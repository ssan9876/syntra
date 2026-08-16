# Syntra Automate — Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every person a catalog of things they may ask for, route each request through an ordered approval chain whose approvers are resolved from a closed selector set, and turn an approval into an `AccessGrant` that enters Provision's desired state — with an end date, a decision record, a guarded expiry sweep, and no second writer to any target system.

**Architecture:** Four pure cores — the audience evaluator, the form and duration arithmetic, the sweep classifier and the sweep guard — sit under six short-transaction services: submission, decision, fulfilment, reflection, the sweep and delegated administration. Automate performs **no network I/O of its own**: fulfilment either writes an `AppAssignment`/`GroupMembership` row (tables with no other writer) or writes an `AccessGrant` that becomes a term in Provision's `desiredState` and lets Provision's existing plan, guard, retry and audit machinery do the writing. Every message is rendered into a `NotificationOutbox` row inside the transaction and sent by a job afterwards.

**Tech Stack:** TypeScript 5.7, Node 22+, Fastify 5, Prisma 6, PostgreSQL 16, Vitest 3, React 19, Tailwind 4, `zod@^3.24.0`, pg-boss 12, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-syntra-automate-design.md` — the binding authority, all 21 sections. Rulings that bind this plan: `.superpowers/sdd/provision-rulings.md` (P2, P5, P7) and `.superpowers/sdd/provision-preflight-rulings.md` (P8, P10, P11, P14, P15, P16). The hard dependency: `docs/superpowers/plans/2026-08-16-syntra-provision.md` — every Provision symbol named here comes from that plan's Interfaces blocks.

---

## Global Constraints

Everything in the Core, Directory Sync, Access and Provision plans' Global Constraints still applies. These are the ones that bite in this slice, plus the ones this slice adds. Every task's requirements implicitly include this section.

1. **Automate never writes to a target system.** It has no connector, no target credential, no write path and no retry loop against anything remote. A `targetEntitlement` product is fulfilled by writing an `AccessGrant` that enters `desiredState` and enqueuing a Provision run. There is no code path in this slice that opens a socket to a directory. (Spec §5, §16, §18.)

2. **No network I/O, no LDAP call, no Argon2, no signing and no SMTP send inside a Prisma interactive transaction.** `withTenant` is `prisma.$transaction(fn)` and `packages/db/src/client.ts` constructs the client with no `transactionOptions`, so Prisma's **5000 ms** default applies. This has produced a Critical finding four times on this programme. Automate sends more mail than every other subsystem combined, which is why nothing in this slice calls `sendMessage` or `queueMessage` from a request path at all: the transaction writes a `NotificationOutbox` row and `runOutboxJob` sends it afterwards. Task 16 makes this a test rather than a convention.

3. **Every tenant-scoped table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`** and a `tenant_isolation` policy whose USING **and** WITH CHECK are `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. The `NULLIF` is not optional: `set_config(..., true)` reverts the GUC to the **empty string, not NULL**, at transaction end, and `''::uuid` raises. Copy the `DO $$` block from `packages/db/prisma/migrations/20260820000000_provision_targets/migration.sql`.

4. **Every database access runs inside `withTenant`, including test fixtures and assertions.** The app connects as `syntra_app`, which is NOSUPERUSER NOBYPASSRLS deliberately. A bare `prisma.accessRequest.findMany()` outside `withTenant` returns `[]` under forced RLS **whether or not the code works**. Every test in this plan that asserts on database state reads through `withTenant`. The only exceptions are `prisma.tenant.*` (Tenant is outside RLS by design) and `asDatabaseSuperuser` in tamper tests.

5. **Unique constraints do not constrain NULLs in PostgreSQL.** Any uniqueness rule over a nullable column, or any rule qualified by a status, needs a hand-written partial unique index appended to the generated migration — never `@@unique`. This slice has two. **Inspect the generated migration before appending:** `prisma migrate diff` compares the schema file against a shadow database, `schema.prisma` cannot express a partial index, so every partial index the previous slices created by hand looks to the diff like something the database has that the model does not, and it will emit `DROP INDEX` for them. Delete any such line before going further.

6. **Migration directory names must sort after every migration they depend on.** As of 2026-08-16 the newest existing migration is `20260820000000_provision_targets`, so this plan takes `20260821000000`. **Re-read `packages/db/prisma/migrations/` before creating the directory** and bump the date again if anything newer has landed — Provision is in build in this same checkout and a timestamp collision was caught once already on this programme (Ruling P7). This plan adds exactly one migration, named `20260821000000_automate_requests`. A name that sorts early passes the entire suite and breaks every fresh install, because `resetDatabase()` truncates rather than re-migrating.

7. **Vitest does not type-check.** `pnpm vitest run` will happily execute a file full of type errors. **Every task's verification runs `pnpm typecheck` as its own step**, separately from the tests, or type errors ship invisibly.

8. **pg-boss schedules need a distinct `key` per tenant and per purpose.** `Scheduler.schedule(name, cron, data, key)` in `packages/core/src/jobs/scheduler.ts` defaults `key` to `''`, and pg-boss keys its schedule table on `(queue, key)`. All directory sources once shared `key: ''` and only the last one in the last tenant ever ran. `automateScheduleKey(tenantId, purpose)` is mandatory on every `schedule` and `unschedule` call this slice makes, and this slice has three purposes on three queues.

9. **A fake reproduces the real system's identifier semantics** (Ruling P8). Where the real system returns an opaque identifier, the fake returns something equally opaque; where it returns a DN, the fake returns a DN. A fake written from the consumer's side of the interface is not a test double, it is a second implementation of the bug. This slice's integration tests reuse `FakeTarget` from `@syntra/connectors` unchanged rather than introducing a second fake target.

10. **Approval authority comes from resolution, never from a permission.** There is no `automate.approve`. `automate.read` and `automate.manage` administer Automate; they do not confer the right to decide anything, and requesting for yourself needs no permission at all. (Spec §15, §19.)

11. **Catalog visibility fails closed.** A `Product` with a null `audienceCondition` is visible to **nobody**. `{ all: [] }` is how a tenant says "everybody with an active contract", and it is a deliberate keystroke. A product the caller's audience does not admit answers **404, never 403** — a 403 confirms the thing exists, and the existence of a product name is itself information about the organization. Every read path calls `visibleProducts` or `findVisibleProduct`; there is no second query. (Spec §6.)

12. **No person may record a decision on a request in which they are the subject or the submitter.** Enforced in the domain service, at the moment of decision as well as at resolution, and as a single subtraction from the resolved set so every selector inherits it. Never in the console — router-level gating in React is cosmetic. (Spec §9.)

13. **There is no timeout that approves.** Not configurable, not per product, not for low-risk items. `onTimeout` is `remind` (default), `escalate` or `expire`. Task 11 carries a structural test over the request state machine asserting that no transition into `approved` exists that is not caused by an `ApprovalDecision` row, so adding a timeout-approval later fails a test rather than passing review.

14. **A delegation adds an approver; it never replaces one.** Depth 1, end date required, capped at `maxDelegationDays`. Replacement is the cleanest self-approval path anybody would find in this system and it is refused structurally, not by policy. (Spec §8, §9.)

15. **`ApprovalDecision` is append-only.** A reversal is a new row. Enforced with the same PostgreSQL `RULE ... DO INSTEAD NOTHING` pair the audit log uses in `20260814235217_audit/migration.sql`, and the migration test proves an `UPDATE` changes nothing.

16. **A person Automate cannot understand produces *no actions*, not empty desired state.** A person with **no contracts at all** is an incomplete record, not a departure: nothing lapses, and they appear on the sweep as a `SweepException` by name. This is the distinction Directory Sync got wrong once and Provision built its exception model around; the failure shape is identical here. (Spec §12, Ruling P10.)

17. **Every privileged act writes its audit event in the same transaction as the act.** Every decision, delegation, product change, workflow change, grant, revocation, sweep confirmation and threshold change. An approval is the archetypal case: somebody will need to reconstruct, a year later, who allowed this and on what basis.

18. **`exactOptionalPropertyTypes` is on.** `{ foo: undefined }` does not satisfy `{ foo?: string }`. Spread conditionally: `...(x === undefined ? {} : { foo: x })`.

19. **Tests run in a single fork against one PostgreSQL** (`vitest.config.ts`, `poolOptions.forks.singleFork`), and `resetDatabase()` truncates between tests. Never assume parallel isolation.

20. **Commits:** conventional commits, one per task. **Tests:** TDD — a failing test precedes the code that satisfies it.

### Defaults, copied verbatim from the spec

These are the numbers spec §15 fixes on `AutomateSettings`, one row per tenant. Do not invent others.

| Setting | Default | Spec |
|---|---|---|
| `sweepSchedule` | `0 2 * * *` (cron; nightly) | §11 |
| `sweepThresholdPercent` | 10 | §11 |
| `perProductSweepThresholdPercent` | 50 | §11 |
| `personPopulationDropPercent` | 20 | §11 |
| `fulfilmentSlaHours` | 24 | §5 |
| `expiryWarningDays` | `[7, 1]` | §12 |
| `preHireHorizonDays` | 14 | §12 |
| `maxDelegationDays` | 90 | §8 |
| `maxApprovers` | 10 | §8 |
| `delegatedBulkLimit` | 25 | §14 |
| `lastAppliedSweepAt` | null | §11 |
| `personsWithActiveContractAtLastSweep` | null | §11 |
| `MAX_MANAGER_DEPTH` | 16 — **a code constant, deliberately NOT a setting** | §8 |
| stage `quorum` | `any` | §8 |
| stage `onTimeout` | `remind` | §8 |
| `Product.audienceCondition` | null, meaning **nobody** | §6 |
| `Product.status` | `draft` | §6 |
| `Entitlement.requestable` | false | §15 |
| grace on a leaver's requested access | **none, on the day** | §12 |

`MAX_MANAGER_DEPTH` is not on `AutomateSettings` on purpose: it is a cycle-termination constant, not a policy, and a tenant that could raise it could hang its own approvals.

---

## The hard dependency, stated once

Provision — Targets is being built from `docs/superpowers/plans/2026-08-16-syntra-provision.md`. **Tasks 8, 9, 12 and 14 of this plan modify files that plan creates**, and Task 8 modifies six of them. Every Provision symbol this plan names is taken from that plan's Interfaces blocks:

| Symbol | Where Provision defines it |
|---|---|
| `type Condition`, `type ConditionOperator`, `type ConditionFacts`, `evaluateCondition`, `conditionSchema` | Task 5, `packages/core/src/provision/condition.ts` |
| `type ContractFacts`, `type PersonFacts`, `type Attribution`, `type DesiredState`, `type DesiredStateInput`, `type KnownHolding`, `type ActualState` | Tasks 7 and 8, `packages/core/src/provision/types.ts` |
| `desiredState`, `activeOn`, `latestContractEnd`, `resolveMappingContract`, `personDisplayName` | Task 7, `packages/core/src/provision/desired.ts` |
| `type PlannedAction`, `planActions`, `addDays` | Task 9, `packages/core/src/provision/plan.ts` |
| `remitFor`, `refreshEntitlements` | Task 12, `packages/core/src/provision/entitlement-service.ts` |
| `previewProvisionRun`, `ProvisionRunInFlightError` | Task 13, `packages/core/src/provision/run-service.ts` |
| `applyProvisionRun` | Task 14, `packages/core/src/provision/apply.ts` |
| `PROVISION_JOB`, `provisionJobPayload` | Task 16, `packages/core/src/provision/jobs.ts` |
| `explainPersonAccess`, `type PersonAccess` | Task 17, `packages/core/src/provision/explain.ts` |
| `FakeTarget` | Task 2, `packages/connectors/src/testing/fake-target.ts` |

**Do not start Task 8 until Provision's Tasks 5, 7, 8, 9, 12, 13, 14 and 17 have landed.** Tasks 1–7 of this plan depend only on Provision Task 5 (`condition.ts`) and on Core, and Task 1 depends on Provision Task 1, which is already committed as `20260820000000_provision_targets`.

### Three divergences from the spec, decided here rather than discovered mid-task

1. **`DesiredState.attribution` is not widened into a tagged union.** Spec §5 writes `attribution` as a `Map<entitlementId, Array<{source:'rule'…} | {source:'request'…}>>`. Provision's Task 7 defines `Attribution` as `{ ruleId; ruleName; contractId }` and its `desired.ts`, `plan.ts`, `run-service.ts` and `explain.ts` all read `.ruleId` off it. Retagging that union means rewriting four modules this plan cannot see, in a slice being built concurrently. Task 8 therefore adds a **parallel** `DesiredState.grantAttribution: Map<string, GrantAttribution[]>` and `PlannedAction.attributedGrantIds: string[]`, carrying exactly the information the spec's union carries, additively. "Why does this person hold this?" answers with a rule and a contract, a request and its approver, or both — which is the requirement. The shape differs; the answer does not.

2. **The enqueue of a Provision run is not transactional.** Spec §16 says "the enqueue is a pg-boss insert in the same PostgreSQL instance, so it commits or rolls back with the transaction". It does not: `Scheduler.enqueue` calls `boss.send(name, data)` on pg-boss's **own** connection pool, not on the Prisma transaction's connection, so an enqueue inside `withTenant` neither participates in the transaction nor rolls back with it. Task 9 therefore commits first and enqueues afterwards, and Task 12's reflection pass **re-enqueues** a run for any target holding a `pending` grant whose request has sat in `awaiting_fulfilment` with no run since. That closes the window the ordering opens, and it also covers a crash between commit and enqueue, which a transactional enqueue would not have covered either.

3. **Reflection polls rather than being called back.** Spec §16 says "when a Provision run finishes, a handler reads the actions carrying a `grantId`". Provision's plan exposes no completion hook on `applyProvisionRun` and `apps/api/src/scheduler.ts` has no announce/listen seam for runs. Task 12 implements reflection as an idempotent pass over `RequestItem` rows in `dispatched` whose `provisionActionId` names a terminal `ProvisionAction`, driven by the `automate.tick` schedule. A poll is strictly more robust than a hook here: it recovers from a crash between the apply and the callback, which is exactly when a request would otherwise sit in `awaiting_fulfilment` forever.

---

## File Structure

```
packages/db/prisma/
  schema.prisma                     + AutomateSettings, Product, ProductGrant,
                                      ApprovalWorkflow, ApprovalStage, AccessRequest,
                                      RequestItem, ApprovalStep, ApprovalStepApprover,
                                      ApprovalDecision, ApprovalDelegation, AccessGrant,
                                      ResourceOwner, ResourceDelegation, ExpirySweep,
                                      SweepAction, SweepException, NotificationOutbox,
                                      NotificationPreference
                                    MODIFIED: Entitlement.requestable,
                                      AccountEntitlement.grantedByRequestId,
                                      ProvisionAction.grantId
  migrations/20260821000000_automate_requests/migration.sql

packages/core/src/automate/
  types.ts             the shared value unions every module below speaks   (pure)
  audience.ts          audienceConditionSchema, evaluateAudience           (pure)
  form.ts              formSchemaSchema, validateFormValues                (pure)
  duration.ts          resolveRequestedDuration, grantWindow, grantInForce (pure)
  approvers.ts         resolveStageApprovers + the self-approval subtraction
  notify.ts            enqueueOutbox, usersWithPermission, isDigestible
  catalog-service.ts   products, settings, resource owners, visibleProducts
  workflow-service.ts  workflow storage, save-time validation, preview
  fulfil.ts            the three fulfilment paths, hand-back, revoke
  request-service.ts   submitRequest, eligibility, the snapshot
  decision-service.ts  recordDecision, cancel, advance, blocked_no_approver
  reflect.ts           what Provision's run did to the grant
  sweep-guard.ts       evaluateSweepGuard                                  (pure)
  sweep-service.ts     classifySweep (pure) + preview/apply
  delegation-service.ts approval delegation, resource delegation, portal acts
  jobs.ts              AUTOMATE_* queues, schedule keys, registerAutomateJobs

packages/core/src/notify/templates/index.ts   MODIFIED — the Automate templates
packages/core/src/rbac/permissions.ts         MODIFIED — three permissions
packages/core/src/provision/types.ts          MODIFIED — GrantFacts, grantAttribution
packages/core/src/provision/desired.ts        MODIFIED — the grants term
packages/core/src/provision/plan.ts           MODIFIED — attributedGrantIds
packages/core/src/provision/entitlement-service.ts MODIFIED — remitFor widening
packages/core/src/provision/run-service.ts    MODIFIED — load grants, write grantId
packages/core/src/provision/explain.ts        MODIFIED — request attribution
packages/core/src/index.ts                    MODIFIED — one export line per module

packages/contracts/src/automate.ts            every request/response schema
packages/contracts/src/index.ts               MODIFIED

apps/api/src/routes/admin/automate.ts         /api/admin/automate/*
apps/api/src/routes/automate-portal.ts        /api/portal/automate/*
apps/api/src/app.ts                           MODIFIED — registers both
apps/api/src/scheduler.ts                     MODIFIED — registerAutomateJobs

apps/web/src/pages/automate/                  the portal screens
apps/web/src/pages/admin/                     the console screens
apps/web/src/routes.tsx                       MODIFIED — portal routes
apps/web/src/pages/admin/AdminApp.tsx         MODIFIED — console routes, RELATIVE

e2e/automate.spec.ts                          the whole slice through a browser
```

`packages/core/src/automate/audience.ts`, `form.ts`, `duration.ts`, `sweep-guard.ts` and the `classifySweep` half of `sweep-service.ts` import nothing from `@syntra/db`. They may import from `packages/core/src/provision/condition.ts` and `plan.ts`, which are themselves pure. Any *value* import from `@syntra/db` in those five means the boundary is wrong.

---

## Task 1: Data model

Nineteen new tables and three columns added to tables other subsystems own. Spec §15.

**A note on relations that are deliberately absent.** None of these models declares a Prisma `@relation` to `Person`, `User`, `Group`, `Application`, `Entitlement` or `ProvisionAction`. Subject, owner, delegate and resource references are bare `@db.Uuid` columns, exactly as `AppAssignment` already stores `userId`, `groupId` and `orgUnitId` with no relation. Two reasons: adding a back-relation edits a model Directory Sync rewrites every night, which is how a boundary erodes; and a foreign key from `AccessGrant` to `Entitlement` would make deleting a target system fail on a live grant rather than succeed through Provision's own confirmable delete. Relations exist only *within* Automate's own tables, where the cascade is ours to define.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260821000000_automate_requests/migration.sql`
- Test: `packages/db/src/automate-schema.test.ts`

**Interfaces:**
- Consumes: `prisma`, `withTenant`, `TenantClient` from `@syntra/db`; `resetDatabase`, `asDatabaseSuperuser` from `@syntra/db/src/test-support.js`. The existing `Entitlement`, `AccountEntitlement` and `ProvisionAction` models from `20260820000000_provision_targets`.
- Produces: every Prisma model the rest of the plan reads and writes — `AutomateSettings`, `Product`, `ProductGrant`, `ApprovalWorkflow`, `ApprovalStage`, `AccessRequest`, `RequestItem`, `ApprovalStep`, `ApprovalStepApprover`, `ApprovalDecision`, `ApprovalDelegation`, `AccessGrant`, `ResourceOwner`, `ResourceDelegation`, `ExpirySweep`, `SweepAction`, `SweepException`, `NotificationOutbox`, `NotificationPreference` — plus three added columns: `Entitlement.requestable`, `AccountEntitlement.grantedByRequestId` and `ProvisionAction.grantId`.
- Three fields exist here only because a later task needs them and nothing else would supply them: `SweepAction.provisionActionId` (Task 12 reflects a Provision outcome back onto a sweep's removal), `AccessGrant.supersededByGrantId` (Task 14 must not expire a grant an approved extension already replaced) and `AccessRequest.replacesGrantId` (Task 10 pre-fills an extension and Task 9 links the two).

- [ ] **Step 1: Add the settings, catalog and workflow models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// One row per tenant, holding every number the Automate design names, so
/// that none of them is a constant compiled into the code. Two of the columns
/// are not settings at all: `lastAppliedSweepAt` and
/// `personsWithActiveContractAtLastSweep` are the denominator the
/// population-collapse refusal compares against, and they are STORED rather
/// than recomputed for the same reason Provision stores `lastAppliedRunAt` —
/// the comparison is against the last state somebody accepted, not against
/// the last state observed.
///
/// MAX_MANAGER_DEPTH is deliberately not here. It is a cycle-termination
/// constant, not a policy, and a tenant that could raise it could hang its
/// own approvals.
model AutomateSettings {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @unique @db.Uuid

  sweepSchedule                   String? @default("0 2 * * *")
  sweepThresholdPercent           Int     @default(10)
  perProductSweepThresholdPercent Int     @default(50)
  personPopulationDropPercent     Int     @default(20)
  fulfilmentSlaHours              Int     @default(24)
  /// Days before `endsAt` that the holder and the original approver are told.
  expiryWarningDays               Int[]   @default([7, 1])
  /// For an `application` or `localGroup` grant, which has no target system
  /// to inherit a pre-hire horizon from. Two horizons rather than one is not
  /// duplication: a domain that needs an account three weeks early does not
  /// imply a portal tile three weeks early.
  preHireHorizonDays              Int     @default(14)
  maxDelegationDays               Int     @default(90)
  maxApprovers                    Int     @default(10)
  delegatedBulkLimit              Int     @default(25)

  lastAppliedSweepAt                   DateTime?
  personsWithActiveContractAtLastSweep Int?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}

/// One thing a person may ask for. `audienceCondition` NULL means visible to
/// NOBODY — the safe reading of an unconfigured access control — and a
/// product genuinely meant for everybody says so with `{ "all": [] }`.
model Product {
  id                  String  @id @default(uuid()) @db.Uuid
  tenantId            String  @db.Uuid
  name                String
  slug                String
  description         String?
  category            String?
  iconUrl             String?
  /// Free text on the request form: where a tenant explains what the thing is.
  requestInstructions String?
  /// 'targetEntitlement' | 'application' | 'localGroup'
  kind                String
  /// The audience expression. NULL MEANS NOBODY. See the check constraint on
  /// nothing at all: this one cannot be enforced in SQL, only in the resolver,
  /// which is why Task 6 has a test for it and the catalog editor says so.
  audienceCondition   Json?
  workflowId          String  @db.Uuid
  workflow            ApprovalWorkflow @relation(fields: [workflowId], references: [id], onDelete: Restrict)
  /// The typed request form, a list of fields from a closed set.
  formSchema          Json    @default("[]")
  /// 'permanent' | 'fixed' | 'requesterChoice'
  durationMode        String  @default("permanent")
  defaultDurationDays Int?
  maxDurationDays     Int?
  ownerPersonId       String? @db.Uuid
  ownerGroupId        String? @db.Uuid
  /// 'draft' | 'active' | 'retired'. Never hard-deleted while any grant or
  /// request references it.
  status              String  @default("draft")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  grants   ProductGrant[]
  requests AccessRequest[]

  @@unique([tenantId, slug])
  @@index([tenantId])
  @@index([tenantId, status])
}

/// One resource a product grants. A product granting several is a bundle,
/// requested, approved and fulfilled as a set, with per-resource outcomes
/// recorded per RequestItem.
model ProductGrant {
  id        String  @id @default(uuid()) @db.Uuid
  tenantId  String  @db.Uuid
  productId String  @db.Uuid
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  /// 'entitlement' | 'application' | 'group'
  resourceType   String
  resourceId     String  @db.Uuid
  /// Set for 'entitlement', null otherwise. Every entitlement grant in one
  /// bundle must name the SAME target, so one Provision run fulfils the whole
  /// thing; Task 6 refuses a save that mixes two.
  targetSystemId String? @db.Uuid
  /// For a resourcePicker form: the requester chooses among the optional ones.
  optional       Boolean @default(false)

  @@unique([tenantId, productId, resourceType, resourceId])
  @@index([tenantId])
  @@index([productId])
}

/// An ordered list of stages. A workflow with ZERO stages grants immediately —
/// not a flag, not a special case; the empty list is the mechanism.
model ApprovalWorkflow {
  id          String  @id @default(uuid()) @db.Uuid
  tenantId    String  @db.Uuid
  name        String
  description String?
  enabled     Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  stages   ApprovalStage[]
  products Product[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model ApprovalStage {
  id         String           @id @default(uuid()) @db.Uuid
  tenantId   String           @db.Uuid
  workflowId String           @db.Uuid
  workflow   ApprovalWorkflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  sequence   Int
  name       String
  /// 'manager' | 'managerChain' | 'productOwner' | 'resourceOwner' | 'role'
  /// | 'group' | 'person'
  selector   String
  /// { depth?, roleId?, groupId?, personId? }
  selectorConfig Json @default("{}")
  /// 'any' (first decision decides) | 'all' (every resolved approver)
  quorum     String @default("any")
  /// Required when selector is manager, managerChain or resourceOwner: the
  /// three that legitimately resolve to nobody. Enforced by a check
  /// constraint as well as at save time, because discovering it at 3am on
  /// somebody's request is the failure this exists to prevent.
  fallbackSelector String?
  fallbackConfig   Json    @default("{}")
  slaHours   Int    @default(48)
  /// 'remind' (default) | 'escalate' | 'expire'. THERE IS NO VALUE THAT
  /// APPROVES. Approval by inattention is a privilege grant nobody made.
  onTimeout  String @default("remind")
  escalationSelector String?
  escalationConfig   Json    @default("{}")
  /// Required when onTimeout is 'expire'.
  expiryHours Int?

  @@unique([workflowId, sequence])
  @@index([tenantId])
}
```

- [ ] **Step 2: Add the request, step and decision models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// The ask. An AccessRequest is the ask; an AccessGrant is the holding. They
/// have separate lifecycles, and conflating them is what makes "what happens
/// when the date arrives" unanswerable.
model AccessRequest {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @db.Uuid
  /// Null for a delegated administrative act, which has no catalog entry.
  productId String?  @db.Uuid
  product   Product? @relation(fields: [productId], references: [id], onDelete: Restrict)
  subjectPersonId  String @db.Uuid
  requestedByUserId String @db.Uuid
  /// The person behind requestedByUserId, resolved at submission so the
  /// self-approval subtraction has a person to subtract without re-reading
  /// the User row at every stage. Null when the submitting account is not
  /// linked to a person.
  requestedByPersonId String? @db.Uuid
  /// 'catalog' | 'delegated_admin'
  origin        String @default("catalog")
  /// Set for a delegated act, which names its resource directly.
  resourceType  String?
  resourceId    String? @db.Uuid
  justification String?
  formValues    Json    @default("{}")
  requestedDurationDays Int?
  /// The grant this request would replace, for an extension. Task 9 sets
  /// `supersededByGrantId` on the old grant when the new one lands, so a
  /// naive implementation cannot expire the old one, revoke at the target and
  /// re-grant an hour later.
  replacesGrantId String? @db.Uuid
  /// pending_approval | blocked_no_approver | approved | awaiting_fulfilment
  /// | fulfilled | partially_fulfilled | fulfilment_failed | rejected
  /// | cancelled | expired
  status       String @default("pending_approval")
  statusReason String?
  submittedAt  DateTime  @default(now())
  decidedAt    DateTime?
  fulfilledAt  DateTime?
  /// When this request entered awaiting_fulfilment, so the fulfilment SLA has
  /// something to measure from that `submittedAt` cannot supply.
  dispatchedAt DateTime?

  items RequestItem[]
  steps ApprovalStep[]

  @@index([tenantId])
  @@index([tenantId, status])
  @@index([tenantId, subjectPersonId])
}

/// The snapshot of what was asked for, written at submission. Editing the
/// product afterwards changes nothing about this request — the same principle
/// as Directory Sync's materialized SyncChange and Provision's
/// ProvisionAction: what was reviewed is what is applied, literally.
model RequestItem {
  id        String        @id @default(uuid()) @db.Uuid
  tenantId  String        @db.Uuid
  requestId String        @db.Uuid
  request   AccessRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  resourceType   String
  resourceId     String  @db.Uuid
  targetSystemId String? @db.Uuid
  /// 'pending' | 'dispatched' | 'fulfilled' | 'failed' | 'skipped'
  status  String @default("pending")
  /// The Provision action that is applying this. A bare column, not a
  /// relation: the action is Provision's row and cascading from it would
  /// delete the record of what happened when a run is cleaned up.
  provisionActionId String? @db.Uuid
  grantId String? @db.Uuid
  message String?

  @@unique([requestId, resourceType, resourceId])
  @@index([tenantId])
  @@index([tenantId, status])
}

/// One per workflow stage, instantiated at submission carrying the whole
/// stage as it stood, so a workflow edited afterwards cannot change what an
/// approver's signature meant.
model ApprovalStep {
  id        String        @id @default(uuid()) @db.Uuid
  tenantId  String        @db.Uuid
  requestId String        @db.Uuid
  request   AccessRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  sequence  Int
  stageSnapshot Json
  /// 'waiting' | 'open' | 'approved' | 'rejected' | 'skipped'
  status    String    @default("waiting")
  openedAt  DateTime?
  closedAt  DateTime?
  slaDueAt  DateTime?
  escalatedAt DateTime?
  /// When the last reminder went out, so the daily cadence after 100% of the
  /// SLA is a cadence and not a message per tick.
  lastRemindedAt DateTime?

  approvers ApprovalStepApprover[]
  decisions ApprovalDecision[]

  @@unique([requestId, sequence])
  @@index([tenantId])
  @@index([tenantId, status])
}

/// The MATERIALIZED resolved set. This is what makes "who was this with, on
/// the Tuesday it was sitting there" answerable a year later rather than
/// recomputable against a directory that has since moved.
model ApprovalStepApprover {
  id       String       @id @default(uuid()) @db.Uuid
  tenantId String       @db.Uuid
  stepId   String       @db.Uuid
  step     ApprovalStep @relation(fields: [stepId], references: [id], onDelete: Cascade)
  personId String       @db.Uuid
  /// 'selector' | 'delegate' | 'escalation' | 'fallback'
  via      String
  /// The delegator, when via is 'delegate'.
  onBehalfOfPersonId String? @db.Uuid
  addedAt  DateTime @default(now())

  /// One row per person per step. A person resolved both by the selector and
  /// as somebody's delegate is one approver, not two — which is also what
  /// makes an `all` quorum countable.
  @@unique([stepId, personId])
  @@index([tenantId])
}

/// Append-only in the same sense as the audit log: never updated, never
/// deleted. A reversal is a new row with its own reason. The migration adds
/// the two PostgreSQL rules that make that true of the data rather than true
/// of the one code path that happens to respect it.
model ApprovalDecision {
  id       String       @id @default(uuid()) @db.Uuid
  tenantId String       @db.Uuid
  stepId   String       @db.Uuid
  step     ApprovalStep @relation(fields: [stepId], references: [id], onDelete: Cascade)
  personId String       @db.Uuid
  /// The account the decision was made from, so a decision can be tied to a
  /// session as well as to a person.
  userId   String?      @db.Uuid
  /// 'approve' | 'reject'
  decision String
  /// Required on a reject. A refusal with no reason is an unanswerable
  /// support call and a request the person will simply raise again.
  comment  String?
  /// An approver may SHORTEN a duration when deciding. Never lengthen it.
  shortenedToDays Int?
  /// 'selector' | 'delegate' | 'escalation' | 'fallback' | 'administrator'
  via      String
  onBehalfOfPersonId String? @db.Uuid
  decidedAt DateTime @default(now())

  @@index([tenantId])
  @@index([stepId])
}

/// Adds an approver; never replaces one. Depth 1, end date required.
model ApprovalDelegation {
  id                 String    @id @default(uuid()) @db.Uuid
  tenantId           String    @db.Uuid
  delegatorPersonId  String    @db.Uuid
  delegatePersonId   String    @db.Uuid
  /// Optional restriction to one product category.
  category           String?
  startsAt           DateTime
  endsAt             DateTime
  createdByUserId    String?   @db.Uuid
  revokedAt          DateTime?

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([tenantId, delegatorPersonId])
}
```

- [ ] **Step 3: Add the grant, ownership and delegation models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// The holding. Its status is about the access, not about the ask.
///
///   scheduled — startsAt is in the future; confers NOTHING until then.
///   pending   — in force, dispatched, not yet confirmed applied at the target.
///   active    — confirmed held.
///   expired   — endsAt passed.
///   lapsed    — the subject's contracts all ended.
///   revoked   — handed back, or withdrawn by an owner or administrator.
///
/// Desired state includes `pending` and `active` — grants whose window covers
/// now. A scheduled grant never confers access before its start date, which
/// mirrors Provision's split between the horizon deciding that an account
/// exists and `now` deciding that it holds anything.
model AccessGrant {
  id              String  @id @default(uuid()) @db.Uuid
  tenantId        String  @db.Uuid
  subjectPersonId String  @db.Uuid
  resourceType    String
  resourceId      String  @db.Uuid
  targetSystemId  String? @db.Uuid
  /// 'request' | 'delegated_admin'
  origin          String  @default("request")
  requestId       String? @db.Uuid
  /// Denormalised from the request so the sweep can group by product without
  /// a join through a nullable request, and so a grant survives a request
  /// whose product was later retired.
  productId       String? @db.Uuid
  startsAt        DateTime
  endsAt          DateTime?
  status          String  @default("pending")
  statusReason    String?
  /// Set the FIRST time a sweep observes that the subject no longer satisfies
  /// the product's audience. A flag, not a removal: it changes nothing about
  /// what the person holds, so the sweep guard does not count it and the
  /// review screen cannot skip it.
  needsReview     Boolean @default(false)
  reviewReason    String?
  reviewedAt      DateTime?
  /// The grant that replaced this one when an extension was approved before
  /// the original expired, so no removal is produced and there is no outage.
  supersededByGrantId String? @db.Uuid
  /// The person who approved the request this grant came from, so the expiry
  /// warning and the lapse notice can reach them without walking the steps.
  approvedByPersonId  String? @db.Uuid

  createdAt DateTime  @default(now())
  endedAt   DateTime?

  @@index([tenantId])
  /// The read desiredState performs, per person.
  @@index([tenantId, subjectPersonId, status])
  /// The read the sweep performs.
  @@index([tenantId, endsAt])
  @@index([tenantId, productId, status])
}

/// Who owns a resource, for the resourceOwner selector. Deliberately a
/// separate table rather than a column on Entitlement, Application and Group,
/// because two of those three are owned by other subsystems and adding a
/// column to a table another subsystem rewrites every night is how a boundary
/// erodes.
model ResourceOwner {
  id            String  @id @default(uuid()) @db.Uuid
  tenantId      String  @db.Uuid
  resourceType  String
  resourceId    String  @db.Uuid
  ownerPersonId String? @db.Uuid
  ownerGroupId  String? @db.Uuid

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([tenantId, resourceType, resourceId])
  @@index([tenantId])
}

/// A team lead who may add and remove members of ONE resource they own, from
/// the portal, with no administrative session. Scope is per resource, never
/// per type: there is no "manage all groups" delegation; that is a role, and
/// roles live in the console.
model ResourceDelegation {
  id               String  @id @default(uuid()) @db.Uuid
  tenantId         String  @db.Uuid
  resourceType     String
  resourceId       String  @db.Uuid
  delegatePersonId String? @db.Uuid
  delegateGroupId  String? @db.Uuid
  /// Subset of ['view_members','approve','grant','revoke'].
  capabilities     String[]
  /// Applies where the resource is not reachable through a product whose
  /// condition would apply. Without an audience rule of some kind, delegation
  /// is a hole underneath the catalog's visibility model.
  audienceCondition Json?
  startsAt         DateTime
  endsAt           DateTime?
  createdByUserId  String?  @db.Uuid

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([tenantId, resourceType, resourceId])
}
```

- [ ] **Step 4: Add the sweep and notification models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A run, in exactly the idiom Directory Sync and Provision established: it
/// computes, writes down one row per proposed removal, and stops.
model ExpirySweep {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  /// 'running' | 'previewed' | 'blocked' | 'applying' | 'applied'
  /// | 'partially_applied' | 'failed'
  status   String @default("running")
  startedAt  DateTime  @default(now())
  finishedAt DateTime?

  expireCount Int @default(0)
  lapseCount  Int @default(0)
  /// Grants flagged for review. Counted separately and NOT by the guard: a
  /// flag changes nothing about what anybody holds.
  reviewFlagCount Int @default(0)

  personsWithActiveContract Int @default(0)
  personsUnprocessable      Int @default(0)
  /// Active application and localGroup grants in the tenant: the denominator
  /// of the internal-removal axis. Provision's guard covers the target half.
  internalGrantsInTenant    Int @default(0)

  requiresConfirmation Boolean @default(false)
  blockedReason        String?
  confirmedByUserId    String? @db.Uuid
  error                String?

  actions    SweepAction[]
  exceptions SweepException[]

  @@index([tenantId])
  @@index([tenantId, startedAt])
}

model SweepAction {
  id       String      @id @default(uuid()) @db.Uuid
  tenantId String      @db.Uuid
  sweepId  String      @db.Uuid
  sweep    ExpirySweep @relation(fields: [sweepId], references: [id], onDelete: Cascade)
  grantId  String      @db.Uuid
  /// 'expire' | 'lapse'
  kind     String
  productId       String? @db.Uuid
  subjectPersonId String  @db.Uuid
  resourceType    String
  resourceId      String  @db.Uuid
  targetSystemId  String? @db.Uuid
  /// 'proposed' | 'dispatched' | 'applied' | 'skipped' | 'failed'
  status   String @default("proposed")
  provisionActionId String? @db.Uuid
  message  String?

  /// How the apply loop reads it. Directory Sync indexed its equivalent on
  /// (runId, changeType) and then queried by status; do not repeat that.
  @@index([sweepId, status])
  @@index([tenantId])
}

/// The person with no contracts at all, BY NAME. A person the system cannot
/// understand must produce no actions, never empty desired state.
model SweepException {
  id       String      @id @default(uuid()) @db.Uuid
  tenantId String      @db.Uuid
  sweepId  String      @db.Uuid
  sweep    ExpirySweep @relation(fields: [sweepId], references: [id], onDelete: Cascade)
  personId String      @db.Uuid
  /// 'no_contracts' | 'not_yet_started' | 'no_user_account'
  kind     String
  message  String

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([sweepId])
}

/// Rendered inside the transaction, sent by a job afterwards. Not ceremony:
/// "the approver says they never got the mail" is the most common support
/// question a request system produces, and without a row it is unanswerable.
model NotificationOutbox {
  id        String  @id @default(uuid()) @db.Uuid
  tenantId  String  @db.Uuid
  template  String
  to        String
  vars      Json    @default("{}")
  requestId String? @db.Uuid
  /// Who it was for, so a per-user digest preference can be honoured and a
  /// failure can be reported against somebody.
  userId    String? @db.Uuid
  attempts  Int     @default(0)
  lastError String?
  sentAt    DateTime?
  /// Withheld until the daily digest runs, for a recipient who chose one.
  /// Failures, blocks and confirmations are never digested regardless of
  /// preference, so this is false on those rows whatever the preference says.
  digest    Boolean @default(false)

  createdAt DateTime @default(now())

  @@index([tenantId])
  /// The sender's read: unsent rows, oldest first.
  @@index([tenantId, sentAt, createdAt])
}

model NotificationPreference {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  userId   String @db.Uuid
  /// 'immediate' | 'daily'
  mode     String @default("immediate")

  updatedAt DateTime @updatedAt

  @@unique([userId])
  @@index([tenantId])
}
```

- [ ] **Step 5: Add the three columns to tables other subsystems own**

Spec §15 lists these rather than absorbing them. In `packages/db/prisma/schema.prisma`, inside the **existing** `Entitlement` model (created by `20260820000000_provision_targets`), after `holderCount`:

```prisma
  /// Whether this entitlement may be named by a catalog product. False by
  /// default, so a target's catalog can be published without publishing every
  /// group in the domain.
  requestable    Boolean  @default(false)
```

Inside the existing `AccountEntitlement` model, replace the `origin` doc comment and add the column, so the block reads:

```prisma
  /// 'rule' — Provision granted it because a rule said so.
  /// 'request' — an approved AccessRequest put it into desired state. ONE
  ///   value covers both grant origins: a delegated administrator's act is an
  ///   AccessRequest too, so `grantedByRequestId` answers which kind it was
  ///   without a second enum value that would mean the same thing here.
  /// 'manual' — an administrator linked it in Syntra deliberately.
  /// 'discovered' — the target already held it when Provision first looked.
  origin        String
  grantedByRuleId String? @db.Uuid
  grantedByRequestId String? @db.Uuid
```

Inside the existing `ProvisionAction` model, after `attributedRuleIds`:

```prisma
  /// The AccessGrant this action is applying or removing, when one caused it.
  /// A bare column and not a relation: Automate's reflection pass reads it,
  /// and a foreign key would make deleting a grant fail on the history of
  /// what was done about it.
  grantId       String?  @db.Uuid
```

and add to that model's index list:

```prisma
  @@index([tenantId, grantId])
```

- [ ] **Step 6: Re-read the migrations directory, then generate the migration**

```bash
ls packages/db/prisma/migrations
```

Confirm nothing sorts at or after `20260821000000`. Provision is being built in this same checkout and claimed `20260820000000`; if a newer directory has appeared, bump the date below and everywhere it is named. A timestamp collision was caught once already on this programme, and the failure is a migration ordering that depends on filesystem enumeration.

```bash
cd packages/db && pnpm prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > /tmp/automate.sql
mkdir -p prisma/migrations/20260821000000_automate_requests
cp /tmp/automate.sql prisma/migrations/20260821000000_automate_requests/migration.sql
```

- [ ] **Step 7: Read the generated file before touching anything else**

Open `packages/db/prisma/migrations/20260821000000_automate_requests/migration.sql` and search it for `DROP INDEX` and for `DROP RULE`.

`migrate diff --from-migrations` compares the *schema file* against a shadow database built from the existing migrations, and `schema.prisma` can express neither a partial index nor a rule. Every partial index the previous slices created by hand — `role_assignment_unscoped_unique`, `contract_one_primary_per_person`, `app_assignment_unique_user`, `app_assignment_unique_group`, `app_assignment_unique_org_unit`, `webauthn_challenge_one_live`, `password_reset_token_one_live`, `account_profile_one_per_target`, `target_account_anchor_unique`, `account_entitlement_one_live`, `provision_run_one_non_terminal` and the sync ones — is therefore invisible to the schema file and looks like something the database has that the model does not.

**If any `DROP INDEX` or `DROP RULE` appears, delete those lines from the generated file before going further.** Applying them silently removes constraints nothing in the test suite would notice were gone, because `resetDatabase()` truncates rather than re-migrating.

- [ ] **Step 8: Append row-level security, the check constraints, the partial indexes and the append-only rules**

Append to `packages/db/prisma/migrations/20260821000000_automate_requests/migration.sql`:

```sql
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AutomateSettings','Product','ProductGrant','ApprovalWorkflow','ApprovalStage',
    'AccessRequest','RequestItem','ApprovalStep','ApprovalStepApprover',
    'ApprovalDecision','ApprovalDelegation','AccessGrant','ResourceOwner',
    'ResourceDelegation','ExpirySweep','SweepAction','SweepException',
    'NotificationOutbox','NotificationPreference'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- A person holds one LIVE grant of one resource at a time. `status` is NOT
-- NULL, but the rule is qualified by it, and a plain UNIQUE over the four
-- columns would forbid ever granting the same thing again after it expired --
-- which is exactly what an extension does. Partial is the only version that
-- says what is meant.
CREATE UNIQUE INDEX access_grant_one_live
  ON "AccessGrant" ("tenantId", "subjectPersonId", "resourceType", "resourceId")
  WHERE "status" IN ('scheduled', 'pending', 'active');

-- One sweep per tenant in a non-terminal state, for the reason Provision
-- gives for the same index on its runs: two overlapping plans can interleave
-- a removal from the older behind a grant from the newer, producing a state
-- neither plan described and nobody confirmed.
CREATE UNIQUE INDEX expiry_sweep_one_non_terminal
  ON "ExpirySweep" ("tenantId")
  WHERE "status" IN ('running', 'previewed', 'blocked', 'applying');

-- Percentages are percentages.
ALTER TABLE "AutomateSettings" ADD CONSTRAINT automate_settings_are_percent CHECK (
  "sweepThresholdPercent"           BETWEEN 0 AND 100 AND
  "perProductSweepThresholdPercent" BETWEEN 0 AND 100 AND
  "personPopulationDropPercent"     BETWEEN 0 AND 100
);

ALTER TABLE "AutomateSettings" ADD CONSTRAINT automate_settings_positive_limits CHECK (
  "fulfilmentSlaHours" > 0 AND
  "preHireHorizonDays" >= 0 AND
  "maxDelegationDays"  > 0 AND
  "maxApprovers"       > 0 AND
  "delegatedBulkLimit" > 0
);

ALTER TABLE "Product" ADD CONSTRAINT product_kind_is_known CHECK (
  "kind" IN ('targetEntitlement', 'application', 'localGroup')
);

ALTER TABLE "Product" ADD CONSTRAINT product_status_is_known CHECK (
  "status" IN ('draft', 'active', 'retired')
);

-- The duration rules, per spec section 12. `fixed` without a default runs
-- every grant for an unstated number of days; `requesterChoice` without a cap
-- is `permanent` with extra clicks.
ALTER TABLE "Product" ADD CONSTRAINT product_duration_is_coherent CHECK (
  "durationMode" IN ('permanent', 'fixed', 'requesterChoice')
  AND ("durationMode" <> 'fixed' OR "defaultDurationDays" IS NOT NULL)
  AND ("durationMode" <> 'requesterChoice' OR "maxDurationDays" IS NOT NULL)
  AND ("defaultDurationDays" IS NULL OR "maxDurationDays" IS NULL
       OR "defaultDurationDays" <= "maxDurationDays")
);

-- One owner, or none. Both at once has no defined meaning for the
-- productOwner selector and would make "who owns this" ambiguous.
ALTER TABLE "Product" ADD CONSTRAINT product_one_owner CHECK (
  NOT ("ownerPersonId" IS NOT NULL AND "ownerGroupId" IS NOT NULL)
);

ALTER TABLE "ProductGrant" ADD CONSTRAINT product_grant_resource_type CHECK (
  "resourceType" IN ('entitlement', 'application', 'group')
);

-- A target entitlement without a target cannot be routed to a Provision run,
-- and a target on anything else names a system the grant has nothing to do
-- with.
ALTER TABLE "ProductGrant" ADD CONSTRAINT product_grant_target_matches_type CHECK (
  ("resourceType" = 'entitlement') = ("targetSystemId" IS NOT NULL)
);

ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_selector_is_known CHECK (
  "selector" IN ('manager','managerChain','productOwner','resourceOwner','role','group','person')
  AND ("fallbackSelector" IS NULL OR "fallbackSelector" IN
       ('manager','managerChain','productOwner','resourceOwner','role','group','person'))
  AND ("escalationSelector" IS NULL OR "escalationSelector" IN
       ('manager','managerChain','productOwner','resourceOwner','role','group','person'))
);

ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_quorum_is_known CHECK (
  "quorum" IN ('any', 'all')
);

-- No timeout approves. The enum is the enforcement, and it is enforced in the
-- database so that adding a fourth value is a migration somebody has to write
-- rather than a string somebody can pass.
ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_timeout_never_approves CHECK (
  "onTimeout" IN ('remind', 'escalate', 'expire')
  AND ("onTimeout" <> 'expire' OR "expiryHours" IS NOT NULL)
  AND ("onTimeout" <> 'escalate' OR "escalationSelector" IS NOT NULL)
  AND "slaHours" > 0
);

-- The three selectors that legitimately resolve to nobody must declare a
-- fallback. Validated at save time as well, because a constraint violation is
-- a 500 and a validation error is a message -- this is the backstop that
-- makes the rule true of the data.
ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_fallback_required CHECK (
  "selector" NOT IN ('manager', 'managerChain', 'resourceOwner')
  OR "fallbackSelector" IS NOT NULL
);

-- A rejection requires a reason. Not a nicety: a refusal with no reason is an
-- unanswerable support call and a request the person will simply raise again.
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT approval_decision_reject_has_comment CHECK (
  "decision" IN ('approve', 'reject')
  AND ("decision" <> 'reject' OR ("comment" IS NOT NULL AND btrim("comment") <> ''))
);

-- An approver may shorten a duration, never lengthen it, and never to zero.
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT approval_decision_shortening_is_positive CHECK (
  "shortenedToDays" IS NULL OR "shortenedToDays" > 0
);

-- Append-only. The rules make tampering through the application impossible;
-- the audit chain makes tampering through direct database access detectable.
-- Neither substitutes for the other. TRUNCATE is not affected by rules, so
-- resetDatabase() still works.
CREATE RULE approval_decision_no_update AS ON UPDATE TO "ApprovalDecision" DO INSTEAD NOTHING;
CREATE RULE approval_decision_no_delete AS ON DELETE TO "ApprovalDecision" DO INSTEAD NOTHING;

ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT approval_delegation_window CHECK (
  "endsAt" > "startsAt"
);

-- Delegation is not self-delegation. Depth 1 is enforced in code because it
-- needs a second row to see; this one needs only this row.
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT approval_delegation_not_self CHECK (
  "delegatorPersonId" <> "delegatePersonId"
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_status_is_known CHECK (
  "status" IN ('scheduled', 'pending', 'active', 'expired', 'lapsed', 'revoked')
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_window CHECK (
  "endsAt" IS NULL OR "endsAt" > "startsAt"
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_target_matches_type CHECK (
  ("resourceType" = 'entitlement') = ("targetSystemId" IS NOT NULL)
);

ALTER TABLE "ResourceOwner" ADD CONSTRAINT resource_owner_exactly_one CHECK (
  ("ownerPersonId" IS NOT NULL) <> ("ownerGroupId" IS NOT NULL)
);

ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_exactly_one CHECK (
  ("delegatePersonId" IS NOT NULL) <> ("delegateGroupId" IS NOT NULL)
);

ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_window CHECK (
  "endsAt" IS NULL OR "endsAt" > "startsAt"
);

-- Capabilities come from a closed set. An unknown capability string would be
-- silently ignored by every check, which reads as "denied" in some code paths
-- and "not checked" in others.
ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_capabilities CHECK (
  "capabilities" <@ ARRAY['view_members','approve','grant','revoke']::text[]
  AND array_length("capabilities", 1) IS NOT NULL
);

ALTER TABLE "NotificationPreference" ADD CONSTRAINT notification_preference_mode CHECK (
  "mode" IN ('immediate', 'daily')
);
```

- [ ] **Step 9: Apply and regenerate**

```bash
cd packages/db && pnpm prisma migrate deploy && pnpm prisma generate
```

- [ ] **Step 10: Write the failing test**

`packages/db/src/automate-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { asDatabaseSuperuser, resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;
let personId: string;
let workflowId: string;
let productId: string;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const o = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
  tenantId = t.id;
  otherTenantId = o.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Manager approval' },
    });
    const product = await tx.product.create({
      data: {
        tenantId,
        name: 'Statistics licence',
        slug: 'statistics-licence',
        kind: 'application',
        workflowId: workflow.id,
      },
    });
    return { personId: person.id, workflowId: workflow.id, productId: product.id };
  });
  personId = seeded.personId;
  workflowId = seeded.workflowId;
  productId = seeded.productId;
});

describe('automate settings', () => {
  it('defaults every number to the value the spec fixes', async () => {
    const settings = await withTenant(tenantId, (tx) =>
      tx.automateSettings.create({ data: { tenantId } }),
    );
    expect(settings.sweepSchedule).toBe('0 2 * * *');
    expect(settings.sweepThresholdPercent).toBe(10);
    expect(settings.perProductSweepThresholdPercent).toBe(50);
    expect(settings.personPopulationDropPercent).toBe(20);
    expect(settings.fulfilmentSlaHours).toBe(24);
    expect(settings.expiryWarningDays).toEqual([7, 1]);
    expect(settings.preHireHorizonDays).toBe(14);
    expect(settings.maxDelegationDays).toBe(90);
    expect(settings.maxApprovers).toBe(10);
    expect(settings.delegatedBulkLimit).toBe(25);
    // The denominator the population-collapse refusal compares against. Null
    // until a sweep has been applied, which is what makes the first sweep in
    // a tenant confirmable rather than measurable.
    expect(settings.lastAppliedSweepAt).toBeNull();
    expect(settings.personsWithActiveContractAtLastSweep).toBeNull();
  });
});

describe('product', () => {
  it('is visible to nobody by default and starts as a draft', async () => {
    const product = await withTenant(tenantId, (tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId } }),
    );
    // NULL means NOBODY. The tempting alternative -- absent means everybody --
    // is an unconfigured control that fails open.
    expect(product.audienceCondition).toBeNull();
    expect(product.status).toBe('draft');
    expect(product.durationMode).toBe('permanent');
  });

  it('refuses a fixed duration with no default number of days', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: { durationMode: 'fixed', defaultDurationDays: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses requesterChoice with no cap', async () => {
    // Without a cap, requesterChoice is `permanent` with extra clicks.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: { durationMode: 'requesterChoice', maxDurationDays: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a default duration longer than the cap', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: {
            durationMode: 'requesterChoice',
            defaultDurationDays: 90,
            maxDurationDays: 30,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an entitlement grant with no target system', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.productGrant.create({
          data: {
            tenantId,
            productId,
            resourceType: 'entitlement',
            resourceId: personId,
            targetSystemId: null,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('approval stage', () => {
  const stage = (over: Record<string, unknown> = {}) => ({
    tenantId,
    workflowId,
    sequence: 1,
    name: 'Manager',
    selector: 'manager',
    fallbackSelector: 'role',
    ...over,
  });

  it('defaults to any quorum and to reminding forever', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.approvalStage.create({ data: stage() }),
    );
    expect(row.quorum).toBe('any');
    // Remind forever. A request never stops asking, and it never approves
    // itself for not having been read.
    expect(row.onTimeout).toBe('remind');
  });

  it('refuses a manager stage with no fallback selector', async () => {
    // manager, managerChain and resourceOwner are the three that legitimately
    // resolve to nobody: a person with no manager, a chain shorter than n, a
    // resource whose owner was never recorded.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({ data: stage({ fallbackSelector: null }) }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an onTimeout value that is not one of the three', async () => {
    // The one that matters is that no fourth value can be inserted. Approval
    // by inattention is a privilege grant nobody made, and this is the
    // structural half of forbidding it.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({ data: stage({ onTimeout: 'approve' }) }),
      ),
    ).rejects.toThrow();
  });

  it('refuses expire with no expiry window and escalate with no target', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({
          data: stage({ onTimeout: 'expire', expiryHours: null }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({
          data: stage({ onTimeout: 'escalate', escalationSelector: null }),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('approval decision', () => {
  let stepId: string;

  beforeEach(async () => {
    stepId = await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          productId,
          subjectPersonId: personId,
          requestedByUserId: personId,
        },
      });
      const step = await tx.approvalStep.create({
        data: { tenantId, requestId: request.id, sequence: 1, stageSnapshot: {} },
      });
      return step.id;
    });
  });

  it('refuses a rejection with no comment, and one with only whitespace', async () => {
    for (const comment of [null, '   ']) {
      await expect(
        withTenant(tenantId, (tx) =>
          tx.approvalDecision.create({
            data: {
              tenantId,
              stepId,
              personId,
              decision: 'reject',
              comment,
              via: 'selector',
            },
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it('accepts an approval with no comment', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: { tenantId, stepId, personId, decision: 'approve', via: 'selector' },
      }),
    );
    expect(row.comment).toBeNull();
  });

  it('is append-only: an update changes nothing and a delete removes nothing', async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: {
          tenantId,
          stepId,
          personId,
          decision: 'reject',
          comment: 'not this quarter',
          via: 'selector',
        },
      }),
    );

    // The rule is DO INSTEAD NOTHING, so neither call raises -- they simply
    // do not happen. Asserting on the row afterwards is the only way to see
    // that, and asserting on a thrown error would pass while the rule was
    // missing.
    await withTenant(tenantId, (tx) =>
      tx.approvalDecision.updateMany({
        where: { id: created.id },
        data: { decision: 'approve', comment: 'changed my mind' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.approvalDecision.deleteMany({ where: { id: created.id } }),
    );

    const after = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.findUnique({ where: { id: created.id } }),
    );
    expect(after?.decision).toBe('reject');
    expect(after?.comment).toBe('not this quarter');
  });
});

describe('access grant', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    tenantId,
    subjectPersonId: personId,
    resourceType: 'application',
    resourceId: productId,
    startsAt: day('2026-06-01'),
    status: 'active',
    ...over,
  });

  it('refuses a second live grant of the same resource to the same person', async () => {
    await withTenant(tenantId, (tx) => tx.accessGrant.create({ data: grant() }));
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessGrant.create({ data: grant({ status: 'pending' }) }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new grant once the old one is no longer live', async () => {
    // This is what an extension does, and a plain unique index over the four
    // columns would forbid it.
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant({ status: 'expired' }) }),
    );
    const replacement = await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant({ startsAt: day('2026-07-01') }) }),
    );
    expect(replacement.status).toBe('active');
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessGrant.create({
          data: grant({ startsAt: day('2026-06-01'), endsAt: day('2026-05-01') }),
        }),
      ),
    ).rejects.toThrow();
  });

  it('starts unflagged for review', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant() }),
    );
    expect(row.needsReview).toBe(false);
    expect(row.reviewReason).toBeNull();
    expect(row.supersededByGrantId).toBeNull();
  });
});

describe('resource delegation', () => {
  it('refuses a capability outside the closed set', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.resourceDelegation.create({
          data: {
            tenantId,
            resourceType: 'group',
            resourceId: productId,
            delegatePersonId: personId,
            capabilities: ['grant', 'delete_group'],
            startsAt: day('2026-06-01'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a delegation naming both a person and a group', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.resourceDelegation.create({
          data: {
            tenantId,
            resourceType: 'group',
            resourceId: productId,
            delegatePersonId: personId,
            delegateGroupId: productId,
            capabilities: ['grant'],
            startsAt: day('2026-06-01'),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('expiry sweep', () => {
  it('refuses a second non-terminal sweep in one tenant', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'previewed' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new sweep once the previous one reached a terminal state', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'applied' } }),
    );
    const next = await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
    );
    expect(next.status).toBe('running');
  });

  it('allows a non-terminal sweep in each of two tenants at once', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
    );
    const other = await withTenant(otherTenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId: otherTenantId, status: 'running' } }),
    );
    expect(other.tenantId).toBe(otherTenantId);
  });
});

describe('the changes to tables other subsystems own', () => {
  it('defaults an entitlement to not requestable', async () => {
    const row = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'target/ad/bind',
          config: {
            url: 'ldaps://dc.acme.test:636',
            tlsMode: 'ldaps',
            bindDn: 'CN=svc,DC=acme,DC=test',
            baseDn: 'DC=acme,DC=test',
          },
        },
      });
      return tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-finance',
          type: 'group',
          displayName: 'Finance',
        },
      });
    });
    // A target's catalog can be published without publishing every group in
    // the domain.
    expect(row.requestable).toBe(false);
  });
});

describe('row-level security', () => {
  it('hides another tenant\'s request, grant and product', async () => {
    await withTenant(otherTenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId: otherTenantId, name: 'Theirs' },
      });
      const product = await tx.product.create({
        data: {
          tenantId: otherTenantId,
          name: 'Theirs',
          slug: 'theirs',
          kind: 'application',
          workflowId: workflow.id,
        },
      });
      const request = await tx.accessRequest.create({
        data: {
          tenantId: otherTenantId,
          productId: product.id,
          subjectPersonId: product.id,
          requestedByUserId: product.id,
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId: otherTenantId,
          subjectPersonId: product.id,
          resourceType: 'application',
          resourceId: product.id,
          requestId: request.id,
          startsAt: day('2026-06-01'),
          status: 'active',
        },
      });
    });

    // Read as the OTHER tenant would, with a query written as badly as
    // possible -- no tenant filter at all. The policy is what makes this
    // empty, not the where clause.
    const seen = await withTenant(tenantId, async (tx) => ({
      products: await tx.product.count({ where: { slug: 'theirs' } }),
      requests: await tx.accessRequest.count(),
      grants: await tx.accessGrant.count(),
    }));
    expect(seen).toEqual({ products: 0, requests: 0, grants: 0 });
  });

  it('refuses to write a row into another tenant', async () => {
    // WITH CHECK, not only USING. Without it, a caller bound to one tenant
    // could insert rows belonging to another and simply never see them again.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalWorkflow.create({
          data: { tenantId: otherTenantId, name: 'Smuggled' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('still has the policy forced against the application role', async () => {
    // A FORCE that was never applied is invisible until the day somebody
    // relies on it. Read the catalogue rather than inferring from behaviour.
    const rows = await prisma.$queryRaw<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relname IN ('AccessRequest', 'AccessGrant', 'ApprovalDecision', 'NotificationOutbox')
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });
});

describe('tamper detection through direct database access', () => {
  it('can be shown to bypass the rule, which is why the audit chain exists', async () => {
    // The rules stop the APPLICATION. A superuser is a different threat and a
    // different control -- recorded here so nobody later reads the append-only
    // rule as protection against database-level compromise.
    const stepId = await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.create({
        data: { tenantId, productId, subjectPersonId: personId, requestedByUserId: personId },
      });
      const step = await tx.approvalStep.create({
        data: { tenantId, requestId: request.id, sequence: 1, stageSnapshot: {} },
      });
      return step.id;
    });
    const created = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: { tenantId, stepId, personId, decision: 'approve', via: 'selector' },
      }),
    );

    await asDatabaseSuperuser('ALTER TABLE "ApprovalDecision" DISABLE RULE approval_decision_no_update');
    try {
      await asDatabaseSuperuser('UPDATE "ApprovalDecision" SET "via" = $1 WHERE id = $2', [
        'administrator',
        created.id,
      ]);
    } finally {
      await asDatabaseSuperuser('ALTER TABLE "ApprovalDecision" ENABLE RULE approval_decision_no_update');
    }

    const after = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(after.via).toBe('administrator');
  });
});
```

- [ ] **Step 11: Run the test**

Run: `pnpm vitest run packages/db/src/automate-schema.test.ts`
Expected: PASS, every case.

- [ ] **Step 12: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. Vitest does not type-check, so a green suite says nothing about this.

- [ ] **Step 13: Commit**

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260821000000_automate_requests \
        packages/db/src/automate-schema.test.ts
git commit -m "feat(automate): request, grant, workflow and sweep data model"
```

---

## Task 2: The shared value types and the audience language

Spec §6. Visibility is an access decision and its default is closed.

**Why this is not a call into `conditionSchema` with three extra fields.** Provision's `ConditionField` is a closed union of seven, and `evaluateCondition` reads its facts off a `ConditionFacts` interface with exactly those keys. Widening that union would let a *business rule* name `user.memberOfGroup`, which Provision has no way to supply — a rule that silently never matches. So the audience language is its own schema over ten fields, and its evaluator **delegates every leaf on one of Provision's seven fields to `evaluateCondition`**. One implementation of the trimmed, case-insensitive string comparison; one implementation of the numeric `fte` comparison; one implementation of `isEmpty` catching both null and `''`. The three new fields are set-membership over lists, which those operators do not describe, so they are evaluated here — deliberately, and with the operator set restricted to the four that mean something over a list.

**Files:**
- Create: `packages/core/src/automate/types.ts`
- Create: `packages/core/src/automate/audience.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/audience.test.ts`

**Interfaces:**
- Consumes: `evaluateCondition`, `type Condition`, `type ConditionFacts`, `type ConditionOperator` from `../provision/condition.js` (Provision Task 5); `z` from `zod`.
- Produces (in `./types.js`):
  - `type ProductKind = 'targetEntitlement' | 'application' | 'localGroup'`
  - `type ResourceType = 'entitlement' | 'application' | 'group'`
  - `type RequestStatus = 'pending_approval' | 'blocked_no_approver' | 'approved' | 'awaiting_fulfilment' | 'fulfilled' | 'partially_fulfilled' | 'fulfilment_failed' | 'rejected' | 'cancelled' | 'expired'`
  - `type RequestItemStatus = 'pending' | 'dispatched' | 'fulfilled' | 'failed' | 'skipped'`
  - `type GrantStatus = 'scheduled' | 'pending' | 'active' | 'expired' | 'lapsed' | 'revoked'`
  - `type StepStatus = 'waiting' | 'open' | 'approved' | 'rejected' | 'skipped'`
  - `type ApproverVia = 'selector' | 'delegate' | 'escalation' | 'fallback' | 'administrator'`
  - `type SweepActionKind = 'expire' | 'lapse'`
  - `type RefusalReason = 'not_visible' | 'no_longer_eligible' | 'subject_departed' | 'subject_inactive' | 'already_held' | 'product_withdrawn' | 'no_user_account' | 'invalid_form' | 'duration_not_permitted' | 'not_permitted_on_behalf' | 'workflow_disabled'`
  - `const LIVE_GRANT_STATUSES: readonly GrantStatus[]` — `['scheduled','pending','active']`, the four-column partial unique index's predicate, in one place
  - `const IN_FORCE_GRANT_STATUSES: readonly GrantStatus[]` — `['pending','active']`, the ones desired state includes
  - `const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[]`
- Produces (in `./audience.js`):
  - `type AudienceField = 'contract.department' | 'contract.jobTitle' | 'contract.costCentre' | 'contract.employer' | 'contract.location' | 'contract.fte' | 'person.status' | 'user.memberOfGroup' | 'user.orgUnit' | 'person.hasEntitlement'`
  - `const CONTRACT_AUDIENCE_FIELDS: readonly AudienceField[]` — the seven Provision already evaluates
  - `const SET_AUDIENCE_FIELDS: readonly AudienceField[]` — the three this slice adds
  - `type AudienceCondition = { all: AudienceCondition[] } | { any: AudienceCondition[] } | { not: AudienceCondition } | { field: AudienceField; op: ConditionOperator; value?: string | number | string[] }`
  - `const audienceConditionSchema: z.ZodType<AudienceCondition>`
  - `interface SubjectSetFacts { groupIds: readonly string[]; orgUnitChainIds: readonly string[]; entitlementIds: readonly string[] }`
  - `interface AudienceFacts extends SubjectSetFacts { contract: ConditionFacts }`
  - `function evaluateAudience(condition: AudienceCondition, facts: AudienceFacts): boolean`
  - `function audienceAdmits(condition: AudienceCondition | null, contracts: readonly ConditionFacts[], sets: SubjectSetFacts): boolean`

- [ ] **Step 1: Write the shared value types**

`packages/core/src/automate/types.ts`:

```ts
/**
 * The unions every Automate module speaks, in one place, so that a status
 * string is spelled the same way in the schema, the service, the API and the
 * console. These mirror the check constraints in
 * `20260821000000_automate_requests` exactly; if one moves, both move.
 */

export type ProductKind = 'targetEntitlement' | 'application' | 'localGroup';

export type ResourceType = 'entitlement' | 'application' | 'group';

/** Which resource type a product of each kind grants. */
export const RESOURCE_TYPE_FOR_KIND: Record<ProductKind, ResourceType> = {
  targetEntitlement: 'entitlement',
  application: 'application',
  localGroup: 'group',
};

export type RequestStatus =
  | 'pending_approval'
  | 'blocked_no_approver'
  | 'approved'
  | 'awaiting_fulfilment'
  | 'fulfilled'
  /**
   * TERMINAL. Every item reached a terminal state, some landed and some did
   * not, and the request names which. A request with items still in flight is
   * `awaiting_fulfilment`, never this.
   */
  | 'partially_fulfilled'
  | 'fulfilment_failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type RequestItemStatus =
  | 'pending'
  | 'dispatched'
  | 'fulfilled'
  | 'failed'
  | 'skipped';

export type GrantStatus =
  | 'scheduled'
  | 'pending'
  | 'active'
  | 'expired'
  | 'lapsed'
  | 'revoked';

export type StepStatus = 'waiting' | 'open' | 'approved' | 'rejected' | 'skipped';

export type ApproverVia =
  | 'selector'
  | 'delegate'
  | 'escalation'
  | 'fallback'
  | 'administrator';

export type SweepActionKind = 'expire' | 'lapse';

export type RefusalReason =
  | 'not_visible'
  | 'no_longer_eligible'
  | 'subject_departed'
  | 'subject_inactive'
  | 'already_held'
  | 'product_withdrawn'
  | 'no_user_account'
  | 'invalid_form'
  | 'duration_not_permitted'
  | 'not_permitted_on_behalf'
  | 'workflow_disabled';

/**
 * A grant that occupies the one-live-grant slot. The same predicate as the
 * `access_grant_one_live` partial unique index, written once so the query and
 * the constraint cannot drift apart.
 */
export const LIVE_GRANT_STATUSES: readonly GrantStatus[] = [
  'scheduled',
  'pending',
  'active',
];

/**
 * The grants desired state includes: those whose window covers now.
 * `scheduled` is deliberately absent -- a scheduled grant is visible in the
 * console, says when it starts, and confers NOTHING until it does.
 */
export const IN_FORCE_GRANT_STATUSES: readonly GrantStatus[] = ['pending', 'active'];

export const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
  'fulfilled',
  'partially_fulfilled',
  'fulfilment_failed',
  'rejected',
  'cancelled',
  'expired',
];
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/automate/audience.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  audienceAdmits,
  audienceConditionSchema,
  evaluateAudience,
  type AudienceCondition,
  type AudienceFacts,
} from './audience.js';
import type { ConditionFacts } from '../provision/condition.js';

const contract = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': 'Analyst',
  'contract.costCentre': 'CC-100',
  'contract.employer': 'Acme Care',
  'contract.location': 'Utrecht',
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

const facts = (over: Partial<AudienceFacts> = {}): AudienceFacts => ({
  contract: contract(),
  groupIds: ['group-finance'],
  orgUnitChainIds: ['ou-finance', 'ou-head-office'],
  entitlementIds: ['ent-base-licence'],
  ...over,
});

describe('evaluateAudience — the seven fields Provision already knows', () => {
  it('delegates a contract leaf to the shared evaluator, trimming and folding case', () => {
    // Not reimplemented here. The expression that decides who SEES a product
    // and the one that decides who GETS birthright access compare strings the
    // same way, or a tenant learns two languages.
    const condition: AudienceCondition = {
      field: 'contract.department',
      op: 'equals',
      value: 'finance',
    };
    expect(evaluateAudience(condition, facts())).toBe(true);
    expect(
      evaluateAudience(
        condition,
        facts({ contract: contract({ 'contract.department': '  FINANCE  ' }) }),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        condition,
        facts({ contract: contract({ 'contract.department': 'Facilities' }) }),
      ),
    ).toBe(false);
  });

  it('compares fte numerically through the shared evaluator', () => {
    expect(
      evaluateAudience(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ contract: contract({ 'contract.fte': 0.4 }) }),
      ),
    ).toBe(true);
  });
});

describe('evaluateAudience — the three fields the catalog adds', () => {
  it('matches a group the subject belongs to, and does not match one they do not', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-finance' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-payroll' },
        facts(),
      ),
    ).toBe(false);
  });

  it('matches an org unit above the subject, not only their own', () => {
    // An assignment on Head Office reaches everyone under it; that is what
    // makes the tree worth having. The chain is supplied already walked.
    expect(
      evaluateAudience(
        { field: 'user.orgUnit', op: 'equals', value: 'ou-head-office' },
        facts(),
      ),
    ).toBe(true);
  });

  it('matches an entitlement the subject already holds', () => {
    // The common real case: a product that only makes sense to somebody who
    // already holds the base licence. Without it, tenants express that as a
    // department list that drifts.
    expect(
      evaluateAudience(
        { field: 'person.hasEntitlement', op: 'equals', value: 'ent-base-licence' },
        facts(),
      ),
    ).toBe(true);
  });

  it('reads in as any-of and notIn as none-of over the whole set', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'in', value: ['group-payroll', 'group-finance'] },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'notIn', value: ['group-finance'] },
        facts(),
      ),
    ).toBe(false);
    expect(
      evaluateAudience(
        { field: 'person.hasEntitlement', op: 'notEquals', value: 'ent-other' },
        facts(),
      ),
    ).toBe(true);
  });

  it('does not match a set field against an empty set', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-finance' },
        facts({ groupIds: [] }),
      ),
    ).toBe(false);
    // notEquals over an empty set is vacuously true: the subject is in no
    // group, so they are in no group named here.
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'notEquals', value: 'group-finance' },
        facts({ groupIds: [] }),
      ),
    ).toBe(true);
  });
});

describe('evaluateAudience — combinators', () => {
  it('treats an empty all as true and an empty any as false', () => {
    // `{ all: [] }` is how a product genuinely meant for everybody says so.
    // It is a deliberate keystroke, not an omission.
    expect(evaluateAudience({ all: [] }, facts())).toBe(true);
    expect(evaluateAudience({ any: [] }, facts())).toBe(false);
  });

  it('mixes contract fields and set fields inside one expression', () => {
    const condition: AudienceCondition = {
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { field: 'person.hasEntitlement', op: 'equals', value: 'ent-base-licence' },
        { not: { field: 'user.memberOfGroup', op: 'equals', value: 'group-contractors' } },
      ],
    };
    expect(evaluateAudience(condition, facts())).toBe(true);
    expect(
      evaluateAudience(condition, facts({ groupIds: ['group-contractors'] })),
    ).toBe(false);
  });
});

describe('audienceAdmits', () => {
  const sets = { groupIds: ['group-finance'], orgUnitChainIds: [], entitlementIds: [] };

  it('admits nobody when the condition is null', () => {
    // THE security default of this slice. An unconfigured access control
    // reads as "nobody", and a catalog listing things you may not have
    // describes the organization to you.
    expect(audienceAdmits(null, [contract()], sets)).toBe(false);
    // Not even with `{ all: [] }`-shaped facts, and not even for somebody who
    // would match everything. Null is null.
    expect(audienceAdmits(null, [contract(), contract()], sets)).toBe(false);
  });

  it('admits anybody with an active contract when the condition is an empty all', () => {
    expect(audienceAdmits({ all: [] }, [contract()], sets)).toBe(true);
  });

  it('admits nobody with no active contracts, even for an empty all', () => {
    // "Any of the person's currently ACTIVE contracts satisfies it" is
    // vacuously false when there are none. A leaver does not keep seeing the
    // catalog because the condition was permissive.
    expect(audienceAdmits({ all: [] }, [], sets)).toBe(false);
  });

  it('admits when ANY active contract satisfies the condition', () => {
    const condition: AudienceCondition = {
      field: 'contract.department',
      op: 'equals',
      value: 'Facilities',
    };
    expect(
      audienceAdmits(
        condition,
        [contract(), contract({ 'contract.department': 'Facilities' })],
        sets,
      ),
    ).toBe(true);
  });
});

describe('audienceConditionSchema', () => {
  it('accepts every one of the ten fields', () => {
    for (const field of [
      'contract.department',
      'contract.jobTitle',
      'contract.costCentre',
      'contract.employer',
      'contract.location',
      'contract.fte',
      'person.status',
      'user.memberOfGroup',
      'user.orgUnit',
      'person.hasEntitlement',
    ]) {
      expect(
        audienceConditionSchema.safeParse({ field, op: 'equals', value: 'x' }).success,
      ).toBe(true);
    }
  });

  it('refuses a field outside the closed set', () => {
    expect(
      audienceConditionSchema.safeParse({
        field: 'person.salary',
        op: 'greaterThan',
        value: 100000,
      }).success,
    ).toBe(false);
  });

  it('refuses an operator that means nothing over a set field', () => {
    // `startsWith` over a list of opaque ids would match on a prefix of a
    // UUID, which is a coincidence rather than a rule.
    expect(
      audienceConditionSchema.safeParse({
        field: 'user.memberOfGroup',
        op: 'startsWith',
        value: 'group-',
      }).success,
    ).toBe(false);
  });

  it('refuses a leaf with no value where the operator needs one', () => {
    expect(
      audienceConditionSchema.safeParse({ field: 'contract.department', op: 'equals' })
        .success,
    ).toBe(false);
    expect(
      audienceConditionSchema.safeParse({ field: 'contract.department', op: 'isEmpty' })
        .success,
    ).toBe(true);
  });

  it('parses a nested expression to the same shape it was given', () => {
    const condition = {
      any: [
        { all: [{ field: 'contract.location', op: 'in', value: ['Utrecht', 'Delft'] }] },
        { not: { field: 'person.status', op: 'equals', value: 'inactive' } },
      ],
    };
    expect(audienceConditionSchema.parse(condition)).toEqual(condition);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/audience.test.ts`
Expected: FAIL, "Failed to resolve import ./audience.js".

- [ ] **Step 4: Write the audience language**

`packages/core/src/automate/audience.ts`:

```ts
import { z } from 'zod';
import {
  evaluateCondition,
  type Condition,
  type ConditionFacts,
  type ConditionOperator,
} from '../provision/condition.js';

/**
 * The audience field set: Provision's seven, plus the three the catalog
 * needs.
 *
 * Provision's `ConditionField` is deliberately NOT widened to include these.
 * A business rule naming `user.memberOfGroup` would be a rule Provision has no
 * facts to evaluate -- it would parse, save, and then silently never match,
 * which is the worst of the three possible behaviours.
 */
export type AudienceField =
  | 'contract.department'
  | 'contract.jobTitle'
  | 'contract.costCentre'
  | 'contract.employer'
  | 'contract.location'
  | 'contract.fte'
  | 'person.status'
  | 'user.memberOfGroup'
  | 'user.orgUnit'
  | 'person.hasEntitlement';

/** The seven `evaluateCondition` already knows how to answer. */
export const CONTRACT_AUDIENCE_FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
] as const satisfies readonly AudienceField[];

/**
 * The three this slice adds. Each is set membership over a list of opaque
 * identifiers, which is why only four operators are permitted over them.
 */
export const SET_AUDIENCE_FIELDS = [
  'user.memberOfGroup',
  'user.orgUnit',
  'person.hasEntitlement',
] as const satisfies readonly AudienceField[];

const SET_OPERATORS = ['equals', 'notEquals', 'in', 'notIn'] as const;
type SetOperator = (typeof SET_OPERATORS)[number];

const VALUELESS_OPERATORS = ['isEmpty', 'isNotEmpty'] as const;

export type AudienceCondition =
  | { all: AudienceCondition[] }
  | { any: AudienceCondition[] }
  | { not: AudienceCondition }
  | { field: AudienceField; op: ConditionOperator; value?: string | number | string[] };

const isSetField = (field: AudienceField): boolean =>
  (SET_AUDIENCE_FIELDS as readonly string[]).includes(field);

const leafSchema = z
  .object({
    field: z.enum([
      'contract.department',
      'contract.jobTitle',
      'contract.costCentre',
      'contract.employer',
      'contract.location',
      'contract.fte',
      'person.status',
      'user.memberOfGroup',
      'user.orgUnit',
      'person.hasEntitlement',
    ]),
    op: z.enum([
      'equals',
      'notEquals',
      'in',
      'notIn',
      'startsWith',
      'contains',
      'isEmpty',
      'isNotEmpty',
      'greaterThan',
      'lessThan',
    ]),
    value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  })
  .superRefine((leaf, ctx) => {
    const needsValue = !(VALUELESS_OPERATORS as readonly string[]).includes(leaf.op);
    if (needsValue && leaf.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${leaf.op} needs a value`,
      });
    }
    if (!needsValue && leaf.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${leaf.op} takes no value`,
      });
    }
    // A prefix match over a list of opaque identifiers matches on a
    // coincidence rather than a rule, and a numeric comparison over one is
    // meaningless. Refused at save time so nobody has to discover it from a
    // product that is visible to nobody for no stated reason.
    if (isSetField(leaf.field) && !(SET_OPERATORS as readonly string[]).includes(leaf.op)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['op'],
        message: `${leaf.field} accepts only ${SET_OPERATORS.join(', ')}`,
      });
    }
  });

/**
 * Recursive, so the schema is declared lazily and typed explicitly. The cast
 * is the one zod requires for a self-referential union; it is the same shape
 * `conditionSchema` uses in `provision/condition.ts`.
 */
export const audienceConditionSchema: z.ZodType<AudienceCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(audienceConditionSchema) }).strict(),
    z.object({ any: z.array(audienceConditionSchema) }).strict(),
    z.object({ not: audienceConditionSchema }).strict(),
    leafSchema,
  ]),
) as z.ZodType<AudienceCondition>;

export interface SubjectSetFacts {
  /** Every group the subject's user accounts belong to. */
  groupIds: readonly string[];
  /** The subject's org unit and every unit above it, already walked. */
  orgUnitChainIds: readonly string[];
  /** Entitlements the subject already holds, by any origin. */
  entitlementIds: readonly string[];
}

export interface AudienceFacts extends SubjectSetFacts {
  /** One contract's worth of facts, in the shape Provision's evaluator reads. */
  contract: ConditionFacts;
}

function setFor(field: AudienceField, facts: AudienceFacts): readonly string[] {
  if (field === 'user.memberOfGroup') return facts.groupIds;
  if (field === 'user.orgUnit') return facts.orgUnitChainIds;
  return facts.entitlementIds;
}

function evaluateSetLeaf(
  field: AudienceField,
  op: SetOperator,
  value: string | number | string[] | undefined,
  facts: AudienceFacts,
): boolean {
  const held = new Set(setFor(field, facts));
  const wanted = (Array.isArray(value) ? value : [String(value ?? '')]).map((v) =>
    v.trim(),
  );
  const anyHeld = wanted.some((v) => held.has(v));
  return op === 'equals' || op === 'in' ? anyHeld : !anyHeld;
}

/**
 * Evaluates one expression against one contract's worth of facts.
 *
 * Every leaf on one of Provision's seven fields is handed to
 * `evaluateCondition` unchanged. That is the point: the trimmed
 * case-insensitive comparison, the null handling, the empty-string handling
 * and the numeric `fte` path have exactly one implementation and exactly one
 * test suite, and a tenant learns one language.
 */
export function evaluateAudience(
  condition: AudienceCondition,
  facts: AudienceFacts,
): boolean {
  if ('all' in condition) {
    return condition.all.every((child) => evaluateAudience(child, facts));
  }
  if ('any' in condition) {
    return condition.any.some((child) => evaluateAudience(child, facts));
  }
  if ('not' in condition) {
    return !evaluateAudience(condition.not, facts);
  }

  if (isSetField(condition.field)) {
    return evaluateSetLeaf(
      condition.field,
      condition.op as SetOperator,
      condition.value,
      facts,
    );
  }

  // Narrowed by the branch above: what remains is one of the seven, which is
  // exactly `Condition`'s leaf shape.
  return evaluateCondition(condition as Condition, facts.contract);
}

/**
 * Whether a product's audience admits a person.
 *
 * A null condition admits NOBODY. This is the security default of the whole
 * catalog and it is written here, once, rather than at each of the seven read
 * paths -- a default applied by six of seven callers is not a default.
 *
 * A person with no active contracts is admitted by nothing, including
 * `{ all: [] }`: the rule is "any of the person's currently active contracts
 * satisfies it", and there are none to satisfy it.
 */
export function audienceAdmits(
  condition: AudienceCondition | null,
  contracts: readonly ConditionFacts[],
  sets: SubjectSetFacts,
): boolean {
  if (condition === null) return false;
  return contracts.some((contract) => evaluateAudience(condition, { ...sets, contract }));
}
```

- [ ] **Step 5: Export both modules from the package**

In `packages/core/src/index.ts`, after the `provision/` export lines, add:

```ts
export * from './automate/types.js';
export * from './automate/audience.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/automate/audience.test.ts`
Expected: PASS, every case.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/automate/types.ts \
        packages/core/src/automate/audience.ts \
        packages/core/src/automate/audience.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): the audience language, closed by default"
```

---

## Task 3: The request form and the duration arithmetic

Spec §6's form schema and §12's durations. Both pure, both full of boundaries, and the second is where a naive implementation produces an outage.

**Files:**
- Create: `packages/core/src/automate/form.ts`
- Create: `packages/core/src/automate/duration.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/form.test.ts`, `packages/core/src/automate/duration.test.ts`

**Interfaces:**
- Consumes: `z` from `zod`; `addDays` from `../provision/plan.js` (Provision Task 9). **`addDays` is imported, not redefined.** `packages/core/src/index.ts` re-exports both modules with `export *`, and two modules exporting `addDays` is an ambiguous re-export that fails the build.
- Produces (in `./form.js`):
  - `type FormFieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'date' | 'number' | 'checkbox' | 'resourcePicker'`
  - `interface FormField { key: string; type: FormFieldType; label: string; help?: string; required: boolean; options?: { value: string; label: string }[]; min?: number; max?: number; maxLength?: number }`
  - `type FormSchema = FormField[]`
  - `const formSchemaSchema: z.ZodType<FormSchema>`
  - `type FormValidation = { ok: true; values: Record<string, string | number | boolean | string[]> } | { ok: false; errors: { path: string; message: string }[] }`
  - `function validateFormValues(schema: FormSchema, values: unknown, selectableResourceIds: readonly string[]): FormValidation`
- Produces (in `./duration.js`):
  - `type DurationMode = 'permanent' | 'fixed' | 'requesterChoice'`
  - `interface DurationPolicy { durationMode: DurationMode; defaultDurationDays: number | null; maxDurationDays: number | null }`
  - `type DurationOutcome = { ok: true; days: number | null } | { ok: false; message: string }`
  - `function resolveRequestedDuration(policy: DurationPolicy, requestedDays: number | null): DurationOutcome`
  - `function applyShortening(days: number | null, shortenedToDays: number | null): DurationOutcome`
  - `interface GrantWindowInput { now: Date; days: number | null; requestedStartsAt: Date | null; earliestContractStart: Date | null }`
  - `function grantWindow(input: GrantWindowInput): { startsAt: Date; endsAt: Date | null; scheduled: boolean }`
  - `function grantInForce(grant: { startsAt: Date; endsAt: Date | null }, now: Date): boolean`

- [ ] **Step 1: Write the failing form test**

`packages/core/src/automate/form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formSchemaSchema, validateFormValues, type FormSchema } from './form.js';

const schema: FormSchema = [
  { key: 'reason', type: 'text', label: 'What is it for', required: true, maxLength: 200 },
  { key: 'seats', type: 'number', label: 'Seats', required: false, min: 1, max: 10 },
  {
    key: 'tier',
    type: 'select',
    label: 'Tier',
    required: true,
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'premium', label: 'Premium' },
    ],
  },
  { key: 'mailbox', type: 'resourcePicker', label: 'Which mailbox', required: true },
];

const RESOURCES = ['res-a', 'res-b'];

describe('validateFormValues', () => {
  it('accepts a complete, well-typed submission and returns the coerced values', () => {
    const result = validateFormValues(
      schema,
      { reason: 'Q3 audit', seats: 3, tier: 'standard', mailbox: 'res-b' },
      RESOURCES,
    );
    expect(result).toEqual({
      ok: true,
      values: { reason: 'Q3 audit', seats: 3, tier: 'standard', mailbox: 'res-b' },
    });
  });

  it('names the field that is missing rather than saying the form is invalid', () => {
    const result = validateFormValues(schema, { tier: 'standard', mailbox: 'res-a' }, RESOURCES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual({ path: 'reason', message: 'This is required' });
  });

  it('refuses a select value that is not one of the declared options', () => {
    // The options are a closed list on the schema. A value outside it means
    // the submission did not come from the form the product published.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'enterprise', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.map((e) => e.path)).toContain('tier');
  });

  it('refuses a resourcePicker value that is not one of the product own grants', () => {
    // This is the one field whose options come from the product rather than
    // the schema, and it is the one an attacker would try to widen: naming a
    // resource the product does not grant would make the request grant it.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'standard', mailbox: 'res-somebody-elses' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual({
      path: 'mailbox',
      message: 'Choose one of the resources this product grants',
    });
  });

  it('enforces numeric bounds and string length', () => {
    const tooMany = validateFormValues(
      schema,
      { reason: 'x', seats: 40, tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(tooMany.ok).toBe(false);
    const tooLong = validateFormValues(
      schema,
      { reason: 'x'.repeat(201), tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(tooLong.ok).toBe(false);
  });

  it('drops a value for a key the schema does not declare', () => {
    // Not an error -- a stale browser tab holding a previous version of the
    // form is ordinary -- but it must not reach the stored formValues, or the
    // request records an answer to a question nobody asked.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'standard', mailbox: 'res-a', smuggled: 'admin' },
      RESOURCES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.values).not.toHaveProperty('smuggled');
  });

  it('treats an empty string as absent for a required field', () => {
    const result = validateFormValues(
      schema,
      { reason: '   ', tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
  });
});

describe('formSchemaSchema', () => {
  it('accepts the eight field types and refuses a ninth', () => {
    for (const type of [
      'text',
      'textarea',
      'select',
      'multiselect',
      'date',
      'number',
      'checkbox',
      'resourcePicker',
    ]) {
      const field = {
        key: 'k',
        type,
        label: 'L',
        required: false,
        ...(type === 'select' || type === 'multiselect'
          ? { options: [{ value: 'a', label: 'A' }] }
          : {}),
      };
      expect(formSchemaSchema.safeParse([field]).success).toBe(true);
    }
    expect(
      formSchemaSchema.safeParse([{ key: 'k', type: 'script', label: 'L', required: false }])
        .success,
    ).toBe(false);
  });

  it('refuses a select with no options', () => {
    // A select nobody can answer makes a required field unsatisfiable, which
    // is a product that cannot be requested at all.
    expect(
      formSchemaSchema.safeParse([
        { key: 'k', type: 'select', label: 'L', required: true, options: [] },
      ]).success,
    ).toBe(false);
  });

  it('refuses two fields with the same key', () => {
    expect(
      formSchemaSchema.safeParse([
        { key: 'k', type: 'text', label: 'One', required: false },
        { key: 'k', type: 'text', label: 'Two', required: false },
      ]).success,
    ).toBe(false);
  });

  it('refuses a key that is one of the two implicit fields', () => {
    // `justification` and `duration` are implicit on every form and are NOT
    // part of the schema. A schema field of the same name would either shadow
    // the real one or be silently overwritten by it.
    for (const key of ['justification', 'duration']) {
      expect(
        formSchemaSchema.safeParse([{ key, type: 'text', label: 'L', required: false }])
          .success,
      ).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Write the failing duration test**

`packages/core/src/automate/duration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyShortening,
  grantInForce,
  grantWindow,
  resolveRequestedDuration,
  type DurationPolicy,
} from './duration.js';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = day('2026-06-15');

const policy = (over: Partial<DurationPolicy> = {}): DurationPolicy => ({
  durationMode: 'requesterChoice',
  defaultDurationDays: 30,
  maxDurationDays: 90,
  ...over,
});

describe('resolveRequestedDuration', () => {
  it('gives a permanent product no end date, whatever the requester asked for', () => {
    expect(
      resolveRequestedDuration(
        policy({ durationMode: 'permanent', defaultDurationDays: null, maxDurationDays: null }),
        365,
      ),
    ).toEqual({ ok: true, days: null });
  });

  it('gives a fixed product its own number of days, ignoring the request', () => {
    expect(
      resolveRequestedDuration(
        policy({ durationMode: 'fixed', defaultDurationDays: 14, maxDurationDays: null }),
        90,
      ),
    ).toEqual({ ok: true, days: 14 });
  });

  it('defaults requesterChoice to the product default when nothing was asked', () => {
    expect(resolveRequestedDuration(policy(), null)).toEqual({ ok: true, days: 30 });
  });

  it('accepts exactly the cap and refuses one day beyond it', () => {
    // The boundary, both sides. `maxDurationDays` is validated on the form and
    // AGAIN at submission, and a form is not a control.
    expect(resolveRequestedDuration(policy(), 90)).toEqual({ ok: true, days: 90 });
    const over = resolveRequestedDuration(policy(), 91);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('unreachable');
    expect(over.message).toContain('90');
  });

  it('refuses zero, a negative, and a fraction', () => {
    for (const days of [0, -1, 1.5]) {
      expect(resolveRequestedDuration(policy(), days).ok).toBe(false);
    }
  });
});

describe('applyShortening', () => {
  it('lets an approver shorten', () => {
    // A manager who will allow three weeks but not three months should be
    // able to say so without a rejection and a resubmission.
    expect(applyShortening(90, 21)).toEqual({ ok: true, days: 21 });
  });

  it('refuses to lengthen', () => {
    const result = applyShortening(21, 90);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('shorten');
  });

  it('refuses to put an end date on a permanent grant', () => {
    // Shortening `null` is not lengthening, but it changes the product's own
    // durationMode after the fact, which is a decision the catalog makes and
    // not one an approver does. Refused rather than silently honoured.
    expect(applyShortening(null, 30).ok).toBe(false);
  });

  it('is a no-op when the approver shortened nothing', () => {
    expect(applyShortening(30, null)).toEqual({ ok: true, days: 30 });
    expect(applyShortening(null, null)).toEqual({ ok: true, days: null });
  });
});

describe('grantWindow', () => {
  it('starts now and ends the requested number of days later', () => {
    expect(
      grantWindow({ now: NOW, days: 30, requestedStartsAt: null, earliestContractStart: null }),
    ).toEqual({ startsAt: NOW, endsAt: day('2026-07-15'), scheduled: false });
  });

  it('has no end date for a permanent grant', () => {
    expect(
      grantWindow({ now: NOW, days: null, requestedStartsAt: null, earliestContractStart: null }),
    ).toEqual({ startsAt: NOW, endsAt: null, scheduled: false });
  });

  it('schedules from a future contract start, and measures the duration from there', () => {
    // The pre-hire. The grant confers nothing until the day, and its thirty
    // days are thirty days of employment rather than thirty days of waiting.
    expect(
      grantWindow({
        now: NOW,
        days: 30,
        requestedStartsAt: null,
        earliestContractStart: day('2026-07-01'),
      }),
    ).toEqual({ startsAt: day('2026-07-01'), endsAt: day('2026-07-31'), scheduled: true });
  });

  it('ignores a contract start in the past', () => {
    expect(
      grantWindow({
        now: NOW,
        days: 7,
        requestedStartsAt: null,
        earliestContractStart: day('2020-01-01'),
      }).startsAt,
    ).toEqual(NOW);
  });

  it('takes the later of a requested start and a future contract start', () => {
    expect(
      grantWindow({
        now: NOW,
        days: null,
        requestedStartsAt: day('2026-08-01'),
        earliestContractStart: day('2026-07-01'),
      }).startsAt,
    ).toEqual(day('2026-08-01'));
  });
});

describe('grantInForce', () => {
  const grant = { startsAt: day('2026-06-01'), endsAt: day('2026-06-15') };

  it('is in force the day before the end date', () => {
    expect(grantInForce(grant, day('2026-06-14'))).toBe(true);
  });

  it('is in force at the instant of the end date and not after it', () => {
    // The boundary that decides whether the sweep removes it tonight or
    // tomorrow night. `endsAt` is the moment access stops, so the instant
    // itself is out.
    expect(grantInForce(grant, day('2026-06-15'))).toBe(false);
    expect(grantInForce(grant, new Date('2026-06-14T23:59:59Z'))).toBe(true);
  });

  it('is not in force before it starts', () => {
    // A scheduled grant never confers access before its start date.
    expect(grantInForce(grant, day('2026-05-31'))).toBe(false);
    expect(grantInForce(grant, day('2026-06-01'))).toBe(true);
  });

  it('never ends when there is no end date', () => {
    expect(grantInForce({ startsAt: day('2020-01-01'), endsAt: null }, NOW)).toBe(true);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm vitest run packages/core/src/automate/form.test.ts packages/core/src/automate/duration.test.ts`
Expected: FAIL, "Failed to resolve import" for both.

- [ ] **Step 4: Write the form module**

`packages/core/src/automate/form.ts`:

```ts
import { z } from 'zod';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'number'
  | 'checkbox'
  /** Choose among the product's own ProductGrant rows. */
  | 'resourcePicker';

export interface FormField {
  key: string;
  type: FormFieldType;
  label: string;
  help?: string;
  required: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export type FormSchema = FormField[];

/**
 * Two keys are implicit on every form and are not part of the schema:
 * `justification` (required whenever the workflow has at least one stage) and
 * `duration` (shown only under requesterChoice). A schema field of either
 * name would either shadow the real one or be silently overwritten by it.
 */
const RESERVED_KEYS = ['justification', 'duration'];

const fieldSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores'),
    type: z.enum([
      'text',
      'textarea',
      'select',
      'multiselect',
      'date',
      'number',
      'checkbox',
      'resourcePicker',
    ]),
    label: z.string().min(1).max(200),
    help: z.string().max(500).optional(),
    required: z.boolean(),
    options: z
      .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(200) }))
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().int().positive().max(10000).optional(),
  })
  .superRefine((field, ctx) => {
    if (RESERVED_KEYS.includes(field.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key'],
        message: `${field.key} is added to every form automatically`,
      });
    }
    const needsOptions = field.type === 'select' || field.type === 'multiselect';
    if (needsOptions && (field.options === undefined || field.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A select needs at least one option',
      });
    }
  });

export const formSchemaSchema: z.ZodType<FormSchema> = z
  .array(fieldSchema)
  .max(40)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['key'],
          message: `Two fields both named ${field.key}`,
        });
      }
      seen.add(field.key);
    }
  }) as z.ZodType<FormSchema>;

export type FormValidation =
  | { ok: true; values: Record<string, string | number | boolean | string[]> }
  | { ok: false; errors: { path: string; message: string }[] };

const absent = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/**
 * Validates a submission against the schema the product published.
 *
 * Run at save time on the schema and again here on the values. A field the
 * schema does not declare is DROPPED rather than rejected -- a stale browser
 * tab is ordinary -- but it never reaches the stored `formValues`, or the
 * request records an answer to a question nobody asked.
 *
 * `selectableResourceIds` is the product's own ProductGrant ids. It is the one
 * option list that does not live on the schema, and it is the one an attacker
 * would try to widen: a `resourcePicker` naming a resource the product does
 * not grant would make the request grant it.
 */
export function validateFormValues(
  schema: FormSchema,
  values: unknown,
  selectableResourceIds: readonly string[],
): FormValidation {
  const input: Record<string, unknown> =
    typeof values === 'object' && values !== null && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : {};

  const errors: { path: string; message: string }[] = [];
  const out: Record<string, string | number | boolean | string[]> = {};
  const fail = (path: string, message: string) => errors.push({ path, message });

  for (const field of schema) {
    const raw = input[field.key];

    if (absent(raw)) {
      if (field.required) fail(field.key, 'This is required');
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof raw !== 'string') {
          fail(field.key, 'Expected text');
          break;
        }
        const trimmed = raw.trim();
        if (trimmed.length > (field.maxLength ?? 2000)) {
          fail(field.key, `Keep this under ${field.maxLength ?? 2000} characters`);
          break;
        }
        out[field.key] = trimmed;
        break;
      }
      case 'date': {
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
          fail(field.key, 'Expected a date');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          fail(field.key, 'Expected a number');
          break;
        }
        if (field.min !== undefined && raw < field.min) {
          fail(field.key, `Must be at least ${field.min}`);
          break;
        }
        if (field.max !== undefined && raw > field.max) {
          fail(field.key, `Must be at most ${field.max}`);
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'checkbox': {
        if (typeof raw !== 'boolean') {
          fail(field.key, 'Expected yes or no');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'select': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (typeof raw !== 'string' || !allowed.includes(raw)) {
          fail(field.key, 'Choose one of the offered options');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'multiselect': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !allowed.includes(v))) {
          fail(field.key, 'Choose from the offered options');
          break;
        }
        out[field.key] = raw as string[];
        break;
      }
      case 'resourcePicker': {
        if (typeof raw !== 'string' || !selectableResourceIds.includes(raw)) {
          fail(field.key, 'Choose one of the resources this product grants');
          break;
        }
        out[field.key] = raw;
        break;
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out };
}
```

- [ ] **Step 5: Write the duration module**

`packages/core/src/automate/duration.ts`:

```ts
// `addDays` comes from Provision's planner, which already owns the one
// implementation of date arithmetic in this codebase. Redefining it here
// would give `packages/core/src/index.ts` two `addDays` exports, which is an
// ambiguous re-export and a build error -- and, worse, two implementations of
// month-boundary arithmetic to keep in agreement.
import { addDays } from '../provision/plan.js';

export type DurationMode = 'permanent' | 'fixed' | 'requesterChoice';

export interface DurationPolicy {
  durationMode: DurationMode;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
}

export type DurationOutcome =
  | { ok: true; days: number | null }
  | { ok: false; message: string };

/**
 * What duration a submission actually gets.
 *
 * `permanent` ignores the request entirely -- there is no end date to argue
 * about. `fixed` ignores it too, because the product decided. Only
 * `requesterChoice` reads it, and the cap is checked HERE as well as on the
 * form, because a form is a convenience and not a control.
 */
export function resolveRequestedDuration(
  policy: DurationPolicy,
  requestedDays: number | null,
): DurationOutcome {
  if (policy.durationMode === 'permanent') return { ok: true, days: null };
  if (policy.durationMode === 'fixed') return { ok: true, days: policy.defaultDurationDays };

  const days = requestedDays ?? policy.defaultDurationDays;
  if (days === null) return { ok: false, message: 'Say how long this is needed for' };
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, message: 'Ask for a whole number of days, at least one' };
  }
  if (policy.maxDurationDays !== null && days > policy.maxDurationDays) {
    return {
      ok: false,
      message: `This product may be held for at most ${policy.maxDurationDays} days`,
    };
  }
  return { ok: true, days };
}

/**
 * An approver may SHORTEN a duration when deciding, and may not lengthen it.
 *
 * Shortening a permanent grant is refused rather than honoured: `null` to
 * thirty days is not a shortening, it is a change to the product's
 * `durationMode` made one request at a time, and that is a catalog decision.
 */
export function applyShortening(
  days: number | null,
  shortenedToDays: number | null,
): DurationOutcome {
  if (shortenedToDays === null) return { ok: true, days };
  if (!Number.isInteger(shortenedToDays) || shortenedToDays <= 0) {
    return { ok: false, message: 'A shortened duration is a whole number of days' };
  }
  if (days === null) {
    return {
      ok: false,
      message: 'This product grants permanent access; you can approve it or refuse it',
    };
  }
  if (shortenedToDays > days) {
    return { ok: false, message: 'An approver may shorten a request, never lengthen it' };
  }
  return { ok: true, days: shortenedToDays };
}

export interface GrantWindowInput {
  now: Date;
  /** Null for a permanent grant. */
  days: number | null;
  /** A start the requester deliberately chose. */
  requestedStartsAt: Date | null;
  /** The subject's earliest contract start, when that is in the future. */
  earliestContractStart: Date | null;
}

/**
 * When a grant runs.
 *
 * A grant starts at the moment of fulfilment, or a later date the requester
 * chose, or the subject's contract start where that is in the future --
 * whichever is latest. The last case is the pre-hire: the grant is
 * `scheduled`, confers nothing, and becomes `pending` on the day.
 *
 * The duration is measured from `startsAt`, not from now. Thirty days of a
 * pre-hire's access are thirty days of employment, not thirty days of waiting.
 */
export function grantWindow(input: GrantWindowInput): {
  startsAt: Date;
  endsAt: Date | null;
  scheduled: boolean;
} {
  const candidates = [input.now];
  if (input.requestedStartsAt !== null && input.requestedStartsAt > input.now) {
    candidates.push(input.requestedStartsAt);
  }
  if (input.earliestContractStart !== null && input.earliestContractStart > input.now) {
    candidates.push(input.earliestContractStart);
  }
  const startsAt = candidates.reduce((a, b) => (a > b ? a : b));

  return {
    startsAt,
    endsAt: input.days === null ? null : addDays(startsAt, input.days),
    scheduled: startsAt > input.now,
  };
}

/**
 * Whether a grant's window covers `now`.
 *
 * `startsAt` is inclusive and `endsAt` is exclusive: the end date is the
 * moment access stops. This is the boundary the nightly sweep reads, and
 * getting it the other way round leaves everybody holding their access for one
 * extra day.
 */
export function grantInForce(
  grant: { startsAt: Date; endsAt: Date | null },
  now: Date,
): boolean {
  if (now < grant.startsAt) return false;
  return grant.endsAt === null || now < grant.endsAt;
}
```

- [ ] **Step 6: Export both modules**

In `packages/core/src/index.ts`, after `export * from './automate/audience.js';`:

```ts
export * from './automate/form.js';
export * from './automate/duration.js';
```

- [ ] **Step 7: Run both tests**

Run: `pnpm vitest run packages/core/src/automate/form.test.ts packages/core/src/automate/duration.test.ts`
Expected: PASS, every case.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. In particular, no "Module ... has already exported a member named 'addDays'" — if that appears, `duration.ts` defined its own instead of importing Provision's.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/automate/form.ts packages/core/src/automate/duration.ts \
        packages/core/src/automate/form.test.ts packages/core/src/automate/duration.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): typed request forms and duration arithmetic"
```

---

## Task 4: Approver resolution, and the subtraction that is a security control

Spec §8 and §9. This is the module the whole slice's security argument rests on, and the subtraction happens in **one place** so that every selector inherits it — a rule applied per selector is a rule the next selector forgets.

**Files:**
- Create: `packages/core/src/automate/approvers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/approvers.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `activeContracts`, `resolveContractForMapping` from `../identity/contract-service.js`; `listMembers` from `../directory/group-service.js`; `type ResourceType`, `type ApproverVia` from `./types.js`.
- Produces:
  - `const MAX_MANAGER_DEPTH = 16`
  - `type ApproverSelector = 'manager' | 'managerChain' | 'productOwner' | 'resourceOwner' | 'role' | 'group' | 'person'`
  - `interface SelectorConfig { depth?: number; roleId?: string; groupId?: string; personId?: string }`
  - `interface StageSnapshot { sequence: number; name: string; selector: ApproverSelector; selectorConfig: SelectorConfig; quorum: 'any' | 'all'; fallbackSelector: ApproverSelector | null; fallbackConfig: SelectorConfig; slaHours: number; onTimeout: 'remind' | 'escalate' | 'expire'; escalationSelector: ApproverSelector | null; escalationConfig: SelectorConfig; expiryHours: number | null }`
  - `interface ResolutionSubject { subjectPersonId: string; submitterPersonId: string | null; productOwnerPersonId: string | null; productOwnerGroupId: string | null; productCategory: string | null; resources: { resourceType: ResourceType; resourceId: string }[] }`
  - `type DropReason = 'subject' | 'submitter' | 'no_user' | 'inactive_user' | 'no_active_contract'`
  - `interface ResolvedApprover { personId: string; via: ApproverVia; onBehalfOfPersonId: string | null }`
  - `interface ResolutionResult { approvers: ResolvedApprover[]; usedFallback: boolean; dropped: { personId: string; reason: DropReason }[] }`
  - `async function mappingContractFor(tx: TenantClient, personId: string, on: Date): Promise<{ id: string; managerPersonId: string | null } | null>`
  - `async function managerChainFor(tx: TenantClient, personId: string, depth: number, on: Date): Promise<string[]>`
  - `async function isValidApprover(tx: TenantClient, personId: string, on: Date): Promise<DropReason | null>`
  - `async function activeDelegatesFor(tx: TenantClient, delegatorPersonIds: readonly string[], category: string | null, on: Date): Promise<Map<string, string[]>>`
  - `async function resolveSelector(tx: TenantClient, selector: ApproverSelector, config: SelectorConfig, subject: ResolutionSubject, on: Date): Promise<string[]>`
  - `async function resolveStageApprovers(tx: TenantClient, stage: StageSnapshot, subject: ResolutionSubject, on: Date): Promise<ResolutionResult>`
  - `async function resolveEscalationApprovers(tx: TenantClient, stage: StageSnapshot, subject: ResolutionSubject, on: Date): Promise<ResolutionResult>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/approvers.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  MAX_MANAGER_DEPTH,
  managerChainFor,
  resolveStageApprovers,
  type ApproverSelector,
  type ResolutionSubject,
  type StageSnapshot,
} from './approvers.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
/** personId by nickname, so the assertions read as sentences. */
const person: Record<string, string> = {};

/**
 * A person with an active account and an active contract: the only kind that
 * can decide anything. `manager` is who they report to.
 */
async function seedPerson(
  name: string,
  options: { manager?: string; userStatus?: string; withUser?: boolean; contract?: boolean } = {},
) {
  const { manager, userStatus = 'active', withUser = true, contract = true } = options;
  person[name] = await withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    if (contract) {
      await tx.contract.create({
        data: {
          tenantId,
          personId: p.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
          department: 'Finance',
          ...(manager === undefined ? {} : { managerPersonId: person[manager]! }),
        },
      });
    }
    if (withUser) {
      await tx.user.create({
        data: {
          tenantId,
          login: name.toLowerCase(),
          email: `${name.toLowerCase()}@acme.test`,
          displayName: name,
          personId: p.id,
          status: userStatus,
        },
      });
    }
    return p.id;
  });
  return person[name]!;
}

const stage = (over: Partial<StageSnapshot> = {}): StageSnapshot => ({
  sequence: 1,
  name: 'Stage 1',
  selector: 'manager',
  selectorConfig: {},
  quorum: 'any',
  fallbackSelector: null,
  fallbackConfig: {},
  slaHours: 48,
  onTimeout: 'remind',
  escalationSelector: null,
  escalationConfig: {},
  expiryHours: null,
  ...over,
});

const subject = (over: Partial<ResolutionSubject> = {}): ResolutionSubject => ({
  subjectPersonId: person.anna!,
  submitterPersonId: person.anna!,
  productOwnerPersonId: null,
  productOwnerGroupId: null,
  productCategory: null,
  resources: [],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  for (const key of Object.keys(person)) delete person[key];
  await seedPerson('jan');
  await seedPerson('anna', { manager: 'jan' });
});

describe('resolveStageApprovers — the selectors', () => {
  it('resolves manager from the subject own mapping contract', async () => {
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
    ]);
    expect(result.usedFallback).toBe(false);
  });

  it('resolves managerChain(2) to the manager of the manager', async () => {
    await seedPerson('rik');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.rik! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ selector: 'managerChain', selectorConfig: { depth: 2 }, fallbackSelector: 'person', fallbackConfig: { personId: person.rik! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.rik]);
  });

  it('falls back when the chain is shorter than n', async () => {
    await seedPerson('ines');
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'managerChain',
          selectorConfig: { depth: 5 },
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([
      { personId: person.ines, via: 'fallback', onBehalfOfPersonId: null },
    ]);
    expect(result.usedFallback).toBe(true);
  });

  it('resolves group to every member with a person, and role to every holder', async () => {
    await seedPerson('bo');
    await seedPerson('ines');
    const { groupId, roleId } = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
      const bo = await tx.user.findFirstOrThrow({ where: { personId: person.bo! } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: bo.id },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Approvers', permissions: [] },
      });
      const ines = await tx.user.findFirstOrThrow({ where: { personId: person.ines! } });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: ines.id },
      });
      return { groupId: group.id, roleId: role.id };
    });

    const byGroup = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage({ selector: 'group', selectorConfig: { groupId } }), subject(), NOW),
    );
    expect(byGroup.approvers.map((a) => a.personId)).toEqual([person.bo]);

    const byRole = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage({ selector: 'role', selectorConfig: { roleId } }), subject(), NOW),
    );
    expect(byRole.approvers.map((a) => a.personId)).toEqual([person.ines]);
  });

  it('resolves resourceOwner from the ResourceOwner table, and falls back when none is recorded', async () => {
    await seedPerson('bo');
    await seedPerson('ines');
    const resourceId = person.bo!;
    const resources = [{ resourceType: 'group' as const, resourceId }];
    const withoutOwner = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'resourceOwner',
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject({ resources }),
        NOW,
      ),
    );
    expect(withoutOwner.approvers.map((a) => a.personId)).toEqual([person.ines]);

    await withTenant(tenantId, (tx) =>
      tx.resourceOwner.create({
        data: { tenantId, resourceType: 'group', resourceId, ownerPersonId: person.bo! },
      }),
    );
    const withOwner = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'resourceOwner',
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject({ resources }),
        NOW,
      ),
    );
    expect(withOwner.approvers.map((a) => a.personId)).toEqual([person.bo]);
  });
});

describe('resolveStageApprovers — who cannot act', () => {
  it('drops a person with no Syntra account at all', async () => {
    // The ordinary case of a manager who exists in the HR record and has no
    // account here: they cannot sign in, so they cannot decide.
    await seedPerson('ghost', { withUser: false });
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.ghost! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({ personId: person.ghost, reason: 'no_user' });
    expect(result.approvers.map((a) => a.personId)).toEqual([person.jan]);
  });

  it('drops a person whose account is inactive', async () => {
    await seedPerson('gone', { userStatus: 'inactive' });
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.gone! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({ personId: person.gone, reason: 'inactive_user' });
  });

  it('drops a person with no active contract', async () => {
    await seedPerson('left');
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.left! },
        data: { endDate: day('2026-01-01') },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.left! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({
      personId: person.left,
      reason: 'no_active_contract',
    });
  });

  it('returns nobody, and does not throw, when the fallback is also empty', async () => {
    // The caller turns this into blocked_no_approver. It never auto-approves
    // and it never sits silently, but that decision belongs one level up.
    await seedPerson('ghost', { withUser: false });
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.ghost! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ghost! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([]);
  });
});

describe('managerChainFor', () => {
  it('terminates on a cycle instead of hanging every approval in the tenant', async () => {
    // Contract.managerPersonId is a self-reference with no database-level
    // acyclicity check, exactly like OrgUnit.parentId.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const chain = await withTenant(tenantId, (tx) =>
      managerChainFor(tx, person.anna!, MAX_MANAGER_DEPTH, NOW),
    );
    expect(chain).toEqual([person.jan, person.anna]);
  });

  it('stops at MAX_MANAGER_DEPTH', async () => {
    let previous = 'anna';
    for (let i = 0; i < 25; i += 1) {
      const name = `boss${i}`;
      await seedPerson(name);
      const child = previous;
      await withTenant(tenantId, (tx) =>
        tx.contract.updateMany({
          where: { personId: person[child]! },
          data: { managerPersonId: person[name]! },
        }),
      );
      previous = name;
    }
    const chain = await withTenant(tenantId, (tx) =>
      managerChainFor(tx, person.anna!, 99, NOW),
    );
    expect(chain).toHaveLength(MAX_MANAGER_DEPTH);
  });
});

describe('delegation adds an approver and never replaces one', () => {
  it('routes to the delegator AND the delegate while a delegation is active', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    // The delegator stays. Replacement would hide an approval from the person
    // accountable for it, and it is the cleanest self-approval path in the
    // design.
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
      { personId: person.ines, via: 'delegate', onBehalfOfPersonId: person.jan },
    ]);
  });

  it('ignores a delegation outside its own window, and one restricted to another category', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, async (tx) => {
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-02-01'),
        },
      });
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          category: 'Facilities',
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject({ productCategory: 'Finance' }), NOW),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.jan]);
  });

  it('is not transitive', async () => {
    // A delegates to B, B delegates to C: C is not an approver of A's steps.
    await seedPerson('ines');
    await seedPerson('bo');
    await withTenant(tenantId, async (tx) => {
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.ines!,
          delegatePersonId: person.bo!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers.map((a) => a.personId)).not.toContain(person.bo);
  });
});

/**
 * The invariant, as a matrix rather than a set of cases.
 *
 * Written over the selector list rather than as eight hand-written tests, so
 * that adding a selector later and forgetting the subtraction fails a test
 * rather than passing review. Each row builds a world where the subject or the
 * submitter WOULD be resolved by that selector, and asserts they are not.
 */
describe('the self-approval invariant', () => {
  const SELECTORS: ApproverSelector[] = [
    'manager',
    'managerChain',
    'productOwner',
    'resourceOwner',
    'role',
    'group',
    'person',
  ];

  /** Makes `victim` the person this selector would resolve to. */
  async function arrange(selector: ApproverSelector, victimPersonId: string) {
    return withTenant(tenantId, async (tx) => {
      switch (selector) {
        case 'manager':
        case 'managerChain':
          await tx.contract.updateMany({
            where: { personId: person.anna! },
            data: { managerPersonId: victimPersonId },
          });
          return { config: selector === 'managerChain' ? { depth: 1 } : {}, subjectOver: {} };
        case 'productOwner':
          return { config: {}, subjectOver: { productOwnerPersonId: victimPersonId } };
        case 'resourceOwner': {
          await tx.resourceOwner.create({
            data: {
              tenantId,
              resourceType: 'group',
              resourceId: person.jan!,
              ownerPersonId: victimPersonId,
            },
          });
          return {
            config: {},
            subjectOver: {
              resources: [{ resourceType: 'group' as const, resourceId: person.jan! }],
            },
          };
        }
        case 'role': {
          const role = await tx.role.create({
            data: { tenantId, name: `R-${selector}-${victimPersonId}`, permissions: [] },
          });
          const user = await tx.user.findFirstOrThrow({ where: { personId: victimPersonId } });
          await tx.roleAssignment.create({
            data: { tenantId, roleId: role.id, userId: user.id },
          });
          return { config: { roleId: role.id }, subjectOver: {} };
        }
        case 'group': {
          const group = await tx.group.create({
            data: { tenantId, name: `G-${victimPersonId}` },
          });
          const user = await tx.user.findFirstOrThrow({ where: { personId: victimPersonId } });
          await tx.groupMembership.create({
            data: { tenantId, groupId: group.id, userId: user.id },
          });
          return { config: { groupId: group.id }, subjectOver: {} };
        }
        case 'person':
          return { config: { personId: victimPersonId }, subjectOver: {} };
      }
    });
  }

  for (const selector of SELECTORS) {
    it(`never resolves the subject through ${selector}`, async () => {
      const { config, subjectOver } = await arrange(selector, person.anna!);
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject(subjectOver),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.anna);
      expect(result.dropped).toContainEqual({ personId: person.anna, reason: 'subject' });
    });

    it(`never resolves the on-behalf submitter through ${selector}`, async () => {
      // The path a design that only checks the SUBJECT leaves open, and the
      // more dangerous one: request_on_behalf is handed out widely.
      await seedPerson('helpdesk');
      const { config, subjectOver } = await arrange(selector, person.helpdesk!);
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject({ ...subjectOver, submitterPersonId: person.helpdesk! }),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.helpdesk);
      expect(result.dropped).toContainEqual({
        personId: person.helpdesk,
        reason: 'submitter',
      });
    });
  }

  it('drops the subject when they hold a delegation from the resolved approver', async () => {
    // Persuade your manager to delegate to you for a week and every request
    // you raise arrives in your own queue. Because delegation ADDS, dropping
    // the subject leaves the nominal approver in place and the stage works.
    await withTenant(tenantId, (tx) =>
      tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.anna!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
    ]);
  });

  it('drops the subject when they are their own manager', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.ines]);
    expect(result.usedFallback).toBe(true);
  });

  it('drops the subject wherever they appear in a manager cycle', async () => {
    // A manages B and B manages A, so managerChain(2) returns A.
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'managerChain',
          selectorConfig: { depth: 2 },
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.ines]);
  });

  it('returns nobody when the subject is the only member of the group selector', async () => {
    // The correct outcome: a product whose only approver is the person asking
    // is a misconfiguration, and it should be visible as one rather than
    // resolved by pretending.
    const groupId = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Just Anna' } });
      const anna = await tx.user.findFirstOrThrow({ where: { personId: person.anna! } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: anna.id },
      });
      return group.id;
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ selector: 'group', selectorConfig: { groupId } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/approvers.test.ts`
Expected: FAIL, "Failed to resolve import ./approvers.js".

- [ ] **Step 3: Write the resolver**

`packages/core/src/automate/approvers.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { activeContracts, resolveContractForMapping } from '../identity/contract-service.js';
import { listMembers } from '../directory/group-service.js';
import type { ApproverVia, ResourceType } from './types.js';

/**
 * A chain deep enough to hit this is a cycle, not an organization.
 *
 * Deliberately a constant and not a tenant setting: it terminates a walk, it
 * does not express a policy, and a tenant that could raise it could hang every
 * approval it has.
 */
export const MAX_MANAGER_DEPTH = 16;

export type ApproverSelector =
  | 'manager'
  | 'managerChain'
  | 'productOwner'
  | 'resourceOwner'
  | 'role'
  | 'group'
  | 'person';

export interface SelectorConfig {
  /** managerChain only, 1..5. */
  depth?: number;
  roleId?: string;
  groupId?: string;
  personId?: string;
}

/** The whole stage as it stood at submission. Written onto ApprovalStep. */
export interface StageSnapshot {
  sequence: number;
  name: string;
  selector: ApproverSelector;
  selectorConfig: SelectorConfig;
  quorum: 'any' | 'all';
  fallbackSelector: ApproverSelector | null;
  fallbackConfig: SelectorConfig;
  slaHours: number;
  onTimeout: 'remind' | 'escalate' | 'expire';
  escalationSelector: ApproverSelector | null;
  escalationConfig: SelectorConfig;
  expiryHours: number | null;
}

export interface ResolutionSubject {
  subjectPersonId: string;
  /** The person behind the submitting account, when there is one. */
  submitterPersonId: string | null;
  productOwnerPersonId: string | null;
  productOwnerGroupId: string | null;
  /** Restricts which delegations apply. */
  productCategory: string | null;
  resources: { resourceType: ResourceType; resourceId: string }[];
}

export type DropReason =
  | 'subject'
  | 'submitter'
  | 'no_user'
  | 'inactive_user'
  | 'no_active_contract';

export interface ResolvedApprover {
  personId: string;
  via: ApproverVia;
  onBehalfOfPersonId: string | null;
}

export interface ResolutionResult {
  approvers: ResolvedApprover[];
  usedFallback: boolean;
  dropped: { personId: string; reason: DropReason }[];
}

/**
 * The contract that supplies the manager: the primary contract if currently
 * active, otherwise the active contract with the lowest sequence number.
 *
 * `resolveContractForMapping` is reused rather than reimplemented. Access uses
 * it for claims and Provision uses it for account attributes, and a person's
 * approval chain disagreeing with their SAML assertion about who their manager
 * is would be a support call nobody can close.
 */
export async function mappingContractFor(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<{ id: string; managerPersonId: string | null } | null> {
  const primary = await resolveContractForMapping(tx, personId, 'primary', on);
  const contract = primary ?? (await resolveContractForMapping(tx, personId, 'lowestSequence', on));
  return contract === null
    ? null
    : { id: contract.id, managerPersonId: contract.managerPersonId };
}

/**
 * The manager, their manager, and so on, up to `depth` levels.
 *
 * Carries a seen-set and a depth cap for the reason `orgUnitChain` does:
 * `Contract.managerPersonId` is a self-relation with no database-level
 * acyclicity check, and a cycle introduced by a bad import would otherwise
 * hang every approval in the tenant.
 */
export async function managerChainFor(
  tx: TenantClient,
  personId: string,
  depth: number,
  on: Date,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>([personId]);
  let current = personId;

  const limit = Math.min(depth, MAX_MANAGER_DEPTH);
  for (let step = 0; step < limit; step += 1) {
    const contract = await mappingContractFor(tx, current, on);
    const next = contract?.managerPersonId ?? null;
    if (next === null) break;
    chain.push(next);
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
  }

  return chain;
}

/**
 * Whether somebody can actually act, and why not when they cannot.
 *
 * All three conditions, per spec section 8: a live Syntra account, that
 * account active, and at least one active contract. A person with no `User` at
 * all cannot sign in and therefore cannot decide -- the ordinary case of a
 * manager who exists in the HR record and has no account here.
 */
export async function isValidApprover(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<DropReason | null> {
  const users = await tx.user.findMany({ where: { personId }, select: { status: true } });
  if (users.length === 0) return 'no_user';
  if (!users.some((u) => u.status === 'active')) return 'inactive_user';
  const contracts = await activeContracts(tx, personId, on);
  if (contracts.length === 0) return 'no_active_contract';
  return null;
}

/**
 * Active delegations from each of `delegatorPersonIds`, as delegator to
 * delegates.
 *
 * Exactly ONE level is expanded, which is what makes delegation
 * non-transitive: A delegates to B, B delegates to C, and C is not an approver
 * of A's steps. Depth is also refused when the delegation is created, but this
 * is the half that holds even if a row got in another way.
 */
export async function activeDelegatesFor(
  tx: TenantClient,
  delegatorPersonIds: readonly string[],
  category: string | null,
  on: Date,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (delegatorPersonIds.length === 0) return out;

  const rows = await tx.approvalDelegation.findMany({
    where: {
      delegatorPersonId: { in: [...delegatorPersonIds] },
      revokedAt: null,
      startsAt: { lte: on },
      endsAt: { gt: on },
      // A delegation restricted to one product category applies only there. A
      // delegation with no category applies to everything.
      OR: [{ category: null }, ...(category === null ? [] : [{ category }])],
    },
    select: { delegatorPersonId: true, delegatePersonId: true },
  });

  for (const row of rows) {
    const list = out.get(row.delegatorPersonId) ?? [];
    if (!list.includes(row.delegatePersonId)) list.push(row.delegatePersonId);
    out.set(row.delegatorPersonId, list);
  }
  return out;
}

async function personIdsForUsers(
  tx: TenantClient,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const users = await tx.user.findMany({
    where: { id: { in: [...userIds] }, personId: { not: null } },
    select: { personId: true },
  });
  return users.map((u) => u.personId!).filter((id, i, all) => all.indexOf(id) === i);
}

/** The raw set a selector names, before delegation, subtraction or validity. */
export async function resolveSelector(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
  subject: ResolutionSubject,
  on: Date,
): Promise<string[]> {
  switch (selector) {
    case 'manager': {
      const contract = await mappingContractFor(tx, subject.subjectPersonId, on);
      return contract?.managerPersonId === null || contract === null
        ? []
        : [contract.managerPersonId];
    }
    case 'managerChain': {
      const depth = Math.min(Math.max(config.depth ?? 1, 1), 5);
      const chain = await managerChainFor(tx, subject.subjectPersonId, depth, on);
      // The n-th manager up, and only that one. A chain shorter than n
      // resolves to nobody and falls through to the required fallback.
      const nth = chain[depth - 1];
      return nth === undefined ? [] : [nth];
    }
    case 'productOwner': {
      if (subject.productOwnerPersonId !== null) return [subject.productOwnerPersonId];
      if (subject.productOwnerGroupId === null) return [];
      const members = await listMembers(tx, subject.productOwnerGroupId);
      return members
        .map((u) => u.personId)
        .filter((id): id is string => id !== null);
    }
    case 'resourceOwner': {
      if (subject.resources.length === 0) return [];
      const owners = await tx.resourceOwner.findMany({
        where: {
          OR: subject.resources.map((r) => ({
            resourceType: r.resourceType,
            resourceId: r.resourceId,
          })),
        },
      });
      const people: string[] = [];
      for (const owner of owners) {
        if (owner.ownerPersonId !== null) {
          people.push(owner.ownerPersonId);
          continue;
        }
        if (owner.ownerGroupId !== null) {
          const members = await listMembers(tx, owner.ownerGroupId);
          for (const member of members) {
            if (member.personId !== null) people.push(member.personId);
          }
        }
      }
      return people.filter((id, i, all) => all.indexOf(id) === i);
    }
    case 'role': {
      if (config.roleId === undefined) return [];
      const assignments = await tx.roleAssignment.findMany({
        where: { roleId: config.roleId },
        select: { userId: true },
      });
      return personIdsForUsers(tx, assignments.map((a) => a.userId));
    }
    case 'group': {
      if (config.groupId === undefined) return [];
      const members = await listMembers(tx, config.groupId);
      return members.map((u) => u.personId).filter((id): id is string => id !== null);
    }
    case 'person':
      return config.personId === undefined ? [] : [config.personId];
  }
}

/**
 * One selector's worth of resolution: expand delegations, subtract the subject
 * and the submitter, then drop whoever cannot act.
 *
 * The subtraction happens HERE, once, rather than inside each `case` above. A
 * rule applied per selector is a rule the next selector forgets, and the next
 * selector is the one somebody adds in a year.
 */
async function resolveOne(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
  subject: ResolutionSubject,
  via: 'selector' | 'fallback' | 'escalation',
  on: Date,
  dropped: { personId: string; reason: DropReason }[],
): Promise<ResolvedApprover[]> {
  const named = await resolveSelector(tx, selector, config, subject, on);
  const delegates = await activeDelegatesFor(tx, named, subject.productCategory, on);

  const candidates: ResolvedApprover[] = [];
  for (const personId of named) {
    candidates.push({ personId, via, onBehalfOfPersonId: null });
    for (const delegate of delegates.get(personId) ?? []) {
      candidates.push({ personId: delegate, via: 'delegate', onBehalfOfPersonId: personId });
    }
  }

  const out: ResolvedApprover[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.personId)) continue;
    seen.add(candidate.personId);

    // The invariant. Both halves, in one place, before anything else is asked
    // about this person -- so no future branch can reach past it.
    if (candidate.personId === subject.subjectPersonId) {
      dropped.push({ personId: candidate.personId, reason: 'subject' });
      continue;
    }
    if (
      subject.submitterPersonId !== null &&
      candidate.personId === subject.submitterPersonId
    ) {
      dropped.push({ personId: candidate.personId, reason: 'submitter' });
      continue;
    }

    const invalid = await isValidApprover(tx, candidate.personId, on);
    if (invalid !== null) {
      dropped.push({ personId: candidate.personId, reason: invalid });
      continue;
    }
    out.push(candidate);
  }
  return out;
}

/**
 * The stage's approver set: the selector, and the fallback when the selector
 * left nobody.
 *
 * Returning an empty list is a legitimate outcome and not an error. The caller
 * turns it into `blocked_no_approver`, which appears on the dashboard,
 * notifies the product owner and every holder of `automate.manage`, and stays
 * there. It never auto-approves and it never sits silently, but neither of
 * those decisions belongs in a resolver.
 */
export async function resolveStageApprovers(
  tx: TenantClient,
  stage: StageSnapshot,
  subject: ResolutionSubject,
  on: Date,
): Promise<ResolutionResult> {
  const dropped: { personId: string; reason: DropReason }[] = [];
  const primary = await resolveOne(
    tx,
    stage.selector,
    stage.selectorConfig,
    subject,
    'selector',
    on,
    dropped,
  );
  if (primary.length > 0) return { approvers: primary, usedFallback: false, dropped };

  if (stage.fallbackSelector === null) {
    return { approvers: [], usedFallback: false, dropped };
  }
  const fallback = await resolveOne(
    tx,
    stage.fallbackSelector,
    stage.fallbackConfig,
    subject,
    'fallback',
    on,
    dropped,
  );
  return { approvers: fallback, usedFallback: true, dropped };
}

/**
 * The escalation set, resolved when a stage passes its SLA under
 * `onTimeout: 'escalate'`.
 *
 * These are ADDED to the stage; the original approvers remain and are told
 * they were escalated past. Escalation that silently removes somebody's
 * authority is how an approver discovers, months later, that decisions
 * attributed to their team were not theirs. The subtraction applies here too:
 * escalating to a role the subject happens to hold is a plausible accident.
 */
export async function resolveEscalationApprovers(
  tx: TenantClient,
  stage: StageSnapshot,
  subject: ResolutionSubject,
  on: Date,
): Promise<ResolutionResult> {
  const dropped: { personId: string; reason: DropReason }[] = [];
  if (stage.escalationSelector === null) {
    return { approvers: [], usedFallback: false, dropped };
  }
  const approvers = await resolveOne(
    tx,
    stage.escalationSelector,
    stage.escalationConfig,
    subject,
    'escalation',
    on,
    dropped,
  );
  return { approvers, usedFallback: false, dropped };
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/duration.js';`:

```ts
export * from './automate/approvers.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/approvers.test.ts`
Expected: PASS. The matrix contributes fourteen cases on its own — seven selectors × subject and submitter.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/approvers.ts \
        packages/core/src/automate/approvers.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): approver resolution with the self-approval subtraction"
```

---

## Task 5: The notification outbox and Automate's templates

Spec §13. Render inside the transaction, send after it commits, record everything in an outbox.

**Nothing in this task sends anything.** `enqueueOutbox` writes rows; `runOutboxJob` in Task 16 renders and sends them. That ordering is not a convention anybody has to remember here: `enqueueOutbox` takes a `TenantClient` and no `Transport`, and `sendMessage` takes a `Transport` and no `TenantClient`, so the wrong order does not type-check.

**Files:**
- Modify: `packages/core/src/notify/templates/index.ts`
- Create: `packages/core/src/automate/notify.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/notify.test.ts`

**Interfaces:**
- Consumes: `type TenantClient` from `@syntra/db`; `currentTenant` from `../tenant-context.js`; `TEMPLATES`, `type TemplateName`, `renderMessage` from `../notify/notification-service.js` and `../notify/templates/index.js`; `type Permission` from `../rbac/permissions.js`.
- Produces:
  - `type AutomateTemplate` — the union of the template names added below, a subset of `TemplateName`
  - `const NEVER_DIGESTED: readonly AutomateTemplate[]`
  - `function isDigestible(template: AutomateTemplate): boolean`
  - `interface OutboxDraft { template: AutomateTemplate; to: string; vars: Record<string, string>; requestId: string | null; userId: string | null }`
  - `async function enqueueOutbox(tx: TenantClient, drafts: readonly OutboxDraft[]): Promise<number>`
  - `interface Recipient { userId: string; personId: string | null; email: string; displayName: string }`
  - `async function recipientsForPersons(tx: TenantClient, personIds: readonly string[]): Promise<Recipient[]>`
  - `async function usersWithPermission(tx: TenantClient, permission: Permission): Promise<Recipient[]>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/notify.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { renderMessage } from '../notify/notification-service.js';
import { TEMPLATES } from '../notify/templates/index.js';
import {
  NEVER_DIGESTED,
  enqueueOutbox,
  isDigestible,
  recipientsForPersons,
  usersWithPermission,
  type AutomateTemplate,
} from './notify.js';

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    return { personId: person.id, userId: user.id };
  });
  annaPersonId = seeded.personId;
  annaUserId = seeded.userId;
});

describe('enqueueOutbox', () => {
  it('writes one unsent row per draft, carrying the request it belongs to', async () => {
    const written = await withTenant(tenantId, (tx) =>
      enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'jan@acme.test',
          vars: { displayName: 'Jan', productName: 'Statistics licence' },
          requestId: null,
          userId: null,
        },
      ]),
    );
    expect(written).toBe(1);

    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template: 'automate-stage-opened',
      to: 'jan@acme.test',
      attempts: 0,
      sentAt: null,
      digest: false,
    });
  });

  it('marks a digestible row for the digest when the recipient asked for one', async () => {
    await withTenant(tenantId, (tx) =>
      tx.notificationPreference.create({
        data: { tenantId, userId: annaUserId, mode: 'daily' },
      }),
    );
    const rows = await withTenant(tenantId, async (tx) => {
      await enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'anna@acme.test',
          vars: {},
          requestId: null,
          userId: annaUserId,
        },
      ]);
      return tx.notificationOutbox.findMany();
    });
    expect(rows[0]?.digest).toBe(true);
  });

  it('never digests a failure, a block or a confirmation, whatever the preference says', async () => {
    // A digest is a convenience for routine traffic. The traffic that matters
    // is the traffic that says something is stuck.
    await withTenant(tenantId, (tx) =>
      tx.notificationPreference.create({
        data: { tenantId, userId: annaUserId, mode: 'daily' },
      }),
    );
    const rows = await withTenant(tenantId, async (tx) => {
      await enqueueOutbox(
        tx,
        NEVER_DIGESTED.map((template) => ({
          template,
          to: 'anna@acme.test',
          vars: {},
          requestId: null,
          userId: annaUserId,
        })),
      );
      return tx.notificationOutbox.findMany();
    });
    expect(rows).toHaveLength(NEVER_DIGESTED.length);
    for (const row of rows) expect(row.digest).toBe(false);
  });

  it('writes nothing for an empty list rather than a row with no recipient', async () => {
    const written = await withTenant(tenantId, (tx) => enqueueOutbox(tx, []));
    expect(written).toBe(0);
  });
});

describe('isDigestible', () => {
  it('agrees with NEVER_DIGESTED for every template that exists', () => {
    for (const template of Object.keys(TEMPLATES) as AutomateTemplate[]) {
      if (!template.startsWith('automate-')) continue;
      expect(isDigestible(template)).toBe(
        !(NEVER_DIGESTED as readonly string[]).includes(template),
      );
    }
  });
});

describe('recipientsForPersons', () => {
  it('returns one recipient per active account, and none for a person with no account', async () => {
    const ghostPersonId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Ghost', familyName: 'Test' },
      });
      return p.id;
    });
    const recipients = await withTenant(tenantId, (tx) =>
      recipientsForPersons(tx, [annaPersonId, ghostPersonId]),
    );
    expect(recipients).toEqual([
      {
        userId: annaUserId,
        personId: annaPersonId,
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
      },
    ]);
  });

  it('skips an inactive account', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: annaUserId }, data: { status: 'inactive' } }),
    );
    const recipients = await withTenant(tenantId, (tx) =>
      recipientsForPersons(tx, [annaPersonId]),
    );
    expect(recipients).toEqual([]);
  });
});

describe('usersWithPermission', () => {
  it('finds the holders of a permission through their roles', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders.map((h) => h.userId)).toEqual([annaUserId]);
  });

  it('does not find somebody holding a different permission', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: [PERMISSIONS.AUDIT_READ] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders).toEqual([]);
  });

  it('does not find somebody whose account is inactive', async () => {
    // Telling a deactivated account that a request is stuck reaches nobody and
    // makes the queue look attended.
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
      await tx.user.update({ where: { id: annaUserId }, data: { status: 'inactive' } });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders).toEqual([]);
  });
});

describe('the templates themselves', () => {
  it('leaves an unknown placeholder visible rather than rendering undefined', () => {
    // The existing rule, and it matters more here than anywhere: a request
    // notification with "undefined" where the product name should be is a
    // support ticket, and one with "{{productName}}" is a bug report.
    const message = renderMessage('Acme', 'automate-stage-opened', 'jan@acme.test', {
      displayName: 'Jan',
    });
    expect(message.text).toContain('{{productName}}');
    expect(message.text).not.toContain('undefined');
  });

  it('names the tenant in every automate subject line', async () => {
    for (const template of Object.keys(TEMPLATES)) {
      if (!template.startsWith('automate-')) continue;
      expect(TEMPLATES[template as AutomateTemplate].subject).toContain('{{tenantName}}');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/notify.test.ts`
Expected: FAIL, "Failed to resolve import ./notify.js".

- [ ] **Step 3: Add the templates**

In `packages/core/src/notify/templates/index.ts`, inside the `TEMPLATES` object, after `'password-reset-upstream'`:

```ts
  'automate-request-submitted-for-you': {
    subject: 'A request was raised for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{submitterName}} has asked for {{productName}} on your behalf. You are being told now, before anybody decides, so that you can say something if this is not what you expected.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{submitterName}}</strong> has asked for <strong>{{productName}}</strong> on your behalf. You are being told now, before anybody decides, so that you can say something if this is not what you expected.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-stage-opened': {
    subject: 'A request at {{tenantName}} is waiting for you',
    text: 'Hello {{displayName}},\n\n{{requesterName}} has asked for {{productName}} for {{subjectName}}.\n\nWhy: {{justification}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> has asked for <strong>{{productName}}</strong> for {{subjectName}}.</p><p>Why: {{justification}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-reminder': {
    subject: 'Still waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} has been waiting for your decision since {{openedAt}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} has been waiting for your decision since {{openedAt}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated': {
    subject: 'A request at {{tenantName}} has been escalated to you',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour service level and has been escalated to you. The original approvers remain and have been told.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour service level and has been escalated to you. The original approvers remain and have been told.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated-past': {
    subject: 'A request of yours at {{tenantName}} was escalated',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour service level, so {{escalatedTo}} were added as approvers. You have not been removed and you can still decide it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour service level, so {{escalatedTo}} were added as approvers. You have <em>not</em> been removed and you can still decide it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-approved': {
    subject: 'Your request at {{tenantName}} was approved',
    text: 'Hello {{displayName}},\n\n{{productName}} was approved by {{approverName}}{{shortenedNote}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was approved by {{approverName}}{{shortenedNote}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-rejected': {
    subject: 'Your request at {{tenantName}} was refused',
    text: 'Hello {{displayName}},\n\n{{productName}} was refused by {{approverName}}.\n\nReason: {{comment}}\n\nIf that reason has changed, you can ask again.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was refused by {{approverName}}.</p><p>Reason: {{comment}}</p><p>If that reason has changed, you can ask again.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-refused': {
    subject: 'A request at {{tenantName}} could not go ahead',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was refused automatically.\n\nReason: {{reason}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was refused automatically.</p><p>Reason: {{reason}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-cancelled': {
    subject: 'A request at {{tenantName}} was withdrawn',
    text: 'Hello {{displayName}},\n\n{{requesterName}} has withdrawn their request for {{productName}}. There is nothing left for you to decide.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> has withdrawn their request for {{productName}}. There is nothing left for you to decide.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-request-expired': {
    subject: 'Your request at {{tenantName}} expired',
    text: 'Hello {{displayName}},\n\nNobody decided {{productName}} within {{expiryHours}} hours, so the request has expired. Nothing was granted. You can ask again.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Nobody decided <strong>{{productName}}</strong> within {{expiryHours}} hours, so the request has expired. Nothing was granted. You can ask again.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilled': {
    subject: 'You now hold {{productName}} at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} has been granted to {{subjectName}}.\n\nWhat this includes: {{resourceList}}\nUntil: {{endsAt}}\n{{skippedNote}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> has been granted to {{subjectName}}.</p><p>What this includes: {{resourceList}}<br>Until: {{endsAt}}</p><p>{{skippedNote}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-partially-fulfilled': {
    subject: 'Part of a request at {{tenantName}} did not go through',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} landed in part.\n\nGranted: {{grantedList}}\nNot granted: {{failedList}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} landed in part.</p><p>Granted: {{grantedList}}<br>Not granted: {{failedList}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilment-failed': {
    subject: 'A request at {{tenantName}} could not be applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved but could not be applied to {{targetName}}.\n\nThe system said: {{message}}\n\nNothing has been granted, and the request is waiting for somebody to look at it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved but could not be applied to {{targetName}}.</p><p>The system said: {{message}}</p><p>Nothing has been granted, and the request is waiting for somebody to look at it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-awaiting-fulfilment-sla': {
    subject: 'A request at {{tenantName}} has been waiting to be applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved {{waitingHours}} hours ago and has not been applied to {{targetName}} yet.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved {{waitingHours}} hours ago and has not been applied to {{targetName}} yet.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-blocked-no-approver': {
    subject: 'A request at {{tenantName}} has nobody to approve it',
    text: 'Hello {{displayName}},\n\nStage {{stageName}} of {{productName}} for {{subjectName}} resolved to nobody who can decide it, and so did its fallback.\n\n{{droppedNote}}\n\nNothing will happen to this request until somebody fixes the workflow, records a resource owner, or decides it by hand.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Stage <strong>{{stageName}}</strong> of {{productName}} for {{subjectName}} resolved to nobody who can decide it, and so did its fallback.</p><p>{{droppedNote}}</p><p>Nothing will happen to this request until somebody fixes the workflow, records a resource owner, or decides it by hand.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-expiry-warning': {
    subject: '{{productName}} at {{tenantName}} ends in {{days}} days',
    text: 'Hello {{displayName}},\n\n{{subjectName}} holds {{productName}} until {{endsAt}}.\n\nIf it is still needed, ask for an extension before then and there will be no gap:\n{{extendUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} holds <strong>{{productName}}</strong> until {{endsAt}}.</p><p>If it is still needed, ask for an extension before then and there will be no gap:</p><p><a href="{{extendUrl}}">Extend</a></p>',
  },
  'automate-expired': {
    subject: '{{productName}} at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\n{{productName}} ended on {{endsAt}} and has been removed.\n\n{{stillHeldNote}}\n\nTo ask for it again: {{catalogUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> ended on {{endsAt}} and has been removed.</p><p>{{stillHeldNote}}</p><p>To ask for it again: <a href="{{catalogUrl}}">the catalog</a></p>',
  },
  'automate-lapsed': {
    subject: 'Requested access at {{tenantName}} ended with the contract',
    text: 'Hello {{displayName}},\n\n{{subjectName}} had no contract in force after {{lastContractEnd}}, so the access they had asked for has been removed: {{resourceList}}\n\nIf a handover needs some of it back, request it with an end date.',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} had no contract in force after {{lastContractEnd}}, so the access they had asked for has been removed: {{resourceList}}</p><p>If a handover needs some of it back, request it with an end date.</p>',
  },
  'automate-review-flagged': {
    subject: 'Access at {{tenantName}} may no longer be needed',
    text: 'Hello {{displayName}},\n\n{{subjectName}} still holds {{productName}}, granted on {{grantedAt}}, but no longer matches the audience for it: {{reviewReason}}\n\nNothing has been removed. Somebody should decide whether it should be.\n\n{{grantUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} still holds <strong>{{productName}}</strong>, granted on {{grantedAt}}, but no longer matches the audience for it: {{reviewReason}}</p><p><em>Nothing has been removed.</em> Somebody should decide whether it should be.</p><p><a href="{{grantUrl}}">{{grantUrl}}</a></p>',
  },
  'automate-delegation-started': {
    subject: 'An approval delegation at {{tenantName}} has started',
    text: 'Hello {{displayName}},\n\n{{delegatorName}} has delegated approvals to {{delegateName}} until {{endsAt}}.\n\nThis ADDS an approver. {{delegatorName}} still receives every request and can still decide it.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{delegatorName}}</strong> has delegated approvals to <strong>{{delegateName}}</strong> until {{endsAt}}.</p><p>This <em>adds</em> an approver. {{delegatorName}} still receives every request and can still decide it.</p>',
  },
  'automate-delegation-ended': {
    subject: 'An approval delegation at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\nThe delegation from {{delegatorName}} to {{delegateName}} ended on {{endsAt}}.',
    html: '<p>Hello {{displayName}},</p><p>The delegation from <strong>{{delegatorName}}</strong> to <strong>{{delegateName}}</strong> ended on {{endsAt}}.</p>',
  },
  'automate-sweep-confirmation': {
    subject: 'An expiry sweep at {{tenantName}} needs a decision',
    text: 'Hello {{displayName}},\n\nTonight’s sweep proposed {{actionCount}} removals and stopped without applying any of them.\n\nWhy: {{blockedReason}}\n\n{{sweepUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Tonight’s sweep proposed {{actionCount}} removals and stopped without applying any of them.</p><p>Why: {{blockedReason}}</p><p><a href="{{sweepUrl}}">{{sweepUrl}}</a></p>',
  },
```

- [ ] **Step 4: Write the outbox module**

`packages/core/src/automate/notify.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { TemplateName } from '../notify/templates/index.js';
import type { Permission } from '../rbac/permissions.js';

/**
 * The templates this slice adds. A narrowing of `TemplateName` rather than a
 * second list, so a template renamed in one place fails to compile in the
 * other.
 */
export type AutomateTemplate = Extract<TemplateName, `automate-${string}`>;

/**
 * Failures, blocks and confirmations are never digested, regardless of
 * preference.
 *
 * A digest is a convenience for routine traffic. The traffic that matters is
 * the traffic that says something is stuck, and a stuck request that arrives
 * tomorrow morning in a summary is a stuck request nobody acted on today.
 */
export const NEVER_DIGESTED: readonly AutomateTemplate[] = [
  'automate-fulfilment-failed',
  'automate-partially-fulfilled',
  'automate-awaiting-fulfilment-sla',
  'automate-blocked-no-approver',
  'automate-sweep-confirmation',
];

export function isDigestible(template: AutomateTemplate): boolean {
  return !NEVER_DIGESTED.includes(template);
}

export interface OutboxDraft {
  template: AutomateTemplate;
  to: string;
  vars: Record<string, string>;
  requestId: string | null;
  /** Who it is for, so a digest preference can be honoured. */
  userId: string | null;
}

/**
 * Writes messages down. Sends nothing.
 *
 * Takes a `TenantClient` and no `Transport`, which is what makes the ordering
 * structural rather than remembered: `sendMessage` takes a `Transport` and no
 * `TenantClient`, so the shape that put an SMTP round trip inside
 * `prisma.$transaction` -- twice, on this project -- does not type-check from
 * either end.
 *
 * Returns how many rows were written, so a caller can assert on it without a
 * second query.
 */
export async function enqueueOutbox(
  tx: TenantClient,
  drafts: readonly OutboxDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0;
  const tenantId = await currentTenant(tx);

  const userIds = drafts
    .map((d) => d.userId)
    .filter((id): id is string => id !== null);
  const preferences =
    userIds.length === 0
      ? []
      : await tx.notificationPreference.findMany({
          where: { userId: { in: userIds }, mode: 'daily' },
          select: { userId: true },
        });
  const wantsDigest = new Set(preferences.map((p) => p.userId));

  await tx.notificationOutbox.createMany({
    data: drafts.map((draft) => ({
      tenantId,
      template: draft.template,
      to: draft.to,
      vars: draft.vars,
      requestId: draft.requestId,
      userId: draft.userId,
      digest:
        isDigestible(draft.template) &&
        draft.userId !== null &&
        wantsDigest.has(draft.userId),
    })),
  });

  return drafts.length;
}

export interface Recipient {
  userId: string;
  personId: string | null;
  email: string;
  displayName: string;
}

/**
 * The active accounts belonging to these people.
 *
 * A person with several accounts is told once per account, deliberately: an
 * application granted to a person is granted to that person, and picking one
 * of their logins arbitrarily is a support call waiting to happen. A person
 * with no account at all yields nothing, which is a fact the caller may need
 * to notice rather than an error.
 */
export async function recipientsForPersons(
  tx: TenantClient,
  personIds: readonly string[],
): Promise<Recipient[]> {
  const unique = [...new Set(personIds)];
  if (unique.length === 0) return [];
  const users = await tx.user.findMany({
    where: { personId: { in: unique }, status: 'active' },
    select: { id: true, personId: true, email: true, displayName: true },
    orderBy: { login: 'asc' },
  });
  return users.map((u) => ({
    userId: u.id,
    personId: u.personId,
    email: u.email,
    displayName: u.displayName,
  }));
}

/**
 * Everybody who holds a permission, for the notifications addressed to a
 * capability rather than to a person -- a blocked request, a failed
 * fulfilment, a sweep awaiting confirmation.
 *
 * Reads role assignments and filters in memory because `Role.permissions` is a
 * string array on the row rather than a join table: `hasPermission` does the
 * same, and this is its inverse. Inactive accounts are excluded, because
 * telling a deactivated account that a request is stuck reaches nobody and
 * makes the queue look attended.
 */
export async function usersWithPermission(
  tx: TenantClient,
  permission: Permission,
): Promise<Recipient[]> {
  const assignments = await tx.roleAssignment.findMany({ include: { role: true } });
  const userIds = [
    ...new Set(
      assignments
        .filter((a) => a.role.permissions.includes(permission))
        .map((a) => a.userId),
    ),
  ];
  if (userIds.length === 0) return [];

  const users = await tx.user.findMany({
    where: { id: { in: userIds }, status: 'active' },
    select: { id: true, personId: true, email: true, displayName: true },
    orderBy: { login: 'asc' },
  });
  return users.map((u) => ({
    userId: u.id,
    personId: u.personId,
    email: u.email,
    displayName: u.displayName,
  }));
}
```

- [ ] **Step 5: Add the three permissions**

In `packages/core/src/rbac/permissions.ts`, inside the `PERMISSIONS` object, after `POLICY_MANAGE`:

```ts
  AUTOMATE_READ: 'automate.read',
  AUTOMATE_MANAGE: 'automate.manage',
  AUTOMATE_REQUEST_ON_BEHALF: 'automate.request_on_behalf',
```

`automate.read` gates the request queue, the products, the grants and the console. `automate.manage` gates creating and editing products, workflows, resource owners and delegations, confirming a sweep, and deciding a `blocked_no_approver` request. `automate.request_on_behalf` gates submitting for somebody who is neither you nor your report.

**There is deliberately no `automate.approve`.** Approval authority comes from resolution, not from RBAC, and a permission that granted it would be a tenant-wide right to approve anything. **Requesting for yourself needs no permission either**: every portal user may open the catalog, and what they see there is the audience decision — putting a permission in front of it would make an unconfigured tenant's catalog empty for a second, unrelated reason.

- [ ] **Step 6: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/approvers.js';`:

```ts
export * from './automate/notify.js';
```

- [ ] **Step 7: Run the test**

Run: `pnpm vitest run packages/core/src/automate/notify.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove no existing suite regressed on the permission catalogue**

Run: `pnpm vitest run packages/core/src/rbac`
Expected: PASS. `ALL_PERMISSIONS` is derived from `Object.values(PERMISSIONS)`, so the three additions flow through without a second edit — but the RBAC suite asserts on the catalogue and is the place a hand-maintained duplicate would show up.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/notify/templates/index.ts \
        packages/core/src/automate/notify.ts \
        packages/core/src/automate/notify.test.ts \
        packages/core/src/rbac/permissions.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): the notification outbox, templates and permissions"
```

---

## Task 6: The catalog, the settings, and the one visibility resolver

Spec §6 and §15. **Every read path in this slice goes through `visibleProducts` or `findVisibleProduct`.** A filter applied by the console and not by search is the leak, and search is the endpoint that gets written last.

**Files:**
- Create: `packages/core/src/automate/catalog-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/catalog-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `currentTenant` from `../tenant-context.js`; `recordEvent` from `../audit/audit-service.js`; `activeContracts` from `../identity/contract-service.js`; `type ConditionFacts` from `../provision/condition.js`; `audienceAdmits`, `audienceConditionSchema`, `type AudienceCondition`, `type SubjectSetFacts` from `./audience.js`; `formSchemaSchema`, `type FormSchema` from `./form.js`; `type DurationMode` from `./duration.js`; `type ProductKind`, `type ResourceType`, `RESOURCE_TYPE_FOR_KIND`, `LIVE_GRANT_STATUSES` from `./types.js`.
- Produces:
  - `class ProductConfigurationError extends Error { constructor(readonly code: string, message: string) }`
  - `interface ProductGrantInput { resourceType: ResourceType; resourceId: string; targetSystemId?: string | null; optional?: boolean }`
  - `interface ProductInput { name: string; slug: string; description?: string | null; category?: string | null; iconUrl?: string | null; requestInstructions?: string | null; kind: ProductKind; grants: ProductGrantInput[]; audienceCondition: AudienceCondition | null; workflowId: string; formSchema: FormSchema; durationMode: DurationMode; defaultDurationDays: number | null; maxDurationDays: number | null; ownerPersonId: string | null; ownerGroupId: string | null; status: 'draft' | 'active' | 'retired' }`
  - `async function createProduct(tenantId: string, actorUserId: string | null, input: ProductInput): Promise<{ id: string }>`
  - `async function updateProduct(tenantId: string, actorUserId: string | null, productId: string, input: ProductInput): Promise<void>`
  - `async function listAllProducts(tx: TenantClient)` — the console read, unfiltered, behind `automate.read`
  - `interface SubjectAudienceFacts extends SubjectSetFacts { contracts: ConditionFacts[]; hasActiveContract: boolean; personStatus: string }`
  - `async function subjectAudienceFacts(tx: TenantClient, personId: string, on: Date): Promise<SubjectAudienceFacts>`
  - `async function orgUnitChainFor(tx: TenantClient, orgUnitId: string | null): Promise<string[]>`
  - `async function visibleProducts(tx: TenantClient, personId: string, on?: Date): Promise<Product[]>`
  - `async function findVisibleProduct(tx: TenantClient, personId: string, productId: string, on?: Date): Promise<Product | null>`
  - `async function searchVisibleProducts(tx: TenantClient, personId: string, query: string, on?: Date): Promise<Product[]>`
  - `interface AudiencePreview { matched: number; total: number; sample: { personId: string; displayName: string }[] }`
  - `async function previewAudience(tenantId: string, condition: AudienceCondition | null, limit?: number, on?: Date): Promise<AudiencePreview>`
  - `async function automateSettings(tx: TenantClient)` — get-or-create the single row
  - `async function updateAutomateSettings(tenantId: string, actorUserId: string | null, input: Record<string, unknown>): Promise<void>`
  - `async function upsertResourceOwner(tenantId: string, actorUserId: string | null, input: { resourceType: ResourceType; resourceId: string; ownerPersonId: string | null; ownerGroupId: string | null }): Promise<void>`
  - `type Product` is Prisma's generated `Product` row type, imported by consumers from `@prisma/client` where they need to name it.

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/catalog-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  ProductConfigurationError,
  automateSettings,
  createProduct,
  findVisibleProduct,
  previewAudience,
  searchVisibleProducts,
  subjectAudienceFacts,
  updateAutomateSettings,
  visibleProducts,
  type ProductInput,
} from './catalog-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let workflowId: string;
let annaPersonId: string;
let boPersonId: string;
let applicationId: string;
let localGroupId: string;
let syncedGroupId: string;

const product = (over: Partial<ProductInput> = {}): ProductInput => ({
  name: 'Statistics licence',
  slug: 'statistics-licence',
  kind: 'application',
  grants: [{ resourceType: 'application', resourceId: applicationId }],
  audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
  workflowId,
  formSchema: [],
  durationMode: 'permanent',
  defaultDurationDays: null,
  maxDurationDays: null,
  ownerPersonId: null,
  ownerGroupId: null,
  status: 'active',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Manager approval' },
    });
    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    const bo = await tx.person.create({
      data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: bo.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Facilities',
      },
    });
    const application = await tx.application.create({
      data: { tenantId, name: 'Stats', slug: 'stats' },
    });
    const local = await tx.group.create({ data: { tenantId, name: 'Reading room' } });
    const source = await tx.directorySource.create({
      data: {
        tenantId,
        name: 'Corporate LDAP',
        type: 'ldap',
        config: {},
        secretName: 'source/ldap/bind',
      },
    });
    const synced = await tx.group.create({
      data: {
        tenantId,
        name: 'Domain Users',
        sourceId: source.id,
        sourceAnchor: 'guid-domain-users',
      },
    });
    return {
      workflowId: workflow.id,
      annaPersonId: anna.id,
      boPersonId: bo.id,
      applicationId: application.id,
      localGroupId: local.id,
      syncedGroupId: synced.id,
    };
  });
  ({ workflowId, annaPersonId, boPersonId, applicationId, localGroupId, syncedGroupId } =
    seeded);
});

describe('visibility', () => {
  it('shows a product to somebody the audience admits and hides it from everybody else', async () => {
    await createProduct(tenantId, null, product());
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    const forBo = await withTenant(tenantId, (tx) => visibleProducts(tx, boPersonId, NOW));
    expect(forAnna.map((p) => p.slug)).toEqual(['statistics-licence']);
    expect(forBo).toEqual([]);
  });

  it('shows a product with a null audience to NOBODY, including its own owner', async () => {
    // The security default of the catalog. A product nobody configured is a
    // product nobody sees, and the editor says so.
    await createProduct(
      tenantId,
      null,
      product({ audienceCondition: null, ownerPersonId: annaPersonId }),
    );
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    expect(forAnna).toEqual([]);
  });

  it('shows a product with an empty all to anybody with an active contract', async () => {
    await createProduct(tenantId, null, product({ audienceCondition: { all: [] } }));
    const forBo = await withTenant(tenantId, (tx) => visibleProducts(tx, boPersonId, NOW));
    expect(forBo.map((p) => p.slug)).toEqual(['statistics-licence']);
  });

  it('hides a draft and a retired product from the catalog', async () => {
    await createProduct(tenantId, null, product({ slug: 'a-draft', status: 'draft' }));
    await createProduct(
      tenantId,
      null,
      product({ slug: 'a-retired', name: 'Retired', status: 'retired' }),
    );
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    expect(forAnna).toEqual([]);
  });

  it('answers findVisibleProduct with null rather than the row for somebody excluded', async () => {
    // Null, so the route can answer 404. A 403 confirms the thing exists, and
    // "Payroll — Executive Compensation Reporting" existing is itself
    // information about the organization.
    const { id } = await createProduct(tenantId, null, product());
    expect(
      await withTenant(tenantId, (tx) => findVisibleProduct(tx, boPersonId, id, NOW)),
    ).toBeNull();
    expect(
      await withTenant(tenantId, (tx) => findVisibleProduct(tx, annaPersonId, id, NOW)),
    ).not.toBeNull();
  });

  it('applies the same rule to search, which is the endpoint that gets written last', async () => {
    await createProduct(tenantId, null, product());
    const hits = await withTenant(tenantId, (tx) =>
      searchVisibleProducts(tx, boPersonId, 'statistic', NOW),
    );
    expect(hits).toEqual([]);
    const own = await withTenant(tenantId, (tx) =>
      searchVisibleProducts(tx, annaPersonId, 'STATISTIC', NOW),
    );
    expect(own.map((p) => p.slug)).toEqual(['statistics-licence']);
  });

  it('hides everything from somebody whose contracts have all ended', async () => {
    await createProduct(tenantId, null, product({ audienceCondition: { all: [] } }));
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { endDate: day('2026-01-01') },
      }),
    );
    expect(
      await withTenant(tenantId, (tx) => visibleProducts(tx, annaPersonId, NOW)),
    ).toEqual([]);
  });
});

describe('subjectAudienceFacts', () => {
  it('carries the group membership and org unit chain of every account the person holds', async () => {
    const { groupId, parentOrgUnitId } = await withTenant(tenantId, async (tx) => {
      const parent = await tx.orgUnit.create({ data: { tenantId, name: 'Head Office' } });
      const child = await tx.orgUnit.create({
        data: { tenantId, name: 'Finance', parentId: parent.id },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          personId: annaPersonId,
          orgUnitId: child.id,
        },
      });
      const group = await tx.group.create({ data: { tenantId, name: 'Analysts' } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: user.id },
      });
      return { groupId: group.id, parentOrgUnitId: parent.id };
    });

    const facts = await withTenant(tenantId, (tx) =>
      subjectAudienceFacts(tx, annaPersonId, NOW),
    );
    expect(facts.groupIds).toContain(groupId);
    // The chain, not only the leaf: a product offered to Head Office reaches
    // everyone under it.
    expect(facts.orgUnitChainIds).toContain(parentOrgUnitId);
    expect(facts.hasActiveContract).toBe(true);
  });

  it('counts an entitlement held through a live grant as held', async () => {
    // person.hasEntitlement exists for the product that only makes sense to
    // somebody who already holds the base licence. A grant that Provision has
    // not applied yet still counts: the person asked, somebody approved, and
    // the second product should be offerable now rather than after the run.
    const entitlementId = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'target/ad/bind',
          config: { url: 'ldaps://dc.acme.test:636', tlsMode: 'ldaps' },
        },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-base',
          type: 'group',
          displayName: 'Base licence',
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: annaPersonId,
          resourceType: 'entitlement',
          resourceId: entitlement.id,
          targetSystemId: target.id,
          startsAt: day('2026-06-01'),
          status: 'pending',
        },
      });
      return entitlement.id;
    });

    const facts = await withTenant(tenantId, (tx) =>
      subjectAudienceFacts(tx, annaPersonId, NOW),
    );
    expect(facts.entitlementIds).toContain(entitlementId);
  });
});

describe('createProduct — the configurations that are refused', () => {
  it('refuses a localGroup product naming a group a directory source owns', async () => {
    // Its membership is rewritten by that source every run; a request-granted
    // membership would survive until the small hours and then vanish, which is
    // worse than refusing it.
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'domain-users',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: syncedGroupId }],
      }),
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProductConfigurationError);
    expect((failure as ProductConfigurationError).code).toBe('group-is-synced');
    // Naming the owning source is the difference between a refusal somebody
    // can act on and one they argue with.
    expect((failure as Error).message).toContain('Corporate LDAP');
  });

  it('accepts a localGroup product naming a locally-managed group', async () => {
    const created = await createProduct(
      tenantId,
      null,
      product({
        slug: 'reading-room',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: localGroupId }],
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('refuses a bundle whose entitlements span two target systems', async () => {
    // One Provision run must be able to fulfil the whole thing, or the bundle
    // has a fulfilment path that cannot be represented.
    const { entA, entB, targetA, targetB } = await withTenant(tenantId, async (tx) => {
      const a = await tx.targetSystem.create({
        data: { tenantId, name: 'AD A', secretName: 's/a', config: { tlsMode: 'ldaps' } },
      });
      const b = await tx.targetSystem.create({
        data: { tenantId, name: 'AD B', secretName: 's/b', config: { tlsMode: 'ldaps' } },
      });
      const entA = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: a.id,
          externalId: 'g-a',
          type: 'group',
          displayName: 'A',
          requestable: true,
        },
      });
      const entB = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: b.id,
          externalId: 'g-b',
          type: 'group',
          displayName: 'B',
          requestable: true,
        },
      });
      return { entA: entA.id, entB: entB.id, targetA: a.id, targetB: b.id };
    });

    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'two-domains',
        kind: 'targetEntitlement',
        grants: [
          { resourceType: 'entitlement', resourceId: entA, targetSystemId: targetA },
          { resourceType: 'entitlement', resourceId: entB, targetSystemId: targetB },
        ],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('bundle-spans-targets');
  });

  it('refuses an entitlement that has not been marked requestable', async () => {
    const { entitlementId, targetSystemId } = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'g-secret',
          type: 'group',
          displayName: 'Domain Admins',
        },
      });
      return { entitlementId: entitlement.id, targetSystemId: target.id };
    });
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'domain-admins',
        kind: 'targetEntitlement',
        grants: [{ resourceType: 'entitlement', resourceId: entitlementId, targetSystemId }],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('entitlement-not-requestable');
  });

  it('refuses a grant whose resource type does not match the product kind', async () => {
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'confused',
        kind: 'localGroup',
        grants: [{ resourceType: 'application', resourceId: applicationId }],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('kind-mismatch');
  });

  it('refuses a product with no grants at all', async () => {
    const failure = await createProduct(
      tenantId,
      null,
      product({ slug: 'empty', grants: [] }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('no-grants');
  });

  it('writes an audit event carrying the audience before and after', async () => {
    const { id } = await createProduct(tenantId, null, product());
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.product.create' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe(id);
    expect(events[0]?.payload).toMatchObject({ slug: 'statistics-licence' });
  });
});

describe('previewAudience', () => {
  it('counts who a condition would admit, out of everybody with an active contract', async () => {
    // The direct analogue of Provision's business-rule impact preview, and it
    // exists for the same reason: an audience whose blast radius is only
    // visible after saving is an audience that gets saved and then discovered.
    const preview = await previewAudience(
      tenantId,
      { field: 'contract.department', op: 'equals', value: 'Finance' },
      10,
      NOW,
    );
    expect(preview).toMatchObject({ matched: 1, total: 2 });
    expect(preview.sample.map((s) => s.displayName)).toEqual(['Anna Novak']);
  });

  it('reports zero for a null condition rather than everybody', async () => {
    const preview = await previewAudience(tenantId, null, 10, NOW);
    expect(preview.matched).toBe(0);
  });
});

describe('automateSettings', () => {
  it('creates the row on first read with the spec defaults', async () => {
    const settings = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(settings.sweepThresholdPercent).toBe(10);
    expect(settings.delegatedBulkLimit).toBe(25);
    const again = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(again.id).toBe(settings.id);
  });

  it('audits a threshold change with the before and after', async () => {
    // Lowering a sweep threshold is functionally the same act as approving
    // everything it would otherwise have caught.
    await updateAutomateSettings(tenantId, null, { sweepThresholdPercent: 90 });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.settings.update' } }),
    );
    expect(events[0]?.payload).toMatchObject({
      changed: { sweepThresholdPercent: { from: 10, to: 90 } },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/catalog-service.test.ts`
Expected: FAIL, "Failed to resolve import ./catalog-service.js".

- [ ] **Step 3: Write the catalog service**

`packages/core/src/automate/catalog-service.ts`:

```ts
import type { Product } from '@prisma/client';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { activeContracts } from '../identity/contract-service.js';
import type { ConditionFacts } from '../provision/condition.js';
import {
  audienceAdmits,
  audienceConditionSchema,
  type AudienceCondition,
  type SubjectSetFacts,
} from './audience.js';
import { formSchemaSchema, type FormSchema } from './form.js';
import type { DurationMode } from './duration.js';
import {
  LIVE_GRANT_STATUSES,
  RESOURCE_TYPE_FOR_KIND,
  type ProductKind,
  type ResourceType,
} from './types.js';

/**
 * A configuration the catalog refuses, with a code the API turns into a
 * problem type and the console turns into a message against the right field.
 */
export class ProductConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProductConfigurationError';
  }
}

export interface ProductGrantInput {
  resourceType: ResourceType;
  resourceId: string;
  targetSystemId?: string | null;
  optional?: boolean;
}

export interface ProductInput {
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  iconUrl?: string | null;
  requestInstructions?: string | null;
  kind: ProductKind;
  grants: ProductGrantInput[];
  /** NULL MEANS NOBODY. */
  audienceCondition: AudienceCondition | null;
  workflowId: string;
  formSchema: FormSchema;
  durationMode: DurationMode;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  ownerPersonId: string | null;
  ownerGroupId: string | null;
  status: 'draft' | 'active' | 'retired';
}

/**
 * Everything a product's configuration is refused for, in one place, so the
 * create path and the update path cannot disagree about what is legal.
 */
async function validateProduct(tx: TenantClient, input: ProductInput): Promise<void> {
  if (input.audienceCondition !== null) {
    audienceConditionSchema.parse(input.audienceCondition);
  }
  formSchemaSchema.parse(input.formSchema);

  if (input.grants.length === 0) {
    throw new ProductConfigurationError(
      'no-grants',
      'A product has to grant something. Name at least one resource.',
    );
  }

  const expected = RESOURCE_TYPE_FOR_KIND[input.kind];
  for (const grant of input.grants) {
    if (grant.resourceType !== expected) {
      throw new ProductConfigurationError(
        'kind-mismatch',
        `A ${input.kind} product grants ${expected} resources, not ${grant.resourceType}.`,
      );
    }
  }

  if (input.kind === 'targetEntitlement') {
    const targets = new Set(input.grants.map((g) => g.targetSystemId ?? ''));
    if (targets.size > 1) {
      throw new ProductConfigurationError(
        'bundle-spans-targets',
        'Every entitlement in one product must belong to the same target system, so a single Provision run can fulfil the whole request.',
      );
    }
    const entitlements = await tx.entitlement.findMany({
      where: { id: { in: input.grants.map((g) => g.resourceId) } },
      select: { id: true, displayName: true, requestable: true, targetSystemId: true },
    });
    for (const grant of input.grants) {
      const entitlement = entitlements.find((e) => e.id === grant.resourceId);
      if (entitlement === undefined) {
        throw new ProductConfigurationError(
          'entitlement-missing',
          'One of the entitlements named here no longer exists on that target.',
        );
      }
      if (!entitlement.requestable) {
        throw new ProductConfigurationError(
          'entitlement-not-requestable',
          `${entitlement.displayName} is not marked requestable. Publish it on the target's catalog first.`,
        );
      }
      if (entitlement.targetSystemId !== grant.targetSystemId) {
        throw new ProductConfigurationError(
          'entitlement-target-mismatch',
          `${entitlement.displayName} does not belong to the target system named here.`,
        );
      }
    }
  }

  if (input.kind === 'localGroup') {
    const groups = await tx.group.findMany({
      where: { id: { in: input.grants.map((g) => g.resourceId) } },
      include: { source: { select: { name: true } } },
    });
    for (const grant of input.grants) {
      const group = groups.find((g) => g.id === grant.resourceId);
      if (group === undefined) {
        throw new ProductConfigurationError(
          'group-missing',
          'One of the groups named here no longer exists.',
        );
      }
      // A synced group's membership is rewritten by its source every run. A
      // request-granted membership would survive until the small hours and
      // then vanish, which is worse than refusing it here. The correct way to
      // request one is as the targetEntitlement it corresponds to.
      if (group.sourceId !== null) {
        throw new ProductConfigurationError(
          'group-is-synced',
          `${group.name} is owned by the directory source ${group.source?.name ?? 'unknown'}, which rewrites its membership on every run. Request the target entitlement it comes from instead.`,
        );
      }
    }
  }

  const workflow = await tx.approvalWorkflow.findUnique({
    where: { id: input.workflowId },
    select: { id: true },
  });
  if (workflow === null) {
    throw new ProductConfigurationError(
      'workflow-missing',
      'That approval workflow does not exist.',
    );
  }
}

function productData(input: ProductInput, tenantId: string) {
  return {
    tenantId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    category: input.category ?? null,
    iconUrl: input.iconUrl ?? null,
    requestInstructions: input.requestInstructions ?? null,
    kind: input.kind,
    audienceCondition: input.audienceCondition ?? undefined,
    workflowId: input.workflowId,
    formSchema: input.formSchema,
    durationMode: input.durationMode,
    defaultDurationDays: input.defaultDurationDays,
    maxDurationDays: input.maxDurationDays,
    ownerPersonId: input.ownerPersonId,
    ownerGroupId: input.ownerGroupId,
    status: input.status,
  };
}

export async function createProduct(
  tenantId: string,
  actorUserId: string | null,
  input: ProductInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    await validateProduct(tx, input);
    const created = await tx.product.create({ data: productData(input, tenantId) });
    await tx.productGrant.createMany({
      data: input.grants.map((grant) => ({
        tenantId,
        productId: created.id,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId ?? null,
        optional: grant.optional ?? false,
      })),
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.product.create',
      targetType: 'Product',
      targetId: created.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        slug: input.slug,
        kind: input.kind,
        status: input.status,
        audienceCondition: input.audienceCondition,
        grants: input.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
      },
    });
    return { id: created.id };
  });
}

/**
 * Replaces a product whole.
 *
 * The audit payload carries before and after, because a product's workflow
 * edited from two stages to zero is functionally the same act as approving
 * everything that product will ever grant, and the record of it has to survive
 * the edit.
 */
export async function updateProduct(
  tenantId: string,
  actorUserId: string | null,
  productId: string,
  input: ProductInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await validateProduct(tx, input);
    const before = await tx.product.findUnique({
      where: { id: productId },
      include: { grants: true },
    });
    if (before === null) {
      throw new ProductConfigurationError('not-found', 'That product does not exist.');
    }

    await tx.product.update({ where: { id: productId }, data: productData(input, tenantId) });
    await tx.productGrant.deleteMany({ where: { productId } });
    await tx.productGrant.createMany({
      data: input.grants.map((grant) => ({
        tenantId,
        productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId ?? null,
        optional: grant.optional ?? false,
      })),
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.product.update',
      targetType: 'Product',
      targetId: productId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        before: {
          status: before.status,
          workflowId: before.workflowId,
          audienceCondition: before.audienceCondition,
          grants: before.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
        },
        after: {
          status: input.status,
          workflowId: input.workflowId,
          audienceCondition: input.audienceCondition,
          grants: input.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
        },
      },
    });
  });
}

/** Every product, for the console. Behind `automate.read`, never the portal. */
export async function listAllProducts(tx: TenantClient) {
  return tx.product.findMany({ include: { grants: true }, orderBy: { name: 'asc' } });
}

export interface SubjectAudienceFacts extends SubjectSetFacts {
  contracts: ConditionFacts[];
  hasActiveContract: boolean;
  personStatus: string;
}

/**
 * The org unit a user sits in, and every unit above it.
 *
 * A local walk rather than a call into `access/resolve.ts`, whose `orgUnitChain`
 * is module-private and not exported. The depth cap and the seen-set are the
 * same, and for the same reason: `parentId` is a self-relation with no
 * database-level acyclicity check.
 */
export async function orgUnitChainFor(
  tx: TenantClient,
  orgUnitId: string | null,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = orgUnitId;

  for (let depth = 0; current !== null && depth < 64; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const row = await tx.orgUnit.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
  }
  return chain;
}

/**
 * Everything the audience evaluator needs about one person, read once.
 *
 * `entitlementIds` counts both what the target actually holds and what a LIVE
 * grant says they hold. A grant Provision has not applied yet still counts:
 * the person asked, somebody accountable approved, and a second product
 * gated on the first should be offerable now rather than after the next run.
 */
export async function subjectAudienceFacts(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<SubjectAudienceFacts> {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  const contracts = await activeContracts(tx, personId, on);
  const users = await tx.user.findMany({
    where: { personId },
    select: { id: true, orgUnitId: true },
  });

  const groupIds = new Set<string>();
  const orgUnitChainIds = new Set<string>();
  for (const user of users) {
    const memberships = await tx.groupMembership.findMany({
      where: { userId: user.id },
      select: { groupId: true },
    });
    for (const membership of memberships) groupIds.add(membership.groupId);
    for (const unit of await orgUnitChainFor(tx, user.orgUnitId)) {
      orgUnitChainIds.add(unit);
    }
  }

  const holdings = await tx.accountEntitlement.findMany({
    where: { state: 'held', account: { personId } },
    select: { entitlementId: true },
  });
  const granted = await tx.accessGrant.findMany({
    where: {
      subjectPersonId: personId,
      resourceType: 'entitlement',
      status: { in: [...LIVE_GRANT_STATUSES] },
    },
    select: { resourceId: true },
  });

  return {
    personStatus: person?.status ?? 'inactive',
    hasActiveContract: contracts.length > 0,
    groupIds: [...groupIds],
    orgUnitChainIds: [...orgUnitChainIds],
    entitlementIds: [
      ...new Set([
        ...holdings.map((h) => h.entitlementId),
        ...granted.map((g) => g.resourceId),
      ]),
    ],
    contracts: contracts.map((contract) => ({
      'contract.department': contract.department,
      'contract.jobTitle': contract.jobTitle,
      'contract.costCentre': contract.costCentre,
      'contract.employer': contract.employer,
      'contract.location': contract.location,
      // Prisma returns Decimal. The evaluator compares numerically and a
      // Decimal object compared with `>` is a string comparison in disguise.
      'contract.fte': contract.fte === null ? null : Number(contract.fte),
      'person.status': person?.status ?? null,
    })),
  };
}

function admits(product: Product, facts: SubjectAudienceFacts): boolean {
  return audienceAdmits(
    product.audienceCondition as AudienceCondition | null,
    facts.contracts,
    facts,
  );
}

/**
 * THE read path. Every other one calls this or `findVisibleProduct`.
 *
 * `draft` and `retired` products are excluded here rather than by each caller:
 * a draft is a product still being written, and a retired one has stopped
 * accepting requests. Neither is a catalog entry.
 */
export async function visibleProducts(
  tx: TenantClient,
  personId: string,
  on: Date = new Date(),
): Promise<Product[]> {
  const facts = await subjectAudienceFacts(tx, personId, on);
  const products = await tx.product.findMany({
    where: { status: 'active' },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  return products.filter((product) => admits(product, facts));
}

/**
 * Null rather than the row when the caller's audience does not admit it, so
 * the route answers 404. A 403 confirms the thing exists.
 */
export async function findVisibleProduct(
  tx: TenantClient,
  personId: string,
  productId: string,
  on: Date = new Date(),
): Promise<Product | null> {
  const product = await tx.product.findFirst({
    where: { id: productId, status: 'active' },
  });
  if (product === null) return null;
  const facts = await subjectAudienceFacts(tx, personId, on);
  return admits(product, facts) ? product : null;
}

/**
 * Search, filtered by exactly the same resolver. This is the endpoint the
 * whole "one resolver" rule exists for: a filter applied in the console and
 * not in search is the leak.
 */
export async function searchVisibleProducts(
  tx: TenantClient,
  personId: string,
  query: string,
  on: Date = new Date(),
): Promise<Product[]> {
  const visible = await visibleProducts(tx, personId, on);
  const needle = query.trim().toLowerCase();
  if (needle === '') return visible;
  return visible.filter(
    (product) =>
      product.name.toLowerCase().includes(needle) ||
      (product.description ?? '').toLowerCase().includes(needle) ||
      (product.category ?? '').toLowerCase().includes(needle),
  );
}

export interface AudiencePreview {
  matched: number;
  total: number;
  sample: { personId: string; displayName: string }[];
}

/**
 * "Visible to 412 of 1,180 persons — show me who."
 *
 * The direct analogue of Provision's business-rule impact preview, and it
 * exists for the same reason: an audience whose blast radius is only visible
 * after saving is an audience that gets saved and then discovered.
 */
export async function previewAudience(
  tenantId: string,
  condition: AudienceCondition | null,
  limit = 25,
  on: Date = new Date(),
): Promise<AudiencePreview> {
  return withTenant(tenantId, async (tx) => {
    const persons = await tx.person.findMany({
      select: { id: true, givenName: true, familyName: true },
      orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
    });

    let total = 0;
    let matched = 0;
    const sample: { personId: string; displayName: string }[] = [];

    for (const person of persons) {
      const facts = await subjectAudienceFacts(tx, person.id, on);
      if (!facts.hasActiveContract) continue;
      total += 1;
      if (!audienceAdmits(condition, facts.contracts, facts)) continue;
      matched += 1;
      if (sample.length < limit) {
        sample.push({
          personId: person.id,
          displayName: `${person.givenName} ${person.familyName}`,
        });
      }
    }

    return { matched, total, sample };
  });
}

/**
 * The tenant's settings row, created on first read.
 *
 * Get-or-create rather than seeded at tenant creation, because Automate lands
 * after tenants already exist and a nullable settings read scattered through
 * six services is six places to forget the defaults.
 */
export async function automateSettings(tx: TenantClient) {
  const tenantId = await currentTenant(tx);
  const existing = await tx.automateSettings.findUnique({ where: { tenantId } });
  if (existing !== null) return existing;
  return tx.automateSettings.create({ data: { tenantId } });
}

const SETTING_KEYS = [
  'sweepSchedule',
  'sweepThresholdPercent',
  'perProductSweepThresholdPercent',
  'personPopulationDropPercent',
  'fulfilmentSlaHours',
  'expiryWarningDays',
  'preHireHorizonDays',
  'maxDelegationDays',
  'maxApprovers',
  'delegatedBulkLimit',
] as const;

/**
 * Changing a threshold is a privileged action for the reason Provision treats
 * it as one: lowering it is functionally the same act as approving everything
 * it would otherwise have caught. The audit payload names every field that
 * moved, with both values.
 */
export async function updateAutomateSettings(
  tenantId: string,
  actorUserId: string | null,
  input: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const before = (await automateSettings(tx)) as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    for (const key of SETTING_KEYS) {
      if (!(key in input)) continue;
      const next = input[key];
      if (next === before[key]) continue;
      data[key] = next;
      changed[key] = { from: before[key], to: next };
    }
    if (Object.keys(data).length === 0) return;

    await tx.automateSettings.update({ where: { tenantId }, data });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.settings.update',
      targetType: 'AutomateSettings',
      targetId: tenantId,
      outcome: 'success',
      sourceIp: null,
      payload: { changed },
    });
  });
}

/**
 * Records who owns a resource, for the `resourceOwner` selector.
 *
 * A separate table rather than a column on `Entitlement`, `Application` and
 * `Group`, because two of those three are owned by other subsystems.
 */
export async function upsertResourceOwner(
  tenantId: string,
  actorUserId: string | null,
  input: {
    resourceType: ResourceType;
    resourceId: string;
    ownerPersonId: string | null;
    ownerGroupId: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.resourceOwner.upsert({
      where: {
        tenantId_resourceType_resourceId: {
          tenantId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
      },
      create: {
        tenantId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
      update: {
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.resource_owner.set',
      targetType: 'ResourceOwner',
      targetId: input.resourceId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        resourceType: input.resourceType,
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
    });
  });
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/notify.js';`:

```ts
export * from './automate/catalog-service.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/catalog-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/catalog-service.ts \
        packages/core/src/automate/catalog-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): the catalog, settings, and the closed-by-default visibility resolver"
```

---

## Task 7: Workflows — storage, save-time validation, and the resolution preview

Spec §8. The screen that catches a workflow resolving to nobody, a missing fallback, and a stage where the subject is the only approver — **before it is saved rather than at 3am on somebody's request**.

**Files:**
- Create: `packages/core/src/automate/workflow-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/workflow-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `currentTenant`; `recordEvent`; `listMembers` from `../directory/group-service.js`; `resolveStageApprovers`, `resolveEscalationApprovers`, `type ApproverSelector`, `type SelectorConfig`, `type StageSnapshot`, `type DropReason` from `./approvers.js`; `automateSettings` from `./catalog-service.js`.
- Produces:
  - `class WorkflowConfigurationError extends Error { constructor(readonly code: string, message: string) }`
  - `interface StageInput { sequence: number; name: string; selector: ApproverSelector; selectorConfig: SelectorConfig; quorum: 'any' | 'all'; fallbackSelector: ApproverSelector | null; fallbackConfig: SelectorConfig; slaHours: number; onTimeout: 'remind' | 'escalate' | 'expire'; escalationSelector: ApproverSelector | null; escalationConfig: SelectorConfig; expiryHours: number | null }`
  - `interface WorkflowInput { name: string; description: string | null; enabled: boolean; stages: StageInput[] }`
  - `async function upsertWorkflow(tenantId: string, actorUserId: string | null, workflowId: string | null, input: WorkflowInput): Promise<{ id: string }>`
  - `async function loadWorkflowStages(tx: TenantClient, workflowId: string): Promise<StageSnapshot[]>`
  - `interface StagePreview { sequence: number; name: string; selector: ApproverSelector; quorum: 'any' | 'all'; usedFallback: boolean; approvers: { personId: string; displayName: string; via: string }[]; dropped: { personId: string; displayName: string; reason: DropReason }[]; blocked: boolean }`
  - `async function previewWorkflowResolution(tenantId: string, workflowId: string, subjectPersonId: string, productId: string | null, on?: Date): Promise<StagePreview[]>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/workflow-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  WorkflowConfigurationError,
  loadWorkflowStages,
  previewWorkflowResolution,
  upsertWorkflow,
  type StageInput,
  type WorkflowInput,
} from './workflow-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let janPersonId: string;
let securityGroupId: string;

const stage = (over: Partial<StageInput> = {}): StageInput => ({
  sequence: 1,
  name: 'Manager',
  selector: 'manager',
  selectorConfig: {},
  quorum: 'any',
  fallbackSelector: 'person',
  fallbackConfig: { personId: janPersonId },
  slaHours: 48,
  onTimeout: 'remind',
  escalationSelector: null,
  escalationConfig: {},
  expiryHours: null,
  ...over,
});

const workflow = (over: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: 'Two stage',
  description: null,
  enabled: true,
  stages: [stage()],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const jan = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: jan.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
      },
    });
    await tx.user.create({
      data: {
        tenantId,
        login: 'jan',
        email: 'jan@acme.test',
        displayName: 'Jan de Vries',
        personId: jan.id,
      },
    });
    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        managerPersonId: jan.id,
      },
    });
    await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: anna.id,
      },
    });
    const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
    return { annaPersonId: anna.id, janPersonId: jan.id, securityGroupId: group.id };
  });
  ({ annaPersonId, janPersonId, securityGroupId } = seeded);
});

describe('upsertWorkflow', () => {
  it('stores a workflow and reads its stages back as snapshots', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    const stages = await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id));
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      sequence: 1,
      selector: 'manager',
      quorum: 'any',
      onTimeout: 'remind',
      fallbackSelector: 'person',
    });
  });

  it('accepts a workflow with zero stages and says loudly what that means', async () => {
    // The empty list IS the auto-grant mechanism -- not a flag, not a special
    // case. Configuring one is a privileged act with an audit event, because
    // a workflow edited from two stages to zero is functionally the same act
    // as approving everything that product will ever grant.
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ name: 'Granted immediately', stages: [] }),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.workflow.upsert' } }),
    );
    expect(events[0]?.payload).toMatchObject({ stageCount: 0, grantsImmediately: true });
    expect(await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id))).toEqual([]);
  });

  it('records the before and after stage count when a workflow is edited to zero', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    await upsertWorkflow(tenantId, null, id, workflow({ stages: [] }));
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'automate.workflow.upsert' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events[1]?.payload).toMatchObject({ previousStageCount: 1, stageCount: 0 });
  });

  it('refuses a manager stage with no fallback, naming the field', async () => {
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ stages: [stage({ fallbackSelector: null })] }),
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkflowConfigurationError);
    expect((failure as WorkflowConfigurationError).code).toBe('fallback-required');
  });

  it('refuses an all quorum on a group larger than maxApprovers', async () => {
    // A stage requiring the unanimous approval of a 400-member group never
    // completes, and a workflow that cannot complete is a request that sits
    // forever.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 12; i += 1) {
        const user = await tx.user.create({
          data: {
            tenantId,
            login: `member${i}`,
            email: `member${i}@acme.test`,
            displayName: `Member ${i}`,
          },
        });
        await tx.groupMembership.create({
          data: { tenantId, groupId: securityGroupId, userId: user.id },
        });
      }
    });
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            quorum: 'all',
            fallbackSelector: null,
          }),
        ],
      }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('quorum-too-large');
    expect((failure as Error).message).toContain('10');
  });

  it('allows an all quorum on a group inside the limit', async () => {
    await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirstOrThrow({ where: { personId: janPersonId } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: securityGroupId, userId: user.id },
      });
    });
    const created = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            quorum: 'all',
            fallbackSelector: null,
          }),
        ],
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('refuses a managerChain depth outside one to five', async () => {
    for (const depth of [0, 6]) {
      const failure = await upsertWorkflow(
        tenantId,
        null,
        null,
        workflow({
          name: `Depth ${depth}`,
          stages: [stage({ selector: 'managerChain', selectorConfig: { depth } })],
        }),
      ).catch((e: unknown) => e);
      expect((failure as WorkflowConfigurationError).code).toBe('chain-depth');
    }
  });

  it('refuses stage sequences that are not one, two, three', async () => {
    // A gap or a duplicate makes "the next stage" ambiguous, and the request
    // walks them in order.
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ stages: [stage({ sequence: 1 }), stage({ sequence: 3 })] }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('sequence-gap');
  });

  it('refuses a selector whose configuration names nothing', async () => {
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [stage({ selector: 'group', selectorConfig: {}, fallbackSelector: null })],
      }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('selector-config-missing');
  });

  it('replaces the stage list whole rather than merging it', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    await upsertWorkflow(
      tenantId,
      null,
      id,
      workflow({
        stages: [
          stage({ sequence: 1, name: 'Owner', selector: 'person', selectorConfig: { personId: janPersonId }, fallbackSelector: null }),
        ],
      }),
    );
    const stages = await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id));
    expect(stages).toHaveLength(1);
    expect(stages[0]?.name).toBe('Owner');
  });
});

describe('previewWorkflowResolution', () => {
  it('names the people a real subject would land on, stage by stage', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ sequence: 1, blocked: false, usedFallback: false });
    expect(preview[0]?.approvers).toEqual([
      { personId: janPersonId, displayName: 'Jan de Vries', via: 'selector' },
    ]);
  });

  it('shows who was dropped and why, by name', async () => {
    // "stage 2: Security Team (4 valid of 6 members; 2 dropped: inactive
    // account, subject)". The reason is the useful half.
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({ selector: 'person', selectorConfig: { personId: annaPersonId }, fallbackSelector: null }),
        ],
      }),
    );
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview[0]?.dropped).toEqual([
      { personId: annaPersonId, displayName: 'Anna Novak', reason: 'subject' },
    ]);
    expect(preview[0]?.blocked).toBe(true);
  });

  it('marks a stage blocked when the selector and the fallback both resolve to nobody', async () => {
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            fallbackSelector: 'group',
            fallbackConfig: { groupId: securityGroupId },
          }),
        ],
      }),
    );
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview[0]?.blocked).toBe(true);
    expect(preview[0]?.approvers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/workflow-service.test.ts`
Expected: FAIL, "Failed to resolve import ./workflow-service.js".

- [ ] **Step 3: Write the workflow service**

`packages/core/src/automate/workflow-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { listMembers } from '../directory/group-service.js';
import {
  resolveStageApprovers,
  type ApproverSelector,
  type DropReason,
  type SelectorConfig,
  type StageSnapshot,
} from './approvers.js';
import { automateSettings } from './catalog-service.js';

export class WorkflowConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowConfigurationError';
  }
}

export type StageInput = StageSnapshot;

export interface WorkflowInput {
  name: string;
  description: string | null;
  enabled: boolean;
  /** An EMPTY list is the auto-grant mechanism. Not a flag, not a special case. */
  stages: StageInput[];
}

const SELECTORS_NEEDING_FALLBACK: ApproverSelector[] = [
  'manager',
  'managerChain',
  'resourceOwner',
];

function requiredConfigKey(selector: ApproverSelector): keyof SelectorConfig | null {
  if (selector === 'role') return 'roleId';
  if (selector === 'group') return 'groupId';
  if (selector === 'person') return 'personId';
  return null;
}

/**
 * The largest number of people a selector could resolve to, for the `all`
 * quorum check.
 *
 * `manager`, `managerChain` and `person` are one by construction.
 * `productOwner` and `resourceOwner` depend on the product and the request and
 * cannot be counted at save time, so they are treated as one -- the honest
 * answer, since the alternative is refusing every `all` stage that uses them.
 */
async function upperBoundOnApprovers(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
): Promise<number> {
  if (selector === 'group' && config.groupId !== undefined) {
    return (await listMembers(tx, config.groupId)).length;
  }
  if (selector === 'role' && config.roleId !== undefined) {
    return tx.roleAssignment.count({ where: { roleId: config.roleId } });
  }
  return 1;
}

async function validateStages(
  tx: TenantClient,
  stages: StageInput[],
  maxApprovers: number,
): Promise<void> {
  const sequences = stages.map((s) => s.sequence);
  const expected = stages.map((_, index) => index + 1);
  if (JSON.stringify([...sequences].sort((a, b) => a - b)) !== JSON.stringify(expected)) {
    throw new WorkflowConfigurationError(
      'sequence-gap',
      'Stages are numbered from one with no gaps and no duplicates; the request walks them in order.',
    );
  }

  for (const stage of stages) {
    if (
      SELECTORS_NEEDING_FALLBACK.includes(stage.selector) &&
      stage.fallbackSelector === null
    ) {
      throw new WorkflowConfigurationError(
        'fallback-required',
        `Stage ${stage.sequence} uses ${stage.selector}, which legitimately resolves to nobody — a person with no manager, a chain shorter than n, a resource whose owner was never recorded. Name a fallback approver.`,
      );
    }

    if (stage.selector === 'managerChain') {
      const depth = stage.selectorConfig.depth;
      if (depth === undefined || !Number.isInteger(depth) || depth < 1 || depth > 5) {
        throw new WorkflowConfigurationError(
          'chain-depth',
          `Stage ${stage.sequence} asks for manager level ${String(depth)}; choose between 1 and 5.`,
        );
      }
    }

    for (const [selector, config, label] of [
      [stage.selector, stage.selectorConfig, 'approver'],
      ...(stage.fallbackSelector === null
        ? []
        : ([[stage.fallbackSelector, stage.fallbackConfig, 'fallback']] as const)),
      ...(stage.escalationSelector === null
        ? []
        : ([[stage.escalationSelector, stage.escalationConfig, 'escalation']] as const)),
    ] as [ApproverSelector, SelectorConfig, string][]) {
      const key = requiredConfigKey(selector);
      if (key !== null && config[key] === undefined) {
        throw new WorkflowConfigurationError(
          'selector-config-missing',
          `Stage ${stage.sequence}: the ${label} uses ${selector} but names no ${key}.`,
        );
      }
    }

    if (stage.onTimeout === 'expire' && stage.expiryHours === null) {
      throw new WorkflowConfigurationError(
        'expiry-hours-required',
        `Stage ${stage.sequence} expires requests, so it needs an expiry window.`,
      );
    }
    if (stage.onTimeout === 'escalate' && stage.escalationSelector === null) {
      throw new WorkflowConfigurationError(
        'escalation-required',
        `Stage ${stage.sequence} escalates, so it needs somebody to escalate to.`,
      );
    }
    if (!Number.isInteger(stage.slaHours) || stage.slaHours <= 0) {
      throw new WorkflowConfigurationError(
        'sla-invalid',
        `Stage ${stage.sequence} needs a service level of at least one hour.`,
      );
    }

    if (stage.quorum === 'all') {
      const bound = await upperBoundOnApprovers(tx, stage.selector, stage.selectorConfig);
      if (bound > maxApprovers) {
        throw new WorkflowConfigurationError(
          'quorum-too-large',
          `Stage ${stage.sequence} would need all ${bound} approvers to agree, and this tenant allows at most ${maxApprovers}. A stage that cannot complete is a request that sits forever.`,
        );
      }
    }
  }
}

export async function upsertWorkflow(
  tenantId: string,
  actorUserId: string | null,
  workflowId: string | null,
  input: WorkflowInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    await validateStages(tx, input.stages, settings.maxApprovers);

    const previous =
      workflowId === null
        ? null
        : await tx.approvalWorkflow.findUnique({
            where: { id: workflowId },
            include: { stages: true },
          });

    const workflow =
      previous === null
        ? await tx.approvalWorkflow.create({
            data: {
              tenantId,
              name: input.name,
              description: input.description,
              enabled: input.enabled,
            },
          })
        : await tx.approvalWorkflow.update({
            where: { id: previous.id },
            data: {
              name: input.name,
              description: input.description,
              enabled: input.enabled,
            },
          });

    // Replaced whole rather than merged. A stage list edited by patch has no
    // readable diff and no defensible answer to "which stage is stage 2 now".
    await tx.approvalStage.deleteMany({ where: { workflowId: workflow.id } });
    if (input.stages.length > 0) {
      await tx.approvalStage.createMany({
        data: input.stages.map((stage) => ({
          tenantId,
          workflowId: workflow.id,
          sequence: stage.sequence,
          name: stage.name,
          selector: stage.selector,
          selectorConfig: stage.selectorConfig,
          quorum: stage.quorum,
          fallbackSelector: stage.fallbackSelector,
          fallbackConfig: stage.fallbackConfig,
          slaHours: stage.slaHours,
          onTimeout: stage.onTimeout,
          escalationSelector: stage.escalationSelector,
          escalationConfig: stage.escalationConfig,
          expiryHours: stage.expiryHours,
        })),
      });
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.workflow.upsert',
      targetType: 'ApprovalWorkflow',
      targetId: workflow.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: input.name,
        enabled: input.enabled,
        previousStageCount: previous?.stages.length ?? null,
        stageCount: input.stages.length,
        // Said in the record, not inferred by a reader counting stages. A
        // workflow at zero stages grants everything it is attached to, and
        // that fact has to be legible a year later.
        grantsImmediately: input.stages.length === 0,
        stages: input.stages.map((s) => ({
          sequence: s.sequence,
          selector: s.selector,
          quorum: s.quorum,
          onTimeout: s.onTimeout,
        })),
      },
    });

    return { id: workflow.id };
  });
}

/**
 * The stages, in order, as the value type the resolver and the request
 * snapshot both speak. JSON columns come back as `unknown`, and the casts here
 * are the one place that conversion happens.
 */
export async function loadWorkflowStages(
  tx: TenantClient,
  workflowId: string,
): Promise<StageSnapshot[]> {
  const rows = await tx.approvalStage.findMany({
    where: { workflowId },
    orderBy: { sequence: 'asc' },
  });
  return rows.map((row) => ({
    sequence: row.sequence,
    name: row.name,
    selector: row.selector as ApproverSelector,
    selectorConfig: (row.selectorConfig ?? {}) as SelectorConfig,
    quorum: row.quorum as 'any' | 'all',
    fallbackSelector: row.fallbackSelector as ApproverSelector | null,
    fallbackConfig: (row.fallbackConfig ?? {}) as SelectorConfig,
    slaHours: row.slaHours,
    onTimeout: row.onTimeout as 'remind' | 'escalate' | 'expire',
    escalationSelector: row.escalationSelector as ApproverSelector | null,
    escalationConfig: (row.escalationConfig ?? {}) as SelectorConfig,
    expiryHours: row.expiryHours,
  }));
}

export interface StagePreview {
  sequence: number;
  name: string;
  selector: ApproverSelector;
  quorum: 'any' | 'all';
  usedFallback: boolean;
  approvers: { personId: string; displayName: string; via: string }[];
  dropped: { personId: string; displayName: string; reason: DropReason }[];
  blocked: boolean;
}

/**
 * "Pick a real person, see the chain this workflow produces for them."
 *
 * The screen that catches a workflow resolving to nobody, a fallback that is
 * missing, and a stage where the subject is the only approver -- before it is
 * saved rather than at 3am on somebody's request.
 *
 * The subject is the submitter here, which is the ordinary case and also the
 * strictest: it exercises both halves of the subtraction.
 */
export async function previewWorkflowResolution(
  tenantId: string,
  workflowId: string,
  subjectPersonId: string,
  productId: string | null,
  on: Date = new Date(),
): Promise<StagePreview[]> {
  return withTenant(tenantId, async (tx) => {
    const stages = await loadWorkflowStages(tx, workflowId);
    const product =
      productId === null
        ? null
        : await tx.product.findUnique({
            where: { id: productId },
            include: { grants: true },
          });

    const subject = {
      subjectPersonId,
      submitterPersonId: subjectPersonId,
      productOwnerPersonId: product?.ownerPersonId ?? null,
      productOwnerGroupId: product?.ownerGroupId ?? null,
      productCategory: product?.category ?? null,
      resources: (product?.grants ?? []).map((g) => ({
        resourceType: g.resourceType as 'entitlement' | 'application' | 'group',
        resourceId: g.resourceId,
      })),
    };

    const previews: StagePreview[] = [];
    for (const stage of stages) {
      const result = await resolveStageApprovers(tx, stage, subject, on);
      const names = await tx.person.findMany({
        where: {
          id: {
            in: [
              ...result.approvers.map((a) => a.personId),
              ...result.dropped.map((d) => d.personId),
            ],
          },
        },
        select: { id: true, givenName: true, familyName: true },
      });
      const nameOf = (personId: string) => {
        const person = names.find((n) => n.id === personId);
        return person === undefined
          ? personId
          : `${person.givenName} ${person.familyName}`;
      };

      previews.push({
        sequence: stage.sequence,
        name: stage.name,
        selector: stage.selector,
        quorum: stage.quorum,
        usedFallback: result.usedFallback,
        approvers: result.approvers.map((a) => ({
          personId: a.personId,
          displayName: nameOf(a.personId),
          via: a.via,
        })),
        dropped: result.dropped.map((d) => ({
          personId: d.personId,
          displayName: nameOf(d.personId),
          reason: d.reason,
        })),
        blocked: result.approvers.length === 0,
      });
    }
    return previews;
  });
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/catalog-service.js';`:

```ts
export * from './automate/workflow-service.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/workflow-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/workflow-service.ts \
        packages/core/src/automate/workflow-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): workflow storage, save-time validation and the resolution preview"
```

---

## Task 8: Desired state gains a grants term — the changes to Provision

Spec §5 and §10. **This is the task that makes Automate work without a second writer**, and it is the only task in this plan that edits Provision's modules. Six files, each edit additive.

> **Do not start this task until Provision's Tasks 5, 7, 8, 9, 12, 13, 14 and 17 have landed on the branch.** Every symbol below is named from that plan's Interfaces blocks. If `packages/core/src/provision/desired.ts` does not exist, this task cannot begin.

**What changes, and what deliberately does not.** `Attribution` is **not** retagged into a union. Provision's `desired.ts`, `plan.ts`, `run-service.ts` and `explain.ts` all read `.ruleId` off it, and retagging means rewriting four modules concurrently under build. A parallel `grantAttribution` map carries exactly the same information additively — see "Three divergences" at the top of this plan.

**Files:**
- Modify: `packages/core/src/provision/types.ts`
- Modify: `packages/core/src/provision/desired.ts`
- Modify: `packages/core/src/provision/plan.ts`
- Modify: `packages/core/src/provision/entitlement-service.ts`
- Modify: `packages/core/src/provision/run-service.ts`
- Modify: `packages/core/src/provision/apply.ts`
- Modify: `packages/core/src/provision/explain.ts`
- Test: `packages/core/src/automate/desired-union.test.ts`

**Interfaces:**
- Consumes: `desiredState`, `type DesiredState`, `type DesiredStateInput`, `type KnownHolding`, `planActions`, `type PlannedAction`, `remitFor`, `previewProvisionRun`, `applyProvisionRun`, `explainPersonAccess`, `type PersonAccess` — all from Provision. `FakeTarget` from `@syntra/connectors`. `localMasterKeyProvider` from `../vault/master-key.js`. `IN_FORCE_GRANT_STATUSES` from `./types.js`.
- Produces (all in `packages/core/src/provision/types.ts` unless noted):
  - `interface GrantFacts { grantId: string; requestId: string | null; entitlementId: string; startsAt: Date; endsAt: Date | null }`
  - `interface GrantAttribution { grantId: string; requestId: string | null; endsAt: Date | null }`
  - `DesiredState` gains `grantAttribution: Map<string, GrantAttribution[]>`
  - `DesiredStateInput` gains `grants: GrantFacts[]`
  - `KnownHolding.origin` gains `'request'`; `KnownHolding` gains `grantedByRequestId: string | null`
  - `PlannedAction` gains `attributedGrantIds: string[]`
  - `remitFor` keeps its signature and widens what it returns
  - `PersonAccess`'s entitlement rows gain `grantId: string | null`, `requestId: string | null`, `grantEndsAt: Date | null`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/desired-union.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from '../provision/target-service.js';
import { previewProvisionRun } from '../provision/run-service.js';
import { applyProvisionRun } from '../provision/apply.js';
import { explainPersonAccess } from '../provision/explain.js';
import { remitFor } from '../provision/entitlement-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const STATS_DN = 'CN=Stats,OU=Groups,DC=acme,DC=test';

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: USERS,
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profileInput = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: USERS,
  fallbackContainer: USERS,
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

let tenantId: string;
let targetId: string;
let financeEntitlementId: string;
let statsEntitlementId: string;
let personId: string;
let ruleId: string;
let target: FakeTarget;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  // Ruling P8: the fake reproduces the real system's identifier semantics --
  // opaque anchors, DN-shaped memberOf. It is reused unchanged rather than
  // re-implemented for this slice.
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push(
    { externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' },
    { externalId: 'guid-stats', dn: STATS_DN, type: 'group', displayName: 'Stats' },
  );

  targetId = (
    await createTarget(tenantId, provider, null, {
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;
  await upsertAccountProfile(tenantId, null, targetId, profileInput);

  const seeded = await withTenant(tenantId, async (tx) => {
    const finance = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        dn: FINANCE_DN,
        type: 'group',
        displayName: 'Finance',
        requestable: true,
      },
    });
    const stats = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-stats',
        dn: STATS_DN,
        type: 'group',
        displayName: 'Stats',
        requestable: true,
      },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    return { finance: finance.id, stats: stats.id, personId: person.id };
  });
  financeEntitlementId = seeded.finance;
  statsEntitlementId = seeded.stats;
  personId = seeded.personId;

  ruleId = (
    await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [financeEntitlementId],
    })
  ).id;
});

async function grant(entitlementId: string, over: Record<string, unknown> = {}) {
  return withTenant(tenantId, async (tx) => {
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        subjectPersonId: personId,
        requestedByUserId: personId,
        status: 'awaiting_fulfilment',
      },
    });
    return tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId: personId,
        resourceType: 'entitlement',
        resourceId: entitlementId,
        targetSystemId: targetId,
        requestId: request.id,
        startsAt: day('2026-06-01'),
        status: 'pending',
        ...over,
      },
    });
  });
}

const runAndApply = async () => {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: target as never,
  });
  await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId: null,
    connector: target as never,
    now: NOW,
    sleep: async () => undefined,
  });
  return run;
};

describe('a grant is a term in desired state', () => {
  it('proposes granting an entitlement no business rule names', async () => {
    const created = await grant(statsEntitlementId);
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: run.id, actionType: 'grant_entitlement' } }),
    );
    const stats = actions.find((a) => a.entitlementId === statsEntitlementId);
    expect(stats).toBeDefined();
    // The action carries the grant that caused it, which is what reflection
    // reads to move the grant to active.
    expect(stats?.grantId).toBe(created.id);
  });

  it('requires an account for somebody whose only claim is a grant', async () => {
    // A group membership without an account is not a thing a directory can
    // hold. If the grants term did not imply the account, the grant action
    // would be planned against an account that was never created and would
    // fail `not_found` every night.
    await withTenant(tenantId, (tx) =>
      tx.businessRule.update({ where: { id: ruleId }, data: { enabled: false } }),
    );
    await grant(statsEntitlementId);
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: run.id } }),
    );
    expect(actions.map((a) => a.actionType)).toContain('create_account');
  });

  it('records the holding with origin request and the request that caused it', async () => {
    await grant(statsEntitlementId);
    await runAndApply();
    const holdings = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findMany({ where: { entitlementId: statsEntitlementId } }),
    );
    expect(holdings).toHaveLength(1);
    // One value covers both grant origins; grantedByRequestId answers which
    // kind it was without a second enum value meaning the same thing.
    expect(holdings[0]?.origin).toBe('request');
    expect(holdings[0]?.grantedByRequestId).not.toBeNull();
  });

  it('does not include a scheduled grant whose start date has not arrived', async () => {
    // A scheduled grant is visible in the console, says when it starts, and
    // confers nothing until it does.
    await grant(statsEntitlementId, { status: 'scheduled', startsAt: day('2026-09-01') });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: statsEntitlementId },
      }),
    );
    expect(actions).toEqual([]);
  });

  it('does not include a grant whose end date has passed', async () => {
    await grant(statsEntitlementId, { endsAt: day('2026-06-10') });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: statsEntitlementId },
      }),
    );
    expect(actions).toEqual([]);
  });
});

describe('collision 1 — a request grants something Provision would not grant', () => {
  it('proposes no revocation and writes no drift finding, in authoritative mode', async () => {
    await grant(statsEntitlementId);
    await runAndApply();

    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { enforcementMode: 'authoritative' },
      }),
    );
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });

    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations).toEqual([]);
    // Not drift. It is neither undocumented nor unexplained: Syntra did not
    // merely see it, it caused it, and can name who approved it.
    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({ where: { entitlementId: statsEntitlementId } }),
    );
    expect(findings).toEqual([]);
  });
});

describe('collision 2 — a contract change removes what a rule granted', () => {
  it('keeps an entitlement a grant still names after the rule stops matching', async () => {
    // Losing access because ONE of two independent reasons to hold it went
    // away is the bug, and union is the fix -- the same semantics Provision
    // already applies across concurrent contracts.
    await grant(financeEntitlementId);
    await runAndApply();

    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId },
        data: { department: 'Facilities' },
      }),
    );
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations).toEqual([]);
  });

  it('proposes the revocation once BOTH terms are gone', async () => {
    await grant(financeEntitlementId);
    await runAndApply();
    await withTenant(tenantId, async (tx) => {
      await tx.contract.updateMany({
        where: { personId },
        data: { department: 'Facilities' },
      });
      await tx.accessGrant.updateMany({
        where: { subjectPersonId: personId },
        data: { status: 'expired', endedAt: NOW },
      });
    });
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations.map((r) => r.entitlementId)).toEqual([financeEntitlementId]);
  });
});

describe('remitFor', () => {
  it('includes an entitlement named only by a live grant', async () => {
    // Without this, archiving an account would leave a requested membership
    // in place, and the unreadable-membership probe would never look at the
    // groups requests put people into.
    const before = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(before.has(statsEntitlementId)).toBe(false);

    await grant(statsEntitlementId);
    const after = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(after.has(statsEntitlementId)).toBe(true);
    expect(after.has(financeEntitlementId)).toBe(true);
  });

  it('drops an entitlement once its grant is no longer live', async () => {
    await grant(statsEntitlementId, { status: 'expired' });
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.has(statsEntitlementId)).toBe(false);
  });
});

describe('explainPersonAccess', () => {
  it('answers with a rule and a contract for one entitlement and a request for the other', async () => {
    // The whole point of putting grants into desired state rather than beside
    // it: one screen, one attribution union behind it.
    const created = await grant(statsEntitlementId);
    await runAndApply();

    const access = await explainPersonAccess(tenantId, personId);
    const entitlements = access.accounts.flatMap((a) => a.entitlements);
    const finance = entitlements.find((e) => e.entitlementId === financeEntitlementId);
    const stats = entitlements.find((e) => e.entitlementId === statsEntitlementId);

    expect(finance).toMatchObject({ origin: 'rule', ruleName: 'Finance staff' });
    expect(finance?.grantId).toBeNull();
    expect(stats).toMatchObject({ origin: 'request', grantId: created.id });
    expect(stats?.requestId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/desired-union.test.ts`
Expected: FAIL — `grants` is not a property of `DesiredStateInput`, and no action carries a `grantId`.

- [ ] **Step 3: Add the grant value types**

Append to `packages/core/src/provision/types.ts`:

```ts
/**
 * An AccessGrant, flattened to what desired state needs.
 *
 * Only grants whose window covers `now` are handed in -- Automate filters
 * before calling, so this carries no status. `endsAt` travels only so the
 * attribution can say "until 30 June" without a second read.
 */
export interface GrantFacts {
  grantId: string;
  requestId: string | null;
  entitlementId: string;
  startsAt: Date;
  endsAt: Date | null;
}

/**
 * Why somebody holds something because they asked for it.
 *
 * A SEPARATE map from `attribution` rather than a second member of it.
 * `Attribution` is read as `{ ruleId, ruleName, contractId }` by four modules
 * in this package; retagging it into a discriminated union means rewriting all
 * four. This carries the same information additively, and "why does this
 * person hold this?" answers from the two maps together.
 */
export interface GrantAttribution {
  grantId: string;
  requestId: string | null;
  endsAt: Date | null;
}
```

In the same file, add one field to `DesiredState`, after `attribution`:

```ts
  /**
   * Entitlement id to the grants that put it in the set. Empty for anything a
   * rule alone produced; both maps carry an entry for anything held for both
   * reasons, which is the row of section 10's matrix where neither is
   * redundant -- they end independently.
   */
  grantAttribution: Map<string, GrantAttribution[]>;
```

and one field to `DesiredStateInput`, after `rules`:

```ts
  /**
   * The subject's grants for THIS target whose window covers `now`. The
   * caller filters; this function unions.
   */
  grants: GrantFacts[];
```

and widen `KnownHolding`:

```ts
export interface KnownHolding {
  entitlementId: string;
  /**
   * 'request' means an approved AccessRequest put it into desired state. One
   * value for both grant origins -- a delegated administrator's act is an
   * AccessRequest too -- and `grantedByRequestId` says which.
   */
  origin: 'rule' | 'request' | 'manual' | 'discovered';
  grantedByRuleId: string | null;
  grantedByRequestId: string | null;
}
```

- [ ] **Step 4: Union the grants into desired state**

In `packages/core/src/provision/desired.ts`, inside `desiredState`:

1. Where the function currently decides whether an account is required from the matching rules, replace that decision with the union of the rule answer and the grant answer:

```ts
  // A group membership without an account is not a thing a directory can
  // hold. Somebody whose only claim on this target is a request grant still
  // needs an account to hold it, or the grant action is planned against an
  // account nothing created and fails `not_found` every night.
  const grantsInForce = input.grants.filter(
    (grant) => grant.startsAt <= input.now && (grant.endsAt === null || input.now < grant.endsAt),
  );
  const accountRequired = accountRequiredFromRules || grantsInForce.length > 0;
```

   `accountRequiredFromRules` is whatever local the function already computes from `rules.some((rule) => rule.grantsAccount && matches)`; rename it to that if it is currently called something else, and use `accountRequired` from there on.

2. After the loop that fills `entitlements` and `attribution` from the rules, add:

```ts
  // The union. The entitlement set is what the rules produce PLUS what the
  // grants name, and the two attributions are kept apart so each can end
  // without taking the other with it (spec section 10's matrix).
  const grantAttribution = new Map<string, GrantAttribution[]>();
  for (const grant of grantsInForce) {
    entitlements.add(grant.entitlementId);
    const existing = grantAttribution.get(grant.entitlementId) ?? [];
    existing.push({
      grantId: grant.grantId,
      requestId: grant.requestId,
      endsAt: grant.endsAt,
    });
    grantAttribution.set(grant.entitlementId, existing);
  }
```

3. Add `grantAttribution` to every `DesiredState` the function returns. The unprocessable and not-yet-started early returns get `grantAttribution: new Map()` — an unprocessable person is excluded from the plan entirely, and a future joiner's grants are `scheduled` and confer nothing.

4. Import the two new types at the top of the file:

```ts
import type { GrantAttribution, GrantFacts } from './types.js';
```

- [ ] **Step 5: Carry the attribution onto the planned action**

In `packages/core/src/provision/plan.ts`, add one field to `PlannedAction`:

```ts
  /**
   * The AccessGrant rows that caused this action, when a request did.
   * Alongside `attributedRuleIds`, never instead of it: an entitlement held
   * for both reasons carries both, because the two end independently.
   */
  attributedGrantIds: string[];
```

Every construction of a `PlannedAction` in this file gains `attributedGrantIds: []`, except the `grant_entitlement` branch, which gains:

```ts
      attributedGrantIds: (state.grantAttribution.get(entitlementId) ?? []).map(
        (a) => a.grantId,
      ),
```

`revoke_entitlement` keeps `attributedGrantIds: []`: by the time a revocation is proposed the grant has already left the union, so there is no live grant to attribute it to. Reflection finds the removal by its `SweepAction` instead (Task 14).

- [ ] **Step 6: Widen the remit**

In `packages/core/src/provision/entitlement-service.ts`, replace the body of `remitFor`:

```ts
export async function remitFor(
  tx: TenantClient,
  targetId: string,
): Promise<Set<string>> {
  const joins = await tx.ruleEntitlement.findMany({
    where: { rule: { targetSystemId: targetId } },
    select: { entitlementId: true },
  });
  // An entitlement named by a LIVE AccessGrant is equally something Provision
  // has been asked to manage on this target. Without it, `archive_account`
  // leaves a requested membership behind -- the strip list is filtered through
  // the remit -- and the unreadable-membership probe never looks at the groups
  // requests put people into. `expired`, `lapsed` and `revoked` grants are
  // excluded, so the remit narrows again when the last grant ends.
  const granted = await tx.accessGrant.findMany({
    where: {
      targetSystemId: targetId,
      resourceType: 'entitlement',
      status: { in: ['scheduled', 'pending', 'active'] },
    },
    select: { resourceId: true },
  });
  return new Set([
    ...joins.map((j) => j.entitlementId),
    ...granted.map((g) => g.resourceId),
  ]);
}
```

- [ ] **Step 7: Load the grants and write the grant id onto the action**

In `packages/core/src/provision/run-service.ts`:

1. In phase 5's snapshot transaction, alongside the `persons`, `rules`, `entitlements`, `accounts` and `users` reads, add:

```ts
      const grants = await tx.accessGrant.findMany({
        where: {
          targetSystemId,
          resourceType: 'entitlement',
          // Only grants whose window can cover `now`. `scheduled` is excluded
          // here as well as by the date filter in desiredState, so a run never
          // even loads a grant that confers nothing.
          status: { in: ['pending', 'active'] },
        },
        select: {
          id: true,
          requestId: true,
          subjectPersonId: true,
          resourceId: true,
          startsAt: true,
          endsAt: true,
        },
      });
```

   and return `grants` from the snapshot.

2. Where the snapshot is turned into per-person `desiredState` calls, build the index once and hand each person their own:

```ts
    const grantsByPerson = new Map<string, GrantFacts[]>();
    for (const grant of snapshot.grants) {
      const list = grantsByPerson.get(grant.subjectPersonId) ?? [];
      list.push({
        grantId: grant.id,
        requestId: grant.requestId,
        entitlementId: grant.resourceId,
        startsAt: grant.startsAt,
        endsAt: grant.endsAt,
      });
      grantsByPerson.set(grant.subjectPersonId, list);
    }
```

   and add `grants: grantsByPerson.get(person.id) ?? []` to each `desiredState({ ... })` call.

3. In the `KnownAccount` construction, add `grantedByRequestId: holding.grantedByRequestId` beside `grantedByRuleId`.

4. In phase 7, where `ProvisionAction` rows are created from `PlannedAction`s, add:

```ts
        // Exactly one grant, or none. A person holding one entitlement through
        // two grants is possible only through the extension path, where the
        // superseding grant replaces the old one before the run -- so a second
        // id here would mean the supersession did not happen, and writing an
        // arbitrary one of the two would attach the outcome to the wrong
        // request.
        grantId: action.attributedGrantIds.length === 1 ? action.attributedGrantIds[0]! : null,
```

5. Import `type GrantFacts` from `./types.js`.

- [ ] **Step 8: Record the origin the holding actually has**

In `packages/core/src/provision/apply.ts`, where a successful `grant_entitlement` writes its `AccountEntitlement` row, replace the hard-coded origin:

```ts
      // The origin is decided by what caused the action, not by a default.
      // `origin` separates convergence from drift and is not derivable after
      // the fact, which is why Provision records it at the moment of the grant
      // -- and a request grant recorded as `rule` would answer "why does this
      // person hold this?" with a rule that does not name it.
      const requestId =
        action.grantId === null
          ? null
          : ((
              await tx.accessGrant.findUnique({
                where: { id: action.grantId },
                select: { requestId: true },
              })
            )?.requestId ?? null);

      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: action.accountId!,
          entitlementId: action.entitlementId!,
          origin: action.grantId === null ? 'rule' : 'request',
          grantedByRuleId: action.attributedRuleIds[0] ?? null,
          grantedByRequestId: requestId,
          state: 'held',
        },
      });
```

- [ ] **Step 9: Answer "why does this person hold this" with both**

In `packages/core/src/provision/explain.ts`, add three fields to the entitlement rows of `PersonAccess`:

```ts
    grantId: string | null;
    requestId: string | null;
    grantEndsAt: Date | null;
```

and populate them where the holdings are mapped:

```ts
      const grant =
        holding.grantedByRequestId === null
          ? null
          : await tx.accessGrant.findFirst({
              where: {
                subjectPersonId: personId,
                resourceType: 'entitlement',
                resourceId: holding.entitlementId,
                requestId: holding.grantedByRequestId,
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true, endsAt: true },
            });
```

then `grantId: grant?.id ?? null`, `requestId: holding.grantedByRequestId`, `grantEndsAt: grant?.endsAt ?? null` on the returned row.

- [ ] **Step 10: Fix the compile errors the widened types produce**

Run: `pnpm typecheck`

Expect errors in `desired.test.ts`, `plan.test.ts`, `reconcile.test.ts` and `run-service.test.ts`: every fixture that builds a `DesiredStateInput`, a `DesiredState`, a `KnownHolding` or a `PlannedAction` by hand is now missing a field. Add `grants: []`, `grantAttribution: new Map()`, `grantedByRequestId: null` and `attributedGrantIds: []` to those fixtures. **Do not weaken the types to make the fixtures compile** — `grants` optional with a default is exactly the shape that would let `run-service.ts` forget to pass it and produce a plan that silently revokes every requested entitlement in the tenant.

- [ ] **Step 11: Run the Provision suite, then the new test**

Run: `pnpm vitest run packages/core/src/provision`
Expected: PASS. This is the regression gate — the union must not have changed any rule-only outcome.

Run: `pnpm vitest run packages/core/src/automate/desired-union.test.ts`
Expected: PASS.

- [ ] **Step 12: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/provision packages/core/src/automate/desired-union.test.ts
git commit -m "feat(automate): an access grant is a term in Provision's desired state"
```

---

## Task 9: Fulfilment — three paths, one writer each

Spec §5 and §16. `application` and `localGroup` land in one short transaction each; `targetEntitlement` writes a grant, marks the item dispatched, and enqueues a Provision run.

**Why the enqueue is outside the transaction.** Spec §16 says the enqueue "commits or rolls back with the transaction". It does not: `Scheduler.enqueue` calls `boss.send` on pg-boss's own pool. So the transaction commits first and the enqueue follows, and Task 12's reflection pass re-enqueues for any target holding a `pending` grant whose request is still `awaiting_fulfilment` — which also covers a crash between the two, something a transactional enqueue would not have covered.

**Files:**
- Create: `packages/core/src/automate/fulfil.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/fulfil.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `assignApplication` from `../access/assignment-service.js`; `addMember`, `removeMember` from `../directory/group-service.js`; `type Scheduler` from `../jobs/scheduler.js`; `PROVISION_JOB`, `provisionJobPayload` from `../provision/jobs.js`; `enqueueOutbox`, `recipientsForPersons`, `usersWithPermission` from `./notify.js`; `automateSettings` from `./catalog-service.js`; `grantWindow` from `./duration.js`; `type GrantStatus`, `type RequestStatus`, `LIVE_GRANT_STATUSES` from `./types.js`; `PERMISSIONS` from `../rbac/permissions.js`.
- Produces:
  - `interface FulfilOptions { now?: Date; scheduler?: Scheduler | null; publicUrl?: string }`
  - `interface FulfilOutcome { status: RequestStatus; grantIds: string[]; targetSystemIds: string[] }`
  - `async function fulfilRequest(tenantId: string, requestId: string, options?: FulfilOptions): Promise<FulfilOutcome>`
  - `async function handBackGrant(tenantId: string, actorUserId: string | null, grantId: string, options?: FulfilOptions): Promise<void>`
  - `async function revokeGrant(tenantId: string, actorUserId: string | null, grantId: string, reason: string, options?: FulfilOptions): Promise<void>`
  - `async function subjectHoldings(tx: TenantClient, personId: string): Promise<Map<string, { source: 'rule' | 'request' | 'manual' | 'discovered'; detail: string }>>`
  - `function requestUrl(publicUrl: string, requestId: string): string`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/fulfil.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { fulfilRequest, handBackGrant, revokeGrant } from './fulfil.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let personId: string;
let userId: string;
let applicationId: string;
let groupId: string;
let entitlementId: string;
let targetSystemId: string;
let workflowId: string;

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
      },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    const application = await tx.application.create({
      data: { tenantId, name: 'Stats', slug: 'stats' },
    });
    const group = await tx.group.create({ data: { tenantId, name: 'Reading room' } });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        externalId: 'guid-stats',
        type: 'group',
        displayName: 'Stats',
        requestable: true,
      },
    });
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Immediate' },
    });
    return {
      personId: person.id,
      userId: user.id,
      applicationId: application.id,
      groupId: group.id,
      targetSystemId: target.id,
      entitlementId: entitlement.id,
      workflowId: workflow.id,
    };
  });
  ({ personId, userId, applicationId, groupId, targetSystemId, entitlementId, workflowId } =
    seeded);
});

/** An approved request with one item, ready to fulfil. */
async function seedRequest(
  kind: 'application' | 'localGroup' | 'targetEntitlement',
  over: { durationDays?: number | null } = {},
) {
  return withTenant(tenantId, async (tx) => {
    const resource =
      kind === 'application'
        ? { resourceType: 'application', resourceId: applicationId, targetSystemId: null }
        : kind === 'localGroup'
          ? { resourceType: 'group', resourceId: groupId, targetSystemId: null }
          : { resourceType: 'entitlement', resourceId: entitlementId, targetSystemId };

    const product = await tx.product.create({
      data: {
        tenantId,
        name: 'Product',
        slug: `p-${kind}`,
        kind,
        workflowId,
        status: 'active',
        durationMode: over.durationDays === undefined ? 'permanent' : 'fixed',
        defaultDurationDays: over.durationDays ?? null,
        maxDurationDays: null,
      },
    });
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        productId: product.id,
        subjectPersonId: personId,
        requestedByUserId: userId,
        requestedByPersonId: personId,
        status: 'approved',
        requestedDurationDays: over.durationDays ?? null,
      },
    });
    await tx.requestItem.create({ data: { tenantId, requestId: request.id, ...resource } });
    return request.id;
  });
}

describe('the application path', () => {
  it('writes an AppAssignment, an active grant and an audit event in one transaction', async () => {
    const requestId = await seedRequest('application');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('fulfilled');

    const state = await withTenant(tenantId, async (tx) => ({
      assignments: await tx.appAssignment.findMany({ where: { applicationId } }),
      grants: await tx.accessGrant.findMany(),
      items: await tx.requestItem.findMany(),
      audits: await tx.auditEvent.findMany({ where: { action: 'automate.grant.create' } }),
    }));
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({ subjectType: 'user', userId });
    // Written directly, so the grant is `active` and not `pending`: there is
    // no target to confirm anything with.
    expect(state.grants[0]).toMatchObject({ status: 'active', origin: 'request' });
    expect(state.items[0]?.status).toBe('fulfilled');
    expect(state.audits).toHaveLength(1);
  });

  it('assigns to every account the person holds, not an arbitrary one', async () => {
    // An application granted to a person is granted to that person. Picking
    // one of their logins is a support call waiting to happen.
    await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'anna.admin',
          email: 'anna.admin@acme.test',
          displayName: 'Anna Novak (admin)',
          personId,
        },
      }),
    );
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const assignments = await withTenant(tenantId, (tx) =>
      tx.appAssignment.findMany({ where: { applicationId } }),
    );
    expect(assignments).toHaveLength(2);
  });
});

describe('the local group path', () => {
  it('adds the membership and records the grant', async () => {
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships.map((m) => m.userId)).toEqual([userId]);
  });
});

describe('the target entitlement path', () => {
  it('writes a pending grant, dispatches the item, and enqueues a run for that target', async () => {
    const scheduler = schedulerStub();
    const requestId = await seedRequest('targetEntitlement');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW, scheduler });

    expect(outcome.status).toBe('awaiting_fulfilment');
    expect(outcome.targetSystemIds).toEqual([targetSystemId]);
    // Pending, not active. The console must never claim somebody holds
    // something they do not.
    const state = await withTenant(tenantId, async (tx) => ({
      grants: await tx.accessGrant.findMany(),
      items: await tx.requestItem.findMany(),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.grants[0]?.status).toBe('pending');
    expect(state.items[0]?.status).toBe('dispatched');
    expect(state.request.dispatchedAt).not.toBeNull();

    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('still commits when there is no scheduler to enqueue with', async () => {
    // The enqueue is not transactional and cannot be. A request that reached
    // awaiting_fulfilment with no run enqueued is picked up by reflection; a
    // request that rolled back because pg-boss was unreachable is an approval
    // silently undone.
    const requestId = await seedRequest('targetEntitlement');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW, scheduler: null });
    expect(outcome.status).toBe('awaiting_fulfilment');
    const grants = await withTenant(tenantId, (tx) => tx.accessGrant.findMany());
    expect(grants).toHaveLength(1);
  });
});

describe('duration and what is already held', () => {
  it('gives a fixed-duration product an end date measured from the start', async () => {
    const requestId = await seedRequest('application', { durationDays: 30 });
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    expect(grant.endsAt).toEqual(day('2026-07-15'));
  });

  it('skips an item the subject already holds, names why, and still fulfils the rest', async () => {
    // Not a refusal. The already-held item is marked skipped with the source
    // of the existing holding, and the notification names it so the requester
    // is not left wondering.
    const requestId = await seedRequest('application');
    await withTenant(tenantId, async (tx) => {
      await tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId },
      });
      const request = await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } });
      await tx.requestItem.create({
        data: {
          tenantId,
          requestId: request.id,
          resourceType: 'group',
          resourceId: groupId,
          targetSystemId: null,
        },
      });
    });

    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('fulfilled');
    const items = await withTenant(tenantId, (tx) =>
      tx.requestItem.findMany({ orderBy: { resourceType: 'asc' } }),
    );
    const skipped = items.find((i) => i.resourceType === 'application');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.message).toContain('already');
    expect(items.find((i) => i.resourceType === 'group')?.status).toBe('fulfilled');
  });

  it('does not write a second live grant when one already exists', async () => {
    // The one-live-grant index would refuse it anyway; this is the code path
    // answering before the database has to.
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const second = await seedRequest('localGroup');
    await fulfilRequest(tenantId, second, { now: NOW });
    const grants = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findMany({ where: { status: 'active' } }),
    );
    expect(grants).toHaveLength(1);
  });
});

describe('notifications', () => {
  it('writes outbox rows and sends nothing', async () => {
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((o) => o.template)).toContain('automate-fulfilled');
    // Nothing has been sent: `sentAt` is null on every row, and this module
    // imports no transport at all.
    for (const row of outbox) expect(row.sentAt).toBeNull();
  });
});

describe('handBackGrant', () => {
  it('revokes the grant and removes the membership immediately, with no sweep', async () => {
    // A guard exists to catch mass action, and this is a person giving one
    // thing back.
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());

    await handBackGrant(tenantId, userId, grant.id, { now: NOW });

    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      memberships: await tx.groupMembership.findMany({ where: { groupId } }),
      audits: await tx.auditEvent.findMany({ where: { action: 'automate.grant.hand_back' } }),
    }));
    expect(state.grant.status).toBe('revoked');
    expect(state.grant.endedAt).not.toBeNull();
    expect(state.memberships).toEqual([]);
    expect(state.audits).toHaveLength(1);
  });

  it('enqueues a Provision run for a target entitlement rather than writing to the target', async () => {
    const scheduler = schedulerStub();
    const requestId = await seedRequest('targetEntitlement');
    await fulfilRequest(tenantId, requestId, { now: NOW, scheduler });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    scheduler.enqueue.mockClear();

    await handBackGrant(tenantId, userId, grant.id, { now: NOW, scheduler });

    const after = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    );
    // The grant leaves desired state; Provision proposes and applies the
    // revocation under its own guard. Automate writes no entitlement anywhere.
    expect(after.status).toBe('revoked');
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('is idempotent on a grant that is already revoked', async () => {
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    await handBackGrant(tenantId, userId, grant.id, { now: NOW });
    await handBackGrant(tenantId, userId, grant.id, { now: NOW });
    const audits = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.grant.hand_back' } }),
    );
    expect(audits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/fulfil.test.ts`
Expected: FAIL, "Failed to resolve import ./fulfil.js".

- [ ] **Step 3: Write the fulfilment module**

`packages/core/src/automate/fulfil.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { assignApplication } from '../access/assignment-service.js';
import { addMember, removeMember } from '../directory/group-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { enqueueOutbox, recipientsForPersons, usersWithPermission } from './notify.js';
import { grantWindow } from './duration.js';
import { LIVE_GRANT_STATUSES, type RequestStatus } from './types.js';

export interface FulfilOptions {
  now?: Date;
  /**
   * How a Provision run is enqueued. Null or absent means no enqueue, which
   * is what every test that is not about scheduling wants -- and which
   * reflection recovers from anyway.
   */
  scheduler?: Scheduler | null;
  publicUrl?: string;
}

export interface FulfilOutcome {
  status: RequestStatus;
  grantIds: string[];
  targetSystemIds: string[];
}

export function requestUrl(publicUrl: string, requestId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/requests/${requestId}`;
}

/**
 * What the subject already holds, and where each holding came from.
 *
 * Keyed on `resourceType:resourceId`. A person who asks for something they
 * already have has a different problem and deserves to be told what it is, so
 * the SOURCE travels with the answer rather than a bare boolean.
 */
export async function subjectHoldings(
  tx: TenantClient,
  personId: string,
): Promise<Map<string, { source: 'rule' | 'request' | 'manual' | 'discovered'; detail: string }>> {
  const out = new Map<string, { source: 'rule' | 'request' | 'manual' | 'discovered'; detail: string }>();

  const holdings = await tx.accountEntitlement.findMany({
    where: { state: 'held', account: { personId } },
    include: { entitlement: { select: { displayName: true } } },
  });
  for (const holding of holdings) {
    out.set(`entitlement:${holding.entitlementId}`, {
      source: holding.origin as 'rule' | 'request' | 'manual' | 'discovered',
      detail: holding.entitlement.displayName,
    });
  }

  const users = await tx.user.findMany({ where: { personId }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    const assignments = await tx.appAssignment.findMany({
      where: { userId: { in: userIds } },
      select: { applicationId: true },
    });
    for (const assignment of assignments) {
      out.set(`application:${assignment.applicationId}`, {
        source: 'manual',
        detail: 'an existing assignment',
      });
    }
    const memberships = await tx.groupMembership.findMany({
      where: { userId: { in: userIds } },
      select: { groupId: true },
    });
    for (const membership of memberships) {
      out.set(`group:${membership.groupId}`, {
        source: 'manual',
        detail: 'an existing membership',
      });
    }
  }

  // A live grant counts even where the write has not landed yet, so a second
  // request for the same thing is skipped rather than racing the first.
  const grants = await tx.accessGrant.findMany({
    where: { subjectPersonId: personId, status: { in: [...LIVE_GRANT_STATUSES] } },
    select: { resourceType: true, resourceId: true, requestId: true },
  });
  for (const grant of grants) {
    out.set(`${grant.resourceType}:${grant.resourceId}`, {
      source: 'request',
      detail: 'an earlier request',
    });
  }

  return out;
}

/**
 * Turns an approved request into the access it asked for.
 *
 * One short transaction. Every write is a database write against a table with
 * no other writer, or an `AccessGrant` row that Provision will read. Nothing
 * here opens a socket, and the only remote call in the whole fulfilment path
 * belongs to Provision, inside Provision's own three-step shape.
 */
export async function fulfilRequest(
  tenantId: string,
  requestId: string,
  options: FulfilOptions = {},
): Promise<FulfilOutcome> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const outcome = await withTenant(tenantId, async (tx): Promise<FulfilOutcome> => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { items: true, product: true },
    });

    const held = await subjectHoldings(tx, request.subjectPersonId);
    const users = await tx.user.findMany({
      where: { personId: request.subjectPersonId, status: 'active' },
      select: { id: true },
    });

    // The duration was resolved at submission and possibly shortened at the
    // decision; `requestedDurationDays` carries the answer. The window is
    // computed here because `startsAt` is the moment of fulfilment.
    const contracts = await tx.contract.findMany({
      where: { personId: request.subjectPersonId },
      orderBy: { startDate: 'asc' },
      select: { startDate: true },
    });
    const futureStart = contracts.find((c) => c.startDate > now)?.startDate ?? null;
    const earliestContractStart = contracts.some((c) => c.startDate <= now)
      ? null
      : futureStart;
    const window = grantWindow({
      now,
      days: request.requestedDurationDays,
      requestedStartsAt: null,
      earliestContractStart,
    });

    const grantIds: string[] = [];
    const targetSystemIds = new Set<string>();
    const granted: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const item of request.items) {
      if (item.status !== 'pending') continue;

      const key = `${item.resourceType}:${item.resourceId}`;
      const existing = held.get(key);
      if (existing !== undefined) {
        await tx.requestItem.update({
          where: { id: item.id },
          data: {
            status: 'skipped',
            message: `already held, from ${existing.detail}`,
          },
        });
        skipped.push(key);
        continue;
      }

      if (item.resourceType !== 'entitlement' && users.length === 0) {
        // Refused at submission too, but a subject can lose their last account
        // between approval and fulfilment.
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'failed', message: 'the subject holds no active Syntra account' },
        });
        failed.push(key);
        continue;
      }

      const grant = await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: request.subjectPersonId,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          targetSystemId: item.targetSystemId,
          origin: request.origin === 'delegated_admin' ? 'delegated_admin' : 'request',
          requestId: request.id,
          productId: request.productId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          // A target entitlement is `pending` until Provision confirms it. The
          // console never claims somebody holds something they do not.
          status: window.scheduled
            ? 'scheduled'
            : item.resourceType === 'entitlement'
              ? 'pending'
              : 'active',
        },
      });
      grantIds.push(grant.id);

      if (item.resourceType === 'entitlement') {
        if (item.targetSystemId !== null) targetSystemIds.add(item.targetSystemId);
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'dispatched', grantId: grant.id },
        });
        granted.push(key);
      } else {
        if (!window.scheduled) {
          for (const user of users) {
            if (item.resourceType === 'application') {
              await assignApplication(tx, item.resourceId, { type: 'user', id: user.id });
            } else {
              await addMember(tx, item.resourceId, user.id);
            }
          }
        }
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'fulfilled', grantId: grant.id },
        });
        granted.push(key);
      }

      await recordEvent(tx, {
        actorUserId: request.requestedByUserId,
        action: 'automate.grant.create',
        targetType: 'AccessGrant',
        targetId: grant.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          requestId: request.id,
          subjectPersonId: request.subjectPersonId,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          startsAt: grant.startsAt.toISOString(),
          endsAt: grant.endsAt?.toISOString() ?? null,
          status: grant.status,
        },
      });
    }

    const items = await tx.requestItem.findMany({ where: { requestId } });
    const anyInFlight = items.some((i) => i.status === 'dispatched' || i.status === 'pending');
    const anyLanded = items.some((i) => i.status === 'fulfilled');
    const anyFailed = items.some((i) => i.status === 'failed');

    const status: RequestStatus = anyInFlight
      ? 'awaiting_fulfilment'
      : anyFailed && anyLanded
        ? 'partially_fulfilled'
        : anyFailed
          ? 'fulfilment_failed'
          : 'fulfilled';

    await tx.accessRequest.update({
      where: { id: requestId },
      data: {
        status,
        ...(anyInFlight ? { dispatchedAt: request.dispatchedAt ?? now } : {}),
        ...(status === 'fulfilled' || status === 'partially_fulfilled'
          ? { fulfilledAt: now }
          : {}),
      },
    });

    // Rendered here, sent by the outbox job afterwards. Nothing in this
    // function can reach a mail server.
    const recipients = await recipientsForPersons(tx, [
      request.subjectPersonId,
      ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
    ]);
    const vars = {
      productName: request.product?.name ?? 'the requested access',
      subjectName: request.subjectPersonId,
      resourceList: granted.join(', '),
      grantedList: granted.join(', '),
      failedList: failed.join(', '),
      endsAt: window.endsAt?.toDateString() ?? 'until it is taken away',
      skippedNote:
        skipped.length === 0
          ? ''
          : `Already held, so nothing changed for: ${skipped.join(', ')}.`,
      requestUrl: requestUrl(publicUrl, request.id),
    };

    if (status === 'fulfilled') {
      await enqueueOutbox(
        tx,
        recipients.map((r) => ({
          template: 'automate-fulfilled' as const,
          to: r.email,
          vars: { ...vars, displayName: r.displayName },
          requestId: request.id,
          userId: r.userId,
        })),
      );
    } else if (status === 'partially_fulfilled' || status === 'fulfilment_failed') {
      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      await enqueueOutbox(
        tx,
        [...recipients, ...managers].map((r) => ({
          template:
            status === 'partially_fulfilled'
              ? ('automate-partially-fulfilled' as const)
              : ('automate-fulfilment-failed' as const),
          to: r.email,
          vars: { ...vars, displayName: r.displayName, message: failed.join(', ') },
          requestId: request.id,
          userId: r.userId,
        })),
      );
    }

    return { status, grantIds, targetSystemIds: [...targetSystemIds] };
  });

  // AFTER the commit, deliberately. `Scheduler.enqueue` is `boss.send` on
  // pg-boss's own pool, so it neither joins this transaction nor rolls back
  // with it -- and an approval undone because pg-boss was briefly unreachable
  // is a worse failure than a run enqueued a few minutes late. Task 12's
  // reflection pass re-enqueues for any target left holding a pending grant.
  for (const targetSystemId of outcome.targetSystemIds) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return outcome;
}

async function endGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  status: 'revoked',
  reason: string,
  action: string,
  options: FulfilOptions,
): Promise<void> {
  const now = options.now ?? new Date();

  const targetSystemId = await withTenant(tenantId, async (tx) => {
    const grant = await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } });
    // Idempotent: a grant already out of force has nothing to give back, and
    // a second audit event would claim a second act.
    if (!(LIVE_GRANT_STATUSES as readonly string[]).includes(grant.status)) return null;

    await tx.accessGrant.update({
      where: { id: grantId },
      data: { status, statusReason: reason, endedAt: now },
    });

    if (grant.resourceType !== 'entitlement') {
      const users = await tx.user.findMany({
        where: { personId: grant.subjectPersonId },
        select: { id: true },
      });
      for (const user of users) {
        if (grant.resourceType === 'application') {
          const assignments = await tx.appAssignment.findMany({
            where: { applicationId: grant.resourceId, userId: user.id },
          });
          for (const assignment of assignments) {
            await tx.appAssignment.deleteMany({ where: { id: assignment.id } });
          }
        } else {
          await removeMember(tx, grant.resourceId, user.id);
        }
      }
    }

    await recordEvent(tx, {
      actorUserId,
      action,
      targetType: 'AccessGrant',
      targetId: grantId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        subjectPersonId: grant.subjectPersonId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        reason,
      },
    });

    return grant.resourceType === 'entitlement' ? grant.targetSystemId : null;
  });

  if (targetSystemId !== null) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }
}

/**
 * Somebody giving one thing back.
 *
 * Runs immediately rather than waiting for the nightly sweep, and is subject
 * to Provision's guard on the target side and to no sweep guard at all: a
 * guard exists to catch mass action, and this is one grant.
 */
export async function handBackGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  options: FulfilOptions = {},
): Promise<void> {
  await endGrant(
    tenantId,
    actorUserId,
    grantId,
    'revoked',
    'handed back by the holder',
    'automate.grant.hand_back',
    options,
  );
}

/** An owner or an administrator taking it away. Same mechanism, different act. */
export async function revokeGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  reason: string,
  options: FulfilOptions = {},
): Promise<void> {
  await endGrant(
    tenantId,
    actorUserId,
    grantId,
    'revoked',
    reason,
    'automate.grant.revoke',
    options,
  );
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/workflow-service.js';`:

```ts
export * from './automate/fulfil.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/fulfil.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/fulfil.ts \
        packages/core/src/automate/fulfil.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): fulfilment, hand-back and revocation"
```

---

## Task 10: Submission — eligibility, the snapshot, and requesting on somebody's behalf

Spec §7 and §16's submission transaction. Five things in one short transaction: validate, write the request and its snapshot, resolve stage 1, audit, and write the outbox rows.

**Files:**
- Create: `packages/core/src/automate/request-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/request-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `hasPermission` and `PERMISSIONS` from `../rbac/`; `activeContracts` from `../identity/contract-service.js`; `resolveStageApprovers`, `type StageSnapshot`, `type ResolutionSubject` from `./approvers.js`; `loadWorkflowStages` from `./workflow-service.js`; `findVisibleProduct`, `subjectAudienceFacts` from `./catalog-service.js`; `audienceAdmits`, `type AudienceCondition` from `./audience.js`; `validateFormValues`, `type FormSchema` from `./form.js`; `resolveRequestedDuration`, `type DurationPolicy` from `./duration.js`; `fulfilRequest`, `subjectHoldings`, `requestUrl`, `type FulfilOptions` from `./fulfil.js`; `enqueueOutbox`, `recipientsForPersons`, `usersWithPermission` from `./notify.js`; `type RefusalReason`, `type RequestStatus` from `./types.js`.
- Produces:
  - `type SubmitOutcome = { ok: true; requestId: string; status: RequestStatus } | { ok: false; reason: RefusalReason; message: string }`
  - `interface SubmitRequestInput { productId: string; subjectPersonId: string; requestedByUserId: string; justification: string | null; formValues: Record<string, unknown>; requestedDurationDays: number | null; replacesGrantId?: string | null }`
  - `interface SubmitOptions extends FulfilOptions {}`
  - `async function submitRequest(tenantId: string, input: SubmitRequestInput, options?: SubmitOptions): Promise<SubmitOutcome>`
  - `async function checkEligibility(tx: TenantClient, productId: string, subjectPersonId: string, on: Date): Promise<{ ok: true } | { ok: false; reason: RefusalReason; message: string }>`
  - `async function openStage(tx: TenantClient, requestId: string, sequence: number, on: Date): Promise<'opened' | 'blocked'>` — **also used by Task 11**, which is why it lives here rather than in the decision service
  - `async function subjectFor(tx: TenantClient, requestId: string): Promise<ResolutionSubject>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/request-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createProduct } from './catalog-service.js';
import { upsertWorkflow } from './workflow-service.js';
import { submitRequest } from './request-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;
let janPersonId: string;
let helpdeskUserId: string;
let helpdeskPersonId: string;
let applicationId: string;
let productId: string;
let immediateProductId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const jan = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
    });
    await tx.contract.create({
      data: { tenantId, personId: jan.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
    });
    await tx.user.create({
      data: { tenantId, login: 'jan', email: 'jan@acme.test', displayName: 'Jan de Vries', personId: jan.id },
    });

    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        managerPersonId: jan.id,
      },
    });
    const annaUser = await tx.user.create({
      data: { tenantId, login: 'anna', email: 'anna@acme.test', displayName: 'Anna Novak', personId: anna.id },
    });

    const helpdesk = await tx.person.create({
      data: { tenantId, givenName: 'Hel', familyName: 'Desk' },
    });
    await tx.contract.create({
      data: { tenantId, personId: helpdesk.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
    });
    const helpdeskUser = await tx.user.create({
      data: { tenantId, login: 'hel', email: 'hel@acme.test', displayName: 'Hel Desk', personId: helpdesk.id },
    });

    const application = await tx.application.create({
      data: { tenantId, name: 'Stats', slug: 'stats' },
    });
    return {
      annaPersonId: anna.id,
      annaUserId: annaUser.id,
      janPersonId: jan.id,
      helpdeskPersonId: helpdesk.id,
      helpdeskUserId: helpdeskUser.id,
      applicationId: application.id,
    };
  });
  ({ annaPersonId, annaUserId, janPersonId, helpdeskPersonId, helpdeskUserId, applicationId } =
    seeded);

  const withStage = await upsertWorkflow(tenantId, null, null, {
    name: 'Manager approval',
    description: null,
    enabled: true,
    stages: [
      {
        sequence: 1,
        name: 'Manager',
        selector: 'manager',
        selectorConfig: {},
        quorum: 'any',
        fallbackSelector: 'person',
        fallbackConfig: { personId: janPersonId },
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
    ],
  });
  const immediate = await upsertWorkflow(tenantId, null, null, {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });

  productId = (
    await createProduct(tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: withStage.id,
      formSchema: [{ key: 'project', type: 'text', label: 'Project', required: true }],
      durationMode: 'requesterChoice',
      defaultDurationDays: 30,
      maxDurationDays: 90,
      ownerPersonId: janPersonId,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;

  immediateProductId = (
    await createProduct(tenantId, null, {
      name: 'Reading room',
      slug: 'reading-room',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { all: [] },
      workflowId: immediate.id,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: null,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;
});

const submit = (over: Record<string, unknown> = {}) =>
  submitRequest(
    tenantId,
    {
      productId,
      subjectPersonId: annaPersonId,
      requestedByUserId: annaUserId,
      justification: 'Q3 audit',
      formValues: { project: 'Audit' },
      requestedDurationDays: 30,
      ...over,
    },
    { now: NOW },
  );

describe('submitRequest — the happy path', () => {
  it('writes the request, one item per product grant, and one step per stage', async () => {
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, status: 'pending_approval' });
    if (!outcome.ok) throw new Error('unreachable');

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
      items: await tx.requestItem.findMany({ where: { requestId: outcome.requestId } }),
      steps: await tx.approvalStep.findMany({ where: { requestId: outcome.requestId } }),
      approvers: await tx.approvalStepApprover.findMany(),
    }));
    expect(state.items).toHaveLength(1);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.status).toBe('open');
    // The snapshot: the whole stage as it stood at submission.
    expect(state.steps[0]?.stageSnapshot).toMatchObject({ selector: 'manager' });
    expect(state.approvers.map((a) => a.personId)).toEqual([janPersonId]);
  });

  it('carries the stage SLA onto the step so a reminder has something to measure', async () => {
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const step = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findFirstOrThrow({ where: { requestId: outcome.requestId } }),
    );
    expect(step.slaDueAt).toEqual(new Date('2026-06-17T00:00:00Z'));
  });

  it('is unaffected by a later edit to the product it was submitted under', async () => {
    // What was reviewed is what is applied, literally. The same principle as
    // Directory Sync's materialized SyncChange and Provision's ProvisionAction.
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    await withTenant(tenantId, (tx) =>
      tx.productGrant.deleteMany({ where: { productId } }),
    );
    const items = await withTenant(tenantId, (tx) =>
      tx.requestItem.findMany({ where: { requestId: outcome.requestId } }),
    );
    expect(items).toHaveLength(1);
  });

  it('grants immediately when the workflow has zero stages', async () => {
    const outcome = await submitRequest(
      tenantId,
      {
        productId: immediateProductId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: null,
        formValues: {},
        requestedDurationDays: null,
      },
      { now: NOW },
    );
    expect(outcome).toMatchObject({ ok: true, status: 'fulfilled' });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('writes an audit event naming the subject, the submitter and what was asked for', async () => {
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.request.submit' } }),
    );
    expect(events[0]?.payload).toMatchObject({
      subjectPersonId: annaPersonId,
      productId,
      onBehalf: false,
    });
  });
});

describe('submitRequest — the refusals', () => {
  it('refuses a product the subject audience does not admit, without saying it exists', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('refuses when the subject has no contracts in force', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { endDate: day('2026-01-01') },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'subject_departed' });
  });

  it('refuses when the subject person record is inactive', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.update({ where: { id: annaPersonId }, data: { status: 'inactive' } }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'subject_inactive' });
  });

  it('refuses when the subject already holds every resource, naming where from', async () => {
    // Refused rather than silently fulfilled into a no-op: a person who asks
    // for something they already have has a different problem.
    await withTenant(tenantId, (tx) =>
      tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId: annaUserId },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'already_held' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toContain('already');
  });

  it('refuses a retired product', async () => {
    await withTenant(tenantId, (tx) =>
      tx.product.update({ where: { id: productId }, data: { status: 'retired' } }),
    );
    expect(await submit()).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('refuses an application product when the subject holds no account', async () => {
    // Refused at submission with that reason, rather than approved and then
    // found to be unfulfillable.
    await withTenant(tenantId, (tx) => tx.user.deleteMany({ where: { personId: annaPersonId } }));
    const outcome = await submit({ requestedByUserId: helpdeskUserId });
    expect(outcome).toMatchObject({ ok: false, reason: 'no_user_account' });
  });

  it('refuses a duration beyond the product cap, and names the cap', async () => {
    const outcome = await submit({ requestedDurationDays: 400 });
    expect(outcome).toMatchObject({ ok: false, reason: 'duration_not_permitted' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toContain('90');
  });

  it('refuses a form submission missing a required field', async () => {
    expect(await submit({ formValues: {} })).toMatchObject({
      ok: false,
      reason: 'invalid_form',
    });
  });

  it('refuses a request with no justification when the workflow has a stage', async () => {
    // An approver asked to decide with no stated reason will decide badly or
    // not at all.
    expect(await submit({ justification: '  ' })).toMatchObject({
      ok: false,
      reason: 'invalid_form',
    });
  });

  it('allows no justification when the workflow has no stages', async () => {
    const outcome = await submitRequest(
      tenantId,
      {
        productId: immediateProductId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: null,
        formValues: {},
        requestedDurationDays: null,
      },
      { now: NOW },
    );
    expect(outcome.ok).toBe(true);
  });

  it('refuses a product whose workflow has been disabled', async () => {
    await withTenant(tenantId, (tx) =>
      tx.approvalWorkflow.updateMany({ where: {}, data: { enabled: false } }),
    );
    expect(await submit()).toMatchObject({ ok: false, reason: 'workflow_disabled' });
  });
});

describe('requesting on behalf of somebody', () => {
  it('lets the subject own manager submit with no permission at all', async () => {
    const janUserId = await withTenant(tenantId, async (tx) =>
      (await tx.user.findFirstOrThrow({ where: { personId: janPersonId } })).id,
    );
    const outcome = await submit({ requestedByUserId: janUserId });
    expect(outcome.ok).toBe(true);
  });

  it('refuses anybody else without automate.request_on_behalf', async () => {
    expect(await submit({ requestedByUserId: helpdeskUserId })).toMatchObject({
      ok: false,
      reason: 'not_permitted_on_behalf',
    });
  });

  it('allows a helpdesk agent holding the permission', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          name: 'Helpdesk',
          permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF],
        },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
    });
    const outcome = await submit({ requestedByUserId: helpdeskUserId });
    expect(outcome.ok).toBe(true);
  });

  it('tells the subject at submission, before anybody decides', async () => {
    // A request made for you that you were never told about is the shape of a
    // privilege escalation, and the notification is what makes it visible
    // while it can still be stopped.
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          name: 'Helpdesk',
          permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF],
        },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
    });
    await submit({ requestedByUserId: helpdeskUserId });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    const told = outbox.find((o) => o.template === 'automate-request-submitted-for-you');
    expect(told?.to).toBe('anna@acme.test');
    expect(told?.sentAt).toBeNull();
  });

  it('never routes the stage to the submitter, even when they are the resolved approver', async () => {
    // The path a design that only checks the subject leaves open.
    const janUserId = await withTenant(tenantId, async (tx) =>
      (await tx.user.findFirstOrThrow({ where: { personId: janPersonId } })).id,
    );
    const outcome = await submit({ requestedByUserId: janUserId });
    if (!outcome.ok) throw new Error('unreachable');
    const approvers = await withTenant(tenantId, (tx) => tx.approvalStepApprover.findMany());
    expect(approvers.map((a) => a.personId)).not.toContain(janPersonId);
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
    );
    // Manager was the only selector and the fallback names the same person, so
    // there is nobody left. It says so rather than approving itself.
    expect(request.status).toBe('blocked_no_approver');
  });
});

describe('blocked_no_approver', () => {
  it('tells the product owner and the holders of automate.manage', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
      await tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: annaPersonId },
      });
      await tx.approvalStage.updateMany({ where: {}, data: { fallbackConfig: {} } });
    });
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
    );
    expect(request.status).toBe('blocked_no_approver');
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-blocked-no-approver' } }),
    );
    expect(outbox.map((o) => o.to).sort()).toEqual(['hel@acme.test', 'jan@acme.test']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/request-service.test.ts`
Expected: FAIL, "Failed to resolve import ./request-service.js".

- [ ] **Step 3: Write the submission service**

`packages/core/src/automate/request-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { activeContracts } from '../identity/contract-service.js';
import {
  resolveStageApprovers,
  type ResolutionSubject,
  type StageSnapshot,
} from './approvers.js';
import { loadWorkflowStages } from './workflow-service.js';
import { findVisibleProduct, subjectAudienceFacts } from './catalog-service.js';
import { validateFormValues, type FormSchema } from './form.js';
import { resolveRequestedDuration, type DurationMode } from './duration.js';
import {
  fulfilRequest,
  requestUrl,
  subjectHoldings,
  type FulfilOptions,
} from './fulfil.js';
import { enqueueOutbox, recipientsForPersons, usersWithPermission } from './notify.js';
import type { RefusalReason, RequestStatus, ResourceType } from './types.js';

export type SubmitOutcome =
  | { ok: true; requestId: string; status: RequestStatus }
  | { ok: false; reason: RefusalReason; message: string };

export interface SubmitRequestInput {
  productId: string;
  subjectPersonId: string;
  requestedByUserId: string;
  justification: string | null;
  formValues: Record<string, unknown>;
  requestedDurationDays: number | null;
  /** Set when this request is an extension of an existing grant. */
  replacesGrantId?: string | null;
}

export type SubmitOptions = FulfilOptions;

const refuse = (reason: RefusalReason, message: string): SubmitOutcome => ({
  ok: false,
  reason,
  message,
});

/**
 * Everything that makes a subject ineligible, checked in one place.
 *
 * Called at submission, at each stage opening, and again immediately before
 * fulfilment. The evaluation is the audience condition plus the subject's
 * employment state, both cheap and both pure -- which is what makes running it
 * three times affordable, and what stops an approval given on Monday for a
 * finance product from fulfilling on Friday after the subject left finance.
 */
export async function checkEligibility(
  tx: TenantClient,
  productId: string,
  subjectPersonId: string,
  on: Date,
): Promise<{ ok: true } | { ok: false; reason: RefusalReason; message: string }> {
  const person = await tx.person.findUnique({
    where: { id: subjectPersonId },
    select: { status: true, givenName: true, familyName: true },
  });
  if (person === null || person.status !== 'active') {
    return {
      ok: false,
      reason: 'subject_inactive',
      message: 'The person this was for is no longer active.',
    };
  }

  const contracts = await activeContracts(tx, subjectPersonId, on);
  if (contracts.length === 0) {
    return {
      ok: false,
      reason: 'subject_departed',
      message: `${person.givenName} ${person.familyName} holds no contract in force.`,
    };
  }

  const product = await tx.product.findUnique({ where: { id: productId } });
  if (product === null || product.status !== 'active') {
    return {
      ok: false,
      reason: 'product_withdrawn',
      message: 'That catalog entry has been withdrawn.',
    };
  }

  const visible = await findVisibleProduct(tx, subjectPersonId, productId, on);
  if (visible === null) {
    return {
      ok: false,
      reason: 'no_longer_eligible',
      message: `${person.givenName} ${person.familyName} no longer matches the audience for ${product.name}.`,
    };
  }

  return { ok: true };
}

/** The facts approver resolution needs about a request that already exists. */
export async function subjectFor(
  tx: TenantClient,
  requestId: string,
): Promise<ResolutionSubject> {
  const request = await tx.accessRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { items: true, product: true },
  });
  return {
    subjectPersonId: request.subjectPersonId,
    submitterPersonId: request.requestedByPersonId,
    productOwnerPersonId: request.product?.ownerPersonId ?? null,
    productOwnerGroupId: request.product?.ownerGroupId ?? null,
    productCategory: request.product?.category ?? null,
    resources: request.items.map((item) => ({
      resourceType: item.resourceType as ResourceType,
      resourceId: item.resourceId,
    })),
  };
}

/**
 * Opens one stage: resolves its approver set, materializes it, and says
 * whether anybody can decide.
 *
 * Materialized rather than recomputed at decision time, for the reason
 * Directory Sync materializes `SyncChange`: "who was this with, on the Tuesday
 * it was sitting there" has to be answerable a year later, against a directory
 * that has since moved.
 *
 * Lives here rather than in the decision service because both need it, and a
 * second copy is a second set of rules about who may approve.
 */
export async function openStage(
  tx: TenantClient,
  requestId: string,
  sequence: number,
  on: Date,
): Promise<'opened' | 'blocked'> {
  const step = await tx.approvalStep.findFirstOrThrow({
    where: { requestId, sequence },
  });
  const stage = step.stageSnapshot as unknown as StageSnapshot;
  const subject = await subjectFor(tx, requestId);
  const result = await resolveStageApprovers(tx, stage, subject, on);

  await tx.approvalStepApprover.deleteMany({ where: { stepId: step.id } });
  if (result.approvers.length === 0) return 'blocked';

  await tx.approvalStepApprover.createMany({
    data: result.approvers.map((approver) => ({
      tenantId: step.tenantId,
      stepId: step.id,
      personId: approver.personId,
      via: approver.via,
      onBehalfOfPersonId: approver.onBehalfOfPersonId,
    })),
  });
  await tx.approvalStep.update({
    where: { id: step.id },
    data: {
      status: 'open',
      openedAt: on,
      slaDueAt: new Date(on.getTime() + stage.slaHours * 3_600_000),
    },
  });
  return 'opened';
}

/**
 * The submission transaction of spec section 16, in order: validate, write the
 * request and its snapshot, resolve stage 1, audit, write the outbox rows.
 *
 * All of it is reads and writes over data already in PostgreSQL. Nothing
 * renders a template against a remote service and nothing sends anything, so
 * it fits comfortably inside `withTenant`.
 */
export async function submitRequest(
  tenantId: string,
  input: SubmitRequestInput,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const result = await withTenant(tenantId, async (tx): Promise<SubmitOutcome> => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      include: { grants: true, workflow: true },
    });
    // Absent and invisible read the same, so the catalog cannot be enumerated.
    if (product === null || product.status !== 'active') {
      return refuse('not_visible', 'That is not something you can ask for.');
    }

    const submitter = await tx.user.findUnique({
      where: { id: input.requestedByUserId },
      select: { id: true, personId: true, displayName: true },
    });
    if (submitter === null) {
      return refuse('not_permitted_on_behalf', 'That account no longer exists.');
    }
    const onBehalf = submitter.personId !== input.subjectPersonId;

    if (onBehalf) {
      // The subject's own manager needs no permission. Anybody else does.
      const contracts = await activeContracts(tx, input.subjectPersonId, now);
      const isManager = contracts.some((c) => c.managerPersonId === submitter.personId);
      const permitted =
        isManager ||
        (await hasPermission(tx, submitter.id, PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF));
      if (!permitted) {
        return refuse(
          'not_permitted_on_behalf',
          'You can ask for things for yourself and for the people who report to you.',
        );
      }
    }

    const eligibility = await checkEligibility(tx, input.productId, input.subjectPersonId, now);
    if (!eligibility.ok) {
      // "Not visible" rather than the more specific reason where the caller is
      // not the subject's manager or an administrator would leak the audience;
      // the caller is one of those in every path that reaches here, so the
      // reason is safe to state.
      return refuse(eligibility.reason, eligibility.message);
    }

    if (!product.workflow.enabled) {
      return refuse(
        'workflow_disabled',
        'The approval workflow for this product has been switched off. An administrator has to turn it back on.',
      );
    }

    const stages = await loadWorkflowStages(tx, product.workflowId);

    if (stages.length > 0 && (input.justification ?? '').trim() === '') {
      return refuse(
        'invalid_form',
        'Say why this is needed. An approver asked to decide with no stated reason will decide badly or not at all.',
      );
    }

    const form = validateFormValues(
      product.formSchema as unknown as FormSchema,
      input.formValues,
      product.grants.map((g) => g.id),
    );
    if (!form.ok) {
      return refuse(
        'invalid_form',
        form.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      );
    }

    const duration = resolveRequestedDuration(
      {
        durationMode: product.durationMode as DurationMode,
        defaultDurationDays: product.defaultDurationDays,
        maxDurationDays: product.maxDurationDays,
      },
      input.requestedDurationDays,
    );
    if (!duration.ok) return refuse('duration_not_permitted', duration.message);

    // An application or a local group needs somebody to grant it TO.
    if (product.kind !== 'targetEntitlement') {
      const users = await tx.user.count({
        where: { personId: input.subjectPersonId, status: 'active' },
      });
      if (users === 0) {
        return refuse(
          'no_user_account',
          'That person holds no active Syntra account, so there is nothing to grant this to.',
        );
      }
    }

    const held = await subjectHoldings(tx, input.subjectPersonId);
    const wanted = product.grants.map((g) => `${g.resourceType}:${g.resourceId}`);
    if (wanted.every((key) => held.has(key))) {
      const sources = wanted.map((key) => `${key} (${held.get(key)!.detail})`);
      return refuse(
        'already_held',
        `That is already held: ${sources.join(', ')}.`,
      );
    }

    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        productId: product.id,
        subjectPersonId: input.subjectPersonId,
        requestedByUserId: submitter.id,
        requestedByPersonId: submitter.personId,
        origin: 'catalog',
        justification: input.justification,
        formValues: form.values,
        requestedDurationDays: duration.days,
        replacesGrantId: input.replacesGrantId ?? null,
        status: 'pending_approval',
      },
    });

    // The snapshot. Written at submission so editing the product afterwards
    // changes nothing about this request.
    await tx.requestItem.createMany({
      data: product.grants.map((grant) => ({
        tenantId,
        requestId: request.id,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
      })),
    });
    if (stages.length > 0) {
      await tx.approvalStep.createMany({
        data: stages.map((stage) => ({
          tenantId,
          requestId: request.id,
          sequence: stage.sequence,
          stageSnapshot: stage as unknown as object,
          status: 'waiting',
        })),
      });
    }

    await recordEvent(tx, {
      actorUserId: submitter.id,
      action: 'automate.request.submit',
      targetType: 'AccessRequest',
      targetId: request.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        productId: product.id,
        subjectPersonId: input.subjectPersonId,
        onBehalf,
        stageCount: stages.length,
        requestedDurationDays: duration.days,
        items: wanted,
      },
    });

    const drafts: Parameters<typeof enqueueOutbox>[1][number][] = [];

    if (onBehalf) {
      // Always, at submission, before anybody decides.
      for (const recipient of await recipientsForPersons(tx, [input.subjectPersonId])) {
        drafts.push({
          template: 'automate-request-submitted-for-you',
          to: recipient.email,
          vars: {
            displayName: recipient.displayName,
            submitterName: submitter.displayName,
            productName: product.name,
            requestUrl: requestUrl(publicUrl, request.id),
          },
          requestId: request.id,
          userId: recipient.userId,
        });
      }
    }

    let status: RequestStatus = 'pending_approval';
    if (stages.length === 0) {
      // The empty stage list IS the auto-grant mechanism. Fulfilment happens
      // after this transaction, so the request is left `approved` here.
      status = 'approved';
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { status, decidedAt: now },
      });
    } else {
      const opened = await openStage(tx, request.id, 1, now);
      if (opened === 'blocked') {
        status = 'blocked_no_approver';
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status,
            statusReason: 'stage 1 resolved to nobody who can decide it, and so did its fallback',
          },
        });
        const owners =
          product.ownerPersonId === null
            ? []
            : await recipientsForPersons(tx, [product.ownerPersonId]);
        const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
        for (const recipient of [...owners, ...managers]) {
          drafts.push({
            template: 'automate-blocked-no-approver',
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              stageName: stages[0]!.name,
              productName: product.name,
              subjectName: input.subjectPersonId,
              droppedNote:
                'Everybody the stage resolved to was the subject, the submitter, or unable to sign in.',
              requestUrl: requestUrl(publicUrl, request.id),
            },
            requestId: request.id,
            userId: recipient.userId,
          });
        }
      } else {
        const approvers = await tx.approvalStepApprover.findMany({
          where: { step: { requestId: request.id, sequence: 1 } },
          select: { personId: true },
        });
        for (const recipient of await recipientsForPersons(
          tx,
          approvers.map((a) => a.personId),
        )) {
          drafts.push({
            template: 'automate-stage-opened',
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              requesterName: submitter.displayName,
              productName: product.name,
              subjectName: input.subjectPersonId,
              justification: input.justification ?? '',
              requestUrl: requestUrl(publicUrl, request.id),
            },
            requestId: request.id,
            userId: recipient.userId,
          });
        }
      }
    }

    await enqueueOutbox(tx, drafts);
    return { ok: true, requestId: request.id, status };
  });

  // Fulfilment is its own transaction, and it enqueues outside one. Running it
  // here rather than inside the submission transaction keeps both short and
  // keeps the pg-boss enqueue out of the request path's transaction entirely.
  if (result.ok && result.status === 'approved') {
    const fulfilled = await fulfilRequest(tenantId, result.requestId, options);
    return { ok: true, requestId: result.requestId, status: fulfilled.status };
  }
  return result;
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/fulfil.js';`:

```ts
export * from './automate/request-service.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/request-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/request-service.ts \
        packages/core/src/automate/request-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): submission, eligibility and the workflow snapshot"
```

---

## Task 11: Decision, cancellation, and the state machine that cannot approve itself

Spec §7, §9 and §16's decision transaction. The invariant is re-checked **at the moment of decision**, because a stage resolved on Monday and decided on Thursday is a stage whose manager relation, group membership and account status have all had three days to move.

**Files:**
- Create: `packages/core/src/automate/decision-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/decision-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `hasPermission`, `PERMISSIONS`; `isValidApprover`, `type StageSnapshot` from `./approvers.js`; `openStage`, `checkEligibility`, `subjectFor` from `./request-service.js`; `applyShortening` from `./duration.js`; `fulfilRequest`, `requestUrl`, `type FulfilOptions` from `./fulfil.js`; `enqueueOutbox`, `recipientsForPersons`, `usersWithPermission` from `./notify.js`; `type RequestStatus` from `./types.js`.
- Produces:
  - `class DecisionRefusedError extends Error { constructor(readonly code: string, message: string) }`
  - `interface DecisionInput { requestId: string; deciderPersonId: string; deciderUserId: string; decision: 'approve' | 'reject'; comment: string | null; shortenedToDays: number | null; sourceIp: string | null }`
  - `interface DecisionOptions extends FulfilOptions { asAdministrator?: boolean }`
  - `async function recordDecision(tenantId: string, input: DecisionInput, options?: DecisionOptions): Promise<{ status: RequestStatus }>`
  - `async function cancelRequest(tenantId: string, requestId: string, actorUserId: string, options?: FulfilOptions): Promise<void>`
  - `const APPROVED_ENTRY_POINTS: readonly string[]` — the exhaustive list of code paths that may write `status: 'approved'`, asserted against by the structural test

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/decision-service.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createProduct } from './catalog-service.js';
import { upsertWorkflow } from './workflow-service.js';
import { submitRequest } from './request-service.js';
import { DecisionRefusedError, cancelRequest, recordDecision } from './decision-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const LATER = new Date('2026-06-18T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;
let janPersonId: string;
let janUserId: string;
let boPersonId: string;
let boUserId: string;
let applicationId: string;
let productId: string;

async function person(name: string, over: { manager?: string } = {}) {
  return withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: p.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        ...(over.manager === undefined ? {} : { managerPersonId: over.manager }),
      },
    });
    const u = await tx.user.create({
      data: {
        tenantId,
        login: name.toLowerCase(),
        email: `${name.toLowerCase()}@acme.test`,
        displayName: name,
        personId: p.id,
      },
    });
    return { personId: p.id, userId: u.id };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  ({ personId: janPersonId, userId: janUserId } = await person('Jan'));
  ({ personId: boPersonId, userId: boUserId } = await person('Bo'));
  ({ personId: annaPersonId, userId: annaUserId } = await person('Anna', {
    manager: janPersonId,
  }));

  applicationId = await withTenant(tenantId, async (tx) =>
    (await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } })).id,
  );

  const workflow = await upsertWorkflow(tenantId, null, null, {
    name: 'Two stage',
    description: null,
    enabled: true,
    stages: [
      {
        sequence: 1,
        name: 'Manager',
        selector: 'manager',
        selectorConfig: {},
        quorum: 'any',
        fallbackSelector: 'person',
        fallbackConfig: { personId: boPersonId },
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
      {
        sequence: 2,
        name: 'Security',
        selector: 'person',
        selectorConfig: { personId: boPersonId },
        quorum: 'any',
        fallbackSelector: null,
        fallbackConfig: {},
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
    ],
  });

  productId = (
    await createProduct(tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: workflow.id,
      formSchema: [],
      durationMode: 'requesterChoice',
      defaultDurationDays: 30,
      maxDurationDays: 90,
      ownerPersonId: janPersonId,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;
});

async function open() {
  const outcome = await submitRequest(
    tenantId,
    {
      productId,
      subjectPersonId: annaPersonId,
      requestedByUserId: annaUserId,
      justification: 'Q3 audit',
      formValues: {},
      requestedDurationDays: 30,
    },
    { now: NOW },
  );
  if (!outcome.ok) throw new Error(`submit refused: ${outcome.reason}`);
  return outcome.requestId;
}

describe('recordDecision — walking the stages', () => {
  it('closes stage one, opens stage two, and does not fulfil yet', async () => {
    const requestId = await open();
    const result = await recordDecision(
      tenantId,
      {
        requestId,
        deciderPersonId: janPersonId,
        deciderUserId: janUserId,
        decision: 'approve',
        comment: null,
        shortenedToDays: null,
        sourceIp: null,
      },
      { now: LATER },
    );
    expect(result.status).toBe('pending_approval');

    const steps = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } }),
    );
    expect(steps.map((s) => s.status)).toEqual(['approved', 'open']);
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toEqual([]);
  });

  it('fulfils once the last stage is decided in favour', async () => {
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('fulfilled');
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('ends the request on a rejection at any stage, with no reject-and-continue', async () => {
    const requestId = await open();
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'reject', comment: 'not this quarter', shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('rejected');
    const steps = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } }),
    );
    expect(steps.map((s) => s.status)).toEqual(['rejected', 'skipped']);
  });

  it('refuses a rejection with no comment', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'reject', comment: '   ', shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('comment-required');
  });

  it('lets an approver shorten a duration and records it on the decision', async () => {
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: 7, sourceIp: null },
      { now: LATER },
    );
    const state = await withTenant(tenantId, async (tx) => ({
      decision: await tx.approvalDecision.findFirstOrThrow(),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.decision.shortenedToDays).toBe(7);
    expect(state.request.requestedDurationDays).toBe(7);
  });

  it('refuses an approver trying to lengthen', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: 365, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('duration');
  });

  it('requires every approver under an all quorum', async () => {
    const groupId = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
      for (const userId of [janUserId, boUserId]) {
        await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId } });
      }
      return group.id;
    });
    const workflow = await upsertWorkflow(tenantId, null, null, {
      name: 'Unanimous',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Security',
          selector: 'group',
          selectorConfig: { groupId },
          quorum: 'all',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'remind',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    await withTenant(tenantId, (tx) =>
      tx.product.update({ where: { id: productId }, data: { workflowId: workflow.id } }),
    );
    const requestId = await open();

    const first = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(first.status).toBe('pending_approval');
    const second = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(second.status).toBe('fulfilled');
  });
});

describe('the invariant, at the moment of decision', () => {
  it('refuses a decision from the subject even when they are in the resolved set', async () => {
    // Materialized rows are the record of who it was WITH; they are not the
    // authorisation. The check runs again here.
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findFirstOrThrow({ where: { requestId, sequence: 1 } });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: annaPersonId, via: 'selector' },
      });
    });
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: annaPersonId, deciderUserId: annaUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses a decision from the on-behalf submitter', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Helpdesk', permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });
    const outcome = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: annaPersonId,
        requestedByUserId: boUserId,
        justification: 'for Anna',
        formValues: {},
        requestedDurationDays: 30,
      },
      { now: NOW },
    );
    if (!outcome.ok) throw new Error('unreachable');
    await recordDecision(
      tenantId,
      { requestId: outcome.requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    // Stage 2 names Bo by person, and Bo is the submitter.
    const failure = await recordDecision(
      tenantId,
      { requestId: outcome.requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses a decision from somebody who was resolved and has since been deactivated', async () => {
    // Deactivation revokes sessions in Core, which covers most of it. "Most of
    // it" is not a security control, so the check is repeated at the act.
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: janUserId }, data: { status: 'inactive' } }),
    );
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('approver-invalid');
  });

  it('refuses a decision from somebody who was never on the step at all', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-an-approver');
  });
});

describe('re-checking eligibility between the stages', () => {
  it('refuses the request when the subject stops matching the audience mid-flight', async () => {
    // An approval given on Monday for a finance product must not fulfil on
    // Friday after the subject left finance.
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('rejected');
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.statusReason).toContain('no_longer_eligible');
  });

  it('tells the approver who already decided that their approval was made moot', async () => {
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-refused' } }),
    );
    expect(outbox.map((o) => o.to)).toContain('jan@acme.test');
  });

  it('re-resolves an open stage when the subject manager changed', async () => {
    // Decisions already recorded on COMPLETED stages stand -- they were valid
    // when made. The open one is reassigned, and both parties are told.
    const { personId: rikPersonId } = await person('Rik');
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: rikPersonId },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: rikPersonId, deciderUserId: (await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({ where: { personId: rikPersonId } }))).id, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch(() => undefined);
    // Rik is not on the materialized set until the stage is re-resolved, which
    // is what the reassignment does; the old approver is gone afterwards.
    const approvers = await withTenant(tenantId, (tx) =>
      tx.approvalStepApprover.findMany({ where: { step: { requestId, sequence: 1 } } }),
    );
    expect(approvers.map((a) => a.personId)).toEqual([rikPersonId]);
  });
});

describe('an administrator deciding a blocked request', () => {
  it('records the decision with the administrator named, and still applies the invariant', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });

    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: 'fixed by hand', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    );
    const decision = await withTenant(tenantId, (tx) => tx.approvalDecision.findFirstOrThrow());
    expect(decision.via).toBe('administrator');

    // And the subject still cannot do it, administrator or not.
    const second = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: second },
        data: { status: 'blocked_no_approver' },
      });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'Automate admin' } });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: annaUserId } });
    });
    const failure = await recordDecision(
      tenantId,
      { requestId: second, deciderPersonId: annaPersonId, deciderUserId: annaUserId, decision: 'approve', comment: 'me', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses an administrator override on a request that is not blocked', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: 'x', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-blocked');
  });
});

describe('cancelRequest', () => {
  it('withdraws before approval and tells the open stage approvers', async () => {
    const requestId = await open();
    await cancelRequest(tenantId, requestId, annaUserId, { now: LATER });
    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-cancelled' },
      }),
    }));
    expect(state.request.status).toBe('cancelled');
    expect(state.outbox.map((o) => o.to)).toEqual(['jan@acme.test']);
  });

  it('refuses to cancel after approval', async () => {
    // After approval the honest act is to hand the access back, which is its
    // own recorded event, not a race with an apply in flight.
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const failure = await cancelRequest(tenantId, requestId, annaUserId, { now: LATER }).catch(
      (e: unknown) => e,
    );
    expect((failure as DecisionRefusedError).code).toBe('too-late');
  });

  it('refuses a cancel by somebody who is not the requester', async () => {
    const requestId = await open();
    const failure = await cancelRequest(tenantId, requestId, boUserId, { now: LATER }).catch(
      (e: unknown) => e,
    );
    expect((failure as DecisionRefusedError).code).toBe('not-the-requester');
  });
});

/**
 * The structural test, in the shape of Provision's never-deletes test.
 *
 * Not a behaviour test: a behaviour test proves that the paths that exist
 * today behave. This proves that no OTHER path can exist. Adding a
 * timeout-approval later fails here rather than passing review.
 */
describe('no transition into approved exists that is not caused by a decision', () => {
  const FILES = [
    'packages/core/src/automate/decision-service.ts',
    'packages/core/src/automate/request-service.ts',
    'packages/core/src/automate/jobs.ts',
    'packages/core/src/automate/sweep-service.ts',
    'packages/core/src/automate/reflect.ts',
    'packages/core/src/automate/delegation-service.ts',
    'packages/core/src/automate/fulfil.ts',
  ];

  it('writes status approved in exactly two places, both of them decisions', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        // A module this plan has not written yet cannot contain a violation.
        continue;
      }
      for (const [index, line] of source.split('\n').entries()) {
        if (/status:\s*'approved'/.test(line)) hits.push(`${file}:${index + 1}`);
      }
    }
    // request-service.ts: the zero-stage workflow, where the empty stage list
    //   IS the grant and the catalog says "granted immediately".
    // decision-service.ts: the last stage decided in favour by a person.
    // Nowhere else. Not a timeout, not a sweep, not a job, not a reflection.
    expect(hits).toHaveLength(2);
    expect(hits.some((h) => h.startsWith('packages/core/src/automate/request-service.ts'))).toBe(true);
    expect(hits.some((h) => h.startsWith('packages/core/src/automate/decision-service.ts'))).toBe(true);
  });

  it('has no onTimeout value that could mean approve', () => {
    const source = readFileSync('packages/core/src/automate/approvers.ts', 'utf8');
    expect(source).toContain("'remind' | 'escalate' | 'expire'");
    expect(source).not.toMatch(/onTimeout[^\n]*approve/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/decision-service.test.ts`
Expected: FAIL, "Failed to resolve import ./decision-service.js".

- [ ] **Step 3: Write the decision service**

`packages/core/src/automate/decision-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { isValidApprover, type StageSnapshot } from './approvers.js';
import { checkEligibility, openStage } from './request-service.js';
import { applyShortening } from './duration.js';
import { fulfilRequest, requestUrl, type FulfilOptions } from './fulfil.js';
import { enqueueOutbox, recipientsForPersons } from './notify.js';
import type { RequestStatus } from './types.js';

export class DecisionRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionRefusedError';
  }
}

export interface DecisionInput {
  requestId: string;
  deciderPersonId: string;
  deciderUserId: string;
  decision: 'approve' | 'reject';
  comment: string | null;
  shortenedToDays: number | null;
  sourceIp: string | null;
}

export interface DecisionOptions extends FulfilOptions {
  /**
   * Deciding a `blocked_no_approver` request by hand. Requires
   * `automate.manage`, is recorded with `via: 'administrator'`, and is subject
   * to the invariant like every other decision.
   */
  asAdministrator?: boolean;
}

/**
 * The one short transaction of spec section 16: re-check validity, write the
 * decision, close or advance the step, resolve the next stage's approvers,
 * audit, write the outbox rows.
 */
export async function recordDecision(
  tenantId: string,
  input: DecisionInput,
  options: DecisionOptions = {},
): Promise<{ status: RequestStatus }> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const result = await withTenant(tenantId, async (tx): Promise<{ status: RequestStatus }> => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: input.requestId },
      include: { product: true },
    });

    const administrative = options.asAdministrator === true;
    if (administrative) {
      if (request.status !== 'blocked_no_approver') {
        throw new DecisionRefusedError(
          'not-blocked',
          'Only a request with nobody to approve it can be decided by an administrator.',
        );
      }
      const allowed = await hasPermission(
        tx,
        input.deciderUserId,
        PERMISSIONS.AUTOMATE_MANAGE,
      );
      if (!allowed) {
        throw new DecisionRefusedError(
          'not-permitted',
          'Deciding a blocked request by hand requires automate.manage.',
        );
      }
    } else if (request.status !== 'pending_approval') {
      throw new DecisionRefusedError(
        'not-open',
        'That request is not waiting for a decision.',
      );
    }

    // THE INVARIANT. First, before anything else this function does, and
    // repeated here rather than trusted from resolution: the manager relation,
    // the group membership and the account status all move between the stage
    // opening and the decision.
    if (
      input.deciderPersonId === request.subjectPersonId ||
      (request.requestedByPersonId !== null &&
        input.deciderPersonId === request.requestedByPersonId)
    ) {
      throw new DecisionRefusedError(
        'self-approval',
        'Nobody may decide a request they are the subject or the submitter of.',
      );
    }

    if (input.decision === 'reject' && (input.comment ?? '').trim() === '') {
      throw new DecisionRefusedError(
        'comment-required',
        'Say why. A refusal with no reason is a request the person will simply raise again.',
      );
    }

    const invalid = await isValidApprover(tx, input.deciderPersonId, now);
    if (invalid !== null) {
      throw new DecisionRefusedError(
        'approver-invalid',
        `That account can no longer decide requests (${invalid}).`,
      );
    }

    const step = administrative
      ? await tx.approvalStep.findFirstOrThrow({
          where: { requestId: request.id, status: { in: ['open', 'waiting'] } },
          orderBy: { sequence: 'asc' },
        })
      : await tx.approvalStep.findFirstOrThrow({
          where: { requestId: request.id, status: 'open' },
        });

    if (!administrative) {
      const onStep = await tx.approvalStepApprover.findFirst({
        where: { stepId: step.id, personId: input.deciderPersonId },
      });
      if (onStep === null) {
        throw new DecisionRefusedError(
          'not-an-approver',
          'This request is not with you.',
        );
      }
      var via = onStep.via;
      var onBehalfOfPersonId = onStep.onBehalfOfPersonId;
    } else {
      var via = 'administrator';
      var onBehalfOfPersonId: string | null = null;
    }

    const shortened = applyShortening(request.requestedDurationDays, input.shortenedToDays);
    if (!shortened.ok) throw new DecisionRefusedError('duration', shortened.message);

    await tx.approvalDecision.create({
      data: {
        tenantId,
        stepId: step.id,
        personId: input.deciderPersonId,
        userId: input.deciderUserId,
        decision: input.decision,
        comment: input.comment,
        shortenedToDays: input.shortenedToDays,
        via,
        onBehalfOfPersonId,
        decidedAt: now,
      },
    });
    if (input.shortenedToDays !== null) {
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { requestedDurationDays: shortened.days },
      });
    }

    await recordEvent(tx, {
      actorUserId: input.deciderUserId,
      action: 'automate.request.decide',
      targetType: 'AccessRequest',
      targetId: request.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        stepSequence: step.sequence,
        deciderPersonId: input.deciderPersonId,
        subjectPersonId: request.subjectPersonId,
        submitterPersonId: request.requestedByPersonId,
        decision: input.decision,
        via,
        onBehalfOfPersonId,
        shortenedToDays: input.shortenedToDays,
      },
    });

    const stage = step.stageSnapshot as unknown as StageSnapshot;
    const requesterAndSubject = await recipientsForPersons(tx, [
      request.subjectPersonId,
      ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
    ]);
    const decidedBefore = await tx.approvalDecision.findMany({
      where: { step: { requestId: request.id } },
      select: { personId: true },
    });
    const alreadyDecided = await recipientsForPersons(
      tx,
      decidedBefore.map((d) => d.personId),
    );
    const vars = {
      productName: request.product?.name ?? 'the requested access',
      subjectName: request.subjectPersonId,
      approverName: input.deciderPersonId,
      comment: input.comment ?? '',
      shortenedNote:
        input.shortenedToDays === null ? '' : ` for ${input.shortenedToDays} days`,
      requestUrl: requestUrl(publicUrl, request.id),
    };

    if (input.decision === 'reject') {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: { status: 'rejected', closedAt: now },
      });
      // No reject-and-continue: every later stage is skipped, not left open.
      await tx.approvalStep.updateMany({
        where: { requestId: request.id, status: 'waiting' },
        data: { status: 'skipped', closedAt: now },
      });
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { status: 'rejected', statusReason: input.comment, decidedAt: now },
      });
      await enqueueOutbox(
        tx,
        [...requesterAndSubject, ...alreadyDecided].map((r) => ({
          template: 'automate-rejected' as const,
          to: r.email,
          vars: { ...vars, displayName: r.displayName },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      return { status: 'rejected' };
    }

    // Quorum. `any` closes on the first decision; `all` needs one approval
    // from every materialized approver, and a delegate's approval satisfies
    // their delegator's obligation -- which is what a delegation means.
    if (stage.quorum === 'all' && !administrative) {
      const approvers = await tx.approvalStepApprover.findMany({
        where: { stepId: step.id },
      });
      const decisions = await tx.approvalDecision.findMany({
        where: { stepId: step.id, decision: 'approve' },
      });
      const satisfied = new Set<string>();
      for (const decision of decisions) {
        satisfied.add(decision.personId);
        if (decision.onBehalfOfPersonId !== null) satisfied.add(decision.onBehalfOfPersonId);
      }
      const outstanding = approvers.filter(
        (a) => !satisfied.has(a.personId) && !(a.onBehalfOfPersonId !== null && satisfied.has(a.onBehalfOfPersonId)),
      );
      if (outstanding.length > 0) return { status: 'pending_approval' };
    }

    await tx.approvalStep.update({
      where: { id: step.id },
      data: { status: 'approved', closedAt: now },
    });

    // Re-evaluated at each stage opening, per spec section 7. The naive
    // implementation -- resolve everything at submission, apply at approval --
    // grants finance access to somebody who left finance three days ago.
    if (request.productId !== null) {
      const eligibility = await checkEligibility(
        tx,
        request.productId,
        request.subjectPersonId,
        now,
      );
      if (!eligibility.ok) {
        await tx.approvalStep.updateMany({
          where: { requestId: request.id, status: { in: ['waiting', 'open'] } },
          data: { status: 'skipped', closedAt: now },
        });
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status: 'rejected',
            statusReason: `${eligibility.reason}: ${eligibility.message}`,
            decidedAt: now,
          },
        });
        // Every approver who already decided is told, because somebody's
        // approval was just made moot and they should know why.
        await enqueueOutbox(
          tx,
          [...requesterAndSubject, ...alreadyDecided].map((r) => ({
            template: 'automate-refused' as const,
            to: r.email,
            vars: { ...vars, displayName: r.displayName, reason: eligibility.message },
            requestId: request.id,
            userId: r.userId,
          })),
        );
        return { status: 'rejected' };
      }
    }

    const next = await tx.approvalStep.findFirst({
      where: { requestId: request.id, status: 'waiting' },
      orderBy: { sequence: 'asc' },
    });

    if (next !== null) {
      const opened = await openStage(tx, request.id, next.sequence, now);
      if (opened === 'blocked') {
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status: 'blocked_no_approver',
            statusReason: `stage ${next.sequence} resolved to nobody who can decide it, and so did its fallback`,
          },
        });
        return { status: 'blocked_no_approver' };
      }
      const approvers = await tx.approvalStepApprover.findMany({
        where: { stepId: next.id },
        select: { personId: true },
      });
      await enqueueOutbox(
        tx,
        (await recipientsForPersons(tx, approvers.map((a) => a.personId))).map((r) => ({
          template: 'automate-stage-opened' as const,
          to: r.email,
          vars: {
            ...vars,
            displayName: r.displayName,
            requesterName: request.requestedByUserId,
            justification: request.justification ?? '',
          },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      return { status: 'pending_approval' };
    }

    // The last stage, decided in favour by a person. One of exactly two places
    // in this slice that writes `approved`.
    await tx.accessRequest.update({
      where: { id: request.id },
      data: { status: 'approved', decidedAt: now },
    });
    await enqueueOutbox(
      tx,
      requesterAndSubject.map((r) => ({
        template: 'automate-approved' as const,
        to: r.email,
        vars: { ...vars, displayName: r.displayName },
        requestId: request.id,
        userId: r.userId,
      })),
    );
    return { status: 'approved' };
  });

  if (result.status === 'approved') {
    const fulfilled = await fulfilRequest(tenantId, input.requestId, options);
    return { status: fulfilled.status };
  }
  return result;
}

/**
 * A requester withdrawing their own request, until it reaches `approved` and
 * not after.
 *
 * After approval the grant may already be mid-apply at a target, and a cancel
 * that races a Provision action produces a state nobody described. What a
 * person does after approval is hand the access back.
 */
export async function cancelRequest(
  tenantId: string,
  requestId: string,
  actorUserId: string,
  options: FulfilOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  await withTenant(tenantId, async (tx) => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { product: true },
    });
    if (request.requestedByUserId !== actorUserId) {
      throw new DecisionRefusedError(
        'not-the-requester',
        'Only the person who raised a request can withdraw it.',
      );
    }
    if (!['pending_approval', 'blocked_no_approver'].includes(request.status)) {
      throw new DecisionRefusedError(
        'too-late',
        'This has already been decided. To give the access back, use "hand it back" on the grant.',
      );
    }

    const openApprovers = await tx.approvalStepApprover.findMany({
      where: { step: { requestId, status: 'open' } },
      select: { personId: true },
    });

    await tx.approvalStep.updateMany({
      where: { requestId, status: { in: ['open', 'waiting'] } },
      data: { status: 'skipped', closedAt: now },
    });
    await tx.accessRequest.update({
      where: { id: requestId },
      data: { status: 'cancelled', statusReason: 'withdrawn by the requester', decidedAt: now },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.request.cancel',
      targetType: 'AccessRequest',
      targetId: requestId,
      outcome: 'success',
      sourceIp: null,
      payload: { subjectPersonId: request.subjectPersonId },
    });

    // So they stop looking at it.
    await enqueueOutbox(
      tx,
      (await recipientsForPersons(tx, openApprovers.map((a) => a.personId))).map((r) => ({
        template: 'automate-cancelled' as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          requesterName: request.requestedByUserId,
          productName: request.product?.name ?? 'the requested access',
          requestUrl: requestUrl(publicUrl, requestId),
        },
        requestId,
        userId: r.userId,
      })),
    );
  });
}
```

- [ ] **Step 4: Replace the `var` declarations the draft above uses**

The `via` / `onBehalfOfPersonId` branch is written with `var` so both branches share one binding. Rewrite it as a `const` pair to keep the file free of `var`:

```ts
    const routing = administrative
      ? { via: 'administrator' as const, onBehalfOfPersonId: null as string | null }
      : await (async () => {
          const onStep = await tx.approvalStepApprover.findFirst({
            where: { stepId: step.id, personId: input.deciderPersonId },
          });
          if (onStep === null) {
            throw new DecisionRefusedError('not-an-approver', 'This request is not with you.');
          }
          return { via: onStep.via, onBehalfOfPersonId: onStep.onBehalfOfPersonId };
        })();
    const { via, onBehalfOfPersonId } = routing;
```

Marked as a correction rather than quietly fixed, because `var` in an ESM module is the kind of thing a reviewer should see was noticed.

- [ ] **Step 5: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/request-service.js';`:

```ts
export * from './automate/decision-service.js';
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/core/src/automate/decision-service.test.ts`
Expected: PASS, including the two structural cases.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/automate/decision-service.ts \
        packages/core/src/automate/decision-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): decisions, cancellation, and the invariant at decision time"
```

---

## Task 12: Reflection — what Provision's run did to the grant

Spec §5 and §16. The state between approval and access is `awaiting_fulfilment`, and it is **loud**.

**Why a poll and not a callback.** Provision's plan exposes no completion hook on `applyProvisionRun`, and `apps/api/src/scheduler.ts` has no announce/listen seam for runs. Reflection is therefore an idempotent pass driven by the `automate.tick` schedule. That is strictly more robust than a hook: it recovers from a crash between the apply and the callback, which is exactly when a request would otherwise sit in `awaiting_fulfilment` forever.

**Files:**
- Create: `packages/core/src/automate/reflect.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/reflect.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent`; `PERMISSIONS`; `type Scheduler`; `PROVISION_JOB`, `provisionJobPayload` from `../provision/jobs.js`; `automateSettings` from `./catalog-service.js`; `enqueueOutbox`, `recipientsForPersons`, `usersWithPermission` from `./notify.js`; `requestUrl` from `./fulfil.js`; `type RequestStatus` from `./types.js`.
- Produces:
  - `interface ReflectOptions { now?: Date; scheduler?: Scheduler | null; publicUrl?: string }`
  - `interface ReflectResult { linked: number; fulfilled: number; failed: number; redispatched: number; slaAlerts: number }`
  - `async function reflectProvisionOutcomes(tenantId: string, options?: ReflectOptions): Promise<ReflectResult>`
  - `const TERMINAL_ACTION_STATUSES: readonly string[]` — `['applied', 'failed', 'skipped', 'conflict']`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/reflect.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { reflectProvisionOutcomes } from './reflect.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const MUCH_LATER = new Date('2026-06-17T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let personId: string;
let userId: string;
let targetSystemId: string;
let entitlementId: string;
let requestId: string;
let itemId: string;
let grantId: string;
let runId: string;

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        externalId: 'guid-stats',
        type: 'group',
        displayName: 'Stats',
      },
    });
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        subjectPersonId: person.id,
        requestedByUserId: user.id,
        requestedByPersonId: person.id,
        status: 'awaiting_fulfilment',
        dispatchedAt: NOW,
      },
    });
    const grant = await tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId: person.id,
        resourceType: 'entitlement',
        resourceId: entitlement.id,
        targetSystemId: target.id,
        requestId: request.id,
        startsAt: NOW,
        status: 'pending',
      },
    });
    const item = await tx.requestItem.create({
      data: {
        tenantId,
        requestId: request.id,
        resourceType: 'entitlement',
        resourceId: entitlement.id,
        targetSystemId: target.id,
        status: 'dispatched',
        grantId: grant.id,
      },
    });
    const run = await tx.provisionRun.create({
      data: { tenantId, targetSystemId: target.id, status: 'applied' },
    });
    return {
      personId: person.id,
      userId: user.id,
      targetSystemId: target.id,
      entitlementId: entitlement.id,
      requestId: request.id,
      itemId: item.id,
      grantId: grant.id,
      runId: run.id,
    };
  });
  ({ personId, userId, targetSystemId, entitlementId, requestId, itemId, grantId, runId } =
    seeded);
});

const action = (status: string, message: string | null = null) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.create({
      data: {
        tenantId,
        runId,
        actionType: 'grant_entitlement',
        personId,
        entitlementId,
        grantId,
        status,
        message,
        sequence: 1,
      },
    }),
  );

describe('reflectProvisionOutcomes', () => {
  it('moves the grant to active and the request to fulfilled when the action applied', async () => {
    await action('applied');
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result).toMatchObject({ fulfilled: 1, failed: 0 });

    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany(),
    }));
    expect(state.grant.status).toBe('active');
    expect(state.item.status).toBe('fulfilled');
    expect(state.request.status).toBe('fulfilled');
    expect(state.outbox.map((o) => o.template)).toContain('automate-fulfilled');
  });

  it('leaves the grant out of active and tells three parties when the action failed', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      const admin = await tx.user.create({
        data: { tenantId, login: 'adm', email: 'adm@acme.test', displayName: 'Adm' },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: admin.id } });
    });
    await action('failed', 'WILL_NOT_PERFORM: 0x2082');

    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-fulfilment-failed' },
      }),
    }));
    // The console must never claim somebody holds something they do not.
    expect(state.grant.status).toBe('pending');
    expect(state.item.status).toBe('failed');
    // The target's OWN message, carried through rather than replaced by a
    // generic one -- the message is the only thing that tells an
    // administrator what to fix.
    expect(state.item.message).toContain('WILL_NOT_PERFORM');
    expect(state.request.status).toBe('fulfilment_failed');
    expect(state.outbox.map((o) => o.to).sort()).toEqual(['adm@acme.test', 'anna@acme.test']);
  });

  it('stays awaiting_fulfilment when the action was superseded, and re-enqueues', async () => {
    // The case that looks like a failure and is not. The grant is still in
    // desired state, so the superseding run re-proposes it.
    const scheduler = schedulerStub();
    await action('superseded');
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });

    const state = await withTenant(tenantId, async (tx) => ({
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.item.status).toBe('dispatched');
    expect(state.request.status).toBe('awaiting_fulfilment');
    expect(result.redispatched).toBe(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('recovers a request whose run was never enqueued at all', async () => {
    // The window the non-transactional enqueue opens, and the crash between
    // the commit and the enqueue, are the same failure and this closes both.
    const scheduler = schedulerStub();
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });
    expect(result.redispatched).toBe(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('does not enqueue a second run while one is already in flight', async () => {
    const scheduler = schedulerStub();
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({ where: { id: runId }, data: { status: 'previewed' } }),
    );
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });
    expect(result.redispatched).toBe(0);
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('recovers a request that failed once and succeeded on a later run', async () => {
    // Terminal for the REQUEST is not terminal for the grant: the grant is
    // still in desired state, so a fixed target converges without anybody
    // raising a second request. The request follows its items.
    await action('failed', 'transient');
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.requestItem.update({ where: { id: itemId }, data: { provisionActionId: null, status: 'dispatched' } }),
    );
    await action('applied');
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('fulfilled');
  });

  it('warns the holders of automate.manage once past the fulfilment SLA', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      const admin = await tx.user.create({
        data: { tenantId, login: 'adm', email: 'adm@acme.test', displayName: 'Adm' },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: admin.id } });
    });

    const first = await reflectProvisionOutcomes(tenantId, { now: MUCH_LATER });
    expect(first.slaAlerts).toBe(1);
    // Once, not on every tick. A dashboard alert that repeats every five
    // minutes is a dashboard alert people filter.
    const second = await reflectProvisionOutcomes(tenantId, { now: MUCH_LATER });
    expect(second.slaAlerts).toBe(0);
  });

  it('does not warn before the SLA has passed', async () => {
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result.slaAlerts).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/reflect.test.ts`
Expected: FAIL, "Failed to resolve import ./reflect.js".

- [ ] **Step 3: Write the reflection pass**

`packages/core/src/automate/reflect.ts`:

```ts
import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { automateSettings } from './catalog-service.js';
import { enqueueOutbox, recipientsForPersons, usersWithPermission } from './notify.js';
import { requestUrl } from './fulfil.js';
import type { RequestStatus } from './types.js';

export interface ReflectOptions {
  now?: Date;
  scheduler?: Scheduler | null;
  publicUrl?: string;
}

export interface ReflectResult {
  linked: number;
  fulfilled: number;
  failed: number;
  redispatched: number;
  slaAlerts: number;
}

/**
 * The Provision action statuses that will not change again.
 *
 * `superseded` is deliberately absent. A superseded action means a newer run
 * replaced this one; the grant is still in desired state, so the newer run
 * re-proposes it. That is the case that looks like a failure and is not.
 */
export const TERMINAL_ACTION_STATUSES: readonly string[] = [
  'applied',
  'failed',
  'skipped',
  'conflict',
];

const NON_TERMINAL_RUN_STATUSES = ['running', 'previewed', 'blocked', 'applying'];

/**
 * Reads what Provision did and moves the grants and requests to match.
 *
 * Idempotent by construction: it derives every state from the rows rather than
 * from what it did last time, so running it twice, or after a crash, or on a
 * schedule while a run is in flight, all produce the same answer.
 */
export async function reflectProvisionOutcomes(
  tenantId: string,
  options: ReflectOptions = {},
): Promise<ReflectResult> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const { result, targetsToRun } = await withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    const result: ReflectResult = {
      linked: 0,
      fulfilled: 0,
      failed: 0,
      redispatched: 0,
      slaAlerts: 0,
    };

    const items = await tx.requestItem.findMany({
      where: { status: 'dispatched', resourceType: 'entitlement' },
    });

    const touchedRequestIds = new Set<string>();
    const targetsToRun = new Set<string>();

    for (const item of items) {
      touchedRequestIds.add(item.requestId);

      // Link the action if it has not been linked. The action carries the
      // grant id Provision wrote at plan time, so the join needs no guessing.
      let actionId = item.provisionActionId;
      if (actionId === null && item.grantId !== null) {
        const action = await tx.provisionAction.findFirst({
          where: { grantId: item.grantId, actionType: 'grant_entitlement' },
          orderBy: { createdAt: 'desc' },
        });
        if (action !== null) {
          actionId = action.id;
          await tx.requestItem.update({
            where: { id: item.id },
            data: { provisionActionId: action.id },
          });
          result.linked += 1;
        }
      }

      if (actionId === null) {
        // Approved, dispatched, and no run has ever planned it. Either the
        // enqueue never happened or it happened and the run has not started.
        if (item.targetSystemId !== null) targetsToRun.add(item.targetSystemId);
        continue;
      }

      const action = await tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } });

      if (action.status === 'superseded') {
        // Not a failure. Unlink so the next run's action is picked up, and ask
        // for a run in case none is pending.
        await tx.requestItem.update({
          where: { id: item.id },
          data: { provisionActionId: null },
        });
        if (item.targetSystemId !== null) targetsToRun.add(item.targetSystemId);
        continue;
      }

      if (!TERMINAL_ACTION_STATUSES.includes(action.status)) continue;

      if (action.status === 'applied') {
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'fulfilled', message: null },
        });
        if (item.grantId !== null) {
          await tx.accessGrant.update({
            where: { id: item.grantId },
            data: { status: 'active' },
          });
        }
        result.fulfilled += 1;
      } else {
        await tx.requestItem.update({
          where: { id: item.id },
          // The target's own message. Replacing it with a generic one throws
          // away the only thing that tells an administrator what to fix.
          data: { status: 'failed', message: action.message ?? action.status },
        });
        // The grant is NOT moved to active, and it is NOT ended either: it is
        // still in desired state, so a fixed target converges on the next run
        // without anybody raising a second request.
        result.failed += 1;
      }
    }

    // Requests whose items all reached a terminal state, recomputed from the
    // items rather than accumulated -- which is what lets a request that
    // failed once and succeeded later end up `fulfilled`.
    for (const requestId of touchedRequestIds) {
      const request = await tx.accessRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { items: true, product: true },
      });
      const inFlight = request.items.some(
        (i) => i.status === 'pending' || i.status === 'dispatched',
      );
      const landed = request.items.some((i) => i.status === 'fulfilled');
      const failed = request.items.some((i) => i.status === 'failed');

      const status: RequestStatus = inFlight
        ? 'awaiting_fulfilment'
        : failed && landed
          ? 'partially_fulfilled'
          : failed
            ? 'fulfilment_failed'
            : 'fulfilled';
      if (status === request.status) continue;

      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status, ...(inFlight ? {} : { fulfilledAt: now }) },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'automate.request.reflect',
        targetType: 'AccessRequest',
        targetId: requestId,
        outcome: status === 'fulfilment_failed' ? 'failure' : 'success',
        sourceIp: null,
        payload: { from: request.status, to: status },
      });

      const recipients = await recipientsForPersons(tx, [
        request.subjectPersonId,
        ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
      ]);
      const managers =
        status === 'fulfilled'
          ? []
          : await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      const template =
        status === 'fulfilled'
          ? ('automate-fulfilled' as const)
          : status === 'partially_fulfilled'
            ? ('automate-partially-fulfilled' as const)
            : ('automate-fulfilment-failed' as const);
      if (status === 'awaiting_fulfilment') continue;

      const failedMessages = request.items
        .filter((i) => i.status === 'failed')
        .map((i) => i.message ?? 'no message')
        .join('; ');
      await enqueueOutbox(
        tx,
        [...recipients, ...managers].map((r) => ({
          template,
          to: r.email,
          vars: {
            displayName: r.displayName,
            productName: request.product?.name ?? 'the requested access',
            subjectName: request.subjectPersonId,
            targetName: request.items[0]?.targetSystemId ?? '',
            message: failedMessages,
            grantedList: request.items
              .filter((i) => i.status === 'fulfilled')
              .map((i) => i.resourceId)
              .join(', '),
            failedList: request.items
              .filter((i) => i.status === 'failed')
              .map((i) => i.resourceId)
              .join(', '),
            resourceList: request.items.map((i) => i.resourceId).join(', '),
            endsAt: '',
            skippedNote: '',
            requestUrl: requestUrl(publicUrl, requestId),
          },
          requestId,
          userId: r.userId,
        })),
      );
    }

    // The fulfilment SLA. A request approved and not applied is not an error;
    // it becomes one when nobody has looked at it for a day.
    const slaCutoff = new Date(now.getTime() - settings.fulfilmentSlaHours * 3_600_000);
    const stale = await tx.accessRequest.findMany({
      where: {
        status: 'awaiting_fulfilment',
        dispatchedAt: { lt: slaCutoff },
      },
      include: { product: true, items: true },
    });
    for (const request of stale) {
      // Once per request, not once per tick. Deduped on the outbox itself,
      // which is also the row somebody reads when they ask whether they were
      // ever told.
      const alreadyWarned = await tx.notificationOutbox.count({
        where: { requestId: request.id, template: 'automate-awaiting-fulfilment-sla' },
      });
      if (alreadyWarned > 0) continue;

      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      if (managers.length === 0) continue;
      await enqueueOutbox(
        tx,
        managers.map((r) => ({
          template: 'automate-awaiting-fulfilment-sla' as const,
          to: r.email,
          vars: {
            displayName: r.displayName,
            productName: request.product?.name ?? 'the requested access',
            subjectName: request.subjectPersonId,
            targetName: request.items[0]?.targetSystemId ?? '',
            waitingHours: String(settings.fulfilmentSlaHours),
            requestUrl: requestUrl(publicUrl, request.id),
          },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      result.slaAlerts += 1;
    }

    // Only where no run is already in flight for that target. Provision
    // refuses a second concurrent run anyway, and an enqueue per tick would
    // fill the queue with jobs that immediately skip.
    const needsRun: string[] = [];
    for (const targetSystemId of targetsToRun) {
      const inFlight = await tx.provisionRun.count({
        where: { targetSystemId, status: { in: NON_TERMINAL_RUN_STATUSES } },
      });
      if (inFlight === 0) needsRun.push(targetSystemId);
    }
    result.redispatched = needsRun.length;

    return { result, targetsToRun: needsRun };
  });

  for (const targetSystemId of targetsToRun) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return result;
}
```

- [ ] **Step 4: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/decision-service.js';`:

```ts
export * from './automate/reflect.js';
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run packages/core/src/automate/reflect.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/automate/reflect.ts \
        packages/core/src/automate/reflect.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): reflect Provision outcomes back onto requests and grants"
```

---

## Task 13: The expiry and lapse sweep — classify, guard, apply

Spec §11 and §12. The one thing Automate does in bulk, so it gets the treatment everything in bulk gets here: it computes, writes down one row per proposed removal, and stops.

**The whole plan is written in ONE transaction**, so a sweep that fails partway writes no plan at all. There is no readable state in which a sweep is `previewed` with no actions, or holds actions while still `running`. That is Provision's phase 7 rule, and it is what makes a review screen trustworthy.

**Files:**
- Create: `packages/core/src/automate/sweep-guard.ts`
- Create: `packages/core/src/automate/sweep-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/sweep-guard.test.ts`, `packages/core/src/automate/sweep-service.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent`; `PERMISSIONS`; `type Scheduler`; `PROVISION_JOB`, `provisionJobPayload`; `addDays` from `../provision/plan.js`; `type ConditionFacts`; `audienceAdmits`, `type AudienceCondition`, `type SubjectSetFacts` from `./audience.js`; `automateSettings`, `subjectAudienceFacts` from `./catalog-service.js`; `revokeGrant` from `./fulfil.js`; `enqueueOutbox`, `recipientsForPersons`, `usersWithPermission` from `./notify.js`; `type SweepActionKind`, `IN_FORCE_GRANT_STATUSES`, `LIVE_GRANT_STATUSES` from `./types.js`.
- Produces (in `./sweep-guard.js`):
  - `interface SweepGuardThresholds { sweepThresholdPercent: number; perProductSweepThresholdPercent: number; personPopulationDropPercent: number }`
  - `interface SweepGuardInput { internalRemovals: number; internalGrantsInTenant: number; removalsByProduct: ReadonlyMap<string, number>; activeGrantsByProduct: ReadonlyMap<string, number>; productNameById: ReadonlyMap<string, string>; thresholds: SweepGuardThresholds; personsWithActiveContract: number; previousPersonsWithActiveContract: number | null; hasEverApplied: boolean }`
  - `type SweepGuardVerdict = { blocked: false } | { blocked: true; confirmable: boolean; reasons: string[] }`
  - `function evaluateSweepGuard(input: SweepGuardInput): SweepGuardVerdict`
- Produces (in `./sweep-service.js`):
  - `interface SweepGrantFacts { grantId: string; subjectPersonId: string; productId: string | null; resourceType: 'entitlement' | 'application' | 'group'; resourceId: string; targetSystemId: string | null; startsAt: Date; endsAt: Date | null; status: string; needsReview: boolean; supersededByGrantId: string | null }`
  - `interface ContractWindow { startDate: Date; endDate: Date | null }`
  - `interface SweepInput { grants: SweepGrantFacts[]; contractsByPerson: ReadonlyMap<string, ContractWindow[]>; audienceByProduct: ReadonlyMap<string, AudienceCondition | null>; factsByPerson: ReadonlyMap<string, { contracts: ConditionFacts[] } & SubjectSetFacts>; horizonDaysByGrant: ReadonlyMap<string, number>; now: Date }`
  - `interface ClassifiedAction { grantId: string; kind: SweepActionKind; subjectPersonId: string; productId: string | null; resourceType: string; resourceId: string; targetSystemId: string | null; message: string }`
  - `interface SweepClassification { actions: ClassifiedAction[]; reviewFlags: { grantId: string; reason: string }[]; exceptions: { personId: string; kind: 'no_contracts' | 'not_yet_started'; message: string }[] }`
  - `function classifySweep(input: SweepInput): SweepClassification`
  - `function latestContractEndFor(contracts: readonly ContractWindow[]): Date | null`
  - `async function previewExpirySweep(tenantId: string, options?: { now?: Date; publicUrl?: string }): Promise<{ id: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }>`
  - `async function applyExpirySweep(tenantId: string, sweepId: string, options?: { confirm?: boolean; confirmedByUserId?: string | null; only?: string[]; now?: Date; scheduler?: Scheduler | null; publicUrl?: string }): Promise<{ status: string; applied: number; skipped: number; failed: number }>`

- [ ] **Step 1: Write the failing guard test**

`packages/core/src/automate/sweep-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateSweepGuard, type SweepGuardInput } from './sweep-guard.js';

const thresholds = {
  sweepThresholdPercent: 10,
  perProductSweepThresholdPercent: 50,
  personPopulationDropPercent: 20,
};

const guard = (over: Partial<SweepGuardInput> = {}) =>
  evaluateSweepGuard({
    internalRemovals: 0,
    internalGrantsInTenant: 1000,
    removalsByProduct: new Map(),
    activeGrantsByProduct: new Map(),
    productNameById: new Map(),
    thresholds,
    personsWithActiveContract: 1000,
    previousPersonsWithActiveContract: 1000,
    hasEverApplied: true,
    ...over,
  });

describe('the tenant-wide axis', () => {
  it('passes just under the threshold, and trips exactly at it', () => {
    expect(guard({ internalRemovals: 99 })).toEqual({ blocked: false });
    const at = guard({ internalRemovals: 100 });
    expect(at).toMatchObject({ blocked: true, confirmable: true });
  });

  it('names the count and the share in the reason', () => {
    const verdict = guard({ internalRemovals: 250 });
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('250');
    expect(verdict.reasons[0]).toContain('25');
  });

  it('counts only internal removals; the target half is Provision guard', () => {
    // Provision's guard already covers grants, revocations, disables and
    // archives at the target, on two axes. Counting them here would guard the
    // same act twice and block on a number nobody can act on from this screen.
    expect(guard({ internalRemovals: 0, internalGrantsInTenant: 10 })).toEqual({
      blocked: false,
    });
  });
});

describe('the per-product axis', () => {
  it('trips when one product loses more than half its holders, even at tenant scale', () => {
    // Emptying one product of its 90 holders is 0.2% of a large tenant and
    // total for the 90.
    const verdict = guard({
      internalRemovals: 90,
      internalGrantsInTenant: 40_000,
      removalsByProduct: new Map([['p1', 90]]),
      activeGrantsByProduct: new Map([['p1', 90]]),
      productNameById: new Map([['p1', 'Finance folder']]),
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: true });
    if (!verdict.blocked) throw new Error('unreachable');
    // The product BY NAME. "50% of one product" with no name is a number
    // nobody can check.
    expect(verdict.reasons.join(' ')).toContain('Finance folder');
  });

  it('does not trip at exactly half', () => {
    expect(
      guard({
        internalRemovals: 5,
        removalsByProduct: new Map([['p1', 5]]),
        activeGrantsByProduct: new Map([['p1', 10]]),
        productNameById: new Map([['p1', 'Half']]),
      }),
    ).toEqual({ blocked: false });
  });

  it('skips a product with no active grants rather than dividing by zero', () => {
    expect(
      guard({
        internalRemovals: 1,
        removalsByProduct: new Map([['p1', 1]]),
        activeGrantsByProduct: new Map([['p1', 0]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('the two conditions that block outright', () => {
  it('refuses when the person population has collapsed, with no confirmation available', () => {
    // Every lapse action is downstream of that count, and a truncated HR
    // import is the accident most likely to produce a sweep that revokes
    // everything.
    const verdict = guard({
      personsWithActiveContract: 700,
      previousPersonsWithActiveContract: 1000,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: false });
  });

  it('does not refuse a drop inside the threshold', () => {
    expect(
      guard({ personsWithActiveContract: 850, previousPersonsWithActiveContract: 1000 }),
    ).toEqual({ blocked: false });
  });

  it('refuses a tenant with no persons at all, unconditionally', () => {
    const verdict = guard({
      personsWithActiveContract: 0,
      previousPersonsWithActiveContract: null,
      hasEverApplied: false,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: false });
  });

  it('makes the first sweep in a tenant confirmable regardless of size', () => {
    // Every denominator is zero and no percentage can say anything about it.
    // This is the hole Provision found in Directory Sync's guard, closed here
    // at the start.
    const verdict = guard({
      internalRemovals: 1,
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: true });
  });

  it('does not confuse a first sweep with a collapsed population', () => {
    const verdict = guard({
      internalRemovals: 1,
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
      personsWithActiveContract: 1000,
    });
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.confirmable).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('first');
  });
});
```

- [ ] **Step 2: Write the guard**

`packages/core/src/automate/sweep-guard.ts`:

```ts
export interface SweepGuardThresholds {
  sweepThresholdPercent: number;
  perProductSweepThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface SweepGuardInput {
  /**
   * `application` and `localGroup` removals only. The target half is
   * Provision's guard, thoroughly and on two axes; counting it here would
   * guard the same act twice and block on a number nobody can act on from
   * this screen.
   */
  internalRemovals: number;
  internalGrantsInTenant: number;
  removalsByProduct: ReadonlyMap<string, number>;
  activeGrantsByProduct: ReadonlyMap<string, number>;
  productNameById: ReadonlyMap<string, string>;
  thresholds: SweepGuardThresholds;
  personsWithActiveContract: number;
  /** From the last APPLIED sweep. Null when there has never been one. */
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type SweepGuardVerdict =
  | { blocked: false }
  | { blocked: true; confirmable: boolean; reasons: string[] };

/**
 * Whether a sweep may apply itself.
 *
 * Two axes that make a sweep CONFIRMABLE, and two conditions that block it
 * outright with no confirmation available. The distinction matters: a
 * confirmable sweep is one a human can look at and accept; a blocked one is
 * one whose own inputs are not trustworthy, and confirming it would be
 * confirming a number rather than a decision.
 */
export function evaluateSweepGuard(input: SweepGuardInput): SweepGuardVerdict {
  const hard: string[] = [];
  const soft: string[] = [];

  // A tenant with no persons at all is refused unconditionally. There is
  // nothing a human could usefully confirm about a sweep whose entire
  // population went missing.
  if (input.personsWithActiveContract === 0) {
    hard.push(
      'no person in this tenant holds an active contract; refusing to sweep anything',
    );
  } else if (input.previousPersonsWithActiveContract !== null) {
    const drop =
      ((input.previousPersonsWithActiveContract - input.personsWithActiveContract) /
        input.previousPersonsWithActiveContract) *
      100;
    if (drop > input.thresholds.personPopulationDropPercent) {
      hard.push(
        `the number of people with an active contract has fallen from ${input.previousPersonsWithActiveContract} to ${input.personsWithActiveContract} (${drop.toFixed(1)}%) since the last applied sweep; every lapse in this sweep is downstream of that count`,
      );
    }
  }

  if (hard.length > 0) return { blocked: true, confirmable: false, reasons: hard };

  // The first sweep in a tenant. Every denominator is zero and no percentage
  // can say anything about it, so a human looks at it once.
  if (!input.hasEverApplied && input.internalRemovals > 0) {
    soft.push(
      `this is the first sweep applied in this tenant, so there is no previous state to compare ${input.internalRemovals} removals against`,
    );
  }

  if (input.internalGrantsInTenant > 0) {
    const share = (input.internalRemovals / input.internalGrantsInTenant) * 100;
    if (share >= input.thresholds.sweepThresholdPercent) {
      soft.push(
        `${input.internalRemovals} of ${input.internalGrantsInTenant} application and group grants would be removed (${share.toFixed(1)}%, threshold ${input.thresholds.sweepThresholdPercent}%)`,
      );
    }
  }

  for (const [productId, removals] of input.removalsByProduct) {
    const holders = input.activeGrantsByProduct.get(productId) ?? 0;
    if (holders === 0) continue;
    const share = (removals / holders) * 100;
    if (share > input.thresholds.perProductSweepThresholdPercent) {
      const name = input.productNameById.get(productId) ?? productId;
      soft.push(
        `${name} would lose ${removals} of its ${holders} holders (${share.toFixed(1)}%, threshold ${input.thresholds.perProductSweepThresholdPercent}%)`,
      );
    }
  }

  return soft.length === 0
    ? { blocked: false }
    : { blocked: true, confirmable: true, reasons: soft };
}
```

- [ ] **Step 3: Run the guard test**

Run: `pnpm vitest run packages/core/src/automate/sweep-guard.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing sweep test**

`packages/core/src/automate/sweep-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { applyExpirySweep, classifySweep, previewExpirySweep } from './sweep-service.js';
import type { ConditionFacts } from '../provision/condition.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': null,
  'contract.costCentre': null,
  'contract.employer': null,
  'contract.location': null,
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

const grant = (over: Record<string, unknown> = {}) => ({
  grantId: 'g1',
  subjectPersonId: 'p1',
  productId: 'prod1',
  resourceType: 'application' as const,
  resourceId: 'app1',
  targetSystemId: null,
  startsAt: day('2026-01-01'),
  endsAt: null,
  status: 'active',
  needsReview: false,
  supersededByGrantId: null,
  ...over,
});

const classify = (over: Record<string, unknown> = {}) =>
  classifySweep({
    grants: [grant()],
    contractsByPerson: new Map([['p1', [{ startDate: day('2020-01-01'), endDate: null }]]]),
    audienceByProduct: new Map([['prod1', { all: [] }]]),
    factsByPerson: new Map([
      ['p1', { contracts: [facts()], groupIds: [], orgUnitChainIds: [], entitlementIds: [] }],
    ]),
    horizonDaysByGrant: new Map([['g1', 14]]),
    now: NOW,
    ...over,
  } as never);

describe('classifySweep — expiry', () => {
  it('expires a grant whose end date has passed and leaves one that has not', () => {
    expect(
      classify({ grants: [grant({ endsAt: day('2026-06-14') })] }).actions.map((a) => a.kind),
    ).toEqual(['expire']);
    expect(classify({ grants: [grant({ endsAt: day('2026-06-16') })] }).actions).toEqual([]);
  });

  it('expires exactly on the end date, not the day after', () => {
    // `endsAt` is the moment access stops. Off by one here leaves everybody
    // holding their access for one extra day, every time.
    expect(classify({ grants: [grant({ endsAt: NOW })] }).actions).toHaveLength(1);
  });

  it('does not expire a grant an approved extension already replaced', () => {
    // The case worth testing: a naive implementation expires the old grant,
    // revokes at the target, and re-grants an hour later -- producing an
    // outage and two audit events that say the opposite of what happened.
    expect(
      classify({
        grants: [grant({ endsAt: day('2026-06-14'), supersededByGrantId: 'g2' })],
      }).actions,
    ).toEqual([]);
  });

  it('does not act on a grant that is already out of force', () => {
    expect(classify({ grants: [grant({ status: 'revoked' })] }).actions).toEqual([]);
  });
});

describe('classifySweep — the three meanings of "no active contract"', () => {
  it('lapses a leaver, on the LATEST end date across all their contracts', () => {
    // A person whose second engagement ran three months longer left three
    // months later.
    const result = classify({
      contractsByPerson: new Map([
        [
          'p1',
          [
            { startDate: day('2020-01-01'), endDate: day('2026-03-01') },
            { startDate: day('2021-01-01'), endDate: day('2026-06-01') },
          ],
        ],
      ]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
    expect(result.actions[0]?.message).toContain('2026-06-01');
  });

  it('does not lapse a future joiner, and reports them', () => {
    // An account belonging to somebody whose contract has not started is a
    // question, not an instruction.
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2026-09-01'), endDate: null }]],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([
      expect.objectContaining({ personId: 'p1', kind: 'not_yet_started' }),
    ]);
  });

  it('treats a joiner inside the pre-hire horizon as present, not as an exception', () => {
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2026-06-20'), endDate: null }]],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('does NOT lapse a person with no contracts at all, and names them', () => {
    // THE assertion that fails loudly if anybody ever collapses the two. An
    // incomplete record is not a departure: a person the system cannot
    // understand must produce no actions, never empty desired state.
    const result = classify({ contractsByPerson: new Map([['p1', []]]) });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([
      expect.objectContaining({ personId: 'p1', kind: 'no_contracts' }),
    ]);
  });

  it('lapses on the day, with no grace, whatever a target disable grace says', () => {
    // Requested access is access beyond the job. When the job ends it goes
    // first, and it goes on the day.
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2020-01-01'), endDate: day('2026-06-14') }]],
      ]),
      horizonDaysByGrant: new Map([['g1', 30]]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
  });

  it('prefers lapse over expire when both would apply', () => {
    const result = classify({
      grants: [grant({ endsAt: day('2026-06-10') })],
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2020-01-01'), endDate: day('2026-06-01') }]],
      ]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
  });
});

describe('classifySweep — the review flag', () => {
  it('flags a mover whose audience no longer admits them, and proposes nothing', () => {
    // Somebody asked and somebody accountable allowed it. Revoking that
    // silently on an HR field change is not Automate's call. Not saying
    // anything is not an option either.
    const result = classify({
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.reviewFlags).toEqual([
      expect.objectContaining({ grantId: 'g1' }),
    ]);
    expect(result.reviewFlags[0]?.reason).toContain('audience');
  });

  it('flags once, not on every sweep', () => {
    const result = classify({
      grants: [grant({ needsReview: true })],
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.reviewFlags).toEqual([]);
  });

  it('does not flag a grant it is already removing', () => {
    const result = classify({
      grants: [grant({ endsAt: day('2026-06-01') })],
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.reviewFlags).toEqual([]);
  });
});
```

- [ ] **Step 5: Write the failing sweep integration test**

Append to `packages/core/src/automate/sweep-service.test.ts`:

```ts
describe('previewExpirySweep and applyExpirySweep', () => {
  let tenantId: string;
  let personId: string;
  let userId: string;
  let applicationId: string;
  let productId: string;
  let targetSystemId: string;
  let entitlementId: string;

  const schedulerStub = () => ({
    schedule: vi.fn(async () => undefined),
    unschedule: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => 'job-1'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  });

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;

    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
          department: 'Finance',
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          personId: person.id,
        },
      });
      const application = await tx.application.create({
        data: { tenantId, name: 'Stats', slug: 'stats' },
      });
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId, name: 'Immediate' },
      });
      const product = await tx.product.create({
        data: {
          tenantId,
          name: 'Statistics licence',
          slug: 'stats',
          kind: 'application',
          workflowId: workflow.id,
          status: 'active',
          audienceCondition: { all: [] },
        },
      });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-stats',
          type: 'group',
          displayName: 'Stats',
        },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: application.id, subjectType: 'user', userId: user.id },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: application.id,
          productId: product.id,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-01'),
          status: 'active',
        },
      });
      return {
        personId: person.id,
        userId: user.id,
        applicationId: application.id,
        productId: product.id,
        targetSystemId: target.id,
        entitlementId: entitlement.id,
      };
    });
    ({ personId, userId, applicationId, productId, targetSystemId, entitlementId } = seeded);
  });

  it('writes the whole plan in one transaction and stops', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    // The first sweep in a tenant always requires confirmation, whatever its
    // size: every denominator is zero.
    expect(sweep.requiresConfirmation).toBe(true);
    const state = await withTenant(tenantId, async (tx) => ({
      sweep: await tx.expirySweep.findUniqueOrThrow({ where: { id: sweep.id } }),
      actions: await tx.sweepAction.findMany(),
      assignments: await tx.appAssignment.findMany(),
    }));
    expect(state.sweep.status).toBe('previewed');
    expect(state.actions.map((a) => a.kind)).toEqual(['expire']);
    // Nothing applied. It computes, writes down one row per proposed removal,
    // and stops.
    expect(state.assignments).toHaveLength(1);
  });

  it('refuses to apply a sweep that requires confirmation without one', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, { now: NOW });
    expect(result).toMatchObject({ applied: 0 });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('applies on an explicit confirmation and records the confirming user', async () => {
    // `confirm` is separate from `confirmedByUserId` so the gate cannot be
    // satisfied by accident: keying it on `confirmedByUserId === undefined`
    // means an internal caller passing null passes the gate.
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });
    expect(result).toMatchObject({ status: 'applied', applied: 1 });
    const state = await withTenant(tenantId, async (tx) => ({
      sweep: await tx.expirySweep.findUniqueOrThrow({ where: { id: sweep.id } }),
      assignments: await tx.appAssignment.findMany(),
      grant: await tx.accessGrant.findFirstOrThrow(),
      settings: await tx.automateSettings.findUniqueOrThrow({ where: { tenantId } }),
      outbox: await tx.notificationOutbox.findMany({ where: { template: 'automate-expired' } }),
    }));
    expect(state.sweep.confirmedByUserId).toBe(userId);
    expect(state.assignments).toEqual([]);
    expect(state.grant.status).toBe('expired');
    // Recorded so the NEXT sweep has a denominator that means something.
    expect(state.settings.lastAppliedSweepAt).not.toBeNull();
    expect(state.settings.personsWithActiveContractAtLastSweep).toBe(1);
    expect(state.outbox).toHaveLength(1);
  });

  it('honours a per-row skip', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
      only: [],
    });
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('hands a target entitlement removal to Provision rather than writing it', async () => {
    const scheduler = schedulerStub();
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: personId,
          resourceType: 'entitlement',
          resourceId: entitlementId,
          targetSystemId,
          productId,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-01'),
          status: 'active',
        },
      }),
    );
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
      scheduler,
    });

    const actions = await withTenant(tenantId, (tx) =>
      tx.sweepAction.findMany({ where: { resourceType: 'entitlement' } }),
    );
    // Dispatched, not applied: the grant left desired state and Provision
    // proposes and applies the revocation under its own guard.
    expect(actions[0]?.status).toBe('dispatched');
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('blocks outright, with no confirmation offered, when the population collapsed', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.automateSettings.create({
        data: {
          tenantId,
          lastAppliedSweepAt: day('2026-06-01'),
          personsWithActiveContractAtLastSweep: 100,
        },
      });
    });
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    expect(sweep.status).toBe('blocked');
    expect(sweep.requiresConfirmation).toBe(false);
    expect(sweep.blockedReason).toContain('fallen');

    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });
    // Confirmation is not available. A blocked sweep is one whose own inputs
    // are not trustworthy, and confirming it would be confirming a number.
    expect(result.applied).toBe(0);
  });

  it('writes a SweepException for a person with no contracts and lapses nothing of theirs', async () => {
    await withTenant(tenantId, async (tx) => {
      const ghost = await tx.person.create({
        data: { tenantId, givenName: 'Ghost', familyName: 'Test' },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: ghost.id,
          resourceType: 'application',
          resourceId: applicationId,
          productId,
          startsAt: day('2026-01-01'),
          status: 'active',
        },
      });
    });
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const state = await withTenant(tenantId, async (tx) => ({
      exceptions: await tx.sweepException.findMany({ where: { sweepId: sweep.id } }),
      actions: await tx.sweepAction.findMany({ where: { sweepId: sweep.id } }),
    }));
    expect(state.exceptions.map((e) => e.kind)).toEqual(['no_contracts']);
    // One action, for the expiring grant -- not two.
    expect(state.actions).toHaveLength(1);
  });

  it('tells the holders of automate.manage when a sweep needs confirming', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId } });
    });
    await previewExpirySweep(tenantId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-sweep-confirmation' } }),
    );
    expect(outbox).toHaveLength(1);
    // Never digested, whatever the recipient's preference says.
    expect(outbox[0]?.digest).toBe(false);
  });
});
```

- [ ] **Step 6: Run both sweep tests to verify they fail**

Run: `pnpm vitest run packages/core/src/automate/sweep-service.test.ts`
Expected: FAIL, "Failed to resolve import ./sweep-service.js".

- [ ] **Step 7: Write the sweep service**

`packages/core/src/automate/sweep-service.ts`:

```ts
import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { addDays } from '../provision/plan.js';
import type { ConditionFacts } from '../provision/condition.js';
import {
  audienceAdmits,
  type AudienceCondition,
  type SubjectSetFacts,
} from './audience.js';
import { automateSettings, subjectAudienceFacts } from './catalog-service.js';
import { enqueueOutbox, recipientsForPersons, usersWithPermission } from './notify.js';
import { evaluateSweepGuard } from './sweep-guard.js';
import { IN_FORCE_GRANT_STATUSES, type SweepActionKind } from './types.js';

export interface SweepGrantFacts {
  grantId: string;
  subjectPersonId: string;
  productId: string | null;
  resourceType: 'entitlement' | 'application' | 'group';
  resourceId: string;
  targetSystemId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  needsReview: boolean;
  supersededByGrantId: string | null;
}

export interface ContractWindow {
  startDate: Date;
  endDate: Date | null;
}

export interface SweepInput {
  grants: SweepGrantFacts[];
  contractsByPerson: ReadonlyMap<string, ContractWindow[]>;
  audienceByProduct: ReadonlyMap<string, AudienceCondition | null>;
  factsByPerson: ReadonlyMap<string, { contracts: ConditionFacts[] } & SubjectSetFacts>;
  /**
   * The pre-hire horizon that applies to each grant: the target system's
   * `preHireDays` for an entitlement grant, and the tenant's
   * `preHireHorizonDays` for an application or local group grant, which has no
   * target to inherit from.
   */
  horizonDaysByGrant: ReadonlyMap<string, number>;
  now: Date;
}

export interface ClassifiedAction {
  grantId: string;
  kind: SweepActionKind;
  subjectPersonId: string;
  productId: string | null;
  resourceType: string;
  resourceId: string;
  targetSystemId: string | null;
  message: string;
}

export interface SweepClassification {
  actions: ClassifiedAction[];
  reviewFlags: { grantId: string; reason: string }[];
  exceptions: { personId: string; kind: 'no_contracts' | 'not_yet_started'; message: string }[];
}

/** The LATEST end across all contracts, or null when any is open-ended. */
export function latestContractEndFor(contracts: readonly ContractWindow[]): Date | null {
  if (contracts.length === 0) return null;
  if (contracts.some((c) => c.endDate === null)) return null;
  return contracts.reduce<Date>(
    (latest, c) => (c.endDate! > latest ? c.endDate! : latest),
    contracts[0]!.endDate!,
  );
}

/**
 * Pure. Each grant becomes an `expire` action, a `lapse` action, or nothing.
 *
 * The review flag is deliberately NOT an action: it changes nothing about what
 * the person holds, so the guard does not count it and the review screen
 * cannot skip it.
 */
export function classifySweep(input: SweepInput): SweepClassification {
  const actions: ClassifiedAction[] = [];
  const reviewFlags: { grantId: string; reason: string }[] = [];
  const exceptions: SweepClassification['exceptions'] = [];
  const reported = new Set<string>();

  for (const grant of input.grants) {
    if (!(IN_FORCE_GRANT_STATUSES as readonly string[]).includes(grant.status)) continue;
    // An approved extension already replaced this one. Expiring it now would
    // revoke at the target and re-grant an hour later.
    if (grant.supersededByGrantId !== null) continue;

    const contracts = input.contractsByPerson.get(grant.subjectPersonId) ?? [];
    const horizonDays = input.horizonDaysByGrant.get(grant.grantId) ?? 0;
    const horizon = addDays(input.now, horizonDays);

    // Three meanings of "no active contract", and they are Provision's, used
    // rather than reinvented.
    if (contracts.length === 0) {
      // An incomplete record, not a departure. NOTHING lapses.
      if (!reported.has(grant.subjectPersonId)) {
        reported.add(grant.subjectPersonId);
        exceptions.push({
          personId: grant.subjectPersonId,
          kind: 'no_contracts',
          message:
            'this person holds no contract at all, so there is no departure date to lapse their requested access from',
        });
      }
      continue;
    }

    const inForce = contracts.some(
      (c) => c.startDate <= input.now && (c.endDate === null || input.now <= c.endDate),
    );
    const startingSoon = contracts.some(
      (c) => c.startDate > input.now && c.startDate <= horizon,
    );

    if (!inForce && !startingSoon) {
      const allInFuture = contracts.every((c) => c.startDate > input.now);
      if (allInFuture) {
        // A future joiner. Grants already held are left alone and reported: a
        // grant held by somebody who has not started is a question.
        if (!reported.has(grant.subjectPersonId)) {
          reported.add(grant.subjectPersonId);
          exceptions.push({
            personId: grant.subjectPersonId,
            kind: 'not_yet_started',
            message:
              'every contract this person holds starts beyond the pre-hire horizon, so nothing of theirs lapses',
          });
        }
        continue;
      }

      // A leaver. On the LATEST end date across all their contracts, with no
      // grace: requested access is access beyond what the job required.
      const end = latestContractEndFor(contracts);
      actions.push({
        grantId: grant.grantId,
        kind: 'lapse',
        subjectPersonId: grant.subjectPersonId,
        productId: grant.productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
        message: `every contract ended by ${end?.toISOString().slice(0, 10) ?? 'an unknown date'}`,
      });
      continue;
    }

    if (grant.endsAt !== null && input.now >= grant.endsAt) {
      actions.push({
        grantId: grant.grantId,
        kind: 'expire',
        subjectPersonId: grant.subjectPersonId,
        productId: grant.productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
        message: `the grant ended on ${grant.endsAt.toISOString().slice(0, 10)}`,
      });
      continue;
    }

    // A mover: the grant survives and is flagged, once.
    if (grant.needsReview || grant.productId === null) continue;
    const condition = input.audienceByProduct.get(grant.productId);
    if (condition === undefined) continue;
    const facts = input.factsByPerson.get(grant.subjectPersonId);
    if (facts === undefined) continue;
    if (!audienceAdmits(condition, facts.contracts, facts)) {
      reviewFlags.push({
        grantId: grant.grantId,
        reason:
          'the subject no longer satisfies the audience for the product this was granted from',
      });
    }
  }

  return { actions, reviewFlags, exceptions };
}

/**
 * Computes the plan and writes it down. Applies nothing.
 *
 * The whole plan is written in ONE transaction, so a sweep that fails partway
 * writes no plan at all. There is no readable state in which a sweep is
 * `previewed` with no actions, or holds actions while still `running` --
 * which is what makes the review screen trustworthy.
 */
export async function previewExpirySweep(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ id: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);

    const grants = await tx.accessGrant.findMany({
      where: { status: { in: [...IN_FORCE_GRANT_STATUSES] } },
    });
    const persons = await tx.person.findMany({ select: { id: true } });
    const contracts = await tx.contract.findMany({
      select: { personId: true, startDate: true, endDate: true },
    });
    const products = await tx.product.findMany({
      select: { id: true, name: true, audienceCondition: true },
    });
    const targets = await tx.targetSystem.findMany({
      select: { id: true, preHireDays: true },
    });

    const contractsByPerson = new Map<string, ContractWindow[]>();
    for (const person of persons) contractsByPerson.set(person.id, []);
    for (const contract of contracts) {
      const list = contractsByPerson.get(contract.personId) ?? [];
      list.push({ startDate: contract.startDate, endDate: contract.endDate });
      contractsByPerson.set(contract.personId, list);
    }

    const audienceByProduct = new Map<string, AudienceCondition | null>(
      products.map((p) => [p.id, p.audienceCondition as AudienceCondition | null]),
    );
    const productNameById = new Map(products.map((p) => [p.id, p.name]));
    const preHireByTarget = new Map(targets.map((t) => [t.id, t.preHireDays]));

    const subjectIds = [...new Set(grants.map((g) => g.subjectPersonId))];
    const factsByPerson = new Map<
      string,
      { contracts: ConditionFacts[] } & SubjectSetFacts
    >();
    for (const subjectId of subjectIds) {
      const facts = await subjectAudienceFacts(tx, subjectId, now);
      factsByPerson.set(subjectId, facts);
    }

    const horizonDaysByGrant = new Map(
      grants.map((g) => [
        g.id,
        // Two horizons rather than one. A domain that needs an account three
        // weeks early does not imply a portal tile three weeks early.
        g.targetSystemId === null
          ? settings.preHireHorizonDays
          : (preHireByTarget.get(g.targetSystemId) ?? settings.preHireHorizonDays),
      ]),
    );

    const classification = classifySweep({
      grants: grants.map((g) => ({
        grantId: g.id,
        subjectPersonId: g.subjectPersonId,
        productId: g.productId,
        resourceType: g.resourceType as 'entitlement' | 'application' | 'group',
        resourceId: g.resourceId,
        targetSystemId: g.targetSystemId,
        startsAt: g.startsAt,
        endsAt: g.endsAt,
        status: g.status,
        needsReview: g.needsReview,
        supersededByGrantId: g.supersededByGrantId,
      })),
      contractsByPerson,
      audienceByProduct,
      factsByPerson,
      horizonDaysByGrant,
      now,
    });

    const personsWithActiveContract = [...contractsByPerson.values()].filter((windows) =>
      windows.some((c) => c.startDate <= now && (c.endDate === null || now <= c.endDate)),
    ).length;

    const internal = classification.actions.filter((a) => a.resourceType !== 'entitlement');
    const internalGrantsInTenant = grants.filter(
      (g) => g.resourceType !== 'entitlement',
    ).length;
    const removalsByProduct = new Map<string, number>();
    for (const action of classification.actions) {
      if (action.productId === null) continue;
      removalsByProduct.set(
        action.productId,
        (removalsByProduct.get(action.productId) ?? 0) + 1,
      );
    }
    const activeGrantsByProduct = new Map<string, number>();
    for (const grant of grants) {
      if (grant.productId === null) continue;
      activeGrantsByProduct.set(
        grant.productId,
        (activeGrantsByProduct.get(grant.productId) ?? 0) + 1,
      );
    }

    const verdict = evaluateSweepGuard({
      internalRemovals: internal.length,
      internalGrantsInTenant,
      removalsByProduct,
      activeGrantsByProduct,
      productNameById,
      thresholds: {
        sweepThresholdPercent: settings.sweepThresholdPercent,
        perProductSweepThresholdPercent: settings.perProductSweepThresholdPercent,
        personPopulationDropPercent: settings.personPopulationDropPercent,
      },
      personsWithActiveContract,
      previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastSweep,
      hasEverApplied: settings.lastAppliedSweepAt !== null,
    });

    const sweep = await tx.expirySweep.create({
      data: {
        tenantId,
        status: verdict.blocked && !verdict.confirmable ? 'blocked' : 'previewed',
        startedAt: now,
        finishedAt: now,
        expireCount: classification.actions.filter((a) => a.kind === 'expire').length,
        lapseCount: classification.actions.filter((a) => a.kind === 'lapse').length,
        reviewFlagCount: classification.reviewFlags.length,
        personsWithActiveContract,
        personsUnprocessable: classification.exceptions.length,
        internalGrantsInTenant,
        requiresConfirmation: verdict.blocked && verdict.confirmable,
        blockedReason: verdict.blocked ? verdict.reasons.join('; ') : null,
      },
    });

    if (classification.actions.length > 0) {
      await tx.sweepAction.createMany({
        data: classification.actions.map((action) => ({
          tenantId,
          sweepId: sweep.id,
          grantId: action.grantId,
          kind: action.kind,
          productId: action.productId,
          subjectPersonId: action.subjectPersonId,
          resourceType: action.resourceType,
          resourceId: action.resourceId,
          targetSystemId: action.targetSystemId,
          message: action.message,
        })),
      });
    }
    if (classification.exceptions.length > 0) {
      await tx.sweepException.createMany({
        data: classification.exceptions.map((exception) => ({
          tenantId,
          sweepId: sweep.id,
          personId: exception.personId,
          kind: exception.kind,
          message: exception.message,
        })),
      });
    }

    // The flag is applied at PREVIEW, not at apply: it removes nothing, so
    // there is nothing to confirm and nothing to skip.
    for (const flag of classification.reviewFlags) {
      await tx.accessGrant.update({
        where: { id: flag.grantId },
        data: { needsReview: true, reviewReason: flag.reason, reviewedAt: now },
      });
      const grant = await tx.accessGrant.findUniqueOrThrow({ where: { id: flag.grantId } });
      const recipients = await recipientsForPersons(tx, [
        grant.subjectPersonId,
        ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
      ]);
      await enqueueOutbox(
        tx,
        recipients.map((r) => ({
          template: 'automate-review-flagged' as const,
          to: r.email,
          vars: {
            displayName: r.displayName,
            subjectName: grant.subjectPersonId,
            productName: productNameById.get(grant.productId ?? '') ?? 'requested access',
            grantedAt: grant.createdAt.toDateString(),
            reviewReason: flag.reason,
            grantUrl: `${(options.publicUrl ?? '').replace(/\/$/, '')}/access`,
          },
          requestId: null,
          userId: r.userId,
        })),
      );
    }

    await recordEvent(tx, {
      actorUserId: null,
      action: 'automate.sweep.preview',
      targetType: 'ExpirySweep',
      targetId: sweep.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        expire: sweep.expireCount,
        lapse: sweep.lapseCount,
        reviewFlags: sweep.reviewFlagCount,
        exceptions: sweep.personsUnprocessable,
        requiresConfirmation: sweep.requiresConfirmation,
        blockedReason: sweep.blockedReason,
      },
    });

    if (verdict.blocked) {
      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      await enqueueOutbox(
        tx,
        managers.map((r) => ({
          template: 'automate-sweep-confirmation' as const,
          to: r.email,
          vars: {
            displayName: r.displayName,
            actionCount: String(classification.actions.length),
            blockedReason: verdict.reasons.join('; '),
            sweepUrl: `${(options.publicUrl ?? '').replace(/\/$/, '')}/admin/automate/sweeps/${sweep.id}`,
          },
          requestId: null,
          userId: r.userId,
        })),
      );
    }

    return {
      id: sweep.id,
      status: sweep.status,
      requiresConfirmation: sweep.requiresConfirmation,
      blockedReason: sweep.blockedReason,
    };
  });
}

/**
 * Applies a previewed sweep.
 *
 * `confirm` is a separate flag from `confirmedByUserId` so the gate cannot be
 * satisfied by accident: keying it on `confirmedByUserId === undefined` means
 * `confirmedByUserId: null` -- what an internal caller writes when it has no
 * user -- passes the gate and records "confirmed by nobody". The scheduler
 * never confirms anything.
 */
export async function applyExpirySweep(
  tenantId: string,
  sweepId: string,
  options: {
    confirm?: boolean;
    confirmedByUserId?: string | null;
    only?: string[];
    now?: Date;
    scheduler?: Scheduler | null;
    publicUrl?: string;
  } = {},
): Promise<{ status: string; applied: number; skipped: number; failed: number }> {
  const now = options.now ?? new Date();
  const confirmed = options.confirm === true;

  const { outcome, targets } = await withTenant(tenantId, async (tx) => {
    const sweep = await tx.expirySweep.findUniqueOrThrow({ where: { id: sweepId } });

    if (sweep.status === 'blocked') {
      // No confirmation available. A blocked sweep is one whose own inputs are
      // not trustworthy, and confirming it would be confirming a number
      // rather than a decision.
      return {
        outcome: { status: sweep.status, applied: 0, skipped: 0, failed: 0 },
        targets: [] as string[],
      };
    }
    if (sweep.requiresConfirmation && !confirmed) {
      return {
        outcome: { status: sweep.status, applied: 0, skipped: 0, failed: 0 },
        targets: [] as string[],
      };
    }
    if (sweep.status !== 'previewed') {
      return {
        outcome: { status: sweep.status, applied: 0, skipped: 0, failed: 0 },
        targets: [] as string[],
      };
    }

    await tx.expirySweep.update({
      where: { id: sweepId },
      data: {
        status: 'applying',
        ...(confirmed ? { confirmedByUserId: options.confirmedByUserId ?? null } : {}),
      },
    });

    const actions = await tx.sweepAction.findMany({
      where: { sweepId, status: 'proposed' },
    });
    const chosen =
      options.only === undefined ? actions : actions.filter((a) => options.only!.includes(a.id));
    const skippedActions = actions.filter((a) => !chosen.includes(a));

    for (const action of skippedActions) {
      await tx.sweepAction.update({
        where: { id: action.id },
        data: { status: 'skipped', message: 'skipped by the reviewer' },
      });
    }

    const targets = new Set<string>();
    let applied = 0;
    let failed = 0;

    for (const action of chosen) {
      const grant = await tx.accessGrant.findUnique({ where: { id: action.grantId } });
      if (grant === null) {
        await tx.sweepAction.update({
          where: { id: action.id },
          data: { status: 'failed', message: 'the grant no longer exists' },
        });
        failed += 1;
        continue;
      }

      await tx.accessGrant.update({
        where: { id: grant.id },
        data: {
          status: action.kind === 'expire' ? 'expired' : 'lapsed',
          statusReason: action.message,
          endedAt: now,
        },
      });

      if (action.resourceType === 'entitlement') {
        // The grant leaves desired state. Provision plans and applies the
        // revocation under its own guard, its own per-entitlement axis and
        // its own review -- Automate writes nothing to a target.
        if (action.targetSystemId !== null) targets.add(action.targetSystemId);
        await tx.sweepAction.update({
          where: { id: action.id },
          data: { status: 'dispatched' },
        });
      } else {
        const users = await tx.user.findMany({
          where: { personId: grant.subjectPersonId },
          select: { id: true },
        });
        for (const user of users) {
          if (action.resourceType === 'application') {
            await tx.appAssignment.deleteMany({
              where: { applicationId: action.resourceId, userId: user.id },
            });
          } else {
            await tx.groupMembership.deleteMany({
              where: { groupId: action.resourceId, userId: user.id },
            });
          }
        }
        await tx.sweepAction.update({ where: { id: action.id }, data: { status: 'applied' } });
      }

      await recordEvent(tx, {
        actorUserId: options.confirmedByUserId ?? null,
        action: action.kind === 'expire' ? 'automate.grant.expire' : 'automate.grant.lapse',
        targetType: 'AccessGrant',
        targetId: grant.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          sweepId,
          subjectPersonId: grant.subjectPersonId,
          resourceType: action.resourceType,
          resourceId: action.resourceId,
          reason: action.message,
        },
      });

      const recipients = await recipientsForPersons(tx, [
        grant.subjectPersonId,
        ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
      ]);
      // Where a business rule still grants the same entitlement, the holder is
      // told they still hold it. Telling somebody they lost something they did
      // not lose is its own kind of defect.
      const stillHeld = await tx.accountEntitlement.count({
        where: {
          state: 'held',
          entitlementId: action.resourceId,
          origin: 'rule',
          account: { personId: grant.subjectPersonId },
        },
      });
      await enqueueOutbox(
        tx,
        recipients.map((r) => ({
          template:
            action.kind === 'expire'
              ? ('automate-expired' as const)
              : ('automate-lapsed' as const),
          to: r.email,
          vars: {
            displayName: r.displayName,
            subjectName: grant.subjectPersonId,
            productName: action.productId ?? 'requested access',
            resourceList: action.resourceId,
            endsAt: grant.endsAt?.toDateString() ?? '',
            lastContractEnd: action.message,
            stillHeldNote:
              stillHeld > 0
                ? 'You still hold this through your role, so nothing has changed for you in practice.'
                : '',
            catalogUrl: `${(options.publicUrl ?? '').replace(/\/$/, '')}/catalog`,
          },
          requestId: null,
          userId: r.userId,
        })),
      );

      applied += 1;
    }

    const status =
      failed > 0 && applied > 0 ? 'partially_applied' : failed > 0 ? 'failed' : 'applied';
    await tx.expirySweep.update({
      where: { id: sweepId },
      data: { status, finishedAt: now },
    });

    if (status !== 'failed') {
      // The denominator the NEXT sweep compares against: the last state
      // somebody accepted, not the last state observed.
      await tx.automateSettings.update({
        where: { tenantId },
        data: {
          lastAppliedSweepAt: now,
          personsWithActiveContractAtLastSweep: sweep.personsWithActiveContract,
        },
      });
    }

    await recordEvent(tx, {
      actorUserId: options.confirmedByUserId ?? null,
      action: 'automate.sweep.apply',
      targetType: 'ExpirySweep',
      targetId: sweepId,
      outcome: failed > 0 ? 'failure' : 'success',
      sourceIp: null,
      payload: { applied, skipped: skippedActions.length, failed, confirmed },
    });

    return {
      outcome: { status, applied, skipped: skippedActions.length, failed },
      targets: [...targets],
    };
  });

  for (const targetSystemId of targets) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return outcome;
}
```

- [ ] **Step 8: Export both modules**

In `packages/core/src/index.ts`, after `export * from './automate/reflect.js';`:

```ts
export * from './automate/sweep-guard.js';
export * from './automate/sweep-service.js';
```

- [ ] **Step 9: Run both tests**

Run: `pnpm vitest run packages/core/src/automate/sweep-guard.test.ts packages/core/src/automate/sweep-service.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/automate/sweep-guard.ts \
        packages/core/src/automate/sweep-service.ts \
        packages/core/src/automate/sweep-guard.test.ts \
        packages/core/src/automate/sweep-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): the guarded expiry and lapse sweep"
```

---

## Task 14: Delegated administration

Spec §8's approval delegation and §14's resource delegation. **Every delegated act is an `AccessRequest`** — `productId` null, `origin` `delegated_admin`, no approval stages — so it fulfils down the same three paths, produces the same `AccessGrant`, writes the same audit events, and answers the same "why does this person hold this?" query.

**Files:**
- Create: `packages/core/src/automate/delegation-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/automate/delegation-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `recordEvent`; `listMembers`; `type Scheduler`; `automateSettings`, `subjectAudienceFacts` from `./catalog-service.js`; `audienceAdmits`, `type AudienceCondition` from `./audience.js`; `fulfilRequest`, `type FulfilOptions` from `./fulfil.js`; `revokeGrant` from `./fulfil.js`; `enqueueOutbox`, `recipientsForPersons` from `./notify.js`; `LIVE_GRANT_STATUSES`, `type ResourceType` from `./types.js`.
- Produces:
  - `class DelegationRefusedError extends Error { constructor(readonly code: string, message: string) }`
  - `type ResourceCapability = 'view_members' | 'approve' | 'grant' | 'revoke'`
  - `const RESOURCE_CAPABILITIES: readonly ResourceCapability[]`
  - `async function createApprovalDelegation(tenantId: string, actorUserId: string | null, input: { delegatorPersonId: string; delegatePersonId: string; category: string | null; startsAt: Date; endsAt: Date }, options?: { now?: Date; publicUrl?: string }): Promise<{ id: string }>`
  - `async function endApprovalDelegation(tenantId: string, actorUserId: string | null, delegationId: string, options?: { now?: Date; publicUrl?: string }): Promise<void>`
  - `async function upsertResourceDelegation(tenantId: string, actorUserId: string | null, input: { id?: string; resourceType: ResourceType; resourceId: string; delegatePersonId: string | null; delegateGroupId: string | null; capabilities: ResourceCapability[]; audienceCondition: AudienceCondition | null; startsAt: Date; endsAt: Date | null }): Promise<{ id: string }>`
  - `interface ManagedResource { delegationId: string; resourceType: ResourceType; resourceId: string; capabilities: ResourceCapability[]; endsAt: Date | null }`
  - `async function resourcesManagedBy(tx: TenantClient, personId: string, now: Date): Promise<ManagedResource[]>`
  - `async function delegatedGrant(tenantId: string, input: { actingPersonId: string; actingUserId: string; resourceType: ResourceType; resourceId: string; subjectPersonIds: string[]; justification: string; durationDays: number | null }, options?: FulfilOptions): Promise<{ requestIds: string[] }>`
  - `async function delegatedRevoke(tenantId: string, input: { actingPersonId: string; actingUserId: string; resourceType: ResourceType; resourceId: string; subjectPersonIds: string[] }, options?: FulfilOptions): Promise<{ revoked: number }>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/delegation-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  DelegationRefusedError,
  createApprovalDelegation,
  delegatedGrant,
  delegatedRevoke,
  resourcesManagedBy,
  upsertResourceDelegation,
} from './delegation-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let leadPersonId: string;
let leadUserId: string;
let annaPersonId: string;
let boPersonId: string;
let groupId: string;

async function person(name: string, department = 'Finance') {
  return withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: p.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department,
      },
    });
    const u = await tx.user.create({
      data: {
        tenantId,
        login: name.toLowerCase(),
        email: `${name.toLowerCase()}@acme.test`,
        displayName: name,
        personId: p.id,
      },
    });
    return { personId: p.id, userId: u.id };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  ({ personId: leadPersonId, userId: leadUserId } = await person('Lead'));
  ({ personId: annaPersonId } = await person('Anna'));
  ({ personId: boPersonId } = await person('Bo', 'Facilities'));
  groupId = await withTenant(tenantId, async (tx) =>
    (await tx.group.create({ data: { tenantId, name: 'Finance Reporting' } })).id,
  );
});

const delegateGroup = (over: Record<string, unknown> = {}) =>
  upsertResourceDelegation(tenantId, null, {
    resourceType: 'group',
    resourceId: groupId,
    delegatePersonId: leadPersonId,
    delegateGroupId: null,
    capabilities: ['view_members', 'grant', 'revoke'],
    audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    startsAt: day('2026-01-01'),
    endsAt: null,
    ...over,
  });

describe('approval delegation', () => {
  it('records one and tells both parties', async () => {
    await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-delegation-started' } }),
    );
    expect(outbox.map((o) => o.to).sort()).toEqual(['anna@acme.test', 'lead@acme.test']);
  });

  it('refuses a delegation longer than maxDelegationDays', async () => {
    // An indefinite delegation is a permanent transfer of authority that
    // nobody ever re-decides.
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2027-06-16'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('too-long');
    expect((failure as Error).message).toContain('90');
  });

  it('refuses a chain: the delegate already delegates onwards', async () => {
    // Depth 1, enforced when the delegation is created. Resolution expands
    // exactly one level regardless, so this is the second half of the same
    // rule rather than the only half.
    await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: annaPersonId,
        delegatePersonId: boPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('not-transitive');
  });

  it('refuses a delegation to oneself', async () => {
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: leadPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('self');
  });
});

describe('resourcesManagedBy', () => {
  it('lists a resource delegated to the person directly', async () => {
    await delegateGroup();
    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toEqual([
      expect.objectContaining({ resourceType: 'group', resourceId: groupId }),
    ]);
  });

  it('lists a resource delegated to a group the person belongs to', async () => {
    const teamGroupId = await withTenant(tenantId, async (tx) => {
      const team = await tx.group.create({ data: { tenantId, name: 'Team leads' } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: team.id, userId: leadUserId },
      });
      return team.id;
    });
    await delegateGroup({ delegatePersonId: null, delegateGroupId: teamGroupId });
    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toHaveLength(1);
  });

  it('does not list a delegation that has ended', async () => {
    await delegateGroup({ endsAt: day('2026-06-01') });
    expect(await withTenant(tenantId, (tx) => resourcesManagedBy(tx, leadPersonId, NOW))).toEqual(
      [],
    );
  });
});

describe('delegatedGrant', () => {
  it('creates an AccessRequest with no stages and fulfils it down the ordinary path', async () => {
    // The alternative -- a direct membership write -- is faster and forks the
    // audit trail and the fulfilment path in two.
    await delegateGroup();
    const { requestIds } = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'joined the reporting team',
        durationDays: null,
      },
      { now: NOW },
    );
    expect(requestIds).toHaveLength(1);

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestIds[0]! } }),
      steps: await tx.approvalStep.findMany(),
      grants: await tx.accessGrant.findMany(),
      memberships: await tx.groupMembership.findMany({ where: { groupId } }),
    }));
    expect(state.request).toMatchObject({ productId: null, origin: 'delegated_admin' });
    expect(state.steps).toEqual([]);
    expect(state.grants[0]).toMatchObject({ origin: 'delegated_admin', status: 'active' });
    expect(state.memberships).toHaveLength(1);
  });

  it('refuses to grant to somebody the resource audience does not admit', async () => {
    // Without this, delegation is a hole underneath the catalog: give a team
    // lead a group and they can put anybody in the organization into it.
    await delegateGroup();
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [boPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('outside-audience');
  });

  it('refuses more subjects than delegatedBulkLimit', async () => {
    // Bounded by construction. The blast radius of a capability handed out to
    // dozens of team leads should be small enough that no guard is needed.
    await delegateGroup();
    const many = Array.from({ length: 26 }, () => annaPersonId);
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: many,
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('too-many');
    expect((failure as Error).message).toContain('administrator');
  });

  it('refuses somebody with no grant capability', async () => {
    await delegateGroup({ capabilities: ['view_members'] });
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('not-permitted');
  });

  it('refuses a group a directory source owns', async () => {
    const syncedGroupId = await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId, name: 'Corporate LDAP', type: 'ldap', config: {}, secretName: 's/l' },
      });
      const group = await tx.group.create({
        data: { tenantId, name: 'Domain Users', sourceId: source.id, sourceAnchor: 'g1' },
      });
      return group.id;
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: syncedGroupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: { all: [] },
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: syncedGroupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('group-is-synced');
  });
});

describe('delegatedRevoke', () => {
  it('revokes a grant this delegation produced', async () => {
    await delegateGroup();
    await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    );
    const { revoked } = await delegatedRevoke(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
      },
      { now: NOW },
    );
    expect(revoked).toBe(1);
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships).toEqual([]);
  });

  it('refuses to remove a holding that came from a business rule', async () => {
    // That is Provision's, and the console says so, naming the rule.
    await delegateGroup();
    await withTenant(tenantId, async (tx) => {
      const anna = await tx.user.findFirstOrThrow({ where: { personId: annaPersonId } });
      await tx.groupMembership.create({
        data: { tenantId, groupId, userId: anna.id },
      });
    });
    const { revoked } = await delegatedRevoke(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
      },
      { now: NOW },
    );
    // No grant to revoke: nothing here came from a request, so the membership
    // is not this delegation's to remove.
    expect(revoked).toBe(0);
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/delegation-service.test.ts`
Expected: FAIL, "Failed to resolve import ./delegation-service.js".

- [ ] **Step 3: Write the delegation service**

`packages/core/src/automate/delegation-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { listMembers } from '../directory/group-service.js';
import { automateSettings, subjectAudienceFacts } from './catalog-service.js';
import { audienceAdmits, type AudienceCondition } from './audience.js';
import { fulfilRequest, revokeGrant, type FulfilOptions } from './fulfil.js';
import { enqueueOutbox, recipientsForPersons } from './notify.js';
import { LIVE_GRANT_STATUSES, type ResourceType } from './types.js';

export class DelegationRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationRefusedError';
  }
}

export type ResourceCapability = 'view_members' | 'approve' | 'grant' | 'revoke';

export const RESOURCE_CAPABILITIES: readonly ResourceCapability[] = [
  'view_members',
  'approve',
  'grant',
  'revoke',
];

const DAY_MS = 86_400_000;

/**
 * Records an approval delegation.
 *
 * Adds an approver; never replaces one. Depth 1 is enforced here, at creation,
 * as well as by the resolver expanding exactly one level -- the resolver's
 * half holds whatever gets into the table, and this half tells somebody why
 * their delegation was refused instead of leaving it silently ineffective.
 */
export async function createApprovalDelegation(
  tenantId: string,
  actorUserId: string | null,
  input: {
    delegatorPersonId: string;
    delegatePersonId: string;
    category: string | null;
    startsAt: Date;
    endsAt: Date;
  },
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);

    if (input.delegatorPersonId === input.delegatePersonId) {
      throw new DelegationRefusedError('self', 'A person cannot delegate to themselves.');
    }
    if (input.endsAt <= input.startsAt) {
      throw new DelegationRefusedError('window', 'A delegation ends after it starts.');
    }
    const days = (input.endsAt.getTime() - input.startsAt.getTime()) / DAY_MS;
    if (days > settings.maxDelegationDays) {
      throw new DelegationRefusedError(
        'too-long',
        `A delegation may run for at most ${settings.maxDelegationDays} days. An indefinite delegation is a permanent transfer of authority that nobody ever re-decides.`,
      );
    }

    // Depth 1, both directions: the delegate must not already delegate
    // onwards, and the delegator must not already be somebody's delegate.
    const chained = await tx.approvalDelegation.findFirst({
      where: {
        revokedAt: null,
        endsAt: { gt: input.startsAt },
        OR: [
          { delegatorPersonId: input.delegatePersonId },
          { delegatePersonId: input.delegatorPersonId },
        ],
      },
    });
    if (chained !== null) {
      throw new DelegationRefusedError(
        'not-transitive',
        'Delegation is not transitive: one of these two already holds a delegation, and chaining them would route approvals to somebody neither party chose.',
      );
    }

    const created = await tx.approvalDelegation.create({
      data: {
        tenantId,
        delegatorPersonId: input.delegatorPersonId,
        delegatePersonId: input.delegatePersonId,
        category: input.category,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdByUserId: actorUserId,
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.delegation.create',
      targetType: 'ApprovalDelegation',
      targetId: created.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        delegatorPersonId: input.delegatorPersonId,
        delegatePersonId: input.delegatePersonId,
        category: input.category,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
      },
    });

    // Both parties, at both ends. A delegation nobody was told about is a
    // transfer of authority nobody agreed to.
    const recipients = await recipientsForPersons(tx, [
      input.delegatorPersonId,
      input.delegatePersonId,
    ]);
    await enqueueOutbox(
      tx,
      recipients.map((r) => ({
        template: 'automate-delegation-started' as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          delegatorName: input.delegatorPersonId,
          delegateName: input.delegatePersonId,
          endsAt: input.endsAt.toDateString(),
        },
        requestId: null,
        userId: r.userId,
      })),
    );

    return { id: created.id };
  });
}

export async function endApprovalDelegation(
  tenantId: string,
  actorUserId: string | null,
  delegationId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await withTenant(tenantId, async (tx) => {
    const delegation = await tx.approvalDelegation.findUniqueOrThrow({
      where: { id: delegationId },
    });
    if (delegation.revokedAt !== null) return;
    await tx.approvalDelegation.update({
      where: { id: delegationId },
      data: { revokedAt: now },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.delegation.end',
      targetType: 'ApprovalDelegation',
      targetId: delegationId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        delegatorPersonId: delegation.delegatorPersonId,
        delegatePersonId: delegation.delegatePersonId,
      },
    });
    const recipients = await recipientsForPersons(tx, [
      delegation.delegatorPersonId,
      delegation.delegatePersonId,
    ]);
    await enqueueOutbox(
      tx,
      recipients.map((r) => ({
        template: 'automate-delegation-ended' as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          delegatorName: delegation.delegatorPersonId,
          delegateName: delegation.delegatePersonId,
          endsAt: now.toDateString(),
        },
        requestId: null,
        userId: r.userId,
      })),
    );
  });
}

export async function upsertResourceDelegation(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string;
    resourceType: ResourceType;
    resourceId: string;
    delegatePersonId: string | null;
    delegateGroupId: string | null;
    capabilities: ResourceCapability[];
    audienceCondition: AudienceCondition | null;
    startsAt: Date;
    endsAt: Date | null;
  },
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    if (input.capabilities.length === 0) {
      throw new DelegationRefusedError(
        'no-capabilities',
        'A delegation with no capabilities does nothing; remove it instead.',
      );
    }
    // Scope is per resource, never per type. There is no "manage all groups"
    // delegation; that is a role, and roles live in the console.
    const data = {
      tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      delegatePersonId: input.delegatePersonId,
      delegateGroupId: input.delegateGroupId,
      capabilities: input.capabilities,
      audienceCondition: input.audienceCondition ?? undefined,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdByUserId: actorUserId,
    };
    const row =
      input.id === undefined
        ? await tx.resourceDelegation.create({ data })
        : await tx.resourceDelegation.update({ where: { id: input.id }, data });

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.resource_delegation.upsert',
      targetType: 'ResourceDelegation',
      targetId: row.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        capabilities: input.capabilities,
        endsAt: input.endsAt?.toISOString() ?? null,
      },
    });
    return { id: row.id };
  });
}

export interface ManagedResource {
  delegationId: string;
  resourceType: ResourceType;
  resourceId: string;
  capabilities: ResourceCapability[];
  endsAt: Date | null;
  audienceCondition: AudienceCondition | null;
}

/** What "Resources you manage" lists. A portal read, under a portal session. */
export async function resourcesManagedBy(
  tx: TenantClient,
  personId: string,
  now: Date,
): Promise<ManagedResource[]> {
  const users = await tx.user.findMany({ where: { personId }, select: { id: true } });
  const memberships = await tx.groupMembership.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { groupId: true },
  });
  const groupIds = memberships.map((m) => m.groupId);

  const rows = await tx.resourceDelegation.findMany({
    where: {
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      ...(groupIds.length === 0
        ? { delegatePersonId: personId }
        : {
            OR2: undefined,
          }),
    },
  });

  return rows
    .filter(
      (row) =>
        row.delegatePersonId === personId ||
        (row.delegateGroupId !== null && groupIds.includes(row.delegateGroupId)),
    )
    .map((row) => ({
      delegationId: row.id,
      resourceType: row.resourceType as ResourceType,
      resourceId: row.resourceId,
      capabilities: row.capabilities as ResourceCapability[],
      endsAt: row.endsAt,
      audienceCondition: row.audienceCondition as AudienceCondition | null,
    }));
}

async function delegationFor(
  tx: TenantClient,
  personId: string,
  resourceType: ResourceType,
  resourceId: string,
  capability: ResourceCapability,
  now: Date,
): Promise<ManagedResource> {
  const managed = await resourcesManagedBy(tx, personId, now);
  const match = managed.find(
    (m) => m.resourceType === resourceType && m.resourceId === resourceId,
  );
  if (match === undefined || !match.capabilities.includes(capability)) {
    throw new DelegationRefusedError(
      'not-permitted',
      'You do not manage that resource, or not in that way.',
    );
  }
  return match;
}

/**
 * A delegated administrator adding somebody.
 *
 * Creates an `AccessRequest` with `productId` null, `origin`
 * `delegated_admin`, no approval stages, and the acting person recorded as the
 * submitter, then fulfils it down the ordinary path. The alternative -- a
 * direct membership write -- is faster and forks the audit trail and the
 * fulfilment path in two, which is precisely the inventory gap Govern will be
 * asked to close.
 */
export async function delegatedGrant(
  tenantId: string,
  input: {
    actingPersonId: string;
    actingUserId: string;
    resourceType: ResourceType;
    resourceId: string;
    subjectPersonIds: string[];
    justification: string;
    durationDays: number | null;
  },
  options: FulfilOptions = {},
): Promise<{ requestIds: string[] }> {
  const now = options.now ?? new Date();

  const requestIds = await withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    const subjects = [...new Set(input.subjectPersonIds)];
    if (subjects.length > settings.delegatedBulkLimit) {
      throw new DelegationRefusedError(
        'too-many',
        `A delegated act may name at most ${settings.delegatedBulkLimit} people. For more than that, ask an administrator.`,
      );
    }

    const delegation = await delegationFor(
      tx,
      input.actingPersonId,
      input.resourceType,
      input.resourceId,
      'grant',
      now,
    );

    if (input.resourceType === 'group') {
      const group = await tx.group.findUniqueOrThrow({
        where: { id: input.resourceId },
        include: { source: { select: { name: true } } },
      });
      if (group.sourceId !== null) {
        throw new DelegationRefusedError(
          'group-is-synced',
          `${group.name} is owned by the directory source ${group.source?.name ?? 'unknown'}, which rewrites its membership on every run.`,
        );
      }
    }

    // The resource's own audience rule applies: where it is reachable through
    // a product, that product's condition; otherwise the delegation's own.
    // Without this, delegation is a hole underneath section 6.
    const productGrant = await tx.productGrant.findFirst({
      where: { resourceType: input.resourceType, resourceId: input.resourceId },
      include: { product: { select: { audienceCondition: true, status: true } } },
    });
    const condition =
      productGrant?.product.status === 'active'
        ? (productGrant.product.audienceCondition as AudienceCondition | null)
        : delegation.audienceCondition;

    const ids: string[] = [];
    for (const subjectPersonId of subjects) {
      const facts = await subjectAudienceFacts(tx, subjectPersonId, now);
      if (!audienceAdmits(condition, facts.contracts, facts)) {
        throw new DelegationRefusedError(
          'outside-audience',
          'One of these people is outside the audience for this resource, so it is not yours to grant them.',
        );
      }

      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          productId: null,
          subjectPersonId,
          requestedByUserId: input.actingUserId,
          requestedByPersonId: input.actingPersonId,
          origin: 'delegated_admin',
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          justification: input.justification,
          requestedDurationDays: input.durationDays,
          status: 'approved',
          decidedAt: now,
        },
      });
      await tx.requestItem.create({
        data: {
          tenantId,
          requestId: request.id,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          targetSystemId: null,
        },
      });
      await recordEvent(tx, {
        actorUserId: input.actingUserId,
        action: 'automate.delegated.grant',
        targetType: 'AccessRequest',
        targetId: request.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          delegationId: delegation.delegationId,
          subjectPersonId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
      });
      ids.push(request.id);
    }
    return ids;
  });

  for (const requestId of requestIds) {
    await fulfilRequest(tenantId, requestId, options);
  }
  return { requestIds };
}

/**
 * A delegated administrator removing somebody.
 *
 * The same act inverted: it revokes the `AccessGrant`, which removes the term
 * from desired state, and the removal follows the ordinary path. A holding
 * that came from a business rule is NOT this delegation's to remove -- that is
 * Provision's, and revoking zero grants is the honest answer.
 */
export async function delegatedRevoke(
  tenantId: string,
  input: {
    actingPersonId: string;
    actingUserId: string;
    resourceType: ResourceType;
    resourceId: string;
    subjectPersonIds: string[];
  },
  options: FulfilOptions = {},
): Promise<{ revoked: number }> {
  const now = options.now ?? new Date();

  const grantIds = await withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    const subjects = [...new Set(input.subjectPersonIds)];
    if (subjects.length > settings.delegatedBulkLimit) {
      throw new DelegationRefusedError(
        'too-many',
        `A delegated act may name at most ${settings.delegatedBulkLimit} people. For more than that, ask an administrator.`,
      );
    }
    await delegationFor(
      tx,
      input.actingPersonId,
      input.resourceType,
      input.resourceId,
      'revoke',
      now,
    );

    const grants = await tx.accessGrant.findMany({
      where: {
        subjectPersonId: { in: subjects },
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: { in: [...LIVE_GRANT_STATUSES] },
      },
      select: { id: true },
    });
    return grants.map((g) => g.id);
  });

  for (const grantId of grantIds) {
    await revokeGrant(
      tenantId,
      input.actingUserId,
      grantId,
      'removed by the resource manager',
      options,
    );
  }
  return { revoked: grantIds.length };
}
```

- [ ] **Step 4: Correct the `resourcesManagedBy` where clause**

The draft above contains a `OR2: undefined` key that Prisma will reject. Replace the query with an unconditional read and filter in memory, which is what the code below it already does:

```ts
  const rows = await tx.resourceDelegation.findMany({
    where: {
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
  });
```

Marked as a correction rather than quietly fixed. The delegation table is per tenant and small — this is one of the few places where reading the set and filtering in memory is cheaper than expressing a two-way OR across a nullable group id.

- [ ] **Step 5: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/sweep-service.js';`:

```ts
export * from './automate/delegation-service.js';
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/core/src/automate/delegation-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/automate/delegation-service.ts \
        packages/core/src/automate/delegation-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(automate): approval delegation and delegated resource administration"
```

---

## Task 15: Jobs, scheduling, and the transaction rule as a test

Spec §11, §12, §13 and §16. Three queues, three schedule keys per tenant, and the reminder cadence that never approves anything.

**Files:**
- Create: `packages/core/src/automate/jobs.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/api/src/scheduler.ts`
- Test: `packages/core/src/automate/jobs.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `prisma` from `@syntra/db`; `recordEvent`; `type Scheduler`; `renderMessage`, `sendMessage`, `type Transport` from `../notify/notification-service.js`; `type TemplateName`; `automateSettings` from `./catalog-service.js`; `previewExpirySweep`, `applyExpirySweep` from `./sweep-service.js`; `reflectProvisionOutcomes` from `./reflect.js`; `resolveEscalationApprovers`, `type StageSnapshot` from `./approvers.js`; `subjectFor` from `./request-service.js`; `enqueueOutbox`, `recipientsForPersons` from `./notify.js`; `requestUrl` from `./fulfil.js`.
- Produces:
  - `const AUTOMATE_OUTBOX_JOB = 'automate.outbox'`
  - `const AUTOMATE_TICK_JOB = 'automate.tick'`
  - `const AUTOMATE_SWEEP_JOB = 'automate.sweep'`
  - `type AutomatePurpose = 'outbox' | 'tick' | 'sweep'`
  - `function automateScheduleKey(tenantId: string, purpose: AutomatePurpose): string`
  - `interface AutomateJobPayload { tenantId: string }`
  - `function automateJobPayload(tenantId: string): AutomateJobPayload`
  - `interface JobOptions { now?: Date; scheduler?: Scheduler | null; publicUrl?: string; batchSize?: number }`
  - `async function runOutboxJob(transport: Transport, payload: AutomateJobPayload, options?: JobOptions): Promise<{ sent: number; failed: number }>`
  - `async function runTickJob(payload: AutomateJobPayload, options?: JobOptions): Promise<{ reminders: number; escalations: number; expired: number; warnings: number }>`
  - `async function runSweepJob(payload: AutomateJobPayload, options?: JobOptions): Promise<{ sweepId: string; status: string }>`
  - `async function applyAutomateSchedules(scheduler: Scheduler, tenantId: string, sweepSchedule: string | null): Promise<void>`
  - `function registerAutomateJobs(scheduler: Scheduler, transport: Transport, options?: { publicUrl?: string }): void`
  - `const OUTBOX_MAX_ATTEMPTS = 5`

- [ ] **Step 1: Write the failing test**

`packages/core/src/automate/jobs.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport } from '../notify/notification-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import {
  AUTOMATE_OUTBOX_JOB,
  AUTOMATE_SWEEP_JOB,
  AUTOMATE_TICK_JOB,
  OUTBOX_MAX_ATTEMPTS,
  applyAutomateSchedules,
  automateScheduleKey,
  runOutboxJob,
  runSweepJob,
  runTickJob,
} from './jobs.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('automateScheduleKey', () => {
  it('is distinct per tenant AND per purpose', async () => {
    // pg-boss keys its schedule table on (queue, key). All directory sources
    // once shared key: '' and only the last one in the last tenant ever ran.
    const a = automateScheduleKey('t1', 'sweep');
    const b = automateScheduleKey('t2', 'sweep');
    const c = automateScheduleKey('t1', 'tick');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('applyAutomateSchedules', () => {
  it('schedules all three queues with their own keys', async () => {
    const scheduler = schedulerStub();
    await applyAutomateSchedules(scheduler, tenantId, '0 2 * * *');
    const names = scheduler.schedule.mock.calls.map((c) => c[0]);
    expect(names.sort()).toEqual(
      [AUTOMATE_OUTBOX_JOB, AUTOMATE_SWEEP_JOB, AUTOMATE_TICK_JOB].sort(),
    );
    const keys = scheduler.schedule.mock.calls.map((c) => c[3]);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toContain(tenantId);
  });

  it('unschedules the sweep when a tenant has no cron for it', async () => {
    // Two halves of one decision. A test that watched only `schedule` would
    // pass while a switched-off sweep kept firing.
    const scheduler = schedulerStub();
    await applyAutomateSchedules(scheduler, tenantId, null);
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      AUTOMATE_SWEEP_JOB,
      automateScheduleKey(tenantId, 'sweep'),
    );
  });
});

describe('runOutboxJob', () => {
  async function draft(over: Record<string, unknown> = {}) {
    return withTenant(tenantId, (tx) =>
      tx.notificationOutbox.create({
        data: {
          tenantId,
          template: 'automate-stage-opened',
          to: 'jan@acme.test',
          vars: { displayName: 'Jan', productName: 'Statistics licence' },
          ...over,
        },
      }),
    );
  }

  it('renders and sends unsent rows, and marks them sent', async () => {
    await draft();
    const mail = memoryTransport();
    const result = await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent[0]?.to).toBe('jan@acme.test');
    // The tenant name comes from the Tenant row, as a parameter -- renderMessage
    // is pure and takes no transaction, which is what stops the send being
    // dragged inside one.
    expect(mail.sent[0]?.subject).toContain('Acme');
    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it('does not send a row twice', async () => {
    await draft();
    const mail = memoryTransport();
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(mail.sent).toHaveLength(1);
  });

  it('records the failure and the attempt count rather than losing the message', async () => {
    await draft();
    const failing = {
      send: async () => {
        throw new Error('connection refused');
      },
    };
    const result = await runOutboxJob(failing, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 0, failed: 1 });
    const row = await withTenant(tenantId, (tx) => tx.notificationOutbox.findFirstOrThrow());
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('connection refused');
    expect(row.sentAt).toBeNull();
  });

  it('stops retrying after OUTBOX_MAX_ATTEMPTS and surfaces the row rather than swallowing it', async () => {
    await draft({ attempts: OUTBOX_MAX_ATTEMPTS });
    const mail = memoryTransport();
    const result = await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toEqual([]);
    // Exhausted, not deleted. "The approver says they never got the mail" is
    // the most common support question a request system produces, and this row
    // is the answer.
    const row = await withTenant(tenantId, (tx) => tx.notificationOutbox.findFirstOrThrow());
    expect(row.sentAt).toBeNull();
  });

  it('holds a digest row back until the daily pass', async () => {
    await draft({ digest: true });
    const mail = memoryTransport();
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(mail.sent).toEqual([]);
    await runOutboxJob(mail, { tenantId }, { now: NOW, batchSize: 100 });
    expect(mail.sent).toEqual([]);
  });
});

describe('runTickJob — reminders and escalation', () => {
  let requestId: string;
  let stepId: string;
  let janPersonId: string;

  beforeEach(async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const jan = await tx.person.create({
        data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
      });
      await tx.contract.create({
        data: { tenantId, personId: jan.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      const user = await tx.user.create({
        data: { tenantId, login: 'jan', email: 'jan@acme.test', displayName: 'Jan', personId: jan.id },
      });
      const anna = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          subjectPersonId: anna.id,
          requestedByUserId: user.id,
          status: 'pending_approval',
        },
      });
      const step = await tx.approvalStep.create({
        data: {
          tenantId,
          requestId: request.id,
          sequence: 1,
          status: 'open',
          openedAt: day('2026-06-10'),
          slaDueAt: day('2026-06-12'),
          stageSnapshot: {
            sequence: 1,
            name: 'Manager',
            selector: 'person',
            selectorConfig: { personId: jan.id },
            quorum: 'any',
            fallbackSelector: null,
            fallbackConfig: {},
            slaHours: 48,
            onTimeout: 'remind',
            escalationSelector: null,
            escalationConfig: {},
            expiryHours: null,
          },
        },
      });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: jan.id, via: 'selector' },
      });
      return { requestId: request.id, stepId: step.id, janPersonId: jan.id };
    });
    ({ requestId, stepId, janPersonId } = seeded);
  });

  it('reminds past the SLA and then no more than once a day', async () => {
    // Remind forever by default. A request never stops asking, and it never
    // approves itself for not having been read.
    const first = await runTickJob({ tenantId }, { now: NOW });
    expect(first.reminders).toBe(1);
    const again = await runTickJob({ tenantId }, { now: NOW });
    expect(again.reminders).toBe(0);
    const tomorrow = await runTickJob({ tenantId }, { now: day('2026-06-16') });
    expect(tomorrow.reminders).toBe(1);
  });

  it('never moves the request out of pending_approval, however long it waits', async () => {
    await runTickJob({ tenantId }, { now: day('2027-01-01') });
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('pending_approval');
  });

  it('adds the escalation approvers and tells the originals they were escalated past', async () => {
    const rikPersonId = await withTenant(tenantId, async (tx) => {
      const rik = await tx.person.create({
        data: { tenantId, givenName: 'Rik', familyName: 'Bos' },
      });
      await tx.contract.create({
        data: { tenantId, personId: rik.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      await tx.user.create({
        data: { tenantId, login: 'rik', email: 'rik@acme.test', displayName: 'Rik', personId: rik.id },
      });
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      await tx.approvalStep.update({
        where: { id: stepId },
        data: {
          stageSnapshot: {
            ...snapshot,
            onTimeout: 'escalate',
            escalationSelector: 'person',
            escalationConfig: { personId: rik.id },
          },
        },
      });
      return rik.id;
    });

    const result = await runTickJob({ tenantId }, { now: NOW });
    expect(result.escalations).toBe(1);

    const state = await withTenant(tenantId, async (tx) => ({
      approvers: await tx.approvalStepApprover.findMany({ where: { stepId } }),
      escalated: await tx.notificationOutbox.findMany({
        where: { template: 'automate-escalated' },
      }),
      told: await tx.notificationOutbox.findMany({
        where: { template: 'automate-escalated-past' },
      }),
    }));
    // ADDED. The originals remain, and they are told.
    expect(state.approvers.map((a) => a.personId).sort()).toEqual(
      [janPersonId, rikPersonId].sort(),
    );
    expect(state.escalated.map((o) => o.to)).toEqual(['rik@acme.test']);
    expect(state.told.map((o) => o.to)).toEqual(['jan@acme.test']);
  });

  it('escalates once, not on every tick', async () => {
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      const rik = await tx.person.create({
        data: { tenantId, givenName: 'Rik', familyName: 'Bos' },
      });
      await tx.contract.create({
        data: { tenantId, personId: rik.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      await tx.user.create({
        data: { tenantId, login: 'rik', email: 'rik@acme.test', displayName: 'Rik', personId: rik.id },
      });
      await tx.approvalStep.update({
        where: { id: stepId },
        data: {
          stageSnapshot: {
            ...snapshot,
            onTimeout: 'escalate',
            escalationSelector: 'person',
            escalationConfig: { personId: rik.id },
          },
        },
      });
    });
    await runTickJob({ tenantId }, { now: NOW });
    const second = await runTickJob({ tenantId }, { now: day('2026-06-20') });
    expect(second.escalations).toBe(0);
  });

  it('expires only where a stage opted into it, and tells the requester by name', async () => {
    // Opt-in per product, never the default, because a request that quietly
    // evaporates is exactly the silent-drop failure this platform keeps
    // rediscovering -- and even opted into, it is loud.
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      await tx.approvalStep.update({
        where: { id: stepId },
        data: { stageSnapshot: { ...snapshot, onTimeout: 'expire', expiryHours: 24 } },
      });
    });
    const result = await runTickJob({ tenantId }, { now: NOW });
    expect(result.expired).toBe(1);
    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-request-expired' },
      }),
    }));
    expect(state.request.status).toBe('expired');
    expect(state.outbox).toHaveLength(1);
  });
});

describe('runTickJob — expiry warnings', () => {
  it('warns the holder at each configured number of days, once per threshold', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.user.create({
        data: { tenantId, login: 'anna', email: 'anna@acme.test', displayName: 'Anna', personId: person.id },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: person.id,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-22'),
          status: 'active',
        },
      });
    });
    const first = await runTickJob({ tenantId }, { now: NOW });
    expect(first.warnings).toBe(1);
    const again = await runTickJob({ tenantId }, { now: NOW });
    expect(again.warnings).toBe(0);
    const closer = await runTickJob({ tenantId }, { now: day('2026-06-21') });
    expect(closer.warnings).toBe(1);
  });
});

describe('runSweepJob', () => {
  it('previews and stops when the sweep needs confirming; the scheduler confirms nothing', async () => {
    const result = await runSweepJob({ tenantId }, { now: NOW });
    const sweep = await withTenant(tenantId, (tx) =>
      tx.expirySweep.findUniqueOrThrow({ where: { id: result.sweepId } }),
    );
    expect(sweep.status).toBe('previewed');
    expect(sweep.confirmedByUserId).toBeNull();
  });
});

/**
 * The transaction rule, as a test rather than a convention.
 *
 * A static instrument, deliberately: a runtime probe for "is a Prisma
 * interactive transaction open on this connection" does not exist, and every
 * approximation of one is flaky enough to be worse than nothing. What IS
 * checkable, and what actually failed twice on this project, is a module
 * reaching for a transport at all.
 */
describe('nothing in the request path can send anything', () => {
  const DIR = 'packages/core/src/automate';

  it('imports a transport in exactly one module, and it is the job module', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      if (file === 'jobs.ts') continue;
      const source = readFileSync(`${DIR}/${file}`, 'utf8');
      if (/\b(sendMessage|queueMessage|deliverMessage|smtpTransport|Transport)\b/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sends outside every transaction in the job module', () => {
    const source = readFileSync(`${DIR}/jobs.ts`, 'utf8');
    // Every `withTenant(` block in this file is closed before the send loop.
    // Asserted by position rather than by parsing: the send call must not be
    // inside the text of any withTenant callback.
    const sendIndex = source.indexOf('await sendMessage(');
    expect(sendIndex).toBeGreaterThan(0);
    const before = source.slice(0, sendIndex);
    const opened = (before.match(/withTenant\(/g) ?? []).length;
    const closed = (before.match(/\}\);\n/g) ?? []).length;
    expect(closed).toBeGreaterThanOrEqual(opened);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/automate/jobs.test.ts`
Expected: FAIL, "Failed to resolve import ./jobs.js".

- [ ] **Step 3: Write the job module**

`packages/core/src/automate/jobs.ts`:

```ts
import { prisma, withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import {
  renderMessage,
  sendMessage,
  type Transport,
} from '../notify/notification-service.js';
import type { TemplateName } from '../notify/templates/index.js';
import { automateSettings } from './catalog-service.js';
import { applyExpirySweep, previewExpirySweep } from './sweep-service.js';
import { reflectProvisionOutcomes } from './reflect.js';
import { resolveEscalationApprovers, type StageSnapshot } from './approvers.js';
import { subjectFor } from './request-service.js';
import { enqueueOutbox, recipientsForPersons } from './notify.js';
import { requestUrl } from './fulfil.js';
import { IN_FORCE_GRANT_STATUSES } from './types.js';

export const AUTOMATE_OUTBOX_JOB = 'automate.outbox';
export const AUTOMATE_TICK_JOB = 'automate.tick';
export const AUTOMATE_SWEEP_JOB = 'automate.sweep';

export type AutomatePurpose = 'outbox' | 'tick' | 'sweep';

/**
 * pg-boss keys its schedule table on (queue, key), and `key` defaults to the
 * empty string. This slice runs three schedules per tenant, so a key that
 * named only the tenant would still collapse two of them.
 */
export function automateScheduleKey(tenantId: string, purpose: AutomatePurpose): string {
  return `automate:${purpose}:${tenantId}`;
}

export interface AutomateJobPayload {
  tenantId: string;
}

export function automateJobPayload(tenantId: string): AutomateJobPayload {
  return { tenantId };
}

export interface JobOptions {
  now?: Date;
  scheduler?: Scheduler | null;
  publicUrl?: string;
  batchSize?: number;
}

/** After this many failures a row stops being retried and starts being visible. */
export const OUTBOX_MAX_ATTEMPTS = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Reads the outbox, renders each message, sends it, and records what happened.
 *
 * Three phases, and the middle one holds no transaction: read the rows out,
 * send, write the results back. `renderMessage` is pure and takes the tenant
 * name as a parameter; `sendMessage` takes a transport and cannot be handed a
 * `TenantClient`, because the signature was deliberately changed after an SMTP
 * round trip inside `prisma.$transaction` shipped as a defect.
 */
export async function runOutboxJob(
  transport: Transport,
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ sent: number; failed: number }> {
  const batchSize = options.batchSize ?? 200;

  // Phase 1: read out. The tenant NAME comes with it, so nothing downstream
  // needs a transaction to render.
  const tenant = await prisma.tenant.findUnique({
    where: { id: payload.tenantId },
    select: { name: true },
  });
  if (tenant === null) return { sent: 0, failed: 0 };

  const rows = await withTenant(payload.tenantId, (tx) =>
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

  // Phase 2: the network. No transaction is held.
  const results: { id: string; error: string | null }[] = [];
  for (const row of rows) {
    try {
      const message = renderMessage(
        tenant.name,
        row.template as TemplateName,
        row.to,
        (row.vars ?? {}) as Record<string, string>,
      );
      await sendMessage(transport, message);
      results.push({ id: row.id, error: null });
    } catch (cause) {
      results.push({ id: row.id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  // Phase 3: write the results back, one short transaction.
  const now = options.now ?? new Date();
  let sent = 0;
  let failed = 0;
  await withTenant(payload.tenantId, async (tx) => {
    for (const result of results) {
      if (result.error === null) {
        await tx.notificationOutbox.update({
          where: { id: result.id },
          data: { sentAt: now, lastError: null },
        });
        sent += 1;
      } else {
        // Never deleted. A row that exhausts its attempts is surfaced, not
        // swallowed: "the approver says they never got the mail" is
        // unanswerable without it.
        await tx.notificationOutbox.update({
          where: { id: result.id },
          data: { attempts: { increment: 1 }, lastError: result.error },
        });
        failed += 1;
      }
    }
  });

  return { sent, failed };
}

/**
 * The five-minute pass: reminders, escalation, opt-in expiry, expiry warnings,
 * and reflection of whatever Provision has done since.
 *
 * There is NO branch in this function that approves anything. That is not a
 * convention here; `decision-service.ts` and `request-service.ts` are the only
 * two modules in the slice that write `status: 'approved'`, and Task 11's
 * structural test asserts it.
 */
export async function runTickJob(
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ reminders: number; escalations: number; expired: number; warnings: number }> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';
  const counts = { reminders: 0, escalations: 0, expired: 0, warnings: 0 };

  await withTenant(payload.tenantId, async (tx) => {
    const settings = await automateSettings(tx);

    const openSteps = await tx.approvalStep.findMany({
      where: { status: 'open' },
      include: { request: { include: { product: true } } },
    });

    for (const step of openSteps) {
      const stage = step.stageSnapshot as unknown as StageSnapshot;
      if (step.slaDueAt === null || step.openedAt === null) continue;

      const halfway = new Date(
        step.openedAt.getTime() + (stage.slaHours / 2) * HOUR_MS,
      );
      const dueForReminder =
        now >= halfway &&
        (step.lastRemindedAt === null || now.getTime() - step.lastRemindedAt.getTime() >= DAY_MS);

      if (stage.onTimeout === 'expire' && stage.expiryHours !== null) {
        const expiresAt = new Date(step.openedAt.getTime() + stage.expiryHours * HOUR_MS);
        if (now >= expiresAt) {
          await tx.approvalStep.updateMany({
            where: { requestId: step.requestId, status: { in: ['open', 'waiting'] } },
            data: { status: 'skipped', closedAt: now },
          });
          await tx.accessRequest.update({
            where: { id: step.requestId },
            data: {
              status: 'expired',
              statusReason: `nobody decided within ${stage.expiryHours} hours`,
              decidedAt: now,
            },
          });
          await recordEvent(tx, {
            actorUserId: null,
            action: 'automate.request.expire',
            targetType: 'AccessRequest',
            targetId: step.requestId,
            outcome: 'success',
            sourceIp: null,
            payload: { stageSequence: step.sequence, expiryHours: stage.expiryHours },
          });
          const recipients = await recipientsForPersons(tx, [
            step.request.subjectPersonId,
            ...(step.request.requestedByPersonId === null
              ? []
              : [step.request.requestedByPersonId]),
          ]);
          await enqueueOutbox(
            tx,
            recipients.map((r) => ({
              template: 'automate-request-expired' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                expiryHours: String(stage.expiryHours),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          );
          counts.expired += 1;
          continue;
        }
      }

      if (stage.onTimeout === 'escalate' && now >= step.slaDueAt && step.escalatedAt === null) {
        const subject = await subjectFor(tx, step.requestId);
        const escalation = await resolveEscalationApprovers(tx, stage, subject, now);
        if (escalation.approvers.length > 0) {
          const existing = await tx.approvalStepApprover.findMany({
            where: { stepId: step.id },
            select: { personId: true },
          });
          const existingIds = new Set(existing.map((e) => e.personId));
          // ADDED, not substituted. Escalation that silently removes somebody's
          // authority is how an approver discovers, months later, that
          // decisions attributed to their team were not theirs.
          for (const approver of escalation.approvers) {
            if (existingIds.has(approver.personId)) continue;
            await tx.approvalStepApprover.create({
              data: {
                tenantId: step.tenantId,
                stepId: step.id,
                personId: approver.personId,
                via: 'escalation',
                onBehalfOfPersonId: approver.onBehalfOfPersonId,
              },
            });
          }
          await tx.approvalStep.update({
            where: { id: step.id },
            data: { escalatedAt: now },
          });

          const added = await recipientsForPersons(
            tx,
            escalation.approvers.map((a) => a.personId),
          );
          const originals = await recipientsForPersons(tx, [...existingIds]);
          await enqueueOutbox(tx, [
            ...added.map((r) => ({
              template: 'automate-escalated' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName: step.request.subjectPersonId,
                slaHours: String(stage.slaHours),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
            ...originals.map((r) => ({
              template: 'automate-escalated-past' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName: step.request.subjectPersonId,
                slaHours: String(stage.slaHours),
                escalatedTo: added.map((a) => a.displayName).join(', '),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          ]);
          counts.escalations += 1;
        }
      }

      if (dueForReminder) {
        const approvers = await tx.approvalStepApprover.findMany({
          where: { stepId: step.id },
          select: { personId: true },
        });
        const recipients = await recipientsForPersons(
          tx,
          approvers.map((a) => a.personId),
        );
        if (recipients.length > 0) {
          await enqueueOutbox(
            tx,
            recipients.map((r) => ({
              template: 'automate-reminder' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName: step.request.subjectPersonId,
                openedAt: step.openedAt!.toDateString(),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          );
          await tx.approvalStep.update({
            where: { id: step.id },
            data: { lastRemindedAt: now },
          });
          counts.reminders += 1;
        }
      }
    }

    // Expiry warnings, one per grant per threshold. Deduped on the outbox
    // itself, keyed on the number of days, so the 7-day and the 1-day warning
    // are two messages and the 7-day one is not repeated for six days.
    for (const days of settings.expiryWarningDays) {
      const from = new Date(now.getTime() + (days - 1) * DAY_MS);
      const to = new Date(now.getTime() + days * DAY_MS);
      const grants = await tx.accessGrant.findMany({
        where: {
          status: { in: [...IN_FORCE_GRANT_STATUSES] },
          endsAt: { gt: from, lte: to },
        },
      });
      for (const grant of grants) {
        const alreadyWarned = await tx.notificationOutbox.count({
          where: {
            template: 'automate-expiry-warning',
            vars: { path: ['grantId'], equals: grant.id },
            AND: [{ vars: { path: ['days'], equals: String(days) } }],
          },
        });
        if (alreadyWarned > 0) continue;
        const recipients = await recipientsForPersons(tx, [
          grant.subjectPersonId,
          ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
        ]);
        if (recipients.length === 0) continue;
        await enqueueOutbox(
          tx,
          recipients.map((r) => ({
            template: 'automate-expiry-warning' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              subjectName: grant.subjectPersonId,
              productName: grant.productId ?? 'requested access',
              endsAt: grant.endsAt!.toDateString(),
              days: String(days),
              grantId: grant.id,
              // The Extend action. An extension is a NEW request against the
              // same product, pre-filled -- auto-renewal is approval by
              // inattention wearing a different hat.
              extendUrl: `${publicUrl.replace(/\/$/, '')}/access/${grant.id}/extend`,
            },
            requestId: null,
            userId: r.userId,
          })),
        );
        counts.warnings += 1;
      }
    }
  });

  // Outside the transaction: reflection opens its own, and enqueues.
  await reflectProvisionOutcomes(payload.tenantId, {
    now,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    publicUrl,
  });

  return counts;
}

/**
 * The nightly sweep. Previews always; applies only when the guard let it
 * through unblocked and unconfirmable.
 *
 * The scheduler never confirms anything. `applyExpirySweep` is called with no
 * `confirm`, so a sweep that trips either axis simply sits in the review
 * screen with its reasons.
 */
export async function runSweepJob(
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ sweepId: string; status: string }> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const sweep = await previewExpirySweep(payload.tenantId, { now, publicUrl });
  if (sweep.status !== 'previewed' || sweep.requiresConfirmation) {
    return { sweepId: sweep.id, status: sweep.status };
  }
  const applied = await applyExpirySweep(payload.tenantId, sweep.id, {
    now,
    publicUrl,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  return { sweepId: sweep.id, status: applied.status };
}

/**
 * Brings the scheduler into line with one tenant.
 *
 * Every queue every time, and the sweep is UNSCHEDULED when the tenant has no
 * cron for it. Scheduling and unscheduling are two halves of one decision: a
 * sweep switched off and merely left out of the next round of scheduling keeps
 * firing.
 */
export async function applyAutomateSchedules(
  scheduler: Scheduler,
  tenantId: string,
  sweepSchedule: string | null,
): Promise<void> {
  await scheduler.schedule(
    AUTOMATE_OUTBOX_JOB,
    '* * * * *',
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'outbox'),
  );
  await scheduler.schedule(
    AUTOMATE_TICK_JOB,
    '*/5 * * * *',
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'tick'),
  );
  if (sweepSchedule === null) {
    await scheduler.unschedule(
      AUTOMATE_SWEEP_JOB,
      automateScheduleKey(tenantId, 'sweep'),
    );
    return;
  }
  await scheduler.schedule(
    AUTOMATE_SWEEP_JOB,
    sweepSchedule,
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'sweep'),
  );
}

/**
 * Registers the three handlers.
 *
 * `transport` is a parameter rather than constructed here for the reason
 * `buildApp` takes one: no test run may put mail on the wire, and a transport
 * that is a parameter is the only way to guarantee that.
 */
export function registerAutomateJobs(
  scheduler: Scheduler,
  transport: Transport,
  options: { publicUrl?: string } = {},
): void {
  scheduler.register<AutomateJobPayload>(AUTOMATE_OUTBOX_JOB, async (payload) => {
    await runOutboxJob(transport, payload, { publicUrl: options.publicUrl ?? '' });
  });
  scheduler.register<AutomateJobPayload>(AUTOMATE_TICK_JOB, async (payload) => {
    await runTickJob(payload, { scheduler, publicUrl: options.publicUrl ?? '' });
  });
  scheduler.register<AutomateJobPayload>(AUTOMATE_SWEEP_JOB, async (payload) => {
    await runSweepJob(payload, { scheduler, publicUrl: options.publicUrl ?? '' });
  });
}
```

- [ ] **Step 4: Wire the jobs into the API's scheduler**

In `apps/api/src/scheduler.ts`:

1. Extend the import from `@syntra/core`:

```ts
import {
  applyAutomateSchedules,
  applySourceSchedule,
  automateSettings,
  createScheduler,
  localMasterKeyProvider,
  registerAutomateJobs,
  registerKeyRotationJob,
  registerProvisionJobs,
  registerSyncJobs,
  scheduleKeyRotation,
  type Config,
  type Scheduler,
  type Transport,
} from '@syntra/core';
```

2. `scheduleBackgroundWork` gains one more per-tenant block, after the key-rotation loop and before the source loop:

```ts
  for (const tenant of tenants) {
    try {
      const settings = await withTenant(tenant.id, (tx) => automateSettings(tx));
      await applyAutomateSchedules(scheduler, tenant.id, settings.sweepSchedule);
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule Automate background work',
      );
    }
  }
```

   Same failure policy as everything else here: logged, not raised. An API that comes up with the sweep unscheduled is strictly better than one that does not come up.

3. `startSyncScheduler` takes the transport it must hand to the jobs, and registers them:

```ts
export async function startSyncScheduler(
  config: Config,
  logger: FastifyBaseLogger,
  transport: Transport,
  create: (databaseUrl: string) => Scheduler = createScheduler,
): Promise<Scheduler | null> {
```

   and inside the `try`, after `registerKeyRotationJob(scheduler, provider);`:

```ts
    registerAutomateJobs(scheduler, transport, { publicUrl: config.publicUrl });
```

   **The transport is not optional.** Ruling P16 made exactly this point about Provision's initial passwords: without it, an unattended path produces something and delivers it to nobody. Here the whole notification system is that path — an outbox job registered with no transport sends nothing at all, and the failure is silent.

4. `apps/api/src/server.ts` calls `startSyncScheduler`; add the transport argument at that call site, constructed the same way `buildApp` constructs its default: `smtpTransport(config.smtpUrl)`. Where `server.ts` already builds one for `buildApp`, pass the same instance rather than a second.

- [ ] **Step 5: Export the module**

In `packages/core/src/index.ts`, after `export * from './automate/delegation-service.js';`:

```ts
export * from './automate/jobs.js';
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/core/src/automate/jobs.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the API scheduler suite**

Run: `pnpm vitest run apps/api/src/scheduler.test.ts`
Expected: PASS. The signature of `startSyncScheduler` changed, so the existing tests need the transport argument; add `memoryTransport()` at each call site there.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/automate/jobs.ts \
        packages/core/src/automate/jobs.test.ts \
        packages/core/src/index.ts \
        apps/api/src/scheduler.ts apps/api/src/scheduler.test.ts apps/api/src/server.ts
git commit -m "feat(automate): the outbox, reminder, escalation and sweep jobs"
```

---

## Task 16: The HTTP surface — portal and administration

Spec §17. Two plugins, both registered in `apps/api/src/app.ts`.

**Read `apps/api/src/routes/admin/sources.ts` and `apps/api/src/routes/portal.ts` before writing either file.** They establish every convention these routes follow, and they are the reason this task names no framework symbol that does not exist:

- `export async function registerXRoutes(app: FastifyInstance, options: XRouteOptions): Promise<void>` — a plain plugin function, registered with a `prefix` in `app.ts`.
- `app.addHook('preHandler', requireSession('admin'))` (or `'portal'`) inside the plugin, so a new route cannot forget it.
- `requirePermission(PERMISSIONS.X)` imported from `../../plugins/require-permission.js` and passed as `{ preHandler: ... }` per route. It is **not** decorated onto `app`.
- `request.db((tx) => ...)` for a tenant-bound read or write; `request.session.userId` for the actor; `request.ip` for the audit event.
- `ProblemError(status, type, title, detail?, extra?)` from `../../plugins/problem-json.js` for anything that is not a 2xx.
- Route paths are written **relative to the prefix**: `'/automate/products'`, never `'/api/admin/automate/products'`.
- Tests use `buildTestApp()` from `apps/api/src/test-support.js` and `app.inject`, signing in through `/api/auth/login` and elevating through `/api/auth/elevate` for the admin half.

**Files:**
- Create: `packages/contracts/src/automate.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/automate-portal.ts`
- Create: `apps/api/src/routes/admin/automate.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/automate-portal.test.ts`, `apps/api/src/routes/admin/automate.test.ts`

**Interfaces:**
- Consumes: from `@syntra/core` — `PERMISSIONS`, `createProduct`, `updateProduct`, `listAllProducts`, `visibleProducts`, `findVisibleProduct`, `searchVisibleProducts`, `previewAudience`, `automateSettings`, `updateAutomateSettings`, `upsertResourceOwner`, `upsertWorkflow`, `previewWorkflowResolution`, `submitRequest`, `recordDecision`, `cancelRequest`, `handBackGrant`, `revokeGrant`, `previewExpirySweep`, `applyExpirySweep`, `resourcesManagedBy`, `delegatedGrant`, `delegatedRevoke`, `createApprovalDelegation`, `endApprovalDelegation`, `upsertResourceDelegation`, `ProductConfigurationError`, `WorkflowConfigurationError`, `DecisionRefusedError`, `DelegationRefusedError`; from `apps/api` — `requireSession`, `requirePermission`, `ProblemError`, `buildTestApp`; from `@syntra/contracts` — `idParam`.
- Produces: the zod schemas in `packages/contracts/src/automate.ts` (`submitRequestBody`, `decideRequestBody`, `productBody`, `workflowBody`, `audiencePreviewBody`, `resolutionPreviewBody`, `sweepApplyBody`, `delegatedGrantBody`, `approvalDelegationBody`, `resourceDelegationBody`, `settingsBody`, `resourceParam`), and the two route plugins `registerAutomatePortalRoutes` and `registerAdminAutomateRoutes`.

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/automate.ts`:

```ts
import { z } from 'zod';

export const resourceType = z.enum(['entitlement', 'application', 'group']);
export const productKind = z.enum(['targetEntitlement', 'application', 'localGroup']);
export const durationMode = z.enum(['permanent', 'fixed', 'requesterChoice']);
export const approverSelector = z.enum([
  'manager',
  'managerChain',
  'productOwner',
  'resourceOwner',
  'role',
  'group',
  'person',
]);

/**
 * Not `z.any()`. The audience expression and the form schema are validated by
 * their own closed interpreters in `@syntra/core`, and re-declaring their
 * grammar here would be a second definition to keep in agreement. `unknown`
 * hands them across intact and lets the one parser refuse what it refuses.
 */
const opaqueJson = z.unknown();

export const productGrantBody = z.object({
  resourceType,
  resourceId: z.string().uuid(),
  targetSystemId: z.string().uuid().nullable().default(null),
  optional: z.boolean().default(false),
});

export const productBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens'),
  description: z.string().max(2000).nullable().default(null),
  category: z.string().max(120).nullable().default(null),
  iconUrl: z.string().url().max(2048).nullable().default(null),
  requestInstructions: z.string().max(4000).nullable().default(null),
  kind: productKind,
  grants: z.array(productGrantBody).min(1),
  // Nullable and REQUIRED to be stated. There is no default, because the
  // default is "nobody" and an omitted field would read as an accident.
  audienceCondition: opaqueJson.nullable(),
  workflowId: z.string().uuid(),
  formSchema: opaqueJson.default([]),
  durationMode,
  defaultDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  maxDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  ownerPersonId: z.string().uuid().nullable().default(null),
  ownerGroupId: z.string().uuid().nullable().default(null),
  status: z.enum(['draft', 'active', 'retired']).default('draft'),
});
export type ProductBody = z.input<typeof productBody>;

export const stageBody = z.object({
  sequence: z.number().int().positive(),
  name: z.string().min(1).max(120),
  selector: approverSelector,
  selectorConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  quorum: z.enum(['any', 'all']).default('any'),
  fallbackSelector: approverSelector.nullable().default(null),
  fallbackConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  slaHours: z.number().int().positive().max(8760).default(48),
  // THERE IS NO 'approve'. Approval by inattention is a privilege grant
  // nobody made, and the enum is where that is enforced at the edge.
  onTimeout: z.enum(['remind', 'escalate', 'expire']).default('remind'),
  escalationSelector: approverSelector.nullable().default(null),
  escalationConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  expiryHours: z.number().int().positive().max(8760).nullable().default(null),
});

export const workflowBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  enabled: z.boolean().default(true),
  /** An EMPTY list means granted immediately, and the editor says so. */
  stages: z.array(stageBody).max(10),
});
export type WorkflowBody = z.input<typeof workflowBody>;

export const submitRequestBody = z.object({
  productId: z.string().uuid(),
  subjectPersonId: z.string().uuid(),
  justification: z.string().max(4000).nullable().default(null),
  formValues: z.record(z.unknown()).default({}),
  requestedDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  replacesGrantId: z.string().uuid().nullable().default(null),
});
export type SubmitRequestBody = z.input<typeof submitRequestBody>;

export const decideRequestBody = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().max(4000).nullable().default(null),
    shortenedToDays: z.number().int().positive().max(3650).nullable().default(null),
  })
  .refine((v) => v.decision !== 'reject' || (v.comment ?? '').trim() !== '', {
    message: 'Say why. A refusal with no reason is a request the person will raise again.',
    path: ['comment'],
  });
export type DecideRequestBody = z.input<typeof decideRequestBody>;

export const audiencePreviewBody = z.object({
  audienceCondition: opaqueJson.nullable(),
  limit: z.number().int().min(1).max(200).default(25),
});

export const resolutionPreviewBody = z.object({
  workflowId: z.string().uuid(),
  subjectPersonId: z.string().uuid(),
  productId: z.string().uuid().nullable().default(null),
});

export const sweepApplyBody = z.object({
  confirm: z.boolean().default(false),
  /** Absent means every proposed action; an empty array means none of them. */
  only: z.array(z.string().uuid()).optional(),
});

export const delegatedGrantBody = z.object({
  subjectPersonIds: z.array(z.string().uuid()).min(1),
  justification: z.string().min(1).max(4000),
  durationDays: z.number().int().positive().max(3650).nullable().default(null),
});

export const approvalDelegationBody = z.object({
  delegatorPersonId: z.string().uuid(),
  delegatePersonId: z.string().uuid(),
  category: z.string().max(120).nullable().default(null),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export const resourceDelegationBody = z.object({
  resourceType,
  resourceId: z.string().uuid(),
  delegatePersonId: z.string().uuid().nullable().default(null),
  delegateGroupId: z.string().uuid().nullable().default(null),
  capabilities: z.array(z.enum(['view_members', 'approve', 'grant', 'revoke'])).min(1),
  audienceCondition: opaqueJson.nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().default(null),
});

export const resourceOwnerBody = z.object({
  resourceType,
  resourceId: z.string().uuid(),
  ownerPersonId: z.string().uuid().nullable().default(null),
  ownerGroupId: z.string().uuid().nullable().default(null),
});

export const settingsBody = z.object({
  sweepSchedule: z.string().max(120).nullable().optional(),
  sweepThresholdPercent: z.number().int().min(0).max(100).optional(),
  perProductSweepThresholdPercent: z.number().int().min(0).max(100).optional(),
  personPopulationDropPercent: z.number().int().min(0).max(100).optional(),
  fulfilmentSlaHours: z.number().int().positive().max(8760).optional(),
  expiryWarningDays: z.array(z.number().int().positive().max(365)).max(6).optional(),
  preHireHorizonDays: z.number().int().min(0).max(365).optional(),
  maxDelegationDays: z.number().int().positive().max(3650).optional(),
  maxApprovers: z.number().int().positive().max(100).optional(),
  delegatedBulkLimit: z.number().int().positive().max(1000).optional(),
});

export const resourceParam = z.object({
  type: resourceType,
  id: z.string().uuid(),
});

export const catalogSearchQuery = z.object({
  q: z.string().max(200).default(''),
});
```

In `packages/contracts/src/index.ts`, add:

```ts
export * from './automate.js';
```

- [ ] **Step 2: Write the failing portal test**

`apps/api/src/routes/automate-portal.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createProduct,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertWorkflow,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let annaCookie: string;
let boCookie: string;
let productId: string;
let annaPersonId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function signIn(login: string) {
  const login_ = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  return login_.cookies.find((c) => c.name === 'syntra_session')!.value;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const anna = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    const annaUser = await createUser(tx, {
      login: 'anna',
      email: 'anna@acme.test',
      displayName: 'Anna Novak',
    });
    await tx.user.update({ where: { id: annaUser.id }, data: { personId: anna.id } });
    await setPasswordHash(tx, annaUser.id, PASSWORD_HASH);

    const bo = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Bo', familyName: 'Lind' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: bo.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Facilities',
      },
    });
    const boUser = await createUser(tx, {
      login: 'bo',
      email: 'bo@acme.test',
      displayName: 'Bo Lind',
    });
    await tx.user.update({ where: { id: boUser.id }, data: { personId: bo.id } });
    await setPasswordHash(tx, boUser.id, PASSWORD_HASH);

    const application = await tx.application.create({
      data: { tenantId: ctx.tenantId, name: 'Stats', slug: 'stats' },
    });
    return { annaPersonId: anna.id, applicationId: application.id };
  });
  annaPersonId = seeded.annaPersonId;

  const workflow = await upsertWorkflow(ctx.tenantId, null, null, {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });
  productId = (
    await createProduct(ctx.tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: seeded.applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: workflow.id,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: null,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;

  annaCookie = await signIn('anna');
  boCookie = await signIn('bo');
});

const call = (
  method: 'GET' | 'POST',
  url: string,
  cookie: string,
  payload?: object,
) => {
  const headers = { host: ctx.host, cookie: `syntra_session=${cookie}` };
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

/**
 * Enumerated as a table over the route list, so a route added later without
 * the resolver fails a test rather than shipping.
 *
 * Every read path in spec section 6: the list, the category browse, the
 * search, the typeahead, the detail endpoint, the on-behalf picker, and the
 * form's option lists. A product the caller's audience does not admit is 404
 * from every one of them -- never 403, which confirms the thing exists.
 */
describe('visibility, on every read path', () => {
  const READ_PATHS = (id: string) => [
    { name: 'catalog list', url: '/api/portal/automate/catalog' },
    { name: 'category browse', url: '/api/portal/automate/catalog?category=Finance' },
    { name: 'search', url: '/api/portal/automate/catalog/search?q=statistic' },
    { name: 'typeahead', url: '/api/portal/automate/catalog/search?q=stat' },
    { name: 'detail', url: `/api/portal/automate/catalog/${id}` },
    { name: 'form options', url: `/api/portal/automate/catalog/${id}/form` },
  ];

  it('shows the product on every path to somebody the audience admits', async () => {
    for (const path of READ_PATHS(productId)) {
      const response = await call('GET', path.url, annaCookie);
      expect(response.statusCode, path.name).toBe(200);
      expect(JSON.stringify(response.json()), path.name).toContain('Statistics licence');
    }
  });

  it('shows nothing, and answers 404 rather than 403, to somebody it does not', async () => {
    for (const path of READ_PATHS(productId)) {
      const response = await call('GET', path.url, boCookie);
      if (response.statusCode === 200) {
        // The list paths answer 200 with an empty list; the id paths answer
        // 404. Neither may name the product.
        expect(JSON.stringify(response.json()), path.name).not.toContain(
          'Statistics licence',
        );
      } else {
        expect(response.statusCode, path.name).toBe(404);
      }
    }
  });

  it('shows the SUBJECT catalog to an on-behalf submitter, not the submitter own', async () => {
    // The permission is to act for somebody, not to see everything.
    await withTenant(ctx.tenantId, async (tx) => {
      const role = await createRole(tx, 'Helpdesk', ['automate.request_on_behalf']);
      const bo = await tx.user.findFirstOrThrow({ where: { login: 'bo' } });
      await assignRole(tx, bo.id, role.id);
    });
    const response = await call(
      'GET',
      `/api/portal/automate/catalog?subjectPersonId=${annaPersonId}`,
      boCookie,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).toContain('Statistics licence');
  });

  it('refuses the on-behalf picker to somebody without the permission', async () => {
    const response = await call(
      'GET',
      `/api/portal/automate/catalog?subjectPersonId=${annaPersonId}`,
      boCookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('requests', () => {
  it('submits, fulfils immediately, and appears in my requests', async () => {
    const created = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'fulfilled' });

    const mine = await call('GET', '/api/portal/automate/requests', annaCookie);
    expect(mine.json().requests).toHaveLength(1);
  });

  it('answers a refusal as a 422 with the reason, not a 500', async () => {
    const response = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(response.statusCode).toBe(201);
    const again = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().type).toContain('already_held');
  });

  it('does not let one person read another request', async () => {
    const created = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const id = created.json().requestId;
    const response = await call('GET', `/api/portal/automate/requests/${id}`, boCookie);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a portal session on an administration route', async () => {
    const response = await call('GET', '/api/admin/automate/requests', annaCookie);
    expect(response.statusCode).toBe(403);
  });
});

describe('my access', () => {
  it('lists grants and hands one back', async () => {
    await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const grants = await call('GET', '/api/portal/automate/grants', annaCookie);
    expect(grants.json().grants).toHaveLength(1);
    const grantId = grants.json().grants[0].id;

    const handed = await call(
      'POST',
      `/api/portal/automate/grants/${grantId}/hand-back`,
      annaCookie,
    );
    expect(handed.statusCode).toBe(204);
    const after = await withTenant(ctx.tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
    );
    expect(after.status).toBe('revoked');
  });

  it('refuses to hand back somebody else grant', async () => {
    await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const grants = await call('GET', '/api/portal/automate/grants', annaCookie);
    const grantId = grants.json().grants[0].id;
    const response = await call(
      'POST',
      `/api/portal/automate/grants/${grantId}/hand-back`,
      boCookie,
    );
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Write the portal routes**

`apps/api/src/routes/automate-portal.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idParam } from '@syntra/contracts';
import {
  catalogSearchQuery,
  decideRequestBody,
  delegatedGrantBody,
  resourceParam,
  submitRequestBody,
} from '@syntra/contracts';
import {
  DecisionRefusedError,
  DelegationRefusedError,
  PERMISSIONS,
  cancelRequest,
  delegatedGrant,
  delegatedRevoke,
  findVisibleProduct,
  handBackGrant,
  hasPermission,
  recordDecision,
  resourcesManagedBy,
  searchVisibleProducts,
  submitRequest,
  visibleProducts,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';

export interface AutomatePortalRouteOptions {
  publicUrl: string;
}

export async function registerAutomatePortalRoutes(
  app: FastifyInstance,
  options: AutomatePortalRouteOptions,
): Promise<void> {
  // A portal session is enough for everything here. Delegated administration
  // is a PORTAL surface by design: no /api/admin, no administrative scope, no
  // step-up MFA. That is the entire point of the feature.
  app.addHook('preHandler', requireSession('portal'));

  /** The person behind the signed-in account, which every route below needs. */
  const personFor = async (request: FastifyRequest): Promise<string> => {
    const user = await request.db((tx) =>
      tx.user.findUnique({
        where: { id: request.session.userId },
        select: { personId: true },
      }),
    );
    if (user?.personId == null) {
      throw new ProblemError(
        403,
        'no-person',
        'Not available to you',
        'This account is not linked to a person record, so it cannot ask for anything or hold anything.',
      );
    }
    return user.personId;
  };

  /**
   * Whose catalog this is.
   *
   * The catalog shown to a submitter acting for somebody else is the
   * SUBJECT's, not the submitter's. Anybody but the subject's own manager
   * needs `automate.request_on_behalf`.
   */
  const subjectFor = async (
    request: FastifyRequest,
    requested: string | undefined,
  ): Promise<string> => {
    const self = await personFor(request);
    if (requested === undefined || requested === self) return self;

    const allowed = await request.db(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { personId: requested },
        select: { managerPersonId: true },
      });
      if (contracts.some((c) => c.managerPersonId === self)) return true;
      return hasPermission(tx, request.session.userId, PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF);
    });
    if (!allowed) {
      throw new ProblemError(
        403,
        'forbidden',
        'Forbidden',
        'You can ask for things for yourself and for the people who report to you.',
      );
    }
    return requested;
  };

  app.get('/automate/catalog', async (request) => {
    const query = request.query as { subjectPersonId?: string; category?: string };
    const subjectPersonId = await subjectFor(request, query.subjectPersonId);
    const products = await request.db((tx) => visibleProducts(tx, subjectPersonId));
    const filtered =
      query.category === undefined
        ? products
        : products.filter((p) => p.category === query.category);
    return {
      products: filtered.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        category: p.category,
        iconUrl: p.iconUrl,
        kind: p.kind,
        durationMode: p.durationMode,
        maxDurationDays: p.maxDurationDays,
      })),
    };
  });

  // Static path, registered before the parametric one. find-my-way prefers a
  // static segment regardless of order, but the reading order should not
  // depend on knowing that.
  app.get('/automate/catalog/search', async (request) => {
    const query = request.query as { subjectPersonId?: string; q?: string };
    const { q } = catalogSearchQuery.parse(request.query);
    const subjectPersonId = await subjectFor(request, query.subjectPersonId);
    const products = await request.db((tx) => searchVisibleProducts(tx, subjectPersonId, q));
    return { products: products.map((p) => ({ id: p.id, name: p.name, slug: p.slug })) };
  });

  app.get('/automate/catalog/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const subjectPersonId = await subjectFor(
      request,
      (request.query as { subjectPersonId?: string }).subjectPersonId,
    );
    const product = await request.db((tx) => findVisibleProduct(tx, subjectPersonId, id));
    // 404, never 403. A 403 confirms the thing exists, and the existence of a
    // product name is itself information about the organization.
    if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
    return product;
  });

  app.get('/automate/catalog/:id/form', async (request) => {
    const { id } = idParam.parse(request.params);
    const subjectPersonId = await subjectFor(
      request,
      (request.query as { subjectPersonId?: string }).subjectPersonId,
    );
    const product = await request.db((tx) => findVisibleProduct(tx, subjectPersonId, id));
    if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
    const grants = await request.db((tx) =>
      tx.productGrant.findMany({ where: { productId: id } }),
    );
    return {
      name: product.name,
      requestInstructions: product.requestInstructions,
      formSchema: product.formSchema,
      durationMode: product.durationMode,
      defaultDurationDays: product.defaultDurationDays,
      maxDurationDays: product.maxDurationDays,
      resources: grants.map((g) => ({
        id: g.id,
        resourceType: g.resourceType,
        resourceId: g.resourceId,
        optional: g.optional,
      })),
    };
  });

  app.post('/automate/requests', async (request, reply) => {
    const body = submitRequestBody.parse(request.body);
    const subjectPersonId = await subjectFor(request, body.subjectPersonId);
    const outcome = await submitRequest(
      request.tenantId,
      {
        productId: body.productId,
        subjectPersonId,
        requestedByUserId: request.session.userId,
        justification: body.justification,
        formValues: body.formValues,
        requestedDurationDays: body.requestedDurationDays,
        replacesGrantId: body.replacesGrantId,
      },
      { scheduler: null, publicUrl: options.publicUrl },
    );
    if (!outcome.ok) {
      // 422, not 400: the request was well-formed and was refused on its
      // merits, and the reason is the thing the requester needs.
      throw new ProblemError(422, outcome.reason, 'Cannot be requested', outcome.message);
    }
    return reply.status(201).send(outcome);
  });

  app.get('/automate/requests', async (request) => {
    const personId = await personFor(request);
    const requests = await request.db((tx) =>
      tx.accessRequest.findMany({
        where: {
          OR: [{ subjectPersonId: personId }, { requestedByPersonId: personId }],
        },
        include: { product: { select: { name: true } }, items: true },
        orderBy: { submittedAt: 'desc' },
      }),
    );
    return { requests };
  });

  app.get('/automate/requests/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const personId = await personFor(request);
    const found = await request.db((tx) =>
      tx.accessRequest.findFirst({
        where: {
          id,
          OR: [{ subjectPersonId: personId }, { requestedByPersonId: personId }],
        },
        include: {
          product: { select: { name: true } },
          items: true,
          steps: {
            include: { approvers: true, decisions: true },
            orderBy: { sequence: 'asc' },
          },
        },
      }),
    );
    if (found === null) throw new ProblemError(404, 'not-found', 'Not found');
    const notifications = await request.db((tx) =>
      tx.notificationOutbox.findMany({
        where: { requestId: id },
        select: { template: true, to: true, sentAt: true, attempts: true, lastError: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // The timeline is assembled from the same rows the audit log records, so
    // what the requester reads and what an auditor reads cannot disagree.
    return { ...found, notifications };
  });

  app.post('/automate/requests/:id/cancel', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await cancelRequest(request.tenantId, id, request.session.userId, {
        publicUrl: options.publicUrl,
      });
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        throw new ProblemError(409, cause.code, 'Cannot be withdrawn', cause.message);
      }
      throw cause;
    }
    return reply.status(204).send();
  });

  app.get('/automate/approvals', async (request) => {
    const personId = await personFor(request);
    const steps = await request.db((tx) =>
      tx.approvalStep.findMany({
        where: { status: 'open', approvers: { some: { personId } } },
        include: {
          request: { include: { product: { select: { name: true } }, items: true } },
        },
        orderBy: { openedAt: 'asc' },
      }),
    );
    // An approver sees the product name and description for requests routed to
    // them whether or not their own audience admits the product: being routed
    // the decision IS the authorisation. It is not a general catalog read.
    return { approvals: steps };
  });

  app.post('/automate/approvals/:id/decide', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = decideRequestBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await recordDecision(
        request.tenantId,
        {
          requestId: id,
          deciderPersonId: personId,
          deciderUserId: request.session.userId,
          decision: body.decision,
          comment: body.comment,
          shortenedToDays: body.shortenedToDays,
          sourceIp: request.ip,
        },
        { scheduler: null, publicUrl: options.publicUrl },
      );
      return reply.status(200).send(result);
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        // 403 for the invariant, 409 for everything else: one is "you may
        // not", the other is "not now".
        const status = cause.code === 'self-approval' || cause.code === 'not-an-approver' ? 403 : 409;
        throw new ProblemError(status, cause.code, 'Cannot be decided', cause.message);
      }
      throw cause;
    }
  });

  app.get('/automate/grants', async (request) => {
    const personId = await personFor(request);
    const grants = await request.db((tx) =>
      tx.accessGrant.findMany({
        where: { subjectPersonId: personId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return { grants };
  });

  app.post('/automate/grants/:id/hand-back', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const personId = await personFor(request);
    const grant = await request.db((tx) =>
      tx.accessGrant.findFirst({ where: { id, subjectPersonId: personId } }),
    );
    if (grant === null) throw new ProblemError(404, 'not-found', 'Not found');
    await handBackGrant(request.tenantId, request.session.userId, id, {
      scheduler: null,
      publicUrl: options.publicUrl,
    });
    return reply.status(204).send();
  });

  app.get('/automate/managed-resources', async (request) => {
    const personId = await personFor(request);
    const managed = await request.db((tx) => resourcesManagedBy(tx, personId, new Date()));
    return { resources: managed };
  });

  app.get('/automate/managed-resources/:type/:id/members', async (request) => {
    const { type, id } = resourceParam.parse(request.params);
    const personId = await personFor(request);
    const managed = await request.db((tx) => resourcesManagedBy(tx, personId, new Date()));
    const delegation = managed.find((m) => m.resourceType === type && m.resourceId === id);
    if (delegation === undefined || !delegation.capabilities.includes('view_members')) {
      throw new ProblemError(404, 'not-found', 'Not found');
    }
    const grants = await request.db((tx) =>
      tx.accessGrant.findMany({
        where: {
          resourceType: type,
          resourceId: id,
          status: { in: ['scheduled', 'pending', 'active'] },
        },
      }),
    );
    return { members: grants, capabilities: delegation.capabilities };
  });

  app.post('/automate/managed-resources/:type/:id/grant', async (request, reply) => {
    const { type, id } = resourceParam.parse(request.params);
    const body = delegatedGrantBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await delegatedGrant(
        request.tenantId,
        {
          actingPersonId: personId,
          actingUserId: request.session.userId,
          resourceType: type,
          resourceId: id,
          subjectPersonIds: body.subjectPersonIds,
          justification: body.justification,
          durationDays: body.durationDays,
        },
        { scheduler: null, publicUrl: options.publicUrl },
      );
      return reply.status(201).send(result);
    } catch (cause) {
      if (cause instanceof DelegationRefusedError) {
        const status = cause.code === 'not-permitted' ? 404 : 422;
        throw new ProblemError(status, cause.code, 'Cannot be granted', cause.message);
      }
      throw cause;
    }
  });

  app.post('/automate/managed-resources/:type/:id/revoke', async (request, reply) => {
    const { type, id } = resourceParam.parse(request.params);
    const body = delegatedGrantBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await delegatedRevoke(
        request.tenantId,
        {
          actingPersonId: personId,
          actingUserId: request.session.userId,
          resourceType: type,
          resourceId: id,
          subjectPersonIds: body.subjectPersonIds,
        },
        { scheduler: null, publicUrl: options.publicUrl },
      );
      return reply.status(200).send(result);
    } catch (cause) {
      if (cause instanceof DelegationRefusedError) {
        const status = cause.code === 'not-permitted' ? 404 : 422;
        throw new ProblemError(status, cause.code, 'Cannot be removed', cause.message);
      }
      throw cause;
    }
  });

  app.get('/automate/delegations', async (request) => {
    const personId = await personFor(request);
    const delegations = await request.db((tx) =>
      tx.approvalDelegation.findMany({
        where: {
          revokedAt: null,
          OR: [{ delegatorPersonId: personId }, { delegatePersonId: personId }],
        },
        orderBy: { startsAt: 'desc' },
      }),
    );
    return { delegations };
  });
}
```

- [ ] **Step 4: Write the failing administration test**

`apps/api/src/routes/admin/automate.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let readOnlyCookie: string;
let workflowId: string;
let applicationId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function elevated(login: string) {
  const signed = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const portal = signed.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return up.cookies.find((c) => c.name === 'syntra_session')!.value;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada',
    });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    await assignRole(tx, admin.id, (await createRole(tx, 'Owner', ALL_PERMISSIONS)).id);

    const reader = await createUser(tx, {
      login: 'reader',
      email: 'reader@acme.test',
      displayName: 'Rea',
    });
    await setPasswordHash(tx, reader.id, PASSWORD_HASH);
    await assignRole(
      tx,
      reader.id,
      (await createRole(tx, 'Reader', [PERMISSIONS.AUTOMATE_READ])).id,
    );

    const application = await tx.application.create({
      data: { tenantId: ctx.tenantId, name: 'Stats', slug: 'stats' },
    });
    applicationId = application.id;
  });

  adminCookie = await elevated('admin');
  readOnlyCookie = await elevated('reader');

  const workflow = await call('POST', '/api/admin/automate/workflows', {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });
  workflowId = workflow.json().id;
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  cookie = adminCookie,
) => {
  const headers = { host: ctx.host, cookie: `syntra_session=${cookie}` };
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

const productPayload = (over: Record<string, unknown> = {}) => ({
  name: 'Statistics licence',
  slug: 'statistics-licence',
  kind: 'application',
  grants: [{ resourceType: 'application', resourceId: applicationId }],
  audienceCondition: { all: [] },
  workflowId,
  formSchema: [],
  durationMode: 'permanent',
  status: 'active',
  ...over,
});

describe('products', () => {
  it('creates one and lists it', async () => {
    expect((await call('POST', '/api/admin/automate/products', productPayload())).statusCode).toBe(
      201,
    );
    const list = await call('GET', '/api/admin/automate/products');
    expect(list.json().products).toHaveLength(1);
  });

  it('turns a refused configuration into a 422 naming the code', async () => {
    const syncedGroupId = await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Corporate LDAP',
          type: 'ldap',
          config: {},
          secretName: 's/l',
        },
      });
      const group = await tx.group.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Domain Users',
          sourceId: source.id,
          sourceAnchor: 'g1',
        },
      });
      return group.id;
    });
    const response = await call(
      'POST',
      '/api/admin/automate/products',
      productPayload({
        slug: 'domain-users',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: syncedGroupId }],
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().type).toContain('group-is-synced');
    expect(response.json().detail).toContain('Corporate LDAP');
  });

  it('refuses a write from somebody holding only automate.read', async () => {
    const response = await call(
      'POST',
      '/api/admin/automate/products',
      productPayload({ slug: 'other' }),
      readOnlyCookie,
    );
    expect(response.statusCode).toBe(403);
  });

  it('allows a read from somebody holding only automate.read', async () => {
    expect((await call('GET', '/api/admin/automate/products', undefined, readOnlyCookie)).statusCode).toBe(
      200,
    );
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/automate/products',
      headers: { host: ctx.host },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('previews', () => {
  it('answers the audience preview with a count and a sample', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01T00:00:00Z'),
        },
      });
    });
    const response = await call('POST', '/api/admin/automate/products/audience-preview', {
      audienceCondition: { all: [] },
      limit: 5,
    });
    expect(response.json()).toMatchObject({ matched: 1, total: 1 });
  });

  it('answers the workflow resolution preview stage by stage', async () => {
    const personId = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01T00:00:00Z'),
        },
      });
      return person.id;
    });
    const response = await call('POST', '/api/admin/automate/workflows/resolution-preview', {
      workflowId,
      subjectPersonId: personId,
      productId: null,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stages).toEqual([]);
  });
});

describe('workflows', () => {
  it('turns a refused workflow into a 422 naming the field', async () => {
    const response = await call('POST', '/api/admin/automate/workflows', {
      name: 'Broken',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Manager',
          selector: 'manager',
          selectorConfig: {},
          quorum: 'any',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'remind',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().type).toContain('fallback-required');
  });

  it('refuses onTimeout: approve at the edge, before it reaches the domain', async () => {
    const response = await call('POST', '/api/admin/automate/workflows', {
      name: 'Auto',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Manager',
          selector: 'person',
          selectorConfig: { personId: '00000000-0000-0000-0000-000000000001' },
          quorum: 'any',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'approve',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('sweeps', () => {
  it('previews, refuses to apply without a confirmation, then applies with one', async () => {
    const preview = await call('POST', '/api/admin/automate/sweeps');
    expect(preview.statusCode).toBe(201);
    const sweepId = preview.json().id;

    const unconfirmed = await call('POST', `/api/admin/automate/sweeps/${sweepId}/apply`, {
      confirm: false,
    });
    expect(unconfirmed.json().applied).toBe(0);

    const confirmed = await call('POST', `/api/admin/automate/sweeps/${sweepId}/apply`, {
      confirm: true,
    });
    expect(confirmed.statusCode).toBe(200);
    const sweep = await withTenant(ctx.tenantId, (tx) =>
      tx.expirySweep.findUniqueOrThrow({ where: { id: sweepId } }),
    );
    // The confirming user is recorded on the run. The scheduler never confirms
    // anything, and neither does an anonymous call.
    expect(sweep.confirmedByUserId).not.toBeNull();
  });

  it('refuses a sweep confirmation from somebody holding only automate.read', async () => {
    const preview = await call('POST', '/api/admin/automate/sweeps');
    const response = await call(
      'POST',
      `/api/admin/automate/sweeps/${preview.json().id}/apply`,
      { confirm: true },
      readOnlyCookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('does not show one tenant products to another', async () => {
    // The policy is what makes this empty, and the route never writes a tenant
    // filter of its own.
    await call('POST', '/api/admin/automate/products', productPayload());
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const products = await withTenant(other.id, (tx) => tx.product.findMany());
    expect(products).toEqual([]);
  });
});
```

- [ ] **Step 5: Write the administration routes**

`apps/api/src/routes/admin/automate.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { idParam } from '@syntra/contracts';
import {
  approvalDelegationBody,
  audiencePreviewBody,
  productBody,
  resolutionPreviewBody,
  resourceDelegationBody,
  resourceOwnerBody,
  settingsBody,
  sweepApplyBody,
  workflowBody,
} from '@syntra/contracts';
import {
  DecisionRefusedError,
  DelegationRefusedError,
  PERMISSIONS,
  ProductConfigurationError,
  WorkflowConfigurationError,
  applyExpirySweep,
  automateSettings,
  createApprovalDelegation,
  createProduct,
  endApprovalDelegation,
  listAllProducts,
  previewAudience,
  previewExpirySweep,
  previewWorkflowResolution,
  recordDecision,
  revokeGrant,
  updateAutomateSettings,
  updateProduct,
  upsertResourceDelegation,
  upsertResourceOwner,
  upsertWorkflow,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface AdminAutomateRouteOptions {
  publicUrl: string;
}

/**
 * Turns the domain's refusals into RFC 9457 problems.
 *
 * 422 rather than 400: the body was well-formed and the configuration was
 * refused on its merits. The `code` becomes the problem type so the console
 * can put the message against the field that caused it.
 */
function asProblem(cause: unknown): never {
  if (
    cause instanceof ProductConfigurationError ||
    cause instanceof WorkflowConfigurationError ||
    cause instanceof DelegationRefusedError
  ) {
    throw new ProblemError(422, cause.code, 'Cannot be saved', cause.message);
  }
  throw cause;
}

export async function registerAdminAutomateRoutes(
  app: FastifyInstance,
  options: AdminAutomateRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/automate/products',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => ({ products: await request.db((tx) => listAllProducts(tx)) }),
  );

  app.post(
    '/automate/products/audience-preview',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const body = audiencePreviewBody.parse(request.body);
      return previewAudience(
        request.tenantId,
        body.audienceCondition as never,
        body.limit,
      );
    },
  );

  app.post(
    '/automate/products',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = productBody.parse(request.body);
      try {
        const created = await createProduct(request.tenantId, request.session.userId, {
          ...body,
          audienceCondition: body.audienceCondition as never,
          formSchema: body.formSchema as never,
          grants: body.grants,
        });
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.put(
    '/automate/products/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = productBody.parse(request.body);
      try {
        await updateProduct(request.tenantId, request.session.userId, id, {
          ...body,
          audienceCondition: body.audienceCondition as never,
          formSchema: body.formSchema as never,
          grants: body.grants,
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/workflows',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = workflowBody.parse(request.body);
      try {
        const created = await upsertWorkflow(
          request.tenantId,
          request.session.userId,
          null,
          body,
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.put(
    '/automate/workflows/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = workflowBody.parse(request.body);
      try {
        await upsertWorkflow(request.tenantId, request.session.userId, id, body);
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/workflows/resolution-preview',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const body = resolutionPreviewBody.parse(request.body);
      const stages = await previewWorkflowResolution(
        request.tenantId,
        body.workflowId,
        body.subjectPersonId,
        body.productId,
      );
      return { stages };
    },
  );

  app.get(
    '/automate/requests',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const query = request.query as { status?: string; productId?: string };
      const requests = await request.db((tx) =>
        tx.accessRequest.findMany({
          where: {
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.productId === undefined ? {} : { productId: query.productId }),
          },
          include: { product: { select: { name: true } }, items: true },
          // Leading with the ones that are stuck.
          orderBy: [{ status: 'asc' }, { submittedAt: 'asc' }],
          take: 200,
        }),
      );
      return { requests };
    },
  );

  app.get(
    '/automate/requests/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const found = await request.db((tx) =>
        tx.accessRequest.findUnique({
          where: { id },
          include: {
            product: true,
            items: true,
            steps: {
              include: { approvers: true, decisions: true },
              orderBy: { sequence: 'asc' },
            },
          },
        }),
      );
      if (found === null) throw new ProblemError(404, 'not-found', 'Not found');
      const notifications = await request.db((tx) =>
        tx.notificationOutbox.findMany({ where: { requestId: id } }),
      );
      return { ...found, notifications };
    },
  );

  app.post(
    '/automate/requests/:id/decide',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = (request.body ?? {}) as { decision: 'approve' | 'reject'; comment: string };
      const person = await request.db((tx) =>
        tx.user.findUnique({
          where: { id: request.session.userId },
          select: { personId: true },
        }),
      );
      if (person?.personId == null) {
        throw new ProblemError(
          403,
          'no-person',
          'Forbidden',
          'Deciding a request requires an account linked to a person.',
        );
      }
      try {
        // Subject to the invariant like every other decision. An administrator
        // is not exempt from it; they are exempt from being on the step.
        const result = await recordDecision(
          request.tenantId,
          {
            requestId: id,
            deciderPersonId: person.personId,
            deciderUserId: request.session.userId,
            decision: body.decision,
            comment: body.comment ?? null,
            shortenedToDays: null,
            sourceIp: request.ip,
          },
          { asAdministrator: true, scheduler: null, publicUrl: options.publicUrl },
        );
        return reply.status(200).send(result);
      } catch (cause) {
        if (cause instanceof DecisionRefusedError) {
          const status = cause.code === 'self-approval' ? 403 : 409;
          throw new ProblemError(status, cause.code, 'Cannot be decided', cause.message);
        }
        throw cause;
      }
    },
  );

  app.get(
    '/automate/sweeps',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => ({
      sweeps: await request.db((tx) =>
        tx.expirySweep.findMany({ orderBy: { startedAt: 'desc' }, take: 50 }),
      ),
    }),
  );

  app.get(
    '/automate/sweeps/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const sweep = await request.db((tx) =>
        tx.expirySweep.findUnique({
          where: { id },
          include: { actions: true, exceptions: true },
        }),
      );
      if (sweep === null) throw new ProblemError(404, 'not-found', 'Not found');
      return sweep;
    },
  );

  app.post(
    '/automate/sweeps',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) =>
      reply
        .status(201)
        .send(await previewExpirySweep(request.tenantId, { publicUrl: options.publicUrl })),
  );

  app.post(
    '/automate/sweeps/:id/apply',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = sweepApplyBody.parse(request.body ?? {});
      return applyExpirySweep(request.tenantId, id, {
        confirm: body.confirm,
        confirmedByUserId: request.session.userId,
        ...(body.only === undefined ? {} : { only: body.only }),
        scheduler: null,
        publicUrl: options.publicUrl,
      });
    },
  );

  app.get(
    '/automate/settings',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => request.db((tx) => automateSettings(tx)),
  );

  app.put(
    '/automate/settings',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = settingsBody.parse(request.body);
      await updateAutomateSettings(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  app.put(
    '/automate/resource-owners',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = resourceOwnerBody.parse(request.body);
      await upsertResourceOwner(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/resource-delegations',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = resourceDelegationBody.parse(request.body);
      try {
        const created = await upsertResourceDelegation(
          request.tenantId,
          request.session.userId,
          { ...body, audienceCondition: body.audienceCondition as never },
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.post(
    '/automate/approval-delegations',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = approvalDelegationBody.parse(request.body);
      try {
        const created = await createApprovalDelegation(
          request.tenantId,
          request.session.userId,
          body,
          { publicUrl: options.publicUrl },
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.delete(
    '/automate/approval-delegations/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await endApprovalDelegation(request.tenantId, request.session.userId, id, {
        publicUrl: options.publicUrl,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/grants/:id/revoke',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = (request.body ?? {}) as { reason?: string };
      await revokeGrant(
        request.tenantId,
        request.session.userId,
        id,
        body.reason ?? 'withdrawn by an administrator',
        { scheduler: null, publicUrl: options.publicUrl },
      );
      return reply.status(204).send();
    },
  );
}
```

- [ ] **Step 6: Register both plugins**

In `apps/api/src/app.ts`:

```ts
import { registerAutomatePortalRoutes } from './routes/automate-portal.js';
import { registerAdminAutomateRoutes } from './routes/admin/automate.js';
```

After `registerAdminUpstreamRoutes`:

```ts
  await app.register(registerAdminAutomateRoutes, {
    prefix: '/api/admin',
    publicUrl: config.publicUrl,
  });
```

After `registerPortalRoutes`:

```ts
  await app.register(registerAutomatePortalRoutes, {
    prefix: '/api/portal',
    publicUrl: config.publicUrl,
  });
```

Registered as its own plugin rather than added to `portal.ts`, so the `preHandler` hook and the rate limits of the launch routes stay where they are. Fastify encapsulates hooks per plugin, and `registerPortalRoutes` already adds a `preHandler` of its own.

- [ ] **Step 7: Run both route tests**

Run: `pnpm vitest run apps/api/src/routes/automate-portal.test.ts apps/api/src/routes/admin/automate.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/automate.ts packages/contracts/src/index.ts \
        apps/api/src/routes/automate-portal.ts apps/api/src/routes/admin/automate.ts \
        apps/api/src/routes/automate-portal.test.ts apps/api/src/routes/admin/automate.test.ts \
        apps/api/src/app.ts
git commit -m "feat(automate): the portal and administration HTTP surface"
```

---

## Task 17: The portal — catalog, requests, approvals, access, managed resources

Spec §17's end-user surface. **Read `apps/web/src/pages/Portal.tsx` and `apps/web/src/pages/admin/SyncRunsPage.tsx` before writing any of this.** They establish every convention these screens follow:

- `import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui'` — those are the real exports of `packages/ui/src/index.ts`. `Alert` takes `tone: 'info' | 'warning' | 'danger'`; `Status` takes `tone: 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary'`; `Field` takes `label`, `value`, `onChange(value: string)`, `hint`, `error`.
- `import { api, ApiError } from '../../session/api.js'` — `api<T>(path, init?: RequestInit)`. There is no `apiFetch` anywhere in this repository.
- `import { useApiResource } from '../../session/use-api-resource.js'` — `{ data, error, loading, reload }`.
- `import { AppShell } from '../../components/AppShell.js'` for a top-level portal page.
- Portal routes are added to `apps/web/src/routes.tsx` inside `<RequireSession scope="portal">`; console routes go in `AdminApp.tsx` and are **relative**.

**Files:**
- Create: `apps/web/src/pages/automate/CatalogPage.tsx`
- Create: `apps/web/src/pages/automate/RequestFormPage.tsx`
- Create: `apps/web/src/pages/automate/MyRequestsPage.tsx`
- Create: `apps/web/src/pages/automate/RequestDetailPage.tsx`
- Create: `apps/web/src/pages/automate/MyAccessPage.tsx`
- Create: `apps/web/src/pages/automate/MyApprovalsPage.tsx`
- Create: `apps/web/src/pages/automate/ManagedResourcesPage.tsx`
- Create: `apps/web/src/pages/automate/status.ts`
- Modify: `apps/web/src/routes.tsx`
- Test: `apps/web/src/pages/automate/MyApprovalsPage.test.tsx`, `apps/web/src/pages/automate/CatalogPage.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `../../session/api.js`; `useApiResource` from `../../session/use-api-resource.js`; `AppShell` from `../../components/AppShell.js`; `Alert`, `Button`, `Empty`, `Field`, `Panel`, `SkeletonRows`, `Status` from `@syntra/ui`; `Link`, `useNavigate`, `useParams` from `react-router-dom`. The endpoints of Task 16.
- Produces: seven route components, and `REQUEST_TONE` / `REQUEST_LABEL` / `GRANT_TONE` / `GRANT_LABEL` in `status.ts`, which the console reuses in Task 18.

- [ ] **Step 1: Write the shared status vocabulary**

`apps/web/src/pages/automate/status.ts`:

```ts
type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

/**
 * The statuses that mean somebody has to do something are the loud ones.
 * `blocked_no_approver` and `fulfilment_failed` are danger because they are
 * stuck; `awaiting_fulfilment` is primary because it is working.
 */
export const REQUEST_TONE: Record<string, Tone> = {
  pending_approval: 'primary',
  blocked_no_approver: 'danger',
  approved: 'primary',
  awaiting_fulfilment: 'primary',
  fulfilled: 'active',
  partially_fulfilled: 'warning',
  fulfilment_failed: 'danger',
  rejected: 'inactive',
  cancelled: 'neutral',
  expired: 'warning',
};

export const REQUEST_LABEL: Record<string, string> = {
  pending_approval: 'Waiting for approval',
  blocked_no_approver: 'Nobody can approve this',
  approved: 'Approved',
  awaiting_fulfilment: 'Approved, being applied',
  fulfilled: 'Granted',
  partially_fulfilled: 'Partly granted',
  fulfilment_failed: 'Could not be applied',
  rejected: 'Refused',
  cancelled: 'Withdrawn',
  expired: 'Expired without a decision',
};

export const GRANT_TONE: Record<string, Tone> = {
  scheduled: 'neutral',
  pending: 'primary',
  active: 'active',
  expired: 'inactive',
  lapsed: 'inactive',
  revoked: 'neutral',
};

export const GRANT_LABEL: Record<string, string> = {
  scheduled: 'Starts later',
  pending: 'Being applied',
  active: 'Held',
  expired: 'Ended',
  lapsed: 'Ended with the contract',
  revoked: 'Given back',
};

export const when = (iso: string | null): string =>
  iso === null ? '—' : new Date(iso).toLocaleDateString();
```

- [ ] **Step 2: Write the failing catalog test**

`apps/web/src/pages/automate/CatalogPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CatalogPage } from './CatalogPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockCatalog(products: Record<string, unknown>[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ products })),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <CatalogPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('CatalogPage', () => {
  it('says plainly when a product is granted immediately', async () => {
    // The catalog shows such a product as "granted immediately" so the
    // requester knows BEFORE they ask.
    mockCatalog([
      {
        id: 'p1',
        name: 'Reading room',
        slug: 'reading-room',
        description: null,
        category: null,
        kind: 'application',
        durationMode: 'permanent',
        maxDurationDays: null,
        needsApproval: false,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/granted immediately/i)).toBeInTheDocument();
  });

  it('says how long a time-bounded product runs for', async () => {
    mockCatalog([
      {
        id: 'p2',
        name: 'Finance folder',
        slug: 'finance-folder',
        description: null,
        category: 'Finance',
        kind: 'targetEntitlement',
        durationMode: 'requesterChoice',
        maxDurationDays: 90,
        needsApproval: true,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/up to 90 days/i)).toBeInTheDocument();
  });

  it('shows an empty catalog as a fact rather than an error', async () => {
    // An empty catalog is what a correctly-configured tenant looks like on day
    // one, and it is what a person outside every audience sees. Neither is a
    // failure, and saying "something went wrong" would send them to support.
    mockCatalog([]);
    renderPage();
    expect(await screen.findByText(/nothing to ask for yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Write the failing approvals test**

`apps/web/src/pages/automate/MyApprovalsPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MyApprovalsPage } from './MyApprovalsPage.js';

const approvals = [
  {
    id: 'step-1',
    requestId: 'req-1',
    sequence: 1,
    openedAt: '2026-06-14T09:00:00.000Z',
    request: {
      id: 'req-1',
      subjectPersonId: 'person-1',
      justification: 'Q3 audit',
      requestedDurationDays: 30,
      product: { name: 'Statistics licence' },
      items: [{ resourceType: 'application', resourceId: 'app-1' }],
    },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(onDecide?: (body: unknown) => Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/decide')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return Promise.resolve((onDecide?.(body) ?? json({ status: 'fulfilled' })) as never);
    }
    return Promise.resolve(json({ approvals }));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <MyApprovalsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('MyApprovalsPage', () => {
  it('shows the justification, because an approver deciding without one decides badly', async () => {
    mockFetch();
    renderPage();
    expect(await screen.findByText('Q3 audit')).toBeInTheDocument();
  });

  it('will not send a rejection without a comment', async () => {
    // The server refuses it too. This is the half that tells the approver
    // before they have typed nothing and pressed a button twice.
    const sent: unknown[] = [];
    mockFetch((body) => {
      sent.push(body);
      return json({ status: 'rejected' });
    });
    renderPage();
    await screen.findByText('Q3 audit');
    await userEvent.click(screen.getByRole('button', { name: /refuse/i }));
    expect(sent).toEqual([]);
    expect(screen.getByText(/say why/i)).toBeInTheDocument();
  });

  it('sends the shortened duration when the approver shortens it', async () => {
    const sent: Record<string, unknown>[] = [];
    mockFetch((body) => {
      sent.push(body as Record<string, unknown>);
      return json({ status: 'fulfilled' });
    });
    renderPage();
    await screen.findByText('Q3 audit');
    await userEvent.clear(screen.getByLabelText(/shorten to/i));
    await userEvent.type(screen.getByLabelText(/shorten to/i), '7');
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(sent[0]).toMatchObject({ decision: 'approve', shortenedToDays: 7 });
  });
});
```

- [ ] **Step 4: Run both tests to verify they fail**

Run: `pnpm vitest run apps/web/src/pages/automate`
Expected: FAIL, "Failed to resolve import ./CatalogPage.js" and "./MyApprovalsPage.js".

- [ ] **Step 5: Write the catalog and the request form**

`apps/web/src/pages/automate/CatalogPage.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface CatalogEntry {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  kind: string;
  durationMode: string;
  maxDurationDays: number | null;
  needsApproval: boolean;
}

function durationLine(entry: CatalogEntry): string {
  if (entry.durationMode === 'permanent') return 'Held until somebody takes it away';
  if (entry.durationMode === 'fixed') return 'Held for a fixed period';
  return `You choose how long, up to ${entry.maxDurationDays ?? 0} days`;
}

export function CatalogPage() {
  const [query, setQuery] = useState('');
  const { data, error, loading } = useApiResource<{ products: CatalogEntry[] }>(
    '/api/portal/automate/catalog',
  );

  const products = (data?.products ?? []).filter((p) =>
    query.trim() === ''
      ? true
      : `${p.name} ${p.description ?? ''} ${p.category ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
  );
  const categories = [...new Set(products.map((p) => p.category ?? 'Everything else'))];

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">What can I ask for?</h1>
        <p className="mt-1 text-muted">
          Everything here is something you are allowed to request. Asking for it does not
          grant it — most things go to somebody who decides.
        </p>

        {error && (
          <div className="mt-6">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}

        {!error && (
          <>
            <div className="mt-6 max-w-md">
              <Field label="Search" value={query} onChange={setQuery} />
            </div>

            {loading && (
              <div className="mt-6">
                <Panel>
                  <SkeletonRows rows={4} cols={3} />
                </Panel>
              </div>
            )}

            {!loading && products.length === 0 && (
              <div className="mt-6">
                <Empty title="Nothing to ask for yet">
                  Either nothing has been published to you, or your search matched nothing.
                  This is not an error.
                </Empty>
              </div>
            )}

            {!loading &&
              categories.map((category) => (
                <div key={category} className="mt-6">
                  <Panel title={category}>
                    <ul className="divide-y divide-border-subtle">
                      {products
                        .filter((p) => (p.category ?? 'Everything else') === category)
                        .map((product) => (
                          <li key={product.id} className="px-4 py-3">
                            <Link
                              to={`/catalog/${product.id}`}
                              className="font-medium text-ink hover:text-primary"
                            >
                              {product.name}
                            </Link>
                            {product.description && (
                              <p className="mt-0.5 text-muted">{product.description}</p>
                            )}
                            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                              <Status tone={product.needsApproval ? 'primary' : 'active'}>
                                {product.needsApproval
                                  ? 'Needs approval'
                                  : 'Granted immediately'}
                              </Status>
                              <span>{durationLine(product)}</span>
                            </p>
                          </li>
                        ))}
                    </ul>
                  </Panel>
                </div>
              ))}
          </>
        )}
      </div>
    </AppShell>
  );
}
```

`apps/web/src/pages/automate/RequestFormPage.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface FormField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  options?: { value: string; label: string }[];
}

interface ProductForm {
  name: string;
  requestInstructions: string | null;
  formSchema: FormField[];
  durationMode: string;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  resources: { id: string; resourceType: string; resourceId: string; optional: boolean }[];
}

export function RequestFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, error, loading } = useApiResource<ProductForm>(
    id === undefined ? null : `/api/portal/automate/catalog/${id}/form`,
  );

  const [values, setValues] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState('');
  const [days, setDays] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ requestId: string }>('/api/portal/automate/requests', {
        method: 'POST',
        body: JSON.stringify({
          productId: id,
          subjectPersonId: undefined,
          justification: justification.trim() === '' ? null : justification,
          formValues: values,
          requestedDurationDays: days.trim() === '' ? null : Number(days),
        }),
      });
      navigate(`/requests/${created.requestId}`);
    } catch (cause) {
      // The refusal reasons are the useful half: "already held", "no longer
      // eligible", "beyond the cap". Showing "something went wrong" instead
      // would send somebody to support with a question the answer to was
      // already on the wire.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong sending this request.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && (
          <Panel>
            <SkeletonRows rows={4} cols={2} />
          </Panel>
        )}
        {!loading && data && (
          <Panel title={data.name} description={data.requestInstructions ?? undefined}>
            <div className="space-y-4 p-4">
              {problem && <Alert tone="warning">{problem}</Alert>}

              {data.formSchema.map((field) => (
                <div key={field.key}>
                  {field.type === 'select' || field.type === 'resourcePicker' ? (
                    <label className="block">
                      <span className="mb-1 block font-medium text-ink">{field.label}</span>
                      <select
                        className="w-full rounded-control border border-border-subtle bg-surface px-3 py-2"
                        value={values[field.key] ?? ''}
                        onChange={(event) =>
                          setValues({ ...values, [field.key]: event.target.value })
                        }
                      >
                        <option value="">Choose one</option>
                        {(field.type === 'resourcePicker'
                          ? data.resources.map((r) => ({ value: r.id, label: r.resourceId }))
                          : (field.options ?? [])
                        ).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {field.help && <span className="mt-1 block text-muted">{field.help}</span>}
                    </label>
                  ) : (
                    <Field
                      label={field.label}
                      value={values[field.key] ?? ''}
                      onChange={(value) => setValues({ ...values, [field.key]: value })}
                      {...(field.help === undefined ? {} : { hint: field.help })}
                    />
                  )}
                </div>
              ))}

              <Field
                label="Why do you need this?"
                value={justification}
                onChange={setJustification}
                hint="Whoever decides this will read exactly what you write here."
              />

              {data.durationMode === 'requesterChoice' && (
                <Field
                  label="For how many days?"
                  value={days}
                  onChange={setDays}
                  type="number"
                  hint={`Up to ${data.maxDurationDays ?? 0} days.`}
                />
              )}

              <Button variant="primary" loading={busy} onClick={submit}>
                Send the request
              </Button>
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 6: Write my requests, the request detail, and my access**

`apps/web/src/pages/automate/MyRequestsPage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from './status.js';

interface RequestRow {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  product: { name: string } | null;
}

export function MyRequestsPage() {
  const { data, error, loading } = useApiResource<{ requests: RequestRow[] }>(
    '/api/portal/automate/requests',
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">My requests</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="mt-6">
          <Panel>
            {loading && <SkeletonRows rows={4} cols={3} />}
            {!loading && (data?.requests ?? []).length === 0 && (
              <div className="p-6">
                <Empty title="You have not asked for anything yet">
                  Anything you request appears here with where it is and who it is with.
                </Empty>
              </div>
            )}
            {!loading && (data?.requests ?? []).length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {data!.requests.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <Link to={`/requests/${row.id}`} className="font-medium text-ink hover:text-primary">
                        {row.product?.name ?? 'Requested access'}
                      </Link>
                      <p className="text-sm text-muted">Asked on {when(row.submittedAt)}</p>
                      {row.statusReason && (
                        <p className="text-sm text-muted">{row.statusReason}</p>
                      )}
                    </div>
                    <Status tone={REQUEST_TONE[row.status] ?? 'neutral'}>
                      {REQUEST_LABEL[row.status] ?? row.status}
                    </Status>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
```

`apps/web/src/pages/automate/RequestDetailPage.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from './status.js';

interface Detail {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  justification: string | null;
  product: { name: string } | null;
  items: { id: string; resourceType: string; resourceId: string; status: string; message: string | null }[];
  steps: {
    id: string;
    sequence: number;
    status: string;
    openedAt: string | null;
    approvers: { personId: string; via: string }[];
    decisions: { personId: string; decision: string; comment: string | null; decidedAt: string }[];
  }[];
  notifications: { template: string; to: string; sentAt: string | null; lastError: string | null }[];
}

const CANCELLABLE = ['pending_approval', 'blocked_no_approver'];

export function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<Detail>(
    id === undefined ? null : `/api/portal/automate/requests/${id}`,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/portal/automate/requests/${id}/cancel`, { method: 'POST' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && (
          <Panel>
            <SkeletonRows rows={5} cols={2} />
          </Panel>
        )}
        {!loading && data && (
          <>
            <Panel
              title={data.product?.name ?? 'Requested access'}
              actions={
                CANCELLABLE.includes(data.status) ? (
                  <Button loading={busy} onClick={cancel}>
                    Withdraw
                  </Button>
                ) : undefined
              }
            >
              <div className="space-y-2 p-4">
                {problem && <Alert tone="warning">{problem}</Alert>}
                <Status tone={REQUEST_TONE[data.status] ?? 'neutral'}>
                  {REQUEST_LABEL[data.status] ?? data.status}
                </Status>
                {data.statusReason && <p className="text-muted">{data.statusReason}</p>}
                {data.status === 'awaiting_fulfilment' && (
                  <Alert tone="info">
                    This has been approved and is waiting to be applied to the system it
                    belongs to. Nothing more is needed from you.
                  </Alert>
                )}
                {data.justification && (
                  <p className="text-muted">You said: {data.justification}</p>
                )}
              </div>
            </Panel>

            <div className="mt-6">
              <Panel title="Approval">
                <ul className="divide-y divide-border-subtle">
                  {data.steps.map((step) => (
                    <li key={step.id} className="px-4 py-3">
                      <p className="font-medium text-ink">Stage {step.sequence}</p>
                      {/* Naming the approver is deliberate. Anonymous approval
                          makes chasing impossible and removes the social
                          accountability that makes an approver read it. */}
                      <p className="text-sm text-muted">
                        With: {step.approvers.map((a) => a.personId).join(', ') || 'nobody yet'}
                      </p>
                      {step.decisions.map((decision, index) => (
                        <p key={index} className="mt-1 text-sm text-muted">
                          {decision.decision === 'approve' ? 'Approved' : 'Refused'} by{' '}
                          {decision.personId} on {when(decision.decidedAt)}
                          {decision.comment ? ` — ${decision.comment}` : ''}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            <div className="mt-6">
              <Panel title="Messages sent about this">
                <ul className="divide-y divide-border-subtle">
                  {data.notifications.map((notification, index) => (
                    <li key={index} className="px-4 py-2 text-sm text-muted">
                      {notification.template} to {notification.to} —{' '}
                      {notification.sentAt === null
                        ? (notification.lastError ?? 'not sent yet')
                        : `sent ${when(notification.sentAt)}`}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
```

`apps/web/src/pages/automate/MyAccessPage.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { GRANT_LABEL, GRANT_TONE, when } from './status.js';

interface GrantRow {
  id: string;
  resourceType: string;
  resourceId: string;
  productId: string | null;
  status: string;
  startsAt: string;
  endsAt: string | null;
  needsReview: boolean;
  reviewReason: string | null;
}

const LIVE = ['scheduled', 'pending', 'active'];

export function MyAccessPage() {
  const { data, error, loading, reload } = useApiResource<{ grants: GrantRow[] }>(
    '/api/portal/automate/grants',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const handBack = async (grantId: string) => {
    setBusy(grantId);
    setProblem(null);
    try {
      await api(`/api/portal/automate/grants/${grantId}/hand-back`, { method: 'POST' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">My access</h1>
        <p className="mt-1 text-muted">
          Everything you hold because you asked for it. Access from your role is not listed
          here — it comes and goes with your contracts.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}

        <div className="mt-6">
          <Panel>
            {loading && <SkeletonRows rows={4} cols={4} />}
            {!loading && (data?.grants ?? []).length === 0 && (
              <div className="p-6">
                <Empty title="You hold nothing you asked for">
                  Anything granted from the catalog appears here with its end date.
                </Empty>
              </div>
            )}
            {!loading && (data?.grants ?? []).length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {data!.grants.map((grant) => (
                  <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="font-medium text-ink">{grant.resourceId}</p>
                      <p className="text-sm text-muted">
                        From {when(grant.startsAt)}
                        {grant.endsAt === null ? ', with no end date' : ` until ${when(grant.endsAt)}`}
                      </p>
                      {grant.needsReview && (
                        <p className="text-sm text-warning">
                          Flagged for review: {grant.reviewReason}. Nothing has been removed.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Status tone={GRANT_TONE[grant.status] ?? 'neutral'}>
                        {GRANT_LABEL[grant.status] ?? grant.status}
                      </Status>
                      {LIVE.includes(grant.status) && grant.endsAt !== null && grant.productId && (
                        <Link to={`/catalog/${grant.productId}`}>
                          <Button size="sm">Extend</Button>
                        </Link>
                      )}
                      {LIVE.includes(grant.status) && (
                        <Button
                          size="sm"
                          loading={busy === grant.id}
                          onClick={() => handBack(grant.id)}
                        >
                          Hand it back
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 7: Write my approvals and managed resources**

`apps/web/src/pages/automate/MyApprovalsPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { when } from './status.js';

interface Approval {
  id: string;
  requestId: string;
  sequence: number;
  openedAt: string | null;
  request: {
    id: string;
    subjectPersonId: string;
    justification: string | null;
    requestedDurationDays: number | null;
    product: { name: string } | null;
    items: { resourceType: string; resourceId: string }[];
  };
}

export function MyApprovalsPage() {
  const { data, error, loading, reload } = useApiResource<{ approvals: Approval[] }>(
    '/api/portal/automate/approvals',
  );
  const [comments, setComments] = useState<Record<string, string>>({});
  const [shorten, setShorten] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (approval: Approval, decision: 'approve' | 'reject') => {
    const comment = comments[approval.id] ?? '';
    if (decision === 'reject' && comment.trim() === '') {
      // The server refuses this too. Saying so here saves a round trip and a
      // second press of the button.
      setProblem('Say why you are refusing it. The requester will read exactly this.');
      return;
    }
    setBusy(approval.id);
    setProblem(null);
    try {
      await api(`/api/portal/automate/approvals/${approval.requestId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          comment: comment.trim() === '' ? null : comment,
          shortenedToDays:
            (shorten[approval.id] ?? '').trim() === '' ? null : Number(shorten[approval.id]),
        }),
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong recording that decision.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">Waiting for me</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}

        <div className="mt-6 space-y-6">
          {loading && (
            <Panel>
              <SkeletonRows rows={3} cols={3} />
            </Panel>
          )}
          {!loading && (data?.approvals ?? []).length === 0 && (
            <Empty title="Nothing is waiting for you">
              Requests routed to you appear here.
            </Empty>
          )}
          {!loading &&
            (data?.approvals ?? []).map((approval) => (
              <Panel
                key={approval.id}
                title={approval.request.product?.name ?? 'Requested access'}
                description={`For ${approval.request.subjectPersonId}, waiting since ${when(approval.openedAt)}`}
              >
                <div className="space-y-3 p-4">
                  <p className="text-ink">{approval.request.justification}</p>
                  <p className="text-sm text-muted">
                    Grants: {approval.request.items.map((i) => i.resourceId).join(', ')}
                  </p>
                  {approval.request.requestedDurationDays !== null && (
                    <Field
                      label={`Shorten to (days, asked for ${approval.request.requestedDurationDays})`}
                      type="number"
                      value={shorten[approval.id] ?? ''}
                      onChange={(value) => setShorten({ ...shorten, [approval.id]: value })}
                      hint="You can shorten this. You cannot lengthen it."
                    />
                  )}
                  <Field
                    label="Comment"
                    value={comments[approval.id] ?? ''}
                    onChange={(value) => setComments({ ...comments, [approval.id]: value })}
                    hint="Required if you refuse."
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      loading={busy === approval.id}
                      onClick={() => decide(approval, 'approve')}
                    >
                      Approve
                    </Button>
                    <Button
                      loading={busy === approval.id}
                      onClick={() => decide(approval, 'reject')}
                    >
                      Refuse
                    </Button>
                  </div>
                </div>
              </Panel>
            ))}
        </div>
      </div>
    </AppShell>
  );
}
```

`apps/web/src/pages/automate/ManagedResourcesPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface Managed {
  delegationId: string;
  resourceType: string;
  resourceId: string;
  capabilities: string[];
  endsAt: string | null;
}

interface Member {
  id: string;
  subjectPersonId: string;
  status: string;
  endsAt: string | null;
}

function ResourcePanel({ resource }: { resource: Managed }) {
  const path = `/api/portal/automate/managed-resources/${resource.resourceType}/${resource.resourceId}/members`;
  const { data, error, loading, reload } = useApiResource<{ members: Member[] }>(path);
  const [personId, setPersonId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (action: 'grant' | 'revoke', subjectPersonIds: string[]) => {
    setBusy(true);
    setProblem(null);
    try {
      await api(
        `/api/portal/automate/managed-resources/${resource.resourceType}/${resource.resourceId}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({
            subjectPersonIds,
            justification: 'managed from the portal',
            durationDays: null,
          }),
        },
      );
      setPersonId('');
      reload();
    } catch (cause) {
      // "That person is outside the audience for this resource" and "ask an
      // administrator for more than 25" are both messages the delegate can act
      // on, so they are shown rather than flattened.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={resource.resourceId} description={`You manage this ${resource.resourceType}`}>
      <div className="space-y-3 p-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}
        {loading && <SkeletonRows rows={3} cols={2} />}
        {!loading && (
          <ul className="divide-y divide-border-subtle">
            {(data?.members ?? []).map((member) => (
              <li key={member.id} className="flex items-center justify-between py-2">
                <span className="text-ink">{member.subjectPersonId}</span>
                {resource.capabilities.includes('revoke') && (
                  <Button size="sm" loading={busy} onClick={() => act('revoke', [member.subjectPersonId])}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {resource.capabilities.includes('grant') && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Add somebody (person id)" value={personId} onChange={setPersonId} />
            </div>
            <Button variant="primary" loading={busy} onClick={() => act('grant', [personId])}>
              Add
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function ManagedResourcesPage() {
  const { data, error, loading } = useApiResource<{ resources: Managed[] }>(
    '/api/portal/automate/managed-resources',
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">Resources you manage</h1>
        <p className="mt-1 text-muted">
          Adding and removing people here records a request in your name, exactly as if it
          had gone through the catalog.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="mt-6 space-y-6">
          {loading && (
            <Panel>
              <SkeletonRows rows={2} cols={2} />
            </Panel>
          )}
          {!loading && (data?.resources ?? []).length === 0 && (
            <Empty title="You do not manage anything yet">
              An administrator delegates a specific group or application to you, and it
              appears here.
            </Empty>
          )}
          {!loading &&
            (data?.resources ?? []).map((resource) => (
              <ResourcePanel key={resource.delegationId} resource={resource} />
            ))}
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 8: Add the portal routes**

In `apps/web/src/routes.tsx`, add the imports:

```tsx
import { CatalogPage } from './pages/automate/CatalogPage.js';
import { RequestFormPage } from './pages/automate/RequestFormPage.js';
import { MyRequestsPage } from './pages/automate/MyRequestsPage.js';
import { RequestDetailPage } from './pages/automate/RequestDetailPage.js';
import { MyAccessPage } from './pages/automate/MyAccessPage.js';
import { MyApprovalsPage } from './pages/automate/MyApprovalsPage.js';
import { ManagedResourcesPage } from './pages/automate/ManagedResourcesPage.js';
```

and, inside `<Routes>` before the `/admin/*` route, seven entries in the same shape as `/security`:

```tsx
      <Route
        path="/catalog"
        element={
          <RequireSession scope="portal">
            <CatalogPage />
          </RequireSession>
        }
      />
      <Route
        path="/catalog/:id"
        element={
          <RequireSession scope="portal">
            <RequestFormPage />
          </RequireSession>
        }
      />
      <Route
        path="/requests"
        element={
          <RequireSession scope="portal">
            <MyRequestsPage />
          </RequireSession>
        }
      />
      <Route
        path="/requests/:id"
        element={
          <RequireSession scope="portal">
            <RequestDetailPage />
          </RequireSession>
        }
      />
      <Route
        path="/access"
        element={
          <RequireSession scope="portal">
            <MyAccessPage />
          </RequireSession>
        }
      />
      <Route
        path="/approvals"
        element={
          <RequireSession scope="portal">
            <MyApprovalsPage />
          </RequireSession>
        }
      />
      <Route
        path="/managed"
        element={
          <RequireSession scope="portal">
            <ManagedResourcesPage />
          </RequireSession>
        }
      />
```

These are **portal** routes, not lazily-loaded console ones. "Resources you manage" in particular is a portal surface under an ordinary portal session — no `/api/admin`, no administrative scope, no step-up MFA, no admin chunk. That is the entire point of the feature and the reason it cannot be implemented by handing the team lead a scoped role.

- [ ] **Step 9: Run the web tests**

Run: `pnpm vitest run apps/web/src/pages/automate`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/pages/automate apps/web/src/routes.tsx
git commit -m "feat(automate): the portal catalog, requests, approvals and managed resources"
```

---

## Task 18: The console, the end-to-end path, and whole-slice verification

Spec §17's administration surface. Console routes are added to `apps/web/src/pages/admin/AdminApp.tsx` and written **relative** to `/admin`; `routes.tsx` already mounts `/admin/*` behind the elevated-session guard and is not touched here.

**Files:**
- Create: `apps/web/src/pages/admin/ProductsPage.tsx`
- Create: `apps/web/src/pages/admin/ProductEditorPage.tsx`
- Create: `apps/web/src/pages/admin/WorkflowEditorPage.tsx`
- Create: `apps/web/src/pages/admin/RequestQueuePage.tsx`
- Create: `apps/web/src/pages/admin/RequestDetailAdminPage.tsx`
- Create: `apps/web/src/pages/admin/SweepsPage.tsx`
- Create: `apps/web/src/pages/admin/SweepDetailPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx`
- Modify: `apps/web/src/pages/PersonAccessPage.tsx`
- Create: `e2e/automate.spec.ts`
- Test: `apps/web/src/pages/admin/RequestQueuePage.test.tsx`, `apps/web/src/pages/admin/SweepDetailPage.test.tsx`

**Interfaces:**
- Consumes: `useApiResource`, `fieldErrors` from `./hooks.js`; `PageHeader` from `./PageHeader.js`; `api`, `ApiError` from `../../session/api.js`; `Alert`, `Button`, `Empty`, `Field`, `Panel`, `SkeletonRows`, `Status` from `@syntra/ui`; `REQUEST_TONE`, `REQUEST_LABEL`, `GRANT_TONE`, `GRANT_LABEL`, `when` from `../automate/status.js`; the `/api/admin/automate/*` endpoints of Task 16; `PersonAccess` from Provision's Task 17, extended in Task 8 with `grantId`, `requestId` and `grantEndsAt`.
- Produces: seven console route components and eight `<Route>` entries under `/admin`.

- [ ] **Step 1: Write the failing queue test**

`apps/web/src/pages/admin/RequestQueuePage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestQueuePage } from './RequestQueuePage.js';

const requests = [
  {
    id: 'r-ok',
    status: 'pending_approval',
    submittedAt: '2026-06-14T09:00:00.000Z',
    subjectPersonId: 'p1',
    statusReason: null,
    product: { name: 'Statistics licence' },
    items: [],
  },
  {
    id: 'r-blocked',
    status: 'blocked_no_approver',
    submittedAt: '2026-06-10T09:00:00.000Z',
    subjectPersonId: 'p2',
    statusReason: 'stage 1 resolved to nobody',
    product: { name: 'Finance folder' },
    items: [],
  },
  {
    id: 'r-failed',
    status: 'fulfilment_failed',
    submittedAt: '2026-06-11T09:00:00.000Z',
    subjectPersonId: 'p3',
    statusReason: null,
    product: { name: 'Mailbox' },
    items: [{ status: 'failed', message: 'WILL_NOT_PERFORM: 0x2082', resourceId: 'e1' }],
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ requests })),
  );
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <RequestQueuePage />
    </MemoryRouter>,
  );

describe('RequestQueuePage', () => {
  it('leads with the ones that are stuck, whatever their age', async () => {
    // Blocked and failed first, then everything else. A queue ordered only by
    // date buries the two states that need a human.
    renderPage();
    const rows = await screen.findAllByRole('row');
    const text = rows.map((row) => row.textContent ?? '');
    const blocked = text.findIndex((t) => t.includes('Finance folder'));
    const failed = text.findIndex((t) => t.includes('Mailbox'));
    const ordinary = text.findIndex((t) => t.includes('Statistics licence'));
    expect(blocked).toBeLessThan(ordinary);
    expect(failed).toBeLessThan(ordinary);
  });

  it('shows the target own message on a failed fulfilment', async () => {
    // The message is the only thing that tells an administrator what to fix.
    renderPage();
    expect(await screen.findByText(/WILL_NOT_PERFORM/)).toBeInTheDocument();
  });

  it('renders blocked in the danger tone', async () => {
    renderPage();
    expect(await screen.findByText(/nobody can approve this/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write the failing sweep review test**

`apps/web/src/pages/admin/SweepDetailPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SweepDetailPage } from './SweepDetailPage.js';

const sweep = {
  id: 's1',
  status: 'previewed',
  requiresConfirmation: true,
  blockedReason:
    'Finance folder would lose 90 of its 90 holders (100.0%, threshold 50%)',
  expireCount: 90,
  lapseCount: 0,
  reviewFlagCount: 2,
  personsWithActiveContract: 1180,
  personsUnprocessable: 1,
  actions: [
    {
      id: 'a1',
      kind: 'expire',
      subjectPersonId: 'p1',
      resourceType: 'application',
      resourceId: 'app-1',
      productId: 'prod-1',
      status: 'proposed',
      message: 'the grant ended on 2026-06-01',
    },
  ],
  exceptions: [
    { id: 'x1', personId: 'p9', kind: 'no_contracts', message: 'this person holds no contract at all' },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(onApply?: (body: unknown) => void) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/apply')) {
      onApply?.(JSON.parse(String(init?.body ?? '{}')));
      return Promise.resolve(json({ status: 'applied', applied: 1, skipped: 0, failed: 0 }));
    }
    return Promise.resolve(json(sweep));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/automate/sweeps/s1']}>
      <Routes>
        <Route path="/admin/automate/sweeps/:id" element={<SweepDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SweepDetailPage', () => {
  it('leads with why it stopped and the numbers behind it', async () => {
    mockFetch();
    renderPage();
    expect(await screen.findByText(/would lose 90 of its 90 holders/)).toBeInTheDocument();
  });

  it('names the people it could not understand, by person', async () => {
    // A count is not an answer. With people, the only useful question is
    // *which* one.
    mockFetch();
    renderPage();
    expect(await screen.findByText(/holds no contract at all/)).toBeInTheDocument();
  });

  it('sends confirm true and only the rows that were left ticked', async () => {
    const sent: unknown[] = [];
    mockFetch((body) => sent.push(body));
    renderPage();
    await screen.findByText(/would lose 90 of its 90 holders/);
    await userEvent.click(screen.getByRole('checkbox', { name: /app-1/i }));
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(sent[0]).toEqual({ confirm: true, only: [] });
  });

  it('does not offer confirmation on a blocked sweep', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(json({ ...sweep, status: 'blocked', requiresConfirmation: false })),
    );
    renderPage();
    await screen.findByText(/would lose 90 of its 90 holders/);
    // A blocked sweep is one whose own inputs are not trustworthy. There is no
    // button, because there is nothing a human could usefully confirm.
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm vitest run apps/web/src/pages/admin/RequestQueuePage.test.tsx apps/web/src/pages/admin/SweepDetailPage.test.tsx`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 4: Write the catalog and workflow editors**

`apps/web/src/pages/admin/ProductsPage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  audienceCondition: unknown | null;
  grants: { id: string }[];
}

export function ProductsPage() {
  const { data, error, loading } = useApiResource<{ products: ProductRow[] }>(
    '/api/admin/automate/products',
  );

  return (
    <>
      <PageHeader
        title="Catalog"
        description="What people may ask for, and who can see each one."
        actions={
          <Link to="/admin/automate/products/new" className="text-primary">
            New product
          </Link>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={5} cols={4} />}
          {!loading && (data?.products ?? []).length === 0 && (
            <div className="p-6">
              <Empty title="No products yet">
                A product is one thing somebody may ask for. Until one is published and
                given an audience, the catalog is empty for everybody.
              </Empty>
            </div>
          )}
          {!loading && (data?.products ?? []).length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Kind</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Visible to</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data!.products.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">
                      <Link to={`/admin/automate/products/${product.id}`} className="text-ink hover:text-primary">
                        {product.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{product.kind}</td>
                    <td className="px-4 py-3">
                      {/* A product with no audience is visible to nobody, and
                          the list says so rather than leaving a blank cell. */}
                      {product.audienceCondition === null ? (
                        <Status tone="warning">Nobody</Status>
                      ) : (
                        <Status tone="neutral">An audience rule</Status>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Status tone={product.status === 'active' ? 'active' : 'neutral'}>
                        {product.status}
                      </Status>
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

`apps/web/src/pages/admin/ProductEditorPage.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

interface Preview {
  matched: number;
  total: number;
  sample: { personId: string; displayName: string }[];
}

export function ProductEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined || id === 'new';
  const { data } = useApiResource<{ products: { id: string; name: string }[] }>(
    '/api/admin/automate/products',
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [kind, setKind] = useState('application');
  const [workflowId, setWorkflowId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [audience, setAudience] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const parsedAudience = (): unknown | null => {
    if (audience.trim() === '') return null;
    return JSON.parse(audience) as unknown;
  };

  const runPreview = async () => {
    setProblem(null);
    try {
      setPreview(
        await api<Preview>('/api/admin/automate/products/audience-preview', {
          method: 'POST',
          body: JSON.stringify({ audienceCondition: parsedAudience(), limit: 10 }),
        }),
      );
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That audience expression could not be read.',
      );
    }
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setErrors({});
    try {
      const body = {
        name,
        slug,
        kind,
        grants: [
          {
            resourceType: kind === 'localGroup' ? 'group' : kind === 'application' ? 'application' : 'entitlement',
            resourceId,
          },
        ],
        audienceCondition: parsedAudience(),
        workflowId,
        formSchema: [],
        durationMode: 'permanent',
        status: 'active',
      };
      await api(
        isNew ? '/api/admin/automate/products' : `/api/admin/automate/products/${id}`,
        { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) },
      );
      setProblem('Saved.');
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong saving this.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={isNew ? 'New product' : 'Product'} />
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel title="What it is">
        <div className="space-y-4 p-4">
          <Field label="Name" value={name} onChange={setName} error={errors.name} />
          <Field label="Slug" value={slug} onChange={setSlug} error={errors.slug} />
          <Field label="Kind" value={kind} onChange={setKind} hint="application, localGroup or targetEntitlement" />
          <Field label="Resource id it grants" value={resourceId} onChange={setResourceId} />
          <Field label="Approval workflow id" value={workflowId} onChange={setWorkflowId} />
        </div>
      </Panel>

      <div className="mt-6">
        <Panel
          title="Who can see it"
          description="Leave this empty and NOBODY sees it. To offer it to everybody with an active contract, write { &quot;all&quot;: [] }."
        >
          <div className="space-y-3 p-4">
            <Field
              label="Audience condition (JSON)"
              value={audience}
              onChange={setAudience}
              error={errors.audienceCondition}
            />
            <Button onClick={runPreview}>Show me who</Button>
            {preview && (
              // The direct analogue of Provision's business-rule impact
              // preview: an audience whose blast radius is only visible after
              // saving is an audience that gets saved and then discovered.
              <Alert tone={preview.matched === 0 ? 'warning' : 'info'}>
                Visible to {preview.matched} of {preview.total} people.
                {preview.sample.length > 0 && (
                  <> For example: {preview.sample.map((s) => s.displayName).join(', ')}.</>
                )}
                {preview.matched === 0 && ' Nobody will see this product.'}
              </Alert>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Button variant="primary" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </>
  );
}
```

`apps/web/src/pages/admin/WorkflowEditorPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { ApiError, api } from '../../session/api.js';

interface StagePreview {
  sequence: number;
  name: string;
  selector: string;
  quorum: string;
  usedFallback: boolean;
  approvers: { personId: string; displayName: string; via: string }[];
  dropped: { personId: string; displayName: string; reason: string }[];
  blocked: boolean;
}

const DROP_REASON: Record<string, string> = {
  subject: 'they are the subject',
  submitter: 'they raised the request',
  no_user: 'no Syntra account',
  inactive_user: 'inactive account',
  no_active_contract: 'no contract in force',
};

export function WorkflowEditorPage() {
  const [workflowId, setWorkflowId] = useState('');
  const [subjectPersonId, setSubjectPersonId] = useState('');
  const [stages, setStages] = useState<StagePreview[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const runPreview = async () => {
    setProblem(null);
    try {
      const result = await api<{ stages: StagePreview[] }>(
        '/api/admin/automate/workflows/resolution-preview',
        {
          method: 'POST',
          body: JSON.stringify({ workflowId, subjectPersonId, productId: null }),
        },
      );
      setStages(result.stages);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That preview could not be run.',
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Approval workflows"
        description="A workflow with no stages grants immediately. That is the mechanism, not a flag."
      />
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel
        title="Resolution preview"
        description="Pick a real person and see the chain this workflow produces for them."
      >
        <div className="space-y-3 p-4">
          <Field label="Workflow id" value={workflowId} onChange={setWorkflowId} />
          <Field label="Subject person id" value={subjectPersonId} onChange={setSubjectPersonId} />
          <Button onClick={runPreview}>Resolve it</Button>

          {stages !== null && stages.length === 0 && (
            <Alert tone="warning">
              This workflow has no stages, so anything using it is granted immediately, with
              no approval at all.
            </Alert>
          )}

          {(stages ?? []).map((stage) => (
            <div key={stage.sequence} className="rounded-control border border-border-subtle p-3">
              <p className="font-medium text-ink">
                Stage {stage.sequence}: {stage.name} ({stage.selector}
                {stage.usedFallback ? ', via the fallback' : ''})
              </p>
              <p className="text-muted">
                {stage.approvers.length} valid:{' '}
                {stage.approvers.map((a) => a.displayName).join(', ') || 'nobody'}
              </p>
              {stage.dropped.length > 0 && (
                <p className="text-muted">
                  {stage.dropped.length} dropped:{' '}
                  {stage.dropped
                    .map((d) => `${d.displayName} (${DROP_REASON[d.reason] ?? d.reason})`)
                    .join(', ')}
                </p>
              )}
              {stage.blocked && (
                // The screen that catches this before it is saved, rather than
                // at 3am on somebody's request.
                <Alert tone="danger">
                  Nobody can decide this stage for this person. Any request reaching it will
                  stop and wait for an administrator.
                </Alert>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
```

- [ ] **Step 5: Write the queue, the request detail, and the sweep screens**

`apps/web/src/pages/admin/RequestQueuePage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from '../automate/status.js';

interface QueueRow {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  subjectPersonId: string;
  product: { name: string } | null;
  items: { status: string; message: string | null; resourceId: string }[];
}

/**
 * Stuck first, then everything else, each half oldest first.
 *
 * A queue ordered only by date buries the two states that actually need a
 * human: a request nobody can approve, and one that was approved and could not
 * be applied.
 */
const STUCK = ['blocked_no_approver', 'fulfilment_failed', 'partially_fulfilled'];

export function RequestQueuePage() {
  const { data, error, loading } = useApiResource<{ requests: QueueRow[] }>(
    '/api/admin/automate/requests',
  );

  const rows = [...(data?.requests ?? [])].sort((a, b) => {
    const aStuck = STUCK.includes(a.status) ? 0 : 1;
    const bStuck = STUCK.includes(b.status) ? 0 : 1;
    if (aStuck !== bStuck) return aStuck - bStuck;
    return a.submittedAt.localeCompare(b.submittedAt);
  });

  return (
    <>
      <PageHeader
        title="Requests"
        description="Every request in this tenant, with the stuck ones first."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={4} />}
          {!loading && rows.length === 0 && (
            <div className="p-6">
              <Empty title="No requests yet">
                Requests appear here as soon as somebody asks for something.
              </Empty>
            </div>
          )}
          {!loading && rows.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">For</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Asked</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <Link to={`/admin/automate/requests/${row.id}`} className="text-ink hover:text-primary">
                        {row.product?.name ?? 'Requested access'}
                      </Link>
                      {row.statusReason && (
                        <p className="text-sm text-muted">{row.statusReason}</p>
                      )}
                      {row.items
                        .filter((item) => item.status === 'failed')
                        .map((item, index) => (
                          // The target's own message. It is the only thing that
                          // says what to fix.
                          <p key={index} className="text-sm text-danger">
                            {item.resourceId}: {item.message}
                          </p>
                        ))}
                    </td>
                    <td className="px-4 py-3 text-muted">{row.subjectPersonId}</td>
                    <td className="px-4 py-3 text-muted">{when(row.submittedAt)}</td>
                    <td className="px-4 py-3">
                      <Status tone={REQUEST_TONE[row.status] ?? 'neutral'}>
                        {REQUEST_LABEL[row.status] ?? row.status}
                      </Status>
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

`apps/web/src/pages/admin/RequestDetailAdminPage.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from '../automate/status.js';

interface Detail {
  id: string;
  status: string;
  statusReason: string | null;
  subjectPersonId: string;
  requestedByPersonId: string | null;
  justification: string | null;
  product: { name: string } | null;
  items: { id: string; resourceId: string; status: string; message: string | null }[];
  steps: {
    id: string;
    sequence: number;
    status: string;
    approvers: { personId: string; via: string; onBehalfOfPersonId: string | null }[];
    decisions: { personId: string; decision: string; comment: string | null; via: string; decidedAt: string }[];
  }[];
  notifications: { template: string; to: string; sentAt: string | null; attempts: number; lastError: string | null }[];
}

export function RequestDetailAdminPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<Detail>(
    id === undefined ? null : `/api/admin/automate/requests/${id}`,
  );
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/automate/requests/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Request" />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      {loading && (
        <Panel>
          <SkeletonRows rows={5} cols={3} />
        </Panel>
      )}
      {!loading && data && (
        <>
          <Panel title={data.product?.name ?? 'Requested access'}>
            <div className="space-y-2 p-4">
              <Status tone={REQUEST_TONE[data.status] ?? 'neutral'}>
                {REQUEST_LABEL[data.status] ?? data.status}
              </Status>
              <p className="text-muted">For {data.subjectPersonId}</p>
              {data.requestedByPersonId !== null &&
                data.requestedByPersonId !== data.subjectPersonId && (
                  <p className="text-muted">Raised by {data.requestedByPersonId}</p>
                )}
              {data.justification && <p className="text-ink">{data.justification}</p>}
            </div>
          </Panel>

          <div className="mt-6">
            <Panel title="Who it was with, and what they decided">
              <ul className="divide-y divide-border-subtle">
                {data.steps.map((step) => (
                  <li key={step.id} className="px-4 py-3">
                    <p className="font-medium text-ink">
                      Stage {step.sequence} — {step.status}
                    </p>
                    {step.approvers.map((approver, index) => (
                      <p key={index} className="text-sm text-muted">
                        {approver.personId} ({approver.via}
                        {approver.onBehalfOfPersonId === null
                          ? ''
                          : ` for ${approver.onBehalfOfPersonId}`}
                        )
                      </p>
                    ))}
                    {step.decisions.map((decision, index) => (
                      <p key={index} className="mt-1 text-sm text-ink">
                        {decision.decision} by {decision.personId} ({decision.via}) on{' '}
                        {when(decision.decidedAt)}
                        {decision.comment ? ` — ${decision.comment}` : ''}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          {data.status === 'blocked_no_approver' && (
            <div className="mt-6">
              <Panel
                title="Decide this by hand"
                description="Recorded as a decision with your name on it, and subject to the same rule as every other decision: you cannot decide a request you are the subject or submitter of."
              >
                <div className="space-y-3 p-4">
                  <Field label="Comment" value={comment} onChange={setComment} />
                  <div className="flex gap-2">
                    <Button variant="primary" loading={busy} onClick={() => decide('approve')}>
                      Approve
                    </Button>
                    <Button loading={busy} onClick={() => decide('reject')}>
                      Refuse
                    </Button>
                  </div>
                </div>
              </Panel>
            </div>
          )}

          <div className="mt-6">
            <Panel title="Notifications">
              <ul className="divide-y divide-border-subtle">
                {data.notifications.map((notification, index) => (
                  <li key={index} className="px-4 py-2 text-sm text-muted">
                    {notification.template} to {notification.to} —{' '}
                    {notification.sentAt === null
                      ? `not sent after ${notification.attempts} attempts${notification.lastError ? `: ${notification.lastError}` : ''}`
                      : `sent ${when(notification.sentAt)}`}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
```

`apps/web/src/pages/admin/SweepsPage.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';
import { when } from '../automate/status.js';

interface SweepRow {
  id: string;
  status: string;
  startedAt: string;
  expireCount: number;
  lapseCount: number;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}

const TONE: Record<string, 'neutral' | 'active' | 'warning' | 'danger' | 'primary'> = {
  running: 'neutral',
  previewed: 'primary',
  blocked: 'danger',
  applying: 'primary',
  applied: 'active',
  partially_applied: 'warning',
  failed: 'danger',
};

export function SweepsPage() {
  const { data, error, loading, reload } = useApiResource<{ sweeps: SweepRow[] }>(
    '/api/admin/automate/sweeps',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const runNow = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api('/api/admin/automate/sweeps', { method: 'POST' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Expiry sweeps"
        description="What would be removed tonight, and why each sweep did or did not apply itself."
        actions={
          <Button loading={busy} onClick={runNow}>
            Run a preview now
          </Button>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel>
        {loading && <SkeletonRows rows={4} cols={4} />}
        {!loading && (data?.sweeps ?? []).length === 0 && (
          <div className="p-6">
            <Empty title="No sweeps yet">
              The nightly sweep records one row here every time it runs, whether or not it
              applied anything.
            </Empty>
          </div>
        )}
        {!loading && (data?.sweeps ?? []).length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {data!.sweeps.map((sweep) => (
              <li key={sweep.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <Link to={`/admin/automate/sweeps/${sweep.id}`} className="text-ink hover:text-primary">
                    {when(sweep.startedAt)}
                  </Link>
                  <p className="text-sm text-muted">
                    {sweep.expireCount} expiring, {sweep.lapseCount} lapsing
                  </p>
                  {sweep.blockedReason && (
                    <p className="text-sm text-danger">{sweep.blockedReason}</p>
                  )}
                </div>
                <Status tone={TONE[sweep.status] ?? 'neutral'}>{sweep.status}</Status>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
```

`apps/web/src/pages/admin/SweepDetailPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

interface SweepAction {
  id: string;
  kind: string;
  subjectPersonId: string;
  resourceType: string;
  resourceId: string;
  productId: string | null;
  status: string;
  message: string | null;
}

interface SweepDetail {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
  expireCount: number;
  lapseCount: number;
  reviewFlagCount: number;
  personsWithActiveContract: number;
  personsUnprocessable: number;
  actions: SweepAction[];
  exceptions: { id: string; personId: string; kind: string; message: string }[];
}

export function SweepDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<SweepDetail>(
    id === undefined ? null : `/api/admin/automate/sweeps/${id}`,
  );
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Every proposed row starts ticked. Reviewing means UNticking the ones you
    // disagree with, which is the direction that leaves an unread row proposed
    // rather than silently skipped.
    if (data) setTicked(new Set(data.actions.filter((a) => a.status === 'proposed').map((a) => a.id)));
  }, [data]);

  const apply = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/automate/sweeps/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, only: [...ticked] }),
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong applying this sweep.',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (actionId: string) => {
    const next = new Set(ticked);
    if (next.has(actionId)) next.delete(actionId);
    else next.add(actionId);
    setTicked(next);
  };

  return (
    <>
      <PageHeader title="Sweep" />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      {loading && (
        <Panel>
          <SkeletonRows rows={5} cols={3} />
        </Panel>
      )}
      {!loading && data && (
        <>
          {data.blockedReason && (
            // Leads with why, and the numbers behind it.
            <Alert tone={data.status === 'blocked' ? 'danger' : 'warning'} title="This sweep stopped">
              {data.blockedReason}
            </Alert>
          )}

          <div className="mt-6">
            <Panel title="What it found">
              <div className="space-y-1 p-4 text-muted">
                <p>{data.expireCount} grants past their end date</p>
                <p>{data.lapseCount} grants whose holder has no contract in force</p>
                <p>{data.reviewFlagCount} grants flagged for review and left alone</p>
                <p>{data.personsWithActiveContract} people hold an active contract</p>
              </div>
            </Panel>
          </div>

          {data.exceptions.length > 0 && (
            <div className="mt-6">
              <Panel
                title="People it could not understand"
                description="Nothing of theirs was touched. A person the system cannot understand produces no actions."
              >
                <ul className="divide-y divide-border-subtle">
                  {data.exceptions.map((exception) => (
                    <li key={exception.id} className="px-4 py-2">
                      <span className="text-ink">{exception.personId}</span>
                      <span className="text-muted"> — {exception.message}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}

          <div className="mt-6">
            <Panel
              title="Proposed removals"
              actions={
                data.status === 'previewed' ? (
                  <Button variant="primary" loading={busy} onClick={apply}>
                    Apply the ticked rows
                  </Button>
                ) : undefined
              }
            >
              <ul className="divide-y divide-border-subtle">
                {data.actions.map((action) => (
                  <li key={action.id} className="flex items-center gap-3 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`${action.resourceId} for ${action.subjectPersonId}`}
                      checked={ticked.has(action.id)}
                      disabled={data.status !== 'previewed'}
                      onChange={() => toggle(action.id)}
                    />
                    <span className="flex-1 text-ink">
                      {action.subjectPersonId} — {action.resourceId}
                    </span>
                    <span className="text-muted">{action.message}</span>
                    <Status tone={action.kind === 'lapse' ? 'warning' : 'neutral'}>
                      {action.kind}
                    </Status>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Add the console routes**

In `apps/web/src/pages/admin/AdminApp.tsx`, add the imports:

```tsx
import { ProductsPage } from './ProductsPage.js';
import { ProductEditorPage } from './ProductEditorPage.js';
import { WorkflowEditorPage } from './WorkflowEditorPage.js';
import { RequestQueuePage } from './RequestQueuePage.js';
import { RequestDetailAdminPage } from './RequestDetailAdminPage.js';
import { SweepsPage } from './SweepsPage.js';
import { SweepDetailPage } from './SweepDetailPage.js';
```

add four entries to `NAV`, after the sync ones:

```tsx
  { to: '/admin/automate/products', label: 'Catalog', permission: 'automate.read' },
  { to: '/admin/automate/workflows', label: 'Approval workflows', permission: 'automate.read' },
  { to: '/admin/automate/requests', label: 'Requests', permission: 'automate.read' },
  { to: '/admin/automate/sweeps', label: 'Expiry sweeps', permission: 'automate.read' },
```

and seven routes inside `<Routes>`, **relative** — `routes.tsx` already mounts `/admin/*`:

```tsx
            <Route path="automate/products" element={<ProductsPage />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="automate/products/new" element={<ProductEditorPage />} />
            <Route path="automate/products/:id" element={<ProductEditorPage />} />
            <Route path="automate/workflows" element={<WorkflowEditorPage />} />
            <Route path="automate/requests" element={<RequestQueuePage />} />
            <Route path="automate/requests/:id" element={<RequestDetailAdminPage />} />
            <Route path="automate/sweeps" element={<SweepsPage />} />
            <Route path="automate/sweeps/:id" element={<SweepDetailPage />} />
```

- [ ] **Step 7: Extend the person access view with the request attribution**

In `apps/web/src/pages/PersonAccessPage.tsx` (created by Provision's Task 18), the entitlement rows now carry `grantId`, `requestId` and `grantEndsAt` from Task 8. Where the page renders the "why" for each holding, replace the rule-only line with:

```tsx
                    {entitlement.origin === 'request' ? (
                      <span className="text-muted">
                        Requested{entitlement.requestId === null ? '' : ' '}
                        {entitlement.requestId !== null && (
                          <Link
                            to={`/admin/automate/requests/${entitlement.requestId}`}
                            className="text-primary"
                          >
                            on request {entitlement.requestId.slice(0, 8)}
                          </Link>
                        )}
                        {entitlement.grantEndsAt === null
                          ? ', with no end date'
                          : `, until ${new Date(entitlement.grantEndsAt).toLocaleDateString()}`}
                      </span>
                    ) : (
                      <span className="text-muted">
                        From rule {entitlement.ruleName ?? '—'}
                        {entitlement.contractDescription === null
                          ? ''
                          : `, via contract ${entitlement.contractDescription}`}
                      </span>
                    )}
```

This is the same screen Provision built, with the attribution union of spec §5 behind it — which is the point of putting grants into desired state rather than beside it.

- [ ] **Step 8: Write the end-to-end path**

`e2e/automate.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

const ADMIN = process.env.SEED_ADMIN_PASSWORD;
const USER = process.env.SEED_USER_PASSWORD;

test.beforeAll(() => {
  if (!ADMIN || !USER) {
    throw new Error(
      'SEED_ADMIN_PASSWORD and SEED_USER_PASSWORD must be set to the values the database was seeded with',
    );
  }
});

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function elevateTo(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN!);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('a product with no audience is visible to nobody, and saying so is on the screen', async ({
  page,
}) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/products/new');
  await page.getByLabel('Name').fill('Nobody sees this');
  await page.getByLabel('Slug').fill('nobody-sees-this');
  await page.getByRole('button', { name: /show me who/i }).click();
  await expect(page.getByText(/nobody will see this product/i)).toBeVisible();
});

test('a user requests something, the manager approves, and the user sees it granted', async ({
  page,
}) => {
  await signIn(page, 'user', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /statistics licence/i }).click();
  await page.getByLabel(/why do you need this/i).fill('Q3 audit');
  await page.getByRole('button', { name: /send the request/i }).click();
  await expect(page.getByText(/waiting for approval/i)).toBeVisible();
  // Naming the approver is deliberate: anonymous approval makes chasing
  // impossible and removes the accountability that makes an approver read it.
  await expect(page.getByText(/with:/i)).toBeVisible();
  await signOut(page);

  await signIn(page, 'admin', ADMIN!);
  await page.goto('/approvals');
  await page.getByLabel('Comment').fill('fine for the audit');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/nothing is waiting for you/i)).toBeVisible();
  await signOut(page);

  await signIn(page, 'user', USER!);
  await page.goto('/access');
  await expect(page.getByText(/held/i).first()).toBeVisible();
});

test('a refusal names the reason and the requester reads it', async ({ page }) => {
  await signIn(page, 'user', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /finance folder/i }).click();
  await page.getByLabel(/why do you need this/i).fill('for a report');
  await page.getByRole('button', { name: /send the request/i }).click();
  await signOut(page);

  await signIn(page, 'admin', ADMIN!);
  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Refuse' }).click();
  // The client refuses to send it, before the server does.
  await expect(page.getByText(/say why/i)).toBeVisible();
  await page.getByLabel('Comment').fill('not for this project');
  await page.getByRole('button', { name: 'Refuse' }).click();
  await signOut(page);

  await signIn(page, 'user', USER!);
  await page.goto('/requests');
  await expect(page.getByText(/refused/i)).toBeVisible();
  await page.getByRole('link', { name: /finance folder/i }).click();
  await expect(page.getByText('not for this project')).toBeVisible();
});

test('a team lead adds a member from the portal with no administrative session', async ({
  page,
}) => {
  await signIn(page, 'lead', USER!);
  await page.goto('/managed');
  await expect(page.getByText(/resources you manage/i)).toBeVisible();
  await page.getByLabel(/add somebody/i).fill(process.env.SEED_MEMBER_PERSON_ID ?? '');
  await page.getByRole('button', { name: 'Add' }).click();
  // No elevation prompt appeared anywhere in this test. That is the assertion:
  // this surface works under an ordinary portal session.
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toHaveCount(0);
});

test('a blocked sweep is reviewed and confirmed', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/sweeps');
  await page.getByRole('button', { name: /run a preview now/i }).click();
  await page.getByRole('link').first().click();
  await expect(page.getByText(/this sweep stopped/i)).toBeVisible();
  await page.getByRole('button', { name: /apply the ticked rows/i }).click();
  await expect(page.getByText(/applied/i).first()).toBeVisible();
});
```

- [ ] **Step 9: Seed the e2e fixtures**

In `packages/db/src/seed.ts`, alongside the existing users and applications, add: an `ApprovalWorkflow` named "Manager approval" with one `manager` stage falling back to the admin, a second with zero stages, two active `Product` rows (`statistics-licence` with `{ all: [] }`, `finance-folder` with a department condition), a locally-managed `Group` named "Finance Reporting", a `ResourceDelegation` of it to the seeded `lead` person with `['view_members','grant','revoke']`, and one `AccessGrant` already past its end date so the sweep has something to propose. Print `SEED_MEMBER_PERSON_ID` alongside the passwords the seed already prints, so the e2e run can name a subject.

- [ ] **Step 10: Run the web tests**

Run: `pnpm vitest run apps/web/src/pages/admin/RequestQueuePage.test.tsx apps/web/src/pages/admin/SweepDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 11: Whole-slice verification**

Run each of these and read the output before claiming anything:

```bash
pnpm typecheck
pnpm vitest run packages/core/src/automate
pnpm vitest run packages/core/src/provision
pnpm vitest run packages/db/src/automate-schema.test.ts
pnpm vitest run apps/api/src/routes/automate-portal.test.ts apps/api/src/routes/admin/automate.test.ts
pnpm vitest run apps/web/src/pages/automate apps/web/src/pages/admin
pnpm vitest run
```

Expected: all pass. The full run is last and is the one that matters — this slice changed `packages/core/src/provision`, `packages/core/src/rbac/permissions.ts`, `packages/core/src/notify/templates/index.ts`, `apps/api/src/app.ts`, `apps/api/src/scheduler.ts` and `apps/web/src/routes.tsx`, and the suites that cover those are not in the lists above.

Then, with the database seeded:

```bash
pnpm e2e
```

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/pages/admin apps/web/src/pages/PersonAccessPage.tsx \
        e2e/automate.spec.ts packages/db/src/seed.ts
git commit -m "feat(automate): the administration console and the end-to-end path"
```

---

## Plan self-review

Run with fresh eyes against `docs/superpowers/specs/2026-08-16-syntra-automate-design.md`.

### 1. Spec coverage

| Spec section | Tasks |
|---|---|
| §1 Purpose, success criteria 1–14 | 1–18; criterion 8 is Task 8, criterion 13 is Tasks 11, 12, 13 and 15 |
| §2 Position, the two slices, the hard dependency | The header's "hard dependency" table; Task 8's gate |
| §3 Platform constraints | Global Constraints 1–20 |
| §4 Decisions | Global Constraints, and the rationale comments in each task |
| §5 What Automate writes, latency, `awaiting_fulfilment`, the `application`/`User` rule, the synced-group refusal | 8 (desired state, remit, origin), 9 (three paths, the `User` rule), 12 (`awaiting_fulfilment`, SLA, supersession), 6 (synced-group refusal) |
| §6 The catalog, audience, `visibleProducts`, 404 not 403, the form | 2 (audience), 3 (form), 6 (catalog, visibility), 16 (404 on every read path, on-behalf picker) |
| §7 The request, statuses, cancellation, on-behalf, eligibility re-check, the snapshot | 10 (submission, snapshot, on-behalf), 11 (re-check, cancel), 2 (`RequestStatus`) |
| §8 Workflows, selectors, quorum, auto-grant, delegation, escalation, absence | 4 (selectors, validity, delegation), 7 (quorum and fallback at save time, auto-grant), 15 (escalation, reminders, expiry), 14 (delegation creation) |
| §9 Approval integrity, all ten paths | 4 (the matrix over the selector list), 11 (decision-time re-check, paths 6, 7, 8), 7 (path 9's containment — the audited before/after), and path 10 is Govern's, stated as out of scope |
| §10 Requested vs birthright, the four rows, movers | 8 (collisions 1 and 2 as integration tests), 13 (`needsReview`) |
| §11 Sweeps, `ExpirySweep`, `SweepAction`, the guard | 13 |
| §12 Duration, expiry, extension, lapse, the three meanings | 3 (arithmetic), 13 (classification, the three meanings), 15 (warnings, the Extend action) |
| §13 Notification, the outbox, who is told what, digests | 5 (outbox, templates, digest rule), 15 (the sender), and every service task writes its own rows |
| §14 Delegated administration, the six properties | 14, 17 (the portal surface) |
| §15 Data model, permissions | 1, 5 (permissions) |
| §16 Pipeline and transaction shape | 10, 11, 9, 12, 13, 15 |
| §17 Administration and end-user surface | 16, 17, 18 |
| §18 Security posture | Global Constraints 1, 10, 11, 12, 13, 14, 15, 17 |
| §19 Rejected alternatives | Nothing to build |
| §20 Testing | Every task's test steps; the visibility table is Task 16, the invariant matrix Task 4, the structural approval test Task 11, the transaction rule Task 15 |
| §21 Out of scope | Nothing to build |

**Gaps found and closed while reviewing:**

- **The `NotificationPreference` daily digest has a writer and a holder but no sender.** Task 5 writes `digest: true`, Task 15's outbox job skips those rows, and nothing ever sends them — a message marked for a digest would sit forever, which is the silent-drop failure this platform keeps rediscovering. **Fix, applied to Task 15 Step 3:** `runOutboxJob` gains a `digest` mode. Add to the module, after `runOutboxJob`:

  ```ts
  /**
   * The daily pass over the digest rows. One message per recipient, listing
   * what was held back, rather than one message per row -- which would be the
   * immediate mode with a delay attached.
   */
  export async function runDigestJob(
    transport: Transport,
    payload: AutomateJobPayload,
    options: JobOptions = {},
  ): Promise<{ sent: number }> {
    const now = options.now ?? new Date();
    const tenant = await prisma.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { name: true },
    });
    if (tenant === null) return { sent: 0 };

    const rows = await withTenant(payload.tenantId, (tx) =>
      tx.notificationOutbox.findMany({
        where: { sentAt: null, digest: true, attempts: { lt: OUTBOX_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const byRecipient = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byRecipient.get(row.to) ?? [];
      list.push(row);
      byRecipient.set(row.to, list);
    }

    let sent = 0;
    const delivered: string[] = [];
    for (const [to, group] of byRecipient) {
      const message = renderMessage(tenant.name, 'automate-digest', to, {
        displayName: (group[0]?.vars as Record<string, string>)?.displayName ?? 'there',
        count: String(group.length),
        lines: group
          .map((row) => `- ${(row.vars as Record<string, string>)?.productName ?? row.template}`)
          .join('\n'),
      });
      try {
        await sendMessage(transport, message);
        delivered.push(...group.map((row) => row.id));
        sent += 1;
      } catch {
        // Left unsent and unmarked; the next daily pass picks it up, and the
        // attempts column is what makes a dead recipient visible.
      }
    }
    if (delivered.length > 0) {
      await withTenant(payload.tenantId, (tx) =>
        tx.notificationOutbox.updateMany({
          where: { id: { in: delivered } },
          data: { sentAt: now },
        }),
      );
    }
    return { sent };
  }
  ```

  with one more template in Task 5 Step 3:

  ```ts
  'automate-digest': {
    subject: 'Your daily summary from {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThere are {{count}} things waiting for you:\n\n{{lines}}\n\nAnything urgent — a failure, a block, or a sweep needing confirmation — is sent to you immediately and is never in this summary.',
    html: '<p>Hello {{displayName}},</p><p>There are {{count}} things waiting for you:</p><pre>{{lines}}</pre><p>Anything urgent — a failure, a block, or a sweep needing confirmation — is sent to you immediately and is never in this summary.</p>',
  },
  ```

  a fourth queue in Task 15 Step 3 (`export const AUTOMATE_DIGEST_JOB = 'automate.digest'`, `AutomatePurpose` gains `'digest'`), a fourth `schedule` call in `applyAutomateSchedules` on `0 7 * * *` with `automateScheduleKey(tenantId, 'digest')`, a fourth `scheduler.register` in `registerAutomateJobs`, and a case in Task 15 Step 1's `applyAutomateSchedules` test asserting four distinct keys rather than three.

- **`AccessGrant.approvedByPersonId` is read by four notification paths and written by nobody.** Tasks 13 and 15 address the expiry warning and the lapse notice to "the original approver" through it. **Fix, applied to Task 9 Step 3:** in `fulfilRequest`, before creating each grant, read the last approving decision and carry it:

  ```ts
    const lastApproval = await tx.approvalDecision.findFirst({
      where: { step: { requestId: request.id }, decision: 'approve' },
      orderBy: { decidedAt: 'desc' },
      select: { personId: true },
    });
  ```

  and add `approvedByPersonId: lastApproval?.personId ?? null` to the `tx.accessGrant.create` data. Null for an auto-granted product, which is correct: nobody approved it.

- **`AccessRequest.replacesGrantId` is written at submission and never acted on.** Spec §12 requires that an extension approved before the original expires supersedes it, so no removal is produced. **Fix, applied to Task 9 Step 3:** after the grant loop in `fulfilRequest`, add:

  ```ts
    // An extension approved before the original expired supersedes it, so the
    // sweep produces no removal and there is no outage. A naive implementation
    // expires the old grant, revokes at the target, and re-grants an hour
    // later -- two audit events that say the opposite of what happened.
    if (request.replacesGrantId !== null && grantIds.length > 0) {
      await tx.accessGrant.updateMany({
        where: { id: request.replacesGrantId },
        data: { supersededByGrantId: grantIds[0]!, status: 'revoked', endedAt: now },
      });
    }
  ```

  and one case to Task 9 Step 1's test:

  ```ts
  it('supersedes the grant an extension replaces, so no removal is produced', async () => {
    const first = await seedRequest('localGroup');
    await fulfilRequest(tenantId, first, { now: NOW });
    const original = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());

    const extension = await seedRequest('localGroup');
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({
        where: { id: extension },
        data: { replacesGrantId: original.id },
      }),
    );
    await fulfilRequest(tenantId, extension, { now: NOW });

    const after = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: original.id } }),
    );
    expect(after.supersededByGrantId).not.toBeNull();
    expect(after.status).toBe('revoked');
    // And the membership survived: the replacement was written before the
    // original was retired, so nothing was removed in between.
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships).toHaveLength(1);
  });
  ```

- **The `needsApproval` field the catalog page renders was never produced by the API.** Task 16's `/automate/catalog` returns `durationMode` and `maxDurationDays` but not whether the product's workflow has stages, and Task 17's `CatalogPage` reads `needsApproval`. **Fix, applied to Task 16 Step 3:** in the `/automate/catalog` handler, read the stage counts and include the flag:

  ```ts
    const stageCounts = await request.db((tx) =>
      tx.approvalStage.groupBy({
        by: ['workflowId'],
        _count: { _all: true },
      }),
    );
    const hasStages = new Set(stageCounts.map((c) => c.workflowId));
  ```

  and `needsApproval: hasStages.has(p.workflowId)` on each mapped product. The catalog says "granted immediately" before somebody asks, which is what spec §8 requires of a zero-stage workflow.

- **§17's "Sweep exceptions … on the dashboard" and §5's fulfilment-SLA dashboard have no dashboard.** There is no administration dashboard in this repository — `AdminApp.tsx` navigates straight to `/admin/users`. Rather than invent one, the plan surfaces each of these where somebody looks: `blocked_no_approver` and `fulfilment_failed` lead the request queue (Task 18), exceptions lead the sweep detail (Task 18), and every one of them also notifies the holders of `automate.manage` (Tasks 10, 12, 13). **Recorded as a deliberate narrowing rather than a gap**; a dashboard is a reasonable follow-up and nothing here depends on it.

### 2. Placeholder scan

Searched for "TBD", "TODO", "implement later", "add appropriate", "handle edge cases", "similar to Task", "write tests for the above". None present. Every code step carries the code; every test step carries the test. Three steps are deliberate **corrections** rather than placeholders — Task 11 Step 4 (`var` to `const`), Task 14 Step 4 (the invalid Prisma `where`), and Task 8 Step 10 (fixing the fixtures the widened types break) — and each says what it is fixing and why it was left visible.

### 3. Type consistency

Walked every Interfaces block in order and checked that each task imports only what precedes it:

- `types.ts` (2) → everything.
- `audience.ts` (2) → 6, 13, 14. `AudienceCondition`, `SubjectSetFacts`, `audienceAdmits` spelled identically in all four.
- `form.ts` / `duration.ts` (3) → 6, 9, 10, 11. `resolveRequestedDuration` and `applyShortening` return `DurationOutcome` in both producer and consumers.
- `approvers.ts` (4) → 7, 10, 11, 15. `StageSnapshot` is produced in 4 and consumed by 7's `loadWorkflowStages`, 10's `openStage` and 15's tick loop, with the same eleven fields.
- `notify.ts` (5) → 6, 9, 10, 11, 12, 13, 14, 15. `enqueueOutbox(tx, drafts)` and `recipientsForPersons(tx, ids)` in all of them.
- `catalog-service.ts` (6) → 7 (`automateSettings`), 10, 13, 14, 16.
- `workflow-service.ts` (7) → 10 (`loadWorkflowStages`), 16.
- Provision's widened types (8) → nothing later in this plan imports them; 8 is a leaf as far as Automate is concerned, which is why it can be scheduled at any point after Provision lands.
- `fulfil.ts` (9) → 10, 11, 14. `FulfilOptions` is the base of `SubmitOptions` and `DecisionOptions`.
- `request-service.ts` (10) → 11 (`openStage`, `checkEligibility`, `subjectFor`), 15 (`subjectFor`), 16.
- `decision-service.ts` (11) → 16.
- `reflect.ts` (12) → 15.
- `sweep-guard.ts` / `sweep-service.ts` (13) → 15, 16.
- `delegation-service.ts` (14) → 16, 17.
- `jobs.ts` (15) → `apps/api/src/scheduler.ts` only.
- Tasks 16, 17, 18 consume and produce nothing the earlier tasks do not already define.

**Two forward references found and fixed while walking:**

1. Task 11's `decision-service.ts` imported `usersWithPermission` in its Interfaces list but never used it; removed from the list so nobody adds an import for it.
2. Task 15's `jobs.ts` consumed `subjectFor` from `request-service.ts` (Task 10) — correct — but the first draft of its Interfaces block credited it to `approvers.ts`. Corrected to `./request-service.js`.

**One naming collision found and fixed:** `addDays` exists in Provision's `plan.ts` and was about to be redefined in `duration.ts`. Both are re-exported from `packages/core/src/index.ts` with `export *`, which makes a second definition an ambiguous re-export and a build error. Task 3 imports Provision's rather than defining one, and its typecheck step names the exact error to watch for.

**One ordering hazard, stated rather than resolved by renumbering:** Task 8 must not be dispatched until Provision's Tasks 5, 7, 8, 9, 12, 13, 14 and 17 have landed. Tasks 1–7 need only Provision Task 5. Tasks 9 onwards need Task 8 to have landed for `remitFor` and the grant term to mean anything at runtime, but they **compile** without it — the only hard compile-time dependency on Provision outside Task 8 is `PROVISION_JOB` and `provisionJobPayload` from Provision's Task 16, used by Tasks 9, 12, 13 and 15.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-17-syntra-automate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

