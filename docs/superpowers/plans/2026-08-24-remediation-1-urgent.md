# Remediation 1 — Urgent: Critical, Data Loss, CI Blindness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the one defect that halts governance permanently, close the one command that can destroy the lab database by accident, and make CI able to see the tests and the build it is currently blind to.

**Architecture:** Five independent tasks with no shared state. Task 1 lands the already-verified test fixes so later tasks start from a clean baseline. Task 2 de-duplicates collected holdings before the batch write. Task 3 inverts the reset guard from "refuse in production" to "refuse unless deliberately told otherwise", extracted into a pure function so it can be tested. Tasks 4 and 5 widen CI's reach and add a migration-ordering check.

**Tech Stack:** TypeScript (ESM, strict, `exactOptionalPropertyTypes`), Prisma + PostgreSQL, vitest (forks pool, one database per worker), pnpm workspaces, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-24-audit-findings.md` — §2 (R1–R3), §3 (C1), §4 (D1), §8 (X1–X3).

## Global Constraints

- Node `>=22`; pnpm pinned to `9.12.0` via `packageManager`. Never run `npm` or a different pnpm.
- `tsc -b --force` and `pnpm --filter @syntra/web build` must stay green at every commit.
- Test files live beside their subject as `*.test.ts` (or `*.test.tsx` under `apps/web`).
- The root vitest suite takes ~155 minutes at `SYNTRA_TEST_WORKERS=4`. **Never run the whole suite to check one change** — run the specific file, e.g. `npx vitest run packages/core/src/govern/snapshot-service.test.ts`.
- Integration tests call `resetDatabase()` in `beforeEach` and go through `withTenant`; never call `prisma` directly for tenant-scoped data in a test.
- **The working tree is not clean and is not yours alone.** Another session is mid-TDD on `packages/core/src/auth/password-reset.test.ts` (tests for an `issuePasswordSetup` that does not exist yet). Never `git add -A`, never `git commit -a`. Stage only the exact paths each task names.
- Commit messages: lower-case type prefix, imperative, no trailing period — e.g. `fix(govern): collapse holdings that collide on the snapshot key`.

---

### Task 1: Land the three verified test fixes — ALREADY DONE, VERIFY AND SKIP

> **This task was completed by another session while the plan was being written.** The three fixes were committed as `474567e` ("test: fix three suites that were passing for the wrong reasons"), unchanged. Run Step 2 to confirm they are present and green, then move to Task 2. The remaining steps are kept for the record.

The fixes are already written and verified in the working tree. This task only commits them, on their own, so the tasks that follow start from a known baseline. See spec §2 and §12.

**Files:**
- Commit (already modified): `packages/core/src/health/readiness.test.ts`
- Commit (already modified): `packages/core/src/update/update-service.test.ts`
- Commit (already modified): `apps/web/src/pages/admin/StatusToggle.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a clean baseline for `packages/core` and `apps/web` test runs. No exported symbols.

- [ ] **Step 1: Confirm exactly what is staged before committing**

```bash
git status --short
```

Expected: four modified files. Three are yours. `packages/core/src/auth/password-reset.test.ts` is **the other session's work — do not stage it.**

- [ ] **Step 2: Verify the three files pass**

```bash
npx vitest run packages/core/src/health/readiness.test.ts packages/core/src/update/update-service.test.ts
cd apps/web && npx vitest run src/pages/admin/StatusToggle.test.tsx; cd ../..
```

Expected: `10 passed` and `18 passed` for the two core files; `11 passed` for the web file.

- [ ] **Step 3: Stage the three paths explicitly and commit**

```bash
git add packages/core/src/health/readiness.test.ts \
        packages/core/src/update/update-service.test.ts \
        apps/web/src/pages/admin/StatusToggle.test.tsx
git status --short
```

Expected: exactly three files under `M ` in the staged column, and `password-reset.test.ts` still unstaged.

```bash
git commit -m "$(cat <<'EOF'
test: three that were committed red, and why nobody saw them

The suite had never completed a run -- two attempts were killed at three
hours and cancelled -- so these sat on main unseen.

readiness: `prisma` is a Proxy that materialises methods on access, so
restoring a `vi.spyOn` on `$queryRawUnsafe` left it undefined and the two
tests after it failed in the database and migrations probes. Swapped by
hand with a finally restore instead.

update-service: the no-token case could never run in a checkout, where
`buildInfo()` reports `dev` and the working-tree refusal returns first.
It now arranges a release install before asserting.

StatusToggle: a stale assertion left by the write-back copy change. CI
never runs this file at all, which is its own problem and is fixed in a
later task.
EOF
)"
```

---

### Task 2: Collapse holdings that collide on the snapshot key

Spec §3, C1 — the critical. `collect` emits one holding per `(userId, resource)` while the subject key is the **person**, so a person with two `User` rows in one group produces two rows that collide on `Holding`'s unique key. `createMany` has no upsert, so the snapshot fails and every nightly build after it fails identically.

**Files:**
- Modify: `packages/core/src/govern/snapshot-service.ts:219-245` (the `prepared` construction)
- Test: `packages/core/src/govern/snapshot-service.test.ts`

**Interfaces:**
- Consumes: `CollectedHolding` and `CollectedTenant` from `./collect.js`; `subjectKey` from `./attribute.js`; the existing local `PreparedHolding` interface and `isUnattributable`, `attributionsFor` helpers.
- Produces: no signature change. `buildSnapshot(tenantId, opts)` keeps its shape; `prepared` is now de-duplicated on `` `${subjectKey}|${systemId}|${resourceKind}|${resourceId}` ``, and every downstream consumer (`detectHoldings`, the diff `after` set, `holdingCount`, `unattributableCount`) sees one row per key.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/govern/snapshot-service.test.ts`, at the end of the file:

```ts
/**
 * One person, several `User` rows -- explicitly supported by the sync
 * design, and the shape that used to end every nightly build.
 *
 * `collect` emits a holding per (userId, resource) while the subject key is
 * the PERSON, so two accounts in one group collide on `Holding`'s unique
 * key. `createMany` has no upsert: the snapshot failed with P2002, and so
 * did every build after it, because the shape does not go away on its own.
 */
describe('a person holding the same resource through two accounts', () => {
  const twoAccounts = (personId: string): CollectedTenant =>
    emptyCollection({
      personIds: [personId],
      personsWithActiveContract: 1,
      holdings: [
        {
          subject: { kind: 'person', personId },
          systemKind: 'syntra',
          systemId: 'syntra',
          systemName: 'Syntra',
          resourceKind: 'group',
          resourceId: 'g1',
          resourceName: 'Ward Nurses',
          state: 'held',
          observedAt: NOW,
          observedVia: 'user-a',
          attribution: { kind: 'direct', detail: 'account A' },
        },
        {
          subject: { kind: 'person', personId },
          systemKind: 'syntra',
          systemId: 'syntra',
          systemName: 'Syntra',
          resourceKind: 'group',
          resourceId: 'g1',
          resourceName: 'Ward Nurses',
          state: 'held',
          observedAt: NOW,
          observedVia: 'user-b',
          attribution: { kind: 'direct', detail: 'account B' },
        },
      ],
    });

  it('builds instead of failing the snapshot', async () => {
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, displayName: 'Maya Okafor' } }),
    );

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => twoAccounts(person.id),
    });

    const snapshot = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findUniqueOrThrow({ where: { id: built.snapshotId } }),
    );
    expect(snapshot.status).toBe('complete');
    expect(snapshot.error).toBeNull();
  });

  it('writes ONE holding, not two', async () => {
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, displayName: 'Maya Okafor' } }),
    );

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => twoAccounts(person.id),
    });

    const holdings = await withTenant(tenantId, (tx) =>
      tx.holding.findMany({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holdings).toHaveLength(1);
  });

  /**
   * Union rather than discard. Each account is a separate true reason the
   * person holds this, and section 7 wants all of them -- dropping one
   * would make the holding look less attributable than it is.
   */
  it('keeps BOTH accounts as attributions of the one holding', async () => {
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, displayName: 'Maya Okafor' } }),
    );

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => twoAccounts(person.id),
    });

    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({
        where: { snapshotId: built.snapshotId },
        include: { attributions: true },
      }),
    );
    expect(holding.attributions).toHaveLength(2);
    expect(holding.attributionCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts -t 'two accounts'`

Expected: FAIL. The snapshot status is `failed` and the error names a unique-constraint violation on `Holding` — Prisma code P2002 on `snapshotId, subjectKey, systemId, resourceKind, resourceId`.

- [ ] **Step 3: Replace the `prepared` map with a de-duplicating loop**

In `packages/core/src/govern/snapshot-service.ts`, replace the whole `const prepared: PreparedHolding[] = collected.holdings.map((h) => { … });` block (currently lines 219–245) with:

```ts
    // ---- attribute + classify (pure) ---------------------------------------
    //
    // ONE ROW PER (subject, resource), and that is load-bearing rather than
    // tidy. `collect` emits a holding per (userId, resource) while the
    // subject key here is the PERSON, and a person may hold several `User`
    // rows -- so two accounts in one group, or under one org unit carrying
    // an application assignment, or holding one role, produce two entries
    // that collide on `Holding`'s unique key.
    //
    // `createMany` has no upsert. Before this, that collision failed the
    // snapshot with P2002 and failed EVERY nightly build afterwards, because
    // the shape does not resolve itself: snapshots stopped, sources went
    // stale, and past `maxSnapshotAgeDays` every campaign start and every
    // revocation batch was refused.
    //
    // Deliberately NOT `skipDuplicates` on the write instead. That would
    // silently drop the second row's attribution -- the holding would look
    // less attributable than it is -- and would hide a genuinely new
    // duplicate shape rather than surfacing it.
    const preparedByKey = new Map<string, PreparedHolding>();
    const prepared: PreparedHolding[] = [];

    for (const h of collected.holdings) {
      const key = subjectKey(h.subject);
      const compositeKey = `${key}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;
      const attributions = attributionsFor(h.attribution, collected.asOf);
      // Every syntraRole holding is privileged with NO configuration: a
      // Syntra role carries permissions from the closed catalogue and there
      // is no version of that which is not.
      const privileged =
        h.resourceKind === 'syntraRole' ||
        privilegedByKey.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`);

      const existing = preparedByKey.get(compositeKey);
      if (existing !== undefined) {
        existing.attributions.push(...attributions);
        existing.unattributable = isUnattributable(
          existing.attributions.map((a) => a.kind),
        );
        // `held` beats `unknown`: one readable account is enough to know the
        // person holds it, and the other account's blindness does not
        // unmake that.
        if (h.state === 'held') existing.state = 'held';
        // Privilege is a property of the RESOURCE, so the two agree in
        // practice; taking the disjunction means a future per-account
        // difference cannot quietly downgrade it.
        existing.privileged = existing.privileged || privileged;
        if (h.observedAt.getTime() > existing.observedAt.getTime()) {
          existing.observedAt = h.observedAt;
        }
        continue;
      }

      const row: PreparedHolding = {
        subjectKey: key,
        personId: h.subject.kind === 'person' ? h.subject.personId : null,
        accountRef: h.subject.kind === 'account' ? h.subject.accountRef : null,
        systemKind: h.systemKind,
        systemId: h.systemId,
        resourceKind: h.resourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state,
        privileged,
        observedAt: h.observedAt,
        observedVia: h.observedVia,
        firstSeenAt: firstSeenByKey.get(compositeKey) ?? collected.asOf,
        unattributable: isUnattributable(attributions.map((a) => a.kind)),
        attributions,
      };
      preparedByKey.set(compositeKey, row);
      prepared.push(row);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/govern/snapshot-service.test.ts`

Expected: PASS, all tests in the file, including the three new ones and every pre-existing one.

- [ ] **Step 5: Run the neighbouring suites that read `prepared`**

Run: `npx vitest run packages/core/src/govern/collect.test.ts packages/core/src/govern/diff.test.ts packages/core/src/govern/report-service.test.ts`

Expected: PASS. These consume holdings and the diff `after` set; a de-duplication bug would show here as a changed count.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/govern/snapshot-service.ts packages/core/src/govern/snapshot-service.test.ts
git commit -m "$(cat <<'EOF'
fix(govern): one holding per subject and resource, not one per account

A person may hold several `User` rows -- the sync design says so -- and
`collect` emits a holding per (userId, resource) while the subject key is
the person. Two accounts in one group therefore collided on `Holding`'s
unique key, `createMany` raised P2002, and the snapshot failed. So did
every nightly build after it: the shape does not go away on its own, so
snapshots stopped, sources went stale, and past maxSnapshotAgeDays every
campaign start and every revocation batch was refused.

Collapsed on the composite key before the write, unioning the
attributions rather than discarding one -- each account is a separate
true reason the person holds it. Not `skipDuplicates`, which would drop
that reason silently and hide the next duplicate shape too.
EOF
)"
```

---

### Task 3: Refuse to empty a database nobody said to empty

Spec §4, D1. The guard tests `NODE_ENV === 'production'`, which the lab deployment never sets — verified against the systemd unit and both `.env.example` files. The dev and lab databases are **both named `syntra`**, so no name rule can separate them: the guard has to refuse by default and require the operator to name the database they mean.

**Files:**
- Create: `packages/db/src/reset-guard.ts`
- Create: `packages/db/src/reset-guard.test.ts`
- Modify: `packages/db/src/reset.ts` (whole file)
- Modify: `.github/workflows/ci.yml` (the e2e job's seed step)
- Modify: `e2e/README.md` (the documented invocation)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ResetDecision = { allow: true; database: string } | { allow: false; reason: string }`
  - `function resetDecision(input: { databaseUrl: string | undefined; allowVar: string | undefined }): ResetDecision`
  - `const SCRATCH_DATABASE = /^syntra_test_/` — exported for the test only.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/reset-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resetDecision } from './reset-guard.js';

const url = (name: string) => `postgresql://syntra:syntra@localhost:5432/${name}`;

describe('resetDecision', () => {
  /**
   * The worker databases the suite provisions for itself. Emptying one is
   * the whole point of them, and requiring a ceremony here would put the
   * ceremony in CI rather than in front of the operator who needs it.
   */
  it('allows a scratch test database with no ceremony', () => {
    expect(resetDecision({ databaseUrl: url('syntra_test_ba9ecd06eae8_w1'), allowVar: undefined }))
      .toEqual({ allow: true, database: 'syntra_test_ba9ecd06eae8_w1' });
  });

  /**
   * THE ONE THAT MATTERS. The development database and the lab database are
   * both named `syntra`, so nothing about the name can tell them apart --
   * which is exactly why the answer is no until somebody says otherwise.
   */
  it('refuses a database named `syntra` by default', () => {
    const decision = resetDecision({ databaseUrl: url('syntra'), allowVar: undefined });
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toContain('syntra');
    expect(decision.reason).toContain('SYNTRA_ALLOW_RESET');
  });

  it('allows it when the operator names that exact database', () => {
    expect(resetDecision({ databaseUrl: url('syntra'), allowVar: 'syntra' }))
      .toEqual({ allow: true, database: 'syntra' });
  });

  /**
   * Naming a DIFFERENT database is the copy-pasted-incantation case: the
   * operator carried an override from another checkout. It must not pass.
   */
  it('refuses when the named database is not the one it is pointed at', () => {
    const decision = resetDecision({ databaseUrl: url('syntra'), allowVar: 'syntra_dev' });
    expect(decision.allow).toBe(false);
  });

  it('refuses a truthy-but-meaningless override', () => {
    for (const allowVar of ['1', 'true', 'yes']) {
      expect(resetDecision({ databaseUrl: url('syntra'), allowVar }).allow).toBe(false);
    }
  });

  it('refuses when DATABASE_URL is absent or unparseable', () => {
    expect(resetDecision({ databaseUrl: undefined, allowVar: 'syntra' }).allow).toBe(false);
    expect(resetDecision({ databaseUrl: 'not-a-url', allowVar: 'syntra' }).allow).toBe(false);
  });

  it('refuses a URL with no database path', () => {
    expect(resetDecision({ databaseUrl: 'postgresql://u:p@localhost:5432/', allowVar: 'x' }).allow)
      .toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/db/src/reset-guard.test.ts`
Expected: FAIL — `Cannot find module './reset-guard.js'`.

- [ ] **Step 3: Write the guard**

Create `packages/db/src/reset-guard.ts`:

```ts
/**
 * Whether this invocation may empty the database it is pointed at.
 *
 * Separated from `reset.ts` so it can be tested without a process that
 * exits, and inverted from what it replaced.
 *
 * The old guard refused when `NODE_ENV === 'production'` -- a variable
 * NOTHING in the lab deployment sets. Not the systemd unit, not
 * `.env.example`, not `packages/db/.env.example`. It therefore passed on
 * the one machine holding real data, where `e2e/README.md` tells operators
 * to run `pnpm db:reset && pnpm seed` as a habit and the checkout sits at
 * the same path it does on a developer's machine.
 *
 * It cannot be fixed by naming safe databases either: the development
 * database and the lab database are BOTH called `syntra`. Nothing about
 * the connection string separates them.
 *
 * So the answer is no, unless the operator names the database they mean.
 * A new environment is then safe by default rather than dangerous by
 * default, which is the direction a `TRUNCATE ... CASCADE` should fail in.
 */

/**
 * The per-worker databases the suite provisions for itself
 * (`syntra_test_<hash>_w<n>`, see `test-database.ts`). Emptying one is
 * their entire purpose, and demanding a ceremony for them would put the
 * ceremony in CI instead of in front of the person who needs it.
 */
export const SCRATCH_DATABASE = /^syntra_test_/;

export type ResetDecision =
  | { allow: true; database: string }
  | { allow: false; reason: string };

function databaseName(databaseUrl: string | undefined): string | null {
  if (databaseUrl === undefined || databaseUrl === '') return null;
  try {
    const name = new URL(databaseUrl).pathname.slice(1);
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

export function resetDecision(input: {
  databaseUrl: string | undefined;
  allowVar: string | undefined;
}): ResetDecision {
  const database = databaseName(input.databaseUrl);

  if (database === null) {
    return {
      allow: false,
      reason:
        'DATABASE_URL is unset or names no database, so there is nothing this could safely empty.',
    };
  }

  if (SCRATCH_DATABASE.test(database)) {
    return { allow: true, database };
  }

  // THE EXACT NAME, not a truthy flag. `SYNTRA_ALLOW_RESET=1` is the shape
  // that gets copied between checkouts and pasted into a shell on the wrong
  // machine; typing the database out is the part that makes somebody look
  // at which one they are pointed at.
  if (input.allowVar === database) {
    return { allow: true, database };
  }

  return {
    allow: false,
    reason:
      `Refusing to empty "${database}": it is not a scratch test database, and nothing ` +
      `said to empty this one.\n` +
      `The development database and the lab database are both named "syntra", so the name ` +
      `alone cannot tell them apart -- check which host this DATABASE_URL points at.\n` +
      `If you are certain, re-run with SYNTRA_ALLOW_RESET=${database}`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/db/src/reset-guard.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Rewrite `reset.ts` to use it, and say what is about to be lost**

Replace the whole of `packages/db/src/reset.ts` with:

```ts
/**
 * Empties every application table.
 *
 * The integration tests truncate between cases and leave whatever the last
 * one created behind -- often a tenant named `acme` holding an `admin`
 * user. That is enough to fool the seed's idempotence guard into reporting
 * the tenant as already seeded and doing nothing, which leaves the browser
 * tests looking at a directory with no people in it.
 *
 * `reset-guard.ts` decides whether this is allowed to run at all, and says
 * why it is shaped the way it is.
 */
import { prisma } from './client.js';
import { resetDecision } from './reset-guard.js';
import { resetDatabase } from './test-support.js';

const decision = resetDecision({
  databaseUrl: process.env.DATABASE_URL,
  allowVar: process.env.SYNTRA_ALLOW_RESET,
});

if (!decision.allow) {
  console.error(decision.reason);
  process.exit(1);
}

// What is about to go, counted before it goes. An operator who has pointed
// this at the wrong host is not helped by the database's NAME -- both are
// `syntra` -- but is stopped in their tracks by a four-figure audit count
// where they expected a seed.
const [tenants, users, auditEvents] = await Promise.all([
  prisma.tenant.count(),
  prisma.user.count(),
  prisma.auditEvent.count(),
]);

console.log(
  `Emptying "${decision.database}": ${tenants} tenant(s), ${users} user(s), ` +
    `${auditEvents} audit event(s).`,
);

await resetDatabase();
console.log('Database emptied. Run `pnpm seed` next.');
await prisma.$disconnect();
```

- [ ] **Step 6: Prove the guard refuses, then allows**

```bash
node --env-file-if-exists=../../.env --env-file-if-exists=.env --import tsx packages/db/src/reset.ts
```

Run this from `packages/db`. Expected: exit code 1, and the refusal naming `syntra` and `SYNTRA_ALLOW_RESET=syntra`. **The database is untouched.**

Do **not** run the allowing form against your development database unless you intend to re-seed it. If you do:

```bash
SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed
```

- [ ] **Step 7: Give CI the override it now needs**

CI's database is named `syntra` (from `.env.example`), so the e2e job's `db:reset` would now refuse. In `.github/workflows/ci.yml`, in the `e2e` job's `Seed` step, replace `pnpm db:reset` with the explicit form:

```yaml
      - name: Seed
        # A fresh seed, every time. The integration suite truncates between
        # cases and leaves the last one's fixtures behind, which is enough to
        # fool the seed's idempotence guard into doing nothing -- and the
        # browser tests then look at a directory with no people in it.
        #
        # `SYNTRA_ALLOW_RESET` names the database deliberately: `db:reset`
        # refuses anything that is not a scratch test database unless told
        # which one it is emptying, because the development and lab databases
        # are both named `syntra` and the old NODE_ENV guard protected
        # neither. See packages/db/src/reset-guard.ts.
        run: |
          SYNTRA_ALLOW_RESET=syntra pnpm db:reset
          pnpm seed
```

- [ ] **Step 8: Update the documented invocation**

In `e2e/README.md`, change the setup block's reset line and the sentence that recommends it:

```bash
pnpm db:up
pnpm db:migrate
SYNTRA_ALLOW_RESET=syntra pnpm db:reset
SEED_ADMIN_PASSWORD=... SEED_USER_PASSWORD=... pnpm seed
AUTH_RATE_LIMIT_MAX=200 pnpm dev    # api on :3000, web on :5173
pnpm e2e
```

And amend the paragraph beginning "**Run `pnpm db:reset && pnpm seed` after `pnpm test`.**" to name the override and say why:

```markdown
**Run `SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed` after `pnpm test`.** The
integration tests truncate every table between cases and leave the last one's
fixtures behind — usually a tenant named `acme` with an `admin` user in it, which
is enough to fool the seed into reporting the tenant as already seeded and doing
nothing.

`db:reset` refuses to empty anything that is not a scratch `syntra_test_*`
database unless you name the database you mean. That is not ceremony for its own
sake: the development database and the lab database are both called `syntra`, so
the connection string cannot tell them apart, and the guard this replaced tested
`NODE_ENV=production` — which the lab sets nowhere.
```

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/db/src/reset-guard.ts packages/db/src/reset-guard.test.ts \
        packages/db/src/reset.ts .github/workflows/ci.yml e2e/README.md
git commit -m "$(cat <<'EOF'
fix(db): refuse to empty a database nobody said to empty

`db:reset` refused only when NODE_ENV was production -- a variable the lab
deployment sets nowhere: not the systemd unit, not either .env.example. It
therefore passed on the one machine holding real data, where the e2e
README tells operators to run it as a habit and the checkout sits at the
same path a developer's does.

Naming safe databases does not fix it, because the development database
and the lab database are both called `syntra`. So: scratch `syntra_test_*`
databases pass as before, and anything else refuses until the operator
names that exact database in SYNTRA_ALLOW_RESET. Not a truthy flag -- the
name, because typing it is the part that makes somebody check which host
they are pointed at. It now also prints the tenant, user and audit counts
it is about to destroy.

The guard is a pure function so it can be tested without a process that
exits. CI names its database explicitly for the same reason anyone else
has to.
EOF
)"
```

---

### Task 4: Make CI run the tests and the build it cannot see

Spec §8, X1 and X2. 71 web component tests run in no CI job; the three web `*.test.ts` files that CI *does* match run under the root config in a node environment without the jsdom setup; and no job ever builds the production bundle.

**Files:**
- Modify: `vitest.config.ts:33` (the `include` array)
- Modify: `.github/workflows/ci.yml` (the `test` job)

**Interfaces:**
- Consumes: `apps/web/vitest.config.ts` as it stands (jsdom, `globals: true`, `setupFiles: ['./src/test-setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']`).
- Produces: no code symbols. After this task `pnpm test` covers `packages/**` and `apps/api/**` only; `pnpm --filter @syntra/web test` covers everything under `apps/web/src`.

- [ ] **Step 1: Confirm the blind spot before changing anything**

```bash
npx vitest list --config vitest.config.ts 2>/dev/null | grep -c "apps/web"
```

Expected: `3` — the three `.test.ts` files. The 37 `.test.tsx` files are invisible.

```bash
cd apps/web && npx vitest list 2>/dev/null | wc -l; cd ../..
```

Expected: a number in the high tens — every web test file, which is what CI never runs.

- [ ] **Step 2: Narrow the root config so web tests run only under their own**

In `vitest.config.ts`, change the `include` line:

```ts
    // `apps/api`, NOT `apps/**`. The web app has its own config -- jsdom,
    // `globals: true`, and `src/test-setup.ts` -- and the three `.test.ts`
    // files under it were being matched HERE instead: run in a node
    // environment, without that setup, which is not the environment they
    // were written for. Its 37 `.test.tsx` files were matched by neither
    // pattern and ran nowhere at all, which is how a stale assertion in
    // StatusToggle.test.tsx sat red on main unseen.
    //
    // Widening this to `*.test.{ts,tsx}` would not work: this config has no
    // jsdom environment and no React plugin. Two configs, two commands, and
    // CI runs both.
    include: ['packages/**/src/**/*.test.ts', 'apps/api/**/src/**/*.test.ts'],
```

- [ ] **Step 3: Verify the root config no longer claims the web files**

```bash
npx vitest list --config vitest.config.ts 2>/dev/null | grep -c "apps/web"
```

Expected: `0`.

- [ ] **Step 4: Verify the web suite passes under its own config**

```bash
cd apps/web && npx vitest run; cd ../..
```

Expected: `Test Files 37 passed (37)`, `Tests 301 passed (301)`.

- [ ] **Step 5: Add both missing steps to the CI test job**

In `.github/workflows/ci.yml`, in the `test` job, after the existing `- name: Test` step, add:

```yaml
      # THE WEB COMPONENT SUITE, which ran in no job at all until this step.
      #
      # The root vitest config matches `*.test.ts` only, so every
      # `apps/web/**/*.test.tsx` file -- 37 of them, 301 tests -- was
      # invisible to `pnpm test`. Because release.yml reuses this workflow
      # through `workflow_call`, tagged releases shipped with them
      # unexecuted too. A stale assertion in StatusToggle.test.tsx sat red
      # on main until a full local run turned it up.
      #
      # Separate step rather than folded into `pnpm test`: it needs jsdom
      # and the React plugin, which is what `apps/web/vitest.config.ts` is.
      - name: Test the console
        run: pnpm --filter @syntra/web test

      # THE PRODUCTION BUNDLE, which nothing built until this step.
      #
      # The browser job exercises the Vite DEV server, so a break that only
      # appears in a production build -- a rollup resolution failure, a
      # tailwind config error, a dynamic import path -- merged green and
      # first surfaced in release.yml, or on the lab host halfway through a
      # deploy. It takes a couple of seconds.
      - name: Build the console
        run: pnpm --filter @syntra/web build
```

- [ ] **Step 6: Check the workflow parses**

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/Test the console/.test(y)||!/Build the console/.test(y)) { console.error('steps missing'); process.exit(1); } console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: run the console's tests, and build the bundle it ships

The root vitest config matches `*.test.ts`, so all 37 `.test.tsx` files
under apps/web -- 301 tests -- ran in no job at all, and release.yml
reuses this workflow, so tagged releases shipped with them unexecuted. A
stale assertion in StatusToggle.test.tsx sat red on main until a full
local run turned it up.

The three web `.test.ts` files CI did match were worse than useless: the
root config runs them in a node environment without src/test-setup.ts,
which is not what they were written against. Narrowed the root include to
apps/api so the web app's own jsdom config owns all of them, and added the
step that runs it.

Also added `vite build`. Nothing built the production bundle: the browser
job drives the dev server, so a rollup or tailwind break merged green and
first appeared in release.yml or mid-deploy on the lab host.
EOF
)"
```

---

### Task 5: Stop a new migration sorting before the ones production already has

Spec §8, X3. Four migrations are hand-named with dates ahead of the real clock, so the next migration `prisma migrate dev` generates carries a real timestamp that sorts **before** them — while being diffed against a shadow database holding the full end state.

**Files:**
- Create: `packages/db/src/migration-order.ts`
- Create: `packages/db/src/migration-order.test.ts`

**Interfaces:**
- Consumes: the migration directory listing at `packages/db/prisma/migrations`.
- Produces:
  - `const MIGRATION_NAME_FLOOR = '20260830000000'`
  - `function migrationsBelowFloor(names: string[], floor: string): string[]` — returns the names that sort at or below the floor **and are not already known**, i.e. the offenders.
  - `const KNOWN_MIGRATIONS: readonly string[]` — the 31 directories that exist today, which are grandfathered.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/migration-order.test.ts`:

```ts
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_MIGRATIONS,
  MIGRATION_NAME_FLOOR,
  migrationsBelowFloor,
} from './migration-order.js';

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations',
);

const directories = (): string[] =>
  readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe('migration naming order', () => {
  /**
   * The hazard, stated once.
   *
   * Four migrations are hand-named with dates AHEAD of the real clock
   * (20260825.. through 20260830..), and the lab has applied them. A new
   * migration generated today gets a real timestamp -- 20260824.. -- which
   * sorts BEFORE them, while being diffed against a shadow database that
   * holds the full end state including their columns.
   *
   * `prisma migrate deploy` replays in NAME order on a fresh database, so
   * such a migration runs before the columns it was written against exist.
   * `migrationState()` compares name SETS, not order, so nothing else in
   * this codebase can see the difference.
   */
  it('has no migration at or below the floor that is not grandfathered', () => {
    const offenders = migrationsBelowFloor(directories(), MIGRATION_NAME_FLOOR);
    expect(offenders).toEqual([]);
  });

  it('flags a newly generated real-timestamp migration', () => {
    const offenders = migrationsBelowFloor(
      [...directories(), '20260824235959_add_a_column'],
      MIGRATION_NAME_FLOOR,
    );
    expect(offenders).toEqual(['20260824235959_add_a_column']);
  });

  it('accepts one named above the floor', () => {
    const offenders = migrationsBelowFloor(
      [...directories(), '20260831000000_add_a_column'],
      MIGRATION_NAME_FLOOR,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The grandfather list must describe the tree it ships with, or the
   * check silently stops covering whatever drifted out of it.
   */
  it('grandfathers exactly the migrations that exist', () => {
    expect([...KNOWN_MIGRATIONS].sort()).toEqual(directories());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/db/src/migration-order.test.ts`
Expected: FAIL — `Cannot find module './migration-order.js'`.

- [ ] **Step 3: Write the check**

Create `packages/db/src/migration-order.ts`. Generate the `KNOWN_MIGRATIONS` entries from the tree rather than typing them:

```bash
ls packages/db/prisma/migrations -1 | grep -v migration_lock | sed "s/^/  '/;s/$/',/"
```

Paste that output into the array below.

```ts
/**
 * A new migration must not sort before the migrations production already
 * applied.
 *
 * Four migrations in this tree are hand-named with dates ahead of the real
 * clock -- `20260825000000` through `20260830000000` -- and the lab has
 * applied all of them. `prisma migrate dev` names what it generates with
 * the REAL timestamp, so a migration written today is called `20260824..`
 * and sorts before those four.
 *
 * That matters because the two orders are not the same order:
 *
 *   - `prisma migrate deploy` replays in NAME order on a fresh database,
 *     so the new migration runs BEFORE the four.
 *   - The lab applied the four already, so there it runs AFTER them.
 *   - And `migrate dev` diffs against a shadow database holding the FULL
 *     end state, including their columns -- so the migration it writes may
 *     legitimately reference `OrgUnit.status`, `Tenant.additionalDomains`
 *     or `UpstreamIdp.allowLoginAdoption`.
 *
 * A fresh replay then hits those references before the columns exist. In
 * the good case CI fails loudly; in the bad case a data backfill computes
 * over different state than it did on the lab database and nothing
 * anywhere reports it. `migrationState()` compares name SETS, so the
 * readiness check cannot see it either.
 *
 * The rule: name new migrations above the floor.
 *
 *   npx prisma migrate dev --create-only --name add_a_column
 *   mv prisma/migrations/2026082X.._add_a_column \
 *      prisma/migrations/20260831000000_add_a_column
 *
 * When the real clock passes the floor this check becomes a no-op and can
 * be deleted along with the hand-dated names.
 */

/**
 * Migrations named at or below this must not be added. It is the highest
 * hand-dated name in the tree.
 */
export const MIGRATION_NAME_FLOOR = '20260830000000';

/**
 * The tree as it stands. Everything here predates the rule and is exempt;
 * the test asserts this list still describes the directory, so it cannot
 * quietly stop covering something.
 */
export const KNOWN_MIGRATIONS: readonly string[] = [
  // <-- paste the generated list here
];

/**
 * The migrations that break the rule: at or below the floor, and not
 * already part of the tree.
 */
export function migrationsBelowFloor(names: string[], floor: string): string[] {
  const known = new Set(KNOWN_MIGRATIONS);
  return names
    .filter((name) => !known.has(name))
    .filter((name) => name <= floor)
    .sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/db/src/migration-order.test.ts`
Expected: PASS, 4 tests. If the last one fails, the pasted list does not match the directory — regenerate it.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/db/src/migration-order.ts packages/db/src/migration-order.test.ts
git commit -m "$(cat <<'EOF'
test(db): a new migration must not sort before the ones already applied

Four migrations here are hand-named with dates ahead of the real clock,
and the lab has applied them. `prisma migrate dev` names what it generates
with the real timestamp, so a migration written today sorts BEFORE those
four -- while being diffed against a shadow database that holds their
columns.

`migrate deploy` replays in name order, so on a fresh database such a
migration runs before the state it was written against exists. On the lab
it ran after. In the good case CI fails loudly; in the bad case a backfill
computes over different state in the two places and nothing reports it.
`migrationState()` compares name sets, so readiness cannot see it either.

A floor, a grandfather list the test keeps honest, and a failure message
that says to rename. It becomes a no-op once the clock passes 20260830 and
can go then, with the hand-dated names.
EOF
)"
```

---

## Done when

- [ ] A snapshot builds for a person holding one resource through two accounts, writes one holding, and keeps both attributions.
- [ ] `pnpm db:reset` refuses a database named `syntra` and says how to mean it; scratch `syntra_test_*` databases still reset freely; CI and the e2e README name theirs.
- [ ] `pnpm test` no longer claims the web files; `pnpm --filter @syntra/web test` runs 301; CI runs both that and `vite build`.
- [ ] A migration named `20260824…` fails a test that names the file and the rule.
- [ ] `npx tsc -b` exits 0 and `packages/core/src/auth/password-reset.test.ts` is still uncommitted and untouched.

## Deliberately not in this plan

Everything else in the findings register. In order of the plans that follow:

- **Remediation 2 — Governance.** G1–G27: the decide race, retention deleting campaign evidence, the `revoked` figure, the two transaction-ceiling failures that never recover, the empty evidence bundle, CSV injection, the scheduling switch, and "Verify now".
- **Remediation 3 — Approvals and provisioning.** A1–A9, P1–P8: the stuck multi-stage request, the terminal-transition races, the dropped revocation order, the double apply.
- **Remediation 4 — Auth, API and console.** H1–H6, N1–N6, W1–W9, S1–S7, B1–B5: `ForceAuthn`, the passkey reset lockout, role management, and the console's missing surfaces.
- **Remediation 5 — The update feature.** U1–U10, plus the lab rehearsal its own design lists as outstanding.
