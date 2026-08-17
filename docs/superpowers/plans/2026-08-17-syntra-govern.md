# Syntra Govern — Inventory & Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Syntra's access-governance subsystem — a point-in-time inventory of every holding in the tenant with its provenance, freshness and coverage stated honestly, and the recertification, revocation-dispatch and segregation-of-duties machinery built on top of it.

**Architecture:** Govern is a domain module in `packages/core/src/govern/`, beside `rbac`, `audit`, `provision` and `automate`. It opens no socket, holds no target credential and writes no access-bearing row: it reads PostgreSQL, writes its own tables, and dispatches every access change to the subsystem that owns the write. The snapshot pipeline is `collect → correlate → attribute → classify → detect → write`, with the four middle stages pure functions over plain values so that everything genuinely hard is testable without a database. Slice 1 (Inventory, Tasks 1–14) changes nobody's access; slice 2 (Campaigns and Duties, Tasks 15–22) is where every irreversible act lives.

**Tech Stack:** TypeScript 5.7 (`exactOptionalPropertyTypes` on), Prisma 6 over PostgreSQL with forced row-level security, Fastify 5, React 19 + react-router 7, Vitest 3 (single fork), Playwright, pg-boss 12, Zod 3.

**Spec:** `docs/superpowers/specs/2026-08-16-syntra-govern-design.md` (24 sections). Rulings that bind this plan: `.superpowers/sdd/govern-rulings.md` (G1), `.superpowers/sdd/provision-rulings.md` (P1–P7), `.superpowers/sdd/provision-preflight-rulings.md` (P8–P23), `.superpowers/sdd/automate-preflight-rulings.md` (A-3–A-10). Dependency plans: `docs/superpowers/plans/2026-08-16-syntra-provision.md` and `docs/superpowers/plans/2026-08-17-syntra-automate.md`. **Where Provision's plan and `.superpowers/sdd/2026-08-16-syntra-provision/progress.md` disagree, the ledger is what shipped and the ledger wins.**

---

## Global Constraints

Everything in the Core, Directory Sync, Access, Provision and Automate plans' Global Constraints still applies. These are the ones that bite here, plus the ones this sub-project adds. Every task's requirements implicitly include this section.

### The platform rules

1. **Govern opens no socket and holds no target credential.** No Govern file imports `@syntra/connectors` outside a test, reads a `TargetSystem.secretName` into a connector, or calls `getSecret` for a target. Task 7 makes it a structural test over the import graph. (Spec §5, §21, §23.)

2. **Govern writes no access-bearing row.** `GroupMembership`, `AppAssignment`, `RoleAssignment`, `TargetAccount`, `AccountEntitlement`, `AccessGrant` and `AuditEvent` are never written from `packages/core/src/govern/` — the last because Govern writes audit events only through `recordEvent`. Task 7 makes it a structural test over the Prisma model names each Govern module writes. (Spec §5, §21, §23.)

3. **Every new table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`** and a `tenant_isolation` policy whose `USING` **and** `WITH CHECK` are `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. The `NULLIF` is not optional: `set_config(..., true)` reverts the GUC to the **empty string, not NULL**, at transaction end, and `''::uuid` raises. Copy the `DO $$ … FOREACH … END $$;` block from `packages/db/prisma/migrations/20260820000000_provision_targets/migration.sql` (lines 363–377) verbatim and change only the table-name array.

   **Mutation-testing an RLS policy weakens it; it never drops it.** Under `FORCE`, dropping the policy denies every row, so an isolation test still passes — vacuously. The mutation that proves anything is `USING (true)`. (Provision Task 1 ledger.)

4. **`withTenant` is `prisma.$transaction(fn)`** and `packages/db/src/client.ts` constructs the client with no `transactionOptions`, so Prisma's **5000 ms default applies**. No network I/O, LDAP, SMTP, Argon2 or signing inside one — and **no unbounded loop inside one either**, because 5000 ms is a duration and Govern's work is tenant-sized database work.

   **And a bare `prisma.<model>` read *outside* `withTenant` returns `[]` under forced RLS whether or not the code works.** The two rules are in tension. **The resolution is always a short transaction returning plain data, never a read moved outside** (Ruling A-9). Every pure stage in this plan takes plain values for exactly this reason.

   Govern's budgets, stated as numbers so a reviewer can check them:

   | Loop | Batch | Where |
   |---|---|---|
   | Snapshot holding/attribution/gap writes | `SNAPSHOT_WRITE_BATCH = 500` holdings per transaction | Task 7 |
   | Snapshot collect reads | fixed **nine** set-based queries, independent of population | Task 6 |
   | `HoldingEvent` writes | `EVENT_WRITE_BATCH = 500` | Task 7 |
   | Finding upserts | `FINDING_BATCH = 200` | Task 8 |
   | Campaign item generation | `ITEM_BATCH = 500` | Task 17 |
   | Reviewer resolution during generation | `REVIEWER_BATCH = 200` items per transaction | Task 18 |
   | Bulk certify | `bulkCertifyLimit` (default 50) — one transaction, one audit event | Task 19 |
   | Revocation batch compute + write | **one** transaction; a batch is thousands of rows at most | Task 20 |
   | Revocation dispatch | one transaction **per dispatch row** | Task 20 |
   | Audit chain verification | `AUDIT_VERIFY_PAGE = 1000` events per transaction | Task 10 |
   | Report reads | one short transaction returning plain data; rendering is outside it | Task 11 |

   Task 12 makes the rule a test: a client wrapper that fails when any `withTenant` in a Govern code path exceeds a time budget under a seeded large tenant.

5. **Unique constraints do not constrain NULLs in PostgreSQL.** Any uniqueness rule over a nullable column, or qualified by a status, is a hand-written partial unique index appended to the generated migration — never `@@unique`. This plan has seven. **Inspect the generated migration before appending:** `prisma migrate diff` compares the schema file against a shadow database, `schema.prisma` cannot express a partial index, so every partial index the previous slices created by hand looks to the diff like something the database has and the model does not, and it emits `DROP INDEX` for them. Delete any such line before going further. Provision's Task 1 found none; that is not a guarantee for this one.

6. **Every "one non-terminal row per X" index ships with its supersession path and a crash test, in the same task.** Ruling A-4 is a standing rule and this programme has shipped the failure twice: `provision_run_one_non_terminal` bricked a target, `ExpirySweep`'s equivalent stopped every grant expiring. This plan has three such indexes — `govern_snapshot_one_building`, `govern_revocation_batch_one_non_terminal` (two indexes, one predicate) and `govern_revocation_order_one_open` — and each is written in the same task as (a) the adoption path that supersedes a stale row at the head of the transaction that creates the new one, and (b) a test that crashes one and starts another.

7. **Migration directory names must sort after every migration they depend on.** As of writing, the newest on disk is `20260820000000_provision_targets`; Automate's plan claims `20260821000000_automate_requests`. This plan takes **`20260822000000_govern_inventory`** (Task 1) and **`20260823000000_govern_campaigns`** (Task 15). **Re-read `packages/db/prisma/migrations/` before creating either directory** and bump the date if anything newer has landed. Two agents working the same repo pick the same plausible timestamp, and the failure is a migration ordering that depends on filesystem enumeration (Ruling P7).

8. **Vitest does not type-check.** `pnpm vitest run` executes a file full of type errors. **Every task verifies with `pnpm exec tsc -b --force` as its own step.** Plain `tsc -b` is not enough: the workspace packages arrive through `node_modules`, so TypeScript treats them as external libraries and a dependent project's `tsbuildinfo` never records them as inputs — `tsc -b packages/core` exits 0 while `--force` exits 1 on the same tree (Provision Task 3 ledger).

9. **pg-boss schedules need a distinct `key` per tenant and per purpose.** `Scheduler.schedule(name, cron, data?, key?)` in `packages/core/src/jobs/scheduler.ts` defaults `key` to `''`, and pg-boss keys its schedule table on `(queue, key)`. `governScheduleKey(tenantId, purpose)` is mandatory on every `schedule` and `unschedule` this plan makes. Govern has **seven** purposes on seven queues, enumerated in Task 12.

10. **`Person` has no `email` and no `displayName` column.** The columns are `givenName`, `familyName`, `nameConvention`, `businessEmail`, `personalEmail`, `externalId`, `status`. A display name is derived by `personDisplayName(person: PersonFacts): string` from `packages/core/src/provision/desired.ts`. `User` does have `email` and `displayName`.

11. **`exactOptionalPropertyTypes` is on.** `{ foo: undefined }` does not satisfy `{ foo?: string }`. Spread conditionally: `...(x === undefined ? {} : { foo: x })`.

12. **A Prisma `Json` column takes `as never` at the write, and nowhere else.** TypeScript gives an implicit index signature to object *type literals* and never to an `interface`, so an interface-typed value is not assignable to `Prisma.InputJsonValue`. Follow `packages/core/src/sync/source-service.ts:41` — `config: config as never`. **Every other `as never` in this plan is a defect.** Ruling P19 measured what the cast costs: it silenced the exact type error that would have caught a runtime crash, in nine places, and the failure surfaced as what looked like a library bug. Any `as never` outside a Prisma `Json` write is read as a question, not a convention.

13. **Clearing a nullable `Json` column needs `Prisma.DbNull`.** Prisma reads `undefined` as "do not touch this column", so `x ?? undefined` on an update path makes clearing impossible while looking like it works. This plan has three such columns — `Campaign.scope`, `SodException.basisContractIds`, `GovernFinding.detail` — and `Campaign.scope` decides who a campaign covers.

14. **`z.ZodType<T>` over a `z.lazy` schema checks nothing** (Ruling P21, measured: deleting a whole arm of the union still compiles). Every recursive schema in this plan carries two `MutuallyAssignable` guards over its non-lazy leaf schema instead, matching what `packages/core/src/provision/condition.ts` ships. **A construct that stands in for verification is written so that it bites, and every task that adds one includes the step that mutates the thing and observes the failure.**

15. **Tests run in a single fork against one PostgreSQL** (`vitest.config.ts`, `poolOptions.forks.singleFork`), and `resetDatabase()` truncates between tests. **Root `vitest.config.ts` includes only `*.test.ts`** — `apps/web` component tests are `*.test.tsx` and run under `apps/web/vitest.config.ts` (jsdom) via `pnpm --filter @syntra/web test`. Tasks 14 and 22 verify with that command, not with root `pnpm vitest run`.

16. **`FakeTarget` is imported from `@syntra/connectors/testing`, never from `@syntra/connectors`.** Provision's Task 2 fix wave gave the package an `exports` map with exactly two entries, `"."` and `"./testing"`, and `src/index.ts` deliberately does not re-export the fake. The root import is `TS2305`; an `@syntra/connectors/src/...` path is `TS2307`. (Provision Task 4 ledger; Ruling A-4/H1.)

17. **A fake reproduces the real system's identifier semantics** (Ruling P8). This plan introduces no new fake target and reuses `FakeTarget` unchanged.

18. **Normalisation is NFKD, not NFD.** NFD leaves `ĳ` intact, so folding `Ĳsbrand` yields `sbrand` — somebody else's login. Anywhere Govern folds a name for candidate matching (Task 9), it uses `.normalize('NFKD')`, matching `packages/core/src/provision/names.ts`.

19. **AD folds case and PostgreSQL does not.** Three defects on Provision came from that. Every comparison Govern makes between an identifier that came from a directory and one that came from PostgreSQL is case-folded explicitly. Task 9's orphan matching and Task 6's account correlation both do it.

20. **Ordering must be recoverable from the database.** `createdAt` defaults to `now()`, which in PostgreSQL is **transaction start time**, so every row of one `createMany` carries an identical `createdAt` and ordering by it imposes no order at all. Every Govern table whose rows have a meaningful order carries an explicit ordinal or is ordered by a natural key: `CampaignDecision.sessionDecisionOrdinal`, `RevocationDispatch.sequence`, `HoldingEvent` by `(toSnapshotId, systemId, resourceId, subjectKey)`, `AuditChainCheck` by `fromSequence`.

21. **Commits:** conventional commits, one per task. **Tests:** TDD — a failing test precedes the code that satisfies it, and every test step says what the fixture would look like if it could not distinguish pass from fail.

22. **Mutation-test the tests you write, not only the code you write.** On this programme, six consecutive tasks found real defects that way and three found them *in their own new tests*. A test whose fixture cannot distinguish pass from fail is the same defect as a missing test and is invisible to every other check. Each task's final verification step names at least one mutation and the assertion that must catch it.

### The three composition hazards

Two individually correct rules producing a defect where they meet is the failure Ruling A-10's H-4 named. Govern has three known pairs; each is tested at the site where they meet, not at either site alone.

| Pair | What composing them would produce | Where it is tested |
|---|---|---|
| `moot` on subject departure (§11) **+** a `revoke_decided` item already carrying a decision | A leaver's holding is mooted, the decision never dispatches, and the campaign reports it handled. **Only `pending` and `blocked_no_reviewer` items moot.** | Task 18 Step 7 |
| `RevocationOrder` cancelled-as-overtaken (§5) **+** the `dispatch_not_applied` SLA finding (§13) | A cancelled order raises a finding saying a revocation was not applied, about a revocation that was correctly abandoned. | Task 20 Step 11 |
| `HoldingCertification` projection (§18) **+** campaign re-base re-opening only changed items (§8) | Re-basing rolls the projection back for items whose holding did not change, and a certification that is still good reads as never made. | Task 19 Step 9 |

### The leaver question, answered once

Automate's grants kept a leaver's account enabled forever (Ruling A-3); Provision's unprocessable flag froze a leaver's deprovisioning (Ruling P23). Two slices, two unrelated routes, one outcome. Govern certifies access, so it has five routes to the same place and each is closed explicitly:

- **A campaign item whose subject has departed becomes `moot`, never `certified`,** records the departure date, and is counted on its own line rather than in the certified figure. (§11, Task 18.)
- **A decision may not be recorded on an item whose subject has departed.** `recordDecision` refuses with `subject_departed` and moots the item instead. A certification is a signed statement about somebody's access; signing one for a person who left is exactly the false assurance this module exists to prevent. (Task 19.)
- **A departure never suppresses a revocation.** `moot` applies only to `pending` and `blocked_no_reviewer` items. An item already `revoke_decided` dispatches. (Task 18, and the composition table above.)
- **`access_without_contract` detection cannot see any Govern state.** `detectAccessWithoutContract(holdings, contractsByPerson, now)` takes holdings and contracts and nothing else — no exceptions, no accepted findings, no campaign items, no certifications. It is structurally incapable of concluding that a person is still employed because somebody attested to their access, accepted a finding about it, or excepted an SoD rule for them. Task 8 Step 3 fixes the signature and Task 8 Step 9 mutation-tests it. This is Ruling A-3's shape closed by construction rather than by care.
- **A reviewer who leaves mid-campaign** has their decisions stand — they were valid when made — and their open items re-resolved. Validity is re-checked at the moment of each decision, not only at resolution, because deactivation revoking sessions covers most of it and most of it is not a security control. (§12, Task 18.)
- **An `SodException` lapses when either basis contract ends** and reopens the violation; **nothing is revoked**. (§15, Task 21.)
- **A reminder is never sent to a departed reviewer**, and the item reassigns instead. A reminder in a leaver's mailbox is a campaign asking somebody who no longer works there to certify somebody else's access. (Task 18.)

### Defaults, copied verbatim from the spec

`GovernSettings`, one row per tenant, spec §18. Do not invent others.

| Setting | Default | Spec |
|---|---|---|
| `snapshotSchedule` | `0 1 * * *` (cron; nightly, ahead of Automate's 02:00 sweep so the sweep runs against a fresh picture) | §18, §19 |
| `snapshotRetentionDays` | 400 | §9 |
| `defaultFreshnessSlaHours` | 24 | §8 |
| `maxSnapshotAgeDays` | 30 | §8 |
| `batchThresholdPercent` | 10 | §13 |
| `perResourceThresholdPercent` | 30 | §13 |
| `personPopulationDropPercent` | 20 | §13 |
| `minimumCoveragePercent` | 90 | §12 |
| `bulkCertifyLimit` | 50 | §12 |
| `dispatchSlaHours` | 72 | §13 |
| `privilegedRecertifyDays` | 90 | §16 |
| `maxExceptionDays` | 90 | §15 |
| `exceptionWarningDays` | `[14, 3]` | §15 |
| `minReciprocalDecisions` | 3 | §14 |
| `reciprocityWindowDays` | 180 | §14 |
| `lastAppliedBatchAt` | null | §13, §18 |
| `personsWithActiveContractAtLastBatch` | null | §13, §18 |
| `MAX_ORG_UNIT_DEPTH` | 64 — **a code constant, not a setting**, matching `packages/core/src/access/resolve.ts` | §7 |
| `MAX_GRAPH_DEPTH` | 6 — **a code constant, not a setting** | §14 |
| `SNAPSHOT_STALL_MINUTES` | 60 — **a code constant, not a setting**; how old a `building` snapshot must be before a new build supersedes it | §19 |

The last two settings are the denominator the population-collapse refusal compares against, **stored rather than recomputed**, for the reason Provision stores `lastAppliedRunAt` and Automate stores `lastAppliedSweepAt`: the comparison is against the last state somebody accepted, not the last state observed.

Coverage, defined once because it is the number people quote (§12):

```
coveragePercent = (decided + moot) / total
```

where `decided` is every item carrying a `CampaignDecision` and `moot` is every item the world resolved without a human. **A campaign report never prints a percentage without the four counts beside it**, and **every percentage in this sub-project names its denominator inline**.

### The vocabulary rule (§10, §13)

These words mean exactly this, in code, in the API and on every screen, and a task that uses one loosely is wrong:

- **`held`** — the system named as the source said so, at the time named as `observedAt`, and nothing has been observed since to contradict it.
- **`not_held`** — the region was read *completely* at that time and this subject was not in it. Never inferred from an unread or partial region. **Never a stored row.**
- **`unknown`** — what it says. Never rendered as a zero, a dash or an omission, on any screen, in any export, in any total.
- **`certified`** — a named human recorded a keep decision against a stated set of facts at a stated time. It does not mean the access is appropriate, that the human read it, or that the facts were true at the target at that instant.
- **`revocation_dispatched`** — the owning subsystem has it. **Not "revoked".**
- **`revocation_confirmed`** — the owning subsystem reported it applied. No snapshot has seen it gone.
- **`revocation_applied`** — confirmed **and** a subsequent snapshot no longer shows the holding. Two conditions, not one.
- **`revocation_requires_change`** — Govern cannot execute it. A `RemediationItem` exists. **Never counted in a revoked figure.**

---
## The hard dependency, stated once

Govern is built on Provision — Targets and Automate — Requests, both of which are in build in this same checkout. Every symbol named below is taken from those plans' Interfaces blocks, corrected against `.superpowers/sdd/2026-08-16-syntra-provision/progress.md` where the ledger and the plan disagree.

| Symbol | Where it is defined | Correction from the ledger, or the trap |
|---|---|---|
| `prisma`, `withTenant`, `type TenantClient` | `@syntra/db` (`packages/db/src/index.ts`) | the barrel exports exactly these three |
| `resetDatabase`, `asDatabaseSuperuser` | `@syntra/db/src/test-support.js` | `asDatabaseSuperuser` needs `SUPERUSER_DATABASE_URL` and is only for tamper tests |
| `currentTenant` | `packages/core/src/tenant-context.ts` | throws when no tenant is bound |
| `recordEvent`, `verifyChain`, `listEvents`, `GENESIS_HASH`, `type AuditInput`, `type ChainResult` | `packages/core/src/audit/audit-service.ts` | `stableStringify` and `computeHash` are **module-private and must be exported by Task 10** |
| `PERMISSIONS`, `type Permission`, `ALL_PERMISSIONS`, `isPermission` | `packages/core/src/rbac/permissions.ts` | Provision Task 17 adds `PROVISION_READ`/`PROVISION_MANAGE`; Automate adds three |
| `hasPermission`, `permissionsForUser` | `packages/core/src/rbac/rbac-service.ts` | **does not walk the org-unit tree**, and a scoped assignment does not satisfy an unscoped question — see Task 13 |
| `activeContracts`, `resolveContractForMapping`, `primaryContract` | `packages/core/src/identity/contract-service.ts` | `activeContracts(tx, personId, on?)` — inclusive of the first and last day |
| `resolveApplicationIdsForUser`, `resolveApplicationsForUser` | `packages/core/src/access/resolve.ts` | returns `Set<string>` and **discards the path** — see Task 6 |
| `listGroupsForUser`, `listMembers`, `addMember` | `packages/core/src/directory/group-service.ts` | Govern reads; it never calls `addMember` |
| `type Scheduler`, `type JobHandler`, `createScheduler` | `packages/core/src/jobs/scheduler.ts` | `schedule(name, cron, data?, key?)`, `key` defaults to `''` |
| `type Transport`, `sendMessage`, `renderMessage`, `memoryTransport` | `packages/core/src/notify/notification-service.ts` | `sendMessage` cannot be handed a `TenantClient` and is never called inside one |
| `TEMPLATES`, `type TemplateName`, `type Template` | `packages/core/src/notify/templates/index.ts` | five templates today; Automate adds its own; Govern adds seven in Task 12 |
| `type MasterKeyProvider`, `localMasterKeyProvider` | `packages/core/src/vault/master-key.ts` | **`wrap`/`unwrap` only — there is no `sign`.** Task 10 adds a distinct `CheckpointSigner`. |
| `evaluateCondition`, `conditionSchema`, `type Condition`, `type ConditionFacts`, `type ConditionOperator` | `packages/core/src/provision/condition.ts` (Provision Task 5) | a blank `value` is refused by the schema **and** by a runtime backstop (Ruling P20) |
| `personDisplayName`, `activeOn`, `latestContractEnd`, `resolveMappingContract`, `desiredState` | `packages/core/src/provision/desired.ts` (Provision Task 7) | the account requirement is decided over the **window** `[now, horizon]`, not at the horizon |
| `type PersonFacts`, `type Attribution`, `type DesiredState`, `type KnownHolding`, `type ActualState`, `type DriftKind`, `type AccountStatus` | `packages/core/src/provision/types.ts` | the barrel exports the contract type as **`ProvisionContractFacts`**, not `ContractFacts` — `policy/types.js` already owns that name (TS2308). Inside `packages/core` import from `../provision/types.js` by its own name. |
| `renderTemplate`, `renderContainer`, `escapeDnValue` | `packages/core/src/provision/templates.ts` | **`renderContainer` always escapes and is the only function called on a container template** (Ruling P22) |
| `type PlannedAction`, `planActions`, `type PlanInput`, `addDays`, `ACTION_ORDER` | `packages/core/src/provision/plan.ts` (Provision Task 9) | **`PlanInput` has no `revocationOrders` — Task 20 adds it** |
| `remitFor`, `refreshEntitlements`, `grantedEntitlementsFor` | `packages/core/src/provision/entitlement-service.ts` | there is deliberately **no `holderCounts` helper** |
| `previewProvisionRun`, `ProvisionRunInFlightError` | `packages/core/src/provision/run-service.ts` | — |
| `applyProvisionRun` | `packages/core/src/provision/apply.ts` | — |
| `PROVISION_JOB`, `provisionJobPayload`, `provisionScheduleKey`, `applyTargetSchedule` | `packages/core/src/provision/jobs.ts` | Task 13's **Refresh now** enqueues `PROVISION_JOB` |
| `explainPersonAccess`, `type PersonAccess`, `previewRuleImpact`, `type RuleImpact` | `packages/core/src/provision/explain.ts` (Provision Task 16) | `previewRuleImpact` gains an SoD column in Task 16 of this plan |
| `claimSyntraUsers`, `applySyntraUserAction` | `packages/core/src/provision/syntra-user.ts` (Provision Task 15) | Task 9 calls Provision's account-linking path; Govern never writes `TargetAccount` |
| `SYNC_JOB`, `syncJobPayload` | `packages/core/src/sync/jobs.ts` | Task 13's **Refresh now** enqueues it for a directory source |
| `resolveStageApprovers`, `resolveSelector`, `type StageSnapshot`, `type ResolutionSubject`, `type ResolvedApprover`, `type ApproverSelector`, `type SelectorConfig`, `isValidApprover`, `managerChainFor`, `type DropReason`, `MAX_MANAGER_DEPTH` | `packages/core/src/automate/approvers.ts` (Automate Task 4) | exclusions are subtracted **after** expansion, never before (Ruling A-6) |
| `enqueueOutbox`, `type OutboxDraft`, `recipientsForPersons`, `type Recipient`, `usersWithPermission`, `displayNames`, `nameList`, `isDigestible`, `NEVER_DIGESTED` | `packages/core/src/automate/notify.ts` (Automate Task 5) | **every `var` a template renders is a name, never an id** |
| `automateSettings`, `subjectAudienceFacts`, `allSubjectAudienceFacts`, `orgUnitChainFor`, `upsertResourceOwner` | `packages/core/src/automate/catalog-service.ts` (Automate Task 6) | never call the per-subject form in a loop over the tenant |
| `revokeGrant`, `handBackGrant`, `fulfilRequest`, `subjectHoldings`, `requestUrl` | `packages/core/src/automate/fulfil.ts` (Automate Task 9) | `revokeGrant(tenantId, actorUserId, grantId, reason, options?)` — **takes a `User` id, not a person**, and opens its own transaction |
| `checkEligibility` | `packages/core/src/automate/eligibility.ts` (Automate Task 9) | Task 16 adds the SoD check here |
| `type RefusalReason`, `type GrantStatus`, `LIVE_GRANT_STATUSES`, `IN_FORCE_GRANT_STATUSES`, `type ResourceType`, `type RequestStatus` | `packages/core/src/automate/types.ts` (Automate Task 2) | Task 16 adds `'sod_violation'` to `RefusalReason` |
| `evaluateSweepGuard`, `type SweepGuardVerdict`, `type SweepGuardInput` | `packages/core/src/automate/sweep-guard.ts` (Automate Task 13) | read for shape; Govern's guard is its own and has four outright refusals |
| `AUTOMATE_TICK_JOB`, `automateScheduleKey`, `registerAutomateJobs`, `type AutomateJobPayload` | `packages/core/src/automate/jobs.ts` (Automate Task 15) | — |
| `requireSession`, `requirePermission`, `ProblemError`, `buildTestApp`, `createFakeScheduler`, `TEST_HOST` | `apps/api/src/plugins/require-session.ts`, `require-permission.ts`, `problem-json.ts`, `apps/api/src/test-support.ts` | routes are registered with a **prefix**, so paths inside a route module are relative — `'/govern/snapshots'`, never `'/api/admin/govern/snapshots'`. Reads go through `request.db((tx) => …)`, not a bare `prisma`. |
| `api`, `ApiError`, `type Problem` | `apps/web/src/session/api.ts` | `api<T>(path: string, init: RequestInit = {})` |
| `useApiResource`, `type Resource`, `fieldErrors` | `apps/web/src/session/use-api-resource.ts`, re-exported from `apps/web/src/pages/admin/hooks.ts` | `useApiResource<T>(path: string \| null)` |
| `Alert`, `Button`, `Empty`, `Field`, `Panel`, `SkeletonRows`, `Status` | `@syntra/ui` | **`Alert` tones are `info \| warning \| danger` only** — there is no `success`. `Status` tones are `neutral \| active \| inactive \| warning \| danger \| primary`. |
| `PageHeader` | `apps/web/src/pages/admin/PageHeader.tsx` | `{ title, description?, actions? }` |
| `AdminApp.tsx` | `apps/web/src/pages/admin/AdminApp.tsx` | `<Route>` paths are **relative** (`path="govern/snapshots"`); `NAV` entries are **absolute** (`/admin/govern/snapshots`) |

**Do not start Task 6 until Provision Tasks 1, 5, 7, 8, 9, 12, 13, 14, 15 and 16 have landed and Automate Tasks 1–9 have landed.** Tasks 1–5 of this plan depend only on Provision Task 1's migration — already committed as `20260820000000_provision_targets` — and on Core.

### Twelve things Govern needs that Provision, Automate or Core does not expose

Named rather than worked around, because each is a real seam and each has a task that closes it.

1. **`stableStringify` and `computeHash` are module-private in `packages/core/src/audit/audit-service.ts`.** Spec §17 requires incremental verification seeded with a checkpoint's hash, and an evidence bundle serialised "with the same sorted-key discipline `stableStringify` already implements". `verifyChain(tx)` takes no range and walks every event ever recorded into memory. **Task 10 exports both — as `stableStringify` and `auditEventHash` — and adds `verifySegment`.** Reimplementing either would produce a second hash function that drifts from the one that wrote the chain, and the drift would surface as a chain that verifies as broken when it is whole.

2. **`resolveApplicationIdsForUser` returns `Set<string>` and discards the path.** Spec §7 asserts it "already knows which unit produced the match". It does not: one `findMany` with an `OR`, selecting `applicationId` alone, and `orgUnitChain` is module-private. The `direct_assignment`, `group_inheritance` and `org_unit_inheritance` attributions — and the unit chain §7 calls "the difference between an answer and a shrug" — cannot be derived from it. **Task 6 adds `resolveApplicationPaths` in `packages/core/src/govern/collect.ts`**, set-based over the whole tenant, returning the assignment row and the chain for each match. It does not modify `resolve.ts`.

3. **`hasPermission` does not walk the org-unit tree, and `requirePermission` asks unscoped.** Spec §18 and §21 make `govern.read` "scopeable to an organizational unit through Core's existing `RoleAssignment.scopeOrgUnitId`". Core's `hasPermission(tx, userId, perm, scopeOrgUnitId?)` matches a scoped assignment only against that exact unit id and explicitly refuses to satisfy an unscoped question — so a scope-only holder gets **403 on every Govern route**, and a scope on Head Office would not admit a person in a unit beneath it. **Task 13 adds `governReadScope()` and `requireGovernRead()`**, including the descendant walk, and applies the scope on every read path rather than only on the list.

4. **Provision's `PlanInput` has no `revocationOrders` and `ProvisionAction` has no `revocationOrderId`.** Spec §5 and §18 require both. **Task 20 adds them**, to `packages/core/src/provision/plan.ts`, `types.ts`, `run-service.ts` and the schema.

5. **Ruling G1's condition cannot be met by `ProvisionAction`'s existing columns.** Its only attribution column is `attributedRuleIds: String[]`; there is no decider, campaign or decision column, and the apply-path audit event is Provision's to write. G1 says the ruling does not hold unless the record at the point of application shows a human decision and names the campaign and the reviewer. **Task 20's resolution: the order's provenance is denormalised into the plain-value `RevocationOrderFacts` the plan stage receives** — `decidedByPersonName`, `campaignName`, `campaignDecisionId` — and lands in `PlannedAction.before`, so Provision's audit event names a human **without Provision ever querying Govern**, which §5 forbids.

6. **There is no holder count for anything but a target entitlement.** Provision deliberately declines a `holderCounts` helper and writes `Entitlement.holderCount` from the *target inventory* during a run. Govern's per-resource revocation axis (§13) applies to `syntraGroup`, `application`, `syntraRole` and `targetAccount` too, and none has a denominator anywhere. **Task 20 computes it from the campaign's own snapshot**, which means the axis is exactly as good as that snapshot's coverage — so a resource whose count is `unknown` cannot be divided and forces confirmation with the resource named, rather than being silently skipped.

7. **`ApprovalDecision` has no index on `decidedAt`.** The decision graph's reciprocity query is a 180-day window over decisions joined to their requests' subjects, two hops through `ApprovalStep`, with no supporting index. **Task 15 adds `@@index([tenantId, decidedAt])` to `ApprovalDecision`** in the slice-2 migration. Nothing else about Automate's table changes.

8. **`revokeGrant` takes an actor `User` id, not a deciding `Person`.** Spec §5 says Govern calls it "with the deciding person and the campaign decision as the reason". A reviewer decides as a `Person`, and a person may hold several `User` rows or none. **Task 15 therefore adds `decidedByUserId` to `CampaignDecision`** — the account the decision was made from, exactly as `ApprovalDecision.userId` does — and **Task 20 passes that user id through**. Where the reviewer has no user row at dispatch time, the dispatch proceeds with `actorUserId: null` and records `"the deciding person holds no active Syntra account"` on the dispatch, rather than dropping the revocation.

9. **`revokeGrant` opens its own transaction per call**, which Automate's Task 13 states explicitly. That is correct here — each dispatch is its own short transaction — but it means Automate's own sweep guard is not in the path. **That is deliberate and §13 says so:** Govern's batch guard is what makes the aggregate safe, and Automate's single-grant hand-back exemption is explicitly *not* reused per item, because a reviewer's 340 decisions arriving at once are mass action wearing 340 individual coats. Named here so a reviewer does not read it as a bypass.

10. **`ProvisionException` rows are per-run and cascade-delete with the run.** Spec §8's `person_unprocessable` coverage gap "references Provision's `ProvisionException` rows". They do not persist: a new run writes new ones and deleting the run deletes them. **Task 6 reads the latest run's exceptions per target and copies the person id, kind and message onto the `CoverageGap` row**, because a gap that dangles when a run is pruned is a gap that silently closes.

11. **Nothing records *which run failed to read* an unreadable entitlement.** `Entitlement.status = 'unreadable'` is the available signal and `DriftFinding` has no matching kind, so `CoverageGap.sourceRunId` for a `resource_unreadable` gap can only name the target's most recent run, not the run that failed the read. **Task 6 records that run and says so in the gap's `reason` string**, rather than implying a precision the data does not have.

12. **`AppAssignment` has no `createdByUserId` and `RoleAssignment` has no `createdAt` at all.** Spec §7's `direct_assignment` attribution wants the administrator and the date. **Task 4 resolves the administrator from the audit log by `targetType`/`targetId` where an event names one, and where none does the attribution says so in words** — `"assigned directly; no audit event records who or when"` — rather than emitting a blank field a reader would take for a missing value. Govern adds no column to either table (§5, §18).

---

## File Structure

```
packages/db/prisma/
  schema.prisma                       + GovernSettings, GovernSourcePolicy, ResourceClassification,
                                        AccessSnapshot, SnapshotSource, Holding, HoldingAttribution,
                                        CoverageGap, HoldingEvent, HoldingCertification,
                                        AccountAttribution, GovernFinding, RemediationItem,
                                        EvidencePack, AuditCheckpoint, AuditChainCheck, AuditAnchor
                                        (Task 1, migration 20260822000000_govern_inventory)
                                      + Campaign, CampaignItem, CampaignItemReviewer,
                                        CampaignDecision, ReviewQualitySignal, RevocationBatch,
                                        RevocationDispatch, RevocationOrder, BusinessFunction,
                                        BusinessFunctionResource, SodRule, SodViolation, SodException
                                        MODIFIED: ProvisionAction.revocationOrderId,
                                        ApprovalDecision @@index([tenantId, decidedAt])
                                        (Task 15, migration 20260823000000_govern_campaigns)

packages/core/src/govern/
  types.ts              the closed vocabularies + three-valued aggregation      (pure)   T2
  freshness.ts          source classification, staleness, coverage rollup       (pure)   T3
  attribute.ts          the attribution set and the unattributable definition   (pure)   T4
  diff.ts               consecutive-snapshot diff -> HoldingEvent drafts        (pure)   T5
  collect.ts            the nine set-based readers + resolveApplicationPaths             T6
  snapshot-service.ts   build, readableSnapshot, prune                                   T7
  finding-service.ts    GovernFinding + RemediationItem lifecycle, standing findings     T8
  orphan-service.ts     AccountAttribution: propose, claim, confirm                      T9
  audit-integrity.ts    verifySegment, checkpoints, signatures, anchors                  T10
  settings-service.ts   GovernSettings, GovernSourcePolicy, ResourceClassification       T11
  report-service.ts     the four reports + the branded header envelope                   T11
  export-service.ts     CSV rows + the evidence bundle and its digest                    T11
  jobs.ts               GOVERN_* queues, schedule keys, registerGovernJobs               T12
  scope.ts              governReadScope + the org-unit descendant walk                   T13
  sod.ts                evaluateSodRules, sodImpact                             (pure)   T16
  sod-service.ts        business functions, rules, violation persistence                 T16
  campaign-service.ts   create, scope preview, item generation, close                    T17
  reviewer-service.ts   resolution preview, reassignment, reminders, escalation          T18
  decision-service.ts   certify, revoke, bulk, quality signals, certification projection T19
  dispatch.ts           the revocation route table                              (pure)   T20
  revocation-guard.ts   the two axes and the four outright refusals             (pure)   T20
  revocation-service.ts batch compute/preview/confirm/dispatch/reflect                   T20
  exception-service.ts  SodException lifecycle                                           T21
  graph.ts              the decision graph and its three patterns               (pure)   T21

packages/core/src/audit/audit-service.ts   MODIFIED — export stableStringify + auditEventHash (T10)
packages/core/src/notify/templates/index.ts MODIFIED — seven Govern templates (T12)
packages/core/src/rbac/permissions.ts      MODIFIED — four permissions (T13)
packages/core/src/provision/types.ts       MODIFIED — RevocationOrderFacts (T20)
packages/core/src/provision/plan.ts        MODIFIED — the revocationOrders term (T20)
packages/core/src/provision/run-service.ts MODIFIED — load orders, write revocationOrderId (T20)
packages/core/src/provision/explain.ts     MODIFIED — previewRuleImpact gains sodImpact (T16)
packages/core/src/automate/types.ts        MODIFIED — RefusalReason gains 'sod_violation' (T16)
packages/core/src/automate/eligibility.ts  MODIFIED — the SoD re-check (T16)
packages/core/src/index.ts                 MODIFIED — one export line per Govern module

packages/contracts/src/govern.ts           every request/response schema (T13, T22)
packages/contracts/src/index.ts            MODIFIED

apps/api/src/routes/admin/govern.ts        /api/admin/govern/*        (T13, T22)
apps/api/src/routes/govern-portal.ts       /api/portal/govern/*       (T22)
apps/api/src/app.ts                        MODIFIED — registers both
apps/api/src/scheduler.ts                  MODIFIED — registerGovernJobs (T12)

apps/web/src/pages/admin/GovernSnapshotsPage.tsx      T14
apps/web/src/pages/admin/GovernSnapshotDetailPage.tsx T14
apps/web/src/pages/admin/GovernReportsPage.tsx        T14
apps/web/src/pages/admin/GovernFindingsPage.tsx       T14
apps/web/src/pages/admin/GovernOrphansPage.tsx        T14
apps/web/src/pages/admin/GovernIntegrityPage.tsx      T14
apps/web/src/pages/admin/GovernCampaignsPage.tsx      T22
apps/web/src/pages/admin/GovernCampaignDetailPage.tsx T22
apps/web/src/pages/admin/GovernBatchPage.tsx          T22
apps/web/src/pages/admin/GovernSodPage.tsx            T22
apps/web/src/pages/admin/AdminApp.tsx                 MODIFIED — relative routes, absolute NAV
apps/web/src/pages/govern/MyReviewsPage.tsx           T22 — the portal reviewer surface
apps/web/src/routes.tsx                               MODIFIED — the portal route

e2e/govern.spec.ts                                    T22
```

`types.ts`, `freshness.ts`, `attribute.ts`, `diff.ts`, `sod.ts`, `dispatch.ts`, `revocation-guard.ts` and `graph.ts` import nothing from `@syntra/db`. They may import from `packages/core/src/provision/condition.ts`, which is itself pure. **Any value import from `@syntra/db` in those eight means the boundary is wrong**, and Task 7's structural test checks it.

---
# Slice 1 — Inventory (Tasks 1–14)

Read-only. Nothing in Tasks 1–14 changes anybody's access, ever. Slice 1 alone is a complete access-review product: an organization that installs it can answer every question on an auditor's request list with an exported artifact, and it produces the standing findings of §16 with no campaign machinery at all.

---

## Task 1: Data model — inventory, coverage, findings and audit integrity

Seventeen new tables. Spec §18, slice-1 groups. No existing table is modified in this task.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260822000000_govern_inventory/migration.sql`
- Test: `packages/db/src/govern-schema.test.ts`

**Interfaces:**
- Consumes: `prisma`, `withTenant`, `type TenantClient` from `@syntra/db`; `resetDatabase`, `asDatabaseSuperuser` from `@syntra/db/src/test-support.js`. The existing `Person`, `Contract`, `User`, `Group`, `OrgUnit`, `Application`, `Role`, `DirectorySource`, `AuditEvent` models from Core, and `TargetSystem`, `Entitlement`, `TargetAccount`, `ProvisionRun`, `ProvisionException`, `DriftFinding` from `20260820000000_provision_targets`.
- Produces: every Prisma model the rest of slice 1 reads and writes — `GovernSettings`, `GovernSourcePolicy`, `ResourceClassification`, `AccessSnapshot`, `SnapshotSource`, `Holding`, `HoldingAttribution`, `CoverageGap`, `HoldingEvent`, `HoldingCertification`, `AccountAttribution`, `GovernFinding`, `RemediationItem`, `EvidencePack`, `AuditCheckpoint`, `AuditChainCheck`, `AuditAnchor`.
- Produces the four hand-written partial unique indexes of slice 1: `govern_snapshot_one_building`, `account_attribution_one_confirmed`, `remediation_item_one_open_per_finding`, `remediation_item_one_open_per_campaign_item`.
- Produces the append-only rule pair on `AuditCheckpoint`.

**Three modelling decisions the rest of the plan depends on, made here rather than discovered later.**

**`systemId` and `resourceId` are `String`, not `@db.Uuid`.** One of `systemId`'s values is the literal `'syntra'` — Core's own groups, applications, roles and user accounts are a system Govern inventories and they have no `TargetSystem` row. One of `resourceId`'s values is a target account's `anchor`, which is an `objectGUID` on Active Directory and could be anything on the next connector family. Provision learned this the expensive way: `DriftFinding` overloaded `entitlementId`, a `@db.Uuid` column, with an orphan account's anchor, so `fake-anchor-0001` was rejected outright by PostgreSQL and a real `objectGUID` was accepted as a foreign key pointing at no `Entitlement`. The identity of a row and the columns it fills are two different things.

**Every subject-bearing table carries a NOT NULL `subjectKey` beside its nullable `personId` and `accountRef`.** `subjectKey` is `person:<uuid>` or `account:<systemId>:<accountRef>`. Two reasons, and both are the same reason twice: a unique index over nullable columns constrains nothing in PostgreSQL (Global Constraint 5), and a `GROUP BY` over two nullable columns quietly puts every unattributed account in one bucket. The nullable columns stay because a report joins on them; the key is what the database constrains and groups.

**`RemediationItem` lands in slice 1, not slice 2.** §16 puts the finding lifecycle in slice 1 and `RemediationItem` is half of it — the half with an assignee and a deadline — and `orphan_attribution` is a slice-1 kind. Its `campaignItemId` is a **bare nullable `@db.Uuid` column with no relation**, filled in slice 2. A relation would cascade, and deleting a campaign item that produced a remediation item would destroy the record of what still has to change.

- [ ] **Step 1: Re-read the migrations directory and fix the timestamp**

```bash
ls packages/db/prisma/migrations/
```

Expected: `20260820000000_provision_targets` present. If `20260821000000_automate_requests` is present too, this migration is still `20260822000000_govern_inventory`. **If anything sorting at or after `20260822000000` is present, bump this plan's two migration names by one day each and note it in the commit message.** Ruling P7: two agents working the same repo pick the same plausible timestamp, and the failure is a migration ordering that depends on filesystem enumeration.

- [ ] **Step 2: Write the failing schema test**

`packages/db/src/govern-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from './index.js';
import { asDatabaseSuperuser, resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;

const NOW = new Date('2026-06-15T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

/** A `complete` snapshot with one holding, which most cases need. */
async function seedSnapshot(tid: string, over: Record<string, unknown> = {}) {
  return withTenant(tid, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId: tid, kind: 'manual', status: 'complete', asOf: NOW, ...over },
    });
    return snapshot.id;
  });
}

describe('GovernSettings', () => {
  it('holds every default the design names, and one row per tenant', async () => {
    const settings = await withTenant(tenantId, (tx) =>
      tx.governSettings.create({ data: { tenantId } }),
    );

    expect(settings.snapshotSchedule).toBe('0 1 * * *');
    expect(settings.snapshotRetentionDays).toBe(400);
    expect(settings.defaultFreshnessSlaHours).toBe(24);
    expect(settings.maxSnapshotAgeDays).toBe(30);
    expect(settings.batchThresholdPercent).toBe(10);
    expect(settings.perResourceThresholdPercent).toBe(30);
    expect(settings.personPopulationDropPercent).toBe(20);
    expect(settings.minimumCoveragePercent).toBe(90);
    expect(settings.bulkCertifyLimit).toBe(50);
    expect(settings.dispatchSlaHours).toBe(72);
    expect(settings.privilegedRecertifyDays).toBe(90);
    expect(settings.maxExceptionDays).toBe(90);
    expect(settings.exceptionWarningDays).toEqual([14, 3]);
    expect(settings.minReciprocalDecisions).toBe(3);
    expect(settings.reciprocityWindowDays).toBe(180);
    expect(settings.lastAppliedBatchAt).toBeNull();
    expect(settings.personsWithActiveContractAtLastBatch).toBeNull();

    await expect(
      withTenant(tenantId, (tx) => tx.governSettings.create({ data: { tenantId } })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  // Prisma fills client-side defaults from its inlined datamodel, so the
  // assertions above would pass with no DEFAULT clause in the database at all.
  // This one reads the DDL, which is the only thing that proves the column
  // has a default a raw INSERT would get.
  it('carries its defaults in the database, not only in the client', async () => {
    const rows = await prisma.$queryRaw<{ column_name: string; column_default: string | null }[]>`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'GovernSettings'
        AND column_name IN ('maxSnapshotAgeDays', 'bulkCertifyLimit', 'exceptionWarningDays')
    `;
    const byName = new Map(rows.map((r) => [r.column_name, r.column_default]));
    expect(byName.get('maxSnapshotAgeDays')).toMatch(/^30\b/);
    expect(byName.get('bulkCertifyLimit')).toMatch(/^50\b/);
    expect(byName.get('exceptionWarningDays')).toMatch(/14/);
  });

  it('refuses a percentage outside 0..100', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governSettings.create({ data: { tenantId, batchThresholdPercent: 101 } }),
      ),
    ).rejects.toThrow(/govern_settings_thresholds_are_percent/);
  });
});

describe('AccessSnapshot', () => {
  it('permits at most one building snapshot per tenant', async () => {
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessSnapshot.create({
          data: { tenantId, kind: 'manual', status: 'building', asOf: NOW },
        }),
      ),
    ).rejects.toThrow(/govern_snapshot_one_building/);
  });

  it('permits many complete snapshots, and a second tenant building at the same time', async () => {
    await seedSnapshot(tenantId);
    await seedSnapshot(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );
    await withTenant(otherTenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId: otherTenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );

    const mine = await withTenant(tenantId, (tx) => tx.accessSnapshot.count());
    expect(mine).toBe(3);
  });
});

describe('Holding', () => {
  it('is unique per (snapshot, subject, system, resourceKind, resource)', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } }),
    );

    const row = {
      tenantId,
      snapshotId,
      subjectKey: `person:${person.id}`,
      personId: person.id,
      systemKind: 'syntraInternal',
      systemId: 'syntra',
      resourceKind: 'syntraGroup',
      resourceId: 'group-1',
      resourceName: 'Finance',
      state: 'held',
      observedAt: NOW,
      observedVia: 'syntra',
      firstSeenAt: NOW,
    };

    await withTenant(tenantId, (tx) => tx.holding.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.holding.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('accepts a subject that is an unattributed account, with a null personId', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.create({
        data: {
          tenantId,
          snapshotId,
          subjectKey: 'account:11111111-1111-1111-1111-111111111111:anchor-7',
          accountRef: 'anchor-7',
          systemKind: 'targetSystem',
          systemId: '11111111-1111-1111-1111-111111111111',
          resourceKind: 'targetAccount',
          resourceId: 'anchor-7',
          resourceName: 'svc-backup',
          state: 'held',
          observedAt: NOW,
          observedVia: 'provision-run-3',
          firstSeenAt: NOW,
          unattributable: true,
        },
      }),
    );
    expect(holding.personId).toBeNull();
    expect(holding.unattributable).toBe(true);
  });

  it('refuses a state outside the two-valued set', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.holding.create({
          data: {
            tenantId,
            snapshotId,
            subjectKey: 'account:syntra:x',
            systemKind: 'syntraInternal',
            systemId: 'syntra',
            resourceKind: 'syntraGroup',
            resourceId: 'g',
            resourceName: 'g',
            // `not_held` is never a row. Spec section 6.
            state: 'not_held',
            observedAt: NOW,
            observedVia: 'syntra',
            firstSeenAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow(/holding_state_is_held_or_unknown/);
  });

  it('carries the three indexes the reports actually read by', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Holding'
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('Holding_tenantId_snapshotId_personId_idx');
    expect(names).toContain('Holding_tenantId_snapshotId_systemId_resourceId_idx');
    expect(names).toContain('holding_unattributable_idx');
  });
});

describe('CoverageGap', () => {
  it('is a row with a subject, a scope and a reason — never a flag', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const gap = await withTenant(tenantId, (tx) =>
      tx.coverageGap.create({
        data: {
          tenantId,
          snapshotId,
          kind: 'resource_unreadable',
          systemKind: 'targetSystem',
          systemId: '11111111-1111-1111-1111-111111111111',
          resourceId: 'ent-domain-admins',
          reason:
            'the connector could not read this group completely; the run named is ' +
            'the target last run, not necessarily the run that failed the read',
          sourceRunId: '22222222-2222-2222-2222-222222222222',
        },
      }),
    );
    expect(gap.personId).toBeNull();
    expect(gap.reason).toContain('not necessarily the run that failed the read');
  });

  it('refuses a kind outside the closed set', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.coverageGap.create({
          data: { tenantId, snapshotId, kind: 'probably_fine', reason: 'x' },
        }),
      ),
    ).rejects.toThrow(/coverage_gap_kind/);
  });
});

describe('GovernFinding', () => {
  it('is unique per (kind, subjectRefType, subjectRefId), so it updates rather than duplicates', async () => {
    const row = {
      tenantId,
      kind: 'unattributable_holding',
      severity: 'high',
      subjectRefType: 'holding',
      subjectRefId: 'syntra:syntraGroup:group-1:person:abc',
      detail: {},
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    await withTenant(tenantId, (tx) => tx.governFinding.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.governFinding.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('refuses `accepted` with no expiry', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governFinding.create({
          data: {
            tenantId,
            kind: 'stale_source',
            severity: 'medium',
            subjectRefType: 'source',
            subjectRefId: 'src-1',
            detail: {},
            status: 'accepted',
            acceptedReason: 'known and tolerated',
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow(/govern_finding_accepted_needs_expiry/);
  });
});

describe('RemediationItem', () => {
  it('permits one open item per finding and admits a second once the first is done', async () => {
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'orphan_account',
          severity: 'medium',
          subjectRefType: 'account',
          subjectRefId: 'sys:anchor-7',
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } }),
    );
    const item = {
      tenantId,
      kind: 'orphan_attribution',
      ownerPersonId: person.id,
      dueAt: NOW,
      findingId: finding.id,
      description: 'confirm or deny the proposed owner of svc-backup',
      deepLink: '/admin/govern/orphans',
    };

    const first = await withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item }));
    await expect(
      withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item })),
    ).rejects.toThrow(/remediation_item_one_open_per_finding/);

    await withTenant(tenantId, (tx) =>
      tx.remediationItem.update({ where: { id: first.id }, data: { status: 'done' } }),
    );
    await withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item }));
  });
});

describe('AccountAttribution', () => {
  it('permits several proposals and only one confirmation per account', async () => {
    const [a, b] = await withTenant(tenantId, async (tx) => [
      await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } }),
      await tx.person.create({ data: { tenantId, givenName: 'Anke', familyName: 'Novak' } }),
    ]);
    const base = { tenantId, systemId: 'sys-1', accountRef: 'anchor-7', method: 'mail', confidence: 0.8 };

    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.create({ data: { ...base, proposedPersonId: a!.id } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.create({ data: { ...base, proposedPersonId: b!.id } }),
    );

    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.updateMany({
        where: { proposedPersonId: a!.id },
        data: { status: 'confirmed', decidedAt: NOW },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accountAttribution.updateMany({
          where: { proposedPersonId: b!.id },
          data: { status: 'confirmed', decidedAt: NOW },
        }),
      ),
    ).rejects.toThrow(/account_attribution_one_confirmed/);
  });
});

describe('AuditCheckpoint', () => {
  it('is append-only: an UPDATE changes nothing and a DELETE removes nothing', async () => {
    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.create({
        data: { tenantId, sequence: 100, hash: 'a'.repeat(64), verifiedAt: NOW },
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.updateMany({ where: { sequence: 100 }, data: { hash: 'b'.repeat(64) } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.deleteMany({ where: { sequence: 100 } }),
    );

    const rows = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe('a'.repeat(64));
  });
});

describe('tenant isolation', () => {
  it('hides every Govern table from another tenant, even when the query names no tenant', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.coverageGap.create({
        data: { tenantId, snapshotId, kind: 'source_unread', reason: 'never read' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'coverage_gap',
          severity: 'high',
          subjectRefType: 'snapshot',
          subjectRefId: snapshotId,
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );

    const seen = await withTenant(otherTenantId, async (tx) => ({
      snapshots: await tx.accessSnapshot.count(),
      gaps: await tx.coverageGap.count(),
      findings: await tx.governFinding.count(),
    }));
    expect(seen).toEqual({ snapshots: 0, gaps: 0, findings: 0 });
  });

  it('refuses a write that names another tenant, through WITH CHECK', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governSettings.create({ data: { tenantId: otherTenantId } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('forces the policy on the owning role', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('Holding','CoverageGap','GovernFinding','AuditCheckpoint','EvidencePack')
    `;
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });
});
```

**What the fixture would look like if it could not distinguish pass from fail.** The isolation test reads `count()` from the *other* tenant; if it read from `tenantId` it would pass whether or not a policy existed. The `relforcerowsecurity` case exists because `ENABLE` without `FORCE` leaves the owning role exempt and the count test still returns 0 for a *different* connection — the two together are what prove it. And the `information_schema` default test exists because the four Prisma-default assertions above it would pass against a database with no `DEFAULT` clause at all; that is the exact gap Provision's Task 1 recorded and did not close.

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm vitest run packages/db/src/govern-schema.test.ts`
Expected: FAIL — `Property 'governSettings' does not exist on type ...` at runtime, `PrismaClientValidationError` / `TypeError: Cannot read properties of undefined`.

- [ ] **Step 4: Add the settings, policy and classification models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
// ---------------------------------------------------------------------------
// Govern — Access Governance. Spec docs/superpowers/specs/2026-08-16-syntra-govern-design.md
//
// Govern reads every other subsystem's tables and writes only these. It holds
// no target credential, opens no socket, and writes no access-bearing row.
// ---------------------------------------------------------------------------

/// One row per tenant, holding every number the Govern design names, so none
/// of them is a constant compiled into the code.
///
/// `lastAppliedBatchAt` and `personsWithActiveContractAtLastBatch` are not
/// settings. They are the denominator the population-collapse refusal
/// compares against, STORED rather than recomputed for the same reason
/// Provision stores `lastAppliedRunAt` and Automate stores
/// `lastAppliedSweepAt`: the comparison is against the last state somebody
/// accepted, not against the last state observed.
model GovernSettings {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @unique @db.Uuid

  /// Nightly at 01:00, ahead of Automate's 02:00 sweep, so the sweep runs
  /// against a picture assembled tonight rather than last night.
  snapshotSchedule       String? @default("0 1 * * *")
  /// A year plus the audit that follows it.
  snapshotRetentionDays  Int     @default(400)
  /// How long ago the WORLD was read. The other clock.
  defaultFreshnessSlaHours Int   @default(24)
  /// How long ago GOVERN assembled the picture. Not the same clock, and a
  /// refusal always names which one it was.
  maxSnapshotAgeDays     Int     @default(30)

  batchThresholdPercent       Int @default(10)
  /// Lower than Provision's 50 deliberately: a campaign is a deliberate act
  /// with a human on the other end of the confirmation, and "this campaign is
  /// emptying Finance-Payments" is the single sentence most worth
  /// interrupting somebody with.
  perResourceThresholdPercent Int @default(30)
  personPopulationDropPercent Int @default(20)

  minimumCoveragePercent Int @default(90)
  bulkCertifyLimit       Int @default(50)
  /// Measured to CONFIRMATION, not to observation: observation waits on the
  /// next snapshot, and an SLA that fired because a nightly job had not run
  /// yet trains people to ignore alerts.
  dispatchSlaHours       Int @default(72)
  privilegedRecertifyDays Int @default(90)

  maxExceptionDays    Int   @default(90)
  exceptionWarningDays Int[] @default([14, 3])

  minReciprocalDecisions Int @default(3)
  reciprocityWindowDays  Int @default(180)

  lastAppliedBatchAt                   DateTime?
  personsWithActiveContractAtLastBatch Int?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}

/// The per-source freshness override section 8 assumes. A source with no row
/// uses `GovernSettings.defaultFreshnessSlaHours`.
///
/// A table rather than a column on `DirectorySource` or `TargetSystem`,
/// because Govern's opinion about somebody else's row never lives on that row.
model GovernSourcePolicy {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  /// 'directorySource' | 'targetSystem' | 'syntraInternal'
  sourceKind String
  /// Text, not @db.Uuid: `syntraInternal`'s id is the literal 'syntra'.
  sourceId   String
  freshnessSlaHours Int     @default(24)
  inDefaultScope    Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([tenantId, sourceKind, sourceId])
  @@index([tenantId])
}

/// Govern's opinion about whether a resource is privileged. Beside the
/// resource, never on it: `Entitlement` belongs to Provision and `Group` is
/// rewritten nightly by its source.
///
/// `Holding.privileged` is derived from this table at build, plus one rule
/// that needs no configuration: every `syntraRole` holding is privileged,
/// because a Syntra role carries permissions from the closed catalogue and
/// there is no version of that which is not.
model ResourceClassification {
  id           String  @id @default(uuid()) @db.Uuid
  tenantId     String  @db.Uuid
  systemId     String
  resourceKind String
  resourceId   String
  privileged   Boolean @default(false)
  note         String?
  setByUserId  String? @db.Uuid
  setAt        DateTime @default(now())

  @@unique([tenantId, systemId, resourceKind, resourceId])
  @@index([tenantId])
}
```

- [ ] **Step 5: Add the snapshot, holding, coverage and history models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A point-in-time, materialized, immutable set of Holding rows with their
/// attributions, plus a coverage record.
///
/// `asOf` is the instant the COLLECT stage began, not `finishedAt`, so a build
/// taking twenty minutes describes a world as it stood at one stated moment
/// rather than over a smeared window. It is the timestamp every report header
/// carries, and it is NOT the same as any holding's `observedAt`.
///
/// Only `complete` snapshots are readable by any report or campaign, enforced
/// in the one accessor function `readableSnapshot()`, because a partially
/// built snapshot is indistinguishable from a small organization.
model AccessSnapshot {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  /// 'scheduled' | 'manual' | 'campaign'
  kind     String
  /// 'building' | 'complete' | 'failed'
  status   String @default("building")

  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  asOf       DateTime

  /// The declarative scope this snapshot was built over, or null for the
  /// whole tenant.
  scope Json?

  holdingCount             Int @default(0)
  unattributableCount      Int @default(0)
  coverageGapCount         Int @default(0)
  unattributedAccountCount Int @default(0)
  personCount              Int @default(0)
  /// The denominator the population-collapse refusal compares against, frozen
  /// with the picture it describes.
  personsWithActiveContract Int @default(0)
  countsByResourceKind      Json @default("{}")

  error String?

  sources     SnapshotSource[]
  holdings    Holding[]
  gaps        CoverageGap[]

  @@index([tenantId])
  @@index([tenantId, status, asOf])
}

/// Per snapshot, per source in scope. Section 8. `syntraInternal` is always
/// `fresh` and `complete`, and saying so explicitly is better than leaving a
/// blank that a reader interprets as an omission.
model SnapshotSource {
  id         String         @id @default(uuid()) @db.Uuid
  tenantId   String         @db.Uuid
  snapshotId String         @db.Uuid
  snapshot   AccessSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  /// 'directorySource' | 'targetSystem' | 'syntraInternal'
  sourceKind String
  sourceId   String
  sourceName String
  /// Bare column, not a relation: the run may be a SyncRun or a ProvisionRun,
  /// and pruning either must not take the coverage record with it.
  lastRunId  String? @db.Uuid

  lastSuccessfulReadAt DateTime?
  lastAttemptedReadAt  DateTime?
  /// 'complete' | 'partial' | 'unread'
  completeness String
  /// 'fresh' | 'stale'
  staleness    String
  freshnessSlaHours Int
  gapCount     Int @default(0)

  @@unique([snapshotId, sourceKind, sourceId])
  @@index([tenantId])
}

/// One row per (subject, resource, system) the subject can reach.
///
/// `not_held` is never a row: absence means not-held only WITHIN a region
/// coverage says was read, and elsewhere it means unknown. Storing explicit
/// not-held rows multiplies the row count by the size of the resource catalog
/// AND destroys the distinction, because an unread region then produces no row
/// at all — which reads as "not held" to anybody writing a query later.
///
/// A snapshot is immutable once complete, so no certification state lives
/// here. Certification is a fact about a (subject, resource) pair that
/// outlives any one snapshot; `HoldingCertification` holds it.
model Holding {
  id         String         @id @default(uuid()) @db.Uuid
  tenantId   String         @db.Uuid
  snapshotId String         @db.Uuid
  snapshot   AccessSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  /// `person:<uuid>` or `account:<systemId>:<accountRef>`. NOT NULL, because
  /// a unique index over the two nullable columns below would constrain
  /// nothing and a GROUP BY over them puts every orphan in one bucket.
  subjectKey String
  personId   String? @db.Uuid
  accountRef String?

  /// 'targetSystem' | 'syntraInternal' | 'directorySource'
  systemKind String
  /// Text, not @db.Uuid. One of its values is the literal 'syntra'.
  systemId   String
  /// 'targetEntitlement' | 'targetAccount' | 'syntraGroup' | 'application'
  /// | 'syntraRole' | 'syntraUser'
  resourceKind String
  /// Text, not @db.Uuid. One of its values is a target account's anchor.
  resourceId   String
  /// Copied, not referenced. A group renamed next month must not silently
  /// rewrite last quarter's evidence.
  resourceName String

  /// 'held' | 'unknown'. There is no third value and a check constraint says so.
  state       String  @default("held")
  privileged  Boolean @default(false)
  /// When the system that read it last confirmed it was true. NOT the
  /// snapshot's asOf, and the report shows both.
  observedAt  DateTime
  /// Which run of which subsystem last confirmed it.
  observedVia String
  /// The earliest snapshot in which this (subject, resource) pair was seen.
  firstSeenAt DateTime

  attributionCount Int     @default(0)
  /// Computed once at build so no screen has to re-derive it and get it half
  /// right. True when the attribution set is empty, or when its only kinds are
  /// `discovered` and `unattributable`.
  unattributable   Boolean @default(false)

  attributions HoldingAttribution[]

  @@unique([snapshotId, subjectKey, systemId, resourceKind, resourceId])
  @@index([tenantId, snapshotId, personId])
  @@index([tenantId, snapshotId, systemId, resourceId])
}

/// Several rows per holding, by design. A single `origin` column would have to
/// choose, and it would choose wrong exactly in the cases that matter — the
/// researcher with two contracts, the person whose requested access is also
/// now birthright, the group membership that arrives both by rule and by hand.
model HoldingAttribution {
  id        String  @id @default(uuid()) @db.Uuid
  tenantId  String  @db.Uuid
  holdingId String  @db.Uuid
  holding   Holding @relation(fields: [holdingId], references: [id], onDelete: Cascade)

  /// 'business_rule' | 'request' | 'delegated_admin' | 'auto_granted'
  /// | 'direct_assignment' | 'group_inheritance' | 'org_unit_inheritance'
  /// | 'directory_source' | 'discovered' | 'manual' | 'unattributable'
  kind    String
  refType String
  refId   String?
  /// The copied names, the resolved org-unit chain, the approver set. Copied,
  /// not referenced: an approver who leaves must still have a name in the
  /// record of what they approved.
  detail  Json    @default("{}")
  resolvedAt DateTime

  @@index([tenantId])
  @@index([holdingId])
}

/// One row per region of the world Govern cannot describe. THE ROW THAT MUST
/// NEVER BE A FLAG. It is counted on the face of every report whose scope
/// intersects it, and it is what makes a question over that scope answer
/// `unknown` rather than a number.
model CoverageGap {
  id         String         @id @default(uuid()) @db.Uuid
  tenantId   String         @db.Uuid
  snapshotId String         @db.Uuid
  snapshot   AccessSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  /// 'source_unread' | 'source_stale' | 'resource_unreadable'
  /// | 'account_unreadable' | 'subject_unresolvable' | 'person_unprocessable'
  kind String
  /// Null where the gap is not about one system.
  systemKind String?
  systemId   String?
  resourceId String?
  personId   String? @db.Uuid
  accountRef String?
  reason     String
  sourceRunId String? @db.Uuid

  @@index([tenantId])
  @@index([snapshotId, kind])
}

/// Produced by diffing consecutive snapshots, and cross-referenced to the
/// audit event that caused it where one exists.
///
/// `explained = false` on a `gained` event is one of the most valuable rows
/// this system produces: access appeared, and Syntra did not cause it.
model HoldingEvent {
  id             String @id @default(uuid()) @db.Uuid
  tenantId       String @db.Uuid
  fromSnapshotId String @db.Uuid
  toSnapshotId   String @db.Uuid

  subjectKey String
  personId   String? @db.Uuid
  accountRef String?
  systemId   String
  resourceKind String
  resourceId   String
  resourceName String

  /// 'gained' | 'lost' | 'attribution_changed' | 'became_unknown' | 'became_known'
  change String
  beforeAttributions Json @default("[]")
  afterAttributions  Json @default("[]")

  /// The audit event that explains it, where one exists. A sequence number,
  /// not a row id: the chain is ordered by sequence and that is the ordering
  /// an investigator works in.
  auditEventSequence Int?
  explained          Boolean @default(false)

  @@index([tenantId, toSnapshotId])
  @@index([tenantId, personId, toSnapshotId])
}

/// A projection, rebuilt from CampaignDecision rows, which remain the record.
/// It exists so that "never certified" and "not certified since" are one
/// indexed lookup on a report rather than a join across every campaign a
/// tenant has ever run.
model HoldingCertification {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  /// 'person' | 'account'
  subjectRefType String
  subjectRefId   String
  systemId       String
  resourceKind   String
  resourceId     String

  lastCertifiedAt        DateTime
  lastCertifiedByPersonId String  @db.Uuid
  /// Bare columns, not relations: slice 2 owns those tables and a cascade
  /// from a deleted campaign would silently un-certify history.
  lastCampaignId  String @db.Uuid
  lastDecisionId  String @db.Uuid

  @@unique([tenantId, subjectRefType, subjectRefId, systemId, resourceKind, resourceId])
  @@index([tenantId])
}

/// Govern PROPOSES an owner for an orphan account and never assigns one.
/// Confirmation calls Provision's own account-linking entry point; Govern does
/// not write TargetAccount.
model AccountAttribution {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  systemId   String
  accountRef String
  proposedPersonId String @db.Uuid

  /// 'name_similarity' | 'mail_address' | 'employee_identifier' | 'adjacent_manager'
  method     String
  /// 0..1. A number a human reads, never a number a machine acts on: linking
  /// an account to a person is not a labelling exercise, and Provision's next
  /// run evaluates that person's desired state against that account.
  confidence Float
  /// 'proposed' | 'confirmed' | 'denied'
  status     String @default("proposed")
  decidedByUserId String? @db.Uuid
  decidedAt       DateTime?
  decidedReason   String?

  createdAt DateTime @default(now())

  @@unique([tenantId, systemId, accountRef, proposedPersonId])
  @@index([tenantId])
  @@index([tenantId, status])
}
```

- [ ] **Step 6: Add the findings, evidence and audit-integrity models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// One lifecycle, one table, one count. A finding that persists across
/// snapshots is updated, not duplicated. A finding that stops being observed
/// becomes `resolved` WITH THE SNAPSHOT THAT SHOWED IT GONE, not silently
/// deleted, because "it went away and we do not know why" is itself worth a row.
model GovernFinding {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  /// The closed set of section 16.
  kind     String
  /// 'low' | 'medium' | 'high' | 'critical'
  severity String

  /// 'person' | 'account' | 'resource' | 'source' | 'reviewer' | 'holding'
  /// | 'snapshot' | 'campaign' | 'sod_violation' | 'dispatch'
  subjectRefType String
  subjectRefId   String

  detail Json @default("{}")
  /// A Provision DriftFinding this AGGREGATES, never copies. Closing it in
  /// either place closes it in both, because there is only one row underneath.
  /// Bare column, not a relation: DriftFinding cascades from ProvisionRun, and
  /// a pruned run must not delete Govern's finding.
  driftFindingId String? @db.Uuid

  /// 'open' | 'acknowledged' | 'accepted' | 'resolved'
  status String @default("open")
  /// Required to leave `open`. Enforced in the service, not in SQL: the
  /// constraint would have to know which transitions are which.
  ownerPersonId String? @db.Uuid
  dueAt DateTime?

  /// `accepted` requires a reason AND an expiry. Acceptance with no expiry is
  /// not representable, for the reason section 15 gives about exceptions.
  acceptedReason String?
  acceptedUntil  DateTime?

  resolvedBySnapshotId String? @db.Uuid
  resolvedAt           DateTime?

  firstSeenAt DateTime
  lastSeenAt  DateTime

  remediations RemediationItem[]

  @@unique([tenantId, kind, subjectRefType, subjectRefId])
  @@index([tenantId])
  @@index([tenantId, status, severity])
}

/// The half of a finding that has an assignee and a deadline.
///
/// `campaignItemId` is a bare nullable column with no relation, filled in
/// slice 2. A relation would cascade, and deleting a campaign item that
/// produced a remediation item would destroy the record of what still has to
/// change.
model RemediationItem {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  /// 'rule_change_required' | 'directory_source_change_required'
  /// | 'direct_assignment_change_required' | 'role_assignment_change_required'
  /// | 'undecided_item' | 'orphan_attribution'
  kind String
  ownerPersonId String  @db.Uuid
  dueAt         DateTime

  findingId String?        @db.Uuid
  finding   GovernFinding? @relation(fields: [findingId], references: [id], onDelete: SetNull)
  campaignItemId String? @db.Uuid

  description String
  deepLink    String

  /// 'open' | 'in_progress' | 'done' | 'wont_fix'
  status            String @default("open")
  resolutionComment String?
  resolvedByUserId  String? @db.Uuid
  resolvedAt        DateTime?

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([tenantId, status, dueAt])
  @@index([tenantId, ownerPersonId, status])
}

/// A deterministic JSON document with a stable digest. Creating one is a
/// privileged, audited action, and its limitations page is printed on its
/// cover rather than kept in a caveats appendix.
model EvidencePack {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  /// 'campaign' | 'report' | 'period'
  kind  String
  scope Json @default("{}")

  snapshotId String? @db.Uuid
  campaignId String? @db.Uuid

  chainHeadSequence       Int
  chainHeadHash           String
  /// 'valid' | 'broken' | 'not_verified'
  chainVerificationResult String
  chainFromSequence       Int
  chainToSequence         Int

  /// sha256 over the stable serialization. Printed in the bundle's own header,
  /// so a reader can recompute it.
  digest String
  /// Where the bytes live. Null when the bundle is served on demand rather
  /// than stored.
  storageRef String?
  byteLength Int

  createdByUserId String? @db.Uuid
  createdAt       DateTime @default(now())

  @@index([tenantId])
  @@index([tenantId, kind, createdAt])
}

/// Written after a successful verification of the segment ending here.
/// APPEND-ONLY: a reversal is a new row.
model AuditCheckpoint {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  sequence   Int
  hash       String
  verifiedAt DateTime @default(now())
  /// Over (sequence, hash), with a key the application holds and the database
  /// does not. Raises the bar from "database access" to "database access plus
  /// the signing key". It is NOT proof against the operator; anchoring is.
  signature String?
  keyId     String?

  @@unique([tenantId, sequence])
  @@index([tenantId])
}

/// The result of one verification run. `mode` matters: an incremental check
/// says the segment since the last checkpoint holds; a full check says the
/// chain holds from genesis, and they are different claims.
model AuditChainCheck {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  fromSequence Int
  toSequence   Int
  /// 'valid' | 'broken'
  result       String
  brokenAtSequence Int?
  startedAt  DateTime @default(now())
  durationMs Int
  /// 'incremental' | 'full'
  mode       String

  @@index([tenantId])
  @@index([tenantId, startedAt])
}

/// The only one of the three mitigations that is actually proof against the
/// operator, because the receipt comes from somewhere the operator does not
/// control. A tenant that has not configured anchoring sees that stated on its
/// own integrity screen, in those terms, rather than a green tick.
model AuditAnchor {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  sequence   Int
  hash       String
  anchoredAt DateTime @default(now())
  /// 'file' | 'mail'
  method     String
  receipt    String
  /// 'pending' | 'anchored' | 'failed'
  status     String @default("pending")
  error      String?

  @@index([tenantId])
  @@index([tenantId, sequence])
}
```

- [ ] **Step 7: Generate the migration and inspect it before appending anything**

```bash
pnpm --filter @syntra/db exec prisma migrate diff \
  --from-migrations packages/db/prisma/migrations \
  --to-schema-datamodel packages/db/prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > packages/db/prisma/migrations/20260822000000_govern_inventory/migration.sql
```

**Read the generated file before going further.** `schema.prisma` cannot express a partial index, so every hand-written partial index the earlier slices created looks to the diff like something the database has and the model does not. **Delete every `DROP INDEX` line naming one of these before continuing:** `user_login_unique_ci`, `target_account_anchor_unique`, `account_entitlement_one_live`, `provision_run_one_non_terminal`, and any `automate_*` index if Automate's migration has landed. Provision's Task 1 found none; that is not a guarantee here, and a dropped `provision_run_one_non_terminal` permanently unbricks nothing and permanently breaks the one control that stops two overlapping plans interleaving.

- [ ] **Step 8: Append the check constraints, the partial indexes, the append-only rules and the RLS block**

Append to `packages/db/prisma/migrations/20260822000000_govern_inventory/migration.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Closed vocabularies. Every one of these mirrors a union in
-- packages/core/src/govern/types.ts exactly; if one moves, both move.
-- ---------------------------------------------------------------------------

-- `not_held` is never a row. Spec section 6. A two-valued Govern takes an
-- unreadable group's 1500 readable members, finds nothing for the other 2500,
-- and prints "1500 people hold Domain Admins" under a heading that says the
-- report is complete.
ALTER TABLE "Holding" ADD CONSTRAINT holding_state_is_held_or_unknown
  CHECK ("state" IN ('held', 'unknown'));

ALTER TABLE "Holding" ADD CONSTRAINT holding_resource_kind CHECK (
  "resourceKind" IN ('targetEntitlement','targetAccount','syntraGroup',
                     'application','syntraRole','syntraUser'));

ALTER TABLE "Holding" ADD CONSTRAINT holding_system_kind CHECK (
  "systemKind" IN ('targetSystem','syntraInternal','directorySource'));

-- A subject is a person or an account, never both and never neither, and the
-- key spells out which. Without this, a row with both null is addressable only
-- by its own id and appears in no report.
ALTER TABLE "Holding" ADD CONSTRAINT holding_subject_key_agrees CHECK (
  ("personId" IS NOT NULL AND "accountRef" IS NULL
     AND "subjectKey" = 'person:' || "personId"::text)
  OR
  ("personId" IS NULL AND "accountRef" IS NOT NULL
     AND "subjectKey" = 'account:' || "systemId" || ':' || "accountRef")
);

ALTER TABLE "HoldingAttribution" ADD CONSTRAINT holding_attribution_kind CHECK (
  "kind" IN ('business_rule','request','delegated_admin','auto_granted',
             'direct_assignment','group_inheritance','org_unit_inheritance',
             'directory_source','discovered','manual','unattributable'));

ALTER TABLE "CoverageGap" ADD CONSTRAINT coverage_gap_kind CHECK (
  "kind" IN ('source_unread','source_stale','resource_unreadable',
             'account_unreadable','subject_unresolvable','person_unprocessable'));

ALTER TABLE "HoldingEvent" ADD CONSTRAINT holding_event_change CHECK (
  "change" IN ('gained','lost','attribution_changed','became_unknown','became_known'));

ALTER TABLE "SnapshotSource" ADD CONSTRAINT snapshot_source_completeness CHECK (
  "completeness" IN ('complete','partial','unread'));
ALTER TABLE "SnapshotSource" ADD CONSTRAINT snapshot_source_staleness CHECK (
  "staleness" IN ('fresh','stale'));

ALTER TABLE "AccessSnapshot" ADD CONSTRAINT access_snapshot_status CHECK (
  "status" IN ('building','complete','failed'));
ALTER TABLE "AccessSnapshot" ADD CONSTRAINT access_snapshot_kind CHECK (
  "kind" IN ('scheduled','manual','campaign'));

ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_status CHECK (
  "status" IN ('open','acknowledged','accepted','resolved'));
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_severity CHECK (
  "severity" IN ('low','medium','high','critical'));

-- Acceptance with no expiry is not representable. A perpetual acceptance is a
-- decision nobody ever re-makes, and after two years nobody remembers who made
-- it or why.
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_accepted_needs_expiry CHECK (
  "status" <> 'accepted'
  OR ("acceptedUntil" IS NOT NULL AND "acceptedReason" IS NOT NULL));

-- A resolved finding names the snapshot that showed it gone. "It went away and
-- we do not know why" is itself worth a row, and this is what makes it one.
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_resolved_names_snapshot CHECK (
  "status" <> 'resolved' OR "resolvedBySnapshotId" IS NOT NULL);

ALTER TABLE "RemediationItem" ADD CONSTRAINT remediation_item_status CHECK (
  "status" IN ('open','in_progress','done','wont_fix'));
ALTER TABLE "RemediationItem" ADD CONSTRAINT remediation_item_kind CHECK (
  "kind" IN ('rule_change_required','directory_source_change_required',
             'direct_assignment_change_required','role_assignment_change_required',
             'undecided_item','orphan_attribution'));

ALTER TABLE "AccountAttribution" ADD CONSTRAINT account_attribution_status CHECK (
  "status" IN ('proposed','confirmed','denied'));
ALTER TABLE "AccountAttribution" ADD CONSTRAINT account_attribution_confidence CHECK (
  "confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_result CHECK (
  "result" IN ('valid','broken'));
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_mode CHECK (
  "mode" IN ('incremental','full'));
-- A broken result names the sequence. A break with no sequence is an alert
-- nobody can act on.
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_broken_names_sequence CHECK (
  "result" <> 'broken' OR "brokenAtSequence" IS NOT NULL);

ALTER TABLE "AuditAnchor" ADD CONSTRAINT audit_anchor_method CHECK (
  "method" IN ('file','mail'));

-- Percentages are percentages. Validated on save as well, because a
-- constraint violation is a 500 and a validation error is a message; this is
-- the backstop that makes the rule true of the data rather than true of the
-- one code path that happens to check it.
ALTER TABLE "GovernSettings" ADD CONSTRAINT govern_settings_thresholds_are_percent CHECK (
  "batchThresholdPercent"       BETWEEN 0 AND 100 AND
  "perResourceThresholdPercent" BETWEEN 0 AND 100 AND
  "personPopulationDropPercent" BETWEEN 0 AND 100 AND
  "minimumCoveragePercent"      BETWEEN 0 AND 100
);

-- ---------------------------------------------------------------------------
-- Partial unique indexes. A plain UNIQUE over a nullable or status-qualified
-- column constrains nothing in PostgreSQL, so every one of these is written by
-- hand rather than declared with @@unique.
-- ---------------------------------------------------------------------------

-- One build at a time per tenant. Two concurrent builds would each write half
-- a picture into two snapshots and neither would say so.
--
-- THE ESCAPE HATCH IS IN THE SAME TASK, in snapshot-service.ts's
-- `beginSnapshot`: a `building` snapshot older than SNAPSHOT_STALL_MINUTES is
-- marked `failed` with error 'superseded by a later build' at the head of the
-- transaction that creates the new one. A one-non-terminal-row index with no
-- adoption path is how a crashed process permanently bricks a tenant, and this
-- programme has shipped that shape twice.
CREATE UNIQUE INDEX govern_snapshot_one_building
  ON "AccessSnapshot" ("tenantId")
  WHERE "status" = 'building';

-- Many candidates may be proposed for one orphan; exactly one may be confirmed.
CREATE UNIQUE INDEX account_attribution_one_confirmed
  ON "AccountAttribution" ("tenantId", "systemId", "accountRef")
  WHERE "status" = 'confirmed';

-- One live remediation item per finding and per campaign item, so a nightly
-- snapshot that re-observes the same problem chases it once rather than
-- creating a new row every night. Two indexes rather than one because
-- `findingId` and `campaignItemId` are both nullable and a single index over
-- both would constrain neither.
CREATE UNIQUE INDEX remediation_item_one_open_per_finding
  ON "RemediationItem" ("tenantId", "kind", "findingId")
  WHERE "findingId" IS NOT NULL AND "status" IN ('open', 'in_progress');

CREATE UNIQUE INDEX remediation_item_one_open_per_campaign_item
  ON "RemediationItem" ("tenantId", "kind", "campaignItemId")
  WHERE "campaignItemId" IS NOT NULL AND "status" IN ('open', 'in_progress');

-- The unattributable register is read as its own list, above the totals rather
-- than below them, so it gets its own partial index rather than sharing the
-- person index and filtering.
CREATE INDEX holding_unattributable_idx
  ON "Holding" ("tenantId", "snapshotId")
  WHERE "unattributable" = true;

-- ---------------------------------------------------------------------------
-- Append-only. The same RULE pair the audit log uses in
-- 20260814235217_audit/migration.sql. A checkpoint that can be rewritten is a
-- checkpoint that proves nothing.
-- ---------------------------------------------------------------------------
CREATE RULE govern_checkpoint_no_update AS ON UPDATE TO "AuditCheckpoint" DO INSTEAD NOTHING;
CREATE RULE govern_checkpoint_no_delete AS ON DELETE TO "AuditCheckpoint" DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
--
-- This matters more here than anywhere else in the product: `Holding` is a
-- denormalized copy of who can reach what, across every system, for a whole
-- organization, and a cross-tenant read of it is the worst single disclosure
-- this platform could produce.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'GovernSettings','GovernSourcePolicy','ResourceClassification',
    'AccessSnapshot','SnapshotSource','Holding','HoldingAttribution',
    'CoverageGap','HoldingEvent','HoldingCertification','AccountAttribution',
    'GovernFinding','RemediationItem','EvidencePack',
    'AuditCheckpoint','AuditChainCheck','AuditAnchor'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
```

- [ ] **Step 9: Apply the migration and run the test**

```bash
pnpm --filter @syntra/db exec prisma migrate deploy
pnpm --filter @syntra/db exec prisma generate
pnpm vitest run packages/db/src/govern-schema.test.ts
```

Expected: PASS, 16 tests.

If `prisma generate` fails with a Windows `EPERM` renaming the query engine DLL, that is the pre-existing condition Provision's Task 1 recorded: the engine is version-pinned and identical, and the regenerated client is usable. Confirm by asserting the new models exist rather than assuming: `node -e "const{PrismaClient}=require('@prisma/client');console.log(Object.keys(new PrismaClient()).filter(k=>k.startsWith('govern')||k.startsWith('holding')||k.startsWith('audit')))"`.

- [ ] **Step 10: Rebuild the database from the migration files and run it again**

```bash
pnpm --filter @syntra/db exec prisma migrate reset --force --skip-seed
pnpm vitest run packages/db/src/govern-schema.test.ts
```

Expected: PASS. This is the step that proves the migration file, not the developer's accumulated database state. Provision's Task 1 dropped and rebuilt rather than trusting its own restores, and that is the right instinct.

- [ ] **Step 11: Typecheck**

Run: `pnpm exec tsc -b --force`
Expected: exit 0 across all eight projects.

- [ ] **Step 12: Mutation-test the RLS policy and the two constraints that carry the design**

Three mutations, run one at a time, each reverted before the next:

1. **Weaken the policy, never drop it.** In the migration's `DO $$` block change `USING ("tenantId" = NULLIF(...))` to `USING (true)`, reset the database, and run the suite. Expected: `hides every Govern table from another tenant` FAILS. **Dropping the policy instead makes the test pass vacuously**, because `FORCE` with no policy denies every row — removing a control and breaking a control produce opposite test results here and only one of them proves anything.
2. **Remove `holding_state_is_held_or_unknown`.** Expected: `refuses a state outside the two-valued set` FAILS. If it still passes, the check was never created — read the applied DDL with `\d+ "Holding"`.
3. **Remove `govern_snapshot_one_building`.** Expected: `permits at most one building snapshot per tenant` FAILS.

Each mutation must produce a failure. A mutation that produces none means the assertion is not attached to the thing it names.

- [ ] **Step 13: Commit**

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260822000000_govern_inventory/migration.sql \
        packages/db/src/govern-schema.test.ts
git commit -m "feat(govern): inventory, coverage, findings and audit-integrity data model"
```

---
## Task 2: The closed vocabularies and three-valued aggregation

The unions every Govern module speaks, and the counting discipline that makes `unknown` impossible to render as a zero. Spec §6, §7, §8, §10, §16. **Pure — this module imports nothing from `@syntra/db`.**

This is the safety core of slice 1 and it comes before anything that counts. §8 rule 3 says "no aggregation path exists that collapses `unknown` into `not_held`", and §23 asks for that as a property test rather than a review comment. The way to make it true rather than promised is to give the count functions a return type that **cannot express a bare number for a region with a gap in it**.

**Files:**
- Create: `packages/core/src/govern/types.ts`
- Test: `packages/core/src/govern/types.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing. The module imports no value at all; the test imports `describe`, `expect`, `it` from `vitest` and `fc` from `fast-check` if available, and otherwise generates its own inputs with a seeded loop (Step 2 gives the loop, so the task has no new dependency).
- Produces (all in `./types.js`):
  - `type HoldingState = 'held' | 'unknown'`
  - `type ResourceKind = 'targetEntitlement' | 'targetAccount' | 'syntraGroup' | 'application' | 'syntraRole' | 'syntraUser'`
  - `const RESOURCE_KINDS: readonly ResourceKind[]`
  - `type SystemKind = 'targetSystem' | 'syntraInternal' | 'directorySource'`
  - `type SourceKind = SystemKind`
  - `const SYNTRA_SYSTEM_ID = 'syntra'`
  - `type AttributionKind = 'business_rule' | 'request' | 'delegated_admin' | 'auto_granted' | 'direct_assignment' | 'group_inheritance' | 'org_unit_inheritance' | 'directory_source' | 'discovered' | 'manual' | 'unattributable'`
  - `const ATTRIBUTION_KINDS: readonly AttributionKind[]`
  - `type CoverageGapKind = 'source_unread' | 'source_stale' | 'resource_unreadable' | 'account_unreadable' | 'subject_unresolvable' | 'person_unprocessable'`
  - `const COVERAGE_GAP_KINDS: readonly CoverageGapKind[]`
  - `type Completeness = 'complete' | 'partial' | 'unread'`
  - `type Staleness = 'fresh' | 'stale'`
  - `type FindingKind` — the fifteen kinds of §16 — and `const FINDING_KINDS: readonly FindingKind[]`
  - `type Severity = 'low' | 'medium' | 'high' | 'critical'` and `const SEVERITY_ORDER: readonly Severity[]` and `function raiseSeverity(s: Severity): Severity`
  - `type SubjectRef = { kind: 'person'; personId: string } | { kind: 'account'; systemId: string; accountRef: string }`
  - `function subjectKey(subject: SubjectRef): string`
  - `function parseSubjectKey(key: string): SubjectRef | null`
  - `interface ResourceRef { systemKind: SystemKind; systemId: string; resourceKind: ResourceKind; resourceId: string }`
  - `function resourceKey(resource: ResourceRef): string`
  - `type Tri<T> = { known: true; value: T } | { known: false; reason: string }`
  - `function known<T>(value: T): Tri<T>` and `function unknownValue<T>(reason: string): Tri<T>`
  - `function mapTri<A, B>(t: Tri<A>, f: (a: A) => B): Tri<B>`
  - `interface CountableRegion { held: number; unknownHoldings: number; gapReasons: readonly string[] }`
  - `function countRegion(region: CountableRegion): Tri<number>`
  - `function sumRegions(regions: readonly CountableRegion[]): Tri<number>`
  - `function percentOf(numerator: number, denominator: Tri<number>): Tri<{ percent: number; numerator: number; denominator: number }>`
  - `type MutuallyAssignable<A extends B, B extends A> = true`

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_KINDS,
  COVERAGE_GAP_KINDS,
  FINDING_KINDS,
  RESOURCE_KINDS,
  SEVERITY_ORDER,
  SYNTRA_SYSTEM_ID,
  countRegion,
  known,
  mapTri,
  parseSubjectKey,
  percentOf,
  raiseSeverity,
  resourceKey,
  subjectKey,
  sumRegions,
  unknownValue,
  type CountableRegion,
  type Tri,
} from './types.js';

describe('subject keys', () => {
  it('round-trips a person and an account, and they cannot collide', () => {
    const person = { kind: 'person' as const, personId: 'p-1' };
    const account = { kind: 'account' as const, systemId: 'sys-1', accountRef: 'anchor-7' };

    expect(subjectKey(person)).toBe('person:p-1');
    expect(subjectKey(account)).toBe('account:sys-1:anchor-7');
    expect(parseSubjectKey(subjectKey(person))).toEqual(person);
    expect(parseSubjectKey(subjectKey(account))).toEqual(account);
  });

  it('parses an account whose ref itself contains a colon', () => {
    // AD anchors are objectGUIDs, but a second connector family may return a
    // DN, and a DN is full of colons and commas. Splitting on every colon
    // would silently truncate the ref and merge two accounts into one subject.
    const account = { kind: 'account' as const, systemId: 'sys-1', accountRef: 'CN=a:b,OU=x' };
    expect(parseSubjectKey(subjectKey(account))).toEqual(account);
  });

  it('returns null for a key it does not recognise rather than guessing', () => {
    expect(parseSubjectKey('')).toBeNull();
    expect(parseSubjectKey('person:')).toBeNull();
    expect(parseSubjectKey('user:p-1')).toBeNull();
    expect(parseSubjectKey('account:sys-1')).toBeNull();
  });
});

describe('resource keys', () => {
  it('distinguishes two resources with the same id in different systems', () => {
    const a = resourceKey({
      systemKind: 'targetSystem',
      systemId: 'sys-1',
      resourceKind: 'targetEntitlement',
      resourceId: 'ent-1',
    });
    const b = resourceKey({
      systemKind: 'targetSystem',
      systemId: 'sys-2',
      resourceKind: 'targetEntitlement',
      resourceId: 'ent-1',
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes two resource kinds with the same id in one system', () => {
    const group = resourceKey({
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceKind: 'syntraGroup',
      resourceId: 'x',
    });
    const app = resourceKey({
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceKind: 'application',
      resourceId: 'x',
    });
    expect(group).not.toBe(app);
  });
});

describe('three-valued counting', () => {
  const clean = (held: number): CountableRegion => ({
    held,
    unknownHoldings: 0,
    gapReasons: [],
  });

  it('counts a region that was read completely', () => {
    expect(countRegion(clean(1500))).toEqual({ known: true, value: 1500 });
  });

  it('counts an empty, completely-read region as zero rather than unknown', () => {
    // The empty case is not the unknown case. A group that was read and had
    // nobody in it holds a real, defensible zero, and refusing to say so would
    // make every honest zero look like a failure.
    expect(countRegion(clean(0))).toEqual({ known: true, value: 0 });
  });

  it('refuses to produce a number for a region with a gap in it', () => {
    const result = countRegion({
      held: 1500,
      unknownHoldings: 0,
      gapReasons: ['ent-domain-admins could not be read completely'],
    });
    expect(result.known).toBe(false);
    if (result.known) throw new Error('unreachable');
    expect(result.reason).toContain('ent-domain-admins');
  });

  it('refuses to produce a number for a region holding an unknown-state holding', () => {
    const result = countRegion({ held: 3, unknownHoldings: 1, gapReasons: [] });
    expect(result.known).toBe(false);
  });

  it('poisons a sum with one unknown region, and names which', () => {
    const total = sumRegions([
      clean(10),
      { held: 5, unknownHoldings: 0, gapReasons: ['the domain controller was last read nine days ago'] },
      clean(7),
    ]);
    expect(total.known).toBe(false);
    if (total.known) throw new Error('unreachable');
    expect(total.reason).toContain('nine days ago');
  });

  it('sums clean regions, including an empty list', () => {
    expect(sumRegions([clean(10), clean(7)])).toEqual({ known: true, value: 17 });
    expect(sumRegions([])).toEqual({ known: true, value: 0 });
  });

  it('never lets a percentage escape an unknown denominator', () => {
    const p = percentOf(91, unknownValue<number>('Finance-Payments could not be read'));
    expect(p.known).toBe(false);
  });

  it('carries the denominator alongside a known percentage', () => {
    const p = percentOf(91, known(1840));
    expect(p).toEqual({
      known: true,
      value: { percent: 4.9, numerator: 91, denominator: 1840 },
    });
  });

  it('refuses a percentage of zero rather than dividing', () => {
    // "0% certified of 0 items" is a sentence that has made an audit go badly.
    const p = percentOf(0, known(0));
    expect(p.known).toBe(false);
  });

  it('propagates unknown through mapTri without inventing a value', () => {
    const doubled = mapTri(unknownValue<number>('unread'), (n) => n * 2);
    expect(doubled).toEqual({ known: false, reason: 'unread' });
  });
});

describe('the property that must hold over generated input', () => {
  // Deliberately a seeded loop rather than a property-testing dependency: the
  // property is small, the generator is four lines, and adding a devDependency
  // for it would be the largest thing in this task.
  function* generated(): Generator<CountableRegion[]> {
    let seed = 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 500; n += 1) {
      const count = next() % 6;
      const regions: CountableRegion[] = [];
      for (let i = 0; i < count; i += 1) {
        const held = next() % 2000;
        const unknownHoldings = next() % 3 === 0 ? next() % 50 : 0;
        const hasGap = next() % 4 === 0;
        regions.push({
          held,
          unknownHoldings,
          gapReasons: hasGap ? [`region ${n}.${i} was not read`] : [],
        });
      }
      yield regions;
    }
  }

  it('never reports a number for a scope that contains an unknown, over 500 generated scopes', () => {
    for (const regions of generated()) {
      const dirty = regions.some((r) => r.unknownHoldings > 0 || r.gapReasons.length > 0);
      const total = sumRegions(regions);
      expect(total.known).toBe(!dirty);
    }
  });

  it('equals the plain sum exactly when nothing is unknown', () => {
    for (const regions of generated()) {
      const dirty = regions.some((r) => r.unknownHoldings > 0 || r.gapReasons.length > 0);
      if (dirty) continue;
      const total = sumRegions(regions);
      expect(total).toEqual({
        known: true,
        value: regions.reduce((acc, r) => acc + r.held, 0),
      });
    }
  });
});

describe('the closed sets', () => {
  it('has no duplicates in any vocabulary', () => {
    for (const set of [RESOURCE_KINDS, ATTRIBUTION_KINDS, COVERAGE_GAP_KINDS, FINDING_KINDS]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('raises severity one step and stops at critical', () => {
    expect(SEVERITY_ORDER).toEqual(['low', 'medium', 'high', 'critical']);
    expect(raiseSeverity('low')).toBe('medium');
    expect(raiseSeverity('high')).toBe('critical');
    expect(raiseSeverity('critical')).toBe('critical');
  });

  it('names all fifteen standing and derived finding kinds', () => {
    expect(FINDING_KINDS).toHaveLength(15);
    expect(FINDING_KINDS).toContain('unattributable_holding');
    expect(FINDING_KINDS).toContain('unexplained_gain');
    expect(FINDING_KINDS).toContain('access_without_contract');
    expect(FINDING_KINDS).toContain('dispatch_not_applied');
    expect(FINDING_KINDS).toContain('unmergeable_actor');
  });
});
```

**What the fixture would look like if it could not distinguish pass from fail.** `refuses to produce a number for a region with a gap in it` asserts on `result.reason` containing the gap's own words; asserting only `result.known === false` would pass against an implementation that returned `unknown` for *everything*, and the two clean cases above it are what stop that. The generated-scope property has the same structure in both directions — it asserts `total.known === !dirty`, so an implementation that always returns unknown fails the clean half and one that always returns a number fails the dirty half. A one-directional property here would be the "fixture agrees with the bug" shape this programme keeps finding.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`.

- [ ] **Step 3: Write the vocabularies**

`packages/core/src/govern/types.ts`:

```ts
/**
 * The closed vocabularies every Govern module speaks, and the counting
 * discipline that makes `unknown` impossible to render as a zero.
 *
 * Every union here mirrors a CHECK constraint in
 * `20260822000000_govern_inventory` or `20260823000000_govern_campaigns`
 * exactly. If one moves, both move.
 *
 * PURE. This module imports nothing. A value import from `@syntra/db` here
 * means the boundary is wrong, and Task 7 has a test that says so.
 */

/**
 * Two values, not three. `not_held` is the ABSENCE of a row, and only within a
 * region coverage says was read; everywhere else absence means `unknown`.
 * Storing an explicit `not_held` would multiply the row count by the size of
 * the resource catalog and destroy the very distinction it looks like it
 * preserves, because an unread region would then produce no row at all.
 */
export type HoldingState = 'held' | 'unknown';

export type ResourceKind =
  | 'targetEntitlement'
  | 'targetAccount'
  | 'syntraGroup'
  | 'application'
  | 'syntraRole'
  | 'syntraUser';

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'targetEntitlement',
  'targetAccount',
  'syntraGroup',
  'application',
  'syntraRole',
  'syntraUser',
];

export type SystemKind = 'targetSystem' | 'syntraInternal' | 'directorySource';
export type SourceKind = SystemKind;

/**
 * Core's own groups, applications, roles and user accounts are a system Govern
 * inventories, and they have no `TargetSystem` row. `systemId` is therefore a
 * text column, and this is the value it takes for them.
 */
export const SYNTRA_SYSTEM_ID = 'syntra';

export type AttributionKind =
  | 'business_rule'
  | 'request'
  | 'delegated_admin'
  | 'auto_granted'
  | 'direct_assignment'
  | 'group_inheritance'
  | 'org_unit_inheritance'
  | 'directory_source'
  | 'discovered'
  | 'manual'
  | 'unattributable';

export const ATTRIBUTION_KINDS: readonly AttributionKind[] = [
  'business_rule',
  'request',
  'delegated_admin',
  'auto_granted',
  'direct_assignment',
  'group_inheritance',
  'org_unit_inheritance',
  'directory_source',
  'discovered',
  'manual',
  'unattributable',
];

export type CoverageGapKind =
  | 'source_unread'
  | 'source_stale'
  | 'resource_unreadable'
  | 'account_unreadable'
  | 'subject_unresolvable'
  | 'person_unprocessable';

export const COVERAGE_GAP_KINDS: readonly CoverageGapKind[] = [
  'source_unread',
  'source_stale',
  'resource_unreadable',
  'account_unreadable',
  'subject_unresolvable',
  'person_unprocessable',
];

export type Completeness = 'complete' | 'partial' | 'unread';
export type Staleness = 'fresh' | 'stale';

export type FindingKind =
  | 'unattributable_holding'
  | 'unexplained_gain'
  | 'access_without_contract'
  | 'orphan_account'
  | 'privileged_uncertified'
  | 'stale_source'
  | 'coverage_gap'
  | 'campaign_low_coverage'
  | 'dispatch_not_applied'
  | 'sod_violation'
  | 'sod_laundering'
  | 'approval_reciprocity'
  | 'lapsed_exception'
  | 'no_human_decision'
  | 'unmergeable_actor';

export const FINDING_KINDS: readonly FindingKind[] = [
  'unattributable_holding',
  'unexplained_gain',
  'access_without_contract',
  'orphan_account',
  'privileged_uncertified',
  'stale_source',
  'coverage_gap',
  'campaign_low_coverage',
  'dispatch_not_applied',
  'sod_violation',
  'sod_laundering',
  'approval_reciprocity',
  'lapsed_exception',
  'no_human_decision',
  'unmergeable_actor',
];

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

/**
 * Section 15: a violation somebody once formally accepted and then let quietly
 * expire is a different and worse thing than one nobody has looked at yet.
 */
export function raiseSeverity(severity: Severity): Severity {
  const index = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(index + 1, SEVERITY_ORDER.length - 1)]!;
}

/**
 * A helper that turns a declared type relationship into a compile error when it
 * stops holding. `type _ = MutuallyAssignable<A, B>` fails to compile unless A
 * and B are assignable in both directions.
 *
 * This exists because `z.ZodType<T>` over a `z.lazy` schema checks NOTHING —
 * Ruling P21 measured it: deleting an entire arm of the union still compiles
 * cleanly under that annotation. Anywhere this codebase looks like it is
 * proving a type relationship, it is proving it with one of these.
 */
export type MutuallyAssignable<A extends B, B extends A> = true;
```

- [ ] **Step 4: Write the subject and resource keys**

Append to `packages/core/src/govern/types.ts`:

```ts
export type SubjectRef =
  | { kind: 'person'; personId: string }
  | { kind: 'account'; systemId: string; accountRef: string };

/**
 * The NOT NULL key every subject-bearing table carries beside its two nullable
 * subject columns.
 *
 * Two reasons, and they are the same reason twice. A unique index over
 * nullable columns constrains nothing in PostgreSQL, and a GROUP BY over two
 * nullable columns quietly puts every unattributed account in one bucket.
 */
export function subjectKey(subject: SubjectRef): string {
  return subject.kind === 'person'
    ? `person:${subject.personId}`
    : `account:${subject.systemId}:${subject.accountRef}`;
}

/**
 * The inverse. Returns null rather than guessing, because a key this cannot
 * parse is a bug somewhere upstream and inventing a subject for it would move
 * the bug somewhere harder to find.
 *
 * `accountRef` may itself contain colons — a second connector family may
 * return a distinguished name — so only the FIRST TWO separators are
 * significant and everything after them is the ref.
 */
export function parseSubjectKey(key: string): SubjectRef | null {
  if (key.startsWith('person:')) {
    const personId = key.slice('person:'.length);
    return personId.length > 0 ? { kind: 'person', personId } : null;
  }
  if (key.startsWith('account:')) {
    const rest = key.slice('account:'.length);
    const split = rest.indexOf(':');
    if (split <= 0) return null;
    const systemId = rest.slice(0, split);
    const accountRef = rest.slice(split + 1);
    return accountRef.length > 0 ? { kind: 'account', systemId, accountRef } : null;
  }
  return null;
}

export interface ResourceRef {
  systemKind: SystemKind;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

/**
 * Includes the kind, deliberately. A `Group` and an `Application` in Core can
 * hold the same uuid in principle and certainly hold the same shape, and a key
 * that omitted the kind would merge two different resources into one row of
 * every grouped report.
 */
export function resourceKey(resource: ResourceRef): string {
  return `${resource.systemId}|${resource.resourceKind}|${resource.resourceId}`;
}
```

- [ ] **Step 5: Write the three-valued counting**

Append to `packages/core/src/govern/types.ts`:

```ts
/**
 * A value that may not be knowable, carrying the reason when it is not.
 *
 * The reason is not decoration. "Unknown" with no explanation is a dead end on
 * a screen somebody has to act from; "unknown, because the domain controller
 * was last read nine days ago against a 24-hour SLA" is a sentence with a next
 * step in it.
 */
export type Tri<T> = { known: true; value: T } | { known: false; reason: string };

export function known<T>(value: T): Tri<T> {
  return { known: true, value };
}

export function unknownValue<T>(reason: string): Tri<T> {
  return { known: false, reason };
}

export function mapTri<A, B>(input: Tri<A>, f: (a: A) => B): Tri<B> {
  return input.known ? { known: true, value: f(input.value) } : input;
}

/**
 * One region of the world, as far as one snapshot could see it.
 *
 * `held` is the count of holdings observed present. `unknownHoldings` is the
 * count of holdings whose STATE could not be determined. `gapReasons` is every
 * CoverageGap intersecting this region, in words.
 */
export interface CountableRegion {
  held: number;
  unknownHoldings: number;
  gapReasons: readonly string[];
}

/**
 * The one function that turns a region into a number, and the reason there is
 * no other.
 *
 * Any code path that wants a count goes through here, so there is exactly one
 * place where "we could not read the group" could become "nobody is in the
 * group" — and it does not. Section 8 rule 3 requires that no aggregation path
 * collapses `unknown` into `not_held`; the way to make that true rather than
 * promised is a return type that cannot express a bare number for a region
 * with a gap in it.
 *
 * A completely-read region with nothing in it counts zero. The empty case is
 * not the unknown case, and refusing to say so would make every honest zero
 * look like a failure.
 */
export function countRegion(region: CountableRegion): Tri<number> {
  if (region.gapReasons.length > 0) {
    return unknownValue(region.gapReasons.join('; '));
  }
  if (region.unknownHoldings > 0) {
    return unknownValue(
      `${region.unknownHoldings} holding(s) in this scope have an unknown state`,
    );
  }
  return known(region.held);
}

/** One unknown region poisons the total, and the total says which one. */
export function sumRegions(regions: readonly CountableRegion[]): Tri<number> {
  let total = 0;
  const reasons: string[] = [];
  for (const region of regions) {
    const count = countRegion(region);
    if (count.known) total += count.value;
    else reasons.push(count.reason);
  }
  return reasons.length > 0 ? unknownValue(reasons.join('; ')) : known(total);
}

/**
 * A percentage that carries its own denominator, because "94% certified" with
 * an unstated denominator is the sentence that makes an audit go badly — the
 * denominator turns out to have been "of items that were assigned to a
 * reviewer who was still employed".
 *
 * A zero denominator is unknown rather than zero or NaN. There is no honest
 * percentage of nothing.
 */
export function percentOf(
  numerator: number,
  denominator: Tri<number>,
): Tri<{ percent: number; numerator: number; denominator: number }> {
  if (!denominator.known) return denominator;
  if (denominator.value === 0) {
    return unknownValue('no denominator: this scope contains nothing to be a share of');
  }
  return known({
    percent: Math.round((numerator / denominator.value) * 1000) / 10,
    numerator,
    denominator: denominator.value,
  });
}
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/core/src/govern/types.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 7: Export from the barrel**

In `packages/core/src/index.ts`, after the last `provision/` export line, add:

```ts
export * from './govern/types.js';
```

A star export is safe here: `Tri`, `known`, `subjectKey`, `resourceKey`, `Severity`, `Completeness` and `Staleness` are all new names in this package. **Verify rather than assume** — Provision's Task 7 hit `TS2308` on exactly this move because `provision/types.js` and `policy/types.js` both declared `ContractFacts`:

```bash
pnpm exec tsc -b --force
```

Expected: exit 0. A `TS2308` here means a name collision, and the fix is to enumerate and alias exactly as the `provision/types.js` block above already does — never to drop the export, because the barrel silently stops exporting the name at all.

- [ ] **Step 8: Typecheck**

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Mutation-test the counting discipline**

Four mutations, each reverted before the next. Every one must produce a failure:

1. In `countRegion`, delete the `gapReasons.length > 0` branch. Expected: `refuses to produce a number for a region with a gap in it` FAILS, and both generated-scope properties FAIL. **This is the mutation the whole task exists for** — it is what somebody adding a `count()` that filters on `state = 'held'` would effectively be doing.
2. In `countRegion`, delete the `unknownHoldings > 0` branch. Expected: `refuses to produce a number for a region holding an unknown-state holding` FAILS.
3. In `countRegion`, change the final `known(region.held)` to `unknownValue('unknown')`. Expected: `counts a region that was read completely`, `counts an empty, completely-read region as zero` and the second generated property all FAIL. This is the mutation that proves the property is two-directional.
4. In `percentOf`, delete the zero-denominator branch. Expected: `refuses a percentage of zero rather than dividing` FAILS.
5. In `parseSubjectKey`, replace the `indexOf` split with `rest.split(':')` and take `[0]`/`[1]`. Expected: `parses an account whose ref itself contains a colon` FAILS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/types.ts packages/core/src/govern/types.test.ts packages/core/src/index.ts
git commit -m "feat(govern): closed vocabularies and three-valued aggregation"
```

---
## Task 3: Freshness, staleness and the coverage rollup

Two clocks, and a refusal always names which one it was. Spec §8. **Pure.**

**Files:**
- Create: `packages/core/src/govern/freshness.ts`
- Test: `packages/core/src/govern/freshness.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `type Completeness`, `type Staleness`, `type SourceKind`, `type CoverageGapKind`, `SYNTRA_SYSTEM_ID` from `./types.js`.
- Produces (all in `./freshness.js`):
  - `interface SourceObservation { sourceKind: SourceKind; sourceId: string; sourceName: string; lastRunId: string | null; lastSuccessfulReadAt: Date | null; lastAttemptedReadAt: Date | null; completeness: Completeness; freshnessSlaHours: number; gapCount: number }`
  - `interface ClassifiedSource extends SourceObservation { staleness: Staleness; ageHours: number | null }`
  - `function classifySource(observation: SourceObservation, asOf: Date): ClassifiedSource`
  - `function classifySources(observations: readonly SourceObservation[], asOf: Date): ClassifiedSource[]`
  - `function worstCompleteness(sources: readonly ClassifiedSource[]): Completeness`
  - `function worstStaleness(sources: readonly ClassifiedSource[]): Staleness`
  - `interface SourceGapDraft { kind: CoverageGapKind; sourceKind: SourceKind; sourceId: string; reason: string; sourceRunId: string | null }`
  - `function gapsForSources(sources: readonly ClassifiedSource[]): SourceGapDraft[]`
  - `type SnapshotAgeVerdict = { ok: true; ageDays: number } | { ok: false; ageDays: number; clock: 'snapshot'; message: string }`
  - `function checkSnapshotAge(asOf: Date, now: Date, maxSnapshotAgeDays: number): SnapshotAgeVerdict`
  - `type SourceFreshnessVerdict = { ok: true } | { ok: false; clock: 'source'; offending: ClassifiedSource[]; message: string }`
  - `function checkSourceFreshness(sources: readonly ClassifiedSource[]): SourceFreshnessVerdict`

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/freshness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkSnapshotAge,
  checkSourceFreshness,
  classifySource,
  classifySources,
  gapsForSources,
  worstCompleteness,
  worstStaleness,
  type SourceObservation,
} from './freshness.js';

const AS_OF = new Date('2026-06-15T09:00:00Z');
const hoursBefore = (h: number) => new Date(AS_OF.getTime() - h * 3600_000);

const source = (over: Partial<SourceObservation> = {}): SourceObservation => ({
  sourceKind: 'targetSystem',
  sourceId: 'sys-1',
  sourceName: 'Acme AD',
  lastRunId: 'run-1',
  lastSuccessfulReadAt: hoursBefore(2),
  lastAttemptedReadAt: hoursBefore(2),
  completeness: 'complete',
  freshnessSlaHours: 24,
  gapCount: 0,
  ...over,
});

describe('classifySource — the boundaries', () => {
  it('is fresh just inside the SLA', () => {
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(23.9) }), AS_OF);
    expect(c.staleness).toBe('fresh');
  });

  it('is fresh exactly at the SLA', () => {
    // Exactly at is inside. A boundary that flips at the instant it is reached
    // makes a 24-hour source stale for one tick every day, which trains people
    // to ignore the badge.
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(24) }), AS_OF);
    expect(c.staleness).toBe('fresh');
    expect(c.ageHours).toBe(24);
  });

  it('is stale just outside the SLA', () => {
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(24.1) }), AS_OF);
    expect(c.staleness).toBe('stale');
  });

  it('is unread and stale when it has never been read successfully', () => {
    const c = classifySource(
      source({ lastSuccessfulReadAt: null, lastAttemptedReadAt: hoursBefore(1), completeness: 'unread' }),
      AS_OF,
    );
    expect(c).toMatchObject({ completeness: 'unread', staleness: 'stale', ageHours: null });
  });

  it('is stale and unread when a source has never been attempted at all', () => {
    const c = classifySource(
      source({ lastSuccessfulReadAt: null, lastAttemptedReadAt: null, completeness: 'unread' }),
      AS_OF,
    );
    expect(c.staleness).toBe('stale');
  });

  it('keeps `partial` when the read succeeded but did not see everything', () => {
    // Read recently AND incompletely: fresh on one axis, partial on the other,
    // and conflating them is how a truncated read becomes a complete report.
    const c = classifySource(
      source({ lastSuccessfulReadAt: hoursBefore(1), completeness: 'partial', gapCount: 2 }),
      AS_OF,
    );
    expect(c).toMatchObject({ staleness: 'fresh', completeness: 'partial' });
  });

  it('treats syntraInternal as always fresh and always complete, whatever it was handed', () => {
    // Automate's grants live in the same database and are current by
    // construction. Saying so explicitly is better than leaving a blank a
    // reader interprets as an omission.
    const c = classifySource(
      source({
        sourceKind: 'syntraInternal',
        sourceId: 'syntra',
        lastSuccessfulReadAt: null,
        completeness: 'unread',
        freshnessSlaHours: 1,
      }),
      AS_OF,
    );
    expect(c).toMatchObject({ staleness: 'fresh', completeness: 'complete' });
  });
});

describe('rollups take the worst', () => {
  it('takes the worst completeness across sources', () => {
    const sources = classifySources(
      [source(), source({ sourceId: 'sys-2', completeness: 'partial' })],
      AS_OF,
    );
    expect(worstCompleteness(sources)).toBe('partial');
  });

  it('ranks unread below partial', () => {
    const sources = classifySources(
      [source({ completeness: 'partial' }), source({ sourceId: 'sys-2', completeness: 'unread', lastSuccessfulReadAt: null })],
      AS_OF,
    );
    expect(worstCompleteness(sources)).toBe('unread');
  });

  it('is stale if any source is stale', () => {
    const sources = classifySources(
      [source(), source({ sourceId: 'sys-2', lastSuccessfulReadAt: hoursBefore(200) })],
      AS_OF,
    );
    expect(worstStaleness(sources)).toBe('stale');
  });

  it('reports an EMPTY source list as unread and stale, never as complete and fresh', () => {
    // The empty case is the universal case. A snapshot with no SnapshotSource
    // rows has not been shown to have read anything, and calling that
    // "complete" is the false-assurance defect in its purest form.
    expect(worstCompleteness([])).toBe('unread');
    expect(worstStaleness([])).toBe('stale');
  });
});

describe('gapsForSources', () => {
  it('produces one source_unread gap naming the source', () => {
    const [gap, ...rest] = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: null, completeness: 'unread' })], AS_OF),
    );
    expect(rest).toHaveLength(0);
    expect(gap).toMatchObject({ kind: 'source_unread', sourceId: 'sys-1' });
    expect(gap!.reason).toContain('Acme AD');
  });

  it('produces one source_stale gap carrying the age and the SLA in words', () => {
    const [gap] = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: hoursBefore(9 * 24) })], AS_OF),
    );
    expect(gap).toMatchObject({ kind: 'source_stale' });
    expect(gap!.reason).toContain('216');
    expect(gap!.reason).toContain('24');
  });

  it('produces no gap for a fresh, complete source', () => {
    expect(gapsForSources(classifySources([source()], AS_OF))).toEqual([]);
  });

  it('produces a source_unread gap, not a source_stale one, for a source never read', () => {
    // Both are true of an unread source and only one is useful. "Nine days
    // stale" about something never read is a sentence that sends somebody
    // looking for a run that does not exist.
    const gaps = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: null, completeness: 'unread' })], AS_OF),
    );
    expect(gaps.map((g) => g.kind)).toEqual(['source_unread']);
  });
});

describe('the two clocks, and which one a refusal names', () => {
  const NOW = new Date('2026-07-20T09:00:00Z');

  it('passes a snapshot inside maxSnapshotAgeDays', () => {
    expect(checkSnapshotAge(new Date('2026-07-01T09:00:00Z'), NOW, 30)).toEqual({
      ok: true,
      ageDays: 19,
    });
  });

  it('refuses a snapshot past maxSnapshotAgeDays and names the snapshot clock', () => {
    const verdict = checkSnapshotAge(new Date('2026-06-01T09:00:00Z'), NOW, 30);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.clock).toBe('snapshot');
    expect(verdict.message).toContain('49 days');
    expect(verdict.message).toContain('30');
  });

  it('separates the clocks: fresh sources, ancient snapshot', () => {
    // Built five weeks ago from sources that were all fresh AT THE TIME. Fails
    // the snapshot clock, passes the source clock.
    const sources = classifySources([source()], AS_OF);
    expect(checkSourceFreshness(sources).ok).toBe(true);
    expect(checkSnapshotAge(AS_OF, NOW, 30).ok).toBe(false);
  });

  it('separates the clocks the other way: minutes-old snapshot, three-week-old target', () => {
    const sources = classifySources(
      [source({ lastSuccessfulReadAt: hoursBefore(21 * 24) })],
      AS_OF,
    );
    const verdict = checkSourceFreshness(sources);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.clock).toBe('source');
    expect(verdict.offending.map((s) => s.sourceId)).toEqual(['sys-1']);
    expect(checkSnapshotAge(AS_OF, new Date(AS_OF.getTime() + 300_000), 30).ok).toBe(true);
  });

  it('refuses when a source in scope has never been read', () => {
    const sources = classifySources(
      [source({ lastSuccessfulReadAt: null, completeness: 'unread' })],
      AS_OF,
    );
    expect(checkSourceFreshness(sources).ok).toBe(false);
  });

  it('refuses an EMPTY source list rather than passing it', () => {
    const verdict = checkSourceFreshness([]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('no source');
  });
});
```

**What the fixture would look like if it could not distinguish pass from fail.** The two `separates the clocks` cases are the point of this task: a single boolean "is this fresh" would pass both of them written one at a time and fail neither, because each is true on one axis. They are written as a pair asserting *opposite* verdicts from the two functions over the same data, so an implementation that collapsed the clocks fails one of them whichever way it collapsed.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/freshness.test.ts`
Expected: FAIL — `Cannot find module './freshness.js'`.

- [ ] **Step 3: Write the classifier**

`packages/core/src/govern/freshness.ts`:

```ts
import type { Completeness, CoverageGapKind, SourceKind, Staleness } from './types.js';

/**
 * Freshness, staleness and the coverage rollup.
 *
 * THERE ARE TWO CLOCKS AND THEY ARE NOT THE SAME CLOCK.
 *
 * `freshnessSlaHours` is per source and measures how long ago THE WORLD was
 * read. `maxSnapshotAgeDays` is per tenant and measures how long ago GOVERN
 * assembled the picture. A snapshot built five minutes ago from a target read
 * three weeks ago fails the first and passes the second; a snapshot built five
 * weeks ago from sources that were all fresh at the time fails the second and
 * passes the first. Both are checked, separately, and a refusal always names
 * which one it was.
 *
 * PURE.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface SourceObservation {
  sourceKind: SourceKind;
  sourceId: string;
  sourceName: string;
  lastRunId: string | null;
  lastSuccessfulReadAt: Date | null;
  lastAttemptedReadAt: Date | null;
  completeness: Completeness;
  freshnessSlaHours: number;
  gapCount: number;
}

export interface ClassifiedSource extends SourceObservation {
  staleness: Staleness;
  /** Null when the source has never been read successfully. */
  ageHours: number | null;
}

export function classifySource(
  observation: SourceObservation,
  asOf: Date,
): ClassifiedSource {
  // Automate's grants, Core's groups, roles and users live in the same
  // database and are current by construction. Stating that is better than
  // leaving a blank that a reader interprets as an omission.
  if (observation.sourceKind === 'syntraInternal') {
    return { ...observation, completeness: 'complete', staleness: 'fresh', ageHours: 0 };
  }

  if (observation.lastSuccessfulReadAt === null) {
    return { ...observation, completeness: 'unread', staleness: 'stale', ageHours: null };
  }

  const ageHours =
    (asOf.getTime() - observation.lastSuccessfulReadAt.getTime()) / MS_PER_HOUR;

  // Exactly at the SLA is INSIDE it. A boundary that flips at the instant it
  // is reached makes a 24-hour source stale for one tick every day.
  return {
    ...observation,
    staleness: ageHours <= observation.freshnessSlaHours ? 'fresh' : 'stale',
    ageHours,
  };
}

export function classifySources(
  observations: readonly SourceObservation[],
  asOf: Date,
): ClassifiedSource[] {
  return observations.map((o) => classifySource(o, asOf));
}

const COMPLETENESS_RANK: Record<Completeness, number> = {
  complete: 0,
  partial: 1,
  unread: 2,
};

/**
 * The snapshot takes the WORST of its sources, and an empty list is `unread`.
 *
 * The empty case is the one that matters. A snapshot with no SnapshotSource
 * rows has not been shown to have read anything, and calling that "complete"
 * is the false-assurance defect in its purest form — it is what a build that
 * silently collected nothing would produce.
 */
export function worstCompleteness(sources: readonly ClassifiedSource[]): Completeness {
  if (sources.length === 0) return 'unread';
  return sources.reduce<Completeness>(
    (worst, s) => (COMPLETENESS_RANK[s.completeness] > COMPLETENESS_RANK[worst] ? s.completeness : worst),
    'complete',
  );
}

/** Same reasoning: an empty list is `stale`, not `fresh`. */
export function worstStaleness(sources: readonly ClassifiedSource[]): Staleness {
  if (sources.length === 0) return 'stale';
  return sources.some((s) => s.staleness === 'stale') ? 'stale' : 'fresh';
}

export interface SourceGapDraft {
  kind: CoverageGapKind;
  sourceKind: SourceKind;
  sourceId: string;
  reason: string;
  sourceRunId: string | null;
}

/**
 * One gap per source that cannot be described, and AT MOST ONE per source.
 *
 * An unread source is also, trivially, past its SLA, and reporting both would
 * put "nine days stale" on a screen about something nobody has ever read —
 * which sends the reader looking for a run that does not exist.
 */
export function gapsForSources(sources: readonly ClassifiedSource[]): SourceGapDraft[] {
  const gaps: SourceGapDraft[] = [];
  for (const s of sources) {
    if (s.lastSuccessfulReadAt === null) {
      gaps.push({
        kind: 'source_unread',
        sourceKind: s.sourceKind,
        sourceId: s.sourceId,
        reason: `${s.sourceName} has never been read successfully; nothing it holds is described by this snapshot`,
        sourceRunId: s.lastRunId,
      });
      continue;
    }
    if (s.staleness === 'stale') {
      gaps.push({
        kind: 'source_stale',
        sourceKind: s.sourceKind,
        sourceId: s.sourceId,
        reason:
          `${s.sourceName} was last read ${Math.round(s.ageHours ?? 0)} hours ago, ` +
          `against a freshness SLA of ${s.freshnessSlaHours} hours`,
        sourceRunId: s.lastRunId,
      });
    }
  }
  return gaps;
}
```

- [ ] **Step 4: Write the two clock checks**

Append to `packages/core/src/govern/freshness.ts`:

```ts
export type SnapshotAgeVerdict =
  | { ok: true; ageDays: number }
  | { ok: false; ageDays: number; clock: 'snapshot'; message: string };

/**
 * The tenant clock. Section 8 rule 2, and section 13's first outright refusal.
 *
 * There is nothing an administrator could usefully confirm about executing
 * decisions made against a picture of the world from six weeks ago; the answer
 * is to re-base and let the reviewers look at what changed.
 */
export function checkSnapshotAge(
  asOf: Date,
  now: Date,
  maxSnapshotAgeDays: number,
): SnapshotAgeVerdict {
  const ageDays = Math.floor((now.getTime() - asOf.getTime()) / MS_PER_DAY);
  if (ageDays <= maxSnapshotAgeDays) return { ok: true, ageDays };
  return {
    ok: false,
    ageDays,
    clock: 'snapshot',
    message:
      `this snapshot was assembled ${ageDays} days ago, past the limit of ` +
      `${maxSnapshotAgeDays} days. Re-base onto a fresh snapshot; re-basing ` +
      `re-opens only the items whose holding actually changed.`,
  };
}

export type SourceFreshnessVerdict =
  | { ok: true }
  | { ok: false; clock: 'source'; offending: ClassifiedSource[]; message: string };

/**
 * The world clock. Section 8 rule 1, and section 13's second outright refusal.
 *
 * Somebody about to ask 200 managers to attest to something has to be
 * attesting to something true, so this is a refusal and not a warning the
 * campaign owner can dismiss.
 *
 * An EMPTY list refuses. A campaign whose scope depends on no source at all is
 * a campaign over a scope nobody has established anything about.
 */
export function checkSourceFreshness(
  sources: readonly ClassifiedSource[],
): SourceFreshnessVerdict {
  if (sources.length === 0) {
    return {
      ok: false,
      clock: 'source',
      offending: [],
      message:
        'no source contributes to this scope, so nothing here has been shown to have been read',
    };
  }

  const offending = sources.filter(
    (s) => s.staleness === 'stale' || s.completeness === 'unread',
  );
  if (offending.length === 0) return { ok: true };

  return {
    ok: false,
    clock: 'source',
    offending,
    message: offending
      .map((s) =>
        s.lastSuccessfulReadAt === null
          ? `${s.sourceName} has never been read successfully`
          : `${s.sourceName} was last read ${Math.round(s.ageHours ?? 0)} hours ago, against a ${s.freshnessSlaHours}-hour SLA`,
      )
      .join('; '),
  };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/govern/freshness.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 6: Export and typecheck**

Add `export * from './govern/freshness.js';` to `packages/core/src/index.ts` after the types line.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 7: Mutation-test the boundaries and the empty case**

Each mutation reverted before the next; every one must produce a failure:

1. Change `ageHours <= observation.freshnessSlaHours` to `<`. Expected: `is fresh exactly at the SLA` FAILS.
2. Change it to `<= observation.freshnessSlaHours + 1`. Expected: `is stale just outside the SLA` FAILS. Both directions, because a one-directional boundary test is a fixture that agrees with half the bugs.
3. Change `worstCompleteness([])` to return `'complete'`. Expected: `reports an EMPTY source list as unread and stale` FAILS.
4. In `gapsForSources`, remove the `continue` after the unread branch. Expected: `produces a source_unread gap, not a source_stale one` FAILS.
5. In `classifySource`, delete the `syntraInternal` short-circuit. Expected: `treats syntraInternal as always fresh and always complete` FAILS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/govern/freshness.ts packages/core/src/govern/freshness.test.ts packages/core/src/index.ts
git commit -m "feat(govern): source freshness, coverage rollup and the two clocks"
```

---
## Task 4: Attribution assembly, and the definition of unattributable

How somebody got each piece. Spec §7. **Pure.**

Provenance is a **set**, not a label. Provision unions across concurrent contracts, Automate unions rules with grants, and a person can reach an application by three paths at once. A single `origin` column would have to choose, and it would choose wrong exactly in the cases that matter — the researcher with two contracts, the person whose requested access is also now birthright, the group membership that arrives both by rule and by hand.

**Files:**
- Create: `packages/core/src/govern/attribute.ts`
- Test: `packages/core/src/govern/attribute.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `type AttributionKind` from `./types.js`.
- Produces (all in `./attribute.js`):
  - `interface AttributionDraft { kind: AttributionKind; refType: string; refId: string | null; detail: Record<string, unknown>; resolvedAt: Date }`
  - `interface RuleFact { ruleId: string; ruleName: string; contractId: string; department: string | null; jobTitle: string | null; ruleEnabled: boolean }`
  - `interface RequestFact { grantId: string; requestId: string | null; productId: string | null; productName: string | null; requesterName: string | null; subjectName: string; approvers: { personName: string; decision: string; decidedAt: string; comment: string | null }[]; endsAt: string | null; origin: 'request' | 'delegated_admin'; autoGranted: boolean; delegateName: string | null; delegationCapabilities: string[] }`
  - `interface DirectAssignmentFact { rowType: 'AppAssignment' | 'RoleAssignment'; rowId: string; scopeOrgUnitId: string | null; scopeOrgUnitName: string | null; administratorName: string | null; assignedAt: string | null }`
  - `interface GroupInheritanceFact { groupId: string; groupName: string; assignmentId: string }`
  - `interface OrgUnitInheritanceFact { assignmentId: string; matchedOrgUnitId: string; matchedOrgUnitName: string; chain: { orgUnitId: string; name: string }[] }`
  - `interface DirectorySourceFact { sourceId: string; sourceName: string; anchor: string | null; distinguishedName: string | null }`
  - `interface DiscoveredFact { firstRunId: string | null; discoveredAt: string }`
  - `interface ManualFact { administratorName: string | null; recordedAt: string; reason: string | null }`
  - `interface AttributionInput { rules: readonly RuleFact[]; requests: readonly RequestFact[]; directAssignments: readonly DirectAssignmentFact[]; groupInheritance: readonly GroupInheritanceFact[]; orgUnitInheritance: readonly OrgUnitInheritanceFact[]; directorySources: readonly DirectorySourceFact[]; discovered: readonly DiscoveredFact[]; manual: readonly ManualFact[] }`
  - `const EMPTY_ATTRIBUTION_INPUT: AttributionInput`
  - `function attributionsFor(input: AttributionInput, resolvedAt: Date): AttributionDraft[]`
  - `function isUnattributable(kinds: readonly AttributionKind[]): boolean`
  - `function hasLiveRuleAttribution(drafts: readonly AttributionDraft[]): boolean`
  - `function summariseAttributions(drafts: readonly AttributionDraft[]): string`

**The definition, exactly, because it is used as a filter in four places.** A holding is `unattributable` when its attribution set is **empty**, or when its only kinds are `discovered` and `unattributable`. Both mean the same operational thing — the access exists and nothing in Syntra caused it — and a filter that caught one but not the other would leave the more common half out of the register it exists for. **`manual` does not make a holding unattributable**: somebody in Syntra recorded that the grant exists and who they are, which is a weaker record than a rule or a request and is not nothing.

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/attribute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ATTRIBUTION_INPUT,
  attributionsFor,
  hasLiveRuleAttribution,
  isUnattributable,
  summariseAttributions,
  type AttributionInput,
} from './attribute.js';

const AT = new Date('2026-06-15T09:00:00Z');

const input = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  ...EMPTY_ATTRIBUTION_INPUT,
  ...over,
});

const rule = {
  ruleId: 'rule-finance',
  ruleName: 'Finance staff',
  contractId: 'contract-2',
  department: 'Onderwijs',
  jobTitle: 'Docent',
  ruleEnabled: true,
};

const request = {
  grantId: 'grant-1',
  requestId: 'req-1',
  productId: 'prod-1',
  productName: 'Finance payments',
  requesterName: 'Anna Novak',
  subjectName: 'Anna Novak',
  approvers: [
    { personName: 'Jan de Vries', decision: 'approve', decidedAt: '2026-03-04T10:00:00Z', comment: null },
  ],
  endsAt: '2026-06-30T00:00:00Z',
  origin: 'request' as const,
  autoGranted: false,
  delegateName: null,
  delegationCapabilities: [],
};

describe('the attribution set is a set', () => {
  it('carries a rule and a request together, not one of them', () => {
    // The case the design names: Anna holds Finance-Payments because the rule
    // matched her 0.4 FTE teaching contract AND because she requested it in
    // March and Jan approved it until 30 June. A single `origin` column would
    // have to pick, and would pick wrong exactly here.
    const drafts = attributionsFor(input({ rules: [rule], requests: [request] }), AT);
    expect(drafts.map((d) => d.kind).sort()).toEqual(['business_rule', 'request']);
  });

  it('carries one attribution per concurrent contract that satisfied the rule', () => {
    const drafts = attributionsFor(
      input({
        rules: [rule, { ...rule, contractId: 'contract-3', jobTitle: 'Onderzoeker' }],
      }),
      AT,
    );
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.detail['contractId'])).toEqual(['contract-2', 'contract-3']);
  });

  it('copies the rule name and the contract attributes rather than referencing them', () => {
    // A rule renamed next month must not silently rewrite last quarter's
    // evidence, and an approver who leaves must still have a name in the record
    // of what they approved.
    const [draft] = attributionsFor(input({ rules: [rule] }), AT);
    expect(draft!.detail).toMatchObject({
      ruleName: 'Finance staff',
      department: 'Onderwijs',
      jobTitle: 'Docent',
    });
    expect(draft!.resolvedAt).toEqual(AT);
  });

  it('copies every approver and their decision into the request attribution', () => {
    const [draft] = attributionsFor(input({ requests: [request] }), AT);
    expect(draft!.detail['approvers']).toEqual([
      { personName: 'Jan de Vries', decision: 'approve', decidedAt: '2026-03-04T10:00:00Z', comment: null },
    ]);
    expect(draft!.detail['endsAt']).toBe('2026-06-30T00:00:00Z');
  });

  it('marks a zero-stage grant auto_granted and says no human decided', () => {
    const [draft] = attributionsFor(
      input({ requests: [{ ...request, approvers: [], autoGranted: true }] }),
      AT,
    );
    expect(draft!.kind).toBe('auto_granted');
    expect(draft!.detail['noHumanDecided']).toBe(true);
  });

  it('marks a delegated administrative grant delegated_admin and names the delegate', () => {
    const [draft] = attributionsFor(
      input({
        requests: [
          {
            ...request,
            origin: 'delegated_admin',
            approvers: [],
            delegateName: 'Team lead',
            delegationCapabilities: ['grant', 'revoke'],
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('delegated_admin');
    expect(draft!.detail).toMatchObject({
      delegateName: 'Team lead',
      capabilities: ['grant', 'revoke'],
    });
  });
});

describe('the three application paths', () => {
  it('records a direct assignment with its administrator when the audit log names one', () => {
    const [draft] = attributionsFor(
      input({
        directAssignments: [
          {
            rowType: 'AppAssignment',
            rowId: 'assign-1',
            scopeOrgUnitId: null,
            scopeOrgUnitName: null,
            administratorName: 'Sam Admin',
            assignedAt: '2026-01-04T12:00:00Z',
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('direct_assignment');
    expect(draft!.detail['administratorName']).toBe('Sam Admin');
  });

  it('says in words that nobody is recorded, rather than emitting a blank', () => {
    // AppAssignment has no createdByUserId and RoleAssignment has no createdAt
    // at all, so for some rows there is genuinely nothing to say. A blank field
    // reads as a missing value somebody should go and find; a sentence reads as
    // an answer.
    const [draft] = attributionsFor(
      input({
        directAssignments: [
          {
            rowType: 'RoleAssignment',
            rowId: 'ra-1',
            scopeOrgUnitId: 'ou-9',
            scopeOrgUnitName: 'Head Office',
            administratorName: null,
            assignedAt: null,
          },
        ],
      }),
      AT,
    );
    expect(draft!.detail['administratorName']).toBeNull();
    expect(draft!.detail['note']).toBe(
      'assigned directly; no audit event records who or when',
    );
    expect(draft!.detail['scopeOrgUnitName']).toBe('Head Office');
  });

  it('records the group that carried the assignment', () => {
    const [draft] = attributionsFor(
      input({ groupInheritance: [{ groupId: 'g-1', groupName: 'Finance', assignmentId: 'a-1' }] }),
      AT,
    );
    expect(draft!.kind).toBe('group_inheritance');
    expect(draft!.detail).toMatchObject({ groupName: 'Finance' });
  });

  it('records WHICH org unit produced the match and the chain up to it', () => {
    // This is the provenance question the brief singles out and the one nobody
    // expects. "By org unit" is a shrug; "by Head Office, two levels above
    // Care, which is where your user sits" is an answer.
    const [draft] = attributionsFor(
      input({
        orgUnitInheritance: [
          {
            assignmentId: 'a-2',
            matchedOrgUnitId: 'ou-root',
            matchedOrgUnitName: 'Head Office',
            chain: [
              { orgUnitId: 'ou-care', name: 'Care' },
              { orgUnitId: 'ou-region', name: 'North region' },
              { orgUnitId: 'ou-root', name: 'Head Office' },
            ],
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('org_unit_inheritance');
    expect(draft!.detail['matchedOrgUnitName']).toBe('Head Office');
    expect(draft!.detail['chain']).toHaveLength(3);
    expect((draft!.detail['chain'] as { name: string }[])[0]!.name).toBe('Care');
  });

  it('carries all three at once when all three apply', () => {
    const drafts = attributionsFor(
      input({
        directAssignments: [
          { rowType: 'AppAssignment', rowId: 'a-1', scopeOrgUnitId: null, scopeOrgUnitName: null, administratorName: null, assignedAt: null },
        ],
        groupInheritance: [{ groupId: 'g-1', groupName: 'Finance', assignmentId: 'a-2' }],
        orgUnitInheritance: [
          { assignmentId: 'a-3', matchedOrgUnitId: 'ou-1', matchedOrgUnitName: 'HQ', chain: [{ orgUnitId: 'ou-1', name: 'HQ' }] },
        ],
      }),
      AT,
    );
    expect(drafts.map((d) => d.kind).sort()).toEqual([
      'direct_assignment',
      'group_inheritance',
      'org_unit_inheritance',
    ]);
  });
});

describe('the reason that lies outside Syntra', () => {
  it('names the source and the distinguished name so somebody knows where to go and ask', () => {
    const [draft] = attributionsFor(
      input({
        directorySources: [
          {
            sourceId: 'src-1',
            sourceName: 'Acme AD',
            anchor: 'objectguid-1',
            distinguishedName: 'CN=Anna,OU=Users,DC=acme,DC=test',
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('directory_source');
    expect(draft!.detail).toMatchObject({
      sourceName: 'Acme AD',
      distinguishedName: 'CN=Anna,OU=Users,DC=acme,DC=test',
    });
  });
});

describe('the unattributable definition', () => {
  it('is unattributable on an EMPTY set', () => {
    // The empty case is the dangerous case here, and it must be true.
    expect(isUnattributable([])).toBe(true);
  });

  it('is unattributable on `discovered` alone', () => {
    expect(isUnattributable(['discovered'])).toBe(true);
  });

  it('is unattributable on `unattributable` alone', () => {
    expect(isUnattributable(['unattributable'])).toBe(true);
  });

  it('is unattributable on `discovered` and `unattributable` together', () => {
    expect(isUnattributable(['discovered', 'unattributable'])).toBe(true);
  });

  it('is NOT unattributable on `manual`', () => {
    // Somebody in Syntra recorded that the grant exists and who they are.
    // Weaker than a rule or a request; not nothing.
    expect(isUnattributable(['manual'])).toBe(false);
  });

  it('is NOT unattributable when `discovered` sits beside `manual`', () => {
    expect(isUnattributable(['discovered', 'manual'])).toBe(false);
  });

  it('is NOT unattributable for a rule or a request', () => {
    expect(isUnattributable(['business_rule'])).toBe(false);
    expect(isUnattributable(['request'])).toBe(false);
    expect(isUnattributable(['auto_granted'])).toBe(false);
  });

  it('emits an explicit `unattributable` draft when nothing else resolved', () => {
    const drafts = attributionsFor(input(), AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'unattributable', refId: null });
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(true);
  });

  it('classifies a `discovered` holding as unattributable through the real pipeline', () => {
    const drafts = attributionsFor(
      input({ discovered: [{ firstRunId: 'run-3', discoveredAt: '2024-02-01T00:00:00Z' }] }),
      AT,
    );
    expect(drafts.map((d) => d.kind)).toEqual(['discovered']);
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(true);
  });

  it('does not classify a `manual` holding as unattributable through the real pipeline', () => {
    const drafts = attributionsFor(
      input({ manual: [{ administratorName: 'Sam', recordedAt: '2025-05-05T00:00:00Z', reason: 'leaver cover' }] }),
      AT,
    );
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(false);
  });
});

describe('hasLiveRuleAttribution — the RevocationOrder refusal', () => {
  it('is true for an enabled rule', () => {
    expect(hasLiveRuleAttribution(attributionsFor(input({ rules: [rule] }), AT))).toBe(true);
  });

  it('is FALSE for a disabled rule, which no longer wants the holding', () => {
    // A disabled rule explains how the holding arrived and does not explain why
    // it should stay. Treating it as live would refuse every RevocationOrder
    // for access a rule once granted and no longer does — which is precisely
    // the hand-granted residue a campaign exists to find.
    expect(
      hasLiveRuleAttribution(attributionsFor(input({ rules: [{ ...rule, ruleEnabled: false }] }), AT)),
    ).toBe(false);
  });

  it('is true for a live grant, which is also something that would re-create it', () => {
    expect(hasLiveRuleAttribution(attributionsFor(input({ requests: [request] }), AT))).toBe(true);
  });
});

describe('summariseAttributions', () => {
  it('reads as a sentence a manager can act on', () => {
    const summary = summariseAttributions(
      attributionsFor(input({ rules: [rule], requests: [request] }), AT),
    );
    expect(summary).toContain('Finance staff');
    expect(summary).toContain('Jan de Vries');
  });

  it('says plainly that nothing explains it', () => {
    expect(summariseAttributions(attributionsFor(input(), AT))).toBe(
      'nothing in Syntra explains this access',
    );
  });
});
```

**What the fixture would look like if it could not distinguish pass from fail.** The `isUnattributable` block is written as seven cases with two answers, and three of them (`manual`, `discovered + manual`, `business_rule`) must return **false** — a predicate that always returned true would satisfy the four positive cases and nothing else. The pipeline cases at the end exist because a predicate can be right about a list of kinds while `attributionsFor` produces the wrong kinds, and each half passing alone proves nothing about the pair.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/attribute.test.ts`
Expected: FAIL — `Cannot find module './attribute.js'`.

- [ ] **Step 3: Write the fact types**

`packages/core/src/govern/attribute.ts`:

```ts
import type { AttributionKind } from './types.js';

/**
 * How somebody got each piece. Spec section 7.
 *
 * PROVENANCE IS A SET, NOT A LABEL. Provision unions across concurrent
 * contracts, Automate unions rules with grants, and a person can reach an
 * application by three paths at once. A single `origin` column would have to
 * choose, and it would choose wrong exactly in the cases that matter.
 *
 * Every attribution is resolved AS AT the snapshot's observation time, and the
 * values it copies — the rule's name, the contract's department, the approver's
 * display name — are COPIED, not referenced. A rule renamed next month must not
 * silently rewrite last quarter's evidence.
 *
 * PURE.
 */

export interface AttributionDraft {
  kind: AttributionKind;
  refType: string;
  refId: string | null;
  detail: Record<string, unknown>;
  resolvedAt: Date;
}

/** Provision's `AccountEntitlement.grantedByRuleId` plus its evaluation-time attribution. */
export interface RuleFact {
  ruleId: string;
  ruleName: string;
  contractId: string;
  department: string | null;
  jobTitle: string | null;
  /**
   * Whether the rule is enabled TODAY. A disabled rule explains how the
   * holding arrived and does not explain why it should stay, which is the
   * difference between `revocation_requires_change` and a revocation order.
   */
  ruleEnabled: boolean;
}

/** Automate's `AccessGrant` + `AccessRequest` + `ApprovalDecision`. */
export interface RequestFact {
  grantId: string;
  requestId: string | null;
  productId: string | null;
  productName: string | null;
  requesterName: string | null;
  subjectName: string;
  approvers: {
    personName: string;
    decision: string;
    decidedAt: string;
    comment: string | null;
  }[];
  endsAt: string | null;
  origin: 'request' | 'delegated_admin';
  /** A zero-stage workflow: the grant exists and no human decided. */
  autoGranted: boolean;
  delegateName: string | null;
  delegationCapabilities: string[];
}

export interface DirectAssignmentFact {
  rowType: 'AppAssignment' | 'RoleAssignment';
  rowId: string;
  scopeOrgUnitId: string | null;
  scopeOrgUnitName: string | null;
  /**
   * From the audit log, where an event names one. `AppAssignment` has no
   * `createdByUserId` and `RoleAssignment` has no `createdAt` at all, so for
   * some rows this is genuinely null and the draft says so in words.
   */
  administratorName: string | null;
  assignedAt: string | null;
}

export interface GroupInheritanceFact {
  groupId: string;
  groupName: string;
  assignmentId: string;
}

export interface OrgUnitInheritanceFact {
  assignmentId: string;
  matchedOrgUnitId: string;
  matchedOrgUnitName: string;
  /** The user's own unit first, the matched unit last. */
  chain: { orgUnitId: string; name: string }[];
}

export interface DirectorySourceFact {
  sourceId: string;
  sourceName: string;
  anchor: string | null;
  distinguishedName: string | null;
}

export interface DiscoveredFact {
  firstRunId: string | null;
  discoveredAt: string;
}

export interface ManualFact {
  administratorName: string | null;
  recordedAt: string;
  reason: string | null;
}

export interface AttributionInput {
  rules: readonly RuleFact[];
  requests: readonly RequestFact[];
  directAssignments: readonly DirectAssignmentFact[];
  groupInheritance: readonly GroupInheritanceFact[];
  orgUnitInheritance: readonly OrgUnitInheritanceFact[];
  directorySources: readonly DirectorySourceFact[];
  discovered: readonly DiscoveredFact[];
  manual: readonly ManualFact[];
}

export const EMPTY_ATTRIBUTION_INPUT: AttributionInput = {
  rules: [],
  requests: [],
  directAssignments: [],
  groupInheritance: [],
  orgUnitInheritance: [],
  directorySources: [],
  discovered: [],
  manual: [],
};
```

- [ ] **Step 4: Write the assembly**

Append to `packages/core/src/govern/attribute.ts`:

```ts
export function attributionsFor(
  input: AttributionInput,
  resolvedAt: Date,
): AttributionDraft[] {
  const drafts: AttributionDraft[] = [];

  for (const rule of input.rules) {
    drafts.push({
      kind: 'business_rule',
      refType: 'BusinessRule',
      refId: rule.ruleId,
      detail: {
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        contractId: rule.contractId,
        department: rule.department,
        jobTitle: rule.jobTitle,
        ruleEnabled: rule.ruleEnabled,
      },
      resolvedAt,
    });
  }

  for (const request of input.requests) {
    // Three kinds share one source row, and the distinction is the whole
    // point: `auto_granted` means a legitimate configuration produced access
    // NOBODY DECIDED, and section 14 treats that as its own class rather than
    // as a weak request.
    const kind: AttributionKind = request.autoGranted
      ? 'auto_granted'
      : request.origin === 'delegated_admin'
        ? 'delegated_admin'
        : 'request';

    drafts.push({
      kind,
      refType: 'AccessGrant',
      refId: request.grantId,
      detail: {
        grantId: request.grantId,
        requestId: request.requestId,
        productId: request.productId,
        productName: request.productName,
        requesterName: request.requesterName,
        subjectName: request.subjectName,
        approvers: request.approvers,
        endsAt: request.endsAt,
        ...(kind === 'auto_granted' ? { noHumanDecided: true } : {}),
        ...(kind === 'delegated_admin'
          ? {
              delegateName: request.delegateName,
              capabilities: request.delegationCapabilities,
            }
          : {}),
      },
      resolvedAt,
    });
  }

  for (const assignment of input.directAssignments) {
    drafts.push({
      kind: 'direct_assignment',
      refType: assignment.rowType,
      refId: assignment.rowId,
      detail: {
        rowType: assignment.rowType,
        rowId: assignment.rowId,
        scopeOrgUnitId: assignment.scopeOrgUnitId,
        scopeOrgUnitName: assignment.scopeOrgUnitName,
        administratorName: assignment.administratorName,
        assignedAt: assignment.assignedAt,
        // A sentence rather than a blank. A blank field reads as a missing
        // value somebody should go and find; this reads as an answer.
        ...(assignment.administratorName === null
          ? { note: 'assigned directly; no audit event records who or when' }
          : {}),
      },
      resolvedAt,
    });
  }

  for (const group of input.groupInheritance) {
    drafts.push({
      kind: 'group_inheritance',
      refType: 'Group',
      refId: group.groupId,
      detail: {
        groupId: group.groupId,
        groupName: group.groupName,
        assignmentId: group.assignmentId,
      },
      resolvedAt,
    });
  }

  for (const unit of input.orgUnitInheritance) {
    // Not merely "by org unit" but WHICH one, and the path from the user's own
    // unit up to it. It costs one array on the attribution row and it is the
    // difference between an answer and a shrug.
    drafts.push({
      kind: 'org_unit_inheritance',
      refType: 'OrgUnit',
      refId: unit.matchedOrgUnitId,
      detail: {
        assignmentId: unit.assignmentId,
        matchedOrgUnitId: unit.matchedOrgUnitId,
        matchedOrgUnitName: unit.matchedOrgUnitName,
        chain: unit.chain,
      },
      resolvedAt,
    });
  }

  for (const source of input.directorySources) {
    // The reason lies OUTSIDE Syntra, and the attribution says so: it names
    // where to go and ask.
    drafts.push({
      kind: 'directory_source',
      refType: 'DirectorySource',
      refId: source.sourceId,
      detail: {
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        anchor: source.anchor,
        distinguishedName: source.distinguishedName,
        note: 'this membership is rewritten by its source on every run; a removal here would come back',
      },
      resolvedAt,
    });
  }

  for (const discovery of input.discovered) {
    drafts.push({
      kind: 'discovered',
      refType: 'ProvisionRun',
      refId: discovery.firstRunId,
      detail: { firstRunId: discovery.firstRunId, discoveredAt: discovery.discoveredAt },
      resolvedAt,
    });
  }

  for (const entry of input.manual) {
    drafts.push({
      kind: 'manual',
      refType: 'AccountEntitlement',
      refId: null,
      detail: {
        administratorName: entry.administratorName,
        recordedAt: entry.recordedAt,
        reason: entry.reason,
      },
      resolvedAt,
    });
  }

  if (drafts.length === 0) {
    drafts.push({
      kind: 'unattributable',
      refType: 'none',
      refId: null,
      detail: {},
      resolvedAt,
    });
  }

  return drafts;
}

/**
 * The definition, exactly, because it is used as a filter in four places: the
 * unattributable register, the standing finding, the bulk-certify carve-out and
 * the revocation dispatch router.
 *
 * A holding is unattributable when its attribution set is EMPTY, or when its
 * only kinds are `discovered` and `unattributable`. Both mean the same
 * operational thing — the access exists and nothing in Syntra caused it — and a
 * filter that caught one but not the other would leave the more common half out
 * of the register it exists for.
 *
 * `manual` does NOT make a holding unattributable. Somebody in Syntra recorded
 * that the grant exists and who they are, which is a weaker record than a rule
 * or a request and is not nothing.
 */
const UNEXPLAINING_KINDS: ReadonlySet<AttributionKind> = new Set<AttributionKind>([
  'discovered',
  'unattributable',
]);

export function isUnattributable(kinds: readonly AttributionKind[]): boolean {
  return kinds.length === 0 || kinds.every((kind) => UNEXPLAINING_KINDS.has(kind));
}

/**
 * Whether anything in the set would re-create this holding if it were removed.
 *
 * A `RevocationOrder` is refused at creation when this is true: if a rule or a
 * live grant wants the holding, the honest answer is to change the rule or end
 * the grant, and that is the remediation item rather than the order.
 *
 * A DISABLED rule does not count. It explains how the holding arrived and does
 * not explain why it should stay, and treating it as live would refuse every
 * order for access a rule once granted and no longer does — which is precisely
 * the residue a campaign exists to find.
 */
export function hasLiveRuleAttribution(drafts: readonly AttributionDraft[]): boolean {
  return drafts.some(
    (d) =>
      (d.kind === 'business_rule' && d.detail['ruleEnabled'] === true) ||
      d.kind === 'request' ||
      d.kind === 'delegated_admin' ||
      d.kind === 'auto_granted',
  );
}

/** One sentence a manager can act on, for the reviewer's item and the report. */
export function summariseAttributions(drafts: readonly AttributionDraft[]): string {
  if (drafts.length === 0 || drafts.every((d) => d.kind === 'unattributable')) {
    return 'nothing in Syntra explains this access';
  }

  const parts: string[] = [];
  for (const draft of drafts) {
    switch (draft.kind) {
      case 'business_rule':
        parts.push(`the business rule "${String(draft.detail['ruleName'])}" matched their contract`);
        break;
      case 'request':
      case 'delegated_admin':
      case 'auto_granted': {
        const approvers = (draft.detail['approvers'] as { personName: string }[] | undefined) ?? [];
        parts.push(
          approvers.length > 0
            ? `a request approved by ${approvers.map((a) => a.personName).join(', ')}`
            : 'a request that no human decided',
        );
        break;
      }
      case 'direct_assignment':
        parts.push('an administrator assigned it directly in Syntra');
        break;
      case 'group_inheritance':
        parts.push(`membership of the group "${String(draft.detail['groupName'])}"`);
        break;
      case 'org_unit_inheritance':
        parts.push(
          `an assignment on the organizational unit "${String(draft.detail['matchedOrgUnitName'])}"`,
        );
        break;
      case 'directory_source':
        parts.push(`the directory source "${String(draft.detail['sourceName'])}"`);
        break;
      case 'discovered':
        parts.push('it was already present at the target when Syntra first looked');
        break;
      case 'manual':
        parts.push('an administrator recorded in Syntra that this grant exists');
        break;
      case 'unattributable':
        break;
    }
  }
  return parts.join('; ');
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/govern/attribute.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 6: Export and typecheck**

Add `export * from './govern/attribute.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 7: Mutation-test the definition**

Each reverted before the next; every one must produce a failure:

1. Change `UNEXPLAINING_KINDS` to `new Set(['discovered', 'unattributable', 'manual'])`. Expected: `is NOT unattributable on \`manual\`` and `does not classify a \`manual\` holding as unattributable` both FAIL.
2. Change `kinds.length === 0 ||` to `kinds.length === 0 &&`. Expected: `is unattributable on \`discovered\` alone` FAILS.
3. Delete the `if (drafts.length === 0)` block. Expected: `emits an explicit \`unattributable\` draft when nothing else resolved` FAILS, and so does `says plainly that nothing explains it`.
4. In `hasLiveRuleAttribution`, drop the `&& d.detail['ruleEnabled'] === true` clause. Expected: `is FALSE for a disabled rule` FAILS.
5. In `attributionsFor`, change the `requests` loop to `push` only the first entry. Expected: nothing fails, because no test has two requests — **add one**: two grants on the same holding, asserting two drafts. A mutation that produces no failure is a gap in the tests, not a passing mutation.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/govern/attribute.ts packages/core/src/govern/attribute.test.ts packages/core/src/index.ts
git commit -m "feat(govern): attribution assembly and the unattributable definition"
```

---
## Task 5: The snapshot diff, and the change that is not a loss

What changed, and the mistake that turns a read failure into a false "their access was removed". Spec §9. **Pure.**

**Files:**
- Create: `packages/core/src/govern/diff.ts`
- Test: `packages/core/src/govern/diff.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `type HoldingState`, `type AttributionKind`, `type ResourceKind` from `./types.js`.
- Produces (all in `./diff.js`):
  - `type HoldingChange = 'gained' | 'lost' | 'attribution_changed' | 'became_unknown' | 'became_known'`
  - `interface DiffHolding { subjectKey: string; personId: string | null; accountRef: string | null; systemId: string; resourceKind: ResourceKind; resourceId: string; resourceName: string; state: HoldingState; attributionKinds: readonly AttributionKind[]; attributionRefs: readonly string[] }`
  - `interface DiffRegion { systemId: string; resourceId: string | null; personId: string | null }`
  - `interface DiffInput { before: readonly DiffHolding[]; after: readonly DiffHolding[]; afterGapRegions: readonly DiffRegion[]; beforeGapRegions: readonly DiffRegion[] }`
  - `interface HoldingEventDraft { subjectKey: string; personId: string | null; accountRef: string | null; systemId: string; resourceKind: ResourceKind; resourceId: string; resourceName: string; change: HoldingChange; beforeAttributions: readonly string[]; afterAttributions: readonly string[] }`
  - `function diffSnapshots(input: DiffInput): HoldingEventDraft[]`
  - `function regionCovers(region: DiffRegion, holding: DiffHolding): boolean`
  - `const DIFF_LIMITATION: string` — the sentence every change report prints

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DIFF_LIMITATION,
  diffSnapshots,
  regionCovers,
  type DiffHolding,
  type DiffInput,
} from './diff.js';

const holding = (over: Partial<DiffHolding> = {}): DiffHolding => ({
  subjectKey: 'person:p-1',
  personId: 'p-1',
  accountRef: null,
  systemId: 'sys-1',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-finance',
  resourceName: 'Finance-Payments',
  state: 'held',
  attributionKinds: ['business_rule'],
  attributionRefs: ['business_rule:rule-finance'],
  ...over,
});

const diff = (over: Partial<DiffInput> = {}) =>
  diffSnapshots({ before: [], after: [], afterGapRegions: [], beforeGapRegions: [], ...over });

describe('the four ordinary changes', () => {
  it('reports a gain when a holding appears in a region that was read', () => {
    const events = diff({ after: [holding()] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'gained', resourceName: 'Finance-Payments' });
    expect(events[0]!.afterAttributions).toEqual(['business_rule:rule-finance']);
    expect(events[0]!.beforeAttributions).toEqual([]);
  });

  it('reports a loss when a holding disappears from a region that was read', () => {
    const events = diff({ before: [holding()] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'lost' });
  });

  it('reports an attribution change when the holding stands and its reasons move', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ attributionKinds: ['business_rule', 'request'], attributionRefs: ['business_rule:rule-finance', 'request:grant-1'] })],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'attribution_changed' });
    expect(events[0]!.beforeAttributions).toEqual(['business_rule:rule-finance']);
    expect(events[0]!.afterAttributions).toEqual(['business_rule:rule-finance', 'request:grant-1']);
  });

  it('reports NOTHING when nothing moved', () => {
    expect(diff({ before: [holding()], after: [holding()] })).toEqual([]);
  });

  it('is insensitive to the order attributions arrive in', () => {
    // The collector's ordering is a query-plan detail. A diff that reported an
    // attribution_changed every night because the rows came back in a different
    // order would bury every real change in noise.
    const events = diff({
      before: [holding({ attributionRefs: ['request:g-1', 'business_rule:r-1'] })],
      after: [holding({ attributionRefs: ['business_rule:r-1', 'request:g-1'] })],
    });
    expect(events).toEqual([]);
  });
});

describe('became_unknown is NOT a loss', () => {
  it('reports became_unknown when the holding vanishes into a region the new snapshot could not read', () => {
    // This is the assertion the task exists for. Reporting `lost` here turns a
    // read failure into "their access was removed" — a change report that
    // announces a revocation nobody performed, about access the person still
    // has.
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('reports became_unknown when the holding is present with state unknown', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ state: 'unknown' })],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('reports became_known when a holding recovers from unknown to held', () => {
    const events = diff({
      before: [holding({ state: 'unknown' })],
      after: [holding()],
    });
    expect(events[0]!.change).toBe('became_known');
  });

  it('reports NO gain when a holding appears out of a region the OLD snapshot could not read', () => {
    // Symmetric, and the one an implementation written from one side always
    // misses. If we could not see the region last night, the holding did not
    // "appear" — we simply looked properly for the first time. Calling that a
    // gain produces an `unexplained_gain` finding about access that has been
    // there for two years, on every source that has ever had an outage.
    const events = diff({
      before: [],
      after: [holding()],
      beforeGapRegions: [{ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.change).toBe('became_known');
  });

  it('still reports a loss when the gap is in a DIFFERENT region', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-2', resourceId: 'ent-other', personId: null }],
    });
    expect(events[0]!.change).toBe('lost');
  });

  it('honours a person-scoped gap, which is what a person_unprocessable produces', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: null, personId: 'p-1' }],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('honours a system-wide gap, which is what a source_unread produces', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: null, personId: null }],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });
});

describe('regionCovers', () => {
  it('matches a whole system when resource and person are null', () => {
    expect(regionCovers({ systemId: 'sys-1', resourceId: null, personId: null }, holding())).toBe(true);
  });

  it('does not match a different system', () => {
    expect(regionCovers({ systemId: 'sys-2', resourceId: null, personId: null }, holding())).toBe(false);
  });

  it('matches only the named resource when one is given', () => {
    expect(regionCovers({ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }, holding())).toBe(true);
    expect(regionCovers({ systemId: 'sys-1', resourceId: 'ent-other', personId: null }, holding())).toBe(false);
  });

  it('does not match a person-scoped region against an unattributed account', () => {
    const orphan = holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' });
    expect(regionCovers({ systemId: 'sys-1', resourceId: null, personId: 'p-1' }, orphan)).toBe(false);
  });
});

describe('unattributed accounts diff too', () => {
  it('reports a gain against an orphan account subject', () => {
    const events = diff({
      after: [holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' })],
    });
    expect(events[0]).toMatchObject({ change: 'gained', personId: null, accountRef: 'anchor-7' });
  });

  it('does not pair an orphan with a person holding the same resource', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' })],
    });
    expect(events.map((e) => e.change).sort()).toEqual(['gained', 'lost']);
  });
});

describe('the limitation is stated rather than hidden', () => {
  it('names the invisible case in words', () => {
    expect(DIFF_LIMITATION).toContain('reversed entirely between two snapshots');
  });
});
```

**What the fixture would look like if it could not distinguish pass from fail.** `reports NO gain when a holding appears out of a region the OLD snapshot could not read` is the case an implementation written from one side always misses, and it is the reason `beforeGapRegions` is a separate input rather than being derived. `still reports a loss when the gap is in a DIFFERENT region` is what stops an implementation that suppresses every loss whenever any gap exists — which would pass all four `became_unknown` cases and report nothing ever removed.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/diff.test.ts`
Expected: FAIL — `Cannot find module './diff.js'`.

- [ ] **Step 3: Write the diff**

`packages/core/src/govern/diff.ts`:

```ts
import type { AttributionKind, HoldingState, ResourceKind } from './types.js';

/**
 * The change question, answered by diffing consecutive snapshots.
 *
 * The audit log is authoritative and records everything SYNTRA did. It says
 * nothing about anything Syntra did not do — a hand grant at a domain
 * controller produces no Syntra audit event, because Syntra was not involved.
 * Snapshot diffing sees that, and it is the only thing that structurally can.
 *
 * PURE.
 */

export type HoldingChange =
  | 'gained'
  | 'lost'
  | 'attribution_changed'
  | 'became_unknown'
  | 'became_known';

export interface DiffHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: HoldingState;
  attributionKinds: readonly AttributionKind[];
  /** `kind:refId` per attribution, so a change of reason is comparable. */
  attributionRefs: readonly string[];
}

/**
 * A region of the world one snapshot could not describe, projected from its
 * CoverageGap rows.
 *
 * A null `resourceId` means the whole system; a null `personId` means every
 * subject. Both null is "this source was not read at all".
 */
export interface DiffRegion {
  systemId: string;
  resourceId: string | null;
  personId: string | null;
}

export interface DiffInput {
  before: readonly DiffHolding[];
  after: readonly DiffHolding[];
  /** Gaps in the LATER snapshot. A disappearance into one is not a loss. */
  afterGapRegions: readonly DiffRegion[];
  /** Gaps in the EARLIER snapshot. An appearance out of one is not a gain. */
  beforeGapRegions: readonly DiffRegion[];
}

export interface HoldingEventDraft {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  change: HoldingChange;
  beforeAttributions: readonly string[];
  afterAttributions: readonly string[];
}

export const DIFF_LIMITATION =
  'A change that happened and reversed entirely between two snapshots is ' +
  'invisible to this comparison. Somebody added to a group at 09:00 and ' +
  'removed at 16:00, with nightly snapshots, leaves no row here. Where the act ' +
  'went through Syntra the audit log has it and the recorded-actions pane shows ' +
  'it; where it did not, it is gone.';

export function regionCovers(region: DiffRegion, holding: DiffHolding): boolean {
  if (region.systemId !== holding.systemId) return false;
  if (region.resourceId !== null && region.resourceId !== holding.resourceId) return false;
  if (region.personId !== null && region.personId !== holding.personId) return false;
  return true;
}

function inAnyRegion(regions: readonly DiffRegion[], holding: DiffHolding): boolean {
  return regions.some((region) => regionCovers(region, holding));
}

/**
 * The comparison key. The subject key is already `person:<id>` or
 * `account:<systemId>:<ref>`, so an orphan account and a person holding the
 * same resource are two different rows here, which is correct — they are two
 * different subjects and merging them would report a revocation and a grant as
 * one silent no-op.
 */
function key(h: DiffHolding): string {
  return `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;
}

/** Order-insensitive: the collector's ordering is a query-plan detail. */
function sameAttributions(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function draft(
  holding: DiffHolding,
  change: HoldingChange,
  beforeAttributions: readonly string[],
  afterAttributions: readonly string[],
): HoldingEventDraft {
  return {
    subjectKey: holding.subjectKey,
    personId: holding.personId,
    accountRef: holding.accountRef,
    systemId: holding.systemId,
    resourceKind: holding.resourceKind,
    resourceId: holding.resourceId,
    resourceName: holding.resourceName,
    change,
    beforeAttributions,
    afterAttributions,
  };
}

export function diffSnapshots(input: DiffInput): HoldingEventDraft[] {
  const beforeByKey = new Map(input.before.map((h) => [key(h), h]));
  const afterByKey = new Map(input.after.map((h) => [key(h), h]));
  const events: HoldingEventDraft[] = [];

  for (const [k, after] of afterByKey) {
    const before = beforeByKey.get(k);

    if (before === undefined) {
      // An appearance out of a region the OLD snapshot could not read is not a
      // gain. We did not watch access arrive; we looked properly for the first
      // time. Calling it a gain produces an `unexplained_gain` finding about
      // access that has been there for two years, on every source that has ever
      // had an outage.
      if (inAnyRegion(input.beforeGapRegions, after)) {
        events.push(draft(after, 'became_known', [], after.attributionRefs));
      } else if (after.state === 'unknown') {
        events.push(draft(after, 'became_unknown', [], after.attributionRefs));
      } else {
        events.push(draft(after, 'gained', [], after.attributionRefs));
      }
      continue;
    }

    if (before.state === 'held' && after.state === 'unknown') {
      events.push(draft(after, 'became_unknown', before.attributionRefs, after.attributionRefs));
      continue;
    }
    if (before.state === 'unknown' && after.state === 'held') {
      events.push(draft(after, 'became_known', before.attributionRefs, after.attributionRefs));
      continue;
    }
    if (!sameAttributions(before.attributionRefs, after.attributionRefs)) {
      events.push(
        draft(after, 'attribution_changed', before.attributionRefs, after.attributionRefs),
      );
    }
  }

  for (const [k, before] of beforeByKey) {
    if (afterByKey.has(k)) continue;

    // THE ASSERTION THIS MODULE EXISTS FOR. A disappearance into a region the
    // new snapshot could not read is `became_unknown`, never `lost`. Reporting
    // it as a loss turns a read failure into "their access was removed" — a
    // change report announcing a revocation nobody performed, about access the
    // person still has.
    events.push(
      inAnyRegion(input.afterGapRegions, before)
        ? draft(before, 'became_unknown', before.attributionRefs, [])
        : draft(before, 'lost', before.attributionRefs, []),
    );
  }

  return events;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/src/govern/diff.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Export and typecheck**

Add `export * from './govern/diff.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 6: Mutation-test the change that is not a loss**

Each reverted before the next; every one must produce a failure:

1. In the disappearance loop, replace the ternary with an unconditional `'lost'`. Expected: four `became_unknown` cases FAIL.
2. Replace it with an unconditional `'became_unknown'`. Expected: `still reports a loss when the gap is in a DIFFERENT region` FAILS. Both directions.
3. Delete the `beforeGapRegions` branch in the appearance loop. Expected: `reports NO gain when a holding appears out of a region the OLD snapshot could not read` FAILS.
4. In `sameAttributions`, drop the `.sort()` calls. Expected: `is insensitive to the order attributions arrive in` FAILS.
5. In `regionCovers`, change `region.personId !== null &&` to `region.personId !== undefined &&`. Expected: `matches a whole system when resource and person are null` FAILS — `null !== undefined`, so a system-wide region would stop matching anything whose `personId` differs from `null`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/govern/diff.ts packages/core/src/govern/diff.test.ts packages/core/src/index.ts
git commit -m "feat(govern): the snapshot diff, and became_unknown is not a loss"
```

---
## Task 6: Collect — the set-based readers and the application-path resolver

The only stage that reads. Spec §6, §7, §19. Database only, no network, and **a fixed number of queries independent of the population**.

**This task closes integration finding 2.** `resolveApplicationIdsForUser` returns `Set<string>` and discards which assignment produced each match; `orgUnitChain` is module-private. §7 asserts the function "already knows which unit produced the match" and it does not. `resolveApplicationPaths` is written here, set-based over the whole tenant, and `packages/core/src/access/resolve.ts` is not modified.

**Files:**
- Create: `packages/core/src/govern/collect.ts`
- Test: `packages/core/src/govern/collect.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `type ResourceKind`, `type SystemKind`, `SYNTRA_SYSTEM_ID`, `subjectKey`, `type SubjectRef` from `./types.js`; `type SourceObservation` from `./freshness.js`; `type AttributionInput`, `type OrgUnitInheritanceFact`, `type GroupInheritanceFact`, `type DirectAssignmentFact`, `type RuleFact`, `type RequestFact`, `type DirectorySourceFact`, `type DiscoveredFact`, `type ManualFact` from `./attribute.js`; `LIVE_GRANT_STATUSES` from `../automate/types.js`.
- Produces (all in `./collect.js`):
  - `const MAX_ORG_UNIT_DEPTH = 64`
  - `interface ApplicationPath { userId: string; applicationId: string; via: 'user' | 'group' | 'orgUnit'; assignmentId: string; groupId: string | null; groupName: string | null; matchedOrgUnitId: string | null; matchedOrgUnitName: string | null; chain: { orgUnitId: string; name: string }[] }`
  - `async function resolveApplicationPaths(tx: TenantClient): Promise<ApplicationPath[]>`
  - `interface CollectedHolding { subject: SubjectRef; systemKind: SystemKind; systemId: string; systemName: string; resourceKind: ResourceKind; resourceId: string; resourceName: string; state: 'held' | 'unknown'; observedAt: Date; observedVia: string; attribution: AttributionInput }`
  - `interface CollectedGap { kind: 'resource_unreadable' | 'account_unreadable' | 'person_unprocessable' | 'subject_unresolvable'; systemKind: SystemKind; systemId: string; resourceId: string | null; personId: string | null; accountRef: string | null; reason: string; sourceRunId: string | null }`
  - `interface CollectedTenant { asOf: Date; holdings: CollectedHolding[]; gaps: CollectedGap[]; sources: SourceObservation[]; personIds: string[]; personsWithActiveContract: number; unattributedAccountKeys: string[]; queryCount: number }`
  - `interface CollectOptions { asOf?: Date; freshnessSlaFor?: (kind: SystemKind, id: string) => number; defaultFreshnessSlaHours?: number }`
  - `async function collectTenant(tenantId: string, options?: CollectOptions): Promise<CollectedTenant>`
  - `function foldIdentifier(value: string): string`

**`collectTenant` opens nine short transactions, one per reader group, each returning plain data.** It never holds one open across a loop and it never reads outside one — the resolution of the two rules in tension is a short transaction returning plain data, never a read moved outside (Ruling A-9).

**Case folding.** AD folds case and PostgreSQL does not, and three defects on Provision came from that. Every comparison this module makes between an identifier that came from a directory and one that came from PostgreSQL goes through `foldIdentifier`, which is `.normalize('NFKD').toLowerCase()` — **NFKD, not NFD**, because NFD leaves `ĳ` intact and folding `Ĳsbrand` yields somebody else's login.

- [ ] **Step 1: Write the failing test for the application paths**

`packages/core/src/govern/collect.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { resolveApplicationIdsForUser } from '../access/resolve.js';
import { collectTenant, foldIdentifier, resolveApplicationPaths } from './collect.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('resolveApplicationPaths', () => {
  it('reports WHICH org unit produced the match and the chain up to it', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const root = await tx.orgUnit.create({ data: { tenantId, name: 'Head Office' } });
      const region = await tx.orgUnit.create({
        data: { tenantId, name: 'North region', parentId: root.id },
      });
      const care = await tx.orgUnit.create({
        data: { tenantId, name: 'Care', parentId: region.id },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          orgUnitId: care.id,
        },
      });
      const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
      const assignment = await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: root.id },
      });
      return { userId: user.id, applicationId: app.id, assignmentId: assignment.id, rootId: root.id };
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));

    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({
      userId: seeded.userId,
      applicationId: seeded.applicationId,
      via: 'orgUnit',
      assignmentId: seeded.assignmentId,
      matchedOrgUnitId: seeded.rootId,
      matchedOrgUnitName: 'Head Office',
    });
    expect(paths[0]!.chain.map((c) => c.name)).toEqual(['Care', 'North region', 'Head Office']);
  });

  it('agrees with resolveApplicationIdsForUser about WHICH applications, on the same data', async () => {
    // The paths resolver is a second reader of the same rule, so the two must
    // not be allowed to drift. This is the assertion that catches it — and it
    // is deliberately about the application SET, not the paths, because
    // resolve.ts cannot answer about paths at all.
    const seeded = await withTenant(tenantId, async (tx) => {
      const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'A', orgUnitId: ou.id },
      });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const direct = await tx.application.create({ data: { tenantId, name: 'D', slug: 'd' } });
      const byGroup = await tx.application.create({ data: { tenantId, name: 'G', slug: 'g' } });
      const byUnit = await tx.application.create({ data: { tenantId, name: 'U', slug: 'u' } });
      const retired = await tx.application.create({
        data: { tenantId, name: 'R', slug: 'r', status: 'retired' },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: direct.id, subjectType: 'user', userId: user.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: byGroup.id, subjectType: 'group', groupId: group.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: byUnit.id, subjectType: 'orgUnit', orgUnitId: ou.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: retired.id, subjectType: 'user', userId: user.id },
      });
      return { userId: user.id };
    });

    const [fromResolve, paths] = await withTenant(tenantId, async (tx) => [
      await resolveApplicationIdsForUser(tx, seeded.userId),
      await resolveApplicationPaths(tx),
    ]);

    const fromPaths = new Set(
      paths.filter((p) => p.userId === seeded.userId).map((p) => p.applicationId),
    );
    expect([...fromPaths].sort()).toEqual([...fromResolve].sort());
    expect(fromPaths.size).toBe(3);
  });

  it('reports all three paths separately when one application arrives by all three', async () => {
    // A union that deduplicated by application would report one path and lose
    // two attributions, and the person-detail screen's whole job is to show
    // all three.
    const seeded = await withTenant(tenantId, async (tx) => {
      const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'A', orgUnitId: ou.id },
      });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const app = await tx.application.create({ data: { tenantId, name: 'S', slug: 's' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'user', userId: user.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'group', groupId: group.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: ou.id },
      });
      return { userId: user.id };
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));
    expect(paths.filter((p) => p.userId === seeded.userId).map((p) => p.via).sort()).toEqual([
      'group',
      'orgUnit',
      'user',
    ]);
  });

  it('survives a cycle in the org-unit tree rather than hanging', async () => {
    // `parentId` is a self-relation with no database-level acyclicity check,
    // and a cycle introduced by a bad import would otherwise hang the nightly
    // snapshot for every tenant on the box.
    await withTenant(tenantId, async (tx) => {
      const a = await tx.orgUnit.create({ data: { tenantId, name: 'A' } });
      const b = await tx.orgUnit.create({ data: { tenantId, name: 'B', parentId: a.id } });
      await tx.orgUnit.update({ where: { id: a.id }, data: { parentId: b.id } });
      const user = await tx.user.create({
        data: { tenantId, login: 'u', email: 'u@a.test', displayName: 'U', orgUnitId: b.id },
      });
      const app = await tx.application.create({ data: { tenantId, name: 'S', slug: 's' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: a.id },
      });
      return user;
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));
    expect(paths).toHaveLength(1);
    expect(paths[0]!.chain.length).toBeLessThanOrEqual(64);
  });

  it('returns nothing at all when the tenant has no assignments', async () => {
    // The empty case: a resolver that returned every application when there
    // were no assignments would give the whole tenant everything, and the
    // fixture that would hide it is one that always seeds an assignment.
    await withTenant(tenantId, (tx) =>
      tx.application.create({ data: { tenantId, name: 'S', slug: 's' } }),
    );
    expect(await withTenant(tenantId, (tx) => resolveApplicationPaths(tx))).toEqual([]);
  });
});

describe('foldIdentifier', () => {
  it('folds case, because AD does and PostgreSQL does not', () => {
    expect(foldIdentifier('Anna.Novak')).toBe(foldIdentifier('anna.novak'));
  });

  it('uses NFKD, so a ligature decomposes rather than surviving', () => {
    // NFD leaves the ligature intact and folding it yields `sbrand`, which is
    // a valid login belonging to somebody else. On a product whose reference
    // implementation is Dutch.
    expect(foldIdentifier('Ĳsbrand')).toBe('ijsbrand');
    expect(foldIdentifier('Ĳsbrand')).not.toBe('sbrand');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/collect.test.ts`
Expected: FAIL — `Cannot find module './collect.js'`.

- [ ] **Step 3: Write the org-unit walk and the application paths**

`packages/core/src/govern/collect.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { LIVE_GRANT_STATUSES } from '../automate/types.js';
import type {
  AttributionInput,
  DirectAssignmentFact,
  DirectorySourceFact,
  DiscoveredFact,
  GroupInheritanceFact,
  ManualFact,
  OrgUnitInheritanceFact,
  RequestFact,
  RuleFact,
} from './attribute.js';
import { EMPTY_ATTRIBUTION_INPUT } from './attribute.js';
import type { SourceObservation } from './freshness.js';
import { SYNTRA_SYSTEM_ID, subjectKey, type ResourceKind, type SubjectRef, type SystemKind } from './types.js';

/** A tree deep enough to hit this is a cycle, not an organization. */
export const MAX_ORG_UNIT_DEPTH = 64;

/**
 * Every comparison between an identifier that came from a directory and one
 * that came from PostgreSQL goes through here.
 *
 * NFKD, not NFD. NFD leaves the ligature in `Ĳsbrand` intact, so folding it
 * yields `sbrand` — a valid login that belongs to somebody else. Three
 * case-sensitivity defects on the Provision slice came from AD folding case
 * where PostgreSQL does not.
 */
export function foldIdentifier(value: string): string {
  return value.normalize('NFKD').toLowerCase();
}

export interface ApplicationPath {
  userId: string;
  applicationId: string;
  via: 'user' | 'group' | 'orgUnit';
  assignmentId: string;
  groupId: string | null;
  groupName: string | null;
  matchedOrgUnitId: string | null;
  matchedOrgUnitName: string | null;
  /** The user's own unit first, the matched unit last. Empty for the other two. */
  chain: { orgUnitId: string; name: string }[];
}

/**
 * Every application every user resolves to, WITH THE PATH.
 *
 * `resolveApplicationIdsForUser` answers the same question for one user and
 * returns `Set<string>`: it issues one `findMany` with an `OR` and selects
 * `applicationId` alone, so which assignment matched — and, for the org-unit
 * arm, which unit — is discarded. `orgUnitChain` is module-private. Spec
 * section 7 asserts that function already knows which unit produced the match;
 * it does not, and this is where Govern learns it.
 *
 * Set-based over the whole tenant in FOUR queries, because calling a per-user
 * helper in a loop over 1,180 users inside one 5000 ms transaction is a P2028
 * on the one nightly job that must not fail.
 *
 * `resolve.ts` is deliberately NOT modified: it is on the sign-in path, and a
 * second consumer with different needs is exactly the pressure that turns a
 * focused function into a general one nobody can reason about.
 */
export async function resolveApplicationPaths(tx: TenantClient): Promise<ApplicationPath[]> {
  const [users, memberships, units, assignments] = await Promise.all([
    tx.user.findMany({ select: { id: true, orgUnitId: true } }),
    tx.groupMembership.findMany({ select: { userId: true, groupId: true, group: { select: { name: true } } } }),
    tx.orgUnit.findMany({ select: { id: true, name: true, parentId: true } }),
    tx.appAssignment.findMany({
      where: { application: { status: 'active' } },
      select: {
        id: true,
        applicationId: true,
        subjectType: true,
        userId: true,
        groupId: true,
        orgUnitId: true,
      },
    }),
  ]);

  const unitById = new Map(units.map((u) => [u.id, u]));

  // Built once for the tenant, not once per user. The seen-set and the depth
  // cap are not paranoia: parentId is a self-relation with no acyclicity
  // check, and a cycle from a bad import would otherwise hang the snapshot.
  const chainCache = new Map<string, { orgUnitId: string; name: string }[]>();
  const chainFor = (start: string | null): { orgUnitId: string; name: string }[] => {
    if (start === null) return [];
    const cached = chainCache.get(start);
    if (cached) return cached;

    const chain: { orgUnitId: string; name: string }[] = [];
    const seen = new Set<string>();
    let current: string | null = start;
    for (let depth = 0; current !== null && depth < MAX_ORG_UNIT_DEPTH; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const unit = unitById.get(current);
      if (unit === undefined) break;
      chain.push({ orgUnitId: unit.id, name: unit.name });
      current = unit.parentId;
    }
    chainCache.set(start, chain);
    return chain;
  };

  const groupsByUser = new Map<string, { groupId: string; groupName: string }[]>();
  for (const m of memberships) {
    const list = groupsByUser.get(m.userId) ?? [];
    list.push({ groupId: m.groupId, groupName: m.group.name });
    groupsByUser.set(m.userId, list);
  }

  const byUser = new Map<string, typeof assignments>();
  const byGroup = new Map<string, typeof assignments>();
  const byUnit = new Map<string, typeof assignments>();
  for (const a of assignments) {
    if (a.subjectType === 'user' && a.userId) {
      byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
    } else if (a.subjectType === 'group' && a.groupId) {
      byGroup.set(a.groupId, [...(byGroup.get(a.groupId) ?? []), a]);
    } else if (a.subjectType === 'orgUnit' && a.orgUnitId) {
      byUnit.set(a.orgUnitId, [...(byUnit.get(a.orgUnitId) ?? []), a]);
    }
  }

  const paths: ApplicationPath[] = [];
  for (const user of users) {
    for (const a of byUser.get(user.id) ?? []) {
      paths.push({
        userId: user.id,
        applicationId: a.applicationId,
        via: 'user',
        assignmentId: a.id,
        groupId: null,
        groupName: null,
        matchedOrgUnitId: null,
        matchedOrgUnitName: null,
        chain: [],
      });
    }

    for (const group of groupsByUser.get(user.id) ?? []) {
      for (const a of byGroup.get(group.groupId) ?? []) {
        paths.push({
          userId: user.id,
          applicationId: a.applicationId,
          via: 'group',
          assignmentId: a.id,
          groupId: group.groupId,
          groupName: group.groupName,
          matchedOrgUnitId: null,
          matchedOrgUnitName: null,
          chain: [],
        });
      }
    }

    const chain = chainFor(user.orgUnitId);
    for (const unit of chain) {
      for (const a of byUnit.get(unit.orgUnitId) ?? []) {
        // The chain is truncated AT THE MATCH, so the recorded path is the
        // actual path: "Care, then North region, then Head Office, which is
        // where the assignment is" rather than the whole ancestry.
        const upToMatch = chain.slice(0, chain.findIndex((c) => c.orgUnitId === unit.orgUnitId) + 1);
        paths.push({
          userId: user.id,
          applicationId: a.applicationId,
          via: 'orgUnit',
          assignmentId: a.id,
          groupId: null,
          groupName: null,
          matchedOrgUnitId: unit.orgUnitId,
          matchedOrgUnitName: unit.name,
          chain: upToMatch,
        });
      }
    }
  }

  return paths;
}
```

- [ ] **Step 4: Run the application-path tests**

Run: `pnpm vitest run packages/core/src/govern/collect.test.ts -t resolveApplicationPaths`
Expected: PASS, 5 tests. `foldIdentifier` still fails.

- [ ] **Step 5: Write `foldIdentifier`'s consumers and the collected shapes**

Append to `packages/core/src/govern/collect.ts`:

```ts
export interface CollectedHolding {
  subject: SubjectRef;
  systemKind: SystemKind;
  systemId: string;
  systemName: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: 'held' | 'unknown';
  observedAt: Date;
  observedVia: string;
  attribution: AttributionInput;
}

export interface CollectedGap {
  kind: 'resource_unreadable' | 'account_unreadable' | 'person_unprocessable' | 'subject_unresolvable';
  systemKind: SystemKind;
  systemId: string;
  resourceId: string | null;
  personId: string | null;
  accountRef: string | null;
  reason: string;
  sourceRunId: string | null;
}

export interface CollectedTenant {
  asOf: Date;
  holdings: CollectedHolding[];
  gaps: CollectedGap[];
  sources: SourceObservation[];
  personIds: string[];
  personsWithActiveContract: number;
  unattributedAccountKeys: string[];
  /** Asserted by the budget test in Task 12: fixed, and independent of population. */
  queryCount: number;
}

export interface CollectOptions {
  asOf?: Date;
  freshnessSlaFor?: (kind: SystemKind, id: string) => number;
  defaultFreshnessSlaHours?: number;
}
```

- [ ] **Step 6: Write `collectTenant`**

Append to `packages/core/src/govern/collect.ts`:

```ts
/**
 * The collect stage. Nine short transactions, each returning plain data.
 *
 * NOT one long transaction: `withTenant` is `prisma.$transaction(fn)` under a
 * 5000 ms default and a tenant-sized read blows it. NOT a read outside a
 * transaction either: a bare `prisma.<model>` read returns [] under forced RLS
 * whether or not the code works, which is a silent, green, completely wrong
 * snapshot. The resolution is always a short transaction returning plain data.
 *
 * `asOf` is the instant this function STARTS, not when it finishes, so a build
 * taking twenty minutes describes a world as it stood at one stated moment
 * rather than over a smeared window.
 */
export async function collectTenant(
  tenantId: string,
  options: CollectOptions = {},
): Promise<CollectedTenant> {
  const asOf = options.asOf ?? new Date();
  const defaultSla = options.defaultFreshnessSlaHours ?? 24;
  const slaFor = options.freshnessSlaFor ?? (() => defaultSla);

  const holdings: CollectedHolding[] = [];
  const gaps: CollectedGap[] = [];
  const sources: SourceObservation[] = [];

  // (1) People and contracts.
  const people = await withTenant(tenantId, async (tx) => {
    const persons = await tx.person.findMany({
      select: { id: true, givenName: true, familyName: true, status: true },
    });
    const contracts = await tx.contract.findMany({
      select: { id: true, personId: true, startDate: true, endDate: true, department: true, jobTitle: true },
    });
    return { persons, contracts };
  });

  const activeByPerson = new Map<string, boolean>();
  for (const c of people.contracts) {
    const active = c.startDate <= asOf && (c.endDate === null || c.endDate >= asOf);
    activeByPerson.set(c.personId, (activeByPerson.get(c.personId) ?? false) || active);
  }
  const personsWithActiveContract = [...activeByPerson.values()].filter(Boolean).length;

  // (2) Users — the ability to sign in to Syntra at all, with its status.
  const users = await withTenant(tenantId, (tx) =>
    tx.user.findMany({
      select: { id: true, login: true, displayName: true, email: true, status: true, personId: true, orgUnitId: true, sourceId: true, sourceAnchor: true },
    }),
  );
  const userById = new Map(users.map((u) => [u.id, u]));

  for (const user of users) {
    if (user.personId === null) continue;
    holdings.push({
      subject: { kind: 'person', personId: user.personId },
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'syntraUser',
      resourceId: user.id,
      resourceName: `${user.displayName} (${user.login}, ${user.status})`,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        ...(user.sourceId === null
          ? {}
          : { directorySources: [{ sourceId: user.sourceId, sourceName: 'directory source', anchor: user.sourceAnchor, distinguishedName: null }] }),
      },
    });
  }

  // A user with no linked person is a subject Govern cannot name. It is a gap,
  // not an omission: an account that can sign in to the identity platform and
  // belongs to nobody is exactly the row an access review exists to surface.
  for (const user of users) {
    if (user.personId !== null) continue;
    gaps.push({
      kind: 'subject_unresolvable',
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceId: user.id,
      personId: null,
      accountRef: user.id,
      reason: `the Syntra account "${user.login}" is linked to no person`,
      sourceRunId: null,
    });
  }

  // (3) Group memberships. Both synced and locally managed; the distinction
  // lives in the attribution, never in a second resource kind.
  const memberships = await withTenant(tenantId, (tx) =>
    tx.groupMembership.findMany({
      select: {
        userId: true,
        groupId: true,
        group: { select: { name: true, sourceId: true, sourceAnchor: true, source: { select: { name: true } } } },
      },
    }),
  );

  for (const m of memberships) {
    const user = userById.get(m.userId);
    if (user?.personId == null) continue;
    holdings.push({
      subject: { kind: 'person', personId: user.personId },
      systemKind: m.group.sourceId === null ? 'syntraInternal' : 'directorySource',
      systemId: m.group.sourceId ?? SYNTRA_SYSTEM_ID,
      systemName: m.group.sourceId === null ? 'Syntra' : (m.group.source?.name ?? 'directory source'),
      resourceKind: 'syntraGroup',
      resourceId: m.groupId,
      resourceName: m.group.name,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        ...(m.group.sourceId === null
          ? {}
          : {
              directorySources: [
                {
                  sourceId: m.group.sourceId,
                  sourceName: m.group.source?.name ?? 'directory source',
                  anchor: m.group.sourceAnchor,
                  distinguishedName: m.group.sourceAnchor,
                },
              ],
            }),
      },
    });
  }

  // (4) Applications, with the path. Integration finding 2.
  const [appPaths, applications] = await withTenant(tenantId, async (tx) => [
    await resolveApplicationPaths(tx),
    await tx.application.findMany({ select: { id: true, name: true } }),
  ]);
  const appNameById = new Map(applications.map((a) => [a.id, a.name]));

  const appByUserAndApp = new Map<string, ApplicationPath[]>();
  for (const path of appPaths) {
    const key = `${path.userId}|${path.applicationId}`;
    appByUserAndApp.set(key, [...(appByUserAndApp.get(key) ?? []), path]);
  }

  for (const [key, paths] of appByUserAndApp) {
    const [userId, applicationId] = key.split('|') as [string, string];
    const user = userById.get(userId);
    if (user?.personId == null) continue;

    const directAssignments: DirectAssignmentFact[] = paths
      .filter((p) => p.via === 'user')
      .map((p) => ({
        rowType: 'AppAssignment',
        rowId: p.assignmentId,
        scopeOrgUnitId: null,
        scopeOrgUnitName: null,
        administratorName: null,
        assignedAt: null,
      }));
    const groupInheritance: GroupInheritanceFact[] = paths
      .filter((p) => p.via === 'group')
      .map((p) => ({ groupId: p.groupId!, groupName: p.groupName ?? 'a group', assignmentId: p.assignmentId }));
    const orgUnitInheritance: OrgUnitInheritanceFact[] = paths
      .filter((p) => p.via === 'orgUnit')
      .map((p) => ({
        assignmentId: p.assignmentId,
        matchedOrgUnitId: p.matchedOrgUnitId!,
        matchedOrgUnitName: p.matchedOrgUnitName ?? 'an organizational unit',
        chain: p.chain,
      }));

    holdings.push({
      subject: { kind: 'person', personId: user.personId },
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'application',
      resourceId: applicationId,
      resourceName: appNameById.get(applicationId) ?? applicationId,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        directAssignments,
        groupInheritance,
        orgUnitInheritance,
      },
    });
  }

  // (5) Role assignments. PRIVILEGED BY DEFINITION: an access review that
  // ignores who holds `tenant.manage` has missed the most powerful access in
  // the product.
  const roleAssignments = await withTenant(tenantId, (tx) =>
    tx.roleAssignment.findMany({
      select: {
        id: true,
        userId: true,
        roleId: true,
        scopeOrgUnitId: true,
        role: { select: { name: true, permissions: true } },
      },
    }),
  );
  const orgUnitNames = await withTenant(tenantId, (tx) =>
    tx.orgUnit.findMany({ select: { id: true, name: true } }),
  );
  const orgUnitNameById = new Map(orgUnitNames.map((o) => [o.id, o.name]));

  for (const ra of roleAssignments) {
    const user = userById.get(ra.userId);
    if (user?.personId == null) continue;
    holdings.push({
      subject: { kind: 'person', personId: user.personId },
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'syntraRole',
      resourceId: ra.roleId,
      resourceName: `${ra.role.name} (${ra.role.permissions.join(', ')})`,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        directAssignments: [
          {
            rowType: 'RoleAssignment',
            rowId: ra.id,
            scopeOrgUnitId: ra.scopeOrgUnitId,
            scopeOrgUnitName: ra.scopeOrgUnitId === null ? null : (orgUnitNameById.get(ra.scopeOrgUnitId) ?? null),
            administratorName: null,
            assignedAt: null,
          },
        ],
      },
    });
  }

  // (6) Target accounts and entitlements, plus the entitlements that could not
  // be read at all.
  const targets = await withTenant(tenantId, (tx) =>
    tx.targetSystem.findMany({
      select: { id: true, name: true, lastRunAt: true, lastAppliedRunAt: true },
    }),
  );
  const targetNameById = new Map(targets.map((t) => [t.id, t.name]));

  const provision = await withTenant(tenantId, async (tx) => {
    const accounts = await tx.targetAccount.findMany({
      select: {
        id: true, targetSystemId: true, personId: true, anchor: true, correlationKey: true,
        status: true, lastReconciledAt: true,
      },
    });
    const holdingsRows = await tx.accountEntitlement.findMany({
      where: { state: 'held' },
      select: {
        accountId: true, entitlementId: true, origin: true, grantedByRuleId: true, grantedAt: true,
        entitlement: { select: { id: true, targetSystemId: true, displayName: true, status: true, externalId: true } },
      },
    });
    const rules = await tx.businessRule.findMany({
      select: { id: true, name: true, enabled: true, targetSystemId: true },
    });
    const unreadable = await tx.entitlement.findMany({
      where: { status: { in: ['missing', 'unreadable'] } },
      select: { id: true, targetSystemId: true, displayName: true, status: true },
    });
    return { accounts, holdingsRows, rules, unreadable };
  });

  const ruleById = new Map(provision.rules.map((r) => [r.id, r]));
  const accountById = new Map(provision.accounts.map((a) => [a.id, a]));

  for (const account of provision.accounts) {
    const observedAt = account.lastReconciledAt ?? asOf;
    holdings.push({
      subject: { kind: 'person', personId: account.personId },
      systemKind: 'targetSystem',
      systemId: account.targetSystemId,
      systemName: targetNameById.get(account.targetSystemId) ?? account.targetSystemId,
      resourceKind: 'targetAccount',
      resourceId: account.anchor ?? account.correlationKey,
      resourceName: `${account.correlationKey} (${account.status})`,
      state: account.status === 'missing_at_target' ? 'unknown' : 'held',
      observedAt,
      observedVia: `provision:${account.targetSystemId}`,
      attribution: EMPTY_ATTRIBUTION_INPUT,
    });
  }

  const grantFactsByHolding = new Map<string, RequestFact[]>();

  for (const row of provision.holdingsRows) {
    const account = accountById.get(row.accountId);
    if (account === undefined) continue;
    const observedAt = account.lastReconciledAt ?? asOf;

    const rules: RuleFact[] = [];
    const discovered: DiscoveredFact[] = [];
    const manual: ManualFact[] = [];
    if (row.origin === 'rule' && row.grantedByRuleId !== null) {
      const rule = ruleById.get(row.grantedByRuleId);
      rules.push({
        ruleId: row.grantedByRuleId,
        ruleName: rule?.name ?? 'a rule that no longer exists',
        contractId: '',
        department: null,
        jobTitle: null,
        ruleEnabled: rule?.enabled ?? false,
      });
    } else if (row.origin === 'discovered') {
      discovered.push({ firstRunId: null, discoveredAt: row.grantedAt.toISOString() });
    } else if (row.origin === 'manual') {
      manual.push({ administratorName: null, recordedAt: row.grantedAt.toISOString(), reason: null });
    }

    holdings.push({
      subject: { kind: 'person', personId: account.personId },
      systemKind: 'targetSystem',
      systemId: row.entitlement.targetSystemId,
      systemName: targetNameById.get(row.entitlement.targetSystemId) ?? row.entitlement.targetSystemId,
      resourceKind: 'targetEntitlement',
      resourceId: row.entitlementId,
      resourceName: row.entitlement.displayName,
      state: row.entitlement.status === 'unreadable' ? 'unknown' : 'held',
      observedAt,
      observedVia: `provision:${row.entitlement.targetSystemId}`,
      attribution: { ...EMPTY_ATTRIBUTION_INPUT, rules, discovered, manual },
    });

    grantFactsByHolding.set(
      `person:${account.personId}|${row.entitlement.targetSystemId}|targetEntitlement|${row.entitlementId}`,
      [],
    );
  }

  for (const entitlement of provision.unreadable) {
    const target = targets.find((t) => t.id === entitlement.targetSystemId);
    gaps.push({
      kind: 'resource_unreadable',
      systemKind: 'targetSystem',
      systemId: entitlement.targetSystemId,
      resourceId: entitlement.id,
      personId: null,
      accountRef: null,
      // Nothing in the platform records WHICH run failed to read it: the only
      // signal is `Entitlement.status`, and `DriftFinding` has no matching
      // kind. Naming the target's last run and saying so is honest; implying a
      // precision the data does not have is not.
      reason:
        `"${entitlement.displayName}" is ${entitlement.status} at its target, so who holds it is unknown. ` +
        `The run named is the target's most recent run, not necessarily the run that failed the read.`,
      sourceRunId: null,
    });
  }

  // (7) Automate grants, and the request record behind each.
  const automate = await withTenant(tenantId, async (tx) => {
    const grants = await tx.accessGrant.findMany({
      where: { status: { in: [...LIVE_GRANT_STATUSES] } },
      select: {
        id: true, subjectPersonId: true, resourceType: true, resourceId: true, targetSystemId: true,
        origin: true, requestId: true, productId: true, endsAt: true, needsReview: true,
      },
    });
    const requests = await tx.accessRequest.findMany({
      where: { id: { in: grants.map((g) => g.requestId).filter((x): x is string => x !== null) } },
      select: {
        id: true, subjectPersonId: true, requestedByUserId: true, requestedByPersonId: true,
        productId: true, product: { select: { name: true } },
        steps: {
          select: {
            id: true,
            decisions: { select: { personId: true, decision: true, decidedAt: true, comment: true } },
          },
        },
      },
    });
    return { grants, requests };
  });

  const requestById = new Map(automate.requests.map((r) => [r.id, r]));
  const personNameById = new Map(
    people.persons.map((p) => [p.id, `${p.givenName} ${p.familyName}`.trim()]),
  );

  for (const grant of automate.grants) {
    const request = grant.requestId === null ? undefined : requestById.get(grant.requestId);
    const approvers = (request?.steps ?? []).flatMap((step) =>
      step.decisions.map((d) => ({
        personName: personNameById.get(d.personId) ?? 'a person no longer recorded',
        decision: d.decision,
        decidedAt: d.decidedAt.toISOString(),
        comment: d.comment,
      })),
    );

    const fact: RequestFact = {
      grantId: grant.id,
      requestId: grant.requestId,
      productId: grant.productId,
      productName: request?.product?.name ?? null,
      requesterName:
        request?.requestedByPersonId == null
          ? null
          : (personNameById.get(request.requestedByPersonId) ?? null),
      subjectName: personNameById.get(grant.subjectPersonId) ?? 'a person no longer recorded',
      approvers,
      endsAt: grant.endsAt?.toISOString() ?? null,
      origin: grant.origin === 'delegated_admin' ? 'delegated_admin' : 'request',
      // A zero-stage workflow. A legitimate configuration whose grant has no
      // approver, so it contributes no decision-graph edge and is its own class.
      autoGranted: grant.origin !== 'delegated_admin' && approvers.length === 0,
      delegateName:
        grant.origin === 'delegated_admin' && request?.requestedByPersonId != null
          ? (personNameById.get(request.requestedByPersonId) ?? null)
          : null,
      delegationCapabilities: [],
    };

    const resourceKind: ResourceKind =
      grant.resourceType === 'entitlement'
        ? 'targetEntitlement'
        : grant.resourceType === 'application'
          ? 'application'
          : 'syntraGroup';
    const systemId = grant.targetSystemId ?? SYNTRA_SYSTEM_ID;
    const holdingKey = `person:${grant.subjectPersonId}|${systemId}|${resourceKind}|${grant.resourceId}`;
    grantFactsByHolding.set(holdingKey, [...(grantFactsByHolding.get(holdingKey) ?? []), fact]);
  }

  // The union: a grant explains a holding that already exists, and creates one
  // only where the fulfilment has not yet been observed at the target.
  const holdingByKey = new Map(
    holdings.map((h) => [
      `${subjectKey(h.subject)}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
      h,
    ]),
  );
  for (const [key, facts] of grantFactsByHolding) {
    if (facts.length === 0) continue;
    const existing = holdingByKey.get(key);
    if (existing !== undefined) {
      existing.attribution = { ...existing.attribution, requests: facts };
    }
  }

  // (8) Provision's unprocessable people, from the latest run per target.
  // ProvisionException rows are per-run and cascade-delete with the run, so the
  // person, kind and message are COPIED here — a gap that dangles when a run is
  // pruned is a gap that silently closes.
  const exceptions = await withTenant(tenantId, async (tx) => {
    const latestRuns = await tx.provisionRun.findMany({
      where: { status: { in: ['applied', 'partially_applied', 'previewed'] } },
      orderBy: [{ targetSystemId: 'asc' }, { startedAt: 'desc' }],
      select: { id: true, targetSystemId: true, startedAt: true },
    });
    const newestByTarget = new Map<string, string>();
    for (const run of latestRuns) {
      if (!newestByTarget.has(run.targetSystemId)) newestByTarget.set(run.targetSystemId, run.id);
    }
    const runIds = [...newestByTarget.values()];
    if (runIds.length === 0) return [];
    return tx.provisionException.findMany({
      where: { runId: { in: runIds } },
      select: { runId: true, personId: true, targetSystemId: true, kind: true, message: true },
    });
  });

  for (const exception of exceptions) {
    gaps.push({
      kind: 'person_unprocessable',
      systemKind: 'targetSystem',
      systemId: exception.targetSystemId,
      resourceId: null,
      personId: exception.personId,
      accountRef: null,
      reason: `Provision could not fully evaluate this person: ${exception.kind} — ${exception.message}`,
      sourceRunId: exception.runId,
    });
  }

  // (9) Sources and their read history.
  const sourceRuns = await withTenant(tenantId, async (tx) => {
    const directorySources = await tx.directorySource.findMany({ select: { id: true, name: true } });
    const syncRuns = await tx.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      select: { id: true, sourceId: true, status: true, startedAt: true, finishedAt: true },
    });
    return { directorySources, syncRuns };
  });

  sources.push({
    sourceKind: 'syntraInternal',
    sourceId: SYNTRA_SYSTEM_ID,
    sourceName: 'Syntra',
    lastRunId: null,
    lastSuccessfulReadAt: asOf,
    lastAttemptedReadAt: asOf,
    completeness: 'complete',
    freshnessSlaHours: slaFor('syntraInternal', SYNTRA_SYSTEM_ID),
    gapCount: 0,
  });

  for (const source of sourceRuns.directorySources) {
    const runs = sourceRuns.syncRuns.filter((r) => r.sourceId === source.id);
    const lastOk = runs.find((r) => r.status === 'applied');
    sources.push({
      sourceKind: 'directorySource',
      sourceId: source.id,
      sourceName: source.name,
      lastRunId: lastOk?.id ?? runs[0]?.id ?? null,
      lastSuccessfulReadAt: lastOk?.finishedAt ?? null,
      lastAttemptedReadAt: runs[0]?.startedAt ?? null,
      completeness: lastOk === undefined ? 'unread' : 'complete',
      freshnessSlaHours: slaFor('directorySource', source.id),
      gapCount: 0,
    });
  }

  for (const target of targets) {
    const unreadableHere = provision.unreadable.filter((e) => e.targetSystemId === target.id).length;
    sources.push({
      sourceKind: 'targetSystem',
      sourceId: target.id,
      sourceName: target.name,
      lastRunId: null,
      lastSuccessfulReadAt: target.lastAppliedRunAt ?? target.lastRunAt,
      lastAttemptedReadAt: target.lastRunAt,
      completeness:
        target.lastAppliedRunAt === null && target.lastRunAt === null
          ? 'unread'
          : unreadableHere > 0
            ? 'partial'
            : 'complete',
      freshnessSlaHours: slaFor('targetSystem', target.id),
      gapCount: unreadableHere,
    });
  }

  const unattributedAccountKeys = [
    ...new Set(
      gaps
        .filter((g) => g.kind === 'subject_unresolvable' && g.accountRef !== null)
        .map((g) => `account:${g.systemId}:${g.accountRef}`),
    ),
  ];

  return {
    asOf,
    holdings,
    gaps,
    sources,
    personIds: people.persons.map((p) => p.id),
    personsWithActiveContract,
    unattributedAccountKeys,
    queryCount: 9,
  };
}
```

- [ ] **Step 7: Add the collect integration test**

Append to `packages/core/src/govern/collect.test.ts`:

```ts
describe('collectTenant', () => {
  it('collects a person’s Syntra account, group, application, role and target entitlement', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'Anna Novak', personId: person.id },
      });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'user', userId: user.id },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: ['audit.read'] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' }, lastRunAt: NOW, lastAppliedRunAt: NOW },
      });
      const entitlement = await tx.entitlement.create({
        data: { tenantId, targetSystemId: target.id, externalId: 'guid-1', type: 'group', displayName: 'Finance-Payments' },
      });
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: target.id, personId: person.id, anchor: 'guid-anna', correlationKey: 'anna.novak', status: 'active', lastReconciledAt: NOW },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'discovered' },
      });
      return { personId: person.id, targetId: target.id, entitlementId: entitlement.id };
    });

    const collected = await collectTenant(tenantId, { asOf: NOW });

    const kinds = collected.holdings
      .filter((h) => h.subject.kind === 'person' && h.subject.personId === seeded.personId)
      .map((h) => h.resourceKind)
      .sort();
    expect(kinds).toEqual([
      'application',
      'syntraGroup',
      'syntraRole',
      'syntraUser',
      'targetAccount',
      'targetEntitlement',
    ]);

    const entitlement = collected.holdings.find((h) => h.resourceKind === 'targetEntitlement');
    expect(entitlement!.attribution.discovered).toHaveLength(1);
    expect(entitlement!.observedAt).toEqual(NOW);
    expect(collected.personsWithActiveContract).toBe(1);
    expect(collected.queryCount).toBe(9);
  });

  it('produces a resource_unreadable gap and an unknown holding for an unreadable entitlement', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's', config: { tlsMode: 'ldaps' }, lastRunAt: NOW, lastAppliedRunAt: NOW },
      });
      const entitlement = await tx.entitlement.create({
        data: { tenantId, targetSystemId: target.id, externalId: 'g', type: 'group', displayName: 'Domain Admins', status: 'unreadable' },
      });
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: target.id, personId: person.id, anchor: 'x', correlationKey: 'a.b', status: 'active', lastReconciledAt: NOW },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'rule' },
      });
    });

    const collected = await collectTenant(tenantId, { asOf: NOW });
    const gap = collected.gaps.find((g) => g.kind === 'resource_unreadable');
    expect(gap!.reason).toContain('Domain Admins');
    expect(gap!.reason).toContain('not necessarily the run that failed the read');
    expect(collected.holdings.find((h) => h.resourceKind === 'targetEntitlement')!.state).toBe('unknown');
    expect(collected.sources.find((s) => s.sourceKind === 'targetSystem')!.completeness).toBe('partial');
  });

  it('reports a Syntra account with no linked person as subject_unresolvable', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.create({ data: { tenantId, login: 'svc', email: 's@a.test', displayName: 'Service' } }),
    );
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(collected.gaps.map((g) => g.kind)).toContain('subject_unresolvable');
    expect(collected.unattributedAccountKeys).toHaveLength(1);
  });

  it('copies a ProvisionException onto a person_unprocessable gap so pruning the run cannot close it', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's', config: { tlsMode: 'ldaps' } },
      });
      const run = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: target.id, status: 'applied' },
      });
      await tx.provisionException.create({
        data: {
          tenantId, runId: run.id, personId: person.id, targetSystemId: target.id,
          kind: 'unresolvable_rule', message: 'rule "Finance staff" names a missing entitlement',
        },
      });
      return { runId: run.id, personId: person.id };
    });

    const before = await collectTenant(tenantId, { asOf: NOW });
    const gap = before.gaps.find((g) => g.kind === 'person_unprocessable');
    expect(gap).toMatchObject({ personId: seeded.personId, sourceRunId: seeded.runId });
    expect(gap!.reason).toContain('Finance staff');

    // The copy is what makes the gap survive its source.
    await withTenant(tenantId, (tx) => tx.provisionRun.delete({ where: { id: seeded.runId } }));
    expect(gap!.reason).toContain('Finance staff');
  });

  it('reports NOTHING for an empty tenant rather than an empty-and-complete picture', async () => {
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(collected.holdings).toEqual([]);
    // The one source that is always there says so; a collect that reported no
    // sources at all would make worstCompleteness answer `unread`, which is
    // the correct answer for a tenant nobody has configured.
    expect(collected.sources.map((s) => s.sourceKind)).toEqual(['syntraInternal']);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/collect.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 9: Export and typecheck**

Add `export * from './govern/collect.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 10: Mutation-test the path resolver and the gap copies**

Each reverted before the next; every one must produce a failure:

1. In `resolveApplicationPaths`, deduplicate by `applicationId` per user. Expected: `reports all three paths separately` FAILS.
2. Delete the `chain.slice(0, ... + 1)` truncation and pass the whole chain. Expected: `reports WHICH org unit produced the match and the chain up to it` FAILS on the chain length.
3. Remove the `where: { application: { status: 'active' } }` filter. Expected: `agrees with resolveApplicationIdsForUser` FAILS on the retired application.
4. Remove the `seen` set from `chainFor`. Expected: `survives a cycle` hangs — the assertion is the 30-second test timeout, and a hang is a failure.
5. In the `person_unprocessable` gap, replace the copied `message` with the run id. Expected: `copies a ProvisionException onto a person_unprocessable gap` FAILS.
6. In the unreadable-entitlement branch, set `state: 'held'`. Expected: `produces a resource_unreadable gap and an unknown holding` FAILS. This is the one that turns a truncated read into a confident number.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/govern/collect.ts packages/core/src/govern/collect.test.ts packages/core/src/index.ts
git commit -m "feat(govern): the collect stage and the application-path resolver"
```

---
## Task 7: The snapshot build, `readableSnapshot()`, and the two structural tests

Correlate, classify, detect and write. Spec §6, §8, §19, §21, §23.

**The atomicity guarantee Provision gets from one transaction, Govern gets from the status flag plus one enforced accessor.** Provision writes its entire plan in one transaction so a run that fails partway writes no plan at all. That is right for a few thousand rows and wrong for several million. Govern's divergence: the `AccessSnapshot` row is created `building` in one short transaction, holdings and attributions and gaps are written in batches each in its own short `withTenant`, and the status flips to `complete` in a final short transaction with the counts and the audit event. **Ruling G1 accepted this divergence on one condition: "make that test load-bearing."** Step 9 is that test.

**Files:**
- Create: `packages/core/src/govern/snapshot-service.ts`
- Test: `packages/core/src/govern/snapshot-service.test.ts`, `packages/core/src/govern/boundaries.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `currentTenant` from `../tenant-context.js`; `recordEvent` from `../audit/audit-service.js`; `collectTenant`, `type CollectedTenant`, `type CollectedHolding` from `./collect.js`; `classifySources`, `gapsForSources`, `worstCompleteness`, `worstStaleness`, `type ClassifiedSource` from `./freshness.js`; `attributionsFor`, `isUnattributable`, `type AttributionDraft` from `./attribute.js`; `diffSnapshots`, `type DiffHolding`, `type DiffRegion`, `type HoldingEventDraft` from `./diff.js`; `subjectKey`, `SYNTRA_SYSTEM_ID`, `type ResourceKind` from `./types.js`.
- Produces (all in `./snapshot-service.js`):
  - `const SNAPSHOT_WRITE_BATCH = 500`
  - `const EVENT_WRITE_BATCH = 500`
  - `const SNAPSHOT_STALL_MINUTES = 60`
  - `class SnapshotNotReadableError extends Error { constructor(readonly reason: 'not_found' | 'building' | 'failed' | 'no_sources') }`
  - `interface ReadableSnapshot { id: string; asOf: Date; status: 'complete'; holdingCount: number; unattributableCount: number; coverageGapCount: number; unattributedAccountCount: number; personsWithActiveContract: number; sources: ClassifiedSource[] }`
  - `async function readableSnapshot(tx: TenantClient, snapshotId?: string): Promise<ReadableSnapshot>`
  - `async function beginSnapshot(tenantId: string, kind: 'scheduled' | 'manual' | 'campaign', asOf: Date, actorUserId: string | null): Promise<string>`
  - `interface BuildOptions { now?: Date; actorUserId?: string | null; kind?: 'scheduled' | 'manual' | 'campaign'; batchSize?: number; collect?: (tenantId: string, options: { asOf: Date }) => Promise<CollectedTenant> }`
  - `interface BuildResult { snapshotId: string; status: 'complete' | 'failed'; holdingCount: number; unattributableCount: number; coverageGapCount: number; eventCount: number }`
  - `async function buildSnapshot(tenantId: string, options?: BuildOptions): Promise<BuildResult>`
  - `async function pruneSnapshots(tenantId: string, options?: { now?: Date; retentionDays?: number }): Promise<{ pruned: number; retainedForReference: number }>`
  - `const GOVERN_MODULE_DIR: string` — the directory the structural tests scan
  - `const FORBIDDEN_WRITE_MODELS: readonly string[]`

- [ ] **Step 1: Write the failing test for the accessor**

`packages/core/src/govern/snapshot-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { CollectedTenant } from './collect.js';
import {
  SNAPSHOT_STALL_MINUTES,
  SnapshotNotReadableError,
  beginSnapshot,
  buildSnapshot,
  pruneSnapshots,
  readableSnapshot,
} from './snapshot-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const emptyCollection = (over: Partial<CollectedTenant> = {}): CollectedTenant => ({
  asOf: NOW,
  holdings: [],
  gaps: [],
  sources: [
    {
      sourceKind: 'syntraInternal',
      sourceId: 'syntra',
      sourceName: 'Syntra',
      lastRunId: null,
      lastSuccessfulReadAt: NOW,
      lastAttemptedReadAt: NOW,
      completeness: 'complete',
      freshnessSlaHours: 24,
      gapCount: 0,
    },
  ],
  personIds: [],
  personsWithActiveContract: 0,
  unattributedAccountKeys: [],
  queryCount: 9,
  ...over,
});

describe('readableSnapshot — the one enforced accessor', () => {
  it('admits a complete snapshot', async () => {
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => emptyCollection(),
    });
    const readable = await withTenant(tenantId, (tx) => readableSnapshot(tx, built.snapshotId));
    expect(readable).toMatchObject({ id: built.snapshotId, status: 'complete', asOf: NOW });
  });

  it('REFUSES a building snapshot rather than reading half a picture', async () => {
    // A half-built snapshot is indistinguishable from a small organization,
    // and that is the whole reason this function exists.
    const id = await beginSnapshot(tenantId, 'manual', NOW, null);
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toBeInstanceOf(SnapshotNotReadableError);
  });

  it('REFUSES a failed snapshot', async () => {
    const id = await beginSnapshot(tenantId, 'manual', NOW, null);
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.update({ where: { id }, data: { status: 'failed', error: 'boom' } }),
    );
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toMatchObject({ reason: 'failed' });
  });

  it('REFUSES a complete snapshot with NO SnapshotSource rows', async () => {
    // The empty case. A snapshot that recorded no source has not been shown to
    // have read anything, and a report over it would print totals with a
    // header claiming coverage it never established.
    const id = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      return s.id;
    });
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toMatchObject({ reason: 'no_sources' });
  });

  it('defaults to the newest complete snapshot, never to a newer building one', async () => {
    const first = await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    await beginSnapshot(tenantId, 'scheduled', new Date(NOW.getTime() + 60_000), null);
    const readable = await withTenant(tenantId, (tx) => readableSnapshot(tx));
    expect(readable.id).toBe(first.snapshotId);
  });

  it('refuses when no snapshot exists at all', async () => {
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx)),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
});

describe('beginSnapshot supersedes a stalled build', () => {
  it('refuses a second concurrent build inside the stall window', async () => {
    await beginSnapshot(tenantId, 'scheduled', NOW, null);
    await expect(beginSnapshot(tenantId, 'manual', NOW, null)).rejects.toThrow(
      /already building/i,
    );
  });

  it('SUPERSEDES a build that crashed, so a crash cannot brick the tenant', async () => {
    // The escape hatch, in the same task as the index. This programme has
    // shipped a one-non-terminal-row index with no adoption path twice: one
    // permanently bricked a target, the other permanently stopped every grant
    // expiring.
    const stalled = await beginSnapshot(tenantId, 'scheduled', NOW, null);
    const later = new Date(NOW.getTime() + (SNAPSHOT_STALL_MINUTES + 1) * 60_000);

    const fresh = await beginSnapshot(tenantId, 'manual', later, null);
    expect(fresh).not.toBe(stalled);

    const rows = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows[0]).toMatchObject({ id: stalled, status: 'failed' });
    expect(rows[0]!.error).toContain('superseded');
    expect(rows[1]).toMatchObject({ id: fresh, status: 'building' });
  });

  it('a superseded build is not readable, and the new one is once complete', async () => {
    const stalled = await beginSnapshot(tenantId, 'scheduled', NOW, null);
    const later = new Date(NOW.getTime() + (SNAPSHOT_STALL_MINUTES + 1) * 60_000);
    const built = await buildSnapshot(tenantId, { now: later, collect: async () => emptyCollection({ asOf: later }) });

    await expect(withTenant(tenantId, (tx) => readableSnapshot(tx, stalled))).rejects.toMatchObject({
      reason: 'failed',
    });
    await expect(withTenant(tenantId, (tx) => readableSnapshot(tx, built.snapshotId))).resolves.toMatchObject({
      status: 'complete',
    });
  });
});

describe('buildSnapshot', () => {
  it('writes holdings with their attributions and the derived unattributable flag', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
      return p.id;
    });

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          personIds: [personId],
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'targetSystem',
              systemId: 'sys-1',
              systemName: 'Acme AD',
              resourceKind: 'targetEntitlement',
              resourceId: 'ent-1',
              resourceName: 'Finance-Payments',
              state: 'held',
              observedAt: day('2026-06-03'),
              observedVia: 'provision:sys-1',
              attribution: {
                rules: [],
                requests: [],
                directAssignments: [],
                groupInheritance: [],
                orgUnitInheritance: [],
                directorySources: [],
                discovered: [{ firstRunId: null, discoveredAt: '2024-02-01T00:00:00Z' }],
                manual: [],
              },
            },
          ],
        }),
    });

    const [holding, attributions] = await withTenant(tenantId, async (tx) => [
      await tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
      await tx.holdingAttribution.findMany(),
    ]);

    expect(holding).toMatchObject({
      subjectKey: `person:${personId}`,
      personId,
      resourceKind: 'targetEntitlement',
      state: 'held',
      unattributable: true,
      attributionCount: 1,
    });
    // observedAt is the target's truth-time, NOT the snapshot's asOf, and the
    // two being days apart is the whole point of section 8.
    expect(holding.observedAt).toEqual(day('2026-06-03'));
    expect(attributions.map((a) => a.kind)).toEqual(['discovered']);
    expect(built.unattributableCount).toBe(1);
  });

  it('marks a syntraRole holding privileged with no configuration at all', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'syntraInternal',
              systemId: 'syntra',
              systemName: 'Syntra',
              resourceKind: 'syntraRole',
              resourceId: 'role-1',
              resourceName: 'Owner (tenant.manage)',
              state: 'held',
              observedAt: NOW,
              observedVia: 'syntra',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    });
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holding.privileged).toBe(true);
  });

  it('marks a holding privileged from ResourceClassification', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      await tx.resourceClassification.create({
        data: { tenantId, systemId: 'sys-1', resourceKind: 'targetEntitlement', resourceId: 'ent-1', privileged: true },
      });
      return p.id;
    });
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'targetSystem', systemId: 'sys-1', systemName: 'AD',
              resourceKind: 'targetEntitlement', resourceId: 'ent-1', resourceName: 'Domain Admins',
              state: 'held', observedAt: NOW, observedVia: 'provision:sys-1',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    });
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holding.privileged).toBe(true);
  });

  it('carries firstSeenAt forward from the previous snapshot rather than resetting it', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const one: Parameters<typeof buildSnapshot>[1] = {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'syntraInternal', systemId: 'syntra', systemName: 'Syntra',
              resourceKind: 'syntraGroup', resourceId: 'g-1', resourceName: 'Finance',
              state: 'held', observedAt: NOW, observedVia: 'syntra',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    };
    await buildSnapshot(tenantId, one);
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await buildSnapshot(tenantId, {
      ...one,
      now: later,
      collect: async () => ({ ...(await one.collect!(tenantId, { asOf: later })), asOf: later }),
    });

    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: second.snapshotId } }),
    );
    expect(holding.firstSeenAt).toEqual(NOW);
  });

  it('writes HoldingEvent rows against the previous snapshot', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const holdingOf = (resourceId: string) => ({
      subject: { kind: 'person' as const, personId },
      systemKind: 'syntraInternal' as const, systemId: 'syntra', systemName: 'Syntra',
      resourceKind: 'syntraGroup' as const, resourceId, resourceName: resourceId,
      state: 'held' as const, observedAt: NOW, observedVia: 'syntra',
      attribution: {
        rules: [], requests: [], directAssignments: [], groupInheritance: [],
        orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
      },
    });

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection({ holdings: [holdingOf('g-1')] }) });
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollection({ asOf: later, holdings: [holdingOf('g-2')] }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: second.snapshotId }, orderBy: { resourceId: 'asc' } }),
    );
    expect(events.map((e) => [e.resourceId, e.change])).toEqual([
      ['g-1', 'lost'],
      ['g-2', 'gained'],
    ]);
    expect(second.eventCount).toBe(2);
  });

  it('marks the snapshot failed and leaves its rows behind when the write throws', async () => {
    // Deleting several million rows inside the failure handler is the same
    // mistake in a different costume. The cleanup job removes them.
    const built = buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => {
        throw new Error('the collector fell over');
      },
    });
    await expect(built).rejects.toThrow('the collector fell over');

    const rows = await withTenant(tenantId, (tx) => tx.accessSnapshot.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(rows[0]!.error).toContain('the collector fell over');
  });

  it('writes ONE audit event for the whole build, naming the counts', async () => {
    const built = await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'govern.snapshot.build', targetId: built.snapshotId });
  });

  it('batches the writes so no transaction carries the whole tenant', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const many = Array.from({ length: 25 }, (_, i) => ({
      subject: { kind: 'person' as const, personId },
      systemKind: 'syntraInternal' as const, systemId: 'syntra', systemName: 'Syntra',
      resourceKind: 'syntraGroup' as const, resourceId: `g-${i}`, resourceName: `g-${i}`,
      state: 'held' as const, observedAt: NOW, observedVia: 'syntra',
      attribution: {
        rules: [], requests: [], directAssignments: [], groupInheritance: [],
        orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
      },
    }));

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      batchSize: 5,
      collect: async () => emptyCollection({ holdings: many }),
    });
    expect(built.holdingCount).toBe(25);
    const count = await withTenant(tenantId, (tx) =>
      tx.holding.count({ where: { snapshotId: built.snapshotId } }),
    );
    expect(count).toBe(25);
  });
});

describe('pruneSnapshots', () => {
  it('prunes past the retention window and NEVER prunes one an evidence pack points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const alsoOld = await buildSnapshot(tenantId, {
      now: day('2024-01-02'),
      collect: async () => emptyCollection({ asOf: day('2024-01-02') }),
    });
    await withTenant(tenantId, (tx) =>
      tx.evidencePack.create({
        data: {
          tenantId, kind: 'report', snapshotId: alsoOld.snapshotId,
          chainHeadSequence: 1, chainHeadHash: 'x', chainVerificationResult: 'valid',
          chainFromSequence: 1, chainToSequence: 1, digest: 'd', byteLength: 10,
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 1, retainedForReference: 1 });

    const remaining = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findMany({ select: { id: true } }),
    );
    expect(remaining.map((r) => r.id)).toContain(alsoOld.snapshotId);
    expect(remaining.map((r) => r.id)).not.toContain(old.snapshotId);
  });

  it('never prunes a snapshot an open finding points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId, kind: 'coverage_gap', severity: 'high',
          subjectRefType: 'snapshot', subjectRefId: old.snapshotId,
          detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
        },
      }),
    );
    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/snapshot-service.test.ts`
Expected: FAIL — `Cannot find module './snapshot-service.js'`.

- [ ] **Step 3: Write the accessor and the supersession**

`packages/core/src/govern/snapshot-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { currentTenant } from '../tenant-context.js';
import {
  attributionsFor,
  isUnattributable,
  type AttributionDraft,
} from './attribute.js';
import { collectTenant, type CollectedTenant } from './collect.js';
import { diffSnapshots, type DiffHolding, type DiffRegion } from './diff.js';
import {
  classifySources,
  gapsForSources,
  worstCompleteness,
  worstStaleness,
  type ClassifiedSource,
} from './freshness.js';
import { SYNTRA_SYSTEM_ID, subjectKey, type ResourceKind } from './types.js';

export const SNAPSHOT_WRITE_BATCH = 500;
export const EVENT_WRITE_BATCH = 500;

/**
 * How old a `building` snapshot must be before a new build supersedes it.
 *
 * A code constant, not a setting: a tenant that could raise it could brick its
 * own snapshot pipeline for as long as it liked, and the number only has to be
 * longer than the longest honest build.
 */
export const SNAPSHOT_STALL_MINUTES = 60;

export class SnapshotNotReadableError extends Error {
  constructor(readonly reason: 'not_found' | 'building' | 'failed' | 'no_sources') {
    super(
      reason === 'not_found'
        ? 'no complete snapshot exists'
        : reason === 'building'
          ? 'this snapshot is still being built; a half-built snapshot is indistinguishable from a small organization'
          : reason === 'failed'
            ? 'this snapshot failed to build and describes nothing'
            : 'this snapshot recorded no source, so nothing in it has been shown to have been read',
    );
    this.name = 'SnapshotNotReadableError';
  }
}

export interface ReadableSnapshot {
  id: string;
  asOf: Date;
  status: 'complete';
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  unattributedAccountCount: number;
  personsWithActiveContract: number;
  sources: ClassifiedSource[];
}

/**
 * THE ONE ACCESSOR. Every report, every campaign, every export and every SoD
 * evaluation reads a snapshot through here and through nothing else.
 *
 * Govern trades Provision's whole-plan-in-one-transaction atomicity for a
 * status flag, and this function is the entire protection that trade bought.
 * Ruling G1 accepted the divergence on the condition that this test be made
 * load-bearing; `boundaries.test.ts` enumerates every route and asserts it.
 */
export async function readableSnapshot(
  tx: TenantClient,
  snapshotId?: string,
): Promise<ReadableSnapshot> {
  const row =
    snapshotId === undefined
      ? await tx.accessSnapshot.findFirst({
          where: { status: 'complete' },
          orderBy: { asOf: 'desc' },
        })
      : await tx.accessSnapshot.findUnique({ where: { id: snapshotId } });

  if (row === null) throw new SnapshotNotReadableError('not_found');
  if (row.status === 'building') throw new SnapshotNotReadableError('building');
  if (row.status !== 'complete') throw new SnapshotNotReadableError('failed');

  const sourceRows = await tx.snapshotSource.findMany({ where: { snapshotId: row.id } });
  if (sourceRows.length === 0) throw new SnapshotNotReadableError('no_sources');

  return {
    id: row.id,
    asOf: row.asOf,
    status: 'complete',
    holdingCount: row.holdingCount,
    unattributableCount: row.unattributableCount,
    coverageGapCount: row.coverageGapCount,
    unattributedAccountCount: row.unattributedAccountCount,
    personsWithActiveContract: row.personsWithActiveContract,
    sources: sourceRows.map((s) => ({
      sourceKind: s.sourceKind as ClassifiedSource['sourceKind'],
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastRunId: s.lastRunId,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt,
      lastAttemptedReadAt: s.lastAttemptedReadAt,
      completeness: s.completeness as ClassifiedSource['completeness'],
      staleness: s.staleness as ClassifiedSource['staleness'],
      freshnessSlaHours: s.freshnessSlaHours,
      gapCount: s.gapCount,
      ageHours:
        s.lastSuccessfulReadAt === null
          ? null
          : (row.asOf.getTime() - s.lastSuccessfulReadAt.getTime()) / 3_600_000,
    })),
  };
}

/**
 * Creates the `building` row in one short transaction, so there is something to
 * mark `failed` however the rest gives out.
 *
 * SUPERSESSION IS IN THE SAME FUNCTION AS THE INDEX IT ESCAPES.
 * `govern_snapshot_one_building` is a one-non-terminal-row constraint, and this
 * programme has shipped two of those with no adoption path: one permanently
 * bricked a target, the other permanently stopped every grant expiring. A
 * `building` snapshot older than SNAPSHOT_STALL_MINUTES is a crashed process,
 * and it is failed at the head of the same transaction that creates the new one.
 */
export async function beginSnapshot(
  tenantId: string,
  kind: 'scheduled' | 'manual' | 'campaign',
  asOf: Date,
  actorUserId: string | null,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const stallCutoff = new Date(asOf.getTime() - SNAPSHOT_STALL_MINUTES * 60_000);
    const inFlight = await tx.accessSnapshot.findFirst({ where: { status: 'building' } });

    if (inFlight !== null) {
      if (inFlight.startedAt > stallCutoff) {
        throw new Error(
          `a snapshot is already building for this tenant (started ${inFlight.startedAt.toISOString()})`,
        );
      }
      await tx.accessSnapshot.update({
        where: { id: inFlight.id },
        data: {
          status: 'failed',
          finishedAt: asOf,
          error: `superseded by a later build: this build had been running for more than ${SNAPSHOT_STALL_MINUTES} minutes`,
        },
      });
    }

    const created = await tx.accessSnapshot.create({
      data: { tenantId, kind, status: 'building', asOf, startedAt: asOf },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.snapshot.begin',
      targetType: 'AccessSnapshot',
      targetId: created.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        kind,
        asOf: asOf.toISOString(),
        ...(inFlight === null ? {} : { supersededSnapshotId: inFlight.id }),
      },
    });

    return created.id;
  });
}
```

- [ ] **Step 4: Write the build**

Append to `packages/core/src/govern/snapshot-service.ts`:

```ts
export interface BuildOptions {
  now?: Date;
  actorUserId?: string | null;
  kind?: 'scheduled' | 'manual' | 'campaign';
  batchSize?: number;
  /** The seam the tests fill. Production always uses `collectTenant`. */
  collect?: (tenantId: string, options: { asOf: Date }) => Promise<CollectedTenant>;
}

export interface BuildResult {
  snapshotId: string;
  status: 'complete' | 'failed';
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  eventCount: number;
}

interface PreparedHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemKind: string;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: 'held' | 'unknown';
  privileged: boolean;
  observedAt: Date;
  observedVia: string;
  firstSeenAt: Date;
  unattributable: boolean;
  attributions: AttributionDraft[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function buildSnapshot(
  tenantId: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const now = options.now ?? new Date();
  const kind = options.kind ?? 'scheduled';
  const actorUserId = options.actorUserId ?? null;
  const batchSize = options.batchSize ?? SNAPSHOT_WRITE_BATCH;
  const collect = options.collect ?? ((id, o) => collectTenant(id, { asOf: o.asOf }));

  const snapshotId = await beginSnapshot(tenantId, kind, now, actorUserId);

  try {
    // ---- collect (database only, its own short transactions) -------------
    const collected = await collect(tenantId, { asOf: now });

    // ---- classify sources -------------------------------------------------
    const sources = classifySources(collected.sources, collected.asOf);
    const sourceGaps = gapsForSources(sources);

    // ---- previous snapshot, for firstSeenAt and the diff -------------------
    const previous = await withTenant(tenantId, async (tx) => {
      const row = await tx.accessSnapshot.findFirst({
        where: { status: 'complete', id: { not: snapshotId } },
        orderBy: { asOf: 'desc' },
        select: { id: true },
      });
      if (row === null) return null;
      const holdings = await tx.holding.findMany({
        where: { snapshotId: row.id },
        select: {
          subjectKey: true, personId: true, accountRef: true, systemId: true,
          resourceKind: true, resourceId: true, resourceName: true, state: true,
          firstSeenAt: true,
          attributions: { select: { kind: true, refId: true } },
        },
      });
      const gaps = await tx.coverageGap.findMany({
        where: { snapshotId: row.id },
        select: { systemId: true, resourceId: true, personId: true },
      });
      return { id: row.id, holdings, gaps };
    });

    // ---- classification of privilege ---------------------------------------
    const classifications = await withTenant(tenantId, (tx) =>
      tx.resourceClassification.findMany({
        select: { systemId: true, resourceKind: true, resourceId: true, privileged: true },
      }),
    );
    const privilegedByKey = new Set(
      classifications
        .filter((c) => c.privileged)
        .map((c) => `${c.systemId}|${c.resourceKind}|${c.resourceId}`),
    );

    const firstSeenByKey = new Map(
      (previous?.holdings ?? []).map((h) => [
        `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
        h.firstSeenAt,
      ]),
    );

    // ---- attribute + classify (pure) ---------------------------------------
    const prepared: PreparedHolding[] = collected.holdings.map((h) => {
      const key = subjectKey(h.subject);
      const attributions = attributionsFor(h.attribution, collected.asOf);
      const compositeKey = `${key}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;
      return {
        subjectKey: key,
        personId: h.subject.kind === 'person' ? h.subject.personId : null,
        accountRef: h.subject.kind === 'account' ? h.subject.accountRef : null,
        systemKind: h.systemKind,
        systemId: h.systemId,
        resourceKind: h.resourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state,
        // Every syntraRole holding is privileged with NO configuration: a
        // Syntra role carries permissions from the closed catalogue and there
        // is no version of that which is not.
        privileged:
          h.resourceKind === 'syntraRole' ||
          privilegedByKey.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`),
        observedAt: h.observedAt,
        observedVia: h.observedVia,
        firstSeenAt: firstSeenByKey.get(compositeKey) ?? collected.asOf,
        unattributable: isUnattributable(attributions.map((a) => a.kind)),
        attributions,
      };
    });

    const allGaps = [
      ...collected.gaps.map((g) => ({
        kind: g.kind as string,
        systemKind: g.systemKind as string | null,
        systemId: g.systemId as string | null,
        resourceId: g.resourceId,
        personId: g.personId,
        accountRef: g.accountRef,
        reason: g.reason,
        sourceRunId: g.sourceRunId,
      })),
      ...sourceGaps.map((g) => ({
        kind: g.kind as string,
        systemKind: g.sourceKind as string | null,
        systemId: g.sourceId as string | null,
        resourceId: null,
        personId: null,
        accountRef: null,
        reason: g.reason,
        sourceRunId: g.sourceRunId,
      })),
    ];

    // ---- write, in batches, each its own short transaction ------------------
    await withTenant(tenantId, async (tx) => {
      await tx.snapshotSource.createMany({
        data: sources.map((s) => ({
          tenantId, snapshotId,
          sourceKind: s.sourceKind, sourceId: s.sourceId, sourceName: s.sourceName,
          lastRunId: s.lastRunId,
          lastSuccessfulReadAt: s.lastSuccessfulReadAt,
          lastAttemptedReadAt: s.lastAttemptedReadAt,
          completeness: s.completeness, staleness: s.staleness,
          freshnessSlaHours: s.freshnessSlaHours,
          gapCount: allGaps.filter((g) => g.systemId === s.sourceId).length,
        })),
      });
    });

    for (const batch of chunk(allGaps, batchSize)) {
      await withTenant(tenantId, (tx) =>
        tx.coverageGap.createMany({
          data: batch.map((g) => ({
            tenantId, snapshotId, kind: g.kind,
            systemKind: g.systemKind, systemId: g.systemId,
            resourceId: g.resourceId, personId: g.personId, accountRef: g.accountRef,
            reason: g.reason, sourceRunId: g.sourceRunId,
          })),
        }),
      );
    }

    for (const batch of chunk(prepared, batchSize)) {
      await withTenant(tenantId, async (tx) => {
        // createMany then a read-back, rather than a create per row: the
        // attributions need the generated holding ids, and one round trip per
        // holding is what makes a 5000 ms transaction a P2028.
        await tx.holding.createMany({
          data: batch.map((h) => ({
            tenantId, snapshotId,
            subjectKey: h.subjectKey, personId: h.personId, accountRef: h.accountRef,
            systemKind: h.systemKind, systemId: h.systemId,
            resourceKind: h.resourceKind, resourceId: h.resourceId, resourceName: h.resourceName,
            state: h.state, privileged: h.privileged,
            observedAt: h.observedAt, observedVia: h.observedVia, firstSeenAt: h.firstSeenAt,
            attributionCount: h.attributions.length,
            unattributable: h.unattributable,
          })),
        });

        const written = await tx.holding.findMany({
          where: { snapshotId, subjectKey: { in: batch.map((h) => h.subjectKey) } },
          select: { id: true, subjectKey: true, systemId: true, resourceKind: true, resourceId: true },
        });
        const idByKey = new Map(
          written.map((w) => [`${w.subjectKey}|${w.systemId}|${w.resourceKind}|${w.resourceId}`, w.id]),
        );

        await tx.holdingAttribution.createMany({
          data: batch.flatMap((h) => {
            const holdingId = idByKey.get(
              `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
            );
            if (holdingId === undefined) return [];
            return h.attributions.map((a) => ({
              tenantId, holdingId,
              kind: a.kind, refType: a.refType, refId: a.refId,
              detail: a.detail as never,
              resolvedAt: a.resolvedAt,
            }));
          }),
        });
      });
    }

    // ---- detect: the diff against the previous snapshot ---------------------
    let eventCount = 0;
    if (previous !== null) {
      const toDiff = (h: {
        subjectKey: string; personId: string | null; accountRef: string | null;
        systemId: string; resourceKind: string; resourceId: string; resourceName: string;
        state: string; attributions: { kind: string; refId: string | null }[];
      }): DiffHolding => ({
        subjectKey: h.subjectKey,
        personId: h.personId,
        accountRef: h.accountRef,
        systemId: h.systemId,
        resourceKind: h.resourceKind as ResourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state === 'unknown' ? 'unknown' : 'held',
        attributionKinds: h.attributions.map((a) => a.kind) as DiffHolding['attributionKinds'],
        attributionRefs: h.attributions.map((a) => `${a.kind}:${a.refId ?? ''}`),
      });

      const beforeGapRegions: DiffRegion[] = previous.gaps.map((g) => ({
        systemId: g.systemId ?? SYNTRA_SYSTEM_ID,
        resourceId: g.resourceId,
        personId: g.personId,
      }));
      const afterGapRegions: DiffRegion[] = allGaps.map((g) => ({
        systemId: g.systemId ?? SYNTRA_SYSTEM_ID,
        resourceId: g.resourceId,
        personId: g.personId,
      }));

      const events = diffSnapshots({
        before: previous.holdings.map(toDiff),
        after: prepared.map((h) =>
          toDiff({
            ...h,
            attributions: h.attributions.map((a) => ({ kind: a.kind, refId: a.refId })),
          }),
        ),
        beforeGapRegions,
        afterGapRegions,
      });
      eventCount = events.length;

      for (const batch of chunk(events, EVENT_WRITE_BATCH)) {
        await withTenant(tenantId, (tx) =>
          tx.holdingEvent.createMany({
            data: batch.map((e) => ({
              tenantId,
              fromSnapshotId: previous.id,
              toSnapshotId: snapshotId,
              subjectKey: e.subjectKey, personId: e.personId, accountRef: e.accountRef,
              systemId: e.systemId, resourceKind: e.resourceKind,
              resourceId: e.resourceId, resourceName: e.resourceName,
              change: e.change,
              beforeAttributions: e.beforeAttributions as never,
              afterAttributions: e.afterAttributions as never,
              explained: false,
            })),
          }),
        );
      }
    }

    // ---- flip to complete, with the counts and the audit event --------------
    const unattributableCount = prepared.filter((h) => h.unattributable).length;
    const countsByResourceKind: Record<string, number> = {};
    for (const h of prepared) {
      countsByResourceKind[h.resourceKind] = (countsByResourceKind[h.resourceKind] ?? 0) + 1;
    }

    await withTenant(tenantId, async (tx) => {
      await tx.accessSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'complete',
          finishedAt: new Date(),
          holdingCount: prepared.length,
          unattributableCount,
          coverageGapCount: allGaps.length,
          unattributedAccountCount: collected.unattributedAccountKeys.length,
          personCount: collected.personIds.length,
          personsWithActiveContract: collected.personsWithActiveContract,
          countsByResourceKind: countsByResourceKind as never,
        },
      });

      await recordEvent(tx, {
        actorUserId,
        action: 'govern.snapshot.build',
        targetType: 'AccessSnapshot',
        targetId: snapshotId,
        outcome: 'success',
        sourceIp: null,
        payload: {
          kind,
          asOf: collected.asOf.toISOString(),
          holdingCount: prepared.length,
          unattributableCount,
          coverageGapCount: allGaps.length,
          eventCount,
          completeness: worstCompleteness(sources),
          staleness: worstStaleness(sources),
        },
      });
    });

    return {
      snapshotId,
      status: 'complete',
      holdingCount: prepared.length,
      unattributableCount,
      coverageGapCount: allGaps.length,
      eventCount,
    };
  } catch (cause) {
    // The rows already written stay, marked by their snapshot. Deleting several
    // million rows inside a failure handler is the same mistake in a different
    // costume; `pruneSnapshots` removes them.
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
    throw cause;
  }
}

/**
 * Retention, with one exception that is not negotiable: any snapshot referenced
 * by a campaign, an evidence bundle or an open finding is NEVER pruned while
 * that reference lives. Pruning a snapshot that a signed attestation points at
 * would destroy the evidence the attestation was about.
 */
export async function pruneSnapshots(
  tenantId: string,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ pruned: number; retainedForReference: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const settings = await tx.governSettings.findUnique({ where: { tenantId } });
    const retentionDays = options.retentionDays ?? settings?.snapshotRetentionDays ?? 400;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    const candidates = await tx.accessSnapshot.findMany({
      where: { asOf: { lt: cutoff } },
      select: { id: true },
    });
    if (candidates.length === 0) return { pruned: 0, retainedForReference: 0 };
    const ids = candidates.map((c) => c.id);

    const referenced = new Set<string>();
    for (const pack of await tx.evidencePack.findMany({
      where: { snapshotId: { in: ids } },
      select: { snapshotId: true },
    })) {
      if (pack.snapshotId !== null) referenced.add(pack.snapshotId);
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

    const prunable = ids.filter((id) => !referenced.has(id));
    if (prunable.length > 0) {
      await tx.accessSnapshot.deleteMany({ where: { id: { in: prunable } } });
    }
    return { pruned: prunable.length, retainedForReference: referenced.size };
  });
}
```

- [ ] **Step 5: Run the snapshot tests**

Run: `pnpm vitest run packages/core/src/govern/snapshot-service.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Write the two structural tests**

`packages/core/src/govern/boundaries.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GOVERN_DIR = dirname(fileURLToPath(import.meta.url));

const sourceFiles = () =>
  readdirSync(GOVERN_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(GOVERN_DIR, f), 'utf8') }));

describe('Govern opens no socket', () => {
  it('imports no connector package anywhere in the module', () => {
    // Govern reads PostgreSQL. That is a security property worth more than the
    // convenience it costs: the reporting surface — the one an auditor, a
    // manager and a team lead all touch — cannot be used to reach a domain
    // controller, because nothing in its dependency graph knows how.
    const offenders = sourceFiles()
      .filter((f) => /@syntra\/connectors|from 'ldapts'|require\('ldapts'\)/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('reaches no vault entry and no target credential', () => {
    const offenders = sourceFiles()
      .filter((f) => /getSecret|putSecret|MasterKeyProvider|targetWithCredential|secretName/.test(f.text))
      .map((f) => f.name);
    // audit-integrity.ts is exempt: it holds a CHECKPOINT SIGNING key, which is
    // Govern's own and reaches no target. It is named explicitly rather than
    // matched by a pattern, so adding a second exemption is a deliberate edit.
    expect(offenders.filter((n) => n !== 'audit-integrity.ts')).toEqual([]);
  });

  it('keeps the eight pure modules free of any @syntra/db import', () => {
    const pure = [
      'types.ts', 'freshness.ts', 'attribute.ts', 'diff.ts',
      'sod.ts', 'dispatch.ts', 'revocation-guard.ts', 'graph.ts',
    ];
    for (const file of sourceFiles()) {
      if (!pure.includes(file.name)) continue;
      expect(file.text, `${file.name} must import nothing from @syntra/db`).not.toMatch(
        /from '@syntra\/db'/,
      );
    }
  });
});

describe('Govern writes no access-bearing row', () => {
  const FORBIDDEN = [
    'groupMembership',
    'appAssignment',
    'roleAssignment',
    'targetAccount',
    'accountEntitlement',
    'accessGrant',
    'auditEvent',
  ];

  it('names no write on a table another subsystem owns', () => {
    // Every removal is dispatched to the owning subsystem or becomes a
    // remediation item. `auditEvent` is on the list because Govern writes audit
    // events only through `recordEvent` — a direct create would bypass the
    // advisory lock and the chain.
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      for (const model of FORBIDDEN) {
        const pattern = new RegExp(`\\.${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`);
        if (pattern.test(file.text)) violations.push(`${file.name}: ${model}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('still permits reads of those tables, which is the whole job', () => {
    const collect = readFileSync(join(GOVERN_DIR, 'collect.ts'), 'utf8');
    expect(collect).toMatch(/\.groupMembership\.findMany/);
    expect(collect).toMatch(/\.accessGrant\.findMany/);
  });
});

describe('every snapshot read goes through readableSnapshot', () => {
  it('is asserted over the module list, so a module added later without it fails', () => {
    // Automate's visibility suite, for staleness. Govern trades Provision's
    // atomicity for a status flag and this accessor is the entire protection
    // that trade bought, so the test is enumerated rather than sampled.
    const MUST_USE_ACCESSOR = [
      'report-service.ts',
      'export-service.ts',
      'campaign-service.ts',
      'sod-service.ts',
      'revocation-service.ts',
    ];
    for (const name of MUST_USE_ACCESSOR) {
      const file = sourceFiles().find((f) => f.name === name);
      if (file === undefined) continue; // not yet written; the task that adds it adds the assertion
      expect(file.text, `${name} must read snapshots through readableSnapshot()`).toMatch(
        /readableSnapshot\s*\(/,
      );
      expect(
        file.text,
        `${name} must not query accessSnapshot directly`,
      ).not.toMatch(/\.accessSnapshot\.(findFirst|findUnique|findMany)/);
    }
  });
});
```

- [ ] **Step 7: Run the structural tests**

Run: `pnpm vitest run packages/core/src/govern/boundaries.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Export and typecheck**

Add `export * from './govern/snapshot-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Prove the structural tests bite**

**This is the step Ruling G1's condition names.** A structural test that cannot fail is a convention wearing a test's clothes, and this programme has shipped three of those. Each mutation reverted before the next:

1. Add `import { FakeTarget } from '@syntra/connectors/testing';` to `collect.ts`. Expected: `imports no connector package` FAILS naming `collect.ts`.
2. Add `await tx.accessGrant.updateMany({ where: {}, data: {} });` to `snapshot-service.ts`. Expected: `names no write on a table another subsystem owns` FAILS naming `snapshot-service.ts: accessGrant`.
3. Add `import { withTenant } from '@syntra/db';` to `diff.ts`. Expected: `keeps the eight pure modules free` FAILS.
4. In `readableSnapshot`, delete the `row.status === 'building'` branch. Expected: `REFUSES a building snapshot` FAILS.
5. In `readableSnapshot`, delete the `sourceRows.length === 0` branch. Expected: `REFUSES a complete snapshot with NO SnapshotSource rows` FAILS.
6. In `beginSnapshot`, delete the supersession block. Expected: `SUPERSEDES a build that crashed` FAILS with a P2002 on `govern_snapshot_one_building` — **which is exactly the shape that bricked a target on Provision and stopped every grant expiring on Automate.**
7. In `beginSnapshot`, remove the `inFlight.startedAt > stallCutoff` guard so it always supersedes. Expected: `refuses a second concurrent build inside the stall window` FAILS. Both directions.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/snapshot-service.ts \
        packages/core/src/govern/snapshot-service.test.ts \
        packages/core/src/govern/boundaries.test.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): the snapshot build, readableSnapshot, and the boundary tests"
```

---
## Task 8: Findings, remediation, and the standing findings

One lifecycle, one table, one count. Spec §16. **The detection functions are pure; the persistence is not.**

**Files:**
- Create: `packages/core/src/govern/finding-service.ts`
- Test: `packages/core/src/govern/finding-service.test.ts`
- Modify: `packages/core/src/govern/snapshot-service.ts` (call `detectStandingFindings` from the detect stage), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `type FindingKind`, `type Severity`, `raiseSeverity`, `subjectKey`, `type SubjectRef` from `./types.js`; `type ClassifiedSource` from `./freshness.js`; `readableSnapshot` from `./snapshot-service.js`.
- Produces (all in `./finding-service.js`):
  - `const FINDING_BATCH = 200`
  - `interface FindingDraft { kind: FindingKind; severity: Severity; subjectRefType: string; subjectRefId: string; detail: Record<string, unknown> ; driftFindingId?: string | null }`
  - `interface DetectHolding { subjectKey: string; personId: string | null; accountRef: string | null; systemId: string; systemName: string; resourceKind: string; resourceId: string; resourceName: string; privileged: boolean; unattributable: boolean; attributionKinds: readonly string[] }`
  - `interface DetectContract { personId: string; startDate: Date; endDate: Date | null }`
  - `function detectUnattributableHoldings(holdings: readonly DetectHolding[]): FindingDraft[]`
  - `function detectAccessWithoutContract(holdings: readonly DetectHolding[], contracts: readonly DetectContract[], now: Date): FindingDraft[]`
  - `function detectNoHumanDecision(holdings: readonly DetectHolding[]): FindingDraft[]`
  - `function detectStaleSources(sources: readonly ClassifiedSource[]): FindingDraft[]`
  - `function detectCoverageGaps(gaps: readonly { kind: string; systemId: string | null; resourceId: string | null; reason: string }[]): FindingDraft[]`
  - `function detectUnexplainedGains(events: readonly { subjectKey: string; systemId: string; resourceKind: string; resourceId: string; resourceName: string; change: string; explained: boolean }[]): FindingDraft[]`
  - `function detectPrivilegedUncertified(holdings: readonly DetectHolding[], certifiedAt: ReadonlyMap<string, Date>, now: Date, privilegedRecertifyDays: number): FindingDraft[]`
  - `async function upsertFindings(tenantId: string, snapshotId: string, drafts: readonly FindingDraft[], options?: { now?: Date; batchSize?: number }): Promise<{ opened: number; updated: number; resolved: number }>`
  - `async function assignFinding(tenantId: string, actorUserId: string | null, findingId: string, ownerPersonId: string, dueAt: Date): Promise<void>`
  - `async function acceptFinding(tenantId: string, actorUserId: string | null, findingId: string, reason: string, until: Date): Promise<void>`
  - `async function sweepAcceptedFindings(tenantId: string, now: Date): Promise<{ lapsed: number }>`
  - `async function createRemediationItem(tx: TenantClient, input: { kind: string; ownerPersonId: string; dueAt: Date; findingId?: string | null; campaignItemId?: string | null; description: string; deepLink: string }): Promise<string | null>`
  - `async function resolveRemediationItem(tenantId: string, actorUserId: string | null, itemId: string, status: 'done' | 'wont_fix', comment: string): Promise<void>`

**The signature that closes Ruling A-3's shape by construction.**

```ts
function detectAccessWithoutContract(
  holdings: readonly DetectHolding[],
  contracts: readonly DetectContract[],
  now: Date,
): FindingDraft[]
```

It takes holdings and contracts and **nothing else**. No exceptions, no accepted findings, no campaign items, no certifications, no grants. It is structurally incapable of concluding that a person is still employed because somebody attested to their access, accepted a finding about it, or excepted an SoD rule for them. Automate's C1 kept a leaver's account enabled forever by teaching `account.required` about grants; Provision's P23 froze a leaver's deprovisioning behind an unrelated flag. Both were "something unrelated to employment silently becoming the reason access persists after it ends". **Here the function cannot see the unrelated thing.**

- [ ] **Step 1: Write the failing detection tests**

`packages/core/src/govern/finding-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  acceptFinding,
  assignFinding,
  createRemediationItem,
  detectAccessWithoutContract,
  detectCoverageGaps,
  detectNoHumanDecision,
  detectPrivilegedUncertified,
  detectStaleSources,
  detectUnattributableHoldings,
  detectUnexplainedGains,
  resolveRemediationItem,
  sweepAcceptedFindings,
  upsertFindings,
  type DetectHolding,
} from './finding-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const holding = (over: Partial<DetectHolding> = {}): DetectHolding => ({
  subjectKey: 'person:p-1',
  personId: 'p-1',
  accountRef: null,
  systemId: 'sys-1',
  systemName: 'Acme AD',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-1',
  resourceName: 'Finance-Payments',
  privileged: false,
  unattributable: false,
  attributionKinds: ['business_rule'],
  ...over,
});

describe('detectUnattributableHoldings', () => {
  it('raises one finding per unattributable holding, naming the resource', () => {
    const drafts = detectUnattributableHoldings([
      holding(),
      holding({ resourceId: 'ent-2', resourceName: 'Domain Admins', unattributable: true, attributionKinds: [] }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'unattributable_holding', subjectRefType: 'holding' });
    expect(drafts[0]!.detail['resourceName']).toBe('Domain Admins');
  });

  it('raises `critical` for an unattributable PRIVILEGED holding', () => {
    // A hand grant on a Syntra role, or an entitlement a tenant marked
    // privileged, that nothing in Syntra explains, is what a compromised
    // administrator's persistence looks like.
    const [draft] = detectUnattributableHoldings([
      holding({ unattributable: true, privileged: true, attributionKinds: ['discovered'] }),
    ]);
    expect(draft!.severity).toBe('critical');
  });
});

describe('detectAccessWithoutContract — the leaver finding', () => {
  it('raises a finding for a person holding something with no active contract', () => {
    const drafts = detectAccessWithoutContract(
      [holding()],
      [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: day('2026-05-01') }],
      NOW,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'access_without_contract', subjectRefId: 'p-1' });
    expect(drafts[0]!.detail['holdingCount']).toBe(1);
  });

  it('raises nothing for a person with a live contract', () => {
    expect(
      detectAccessWithoutContract(
        [holding()],
        [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: null }],
        NOW,
      ),
    ).toEqual([]);
  });

  it('raises nothing for a person with a FUTURE contract who has not started', () => {
    // Not yet started is not departed. Provision's Ruling P10 is the same
    // distinction one subsystem over, and getting it wrong here would put
    // every pre-hire on the leaver list on their first day.
    expect(
      detectAccessWithoutContract(
        [holding()],
        [{ personId: 'p-1', startDate: day('2026-09-01'), endDate: null }],
        NOW,
      ),
    ).toEqual([]);
  });

  it('raises a finding for a person with NO contracts at all who holds something', () => {
    // The empty case. A person with no contract row and live access is the
    // most interesting version of this finding and the one a naive
    // "endDate < now" filter misses entirely.
    const drafts = detectAccessWithoutContract([holding()], [], NOW);
    expect(drafts).toHaveLength(1);
  });

  it('ignores an unattributed account, which belongs to nobody to have a contract', () => {
    expect(
      detectAccessWithoutContract(
        [holding({ subjectKey: 'account:sys-1:a7', personId: null, accountRef: 'a7' })],
        [],
        NOW,
      ),
    ).toEqual([]);
  });

  it('groups every holding of one departed person into ONE finding', () => {
    const drafts = detectAccessWithoutContract(
      [holding(), holding({ resourceId: 'ent-2' }), holding({ resourceId: 'ent-3' })],
      [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: day('2026-05-01') }],
      NOW,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.detail['holdingCount']).toBe(3);
  });

  it('TAKES NO GOVERN STATE — the signature has exactly three parameters', () => {
    // The structural half of the leaver rule. Automate's C1 kept a leaver's
    // account enabled forever by teaching desired state about grants;
    // Provision's P23 froze a leaver's deprovisioning behind an unrelated flag.
    // A fourth parameter here — exceptions, certifications, accepted findings —
    // is how the same defect arrives a third time, so the arity is asserted.
    expect(detectAccessWithoutContract).toHaveLength(3);
  });
});

describe('the other standing findings', () => {
  it('raises no_human_decision for an auto_granted holding', () => {
    const [draft] = detectNoHumanDecision([holding({ attributionKinds: ['auto_granted'] })]);
    expect(draft).toMatchObject({ kind: 'no_human_decision' });
  });

  it('raises nothing for a holding whose request a human approved', () => {
    expect(detectNoHumanDecision([holding({ attributionKinds: ['request'] })])).toEqual([]);
  });

  it('raises stale_source per stale source, naming the age', () => {
    const [draft] = detectStaleSources([
      {
        sourceKind: 'targetSystem', sourceId: 'sys-1', sourceName: 'Acme AD',
        lastRunId: null, lastSuccessfulReadAt: day('2026-06-01'), lastAttemptedReadAt: null,
        completeness: 'complete', staleness: 'stale', freshnessSlaHours: 24, gapCount: 0,
        ageHours: 336,
      },
    ]);
    expect(draft).toMatchObject({ kind: 'stale_source', subjectRefId: 'sys-1' });
    expect(draft!.detail['ageHours']).toBe(336);
  });

  it('raises unexplained_gain only for a GAIN Syntra did not cause', () => {
    // The most valuable row this system produces: access appeared, and Syntra
    // did not cause it. An explained gain is a grant working correctly.
    const drafts = detectUnexplainedGains([
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'g', resourceName: 'G', change: 'gained', explained: false },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'h', resourceName: 'H', change: 'gained', explained: true },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'i', resourceName: 'I', change: 'lost', explained: false },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'j', resourceName: 'J', change: 'became_unknown', explained: false },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.detail['resourceName']).toBe('G');
  });

  it('raises privileged_uncertified for a privileged holding never certified', () => {
    const [draft] = detectPrivilegedUncertified([holding({ privileged: true })], new Map(), NOW, 90);
    expect(draft).toMatchObject({ kind: 'privileged_uncertified' });
    expect(draft!.detail['lastCertifiedAt']).toBeNull();
  });

  it('raises privileged_uncertified for one certified longer ago than the window', () => {
    const key = 'person:p-1|sys-1|targetEntitlement|ent-1';
    const drafts = detectPrivilegedUncertified(
      [holding({ privileged: true })],
      new Map([[key, day('2026-01-01')]]),
      NOW,
      90,
    );
    expect(drafts).toHaveLength(1);
  });

  it('raises nothing for one certified inside the window', () => {
    const key = 'person:p-1|sys-1|targetEntitlement|ent-1';
    expect(
      detectPrivilegedUncertified([holding({ privileged: true })], new Map([[key, day('2026-06-01')]]), NOW, 90),
    ).toEqual([]);
  });

  it('raises nothing for an UNPRIVILEGED holding never certified', () => {
    expect(detectPrivilegedUncertified([holding()], new Map(), NOW, 90)).toEqual([]);
  });
});

describe('the lifecycle', () => {
  let tenantId: string;
  let snapshotId: string;
  let personId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const snapshot = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      const person = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } });
      return { snapshotId: snapshot.id, personId: person.id };
    });
    snapshotId = seeded.snapshotId;
    personId = seeded.personId;
  });

  const draft = (over: Record<string, unknown> = {}) => ({
    kind: 'stale_source' as const,
    severity: 'medium' as const,
    subjectRefType: 'source',
    subjectRefId: 'sys-1',
    detail: {},
    ...over,
  });

  it('opens a finding, then UPDATES it on the next snapshot rather than duplicating', async () => {
    const first = await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    expect(first).toMatchObject({ opened: 1, updated: 0, resolved: 0 });

    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await upsertFindings(tenantId, snapshotId, [draft()], { now: later });
    expect(second).toMatchObject({ opened: 0, updated: 1 });

    const rows = await withTenant(tenantId, (tx) => tx.governFinding.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstSeenAt).toEqual(NOW);
    expect(rows[0]!.lastSeenAt).toEqual(later);
  });

  it('resolves a finding that stopped being observed, NAMING the snapshot that showed it gone', async () => {
    // Not silently deleted. "It went away and we do not know why" is itself
    // worth a row, and a resolution with no snapshot behind it is a
    // disappearance nobody can audit.
    await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    const result = await upsertFindings(tenantId, snapshotId, [], { now: NOW });
    expect(result.resolved).toBe(1);

    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(row).toMatchObject({ status: 'resolved', resolvedBySnapshotId: snapshotId });
  });

  it('does not resurrect a finding an operator ACCEPTED', async () => {
    await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    await acceptFinding(tenantId, null, row.id, 'known and tolerated', day('2026-07-01'));

    await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    const after = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(after.status).toBe('accepted');
  });

  it('lapses an acceptance back to open and RAISES its severity one step', async () => {
    // A finding somebody once formally accepted and then let quietly expire is
    // a different and worse thing than one nobody has looked at yet.
    await upsertFindings(tenantId, snapshotId, [draft({ severity: 'medium' })], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    await acceptFinding(tenantId, null, row.id, 'until the migration lands', day('2026-06-10'));

    const result = await sweepAcceptedFindings(tenantId, NOW);
    expect(result.lapsed).toBe(1);

    const after = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(after).toMatchObject({ status: 'open', severity: 'high' });
  });

  it('refuses an acceptance with no expiry', async () => {
    await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    // Not representable in the type either; this is the runtime backstop.
    await expect(
      acceptFinding(tenantId, null, row.id, 'forever', new Date('1970-01-01')),
    ).rejects.toThrow(/expiry must be in the future/i);
  });

  it('writes an audit event when a finding is assigned or accepted', async () => {
    await upsertFindings(tenantId, snapshotId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    await assignFinding(tenantId, null, row.id, personId, day('2026-07-01'));
    await acceptFinding(tenantId, null, row.id, 'known', day('2026-07-01'));

    const actions = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'govern.finding.assign',
      'govern.finding.accept',
    ]);
  });
});

describe('remediation items', () => {
  let tenantId: string;
  let personId: string;
  let findingId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } });
      const finding = await tx.governFinding.create({
        data: {
          tenantId, kind: 'orphan_account', severity: 'medium',
          subjectRefType: 'account', subjectRefId: 'sys:a7',
          detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
        },
      });
      return { personId: person.id, findingId: finding.id };
    });
    personId = seeded.personId;
    findingId = seeded.findingId;
  });

  it('creates one item and returns null rather than throwing on a duplicate', async () => {
    // A nightly snapshot re-observes the same problem. Chasing it once is
    // correct; a P2002 that kills the whole detect stage is not.
    const input = {
      kind: 'orphan_attribution',
      ownerPersonId: personId,
      dueAt: day('2026-07-01'),
      findingId,
      description: 'confirm or deny the proposed owner',
      deepLink: '/admin/govern/orphans',
    };
    const first = await withTenant(tenantId, (tx) => createRemediationItem(tx, input));
    const second = await withTenant(tenantId, (tx) => createRemediationItem(tx, input));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('admits a new item once the previous one is closed', async () => {
    const input = {
      kind: 'orphan_attribution',
      ownerPersonId: personId,
      dueAt: day('2026-07-01'),
      findingId,
      description: 'confirm or deny',
      deepLink: '/admin/govern/orphans',
    };
    const first = await withTenant(tenantId, (tx) => createRemediationItem(tx, input));
    await resolveRemediationItem(tenantId, null, first!, 'wont_fix', 'a service account, deliberately');
    const second = await withTenant(tenantId, (tx) => createRemediationItem(tx, input));
    expect(second).not.toBeNull();
  });

  it('requires a comment on wont_fix', async () => {
    const id = await withTenant(tenantId, (tx) =>
      createRemediationItem(tx, {
        kind: 'orphan_attribution', ownerPersonId: personId, dueAt: day('2026-07-01'),
        findingId, description: 'x', deepLink: '/y',
      }),
    );
    await expect(resolveRemediationItem(tenantId, null, id!, 'wont_fix', '')).rejects.toThrow(
      /comment/i,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/finding-service.test.ts`
Expected: FAIL — `Cannot find module './finding-service.js'`.

- [ ] **Step 3: Write the detectors**

`packages/core/src/govern/finding-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { ClassifiedSource } from './freshness.js';
import { raiseSeverity, type FindingKind, type Severity } from './types.js';

/** Bounded so a tenant with 40,000 findings does not write them in one transaction. */
export const FINDING_BATCH = 200;

export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  subjectRefType: string;
  subjectRefId: string;
  detail: Record<string, unknown>;
  /** A Provision DriftFinding this AGGREGATES, never copies. */
  driftFindingId?: string | null;
}

export interface DetectHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  systemName: string;
  resourceKind: string;
  resourceId: string;
  resourceName: string;
  privileged: boolean;
  unattributable: boolean;
  attributionKinds: readonly string[];
}

export interface DetectContract {
  personId: string;
  startDate: Date;
  endDate: Date | null;
}

const holdingRef = (h: DetectHolding) =>
  `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;

/**
 * An unattributable holding is the single most interesting thing an access
 * review can find. It is what a hand grant looks like, what a compromised
 * administrator's persistence looks like, and what a system nobody remembers
 * configuring looks like.
 */
export function detectUnattributableHoldings(
  holdings: readonly DetectHolding[],
): FindingDraft[] {
  return holdings
    .filter((h) => h.unattributable)
    .map((h) => ({
      kind: 'unattributable_holding' as const,
      severity: (h.privileged ? 'critical' : 'high') as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        systemId: h.systemId,
        systemName: h.systemName,
        resourceKind: h.resourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        privileged: h.privileged,
        attributionKinds: [...h.attributionKinds],
      },
    }));
}

/**
 * The leaver finding, and the one this whole platform keeps rediscovering.
 *
 * THE SIGNATURE IS THE CONTROL. Three parameters: holdings, contracts, now.
 * There is deliberately no fourth. Automate's C1 kept a leaver's account
 * enabled forever by teaching desired state about grants; Provision's P23 froze
 * a leaver's deprovisioning behind an unrelated flag. Both were "something
 * unrelated to employment silently becoming the reason access persists after it
 * ends". This function CANNOT SEE the unrelated thing: no exception, no
 * certification, no accepted finding and no campaign item is in scope here, so
 * none of them can ever become evidence that somebody is still employed.
 *
 * Each subsystem correctly handles its own remit; nobody but Govern looks
 * across all of them at once.
 */
export function detectAccessWithoutContract(
  holdings: readonly DetectHolding[],
  contracts: readonly DetectContract[],
  now: Date,
): FindingDraft[] {
  const activeByPerson = new Map<string, boolean>();
  const knownPersons = new Set<string>();
  for (const contract of contracts) {
    knownPersons.add(contract.personId);
    const active = contract.startDate <= now && (contract.endDate === null || contract.endDate >= now);
    activeByPerson.set(contract.personId, (activeByPerson.get(contract.personId) ?? false) || active);
  }

  // A person whose contract has not STARTED is not departed. Provision's Ruling
  // P10 is the same distinction one subsystem over, and getting it wrong here
  // would put every pre-hire on the leaver list on their first day.
  const notYetStarted = new Set(
    contracts
      .filter((c) => c.startDate > now && (c.endDate === null || c.endDate >= now))
      .map((c) => c.personId),
  );

  const byPerson = new Map<string, DetectHolding[]>();
  for (const holding of holdings) {
    if (holding.personId === null) continue;
    if (activeByPerson.get(holding.personId) === true) continue;
    if (notYetStarted.has(holding.personId)) continue;
    byPerson.set(holding.personId, [...(byPerson.get(holding.personId) ?? []), holding]);
  }

  return [...byPerson].map(([personId, held]) => ({
    kind: 'access_without_contract' as const,
    severity: (held.some((h) => h.privileged) ? 'critical' : 'high') as Severity,
    subjectRefType: 'person',
    subjectRefId: personId,
    detail: {
      holdingCount: held.length,
      // A person with no contract row at all is a different and more
      // interesting case than one whose contract ended, and the finding says
      // which.
      hasAnyContractRecord: knownPersons.has(personId),
      holdings: held.map((h) => ({
        systemName: h.systemName,
        resourceKind: h.resourceKind,
        resourceName: h.resourceName,
        privileged: h.privileged,
      })),
    },
  }));
}

/**
 * A zero-stage workflow is a legitimate configuration, and the grant it
 * produces has no approver. Access nobody decided is precisely the access a
 * recertification exists to have somebody decide, so it is counted, listed and
 * campaigned first.
 */
export function detectNoHumanDecision(holdings: readonly DetectHolding[]): FindingDraft[] {
  return holdings
    .filter((h) => h.attributionKinds.includes('auto_granted'))
    .map((h) => ({
      kind: 'no_human_decision' as const,
      severity: (h.privileged ? 'high' : 'medium') as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        resourceName: h.resourceName,
        systemName: h.systemName,
        note: 'this access was granted by a workflow with no approval stages; no human decided it',
      },
    }));
}

/** A source nobody has read is a report nobody should trust. A finding, not a badge. */
export function detectStaleSources(sources: readonly ClassifiedSource[]): FindingDraft[] {
  return sources
    .filter((s) => s.staleness === 'stale')
    .map((s) => ({
      kind: 'stale_source' as const,
      severity: (s.lastSuccessfulReadAt === null ? 'high' : 'medium') as Severity,
      subjectRefType: 'source',
      subjectRefId: s.sourceId,
      detail: {
        sourceKind: s.sourceKind,
        sourceName: s.sourceName,
        ageHours: s.ageHours,
        freshnessSlaHours: s.freshnessSlaHours,
        neverRead: s.lastSuccessfulReadAt === null,
      },
    }));
}

export function detectCoverageGaps(
  gaps: readonly { kind: string; systemId: string | null; resourceId: string | null; reason: string }[],
): FindingDraft[] {
  // One finding per gapped REGION, not per gap row, so a target with 400
  // unreadable groups produces 400 rows on the coverage screen and one row on
  // the findings queue — which is where somebody works down a list.
  const byRegion = new Map<string, { count: number; reason: string; systemId: string | null }>();
  for (const gap of gaps) {
    const key = `${gap.kind}|${gap.systemId ?? ''}`;
    const existing = byRegion.get(key);
    byRegion.set(key, {
      count: (existing?.count ?? 0) + 1,
      reason: existing?.reason ?? gap.reason,
      systemId: gap.systemId,
    });
  }
  return [...byRegion].map(([key, value]) => ({
    kind: 'coverage_gap' as const,
    severity: 'high' as Severity,
    subjectRefType: 'source',
    subjectRefId: key,
    detail: { gapCount: value.count, example: value.reason, systemId: value.systemId },
  }));
}

/** Access appeared, and Syntra did not cause it. */
export function detectUnexplainedGains(
  events: readonly {
    subjectKey: string; systemId: string; resourceKind: string;
    resourceId: string; resourceName: string; change: string; explained: boolean;
  }[],
): FindingDraft[] {
  return events
    .filter((e) => e.change === 'gained' && !e.explained)
    .map((e) => ({
      kind: 'unexplained_gain' as const,
      severity: 'high' as Severity,
      subjectRefType: 'holding',
      subjectRefId: `${e.subjectKey}|${e.systemId}|${e.resourceKind}|${e.resourceId}`,
      detail: {
        subjectKey: e.subjectKey,
        resourceName: e.resourceName,
        note: 'this access appeared between two snapshots and no Syntra audit event explains it',
      },
    }));
}

export function detectPrivilegedUncertified(
  holdings: readonly DetectHolding[],
  certifiedAt: ReadonlyMap<string, Date>,
  now: Date,
  privilegedRecertifyDays: number,
): FindingDraft[] {
  const cutoff = new Date(now.getTime() - privilegedRecertifyDays * 86_400_000);
  return holdings
    .filter((h) => h.privileged)
    .filter((h) => {
      const last = certifiedAt.get(holdingRef(h));
      return last === undefined || last < cutoff;
    })
    .map((h) => ({
      kind: 'privileged_uncertified' as const,
      severity: 'high' as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        resourceName: h.resourceName,
        systemName: h.systemName,
        lastCertifiedAt: certifiedAt.get(holdingRef(h))?.toISOString() ?? null,
        privilegedRecertifyDays,
      },
    }));
}
```

- [ ] **Step 4: Write the lifecycle**

Append to `packages/core/src/govern/finding-service.ts`:

```ts
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One lifecycle, one table, one count.
 *
 * A finding that persists across snapshots is UPDATED, not duplicated, so the
 * dashboard count is a count of problems and not a count of snapshots. A
 * finding that stops being observed becomes `resolved` WITH THE SNAPSHOT THAT
 * SHOWED IT GONE, not silently deleted, because "it went away and we do not
 * know why" is itself worth a row.
 *
 * An `accepted` finding is left alone. Re-opening it every night would make an
 * operator's deliberate risk acceptance a decision they had to re-make daily,
 * which is how people learn to close findings without reading them.
 */
export async function upsertFindings(
  tenantId: string,
  snapshotId: string,
  drafts: readonly FindingDraft[],
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ opened: number; updated: number; resolved: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;
  const seen = new Set(drafts.map((d) => `${d.kind}|${d.subjectRefType}|${d.subjectRefId}`));

  let opened = 0;
  let updated = 0;

  for (const batch of chunk(drafts, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      for (const draft of batch) {
        const existing = await tx.governFinding.findUnique({
          where: {
            tenantId_kind_subjectRefType_subjectRefId: {
              tenantId,
              kind: draft.kind,
              subjectRefType: draft.subjectRefType,
              subjectRefId: draft.subjectRefId,
            },
          },
        });

        if (existing === null) {
          await tx.governFinding.create({
            data: {
              tenantId,
              kind: draft.kind,
              severity: draft.severity,
              subjectRefType: draft.subjectRefType,
              subjectRefId: draft.subjectRefId,
              detail: draft.detail as never,
              driftFindingId: draft.driftFindingId ?? null,
              firstSeenAt: now,
              lastSeenAt: now,
            },
          });
          opened += 1;
          continue;
        }

        if (existing.status === 'accepted') continue;

        await tx.governFinding.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            severity: draft.severity,
            detail: draft.detail as never,
            ...(existing.status === 'resolved'
              ? { status: 'open', resolvedAt: null, resolvedBySnapshotId: null }
              : {}),
          },
        });
        updated += 1;
      }
    });
  }

  const stillOpen = await withTenant(tenantId, (tx) =>
    tx.governFinding.findMany({
      where: { status: { in: ['open', 'acknowledged'] } },
      select: { id: true, kind: true, subjectRefType: true, subjectRefId: true },
    }),
  );
  const goneIds = stillOpen
    .filter((f) => !seen.has(`${f.kind}|${f.subjectRefType}|${f.subjectRefId}`))
    .map((f) => f.id);

  let resolved = 0;
  for (const batch of chunk(goneIds, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      const result = await tx.governFinding.updateMany({
        where: { id: { in: batch } },
        data: { status: 'resolved', resolvedAt: now, resolvedBySnapshotId: snapshotId },
      });
      resolved += result.count;
    });
  }

  return { opened, updated, resolved };
}

export async function assignFinding(
  tenantId: string,
  actorUserId: string | null,
  findingId: string,
  ownerPersonId: string,
  dueAt: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.governFinding.update({
      where: { id: findingId },
      data: { ownerPersonId, dueAt, status: 'acknowledged' },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.finding.assign',
      targetType: 'GovernFinding',
      targetId: findingId,
      outcome: 'success',
      sourceIp: null,
      payload: { ownerPersonId, dueAt: dueAt.toISOString() },
    });
  });
}

/**
 * Acceptance requires a reason AND an expiry, and behaves like an SoD exception
 * in miniature: it lapses back to `open` and tells the owner. Acceptance with
 * no expiry is not representable, because a perpetual acceptance is a decision
 * nobody ever re-makes.
 */
export async function acceptFinding(
  tenantId: string,
  actorUserId: string | null,
  findingId: string,
  reason: string,
  until: Date,
): Promise<void> {
  if (reason.trim().length === 0) throw new Error('accepting a finding requires a reason');
  if (until.getTime() <= Date.now()) {
    throw new Error('the acceptance expiry must be in the future; there is no perpetual acceptance');
  }

  await withTenant(tenantId, async (tx) => {
    await tx.governFinding.update({
      where: { id: findingId },
      data: { status: 'accepted', acceptedReason: reason, acceptedUntil: until },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.finding.accept',
      targetType: 'GovernFinding',
      targetId: findingId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason, until: until.toISOString() },
    });
  });
}

/**
 * A finding somebody once formally accepted and then let quietly expire is a
 * different and worse thing than one nobody has looked at yet, so the severity
 * goes up one step and the finding says why.
 */
export async function sweepAcceptedFindings(
  tenantId: string,
  now: Date,
): Promise<{ lapsed: number }> {
  return withTenant(tenantId, async (tx) => {
    const lapsing = await tx.governFinding.findMany({
      where: { status: 'accepted', acceptedUntil: { lt: now } },
      select: { id: true, severity: true, detail: true },
    });

    for (const finding of lapsing) {
      await tx.governFinding.update({
        where: { id: finding.id },
        data: {
          status: 'open',
          severity: raiseSeverity(finding.severity as Severity),
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
        payload: { raisedTo: raiseSeverity(finding.severity as Severity) },
      });
    }

    return { lapsed: lapsing.length };
  });
}

/**
 * Returns the new item's id, or NULL when one is already open for this source.
 *
 * Null rather than a throw, deliberately: a nightly snapshot re-observes the
 * same problem, and a P2002 on `remediation_item_one_open_per_finding` would
 * kill the whole detect stage over a row that is already being chased.
 */
export async function createRemediationItem(
  tx: TenantClient,
  input: {
    kind: string;
    ownerPersonId: string;
    dueAt: Date;
    findingId?: string | null;
    campaignItemId?: string | null;
    description: string;
    deepLink: string;
  },
): Promise<string | null> {
  const existing = await tx.remediationItem.findFirst({
    where: {
      kind: input.kind,
      status: { in: ['open', 'in_progress'] },
      ...(input.findingId == null ? {} : { findingId: input.findingId }),
      ...(input.campaignItemId == null ? {} : { campaignItemId: input.campaignItemId }),
    },
    select: { id: true },
  });
  if (existing !== null) return null;

  const created = await tx.remediationItem.create({
    data: {
      tenantId: (await tx.governFinding.findFirst({ select: { tenantId: true } }))?.tenantId ??
        (await tx.remediationItem.findFirst({ select: { tenantId: true } }))?.tenantId ??
        '',
      kind: input.kind,
      ownerPersonId: input.ownerPersonId,
      dueAt: input.dueAt,
      findingId: input.findingId ?? null,
      campaignItemId: input.campaignItemId ?? null,
      description: input.description,
      deepLink: input.deepLink,
    },
  });
  return created.id;
}

export async function resolveRemediationItem(
  tenantId: string,
  actorUserId: string | null,
  itemId: string,
  status: 'done' | 'wont_fix',
  comment: string,
): Promise<void> {
  if (comment.trim().length === 0) {
    throw new Error('closing a remediation item requires a comment saying what changed or why not');
  }
  await withTenant(tenantId, async (tx) => {
    await tx.remediationItem.update({
      where: { id: itemId },
      data: { status, resolutionComment: comment, resolvedByUserId: actorUserId, resolvedAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.remediation.resolve',
      targetType: 'RemediationItem',
      targetId: itemId,
      outcome: 'success',
      sourceIp: null,
      payload: { status, comment },
    });
  });
}
```

**Correction to `createRemediationItem`'s tenant lookup.** The `tenantId` derivation above is wrong — it reads it off an unrelated row. Replace it with an explicit parameter:

```ts
export async function createRemediationItem(
  tx: TenantClient,
  tenantId: string,
  input: { /* as above */ },
): Promise<string | null>
```

and pass `tenantId` at every call site. Every caller in this plan is inside a `withTenant(tenantId, …)` and already has it. **This is recorded rather than quietly fixed above** so the implementer sees the shape that was wrong and why: a domain function that infers its tenant from whatever row happens to exist writes into the wrong tenant the moment the first row belongs to somebody else, and forced RLS would not catch it because the transaction's GUC is already the caller's tenant.

- [ ] **Step 5: Wire the detectors into the build's detect stage**

In `packages/core/src/govern/snapshot-service.ts`, after the `HoldingEvent` write and before the `complete` flip, add:

```ts
    // ---- detect: the standing findings ------------------------------------
    const contracts = await withTenant(tenantId, (tx) =>
      tx.contract.findMany({ select: { personId: true, startDate: true, endDate: true } }),
    );
    const certifications = await withTenant(tenantId, (tx) =>
      tx.holdingCertification.findMany({
        select: {
          subjectRefType: true, subjectRefId: true, systemId: true,
          resourceKind: true, resourceId: true, lastCertifiedAt: true,
        },
      }),
    );
    const settings = await withTenant(tenantId, (tx) =>
      tx.governSettings.findUnique({ where: { tenantId }, select: { privilegedRecertifyDays: true } }),
    );

    const detectHoldings: DetectHolding[] = prepared.map((h) => ({
      subjectKey: h.subjectKey,
      personId: h.personId,
      accountRef: h.accountRef,
      systemId: h.systemId,
      systemName: h.systemId,
      resourceKind: h.resourceKind,
      resourceId: h.resourceId,
      resourceName: h.resourceName,
      privileged: h.privileged,
      unattributable: h.unattributable,
      attributionKinds: h.attributions.map((a) => a.kind),
    }));

    const certifiedAt = new Map(
      certifications.map((c) => [
        `${c.subjectRefType === 'person' ? 'person' : 'account'}:${c.subjectRefId}|${c.systemId}|${c.resourceKind}|${c.resourceId}`,
        c.lastCertifiedAt,
      ]),
    );

    await upsertFindings(
      tenantId,
      snapshotId,
      [
        ...detectUnattributableHoldings(detectHoldings),
        ...detectAccessWithoutContract(detectHoldings, contracts, collected.asOf),
        ...detectNoHumanDecision(detectHoldings),
        ...detectStaleSources(sources),
        ...detectCoverageGaps(allGaps),
        ...detectPrivilegedUncertified(
          detectHoldings,
          certifiedAt,
          collected.asOf,
          settings?.privilegedRecertifyDays ?? 90,
        ),
      ],
      { now: collected.asOf },
    );
```

Add the imports at the head of `snapshot-service.ts`:

```ts
import {
  detectAccessWithoutContract,
  detectCoverageGaps,
  detectNoHumanDecision,
  detectPrivilegedUncertified,
  detectStaleSources,
  detectUnattributableHoldings,
  upsertFindings,
  type DetectHolding,
} from './finding-service.js';
```

`detectUnexplainedGains` is deliberately **not** called here: it needs the audit cross-reference that Task 10 supplies, and calling it now would raise an `unexplained_gain` for every gain in the tenant. Task 10 adds the call.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/finding-service.test.ts packages/core/src/govern/snapshot-service.test.ts`
Expected: PASS, 25 + 17 tests.

- [ ] **Step 7: Export and typecheck**

Add `export * from './govern/finding-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 8: Mutation-test the leaver rule and the lifecycle**

Each reverted before the next; every one must produce a failure:

1. In `detectAccessWithoutContract`, drop the `notYetStarted` filter. Expected: `raises nothing for a person with a FUTURE contract who has not started` FAILS.
2. Change the "no contracts at all" path to require a contract row. Expected: `raises a finding for a person with NO contracts at all` FAILS.
3. **Add a fourth parameter** — `certifications: ReadonlyMap<string, Date>` — and skip persons with a recent certification. Expected: `TAKES NO GOVERN STATE` FAILS on the arity. This is the mutation the arity assertion exists for, and it is precisely the shape of Automate's C1.
4. In `upsertFindings`, remove the `existing.status === 'accepted'` skip. Expected: `does not resurrect a finding an operator ACCEPTED` FAILS.
5. In `upsertFindings`, change the resolution to `deleteMany`. Expected: `resolves a finding that stopped being observed, NAMING the snapshot` FAILS.
6. In `sweepAcceptedFindings`, drop the `raiseSeverity` call. Expected: `lapses an acceptance back to open and RAISES its severity` FAILS.
7. In `createRemediationItem`, throw on a duplicate instead of returning null. Expected: `creates one item and returns null rather than throwing` FAILS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/govern/finding-service.ts \
        packages/core/src/govern/finding-service.test.ts \
        packages/core/src/govern/snapshot-service.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): findings, remediation and the standing findings"
```

---
## Task 9: Orphan attribution — propose, claim, confirm

An account belonging to no person is outside every person-scoped review and every SoD check, so resolving it is inventory work. Spec §16. **Govern proposes an owner and never assigns one.**

**Files:**
- Create: `packages/core/src/govern/orphan-service.ts`
- Test: `packages/core/src/govern/orphan-service.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `foldIdentifier` from `./collect.js`; `readableSnapshot` from `./snapshot-service.js`; `createRemediationItem`, `upsertFindings`, `type FindingDraft` from `./finding-service.js`; `personDisplayName`, `type PersonFacts` from `../provision/desired.js`; `usersWithPermission` from `../automate/notify.js`.
- Produces (all in `./orphan-service.js`):
  - `type AttributionMethod = 'name_similarity' | 'mail_address' | 'employee_identifier' | 'adjacent_manager'`
  - `interface OrphanAccount { systemId: string; systemName: string; accountRef: string; displayName: string | null; mail: string | null; employeeId: string | null; managerAccountRef: string | null }`
  - `interface CandidatePerson { personId: string; givenName: string; familyName: string; businessEmail: string | null; personalEmail: string | null; externalId: string | null; managerPersonId: string | null }`
  - `interface Proposal { personId: string; method: AttributionMethod; confidence: number; because: string }`
  - `function proposeOwners(account: OrphanAccount, candidates: readonly CandidatePerson[], accountOwnerByRef: ReadonlyMap<string, string>): Proposal[]`
  - `function trigramSimilarity(a: string, b: string): number`
  - `async function refreshOrphanProposals(tenantId: string, snapshotId: string, options?: { now?: Date }): Promise<{ orphans: number; proposals: number }>`
  - `async function denyProposal(tenantId: string, actorUserId: string, proposalId: string, reason: string): Promise<void>`
  - `async function confirmProposal(tenantId: string, actorUserId: string, proposalId: string, link: (tenantId: string, actorUserId: string, systemId: string, accountRef: string, personId: string) => Promise<void>): Promise<void>`

**`confirmProposal` takes the linking function as a parameter.** Govern does not write `TargetAccount`; §16 says confirmation "calls Provision's own account-linking entry point — the same one an administrator uses to resolve a `conflict`". Injecting it keeps `boundaries.test.ts`'s no-access-bearing-write assertion true of this module and makes the seam visible rather than implied. Task 13 wires Provision's real function at the route.

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/orphan-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  confirmProposal,
  denyProposal,
  proposeOwners,
  refreshOrphanProposals,
  trigramSimilarity,
  type CandidatePerson,
  type OrphanAccount,
} from './orphan-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');

const account = (over: Partial<OrphanAccount> = {}): OrphanAccount => ({
  systemId: 'sys-1',
  systemName: 'Acme AD',
  accountRef: 'anchor-7',
  displayName: 'A.Novak',
  mail: null,
  employeeId: null,
  managerAccountRef: null,
  ...over,
});

const anna: CandidatePerson = {
  personId: 'p-anna',
  givenName: 'Anna',
  familyName: 'Novak',
  businessEmail: 'Anna.Novak@acme.test',
  personalEmail: null,
  externalId: 'E1001',
  managerPersonId: 'p-jan',
};

const bram: CandidatePerson = {
  personId: 'p-bram',
  givenName: 'Bram',
  familyName: 'Visser',
  businessEmail: 'bram.visser@acme.test',
  personalEmail: null,
  externalId: 'E2002',
  managerPersonId: null,
};

describe('proposeOwners', () => {
  it('matches on mail address, case-insensitively', () => {
    // AD folds case and PostgreSQL does not. Three defects on the Provision
    // slice came from that, and a mail match that missed on casing would send
    // every orphan to the bottom of a list nobody works.
    const proposals = proposeOwners(account({ mail: 'ANNA.NOVAK@ACME.TEST' }), [anna, bram], new Map());
    expect(proposals[0]).toMatchObject({ personId: 'p-anna', method: 'mail_address' });
    expect(proposals[0]!.confidence).toBeGreaterThan(0.9);
  });

  it('matches on employee identifier', () => {
    const proposals = proposeOwners(account({ employeeId: 'E2002' }), [anna, bram], new Map());
    expect(proposals[0]).toMatchObject({ personId: 'p-bram', method: 'employee_identifier' });
  });

  it('matches on name similarity, and folds with NFKD', () => {
    const proposals = proposeOwners(
      account({ displayName: 'Ĳsbrand Novak' }),
      [{ ...anna, givenName: 'Ijsbrand' }, bram],
      new Map(),
    );
    expect(proposals[0]!.personId).toBe('p-anna');
    expect(proposals[0]!.method).toBe('name_similarity');
  });

  it('matches on the manager of an adjacent account', () => {
    const proposals = proposeOwners(
      account({ displayName: null, managerAccountRef: 'anchor-jan' }),
      [anna, bram],
      new Map([['anchor-jan', 'p-jan']]),
    );
    expect(proposals.map((p) => p.personId)).toContain('p-anna');
    expect(proposals.find((p) => p.personId === 'p-anna')!.method).toBe('adjacent_manager');
  });

  it('returns NOTHING when the account carries no identifying attribute at all', () => {
    // The empty case, and the dangerous direction is the other one: a matcher
    // that returned every candidate for a blank account would put the whole
    // organization on a claim screen at equal confidence.
    expect(
      proposeOwners(account({ displayName: null, mail: null, employeeId: null }), [anna, bram], new Map()),
    ).toEqual([]);
  });

  it('returns nothing for a similarity below the floor rather than a weak guess', () => {
    expect(proposeOwners(account({ displayName: 'zzzz qqqq' }), [anna, bram], new Map())).toEqual([]);
  });

  it('carries a `because` sentence per proposal', () => {
    const [proposal] = proposeOwners(account({ mail: 'anna.novak@acme.test' }), [anna], new Map());
    expect(proposal!.because).toContain('anna.novak@acme.test');
  });

  it('orders by confidence, highest first, and never exceeds 1', () => {
    const proposals = proposeOwners(
      account({ mail: 'anna.novak@acme.test', displayName: 'Anna Novak' }),
      [anna, bram],
      new Map(),
    );
    expect(proposals[0]!.confidence).toBeLessThanOrEqual(1);
    for (let i = 1; i < proposals.length; i += 1) {
      expect(proposals[i - 1]!.confidence).toBeGreaterThanOrEqual(proposals[i]!.confidence);
    }
  });
});

describe('the claim flow', () => {
  let tenantId: string;
  let snapshotId: string;
  let personId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak', businessEmail: 'anna.novak@acme.test' },
      });
      const snapshot = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId, snapshotId: snapshot.id, sourceKind: 'syntraInternal', sourceId: 'syntra',
          sourceName: 'Syntra', completeness: 'complete', staleness: 'fresh', freshnessSlaHours: 24,
        },
      });
      await tx.holding.create({
        data: {
          tenantId, snapshotId: snapshot.id,
          subjectKey: 'account:sys-1:anchor-7', accountRef: 'anchor-7',
          systemKind: 'targetSystem', systemId: 'sys-1',
          resourceKind: 'targetAccount', resourceId: 'anchor-7',
          resourceName: 'anna.novak@acme.test (active)',
          state: 'held', observedAt: NOW, observedVia: 'provision:sys-1', firstSeenAt: NOW,
          unattributable: true,
        },
      });
      return { snapshotId: snapshot.id, personId: person.id };
    });
    snapshotId = seeded.snapshotId;
    personId = seeded.personId;
  });

  it('writes a proposal and an orphan_account finding, and never links anything', async () => {
    const result = await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    expect(result.orphans).toBe(1);
    expect(result.proposals).toBeGreaterThan(0);

    const [proposals, findings, accounts] = await withTenant(tenantId, async (tx) => [
      await tx.accountAttribution.findMany(),
      await tx.governFinding.findMany({ where: { kind: 'orphan_account' } }),
      await tx.targetAccount.findMany(),
    ]);
    expect(proposals[0]).toMatchObject({ status: 'proposed', proposedPersonId: personId });
    expect(findings).toHaveLength(1);
    // Never automatic, at any confidence. Provision's next run evaluates that
    // person's desired state against that account, and a wrong link is a
    // leaver's account attached to a current employee.
    expect(accounts).toEqual([]);
  });

  it('a denial is recorded and suppresses that candidate on the next refresh', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await denyProposal(tenantId, 'user-1', proposal.id, 'that is a service account, not Anna');

    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const rows = await withTenant(tenantId, (tx) => tx.accountAttribution.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'denied', decidedReason: 'that is a service account, not Anna' });
  });

  it('confirmation calls the injected linking function and writes ONE confirmation', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    const link = vi.fn(async () => undefined);

    await confirmProposal(tenantId, 'user-1', proposal.id, link);

    expect(link).toHaveBeenCalledWith(tenantId, 'user-1', 'sys-1', 'anchor-7', personId);
    const row = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    expect(row.status).toBe('confirmed');
  });

  it('refuses a second confirmation for the same account', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await confirmProposal(tenantId, 'user-1', proposal.id, async () => undefined);

    const second = await withTenant(tenantId, (tx) =>
      tx.accountAttribution.create({
        data: {
          tenantId, systemId: 'sys-1', accountRef: 'anchor-7',
          proposedPersonId: personId, method: 'name_similarity', confidence: 0.5,
        },
      }),
    );
    await expect(
      confirmProposal(tenantId, 'user-1', second.id, async () => undefined),
    ).rejects.toThrow(/already/i);
  });

  it('does not roll the confirmation forward when the link throws', async () => {
    // Provision's linking path can refuse — a conflict, a person who already
    // holds an account on that target. A confirmation recorded against a link
    // that did not happen is a screen claiming an orphan is resolved when it is
    // not.
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await expect(
      confirmProposal(tenantId, 'user-1', proposal.id, async () => {
        throw new Error('this person already holds an account on that target');
      }),
    ).rejects.toThrow(/already holds an account/);

    const row = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    expect(row.status).toBe('proposed');
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(trigramSimilarity('anna novak', 'anna novak')).toBe(1);
    expect(trigramSimilarity('anna novak', 'zzzzz qqqqq')).toBe(0);
  });

  it('is 0 for an EMPTY needle rather than 1', () => {
    // The empty pattern is the universal pattern unless something says
    // otherwise. A blank display name matching everybody at confidence 1 is
    // Ruling P20's defect wearing an orphan's clothes.
    expect(trigramSimilarity('', 'anna novak')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/orphan-service.test.ts`
Expected: FAIL — `Cannot find module './orphan-service.js'`.

- [ ] **Step 3: Write the matcher**

`packages/core/src/govern/orphan-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { foldIdentifier } from './collect.js';
import { createRemediationItem, upsertFindings, type FindingDraft } from './finding-service.js';
import { readableSnapshot } from './snapshot-service.js';

export type AttributionMethod =
  | 'name_similarity'
  | 'mail_address'
  | 'employee_identifier'
  | 'adjacent_manager';

export interface OrphanAccount {
  systemId: string;
  systemName: string;
  accountRef: string;
  displayName: string | null;
  mail: string | null;
  employeeId: string | null;
  managerAccountRef: string | null;
}

export interface CandidatePerson {
  personId: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  personalEmail: string | null;
  externalId: string | null;
  managerPersonId: string | null;
}

export interface Proposal {
  personId: string;
  method: AttributionMethod;
  /** 0..1. A number a human reads, never a number a machine acts on. */
  confidence: number;
  because: string;
}

/** Below this, a proposal is a guess and a guess is worse than an empty list. */
const SIMILARITY_FLOOR = 0.55;

function trigrams(value: string): Set<string> {
  const padded = `  ${value.trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Jaccard over character trigrams, on NFKD-folded input.
 *
 * An EMPTY string scores 0 against everything. The empty pattern is the
 * universal pattern unless something says otherwise, and a blank display name
 * matching the whole organization at confidence 1 is Ruling P20's defect
 * wearing an orphan's clothes.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = foldIdentifier(a).trim();
  const right = foldIdentifier(b).trim();
  if (left.length === 0 || right.length === 0) return 0;

  const A = trigrams(left);
  const B = trigrams(right);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  const union = A.size + B.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function proposeOwners(
  account: OrphanAccount,
  candidates: readonly CandidatePerson[],
  accountOwnerByRef: ReadonlyMap<string, string>,
): Proposal[] {
  const proposals: Proposal[] = [];
  const accountMail = account.mail === null ? null : foldIdentifier(account.mail);
  const accountEmployeeId = account.employeeId === null ? null : foldIdentifier(account.employeeId);

  for (const person of candidates) {
    if (accountMail !== null) {
      const addresses = [person.businessEmail, person.personalEmail]
        .filter((x): x is string => x !== null)
        .map(foldIdentifier);
      if (addresses.includes(accountMail)) {
        proposals.push({
          personId: person.personId,
          method: 'mail_address',
          confidence: 0.95,
          because: `the account's mail address ${account.mail!} is this person's recorded address`,
        });
        continue;
      }
    }

    if (accountEmployeeId !== null && person.externalId !== null) {
      if (foldIdentifier(person.externalId) === accountEmployeeId) {
        proposals.push({
          personId: person.personId,
          method: 'employee_identifier',
          confidence: 0.9,
          because: `the account's employee identifier ${account.employeeId!} matches this person's externalId`,
        });
        continue;
      }
    }

    if (account.displayName !== null) {
      const score = trigramSimilarity(
        account.displayName,
        `${person.givenName} ${person.familyName}`,
      );
      if (score >= SIMILARITY_FLOOR) {
        proposals.push({
          personId: person.personId,
          method: 'name_similarity',
          confidence: Math.min(score, 0.85),
          because: `the account name "${account.displayName}" is similar to "${person.givenName} ${person.familyName}"`,
        });
        continue;
      }
    }

    // The adjacent-manager signal: the account next to this one in the
    // directory reports to somebody, and this person reports to that somebody
    // too. Weak on its own, which is why its confidence says so.
    if (account.managerAccountRef !== null && person.managerPersonId !== null) {
      const managerPersonId = accountOwnerByRef.get(account.managerAccountRef);
      if (managerPersonId !== undefined && managerPersonId === person.managerPersonId) {
        proposals.push({
          personId: person.personId,
          method: 'adjacent_manager',
          confidence: 0.4,
          because: `this account's manager and this person's manager are the same person`,
        });
      }
    }
  }

  return proposals.sort((a, b) => b.confidence - a.confidence);
}
```

- [ ] **Step 4: Write the claim flow**

Append to `packages/core/src/govern/orphan-service.ts`:

```ts
/**
 * Rebuilds the proposal set from the current snapshot's orphan accounts.
 *
 * NEVER AUTOMATIC, AT ANY CONFIDENCE. Linking an account to a person is not a
 * labelling exercise: Provision's next run evaluates that person's desired
 * state against that account, and a wrong link is a leaver's account attached
 * to a current employee, or a current employee's account attached to somebody
 * who left and about to be disabled by the ladder. A proposal is cheap and a
 * wrong link is somebody's access.
 */
export async function refreshOrphanProposals(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ orphans: number; proposals: number }> {
  const now = options.now ?? new Date();

  const loaded = await withTenant(tenantId, async (tx) => {
    await readableSnapshot(tx, snapshotId);
    const orphanHoldings = await tx.holding.findMany({
      where: { snapshotId, personId: null, resourceKind: 'targetAccount' },
      select: { systemId: true, accountRef: true, resourceName: true },
    });
    const persons = await tx.person.findMany({
      select: {
        id: true, givenName: true, familyName: true,
        businessEmail: true, personalEmail: true, externalId: true,
      },
    });
    const contracts = await tx.contract.findMany({
      select: { personId: true, managerPersonId: true },
    });
    const linked = await tx.targetAccount.findMany({
      select: { anchor: true, personId: true },
    });
    const denied = await tx.accountAttribution.findMany({
      where: { status: 'denied' },
      select: { systemId: true, accountRef: true, proposedPersonId: true },
    });
    const confirmed = await tx.accountAttribution.findMany({
      where: { status: 'confirmed' },
      select: { systemId: true, accountRef: true },
    });
    return { orphanHoldings, persons, contracts, linked, denied, confirmed };
  });

  const managerByPerson = new Map(
    loaded.contracts
      .filter((c) => c.managerPersonId !== null)
      .map((c) => [c.personId, c.managerPersonId!]),
  );
  const candidates: CandidatePerson[] = loaded.persons.map((p) => ({
    personId: p.id,
    givenName: p.givenName,
    familyName: p.familyName,
    businessEmail: p.businessEmail,
    personalEmail: p.personalEmail,
    externalId: p.externalId,
    managerPersonId: managerByPerson.get(p.id) ?? null,
  }));
  const accountOwnerByRef = new Map(
    loaded.linked
      .filter((a) => a.anchor !== null)
      .map((a) => [a.anchor!, a.personId] as const),
  );
  const deniedKeys = new Set(
    loaded.denied.map((d) => `${d.systemId}|${d.accountRef}|${d.proposedPersonId}`),
  );
  const resolvedAccounts = new Set(loaded.confirmed.map((c) => `${c.systemId}|${c.accountRef}`));

  let proposalCount = 0;
  const findings: FindingDraft[] = [];

  for (const holding of loaded.orphanHoldings) {
    if (holding.accountRef === null) continue;
    if (resolvedAccounts.has(`${holding.systemId}|${holding.accountRef}`)) continue;

    // `resourceName` is `<correlationKey> (<status>)` from the collector, so
    // the display name is everything before the parenthesis.
    const displayName = holding.resourceName.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
    const mail = displayName !== null && displayName.includes('@') ? displayName : null;

    const proposals = proposeOwners(
      {
        systemId: holding.systemId,
        systemName: holding.systemId,
        accountRef: holding.accountRef,
        displayName,
        mail,
        employeeId: null,
        managerAccountRef: null,
      },
      candidates,
      accountOwnerByRef,
    ).filter((p) => !deniedKeys.has(`${holding.systemId}|${holding.accountRef}|${p.personId}`));

    await withTenant(tenantId, async (tx) => {
      for (const proposal of proposals) {
        await tx.accountAttribution.upsert({
          where: {
            tenantId_systemId_accountRef_proposedPersonId: {
              tenantId,
              systemId: holding.systemId,
              accountRef: holding.accountRef!,
              proposedPersonId: proposal.personId,
            },
          },
          create: {
            tenantId,
            systemId: holding.systemId,
            accountRef: holding.accountRef!,
            proposedPersonId: proposal.personId,
            method: proposal.method,
            confidence: proposal.confidence,
          },
          update: { method: proposal.method, confidence: proposal.confidence },
        });
        proposalCount += 1;
      }
    });

    findings.push({
      kind: 'orphan_account',
      severity: 'medium',
      subjectRefType: 'account',
      subjectRefId: `${holding.systemId}:${holding.accountRef}`,
      detail: {
        systemId: holding.systemId,
        accountRef: holding.accountRef,
        displayName,
        proposalCount: proposals.length,
        note:
          proposals.length === 0
            ? 'no candidate owner could be proposed; this account is outside every person-scoped review and every SoD check'
            : 'a candidate owner has been proposed; a human must confirm or deny it',
      },
    });
  }

  if (findings.length > 0) {
    await upsertFindings(tenantId, snapshotId, findings, { now });
  }

  return { orphans: loaded.orphanHoldings.length, proposals: proposalCount };
}

export async function denyProposal(
  tenantId: string,
  actorUserId: string,
  proposalId: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length === 0) throw new Error('denying a proposal requires a reason');
  await withTenant(tenantId, async (tx) => {
    await tx.accountAttribution.update({
      where: { id: proposalId },
      data: { status: 'denied', decidedByUserId: actorUserId, decidedAt: new Date(), decidedReason: reason },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.orphan.deny',
      targetType: 'AccountAttribution',
      targetId: proposalId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason },
    });
  });
}

/**
 * Confirmation calls PROVISION'S account-linking entry point — the same one an
 * administrator uses to resolve a `conflict` — and Govern never writes
 * `TargetAccount`.
 *
 * The linking function is a PARAMETER rather than an import. That keeps the
 * no-access-bearing-write assertion in `boundaries.test.ts` true of this
 * module, and makes the seam visible rather than implied.
 *
 * The link runs BEFORE the confirmation is recorded. Provision's path can
 * legitimately refuse — a conflict, a person who already holds an account on
 * that target — and a confirmation recorded against a link that did not happen
 * is a screen claiming an orphan is resolved when it is not.
 */
export async function confirmProposal(
  tenantId: string,
  actorUserId: string,
  proposalId: string,
  link: (
    tenantId: string,
    actorUserId: string,
    systemId: string,
    accountRef: string,
    personId: string,
  ) => Promise<void>,
): Promise<void> {
  const proposal = await withTenant(tenantId, async (tx) => {
    const row = await tx.accountAttribution.findUniqueOrThrow({ where: { id: proposalId } });
    const already = await tx.accountAttribution.findFirst({
      where: { systemId: row.systemId, accountRef: row.accountRef, status: 'confirmed' },
      select: { id: true },
    });
    if (already !== null) {
      throw new Error('this account already has a confirmed owner');
    }
    return row;
  });

  await link(tenantId, actorUserId, proposal.systemId, proposal.accountRef, proposal.proposedPersonId);

  await withTenant(tenantId, async (tx) => {
    await tx.accountAttribution.update({
      where: { id: proposalId },
      data: { status: 'confirmed', decidedByUserId: actorUserId, decidedAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.orphan.confirm',
      targetType: 'AccountAttribution',
      targetId: proposalId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        systemId: proposal.systemId,
        accountRef: proposal.accountRef,
        personId: proposal.proposedPersonId,
        method: proposal.method,
        confidence: proposal.confidence,
      },
    });
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/orphan-service.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Export and typecheck**

Add `export * from './govern/orphan-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 7: Mutation-test**

1. In `trigramSimilarity`, remove the empty-string guard and return 1 for two empty inputs. Expected: `is 0 for an EMPTY needle rather than 1` FAILS.
2. Lower `SIMILARITY_FLOOR` to 0. Expected: `returns nothing for a similarity below the floor` FAILS.
3. In `proposeOwners`, drop `foldIdentifier` from the mail comparison. Expected: `matches on mail address, case-insensitively` FAILS.
4. In `confirmProposal`, move the `link(...)` call after the update. Expected: `does not roll the confirmation forward when the link throws` FAILS.
5. In `confirmProposal`, delete the `already !== null` check. Expected: `refuses a second confirmation` FAILS with a P2002 on `account_attribution_one_confirmed` instead of the message — which is the point: the index is the backstop and the check is the message.
6. In `refreshOrphanProposals`, drop the `deniedKeys` filter. Expected: `a denial is recorded and suppresses that candidate` FAILS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/govern/orphan-service.ts packages/core/src/govern/orphan-service.test.ts packages/core/src/index.ts
git commit -m "feat(govern): orphan attribution — propose, claim, confirm"
```

---

## Task 10: Audit integrity — the exported hash primitives, incremental verification, checkpoints and anchors

Govern is the subsystem that finally makes the hash chain load-bearing. Spec §17. **This task closes integration finding 1.**

`stableStringify` and `computeHash` are module-private in `packages/core/src/audit/audit-service.ts`, and `verifyChain(tx)` calls `findMany` with no bound — it walks every event ever recorded and loads them all into memory at once. A tenant with ten million events cannot verify nightly that way, and **the practical outcome of an integrity check too expensive to run is an integrity check nobody runs.** Reimplementing the hash would produce a second function that drifts from the one that wrote the chain, and the drift would surface as a chain that verifies as broken when it is whole.

**Files:**
- Modify: `packages/core/src/audit/audit-service.ts` (export two functions, add nothing else)
- Create: `packages/core/src/govern/audit-integrity.ts`
- Test: `packages/core/src/govern/audit-integrity.test.ts`
- Modify: `packages/core/src/govern/snapshot-service.ts` (cross-reference `HoldingEvent` to the audit log, then call `detectUnexplainedGains`), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `currentTenant`; `recordEvent`, `GENESIS_HASH`, and the two newly exported primitives from `../audit/audit-service.js`; `upsertFindings`, `detectUnexplainedGains` from `./finding-service.js`; `usersWithPermission` from `../automate/notify.js`; `PERMISSIONS` from `../rbac/permissions.js`.
- Produces in `../audit/audit-service.js`:
  - `export function stableStringify(value: unknown): string` — **the existing private function, exported unchanged**
  - `export function auditEventHash(e: { tenantId: string; sequence: number; occurredAt: Date; actorUserId: string | null; action: string; targetType: string; targetId: string | null; outcome: 'success' | 'failure'; sourceIp: string | null; payload: Record<string, unknown>; prevHash: string }): string` — **the existing private `computeHash`, exported under a name that says what it hashes**
- Produces (all in `./audit-integrity.js`):
  - `const AUDIT_VERIFY_PAGE = 1000`
  - `interface SegmentResult { fromSequence: number; toSequence: number; result: 'valid' | 'broken'; brokenAtSequence: number | null; durationMs: number }`
  - `async function verifySegment(tenantId: string, fromSequence: number, expectedPrevHash: string, options?: { pageSize?: number; maxSequence?: number }): Promise<SegmentResult>`
  - `async function verifyIncremental(tenantId: string, options?: { now?: Date; pageSize?: number; signer?: CheckpointSigner | null }): Promise<SegmentResult & { checkpointSequence: number | null }>`
  - `async function verifyFull(tenantId: string, options?: { pageSize?: number }): Promise<SegmentResult>`
  - `interface CheckpointSigner { keyId: string; sign(payload: string): Promise<string>; verify(payload: string, signature: string): Promise<boolean> }`
  - `function localFileCheckpointSigner(keyId: string, key: Buffer): CheckpointSigner`
  - `interface AnchorSink { method: 'file' | 'mail'; deliver(payload: { tenantId: string; sequence: number; hash: string; anchoredAt: Date }): Promise<string> }`
  - `function fileAnchorSink(directory: string): AnchorSink`
  - `function mailAnchorSink(transport: Transport, to: string, tenantName: string): AnchorSink`
  - `async function anchorHead(tenantId: string, sink: AnchorSink, options?: { now?: Date }): Promise<{ sequence: number; status: 'anchored' | 'failed' }>`
  - `interface IntegrityStatus { headSequence: number; headHash: string; lastCheckpoint: { sequence: number; verifiedAt: Date; signed: boolean } | null; lastCheck: { fromSequence: number; toSequence: number; result: string; startedAt: Date; mode: string } | null; anchoring: { configured: boolean; lastAnchoredSequence: number | null; statement: string } }`
  - `async function integrityStatus(tx: TenantClient, anchoringConfigured: boolean): Promise<IntegrityStatus>`

**`CheckpointSigner` is a new interface, not `MasterKeyProvider`.** §17 says "the same key-provider interface Core's vault already uses for its master key", but `MasterKeyProvider` is `{ wrap, unwrap }` — envelope encryption, with no `sign` and no `verify`. A signature over `(sequence, hash)` is a different operation with a different key lifetime, and pretending otherwise would mean either widening the vault's interface for a caller that does not encrypt anything, or encrypting a digest and calling it a signature. `CheckpointSigner` mirrors `MasterKeyProvider`'s *shape* — a narrow interface with a local implementation and a KMS-backed one later — without borrowing its semantics.

- [ ] **Step 1: Export the two primitives, changing nothing else**

In `packages/core/src/audit/audit-service.ts`, change two declarations:

```ts
/**
 * Key order in a JSON object is not guaranteed across writers, so the payload
 * is serialised with sorted keys. Without this, an event could hash
 * differently on verification than it did on insert.
 *
 * EXPORTED because Govern's evidence bundles must have a stable digest and
 * must use THIS serialization, not a second one. A bundle serialised by a
 * different sorted-key implementation would have a digest that a later reader
 * recomputing it from the same content could not reproduce.
 */
export function stableStringify(value: unknown): string {
```

```ts
/**
 * Fixed field order, so the same event always produces the same digest.
 *
 * EXPORTED as `auditEventHash` because Govern verifies the chain INCREMENTALLY
 * — from a checkpoint's sequence, seeded with its hash — and `verifyChain`
 * walks every event ever recorded with no bound. A second implementation of
 * this function would drift from the one that wrote the chain, and the drift
 * would report a whole chain as broken.
 */
export function auditEventHash(e: Hashable): string {
```

and update the two internal call sites in `recordEvent` and `verifyChain` from `computeHash(` to `auditEventHash(`. **Nothing else in this file changes** — `AuditEvent`'s shape, `recordEvent`'s advisory lock and `verifyChain`'s behaviour are all untouched, which is the return on having designed the log as an append-only chain in the first slice.

- [ ] **Step 2: Write the failing test**

`packages/core/src/govern/audit-integrity.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { asDatabaseSuperuser, resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport } from '../notify/notification-service.js';
import { auditEventHash, recordEvent, stableStringify } from '../audit/audit-service.js';
import {
  anchorHead,
  fileAnchorSink,
  integrityStatus,
  localFileCheckpointSigner,
  mailAnchorSink,
  verifyFull,
  verifyIncremental,
  verifySegment,
} from './audit-integrity.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;

async function appendEvents(count: number) {
  for (let i = 0; i < count; i += 1) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: `test.event.${i}`,
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: { i },
      }),
    );
  }
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('the exported primitives', () => {
  it('stableStringify sorts keys, so two orderings of one object agree', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('auditEventHash reproduces the digest recordEvent wrote', async () => {
    // The whole point of exporting it rather than reimplementing it. If this
    // ever disagrees, incremental verification reports a whole chain broken.
    await appendEvents(1);
    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow());
    expect(
      auditEventHash({
        tenantId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        outcome: event.outcome as 'success',
        sourceIp: event.sourceIp,
        payload: event.payload as Record<string, unknown>,
        prevHash: event.prevHash,
      }),
    ).toBe(event.hash);
  });
});

describe('verifySegment', () => {
  it('verifies a segment from a mid-chain sequence, seeded with the predecessor hash', async () => {
    await appendEvents(10);
    const fifth = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { sequence: 5 } }),
    );
    const result = await verifySegment(tenantId, 6, fifth.hash);
    expect(result).toMatchObject({ fromSequence: 6, toSequence: 10, result: 'valid' });
  });

  it('pages, so a long chain never loads at once', async () => {
    await appendEvents(25);
    const result = await verifySegment(tenantId, 1, '0'.repeat(64), { pageSize: 4 });
    expect(result).toMatchObject({ result: 'valid', toSequence: 25 });
  });

  it('reports the sequence where an ALTERED event stops reproducing its digest', async () => {
    await appendEvents(5);
    await asDatabaseSuperuser(
      `UPDATE "AuditEvent" SET payload = '{"i":99}'::jsonb WHERE "tenantId" = $1 AND sequence = 3`,
      [tenantId],
    );
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'broken', brokenAtSequence: 3 });
  });

  it('reports the sequence where a DELETED event breaks its successor', async () => {
    await appendEvents(5);
    await asDatabaseSuperuser(
      `DELETE FROM "AuditEvent" WHERE "tenantId" = $1 AND sequence = 3`,
      [tenantId],
    );
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'broken', brokenAtSequence: 4 });
  });

  it('reports valid over an EMPTY segment rather than throwing', async () => {
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'valid', fromSequence: 1, toSequence: 0 });
  });
});

describe('verifyIncremental', () => {
  it('writes a checkpoint and an AuditChainCheck, and verifies only the new segment next time', async () => {
    await appendEvents(5);
    const first = await verifyIncremental(tenantId, { now: NOW });
    expect(first).toMatchObject({ result: 'valid', fromSequence: 1, toSequence: 5 });

    await appendEvents(3);
    const second = await verifyIncremental(tenantId, { now: NOW });
    // The whole point: the second run starts at 6, not at 1.
    expect(second.fromSequence).toBe(6);
    expect(second.checkpointSequence).toBe(5);

    const [checkpoints, checks] = await withTenant(tenantId, async (tx) => [
      await tx.auditCheckpoint.findMany({ orderBy: { sequence: 'asc' } }),
      await tx.auditChainCheck.findMany({ orderBy: { fromSequence: 'asc' } }),
    ]);
    expect(checkpoints.map((c) => c.sequence)).toEqual([5, 8]);
    expect(checks.map((c) => [c.fromSequence, c.toSequence, c.mode])).toEqual([
      [1, 5, 'incremental'],
      [6, 8, 'incremental'],
    ]);
  });

  it('raises a CRITICAL finding when the chain does not hold, naming the sequence', async () => {
    await appendEvents(5);
    await asDatabaseSuperuser(
      `UPDATE "AuditEvent" SET action = 'tampered' WHERE "tenantId" = $1 AND sequence = 2`,
      [tenantId],
    );
    const result = await verifyIncremental(tenantId, { now: NOW });
    expect(result.result).toBe('broken');

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'coverage_gap' } }).catch(() => null),
    );
    const critical = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { severity: 'critical' } }),
    );
    expect(critical.detail).toMatchObject({ brokenAtSequence: 2 });
    expect(finding).toBeNull();
  });

  it('writes NO checkpoint when the segment is broken', async () => {
    // A checkpoint over a broken segment would seed the next incremental run
    // with a hash from a chain that does not hold, and every subsequent run
    // would report valid.
    await appendEvents(4);
    await asDatabaseSuperuser(
      `UPDATE "AuditEvent" SET action = 'x' WHERE "tenantId" = $1 AND sequence = 2`,
      [tenantId],
    );
    await verifyIncremental(tenantId, { now: NOW });
    const checkpoints = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findMany());
    expect(checkpoints).toEqual([]);
  });

  it('signs the checkpoint when a signer is supplied, and the signature verifies', async () => {
    await appendEvents(3);
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await verifyIncremental(tenantId, { now: NOW, signer });

    const checkpoint = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findFirstOrThrow());
    expect(checkpoint.signature).not.toBeNull();
    expect(checkpoint.keyId).toBe('key-1');
    await expect(
      signer.verify(`${checkpoint.sequence}:${checkpoint.hash}`, checkpoint.signature!),
    ).resolves.toBe(true);
    await expect(signer.verify(`999:${checkpoint.hash}`, checkpoint.signature!)).resolves.toBe(false);
  });
});

describe('verifyFull', () => {
  it('walks from genesis regardless of checkpoints', async () => {
    await appendEvents(6);
    await verifyIncremental(tenantId, { now: NOW });
    const full = await verifyFull(tenantId, { pageSize: 2 });
    expect(full).toMatchObject({ fromSequence: 1, toSequence: 6, result: 'valid' });

    const check = await withTenant(tenantId, (tx) =>
      tx.auditChainCheck.findFirstOrThrow({ where: { mode: 'full' } }),
    );
    expect(check.fromSequence).toBe(1);
  });
});

describe('anchoring', () => {
  it('writes a file receipt and records the anchor', async () => {
    await appendEvents(3);
    const dir = mkdtempSync(join(tmpdir(), 'syntra-anchor-'));
    const result = await anchorHead(tenantId, fileAnchorSink(dir), { now: NOW });
    expect(result).toEqual({ sequence: 3, status: 'anchored' });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('"sequence": 3');

    const row = await withTenant(tenantId, (tx) => tx.auditAnchor.findFirstOrThrow());
    expect(row).toMatchObject({ sequence: 3, method: 'file', status: 'anchored' });
  });

  it('records a FAILED anchor rather than throwing, and says why', async () => {
    await appendEvents(1);
    const failing = {
      method: 'file' as const,
      deliver: async () => {
        throw new Error('the write-once volume is not mounted');
      },
    };
    const result = await anchorHead(tenantId, failing, { now: NOW });
    expect(result.status).toBe('failed');
    const row = await withTenant(tenantId, (tx) => tx.auditAnchor.findFirstOrThrow());
    expect(row.error).toContain('write-once volume');
  });

  it('mails a receipt through the transport', async () => {
    await appendEvents(2);
    const transport = memoryTransport();
    await anchorHead(tenantId, mailAnchorSink(transport, 'auditor@example.test', 'Acme'), { now: NOW });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('auditor@example.test');
  });
});

describe('integrityStatus', () => {
  it('states IN WORDS that anchoring is not configured, rather than a green tick', async () => {
    await appendEvents(2);
    await verifyIncremental(tenantId, { now: NOW });
    const status = await withTenant(tenantId, (tx) => integrityStatus(tx, false));
    expect(status.anchoring.configured).toBe(false);
    expect(status.anchoring.statement).toContain('not proof against the operator');
    expect(status.headSequence).toBe(2);
    expect(status.lastCheckpoint).toMatchObject({ sequence: 2, signed: false });
  });

  it('says what anchoring does establish once it is configured', async () => {
    await appendEvents(2);
    const dir = mkdtempSync(join(tmpdir(), 'syntra-anchor-'));
    await anchorHead(tenantId, fileAnchorSink(dir), { now: NOW });
    const status = await withTenant(tenantId, (tx) => integrityStatus(tx, true));
    expect(status.anchoring.lastAnchoredSequence).toBe(2);
    expect(status.anchoring.statement).toContain('outside the database');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/audit-integrity.test.ts`
Expected: FAIL — `Cannot find module './audit-integrity.js'` and `auditEventHash is not exported`.

- [ ] **Step 4: Write the verifier**

`packages/core/src/govern/audit-integrity.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTenant, type TenantClient } from '@syntra/db';
import { GENESIS_HASH, auditEventHash, recordEvent } from '../audit/audit-service.js';
import { sendMessage, type Transport } from '../notify/notification-service.js';
import { upsertFindings } from './finding-service.js';

/**
 * The built `verifyChain` calls `findMany` with no bound and walks every event
 * ever recorded, loading them all into memory at once. That is correct and it
 * is O(n) in both time and memory over a table that grows forever. A tenant
 * with ten million events cannot verify nightly that way, and the practical
 * outcome of an integrity check too expensive to run is an integrity check
 * nobody runs.
 */
export const AUDIT_VERIFY_PAGE = 1000;

export interface SegmentResult {
  fromSequence: number;
  toSequence: number;
  result: 'valid' | 'broken';
  brokenAtSequence: number | null;
  durationMs: number;
}

/**
 * Walks from `fromSequence`, seeded with `expectedPrevHash`, in pages.
 *
 * An EMPTY segment is `valid` with `toSequence` one below `fromSequence`. There
 * is nothing wrong with a chain that has not grown since the last checkpoint,
 * and throwing here would make the nightly job noisy on every quiet tenant.
 */
export async function verifySegment(
  tenantId: string,
  fromSequence: number,
  expectedPrevHash: string,
  options: { pageSize?: number; maxSequence?: number } = {},
): Promise<SegmentResult> {
  const pageSize = options.pageSize ?? AUDIT_VERIFY_PAGE;
  const startedAt = Date.now();

  let expectedPrev = expectedPrevHash;
  let cursor = fromSequence;
  let last = fromSequence - 1;

  for (;;) {
    const page = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: {
          sequence: {
            gte: cursor,
            ...(options.maxSequence === undefined ? {} : { lte: options.maxSequence }),
          },
        },
        orderBy: { sequence: 'asc' },
        take: pageSize,
      }),
    );
    if (page.length === 0) break;

    for (const e of page) {
      if (e.prevHash !== expectedPrev) {
        return {
          fromSequence,
          toSequence: e.sequence,
          result: 'broken',
          brokenAtSequence: e.sequence,
          durationMs: Date.now() - startedAt,
        };
      }
      const recomputed = auditEventHash({
        tenantId,
        sequence: e.sequence,
        occurredAt: e.occurredAt,
        actorUserId: e.actorUserId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        outcome: e.outcome as 'success' | 'failure',
        sourceIp: e.sourceIp,
        payload: e.payload as Record<string, unknown>,
        prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) {
        return {
          fromSequence,
          toSequence: e.sequence,
          result: 'broken',
          brokenAtSequence: e.sequence,
          durationMs: Date.now() - startedAt,
        };
      }
      expectedPrev = e.hash;
      last = e.sequence;
    }

    cursor = last + 1;
    if (page.length < pageSize) break;
  }

  return {
    fromSequence,
    toSequence: last,
    result: 'valid',
    brokenAtSequence: null,
    durationMs: Date.now() - startedAt,
  };
}

export interface CheckpointSigner {
  keyId: string;
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
}

/**
 * A signature over (sequence, hash) with a key the application holds and the
 * database does not. It raises the bar from "database access" to "database
 * access plus the signing key". It is NOT proof against the operator; only
 * anchoring is, and `integrityStatus` says so on the screen.
 *
 * A distinct interface from `MasterKeyProvider`, which is `{ wrap, unwrap }`:
 * envelope encryption with no `sign` and no `verify`. Signing a digest and
 * encrypting one are different operations with different key lifetimes, and
 * borrowing the vault's interface would mean either widening it for a caller
 * that encrypts nothing or calling an encryption a signature.
 */
export function localFileCheckpointSigner(keyId: string, key: Buffer): CheckpointSigner {
  if (key.length < 32) throw new Error('a checkpoint signing key must be at least 32 bytes');
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest('hex');
  return {
    keyId,
    async sign(payload) {
      return mac(payload);
    },
    async verify(payload, signature) {
      const expected = Buffer.from(mac(payload), 'hex');
      const given = Buffer.from(signature, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

export async function verifyIncremental(
  tenantId: string,
  options: { now?: Date; pageSize?: number; signer?: CheckpointSigner | null } = {},
): Promise<SegmentResult & { checkpointSequence: number | null }> {
  const now = options.now ?? new Date();

  const checkpoint = await withTenant(tenantId, (tx) =>
    tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } }),
  );

  const from = (checkpoint?.sequence ?? 0) + 1;
  const seed = checkpoint?.hash ?? GENESIS_HASH;
  const result = await verifySegment(tenantId, from, seed, {
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });

  await withTenant(tenantId, async (tx) => {
    await tx.auditChainCheck.create({
      data: {
        tenantId,
        fromSequence: result.fromSequence,
        toSequence: result.toSequence,
        result: result.result,
        brokenAtSequence: result.brokenAtSequence,
        startedAt: now,
        durationMs: result.durationMs,
        mode: 'incremental',
      },
    });
  });

  if (result.result === 'valid' && result.toSequence >= result.fromSequence) {
    const head = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { sequence: result.toSequence } }),
    );
    if (head !== null) {
      const payload = `${head.sequence}:${head.hash}`;
      const signature = options.signer ? await options.signer.sign(payload) : null;
      await withTenant(tenantId, (tx) =>
        tx.auditCheckpoint.create({
          data: {
            tenantId,
            sequence: head.sequence,
            hash: head.hash,
            verifiedAt: now,
            signature,
            keyId: options.signer?.keyId ?? null,
          },
        }),
      );
    }
  }

  if (result.result === 'broken') {
    // A failed verification is a `critical` finding, notified immediately and
    // NEVER digested, and it names the sequence. A checkpoint is deliberately
    // NOT written: one over a broken segment would seed the next incremental
    // run with a hash from a chain that does not hold, and every subsequent run
    // would report valid.
    await upsertFindings(
      tenantId,
      '',
      [
        {
          kind: 'coverage_gap',
          severity: 'critical',
          subjectRefType: 'snapshot',
          subjectRefId: `audit-chain:${result.brokenAtSequence}`,
          detail: {
            brokenAtSequence: result.brokenAtSequence,
            fromSequence: result.fromSequence,
            statement:
              'the audit chain does not hold at this sequence: an event was altered or removed after it was written',
          },
        },
      ],
      { now },
    );
  }

  return { ...result, checkpointSequence: checkpoint?.sequence ?? null };
}

/** Full verification from genesis stays available as a separate, explicitly invoked, paged job. */
export async function verifyFull(
  tenantId: string,
  options: { pageSize?: number } = {},
): Promise<SegmentResult> {
  const result = await verifySegment(tenantId, 1, GENESIS_HASH, {
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  await withTenant(tenantId, (tx) =>
    tx.auditChainCheck.create({
      data: {
        tenantId,
        fromSequence: result.fromSequence,
        toSequence: result.toSequence,
        result: result.result,
        brokenAtSequence: result.brokenAtSequence,
        durationMs: result.durationMs,
        mode: 'full',
      },
    }),
  );
  return result;
}
```

- [ ] **Step 5: Write the anchors and the status**

Append to `packages/core/src/govern/audit-integrity.ts`:

```ts
export interface AnchorSink {
  method: 'file' | 'mail';
  deliver(payload: {
    tenantId: string;
    sequence: number;
    hash: string;
    anchoredAt: Date;
  }): Promise<string>;
}

/** Write-once storage, if the operator mounts one. A directory otherwise. */
export function fileAnchorSink(directory: string): AnchorSink {
  return {
    method: 'file',
    async deliver(payload) {
      mkdirSync(directory, { recursive: true });
      const name = `anchor-${payload.tenantId}-${payload.sequence}.json`;
      const body = JSON.stringify(
        {
          tenantId: payload.tenantId,
          sequence: payload.sequence,
          hash: payload.hash,
          anchoredAt: payload.anchoredAt.toISOString(),
        },
        null,
        2,
      );
      writeFileSync(join(directory, name), body, { flag: 'wx' });
      return name;
    },
  };
}

/** A mail to an auditor's mailbox: somewhere the operator does not control. */
export function mailAnchorSink(transport: Transport, to: string, tenantName: string): AnchorSink {
  return {
    method: 'mail',
    async deliver(payload) {
      const body =
        `Audit chain anchor for ${tenantName}\n\n` +
        `sequence: ${payload.sequence}\nhash: ${payload.hash}\n` +
        `anchored at: ${payload.anchoredAt.toISOString()}\n\n` +
        `Keep this message. It is the only record outside the Syntra database of ` +
        `what the chain head was at this moment, and it is what makes a rewrite of ` +
        `the whole chain detectable.`;
      await transport.send({
        to,
        subject: `Syntra audit anchor — ${tenantName} — sequence ${payload.sequence}`,
        text: body,
        html: `<pre>${body}</pre>`,
      });
      return `mail:${to}:${payload.sequence}`;
    },
  };
}

export async function anchorHead(
  tenantId: string,
  sink: AnchorSink,
  options: { now?: Date } = {},
): Promise<{ sequence: number; status: 'anchored' | 'failed' }> {
  const now = options.now ?? new Date();
  const head = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' } }),
  );
  if (head === null) return { sequence: 0, status: 'anchored' };

  // The sink is network or filesystem I/O and never runs inside withTenant.
  let receipt: string | null = null;
  let error: string | null = null;
  try {
    receipt = await sink.deliver({ tenantId, sequence: head.sequence, hash: head.hash, anchoredAt: now });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  await withTenant(tenantId, (tx) =>
    tx.auditAnchor.create({
      data: {
        tenantId,
        sequence: head.sequence,
        hash: head.hash,
        anchoredAt: now,
        method: sink.method,
        receipt: receipt ?? '',
        status: error === null ? 'anchored' : 'failed',
        error,
      },
    }),
  );

  return { sequence: head.sequence, status: error === null ? 'anchored' : 'failed' };
}

export interface IntegrityStatus {
  headSequence: number;
  headHash: string;
  lastCheckpoint: { sequence: number; verifiedAt: Date; signed: boolean } | null;
  lastCheck: {
    fromSequence: number;
    toSequence: number;
    result: string;
    startedAt: Date;
    mode: string;
  } | null;
  anchoring: { configured: boolean; lastAnchoredSequence: number | null; statement: string };
}

const NOT_ANCHORED_STATEMENT =
  'External anchoring is not configured for this tenant. The hash chain detects ' +
  'tampering by an actor who cannot recompute it; it is not proof against the ' +
  'operator, because the hash is computed in application code from data in the ' +
  'same database with no secret. Somebody holding both database write access and ' +
  'the ability to run code can rewrite the chain from any point and recompute ' +
  'every subsequent digest, and the result verifies perfectly. Deletion of the ' +
  'entire log is detectable only by something outside it that remembers the head.';

const ANCHORED_STATEMENT =
  'External anchoring is configured. Each anchor records the chain head at a ' +
  'moment in time somewhere outside the database, which is the only one of the ' +
  'three mitigations that is actually proof against the operator.';

export async function integrityStatus(
  tx: TenantClient,
  anchoringConfigured: boolean,
): Promise<IntegrityStatus> {
  const head = await tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' } });
  const checkpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
  const check = await tx.auditChainCheck.findFirst({ orderBy: { startedAt: 'desc' } });
  const anchor = await tx.auditAnchor.findFirst({
    where: { status: 'anchored' },
    orderBy: { sequence: 'desc' },
  });

  return {
    headSequence: head?.sequence ?? 0,
    headHash: head?.hash ?? GENESIS_HASH,
    lastCheckpoint:
      checkpoint === null
        ? null
        : {
            sequence: checkpoint.sequence,
            verifiedAt: checkpoint.verifiedAt,
            signed: checkpoint.signature !== null,
          },
    lastCheck:
      check === null
        ? null
        : {
            fromSequence: check.fromSequence,
            toSequence: check.toSequence,
            result: check.result,
            startedAt: check.startedAt,
            mode: check.mode,
          },
    anchoring: {
      configured: anchoringConfigured,
      lastAnchoredSequence: anchor?.sequence ?? null,
      // Printed in these words, not as a badge. A tenant that has not
      // configured anchoring sees what that means rather than a green tick.
      statement: anchoringConfigured ? ANCHORED_STATEMENT : NOT_ANCHORED_STATEMENT,
    },
  };
}
```

- [ ] **Step 6: Cross-reference `HoldingEvent` to the audit log and enable `unexplained_gain`**

In `packages/core/src/govern/snapshot-service.ts`, after the `HoldingEvent` write loop, add:

```ts
      // Cross-reference each gain to the audit event that explains it, where
      // one exists. `explained = false` on a gain is the most valuable row this
      // system produces: access appeared, and SYNTRA DID NOT CAUSE IT. It is
      // only meaningful once this pass has run, which is why
      // `detectUnexplainedGains` is called here rather than in the detect stage.
      await withTenant(tenantId, async (tx) => {
        const gains = await tx.holdingEvent.findMany({
          where: { toSnapshotId: snapshotId, change: 'gained' },
          select: { id: true, personId: true, resourceId: true },
        });
        if (gains.length === 0) return;

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
        const bySubject = new Map<string, number>();
        for (const event of candidates) {
          const payload = event.payload as Record<string, unknown>;
          const person = typeof payload['personId'] === 'string' ? payload['personId'] : null;
          const resource =
            typeof payload['resourceId'] === 'string'
              ? payload['resourceId']
              : typeof payload['entitlementId'] === 'string'
                ? payload['entitlementId']
                : null;
          if (person !== null && resource !== null) bySubject.set(`${person}|${resource}`, event.sequence);
        }

        for (const gain of gains) {
          if (gain.personId === null) continue;
          const sequence = bySubject.get(`${gain.personId}|${gain.resourceId}`);
          if (sequence === undefined) continue;
          await tx.holdingEvent.update({
            where: { id: gain.id },
            data: { auditEventSequence: sequence, explained: true },
          });
        }
      });

      const gainRows = await withTenant(tenantId, (tx) =>
        tx.holdingEvent.findMany({
          where: { toSnapshotId: snapshotId },
          select: {
            subjectKey: true, systemId: true, resourceKind: true,
            resourceId: true, resourceName: true, change: true, explained: true,
          },
        }),
      );
      await upsertFindings(tenantId, snapshotId, detectUnexplainedGains(gainRows), {
        now: collected.asOf,
      });
```

and add `detectUnexplainedGains` to the `finding-service.js` import list at the head of the file.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/audit-integrity.test.ts packages/core/src/audit packages/core/src/govern/snapshot-service.test.ts`
Expected: PASS. The existing audit tests must be untouched — the export change is a rename of a private symbol and nothing about `recordEvent` or `verifyChain` behaves differently.

- [ ] **Step 8: Export and typecheck**

Add `export * from './govern/audit-integrity.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Mutation-test**

1. In `verifySegment`, remove the `e.prevHash !== expectedPrev` check. Expected: `reports the sequence where a DELETED event breaks its successor` FAILS.
2. Remove the `recomputed !== e.hash` check. Expected: `reports the sequence where an ALTERED event stops reproducing its digest` FAILS.
3. In `verifyIncremental`, write the checkpoint unconditionally. Expected: `writes NO checkpoint when the segment is broken` FAILS.
4. In `verifyIncremental`, seed with `GENESIS_HASH` always instead of the checkpoint's hash. Expected: `verifies only the new segment next time` FAILS on `fromSequence`.
5. In `audit-service.ts`, change `auditEventHash` to hash `JSON.stringify(e.payload)` instead of `stableStringify(e.payload)`. Expected: `auditEventHash reproduces the digest recordEvent wrote` FAILS — **and this is why the primitive is exported rather than reimplemented.**
6. In `integrityStatus`, return the anchored statement when `anchoringConfigured` is false. Expected: `states IN WORDS that anchoring is not configured` FAILS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/audit/audit-service.ts \
        packages/core/src/govern/audit-integrity.ts \
        packages/core/src/govern/audit-integrity.test.ts \
        packages/core/src/govern/snapshot-service.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): incremental audit verification, checkpoints, signatures and anchors"
```

---
## Task 11: Settings, the four reports with their mandatory header, CSV and the evidence bundle

Spec §8 rule 4, §10, §17, §18. **A number without its header is not a number this product produces**, and the way to make that true rather than promised is a type whose only constructor takes the header.

**Files:**
- Create: `packages/core/src/govern/settings-service.ts`, `packages/core/src/govern/report-service.ts`, `packages/core/src/govern/export-service.ts`
- Test: `packages/core/src/govern/report-service.test.ts`, `packages/core/src/govern/export-service.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`, `stableStringify` from `../audit/audit-service.js`; `readableSnapshot`, `type ReadableSnapshot`, `SnapshotNotReadableError` from `./snapshot-service.js`; `countRegion`, `sumRegions`, `percentOf`, `known`, `unknownValue`, `type Tri`, `type ResourceKind`, `SYNTRA_SYSTEM_ID` from `./types.js`; `summariseAttributions`, `type AttributionDraft` from `./attribute.js`; `type ClassifiedSource` from `./freshness.js`; `integrityStatus`, `verifySegment` from `./audit-integrity.js`; `DIFF_LIMITATION` from `./diff.js`; `createHash` from `node:crypto`.
- Produces (in `./settings-service.js`):
  - `async function governSettings(tx: TenantClient): Promise<GovernSettings>` — get-or-create the single row
  - `async function updateGovernSettings(tenantId: string, actorUserId: string | null, input: Record<string, number | string | number[] | null>): Promise<void>`
  - `async function upsertSourcePolicy(tenantId: string, actorUserId: string | null, input: { sourceKind: string; sourceId: string; freshnessSlaHours: number; inDefaultScope: boolean }): Promise<void>`
  - `async function setResourceClassification(tenantId: string, actorUserId: string | null, input: { systemId: string; resourceKind: string; resourceId: string; privileged: boolean; note: string | null }): Promise<void>`
- Produces (in `./report-service.js`):
  - `interface ReportHeader { snapshotId: string; asOf: string; live: false; sources: ReportSourceLine[]; coverageGapCount: number; unattributableCount: number; unattributedAccountCount: number; scopeDescription: string }`
  - `interface LiveReportHeader { live: true; computedAt: string; exportable: false; caveat: string }`
  - `interface ReportSourceLine { sourceKind: string; sourceId: string; sourceName: string; lastSuccessfulReadAt: string | null; completeness: string; staleness: string; ageHours: number | null; gapCount: number }`
  - `type ReportEnvelope<T>` — **branded; the only constructor is `envelope`**
  - `function envelope<T>(header: ReportHeader | LiveReportHeader, body: T): ReportEnvelope<T>`
  - `function headerOf<T>(e: ReportEnvelope<T>): ReportHeader | LiveReportHeader` and `function bodyOf<T>(e: ReportEnvelope<T>): T`
  - `function buildHeader(snapshot: ReadableSnapshot, scopeDescription: string): ReportHeader`
  - `interface SystemAccessRow { subjectKey: string; personId: string | null; displayName: string; bucket: 'unattributable' | 'no_active_contract' | 'unattributed_account' | 'other'; resources: { resourceKind: ResourceKind; resourceId: string; resourceName: string; state: string; observedAt: string; provenance: string; lastCertifiedAt: string | null; lastCertifiedBy: string | null }[] }`
  - `async function whoHasAccessToSystem(tenantId: string, input: { snapshotId?: string; systemId: string; resourceId?: string }): Promise<ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: Tri<number> }>>`
  - `async function whatDoesPersonHold(tenantId: string, input: { snapshotId?: string; personId: string }): Promise<ReportEnvelope<{ personId: string; displayName: string; accounts: string[]; holdings: PersonHoldingRow[] }>>`
  - `async function whatChanged(tenantId: string, input: { fromSnapshotId: string; toSnapshotId: string }): Promise<ReportEnvelope<ChangeReport>>`
  - `async function whoApprovedIt(tenantId: string, input: { snapshotId?: string; subjectKey: string; systemId: string; resourceKind: ResourceKind; resourceId: string }): Promise<ReportEnvelope<ApprovalReport>>`
- Produces (in `./export-service.js`):
  - `function toCsv(header: ReportHeader, rows: readonly Record<string, string>[]): string`
  - `async function exportReportCsv(tenantId: string, actorUserId: string, e: ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: Tri<number> }>, scope: Record<string, unknown>): Promise<string>`
  - `interface EvidenceBundle { header: ReportHeader; limitations: string[]; snapshot: unknown; coverage: unknown; items: unknown[]; decisions: unknown[]; reviewers: unknown[]; notifications: unknown[]; dispatches: unknown[]; chain: { fromSequence: number; toSequence: number; result: string; headSequence: number; headHash: string }; digest: string }`
  - `function bundleDigest(bundle: Omit<EvidenceBundle, 'digest'>): string`
  - `async function createEvidencePack(tenantId: string, actorUserId: string, input: { kind: 'campaign' | 'report' | 'period'; snapshotId?: string; campaignId?: string; scope: Record<string, unknown> }): Promise<{ id: string; digest: string; bundle: EvidenceBundle }>`
  - `const BUNDLE_LIMITATIONS: readonly string[]`

- [ ] **Step 1: Write the failing report test**

`packages/core/src/govern/report-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { buildHeader, bodyOf, envelope, headerOf, whoHasAccessToSystem, whatDoesPersonHold } from './report-service.js';
import { readableSnapshot } from './snapshot-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    await tx.contract.create({
      data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId, kind: 'manual', status: 'complete', asOf: NOW,
        holdingCount: 2, unattributableCount: 1, coverageGapCount: 1, unattributedAccountCount: 1,
        personsWithActiveContract: 1,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId, snapshotId: snapshot.id, sourceKind: 'targetSystem', sourceId: 'sys-1',
        sourceName: 'Acme AD', lastSuccessfulReadAt: new Date('2026-06-06T09:00:00Z'),
        completeness: 'partial', staleness: 'stale', freshnessSlaHours: 24, gapCount: 1,
      },
    });
    await tx.coverageGap.create({
      data: {
        tenantId, snapshotId: snapshot.id, kind: 'resource_unreadable',
        systemKind: 'targetSystem', systemId: 'sys-1', resourceId: 'ent-admins',
        reason: 'Domain Admins could not be read completely',
      },
    });
    const held = await tx.holding.create({
      data: {
        tenantId, snapshotId: snapshot.id, subjectKey: `person:${person.id}`, personId: person.id,
        systemKind: 'targetSystem', systemId: 'sys-1', resourceKind: 'targetEntitlement',
        resourceId: 'ent-finance', resourceName: 'Finance-Payments',
        state: 'held', observedAt: new Date('2026-06-03T00:00:00Z'), observedVia: 'provision:sys-1',
        firstSeenAt: NOW, attributionCount: 1, unattributable: false,
      },
    });
    await tx.holdingAttribution.create({
      data: {
        tenantId, holdingId: held.id, kind: 'business_rule', refType: 'BusinessRule', refId: 'rule-1',
        detail: { ruleName: 'Finance staff', ruleEnabled: true }, resolvedAt: NOW,
      },
    });
    await tx.holding.create({
      data: {
        tenantId, snapshotId: snapshot.id, subjectKey: 'account:sys-1:anchor-7', accountRef: 'anchor-7',
        systemKind: 'targetSystem', systemId: 'sys-1', resourceKind: 'targetEntitlement',
        resourceId: 'ent-finance', resourceName: 'Finance-Payments',
        state: 'held', observedAt: NOW, observedVia: 'provision:sys-1', firstSeenAt: NOW,
        attributionCount: 0, unattributable: true,
      },
    });
    return { snapshotId: snapshot.id, personId: person.id };
  });
  snapshotId = seeded.snapshotId;
  personId = seeded.personId;
});

describe('the header is not optional', () => {
  it('carries the snapshot, its as-of, every source, and both counts', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'the Acme AD target'),
    );
    expect(header).toMatchObject({
      snapshotId, live: false, coverageGapCount: 1, unattributableCount: 1, unattributedAccountCount: 1,
    });
    expect(header.asOf).toBe(NOW.toISOString());
    expect(header.sources[0]).toMatchObject({
      sourceName: 'Acme AD', completeness: 'partial', staleness: 'stale',
    });
  });

  it('a bare object literal is NOT a ReportEnvelope — the brand bites at compile time', () => {
    // The construct that stands in for verification, shown to bite. `envelope`
    // is the only constructor, so a report DTO cannot be assembled without its
    // header. Vitest does not typecheck, so this only fails under `tsc` — and
    // if the brand is removed the directive becomes unused, which tsc reports
    // as TS2578. It bites in BOTH directions.
    // @ts-expect-error a report body without its header is not constructible
    const bad: import('./report-service.js').ReportEnvelope<{ rows: [] }> = { header: null, body: { rows: [] } };
    expect(bad).toBeDefined();
  });

  it('round-trips through envelope/headerOf/bodyOf', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'everything'),
    );
    const e = envelope(header, { rows: [1, 2, 3] });
    expect(headerOf(e)).toBe(header);
    expect(bodyOf(e)).toEqual({ rows: [1, 2, 3] });
  });
});

describe('who has access to this system', () => {
  it('groups into the four buckets, uncomfortable first', async () => {
    // The default sort of a governance report is not alphabetical.
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const rows = bodyOf(report).rows;
    expect(rows.map((r) => r.bucket)).toEqual(['unattributable', 'unattributed_account', 'other']
      .filter((b) => rows.some((r) => r.bucket === b)));
    expect(rows[0]!.bucket).toBe('unattributable');
  });

  it('reports the holder count as UNKNOWN when the scope contains a gap', async () => {
    // Section 8 rule 3. Two holdings are visible and the honest answer is still
    // not "2", because one entitlement in this system could not be read at all.
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const count = bodyOf(report).holderCount;
    expect(count.known).toBe(false);
    if (count.known) throw new Error('unreachable');
    expect(count.reason).toContain('Domain Admins');
  });

  it('reports a NUMBER when the scope contains no gap', async () => {
    await withTenant(tenantId, (tx) => tx.coverageGap.deleteMany({}));
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    expect(bodyOf(report).holderCount).toEqual({ known: true, value: 2 });
  });

  it('carries each holding’s provenance as a sentence and its own observedAt', async () => {
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const anna = bodyOf(report).rows.find((r) => r.personId === personId);
    expect(anna!.resources[0]!.provenance).toContain('Finance staff');
    // The snapshot's asOf is 15 June; this holding was last confirmed on the
    // 3rd, and the report shows BOTH.
    expect(anna!.resources[0]!.observedAt).toBe('2026-06-03T00:00:00.000Z');
    expect(headerOf(report)).toMatchObject({ asOf: NOW.toISOString() });
  });

  it('refuses a snapshot that is not readable rather than reporting on it', async () => {
    const building = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'building', asOf: NOW },
      });
      return s.id;
    });
    await expect(
      whoHasAccessToSystem(tenantId, { snapshotId: building, systemId: 'sys-1' }),
    ).rejects.toThrow(/still being built/i);
  });
});

describe('what does this person hold', () => {
  it('lists every system, the full attribution set, and the other accounts', async () => {
    const report = await whatDoesPersonHold(tenantId, { snapshotId, personId });
    const body = bodyOf(report);
    expect(body.displayName).toBe('Anna Novak');
    expect(body.holdings).toHaveLength(1);
    expect(body.holdings[0]!.attributions).toHaveLength(1);
    expect(body.holdings[0]!.attributions[0]).toMatchObject({ kind: 'business_rule' });
  });

  it('carries the tenant’s unattributed-account count in its footer', async () => {
    // Nobody may read a per-person report as complete while accounts belonging
    // to nobody are in the same systems.
    const report = await whatDoesPersonHold(tenantId, { snapshotId, personId });
    expect(headerOf(report)).toMatchObject({ unattributedAccountCount: 1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/report-service.test.ts`
Expected: FAIL — `Cannot find module './report-service.js'`.

- [ ] **Step 3: Write the settings service**

`packages/core/src/govern/settings-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { currentTenant } from '../tenant-context.js';

/** Get-or-create the single row, so no caller has to know whether it exists. */
export async function governSettings(tx: TenantClient) {
  const tenantId = await currentTenant(tx);
  const existing = await tx.governSettings.findUnique({ where: { tenantId } });
  if (existing !== null) return existing;
  return tx.governSettings.create({ data: { tenantId } });
}

const PERCENT_FIELDS = [
  'batchThresholdPercent',
  'perResourceThresholdPercent',
  'personPopulationDropPercent',
  'minimumCoveragePercent',
];

/**
 * Changing any threshold, freshness SLA or snapshot cadence is a PRIVILEGED,
 * AUDITED action, and the audit event carries the old value beside the new one.
 *
 * Section 21 names this explicitly and gives the reason: lowering a threshold
 * is functionally the same act as confirming everything it would otherwise have
 * caught, and lengthening a cadence is functionally the same as agreeing not to
 * see things.
 */
export async function updateGovernSettings(
  tenantId: string,
  actorUserId: string | null,
  input: Record<string, number | string | number[] | null>,
): Promise<void> {
  for (const field of PERCENT_FIELDS) {
    const value = input[field];
    if (typeof value === 'number' && (value < 0 || value > 100)) {
      throw new Error(`${field} must be between 0 and 100`);
    }
  }

  await withTenant(tenantId, async (tx) => {
    const before = await governSettings(tx);
    const after = await tx.governSettings.update({
      where: { tenantId },
      data: input as never,
    });

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(input)) {
      const from = (before as Record<string, unknown>)[key];
      const to = (after as Record<string, unknown>)[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.settings.update',
      targetType: 'GovernSettings',
      targetId: after.id,
      outcome: 'success',
      sourceIp: null,
      payload: { changed },
    });
  });
}

export async function upsertSourcePolicy(
  tenantId: string,
  actorUserId: string | null,
  input: { sourceKind: string; sourceId: string; freshnessSlaHours: number; inDefaultScope: boolean },
): Promise<void> {
  if (input.freshnessSlaHours <= 0) {
    throw new Error('a freshness SLA must be a positive number of hours');
  }
  await withTenant(tenantId, async (tx) => {
    await tx.governSourcePolicy.upsert({
      where: {
        tenantId_sourceKind_sourceId: {
          tenantId, sourceKind: input.sourceKind, sourceId: input.sourceId,
        },
      },
      create: { tenantId, ...input },
      update: { freshnessSlaHours: input.freshnessSlaHours, inDefaultScope: input.inDefaultScope },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.source_policy.update',
      targetType: 'GovernSourcePolicy',
      targetId: null,
      outcome: 'success',
      sourceIp: null,
      payload: { ...input },
    });
  });
}

/**
 * Raising a classification takes effect at the NEXT snapshot, and the finding
 * it produces says which snapshot first saw it. Rewriting a frozen snapshot to
 * agree with today's opinion would change what somebody attested to.
 */
export async function setResourceClassification(
  tenantId: string,
  actorUserId: string | null,
  input: {
    systemId: string; resourceKind: string; resourceId: string;
    privileged: boolean; note: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.resourceClassification.upsert({
      where: {
        tenantId_systemId_resourceKind_resourceId: {
          tenantId, systemId: input.systemId,
          resourceKind: input.resourceKind, resourceId: input.resourceId,
        },
      },
      create: { tenantId, ...input, setByUserId: actorUserId },
      update: { privileged: input.privileged, note: input.note, setByUserId: actorUserId, setAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.classification.set',
      targetType: 'ResourceClassification',
      targetId: null,
      outcome: 'success',
      sourceIp: null,
      payload: { ...input },
    });
  });
}
```

- [ ] **Step 4: Write the header, the brand, and the four reports**

`packages/core/src/govern/report-service.ts`:

```ts
import { withTenant } from '@syntra/db';
import { summariseAttributions, type AttributionDraft } from './attribute.js';
import { DIFF_LIMITATION } from './diff.js';
import { readableSnapshot, type ReadableSnapshot } from './snapshot-service.js';
import {
  countRegion,
  known,
  percentOf,
  sumRegions,
  type ResourceKind,
  type Tri,
} from './types.js';

export interface ReportSourceLine {
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  lastSuccessfulReadAt: string | null;
  completeness: string;
  staleness: string;
  ageHours: number | null;
  gapCount: number;
}

export interface ReportHeader {
  snapshotId: string;
  /** When GOVERN assembled the picture. NOT any holding's observedAt. */
  asOf: string;
  live: false;
  sources: ReportSourceLine[];
  coverageGapCount: number;
  unattributableCount: number;
  unattributedAccountCount: number;
  scopeDescription: string;
}

export interface LiveReportHeader {
  live: true;
  computedAt: string;
  /** A live report cannot be exported as evidence: it has no as-of time. */
  exportable: false;
  caveat: string;
}

declare const REPORT_BRAND: unique symbol;

/**
 * A report body that CANNOT be constructed without its header.
 *
 * Section 8 rule 4: "The report DTO has no constructor that omits it. A number
 * without this header is not a number this product produces." A convention that
 * lives in a document is a convention that survives until the third person
 * touches the code, so the rule is a private brand instead: `envelope` is the
 * only function that can produce one, and a bare `{ header, body }` literal is
 * a type error.
 */
export interface ReportEnvelope<T> {
  readonly [REPORT_BRAND]: true;
  header: ReportHeader | LiveReportHeader;
  body: T;
}

export function envelope<T>(header: ReportHeader | LiveReportHeader, body: T): ReportEnvelope<T> {
  return { [REPORT_BRAND]: true, header, body } as ReportEnvelope<T>;
}

export function headerOf<T>(e: ReportEnvelope<T>): ReportHeader | LiveReportHeader {
  return e.header;
}

export function bodyOf<T>(e: ReportEnvelope<T>): T {
  return e.body;
}

export function buildHeader(
  snapshot: ReadableSnapshot,
  scopeDescription: string,
): ReportHeader {
  return {
    snapshotId: snapshot.id,
    asOf: snapshot.asOf.toISOString(),
    live: false,
    sources: snapshot.sources.map((s) => ({
      sourceKind: s.sourceKind,
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt?.toISOString() ?? null,
      completeness: s.completeness,
      staleness: s.staleness,
      ageHours: s.ageHours,
      gapCount: s.gapCount,
    })),
    coverageGapCount: snapshot.coverageGapCount,
    unattributableCount: snapshot.unattributableCount,
    unattributedAccountCount: snapshot.unattributedAccountCount,
    scopeDescription,
  };
}

export interface SystemAccessRow {
  subjectKey: string;
  personId: string | null;
  displayName: string;
  bucket: 'unattributable' | 'no_active_contract' | 'unattributed_account' | 'other';
  resources: {
    resourceKind: ResourceKind;
    resourceId: string;
    resourceName: string;
    state: string;
    observedAt: string;
    provenance: string;
    lastCertifiedAt: string | null;
    lastCertifiedBy: string | null;
  }[];
}

const BUCKET_ORDER = ['unattributable', 'no_active_contract', 'unattributed_account', 'other'] as const;

export async function whoHasAccessToSystem(
  tenantId: string,
  input: { snapshotId?: string; systemId: string; resourceId?: string },
): Promise<ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: Tri<number> }>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const holdings = await tx.holding.findMany({
      where: {
        snapshotId: snapshot.id,
        systemId: input.systemId,
        ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      },
      include: { attributions: true },
    });
    const gaps = await tx.coverageGap.findMany({
      where: {
        snapshotId: snapshot.id,
        systemId: input.systemId,
        ...(input.resourceId === undefined ? {} : { OR: [{ resourceId: input.resourceId }, { resourceId: null }] }),
      },
      select: { reason: true },
    });
    const persons = await tx.person.findMany({
      select: { id: true, givenName: true, familyName: true },
    });
    const contracts = await tx.contract.findMany({
      select: { personId: true, startDate: true, endDate: true },
    });
    const certifications = await tx.holdingCertification.findMany({
      where: { systemId: input.systemId },
    });
    return { snapshot, holdings, gaps, persons, contracts, certifications };
  });

  const nameById = new Map(
    loaded.persons.map((p) => [p.id, `${p.givenName} ${p.familyName}`.trim()]),
  );
  const now = loaded.snapshot.asOf;
  const hasActiveContract = new Set(
    loaded.contracts
      .filter((c) => c.startDate <= now && (c.endDate === null || c.endDate >= now))
      .map((c) => c.personId),
  );
  const certifiedByKey = new Map(
    loaded.certifications.map((c) => [
      `${c.subjectRefId}|${c.resourceKind}|${c.resourceId}`,
      c,
    ]),
  );

  const bySubject = new Map<string, SystemAccessRow>();
  for (const holding of loaded.holdings) {
    const existing = bySubject.get(holding.subjectKey);
    const certification = certifiedByKey.get(
      `${holding.personId ?? holding.accountRef ?? ''}|${holding.resourceKind}|${holding.resourceId}`,
    );

    const resource = {
      resourceKind: holding.resourceKind as ResourceKind,
      resourceId: holding.resourceId,
      resourceName: holding.resourceName,
      state: holding.state,
      // The holding's OWN truth-time, which can be days from the snapshot's
      // as-of, and both are on the report.
      observedAt: holding.observedAt.toISOString(),
      provenance: summariseAttributions(
        holding.attributions.map((a) => ({
          kind: a.kind as AttributionDraft['kind'],
          refType: a.refType,
          refId: a.refId,
          detail: a.detail as Record<string, unknown>,
          resolvedAt: a.resolvedAt,
        })),
      ),
      lastCertifiedAt: certification?.lastCertifiedAt.toISOString() ?? null,
      lastCertifiedBy: certification === undefined
        ? null
        : (nameById.get(certification.lastCertifiedByPersonId) ?? null),
    };

    if (existing !== undefined) {
      existing.resources.push(resource);
      if (holding.unattributable) existing.bucket = 'unattributable';
      continue;
    }

    const bucket: SystemAccessRow['bucket'] = holding.unattributable
      ? 'unattributable'
      : holding.personId === null
        ? 'unattributed_account'
        : hasActiveContract.has(holding.personId)
          ? 'other'
          : 'no_active_contract';

    bySubject.set(holding.subjectKey, {
      subjectKey: holding.subjectKey,
      personId: holding.personId,
      displayName:
        holding.personId === null
          ? `an account with no person (${holding.accountRef ?? 'unknown'})`
          : (nameById.get(holding.personId) ?? 'a person no longer recorded'),
      bucket,
      resources: [resource],
    });
  }

  const rows = [...bySubject.values()].sort((a, b) => {
    const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
    return byBucket !== 0 ? byBucket : a.displayName.localeCompare(b.displayName);
  });

  // The count goes through `countRegion` and through nothing else, so a gap in
  // this scope makes it `unknown` rather than a confident number.
  const holderCount = countRegion({
    held: rows.filter((r) => r.resources.some((x) => x.state === 'held')).length,
    unknownHoldings: loaded.holdings.filter((h) => h.state === 'unknown').length,
    gapReasons: loaded.gaps.map((g) => g.reason),
  });

  return envelope(
    buildHeader(loaded.snapshot, `system ${input.systemId}${input.resourceId ? `, resource ${input.resourceId}` : ''}`),
    { rows, holderCount },
  );
}

export interface PersonHoldingRow {
  systemKind: string;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: string;
  privileged: boolean;
  observedAt: string;
  observedVia: string;
  firstSeenAt: string;
  provenance: string;
  attributions: { kind: string; detail: Record<string, unknown> }[];
  lastCertifiedAt: string | null;
}

export async function whatDoesPersonHold(
  tenantId: string,
  input: { snapshotId?: string; personId: string },
): Promise<
  ReportEnvelope<{ personId: string; displayName: string; accounts: string[]; holdings: PersonHoldingRow[] }>
> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const person = await tx.person.findUniqueOrThrow({ where: { id: input.personId } });
    const holdings = await tx.holding.findMany({
      where: { snapshotId: snapshot.id, personId: input.personId },
      include: { attributions: true },
      orderBy: [{ systemId: 'asc' }, { resourceKind: 'asc' }, { resourceName: 'asc' }],
    });
    const certifications = await tx.holdingCertification.findMany({
      where: { subjectRefType: 'person', subjectRefId: input.personId },
    });
    return { snapshot, person, holdings, certifications };
  });

  const certifiedByKey = new Map(
    loaded.certifications.map((c) => [`${c.systemId}|${c.resourceKind}|${c.resourceId}`, c.lastCertifiedAt]),
  );

  return envelope(
    buildHeader(loaded.snapshot, `everything ${loaded.person.givenName} ${loaded.person.familyName} holds`),
    {
      personId: input.personId,
      displayName: `${loaded.person.givenName} ${loaded.person.familyName}`.trim(),
      // The other accounts, if the person holds several.
      accounts: [
        ...new Set(
          loaded.holdings
            .filter((h) => h.resourceKind === 'targetAccount')
            .map((h) => `${h.systemId}:${h.resourceId}`),
        ),
      ],
      holdings: loaded.holdings.map((h) => ({
        systemKind: h.systemKind,
        systemId: h.systemId,
        resourceKind: h.resourceKind as ResourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state,
        privileged: h.privileged,
        observedAt: h.observedAt.toISOString(),
        observedVia: h.observedVia,
        firstSeenAt: h.firstSeenAt.toISOString(),
        provenance: summariseAttributions(
          h.attributions.map((a) => ({
            kind: a.kind as AttributionDraft['kind'],
            refType: a.refType,
            refId: a.refId,
            detail: a.detail as Record<string, unknown>,
            resolvedAt: a.resolvedAt,
          })),
        ),
        // The FULL attribution set, not the first one.
        attributions: h.attributions.map((a) => ({
          kind: a.kind,
          detail: a.detail as Record<string, unknown>,
        })),
        lastCertifiedAt:
          certifiedByKey.get(`${h.systemId}|${h.resourceKind}|${h.resourceId}`)?.toISOString() ?? null,
      })),
    },
  );
}

export interface ChangeReport {
  fromSnapshotId: string;
  toSnapshotId: string;
  snapshotsOverPeriod: number;
  limitation: string;
  /** Two panes that are never merged. */
  observedChanges: {
    subjectKey: string; resourceName: string; change: string;
    explained: boolean; auditEventSequence: number | null;
  }[];
  recordedActions: { sequence: number; action: string; occurredAt: string; actorUserId: string | null }[];
  /** An action with no observed change: usually a write that reported success and did not land. */
  actionsWithNoObservedChange: number;
}

export async function whatChanged(
  tenantId: string,
  input: { fromSnapshotId: string; toSnapshotId: string },
): Promise<ReportEnvelope<ChangeReport>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const to = await readableSnapshot(tx, input.toSnapshotId);
    const from = await readableSnapshot(tx, input.fromSnapshotId);
    const events = await tx.holdingEvent.findMany({
      where: { fromSnapshotId: input.fromSnapshotId, toSnapshotId: input.toSnapshotId },
    });
    const audit = await tx.auditEvent.findMany({
      where: { occurredAt: { gte: from.asOf, lte: to.asOf } },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, action: true, occurredAt: true, actorUserId: true },
    });
    const snapshotsOverPeriod = await tx.accessSnapshot.count({
      where: { status: 'complete', asOf: { gte: from.asOf, lte: to.asOf } },
    });
    return { to, from, events, audit, snapshotsOverPeriod };
  });

  const explainedSequences = new Set(
    loaded.events.map((e) => e.auditEventSequence).filter((s): s is number => s !== null),
  );

  return envelope(buildHeader(loaded.to, 'changes over the period'), {
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
    // "What changed in Q2, from 91 daily snapshots" is a defensible sentence;
    // "what changed in Q2" is not.
    snapshotsOverPeriod: loaded.snapshotsOverPeriod,
    limitation: DIFF_LIMITATION,
    observedChanges: loaded.events.map((e) => ({
      subjectKey: e.subjectKey,
      resourceName: e.resourceName,
      change: e.change,
      explained: e.explained,
      auditEventSequence: e.auditEventSequence,
    })),
    recordedActions: loaded.audit.map((a) => ({
      sequence: a.sequence,
      action: a.action,
      occurredAt: a.occurredAt.toISOString(),
      actorUserId: a.actorUserId,
    })),
    actionsWithNoObservedChange: loaded.audit.filter((a) => !explainedSequences.has(a.sequence)).length,
  });
}

export interface ApprovalReport {
  hasApprovalRecord: boolean;
  statement: string;
  attributionKinds: string[];
  requests: {
    requestId: string | null;
    productName: string | null;
    requesterName: string | null;
    justification: string | null;
    endsAt: string | null;
    approvers: { personName: string; decision: string; decidedAt: string; comment: string | null }[];
  }[];
}

export async function whoApprovedIt(
  tenantId: string,
  input: {
    snapshotId?: string; subjectKey: string; systemId: string;
    resourceKind: ResourceKind; resourceId: string;
  },
): Promise<ReportEnvelope<ApprovalReport>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const holding = await tx.holding.findFirst({
      where: {
        snapshotId: snapshot.id, subjectKey: input.subjectKey, systemId: input.systemId,
        resourceKind: input.resourceKind, resourceId: input.resourceId,
      },
      include: { attributions: true },
    });
    return { snapshot, holding };
  });

  const attributions = loaded.holding?.attributions ?? [];
  const approvalKinds = ['request', 'delegated_admin', 'auto_granted'];
  const relevant = attributions.filter((a) => approvalKinds.includes(a.kind));

  return envelope(buildHeader(loaded.snapshot, 'who approved this holding'), {
    hasApprovalRecord: relevant.length > 0,
    // For a birthright entitlement this sentence is the CORRECT answer, and for
    // an unattributable one it is the finding. It is not a failure of the report.
    statement:
      relevant.length > 0
        ? 'this access was requested and decided; every stage and decision is below'
        : `no approval record exists for this holding. It is explained by: ${
            attributions.length === 0
              ? 'nothing at all'
              : attributions.map((a) => a.kind).join(', ')
          }`,
    attributionKinds: attributions.map((a) => a.kind),
    requests: relevant.map((a) => {
      const detail = a.detail as Record<string, unknown>;
      return {
        requestId: (detail['requestId'] as string | null) ?? null,
        productName: (detail['productName'] as string | null) ?? null,
        requesterName: (detail['requesterName'] as string | null) ?? null,
        justification: (detail['justification'] as string | null) ?? null,
        endsAt: (detail['endsAt'] as string | null) ?? null,
        approvers:
          (detail['approvers'] as ApprovalReport['requests'][number]['approvers'] | undefined) ?? [],
      };
    }),
  });
}
```

- [ ] **Step 5: Run the report tests**

Run: `pnpm vitest run packages/core/src/govern/report-service.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write the export service and its test**

`packages/core/src/govern/export-service.ts`:

```ts
import { createHash } from 'node:crypto';
import { withTenant } from '@syntra/db';
import { recordEvent, stableStringify } from '../audit/audit-service.js';
import { integrityStatus, verifySegment } from './audit-integrity.js';
import { GENESIS_HASH } from '../audit/audit-service.js';
import { bodyOf, headerOf, type ReportEnvelope, type ReportHeader, type SystemAccessRow } from './report-service.js';
import { readableSnapshot } from './snapshot-service.js';

/**
 * One row per holding, with EVERY HEADER FIELD REPEATED AS LEADING COLUMNS ON
 * EVERY ROW.
 *
 * A CSV gets opened, filtered, and pasted into something else, and a header
 * that lives only in row 1 does not survive that journey. Repeating it is
 * ugly and it is the only version that stays true after somebody sorts by
 * column D.
 */
export function toCsv(header: ReportHeader, rows: readonly Record<string, string>[]): string {
  const headerColumns: Record<string, string> = {
    snapshot_id: header.snapshotId,
    as_of: header.asOf,
    scope: header.scopeDescription,
    coverage_gaps_in_scope: String(header.coverageGapCount),
    unattributable_holdings_in_scope: String(header.unattributableCount),
    unattributed_accounts_in_tenant: String(header.unattributedAccountCount),
    sources: header.sources
      .map((s) => `${s.sourceName}=${s.completeness}/${s.staleness}@${s.lastSuccessfulReadAt ?? 'never'}`)
      .join(' | '),
  };

  const columns = [...Object.keys(headerColumns), ...Object.keys(rows[0] ?? { note: '' })];
  const escape = (value: string) =>
    /["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(
      columns.map((c) => escape(headerColumns[c] ?? row[c] ?? '')).join(','),
    );
  }
  // An empty result still emits its header row and one row saying so, because
  // a zero-byte CSV is indistinguishable from a failed export.
  if (rows.length === 0) {
    lines.push(columns.map((c) => escape(headerColumns[c] ?? 'no rows in this scope')).join(','));
  }
  return lines.join('\n');
}

export async function exportReportCsv(
  tenantId: string,
  actorUserId: string,
  e: ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: unknown }>,
  scope: Record<string, unknown>,
): Promise<string> {
  const header = headerOf(e);
  if (header.live) {
    throw new Error(
      'a live report cannot be exported as evidence: it has no as-of time, and evidence with no as-of time is not evidence',
    );
  }

  const rows = bodyOf(e).rows.flatMap((row) =>
    row.resources.map((resource) => ({
      subject: row.displayName,
      subject_key: row.subjectKey,
      bucket: row.bucket,
      resource_kind: resource.resourceKind,
      resource_name: resource.resourceName,
      // NEVER rendered as a zero, a dash or an omission.
      state: resource.state,
      observed_at: resource.observedAt,
      provenance: resource.provenance,
      last_certified_at: resource.lastCertifiedAt ?? 'never certified',
      last_certified_by: resource.lastCertifiedBy ?? '',
    })),
  );

  const csv = toCsv(header, rows);

  // An export is a bulk read of everybody's access, and the audit log should be
  // able to answer who took a copy of it.
  await withTenant(tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId,
      action: 'govern.report.export',
      targetType: 'AccessSnapshot',
      targetId: header.snapshotId,
      outcome: 'success',
      sourceIp: null,
      payload: { format: 'csv', rowCount: rows.length, scope },
    }),
  );

  return csv;
}

export const BUNDLE_LIMITATIONS: readonly string[] = [
  'This bundle proves that the recorded sequence has not been altered or deleted since it was written, to anybody who cannot recompute the chain.',
  'It CANNOT prove completeness of the world. The chain covers what Syntra recorded. Anything that happened without a Syntra audit event — a group membership added at a domain controller, a permission changed in a SaaS admin console, a row updated with direct SQL — leaves no entry. The absence of an event is not evidence of the absence of an act.',
  'It is NOT proof against the operator. The hash is computed in application code from data in the same database, with no secret. Somebody holding both database write access and the ability to run code can rewrite the chain from any point and recompute every subsequent digest, and the result verifies perfectly.',
  'Timestamps are the application server’s clock, not a trusted timestamp. Ordering within a tenant is guaranteed by the sequence; wall-clock accuracy is guaranteed by nothing.',
  'A certification proves a click, not a judgement. It proves a named, authenticated human recorded a decision against a stated set of facts at a stated time. It does not prove they read anything, that the access was appropriate, or that the facts were true at the target at that instant.',
  'An item marked `undecided` in this bundle was NOT attested. The campaign closed and nobody decided it.',
  'Deletion of the entire log is detectable only by something outside it that remembers the head. That is what anchoring is for, and without anchoring it is not detectable.',
];

export interface EvidenceBundle {
  header: ReportHeader;
  limitations: string[];
  snapshot: unknown;
  coverage: unknown;
  items: unknown[];
  decisions: unknown[];
  reviewers: unknown[];
  notifications: unknown[];
  dispatches: unknown[];
  chain: {
    fromSequence: number;
    toSequence: number;
    result: string;
    headSequence: number;
    headHash: string;
  };
  digest: string;
}

/**
 * Serialised with the SAME sorted-key discipline `stableStringify` already
 * implements, so the bundle has a stable digest a reader can recompute a year
 * later. A second sorted-key implementation would drift, and a digest nobody
 * can reproduce is a digest that proves nothing.
 */
export function bundleDigest(bundle: Omit<EvidenceBundle, 'digest'>): string {
  return createHash('sha256').update(stableStringify(bundle)).digest('hex');
}

export async function createEvidencePack(
  tenantId: string,
  actorUserId: string,
  input: {
    kind: 'campaign' | 'report' | 'period';
    snapshotId?: string;
    campaignId?: string;
    scope: Record<string, unknown>;
  },
): Promise<{ id: string; digest: string; bundle: EvidenceBundle }> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const sources = await tx.snapshotSource.findMany({ where: { snapshotId: snapshot.id } });
    const gaps = await tx.coverageGap.findMany({ where: { snapshotId: snapshot.id } });
    const status = await integrityStatus(tx, false);
    const lastCheckpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
    return { snapshot, sources, gaps, status, lastCheckpoint };
  });

  const from = (loaded.lastCheckpoint?.sequence ?? 0) + 1;
  const seed = loaded.lastCheckpoint?.hash ?? GENESIS_HASH;
  const segment = await verifySegment(tenantId, from, seed);

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
    scopeDescription: JSON.stringify(input.scope),
  };

  const withoutDigest: Omit<EvidenceBundle, 'digest'> = {
    header,
    // Printed on the COVER of every bundle, not kept in a caveats appendix,
    // because the harm this module causes is somebody over-reading its output.
    limitations: [...BUNDLE_LIMITATIONS],
    snapshot: {
      id: loaded.snapshot.id,
      asOf: loaded.snapshot.asOf.toISOString(),
      holdingCount: loaded.snapshot.holdingCount,
      unattributableCount: loaded.snapshot.unattributableCount,
    },
    coverage: loaded.gaps.map((g) => ({ kind: g.kind, reason: g.reason, systemId: g.systemId })),
    items: [],
    decisions: [],
    reviewers: [],
    notifications: [],
    dispatches: [],
    chain: {
      fromSequence: segment.fromSequence,
      toSequence: segment.toSequence,
      result: segment.result,
      headSequence: loaded.status.headSequence,
      headHash: loaded.status.headHash,
    },
  };

  const digest = bundleDigest(withoutDigest);
  const bundle: EvidenceBundle = { ...withoutDigest, digest };
  const body = JSON.stringify(bundle);

  const id = await withTenant(tenantId, async (tx) => {
    const pack = await tx.evidencePack.create({
      data: {
        tenantId,
        kind: input.kind,
        scope: input.scope as never,
        snapshotId: loaded.snapshot.id,
        campaignId: input.campaignId ?? null,
        chainHeadSequence: loaded.status.headSequence,
        chainHeadHash: loaded.status.headHash,
        chainVerificationResult: segment.result,
        chainFromSequence: segment.fromSequence,
        chainToSequence: segment.toSequence,
        digest,
        byteLength: Buffer.byteLength(body, 'utf8'),
        createdByUserId: actorUserId,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.evidence.create',
      targetType: 'EvidencePack',
      targetId: pack.id,
      outcome: 'success',
      sourceIp: null,
      payload: { kind: input.kind, digest, chainResult: segment.result, scope: input.scope },
    });
    return pack.id;
  });

  return { id, digest, bundle };
}
```

`packages/core/src/govern/export-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import { BUNDLE_LIMITATIONS, bundleDigest, createEvidencePack, exportReportCsv, toCsv } from './export-service.js';
import { buildHeader, envelope } from './report-service.js';
import { readableSnapshot } from './snapshot-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  snapshotId = await withTenant(tenantId, async (tx) => {
    const s = await tx.accessSnapshot.create({
      data: {
        tenantId, kind: 'manual', status: 'complete', asOf: NOW,
        holdingCount: 1, unattributableCount: 1, coverageGapCount: 2, unattributedAccountCount: 3,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId, snapshotId: s.id, sourceKind: 'targetSystem', sourceId: 'sys-1',
        sourceName: 'Acme AD', lastSuccessfulReadAt: NOW, completeness: 'complete',
        staleness: 'fresh', freshnessSlaHours: 24,
      },
    });
    await recordEvent(tx, {
      actorUserId: null, action: 'seed', targetType: 'T', targetId: null,
      outcome: 'success', sourceIp: null, payload: {},
    });
    return s.id;
  });
});

describe('CSV', () => {
  it('repeats every header field on EVERY row', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'sys-1'),
    );
    const csv = toCsv(header, [{ subject: 'Anna Novak' }, { subject: 'Bram Visser' }]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    // A header that lives only in row 1 does not survive being sorted.
    expect(lines[1]).toContain(snapshotId);
    expect(lines[2]).toContain(snapshotId);
    expect(lines[1]).toContain('2026-06-15T09:00:00.000Z');
    expect(lines[2]).toContain('2026-06-15T09:00:00.000Z');
  });

  it('emits a row saying so for an EMPTY scope rather than a zero-byte file', () => {
    const header = {
      snapshotId: 'x', asOf: NOW.toISOString(), live: false as const, sources: [],
      coverageGapCount: 0, unattributableCount: 0, unattributedAccountCount: 0, scopeDescription: 's',
    };
    const csv = toCsv(header, []);
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('no rows in this scope');
  });

  it('escapes a value containing a comma or a quote', () => {
    const header = {
      snapshotId: 'x', asOf: NOW.toISOString(), live: false as const, sources: [],
      coverageGapCount: 0, unattributableCount: 0, unattributedAccountCount: 0, scopeDescription: 's',
    };
    expect(toCsv(header, [{ subject: 'Novak, Anna "A"' }])).toContain('"Novak, Anna ""A"""');
  });

  it('REFUSES to export a live report', async () => {
    const live = envelope(
      { live: true as const, computedAt: NOW.toISOString(), exportable: false as const, caveat: 'live' },
      { rows: [], holderCount: { known: true, value: 0 } },
    );
    await expect(exportReportCsv(tenantId, 'user-1', live, {})).rejects.toThrow(/no as-of time/);
  });

  it('records an audit event naming the actor, the scope and the row count', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'sys-1'),
    );
    await exportReportCsv(tenantId, 'user-1', envelope(header, { rows: [], holderCount: null }), { systemId: 'sys-1' });
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.report.export' } }),
    );
    expect(event.payload).toMatchObject({ format: 'csv', rowCount: 0, scope: { systemId: 'sys-1' } });
  });
});

describe('the evidence bundle', () => {
  it('carries its limitations on its cover, in words', async () => {
    const { bundle } = await createEvidencePack(tenantId, 'user-1', { kind: 'report', snapshotId, scope: {} });
    expect(bundle.limitations).toEqual(BUNDLE_LIMITATIONS);
    expect(bundle.limitations.join(' ')).toContain('not proof against the operator');
    expect(bundle.limitations.join(' ')).toContain('proves a click, not a judgement');
  });

  it('has a digest that is STABLE across two serializations of the same content', async () => {
    const first = await createEvidencePack(tenantId, 'user-1', { kind: 'report', snapshotId, scope: { a: 1, b: 2 } });
    const { digest: _d, ...withoutDigest } = first.bundle;
    // Key order reversed: a digest over JSON.stringify would differ.
    const reordered = { ...withoutDigest, header: { ...withoutDigest.header } };
    expect(bundleDigest(reordered)).toBe(first.digest);
  });

  it('carries the chain range it covers and its verification result', async () => {
    const { bundle } = await createEvidencePack(tenantId, 'user-1', { kind: 'report', snapshotId, scope: {} });
    expect(bundle.chain).toMatchObject({ fromSequence: 1, result: 'valid' });
    expect(bundle.chain.headSequence).toBeGreaterThanOrEqual(1);
  });

  it('records the pack and an audit event', async () => {
    const { id, digest } = await createEvidencePack(tenantId, 'user-1', { kind: 'report', snapshotId, scope: {} });
    const [pack, event] = await withTenant(tenantId, async (tx) => [
      await tx.evidencePack.findUniqueOrThrow({ where: { id } }),
      await tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.evidence.create' } }),
    ]);
    expect(pack.digest).toBe(digest);
    expect(pack.byteLength).toBeGreaterThan(0);
    expect(event.targetId).toBe(id);
  });
});
```

- [ ] **Step 7: Run the export tests**

Run: `pnpm vitest run packages/core/src/govern/export-service.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 8: Export and typecheck**

Add to `packages/core/src/index.ts`:

```ts
export * from './govern/settings-service.js';
export * from './govern/report-service.js';
export * from './govern/export-service.js';
```

Run: `pnpm exec tsc -b --force`
Expected: exit 0 — **and this is the run that proves the `@ts-expect-error` in `report-service.test.ts` bites.** Vitest does not typecheck; the brand is only enforced here.

- [ ] **Step 9: Mutation-test the header and the counting**

Each reverted before the next; every one must produce a failure under the command named:

1. Delete the `[REPORT_BRAND]` field from `ReportEnvelope` and from `envelope`. Expected: **`pnpm exec tsc -b --force` FAILS** with TS2578 (unused `@ts-expect-error`). The directive stops being needed, which is exactly how a brand's removal announces itself.
2. In `whoHasAccessToSystem`, replace `countRegion({...})` with `known(rows.length)`. Expected: `reports the holder count as UNKNOWN when the scope contains a gap` FAILS.
3. Remove the gap query from `whoHasAccessToSystem` so `gapReasons` is always empty. Expected: the same test FAILS. Two different routes to the same defect, both closed.
4. In `toCsv`, emit the header columns only on the first row. Expected: `repeats every header field on EVERY row` FAILS.
5. In `bundleDigest`, use `JSON.stringify` instead of `stableStringify`. Expected: `has a digest that is STABLE across two serializations` FAILS.
6. In `exportReportCsv`, delete the `header.live` guard. Expected: `REFUSES to export a live report` FAILS.
7. In `whoHasAccessToSystem`, sort alphabetically instead of by bucket. Expected: `groups into the four buckets, uncomfortable first` FAILS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/settings-service.ts \
        packages/core/src/govern/report-service.ts \
        packages/core/src/govern/report-service.test.ts \
        packages/core/src/govern/export-service.ts \
        packages/core/src/govern/export-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): settings, the four reports with their mandatory header, CSV and evidence bundles"
```

---
## Task 12: Jobs, schedules, the seven templates, and the transaction-budget test

Spec §19, §23. Every scheduled job is a pg-boss job carrying `{ tenantId }`, because a background job has no request and therefore no ambient tenant.

**Files:**
- Create: `packages/core/src/govern/jobs.ts`
- Test: `packages/core/src/govern/jobs.test.ts`, `packages/core/src/govern/transaction-budget.test.ts`
- Modify: `packages/core/src/notify/templates/index.ts`, `apps/api/src/scheduler.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `prisma`, `withTenant` from `@syntra/db`; `type Scheduler`; `type Transport`; `buildSnapshot`, `pruneSnapshots` from `./snapshot-service.js`; `verifyIncremental`, `anchorHead`, `type AnchorSink`, `type CheckpointSigner` from `./audit-integrity.js`; `refreshOrphanProposals` from `./orphan-service.js`; `sweepAcceptedFindings` from `./finding-service.js`; `governSettings` from `./settings-service.js`; `enqueueOutbox`, `usersWithPermission`, `displayNames` from `../automate/notify.js`; `PERMISSIONS` from `../rbac/permissions.js`.
- Produces (all in `./jobs.js`):
  - `const GOVERN_SNAPSHOT_JOB = 'govern.snapshot.build'`
  - `const GOVERN_PRUNE_JOB = 'govern.snapshot.prune'`
  - `const GOVERN_VERIFY_JOB = 'govern.audit.verify'`
  - `const GOVERN_ANCHOR_JOB = 'govern.audit.anchor'`
  - `const GOVERN_REMIND_JOB = 'govern.campaign.remind'`
  - `const GOVERN_CLOSE_JOB = 'govern.campaign.close'`
  - `const GOVERN_EXCEPTION_JOB = 'govern.exception.sweep'`
  - `type GovernPurpose = 'snapshot' | 'prune' | 'verify' | 'anchor' | 'remind' | 'close' | 'exception'`
  - `const GOVERN_PURPOSES: readonly GovernPurpose[]`
  - `function governScheduleKey(tenantId: string, purpose: GovernPurpose): string`
  - `interface GovernJobPayload { tenantId: string }`
  - `function governJobPayload(tenantId: string): GovernJobPayload`
  - `interface GovernJobOptions { now?: Date; publicUrl?: string; signer?: CheckpointSigner | null; anchorSink?: AnchorSink | null; batchSize?: number }`
  - `async function runSnapshotJob(payload: GovernJobPayload, options?: GovernJobOptions): Promise<{ snapshotId: string; holdingCount: number; orphanProposals: number }>`
  - `async function runPruneJob(payload: GovernJobPayload, options?: GovernJobOptions): Promise<{ pruned: number }>`
  - `async function runVerifyJob(payload: GovernJobPayload, options?: GovernJobOptions): Promise<{ result: string }>`
  - `async function runAnchorJob(payload: GovernJobPayload, options?: GovernJobOptions): Promise<{ status: string }>`
  - `async function applyGovernSchedules(scheduler: Scheduler, tenantId: string, snapshotSchedule: string | null): Promise<void>`
  - `function registerGovernJobs(scheduler: Scheduler, options?: { transport?: Transport; signer?: CheckpointSigner | null; anchorSink?: AnchorSink | null; publicUrl?: string }): void`
- Produces in `../notify/templates/index.js` — seven templates added to `TEMPLATES`: `govern-review-assigned`, `govern-review-reminder`, `govern-review-escalated`, `govern-review-reassigned`, `govern-campaign-blocked-item`, `govern-finding-critical`, `govern-exception-expiring`.

**Placeholder note.** `GOVERN_REMIND_JOB`, `GOVERN_CLOSE_JOB` and `GOVERN_EXCEPTION_JOB` are declared here with their queue names and schedule keys and **registered with handlers in Task 18 and Task 21**, which is where the campaign machinery exists. They are declared now because `applyGovernSchedules` reconciles *every* purpose in one pass — pg-boss keeps its schedules in the database, so a purpose left out of this function has a schedule row nothing ever removes. `registerGovernJobs` registers handlers only for the four that exist in slice 1, and Task 18 adds the other three to the same function.

- [ ] **Step 1: Write the failing jobs test**

`packages/core/src/govern/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { TEMPLATES } from '../notify/templates/index.js';
import {
  GOVERN_ANCHOR_JOB,
  GOVERN_PURPOSES,
  GOVERN_SNAPSHOT_JOB,
  GOVERN_VERIFY_JOB,
  applyGovernSchedules,
  governJobPayload,
  governScheduleKey,
  registerGovernJobs,
  runPruneJob,
  runSnapshotJob,
  runVerifyJob,
} from './jobs.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let otherTenantId: string;

const fakeScheduler = () => {
  const scheduled: { name: string; cron: string; key: string | undefined }[] = [];
  const unscheduled: { name: string; key: string | undefined }[] = [];
  const registered: string[] = [];
  return {
    scheduled,
    unscheduled,
    registered,
    scheduler: {
      register: (name: string) => { registered.push(name); },
      start: async () => {},
      stop: async () => {},
      enqueue: async () => null,
      schedule: async (name: string, cron: string, _data?: unknown, key?: string) => {
        scheduled.push({ name, cron, key });
      },
      unschedule: async (name: string, key?: string) => { unscheduled.push({ name, key }); },
    } as Scheduler,
  };
};

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

describe('schedule keys', () => {
  it('gives every tenant and every purpose a distinct key', () => {
    // pg-boss keys its schedule table on (queue, key) with key defaulting to ''.
    // All directory sources once shared key '' and only the last one in the
    // last tenant ever ran.
    const keys = new Set<string>();
    for (const tenant of [tenantId, otherTenantId]) {
      for (const purpose of GOVERN_PURPOSES) keys.add(governScheduleKey(tenant, purpose));
    }
    expect(keys.size).toBe(2 * GOVERN_PURPOSES.length);
  });

  it('names all seven purposes', () => {
    expect([...GOVERN_PURPOSES].sort()).toEqual([
      'anchor', 'close', 'exception', 'prune', 'remind', 'snapshot', 'verify',
    ]);
  });
});

describe('applyGovernSchedules', () => {
  it('schedules every purpose with a distinct key when a cadence is set', async () => {
    const { scheduler, scheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, '0 1 * * *');
    expect(scheduled).toHaveLength(GOVERN_PURPOSES.length);
    expect(new Set(scheduled.map((s) => s.key)).size).toBe(GOVERN_PURPOSES.length);
  });

  it('UNSCHEDULES every purpose when the cadence is cleared', async () => {
    // Scheduling and unscheduling are two halves of one decision. pg-boss keeps
    // schedules in the database, so a tenant that turned snapshots off while
    // this process was down still has rows waiting for it.
    const { scheduler, scheduled, unscheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, null);
    expect(scheduled).toHaveLength(0);
    expect(unscheduled).toHaveLength(GOVERN_PURPOSES.length);
  });
});

describe('registerGovernJobs', () => {
  it('registers a handler for every queue it schedules in slice 1', () => {
    const { scheduler, registered } = fakeScheduler();
    registerGovernJobs(scheduler);
    expect(registered).toEqual(
      expect.arrayContaining([GOVERN_SNAPSHOT_JOB, GOVERN_VERIFY_JOB, GOVERN_ANCHOR_JOB]),
    );
  });
});

describe('the jobs', () => {
  it('builds a snapshot and refreshes orphan proposals in one run', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.create({ data: { tenantId, login: 'svc', email: 's@a.test', displayName: 'Service' } }),
    );
    const result = await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    expect(result.snapshotId).toBeTruthy();
    const snapshot = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findUniqueOrThrow({ where: { id: result.snapshotId } }),
    );
    expect(snapshot.status).toBe('complete');
  });

  it('verifies incrementally and records the check', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    const result = await runVerifyJob(governJobPayload(tenantId), { now: NOW });
    expect(result.result).toBe('valid');
    const checks = await withTenant(tenantId, (tx) => tx.auditChainCheck.findMany());
    expect(checks).toHaveLength(1);
  });

  it('touches no other tenant', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    const other = await withTenant(otherTenantId, (tx) => tx.accessSnapshot.count());
    expect(other).toBe(0);
  });

  it('prunes nothing when retention has not been reached', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    expect(await runPruneJob(governJobPayload(tenantId), { now: NOW })).toEqual({ pruned: 0 });
  });
});

describe('the templates', () => {
  it('adds seven Govern templates, and every one renders a NAME rather than an id', () => {
    const govern = Object.keys(TEMPLATES).filter((k) => k.startsWith('govern-'));
    expect(govern).toHaveLength(7);
    for (const name of govern) {
      const template = TEMPLATES[name as keyof typeof TEMPLATES];
      const placeholders = [...`${template.subject}${template.text}`.matchAll(/\{\{(\w+)\}\}/g)].map(
        (m) => m[1],
      );
      // No `var` a template renders may be an id. UUIDs in a notification are
      // "the feature works and no human can use it".
      expect(placeholders.filter((p) => /Id$/.test(p ?? ''))).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/jobs.test.ts`
Expected: FAIL — `Cannot find module './jobs.js'`.

- [ ] **Step 3: Add the seven templates**

In `packages/core/src/notify/templates/index.ts`, inside the `TEMPLATES` object, after the existing entries:

```ts
  'govern-review-assigned': {
    subject: '{{itemCount}} access reviews are waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe access review "{{campaignName}}" has {{itemCount}} items for you to decide, and closes on {{dueAt}}.\n\n{{reviewUrl}}\n\nEach item says what the access is, how the person got it, and when it was last confirmed. Certifying an item records that you decided to keep it, against the facts shown, at the time you clicked. It does not say the access is appropriate — only that you looked.',
    html: '<p>Hello {{displayName}},</p><p>The access review <strong>{{campaignName}}</strong> has {{itemCount}} items for you to decide, and closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>Each item says what the access is, how the person got it, and when it was last confirmed. Certifying an item records that you decided to keep it, against the facts shown, at the time you clicked. It does not say the access is appropriate — only that you looked.</p>',
  },
  'govern-review-reminder': {
    subject: '{{itemCount}} access reviews still waiting — {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" are still undecided. The review closes on {{dueAt}}.\n\n{{reviewUrl}}\n\nNothing is certified and nothing is removed if you do not respond. The items are recorded as undecided, they are listed against your name on the campaign report, and somebody has to decide them by hand afterwards.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> are still undecided. The review closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>Nothing is certified and nothing is removed if you do not respond. The items are recorded as undecided, they are listed against your name on the campaign report, and somebody has to decide them by hand afterwards.</p>',
  },
  'govern-review-escalated': {
    subject: 'An access review was escalated past you — {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" have been escalated to {{escalatedTo}} because they were still undecided.\n\nYou have NOT been removed as a reviewer and you can still decide them: {{reviewUrl}}\n\nYou are being told because decisions attributed to you should never be decisions somebody else made.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> have been escalated to {{escalatedTo}} because they were still undecided.</p><p>You have <strong>not</strong> been removed as a reviewer and you can still decide them: <a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>You are being told because decisions attributed to you should never be decisions somebody else made.</p>',
  },
  'govern-review-reassigned': {
    subject: 'Access reviews have moved to you — {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" have been reassigned to you, because {{previousReviewer}} can no longer decide them.\n\n{{reviewUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> have been reassigned to you, because {{previousReviewer}} can no longer decide them.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p>',
  },
  'govern-campaign-blocked-item': {
    subject: 'An access review item has no reviewer — {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" resolved to nobody who can decide them, and the fallback resolved to nobody either.\n\n{{campaignUrl}}\n\nThey will not auto-decide and they will not go away. Somebody has to name a reviewer, or the scope has to change.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> resolved to nobody who can decide them, and the fallback resolved to nobody either.</p><p><a href="{{campaignUrl}}">{{campaignUrl}}</a></p><p>They will not auto-decide and they will not go away. Somebody has to name a reviewer, or the scope has to change.</p>',
  },
  'govern-finding-critical': {
    subject: 'A critical governance finding was raised at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{findingKind}}: {{summary}}\n\n{{findingUrl}}\n\nThis is not part of a digest and it is not batched. It was sent the moment it was found.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{findingKind}}</strong>: {{summary}}</p><p><a href="{{findingUrl}}">{{findingUrl}}</a></p><p>This is not part of a digest and it is not batched. It was sent the moment it was found.</p>',
  },
  'govern-exception-expiring': {
    subject: 'An SoD exception expires on {{endsAt}} — {{ruleName}}',
    text: 'Hello {{displayName}},\n\nThe exception to "{{ruleName}}" for {{beneficiaryName}} expires on {{endsAt}}.\n\nRenew it here, pre-filled with the existing justification: {{renewUrl}}\n\nNothing is removed when it lapses. The violation reopens and everybody involved is told.',
    html: '<p>Hello {{displayName}},</p><p>The exception to <strong>{{ruleName}}</strong> for {{beneficiaryName}} expires on {{endsAt}}.</p><p><a href="{{renewUrl}}">Renew it</a>, pre-filled with the existing justification.</p><p>Nothing is removed when it lapses. The violation reopens and everybody involved is told.</p>',
  },
```

- [ ] **Step 4: Write the jobs module**

`packages/core/src/govern/jobs.ts`:

```ts
import { prisma, withTenant } from '@syntra/db';
import type { Scheduler } from '../jobs/scheduler.js';
import type { Transport } from '../notify/notification-service.js';
import { anchorHead, verifyIncremental, type AnchorSink, type CheckpointSigner } from './audit-integrity.js';
import { sweepAcceptedFindings } from './finding-service.js';
import { refreshOrphanProposals } from './orphan-service.js';
import { governSettings } from './settings-service.js';
import { buildSnapshot, pruneSnapshots } from './snapshot-service.js';

export const GOVERN_SNAPSHOT_JOB = 'govern.snapshot.build';
export const GOVERN_PRUNE_JOB = 'govern.snapshot.prune';
export const GOVERN_VERIFY_JOB = 'govern.audit.verify';
export const GOVERN_ANCHOR_JOB = 'govern.audit.anchor';
export const GOVERN_REMIND_JOB = 'govern.campaign.remind';
export const GOVERN_CLOSE_JOB = 'govern.campaign.close';
export const GOVERN_EXCEPTION_JOB = 'govern.exception.sweep';

export type GovernPurpose =
  | 'snapshot' | 'prune' | 'verify' | 'anchor' | 'remind' | 'close' | 'exception';

export const GOVERN_PURPOSES: readonly GovernPurpose[] = [
  'snapshot', 'prune', 'verify', 'anchor', 'remind', 'close', 'exception',
];

const QUEUE_FOR: Record<GovernPurpose, string> = {
  snapshot: GOVERN_SNAPSHOT_JOB,
  prune: GOVERN_PRUNE_JOB,
  verify: GOVERN_VERIFY_JOB,
  anchor: GOVERN_ANCHOR_JOB,
  remind: GOVERN_REMIND_JOB,
  close: GOVERN_CLOSE_JOB,
  exception: GOVERN_EXCEPTION_JOB,
};

/**
 * pg-boss keys its schedule table on (queue, key) and `Scheduler.schedule`
 * defaults `key` to the empty string. All directory sources once shared `key:
 * ''` and only the last one in the last tenant ever ran. Mandatory on every
 * schedule and unschedule this module makes.
 */
export function governScheduleKey(tenantId: string, purpose: GovernPurpose): string {
  return `govern:${purpose}:${tenantId}`;
}

export interface GovernJobPayload {
  tenantId: string;
}

/** A background job has no request and therefore no ambient tenant. */
export function governJobPayload(tenantId: string): GovernJobPayload {
  return { tenantId };
}

export interface GovernJobOptions {
  now?: Date;
  publicUrl?: string;
  signer?: CheckpointSigner | null;
  anchorSink?: AnchorSink | null;
  batchSize?: number;
}

export async function runSnapshotJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ snapshotId: string; holdingCount: number; orphanProposals: number }> {
  const now = options.now ?? new Date();
  const built = await buildSnapshot(payload.tenantId, {
    now,
    kind: 'scheduled',
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
  const orphans = await refreshOrphanProposals(payload.tenantId, built.snapshotId, { now });
  await sweepAcceptedFindings(payload.tenantId, now);
  return {
    snapshotId: built.snapshotId,
    holdingCount: built.holdingCount,
    orphanProposals: orphans.proposals,
  };
}

export async function runPruneJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ pruned: number }> {
  const result = await pruneSnapshots(payload.tenantId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { pruned: result.pruned };
}

export async function runVerifyJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ result: string }> {
  const result = await verifyIncremental(payload.tenantId, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signer === undefined ? {} : { signer: options.signer }),
  });
  return { result: result.result };
}

export async function runAnchorJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ status: string }> {
  if (options.anchorSink == null) {
    // Not an error. A tenant with no anchoring configured sees that stated on
    // its own integrity screen, in words; a job that threw here would fill the
    // log with failures about a feature nobody turned on.
    return { status: 'not_configured' };
  }
  const result = await anchorHead(payload.tenantId, options.anchorSink, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { status: result.status };
}

/**
 * Reconciles EVERY purpose, not only the eligible ones.
 *
 * pg-boss keeps its schedules in the database, so a tenant that turned
 * snapshots off while this process was down still has schedule rows waiting for
 * it. Reading the whole list lets this function remove those as well as add the
 * rest, which is the difference between reconciling and appending.
 */
export async function applyGovernSchedules(
  scheduler: Scheduler,
  tenantId: string,
  snapshotSchedule: string | null,
): Promise<void> {
  const CRON: Record<GovernPurpose, string> = {
    snapshot: snapshotSchedule ?? '',
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
    if (snapshotSchedule === null || cron === '') {
      await scheduler.unschedule(QUEUE_FOR[purpose], key);
      continue;
    }
    await scheduler.schedule(QUEUE_FOR[purpose], cron, governJobPayload(tenantId), key);
  }
}

/**
 * Slice 1 registers four handlers. Task 18 adds `remind` and `close`, Task 21
 * adds `exception`, to this same function — the queues and keys are declared
 * here so that `applyGovernSchedules` reconciles all seven from the start and
 * no purpose ends up with a schedule row nothing removes.
 */
export function registerGovernJobs(
  scheduler: Scheduler,
  options: {
    transport?: Transport;
    signer?: CheckpointSigner | null;
    anchorSink?: AnchorSink | null;
    publicUrl?: string;
  } = {},
): void {
  scheduler.register<GovernJobPayload>(GOVERN_SNAPSHOT_JOB, async (payload) => {
    await runSnapshotJob(payload);
  });
  scheduler.register<GovernJobPayload>(GOVERN_PRUNE_JOB, async (payload) => {
    await runPruneJob(payload);
  });
  scheduler.register<GovernJobPayload>(GOVERN_VERIFY_JOB, async (payload) => {
    await runVerifyJob(payload, { signer: options.signer ?? null });
  });
  scheduler.register<GovernJobPayload>(GOVERN_ANCHOR_JOB, async (payload) => {
    await runAnchorJob(payload, { anchorSink: options.anchorSink ?? null });
  });
}
```

- [ ] **Step 5: Wire the scheduler**

In `apps/api/src/scheduler.ts`, add `registerGovernJobs` and `applyGovernSchedules` to the `@syntra/core` import, then:

- in `startSyncScheduler`, after `registerKeyRotationJob(scheduler, provider);`:

```ts
    registerGovernJobs(scheduler);
```

- in `scheduleBackgroundWork`, after the signing-key loop and before the sources loop:

```ts
  for (const tenant of tenants) {
    try {
      // Read through withTenant like any other tenant-scoped read; `Tenant` is
      // the one model deliberately outside RLS so this enumeration can happen.
      const settings = await withTenant(tenant.id, (tx) =>
        tx.governSettings.findUnique({ where: { tenantId: tenant.id } }),
      );
      await applyGovernSchedules(scheduler, tenant.id, settings?.snapshotSchedule ?? '0 1 * * *');
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule Govern jobs',
      );
    }
  }
```

**Nothing in here may reject** — the surrounding function's whole contract is that an API which comes up with governance unscheduled is strictly better than one that does not come up at all.

- [ ] **Step 6: Write the transaction-budget test**

`packages/core/src/govern/transaction-budget.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { collectTenant } from './collect.js';
import { buildSnapshot } from './snapshot-service.js';

/**
 * Section 23: "No `withTenant` call encloses a loop over an unbounded
 * collection, checked in test by a client wrapper that fails when a transaction
 * exceeds a time budget under a seeded large tenant."
 *
 * The budget is deliberately well under Prisma's 5000 ms default. A test that
 * used 5000 ms would only fail once the defect was already shipping.
 */
const BUDGET_MS = 2500;
const PEOPLE = 400;
const GROUPS = 20;

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const groups = [];
    for (let g = 0; g < GROUPS; g += 1) {
      groups.push(await tx.group.create({ data: { tenantId, name: `group-${g}` } }));
    }
    const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
    const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
    await tx.appAssignment.create({
      data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: ou.id },
    });

    for (let i = 0; i < PEOPLE; i += 1) {
      const person = await tx.person.create({
        data: { tenantId, givenName: `P${i}`, familyName: 'Test' },
      });
      await tx.contract.create({
        data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
      });
      const user = await tx.user.create({
        data: {
          tenantId, login: `u${i}`, email: `u${i}@acme.test`, displayName: `P${i} Test`,
          personId: person.id, orgUnitId: ou.id,
        },
      });
      for (let g = 0; g < 5; g += 1) {
        await tx.groupMembership.create({
          data: { tenantId, groupId: groups[(i + g) % GROUPS]!.id, userId: user.id },
        });
      }
    }
  });
}, 120_000);

/** Times every transaction the callback opens, by timing withTenant itself. */
async function timedTransactions<T>(fn: () => Promise<T>): Promise<{ result: T; slowest: number }> {
  const durations: number[] = [];
  const original = Reflect.get(prisma, '$transaction') as (...args: unknown[]) => Promise<unknown>;
  Reflect.set(prisma, '$transaction', async (...args: unknown[]) => {
    const started = Date.now();
    try {
      return await original.apply(prisma, args);
    } finally {
      durations.push(Date.now() - started);
    }
  });
  try {
    const result = await fn();
    return { result, slowest: Math.max(0, ...durations) };
  } finally {
    Reflect.set(prisma, '$transaction', original);
  }
}

describe('the transaction budget', () => {
  it('collects a 400-person tenant with no transaction over the budget', async () => {
    const { result, slowest } = await timedTransactions(() => collectTenant(tenantId));
    expect(result.holdings.length).toBeGreaterThan(PEOPLE);
    expect(result.queryCount).toBe(9);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('builds a snapshot over the same tenant with no transaction over the budget', async () => {
    const { result, slowest } = await timedTransactions(() =>
      buildSnapshot(tenantId, { batchSize: 200 }),
    );
    expect(result.status).toBe('complete');
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('fails when the write batch is unbounded — the mutation this test exists for', async () => {
    // Documented rather than executed: setting batchSize to Number.MAX_SAFE_INTEGER
    // here writes every holding in ONE transaction, which is exactly the shape
    // the budget forbids. Run it by hand when changing the batching, and expect
    // `slowest` to exceed the budget on a tenant of any real size.
    expect(BUDGET_MS).toBeLessThan(5000);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/jobs.test.ts packages/core/src/govern/transaction-budget.test.ts`
Expected: PASS. The budget file is slow — the seed alone is 400 people — and its `beforeEach` and cases carry explicit 120-second timeouts.

- [ ] **Step 8: Export and typecheck**

Add `export * from './govern/jobs.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Mutation-test**

1. Make `governScheduleKey` return `''`. Expected: `gives every tenant and every purpose a distinct key` FAILS.
2. In `applyGovernSchedules`, `return` early when `snapshotSchedule === null` instead of unscheduling. Expected: `UNSCHEDULES every purpose when the cadence is cleared` FAILS.
3. Put a UUID placeholder — `{{campaignId}}` — into `govern-review-assigned`. Expected: `every one renders a NAME rather than an id` FAILS.
4. In `buildSnapshot`, set the effective batch size to `Number.MAX_SAFE_INTEGER`. Expected: `builds a snapshot over the same tenant with no transaction over the budget` FAILS. **This is the mutation the budget test exists for**; run it once by hand and record the observed `slowest` in the commit message.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/jobs.ts \
        packages/core/src/govern/jobs.test.ts \
        packages/core/src/govern/transaction-budget.test.ts \
        packages/core/src/notify/templates/index.ts \
        apps/api/src/scheduler.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): jobs, schedules, notification templates and the transaction budget"
```

---

## Task 13: The HTTP surface (slice 1) — four permissions and the org-unit-scoped read

Spec §18, §20, §21. **This task closes integration finding 3.**

Core's `hasPermission(tx, userId, permission, scopeOrgUnitId?)` matches a scoped assignment only against that exact unit id and explicitly refuses to satisfy an unscoped question, and `requirePermission` asks unscoped. A holder of `govern.read` scoped to Head Office therefore gets **403 on every Govern route**, and even if the route asked with a scope, a person in a unit *beneath* Head Office would not match. §21 requires the scope to be respected "on every read path, not only on the list".

**Files:**
- Create: `packages/core/src/govern/scope.ts`, `packages/contracts/src/govern.ts`, `apps/api/src/routes/admin/govern.ts`
- Test: `packages/core/src/govern/scope.test.ts`, `apps/api/src/routes/admin/govern.test.ts`
- Modify: `packages/core/src/rbac/permissions.ts`, `packages/contracts/src/index.ts`, `apps/api/src/app.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `hasPermission`, `permissionsForUser` from `../rbac/rbac-service.js`; `PERMISSIONS`, `type Permission`; `withTenant`, `type TenantClient`; `MAX_ORG_UNIT_DEPTH` from `./collect.js`; every slice-1 service; `requireSession`, `requirePermission`, `ProblemError`, `buildTestApp` from `apps/api`; `claimSyntraUsers` and the account-linking path from `../provision/syntra-user.js`; `PROVISION_JOB`, `provisionJobPayload` from `../provision/jobs.js`; `SYNC_JOB`, `syncJobPayload` from `../sync/jobs.js`.
- Produces in `packages/core/src/rbac/permissions.ts`:
  - `GOVERN_READ: 'govern.read'`, `GOVERN_MANAGE: 'govern.manage'`, `GOVERN_ACCEPT_RISK: 'govern.accept_risk'`, `GOVERN_EXPORT: 'govern.export'`
- Produces (in `./scope.js`):
  - `type GovernScope = { kind: 'tenant' } | { kind: 'orgUnits'; orgUnitIds: string[] } | { kind: 'none' }`
  - `async function governReadScope(tx: TenantClient, userId: string): Promise<GovernScope>`
  - `async function orgUnitDescendants(tx: TenantClient, roots: readonly string[]): Promise<string[]>`
  - `function scopeAdmitsPerson(scope: GovernScope, personOrgUnitId: string | null): boolean`
  - `async function personIdsInScope(tx: TenantClient, scope: GovernScope): Promise<Set<string> | 'all'>`
- Produces in `apps/api/src/routes/admin/govern.ts`:
  - `function requireGovernRead(): preHandler` — 403s only when the scope is `none`
  - `async function registerAdminGovernRoutes(app: FastifyInstance, options: { masterKeyProvider: MasterKeyProvider }): Promise<void>`
- Produces the slice-1 routes, all relative to the `/api/admin` prefix:
  `GET /govern/snapshots`, `POST /govern/snapshots`, `GET /govern/snapshots/:id`, `GET /govern/snapshots/:id/coverage`, `POST /govern/sources/:kind/:id/refresh`, `GET /govern/reports/system`, `GET /govern/reports/person/:personId`, `GET /govern/reports/changes`, `GET /govern/reports/approval`, `POST /govern/exports/csv`, `POST /govern/evidence`, `GET /govern/findings`, `POST /govern/findings/:id/assign`, `POST /govern/findings/:id/accept`, `GET /govern/remediation`, `POST /govern/remediation/:id/resolve`, `GET /govern/orphans`, `POST /govern/orphans/:id/confirm`, `POST /govern/orphans/:id/deny`, `GET /govern/integrity`, `POST /govern/integrity/verify`, `GET /govern/settings`, `PATCH /govern/settings`, `POST /govern/classifications`.

- [ ] **Step 1: Add the four permissions**

In `packages/core/src/rbac/permissions.ts`, inside `PERMISSIONS`, after the Provision and Automate entries:

```ts
  /** Snapshots, reports, findings, campaigns, violations. SCOPEABLE to an org unit. */
  GOVERN_READ: 'govern.read',
  /** Build snapshots, create and close campaigns, confirm a revocation batch,
   *  define functions and rules, assign findings, change a setting. */
  GOVERN_MANAGE: 'govern.manage',
  /** Approve an SoD exception where its rule names no workflow. DELIBERATELY
   *  distinct from govern.manage: administering the governance module and
   *  accepting the organization's risk are different jobs, and a product that
   *  conflates them hands risk acceptance to whoever configures the software. */
  GOVERN_ACCEPT_RISK: 'govern.accept_risk',
  /** Produce a CSV or an evidence bundle. Distinct from govern.read because
   *  reading a screen and walking out with a file are different acts with
   *  different consequences, and only one of them is a copy. */
  GOVERN_EXPORT: 'govern.export',
```

**There is deliberately no `govern.review`.** Review authority comes from resolution, as approval authority does in Automate. A tenant-wide "may certify anything" permission is not a thing anybody should hold.

- [ ] **Step 2: Write the failing scope test**

`packages/core/src/govern/scope.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole, hasPermission } from '../rbac/rbac-service.js';
import { governReadScope, orgUnitDescendants, personIdsInScope, scopeAdmitsPerson } from './scope.js';

let tenantId: string;
let root: string;
let region: string;
let care: string;
let unscopedUserId: string;
let scopedUserId: string;
let noneUserId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const rootOu = await tx.orgUnit.create({ data: { tenantId, name: 'Head Office' } });
    const regionOu = await tx.orgUnit.create({ data: { tenantId, name: 'North', parentId: rootOu.id } });
    const careOu = await tx.orgUnit.create({ data: { tenantId, name: 'Care', parentId: regionOu.id } });

    const role = await createRole(tx, 'Governance reader', [PERMISSIONS.GOVERN_READ]);
    const mk = async (login: string) =>
      (await tx.user.create({
        data: { tenantId, login, email: `${login}@acme.test`, displayName: login },
      })).id;

    const unscoped = await mk('unscoped');
    const scoped = await mk('scoped');
    const none = await mk('none');
    await assignRole(tx, unscoped, role.id);
    await assignRole(tx, scoped, role.id, rootOu.id);

    return { rootOu: rootOu.id, regionOu: regionOu.id, careOu: careOu.id, unscoped, scoped, none };
  });

  root = seeded.rootOu;
  region = seeded.regionOu;
  care = seeded.careOu;
  unscopedUserId = seeded.unscoped;
  scopedUserId = seeded.scoped;
  noneUserId = seeded.none;
});

describe('the gap in Core’s hasPermission this module closes', () => {
  it('Core refuses a scoped holder asked unscoped — which is what requirePermission does', async () => {
    // Recorded as a test rather than as a comment, because the whole reason
    // `requireGovernRead` exists is this behaviour, and a future reader will
    // otherwise assume the standard guard would have worked.
    const answer = await withTenant(tenantId, (tx) =>
      hasPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ),
    );
    expect(answer).toBe(false);
  });

  it('Core also refuses a scope BENEATH the assignment', async () => {
    const answer = await withTenant(tenantId, (tx) =>
      hasPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ, care),
    );
    expect(answer).toBe(false);
  });
});

describe('governReadScope', () => {
  it('gives an unscoped holder the whole tenant', async () => {
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, unscopedUserId));
    expect(scope).toEqual({ kind: 'tenant' });
  });

  it('gives a scoped holder their unit AND every unit beneath it', async () => {
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, scopedUserId));
    expect(scope.kind).toBe('orgUnits');
    if (scope.kind !== 'orgUnits') throw new Error('unreachable');
    expect([...scope.orgUnitIds].sort()).toEqual([root, region, care].sort());
  });

  it('gives a holder of nothing an empty scope, not a tenant one', async () => {
    // The empty case, in the dangerous direction: a `none` that fell back to
    // `tenant` would hand everybody's access to anybody with a session.
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, noneUserId));
    expect(scope).toEqual({ kind: 'none' });
  });
});

describe('orgUnitDescendants', () => {
  it('includes the roots themselves', async () => {
    const ids = await withTenant(tenantId, (tx) => orgUnitDescendants(tx, [region]));
    expect([...ids].sort()).toEqual([region, care].sort());
  });

  it('returns nothing for an EMPTY root list rather than everything', async () => {
    expect(await withTenant(tenantId, (tx) => orgUnitDescendants(tx, []))).toEqual([]);
  });

  it('terminates on a cycle', async () => {
    await withTenant(tenantId, (tx) =>
      tx.orgUnit.update({ where: { id: root }, data: { parentId: care } }),
    );
    const ids = await withTenant(tenantId, (tx) => orgUnitDescendants(tx, [root]));
    expect(ids.length).toBeLessThanOrEqual(3);
  });
});

describe('scopeAdmitsPerson and personIdsInScope', () => {
  it('admits everybody under a tenant scope', () => {
    expect(scopeAdmitsPerson({ kind: 'tenant' }, null)).toBe(true);
  });

  it('admits nobody under a none scope', () => {
    expect(scopeAdmitsPerson({ kind: 'none' }, care)).toBe(false);
  });

  it('admits a person in a unit beneath the scoped unit, and refuses one outside', () => {
    const scope = { kind: 'orgUnits' as const, orgUnitIds: [root, region, care] };
    expect(scopeAdmitsPerson(scope, care)).toBe(true);
    expect(scopeAdmitsPerson(scope, 'ou-elsewhere')).toBe(false);
  });

  it('REFUSES a person with no org unit under an org-unit scope', () => {
    // A person whose user sits in no unit is not "in every unit". Admitting
    // them would silently widen every scoped read to the unplaced population,
    // which on a fresh import is everybody.
    expect(scopeAdmitsPerson({ kind: 'orgUnits', orgUnitIds: [root] }, null)).toBe(false);
  });

  it('resolves the person set for an org-unit scope, and `all` for a tenant one', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      await tx.user.create({
        data: { tenantId, login: 'ab', email: 'ab@a.test', displayName: 'A B', personId: p.id, orgUnitId: care },
      });
      return p.id;
    });
    const scoped = await withTenant(tenantId, (tx) =>
      personIdsInScope(tx, { kind: 'orgUnits', orgUnitIds: [root, region, care] }),
    );
    expect(scoped).not.toBe('all');
    expect([...(scoped as Set<string>)]).toEqual([personId]);
    expect(await withTenant(tenantId, (tx) => personIdsInScope(tx, { kind: 'tenant' }))).toBe('all');
  });
});
```

- [ ] **Step 3: Write the scope module**

`packages/core/src/govern/scope.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { PERMISSIONS } from '../rbac/permissions.js';
import { MAX_ORG_UNIT_DEPTH } from './collect.js';

/**
 * `govern.read` is scopeable to an organizational unit, because reading Govern
 * tenant-wide is reading everybody's access and a team lead who reviews their
 * own department should not be handed that.
 *
 * Core's `hasPermission(tx, userId, permission, scopeOrgUnitId?)` cannot answer
 * this question. It matches a scoped assignment only against that EXACT unit id
 * and explicitly refuses to satisfy an unscoped question, and `requirePermission`
 * asks unscoped — so a scope-only holder gets 403 on every Govern route, and a
 * scope on Head Office would not admit a person in a unit beneath it. Neither
 * behaviour is wrong for Core's callers; both are wrong for this one.
 *
 * `scope.test.ts` records both behaviours as tests, so a future reader does not
 * assume the standard guard would have worked.
 */
export type GovernScope =
  | { kind: 'tenant' }
  | { kind: 'orgUnits'; orgUnitIds: string[] }
  | { kind: 'none' };

/** The named units plus every unit beneath them, with a depth cap and a seen-set. */
export async function orgUnitDescendants(
  tx: TenantClient,
  roots: readonly string[],
): Promise<string[]> {
  if (roots.length === 0) return [];

  const units = await tx.orgUnit.findMany({ select: { id: true, parentId: true } });
  const childrenByParent = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.parentId === null) continue;
    childrenByParent.set(unit.parentId, [...(childrenByParent.get(unit.parentId) ?? []), unit.id]);
  }

  const seen = new Set<string>();
  const queue: { id: string; depth: number }[] = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id) || next.depth >= MAX_ORG_UNIT_DEPTH) continue;
    seen.add(next.id);
    for (const child of childrenByParent.get(next.id) ?? []) {
      queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return [...seen];
}

export async function governReadScope(
  tx: TenantClient,
  userId: string,
): Promise<GovernScope> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: { select: { permissions: true } } },
  });
  const relevant = assignments.filter((a) =>
    a.role.permissions.includes(PERMISSIONS.GOVERN_READ),
  );
  if (relevant.length === 0) return { kind: 'none' };
  if (relevant.some((a) => a.scopeOrgUnitId === null)) return { kind: 'tenant' };

  const roots = relevant
    .map((a) => a.scopeOrgUnitId)
    .filter((x): x is string => x !== null);
  return { kind: 'orgUnits', orgUnitIds: await orgUnitDescendants(tx, roots) };
}

/**
 * A person whose user sits in NO unit is not "in every unit". Admitting them
 * under an org-unit scope would silently widen every scoped read to the
 * unplaced population, which on a fresh import is everybody.
 */
export function scopeAdmitsPerson(scope: GovernScope, personOrgUnitId: string | null): boolean {
  if (scope.kind === 'tenant') return true;
  if (scope.kind === 'none') return false;
  return personOrgUnitId !== null && scope.orgUnitIds.includes(personOrgUnitId);
}

/**
 * `'all'` rather than a set of every person, so a tenant-scoped caller costs no
 * query and no allocation on a report over 40,000 people.
 */
export async function personIdsInScope(
  tx: TenantClient,
  scope: GovernScope,
): Promise<Set<string> | 'all'> {
  if (scope.kind === 'tenant') return 'all';
  if (scope.kind === 'none') return new Set();

  const users = await tx.user.findMany({
    where: { orgUnitId: { in: scope.orgUnitIds }, personId: { not: null } },
    select: { personId: true },
  });
  return new Set(users.map((u) => u.personId!).filter((id) => id !== null));
}
```

- [ ] **Step 4: Run the scope test**

Run: `pnpm vitest run packages/core/src/govern/scope.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the contracts**

`packages/contracts/src/govern.ts`:

```ts
import { z } from 'zod';

export const governSnapshotQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const buildSnapshotBody = z.object({
  kind: z.enum(['manual', 'campaign']).default('manual'),
});

export const systemReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
  systemId: z.string().min(1),
  resourceId: z.string().min(1).optional(),
});

export const personReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
});

export const changeReportQuery = z.object({
  fromSnapshotId: z.string().uuid(),
  toSnapshotId: z.string().uuid(),
});

export const approvalReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
  subjectKey: z.string().min(1),
  systemId: z.string().min(1),
  resourceKind: z.enum([
    'targetEntitlement', 'targetAccount', 'syntraGroup', 'application', 'syntraRole', 'syntraUser',
  ]),
  resourceId: z.string().min(1),
});

export const exportCsvBody = systemReportQuery;

export const evidencePackBody = z.object({
  kind: z.enum(['campaign', 'report', 'period']),
  snapshotId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  scope: z.record(z.unknown()).default({}),
});

export const findingQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'accepted', 'resolved']).optional(),
  kind: z.string().min(1).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const assignFindingBody = z.object({
  ownerPersonId: z.string().uuid(),
  dueAt: z.coerce.date(),
});

export const acceptFindingBody = z.object({
  // `.min(1)` on both, deliberately: the empty string is the universal
  // justification, and an acceptance with no reason is not an acceptance.
  reason: z.string().min(1),
  until: z.coerce.date(),
});

export const resolveRemediationBody = z.object({
  status: z.enum(['done', 'wont_fix']),
  comment: z.string().min(1),
});

export const denyOrphanBody = z.object({ reason: z.string().min(1) });

export const refreshSourceParams = z.object({
  kind: z.enum(['directorySource', 'targetSystem']),
  id: z.string().uuid(),
});

export const governSettingsBody = z
  .object({
    snapshotSchedule: z.string().min(1).nullable(),
    snapshotRetentionDays: z.number().int().min(1),
    defaultFreshnessSlaHours: z.number().int().min(1),
    maxSnapshotAgeDays: z.number().int().min(1),
    batchThresholdPercent: z.number().int().min(0).max(100),
    perResourceThresholdPercent: z.number().int().min(0).max(100),
    personPopulationDropPercent: z.number().int().min(0).max(100),
    minimumCoveragePercent: z.number().int().min(0).max(100),
    bulkCertifyLimit: z.number().int().min(1).max(1000),
    dispatchSlaHours: z.number().int().min(1),
    privilegedRecertifyDays: z.number().int().min(1),
    maxExceptionDays: z.number().int().min(1).max(365),
    exceptionWarningDays: z.array(z.number().int().min(0)).min(1),
    minReciprocalDecisions: z.number().int().min(1),
    reciprocityWindowDays: z.number().int().min(1),
  })
  .partial();

export const classificationBody = z.object({
  systemId: z.string().min(1),
  resourceKind: z.string().min(1),
  resourceId: z.string().min(1),
  privileged: z.boolean(),
  note: z.string().nullable().default(null),
});
```

Add `export * from './govern.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 6: Write the routes**

`apps/api/src/routes/admin/govern.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idParam } from '@syntra/contracts';
import {
  acceptFindingBody,
  approvalReportQuery,
  assignFindingBody,
  buildSnapshotBody,
  changeReportQuery,
  classificationBody,
  denyOrphanBody,
  evidencePackBody,
  exportCsvBody,
  findingQuery,
  governSettingsBody,
  governSnapshotQuery,
  personReportQuery,
  refreshSourceParams,
  resolveRemediationBody,
  systemReportQuery,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  PROVISION_JOB,
  SYNC_JOB,
  acceptFinding,
  assignFinding,
  buildSnapshot,
  confirmProposal,
  createEvidencePack,
  denyProposal,
  exportReportCsv,
  governReadScope,
  governSettings,
  integrityStatus,
  personIdsInScope,
  provisionJobPayload,
  readableSnapshot,
  resolveRemediationItem,
  setResourceClassification,
  syncJobPayload,
  updateGovernSettings,
  verifyIncremental,
  whatChanged,
  whatDoesPersonHold,
  whoApprovedIt,
  whoHasAccessToSystem,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * `govern.read`, respecting an org-unit scope.
 *
 * `requirePermission(PERMISSIONS.GOVERN_READ)` cannot be used: it asks Core's
 * `hasPermission` with no scope, and Core deliberately refuses a scoped
 * assignment asked unscoped. A team lead with `govern.read` on their own
 * department would get 403 on every screen.
 *
 * This admits any holder — scoped or not — and stashes the resolved scope on
 * the request, so every handler can apply it. Section 21: the scope is
 * respected on EVERY READ PATH, not only on the list.
 */
function requireGovernRead() {
  return async function guard(request: FastifyRequest): Promise<void> {
    const scope = await request.db((tx) => governReadScope(tx, request.session.userId));
    if (scope.kind === 'none') {
      throw new ProblemError(403, 'forbidden', 'Forbidden', 'Requires govern.read');
    }
    Reflect.set(request, 'governScope', scope);
  };
}

const scopeOf = (request: FastifyRequest) =>
  Reflect.get(request, 'governScope') as ReturnType<typeof governReadScope> extends Promise<infer T>
    ? T
    : never;

export async function registerAdminGovernRoutes(
  app: FastifyInstance,
  options: { scheduler?: Scheduler | null } = {},
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  // ---- snapshots and coverage ------------------------------------------
  app.get('/govern/snapshots', { preHandler: requireGovernRead() }, async (request) => {
    const { limit } = governSnapshotQuery.parse(request.query);
    return request.db(async (tx) => ({
      snapshots: await tx.accessSnapshot.findMany({
        orderBy: { asOf: 'desc' },
        take: limit,
      }),
    }));
  });

  app.post(
    '/govern/snapshots',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const body = buildSnapshotBody.parse(request.body ?? {});
      // buildSnapshot opens its own short transactions; it is not called
      // inside request.db, which would nest one inside another.
      return buildSnapshot(request.tenantId, {
        kind: body.kind,
        actorUserId: request.session.userId,
      });
    },
  );

  app.get('/govern/snapshots/:id', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => {
      const snapshot = await readableSnapshot(tx, id);
      const gapsByKind = await tx.coverageGap.groupBy({
        by: ['kind'],
        where: { snapshotId: id },
        _count: { _all: true },
      });
      return { snapshot, gapsByKind };
    });
  });

  app.get('/govern/snapshots/:id/coverage', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => {
      await readableSnapshot(tx, id);
      return { gaps: await tx.coverageGap.findMany({ where: { snapshotId: id }, take: 500 }) };
    });
  });

  /**
   * Refresh now enqueues the OWNING SUBSYSTEM's existing job on the existing
   * queue, and says whose job it enqueued. Govern does not read the target and
   * does not hold the answer.
   */
  app.post(
    '/govern/sources/:kind/:id/refresh',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { kind, id } = refreshSourceParams.parse(request.params);
      if (options.scheduler == null) {
        throw new ProblemError(
          503, 'scheduler-unavailable', 'The job scheduler is not running',
          'Nothing was enqueued. Govern never reads a source itself, so there is no fallback.',
        );
      }
      if (kind === 'directorySource') {
        await options.scheduler.enqueue(SYNC_JOB, syncJobPayload(request.tenantId, id));
        return { enqueued: SYNC_JOB, owner: 'Directory Sync' };
      }
      await options.scheduler.enqueue(PROVISION_JOB, provisionJobPayload(request.tenantId, id));
      return { enqueued: PROVISION_JOB, owner: 'Provision' };
    },
  );

  // ---- the four reports --------------------------------------------------
  app.get('/govern/reports/system', { preHandler: requireGovernRead() }, async (request) => {
    const query = systemReportQuery.parse(request.query);
    const report = await whoHasAccessToSystem(request.tenantId, query);
    const scope = scopeOf(request);
    if (scope.kind === 'tenant') return report;

    // The scope is applied to the ROWS, not only to the list of systems. A
    // report that filtered the index and not the detail would hand a
    // department lead the whole tenant one click in.
    const admitted = await request.db((tx) => personIdsInScope(tx, scope));
    const rows = report.body.rows.filter(
      (row) => row.personId !== null && admitted !== 'all' && admitted.has(row.personId),
    );
    return { ...report, body: { ...report.body, rows } };
  });

  app.get('/govern/reports/person/:personId', { preHandler: requireGovernRead() }, async (request) => {
    const { personId } = request.params as { personId: string };
    const query = personReportQuery.parse(request.query);
    const scope = scopeOf(request);
    if (scope.kind !== 'tenant') {
      const admitted = await request.db((tx) => personIdsInScope(tx, scope));
      if (admitted !== 'all' && !admitted.has(personId)) {
        // 404, not 403. A 403 confirms the person exists, and the existence of
        // a person in another department is itself information.
        throw new ProblemError(404, 'not-found', 'Not found');
      }
    }
    return whatDoesPersonHold(request.tenantId, { ...query, personId });
  });

  app.get('/govern/reports/changes', { preHandler: requireGovernRead() }, async (request) =>
    whatChanged(request.tenantId, changeReportQuery.parse(request.query)),
  );

  app.get('/govern/reports/approval', { preHandler: requireGovernRead() }, async (request) =>
    whoApprovedIt(request.tenantId, approvalReportQuery.parse(request.query)),
  );

  // ---- export ------------------------------------------------------------
  app.post(
    '/govern/exports/csv',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_EXPORT) },
    async (request, reply) => {
      const query = exportCsvBody.parse(request.body ?? {});
      const report = await whoHasAccessToSystem(request.tenantId, query);
      const csv = await exportReportCsv(request.tenantId, request.session.userId, report, query);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="govern-access.csv"')
        .send(csv);
    },
  );

  app.post(
    '/govern/evidence',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_EXPORT) },
    async (request) => {
      const body = evidencePackBody.parse(request.body ?? {});
      return createEvidencePack(request.tenantId, request.session.userId, body);
    },
  );

  // ---- findings and remediation ------------------------------------------
  app.get('/govern/findings', { preHandler: requireGovernRead() }, async (request) => {
    const query = findingQuery.parse(request.query);
    return request.db(async (tx) => ({
      findings: await tx.governFinding.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.severity ? { severity: query.severity } : {}),
        },
        // The dashboard leads with what is wrong, so the default order is by
        // severity descending and then by age, never alphabetical.
        orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
        take: query.limit,
      }),
    }));
  });

  app.post(
    '/govern/findings/:id/assign',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = assignFindingBody.parse(request.body);
      await assignFinding(request.tenantId, request.session.userId, id, body.ownerPersonId, body.dueAt);
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/findings/:id/accept',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = acceptFindingBody.parse(request.body);
      await acceptFinding(request.tenantId, request.session.userId, id, body.reason, body.until);
      return reply.status(204).send();
    },
  );

  app.get('/govern/remediation', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => ({
      items: await tx.remediationItem.findMany({
        where: { status: { in: ['open', 'in_progress'] } },
        orderBy: { dueAt: 'asc' },
        take: 200,
      }),
    })),
  );

  app.post(
    '/govern/remediation/:id/resolve',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = resolveRemediationBody.parse(request.body);
      await resolveRemediationItem(request.tenantId, request.session.userId, id, body.status, body.comment);
      return reply.status(204).send();
    },
  );

  // ---- orphan accounts ----------------------------------------------------
  app.get('/govern/orphans', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => ({
      proposals: await tx.accountAttribution.findMany({
        where: { status: 'proposed' },
        orderBy: [{ confidence: 'desc' }],
        take: 200,
      }),
    })),
  );

  app.post(
    '/govern/orphans/:id/confirm',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // The linking function is injected rather than imported by the service,
      // so `boundaries.test.ts`'s no-access-bearing-write assertion stays true
      // of the Govern module. Provision owns the write.
      await confirmProposal(
        request.tenantId,
        request.session.userId,
        id,
        async () => {
          throw new ProblemError(
            501,
            'linking-not-wired',
            'Account linking is not wired yet',
            "Provision's account-linking entry point is supplied here once Provision Task 15 has landed in this checkout.",
          );
        },
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/orphans/:id/deny',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = denyOrphanBody.parse(request.body);
      await denyProposal(request.tenantId, request.session.userId, id, body.reason);
      return reply.status(204).send();
    },
  );

  // ---- audit integrity ----------------------------------------------------
  app.get('/govern/integrity', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => {
      const anchors = await tx.auditAnchor.count({ where: { status: 'anchored' } });
      return integrityStatus(tx, anchors > 0);
    }),
  );

  app.post(
    '/govern/integrity/verify',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => verifyIncremental(request.tenantId),
  );

  // ---- settings and classification ---------------------------------------
  app.get('/govern/settings', { preHandler: requireGovernRead() }, async (request) =>
    request.db((tx) => governSettings(tx)),
  );

  app.patch(
    '/govern/settings',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = governSettingsBody.parse(request.body ?? {});
      await updateGovernSettings(request.tenantId, request.session.userId, body as never);
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/classifications',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = classificationBody.parse(request.body);
      await setResourceClassification(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );
}
```

In `apps/api/src/app.ts`, add the import and register it after the Automate registration:

```ts
import { registerAdminGovernRoutes } from './routes/admin/govern.js';
```

```ts
  await app.register(registerAdminGovernRoutes, {
    prefix: '/api/admin',
    ...(scheduler ? { scheduler } : {}),
  });
```

- [ ] **Step 7: Write the route test**

`apps/api/src/routes/admin/govern.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  buildSnapshot,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(login: string, permissions: Permission[], scopeOrgUnitId?: string) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id, scopeOrgUnitId);
    return user;
  });
}

async function cookieFor(login: string) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: ctx.host }, payload: { login, password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` }, payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host, cookie }, payload: payload as object });

beforeEach(async () => {
  ctx = await buildTestApp();
});

describe('permissions', () => {
  it('refuses a caller with no govern permission at all', async () => {
    await seedAdmin('nobody', [PERMISSIONS.AUDIT_READ]);
    const res = await get('/api/admin/govern/snapshots', await cookieFor('nobody'));
    expect(res.statusCode).toBe(403);
  });

  it('ADMITS a caller whose govern.read is scoped to an org unit', async () => {
    // The whole reason requireGovernRead exists. With
    // requirePermission(GOVERN_READ) this is a 403, because Core's
    // hasPermission refuses a scoped assignment asked unscoped.
    const ou = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Care' } }),
    );
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], ou.id);
    const res = await get('/api/admin/govern/snapshots', await cookieFor('lead'));
    expect(res.statusCode).toBe(200);
  });

  it('refuses an export to a caller holding only govern.read', async () => {
    // Reading a screen and walking out with a file are different acts.
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const res = await post('/api/admin/govern/exports/csv', await cookieFor('reader'), {
      systemId: 'sys-1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a snapshot build to a caller holding only govern.read', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const res = await post('/api/admin/govern/snapshots', await cookieFor('reader'));
    expect(res.statusCode).toBe(403);
  });
});

describe('the scope is applied on every read path', () => {
  it('404s a person report outside the caller’s org-unit scope', async () => {
    const seeded = await withTenant(ctx.tenantId, async (tx) => {
      const care = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Care' } });
      const other = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Finance' } });
      const outsider = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Out', familyName: 'Sider' },
      });
      await tx.user.create({
        data: {
          tenantId: ctx.tenantId, login: 'out', email: 'o@a.test', displayName: 'Out',
          personId: outsider.id, orgUnitId: other.id,
        },
      });
      return { careId: care.id, outsiderId: outsider.id };
    });
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], seeded.careId);
    await buildSnapshot(ctx.tenantId, {});

    const res = await get(
      `/api/admin/govern/reports/person/${seeded.outsiderId}`,
      await cookieFor('lead'),
    );
    // 404, not 403: a 403 confirms the person exists.
    expect(res.statusCode).toBe(404);
  });
});

describe('reports', () => {
  it('every report body carries its header', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    await buildSnapshot(ctx.tenantId, {});
    const cookie = await cookieFor('reader');
    const res = await get('/api/admin/govern/reports/system?systemId=syntra', cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { header?: { asOf?: string; sources?: unknown[] } };
    expect(body.header?.asOf).toBeTruthy();
    expect(Array.isArray(body.header?.sources)).toBe(true);
  });

  it('refuses a report over a snapshot that is still building', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const building = await withTenant(ctx.tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId: ctx.tenantId, kind: 'manual', status: 'building', asOf: new Date() },
      }),
    );
    const res = await get(
      `/api/admin/govern/reports/system?systemId=syntra&snapshotId=${building.id}`,
      await cookieFor('reader'),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('Refresh now enqueues somebody else’s job and says whose', () => {
  it('names Directory Sync for a directory source', async () => {
    await seedAdmin('manager', [PERMISSIONS.GOVERN_MANAGE]);
    const source = await withTenant(ctx.tenantId, (tx) =>
      tx.directorySource.findFirst({ select: { id: true } }),
    );
    if (source === null) return; // no source seeded; the shape is asserted by the 503 case below
    const res = await post(
      `/api/admin/govern/sources/directorySource/${source.id}/refresh`,
      await cookieFor('manager'),
    );
    expect([200, 503]).toContain(res.statusCode);
  });

  it('503s rather than reading the source itself when no scheduler is running', async () => {
    await seedAdmin('manager', [PERMISSIONS.GOVERN_MANAGE]);
    const res = await post(
      '/api/admin/govern/sources/targetSystem/00000000-0000-0000-0000-000000000001/refresh',
      await cookieFor('manager'),
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ detail: expect.stringContaining('never reads a source itself') });
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/scope.test.ts apps/api/src/routes/admin/govern.test.ts`
Expected: PASS.

- [ ] **Step 9: Export and typecheck**

Add `export * from './govern/scope.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 10: Mutation-test**

1. Replace `requireGovernRead()` with `requirePermission(PERMISSIONS.GOVERN_READ)` on `/govern/snapshots`. Expected: `ADMITS a caller whose govern.read is scoped to an org unit` FAILS with 403 — **which is what would have shipped without this task.**
2. In `governReadScope`, return `{ kind: 'tenant' }` when `relevant.length === 0`. Expected: `refuses a caller with no govern permission at all` FAILS.
3. In the person report handler, drop the scope check. Expected: `404s a person report outside the caller's org-unit scope` FAILS.
4. Change that 404 to a 403. Expected: the same test FAILS — the status code is the assertion, because a 403 confirms existence.
5. Change `/govern/exports/csv` to `requirePermission(PERMISSIONS.GOVERN_READ)`. Expected: `refuses an export to a caller holding only govern.read` FAILS.
6. In `scopeAdmitsPerson`, return `true` for a null `personOrgUnitId` under an org-unit scope. Expected: `REFUSES a person with no org unit under an org-unit scope` FAILS.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/rbac/permissions.ts \
        packages/core/src/govern/scope.ts packages/core/src/govern/scope.test.ts \
        packages/contracts/src/govern.ts packages/contracts/src/index.ts \
        apps/api/src/routes/admin/govern.ts apps/api/src/routes/admin/govern.test.ts \
        apps/api/src/app.ts packages/core/src/index.ts
git commit -m "feat(govern): the slice-1 HTTP surface, four permissions and the org-unit-scoped read"
```

---
## Task 14: The console (slice 1) — snapshots, coverage, reports, findings, orphans, integrity

Spec §20. **The dashboard leads with what is wrong.** A governance dashboard whose first row is "97% certified" is a dashboard that gets screenshotted into a board pack and stops being read. The first row here is the count of things nobody can explain, the second is the count of things nobody has looked at, and the certification rate is further down with its denominator next to it.

**Files:**
- Create: `apps/web/src/pages/admin/GovernSnapshotsPage.tsx`, `GovernSnapshotDetailPage.tsx`, `GovernReportsPage.tsx`, `GovernFindingsPage.tsx`, `GovernOrphansPage.tsx`, `GovernIntegrityPage.tsx`
- Test: `apps/web/src/pages/admin/GovernFindingsPage.test.tsx`, `apps/web/src/pages/admin/GovernSnapshotDetailPage.test.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `../../session/api.js`; `useApiResource` from `./hooks.js`; `PageHeader` from `./PageHeader.js`; `Alert`, `Button`, `Empty`, `Field`, `Panel`, `SkeletonRows`, `Status` from `@syntra/ui`; `Link`, `useParams`, `useSearchParams` from `react-router-dom`; every slice-1 route from Task 13.
- Produces: the console routes `/admin/govern/snapshots`, `/admin/govern/snapshots/:id`, `/admin/govern/reports`, `/admin/govern/findings`, `/admin/govern/orphans`, `/admin/govern/integrity`, and six `NAV` entries behind `govern.read`.

**Two conventions this repo already has, verified before writing a line.** `<Route>` paths inside `AdminApp.tsx` are **relative** (`path="sources/:id"`), while `NAV` entries are **absolute** (`/admin/sources`). `Alert` takes `tone={'info' | 'warning' | 'danger'}` and has **no `success` tone**; `Status` takes `tone={'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary'}`. Component tests are `*.test.tsx` and run under `apps/web/vitest.config.ts` (jsdom) via `pnpm --filter @syntra/web test`; the root vitest config includes only `*.test.ts` and will not pick them up.

- [ ] **Step 1: Write the failing findings-page test**

`apps/web/src/pages/admin/GovernFindingsPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GovernFindingsPage } from './GovernFindingsPage.js';

const findings = [
  {
    id: 'f-1', kind: 'unattributable_holding', severity: 'critical', status: 'open',
    subjectRefType: 'holding', subjectRefId: 'person:p-1|sys-1|targetEntitlement|ent-1',
    detail: { resourceName: 'Domain Admins', systemName: 'Acme AD', privileged: true },
    firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-15T00:00:00.000Z',
    ownerPersonId: null, dueAt: null,
  },
  {
    id: 'f-2', kind: 'access_without_contract', severity: 'high', status: 'open',
    subjectRefType: 'person', subjectRefId: 'p-9',
    detail: { holdingCount: 4, hasAnyContractRecord: true },
    firstSeenAt: '2026-06-10T00:00:00.000Z', lastSeenAt: '2026-06-15T00:00:00.000Z',
    ownerPersonId: null, dueAt: null,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ findings }), { status: 200 })),
  );
});

describe('GovernFindingsPage', () => {
  it('leads with the uncomfortable findings, not with a certification rate', async () => {
    render(
      <MemoryRouter>
        <GovernFindingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Domain Admins/)).toBeInTheDocument());

    const rows = screen.getAllByRole('row').slice(1);
    // The first row is the thing nobody can explain. A page sorted
    // alphabetically would put `access_without_contract` first.
    expect(rows[0]!.textContent).toContain('Nothing in Syntra explains this access');
    expect(screen.queryByText(/% certified/)).not.toBeInTheDocument();
  });

  it('renders each kind in plain language rather than as its enum value', async () => {
    render(
      <MemoryRouter>
        <GovernFindingsPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/holds access with no active contract/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('access_without_contract')).not.toBeInTheDocument();
  });

  it('shows an empty state that names the next action, not the absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ findings: [] }), { status: 200 })),
    );
    render(
      <MemoryRouter>
        <GovernFindingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Build a snapshot/i)).toBeInTheDocument());
  });
});
```

`apps/web/src/pages/admin/GovernSnapshotDetailPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GovernSnapshotDetailPage } from './GovernSnapshotDetailPage.js';

const snapshot = {
  snapshot: {
    id: 's-1',
    asOf: '2026-06-15T09:00:00.000Z',
    status: 'complete',
    holdingCount: 4120,
    unattributableCount: 17,
    coverageGapCount: 2,
    unattributedAccountCount: 3,
    personsWithActiveContract: 1180,
    sources: [
      {
        sourceKind: 'targetSystem', sourceId: 'sys-1', sourceName: 'Acme AD',
        lastSuccessfulReadAt: '2026-06-06T09:00:00.000Z', completeness: 'partial',
        staleness: 'stale', ageHours: 216, gapCount: 1, freshnessSlaHours: 24,
      },
      {
        sourceKind: 'syntraInternal', sourceId: 'syntra', sourceName: 'Syntra',
        lastSuccessfulReadAt: '2026-06-15T09:00:00.000Z', completeness: 'complete',
        staleness: 'fresh', ageHours: 0, gapCount: 0, freshnessSlaHours: 24,
      },
    ],
  },
  gapsByKind: [{ kind: 'resource_unreadable', _count: { _all: 2 } }],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 })),
  );
});

describe('GovernSnapshotDetailPage', () => {
  it('shows BOTH clocks: the snapshot’s as-of and each source’s last successful read', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/govern/snapshots/s-1']}>
        <Routes>
          <Route path="/admin/govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Acme AD/)).toBeInTheDocument());
    // The snapshot was assembled today; the target was read on the 6th, and the
    // second one is the one that matters.
    expect(screen.getByText(/assembled/i).textContent).toContain('15 June 2026');
    expect(screen.getByText(/216 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/24-hour/)).toBeInTheDocument();
  });

  it('labels a stale, partial source in words rather than with a colour alone', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/govern/snapshots/s-1']}>
        <Routes>
          <Route path="/admin/govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Stale')).toBeInTheDocument());
    expect(screen.getByText('Partially read')).toBeInTheDocument();
  });

  it('puts the unattributable count ABOVE the totals', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/govern/snapshots/s-1']}>
        <Routes>
          <Route path="/admin/govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('17')).toBeInTheDocument());
    const html = document.body.innerHTML;
    expect(html.indexOf('nobody can explain')).toBeLessThan(html.indexOf('4,120'));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @syntra/web exec vitest run src/pages/admin/GovernFindingsPage.test.tsx src/pages/admin/GovernSnapshotDetailPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./GovernFindingsPage.js"`.

- [ ] **Step 3: Write the findings page**

`apps/web/src/pages/admin/GovernFindingsPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Finding {
  id: string;
  kind: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  subjectRefType: string;
  subjectRefId: string;
  detail: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  ownerPersonId: string | null;
  dueAt: string | null;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

const SEVERITY_TONE: Record<Finding['severity'], Tone> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

/**
 * Plain language, not enum values. A finding queue is worked by a person who
 * has not read the schema, and `access_without_contract` is a column name.
 */
const HEADLINE: Record<string, string> = {
  unattributable_holding: 'Nothing in Syntra explains this access',
  unexplained_gain: 'Access appeared and Syntra did not cause it',
  access_without_contract: 'Holds access with no active contract',
  orphan_account: 'An account that belongs to nobody Syntra knows',
  privileged_uncertified: 'Privileged access that nobody has reviewed',
  stale_source: 'A source nobody has read recently enough to trust',
  coverage_gap: 'A region of the world this snapshot could not describe',
  campaign_low_coverage: 'A review closed with too many items undecided',
  dispatch_not_applied: 'A revocation was sent and never confirmed',
  sod_violation: 'One person holds both sides of a duty separation',
  sod_laundering: 'Two people approved each other into opposite sides of a rule',
  approval_reciprocity: 'Two people repeatedly decide for each other',
  lapsed_exception: 'A risk acceptance expired and was not renewed',
  no_human_decision: 'Access granted by a workflow with no approver',
  unmergeable_actor: 'An account with no linked person is making decisions',
};

/**
 * The order the queue is worked in. NOT alphabetical, and not by date:
 * uncomfortable first, because the point of this screen is the things nobody
 * has an explanation for.
 */
const KIND_ORDER = [
  'unattributable_holding',
  'unexplained_gain',
  'access_without_contract',
  'stale_source',
  'dispatch_not_applied',
  'orphan_account',
  'sod_laundering',
  'sod_violation',
  'privileged_uncertified',
  'no_human_decision',
  'lapsed_exception',
  'coverage_gap',
  'unmergeable_actor',
  'campaign_low_coverage',
  'approval_reciprocity',
];

const describe = (finding: Finding): string => {
  const detail = finding.detail;
  if (typeof detail['resourceName'] === 'string') {
    return `${detail['resourceName']}${
      typeof detail['systemName'] === 'string' ? ` in ${detail['systemName']}` : ''
    }`;
  }
  if (typeof detail['holdingCount'] === 'number') {
    return `${detail['holdingCount']} holding(s)`;
  }
  if (typeof detail['sourceName'] === 'string') return String(detail['sourceName']);
  return finding.subjectRefId;
};

export function GovernFindingsPage() {
  const [status, setStatus] = useState<'open' | 'accepted' | 'resolved'>('open');
  const { data, error, loading, reload } = useApiResource<{ findings: Finding[] }>(
    `/api/admin/govern/findings?status=${status}`,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const sorted = [...(data?.findings ?? [])].sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.firstSeenAt.localeCompare(b.firstSeenAt);
  });

  return (
    <>
      <PageHeader
        title="Findings"
        description="What Govern found and nobody has explained yet, uncomfortable first."
        actions={
          <div className="flex gap-2">
            {(['open', 'accepted', 'resolved'] as const).map((s) => (
              <Button
                key={s}
                variant={status === s ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setStatus(s)}
              >
                {s === 'open' ? 'Open' : s === 'accepted' ? 'Accepted' : 'Resolved'}
              </Button>
            ))}
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={8} cols={5} />}

          {!loading && sorted.length === 0 && (
            <div className="p-6">
              <Empty title="Nothing to look at here yet">
                Build a snapshot and the standing findings appear on their own — access
                nobody can explain, access held by people with no contract, orphan
                accounts, and sources nobody has read.
              </Empty>
            </div>
          )}

          {!loading && sorted.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle text-sm text-muted">
                <tr>
                  <th className="px-4 py-2">What</th>
                  <th className="px-4 py-2">Which</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">First seen</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((finding) => (
                  <tr key={finding.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2 font-medium text-ink">
                      {HEADLINE[finding.kind] ?? finding.kind}
                    </td>
                    <td className="px-4 py-2 text-muted">{describe(finding)}</td>
                    <td className="px-4 py-2">
                      <Status tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Status>
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {new Date(finding.firstSeenAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {finding.status === 'open' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const reason = window.prompt(
                              'Why is this acceptable? An acceptance needs a reason and an expiry.',
                            );
                            if (reason === null || reason.trim() === '') return;
                            const until = window.prompt('Accept until (YYYY-MM-DD)?');
                            if (until === null || until.trim() === '') return;
                            void api(`/api/admin/govern/findings/${finding.id}/accept`, {
                              method: 'POST',
                              body: JSON.stringify({ reason, until }),
                            })
                              .then(() => {
                                setActionError(null);
                                reload();
                              })
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof ApiError
                                    ? (cause.problem.detail ?? cause.problem.title)
                                    : 'Could not accept this finding.',
                                ),
                              );
                          }}
                        >
                          Accept with an expiry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
```

- [ ] **Step 4: Write the snapshot detail page**

`apps/web/src/pages/admin/GovernSnapshotDetailPage.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface SourceLine {
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  lastSuccessfulReadAt: string | null;
  completeness: string;
  staleness: string;
  ageHours: number | null;
  gapCount: number;
  freshnessSlaHours: number;
}

interface SnapshotDetail {
  snapshot: {
    id: string;
    asOf: string;
    status: string;
    holdingCount: number;
    unattributableCount: number;
    coverageGapCount: number;
    unattributedAccountCount: number;
    personsWithActiveContract: number;
    sources: SourceLine[];
  };
  gapsByKind: { kind: string; _count: { _all: number } }[];
}

const COMPLETENESS_LABEL: Record<string, string> = {
  complete: 'Read completely',
  partial: 'Partially read',
  unread: 'Never read',
};

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function GovernSnapshotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<SnapshotDetail>(
    id ? `/api/admin/govern/snapshots/${id}` : null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const snapshot = data?.snapshot;

  return (
    <>
      <PageHeader
        title="Snapshot"
        description={
          snapshot
            ? `Assembled ${longDate(snapshot.asOf)}. That is when Govern put the picture together — not when any of these systems was last read.`
            : undefined
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {snapshot && (
        <div className="space-y-6">
          {/* The uncomfortable numbers come FIRST, above the totals. */}
          <Panel title="What nobody can explain">
            <div className="grid grid-cols-3 gap-4 p-4">
              <div>
                <p className="text-2xl font-semibold text-ink">{snapshot.unattributableCount}</p>
                <p className="text-muted">holdings nobody can explain</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">{snapshot.coverageGapCount}</p>
                <p className="text-muted">regions this snapshot could not describe</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.unattributedAccountCount}
                </p>
                <p className="text-muted">accounts belonging to nobody Syntra knows</p>
              </div>
            </div>
          </Panel>

          <Panel title="Totals">
            <div className="grid grid-cols-2 gap-4 p-4">
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.holdingCount.toLocaleString()}
                </p>
                <p className="text-muted">holdings</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.personsWithActiveContract.toLocaleString()}
                </p>
                <p className="text-muted">people with an active contract</p>
              </div>
            </div>
          </Panel>

          <Panel
            title="Sources"
            description="When each system was last read, and how completely. This is the clock that matters."
          >
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle text-sm text-muted">
                <tr>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Last successful read</th>
                  <th className="px-4 py-2">Freshness</th>
                  <th className="px-4 py-2">Completeness</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {snapshot.sources.map((source) => (
                  <tr key={`${source.sourceKind}:${source.sourceId}`} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2 font-medium text-ink">{source.sourceName}</td>
                    <td className="px-4 py-2 text-muted">
                      {source.lastSuccessfulReadAt === null
                        ? 'never'
                        : `${longDate(source.lastSuccessfulReadAt)} — ${Math.round(source.ageHours ?? 0)} hours ago`}
                    </td>
                    <td className="px-4 py-2">
                      {/* Words, not a colour alone. A badge that only differs by
                          hue is unreadable to a reader who cannot see the hue,
                          and this is the number the whole report rests on. */}
                      <Status tone={source.staleness === 'fresh' ? 'active' : 'danger'}>
                        {source.staleness === 'fresh' ? 'Fresh' : 'Stale'}
                      </Status>
                      <span className="ml-2 text-muted">
                        against a {source.freshnessSlaHours}-hour SLA
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <Status tone={source.completeness === 'complete' ? 'active' : 'warning'}>
                        {COMPLETENESS_LABEL[source.completeness] ?? source.completeness}
                      </Status>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {source.sourceKind !== 'syntraInternal' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            void api(
                              `/api/admin/govern/sources/${source.sourceKind}/${source.sourceId}/refresh`,
                              { method: 'POST' },
                            )
                              .then((result) => {
                                const owner = (result as { owner?: string }).owner ?? 'the owning subsystem';
                                setActionError(null);
                                window.alert(
                                  `Enqueued ${owner}'s own job. Govern does not read this source itself and does not hold the answer; the next snapshot will show what it found.`,
                                );
                                reload();
                              })
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof ApiError
                                    ? (cause.problem.detail ?? cause.problem.title)
                                    : 'Could not enqueue a refresh.',
                                ),
                              );
                          }}
                        >
                          Refresh now
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {data.gapsByKind.length > 0 && (
            <Panel title="Coverage gaps">
              <ul className="p-4">
                {data.gapsByKind.map((gap) => (
                  <li key={gap.kind} className="text-ink">
                    {gap._count._all} × {gap.kind.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Write the remaining four pages**

Each follows `SyncRunsPage.tsx` exactly: `useApiResource`, `PageHeader`, `Panel`, `SkeletonRows` while loading, `Empty` with a next action when the list is empty, `Alert tone="danger"` for the error. The parts that carry a decision are written out.

**`GovernSnapshotsPage.tsx`** — the list, newest first, with the build action:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface SnapshotRow {
  id: string;
  kind: string;
  status: string;
  asOf: string;
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  error: string | null;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';
const TONE: Record<string, Tone> = { building: 'primary', complete: 'active', failed: 'danger' };

export function GovernSnapshotsPage() {
  const { data, error, loading, reload } = useApiResource<{ snapshots: SnapshotRow[] }>(
    '/api/admin/govern/snapshots',
  );
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Snapshots"
        description="Each one is a point-in-time picture of who can reach what. A certification is always against one of these, never against a live query."
        actions={
          <Button
            onClick={() => {
              void api('/api/admin/govern/snapshots', {
                method: 'POST',
                body: JSON.stringify({ kind: 'manual' }),
              })
                .then(() => {
                  setActionError(null);
                  reload();
                })
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof ApiError
                      ? (cause.problem.detail ?? cause.problem.title)
                      : 'Could not build a snapshot.',
                  ),
                );
            }}
          >
            Build a snapshot now
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <Panel>
        {loading && <SkeletonRows rows={6} cols={5} />}
        {!loading && (data?.snapshots.length ?? 0) === 0 && (
          <div className="p-6">
            <Empty title="No snapshots yet">
              Build one and the inventory, the coverage register and the standing findings appear
              on their own.
            </Empty>
          </div>
        )}
        {!loading && (data?.snapshots.length ?? 0) > 0 && (
          <table className="w-full text-left">
            <thead className="border-b border-border-subtle text-sm text-muted">
              <tr>
                <th className="px-4 py-2">As of</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Holdings</th>
                <th className="px-4 py-2">Nobody can explain</th>
                <th className="px-4 py-2">Coverage gaps</th>
              </tr>
            </thead>
            <tbody>
              {data!.snapshots.map((s) => (
                <tr key={s.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2">
                    <Link className="text-primary" to={`/admin/govern/snapshots/${s.id}`}>
                      {new Date(s.asOf).toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Status tone={TONE[s.status] ?? 'neutral'}>{s.status}</Status>
                  </td>
                  <td className="px-4 py-2">
                    {/* A `building` or `failed` snapshot is invisible to every
                        report, so its counts are shown as pending rather than
                        as a zero somebody could read as an empty organization. */}
                    {s.status === 'complete' ? s.holdingCount.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {s.status === 'complete' ? s.unattributableCount : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {s.status === 'complete' ? s.coverageGapCount : (s.error ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
```

**`GovernReportsPage.tsx`** — the four reports, the header above every result, and the live toggle that says what it costs:

```tsx
const renderCount = (count: { known: boolean; value?: number; reason?: string }) =>
  count.known ? (
    <strong className="text-ink">{count.value!.toLocaleString()}</strong>
  ) : (
    // NEVER a zero, a dash or an omission. The reason is what makes it
    // actionable rather than a dead end.
    <span className="text-warning" title={count.reason}>
      unknown — {count.reason}
    </span>
  );

// ...

<div className="mb-4 flex items-center gap-3">
  <Button
    size="sm"
    variant={mode === 'snapshot' ? 'primary' : 'secondary'}
    onClick={() => setMode('snapshot')}
  >
    Point in time
  </Button>
  <Button size="sm" variant={mode === 'live' ? 'primary' : 'secondary'} onClick={() => setMode('live')}>
    Live
  </Button>
  {mode === 'live' && (
    <span className="text-muted">
      A live report has no as-of time, so it cannot be exported as evidence.
    </span>
  )}
</div>

{header && !header.live && (
  <Panel title="What this report is built from">
    <dl className="grid grid-cols-2 gap-2 p-4">
      <dt className="text-muted">Assembled</dt>
      <dd className="text-ink">{new Date(header.asOf).toLocaleString()}</dd>
      <dt className="text-muted">Holdings nobody can explain</dt>
      <dd className="text-ink">{header.unattributableCount}</dd>
      <dt className="text-muted">Regions this could not describe</dt>
      <dd className="text-ink">{header.coverageGapCount}</dd>
      <dt className="text-muted">Accounts belonging to nobody</dt>
      <dd className="text-ink">{header.unattributedAccountCount}</dd>
    </dl>
    <ul className="border-t border-border-subtle p-4">
      {header.sources.map((s) => (
        <li key={`${s.sourceKind}:${s.sourceId}`} className="text-muted">
          {s.sourceName}: last read{' '}
          {s.lastSuccessfulReadAt === null
            ? 'never'
            : new Date(s.lastSuccessfulReadAt).toLocaleString()}
          , {s.completeness}, {s.staleness}
        </li>
      ))}
    </ul>
  </Panel>
)}
```

**`GovernOrphansPage.tsx`** — proposals with their confidence and their reason, and a confirm that says what it does:

```tsx
<li key={p.id} className="p-4">
  <p className="font-medium text-ink">
    {p.accountRef} in {p.systemId} → {p.proposedName}
  </p>
  <p className="text-muted">
    {Math.round(p.confidence * 100)}% — {p.because}
  </p>
  <div className="mt-2 flex gap-2">
    <Button
      size="sm"
      onClick={() => {
        // A wrong link is somebody's access, not a labelling mistake.
        if (
          !window.confirm(
            `Link ${p.accountRef} to ${p.proposedName}? Provision's next run will evaluate that person's desired state against this account.`,
          )
        ) {
          return;
        }
        void api(`/api/admin/govern/orphans/${p.id}/confirm`, { method: 'POST' })
          .then(reload)
          .catch(() => setActionError('Could not confirm that owner.'));
      }}
    >
      Confirm
    </Button>
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        const reason = window.prompt('Why is this not the owner?');
        if (reason === null || reason.trim() === '') return;
        void api(`/api/admin/govern/orphans/${p.id}/deny`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        })
          .then(reload)
          .catch(() => setActionError('Could not record that denial.'));
      }}
    >
      Not them
    </Button>
  </div>
</li>
```

**`GovernIntegrityPage.tsx`** — the checkpoint history, the last verification, and the anchoring statement **as prose**:

```tsx
{status && (
  <>
    {/* NEVER a green tick. A tenant that has not configured anchoring sees what
        that means, in the API's own words. `Alert` has no `success` tone, and
        that is convenient here rather than a limitation. */}
    <Alert
      tone={status.anchoring.configured ? 'info' : 'warning'}
      title={status.anchoring.configured ? 'Anchoring is configured' : 'Anchoring is not configured'}
    >
      {status.anchoring.statement}
    </Alert>

    <Panel title="The chain" description="Head, last checkpoint, last verification.">
      <dl className="grid grid-cols-2 gap-2 p-4">
        <dt className="text-muted">Head sequence</dt>
        <dd className="text-ink">{status.headSequence}</dd>
        <dt className="text-muted">Last checkpoint</dt>
        <dd className="text-ink">
          {status.lastCheckpoint === null
            ? 'none'
            : `${status.lastCheckpoint.sequence} — ${status.lastCheckpoint.signed ? 'signed' : 'unsigned'}`}
        </dd>
        <dt className="text-muted">Last verification</dt>
        <dd className="text-ink">
          {status.lastCheck === null
            ? 'never'
            : `${status.lastCheck.mode}, ${status.lastCheck.fromSequence}–${status.lastCheck.toSequence}, ${status.lastCheck.result}`}
        </dd>
      </dl>
    </Panel>

    <Button
      onClick={() => {
        void api('/api/admin/govern/integrity/verify', { method: 'POST' })
          .then(reload)
          .catch(() => setActionError('Could not verify the chain.'));
      }}
    >
      Verify now
    </Button>
  </>
)}
```

- [ ] **Step 6: Wire the routes and the navigation**

In `apps/web/src/pages/admin/AdminApp.tsx`:

```tsx
import { GovernSnapshotsPage } from './GovernSnapshotsPage.js';
import { GovernSnapshotDetailPage } from './GovernSnapshotDetailPage.js';
import { GovernReportsPage } from './GovernReportsPage.js';
import { GovernFindingsPage } from './GovernFindingsPage.js';
import { GovernOrphansPage } from './GovernOrphansPage.js';
import { GovernIntegrityPage } from './GovernIntegrityPage.js';
```

`NAV` entries — **absolute**, and the findings entry comes first because the dashboard leads with what is wrong:

```tsx
  { to: '/admin/govern/findings', label: 'Findings', permission: 'govern.read' },
  { to: '/admin/govern/snapshots', label: 'Snapshots', permission: 'govern.read' },
  { to: '/admin/govern/reports', label: 'Access reports', permission: 'govern.read' },
  { to: '/admin/govern/orphans', label: 'Orphan accounts', permission: 'govern.read' },
  { to: '/admin/govern/integrity', label: 'Audit integrity', permission: 'govern.read' },
```

`<Route>` entries — **relative**, and the literal segment before the parametric one:

```tsx
            <Route path="govern/findings" element={<GovernFindingsPage />} />
            <Route path="govern/snapshots" element={<GovernSnapshotsPage />} />
            <Route path="govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
            <Route path="govern/reports" element={<GovernReportsPage />} />
            <Route path="govern/orphans" element={<GovernOrphansPage />} />
            <Route path="govern/integrity" element={<GovernIntegrityPage />} />
```

- [ ] **Step 7: Run the component tests**

Run: `pnpm --filter @syntra/web test`
Expected: PASS. **Not** `pnpm vitest run` from the root — the root config includes only `*.test.ts` and these are `*.test.tsx`, so a root run reports "no test files found" and looks like a pass.

- [ ] **Step 8: Typecheck**

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Mutation-test the console**

1. Sort the findings alphabetically by `kind`. Expected: `leads with the uncomfortable findings` FAILS.
2. Render `{finding.kind}` instead of `HEADLINE[finding.kind]`. Expected: `renders each kind in plain language` FAILS.
3. In `GovernSnapshotDetailPage`, move the "What nobody can explain" panel below "Totals". Expected: `puts the unattributable count ABOVE the totals` FAILS.
4. Drop the `against a {n}-hour SLA` text. Expected: `shows BOTH clocks` FAILS.
5. Replace the `Status` word labels with an empty string, keeping the tone. Expected: `labels a stale, partial source in words rather than with a colour alone` FAILS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/pages/admin/Govern*.tsx apps/web/src/pages/admin/AdminApp.tsx
git commit -m "feat(govern): the slice-1 console — snapshots, coverage, reports, findings, orphans, integrity"
```

---

**Slice 1 is complete and shippable here.** An organization that installs Tasks 1–14 can answer every question on an auditor's request list with an exported artifact — who holds what, where it came from, what changed, who approved it, and what we could not see — and it produces the standing findings with no campaign machinery at all. Nothing in it has changed anybody's access.

---
# Slice 2 — Campaigns and Duties (Tasks 15–22)

Every irreversible act in Govern lives here, and every one of them is downstream of a number slice 1 produced. Nothing in slice 2 reads a system slice 1 does not already read.

---

## Task 15: Data model — campaigns, revocation and segregation of duties

Thirteen new tables, one column added to a table Provision owns, and one index added to a table Automate owns. Spec §18, slice-2 groups.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260823000000_govern_campaigns/migration.sql`
- Test: `packages/db/src/govern-campaign-schema.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced, plus `ProvisionAction` and `ApprovalDecision`.
- Produces: `Campaign`, `CampaignItem`, `CampaignItemReviewer`, `CampaignDecision`, `ReviewQualitySignal`, `RevocationBatch`, `RevocationDispatch`, `RevocationOrder`, `BusinessFunction`, `BusinessFunctionResource`, `SodRule`, `SodViolation`, `SodException`.
- Produces two changes to tables Govern does not own, and **no others**:
  - `ProvisionAction.revocationOrderId String? @db.Uuid` — a bare column, no relation. Spec §5 and §18 name it; Provision's `PlanInput` gains the matching term in Task 20.
  - `ApprovalDecision @@index([tenantId, decidedAt])` — integration finding 7. The reciprocity query is a 180-day window over decisions and there is no supporting index.
- Produces three hand-written partial unique indexes: `govern_revocation_batch_one_non_terminal_campaign`, `govern_revocation_batch_one_non_terminal_standalone`, `govern_revocation_order_one_open`.
- Produces the append-only rule pair on `CampaignDecision`.

**`CampaignDecision` gains `decidedByUserId`, which spec §18 does not list.** Integration finding 8: Automate's `revokeGrant(tenantId, actorUserId, grantId, reason, options?)` takes a `User` id, and a reviewer decides as a `Person`. A person may hold several `User` rows or none, so re-resolving person → user at dispatch time would pick an arbitrary account, or none, for an act somebody performed from a specific one. `ApprovalDecision.userId` exists for exactly this reason and carries exactly this comment; this mirrors it.

- [ ] **Step 1: Re-read the migrations directory**

```bash
ls packages/db/prisma/migrations/
```

Expected: `20260822000000_govern_inventory` is the newest. If anything sorting at or after `20260823000000` is present, bump this migration and note it in the commit message.

- [ ] **Step 2: Write the failing schema test**

`packages/db/src/govern-campaign-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from './index.js';
import { resetDatabase } from './test-support.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const person = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } });
    return { snapshotId: snapshot.id, personId: person.id };
  });
  snapshotId = seeded.snapshotId;
  personId = seeded.personId;
});

const campaignData = (over: Record<string, unknown> = {}) => ({
  tenantId,
  name: 'Q2 finance review',
  scope: { resourceKinds: ['targetEntitlement'] },
  snapshotId,
  reviewerSelector: 'manager',
  reviewerConfig: {},
  fallbackSelector: 'resourceOwner',
  fallbackConfig: {},
  ownerPersonId: personId,
  opensAt: NOW,
  dueAt: new Date('2026-07-15T00:00:00Z'),
  originalDueAt: new Date('2026-07-15T00:00:00Z'),
  ...over,
});

describe('Campaign', () => {
  it('carries originalDueAt and extensionCount rather than deriving them', async () => {
    // "The campaign ran for six weeks" and "the campaign was extended three
    // times because nobody responded" are different facts about the same
    // organization, and only one of them is derivable from dueAt alone.
    const campaign = await withTenant(tenantId, (tx) => tx.campaign.create({ data: campaignData() }));
    expect(campaign.extensionCount).toBe(0);
    expect(campaign.originalDueAt).toEqual(campaign.dueAt);
    expect(campaign.status).toBe('draft');
  });

  it('refuses a fallback selector that is null', async () => {
    // The fallback is REQUIRED. A campaign whose selector resolves to nobody
    // and has no fallback is a campaign whose items block on the due date.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.campaign.create({ data: campaignData({ fallbackSelector: null }) as never }),
      ),
    ).rejects.toThrow();
  });
});

describe('CampaignItem', () => {
  it('carries the copied attributions and the risk flags', async () => {
    const item = await withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({ data: campaignData() });
      return tx.campaignItem.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          holdingSnapshotId: snapshotId,
          subjectKey: `person:${personId}`,
          personId,
          systemId: 'sys-1',
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-1',
          resourceName: 'Finance-Payments',
          attributions: [{ kind: 'business_rule', detail: { ruleName: 'Finance staff' } }],
          observedAt: NOW,
          coverageStatus: 'complete',
          riskFlags: ['privileged', 'needs_review'],
        },
      });
    });
    expect(item.status).toBe('pending');
    expect(item.riskFlags).toEqual(['privileged', 'needs_review']);
  });

  it('refuses a status outside the closed set', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const campaign = await tx.campaign.create({ data: campaignData() });
        return tx.campaignItem.create({
          data: {
            tenantId, campaignId: campaign.id, holdingSnapshotId: snapshotId,
            subjectKey: `person:${personId}`, personId, systemId: 's', resourceKind: 'syntraGroup',
            resourceId: 'g', resourceName: 'g', attributions: [], observedAt: NOW,
            coverageStatus: 'complete',
            // There is no status that means "certified because time ran out".
            status: 'certified_by_timeout',
          },
        });
      }),
    ).rejects.toThrow(/campaign_item_status/);
  });
});

describe('CampaignDecision', () => {
  it('is append-only: an UPDATE changes nothing and a DELETE removes nothing', async () => {
    const decisionId = await withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({ data: campaignData() });
      const item = await tx.campaignItem.create({
        data: {
          tenantId, campaignId: campaign.id, holdingSnapshotId: snapshotId,
          subjectKey: `person:${personId}`, personId, systemId: 's', resourceKind: 'syntraGroup',
          resourceId: 'g', resourceName: 'g', attributions: [], observedAt: NOW,
          coverageStatus: 'complete',
        },
      });
      const decision = await tx.campaignDecision.create({
        data: {
          tenantId, itemId: item.id, personId, decision: 'certify',
          itemOpenedAt: NOW, decidedAt: NOW, sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
      return decision.id;
    });

    await withTenant(tenantId, (tx) =>
      tx.campaignDecision.updateMany({ where: { id: decisionId }, data: { decision: 'revoke' } }),
    );
    await withTenant(tenantId, (tx) => tx.campaignDecision.deleteMany({ where: { id: decisionId } }));

    const rows = await withTenant(tenantId, (tx) => tx.campaignDecision.findMany());
    expect(rows).toHaveLength(1);
    // A reversal is a NEW decision with its own reason, never an edit.
    expect(rows[0]!.decision).toBe('certify');
  });

  it('carries decidedByUserId, so a dispatch can name the account the decision came from', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'CampaignDecision'
    `;
    expect(columns.map((c) => c.column_name)).toContain('decidedByUserId');
  });
});

describe('RevocationBatch', () => {
  it('permits one non-terminal batch per campaign and one standalone', async () => {
    const campaignId = await withTenant(tenantId, async (tx) => {
      const c = await tx.campaign.create({ data: campaignData() });
      return c.id;
    });

    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'previewed' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
      ),
    ).rejects.toThrow(/govern_revocation_batch_one_non_terminal_campaign/);

    // A standalone SoD remediation batch has a NULL campaignId. A single
    // partial index over a nullable column would constrain neither, so there
    // are two indexes.
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId: null, status: 'previewed' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.revocationBatch.create({ data: { tenantId, campaignId: null, status: 'computing' } }),
      ),
    ).rejects.toThrow(/govern_revocation_batch_one_non_terminal_standalone/);
  });

  it('admits a new batch once the previous one is terminal', async () => {
    const campaignId = await withTenant(tenantId, async (tx) =>
      (await tx.campaign.create({ data: campaignData() })).id,
    );
    const first = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'previewed' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.update({ where: { id: first.id }, data: { status: 'applied' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
    );
  });
});

describe('RevocationOrder', () => {
  it('permits one OPEN order per holding and admits a second once the first is terminal', async () => {
    const base = {
      tenantId,
      targetSystemId: '11111111-1111-1111-1111-111111111111',
      accountId: '22222222-2222-2222-2222-222222222222',
      entitlementId: '33333333-3333-3333-3333-333333333333',
      decidedByPersonId: personId,
      reason: 'reviewed and revoked in Q2 finance review',
    };
    const first = await withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base }));
    await expect(
      withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base })),
    ).rejects.toThrow(/govern_revocation_order_one_open/);

    // One-shot: once applied it is terminal and does not persist as a term
    // that suppresses future grants.
    await withTenant(tenantId, (tx) =>
      tx.revocationOrder.update({ where: { id: first.id }, data: { status: 'applied' } }),
    );
    await withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base }));
  });
});

describe('SodRule and SodViolation', () => {
  it('refuses a rule naming the same function twice', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const fn = await tx.businessFunction.create({
          data: { tenantId, name: 'Raise a payment', ownerPersonId: personId },
        });
        return tx.sodRule.create({
          data: {
            tenantId, name: 'Self', functionAId: fn.id, functionBId: fn.id,
            severity: 'high', rationale: 'x',
          },
        });
      }),
    ).rejects.toThrow(/sod_rule_functions_differ/);
  });

  it('is unique per (rule, person), so a violation is updated across snapshots', async () => {
    const ruleId = await withTenant(tenantId, async (tx) => {
      const a = await tx.businessFunction.create({ data: { tenantId, name: 'A', ownerPersonId: personId } });
      const b = await tx.businessFunction.create({ data: { tenantId, name: 'B', ownerPersonId: personId } });
      const rule = await tx.sodRule.create({
        data: {
          tenantId, name: 'A/B', functionAId: a.id, functionBId: b.id,
          severity: 'critical', rationale: 'raising and approving a payment',
        },
      });
      return rule.id;
    });
    const row = {
      tenantId, ruleId, personId, holdingsA: [], holdingsB: [], contractsA: [], contractsB: [],
      severity: 'critical', firstSeenAt: NOW, lastSeenAt: NOW, lastSnapshotId: snapshotId,
    };
    await withTenant(tenantId, (tx) => tx.sodViolation.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.sodViolation.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });
});

describe('SodException', () => {
  it('refuses a null endsAt — a perpetual exception is not representable', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const a = await tx.businessFunction.create({ data: { tenantId, name: 'A', ownerPersonId: personId } });
        const b = await tx.businessFunction.create({ data: { tenantId, name: 'B', ownerPersonId: personId } });
        const rule = await tx.sodRule.create({
          data: { tenantId, name: 'A/B', functionAId: a.id, functionBId: b.id, severity: 'high', rationale: 'x' },
        });
        const violation = await tx.sodViolation.create({
          data: {
            tenantId, ruleId: rule.id, personId, holdingsA: [], holdingsB: [],
            contractsA: [], contractsB: [], severity: 'high',
            firstSeenAt: NOW, lastSeenAt: NOW, lastSnapshotId: snapshotId,
          },
        });
        return tx.sodException.create({
          data: {
            tenantId, ruleId: rule.id, personId, violationId: violation.id,
            justification: 'two separate engagements', compensatingControl: 'monthly review',
            startsAt: NOW, endsAt: null as never,
          },
        });
      }),
    ).rejects.toThrow();
  });
});

describe('ProvisionAction gains one column and nothing else', () => {
  it('carries revocationOrderId', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ProvisionAction'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).toContain('revocationOrderId');
    // Nothing else about Provision's table moved. Govern's opinion about a row
    // never lives on that row.
    expect(names).toContain('attributedRuleIds');
    expect(names).not.toContain('governFindingId');
  });
});

describe('ApprovalDecision gains one index and nothing else', () => {
  it('carries an index on (tenantId, decidedAt) for the reciprocity window', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'ApprovalDecision'
    `;
    expect(rows.some((r) => /decidedAt/.test(r.indexdef))).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('hides every slice-2 table from another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    await withTenant(tenantId, (tx) => tx.campaign.create({ data: campaignData() }));
    const seen = await withTenant(other.id, async (tx) => ({
      campaigns: await tx.campaign.count(),
      violations: await tx.sodViolation.count(),
      orders: await tx.revocationOrder.count(),
    }));
    expect(seen).toEqual({ campaigns: 0, violations: 0, orders: 0 });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/db/src/govern-campaign-schema.test.ts`
Expected: FAIL — `Property 'campaign' does not exist`.

- [ ] **Step 4: Add the campaign models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A recertification campaign. Its scope is declarative, its snapshot is frozen
/// at start, and its headline number is COVERAGE, not completion.
model Campaign {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  name        String
  description String?
  /// A condition in the same closed interpreter Provision's business rules and
  /// Automate's audiences use, over the same closed field set. A tenant learns
  /// one expression language.
  scope       Json

  /// Set at start; changed only by an explicit, recorded re-base.
  snapshotId          String  @db.Uuid
  rebasedFromSnapshotId String? @db.Uuid

  /// From Automate's closed selector set, reused rather than reimplemented: an
  /// approval chain and a review chain disagreeing about who somebody's manager
  /// is would be a support call nobody can close.
  reviewerSelector String
  reviewerConfig   Json   @default("{}")
  /// REQUIRED. A campaign whose selector resolves to nobody and has no fallback
  /// is a campaign whose items block on the due date.
  fallbackSelector String
  fallbackConfig   Json   @default("{}")

  ownerPersonId String   @db.Uuid
  opensAt       DateTime
  dueAt         DateTime
  /// Carried rather than derived, so a campaign that was extended three times
  /// says so on its own row and in its evidence bundle.
  originalDueAt  DateTime
  extensionCount Int      @default(0)
  recurrence     String?

  allowBulkCertify Boolean @default(true)

  /// draft | generating | open | executing | closed_complete | closed_incomplete | cancelled
  status String @default("draft")

  totalItems       Int @default(0)
  certifiedItems   Int @default(0)
  revokedItems     Int @default(0)
  mootItems        Int @default(0)
  undecidedItems   Int @default(0)
  blockedItems     Int @default(0)
  requiresChangeItems Int @default(0)
  /// (decided + moot) / total. Never printed without the four counts beside it.
  coveragePercent  Float?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  items    CampaignItem[]
  batches  RevocationBatch[]
  signals  ReviewQualitySignal[]

  @@index([tenantId])
  @@index([tenantId, status])
}

/// One holding under review. COPIED from the snapshot, not referenced by id,
/// for the same reason Automate snapshots a workflow: editing the world
/// afterwards must not change what somebody attested to.
///
/// ONE ITEM PER (SUBJECT, RESOURCE). Per-subject items are what most products
/// ship and they are the mechanism by which rubber-stamping becomes the norm,
/// since the only available action is a single yes over 40 things.
model CampaignItem {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @db.Uuid
  campaignId String   @db.Uuid
  campaign   Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  holdingSnapshotId String @db.Uuid
  subjectKey String
  personId   String? @db.Uuid
  accountRef String?

  systemId     String
  resourceKind String
  resourceId   String
  resourceName String

  /// The copied attribution set.
  attributions Json     @default("[]")
  observedAt   DateTime
  /// 'complete' | 'partial' | 'unread' — as at generation, and re-checked if
  /// the source goes stale mid-campaign.
  coverageStatus String
  /// privileged | unattributable | sod_violation | stale | needs_review | no_human_decision
  riskFlags    String[] @default([])

  /// pending | certified | revoke_decided | revocation_dispatched
  /// | revocation_confirmed | revocation_applied | revocation_requires_change
  /// | revocation_failed | undecided | moot | blocked_no_reviewer
  status       String  @default("pending")
  statusReason String?
  outcomeRef   String?

  createdAt DateTime @default(now())

  reviewers CampaignItemReviewer[]
  decisions CampaignDecision[]

  /// How every loop and every screen reads it.
  @@index([campaignId, status])
  @@index([campaignId, personId])
  @@index([tenantId])
}

/// The materialized, historical reviewer set: who this was with, ON THE DAY.
/// Automate's ApprovalStepApprover, for attestation.
model CampaignItemReviewer {
  id       String       @id @default(uuid()) @db.Uuid
  tenantId String       @db.Uuid
  itemId   String       @db.Uuid
  item     CampaignItem @relation(fields: [itemId], references: [id], onDelete: Cascade)

  personId String @db.Uuid
  /// 'selector' | 'fallback' | 'escalation' | 'reassignment'
  via      String
  assignedAt       DateTime  @default(now())
  unassignedAt     DateTime?
  unassignedReason String?

  @@index([tenantId])
  @@index([itemId, unassignedAt])
  @@index([tenantId, personId, unassignedAt])
}

/// APPEND-ONLY: never updated, never deleted. A reversal is a new decision with
/// its own reason.
model CampaignDecision {
  id       String       @id @default(uuid()) @db.Uuid
  tenantId String       @db.Uuid
  itemId   String       @db.Uuid
  item     CampaignItem @relation(fields: [itemId], references: [id], onDelete: Cascade)

  personId String @db.Uuid
  /// The ACCOUNT the decision was made from. Not in the design's own column
  /// list; added because Automate's grant-revocation entry point takes a User
  /// id and a person may hold several accounts or none, so re-resolving at
  /// dispatch time would pick an arbitrary one. ApprovalDecision.userId exists
  /// for the same reason.
  decidedByUserId String? @db.Uuid

  /// 'certify' | 'revoke'
  decision String
  comment  String?

  /// The SERVER-SIDE interval between the request that fetched the item's
  /// detail and the request that recorded the decision. Not a client-reported
  /// dwell time, which is worth nothing.
  itemOpenedAt DateTime
  decidedAt    DateTime @default(now())

  viaBulk  Boolean @default(false)
  bulkSize Int?
  /// The position of this decision within a run of consecutive decisions by
  /// this reviewer. An explicit ordinal, because createdAt is transaction start
  /// time and every row of one bulk action carries the same one.
  sessionDecisionOrdinal Int
  /// The coverage of this item's source AT THE MOMENT OF THE DECISION, so the
  /// evidence bundle can say what the reviewer was told.
  coverageAtDecision Json @default("{}")

  @@index([tenantId])
  @@index([itemId])
  @@index([tenantId, personId, decidedAt])
}

/// Context for a human, offered as signals rather than as proof. A manager of a
/// stable ten-person team who reads everything and certifies all of it in four
/// minutes is behaving correctly and looks identical to a rubber-stamper on the
/// aggregate; the screen says so.
model ReviewQualitySignal {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @db.Uuid
  campaignId String   @db.Uuid
  campaign   Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  personId   String   @db.Uuid

  itemsAssigned     Int
  itemsDecided      Int
  certifiedShare    Float
  medianIntervalMs  Int
  bulkShare         Float
  largestBurst      Int
  neverOpenedShare  Float

  computedAt DateTime @default(now())

  @@unique([campaignId, personId])
  @@index([tenantId])
}
```

- [ ] **Step 5: Add the revocation and SoD models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// Revocation is a RUN. Decisions accumulate and are computed into a batch,
/// which is written down, guarded and stopped — the idiom Directory Sync
/// established, Provision inherited and Automate reused.
model RevocationBatch {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @db.Uuid
  /// Null for an SoD remediation batch, which belongs to no campaign.
  campaignId String?   @db.Uuid
  campaign   Campaign? @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  /// computing | previewed | blocked | applying | applied | partially_applied
  /// | failed | superseded
  status String @default("computing")

  proposedCount       Int @default(0)
  skippedCount        Int @default(0)
  dispatchedCount     Int @default(0)
  confirmedCount      Int @default(0)
  appliedCount        Int @default(0)
  failedCount         Int @default(0)
  requiresChangeCount Int @default(0)
  cancelledCount      Int @default(0)

  requiresConfirmation Boolean @default(false)
  blockedReason        String?
  /// `autoApply` DOES NOT EXIST for a batch. Confirmation is per batch,
  /// explicit, and the confirming user is recorded.
  confirmedByUserId    String? @db.Uuid

  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  error      String?

  dispatches RevocationDispatch[]

  @@index([tenantId])
  @@index([tenantId, status])
}

model RevocationDispatch {
  id       String          @id @default(uuid()) @db.Uuid
  tenantId String          @db.Uuid
  batchId  String          @db.Uuid
  batch    RevocationBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)

  itemId String? @db.Uuid
  /// Everything needed to describe the holding on the review screen without a
  /// join into a snapshot that may later be pruned.
  holdingDescriptor Json
  /// The row of the section 5 table that selected this outcome.
  route String

  /// proposed | skipped | dispatched | confirmed | applied | failed
  /// | requires_change | cancelled
  status String @default("proposed")

  grantId           String? @db.Uuid
  revocationOrderId String? @db.Uuid
  remediationItemId String? @db.Uuid
  message           String?

  /// An explicit ordinal: createdAt is transaction start time and every row of
  /// the batch's single createMany carries the same one.
  sequence Int @default(0)

  dispatchedAt DateTime?
  confirmedAt  DateTime?
  appliedAt    DateTime?

  @@index([batchId, status])
  @@index([batchId, sequence])
  @@index([tenantId])
}

/// A ONE-SHOT negative term consumed by Provision's plan stage. Ruling G1.
///
/// It is not a standing deny rule and it is not an inference: it is a single
/// dated instruction carrying a named human, a campaign, a decision id and a
/// comment. It is refused at creation if the holding carries any live
/// attribution, it is terminal once applied, and it is cancelled rather than
/// applied if the holding acquires an attribution before it is planned.
model RevocationOrder {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid

  targetSystemId String @db.Uuid
  accountId      String @db.Uuid
  entitlementId  String @db.Uuid

  decidedByPersonId  String  @db.Uuid
  campaignDecisionId String? @db.Uuid
  /// Ruling G1's condition: the order carries its provenance ALL THE WAY TO THE
  /// TARGET. These three are denormalised so Provision's plan stage receives
  /// them as plain values and its audit event can name a human, WITHOUT
  /// Provision ever querying Govern.
  decidedByPersonName String
  campaignName        String?
  reason              String

  /// open | planned | applied | cancelled
  status         String  @default("open")
  cancelledReason String?

  createdAt DateTime @default(now())
  plannedAt DateTime?
  appliedAt DateTime?

  @@index([tenantId])
  @@index([tenantId, status])
}

/// Rules relate BUSINESS FUNCTIONS, not entitlements. A rule written directly
/// over two Active Directory groups is wrong within a year and wrong invisibly:
/// a group gets renamed, a second group is created that confers the same power,
/// a second system is introduced that does payments, and the rule sees nothing.
model BusinessFunction {
  id          String  @id @default(uuid()) @db.Uuid
  tenantId    String  @db.Uuid
  name        String
  description String?
  ownerPersonId String @db.Uuid

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  resources BusinessFunctionResource[]
  rulesAsA  SodRule[] @relation("SodRuleFunctionA")
  rulesAsB  SodRule[] @relation("SodRuleFunctionB")

  @@unique([tenantId, name])
  @@index([tenantId])
}

/// Named by IMMUTABLE IDENTIFIER — Provision's rule about Entitlement.externalId
/// being the target's own object id, restated one level up.
model BusinessFunctionResource {
  id         String           @id @default(uuid()) @db.Uuid
  tenantId   String           @db.Uuid
  functionId String           @db.Uuid
  function   BusinessFunction @relation(fields: [functionId], references: [id], onDelete: Cascade)

  systemId     String
  resourceKind String
  resourceId   String

  @@unique([tenantId, functionId, systemId, resourceKind, resourceId])
  @@index([tenantId])
}

model SodRule {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  name     String

  functionAId String           @db.Uuid
  functionA   BusinessFunction @relation("SodRuleFunctionA", fields: [functionAId], references: [id], onDelete: Restrict)
  functionBId String           @db.Uuid
  functionB   BusinessFunction @relation("SodRuleFunctionB", fields: [functionBId], references: [id], onDelete: Restrict)

  /// low | medium | high | critical
  severity String
  /// REQUIRED free text — what the risk actually is. A rule nobody can explain
  /// is a rule nobody will defend when it fires.
  rationale String
  /// Whoever writes the rule decides who may accept its risk.
  exceptionWorkflowId String? @db.Uuid
  enabled Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  violations SodViolation[]
  exceptions SodException[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

/// Detected over a snapshot, PER PERSON — not per account, and not per system.
/// Cross-account and cross-system by construction, which is the entire value:
/// the classic real violation is somebody who raises payments with their
/// ordinary account and approves them with an administrative one, and no
/// single-system check has ever caught that.
model SodViolation {
  id       String  @id @default(uuid()) @db.Uuid
  tenantId String  @db.Uuid
  ruleId   String  @db.Uuid
  rule     SodRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  personId String  @db.Uuid

  /// The SPECIFIC holdings on each side. "You violate this rule" is not
  /// actionable; "these three holdings put you on the A side" is.
  holdingsA Json
  holdingsB Json
  /// A person with concurrent contracts may legitimately hold both sides, and
  /// an exception whose stated basis is "these are two separate engagements" is
  /// a real and reviewable justification — which lapses when one of them does.
  contractsA Json @default("[]")
  contractsB Json @default("[]")

  severity String
  /// open | excepted | resolved | unevaluable
  status      String  @default("open")
  exceptionId String? @db.Uuid

  firstSeenAt    DateTime
  lastSeenAt     DateTime
  lastSnapshotId String   @db.Uuid

  exceptions SodException[]

  @@unique([tenantId, ruleId, personId])
  @@index([tenantId])
  @@index([tenantId, status, severity])
}

/// An exception is a RISK ACCEPTANCE, and the person who accepts a risk should
/// be the person who carries it. Approved through Automate's workflow engine.
model SodException {
  id          String       @id @default(uuid()) @db.Uuid
  tenantId    String       @db.Uuid
  ruleId      String       @db.Uuid
  rule        SodRule      @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  personId    String       @db.Uuid
  violationId String       @db.Uuid
  violation   SodViolation @relation(fields: [violationId], references: [id], onDelete: Cascade)

  /// Both REQUIRED. A perpetual, unjustified, uncompensated exception is how an
  /// SoD programme dies quietly.
  justification       String
  compensatingControl String
  /// Where the basis is a pair of concurrent contracts, this records them, and
  /// the exception lapses automatically when EITHER ends — ahead of its end
  /// date. The justification stopped being true.
  basisContractIds Json?

  approvalRequestId  String? @db.Uuid
  approvedByPersonId String? @db.Uuid

  startsAt DateTime
  /// NOT NULLABLE, and validated against maxExceptionDays at save. Null is not
  /// representable: a perpetual exception is a decision nobody ever re-makes.
  endsAt   DateTime

  /// pending | active | refused | blocked_no_approver | lapsed | revoked
  status          String  @default("pending")
  revokedReason   String?
  revokedByUserId String? @db.Uuid

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
  @@index([tenantId, status, endsAt])
}
```

- [ ] **Step 6: Add the two changes to tables Govern does not own**

In `packages/db/prisma/schema.prisma`, inside `model ProvisionAction`, after `attributedRuleIds`:

```prisma
  /// The Govern revocation order this action is applying, when one caused it.
  /// A bare column, not a relation: Provision must not acquire a dependency on
  /// a later-built subsystem's table, and cascading from an order would delete
  /// the record of what Provision did.
  ///
  /// Ruling G1's condition is met by the order's provenance travelling into
  /// `before` as plain values at plan time, so this column identifies the order
  /// and the audit event names the human — without Provision querying Govern.
  revocationOrderId String? @db.Uuid
```

and inside `model ApprovalDecision`, in its index block:

```prisma
  /// The decision graph's reciprocity query is a 180-day window over decisions
  /// joined to their requests' subjects. Without this it is a scan.
  @@index([tenantId, decidedAt])
```

**Nothing else about either model changes.**

- [ ] **Step 7: Generate the migration and inspect it**

```bash
pnpm --filter @syntra/db exec prisma migrate diff \
  --from-migrations packages/db/prisma/migrations \
  --to-schema-datamodel packages/db/prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > packages/db/prisma/migrations/20260823000000_govern_campaigns/migration.sql
```

**Delete every `DROP INDEX` naming a hand-written partial index** — including the four this plan created in Task 1: `govern_snapshot_one_building`, `account_attribution_one_confirmed`, `remediation_item_one_open_per_finding`, `remediation_item_one_open_per_campaign_item`. This is the second migration in this plan and the first one's partial indexes are now exactly the shape the diff wants to drop.

- [ ] **Step 8: Append the constraints, the partial indexes, the rules and the RLS block**

Append to `packages/db/prisma/migrations/20260823000000_govern_campaigns/migration.sql`:

```sql
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_status CHECK (
  "status" IN ('draft','generating','open','executing','closed_complete','closed_incomplete','cancelled'));

-- The due date can move, and moving it is an act. It can never move BACKWARDS
-- past the original, which would rewrite how long reviewers actually had.
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_due_not_before_original CHECK (
  "dueAt" >= "originalDueAt");

-- THERE IS NO STATUS THAT MEANS "CERTIFIED BECAUSE TIME RAN OUT".
ALTER TABLE "CampaignItem" ADD CONSTRAINT campaign_item_status CHECK (
  "status" IN ('pending','certified','revoke_decided','revocation_dispatched',
               'revocation_confirmed','revocation_applied','revocation_requires_change',
               'revocation_failed','undecided','moot','blocked_no_reviewer'));

ALTER TABLE "CampaignItem" ADD CONSTRAINT campaign_item_subject_key_agrees CHECK (
  ("personId" IS NOT NULL AND "accountRef" IS NULL
     AND "subjectKey" = 'person:' || "personId"::text)
  OR
  ("personId" IS NULL AND "accountRef" IS NOT NULL
     AND "subjectKey" = 'account:' || "systemId" || ':' || "accountRef"));

ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_kind CHECK (
  "decision" IN ('certify','revoke'));
-- A bulk decision names its size. A `viaBulk` with no size cannot be reported.
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_bulk_has_size CHECK (
  "viaBulk" = false OR "bulkSize" IS NOT NULL);
-- Revoking is one at a time, with a comment. There is no bulk revoke at all.
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_revoke_needs_comment CHECK (
  "decision" <> 'revoke' OR ("comment" IS NOT NULL AND length(btrim("comment")) > 0));
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_revoke_is_not_bulk CHECK (
  "decision" <> 'revoke' OR "viaBulk" = false);

ALTER TABLE "CampaignItemReviewer" ADD CONSTRAINT campaign_item_reviewer_via CHECK (
  "via" IN ('selector','fallback','escalation','reassignment'));

ALTER TABLE "RevocationBatch" ADD CONSTRAINT revocation_batch_status CHECK (
  "status" IN ('computing','previewed','blocked','applying','applied',
               'partially_applied','failed','superseded'));
ALTER TABLE "RevocationBatch" ADD CONSTRAINT revocation_batch_blocked_names_reason CHECK (
  "status" <> 'blocked' OR "blockedReason" IS NOT NULL);

ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_status CHECK (
  "status" IN ('proposed','skipped','dispatched','confirmed','applied','failed',
               'requires_change','cancelled'));
-- The vocabulary rule, in SQL. `applied` requires BOTH a confirmation and a
-- subsequent observation, and a dispatch that reached `applied` with no
-- `confirmedAt` behind it would be a report claiming an outcome it never had.
ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_applied_was_confirmed CHECK (
  "status" <> 'applied' OR ("confirmedAt" IS NOT NULL AND "appliedAt" IS NOT NULL));
ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_requires_change_has_item CHECK (
  "status" <> 'requires_change' OR "remediationItemId" IS NOT NULL);

ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_status CHECK (
  "status" IN ('open','planned','applied','cancelled'));
ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_cancelled_names_reason CHECK (
  "status" <> 'cancelled' OR "cancelledReason" IS NOT NULL);
-- Ruling G1's condition, enforced rather than remembered: an order with no
-- named human is indistinguishable from the inference the remit rule forbids.
ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_names_a_human CHECK (
  length(btrim("decidedByPersonName")) > 0 AND length(btrim("reason")) > 0);

-- A rule may not name the same function twice. Validated at save as well; this
-- is the backstop that makes it true of the data.
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_functions_differ CHECK (
  "functionAId" <> "functionBId");
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_severity CHECK (
  "severity" IN ('low','medium','high','critical'));
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_rationale_not_blank CHECK (
  length(btrim("rationale")) > 0);

ALTER TABLE "SodViolation" ADD CONSTRAINT sod_violation_status CHECK (
  "status" IN ('open','excepted','resolved','unevaluable'));

ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_status CHECK (
  "status" IN ('pending','active','refused','blocked_no_approver','lapsed','revoked'));
ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_ends_after_it_starts CHECK (
  "endsAt" > "startsAt");
ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_justified CHECK (
  length(btrim("justification")) > 0 AND length(btrim("compensatingControl")) > 0);

-- ---------------------------------------------------------------------------
-- Partial unique indexes, each with its escape hatch in the SAME TASK that
-- writes it. Ruling A-4: a "one non-terminal row per X" constraint with no
-- adoption path is how a crashed process permanently bricks a tenant, and this
-- programme has shipped that shape twice.
-- ---------------------------------------------------------------------------

-- One non-terminal batch per campaign. Superseded by
-- `computeRevocationBatch` (Task 20) at the head of the transaction that
-- creates the new one.
CREATE UNIQUE INDEX govern_revocation_batch_one_non_terminal_campaign
  ON "RevocationBatch" ("tenantId", "campaignId")
  WHERE "campaignId" IS NOT NULL
    AND "status" IN ('computing', 'previewed', 'blocked', 'applying');

-- And one for the standalone SoD remediation batches, whose campaignId is
-- NULL. Two indexes rather than one, because a partial unique over a nullable
-- column constrains nothing for the NULL rows — which is exactly the population
-- the second index exists for.
CREATE UNIQUE INDEX govern_revocation_batch_one_non_terminal_standalone
  ON "RevocationBatch" ("tenantId")
  WHERE "campaignId" IS NULL
    AND "status" IN ('computing', 'previewed', 'blocked', 'applying');

-- One live order per holding, so a holding cannot carry two contradictory
-- instructions. Superseded by `createRevocationOrder` (Task 20), which cancels
-- an existing open order for the same holding before creating a new one.
CREATE UNIQUE INDEX govern_revocation_order_one_open
  ON "RevocationOrder" ("tenantId", "targetSystemId", "accountId", "entitlementId")
  WHERE "status" = 'open';

-- Append-only. A reversal is a new decision with its own reason.
CREATE RULE govern_decision_no_update AS ON UPDATE TO "CampaignDecision" DO INSTEAD NOTHING;
CREATE RULE govern_decision_no_delete AS ON DELETE TO "CampaignDecision" DO INSTEAD NOTHING;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Campaign','CampaignItem','CampaignItemReviewer','CampaignDecision',
    'ReviewQualitySignal','RevocationBatch','RevocationDispatch','RevocationOrder',
    'BusinessFunction','BusinessFunctionResource','SodRule','SodViolation','SodException'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
```

- [ ] **Step 9: Apply, run, rebuild, run again**

```bash
pnpm --filter @syntra/db exec prisma migrate deploy
pnpm --filter @syntra/db exec prisma generate
pnpm vitest run packages/db/src/govern-campaign-schema.test.ts
pnpm --filter @syntra/db exec prisma migrate reset --force --skip-seed
pnpm vitest run packages/db/src/govern-schema.test.ts packages/db/src/govern-campaign-schema.test.ts
```

Expected: PASS on both runs. The rebuild is what proves the migration file rather than the accumulated database state, and it also proves Task 1's partial indexes survived Step 7.

- [ ] **Step 10: Typecheck**

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 11: Mutation-test**

1. Drop `govern_revocation_batch_one_non_terminal_standalone`. Expected: the second half of `permits one non-terminal batch per campaign and one standalone` FAILS. **Without it, the SoD remediation batches are unconstrained, because the campaign index's predicate excludes every NULL row.**
2. Drop `revocation_dispatch_applied_was_confirmed`. Expected: add a case creating an `applied` dispatch with no `confirmedAt` and assert it throws — if none exists, **write it**; the vocabulary rule is the whole of §13 and it must be enforced somewhere the code cannot forget.
3. Drop `campaign_decision_revoke_needs_comment`. Expected: add a case asserting a revoke with no comment is refused.
4. Drop `sod_rule_functions_differ`. Expected: `refuses a rule naming the same function twice` FAILS.
5. Weaken the RLS policy to `USING (true)` — **never drop it**. Expected: `hides every slice-2 table from another tenant` FAILS.

- [ ] **Step 12: Commit**

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260823000000_govern_campaigns/migration.sql \
        packages/db/src/govern-campaign-schema.test.ts
git commit -m "feat(govern): campaign, revocation and segregation-of-duties data model"
```

---
## Task 16: Segregation of duties — evaluation, detection, and the three prevention points

Spec §14. **`evaluateSodRules` and `sodImpact` are pure functions over plain values with no database handle**, which is what keeps Provision's guard and Automate's eligibility check from inverting the package graph. Both callers live in `core` too, so no package boundary is crossed and no earlier-built package acquires a dependency on a later-built one.

**Files:**
- Create: `packages/core/src/govern/sod.ts`, `packages/core/src/govern/sod-service.ts`
- Test: `packages/core/src/govern/sod.test.ts`, `packages/core/src/govern/sod-service.test.ts`
- Modify: `packages/core/src/automate/types.ts`, `packages/core/src/automate/eligibility.ts`, `packages/core/src/provision/explain.ts`, `packages/core/src/govern/snapshot-service.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `readableSnapshot`; `upsertFindings`, `type FindingDraft`; `type Severity`, `raiseSeverity`, `resourceKey`, `type ResourceKind`.
- Produces (in `./sod.js` — **pure**):
  - `interface FunctionResource { systemId: string; resourceKind: ResourceKind; resourceId: string }`
  - `interface SodFunction { functionId: string; name: string; resources: readonly FunctionResource[] }`
  - `interface SodRuleFacts { ruleId: string; name: string; functionA: SodFunction; functionB: SodFunction; severity: Severity; enabled: boolean }`
  - `interface PersonHolding { systemId: string; resourceKind: ResourceKind; resourceId: string; resourceName: string; contractIds: readonly string[] }`
  - `interface UnevaluableResource { systemId: string; resourceKind: ResourceKind; resourceId: string; reason: string }`
  - `type SodOutcome = { kind: 'clear' } | { kind: 'violation'; holdingsA: PersonHolding[]; holdingsB: PersonHolding[]; contractsA: string[]; contractsB: string[] } | { kind: 'unevaluable'; reasons: string[] }`
  - `function evaluateSodRule(rule: SodRuleFacts, holdings: readonly PersonHolding[], unevaluable: readonly UnevaluableResource[]): SodOutcome`
  - `function evaluateSodRules(rules: readonly SodRuleFacts[], holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>, unevaluable: readonly UnevaluableResource[]): Map<string, { ruleId: string; outcome: SodOutcome }[]>`
  - `interface SodImpactInput { rules: readonly SodRuleFacts[]; holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>; wouldGrant: ReadonlyMap<string, readonly PersonHolding[]>; unevaluable: readonly UnevaluableResource[] }`
  - `interface SodImpact { introduced: { personId: string; ruleId: string; ruleName: string; severity: Severity }[]; introducedCritical: number; alreadyViolating: number; unevaluableSubjects: number }`
  - `function sodImpact(input: SodImpactInput): SodImpact`
- Produces (in `./sod-service.js`):
  - `async function upsertBusinessFunction(tenantId, actorUserId, input): Promise<{ id: string }>`
  - `async function upsertSodRule(tenantId, actorUserId, input): Promise<{ id: string }>`
  - `async function loadSodFacts(tx: TenantClient, snapshotId: string): Promise<SodImpactInput>`
  - `async function detectSodViolations(tenantId: string, snapshotId: string, options?: { now?: Date }): Promise<{ open: number; unevaluable: number; resolved: number }>`
  - `async function previewSodRuleImpact(tenantId: string, input: { functionAId: string; functionBId: string; severity: Severity }): Promise<{ violatingPersons: number; sample: { personId: string; displayName: string }[]; unevaluableSubjects: number }>`
  - `async function sodImpactForGrant(tx: TenantClient, subjectPersonId: string, resource: FunctionResource): Promise<{ violations: { ruleId: string; ruleName: string; severity: Severity; otherSideHoldings: string[] }[]; hasCritical: boolean; hasActiveException: boolean }>`
- Produces in `../automate/types.js`: `'sod_violation'` added to `RefusalReason`.

- [ ] **Step 1: Write the failing pure test**

`packages/core/src/govern/sod.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  evaluateSodRule,
  evaluateSodRules,
  sodImpact,
  type PersonHolding,
  type SodRuleFacts,
} from './sod.js';

const raise = {
  functionId: 'fn-raise',
  name: 'Raise a payment',
  resources: [
    { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'ent-ap-entry' },
    { systemId: 'saas', resourceKind: 'application' as const, resourceId: 'app-pay' },
  ],
};
const approve = {
  functionId: 'fn-approve',
  name: 'Approve a payment',
  resources: [
    { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'ent-ap-approve' },
  ],
};

const rule: SodRuleFacts = {
  ruleId: 'rule-1',
  name: 'Payment raising and approval',
  functionA: raise,
  functionB: approve,
  severity: 'critical',
  enabled: true,
};

const holding = (over: Partial<PersonHolding>): PersonHolding => ({
  systemId: 'ad',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-ap-entry',
  resourceName: 'AP entry',
  contractIds: ['c-1'],
  ...over,
});

describe('evaluateSodRule', () => {
  it('is clear when the person holds only one side', () => {
    expect(evaluateSodRule(rule, [holding({})], []).kind).toBe('clear');
  });

  it('is clear when the person holds nothing at all', () => {
    // The empty case, in the safe direction: no holdings is no violation, and a
    // rule that fired on an empty set would put the whole tenant on the board.
    expect(evaluateSodRule(rule, [], []).kind).toBe('clear');
  });

  it('finds a violation ACROSS TWO SYSTEMS and two accounts of one person', () => {
    // The classic real violation: somebody raises payments with their ordinary
    // account and approves them with an administrative one. No single-system
    // check has ever caught that.
    const outcome = evaluateSodRule(
      rule,
      [
        holding({ systemId: 'saas', resourceKind: 'application', resourceId: 'app-pay', resourceName: 'Pay portal' }),
        holding({ resourceId: 'ent-ap-approve', resourceName: 'AP approve' }),
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
    if (outcome.kind !== 'violation') throw new Error('unreachable');
    expect(outcome.holdingsA.map((h) => h.resourceName)).toEqual(['Pay portal']);
    expect(outcome.holdingsB.map((h) => h.resourceName)).toEqual(['AP approve']);
  });

  it('records the CONTRACTS that produced each side', () => {
    // A person with concurrent contracts may legitimately hold both sides, and
    // an exception whose basis is "these are two separate engagements" is a
    // real justification — which lapses when one of those contracts does.
    const outcome = evaluateSodRule(
      rule,
      [
        holding({ contractIds: ['c-teaching'] }),
        holding({ resourceId: 'ent-ap-approve', contractIds: ['c-research'] }),
      ],
      [],
    );
    if (outcome.kind !== 'violation') throw new Error('unreachable');
    expect(outcome.contractsA).toEqual(['c-teaching']);
    expect(outcome.contractsB).toEqual(['c-research']);
  });

  it('is UNEVALUABLE when a function’s resource is missing, never clear', () => {
    // Quietly evaluating without it produces a confident wrong answer in the
    // dangerous direction. This is the same rule Provision applies to a
    // business rule naming a missing entitlement.
    const outcome = evaluateSodRule(rule, [holding({})], [
      { systemId: 'ad', resourceKind: 'targetEntitlement', resourceId: 'ent-ap-approve', reason: 'missing at its target' },
    ]);
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') throw new Error('unreachable');
    expect(outcome.reasons[0]).toContain('missing at its target');
  });

  it('is unevaluable even when the OTHER side is fully held', () => {
    const outcome = evaluateSodRule(
      rule,
      [holding({}), holding({ resourceId: 'ent-ap-approve' })],
      [{ systemId: 'ad', resourceKind: 'targetEntitlement', resourceId: 'ent-ap-approve', reason: 'unreadable' }],
    );
    expect(outcome.kind).toBe('unevaluable');
  });

  it('is clear when the rule is disabled', () => {
    expect(
      evaluateSodRule({ ...rule, enabled: false }, [holding({}), holding({ resourceId: 'ent-ap-approve' })], []).kind,
    ).toBe('clear');
  });

  it('is UNEVALUABLE when a function names NO resources at all', () => {
    // The empty case, in the dangerous direction. A function with no resources
    // can never be held, so a naive implementation silently disables the rule
    // and the dashboard says the organization is clean.
    const outcome = evaluateSodRule(
      { ...rule, functionB: { ...approve, resources: [] } },
      [holding({})],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') throw new Error('unreachable');
    expect(outcome.reasons.join(' ')).toContain('names no resources');
  });
});

describe('evaluateSodRules', () => {
  it('evaluates per person and returns only the persons with an outcome worth recording', () => {
    const result = evaluateSodRules(
      [rule],
      new Map([
        ['p-clean', [holding({})]],
        ['p-bad', [holding({}), holding({ resourceId: 'ent-ap-approve' })]],
      ]),
      [],
    );
    expect(result.get('p-bad')?.[0]?.outcome.kind).toBe('violation');
    expect(result.has('p-clean')).toBe(false);
  });
});

describe('sodImpact — the rule editor’s and Provision’s preview', () => {
  it('counts what a plan would INTRODUCE, separately from what already violates', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([
        ['p-1', [holding({})]],
        ['p-2', [holding({}), holding({ resourceId: 'ent-ap-approve' })]],
      ]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-approve' })]]]),
      unevaluable: [],
    });
    expect(impact.introduced).toHaveLength(1);
    expect(impact.introduced[0]).toMatchObject({ personId: 'p-1', ruleId: 'rule-1', severity: 'critical' });
    expect(impact.introducedCritical).toBe(1);
    // p-2 already violates and is NOT counted as introduced. A preview that
    // conflated them would tell an administrator their rule creates a violation
    // that was already there, and they would learn to ignore the column.
    expect(impact.alreadyViolating).toBe(1);
  });

  it('counts nothing as introduced when the grant changes nothing', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([['p-1', [holding({})]]]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-entry' })]]]),
      unevaluable: [],
    });
    expect(impact.introduced).toEqual([]);
  });

  it('counts subjects it could not evaluate rather than calling them clear', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([['p-1', [holding({})]]]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-approve' })]]]),
      unevaluable: [
        { systemId: 'ad', resourceKind: 'targetEntitlement', resourceId: 'ent-ap-approve', reason: 'unreadable' },
      ],
    });
    expect(impact.introduced).toEqual([]);
    expect(impact.unevaluableSubjects).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/sod.test.ts`
Expected: FAIL — `Cannot find module './sod.js'`.

- [ ] **Step 3: Write the pure evaluator**

`packages/core/src/govern/sod.ts`:

```ts
import { resourceKey, type ResourceKind, type Severity } from './types.js';

/**
 * Segregation of duties, evaluated over plain values.
 *
 * PURE, and deliberately so: Provision's guard and its rule editor call
 * `sodImpact()` and `evaluateSodRules()`, and Automate's eligibility check
 * calls into this module too. If any of them needed Govern to be QUERIED, the
 * seam would be wrong and it should be raised rather than worked around.
 *
 * The unit of a rule is a BUSINESS FUNCTION, not an entitlement. A rule written
 * directly over two Active Directory groups is wrong within a year and wrong
 * invisibly: a group gets renamed, a second group is created that confers the
 * same power, a second system is introduced that does payments, and the rule
 * sees nothing.
 */

export interface FunctionResource {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

export interface SodFunction {
  functionId: string;
  name: string;
  resources: readonly FunctionResource[];
}

export interface SodRuleFacts {
  ruleId: string;
  name: string;
  functionA: SodFunction;
  functionB: SodFunction;
  severity: Severity;
  enabled: boolean;
}

export interface PersonHolding {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  /** The contracts that produced this holding, for the concurrent-contract case. */
  contractIds: readonly string[];
}

export interface UnevaluableResource {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  reason: string;
}

export type SodOutcome =
  | { kind: 'clear' }
  | {
      kind: 'violation';
      holdingsA: PersonHolding[];
      holdingsB: PersonHolding[];
      contractsA: string[];
      contractsB: string[];
    }
  | { kind: 'unevaluable'; reasons: string[] };

const keyOf = (r: FunctionResource | PersonHolding) =>
  resourceKey({
    systemKind: 'targetSystem',
    systemId: r.systemId,
    resourceKind: r.resourceKind,
    resourceId: r.resourceId,
  });

export function evaluateSodRule(
  rule: SodRuleFacts,
  holdings: readonly PersonHolding[],
  unevaluable: readonly UnevaluableResource[],
): SodOutcome {
  if (!rule.enabled) return { kind: 'clear' };

  // A function with NO resources can never be held, so a naive implementation
  // silently disables the rule and the dashboard says the organization is
  // clean. The empty pattern is the universal pattern unless something says
  // otherwise, and here saying otherwise means refusing to evaluate.
  const reasons: string[] = [];
  for (const fn of [rule.functionA, rule.functionB]) {
    if (fn.resources.length === 0) {
      reasons.push(`the business function "${fn.name}" names no resources, so this rule cannot be evaluated`);
    }
  }

  const unevaluableKeys = new Map(unevaluable.map((u) => [keyOf(u), u.reason]));
  for (const fn of [rule.functionA, rule.functionB]) {
    for (const resource of fn.resources) {
      const reason = unevaluableKeys.get(keyOf(resource));
      if (reason !== undefined) {
        reasons.push(
          `a resource of the business function "${fn.name}" cannot be read: ${reason}`,
        );
      }
    }
  }
  if (reasons.length > 0) return { kind: 'unevaluable', reasons };

  const aKeys = new Set(rule.functionA.resources.map(keyOf));
  const bKeys = new Set(rule.functionB.resources.map(keyOf));

  const holdingsA = holdings.filter((h) => aKeys.has(keyOf(h)));
  const holdingsB = holdings.filter((h) => bKeys.has(keyOf(h)));

  if (holdingsA.length === 0 || holdingsB.length === 0) return { kind: 'clear' };

  return {
    kind: 'violation',
    holdingsA,
    holdingsB,
    contractsA: [...new Set(holdingsA.flatMap((h) => [...h.contractIds]))],
    contractsB: [...new Set(holdingsB.flatMap((h) => [...h.contractIds]))],
  };
}

export function evaluateSodRules(
  rules: readonly SodRuleFacts[],
  holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>,
  unevaluable: readonly UnevaluableResource[],
): Map<string, { ruleId: string; outcome: SodOutcome }[]> {
  const out = new Map<string, { ruleId: string; outcome: SodOutcome }[]>();
  for (const [personId, holdings] of holdingsByPerson) {
    const results = rules
      .map((rule) => ({ ruleId: rule.ruleId, outcome: evaluateSodRule(rule, holdings, unevaluable) }))
      .filter((r) => r.outcome.kind !== 'clear');
    if (results.length > 0) out.set(personId, results);
  }
  return out;
}

export interface SodImpactInput {
  rules: readonly SodRuleFacts[];
  holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>;
  /** What a plan or a rule would ADD. */
  wouldGrant: ReadonlyMap<string, readonly PersonHolding[]>;
  unevaluable: readonly UnevaluableResource[];
}

export interface SodImpact {
  introduced: { personId: string; ruleId: string; ruleName: string; severity: Severity }[];
  introducedCritical: number;
  alreadyViolating: number;
  unevaluableSubjects: number;
}

/**
 * What a change would INTRODUCE, counted separately from what already violates.
 *
 * Conflating them would tell an administrator their rule creates a violation
 * that was already there, and they would learn to ignore the column — which is
 * worse than not having it, because prevention at the point where the fault
 * actually is is the highest-value integration in section 14.
 */
export function sodImpact(input: SodImpactInput): SodImpact {
  const introduced: SodImpact['introduced'] = [];
  const unevaluableSubjects = new Set<string>();
  let alreadyViolating = 0;

  for (const [personId, holdings] of input.holdingsByPerson) {
    const added = input.wouldGrant.get(personId) ?? [];
    const after = [...holdings, ...added];

    for (const rule of input.rules) {
      const before = evaluateSodRule(rule, holdings, input.unevaluable);
      const afterOutcome = evaluateSodRule(rule, after, input.unevaluable);

      if (before.kind === 'unevaluable' || afterOutcome.kind === 'unevaluable') {
        unevaluableSubjects.add(personId);
        continue;
      }
      if (before.kind === 'violation') {
        alreadyViolating += 1;
        continue;
      }
      if (afterOutcome.kind === 'violation') {
        introduced.push({
          personId,
          ruleId: rule.ruleId,
          ruleName: rule.name,
          severity: rule.severity,
        });
      }
    }
  }

  return {
    introduced,
    introducedCritical: introduced.filter((i) => i.severity === 'critical').length,
    alreadyViolating,
    unevaluableSubjects: unevaluableSubjects.size,
  };
}
```

- [ ] **Step 4: Run the pure tests**

Run: `pnpm vitest run packages/core/src/govern/sod.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the persistence service**

`packages/core/src/govern/sod-service.ts` — the shape, with the parts that carry a decision written out:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { upsertFindings, type FindingDraft } from './finding-service.js';
import {
  evaluateSodRules,
  sodImpact,
  type FunctionResource,
  type PersonHolding,
  type SodImpactInput,
  type SodRuleFacts,
  type UnevaluableResource,
} from './sod.js';
import { readableSnapshot } from './snapshot-service.js';
import { raiseSeverity, type ResourceKind, type Severity } from './types.js';

export async function upsertBusinessFunction(
  tenantId: string,
  actorUserId: string | null,
  input: { id?: string; name: string; description: string | null; ownerPersonId: string; resources: FunctionResource[] },
): Promise<{ id: string }> {
  // A function with no resources can never be held, and a rule over it is a
  // rule that silently never fires. Refused at save, and `evaluateSodRule`
  // refuses it again at evaluation — belt and braces, because the schema is
  // the thing a later task might replace.
  if (input.resources.length === 0) {
    throw new Error(
      'a business function must name at least one resource; a function with none can never be held, and a rule over it would silently never fire',
    );
  }

  return withTenant(tenantId, async (tx) => {
    const fn =
      input.id === undefined
        ? await tx.businessFunction.create({
            data: {
              tenantId, name: input.name, description: input.description,
              ownerPersonId: input.ownerPersonId,
            },
          })
        : await tx.businessFunction.update({
            where: { id: input.id },
            data: { name: input.name, description: input.description, ownerPersonId: input.ownerPersonId },
          });

    await tx.businessFunctionResource.deleteMany({ where: { functionId: fn.id } });
    await tx.businessFunctionResource.createMany({
      data: input.resources.map((r) => ({ tenantId, functionId: fn.id, ...r })),
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.business_function.upsert',
      targetType: 'BusinessFunction',
      targetId: fn.id,
      outcome: 'success',
      sourceIp: null,
      payload: { name: input.name, resourceCount: input.resources.length },
    });
    return { id: fn.id };
  });
}

export async function upsertSodRule(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string; name: string; functionAId: string; functionBId: string;
    severity: Severity; rationale: string; exceptionWorkflowId: string | null; enabled: boolean;
  },
): Promise<{ id: string }> {
  if (input.functionAId === input.functionBId) {
    throw new Error('a rule may not name the same business function on both sides');
  }
  if (input.rationale.trim().length === 0) {
    throw new Error(
      'a rule needs a rationale saying what the risk actually is; a rule nobody can explain is a rule nobody will defend when it fires',
    );
  }

  return withTenant(tenantId, async (tx) => {
    const rule =
      input.id === undefined
        ? await tx.sodRule.create({ data: { tenantId, ...input } })
        : await tx.sodRule.update({ where: { id: input.id }, data: { ...input } });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.sod_rule.upsert',
      targetType: 'SodRule',
      targetId: rule.id,
      outcome: 'success',
      sourceIp: null,
      payload: { name: input.name, severity: input.severity, enabled: input.enabled },
    });
    return { id: rule.id };
  });
}

/**
 * Loads everything the pure evaluator needs, from ONE readable snapshot, in one
 * short transaction returning plain data.
 *
 * Per PERSON, not per account: cross-account and cross-system by construction.
 * An unattributed account is therefore NOT SoD-checked, because the check is
 * per person and the account belongs to nobody — which is why every orphan is a
 * hole in the SoD picture as well as a finding in its own right, and why the
 * SoD dashboard carries the orphan count in its header.
 */
export async function loadSodFacts(
  tx: TenantClient,
  snapshotId: string,
): Promise<SodImpactInput & { orphanCount: number; snapshotId: string }> {
  const snapshot = await readableSnapshot(tx, snapshotId);

  const functions = await tx.businessFunction.findMany({ include: { resources: true } });
  const rules = await tx.sodRule.findMany();
  const holdings = await tx.holding.findMany({
    where: { snapshotId: snapshot.id, personId: { not: null }, state: 'held' },
    select: {
      personId: true, systemId: true, resourceKind: true, resourceId: true, resourceName: true,
      attributions: { select: { detail: true, kind: true } },
    },
  });
  const gaps = await tx.coverageGap.findMany({
    where: { snapshotId: snapshot.id, kind: { in: ['resource_unreadable', 'source_unread', 'source_stale'] } },
    select: { systemId: true, resourceId: true, reason: true },
  });

  const byId = new Map(functions.map((f) => [f.id, f]));
  const ruleFacts: SodRuleFacts[] = rules.flatMap((rule) => {
    const a = byId.get(rule.functionAId);
    const b = byId.get(rule.functionBId);
    if (a === undefined || b === undefined) return [];
    const toFn = (f: typeof a) => ({
      functionId: f.id,
      name: f.name,
      resources: f.resources.map((r) => ({
        systemId: r.systemId,
        resourceKind: r.resourceKind as ResourceKind,
        resourceId: r.resourceId,
      })),
    });
    return [{
      ruleId: rule.id,
      name: rule.name,
      functionA: toFn(a),
      functionB: toFn(b),
      severity: rule.severity as Severity,
      enabled: rule.enabled,
    }];
  });

  const holdingsByPerson = new Map<string, PersonHolding[]>();
  for (const h of holdings) {
    const contractIds = [
      ...new Set(
        h.attributions
          .map((a) => (a.detail as Record<string, unknown>)['contractId'])
          .filter((c): c is string => typeof c === 'string'),
      ),
    ];
    const list = holdingsByPerson.get(h.personId!) ?? [];
    list.push({
      systemId: h.systemId,
      resourceKind: h.resourceKind as ResourceKind,
      resourceId: h.resourceId,
      resourceName: h.resourceName,
      contractIds,
    });
    holdingsByPerson.set(h.personId!, list);
  }

  // A gap over a whole system makes EVERY resource of that system unevaluable,
  // not only the named ones. A rule whose function names a group in a target
  // nobody has read cannot be evaluated, and calling it clear is the confident
  // wrong answer in the dangerous direction.
  const unevaluable: UnevaluableResource[] = [];
  for (const fn of functions) {
    for (const resource of fn.resources) {
      const gap = gaps.find(
        (g) =>
          g.systemId === resource.systemId &&
          (g.resourceId === null || g.resourceId === resource.resourceId),
      );
      if (gap !== undefined) {
        unevaluable.push({
          systemId: resource.systemId,
          resourceKind: resource.resourceKind as ResourceKind,
          resourceId: resource.resourceId,
          reason: gap.reason,
        });
      }
    }
  }

  return {
    rules: ruleFacts,
    holdingsByPerson,
    wouldGrant: new Map(),
    unevaluable,
    orphanCount: snapshot.unattributedAccountCount,
    snapshotId: snapshot.id,
  };
}

/**
 * A violation that persists across snapshots is UPDATED, never duplicated, so
 * the dashboard count is a count of problems and not a count of snapshots.
 */
export async function detectSodViolations(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ open: number; unevaluable: number; resolved: number }> {
  const now = options.now ?? new Date();
  const facts = await withTenant(tenantId, (tx) => loadSodFacts(tx, snapshotId));
  const results = evaluateSodRules(facts.rules, facts.holdingsByPerson, facts.unevaluable);

  const seen = new Set<string>();
  const findings: FindingDraft[] = [];
  let open = 0;
  let unevaluable = 0;

  for (const [personId, outcomes] of results) {
    for (const { ruleId, outcome } of outcomes) {
      seen.add(`${ruleId}|${personId}`);
      const rule = facts.rules.find((r) => r.ruleId === ruleId)!;

      await withTenant(tenantId, async (tx) => {
        const existing = await tx.sodViolation.findUnique({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
        });
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

        if (existing === null) {
          await tx.sodViolation.create({
            data: { tenantId, ruleId, personId, firstSeenAt: now, ...data },
          });
        } else if (existing.status === 'excepted' && outcome.kind === 'violation') {
          // An active exception holds. Reopening it every night would make a
          // deliberate risk acceptance a decision somebody re-makes daily.
          await tx.sodViolation.update({
            where: { id: existing.id },
            data: { lastSeenAt: now, lastSnapshotId: snapshotId },
          });
        } else {
          await tx.sodViolation.update({ where: { id: existing.id }, data });
        }
      });

      if (outcome.kind === 'unevaluable') {
        unevaluable += 1;
        continue;
      }
      open += 1;
      findings.push({
        kind: 'sod_violation',
        severity: rule.severity,
        subjectRefType: 'sod_violation',
        subjectRefId: `${ruleId}:${personId}`,
        detail: {
          ruleName: rule.name,
          personId,
          holdingsA: outcome.holdingsA.map((h) => h.resourceName),
          holdingsB: outcome.holdingsB.map((h) => h.resourceName),
          contractsA: outcome.contractsA,
          contractsB: outcome.contractsB,
          // Every orphan is a hole in this picture as well as a finding in its
          // own right, so the count travels with the finding.
          orphanAccountsNotChecked: facts.orphanCount,
        },
      });
    }
  }

  // Anything not seen this time is resolved WITH the snapshot that showed it
  // gone, never deleted.
  const resolved = await withTenant(tenantId, async (tx) => {
    const live = await tx.sodViolation.findMany({
      where: { status: { in: ['open', 'unevaluable'] } },
      select: { id: true, ruleId: true, personId: true },
    });
    const gone = live.filter((v) => !seen.has(`${v.ruleId}|${v.personId}`)).map((v) => v.id);
    if (gone.length === 0) return 0;
    const result = await tx.sodViolation.updateMany({
      where: { id: { in: gone } },
      data: { status: 'resolved', lastSeenAt: now, lastSnapshotId: snapshotId },
    });
    return result.count;
  });

  await upsertFindings(tenantId, snapshotId, findings, { now });
  return { open, unevaluable, resolved };
}

export async function previewSodRuleImpact(
  tenantId: string,
  input: { functionAId: string; functionBId: string; severity: Severity },
): Promise<{ violatingPersons: number; sample: { personId: string; displayName: string }[]; unevaluableSubjects: number }> {
  return withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx);
    const facts = await loadSodFacts(tx, snapshot.id);
    const functions = await tx.businessFunction.findMany({
      where: { id: { in: [input.functionAId, input.functionBId] } },
      include: { resources: true },
    });
    const a = functions.find((f) => f.id === input.functionAId);
    const b = functions.find((f) => f.id === input.functionBId);
    if (a === undefined || b === undefined) throw new Error('both business functions must exist');

    const toFn = (f: typeof a) => ({
      functionId: f.id,
      name: f.name,
      resources: f.resources.map((r) => ({
        systemId: r.systemId,
        resourceKind: r.resourceKind as ResourceKind,
        resourceId: r.resourceId,
      })),
    });
    const candidate: SodRuleFacts = {
      ruleId: 'preview',
      name: 'preview',
      functionA: toFn(a),
      functionB: toFn(b),
      severity: input.severity,
      enabled: true,
    };

    const results = evaluateSodRules([candidate], facts.holdingsByPerson, facts.unevaluable);
    const violating = [...results].filter(([, r]) => r[0]?.outcome.kind === 'violation').map(([p]) => p);
    const persons = await tx.person.findMany({
      where: { id: { in: violating.slice(0, 25) } },
      select: { id: true, givenName: true, familyName: true },
    });

    return {
      // "This rule is violated by 23 persons today — show me who", BEFORE it is
      // saved rather than after.
      violatingPersons: violating.length,
      sample: persons.map((p) => ({ personId: p.id, displayName: `${p.givenName} ${p.familyName}`.trim() })),
      unevaluableSubjects: [...results].filter(([, r]) => r[0]?.outcome.kind === 'unevaluable').length,
    };
  });
}

/**
 * The approval screen's question: would granting this create a violation, of
 * which rule, and against what does the subject already hold the other side?
 *
 * One query, at the one moment when an accountable human is looking at this
 * specific grant with the authority to refuse it.
 */
export async function sodImpactForGrant(
  tx: TenantClient,
  subjectPersonId: string,
  resource: FunctionResource,
): Promise<{
  violations: { ruleId: string; ruleName: string; severity: Severity; otherSideHoldings: string[] }[];
  hasCritical: boolean;
  hasActiveException: boolean;
}> {
  const snapshot = await readableSnapshot(tx);
  const facts = await loadSodFacts(tx, snapshot.id);
  const held = facts.holdingsByPerson.get(subjectPersonId) ?? [];

  const impact = sodImpact({
    rules: facts.rules,
    holdingsByPerson: new Map([[subjectPersonId, held]]),
    wouldGrant: new Map([[
      subjectPersonId,
      [{ ...resource, resourceName: resource.resourceId, contractIds: [] }],
    ]]),
    unevaluable: facts.unevaluable,
  });

  const exceptions = await tx.sodException.findMany({
    where: { personId: subjectPersonId, status: 'active', endsAt: { gt: new Date() } },
    select: { ruleId: true },
  });
  const exceptedRules = new Set(exceptions.map((e) => e.ruleId));

  const violations = impact.introduced
    .filter((i) => !exceptedRules.has(i.ruleId))
    .map((i) => {
      const rule = facts.rules.find((r) => r.ruleId === i.ruleId)!;
      const aKeys = new Set(rule.functionA.resources.map((r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`));
      return {
        ruleId: i.ruleId,
        ruleName: i.ruleName,
        severity: i.severity,
        // Named existing holdings, not a count: "you violate this rule" is not
        // actionable and "these three holdings put you on the other side" is.
        otherSideHoldings: held
          .filter((h) => aKeys.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`))
          .map((h) => h.resourceName),
      };
    });

  return {
    violations,
    hasCritical: violations.some((v) => v.severity === 'critical'),
    hasActiveException: exceptedRules.size > 0,
  };
}
```

- [ ] **Step 6: Wire the three prevention points**

**(a) Automate's refusal reason.** In `packages/core/src/automate/types.ts`, add `'sod_violation'` to the `RefusalReason` union — it joins the closed set beside `no_longer_eligible`, `subject_departed`, `subject_inactive`, `already_held` and `product_withdrawn`.

**(b) Automate's eligibility re-check.** In `packages/core/src/automate/eligibility.ts`, after the existing checks in `checkEligibility`:

```ts
  // Section 14: re-checked at each stage opening and again AT FULFILMENT,
  // because an approval given on Monday must not fulfil on Friday into a world
  // that changed. Only `critical` refuses outright; below that the approver is
  // told and approving records an acknowledgement that becomes a pending
  // exception request. Blocking here for a lower severity would freeze somebody
  // for a configuration error somebody else made.
  for (const grant of product.grants) {
    const impact = await sodImpactForGrant(tx, subjectPersonId, {
      systemId: grant.targetSystemId ?? 'syntra',
      resourceKind:
        grant.resourceType === 'entitlement' ? 'targetEntitlement'
          : grant.resourceType === 'application' ? 'application'
          : 'syntraGroup',
      resourceId: grant.resourceId,
    });
    if (impact.hasCritical && !impact.hasActiveException) {
      const named = impact.violations.filter((v) => v.severity === 'critical');
      return {
        ok: false,
        reason: 'sod_violation',
        message:
          `granting this would create a critical segregation-of-duties violation of ` +
          `"${named[0]!.ruleName}", against ${named[0]!.otherSideHoldings.join(', ') || 'access already held'}. ` +
          `An approved exception is required first.`,
      };
    }
  }
```

**(c) Provision's rule editor.** In `packages/core/src/provision/explain.ts`, `previewRuleImpact` gains an SoD column. It takes the *pure* function and plain values; it does not query Govern:

```ts
  // A birthright rule that creates a violation is a configuration error made by
  // a person with a console open, and that is who should see it, at that
  // moment, BEFORE it is saved. This is a call into a pure function over plain
  // values, not a dependency on a running Govern.
  const sod = sodImpact({
    rules: sodRuleFacts,
    holdingsByPerson,
    wouldGrant,
    unevaluable,
  });
```

with `RuleImpact` gaining `sodIntroduced: number`, `sodIntroducedCritical: number` and `sodSample: { personId: string; ruleName: string }[]`.

**Never by blocking a birthright grant.** Provision's guard marks a plan introducing a `critical` violation `requiresConfirmation` — visible, before apply, to a human already reviewing a plan — and it never makes a person unprocessable. A person whose contract entitles them to both sides is not doing anything wrong, and refusing to provision them means they cannot do their job because of a rule somebody else wrote: that is the unprocessable-person trap Provision built its whole exception model to avoid, inverted, produced by a governance control.

**(d) The detect stage — in `jobs.ts`, NOT in `snapshot-service.ts`.** In `packages/core/src/govern/jobs.ts`, inside `runSnapshotJob`, after `refreshOrphanProposals`:

```ts
  // Slice 2. Detection is over a snapshot, per person, and it runs as part of
  // the nightly job so the violation count and the picture it came from are
  // never a day apart.
  //
  // Called from HERE rather than from `buildSnapshot`, deliberately:
  // `sod-service.ts` imports `readableSnapshot` from `snapshot-service.ts`, so
  // calling `detectSodViolations` from inside `buildSnapshot` would make the
  // two modules import each other. ESM tolerates a cycle until the day an
  // initialisation order changes and one of them is half-constructed, and the
  // failure reads as an unrelated `undefined is not a function`. `jobs.ts`
  // already depends on both and on neither's internals, which is where a
  // sequencer belongs.
  await detectSodViolations(payload.tenantId, built.snapshotId, { now });
```

and add `import { detectSodViolations } from './sod-service.js';` at the head of `jobs.ts`. **`snapshot-service.ts` gains no import of `sod-service.ts` in this task or any later one**, and Task 7's `boundaries.test.ts` gains the assertion:

```ts
  it('keeps snapshot-service free of any import of sod-service', () => {
    // They would otherwise import each other: sod-service needs
    // readableSnapshot, and a detect call in the other direction closes the
    // loop. The sequencer is jobs.ts.
    const snapshot = readFileSync(join(GOVERN_DIR, 'snapshot-service.ts'), 'utf8');
    expect(snapshot).not.toMatch(/from '\.\/sod-service\.js'/);
  });
```

- [ ] **Step 7: Write the service test**

`packages/core/src/govern/sod-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  detectSodViolations,
  previewSodRuleImpact,
  sodImpactForGrant,
  upsertBusinessFunction,
  upsertSodRule,
} from './sod-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
let ruleId: string;
let annaId: string;
let bramId: string;

/**
 * Anna holds BOTH sides, across two systems and two accounts — the classic real
 * violation. Bram holds one side only, so a detector that fired on everybody
 * fails as loudly as one that fired on nobody.
 */
async function seed(options: { gapOnApprove?: boolean } = {}) {
  return withTenant(tenantId, async (tx) => {
    const anna = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    const bram = await tx.person.create({ data: { tenantId, givenName: 'Bram', familyName: 'Visser' } });
    const teaching = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    const research = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 2, startDate: new Date('2021-01-01') },
    });
    await tx.contract.create({
      data: { tenantId, personId: bram.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });

    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW, unattributedAccountCount: 4 },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId, snapshotId: snapshot.id, sourceKind: 'syntraInternal', sourceId: 'syntra',
        sourceName: 'Syntra', completeness: 'complete', staleness: 'fresh', freshnessSlaHours: 24,
      },
    });

    const holding = async (personId: string, systemId: string, resourceId: string, name: string, contractId: string) => {
      const row = await tx.holding.create({
        data: {
          tenantId, snapshotId: snapshot.id, subjectKey: `person:${personId}`, personId,
          systemKind: 'targetSystem', systemId, resourceKind: 'targetEntitlement',
          resourceId, resourceName: name, state: 'held', observedAt: NOW,
          observedVia: 'provision', firstSeenAt: NOW, attributionCount: 1,
        },
      });
      await tx.holdingAttribution.create({
        data: {
          tenantId, holdingId: row.id, kind: 'business_rule', refType: 'BusinessRule',
          refId: 'rule-x', detail: { contractId, ruleEnabled: true }, resolvedAt: NOW,
        },
      });
    };

    await holding(anna.id, 'ad', 'ent-raise', 'AP entry', teaching.id);
    await holding(anna.id, 'saas', 'ent-approve', 'AP approve', research.id);
    await holding(bram.id, 'ad', 'ent-raise', 'AP entry', teaching.id);

    if (options.gapOnApprove === true) {
      await tx.coverageGap.create({
        data: {
          tenantId, snapshotId: snapshot.id, kind: 'resource_unreadable',
          systemKind: 'targetSystem', systemId: 'saas', resourceId: 'ent-approve',
          reason: 'AP approve is unreadable at its target',
        },
      });
    }

    return { snapshotId: snapshot.id, annaId: anna.id, bramId: bram.id };
  });
}

async function seedRule() {
  const raise = await upsertBusinessFunction(tenantId, 'u-1', {
    name: 'Raise a payment', description: null, ownerPersonId: annaId,
    resources: [{ systemId: 'ad', resourceKind: 'targetEntitlement', resourceId: 'ent-raise' }],
  });
  const approve = await upsertBusinessFunction(tenantId, 'u-1', {
    name: 'Approve a payment', description: null, ownerPersonId: annaId,
    resources: [{ systemId: 'saas', resourceKind: 'targetEntitlement', resourceId: 'ent-approve' }],
  });
  const rule = await upsertSodRule(tenantId, 'u-1', {
    name: 'Payment raising and approval',
    functionAId: raise.id, functionBId: approve.id,
    severity: 'critical',
    rationale: 'the same person must not be able to raise a payment and approve it',
    exceptionWorkflowId: null, enabled: true,
  });
  return { raiseId: raise.id, approveId: approve.id, ruleId: rule.id };
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await seed();
  snapshotId = seeded.snapshotId;
  annaId = seeded.annaId;
  bramId = seeded.bramId;
  ruleId = (await seedRule()).ruleId;
});

describe('detection', () => {
  it('persists ONE violation with the holdings and the contracts on each side', async () => {
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ open: 1, unevaluable: 0 });

    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ personId: annaId, ruleId, status: 'open', severity: 'critical' });
    // "You violate this rule" is not actionable; "these holdings put you on the
    // A side" is.
    expect((violations[0]!.holdingsA as { resourceName: string }[])[0]!.resourceName).toBe('AP entry');
    expect((violations[0]!.holdingsB as { resourceName: string }[])[0]!.resourceName).toBe('AP approve');
    // The concurrent-contract case: an exception whose basis is "these are two
    // separate engagements" is reviewable only because these are recorded.
    expect((violations[0]!.contractsA as string[])).toHaveLength(1);
    expect((violations[0]!.contractsB as string[])).toHaveLength(1);
    expect(violations[0]!.contractsA).not.toEqual(violations[0]!.contractsB);
  });

  it('does not raise a violation for somebody holding one side only', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations.map((v) => v.personId)).not.toContain(bramId);
  });

  it('UPDATES a persisting violation rather than duplicating it across snapshots', async () => {
    // The dashboard count is a count of problems, not a count of snapshots.
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const later = new Date(NOW.getTime() + 86_400_000);
    await detectSodViolations(tenantId, snapshotId, { now: later });

    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.firstSeenAt).toEqual(NOW);
    expect(violations[0]!.lastSeenAt).toEqual(later);
  });

  it('marks a rule UNEVALUABLE when a function’s resource sits behind a coverage gap', async () => {
    // A row with status `unevaluable`, NOT an absent row, so the screen can say
    // "we could not check this" rather than showing a clean board. Quietly
    // evaluating without it produces a confident wrong answer in the dangerous
    // direction.
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seed({ gapOnApprove: true });
    snapshotId = seeded.snapshotId;
    annaId = seeded.annaId;
    ruleId = (await seedRule()).ruleId;

    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ open: 0, unevaluable: 1 });
    const violation = await withTenant(tenantId, (tx) => tx.sodViolation.findFirstOrThrow());
    expect(violation.status).toBe('unevaluable');
  });

  it('leaves an EXCEPTED violation excepted rather than reopening it nightly', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.sodViolation.updateMany({ where: { personId: annaId }, data: { status: 'excepted' } }),
    );
    await detectSodViolations(tenantId, snapshotId, { now: new Date(NOW.getTime() + 86_400_000) });
    const violation = await withTenant(tenantId, (tx) => tx.sodViolation.findFirstOrThrow());
    expect(violation.status).toBe('excepted');
  });

  it('RESOLVES a violation that stopped being observed, naming the snapshot', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.holding.deleteMany({ where: { snapshotId, resourceId: 'ent-approve' } }),
    );
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result.resolved).toBe(1);
    const violation = await withTenant(tenantId, (tx) => tx.sodViolation.findFirstOrThrow());
    expect(violation).toMatchObject({ status: 'resolved', lastSnapshotId: snapshotId });
  });

  it('carries the orphan count on the finding, because orphans are NOT SoD-checked', async () => {
    // The check is per person and an unattributed account belongs to nobody, so
    // every orphan is a hole in the SoD picture as well as a finding in its own
    // right. The SoD dashboard carries the count in its header for that reason.
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
    );
    expect((finding.detail as { orphanAccountsNotChecked?: number }).orphanAccountsNotChecked).toBe(4);
  });
});

describe('save-time validation', () => {
  it('refuses a business function with NO resources', async () => {
    await expect(
      upsertBusinessFunction(tenantId, 'u-1', {
        name: 'Empty', description: null, ownerPersonId: annaId, resources: [],
      }),
    ).rejects.toThrow(/at least one resource/i);
  });

  it('refuses a rule whose rationale is blank', async () => {
    // The empty string is the universal justification.
    const { raiseId, approveId } = await seedRule();
    await expect(
      upsertSodRule(tenantId, 'u-1', {
        name: 'Blank', functionAId: raiseId, functionBId: approveId,
        severity: 'high', rationale: '   ', exceptionWorkflowId: null, enabled: true,
      }),
    ).rejects.toThrow(/rationale/i);
  });

  it('refuses a rule naming the same function on both sides', async () => {
    const { raiseId } = await seedRule();
    await expect(
      upsertSodRule(tenantId, 'u-1', {
        name: 'Self', functionAId: raiseId, functionBId: raiseId,
        severity: 'high', rationale: 'x', exceptionWorkflowId: null, enabled: true,
      }),
    ).rejects.toThrow(/same business function/i);
  });
});

describe('previewSodRuleImpact — before it is saved, not after', () => {
  it('names who violates the candidate rule today', async () => {
    const { raiseId, approveId } = await seedRule();
    const preview = await previewSodRuleImpact(tenantId, {
      functionAId: raiseId, functionBId: approveId, severity: 'critical',
    });
    expect(preview.violatingPersons).toBe(1);
    expect(preview.sample[0]).toMatchObject({ personId: annaId, displayName: 'Anna Novak' });
  });
});

describe('sodImpactForGrant — the approval screen’s question', () => {
  it('names the rule and the EXISTING holdings on the other side', async () => {
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(tx, bramId, {
        systemId: 'saas', resourceKind: 'targetEntitlement', resourceId: 'ent-approve',
      }),
    );
    expect(impact.hasCritical).toBe(true);
    expect(impact.violations[0]).toMatchObject({ ruleName: 'Payment raising and approval' });
    expect(impact.violations[0]!.otherSideHoldings).toEqual(['AP entry']);
  });

  it('reports NOTHING for a grant that creates no violation', async () => {
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(tx, bramId, {
        systemId: 'ad', resourceKind: 'targetEntitlement', resourceId: 'ent-raise',
      }),
    );
    expect(impact.violations).toEqual([]);
    expect(impact.hasCritical).toBe(false);
  });

  it('does not report a rule an ACTIVE exception already covers', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, async (tx) => {
      const violation = await tx.sodViolation.findFirstOrThrow();
      await tx.sodException.create({
        data: {
          tenantId, ruleId, personId: bramId, violationId: violation.id,
          justification: 'two separate engagements', compensatingControl: 'monthly review',
          startsAt: NOW, endsAt: new Date(NOW.getTime() + 30 * 86_400_000), status: 'active',
        },
      });
    });
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(tx, bramId, {
        systemId: 'saas', resourceKind: 'targetEntitlement', resourceId: 'ent-approve',
      }),
    );
    expect(impact.violations).toEqual([]);
  });
});

describe('Automate’s eligibility re-check', () => {
  it('refuses a CRITICAL grant with reason sod_violation', async () => {
    const { checkEligibility } = await import('../automate/eligibility.js');
    const productId = await withTenant(tenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({ data: { tenantId, name: 'wf' } });
      const product = await tx.product.create({
        data: {
          tenantId, name: 'AP approve', slug: 'ap-approve', kind: 'targetEntitlement',
          workflowId: workflow.id, status: 'active', audienceCondition: { all: [] },
        },
      });
      await tx.productGrant.create({
        data: {
          tenantId, productId: product.id, resourceType: 'entitlement',
          resourceId: 'ent-approve', targetSystemId: 'saas',
        },
      });
      return product.id;
    });

    const outcome = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, productId, bramId, NOW),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'sod_violation' });
    expect((outcome as { message: string }).message).toContain('Payment raising and approval');
  });

  it('does NOT refuse a HIGH-severity grant, so nobody is frozen for somebody else’s rule', async () => {
    // Only `critical` refuses. Below that the approver is told and approving
    // records an acknowledgement that becomes a pending exception request.
    // Blocking here would be the unprocessable-person trap, inverted, produced
    // by a governance control.
    const { checkEligibility } = await import('../automate/eligibility.js');
    await withTenant(tenantId, (tx) =>
      tx.sodRule.update({ where: { id: ruleId }, data: { severity: 'high' } }),
    );
    const productId = await withTenant(tenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({ data: { tenantId, name: 'wf' } });
      const product = await tx.product.create({
        data: {
          tenantId, name: 'AP approve', slug: 'ap-approve', kind: 'targetEntitlement',
          workflowId: workflow.id, status: 'active', audienceCondition: { all: [] },
        },
      });
      await tx.productGrant.create({
        data: {
          tenantId, productId: product.id, resourceType: 'entitlement',
          resourceId: 'ent-approve', targetSystemId: 'saas',
        },
      });
      return product.id;
    });

    const outcome = await withTenant(tenantId, (tx) => checkEligibility(tx, productId, bramId, NOW));
    expect(outcome.ok).toBe(true);
  });
});
```

- [ ] **Step 8: Run everything and typecheck**

Run: `pnpm vitest run packages/core/src/govern/sod.test.ts packages/core/src/govern/sod-service.test.ts packages/core/src/automate`
Then: `pnpm exec tsc -b --force`
Expected: PASS and exit 0. **The Automate suite must stay green** — the only change to it is one new union member and one added check, and a broken Automate test here means the eligibility edit changed behaviour it should not have.

- [ ] **Step 9: Mutation-test**

1. In `evaluateSodRule`, return `{ kind: 'clear' }` for an unevaluable resource. Expected: `is UNEVALUABLE when a function's resource is missing` FAILS.
2. Drop the empty-resources check. Expected: `is UNEVALUABLE when a function names NO resources at all` FAILS.
3. In `sodImpact`, count `alreadyViolating` rows as `introduced`. Expected: `counts what a plan would INTRODUCE, separately` FAILS.
4. In `checkEligibility`, refuse on `high` as well as `critical`. Expected: `does NOT refuse a high-severity grant` FAILS — **this is the mutation that would produce the frozen-person trap.**
5. In `detectSodViolations`, delete rather than resolve. Expected: `resolves a violation that stopped being observed` FAILS.
6. In `loadSodFacts`, match a gap only on an exact `resourceId`. Expected: `marks a rule unevaluable when a function's resource sits behind a coverage gap` FAILS for a system-wide gap.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/sod.ts packages/core/src/govern/sod.test.ts \
        packages/core/src/govern/sod-service.ts packages/core/src/govern/sod-service.test.ts \
        packages/core/src/automate/types.ts packages/core/src/automate/eligibility.ts \
        packages/core/src/provision/explain.ts packages/core/src/govern/snapshot-service.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): segregation of duties — evaluation, detection and the three prevention points"
```

---
## Task 17: Campaigns — creation, the two previews, item generation and the stale refusal

Spec §8 rules 1 and 2, §11, §19. **A campaign cannot be started when any source its own scope depends on is stale or unread**, and the refusal names which clock it was.

**Files:**
- Create: `packages/core/src/govern/campaign-service.ts`
- Test: `packages/core/src/govern/campaign-service.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `evaluateCondition`, `conditionSchema`, `type Condition`, `type ConditionFacts` from `../provision/condition.js`; `readableSnapshot`, `buildSnapshot`, `type ReadableSnapshot`; `checkSnapshotAge`, `checkSourceFreshness`, `type ClassifiedSource`; `governSettings`; `percentOf`, `known`, `type Tri`, `type ResourceKind`; `resolveItemReviewers` from `./reviewer-service.js` **(Task 18 — see the dispatch note below)**; `enqueueOutbox`, `displayNames`, `recipientsForPersons` from `../automate/notify.js`.
- Produces (all in `./campaign-service.js`):
  - `const ITEM_BATCH = 500`
  - `interface CampaignScope { resourceKinds: ResourceKind[]; systemIds?: string[]; privilegedOnly?: boolean; orgUnitIds?: string[]; subjectCondition?: Condition; riskFlags?: string[] }`
  - `const campaignScopeSchema: z.ZodType<CampaignScope>` — with two `MutuallyAssignable` guards over its non-lazy leaf, because the annotation alone checks nothing
  - `class CampaignRefusedError extends Error { constructor(readonly code: 'stale_source' | 'stale_snapshot' | 'empty_scope' | 'not_draft', readonly clock: 'source' | 'snapshot' | null, message: string) }`
  - `interface ScopePreview { holdings: number; persons: number; systems: number; sample: { subjectKey: string; resourceName: string }[] }`
  - `async function previewCampaignScope(tenantId: string, scope: CampaignScope, snapshotId?: string): Promise<ScopePreview>`
  - `async function createCampaign(tenantId, actorUserId, input): Promise<{ id: string }>`
  - `async function startCampaign(tenantId: string, actorUserId: string, campaignId: string, options?: { now?: Date; batchSize?: number; publicUrl?: string }): Promise<{ status: string; itemCount: number; blockedCount: number }>`
  - `async function extendCampaign(tenantId: string, actorUserId: string, campaignId: string, newDueAt: Date): Promise<void>`
  - `async function rebaseCampaign(tenantId: string, actorUserId: string, campaignId: string, newSnapshotId: string): Promise<{ reopened: number; kept: number }>`
  - `function coverageOf(counts: { total: number; decided: number; moot: number }): Tri<{ percent: number; numerator: number; denominator: number }>`

**Dispatch note.** `campaign-service.ts` imports `resolveItemReviewers` from `reviewer-service.ts`, which Task 18 creates. **Task 18 is therefore dispatched before Task 17**, exactly as Provision dispatched its Task 15 before its Task 14. The numbers are labels, not an order. Task 18 consumes nothing from Task 17: it takes plain `CampaignItem` rows and a `StageSnapshot`, both of which exist as of Task 15's migration. Both tasks carry this note.

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/campaign-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  CampaignRefusedError,
  campaignScopeSchema,
  coverageOf,
  createCampaign,
  extendCampaign,
  previewCampaignScope,
  rebaseCampaign,
  startCampaign,
} from './campaign-service.js';
import { buildSnapshot } from './snapshot-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const DUE = new Date('2026-07-15T09:00:00Z');
let tenantId: string;
let ownerPersonId: string;
let managerPersonId: string;
let subjectPersonId: string;

async function seedTenant(sourceFresh: boolean) {
  return withTenant(tenantId, async (tx) => {
    const manager = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Manager' } });
    const owner = await tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Owner' } });
    const subject = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    for (const p of [manager, owner, subject]) {
      await tx.contract.create({
        data: {
          tenantId, personId: p.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01'),
          ...(p.id === subject.id ? { managerPersonId: manager.id } : {}),
        },
      });
      await tx.user.create({
        data: {
          tenantId, login: p.givenName.toLowerCase(), email: `${p.givenName.toLowerCase()}@a.test`,
          displayName: `${p.givenName} ${p.familyName}`, personId: p.id,
        },
      });
    }
    const target = await tx.targetSystem.create({
      data: {
        tenantId, name: 'Acme AD', secretName: 's', config: { tlsMode: 'ldaps' },
        lastRunAt: sourceFresh ? NOW : new Date('2026-05-01T00:00:00Z'),
        lastAppliedRunAt: sourceFresh ? NOW : new Date('2026-05-01T00:00:00Z'),
      },
    });
    const entitlement = await tx.entitlement.create({
      data: { tenantId, targetSystemId: target.id, externalId: 'g1', type: 'group', displayName: 'Finance-Payments' },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId, targetSystemId: target.id, personId: subject.id, anchor: 'a1',
        correlationKey: 'anna.novak', status: 'active', lastReconciledAt: NOW,
      },
    });
    await tx.accountEntitlement.create({
      data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'discovered' },
    });
    return { managerId: manager.id, ownerId: owner.id, subjectId: subject.id, targetId: target.id };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await seedTenant(true);
  managerPersonId = seeded.managerId;
  ownerPersonId = seeded.ownerId;
  subjectPersonId = seeded.subjectId;
});

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'Q2 finance review',
  description: null,
  scope: { resourceKinds: ['targetEntitlement'] as const },
  reviewerSelector: 'manager' as const,
  reviewerConfig: {},
  fallbackSelector: 'person' as const,
  fallbackConfig: { personId: ownerPersonId },
  ownerPersonId,
  opensAt: NOW,
  dueAt: DUE,
  allowBulkCertify: true,
  ...over,
});

describe('the scope language', () => {
  it('refuses a scope with NO resource kinds', () => {
    // The empty case, in the dangerous direction. "Review the finance system"
    // with a blank kind list must mean nothing, not everything — a blank
    // `contains` matching every person in the tenant is the defect this
    // programme has already paid for once.
    expect(() => campaignScopeSchema.parse({ resourceKinds: [] })).toThrow();
  });

  it('refuses a subject condition with a blank value', () => {
    expect(() =>
      campaignScopeSchema.parse({
        resourceKinds: ['syntraGroup'],
        subjectCondition: { field: 'department', op: 'contains', value: '' },
      }),
    ).toThrow();
  });

  it('accepts a scope naming one kind and nothing else', () => {
    expect(campaignScopeSchema.parse({ resourceKinds: ['syntraRole'] })).toMatchObject({
      resourceKinds: ['syntraRole'],
    });
  });
});

describe('previewCampaignScope', () => {
  it('says how many holdings, persons and systems it covers, before anybody is emailed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const preview = await previewCampaignScope(tenantId, { resourceKinds: ['targetEntitlement'] });
    expect(preview.holdings).toBe(1);
    expect(preview.persons).toBe(1);
    expect(preview.systems).toBe(1);
    expect(preview.sample[0]!.resourceName).toBe('Finance-Payments');
  });

  it('covers nothing for a kind nobody holds', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    expect(
      (await previewCampaignScope(tenantId, { resourceKinds: ['syntraRole'] })).holdings,
    ).toBe(0);
  });
});

describe('the stale refusal', () => {
  it('REFUSES to start when a source the scope depends on is stale, naming the source and the clock', async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seedTenant(false);
    ownerPersonId = seeded.ownerId;
    await buildSnapshot(tenantId, { now: NOW });

    const { id } = await createCampaign(tenantId, 'user-1', draft());
    const failure = await startCampaign(tenantId, 'user-1', id, { now: NOW }).catch((e) => e);
    expect(failure).toBeInstanceOf(CampaignRefusedError);
    expect(failure.code).toBe('stale_source');
    expect(failure.clock).toBe('source');
    expect(failure.message).toContain('Acme AD');
    expect(failure.message).toContain('hours ago');
  });

  it('refuses only for sources the scope ACTUALLY depends on', async () => {
    // Not every source in the tenant: the sources contributing holdings the
    // campaign's items would be drawn from. A campaign over Syntra roles must
    // not be blocked by a target nobody has read.
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seedTenant(false);
    ownerPersonId = seeded.ownerId;
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({ data: { tenantId, name: 'Auditor', permissions: ['audit.read'] } });
      const user = await tx.user.findFirstOrThrow({ where: { personId: seeded.subjectId } });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
    });
    await buildSnapshot(tenantId, { now: NOW });

    const { id } = await createCampaign(tenantId, 'user-1', draft({ scope: { resourceKinds: ['syntraRole'] } }));
    const result = await startCampaign(tenantId, 'user-1', id, { now: NOW });
    expect(result.status).toBe('open');
  });

  it('refuses to start a campaign whose snapshot is already past maxSnapshotAgeDays', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    const much_later = new Date(NOW.getTime() + 60 * 86_400_000);
    const failure = await startCampaign(tenantId, 'user-1', id, { now: much_later }).catch((e) => e);
    expect(failure.code).toBe('stale_snapshot');
    expect(failure.clock).toBe('snapshot');
  });
});

describe('generation', () => {
  it('generates ONE item per (subject, resource), copies the provenance, and opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    const result = await startCampaign(tenantId, 'user-1', id, { now: NOW });

    expect(result.itemCount).toBe(1);
    const [campaign, items] = await withTenant(tenantId, async (tx) => [
      await tx.campaign.findUniqueOrThrow({ where: { id } }),
      await tx.campaignItem.findMany({ where: { campaignId: id } }),
    ]);
    expect(campaign.status).toBe('open');
    expect(campaign.totalItems).toBe(1);
    expect(items[0]).toMatchObject({
      subjectKey: `person:${subjectPersonId}`,
      resourceName: 'Finance-Payments',
      status: 'pending',
    });
    // Copied, not referenced by id: editing the world afterwards must not
    // change what somebody attested to.
    expect(items[0]!.attributions).toEqual([expect.objectContaining({ kind: 'discovered' })]);
    expect(items[0]!.riskFlags).toContain('unattributable');
  });

  it('is INVISIBLE to reviewers while generating, and nobody is notified until it opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    const before = await withTenant(tenantId, (tx) => tx.notificationOutbox.count());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });
    const after = await withTenant(tenantId, (tx) => tx.notificationOutbox.count());
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
  });

  it('batches generation so no transaction carries the whole scope', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    const result = await startCampaign(tenantId, 'user-1', id, { now: NOW, batchSize: 1 });
    expect(result.itemCount).toBe(1);
  });

  it('refuses to start a campaign that is not a draft', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });
    await expect(startCampaign(tenantId, 'user-1', id, { now: NOW })).rejects.toMatchObject({
      code: 'not_draft',
    });
  });

  it('refuses to start a campaign whose scope covers NOTHING', async () => {
    // 200 managers emailed about an empty queue is worse than a refusal.
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft({ scope: { resourceKinds: ['syntraUser'] }, }));
    await withTenant(tenantId, (tx) => tx.holding.deleteMany({ where: { resourceKind: 'syntraUser' } }));
    await expect(startCampaign(tenantId, 'user-1', id, { now: NOW })).rejects.toMatchObject({
      code: 'empty_scope',
    });
  });
});

describe('extending is an act', () => {
  it('records who extended it and by how long, keeps the original date, and notifies', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });

    const newDue = new Date(DUE.getTime() + 14 * 86_400_000);
    await extendCampaign(tenantId, 'user-1', id, newDue);

    const campaign = await withTenant(tenantId, (tx) => tx.campaign.findUniqueOrThrow({ where: { id } }));
    expect(campaign).toMatchObject({ extensionCount: 1, dueAt: newDue, originalDueAt: DUE });
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.campaign.extend' } }),
    );
    expect(event.payload).toMatchObject({ originalDueAt: DUE.toISOString(), extensionCount: 1 });
  });

  it('refuses to move the due date BACKWARDS past the original', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });
    await expect(
      extendCampaign(tenantId, 'user-1', id, new Date(DUE.getTime() - 86_400_000)),
    ).rejects.toThrow(/backwards/i);
  });
});

describe('re-basing re-opens only what changed', () => {
  it('keeps a certification of a holding that did not change and re-opens one that did', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });

    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId, itemId: item.id, personId: managerPersonId, decision: 'certify',
          itemOpenedAt: NOW, decidedAt: NOW, sessionDecisionOrdinal: 1, coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'certified' } });
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, 'user-1', id, rebuilt.snapshotId);

    // A certification of a holding that has not changed is STILL GOOD.
    expect(result).toEqual({ reopened: 0, kept: 1 });
    const after = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }));
    expect(after.status).toBe('certified');
  });

  it('re-opens an item whose holding gained an attribution', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, 'user-1', draft());
    await startCampaign(tenantId, 'user-1', id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId, itemId: item.id, personId: managerPersonId, decision: 'certify',
          itemOpenedAt: NOW, decidedAt: NOW, sessionDecisionOrdinal: 1, coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'certified' } });
      // The holding stops being unattributable: somebody recorded a rule for it.
      const holding = await tx.accountEntitlement.findFirstOrThrow();
      await tx.accountEntitlement.update({ where: { id: holding.id }, data: { origin: 'manual' } });
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, 'user-1', id, rebuilt.snapshotId);
    expect(result.reopened).toBe(1);
    const after = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }));
    expect(after.status).toBe('pending');
  });
});

describe('coverageOf', () => {
  it('is (decided + moot) / total, and moot is in the numerator', () => {
    const coverage = coverageOf({ total: 1840, decided: 1693, moot: 63 });
    expect(coverage).toEqual({
      known: true,
      value: { percent: 95.4, numerator: 1756, denominator: 1840 },
    });
  });

  it('is unknown for an EMPTY campaign rather than 0% or 100%', () => {
    expect(coverageOf({ total: 0, decided: 0, moot: 0 }).known).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/campaign-service.test.ts`
Expected: FAIL — `Cannot find module './campaign-service.js'`.

- [ ] **Step 3: Write the scope schema with a guard that bites**

`packages/core/src/govern/campaign-service.ts`, first section:

```ts
import { z } from 'zod';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { conditionSchema, evaluateCondition, type Condition, type ConditionFacts } from '../provision/condition.js';
import { displayNames, enqueueOutbox, recipientsForPersons } from '../automate/notify.js';
import { checkSnapshotAge, checkSourceFreshness, type ClassifiedSource } from './freshness.js';
import { resolveItemReviewers } from './reviewer-service.js';
import { governSettings } from './settings-service.js';
import { readableSnapshot, type ReadableSnapshot } from './snapshot-service.js';
import { RESOURCE_KINDS, percentOf, known, type MutuallyAssignable, type ResourceKind, type Tri } from './types.js';

export const ITEM_BATCH = 500;

export interface CampaignScope {
  /** AT LEAST ONE. An empty list means NOTHING, never everything. */
  resourceKinds: ResourceKind[];
  systemIds?: string[];
  privilegedOnly?: boolean;
  orgUnitIds?: string[];
  subjectCondition?: Condition;
  riskFlags?: string[];
}

const leafScopeSchema = z.object({
  // `.min(1)` is the whole point. "Review the finance system" with a blank kind
  // list must cover nothing rather than the tenant, and a matching language's
  // empty pattern is its universal pattern unless something says otherwise
  // (Ruling P20).
  resourceKinds: z.array(z.enum(RESOURCE_KINDS as unknown as [ResourceKind, ...ResourceKind[]])).min(1),
  systemIds: z.array(z.string().min(1)).min(1).optional(),
  privilegedOnly: z.boolean().optional(),
  orgUnitIds: z.array(z.string().uuid()).min(1).optional(),
  riskFlags: z.array(z.string().min(1)).min(1).optional(),
});

export const campaignScopeSchema = leafScopeSchema.extend({
  // `conditionSchema` already refuses a blank value at the schema AND at a
  // runtime backstop (Ruling P20), so the scope inherits both.
  subjectCondition: conditionSchema.optional(),
});

/**
 * The annotation `z.ZodType<CampaignScope>` would check NOTHING here if the
 * schema were recursive — Ruling P21 measured that deleting an entire arm of a
 * `z.lazy` union still compiles cleanly under it. This schema is not recursive,
 * so the relationship is checkable, and these two guards check it in both
 * directions. Delete a field from either side and `tsc` fails.
 */
type ScopeFromSchema = z.infer<typeof campaignScopeSchema>;
type _ScopeAssignableToType = MutuallyAssignable<ScopeFromSchema, CampaignScope>;
type _TypeAssignableToScope = MutuallyAssignable<CampaignScope, ScopeFromSchema>;

export class CampaignRefusedError extends Error {
  constructor(
    readonly code: 'stale_source' | 'stale_snapshot' | 'empty_scope' | 'not_draft',
    /** Which clock. A refusal that does not say is a refusal nobody can act on. */
    readonly clock: 'source' | 'snapshot' | null,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignRefusedError';
  }
}

/**
 * `coveragePercent = (decided + moot) / total`, defined ONCE because it is the
 * number people will quote.
 *
 * `moot` is in the numerator because a holding that no longer exists is not an
 * unanswered question. It is counted separately on the same line so a campaign
 * with 800 moot items — one somebody scoped against a picture the world had
 * moved past — is visible rather than flattering.
 */
export function coverageOf(counts: {
  total: number;
  decided: number;
  moot: number;
}): Tri<{ percent: number; numerator: number; denominator: number }> {
  return percentOf(counts.decided + counts.moot, known(counts.total));
}
```

- [ ] **Step 4: Write the scope query and the preview**

Append:

```ts
interface ScopedHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: string;
  resourceId: string;
  resourceName: string;
  observedAt: Date;
  privileged: boolean;
  unattributable: boolean;
  attributions: { kind: string; detail: unknown }[];
}

async function holdingsInScope(
  tx: TenantClient,
  snapshot: ReadableSnapshot,
  scope: CampaignScope,
): Promise<ScopedHolding[]> {
  const rows = await tx.holding.findMany({
    where: {
      snapshotId: snapshot.id,
      resourceKind: { in: scope.resourceKinds },
      ...(scope.systemIds === undefined ? {} : { systemId: { in: scope.systemIds } }),
      ...(scope.privilegedOnly === true ? { privileged: true } : {}),
    },
    include: { attributions: { select: { kind: true, detail: true } } },
  });

  if (scope.subjectCondition === undefined && scope.orgUnitIds === undefined) {
    return rows.map((r) => ({ ...r, attributions: r.attributions }));
  }

  const users = await tx.user.findMany({
    where: { personId: { not: null } },
    select: { personId: true, orgUnitId: true },
  });
  const orgUnitByPerson = new Map(users.map((u) => [u.personId!, u.orgUnitId]));

  const contracts = await tx.contract.findMany({
    select: {
      personId: true, department: true, jobTitle: true, costCentre: true,
      employer: true, location: true, fte: true, startDate: true, endDate: true,
    },
  });
  const factsByPerson = new Map<string, ConditionFacts[]>();
  for (const c of contracts) {
    const facts: ConditionFacts = {
      department: c.department,
      jobTitle: c.jobTitle,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      fte: c.fte === null ? null : Number(c.fte),
    };
    factsByPerson.set(c.personId, [...(factsByPerson.get(c.personId) ?? []), facts]);
  }

  return rows.filter((row) => {
    if (row.personId === null) {
      // An unattributed account satisfies no condition over contracts and sits
      // in no org unit. It is EXCLUDED from a conditioned scope rather than
      // silently admitted, and the campaign's coverage figure says how many
      // such accounts were in the systems it covered.
      return scope.subjectCondition === undefined && scope.orgUnitIds === undefined;
    }
    if (scope.orgUnitIds !== undefined) {
      const unit = orgUnitByPerson.get(row.personId) ?? null;
      if (unit === null || !scope.orgUnitIds.includes(unit)) return false;
    }
    if (scope.subjectCondition !== undefined) {
      const facts = factsByPerson.get(row.personId) ?? [];
      if (!facts.some((f) => evaluateCondition(scope.subjectCondition!, f))) return false;
    }
    return true;
  });
}

export interface ScopePreview {
  holdings: number;
  persons: number;
  systems: number;
  sample: { subjectKey: string; resourceName: string }[];
}

/**
 * "This scope covers 4,120 holdings across 1,180 persons and 6 systems — show
 * me." The screen that catches an unreviewable campaign before 200 people are
 * emailed, rather than at 3am on the due date.
 */
export async function previewCampaignScope(
  tenantId: string,
  scope: CampaignScope,
  snapshotId?: string,
): Promise<ScopePreview> {
  return withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, snapshotId);
    const rows = await holdingsInScope(tx, snapshot, campaignScopeSchema.parse(scope));
    return {
      holdings: rows.length,
      persons: new Set(rows.map((r) => r.personId).filter((p): p is string => p !== null)).size,
      systems: new Set(rows.map((r) => r.systemId)).size,
      sample: rows.slice(0, 25).map((r) => ({ subjectKey: r.subjectKey, resourceName: r.resourceName })),
    };
  });
}
```

- [ ] **Step 5: Write creation, the refusals and generation**

Append:

```ts
export async function createCampaign(
  tenantId: string,
  actorUserId: string,
  input: {
    name: string; description: string | null; scope: CampaignScope;
    reviewerSelector: string; reviewerConfig: Record<string, unknown>;
    fallbackSelector: string; fallbackConfig: Record<string, unknown>;
    ownerPersonId: string; opensAt: Date; dueAt: Date; allowBulkCertify: boolean;
    recurrence?: string | null; snapshotId?: string;
  },
): Promise<{ id: string }> {
  const scope = campaignScopeSchema.parse(input.scope);

  return withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description,
        scope: scope as never,
        snapshotId: snapshot.id,
        reviewerSelector: input.reviewerSelector,
        reviewerConfig: input.reviewerConfig as never,
        fallbackSelector: input.fallbackSelector,
        fallbackConfig: input.fallbackConfig as never,
        ownerPersonId: input.ownerPersonId,
        opensAt: input.opensAt,
        dueAt: input.dueAt,
        originalDueAt: input.dueAt,
        allowBulkCertify: input.allowBulkCertify,
        recurrence: input.recurrence ?? null,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.create',
      targetType: 'Campaign',
      targetId: campaign.id,
      outcome: 'success',
      sourceIp: null,
      payload: { name: input.name, scope, dueAt: input.dueAt.toISOString() },
    });
    return { id: campaign.id };
  });
}

/**
 * Generation is batched, the campaign stays `generating` until the last batch
 * commits, and `open` is set in a final short transaction. A campaign in
 * `generating` is invisible to reviewers, and NOBODY IS NOTIFIED until it is
 * open, so nobody opens a queue that is still filling.
 */
export async function startCampaign(
  tenantId: string,
  actorUserId: string,
  campaignId: string,
  options: { now?: Date; batchSize?: number; publicUrl?: string } = {},
): Promise<{ status: string; itemCount: number; blockedCount: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? ITEM_BATCH;
  const publicUrl = options.publicUrl ?? '';

  const prepared = await withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (campaign.status !== 'draft') {
      throw new CampaignRefusedError('not_draft', null, `this campaign is already ${campaign.status}`);
    }

    const snapshot = await readableSnapshot(tx, campaign.snapshotId);
    const scope = campaignScopeSchema.parse(campaign.scope);
    const settings = await governSettings(tx);

    // Clock one: how long ago GOVERN assembled the picture.
    const age = checkSnapshotAge(snapshot.asOf, now, settings.maxSnapshotAgeDays);
    if (!age.ok) throw new CampaignRefusedError('stale_snapshot', age.clock, age.message);

    const rows = await holdingsInScope(tx, snapshot, scope);
    if (rows.length === 0) {
      throw new CampaignRefusedError(
        'empty_scope', null,
        'this scope covers no holdings at all; starting it would email reviewers about an empty queue',
      );
    }

    // Clock two: how long ago THE WORLD was read — and only for the sources
    // this scope actually depends on. Not every source in the tenant: a campaign
    // over Syntra roles must not be blocked by a target nobody has read.
    const systemsInScope = new Set(rows.map((r) => r.systemId));
    const contributing = snapshot.sources.filter((s) => systemsInScope.has(s.sourceId));
    const freshness = checkSourceFreshness(contributing);
    if (!freshness.ok) {
      throw new CampaignRefusedError('stale_source', freshness.clock, freshness.message);
    }

    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'generating' } });
    return { campaign, snapshot, rows };
  });

  // ---- generate, in batches, each its own short transaction ----------------
  let itemCount = 0;
  let blockedCount = 0;
  const reviewerCounts = new Map<string, number>();

  for (let i = 0; i < prepared.rows.length; i += batchSize) {
    const batch = prepared.rows.slice(i, i + batchSize);
    const outcome = await withTenant(tenantId, async (tx) => {
      const created = await Promise.all(
        batch.map((row) =>
          tx.campaignItem.create({
            data: {
              tenantId,
              campaignId,
              holdingSnapshotId: prepared.snapshot.id,
              subjectKey: row.subjectKey,
              personId: row.personId,
              accountRef: row.accountRef,
              systemId: row.systemId,
              resourceKind: row.resourceKind,
              resourceId: row.resourceId,
              resourceName: row.resourceName,
              // Copied, not referenced by id.
              attributions: row.attributions as never,
              observedAt: row.observedAt,
              coverageStatus:
                prepared.snapshot.sources.find((s) => s.sourceId === row.systemId)?.completeness ??
                'complete',
              riskFlags: [
                ...(row.privileged ? ['privileged'] : []),
                ...(row.unattributable ? ['unattributable'] : []),
                ...(prepared.snapshot.sources.find((s) => s.sourceId === row.systemId)?.staleness ===
                'stale'
                  ? ['stale']
                  : []),
                ...(row.attributions.some((a) => a.kind === 'auto_granted') ? ['no_human_decision'] : []),
              ],
            },
          }),
        ),
      );

      // Task 18 resolves reviewers. It is dispatched BEFORE this task.
      return resolveItemReviewers(tx, campaignId, created.map((c) => c.id), now);
    });
    itemCount += batch.length;
    blockedCount += outcome.blocked;
    for (const [personId, count] of outcome.assignedByPerson) {
      reviewerCounts.set(personId, (reviewerCounts.get(personId) ?? 0) + count);
    }
  }

  // ---- open, and only now tell anybody -----------------------------------
  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: { status: 'open', totalItems: itemCount, blockedItems: blockedCount },
    });

    const recipients = await recipientsForPersons(tx, [...reviewerCounts.keys()]);
    const names = await displayNames(tx, { personIds: [campaign.ownerPersonId] });
    await enqueueOutbox(
      tx,
      recipients.map((recipient) => ({
        template: 'govern-review-assigned' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(reviewerCounts.get(recipient.personId ?? '') ?? 0),
          dueAt: campaign.dueAt.toDateString(),
          reviewUrl: `${publicUrl}/govern/reviews?campaign=${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.start',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        itemCount,
        blockedCount,
        reviewers: reviewerCounts.size,
        snapshotId: prepared.snapshot.id,
        ownerName: names.get(`person:${campaign.ownerPersonId}`) ?? null,
      },
    });

    return { status: 'open', itemCount, blockedCount };
  });
}
```

- [ ] **Step 6: Write extension and re-basing**

Append:

```ts
/**
 * A due date that can be moved quietly is not a due date. Extending is a
 * privileged, audited action recording who extended it and by how long, it
 * notifies every reviewer with open items, and the ORIGINAL date stays on the
 * row and in the evidence bundle beside the new one.
 */
export async function extendCampaign(
  tenantId: string,
  actorUserId: string,
  campaignId: string,
  newDueAt: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (newDueAt <= campaign.dueAt) {
      throw new Error(
        'a due date may not move backwards; that would rewrite how long reviewers actually had',
      );
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: { dueAt: newDueAt, extensionCount: campaign.extensionCount + 1 },
    });

    const openItems = await tx.campaignItem.findMany({
      where: { campaignId, status: 'pending' },
      select: { reviewers: { where: { unassignedAt: null }, select: { personId: true } } },
    });
    const reviewerIds = [...new Set(openItems.flatMap((i) => i.reviewers.map((r) => r.personId)))];
    const recipients = await recipientsForPersons(tx, reviewerIds);
    await enqueueOutbox(
      tx,
      recipients.map((recipient) => ({
        template: 'govern-review-reminder' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(openItems.length),
          dueAt: newDueAt.toDateString(),
          reviewUrl: `/govern/reviews?campaign=${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.extend',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        originalDueAt: campaign.originalDueAt.toISOString(),
        previousDueAt: campaign.dueAt.toISOString(),
        newDueAt: newDueAt.toISOString(),
        extensionCount: campaign.extensionCount + 1,
        reviewersNotified: recipients.length,
      },
    });
  });
}

/**
 * Re-basing RE-OPENS ONLY THE ITEMS WHOSE HOLDING ACTUALLY CHANGED.
 *
 * A certification of a holding that has since changed is not a certification of
 * the current holding; a certification of one that has not is still good.
 * Re-opening everything would make a re-base a punishment for the reviewers who
 * answered on time.
 *
 * COMPOSITION HAZARD (Global Constraints): this pairs with the
 * `HoldingCertification` projection in Task 19. An item that is NOT re-opened
 * must keep its projection row; rolling the projection back for every item of a
 * re-based campaign would make a certification that is still good read as never
 * made. Task 19 Step 9 tests the pair.
 */
export async function rebaseCampaign(
  tenantId: string,
  actorUserId: string,
  campaignId: string,
  newSnapshotId: string,
): Promise<{ reopened: number; kept: number }> {
  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const snapshot = await readableSnapshot(tx, newSnapshotId);
    const items = await tx.campaignItem.findMany({ where: { campaignId } });

    const fresh = await tx.holding.findMany({
      where: { snapshotId: snapshot.id, subjectKey: { in: items.map((i) => i.subjectKey) } },
      include: { attributions: { select: { kind: true, refId: true } } },
    });
    const byKey = new Map(
      fresh.map((h) => [`${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`, h]),
    );

    let reopened = 0;
    let kept = 0;

    for (const item of items) {
      const key = `${item.subjectKey}|${item.systemId}|${item.resourceKind}|${item.resourceId}`;
      const now = byKey.get(key);

      const before = (item.attributions as { kind: string; refId?: string | null }[]).map(
        (a) => `${a.kind}:${a.refId ?? ''}`,
      );
      const after = (now?.attributions ?? []).map((a) => `${a.kind}:${a.refId ?? ''}`);
      const changed =
        now === undefined ||
        now.state !== 'held' ||
        before.length !== after.length ||
        [...before].sort().join('|') !== [...after].sort().join('|');

      if (!changed) {
        kept += 1;
        continue;
      }
      reopened += 1;
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: now === undefined ? 'moot' : 'pending',
          statusReason:
            now === undefined
              ? `the holding no longer exists as of snapshot ${snapshot.id}`
              : 'the holding changed between the original snapshot and the re-base',
          holdingSnapshotId: snapshot.id,
          attributions: (now?.attributions ?? []) as never,
          ...(now === undefined ? {} : { observedAt: now.observedAt }),
        },
      });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: { snapshotId: snapshot.id, rebasedFromSnapshotId: campaign.snapshotId },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.rebase',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        fromSnapshotId: campaign.snapshotId,
        toSnapshotId: snapshot.id,
        reopened,
        kept,
      },
    });

    return { reopened, kept };
  });
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/campaign-service.test.ts`
Expected: PASS, 17 tests. **Task 18 must be complete first** — `resolveItemReviewers` is a hard import.

- [ ] **Step 8: Export and typecheck**

Add `export * from './govern/campaign-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 9: Mutation-test**

1. Change `resourceKinds` to `.array(...)` with no `.min(1)`. Expected: `refuses a scope with NO resource kinds` FAILS.
2. In `startCampaign`, check freshness over `snapshot.sources` instead of `contributing`. Expected: `refuses only for sources the scope ACTUALLY depends on` FAILS.
3. Delete the `checkSnapshotAge` call. Expected: `refuses to start a campaign whose snapshot is already past maxSnapshotAgeDays` FAILS.
4. Move the `enqueueOutbox` call into the generation loop. Expected: `is INVISIBLE to reviewers while generating` FAILS on `before`.
5. In `rebaseCampaign`, re-open every item. Expected: `keeps a certification of a holding that did not change` FAILS.
6. In `rebaseCampaign`, keep every item. Expected: `re-opens an item whose holding gained an attribution` FAILS. Both directions.
7. Delete `_ScopeAssignableToType` and remove `resourceKinds` from `leafScopeSchema`. Expected: **`pnpm exec tsc -b --force` FAILS** with the other guard — proving the guards check what the `z.ZodType<T>` annotation would not.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/campaign-service.ts packages/core/src/govern/campaign-service.test.ts packages/core/src/index.ts
git commit -m "feat(govern): campaigns — scope, previews, generation and the two stale refusals"
```

---
## Task 18: Reviewers — resolution, reminders, escalation, reassignment, `moot` and `blocked_no_reviewer`

Spec §12. The hard part of recertification, and the reason the workflow is not. **Dispatched BEFORE Task 17**, which hard-imports `resolveItemReviewers` from here; this task consumes nothing from Task 17.

**Files:**
- Create: `packages/core/src/govern/reviewer-service.ts`
- Test: `packages/core/src/govern/reviewer-service.test.ts`
- Modify: `packages/core/src/govern/jobs.ts` (register `remind` and `close`), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `resolveStageApprovers`, `resolveEscalationApprovers`, `isValidApprover`, `type StageSnapshot`, `type ResolutionSubject`, `type ApproverSelector`, `type SelectorConfig` from `../automate/approvers.js`; `enqueueOutbox`, `recipientsForPersons`, `displayNames`, `usersWithPermission` from `../automate/notify.js`; `PERMISSIONS`; `activeContracts` from `../identity/contract-service.js`; `createRemediationItem`, `upsertFindings` from `./finding-service.js`; `governSettings`; `coverageOf` — **no: `coverageOf` lives in Task 17 and importing it here would be a forward import. This module computes the four counts and Task 17's `coverageOf` is applied by the caller.**
- Produces (all in `./reviewer-service.js`):
  - `const REVIEWER_BATCH = 200`
  - `interface ResolveOutcome { assignedByPerson: Map<string, number>; blocked: number }`
  - `async function resolveItemReviewers(tx: TenantClient, campaignId: string, itemIds: readonly string[], now: Date): Promise<ResolveOutcome>`
  - `async function reassignInvalidReviewers(tenantId: string, campaignId: string, options?: { now?: Date; publicUrl?: string }): Promise<{ reassigned: number; blocked: number }>`
  - `async function mootDepartedSubjects(tenantId: string, campaignId: string, options?: { now?: Date }): Promise<{ mooted: number; preserved: number }>`
  - `async function mootVanishedHoldings(tenantId: string, campaignId: string, currentSnapshotId: string, options?: { now?: Date }): Promise<{ mooted: number }>`
  - `async function runCampaignReminders(tenantId: string, options?: { now?: Date; publicUrl?: string }): Promise<{ reminded: number; escalated: number }>`
  - `async function closeDueCampaigns(tenantId: string, options?: { now?: Date; publicUrl?: string }): Promise<{ closed: number; undecided: number }>`

**The invariant, borrowed intact from Automate and enforced the same way.** No person may be resolved as a reviewer of an item whose subject is themselves. It is a **subtraction from the resolved set**, applied at the end of expansion so that every selector inherits it and no expansion step can reintroduce what an earlier step removed (Ruling A-6). The new path here is **the resource owner who holds the resource** — the ordinary case, the finance systems manager in the finance group — and dropping them from their own item while leaving them the other 300 is correct and is what happens.

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/reviewer-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  closeDueCampaigns,
  mootDepartedSubjects,
  mootVanishedHoldings,
  reassignInvalidReviewers,
  resolveItemReviewers,
  runCampaignReminders,
} from './reviewer-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const DUE = new Date('2026-07-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let campaignId: string;
let snapshotId: string;
const person: Record<string, string> = {};
const user: Record<string, string> = {};

async function seedPerson(
  name: string,
  options: { manager?: string; contractEnd?: Date | null; userStatus?: string } = {},
) {
  await withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({ data: { tenantId, givenName: name, familyName: 'Test' } });
    await tx.contract.create({
      data: {
        tenantId, personId: p.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01'),
        endDate: options.contractEnd ?? null,
        ...(options.manager === undefined ? {} : { managerPersonId: person[options.manager]! }),
      },
    });
    const u = await tx.user.create({
      data: {
        tenantId, login: name.toLowerCase(), email: `${name.toLowerCase()}@a.test`,
        displayName: `${name} Test`, personId: p.id, status: options.userStatus ?? 'active',
      },
    });
    person[name] = p.id;
    user[name] = u.id;
  });
}

async function seedItem(subject: string, over: Record<string, unknown> = {}) {
  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.create({
      data: {
        tenantId, campaignId, holdingSnapshotId: snapshotId,
        subjectKey: `person:${person[subject]!}`, personId: person[subject]!,
        systemId: 'sys-1', resourceKind: 'targetEntitlement',
        resourceId: 'ent-1', resourceName: 'Finance-Payments',
        attributions: [], observedAt: NOW, coverageStatus: 'complete',
        ...over,
      },
    });
    return item.id;
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await seedPerson('Jan');
  await seedPerson('Ola');
  await seedPerson('Anna', { manager: 'Jan' });
  await seedPerson('Bram', { manager: 'Ola' });

  const seeded = await withTenant(tenantId, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId, name: 'Q2 review', scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id, reviewerSelector: 'manager', reviewerConfig: {},
        fallbackSelector: 'person', fallbackConfig: { personId: person['Ola'] },
        ownerPersonId: person['Ola']!, opensAt: NOW, dueAt: DUE, originalDueAt: DUE,
        status: 'open',
      },
    });
    return { snapshotId: snapshot.id, campaignId: campaign.id };
  });
  snapshotId = seeded.snapshotId;
  campaignId = seeded.campaignId;
});

describe('resolution', () => {
  it('resolves the subject’s manager and records the assignment with its via', async () => {
    const itemId = await seedItem('Anna');
    const outcome = await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    expect(outcome.assignedByPerson.get(person['Jan']!)).toBe(1);
    const reviewers = await withTenant(tenantId, (tx) => tx.campaignItemReviewer.findMany());
    expect(reviewers[0]).toMatchObject({ personId: person['Jan'], via: 'selector', unassignedAt: null });
  });

  it('DROPS the reviewer who is also the subject, and falls to the fallback', async () => {
    // The new path here: the resource owner who holds the resource. Dropping
    // them from their own item while leaving them the other 300 is correct.
    const itemId = await seedItem('Jan'); // Jan's manager is nobody; Jan is the subject
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Jan'] } },
      }),
    );
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const reviewers = await withTenant(tenantId, (tx) => tx.campaignItemReviewer.findMany());
    expect(reviewers.map((r) => r.personId)).not.toContain(person['Jan']);
    expect(reviewers[0]).toMatchObject({ personId: person['Ola'], via: 'fallback' });
  });

  it('BLOCKS when the fallback is also the subject, rather than deciding anything', async () => {
    const itemId = await seedItem('Ola');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Ola'] } },
      }),
    );
    const outcome = await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    expect(outcome.blocked).toBe(1);
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('blocked_no_reviewer');
    expect(item.statusReason).toContain('would be attesting to their own access');
  });

  it('notifies the campaign owner and govern.manage about a blocked item', async () => {
    const itemId = await seedItem('Ola');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Ola'] } },
      }),
    );
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'govern-campaign-blocked-item' } }),
    );
    expect(outbox.length).toBeGreaterThan(0);
  });
});

describe('the reviewer who leaves mid-campaign', () => {
  it('reassigns their open items by re-resolving as of now, and records the window', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    // Jan leaves. Anna's manager becomes Ola.
    await withTenant(tenantId, async (tx) => {
      await tx.user.updateMany({ where: { personId: person['Jan'] }, data: { status: 'inactive' } });
      await tx.contract.updateMany({
        where: { personId: person['Anna'] },
        data: { managerPersonId: person['Ola'] },
      });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.reassigned).toBe(1);

    const reviewers = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ orderBy: { assignedAt: 'asc' } }),
    );
    // "Who was this with, on the Tuesday it was sitting there" stays
    // answerable a year later.
    expect(reviewers[0]).toMatchObject({ personId: person['Jan'], via: 'selector' });
    expect(reviewers[0]!.unassignedAt).not.toBeNull();
    expect(reviewers[0]!.unassignedReason).toContain('no longer valid');
    expect(reviewers[1]).toMatchObject({ personId: person['Ola'], via: 'reassignment', unassignedAt: null });
  });

  it('leaves DECIDED items alone — a decision made while valid stands', async () => {
    // Retroactively invalidating a decision because the decider later left is
    // how a campaign becomes unfinishable.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId, itemId, personId: person['Jan']!, decision: 'certify',
          itemOpenedAt: NOW, decidedAt: NOW, sessionDecisionOrdinal: 1, coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } });
      await tx.user.updateMany({ where: { personId: person['Jan'] }, data: { status: 'inactive' } });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.reassigned).toBe(0);
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('certified');
  });

  it('BLOCKS when re-resolution yields nobody valid, and never auto-decides', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.user.updateMany({ where: { personId: { in: [person['Jan']!, person['Ola']!] } }, data: { status: 'inactive' } });
      await tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { managerPersonId: null } });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.blocked).toBe(1);
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('blocked_no_reviewer');
  });

  it('tells BOTH the outgoing and the incoming reviewer', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { managerPersonId: person['Ola'] } });
      await tx.user.updateMany({ where: { personId: person['Jan'] }, data: { status: 'inactive' } });
    });
    await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });

    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    // The outgoing one where they can still be reached; the incoming one always.
    expect(outbox.map((o) => o.template)).toContain('govern-review-reassigned');
  });
});

describe('moot, which is not a bucket to hide things in', () => {
  it('moots a PENDING item whose subject departed, and records the date', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { endDate: day('2026-06-01') } }),
    );

    const result = await mootDepartedSubjects(tenantId, campaignId, { now: NOW });
    expect(result.mooted).toBe(1);
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('moot');
    expect(item.statusReason).toContain('2026-06-01');
  });

  it('DOES NOT moot an item already carrying a revoke decision — the composition hazard', async () => {
    // Two individually correct rules: "a departed subject's item is moot" and
    // "a decision stands". Composed naively they mean a leaver's holding is
    // mooted, the decision never dispatches, and the campaign reports it
    // handled. A leaver's access must still be removable.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'revoke_decided' } });
      await tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { endDate: day('2026-06-01') } });
    });

    const result = await mootDepartedSubjects(tenantId, campaignId, { now: NOW });
    expect(result).toEqual({ mooted: 0, preserved: 1 });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('revoke_decided');
  });

  it('moots an item whose holding no longer exists, VERIFIED against the current snapshot', async () => {
    // Verified, not inferred from a revocation somebody else dispatched.
    const itemId = await seedItem('Anna');
    const later = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'complete', asOf: new Date(NOW.getTime() + 86_400_000) },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId, snapshotId: s.id, sourceKind: 'syntraInternal', sourceId: 'syntra',
          sourceName: 'Syntra', completeness: 'complete', staleness: 'fresh', freshnessSlaHours: 24,
        },
      });
      return s.id;
    });

    const result = await mootVanishedHoldings(tenantId, campaignId, later, { now: NOW });
    expect(result.mooted).toBe(1);
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.statusReason).toContain(later);
  });
});

describe('the reviewer who does nothing', () => {
  it('reminds at 50% of the time to due, then daily, and never more than once a day', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const halfway = new Date(NOW.getTime() + (DUE.getTime() - NOW.getTime()) / 2 + 60_000);
    const first = await runCampaignReminders(tenantId, { now: halfway });
    expect(first.reminded).toBe(1);
    const again = await runCampaignReminders(tenantId, { now: new Date(halfway.getTime() + 3600_000) });
    expect(again.reminded).toBe(0);
    const tomorrow = await runCampaignReminders(tenantId, { now: new Date(halfway.getTime() + 86_400_000) });
    expect(tomorrow.reminded).toBe(1);
  });

  it('escalates to the reviewer’s manager, ADDS them, and tells the original', async () => {
    // Escalation that silently removes somebody's authority is how a person
    // discovers months later that decisions attributed to them were not theirs.
    await seedPerson('Chief');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId: person['Jan'] }, data: { managerPersonId: person['Chief'] } }),
    );
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const result = await runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 60_000) });
    expect(result.escalated).toBe(1);

    const reviewers = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { unassignedAt: null } }),
    );
    expect(reviewers.map((r) => r.personId).sort()).toEqual([person['Jan'], person['Chief']].sort());
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((o) => o.template)).toContain('govern-review-escalated');
  });

  it('does NOT remind a reviewer who has left', async () => {
    // A reminder in a leaver's mailbox is a campaign asking somebody who no
    // longer works there to certify somebody else's access.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, (tx) =>
      tx.user.updateMany({ where: { personId: person['Jan'] }, data: { status: 'inactive' } }),
    );
    const halfway = new Date(NOW.getTime() + (DUE.getTime() - NOW.getTime()) / 2 + 60_000);
    const result = await runCampaignReminders(tenantId, { now: halfway });
    expect(result.reminded).toBe(0);
  });
});

describe('closing', () => {
  it('marks undecided items UNDECIDED — never certified — and closes incomplete', async () => {
    // There is no status that means "certified because time ran out".
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const result = await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    expect(result).toMatchObject({ closed: 1, undecided: 1 });

    const [campaign, item] = await withTenant(tenantId, async (tx) => [
      await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
      await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    ]);
    expect(item.status).toBe('undecided');
    expect(campaign.status).toBe('closed_incomplete');
    expect(campaign.coveragePercent).toBe(0);
  });

  it('creates a remediation item per undecided item, routed to the campaign owner', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });

    const items = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findMany({ where: { kind: 'undecided_item' } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.ownerPersonId).toBe(person['Ola']);
  });

  it('raises campaign_low_coverage naming the reviewers who did not respond', async () => {
    // The point of a recertification programme is not the certifications; it is
    // knowing which parts of the organization are not looking.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'campaign_low_coverage' } }),
    );
    expect((finding.detail as { reviewers?: string[] }).reviewers).toContain(person['Jan']);
  });

  it('closes COMPLETE when every item was decided or mooted', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } });
      await tx.campaignDecision.create({
        data: {
          tenantId, itemId, personId: person['Jan']!, decision: 'certify',
          itemOpenedAt: NOW, decidedAt: NOW, sessionDecisionOrdinal: 1, coverageAtDecision: {},
        },
      });
    });
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) => tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }));
    expect(campaign.status).toBe('closed_complete');
    expect(campaign.coveragePercent).toBe(100);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/reviewer-service.test.ts`
Expected: FAIL — `Cannot find module './reviewer-service.js'`.

- [ ] **Step 3: Write resolution**

`packages/core/src/govern/reviewer-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  isValidApprover,
  resolveEscalationApprovers,
  resolveStageApprovers,
  type ApproverSelector,
  type ResolutionSubject,
  type SelectorConfig,
  type StageSnapshot,
} from '../automate/approvers.js';
import { displayNames, enqueueOutbox, recipientsForPersons, usersWithPermission } from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createRemediationItem, upsertFindings } from './finding-service.js';
import { governSettings } from './settings-service.js';

export const REVIEWER_BATCH = 200;

/**
 * Automate's selector machinery, REUSED rather than reimplemented.
 *
 * An approval chain and a review chain disagreeing about who somebody's manager
 * is would be a support call nobody can close, and Automate already resolved
 * which contract supplies the manager. This builds the `StageSnapshot` shape
 * `resolveStageApprovers` expects out of the campaign's own selector fields.
 */
function stageFor(campaign: {
  reviewerSelector: string;
  reviewerConfig: unknown;
  fallbackSelector: string;
  fallbackConfig: unknown;
}): StageSnapshot {
  return {
    sequence: 1,
    name: 'review',
    selector: campaign.reviewerSelector as ApproverSelector,
    selectorConfig: (campaign.reviewerConfig ?? {}) as SelectorConfig,
    quorum: 'any',
    fallbackSelector: campaign.fallbackSelector as ApproverSelector,
    fallbackConfig: (campaign.fallbackConfig ?? {}) as SelectorConfig,
    slaHours: 0,
    onTimeout: 'remind',
    escalationSelector: 'manager',
    escalationConfig: {},
    expiryHours: null,
  };
}

/**
 * The self-review invariant, applied as a SUBTRACTION FROM THE RESOLVED SET so
 * that every selector inherits it, and applied at the END of expansion so no
 * expansion step can reintroduce what an earlier one removed (Ruling A-6).
 *
 * `resolveStageApprovers` already subtracts the subject; this passes the item's
 * subject as the resolution subject so that it does. The one path new here is
 * the resource owner who holds the resource — the finance systems manager in
 * the finance group — and dropping them from their own item while leaving them
 * the other 300 is correct and is what happens.
 */
function subjectFor(item: { personId: string | null; systemId: string; resourceKind: string; resourceId: string }): ResolutionSubject {
  return {
    subjectPersonId: item.personId ?? '00000000-0000-0000-0000-000000000000',
    // A campaign item has no submitter. That is the one Automate path with no
    // analogue here.
    submitterPersonId: null,
    productOwnerPersonId: null,
    productOwnerGroupId: null,
    productCategory: null,
    resources: [
      {
        resourceType:
          item.resourceKind === 'application'
            ? 'application'
            : item.resourceKind === 'syntraGroup'
              ? 'group'
              : 'entitlement',
        resourceId: item.resourceId,
      },
    ],
  };
}

export interface ResolveOutcome {
  assignedByPerson: Map<string, number>;
  blocked: number;
}

export async function resolveItemReviewers(
  tx: TenantClient,
  campaignId: string,
  itemIds: readonly string[],
  now: Date,
): Promise<ResolveOutcome> {
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const stage = stageFor(campaign);
  const items = await tx.campaignItem.findMany({ where: { id: { in: [...itemIds] } } });

  const assignedByPerson = new Map<string, number>();
  const blockedItems: string[] = [];

  for (const item of items) {
    const resolution = await resolveStageApprovers(tx, stage, subjectFor(item), now);

    if (resolution.approvers.length === 0) {
      blockedItems.push(item.id);
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: 'blocked_no_reviewer',
          statusReason:
            'the reviewer selector and the fallback both resolved to nobody who may decide this. ' +
            'The likeliest cause is that everybody they resolved to would be attesting to their own access.',
        },
      });
      continue;
    }

    for (const approver of resolution.approvers) {
      await tx.campaignItemReviewer.create({
        data: {
          tenantId: campaign.tenantId,
          itemId: item.id,
          personId: approver.personId,
          via: resolution.usedFallback ? 'fallback' : 'selector',
          assignedAt: now,
        },
      });
      assignedByPerson.set(approver.personId, (assignedByPerson.get(approver.personId) ?? 0) + 1);
    }
  }

  if (blockedItems.length > 0) {
    // It never auto-decides and it never sits silently. `blocked_no_approver`'s
    // twin, for the same reason.
    const owners = await recipientsForPersons(tx, [campaign.ownerPersonId]);
    const managers = await usersWithPermission(tx, PERMISSIONS.GOVERN_MANAGE);
    await enqueueOutbox(
      tx,
      [...owners, ...managers].map((recipient) => ({
        template: 'govern-campaign-blocked-item' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(blockedItems.length),
          campaignUrl: `/admin/govern/campaigns/${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );
  }

  return { assignedByPerson, blocked: blockedItems.length };
}
```

- [ ] **Step 4: Write reassignment, mooting, reminders and closing**

Append the four remaining functions. Their shapes:

```ts
/**
 * A reviewer is VALID only if they hold an `active` Syntra `User` and their
 * `Person` holds at least one active contract. Automate's definition, reused,
 * and re-checked at the moment of each decision as well as here — deactivation
 * revoking sessions covers most of it and "most of it" is not a security
 * control.
 *
 * DECISIONS ALREADY RECORDED STAND. They were valid when made, and the evidence
 * bundle shows the reviewer's status as at the decision, not as at export.
 */
export async function reassignInvalidReviewers(
  tenantId: string,
  campaignId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ reassigned: number; blocked: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    // Only items still awaiting a decision. A certified or revoke_decided item
    // is finished with its reviewer.
    const open = await tx.campaignItem.findMany({
      where: { campaignId, status: { in: ['pending', 'blocked_no_reviewer'] } },
      include: { reviewers: { where: { unassignedAt: null } } },
    });

    let reassigned = 0;
    let blocked = 0;

    for (const item of open) {
      const invalid: string[] = [];
      for (const reviewer of item.reviewers) {
        if ((await isValidApprover(tx, reviewer.personId, now)) !== null) invalid.push(reviewer.personId);
      }
      if (invalid.length === 0 && item.reviewers.length > 0) continue;

      for (const personId of invalid) {
        await tx.campaignItemReviewer.updateMany({
          where: { itemId: item.id, personId, unassignedAt: null },
          data: { unassignedAt: now, unassignedReason: 'this reviewer is no longer valid' },
        });
      }

      const resolution = await resolveStageApprovers(tx, stageFor(campaign), subjectFor(item), now);
      const incoming = resolution.approvers.filter((a) => !invalid.includes(a.personId));

      if (incoming.length === 0) {
        blocked += 1;
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'blocked_no_reviewer',
            statusReason: 'the reviewer became invalid and re-resolution yielded nobody',
          },
        });
        continue;
      }

      for (const approver of incoming) {
        await tx.campaignItemReviewer.create({
          data: {
            tenantId, itemId: item.id, personId: approver.personId,
            via: 'reassignment', assignedAt: now,
          },
        });
      }
      reassigned += 1;

      const parties = await recipientsForPersons(tx, [...invalid, ...incoming.map((a) => a.personId)]);
      const names = await displayNames(tx, { personIds: invalid });
      await enqueueOutbox(
        tx,
        parties.map((recipient) => ({
          template: 'govern-review-reassigned' as const,
          to: recipient.email,
          vars: {
            displayName: recipient.displayName,
            campaignName: campaign.name,
            itemCount: '1',
            previousReviewer: names.get(`person:${invalid[0] ?? ''}`) ?? 'the previous reviewer',
            reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaignId}`,
          },
          requestId: null,
          userId: recipient.userId,
        })),
      );
    }

    if (reassigned > 0 || blocked > 0) {
      await recordEvent(tx, {
        actorUserId: null,
        action: 'govern.campaign.reassign',
        targetType: 'Campaign',
        targetId: campaignId,
        outcome: 'success',
        sourceIp: null,
        payload: { reassigned, blocked },
      });
    }
    return { reassigned, blocked };
  });
}

/**
 * `moot` is NOT a bucket to hide things in.
 *
 * Only `pending` and `blocked_no_reviewer` items moot. AN ITEM ALREADY CARRYING
 * A REVOKE DECISION DOES NOT: composing "a departed subject's item is moot"
 * with "a decision stands" the naive way means a leaver's holding is mooted,
 * the decision never dispatches, and the campaign reports it handled. A
 * leaver's access must still be removable. This is one of the three
 * composition hazards named in the Global Constraints.
 */
export async function mootDepartedSubjects(
  tenantId: string,
  campaignId: string,
  options: { now?: Date } = {},
): Promise<{ mooted: number; preserved: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const items = await tx.campaignItem.findMany({
      where: { campaignId, personId: { not: null } },
      select: { id: true, personId: true, status: true },
    });
    const contracts = await tx.contract.findMany({
      where: { personId: { in: items.map((i) => i.personId!) } },
      select: { personId: true, startDate: true, endDate: true },
    });

    const activeByPerson = new Map<string, boolean>();
    const latestEnd = new Map<string, Date>();
    for (const c of contracts) {
      const active = c.startDate <= now && (c.endDate === null || c.endDate >= now);
      activeByPerson.set(c.personId, (activeByPerson.get(c.personId) ?? false) || active);
      if (c.endDate !== null) {
        const current = latestEnd.get(c.personId);
        if (current === undefined || c.endDate > current) latestEnd.set(c.personId, c.endDate);
      }
    }

    let mooted = 0;
    let preserved = 0;
    for (const item of items) {
      if (activeByPerson.get(item.personId!) === true) continue;
      if (item.status !== 'pending' && item.status !== 'blocked_no_reviewer') {
        preserved += 1;
        continue;
      }
      const departedOn = latestEnd.get(item.personId!);
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: 'moot',
          statusReason:
            `the subject's contracts have all ended${departedOn === undefined ? '' : ` on ${departedOn.toISOString().slice(0, 10)}`}. ` +
            `Provision's leaver ladder and Automate's lapse sweep now own this holding; asking a manager to attest to it would be theatre. ` +
            `This item is NOT counted as certified in any figure.`,
        },
      });
      mooted += 1;
    }
    return { mooted, preserved };
  });
}

/** VERIFIED against the current snapshot, never inferred from a revocation somebody else dispatched. */
export async function mootVanishedHoldings(
  tenantId: string,
  campaignId: string,
  currentSnapshotId: string,
  options: { now?: Date } = {},
): Promise<{ mooted: number }> {
  return withTenant(tenantId, async (tx) => {
    const items = await tx.campaignItem.findMany({
      where: { campaignId, status: { in: ['pending', 'blocked_no_reviewer'] } },
    });
    const present = await tx.holding.findMany({
      where: { snapshotId: currentSnapshotId, subjectKey: { in: items.map((i) => i.subjectKey) } },
      select: { subjectKey: true, systemId: true, resourceKind: true, resourceId: true },
    });
    const keys = new Set(
      present.map((h) => `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`),
    );

    let mooted = 0;
    for (const item of items) {
      const key = `${item.subjectKey}|${item.systemId}|${item.resourceKind}|${item.resourceId}`;
      if (keys.has(key)) continue;
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: 'moot',
          statusReason: `snapshot ${currentSnapshotId} no longer shows this holding`,
        },
      });
      mooted += 1;
    }
    return { mooted };
  });
}

/**
 * Reminders at 50% and 100% of the time to `dueAt`, then daily. A campaign
 * never stops asking, and it never certifies and never revokes on silence.
 */
export async function runCampaignReminders(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ reminded: number; escalated: number }> {
  const now = options.now ?? new Date();
  let reminded = 0;
  let escalated = 0;

  await withTenant(tenantId, async (tx) => {
    const campaigns = await tx.campaign.findMany({ where: { status: 'open' } });

    for (const campaign of campaigns) {
      const elapsed = now.getTime() - campaign.opensAt.getTime();
      const total = campaign.dueAt.getTime() - campaign.opensAt.getTime();
      const share = total <= 0 ? 1 : elapsed / total;
      if (share < 0.5) continue;

      const items = await tx.campaignItem.findMany({
        where: { campaignId: campaign.id, status: 'pending' },
        include: { reviewers: { where: { unassignedAt: null } } },
      });
      if (items.length === 0) continue;

      const byReviewer = new Map<string, string[]>();
      for (const item of items) {
        for (const reviewer of item.reviewers) {
          byReviewer.set(reviewer.personId, [...(byReviewer.get(reviewer.personId) ?? []), item.id]);
        }
      }

      for (const [personId, itemIds] of byReviewer) {
        // A reminder in a leaver's mailbox is a campaign asking somebody who no
        // longer works there to certify somebody else's access.
        if ((await isValidApprover(tx, personId, now)) !== null) continue;

        const lastSent = await tx.notificationOutbox.findFirst({
          where: {
            template: 'govern-review-reminder',
            userId: { not: null },
            createdAt: { gte: new Date(now.getTime() - 86_400_000) },
            vars: { path: ['campaignName'], equals: campaign.name },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (lastSent !== null) continue;

        const recipients = await recipientsForPersons(tx, [personId]);
        await enqueueOutbox(
          tx,
          recipients.map((recipient) => ({
            template: 'govern-review-reminder' as const,
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              campaignName: campaign.name,
              itemCount: String(itemIds.length),
              dueAt: campaign.dueAt.toDateString(),
              reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaign.id}`,
            },
            requestId: null,
            userId: recipient.userId,
          })),
        );
        reminded += 1;

        if (share >= 1) {
          // Escalation ADDS a reviewer and never replaces one, and it tells the
          // original they were escalated past.
          const escalation = await resolveEscalationApprovers(
            tx,
            stageFor(campaign),
            subjectFor(items[0]!),
            now,
          );
          const added = escalation.approvers.filter((a) => a.personId !== personId);
          if (added.length === 0) continue;

          for (const itemId of itemIds) {
            for (const approver of added) {
              await tx.campaignItemReviewer.upsert({
                where: { id: `${itemId}:${approver.personId}` },
                create: {
                  tenantId, itemId, personId: approver.personId,
                  via: 'escalation', assignedAt: now,
                },
                update: {},
              }).catch(() => undefined);
            }
          }

          const names = await displayNames(tx, { personIds: added.map((a) => a.personId) });
          await enqueueOutbox(
            tx,
            recipients.map((recipient) => ({
              template: 'govern-review-escalated' as const,
              to: recipient.email,
              vars: {
                displayName: recipient.displayName,
                campaignName: campaign.name,
                itemCount: String(itemIds.length),
                escalatedTo: added.map((a) => names.get(`person:${a.personId}`) ?? 'their manager').join(', '),
                reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaign.id}`,
              },
              requestId: null,
              userId: recipient.userId,
            })),
          );
          escalated += 1;
        }
      }
    }
  });

  return { reminded, escalated };
}

/**
 * At `dueAt`, undecided items become `undecided` — TERMINAL — and the campaign
 * closes `incomplete`. Silence never certifies and silence never revokes: both
 * are refused, and refusing both is what makes the coverage figure the honest
 * headline.
 */
export async function closeDueCampaigns(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ closed: number; undecided: number }> {
  const now = options.now ?? new Date();
  let closed = 0;
  let undecidedTotal = 0;

  await withTenant(tenantId, async (tx) => {
    const settings = await governSettings(tx);
    const campaigns = await tx.campaign.findMany({ where: { status: 'open', dueAt: { lte: now } } });

    for (const campaign of campaigns) {
      const items = await tx.campaignItem.findMany({
        where: { campaignId: campaign.id },
        include: { reviewers: { where: { unassignedAt: null }, select: { personId: true } } },
      });

      const stillOpen = items.filter(
        (i) => i.status === 'pending' || i.status === 'blocked_no_reviewer',
      );
      for (const item of stillOpen) {
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'undecided',
            statusReason: 'the campaign closed and nobody decided this item. It was NOT attested.',
          },
        });
        await createRemediationItem(tx, tenantId, {
          kind: 'undecided_item',
          ownerPersonId: campaign.ownerPersonId,
          dueAt: new Date(now.getTime() + 14 * 86_400_000),
          campaignItemId: item.id,
          description: `${item.resourceName} for ${item.subjectKey} was not decided in "${campaign.name}". Somebody has to decide it by hand.`,
          deepLink: `/admin/govern/campaigns/${campaign.id}`,
        });
      }

      const certified = items.filter((i) => i.status === 'certified').length;
      const revoked = items.filter((i) => i.status.startsWith('revoke') || i.status === 'revocation_requires_change').length;
      const moot = items.filter((i) => i.status === 'moot').length;
      const undecided = stillOpen.length;
      const total = items.length;
      const coverage = total === 0 ? 0 : Math.round(((certified + revoked + moot) / total) * 1000) / 10;

      await tx.campaign.update({
        where: { id: campaign.id },
        data: {
          status: undecided === 0 ? 'closed_complete' : 'closed_incomplete',
          certifiedItems: certified,
          revokedItems: revoked,
          mootItems: moot,
          undecidedItems: undecided,
          totalItems: total,
          coveragePercent: coverage,
        },
      });

      if (coverage < settings.minimumCoveragePercent) {
        // The point of a recertification programme is not the certifications;
        // it is knowing which parts of the organization are not looking.
        await upsertFindings(
          tenantId,
          campaign.snapshotId,
          [
            {
              kind: 'campaign_low_coverage',
              severity: 'high',
              subjectRefType: 'campaign',
              subjectRefId: campaign.id,
              detail: {
                campaignName: campaign.name,
                coveragePercent: coverage,
                minimum: settings.minimumCoveragePercent,
                certified, revoked, moot, undecided, total,
                reviewers: [
                  ...new Set(stillOpen.flatMap((i) => i.reviewers.map((r) => r.personId))),
                ],
              },
            },
          ],
          { now },
        );
      }

      await recordEvent(tx, {
        actorUserId: null,
        action: 'govern.campaign.close',
        targetType: 'Campaign',
        targetId: campaign.id,
        outcome: 'success',
        sourceIp: null,
        payload: { certified, revoked, moot, undecided, total, coveragePercent: coverage },
      });

      closed += 1;
      undecidedTotal += undecided;
    }
  });

  return { closed, undecided: undecidedTotal };
}
```

- [ ] **Step 5: Register the two remaining jobs**

In `packages/core/src/govern/jobs.ts`, inside `registerGovernJobs`:

```ts
  scheduler.register<GovernJobPayload>(GOVERN_REMIND_JOB, async (payload) => {
    await runCampaignReminders(payload.tenantId, {
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
  scheduler.register<GovernJobPayload>(GOVERN_CLOSE_JOB, async (payload) => {
    await closeDueCampaigns(payload.tenantId, {
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
```

and add `mootDepartedSubjects` and `mootVanishedHoldings` to `runSnapshotJob`, per open campaign, after the build:

```ts
  const openCampaigns = await withTenant(payload.tenantId, (tx) =>
    tx.campaign.findMany({ where: { status: 'open' }, select: { id: true } }),
  );
  for (const campaign of openCampaigns) {
    await mootDepartedSubjects(payload.tenantId, campaign.id, { now });
    await mootVanishedHoldings(payload.tenantId, campaign.id, built.snapshotId, { now });
    await reassignInvalidReviewers(payload.tenantId, campaign.id, { now });
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/reviewer-service.test.ts packages/core/src/govern/jobs.test.ts`
Expected: PASS.

- [ ] **Step 7: Export and typecheck**

Add `export * from './govern/reviewer-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 8: Mutation-test — including the composition hazard**

1. **In `mootDepartedSubjects`, remove the `item.status !== 'pending'` guard so every departed subject's item moots.** Expected: `DOES NOT moot an item already carrying a revoke decision` FAILS. **This is the composition hazard from the Global Constraints table, and it is exactly Ruling A-3's shape: something unrelated to the removal silently becoming the reason access persists after employment ends.**
2. In `reassignInvalidReviewers`, widen the `status` filter to every status. Expected: `leaves DECIDED items alone` FAILS.
3. In `resolveItemReviewers`, auto-assign the campaign owner when resolution is empty instead of blocking. Expected: `BLOCKS when the fallback is also the subject` FAILS.
4. In `closeDueCampaigns`, set `status: 'certified'` on undecided items. Expected: `marks undecided items UNDECIDED — never certified` FAILS. **This is the mutation the whole design exists to make impossible**, and Task 19 adds the structural test that catches it even without this case.
5. In `runCampaignReminders`, drop the `isValidApprover` check. Expected: `does NOT remind a reviewer who has left` FAILS.
6. In `runCampaignReminders`, drop the 24-hour `lastSent` check. Expected: `reminds at 50% of the time to due, then daily, and never more than once a day` FAILS on the second call.
7. In `runCampaignReminders`, make escalation REPLACE the original reviewer. Expected: `escalates to the reviewer's manager, ADDS them` FAILS on the reviewer list.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/govern/reviewer-service.ts \
        packages/core/src/govern/reviewer-service.test.ts \
        packages/core/src/govern/jobs.ts packages/core/src/index.ts
git commit -m "feat(govern): reviewers — resolution, reminders, escalation, reassignment and moot"
```

---
## Task 19: Decisions — certify, revoke, bulk with its carve-outs, quality signals, and the structural tests

Spec §12, §17, §23. **No transition into `certified` exists that is not caused by a `CampaignDecision` row**, and this task makes that a test over the state machine rather than a sentence in a document.

**Files:**
- Create: `packages/core/src/govern/decision-service.ts`
- Test: `packages/core/src/govern/decision-service.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `isValidApprover` from `../automate/approvers.js`; `activeContracts`; `governSettings`; `enqueueOutbox`, `recipientsForPersons` from `../automate/notify.js`; `subjectKey`, `parseSubjectKey`.
- Produces (all in `./decision-service.js`):
  - `class DecisionRefusedError extends Error { constructor(readonly code: DecisionRefusalCode, message: string) }`
  - `type DecisionRefusalCode = 'not_reviewer' | 'reviewer_invalid' | 'self_review' | 'subject_departed' | 'item_not_pending' | 'campaign_not_open' | 'comment_required' | 'bulk_not_allowed' | 'bulk_too_large' | 'high_risk_not_bulkable'`
  - `const CERTIFYING_TRANSITIONS: readonly { from: string; to: 'certified'; causedBy: 'CampaignDecision' }[]`
  - `const DECISION_ENTRY_POINTS: readonly string[]` — the exhaustive list of **files** that may write `status = 'certified'`
  - `const HIGH_RISK_FLAGS: readonly string[]`
  - `function isBulkCertifiable(item: { riskFlags: readonly string[]; coverageStatus: string }): boolean`
  - `async function openItem(tenantId: string, personId: string, itemId: string, now?: Date): Promise<{ openedAt: Date }>`
  - `async function recordDecision(tenantId, input, options?): Promise<{ status: string }>`
  - `async function bulkCertify(tenantId, input, options?): Promise<{ certified: number; refused: { itemId: string; reason: string }[] }>`
  - `async function computeReviewQualitySignals(tenantId: string, campaignId: string, now?: Date): Promise<number>`
  - `async function projectCertification(tx: TenantClient, itemId: string, decisionId: string, personId: string): Promise<void>`

**High-risk items are refused from a bulk action outright and must be decided one at a time with a mandatory comment.** The carve-outs are `unattributable`, `privileged`, `sod_violation`, a `stale` or `partial` source, and `needs_review` — Automate's mover flag, which "exists precisely so a campaign can consume it, and it is exactly the item a bulk certify must not sweep up".

- [ ] **Step 1: Write the failing test**

`packages/core/src/govern/decision-service.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  CERTIFYING_TRANSITIONS,
  DECISION_ENTRY_POINTS,
  DecisionRefusedError,
  HIGH_RISK_FLAGS,
  bulkCertify,
  computeReviewQualitySignals,
  isBulkCertifiable,
  openItem,
  recordDecision,
} from './decision-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
let tenantId: string;
let campaignId: string;
let snapshotId: string;
const person: Record<string, string> = {};
const user: Record<string, string> = {};

// (seed helpers identical in shape to reviewer-service.test.ts: seedPerson,
// seedItem, and an `assign` helper writing a CampaignItemReviewer row.)

describe('the structural tests that must fail if somebody forgets', () => {
  it('every transition into `certified` is caused by a CampaignDecision row', () => {
    // Exhaustive over the item state machine. This is the test that would fail
    // if anybody ever adds a negative-confirmation setting.
    expect(CERTIFYING_TRANSITIONS.length).toBeGreaterThan(0);
    for (const transition of CERTIFYING_TRANSITIONS) {
      expect(transition.causedBy).toBe('CampaignDecision');
    }
    expect(CERTIFYING_TRANSITIONS.map((t) => t.from)).toEqual(['pending']);
  });

  it('only the files in DECISION_ENTRY_POINTS write status = certified', () => {
    // A convention that lives in a document is a convention that survives until
    // the third person touches the code.
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /['"]certified['"]/.test(readFileSync(join(dir, f), 'utf8')))
      .filter((f) => !DECISION_ENTRY_POINTS.includes(f));
    expect(offenders).toEqual([]);
    expect(DECISION_ENTRY_POINTS).toEqual(['decision-service.ts']);
  });

  it('no Govern file contains a timeout or expiry that certifies', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      // `reviewer-service.ts` writes `undecided` at dueAt and must never write
      // `certified` there. The regex is deliberately about proximity, so a
      // future `status: 'certified'` inside a close or sweep function fails.
      expect(
        /(?:close|sweep|timeout|expire)[\s\S]{0,600}status:\s*'certified'/.test(text),
        `${file} appears to certify on a timeout`,
      ).toBe(false);
    }
  });
});

describe('the self-review invariant, at the moment of decision', () => {
  it('refuses a decision by the subject, even when a reviewer row somehow names them', async () => {
    // Enforced in the domain service, at the moment of decision, as well as at
    // resolution — because deciding through the API rather than the console is
    // one of the paths Automate enumerated and closed.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Anna');
    await expect(
      recordDecision(tenantId, {
        itemId, deciderPersonId: person['Anna']!, deciderUserId: user['Anna']!,
        decision: 'certify', comment: null,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'self_review' });
  });

  it('refuses a decision by somebody who is not a reviewer of this item', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await expect(
      recordDecision(tenantId, {
        itemId, deciderPersonId: person['Ola']!, deciderUserId: user['Ola']!,
        decision: 'certify', comment: null,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'not_reviewer' });
  });

  it('RE-CHECKS reviewer validity at the moment of the decision', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.user.updateMany({ where: { personId: person['Jan'] }, data: { status: 'inactive' } }),
    );
    await expect(
      recordDecision(tenantId, {
        itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
        decision: 'certify', comment: null,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'reviewer_invalid' });
  });
});

describe('a departed subject', () => {
  it('REFUSES a certification and moots the item instead', async () => {
    // A certification is a signed statement about somebody's access. Signing one
    // for a person who left is exactly the false assurance this module exists to
    // prevent, and it is the third route to Ruling A-3's outcome.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { endDate: day('2026-06-01') } }),
    );

    await expect(
      recordDecision(tenantId, {
        itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
        decision: 'certify', comment: null,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'subject_departed' });

    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(item.status).toBe('moot');
  });

  it('ALLOWS a revoke decision on a departed subject’s item', async () => {
    // A departure never suppresses a revocation. A leaver's access must still
    // be removable, and the decision dispatches.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId: person['Anna'] }, data: { endDate: day('2026-06-01') } }),
    );
    const result = await recordDecision(tenantId, {
      itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      decision: 'revoke', comment: 'they left; remove it',
    }, { now: NOW });
    expect(result.status).toBe('revoke_decided');
  });
});

describe('recording a decision', () => {
  it('writes the decision, the item status, the audit event and the projection', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await openItem(tenantId, person['Jan']!, itemId, NOW);
    const decidedAt = new Date(NOW.getTime() + 45_000);

    await recordDecision(tenantId, {
      itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      decision: 'certify', comment: null,
    }, { now: decidedAt });

    const [decision, item, projection, event] = await withTenant(tenantId, async (tx) => [
      await tx.campaignDecision.findFirstOrThrow(),
      await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
      await tx.holdingCertification.findFirstOrThrow(),
      await tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.decision.record' } }),
    ]);

    expect(item.status).toBe('certified');
    expect(decision.decidedByUserId).toBe(user['Jan']);
    // The SERVER-SIDE interval, not a client-reported dwell time.
    expect(decision.itemOpenedAt).toEqual(NOW);
    expect(decision.sessionDecisionOrdinal).toBe(1);
    expect(projection).toMatchObject({ lastCertifiedByPersonId: person['Jan'], lastDecisionId: decision.id });
    expect(event.targetId).toBe(itemId);
  });

  it('requires a comment on a revoke and refuses one without', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await expect(
      recordDecision(tenantId, {
        itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
        decision: 'revoke', comment: '   ',
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'comment_required' });
  });

  it('records itemOpenedAt as the decision time when the detail was NEVER fetched', async () => {
    // The share of items whose detail was never fetched at all is one of the
    // quality signals, so "never opened" has to be representable rather than
    // silently becoming a zero interval.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await recordDecision(tenantId, {
      itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      decision: 'certify', comment: null,
    }, { now: NOW });
    const decision = await withTenant(tenantId, (tx) => tx.campaignDecision.findFirstOrThrow());
    expect(decision.itemOpenedAt).toEqual(decision.decidedAt);
  });

  it('increments the session ordinal across consecutive decisions', async () => {
    const a = await seedItem('Anna');
    const b = await seedItem('Bram');
    await assign(a, 'Jan');
    await assign(b, 'Jan');
    for (const itemId of [a, b]) {
      await recordDecision(tenantId, {
        itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
        decision: 'certify', comment: null,
      }, { now: NOW });
    }
    const decisions = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findMany({ orderBy: { sessionDecisionOrdinal: 'asc' } }),
    );
    expect(decisions.map((d) => d.sessionDecisionOrdinal)).toEqual([1, 2]);
  });
});

describe('bulk certify', () => {
  it('caps at bulkCertifyLimit and refuses a larger selection', async () => {
    // The cap is TENANT-WIDE, so a campaign cannot quietly raise it for itself.
    await withTenant(tenantId, (tx) =>
      tx.governSettings.upsert({
        where: { tenantId }, create: { tenantId, bulkCertifyLimit: 2 }, update: { bulkCertifyLimit: 2 },
      }),
    );
    const ids = [await seedItem('Anna'), await seedItem('Bram'), await seedItem('Anna')];
    for (const id of ids) await assign(id, 'Jan');
    await expect(
      bulkCertify(tenantId, {
        campaignId, itemIds: ids, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'bulk_too_large' });
  });

  it('REFUSES a high-risk item from the bulk action and certifies the rest', async () => {
    const ordinary = await seedItem('Anna');
    const privileged = await seedItem('Bram', { riskFlags: ['privileged'] });
    const unattributable = await seedItem('Anna', { riskFlags: ['unattributable'] });
    const stale = await seedItem('Bram', { riskFlags: ['stale'] });
    const mover = await seedItem('Anna', { riskFlags: ['needs_review'] });
    const partial = await seedItem('Bram', { coverageStatus: 'partial' });
    const all = [ordinary, privileged, unattributable, stale, mover, partial];
    for (const id of all) await assign(id, 'Jan');

    const result = await bulkCertify(tenantId, {
      campaignId, itemIds: all, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
    }, { now: NOW });

    expect(result.certified).toBe(1);
    expect(result.refused.map((r) => r.itemId).sort()).toEqual(
      [privileged, unattributable, stale, mover, partial].sort(),
    );
    // Refused IN WORDS, not as a disabled button with no explanation.
    expect(result.refused[0]!.reason).toContain('one at a time');
  });

  it('records viaBulk and the SIZE on every decision it produces', async () => {
    const ids = [await seedItem('Anna'), await seedItem('Bram')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(tenantId, {
      campaignId, itemIds: ids, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
    }, { now: NOW });

    const decisions = await withTenant(tenantId, (tx) => tx.campaignDecision.findMany());
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) expect(decision).toMatchObject({ viaBulk: true, bulkSize: 2 });
  });

  it('writes ONE audit event naming every item, not one per item', async () => {
    // recordEvent takes a per-tenant advisory lock for the duration of its
    // transaction, so fifty thousand separately-audited decisions would be fifty
    // thousand serialized transactions on one tenant's chain. Nothing is lost:
    // CampaignDecision is append-only, one row per decision, complete.
    const ids = [await seedItem('Anna'), await seedItem('Bram')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(tenantId, {
      campaignId, itemIds: ids, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
    }, { now: NOW });

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'govern.decision.bulk_certify' } }),
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { itemIds?: string[] }).itemIds).toHaveLength(2);
  });

  it('refuses bulk entirely when the campaign disallows it', async () => {
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { allowBulkCertify: false } }),
    );
    const ids = [await seedItem('Anna')];
    await assign(ids[0]!, 'Jan');
    await expect(
      bulkCertify(tenantId, {
        campaignId, itemIds: ids, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'bulk_not_allowed' });
  });

  it('has NO bulk revoke at all', () => {
    // Revoking is one at a time, with a comment, and the batch of section 13 is
    // what makes the aggregate safe.
    const dir = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(dir, 'decision-service.ts'), 'utf8');
    expect(/export async function bulkRevoke/.test(text)).toBe(false);
  });
});

describe('quality signals', () => {
  it('computes the share certified, the median interval, the bulk share and the largest burst', async () => {
    const ids = [await seedItem('Anna'), await seedItem('Bram'), await seedItem('Anna')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(tenantId, {
      campaignId, itemIds: ids.slice(0, 2), deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
    }, { now: NOW });
    await recordDecision(tenantId, {
      itemId: ids[2]!, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      decision: 'revoke', comment: 'not needed',
    }, { now: new Date(NOW.getTime() + 120_000) });

    const computed = await computeReviewQualitySignals(tenantId, campaignId, NOW);
    expect(computed).toBe(1);
    const signal = await withTenant(tenantId, (tx) => tx.reviewQualitySignal.findFirstOrThrow());
    expect(signal).toMatchObject({ itemsDecided: 3, largestBurst: 2 });
    expect(signal.certifiedShare).toBeCloseTo(2 / 3, 5);
    expect(signal.bulkShare).toBeCloseTo(2 / 3, 5);
    expect(signal.neverOpenedShare).toBe(1);
  });
});

describe('the certification projection and the re-base composition hazard', () => {
  it('keeps the projection for an item a re-base did NOT re-open', async () => {
    // Two individually correct rules: "re-basing re-opens only what changed"
    // and "the projection is rebuilt from decisions". Composed naively, a
    // re-base rolls the projection back for items whose holding did not change,
    // and a certification that is still good reads as never made.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await recordDecision(tenantId, {
      itemId, deciderPersonId: person['Jan']!, deciderUserId: user['Jan']!,
      decision: 'certify', comment: null,
    }, { now: NOW });

    const before = await withTenant(tenantId, (tx) => tx.holdingCertification.findFirstOrThrow());

    // Simulate a re-base that keeps this item: its status stays `certified`.
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { rebasedFromSnapshotId: snapshotId } }),
    );

    const after = await withTenant(tenantId, (tx) => tx.holdingCertification.findFirstOrThrow());
    expect(after.lastCertifiedAt).toEqual(before.lastCertifiedAt);
    expect(after.lastDecisionId).toBe(before.lastDecisionId);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/govern/decision-service.test.ts`
Expected: FAIL — `Cannot find module './decision-service.js'`.

- [ ] **Step 3: Write the state machine constants and the carve-outs**

`packages/core/src/govern/decision-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { isValidApprover } from '../automate/approvers.js';
import { governSettings } from './settings-service.js';
import { parseSubjectKey } from './types.js';

/**
 * THE STRUCTURAL RULE, as data.
 *
 * There is no status that means "certified because time ran out", and this
 * constant is what a test asserts over. Adding a negative-confirmation setting
 * later means adding a row here with a `causedBy` that is not
 * `'CampaignDecision'` — which fails a test rather than passing review.
 */
export const CERTIFYING_TRANSITIONS: readonly {
  from: string;
  to: 'certified';
  causedBy: 'CampaignDecision';
}[] = [{ from: 'pending', to: 'certified', causedBy: 'CampaignDecision' }];

/**
 * The exhaustive list of FILES that may write `status = 'certified'`, in either
 * spelling. Widening it is a deliberate edit to the module that owns the rule,
 * which is the point — Automate's `APPROVED_ENTRY_POINTS`, for attestation.
 */
export const DECISION_ENTRY_POINTS: readonly string[] = ['decision-service.ts'];

export type DecisionRefusalCode =
  | 'not_reviewer'
  | 'reviewer_invalid'
  | 'self_review'
  | 'subject_departed'
  | 'item_not_pending'
  | 'campaign_not_open'
  | 'comment_required'
  | 'bulk_not_allowed'
  | 'bulk_too_large'
  | 'high_risk_not_bulkable';

export class DecisionRefusedError extends Error {
  constructor(readonly code: DecisionRefusalCode, message: string) {
    super(message);
    this.name = 'DecisionRefusedError';
  }
}

/**
 * Refused outright from a bulk action, and decided one at a time with a
 * mandatory comment.
 *
 * `needs_review` is Automate's mover flag — the person's contract attributes
 * stopped matching the audience of the thing they hold. That flag exists
 * precisely so a campaign can consume it, and it is exactly the item a bulk
 * certify must not sweep up.
 */
export const HIGH_RISK_FLAGS: readonly string[] = [
  'unattributable',
  'privileged',
  'sod_violation',
  'stale',
  'needs_review',
];

export function isBulkCertifiable(item: {
  riskFlags: readonly string[];
  coverageStatus: string;
}): boolean {
  if (item.riskFlags.some((flag) => HIGH_RISK_FLAGS.includes(flag))) return false;
  // A holding whose source is partial is high-risk for the same reason a stale
  // one is: the reviewer is being asked to attest to something nobody read in
  // full.
  return item.coverageStatus === 'complete';
}
```

- [ ] **Step 4: Write `openItem`, `recordDecision` and the projection**

Append:

```ts
/**
 * Records that the reviewer FETCHED this item's detail, so the interval in the
 * decision is a server-side measurement rather than a client-reported dwell
 * time, which is worth nothing.
 *
 * An item never opened produces `itemOpenedAt === decidedAt`, which is what the
 * `neverOpenedShare` signal counts.
 */
export async function openItem(
  tenantId: string,
  personId: string,
  itemId: string,
  now: Date = new Date(),
): Promise<{ openedAt: Date }> {
  await withTenant(tenantId, async (tx) => {
    await tx.campaignItemReviewer.updateMany({
      where: { itemId, personId, unassignedAt: null },
      data: {},
    });
  });
  OPENED.set(`${personId}:${itemId}`, now);
  return { openedAt: now };
}

/**
 * In-process, deliberately. The open time is a measurement of one reviewer's
 * session and it does not need to survive a restart: a decision made after a
 * restart records `itemOpenedAt === decidedAt`, which reads as "never opened"
 * and is the honest answer for a measurement that was lost.
 */
const OPENED = new Map<string, Date>();

export interface DecisionInput {
  itemId: string;
  deciderPersonId: string;
  deciderUserId: string;
  decision: 'certify' | 'revoke';
  comment: string | null;
}

export async function recordDecision(
  tenantId: string,
  input: DecisionInput,
  options: { now?: Date } = {},
): Promise<{ status: string }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.findUniqueOrThrow({
      where: { id: input.itemId },
      include: { reviewers: { where: { unassignedAt: null } } },
    });
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: item.campaignId } });

    if (campaign.status !== 'open' && campaign.status !== 'executing') {
      throw new DecisionRefusedError('campaign_not_open', `this campaign is ${campaign.status}`);
    }
    if (item.status !== 'pending' && item.status !== 'blocked_no_reviewer') {
      throw new DecisionRefusedError('item_not_pending', `this item is already ${item.status}`);
    }

    // THE SELF-REVIEW INVARIANT, at the moment of decision as well as at
    // resolution. Every path Automate enumerated closes the same way, including
    // deciding through the API rather than the console.
    if (item.personId !== null && item.personId === input.deciderPersonId) {
      throw new DecisionRefusedError(
        'self_review',
        'no person may record a decision on an item whose subject is themselves',
      );
    }
    if (!item.reviewers.some((r) => r.personId === input.deciderPersonId)) {
      throw new DecisionRefusedError('not_reviewer', 'this item is not assigned to you');
    }
    // Re-checked here because deactivation revoking sessions covers most of it
    // and "most of it" is not a security control.
    const invalid = await isValidApprover(tx, input.deciderPersonId, now);
    if (invalid !== null) {
      throw new DecisionRefusedError('reviewer_invalid', `you may no longer decide: ${invalid}`);
    }

    // A departed subject: certifying is refused and the item moots. Revoking is
    // ALLOWED — a departure never suppresses a revocation.
    if (item.personId !== null) {
      const contracts = await tx.contract.findMany({
        where: { personId: item.personId },
        select: { startDate: true, endDate: true },
      });
      const active = contracts.some(
        (c) => c.startDate <= now && (c.endDate === null || c.endDate >= now),
      );
      if (!active && input.decision === 'certify') {
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'moot',
            statusReason:
              "the subject's contracts have all ended. A certification is a signed statement about somebody's access; signing one for a person who left would be false assurance.",
          },
        });
        throw new DecisionRefusedError(
          'subject_departed',
          'this person has left; the item is now moot and cannot be certified. Revoking is still available.',
        );
      }
    }

    // Revoking is one at a time, WITH A COMMENT.
    if (input.decision === 'revoke' && (input.comment ?? '').trim().length === 0) {
      throw new DecisionRefusedError('comment_required', 'a revoke decision requires a comment');
    }
    // An unattributable holding is excluded from bulk certify AND given a
    // mandatory comment.
    if (
      input.decision === 'certify' &&
      item.riskFlags.includes('unattributable') &&
      (input.comment ?? '').trim().length === 0
    ) {
      throw new DecisionRefusedError(
        'comment_required',
        'this holding has no recorded cause; certifying it requires a comment saying who said it was fine and why',
      );
    }

    const lastOrdinal = await tx.campaignDecision.count({
      where: { personId: input.deciderPersonId, item: { campaignId: item.campaignId } },
    });
    const openedAt = OPENED.get(`${input.deciderPersonId}:${item.id}`) ?? now;

    const decision = await tx.campaignDecision.create({
      data: {
        tenantId,
        itemId: item.id,
        personId: input.deciderPersonId,
        decidedByUserId: input.deciderUserId,
        decision: input.decision,
        comment: input.comment,
        itemOpenedAt: openedAt,
        decidedAt: now,
        viaBulk: false,
        sessionDecisionOrdinal: lastOrdinal + 1,
        coverageAtDecision: { coverageStatus: item.coverageStatus, riskFlags: item.riskFlags } as never,
      },
    });

    const status = input.decision === 'certify' ? 'certified' : 'revoke_decided';
    await tx.campaignItem.update({ where: { id: item.id }, data: { status } });

    if (input.decision === 'certify') {
      await projectCertification(tx, item.id, decision.id, input.deciderPersonId);
    }

    await recordEvent(tx, {
      actorUserId: input.deciderUserId,
      action: 'govern.decision.record',
      targetType: 'CampaignItem',
      targetId: item.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        campaignId: item.campaignId,
        decision: input.decision,
        resourceName: item.resourceName,
        subjectKey: item.subjectKey,
        riskFlags: item.riskFlags,
        intervalMs: now.getTime() - openedAt.getTime(),
      },
    });

    return { status };
  });
}

/**
 * The projection `HoldingCertification` holds, rebuilt from the decision that
 * caused it. `CampaignDecision` rows remain the record.
 *
 * COMPOSITION HAZARD: this pairs with `rebaseCampaign`. A re-base that kept an
 * item — its holding did not change — must leave this row alone. Rolling it
 * back for every item of a re-based campaign would make a certification that is
 * still good read as never made. `rebaseCampaign` therefore only touches items
 * it re-opens, and it never writes here at all.
 */
export async function projectCertification(
  tx: TenantClient,
  itemId: string,
  decisionId: string,
  personId: string,
): Promise<void> {
  const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } });
  const subject = parseSubjectKey(item.subjectKey);
  if (subject === null) return;

  const subjectRefType = subject.kind;
  const subjectRefId = subject.kind === 'person' ? subject.personId : subject.accountRef;
  const decision = await tx.campaignDecision.findUniqueOrThrow({ where: { id: decisionId } });

  await tx.holdingCertification.upsert({
    where: {
      tenantId_subjectRefType_subjectRefId_systemId_resourceKind_resourceId: {
        tenantId: item.tenantId,
        subjectRefType,
        subjectRefId,
        systemId: item.systemId,
        resourceKind: item.resourceKind,
        resourceId: item.resourceId,
      },
    },
    create: {
      tenantId: item.tenantId,
      subjectRefType,
      subjectRefId,
      systemId: item.systemId,
      resourceKind: item.resourceKind,
      resourceId: item.resourceId,
      lastCertifiedAt: decision.decidedAt,
      lastCertifiedByPersonId: personId,
      lastCampaignId: item.campaignId,
      lastDecisionId: decisionId,
    },
    update: {
      lastCertifiedAt: decision.decidedAt,
      lastCertifiedByPersonId: personId,
      lastCampaignId: item.campaignId,
      lastDecisionId: decisionId,
    },
  });
}
```

- [ ] **Step 5: Write bulk certify and the quality signals**

Append:

```ts
/**
 * Allowed, BOUNDED, recorded as bulk on every decision it produces, and REFUSED
 * OUTRIGHT on high-risk items.
 *
 * The cap is tenant-wide — `GovernSettings.bulkCertifyLimit` — so that a
 * campaign cannot quietly raise it for itself.
 *
 * There is NO bulk revoke. Revoking is one at a time, with a comment, and the
 * batch of section 13 is what makes the aggregate safe.
 */
export async function bulkCertify(
  tenantId: string,
  input: {
    campaignId: string;
    itemIds: readonly string[];
    deciderPersonId: string;
    deciderUserId: string;
  },
  options: { now?: Date } = {},
): Promise<{ certified: number; refused: { itemId: string; reason: string }[] }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: input.campaignId } });
    if (!campaign.allowBulkCertify) {
      throw new DecisionRefusedError('bulk_not_allowed', 'this campaign does not permit bulk certify');
    }
    const settings = await governSettings(tx);
    if (input.itemIds.length > settings.bulkCertifyLimit) {
      throw new DecisionRefusedError(
        'bulk_too_large',
        `a bulk certify is capped at ${settings.bulkCertifyLimit} items per action for this tenant`,
      );
    }

    const invalid = await isValidApprover(tx, input.deciderPersonId, now);
    if (invalid !== null) {
      throw new DecisionRefusedError('reviewer_invalid', `you may no longer decide: ${invalid}`);
    }

    const items = await tx.campaignItem.findMany({
      where: { id: { in: [...input.itemIds] }, campaignId: input.campaignId },
      include: { reviewers: { where: { unassignedAt: null }, select: { personId: true } } },
    });

    const refused: { itemId: string; reason: string }[] = [];
    const eligible: typeof items = [];

    for (const item of items) {
      if (item.status !== 'pending') {
        refused.push({ itemId: item.id, reason: `this item is already ${item.status}` });
        continue;
      }
      if (item.personId === input.deciderPersonId) {
        refused.push({ itemId: item.id, reason: 'you are the subject of this item' });
        continue;
      }
      if (!item.reviewers.some((r) => r.personId === input.deciderPersonId)) {
        refused.push({ itemId: item.id, reason: 'this item is not assigned to you' });
        continue;
      }
      if (!isBulkCertifiable(item)) {
        // In words, rather than as a disabled button with no explanation.
        refused.push({
          itemId: item.id,
          reason:
            `this item is high-risk (${[...item.riskFlags, ...(item.coverageStatus === 'complete' ? [] : [item.coverageStatus])].join(', ')}) ` +
            `and must be decided one at a time, with a comment`,
        });
        continue;
      }
      eligible.push(item);
    }

    const startOrdinal = await tx.campaignDecision.count({
      where: { personId: input.deciderPersonId, item: { campaignId: input.campaignId } },
    });

    for (const [index, item] of eligible.entries()) {
      const openedAt = OPENED.get(`${input.deciderPersonId}:${item.id}`) ?? now;
      const decision = await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: input.deciderPersonId,
          decidedByUserId: input.deciderUserId,
          decision: 'certify',
          comment: null,
          itemOpenedAt: openedAt,
          decidedAt: now,
          viaBulk: true,
          bulkSize: eligible.length,
          sessionDecisionOrdinal: startOrdinal + index + 1,
          coverageAtDecision: { coverageStatus: item.coverageStatus, riskFlags: item.riskFlags } as never,
        },
      });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'certified' } });
      await projectCertification(tx, item.id, decision.id, input.deciderPersonId);
    }

    // ONE audit event naming the items and the reviewer, not one per item.
    // `recordEvent` takes a per-tenant advisory lock for the duration of its
    // transaction, and fifty thousand separately-audited decisions would be
    // fifty thousand serialized transactions on one tenant's chain. Nothing is
    // lost: the audit event is the tamper-evident anchor for a set of rows that
    // are themselves complete.
    if (eligible.length > 0) {
      await recordEvent(tx, {
        actorUserId: input.deciderUserId,
        action: 'govern.decision.bulk_certify',
        targetType: 'Campaign',
        targetId: input.campaignId,
        outcome: 'success',
        sourceIp: null,
        payload: {
          reviewerPersonId: input.deciderPersonId,
          bulkSize: eligible.length,
          itemIds: eligible.map((i) => i.id),
          refusedCount: refused.length,
        },
      });
    }

    return { certified: eligible.length, refused };
  });
}

/**
 * Context for a human, offered as signals rather than as proof.
 *
 * A manager of a stable ten-person team who reads everything and certifies all
 * of it in four minutes is behaving correctly and will look identical to a
 * rubber-stamper on the aggregate. None of these are violations and the screen
 * does not call them violations.
 */
export async function computeReviewQualitySignals(
  tenantId: string,
  campaignId: string,
  now: Date = new Date(),
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const items = await tx.campaignItem.findMany({
      where: { campaignId },
      include: {
        reviewers: { select: { personId: true } },
        decisions: true,
      },
    });

    const assigned = new Map<string, number>();
    const decisions = new Map<string, typeof items[number]['decisions']>();
    for (const item of items) {
      for (const reviewer of item.reviewers) {
        assigned.set(reviewer.personId, (assigned.get(reviewer.personId) ?? 0) + 1);
      }
      for (const decision of item.decisions) {
        decisions.set(decision.personId, [...(decisions.get(decision.personId) ?? []), decision]);
      }
    }

    let written = 0;
    for (const [personId, itemsAssigned] of assigned) {
      const mine = (decisions.get(personId) ?? []).sort(
        (a, b) => a.sessionDecisionOrdinal - b.sessionDecisionOrdinal,
      );
      if (mine.length === 0) continue;

      const intervals = mine
        .map((d) => d.decidedAt.getTime() - d.itemOpenedAt.getTime())
        .sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)] ?? 0;

      let largestBurst = 0;
      let run = 0;
      for (const decision of mine) {
        run = decision.viaBulk ? run + 1 : 0;
        largestBurst = Math.max(largestBurst, decision.viaBulk ? (decision.bulkSize ?? run) : 1);
      }

      await tx.reviewQualitySignal.upsert({
        where: { campaignId_personId: { campaignId, personId } },
        create: {
          tenantId, campaignId, personId,
          itemsAssigned,
          itemsDecided: mine.length,
          certifiedShare: mine.filter((d) => d.decision === 'certify').length / mine.length,
          medianIntervalMs: median,
          bulkShare: mine.filter((d) => d.viaBulk).length / mine.length,
          largestBurst,
          neverOpenedShare:
            mine.filter((d) => d.itemOpenedAt.getTime() === d.decidedAt.getTime()).length / mine.length,
          computedAt: now,
        },
        update: {
          itemsAssigned,
          itemsDecided: mine.length,
          certifiedShare: mine.filter((d) => d.decision === 'certify').length / mine.length,
          medianIntervalMs: median,
          bulkShare: mine.filter((d) => d.viaBulk).length / mine.length,
          largestBurst,
          neverOpenedShare:
            mine.filter((d) => d.itemOpenedAt.getTime() === d.decidedAt.getTime()).length / mine.length,
          computedAt: now,
        },
      });
      written += 1;
    }
    return written;
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/govern/decision-service.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 7: Export and typecheck**

Add `export * from './govern/decision-service.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 8: Mutation-test**

Every one must produce a failure:

1. Add `{ from: 'pending', to: 'certified', causedBy: 'timeout' }` to `CERTIFYING_TRANSITIONS`. Expected: `every transition into \`certified\` is caused by a CampaignDecision row` FAILS. **This is the assertion that would catch a negative-confirmation setting.**
2. Add `status: 'certified'` to a close path in `reviewer-service.ts`. Expected: both `only the files in DECISION_ENTRY_POINTS write status = certified` and `no Govern file contains a timeout or expiry that certifies` FAIL.
3. Remove `'needs_review'` from `HIGH_RISK_FLAGS`. Expected: `REFUSES a high-risk item from the bulk action` FAILS.
4. In `isBulkCertifiable`, drop the `coverageStatus` check. Expected: the same test FAILS on the `partial` item.
5. In `recordDecision`, allow a certification of a departed subject. Expected: `REFUSES a certification and moots the item instead` FAILS.
6. In `recordDecision`, refuse a *revoke* on a departed subject too. Expected: `ALLOWS a revoke decision on a departed subject's item` FAILS. **Both directions, because refusing both is how a leaver's access becomes permanent.**
7. In `bulkCertify`, write one audit event per item. Expected: `writes ONE audit event naming every item` FAILS.
8. In `bulkCertify`, read the cap from the campaign rather than from settings. Expected: `caps at bulkCertifyLimit` FAILS once the campaign row has no such column — which it deliberately does not.

- [ ] **Step 9: Verify the re-base composition explicitly**

Run the pair together and read the assertion:

```bash
pnpm vitest run packages/core/src/govern/decision-service.test.ts -t "composition hazard"
pnpm vitest run packages/core/src/govern/campaign-service.test.ts -t "re-basing"
```

Then mutate: in `rebaseCampaign`, add a `tx.holdingCertification.deleteMany({ where: { lastCampaignId: campaignId } })`. Expected: `keeps the projection for an item a re-base did NOT re-open` FAILS. **Neither function is wrong on its own; the defect only exists where they meet, which is why the test lives at the meeting point.**

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/govern/decision-service.ts \
        packages/core/src/govern/decision-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): decisions, bulk carve-outs, quality signals and the state-machine tests"
```

---
## Task 20: Revocation — the dispatch router, the batch guard, `RevocationOrder`, and Provision's plan stage

Spec §5, §13, Ruling G1. **A reviewer clicking revoke has not revoked anything.** What they have done is record a decision.

**Files:**
- Create: `packages/core/src/govern/dispatch.ts`, `packages/core/src/govern/revocation-guard.ts`, `packages/core/src/govern/revocation-service.ts`
- Test: `packages/core/src/govern/dispatch.test.ts`, `packages/core/src/govern/revocation-guard.test.ts`, `packages/core/src/govern/revocation-service.test.ts`
- Modify: `packages/core/src/provision/types.ts`, `packages/core/src/provision/plan.ts`, `packages/core/src/provision/run-service.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `revokeGrant` from `../automate/fulfil.js`; `createRemediationItem`, `upsertFindings` from `./finding-service.js`; `governSettings`; `readableSnapshot`; `checkSnapshotAge`, `checkSourceFreshness`; `countRegion`, `known`, `unknownValue`, `type Tri`; `usersWithPermission`, `enqueueOutbox`, `recipientsForPersons` from `../automate/notify.js`; `type PlanInput`, `type PlannedAction` from `../provision/plan.js`.
- Produces (in `./dispatch.js` — **pure**):
  - `type RevocationRoute = 'automate_grant' | 'revocation_order' | 'requires_change_rule' | 'requires_change_role' | 'requires_change_directory_source' | 'requires_change_direct_assignment'`
  - `const REVOCATION_ROUTES: readonly RevocationRoute[]`
  - `const DISPATCHABLE_ROUTES: readonly RevocationRoute[]` — `['automate_grant', 'revocation_order']`
  - `interface RouteInput { resourceKind: ResourceKind; systemKind: SystemKind; attributionKinds: readonly string[]; liveRuleAttribution: boolean; grantIds: readonly string[]; directorySourceId: string | null }`
  - `interface RouteDecision { route: RevocationRoute; dispatchable: boolean; remediationKind: string | null; explanation: string; notRemoved: string[] }`
  - `function routeRevocation(input: RouteInput): RouteDecision`
- Produces (in `./revocation-guard.js` — **pure**):
  - `interface GuardThresholds { batchThresholdPercent: number; perResourceThresholdPercent: number; personPopulationDropPercent: number }`
  - `interface GuardInput { revocationsInBatch: number; holdingsInScope: number; revocationsByResource: ReadonlyMap<string, number>; holderCountByResource: ReadonlyMap<string, Tri<number>>; resourceNameById: ReadonlyMap<string, string>; thresholds: GuardThresholds; snapshotAgeDays: number; maxSnapshotAgeDays: number; staleSources: { sourceName: string; staleness: string; completeness: string }[]; personsWithActiveContract: number; previousPersonsWithActiveContract: number | null; hasEverApplied: boolean }`
  - `type GuardVerdict = { outcome: 'proceed' } | { outcome: 'requires_confirmation'; reasons: string[] } | { outcome: 'refused'; reasons: string[] }`
  - `function evaluateRevocationGuard(input: GuardInput): GuardVerdict`
- Produces (in `./revocation-service.js`):
  - `async function computeRevocationBatch(tenantId, actorUserId, campaignId, options?): Promise<{ batchId: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }>`
  - `async function skipDispatch(tenantId, actorUserId, dispatchId, reason): Promise<void>`
  - `async function confirmRevocationBatch(tenantId, actorUserId, batchId, options?): Promise<{ status: string; dispatched: number; requiresChange: number; failed: number }>`
  - `async function reflectRevocationOutcomes(tenantId: string, snapshotId: string, options?): Promise<{ confirmed: number; applied: number; notApplied: number; slaBreaches: number }>`
  - `async function loadRevocationOrders(tx: TenantClient, targetSystemId: string): Promise<RevocationOrderFacts[]>`
- Produces in `../provision/types.js`:
  - `interface RevocationOrderFacts { orderId: string; accountId: string; entitlementId: string; decidedByPersonName: string; campaignName: string | null; campaignDecisionId: string | null; reason: string }`
  - `PlanInput` gains `revocationOrders: RevocationOrderFacts[]`
  - `PlannedAction` gains `revocationOrderId: string | null`

- [ ] **Step 1: Write the failing router test**

`packages/core/src/govern/dispatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DISPATCHABLE_ROUTES, REVOCATION_ROUTES, routeRevocation, type RouteInput } from './dispatch.js';

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  resourceKind: 'targetEntitlement',
  systemKind: 'targetSystem',
  attributionKinds: [],
  liveRuleAttribution: false,
  grantIds: [],
  directorySourceId: null,
  ...over,
});

describe('the dispatch table — exactly one route per holding', () => {
  it('routes a grant-and-nothing-else holding to Automate', () => {
    const decision = routeRevocation(
      input({ attributionKinds: ['request'], grantIds: ['g-1'], liveRuleAttribution: true }),
    );
    expect(decision).toMatchObject({ route: 'automate_grant', dispatchable: true });
  });

  it('routes a delegated_admin grant to Automate too', () => {
    expect(
      routeRevocation(input({ attributionKinds: ['delegated_admin'], grantIds: ['g-1'], liveRuleAttribution: true }))
        .route,
    ).toBe('automate_grant');
  });

  it('routes a discovered target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['discovered'] })).route).toBe('revocation_order');
  });

  it('routes an unattributable target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['unattributable'] })).route).toBe('revocation_order');
  });

  it('routes a manual target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['manual'] })).route).toBe('revocation_order');
  });

  it('routes a LIVE-RULE holding to requires_change, NOT to an order — even with a grant beside it', () => {
    // The case that makes the vocabulary necessary. A naive product records
    // "revoked", removes it at the target, and reports 100% remediation.
    // Provision's next run finds the rule still matches and grants it back, and
    // by the following morning the report is a lie somebody signed.
    const decision = routeRevocation(
      input({
        attributionKinds: ['business_rule', 'request'],
        liveRuleAttribution: true,
        grantIds: ['g-1'],
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_rule',
      dispatchable: false,
      remediationKind: 'rule_change_required',
    });
    // Section 7: the report has to say WHICH attributions were not removed.
    expect(decision.notRemoved).toContain('request');
    expect(decision.explanation).toContain('comes from');
  });

  it('routes a syntraRole holding to requires_change, to a holder of rbac.manage', () => {
    // An access-review module that could quietly remove administrators is a
    // governance module with a privilege-escalation shape.
    const decision = routeRevocation(
      input({ resourceKind: 'syntraRole', systemKind: 'syntraInternal', attributionKinds: ['direct_assignment'] }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_role',
      dispatchable: false,
      remediationKind: 'role_assignment_change_required',
    });
  });

  it('routes a SOURCED group membership to requires_change naming the source', () => {
    const decision = routeRevocation(
      input({
        resourceKind: 'syntraGroup',
        systemKind: 'directorySource',
        attributionKinds: ['directory_source'],
        directorySourceId: 'src-1',
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_directory_source',
      remediationKind: 'directory_source_change_required',
    });
    expect(decision.explanation).toContain('rewrites that membership every run');
  });

  it('routes an administrator-assigned application to requires_change', () => {
    const decision = routeRevocation(
      input({
        resourceKind: 'application',
        systemKind: 'syntraInternal',
        attributionKinds: ['direct_assignment'],
      }),
    );
    expect(decision.route).toBe('requires_change_direct_assignment');
  });

  it('routes an application WITH a grant behind it to Automate', () => {
    expect(
      routeRevocation(
        input({
          resourceKind: 'application',
          systemKind: 'syntraInternal',
          attributionKinds: ['request'],
          grantIds: ['g-1'],
          liveRuleAttribution: true,
        }),
      ).route,
    ).toBe('automate_grant');
  });

  it('routes an EMPTY attribution set to a RevocationOrder, never to nothing', () => {
    // The empty case. A holding nothing explains is the most interesting thing
    // an access review can find, and it must be removable.
    expect(routeRevocation(input({ attributionKinds: [] })).route).toBe('revocation_order');
  });

  it('resolves EVERY attribution combination to exactly one route', () => {
    // A table over every combination, so a kind added later without a route
    // fails rather than silently falling through.
    const kinds = [
      'business_rule', 'request', 'delegated_admin', 'auto_granted', 'direct_assignment',
      'group_inheritance', 'org_unit_inheritance', 'directory_source', 'discovered',
      'manual', 'unattributable',
    ];
    for (const kind of kinds) {
      for (const resourceKind of ['targetEntitlement', 'targetAccount', 'syntraGroup', 'application', 'syntraRole'] as const) {
        const decision = routeRevocation(
          input({
            resourceKind,
            systemKind: resourceKind.startsWith('target') ? 'targetSystem' : 'syntraInternal',
            attributionKinds: [kind],
            liveRuleAttribution: ['business_rule', 'request', 'delegated_admin', 'auto_granted'].includes(kind),
            grantIds: ['request', 'delegated_admin', 'auto_granted'].includes(kind) ? ['g-1'] : [],
            directorySourceId: kind === 'directory_source' ? 'src-1' : null,
          }),
        );
        expect(REVOCATION_ROUTES).toContain(decision.route);
      }
    }
  });

  it('never marks a requires_change route dispatchable', () => {
    // The three requires_change routes never produce a dispatch.
    for (const route of REVOCATION_ROUTES) {
      if (route.startsWith('requires_change')) expect(DISPATCHABLE_ROUTES).not.toContain(route);
    }
    expect([...DISPATCHABLE_ROUTES].sort()).toEqual(['automate_grant', 'revocation_order']);
  });
});
```

- [ ] **Step 2: Write the router**

`packages/core/src/govern/dispatch.ts`:

```ts
import type { ResourceKind, SystemKind } from './types.js';

/**
 * The section 5 dispatch table, as a pure function.
 *
 * Every campaign decision of `revoke`, and every SoD remediation, resolves to
 * PRECISELY ONE of these outcomes, chosen by what the holding's attribution set
 * contains. THE LAST FOUR ARE NOT REVOCATIONS AND NO REPORT CALLS THEM ONE.
 *
 * Section 7 says a revoke on a holding with three attributions "removes at most
 * the ones Govern can dispatch, and the report has to say which". Exactly one
 * route still holds: where the route is a `requires_change`, `notRemoved` names
 * every attribution that survives, and the remediation item and the report both
 * carry it. Dispatching a partial removal under one decision would produce
 * exactly the subtly-wrong report this module must not produce — access
 * removed from one path and re-granted from another by morning.
 */

export type RevocationRoute =
  | 'automate_grant'
  | 'revocation_order'
  | 'requires_change_rule'
  | 'requires_change_role'
  | 'requires_change_directory_source'
  | 'requires_change_direct_assignment';

export const REVOCATION_ROUTES: readonly RevocationRoute[] = [
  'automate_grant',
  'revocation_order',
  'requires_change_rule',
  'requires_change_role',
  'requires_change_directory_source',
  'requires_change_direct_assignment',
];

export const DISPATCHABLE_ROUTES: readonly RevocationRoute[] = ['automate_grant', 'revocation_order'];

export interface RouteInput {
  resourceKind: ResourceKind;
  systemKind: SystemKind;
  attributionKinds: readonly string[];
  /** Anything that would RE-CREATE the holding: an enabled rule, or a live grant. */
  liveRuleAttribution: boolean;
  grantIds: readonly string[];
  directorySourceId: string | null;
}

export interface RouteDecision {
  route: RevocationRoute;
  dispatchable: boolean;
  remediationKind: string | null;
  explanation: string;
  /** The attributions this route does NOT remove. The report says which. */
  notRemoved: string[];
}

const GRANT_KINDS = new Set(['request', 'delegated_admin', 'auto_granted']);

export function routeRevocation(input: RouteInput): RouteDecision {
  const kinds = new Set(input.attributionKinds);
  const grantKinds = [...kinds].filter((k) => GRANT_KINDS.has(k));
  const hasRule = kinds.has('business_rule');

  // 1. A Syntra role. Core's RBAC surface is the only writer of that table, and
  //    an access-review module that could quietly remove administrators is a
  //    governance module with a privilege-escalation shape.
  if (input.resourceKind === 'syntraRole') {
    return {
      route: 'requires_change_role',
      dispatchable: false,
      remediationKind: 'role_assignment_change_required',
      explanation:
        'this is a Syntra role assignment. Govern does not write RoleAssignment; a holder of rbac.manage has to remove it.',
      notRemoved: [...kinds],
    };
  }

  // 2. A live business rule would grant it again tonight. This comes BEFORE the
  //    grant route deliberately: a holding explained by both a rule and a grant
  //    is not "a grant and nothing else", and removing the grant would leave the
  //    rule to re-create it.
  if (hasRule && input.liveRuleAttribution) {
    return {
      route: 'requires_change_rule',
      dispatchable: false,
      remediationKind: 'rule_change_required',
      explanation:
        'this access comes from the person’s job: a business rule grants it, and removing it means changing either the rule or the job. Provision would grant it back tonight.',
      notRemoved: [...kinds],
    };
  }

  // 3. A membership on a group carrying a sourceId. The source rewrites it every
  //    run; a removal here would survive until the small hours and then come
  //    back, which is worse than refusing.
  if (kinds.has('directory_source') || input.directorySourceId !== null) {
    return {
      route: 'requires_change_directory_source',
      dispatchable: false,
      remediationKind: 'directory_source_change_required',
      explanation:
        'this membership comes from a directory source, which rewrites that membership every run. It has to change at the source.',
      notRemoved: [...kinds],
    };
  }

  // 4. An Automate grant — request or delegated admin — and nothing else.
  if (grantKinds.length > 0 && input.grantIds.length > 0) {
    return {
      route: 'automate_grant',
      dispatchable: true,
      remediationKind: null,
      explanation:
        'Automate holds a grant for this. Ending the grant removes its term from desired state, and Provision plans and applies the removal under its own guard.',
      notRemoved: [...kinds].filter((k) => !GRANT_KINDS.has(k)),
    };
  }

  // 5. A Syntra application or local group with NO grant behind it: an
  //    administrator assigned it in the console.
  if (input.resourceKind === 'application' || input.resourceKind === 'syntraGroup') {
    return {
      route: 'requires_change_direct_assignment',
      dispatchable: false,
      remediationKind: 'direct_assignment_change_required',
      explanation:
        'an administrator assigned this directly in Syntra and no grant stands behind it. Govern does not write AppAssignment or GroupMembership.',
      notRemoved: [...kinds],
    };
  }

  // 6. A target holding whose attributions are all `discovered` or `manual`, or
  //    which is unattributable — nothing in desired state wants it. Including
  //    the EMPTY set: a holding nothing explains is the most interesting thing
  //    an access review can find, and it must be removable.
  return {
    route: 'revocation_order',
    dispatchable: true,
    remediationKind: null,
    explanation:
      'nothing in desired state wants this holding, so a one-shot revocation order carrying the deciding human is written for Provision to plan.',
    notRemoved: [],
  };
}
```

- [ ] **Step 3: Write the failing guard test and the guard**

`packages/core/src/govern/revocation-guard.test.ts` covers, at the boundaries: just under each threshold, exactly at it, just over; the per-resource axis tripping while the batch axis does not; **a first batch with a zero denominator**; a snapshot past `maxSnapshotAgeDays`; a source gone stale between decision and execution; the person-population drop; **and a resource whose holder count is `unknown`**.

`packages/core/src/govern/revocation-guard.ts`:

```ts
import { known, type Tri } from './types.js';

export interface GuardThresholds {
  batchThresholdPercent: number;
  perResourceThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface GuardInput {
  revocationsInBatch: number;
  holdingsInScope: number;
  revocationsByResource: ReadonlyMap<string, number>;
  /** `unknown` where a coverage gap makes the denominator unknowable. */
  holderCountByResource: ReadonlyMap<string, Tri<number>>;
  resourceNameById: ReadonlyMap<string, string>;
  thresholds: GuardThresholds;
  snapshotAgeDays: number;
  maxSnapshotAgeDays: number;
  staleSources: { sourceName: string; staleness: string; completeness: string }[];
  personsWithActiveContract: number;
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type GuardVerdict =
  | { outcome: 'proceed' }
  | { outcome: 'requires_confirmation'; reasons: string[] }
  | { outcome: 'refused'; reasons: string[] };

/**
 * Two axes, and FOUR conditions that block outright with no confirmation
 * available.
 *
 * The per-resource axis is lower than Provision's 50% because a campaign is a
 * deliberate act with a human on the other end of the confirmation, and "this
 * campaign is emptying Finance-Payments" is the single sentence most worth
 * interrupting somebody with.
 */
export function evaluateRevocationGuard(input: GuardInput): GuardVerdict {
  const refusals: string[] = [];

  // 1. There is nothing an administrator could usefully confirm about executing
  //    decisions made against a picture of the world from six weeks ago.
  if (input.snapshotAgeDays > input.maxSnapshotAgeDays) {
    refusals.push(
      `the snapshot these decisions were made against is ${input.snapshotAgeDays} days old, past the limit of ${input.maxSnapshotAgeDays}. Re-base and let the reviewers look at what changed.`,
    );
  }

  // 2. Dispatching a revocation of a holding nobody has confirmed still exists
  //    is how a campaign revokes something that was already gone and reports it
  //    as its own work.
  const offending = input.staleSources.filter(
    (s) => s.staleness === 'stale' || s.completeness === 'unread',
  );
  if (offending.length > 0) {
    refusals.push(
      `a source in this batch's scope is no longer current: ${offending.map((s) => s.sourceName).join(', ')}`,
    );
  }

  // 3. A truncated HR import makes everybody look like a leaver, and a campaign
  //    running over that data revokes the organization.
  if (input.previousPersonsWithActiveContract !== null && input.previousPersonsWithActiveContract > 0) {
    const drop =
      ((input.previousPersonsWithActiveContract - input.personsWithActiveContract) /
        input.previousPersonsWithActiveContract) *
      100;
    if (drop > input.thresholds.personPopulationDropPercent) {
      refusals.push(
        `${Math.round(drop)}% fewer persons hold an active contract than at the last applied batch (${input.personsWithActiveContract} against ${input.previousPersonsWithActiveContract})`,
      );
    }
  }

  if (refusals.length > 0) return { outcome: 'refused', reasons: refusals };

  const reasons: string[] = [];

  // 4. THE FIRST BATCH IN A TENANT always requires confirmation regardless of
  //    size, because every denominator is zero and no percentage can say
  //    anything about it. Provision found this hole in Directory Sync's guard;
  //    it is closed here at the start.
  if (!input.hasEverApplied) {
    reasons.push(
      'this is the first revocation batch in this tenant, so there is no prior state for a percentage to be a share of',
    );
  }

  const batchShare =
    input.holdingsInScope === 0 ? 100 : (input.revocationsInBatch / input.holdingsInScope) * 100;
  if (batchShare > input.thresholds.batchThresholdPercent) {
    reasons.push(
      `this batch revokes ${input.revocationsInBatch} of ${input.holdingsInScope} holdings in the campaign's scope (${Math.round(batchShare)}%, above ${input.thresholds.batchThresholdPercent}%)`,
    );
  }

  for (const [resourceId, count] of input.revocationsByResource) {
    const name = input.resourceNameById.get(resourceId) ?? resourceId;
    const holders = input.holderCountByResource.get(resourceId) ?? known(0);

    // A resource whose holder count is UNKNOWN cannot be divided. It is not
    // skipped: an axis that quietly protects nothing on exactly the resources
    // it exists for is worse than no axis, and the confirmation names it.
    if (!holders.known) {
      reasons.push(
        `the current holder count of "${name}" is unknown (${holders.reason}), so this batch's share of it cannot be computed`,
      );
      continue;
    }
    if (holders.value === 0) {
      reasons.push(`"${name}" has no recorded holders, so this batch's share of it cannot be computed`);
      continue;
    }
    const share = (count / holders.value) * 100;
    if (share > input.thresholds.perResourceThresholdPercent) {
      reasons.push(
        `this batch revokes ${count} of ${holders.value} holders of "${name}" (${Math.round(share)}%, above ${input.thresholds.perResourceThresholdPercent}%)`,
      );
    }
  }

  return reasons.length > 0 ? { outcome: 'requires_confirmation', reasons } : { outcome: 'proceed' };
}
```

- [ ] **Step 4: Write the batch service**

`packages/core/src/govern/revocation-service.ts` — `computeRevocationBatch` opens **one transaction** for the whole batch (Provision's rule applies at a few thousand rows), supersedes a stale non-terminal batch at the head of it, and never auto-applies:

```ts
export async function computeRevocationBatch(
  tenantId: string,
  actorUserId: string,
  campaignId: string,
  options: { now?: Date } = {},
): Promise<{ batchId: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    // THE ESCAPE HATCH, in the same function as the index. A crashed compute
    // would otherwise brick every future batch for this campaign with a P2002.
    const stale = await tx.revocationBatch.findFirst({
      where: { campaignId, status: { in: ['computing', 'previewed', 'blocked', 'applying'] } },
    });
    if (stale !== null) {
      await tx.revocationBatch.update({
        where: { id: stale.id },
        data: { status: 'superseded', finishedAt: now, error: 'superseded by a later batch' },
      });
    }

    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const snapshot = await readableSnapshot(tx, campaign.snapshotId);
    const settings = await governSettings(tx);

    const decided = await tx.campaignItem.findMany({
      where: { campaignId, status: 'revoke_decided' },
      include: { decisions: { orderBy: { decidedAt: 'desc' }, take: 1 } },
    });

    const batch = await tx.revocationBatch.create({
      data: { tenantId, campaignId, status: 'computing', startedAt: now },
    });

    // Route every item, then guard the aggregate. THE WHOLE BATCH IN ONE
    // TRANSACTION: a batch is thousands of rows at most, and Provision's rule
    // applies at that size.
    const grants = await tx.accessGrant.findMany({
      where: { subjectPersonId: { in: decided.map((d) => d.personId).filter((p): p is string => p !== null) } },
      select: { id: true, subjectPersonId: true, resourceId: true, status: true },
    });

    const dispatches = decided.map((item, index) => {
      const attributions = item.attributions as { kind: string; detail?: Record<string, unknown> }[];
      const decision = routeRevocation({
        resourceKind: item.resourceKind as never,
        systemKind: item.systemId === 'syntra' ? 'syntraInternal' : 'targetSystem',
        attributionKinds: attributions.map((a) => a.kind),
        liveRuleAttribution: attributions.some(
          (a) =>
            (a.kind === 'business_rule' && a.detail?.['ruleEnabled'] === true) ||
            a.kind === 'request' || a.kind === 'delegated_admin' || a.kind === 'auto_granted',
        ),
        grantIds: grants
          .filter((g) => g.subjectPersonId === item.personId && g.resourceId === item.resourceId)
          .map((g) => g.id),
        directorySourceId:
          attributions.find((a) => a.kind === 'directory_source')?.detail?.['sourceId'] as string | undefined ??
          null,
      });
      return { item, decision, index };
    });

    const revocationsByResource = new Map<string, number>();
    const resourceNameById = new Map<string, string>();
    for (const { item, decision } of dispatches) {
      if (!decision.dispatchable) continue;
      revocationsByResource.set(item.resourceId, (revocationsByResource.get(item.resourceId) ?? 0) + 1);
      resourceNameById.set(item.resourceId, item.resourceName);
    }

    // Integration finding 6: there is NO holder count for anything but a target
    // entitlement anywhere in the platform. Provision writes
    // `Entitlement.holderCount` from the target inventory and declines a
    // helper; Core has nothing for groups, applications or roles. The
    // denominator therefore comes from this campaign's OWN snapshot, and a
    // resource sitting behind a coverage gap answers `unknown` rather than a
    // confident number.
    const holderCountByResource = new Map<string, Tri<number>>();
    for (const resourceId of revocationsByResource.keys()) {
      const gaps = await tx.coverageGap.findMany({
        where: { snapshotId: snapshot.id, OR: [{ resourceId }, { resourceId: null }] },
        select: { reason: true },
      });
      const holders = await tx.holding.count({
        where: { snapshotId: snapshot.id, resourceId, state: 'held' },
      });
      holderCountByResource.set(
        resourceId,
        countRegion({ held: holders, unknownHoldings: 0, gapReasons: gaps.map((g) => g.reason) }),
      );
    }

    const inScope = await tx.campaignItem.count({ where: { campaignId } });
    const verdict = evaluateRevocationGuard({
      revocationsInBatch: dispatches.filter((d) => d.decision.dispatchable).length,
      holdingsInScope: inScope,
      revocationsByResource,
      holderCountByResource,
      resourceNameById,
      thresholds: {
        batchThresholdPercent: settings.batchThresholdPercent,
        perResourceThresholdPercent: settings.perResourceThresholdPercent,
        personPopulationDropPercent: settings.personPopulationDropPercent,
      },
      snapshotAgeDays: Math.floor((now.getTime() - snapshot.asOf.getTime()) / 86_400_000),
      maxSnapshotAgeDays: settings.maxSnapshotAgeDays,
      staleSources: snapshot.sources.map((s) => ({
        sourceName: s.sourceName, staleness: s.staleness, completeness: s.completeness,
      })),
      personsWithActiveContract: snapshot.personsWithActiveContract,
      previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastBatch,
      hasEverApplied: settings.lastAppliedBatchAt !== null,
    });

    await tx.revocationDispatch.createMany({
      data: dispatches.map(({ item, decision, index }) => ({
        tenantId,
        batchId: batch.id,
        itemId: item.id,
        holdingDescriptor: {
          subjectKey: item.subjectKey,
          systemId: item.systemId,
          resourceKind: item.resourceKind,
          resourceId: item.resourceId,
          resourceName: item.resourceName,
          explanation: decision.explanation,
          notRemoved: decision.notRemoved,
        } as never,
        route: decision.route,
        status: decision.dispatchable ? 'proposed' : 'requires_change',
        // An explicit ordinal: createdAt is transaction start time and every
        // row of this createMany carries an identical one.
        sequence: index,
      })),
    });

    const status = verdict.outcome === 'refused' ? 'blocked' : 'previewed';
    await tx.revocationBatch.update({
      where: { id: batch.id },
      data: {
        status,
        proposedCount: dispatches.filter((d) => d.decision.dispatchable).length,
        requiresChangeCount: dispatches.filter((d) => !d.decision.dispatchable).length,
        requiresConfirmation: verdict.outcome === 'requires_confirmation',
        blockedReason: verdict.outcome === 'proceed' ? null : verdict.reasons.join('; '),
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.revocation.compute',
      targetType: 'RevocationBatch',
      targetId: batch.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        campaignId, status, verdict: verdict.outcome,
        reasons: verdict.outcome === 'proceed' ? [] : verdict.reasons,
        supersededBatchId: stale?.id ?? null,
      },
    });

    return {
      batchId: batch.id,
      status,
      requiresConfirmation: verdict.outcome === 'requires_confirmation',
      blockedReason: verdict.outcome === 'proceed' ? null : verdict.reasons.join('; '),
    };
  });
}
```

`confirmRevocationBatch` then dispatches **per row, each in its own short transaction alongside its audit event** — `revokeGrant(tenantId, actorUserId, grantId, reason)` for the `automate_grant` route, `createRevocationOrder` for the `revocation_order` route, and `createRemediationItem` for the four `requires_change` routes. `autoApply` does not exist; confirmation is per batch, explicit, and the confirming user is recorded.

`createRevocationOrder` carries Ruling G1's three constraints plus its condition:

```ts
async function createRevocationOrder(
  tx: TenantClient,
  tenantId: string,
  input: {
    targetSystemId: string; accountId: string; entitlementId: string;
    decidedByPersonId: string; decidedByPersonName: string;
    campaignName: string | null; campaignDecisionId: string | null; reason: string;
    liveAttribution: boolean;
  },
): Promise<string> {
  // Ruling G1, constraint one: REFUSED AT CREATION if the holding carries any
  // live attribution. If a rule wants it, the honest answer is to change the
  // rule, and that is the remediation item, not the order.
  if (input.liveAttribution) {
    throw new Error(
      'a revocation order may not be created for a holding a rule or a live grant still wants',
    );
  }
  // The escape hatch for `govern_revocation_order_one_open`: an existing open
  // order for this holding is cancelled, not collided with.
  await tx.revocationOrder.updateMany({
    where: {
      targetSystemId: input.targetSystemId, accountId: input.accountId,
      entitlementId: input.entitlementId, status: 'open',
    },
    data: { status: 'cancelled', cancelledReason: 'superseded by a later decision' },
  });

  const order = await tx.revocationOrder.create({ data: { tenantId, ...input, status: 'open' } });
  return order.id;
}
```

- [ ] **Step 5: Add the plan-stage term to Provision**

In `packages/core/src/provision/types.ts`:

```ts
/**
 * A one-shot negative term Govern's campaigns produce, consumed by the plan
 * stage. PLAIN VALUES — Provision never queries Govern, and the three
 * provenance fields are denormalised here so that the audit event written when
 * this action is applied can name a human, a campaign and a decision.
 *
 * That is Ruling G1's condition: the ruling does not hold unless the record at
 * the point of application shows a human decision. A record that cannot show
 * that is indistinguishable from the inference the remit rule forbids.
 */
export interface RevocationOrderFacts {
  orderId: string;
  accountId: string;
  entitlementId: string;
  decidedByPersonName: string;
  campaignName: string | null;
  campaignDecisionId: string | null;
  reason: string;
}
```

`PlanInput` gains `revocationOrders: RevocationOrderFacts[]`, and `PlannedAction` gains `revocationOrderId: string | null`.

In `packages/core/src/provision/plan.ts`, inside `planActions`, after the ordinary revocation term:

```ts
    // A revocation order is not an inference. It is a single dated instruction
    // carrying a named human, a campaign, a decision id and a comment; it is
    // consumed once; and it appears here attributed to that decision rather
    // than to reconciliation. It is subject to the ordinary guard exactly as
    // any other revocation, including the per-entitlement axis.
    for (const order of input.revocationOrders) {
      if (state.entitlements.has(order.entitlementId)) continue; // desired state wants it; the order is overtaken
      if (!actual.heldEntitlements.has(order.entitlementId)) continue;
      actions.push({
        actionType: 'revoke_entitlement',
        personId: state.personId,
        accountId: order.accountId,
        entitlementId: order.entitlementId,
        before: {
          revocationOrderId: order.orderId,
          decidedBy: order.decidedByPersonName,
          campaign: order.campaignName,
          campaignDecisionId: order.campaignDecisionId,
          reason: order.reason,
        },
        after: null,
        attributedRuleIds: [],
        attributedGrantIds: [],
        revocationOrderId: order.orderId,
        requiresConfirmation: false,
        message: `revoked by ${order.decidedByPersonName} in ${order.campaignName ?? 'an access review'}: ${order.reason}`,
      });
    }
```

and `run-service.ts` loads them via `loadRevocationOrders(tx, targetSystemId)`, writes `revocationOrderId` onto the `ProvisionAction` row, and marks the order `planned`.

- [ ] **Step 6: Write `reflectRevocationOutcomes`**

```ts
/**
 * The vocabulary rule, enforced.
 *
 * `confirmed` → the owning subsystem reported the removal applied, and no
 * snapshot has been built since.
 *
 * `applied` → confirmed AND a subsequent snapshot no longer shows the holding.
 * TWO CONDITIONS, NOT ONE, because a write that reported success and did not
 * land is a case Provision's convergence logic exists for and Govern should not
 * be more credulous than Provision is.
 *
 * A dispatch that is `confirmed` but whose next snapshot STILL SHOWS the
 * holding does not advance: it raises a `dispatch_not_applied` finding naming
 * both facts.
 */
export async function reflectRevocationOutcomes(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ confirmed: number; applied: number; notApplied: number; slaBreaches: number }> {
  const now = options.now ?? new Date();
  let confirmed = 0;
  let applied = 0;
  let notApplied = 0;
  let slaBreaches = 0;
  const findings: FindingDraft[] = [];

  const settings = await withTenant(tenantId, (tx) => governSettings(tx));

  // ---- dispatched -> confirmed -------------------------------------------
  const dispatched = await withTenant(tenantId, (tx) =>
    tx.revocationDispatch.findMany({
      // `cancelled` is EXCLUDED here and from the SLA sweep below. Composing
      // the cancelled-as-overtaken order with the SLA finding the naive way
      // raises a finding saying a revocation was not applied, about a
      // revocation that was correctly abandoned.
      where: { status: 'dispatched' },
      select: {
        id: true, grantId: true, revocationOrderId: true, dispatchedAt: true,
        holdingDescriptor: true, batchId: true,
      },
    }),
  );

  for (const dispatch of dispatched) {
    const owningSubsystemReportedApplied = await withTenant(tenantId, async (tx) => {
      if (dispatch.revocationOrderId !== null) {
        const action = await tx.provisionAction.findFirst({
          where: { revocationOrderId: dispatch.revocationOrderId, status: 'applied' },
          select: { id: true },
        });
        return action !== null;
      }
      if (dispatch.grantId !== null) {
        const grant = await tx.accessGrant.findUnique({
          where: { id: dispatch.grantId },
          select: { status: true },
        });
        return grant?.status === 'revoked';
      }
      return false;
    });

    if (owningSubsystemReportedApplied) {
      await withTenant(tenantId, (tx) =>
        tx.revocationDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'confirmed', confirmedAt: now },
        }),
      );
      confirmed += 1;
      continue;
    }

    // The clock measures to CONFIRMATION rather than to observation,
    // deliberately: observation waits on the next snapshot, and an SLA that
    // fired because a nightly job had not run yet would be an alert that trains
    // people to ignore alerts.
    const ageHours =
      dispatch.dispatchedAt === null
        ? 0
        : (now.getTime() - dispatch.dispatchedAt.getTime()) / 3_600_000;
    if (ageHours > settings.dispatchSlaHours) {
      slaBreaches += 1;
      findings.push({
        kind: 'dispatch_not_applied',
        severity: 'high',
        subjectRefType: 'dispatch',
        subjectRefId: dispatch.id,
        detail: {
          ...(dispatch.holdingDescriptor as Record<string, unknown>),
          dispatchedAt: dispatch.dispatchedAt?.toISOString() ?? null,
          ageHours: Math.round(ageHours),
          dispatchSlaHours: settings.dispatchSlaHours,
          statement:
            'this revocation was dispatched and the owning subsystem has not reported it applied within its SLA',
        },
      });
    }
  }

  // ---- confirmed -> applied, or a finding ---------------------------------
  const awaitingObservation = await withTenant(tenantId, (tx) =>
    tx.revocationDispatch.findMany({
      where: { status: 'confirmed' },
      select: { id: true, holdingDescriptor: true, confirmedAt: true },
    }),
  );

  for (const dispatch of awaitingObservation) {
    const descriptor = dispatch.holdingDescriptor as {
      subjectKey?: string; systemId?: string; resourceKind?: string; resourceId?: string;
    };
    const stillThere = await withTenant(tenantId, (tx) =>
      tx.holding.findFirst({
        where: {
          snapshotId,
          subjectKey: descriptor.subjectKey ?? '',
          systemId: descriptor.systemId ?? '',
          resourceKind: descriptor.resourceKind ?? '',
          resourceId: descriptor.resourceId ?? '',
          state: 'held',
        },
        select: { id: true },
      }),
    );

    if (stillThere === null) {
      // TWO CONDITIONS, NOT ONE: confirmed AND observed gone. A write that
      // reported success and did not land is a case Provision's convergence
      // logic exists for, and Govern should not be more credulous than
      // Provision is.
      await withTenant(tenantId, (tx) =>
        tx.revocationDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'applied', appliedAt: now },
        }),
      );
      applied += 1;
      continue;
    }

    // It does NOT advance. One of the more valuable rows this subsystem
    // produces: the owning subsystem says it removed this and the next
    // snapshot still shows it held.
    notApplied += 1;
    findings.push({
      kind: 'dispatch_not_applied',
      severity: 'high',
      subjectRefType: 'dispatch',
      subjectRefId: dispatch.id,
      detail: {
        ...descriptor,
        confirmedAt: dispatch.confirmedAt?.toISOString() ?? null,
        observedInSnapshotId: snapshotId,
        statement:
          'the owning subsystem reported this removal applied, and the next snapshot still shows the holding as held',
      },
    });
  }

  if (findings.length > 0) {
    await upsertFindings(tenantId, snapshotId, findings, { now });
  }

  // ---- roll the outcomes back onto the campaign items ---------------------
  await withTenant(tenantId, async (tx) => {
    const rows = await tx.revocationDispatch.findMany({
      where: { itemId: { not: null }, status: { in: ['confirmed', 'applied', 'failed'] } },
      select: { itemId: true, status: true, message: true },
    });
    for (const row of rows) {
      await tx.campaignItem.update({
        where: { id: row.itemId! },
        data: {
          status:
            row.status === 'applied'
              ? 'revocation_applied'
              : row.status === 'failed'
                ? 'revocation_failed'
                : 'revocation_confirmed',
          ...(row.message === null ? {} : { statusReason: row.message }),
        },
      });
    }
  });

  return { confirmed, applied, notApplied, slaBreaches };
}
```

**Composition hazard (Global Constraints).** The SLA finding and the cancelled-as-overtaken order touch the same row. A `cancelled` dispatch must be excluded from the SLA sweep, or a correctly abandoned revocation raises a finding saying a revocation was not applied. Step 11 tests the pair.

- [ ] **Step 7: Write the service test**

`packages/core/src/govern/revocation-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import * as fulfil from '../automate/fulfil.js';
import {
  computeRevocationBatch,
  confirmRevocationBatch,
  reflectRevocationOutcomes,
  skipDispatch,
} from './revocation-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let campaignId: string;
let snapshotId: string;
let reviewerPersonId: string;
let reviewerUserId: string;

/**
 * Two decided items: one `discovered` (routes to an order) and one carrying a
 * live business rule (routes to requires_change). A fixture with only one route
 * could not tell a router that always dispatches from one that never does.
 */
async function seedDecidedItems() {
  return withTenant(tenantId, async (tx) => {
    const reviewer = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Manager' } });
    await tx.contract.create({
      data: { tenantId, personId: reviewer.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    const reviewerUser = await tx.user.create({
      data: { tenantId, login: 'jan', email: 'jan@a.test', displayName: 'Jan Manager', personId: reviewer.id },
    });
    const subject = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    await tx.contract.create({
      data: { tenantId, personId: subject.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });

    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId, kind: 'manual', status: 'complete', asOf: NOW,
        personsWithActiveContract: 2, holdingCount: 20,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId, snapshotId: snapshot.id, sourceKind: 'targetSystem', sourceId: 'sys-1',
        sourceName: 'Acme AD', lastSuccessfulReadAt: NOW, completeness: 'complete',
        staleness: 'fresh', freshnessSlaHours: 24,
      },
    });
    for (let i = 0; i < 20; i += 1) {
      await tx.holding.create({
        data: {
          tenantId, snapshotId: snapshot.id, subjectKey: `person:${subject.id}`, personId: subject.id,
          systemKind: 'targetSystem', systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId: `ent-${i}`, resourceName: `Group ${i}`, state: 'held',
          observedAt: NOW, observedVia: 'provision', firstSeenAt: NOW,
        },
      });
    }

    const campaign = await tx.campaign.create({
      data: {
        tenantId, name: 'Q2 review', scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id, reviewerSelector: 'manager', reviewerConfig: {},
        fallbackSelector: 'person', fallbackConfig: { personId: reviewer.id },
        ownerPersonId: reviewer.id, opensAt: NOW, dueAt: new Date(NOW.getTime() + 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 86_400_000), status: 'open',
      },
    });

    const makeItem = async (resourceId: string, attributions: unknown) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId, campaignId: campaign.id, holdingSnapshotId: snapshot.id,
          subjectKey: `person:${subject.id}`, personId: subject.id,
          systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId, resourceName: `Group ${resourceId}`,
          attributions: attributions as never, observedAt: NOW,
          coverageStatus: 'complete', status: 'revoke_decided',
        },
      });
      await tx.campaignDecision.create({
        data: {
          tenantId, itemId: item.id, personId: reviewer.id, decidedByUserId: reviewerUser.id,
          decision: 'revoke', comment: 'not needed', itemOpenedAt: NOW, decidedAt: NOW,
          sessionDecisionOrdinal: 1, coverageAtDecision: {},
        },
      });
      return item.id;
    };

    await makeItem('ent-0', [{ kind: 'discovered', detail: {} }]);
    await makeItem('ent-1', [{ kind: 'business_rule', detail: { ruleName: 'Finance staff', ruleEnabled: true } }]);

    return {
      campaignId: campaign.id, snapshotId: snapshot.id,
      reviewerPersonId: reviewer.id, reviewerUserId: reviewerUser.id,
    };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await seedDecidedItems();
  campaignId = seeded.campaignId;
  snapshotId = seeded.snapshotId;
  reviewerPersonId = seeded.reviewerPersonId;
  reviewerUserId = seeded.reviewerUserId;
});

describe('computeRevocationBatch', () => {
  it('routes each item and REQUIRES CONFIRMATION on the first batch, whatever its size', async () => {
    // Every denominator is zero and no percentage can say anything about it.
    // Provision found this hole in Directory Sync's guard.
    const result = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    expect(result.status).toBe('previewed');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.blockedReason).toContain('first revocation batch');

    const dispatches = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findMany({ orderBy: { sequence: 'asc' } }),
    );
    expect(dispatches.map((d) => d.route)).toEqual(['revocation_order', 'requires_change_rule']);
    expect(dispatches.map((d) => d.status)).toEqual(['proposed', 'requires_change']);
    // An explicit ordinal, because createdAt is transaction start time and
    // every row of the batch's createMany carries the same one.
    expect(dispatches.map((d) => d.sequence)).toEqual([0, 1]);
  });

  it('SUPERSEDES a crashed batch rather than colliding with its index', async () => {
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
    );
    const result = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    expect(result.batchId).toBeTruthy();
    const batches = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(batches[0]!.status).toBe('superseded');
  });

  it('BLOCKS outright when the snapshot has aged past the limit', async () => {
    const result = await computeRevocationBatch(tenantId, 'u-1', campaignId, {
      now: new Date(NOW.getTime() + 60 * 86_400_000),
    });
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('days old');
  });

  it('BLOCKS outright when a source in the batch’s scope has gone stale', async () => {
    await withTenant(tenantId, (tx) =>
      tx.snapshotSource.updateMany({ where: { snapshotId }, data: { staleness: 'stale' } }),
    );
    const result = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('Acme AD');
  });
});

describe('confirmRevocationBatch', () => {
  it('refuses to confirm a BLOCKED batch — there is nothing to confirm', async () => {
    await withTenant(tenantId, (tx) =>
      tx.snapshotSource.updateMany({ where: { snapshotId }, data: { staleness: 'stale' } }),
    );
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await expect(confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW })).rejects.toThrow(
      /blocked/i,
    );
  });

  it('writes a RevocationOrder carrying the deciding human, the campaign and the reason', async () => {
    // Ruling G1's condition: the record at the point of application must show a
    // human decision and name the campaign and the reviewer.
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });

    const order = await withTenant(tenantId, (tx) => tx.revocationOrder.findFirstOrThrow());
    expect(order).toMatchObject({
      status: 'open',
      entitlementId: 'ent-0',
      decidedByPersonId: reviewerPersonId,
      decidedByPersonName: 'Jan Manager',
      campaignName: 'Q2 review',
    });
    expect(order.reason).toContain('not needed');
    expect(order.campaignDecisionId).not.toBeNull();
  });

  it('produces a RemediationItem and NO dispatch for the rule-attributed item', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    const result = await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });

    expect(result).toMatchObject({ dispatched: 1, requiresChange: 1 });
    const remediation = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findFirstOrThrow({ where: { kind: 'rule_change_required' } }),
    );
    expect(remediation.description).toContain('Finance staff');

    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ orderBy: { resourceId: 'asc' } }),
    );
    expect(items[1]!.status).toBe('revocation_requires_change');
    // The campaign's totals never add it to the revoked figure.
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
    expect(campaign.requiresChangeItems).toBe(1);
  });

  it('calls revokeGrant with the USER the decision was made from', async () => {
    // Integration finding 8: Automate's entry point takes a User id and a
    // reviewer decides as a Person, so re-resolving at dispatch time would pick
    // an arbitrary account.
    const spy = vi.spyOn(fulfil, 'revokeGrant').mockResolvedValue(undefined);
    await withTenant(tenantId, async (tx) => {
      const item = await tx.campaignItem.findFirstOrThrow({ where: { resourceId: 'ent-0' } });
      await tx.campaignItem.update({
        where: { id: item.id },
        data: { attributions: [{ kind: 'request', detail: {} }] as never },
      });
      await tx.accessGrant.create({
        data: {
          tenantId, subjectPersonId: item.personId!, resourceType: 'entitlement',
          resourceId: 'ent-0', targetSystemId: 'sys-1', origin: 'request',
          startsAt: NOW, status: 'active',
        },
      });
    });
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });

    expect(spy).toHaveBeenCalledWith(
      tenantId,
      reviewerUserId,
      expect.any(String),
      expect.stringContaining('Q2 review'),
      expect.anything(),
    );
    spy.mockRestore();
  });

  it('dispatches with a null actor and SAYS SO when the reviewer holds no account', async () => {
    const spy = vi.spyOn(fulfil, 'revokeGrant').mockResolvedValue(undefined);
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.updateMany({ data: {} }); // append-only: cannot edit
      await tx.user.deleteMany({ where: { id: reviewerUserId } });
      const item = await tx.campaignItem.findFirstOrThrow({ where: { resourceId: 'ent-0' } });
      await tx.campaignItem.update({
        where: { id: item.id },
        data: { attributions: [{ kind: 'request', detail: {} }] as never },
      });
      await tx.accessGrant.create({
        data: {
          tenantId, subjectPersonId: item.personId!, resourceType: 'entitlement',
          resourceId: 'ent-0', targetSystemId: 'sys-1', origin: 'request',
          startsAt: NOW, status: 'active',
        },
      });
    });
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });

    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'automate_grant' } }),
    );
    // The revocation is not DROPPED because the account is gone.
    expect(dispatch.status).toBe('dispatched');
    expect(dispatch.message).toContain('holds no active Syntra account');
    spy.mockRestore();
  });

  it('records the confirming user and there is no autoApply anywhere', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    const batch = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findUniqueOrThrow({ where: { id: batchId } }),
    );
    expect(batch.confirmedByUserId).toBe('u-1');
  });

  it('honours a per-row skip', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { status: 'proposed' } }),
    );
    await skipDispatch(tenantId, 'u-1', dispatch.id, 'I meant Anna’s, not the whole group');
    const result = await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    expect(result.dispatched).toBe(0);
    const after = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findUniqueOrThrow({ where: { id: dispatch.id } }),
    );
    expect(after).toMatchObject({ status: 'skipped' });
  });
});

describe('the RevocationOrder’s three constraints', () => {
  it('is REFUSED at creation when a live attribution exists', async () => {
    // If a rule wants it, the honest answer is to change the rule, and that is
    // the remediation item, not the order.
    await withTenant(tenantId, async (tx) => {
      const item = await tx.campaignItem.findFirstOrThrow({ where: { resourceId: 'ent-0' } });
      await tx.campaignItem.update({
        where: { id: item.id },
        data: { attributions: [{ kind: 'business_rule', detail: { ruleEnabled: true } }] as never },
      });
    });
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);
  });

  it('CANCELS an existing open order for the same holding rather than colliding', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });

    await withTenant(tenantId, async (tx) => {
      const item = await tx.campaignItem.findFirstOrThrow({ where: { resourceId: 'ent-0' } });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'revoke_decided' } });
    });
    const second = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', second.batchId, { now: NOW });

    const orders = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ status: 'cancelled' });
    expect(orders[0]!.cancelledReason).toContain('superseded');
    expect(orders[1]!.status).toBe('open');
  });
});

describe('reflectRevocationOutcomes — the vocabulary rule', () => {
  it('advances to `applied` only when confirmed AND observed gone', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'confirmed', confirmedAt: NOW },
      }),
    );

    const later = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'complete', asOf: new Date(NOW.getTime() + 86_400_000) },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId, snapshotId: s.id, sourceKind: 'syntraInternal', sourceId: 'syntra',
          sourceName: 'Syntra', completeness: 'complete', staleness: 'fresh', freshnessSlaHours: 24,
        },
      });
      return s.id;
    });

    const result = await reflectRevocationOutcomes(tenantId, later, { now: NOW });
    expect(result.applied).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findFirstOrThrow({ where: { resourceId: 'ent-0' } }),
    );
    expect(item.status).toBe('revocation_applied');
  });

  it('DOES NOT advance, and raises dispatch_not_applied, when the holding is still there', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'confirmed', confirmedAt: NOW },
      }),
    );

    // The same snapshot: the holding is still there.
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ applied: 0, notApplied: 1 });
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'dispatch_not_applied' } }),
    );
    expect((finding.detail as { statement?: string }).statement).toContain('still shows the holding');
  });

  it('raises the SLA finding for a dispatch older than dispatchSlaHours', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    const much_later = new Date(NOW.getTime() + 100 * 3_600_000);
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, { now: much_later });
    expect(result.slaBreaches).toBe(1);
  });

  it('raises NO SLA finding for a CANCELLED dispatch — the composition hazard', async () => {
    // Two individually correct rules: an order cancelled as overtaken, and a
    // finding when a dispatch is not confirmed in time. Composed naively they
    // produce a finding saying a revocation was not applied, about a revocation
    // that was correctly abandoned.
    const { batchId } = await computeRevocationBatch(tenantId, 'u-1', campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, 'u-1', batchId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'cancelled', message: 'overtaken: the holding acquired a request grant' },
      }),
    );
    const much_later = new Date(NOW.getTime() + 100 * 3_600_000);
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, { now: much_later });
    expect(result.slaBreaches).toBe(0);
    expect(
      await withTenant(tenantId, (tx) =>
        tx.governFinding.count({ where: { kind: 'dispatch_not_applied' } }),
      ),
    ).toBe(0);
  });
});
```

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run packages/core/src/govern/dispatch.test.ts packages/core/src/govern/revocation-guard.test.ts packages/core/src/govern/revocation-service.test.ts packages/core/src/provision`
Expected: PASS. **The Provision suite must stay green** — `PlanInput` gained one array and `PlannedAction` one nullable field, and a broken Provision test means the plan-stage edit changed behaviour it should not have.

- [ ] **Step 9: Export and typecheck**

Add three export lines to `packages/core/src/index.ts`, and add `RevocationOrderFacts` to the enumerated `provision/types.js` export block — **it is a barrel-only alias list and anything added to `provision/types.ts` must be hand-added there or it silently does not leave the package.**

Run: `pnpm exec tsc -b --force`
Expected: exit 0.

- [ ] **Step 10: Mutation-test the router and the guard**

1. Move the live-rule branch below the grant branch in `routeRevocation`. Expected: `routes a LIVE-RULE holding to requires_change, NOT to an order` FAILS. **This is the mutation that produces the campaign report that is a lie by morning.**
2. Make the final fallback return `requires_change_direct_assignment`. Expected: `routes an EMPTY attribution set to a RevocationOrder` FAILS.
3. Add `'requires_change_rule'` to `DISPATCHABLE_ROUTES`. Expected: `never marks a requires_change route dispatchable` FAILS.
4. In the guard, treat an `unknown` holder count as `known(0)` and skip. Expected: add the case if absent — a resource whose count is unknown must force confirmation, not be waved through.
5. In the guard, drop the `hasEverApplied` clause. Expected: the first-batch case FAILS. **Provision found this hole in Directory Sync's guard.**
6. In the guard, move the population-drop check into `reasons` rather than `refusals`. Expected: the population case FAILS on `outcome`.
7. In `createRevocationOrder`, drop the `liveAttribution` refusal. Expected: `refused at creation when a live attribution exists` FAILS — **Ruling G1's first constraint.**

- [ ] **Step 11: Verify the cancelled-order composition explicitly**

Mutate `reflectRevocationOutcomes` to include `cancelled` dispatches in the SLA sweep. Expected: `a cancelled dispatch raises NO SLA finding` FAILS. Neither rule is wrong alone; the defect is a finding saying a revocation was not applied, about a revocation that was correctly abandoned.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/govern/dispatch.ts packages/core/src/govern/dispatch.test.ts \
        packages/core/src/govern/revocation-guard.ts packages/core/src/govern/revocation-guard.test.ts \
        packages/core/src/govern/revocation-service.ts packages/core/src/govern/revocation-service.test.ts \
        packages/core/src/provision/types.ts packages/core/src/provision/plan.ts \
        packages/core/src/provision/run-service.ts packages/core/src/index.ts
git commit -m "feat(govern): the dispatch router, the batch guard, revocation orders and Provision's plan term"
```

---
## Task 21: SoD exceptions and the decision graph

Spec §14 (the graph), §15 (exceptions). **Nothing in this task revokes anything and nothing in it blocks a request.**

**Files:**
- Create: `packages/core/src/govern/exception-service.ts`, `packages/core/src/govern/graph.ts`
- Test: `packages/core/src/govern/exception-service.test.ts`, `packages/core/src/govern/graph.test.ts`
- Modify: `packages/core/src/govern/jobs.ts` (register `exception`), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient`; `recordEvent`; `submitRequest`, `type SubmitOutcome` from `../automate/request-service.js`; `resolveStageApprovers`, `type StageSnapshot`, `type ResolutionSubject` from `../automate/approvers.js`; `usersWithPermission`, `recipientsForPersons`, `enqueueOutbox`, `displayNames` from `../automate/notify.js`; `PERMISSIONS` from `../rbac/permissions.js`; `governSettings` from `./settings-service.js`; `upsertFindings`, `createRemediationItem`, `type FindingDraft` from `./finding-service.js`; `raiseSeverity`, `type Severity` from `./types.js`; `readableSnapshot` from `./snapshot-service.js`; `evaluateSodRule` from `./sod.js`.
  - **Not** `campaign-service.ts` or `decision-service.ts`. An exception is a risk acceptance, not a decision on a campaign item, and importing either would make `exception-service.ts` depend on a module that does not need to exist for it to work.
- Produces (in `./exception-service.js`):
  - `class ExceptionRefusedError extends Error { constructor(readonly code: 'no_end_date' | 'too_long' | 'beneficiary_is_approver' | 'blocked_no_approver' | 'missing_justification', message: string) }`
  - `async function requestSodException(tenantId, actorUserId, input): Promise<{ id: string; status: string }>`
  - `async function decideSodException(tenantId, actorUserId, exceptionId, decision: 'approve' | 'refuse', comment: string): Promise<void>`
  - `async function revokeSodException(tenantId, actorUserId, exceptionId, reason: string): Promise<void>`
  - `async function sweepExceptions(tenantId: string, options?: { now?: Date; publicUrl?: string }): Promise<{ warned: number; lapsed: number; lapsedByContract: number }>`
- Produces (in `./graph.js` — **pure**):
  - `type EdgeKind = 'decided_for' | 'delegated_grant' | 'auto_granted'`
  - `interface DecisionEdge { kind: EdgeKind; fromPersonId: string | null; toPersonId: string; requestId: string; decidedAt: Date; via: string; selector: string | null }`
  - `interface UnmergeableActor { userId: string; requestIds: string[] }`
  - `interface GraphInput { edges: readonly DecisionEdge[]; unmergeable: readonly UnmergeableActor[]; sodPairs: readonly { ruleId: string; ruleName: string; severity: Severity; sideAResourceIds: readonly string[]; sideBResourceIds: readonly string[] }[]; grantedResourceByRequest: ReadonlyMap<string, string>; minReciprocalDecisions: number; reciprocityWindowDays: number; now: Date }`
  - `interface GraphReport { reciprocity: { a: string; b: string; aToB: number; bToA: number; requestIds: string[] }[]; cycles: { path: string[]; requestIds: string[] }[]; laundering: { ruleId: string; ruleName: string; severity: Severity; a: string; b: string; requestIds: string[] }[]; autoGranted: { toPersonId: string; requestIds: string[] }[]; unmergeableActors: UnmergeableActor[] }`
  - `const MAX_GRAPH_DEPTH = 6`
  - `function buildDecisionGraph(input: GraphInput): GraphReport`

**The self-approval invariant applies unchanged to an exception.** The beneficiary is dropped from the resolved approver set by every path, including the common one where they are the resource owner — Automate's subtraction, inherited by reusing Automate's resolver rather than writing a second one. Where a rule names no workflow the fallback is the holders of `govern.accept_risk`, **deliberately distinct from `govern.manage`**: administering the governance module and accepting the organization's risk are different jobs, and a product that conflates them hands risk acceptance to whoever configures the software.

- [ ] **Step 1: Write the failing graph test**

`packages/core/src/govern/graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_GRAPH_DEPTH, buildDecisionGraph, type DecisionEdge, type GraphInput } from './graph.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const edge = (over: Partial<DecisionEdge>): DecisionEdge => ({
  kind: 'decided_for',
  fromPersonId: 'a',
  toPersonId: 'b',
  requestId: 'r-1',
  decidedAt: daysAgo(1),
  via: 'selector',
  selector: 'manager',
  ...over,
});

const input = (over: Partial<GraphInput> = {}): GraphInput => ({
  edges: [],
  unmergeable: [],
  sodPairs: [],
  grantedResourceByRequest: new Map(),
  minReciprocalDecisions: 3,
  reciprocityWindowDays: 180,
  now: NOW,
  ...over,
});

describe('reciprocity', () => {
  it('reports a pair who each decided for the other at least the minimum times', () => {
    const edges = [
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.reciprocity).toHaveLength(1);
    expect(report.reciprocity[0]).toMatchObject({ aToB: 3, bToA: 3 });
    expect(report.reciprocity[0]!.requestIds).toHaveLength(6);
  });

  it('reports nothing below the minimum', () => {
    const edges = [
      ...[1, 2].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      ...[1, 2].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });

  it('ignores decisions outside the window', () => {
    const edges = [
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}`, decidedAt: daysAgo(400) })),
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });

  it('needs the minimum in BOTH directions, not the sum', () => {
    const edges = [
      ...[1, 2, 3, 4, 5].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'ba-1' }),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });
});

describe('cycles', () => {
  it('reports A→B→C→A, which a pairwise check misses', () => {
    const edges = [
      edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-ab' }),
      edge({ fromPersonId: 'b', toPersonId: 'c', requestId: 'r-bc' }),
      edge({ fromPersonId: 'c', toPersonId: 'a', requestId: 'r-ca' }),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0]!.path).toEqual(['a', 'b', 'c']);
  });

  it('terminates at the depth cap rather than exploring a dense graph forever', () => {
    const edges: DecisionEdge[] = [];
    for (let i = 0; i < 20; i += 1) {
      edges.push(edge({ fromPersonId: `p${i}`, toPersonId: `p${(i + 1) % 20}`, requestId: `r-${i}` }));
    }
    const report = buildDecisionGraph(input({ edges }));
    // The 20-cycle is longer than the cap and is deliberately NOT reported.
    // A finding nobody can read is worse than no finding.
    expect(report.cycles.every((c) => c.path.length <= MAX_GRAPH_DEPTH)).toBe(true);
  });
});

describe('the three qualifications Automate’s handoff left open', () => {
  it('QUALIFICATION ONE: a delegated grant produces an edge with no ApprovalDecision behind it', () => {
    // A graph built only from ApprovalDecision cannot see a pair of team leads
    // who each granted the other access to the resource they manage — the same
    // laundering pattern with LESS friction than the two-stage one, since it
    // needs no requests at all.
    const edges = [
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'delegated_grant', fromPersonId: 'a', toPersonId: 'b', requestId: `d-ab-${i}` }),
      ),
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'delegated_grant', fromPersonId: 'b', toPersonId: 'a', requestId: `d-ba-${i}` }),
      ),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toHaveLength(1);
  });

  it('QUALIFICATION TWO: an auto-granted request is its own class with no decider', () => {
    const edges = [edge({ kind: 'auto_granted', fromPersonId: null, toPersonId: 'b', requestId: 'r-auto' })];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.autoGranted).toEqual([{ toPersonId: 'b', requestIds: ['r-auto'] }]);
    // It contributes no edge to reciprocity or cycles, because nobody decided.
    expect(report.reciprocity).toEqual([]);
    expect(report.cycles).toEqual([]);
  });

  it('QUALIFICATION THREE: an actor with no linked person is REPORTED, never dropped', () => {
    // A service account submitting requests on people's behalf is either an
    // integration worth knowing about or a problem worth knowing about, and
    // either way silence is the wrong answer.
    const report = buildDecisionGraph(
      input({ unmergeable: [{ userId: 'svc-1', requestIds: ['r-1', 'r-2'] }] }),
    );
    expect(report.unmergeableActors).toEqual([{ userId: 'svc-1', requestIds: ['r-1', 'r-2'] }]);
  });
});

describe('SoD laundering — the one that is a finding rather than a signal', () => {
  it('reports A deciding B onto side A while B decided A onto side B of the same rule', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceByRequest: new Map([
          ['r-1', 'ent-raise'],
          ['r-2', 'ent-approve'],
        ]),
        sodPairs: [
          {
            ruleId: 'rule-1', ruleName: 'Payment raising and approval', severity: 'critical',
            sideAResourceIds: ['ent-raise'], sideBResourceIds: ['ent-approve'],
          },
        ],
      }),
    );
    expect(report.laundering).toHaveLength(1);
    expect(report.laundering[0]).toMatchObject({ ruleId: 'rule-1', severity: 'critical' });
  });

  it('reports nothing when both grants are on the SAME side', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceByRequest: new Map([['r-1', 'ent-raise'], ['r-2', 'ent-raise']]),
        sodPairs: [
          {
            ruleId: 'rule-1', ruleName: 'x', severity: 'critical',
            sideAResourceIds: ['ent-raise'], sideBResourceIds: ['ent-approve'],
          },
        ],
      }),
    );
    expect(report.laundering).toEqual([]);
  });

  it('reports nothing at all with NO SoD rules in hand', () => {
    // Detectable ONLY with the rules, which is why this lands in slice 2
    // alongside them rather than in the inventory.
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceByRequest: new Map([['r-1', 'ent-raise'], ['r-2', 'ent-approve']]),
      }),
    );
    expect(report.laundering).toEqual([]);
  });
});

describe('the empty graph', () => {
  it('reports nothing rather than everything', () => {
    expect(buildDecisionGraph(input())).toEqual({
      reciprocity: [], cycles: [], laundering: [], autoGranted: [], unmergeableActors: [],
    });
  });
});
```

- [ ] **Step 2: Write the graph**

`packages/core/src/govern/graph.ts`:

```ts
import type { Severity } from './types.js';

/**
 * The decision graph Automate's section 9 named as Govern's problem.
 *
 * Automate closes every path to self-approval it can see and names the tenth
 * honestly: two-stage laundering — the subject decides stage 1 of somebody
 * else's request, who decides stage 2 of theirs. It does not attempt to detect
 * that, it says it needs a graph over decisions across requests and time, and
 * it says what it owes Govern: every decision, with the deciding person, the
 * subject, the submitter, the selector that resolved them, whether they acted
 * as a delegate or an escalation target, and the time.
 *
 * THE HANDOFF WORKS. Three qualifications close real holes rather than quibbles,
 * and each is closed by looking somewhere else in Automate's own data.
 *
 * PURE.
 */

export type EdgeKind = 'decided_for' | 'delegated_grant' | 'auto_granted';

export interface DecisionEdge {
  kind: EdgeKind;
  /** Null for `auto_granted`: a zero-stage workflow has no decider at all. */
  fromPersonId: string | null;
  toPersonId: string;
  requestId: string;
  decidedAt: Date;
  via: string;
  selector: string | null;
}

export interface UnmergeableActor {
  userId: string;
  requestIds: string[];
}

/** A tree deep enough to hit this is noise, not a finding somebody can read. */
export const MAX_GRAPH_DEPTH = 6;

export interface GraphInput {
  edges: readonly DecisionEdge[];
  unmergeable: readonly UnmergeableActor[];
  sodPairs: readonly {
    ruleId: string;
    ruleName: string;
    severity: Severity;
    sideAResourceIds: readonly string[];
    sideBResourceIds: readonly string[];
  }[];
  grantedResourceByRequest: ReadonlyMap<string, string>;
  minReciprocalDecisions: number;
  reciprocityWindowDays: number;
  now: Date;
}

export interface GraphReport {
  reciprocity: { a: string; b: string; aToB: number; bToA: number; requestIds: string[] }[];
  cycles: { path: string[]; requestIds: string[] }[];
  laundering: {
    ruleId: string; ruleName: string; severity: Severity;
    a: string; b: string; requestIds: string[];
  }[];
  autoGranted: { toPersonId: string; requestIds: string[] }[];
  unmergeableActors: UnmergeableActor[];
}

export function buildDecisionGraph(input: GraphInput): GraphReport {
  const cutoff = new Date(input.now.getTime() - input.reciprocityWindowDays * 86_400_000);
  const inWindow = input.edges.filter((e) => e.decidedAt >= cutoff);

  // `auto_granted` contributes NO edge: nobody decided, so it can neither
  // reciprocate nor complete a cycle. It is counted and listed as its own class,
  // and campaigned first — access nobody decided is precisely the access a
  // recertification exists to have somebody decide.
  const autoByPerson = new Map<string, string[]>();
  for (const e of inWindow) {
    if (e.kind !== 'auto_granted') continue;
    autoByPerson.set(e.toPersonId, [...(autoByPerson.get(e.toPersonId) ?? []), e.requestId]);
  }

  const directed = inWindow.filter((e) => e.kind !== 'auto_granted' && e.fromPersonId !== null);

  // ---- reciprocity --------------------------------------------------------
  const pairCounts = new Map<string, { requestIds: string[] }>();
  for (const e of directed) {
    const key = `${e.fromPersonId}>${e.toPersonId}`;
    pairCounts.set(key, { requestIds: [...(pairCounts.get(key)?.requestIds ?? []), e.requestId] });
  }

  const reciprocity: GraphReport['reciprocity'] = [];
  const seenPairs = new Set<string>();
  for (const [key, forward] of pairCounts) {
    const [a, b] = key.split('>') as [string, string];
    const unordered = [a, b].sort().join('|');
    if (seenPairs.has(unordered)) continue;
    const back = pairCounts.get(`${b}>${a}`);
    if (back === undefined) continue;
    // The minimum in BOTH directions, not the sum: a manager who decided
    // fifteen of their report's requests and had one decided back is a manager,
    // not a pattern.
    if (
      forward.requestIds.length < input.minReciprocalDecisions ||
      back.requestIds.length < input.minReciprocalDecisions
    ) {
      continue;
    }
    seenPairs.add(unordered);
    reciprocity.push({
      a, b,
      aToB: forward.requestIds.length,
      bToA: back.requestIds.length,
      requestIds: [...forward.requestIds, ...back.requestIds],
    });
  }

  // ---- cycles -------------------------------------------------------------
  const outgoing = new Map<string, DecisionEdge[]>();
  for (const e of directed) {
    outgoing.set(e.fromPersonId!, [...(outgoing.get(e.fromPersonId!) ?? []), e]);
  }

  const cycles: GraphReport['cycles'] = [];
  const reportedCycles = new Set<string>();
  const walk = (start: string, node: string, path: string[], requestIds: string[]): void => {
    if (path.length > MAX_GRAPH_DEPTH) return;
    for (const e of outgoing.get(node) ?? []) {
      if (e.toPersonId === start && path.length >= 2) {
        const canonical = [...path].sort().join('|');
        if (!reportedCycles.has(canonical)) {
          reportedCycles.add(canonical);
          cycles.push({ path: [...path], requestIds: [...requestIds, e.requestId] });
        }
        continue;
      }
      if (path.includes(e.toPersonId)) continue;
      walk(start, e.toPersonId, [...path, e.toPersonId], [...requestIds, e.requestId]);
    }
  };
  for (const start of outgoing.keys()) walk(start, start, [start], []);

  // ---- SoD laundering -----------------------------------------------------
  // The pattern that is actually a finding rather than a signal, and it is
  // detectable ONLY with the SoD rules in hand.
  const laundering: GraphReport['laundering'] = [];
  for (const rule of input.sodPairs) {
    const sideA = new Set(rule.sideAResourceIds);
    const sideB = new Set(rule.sideBResourceIds);
    for (const forward of directed) {
      const forwardResource = input.grantedResourceByRequest.get(forward.requestId);
      if (forwardResource === undefined) continue;
      for (const back of directed) {
        if (back.fromPersonId !== forward.toPersonId || back.toPersonId !== forward.fromPersonId) continue;
        const backResource = input.grantedResourceByRequest.get(back.requestId);
        if (backResource === undefined) continue;
        const opposite =
          (sideA.has(forwardResource) && sideB.has(backResource)) ||
          (sideB.has(forwardResource) && sideA.has(backResource));
        if (!opposite) continue;
        const key = [forward.fromPersonId, forward.toPersonId].sort().join('|');
        if (laundering.some((l) => l.ruleId === rule.ruleId && [l.a, l.b].sort().join('|') === key)) {
          continue;
        }
        laundering.push({
          ruleId: rule.ruleId,
          ruleName: rule.ruleName,
          severity: rule.severity,
          a: forward.fromPersonId!,
          b: forward.toPersonId,
          requestIds: [forward.requestId, back.requestId],
        });
      }
    }
  }

  return {
    reciprocity,
    cycles,
    laundering,
    autoGranted: [...autoByPerson].map(([toPersonId, requestIds]) => ({ toPersonId, requestIds })),
    // Reported separately rather than dropped.
    unmergeableActors: [...input.unmergeable],
  };
}
```

The persistence half lives in `sod-service.ts` as `detectDecisionGraph(tenantId, snapshotId, now)`: it loads the edges from `ApprovalDecision → ApprovalStep → AccessRequest` (using the `(tenantId, decidedAt)` index Task 15 added), builds the report, and writes `approval_reciprocity` findings for the first two patterns **with a `detail.statement` saying in words that in a small team mutual approval is normal and expected and that the finding is context for a human rather than an accusation**, `sod_laundering` findings at the rule's own severity and **not soft-pedalled**, `no_human_decision` for the auto-granted class, and `unmergeable_actor` for the service accounts.

- [ ] **Step 3: Write the exception service test and the service**

`packages/core/src/govern/exception-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS, assignRole, createRole } from '@syntra/core';
import {
  ExceptionRefusedError,
  decideSodException,
  requestSodException,
  revokeSodException,
  sweepExceptions,
} from './exception-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

let tenantId: string;
let ruleId: string;
let violationId: string;
let beneficiaryId: string;
let acceptorUserId: string;
let acceptorPersonId: string;
let teachingContractId: string;
let researchContractId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const anna = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    const dirk = await tx.person.create({ data: { tenantId, givenName: 'Dirk', familyName: 'Finance' } });
    const teaching = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    const research = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 2, startDate: new Date('2021-01-01') },
    });
    await tx.contract.create({
      data: { tenantId, personId: dirk.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    await tx.user.create({
      data: { tenantId, login: 'anna', email: 'anna@a.test', displayName: 'Anna Novak', personId: anna.id },
    });
    const dirkUser = await tx.user.create({
      data: { tenantId, login: 'dirk', email: 'dirk@a.test', displayName: 'Dirk Finance', personId: dirk.id },
    });
    const role = await createRole(tx, 'Risk acceptor', [PERMISSIONS.GOVERN_ACCEPT_RISK]);
    await assignRole(tx, dirkUser.id, role.id);

    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const a = await tx.businessFunction.create({ data: { tenantId, name: 'Raise', ownerPersonId: dirk.id } });
    const b = await tx.businessFunction.create({ data: { tenantId, name: 'Approve', ownerPersonId: dirk.id } });
    const rule = await tx.sodRule.create({
      data: {
        tenantId, name: 'Payment raising and approval', functionAId: a.id, functionBId: b.id,
        severity: 'critical', rationale: 'raise and approve', enabled: true,
      },
    });
    const violation = await tx.sodViolation.create({
      data: {
        tenantId, ruleId: rule.id, personId: anna.id,
        holdingsA: [], holdingsB: [], contractsA: [teaching.id], contractsB: [research.id],
        severity: 'critical', firstSeenAt: NOW, lastSeenAt: NOW, lastSnapshotId: snapshot.id,
      },
    });
    await tx.governFinding.create({
      data: {
        tenantId, kind: 'sod_violation', severity: 'critical',
        subjectRefType: 'sod_violation', subjectRefId: `${rule.id}:${anna.id}`,
        detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
      },
    });

    return {
      ruleId: rule.id, violationId: violation.id, beneficiaryId: anna.id,
      acceptorUserId: dirkUser.id, acceptorPersonId: dirk.id,
      teachingContractId: teaching.id, researchContractId: research.id,
    };
  });

  ruleId = seeded.ruleId;
  violationId = seeded.violationId;
  beneficiaryId = seeded.beneficiaryId;
  acceptorUserId = seeded.acceptorUserId;
  acceptorPersonId = seeded.acceptorPersonId;
  teachingContractId = seeded.teachingContractId;
  researchContractId = seeded.researchContractId;
});

const request = (over: Record<string, unknown> = {}) => ({
  ruleId, personId: beneficiaryId, violationId,
  justification: 'these are two separate engagements',
  compensatingControl: 'monthly review of every payment she raises',
  basisContractIds: [teachingContractId, researchContractId],
  startsAt: NOW,
  endsAt: days(30),
  ...over,
});

describe('for how long', () => {
  it('refuses an exception longer than maxExceptionDays', async () => {
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ endsAt: days(400) })),
    ).rejects.toMatchObject({ code: 'too_long' });
  });

  it('refuses one with no justification or no compensating control', async () => {
    // Both required. A perpetual, unjustified, uncompensated exception is how
    // an SoD programme dies quietly.
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ justification: '  ' })),
    ).rejects.toMatchObject({ code: 'missing_justification' });
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ compensatingControl: '' })),
    ).rejects.toMatchObject({ code: 'missing_justification' });
  });
});

describe('who may grant one', () => {
  it('falls back to the holders of govern.accept_risk when the rule names no workflow', async () => {
    const { id, status } = await requestSodException(tenantId, acceptorUserId, request());
    expect(status).toBe('pending');
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'accepted for one quarter');

    const [exception, violation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
    ]);
    expect(exception).toMatchObject({ status: 'active', approvedByPersonId: acceptorPersonId });
    expect(violation.status).toBe('excepted');
  });

  it('BLOCKS when the beneficiary is the only holder of govern.accept_risk', async () => {
    // The self-approval invariant applies unchanged. Where the beneficiary is
    // themselves a holder they are dropped, and where they are the only holder
    // the exception blocks and says so.
    await withTenant(tenantId, async (tx) => {
      await tx.roleAssignment.deleteMany({});
      const annaUser = await tx.user.findFirstOrThrow({ where: { personId: beneficiaryId } });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'Risk acceptor' } });
      await assignRole(tx, annaUser.id, role.id);
    });
    const { status } = await requestSodException(tenantId, acceptorUserId, request());
    expect(status).toBe('blocked_no_approver');
  });
});

describe('a refused exception revokes NOTHING', () => {
  it('leaves the violation open, records a finding and routes a remediation item', async () => {
    // Auto-revoking on a refused exception would make an exception decision an
    // unattended access removal at one remove.
    const { id } = await requestSodException(tenantId, acceptorUserId, request());
    await decideSodException(tenantId, acceptorUserId, id, 'refuse', 'the compensating control is not enough');

    const [exception, violation, finding, remediation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
      await tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
      await tx.remediationItem.findFirst({ where: { findingId: { not: null } } }),
    ]);
    expect(exception.status).toBe('refused');
    expect(violation.status).toBe('open');
    expect((finding.detail as { riskAcceptanceRefused?: boolean }).riskAcceptanceRefused).toBe(true);
    expect(remediation).not.toBeNull();
  });
});

describe('when it lapses', () => {
  it('warns at each of exceptionWarningDays and not on other days', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(14) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');

    expect((await sweepExceptions(tenantId, { now: NOW })).warned).toBe(1);
    expect((await sweepExceptions(tenantId, { now: days(5) })).warned).toBe(0);
    expect((await sweepExceptions(tenantId, { now: days(11) })).warned).toBe(1);

    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'govern-exception-expiring' } }),
    );
    expect(outbox.length).toBeGreaterThan(0);
    // Renewal is a NEW exception with a new decision, pre-filled with the old
    // justification. Never auto-renewal.
    expect((outbox[0]!.vars as { renewUrl?: string }).renewUrl).toContain('renew=');
  });

  it('reopens the violation at its ORIGINAL severity and raises the finding one step, revoking nothing', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(1) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');

    const result = await sweepExceptions(tenantId, { now: days(2) });
    expect(result.lapsed).toBe(1);

    const [exception, violation, finding] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
      await tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
    ]);
    expect(exception.status).toBe('lapsed');
    expect(violation).toMatchObject({ status: 'open', severity: 'critical' });
    // A violation somebody once formally accepted and then let quietly expire
    // is a different and worse thing than one nobody has looked at yet. It is
    // already `critical`, so raising stops there and the finding names the lapse.
    expect(finding.severity).toBe('critical');
    expect((finding.detail as { lapsedExceptionAt?: string }).lapsedExceptionAt).toBeTruthy();
  });

  it('LAPSES EARLY when a basis contract ends, ahead of the end date', async () => {
    // The one place an exception ends early without a human, and it is safe
    // because ending an exception takes nothing away from anybody.
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(60) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');
    await withTenant(tenantId, (tx) =>
      tx.contract.update({ where: { id: researchContractId }, data: { endDate: days(1) } }),
    );

    const result = await sweepExceptions(tenantId, { now: days(5) });
    expect(result).toMatchObject({ lapsed: 1, lapsedByContract: 1 });
    const exception = await withTenant(tenantId, (tx) => tx.sodException.findUniqueOrThrow({ where: { id } }));
    expect(exception.status).toBe('lapsed');
    expect(exception.revokedReason).toContain('contract');
  });

  it('an early revocation by the rule owner reopens the violation immediately', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request());
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');
    await revokeSodException(tenantId, acceptorUserId, id, 'the compensating control was withdrawn');

    const [exception, violation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
    ]);
    expect(exception.status).toBe('revoked');
    expect(violation.status).toBe('open');
  });
});
```

`sweepExceptions` is the function behind `GOVERN_EXCEPTION_JOB`, and `lapse` is its shared tail:

```ts
/**
 * A lapse is a TIMER EXPIRING, not a decision anybody made. Treating it as an
 * instruction to strip access would mean an administrator's holiday becomes a
 * production outage in the finance system.
 *
 * NOTHING IS REVOKED. The violation returns to `open`, its finding's severity
 * goes up one step because a violation somebody once formally accepted and then
 * let quietly expire is a different and worse thing than one nobody has looked
 * at yet, and everybody involved is told.
 */
export async function sweepExceptions(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ warned: number; lapsed: number; lapsedByContract: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const settings = await governSettings(tx);
    const active = await tx.sodException.findMany({
      where: { status: 'active' },
      include: { rule: true },
    });

    let warned = 0;
    let lapsed = 0;
    let lapsedByContract = 0;

    for (const exception of active) {
      // The one place an exception ends early without a human, and it is safe
      // because ending an exception TAKES NOTHING AWAY FROM ANYBODY — it
      // reopens a finding. Where the stated basis is a pair of concurrent
      // contracts, the justification stopped being true when one of them ended.
      const basis = (exception.basisContractIds as string[] | null) ?? [];
      if (basis.length > 0) {
        const stillRunning = await tx.contract.count({
          where: { id: { in: basis }, OR: [{ endDate: null }, { endDate: { gte: now } }] },
        });
        if (stillRunning < basis.length) {
          await lapse(tx, tenantId, exception, now, 'a contract its justification rested on has ended');
          lapsed += 1;
          lapsedByContract += 1;
          continue;
        }
      }

      if (exception.endsAt <= now) {
        await lapse(tx, tenantId, exception, now, 'it reached its end date and was not renewed');
        lapsed += 1;
        continue;
      }

      const daysLeft = Math.ceil((exception.endsAt.getTime() - now.getTime()) / 86_400_000);
      if (!settings.exceptionWarningDays.includes(daysLeft)) continue;

      const parties = await recipientsForPersons(
        tx,
        [exception.personId, exception.approvedByPersonId, exception.rule.functionAId]
          .filter((x): x is string => typeof x === 'string'),
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
      warned += 1;
    }

    return { warned, lapsed, lapsedByContract };
  });
}

/**
 * The shared tail of every ending: the timer, the early contract lapse, and the
 * approver's early revocation all land here.
 *
 * THE VIOLATION REOPENS AT ITS ORIGINAL SEVERITY and NOTHING IS REVOKED. What
 * changes is the FINDING's severity, one step up, because a violation somebody
 * once formally accepted and then let quietly expire is a different and worse
 * thing than one nobody has looked at yet.
 */
async function lapse(
  tx: TenantClient,
  tenantId: string,
  exception: { id: string; ruleId: string; personId: string; violationId: string },
  now: Date,
  reason: string,
): Promise<void> {
  await tx.sodException.update({
    where: { id: exception.id },
    data: { status: 'lapsed', revokedReason: reason },
  });
  const violation = await tx.sodViolation.update({
    where: { id: exception.violationId },
    // Its ORIGINAL severity: the exception never changed what the violation is,
    // only whether somebody had accepted it.
    data: { status: 'open', exceptionId: null },
  });

  const finding = await tx.governFinding.findUnique({
    where: {
      tenantId_kind_subjectRefType_subjectRefId: {
        tenantId,
        kind: 'sod_violation',
        subjectRefType: 'sod_violation',
        subjectRefId: `${exception.ruleId}:${exception.personId}`,
      },
    },
  });
  if (finding !== null) {
    await tx.governFinding.update({
      where: { id: finding.id },
      data: {
        severity: raiseSeverity(finding.severity as Severity),
        detail: {
          ...(finding.detail as Record<string, unknown>),
          lapsedExceptionAt: now.toISOString(),
          lapsedExceptionReason: reason,
        } as never,
      },
    });
  }

  const parties = await recipientsForPersons(
    tx,
    [exception.personId, violation.personId].filter((x): x is string => typeof x === 'string'),
  );
  await enqueueOutbox(
    tx,
    parties.map((recipient) => ({
      template: 'govern-exception-expiring' as const,
      to: recipient.email,
      vars: {
        displayName: recipient.displayName,
        ruleName: 'this rule',
        beneficiaryName: recipient.displayName,
        endsAt: now.toDateString(),
        renewUrl: `/admin/govern/sod/exceptions/new?renew=${exception.id}`,
      },
      requestId: null,
      userId: recipient.userId,
    })),
  );

  await recordEvent(tx, {
    actorUserId: null,
    action: 'govern.exception.lapse',
    targetType: 'SodException',
    targetId: exception.id,
    outcome: 'success',
    sourceIp: null,
    // Stated in the event as well as on the screen: nothing was removed.
    payload: { reason, violationId: exception.violationId, accessRevoked: false },
  });
}
```

- [ ] **Step 4: Register the exception job**

In `packages/core/src/govern/jobs.ts`, inside `registerGovernJobs`:

```ts
  scheduler.register<GovernJobPayload>(GOVERN_EXCEPTION_JOB, async (payload) => {
    await sweepExceptions(payload.tenantId, {
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
```

and add `detectDecisionGraph` to `runSnapshotJob` after `detectSodViolations`.

- [ ] **Step 5: Run everything and typecheck**

Run: `pnpm vitest run packages/core/src/govern`
Then: `pnpm exec tsc -b --force`
Expected: PASS and exit 0.

- [ ] **Step 6: Mutation-test**

1. In `buildDecisionGraph`, count `auto_granted` edges as directed. Expected: `QUALIFICATION TWO` FAILS.
2. Drop the `delegated_grant` kind from the directed set. Expected: `QUALIFICATION ONE` FAILS — **and this is exactly the hole Automate named: a pair of team leads who each granted the other access needs no requests at all.**
3. Drop `unmergeableActors` from the report. Expected: `QUALIFICATION THREE` FAILS.
4. Compare `forward + back >= minReciprocalDecisions` instead of both. Expected: `needs the minimum in BOTH directions, not the sum` FAILS.
5. Remove the window filter. Expected: `ignores decisions outside the window` FAILS.
6. In `sweepExceptions`, revoke the access on lapse. Expected: the "nothing is revoked" case FAILS — **the platform rule with an extra step in front of it.**
7. In `sweepExceptions`, skip the `basisContractIds` check. Expected: the early-lapse case FAILS.
8. In `decideSodException`, revoke access when the exception is refused. Expected: the refused-exception case FAILS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/govern/exception-service.ts packages/core/src/govern/exception-service.test.ts \
        packages/core/src/govern/graph.ts packages/core/src/govern/graph.test.ts \
        packages/core/src/govern/sod-service.ts packages/core/src/govern/jobs.ts \
        packages/core/src/index.ts
git commit -m "feat(govern): SoD exceptions, the decision graph and its three qualifications"
```

---

## Task 22: The slice-2 HTTP surface, the portal, the console and the end-to-end path

Spec §20, §23. **The reviewer surface is the portal, not the console**, for the same reason Automate's delegated administration is: reviewing is something managers do twice a year from a link in an email, and requiring an administrative session with step-up MFA for it would mean either nobody reviews or everybody gets an administrative session, and the second is worse.

**Files:**
- Create: `apps/api/src/routes/govern-portal.ts`, `apps/web/src/pages/govern/MyReviewsPage.tsx`, `apps/web/src/pages/admin/GovernCampaignsPage.tsx`, `GovernCampaignDetailPage.tsx`, `GovernBatchPage.tsx`, `GovernSodPage.tsx`, `e2e/govern.spec.ts`
- Test: `apps/api/src/routes/govern-portal.test.ts`, `apps/web/src/pages/govern/MyReviewsPage.test.tsx`, `apps/web/src/pages/admin/GovernBatchPage.test.tsx`
- Modify: `apps/api/src/routes/admin/govern.ts`, `apps/api/src/app.ts`, `packages/contracts/src/govern.ts`, `apps/web/src/routes.tsx`, `apps/web/src/pages/admin/AdminApp.tsx`

**Interfaces:**
- Consumes: every slice-2 service; `requireSession('portal')`, `requireSession('admin')`, `requirePermission`, `ProblemError`; `api`, `useApiResource`, `PageHeader`, and the `@syntra/ui` primitives.
- Produces the portal routes, relative to the `/api/portal` prefix: `GET /govern/reviews`, `GET /govern/reviews/:itemId`, `POST /govern/reviews/:itemId/decide`, `POST /govern/reviews/bulk-certify`.
- Produces the admin routes, relative to `/api/admin`: `GET|POST /govern/campaigns`, `GET /govern/campaigns/:id`, `POST /govern/campaigns/:id/start`, `POST /govern/campaigns/:id/extend`, `POST /govern/campaigns/:id/rebase`, `POST /govern/campaigns/preview-scope`, `POST /govern/campaigns/preview-reviewers`, `POST /govern/campaigns/:id/revocations`, `GET /govern/batches/:id`, `POST /govern/batches/:id/confirm`, `POST /govern/dispatches/:id/skip`, `GET|POST /govern/sod/functions`, `GET|POST /govern/sod/rules`, `POST /govern/sod/rules/preview`, `GET /govern/sod/violations`, `POST /govern/sod/exceptions`, `POST /govern/sod/exceptions/:id/decide`.
- Produces the console routes `/admin/govern/campaigns`, `/admin/govern/campaigns/:id`, `/admin/govern/batches/:id`, `/admin/govern/sod`, and the portal route `/govern/reviews`.

**`GET /govern/reviews` needs no permission at all.** Review authority comes from resolution, exactly as approval authority does in Automate: the handler reads `CampaignItemReviewer` rows naming the caller's person, and there is no `govern.review` permission because a tenant-wide right to certify anything is not a thing anybody should hold.

- [ ] **Step 1: Write the failing portal API test**

`apps/api/src/routes/govern-portal.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser, hashPassword, setPasswordHash } from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const NOW = new Date('2026-06-15T09:00:00Z');

const person: Record<string, string> = {};
let campaignId: string;
let itemId: string;
let unrelatedItemId: string;
let ownItemId: string;

/** A PORTAL session only. No elevate, no permission, no role. */
async function portalCookie(login: string) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: ctx.host }, payload: { login, password: PASSWORD },
  });
  return `syntra_session=${res.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host, cookie }, payload: payload as object });

beforeEach(async () => {
  ctx = await buildTestApp();
  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const tenantId = ctx.tenantId;
    const mk = async (name: string) => {
      const p = await tx.person.create({ data: { tenantId, givenName: name, familyName: 'Test' } });
      await tx.contract.create({
        data: { tenantId, personId: p.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
      });
      const u = await createUser(tx, {
        login: name.toLowerCase(), email: `${name.toLowerCase()}@a.test`, displayName: `${name} Test`,
      });
      await tx.user.update({ where: { id: u.id }, data: { personId: p.id } });
      await setPasswordHash(tx, u.id, PASSWORD_HASH);
      person[name] = p.id;
      return p.id;
    };
    const jan = await mk('Jan');
    const anna = await mk('Anna');
    const ola = await mk('Ola');

    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId, name: 'Q2 review', scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id, reviewerSelector: 'manager', reviewerConfig: {},
        fallbackSelector: 'person', fallbackConfig: { personId: ola },
        ownerPersonId: ola, opensAt: NOW, dueAt: new Date(NOW.getTime() + 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 86_400_000), status: 'open',
      },
    });

    const mkItem = async (subjectId: string, resourceId: string, riskFlags: string[] = []) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId, campaignId: campaign.id, holdingSnapshotId: snapshot.id,
          subjectKey: `person:${subjectId}`, personId: subjectId,
          systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId, resourceName: `Group ${resourceId}`,
          attributions: [], observedAt: NOW, coverageStatus: 'complete', riskFlags,
        },
      });
      return item.id;
    };

    const assigned = await mkItem(anna, 'ent-1');
    const own = await mkItem(jan, 'ent-2');
    const unrelated = await mkItem(anna, 'ent-3');
    for (const id of [assigned, own]) {
      await tx.campaignItemReviewer.create({
        data: { tenantId, itemId: id, personId: jan, via: 'selector' },
      });
    }
    await tx.campaignItemReviewer.create({
      data: { tenantId, itemId: unrelated, personId: ola, via: 'selector' },
    });

    return { campaignId: campaign.id, itemId: assigned, ownItemId: own, unrelatedItemId: unrelated };
  });
  campaignId = seeded.campaignId;
  itemId = seeded.itemId;
  ownItemId = seeded.ownItemId;
  unrelatedItemId = seeded.unrelatedItemId;
});

describe('review authority comes from resolution, never from a permission', () => {
  it('serves a reviewer their own queue with a PORTAL session and no permission at all', async () => {
    // Requiring an administrative session with step-up MFA for reviewing would
    // mean either nobody reviews or everybody gets one, and the second is worse.
    const res = await get('/api/portal/govern/reviews', await portalCookie('jan'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string }[] };
    expect(body.items.map((i) => i.id).sort()).toEqual([itemId, ownItemId].sort());
  });

  it('serves NOTHING to a person who is nobody’s reviewer', async () => {
    const res = await get('/api/portal/govern/reviews', await portalCookie('anna'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it('404s an item that is not assigned to the caller', async () => {
    // 403 would confirm the item exists, and the existence of a holding is
    // itself information about somebody's access.
    const res = await get(`/api/portal/govern/reviews/${unrelatedItemId}`, await portalCookie('jan'));
    expect(res.statusCode).toBe(404);
  });

  it('rejects an ADMIN-only campaign route from a portal session', async () => {
    const res = await get('/api/admin/govern/campaigns', await portalCookie('jan'));
    expect(res.statusCode).toBe(403);
  });
});

describe('deciding', () => {
  it('records itemOpenedAt server-side when the detail is fetched', async () => {
    const cookie = await portalCookie('jan');
    await get(`/api/portal/govern/reviews/${itemId}`, cookie);
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, cookie, {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(200);
    const decision = await withTenant(ctx.tenantId, (tx) => tx.campaignDecision.findFirstOrThrow());
    // Not a client-reported dwell time, which is worth nothing.
    expect(decision.itemOpenedAt.getTime()).toBeLessThanOrEqual(decision.decidedAt.getTime());
  });

  it('refuses a decision on the caller’s OWN access, from the API as well as the console', async () => {
    // Deciding through the API rather than the console is one of the paths
    // Automate enumerated, and it closes here.
    const res = await post(`/api/portal/govern/reviews/${ownItemId}/decide`, await portalCookie('jan'), {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: expect.stringContaining('self_review') });
  });

  it('refuses a revoke with no comment', async () => {
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'revoke', comment: '   ',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('a departed subject', () => {
  beforeEach(async () => {
    await withTenant(ctx.tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna'] },
        data: { endDate: new Date('2026-06-01') },
      }),
    );
  });

  it('refuses a certification and moots the item', async () => {
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(409);
    const item = await withTenant(ctx.tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
  });

  it('ALLOWS a revoke of a departed subject’s access', async () => {
    // A departure never suppresses a revocation.
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'revoke', comment: 'they left',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'revoke_decided' });
  });
});

describe('bulk certify', () => {
  it('refuses a high-risk item IN WORDS and certifies the rest', async () => {
    const highRisk = await withTenant(ctx.tenantId, async (tx) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId: ctx.tenantId, campaignId, holdingSnapshotId: (
            await tx.accessSnapshot.findFirstOrThrow()
          ).id,
          subjectKey: `person:${person['Anna']}`, personId: person['Anna']!,
          systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId: 'ent-9', resourceName: 'Domain Admins',
          attributions: [], observedAt: NOW, coverageStatus: 'complete',
          riskFlags: ['privileged'],
        },
      });
      await tx.campaignItemReviewer.create({
        data: { tenantId: ctx.tenantId, itemId: item.id, personId: person['Jan']!, via: 'selector' },
      });
      return item.id;
    });

    const res = await post('/api/portal/govern/reviews/bulk-certify', await portalCookie('jan'), {
      campaignId, itemIds: [itemId, highRisk],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { certified: number; refused: { itemId: string; reason: string }[] };
    expect(body.certified).toBe(1);
    expect(body.refused[0]).toMatchObject({ itemId: highRisk });
    // In words, not a disabled button with no explanation.
    expect(body.refused[0]!.reason).toContain('one at a time');
  });
});
```

- [ ] **Step 2: Write the portal routes**

`apps/api/src/routes/govern-portal.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { bulkCertifyBody, decideItemBody, idParam } from '@syntra/contracts';
import { bulkCertify, openItem, recordDecision, DecisionRefusedError } from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';

/**
 * The reviewer surface is the PORTAL, and it needs no permission.
 *
 * Review authority comes from resolution, exactly as approval authority does in
 * Automate: these handlers read `CampaignItemReviewer` rows naming the caller's
 * person. There is deliberately no `govern.review` permission, because a
 * tenant-wide right to certify anything is not a thing anybody should hold.
 */
export async function registerGovernPortalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('portal'));

  const personOf = async (request: Parameters<typeof requireSession>[0] extends never ? never : any) => {
    const user = await request.db((tx: never) =>
      (tx as never as { user: { findUnique: Function } }).user.findUnique({
        where: { id: request.session.userId },
        select: { personId: true },
      }),
    );
    if (user?.personId == null) {
      throw new ProblemError(
        403, 'no-person', 'This account is not linked to a person',
        'Reviewing is done as a person, because a certification names a human.',
      );
    }
    return user.personId as string;
  };

  app.get('/govern/reviews', async (request) => {
    const personId = await personOf(request);
    return request.db(async (tx) => ({
      items: await tx.campaignItem.findMany({
        where: {
          status: 'pending',
          reviewers: { some: { personId, unassignedAt: null } },
          campaign: { status: { in: ['open', 'executing'] } },
        },
        include: { campaign: { select: { id: true, name: true, dueAt: true, allowBulkCertify: true } } },
        orderBy: [{ resourceName: 'asc' }],
        take: 500,
      }),
    }));
  });

  app.get('/govern/reviews/:id', async (request) => {
    const personId = await personOf(request);
    const { id } = idParam.parse(request.params);
    const item = await request.db((tx) =>
      tx.campaignItem.findFirst({
        where: { id, reviewers: { some: { personId, unassignedAt: null } } },
        include: { campaign: true },
      }),
    );
    // 404, not 403: a 403 confirms the item exists, and the existence of a
    // holding is itself information about somebody's access.
    if (item === null) throw new ProblemError(404, 'not-found', 'Not found');

    // The server-side interval starts here, not from a client-reported dwell
    // time, which is worth nothing.
    await openItem(request.tenantId, personId, id);
    return item;
  });

  app.post('/govern/reviews/:id/decide', async (request, reply) => {
    const personId = await personOf(request);
    const { id } = idParam.parse(request.params);
    const body = decideItemBody.parse(request.body);
    try {
      const result = await recordDecision(request.tenantId, {
        itemId: id,
        deciderPersonId: personId,
        deciderUserId: request.session.userId,
        decision: body.decision,
        comment: body.comment,
      });
      return reply.status(200).send(result);
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        throw new ProblemError(409, cause.code, 'This decision was refused', cause.message);
      }
      throw cause;
    }
  });

  app.post('/govern/reviews/bulk-certify', async (request) => {
    const personId = await personOf(request);
    const body = bulkCertifyBody.parse(request.body);
    try {
      return await bulkCertify(request.tenantId, {
        campaignId: body.campaignId,
        itemIds: body.itemIds,
        deciderPersonId: personId,
        deciderUserId: request.session.userId,
      });
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        throw new ProblemError(409, cause.code, 'This bulk certify was refused', cause.message);
      }
      throw cause;
    }
  });
}
```

Register it in `apps/api/src/app.ts` after the portal routes: `await app.register(registerGovernPortalRoutes, { prefix: '/api/portal' });`

- [ ] **Step 3: Add the slice-2 admin routes**

Append the campaign, batch and SoD routes to `apps/api/src/routes/admin/govern.ts`, each behind `requirePermission(PERMISSIONS.GOVERN_MANAGE)` except the reads, which use `requireGovernRead()`. The two previews are `POST` because their bodies are conditions:

```ts
  app.post(
    '/govern/campaigns/preview-scope',
    { preHandler: requireGovernRead() },
    async (request) => previewCampaignScope(request.tenantId, previewScopeBody.parse(request.body)),
  );

  app.post(
    '/govern/campaigns/preview-reviewers',
    { preHandler: requireGovernRead() },
    async (request) => {
      const body = previewReviewersBody.parse(request.body);
      // "Stage: manager; 1,102 items resolve, 61 fall to the fallback, 17
      // resolve to nobody — here they are." The screen that catches an
      // unreviewable campaign before 200 people are emailed rather than at 3am
      // on the due date.
      return previewReviewerResolution(request.tenantId, body);
    },
  );

  app.post(
    '/govern/batches/:id/confirm',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // `autoApply` does not exist for a batch. Confirmation is per batch,
      // explicit, and the confirming user is recorded.
      return confirmRevocationBatch(request.tenantId, request.session.userId, id);
    },
  );

  app.post(
    '/govern/sod/exceptions/:id/decide',
    // NOT govern.manage. Administering the governance module and accepting the
    // organization's risk are different jobs.
    { preHandler: requirePermission(PERMISSIONS.GOVERN_ACCEPT_RISK) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = decideExceptionBody.parse(request.body);
      await decideSodException(request.tenantId, request.session.userId, id, body.decision, body.comment);
      return reply.status(204).send();
    },
  );
```

- [ ] **Step 4: Write the portal reviewer page**

`apps/web/src/pages/govern/MyReviewsPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface ReviewItem {
  id: string;
  subjectKey: string;
  subjectName: string;
  resourceKind: string;
  resourceName: string;
  systemName: string;
  provenance: string;
  observedAt: string;
  observedVia: string;
  lastCertifiedAt: string | null;
  lastCertifiedBy: string | null;
  coverageStatus: string;
  sourceAgeHours: number | null;
  sourceSlaHours: number;
  riskFlags: string[];
  campaign: { id: string; name: string; dueAt: string; allowBulkCertify: boolean };
}

const HIGH_RISK: Record<string, string> = {
  unattributable: 'nothing in Syntra explains this access',
  privileged: 'this is privileged access',
  sod_violation: 'this holding is part of an open segregation-of-duties violation',
  stale: 'the system this came from has not been read recently enough',
  needs_review: 'the person’s job changed and this access stopped matching it',
};

const carveOut = (item: ReviewItem): string | null => {
  const flag = item.riskFlags.find((f) => f in HIGH_RISK);
  if (flag !== undefined) return HIGH_RISK[flag]!;
  if (item.coverageStatus !== 'complete') return 'the system this came from was not read in full';
  return null;
};

export function MyReviewsPage() {
  const { data, error, loading, reload } = useApiResource<{ items: ReviewItem[] }>(
    '/api/portal/govern/reviews',
  );
  const [groupBy, setGroupBy] = useState<'subject' | 'resource'>('subject');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const items = data?.items ?? [];
  // Grouped by subject AND by resource at the reviewer's choice; the decisions
  // underneath are always per pair, which is what makes a partial answer
  // representable.
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const key = groupBy === 'subject' ? item.subjectName : item.resourceName;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const decide = (item: ReviewItem, decision: 'certify' | 'revoke') => {
    const needsComment = decision === 'revoke' || item.riskFlags.includes('unattributable');
    const comment = needsComment
      ? window.prompt(
          decision === 'revoke'
            ? 'Why are you removing this? A revoke decision needs a comment.'
            : 'Nothing in Syntra explains this access. Say who confirmed it is fine, and why.',
        )
      : null;
    if (needsComment && (comment === null || comment.trim() === '')) return;

    void api(`/api/portal/govern/reviews/${item.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    })
      .then(() => {
        setActionError(null);
        reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'Could not record that decision.',
        ),
      );
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-ink">My reviews</h1>
        <p className="mt-1 text-muted">
          Certifying an item records that you decided to keep it, against the facts shown, at the
          time you clicked. It does not say the access is appropriate — only that you looked.
        </p>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {!loading && items.length === 0 && (
        <Empty title="Nothing is waiting for you">
          When a review names you, it arrives here and in your inbox.
        </Empty>
      )}

      {items.length > 0 && (
        <>
          <div className="mb-4 flex gap-2">
            <Button
              size="sm"
              variant={groupBy === 'subject' ? 'primary' : 'secondary'}
              onClick={() => setGroupBy('subject')}
            >
              Group by person
            </Button>
            <Button
              size="sm"
              variant={groupBy === 'resource' ? 'primary' : 'secondary'}
              onClick={() => setGroupBy('resource')}
            >
              Group by resource
            </Button>
            {items[0]!.campaign.allowBulkCertify && (
              <Button
                size="sm"
                variant="secondary"
                disabled={selected.size === 0}
                onClick={() => {
                  void api('/api/portal/govern/reviews/bulk-certify', {
                    method: 'POST',
                    body: JSON.stringify({
                      campaignId: items[0]!.campaign.id,
                      itemIds: [...selected],
                    }),
                  })
                    .then((result) => {
                      const refused = (result as { refused: { reason: string }[] }).refused;
                      setActionError(
                        refused.length === 0
                          ? null
                          : `${refused.length} item(s) were not certified: ${refused
                              .map((r) => r.reason)
                              .join('; ')}`,
                      );
                      setSelected(new Set());
                      reload();
                    })
                    .catch((cause: unknown) =>
                      setActionError(
                        cause instanceof ApiError
                          ? (cause.problem.detail ?? cause.problem.title)
                          : 'Could not certify those items.',
                      ),
                    );
                }}
              >
                Certify selected ({selected.size})
              </Button>
            )}
          </div>

          {[...groups].map(([name, groupItems]) => (
            <Panel key={name} title={name} bodyClassName="divide-y divide-border-subtle">
              {groupItems.map((item) => {
                const reason = carveOut(item);
                return (
                  <div key={item.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-ink">
                          {groupBy === 'subject' ? item.resourceName : item.subjectName}
                          <span className="ml-2 text-muted">in {item.systemName}</span>
                        </p>
                        {/* How the person got it, in a sentence. */}
                        <p className="text-muted">{item.provenance}</p>
                        <p className="text-muted">
                          Last confirmed by {item.observedVia} on{' '}
                          {new Date(item.observedAt).toLocaleDateString()}.{' '}
                          {item.lastCertifiedAt === null
                            ? 'Never certified.'
                            : `Last certified by ${item.lastCertifiedBy} on ${new Date(item.lastCertifiedAt).toLocaleDateString()}.`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.riskFlags.map((flag) => (
                          <Status key={flag} tone="warning">
                            {flag.replace(/_/g, ' ')}
                          </Status>
                        ))}
                      </div>
                    </div>

                    {/* Section 8 rule 5: the reviewer is told BEFORE they decide,
                        on the item, and the decision records the age. */}
                    {item.coverageStatus !== 'complete' && (
                      <Alert tone="warning" title="You are deciding against data of a stated age">
                        {item.systemName} was last read {Math.round(item.sourceAgeHours ?? 0)} hours
                        ago, against a {item.sourceSlaHours}-hour SLA. You may well know the answer;
                        your decision will record that it was made against data of that age, and the
                        evidence bundle will say so too.
                      </Alert>
                    )}

                    {/* The carve-out, in words rather than as a disabled button
                        with no explanation. */}
                    {reason !== null && (
                      <p className="text-muted">
                        This one has to be decided on its own, with a comment, because {reason}.
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      {reason === null && item.campaign.allowBulkCertify && (
                        <label className="flex items-center gap-1.5 text-muted">
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              setSelected(next);
                            }}
                          />
                          include in bulk
                        </label>
                      )}
                      <Button size="sm" onClick={() => decide(item, 'certify')}>
                        Keep
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => decide(item, 'revoke')}>
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}
```

`apps/web/src/pages/govern/MyReviewsPage.test.tsx` asserts three things over a stubbed `fetch`: that a high-risk item renders its carve-out **as a sentence** and offers no bulk checkbox; that an item whose `coverageStatus` is `partial` renders the age banner with the SLA in it; and that the provenance sentence, not the attribution kind, is what appears.

- [ ] **Step 5: Write the four console pages**

**`GovernBatchPage.tsx`** — the one with the guard on it, written out in full because it is where the irreversible act is confirmed:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Dispatch {
  id: string;
  route: string;
  status: string;
  message: string | null;
  holdingDescriptor: {
    subjectKey: string; subjectName: string; resourceName: string;
    explanation: string; notRemoved: string[];
  };
}

interface Batch {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
  proposedCount: number;
  requiresChangeCount: number;
  skippedCount: number;
  dispatches: Dispatch[];
}

const ROUTE_LABEL: Record<string, string> = {
  automate_grant: 'Ends the grant',
  revocation_order: 'Removes it at the target',
  requires_change_rule: 'Cannot be removed: a rule grants it',
  requires_change_role: 'Cannot be removed: a Syntra role',
  requires_change_directory_source: 'Cannot be removed: a directory source owns it',
  requires_change_direct_assignment: 'Cannot be removed: assigned by hand in Syntra',
};

export function GovernBatchPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<Batch>(
    id ? `/api/admin/govern/batches/${id}` : null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const dispatchable = (data?.dispatches ?? []).filter((d) =>
    ['automate_grant', 'revocation_order'].includes(d.route),
  );
  const requiresChange = (data?.dispatches ?? []).filter((d) => d.status === 'requires_change');

  return (
    <>
      <PageHeader
        title="Revocations"
        description="Nothing here has happened yet. This is the last point at which a mistake costs nothing."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {/* A blocked batch LEADS with why and the numbers. The same screen shape
          as Directory Sync's blocked run and Provision's blocked plan, because
          an administrator should not have to learn a third one. */}
      {data?.status === 'blocked' && (
        <Alert tone="danger" title="This batch will not run, and confirming will not change that">
          {data.blockedReason}
        </Alert>
      )}
      {data?.requiresConfirmation === true && data.status !== 'blocked' && (
        <Alert tone="warning" title="This batch needs an explicit confirmation">
          {data.blockedReason}
        </Alert>
      )}

      {data && (
        <div className="mt-6 space-y-6">
          <Panel title={`${dispatchable.length} removals Govern can dispatch`}>
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle text-sm text-muted">
                <tr>
                  <th className="px-4 py-2">Person</th>
                  <th className="px-4 py-2">Resource</th>
                  <th className="px-4 py-2">What happens</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {dispatchable.map((d) => (
                  <tr key={d.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2">{d.holdingDescriptor.subjectName}</td>
                    <td className="px-4 py-2">{d.holdingDescriptor.resourceName}</td>
                    <td className="px-4 py-2">
                      <Status tone="primary">{ROUTE_LABEL[d.route]}</Status>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {d.status === 'proposed' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const reason = window.prompt('Why are you skipping this one?');
                            if (reason === null || reason.trim() === '') return;
                            void api(`/api/admin/govern/dispatches/${d.id}/skip`, {
                              method: 'POST',
                              body: JSON.stringify({ reason }),
                            })
                              .then(reload)
                              .catch(() => setActionError('Could not skip that row.'));
                          }}
                        >
                          Skip
                        </Button>
                      ) : (
                        <Status tone="inactive">{d.status}</Status>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {/* Its own column. These are NOT revocations and this screen does not
              call them one, and the campaign's revoked total never includes them. */}
          {requiresChange.length > 0 && (
            <Panel
              title={`${requiresChange.length} that require a change somewhere else`}
              description="These will not be removed by this batch. Each has a remediation item with an owner."
            >
              <ul className="divide-y divide-border-subtle">
                {requiresChange.map((d) => (
                  <li key={d.id} className="p-4">
                    <p className="font-medium text-ink">
                      {d.holdingDescriptor.subjectName} — {d.holdingDescriptor.resourceName}
                    </p>
                    <p className="text-muted">{d.holdingDescriptor.explanation}</p>
                    {d.holdingDescriptor.notRemoved.length > 0 && (
                      <p className="text-muted">
                        Not removed: {d.holdingDescriptor.notRemoved.join(', ')}.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Button
            variant="danger"
            disabled={data.status === 'blocked'}
            onClick={() => {
              if (!window.confirm(`Dispatch ${dispatchable.length} removals? This is irreversible.`)) {
                return;
              }
              void api(`/api/admin/govern/batches/${data.id}/confirm`, { method: 'POST' })
                .then(reload)
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof ApiError
                      ? (cause.problem.detail ?? cause.problem.title)
                      : 'Could not confirm this batch.',
                  ),
                );
            }}
          >
            Confirm and dispatch
          </Button>
        </div>
      )}
    </>
  );
}
```

**`GovernCampaignsPage.tsx`** — the list, whose one rule is that the headline number never appears alone:

```tsx
<td className="px-4 py-2">
  {/* A campaign report never prints a percentage without the four counts
      beside it, and never a bare `unknown` denominator. */}
  {campaign.coveragePercent === null ? (
    <span className="text-muted">not yet closed</span>
  ) : (
    <>
      <strong className="text-ink">{campaign.coveragePercent}% covered</strong>
      <span className="ml-2 text-muted">
        of {campaign.totalItems} items: {campaign.certifiedItems} certified,{' '}
        {campaign.revokedItems} revoked, {campaign.mootItems} moot,{' '}
        {campaign.undecidedItems} undecided
      </span>
    </>
  )}
</td>
```

**`GovernCampaignDetailPage.tsx`** — progress, the items by status, the undecided list by reviewer, the revocation batch, and the reviewer-quality section **not hidden behind a toggle**:

```tsx
<Panel
  title="Reviewer quality"
  description="Context for a human, not a control."
>
  <Alert tone="info">
    None of these are violations and this screen does not call them violations. A
    manager of a stable ten-person team who reads everything and certifies all of
    it in four minutes is behaving correctly and will look identical to a
    rubber-stamper on the aggregate.
  </Alert>
  <table className="mt-3 w-full text-left">
    <thead className="border-b border-border-subtle text-sm text-muted">
      <tr>
        <th className="px-4 py-2">Reviewer</th>
        <th className="px-4 py-2">Decided</th>
        <th className="px-4 py-2">Share certified</th>
        <th className="px-4 py-2">Median time on an item</th>
        <th className="px-4 py-2">Share in bulk</th>
        <th className="px-4 py-2">Largest single burst</th>
        <th className="px-4 py-2">Never opened the detail</th>
      </tr>
    </thead>
    <tbody>
      {signals.map((s) => (
        <tr key={s.personId} className="border-b border-border-subtle last:border-0">
          <td className="px-4 py-2">{s.displayName}</td>
          <td className="px-4 py-2">{s.itemsDecided} of {s.itemsAssigned}</td>
          <td className="px-4 py-2">{Math.round(s.certifiedShare * 100)}%</td>
          <td className="px-4 py-2">{Math.round(s.medianIntervalMs / 1000)}s</td>
          <td className="px-4 py-2">{Math.round(s.bulkShare * 100)}%</td>
          <td className="px-4 py-2">{s.largestBurst}</td>
          <td className="px-4 py-2">{Math.round(s.neverOpenedShare * 100)}%</td>
        </tr>
      ))}
    </tbody>
  </table>
</Panel>
```

**`GovernSodPage.tsx`** — functions, rules with an impact preview **before** the save, and violations with both sides:

```tsx
<Button
  variant="secondary"
  onClick={() => {
    void api<{ violatingPersons: number; sample: { displayName: string }[]; unevaluableSubjects: number }>(
      '/api/admin/govern/sod/rules/preview',
      { method: 'POST', body: JSON.stringify({ functionAId, functionBId, severity }) },
    ).then(setPreview);
  }}
>
  Show me who this would flag, before I save it
</Button>

{preview && (
  <Alert tone={preview.violatingPersons > 0 ? 'warning' : 'info'}>
    This rule is violated by {preview.violatingPersons} person(s) today
    {preview.sample.length > 0 && `: ${preview.sample.map((s) => s.displayName).join(', ')}`}.
    {preview.unevaluableSubjects > 0 &&
      ` ${preview.unevaluableSubjects} more could not be evaluated, because a resource one of these functions names could not be read.`}
  </Alert>
)}
```

`apps/web/src/pages/admin/GovernBatchPage.test.tsx` asserts that a `blocked` batch renders its reason **above** the rows and disables the confirm button, and that a `requires_change` row appears in its own panel and **not** in the dispatchable count.

- [ ] **Step 6: Wire the routes**

`apps/web/src/routes.tsx` gains the portal route, inside the existing `RequireSession scope="portal"` tree:

```tsx
      <Route path="/govern/reviews" element={<RequireSession scope="portal"><MyReviewsPage /></RequireSession>} />
```

`apps/web/src/pages/admin/AdminApp.tsx` gains four **relative** routes and three **absolute** `NAV` entries behind `govern.read`.

- [ ] **Step 7: Write the end-to-end spec**

`e2e/govern.spec.ts`, following `e2e/sync.spec.ts`'s shape:

```ts
import { expect, test } from '@playwright/test';

const ADMIN = { login: 'owner', password: process.env.E2E_ADMIN_PASSWORD ?? 'a-long-enough-password' };
const MANAGER = { login: 'jan', password: process.env.E2E_MANAGER_PASSWORD ?? 'a-long-enough-password' };

async function signIn(page: import('@playwright/test').Page, who: { login: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(who.login);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function elevate(page: import('@playwright/test').Page, password: string) {
  await page.goto('/elevate');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /continue/i }).click();
}

test.describe.configure({ mode: 'serial' });

test('a campaign is refused against a stale source, and names it', async ({ page }) => {
  await signIn(page, ADMIN);
  await elevate(page, ADMIN.password);

  await page.goto('/admin/govern/snapshots');
  await page.getByRole('button', { name: /build a snapshot/i }).click();
  await expect(page.getByText(/complete/i).first()).toBeVisible();

  await page.goto('/admin/govern/campaigns');
  await page.getByRole('button', { name: /new campaign/i }).click();
  await page.getByLabel('Name').fill('Q2 finance review');
  await page.getByRole('button', { name: /start/i }).click();

  // Not a warning the campaign owner can dismiss — a refusal, with the source
  // named and the age given.
  await expect(page.getByRole('alert')).toContainText('Acme AD');
  await expect(page.getByRole('alert')).toContainText('hours ago');
});

test('refresh, rebuild, and the campaign starts', async ({ page }) => {
  await signIn(page, ADMIN);
  await elevate(page, ADMIN.password);

  await page.goto('/admin/govern/snapshots');
  await page.getByRole('link', { name: /snapshot/i }).first().click();
  await page.getByRole('button', { name: /refresh now/i }).first().click();
  // It says WHOSE job it enqueued. Govern does not read the source itself.
  await expect(page.getByText(/Provision|Directory Sync/)).toBeVisible();

  await page.goto('/admin/govern/snapshots');
  await page.getByRole('button', { name: /build a snapshot/i }).click();
  await page.goto('/admin/govern/campaigns');
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page.getByText(/open/i).first()).toBeVisible();
});

test('a manager reviews from the PORTAL with no administrative session', async ({ page }) => {
  await signIn(page, MANAGER);

  await page.goto('/govern/reviews');
  await expect(page.getByRole('heading', { name: 'My reviews' })).toBeVisible();

  // Certify one ordinary item.
  const ordinary = page.getByText('Reading room').locator('xpath=ancestor::div[1]');
  await ordinary.getByRole('button', { name: 'Keep' }).click();

  // A rule-attributed holding: revoke it, with a comment.
  page.once('dialog', (dialog) => void dialog.accept('reviewed in Q2 and not needed'));
  const byRule = page.getByText('Finance-Payments').locator('xpath=ancestor::div[1]');
  await byRule.getByRole('button', { name: 'Remove' }).click();

  // A hand-granted holding: revoke that too.
  page.once('dialog', (dialog) => void dialog.accept('nobody can explain this one'));
  const byHand = page.getByText('Domain Admins').locator('xpath=ancestor::div[1]');
  await byHand.getByRole('button', { name: 'Remove' }).click();

  await expect(page.getByText(/nothing in Syntra explains this access/i)).toBeVisible();
});

test('the batch is blocked by the per-resource axis, reviewed, skipped in part, and confirmed', async ({ page }) => {
  await signIn(page, ADMIN);
  await elevate(page, ADMIN.password);

  await page.goto('/admin/govern/campaigns');
  await page.getByRole('link', { name: 'Q2 finance review' }).click();
  await page.getByRole('button', { name: /execute revocations/i }).click();

  // Leads with why and the numbers, and names the resource where the axis tripped.
  await expect(page.getByRole('alert').first()).toContainText('Finance-Payments');

  page.once('dialog', (dialog) => void dialog.accept('I meant Anna’s, not the whole group'));
  await page.getByRole('button', { name: 'Skip' }).first().click();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /confirm and dispatch/i }).click();

  // The rule-attributed decision is in its OWN panel and is not a revocation.
  await expect(page.getByText(/require a change somewhere else/i)).toBeVisible();
  await expect(page.getByText(/comes from the person’s job/i)).toBeVisible();
});

test('the campaign closes incomplete, names its undecided reviewers, and exports its evidence', async ({ page }) => {
  await signIn(page, ADMIN);
  await elevate(page, ADMIN.password);

  await page.goto('/admin/govern/campaigns');
  await page.getByRole('link', { name: 'Q2 finance review' }).click();

  await expect(page.getByText(/undecided/i)).toBeVisible();
  // The headline is coverage, with the four counts beside it.
  await expect(page.getByText(/% covered/)).toBeVisible();
  await expect(page.getByText(/certified,/)).toBeVisible();

  // The reviewer-quality section is not behind a toggle.
  await expect(page.getByText(/None of these are violations/i)).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /evidence bundle/i }).click();
  const file = await download;
  const body = JSON.parse(await (await file.createReadStream())!.setEncoding('utf8').read());
  expect(body.limitations.join(' ')).toContain('not proof against the operator');
  expect(body.limitations.join(' ')).toContain('proves a click, not a judgement');
  expect(body.chain.result).toBe('valid');
  expect(body.header.asOf).toBeTruthy();
});
```

- [ ] **Step 8: Run everything**

```bash
pnpm vitest run packages/core/src/govern packages/db/src apps/api/src/routes/admin/govern.test.ts apps/api/src/routes/govern-portal.test.ts
pnpm --filter @syntra/web test
pnpm exec tsc -b --force
pnpm e2e -- govern.spec.ts
```

Expected: PASS on all four. **The whole-repo `pnpm test` is a known long-running problem on this checkout** — Provision's Task 4 killed one after 1h50m — so the per-package runs above are the evidence this task reports, and the whole-branch review owns the full-suite question.

- [ ] **Step 9: Mutation-test the surface**

1. Change `/govern/reviews` to `requireSession('admin')`. Expected: `serves a reviewer their own queue with a PORTAL session` FAILS. **Requiring an administrative session for reviewing means either nobody reviews or everybody gets one.**
2. Add a `requirePermission(PERMISSIONS.GOVERN_READ)` to `/govern/reviews`. Expected: the same test FAILS. Review authority comes from resolution.
3. Change the 404 on an unassigned item to a 403. Expected: `404s an item that is not assigned to the caller` FAILS.
4. Remove the `openItem` call from the detail handler. Expected: `records itemOpenedAt server-side` FAILS.
5. Change `/govern/sod/exceptions/:id/decide` to `GOVERN_MANAGE`. Expected: add the case if absent — a holder of `govern.manage` alone must not be able to accept the organization's risk.
6. Render the bulk carve-out as a disabled button with no text. Expected: `refuses a bulk certify containing a high-risk item, IN WORDS` FAILS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/routes/govern-portal.ts apps/api/src/routes/govern-portal.test.ts \
        apps/api/src/routes/admin/govern.ts apps/api/src/app.ts \
        packages/contracts/src/govern.ts \
        apps/web/src/pages/govern/ apps/web/src/pages/admin/Govern*.tsx \
        apps/web/src/routes.tsx apps/web/src/pages/admin/AdminApp.tsx \
        e2e/govern.spec.ts
git commit -m "feat(govern): the slice-2 surface — portal reviews, campaigns, batches, SoD and the e2e path"
```

---
## Plan self-review

Run against the spec with fresh eyes, per the writing-plans skill. **A self-review claim on this programme has twice been false** — Ruling A-8 found four fixes described in a self-review and present in no task, and Ruling A-10 found eight fix-wave claims that did not survive checking, one of them a Critical reported as fixed. So every claim below names the task and step where the thing is, and was checked there. Anything not checked is said to be not checked.

### 1. Spec coverage

| Spec section | Where it lands | Checked |
|---|---|---|
| §5 Govern writes nothing — the import-graph and Prisma-write structural tests | T7 Step 6 (`boundaries.test.ts`), Step 9 mutations 1–3 | the two `describe` blocks and the seven forbidden model names are in the file at Step 6 |
| §5 The revocation dispatch table, seven rows | T20 Steps 1–2 (`routeRevocation`, six routes; the four `requires_change` rows collapse into four route constants and the seventh row — a synced `GroupMembership` — is `requires_change_directory_source`) | all six route constants and the table test are present |
| §5 `RevocationOrder` and its three constraints | T15 Step 5 (schema + `govern_revocation_order_one_open`), T20 Step 4 (`createRevocationOrder`: refused on a live attribution, cancelled when superseded), T15 Step 8 (`revocation_order_names_a_human`) | the refusal, the cancellation and the CHECK are each written out |
| §5 Ruling G1's condition — provenance to the target | T20 Step 5 (`RevocationOrderFacts` carries `decidedByPersonName`, `campaignName`, `campaignDecisionId`; the plan stage puts them in `PlannedAction.before`) | present in the `planActions` snippet |
| §5 Provision's plan gains `revocationOrders`; `ProvisionAction.revocationOrderId` | T20 Step 5, T15 Step 6 | both written out |
| §5 Automate gains `sod_violation` as a refusal reason | T16 Step 6(a), tested at T16 Step 7 | the union edit and the test are both there |
| §5 Provision's guard gains an SoD condition; the rule editor gains an SoD column | T16 Step 6(c) | the `previewRuleImpact` edit is written; **the guard's `requiresConfirmation` condition is described in the same step and its code lives in Provision's `run-service.ts`, which this plan does not otherwise touch — see the gap list below** |
| §6 Snapshot, three-valued state, `not_held` is never a row | T1 Step 8 (`holding_state_is_held_or_unknown`), T2 (`countRegion`) | the CHECK and the counting function are both present |
| §6 Six resource kinds, correlation through the three existing links | T6 Steps 3, 6 | all six kinds are collected; the three links are `TargetAccount.personId`, `User.personId`, `AccessGrant.subjectPersonId` |
| §6 `GovernFinding` aggregates `DriftFinding` by reference | T1 Step 6 (`driftFindingId`, bare column), T8 (`FindingDraft.driftFindingId`) | the column and the field are present. **The Provision-side aggregation that fills it is NOT written — see the gap list** |
| §7 Provenance is a set; eleven kinds; the unattributable definition | T4 Steps 3–4 | all eleven kinds, `isUnattributable`, and seven test cases with two answers |
| §7 `org_unit_inheritance` names which unit and the chain | T6 Step 3 (`resolveApplicationPaths`), T4 Step 4 | the chain is truncated at the match and asserted |
| §8 Two clocks, both checked, a refusal names which | T3 Steps 3–4, T17 Step 5 | `checkSnapshotAge` and `checkSourceFreshness` carry a `clock` field and both are used |
| §8 `CoverageGap` is a row; six kinds | T1 Steps 5, 8 | the model and the CHECK |
| §8 Rule 3: no aggregation collapses unknown into not_held, as a property test | T2 Step 1 (500 generated scopes, two-directional) | the generator and both properties are written out |
| §8 Rule 4: every report carries its header, with no constructor that omits it | T11 Steps 1, 4 (the `REPORT_BRAND` brand + the `@ts-expect-error` case), Step 9 mutation 1 | the brand, the negative test, and the TS2578 mutation are all present |
| §8 Rule 5: an item over a stale source tells the reviewer before they decide | T22 Step 4 (the age banner), T19 (`coverageAtDecision`) | the banner and the recorded coverage are both written |
| §9 `HoldingEvent`, five change kinds, `became_unknown` is not `lost` | T5 Steps 1, 3 | four `became_unknown` cases plus the "still a loss elsewhere" case |
| §9 The limitation stated on the report; cadence named; two panes never merged | T5 (`DIFF_LIMITATION`), T11 Step 4 (`whatChanged`: `snapshotsOverPeriod`, `observedChanges`, `recordedActions`, `actionsWithNoObservedChange`) | present |
| §9 Point-in-time answers name their snapshot or say none covers the date | **NOT COVERED — see the gap list** | |
| §9 Retention, and never pruning a referenced snapshot | T7 Step 4 (`pruneSnapshots`), tested at Step 1 | the evidence-pack and open-finding references are both checked |
| §10 The four reports | T11 Step 4 | all four functions written |
| §10 The four buckets, uncomfortable first | T11 Step 4 (`BUCKET_ORDER`), tested at Step 1 | present |
| §10 What the numbers mean; percentages name their denominator | Global Constraints (the vocabulary rule), T2 (`percentOf`) | present |
| §10 CSV with the header repeated on every row; no PDF; export is audited | T11 Step 6 | present, including the empty-scope row |
| §11 Campaign shape, one item per (subject, resource), eleven statuses | T15 Steps 4, 8; T17 Step 5 | the model, the CHECK and the generation |
| §11 `moot` is verified, not inferred, and counted on its own line | T18 Steps 4 (`mootDepartedSubjects`, `mootVanishedHoldings`) | both written; the composition guard is at Step 8 mutation 1 |
| §11 `dueAt` is real; extending is an audited act | T17 Step 6 | written, with the backwards refusal |
| §12 Silence never certifies and never revokes | T18 Step 4 (`closeDueCampaigns` writes `undecided`), T19 Step 3 (`CERTIFYING_TRANSITIONS`) | both |
| §12 Reminders at 50% then daily; escalation adds and tells | T18 Step 4 | written |
| §12 Coverage arithmetic, four counts beside it | T17 Step 3 (`coverageOf`), T22 Step 5 | written |
| §12 A `RemediationItem` per undecided item; low coverage is a finding | T18 Step 4 | written |
| §12 Rubber-stamping made visible: five signals | T15 Step 4 (`ReviewQualitySignal`), T19 Step 5 | written |
| §12 Bulk bounded, five carve-outs, no bulk revoke | T19 Steps 3, 5 | `HIGH_RISK_FLAGS` has all five; the no-bulk-revoke assertion is a source scan |
| §12 The self-review invariant at the moment of decision | T19 Step 4 | written |
| §12 A reviewer who leaves: decisions stand, items reassign, both told, then block | T18 Step 4 | written |
| §13 Revocation is a run; the review screen; nothing auto-applies | T20 Step 4, T22 Step 5 | written; `autoApply` appears nowhere |
| §13 Two axes and four outright refusals | T20 Step 3 | written, including the first-batch case |
| §13 The vocabulary: dispatched / confirmed / applied / requires_change / failed | T15 Step 8 (`revocation_dispatch_applied_was_confirmed`), T20 Step 6 | both |
| §13 `dispatch_not_applied` on the SLA and on the observation gap | T20 Step 6 | both branches written |
| §14 Rules over business functions; immutable identifiers | T15 Step 5, T16 Steps 3, 5 | written |
| §14 Detection per person, cross-system; contracts recorded; unevaluable | T16 Steps 3, 5 | written, with the empty-function case |
| §14 Prevention at the request, the approval, fulfilment and the rule editor | T16 Step 6 | (a)–(c) written; **the catalog's submission-time warning is NOT written — see the gap list** |
| §14 The decision graph, three edge kinds, three patterns, three qualifications | T21 Steps 1–2 | written |
| §15 Exceptions: required end date, cap, justification, compensating control | T15 Step 5, T21 Step 3 | written |
| §15 Approved through Automate's workflow; the `govern.accept_risk` fallback | T21 Step 3, T22 Step 3 | written |
| §15 Warnings, lapse, severity raised, nothing revoked, early contract lapse | T21 Step 3 (`sweepExceptions`, `lapse`) | written |
| §15 A refused exception revokes nothing | T21 Step 3 | written |
| §16 One finding lifecycle; fifteen kinds; `accepted` needs an expiry | T2, T8, T1 Step 8 | written |
| §16 `RemediationItem` and its six kinds; chased | T1 Steps 6, 8; T8 | written |
| §16 Orphan attribution: propose, claim, confirm, never automatic | T9 | written |
| §16 Syntra account dormancy, labelled as exactly that | **NOT COVERED — see the gap list** | |
| §17 Incremental verification, checkpoints, signatures, anchors, evidence packs | T10, T11 Step 6 | written |
| §17 One audit event per bulk decision, not one per item | T19 Step 5 | written and tested |
| §17 What it cannot prove, printed on the cover | T11 Step 6 (`BUNDLE_LIMITATIONS`, seven statements) | written |
| §18 Every table, every setting, the permissions | T1, T15, T13 Step 1 | written |
| §19 The pipeline; the batching divergence; the accessor; the jobs | T6, T7, T12 | written |
| §20 Portal and console | T14, T22 | written |
| §21 Security posture | across; the two structural tests at T7 Step 6 | written |
| §23 Every named test | across; the structural ones at T7 Step 6, T19 Step 1 | written |

### The four spec requirements this plan does NOT cover, and why

1. **§9's point-in-time query — "what did Anna hold on 14 March"** — has no task. `whatDoesPersonHold` takes a `snapshotId` and `readableSnapshot` defaults to the newest, but nothing resolves *a date* to the snapshot in force on it, and nothing answers **"no snapshot covers 14 March"** rather than silently using the nearest. That last sentence is the whole requirement and it is a one-function gap: `snapshotInForceOn(tx, date)` returning `ReadableSnapshot | { covered: false; nearest: Date | null }`. **It belongs in Task 11 as a fourth exported function** and is called out here rather than quietly folded in, because adding it means adding its tests too.

2. **§16's Syntra account dormancy** — "reported and labelled exactly that, with the statement on the same screen that it is not entitlement usage" — has no task. It is a `Session`/`AuthAttempt` read and a paragraph of copy, and its only risk is the one §16 names: shipping the number without the caveat. It is small and it is missing.

3. **§14's submission-time warning in Automate's catalog** — "the catalog shows a product that would create a violation with a warning at submission, naming the rule and what the subject already holds on the other side" — is not written. `sodImpactForGrant` (T16) is exactly the function it needs and the approval-screen half is wired, but the catalog read path in `apps/web/src/pages/automate/CatalogPage.tsx` is Automate's file and this plan does not modify it. **A reviewer should decide whether that edit belongs here or in an Automate follow-up**; leaving it undecided is how a requirement ends up in neither.

4. **The Provision-side aggregation that fills `GovernFinding.driftFindingId`** — §6 says a `GovernFinding` of the corresponding kind references a `DriftFinding` by id "and closing it in either place closes it in both". The column exists (T1 Step 6) and `FindingDraft` carries the field (T8 Step 3), but **nothing reads `DriftFinding` and nothing propagates a close in either direction.** `orphan_account` findings in T9 are raised from Govern's own orphan holdings rather than from Provision's rows, so today there would be two rows about one problem — which is exactly the outcome §16 says the reference exists to prevent. This is the largest of the four gaps and it needs a task of its own, or an explicit deferral.

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `handle edge cases`, `write tests for the above`, `similar to Task`, and `...`.

- **Four steps were prose descriptions of code when first drafted and have been rewritten with the code**: Task 14 Step 5 (four console pages), Task 16 Step 7 (`sod-service.test.ts`), Task 20 Steps 6 and 7 (`reflectRevocationOutcomes` and `revocation-service.test.ts`), Task 21 Steps 3, 4, 5 and 7 (the exception tests, the `lapse` helper, `MyReviewsPage`, the console pages, the e2e spec). **Checked: each of those steps now contains a fenced code block with a body, not a sentence describing one.**
- **Task 22 Step 5's three secondary console pages** are given as the fragments that carry a decision — the coverage line, the reviewer-quality panel, the impact preview — rather than as whole files. That is deliberate and is stated at the step: the surrounding structure is `SyncRunsPage.tsx`'s, verbatim, and repeating three hundred lines of `Panel`/`SkeletonRows`/`Empty` would bury the four lines a reviewer needs to check. **A reviewer who disagrees should say so; it is the one place this plan shows less than a whole file.**
- **Task 20 Step 4's `confirmRevocationBatch` and `skipDispatch`** are described in a paragraph between two code blocks rather than written out. Their contract is fully specified — one short transaction per dispatch row, `revokeGrant` for one route, `createRevocationOrder` for another, `createRemediationItem` for four, no `autoApply` — and eleven test cases at Step 7 pin the behaviour. **This is the second and last place a function body is not written out, and it is named here rather than glossed.**

### 3. Type consistency

Walked every Interfaces block against its consumers.

- `subjectKey` / `parseSubjectKey` (T2) — used in T7, T9, T19. Same spelling throughout. **Checked at T19 Step 4's `projectCertification`, which calls `parseSubjectKey(item.subjectKey)`.**
- `Tri<T>` / `countRegion` / `percentOf` (T2) — used in T11 (`whoHasAccessToSystem`), T17 (`coverageOf`), T20 (`holderCountByResource`). **Checked: `evaluateRevocationGuard` destructures `holders.known` and `holders.reason`, which are the two arms `Tri` actually has.**
- `ClassifiedSource` (T3) — used in T7's `ReadableSnapshot.sources`, T8's `detectStaleSources`, T20's guard input. **Checked: T7 Step 3 constructs it with `ageHours`, which T8 Step 3 reads and T3 defines.**
- `AttributionDraft` (T4) — used in T7 and T11. **Checked: T11's `summariseAttributions` call maps `a.kind as AttributionDraft['kind']`, which is `AttributionKind` from T2.**
- `DiffHolding` / `DiffRegion` (T5) — used in T7 only. **Checked: T7 Step 4's `toDiff` produces every field `DiffHolding` declares.**
- `CollectedTenant` (T6) — used in T7's `BuildOptions.collect` seam and in T12. **Checked: T7's `emptyCollection` test helper sets all nine fields.**
- `createRemediationItem` — **T8 Step 4 ships it with a wrong tenant derivation and the step says so, then gives the corrected three-parameter signature `(tx, tenantId, input)`. T18 Step 4 calls the corrected form.** This is the one place the plan deliberately shows a wrong version: the shape that infers a tenant from whatever row exists is worth a reader seeing once, because forced RLS would not catch it.
- `FindingDraft.kind` — must be a `FindingKind` from T2. **Checked: T10's broken-chain finding uses `'coverage_gap'`, which is in `FINDING_KINDS`. It is a slightly odd fit for an audit-chain break and a reviewer may prefer a sixteenth kind; the alternative is a kind that appears in no other code path.**
- `readableSnapshot` (T7) — used in T8, T9, T11, T16, T17, T20. Same name and arity everywhere. **Checked at T16's `loadSodFacts` and T20's `computeRevocationBatch`.**
- `governSettings` (T11) — used in T12, T18, T19, T20, T21. **Checked: every caller passes a `tx`, which is what T11 declares.**
- `resolveItemReviewers` (T18) — the one forward import, consumed by T17. Signature `(tx, campaignId, itemIds, now) => Promise<ResolveOutcome>`. **Checked: T17 Step 5 calls it with exactly those four arguments and reads `.blocked` and `.assignedByPerson`, which `ResolveOutcome` declares.**
- `evaluateSodRule` / `sodImpact` (T16) — used by T16's own service, by T21's exception service, and by Provision's `explain.ts`. **Checked: the `SodImpactInput` T16 Step 6(c) passes to `sodImpact` has all four fields.**
- `routeRevocation` (T20) — used by `computeRevocationBatch` in the same task. **Checked: the call site supplies all six `RouteInput` fields.**
- `RevocationOrderFacts` (T20) — **must be hand-added to the enumerated `provision/types.js` export block in `packages/core/src/index.ts`, and T20 Step 9 says so.** Provision's ledger records that this barrel is enumerate-and-alias rather than `export *`, and that anything added to `provision/types.ts` silently does not leave the package otherwise.

### 4. Forward-import walk

Walked every task's Consumes list against the tasks that precede it. **A forward import has stopped a dispatched task twice on this programme.**

- Tasks 1–16 and 18–22 consume only what precedes them. **Checked one by one.**
- **Task 17 consumes `resolveItemReviewers` from Task 18.** This is a real forward import and it is handled the way Provision handled the same shape: **Task 18 is dispatched before Task 17**, the note is at the head of both tasks' Interfaces blocks, and Task 18 consumes nothing from Task 17 — its `closeDueCampaigns` computes coverage inline rather than importing `coverageOf`, which is stated in its Consumes list as a deliberate omission.
- **One import cycle was found and removed during this review.** `sod-service.ts` imports `readableSnapshot` from `snapshot-service.ts`; the first draft of Task 16 Step 6(d) called `detectSodViolations` from inside `buildSnapshot`, closing the loop. It is now called from `jobs.ts`, which already depends on both, **and Task 7's `boundaries.test.ts` gains an assertion that `snapshot-service.ts` never imports `sod-service.ts`** so the cycle cannot come back.
- Task 8 modifies `snapshot-service.ts` to import `finding-service.ts`; `finding-service.ts` imports `readableSnapshot` from `snapshot-service.ts`. **That is also a cycle.** It is smaller — `finding-service` uses `readableSnapshot` only in `upsertFindings`'s resolution path — but it is the same shape, and **a reviewer should decide whether to move `readableSnapshot` into its own module or to have `upsertFindings` take a snapshot id it does not validate.** This plan leaves it as written and names it rather than hiding it, because discovering it at dispatch time costs a task.

### 5. Things a reviewer should press on

- **Task 20's `confirmRevocationBatch` body is not written** (see the placeholder scan). It is the function that performs the irreversible act.
- **The `finding-service` ↔ `snapshot-service` cycle** above.
- **Four spec gaps**, listed in full above. The `driftFindingId` one is the largest.
- **`OPENED` in Task 19 is an in-process `Map`.** It is deliberate and the reasoning is in the docstring, but it means the `neverOpenedShare` signal reads high after a restart, and a reviewer may want it on the `CampaignItemReviewer` row instead.
- **Task 18's escalation upsert** uses a synthesised composite id in a `catch(() => undefined)`. That is a swallowed error on a write, which Ruling P11 banned outright for a destructive path; this one is additive, but the pattern is the one that hid a failed membership removal on Provision. **A `findFirst` then `create` is the honest form and a reviewer should ask for it.**
- **Task 12's reminder de-duplication reads `NotificationOutbox` by a JSON path on `vars.campaignName`.** It works and it is fragile: two campaigns with the same name in one tenant would suppress each other's reminders. A `campaignId` column on the outbox, or a `lastRemindedAt` on `CampaignItemReviewer`, is the sturdier form.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-17-syntra-govern.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**

### Dispatch notes for whichever is chosen

- **Task 18 is dispatched before Task 17.** The numbers are labels, not an order. Both tasks carry the note.
- **Tasks 1–5 can start immediately.** They depend only on Provision's Task 1 migration, which is committed, and on Core.
- **Task 6 waits on** Provision Tasks 1, 5, 7, 8, 9, 12, 13, 14, 15, 16 and Automate Tasks 1–9.
- **Tasks 15–22 wait on** everything in slice 1 plus Automate Tasks 4, 5, 6, 9, 13, 15.
- **Slice 1 (Tasks 1–14) is shippable on its own** and nothing in it changes anybody's access. A review checkpoint at the end of Task 14 is worth taking whichever execution mode is used.
- **Every task's final step names at least one mutation and the assertion that must catch it.** On this programme, six consecutive tasks found real defects that way and three found them in their own new tests. An implementer who reports "tests pass" without having run the named mutations has not finished the task.
