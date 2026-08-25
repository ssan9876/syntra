# Remediation 3 — Approvals and Provisioning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a request that nobody can move, stop two writers landing contradictory outcomes on one request or one target, stop a reviewer's revocation order disappearing, and build the two things the designs describe and the code never grew — a requester-chosen start date with a live pre-hire path, and bounded write concurrency.

**Architecture:** Thirteen independently reviewable tasks. Tasks 1–4 are the approvals engine's own state machine: the stuck admin path, the read-then-write races, and the notification a blocked stage never sends. Task 5 is the highest-value provisioning fix — an order that is marked consumed at plan time and never unmarked. Tasks 6–8 are determinism, confirmation and a denominator. Task 9 builds `requestedStartsAt` end to end and admits future joiners to the catalog, which is what makes `scheduled` grants reachable at all. Tasks 10 and 11 are the small items, split by subsystem so each is one review. Tasks 12 and 13 close the design gap from both ends: strip what the design abandoned, build what it specified.

**Tech Stack:** TypeScript (ESM, strict, `exactOptionalPropertyTypes`), Prisma + PostgreSQL, Fastify, React/Vite, zod contracts, vitest (forks pool, one database per worker), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-audit-findings.md` — §7.1 (A1–A9), §7.2 (P1–P8). Designs: `docs/superpowers/specs/2026-08-16-syntra-automate-design.md` and `docs/superpowers/specs/2026-08-16-syntra-provision-design.md`.

## Global Constraints

- Node `>=22`; pnpm pinned to `9.12.0` via `packageManager`. Never run `npm` or a different pnpm.
- **The full root suite takes ~155 minutes at `SYNTRA_TEST_WORKERS=4`. Never run it to check one change.** Run the one file, e.g. `npx vitest run packages/core/src/automate/decision-service.test.ts`. Where a change reaches a neighbour, the task names that neighbour's file explicitly.
- **`npx tsc -b` must stay green at every commit.** It is the only gate that sees all eight project references, and a contract change that compiles in `packages/contracts` and not in `apps/web` is exactly what it exists to catch.
- **The working tree is shared with another session and is not clean.** Never `git add -A`, never `git commit -a`, and **never stage `packages/core/src/auth/password-reset.test.ts`** — it holds a red TDD phase for an `issuePasswordSetup` that does not exist yet. Stage only the exact paths each task names, and run `git status --short` before every commit.
- **`withTenant` is `prisma.$transaction(fn)` under Prisma's 5000 ms default.** No network, no SMTP, no connector call inside one, and no per-row loop whose length follows the size of the tenant. Every loop this plan adds is either bounded by a constant or batched.
- **Any schema change needs a migration named ABOVE `20260830000000`.** Four migrations in the tree are hand-dated ahead of the real clock and the lab has applied them, so a migration `prisma migrate dev` names with today's real timestamp sorts *before* state it was diffed against — see finding X3, and `packages/db/src/migration-order.ts` if remediation 1 Task 5 has already landed it. Generate with `--create-only` and rename:

  ```bash
  npx prisma migrate dev --create-only --name access_request_requested_starts_at
  mv packages/db/prisma/migrations/2026*_access_request_requested_starts_at \
     packages/db/prisma/migrations/20260901000000_access_request_requested_starts_at
  ```

- Integration tests call `resetDatabase()` in `beforeEach` and go through `withTenant`; never touch `prisma` directly for tenant-scoped data in a test.
- Test files live beside their subject as `*.test.ts` (or `*.test.tsx` under `apps/web`, which runs under `apps/web/vitest.config.ts`, not the root one).
- Commit messages: lower-case type prefix, imperative, no trailing period — e.g. `fix(automate): an unblocked request that opens a second stage says so`.

---

### Task 1: An unblocked request that opens a second stage says so

Spec §7.1, **A1**. After an administrative approval of a `blocked_no_approver` request, when a next stage exists and opens, `recordDecision` enqueues the stage-opened mail and returns `pending_approval` — and never writes the status. On the ordinary path the row is already `pending_approval`, so the omission is invisible. On the administrative path the row stays `blocked_no_approver`, so stage 2's approvers are mailed and then refused `not-open` when they click through. Every test of the blocked path uses a single-stage workflow.

**Files:**
- Modify: `packages/core/src/automate/decision-service.ts:380-422` (the `next !== null` branch)
- Test: `packages/core/src/automate/decision-service.test.ts` (append to the `an administrator deciding a blocked request` describe)

**Interfaces:**
- Consumes: `openStage(tx, requestId, sequence, on)` from `./request-service.js`; `enqueueOutbox`, `recipientsForPersons` from `./notify.js`.
- Produces: no signature change. `recordDecision(tenantId, input, options)` still returns `Promise<{ status: RequestStatus }>`; the `pending_approval` return is now backed by a row that says `pending_approval`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/automate/decision-service.test.ts`, inside the existing `describe('an administrator deciding a blocked request')` block:

```ts
  /**
   * The two-stage blocked request, which nothing tested.
   *
   * `recordDecision` returns `pending_approval` for it and used to leave the
   * row on `blocked_no_approver`, so the mail went out to stage 2's approvers
   * and every one of them was refused `not-open` on arrival. The request could
   * then only be moved by a second administrative override -- which is refused
   * too, because the step it would take is `open` rather than `waiting`.
   */
  it('leaves a request PENDING, not blocked, when the administrator opens a second stage', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      // Stage 1 blocked: nobody materialized on it.
      await tx.approvalStepApprover.deleteMany({ where: { step: { requestId } } });
      await tx.approvalStep.updateMany({
        where: { requestId, sequence: 1 },
        data: { status: 'waiting' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });

    const result = await recordDecision(
      tenantId,
      {
        requestId,
        deciderPersonId: janPersonId,
        deciderUserId: janUserId,
        decision: 'approve',
        comment: 'stage one has nobody; approving by hand',
        shortenedToDays: null,
        sourceIp: null,
      },
      { now: LATER, asAdministrator: true },
    );
    expect(result.status).toBe('pending_approval');

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      steps: await tx.approvalStep.findMany({
        where: { requestId },
        orderBy: { sequence: 'asc' },
      }),
    }));
    expect(state.request.status).toBe('pending_approval');
    expect(state.request.statusReason).toBeNull();
    expect(state.steps.map((s) => s.status)).toEqual(['approved', 'open']);
  });

  /**
   * And stage 2's approver can actually decide it. This is the assertion the
   * defect was really about: the mail was sent either way, and what the
   * recipient met was a 'not-open' refusal.
   */
  it('lets the second stage approver decide after an administrative unblock', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      await tx.approvalStepApprover.deleteMany({ where: { step: { requestId } } });
      await tx.approvalStep.updateMany({
        where: { requestId, sequence: 1 },
        data: { status: 'waiting' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: janUserId } });
    });
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: 'by hand', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    );

    const second = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(second.status).toBe('fulfilled');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts -t 'administrator'`

Expected: FAIL. The first new test reports `expected 'blocked_no_approver' to be 'pending_approval'`; the second fails with a `DecisionRefusedError` whose code is `not-open`.

- [ ] **Step 3: Write the status the branch already returns**

In `packages/core/src/automate/decision-service.ts`, in the `if (next !== null) {` branch, immediately after the `if (opened === 'blocked') { … }` block and before `const approvers = …` (currently line 397), insert:

```ts
      // WRITTEN, not merely returned.
      //
      // On the ordinary path the row is already `pending_approval` and this is
      // a no-op, which is exactly why the omission survived: every test of a
      // multi-stage request walks that path. The ADMINISTRATIVE path arrives
      // here on a row that says `blocked_no_approver`, and returning
      // `pending_approval` without writing it left the request in a state that
      // refuses every subsequent decision -- while the mail below went out to
      // stage 2's approvers regardless. They were told it was with them and
      // then met `not-open`, and no second override could rescue it either:
      // the administrative branch looks for a step in `open` or `waiting`, and
      // `openStage` has just moved this one to `open` under a request status
      // that forbids deciding it.
      //
      // `statusReason` is cleared with it. The reason on the row is stage 1's
      // "resolved to nobody who can decide it", which stops being true the
      // moment an administrator decides stage 1 by hand, and a stale reason
      // beside a live status is the console telling somebody something that is
      // no longer so.
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { status: 'pending_approval', statusReason: null },
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts`

Expected: PASS, every test in the file including the two new ones.

- [ ] **Step 5: Run the neighbours that walk the same branch**

Run: `npx vitest run packages/core/src/automate/request-service.test.ts packages/core/src/automate/jobs.test.ts`

Expected: PASS. Both drive multi-stage requests through `openStage` and would show a status regression as a changed terminal state.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git status --short
git add packages/core/src/automate/decision-service.ts \
        packages/core/src/automate/decision-service.test.ts
git commit -m "$(cat <<'EOF'
fix(automate): an unblocked request that opens a second stage says so

`recordDecision` returned `pending_approval` when a next stage opened and
never wrote it. On the ordinary path the row already said that, so the
omission was invisible -- and every test of the blocked path uses a
single-stage workflow.

On the administrative path the row still said `blocked_no_approver`. The
stage-opened mail went out to stage two's approvers, every one of them was
refused `not-open` on arrival, and a second override could not rescue it
either, because `openStage` had just moved the step to `open` under a
request status that forbids deciding it. The request was stuck for good.

Writes the status, and clears the stale reason with it: stage one's
"resolved to nobody" stops being true the moment an administrator decides
stage one by hand.
EOF
)"
```

---

### Task 2: A terminal transition that cannot be taken twice

Spec §7.1, **A2**. `recordDecision` and `cancelRequest` read `request.status`, decide on it, and then update by id with no predicate, under READ COMMITTED. Two callers therefore both pass the check: a reject that lands after an approval has already fulfilled leaves a live, applied grant under a request whose record says `rejected`, two decision rows that contradict each other, and both notification sets sent.

**The choice:** a conditional update whose row count is verified, not a `SELECT … FOR UPDATE`. The predicate is already in hand — the status the transaction read — and a conditional update makes the loser's refusal a `DecisionRefusedError` with a code the API can turn into a 409, where a row lock would make it a wait followed by the same stale decision. The same shape the codebase already uses for the TOTP replay watermark and the password-reset token.

**Files:**
- Modify: `packages/core/src/automate/decision-service.ts:81-111` (capture the observed status), `:286-299` (the reject write), `:352-363` (the eligibility-refusal write), `:386-396` (the blocked write), `:427-430` (the approved write), `:479-498` (the cancel write)
- Test: `packages/core/src/automate/decision-service.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `DecisionRefusedError` gains one more code, `'raced'` — thrown by `recordDecision` and by `cancelRequest` when the row moved under them. No new class, no signature change.
  - A new module-private helper in `decision-service.ts`:
    `async function settleRequest(tx: TenantClient, requestId: string, from: string, data: Prisma.AccessRequestUpdateManyMutationInput): Promise<void>` — updates only while the status is still `from`, and throws `DecisionRefusedError('raced', …)` when it matched nothing.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/automate/decision-service.test.ts`, at the end of the file:

```ts
/**
 * Two decisions in flight over one request.
 *
 * `recordDecision` read `request.status`, decided on it, and updated by id
 * with no predicate. Under READ COMMITTED both transactions saw
 * `pending_approval`, both passed the gate, and both wrote -- so a reject
 * landing after an approval had already fulfilled left a live, applied grant
 * under a request whose own record said `rejected`, two contradictory decision
 * rows, and both sets of mail sent.
 *
 * Serialised here rather than raced with `Promise.all`: the defect is not a
 * timing accident, it is that the SECOND writer is not refused. Running them
 * in order and asserting the second is refused tests exactly that, every time,
 * with no flake.
 */
describe('two people deciding one request', () => {
  it('refuses the second decision once the first has settled it', async () => {
    const requestId = await open();
    const first = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(first.status).toBe('pending_approval');

    // Stage 2 is now open with Bo on it. Jan decides again, against the stage
    // he has already closed -- the shape a stale browser tab produces.
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'reject', comment: 'changed my mind', shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-an-approver');
  });

  it('refuses a decision on a request another writer has already rejected', async () => {
    const requestId = await open();
    // The state the losing transaction is about to write into: another writer
    // committed a rejection between this one's read and its write.
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'rejected', statusReason: 'decided by somebody else' },
      }),
    );
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-open');
  });

  /**
   * THE ONE THAT MATTERS, and the one no gate above catches: the status is
   * read, every check passes, and the row moves before the write. Simulated by
   * moving it from inside a spy on the eligibility re-check, which runs after
   * the gate and before the terminal update.
   */
  it('refuses to write a terminal status over one somebody else wrote', async () => {
    const requestId = await open();
    const eligibility = await import('./eligibility.js');
    const spy = vi.spyOn(eligibility, 'checkEligibility').mockImplementation(async () => {
      await withTenant(tenantId, (tx) =>
        tx.accessRequest.update({
          where: { id: requestId },
          data: { status: 'cancelled', statusReason: 'withdrawn by the requester' },
        }),
      );
      return { ok: true } as const;
    });
    try {
      const failure = await recordDecision(
        tenantId,
        { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
        { now: LATER },
      ).catch((e: unknown) => e);
      expect((failure as DecisionRefusedError).code).toBe('raced');
    } finally {
      spy.mockRestore();
    }

    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('cancelled');
  });

  it('refuses a cancel of a request that has already been decided under it', async () => {
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({ where: { id: requestId }, data: { status: 'approved' } }),
    );
    const failure = await cancelRequest(tenantId, requestId, annaUserId, { now: LATER }).catch(
      (e: unknown) => e,
    );
    expect((failure as DecisionRefusedError).code).toBe('too-late');
  });
});
```

Add `vi` to the vitest import at the top of the file:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts -t 'two people deciding'`

Expected: FAIL on the third test — the decision writes `approved` over `cancelled` and no error is thrown, so `(failure as DecisionRefusedError).code` is `undefined`. The other three pass already; they are there so the conditional update cannot regress the gates it sits behind.

- [ ] **Step 3: Add the conditional-update helper**

In `packages/core/src/automate/decision-service.ts`, after the `DecisionRefusedError` class (currently ending at line 47), insert:

```ts
/**
 * Moves a request to a terminal or a next status ONLY IF it is still where the
 * transaction found it.
 *
 * Every path in this module reads `request.status`, decides on it, and then
 * writes. Under READ COMMITTED — which is what `withTenant` runs at — two
 * transactions both read `pending_approval`, both pass their gate, and both
 * write. The observed outcome was a reject landing after an approval had
 * already fulfilled: a live, applied grant under a request whose own record
 * said `rejected`, two decision rows saying opposite things, and both sets of
 * mail sent to the same people.
 *
 * `updateMany` with the status in the predicate, and the COUNT CHECKED. A
 * plain `update` by id cannot express "only if"; a `SELECT ... FOR UPDATE`
 * would make the loser wait and then commit the same stale decision anyway.
 * The loser is refused instead, with a code the API turns into a 409, which is
 * the honest answer: somebody else decided this while you were reading it.
 *
 * The same shape as the TOTP replay watermark and the password-reset token
 * consumption elsewhere in core — conditional update, count verified.
 */
async function settleRequest(
  tx: TenantClient,
  requestId: string,
  from: string,
  data: Prisma.AccessRequestUpdateManyMutationInput,
): Promise<void> {
  const { count } = await tx.accessRequest.updateMany({
    where: { id: requestId, status: from },
    data,
  });
  if (count === 0) {
    throw new DecisionRefusedError(
      'raced',
      'Somebody else decided this while you were reading it. Open it again to see where it got to.',
    );
  }
}
```

and widen the imports at the top of the file:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import type { Prisma } from '@prisma/client';
```

- [ ] **Step 4: Capture the status the gate was taken against**

In `recordDecision`, immediately after the `findUniqueOrThrow` (currently line 85), insert:

```ts
    // The status EVERY gate below is taken against, and the predicate every
    // terminal write is made under. Read once and named, so the two cannot
    // drift apart: a second `request.status` read further down would be a
    // second answer to the same question.
    const observedStatus = request.status;
```

- [ ] **Step 5: Make the five terminal writes conditional**

In `packages/core/src/automate/decision-service.ts`, replace each of the following, leaving every surrounding statement untouched.

The rejection (currently lines 296–299):

```ts
      await settleRequest(tx, request.id, observedStatus, {
        status: 'rejected',
        statusReason: input.comment,
        decidedAt: now,
      });
```

The eligibility refusal (currently lines 356–363):

```ts
        await settleRequest(tx, request.id, observedStatus, {
          status: 'rejected',
          statusReason: `${eligibility.reason}: ${eligibility.message}`,
          decidedAt: now,
        });
```

The blocked next stage (currently lines 388–394):

```ts
        await settleRequest(tx, request.id, observedStatus, {
          status: 'blocked_no_approver',
          statusReason: `stage ${next.sequence} resolved to nobody who can decide it, and so did its fallback`,
        });
```

The next stage opening, from Task 1:

```ts
      await settleRequest(tx, request.id, observedStatus, {
        status: 'pending_approval',
        statusReason: null,
      });
```

The final approval (currently lines 427–430):

```ts
    await settleRequest(tx, request.id, observedStatus, {
      status: 'approved',
      decidedAt: now,
    });
```

- [ ] **Step 6: Make the cancel conditional too**

In `cancelRequest`, replace the `tx.accessRequest.update` (currently lines 495–498) with:

```ts
    // Under the status the `too-late` gate above was taken against. A cancel
    // that races an approval used to write `cancelled` over `approved` after
    // `fulfilRequest` had already created the grants -- so the person held the
    // access, the record said they had withdrawn the request for it, and the
    // sweep had nothing to expire it by.
    await settleRequest(tx, requestId, request.status, {
      status: 'cancelled',
      statusReason: 'withdrawn by the requester',
      decidedAt: now,
    });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts`

Expected: PASS, all tests including the four new ones.

- [ ] **Step 8: Run the callers that drive these transitions**

Run: `npx vitest run packages/core/src/automate/request-service.test.ts packages/core/src/automate/fulfil.test.ts packages/core/src/automate/delegation-service.test.ts packages/core/src/automate/jobs.test.ts`

Expected: PASS. `delegation-service` and `request-service` both reach `recordDecision`'s approved write through the zero-stage and delegated paths.

- [ ] **Step 9: Give the API a status code for the new refusal**

In `apps/api/src/routes/admin/automate.ts` and `apps/api/src/routes/automate-portal.ts`, find the `DecisionRefusedError` handler and add `raced` to the codes answered `409`. If the handler maps every code to one status, add the branch:

```ts
        // 409, not 422. The body was fine and the caller was entitled to
        // decide it; somebody else got there first, and the useful thing to
        // tell them is to reload rather than to correct anything.
        if (cause.code === 'raced') {
          throw new ProblemError(409, cause.code, 'Already decided', cause.message);
        }
```

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/automate/decision-service.ts \
        packages/core/src/automate/decision-service.test.ts \
        apps/api/src/routes/admin/automate.ts \
        apps/api/src/routes/automate-portal.ts
git commit -m "$(cat <<'EOF'
fix(automate): a terminal transition that cannot be taken twice

`recordDecision` and `cancelRequest` read the status, decided on it, and
then updated by id with no predicate. `withTenant` runs at READ COMMITTED,
so two transactions both read `pending_approval`, both passed the gate, and
both wrote.

The observed shape: a reject landing after an approval had already
fulfilled. A live, applied grant under a request whose own record said
`rejected`; two decision rows saying opposite things; and both sets of mail
sent to the same people. A cancel racing an approval did the same in the
other direction -- the person held the access and the record said they had
withdrawn the request for it, so nothing would ever expire it.

Every terminal write now goes through `settleRequest`, which is an
`updateMany` predicated on the status the gate was taken against with the
row count checked. Not `SELECT ... FOR UPDATE`: that makes the loser wait
and then commit the same stale decision. The loser is refused instead, with
`raced`, which the API answers 409 -- somebody else decided this while you
were reading it.
EOF
)"
```

---

### Task 3: A run claims `applying`, it does not merely announce it

Spec §7.2, **P2**. `applyProvisionRun`'s prepared transaction reads the run, checks its status against `APPLIABLE_RUN_STATUSES` and the confirmation gate, and then writes `status: 'applying'` with a plain `update` by id. Two concurrent applies of one previewed run both proceed. Process A creates the account with password A, seals it and delivers it; process B adopts the same directory object through its provenance marker, then seals password B into the same vault name and mails password B. The directory holds A, the vault holds B, and the person is told B.

**Two tasks, not one, though it is the same pattern as Task 2.** They are different subsystems with different test files, different failure narratives and different reviewers; one commit spanning `automate` and `provision` would be two reviews wearing one hat, and the `provision` half has an irreversible directory write behind it that deserves its own reading.

**Files:**
- Modify: `packages/core/src/provision/apply.ts:507-527` (the `applying` transition)
- Test: `packages/core/src/provision/apply.test.ts`

**Interfaces:**
- Consumes: the existing `ProvisionRunNotAppliableError(runId, status)` from the same file.
- Produces: no signature change. `applyProvisionRun` throws `ProvisionRunNotAppliableError` where it previously proceeded, and the winner's return shape is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/provision/apply.test.ts`:

```ts
/**
 * Two applies of one previewed run.
 *
 * The `previewed -> applying` transition was a plain `update` after a read, so
 * both processes passed the gate and both walked the action list. The
 * observable damage is on `create_account`: A creates the object with password
 * A, seals it and delivers it; B finds the object by its provenance marker,
 * adopts it, and seals password B into `target/<id>/initial/<accountId>` --
 * the same vault name -- and mails password B. The directory holds A. Nobody
 * can sign in with what they were sent, and nothing anywhere says why.
 */
describe('two applies of one run', () => {
  it('lets exactly one of them claim the run', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const confirmedByUserId = await seedConfirmingUser();
    const apply = () =>
      applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId,
        connector: target as never,
        now: NOW,
        sleep: noSleep,
      });

    const [a, b] = await Promise.allSettled([apply(), apply()]);
    const settled = [a, b];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      ProvisionRunNotAppliableError,
    );
  });

  it('creates the account once, and seals the password that is actually at the target', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const confirmedByUserId = await seedConfirmingUser();
    const apply = () =>
      applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId,
        connector: target as never,
        now: NOW,
        sleep: noSleep,
      });
    await Promise.allSettled([apply(), apply()]);

    // One object at the target, one account row, one sealed secret -- and the
    // secret is the password the directory will accept.
    expect(target.accounts).toHaveLength(1);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { targetSystemId: targetId } }),
    );
    const sealed = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, `target/${targetId}/initial/${account.id}`),
    );
    expect(sealed).toBe(target.accounts[0]!.password);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/provision/apply.test.ts -t 'two applies'`

Expected: FAIL. Both promises fulfil, so the first assertion reports two fulfilled where one was expected; the second test shows the sealed secret differing from the password the fake target holds.

- [ ] **Step 3: Claim the run instead of announcing it**

In `packages/core/src/provision/apply.ts`, replace the `await tx.provisionRun.update({ where: { id: runId }, data: { status: 'applying', … } });` block (currently lines 507–527) with:

```ts
    // CLAIMED, not announced.
    //
    // The read above decided this run is appliable. Writing `applying` with a
    // plain `update` by id says nothing about whether it was still appliable
    // at the moment of the write, and `withTenant` runs at READ COMMITTED: two
    // processes both read `previewed`, both passed the confirmation gate, and
    // both walked the action list.
    //
    // What that does is not abstract. On `create_account`, A creates the
    // object with password A, seals it and delivers it; B finds the same
    // object by the provenance marker Provision writes, adopts it rather than
    // colliding, and then seals password B into
    // `target/<targetId>/initial/<accountId>` -- the same vault name -- and
    // mails password B. The directory holds A. The person is told B, cannot
    // sign in, and nothing in the audit trail says the two ever disagreed.
    //
    // `updateMany` predicated on the status this transaction read, with the
    // count checked. The loser gets the same refusal any caller gets for a run
    // that is not appliable, which is what it now is.
    const claimed = await tx.provisionRun.updateMany({
      where: { id: runId, status: run.status },
      data: {
        // The phase transition, stamped. `startedAt` belongs to the preview
        // and answers "when was this plan computed"; overloading it here would
        // make the run's own history unreadable and would still leave the
        // staleness check asking the wrong question. A run previewed at T and
        // confirmed at T+7h is not six hours abandoned — it is one second into
        // writing to a domain controller, and the next scheduled job used to
        // adopt it and start a second run against the same objects.
        status: 'applying',
        lastProgressAt: new Date(),
        // Recorded only when somebody actually confirmed. Writing whatever
        // arrived would put a null in the column on an unconfirmed apply and
        // read as "confirmed by nobody" rather than "not confirmed".
        ...(confirmed ? { confirmedByUserId: options.confirmedByUserId } : {}),
      },
    });
    if (claimed.count === 0) {
      throw new ProvisionRunNotAppliableError(runId, run.status);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/provision/apply.test.ts`

Expected: PASS, every test in the file.

- [ ] **Step 5: Run the run lifecycle neighbours**

Run: `npx vitest run packages/core/src/provision/run-service.test.ts packages/core/src/provision/loop.integration.test.ts packages/core/src/provision/jobs.test.ts`

Expected: PASS. `loop.integration.test.ts` walks preview → apply → reflect end to end and is where a broken claim would surface as a run that never applies.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/provision/apply.ts packages/core/src/provision/apply.test.ts
git commit -m "$(cat <<'EOF'
fix(provision): a run claims `applying`, it does not merely announce it

The `previewed -> applying` transition was a plain update after a read, and
`withTenant` runs at READ COMMITTED, so two concurrent applies of one run
both passed the gate and both walked the action list.

On `create_account` that is not a wasted round trip. A creates the object
with password A, seals it and delivers it. B finds the same object by the
provenance marker Provision writes, adopts it rather than colliding, seals
password B into the same vault name, and mails password B. The directory
holds A. The person is told B, cannot sign in, and nothing in the audit
trail says the two ever disagreed.

`updateMany` predicated on the status the transaction read, count checked.
The loser gets `ProvisionRunNotAppliableError`, which is what the run is by
then.
EOF
)"
```

---

### Task 4: A request that becomes blocked mid-flight tells somebody

Spec §7.1, **A3**. When stage N≥2 resolves to nobody, `recordDecision` sets `blocked_no_approver` and returns. No outbox row for the product owner, none for the `automate.manage` holders, no audit event. The stage-1 path in `submitRequest` sends both and audits — so the same failure is loud at submission and silent afterwards, which is the wrong way round: at submission the requester is still watching the screen, and at stage 3 on a Thursday nobody is.

**Files:**
- Modify: `packages/core/src/automate/decision-service.ts:385-396` (the blocked branch), and the import block at the top
- Test: `packages/core/src/automate/decision-service.test.ts`

**Interfaces:**
- Consumes: `usersWithPermission(tx, permission)` and `recipientsForPersons(tx, personIds)` from `./notify.js`; `PERMISSIONS.AUTOMATE_MANAGE`; the `automate-blocked-no-approver` template, which takes `displayName`, `stageName`, `productName`, `subjectName`, `droppedNote`, `requestUrl`.
- Produces: no signature change. The blocked return now leaves outbox rows and one `automate.request.blocked` audit event behind it.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/automate/decision-service.test.ts`:

```ts
/**
 * A stage that resolves to nobody, at stage two rather than stage one.
 *
 * `submitRequest` mails the product owner and every `automate.manage` holder
 * when stage ONE blocks, and audits it. `recordDecision` set the status and
 * returned. So the loud version of this failure happens while the requester is
 * still looking at the screen, and the silent version happens three days later
 * when nobody is -- which is the wrong way round, and is the silent-drop class
 * the design's own constraint names.
 */
describe('a request that becomes blocked mid-flight', () => {
  it('tells the product owner and the automate.manage holders, and audits it', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });

    // Stage 2 names Bo. Deactivating him leaves the stage resolving to nobody,
    // and it has no fallback.
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: boUserId }, data: { status: 'inactive' } }),
    );

    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('blocked_no_approver');

    const state = await withTenant(tenantId, async (tx) => ({
      outbox: await tx.notificationOutbox.findMany({
        where: { requestId, template: 'automate-blocked-no-approver' },
      }),
      events: await tx.auditEvent.findMany({ where: { action: 'automate.request.blocked' } }),
    }));
    // Jan owns the product and holds no automate.manage; Bo holds it and is
    // now inactive, and `usersWithPermission` reads active users only. So the
    // owner is the whole of the list -- which is exactly the case worth
    // asserting: SOMEBODY is told even when the administrators are gone.
    expect(state.outbox.map((o) => o.to)).toEqual(['jan@acme.test']);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.targetId).toBe(requestId);
  });

  it('names the stage that blocked, not stage one', async () => {
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: boUserId }, data: { status: 'inactive' } }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findFirstOrThrow({
        where: { requestId, template: 'automate-blocked-no-approver' },
      }),
    );
    expect((row.vars as Record<string, string>).stageName).toBe('Security');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts -t 'blocked mid-flight'`

Expected: FAIL. `state.outbox` is `[]` and `state.events` is `[]` — the status is written and nothing else happens.

- [ ] **Step 3: Widen the imports**

In `packages/core/src/automate/decision-service.ts`, change the `./notify.js` import to:

```ts
import {
  displayNames,
  enqueueOutbox,
  recipientsForPersons,
  usersWithPermission,
} from './notify.js';
```

- [ ] **Step 4: Say something when the stage blocks**

Replace the whole `if (opened === 'blocked') { … }` block (currently lines 387–396) with:

```ts
      if (opened === 'blocked') {
        const stageName =
          (next.stageSnapshot as unknown as StageSnapshot).name ?? `stage ${next.sequence}`;
        await settleRequest(tx, request.id, observedStatus, {
          status: 'blocked_no_approver',
          statusReason: `stage ${next.sequence} resolved to nobody who can decide it, and so did its fallback`,
        });

        // THE SAME NOISE `submitRequest` MAKES WHEN STAGE ONE BLOCKS.
        //
        // It made none here, and the asymmetry pointed the wrong way: stage
        // one blocks while the requester is still looking at the screen and
        // can go and ask somebody, and stage three blocks on a Thursday
        // afternoon with nobody watching at all. A request in
        // `blocked_no_approver` is one of the three states the design names as
        // needing "a state, a name, a notification and a screen" -- it had the
        // first two.
        //
        // Owner first, then every `automate.manage` holder; `enqueueOutbox`
        // deduplicates on the recipient. `usersWithPermission` reads active
        // users only, so a tenant whose only administrator has been
        // deactivated still reaches the owner, and a product with no owner
        // still reaches the administrators.
        const owners =
          request.product?.ownerPersonId == null
            ? []
            : await recipientsForPersons(tx, [request.product.ownerPersonId]);
        const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
        await enqueueOutbox(
          tx,
          [...owners, ...managers].map((r) => ({
            template: 'automate-blocked-no-approver' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              stageName,
              productName: vars.productName,
              subjectName: vars.subjectName,
              droppedNote:
                'Everybody the stage resolved to was the subject, the submitter, or unable to sign in.',
              requestUrl: vars.requestUrl,
            },
            requestId: request.id,
            userId: r.userId,
          })),
        );

        // Audited as a `failure` outcome, deliberately. Nothing threw and the
        // decision above stands -- but this is a request that has stopped
        // moving, and the column people filter on when asked "what is stuck"
        // is the outcome.
        await recordEvent(tx, {
          actorUserId: input.deciderUserId,
          action: 'automate.request.blocked',
          targetType: 'AccessRequest',
          targetId: request.id,
          outcome: 'failure',
          sourceIp: input.sourceIp,
          payload: {
            stageSequence: next.sequence,
            stageName,
            subjectPersonId: request.subjectPersonId,
            told: [...owners, ...managers].map((r) => r.email),
          },
        });
        return { status: 'blocked_no_approver' };
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts`

Expected: PASS, every test in the file.

- [ ] **Step 6: Run the notification neighbours**

Run: `npx vitest run packages/core/src/automate/notify.test.ts packages/core/src/automate/jobs.test.ts`

Expected: PASS. `jobs.test.ts` drives `runOutboxJob` over whatever the engine enqueued, so an unrenderable template surfaces there as a send failure.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/automate/decision-service.ts \
        packages/core/src/automate/decision-service.test.ts
git commit -m "$(cat <<'MSG'
fix(automate): a request blocked at stage two tells somebody

`submitRequest` mails the product owner and every automate.manage holder
when stage one resolves to nobody, and audits it. `recordDecision` set
`blocked_no_approver` and returned -- no outbox row, no audit event,
nothing.

The asymmetry pointed the wrong way. Stage one blocks while the requester
is still looking at the screen and can go and ask somebody; stage three
blocks on a Thursday afternoon with nobody watching, and the request then
sits there until somebody happens to open it. `blocked_no_approver` is one
of the three states the design names as needing a state, a name, a
notification and a screen. It had the first two.

Audited with outcome `failure`, because "what is stuck" is a question
people answer by filtering that column, not because anything threw.
MSG
)"
```

---

### Task 5: A revocation order the run did not apply goes back in the queue

Spec §7.2, **P1** — the highest-value provisioning fix. `planActions` consumes an open order into an action, and phase 7 marks the order `planned` when the **plan is written**. Nothing ever writes `applied`; that status and the `appliedAt` column have no writer anywhere in the codebase. Nothing reverts `planned → open` when the run is blocked by the guard, superseded by a later plan, killed mid-flight, or when the action itself fails. `loadRevocationOrders` reads only `open`. So a reviewer's decision to remove somebody's access is consumed once, silently, and never enters another plan — while the order row and the audit trail both read as though it had been handled.

**The choice:** keep `planned` as a real state and make it self-healing at the head of the next run, rather than deferring the mark to apply time. Deferring would let two overlapping runs each plan the same order and revoke twice; releasing keeps "consumed once" true within a run and across runs, and derives its answer from the rows rather than from what the last run remembered — the idiom `reflectProvisionOutcomes` is already built on.

**Files:**
- Modify: `packages/core/src/govern/revocation-service.ts` (two new exports, after `loadRevocationOrders`)
- Modify: `packages/core/src/provision/run-service.ts:110-125` (release inside `adoptStaleRunsAndStart`) and its import block
- Modify: `packages/core/src/provision/apply.ts:1264-1275` (`finish`'s `revoke_entitlement` branch) and its import block
- Test: `packages/core/src/govern/revocation-service.test.ts`, `packages/core/src/provision/run-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient` from `@syntra/db`; `ProvisionAction.revocationOrderId`, which phase 7 already writes; `ProvisionRun.status`.
- Produces, both from `packages/core/src/govern/revocation-service.ts`:
  - `export async function releaseUnappliedRevocationOrders(tx: TenantClient, targetSystemId: string): Promise<number>` — returns to `open` every `planned` order for this target whose action did not reach `applied` and whose run is terminal, and answers how many.
  - `export async function markRevocationOrderApplied(tx: TenantClient, orderId: string, on: Date): Promise<void>` — `planned → applied`, conditional on `planned`, stamping `appliedAt`.

- [ ] **Step 1: Write the fixture the tests call**

Append to `packages/core/src/govern/revocation-service.test.ts`:

```ts
/**
 * An order in `planned`, with one `revoke_entitlement` action carrying its id,
 * on a run whose status the caller chooses.
 *
 * Written by hand rather than by driving a preview: what these tests are about
 * is the state a dead or superseded run LEAVES BEHIND, and reproducing every
 * route to it would be four setups asserting one function.
 */
async function seedPlannedOrder(over: {
  actionStatus: string;
  runStatus?: string;
}): Promise<{ orderId: string; actionId: string }> {
  const unique = Math.random().toString(16).slice(2, 10);
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Maya', familyName: 'Okafor' },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId: person.id,
        correlationKey: `maya.okafor.${unique}`,
        status: 'active',
      },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: `guid-${unique}`,
        dn: `CN=Payments-${unique},OU=Groups,DC=acme,DC=test`,
        type: 'group',
        displayName: 'Payments',
      },
    });
    const order = await tx.revocationOrder.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        accountId: account.id,
        entitlementId: entitlement.id,
        decidedByPersonId: person.id,
        decidedByPersonName: 'Rita Owusu',
        campaignName: 'Q2 access review',
        campaignDecisionId: null,
        reason: 'no longer in payments',
        status: 'planned',
        plannedAt: new Date('2026-06-15T00:00:00Z'),
      },
    });
    const terminal = over.runStatus === undefined;
    const run = await tx.provisionRun.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        status: over.runStatus ?? 'failed',
        ...(terminal ? { finishedAt: new Date('2026-06-15T01:00:00Z') } : {}),
      },
    });
    const action = await tx.provisionAction.create({
      data: {
        tenantId,
        runId: run.id,
        actionType: 'revoke_entitlement',
        personId: person.id,
        accountId: account.id,
        entitlementId: entitlement.id,
        revocationOrderId: order.id,
        status: over.actionStatus,
        sequence: 0,
      },
    });
    return { orderId: order.id, actionId: action.id };
  });
}
```

If that file has no `targetId` in scope, seed one in the same helper with `createTarget` exactly as `packages/core/src/provision/apply.test.ts` does, and hoist it to a module-level `let` set in `beforeEach`.

- [ ] **Step 2: Write the failing tests**

Append to the same file:

```ts
/**
 * An order marked `planned` and then dropped.
 *
 * `planned` was written when the PLAN was written, not when the action was
 * applied, and nothing ever wrote `applied` -- that status and the `appliedAt`
 * column had no writer in the codebase at all. Nothing reverted it either. So
 * a run blocked by the guard, superseded by a later plan, or simply killed
 * took the reviewer's decision with it: `loadRevocationOrders` reads only
 * `open`, so the order never entered another plan, while the row and the audit
 * trail both read as though somebody had dealt with it.
 */
describe('releaseUnappliedRevocationOrders', () => {
  it('returns an order whose action never reached applied', async () => {
    const { orderId } = await seedPlannedOrder({ actionStatus: 'superseded' });
    const released = await withTenant(tenantId, (tx) =>
      releaseUnappliedRevocationOrders(tx, targetId),
    );
    expect(released).toBe(1);
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('open');
    // Cleared with the status. A `plannedAt` beside `open` reads as an order
    // that is queued AND already scheduled, which is the confusion this
    // function exists to end.
    expect(order.plannedAt).toBeNull();
  });

  it('leaves an order whose action IS applied alone', async () => {
    const { orderId } = await seedPlannedOrder({ actionStatus: 'applied' });
    const released = await withTenant(tenantId, (tx) =>
      releaseUnappliedRevocationOrders(tx, targetId),
    );
    expect(released).toBe(0);
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('planned');
  });

  /**
   * The one that stops the cure being worse than the disease. A run still in
   * flight has actions in `proposed` and `in_flight`; releasing its orders
   * would let the NEXT run plan the same revocation while the first is
   * mid-write at the directory.
   */
  it('leaves an order whose run is still in flight alone', async () => {
    const { orderId } = await seedPlannedOrder({
      actionStatus: 'in_flight',
      runStatus: 'applying',
    });
    const released = await withTenant(tenantId, (tx) =>
      releaseUnappliedRevocationOrders(tx, targetId),
    );
    expect(released).toBe(0);
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('planned');
  });

  it('is scoped to one target', async () => {
    const { orderId } = await seedPlannedOrder({ actionStatus: 'failed' });
    const released = await withTenant(tenantId, (tx) =>
      releaseUnappliedRevocationOrders(tx, '00000000-0000-4000-8000-000000000001'),
    );
    expect(released).toBe(0);
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('planned');
  });
});

describe('markRevocationOrderApplied', () => {
  it('moves a planned order to applied and stamps the date', async () => {
    const { orderId } = await seedPlannedOrder({ actionStatus: 'applied' });
    const on = new Date('2026-06-20T09:00:00Z');
    await withTenant(tenantId, (tx) => markRevocationOrderApplied(tx, orderId, on));
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('applied');
    expect(order.appliedAt).toEqual(on);
  });

  /**
   * Conditional on `planned`. A straggling action reporting on an order that
   * has since been cancelled -- the escape hatch `createRevocationOrder` uses
   * when a later decision supersedes an earlier one -- must not resurrect it.
   * The cancellation is the later decision and it wins.
   */
  it('leaves a cancelled order cancelled', async () => {
    const { orderId } = await seedPlannedOrder({ actionStatus: 'applied' });
    await withTenant(tenantId, (tx) =>
      tx.revocationOrder.update({
        where: { id: orderId },
        data: { status: 'cancelled', cancelledReason: 'overtaken by a later decision' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      markRevocationOrderApplied(tx, orderId, new Date('2026-06-20T09:00:00Z')),
    );
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('cancelled');
  });
});
```

Add both names to the file's import from `./revocation-service.js`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/revocation-service.test.ts -t 'RevocationOrder'`

Expected: FAIL — `releaseUnappliedRevocationOrders is not a function`, and the same for `markRevocationOrderApplied`.

- [ ] **Step 4: Write both functions**

In `packages/core/src/govern/revocation-service.ts`, append after `loadRevocationOrders`:

```ts
/**
 * The run statuses that mean "this run has not finished deciding".
 *
 * The same four `provision_run_one_non_terminal` covers and that
 * `run-service.ts` calls `NON_TERMINAL`. Restated here rather than imported,
 * because Govern must not take a dependency on Provision's module graph — the
 * whole point of `loadRevocationOrders` handing over plain values — and it is
 * four strings a migration constrains on the other side.
 */
const NON_TERMINAL_RUN_STATUSES = ['running', 'previewed', 'blocked', 'applying'] as const;

/**
 * Puts back every order the last run took and did not apply.
 *
 * `planned` is written when the PLAN is written, not when the action lands.
 * That much is deliberate: a one-shot term has to be consumed once, and two
 * overlapping plans against one target must not each carry the same
 * revocation. What was missing is the other half. The run was blocked by the
 * guard. The run was superseded. The process died. The action failed at the
 * directory. In all four the order sat in `planned` for ever, and
 * `loadRevocationOrders` reads only `open` — so a reviewer's decision to take
 * somebody's access away entered exactly one plan, never became a write, and
 * never entered another, under a row and an audit trail that both read as
 * handled.
 *
 * Nothing wrote `applied` either, so the two were indistinguishable even to
 * somebody reading the table by hand.
 *
 * Called at the head of every run, before the plan is computed, so the answer
 * is derived from the action rows rather than from what the last run
 * remembered. An order whose action reached `applied` stays `planned` until
 * `markRevocationOrderApplied` moves it on. An order whose run is still
 * non-terminal is left alone: releasing it would let the next run plan a
 * second revocation while the first is mid-write at the directory, which is
 * the failure this is meant to prevent, reached from the other side.
 */
export async function releaseUnappliedRevocationOrders(
  tx: TenantClient,
  targetSystemId: string,
): Promise<number> {
  const planned = await tx.revocationOrder.findMany({
    where: { targetSystemId, status: 'planned' },
    select: { id: true },
  });
  if (planned.length === 0) return 0;

  // One query for the whole set, not one per order. This runs at the head of
  // every run and the count follows the size of the campaign that produced the
  // orders, not any constant in this file.
  const actions = await tx.provisionAction.findMany({
    where: { revocationOrderId: { in: planned.map((o) => o.id) } },
    select: { revocationOrderId: true, status: true, run: { select: { status: true } } },
  });

  const settled = new Set<string>();
  for (const action of actions) {
    if (action.revocationOrderId === null) continue;
    if (
      action.status === 'applied' ||
      (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(action.run.status)
    ) {
      settled.add(action.revocationOrderId);
    }
  }

  const releasable = planned.map((o) => o.id).filter((id) => !settled.has(id));
  if (releasable.length === 0) return 0;

  const { count } = await tx.revocationOrder.updateMany({
    where: { id: { in: releasable }, status: 'planned' },
    data: { status: 'open', plannedAt: null },
  });
  return count;
}

/**
 * The writer `RevocationOrder.status = 'applied'` never had.
 *
 * Conditional on `planned`, so a straggling action reporting on an order that
 * has since been cancelled — overtaken by a later decision, which is the
 * escape hatch `createRevocationOrder` uses — cannot resurrect it. The
 * cancellation is the later decision and it wins.
 */
export async function markRevocationOrderApplied(
  tx: TenantClient,
  orderId: string,
  on: Date,
): Promise<void> {
  await tx.revocationOrder.updateMany({
    where: { id: orderId, status: 'planned' },
    data: { status: 'applied', appliedAt: on },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/revocation-service.test.ts`

Expected: PASS, every test in the file including the six new ones.

- [ ] **Step 6: Write the failing test for the two-run shape**

Append to `packages/core/src/provision/run-service.test.ts`:

```ts
/**
 * The end-to-end shape of the drop: an order planned by a run that then dies,
 * and the next run that has to pick it up again.
 */
describe('a revocation order across two runs', () => {
  it('re-enters the plan after a run that never applied it', async () => {
    const { orderId } = await seedOpenRevocationOrder();

    const first = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const planned = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: first.id, revocationOrderId: orderId } }),
    );
    // The premise, asserted rather than assumed: `plan.ts` skips an order
    // whose entitlement is in desired state or is not currently held, so a
    // fixture that got either wrong would make the rest of this test vacuous.
    expect(planned).toHaveLength(1);
    const afterPlan = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(afterPlan.status).toBe('planned');

    // The run dies. Nothing applied it.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({
        where: { id: first.id },
        data: { status: 'failed', error: 'the process did not finish', finishedAt: NOW },
      }),
    );

    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const replanned = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: second.id, revocationOrderId: orderId } }),
    );
    expect(replanned).toHaveLength(1);
  });

  it('marks the order applied when the revocation actually lands', async () => {
    const { orderId } = await seedOpenRevocationOrder();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const confirmedByUserId = await seedConfirmingUser();
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId,
      connector: target as never,
      now: NOW,
      sleep: noSleep,
    });
    const order = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: orderId } }),
    );
    expect(order.status).toBe('applied');
    expect(order.appliedAt).not.toBeNull();
  });
});
```

Write `seedOpenRevocationOrder` beside it, modelled on that file's existing person-and-account fixtures. It must produce: a person with a contract in force, a `TargetAccount` with an anchor, an object at the fake target carrying that anchor and **holding** the entitlement, an `Entitlement` no business rule and no `AccessGrant` names, and a `RevocationOrder` in `open` for that (account, entitlement). Import `applyProvisionRun` and reuse the file's `seedConfirmingUser` and `noSleep` if present, or copy them from `apply.test.ts:112-127`.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/provision/run-service.test.ts -t 'revocation order across two runs'`

Expected: FAIL. The second preview plans nothing for the order — it is still `planned` and `loadRevocationOrders` reads only `open`. The second test shows the order still `planned` after a successful apply.

- [ ] **Step 8: Release at the head of every run**

In `packages/core/src/provision/run-service.ts`, widen the Govern import:

```ts
import {
  loadRevocationOrders,
  releaseUnappliedRevocationOrders,
} from '../govern/revocation-service.js';
```

and in `adoptStaleRunsAndStart`, inside the first `withTenant`, immediately after the `tx.provisionAction.updateMany({ where: { status: 'proposed', run: { targetSystemId } }, … })` call, insert:

```ts
    // Every order the last plan took and did not apply goes back in the queue.
    //
    // Here, and not at the end of the apply: this is the one point every run
    // passes through, whatever ended the last one — a guard block, a
    // supersession, a failed action, or a process that simply stopped. An
    // order stranded in `planned` is a reviewer's decision to remove somebody's
    // access that entered exactly one plan, never became a write, and never
    // entered another, under a row that reads as handled.
    //
    // After the supersession above and before the plan below, so an action
    // this very statement has just moved to `superseded` is already visible as
    // "did not apply".
    await releaseUnappliedRevocationOrders(tx, targetSystemId);
```

- [ ] **Step 9: Mark the order applied when the revocation lands**

In `packages/core/src/provision/apply.ts`, add:

```ts
import { markRevocationOrderApplied } from '../govern/revocation-service.js';
```

and in `finish`, in the `case 'revoke_entitlement':` branch, after the `accountEntitlement.updateMany` call and before `break`:

```ts
          if (action.revocationOrderId !== null) {
            // The writer this status never had. `applied` and its `appliedAt`
            // column existed in the schema with nothing in the codebase that
            // could set them, so an order Provision genuinely carried out was
            // indistinguishable from one it had dropped: both sat in `planned`
            // for ever. In the same transaction as the holding state change it
            // reports, which is the shape every other outcome here takes.
            await markRevocationOrderApplied(tx, action.revocationOrderId, now);
          }
```

- [ ] **Step 10: Run both suites to verify they pass**

Run: `npx vitest run packages/core/src/provision/run-service.test.ts packages/core/src/govern/revocation-service.test.ts`

Expected: PASS.

- [ ] **Step 11: Run the apply and loop neighbours**

Run: `npx vitest run packages/core/src/provision/apply.test.ts packages/core/src/provision/loop.integration.test.ts packages/core/src/provision/plan.test.ts`

Expected: PASS.

- [ ] **Step 12: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/govern/revocation-service.ts \
        packages/core/src/govern/revocation-service.test.ts \
        packages/core/src/provision/run-service.ts \
        packages/core/src/provision/run-service.test.ts \
        packages/core/src/provision/apply.ts
git commit -m "$(cat <<'MSG'
fix(provision): a revocation order the run did not apply goes back in the queue

An order was marked `planned` when the PLAN was written, not when the
action landed -- and nothing anywhere wrote `applied`. That status and the
`appliedAt` column had no writer in the codebase at all, and nothing
reverted `planned` when a run was blocked by the guard, superseded by a
later plan, killed mid-flight, or when the action failed at the directory.

`loadRevocationOrders` reads only `open`. So a reviewer's decision to take
somebody's access away entered exactly one plan, never became a write, and
never entered another -- while the order row and the audit trail both read
as though it had been handled. Nobody could tell the two cases apart even
by reading the table, because the applied case looked identical.

`releaseUnappliedRevocationOrders` runs at the head of every run, which is
the one point every run passes through whatever ended the last one, and
derives its answer from the action rows rather than from what the last run
remembered. It leaves alone anything whose action applied, and anything
whose run is still non-terminal -- releasing the latter would let the next
run plan a second revocation while the first is mid-write.

`markRevocationOrderApplied` is the writer the applied status never had,
conditional on `planned` so a straggler cannot resurrect a cancelled order.
MSG
)"
```

---

### Task 6: A delegated act that does not depend on row order

Spec §7.1, **A5**. Two places pick an arbitrary row and read authority off it.

`delegationFor` takes `.find()` over an unordered `findMany`, and reads the capability set **and** the `audienceCondition` from that one row — though several delegations per (resource, delegate) are legal, and a person delegated `view_members` by one row and `grant` by another is refused or admitted depending on which row PostgreSQL returned first.

`delegatedGrant` takes the bounding audience from `productGrant.findFirst` with no ordering, and falls back to the delegation's own condition when the first-found product happens to be `draft` or `retired` — even when an `active` product with a condition exists.

**The choice, both times: union, computed over every row rather than read off one.** Each live delegation is an independent, deliberate grant of authority, and each active product is an independent route by which the resource is legitimately requestable — so somebody either of them admits is somebody the delegate may act on. Taking the intersection would let one narrow row silently cancel a wider one that an administrator wrote on purpose, and taking the first row makes the answer depend on nothing at all.

**Files:**
- Modify: `packages/core/src/automate/delegation-service.ts:340-403` (`resourcesManagedBy` and `delegationFor`), `:476-486` (the bounding audience)
- Test: `packages/core/src/automate/delegation-service.test.ts`

**Interfaces:**
- Consumes: `AudienceCondition` from `./audience.js`, whose `{ any: AudienceCondition[] }` shape is what the union is expressed in.
- Produces:
  - `resourcesManagedBy(tx, personId, now)` keeps its signature `Promise<ManagedResource[]>` and now returns **one entry per (resourceType, resourceId)**, merged: `capabilities` the union, `audienceCondition` null if any contributing row is null and otherwise `{ any: [...] }`, `endsAt` the latest (null wins), `delegationId` the earliest-created contributor.
  - `delegationFor` is unchanged in signature and becomes deterministic by construction.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/automate/delegation-service.test.ts`:

```ts
/**
 * Two delegations of one resource to one person.
 *
 * Legal, and ordinary: a team lead is given `view_members` when the group is
 * created and `grant`/`revoke` months later when they take over running it.
 * `delegationFor` read the capability list off whichever row `findMany`
 * happened to return first, so whether they could add anybody depended on
 * PostgreSQL's physical row order -- which changes when a row is updated.
 */
describe('several delegations of one resource to one person', () => {
  it('unions the capabilities instead of reading one row', async () => {
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['view_members'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant', 'revoke'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });

    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toHaveLength(1);
    expect([...managed[0]!.capabilities].sort()).toEqual(['grant', 'revoke', 'view_members']);
  });

  it('lets the delegate act on the capability the second row gave them', async () => {
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['view_members'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });

    const outcome = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [memberPersonId],
        justification: 'joined the team',
        durationDays: 30,
      },
      { now: NOW },
    );
    expect(outcome.requestIds).toHaveLength(1);
  });

  /**
   * A narrow row must not cancel a wide one. Each delegation is a deliberate,
   * independent grant of authority, so somebody either of them admits is
   * somebody the delegate may act on -- and an unrestricted row makes the
   * union unrestricted.
   */
  it('takes the union of the audiences, and an unrestricted row wins', async () => {
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: {
        field: 'contract.department',
        op: 'equals',
        value: 'Nowhere',
      },
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });

    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toHaveLength(1);
    expect(managed[0]!.audienceCondition).toBeNull();
  });
});

/**
 * The bounding audience, when the resource is reachable through more than one
 * product.
 *
 * `productGrant.findFirst` has no ordering, so a resource offered by a retired
 * product and an active one took the RETIRED product's row about half the
 * time -- and, because a retired product is not `active`, fell back to the
 * delegation's own condition, which is a different rule entirely. Two runs of
 * the same act against the same data admitted different people.
 */
describe('the bounding audience for a delegated grant', () => {
  it('ignores a retired product when an active one offers the same resource', async () => {
    const retired = await createProduct(tenantId, null, {
      name: 'Old route',
      slug: 'old-route',
      kind: 'localGroup',
      grants: [{ resourceType: 'group', resourceId: groupId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Nowhere' },
      workflowId,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: leadPersonId,
      ownerGroupId: null,
      status: 'active',
    });
    await withTenant(tenantId, (tx) =>
      tx.product.update({ where: { id: retired.id }, data: { status: 'retired' } }),
    );
    await createProduct(tenantId, null, {
      name: 'Current route',
      slug: 'current-route',
      kind: 'localGroup',
      grants: [{ resourceType: 'group', resourceId: groupId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: leadPersonId,
      ownerGroupId: null,
      status: 'active',
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });

    // The member is in Finance, which only the ACTIVE product admits.
    const outcome = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [memberPersonId],
        justification: 'joined the team',
        durationDays: null,
      },
      { now: NOW },
    );
    expect(outcome.requestIds).toHaveLength(1);
  });
});
```

Reuse the file's existing fixtures for `groupId`, `leadPersonId`, `leadUserId`, `memberPersonId`, `workflowId`, `NOW` and `day`. If any of those is not already a module-level binding there, add it in `beforeEach` in the same shape the file already uses, and make sure `memberPersonId`'s contract carries `department: 'Finance'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/delegation-service.test.ts -t 'several delegations'`

Expected: FAIL. `resourcesManagedBy` returns two entries rather than one merged entry, so `toHaveLength(1)` fails; and `delegatedGrant` throws `DelegationRefusedError('not-permitted')` about half the time on the second test, depending on which row came back first.

- [ ] **Step 3: Merge in `resourcesManagedBy`**

In `packages/core/src/automate/delegation-service.ts`, replace the `return rows.filter(…).map(…)` tail of `resourcesManagedBy` (currently lines 368–382) with:

```ts
  const live = rows
    .filter(
      (row) =>
        row.delegatePersonId === personId ||
        (row.delegateGroupId !== null && groupIds.includes(row.delegateGroupId)),
    )
    // TOTAL AND STABLE, and it is not decoration. `delegationId` below is the
    // row this merged entry is attributed to, and an unordered read attributes
    // the same authority to a different delegation on every call — which makes
    // "who gave this person the right to do that" unanswerable from the audit
    // trail. `id` breaks the tie because two rows can share a `createdAt`:
    // PostgreSQL's now() is transaction start time, so a bulk insert gives
    // every row the same one.
    .sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  /**
   * ONE ENTRY PER RESOURCE, merged across every live delegation.
   *
   * Several delegations of one resource to one person are legal and ordinary:
   * a team lead is given `view_members` when the group is created and
   * `grant`/`revoke` months later when they take it over. `delegationFor` used
   * to `.find()` the first matching row and read the capability list AND the
   * audience off it alone, so whether they could add anybody depended on which
   * row `findMany` happened to return — physical row order, which changes the
   * moment an unrelated column is updated.
   *
   * UNION, not intersection. Each row is a deliberate, independent grant of
   * authority; intersecting would let one narrow row silently cancel a wider
   * one an administrator wrote on purpose, and a delegation carrying no
   * audience is an unrestricted one, so it makes the union unrestricted too.
   */
  const merged = new Map<string, ManagedResource>();
  for (const row of live) {
    const key = `${row.resourceType}:${row.resourceId}`;
    const capabilities = row.capabilities as ResourceCapability[];
    const condition = row.audienceCondition as AudienceCondition | null;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        delegationId: row.id,
        resourceType: row.resourceType as ResourceType,
        resourceId: row.resourceId,
        capabilities: [...new Set(capabilities)],
        endsAt: row.endsAt,
        audienceCondition: condition,
      });
      continue;
    }
    existing.capabilities = [...new Set([...existing.capabilities, ...capabilities])];
    // The LATEST end, and an open-ended row wins outright: the authority lasts
    // as long as the longest thing that confers it.
    if (existing.endsAt !== null) {
      existing.endsAt = row.endsAt === null ? null : row.endsAt > existing.endsAt ? row.endsAt : existing.endsAt;
    }
    if (existing.audienceCondition !== null) {
      existing.audienceCondition =
        condition === null ? null : { any: [existing.audienceCondition, condition] };
    }
  }
  return [...merged.values()];
```

`delegationFor` is left exactly as it is: its `.find()` is now over a list with one entry per resource, so it is deterministic by construction rather than by a second rule somebody has to remember.

- [ ] **Step 4: Take the bound from every active product**

In `delegatedGrant`, replace the `productGrant.findFirst` and the `condition` binding (currently lines 476–486) with:

```ts
    // The resource's own audience rule applies: where it is reachable through
    // a product, that product's condition; otherwise the delegation's own.
    // Without this, delegation is a hole underneath section 6.
    //
    // EVERY ACTIVE PRODUCT, not the first row of any status. `findFirst` with
    // no ordering returned a `draft` or `retired` product about half the time
    // for a resource offered by two — and, because neither is `active`, fell
    // through to the delegation's own condition, which is a different rule
    // entirely. Two runs of the same act against the same data admitted
    // different people.
    //
    // Their conditions are unioned for the same reason the delegations above
    // are: each active product is an independent, legitimate route by which
    // this resource may be asked for, so somebody any of them admits is
    // somebody the delegate may add. An active product with no condition means
    // the catalog places no bound on it, and the union is then unbounded.
    const productGrants = await tx.productGrant.findMany({
      where: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        product: { status: 'active' },
      },
      include: { product: { select: { audienceCondition: true } } },
      orderBy: { id: 'asc' },
    });
    const productConditions = productGrants.map(
      (g) => g.product.audienceCondition as AudienceCondition | null,
    );
    const condition: AudienceCondition | null =
      productGrants.length === 0
        ? delegation.audienceCondition
        : productConditions.some((c) => c === null)
          ? null
          : productConditions.length === 1
            ? productConditions[0]!
            : { any: productConditions as AudienceCondition[] };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/automate/delegation-service.test.ts`

Expected: PASS, every test in the file.

- [ ] **Step 6: Run the audience and portal neighbours**

Run: `npx vitest run packages/core/src/automate/audience.test.ts packages/core/src/automate/catalog-service.test.ts`

Expected: PASS. `audience.test.ts` is what proves an `{ any: [...] }` built here evaluates the way the union claims it does.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/automate/delegation-service.ts \
        packages/core/src/automate/delegation-service.test.ts
git commit -m "$(cat <<'MSG'
fix(automate): a delegated act that does not depend on row order

Two places picked an arbitrary row and read authority off it.

`delegationFor` took `.find()` over an unordered `findMany` and read the
capability list and the audience from that one row -- though several
delegations of one resource to one person are legal and ordinary: a team
lead gets `view_members` when the group is created and `grant` months later
when they take it over. Which one came back decided whether they could add
anybody, and physical row order changes the moment an unrelated column is
updated.

`delegatedGrant` took the bounding audience from `productGrant.findFirst`
with no ordering, so a resource offered by a retired product and an active
one took the retired row about half the time -- and, not being active, fell
through to the delegation's own condition, a different rule entirely.

Both now union over every contributing row. Union rather than intersection:
each delegation is a deliberate independent grant of authority and each
active product is a legitimate route by which the resource may be asked
for, so intersecting would let one narrow row cancel a wider one somebody
wrote on purpose. A row carrying no audience is unrestricted, so it makes
the union unrestricted. `resourcesManagedBy` now returns one merged entry
per resource, which is also what the portal's "Resources you manage" list
should have been showing all along.
MSG
)"
```

---

### Task 7: A swept revocation that says whether it landed

Spec §7.1, **A6**. `applyExpirySweep` marks an entitlement action `dispatched`, counts it in `applied`, closes the sweep `applied`, moves the grant to `expired`/`lapsed` and mails the holder — and nothing anywhere moves a `SweepAction` from `dispatched` to `applied` or `failed`. A revocation Provision fails is therefore invisible: the console says the access ended, the holder has been told it ended, and the target still holds it.

**The choice:** confirm from the *inventory row*, not from a `ProvisionAction` join. `plan.ts` writes no `grantId` on a `revoke_entitlement`, so there is no link to follow — but `finish` moves the `AccountEntitlement` to `revoked` in the same transaction as the write, and that row is the thing whose absence means the person no longer holds it. The same two-conditions-not-one reasoning Govern's `reflectRevocationOutcomes` uses.

**Files:**
- Modify: `packages/core/src/automate/reflect.ts` (a new phase, after phase 2)
- Modify: `packages/core/src/automate/sweep-service.ts:826-839` (count dispatched separately)
- Modify: `packages/core/src/notify/templates/index.ts` (one new template)
- Modify: `packages/core/src/automate/notify.ts` (`NEVER_DIGESTED`)
- Test: `packages/core/src/automate/reflect.test.ts`, `packages/core/src/automate/sweep-service.test.ts`

**Interfaces:**
- Consumes: `AccountEntitlement.state`, `TargetAccount` by (`targetSystemId`, `personId`), `ProvisionAction.status`; `usersWithPermission`, `enqueueOutbox`, `displayNames`, `nameList` from `./notify.js`.
- Produces:
  - `ReflectResult` gains `revocationsConfirmed: number` and `revocationsFailed: number`. Every existing field keeps its name and meaning.
  - `applyExpirySweep` returns `{ status, applied, dispatched, skipped, failed }` — `applied` now counts only what this sweep itself finished, and `dispatched` counts what it handed to Provision.
  - A new template `automate-revocation-failed`, taking `displayName`, `subjectName`, `resourceList`, `targetName`, `message`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/automate/reflect.test.ts`:

```ts
/**
 * A swept entitlement revocation Provision could not perform.
 *
 * The sweep marked the action `dispatched`, counted it in `applied`, closed
 * itself `applied`, moved the grant to `expired` and mailed the holder to say
 * their access had ended. Nothing ever moved the `SweepAction` again. So a
 * revocation that failed at the directory was invisible from every screen: the
 * console said the access ended, the person had been told it ended, and the
 * target still held it.
 */
describe('confirming what the sweep handed to Provision', () => {
  it('moves a dispatched action to applied once the holding is gone', async () => {
    const { actionId } = await seedDispatchedSweepAction({ stillHeld: false });
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result.revocationsConfirmed).toBe(1);
    const action = await withTenant(tenantId, (tx) =>
      tx.sweepAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('applied');
  });

  it('leaves it dispatched while the revocation is still in flight', async () => {
    const { actionId } = await seedDispatchedSweepAction({ stillHeld: true });
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result.revocationsConfirmed).toBe(0);
    expect(result.revocationsFailed).toBe(0);
    const action = await withTenant(tenantId, (tx) =>
      tx.sweepAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('dispatched');
  });

  /**
   * THE ONE THAT MATTERS. The holding is still there AND Provision has already
   * reported it failed, so this is not "not yet" -- it is "not going to", and
   * somebody has to be told.
   */
  it('marks it failed, with the target message, when Provision refused', async () => {
    const { actionId } = await seedDispatchedSweepAction({
      stillHeld: true,
      provisionActionStatus: 'failed',
      provisionActionMessage: 'insufficient rights to modify the group',
    });
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result.revocationsFailed).toBe(1);
    const action = await withTenant(tenantId, (tx) =>
      tx.sweepAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('failed');
    // The TARGET's own message. Replacing it with a generic one throws away
    // the only thing that says what to fix.
    expect(action.message).toContain('insufficient rights');
  });

  it('tells the automate.manage holders that the access did not actually end', async () => {
    await seedDispatchedSweepAction({
      stillHeld: true,
      provisionActionStatus: 'failed',
      provisionActionMessage: 'insufficient rights to modify the group',
      withAdministrator: true,
    });
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-revocation-failed' } }),
    );
    expect(outbox).toHaveLength(1);
  });

  it('is idempotent — a second pass changes nothing and reports nothing', async () => {
    await seedDispatchedSweepAction({ stillHeld: false });
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const second = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(second.revocationsConfirmed).toBe(0);
    expect(second.revocationsFailed).toBe(0);
  });
});
```

Write `seedDispatchedSweepAction` beside it. It must create: a person, a `TargetSystem`, a `TargetAccount` for that person at that target, an `Entitlement`, an `AccountEntitlement` in state `held` or `revoked` per `stillHeld`, an `AccessGrant` in `expired` for (`entitlement`, that entitlement id, that target), an `ExpirySweep` in `applied`, and a `SweepAction` in `dispatched` referencing the grant. When `provisionActionStatus` is given, add a `ProvisionRun` in `partially_applied` and a `revoke_entitlement` `ProvisionAction` on it for that (accountId, entitlementId) carrying the message. When `withAdministrator` is set, create a role holding `PERMISSIONS.AUTOMATE_MANAGE` and a user assigned to it. Model the shapes on `seedPlannedOrder` in Task 5 and on the existing fixtures in `sweep-service.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/reflect.test.ts -t 'handed to Provision'`

Expected: FAIL — `revocationsConfirmed` is `undefined` on the result, and every `SweepAction` is still `dispatched`.

- [ ] **Step 3: Add the template**

In `packages/core/src/notify/templates/index.ts`, beside `automate-lapsed`:

```ts
  // Sent when a removal Provision was asked to perform did not happen.
  //
  // The holder has ALREADY been told their access ended, because the sweep
  // tells them at dispatch — which is right, since the grant has left desired
  // state and there is nothing more for them to do. This one goes to the
  // administrators, and it is the only signal anywhere that the two statements
  // disagree: the console says the access ended and the target still holds it.
  'automate-revocation-failed': {
    subject: 'A removal at {{tenantName}} did not happen',
    text: 'Hello {{displayName}},\n\n{{subjectName}}’s access to {{resourceList}} was expired in Syntra and the removal at {{targetName}} did not go through.\n\nWhat the target said: {{message}}\n\nThey have already been told their access ended, so until this is fixed the record and the target disagree. Provision keeps the grant out of desired state, so a fixed target converges on the next run without anybody re-raising anything.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{subjectName}}</strong>’s access to <strong>{{resourceList}}</strong> was expired in Syntra and the removal at {{targetName}} did not go through.</p><p>What the target said: {{message}}</p><p>They have already been told their access ended, so until this is fixed the record and the target disagree. Provision keeps the grant out of desired state, so a fixed target converges on the next run without anybody re-raising anything.</p>',
  },
```

and add it to `NEVER_DIGESTED` in `packages/core/src/automate/notify.ts`, beside `automate-fulfilment-failed`:

```ts
  // A removal that did not happen is the traffic a digest must never hold: it
  // is the one message that says the console and the target disagree about who
  // holds what, and tomorrow morning is not when somebody should read it.
  'automate-revocation-failed',
```

- [ ] **Step 4: Add the confirmation phase**

In `packages/core/src/automate/reflect.ts`, extend `ReflectResult`:

```ts
export interface ReflectResult {
  linked: number;
  fulfilled: number;
  failed: number;
  redispatched: number;
  slaAlerts: number;
  /** Swept entitlement revocations the target is now observed to have made. */
  revocationsConfirmed: number;
  /** Swept entitlement revocations Provision has reported it cannot make. */
  revocationsFailed: number;
}
```

initialise both to `0` in the `result` literal, and insert this phase between phase 2 and phase 3:

```ts
  // ---- Phase 2a: what the sweep handed to Provision. ----------------------
  //
  // `applyExpirySweep` marks an entitlement action `dispatched`, moves the
  // grant to `expired` or `lapsed`, and mails the holder to say their access
  // has ended — and nothing moved the `SweepAction` again, ever. `dispatched`
  // was terminal in practice, so a revocation that failed at the directory was
  // invisible from every screen: the console said the access ended, the person
  // had been told it ended, and the target still held it.
  //
  // Confirmed from the INVENTORY ROW, not from a `ProvisionAction` join.
  // `plan.ts` writes no `grantId` on a `revoke_entitlement`, so there is no
  // link to follow — but `finish` moves the `AccountEntitlement` to `revoked`
  // in the same transaction as the write, and that row's state is the
  // observation. `applied` therefore needs the holding to be GONE, which is
  // the same two-conditions-not-one rule Govern's `reflectRevocationOutcomes`
  // applies: a write that reported success and did not land is a case
  // Provision's convergence logic exists for, and Automate should not be more
  // credulous than Provision is.
  //
  // Still held is not a failure by itself — the next run has not happened yet.
  // It becomes one when Provision has already reported a terminal non-applied
  // outcome for that holding, which is "not going to" rather than "not yet".
  const dispatchedActionIds = await withTenant(tenantId, async (tx) =>
    (
      await tx.sweepAction.findMany({
        where: { status: 'dispatched', resourceType: 'entitlement' },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  for (const batch of reflectChunk(dispatchedActionIds, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      const sweepActions = await tx.sweepAction.findMany({ where: { id: { in: batch } } });
      const failures: {
        subjectPersonId: string;
        resourceId: string;
        targetSystemId: string | null;
        message: string;
      }[] = [];

      for (const action of sweepActions) {
        if (action.targetSystemId === null) continue;
        const account = await tx.targetAccount.findFirst({
          where: {
            targetSystemId: action.targetSystemId,
            personId: action.subjectPersonId,
          },
          select: { id: true },
        });
        if (account === null) {
          // No account at the target means no holding at the target. There is
          // nothing left to revoke and nothing to wait for.
          await tx.sweepAction.update({
            where: { id: action.id },
            data: {
              status: 'applied',
              message: 'the person holds no account at this target',
            },
          });
          result.revocationsConfirmed += 1;
          continue;
        }

        const stillHeld = await tx.accountEntitlement.count({
          where: {
            accountId: account.id,
            entitlementId: action.resourceId,
            state: 'held',
          },
        });
        if (stillHeld === 0) {
          await tx.sweepAction.update({
            where: { id: action.id },
            data: { status: 'applied', message: null },
          });
          result.revocationsConfirmed += 1;
          continue;
        }

        const refused = await tx.provisionAction.findFirst({
          where: {
            actionType: 'revoke_entitlement',
            accountId: account.id,
            entitlementId: action.resourceId,
            status: { in: ['failed', 'conflict', 'pending_retry'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { status: true, message: true },
        });
        if (refused === null) continue;

        const message = refused.message ?? refused.status;
        await tx.sweepAction.update({
          where: { id: action.id },
          data: { status: 'failed', message },
        });
        result.revocationsFailed += 1;
        failures.push({
          subjectPersonId: action.subjectPersonId,
          resourceId: action.resourceId,
          targetSystemId: action.targetSystemId,
          message,
        });
      }

      if (failures.length === 0) return;

      // One read for the batch, not one per failure. The holder is NOT told
      // again: they were told at dispatch that their access ended, which is
      // true of the grant and is all they can act on. This goes to the people
      // who can fix the disagreement.
      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      if (managers.length === 0) return;
      const failureNames = await displayNames(tx, {
        personIds: failures.map((f) => f.subjectPersonId),
        resources: failures.map((f) => ({
          resourceType: 'entitlement' as ResourceType,
          resourceId: f.resourceId,
        })),
      });
      const targetNames = new Map(
        (
          await tx.targetSystem.findMany({
            where: {
              id: {
                in: [
                  ...new Set(
                    failures
                      .map((f) => f.targetSystemId)
                      .filter((id): id is string => id !== null),
                  ),
                ],
              },
            },
            select: { id: true, name: true },
          })
        ).map((t) => [t.id, t.name]),
      );

      await enqueueOutbox(
        tx,
        failures.flatMap((failure) =>
          managers.map((r) => ({
            template: 'automate-revocation-failed' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              subjectName:
                failureNames.get(`person:${failure.subjectPersonId}`) ?? 'somebody',
              resourceList: nameList(failureNames, [
                { resourceType: 'entitlement' as ResourceType, resourceId: failure.resourceId },
              ]),
              targetName:
                (failure.targetSystemId === null
                  ? undefined
                  : targetNames.get(failure.targetSystemId)) ?? 'a target system',
              message: failure.message,
            },
            requestId: null,
            userId: r.userId,
          })),
        ),
      );
    });
  }
```

- [ ] **Step 5: Stop the sweep counting dispatched as applied**

In `packages/core/src/automate/sweep-service.ts`, change `applyExpirySweep`'s return type to `Promise<{ status: string; applied: number; dispatched: number; skipped: number; failed: number }>`, add `let dispatched = 0;` beside `applied`, return `batchDispatched` from the batch closure, and in the entitlement branch increment that instead of `batchApplied`:

```ts
          if (action.targetSystemId !== null) batchTargets.push(action.targetSystemId);
          await tx.sweepAction.update({
            where: { id: action.id },
            data: { status: 'dispatched' },
          });
          // COUNTED SEPARATELY from `applied`, and the difference is the whole
          // of this defect. Nothing here has happened at the target yet: the
          // grant has left desired state and Provision will plan the removal
          // on its next run. Counting it as applied made the sweep close
          // `applied` and the console say the access had ended, which was a
          // claim about a write nobody had made. `reflectProvisionOutcomes`
          // moves these to `applied` or `failed` once there is an observation
          // to move them on.
          batchDispatched += 1;
          continue;
```

Note the `continue`: the audit event and the holder's notification below still run for a dispatched action, so hoist them above this branch rather than skipping them — the grant genuinely ended, and the holder is genuinely told. Keep the loop's existing order and only split the counter.

Then in phase 3, leave the `status` computation reading `failed`/`applied` as it does, and return `{ status, applied, dispatched, skipped: claim.skipped, failed }`.

- [ ] **Step 6: Update the two callers**

`packages/core/src/automate/jobs.ts:710` and `apps/api/src/routes/admin/automate.ts:323` both take the result. Neither destructures `applied` in a way that breaks, but the route's response shape is the console's, so add `dispatched` to whatever it sends and to the `admin/automate` sweep view's type in `apps/web`. Run `npx tsc -b` to find every site rather than grepping for them.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/automate/reflect.test.ts packages/core/src/automate/sweep-service.test.ts`

Expected: PASS. Existing sweep tests asserting `applied` for an entitlement action need their expectations moved to `dispatched` — that is the point of the change, and each edit should carry a one-line comment saying so.

- [ ] **Step 8: Run the job and notification neighbours**

Run: `npx vitest run packages/core/src/automate/jobs.test.ts packages/core/src/automate/notify.test.ts`

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/automate/reflect.ts \
        packages/core/src/automate/reflect.test.ts \
        packages/core/src/automate/sweep-service.ts \
        packages/core/src/automate/sweep-service.test.ts \
        packages/core/src/automate/notify.ts \
        packages/core/src/notify/templates/index.ts \
        packages/core/src/automate/jobs.ts \
        apps/api/src/routes/admin/automate.ts
git commit -m "$(cat <<'MSG'
fix(automate): a swept revocation that says whether it landed

The sweep marked an entitlement action `dispatched`, counted it in
`applied`, closed itself `applied`, moved the grant to expired or lapsed
and mailed the holder to say their access had ended -- and nothing anywhere
moved a SweepAction again. `dispatched` was terminal in practice.

So a revocation Provision could not perform was invisible from every
screen. The console said the access ended. The person had been told it
ended. The target still held it, and nothing said the two disagreed.

Confirmed from the inventory row rather than a ProvisionAction join,
because `plan.ts` writes no grantId on a revoke_entitlement and there is no
link to follow -- but `finish` moves the AccountEntitlement to `revoked` in
the same transaction as the write. Applied needs the holding to be GONE,
which is the same two-conditions-not-one rule Govern's revocation
reflection applies: a write that reported success and did not land is what
Provision's convergence logic exists for.

Still held is not a failure on its own; it becomes one when Provision has
already reported a terminal non-applied outcome, which is "not going to"
rather than "not yet". The administrators are told then, with the target's
own message, and the template is never digested -- a message saying the
console and the target disagree about who holds what should not arrive in
tomorrow morning's summary.

The sweep now counts `dispatched` separately from `applied`, because they
are different claims and only one of them is about a write somebody made.
MSG
)"
```

---

### Task 8: The deactivation guard divides by the population it is protecting

Spec §7.2, **P3**. `GuardInput.activeSyntraUsersLinked` is documented in `guard.ts` as "active Syntra users linked to this target" and is printed to the administrator in exactly those words. `run-service.ts` fills it with `snapshot.users.filter((u) => u.status === 'active').length` — every active user in the tenant with a person, whatever target they belong to. A tenant with 4,000 users and one small target holding 80 linked logins can deactivate all 80 and compute 2%, which sails under a 25% threshold unconfirmed. The axis reads as a control and is one only when the tenant happens to be a single target.

**Files:**
- Modify: `packages/core/src/provision/run-service.ts:996-1013` (the guard call site) — the fix is at the call site, not in `guard.ts`, because `guard.ts` is pure and already says what the number means
- Test: `packages/core/src/provision/guard.test.ts` (the meaning), `packages/core/src/provision/run-service.test.ts` (the denominator)

**Interfaces:**
- Consumes: `snapshot.accounts` — already loaded in phase 5 as `tx.targetAccount.findMany({ where: { targetSystemId }, … })`, each carrying `personId`; `snapshot.users`, each carrying `personId` and `status`.
- Produces: no signature change anywhere. `evaluateProvisionGuard` is untouched; the value it is handed changes.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/provision/run-service.test.ts`:

```ts
/**
 * The deactivation axis, against a target that is a small part of the tenant.
 *
 * `activeSyntraUsersLinked` is documented in `guard.ts` as "active Syntra
 * users linked to this target" and printed to the administrator in those
 * words, and the run filled it with every active user in the TENANT. So a
 * plan deactivating every login belonging to this target's population divided
 * by the whole directory and computed a percentage small enough to sail
 * through unconfirmed -- on the axis whose entire job is to notice that
 * everybody is being locked out at once.
 */
describe('the deactivation guard denominator', () => {
  it('counts only the logins of people who have an account at THIS target', async () => {
    // Twenty people elsewhere in the tenant, with logins and no account here.
    await seedUnrelatedActiveUsers(20);
    // Two who do have an account at this target, both leaving.
    const leavers = await Promise.all([
      seedLeaver('Anna', 'Novak', 'anna.novak', { endDate: day('2026-06-01') }),
      seedLeaver('Bo', 'Berg', 'bo.berg', { endDate: day('2026-06-01') }),
    ]);
    for (const leaver of leavers) await seedLoginFor(leaver.personId);

    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        // 50%: two of two is 100% and trips; two of twenty-two is 9% and does
        // not. The threshold is the same either way -- what changes is which
        // population the guard is asked about.
        data: { deactivateSyntraUserThresholdPercent: 50, lastAppliedRunAt: NOW },
      }),
    );

    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(row.status).toBe('blocked');
    expect(row.requiresConfirmation).toBe(true);
    expect(row.blockedReason).toContain('active Syntra users linked to this target');
  });
});
```

Write `seedUnrelatedActiveUsers(n)` — `n` persons each with an active contract and an active `User`, and **no** `TargetAccount` — and `seedLoginFor(personId)` — one active `User` linked to that person — beside the file's existing fixtures.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/provision/run-service.test.ts -t 'deactivation guard denominator'`

Expected: FAIL. The run is `previewed`, not `blocked`: two deactivations over twenty-two tenant users is 9%, under the 50% threshold.

- [ ] **Step 3: Build the denominator from the target's own population**

In `packages/core/src/provision/run-service.ts`, immediately above the `evaluateProvisionGuard({` call, insert:

```ts
    /**
     * The people this target actually has accounts for.
     *
     * `guard.ts` documents `activeSyntraUsersLinked` as "active Syntra users
     * linked to this target" and prints that phrase to the administrator, and
     * this used to be `snapshot.users.filter(active).length` — every active
     * user in the TENANT. On a tenant with one small target that is the same
     * number by accident; on any tenant with two, it is the wrong one, and
     * wrong in the permissive direction. Four thousand users, one target with
     * eighty linked logins: deactivating all eighty computes 2%, sails under a
     * 25% threshold and applies unattended, on the axis whose entire job is to
     * notice that a population is being locked out at once.
     *
     * `snapshot.accounts` is already the target's own account set from phase
     * 5, and every row carries a `personId` — a person with an account here is
     * exactly what "linked to this target" means, and it is the same set the
     * `deactivate_syntra_user` actions are drawn from, so numerator and
     * denominator finally come from one place.
     */
    const personsAtThisTarget = new Set(snapshot.accounts.map((a) => a.personId));
    const activeSyntraUsersLinked = snapshot.users.filter(
      (u) =>
        u.status === 'active' &&
        u.personId !== null &&
        personsAtThisTarget.has(u.personId),
    ).length;
```

and pass it:

```ts
      activeSyntraUsersLinked,
```

- [ ] **Step 4: Nail the meaning down where it is pure**

Append to `packages/core/src/provision/guard.test.ts`:

```ts
  /**
   * The unit statement of what the run now computes. Kept here as well as in
   * `run-service.test.ts` because this file is where the axis's arithmetic
   * lives: a future change to the call site that quietly widens the
   * denominator again would still pass there if the threshold were generous,
   * and would fail here.
   */
  it('measures deactivations against the linked population, not a wider one', () => {
    const verdict = evaluateProvisionGuard({
      ...baseInput,
      actions: [
        deactivation('person-a'),
        deactivation('person-b'),
      ],
      activeSyntraUsersLinked: 2,
      thresholds: { ...baseInput.thresholds, deactivateSyntraUserThresholdPercent: 50 },
      hasEverApplied: true,
    });
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reasons.join(' ')).toContain('active Syntra users linked to this target');
  });
```

Reuse that file's existing `baseInput` and its action factory; if it names them differently, follow what is there rather than introducing a second convention.

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npx vitest run packages/core/src/provision/guard.test.ts packages/core/src/provision/run-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/provision/run-service.ts \
        packages/core/src/provision/run-service.test.ts \
        packages/core/src/provision/guard.test.ts
git commit -m "$(cat <<'MSG'
fix(provision): the deactivation guard divides by the population it protects

`guard.ts` documents `activeSyntraUsersLinked` as "active Syntra users
linked to this target" and prints that phrase to the administrator. The run
filled it with every active user in the tenant.

On a tenant with one target the two numbers coincide by accident. On any
tenant with two, the denominator is the wrong one and wrong in the
permissive direction: four thousand users and one target holding eighty
linked logins means deactivating all eighty computes 2%, sails under a 25%
threshold and applies unattended -- on the axis whose entire job is to
notice that a population is being locked out at once.

Built from `snapshot.accounts`, which phase 5 already loads for this target
and which carries a personId. A person with an account here is exactly what
"linked to this target" means, and it is the same set the
deactivate_syntra_user actions are drawn from, so the numerator and the
denominator now come from one place.

The arithmetic is asserted in guard.test.ts as well as the run, because a
future widening of the call site would still pass there under a generous
threshold and would fail here.
MSG
)"
```

---

### Task 9: A start date the requester can choose, and a pre-hire who can ask

Spec §7.1, **A4**. `grantWindow` can only return `scheduled` when `requestedStartsAt` is in the future — hard-coded `null` at the one call site, because the column and the field do not exist — or when the subject has zero active contracts, which every route to fulfilment already refuses. So nothing writes `status: 'scheduled'`, and the tick job's promotion pass, the `LIVE_GRANT_STATUSES` member, `fulfilRequest`'s `window.scheduled` branches and Provision's exclusion of `scheduled` grants from desired state all service a status that cannot occur.

**The choice: build it.** The register offers deleting the scheduled machinery instead, and the design refuses that — §12 describes the pre-hire as a feature ("a grant held by somebody who has not started is a question, not an instruction"), §11 gives `startsAt` three sources of which the requester's chosen date is one, and the sweep already classifies `startingSoon` against a pre-hire horizon. The machinery is right; the two things that reach it were never built.

Two halves, in one task because neither is reachable without the other: `checkEligibility` must admit a future joiner inside the horizon (otherwise the pre-hire can never submit), and `requestedStartsAt` must exist from the contract to the grant (otherwise a present employee can never schedule one).

**Files:**
- Create: `packages/db/prisma/migrations/20260901000000_access_request_requested_starts_at/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`AccessRequest`)
- Modify: `packages/core/src/automate/eligibility.ts` (the contract gate)
- Modify: `packages/core/src/automate/request-service.ts` (accept and store it)
- Modify: `packages/core/src/automate/fulfil.ts:294-312` (stop passing `null`)
- Modify: `packages/contracts/src/automate.ts:119-133` (`submitRequestBody`)
- Modify: `apps/api/src/routes/automate-portal.ts:252-273`
- Modify: `apps/web/src/pages/automate/RequestFormPage.tsx`
- Test: `packages/core/src/automate/eligibility.test.ts` (create if absent), `packages/core/src/automate/fulfil.test.ts`, `packages/core/src/automate/request-service.test.ts`, `apps/web/src/pages/automate/RequestFormPage.test.tsx`

**Interfaces:**
- Consumes: `automateSettings(tx)` → `preHireHorizonDays`; `TargetSystem.preHireDays`; `grantWindow({ now, days, requestedStartsAt, earliestContractStart })` from `./duration.js`, unchanged.
- Produces:
  - `AccessRequest.requestedStartsAt: DateTime?`
  - `checkEligibility(tx, productId, subjectPersonId, on)` keeps its signature and now admits a subject all of whose contracts start within the product's pre-hire horizon.
  - `SubmitRequestInput` gains `requestedStartsAt?: Date | null`.
  - `submitRequestBody` gains `requestedStartsAt: z.coerce.date().nullable().default(null)`.
  - New export from `packages/core/src/automate/eligibility.ts`:
    `export async function preHireHorizonFor(tx: TenantClient, productId: string, now: Date): Promise<Date>`

- [ ] **Step 1: Write the failing eligibility test**

Create `packages/core/src/automate/eligibility.test.ts` (or append if it exists):

```ts
/**
 * A future joiner asking for something before their first day.
 *
 * `checkEligibility` refused anybody with no contract in force, full stop --
 * so `grantWindow`'s pre-hire branch, `fulfilRequest`'s `window.scheduled`
 * branches, the tick job's promotion pass and Provision's exclusion of
 * `scheduled` grants from desired state all serviced a status nothing could
 * ever write. The design describes the pre-hire as a feature and the sweep
 * already classifies `startingSoon` against a horizon; the catalog was the one
 * place that had never heard of it.
 *
 * The horizon is the SAME two-horizon rule section 12 states: the target
 * system's `preHireDays` for an entitlement product, and the tenant's
 * `preHireHorizonDays` for an application or local group, which has no target
 * to inherit from.
 */
describe('checkEligibility and the pre-hire horizon', () => {
  it('admits a joiner whose contract starts inside the horizon', async () => {
    const personId = await seedFutureJoiner(day('2026-06-20'));
    const verdict = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, applicationProductId, personId, NOW),
    );
    expect(verdict.ok).toBe(true);
  });

  it('refuses a joiner whose contract starts beyond it', async () => {
    const personId = await seedFutureJoiner(day('2026-09-01'));
    const verdict = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, applicationProductId, personId, NOW),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('subject_departed');
  });

  /**
   * A LEAVER still gets nothing, and that is the case this must not widen.
   * Their contracts are in the past, not the future, so no horizon reaches
   * them.
   */
  it('still refuses somebody whose contracts have ended', async () => {
    const personId = await seedLeaver(day('2026-01-01'), day('2026-03-01'));
    const verdict = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, applicationProductId, personId, NOW),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('subject_departed');
  });

  it('uses the target system’s own preHireDays for an entitlement product', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { preHireDays: 60 } }),
    );
    const personId = await seedFutureJoiner(day('2026-07-20'));
    // Beyond the tenant's 14-day horizon and inside the target's 60.
    const viaTarget = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, entitlementProductId, personId, NOW),
    );
    expect(viaTarget.ok).toBe(true);
    const viaTenant = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, applicationProductId, personId, NOW),
    );
    expect(viaTenant.ok).toBe(false);
  });
});
```

Write `seedFutureJoiner(startDate)` and `seedLeaver(startDate, endDate)`, and seed two products — one `application`, one `targetEntitlement` whose grant names `targetId` — using `createProduct` exactly as `decision-service.test.ts` does. Both products need an audience the seeded person matches; give the contracts `department: 'Finance'` and the products `{ field: 'contract.department', op: 'equals', value: 'Finance' }`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/eligibility.test.ts`

Expected: FAIL on the first and the fourth: `activeContracts` returns `[]` for a future joiner and the gate answers `subject_departed`.

- [ ] **Step 3: Teach eligibility the horizon**

In `packages/core/src/automate/eligibility.ts`, add above `checkEligibility`:

```ts
/**
 * How far ahead of `now` this product will admit somebody who has not started.
 *
 * The same two horizons section 12 states and `previewExpirySweep` already
 * builds, and deliberately not one: a domain that needs an account three weeks
 * early does not imply a portal tile three weeks early, and inventing a
 * target-derived number for an internal grant would attach it to a target the
 * grant has nothing to do with.
 *
 * The MAXIMUM across the product's targets rather than the minimum. A bundle
 * whose grants name one target is the ordinary case and the two agree; where a
 * product somehow reaches two, admitting the request is the recoverable
 * direction — the grant is `scheduled`, confers nothing until its start date,
 * and Provision's own `preHireDays` still decides when each account appears.
 * Refusing early would refuse a request nobody can re-raise until the day.
 */
export async function preHireHorizonFor(
  tx: TenantClient,
  productId: string,
  now: Date,
): Promise<Date> {
  const settings = await automateSettings(tx);
  const grants = await tx.productGrant.findMany({
    where: { productId, targetSystemId: { not: null } },
    select: { targetSystemId: true },
  });
  const targetIds = [
    ...new Set(grants.map((g) => g.targetSystemId).filter((id): id is string => id !== null)),
  ];
  const days =
    targetIds.length === 0
      ? settings.preHireHorizonDays
      : Math.max(
          ...(
            await tx.targetSystem.findMany({
              where: { id: { in: targetIds } },
              select: { preHireDays: true },
            })
          ).map((t) => t.preHireDays),
          0,
        );
  return addDays(now, days);
}
```

with imports `import { automateSettings } from './catalog-service.js';` and `import { addDays } from '../provision/plan.js';` — the same single implementation of date arithmetic `duration.ts` already borrows, for the reason its comment gives.

Then replace the contract gate (currently lines 39–46) with:

```ts
  const contracts = await activeContracts(tx, subjectPersonId, on);
  if (contracts.length === 0) {
    // THE PRE-HIRE, admitted rather than refused.
    //
    // Section 12's three meanings of "no active contract" are Provision's, and
    // this gate collapsed two of them: a LEAVER, whose contracts are behind
    // them, and a FUTURE JOINER, whose are ahead. Refusing both meant nothing
    // could ever write `status: 'scheduled'` -- so `grantWindow`'s pre-hire
    // branch, `fulfilRequest`'s two `window.scheduled` branches, the tick job's
    // promotion pass, the `LIVE_GRANT_STATUSES` member and Provision's
    // exclusion of scheduled grants from desired state all serviced a state
    // that could not occur.
    //
    // A joiner inside the horizon is admitted; the grant that results starts on
    // their first day and confers nothing before it. Beyond the horizon, and
    // for a leaver, the refusal stands exactly as it did: no horizon reaches
    // backwards, so a person whose contracts have ended is unaffected by this
    // branch.
    const all = await tx.contract.findMany({
      where: { personId: subjectPersonId },
      select: { startDate: true },
    });
    const horizon = await preHireHorizonFor(tx, productId, on);
    const startingSoon = all.some((c) => c.startDate > on && c.startDate <= horizon);
    if (!startingSoon) {
      return {
        ok: false,
        reason: 'subject_departed',
        message: `${person.givenName} ${person.familyName} holds no contract in force.`,
      };
    }
  }
```

Everything below it — the product read, the visibility check, the SoD evaluation — is unchanged and now runs for a pre-hire too, which is what it should always have done: a joiner outside the audience is still refused, and a joiner whose access would create a critical violation is still refused.

- [ ] **Step 4: Run the eligibility test to verify it passes**

Run: `npx vitest run packages/core/src/automate/eligibility.test.ts`

Expected: PASS, four tests.

- [ ] **Step 5: Add the column**

In `packages/db/prisma/schema.prisma`, in `AccessRequest`, after `requestedDurationDays`:

```prisma
  /// A start the requester deliberately chose, bounded by the product's own
  /// rules and never earlier than fulfilment. `grantWindow` takes the LATEST
  /// of now, this, and the subject's contract start where that is in the
  /// future — so a chosen date and a pre-hire compose rather than compete.
  requestedStartsAt     DateTime?
```

Then:

```bash
npx prisma migrate dev --create-only --name access_request_requested_starts_at
mv packages/db/prisma/migrations/2026*_access_request_requested_starts_at \
   packages/db/prisma/migrations/20260901000000_access_request_requested_starts_at
```

Replace the generated SQL's contents with the statement plus its reason, in the tree's house style:

```sql
-- The start date the requester chooses.
--
-- `grantWindow` has taken a `requestedStartsAt` since it was written and the
-- one call site passed a hard-coded null, because there was nowhere to put
-- one. Section 11 names three sources for a grant's start -- the moment of
-- fulfilment, a later date the requester chose, and the subject's contract
-- start where that is in the future -- and only the first and third could ever
-- occur. Together with the pre-hire admission in `checkEligibility` this is
-- what makes `GrantStatus = 'scheduled'` reachable at all, and therefore what
-- makes the tick job's promotion pass something other than dead code.
--
-- Nullable with no default: absent means "as soon as it is approved", which is
-- what every existing row means and what the portal sends unless somebody
-- fills the field in.
ALTER TABLE "AccessRequest"
  ADD COLUMN "requestedStartsAt" TIMESTAMP(3);
```

Then `npx prisma migrate deploy` against your development database and `pnpm db:generate`.

- [ ] **Step 6: Write the failing test for the end-to-end path**

Append to `packages/core/src/automate/fulfil.test.ts`:

```ts
/**
 * The two ways a grant comes out `scheduled`, neither of which could happen.
 */
describe('a grant that starts later than it is approved', () => {
  it('schedules a grant for the start date the requester chose', async () => {
    const startsAt = new Date('2026-07-01T00:00:00Z');
    const submitted = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: 'starts on the project in July',
        formValues: {},
        requestedDurationDays: 30,
        requestedStartsAt: startsAt,
      },
      { now: NOW },
    );
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.reason}`);

    const grant = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findFirstOrThrow({ where: { requestId: submitted.requestId } }),
    );
    expect(grant.status).toBe('scheduled');
    expect(grant.startsAt).toEqual(startsAt);
    // Thirty days of ACCESS, measured from the start, not thirty days of
    // waiting -- which is what `grantWindow`'s docstring has always said.
    expect(grant.endsAt).toEqual(new Date('2026-07-31T00:00:00Z'));
  });

  it('writes no application assignment until the start date', async () => {
    const submitted = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: 'later',
        formValues: {},
        requestedDurationDays: 30,
        requestedStartsAt: new Date('2026-07-01T00:00:00Z'),
      },
      { now: NOW },
    );
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.reason}`);
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toEqual([]);
  });

  it('schedules a pre-hire’s grant to their first day', async () => {
    const firstDay = new Date('2026-06-22T00:00:00Z');
    const joinerPersonId = await seedFutureJoiner(firstDay);
    const submitted = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: joinerPersonId,
        requestedByUserId: annaUserId,
        justification: 'ready on day one',
        formValues: {},
        requestedDurationDays: 30,
        requestedStartsAt: null,
      },
      { now: NOW },
    );
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.reason}`);
    const grant = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findFirstOrThrow({ where: { requestId: submitted.requestId } }),
    );
    expect(grant.status).toBe('scheduled');
    expect(grant.startsAt).toEqual(firstDay);
  });

  /**
   * A date in the past is not a scheduling instruction, it is a typo or a
   * clock skew. `grantWindow` already takes the latest of the candidates, so
   * the grant simply starts now -- asserted so that nobody later "fixes" it
   * into a backdated grant, which would be an entitlement that reads as having
   * been held before anybody approved it.
   */
  it('ignores a start date in the past', async () => {
    const submitted = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: 'typo',
        formValues: {},
        requestedDurationDays: 30,
        requestedStartsAt: new Date('2026-01-01T00:00:00Z'),
      },
      { now: NOW },
    );
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.reason}`);
    const grant = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findFirstOrThrow({ where: { requestId: submitted.requestId } }),
    );
    expect(grant.status).toBe('active');
    expect(grant.startsAt).toEqual(NOW);
  });
});
```

The product these use must have a zero-stage workflow so submission fulfils in one call; `fulfil.test.ts` already has one — reuse it rather than adding a second.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/automate/fulfil.test.ts -t 'starts later'`

Expected: FAIL — a TypeScript error on `requestedStartsAt` in `SubmitRequestInput`, and once that is silenced the grants come out `active` starting at `NOW`.

- [ ] **Step 8: Carry it from the submission to the grant**

In `packages/core/src/automate/request-service.ts`:

```ts
export interface SubmitRequestInput {
  productId: string;
  subjectPersonId: string;
  requestedByUserId: string;
  justification: string | null;
  formValues: Record<string, unknown>;
  requestedDurationDays: number | null;
  /**
   * A start the requester deliberately chose. Absent or null means "as soon as
   * it is approved", which is what every request meant before this existed.
   */
  requestedStartsAt?: Date | null;
  /** Set when this request is an extension of an existing grant. */
  replacesGrantId?: string | null;
}
```

and in the `tx.accessRequest.create` data, beside `requestedDurationDays`:

```ts
        requestedStartsAt: input.requestedStartsAt ?? null,
```

In `packages/core/src/automate/fulfil.ts`, replace the `grantWindow({ … requestedStartsAt: null … })` call (currently lines 306–311) with:

```ts
    const window = grantWindow({
      now,
      days: request.requestedDurationDays,
      // The requester's own choice, at last. This was a hard-coded `null`
      // because there was no column to read -- which meant `grantWindow` could
      // only ever return `scheduled` for a subject with no active contract,
      // and every route to fulfilment refused those. Nothing in the product
      // could write `scheduled`, so the promotion pass, the
      // `LIVE_GRANT_STATUSES` member and Provision's exclusion of scheduled
      // grants from desired state were all servicing a state that never
      // occurred.
      requestedStartsAt: request.requestedStartsAt,
      earliestContractStart,
    });
```

- [ ] **Step 9: Bound the chosen date where the duration is bounded**

In `resolveRequestedDuration`'s caller in `request-service.ts`, after the duration check, add:

```ts
    // A start further out than the pre-hire horizon is refused, and not
    // silently clamped. Somebody who asks for access from October and is
    // quietly given it from today has been given something they did not ask
    // for, on a product whose whole point is a bounded window -- and an
    // approver reading the request would see a date the grant does not honour.
    //
    // The same horizon `checkEligibility` admits a joiner within, so the two
    // answers cannot diverge: a person can schedule exactly as far ahead as a
    // joiner can be admitted.
    if (input.requestedStartsAt != null && input.requestedStartsAt > now) {
      const horizon = await preHireHorizonFor(tx, input.productId, now);
      if (input.requestedStartsAt > horizon) {
        return refuse(
          'duration_not_permitted',
          `This can be scheduled to start at most ${Math.round((horizon.getTime() - now.getTime()) / 86_400_000)} days from now.`,
        );
      }
    }
```

- [ ] **Step 10: Open the contract and the route**

In `packages/contracts/src/automate.ts`, in `submitRequestBody`, after `requestedDurationDays`:

```ts
  /**
   * `z.coerce.date()`, because the portal sends an ISO string from a
   * `<input type="date">` and the service takes a `Date`. Nullable and
   * defaulted to null: absent means "as soon as it is approved", which is what
   * every request meant before the field existed and what the form sends when
   * the requester leaves it blank.
   */
  requestedStartsAt: z.coerce.date().nullable().default(null),
```

In `apps/api/src/routes/automate-portal.ts`, in the `POST /automate/requests` handler, add `requestedStartsAt: body.requestedStartsAt,` to the `submitRequest` input object.

- [ ] **Step 11: Put the field on the form**

In `apps/web/src/pages/automate/RequestFormPage.tsx`, add `const [startsAt, setStartsAt] = useState('');` beside `days`, send it:

```ts
            requestedStartsAt: startsAt.trim() === '' ? null : startsAt,
```

and render it below the duration field:

```tsx
              {/*
                Optional, always. Blank means "as soon as this is approved",
                which is what almost every request wants -- and a required date
                picker would make the ordinary case the one that takes an extra
                decision.
              */}
              <Field
                label="Start on (optional)"
                value={startsAt}
                onChange={setStartsAt}
                type="date"
                hint="Leave blank to start as soon as this is approved. A future date holds the access until then and does not shorten it."
              />
```

If `Field` from `@syntra/ui` does not accept `type="date"`, add it there rather than dropping a bare `<input>` into this page — the panel's other controls all come from the kit.

- [ ] **Step 12: Test the form field**

Append to `apps/web/src/pages/automate/RequestFormPage.test.tsx` a case that fills the date and asserts the POST body carries `requestedStartsAt`, and one that leaves it blank and asserts the body carries `null`. Follow that file's existing fetch-mocking shape.

Run: `cd apps/web && npx vitest run src/pages/automate/RequestFormPage.test.tsx; cd ../..`

Expected: PASS.

- [ ] **Step 13: Run the core suites to verify they pass**

Run: `npx vitest run packages/core/src/automate/fulfil.test.ts packages/core/src/automate/request-service.test.ts packages/core/src/automate/eligibility.test.ts packages/core/src/automate/duration.test.ts`

Expected: PASS.

- [ ] **Step 14: Run the promotion pass, which now has something to promote**

Run: `npx vitest run packages/core/src/automate/jobs.test.ts packages/core/src/automate/desired-union.test.ts packages/core/src/provision/desired.test.ts`

Expected: PASS. `desired-union.test.ts` is what proves a `scheduled` grant contributes nothing to desired state before its start date, which was previously only assertable by writing the status by hand.

- [ ] **Step 15: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260901000000_access_request_requested_starts_at \
        packages/core/src/automate/eligibility.ts \
        packages/core/src/automate/eligibility.test.ts \
        packages/core/src/automate/request-service.ts \
        packages/core/src/automate/fulfil.ts \
        packages/core/src/automate/fulfil.test.ts \
        packages/contracts/src/automate.ts \
        apps/api/src/routes/automate-portal.ts \
        apps/web/src/pages/automate/RequestFormPage.tsx \
        apps/web/src/pages/automate/RequestFormPage.test.tsx
git commit -m "$(cat <<'MSG'
feat(automate): a start date the requester can choose, and a pre-hire who can ask

`grantWindow` could only return `scheduled` when `requestedStartsAt` was in
the future -- hard-coded null at its one call site, because there was no
column and no field -- or when the subject held no active contract, which
every route to fulfilment refused. So nothing in the product could write
`status: 'scheduled'`, and the tick job's promotion pass, the
LIVE_GRANT_STATUSES member, fulfilment's two `window.scheduled` branches
and Provision's exclusion of scheduled grants from desired state were all
servicing a state that could not occur.

Built rather than deleted, because the design describes it as a feature:
section 12 says a grant held by somebody who has not started is a question
rather than an instruction, section 11 gives a grant's start three sources
of which the requester's chosen date is one, and the expiry sweep already
classifies `startingSoon` against a pre-hire horizon. The machinery was
right; the two things that reach it were never built.

`checkEligibility` now separates the two meanings of "no contract in force"
that it used to collapse -- a leaver, whose contracts are behind them, and
a joiner, whose are ahead -- and admits a joiner inside the horizon. The
same two horizons section 12 states: the target's own preHireDays for an
entitlement product, the tenant's preHireHorizonDays otherwise. A leaver is
untouched: no horizon reaches backwards.

`requestedStartsAt` runs from the form through the contract and the route to
the column and into `grantWindow`. A date beyond the horizon is refused
rather than clamped -- quietly granting from today what somebody asked for
from October gives them something they did not ask for, under an approval
somebody gave for a different request.
MSG
)"
```

---

### Task 10: Three small ones in the approvals engine

Spec §7.1, **A7**, **A8**, **A9**. One task because all three are in `automate` and none is more than a few lines; kept out of Tasks 1–4 because none of them is about the state machine those tasks fix, and mixing them in would have made those diffs harder to read rather than easier.

**A7 — lazy stage re-resolution drops escalation approvers and restarts the SLA.** `openStage` deletes every `ApprovalStepApprover` including `via: 'escalation'`, and the resolver never re-adds them while `escalatedAt` stays set — so the people a stage was escalated to lose it, permanently, the first time somebody who is not on the step tries to decide. It also restamps `openedAt` and `slaDueAt`, so a stage that has been open for three days becomes a stage that has been open for none, and the reminder ladder starts over. And nobody is told the set changed.

**A8 — reflection stamps `fulfilledAt` on failed requests.** `fulfilRequest` sets it only for `fulfilled` and `partially_fulfilled`; `reflectProvisionOutcomes` sets it for anything not in flight, so a `fulfilment_failed` request carries a date saying when it was fulfilled.

**A9 — outbox send is at-least-once with a whole-batch duplicate window.** `runOutboxJob` reads 200 rows, sends all 200, and marks all 200 in one transaction afterwards. A crash or a rolled-back phase 3 resends every message in the batch, and two senders running at once send everything twice. **The choice: claim each row optimistically on `attempts` before sending, and mark each result as it arrives** — no schema change, no `claimedAt` column, and it makes concurrent senders disjoint rather than merely narrowing the window.

**Files:**
- Modify: `packages/core/src/automate/request-service.ts:94-128` (`openStage`)
- Modify: `packages/core/src/automate/decision-service.ts:184-201` (notify on re-resolution)
- Modify: `packages/core/src/automate/reflect.ts:233-236` (`fulfilledAt`)
- Modify: `packages/core/src/automate/jobs.ts:97-165` (`runOutboxJob`)
- Test: `packages/core/src/automate/decision-service.test.ts`, `packages/core/src/automate/reflect.test.ts`, `packages/core/src/automate/jobs.test.ts`

**Interfaces:**
- Consumes: `ApprovalStepApprover.via`, `ApprovalStep.openedAt` / `slaDueAt` / `escalatedAt`; `NotificationOutbox.attempts`.
- Produces:
  - `openStage(tx, requestId, sequence, on)` gains a fifth parameter and a richer return:
    `openStage(tx: TenantClient, requestId: string, sequence: number, on: Date, mode: 'first' | 're-resolve' = 'first'): Promise<{ outcome: 'opened'; added: string[] } | { outcome: 'blocked' }>`
  - `runOutboxJob` keeps `Promise<{ sent: number; failed: number }>` and gains `skipped` — rows another sender had already claimed.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/automate/decision-service.test.ts`:

```ts
/**
 * Re-resolving an open stage, which happens whenever somebody not on the
 * materialized set tries to decide.
 *
 * `openStage` deleted every approver row and rebuilt from the resolver -- and
 * the resolver never produces `via: 'escalation'` rows, which the tick job
 * creates and which it will not create again while `escalatedAt` is set. So a
 * stage escalated on Tuesday lost the people it was escalated TO the first
 * time an unrelated person opened it on Wednesday, silently and for good.
 *
 * It also restamped `openedAt` and `slaDueAt`, so a stage three days late
 * became a stage no minutes late, and the whole reminder ladder started again.
 */
describe('re-resolving an open stage', () => {
  it('keeps the approvers the stage was escalated to', async () => {
    const requestId = await open();
    const stepId = await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findFirstOrThrow({ where: { requestId, sequence: 1 } });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: boPersonId, via: 'escalation' },
      });
      await tx.approvalStep.update({ where: { id: step.id }, data: { escalatedAt: LATER } });
      return step.id;
    });

    // Rik is the subject's new manager, so re-resolution rebuilds the selector
    // set around him -- the path that used to take Bo out with it.
    const { personId: rikPersonId, userId: rikUserId } = await person('Rik');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: rikPersonId },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: rikPersonId, deciderUserId: rikUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );

    const approvers = await withTenant(tenantId, (tx) =>
      tx.approvalStepApprover.findMany({ where: { stepId } }),
    );
    expect(approvers.map((a) => a.via)).toContain('escalation');
    expect(approvers.filter((a) => a.via === 'escalation').map((a) => a.personId)).toEqual([
      boPersonId,
    ]);
  });

  it('does not restart the SLA clock', async () => {
    const requestId = await open();
    const before = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findFirstOrThrow({ where: { requestId, sequence: 1 } }),
    );
    const { personId: rikPersonId, userId: rikUserId } = await person('Rik');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: rikPersonId },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: rikPersonId, deciderUserId: rikUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const after = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findFirstOrThrow({ where: { requestId, sequence: 1 } }),
    );
    expect(after.openedAt).toEqual(before.openedAt);
    expect(after.slaDueAt).toEqual(before.slaDueAt);
  });

  it('tells the approvers it just added', async () => {
    const requestId = await open();
    const { personId: rikPersonId, userId: rikUserId } = await person('Rik');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: rikPersonId },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: rikPersonId, deciderUserId: rikUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({
        where: { requestId, template: 'automate-stage-opened' },
      }),
    );
    // Jan was told when the stage first opened; Rik is told when it becomes
    // his. Without this a reassignment is a request that silently moved to
    // somebody who has no idea it is with them.
    expect(outbox.map((o) => o.to).sort()).toEqual(['jan@acme.test', 'rik@acme.test']);
  });
});
```

Append to `packages/core/src/automate/reflect.test.ts`:

```ts
  /**
   * `fulfilRequest` stamps `fulfilledAt` only for `fulfilled` and
   * `partially_fulfilled`. Reflection stamped it for anything not in flight,
   * so a request that failed at every item carried a date saying when it had
   * been fulfilled -- which is the column every report and every timeline
   * reads to say when somebody got their access.
   */
  it('does not stamp fulfilledAt on a request that failed outright', async () => {
    const { requestId } = await seedFailedDispatch();
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('fulfilment_failed');
    expect(request.fulfilledAt).toBeNull();
  });
```

Append to `packages/core/src/automate/jobs.test.ts`:

```ts
/**
 * The outbox's duplicate window, which was the whole batch.
 *
 * Phase 1 read 200 rows, phase 2 sent all 200, and phase 3 marked all 200 in
 * one transaction at the end. A crash, a P2028 on that transaction, or simply
 * a second sender running at the same time resent every message in the batch:
 * approvers got the same request twice, and a person got two copies of the
 * password-reset-shaped mail that says their access ended.
 */
describe('runOutboxJob and sending twice', () => {
  it('claims each row before sending it, so a second sender sends nothing', async () => {
    await seedOutboxRows(3);
    const transport = countingTransport();
    const [a, b] = await Promise.all([
      runOutboxJob(transport, { tenantId }, { now: NOW }),
      runOutboxJob(transport, { tenantId }, { now: NOW }),
    ]);
    expect(a.sent + b.sent).toBe(3);
    expect(transport.sent).toHaveLength(3);
  });

  it('records a send that happened even when a later one in the batch throws', async () => {
    await seedOutboxRows(2);
    const transport = failingAfter(1);
    await runOutboxJob(transport, { tenantId }, { now: NOW }).catch(() => undefined);
    const rows = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    // The first is marked sent even though the second threw. Marking per row
    // rather than per batch is what makes a partial pass keep its progress.
    expect(rows[0]!.sentAt).not.toBeNull();
  });
});
```

Write `seedOutboxRows(n)`, `countingTransport()` and `failingAfter(n)` beside the file's existing transport fakes; if it already has a fake transport, extend it rather than adding a second.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/core/src/automate/decision-service.test.ts -t 'Re-resolving'
npx vitest run packages/core/src/automate/reflect.test.ts -t 'fulfilledAt'
npx vitest run packages/core/src/automate/jobs.test.ts -t 'sending twice'
```

Expected: FAIL, all three. The escalation row is gone, `openedAt` has moved, no mail was sent to Rik, `fulfilledAt` is a date, and the two concurrent outbox jobs send six messages for three rows.

- [ ] **Step 3: Preserve escalation and the clock in `openStage`**

Replace the whole of `openStage` in `packages/core/src/automate/request-service.ts` — its docstring above it stays as it is — with:

```ts
export async function openStage(
  tx: TenantClient,
  requestId: string,
  sequence: number,
  on: Date,
  /**
   * `first` is a stage being opened for the first time; `re-resolve` is an
   * already-open stage being rebuilt because somebody not on the materialized
   * set tried to decide it. The two differ in what they may throw away — see
   * the escalation and clock comments below — and defaulting to `first` keeps
   * every existing call site meaning what it meant.
   */
  mode: 'first' | 're-resolve' = 'first',
): Promise<{ outcome: 'opened'; added: string[] } | { outcome: 'blocked' }> {
  const step = await tx.approvalStep.findFirstOrThrow({
    where: { requestId, sequence },
  });
  const stage = step.stageSnapshot as unknown as StageSnapshot;
  const subject = await subjectFor(tx, requestId);
  const result = await resolveStageApprovers(tx, stage, subject, on);

  /**
   * WHAT THE RESOLVER CANNOT REBUILD IS KEPT, NOT DELETED.
   *
   * `resolveStageApprovers` produces `selector` and `fallback` rows.
   * `via: 'escalation'` rows are written by the tick job, once, and it will
   * never write them again while `escalatedAt` is set. Deleting everything and
   * rebuilding therefore removed the people a stage had been escalated to --
   * permanently, silently, and triggered by an unrelated person opening the
   * request. The one control that stops an SLA breach sitting for ever was
   * undone by somebody clicking a link.
   */
  const escalated = await tx.approvalStepApprover.findMany({
    where: { stepId: step.id, via: 'escalation' },
    select: { personId: true, onBehalfOfPersonId: true },
  });
  const before = new Set(
    (
      await tx.approvalStepApprover.findMany({
        where: { stepId: step.id },
        select: { personId: true },
      })
    ).map((a) => a.personId),
  );

  await tx.approvalStepApprover.deleteMany({
    where: { stepId: step.id, via: { not: 'escalation' } },
  });
  if (result.approvers.length === 0 && escalated.length === 0) return { outcome: 'blocked' };

  const escalatedIds = new Set(escalated.map((e) => e.personId));
  const fresh = result.approvers.filter((a) => !escalatedIds.has(a.personId));
  if (fresh.length > 0) {
    await tx.approvalStepApprover.createMany({
      data: fresh.map((approver) => ({
        tenantId: step.tenantId,
        stepId: step.id,
        personId: approver.personId,
        via: approver.via,
        onBehalfOfPersonId: approver.onBehalfOfPersonId,
      })),
    });
  }

  await tx.approvalStep.update({
    where: { id: step.id },
    data: {
      status: 'open',
      /**
       * THE CLOCK IS NOT RESTARTED BY A RE-RESOLUTION.
       *
       * A stage opened on Monday and re-resolved on Thursday has been waiting
       * since Monday. Restamping made it a stage that had been waiting no time
       * at all: the reminder ladder began again from its halfway milestone, the
       * escalation the tick job was about to perform was pushed another
       * `slaHours` into the future, and an `onTimeout: 'expire'` stage could
       * be kept alive indefinitely by anybody opening the request. The SLA is
       * a promise to the requester about how long this takes, and it is not
       * the resolver's to reset.
       */
      ...(mode === 're-resolve' && step.openedAt !== null
        ? {}
        : {
            openedAt: on,
            slaDueAt: new Date(on.getTime() + stage.slaHours * 3_600_000),
          }),
    },
  });

  return {
    outcome: 'opened',
    added: fresh.map((a) => a.personId).filter((id) => !before.has(id)),
  };
}
```

- [ ] **Step 4: Update the three call sites and notify on reassignment**

`request-service.ts`'s own call becomes:

```ts
      const opened = await openStage(tx, request.id, 1, now);
      if (opened.outcome === 'blocked') {
```

`decision-service.ts`'s next-stage call becomes:

```ts
      const opened = await openStage(tx, request.id, next.sequence, now);
      if (opened.outcome === 'blocked') {
```

and its re-resolution call (currently line 185) becomes:

```ts
            const reopened = await openStage(tx, request.id, step.sequence, now, 're-resolve');
            if (reopened.outcome === 'blocked') {
              throw new DecisionRefusedError(
                'not-an-approver',
                'This request no longer resolves to anybody, including you.',
              );
            }
            // The design's reassignment notification, which this path never
            // had. A request that silently moves to somebody is a request that
            // sits there: they are not looking at a queue they were never told
            // about. Only the people who were NOT on the step before are
            // mailed, so re-resolving over a set that has not changed sends
            // nothing.
            if (reopened.added.length > 0) {
              const moved = await recipientsForPersons(tx, reopened.added);
              const movedNames = await displayNames(tx, {
                personIds: [
                  request.subjectPersonId,
                  ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
                ],
              });
              await enqueueOutbox(
                tx,
                moved.map((r) => ({
                  template: 'automate-stage-opened' as const,
                  to: r.email,
                  vars: {
                    displayName: r.displayName,
                    requesterName:
                      request.requestedByPersonId === null
                        ? 'the requester'
                        : (movedNames.get(`person:${request.requestedByPersonId}`) ??
                          'the requester'),
                    productName: request.product?.name ?? 'the requested access',
                    subjectName:
                      movedNames.get(`person:${request.subjectPersonId}`) ??
                      'the person this is for',
                    justification: request.justification ?? '',
                    requestUrl: requestUrl(publicUrl, request.id),
                  },
                  requestId: request.id,
                  userId: r.userId,
                })),
              );
            }
```

`npx tsc -b` will name any other call site; there are three in the tree today.

- [ ] **Step 5: Stop stamping `fulfilledAt` on a failure**

In `packages/core/src/automate/reflect.ts`, replace the `tx.accessRequest.update` in phase 3 (currently lines 233–236) with:

```ts
      await tx.accessRequest.update({
        where: { id: requestId },
        data: {
          status,
          // The SAME rule `fulfilRequest` applies, and it was two different
          // rules in two files. `...(inFlight ? {} : { fulfilledAt: now })`
          // stamped a fulfilment date on a request every item of which had
          // failed -- and that column is what every report and every timeline
          // reads to say when somebody got their access.
          ...(status === 'fulfilled' || status === 'partially_fulfilled'
            ? { fulfilledAt: now }
            : {}),
        },
      });
```

- [ ] **Step 6: Claim outbox rows before sending them**

In `packages/core/src/automate/jobs.ts`, replace phases 1–3 of `runOutboxJob` with:

```ts
  // Phase 1: read out, then CLAIM. The tenant NAME comes with it, so nothing
  // downstream needs a transaction to render.
  const tenant = await prisma.tenant.findUnique({
    where: { id: payload.tenantId },
    select: { name: true },
  });
  if (tenant === null) return { sent: 0, failed: 0, skipped: 0 };

  const candidates = await withTenant(payload.tenantId, (tx) =>
    tx.notificationOutbox.findMany({
      where: {
        sentAt: null,
        digest: false,
        attempts: { lt: OUTBOX_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    }),
  );

  /**
   * The claim, and it is what turns a whole-batch duplicate window into none.
   *
   * The old shape read 200 rows, sent 200 messages, and marked 200 rows in one
   * transaction at the END. A crash, a P2028 on that transaction, or a second
   * sender running at the same time resent every message in the batch:
   * approvers received the same request twice, and somebody received two
   * copies of the notice saying their access had ended.
   *
   * Optimistic concurrency on `attempts`, which is a column that already
   * exists and already means "how many times has this been tried". Each row is
   * claimed by incrementing it FROM the value this pass read, so exactly one
   * of two concurrent senders wins each row and the two batches become
   * disjoint rather than identical. No `claimedAt` column, no schema change,
   * and a crash after the claim costs at most one attempt out of
   * OUTBOX_MAX_ATTEMPTS rather than an unbounded resend.
   */
  const claimed: typeof candidates = [];
  let skipped = 0;
  await withTenant(payload.tenantId, async (tx) => {
    for (const row of candidates) {
      const { count } = await tx.notificationOutbox.updateMany({
        where: { id: row.id, sentAt: null, attempts: row.attempts },
        data: { attempts: row.attempts + 1 },
      });
      if (count === 1) claimed.push(row);
      else skipped += 1;
    }
  });

  // Phase 2: the network, and the result written per row as it arrives. No
  // transaction is held across a send.
  const now = options.now ?? new Date();
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    let error: string | null = null;
    try {
      const message = renderMessage(
        tenant.name,
        row.template as TemplateName,
        row.to,
        (row.vars ?? {}) as Record<string, string>,
      );
      await sendMessage(transport, message);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    // Per row, immediately. Batching this at the end is what made a failure
    // anywhere in the batch lose the record of every send before it -- and
    // those sends had already happened.
    await withTenant(payload.tenantId, (tx) =>
      tx.notificationOutbox.update({
        where: { id: row.id },
        data:
          error === null
            ? { sentAt: now, lastError: null }
            : // `attempts` is NOT incremented again: the claim above already
              // did it. Never deleted either -- a row that exhausts its
              // attempts is surfaced, not swallowed, because "the approver
              // says they never got the mail" is unanswerable without it.
              { lastError: error },
      }),
    );
    if (error === null) sent += 1;
    else failed += 1;
  }

  return { sent, failed, skipped };
```

and widen the return type to `Promise<{ sent: number; failed: number; skipped: number }>`.

- [ ] **Step 7: Run the three suites to verify they pass**

Run: `npx vitest run packages/core/src/automate/decision-service.test.ts packages/core/src/automate/reflect.test.ts packages/core/src/automate/jobs.test.ts`

Expected: PASS. The existing decision-service test asserting `approvers.map((a) => a.personId)).toEqual([rikPersonId])` after a reassignment (currently around line 458) needs its expectation widened where an escalation row is present — check whether that case has one; if not, it is unaffected.

- [ ] **Step 8: Run the request and notification neighbours**

Run: `npx vitest run packages/core/src/automate/request-service.test.ts packages/core/src/automate/approvers.test.ts packages/core/src/automate/notify.test.ts`

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/automate/request-service.ts \
        packages/core/src/automate/decision-service.ts \
        packages/core/src/automate/decision-service.test.ts \
        packages/core/src/automate/reflect.ts \
        packages/core/src/automate/reflect.test.ts \
        packages/core/src/automate/jobs.ts \
        packages/core/src/automate/jobs.test.ts
git commit -m "$(cat <<'MSG'
fix(automate): keep escalations, keep the clock, send each mail once

Three small ones in the request engine.

`openStage` deleted every approver row and rebuilt from the resolver, which
produces `selector` and `fallback` rows and never `escalation` ones -- the
tick job writes those, once, and will not write them again while
`escalatedAt` is set. So a stage escalated on Tuesday lost the people it
had been escalated TO the first time somebody unrelated opened the request
on Wednesday. The one control that stops an SLA breach sitting for ever was
undone by somebody clicking a link.

It also restamped openedAt and slaDueAt, so a stage three days late became
a stage no minutes late: the reminder ladder began again, the escalation
was pushed another slaHours out, and an expiring stage could be kept alive
indefinitely by anybody opening the request. And nobody was told the set
had changed, so a reassigned request moved silently to somebody who was not
looking at a queue they had never heard of.

Reflection stamped `fulfilledAt` on anything not in flight, so a request
every item of which failed carried a date saying when it was fulfilled --
the column every report and timeline reads to answer exactly that.

And the outbox read 200 rows, sent 200 messages, and marked 200 rows in one
transaction at the end. A crash, a P2028 on that transaction, or a second
sender running at once resent the whole batch. Rows are now claimed
optimistically on `attempts` -- a column that already exists and already
means what it needs to mean -- so two senders take disjoint batches, and
each result is written as it arrives rather than after the last send.
MSG
)"
```

---

### Task 11: Four small ones in provisioning

Spec §7.2, **P4**, **P5**, **P6**, **P7**. Grouped for the same reason as Task 10, and split from it because these are a different subsystem with different reviewers.

**P4 — every pre-hire raises a false drift finding on every run.** `finish` records a created-disabled pre-hire account as `active`, deliberately: `plan.ts` gates the confirmable re-enable on the recorded status, so recording `disabled` would turn the joiner's first enable into something an administrator has to tick. `reconcile` then compares the recorded status against the target's and raises `unexpected_status` every run until the start date. Ten hires a fortnight out means ten open findings for a fortnight, which trains administrators to ignore the drift tab. **The choice: suppress it in `reconcile`, where the desired state is in hand, rather than change what `finish` records** — the recorded status has a reason, and the finding is the thing that is wrong.

**P5 — creating a business rule never verifies the target.** The update path checks that the rule belongs to the target; the create path relies on the foreign key, which is evaluated under RLS the row is being inserted into. A typo gives a bare 500; a valid other-tenant id stores an inert cross-tenant row.

**P6 — `pending_retry` actions are never superseded.** `adoptStaleRunsAndStart` supersedes `proposed` only, so a `pending_retry` action sits on a terminal `partially_applied` run that can never be re-applied, reading "will be retried" for ever. §14 says a superseded plan's actions are superseded. **The choice: supersede them, rather than build a retry queue** — the next run re-plans from current facts, which is the whole convergence model, and an action carrying last night's decision is exactly what `pending_retry`'s own docstring says must not come back.

**P7 — deleting a target orphans its sealed initial passwords.** `deleteTarget` removes `target/{id}/bind` and leaves every `target/{id}/initial/{accountId}` behind: live credentials with no owner, no reader and a name derived from an id that will never be issued again — precisely what the function's own comment warns about for the bind secret.

**Files:**
- Modify: `packages/core/src/provision/reconcile.ts:418-427`
- Modify: `packages/core/src/provision/target-service.ts:973-1000` (verify the target), `:584-600` (delete the initial secrets)
- Modify: `packages/core/src/provision/run-service.ts:120-124` (supersede `pending_retry`)
- Modify: `packages/core/src/vault/vault-service.ts:98-103` (a prefix delete)
- Test: `packages/core/src/provision/reconcile.test.ts`, `packages/core/src/provision/target-service.test.ts`, `packages/core/src/provision/run-service.test.ts`, `packages/core/src/vault/vault-service.test.ts`

**Interfaces:**
- Consumes: `DesiredAccount.required` and `.enabledNow` from `./types.js`; `TargetNotFoundError` from `target-service.ts`.
- Produces:
  - `export async function deleteSecretsWithPrefix(tx: TenantClient, prefix: string): Promise<number>` in `packages/core/src/vault/vault-service.ts`.
  - No other signature changes.

- [ ] **Step 1: Write the four failing tests**

`packages/core/src/provision/reconcile.test.ts`:

```ts
  /**
   * A pre-hire, on every run between their account being created and their
   * first day.
   *
   * `finish` records a created-disabled pre-hire account as `active` on
   * purpose: `plan.ts` gates the confirmable re-enable on the RECORDED status,
   * so recording `disabled` with a `disabledAt` of the creation date would turn
   * the joiner's first enable -- the happy path -- into something an
   * administrator has to tick, `preHireDays` after the fact and therefore
   * outside the window. That is right, and the FINDING is what is wrong: ten
   * hires a fortnight out produced ten open drift findings for a fortnight,
   * which teaches people to ignore the drift tab.
   */
  it('raises no status drift for an account Provision itself asked to be disabled', () => {
    const output = reconcile({
      ...baseInput,
      desired: [
        preHireState({ personId: 'person-a', required: true, enabledNow: false }),
      ],
      known: [knownAccount({ personId: 'person-a', status: 'active', anchor: 'guid-a' })],
      objects: [targetObject({ anchor: 'guid-a', enabled: false })],
    });
    expect(output.findings.filter((f) => f.kind === 'unexpected_status')).toEqual([]);
  });

  /**
   * And the case this must not swallow: an account that should be enabled NOW
   * and is disabled at the target is somebody who has been locked out by hand,
   * which is exactly what the finding exists to report.
   */
  it('still raises status drift when the account should be enabled and is not', () => {
    const output = reconcile({
      ...baseInput,
      desired: [preHireState({ personId: 'person-a', required: true, enabledNow: true })],
      known: [knownAccount({ personId: 'person-a', status: 'active', anchor: 'guid-a' })],
      objects: [targetObject({ anchor: 'guid-a', enabled: false })],
    });
    expect(output.findings.filter((f) => f.kind === 'unexpected_status')).toHaveLength(1);
  });
```

`packages/core/src/provision/target-service.test.ts`:

```ts
  it('refuses to create a business rule against a target that is not there', async () => {
    const failure = await upsertBusinessRule(
      tenantId,
      null,
      '00000000-0000-4000-8000-000000000001',
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      },
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TargetNotFoundError);
  });

  it('removes every sealed initial password when the target goes', async () => {
    // A password Provision sealed for an account it created here.
    const accountId = '00000000-0000-4000-8000-0000000000aa';
    await withTenant(tenantId, (tx) =>
      putSecret(tx, provider, `target/${targetId}/initial/${accountId}`, 'Aa1!sealed-password'),
    );
    await deleteTarget(tenantId, null, targetId, true);
    const names = await withTenant(tenantId, (tx) => listSecretNames(tx));
    expect(names.filter((s) => s.name.startsWith(`target/${targetId}/`))).toEqual([]);
  });
```

`packages/core/src/provision/run-service.test.ts`:

```ts
  it('supersedes a pending_retry action left by a run that ended', async () => {
    const { runId, actionId } = await seedPendingRetryAction();
    await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    // "Will be retried" on an action belonging to a terminal
    // `partially_applied` run that can never be re-applied is a sentence the
    // console had no way of making true.
    expect(action.status).toBe('superseded');
    const run = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: runId } }),
    );
    expect(run.status).toBe('partially_applied');
  });
```

`packages/core/src/vault/vault-service.test.ts`:

```ts
  it('deletes every secret under a prefix and nothing beside it', async () => {
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'target/a/bind', 'one');
      await putSecret(tx, provider, 'target/a/initial/x', 'two');
      await putSecret(tx, provider, 'target/a/initial/y', 'three');
      await putSecret(tx, provider, 'target/ab/bind', 'not this one');
    });
    const removed = await withTenant(tenantId, (tx) =>
      deleteSecretsWithPrefix(tx, 'target/a/'),
    );
    expect(removed).toBe(3);
    const names = await withTenant(tenantId, (tx) => listSecretNames(tx));
    expect(names.map((s) => s.name)).toEqual(['target/ab/bind']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run packages/core/src/provision/reconcile.test.ts -t 'disabled'
npx vitest run packages/core/src/provision/target-service.test.ts -t 'not there'
npx vitest run packages/core/src/provision/run-service.test.ts -t 'pending_retry'
npx vitest run packages/core/src/vault/vault-service.test.ts -t 'prefix'
```

Expected: FAIL, all four — a finding is raised, a bare Prisma error rather than `TargetNotFoundError`, the action is still `pending_retry`, and `deleteSecretsWithPrefix is not a function`.

- [ ] **Step 3: P4 — stop reporting what Provision asked for**

In `packages/core/src/provision/reconcile.ts`, replace the status comparison (currently lines 418–427) with:

```ts
    if (object && account) {
      const expected = expectedEnabled(account.status);
      // A PRE-HIRE IS NOT DRIFT.
      //
      // `required: true` with `enabledNow: false` is the pre-hire and nothing
      // else -- a leaver's account is `required: false`, and `emptyAccount()`
      // carries both as false -- so this is exactly the state where the target
      // being disabled is what Provision itself asked for.
      //
      // The recorded status says `active` deliberately: `finish` writes it so
      // that `plan.ts`'s confirmable re-enable, which is gated on the RECORDED
      // status, does not turn the joiner's first enable into something an
      // administrator has to tick. That is right, and the finding was what was
      // wrong. Ten hires a fortnight out produced ten open drift findings for
      // a fortnight, and a drift tab that is always red is a drift tab nobody
      // reads -- which costs more than the finding ever bought.
      const disabledOnPurpose =
        state.account !== null &&
        state.account.required &&
        !state.account.enabledNow &&
        !object.enabled;
      if (expected !== null && expected !== object.enabled && !disabledOnPurpose) {
        record('unexpected_status', account.id, null, {
          syntraBelieves: account.status,
          targetReports: object.enabled ? 'active' : 'disabled',
          reason: 'the account status at the target does not match what Syntra recorded',
        });
      }
    }
```

- [ ] **Step 4: P5 — verify the target on the create path too**

In `packages/core/src/provision/target-service.ts`, in `upsertBusinessRule`'s `withTenant`, immediately after `const bound = await currentTenant(tx);`:

```ts
    // The TARGET, checked on both paths.
    //
    // The update path below checks that the rule belongs to this target, and
    // the create path relied on the foreign key alone. A typo therefore gave a
    // bare 500 out of Prisma with nothing saying which id was wrong, and a
    // valid id belonging to another tenant stored a row that satisfies the FK
    // and matches nothing this tenant can ever see -- an inert rule, in the
    // table an administrator reads to answer "why does this person hold this".
    const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
    if (!target) throw new TargetNotFoundError(targetId);
```

- [ ] **Step 5: P6 — supersede what the run left half-tried**

In `packages/core/src/provision/run-service.ts`, in `adoptStaleRunsAndStart`, change the supersession to:

```ts
    // `pending_retry` as well as `proposed`.
    //
    // A `pending_retry` action has exhausted its attempts or its throttle
    // budget and belongs to a run that has since gone terminal --
    // `partially_applied`, which nothing can re-apply. It therefore sat there
    // reading "will be retried" for ever, on a screen where that sentence
    // could never come true.
    //
    // Superseded rather than requeued, and that is spec section 14's own
    // answer: the next run re-plans from current facts, and `finish`'s
    // docstring says the point of `pending_retry` is that "a target that was
    // down for a night does not come back to a queue of decisions made against
    // last night's facts". Carrying the action forward would be exactly that
    // queue.
    await tx.provisionAction.updateMany({
      where: {
        status: { in: ['proposed', 'pending_retry'] },
        run: { targetSystemId },
      },
      data: { status: 'superseded' },
    });
```

- [ ] **Step 6: P7 — take the sealed passwords with the target**

In `packages/core/src/vault/vault-service.ts`, beside `deleteSecret`:

```ts
/**
 * Every secret whose name begins with `prefix`.
 *
 * `startsWith` and not a `LIKE` with a wildcard the caller supplies: the
 * prefixes this is used with are built from a uuid, and a pattern-matching
 * parameter reaching a deletion is not a shape worth having in the tree.
 *
 * Exists because `deleteTarget` removed `target/{id}/bind` and left every
 * `target/{id}/initial/{accountId}` behind -- live credentials for accounts at
 * a system Syntra no longer knows about, with no owner, no reader, and a name
 * derived from an id that will never be issued again, so nothing will ever
 * overwrite them either. That is precisely what the delete's own comment warns
 * about for the bind secret.
 */
export async function deleteSecretsWithPrefix(
  tx: TenantClient,
  prefix: string,
): Promise<number> {
  const { count } = await tx.secret.deleteMany({ where: { name: { startsWith: prefix } } });
  return count;
}
```

and in `deleteTarget`, replace `await deleteSecret(tx, target.secretName);` with:

```ts
    // The bind credential AND every initial password sealed for an account at
    // this target. One prefix covers both -- `target/{id}/bind` and
    // `target/{id}/initial/{accountId}` -- and the count goes into the audit
    // payload, because "how many credentials did that delete take with it" is
    // a question somebody asks afterwards and cannot otherwise answer.
    const secretsRemoved = await deleteSecretsWithPrefix(tx, `target/${targetId}/`);
```

adding `secretsRemoved` to the `recordEvent` payload:

```ts
      payload: { ...counts, secretsRemoved },
```

and importing `deleteSecretsWithPrefix` beside the existing `deleteSecret` import. If `deleteSecret` then has no other caller in this file, leave it exported — it is used elsewhere for the source bind credential.

- [ ] **Step 7: Run the four suites to verify they pass**

Run: `npx vitest run packages/core/src/provision/reconcile.test.ts packages/core/src/provision/target-service.test.ts packages/core/src/provision/run-service.test.ts packages/core/src/vault/vault-service.test.ts`

Expected: PASS.

- [ ] **Step 8: Run the neighbours the four touch**

Run: `npx vitest run packages/core/src/provision/apply.test.ts packages/core/src/provision/plan.test.ts packages/core/src/provision/target-service.schemas.test.ts packages/core/src/provision/loop.integration.test.ts`

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/provision/reconcile.ts \
        packages/core/src/provision/reconcile.test.ts \
        packages/core/src/provision/target-service.ts \
        packages/core/src/provision/target-service.test.ts \
        packages/core/src/provision/run-service.ts \
        packages/core/src/provision/run-service.test.ts \
        packages/core/src/vault/vault-service.ts \
        packages/core/src/vault/vault-service.test.ts
git commit -m "$(cat <<'MSG'
fix(provision): four small ones -- pre-hire drift, rule targets, stale retries, sealed passwords

A pre-hire raised an `unexpected_status` drift finding on every run until
their start date. `finish` records a created-disabled pre-hire account as
`active` on purpose -- `plan.ts` gates the confirmable re-enable on the
recorded status, so recording `disabled` would turn the joiner's first
enable into something an administrator has to tick, outside the window --
and the FINDING was what was wrong. Ten hires a fortnight out meant ten
open findings for a fortnight, and a drift tab that is always red is one
nobody reads. Suppressed where the desired state is in hand, and only for
`required && !enabledNow`, which is the pre-hire and nothing else.

Creating a business rule never verified the target; only the update path
did. A typo gave a bare 500 with nothing naming the bad id, and a valid
other-tenant id stored an inert cross-tenant row in the table an
administrator reads to answer "why does this person hold this".

`pending_retry` actions were never superseded, so they sat on a terminal
`partially_applied` run that nothing can re-apply, reading "will be
retried" for ever. Superseded rather than requeued, which is section 14's
answer and `finish`'s own: a target that was down for a night must not come
back to a queue of decisions made against last night's facts.

And deleting a target removed `target/{id}/bind` and left every
`target/{id}/initial/{accountId}` behind -- live credentials with no owner,
no reader and a name derived from an id that will never be issued again, so
nothing would ever overwrite them. Exactly what the delete's own comment
warns about for the bind secret.
MSG
)"
```

---

### Task 12: Strip the three columns and the status nothing can reach

Spec §7.2, **P8**, first half. `TargetAccount.disableDueAt`, `TargetAccount.archiveDueAt` and `ProvisionAction.nextAttemptAt` appear in the schema and **nowhere else in the repository** — no reader, no writer, not in a test, not in a contract. `ProvisionAction` status `'skipped'` is in the column's doc comment and in `reflect.ts`'s `TERMINAL_ACTION_STATUSES`, and nothing writes it: the apply loop's `skipped` is a *count* of rows left `proposed`.

**The choice: strip, not build.** The ladder computes its due dates from `disabledAt` plus the target's `disableGraceDays` and `archiveAfterDays` on every run, which is what makes a changed setting take effect immediately and a retroactive correction a non-event; materialising them would give the same question two answers that can disagree. `nextAttemptAt` belongs to a scheduled-retry model the design replaced with `pending_retry` plus re-planning. And a column with no reader is a promise the schema makes and the code does not keep — the next person to touch this reads three of them and has to prove a negative.

**Files:**
- Create: `packages/db/prisma/migrations/20260902000000_provision_drop_unread_columns/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`TargetAccount`, `ProvisionAction`)
- Modify: `packages/core/src/automate/reflect.ts:60-65` (`TERMINAL_ACTION_STATUSES`)
- Test: `packages/db/src/provision-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TERMINAL_ACTION_STATUSES` becomes `['applied', 'failed', 'conflict']`. No other exported symbol changes.

- [ ] **Step 1: Prove they have no reader**

```bash
grep -rn "nextAttemptAt\|disableDueAt\|archiveDueAt" packages apps e2e ops --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.prisma'
```

Expected: three hits, all in `packages/db/prisma/schema.prisma`, plus whatever the historical migration that added them contains. If anything else appears, **stop** — this task's premise is wrong and the finding needs re-reading.

```bash
grep -rn "'skipped'" packages/core/src/provision packages/contracts/src/provision.ts apps/api/src/routes/admin/targets.ts
```

Expected: no hit that assigns it to a `ProvisionAction.status`.

- [ ] **Step 2: Write the failing test**

Append to `packages/db/src/provision-schema.test.ts`:

```ts
/**
 * Columns with no reader are a promise the schema makes and the code does not
 * keep.
 *
 * `disableDueAt`, `archiveDueAt` and `nextAttemptAt` were written into the
 * schema and never read or written by anything -- not by a service, not by a
 * job, not by a test, not by a contract. The ladder computes its due dates
 * from `disabledAt` plus the target's `disableGraceDays` and `archiveAfterDays`
 * on every run, which is what makes a changed setting take effect immediately
 * and a retroactive correction a non-event; a stored copy would give one
 * question two answers that can disagree. `nextAttemptAt` belongs to a
 * scheduled-retry model the design replaced with `pending_retry` plus
 * re-planning.
 *
 * Asserted against the live database rather than the schema file, because the
 * schema file is the thing this test would otherwise be checking against
 * itself.
 */
describe('columns that were never read', () => {
  it('is gone from TargetAccount', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'TargetAccount'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('disableDueAt');
    expect(names).not.toContain('archiveDueAt');
    // The one the ladder actually reads is still there.
    expect(names).toContain('disabledAt');
  });

  it('is gone from ProvisionAction', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ProvisionAction'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('nextAttemptAt');
    expect(names).toContain('attempts');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/db/src/provision-schema.test.ts -t 'never read'`

Expected: FAIL — all three columns are present.

- [ ] **Step 4: Take them out of the schema**

In `packages/db/prisma/schema.prisma`, delete these three lines and nothing else:

```prisma
  disableDueAt          DateTime?
  archiveDueAt          DateTime?
```

from `TargetAccount`, and:

```prisma
  nextAttemptAt        DateTime?
```

from `ProvisionAction`.

In the same file, correct `ProvisionAction.status`'s doc comment, which advertises a value nothing writes:

```prisma
  /// 'proposed' | 'in_flight' | 'applied' | 'failed' | 'pending_retry'
  /// | 'conflict' | 'superseded'
  ///
  /// There is no 'skipped'. An action nobody got to is left `proposed` with a
  /// message saying why, which is what the run's own screen reads; the apply's
  /// `skipped` return is a COUNT of those rows, not a status any row carries.
```

- [ ] **Step 5: Write the migration**

```bash
npx prisma migrate dev --create-only --name provision_drop_unread_columns
mv packages/db/prisma/migrations/2026*_provision_drop_unread_columns \
   packages/db/prisma/migrations/20260902000000_provision_drop_unread_columns
```

Replace the generated SQL with:

```sql
-- Three columns that were never read and never written.
--
-- Not by a service, not by a job, not by a test, not by a contract: a
-- repository-wide search for each name found the schema file and nothing else.
--
-- `disableDueAt` and `archiveDueAt` look like the leaver ladder and are not
-- it. The ladder computes both dates on every run from `disabledAt` plus the
-- target's `disableGraceDays` and `archiveAfterDays`, and that is deliberate:
-- it is what makes a changed setting take effect immediately and a
-- retroactive correction a non-event, "because there is no memory to
-- corrupt". A stored copy gives one question two answers that can disagree,
-- and the stored one would be the one nobody updates.
--
-- `nextAttemptAt` belongs to a scheduled-retry model this design replaced.
-- What ships instead is `pending_retry` plus a re-plan on the next run, so
-- that a target which was down for a night does not come back to a queue of
-- decisions made against last night's facts. A column holding a time to retry
-- at is the shape of the thing that was rejected.
--
-- Every one of them is NULL in every row -- nothing has ever written one --
-- so there is nothing to migrate, only to remove.
ALTER TABLE "TargetAccount"
  DROP COLUMN "disableDueAt",
  DROP COLUMN "archiveDueAt";

ALTER TABLE "ProvisionAction"
  DROP COLUMN "nextAttemptAt";
```

Then `npx prisma migrate deploy` and `pnpm db:generate`.

- [ ] **Step 6: Drop the unreachable status from the terminal list**

In `packages/core/src/automate/reflect.ts`:

```ts
/**
 * The Provision action statuses that will not change again.
 *
 * `superseded` is deliberately absent. A superseded action means a newer run
 * replaced this one; the grant is still in desired state, so the newer run
 * re-proposes it. That is the case that looks like a failure and is not.
 *
 * `skipped` is absent because it does not exist. It was in the column's doc
 * comment and in this list and nothing anywhere wrote it — the apply's
 * `skipped` return is a COUNT of actions left `proposed`, not a status a row
 * carries. A branch keyed on a value that cannot occur is a branch nobody can
 * test and everybody has to reason about.
 */
export const TERMINAL_ACTION_STATUSES: readonly string[] = [
  'applied',
  'failed',
  'conflict',
];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/db/src/provision-schema.test.ts packages/core/src/automate/reflect.test.ts`

Expected: PASS.

- [ ] **Step 8: Check the migration replays from empty**

```bash
npx prisma migrate reset --force --skip-seed --schema packages/db/prisma/schema.prisma
```

Run this against a **scratch** database only — set `DATABASE_URL` to a `syntra_test_*` name first. Expected: every migration applies in name order with no drift, and the new one lands last.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260902000000_provision_drop_unread_columns \
        packages/db/src/provision-schema.test.ts \
        packages/core/src/automate/reflect.ts
git commit -m "$(cat <<'MSG'
refactor(provision): drop three columns and a status nothing could reach

`TargetAccount.disableDueAt`, `TargetAccount.archiveDueAt` and
`ProvisionAction.nextAttemptAt` appeared in the schema and nowhere else in
the repository -- no reader, no writer, no test, no contract. Every one of
them is null in every row.

The first two look like the leaver ladder and are not it. The ladder
computes both dates on every run from `disabledAt` and the target's grace
settings, deliberately: that is what makes a changed setting take effect
immediately and a retroactive correction a non-event, because there is no
memory to corrupt. A stored copy gives one question two answers, and the
stored one is the one nobody updates.

`nextAttemptAt` is the shape of the scheduled-retry model this design
rejected in favour of `pending_retry` plus a re-plan, so that a target down
for a night does not come back to a queue of decisions made against last
night's facts.

`ProvisionAction` status `skipped` went the same way. It was in the
column's doc comment and in reflection's terminal list and nothing wrote
it: the apply's `skipped` return is a count of rows left `proposed`. A
branch keyed on a value that cannot occur is one nobody can test and
everybody has to reason about.
MSG
)"
```

---

### Task 13: Writes against one target, at the concurrency the design specified

Spec §7.2, **P8**, second half. §14 says writes against a single target run at a bounded concurrency, default 4. `TargetSystem.concurrency` stores it, `runSettingsSchema` validates it between 1 and 32, `updateTarget` writes it — and the apply loop is strictly sequential, so nothing has ever read it. The knob is deliberately hidden from the API and the console (`packages/contracts/src/provision.ts:61-73`, `apps/api/src/routes/admin/targets.ts:35-45`) precisely because it does nothing.

**The choice: build it.** The register offers either direction; this one is stored, validated, documented in the design and already has a comment in `apply.ts` explaining exactly what a correct implementation must respect. A four-thousand-account first run against a remote domain controller is the case it exists for, and the alternative — deleting a validated, persisted setting — throws away the only per-target performance control the product has.

**The ordering rule the pool must keep:** actions for one person are ordered relative to each other (create, then attributes, then grants, then revocations, then disable, then archive — `ACTION_ORDER`, recovered from `sequence`), and actions for different people are not. So the unit of concurrency is the **person**, not the action: each worker takes a whole person's action list and walks it in sequence order. That is why this is a grouping change rather than a `Promise.all` over `actions`.

**Files:**
- Modify: `packages/core/src/provision/apply.ts:539-616` (the apply loop)
- Modify: `packages/contracts/src/provision.ts:61-73` (the docstring) and `:130-139` (`updateTargetRequestSchema`)
- Modify: `apps/api/src/routes/admin/targets.ts:35-56` (the docstring and `TARGET_FIELDS`)
- Test: `packages/core/src/provision/apply.test.ts`, `packages/core/src/provision/target-service.schemas.test.ts`

**Interfaces:**
- Consumes: `prepared.target.concurrency` (already loaded — `prepared` returns the whole `TargetSystem` row); `ProvisionAction.personId` and `.sequence`.
- Produces: no signature change to `applyProvisionRun`. `updateTargetRequestSchema` gains `concurrency`; the target response gains `concurrency`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/provision/apply.test.ts`:

```ts
/**
 * Bounded write concurrency, which section 14 specifies at a default of 4 and
 * which `TargetSystem.concurrency` has stored, validated and rendered while
 * the apply loop ran strictly sequentially. A setting with no reader.
 *
 * The unit of concurrency is the PERSON, not the action, and that is the whole
 * of the correctness argument. Within a person the order is forced -- create,
 * then attributes, then grants, then revocations, then disable, then archive,
 * recovered from `sequence` because PostgreSQL's now() is transaction start
 * time and every row of one `createMany` shares a `createdAt`. Across people
 * there is no order at all.
 */
describe('bounded write concurrency', () => {
  it('never has more than `concurrency` writes in flight at once', async () => {
    await seedPeople(8);
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { concurrency: 3 } }),
    );
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const confirmedByUserId = await seedConfirmingUser();

    let inFlight = 0;
    let peak = 0;
    const watched = {
      ...target,
      write: async (config: never, operation: WriteOperation): Promise<WriteResult> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          // A turn of the event loop, so overlapping calls actually overlap.
          await new Promise((resolve) => setImmediate(resolve));
          return await target.write(config, operation);
        } finally {
          inFlight -= 1;
        }
      },
    };

    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId,
      connector: watched as never,
      now: NOW,
      sleep: noSleep,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps one person’s actions in sequence order', async () => {
    await seedPeople(6);
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { concurrency: 4 } }),
    );
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const confirmedByUserId = await seedConfirmingUser();

    const order: string[] = [];
    const watched = {
      ...target,
      write: async (config: never, operation: WriteOperation): Promise<WriteResult> => {
        order.push(operation.actionId);
        await new Promise((resolve) => setImmediate(resolve));
        return target.write(config, operation);
      },
    };
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId,
      connector: watched as never,
      now: NOW,
      sleep: noSleep,
    });

    const actions = await actionsOf(run.id);
    const byPerson = new Map<string, number[]>();
    for (const action of actions) {
      if (action.personId === null) continue;
      const at = order.indexOf(action.id);
      if (at === -1) continue;
      const list = byPerson.get(action.personId) ?? [];
      list.push(at);
      byPerson.set(action.personId, list);
    }
    // Each person's actions were attempted in the order phase 7 wrote them.
    // Interleaving a grant before the create it depends on is the failure this
    // guarantees against, and it is exactly the one `sequence` exists for.
    for (const positions of byPerson.values()) {
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('applies every action, at concurrency 1 and at concurrency 8 alike', async () => {
    await seedPeople(8);
    for (const concurrency of [1, 8]) {
      await withTenant(tenantId, (tx) =>
        tx.targetSystem.update({ where: { id: targetId }, data: { concurrency } }),
      );
      const run = await previewProvisionRun(tenantId, provider, targetId, {
        now: NOW,
        connector: target as never,
      });
      const confirmedByUserId = await seedConfirmingUser();
      const result = await applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId,
        connector: target as never,
        now: NOW,
        sleep: noSleep,
      });
      expect(result.failed).toBe(0);
      expect(result.status).toBe('applied');
    }
  });
});
```

`seedPeople(n)` creates `n` persons in Finance with an active contract and no account, so each produces a create and a grant. Model it on the file's existing person fixtures.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/provision/apply.test.ts -t 'bounded write concurrency'`

Expected: FAIL on the first — `peak` is `1`, because the loop is sequential.

- [ ] **Step 3: Group by person and run a bounded pool**

In `packages/core/src/provision/apply.ts`, replace the comment at lines 539–546 and the `for (const action of actions) { … }` loop with:

```ts
  /**
   * Spec section 14: writes against a single target run at a bounded
   * concurrency, default 4, and `TargetSystem.concurrency` stores it. Until
   * this loop read it the setting had never done anything, which is why it is
   * absent from the API schemas and the console — a knob an administrator can
   * turn with no effect is worse than an absent one, because they will turn
   * it and then conclude something else is broken.
   *
   * THE UNIT OF CONCURRENCY IS THE PERSON, NOT THE ACTION, and that is the
   * whole correctness argument rather than a convenience. Within a person the
   * order is forced by dependency — create, then attribute updates, then
   * grants, then revocations, then disable, then archive — and it is carried
   * on `sequence` rather than `createdAt` because PostgreSQL's now() is
   * transaction start time, so every row phase 7's `createMany` wrote shares
   * one timestamp. A pool over ACTIONS would let a grant be attempted before
   * the create it depends on, which fails `not_found` nondeterministically:
   * green in CI, wrong at a customer.
   *
   * Across people there is no order at all, so each worker takes a whole
   * person's list and walks it. Actions carrying no person — an orphan
   * account's — are each their own group: they depend on nothing and nothing
   * depends on them.
   *
   * The counters below are incremented inside the workers. That is safe
   * without a lock because JavaScript is single-threaded between awaits: a
   * `+= 1` cannot be interleaved. It is the reason this is a pool over
   * promises and not worker threads.
   */
  const groups = new Map<string, typeof actions>();
  for (const action of actions) {
    // The id, not the index, for a null person: two orphan actions must not
    // land in one group and thereby acquire an order neither of them has.
    const key = action.personId ?? `action:${action.id}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [action]);
    else list.push(action);
  }
  const queue = [...groups.values()];
  // At least one, at most the number of groups — a pool wider than the work is
  // idle promises. `concurrency` is bounded 1..32 by `runSettingsSchema`, so
  // the `max` here is a floor against a row written before that bound existed
  // rather than a second opinion about the range.
  const width = Math.max(1, Math.min(prepared.target.concurrency, queue.length));
  let nextGroup = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextGroup;
      nextGroup += 1;
      if (index >= queue.length) return;

      for (const action of queue[index]!) {
        if (action.requiresConfirmation && !confirmed) {
          // A rename, a re-enable outside the window, or a re-create of a
          // vanished account. Never auto-applied, and never unlocked by a
          // caller that merely passed the parameter — but recorded rather than
          // dropped. Ruling P4 exists because a silent skip is how a target
          // looks healthy while doing nothing, and on an unattended `autoApply`
          // run nobody is watching this happen.
          deferredIds.push(action.id);
          continue;
        }

        // The heartbeat, at most once a minute, in a transaction of its own
        // that holds nothing. The transition stamp above is enough only while
        // an apply is shorter than STALE_RUN_MS; a run with four thousand
        // creates on a slow directory is not, and the staleness check has to
        // keep answering "when did this run last show a sign of life" rather
        // than "when did it begin". Shared across the workers deliberately:
        // one small UPDATE per minute of applying, not one per worker.
        if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
          heartbeatAt = Date.now();
          await withTenant(tenantId, (tx) =>
            tx.provisionRun.update({
              where: { id: runId },
              data: { lastProgressAt: new Date() },
            }),
          );
        }

        let outcome: ActionOutcome;
        try {
          outcome = await applyOneAction(tenantId, provider, action, {
            connector,
            config: prepared.config,
            maxAttempts: prepared.target.maxAttempts,
            targetSystemId: prepared.run.targetSystemId,
            remit: prepared.remit,
            grantedEntitlements: prepared.grantedEntitlements,
            profile: prepared.profile,
            actorUserId,
            sleep,
            ...(options.transport === undefined ? {} : { transport: options.transport }),
          });
        } catch (cause) {
          // A throw out of one action is one action's problem. Left uncaught
          // it abandons every later action for THIS PERSON — the disable, the
          // archive, the second of their two logins — and, before the pool,
          // every later action for everybody.
          outcome = await recordActionThrew(tenantId, action.id, actorUserId, cause);
        }

        if (outcome === 'applied') applied += 1;
        else if (outcome === 'pending_retry') pendingRetry += 1;
        else if (outcome === 'in_flight') inFlight += 1;
        else failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/provision/apply.test.ts`

Expected: PASS, every test in the file. If a test that asserts an exact audit-event ORDER across people now fails, its expectation was relying on the sequential loop rather than on anything the design guarantees — sort before comparing, and say so in a comment.

- [ ] **Step 5: Let an administrator set it**

In `packages/contracts/src/provision.ts`, replace the `.strict()` docstring (lines 61–73) with:

```ts
/**
 * `.strict()` on the request bodies, and it is not decoration.
 *
 * A `PATCH` that saves nothing must not answer 204. Without `.strict()` Zod
 * silently strips an unknown key, so a mistyped field name commits the rest of
 * the body and reports success — and the caller has no way to find out that
 * half of what they sent went nowhere.
 *
 * `concurrency` was deliberately absent from these schemas while the apply
 * loop was sequential: the column was stored, validated and defaulted with no
 * reader, and an API that accepts a knob which changes nothing tells its
 * caller a lie no amount of documentation unsays. The loop now honours it, so
 * it is accepted.
 */
```

and add to `updateTargetRequestSchema`:

```ts
    /**
     * Writes in flight against this target at once. Section 14's default is 4.
     * Bounded 1..32 to match `runSettingsSchema` in core: zero is a run that
     * makes no progress, and an unbounded one is a domain controller taking a
     * four-thousand-account plan all at once.
     */
    concurrency: z.number().int().min(1).max(32).optional(),
```

In `apps/api/src/routes/admin/targets.ts`, replace the `TARGET_FIELDS` docstring with:

```ts
/**
 * Everything safe to return. `secretName` and the bind credential are not
 * among it.
 *
 * `concurrency` IS among it now. It was left out while the apply loop was
 * sequential, because rendering a setting that does nothing is worse than
 * omitting it — an administrator changes it, sees no difference, and concludes
 * something else is broken. The loop honours it, so the screen may show it.
 */
```

and add `concurrency: true,` to the object.

- [ ] **Step 6: Assert the contract accepts it**

Append to `packages/core/src/provision/target-service.schemas.test.ts`:

```ts
  it('accepts a concurrency now that the apply loop reads one', () => {
    const parsed = updateTargetRequestSchema.parse({ concurrency: 8 });
    expect(parsed.concurrency).toBe(8);
  });

  it('still refuses a concurrency the pool cannot honour', () => {
    expect(() => updateTargetRequestSchema.parse({ concurrency: 0 })).toThrow();
    expect(() => updateTargetRequestSchema.parse({ concurrency: 64 })).toThrow();
  });
```

- [ ] **Step 7: Run the schema and route tests**

Run: `npx vitest run packages/core/src/provision/target-service.schemas.test.ts packages/core/src/provision/target-service.test.ts`

Expected: PASS. If a route test asserts the exact key set of the target response, add `concurrency` to its expectation.

- [ ] **Step 8: Run the whole provisioning slice**

Run: `npx vitest run packages/core/src/provision`

Expected: PASS. This is the one place in the plan where a directory-wide run is worth its ~8 minutes: the pool changes the order in which every action in every test is attempted.

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git status --short
git add packages/core/src/provision/apply.ts \
        packages/core/src/provision/apply.test.ts \
        packages/core/src/provision/target-service.schemas.test.ts \
        packages/contracts/src/provision.ts \
        apps/api/src/routes/admin/targets.ts
git commit -m "$(cat <<'MSG'
feat(provision): writes against one target at the concurrency the design specified

Section 14 bounds writes against a single target at a concurrency defaulting
to 4. `TargetSystem.concurrency` stored it, `runSettingsSchema` validated it
between 1 and 32, `updateTarget` wrote it -- and the apply loop was strictly
sequential, so nothing had ever read it. It was deliberately hidden from the
API schemas and the console for exactly that reason: a knob an administrator
can turn with no effect is worse than an absent one.

Built rather than deleted, because it is stored, validated, documented in
the design, and `apply.ts` already carried a comment saying what a correct
implementation would have to respect.

The unit of concurrency is the PERSON, not the action. Within a person the
order is forced by dependency -- create, attributes, grants, revocations,
disable, archive -- and carried on `sequence`, because PostgreSQL's now() is
transaction start time and every row of phase 7's createMany shares a
timestamp. A pool over actions would let a grant be attempted before the
create it depends on: `not_found`, nondeterministically, green in CI and
wrong at a customer. Across people there is no order, so each worker takes a
whole person's list and walks it.

The counters are incremented inside the workers without a lock, which is
safe because JavaScript is single-threaded between awaits -- and is why this
is a pool over promises rather than threads.
MSG
)"
```

---

## Done when

- [ ] An administrator unblocking a multi-stage request leaves it `pending_approval` with no stale reason, and stage 2's approver can decide it.
- [ ] A second decision on a settled request is refused `raced` and answered 409; the row keeps whatever the first writer put there.
- [ ] Two concurrent applies of one run: one claims it, the other gets `ProvisionRunNotAppliableError`, one account exists at the target, and the sealed password is the one the directory will accept.
- [ ] A stage that blocks at N≥2 mails the product owner and the `automate.manage` holders and writes an `automate.request.blocked` audit event naming the stage.
- [ ] A revocation order planned by a run that never applied it is `open` again at the head of the next run and enters that plan; one that lands is `applied` with a date.
- [ ] Two delegations of one resource to one person produce one merged entry with the union of their capabilities; a retired product no longer decides the bounding audience when an active one exists.
- [ ] A swept entitlement revocation reaches `applied` when the holding is gone and `failed`, with the target's own message and a mail to the administrators, when Provision has refused it; the sweep counts `dispatched` separately from `applied`.
- [ ] Deactivating every login at one small target of a large tenant trips the guard.
- [ ] A requester can choose a start date, a joiner inside the pre-hire horizon can submit, both produce a `scheduled` grant that confers nothing until its day, and a date beyond the horizon is refused with the number of days.
- [ ] Re-resolving an open stage keeps its escalation approvers and its clock, and mails only the people it added; a `fulfilment_failed` request has a null `fulfilledAt`; two outbox senders running at once send each message once.
- [ ] A pre-hire raises no drift finding; creating a rule against an absent target is a `TargetNotFoundError`; `pending_retry` actions are superseded at the next run; deleting a target takes every `target/{id}/…` secret with it.
- [ ] `disableDueAt`, `archiveDueAt` and `nextAttemptAt` are gone from the database, and `TERMINAL_ACTION_STATUSES` no longer names a status nothing writes.
- [ ] `peak` writes in flight is greater than one and at most `TargetSystem.concurrency`, each person's actions are attempted in `sequence` order, and the setting is accepted by the API and shown in the console.
- [ ] `npx tsc -b` exits 0, both new migrations sort above `20260830000000`, and `packages/core/src/auth/password-reset.test.ts` is still uncommitted and untouched.

## Deliberately not in this plan

Everything else in the findings register:

- **Remediation 1 — Urgent.** R1–R3, C1, D1, X1–X3: the snapshot key collision that halts governance permanently, `db:reset` against the lab database, and the 71 web tests CI cannot see. **Land it first** — Task 12 here adds a migration, and the migration-order check is that plan's Task 5.
- **Remediation 2 — Governance.** G1–G27: the decide race, retention deleting campaign evidence, the `revoked` figure, the two transaction-ceiling failures that never recover, the empty evidence bundle, CSV injection, the scheduling switch, and "Verify now". G15 in particular — nothing computing a revocation batch at campaign close — is upstream of Task 5 here: this plan stops an order being dropped, and that one is why some orders are never created.
- **Remediation 4 — Auth, API and console.** H1–H6, N1–N6, W1–W9, S1–S7, B1–B5: `ForceAuthn`, the passkey reset lockout, role management, and the console's missing surfaces. N2 belongs there and not here even though it decides access requests — `{"decision":"Reject"}` capitalised approving one is an unparsed body, which is an API-surface defect with an API-surface fix, and it lands beside the other five uncast routes.
- **Remediation 5 — The update feature.** U1–U10, plus the lab rehearsal its own design lists as outstanding.
