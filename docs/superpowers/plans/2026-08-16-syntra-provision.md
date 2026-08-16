# Syntra Provision — Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a person's contracts into accounts and entitlements in an Active Directory target system — computed as desired state, diffed against what the target actually holds, written down as a reviewable plan, guarded, and applied only when a human or an explicit `autoApply` says so — with no code path anywhere that can delete anything.

**Architecture:** Six stages, `load → evaluate → reconcile → plan → guard → enforce`. The four stages in the middle are pure functions over plain values, so the multi-contract union, the grace arithmetic, the rehire, the pre-hire horizon, the guard's two axes and the drift classification are all testable without a server or a database. `load` and `enforce` are the only stages that touch the network, and neither ever does so inside a Prisma transaction. A target connector is the existing `Connector<C>` plus `listEntitlements`, with `write` given a tagged-union shape whose `failure` classification is decided by the connector — so the retry logic in the run stays generic while the target-specific knowledge stays in the target.

**Tech Stack:** TypeScript 5.7, Node 22+, Fastify 5, Prisma 6, PostgreSQL 16, Vitest 3, React 19, Tailwind 4, `ldapts@^9.0.0`, `zod@^3.24.0`, pg-boss 12, Docker (`nowsci/samba-domain:20260801025201`).

**Spec:** `docs/superpowers/specs/2026-08-16-syntra-provision-design.md` — the binding authority, all 21 sections. Rulings that bind this plan: `.superpowers/sdd/provision-rulings.md` (P1, P2, P4; P3 resolved by spike). Spike evidence the plan depends on: `.superpowers/sdd/provision-ad-spike.md`. Inherited read-side defects: `docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`.

---

## Global Constraints

Everything in the Core, Directory Sync and Access plans' Global Constraints still applies. These are the ones that bite in this slice, plus the ones this slice adds. Every task's requirements implicitly include this section.

1. **Provision never deletes.** No action type, no connector method, no configuration flag and no code path deletes an account or an entitlement object in a target system. The Active Directory connector has **no delete operation to call** — absent, not disabled and not configuration-gated. Task 2 pins this with an exhaustive structural test over the action-type union so that adding a destructive member fails a test rather than passing review. (Spec §9, §15.)

2. **No network I/O, no LDAP call, no Argon2, no signing and no KMS or remote key-service round trip inside a Prisma interactive transaction.** The Core vault helpers `putSecret` and `getSecret` take a `tx` by design and are local AES operations against a row in the same transaction; they are *not* what this forbids, and existing Core code calls them inside `withTenant`. What is forbidden is anything that leaves the process: a directory read, a target write, an SMTP send, a KMS unwrap. `withTenant` is `prisma.$transaction(fn)` and the client in `packages/db/src/client.ts` is constructed with no `transactionOptions`, so Prisma's **5000 ms** default applies. This has produced a Critical finding three times on this programme. Every task that reads a directory and writes the result is structured in phases: read outside, write inside. A `tx` handle never crosses a phase boundary. (Spec §14, §16.)

3. **Every tenant-scoped table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`** and a `tenant_isolation` policy whose USING **and** WITH CHECK are `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. The `NULLIF` is not optional: `set_config(..., true)` reverts the GUC to the **empty string, not NULL**, at transaction end. Copy the `DO $$` block from `packages/db/prisma/migrations/20260816000000_access_1/migration.sql`.

4. **Every database access runs inside `withTenant`, including test fixtures and assertions.** The app connects as `syntra_app`, which is NOSUPERUSER NOBYPASSRLS deliberately. A bare `prisma.provisionAction.findMany()` outside `withTenant` returns `[]` under forced RLS **whether or not the code works** — 28 such vacuous assertions were found on the last branch. Every test in this plan that asserts on database state reads through `withTenant`. The only exceptions are `prisma.tenant.*` (Tenant is outside RLS by design) and `asDatabaseSuperuser` in tamper tests.

5. **Unique constraints do not constrain NULLs in PostgreSQL.** Any uniqueness rule over a nullable column needs a hand-written partial unique index appended to the generated migration — never `@@unique`. This slice has four. **Inspect the generated migration before appending:** `prisma migrate diff` compares the schema file against a shadow database, `schema.prisma` cannot express a partial index, so every partial index the previous slices created by hand looks to the diff like something the database has that the model does not, and it will emit `DROP INDEX` for them. Delete any such line before going further.

6. **Migration directory names must sort after every migration they depend on.** As of 2026-08-16 the newest existing migration is `20260819030000_saml_config_unique_entity_id`, with `20260819000000_oidc_artifact_account_index`, `20260819010000_federation_request_browser_binding` and `20260819020000_federation_request_expected_response_to` behind it — so this plan takes `20260820000000`, which sorts after all of them. **Re-read `packages/db/prisma/migrations/` before creating the directory** and bump the date again if anything newer has landed; this list has already moved once while the plan was being written, and a timestamp collision was caught once on this plan (Ruling P7). This plan adds exactly one migration, named `20260820000000_provision_targets`. A name that sorts early passes the entire suite and breaks every fresh install, because `resetDatabase()` truncates rather than re-migrating.

7. **Vitest does not type-check.** `pnpm vitest run` will happily execute a file full of type errors. **Every task's verification runs `pnpm typecheck` as its own step**, separately from the tests, or type errors ship invisibly.

8. **The anchor is the target's own immutable object identifier.** `objectGUID` in Active Directory, normalised through the existing `normaliseAnchor` in `packages/connectors/src/ldap/anchor.ts`. Never `sAMAccountName`, never the UPN, never the mail address, never the DN. The same rule binds `Entitlement.externalId`: the group's `objectGUID`, never its name or DN. A name-keyed entitlement turns a group rename into "revoke this from all 400 holders and grant a new thing to all 400 of them". (Spec §5.)

9. **A run proposes, a human confirms, nothing irreversible happens unattended** (Ruling P2). The guard is not advisory and `autoApply` does not override it. The scheduler never confirms anything. The confirming user is recorded on the run.

10. **`enforcementMode` is `additive` by default, per target, visible on the target's screen, and drift is reported under both modes** (Ruling P2). Additive must mean "I saw this and left it", never "I did not look". A `DriftFinding` is written in both modes; only whether a revocation is *proposed* differs. The remit restriction — Provision only ever touches entitlements named by at least one business rule for this target — applies in **both** modes.

11. **A superseded or skipped scheduled run is surfaced where someone looks** (Ruling P4). `TargetSystem.consecutiveSkippedRuns`, `lastSkippedAt` and `lastSkipReason` are columns on the target, rendered on the targets list and on the target's own screen, and a target that has skipped repeatedly is visibly distinguishable from one running cleanly. "It is recorded in an audit event" is explicitly **not** sufficient — that reasoning was corrected once already on this project.

12. **pg-boss schedules need a distinct `key` per source.** pg-boss keys its schedule table on `(queue, key)` with `key` defaulting to `''`. All directory sources once shared `key: ''` and only the last one in the last tenant ever ran. `provisionScheduleKey(tenantId, targetSystemId)` is mandatory on every `schedule` and `unschedule` call.

13. **Writes to Active Directory require an encrypted transport unconditionally.** `tlsMode` must be `ldaps` or `starttls`; `plain` is refused when a target is saved, not merely discouraged. The Samba container the tests run against refuses **even a plain simple bind** — `StrongAuthRequiredError: BindSimple: Transport encryption required. Code: 0x8` — so a fixture that assumes it can do anything over `ldap://` will not work at all.

14. **The generated initial password is a secret and is treated as one.** Generated with `crypto.randomBytes`, sealed into the Core vault via `putSecret`, delivered once through `queueMessage`, and never written to a `ProvisionAction`, never to an audit payload, never to a log line, and never returned by any API. An action whose `before`/`after` JSON carries `unicodePwd` is a plan violation.

15. **A person Provision cannot understand produces *no actions*, not *empty desired state*.** These are not the same thing and the difference is somebody's job. Every unprocessable person writes a `ProvisionException` naming them, and their existing accounts and entitlements are left untouched — not granted, not revoked, not disabled. (Spec §13.)

16. **A rule that names a `missing` or `unreadable` entitlement is unresolvable as a whole**, and produces no desired state at all for any person it would have been evaluated against. Evaluating it without the missing entitlement produces a desired set that lacks it, and the diff then proposes revoking it from everybody who holds it.

17. **`exactOptionalPropertyTypes` is on.** `{ foo: undefined }` does not satisfy `{ foo?: string }`. Spread conditionally: `...(x === undefined ? {} : { foo: x })`.

18. **Tests run in a single fork against one PostgreSQL** (`vitest.config.ts`, `poolOptions.forks.singleFork`), and `resetDatabase()` truncates between tests. Never assume parallel isolation. Integration tests run against real containers, never mocks.

19. **Every privileged configuration change is audited in the same transaction as the mutation.** A target, a profile, a rule, a threshold, an enforcement mode: lowering a threshold is functionally the same as approving everything it would otherwise have caught.

20. **Commits:** conventional commits, one per task. **Tests:** TDD — a failing test precedes the code that satisfies it.

### Defaults, copied verbatim from the spec

These are the numbers the spec fixes. Do not invent others.

| Setting | Default | Spec |
|---|---|---|
| `enforcementMode` | `additive` | §12 |
| `preHireDays` | 0 | §8 |
| `entitlementRevocationDelayDays` | 0 | §9 |
| `disableGraceDays` | 0 | §9 |
| `archiveAfterDays` | null (never) | §9 |
| `reenableWithoutConfirmationDays` | 7 | §8 |
| `createAccountThresholdPercent` | 20 | §11 |
| `disableAccountThresholdPercent` | 10 | §11 |
| `archiveAccountThresholdPercent` | 2 | §11 |
| `revokeEntitlementThresholdPercent` | 10 | §11 |
| `deactivateSyntraUserThresholdPercent` | 10 | §11 |
| `perEntitlementThresholdPercent` | 50 | §11 |
| `personPopulationDropPercent` | 20 | §11 |
| `maxAttempts` | 3 | §14 |
| `concurrency` | 4 | §14 |
| `renameEnabled` | false | §6 |
| `sAMAccountName` length cap | 20 characters | §6 |
| AD `userAccountControl` disabled / enabled | 514 / 512 | §6 |
| AD `member` range truncation boundary | 1500 | §6 |
| Ladder ordering, validated on save | `entitlementRevocationDelayDays <= disableGraceDays`, and when `archiveAfterDays` is set, `disableGraceDays < archiveAfterDays` | §9 |

---

## File Structure

```
packages/db/prisma/
  schema.prisma                        + TargetSystem, AccountProfile, BusinessRule,
                                         RuleEntitlement, Entitlement, TargetAccount,
                                         AccountEntitlement, ProvisionRun,
                                         ProvisionAction, ProvisionException,
                                         DriftFinding
  migrations/20260820000000_provision_targets/migration.sql

packages/connectors/src/
  types.ts                MODIFIED — TargetConnector, DiscoveredEntitlement,
                          WriteOperation (tagged union), WriteResult, WriteFailure
  ldap/range.ts           readRangedAttribute — Ruling P1, before anything writes
                          (parseRangeKey, RANGE_STEP; no nextRangeSpec)
  ldap/connector.ts       MODIFIED — range retrieval replaces the loud failure
  ad/config.ts            adTargetConfigSchema — LDAP config plus target-only fields
  ad/uac.ts               UAC_NORMAL_DISABLED, UAC_NORMAL_ENABLED   (pure)
  ad/connector.ts         adTargetConnector — the only module that writes to AD
  ad/samba-connection.ts  sambaConnection, connectAsSambaAdmin, purgeSubtree
                          — a plain module, NOT an export from the smoke test
  testing/fake-target.ts  FakeTarget — programmable failures, no network

packages/core/src/provision/
  types.ts                the shared value types every pure stage speaks
  condition.ts            conditionSchema, evaluateCondition        (pure)
  templates.ts            renderTemplate, TemplateContext           (pure)
  names.ts                generateCorrelationKey                    (pure)
  desired.ts              desiredState                              (pure)
  reconcile.ts            reconcile                                 (pure)
  plan.ts                 planActions, ACTION_ORDER                 (pure)
  guard.ts                evaluateProvisionGuard                    (pure)
  target-service.ts       TargetSystem + AccountProfile + BusinessRule storage
  entitlement-service.ts  refreshEntitlements, catalog reads
  run-service.ts          previewProvisionRun — the seven phases
  apply.ts                applyProvisionRun — the three-step per action
  syntra-user.ts          claimSyntraUser, applySyntraUserAction
  jobs.ts                 PROVISION_JOB, provisionScheduleKey, skip accounting
  explain.ts              explainPersonAccess

packages/contracts/src/
  provision.ts            every request/response schema for the surface below

apps/api/src/routes/admin/
  targets.ts              /api/admin/targets/*
  profiles.ts             /api/admin/targets/:id/profile  + live preview
  rules.ts                /api/admin/targets/:id/rules    + impact preview
  provision-runs.ts       runs, detail, apply, confirm, exceptions, drift
  persons.ts              MODIFIED — GET /api/admin/persons/:id/access
apps/api/src/
  app.ts                  MODIFIED — registers the four plugins above
  scheduler.ts            MODIFIED — registerProvisionJobs + boot reconciliation

apps/web/src/pages/admin/
  TargetsPage.tsx              list, with the skip badge Ruling P4 requires
  TargetDetailPage.tsx         editor, enforcement mode, thresholds, ladder
  AccountProfilePage.tsx       template editor with the live preview
  BusinessRulesPage.tsx        rule editor with the impact preview
  ProvisionRunsPage.tsx        run history
  ProvisionRunDetailPage.tsx   by type and by person, apply, per-action skip,
                               blocked reasons, Exceptions tab, Drift tab
apps/web/src/pages/PersonAccessPage.tsx   why does this person hold this
apps/web/src/pages/admin/AdminApp.tsx     MODIFIED — the seven console routes,
                             written RELATIVE to /admin; routes.tsx already
                             mounts /admin/* behind the elevated-session guard
                             and is not touched

infra/docker-compose.yml     MODIFIED — samba service, pinned tag, privileged
infra/samba/README.md        why --privileged, why LDAPS, which ports

e2e/provision.spec.ts        the whole slice through a browser
```

`packages/core/src/provision/desired.ts`, `reconcile.ts`, `plan.ts`, `guard.ts` and `types.ts` import nothing from `@syntra/db`, and nothing from `@syntra/connectors` **beyond a type-only import of `ProvisionActionType`** — which `types.ts`, `plan.ts` and `guard.ts` each take, because the action-type union is defined once and must not be restated. That import is erased at compile time and carries no runtime dependency. Any *value* import from either package in those five modules means the boundary is wrong: `run-service.ts` is what reads the database and the target, and the pure stages only reason over what they are handed. `packages/connectors` never imports `@syntra/core` or `@syntra/db`.

---

## Task 1: Data model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260820000000_provision_targets/migration.sql`
- Test: `packages/db/src/provision-schema.test.ts`

**Interfaces:**
- Consumes: `prisma`, `withTenant`, `TenantClient` from `@syntra/db`; `resetDatabase` from `@syntra/db/src/test-support.js`.
- Produces: every Prisma model the rest of the plan reads and writes — `TargetSystem`, `AccountProfile`, `BusinessRule`, `RuleEntitlement`, `Entitlement`, `TargetAccount`, `AccountEntitlement`, `ProvisionRun`, `ProvisionAction`, `ProvisionException`, `DriftFinding`. No existing table is modified; `Person`, `Contract` and `User` are unchanged (spec §15) — and in particular **`Person` gains no `email` and no `displayName` column**, because it has neither: the columns are `givenName`, `familyName`, `nameConvention`, `businessEmail`, `personalEmail`, `externalId`, `status`. Every task downstream reads those names.
- Four fields here exist only because a later task needs them and nothing else would supply them: `Entitlement.dn` (Task 13 maps Active Directory `memberOf`, which is a list of DNs, onto entitlement ids), `ProvisionAction.sequence` (Task 14 applies actions in order, and `createdAt` is transaction start time in PostgreSQL and therefore identical for every row written by one `createMany`), `DriftFinding.subjectAnchor` (an orphan finding's subject is a target anchor, not a UUID) and `DriftFinding.runId` being nullable (Task 15 can observe drift with no run in flight).

- [ ] **Step 1: Add the configuration models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A system Provision writes accounts and entitlements into. The bind
/// credential is never on this row: it lives in the Core vault under
/// `secretName`, so a target can be read and edited without exposing it.
model TargetSystem {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  name     String
  /// 'activeDirectory'. A string rather than an enum so a second connector
  /// family needs no migration.
  type     String @default("activeDirectory")
  /// URL, TLS mode, certificate verification, bind DN, base DN, entitlement
  /// search base, archive container, provenance attribute, page size,
  /// timeouts. Validated as a whole by adTargetConfigSchema, so it is
  /// replaced whole on a save rather than merged.
  config   Json
  /// Names the Core vault entry holding the bind credential.
  secretName String
  /// The directory source that reads this same system back into Syntra. When
  /// set, account status propagates inward (spec §4) and a successful apply
  /// enqueues a run of it.
  pairedDirectorySourceId String? @db.Uuid

  schedule  String?
  autoApply Boolean @default(false)
  enabled   Boolean @default(true)

  /// 'additive' | 'authoritative'. Additive is the default because an engine
  /// that silently strips what it did not grant gets switched off. Drift is
  /// reported under BOTH modes (Ruling P2).
  enforcementMode String @default("additive")

  /// Desired state is computed against `now + preHireDays` for whether an
  /// account is required, and against `now` for whether it is enabled.
  preHireDays                    Int  @default(0)
  entitlementRevocationDelayDays Int  @default(0)
  disableGraceDays               Int  @default(0)
  /// Null means never. Archiving moves the object and strips its remaining
  /// managed entitlements, so it is opted into.
  archiveAfterDays               Int?
  /// Re-enabling an account disabled for longer than this is confirmable.
  /// Deliberately not derived from disableGraceDays: with that at its default
  /// of zero, deriving it would make every re-enable confirmable, including
  /// the correction the morning after.
  reenableWithoutConfirmationDays Int @default(7)

  createAccountThresholdPercent        Int @default(20)
  disableAccountThresholdPercent       Int @default(10)
  archiveAccountThresholdPercent       Int @default(2)
  revokeEntitlementThresholdPercent    Int @default(10)
  deactivateSyntraUserThresholdPercent Int @default(10)
  /// The second axis. Revoking every holder of one entitlement is 0.2% of a
  /// 40,000-holding tenant and total for the 90 people it happens to.
  perEntitlementThresholdPercent       Int @default(50)
  personPopulationDropPercent          Int @default(20)

  maxAttempts   Int     @default(3)
  concurrency   Int     @default(4)
  /// A rename breaks certificate subjects, profile paths, file ownership and
  /// mailbox aliases. Off by default, and always confirmable when on.
  renameEnabled Boolean @default(false)

  lastRunAt        DateTime?
  lastAppliedRunAt DateTime?

  /// Ruling P4. A scheduled run that did not start because one was awaiting
  /// review is surfaced here, on the target's own row, because that is where
  /// somebody looks. An audit event nobody reads is not a surfacing.
  consecutiveSkippedRuns Int       @default(0)
  lastSkippedAt          DateTime?
  lastSkipReason         String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  profile     AccountProfile?
  rules       BusinessRule[]
  entitlements Entitlement[]
  accounts    TargetAccount[]
  runs        ProvisionRun[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

/// One per target. Rules answer *whether* somebody gets an account; the
/// profile answers *what that account looks like*. Keeping attributes out of
/// rules removes the whole class of "two rules both want to set department".
model AccountProfile {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)

  /// e.g. "%person.givenName.first%.%person.familyName%"
  correlationKeyTemplate String
  /// 'numericSuffix' — base, then base with an incrementing suffix.
  uniquenessStrategy     String @default("numericSuffix")
  maxUniquenessAttempts  Int    @default(20)
  /// e.g. "OU=%contract.department%,OU=Users,%baseDn%"
  containerTemplate      String
  /// Used when containerTemplate resolves to an empty value. Required: a
  /// template that resolves to nothing must land somewhere known, and
  /// Provision does not create organizational units in somebody else's domain.
  fallbackContainer      String
  /// { "displayName": "...", "userPrincipalName": "...", "mail": "..." }
  attributeTemplates     Json
  /// { "length": 20, "requireUpper": true, ... }
  initialPasswordPolicy  Json
  /// 'manager' | 'personalEmail' | 'vaultOnly'
  initialPasswordDelivery String @default("vaultOnly")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}

/// A condition over ONE contract, mapped to entitlements in ONE target, plus
/// whether a match requires an account there at all. Evaluated against each
/// active contract independently and unioned.
model BusinessRule {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  name           String
  description    String?
  /// A closed declarative expression, validated by Zod, evaluated by a closed
  /// interpreter. Nothing an administrator types is executed.
  condition      Json
  grantsAccount  Boolean      @default(true)
  enabled        Boolean      @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entitlements RuleEntitlement[]

  @@index([tenantId])
  @@index([targetSystemId])
}

/// A join table, so "which rules grant this entitlement" is a query rather
/// than a scan over JSON — which is what the guard's remit check and the
/// person-detail "why" view both need.
model RuleEntitlement {
  id            String       @id @default(uuid()) @db.Uuid
  tenantId      String       @db.Uuid
  ruleId        String       @db.Uuid
  rule          BusinessRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  entitlementId String       @db.Uuid
  entitlement   Entitlement  @relation(fields: [entitlementId], references: [id], onDelete: Cascade)

  @@unique([ruleId, entitlementId])
  @@index([tenantId])
  @@index([entitlementId])
}
```

- [ ] **Step 2: Add the inventory models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A grantable thing the target offers. `externalId` is the target's own
/// immutable identifier — the group's objectGUID — never its name or DN. A
/// name-keyed entitlement turns a group rename into a mass revoke-and-regrant.
model Entitlement {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  externalId     String
  /// The target's distinguished name for this object, as last read.
  /// Active Directory reports a user's group membership as a list of DNs in
  /// `memberOf`, never as objectGUIDs, so mapping membership back onto
  /// entitlements needs the DN. It is NOT the identity -- `externalId` is --
  /// which is why it is nullable and may go stale between catalog refreshes.
  dn             String?
  /// 'group' | 'licence' | 'role'
  type           String
  displayName    String
  description    String?
  /// 'present' | 'missing' | 'unreadable'. A rule naming a missing or
  /// unreadable entitlement is unresolvable AS A WHOLE — see plan.ts.
  status         String   @default("present")
  /// Current holders, the denominator of the per-entitlement guard axis.
  holderCount    Int      @default(0)
  lastSeenAt     DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  rules    RuleEntitlement[]
  holdings AccountEntitlement[]

  @@unique([tenantId, targetSystemId, externalId])
  @@index([tenantId])
}

/// One account per person per target — which is what makes a rehire find its
/// own account instead of creating a second one.
model TargetAccount {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  personId       String       @db.Uuid
  person         Person       @relation(fields: [personId], references: [id], onDelete: Restrict)
  /// The target's immutable object identifier. Null until the account exists
  /// in the target: a `pending` row holds its correlation key reserved so two
  /// runs cannot generate the same login.
  anchor         String?
  correlationKey String
  /// 'pending' | 'active' | 'disabled' | 'archived' | 'missing_at_target'
  /// | 'conflict'
  status         String   @default("pending")
  statusReason   String?
  disabledAt     DateTime?
  disableDueAt   DateTime?
  archiveDueAt   DateTime?
  createdActionId String?  @db.Uuid
  lastReconciledAt DateTime?
  /// What Provision last wrote, so update_account can carry the complete
  /// managed set and a no-op run stays a no-op.
  lastAppliedAttributes Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entitlements AccountEntitlement[]

  @@unique([tenantId, targetSystemId, personId])
  @@unique([tenantId, targetSystemId, correlationKey])
  @@index([tenantId])
  @@index([targetSystemId, status])
}

/// `origin` separates convergence from drift and is not derivable after the
/// fact, so it is recorded at the moment of the grant.
model AccountEntitlement {
  id            String        @id @default(uuid()) @db.Uuid
  tenantId      String        @db.Uuid
  accountId     String        @db.Uuid
  account       TargetAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  entitlementId String        @db.Uuid
  /// Cascade, not Restrict. `Entitlement` cascades from `TargetSystem`, and
  /// PostgreSQL checks RESTRICT immediately -- so with Restrict here, deleting
  /// a target that holds a single live holding fails with a foreign-key
  /// violation rather than the confirmable delete deleteTarget offers. The
  /// holding is a record of a grant into this entitlement; it is meaningless
  /// once the entitlement row is gone, and the account's own row cascades from
  /// the target by the same reasoning.
  entitlement   Entitlement   @relation(fields: [entitlementId], references: [id], onDelete: Cascade)
  /// 'rule' — Provision granted it because a rule said so.
  /// 'manual' — an administrator linked it in Syntra deliberately.
  /// 'discovered' — the target already held it when Provision first looked.
  origin        String
  grantedByRuleId String? @db.Uuid
  grantedAt     DateTime  @default(now())
  revokedAt     DateTime?
  /// 'held' | 'revoked'
  state         String    @default("held")

  @@index([tenantId])
  @@index([accountId])
  @@index([entitlementId, state])
}
```

- [ ] **Step 3: Add the run models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// 'running' | 'previewed' | 'blocked' | 'applying' | 'applied'
/// | 'partially_applied' | 'failed'. A run reaches `applied` only when every
/// action it proposed reached a terminal state and none failed.
model ProvisionRun {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  status         String       @default("running")
  startedAt      DateTime     @default(now())
  finishedAt     DateTime?

  createAccountCount        Int @default(0)
  updateAccountCount        Int @default(0)
  enableAccountCount        Int @default(0)
  disableAccountCount       Int @default(0)
  archiveAccountCount       Int @default(0)
  renameAccountCount        Int @default(0)
  grantEntitlementCount     Int @default(0)
  revokeEntitlementCount    Int @default(0)
  deactivateSyntraUserCount Int @default(0)
  reactivateSyntraUserCount Int @default(0)

  personsEvaluated           Int @default(0)
  /// The denominator of the population-collapse refusal.
  personsWithActiveContract  Int @default(0)
  personsUnprocessable       Int @default(0)
  accountsReadFromTarget     Int @default(0)
  entitlementsReadFromTarget Int @default(0)

  requiresConfirmation Boolean @default(false)
  blockedReason        String?
  confirmedByUserId    String? @db.Uuid
  error                String?

  actions    ProvisionAction[]
  exceptions ProvisionException[]
  drift      DriftFinding[]

  @@index([tenantId])
  @@index([targetSystemId, startedAt])
}

/// One materialized row per proposed action. The review screen and the
/// enforcement loop read the same table, so there is no version of "the
/// preview said one thing and the apply did another".
model ProvisionAction {
  id       String       @id @default(uuid()) @db.Uuid
  tenantId String       @db.Uuid
  runId    String       @db.Uuid
  run      ProvisionRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  /// create_account | update_account | enable_account | disable_account
  /// | archive_account | rename_account | grant_entitlement
  /// | revoke_entitlement | deactivate_syntra_user | reactivate_syntra_user
  /// THERE IS NO DELETE OF ANY KIND, AND NO TYPE THAT COULD BECOME ONE.
  actionType    String
  personId      String? @db.Uuid
  accountId     String? @db.Uuid
  entitlementId String? @db.Uuid
  before        Json?
  after         Json?
  /// Which rules caused this. Recorded at evaluation time because it is
  /// unanswerable afterwards, and "why does this person hold this?" is the
  /// most-asked question of any provisioning product.
  attributedRuleIds String[] @default([])
  /// The order this action is applied in, from ACTION_ORDER (spec section 14:
  /// within a person, create then attribute updates then grants then
  /// revocations then disable then archive).
  ///
  /// A column rather than an ORDER BY on createdAt, because `now()` in
  /// PostgreSQL is TRANSACTION START time: every row written by phase 7's
  /// single `createMany` carries an identical createdAt, so ordering by it
  /// imposes no order at all. A grant attempted before the create it depends
  /// on fails `not_found`, nondeterministically -- which passes CI and fails
  /// in production.
  sequence      Int      @default(0)
  /// 'proposed' | 'in_flight' | 'applied' | 'skipped' | 'failed'
  /// | 'pending_retry' | 'conflict' | 'superseded'
  status        String   @default("proposed")
  attempts      Int      @default(0)
  nextAttemptAt DateTime?
  message       String?
  appliedAt     DateTime?
  /// Whether applying this needs an explicit tick even in an otherwise
  /// unblocked run: a rename, or a re-enable outside the window.
  requiresConfirmation Boolean @default(false)

  createdAt DateTime @default(now())

  /// The apply loop reads by status. Directory Sync indexed its equivalent on
  /// (runId, changeType) and then queried by status; do not repeat that.
  @@index([runId, status])
  /// The apply loop and the run-detail route both read in sequence order.
  @@index([runId, sequence])
  @@index([tenantId])
  @@index([personId])
}

/// A person Provision could not fully evaluate for a target. Deliberately a
/// table and not a count-plus-reasons pair: with people, the only useful
/// question is *which* eleven, and the answer needs to be a list a human can
/// work down.
model ProvisionException {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  runId          String       @db.Uuid
  run            ProvisionRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  personId       String       @db.Uuid
  person         Person       @relation(fields: [personId], references: [id], onDelete: Restrict)
  targetSystemId String       @db.Uuid
  /// 'no_contracts' | 'unresolvable_rule' | 'template_unresolvable'
  /// | 'container_missing' | 'name_generation_exhausted'
  /// | 'target_read_incomplete' | 'account_conflict'
  kind    String
  message String

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([runId])
  @@index([personId])
}

/// A finding that persists across runs is updated rather than duplicated, so
/// the count on the dashboard is a count of problems and not a count of runs.
model DriftFinding {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  targetSystemId String       @db.Uuid
  /// The run that most recently observed it. Nullable: `claimSyntraUsers`
  /// (Task 15) records a finding and can be called when no run has ever
  /// existed for this target, and resolving a run id it does not have by
  /// `findFirstOrThrow` would turn a drift report into an exception.
  runId          String?      @db.Uuid
  run            ProvisionRun? @relation(fields: [runId], references: [id], onDelete: Cascade)
  accountId      String?      @db.Uuid
  entitlementId  String?      @db.Uuid
  /// The target's own identifier for the object a finding is about, when that
  /// object is not one Syntra holds a row for -- an orphan account. It cannot
  /// go in `entitlementId`, which is `@db.Uuid` and would reject
  /// `fake-anchor-0001` outright and, against real Active Directory, would
  /// accept a valid UUID that points at no Entitlement.
  subjectAnchor  String?
  /// 'unmanaged_entitlement' | 'missing_grant' | 'orphan_account'
  /// | 'account_missing_at_target' | 'unexpected_status'
  kind   String
  detail Json
  /// 'open' | 'acknowledged' | 'resolved'
  status String @default("open")
  /// A stable identity for "the same problem", so the upsert has something
  /// NOT NULL to key on. accountId and entitlementId are both nullable and a
  /// unique index over nullable columns constrains nothing, so this column
  /// exists rather than a four-column partial index that would not work.
  /// Built by driftFingerprint() in reconcile.ts.
  fingerprint String

  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())

  @@unique([tenantId, targetSystemId, fingerprint])
  @@index([tenantId])
  @@index([targetSystemId, status])
}
```

- [ ] **Step 4: Add the back-relations to Person**

`Person` gains two back-relations and nothing else — no column is added, per spec §15 ("Changes to existing tables: None"). In `packages/db/prisma/schema.prisma`, inside `model Person`, after its existing relation fields:

```prisma
  targetAccounts      TargetAccount[]
  provisionExceptions ProvisionException[]
```

- [ ] **Step 5: Generate the migration**

```bash
cd packages/db && pnpm prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > /tmp/provision.sql
mkdir -p prisma/migrations/20260820000000_provision_targets
cp /tmp/provision.sql prisma/migrations/20260820000000_provision_targets/migration.sql
```

- [ ] **Step 6: Read the generated file before touching anything else**

Open `packages/db/prisma/migrations/20260820000000_provision_targets/migration.sql` and search it for `DROP INDEX`.

`migrate diff --from-migrations` compares the *schema file* against a shadow database built from the existing migrations, and `schema.prisma` cannot express a partial index. Every partial index the previous slices created by hand — `role_assignment_unscoped_unique`, `contract_one_primary_per_person`, `app_assignment_unique_user`, `app_assignment_unique_group`, `app_assignment_unique_org_unit`, `webauthn_challenge_one_live`, `password_reset_token_one_live` and the sync ones — is therefore invisible to the schema file and looks like something the database has that the model does not.

**If any `DROP INDEX` appears, delete those lines from the generated file before going further.** Applying them silently removes constraints nothing in the test suite would notice were gone, because `resetDatabase()` truncates rather than re-migrating. The same is true of the four partial indexes the next step adds.

- [ ] **Step 7: Append row-level security, the check constraints, and the partial indexes**

Append to `packages/db/prisma/migrations/20260820000000_provision_targets/migration.sql`:

```sql
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TargetSystem','AccountProfile','BusinessRule','RuleEntitlement',
    'Entitlement','TargetAccount','AccountEntitlement','ProvisionRun',
    'ProvisionAction','ProvisionException','DriftFinding'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- One profile per target. targetSystemId is NOT NULL so this could have been
-- an @@unique, but it is written here beside the other three so the whole
-- uniqueness story for this slice is readable in one place.
CREATE UNIQUE INDEX account_profile_one_per_target
  ON "AccountProfile" ("targetSystemId");

-- The anchor is unique within a target, but it is NULL for every `pending`
-- account, and PostgreSQL treats NULL as distinct from NULL. A plain
-- UNIQUE("tenantId","targetSystemId","anchor") would therefore permit two
-- accounts on the SAME anchor as long as it constrained nothing else, and
-- would not constrain the pending rows at all. Partial is the only version
-- that constrains what matters.
CREATE UNIQUE INDEX target_account_anchor_unique
  ON "TargetAccount" ("tenantId", "targetSystemId", "anchor")
  WHERE "anchor" IS NOT NULL;

-- A live holding is unique per (account, entitlement). Revoked rows stay for
-- history, so only the live ones are constrained -- same NULL reasoning.
CREATE UNIQUE INDEX account_entitlement_one_live
  ON "AccountEntitlement" ("accountId", "entitlementId")
  WHERE "revokedAt" IS NULL;

-- Spec section 10: "A target system has at most one run in a non-terminal
-- state." Enforced by the database rather than by the code that starts runs,
-- for the same reason the correlation key reservation is: two concurrent
-- starts are a race the database refuses, not one the application is trusted
-- to avoid. Two overlapping plans against one target can interleave a
-- revocation from the older behind a grant from the newer, producing a state
-- neither plan described and nobody approved.
CREATE UNIQUE INDEX provision_run_one_non_terminal
  ON "ProvisionRun" ("tenantId", "targetSystemId")
  WHERE "status" IN ('running', 'previewed', 'blocked', 'applying');

-- The ladder ordering, per spec section 9. Validated on save as well, because
-- a constraint violation is a 500 and a validation error is a message; this
-- is the backstop that makes the rule true of the data rather than true of
-- the one code path that happens to check it.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_ladder_order CHECK (
  "entitlementRevocationDelayDays" <= "disableGraceDays"
  AND ("archiveAfterDays" IS NULL OR "disableGraceDays" < "archiveAfterDays")
);

-- Percentages are percentages.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_thresholds_are_percent CHECK (
  "createAccountThresholdPercent"        BETWEEN 0 AND 100 AND
  "disableAccountThresholdPercent"       BETWEEN 0 AND 100 AND
  "archiveAccountThresholdPercent"       BETWEEN 0 AND 100 AND
  "revokeEntitlementThresholdPercent"    BETWEEN 0 AND 100 AND
  "deactivateSyntraUserThresholdPercent" BETWEEN 0 AND 100 AND
  "perEntitlementThresholdPercent"       BETWEEN 0 AND 100 AND
  "personPopulationDropPercent"          BETWEEN 0 AND 100
);

-- Writes to a target require an encrypted transport unconditionally. A
-- target that could be configured to write in the clear is a target that
-- eventually does, and Active Directory refuses a password write over an
-- unencrypted connection anyway.
-- The IS NOT NULL half is not redundant. `"config" ->> 'tlsMode'` yields SQL
-- NULL for a config object with no `tlsMode` key at all, `NULL IN (...)` is
-- NULL, and a CHECK constraint PASSES on NULL. Without it, the one config
-- shape that says nothing about its transport is the one shape this
-- constraint waves through.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_encrypted_transport CHECK (
  ("config" ->> 'tlsMode') IS NOT NULL
  AND ("config" ->> 'tlsMode') IN ('ldaps', 'starttls')
);
```

- [ ] **Step 8: Apply and regenerate**

```bash
cd packages/db && pnpm prisma migrate deploy && pnpm prisma generate
```

- [ ] **Step 9: Write the failing test**

`packages/db/src/provision-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let personId: string;
let targetId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
  provenanceAttribute: 'info',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', config, secretName: 'target/ad/bind' },
    });
    return { personId: person.id, targetId: target.id };
  });
  personId = seeded.personId;
  targetId = seeded.targetId;
});

describe('provision schema', () => {
  it('defaults a target to additive enforcement and the spec ladder', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Additive, because an engine that silently strips what it did not grant
    // gets switched off inside a week (Ruling P2).
    expect(target.enforcementMode).toBe('additive');
    expect(target.preHireDays).toBe(0);
    expect(target.entitlementRevocationDelayDays).toBe(0);
    // Zero: a leaver's access ends when their contract ends. Handover time is
    // a choice an organization makes, not a default it inherits.
    expect(target.disableGraceDays).toBe(0);
    expect(target.archiveAfterDays).toBeNull();
    expect(target.reenableWithoutConfirmationDays).toBe(7);
    expect(target.renameEnabled).toBe(false);
    expect(target.autoApply).toBe(false);
  });

  it('defaults every guard threshold to the spec value', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target.createAccountThresholdPercent).toBe(20);
    expect(target.disableAccountThresholdPercent).toBe(10);
    expect(target.archiveAccountThresholdPercent).toBe(2);
    expect(target.revokeEntitlementThresholdPercent).toBe(10);
    expect(target.deactivateSyntraUserThresholdPercent).toBe(10);
    expect(target.perEntitlementThresholdPercent).toBe(50);
    expect(target.personPopulationDropPercent).toBe(20);
    expect(target.maxAttempts).toBe(3);
    expect(target.concurrency).toBe(4);
  });

  it('starts a target with no skip history', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Ruling P4: this lives on the target row, not only in an audit event,
    // because the target row is where somebody looks.
    expect(target.consecutiveSkippedRuns).toBe(0);
    expect(target.lastSkippedAt).toBeNull();
    expect(target.lastSkipReason).toBeNull();
  });

  it('refuses a target configured to write in the clear', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.create({
          data: {
            tenantId,
            name: 'Plaintext',
            config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
            secretName: 'target/plain/bind',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a target whose config names no transport at all', async () => {
    // `config ->> 'tlsMode'` is SQL NULL when the key is absent, and a CHECK
    // constraint passes on NULL. The one config that says nothing about its
    // transport must not be the one config that gets through.
    const { tlsMode: _omitted, ...withoutTlsMode } = config;
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.create({
          data: {
            tenantId,
            name: 'Silent',
            config: withoutTlsMode,
            secretName: 'target/silent/bind',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a ladder that revokes entitlements after the account is disabled', async () => {
    // An account whose entitlements were stripped a week before it was
    // disabled belongs to somebody who is still employed as far as the
    // directory is concerned and cannot do anything.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.update({
          where: { id: targetId },
          data: { entitlementRevocationDelayDays: 7, disableGraceDays: 3 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an archive that lands on or before the disable', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.update({
          where: { id: targetId },
          data: { disableGraceDays: 30, archiveAfterDays: 30 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('accepts a ladder in the right order', async () => {
    const updated = await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          entitlementRevocationDelayDays: 0,
          disableGraceDays: 7,
          archiveAfterDays: 90,
        },
      }),
    );
    expect(updated.archiveAfterDays).toBe(90);
  });

  it('isolates targets between tenants', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const seen = await withTenant(other.id, (tx) => tx.targetSystem.findMany());
    expect(seen).toEqual([]);
  });

  it('allows one account per person per target and refuses a second', async () => {
    const row = {
      tenantId,
      targetSystemId: targetId,
      personId,
      correlationKey: 'a.novak',
    };
    await withTenant(tenantId, (tx) => tx.targetAccount.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.create({ data: { ...row, correlationKey: 'a.novak2' } }),
      ),
    ).rejects.toThrow();
  });

  it('reserves a correlation key even before the account exists in the target', async () => {
    const second = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Anne', familyName: 'Novak' },
      });
      return p.id;
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'a.novak' },
      }),
    );
    // Two runs generating the same name for two different people is a race
    // the database refuses, not one the application is trusted to avoid.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.create({
          data: {
            tenantId,
            targetSystemId: targetId,
            personId: second,
            correlationKey: 'a.novak',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows many pending accounts with a null anchor but only one per anchor', async () => {
    const second = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
      });
      return p.id;
    });
    // Two null anchors coexist -- this is the case a plain @@unique would
    // have permitted anyway, and it must keep working.
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'k1' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: second,
          correlationKey: 'k2',
        },
      });
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.updateMany({
        where: { correlationKey: 'k1' },
        data: { anchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'active' },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.updateMany({
          where: { correlationKey: 'k2' },
          data: { anchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows only one live holding per account and entitlement, and re-granting after a revoke', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'a.novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: '11111111-2222-3333-4444-555555555555',
          type: 'group',
          displayName: 'Finance',
        },
      });
      return { accountId: account.id, entitlementId: entitlement.id };
    });
    const holding = { tenantId, ...ids, origin: 'rule' };
    await withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding }));
    await expect(
      withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding })),
    ).rejects.toThrow();

    // Revoking frees the slot; the index only covers live rows, and the
    // revoked row stays for history.
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.updateMany({
        where: { accountId: ids.accountId },
        data: { revokedAt: new Date(), state: 'revoked' },
      }),
    );
    await withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding }));
    expect(
      await withTenant(tenantId, (tx) => tx.accountEntitlement.count()),
    ).toBe(2);
  });

  it('allows only one non-terminal run per target', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'running' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new run once the previous one reached a terminal status', async () => {
    const first = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({
        where: { id: first.id },
        data: { status: 'applied', finishedAt: new Date() },
      }),
    );
    const second = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'running' },
      }),
    );
    expect(second.status).toBe('running');
  });

  it('keeps one drift finding per fingerprint across runs', async () => {
    const runIds = await withTenant(tenantId, async (tx) => {
      const a = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applied' },
      });
      const b = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      });
      return [a.id, b.id];
    });
    const fingerprint = 'unmanaged_entitlement:acct-1:ent-1';
    await withTenant(tenantId, (tx) =>
      tx.driftFinding.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          runId: runIds[0]!,
          kind: 'unmanaged_entitlement',
          detail: {},
          fingerprint,
        },
      }),
    );
    // A finding that persists is updated, not duplicated, so the dashboard
    // counts problems rather than runs.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.driftFinding.create({
          data: {
            tenantId,
            targetSystemId: targetId,
            runId: runIds[1]!,
            kind: 'unmanaged_entitlement',
            detail: {},
            fingerprint,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('records an exception by person, not as a count', async () => {
    const runId = await withTenant(tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'previewed' },
        })
      ).id,
    );
    await withTenant(tenantId, (tx) =>
      tx.provisionException.create({
        data: {
          tenantId,
          runId,
          personId,
          targetSystemId: targetId,
          kind: 'no_contracts',
          message: 'Anna Novak holds no contracts at all',
        },
      }),
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany({ include: { person: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person.givenName).toBe('Anna');
    expect(rows[0]!.kind).toBe('no_contracts');
  });

  it('defaults an action to proposed and no confirmation', async () => {
    const runId = await withTenant(tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'previewed' },
        })
      ).id,
    );
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.create({
        data: { tenantId, runId, actionType: 'create_account', personId },
      }),
    );
    expect(action.status).toBe('proposed');
    expect(action.attempts).toBe(0);
    expect(action.requiresConfirmation).toBe(false);
    expect(action.attributedRuleIds).toEqual([]);
    // Defaulted so every fixture in this plan can create an action without
    // one; the run sets it explicitly from ACTION_ORDER (Task 13, phase 7).
    expect(action.sequence).toBe(0);
  });
});
```

- [ ] **Step 10: Run the test**

Run: `pnpm vitest run packages/db/src/provision-schema.test.ts`
Expected: PASS, 18 tests.

If "allows only one non-terminal run per target" does not reject, the partial unique index was not created and spec §10's staleness rule is unenforced — two overlapping plans could interleave against one target. If "allows only one live holding" does not reject, `account_entitlement_one_live` is missing. Do not proceed past either.

- [ ] **Step 11: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. Vitest does not type-check, so a passing test above says nothing about this.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: add provision targets data model"
```

---

## Task 2: The target connector interface, the write union, and the fake target

**Files:**
- Modify: `packages/connectors/src/types.ts`
- Create: `packages/connectors/src/testing/fake-target.ts`
- Modify: `packages/connectors/src/index.ts`
- Modify: `packages/connectors/src/ldap/connector.test.ts` — the one existing caller of `write`
- Test: `packages/connectors/src/types.test.ts` (extend), `packages/connectors/src/testing/fake-target.test.ts`

**Interfaces:**
- Consumes: the existing `Connector<C>`, `SourceRecord`, `ConnectionResult`, `SchemaDescriptor`, `first` from `packages/connectors/src/types.ts`.
- Produces:
  - `type ProvisionActionType = 'create_account' | 'update_account' | 'enable_account' | 'disable_account' | 'archive_account' | 'rename_account' | 'grant_entitlement' | 'revoke_entitlement' | 'deactivate_syntra_user' | 'reactivate_syntra_user'`
  - `const CONNECTOR_ACTION_TYPES: readonly ProvisionActionType[]` — the eight that reach a connector.
  - `const SYNTRA_ONLY_ACTION_TYPES: readonly ProvisionActionType[]` — the two that do not.
  - `type WriteOperation` — the tagged union of spec §5, discriminated on `op`.
  - `type WriteFailure = 'transient' | 'throttled' | 'conflict' | 'rejected' | 'unauthorized' | 'not_found'`
  - `interface WriteResult { ok: boolean; message: string; anchor?: string; failure?: WriteFailure; retryAfterMs?: number }`
  - `interface DiscoveredEntitlement { externalId: string; dn: string; type: 'group' | 'licence' | 'role'; displayName: string; description?: string }`
  - `interface TargetConnector<C> extends Connector<C> { listEntitlements(config: C): AsyncIterable<DiscoveredEntitlement>; listContainers(config: C): AsyncIterable<{ dn: string }>; readEntitlementMembers(config: C, entitlementDn: string): Promise<string[]> }`
  - `function isRetryable(failure: WriteFailure | undefined): boolean`
  - `class FakeTarget implements TargetConnector<FakeTargetConfig>` with `program(op, outcome)`, `objects`, `holdings`, `calls`, `entitlements`, `containers`.

**Two members exist because of what the consumer cannot infer, and one field because of what the consumer must not invent.**

`listContainers` exists because Task 13 otherwise derives the set of containers a target holds from the DNs of the accounts it returned - which means a container holding no accounts is invisible, and on a first run against an empty target *every* container is invisible and every person becomes `container_missing`. Containers are read, never inferred, and the check never skips: spec section 6 is explicit that Provision does not create organizational units in somebody else's domain, so a check that disables itself on an empty set is a fail-open on exactly the thing it guards (Ruling P9).

`DiscoveredEntitlement.dn` exists because Active Directory reports a user's group membership in `memberOf` as **distinguished names**, and `externalId` is the group's **objectGUID**. Without the DN there is no way to turn a membership list into entitlement ids, and every lookup misses silently - which reads as "this account holds nothing", proposes a grant for the whole population every run, and leaves the revocation guard with a denominator of zero.

**Ruling P8 binds `FakeTarget` for the rest of this slice: a fake reproduces the real system's identifier semantics or it is not a test double, it is a second implementation of the bug.** Where Active Directory returns DNs, `FakeTarget` returns DNs. Its `read` therefore emits `memberOf` as DNs and its `write` resolves an `entitlementId` (an objectGUID) to a DN through its own catalog, exactly as `adTargetConnector` resolves one through `groupDnFor`. That makes it slightly more tedious to seed, and it is the whole reason the run-service tests exercise the mapping that production actually runs.

- [ ] **Step 1: Write the failing structural test**

Append the `describe` blocks below to `packages/connectors/src/types.test.ts`, and **merge** the imports rather than pasting them - that file already opens with `import { describe, expect, it } from 'vitest';` and its own `./types.js` import, and appending this block verbatim redeclares all three vitest identifiers. Add `CONNECTOR_ACTION_TYPES`, `SYNTRA_ONLY_ACTION_TYPES`, `isRetryable`, `type ProvisionActionType` and `type WriteOperation` to the existing `./types.js` import.

```ts
// Imports are MERGED into the file's existing ones, not appended:
//   import { describe, expect, it } from 'vitest';
//   import {
//     CONNECTOR_ACTION_TYPES,
//     SYNTRA_ONLY_ACTION_TYPES,
//     isRetryable,
//     type ProvisionActionType,
//     type WriteOperation,
//   } from './types.js';

/**
 * Spec section 9: Provision never deletes. Not after any grace period, not
 * under any configuration, not on any code path.
 *
 * This test exists so that adding a destructive member to the action union
 * fails a test rather than passing review. It is deliberately written as an
 * exhaustive enumeration rather than a regex over the type, because a type is
 * erased at run time and cannot be asserted on -- so the enumeration is the
 * value the rest of the system iterates, and this is what pins it.
 */
describe('the action-type union', () => {
  const EXPECTED: ProvisionActionType[] = [
    'create_account',
    'update_account',
    'enable_account',
    'disable_account',
    'archive_account',
    'rename_account',
    'grant_entitlement',
    'revoke_entitlement',
    'deactivate_syntra_user',
    'reactivate_syntra_user',
  ];

  it('contains exactly the ten action types the spec names', () => {
    expect([...CONNECTOR_ACTION_TYPES, ...SYNTRA_ONLY_ACTION_TYPES].sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });

  it('contains no member whose name suggests destruction', () => {
    // A member called delete_account, purge_account, remove_account or
    // destroy_entitlement would pass every other test in this repository.
    const forbidden = /delete|destroy|purge|erase|wipe|remove_account|drop/i;
    for (const type of [...CONNECTOR_ACTION_TYPES, ...SYNTRA_ONLY_ACTION_TYPES]) {
      expect(type).not.toMatch(forbidden);
    }
  });

  it('routes exactly two action types away from any connector', () => {
    // deactivate_syntra_user and reactivate_syntra_user are writes to Syntra's
    // own directory (spec section 4). They call no connector at all, which is
    // why they are the only two that apply inside a single transaction with
    // their audit event and need no in-flight resolution.
    expect([...SYNTRA_ONLY_ACTION_TYPES].sort()).toEqual([
      'deactivate_syntra_user',
      'reactivate_syntra_user',
    ]);
  });

  it('maps every connector action type onto exactly one write operation', () => {
    // Every WriteOperation `op` is a connector action type and vice versa. A
    // connector action with no operation could never be applied; an operation
    // with no action type could never be proposed.
    const ops: WriteOperation['op'][] = [
      'create_account',
      'update_account',
      'enable_account',
      'disable_account',
      'archive_account',
      'rename_account',
      'grant_entitlement',
      'revoke_entitlement',
    ];
    expect([...CONNECTOR_ACTION_TYPES].sort()).toEqual([...ops].sort());
  });
});

describe('isRetryable', () => {
  it('retries transient and throttled, and nothing else', () => {
    // A duplicate name, a schema violation, a refused password complexity, a
    // revoked service credential and a deleted entitlement do not become true
    // on the fourth attempt.
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('throttled')).toBe(true);
    expect(isRetryable('conflict')).toBe(false);
    expect(isRetryable('rejected')).toBe(false);
    expect(isRetryable('unauthorized')).toBe(false);
    expect(isRetryable('not_found')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/connectors/src/types.test.ts`
Expected: FAIL — `CONNECTOR_ACTION_TYPES` is not exported from `./types.js`.

- [ ] **Step 3: Replace `WriteOperation` and `WriteResult` in the connector types**

In `packages/connectors/src/types.ts`, **delete** these two declarations:

```ts
export interface WriteOperation {
  objectType: ObjectType;
  anchor: string;
  attributes: Record<string, string[]>;
}

export interface WriteResult {
  ok: boolean;
  message: string;
}
```

and put this in their place:

```ts
/**
 * Every action Provision can propose. There is no delete of any kind, and no
 * type that could become one: `archive_account` moves the object and strips
 * the entitlements Provision manages, and leaves the object, its mailbox and
 * its file ownership intact.
 *
 * The failure mode of this subsystem is *mass* action -- a misconfigured
 * source, an inverted condition, an HR export that ran against an empty
 * staging database. The characteristic accident is not one wrong person, it
 * is four thousand. Every action here therefore has to be one that four
 * thousand instances of can be walked back. Disable satisfies that. Delete
 * does not.
 */
export type ProvisionActionType =
  | 'create_account'
  | 'update_account'
  | 'enable_account'
  | 'disable_account'
  | 'archive_account'
  | 'rename_account'
  | 'grant_entitlement'
  | 'revoke_entitlement'
  | 'deactivate_syntra_user'
  | 'reactivate_syntra_user';

/** The eight that reach a connector, in the order enforcement applies them. */
export const CONNECTOR_ACTION_TYPES = [
  'create_account',
  'update_account',
  'enable_account',
  'disable_account',
  'archive_account',
  'rename_account',
  'grant_entitlement',
  'revoke_entitlement',
] as const satisfies readonly ProvisionActionType[];

/**
 * The two that call no connector at all. They are writes to Syntra's own
 * directory, and are therefore the only two that apply inside a single
 * transaction with their audit event and need no in-flight resolution.
 */
export const SYNTRA_ONLY_ACTION_TYPES = [
  'deactivate_syntra_user',
  'reactivate_syntra_user',
] as const satisfies readonly ProvisionActionType[];

/**
 * A tagged union rather than a bag of attributes with a mode flag, because
 * the operations a target supports are genuinely different operations.
 *
 * `actionId` is on every operation: it is the id of the ProvisionAction row
 * that proposed this write, and the connector records it on the object it
 * creates wherever the target offers somewhere to put it. That is what makes
 * a non-idempotent create safe to retry.
 *
 * `update_account` carries the COMPLETE set of managed attributes, not a
 * delta. The connector writes desired state, so receiving the same
 * `update_account` twice performs the same write twice and leaves the same
 * result -- which is what makes retry free for the majority of operations.
 *
 * `create_account` carries a correlation key and no anchor, because the
 * anchor does not exist yet; it comes back in the result. Every other
 * operation carries an anchor, because by then it does.
 *
 * `create_account.initialPassword` is supplied by the caller and never
 * invented by the connector. A password the connector generates internally is
 * a password that is written to the directory and then dropped on the floor:
 * nothing carries it back out, so no account Provision creates is usable by
 * the person it was created for, and the target's `initialPasswordPolicy` and
 * `initialPasswordDelivery` settings have nothing behind them. The caller
 * generates it, seals it into the vault and delivers it (Task 14).
 *
 * `archive_account.entitlementDns` is the set Provision manages for that
 * account, resolved by the caller. The connector iterates THAT list, never the
 * object's own `memberOf`: "Provision manages this target" and "Provision
 * manages every group in this target" are different claims and only the first
 * is ever true (spec section 12), and archiving is the closest thing to
 * destructive in the ladder (spec section 9), which is the last place to widen
 * a remit.
 */
export type WriteOperation =
  | {
      op: 'create_account';
      actionId: string;
      correlationKey: string;
      attributes: Record<string, string[]>;
      enabled: boolean;
      /** Generated by the caller, never by the connector. Never logged. */
      initialPassword: string;
    }
  | {
      op: 'update_account';
      actionId: string;
      anchor: string;
      attributes: Record<string, string[]>;
    }
  | { op: 'enable_account'; actionId: string; anchor: string }
  | { op: 'disable_account'; actionId: string; anchor: string; reason: string }
  | {
      op: 'archive_account';
      actionId: string;
      anchor: string;
      /** The DNs of the entitlements Provision manages for this account. */
      entitlementDns: string[];
    }
  | {
      op: 'rename_account';
      actionId: string;
      anchor: string;
      correlationKey: string;
    }
  | {
      op: 'grant_entitlement';
      actionId: string;
      anchor: string;
      entitlementId: string;
    }
  | {
      op: 'revoke_entitlement';
      actionId: string;
      anchor: string;
      entitlementId: string;
    };

/**
 * A closed set decided by the connector, not a string the run pattern-matches.
 * Only the connector knows whether an LDAP `busy` or an HTTP 429 is worth
 * another attempt; getting the classification into the connector, where the
 * target-specific knowledge is, is what keeps the retry logic in the run
 * generic.
 */
export type WriteFailure =
  | 'transient'
  | 'throttled'
  | 'conflict'
  | 'rejected'
  | 'unauthorized'
  | 'not_found';

export interface WriteResult {
  ok: boolean;
  message: string;
  /** Present on a successful create: the target's identifier for the object. */
  anchor?: string;
  failure?: WriteFailure;
  /** Honoured on `throttled`, where the target supplies one. */
  retryAfterMs?: number;
}

/**
 * `transient` is retried, `throttled` is retried after `retryAfterMs`, and
 * nothing else is.
 */
export function isRetryable(failure: WriteFailure | undefined): boolean {
  return failure === 'transient' || failure === 'throttled';
}

/**
 * One of the rights the bind needs, and whether `test` could confirm it.
 *
 * Spec section 18: the service account should hold only the rights it needs,
 * and `test` reports which of those it could not exercise, so an
 * over-privileged bind is a visible choice rather than a default.
 *
 * `unverified` is a third state and not a polite `granted`. A server that does
 * not publish effective rights cannot be read as having granted them, and
 * collapsing the two would turn "we could not tell" into "yes".
 */
export interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

/** The grantable things a target offers. */
export interface DiscoveredEntitlement {
  /** The target's immutable identifier. Never the display name. */
  externalId: string;
  /**
   * The target's distinguished name for this object, as read.
   *
   * Not the identity -- `externalId` is, and a rename changes this and not
   * that. It is here because Active Directory reports a user's memberships as
   * a list of DNs and never as objectGUIDs, so without it there is no way to
   * turn a membership list back into entitlement ids, and every lookup misses
   * in a way no test notices.
   */
  dn: string;
  type: 'group' | 'licence' | 'role';
  displayName: string;
  description?: string;
}
```

- [ ] **Step 4: Add `TargetConnector` and widen `Connector.write`**

In `packages/connectors/src/types.ts`, replace the `Connector<C>` interface with:

```ts
export interface Connector<C> {
  test(config: C): Promise<ConnectionResult>;
  discoverSchema(config: C): Promise<SchemaDescriptor>;
  read(config: C): AsyncIterable<SourceRecord>;
  write(config: C, op: WriteOperation): Promise<WriteResult>;
}
```

Then widen `ConnectionResult` in place -- it is declared above `Connector` in the same file -- and add `TargetConnector` below it. The new `ConnectionResult` field is optional, so the existing directory-source connector is unaffected and nothing else in the repository has to change:

```ts
export interface ConnectionResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<ObjectType, number>;
  /** Which of the rights a target connector needs it could confirm. */
  rights?: ConnectorRight[];
}

/**
 * A target connector is a Connector plus one member.
 *
 * `read` is not a leftover here. It is how Provision learns what the target
 * currently holds, which is the input to reconciliation: the same paged,
 * anchor-normalising reader Directory Sync uses to pull Active Directory in
 * is what Provision uses to ask the target what it thinks is true. A target
 * connector that could only write would have no way to converge.
 */
export interface TargetConnector<C> extends Connector<C> {
  /** The grantable things this target offers: groups, licences, roles. */
  listEntitlements(config: C): AsyncIterable<DiscoveredEntitlement>;

  /**
   * The containers this target holds -- organizational units and containers --
   * so that an account can be placed only where something already exists.
   *
   * Read, never inferred. Deriving the set from the DNs of the accounts the
   * target returned makes an empty-but-real container invisible, and on a
   * first run against an empty target makes EVERY container invisible: every
   * person becomes `container_missing`, the run proposes nothing, and the
   * container can never become visible because no account can ever be created
   * in it. That is a deadlock wearing a safety argument.
   *
   * The check must not skip itself when the set comes back empty either. Spec
   * section 6 is explicit that silently creating organizational units in
   * somebody else's domain is not a thing this product does, and a check that
   * disables itself on the one input that should trigger it is a fail-open on
   * exactly that (Ruling P9). An empty set from a reachable target means the
   * target genuinely has no containers, and that is a configuration error
   * somebody needs to be told about by name.
   */
  listContainers(config: C): AsyncIterable<{ dn: string }>;

  /**
   * Every member of one entitlement, in full, or a throw.
   *
   * **Never a partial list.** Half a membership read as a whole one is the
   * single most dangerous value in this subsystem: a group with 4,000 members
   * that reads as 1,500 makes the diff propose granting it to 2,500 people or
   * revoking it from them, depending on which way the rules fall. Active
   * Directory truncates above `MaxValRange` and the walk that completes it can
   * fail partway, so the contract here is all or an exception -- and the run
   * marks the entitlement `unreadable`, which makes every rule naming it
   * unresolvable rather than silently narrower.
   *
   * On the interface rather than as a loose export because the run has to call
   * it through whatever connector it was handed, and a check the fake cannot
   * exercise is a check nothing tests.
   */
  readEntitlementMembers(config: C, entitlementDn: string): Promise<string[]>;
}
```

Widening `WriteOperation` and `WriteResult` breaks nothing: `write` has no implementation anywhere. The one existing implementation is `ldapConnector.write`, which returns `{ ok: false, message: '...' }` and still satisfies the wider result type, because `anchor`, `failure` and `retryAfterMs` are all optional.

- [ ] **Step 5: Rewrite the one existing test that builds the old `WriteOperation`**

`packages/connectors/src/ldap/connector.test.ts` already contains this, and it is checked against the interface signature because `ldapConnector` is typed `Connector<Config>`:

```ts
describe('ldapConnector.write', () => {
  it('refuses, since writing back is not in this slice', async () => {
    const result = await ldapConnector.write(config, {
      objectType: 'user',
      anchor: 'a1',
      attributes: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
  });
});
```

Step 3 deleted that `WriteOperation` shape, so the object literal now matches no member of the tagged union and `pnpm typecheck` fails. Replace the whole `describe` block with:

```ts
describe('ldapConnector.write', () => {
  it('refuses, since writing back is not in this slice', async () => {
    // A real member of the tagged union. The directory-source connector is a
    // reader: it satisfies the widened signature and refuses every operation,
    // which is what keeps `write` on `Connector<C>` rather than only on
    // `TargetConnector<C>` honest.
    const result = await ldapConnector.write(config, {
      op: 'disable_account',
      actionId: 'action-1',
      anchor: 'a1',
      reason: 'unused',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
  });
});
```

This file is not mentioned anywhere else in the plan, and it is the only existing caller of `write`. Missing it is the shape that stopped a task dead on the previous branch: a task that changes a shared interface has to grep for its existing implementors and callers before it changes it.

Run: `grep -rn "\.write(" packages/connectors/src --include=*.ts` and confirm the only hits are this test, the fake target and the AD connector.

- [ ] **Step 6: Run the structural test**

Run: `pnpm vitest run packages/connectors/src/types.test.ts`
Expected: PASS. Then run `pnpm typecheck` here as well, not only at step 12 - step 3 changed a shared interface, and this is the first point at which a missed implementor shows up.

- [ ] **Step 7: Write the failing fake-target test**

`packages/connectors/src/testing/fake-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTarget } from './fake-target.js';

const config = { domain: 'acme.test' };
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';

const create = (actionId: string, correlationKey: string) =>
  ({
    op: 'create_account' as const,
    actionId,
    correlationKey,
    attributes: {
      displayName: ['Anna Novak'],
      distinguishedName: [`CN=${correlationKey},${USERS}`],
    },
    enabled: true,
    // Supplied by the caller, never invented by the connector. The fake stores
    // nothing of it, which is what lets Task 14 assert that no ProvisionAction
    // and no AuditEvent ever carries it.
    initialPassword: 'Aa1!fake-initial-password',
  });

/** A target that offers one group, in one container. */
const seeded = () => {
  const target = new FakeTarget();
  target.containers.push(USERS, 'OU=Groups,DC=acme,DC=test');
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });
  return target;
};

describe('FakeTarget', () => {
  it('creates an account and returns an anchor', async () => {
    const target = new FakeTarget();
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.ok).toBe(true);
    expect(result.anchor).toBeDefined();
    expect(target.objects.get(result.anchor!)?.correlationKey).toBe('a.novak');
  });

  it('retries a transient failure and succeeds on the second attempt', async () => {
    const target = new FakeTarget();
    target.program('create_account', { failTimes: 1, failure: 'transient' });
    const first = await target.write(config, create('act-1', 'a.novak'));
    expect(first.ok).toBe(false);
    expect(first.failure).toBe('transient');
    const second = await target.write(config, create('act-1', 'a.novak'));
    expect(second.ok).toBe(true);
  });

  it('reports a permanent rejection that must not be retried', async () => {
    const target = new FakeTarget();
    target.program('create_account', { failTimes: Infinity, failure: 'rejected' });
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.failure).toBe('rejected');
  });

  it('reports a throttle with a retry-after', async () => {
    const target = seeded();
    target.program('grant_entitlement', {
      failTimes: 1,
      failure: 'throttled',
      retryAfterMs: 2500,
    });
    const result = await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: 'anchor-1',
      entitlementId: 'guid-finance',
    });
    expect(result.failure).toBe('throttled');
    expect(result.retryAfterMs).toBe(2500);
  });

  it('adopts its own lost create rather than duplicating it', async () => {
    // The create landed at the target and the response was lost. On retry the
    // connector looks up the correlation key, finds the provenance marker
    // carrying THIS actionId, and adopts.
    const target = new FakeTarget();
    target.program('create_account', { loseResponseTimes: 1 });
    const lost = await target.write(config, create('act-1', 'a.novak'));
    expect(lost.ok).toBe(false);
    expect(lost.failure).toBe('transient');
    expect(target.objects.size).toBe(1);

    const retry = await target.write(config, create('act-1', 'a.novak'));
    expect(retry.ok).toBe(true);
    // One object, not two. This is the whole point of the provenance marker.
    expect(target.objects.size).toBe(1);
    expect(retry.message).toContain('adopted');
  });

  it('conflicts rather than adopting somebody else account', async () => {
    // Same name, different provenance. Never a silent adoption: anybody able
    // to create an object in the target could otherwise choose a name that
    // causes Syntra to hand them an existing person's account, along with
    // every entitlement the rules will then grant it.
    const target = new FakeTarget();
    target.seedForeignObject('a.novak');
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('conflict');
    expect(target.objects.size).toBe(1);
  });

  it('treats granting a held entitlement and revoking an unheld one as successes', async () => {
    const target = seeded();
    target.entitlements.push({
      externalId: 'guid-teaching',
      dn: 'CN=Teaching,OU=Groups,DC=acme,DC=test',
      type: 'group',
      displayName: 'Teaching',
    });
    const created = await target.write(config, create('act-1', 'a.novak'));
    const anchor = created.anchor!;
    const grant = {
      op: 'grant_entitlement' as const,
      actionId: 'act-2',
      anchor,
      entitlementId: 'guid-finance',
    };
    expect((await target.write(config, grant)).ok).toBe(true);
    // Set operations. Granting twice is the same state, not an error.
    expect((await target.write(config, grant)).ok).toBe(true);
    // Held BY DN, because that is what Active Directory holds and what its
    // `member` and `memberOf` attributes contain. The caller passes an
    // objectGUID and the connector resolves it, exactly as groupDnFor does.
    expect(target.holdings.get(anchor)).toEqual(new Set([FINANCE_DN]));

    const revoke = {
      op: 'revoke_entitlement' as const,
      actionId: 'act-3',
      anchor,
      entitlementId: 'guid-teaching',
    };
    expect((await target.write(config, revoke)).ok).toBe(true);
  });

  it('refuses a grant of an entitlement the target does not offer', async () => {
    // groupDnFor returns undefined and the real connector answers not_found.
    // A fake that quietly accepted an unknown identifier would let the whole
    // externalId-to-DN mapping go untested.
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    const result = await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: created.anchor!,
      entitlementId: 'guid-nowhere',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });

  it('reports membership the way a directory does: as distinguished names', async () => {
    // Ruling P8. Active Directory reports memberOf as DNs, never as
    // objectGUIDs, so this fake does too -- which is what makes Task 13's
    // DN-to-entitlement mapping something the run-service tests exercise
    // rather than something production discovers.
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: created.anchor!,
      entitlementId: 'guid-finance',
    });
    const records = [];
    for await (const record of target.read(config)) records.push(record);
    expect(records[0]!.attributes.memberOf).toEqual([FINANCE_DN]);
    expect(records[0]!.dn).toBe(`CN=a.novak,${USERS}`);
  });

  it('lists the containers it was seeded with, and nothing derived from its accounts', async () => {
    // Containers are read, not inferred. An empty-but-real container has to be
    // visible or a first run against an empty target proposes nothing at all.
    const target = seeded();
    const found = [];
    for await (const container of target.listContainers(config)) found.push(container.dn);
    expect(found).toEqual([USERS, 'OU=Groups,DC=acme,DC=test']);
  });

  it('archives by stripping only the entitlements it was handed', async () => {
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    const anchor = created.anchor!;
    await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor,
      entitlementId: 'guid-finance',
    });
    // A membership no business rule mentions: outside Provision's remit, and
    // an archive must not touch it.
    target.holdings.get(anchor)!.add('CN=Sports Club,OU=Groups,DC=acme,DC=test');

    const result = await target.write(config, {
      op: 'archive_account',
      actionId: 'act-3',
      anchor,
      entitlementDns: [FINANCE_DN],
    });
    expect(result.ok).toBe(true);
    expect(target.holdings.get(anchor)).toEqual(
      new Set(['CN=Sports Club,OU=Groups,DC=acme,DC=test']),
    );
    // The object itself is intact and merely disabled. It never deletes.
    expect(target.objects.get(anchor)?.archived).toBe(true);
  });

  it('returns nothing at all when programmed empty', async () => {
    // An empty target and an unreachable one look identical from here, and
    // the guard has to be able to exercise that.
    const target = new FakeTarget();
    target.seedForeignObject('someone');
    target.returnsNothing = true;
    const records = [];
    for await (const record of target.read(config)) records.push(record);
    expect(records).toEqual([]);
  });

  it('has no delete method of any kind', async () => {
    const target = new FakeTarget();
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(target));
    expect(names.filter((n) => /delete|destroy|purge|remove/i.test(n))).toEqual([]);
  });
});
```

- [ ] **Step 8: Run it to see it fail**

Run: `pnpm vitest run packages/connectors/src/testing/fake-target.test.ts`
Expected: FAIL — cannot find module `./fake-target.js`.

- [ ] **Step 9: Write the fake target**

`packages/connectors/src/testing/fake-target.ts`:

```ts
import type {
  ConnectionResult,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteFailure,
  WriteOperation,
  WriteResult,
} from '../types.js';

export interface FakeTargetConfig {
  domain: string;
}

/** How the next N calls of one operation should behave. */
export interface ProgrammedOutcome {
  /** How many of the next calls fail. `Infinity` for a permanent failure. */
  failTimes?: number;
  failure?: WriteFailure;
  retryAfterMs?: number;
  /**
   * The write LANDS at the target and then the response is lost. Distinct
   * from `failTimes`, which does not land. This is the case the provenance
   * marker exists for, and the one a naive retry duplicates.
   */
  loseResponseTimes?: number;
}

interface FakeObject {
  anchor: string;
  correlationKey: string;
  /** Where the object sits. A directory has one; a Map keyed on anchor does not. */
  dn: string;
  attributes: Record<string, string[]>;
  enabled: boolean;
  archived: boolean;
  /** The actionId that created it, or null for an object Syntra never made. */
  provenance: string | null;
}

/** Where a create lands when the operation names no distinguished name. */
const DEFAULT_CONTAINER = 'OU=Users,DC=acme,DC=test';

/**
 * An in-memory TargetConnector with programmable failures.
 *
 * Exists so that every failure path in the enforcement loop -- transient,
 * permanent, throttled, lost response, foreign collision, empty target -- is
 * exercised deterministically and without a container. The Samba container in
 * Task 4 proves the Active Directory *connector*; this proves the *run*.
 */
export class FakeTarget implements TargetConnector<FakeTargetConfig> {
  readonly objects = new Map<string, FakeObject>();
  /**
   * Anchor to the set of group **distinguished names** it holds.
   *
   * DNs, not entitlement ids and not objectGUIDs, because that is what a
   * directory holds: `member` on the group and `memberOf` on the user are both
   * lists of DNs. Keying this the way the caller finds convenient was the
   * defect Ruling P8 exists to prevent -- it made the whole externalId-to-DN
   * mapping untested, and against real Active Directory every managed holding
   * became permanent drift.
   */
  readonly holdings = new Map<string, Set<string>>();
  readonly calls: WriteOperation[] = [];
  /** The catalog. `write` resolves an entitlementId to a DN through this. */
  readonly entitlements: DiscoveredEntitlement[] = [];
  /** The containers this target holds. Read by `listContainers`, never inferred. */
  readonly containers: string[] = [];
  /**
   * Entitlement DNs whose membership cannot be read.
   *
   * Seedable so the run-service tests can exercise the path a truncated Active
   * Directory group takes: the read throws, the run marks the entitlement
   * `unreadable`, and every rule naming it makes its people exceptions instead
   * of proposing grants and revocations against half a membership.
   */
  readonly unreadableEntitlementDns = new Set<string>();
  /** Makes `read` return nothing while objects exist -- an outage, not an empty domain. */
  returnsNothing = false;

  private programmed = new Map<WriteOperation['op'], ProgrammedOutcome>();
  private counter = 0;

  program(op: WriteOperation['op'], outcome: ProgrammedOutcome): void {
    this.programmed.set(op, { ...outcome });
  }

  /** An object at this correlation key that Syntra did not create. */
  seedForeignObject(correlationKey: string, container = DEFAULT_CONTAINER): string {
    const anchor = this.nextAnchor();
    this.objects.set(anchor, {
      anchor,
      correlationKey,
      dn: `CN=${correlationKey},${container}`,
      attributes: {},
      enabled: true,
      archived: false,
      provenance: null,
    });
    return anchor;
  }

  /** The DN of an entitlement, or undefined. The fake's `groupDnFor`. */
  private dnForEntitlement(externalId: string): string | undefined {
    return this.entitlements.find((e) => e.externalId === externalId)?.dn;
  }

  async test(): Promise<ConnectionResult> {
    return { ok: true, message: 'fake target reachable' };
  }

  async discoverSchema(): Promise<SchemaDescriptor> {
    return { objectClasses: ['user', 'group'], attributes: ['displayName'] };
  }

  async *read(): AsyncIterable<SourceRecord> {
    if (this.returnsNothing) return;
    for (const object of this.objects.values()) {
      yield {
        anchor: object.anchor,
        objectType: 'user',
        dn: object.dn,
        attributes: {
          ...object.attributes,
          sAMAccountName: [object.correlationKey],
          userAccountControl: [object.enabled ? '512' : '514'],
          info: object.provenance ? [object.provenance] : [],
          // DNs. Ruling P8: where the real system returns DNs, so does this.
          memberOf: [...(this.holdings.get(object.anchor) ?? [])],
        },
      };
    }
  }

  async *listEntitlements(): AsyncIterable<DiscoveredEntitlement> {
    for (const entitlement of this.entitlements) yield entitlement;
  }

  async readEntitlementMembers(
    _config: FakeTargetConfig,
    entitlementDn: string,
  ): Promise<string[]> {
    if (this.unreadableEntitlementDns.has(entitlementDn)) {
      throw new Error(
        `the directory stopped returning member on ${entitlementDn} partway through a ranged read`,
      );
    }
    const members: string[] = [];
    for (const [anchor, held] of this.holdings) {
      if (!held.has(entitlementDn)) continue;
      const object = this.objects.get(anchor);
      if (object) members.push(object.dn);
    }
    return members;
  }

  async *listContainers(): AsyncIterable<{ dn: string }> {
    // Exactly what it was seeded with. Never derived from the accounts it
    // holds: an empty container is a real thing, and a first run against an
    // empty target must still be able to place an account somewhere.
    for (const dn of this.containers) yield { dn };
  }

  async write(
    _config: FakeTargetConfig,
    op: WriteOperation,
  ): Promise<WriteResult> {
    this.calls.push(op);
    const outcome = this.programmed.get(op.op);

    if (outcome?.loseResponseTimes) {
      outcome.loseResponseTimes -= 1;
      this.perform(op);
      // The write landed. The caller is told it did not, which is exactly the
      // state a lost response leaves the run in.
      return { ok: false, message: 'connection reset after write', failure: 'transient' };
    }

    if (outcome?.failTimes && outcome.failTimes > 0) {
      outcome.failTimes -= 1;
      const failure = outcome.failure ?? 'transient';
      return {
        ok: false,
        message: `programmed ${failure}`,
        failure,
        ...(outcome.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: outcome.retryAfterMs }),
      };
    }

    return this.perform(op);
  }

  private perform(op: WriteOperation): WriteResult {
    switch (op.op) {
      case 'create_account': {
        const existing = [...this.objects.values()].find(
          (o) => o.correlationKey === op.correlationKey,
        );
        if (existing) {
          // Present, carrying THIS actionId -- our own previous attempt
          // succeeded and we lost the answer. Adopt it.
          if (existing.provenance === op.actionId) {
            return {
              ok: true,
              message: 'adopted the account this action already created',
              anchor: existing.anchor,
            };
          }
          // Present, carrying anything else or nothing. Never adopted.
          return {
            ok: false,
            message: `an account named ${op.correlationKey} already exists and was not created by this action`,
            failure: 'conflict',
          };
        }
        const anchor = this.nextAnchor();
        // The password is used and not kept. Nothing on FakeObject, nothing in
        // `calls`' stored copy that a later assertion could read back, and
        // nothing in any WriteResult: a fake that retained it would let a leak
        // through the action and audit rows pass unnoticed.
        this.objects.set(anchor, {
          anchor,
          correlationKey: op.correlationKey,
          dn:
            op.attributes.distinguishedName?.[0] ??
            `CN=${op.correlationKey},${this.containers[0] ?? DEFAULT_CONTAINER}`,
          attributes: Object.fromEntries(
            Object.entries(op.attributes).filter(([key]) => key !== 'distinguishedName'),
          ),
          enabled: op.enabled,
          archived: false,
          provenance: op.actionId,
        });
        return { ok: true, message: 'created', anchor };
      }
      case 'update_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        // Desired state, not a delta: the same update twice leaves the same
        // result, which is what makes retry free. A distinguishedName in the
        // set is a move, exactly as it is on the AD connector, and the anchor
        // is unchanged by it -- which is the point of anchoring on objectGUID.
        const moved = op.attributes.distinguishedName?.[0];
        if (moved !== undefined) object.dn = moved;
        object.attributes = Object.fromEntries(
          Object.entries(op.attributes).filter(([key]) => key !== 'distinguishedName'),
        );
        return { ok: true, message: 'updated' };
      }
      case 'enable_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.enabled = true;
        return { ok: true, message: 'enabled' };
      }
      case 'disable_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.enabled = false;
        object.attributes = { ...object.attributes, info: [op.reason] };
        return { ok: true, message: 'disabled' };
      }
      case 'archive_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.archived = true;
        object.enabled = false;
        // Strips ONLY the entitlements it was handed -- the ones Provision
        // manages for this account. Clearing every membership would assert
        // that Provision manages every group in the target, which is never
        // true, and archive is the closest thing to destructive in the ladder.
        // The object, its attributes and any membership outside the remit are
        // left intact. It never deletes.
        const held = this.holdings.get(op.anchor);
        if (held) for (const dn of op.entitlementDns) held.delete(dn);
        return { ok: true, message: 'archived' };
      }
      case 'rename_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        const container = object.dn.slice(object.dn.indexOf(',') + 1);
        object.correlationKey = op.correlationKey;
        object.dn = `CN=${op.correlationKey},${container}`;
        return { ok: true, message: 'renamed' };
      }
      case 'grant_entitlement': {
        if (!this.objects.has(op.anchor)) return this.gone(op.anchor);
        // The caller passes the target's own identifier for the entitlement --
        // an objectGUID -- and the connector resolves it to the DN the
        // directory actually holds. An identifier the target does not offer is
        // not_found, which is what adTargetConnector answers when groupDnFor
        // comes back undefined.
        const dn = this.dnForEntitlement(op.entitlementId);
        if (dn === undefined) return this.noSuchEntitlement(op.entitlementId);
        const held = this.holdings.get(op.anchor) ?? new Set<string>();
        held.add(dn);
        this.holdings.set(op.anchor, held);
        return { ok: true, message: 'granted' };
      }
      case 'revoke_entitlement': {
        if (!this.objects.has(op.anchor)) return this.gone(op.anchor);
        const dn = this.dnForEntitlement(op.entitlementId);
        if (dn === undefined) return this.noSuchEntitlement(op.entitlementId);
        // A set operation: revoking an unheld entitlement is a success.
        this.holdings.get(op.anchor)?.delete(dn);
        return { ok: true, message: 'revoked' };
      }
    }
  }

  private gone(anchor: string): WriteResult {
    return { ok: false, message: `no object at ${anchor}`, failure: 'not_found' };
  }

  private noSuchEntitlement(externalId: string): WriteResult {
    return {
      ok: false,
      message: `no entitlement at ${externalId}`,
      failure: 'not_found',
    };
  }

  private nextAnchor(): string {
    this.counter += 1;
    return `fake-anchor-${String(this.counter).padStart(4, '0')}`;
  }
}
```

- [ ] **Step 10: Export the new module**

In `packages/connectors/src/index.ts`, append:

```ts
export * from './testing/fake-target.js';
```

- [ ] **Step 11: Run both test files**

Run: `pnpm vitest run packages/connectors/src/types.test.ts packages/connectors/src/testing/fake-target.test.ts`
Expected: PASS.

- [ ] **Step 12: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. `ldapConnector.write` in `packages/connectors/src/ldap/connector.ts` still satisfies the widened `WriteResult` because every new field is optional — if it does not, the signature was widened wrongly, not the connector.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: give the connector write interface its real shape"
```

---

## Task 3: Active Directory range retrieval

**Ruling P1 places this task here, before any task that applies changes to Active Directory.** Directory Sync detects `member;range=` and fails the record loudly, which suffices for a reader. Provision writes: a truncated group read makes 2,500 people look like they need grants, or like nothing at all, and either reading drives writes to a real directory. A target whose largest groups always fail is a target Provision cannot manage.

**Files:**
- Create: `packages/connectors/src/ldap/range.ts`
- Modify: `packages/connectors/src/ldap/connector.ts`
- Modify: `packages/connectors/src/index.ts`
- Test: `packages/connectors/src/ldap/range.test.ts`
- Modify: `docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`

**Interfaces:**
- Consumes: `Client` from `ldapts`; `rangedMembershipFailure` from `./connector.js` (its detection logic moves here and the export is kept as a re-export so Directory Sync's existing test keeps compiling).
- Produces:
  - `function parseRangeKey(key: string): { attribute: string; low: number; high: number | '*' } | undefined`
  - `async function readRangedAttribute(client: Client, dn: string, attribute: string, options: { pageStep: number }): Promise<string[]>`
  - `const RANGE_STEP = 1500`

There is deliberately **no** `nextRangeSpec` helper. An earlier draft of this task had one, together with a `RANGE_STEP_FOR` beside it, and neither was ever called: `readRangedAttribute` computes the next window inline from the window the server just returned. The two disagreed by one on the upper bound as well, so the helper's own tests could not pass. An exported function nothing calls, whose arithmetic differs from the walk that matters, is worse than no helper at all - the next reader assumes the walk uses it.

- [ ] **Step 1: Write the failing unit test for the range key parser**

`packages/connectors/src/ldap/range.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RANGE_STEP, parseRangeKey, readRangedAttribute } from './range.js';

describe('parseRangeKey', () => {
  it('reads a bounded window', () => {
    expect(parseRangeKey('member;range=0-1499')).toEqual({
      attribute: 'member',
      low: 0,
      high: 1499,
    });
  });

  it('reads the final window, which Active Directory marks with an asterisk', () => {
    // The last window is the one that says the enumeration is finished. Miss
    // it and the loop either stops early -- truncating -- or never stops.
    expect(parseRangeKey('member;range=3000-*')).toEqual({
      attribute: 'member',
      low: 3000,
      high: '*',
    });
  });

  it('is case-insensitive, because LDAP attribute names are', () => {
    expect(parseRangeKey('Member;Range=0-1499')).toEqual({
      attribute: 'Member',
      low: 0,
      high: 1499,
    });
  });

  it('reads uniqueMember as well as member', () => {
    expect(parseRangeKey('uniqueMember;range=0-99')).toEqual({
      attribute: 'uniqueMember',
      low: 0,
      high: 99,
    });
  });

  it('ignores a plain attribute name', () => {
    expect(parseRangeKey('member')).toBeUndefined();
    expect(parseRangeKey('memberOf')).toBeUndefined();
  });
});

describe('readRangedAttribute', () => {
  const searchReturning = (pages: Record<string, unknown>[]) => {
    const search = vi.fn();
    for (const page of pages) {
      search.mockResolvedValueOnce({ searchEntries: [page], searchReferences: [] });
    }
    return search;
  };

  it('walks every window and concatenates them in order', async () => {
    const search = searchReturning([
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=2-3': ['c', 'd'] },
      { dn: 'CN=Big,DC=acme,DC=test', 'member;range=4-*': ['e'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Big,DC=acme,DC=test', 'member', {
      pageStep: 2,
    });

    expect(values).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('stops at the asterisk window even when it is full', async () => {
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=2-*': ['c', 'd'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 });

    expect(values).toEqual(['a', 'b', 'c', 'd']);
    // Not a fourth call. The asterisk is the terminator, not the count.
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('returns a plain untruncated attribute in one call', async () => {
    const search = searchReturning([{ dn: 'CN=Small', member: ['a', 'b'] }]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    const values = await readRangedAttribute(client, 'CN=Small', 'member', {
      pageStep: RANGE_STEP,
    });

    expect(values).toEqual(['a', 'b']);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for a group that genuinely has no members', async () => {
    // A group with no members and a group whose membership could not be read
    // must not look the same. This one really is empty, and says so.
    const search = searchReturning([{ dn: 'CN=Empty' }]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    expect(
      await readRangedAttribute(client, 'CN=Empty', 'member', { pageStep: RANGE_STEP }),
    ).toEqual([]);
  });

  it('refuses to return a partial result when a window fails', async () => {
    // Half a membership is the single most dangerous value in this subsystem.
    // If the walk cannot finish, it throws and the caller marks the record a
    // read failure -- it never hands back what it managed to collect.
    const search = vi.fn();
    search.mockResolvedValueOnce({
      searchEntries: [{ dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] }],
      searchReferences: [],
    });
    search.mockRejectedValueOnce(new Error('busy'));
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow('busy');
  });

  it('refuses to return a partial result when the server stops answering partway', async () => {
    // The single most dangerous shape in this task, and the one an early
    // return hides. The first response is ranged, so a walk is under way; the
    // second comes back with neither a plain `member` nor a ranged one -- a
    // transient, a referral, a sizelimit, a replication hiccup. Reading that
    // as "the object holds no more values" hands back 2 of 4,000 members as if
    // it were the whole membership, and the diff then proposes revoking the
    // group from 3,998 people.
    //
    // The same shape on the FIRST request genuinely does mean "no values", and
    // the test above pins that. The difference is whether a walk has started.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big' },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow(/partway through a ranged read/);
  });

  it('refuses a server that returns a window that does not advance', async () => {
    // A server answering the same window forever would otherwise spin here
    // until the process was killed, holding an LDAP connection open.
    const search = searchReturning([
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
      { dn: 'CN=Big', 'member;range=0-1': ['a', 'b'] },
    ]);
    const client = { search } as unknown as Parameters<typeof readRangedAttribute>[0];

    await expect(
      readRangedAttribute(client, 'CN=Big', 'member', { pageStep: 2 }),
    ).rejects.toThrow(/did not advance/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/connectors/src/ldap/range.test.ts`
Expected: FAIL — cannot find module `./range.js`.

- [ ] **Step 3: Write the range reader**

`packages/connectors/src/ldap/range.ts`:

```ts
import type { Client } from 'ldapts';

/**
 * Active Directory's default `MaxValRange`. A group with more members than
 * this comes back as `member;range=0-1499` instead of `member`, and the
 * caller is expected to ask for the next window.
 */
export const RANGE_STEP = 1500;

export interface RangeKey {
  attribute: string;
  low: number;
  /** `'*'` marks the final window. It is the terminator, not a count. */
  high: number | '*';
}

const RANGE_PATTERN = /^([A-Za-z]+);range=(\d+)-(\d+|\*)$/i;

export function parseRangeKey(key: string): RangeKey | undefined {
  const match = RANGE_PATTERN.exec(key);
  if (!match) return undefined;
  const [, attribute, low, high] = match;
  return {
    attribute: attribute!,
    low: Number(low),
    high: high === '*' ? '*' : Number(high),
  };
}

function valuesOf(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/**
 * Reads one multi-valued attribute in full, walking Active Directory's range
 * windows until the server marks the last one with an asterisk.
 *
 * **This never returns a partial result.** If any window fails, it throws, and
 * the caller marks the record a read failure. Half a membership is the single
 * most dangerous value in this subsystem: read naively it is a group with
 * 1,500 members that has 4,000, and the diff then proposes granting it to
 * 2,500 people or revoking it from them, depending on which way the rules
 * happen to fall. Ruling P1 exists because failing loudly was the right
 * interim behaviour for a reader and is not sufficient for a writer.
 */
export async function readRangedAttribute(
  client: Pick<Client, 'search'>,
  dn: string,
  attribute: string,
  options: { pageStep: number },
): Promise<string[]> {
  const collected: string[] = [];
  let spec = attribute;
  let previousSpec: string | undefined;
  // How many requests have been issued. The FIRST response coming back with
  // neither a plain attribute nor a ranged one means the object holds no
  // values; any LATER one means the enumeration stopped mid-walk, and those
  // two must not share a return path.
  let requested = 0;

  for (;;) {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [spec],
    });
    requested += 1;

    const entry = (searchEntries[0] ?? {}) as Record<string, unknown>;

    // The plain name comes back when the attribute fits in one response, and
    // also on the very first request for a small group.
    const plain = Object.keys(entry).find(
      (key) => key.toLowerCase() === attribute.toLowerCase(),
    );
    if (plain) {
      collected.push(...valuesOf(entry[plain]));
      return collected;
    }

    const rangedKey = Object.keys(entry).find((key) => {
      const parsed = parseRangeKey(key);
      return parsed && parsed.attribute.toLowerCase() === attribute.toLowerCase();
    });

    // No plain attribute and no ranged one.
    //
    // On the first request that means the object genuinely holds no values for
    // it: an empty group is a real thing and must not be confused with an
    // unreadable one, so this returns [].
    //
    // On any later request it means the opposite. A walk was under way -- the
    // server had already answered with a bounded window -- and it has now
    // stopped answering, because of a transient, a referral, a sizelimit or a
    // replication hiccup. Returning what has been collected so far hands back
    // 1,500 members of a 4,000-member group as though that were the whole
    // membership, which is precisely the value the docstring above says this
    // function exists to prevent.
    if (!rangedKey) {
      if (requested > 1) {
        throw new Error(
          `the directory stopped returning ${attribute} on ${dn} partway through a ranged ` +
            `read; ${collected.length} values were collected and the enumeration is incomplete`,
        );
      }
      return collected;
    }

    const parsed = parseRangeKey(rangedKey)!;
    collected.push(...valuesOf(entry[rangedKey]));

    if (parsed.high === '*') return collected;

    const next = `${attribute};range=${parsed.high + 1}-${parsed.high + options.pageStep}`;
    if (next === previousSpec || next === spec) {
      throw new Error(
        `the directory returned the same range window twice for ${attribute} on ${dn}; ` +
          `the enumeration did not advance and would not terminate`,
      );
    }
    previousSpec = spec;
    spec = next;
  }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm vitest run packages/connectors/src/ldap/range.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Wire range retrieval into the LDAP reader**

In `packages/connectors/src/ldap/connector.ts`, add the import beside the existing ones:

```ts
import { RANGE_STEP, readRangedAttribute } from './range.js';
```

`toRecord` is synchronous and cannot await a second search, so group membership resolution moves out of it. Replace the group branch of `toRecord`:

```ts
  if (objectType === 'group') {
    const truncated = rangedMembershipFailure(entry);
    if (truncated) {
      // Deliberately no memberDns: an empty list here would read as "this
      // group has no members" and propose removing all of them.
      record.readFailure = truncated;
    } else {
      record.memberDns = toArray(entry.member ?? entry.uniqueMember);
    }
  }
  return record;
```

with:

```ts
  if (objectType === 'group') {
    // Membership is resolved by resolveMembership() after the search, because
    // a ranged read needs further round trips and this function is sync.
    // Deliberately leaves memberDns unset rather than empty: an empty list
    // reads as "this group has no members" and proposes removing all of them.
    record.memberDns = toArray(entry.member ?? entry.uniqueMember);
    if (rangedMembershipFailure(entry)) delete record.memberDns;
  }
  return record;
```

and add this function directly below `toRecord`:

```ts
/**
 * Completes a group record's membership, walking Active Directory's range
 * windows when the first response came back truncated.
 *
 * Ruling P1: until this existed, a group above the server's value-range limit
 * was marked a read failure and excluded from the diff, which is the correct
 * interim behaviour for a subsystem that only reads. Provision writes, and a
 * target whose largest groups always fail is a target it cannot manage.
 *
 * A walk that cannot finish still produces a read failure. That path did not
 * go away; it stopped being the only path.
 */
async function resolveMembership(
  client: Client,
  entry: Record<string, unknown>,
  record: SourceRecord,
  anchorAttribute: string,
): Promise<void> {
  if (record.objectType !== 'group') return;
  if (record.memberDns) return;

  const attribute = Object.keys(entry).some((k) => /^uniqueMember;range=/i.test(k))
    ? 'uniqueMember'
    : 'member';

  try {
    record.memberDns = await readRangedAttribute(client, record.dn, attribute, {
      pageStep: RANGE_STEP,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    record.readFailure =
      `this group's membership exceeds the server's value-range limit and the ` +
      `ranged read could not be completed: ${detail}`;
  }
  void anchorAttribute;
}
```

- [ ] **Step 6: Call it from `read`**

In `packages/connectors/src/ldap/connector.ts`, inside `read`, replace:

```ts
          (searchEntries) =>
            searchEntries.map((entry) =>
              toRecord(entry, search.objectType, config.anchorAttribute),
            ),
        );
        yield* records;
```

with:

```ts
          (searchEntries) =>
            searchEntries.map((entry) => ({
              entry,
              record: toRecord(entry, search.objectType, config.anchorAttribute),
            })),
        );

        for (const { entry, record } of records) {
          // Sequential, not Promise.all: a domain with 300 oversized groups
          // would otherwise open 300 concurrent range walks on one connection.
          await resolveMembership(client, entry, record, config.anchorAttribute);
          yield record;
        }
```

- [ ] **Step 7: Export the module**

In `packages/connectors/src/index.ts`, append:

```ts
export * from './ldap/range.js';
```

- [ ] **Step 8: Run the whole connector suite**

Run: `pnpm vitest run packages/connectors`
Expected: PASS. The existing `rangedMembershipFailure` unit tests in `connector.test.ts` still pass — the function is unchanged and still exported; it is now the *trigger* for a ranged read rather than the end of the story.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Amend spec section 21, which still says this is out of scope**

Ruling P5: Ruling P1 beats spec section 21, **and the spec is what gets corrected**. The ordering landed; this half did not, and a future reader reconciling the two would find a spec saying the feature is out of scope and code saying it is in, with no record of which won.

In `docs/superpowers/specs/2026-08-16-syntra-provision-design.md`, section 21, the paragraph beginning `**Not in this slice at all:**` currently ends:

```markdown
and Active Directory range retrieval, which is inherited as a known gap from
Directory Sync and must be closed before a domain with groups above 1500 members
can be provisioned.
```

Delete that clause -- so the sentence ends at `simulating a rule change against historical data; reading `userAccountControl` into Syntra's user status, which is a Directory Sync change.` -- and append this paragraph immediately after it:

```markdown
**Amended 2026-08-16 under Ruling P1.** Active Directory range retrieval was
listed above as out of scope. It is not: Ruling P1 makes it a prerequisite of
this slice rather than a parallel gap, because Provision *writes*, and a
truncated group read makes 2,500 people look like they need grants or like
nothing at all -- and either reading drives writes to a real directory. It is
implemented in `packages/connectors/src/ldap/range.ts` by Task 3 of the
implementation plan, placed before the Active Directory connector and before
enforcement. The ruling post-dates this section and is the later decision.
```

Amend the spec and not the ruling: the ruling is the record of the decision, and this section is the record of what the slice contains.

- [ ] **Step 11: Close the gap in the known-gaps document**

In `docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`, replace the heading and body of the section beginning `## Active Directory range retrieval (spec section 8, by implication)` with:

```markdown
## ~~Active Directory range retrieval~~ (spec section 8, by implication) — fixed

`readRangedAttribute` in `packages/connectors/src/ldap/range.ts` walks AD's
`member;range=low-high` windows until the server marks the last one with an
asterisk, and `read()` calls it for any group whose first response came back
truncated. Large AD groups now sync.

It never returns a partial result: a window that fails throws, and the record
is marked `readFailure` exactly as before. That path did not go away, it
stopped being the only path.

Closed under Ruling P1 in the Provision — Targets slice rather than as a
Directory Sync follow-up, because Provision *writes*: a truncated group read
makes 2,500 people look like they need grants, or like nothing at all, and
either reading drives writes to a real directory.
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: implement Active Directory range retrieval"
```

---

## Task 4: The Samba Active Directory container

Everything in this task comes from a spike run against a real Samba AD domain controller — `.superpowers/sdd/provision-ad-spike.md`, which resolved Ruling P3. **Do not substitute an image, a tag or a flag.** Five plausible-sounding image names were confirmed **not to exist in the registry** — `elswork/samba-dc`, `svenpetersen1965/samba-ad-dc`, `phillamon/samba-dc`, `domainc/samba-ad-dc` and `athenian/samba-dc`, all 404 on Docker Hub's API. A plan naming an image from memory had five ways to be wrong and one to be right; that is the defect Ruling P3 existed to prevent. Do not invent a sixth.

OpenLDAP cannot exercise any of what this task is for: `sAMAccountName` uniqueness, `userAccountControl`, `unicodePwd` over TLS and `modifyDN` are the behaviours under test, and OpenLDAP has none of them.

**Files:**
- Modify: `infra/docker-compose.yml`
- Create: `infra/samba/README.md`
- Modify: `package.json` (root scripts)
- Create: `packages/connectors/src/ad/samba-connection.ts`
- Test: `packages/connectors/src/ad/samba.smoke.test.ts`

**Interfaces:**
- Consumes: `Client` from `ldapts`.
- Produces: the running container and the environment contract every later integration test reads —
  - `SAMBA_LDAPS_URL`, default `ldaps://localhost:1637`
  - `SAMBA_BIND_DN`, default `CN=Administrator,CN=Users,DC=syntra,DC=test`
  - `SAMBA_BIND_PASSWORD`, default `Syntra!Passw0rd`
  - `SAMBA_BASE_DN`, default `DC=syntra,DC=test`
  - `function sambaConnection(): { url; bindDn; bindPassword; baseDn }` and `async function connectAsSambaAdmin(): Promise<Client>`, **in `packages/connectors/src/ad/samba-connection.ts` — a plain module, not the test file.** Tasks 11 and 18 import them.

`sambaConnection` lives in its own module rather than being exported from the smoke test because importing a test file *executes it*: its `beforeAll`, `afterAll` and five-test `describe` register inside the **importing** file's collection, so `connector.integration.test.ts` and `loop.integration.test.ts` would each re-run the five smoke tests. They are not idempotent, so the second registration fails on `AlreadyExists` — and a helper that quietly runs five other people's tests when you import it is the kind of thing that is diagnosed as flakiness for a week.

- [ ] **Step 1: Verify the pinned tag still resolves before writing it anywhere**

```bash
docker pull nowsci/samba-domain:20260801025201
```

Expected output includes:

```
Digest: sha256:898cca89c3a229bcfa496fcad9cbe0e1d13b9c0ecd1716af78dd40bdadb70061
Status: Downloaded newer image for nowsci/samba-domain:20260801025201
```

If the pull fails, **stop and report it** rather than reaching for another image. The registry offers dated, immutable tags going back years, updated monthly; pick a newer dated tag and re-verify it the same way — `docker pull` it and confirm before writing it into any compose file. Never `:latest`: the dated tags exist for exactly this reason.

- [ ] **Step 2: Add the service to the compose file**

In `infra/docker-compose.yml`, append to `services:`:

```yaml
  samba:
    # Pinned to a dated, immutable tag, verified by `docker pull` before it was
    # written here (spike, Ruling P3). NOT `:latest`. Five plausible-sounding
    # alternatives -- elswork/samba-dc, svenpetersen1965/samba-ad-dc,
    # phillamon/samba-dc, domainc/samba-ad-dc, athenian/samba-dc -- do not
    # exist in the registry at all. Do not swap this without pulling first.
    image: nowsci/samba-domain:20260801025201
    # REQUIRED, not optional. Without it the container gets through most of
    # domain provisioning and then dies:
    #   set_nt_acl_no_snum: fset_nt_acl returned NT_STATUS_ACCESS_DENIED.
    #   ERROR(runtime): uncaught exception - (3221225506, '{Access Denied} ...')
    #     ... setsysvolacl ... setntacl ... smbd.set_nt_acl
    #   exit=255
    # Samba's provisioning sets NT ACLs on the sysvol filesystem, which needs
    # privileges the container does not have without this. It is a real
    # constraint on whatever runs the suite: a Docker host that permits
    # privileged containers. True for a self-hosted runner and for GitHub
    # Actions' standard Linux runners; NOT guaranteed on more locked-down or
    # sandboxed CI. See infra/samba/README.md.
    privileged: true
    environment:
      DOMAIN: SYNTRA.TEST
      DOMAINPASS: 'Syntra!Passw0rd'
      HOSTIP: 127.0.0.1
      INSECURELDAP: 'false'
    # Only 389 and 636 are needed for everything Provision does. The image
    # documents a much larger port surface (53, 88, 123, 135, 137-139, 445,
    # 464, 1024-1044, 3268-3269) for domain join; Kerberos and SMB are not
    # required for anything that goes over ldapts, so the suite stays narrow.
    # 1390 is mapped for diagnostics only -- see the README: this server
    # refuses even a plain simple bind, so nothing in the suite uses it.
    #
    # CORRECTED DURING IMPLEMENTATION -- was 1389, which cannot start:
    # `openldap` in this same compose file already publishes 389 on 1389, and
    # Docker refuses the second claim outright:
    #   Bind for 0.0.0.0:1389 failed: port is already allocated
    ports: ['1390:389', '1637:636']
```

- [ ] **Step 3: Write the README the constraint belongs in**

`infra/samba/README.md`:

```markdown
# Samba Active Directory domain controller (test fixture)

Provision's Active Directory target connector is tested against a real domain
controller, not a fake. OpenLDAP cannot exercise any of the four behaviours
that make Active Directory hard, and those four are precisely what the
connector does: `sAMAccountName` uniqueness, `userAccountControl`,
`unicodePwd` over an encrypted transport, and `modifyDN`.

## The image is pinned, and the pin matters

`nowsci/samba-domain:20260801025201` — a dated, immutable tag, pull-verified
(`sha256:898cca89c3a229bcfa496fcad9cbe0e1d13b9c0ecd1716af78dd40bdadb70061`)
before it was written into the compose file.

Do not switch to `:latest`, and do not substitute another image from memory.
Five plausible-sounding names — `elswork/samba-dc`,
`svenpetersen1965/samba-ad-dc`, `phillamon/samba-dc`, `domainc/samba-ad-dc`
and `athenian/samba-dc` — return 404 from Docker Hub's API. If you need a
newer build, take another dated tag from this same repository and `docker
pull` it before writing it down.

## `--privileged` is required

Not a convenience, not a workaround. Samba's provisioning sets NT ACLs on the
sysvol filesystem. Without the flag the container gets most of the way through
provisioning and then exits 255:

```
set_nt_acl_no_snum: fset_nt_acl returned NT_STATUS_ACCESS_DENIED.
ERROR(runtime): uncaught exception - (3221225506, '{Access Denied} ...')
  ... setsysvolacl ... setntacl ... smbd.set_nt_acl
```

**This constrains where the suite can run.** It needs a Docker host that
permits privileged containers: true for a self-hosted runner and for GitHub
Actions' standard Linux runners, **not** guaranteed on more locked-down or
sandboxed CI. Say so in the CI configuration rather than letting it surface
as a mysterious CI-only failure.

## Everything is encrypted, including reads

This server refuses a plain LDAP simple bind outright — not just a password
write:

```
StrongAuthRequiredError: BindSimple: Transport encryption required. Code: 0x8
```

That is stricter than the OpenLDAP container, which serves plaintext happily.
A fixture shared between the two must default to encrypted rather than assume
plain works, even for a read-only sanity check. The certificate is
self-signed, so tests connect with `rejectUnauthorized: false` deliberately —
the same pattern the OpenLDAP tests already use.

## Startup

12.5s, 16.6s and 18.5s to first successful LDAPS bind across three cold
starts, 3 for 3, no flakiness. Budget well under a minute. Comparable to the
OpenLDAP container, not the multi-minute liability the design feared.

Worth re-timing once on a genuinely cold Docker host: those three trials
benefited from local image-layer caching after the first pull.

## Ports

Only 636 (LDAPS, published on 1637) is used. 389 is published on 1390 for
diagnostics; nothing in the suite binds to it, because it refuses to bind.

1390 rather than 1389 because the `openldap` service in the same compose file
already owns 1389.
```

- [ ] **Step 4: Add the wait script to the root scripts**

In `package.json`, add to `scripts`:

```json
    "samba:up": "docker compose -f infra/docker-compose.yml up -d samba",
    "samba:wait": "node --input-type=module -e \"import {Client} from 'ldapts';const url=process.env.SAMBA_LDAPS_URL??'ldaps://localhost:1637';const dn=process.env.SAMBA_BIND_DN??'CN=Administrator,CN=Users,DC=syntra,DC=test';const pw=process.env.SAMBA_BIND_PASSWORD??'Syntra!Passw0rd';const deadline=Date.now()+120000;for(;;){const c=new Client({url,tlsOptions:{rejectUnauthorized:false},connectTimeout:5000});try{await c.bind(dn,pw);await c.unbind();console.log('samba bindable');process.exit(0)}catch(e){await c.unbind().catch(()=>{});if(Date.now()>deadline){console.error('samba never became bindable:',e.message);process.exit(1)}await new Promise(r=>setTimeout(r,2000))}}\""
```

The poll interval is 2000 ms and the budget is 120 s against an observed
12.5–18.5 s, which is deliberately generous: the observed numbers came from a
host with a warm image-layer cache.

- [ ] **Step 5: Write the shared connection module**

`packages/connectors/src/ad/samba-connection.ts`:

```ts
import { Client } from 'ldapts';

/**
 * The connection every Active Directory integration test in this plan uses.
 *
 * A plain module, deliberately, and not an export from the smoke test.
 * Importing a test file executes it, which registers its hooks and its
 * `describe` inside the importing file's collection -- so every file that
 * wanted this helper would silently re-run the smoke suite as well.
 */
export function sambaConnection(): {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
} {
  return {
    url: process.env.SAMBA_LDAPS_URL ?? 'ldaps://localhost:1637',
    bindDn:
      process.env.SAMBA_BIND_DN ?? 'CN=Administrator,CN=Users,DC=syntra,DC=test',
    bindPassword: process.env.SAMBA_BIND_PASSWORD ?? 'Syntra!Passw0rd',
    baseDn: process.env.SAMBA_BASE_DN ?? 'DC=syntra,DC=test',
  };
}

/**
 * A bound administrative client.
 *
 * The container's certificate is self-signed, so verification is turned off
 * deliberately and explicitly. It cannot be left at its default: with
 * verification on, every connection fails to establish at all.
 */
export async function connectAsSambaAdmin(): Promise<Client> {
  const connection = sambaConnection();
  const client = new Client({
    url: connection.url,
    tlsOptions: { rejectUnauthorized: false },
    connectTimeout: 10_000,
    timeout: 60_000,
  });
  await client.bind(connection.bindDn, connection.bindPassword);
  return client;
}

/**
 * Deletes everything under `base`, deepest first, and leaves `base` itself.
 *
 * Every integration test in this slice starts from a known-empty subtree
 * rather than from whatever the last run left. A fixture that only passes
 * against a freshly created container is a fixture that passes once.
 */
export async function purgeSubtree(client: Client, base: string): Promise<void> {
  const { searchEntries } = await client
    .search(base, { scope: 'sub', filter: '(objectClass=*)', attributes: ['dn'] })
    .catch(() => ({ searchEntries: [] as { dn: string }[] }));
  const deepestFirst = [...searchEntries].sort(
    (a, b) => String(b.dn).length - String(a.dn).length,
  );
  for (const entry of deepestFirst) {
    if (String(entry.dn) === base) continue;
    await client.del(String(entry.dn)).catch(() => undefined);
  }
}
```

**CORRECTED DURING IMPLEMENTATION.** Do not add it to
`packages/connectors/src/index.ts` — it is a fixture, and commit `00b7631`
deliberately keeps fixtures off the package root. Re-export it from
`packages/connectors/src/testing/index.ts` instead, alongside `FakeTarget`.

The deep path this plan originally gave Task 18 does not resolve at all:
`@syntra/connectors` declares an `exports` map (`"."` and `"./testing"`), and an
`exports` map denies every subpath it does not list.

```
error TS2307: Cannot find module '@syntra/connectors/src/ad/samba-connection.js'
or its corresponding type declarations.
```

Task 11's test lives inside `@syntra/connectors` and imports by relative path,
which is unaffected. Task 18's test lives in `@syntra/core` and must import from
**`@syntra/connectors/testing`**.

- [ ] **Step 6: Write the failing smoke test**

`packages/connectors/src/ad/samba.smoke.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Attribute, Change, Client } from 'ldapts';
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
} from './samba-connection.js';

const connection = sambaConnection();

/**
 * Every object this file creates lives under one OU it owns and empties
 * before each test.
 *
 * The earlier draft added five fixed DNs under `CN=Users` and two OUs at the
 * base, with no cleanup: it passed exactly once per fresh container and failed
 * with `AlreadyExists` on every run after. A suite that only passes against a
 * container nobody has touched is a suite nobody can run twice.
 */
const usersDn = `OU=Smoke,${connection.baseDn}`;

/**
 * `replace` on a single attribute, spelled the way `ldapts` actually requires.
 *
 * CORRECTED DURING IMPLEMENTATION. This plan originally wrote every change as
 * an object literal cast `as never`. That throws at send time:
 *
 *   TypeError: change.write is not a function
 *
 * `Client.modify` takes `Change` instances and `ModifyRequest.writeMessage`
 * calls `change.write(writer)` on each; `Change.write` then calls
 * `this.modification.write(writer)`, so the modification must be a real
 * `Attribute` too. The `as never` cast is what hid it -- the compiler knew the
 * argument was wrong and the cast told it not to say so.
 */
function replace(type: string, value: string | Buffer): Change {
  return new Change({
    operation: 'replace',
    modification: new Attribute({ type, values: [value] as string[] | Buffer[] }),
  });
}

let client: Client;

beforeAll(async () => {
  client = await connectAsSambaAdmin();
  await client
    .add(usersDn, { objectClass: ['top', 'organizationalUnit'] })
    .catch(() => undefined);
}, 120_000);

beforeEach(async () => {
  await purgeSubtree(client, usersDn);
});

afterAll(async () => {
  await purgeSubtree(client, usersDn).catch(() => undefined);
  await client?.del(usersDn).catch(() => undefined);
  await client?.unbind().catch(() => undefined);
});

describe('the Samba AD container', () => {
  it('refuses a simple bind over plain LDAP', async () => {
    // Stricter than OpenLDAP, which serves plaintext happily. A fixture shared
    // between the two must default to encrypted rather than assume plain
    // works -- even for a read-only sanity check.
    const plain = new Client({
      url: process.env.SAMBA_LDAP_URL ?? 'ldap://localhost:1390',
      connectTimeout: 10_000,
    });
    await expect(
      plain.bind(connection.bindDn, connection.bindPassword),
    ).rejects.toThrow(/Transport encryption required|StrongAuthRequired/i);
    await plain.unbind().catch(() => undefined);
  });

  it('rejects a duplicate sAMAccountName at the server', async () => {
    const dn = `CN=smoke uniq one,${usersDn}`;
    const clash = `CN=smoke uniq two,${usersDn}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokeuniq',
      userAccountControl: '514',
    });
    // 00002071: samldb: samAccountName 'smokeuniq' already in use! Code: 0x44
    await expect(
      client.add(clash, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: 'smokeuniq',
        userAccountControl: '514',
      }),
    ).rejects.toThrow(/already in use|AlreadyExists/i);
  });

  it('round-trips userAccountControl from 514 to 512', async () => {
    const dn = `CN=smoke uac,${usersDn}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokeuac',
      // 514 = normal account, disabled. Step 1 of creation always writes this:
      // an account that exists and is enabled before its password is set is a
      // window nobody asked for.
      userAccountControl: '514',
    });
    const before = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['userAccountControl'],
    });
    expect(String(before.searchEntries[0]!.userAccountControl)).toBe('514');

    await client.modify(dn, replace('userAccountControl', '512'));

    const after = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['userAccountControl'],
    });
    expect(String(after.searchEntries[0]!.userAccountControl)).toBe('512');
  });

  it('sets unicodePwd over LDAPS and the account can then bind with it', async () => {
    const dn = `CN=smoke pwd,${usersDn}`;
    const password = 'Smoke!Passw0rd42';
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokepwd',
      userPrincipalName: `smokepwd@${connection.baseDn.replace(/DC=/g, '').replace(/,/g, '.')}`,
      userAccountControl: '514',
    });

    // AD requires the value UTF-16LE encoded and wrapped in literal double
    // quotes. This is also why the transport must be encrypted: AD refuses a
    // password write over an unencrypted connection.
    await client.modify(dn, replace('unicodePwd', Buffer.from(`"${password}"`, 'utf16le')));
    await client.modify(dn, replace('userAccountControl', '512'));

    // Proved by binding, not by "the write did not throw".
    const asUser = new Client({
      url: connection.url,
      tlsOptions: { rejectUnauthorized: false },
      connectTimeout: 10_000,
    });
    await asUser.bind(dn, password);
    await asUser.unbind();
  });

  it('moves an account between organizational units with modifyDN', async () => {
    // Under the OU this file owns, so beforeEach can empty them.
    const fromOu = `OU=SmokeFrom,${usersDn}`;
    const toOu = `OU=SmokeTo,${usersDn}`;
    for (const ou of [fromOu, toOu]) {
      await client
        .add(ou, { objectClass: ['top', 'organizationalUnit'] })
        .catch(() => undefined);
    }
    const dn = `CN=smoke move,${fromOu}`;
    const moved = `CN=smoke move,${toOu}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokemove',
      userAccountControl: '514',
    });

    // ldapts's modifyDN(dn, fullNewDn) takes THE COMPLETE NEW DN as its second
    // argument -- NOT (dn, newRdn, newSuperior). The three-argument call
    // throws `TypeError: control.write is not a function`, because the third
    // positional argument is treated as an LDAP control, which reads as a
    // library bug rather than a signature mistake and costs an afternoon.
    // Confirmed by hitting it during the spike.
    await client.modifyDN(dn, moved);

    const atNew = await client.search(moved, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['dn'],
    });
    expect(atNew.searchEntries).toHaveLength(1);
    await expect(
      client.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Bring the container up and wait for it**

```bash
pnpm samba:up && pnpm samba:wait
```

Expected: `samba bindable` within roughly 12–20 seconds on a warm host.

This is also the first and only validation of the **compose translation**. The spike ran the image with `docker run` and an explicit network; the image tag, the digest, `privileged: true` and the port choices are carried from it exactly, but the environment-variable names, the absence of `hostname`/`dns_search` and the service wiring are new here. If `pnpm samba:up` starts the container but `pnpm samba:wait` never sees a bind, read `docker compose -f infra/docker-compose.yml logs samba` before touching anything else — that is a compose problem, not an image problem, and reaching for a different image would be exactly the mistake Ruling P3 exists to prevent.

If it exits 255 with `set_nt_acl_no_snum ... NT_STATUS_ACCESS_DENIED`, `privileged: true` did not take effect — check whether this Docker host permits privileged containers before changing anything else.

- [ ] **Step 8: Run the smoke test, twice**

Run: `pnpm vitest run packages/connectors/src/ad/samba.smoke.test.ts`
Expected: PASS, 5 tests.

**Then run it a second time without restarting the container.** Expected: PASS, 5 tests again. The first run proves the four behaviours; the second proves the fixture cleans up after itself, which the earlier draft did not and which is the difference between a suite that can gate CI and one that can be run once.

All five were proven live during the spike through this same `ldapts` client, reproduced identically across three fresh container starts. A failure here is a change in the environment, not an unproven assumption.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "test: add a pinned Samba Active Directory container"
```

---

## Task 5: The rule condition language

**Files:**
- Create: `packages/core/src/provision/condition.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/condition.test.ts`

**Interfaces:**
- Consumes: `z` from `zod`.
- Produces:
  - `type ConditionField = 'contract.department' | 'contract.jobTitle' | 'contract.costCentre' | 'contract.employer' | 'contract.location' | 'contract.fte' | 'person.status'`
  - `type ConditionOperator = 'equals' | 'notEquals' | 'in' | 'notIn' | 'startsWith' | 'contains' | 'isEmpty' | 'isNotEmpty' | 'greaterThan' | 'lessThan'`
  - `type Condition` — the recursive `{all}` / `{any}` / `{not}` / leaf union.
  - `const conditionSchema: z.ZodType<Condition>`
  - `interface ConditionFacts { 'contract.department': string | null; 'contract.jobTitle': string | null; 'contract.costCentre': string | null; 'contract.employer': string | null; 'contract.location': string | null; 'contract.fte': number | null; 'person.status': string | null }`
  - `function evaluateCondition(condition: Condition, facts: ConditionFacts): boolean`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/condition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  conditionSchema,
  evaluateCondition,
  type Condition,
  type ConditionFacts,
} from './condition.js';

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': 'Analyst',
  'contract.costCentre': 'CC-100',
  'contract.employer': 'Acme Care',
  'contract.location': 'Utrecht',
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

describe('evaluateCondition — leaf operators', () => {
  it('matches equals case-insensitively and trimming whitespace', () => {
    // HR data is typed by humans and "Finance " and "finance" are the same
    // department. A rule that misses because of a trailing space is a rule
    // that silently strips access.
    const condition: Condition = {
      field: 'contract.department',
      op: 'equals',
      value: 'finance',
    };
    expect(evaluateCondition(condition, facts())).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': '  FINANCE  ' })),
    ).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': 'Facilities' })),
    ).toBe(false);
  });

  it('notEquals is the negation of equals, including on null', () => {
    const condition: Condition = {
      field: 'contract.department',
      op: 'notEquals',
      value: 'finance',
    };
    expect(evaluateCondition(condition, facts())).toBe(false);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': 'Facilities' })),
    ).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': null })),
    ).toBe(true);
  });

  it('in and notIn compare against a list, case-insensitively', () => {
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'in', value: ['UTRECHT', 'Delft'] },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'notIn', value: ['Delft'] },
        facts(),
      ),
    ).toBe(true);
  });

  it('startsWith and contains are case-insensitive and trimmed', () => {
    expect(
      evaluateCondition(
        { field: 'contract.costCentre', op: 'startsWith', value: 'cc-' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: 'naly' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: 'manager' },
        facts(),
      ),
    ).toBe(false);
  });

  it('distinguishes isEmpty on null from isEmpty on an empty string', () => {
    // Both are empty, and both must read as empty. A rule written to catch
    // "no department recorded" has to catch the import that wrote "" as well
    // as the one that wrote nothing.
    const isEmpty: Condition = { field: 'contract.department', op: 'isEmpty' };
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': null }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': '' }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': '   ' }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts())).toBe(false);
  });

  it('isNotEmpty is the negation of isEmpty', () => {
    const isNotEmpty: Condition = { field: 'contract.jobTitle', op: 'isNotEmpty' };
    expect(evaluateCondition(isNotEmpty, facts())).toBe(true);
    expect(evaluateCondition(isNotEmpty, facts({ 'contract.jobTitle': '' }))).toBe(false);
  });

  it('greaterThan and lessThan apply to fte and compare numerically', () => {
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': 0.6 }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ 'contract.fte': 0.4 }),
      ),
    ).toBe(true);
    // Not lexicographic: "0.9" < "1" as strings would be wrong here.
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.9 },
        facts({ 'contract.fte': 1 }),
      ),
    ).toBe(true);
  });

  it('does not match a numeric comparison against a null fte', () => {
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
  });

  it('matches person.status as well as contract fields', () => {
    expect(
      evaluateCondition({ field: 'person.status', op: 'equals', value: 'active' }, facts()),
    ).toBe(true);
  });
});

describe('evaluateCondition — combinators', () => {
  it('treats an empty all as true', () => {
    // This is how a birthright rule matching everybody with any active
    // contract is expressed, without a special case anywhere else.
    expect(evaluateCondition({ all: [] }, facts())).toBe(true);
  });

  it('treats an empty any as false', () => {
    expect(evaluateCondition({ any: [] }, facts())).toBe(false);
  });

  it('requires every member of all', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'contract.department', op: 'equals', value: 'Finance' },
            { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
          ],
        },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'contract.department', op: 'equals', value: 'Finance' },
            { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
          ],
        },
        facts({ 'contract.fte': 0.2 }),
      ),
    ).toBe(false);
  });

  it('requires one member of any', () => {
    expect(
      evaluateCondition(
        {
          any: [
            { field: 'contract.department', op: 'equals', value: 'Facilities' },
            { field: 'contract.location', op: 'equals', value: 'Utrecht' },
          ],
        },
        facts(),
      ),
    ).toBe(true);
  });

  it('negates with not, and nests to arbitrary depth', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { not: { field: 'contract.department', op: 'equals', value: 'Facilities' } },
            {
              any: [
                { field: 'contract.jobTitle', op: 'contains', value: 'analyst' },
                { field: 'contract.jobTitle', op: 'contains', value: 'controller' },
              ],
            },
          ],
        },
        facts(),
      ),
    ).toBe(true);
  });
});

describe('conditionSchema', () => {
  it('accepts a nested condition and returns it typed', () => {
    const parsed = conditionSchema.parse({
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { not: { field: 'contract.fte', op: 'lessThan', value: 0.5 } },
      ],
    });
    expect(parsed).toEqual({
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { not: { field: 'contract.fte', op: 'lessThan', value: 0.5 } },
      ],
    });
  });

  it('refuses a field outside the closed set', () => {
    // The closed field set is the point. A rule that decides access must be
    // readable by somebody who did not write it, diffable, and evaluable in a
    // unit test without a runtime.
    expect(() =>
      conditionSchema.parse({ field: 'contract.salary', op: 'greaterThan', value: 1 }),
    ).toThrow();
  });

  it('refuses an operator outside the closed set', () => {
    // Notably `regex`. It is the operator everybody asks for and it brings
    // catastrophic backtracking into the code path that decides who has
    // access, on patterns typed by administrators.
    expect(() =>
      conditionSchema.parse({ field: 'contract.jobTitle', op: 'regex', value: '^a.*' }),
    ).toThrow();
  });

  it('refuses greaterThan on a string field', () => {
    // greaterThan and lessThan apply only to contract.fte.
    expect(() =>
      conditionSchema.parse({
        field: 'contract.department',
        op: 'greaterThan',
        value: 3,
      }),
    ).toThrow();
  });

  it('refuses a leaf that carries no value where one is required', () => {
    expect(() =>
      conditionSchema.parse({ field: 'contract.department', op: 'equals' }),
    ).toThrow();
  });

  it('refuses a value on isEmpty', () => {
    expect(() =>
      conditionSchema.parse({
        field: 'contract.department',
        op: 'isEmpty',
        value: 'x',
      }),
    ).toThrow();
  });

  it('refuses an in with an empty list', () => {
    // An `in` over nothing matches nobody, which is almost certainly not what
    // was meant and is indistinguishable from a rule that was never finished.
    expect(() =>
      conditionSchema.parse({ field: 'contract.location', op: 'in', value: [] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/condition.test.ts`
Expected: FAIL — cannot find module `./condition.js`.

- [ ] **Step 3: Write the condition language**

`packages/core/src/provision/condition.ts`:

```ts
import { z } from 'zod';

/**
 * The closed field set. Rules decide who gets access, so what they can look
 * at is fixed in code rather than open to whatever an administrator types.
 */
export const CONDITION_FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

/**
 * The closed operator set.
 *
 * Regular-expression matching is deliberately absent. It is the operator
 * everybody asks for and it brings catastrophic backtracking into the code
 * path that decides who has access, on patterns typed by administrators. The
 * cases this set does not cover are usually a request for a cleaner HR field.
 */
export const CONDITION_OPERATORS = [
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
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** The only field the numeric operators may be applied to. */
const NUMERIC_FIELD: ConditionField = 'contract.fte';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: ConditionField; op: 'equals' | 'notEquals' | 'startsWith' | 'contains'; value: string }
  | { field: ConditionField; op: 'in' | 'notIn'; value: string[] }
  | { field: ConditionField; op: 'isEmpty' | 'isNotEmpty' }
  | { field: ConditionField; op: 'greaterThan' | 'lessThan'; value: number };

const fieldSchema = z.enum(CONDITION_FIELDS);

/**
 * `.strict()` on every member, not only on the combinators.
 *
 * A bare `z.object(...)` in Zod **strips** unknown keys rather than rejecting
 * them, so `{ field, op: 'isEmpty', value: 'x' }` parses cleanly and the
 * `value` silently disappears -- which is a rule that reads as one thing and
 * means another, in the code path that decides who has access.
 */
const leafSchema = z.union([
  z
    .object({
      field: fieldSchema,
      op: z.enum(['equals', 'notEquals', 'startsWith', 'contains']),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      field: fieldSchema,
      op: z.enum(['in', 'notIn']),
      // An `in` over nothing matches nobody, which is indistinguishable from a
      // rule somebody started and did not finish.
      value: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      field: fieldSchema,
      op: z.enum(['isEmpty', 'isNotEmpty']),
    })
    .strict(),
  z
    .object({
      // greaterThan and lessThan apply only to contract.fte. A literal rather
      // than the open field enum, so the schema refuses the nonsense rather
      // than the evaluator having to.
      field: z.literal(NUMERIC_FIELD),
      op: z.enum(['greaterThan', 'lessThan']),
      value: z.number(),
    })
    .strict(),
]);

/**
 * `.strict()` on the combinators too: a leaf or a branch carrying an
 * unexpected key is a typo in a rule that decides access.
 */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema) }).strict(),
    z.object({ any: z.array(conditionSchema) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    leafSchema,
  ]),
) as z.ZodType<Condition>;

export interface ConditionFacts {
  'contract.department': string | null;
  'contract.jobTitle': string | null;
  'contract.costCentre': string | null;
  'contract.employer': string | null;
  'contract.location': string | null;
  'contract.fte': number | null;
  'person.status': string | null;
}

/**
 * String comparisons trim surrounding whitespace and fold case, because HR
 * data is typed by humans and "Finance " and "finance" are the same
 * department. A rule that misses because of a trailing space is a rule that
 * silently strips somebody's access.
 */
function normalise(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Evaluates a condition against one contract's facts. Pure: no clock, no
 * database, no I/O. Nothing an administrator typed is executed — the
 * interpreter is closed over a closed field and operator set.
 */
export function evaluateCondition(
  condition: Condition,
  facts: ConditionFacts,
): boolean {
  if ('all' in condition) {
    // An empty `all` is true. That is how a birthright rule matching everybody
    // with any active contract is expressed without a special case.
    return condition.all.every((child) => evaluateCondition(child, facts));
  }
  if ('any' in condition) {
    return condition.any.some((child) => evaluateCondition(child, facts));
  }
  if ('not' in condition) {
    return !evaluateCondition(condition.not, facts);
  }

  const raw = facts[condition.field];

  switch (condition.op) {
    case 'isEmpty':
      return raw === null || (typeof raw === 'string' && raw.trim() === '');
    case 'isNotEmpty':
      return !(raw === null || (typeof raw === 'string' && raw.trim() === ''));
    case 'greaterThan':
      return typeof raw === 'number' && raw > condition.value;
    case 'lessThan':
      return typeof raw === 'number' && raw < condition.value;
    default:
      break;
  }

  const actual = normalise(typeof raw === 'number' ? String(raw) : raw);

  switch (condition.op) {
    case 'equals':
      return actual === normalise(condition.value);
    case 'notEquals':
      return actual !== normalise(condition.value);
    case 'startsWith':
      return actual.startsWith(normalise(condition.value));
    case 'contains':
      return actual.includes(normalise(condition.value));
    case 'in':
      return condition.value.some((candidate) => normalise(candidate) === actual);
    case 'notIn':
      return !condition.value.some((candidate) => normalise(candidate) === actual);
  }
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/condition.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/condition.test.ts`
Expected: PASS, 21 tests.

`refuses a value on isEmpty` is the one that depends on step 3's `.strict()`. Without it Zod strips the stray key and the parse succeeds, and a rule that says "department is empty" while carrying a value nobody can see goes into production.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add the declarative business rule condition language"
```

---

## Task 6: Templates and correlation key generation

**Files:**
- Create: `packages/core/src/provision/templates.ts`
- Create: `packages/core/src/provision/names.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/templates.test.ts`, `packages/core/src/provision/names.test.ts`

**Interfaces:**
- Consumes: nothing. Both modules are pure and import nothing.
- Produces:
  - `interface TemplateContext { person: Record<string, string | null>; contract: Record<string, string | null>; baseDn: string }`
  - `type TemplateResult = { ok: true; value: string } | { ok: false; missing: string[] }`
  - `function renderTemplate(template: string, context: TemplateContext): TemplateResult`
  - `function foldToAscii(value: string): string`
  - `interface NameGenerationInput { template: string; context: TemplateContext; taken: ReadonlySet<string>; maxLength: number; maxAttempts: number }`
  - `type NameGenerationResult = { ok: true; correlationKey: string } | { ok: false; reason: 'template_unresolvable'; missing: string[] } | { ok: false; reason: 'exhausted'; attempts: number }`
  - `function generateCorrelationKey(input: NameGenerationInput): NameGenerationResult`
  - `const SAM_ACCOUNT_NAME_MAX_LENGTH = 20`

- [ ] **Step 1: Write the failing template test**

`packages/core/src/provision/templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderTemplate, type TemplateContext } from './templates.js';

const context = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  person: {
    givenName: 'Anna Maria',
    familyName: "O'Brien",
    // `Person` has businessEmail and personalEmail. It has no `email` column
    // and no `displayName` column, and spec section 15 forbids adding one --
    // so no template anywhere in this plan may name `%person.email%`.
    businessEmail: 'anna@acme.test',
    personalEmail: null,
    nameConvention: 'familyName',
    displayName: "Anna Maria O'Brien",
    status: 'active',
  },
  contract: {
    department: 'Finance',
    jobTitle: 'Analyst',
    costCentre: 'CC-100',
    employer: 'Acme Care',
    location: 'Utrecht',
  },
  baseDn: 'DC=acme,DC=test',
  ...over,
});

describe('renderTemplate', () => {
  it('substitutes person and contract fields', () => {
    const result = renderTemplate('%person.givenName% %person.familyName%', context());
    expect(result).toEqual({ ok: true, value: "Anna Maria O'Brien" });
  });

  it('substitutes baseDn, which has no prefix', () => {
    const result = renderTemplate(
      'OU=%contract.department%,OU=Users,%baseDn%',
      context(),
    );
    expect(result).toEqual({
      ok: true,
      value: 'OU=Finance,OU=Users,DC=acme,DC=test',
    });
  });

  it('supports the .first modifier for a first name part', () => {
    // "%person.givenName.first%.%person.familyName%" is the spec's own
    // example, and a person with two given names must yield one initial part
    // rather than a login with a space in it.
    const result = renderTemplate(
      '%person.givenName.first%.%person.familyName%',
      context(),
    );
    expect(result).toEqual({ ok: true, value: "Anna.O'Brien" });
  });

  it('supports the .initial modifier', () => {
    const result = renderTemplate(
      '%person.givenName.initial%%person.familyName%',
      context(),
    );
    expect(result).toEqual({ ok: true, value: "AO'Brien" });
  });

  it('reports every unresolvable placeholder rather than rendering an empty string', () => {
    // An empty value rendered into a DN produces "OU=,OU=Users,..." which is
    // not a container, and rendered into a login produces a login somebody
    // else may already hold. Both must be a refusal, and the refusal has to
    // name what was missing so somebody can fix it.
    const result = renderTemplate(
      'OU=%contract.department%,OU=%contract.costCentre%,%baseDn%',
      context({ contract: { department: null, costCentre: '  ' } }),
    );
    expect(result).toEqual({
      ok: false,
      missing: ['contract.department', 'contract.costCentre'],
    });
  });

  it('reports an unknown placeholder as missing rather than leaving it literal', () => {
    const result = renderTemplate('%person.nickname%', context());
    expect(result).toEqual({ ok: false, missing: ['person.nickname'] });
  });

  it('leaves text with no placeholders alone', () => {
    expect(renderTemplate('OU=Archive,DC=acme,DC=test', context())).toEqual({
      ok: true,
      value: 'OU=Archive,DC=acme,DC=test',
    });
  });

  it('lists a repeated missing placeholder once', () => {
    const result = renderTemplate(
      '%contract.location%/%contract.location%',
      context({ contract: { location: null } }),
    );
    expect(result).toEqual({ ok: false, missing: ['contract.location'] });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/templates.test.ts`
Expected: FAIL — cannot find module `./templates.js`.

- [ ] **Step 3: Write the template renderer**

`packages/core/src/provision/templates.ts`:

```ts
/**
 * Everything a template may reference. `person` and `contract` are open string
 * maps rather than fixed shapes because the account profile's
 * `attributeTemplates` is administrator-written and may name any field the
 * loader put in; an unknown name is reported as missing, not rendered empty.
 */
export interface TemplateContext {
  person: Record<string, string | null>;
  contract: Record<string, string | null>;
  /** The target's base DN. Referenced as `%baseDn%`, with no prefix. */
  baseDn: string;
}

export type TemplateResult =
  | { ok: true; value: string }
  | { ok: false; missing: string[] };

const PLACEHOLDER = /%([a-zA-Z]+)(?:\.([a-zA-Z]+))?(?:\.(first|initial))?%/g;

function lookup(
  context: TemplateContext,
  scope: string,
  field: string | undefined,
): string | null | undefined {
  if (scope === 'baseDn' && field === undefined) return context.baseDn;
  if (field === undefined) return undefined;
  if (scope === 'person') return context.person[field];
  if (scope === 'contract') return context.contract[field];
  return undefined;
}

/**
 * Renders a template, or refuses and says which placeholders it could not
 * resolve.
 *
 * **A missing value is never rendered as an empty string.** An empty value in
 * a DN produces `OU=,OU=Users,DC=acme,DC=test`, which is not a container; an
 * empty value in a login produces a login that collides with whatever the
 * uniqueness strategy invents next, on a person whose record is incomplete.
 * Both are the shape where a person becomes unprocessable and the run says
 * so by name (spec section 13).
 *
 * Pure: no clock, no database, no I/O.
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
): TemplateResult {
  const missing: string[] = [];

  const value = template.replace(
    PLACEHOLDER,
    (_match, scope: string, field: string | undefined, modifier: string | undefined) => {
      const raw = lookup(context, scope, field);
      const name = field === undefined ? scope : `${scope}.${field}`;

      if (raw === undefined || raw === null || raw.trim() === '') {
        if (!missing.includes(name)) missing.push(name);
        return '';
      }

      const trimmed = raw.trim();
      if (modifier === 'first') return trimmed.split(/\s+/)[0]!;
      if (modifier === 'initial') return trimmed.slice(0, 1);
      return trimmed;
    },
  );

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value };
}
```

- [ ] **Step 4: Run the template tests**

Run: `pnpm vitest run packages/core/src/provision/templates.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing name-generation test**

`packages/core/src/provision/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SAM_ACCOUNT_NAME_MAX_LENGTH,
  foldToAscii,
  generateCorrelationKey,
} from './names.js';
import type { TemplateContext } from './templates.js';

const context = (givenName: string, familyName: string): TemplateContext => ({
  person: { givenName, familyName },
  contract: { department: 'Finance' },
  baseDn: 'DC=acme,DC=test',
});

const generate = (
  ctx: TemplateContext,
  taken: string[] = [],
  over: { maxAttempts?: number; template?: string } = {},
) =>
  generateCorrelationKey({
    template: over.template ?? '%person.givenName.first%.%person.familyName%',
    context: ctx,
    taken: new Set(taken),
    maxLength: SAM_ACCOUNT_NAME_MAX_LENGTH,
    maxAttempts: over.maxAttempts ?? 20,
  });

describe('foldToAscii', () => {
  it('folds accents to their base letters', () => {
    expect(foldToAscii('Zoë Müller-Ångström')).toBe('Zoe Muller-Angstrom');
  });

  it('folds the ligatures that decompose to two letters', () => {
    expect(foldToAscii('Æsa Øystein Straße')).toBe('AEsa Oystein Strasse');
  });

  it('drops characters with no ASCII equivalent rather than emitting a question mark', () => {
    expect(foldToAscii('李Anna')).toBe('Anna');
  });
});

describe('generateCorrelationKey', () => {
  it('produces a clean lowercased key', () => {
    expect(generate(context('Anna', 'Novak'))).toEqual({
      ok: true,
      correlationKey: 'anna.novak',
    });
  });

  it('strips apostrophes and spaces and folds non-ASCII', () => {
    // sAMAccountName is not a display name. An apostrophe in it breaks
    // downstream systems that never quoted it.
    expect(generate(context('Anna Maria', "O'Brien"))).toEqual({
      ok: true,
      correlationKey: 'anna.obrien',
    });
    expect(generate(context('Zoë', 'Müller'))).toEqual({
      ok: true,
      correlationKey: 'zoe.muller',
    });
  });

  it('appends an incrementing suffix on a collision', () => {
    expect(generate(context('Anna', 'Novak'), ['anna.novak'])).toEqual({
      ok: true,
      correlationKey: 'anna.novak2',
    });
  });

  it('walks a collision chain', () => {
    expect(
      generate(context('Anna', 'Novak'), [
        'anna.novak',
        'anna.novak2',
        'anna.novak3',
      ]),
    ).toEqual({ ok: true, correlationKey: 'anna.novak4' });
  });

  it('truncates from the right to stay within 20 characters', () => {
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'));
    expect(result).toEqual({
      ok: true,
      correlationKey: 'bartholomew.vandenbe',
    });
    expect((result as { correlationKey: string }).correlationKey).toHaveLength(20);
  });

  it('preserves the suffix when truncating, cutting the base instead', () => {
    // The suffix is what makes the name unique. Truncating it away produces a
    // name that collides with the one it was invented to avoid.
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'), [
      'bartholomew.vandenbe',
    ]);
    expect(result).toEqual({ ok: true, correlationKey: 'bartholomew.vandenb2' });
    expect((result as { correlationKey: string }).correlationKey).toHaveLength(20);
  });

  it('preserves a multi-digit suffix when truncating', () => {
    // Attempts 1..9 are taken: the base truncated to 20, then the base
    // truncated to 19 with a single digit. Attempt 10 has a two-character
    // suffix, so the base is cut to 18 and the result is
    // "bartholomew.vanden" + "10" -- a different string from
    // "bartholomew.vandenb1", which is what naive truncation would produce and
    // what would collide with attempt 1's neighbourhood.
    const taken = ['bartholomew.vandenbe'];
    for (let n = 2; n <= 9; n += 1) taken.push(`bartholomew.vandenb${n}`);
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'), taken);
    expect(result).toEqual({ ok: true, correlationKey: 'bartholomew.vanden10' });
    expect((result as { correlationKey: string }).correlationKey).toHaveLength(20);
  });

  it('refuses when the template cannot resolve, naming the field', () => {
    expect(generate(context('Anna', ''))).toEqual({
      ok: false,
      reason: 'template_unresolvable',
      missing: ['person.familyName'],
    });
  });

  it('refuses when a name of only non-ASCII characters folds away to nothing', () => {
    // Folding "李" to "" would otherwise produce the key ".", or "", and a
    // login of "" is a login somebody else effectively owns.
    expect(generate(context('李', '王'))).toEqual({
      ok: false,
      reason: 'template_unresolvable',
      missing: ['person.givenName', 'person.familyName'],
    });
  });

  it('gives up at the attempt limit rather than picking something arbitrary', () => {
    const taken = ['anna.novak'];
    for (let n = 2; n <= 5; n += 1) taken.push(`anna.novak${n}`);
    expect(generate(context('Anna', 'Novak'), taken, { maxAttempts: 5 })).toEqual({
      ok: false,
      reason: 'exhausted',
      attempts: 5,
    });
  });

  it('never returns a key longer than the cap', () => {
    const result = generate(context('Maximiliana', 'Featherstonehaugh'));
    expect((result as { correlationKey: string }).correlationKey.length).toBeLessThanOrEqual(
      SAM_ACCOUNT_NAME_MAX_LENGTH,
    );
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/names.test.ts`
Expected: FAIL — cannot find module `./names.js`.

- [ ] **Step 7: Write name generation**

`packages/core/src/provision/names.ts`:

```ts
import { renderTemplate, type TemplateContext } from './templates.js';

/**
 * `sAMAccountName` is capped at 20 characters by Active Directory, must be
 * unique in the domain, and is the thing a collision actually collides on.
 */
export const SAM_ACCOUNT_NAME_MAX_LENGTH = 20;

/** Ligatures that decompose to more than one ASCII letter. */
const LIGATURES: Record<string, string> = {
  æ: 'ae',
  Æ: 'AE',
  ø: 'o',
  Ø: 'O',
  ß: 'ss',
  đ: 'd',
  Đ: 'D',
  ł: 'l',
  Ł: 'L',
  þ: 'th',
  Þ: 'TH',
};

/**
 * Folds a name to ASCII: accents to their base letters, the handful of
 * ligatures that need two letters, and anything with no ASCII equivalent
 * dropped.
 *
 * Dropped, not replaced with a placeholder: a login containing `?` is worse
 * than a shorter one, and a name that folds away entirely is caught by the
 * caller as an unresolvable template rather than becoming an empty login.
 */
export function foldToAscii(value: string): string {
  const expanded = [...value]
    .map((character) => LIGATURES[character] ?? character)
    .join('');
  return expanded
    .normalize('NFD')
    // Combining diacritical marks.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^ -~]/g, '');
}

export interface NameGenerationInput {
  template: string;
  context: TemplateContext;
  /**
   * Every key already reserved: Syntra's own `TargetAccount.correlationKey`
   * rows for this target, unioned with the target's current inventory. Both,
   * because Syntra holds keys the target has not seen yet (a `pending`
   * account) and the target holds keys Syntra never made.
   */
  taken: ReadonlySet<string>;
  maxLength: number;
  maxAttempts: number;
}

export type NameGenerationResult =
  | { ok: true; correlationKey: string }
  | { ok: false; reason: 'template_unresolvable'; missing: string[] }
  | { ok: false; reason: 'exhausted'; attempts: number };

/** Lowercased, ASCII-folded, apostrophes and spaces and anything else stripped. */
function sanitise(value: string): string {
  return foldToAscii(value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');
}

/**
 * Generates a correlation key, trying the base value then the base value with
 * an incrementing numeric suffix, truncating from the right to stay within the
 * cap **while preserving the suffix**.
 *
 * Preserving the suffix is the load-bearing half. Truncating a 20-character
 * limit naively cuts the digits off, which produces exactly the name the
 * suffix was invented to avoid — and the uniqueness check then passes because
 * the truncated candidate was never in `taken`, right up until the target
 * refuses it.
 *
 * A generation that cannot produce a unique key within the attempt limit does
 * not pick something arbitrary. It fails, and the caller makes that person
 * unprocessable for that target and says so by name.
 *
 * Uniqueness is *checked* here and *enforced* by the unique index on
 * `(tenantId, targetSystemId, correlationKey)`. Two concurrent runs generating
 * the same name for two different people is a race the database refuses, not
 * one this function is trusted to avoid.
 *
 * Pure: no clock, no database, no I/O.
 */
export function generateCorrelationKey(
  input: NameGenerationInput,
): NameGenerationResult {
  const rendered = renderTemplate(input.template, input.context);
  if (!rendered.ok) {
    return { ok: false, reason: 'template_unresolvable', missing: rendered.missing };
  }

  const base = sanitise(rendered.value).replace(/^[.-]+|[.-]+$/g, '');
  if (base === '') {
    // The template resolved, but every character folded away — a name written
    // entirely in a script with no ASCII equivalent. Report it the same way as
    // an unresolvable template, naming the fields that produced nothing, so
    // the exception a human reads points at a record they can fix.
    const missing = Object.entries(input.context.person)
      .filter(([, value]) => sanitise(value ?? '') === '')
      .map(([field]) => `person.${field}`);
    return {
      ok: false,
      reason: 'template_unresolvable',
      missing: missing.length > 0 ? missing : ['person'],
    };
  }

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const suffix = attempt === 1 ? '' : String(attempt);
    const room = input.maxLength - suffix.length;
    const candidate = `${base.slice(0, room)}${suffix}`;
    if (!input.taken.has(candidate)) {
      return { ok: true, correlationKey: candidate };
    }
  }

  return { ok: false, reason: 'exhausted', attempts: input.maxAttempts };
}
```

- [ ] **Step 8: Export both from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/templates.js';
export * from './provision/names.js';
```

- [ ] **Step 9: Run both test files**

Run: `pnpm vitest run packages/core/src/provision/templates.test.ts packages/core/src/provision/names.test.ts`
Expected: PASS, 8 + 14 tests.

If "preserves the suffix when truncating" fails, the truncation cut the digits instead of the base. That defect passes every uniqueness check in this function and is refused only by the target, on a write, in production.

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add account profile templates and correlation key generation"
```

---

## Task 7: Desired state

The pure function at the centre of the design. Spec §7 and §8 in one module.

> **CORRECTIONS APPLIED DURING IMPLEMENTATION — Ruling P23.** Five instructions
> in this task as first written were wrong. The code below has been amended at
> each site; the reasoning is here so a later reader does not re-derive it.
>
> 1. **An account requirement asked at the horizon ALONE deprovisions an
>    employee who is still at their desk.** `horizon` is `now + preHireDays`, so
>    `activeOn(contracts, horizon)` asks "will this person be employed in a
>    fortnight". Somebody whose contract ends next Tuesday answers no, so
>    `required` is false — which the planner reads as a mover and treats with an
>    immediate disable and an immediate revoke of everything, five days before
>    they leave, while their entitlements (computed at `now`) are still desired.
>    The requirement is now decided over the **window** `[now, horizon]` via a
>    new `activeBetween`. Every pre-hire behaviour is unchanged; `preHireDays`
>    becomes purely additive, which is what a setting of that name must be.
>    Spec §8 has been amended to match (Ruling P5's second half).
> 2. **`renderTemplate` was called directly on `containerTemplate`**, which is
>    exactly what the ledger's Ruling P22 forbids: a department of
>    `Finance,OU=Domain Controllers` renders a VALID DN naming a container the
>    administrator never wrote. Task 6 left `escapeDnValue` as an optional
>    argument nobody is forced to pass, and this was the first call site to not
>    pass it. `renderContainer()` now exists in `templates.ts` and always
>    escapes; **Tasks 11 and 16 must call it too** — see the note on Task 16's
>    `explain.ts`, which had the same line.
> 3. **The person's own key was excluded from `takenCorrelationKeys`
>    case-sensitively.** That set is Syntra's rows unioned with the *target's*
>    inventory, and the target's copy of this person's own account carries the
>    directory's casing (the ledger's Task 6 carry-forward). `Anna.Novak`
>    therefore survived the filter, generation folded it to `anna.novak`, found
>    a collision with the person's own login, and proposed renaming them to
>    `anna.novak2`. Compared lowercased on both sides now.
> 4. **`export * from './provision/types.js'` does not compile**: TS2308,
>    because `policy/types.js` already exports a different `ContractFacts` — the
>    four-field subset an authentication policy reads. A star export of both
>    leaves the barrel exporting neither. `index.ts` now enumerates the
>    provision types and aliases that one to `ProvisionContractFacts`. Nothing
>    inside `provision/` is affected: every task imports it from `./types.js`.
> 5. `maxLength: 20` is `SAM_ACCOUNT_NAME_MAX_LENGTH`, already exported by
>    `names.ts` for this. A hand-copied cap is a cap that drifts.
>
> Also folded in: `entitlementsOrAccountActiveNow` is now `accountGrantedBy`,
> called twice with different contract sets, which removes both the misleading
> name and the two redundant `length > 0` guards in front of it (each of which
> was an unkillable mutant). A blank container with a blank fallback is
> unprocessable rather than a write to an empty DN (spec §13, "a template that
> resolves to nothing and has no fallback").

**Files:**
- Create: `packages/core/src/provision/types.ts`
- Create: `packages/core/src/provision/desired.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/desired.test.ts`

**Interfaces:**
- Consumes: `evaluateCondition`, `type Condition`, `type ConditionFacts` from `./condition.js`; `renderTemplate`, `type TemplateContext` from `./templates.js`; `generateCorrelationKey`, `type NameGenerationResult` from `./names.js`.
- Produces (all in `./types.js` unless noted):
  - `interface PersonFacts { id: string; givenName: string; familyName: string; nameConvention: string; businessEmail: string | null; personalEmail: string | null; status: string }`

**These are the columns `Person` actually has.** `packages/db/prisma/schema.prisma` declares `givenName`, `familyName`, `nameConvention`, `businessEmail`, `personalEmail`, `externalId` and `status`; there is **no `email` column and no `displayName` column**, and spec section 15 forbids adding one. `givenName` and `familyName` are `String` and not `String?`, so they are non-null here too. A `displayName` is derived, by `personDisplayName` below, and every account-profile example in this plan says `%person.businessEmail%` rather than `%person.email%`.
  - `interface ContractFacts { id: string; sequence: number; isPrimary: boolean; startDate: Date; endDate: Date | null; department: string | null; jobTitle: string | null; costCentre: string | null; employer: string | null; location: string | null; fte: number | null }`
  - `interface RuleFacts { id: string; name: string; condition: Condition; grantsAccount: boolean; enabled: boolean; entitlementIds: string[] }`
  - `interface ProfileFacts { correlationKeyTemplate: string; maxUniquenessAttempts: number; containerTemplate: string; fallbackContainer: string; attributeTemplates: Record<string, string>; baseDn: string }`
  - `interface Attribution { ruleId: string; ruleName: string; contractId: string }`
  - `type UnprocessableKind = 'no_contracts' | 'unresolvable_rule' | 'template_unresolvable' | 'container_missing' | 'name_generation_exhausted' | 'target_read_incomplete' | 'account_conflict'`
  - `interface DesiredState { personId: string; account: { required: boolean; attributes: Record<string, string[]>; container: string; enabledNow: boolean; correlationKey: string | null } | null; entitlements: Set<string>; attribution: Map<string, Attribution[]>; notYetStarted: boolean; unprocessable: { kind: UnprocessableKind; message: string } | null }`
  - `function personDisplayName(person: PersonFacts): string` (in `./desired.js`)
  - `function resolveMappingContract(contracts: ContractFacts[], on: Date): ContractFacts | null` (in `./desired.js`)
  - `function activeOn(contracts: ContractFacts[], on: Date): ContractFacts[]` (in `./desired.js`)
  - `function latestContractEnd(contracts: ContractFacts[]): Date | null` (in `./desired.js`)
  - `function desiredState(input: DesiredStateInput): DesiredState` (in `./desired.js`)
  - `interface DesiredStateInput { person: PersonFacts; contracts: ContractFacts[]; rules: RuleFacts[]; profile: ProfileFacts; entitlementStatus: ReadonlyMap<string, 'present' | 'missing' | 'unreadable'>; existingCorrelationKey: string | null; takenCorrelationKeys: ReadonlySet<string>; renameEnabled: boolean; now: Date; horizon: Date }`

`notYetStarted` and `renameEnabled` both exist because without them a field on the target's screen has no behaviour behind it, and in one case the missing behaviour is destructive.

**`notYetStarted`** distinguishes *this person has not started yet* from *this person has left*. Both produce `account.required === false` and an empty entitlement set, and `planActions` has to tell them apart: a leaver's contracts have ended, so the ladder's timers have a date to run from, while a future joiner's contracts are open-ended and `latestContractEnd` returns null — which the planner reads as "still employed, no grace period to measure", and it revokes everything and disables the account *immediately*, for somebody who has not started. Spec section 8 requires the opposite: leave it exactly as it is and report it as drift, because an account belonging to somebody whose contract has not started is a question, not an instruction (Ruling P10).

**`renameEnabled`** is the target column that decides whether a correlation key may be regenerated at all. Without it here, `desiredState` returns the existing key whenever there is one and never consults the setting, so `state.account.correlationKey !== current.correlationKey` can never hold on the production path — `rename_account` becomes dead code with a UI toggle in front of it.

- [ ] **Step 1: Write the shared value types**

`packages/core/src/provision/types.ts`:

```ts
import type { Condition } from './condition.js';

/**
 * A person, flattened to exactly what the pure stages need.
 *
 * These are the columns `Person` has. It has no `email` and no `displayName`;
 * spec section 15 says this slice changes no existing table, so neither is
 * added. `businessEmail` and `personalEmail` are the two address columns, and
 * a display name is DERIVED by `personDisplayName` in `desired.ts`.
 *
 * `givenName` and `familyName` are non-null because the column is `String`,
 * not `String?`.
 */
export interface PersonFacts {
  id: string;
  givenName: string;
  familyName: string;
  /**
   * How the person's name is composed. Carried into the template context as a
   * fact a template may read, rather than branching on it here: `Person` holds
   * no partner-name columns, so there is nothing for a convention to choose
   * between yet, and deriving one from columns that do not exist would be
   * inventing data.
   */
  nameConvention: string;
  businessEmail: string | null;
  personalEmail: string | null;
  status: string;
}

export interface ContractFacts {
  id: string;
  sequence: number;
  isPrimary: boolean;
  startDate: Date;
  /** Null means open-ended. */
  endDate: Date | null;
  department: string | null;
  jobTitle: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  fte: number | null;
}

export interface RuleFacts {
  id: string;
  name: string;
  condition: Condition;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}

export interface ProfileFacts {
  correlationKeyTemplate: string;
  maxUniquenessAttempts: number;
  containerTemplate: string;
  fallbackContainer: string;
  /** Target attribute name to template, e.g. { displayName: '%person.givenName% %person.familyName%' }. */
  attributeTemplates: Record<string, string>;
  baseDn: string;
}

/**
 * Why somebody holds something: a rule name and the contract that satisfied
 * it. Recorded at evaluation time because it is unanswerable after the fact,
 * and "why does this person hold this?" is the most-asked question of any
 * provisioning product.
 */
export interface Attribution {
  ruleId: string;
  ruleName: string;
  contractId: string;
}

export type UnprocessableKind =
  | 'no_contracts'
  | 'unresolvable_rule'
  | 'template_unresolvable'
  | 'container_missing'
  | 'name_generation_exhausted'
  | 'target_read_incomplete'
  | 'account_conflict';

export interface DesiredAccount {
  required: boolean;
  /** The complete managed set. update_account carries all of it, never a delta. */
  attributes: Record<string, string[]>;
  container: string;
  /**
   * Whether the account should be enabled *now*, as opposed to merely existing.
   * A pre-hire has required: true and enabledNow: false.
   */
  enabledNow: boolean;
  /** Null when the person already has an account and keeps its existing key. */
  correlationKey: string | null;
}

export interface DesiredState {
  personId: string;
  account: DesiredAccount | null;
  entitlements: Set<string>;
  attribution: Map<string, Attribution[]>;
  /**
   * This person holds contracts and every one of them starts after the
   * horizon: they have not started yet.
   *
   * A THIRD state, not a shade of the other two. `account.required === false`
   * is equally true of a leaver, and the two need opposite treatment: a
   * leaver's contracts have ended, so the ladder has a date to measure from; a
   * future joiner's are open-ended, `latestContractEnd` returns null, and the
   * planner reads that as "still employed, no departure date" and disables
   * them and revokes everything on the spot -- to somebody who starts in six
   * weeks. Spec section 8: an account belonging to somebody whose contract has
   * not started is a question, not an instruction. Nothing is proposed, and it
   * is reported as drift.
   */
  notYetStarted: boolean;
  /**
   * When set, this person is excluded from the target's plan ENTIRELY and
   * every other field on this object is ignored. `account: null` and an
   * unprocessable person are not the same thing: the first means "this person
   * should have nothing", the second means "we could not work out what this
   * person should have". They produce identical empty sets and opposite
   * correct behaviours.
   */
  unprocessable: { kind: UnprocessableKind; message: string } | null;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/provision/desired.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { activeOn, desiredState, latestContractEnd, resolveMappingContract } from './desired.js';
import type { ContractFacts, PersonFacts, ProfileFacts, RuleFacts } from './types.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const person: PersonFacts = {
  id: 'person-1',
  givenName: 'Anna',
  familyName: 'Novak',
  nameConvention: 'familyName',
  businessEmail: 'anna@acme.test',
  personalEmail: null,
  status: 'active',
};

const contract = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  id: 'contract-1',
  sequence: 1,
  isPrimary: true,
  startDate: day('2020-01-01'),
  endDate: null,
  department: 'Finance',
  jobTitle: 'Analyst',
  costCentre: 'CC-100',
  employer: 'Acme Care',
  location: 'Utrecht',
  fte: 1,
  ...over,
});

const profile: ProfileFacts = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: {
    displayName: '%person.givenName% %person.familyName%',
    userPrincipalName: '%person.givenName.first%.%person.familyName%@acme.test',
    mail: '%person.businessEmail%',
  },
  baseDn: 'DC=acme,DC=test',
};

const financeRule: RuleFacts = {
  id: 'rule-finance',
  name: 'Finance staff',
  condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
  grantsAccount: true,
  enabled: true,
  entitlementIds: ['ent-finance'],
};

const teachingRule: RuleFacts = {
  id: 'rule-teaching',
  name: 'Teaching staff',
  condition: { field: 'contract.department', op: 'equals', value: 'Teaching' },
  grantsAccount: true,
  enabled: true,
  entitlementIds: ['ent-teaching'],
};

const present = new Map<string, 'present' | 'missing' | 'unreadable'>([
  ['ent-finance', 'present'],
  ['ent-teaching', 'present'],
]);

const evaluate = (
  contracts: ContractFacts[],
  rules: RuleFacts[] = [financeRule],
  over: Partial<Parameters<typeof desiredState>[0]> = {},
) =>
  desiredState({
    person,
    contracts,
    rules,
    profile,
    entitlementStatus: present,
    existingCorrelationKey: null,
    takenCorrelationKeys: new Set<string>(),
    renameEnabled: false,
    now: NOW,
    horizon: NOW,
    ...over,
  });

describe('activeOn', () => {
  it('includes a contract on its first and last day', () => {
    const c = contract({ startDate: NOW, endDate: NOW });
    expect(activeOn([c], NOW)).toHaveLength(1);
  });

  it('excludes a contract that has not started and one that has ended', () => {
    expect(activeOn([contract({ startDate: day('2026-07-01') })], NOW)).toEqual([]);
    expect(activeOn([contract({ endDate: day('2026-06-14') })], NOW)).toEqual([]);
  });
});

describe('latestContractEnd', () => {
  it('takes the later of two end dates', () => {
    // A person whose second contract ran three months longer left three
    // months later. Anchoring the ladder to the first end date deprovisions
    // somebody who is still employed.
    const end = latestContractEnd([
      contract({ id: 'a', endDate: day('2026-03-31') }),
      contract({ id: 'b', endDate: day('2026-06-30') }),
    ]);
    expect(end).toEqual(day('2026-06-30'));
  });

  it('returns null when any contract is open-ended', () => {
    expect(
      latestContractEnd([
        contract({ id: 'a', endDate: day('2026-03-31') }),
        contract({ id: 'b', endDate: null }),
      ]),
    ).toBeNull();
  });

  it('returns null for no contracts', () => {
    expect(latestContractEnd([])).toBeNull();
  });
});

describe('resolveMappingContract', () => {
  it('prefers the primary contract when it is currently active', () => {
    // The same rule Access uses for claim mappings, so the department printed
    // in the directory is the department the SAML assertion carries.
    const primary = contract({ id: 'p', sequence: 5, isPrimary: true });
    const other = contract({ id: 'o', sequence: 1, isPrimary: false });
    expect(resolveMappingContract([other, primary], NOW)?.id).toBe('p');
  });

  it('falls back to the lowest sequence when the primary is not active', () => {
    const primary = contract({
      id: 'p',
      sequence: 5,
      isPrimary: true,
      endDate: day('2026-01-01'),
    });
    const low = contract({ id: 'low', sequence: 2, isPrimary: false });
    const high = contract({ id: 'high', sequence: 9, isPrimary: false });
    expect(resolveMappingContract([high, primary, low], NOW)?.id).toBe('low');
  });

  it('returns null when nothing is active', () => {
    expect(resolveMappingContract([contract({ endDate: day('2020-01-01') })], NOW)).toBeNull();
  });
});

describe('desiredState — the joiner', () => {
  it('requires an enabled account with the rule entitlement and full attribution', () => {
    const result = evaluate([contract()]);
    expect(result.unprocessable).toBeNull();
    expect(result.account).toEqual({
      required: true,
      attributes: {
        displayName: ['Anna Novak'],
        userPrincipalName: ['Anna.Novak@acme.test'],
        mail: ['anna@acme.test'],
      },
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      enabledNow: true,
      correlationKey: 'anna.novak',
    });
    expect([...result.entitlements]).toEqual(['ent-finance']);
    expect(result.attribution.get('ent-finance')).toEqual([
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'contract-1' },
    ]);
  });

  it('keeps an existing correlation key rather than regenerating it', () => {
    // Somebody marrying does not get a new login. Renaming breaks certificate
    // subjects, profile paths, file ownership and every downstream system that
    // keyed on it.
    const result = evaluate([contract({ department: 'Finance' })], [financeRule], {
      existingCorrelationKey: 'a.novak',
    });
    expect(result.account?.correlationKey).toBe('a.novak');
  });
});

describe('desiredState — concurrent contracts', () => {
  it('unions entitlements across two concurrent contracts', () => {
    // A researcher who is 0.6 FTE in physics and 0.4 FTE teaching holds two
    // contracts, and both are true at once. Union is the only composition
    // that gets that right.
    const result = evaluate(
      [
        contract({ id: 'c-fin', sequence: 1, department: 'Finance', fte: 0.6 }),
        contract({
          id: 'c-teach',
          sequence: 2,
          isPrimary: false,
          department: 'Teaching',
          fte: 0.4,
        }),
      ],
      [financeRule, teachingRule],
    );
    expect([...result.entitlements].sort()).toEqual(['ent-finance', 'ent-teaching']);
    expect(result.attribution.get('ent-teaching')).toEqual([
      { ruleId: 'rule-teaching', ruleName: 'Teaching staff', contractId: 'c-teach' },
    ]);
  });

  it('records both attributions when two contracts satisfy the same rule', () => {
    const result = evaluate(
      [
        contract({ id: 'c1', sequence: 1 }),
        contract({ id: 'c2', sequence: 2, isPrimary: false }),
      ],
      [financeRule],
    );
    expect(result.attribution.get('ent-finance')).toEqual([
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'c1' },
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'c2' },
    ]);
  });

  it('keeps the account and the surviving entitlement when one of two contracts ends', () => {
    // The case a model flattened onto the user record gets silently wrong in
    // the dangerous direction: it usually revokes everything.
    const result = evaluate(
      [
        contract({
          id: 'c-fin',
          sequence: 1,
          department: 'Finance',
          endDate: day('2026-05-31'),
        }),
        contract({
          id: 'c-teach',
          sequence: 2,
          isPrimary: false,
          department: 'Teaching',
        }),
      ],
      [financeRule, teachingRule],
    );
    expect(result.account?.required).toBe(true);
    expect([...result.entitlements]).toEqual(['ent-teaching']);
    expect(result.attribution.has('ent-finance')).toBe(false);
  });

  it('takes attributes from the primary contract when several are active', () => {
    const result = evaluate(
      [
        contract({ id: 'c-fin', sequence: 3, isPrimary: true, department: 'Finance' }),
        contract({
          id: 'c-teach',
          sequence: 1,
          isPrimary: false,
          department: 'Teaching',
        }),
      ],
      [financeRule, teachingRule],
    );
    // Not "Teaching", even though that contract has the lower sequence: the
    // primary is active, so it wins -- exactly as resolveContractForMapping
    // decides it for claims.
    expect(result.account?.container).toBe('OU=Finance,OU=Users,DC=acme,DC=test');
  });
});

describe('desiredState — the leaver', () => {
  it('requires no account when every contract has ended', () => {
    const result = evaluate([contract({ endDate: day('2026-05-31') })]);
    expect(result.unprocessable).toBeNull();
    expect(result.account).toEqual({
      required: false,
      attributes: {},
      container: '',
      enabledNow: false,
      correlationKey: null,
    });
    expect([...result.entitlements]).toEqual([]);
  });
});

describe('desiredState — the mover whose account is no longer required', () => {
  it('requires no account while the person still holds an active contract', () => {
    // A mover, not a leaver: they moved from finance to facilities and the
    // finance system is not theirs. The ladder's timers are anchored to a
    // contract end date and this person does not have one.
    const result = evaluate([contract({ department: 'Facilities' })]);
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
  });
});

describe('desiredState — the pre-hire horizon', () => {
  it('requires a disabled account for a contract starting inside the horizon', () => {
    const horizon = day('2026-07-01');
    const result = evaluate([contract({ startDate: day('2026-06-25') })], [financeRule], {
      horizon,
    });
    // Created, named, placed and password-set -- and left disabled, holding
    // nothing. A pre-hire never holds access before their start date.
    expect(result.account?.required).toBe(true);
    expect(result.account?.enabledNow).toBe(false);
    expect(result.account?.container).toBe('OU=Finance,OU=Users,DC=acme,DC=test');
    expect([...result.entitlements]).toEqual([]);
  });

  it('marks a contract starting beyond the horizon as not yet started, distinctly from a leaver', () => {
    // The previous version of this test asserted only `required === false`,
    // which is EQUALLY TRUE of a leaver -- and that is precisely the assertion
    // that cannot tell the two apart. It passed while the planner proposed an
    // immediate revoke-everything and disable for somebody who starts in
    // September, with the message "the person is still employed, so there is
    // no departure date to measure a grace period from" (Ruling P10).
    const horizon = day('2026-07-01');
    const result = evaluate([contract({ startDate: day('2026-09-01') })], [financeRule], {
      horizon,
    });
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
    expect(result.notYetStarted).toBe(true);
  });

  it('does not mark a leaver as not yet started', () => {
    // The discriminator. A leaver reaches the same `required: false` by a
    // different route and must keep reaching the ladder.
    const result = evaluate([contract({ endDate: day('2026-05-31') })]);
    expect(result.account?.required).toBe(false);
    expect(result.notYetStarted).toBe(false);
  });

  it('does not mark somebody with one ended and one future contract as not yet started', () => {
    // They have a departure date. The ladder owns them, and the future
    // contract is what the next run will act on when it starts.
    const result = evaluate([
      contract({ id: 'past', endDate: day('2026-05-31') }),
      contract({ id: 'future', sequence: 2, startDate: day('2026-09-01') }),
    ]);
    expect(result.notYetStarted).toBe(false);
  });

  it('enables the account and grants entitlements on the start date', () => {
    const start = day('2026-06-15');
    const result = evaluate([contract({ startDate: start })], [financeRule], {
      now: start,
      horizon: day('2026-06-22'),
    });
    expect(result.account?.enabledNow).toBe(true);
    expect([...result.entitlements]).toEqual(['ent-finance']);
  });
});

describe('desiredState — persons Provision cannot process', () => {
  it('makes a person with no contracts at all unprocessable, not a leaver', () => {
    // The entire lesson of the previous slice, restated. An incomplete record
    // is not a departure, and computing it as one revokes real access.
    const result = evaluate([]);
    expect(result.unprocessable).toEqual({
      kind: 'no_contracts',
      message:
        'Anna Novak holds no contracts at all, so their access cannot be computed; this is an incomplete record, not a departure',
    });
    expect(result.account).toBeNull();
    expect([...result.entitlements]).toEqual([]);
  });

  it('makes every person unprocessable when a rule names a missing entitlement', () => {
    // The WHOLE rule is unresolvable, not just that entitlement. Evaluating it
    // without the missing one produces a desired set that lacks it, and the
    // diff then proposes revoking it from everybody who holds it.
    const status = new Map<string, 'present' | 'missing' | 'unreadable'>([
      ['ent-finance', 'missing'],
    ]);
    const result = evaluate([contract()], [financeRule], { entitlementStatus: status });
    expect(result.unprocessable).toEqual({
      kind: 'unresolvable_rule',
      message:
        'the rule "Finance staff" names entitlement ent-finance, which is missing in the target catalog; the rule cannot be resolved and produces no desired state',
    });
    expect(result.account).toBeNull();
  });

  it('makes every person unprocessable when a rule names an unreadable entitlement', () => {
    const status = new Map<string, 'present' | 'missing' | 'unreadable'>([
      ['ent-finance', 'unreadable'],
    ]);
    const result = evaluate([contract()], [financeRule], { entitlementStatus: status });
    expect(result.unprocessable?.kind).toBe('unresolvable_rule');
    expect(result.unprocessable?.message).toContain('unreadable');
  });

  it('makes a person unprocessable when an attribute template cannot resolve', () => {
    const result = desiredState({
      person: { ...person, businessEmail: null },
      contracts: [contract()],
      rules: [financeRule],
      profile,
      entitlementStatus: present,
      existingCorrelationKey: null,
      takenCorrelationKeys: new Set(),
      renameEnabled: false,
      now: NOW,
      horizon: NOW,
    });
    expect(result.unprocessable).toEqual({
      kind: 'template_unresolvable',
      message:
        'the account profile template for "mail" references person.businessEmail, which resolves to nothing for this person',
    });
  });

  it('falls back rather than failing when the container template resolves to nothing', () => {
    // A required fallback exists precisely so an empty department does not
    // make somebody unprocessable. A container that does not EXIST in the
    // target is a different failure, detected against the target's inventory
    // in reconcile.
    const result = evaluate([contract({ department: null })], [
      { ...financeRule, condition: { all: [] } },
    ]);
    expect(result.unprocessable).toBeNull();
    expect(result.account?.container).toBe('OU=Users,DC=acme,DC=test');
  });

  it('makes a person unprocessable when name generation is exhausted', () => {
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract()], [financeRule], {
      takenCorrelationKeys: taken,
    });
    expect(result.unprocessable).toEqual({
      kind: 'name_generation_exhausted',
      message:
        'no unique account name could be generated for Anna Novak within 20 attempts',
    });
  });

  it('does not run name generation at all for somebody who needs no account', () => {
    // A leaver whose name would collide must not become unprocessable for it:
    // that would freeze the deprovisioning of the person the ladder exists for.
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract({ endDate: day('2026-01-01') })], [financeRule], {
      takenCorrelationKeys: taken,
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account?.required).toBe(false);
  });
});

describe('desiredState — renaming', () => {
  it('keeps the existing key when renaming is off, even when the template would produce another', () => {
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: false,
    });
    expect(result.account?.correlationKey).toBe('a.novak');
  });

  it('regenerates the key when renaming is on, so the planner has something to propose', () => {
    // Without this the setting has nothing behind it: desiredState returns the
    // existing key unconditionally, `state.account.correlationKey !==
    // current.correlationKey` can never hold, and rename_account is dead code
    // with a toggle in front of it.
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: true,
    });
    expect(result.account?.correlationKey).toBe('anna.novak');
  });

  it('keeps the existing key when renaming is on and generation cannot produce one', () => {
    // A rename is never worth making somebody unprocessable for. Their login
    // is not the thing that needs fixing.
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: true,
      takenCorrelationKeys: taken,
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account?.correlationKey).toBe('a.novak');
  });
});

describe('desiredState — rules that are off or grant no account', () => {
  it('ignores a disabled rule entirely', () => {
    const result = evaluate([contract()], [{ ...financeRule, enabled: false }]);
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
  });

  it('grants the entitlement without requiring an account when grantsAccount is false', () => {
    const result = evaluate(
      [contract()],
      [
        { ...financeRule, grantsAccount: false },
        { ...teachingRule, grantsAccount: true },
      ],
    );
    // The entitlement is still desired -- it is granted on whatever account
    // the person has for other reasons -- but this rule does not by itself
    // justify creating one.
    expect([...result.entitlements]).toEqual(['ent-finance']);
    expect(result.account?.required).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/desired.test.ts`
Expected: FAIL — cannot find module `./desired.js`.

- [ ] **Step 4: Write the desired-state function**

`packages/core/src/provision/desired.ts`:

```ts
import { evaluateCondition, type ConditionFacts } from './condition.js';
import { generateCorrelationKey } from './names.js';
import { renderTemplate, type TemplateContext } from './templates.js';
import type {
  Attribution,
  ContractFacts,
  DesiredAccount,
  DesiredState,
  PersonFacts,
  ProfileFacts,
  RuleFacts,
} from './types.js';

export interface DesiredStateInput {
  person: PersonFacts;
  contracts: ContractFacts[];
  rules: RuleFacts[];
  profile: ProfileFacts;
  /** The target's catalog. A rule naming anything but `present` is unresolvable. */
  entitlementStatus: ReadonlyMap<string, 'present' | 'missing' | 'unreadable'>;
  /**
   * The key this person's account already holds, if any. Regenerated only
   * when `renameEnabled` is on -- somebody marrying does not get a new login
   * by default, because renaming breaks certificate subjects, profile paths,
   * file ownership and mailbox aliases.
   */
  existingCorrelationKey: string | null;
  takenCorrelationKeys: ReadonlySet<string>;
  /**
   * The target's `renameEnabled`. Without it here the setting has nothing
   * behind it: the existing key is returned unconditionally, so the planner's
   * `state.account.correlationKey !== current.correlationKey` can never hold
   * and `rename_account` is unreachable.
   */
  renameEnabled: boolean;
  /** Decides whether the account is ENABLED and which entitlements it holds. */
  now: Date;
  /** `now + preHireDays`. Decides whether an account is REQUIRED and its attributes. */
  horizon: Date;
}

/**
 * Contracts in force on `on`. Both boundaries inclusive — a contract is active
 * on its first and last day — matching `activeContracts` in
 * `packages/core/src/identity/contract-service.ts`.
 */
export function activeOn(contracts: ContractFacts[], on: Date): ContractFacts[] {
  return contracts.filter(
    (c) =>
      c.startDate.getTime() <= on.getTime() &&
      (c.endDate === null || c.endDate.getTime() >= on.getTime()),
  );
}

/**
 * The latest end date across every contract — the day the person stopped being
 * employed at all, which is what the whole deprovisioning ladder is measured
 * from. A person whose second contract ran three months longer left three
 * months later.
 *
 * Null when any contract is open-ended (they have not left) or there are none.
 */
export function latestContractEnd(contracts: ContractFacts[]): Date | null {
  if (contracts.length === 0) return null;
  if (contracts.some((c) => c.endDate === null)) return null;
  return contracts.reduce<Date>(
    (latest, c) => (c.endDate!.getTime() > latest.getTime() ? c.endDate! : latest),
    contracts[0]!.endDate!,
  );
}

/**
 * Which contract supplies attribute values: the primary contract if it is
 * currently active, otherwise the active contract with the lowest sequence.
 *
 * This is `resolveContractForMapping`'s precedence, restated over plain values
 * because this module is pure and takes no transaction. Two subsystems
 * disagreeing about somebody's department is a support call nobody can close,
 * so a test in this task asserts the two agree rather than trusting the
 * restatement.
 */
export function resolveMappingContract(
  contracts: ContractFacts[],
  on: Date,
): ContractFacts | null {
  const active = [...activeOn(contracts, on)].sort((a, b) => a.sequence - b.sequence);
  if (active.length === 0) return null;
  return active.find((c) => c.isPrimary) ?? active[0]!;
}

function conditionFacts(
  person: PersonFacts,
  contract: ContractFacts,
): ConditionFacts {
  return {
    'contract.department': contract.department,
    'contract.jobTitle': contract.jobTitle,
    'contract.costCentre': contract.costCentre,
    'contract.employer': contract.employer,
    'contract.location': contract.location,
    'contract.fte': contract.fte,
    'person.status': person.status,
  };
}

function templateContext(
  person: PersonFacts,
  contract: ContractFacts | null,
  baseDn: string,
): TemplateContext {
  return {
    person: {
      givenName: person.givenName,
      familyName: person.familyName,
      // The two address columns Person actually has. There is no `email`
      // column, so there is no `%person.email%` placeholder; a template naming
      // one is reported as unresolvable rather than rendered empty, which is
      // exactly what renderTemplate does with any unknown name.
      businessEmail: person.businessEmail,
      personalEmail: person.personalEmail,
      nameConvention: person.nameConvention,
      // Derived, not stored. Offered so an attributeTemplate can say
      // `%person.displayName%` without every profile restating the join.
      displayName: personDisplayName(person),
      status: person.status,
    },
    contract: {
      department: contract?.department ?? null,
      jobTitle: contract?.jobTitle ?? null,
      costCentre: contract?.costCentre ?? null,
      employer: contract?.employer ?? null,
      location: contract?.location ?? null,
    },
    baseDn,
  };
}

/**
 * The name to print for a person, derived because `Person` has no
 * `displayName` column and spec section 15 forbids adding one.
 *
 * `nameConvention` is deliberately not branched on: the only name parts the
 * record holds are `givenName` and `familyName`, so there is nothing for a
 * convention to select between until partner-name columns exist. It is passed
 * through to the template context as a fact instead, so a profile that wants
 * to act on it can, and this function does not invent data.
 */
export function personDisplayName(person: PersonFacts): string {
  return [person.givenName, person.familyName]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * The same name, with a last resort for the message paths.
 *
 * The explicit empty check is load-bearing: `Array.join` returns `''` and
 * never null or undefined, so a `?? person.id` written after it is dead code
 * and a person with both names blank produces an exception reading
 * " holds no contracts at all", with nothing in it anybody can look up.
 */
function fullName(person: PersonFacts): string {
  const name = personDisplayName(person);
  return name === '' ? person.id : name;
}

/**
 * A factory, not a shared constant.
 *
 * `{ ...EMPTY_ACCOUNT }` is a shallow copy: every caller would receive the
 * SAME `attributes` object, so one consumer mutating it corrupts every
 * subsequent call in the process.
 */
function emptyAccount(): DesiredAccount {
  return {
    required: false,
    attributes: {},
    container: '',
    enabledNow: false,
    correlationKey: null,
  };
}

/**
 * What a person should hold in one target, as a pure function of their record
 * as it stands.
 *
 * There are no joiner, mover and leaver *events* here. There is a desired
 * state computed from the record, an actual state read from the target, and a
 * diff. Joiner, mover and leaver are names for shapes that diff takes. That is
 * what makes a retroactive correction a non-event: whatever happened upstream,
 * the next run converges, because there is no memory to corrupt.
 *
 * Two dates, deliberately: `horizon` decides whether an account is required
 * and what its attributes are; `now` decides whether it is enabled and which
 * entitlements it holds. A pre-hire therefore gets their account created,
 * named, placed and password-set, and left disabled holding nothing.
 *
 * Pure: no clock of its own, no database, no I/O.
 */
export function desiredState(input: DesiredStateInput): DesiredState {
  const { person, contracts, rules, profile, now, horizon } = input;
  const empty: DesiredState = {
    personId: person.id,
    account: null,
    entitlements: new Set<string>(),
    attribution: new Map<string, Attribution[]>(),
    notYetStarted: false,
    unprocessable: null,
  };

  // No contracts at all is an incomplete record -- a person created by hand
  // and not finished, or an import that dropped the contract rows. It is not a
  // departure, and computing it as one revokes real access.
  if (contracts.length === 0) {
    return {
      ...empty,
      unprocessable: {
        kind: 'no_contracts',
        message: `${fullName(person)} holds no contracts at all, so their access cannot be computed; this is an incomplete record, not a departure`,
      },
    };
  }

  // A rule naming an entitlement that is missing or unreadable is unresolvable
  // AS A WHOLE, for every person it would have been evaluated against.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const entitlementId of rule.entitlementIds) {
      const status = input.entitlementStatus.get(entitlementId) ?? 'missing';
      if (status !== 'present') {
        return {
          ...empty,
          unprocessable: {
            kind: 'unresolvable_rule',
            message: `the rule "${rule.name}" names entitlement ${entitlementId}, which is ${status} in the target catalog; the rule cannot be resolved and produces no desired state`,
          },
        };
      }
    }
  }

  const activeNow = activeOn(contracts, now);
  // AMENDED (correction 1 at the head of this task): the WINDOW [now, horizon],
  // not the horizon alone. `activeOn(contracts, horizon)` asks whether the
  // person will still be employed in `preHireDays` time, and answers "no" for
  // somebody whose contract ends next Tuesday -- who then gets an immediate
  // disable and revoke as a mover. Read `activeAtHorizon` below as this window.
  const activeAtHorizon = activeBetween(contracts, now, horizon);

  /**
   * Contracts exist and every one of them starts after the horizon.
   *
   * A third state beside "should have something" and "should have nothing",
   * and it has to be carried out of here because it is not recoverable
   * downstream: their contracts are open-ended, so `latestContractEnd` is
   * null, so the planner sees no departure date and treats them as a mover --
   * which means an immediate revoke of everything they hold and an immediate
   * disable, for somebody who has not started (Ruling P10).
   */
  const notYetStarted =
    activeAtHorizon.length === 0 &&
    contracts.every((c) => c.startDate.getTime() > horizon.getTime());

  const entitlements = new Set<string>();
  const attribution = new Map<string, Attribution[]>();
  let accountRequired = false;

  // Whether an account is required is decided at the horizon, so a pre-hire's
  // account exists before their start date.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const contract of activeAtHorizon) {
      if (!evaluateCondition(rule.condition, conditionFacts(person, contract))) continue;
      if (rule.grantsAccount) accountRequired = true;
    }
  }

  // Which entitlements are held is decided at `now`, so a pre-hire holds
  // nothing until the day they start. This is the security property the two
  // dates exist for.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const contract of activeNow) {
      if (!evaluateCondition(rule.condition, conditionFacts(person, contract))) continue;
      for (const entitlementId of rule.entitlementIds) {
        entitlements.add(entitlementId);
        const list = attribution.get(entitlementId) ?? [];
        list.push({ ruleId: rule.id, ruleName: rule.name, contractId: contract.id });
        attribution.set(entitlementId, list);
      }
    }
  }

  if (!accountRequired) {
    // No account is required. This covers a leaver (every contract ended), a
    // mover whose target is no longer theirs, and a future joiner. The first
    // two differ by a contract end date and telling them apart is plan.ts's
    // job; the third cannot be recovered downstream at all, which is why
    // `notYetStarted` travels with the state rather than being re-derived.
    return {
      ...empty,
      account: emptyAccount(),
      entitlements,
      attribution,
      notYetStarted,
    };
  }

  const mappingContract =
    resolveMappingContract(contracts, now) ?? resolveMappingContract(contracts, horizon);
  const context = templateContext(person, mappingContract, profile.baseDn);

  const attributes: Record<string, string[]> = {};
  for (const [name, template] of Object.entries(profile.attributeTemplates)) {
    const rendered = renderTemplate(template, context);
    if (!rendered.ok) {
      return {
        ...empty,
        unprocessable: {
          kind: 'template_unresolvable',
          message: `the account profile template for "${name}" references ${rendered.missing.join(', ')}, which resolves to nothing for this person`,
        },
      };
    }
    attributes[name] = [rendered.value];
  }

  // A container template that resolves to nothing falls back, which is what
  // the required fallbackContainer is for. A container that does not EXIST in
  // the target is a different failure and is detected in reconcile, against
  // the target's own inventory.
  //
  // AMENDED (correction 2): `renderContainer`, never `renderTemplate`. This is
  // a DN, and Ruling P22 is closed structurally or not at all.
  const containerRendered = renderContainer(profile.containerTemplate, context);
  const container = containerRendered.ok
    ? containerRendered.value
    : profile.fallbackContainer;

  // A correlation key, once assigned, is not regenerated -- unless the target
  // says renaming is on. Somebody marrying does not get a new login by
  // default, because renaming breaks certificate subjects, profile paths, file
  // ownership and mailbox aliases.
  let correlationKey = input.existingCorrelationKey;
  if (correlationKey === null || input.renameEnabled) {
    // When a key already exists, it is not "taken" as far as its own owner is
    // concerned: leaving it in the set would make generation invent a
    // suffixed variant of the name this person already holds.
    const taken =
      input.existingCorrelationKey === null
        ? input.takenCorrelationKeys
        : new Set(
            [...input.takenCorrelationKeys].filter(
              (key) => key !== input.existingCorrelationKey,
            ),
          );

    const generated = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken,
      maxLength: 20,
      maxAttempts: profile.maxUniquenessAttempts,
    });

    if (!generated.ok) {
      // A person who already has a working login keeps it. A rename is never
      // worth making somebody unprocessable for: their login is not the thing
      // that needs fixing, and freezing them would stop every other action
      // this target would take for them.
      if (input.existingCorrelationKey !== null) {
        correlationKey = input.existingCorrelationKey;
      } else {
        return {
          ...empty,
          unprocessable:
            generated.reason === 'exhausted'
              ? {
                  kind: 'name_generation_exhausted',
                  message: `no unique account name could be generated for ${fullName(person)} within ${generated.attempts} attempts`,
                }
              : {
                  kind: 'template_unresolvable',
                  message: `the account name template references ${generated.missing.join(', ')}, which resolves to nothing for this person`,
                },
        };
      }
    } else {
      correlationKey = generated.correlationKey;
    }
  }

  return {
    personId: person.id,
    account: {
      required: true,
      attributes,
      container,
      // Enabled only if a rule matches a contract that is active NOW.
      enabledNow: activeNow.length > 0 && entitlementsOrAccountActiveNow(rules, person, activeNow),
      correlationKey,
    },
    entitlements,
    attribution,
    // An account is required, so by construction a contract is active at the
    // horizon and this person has started.
    notYetStarted: false,
    unprocessable: null,
  };
}

/**
 * Whether any account-granting rule matches a contract that is active *now*,
 * as opposed to merely at the horizon. This is what separates a pre-hire's
 * disabled account from a joiner's enabled one.
 */
function entitlementsOrAccountActiveNow(
  rules: RuleFacts[],
  person: PersonFacts,
  activeNow: ContractFacts[],
): boolean {
  for (const rule of rules) {
    if (!rule.enabled || !rule.grantsAccount) continue;
    for (const contract of activeNow) {
      if (evaluateCondition(rule.condition, conditionFacts(person, contract))) return true;
    }
  }
  return false;
}
```

- [ ] **Step 5: Add the agreement test against `resolveContractForMapping`**

Spec §20 requires attribute resolution to *assert it agrees with* `resolveContractForMapping` rather than reimplementing the precedence. Append to `packages/core/src/provision/desired.test.ts`:

```ts
import { resolveContractForMapping } from '../identity/contract-service.js';
import type { TenantClient } from '@syntra/db';

describe('resolveMappingContract agrees with resolveContractForMapping', () => {
  /**
   * A stub transaction returning the same contract rows, so the two
   * implementations are compared on identical input. Not a mock of the answer
   * -- the real function runs, over a fake `findMany`.
   */
  const txOver = (rows: ContractFacts[]) =>
    ({
      contract: {
        findMany: async ({ where }: { where: { startDate: { lte: Date }; OR: unknown } }) =>
          rows
            .filter(
              (c) =>
                c.startDate.getTime() <= where.startDate.lte.getTime() &&
                (c.endDate === null || c.endDate.getTime() >= where.startDate.lte.getTime()),
            )
            .sort((a, b) => a.sequence - b.sequence),
      },
    }) as unknown as TenantClient;

  const cases: { name: string; rows: ContractFacts[] }[] = [
    {
      name: 'an active primary beside a lower-sequence non-primary',
      rows: [
        contract({ id: 'p', sequence: 5, isPrimary: true }),
        contract({ id: 'o', sequence: 1, isPrimary: false }),
      ],
    },
    {
      name: 'an ended primary and two active non-primaries',
      rows: [
        contract({ id: 'p', sequence: 5, isPrimary: true, endDate: day('2026-01-01') }),
        contract({ id: 'low', sequence: 2, isPrimary: false }),
        contract({ id: 'high', sequence: 9, isPrimary: false }),
      ],
    },
    { name: 'a single active contract', rows: [contract({ id: 'only' })] },
  ];

  for (const { name, rows } of cases) {
    it(`agrees on ${name}`, async () => {
      const viaCore = await resolveContractForMapping(
        txOver(rows),
        'person-1',
        'primary',
        NOW,
      );
      const fallback =
        viaCore ??
        (await resolveContractForMapping(txOver(rows), 'person-1', 'lowestSequence', NOW));
      expect(resolveMappingContract(rows, NOW)?.id).toBe(fallback?.id ?? null);
    });
  }
});
```

- [ ] **Step 6: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/types.js';
export * from './provision/desired.js';
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/desired.test.ts`
Expected: PASS, 36 tests (33 in this file plus the 3 agreement cases step 5 adds).

The one that matters most is "makes a person with no contracts at all unprocessable, not a leaver". If it fails by returning `account.required: false`, somebody has collapsed *this person should have nothing* into *we could not work out what this person should have*, and the run will propose disabling and stripping exactly the people whose records are incomplete.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: compute desired provisioning state from contracts and rules"
```

---

## Task 8: Reconciliation with reality

**Files:**
- Create: `packages/core/src/provision/reconcile.ts`
- Modify: `packages/core/src/provision/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/reconcile.test.ts`

**Interfaces:**
- Consumes: `type DesiredState`, `type UnprocessableKind` from `./types.js`.
- Produces:
  - `type EnforcementMode = 'additive' | 'authoritative'` (in `./types.js`)
  - `type DriftKind = 'unmanaged_entitlement' | 'missing_grant' | 'orphan_account' | 'account_missing_at_target' | 'unexpected_status'` (in `./types.js`)
  - `interface TargetObject { anchor: string; correlationKey: string; dn: string; enabled: boolean; provenance: string | null; entitlementIds: string[]; readComplete: boolean }` (in `./types.js`)
  - `interface KnownHolding { entitlementId: string; origin: 'rule' | 'manual' | 'discovered'; grantedByRuleId: string | null }` (in `./types.js`)
  - `interface KnownAccount { id: string; personId: string; anchor: string | null; correlationKey: string; status: 'pending' | 'active' | 'disabled' | 'archived' | 'missing_at_target' | 'conflict'; disabledAt: Date | null; lastAppliedAttributes: Record<string, string[]>; holdings: KnownHolding[] }` (in `./types.js`)
  - `interface ActualState { personId: string; accountId: string | null; anchor: string | null; correlationKey: string | null; status: KnownAccount['status'] | 'absent'; existsAtTarget: boolean; enabledAtTarget: boolean; disabledAt: Date | null; dn: string | null; attributes: Record<string, string[]>; heldEntitlements: Set<string>; heldWithinRemit: Set<string> }` (in `./types.js`)
  - `interface DraftDriftFinding { kind: DriftKind; accountId: string | null; entitlementId: string | null; subjectAnchor: string | null; detail: Record<string, unknown>; fingerprint: string }` (in `./types.js`)
  - `function driftFingerprint(kind: DriftKind, accountId: string | null, entitlementId: string | null, subject?: string | null): string`

`subjectAnchor` and the fourth `subject` parameter both exist because an orphan account has no `accountId` and no entitlement, and the thing that makes one orphan distinct from another is the target's own anchor. An earlier draft put that anchor in the `entitlementId` slot — which Task 13 then writes into a `@db.Uuid` column, so `fake-anchor-0001` is rejected by PostgreSQL outright and a real `objectGUID` is accepted as a foreign key pointing at no `Entitlement`, which the drift API and the drift tab then render. The identity of a finding and the columns it fills are two different things, and overloading one slot to serve both breaks each of them differently.
  - `function reconcile(input: ReconcileInput): ReconcileOutput`
  - `interface ReconcileInput { desired: DesiredState[]; known: KnownAccount[]; objects: TargetObject[]; remit: ReadonlySet<string>; existingContainers: ReadonlySet<string>; desiredContainers: ReadonlyMap<string, string>; enforcementMode: EnforcementMode }`
  - `interface ReconcileOutput { actual: Map<string, ActualState>; findings: DraftDriftFinding[]; extraUnprocessable: Map<string, { kind: UnprocessableKind; message: string }> }`

- [ ] **Step 1: Add the reconciliation types**

Append to `packages/core/src/provision/types.ts`:

```ts
export type EnforcementMode = 'additive' | 'authoritative';

export type DriftKind =
  | 'unmanaged_entitlement'
  | 'missing_grant'
  | 'orphan_account'
  | 'account_missing_at_target'
  | 'unexpected_status';

export type AccountStatus =
  | 'pending'
  | 'active'
  | 'disabled'
  | 'archived'
  | 'missing_at_target'
  | 'conflict';

/** One account as the target returned it. */
export interface TargetObject {
  anchor: string;
  correlationKey: string;
  dn: string;
  enabled: boolean;
  /** The tenant id and originating actionId Provision wrote when it created this. */
  provenance: string | null;
  /** Entitlement ids (Syntra's, resolved from externalIds), not externalIds. */
  entitlementIds: string[];
  /**
   * False when the connector saw the object but could not read it in full — a
   * range walk that could not finish. Every person whose account this is
   * becomes unprocessable rather than being diffed against half a truth.
   */
  readComplete: boolean;
}

export interface KnownHolding {
  entitlementId: string;
  origin: 'rule' | 'manual' | 'discovered';
  grantedByRuleId: string | null;
}

/** One account as Syntra believes it to be. */
export interface KnownAccount {
  id: string;
  personId: string;
  anchor: string | null;
  correlationKey: string;
  status: AccountStatus;
  disabledAt: Date | null;
  lastAppliedAttributes: Record<string, string[]>;
  holdings: KnownHolding[];
}

export interface ActualState {
  personId: string;
  accountId: string | null;
  anchor: string | null;
  correlationKey: string | null;
  status: AccountStatus | 'absent';
  existsAtTarget: boolean;
  enabledAtTarget: boolean;
  disabledAt: Date | null;
  dn: string | null;
  attributes: Record<string, string[]>;
  /** Everything the target holds for this account. */
  heldEntitlements: Set<string>;
  /**
   * The subset inside Provision's remit — entitlements named by at least one
   * business rule for this target. "Provision manages this target" and
   * "Provision manages every group in this target" are different claims, and
   * only the first is ever true.
   */
  heldWithinRemit: Set<string>;
}

export interface DraftDriftFinding {
  kind: DriftKind;
  accountId: string | null;
  /** A Syntra Entitlement id, or null. Never a target anchor: the column is @db.Uuid. */
  entitlementId: string | null;
  /**
   * The target's own identifier for the object a finding is about, when
   * Syntra holds no row for it -- an orphan account.
   */
  subjectAnchor: string | null;
  detail: Record<string, unknown>;
  fingerprint: string;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/provision/reconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { driftFingerprint, reconcile } from './reconcile.js';
import type {
  DesiredState,
  KnownAccount,
  TargetObject,
} from './types.js';

const desired = (over: Partial<DesiredState> = {}): DesiredState => ({
  personId: 'person-1',
  account: {
    required: true,
    attributes: { displayName: ['Anna Novak'] },
    container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    enabledNow: true,
    correlationKey: 'anna.novak',
  },
  entitlements: new Set(['ent-finance']),
  attribution: new Map(),
  notYetStarted: false,
  unprocessable: null,
  ...over,
});

const known = (over: Partial<KnownAccount> = {}): KnownAccount => ({
  id: 'account-1',
  personId: 'person-1',
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  status: 'active',
  disabledAt: null,
  lastAppliedAttributes: { displayName: ['Anna Novak'] },
  holdings: [
    { entitlementId: 'ent-finance', origin: 'rule', grantedByRuleId: 'rule-finance' },
  ],
  ...over,
});

const object = (over: Partial<TargetObject> = {}): TargetObject => ({
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
  enabled: true,
  provenance: 'tenant-1/action-1',
  entitlementIds: ['ent-finance'],
  readComplete: true,
  ...over,
});

const run = (over: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({
    desired: [desired()],
    known: [known()],
    objects: [object()],
    remit: new Set(['ent-finance', 'ent-teaching']),
    // Lowercased, as the run supplies them.
    existingContainers: new Set([
      'ou=finance,ou=users,dc=acme,dc=test',
      'ou=users,dc=acme,dc=test',
    ]),
    desiredContainers: new Map([['person-1', 'OU=Finance,OU=Users,DC=acme,DC=test']]),
    enforcementMode: 'additive',
    ...over,
  });

describe('driftFingerprint', () => {
  it('is stable for the same problem and distinct for different ones', () => {
    // A finding that persists across runs is updated rather than duplicated,
    // so the count on the dashboard is a count of problems, not of runs.
    expect(driftFingerprint('unmanaged_entitlement', 'a', 'e')).toBe(
      driftFingerprint('unmanaged_entitlement', 'a', 'e'),
    );
    expect(driftFingerprint('unmanaged_entitlement', 'a', 'e')).not.toBe(
      driftFingerprint('missing_grant', 'a', 'e'),
    );
    expect(driftFingerprint('orphan_account', null, null)).toBe(
      'orphan_account:-:-:-',
    );
  });

  it('distinguishes two findings of the same kind on the same account by subject', () => {
    // Two different problems can be `unexpected_status` about one account: the
    // target reports a status Syntra did not expect, and the account belongs
    // to somebody who has not started. Sharing a fingerprint would make each
    // overwrite the other on every run, so the dashboard would show one and
    // never both, alternating.
    expect(driftFingerprint('unexpected_status', 'a', null)).not.toBe(
      driftFingerprint('unexpected_status', 'a', null, 'not_yet_started'),
    );
  });

  it('keeps an orphan out of the entitlement slot', () => {
    // The anchor identifies the orphan and belongs in `subject`.
    // `entitlementId` is a @db.Uuid column and a target anchor is not one.
    expect(driftFingerprint('orphan_account', null, null, 'anchor-9')).toBe(
      'orphan_account:-:-:anchor-9',
    );
  });
});

describe('reconcile — the four outcomes', () => {
  it('agrees, and records nothing, when Syntra granted it and the target has it', () => {
    const result = run();
    expect(result.findings).toEqual([]);
    const actual = result.actual.get('person-1')!;
    expect(actual.existsAtTarget).toBe(true);
    expect([...actual.heldEntitlements]).toEqual(['ent-finance']);
  });

  it('records a missing grant when Syntra granted it and the target does not have it', () => {
    // Convergence, not drift policing. Provision is authoritative for what
    // Provision granted, and a grant that silently disappeared is the
    // subsystem's own state having come apart.
    const result = run({ objects: [object({ entitlementIds: [] })] });
    expect(result.findings).toEqual([
      {
        kind: 'missing_grant',
        accountId: 'account-1',
        entitlementId: 'ent-finance',
        subjectAnchor: null,
        detail: {
          reason: 'Provision granted this entitlement and the target no longer holds it',
          origin: 'rule',
        },
        fingerprint: 'missing_grant:account-1:ent-finance:-',
      },
    ]);
    // And the actual state says it is not held, so the plan proposes the grant.
    expect([...result.actual.get('person-1')!.heldEntitlements]).toEqual([]);
  });

  it('records drift and leaves it alone under additive when the target has what Provision never granted', () => {
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-teaching'] })],
      enforcementMode: 'additive',
    });
    expect(result.findings).toEqual([
      {
        kind: 'unmanaged_entitlement',
        accountId: 'account-1',
        entitlementId: 'ent-teaching',
        subjectAnchor: null,
        detail: {
          reason: 'the target holds this entitlement and Provision did not grant it',
          enforcementMode: 'additive',
          proposedForRevocation: false,
        },
        fingerprint: 'unmanaged_entitlement:account-1:ent-teaching:-',
      },
    ]);
    // Left alone: reported as held, so nothing proposes revoking it.
    expect([...result.actual.get('person-1')!.heldWithinRemit].sort()).toEqual([
      'ent-finance',
      'ent-teaching',
    ]);
  });

  it('records the SAME drift under authoritative and marks it for revocation', () => {
    // Ruling P2: drift is reported under BOTH modes. Additive must mean "I saw
    // this and left it", never "I did not look".
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-teaching'] })],
      enforcementMode: 'authoritative',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('unmanaged_entitlement');
    expect(result.findings[0]!.detail.proposedForRevocation).toBe(true);
  });

  it('never revokes an entitlement no rule mentions, even under authoritative', () => {
    // "Provision manages this target" and "Provision manages every group in
    // this target" are different claims, and only the first is ever true.
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-outside'] })],
      remit: new Set(['ent-finance']),
      enforcementMode: 'authoritative',
    });
    const finding = result.findings.find((f) => f.entitlementId === 'ent-outside');
    expect(finding?.detail.proposedForRevocation).toBe(false);
    expect(finding?.detail.reason).toContain('outside');
    // And it is absent from the set the plan differences against, so nothing
    // downstream can propose revoking it either.
    expect(result.actual.get('person-1')!.heldWithinRemit.has('ent-outside')).toBe(false);
  });

  it('records an orphan for an account belonging to no person Syntra knows', () => {
    // Provision records it and does nothing else. Deciding whether an orphan
    // should exist is Govern's.
    const result = run({
      objects: [object(), object({ anchor: 'anchor-9', correlationKey: 'someone.else' })],
    });
    expect(result.findings).toEqual([
      {
        kind: 'orphan_account',
        accountId: null,
        entitlementId: null,
        subjectAnchor: 'anchor-9',
        detail: {
          anchor: 'anchor-9',
          correlationKey: 'someone.else',
          dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
          reason: 'the target holds this account and it belongs to no person Syntra knows',
        },
        fingerprint: 'orphan_account:-:-:anchor-9',
      },
    ]);
  });
});

describe('reconcile — an account that vanished', () => {
  it('marks it missing_at_target and records a finding', () => {
    const result = run({ objects: [] });
    const actual = result.actual.get('person-1')!;
    expect(actual.status).toBe('missing_at_target');
    expect(actual.existsAtTarget).toBe(false);
    expect(result.findings).toEqual([
      {
        kind: 'account_missing_at_target',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          anchor: 'anchor-1',
          correlationKey: 'anna.novak',
          reason:
            'Syntra holds this account and the target no longer returns its anchor',
        },
        fingerprint: 'account_missing_at_target:account-1:-:-',
      },
    ]);
  });

  it('does not mark a pending account missing, because it never existed', () => {
    // A `pending` row is a reserved correlation key, not a vanished account.
    const result = run({
      known: [known({ anchor: null, status: 'pending', holdings: [] })],
      objects: [],
    });
    expect(result.actual.get('person-1')!.status).toBe('pending');
    expect(result.findings).toEqual([]);
  });
});

describe('reconcile — unexpected status', () => {
  it('records drift when Syntra believes an account is active and the target has it disabled', () => {
    // The residual gap named in spec section 4: an account disabled by an
    // administrator outside Provision. Recorded, not silently reversed.
    const result = run({ objects: [object({ enabled: false })] });
    expect(result.findings).toEqual([
      {
        kind: 'unexpected_status',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          syntraBelieves: 'active',
          targetReports: 'disabled',
          reason: 'the account status at the target does not match what Syntra recorded',
        },
        fingerprint: 'unexpected_status:account-1:-:-',
      },
    ]);
    expect(result.actual.get('person-1')!.enabledAtTarget).toBe(false);
  });

  it('records no status drift when Syntra believes it is disabled and it is', () => {
    const result = run({
      known: [known({ status: 'disabled', disabledAt: new Date('2026-06-01') })],
      objects: [object({ enabled: false })],
    });
    expect(result.findings).toEqual([]);
  });
});

describe('reconcile — persons it makes unprocessable', () => {
  it('excludes a person whose account could not be read in full', () => {
    const result = run({ objects: [object({ readComplete: false })] });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'target_read_incomplete',
      message:
        'the target returned this person account at anchor-1 but it could not be read in full, so it cannot be diffed against safely',
    });
  });

  it('excludes a person whose account is in conflict', () => {
    // A conflict is an account somebody else may own. Adopting it hands them
    // this person's entitlements, so the person is excluded from the plan
    // entirely until a human resolves it -- which makes this a security
    // control and not a tidiness rule (spec section 13).
    const result = run({ known: [known({ status: 'conflict' })] });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'account_conflict',
      message:
        'this person account is in conflict: the correlation key anna.novak already exists in the target on an account Provision did not create',
    });
  });

  it('excludes a person whose desired container does not exist in the target', () => {
    // Provision does not create organizational units in somebody else's
    // domain, and the run says which container was missing.
    const result = run({
      desiredContainers: new Map([['person-1', 'OU=Nowhere,OU=Users,DC=acme,DC=test']]),
    });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'container_missing',
      message:
        'the container OU=Nowhere,OU=Users,DC=acme,DC=test does not exist in the target; Provision does not create it',
    });
  });

  it('does not check the container for somebody who needs no account', () => {
    const result = run({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
        }),
      ],
      desiredContainers: new Map(),
    });
    expect(result.extraUnprocessable.size).toBe(0);
  });

  it('reports an account belonging to somebody who has not started, and leaves it alone', () => {
    // Spec section 8: an account belonging to somebody whose contract has not
    // started is a question, not an instruction. It is reported and untouched
    // -- the planner returns nothing for them (Task 9) and this is where the
    // report is written. Its fingerprint carries a subject so it cannot
    // collide with, and silently overwrite, the account-status finding above.
    const result = run({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          notYetStarted: true,
        }),
      ],
    });
    const finding = result.findings.find(
      (f) => f.detail.reason === 'this account belongs to somebody whose contract has not started',
    );
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe('unexpected_status');
    expect(finding!.fingerprint).toBe('unexpected_status:account-1:-:not_yet_started');
    // Still reconciled, so the run's inventory and the guard's denominators
    // count this account. Not touching it is the planner's job, not a reason
    // to pretend it is not there.
    expect(result.actual.get('person-1')!.existsAtTarget).toBe(true);
  });

  it('leaves an already-unprocessable person entirely alone', () => {
    const result = run({
      desired: [
        desired({
          account: null,
          entitlements: new Set(),
          unprocessable: { kind: 'no_contracts', message: 'no contracts' },
        }),
      ],
    });
    // Their existing accounts and entitlements are not touched: not granted,
    // not revoked, not disabled. No findings, no actual state to diff.
    expect(result.actual.has('person-1')).toBe(false);
    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/reconcile.test.ts`
Expected: FAIL — cannot find module `./reconcile.js`.

- [ ] **Step 4: Write the reconciler**

`packages/core/src/provision/reconcile.ts`:

```ts
import type {
  ActualState,
  DesiredState,
  DraftDriftFinding,
  DriftKind,
  EnforcementMode,
  KnownAccount,
  TargetObject,
  UnprocessableKind,
} from './types.js';

export interface ReconcileInput {
  desired: DesiredState[];
  known: KnownAccount[];
  objects: TargetObject[];
  /** Entitlements named by at least one business rule for this target. */
  remit: ReadonlySet<string>;
  /**
   * Containers the target actually holds, **lowercased**, read from the target
   * by `listContainers` rather than inferred from the DNs of the accounts it
   * returned. Lowercased because DN comparison is case-insensitive and a
   * profile written in one case against an OU created in another is an
   * ordinary configuration, not a missing container.
   */
  existingContainers: ReadonlySet<string>;
  /** personId to the container the profile computed for them, in its own case. */
  desiredContainers: ReadonlyMap<string, string>;
  enforcementMode: EnforcementMode;
}

export interface ReconcileOutput {
  actual: Map<string, ActualState>;
  findings: DraftDriftFinding[];
  extraUnprocessable: Map<string, { kind: UnprocessableKind; message: string }>;
}

/**
 * A stable identity for "the same problem", so a finding that persists across
 * runs is updated rather than duplicated. `-` stands in for a null part
 * because the column is NOT NULL: a unique index over nullable columns
 * constrains nothing, which is why this exists rather than a partial index.
 *
 * `subject` is an explicit fourth part rather than something smuggled into the
 * entitlement slot. Two things need it. An orphan account has no accountId and
 * no entitlement, and what distinguishes one orphan from another is the
 * target's anchor -- which is not a UUID and must never reach the
 * `entitlementId` column. And two genuinely different problems can be
 * `unexpected_status` about one account, so they need different identities or
 * each overwrites the other on every run.
 */
export function driftFingerprint(
  kind: DriftKind,
  accountId: string | null,
  entitlementId: string | null,
  subject: string | null = null,
): string {
  return `${kind}:${accountId ?? '-'}:${entitlementId ?? '-'}:${subject ?? '-'}`;
}

/**
 * Compares three things — what Syntra believes it granted, what the target
 * actually holds, and what the rules say should be held — and sorts the
 * differences into four kinds.
 *
 * Provision converges what it manages and inventories what it does not. It
 * does not judge: deciding whether an orphan should exist, attributing it to
 * an owner and chasing it to closure is Govern's.
 *
 * Ruling P2: drift is recorded under BOTH enforcement modes. The mode decides
 * only whether an unmanaged entitlement is *proposed for revocation*, never
 * whether it is looked at. Additive must mean "I saw this and left it".
 *
 * Pure: no clock, no database, no I/O.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const actual = new Map<string, ActualState>();
  const findings: DraftDriftFinding[] = [];
  const extraUnprocessable = new Map<
    string,
    { kind: UnprocessableKind; message: string }
  >();

  const knownByPerson = new Map(input.known.map((a) => [a.personId, a]));
  const objectByAnchor = new Map(input.objects.map((o) => [o.anchor, o]));
  const claimedAnchors = new Set<string>();

  const record = (
    kind: DriftKind,
    accountId: string | null,
    entitlementId: string | null,
    detail: Record<string, unknown>,
    subject: string | null = null,
  ) => {
    findings.push({
      kind,
      accountId,
      entitlementId,
      // An anchor when the subject is one, and never in the entitlement slot.
      subjectAnchor: kind === 'orphan_account' ? subject : null,
      detail,
      fingerprint: driftFingerprint(kind, accountId, entitlementId, subject),
    });
  };

  for (const state of input.desired) {
    const account = knownByPerson.get(state.personId) ?? null;
    const object = account?.anchor ? objectByAnchor.get(account.anchor) : undefined;

    // Claimed BEFORE the unprocessable check, deliberately.
    //
    // The account of a person Provision cannot evaluate is still that
    // person's account. Skipping the claim first means the trailing orphan
    // loop finds it unclaimed and reports `orphan_account` for it -- so every
    // person with an incomplete HR record generates a false orphan, in the
    // inventory Provision owes Govern (spec section 12). Claiming is a
    // statement about who the object belongs to; it is not a decision to act
    // on it, and the two are separate.
    if (object) claimedAnchors.add(object.anchor);

    // An unprocessable person is excluded from this target's plan ENTIRELY.
    // Their existing accounts and entitlements are not touched -- not granted,
    // not revoked, not disabled -- so they get no actual state to diff and
    // produce no findings of their own.
    if (state.unprocessable) continue;

    if (account?.status === 'conflict') {
      extraUnprocessable.set(state.personId, {
        kind: 'account_conflict',
        message: `this person account is in conflict: the correlation key ${account.correlationKey} already exists in the target on an account Provision did not create`,
      });
      continue;
    }

    if (object && !object.readComplete) {
      // The connector saw it but could not read it in full. Diffing against
      // half a truth is how a partial membership read turns into a mass
      // revoke, which is the whole reason Ruling P1 exists.
      extraUnprocessable.set(state.personId, {
        kind: 'target_read_incomplete',
        message: `the target returned this person account at ${object.anchor} but it could not be read in full, so it cannot be diffed against safely`,
      });
      continue;
    }

    if (state.account?.required) {
      const container = input.desiredContainers.get(state.personId);
      // Compared lowercased, reported in the case the profile produced, so the
      // message names the container the administrator wrote.
      if (
        container !== undefined &&
        !input.existingContainers.has(container.toLowerCase())
      ) {
        // Silently creating organizational units in somebody else's domain is
        // not a thing this product does.
        extraUnprocessable.set(state.personId, {
          kind: 'container_missing',
          message: `the container ${container} does not exist in the target; Provision does not create it`,
        });
        continue;
      }
    }

    // An account Syntra holds whose anchor the target no longer returns. A
    // `pending` row is a reserved correlation key that never existed at the
    // target, so it is not a vanished account.
    if (account && account.anchor !== null && !object && account.status !== 'archived') {
      record('account_missing_at_target', account.id, null, {
        anchor: account.anchor,
        correlationKey: account.correlationKey,
        reason: 'Syntra holds this account and the target no longer returns its anchor',
      });
      actual.set(state.personId, {
        personId: state.personId,
        accountId: account.id,
        anchor: account.anchor,
        correlationKey: account.correlationKey,
        status: 'missing_at_target',
        existsAtTarget: false,
        enabledAtTarget: false,
        disabledAt: account.disabledAt,
        dn: null,
        attributes: account.lastAppliedAttributes,
        heldEntitlements: new Set(),
        heldWithinRemit: new Set(),
      });
      continue;
    }

    const heldAtTarget = new Set(object?.entitlementIds ?? []);
    const heldWithinRemit = new Set<string>();

    for (const entitlementId of heldAtTarget) {
      const inRemit = input.remit.has(entitlementId);
      const granted = account?.holdings.some(
        (h) => h.entitlementId === entitlementId,
      );

      if (granted) {
        // Agreement. Nothing to do.
        heldWithinRemit.add(entitlementId);
        continue;
      }

      // The target has it and Provision never granted it. Recorded in both
      // modes; the mode decides only what happens next.
      const proposedForRevocation =
        input.enforcementMode === 'authoritative' && inRemit;
      record('unmanaged_entitlement', account?.id ?? null, entitlementId, {
        reason: inRemit
          ? 'the target holds this entitlement and Provision did not grant it'
          : 'the target holds this entitlement and it is outside Provision remit: no business rule for this target names it',
        enforcementMode: input.enforcementMode,
        proposedForRevocation,
      });

      // Under additive it stays in the set, so nothing downstream proposes
      // revoking it. Outside the remit it is excluded in both modes, so
      // nothing can propose revoking it there either.
      if (inRemit && input.enforcementMode === 'additive') {
        heldWithinRemit.add(entitlementId);
      }
    }

    // Syntra granted it and the target does not have it. Convergence: putting
    // it back is the whole job.
    for (const holding of account?.holdings ?? []) {
      if (heldAtTarget.has(holding.entitlementId)) continue;
      if (!object) continue;
      record('missing_grant', account!.id, holding.entitlementId, {
        reason: 'Provision granted this entitlement and the target no longer holds it',
        origin: holding.origin,
      });
    }

    if (object && state.notYetStarted) {
      // Reported, and nothing else. The planner returns no actions for this
      // person at all, so the account keeps whatever it has: an account
      // belonging to somebody whose contract has not started is a question,
      // not an instruction (spec section 8, Ruling P10). Its own subject, so
      // it cannot collide with the status finding below on the same account.
      record(
        'unexpected_status',
        account?.id ?? null,
        null,
        {
          anchor: object.anchor,
          correlationKey: object.correlationKey,
          reason: 'this account belongs to somebody whose contract has not started',
        },
        'not_yet_started',
      );
    }

    if (object && account) {
      const syntraBelieves = account.status;
      // `account.status === 'active' ? 'active' : account.status` was a no-op
      // ternary; it is just the status.
      const targetReports = object.enabled ? 'active' : 'disabled';
      if (
        (syntraBelieves === 'active' && targetReports === 'disabled') ||
        (syntraBelieves === 'disabled' && targetReports === 'active')
      ) {
        record('unexpected_status', account.id, null, {
          syntraBelieves,
          targetReports,
          reason: 'the account status at the target does not match what Syntra recorded',
        });
      }
    }

    actual.set(state.personId, {
      personId: state.personId,
      accountId: account?.id ?? null,
      anchor: account?.anchor ?? null,
      correlationKey: account?.correlationKey ?? null,
      status: account?.status ?? 'absent',
      existsAtTarget: object !== undefined,
      enabledAtTarget: object?.enabled ?? false,
      disabledAt: account?.disabledAt ?? null,
      dn: object?.dn ?? null,
      attributes: account?.lastAppliedAttributes ?? {},
      heldEntitlements: heldAtTarget,
      heldWithinRemit,
    });
  }

  // Anything left at the target that no person claimed.
  for (const object of input.objects) {
    if (claimedAnchors.has(object.anchor)) continue;
    // The anchor goes in `subject`, never in `entitlementId`: that column is
    // @db.Uuid, and a target anchor is either not a UUID at all (PostgreSQL
    // rejects the insert) or a valid one pointing at no Entitlement (a
    // dangling reference the drift API and drift tab then render).
    record(
      'orphan_account',
      null,
      null,
      {
        anchor: object.anchor,
        correlationKey: object.correlationKey,
        dn: object.dn,
        reason: 'the target holds this account and it belongs to no person Syntra knows',
      },
      object.anchor,
    );
  }

  return { actual, findings, extraUnprocessable };
}
```

The orphan's anchor goes in the fingerprint's fourth `subject` part and in `subjectAnchor`, never in `entitlementId`. The test above pins `orphan_account:-:-:anchor-9`, and Task 1 gives `DriftFinding` a `subjectAnchor` column for it — an orphan has no `accountId` and no entitlement, the anchor is what makes one orphan distinct from another, and `entitlementId` is `@db.Uuid` and cannot hold one.

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/reconcile.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/reconcile.test.ts`
Expected: PASS, 19 tests.

Two of them exist because the versions they replace could not fail. `excludes a person whose account is in conflict` previously asserted `?.kind` was `undefined`, which is true whether or not conflicted accounts are excluded — and that exclusion is a security control. `leaves an already-unprocessable person entirely alone` fails outright unless the anchor claim is hoisted above the `unprocessable` check.

If "records the SAME drift under authoritative" passes but "records drift and leaves it alone under additive" produces no finding, additive has been implemented as "do not look" rather than "look and leave it", which Ruling P2 explicitly refuses.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: reconcile desired state against what the target actually holds"
```

---

## Task 9: The planner — the diff, the grace ladder, and the ordering

**Files:**
- Create: `packages/core/src/provision/plan.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/plan.test.ts`

**Interfaces:**
- Consumes: `type DesiredState`, `type ActualState`, `type Attribution`, `type ContractFacts` from `./types.js`; `latestContractEnd` from `./desired.js`; `type ProvisionActionType` from `@syntra/connectors`.
- Produces:
  - `interface LadderSettings { entitlementRevocationDelayDays: number; disableGraceDays: number; archiveAfterDays: number | null; reenableWithoutConfirmationDays: number; renameEnabled: boolean }`
  - `interface PlannedAction { actionType: ProvisionActionType; personId: string | null; accountId: string | null; entitlementId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; attributedRuleIds: string[]; requiresConfirmation: boolean; message: string | null }`
  - `const ACTION_ORDER: readonly ProvisionActionType[]`
  - `function addDays(from: Date, days: number): Date`
  - `function planActions(input: PlanInput): PlannedAction[]`
  - `interface PlanInput { desired: DesiredState[]; actual: Map<string, ActualState>; contractsByPerson: ReadonlyMap<string, ContractFacts[]>; syntraUserByPerson: ReadonlyMap<string, { id: string; status: string }>; pairedDirectorySource: boolean; ladder: LadderSettings; now: Date }`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ACTION_ORDER, addDays, planActions } from './plan.js';
import type { ActualState, ContractFacts, DesiredState, LadderSettings } from './types.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const ladder: LadderSettings = {
  entitlementRevocationDelayDays: 0,
  disableGraceDays: 0,
  archiveAfterDays: null,
  reenableWithoutConfirmationDays: 7,
  renameEnabled: false,
};

const contract = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  id: 'contract-1',
  sequence: 1,
  isPrimary: true,
  startDate: day('2020-01-01'),
  endDate: null,
  department: 'Finance',
  jobTitle: 'Analyst',
  costCentre: null,
  employer: null,
  location: null,
  fte: 1,
  ...over,
});

const desired = (over: Partial<DesiredState> = {}): DesiredState => ({
  personId: 'person-1',
  account: {
    required: true,
    attributes: { displayName: ['Anna Novak'] },
    container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    enabledNow: true,
    correlationKey: 'anna.novak',
  },
  entitlements: new Set(['ent-finance']),
  attribution: new Map([
    [
      'ent-finance',
      [{ ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'contract-1' }],
    ],
  ]),
  notYetStarted: false,
  unprocessable: null,
  ...over,
});

const actual = (over: Partial<ActualState> = {}): ActualState => ({
  personId: 'person-1',
  accountId: 'account-1',
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  status: 'active',
  existsAtTarget: true,
  enabledAtTarget: true,
  disabledAt: null,
  dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
  attributes: { displayName: ['Anna Novak'] },
  heldEntitlements: new Set(['ent-finance']),
  heldWithinRemit: new Set(['ent-finance']),
  ...over,
});

const plan = (over: Partial<Parameters<typeof planActions>[0]> = {}) =>
  planActions({
    desired: [desired()],
    actual: new Map([['person-1', actual()]]),
    contractsByPerson: new Map([['person-1', [contract()]]]),
    syntraUserByPerson: new Map(),
    pairedDirectorySource: false,
    ladder,
    now: NOW,
    ...over,
  });

const types = (actions: ReturnType<typeof plan>) => actions.map((a) => a.actionType);

describe('addDays', () => {
  it('adds whole days without drifting across a daylight-saving boundary', () => {
    expect(addDays(day('2026-03-28'), 3)).toEqual(day('2026-03-31'));
    expect(addDays(day('2026-06-15'), 0)).toEqual(day('2026-06-15'));
  });
});

describe('planActions — a run with nothing to do', () => {
  it('proposes nothing when desired and actual agree', () => {
    expect(plan()).toEqual([]);
  });
});

describe('planActions — the joiner', () => {
  it('creates the account before granting entitlements', () => {
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            accountId: null,
            anchor: null,
            status: 'absent',
            existsAtTarget: false,
            enabledAtTarget: false,
            dn: null,
            attributes: {},
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    // Account before entitlements, always, because a grant needs an anchor.
    expect(types(actions)).toEqual(['create_account', 'grant_entitlement']);
    expect(actions[0]!.after).toEqual({
      correlationKey: 'anna.novak',
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      attributes: { displayName: ['Anna Novak'] },
      enabled: true,
    });
    expect(actions[1]!.attributedRuleIds).toEqual(['rule-finance']);
  });

  it('creates a pre-hire account disabled and grants nothing', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: false,
            correlationKey: 'anna.novak',
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            accountId: null,
            anchor: null,
            status: 'absent',
            existsAtTarget: false,
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account']);
    expect(actions[0]!.after).toMatchObject({ enabled: false });
  });
});

describe('planActions — the mover', () => {
  it('updates attributes, grants what is newly required and revokes what is not, immediately', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'], department: ['Facilities'] },
            container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
          entitlements: new Set(['ent-facilities']),
          attribution: new Map([
            [
              'ent-facilities',
              [{ ruleId: 'rule-fac', ruleName: 'Facilities', contractId: 'contract-1' }],
            ],
          ]),
        }),
      ],
    });
    // Mover revocations are immediate: the person is still present, the
    // least-privilege answer is to take the old department's access away now,
    // and if it was a mistake they are there to say so.
    expect(types(actions)).toEqual([
      'update_account',
      'grant_entitlement',
      'revoke_entitlement',
    ]);
    expect(actions[0]!.before).toEqual({
      attributes: { displayName: ['Anna Novak'] },
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    });
    expect(actions[0]!.after).toEqual({
      // The COMPLETE managed set, not a delta: the connector writes desired
      // state, so the same update twice leaves the same result.
      attributes: { displayName: ['Anna Novak'], department: ['Facilities'] },
      container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
    });
  });

  it('treats a container change as an update, leaving the anchor alone', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
        }),
      ],
    });
    expect(types(actions)).toEqual(['update_account']);
    expect(actions[0]!.accountId).toBe('account-1');
  });

  it('disables immediately with no grace when the account is no longer required but the person is still employed', () => {
    // A mover, not a leaver. The leaver grace timers are anchored to a
    // contract end date, and this person does not have one; inventing a
    // departure date for them would be inventing data.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      ladder: { ...ladder, disableGraceDays: 30, entitlementRevocationDelayDays: 14 },
    });
    // Revocations precede disable, and neither waits.
    expect(types(actions)).toEqual(['revoke_entitlement', 'disable_account']);
    expect(actions[1]!.message).toContain('still employed');
  });
});

describe('planActions — the leaver and the grace ladder', () => {
  const leaver = (endDate: string, over: Partial<LadderSettings> = {}) =>
    plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day(endDate) })]]]),
      ladder: { ...ladder, ...over },
    });

  it('revokes and disables on the day the contract ends with the default zero grace', () => {
    expect(types(leaver('2026-06-15'))).toEqual([
      'revoke_entitlement',
      'disable_account',
    ]);
  });

  it('proposes nothing the day before a timer is due', () => {
    expect(types(leaver('2026-06-16', { disableGraceDays: 0 }))).toEqual([]);
  });

  it('proposes the disable exactly on the day it falls due', () => {
    expect(types(leaver('2026-06-08', { disableGraceDays: 7 }))).toEqual([
      'revoke_entitlement',
      'disable_account',
    ]);
  });

  it('proposes nothing the day before the disable falls due', () => {
    // The revocation delay has to move with the disable grace, or this case
    // proposes `revoke_entitlement`: the delay defaults to 0, so a contract
    // ending on the 9th makes the revocation due on the 9th and the run on the
    // 15th proposes it. "Nothing is due yet" means nothing on the whole
    // ladder, not just the rung being tested.
    expect(
      types(
        leaver('2026-06-09', {
          entitlementRevocationDelayDays: 7,
          disableGraceDays: 7,
        }),
      ),
    ).toEqual([]);
  });

  it('holds entitlements until their own delay elapses, then revokes', () => {
    expect(
      types(leaver('2026-06-12', { entitlementRevocationDelayDays: 3, disableGraceDays: 7 })),
    ).toEqual(['revoke_entitlement']);
  });

  it('archives once archiveAfterDays elapses, after the disable', () => {
    const actions = leaver('2026-03-15', { disableGraceDays: 7, archiveAfterDays: 90 });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'archive_account',
    ]);
  });

  it('never archives when archiveAfterDays is null', () => {
    const actions = leaver('2020-01-01', { disableGraceDays: 7, archiveAfterDays: null });
    expect(types(actions)).not.toContain('archive_account');
  });

  it('runs the timers from the LATER of two contract end dates', () => {
    // A person whose second contract ran three months longer left three
    // months later. Anchoring to the first deprovisions somebody still employed.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([
        [
          'person-1',
          [
            contract({ id: 'a', endDate: day('2026-03-31') }),
            contract({ id: 'b', sequence: 2, endDate: day('2026-06-30') }),
          ],
        ],
      ]),
      ladder: { ...ladder, disableGraceDays: 0 },
    });
    expect(types(actions)).toEqual([]);
  });

  it('produces every due action at once for a departure observed late', () => {
    // A retroactive contract end whose grace had already elapsed before the
    // run first observed it produces its deprovisioning actions on that same
    // run. The grace runs from the contract end date; there is no second,
    // hidden clock that starts at observation.
    const actions = leaver('2026-01-01', {
      entitlementRevocationDelayDays: 0,
      disableGraceDays: 7,
      archiveAfterDays: 30,
    });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'archive_account',
    ]);
    expect(actions[1]!.message).toContain('observed late');
  });
});

describe('planActions — the rehire', () => {
  const rehire = (disabledAt: string) =>
    plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day(disabledAt),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });

  it('enables the existing account rather than creating a second one', () => {
    // Keying the account on (personId, targetSystemId) is what makes this
    // automatic rather than a special case. They get their old login and their
    // old files back.
    const actions = rehire('2026-06-12');
    expect(types(actions)).toEqual(['enable_account', 'grant_entitlement']);
    expect(actions[0]!.accountId).toBe('account-1');
  });

  it('auto-applies a re-enable inside the window', () => {
    expect(rehire('2026-06-12')[0]!.requiresConfirmation).toBe(false);
  });

  it('requires confirmation for a re-enable outside the window', () => {
    // Months of accumulated entitlements are about to come back to life along
    // with the login, and an account reappearing after six months is also the
    // shape of a bad rule.
    const actions = rehire('2026-01-01');
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('disabled for 165 days');
  });

  it('treats exactly the boundary day as inside the window', () => {
    expect(rehire('2026-06-08')[0]!.requiresConfirmation).toBe(false);
  });
});

describe('planActions — rename', () => {
  it('proposes no rename when renameEnabled is off, even if the key changed', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.marsh',
          },
        }),
      ],
    });
    expect(types(actions)).not.toContain('rename_account');
  });

  it('proposes a confirmable rename when renameEnabled is on', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.marsh',
          },
        }),
      ],
      ladder: { ...ladder, renameEnabled: true },
    });
    expect(types(actions)).toContain('rename_account');
    expect(actions.find((a) => a.actionType === 'rename_account')!.requiresConfirmation).toBe(
      true,
    );
  });
});

describe('planActions — an account that vanished', () => {
  it('proposes a confirmable re-create and nothing else', () => {
    // An account that vanished usually vanished because somebody deleted it
    // deliberately, and an engine that silently puts it back the same night
    // is in an argument with an administrator, at nightly resolution, that
    // the administrator loses.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'missing_at_target',
            existsAtTarget: false,
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account']);
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('vanished');
  });
});

describe('planActions — the Syntra user', () => {
  it('deactivates the paired Syntra user alongside a disable', () => {
    // Without this, a leaver whose AD account Provision has just disabled
    // still holds a live Syntra login with a Syntra-held password.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-15') })]]]),
      syntraUserByPerson: new Map([['person-1', { id: 'user-1', status: 'active' }]]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'deactivate_syntra_user',
    ]);
  });

  it('proposes nothing for the Syntra user when the target has no paired source', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-15') })]]]),
      syntraUserByPerson: new Map([['person-1', { id: 'user-1', status: 'active' }]]),
      pairedDirectorySource: false,
    });
    expect(types(actions)).not.toContain('deactivate_syntra_user');
  });

  it('reactivates the paired Syntra user alongside an enable', () => {
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      syntraUserByPerson: new Map([['person-1', { id: 'user-1', status: 'inactive' }]]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'enable_account',
      'reactivate_syntra_user',
      'grant_entitlement',
    ]);
  });
});

describe('planActions — the person who has not started', () => {
  it('proposes nothing at all for a future joiner who already holds an account', () => {
    // The case that made this a Ruling. Their contracts are open-ended, so
    // `latestContractEnd` is null, so `departed` is false, so the mover branch
    // takes `disableDue = true` unconditionally: an immediate revoke of
    // everything they hold and an immediate disable, carrying the message "the
    // person is still employed, so there is no departure date to measure a
    // grace period from" -- about somebody who starts in September.
    //
    // Spec section 8 requires the opposite: leave it exactly as it is and
    // report it as drift (reconcile does that). This asserts the plan is
    // EMPTY, which is the only assertion that distinguishes it from a leaver;
    // `account?.required === false` is equally true of both.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
          notYetStarted: true,
        }),
      ],
      contractsByPerson: new Map([
        ['person-1', [contract({ startDate: day('2026-09-01') })]],
      ]),
    });
    expect(actions).toEqual([]);
  });

  it('still deprovisions a leaver, who reaches the same required: false by another route', () => {
    // The guard against over-correcting: `notYetStarted` must gate on itself
    // and not on `required === false`, or nobody is ever deprovisioned again.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
          notYetStarted: false,
        }),
      ],
      contractsByPerson: new Map([
        ['person-1', [contract({ endDate: day('2026-06-15') })]],
      ]),
    });
    expect(types(actions)).toEqual(['revoke_entitlement', 'disable_account']);
  });
});

describe('planActions — persons excluded from the plan', () => {
  it('proposes nothing at all for an unprocessable person', () => {
    const actions = plan({
      desired: [
        desired({
          account: null,
          entitlements: new Set(),
          unprocessable: { kind: 'no_contracts', message: 'no contracts' },
        }),
      ],
    });
    expect(actions).toEqual([]);
  });
});

describe('ACTION_ORDER', () => {
  it('puts revocations before disable and archive last', () => {
    // Revocations precede disable so that a leaver's access is gone before
    // the account stops being writable in the way archiving makes it.
    const index = (t: string) => ACTION_ORDER.indexOf(t as never);
    expect(index('create_account')).toBeLessThan(index('update_account'));
    expect(index('update_account')).toBeLessThan(index('grant_entitlement'));
    expect(index('grant_entitlement')).toBeLessThan(index('revoke_entitlement'));
    expect(index('revoke_entitlement')).toBeLessThan(index('disable_account'));
    expect(index('disable_account')).toBeLessThan(index('archive_account'));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/plan.test.ts`
Expected: FAIL — cannot find module `./plan.js`.

- [ ] **Step 3: Write the planner**

`packages/core/src/provision/plan.ts`:

```ts
import type { ProvisionActionType } from '@syntra/connectors';
import { latestContractEnd } from './desired.js';
import type {
  ActualState,
  ContractFacts,
  DesiredState,
  LadderSettings,
  PlannedAction,
} from './types.js';

/**
 * The order actions are applied within one person.
 *
 * Create before entitlements, because a grant needs an anchor. Revocations
 * before disable, so that a leaver's access is gone before the account stops
 * being writable in the way archiving makes it. Archive last, because it is
 * the only step that moves the object.
 */
export const ACTION_ORDER = [
  'create_account',
  'update_account',
  'rename_account',
  'enable_account',
  'reactivate_syntra_user',
  'grant_entitlement',
  'revoke_entitlement',
  'disable_account',
  'deactivate_syntra_user',
  'archive_account',
] as const satisfies readonly ProvisionActionType[];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days on the UTC timeline. Dates in this subsystem are contract dates,
 * which are days rather than instants, so arithmetic on the epoch is exact and
 * does not drift across a daylight-saving boundary the way setDate() does on a
 * local-time Date.
 */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

const due = (dueAt: Date, now: Date) => now.getTime() >= dueAt.getTime();

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

export interface PlanInput {
  desired: DesiredState[];
  actual: Map<string, ActualState>;
  contractsByPerson: ReadonlyMap<string, ContractFacts[]>;
  /** The Syntra User owned by the paired directory source, when there is one. */
  syntraUserByPerson: ReadonlyMap<string, { id: string; status: string }>;
  pairedDirectorySource: boolean;
  ladder: LadderSettings;
  now: Date;
}

function sameAttributes(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key] ?? [];
    const right = b[key] ?? [];
    if (left.length !== right.length) return false;
    if (left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

/**
 * Desired minus actual, with the grace timers applied and the result ordered.
 *
 * Joiner, mover and leaver are names for shapes this diff takes, not events.
 * There is nothing here that remembers what happened last time, which is what
 * makes a retroactive correction land on the next run with no replay and no
 * reconciliation script.
 *
 * Pure: no clock of its own, no database, no I/O.
 */
export function planActions(input: PlanInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const { ladder, now } = input;

  for (const state of input.desired) {
    // Excluded from the plan entirely, and their existing access untouched.
    if (state.unprocessable) continue;

    // Somebody whose contracts all start in the future. Nothing is proposed
    // and nothing is deprovisioned; if they somehow already hold an account it
    // is left exactly as it is and reported as drift by reconcile, because an
    // account belonging to somebody whose contract has not started is a
    // question, not an instruction (spec section 8).
    //
    // This cannot be inferred from anything else here. Their contracts are
    // open-ended, so `latestContractEnd` returns null, so `departed` is false,
    // so the branch below reads them as a mover and disables them today.
    if (state.notYetStarted) continue;

    const current = input.actual.get(state.personId);
    if (!current) continue;

    const personId = state.personId;
    const accountId = current.accountId;
    const contracts = input.contractsByPerson.get(personId) ?? [];
    const endDate = latestContractEnd(contracts);
    // A departure is contracts that all ended. A person still holding an
    // active contract has no departure date, and inventing one would be
    // inventing data.
    const departed = endDate !== null;

    const attributedFor = (entitlementId: string) =>
      (state.attribution.get(entitlementId) ?? []).map((a) => a.ruleId);

    const push = (
      actionType: ProvisionActionType,
      over: Partial<PlannedAction> = {},
    ) => {
      actions.push({
        actionType,
        personId,
        accountId,
        entitlementId: null,
        before: null,
        after: null,
        attributedRuleIds: [],
        requiresConfirmation: false,
        message: null,
        ...over,
      });
    };

    if (state.account?.required) {
      if (current.status === 'missing_at_target') {
        // Recreating a vanished account is confirmable, never automatic.
        push('create_account', {
          accountId,
          after: {
            correlationKey: current.correlationKey ?? state.account.correlationKey,
            container: state.account.container,
            attributes: state.account.attributes,
            enabled: state.account.enabledNow,
          },
          requiresConfirmation: true,
          message:
            'this account vanished from the target; recreating it is never automatic, because it usually vanished because somebody deleted it deliberately',
        });
        continue;
      }

      if (!current.existsAtTarget && current.status !== 'disabled') {
        push('create_account', {
          after: {
            correlationKey: state.account.correlationKey,
            container: state.account.container,
            attributes: state.account.attributes,
            enabled: state.account.enabledNow,
          },
        });
      } else {
        // The PARENT of the current DN against the desired container, not a
        // suffix test. `endsWith` reads
        // `CN=x,OU=Finance,OU=Users,DC=acme,DC=test` as already being in
        // `OU=Users,DC=acme,DC=test`, so a person whose department is cleared
        // -- and whose container therefore falls back to the shallower one --
        // is never moved. Every move to a shallower container is missed, and
        // the fallback container exists precisely for the case where the
        // deeper one cannot be computed.
        const currentContainer = containerOf(current);
        const containerChanged =
          currentContainer !== null &&
          currentContainer.toLowerCase() !== state.account.container.toLowerCase();
        if (
          !sameAttributes(current.attributes, state.account.attributes) ||
          containerChanged
        ) {
          // The complete managed set, never a delta. A container change is a
          // modifyDN at the connector; the anchor is unchanged, which is the
          // whole point of anchoring on objectGUID.
          push('update_account', {
            before: { attributes: current.attributes, container: containerOf(current) },
            after: {
              attributes: state.account.attributes,
              container: state.account.container,
            },
          });
        }

        if (
          ladder.renameEnabled &&
          state.account.correlationKey !== null &&
          current.correlationKey !== null &&
          state.account.correlationKey !== current.correlationKey
        ) {
          push('rename_account', {
            before: { correlationKey: current.correlationKey },
            after: { correlationKey: state.account.correlationKey },
            requiresConfirmation: true,
            message:
              'renaming breaks certificate subjects, profile paths, file ownership and mailbox aliases, so it is always confirmed',
          });
        }

        if (state.account.enabledNow && !current.enabledAtTarget) {
          const disabledDays =
            current.disabledAt === null ? 0 : daysBetween(current.disabledAt, now);
          const outsideWindow = disabledDays > ladder.reenableWithoutConfirmationDays;
          push('enable_account', {
            before: { enabled: false },
            after: { enabled: true },
            requiresConfirmation: outsideWindow,
            ...(outsideWindow
              ? {
                  message: `this account has been disabled for ${disabledDays} days, longer than the ${ladder.reenableWithoutConfirmationDays}-day window; months of accumulated entitlements come back with the login`,
                }
              : {}),
          });

          const user = input.syntraUserByPerson.get(personId);
          if (input.pairedDirectorySource && user && user.status !== 'active') {
            push('reactivate_syntra_user', {
              accountId,
              before: { status: user.status },
              after: { status: 'active', userId: user.id },
            });
          }
        }
      }

      for (const entitlementId of state.entitlements) {
        if (current.heldWithinRemit.has(entitlementId)) continue;
        push('grant_entitlement', {
          entitlementId,
          after: { held: true },
          attributedRuleIds: attributedFor(entitlementId),
        });
      }
    }

    // Revocations. A mover's are immediate; a leaver's wait for their own
    // delay, measured from the latest contract end date.
    const revocationDue =
      !departed || due(addDays(endDate!, ladder.entitlementRevocationDelayDays), now);

    if (revocationDue) {
      for (const entitlementId of current.heldWithinRemit) {
        if (state.entitlements.has(entitlementId)) continue;
        push('revoke_entitlement', {
          entitlementId,
          before: { held: true },
          after: { held: false },
          ...(departed
            ? {}
            : {
                message:
                  'revoked immediately: the person is still employed, so the least-privilege answer is to take the old access away now and they are present to be asked',
              }),
        });
      }
    }

    if (!state.account?.required && current.existsAtTarget) {
      // An account no longer required. If the person is still employed this is
      // a mover and it happens now, with no grace: the ladder's timers are
      // anchored to a contract end date and this person does not have one.
      const disableDue = departed
        ? due(addDays(endDate!, ladder.disableGraceDays), now)
        : true;

      if (disableDue && current.enabledAtTarget) {
        const late =
          departed && daysBetween(addDays(endDate!, ladder.disableGraceDays), now) > 0;
        push('disable_account', {
          before: { enabled: true },
          after: { enabled: false },
          message: departed
            ? late
              ? `this departure was observed late: the disable fell due on ${addDays(endDate!, ladder.disableGraceDays).toISOString().slice(0, 10)} and this is the first run to see it`
              : null
            : 'disabled immediately: this account is no longer required and the person is still employed, so there is no departure date to measure a grace period from',
        });

        const user = input.syntraUserByPerson.get(personId);
        if (input.pairedDirectorySource && user && user.status === 'active') {
          // Without this, a leaver whose account Provision has just disabled
          // still holds a live Syntra login with a Syntra-held password.
          push('deactivate_syntra_user', {
            accountId,
            before: { status: user.status },
            after: { status: 'inactive', userId: user.id },
          });
        }
      }

      if (
        departed &&
        ladder.archiveAfterDays !== null &&
        due(addDays(endDate!, ladder.archiveAfterDays), now) &&
        current.status !== 'archived'
      ) {
        push('archive_account', {
          before: { archived: false },
          after: { archived: true },
        });
      }
    }
  }

  return actions.sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.actionType) - ACTION_ORDER.indexOf(b.actionType),
  );
}

/** The container part of a DN — everything after the first comma. */
function containerOf(state: ActualState): string | null {
  if (state.dn === null) return null;
  const comma = state.dn.indexOf(',');
  return comma === -1 ? null : state.dn.slice(comma + 1);
}
```

- [ ] **Step 4: Add the two remaining types**

Append to `packages/core/src/provision/types.ts`:

```ts
import type { ProvisionActionType } from '@syntra/connectors';

export interface LadderSettings {
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  /** Null means never. */
  archiveAfterDays: number | null;
  reenableWithoutConfirmationDays: number;
  renameEnabled: boolean;
}

export interface PlannedAction {
  actionType: ProvisionActionType;
  personId: string | null;
  accountId: string | null;
  entitlementId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  attributedRuleIds: string[];
  /**
   * True for a rename, a re-enable outside the window, and a re-create of a
   * vanished account. These need an explicit tick even in a run the guard did
   * not block.
   */
  requiresConfirmation: boolean;
  message: string | null;
}
```

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/plan.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/plan.test.ts`
Expected: PASS, 29 tests.

The three that carry the most weight are "runs the timers from the LATER of two contract end dates" (anchoring to the earlier one deprovisions somebody who is still employed), "disables immediately with no grace when the account is no longer required but the person is still employed" (treating that person as a leaver would give them a grace period computed from a departure date they do not have), and the pair in "the person who has not started" — the first proves a future joiner is left alone, the second proves that leaving them alone did not switch off deprovisioning for everybody who reaches `required: false` by the other route.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: plan provisioning actions with the deprovisioning ladder"
```

---

## Task 10: The guard

**Files:**
- Create: `packages/core/src/provision/guard.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/guard.test.ts`

**Interfaces:**
- Consumes: `type PlannedAction` from `./types.js`; `type ProvisionActionType` from `@syntra/connectors`.
- Produces:
  - `interface GuardThresholds { createAccountThresholdPercent: number; disableAccountThresholdPercent: number; archiveAccountThresholdPercent: number; revokeEntitlementThresholdPercent: number; deactivateSyntraUserThresholdPercent: number; perEntitlementThresholdPercent: number; personPopulationDropPercent: number }`
  - `interface GuardInput { actions: PlannedAction[]; thresholds: GuardThresholds; accountsAtTarget: number; activeAccountsAtTarget: number; entitlementHoldingsAtTarget: number; activeSyntraUsersLinked: number; holderCountByEntitlement: ReadonlyMap<string, number>; entitlementNameById: ReadonlyMap<string, string>; personsWithActiveContract: number; previousPersonsWithActiveContract: number | null; hasEverApplied: boolean }`
  - `type GuardVerdict = { blocked: false } | { blocked: true; requiresConfirmation: boolean; reasons: string[] }`
  - `function evaluateProvisionGuard(input: GuardInput): GuardVerdict`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateProvisionGuard, type GuardInput } from './guard.js';
import type { PlannedAction } from './types.js';
import type { ProvisionActionType } from '@syntra/connectors';

const action = (
  actionType: ProvisionActionType,
  entitlementId: string | null = null,
): PlannedAction => ({
  actionType,
  personId: 'person-1',
  accountId: 'account-1',
  entitlementId,
  before: null,
  after: null,
  attributedRuleIds: [],
  requiresConfirmation: false,
  message: null,
});

const many = (
  actionType: ProvisionActionType,
  count: number,
  entitlementId: string | null = null,
) => Array.from({ length: count }, () => action(actionType, entitlementId));

const thresholds = {
  createAccountThresholdPercent: 20,
  disableAccountThresholdPercent: 10,
  archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10,
  deactivateSyntraUserThresholdPercent: 10,
  perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20,
};

const guard = (over: Partial<GuardInput> = {}) =>
  evaluateProvisionGuard({
    actions: [],
    thresholds,
    accountsAtTarget: 1000,
    activeAccountsAtTarget: 1000,
    entitlementHoldingsAtTarget: 40_000,
    activeSyntraUsersLinked: 1000,
    holderCountByEntitlement: new Map([['ent-a', 90]]),
    entitlementNameById: new Map([['ent-a', 'Payments Approvers']]),
    personsWithActiveContract: 1180,
    previousPersonsWithActiveContract: 1180,
    hasEverApplied: true,
    ...over,
  });

describe('evaluateProvisionGuard — the unconditional refusals', () => {
  it('refuses a target that returned no accounts while Syntra believes it holds some', () => {
    // An empty target and an unreachable one look identical from here, and the
    // safe reading is the second. At a target, "everything is gone" drives
    // creates as well as disables.
    const verdict = guard({
      accountsAtTarget: 0,
      actions: many('create_account', 5),
    });
    expect(verdict).toEqual({
      blocked: true,
      requiresConfirmation: false,
      reasons: [
        'the target returned no accounts at all while Syntra holds 1000 for it; an empty target and an unreachable one look identical, and the safe reading is the second',
      ],
    });
  });

  it('refuses a run with no persons at all, unconditionally', () => {
    const verdict = guard({ personsWithActiveContract: 0 });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('no persons');
  });

  it('refuses a run where the person population collapsed', () => {
    // The signature of a broken HR feed -- a truncated export, an import that
    // ran against a staging database -- which is the accident most likely to
    // produce a plan that disables everybody.
    const verdict = guard({
      personsWithActiveContract: 800,
      previousPersonsWithActiveContract: 1180,
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('32.2%');
  });

  it('allows a population drop just under the threshold', () => {
    // 1180 -> 950 is 19.5%.
    expect(guard({ personsWithActiveContract: 950 })).toEqual({ blocked: false });
  });

  it('skips the population test on a first run, which has no previous population', () => {
    const verdict = guard({
      previousPersonsWithActiveContract: null,
      hasEverApplied: false,
      accountsAtTarget: 0,
    });
    // Not the zero-accounts refusal either: Syntra holds nothing for this
    // target yet, so there is no belief to contradict.
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('never had a run applied');
  });
});

describe('evaluateProvisionGuard — the first run', () => {
  it('always requires confirmation, regardless of size', () => {
    // A first run has a denominator of zero for every population, so no
    // percentage can say anything about it, and it is also the one where the
    // rule set has never been proved against real data.
    const verdict = guard({ hasEverApplied: false, actions: many('create_account', 1) });
    expect(verdict).toEqual({
      blocked: true,
      requiresConfirmation: true,
      reasons: [
        'this target has never had a run applied, so every population has a denominator of zero and no threshold can say anything about it',
      ],
    });
  });
});

describe('evaluateProvisionGuard — per action type', () => {
  it('passes just under the create threshold', () => {
    // 199 of 1000 is 19.9%. The previous version of this pair used 200 twice,
    // so "just under" and "exactly at" were the identical case and the
    // boundary was tested once rather than on both sides of it.
    expect(guard({ actions: many('create_account', 199) })).toEqual({ blocked: false });
  });

  it('passes exactly at the create threshold', () => {
    // "above the threshold" means strictly above. 200 of 1000 is exactly 20%.
    expect(guard({ actions: many('create_account', 200) })).toEqual({ blocked: false });
  });

  it('blocks just over the create threshold', () => {
    // Creates are guarded as well as removals, which Directory Sync does not
    // do. A rule whose condition inverted proposes an account in the finance
    // system for the entire organization, and every one of those accounts
    // leaves a mailbox and a home directory behind it.
    const verdict = guard({ actions: many('create_account', 201) });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect((verdict as { reasons: string[] }).reasons[0]).toContain(
      'create 201 of 1000 accounts',
    );
  });

  it('blocks over the disable threshold at its own 10%', () => {
    expect(guard({ actions: many('disable_account', 100) })).toEqual({ blocked: false });
    expect(guard({ actions: many('disable_account', 101) })).toMatchObject({
      blocked: true,
      requiresConfirmation: true,
    });
  });

  it('blocks over the archive threshold at its own 2%', () => {
    expect(guard({ actions: many('archive_account', 20) })).toEqual({ blocked: false });
    expect(guard({ actions: many('archive_account', 21) })).toMatchObject({
      blocked: true,
    });
  });

  it('blocks over the Syntra user deactivation threshold', () => {
    expect(guard({ actions: many('deactivate_syntra_user', 101) })).toMatchObject({
      blocked: true,
    });
  });

  it('does not threshold-guard the additive and corrective action types', () => {
    // update, enable, grant, rename and reactivate are additive or corrective,
    // and a mass grant, while undesirable, is visible in the plan and
    // reversible by the next run. Rename and re-enable have their own
    // confirmation rules.
    expect(
      guard({
        actions: [
          ...many('update_account', 1000),
          ...many('enable_account', 1000),
          ...many('grant_entitlement', 5000, 'ent-a'),
          ...many('rename_account', 1000),
          ...many('reactivate_syntra_user', 1000),
        ],
        holderCountByEntitlement: new Map([['ent-a', 10_000]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('evaluateProvisionGuard — the second axis, per entitlement', () => {
  it('blocks when one entitlement is emptied even though the global axis is nowhere near', () => {
    // 90 revocations against 40,000 holdings is 0.2% and passes the 10%
    // global threshold without a murmur. For the 90 people it is total.
    const verdict = guard({ actions: many('revoke_entitlement', 90, 'ent-a') });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    const reasons = (verdict as { reasons: string[] }).reasons;
    expect(reasons).toHaveLength(1);
    // The reason names the entitlement, the count and the share.
    expect(reasons[0]).toContain('Payments Approvers');
    expect(reasons[0]).toContain('90 of 90');
    expect(reasons[0]).toContain('100.0%');
  });

  it('passes just under the per-entitlement threshold', () => {
    expect(guard({ actions: many('revoke_entitlement', 45, 'ent-a') })).toEqual({
      blocked: false,
    });
  });

  it('blocks just over the per-entitlement threshold', () => {
    expect(guard({ actions: many('revoke_entitlement', 46, 'ent-a') })).toMatchObject({
      blocked: true,
    });
  });

  it('trips the global axis without the per-entitlement axis', () => {
    // 5000 revocations spread thinly across many groups.
    const spread = Array.from({ length: 5000 }, (_, i) =>
      action('revoke_entitlement', `ent-${i % 500}`),
    );
    const holders = new Map<string, number>();
    for (let i = 0; i < 500; i += 1) holders.set(`ent-${i}`, 1000);
    const verdict = guard({
      actions: spread,
      holderCountByEntitlement: holders,
      entitlementNameById: new Map(),
    });
    expect(verdict).toMatchObject({ blocked: true });
    expect((verdict as { reasons: string[] }).reasons[0]).toContain(
      'revoke 5000 of 40000 entitlement holdings',
    );
  });

  it('reports both axes when both trip', () => {
    const verdict = guard({
      actions: many('revoke_entitlement', 5000, 'ent-a'),
      holderCountByEntitlement: new Map([['ent-a', 6000]]),
      entitlementNameById: new Map([['ent-a', 'Everyone']]),
    });
    expect((verdict as { reasons: string[] }).reasons).toHaveLength(2);
  });

  it('skips an entitlement with no current holders', () => {
    // A first grant of a brand-new group has a denominator of zero and there
    // is nothing to protect.
    expect(
      guard({
        actions: many('revoke_entitlement', 5, 'ent-new'),
        holderCountByEntitlement: new Map([['ent-new', 0]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('evaluateProvisionGuard — autoApply does not enter into it', () => {
  it('has no input by which a caller could waive a threshold', () => {
    // The guard is a pure function of the plan and a set of counts. There is
    // deliberately no `autoApply`, no `force` and no `override` on GuardInput.
    //
    // Inspect the INPUT, not the verdict. The previous version read
    // `Object.keys` of the verdict -- which of course never contains
    // `autoApply`, and would go on not containing it however many waivers
    // GuardInput grew.
    const input: GuardInput = {
      actions: many('disable_account', 500),
      thresholds,
      accountsAtTarget: 1000,
      activeAccountsAtTarget: 1000,
      entitlementHoldingsAtTarget: 40_000,
      activeSyntraUsersLinked: 1000,
      holderCountByEntitlement: new Map(),
      entitlementNameById: new Map(),
      personsWithActiveContract: 1180,
      previousPersonsWithActiveContract: 1180,
      hasEverApplied: true,
    };
    for (const waiver of ['autoApply', 'force', 'override', 'confirm', 'skipGuard']) {
      expect(Object.keys(input)).not.toContain(waiver);
    }
    // And the guard blocks it regardless of who is calling.
    expect(evaluateProvisionGuard(input)).toMatchObject({ blocked: true });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/guard.test.ts`
Expected: FAIL — cannot find module `./guard.js`.

- [ ] **Step 3: Write the guard**

`packages/core/src/provision/guard.ts`:

```ts
import type { ProvisionActionType } from '@syntra/connectors';
import type { PlannedAction } from './types.js';

export interface GuardThresholds {
  createAccountThresholdPercent: number;
  disableAccountThresholdPercent: number;
  archiveAccountThresholdPercent: number;
  revokeEntitlementThresholdPercent: number;
  deactivateSyntraUserThresholdPercent: number;
  perEntitlementThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface GuardInput {
  actions: PlannedAction[];
  thresholds: GuardThresholds;
  accountsAtTarget: number;
  activeAccountsAtTarget: number;
  entitlementHoldingsAtTarget: number;
  activeSyntraUsersLinked: number;
  /**
   * That entitlement's own CURRENT HOLDER COUNT AT THE TARGET, not Syntra's
   * record of what it granted (spec section 11).
   *
   * The distinction is the whole second axis. Counting `AccountEntitlement`
   * rows measures what Provision believes it did, and on a target Provision
   * has not applied to yet -- or whose inventory has come apart, which is the
   * condition drift exists to report -- every count is zero, `holders === 0`
   * skips the entitlement, and the axis protects nothing. The run builds this
   * from the reconciled target inventory (Task 13).
   */
  holderCountByEntitlement: ReadonlyMap<string, number>;
  entitlementNameById: ReadonlyMap<string, string>;
  personsWithActiveContract: number;
  /** Null on a first run; the test is skipped then. */
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type GuardVerdict =
  | { blocked: false }
  /**
   * `requiresConfirmation` separates the two refusals. A run whose target
   * returned nothing, or whose person population collapsed, is refused
   * outright: there is nothing an administrator could usefully confirm about
   * a directory that may simply be unreachable, or an HR feed that may be
   * truncated. A run over a threshold is refused *pending* confirmation,
   * because a real cohort departure has to be processable.
   */
  | { blocked: true; requiresConfirmation: boolean; reasons: string[] };

interface Population {
  actionType: ProvisionActionType;
  verb: string;
  noun: string;
  total(input: GuardInput): number;
  threshold(t: GuardThresholds): number;
}

/**
 * Every consequential action type is its own population with its own
 * denominator.
 *
 * Directory Sync learned the hard way that a guard which counts only the
 * obvious population misses the dangerous one: membership removals sat
 * entirely outside it while user deactivations were carefully gated, and a
 * wrong group filter could empty every group in a tenant while sailing under
 * the user threshold.
 *
 * Absent from this list, deliberately: update_account, enable_account,
 * grant_entitlement, rename_account and reactivate_syntra_user. They are
 * additive or corrective, and a mass grant, while undesirable, is visible in
 * the plan and reversible by the next run.
 */
const POPULATIONS: Population[] = [
  {
    actionType: 'create_account',
    verb: 'create',
    noun: 'accounts',
    total: (i) => i.accountsAtTarget,
    threshold: (t) => t.createAccountThresholdPercent,
  },
  {
    actionType: 'disable_account',
    verb: 'disable',
    noun: 'active accounts',
    total: (i) => i.activeAccountsAtTarget,
    threshold: (t) => t.disableAccountThresholdPercent,
  },
  {
    actionType: 'archive_account',
    verb: 'archive',
    noun: 'accounts',
    total: (i) => i.accountsAtTarget,
    threshold: (t) => t.archiveAccountThresholdPercent,
  },
  {
    actionType: 'revoke_entitlement',
    verb: 'revoke',
    noun: 'entitlement holdings',
    total: (i) => i.entitlementHoldingsAtTarget,
    threshold: (t) => t.revokeEntitlementThresholdPercent,
  },
  {
    actionType: 'deactivate_syntra_user',
    verb: 'deactivate',
    noun: 'active Syntra users linked to this target',
    total: (i) => i.activeSyntraUsersLinked,
    threshold: (t) => t.deactivateSyntraUserThresholdPercent,
  },
];

/**
 * Decides whether a plan may be applied at all.
 *
 * It is a pure function of the plan and a set of counts, it is not advisory,
 * and `autoApply` does not override it — there is deliberately no input by
 * which a caller could waive it, because an unattended schedule is exactly the
 * case it exists for. Confirmation is per run, by a person who has read the
 * numbers; the scheduler never confirms anything.
 */
export function evaluateProvisionGuard(input: GuardInput): GuardVerdict {
  const hard: string[] = [];

  // A run with no persons at all is refused unconditionally, before anything
  // else: it is upstream of every leaver action in the plan.
  if (input.personsWithActiveContract === 0) {
    hard.push(
      'this run found no persons holding an active contract at all, which is upstream of every leaver action a plan could contain',
    );
  } else if (input.previousPersonsWithActiveContract !== null) {
    const previous = input.previousPersonsWithActiveContract;
    if (previous > 0) {
      const drop = ((previous - input.personsWithActiveContract) / previous) * 100;
      if (drop > input.thresholds.personPopulationDropPercent) {
        hard.push(
          `the number of persons holding an active contract has fallen from ${previous} to ${input.personsWithActiveContract} (${drop.toFixed(1)}%), above the ${input.thresholds.personPopulationDropPercent}% limit; this is the signature of a broken HR feed`,
        );
      }
    }
  }

  // An empty target and an unreachable one look identical from here.
  if (input.accountsAtTarget === 0 && input.hasEverApplied) {
    hard.push(
      `the target returned no accounts at all while Syntra holds ${input.activeAccountsAtTarget} for it; an empty target and an unreachable one look identical, and the safe reading is the second`,
    );
  }

  if (hard.length > 0) {
    return { blocked: true, requiresConfirmation: false, reasons: hard };
  }

  // A first run has a denominator of zero for every population, so no
  // percentage can say anything about it. Directory Sync's guard skips a
  // population with no denominator, which is right for a sync and not right
  // for a first mass create.
  if (!input.hasEverApplied) {
    return {
      blocked: true,
      requiresConfirmation: true,
      reasons: [
        'this target has never had a run applied, so every population has a denominator of zero and no threshold can say anything about it',
      ],
    };
  }

  const tripped: string[] = [];

  for (const population of POPULATIONS) {
    const count = input.actions.filter(
      (a) => a.actionType === population.actionType,
    ).length;
    if (count === 0) continue;

    const total = population.total(input);
    if (total === 0) continue;

    const share = (count / total) * 100;
    const threshold = population.threshold(input.thresholds);
    if (share > threshold) {
      tripped.push(
        `would ${population.verb} ${count} of ${total} ${population.noun} (${share.toFixed(1)}%), above the ${threshold}% threshold`,
      );
    }
  }

  // The second axis. Revoking every holder of one entitlement is the exact
  // signature of a rule that stopped matching -- a renamed department, a
  // changed job title string, a mistyped condition -- and in a tenant with
  // 40,000 holdings across 300 groups, emptying one group of its 90 members
  // is 0.2% of the total.
  const revocationsByEntitlement = new Map<string, number>();
  for (const action of input.actions) {
    if (action.actionType !== 'revoke_entitlement') continue;
    if (action.entitlementId === null) continue;
    revocationsByEntitlement.set(
      action.entitlementId,
      (revocationsByEntitlement.get(action.entitlementId) ?? 0) + 1,
    );
  }

  for (const [entitlementId, count] of revocationsByEntitlement) {
    const holders = input.holderCountByEntitlement.get(entitlementId) ?? 0;
    // Zero holders at the target means nobody holds it, so there is nothing
    // for a percentage to protect -- the first grant of a brand-new group.
    // This is only safe because the denominator is read from the target: a
    // denominator taken from Syntra's own records would read "we have not
    // recorded any holders" as "nobody holds it" and skip the axis on exactly
    // the runs it exists for.
    if (holders === 0) continue;
    const share = (count / holders) * 100;
    if (share > input.thresholds.perEntitlementThresholdPercent) {
      const name = input.entitlementNameById.get(entitlementId) ?? entitlementId;
      tripped.push(
        `would revoke "${name}" from ${count} of ${holders} holders (${share.toFixed(1)}%), above the ${input.thresholds.perEntitlementThresholdPercent}% per-entitlement threshold`,
      );
    }
  }

  if (tripped.length === 0) return { blocked: false };
  return { blocked: true, requiresConfirmation: true, reasons: tripped };
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/guard.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/guard.test.ts`
Expected: PASS, 19 tests.

If "blocks when one entitlement is emptied" passes only because the global axis tripped, check the reason text: the test asserts exactly one reason, naming the entitlement. A guard with only the global axis is the defect the previous slice shipped.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add the two-axis provisioning guard"
```

---

## Task 11: The Active Directory target connector

> **CORRECTION FROM TASK 4 — every `client.modify(dn, [...] as never)` below is
> wrong and will throw at runtime.** Verified against `ldapts@9.0.0` and a live
> Samba domain controller:
>
> ```
> TypeError: change.write is not a function
> ```
>
> `Client.modify(dn, changes)` is typed `Change | Change[]`, and
> `ModifyRequest.writeMessage` calls `change.write(writer)` on each element.
> `Change.write` then calls `this.modification.write(writer)`, so the
> modification must be a real `Attribute` as well. An object literal of the
> right *shape* is not enough, and the `as never` cast is precisely what stops
> the compiler from saying so — the same class of suppressed diagnostic as the
> three-argument `modifyDN` trap the spike documents two paragraphs later.
>
> Spell every change like this instead (Task 4 uses a one-line `replace()`
> helper so there is a single place to be right):
>
> ```ts
> import { Attribute, Change } from 'ldapts';
>
> await client.modify(dn, new Change({
>   operation: 'replace',
>   modification: new Attribute({ type: 'userAccountControl', values: ['512'] }),
> }));
> ```
>
> `Attribute.write` branches on `Buffer.isBuffer(value)`, so a UTF-16LE
> `unicodePwd` buffer passes through unchanged.
>
> Two further corrections from Task 4: import `samba-connection.js` by relative
> path from inside this package (unchanged), and the diagnostics-only plain-LDAP
> port is **1390**, not 1389 — `openldap` owns 1389 in the same compose file.

The only module in the system that writes to Active Directory.

**Files:**
- Create: `packages/connectors/src/ad/uac.ts`
- Create: `packages/connectors/src/ad/config.ts`
- Create: `packages/connectors/src/ad/connector.ts`
- Modify: `packages/connectors/src/index.ts`
- Test: `packages/connectors/src/ad/uac.test.ts`, `packages/connectors/src/ad/connector.integration.test.ts`

**Interfaces:**
- Consumes: `Client` from `ldapts`; `normaliseAnchor` from `../ldap/anchor.js`; `readRangedAttribute`, `RANGE_STEP` from `../ldap/range.js`; `ldapTlsModeSchema` from `../ldap/config.js`; `type TargetConnector`, `type WriteOperation`, `type WriteResult`, `type WriteFailure`, `type DiscoveredEntitlement` from `../types.js`; `sambaConnection`, `connectAsSambaAdmin`, `purgeSubtree` from `./samba-connection.js` (a plain module — importing the smoke test would run it).
- Produces:
  - `const UAC_NORMAL_DISABLED = 514`, `const UAC_NORMAL_ENABLED = 512`, `const UAC_DISABLE_BIT = 2`
  - `function withDisableBit(uac: number): number`, `function withoutDisableBit(uac: number): number`, `function isEnabled(uac: number): boolean`
  - `const adTargetConfigSchema`, `type AdTargetConfig = z.input<typeof adTargetConfigSchema>`
  - `function encodeUnicodePwd(password: string): Buffer`
  - `function escapeFilterValue(value: string): string` — RFC 4515 escaping
  - `function classifyLdapError(cause: unknown): WriteFailure`
  - `async function readGroupMembers(config, groupDn): Promise<string[]>` — called by Task 13 phase 4
  - `const adTargetConnector: TargetConnector<AdTargetConfig & { bindPassword: string }>`, including `listContainers`

The connector **generates no password**. `create_account` carries an `initialPassword` the caller produced, sealed and delivered (Task 14). A connector that invents one writes it to the directory and drops it: nothing carries it back out, so `initialPasswordPolicy` and `initialPasswordDelivery` have nothing behind them and no account Provision creates is usable by the person it was created for.

- [ ] **Step 1: Write the failing unit test for the userAccountControl helpers**

`packages/connectors/src/ad/uac.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  UAC_DISABLE_BIT,
  UAC_NORMAL_DISABLED,
  UAC_NORMAL_ENABLED,
  isEnabled,
  withDisableBit,
  withoutDisableBit,
} from './uac.js';

describe('userAccountControl', () => {
  it('uses the two values Active Directory expects', () => {
    expect(UAC_NORMAL_ENABLED).toBe(512);
    expect(UAC_NORMAL_DISABLED).toBe(514);
    expect(UAC_DISABLE_BIT).toBe(2);
  });

  it('sets and clears only the disable bit, preserving every other flag', () => {
    // 66048 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD. Disabling somebody must
    // not silently re-enable password expiry, or smart-card requirement, or
    // any of the dozen other flags an administrator set by hand.
    expect(withDisableBit(66_048)).toBe(66_050);
    expect(withoutDisableBit(66_050)).toBe(66_048);
  });

  it('is idempotent in both directions', () => {
    // disable_account asserts a state rather than toggling one, which is what
    // makes it free to retry.
    expect(withDisableBit(withDisableBit(512))).toBe(514);
    expect(withoutDisableBit(withoutDisableBit(514))).toBe(512);
  });

  it('reads enabled from the bit, not from equality with 512', () => {
    expect(isEnabled(512)).toBe(true);
    expect(isEnabled(66_048)).toBe(true);
    expect(isEnabled(514)).toBe(false);
    expect(isEnabled(66_050)).toBe(false);
  });
});
```

- [ ] **Step 2: Write the userAccountControl helpers**

`packages/connectors/src/ad/uac.ts`:

```ts
/** A normal account, disabled. Every account is created at this value first. */
export const UAC_NORMAL_DISABLED = 514;
/** A normal account, enabled. */
export const UAC_NORMAL_ENABLED = 512;
/** ACCOUNTDISABLE. */
export const UAC_DISABLE_BIT = 2;

/**
 * Sets the disable bit and leaves every other flag alone.
 *
 * Writing a bare 514 would clear DONT_EXPIRE_PASSWORD, SMARTCARD_REQUIRED and
 * everything else an administrator set by hand on that account. Disabling
 * somebody is not licence to reset their account's other properties.
 */
export function withDisableBit(uac: number): number {
  return uac | UAC_DISABLE_BIT;
}

export function withoutDisableBit(uac: number): number {
  return uac & ~UAC_DISABLE_BIT;
}

export function isEnabled(uac: number): boolean {
  return (uac & UAC_DISABLE_BIT) === 0;
}
```

- [ ] **Step 3: Run the unit test**

Run: `pnpm vitest run packages/connectors/src/ad/uac.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write the target configuration schema**

`packages/connectors/src/ad/config.ts`:

```ts
import { z } from 'zod';
import { ldapTlsModeSchema } from '../ldap/config.js';

const isLdapsUrl = (url: string) => url.trim().toLowerCase().startsWith('ldaps:');

export const adTargetConfigSchema = z
  .object({
    url: z.string().min(1),
    /**
     * `plain` is absent from this enum, unlike the directory source schema.
     * Active Directory refuses a password write over an unencrypted
     * connection, and a target that could be configured to write in the clear
     * is a target that eventually does. The Samba container the integration
     * tests run against refuses even an ordinary bind without TLS.
     */
    tlsMode: ldapTlsModeSchema.exclude(['plain']),
    rejectUnauthorized: z.boolean().default(true),
    bindDn: z.string().min(1),
    baseDn: z.string().min(1),
    /** Where listEntitlements enumerates groups. */
    entitlementSearchBase: z.string().min(1),
    /** Where archive_account moves the object. */
    archiveContainer: z.string().min(1),
    /**
     * Where create_account writes the tenant id and originating actionId.
     * `info` on Active Directory, or a nominated extensionAttribute.
     */
    provenanceAttribute: z.string().default('info'),
    /** objectGUID. Kept configurable only so a test fixture can vary it. */
    anchorAttribute: z.string().default('objectGUID'),
    accountFilter: z
      .string()
      .default('(&(objectCategory=person)(objectClass=user))'),
    groupFilter: z.string().default('(objectClass=group)'),
    /**
     * Excluded from the entitlement catalog entirely. Primary group membership
     * is not in `member` and cannot be removed by writing to it, so an attempt
     * to revoke it would be attempted and fail forever.
     */
    primaryGroupExternalIds: z.array(z.string()).default([]),
    pageSize: z.number().int().positive().max(5000).default(1000),
    connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  })
  .superRefine((config, ctx) => {
    if (isLdapsUrl(config.url) && config.tlsMode !== 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message: `an ldaps:// URL is implicit TLS, so it cannot also be "${config.tlsMode}"; use an ldap:// URL for starttls`,
      });
    }
    if (!isLdapsUrl(config.url) && config.tlsMode === 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message: 'tlsMode "ldaps" needs an ldaps:// URL',
      });
    }
  });

export type AdTargetConfig = z.input<typeof adTargetConfigSchema>;
export type ResolvedAdTargetConfig = z.output<typeof adTargetConfigSchema>;
```

- [ ] **Step 5: Write the failing integration test**

`packages/connectors/src/ad/connector.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'ldapts';
import { adTargetConnector } from './connector.js';
// A plain module. Importing `samba.smoke.test.js` would register its hooks and
// its five tests inside THIS file's collection and run them again -- and they
// are not idempotent.
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
} from './samba-connection.js';
import type { AdTargetConfig } from './config.js';

const samba = sambaConnection();
const testOu = `OU=ProvisionTest,${samba.baseDn}`;
const archiveOu = `OU=ProvisionArchive,${samba.baseDn}`;
const groupsOu = `OU=ProvisionGroups,${samba.baseDn}`;

const config: AdTargetConfig & { bindPassword: string } = {
  url: samba.url,
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: samba.bindDn,
  bindPassword: samba.bindPassword,
  baseDn: testOu,
  entitlementSearchBase: groupsOu,
  archiveContainer: archiveOu,
  provenanceAttribute: 'info',
};

let admin: Client;

/** Removes every object under the test OUs so each test starts clean. */
async function purge(): Promise<void> {
  for (const base of [testOu, groupsOu, archiveOu]) {
    await purgeSubtree(admin, base);
  }
}

beforeAll(async () => {
  admin = await connectAsSambaAdmin();
  for (const ou of [testOu, archiveOu, groupsOu]) {
    await admin.add(ou, { objectClass: ['top', 'organizationalUnit'] }).catch(() => undefined);
  }
}, 120_000);

beforeEach(purge);

afterAll(async () => {
  await purge();
  await admin?.unbind().catch(() => undefined);
});

const INITIAL_PASSWORD = 'Provision!Initial0';

const createOp = (actionId: string, correlationKey: string, enabled = true) => ({
  op: 'create_account' as const,
  actionId,
  correlationKey,
  attributes: {
    displayName: ['Anna Novak'],
    givenName: ['Anna'],
    sn: ['Novak'],
    userPrincipalName: [`${correlationKey}@syntra.test`],
    mail: [`${correlationKey}@syntra.test`],
    distinguishedName: [`CN=${correlationKey},${testOu}`],
  },
  enabled,
  // Supplied, never invented here. The connector writes exactly this value,
  // which is what lets Task 14 seal it into the vault and deliver it.
  initialPassword: INITIAL_PASSWORD,
});

async function readUac(dn: string): Promise<number> {
  const { searchEntries } = await admin.search(dn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['userAccountControl'],
  });
  return Number(searchEntries[0]!.userAccountControl);
}

describe('adTargetConnector — test and discovery', () => {
  it('connects and reports what it found', async () => {
    const result = await adTargetConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(samba.url);
  });

  it('refuses to connect with certificate verification left on', async () => {
    // The container's certificate is self-signed. Turning verification off is
    // a deliberate, explicit decision, never a default.
    const result = await adTargetConnector.test({ ...config, rejectUnauthorized: true });
    expect(result.ok).toBe(false);
  });

  it('enumerates groups as entitlements keyed on objectGUID', async () => {
    await admin.add(`CN=Finance,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'Finance',
    });
    const found = [];
    for await (const entitlement of adTargetConnector.listEntitlements(config)) {
      found.push(entitlement);
    }
    expect(found).toHaveLength(1);
    expect(found[0]!.displayName).toBe('Finance');
    expect(found[0]!.type).toBe('group');
    // The group's objectGUID, not its name or DN. Renaming a group must not
    // read as "revoke this from all 400 holders and grant a new thing".
    expect(found[0]!.externalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('reports the group distinguished name alongside its objectGUID', async () => {
    // Both, and for different reasons. `externalId` is the identity, so a
    // rename is not a mass revoke-and-regrant. `dn` is what a user's
    // `memberOf` actually contains, so without it there is no way to map a
    // membership list back onto entitlements -- and every lookup misses
    // silently, which reads as "this account holds nothing".
    await admin.add(`CN=Payroll,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'Payroll',
    });
    const found = [];
    for await (const entitlement of adTargetConnector.listEntitlements(config)) {
      found.push(entitlement);
    }
    expect(found[0]!.dn.toLowerCase()).toBe(`cn=payroll,${groupsOu}`.toLowerCase());
    expect(found[0]!.dn).not.toBe(found[0]!.externalId);
  });

  it('lists containers that hold no accounts at all', async () => {
    // The whole reason containers are read rather than inferred from the DNs
    // of the accounts returned: an empty OU is a real, configured place to put
    // people, and on a first run against an empty target EVERY OU is empty.
    await admin.add(`OU=Empty,${testOu}`, {
      objectClass: ['top', 'organizationalUnit'],
    });
    const containers = [];
    for await (const container of adTargetConnector.listContainers(config)) {
      containers.push(container.dn.toLowerCase());
    }
    expect(containers).toContain(`ou=empty,${testOu}`.toLowerCase());
    expect(containers).toContain(testOu.toLowerCase());
  });

  it('names the rights it could not exercise rather than reporting a bare success', async () => {
    // Spec section 18: the bind should hold only the rights it needs, and
    // `test` reports which of those it could not exercise, so an
    // over-privileged bind is a visible choice rather than a default. Read
    // through Active Directory's effective-rights attributes -- it never
    // writes a probe object, because there would then be a probe object to
    // delete and this connector has no delete.
    const result = await adTargetConnector.test(config);
    expect(result.ok).toBe(true);
    const rights = (result as { rights?: { right: string; status: string }[] }).rights!;
    expect(rights.map((r) => r.right).sort()).toEqual([
      'createUser',
      'modifyMembership',
      'modifyUser',
      'moveUser',
    ]);
    // Every right is accounted for. A server that does not publish effective
    // rights yields `unverified`, which is not the same as `granted` and must
    // never be reported as one.
    for (const right of rights) {
      expect(['granted', 'denied', 'unverified']).toContain(right.status);
    }
  });

  it('excludes a configured primary group from the catalog', async () => {
    await admin.add(`CN=Domain Users Clone,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'DomainUsersClone',
    });
    const first = [];
    for await (const e of adTargetConnector.listEntitlements(config)) first.push(e);
    const excluded = [];
    for await (const e of adTargetConnector.listEntitlements({
      ...config,
      primaryGroupExternalIds: [first[0]!.externalId],
    })) {
      excluded.push(e);
    }
    expect(excluded).toHaveLength(0);
  });
});

describe('adTargetConnector — create_account, which is three writes', () => {
  it('creates a disabled object, sets the password, then enables it', async () => {
    const result = await adTargetConnector.write(config, createOp('action-1', 'anna.novak'));
    expect(result.ok).toBe(true);
    // objectGUID, rendered the way Microsoft tooling does, so it can be
    // pasted into AD and find the same object.
    expect(result.anchor).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await readUac(`CN=anna.novak,${testOu}`)).toBe(512);
  });

  it('leaves a pre-hire created and disabled', async () => {
    // A pre-hire stops after the password. Only the account object exists
    // early, disabled and empty; access itself is granted on the day.
    await adTargetConnector.write(config, createOp('action-2', 'bo.lind', false));
    expect(await readUac(`CN=bo.lind,${testOu}`)).toBe(514);
  });

  it('writes the provenance marker so a retry can adopt', async () => {
    await adTargetConnector.write(config, createOp('action-3', 'cy.marsh'));
    const { searchEntries } = await admin.search(`CN=cy.marsh,${testOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['info'],
    });
    expect(String(searchEntries[0]!.info)).toContain('action-3');
  });

  it('adopts its own account on retry rather than creating a second', async () => {
    await adTargetConnector.write(config, createOp('action-4', 'dee.olsen'));
    const retry = await adTargetConnector.write(config, createOp('action-4', 'dee.olsen'));
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain('adopted');
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=dee.olsen)',
      attributes: ['dn'],
    });
    expect(searchEntries).toHaveLength(1);
  });

  it('conflicts rather than adopting an account it did not create', async () => {
    await adTargetConnector.write(config, createOp('action-5', 'eve.stern'));
    const other = await adTargetConnector.write(
      config,
      createOp('a-different-action', 'eve.stern'),
    );
    expect(other.ok).toBe(false);
    expect(other.failure).toBe('conflict');
  });

  it('classifies a duplicate sAMAccountName as a conflict, not a transient failure', async () => {
    await adTargetConnector.write(config, createOp('action-6', 'fay.brandt'));
    const clash = await adTargetConnector.write(config, {
      ...createOp('action-7', 'fay.brandt'),
      attributes: {
        ...createOp('action-7', 'fay.brandt').attributes,
        distinguishedName: [`CN=fay brandt two,${testOu}`],
      },
    });
    // A duplicate name does not become true on the fourth attempt.
    expect(clash.failure).toBe('conflict');
  });
});

describe('adTargetConnector — the account lifecycle', () => {
  const anchorFor = async (actionId: string, key: string) => {
    const result = await adTargetConnector.write(config, createOp(actionId, key));
    return result.anchor!;
  };

  it('disables and writes the reason into info, preserving other flags', async () => {
    const anchor = await anchorFor('life-1', 'gil.hart');
    const result = await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-1-d',
      anchor,
      reason: 'contract ended 2026-06-15',
    });
    expect(result.ok).toBe(true);
    expect(await readUac(`CN=gil.hart,${testOu}`)).toBe(514);
    const { searchEntries } = await admin.search(`CN=gil.hart,${testOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['info'],
    });
    expect(String(searchEntries[0]!.info)).toContain('contract ended 2026-06-15');
  });

  it('is idempotent: disabling twice leaves the same state', async () => {
    const anchor = await anchorFor('life-2', 'hal.reyes');
    const op = {
      op: 'disable_account' as const,
      actionId: 'life-2-d',
      anchor,
      reason: 'left',
    };
    await adTargetConnector.write(config, op);
    const second = await adTargetConnector.write(config, op);
    expect(second.ok).toBe(true);
    expect(await readUac(`CN=hal.reyes,${testOu}`)).toBe(514);
  });

  it('enables a disabled account', async () => {
    const anchor = await anchorFor('life-3', 'ida.wolf');
    await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-3-d',
      anchor,
      reason: 'left',
    });
    await adTargetConnector.write(config, {
      op: 'enable_account',
      actionId: 'life-3-e',
      anchor,
    });
    expect(await readUac(`CN=ida.wolf,${testOu}`)).toBe(512);
  });

  it('moves the account between containers without changing the anchor', async () => {
    const anchor = await anchorFor('life-4', 'jan.kovac');
    const subOu = `OU=Facilities,${testOu}`;
    await admin.add(subOu, { objectClass: ['top', 'organizationalUnit'] });

    const result = await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-4-u',
      anchor,
      attributes: {
        displayName: ['Jan Kovac'],
        distinguishedName: [`CN=jan.kovac,${subOu}`],
      },
    });
    expect(result.ok).toBe(true);

    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=jan.kovac)',
      attributes: ['objectGUID', 'distinguishedName'],
    });
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=jan.kovac,${subOu}`);
    // The anchor is unchanged, which is the whole point of anchoring on
    // objectGUID rather than the DN.
    const found = [];
    for await (const record of adTargetConnector.read(config)) found.push(record);
    expect(found.some((r) => r.anchor === anchor)).toBe(true);
  });

  it('archives by moving to the archive container and stripping only the managed groups', async () => {
    const anchor = await anchorFor('life-5', 'kit.oduya');
    for (const [cn, sam] of [
      ['Finance', 'FinanceArch'],
      ['Sports Club', 'SportsClubArch'],
    ] as const) {
      await admin.add(`CN=${cn},${groupsOu}`, {
        objectClass: ['top', 'group'],
        sAMAccountName: sam,
      });
    }
    const groups = [];
    for await (const e of adTargetConnector.listEntitlements(config)) groups.push(e);
    const managed = groups.find((g) => g.displayName === 'Finance')!;
    const unmanaged = groups.find((g) => g.displayName === 'Sports Club')!;

    for (const group of [managed, unmanaged]) {
      await adTargetConnector.write(config, {
        op: 'grant_entitlement',
        actionId: `life-5-g-${group.displayName}`,
        anchor,
        entitlementId: group.externalId,
      });
    }

    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-5-a',
      // ONLY the entitlements Provision manages for this account. Iterating
      // the object's own memberOf instead would strip every group it holds,
      // which asserts that Provision manages every group in the target --
      // never true (spec section 12) -- on the one step spec section 9 calls
      // the closest thing to destructive in the ladder.
      entitlementDns: [managed.dn],
    });
    expect(result.ok).toBe(true);

    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=kit.oduya)',
      attributes: ['dn'],
    });
    // The object, its mailbox and its file ownership are intact -- it moved.
    expect(searchEntries).toHaveLength(1);

    const stripped = await admin.search(managed.dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(stripped.searchEntries[0]!.member ?? '')).not.toContain('kit.oduya');

    const untouched = await admin.search(unmanaged.dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(untouched.searchEntries[0]!.member ?? '')).toContain('kit.oduya');
  });

  it('fails an archive whose membership removal did not succeed, rather than reporting it done', async () => {
    // The removal is against a group that no longer exists, so the modify
    // fails. Swallowing it would report a successful archive over an account
    // that still holds the access the archive was supposed to strip -- and
    // nothing would ever retry, because the action is recorded as applied.
    const anchor = await anchorFor('life-6', 'lou.marek');
    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-6-a',
      anchor,
      entitlementDns: [`CN=Vanished,${groupsOu}`],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/membership/i);

    // And it did NOT move: the archive is retried whole rather than half-done.
    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=lou.marek)',
      attributes: ['dn'],
    });
    expect(searchEntries).toHaveLength(0);
  });

  it('has no delete operation to call', async () => {
    // Not disabled, not configuration-gated: absent, so that no configuration
    // mistake can produce one.
    //
    // `await expect(...)`, not a bare `expect(promise)`: without the await the
    // assertion never runs, the loop creates three unhandled rejections, and
    // the test passes whatever the connector does.
    const ops = ['delete_account', 'purge_account', 'destroy_account'];
    for (const op of ops) {
      await expect(
        adTargetConnector.write(config, { op, actionId: 'x', anchor: 'a' } as never),
      ).resolves.toMatchObject({ ok: false, failure: 'rejected' });
    }
  });
});

describe('adTargetConnector — entitlements', () => {
  const setup = async () => {
    const created = await adTargetConnector.write(config, createOp('ent-1', 'lee.tran'));
    await admin.add(`CN=Payments,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'Payments',
    });
    const groups = [];
    for await (const e of adTargetConnector.listEntitlements(config)) groups.push(e);
    return { anchor: created.anchor!, entitlementId: groups[0]!.externalId };
  };

  it('grants and revokes a single value on member, never replacing the attribute', async () => {
    const { anchor, entitlementId } = await setup();
    expect(
      (
        await adTargetConnector.write(config, {
          op: 'grant_entitlement',
          actionId: 'g-1',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);

    const { searchEntries } = await admin.search(`CN=Payments,${groupsOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(searchEntries[0]!.member)).toContain('lee.tran');

    expect(
      (
        await adTargetConnector.write(config, {
          op: 'revoke_entitlement',
          actionId: 'r-1',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);
  });

  it('treats a grant of a held entitlement as a success', async () => {
    const { anchor, entitlementId } = await setup();
    const op = {
      op: 'grant_entitlement' as const,
      actionId: 'g-2',
      anchor,
      entitlementId,
    };
    await adTargetConnector.write(config, op);
    expect((await adTargetConnector.write(config, op)).ok).toBe(true);
  });

  it('treats a revoke of an unheld entitlement as a success', async () => {
    const { anchor, entitlementId } = await setup();
    expect(
      (
        await adTargetConnector.write(config, {
          op: 'revoke_entitlement',
          actionId: 'r-2',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);
  });

  it('rejects an attempt to revoke a configured primary group rather than trying it', async () => {
    const { anchor, entitlementId } = await setup();
    const result = await adTargetConnector.write(
      { ...config, primaryGroupExternalIds: [entitlementId] },
      { op: 'revoke_entitlement', actionId: 'r-3', anchor, entitlementId },
    );
    // Primary group membership is not in `member` and cannot be removed by
    // writing to it. Attempted, it would fail forever.
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('rejected');
    expect(result.message).toContain('primary group');
  });
});

describe('adTargetConnector — read', () => {
  it('returns the account with its anchor, status and memberships', async () => {
    const created = await adTargetConnector.write(config, createOp('read-1', 'mia.reid'));
    const records = [];
    for await (const record of adTargetConnector.read(config)) records.push(record);
    const found = records.find((r) => r.anchor === created.anchor)!;
    expect(found.attributes.sAMAccountName).toEqual(['mia.reid']);
    expect(found.attributes.userAccountControl).toEqual(['512']);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm vitest run packages/connectors/src/ad/connector.integration.test.ts`
Expected: FAIL — cannot find module `./connector.js`.

- [ ] **Step 7: Write the Active Directory target connector**

`packages/connectors/src/ad/connector.ts`:

```ts
import { Client } from 'ldapts';
import { normaliseAnchor } from '../ldap/anchor.js';
import { RANGE_STEP, readRangedAttribute } from '../ldap/range.js';
import { CONNECTOR_ACTION_TYPES } from '../types.js';
import type {
  ConnectionResult,
  ConnectorRight,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteFailure,
  WriteOperation,
  WriteResult,
} from '../types.js';
import {
  adTargetConfigSchema,
  type AdTargetConfig,
  type ResolvedAdTargetConfig,
} from './config.js';
import {
  UAC_NORMAL_DISABLED,
  UAC_NORMAL_ENABLED,
  withDisableBit,
  withoutDisableBit,
} from './uac.js';

type Config = AdTargetConfig & { bindPassword: string };
type Resolved = ResolvedAdTargetConfig & { bindPassword: string };

function normalise(config: Config): Resolved {
  const { bindPassword, ...rest } = config;
  return { ...adTargetConfigSchema.parse(rest), bindPassword };
}

/**
 * Opens a connection, secures it, and binds. StartTLS runs before the bind and
 * that order is not negotiable: the bind carries the password.
 *
 * Unlike the directory-source connector there is no plaintext path at all.
 * Active Directory refuses a password write over an unencrypted connection,
 * and the Samba container the integration tests run against refuses even an
 * ordinary bind without TLS.
 */
async function connect(config: Resolved): Promise<Client> {
  const tlsOptions = { rejectUnauthorized: config.rejectUnauthorized };
  // ldapts treats the mere presence of `tlsOptions` as a request for implicit
  // TLS, independent of the URL scheme, so it is only passed for `ldaps`; a
  // `starttls` connection starts plaintext and takes its options from
  // startTLS() below.
  const client = new Client({
    url: config.url,
    connectTimeout: config.connectTimeoutMs,
    timeout: config.timeoutMs,
    ...(config.tlsMode === 'ldaps' ? { tlsOptions } : {}),
  });
  try {
    if (config.tlsMode === 'starttls') await client.startTLS(tlsOptions);
    await client.bind(config.bindDn, config.bindPassword);
  } catch (cause) {
    // A rejected bind throws without ldapts destroying the socket underneath
    // it, which would otherwise leak a live socket per failed bind.
    await client.unbind().catch(() => undefined);
    throw cause;
  }
  return client;
}

/**
 * Turns an ldapts error into the closed failure set.
 *
 * This classification is the whole reason `failure` is decided by the
 * connector rather than pattern-matched by the run: only here is it known that
 * `busy` is worth another attempt and `entryAlreadyExists` never is.
 */
export function classifyLdapError(cause: unknown): WriteFailure {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();

  // ldapts puts the discriminating signal in `cause.name` -- the class name --
  // and not in the server's diagnostic message, which is why `name` is folded
  // into `text` above. Matching on the message alone misses every one of
  // these.
  if (
    text.includes('alreadyexists') ||
    text.includes('attributeorvalueexists') ||
    text.includes('already in use')
  ) {
    return 'conflict';
  }
  if (text.includes('nosuchattribute')) return 'not_found';
  if (text.includes('invalidcredentials') || text.includes('insufficientaccess'))
    return 'unauthorized';
  if (text.includes('strongauthrequired')) return 'unauthorized';
  if (text.includes('nosuchobject')) return 'not_found';
  if (text.includes('busy') || text.includes('unavailable') || text.includes('timeout'))
    return 'transient';
  if (text.includes('econnreset') || text.includes('econnrefused') || text.includes('etimedout'))
    return 'transient';
  if (text.includes('adminlimitexceeded')) return 'throttled';
  // A schema violation, a refused password complexity, a constraint violation.
  // None of them become true on the fourth attempt.
  return 'rejected';
}

/**
 * Active Directory requires the password UTF-16LE encoded and wrapped in
 * literal double quotes. This is also why the transport must be encrypted.
 */
export function encodeUnicodePwd(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

/**
 * Escapes a value for an LDAP filter, per RFC 4515.
 *
 * The correlation key reaching `findByCorrelationKey` is produced by
 * `generateCorrelationKey`, whose `[a-z0-9.-]` allow-list already makes an
 * injection impossible today -- but that is a property of a function in
 * another package, enforced by nobody at this boundary. A connector that
 * builds a filter must not depend on a caller two packages away staying
 * careful.
 */
export function escapeFilterValue(value: string): string {
  return [...value]
    .map((character) => {
      switch (character) {
        case '\\':
          return '\\5c';
        case '*':
          return '\\2a';
        case '(':
          return '\\28';
        case ')':
          return '\\29';
        case '\0':
          return '\\00';
        default:
          return character;
      }
    })
    .join('');
}

/**
 * The escaped binary form of an objectGUID, for a filter that finds one object
 * instead of reading the whole directory.
 *
 * The inverse of `normaliseAnchor`: Active Directory stores objectGUID as 16
 * raw bytes with the first three groups little-endian, and a filter has to
 * match those bytes rather than the rendered string. Returns undefined for
 * anything that is not a 32-hex-digit GUID -- a text `entryUUID`, a fixture
 * anchor -- and the caller falls back to the scan, so this is an optimisation
 * that cannot become a correctness bug.
 */
function guidFilterValue(anchor: string): string | undefined {
  const hex = anchor.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const ordered = [
    ...bytes.slice(0, 4).reverse(),
    ...bytes.slice(4, 6).reverse(),
    ...bytes.slice(6, 8).reverse(),
    ...bytes.slice(8, 16),
  ];
  return ordered.map((b) => `\\${b.toString(16).padStart(2, '0')}`).join('');
}

function attributeOf(entry: Record<string, unknown>, name: string): string | undefined {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const value = entry[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? undefined : String(first);
}

function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/** Only what any write path reads. `['*']` pulls every attribute of every user. */
function writeAttributes(config: Resolved): string[] {
  return [
    'dn',
    'userAccountControl',
    'sAMAccountName',
    config.provenanceAttribute,
    config.anchorAttribute,
  ];
}

async function findByAnchor(
  client: Client,
  config: Resolved,
  anchor: string,
): Promise<{ dn: string; entry: Record<string, unknown> } | undefined> {
  // A scoped filter first. Every non-create write resolves an anchor, so the
  // fallback below is a full subtree read of every user with every attribute,
  // once per action: a 500-action apply performs 500 full directory reads.
  const scoped = guidFilterValue(anchor);
  if (scoped !== undefined && config.anchorAttribute.toLowerCase() === 'objectguid') {
    const { searchEntries } = await client.search(config.baseDn, {
      scope: 'sub',
      filter: `(&${config.accountFilter}(objectGUID=${scoped}))`,
      attributes: writeAttributes(config),
    });
    const raw = searchEntries[0] as unknown as Record<string, unknown> | undefined;
    if (raw) return { dn: String(raw.dn), entry: raw };
    // Deliberately falls through rather than returning `not_found`. If the
    // byte ordering above is ever wrong, the scan finds the object anyway and
    // the cost is a slow apply, not a run that reports every account missing.
  }

  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter: config.accountFilter,
    attributes: writeAttributes(config),
    paged: { pageSize: config.pageSize },
  });
  for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
    const value = raw[config.anchorAttribute];
    const source = Array.isArray(value) ? value[0] : value;
    if (source === undefined || source === null) continue;
    const normalised = normaliseAnchor(
      config.anchorAttribute,
      Buffer.isBuffer(source) ? source : String(source),
    );
    if (normalised === anchor) return { dn: String(raw.dn), entry: raw };
  }
  return undefined;
}

async function findByCorrelationKey(
  client: Client,
  config: Resolved,
  correlationKey: string,
): Promise<{ dn: string; entry: Record<string, unknown> } | undefined> {
  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter: `(sAMAccountName=${escapeFilterValue(correlationKey)})`,
    attributes: writeAttributes(config),
  });
  const raw = searchEntries[0] as unknown as Record<string, unknown> | undefined;
  return raw ? { dn: String(raw.dn), entry: raw } : undefined;
}

function anchorOf(config: Resolved, entry: Record<string, unknown>): string {
  const value = entry[config.anchorAttribute];
  const source = Array.isArray(value) ? value[0] : value;
  return normaliseAnchor(
    config.anchorAttribute,
    Buffer.isBuffer(source) ? source : String(source ?? ''),
  );
}

/** The provenance value written into the configured attribute on a create. */
function provenanceValue(actionId: string): string {
  return `syntra-provision action=${actionId}`;
}

async function createAccount(
  client: Client,
  config: Resolved,
  op: Extract<WriteOperation, { op: 'create_account' }>,
): Promise<WriteResult> {
  // The provenance marker makes a non-idempotent create safe to retry.
  const existing = await findByCorrelationKey(client, config, op.correlationKey);
  if (existing) {
    const marker = attributeOf(existing.entry, config.provenanceAttribute) ?? '';
    if (marker.includes(op.actionId)) {
      // Our own previous attempt succeeded and we lost the answer.
      return {
        ok: true,
        message: 'adopted the account this action already created',
        anchor: anchorOf(config, existing.entry),
      };
    }
    // Somebody else's account with our chosen name. Never adopted: anybody
    // able to create an object in the target could otherwise choose a name
    // that causes Syntra to hand them an existing person's account.
    return {
      ok: false,
      message: `an account named ${op.correlationKey} already exists in the target and does not carry this action's provenance marker`,
      failure: 'conflict',
    };
  }

  const dn =
    op.attributes.distinguishedName?.[0] ?? `CN=${op.correlationKey},${config.baseDn}`;

  try {
    // Step 1: add the object, disabled. An account that exists and is enabled
    // before its password is set is a window nobody asked for.
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: op.correlationKey,
      userAccountControl: String(UAC_NORMAL_DISABLED),
      [config.provenanceAttribute]: provenanceValue(op.actionId),
      ...Object.fromEntries(
        Object.entries(op.attributes).filter(([key]) => key !== 'distinguishedName'),
      ),
    });
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      failure: classifyLdapError(cause),
    };
  }

  const found = await findByCorrelationKey(client, config, op.correlationKey);
  const anchor = found ? anchorOf(config, found.entry) : undefined;

  try {
    // Step 2: the password, UTF-16LE and quote-wrapped. This is why the
    // transport must be encrypted.
    //
    // `op.initialPassword`, never one generated here. A password invented
    // inside the connector is written to the directory and then dropped:
    // nothing carries it back out, so it can never be sealed into the vault or
    // delivered, and no account Provision creates is usable by the person it
    // was created for. The caller owns it (Task 14).
    await client.modify(dn, [
      {
        operation: 'replace',
        modification: {
          type: 'unicodePwd',
          values: [encodeUnicodePwd(op.initialPassword)],
        },
      },
    ] as never);
  } catch (cause) {
    // The account exists and is unusable and disabled, which is the right way
    // round to fail. The next run sees an account carrying this action's
    // provenance marker, adopts it, and proposes the remaining steps.
    return {
      ok: false,
      message: `the account was created but its password could not be set: ${cause instanceof Error ? cause.message : String(cause)}`,
      failure: classifyLdapError(cause),
      ...(anchor === undefined ? {} : { anchor }),
    };
  }

  if (op.enabled) {
    try {
      // Step 3, only if the account is meant to be enabled now. A pre-hire
      // stops after step 2 and is enabled on its start date.
      await client.modify(dn, [
        {
          operation: 'replace',
          modification: {
            type: 'userAccountControl',
            values: [String(UAC_NORMAL_ENABLED)],
          },
        },
      ] as never);
    } catch (cause) {
      return {
        ok: false,
        message: `the account was created and its password set, but it could not be enabled: ${cause instanceof Error ? cause.message : String(cause)}`,
        failure: classifyLdapError(cause),
        ...(anchor === undefined ? {} : { anchor }),
      };
    }
  }

  return {
    ok: true,
    message: `created ${op.correlationKey}`,
    ...(anchor === undefined ? {} : { anchor }),
  };
}

async function setDisableBit(
  client: Client,
  dn: string,
  entry: Record<string, unknown>,
  disabled: boolean,
  extra?: { attribute: string; value: string },
): Promise<void> {
  const current = Number(attributeOf(entry, 'userAccountControl') ?? UAC_NORMAL_ENABLED);
  const next = disabled ? withDisableBit(current) : withoutDisableBit(current);
  const changes: unknown[] = [
    {
      operation: 'replace',
      modification: { type: 'userAccountControl', values: [String(next)] },
    },
  ];
  if (extra) {
    changes.push({
      operation: 'replace',
      modification: { type: extra.attribute, values: [extra.value] },
    });
  }
  await client.modify(dn, changes as never);
}

/**
 * The DN of a group, by objectGUID.
 *
 * A paged search of `entitlementSearchBase` per grant or revoke. Deliberately
 * left as a scan where `findByAnchor` was narrowed: the entitlement search base
 * holds groups rather than the whole user population, so this is a much
 * smaller read, and narrowing it needs the same escaped-binary GUID filter
 * with the same fallback. Recorded as a known cost rather than optimised on
 * speculation -- if a domain's group count makes it hurt, the fix is
 * `guidFilterValue` here too, with the scan kept behind it.
 */
async function groupDnFor(
  client: Client,
  config: Resolved,
  externalId: string,
): Promise<string | undefined> {
  const { searchEntries } = await client.search(config.entitlementSearchBase, {
    scope: 'sub',
    filter: config.groupFilter,
    attributes: ['dn', config.anchorAttribute],
    paged: { pageSize: config.pageSize },
  });
  for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
    if (anchorOf(config, raw) === externalId) return String(raw.dn);
  }
  return undefined;
}

/**
 * Reads one constructed attribute and reports whether it says a right is held.
 *
 * Three outcomes, and the third is the point. The attribute absent from the
 * response means the server does not publish effective rights, which is NOT
 * the same as the right being granted and must never be reported as one.
 */
async function effectiveRight(
  client: Client,
  right: ConnectorRight['right'],
  dn: string | undefined,
  attribute: 'allowedChildClassesEffective' | 'allowedAttributesEffective',
  wanted: string,
  absentDetail: string,
): Promise<ConnectorRight> {
  if (dn === undefined) {
    return { right, status: 'unverified', detail: absentDetail };
  }
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [attribute],
    });
    const entry = (searchEntries[0] ?? {}) as Record<string, unknown>;
    const key = Object.keys(entry).find(
      (k) => k.toLowerCase() === attribute.toLowerCase(),
    );
    if (key === undefined) {
      return {
        right,
        status: 'unverified',
        detail: `${dn} did not return ${attribute}; this server does not publish effective rights`,
      };
    }
    const held = toArray(entry[key]).some(
      (value) => value.toLowerCase() === wanted.toLowerCase(),
    );
    return {
      right,
      status: held ? 'granted' : 'denied',
      detail: held
        ? `${wanted} is in ${attribute} on ${dn}`
        : `${wanted} is NOT in ${attribute} on ${dn}; this bind cannot perform this operation and the first apply that needs it will fail`,
    };
  } catch (cause) {
    return {
      right,
      status: 'unverified',
      detail: `could not read ${attribute} on ${dn}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

export const adTargetConnector: TargetConnector<Config> = {
  async test(rawConfig): Promise<ConnectionResult> {
    const config = normalise(rawConfig);
    let client: Client | undefined;
    try {
      client = await connect(config);
      const accounts = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        attributes: ['dn'],
      });
      const groups = await client.search(config.entitlementSearchBase, {
        scope: 'sub',
        filter: config.groupFilter,
        attributes: ['dn'],
      });

      // Spec section 18: the bind should hold only the rights it needs, and
      // `test` reports which of those it could not exercise, so an
      // over-privileged bind is a visible choice rather than a default.
      //
      // Read, never exercised. Actually performing a create to prove the right
      // would leave a probe object behind, and there is no delete on this
      // connector to remove it -- by design. Active Directory publishes
      // `allowedChildClassesEffective` and `allowedAttributesEffective` as
      // constructed attributes for exactly this question.
      const firstAccount = accounts.searchEntries[0]?.dn;
      const firstGroup = groups.searchEntries[0]?.dn;
      const rights: ConnectorRight[] = [
        await effectiveRight(
          client,
          'createUser',
          config.baseDn,
          'allowedChildClassesEffective',
          'user',
          'no base DN to read',
        ),
        await effectiveRight(
          client,
          'moveUser',
          config.archiveContainer,
          'allowedChildClassesEffective',
          'user',
          'no archive container configured',
        ),
        await effectiveRight(
          client,
          'modifyUser',
          firstAccount === undefined ? undefined : String(firstAccount),
          'allowedAttributesEffective',
          'userAccountControl',
          'this target holds no account yet, so there is nothing to read effective rights from; the first create will be the first test of this right',
        ),
        await effectiveRight(
          client,
          'modifyMembership',
          firstGroup === undefined ? undefined : String(firstGroup),
          'allowedAttributesEffective',
          'member',
          'this target offers no group yet, so there is nothing to read effective rights from',
        ),
      ];

      const notHeld = rights.filter((r) => r.status !== 'granted');
      return {
        ok: true,
        message:
          notHeld.length === 0
            ? `Connected to ${config.url}; all four write rights confirmed`
            : `Connected to ${config.url}; ${notHeld.length} of 4 write rights not confirmed: ${notHeld
                .map((r) => `${r.right} (${r.status})`)
                .join(', ')}`,
        sampleCounts: {
          user: accounts.searchEntries.length,
          group: groups.searchEntries.length,
          orgUnit: 0,
        },
        rights,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Connection failed',
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        sizeLimit: 20,
        attributes: ['*', '+'],
      });
      const objectClasses = new Set<string>();
      const attributes = new Set<string>();
      for (const entry of searchEntries as unknown as Record<string, unknown>[]) {
        for (const cls of toArray(entry.objectClass)) objectClasses.add(cls);
        for (const key of Object.keys(entry)) {
          if (key !== 'dn' && key !== '*' && key !== '+') attributes.add(key);
        }
      }
      return {
        objectClasses: [...objectClasses].sort(),
        attributes: [...attributes].sort(),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *read(rawConfig): AsyncIterable<SourceRecord> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        paged: { pageSize: config.pageSize },
        attributes: ['*', config.anchorAttribute],
      });
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const attributes: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (key === 'dn' || key === config.anchorAttribute) continue;
          attributes[key] = toArray(value);
        }
        yield {
          anchor: anchorOf(config, raw),
          objectType: 'user',
          dn: String(raw.dn),
          attributes,
        };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *listEntitlements(rawConfig): AsyncIterable<DiscoveredEntitlement> {
    const config = normalise(rawConfig);
    const excluded = new Set(config.primaryGroupExternalIds);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.entitlementSearchBase, {
        scope: 'sub',
        filter: config.groupFilter,
        paged: { pageSize: config.pageSize },
        attributes: ['dn', 'cn', 'description', config.anchorAttribute],
      });
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const externalId = anchorOf(config, raw);
        // Primary group membership is not in `member` and cannot be removed by
        // writing to it, so the primary group is kept out of the catalog
        // entirely rather than being offered and then failing forever.
        if (excluded.has(externalId)) continue;
        const description = attributeOf(raw, 'description');
        yield {
          externalId,
          // The identity is the objectGUID; this is where the group currently
          // lives. Both are needed: a user's `memberOf` is a list of DNs, so
          // without this there is nothing to map a membership onto.
          dn: String(raw.dn),
          type: 'group',
          displayName: attributeOf(raw, 'cn') ?? externalId,
          ...(description === undefined ? {} : { description }),
        };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *listContainers(rawConfig): AsyncIterable<{ dn: string }> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        // Both classes: Active Directory's built-in `CN=Users` is a
        // `container`, not an `organizationalUnit`, and a profile whose
        // fallback points there is a perfectly ordinary configuration.
        filter: '(|(objectClass=organizationalUnit)(objectClass=container))',
        paged: { pageSize: config.pageSize },
        attributes: ['dn'],
      });
      // The search base itself is a valid place to put an account and is not
      // returned by a subtree search for those two classes when it is a
      // domain object, so it is yielded explicitly.
      yield { dn: config.baseDn };
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const dn = String(raw.dn);
        if (dn.toLowerCase() === config.baseDn.toLowerCase()) continue;
        yield { dn };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async write(rawConfig, op): Promise<WriteResult> {
    const config = normalise(rawConfig);

    // Refused BEFORE the bind, before the anchor is resolved, before anything.
    //
    // There is no delete operation to call, and this is what makes that true
    // of the code and not only of the type. With the check further down, an
    // operation this connector does not implement first reached
    // `findByAnchor` -- so `{ op: 'delete_account' }` with no anchor answered
    // `not_found`, which reads as "that object is gone" rather than "this
    // connector will not do that", and a caller could not tell them apart.
    if (!(CONNECTOR_ACTION_TYPES as readonly string[]).includes(op.op)) {
      return {
        ok: false,
        message: `"${String((op as { op: string }).op)}" is not an operation this connector implements; there is no delete of any kind`,
        failure: 'rejected',
      };
    }

    let client: Client | undefined;
    try {
      client = await connect(config);

      if (op.op === 'create_account') {
        return await createAccount(client, config, op);
      }

      const found = await findByAnchor(client, config, op.anchor);
      if (!found) {
        return {
          ok: false,
          message: `no object at anchor ${op.anchor}`,
          failure: 'not_found',
        };
      }

      switch (op.op) {
        case 'update_account': {
          const targetDn = op.attributes.distinguishedName?.[0];
          const rest = Object.entries(op.attributes).filter(
            ([key]) => key !== 'distinguishedName',
          );
          if (rest.length > 0) {
            // The complete managed set, written as `replace`. Receiving the
            // same update twice performs the same write twice and leaves the
            // same result, which is what makes retry free.
            await client.modify(
              found.dn,
              rest.map(([type, values]) => ({
                operation: 'replace',
                modification: { type, values },
              })) as never,
            );
          }
          if (targetDn && targetDn.toLowerCase() !== found.dn.toLowerCase()) {
            // ldapts's modifyDN(dn, fullNewDn) takes THE COMPLETE NEW DN as
            // its second argument -- NOT (dn, newRdn, newSuperior). The
            // three-argument call throws
            // `TypeError: control.write is not a function`, because the third
            // positional argument is treated as an LDAP control, which reads
            // as a library bug rather than a signature mistake. Confirmed by
            // hitting it during the Samba spike.
            await client.modifyDN(found.dn, targetDn);
          }
          return { ok: true, message: 'updated' };
        }
        case 'enable_account':
          await setDisableBit(client, found.dn, found.entry, false);
          return { ok: true, message: 'enabled' };
        case 'disable_account':
          await setDisableBit(client, found.dn, found.entry, true, {
            attribute: 'info',
            value: `[syntra] ${op.reason}`,
          });
          return { ok: true, message: 'disabled' };
        case 'archive_account': {
          // Moves the object, strips the entitlements PROVISION MANAGES for
          // it, and leaves the object, its mailbox and its file ownership
          // intact. It does not delete, and there is no code path here that
          // could.
          await setDisableBit(client, found.dn, found.entry, true);

          // `op.entitlementDns`, not `found.entry.memberOf`. Iterating the
          // object's own memberships removes EVERY group it holds, including
          // ones no business rule mentions -- which asserts "Provision manages
          // every group in this target", a claim spec section 12 says is never
          // true. Archive is the closest thing to destructive in the ladder
          // and is the last place to widen a remit.
          for (const groupDn of op.entitlementDns) {
            try {
              await client.modify(groupDn, [
                {
                  operation: 'delete',
                  modification: { type: 'member', values: [found.dn] },
                },
              ] as never);
            } catch (cause) {
              const name = cause instanceof Error ? cause.name : '';
              const text =
                `${name} ${cause instanceof Error ? cause.message : String(cause)}`.toLowerCase();
              // Already not a member. A set operation, and a success.
              if (
                text.includes('nosuchattribute') ||
                text.includes('no such attribute')
              ) {
                continue;
              }
              // NOT swallowed. `.catch(() => undefined)` here reported a
              // successful archive over an account that still holds the access
              // the archive existed to strip -- and because the action was
              // then recorded applied, nothing ever retried it. Returning
              // before the modifyDN leaves the account disabled and in place,
              // which is a state the next run recognises and repeats.
              return {
                ok: false,
                message: `the account was disabled, but its membership of ${groupDn} could not be removed, so it has not been moved to the archive container: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                failure: classifyLdapError(cause),
              };
            }
          }

          const rdn = found.dn.slice(0, found.dn.indexOf(','));
          await client.modifyDN(found.dn, `${rdn},${config.archiveContainer}`);
          return { ok: true, message: 'archived' };
        }
        case 'rename_account': {
          const rdn = `CN=${op.correlationKey}`;
          const container = found.dn.slice(found.dn.indexOf(',') + 1);
          await client.modify(found.dn, [
            {
              operation: 'replace',
              modification: { type: 'sAMAccountName', values: [op.correlationKey] },
            },
          ] as never);
          await client.modifyDN(found.dn, `${rdn},${container}`);
          return { ok: true, message: 'renamed' };
        }
        case 'grant_entitlement':
        case 'revoke_entitlement': {
          if (config.primaryGroupExternalIds.includes(op.entitlementId)) {
            return {
              ok: false,
              message:
                'this entitlement is the primary group: primary group membership is not held in `member` and cannot be changed by writing to it',
              failure: 'rejected',
            };
          }
          const groupDn = await groupDnFor(client, config, op.entitlementId);
          if (!groupDn) {
            return {
              ok: false,
              message: `no group at ${op.entitlementId}`,
              failure: 'not_found',
            };
          }
          try {
            // A single-value modification, never a replace of the whole
            // attribute: a replace turns a lost race into a mass revocation.
            await client.modify(groupDn, [
              {
                operation: op.op === 'grant_entitlement' ? 'add' : 'delete',
                modification: { type: 'member', values: [found.dn] },
              },
            ] as never);
          } catch (cause) {
            // Set operations: granting a held entitlement and revoking an
            // unheld one are both successes, not errors. That property is what
            // makes retry free for these two, everywhere.
            //
            // ldapts carries the discriminating signal in `cause.name` -- the
            // error class, `AttributeOrValueExistsError` and
            // `NoSuchAttributeError` -- and NOT in the server's diagnostic
            // message. Matching the message alone matches nothing: both cases
            // fall through to `classifyLdapError`'s `rejected` default and
            // become permanent, non-retryable failures.
            const name = cause instanceof Error ? cause.name : '';
            const text =
              `${name} ${cause instanceof Error ? cause.message : String(cause)}`.toLowerCase();
            if (
              (op.op === 'grant_entitlement' &&
                (text.includes('attributeorvalueexists') ||
                  text.includes('already exists'))) ||
              (op.op === 'revoke_entitlement' &&
                (text.includes('nosuchattribute') ||
                  text.includes('no such attribute')))
            ) {
              return { ok: true, message: 'already in the requested state' };
            }
            return {
              ok: false,
              message: cause instanceof Error ? `${name}: ${cause.message}` : String(cause),
              failure: classifyLdapError(cause),
            };
          }
          return { ok: true, message: op.op === 'grant_entitlement' ? 'granted' : 'revoked' };
        }
        default:
          // Unreachable: the guard at the top of `write` refuses anything not
          // in CONNECTOR_ACTION_TYPES before a connection is opened. Kept so
          // that adding a member to the union without handling it here is a
          // compile error rather than a silent fall-through.
          return {
            ok: false,
            message: 'unsupported operation on this connector',
            failure: 'rejected',
          };
      }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        failure: classifyLdapError(cause),
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },
};
```

There is no `generateInitialPassword` in this module, and no `node:crypto` import. An earlier draft had one — with a `require()` in an ESM file, which is a second defect on top of the first — and its output went to the directory and nowhere else. The password arrives on the operation.

`RANGE_STEP` and `readRangedAttribute` are imported for group membership reads that exceed the value-range limit. `readGroupMembers` below is what Task 13 phase 4 calls for every in-remit group: a group whose ranged read cannot finish is marked `unreadable`, and a rule naming it makes every person it would touch an exception rather than being silently evaluated against half a membership. Add it below `groupDnFor`:

```ts
/** Every member DN of a group, walking range windows when AD truncates. */
export async function readGroupMembers(
  rawConfig: Config,
  groupDn: string,
): Promise<string[]> {
  const config = normalise(rawConfig);
  const client = await connect(config);
  try {
    // Throws rather than returning what it managed to collect. The caller
    // marks the entitlement `unreadable`, and a rule naming an unreadable
    // entitlement is unresolvable as a whole -- which is loud, where a
    // silently short membership is a mass revocation.
    return await readRangedAttribute(client, groupDn, 'member', {
      pageStep: RANGE_STEP,
    });
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
```

and add it to the connector object itself, so the run can call it through whatever connector it was handed rather than importing the Active Directory one directly:

```ts
  async readEntitlementMembers(rawConfig, entitlementDn): Promise<string[]> {
    return readGroupMembers(rawConfig, entitlementDn);
  },
```

- [ ] **Step 8: Export the connector**

In `packages/connectors/src/index.ts`, append:

```ts
export * from './ad/uac.js';
export * from './ad/config.js';
export * from './ad/connector.js';
```

- [ ] **Step 9: Run the integration test against the container**

```bash
pnpm samba:up && pnpm samba:wait
pnpm vitest run packages/connectors/src/ad/connector.integration.test.ts
```

Expected: PASS.

If the run hangs before the first test, the container is not up — the wait script exits non-zero rather than letting vitest time out at 30 s per test.

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add the Active Directory target connector"
```

---

## Task 12: Target, profile, rule and entitlement storage

**Files:**
- Create: `packages/core/src/provision/target-service.ts`
- Create: `packages/core/src/provision/entitlement-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/target-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `type TenantClient` from `@syntra/db`; `currentTenant` from `../tenant-context.js`; `recordEvent` from `../audit/audit-service.js`; `putSecret`, `getSecret` from `../vault/vault-service.js`; `type MasterKeyProvider` from `../vault/master-key.js`; `adTargetConfigSchema`, `adTargetConnector`, `type DiscoveredEntitlement` from `@syntra/connectors`; `conditionSchema` from `./condition.js`.
- Produces:
  - `interface CreateTargetInput { name: string; type?: string; config: unknown; bindPassword: string; pairedDirectorySourceId?: string | null; schedule?: string | null; autoApply?: boolean; enabled?: boolean; enforcementMode?: 'additive' | 'authoritative' }`
  - `async function createTarget(tenantId: string, provider: MasterKeyProvider, actorUserId: string | null, input: CreateTargetInput): Promise<{ id: string }>`
  - `async function updateTarget(tenantId: string, provider: MasterKeyProvider, actorUserId: string | null, targetId: string, input: Partial<CreateTargetInput> & { thresholds?: Partial<GuardThresholds>; ladder?: Partial<LadderSettings>; preHireDays?: number; maxAttempts?: number; concurrency?: number }): Promise<void>`
  - `async function deleteTarget(tenantId: string, actorUserId: string | null, targetId: string, confirm: boolean): Promise<{ ok: boolean; counts?: Record<string, number> }>`
  - `async function targetWithCredential(tx: TenantClient, provider: MasterKeyProvider, targetId: string): Promise<(AdTargetConfig & { bindPassword: string }) | null>`
  - `async function testTargetConfiguration(tenantId: string, provider: MasterKeyProvider, input: { config: unknown; bindPassword?: string; borrowFromTargetId?: string }): Promise<ConnectionResult>`
  - `async function upsertAccountProfile(tenantId: string, actorUserId: string | null, targetId: string, input: AccountProfileInput): Promise<void>`
  - `async function upsertBusinessRule(tenantId: string, actorUserId: string | null, targetId: string, input: BusinessRuleInput): Promise<{ id: string }>`
  - `async function deleteBusinessRule(tenantId: string, actorUserId: string | null, ruleId: string): Promise<void>`
  - `async function refreshEntitlements(tenantId: string, provider: MasterKeyProvider, actorUserId: string | null, targetId: string): Promise<{ present: number; missing: number }>` (in `entitlement-service.ts`)
  - `async function remitFor(tx: TenantClient, targetId: string): Promise<Set<string>>` (in `entitlement-service.ts`)

There is deliberately **no** `holderCounts` helper grouping `AccountEntitlement` rows. Spec section 11 says the per-entitlement guard's denominator is "that entitlement's own current holder count" — at the target. Syntra's own count measures what Provision believes it granted, and on a target it has not applied to yet, or one whose inventory has come apart, every count is zero; the guard then skips every entitlement and the second axis protects nothing on exactly the runs it exists for. Task 13 builds the denominator from the reconciled target inventory and writes it onto `Entitlement.holderCount` as it goes.

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/target-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `localMasterKeyProvider`, which is what packages/core/src/vault/master-key.ts
// actually exports. There is no `staticMasterKeyProvider`; the existing
// `auth/authorize.test.ts` and `auth/mfa/totp.test.ts` both import this one.
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  deleteTarget,
  targetWithCredential,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const create = () =>
  createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'super-secret',
  });

describe('createTarget', () => {
  it('stores the credential in the vault and never on the row', async () => {
    const { id } = await create();
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(JSON.stringify(row)).not.toContain('super-secret');
    expect(row.secretName).toBe(`target/${id}/bind`);
  });

  it('audits the creation in the same transaction', async () => {
    const { id } = await create();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.create' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(id);
    // Lowering a threshold is functionally the same as approving everything it
    // would otherwise have caught, so configuration changes are privileged.
    expect(JSON.stringify(events[0]!.payload)).not.toContain('super-secret');
  });

  it('refuses a target configured to write in the clear', async () => {
    await expect(
      createTarget(tenantId, provider, null, {
        name: 'Plain',
        config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('updateTarget', () => {
  it('validates the ladder ordering before writing', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        ladder: { entitlementRevocationDelayDays: 14, disableGraceDays: 3 },
      }),
    ).rejects.toThrow(/entitlement revocations cannot be delayed past the disable/);
  });

  it('validates that archive falls strictly after disable', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        ladder: { disableGraceDays: 30, archiveAfterDays: 30 },
      }),
    ).rejects.toThrow(/archive must fall strictly after the disable/);
  });

  it('accepts a valid ladder and audits it', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: {
        entitlementRevocationDelayDays: 0,
        disableGraceDays: 7,
        archiveAfterDays: 90,
      },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.disableGraceDays).toBe(7);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('records the enforcement mode change explicitly', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      enforcementMode: 'authoritative',
    });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' } }),
    );
    expect(events[0]!.payload).toMatchObject({
      enforcementMode: { from: 'additive', to: 'authoritative' },
    });
  });

  it('replaces the vault entry when a new bind password is supplied', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, { bindPassword: 'rotated' });
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.bindPassword).toBe('rotated');
  });
});

describe('targetWithCredential', () => {
  it('returns the configuration with the credential attached', async () => {
    const { id } = await create();
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.bindPassword).toBe('super-secret');
    expect(loaded?.baseDn).toBe('OU=Users,DC=acme,DC=test');
  });

  it('returns null when the vault entry is gone', async () => {
    const { id } = await create();
    await withTenant(tenantId, (tx) => tx.secret.deleteMany({}));
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded).toBeNull();
  });
});

describe('deleteTarget', () => {
  it('refuses without confirmation and reports what it holds', async () => {
    const { id } = await create();
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: id,
          personId: person.id,
          correlationKey: 'anna.novak',
        },
      });
    });
    const result = await deleteTarget(tenantId, null, id, false);
    expect(result).toEqual({ ok: false, counts: { accounts: 1, rules: 0, entitlements: 0 } });
  });

  it('deletes with confirmation and audits it', async () => {
    const { id } = await create();
    expect(await deleteTarget(tenantId, null, id, true)).toEqual({ ok: true });
    const rows = await withTenant(tenantId, (tx) => tx.targetSystem.findMany());
    expect(rows).toEqual([]);
  });

  it('deletes a target that still holds an account and a live entitlement holding', async () => {
    // The only interesting delete. With `AccountEntitlement.entitlement` on
    // Restrict, PostgreSQL checks it immediately and this fails with a
    // foreign-key violation -- so the confirmable delete the API offers could
    // never succeed on any target anybody had actually used. The test above
    // passes because it deletes an empty target, which is not a case that
    // occurs.
    const { id } = await create();
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: id,
          externalId: 'guid-1',
          dn: 'CN=Finance,OU=Groups,DC=acme,DC=test',
          type: 'group',
          displayName: 'Finance',
        },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: id,
          personId: person.id,
          correlationKey: 'anna.novak',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId: entitlement.id,
          origin: 'rule',
        },
      });
    });

    expect(await deleteTarget(tenantId, null, id, true)).toEqual({ ok: true });
    // Syntra's record of the accounts is gone. The accounts themselves, in the
    // target, were never touched -- Provision has no delete.
    expect(
      await withTenant(tenantId, (tx) => tx.targetAccount.count()),
    ).toBe(0);
    expect(
      await withTenant(tenantId, (tx) => tx.accountEntitlement.count()),
    ).toBe(0);
  });
});

describe('upsertAccountProfile', () => {
  it('stores the templates and audits the change', async () => {
    const { id } = await create();
    await upsertAccountProfile(tenantId, null, id, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      maxUniquenessAttempts: 20,
      containerTemplate: 'OU=%contract.department%,%baseDn%',
      fallbackContainer: 'OU=Users,DC=acme,DC=test',
      attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
      initialPasswordPolicy: { length: 24 },
      initialPasswordDelivery: 'vaultOnly',
    });
    const profile = await withTenant(tenantId, (tx) =>
      tx.accountProfile.findFirstOrThrow({ where: { targetSystemId: id } }),
    );
    expect(profile.fallbackContainer).toBe('OU=Users,DC=acme,DC=test');
  });

  it('refuses a profile with no fallback container', async () => {
    const { id } = await create();
    await expect(
      upsertAccountProfile(tenantId, null, id, {
        correlationKeyTemplate: '%person.familyName%',
        maxUniquenessAttempts: 20,
        containerTemplate: 'OU=%contract.department%,%baseDn%',
        fallbackContainer: '',
        attributeTemplates: {},
        initialPasswordPolicy: {},
        initialPasswordDelivery: 'vaultOnly',
      }),
    ).rejects.toThrow();
  });
});

describe('upsertBusinessRule', () => {
  it('stores a validated condition and its entitlement join rows', async () => {
    const { id } = await create();
    const entitlementId = await withTenant(tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: id,
            externalId: 'guid-1',
            type: 'group',
            displayName: 'Finance',
          },
        })
      ).id,
    );
    const rule = await upsertBusinessRule(tenantId, null, id, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });
    const joins = await withTenant(tenantId, (tx) =>
      tx.ruleEntitlement.findMany({ where: { ruleId: rule.id } }),
    );
    expect(joins).toHaveLength(1);
  });

  it('refuses a condition outside the closed field and operator set', async () => {
    const { id } = await create();
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        name: 'Bad',
        condition: { field: 'contract.salary', op: 'greaterThan', value: 1 } as never,
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      }),
    ).rejects.toThrow();
  });

  it('refuses an entitlement belonging to a different target', async () => {
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    const foreign = await withTenant(tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: other.id,
            externalId: 'guid-2',
            type: 'group',
            displayName: 'Elsewhere',
          },
        })
      ).id,
    );
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        name: 'Cross target',
        condition: { all: [] },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [foreign],
      }),
    ).rejects.toThrow(/does not belong to this target/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/target-service.test.ts`
Expected: FAIL — cannot find module `./target-service.js`.

- [ ] **Step 3: Write the target service**

`packages/core/src/provision/target-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import {
  adTargetConfigSchema,
  adTargetConnector,
  type AdTargetConfig,
  type ConnectionResult,
} from '@syntra/connectors';
import { z } from 'zod';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { conditionSchema } from './condition.js';
import type { GuardThresholds } from './guard.js';
import type { LadderSettings } from './types.js';

const secretNameFor = (targetId: string) => `target/${targetId}/bind`;

export interface CreateTargetInput {
  name: string;
  type?: string;
  config: unknown;
  bindPassword: string;
  pairedDirectorySourceId?: string | null;
  schedule?: string | null;
  autoApply?: boolean;
  enabled?: boolean;
  enforcementMode?: 'additive' | 'authoritative';
}

/**
 * The seven threshold columns, named explicitly.
 *
 * `updateTarget` picks from this rather than spreading `input.thresholds` into
 * Prisma's `data`: a spread makes any extra key a Prisma error at run time
 * rather than a validation failure, and it turns the shape of the request body
 * into the shape of the write. Seven names in one place is also what makes the
 * correspondence with `GuardThresholds` and `thresholdsSchema` checkable by
 * reading.
 */
const THRESHOLD_FIELDS = [
  'createAccountThresholdPercent',
  'disableAccountThresholdPercent',
  'archiveAccountThresholdPercent',
  'revokeEntitlementThresholdPercent',
  'deactivateSyntraUserThresholdPercent',
  'perEntitlementThresholdPercent',
  'personPopulationDropPercent',
] as const;

function pickThresholds(
  thresholds: Partial<GuardThresholds> | undefined,
): Partial<Record<(typeof THRESHOLD_FIELDS)[number], number>> {
  if (thresholds === undefined) return {};
  const picked: Partial<Record<(typeof THRESHOLD_FIELDS)[number], number>> = {};
  for (const field of THRESHOLD_FIELDS) {
    const value = thresholds[field];
    if (typeof value === 'number') picked[field] = value;
  }
  return picked;
}

/**
 * Validates the ladder before it reaches the database.
 *
 * The CHECK constraint is the backstop; this is the message. An account whose
 * entitlements were stripped a week before it was disabled belongs to somebody
 * who is still employed as far as the directory is concerned and cannot do
 * anything.
 */
function assertLadder(ladder: {
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  archiveAfterDays: number | null;
}): void {
  if (ladder.entitlementRevocationDelayDays > ladder.disableGraceDays) {
    throw new Error(
      'entitlement revocations cannot be delayed past the disable: that describes an account whose holder is still employed as far as the directory is concerned and cannot do anything',
    );
  }
  if (
    ladder.archiveAfterDays !== null &&
    ladder.archiveAfterDays <= ladder.disableGraceDays
  ) {
    throw new Error(
      'the archive must fall strictly after the disable: archiving moves the object and strips its remaining entitlements',
    );
  }
}

export async function createTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  input: CreateTargetInput,
): Promise<{ id: string }> {
  // Parsed outside the transaction. A schema failure is a validation error,
  // not a rolled-back write.
  const config = adTargetConfigSchema.parse(input.config);

  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const target = await tx.targetSystem.create({
      data: {
        tenantId: bound,
        name: input.name,
        type: input.type ?? 'activeDirectory',
        config: config as never,
        // Replaced immediately below, once the id exists.
        secretName: 'pending',
        pairedDirectorySourceId: input.pairedDirectorySourceId ?? null,
        schedule: input.schedule ?? null,
        autoApply: input.autoApply ?? false,
        enabled: input.enabled ?? true,
        enforcementMode: input.enforcementMode ?? 'additive',
      },
    });

    const secretName = secretNameFor(target.id);
    await putSecret(tx, provider, secretName, input.bindPassword);
    await tx.targetSystem.update({ where: { id: target.id }, data: { secretName } });

    // The audit event and the mutation in one transaction.
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.create',
      targetType: 'TargetSystem',
      targetId: target.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: input.name,
        url: config.url,
        tlsMode: config.tlsMode,
        enforcementMode: input.enforcementMode ?? 'additive',
      },
    });

    return { id: target.id };
  });
}

export interface UpdateTargetInput extends Partial<CreateTargetInput> {
  thresholds?: Partial<GuardThresholds>;
  ladder?: Partial<LadderSettings>;
  preHireDays?: number;
  maxAttempts?: number;
  concurrency?: number;
}

export async function updateTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
  input: UpdateTargetInput,
): Promise<void> {
  const config =
    input.config === undefined ? undefined : adTargetConfigSchema.parse(input.config);

  await withTenant(tenantId, async (tx) => {
    const before = await tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } });

    const ladder = {
      entitlementRevocationDelayDays:
        input.ladder?.entitlementRevocationDelayDays ??
        before.entitlementRevocationDelayDays,
      disableGraceDays: input.ladder?.disableGraceDays ?? before.disableGraceDays,
      archiveAfterDays:
        input.ladder?.archiveAfterDays === undefined
          ? before.archiveAfterDays
          : input.ladder.archiveAfterDays,
    };
    assertLadder(ladder);

    await tx.targetSystem.update({
      where: { id: targetId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(config === undefined ? {} : { config: config as never }),
        ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
        ...(input.autoApply === undefined ? {} : { autoApply: input.autoApply }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.enforcementMode === undefined
          ? {}
          : { enforcementMode: input.enforcementMode }),
        ...(input.pairedDirectorySourceId === undefined
          ? {}
          : { pairedDirectorySourceId: input.pairedDirectorySourceId }),
        ...(input.preHireDays === undefined ? {} : { preHireDays: input.preHireDays }),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(input.ladder?.reenableWithoutConfirmationDays === undefined
          ? {}
          : {
              reenableWithoutConfirmationDays:
                input.ladder.reenableWithoutConfirmationDays,
            }),
        ...(input.ladder?.renameEnabled === undefined
          ? {}
          : { renameEnabled: input.ladder.renameEnabled }),
        entitlementRevocationDelayDays: ladder.entitlementRevocationDelayDays,
        disableGraceDays: ladder.disableGraceDays,
        archiveAfterDays: ladder.archiveAfterDays,
        // Seven named columns, never a spread of whatever arrived.
        ...pickThresholds(input.thresholds),
      },
    });

    if (input.bindPassword !== undefined) {
      await putSecret(tx, provider, secretNameFor(targetId), input.bindPassword);
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.update',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        ...(input.enforcementMode === undefined
          ? {}
          : {
              enforcementMode: {
                from: before.enforcementMode,
                to: input.enforcementMode,
              },
            }),
        ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
        ladder,
        credentialReplaced: input.bindPassword !== undefined,
      },
    });
  });
}

export async function deleteTarget(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  confirm: boolean,
): Promise<{ ok: boolean; counts?: Record<string, number> }> {
  return withTenant(tenantId, async (tx) => {
    const counts = {
      accounts: await tx.targetAccount.count({ where: { targetSystemId: targetId } }),
      rules: await tx.businessRule.count({ where: { targetSystemId: targetId } }),
      entitlements: await tx.entitlement.count({ where: { targetSystemId: targetId } }),
    };
    if (!confirm) return { ok: false, counts };

    await tx.targetSystem.delete({ where: { id: targetId } });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.delete',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: counts,
    });
    return { ok: true };
  });
}

/**
 * The configuration plus the bind credential, for the run to use *outside* any
 * transaction. Returns plain data, deliberately not a `tx` handle: nothing
 * downstream may hold one open across a target read.
 */
export async function targetWithCredential(
  tx: TenantClient,
  provider: MasterKeyProvider,
  targetId: string,
): Promise<(AdTargetConfig & { bindPassword: string }) | null> {
  const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
  if (!target) return null;
  const bindPassword = await getSecret(tx, provider, target.secretName);
  if (bindPassword === null) return null;
  return {
    ...(target.config as unknown as AdTargetConfig),
    bindPassword,
  };
}

/**
 * Tests a configuration, optionally borrowing a saved target's credential.
 *
 * Borrowing requires the transport — URL, TLS mode and certificate setting —
 * to match the saved target, so a test cannot be pointed at an
 * attacker-controlled socket to harvest the credential. This is the rule
 * Directory Sync arrived at after a security review, adopted here at the
 * start rather than after.
 */
export async function testTargetConfiguration(
  tenantId: string,
  provider: MasterKeyProvider,
  input: { config: unknown; bindPassword?: string; borrowFromTargetId?: string },
): Promise<ConnectionResult> {
  const config = adTargetConfigSchema.parse(input.config);

  let bindPassword = input.bindPassword;
  if (bindPassword === undefined) {
    if (input.borrowFromTargetId === undefined) {
      return { ok: false, message: 'no credential supplied and none to borrow' };
    }
    const saved = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUnique({
        where: { id: input.borrowFromTargetId },
      });
      if (!target) return null;
      const savedConfig = target.config as unknown as AdTargetConfig;
      if (
        savedConfig.url !== config.url ||
        savedConfig.tlsMode !== config.tlsMode ||
        (savedConfig.rejectUnauthorized ?? true) !== config.rejectUnauthorized
      ) {
        return 'mismatch' as const;
      }
      return getSecret(tx, provider, target.secretName);
    });
    if (saved === 'mismatch') {
      return {
        ok: false,
        message:
          'a saved credential can only be borrowed for the transport it was saved against: the URL, TLS mode and certificate setting must all match',
      };
    }
    if (saved === null) return { ok: false, message: 'no saved credential' };
    bindPassword = saved;
  }

  // Outside any transaction: this is a network call.
  return adTargetConnector.test({ ...config, bindPassword });
}

export const accountProfileSchema = z.object({
  correlationKeyTemplate: z.string().min(1),
  uniquenessStrategy: z.literal('numericSuffix').default('numericSuffix'),
  maxUniquenessAttempts: z.number().int().positive().max(200),
  containerTemplate: z.string().min(1),
  // Required: a template that resolves to nothing must land somewhere known,
  // and Provision does not create organizational units in somebody else's
  // domain.
  fallbackContainer: z.string().min(1),
  attributeTemplates: z.record(z.string()),
  initialPasswordPolicy: z.record(z.unknown()),
  initialPasswordDelivery: z.enum(['manager', 'personalEmail', 'vaultOnly']),
});
export type AccountProfileInput = z.input<typeof accountProfileSchema>;

export async function upsertAccountProfile(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  input: AccountProfileInput,
): Promise<void> {
  const profile = accountProfileSchema.parse(input);
  await withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const existing = await tx.accountProfile.findFirst({
      where: { targetSystemId: targetId },
    });
    if (existing) {
      await tx.accountProfile.update({
        where: { id: existing.id },
        data: { ...profile, attributeTemplates: profile.attributeTemplates as never,
          initialPasswordPolicy: profile.initialPasswordPolicy as never },
      });
    } else {
      await tx.accountProfile.create({
        data: {
          tenantId: bound,
          targetSystemId: targetId,
          ...profile,
          attributeTemplates: profile.attributeTemplates as never,
          initialPasswordPolicy: profile.initialPasswordPolicy as never,
        },
      });
    }
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.profile.upsert',
      targetType: 'AccountProfile',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        correlationKeyTemplate: profile.correlationKeyTemplate,
        containerTemplate: profile.containerTemplate,
        initialPasswordDelivery: profile.initialPasswordDelivery,
      },
    });
  });
}

export const businessRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  condition: conditionSchema,
  grantsAccount: z.boolean(),
  enabled: z.boolean(),
  entitlementIds: z.array(z.string().uuid()),
});
export type BusinessRuleInput = z.input<typeof businessRuleSchema>;

export async function upsertBusinessRule(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  input: BusinessRuleInput,
): Promise<{ id: string }> {
  const rule = businessRuleSchema.parse(input);
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);

    // An entitlement from another target would grant access somewhere this
    // rule does not describe.
    if (rule.entitlementIds.length > 0) {
      const owned = await tx.entitlement.count({
        where: { id: { in: rule.entitlementIds }, targetSystemId: targetId },
      });
      if (owned !== rule.entitlementIds.length) {
        throw new Error('an entitlement named by this rule does not belong to this target');
      }
    }

    const row = rule.id
      ? await tx.businessRule.update({
          where: { id: rule.id },
          data: {
            name: rule.name,
            description: rule.description ?? null,
            condition: rule.condition as never,
            grantsAccount: rule.grantsAccount,
            enabled: rule.enabled,
          },
        })
      : await tx.businessRule.create({
          data: {
            tenantId: bound,
            targetSystemId: targetId,
            name: rule.name,
            description: rule.description ?? null,
            condition: rule.condition as never,
            grantsAccount: rule.grantsAccount,
            enabled: rule.enabled,
          },
        });

    await tx.ruleEntitlement.deleteMany({ where: { ruleId: row.id } });
    for (const entitlementId of rule.entitlementIds) {
      await tx.ruleEntitlement.create({
        data: { tenantId: bound, ruleId: row.id, entitlementId },
      });
    }

    await recordEvent(tx, {
      actorUserId,
      action: rule.id ? 'provision.rule.update' : 'provision.rule.create',
      targetType: 'BusinessRule',
      targetId: row.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: rule.name,
        enabled: rule.enabled,
        grantsAccount: rule.grantsAccount,
        entitlementCount: rule.entitlementIds.length,
        condition: rule.condition,
      },
    });

    return { id: row.id };
  });
}

export async function deleteBusinessRule(
  tenantId: string,
  actorUserId: string | null,
  ruleId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const rule = await tx.businessRule.findUniqueOrThrow({ where: { id: ruleId } });
    await tx.businessRule.delete({ where: { id: ruleId } });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.rule.delete',
      targetType: 'BusinessRule',
      targetId: ruleId,
      outcome: 'success',
      sourceIp: null,
      payload: { name: rule.name },
    });
  });
}
```

- [ ] **Step 4: Write the entitlement service**

`packages/core/src/provision/entitlement-service.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { adTargetConnector, type DiscoveredEntitlement } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';

/**
 * Entitlements named by at least one business rule for this target.
 *
 * Provision's remit. "Provision manages this target" and "Provision manages
 * every group in this target" are different claims, and only the first is
 * ever true — so a group no rule mentions is never revoked, in either
 * enforcement mode.
 */
export async function remitFor(
  tx: TenantClient,
  targetId: string,
): Promise<Set<string>> {
  const joins = await tx.ruleEntitlement.findMany({
    where: { rule: { targetSystemId: targetId } },
    select: { entitlementId: true },
  });
  return new Set(joins.map((j) => j.entitlementId));
}

/**
 * Reads the target's entitlement catalog and reconciles it with Syntra's.
 *
 * Phased: the network read happens outside any transaction, and the write is
 * one short transaction afterwards.
 *
 * An entitlement Syntra knows and the target no longer offers becomes
 * `missing` rather than being deleted. Deleting it would orphan every
 * AccountEntitlement pointing at it and, worse, silently narrow every rule
 * that named it — which produces a desired set lacking it and proposes
 * revoking it from everybody. `missing` makes those rules unresolvable
 * instead, which is loud.
 */
export async function refreshEntitlements(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
): Promise<{ present: number; missing: number }> {
  // Phase 1: read the configuration out, then close the transaction.
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetId),
  );
  if (!config) throw new Error('target configuration or credential missing');

  // Phase 2: the network read. No transaction is held.
  const discovered: DiscoveredEntitlement[] = [];
  for await (const entitlement of adTargetConnector.listEntitlements(config)) {
    discovered.push(entitlement);
  }

  // Phase 3: one short transaction for the whole catalog update.
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const now = new Date();
    const seen = new Set<string>();

    for (const entitlement of discovered) {
      seen.add(entitlement.externalId);
      await tx.entitlement.upsert({
        where: {
          tenantId_targetSystemId_externalId: {
            tenantId: bound,
            targetSystemId: targetId,
            externalId: entitlement.externalId,
          },
        },
        create: {
          tenantId: bound,
          targetSystemId: targetId,
          externalId: entitlement.externalId,
          // Persisted so the person-access view and the rules editor can show
          // where a group lives without a second directory read. The identity
          // is still the externalId; this is allowed to go stale between
          // refreshes, and the run reads a live one in its own phase 4.
          dn: entitlement.dn,
          type: entitlement.type,
          displayName: entitlement.displayName,
          description: entitlement.description ?? null,
          status: 'present',
          lastSeenAt: now,
        },
        update: {
          dn: entitlement.dn,
          type: entitlement.type,
          displayName: entitlement.displayName,
          description: entitlement.description ?? null,
          // `status` is deliberately NOT written here. This function knows
          // whether a group is in the catalog; it knows nothing about whether
          // its membership could be read. Writing `present` unconditionally
          // would clear an `unreadable` the run had set, and a rule naming
          // that group would become resolvable again -- evaluated against a
          // membership nobody could read. The line below promotes `missing`
          // back to `present` and leaves `unreadable` alone.
          lastSeenAt: now,
        },
      });
    }

    await tx.entitlement.updateMany({
      where: {
        targetSystemId: targetId,
        externalId: { in: [...seen] },
        status: 'missing',
      },
      data: { status: 'present' },
    });

    const missing = await tx.entitlement.updateMany({
      where: {
        targetSystemId: targetId,
        externalId: { notIn: [...seen] },
        status: { not: 'missing' },
      },
      data: { status: 'missing' },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.entitlements.refresh',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: { present: discovered.length, missing: missing.count },
    });

    return { present: discovered.length, missing: missing.count };
  });
}
```

There is no `holderCounts` here, deliberately. Grouping `AccountEntitlement` rows answers "how many holdings has Provision recorded", and the per-entitlement guard needs "how many holders does this entitlement have **at the target**" (spec section 11). The two differ most on exactly the runs the axis exists for — a target Provision has not applied to yet, or one whose recorded inventory has come apart — where Syntra's count is zero, `holders === 0` skips the entitlement, and the second axis has no denominator at all. Task 13 computes it from the reconciled inventory and writes it onto `Entitlement.holderCount`.

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/target-service.js';
export * from './provision/entitlement-service.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/target-service.test.ts`
Expected: PASS, 18 tests.

Every assertion in this file reads through `withTenant`. A bare `prisma.targetSystem.findMany()` here returns `[]` under forced RLS whether the code works or not.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add target, profile, rule and entitlement storage"
```

---

## Task 13: The preview run — seven phases, no transaction across a network call

**Files:**
- Create: `packages/core/src/provision/run-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/run-service.test.ts`

**Interfaces:**
- Consumes: everything the pure stages produce — `desiredState`, `reconcile`, `planActions`, `evaluateProvisionGuard`, `driftFingerprint`, `personDisplayName`; `targetWithCredential` from `./target-service.js`; `remitFor` from `./entitlement-service.js`; `adTargetConnector`, `type TargetConnector`, `type DiscoveredEntitlement` from `@syntra/connectors`; `withTenant` from `@syntra/db`; `recordEvent`; `type MasterKeyProvider`.
- Produces:
  - `class ProvisionRunInFlightError extends Error` — thrown when another run for this target won the race to start
  - `async function previewProvisionRun(tenantId: string, provider: MasterKeyProvider, targetSystemId: string, options?: { now?: Date; connector?: TargetConnector<never>; resolveInFlight?: (targetSystemId: string) => Promise<number> }): Promise<{ id: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }>`

`resolveInFlight` is a seam Task 14 fills. The adoption of a crashed run has to resolve that run's `in_flight` actions against the target **before** a new run is created, and `resolveInFlightActions` does not exist until Task 14 — so this task defines the seam and defaults it to a no-op, and Task 14 step 4 supplies the real implementation and the test that proves it end to end. The alternative, which the first draft took, was to insert the call *after* the run was created; that is unreachable, because the create is what throws.

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/run-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let entitlementId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

async function seedPerson(givenName: string, familyName: string, endDate: Date | null) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName, familyName } });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        endDate,
        department: 'Finance',
      },
    });
    return person.id;
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
  });
  targetId = created.id;

  target = new FakeTarget();
  // Containers are READ from the target. Without this the target holds no
  // container at all, every person with a required account becomes
  // `container_missing`, and the run proposes nothing -- which is the
  // greenfield deadlock, and it is a fixture that has to reproduce the real
  // shape rather than be worked around.
  target.containers.push(USERS);
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });

  entitlementId = await withTenant(tenantId, async (tx) =>
    (
      await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-finance',
          dn: FINANCE_DN,
          type: 'group',
          displayName: 'Finance',
          status: 'present',
        },
      })
    ).id,
  );

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });

  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
});

const preview = () =>
  previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector: target as never });

// `sequence`, not `createdAt`. Every row phase 7 writes carries the same
// createdAt -- PostgreSQL's now() is transaction start time -- so an assertion
// on action order that reads by createdAt is asserting nothing and is flaky in
// whichever direction the planner happens to have returned.
const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

describe('previewProvisionRun', () => {
  it('proposes a create and a grant on a first run, and blocks it for confirmation', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    // A first run always requires confirmation, regardless of size: every
    // population has a denominator of zero.
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(true);
    expect(run.blockedReason).toContain('never had a run applied');

    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    // Ordered, and recoverable from the database. Two rows written by one
    // createMany share a createdAt to the microsecond.
    expect(actions.map((a) => a.sequence)).toEqual([0, 1]);

    // Spec section 5: the account has a durable identity in Syntra before it
    // has one in the target, and the correlation key is reserved by the unique
    // index before anything is written anywhere. Nothing else in the system
    // creates this row -- without it the apply has no account to write the
    // anchor onto and the next run proposes the same create again.
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.status).toBe('pending');
    expect(account.anchor).toBeNull();
    expect(account.correlationKey).toBe('anna.novak');
    // And every action for that person names it, so the apply can find it.
    expect(actions.every((a) => a.accountId === account.id)).toBe(true);
  });

  it('proposes a create on a first run against a genuinely empty target', async () => {
    // The greenfield case, and the one the container check used to deadlock.
    // Deriving the container set from the DNs of the accounts the target
    // returned makes it empty when the target is empty, so every person
    // becomes `container_missing` and the run proposes nothing -- and the
    // container can never become visible, because no account can ever be
    // created in it (Ruling P9).
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toEqual([]);
  });

  it('still refuses a person routed at a container the target does not hold', async () => {
    // The other half of the same ruling: the check is read from the target,
    // and it does NOT disable itself. Provision does not create organizational
    // units in somebody else's domain, and the exception names the container.
    await seedPerson('Anna', 'Novak', null);
    await upsertAccountProfile(tenantId, null, targetId, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      maxUniquenessAttempts: 20,
      containerTemplate: 'OU=Nowhere,DC=acme,DC=test',
      fallbackContainer: 'OU=Nowhere,DC=acme,DC=test',
      attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
      initialPasswordPolicy: { length: 24 },
      initialPasswordDelivery: 'vaultOnly',
    });
    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);
    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.kind).toBe('container_missing');
    expect(exceptions[0]!.message).toContain('OU=Nowhere,DC=acme,DC=test');
  });

  it('maps membership from distinguished names, which is what the target reports', async () => {
    // Against real Active Directory `memberOf` is a list of DNs and
    // `Entitlement.externalId` is an objectGUID. Keying the map on externalId
    // makes every lookup miss -- silently -- so every managed holding becomes
    // permanent `missing_grant` drift, the planner re-proposes grants for the
    // whole population every run, and the revocation guard's global axis has a
    // denominator of zero.
    const personId = await seedPerson('Anna', 'Novak', null);
    const created = await target.write({ domain: 'acme.test' } as never, {
      op: 'create_account',
      actionId: 'seed',
      correlationKey: 'anna.novak',
      attributes: { distinguishedName: [`CN=anna.novak,${USERS}`] },
      enabled: true,
      initialPassword: 'Aa1!seed-password',
    });
    await target.write({ domain: 'acme.test' } as never, {
      op: 'grant_entitlement',
      actionId: 'seed-g',
      anchor: created.anchor!,
      entitlementId: 'guid-finance',
    });
    await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: created.anchor!,
          correlationKey: 'anna.novak',
          status: 'active',
          lastAppliedAttributes: { displayName: ['Anna Novak'] },
        },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'rule' },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { lastAppliedRunAt: new Date() },
      });
    });

    const run = await preview();
    // Nothing to do: the target holds what Syntra granted. If the DN mapping
    // missed, this would propose `grant_entitlement` and record a
    // `missing_grant` finding.
    expect(await actionsOf(run.id)).toEqual([]);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).not.toContain('missing_grant');
  });

  it('marks a group whose membership cannot be read unreadable, and freezes the rule naming it', async () => {
    // Global Constraint 16, and the status nothing used to write. A group
    // whose ranged read fails was previously treated as fully read with
    // whatever came back -- the exact fail-open Ruling P1 exists to prevent,
    // moved from the connector up into the run.
    await seedPerson('Anna', 'Novak', null);
    target.unreadableEntitlementDns.add(FINANCE_DN);

    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);

    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.kind).toBe('unresolvable_rule');
    expect(exceptions[0]!.message).toContain('unreadable');

    const entitlement = await withTenant(tenantId, (tx) =>
      tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
    );
    expect(entitlement.status).toBe('unreadable');
  });

  it('adopts a run left non-terminal by a dead process instead of refusing forever', async () => {
    // The partial unique index covers running, previewed, blocked AND
    // applying. Demoting only two of the four leaves a crashed run in place,
    // the create violates the index, and every subsequent run for this target
    // throws -- permanently. One crash bricks the target.
    await seedPerson('Anna', 'Novak', null);
    for (const status of ['running', 'applying'] as const) {
      await withTenant(tenantId, (tx) =>
        tx.provisionRun.deleteMany({ where: { targetSystemId: targetId } }),
      );
      await withTenant(tenantId, (tx) =>
        tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status },
        }),
      );

      const run = await preview();
      expect(run.id).toBeDefined();

      const runs = await withTenant(tenantId, (tx) =>
        tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
      );
      expect(runs).toHaveLength(2);
      // `running` never wrote a plan, so it failed. `applying` may have landed
      // writes at the target, so it is partially_applied -- an honest terminal
      // state and not a claim that it finished.
      expect(runs[0]!.status).toBe(status === 'running' ? 'failed' : 'partially_applied');
    }
  });

  it('records the counts on the run', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(row.personsEvaluated).toBe(1);
    expect(row.personsWithActiveContract).toBe(1);
    expect(row.createAccountCount).toBe(1);
    expect(row.grantEntitlementCount).toBe(1);
  });

  it('writes a ProvisionException naming a person with no contracts', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();

    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany({ include: { person: true } }),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.person.givenName).toBe('Bo');
    expect(exceptions[0]!.kind).toBe('no_contracts');

    // And nothing is proposed for them.
    const actions = await actionsOf(run.id);
    expect(actions.every((a) => a.personId !== exceptions[0]!.personId)).toBe(true);
  });

  it('writes the plan and the terminal status in one transaction', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { actions: true },
      }),
    );
    // There is no readable state in which a run is previewed with no actions,
    // or holds actions while still running.
    expect(row.status).not.toBe('running');
    expect(row.actions.length).toBeGreaterThan(0);
    expect(row.finishedAt).not.toBeNull();
  });

  it('supersedes a previous run still proposed', async () => {
    await seedPerson('Anna', 'Novak', null);
    const first = await preview();
    const second = await preview();

    const superseded = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: first.id } }),
    );
    expect(superseded.every((a) => a.status === 'superseded')).toBe(true);
    // A superseded action that still needs doing reappears in the run that
    // superseded it.
    const current = await actionsOf(second.id);
    expect(current.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
  });

  it('marks the run failed and writes no plan when the target read throws', async () => {
    await seedPerson('Anna', 'Novak', null);
    const exploding = {
      ...target,
      read: () => {
        throw new Error('domain controller unreachable');
      },
    };
    await expect(
      previewProvisionRun(tenantId, provider, targetId, {
        now: NOW,
        connector: exploding as never,
      }),
    ).rejects.toThrow('domain controller unreachable');

    const runs = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ include: { actions: true } }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    // A run that fails partway writes no plan at all.
    expect(runs[0]!.actions).toEqual([]);
    expect(runs[0]!.error).toContain('domain controller unreachable');
  });

  it('records drift under additive without proposing a revocation', async () => {
    // Ruling P2. Additive means "I saw this and left it".
    const personId = await seedPerson('Anna', 'Novak', null);
    const created = await target.write({ domain: 'acme.test' } as never, {
      op: 'create_account',
      actionId: 'seed',
      correlationKey: 'anna.novak',
      attributes: { distinguishedName: [`CN=anna.novak,${USERS}`] },
      enabled: true,
      initialPassword: 'Aa1!seed-password',
    });
    await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: created.anchor!,
          correlationKey: 'anna.novak',
          status: 'active',
          lastAppliedAttributes: { displayName: ['Anna Novak'] },
        },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'rule' },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { lastAppliedRunAt: new Date() },
      });
    });
    // Granted by hand at the target, outside Provision.
    await target.write({ domain: 'acme.test' } as never, {
      op: 'grant_entitlement',
      actionId: 'by-hand',
      anchor: created.anchor!,
      entitlementId: 'guid-finance',
    });

    const run = await preview();
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).toContain('unmanaged_entitlement');

    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).not.toContain('revoke_entitlement');
  });

  it('updates a persisting drift finding rather than duplicating it', async () => {
    await seedPerson('Anna', 'Novak', null);
    target.seedForeignObject('stranger');
    await preview();
    await preview();
    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({ where: { kind: 'orphan_account' } }),
    );
    // The count on the dashboard is a count of problems, not of runs.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      findings[0]!.firstSeenAt.getTime(),
    );
  });

  it('refuses outright when the target returns nothing while Syntra holds accounts', async () => {
    const personId = await seedPerson('Anna', 'Novak', null);
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'anchor-existing',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { lastAppliedRunAt: new Date() },
      });
    });
    target.returnsNothing = true;

    const run = await preview();
    expect(run.status).toBe('blocked');
    // There is nothing an administrator could usefully confirm about a
    // directory that may simply be unreachable.
    expect(run.requiresConfirmation).toBe(false);
    expect(run.blockedReason).toContain('no accounts at all');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/run-service.test.ts`
Expected: FAIL — cannot find module `./run-service.js`.

- [ ] **Step 3: Write the run service**

`packages/core/src/provision/run-service.ts`:

```ts
import { withTenant } from '@syntra/db';
import {
  adTargetConnector,
  type DiscoveredEntitlement,
  type TargetConnector,
} from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { desiredState, personDisplayName } from './desired.js';
import { evaluateProvisionGuard } from './guard.js';
import { planActions } from './plan.js';
import { reconcile } from './reconcile.js';
import { remitFor } from './entitlement-service.js';
import { targetWithCredential } from './target-service.js';
import type {
  ContractFacts,
  DesiredState,
  KnownAccount,
  PersonFacts,
  RuleFacts,
  TargetObject,
} from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * Computes the whole plan, writes it down, and stops. Applying it is a
 * separate, explicit step (Task 14).
 *
 * **The phases mirror `previewRun`'s in the sync pipeline, under the same
 * rule: no `tx` handle crosses a phase boundary, and nothing that touches the
 * network is inside one.** `withTenant` is `prisma.$transaction(fn)` under
 * Prisma's 5000 ms default, and a whole directory read once sat inside one,
 * which made that subsystem unable to work against a real directory. A target
 * write is slower and less reliable than a directory read.
 *
 * 1. **Adopt** whatever the last process left behind, then create the run row,
 *    so there is something to mark `failed` however the rest gives out. Short
 *    transactions with the in-flight resolution (phase 3) between them.
 * 2. Read configuration and credentials. One short transaction; returns plain
 *    data, deliberately not a `tx`.
 * 3. Resolving `in_flight` actions from a crashed run happens inside phase 1's
 *    adoption, not after it — see `adoptStaleRuns`.
 * 4. Read the target: accounts, containers and the entitlement catalog, and
 *    probe each in-remit group's membership. Network. No transaction, and
 *    holding no database connection while it runs.
 * 5. Snapshot the database side in one short transaction.
 * 6. Evaluate, reconcile, plan and guard. Pure. No transaction, no I/O.
 * 7. Write every account reservation, action, exception, drift finding and the
 *    run's terminal status **in one transaction**, so that a run which fails
 *    partway writes no plan at all.
 */
/**
 * Another run for this target is already non-terminal and won the race.
 *
 * The partial unique index makes two concurrent starts a database refusal
 * rather than an application race, which is right -- but nothing handled the
 * resulting `P2002`, so it surfaced as an opaque Prisma error, the job failed,
 * and the scheduler recorded nothing. This is what turns it into the loud skip
 * Ruling P4 already defines.
 */
export class ProvisionRunInFlightError extends Error {
  constructor(readonly targetSystemId: string) {
    super(
      `another run for target ${targetSystemId} is already in progress; this one did not start`,
    );
    this.name = 'ProvisionRunInFlightError';
  }
}

const NON_TERMINAL = ['running', 'previewed', 'blocked', 'applying'] as const;

/**
 * Adopts every run a dead process left non-terminal, then starts a new one.
 *
 * **A run left behind must be adopted, not stepped over.** The partial unique
 * index `provision_run_one_non_terminal` refuses a second non-terminal run for
 * a target, and it covers all four of `running`, `previewed`, `blocked` and
 * `applying`. Demoting only `previewed` and `blocked` -- which is what the
 * first draft did -- leaves a run stuck in `running` (the process died in
 * phases 2 to 6) or `applying` (it died mid-apply, which is precisely spec
 * section 20's "kill the process mid-apply, restart" scenario) permanently in
 * place, and every subsequent run for that target throws on the create.
 * Forever. One crash bricks the target.
 *
 * The three statuses are adopted differently because they mean different
 * things:
 *
 * - `previewed` / `blocked`: a plan nobody applied. Superseded — its
 *   still-proposed actions are marked so, because two overlapping plans
 *   against one target can interleave a revocation from the older behind a
 *   grant from the newer, producing a state neither plan described and nobody
 *   approved.
 * - `running`: a preview that never finished. It wrote no plan, so it is
 *   simply failed.
 * - `applying`: writes may have landed at the target. Its `in_flight` actions
 *   are resolved **against the target, outside any transaction** before
 *   anything else happens, and the run is then `partially_applied` — which is
 *   an honest terminal state and not a claim that it finished.
 */
async function adoptStaleRunsAndStart(
  tenantId: string,
  targetSystemId: string,
  resolveInFlight: (targetSystemId: string) => Promise<number>,
): Promise<{ id: string }> {
  const stale = await withTenant(tenantId, async (tx) => {
    const runs = await tx.provisionRun.findMany({
      where: { targetSystemId, status: { in: [...NON_TERMINAL] } },
      select: { id: true, status: true },
    });

    await tx.provisionAction.updateMany({
      where: { status: 'proposed', run: { targetSystemId } },
      data: { status: 'superseded' },
    });
    await tx.provisionRun.updateMany({
      where: { targetSystemId, status: { in: ['previewed', 'blocked'] } },
      data: {
        status: 'failed',
        error: 'superseded by a later run',
        finishedAt: new Date(),
      },
    });
    await tx.provisionRun.updateMany({
      where: { targetSystemId, status: 'running' },
      data: {
        status: 'failed',
        error: 'this run was left running by a process that did not finish',
        finishedAt: new Date(),
      },
    });

    return runs.filter((r) => r.status === 'applying');
  });

  // Outside any transaction: this reads the target. An action found in_flight
  // is in an UNKNOWN state, not a failed one, and it has to be asked about
  // before anything new is planned.
  if (stale.length > 0) {
    await resolveInFlight(targetSystemId);
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: {
          status: 'partially_applied',
          error: 'this run was interrupted mid-apply and was adopted by a later run',
          finishedAt: new Date(),
        },
      }),
    );
  }

  try {
    return await withTenant(tenantId, async (tx) => {
      const bound = await currentTenant(tx);
      return tx.provisionRun.create({
        data: { tenantId: bound, targetSystemId, status: 'running' },
      });
    });
  } catch (cause) {
    // P2002 on `provision_run_one_non_terminal`: another process created a run
    // for this target between the adoption above and this create. The database
    // refused it, which is the correct outcome -- this converts it into
    // something the scheduler can record rather than an opaque 500.
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'P2002'
    ) {
      throw new ProvisionRunInFlightError(targetSystemId);
    }
    throw cause;
  }
}

export async function previewProvisionRun(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  options: {
    now?: Date;
    connector?: TargetConnector<never>;
    /** Task 14 supplies `resolveInFlightActions` here. */
    resolveInFlight?: (targetSystemId: string) => Promise<number>;
  } = {},
): Promise<{
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}> {
  const now = options.now ?? new Date();
  const connector = (options.connector ??
    adTargetConnector) as unknown as TargetConnector<unknown>;
  // Task 14 supplies the real one. Until it does, a crashed `applying` run is
  // adopted without resolving its in-flight actions, which is still strictly
  // better than the target becoming permanently unrunnable.
  const resolveInFlight = options.resolveInFlight ?? (async () => 0);

  // Phase 1, and phase 3 inside it.
  const run = await adoptStaleRunsAndStart(tenantId, targetSystemId, resolveInFlight);

  try {
    // Phase 2.
    const prepared = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUniqueOrThrow({
        where: { id: targetSystemId },
      });
      const config = await targetWithCredential(tx, provider, targetSystemId);
      if (!config) throw new Error('target configuration or credential missing');
      const profile = await tx.accountProfile.findFirst({ where: { targetSystemId } });
      if (!profile) throw new Error('this target has no account profile');
      // The remit is read here rather than in phase 5 because phase 4 needs
      // it: only groups a business rule names are worth probing for a
      // truncated membership, and probing every group in a domain would be an
      // arbitrary number of extra round trips.
      const remit = await remitFor(tx, targetSystemId);
      const entitlementRows = await tx.entitlement.findMany({
        where: { targetSystemId },
        select: { id: true, externalId: true, dn: true },
      });
      return { target, config, profile, remit, entitlementRows };
    });

    // Phase 4. The slow, network-bound part, holding no database connection.
    const externalIdToEntitlementId = new Map(
      prepared.entitlementRows.map((r) => [r.externalId, r.id]),
    );

    // The live catalog, read now rather than trusted from the last refresh.
    const catalog: DiscoveredEntitlement[] = [];
    for await (const entitlement of connector.listEntitlements(prepared.config as never)) {
      catalog.push(entitlement);
    }

    /**
     * DN (lowercased) to Syntra entitlement id.
     *
     * This map is the whole reason `DiscoveredEntitlement` carries a `dn`.
     * Active Directory reports a user's group membership in `memberOf` as a
     * list of DISTINGUISHED NAMES; `Entitlement.externalId` is the group's
     * objectGUID. Keying this on externalId -- which the first draft did --
     * means every lookup misses, every account reads as holding nothing,
     * every managed holding becomes permanent `missing_grant` drift, the
     * planner re-proposes grants for the entire population forever, and the
     * revocation guard's global axis has a denominator of zero. No test caught
     * it, because the fake emitted `memberOf` keyed the way the consumer
     * wanted to read it (Ruling P8).
     *
     * The stored `dn` from the last catalog refresh is seeded first and the
     * live read overwrites it, so a group the catalog read did not return is
     * still resolvable from the last DN Syntra saw.
     */
    const dnToEntitlementId = new Map<string, string>();
    for (const row of prepared.entitlementRows) {
      if (row.dn !== null) dnToEntitlementId.set(row.dn.toLowerCase(), row.id);
    }
    for (const entitlement of catalog) {
      const id = externalIdToEntitlementId.get(entitlement.externalId);
      if (id !== undefined) dnToEntitlementId.set(entitlement.dn.toLowerCase(), id);
    }

    /**
     * Containers, read from the target and never inferred from account DNs.
     *
     * Deriving them from `objects` makes an empty container invisible, and on
     * a first run against an empty target makes every container invisible --
     * so every person with a required account becomes `container_missing`, the
     * run proposes nothing, and the container can never become visible because
     * no account can ever be created in it (Ruling P9).
     */
    const existingContainers = new Set<string>();
    for await (const container of connector.listContainers(prepared.config as never)) {
      existingContainers.add(container.dn.toLowerCase());
    }

    /**
     * Groups whose membership could not be read in full.
     *
     * Global Constraint 16 makes a rule naming an `unreadable` entitlement
     * unresolvable as a whole -- and until this loop existed, nothing anywhere
     * ever WROTE that status. A group whose ranged read fails was treated as
     * fully read with whatever came back, which is the exact fail-open Ruling
     * P1 exists to prevent, moved one level up from the connector into the
     * run.
     *
     * Only in-remit groups are probed: a group no business rule names cannot
     * make any rule unresolvable, and probing every group in a domain would be
     * an unbounded number of round trips for nothing.
     */
    const unreadableEntitlementIds = new Set<string>();
    for (const entitlement of catalog) {
      const id = externalIdToEntitlementId.get(entitlement.externalId);
      if (id === undefined || !prepared.remit.has(id)) continue;
      try {
        await connector.readEntitlementMembers(prepared.config as never, entitlement.dn);
      } catch {
        unreadableEntitlementIds.add(id);
      }
    }

    const objects: TargetObject[] = [];
    for await (const record of connector.read(prepared.config as never)) {
      const memberOf = record.attributes.memberOf ?? [];
      objects.push({
        anchor: record.anchor,
        correlationKey: record.attributes.sAMAccountName?.[0] ?? '',
        dn: record.dn,
        enabled: (record.attributes.userAccountControl?.[0] ?? '512') === '512',
        provenance: record.attributes[
          (prepared.config as { provenanceAttribute?: string }).provenanceAttribute ?? 'info'
        ]?.[0] ?? null,
        // Mapped from DNs, which is what memberOf contains.
        entitlementIds: memberOf
          .map((dn) => dnToEntitlementId.get(dn.toLowerCase()))
          .filter((id): id is string => id !== undefined),
        readComplete: record.readFailure === undefined,
      });
    }

    /**
     * How many accounts at the target hold each entitlement -- the
     * denominator of the guard's per-entitlement axis, and the value written
     * onto `Entitlement.holderCount`.
     *
     * From the TARGET, per spec section 11, not from Syntra's
     * `AccountEntitlement` rows. Syntra's count measures what Provision
     * believes it granted; on a first run, or on a target whose recorded
     * inventory has come apart, every count is zero and the guard's
     * `holders === 0` skips every entitlement -- so the axis switches itself
     * off on precisely the runs it exists for.
     */
    const holdersAtTarget = new Map<string, number>();
    for (const object of objects) {
      for (const entitlementId of object.entitlementIds) {
        holdersAtTarget.set(entitlementId, (holdersAtTarget.get(entitlementId) ?? 0) + 1);
      }
    }

    /**
     * Phase 5. One short transaction for the whole database-side snapshot.
     *
     * **A known limit, recorded rather than hidden.** This loads every
     * `Person` with every `Contract`, every `TargetAccount` with its held
     * entitlements and every `User`, inside one Prisma interactive
     * transaction, under the 5000 ms default (Global Constraint 2). At the
     * 40,000-holding scale the guard's own docstrings assume, that will time
     * out. It is one transaction on purpose -- desired state, actual state and
     * the guard's denominators must all describe the same instant, and a
     * snapshot stitched together from four unsynchronised reads is a plan
     * computed against a world that never existed.
     *
     * The fix, when a tenant reaches that size, is paged reads outside a
     * transaction for the person and account sets with a short transaction
     * around only the consistency-critical part, or a raised
     * `transactionOptions.timeout` on this call specifically. Both are
     * deliberate changes and neither is made here on speculation.
     */
    const snapshot = await withTenant(tenantId, async (tx) => {
      const persons = await tx.person.findMany({ include: { contracts: true } });
      const rules = await tx.businessRule.findMany({
        where: { targetSystemId },
        include: { entitlements: true },
      });
      const entitlements = await tx.entitlement.findMany({ where: { targetSystemId } });
      const accounts = await tx.targetAccount.findMany({
        where: { targetSystemId },
        include: { entitlements: { where: { state: 'held' } } },
      });
      const users = await tx.user.findMany({
        where: { personId: { not: null } },
        select: { id: true, personId: true, status: true },
      });
      const previous = await tx.provisionRun.findFirst({
        where: { targetSystemId, status: { in: ['applied', 'partially_applied'] } },
        orderBy: { startedAt: 'desc' },
      });
      return {
        persons,
        rules,
        entitlements,
        accounts,
        users,
        previousPersons: previous?.personsWithActiveContract ?? null,
        hasEverApplied: prepared.target.lastAppliedRunAt !== null,
      };
    });

    // Phase 6. Pure computation. No transaction, no I/O.
    const horizon = new Date(now.getTime() + prepared.target.preHireDays * MS_PER_DAY);

    // The catalog's stored status, with this run's membership probe merged
    // over it. `unreadable` wins: a group whose membership could not be read
    // must make every rule naming it unresolvable NOW, on this run, not on the
    // next one after phase 7 has written the status down.
    const entitlementStatus = new Map(
      snapshot.entitlements.map((e) => [
        e.id,
        unreadableEntitlementIds.has(e.id)
          ? ('unreadable' as const)
          : (e.status as 'present' | 'missing' | 'unreadable'),
      ]),
    );
    const ruleFacts: RuleFacts[] = snapshot.rules.map((r) => ({
      id: r.id,
      name: r.name,
      condition: r.condition as never,
      grantsAccount: r.grantsAccount,
      enabled: r.enabled,
      entitlementIds: r.entitlements.map((j) => j.entitlementId),
    }));
    const takenKeys = new Set([
      ...snapshot.accounts.map((a) => a.correlationKey),
      ...objects.map((o) => o.correlationKey),
    ]);
    const knownByPerson = new Map(snapshot.accounts.map((a) => [a.personId, a]));

    const desired: DesiredState[] = [];
    const contractsByPerson = new Map<string, ContractFacts[]>();

    for (const person of snapshot.persons) {
      const contracts: ContractFacts[] = person.contracts.map((c) => ({
        id: c.id,
        sequence: c.sequence,
        isPrimary: c.isPrimary,
        startDate: c.startDate,
        endDate: c.endDate,
        department: c.department,
        jobTitle: c.jobTitle,
        costCentre: c.costCentre,
        employer: c.employer,
        location: c.location,
        fte: c.fte === null ? null : Number(c.fte),
      }));
      contractsByPerson.set(person.id, contracts);

      // The columns Person actually has. There is no `email` and no
      // `displayName` on the model, and spec section 15 forbids adding one.
      const facts: PersonFacts = {
        id: person.id,
        givenName: person.givenName,
        familyName: person.familyName,
        nameConvention: person.nameConvention,
        businessEmail: person.businessEmail,
        personalEmail: person.personalEmail,
        status: person.status,
      };

      desired.push(
        desiredState({
          person: facts,
          contracts,
          rules: ruleFacts,
          profile: {
            correlationKeyTemplate: prepared.profile.correlationKeyTemplate,
            maxUniquenessAttempts: prepared.profile.maxUniquenessAttempts,
            containerTemplate: prepared.profile.containerTemplate,
            fallbackContainer: prepared.profile.fallbackContainer,
            attributeTemplates: prepared.profile.attributeTemplates as Record<string, string>,
            baseDn: (prepared.config as { baseDn: string }).baseDn,
          },
          entitlementStatus,
          existingCorrelationKey: knownByPerson.get(person.id)?.correlationKey ?? null,
          takenCorrelationKeys: takenKeys,
          renameEnabled: prepared.target.renameEnabled,
          now,
          horizon,
        }),
      );
    }

    const known: KnownAccount[] = snapshot.accounts.map((a) => ({
      id: a.id,
      personId: a.personId,
      anchor: a.anchor,
      correlationKey: a.correlationKey,
      status: a.status as KnownAccount['status'],
      disabledAt: a.disabledAt,
      lastAppliedAttributes: (a.lastAppliedAttributes ?? {}) as Record<string, string[]>,
      holdings: a.entitlements.map((h) => ({
        entitlementId: h.entitlementId,
        origin: h.origin as 'rule' | 'manual' | 'discovered',
        grantedByRuleId: h.grantedByRuleId,
      })),
    }));

    const reconciled = reconcile({
      desired,
      known,
      objects,
      remit: prepared.remit,
      // Read in phase 4, not derived from the DNs of the accounts the target
      // returned. Lowercased on both sides because DN comparison is
      // case-insensitive and a profile written in one case and an OU created
      // in another is an ordinary configuration, not an error.
      existingContainers,
      // In the case the profile produced: `reconcile` lowercases for the
      // comparison and reports the original, so the exception names the
      // container the administrator wrote rather than a mangled one.
      desiredContainers: new Map(
        desired
          .filter((d) => d.account?.required)
          .map((d) => [d.personId, d.account!.container]),
      ),
      enforcementMode: prepared.target.enforcementMode as 'additive' | 'authoritative',
    });

    const actions = planActions({
      desired,
      actual: reconciled.actual,
      contractsByPerson,
      syntraUserByPerson: new Map(
        snapshot.users
          .filter((u) => u.personId !== null)
          .map((u) => [u.personId!, { id: u.id, status: u.status }]),
      ),
      pairedDirectorySource: prepared.target.pairedDirectorySourceId !== null,
      ladder: {
        entitlementRevocationDelayDays: prepared.target.entitlementRevocationDelayDays,
        disableGraceDays: prepared.target.disableGraceDays,
        archiveAfterDays: prepared.target.archiveAfterDays,
        reenableWithoutConfirmationDays:
          prepared.target.reenableWithoutConfirmationDays,
        renameEnabled: prepared.target.renameEnabled,
      },
      now,
    });

    const personsWithActiveContract = snapshot.persons.filter((p) =>
      p.contracts.some(
        (c) =>
          c.startDate.getTime() <= now.getTime() &&
          (c.endDate === null || c.endDate.getTime() >= now.getTime()),
      ),
    ).length;

    const verdict = evaluateProvisionGuard({
      actions,
      thresholds: {
        createAccountThresholdPercent: prepared.target.createAccountThresholdPercent,
        disableAccountThresholdPercent: prepared.target.disableAccountThresholdPercent,
        archiveAccountThresholdPercent: prepared.target.archiveAccountThresholdPercent,
        revokeEntitlementThresholdPercent:
          prepared.target.revokeEntitlementThresholdPercent,
        deactivateSyntraUserThresholdPercent:
          prepared.target.deactivateSyntraUserThresholdPercent,
        perEntitlementThresholdPercent: prepared.target.perEntitlementThresholdPercent,
        personPopulationDropPercent: prepared.target.personPopulationDropPercent,
      },
      accountsAtTarget: objects.length,
      // No `|| known.length` fallback. Substituting Syntra's belief whenever
      // NO account at the target is enabled replaces the denominator on
      // exactly the input the disable guard exists for -- "everything is
      // disabled" -- with a number that makes the percentage look small. If
      // the denominator is genuinely zero, the zero-accounts refusal or the
      // first-run confirmation has already caught it.
      activeAccountsAtTarget: objects.filter((o) => o.enabled).length,
      entitlementHoldingsAtTarget: objects.reduce(
        (total, o) => total + o.entitlementIds.length,
        0,
      ),
      activeSyntraUsersLinked: snapshot.users.filter((u) => u.status === 'active').length,
      holderCountByEntitlement: holdersAtTarget,
      entitlementNameById: new Map(snapshot.entitlements.map((e) => [e.id, e.displayName])),
      personsWithActiveContract,
      previousPersonsWithActiveContract: snapshot.previousPersons,
      hasEverApplied: snapshot.hasEverApplied,
    });

    const exceptions = [
      ...desired
        .filter((d) => d.unprocessable !== null)
        .map((d) => ({ personId: d.personId, ...d.unprocessable! })),
      ...[...reconciled.extraUnprocessable].map(([personId, value]) => ({
        personId,
        ...value,
      })),
    ];

    const counts = (type: string) =>
      actions.filter((a) => a.actionType === type).length;

    // Phase 7. Everything, together.
    return await withTenant(tenantId, async (tx) => {
      const bound = await currentTenant(tx);

      /**
       * The account has a durable identity in Syntra before it has one in the
       * target.
       *
       * Nothing else in the system creates a `TargetAccount`. Without this,
       * `planActions` emits `create_account` with `accountId: null`, the apply
       * resolves no account, and `finish()` — which guards every inventory
       * write behind `if (status === 'applied' && meta.accountId)` — skips the
       * anchor, the status, the `createdActionId`, the applied attributes and
       * the `AccountEntitlement` row. Every one of them. The next run then
       * sees no account, computes `existsAtTarget: false`, proposes
       * `create_account` again, and the connector finds an object under the
       * same `sAMAccountName` carrying a different actionId and returns
       * `conflict` — so every person Provision ever created ends up
       * permanently in conflict on run two. `claimSyntraUsers` matches on
       * `TargetAccount.anchor` and finds none; the rehire path, the grace
       * ladder, reconciliation and the guard's denominators all read from an
       * inventory that is never populated.
       *
       * Spec section 5: the correlation key is reserved HERE, by the unique
       * index on `(tenantId, targetSystemId, correlationKey)`, before anything
       * is written to the target — which is what makes two concurrent runs
       * generating the same login a race the database refuses rather than one
       * the application is trusted to avoid.
       *
       * `status: 'pending'` and a null anchor: the row is a reservation, not a
       * claim that the account exists. `reconcile` knows not to treat a
       * pending row as a vanished account, and the partial unique index on
       * `anchor` permits many null anchors and only one of each real one.
       */
      const accountIdByPerson = new Map<string, string>();
      for (const state of desired) {
        if (state.unprocessable || state.notYetStarted) continue;
        if (!state.account?.required) continue;
        if (state.account.correlationKey === null) continue;
        const account = await tx.targetAccount.upsert({
          where: {
            tenantId_targetSystemId_personId: {
              tenantId: bound,
              targetSystemId,
              personId: state.personId,
            },
          },
          create: {
            tenantId: bound,
            targetSystemId,
            personId: state.personId,
            correlationKey: state.account.correlationKey,
            status: 'pending',
          },
          // Nothing. An existing account's status, anchor and applied
          // attributes belong to the apply, not to a preview.
          update: {},
        });
        accountIdByPerson.set(state.personId, account.id);
      }

      await tx.provisionAction.createMany({
        data: actions.map((a, index) => ({
          tenantId: bound,
          runId: run.id,
          actionType: a.actionType,
          personId: a.personId,
          // The reserved row, for the actions the planner could not name one
          // for -- everything for a person who had no account before this run.
          accountId:
            a.accountId ?? (a.personId === null ? null : accountIdByPerson.get(a.personId) ?? null),
          entitlementId: a.entitlementId,
          before: (a.before ?? undefined) as never,
          after: (a.after ?? undefined) as never,
          attributedRuleIds: a.attributedRuleIds,
          requiresConfirmation: a.requiresConfirmation,
          message: a.message,
          // `planActions` already returned these sorted by ACTION_ORDER, and
          // this is what preserves that through the write. `createdAt` cannot:
          // PostgreSQL's `now()` is transaction start time, so every row this
          // `createMany` writes carries an identical timestamp and ordering by
          // it imposes no order at all -- which lets a grant be attempted
          // before the create it depends on, nondeterministically.
          sequence: index,
        })),
      });

      await tx.provisionException.createMany({
        data: exceptions.map((e) => ({
          tenantId: bound,
          runId: run.id,
          personId: e.personId,
          targetSystemId,
          kind: e.kind,
          message: e.message,
        })),
      });

      const seenAt = new Date();
      for (const finding of reconciled.findings) {
        await tx.driftFinding.upsert({
          where: {
            tenantId_targetSystemId_fingerprint: {
              tenantId: bound,
              targetSystemId,
              fingerprint: finding.fingerprint,
            },
          },
          create: {
            tenantId: bound,
            targetSystemId,
            runId: run.id,
            accountId: finding.accountId,
            entitlementId: finding.entitlementId,
            subjectAnchor: finding.subjectAnchor,
            kind: finding.kind,
            detail: finding.detail as never,
            fingerprint: finding.fingerprint,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
          },
          update: {
            runId: run.id,
            subjectAnchor: finding.subjectAnchor,
            detail: finding.detail as never,
            lastSeenAt: seenAt,
          },
        });
      }

      // The membership probe's verdict, written down so the catalog screen and
      // the rules editor can show it and so the next run starts from it. Only
      // the transitions are written: a group that read cleanly is promoted out
      // of `unreadable`, and `missing` is left to refreshEntitlements.
      if (unreadableEntitlementIds.size > 0) {
        await tx.entitlement.updateMany({
          where: { targetSystemId, id: { in: [...unreadableEntitlementIds] } },
          data: { status: 'unreadable' },
        });
      }
      await tx.entitlement.updateMany({
        where: {
          targetSystemId,
          status: 'unreadable',
          id: { notIn: [...unreadableEntitlementIds] },
        },
        data: { status: 'present' },
      });

      // The holder count is the target's, per spec section 11, so the second
      // guard axis has a denominator on a run that has applied nothing yet.
      for (const entitlement of snapshot.entitlements) {
        const holders = holdersAtTarget.get(entitlement.id) ?? 0;
        if (holders === entitlement.holderCount) continue;
        await tx.entitlement.update({
          where: { id: entitlement.id },
          data: { holderCount: holders },
        });
      }

      const status = verdict.blocked ? 'blocked' : 'previewed';
      const blockedReason = verdict.blocked ? verdict.reasons.join('; ') : null;

      const updated = await tx.provisionRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          requiresConfirmation: verdict.blocked ? verdict.requiresConfirmation : false,
          blockedReason,
          personsEvaluated: snapshot.persons.length,
          personsWithActiveContract,
          personsUnprocessable: exceptions.length,
          accountsReadFromTarget: objects.length,
          // Read FROM THE TARGET in phase 4, which is what the column says.
          // `snapshot.entitlements.length` is Syntra's own catalog and would
          // report a number the target never gave.
          entitlementsReadFromTarget: catalog.length,
          createAccountCount: counts('create_account'),
          updateAccountCount: counts('update_account'),
          enableAccountCount: counts('enable_account'),
          disableAccountCount: counts('disable_account'),
          archiveAccountCount: counts('archive_account'),
          renameAccountCount: counts('rename_account'),
          grantEntitlementCount: counts('grant_entitlement'),
          revokeEntitlementCount: counts('revoke_entitlement'),
          deactivateSyntraUserCount: counts('deactivate_syntra_user'),
          reactivateSyntraUserCount: counts('reactivate_syntra_user'),
        },
      });

      await tx.targetSystem.update({
        where: { id: targetSystemId },
        data: { lastRunAt: new Date() },
      });

      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.run.preview',
        targetType: 'ProvisionRun',
        targetId: run.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          status,
          actions: actions.length,
          exceptions: exceptions.length,
          drift: reconciled.findings.length,
          blockedReason,
        },
      });

      return {
        id: updated.id,
        status: updated.status,
        requiresConfirmation: updated.requiresConfirmation,
        blockedReason: updated.blockedReason,
      };
    });
  } catch (cause) {
    // A run that fails partway writes no plan at all — the actions, the
    // exceptions and the terminal status are all in phase 7's single
    // transaction, which never ran.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({
        where: { id: run.id },
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
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/run-service.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/run-service.test.ts`
Expected: PASS, 14 tests.

"marks the run failed and writes no plan when the target read throws" is the one that proves the phasing. If the run comes back `failed` *with* actions attached, phase 7 has been split and the spec's promise that a run failing partway writes no plan is broken.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: compute a provisioning run in seven phases"
```

---

## Task 14: Enforcement — the three-step apply, retry, and in-flight resolution

**Files:**
- Create: `packages/core/src/provision/apply.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/apply.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent`; `targetWithCredential`; `remitFor` from `./entitlement-service.js`; `putSecret` from `../vault/vault-service.js`; `queueMessage`, `type Transport` from `../notify/`; `randomInt`, `randomBytes` from `node:crypto`; `type TargetConnector`, `type WriteOperation`, `isRetryable`, `SYNTRA_ONLY_ACTION_TYPES` from `@syntra/connectors`; `applySyntraUserAction` from `./syntra-user.js` (Task 15).

> **Dispatch order: Task 15 runs BEFORE Task 14.** This is a hard import, not a
> type-only one, so Task 14 cannot typecheck or run its tests until
> `syntra-user.ts` exists. Task 15 consumes nothing Task 14 produces — its only
> intra-slice dependency is `driftFingerprint` from Task 8 — so the swap is free.
> The task numbers are labels, not an order; do not renumber, just dispatch 15
> first. Adding an optional `applySyntraUser?` seam to `ApplyOptions` would also
> work and is deliberately NOT chosen: a seam that exists only to dodge task
> ordering is indirection a later reader has to decode, and this slice already
> carries two legitimate injection seams (`connector`, `transport`) that a third
> would dilute.
- Produces:
  - `interface ApplyOptions { only?: string[]; confirm?: boolean; confirmedByUserId?: string | null; connector?: TargetConnector<never>; transport?: Transport; now?: Date; sleep?: (ms: number) => Promise<void> }`
  - `function generateInitialPassword(policy: InitialPasswordPolicy): string`

`confirm` is separate from `confirmedByUserId` because the gate must not be satisfiable by accident. Keying it on `confirmedByUserId === undefined` means `confirmedByUserId: null` — which is what an internal caller writes when it has no user — passes both the blocked-run gate and the per-action `requiresConfirmation` gate. The plan's own test helper did exactly that, and the test named "applies a confirmed run and records the confirming user" then asserted `run.confirmedByUserId` was **null**, certifying the hole rather than catching it. Spec section 11: confirmation is per run, the confirming user is recorded on the run, and the scheduler never confirms anything.
  - `async function applyProvisionRun(tenantId: string, provider: MasterKeyProvider, runId: string, options?: ApplyOptions): Promise<{ status: string; applied: number; failed: number; pendingRetry: number; skipped: number }>`
  - `async function resolveInFlightActions(tenantId: string, provider: MasterKeyProvider, targetSystemId: string, options?: { connector?: TargetConnector<never> }): Promise<number>`
  - `function backoffMs(attempt: number, jitter: () => number): number`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/apply.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun, backoffMs, resolveInFlightActions } from './apply.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noSleep = async () => undefined;

let tenantId: string;
let targetId: string;
let entitlementId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
  });
  targetId = created.id;
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });

  entitlementId = await withTenant(tenantId, async (tx) => {
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
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        dn: FINANCE_DN,
        type: 'group',
        displayName: 'Finance',
      },
    });
    return entitlement.id;
  });

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
});

/** A real user, because confirming a run records who confirmed it. */
const seedConfirmingUser = () =>
  withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'reviewer',
        email: 'reviewer@acme.test',
        displayName: 'Reviewer',
      },
    });
    return user.id;
  });

const previewAndApply = async (only?: string[]) => {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: target as never,
  });
  const confirmedByUserId = await seedConfirmingUser();
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    // BOTH. `confirmedByUserId: null` alone used to satisfy the gate, because
    // it was keyed on the parameter being present rather than on anybody
    // having confirmed anything.
    confirm: true,
    confirmedByUserId,
    connector: target as never,
    now: NOW,
    sleep: noSleep,
    ...(only === undefined ? {} : { only }),
  });
  return { runId: run.id, result, confirmedByUserId };
};

// `sequence`, not `createdAt`: every row phase 7 wrote carries the same
// createdAt, because PostgreSQL's now() is transaction start time.
const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

describe('backoffMs', () => {
  it('grows exponentially and adds jitter', () => {
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(2, () => 0)).toBe(2000);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(1, () => 1)).toBe(1250);
  });
});

describe('applyProvisionRun', () => {
  it('refuses to apply a blocked run that was never confirmed', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    // The guard is not advisory, and the scheduler never confirms anything.
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses a blocked run when a caller passes a null confirming user', async () => {
    // The hole. `confirmedByUserId: null` is what an internal caller writes
    // when it has nobody to name, and keying the gate on the parameter being
    // PRESENT let that through -- so a blocked run applied with no confirming
    // user recorded, which is exactly what spec section 11 says cannot happen.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirmedByUserId: null,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses a blocked run confirmed with no user, and one naming a user without confirming', async () => {
    // Both halves are required. Either alone is somebody's discipline rather
    // than the guard's contract.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId: null,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);

    const userId = await seedConfirmingUser();
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirmedByUserId: userId,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('applies a confirmed run and records the confirming user', async () => {
    const { runId, result, confirmedByUserId } = await previewAndApply();
    expect(result.status).toBe('applied');
    expect(result.applied).toBe(2);
    const run = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: runId } }),
    );
    expect(run.status).toBe('applied');
    // The confirming user, by id. The previous version asserted this was null
    // -- which certified the hole instead of catching it.
    expect(run.confirmedByUserId).toBe(confirmedByUserId);
  });

  it('writes the anchor back onto the account after a create', async () => {
    await previewAndApply();
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.anchor).toMatch(/^fake-anchor-/);
    expect(account.status).toBe('active');
  });

  it('records the holding with its origin and granting rule', async () => {
    await previewAndApply();
    const holding = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findFirstOrThrow({}),
    );
    // origin separates convergence from drift and is not derivable after the
    // fact, so it is recorded at the moment of the grant.
    expect(holding.origin).toBe('rule');
    expect(holding.state).toBe('held');
  });

  it('seals the initial password into the vault and never writes it anywhere else', async () => {
    // Ruling P12. A generated credential that is never delivered is not a
    // feature: the connector used to invent the password, write it to the
    // directory and drop it, so `initialPasswordPolicy` and
    // `initialPasswordDelivery` were schema, contracts and a <select> with no
    // behaviour behind them -- and no account Provision created was usable by
    // the person it was created for.
    const { runId } = await previewAndApply();

    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    const secretName = `target/${targetId}/initial/${account.id}`;
    const password = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, secretName),
    );
    expect(password).not.toBeNull();
    expect(password!.length).toBeGreaterThanOrEqual(16);

    // And the second half, which matters as much as the first: this is the
    // slice where secrets start flowing through action rows and audit events.
    const actions = await actionsOf(runId);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'provision.' } } }),
    );
    const serialised = JSON.stringify({ actions, events });
    expect(serialised).not.toContain(password!);
    expect(serialised).not.toContain('unicodePwd');
    expect(serialised).not.toContain('initialPassword');
  });

  it('writes an intent event before the call and a result event after it', async () => {
    const { runId } = await previewAndApply();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: 'provision.action.' } },
        orderBy: { sequence: 'asc' },
      }),
    );
    // An audit log that only records completions cannot distinguish "we never
    // tried" from "we tried and never found out".
    expect(events.map((e) => e.action)).toEqual([
      'provision.action.intent',
      'provision.action.result',
      'provision.action.intent',
      'provision.action.result',
    ]);
    void runId;
  });

  it('applies only the actions named in `only` and leaves the rest proposed', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const all = await actionsOf(run.id);
    const createId = all.find((a) => a.actionType === 'create_account')!.id;

    const result = await applyProvisionRun(tenantId, provider, run.id, {
      only: [createId],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    // One conflicting person does not force the whole run to be abandoned or
    // applied wholesale.
    expect(result.status).toBe('partially_applied');
    const after = await actionsOf(run.id);
    expect(after.find((a) => a.id === createId)!.status).toBe('applied');
    expect(after.find((a) => a.actionType === 'grant_entitlement')!.status).toBe(
      'proposed',
    );
  });

  it('retries a transient failure within the run and succeeds', async () => {
    target.program('create_account', { failTimes: 2, failure: 'transient' });
    const { runId, result } = await previewAndApply();
    expect(result.status).toBe('applied');
    const actions = await actionsOf(runId);
    expect(actions.find((a) => a.actionType === 'create_account')!.attempts).toBe(3);
  });

  it('leaves an action pending_retry when it exhausts maxAttempts', async () => {
    target.program('create_account', { failTimes: Infinity, failure: 'transient' });
    const { runId, result } = await previewAndApply();
    // pending_retry, not failed: the next run for this target picks it up,
    // provided the plan still wants it.
    expect(result.pendingRetry).toBe(1);
    expect(result.status).toBe('partially_applied');
    const actions = await actionsOf(runId);
    expect(actions.find((a) => a.actionType === 'create_account')!.status).toBe(
      'pending_retry',
    );
  });

  it('never retries a permanent rejection', async () => {
    target.program('create_account', { failTimes: Infinity, failure: 'rejected' });
    const { runId } = await previewAndApply();
    const action = (await actionsOf(runId)).find((a) => a.actionType === 'create_account')!;
    // A schema violation and a refused password complexity do not become true
    // on the fourth attempt.
    expect(action.status).toBe('failed');
    expect(action.attempts).toBe(1);
  });

  it('marks a conflict as conflict and puts the account in conflict', async () => {
    target.seedForeignObject('anna.novak');
    const { runId } = await previewAndApply();
    const action = (await actionsOf(runId)).find((a) => a.actionType === 'create_account')!;
    expect(action.status).toBe('conflict');
    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));
    expect(account.status).toBe('conflict');
  });

  it('honours retryAfterMs on a throttle without counting it against maxAttempts', async () => {
    const waits: number[] = [];
    target.program('create_account', {
      failTimes: 5,
      failure: 'throttled',
      retryAfterMs: 250,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      connector: target as never,
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits.filter((w) => w === 250).length).toBeGreaterThanOrEqual(5);
    const action = (await actionsOf(run.id)).find((a) => a.actionType === 'create_account')!;
    // Throttles are not counted against maxAttempts, so the action still had
    // its full budget of real attempts.
    expect(action.attempts).toBeLessThanOrEqual(3);
  });

  it('gives up on a target that throttles forever instead of hanging', async () => {
    // Without a ceiling this loop is unbounded: no counter, no wall clock. A
    // target that throttles indefinitely hangs the apply, the run stays
    // `applying`, and per the adoption rules in Task 13 that is a run somebody
    // has to have adopted before the target can be used again.
    target.program('create_account', {
      failTimes: Infinity,
      failure: 'throttled',
      retryAfterMs: 10,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.pendingRetry).toBe(1);
    const action = (await actionsOf(run.id)).find((a) => a.actionType === 'create_account')!;
    expect(action.status).toBe('pending_retry');
    expect(action.message).toMatch(/throttl/i);
  });

  it('never puts a network call inside a transaction', async () => {
    // The connector records how long the database was idle around each call.
    // A write inside a transaction would hold a connection for its duration,
    // and Prisma's default 5000 ms would kill it. This asserts the shape
    // rather than the timing: the action is marked in_flight and COMMITTED
    // before the connector is called.
    const seen: string[] = [];
    const observing = new FakeTarget();
    observing.containers.push(USERS);
    observing.entitlements.push({
      externalId: 'guid-finance',
      dn: FINANCE_DN,
      type: 'group',
      displayName: 'Finance',
    });
    const original = observing.write.bind(observing);
    observing.write = async (cfg, op) => {
      const row = await withTenant(tenantId, (tx) =>
        tx.provisionAction.findFirst({ where: { actionType: op.op } }),
      );
      seen.push(row?.status ?? 'absent');
      return original(cfg, op);
    };
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: observing as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      connector: observing as never,
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      sleep: noSleep,
    });
    // Readable from another transaction while the connector runs, which is
    // only possible if the marker was committed first.
    expect(seen).toContain('in_flight');
  });
});

describe('resolveInFlightActions', () => {
  it('adopts a create whose response was lost rather than duplicating it', async () => {
    target.program('create_account', { loseResponseTimes: 1 });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    // Simulate a process death between the write and step 3.
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({ where: { id: createId }, data: { status: 'in_flight' } }),
    );

    const resolved = await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    expect(resolved).toBe(1);
    const action = (await actionsOf(run.id)).find((a) => a.id === createId)!;
    // An action found in_flight is in an UNKNOWN state, not a failed one.
    expect(action.status).toBe('applied');
    expect(target.objects.size).toBe(1);
    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));
    expect(account.anchor).not.toBeNull();
  });

  it('starts a new run after a process died mid-apply, and resolves what it left in flight', async () => {
    // Spec section 20's crash-recovery case, end to end and through the
    // production path: kill the process mid-apply, restart. Both halves matter
    // and each was broken on its own. The run left in `applying` violates the
    // partial unique index, so without adoption the create throws and the
    // target is permanently unrunnable; and with the in-flight resolution
    // inserted AFTER the create, it could never run at all, because the create
    // is what throws.
    target.program('create_account', { loseResponseTimes: 1 });
    const first = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(first.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, async (tx) => {
      await tx.provisionRun.update({ where: { id: first.id }, data: { status: 'applying' } });
      await tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      });
    });
    // The write landed at the target and the response was lost.
    await target.write({ domain: 'acme.test' } as never, {
      op: 'create_account',
      actionId: createId,
      correlationKey: 'anna.novak',
      attributes: { distinguishedName: [`CN=anna.novak,${USERS}`] },
      enabled: true,
      initialPassword: 'Aa1!lost-response',
    });

    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
      resolveInFlight: (id) =>
        resolveInFlightActions(tenantId, provider, id, { connector: target as never }),
    });

    expect(second.id).not.toBe(first.id);
    const resolved = (await actionsOf(first.id)).find((a) => a.id === createId)!;
    // Unknown, not failed: it is asked about, and the answer is that it landed.
    expect(resolved.status).toBe('applied');
    const adopted = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: first.id } }),
    );
    expect(adopted.status).toBe('partially_applied');
    // One object at the target, not two.
    expect(target.objects.size).toBe(1);
  });

  it('marks an in-flight create that never landed as proposed again', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({ where: { id: createId }, data: { status: 'in_flight' } }),
    );
    await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    const action = (await actionsOf(run.id)).find((a) => a.id === createId)!;
    expect(action.status).toBe('proposed');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/apply.test.ts`
Expected: FAIL — cannot find module `./apply.js`.

- [ ] **Step 3: Write the enforcement loop**

`packages/core/src/provision/apply.ts`:

```ts
import { randomBytes, randomInt } from 'node:crypto';
import { withTenant } from '@syntra/db';
import {
  adTargetConnector,
  isRetryable,
  SYNTRA_ONLY_ACTION_TYPES,
  type TargetConnector,
  type WriteOperation,
  type WriteResult,
} from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import { queueMessage } from '../notify/delivery.js';
import type { Transport } from '../notify/notification-service.js';
import { putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { remitFor } from './entitlement-service.js';
import { targetWithCredential } from './target-service.js';
import { applySyntraUserAction } from './syntra-user.js';

/** Exponential, with jitter, so a hundred retries do not arrive together. */
export function backoffMs(attempt: number, jitter: () => number = Math.random): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.round(base * (1 + jitter() * 0.25));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long one action may spend being throttled before it gives up.
 *
 * A throttle is the target asking for patience, so it is not counted against
 * `maxAttempts` -- but "not counted" is not "unbounded". Without a ceiling a
 * target throttling indefinitely hangs the apply forever, and the run stays
 * `applying`, which is the state a later run then has to adopt.
 */
const THROTTLE_BUDGET_MS = 120_000;

export interface InitialPasswordPolicy {
  length?: number;
  requireUpper?: boolean;
  requireLower?: boolean;
  requireDigit?: boolean;
  requireSymbol?: boolean;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';

/**
 * The initial password, generated here and not in the connector.
 *
 * Generated with `crypto` (Global Constraint 14), honouring the profile's
 * policy rather than a hardcoded shape -- the earlier draft's connector
 * produced `Aa1!` plus 24 random bytes regardless of what the profile said,
 * which made `initialPasswordPolicy` a column nothing read.
 *
 * Never logged, never returned by an API, never written to a ProvisionAction
 * or an audit payload. It leaves this module twice: into the vault, and into
 * one message.
 */
export function generateInitialPassword(policy: InitialPasswordPolicy = {}): string {
  const length = Math.max(16, Math.min(128, policy.length ?? 24));
  const classes: string[] = [];
  if (policy.requireUpper !== false) classes.push(UPPER);
  if (policy.requireLower !== false) classes.push(LOWER);
  if (policy.requireDigit !== false) classes.push(DIGIT);
  if (policy.requireSymbol !== false) classes.push(SYMBOL);
  const alphabet = classes.join('');

  // One character from each required class, then fill, then shuffle -- so the
  // result satisfies the policy without a rejection loop that could, on a
  // narrow alphabet, not terminate.
  const chars = classes.map((set) => set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(alphabet[randomInt(alphabet.length)]!);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  void randomBytes;
  return chars.join('');
}

export interface ApplyOptions {
  /** Action ids to apply. Omitted, every proposed action is applied. */
  only?: string[];
  /**
   * A human is applying this deliberately, and `confirmedByUserId` names them.
   *
   * Both are required to satisfy either confirmation gate. Keying the gates on
   * `confirmedByUserId === undefined` alone means `confirmedByUserId: null` --
   * what any internal caller writes when it has nobody to name -- satisfies
   * them, so a blocked run applies with no confirming user recorded. The
   * guard's own contract must not depend on a caller's discipline.
   */
  confirm?: boolean;
  confirmedByUserId?: string | null;
  connector?: TargetConnector<never>;
  /**
   * How the initial password is delivered. Absent, the password is still
   * sealed into the vault and an audit event records that delivery could not
   * be attempted -- which is a visible gap, not a silent one.
   */
  transport?: Transport;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Both halves, in one place, so no call site can satisfy half of it. */
function isConfirmed(options: ApplyOptions): boolean {
  return (
    options.confirm === true &&
    options.confirmedByUserId !== null &&
    options.confirmedByUserId !== undefined
  );
}

interface ActionRow {
  id: string;
  actionType: string;
  personId: string | null;
  accountId: string | null;
  entitlementId: string | null;
  after: unknown;
  attempts: number;
  requiresConfirmation: boolean;
}

function toWriteOperation(
  action: ActionRow,
  context: {
    anchor: string | null;
    correlationKey: string | null;
    entitlementExternalId: string | null;
    /** The DNs of the entitlements Provision manages for this account. */
    entitlementDns: string[];
    /** Generated by the caller for this create, and by nobody else. */
    initialPassword: string;
  },
): WriteOperation | null {
  const after = (action.after ?? {}) as Record<string, unknown>;
  switch (action.actionType) {
    case 'create_account':
      return {
        op: 'create_account',
        actionId: action.id,
        correlationKey: String(after.correlationKey ?? context.correlationKey ?? ''),
        attributes: {
          ...((after.attributes ?? {}) as Record<string, string[]>),
          distinguishedName: [
            `CN=${String(after.correlationKey ?? context.correlationKey)},${String(after.container ?? '')}`,
          ],
        },
        enabled: Boolean(after.enabled),
        // Generated here, sealed and delivered by `finish`. The connector uses
        // this value and invents nothing.
        initialPassword: context.initialPassword,
      };
    case 'update_account':
      return context.anchor === null
        ? null
        : {
            op: 'update_account',
            actionId: action.id,
            anchor: context.anchor,
            attributes: {
              ...((after.attributes ?? {}) as Record<string, string[]>),
              distinguishedName: [
                `CN=${context.correlationKey},${String(after.container ?? '')}`,
              ],
            },
          };
    case 'enable_account':
      return context.anchor === null
        ? null
        : { op: 'enable_account', actionId: action.id, anchor: context.anchor };
    case 'disable_account':
      return context.anchor === null
        ? null
        : {
            op: 'disable_account',
            actionId: action.id,
            anchor: context.anchor,
            reason: String(after.reason ?? 'no longer required by any business rule'),
          };
    case 'archive_account':
      return context.anchor === null
        ? null
        : {
            op: 'archive_account',
            actionId: action.id,
            anchor: context.anchor,
            // ONLY what Provision manages for this account. The connector must
            // not fall back to the object's own memberOf: that strips groups
            // no business rule mentions, on the step spec section 9 calls the
            // closest thing to destructive in the ladder.
            entitlementDns: context.entitlementDns,
          };
    case 'rename_account':
      return context.anchor === null
        ? null
        : {
            op: 'rename_account',
            actionId: action.id,
            anchor: context.anchor,
            correlationKey: String(after.correlationKey ?? ''),
          };
    case 'grant_entitlement':
    case 'revoke_entitlement':
      return context.anchor === null || context.entitlementExternalId === null
        ? null
        : {
            op: action.actionType,
            actionId: action.id,
            anchor: context.anchor,
            entitlementId: context.entitlementExternalId,
          };
    default:
      // Includes the two Syntra-directory actions, which call no connector at
      // all, and anything unrecognised. There is no delete to fall through to.
      return null;
  }
}

/**
 * Applies a run, one action at a time, in three steps per action.
 *
 * **The transaction shape is the point.** Each action that calls a connector
 * is applied as:
 *
 * 1. One short `withTenant`: mark the action `in_flight`, write the audit
 *    event recording the *intent*, commit.
 * 2. The connector call. No transaction is held. No database connection is
 *    held.
 * 3. One short `withTenant`: write the outcome onto the action, update
 *    `TargetAccount` or `AccountEntitlement`, write the audit event recording
 *    the *result*, commit.
 *
 * There is an honest gap between 2 and 3 that no amount of transaction
 * discipline closes, because the target is not in the database and cannot join
 * a transaction. The `in_flight` marker is what makes that gap observable
 * rather than silent — and recording the intent *before* the call is what
 * makes it resolvable, because an audit log that only records completions
 * cannot distinguish "we never tried" from "we tried and never found out".
 *
 * The two Syntra-directory actions are the only exception: they call no
 * connector, so they apply inside a single transaction with their audit event
 * and need no in-flight resolution.
 */
export async function applyProvisionRun(
  tenantId: string,
  provider: MasterKeyProvider,
  runId: string,
  options: ApplyOptions = {},
): Promise<{
  status: string;
  applied: number;
  failed: number;
  pendingRetry: number;
  skipped: number;
}> {
  const sleep = options.sleep ?? defaultSleep;
  const connector = (options.connector ??
    adTargetConnector) as unknown as TargetConnector<unknown>;

  const confirmed = isConfirmed(options);

  const prepared = await withTenant(tenantId, async (tx) => {
    const run = await tx.provisionRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === 'blocked' && !confirmed) {
      throw new Error(
        `this run is blocked and has not been confirmed: ${run.blockedReason ?? ''}`,
      );
    }
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: run.targetSystemId },
    });
    const config = await targetWithCredential(tx, provider, run.targetSystemId);
    if (!config) throw new Error('target configuration or credential missing');
    const profile = await tx.accountProfile.findFirst({
      where: { targetSystemId: run.targetSystemId },
    });
    // Provision only ever touches entitlements a business rule for this target
    // names, in both enforcement modes. The archive's strip list is filtered
    // through this.
    const remit = await remitFor(tx, run.targetSystemId);

    await tx.provisionRun.update({
      where: { id: runId },
      data: {
        status: 'applying',
        // Recorded only when somebody actually confirmed. Writing whatever
        // arrived would put a null in the column on an unconfirmed apply and
        // read as "confirmed by nobody" rather than "not confirmed".
        ...(confirmed ? { confirmedByUserId: options.confirmedByUserId } : {}),
      },
    });
    return { run, target, config, profile, remit };
  });

  const actions = await withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({
      where: {
        runId,
        status: { in: ['proposed', 'pending_retry'] },
        ...(options.only === undefined ? {} : { id: { in: options.only } }),
      },
      // Spec section 14's ordering, recoverable because the run wrote it down.
      // `createdAt` cannot carry it: PostgreSQL's now() is transaction start
      // time, so every row phase 7 wrote shares one timestamp and a grant can
      // be attempted before the create it depends on -- nondeterministically,
      // which passes CI and fails in production.
      orderBy: { sequence: 'asc' },
    }),
  );

  // Spec section 14 also says writes against a single target run at a bounded
  // concurrency, default 4, and `TargetSystem.concurrency` stores it. This
  // loop is strictly sequential and that setting is not yet honoured. Recorded
  // rather than half-implemented: a bounded pool has to interact correctly
  // with the ordering above, with the throttle budget, and with the fact that
  // two actions for the same person are ordered relative to each other and
  // actions for different people are not. Sequential is slow and correct.

  let applied = 0;
  let failed = 0;
  let pendingRetry = 0;

  for (const action of actions) {
    if (action.requiresConfirmation && !confirmed) {
      // A rename, a re-enable outside the window, or a re-create of a vanished
      // account. Never auto-applied, and never unlocked by a caller that
      // merely passed the parameter.
      continue;
    }

    if ((SYNTRA_ONLY_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
      await applySyntraUserAction(tenantId, action.id, options.confirmedByUserId ?? null);
      applied += 1;
      continue;
    }

    const context = await withTenant(tenantId, async (tx) => {
      const account =
        action.accountId === null
          ? await tx.targetAccount.findFirst({
              where: {
                targetSystemId: prepared.run.targetSystemId,
                personId: action.personId ?? undefined,
              },
            })
          : await tx.targetAccount.findUnique({ where: { id: action.accountId } });
      const entitlement =
        action.entitlementId === null
          ? null
          : await tx.entitlement.findUnique({ where: { id: action.entitlementId } });

      // The entitlements Provision manages for this account: what it recorded
      // granting, narrowed to the remit. `archive_account` strips exactly
      // these and nothing else.
      const holdings =
        account === null || action.actionType !== 'archive_account'
          ? []
          : await tx.accountEntitlement.findMany({
              where: { accountId: account.id, state: 'held' },
              include: { entitlement: { select: { id: true, dn: true } } },
            });

      return {
        accountId: account?.id ?? null,
        anchor: account?.anchor ?? null,
        correlationKey:
          account?.correlationKey ??
          String(((action.after ?? {}) as Record<string, unknown>).correlationKey ?? ''),
        entitlementExternalId: entitlement?.externalId ?? null,
        entitlementDns: holdings
          .filter((h) => prepared.remit.has(h.entitlement.id))
          .map((h) => h.entitlement.dn)
          .filter((dn): dn is string => dn !== null),
      };
    });

    // Generated per create, here, and carried no further than the operation
    // and `finish`. Not stored on the action, not returned, not logged.
    const initialPassword =
      action.actionType === 'create_account'
        ? generateInitialPassword(
            (prepared.profile?.initialPasswordPolicy ?? {}) as InitialPasswordPolicy,
          )
        : '';

    const operation = toWriteOperation(action as ActionRow, {
      ...context,
      initialPassword,
    });
    if (operation === null) {
      await finish(tenantId, action.id, {
        ok: false,
        message: 'this action could not be expressed as a write operation',
        failure: 'rejected',
      });
      failed += 1;
      continue;
    }

    let attempts = action.attempts;
    let result: WriteResult | undefined;
    let throttledForMs = 0;

    for (;;) {
      // Step 1: mark in_flight and record the INTENT, committed before the
      // call. This is what makes the gap observable.
      await withTenant(tenantId, async (tx) => {
        await tx.provisionAction.update({
          where: { id: action.id },
          data: { status: 'in_flight' },
        });
        await recordEvent(tx, {
          actorUserId: options.confirmedByUserId ?? null,
          action: 'provision.action.intent',
          targetType: 'ProvisionAction',
          targetId: action.id,
          outcome: 'success',
          sourceIp: null,
          payload: { actionType: action.actionType, attempt: attempts + 1 },
        });
      });

      // Step 2: the connector call. No transaction. No connection held.
      result = await connector.write(prepared.config as never, operation);

      if (result.ok) break;

      if (result.failure === 'throttled') {
        // Not counted against maxAttempts: a throttle is the target asking for
        // patience, not the operation being wrong. Bounded all the same --
        // "not counted" is not "forever", and an unbounded wait here hangs the
        // apply and leaves the run `applying`, which the next run then has to
        // adopt.
        const wait = result.retryAfterMs ?? backoffMs(attempts + 1);
        if (throttledForMs + wait > THROTTLE_BUDGET_MS) {
          result = {
            ok: false,
            message: `the target has been throttling this action for ${Math.round(
              throttledForMs / 1000,
            )}s, past the ${THROTTLE_BUDGET_MS / 1000}s budget; the next run for this target picks it up`,
            failure: 'transient',
          };
          // Force the pending_retry branch rather than a failure: the action is
          // not wrong, the target is busy.
          attempts = prepared.target.maxAttempts;
          break;
        }
        throttledForMs += wait;
        await sleep(wait);
        continue;
      }

      if (!isRetryable(result.failure)) break;

      attempts += 1;
      if (attempts >= prepared.target.maxAttempts) break;
      await sleep(backoffMs(attempts));
    }

    attempts += 1;

    // Step 3: the outcome, the state change and the RESULT event, together.
    const outcome = await finish(tenantId, action.id, result!, {
      attempts,
      maxAttempts: prepared.target.maxAttempts,
      accountId: context.accountId,
      entitlementId: action.entitlementId,
      actorUserId: confirmed ? (options.confirmedByUserId ?? null) : null,
      provider,
      targetSystemId: prepared.run.targetSystemId,
      ...(action.actionType === 'create_account'
        ? {
            initialPassword,
            delivery: (prepared.profile?.initialPasswordDelivery ?? 'vaultOnly') as
              | 'manager'
              | 'personalEmail'
              | 'vaultOnly',
            ...(options.transport === undefined ? {} : { transport: options.transport }),
          }
        : {}),
    });

    if (outcome === 'applied') applied += 1;
    else if (outcome === 'pending_retry') pendingRetry += 1;
    else failed += 1;
  }

  return withTenant(tenantId, async (tx) => {
    const remaining = await tx.provisionAction.count({
      where: { runId, status: { in: ['proposed', 'pending_retry', 'in_flight'] } },
    });
    const anyFailed = await tx.provisionAction.count({
      where: { runId, status: { in: ['failed', 'conflict'] } },
    });
    // A run reaches `applied` only when every action it proposed reached a
    // terminal state and none failed.
    const status = remaining === 0 && anyFailed === 0 ? 'applied' : 'partially_applied';

    await tx.provisionRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date() },
    });
    if (status === 'applied' || applied > 0) {
      await tx.targetSystem.update({
        where: { id: prepared.run.targetSystemId },
        data: { lastAppliedRunAt: new Date() },
      });
    }
    await recordEvent(tx, {
      actorUserId: confirmed ? (options.confirmedByUserId ?? null) : null,
      action: 'provision.run.apply',
      targetType: 'ProvisionRun',
      targetId: runId,
      outcome: status === 'applied' ? 'success' : 'failure',
      sourceIp: null,
      payload: { status, applied, failed, pendingRetry },
    });

    const skipped = await tx.provisionAction.count({
      where: { runId, status: 'proposed' },
    });
    return { status, applied, failed, pendingRetry, skipped };
  });
}

/**
 * Step 3 for one action: the outcome, the inventory change and the result
 * audit event, in one transaction. Nothing here touches the network, which is
 * what makes that safe.
 */
interface FinishMeta {
  attempts?: number;
  maxAttempts?: number;
  accountId?: string | null;
  entitlementId?: string | null;
  actorUserId?: string | null;
  provider?: MasterKeyProvider;
  targetSystemId?: string;
  /** Present only on a create. Sealed here, delivered here, kept nowhere else. */
  initialPassword?: string;
  delivery?: 'manager' | 'personalEmail' | 'vaultOnly';
  transport?: Transport;
}

/** Where the message goes, resolved from the person and the delivery mode. */
async function resolveDeliveryAddress(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  personId: string | null,
  delivery: 'manager' | 'personalEmail' | 'vaultOnly',
): Promise<{ to: string | null; reason: string }> {
  if (delivery === 'vaultOnly' || personId === null) {
    return { to: null, reason: 'delivery mode is vaultOnly' };
  }
  if (delivery === 'personalEmail') {
    const person = await tx.person.findUnique({ where: { id: personId } });
    return person?.personalEmail
      ? { to: person.personalEmail, reason: 'personal email' }
      : { to: null, reason: 'this person has no personal email address recorded' };
  }
  // `manager`. The manager is on the CONTRACT, not on the person -- which is
  // also where department and dates live -- so it is read from the primary
  // contract, falling back to the lowest sequence.
  const contracts = await tx.contract.findMany({
    where: { personId, managerPersonId: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { sequence: 'asc' }],
    take: 1,
  });
  const managerPersonId = contracts[0]?.managerPersonId ?? null;
  if (managerPersonId === null) {
    return { to: null, reason: 'no contract for this person names a manager' };
  }
  const manager = await tx.person.findUnique({ where: { id: managerPersonId } });
  return manager?.businessEmail
    ? { to: manager.businessEmail, reason: 'manager business email' }
    : { to: null, reason: 'the named manager has no business email address recorded' };
}

async function finish(
  tenantId: string,
  actionId: string,
  result: WriteResult,
  meta: FinishMeta = {},
): Promise<'applied' | 'failed' | 'pending_retry' | 'conflict'> {
  const settled = await withTenant(tenantId, async (tx) => {
    const action = await tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } });

    let status: 'applied' | 'failed' | 'pending_retry' | 'conflict';
    if (result.ok) status = 'applied';
    else if (result.failure === 'conflict') status = 'conflict';
    else if (
      isRetryable(result.failure) &&
      (meta.attempts ?? 0) >= (meta.maxAttempts ?? 3)
    ) {
      // pending_retry rather than failed: the next run for this target picks
      // it up, provided the plan still wants it. A target that was down for a
      // night does not come back to a queue of decisions made against last
      // night's facts.
      status = 'pending_retry';
    } else status = 'failed';

    await tx.provisionAction.update({
      where: { id: actionId },
      data: {
        status,
        attempts: meta.attempts ?? action.attempts,
        message: result.message,
        ...(status === 'applied' ? { appliedAt: new Date() } : {}),
      },
    });

    if (status === 'applied' && meta.accountId) {
      const now = new Date();
      switch (action.actionType) {
        case 'create_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: {
              anchor: result.anchor ?? null,
              status: 'active',
              createdActionId: actionId,
              lastReconciledAt: now,
              lastAppliedAttributes: (
                (action.after ?? {}) as { attributes?: unknown }
              ).attributes as never,
            },
          });
          break;
        case 'update_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: {
              lastAppliedAttributes: (
                (action.after ?? {}) as { attributes?: unknown }
              ).attributes as never,
              lastReconciledAt: now,
            },
          });
          break;
        case 'enable_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: { status: 'active', disabledAt: null },
          });
          break;
        case 'disable_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: { status: 'disabled', disabledAt: now },
          });
          break;
        case 'archive_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: { status: 'archived' },
          });
          await tx.accountEntitlement.updateMany({
            where: { accountId: meta.accountId, state: 'held' },
            data: { state: 'revoked', revokedAt: now },
          });
          break;
        case 'rename_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: {
              correlationKey: String(
                ((action.after ?? {}) as Record<string, unknown>).correlationKey ?? '',
              ),
            },
          });
          break;
        case 'grant_entitlement':
          if (meta.entitlementId) {
            await tx.accountEntitlement.create({
              data: {
                tenantId: action.tenantId,
                accountId: meta.accountId,
                entitlementId: meta.entitlementId,
                origin: 'rule',
                grantedByRuleId: action.attributedRuleIds[0] ?? null,
              },
            });
          }
          break;
        case 'revoke_entitlement':
          if (meta.entitlementId) {
            await tx.accountEntitlement.updateMany({
              where: {
                accountId: meta.accountId,
                entitlementId: meta.entitlementId,
                state: 'held',
              },
              data: { state: 'revoked', revokedAt: now },
            });
          }
          break;
      }
    }

    /**
     * The initial password, sealed into the vault in the SAME transaction as
     * the state change that says the account exists.
     *
     * Global Constraint 14 and spec section 18. Without this the password is
     * written to the directory and dropped, so nobody -- not the person, not
     * their manager, not an administrator -- can ever obtain it, and no
     * account Provision creates is usable by the person it was created for.
     *
     * `putSecret` is a local AES operation against a row in this transaction,
     * not a network or KMS round trip, so it belongs here rather than outside
     * (Global Constraint 2). The message is queued AFTER the commit, below:
     * telling somebody their password before the row that says the account
     * exists has committed is the wrong order to fail in.
     */
    let deliver: { to: string; login: string; password: string } | null = null;
    let deliveryNote = 'not applicable';

    if (
      status === 'applied' &&
      action.actionType === 'create_account' &&
      meta.accountId &&
      meta.initialPassword &&
      meta.provider &&
      meta.targetSystemId
    ) {
      await putSecret(
        tx,
        meta.provider,
        `target/${meta.targetSystemId}/initial/${meta.accountId}`,
        meta.initialPassword,
      );

      const account = await tx.targetAccount.findUnique({ where: { id: meta.accountId } });
      const address = await resolveDeliveryAddress(
        tx,
        account?.personId ?? null,
        meta.delivery ?? 'vaultOnly',
      );
      deliveryNote = address.reason;
      if (address.to !== null && meta.transport !== undefined) {
        deliver = {
          to: address.to,
          login: account?.correlationKey ?? '',
          password: meta.initialPassword,
        };
      } else if (address.to !== null) {
        deliveryNote = `${address.reason}, but no message transport was configured for this apply; the password is in the vault and was not sent`;
      }

      await recordEvent(tx, {
        actorUserId: meta.actorUserId ?? null,
        action: 'provision.credential.sealed',
        targetType: 'TargetAccount',
        targetId: meta.accountId,
        outcome: 'success',
        sourceIp: null,
        // The secret's NAME and where it was sent. Never the secret, and never
        // the address of a person who was not sent anything.
        payload: {
          secretName: `target/${meta.targetSystemId}/initial/${meta.accountId}`,
          delivery: meta.delivery ?? 'vaultOnly',
          delivered: deliver !== null,
          note: deliveryNote,
        },
      });
    }

    if (status === 'conflict' && meta.accountId) {
      // Never a silent adoption: anybody able to create an object in the
      // target could otherwise choose a name that causes Syntra to hand them
      // an existing person's account.
      await tx.targetAccount.update({
        where: { id: meta.accountId },
        data: { status: 'conflict', statusReason: result.message },
      });
    }

    await recordEvent(tx, {
      actorUserId: meta.actorUserId ?? null,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: result.ok ? 'success' : 'failure',
      sourceIp: null,
      payload: {
        actionType: action.actionType,
        status,
        // The connector's own message. Never a password: no code path puts one
        // in a WriteResult, and no code path puts `unicodePwd` in one either.
        message: result.message,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      },
    });

    return { status, deliver };
  });

  // After the commit, and fire-and-forget. `queueMessage` never rejects and
  // never blocks: a dead mail server must not turn a committed apply into a
  // failure, and it reports its own failure to the log and the audit trail.
  if (settled.deliver !== null && meta.transport !== undefined) {
    queueMessage(
      meta.transport,
      {
        to: settled.deliver.to,
        subject: 'Your new account',
        text: `An account has been created for you.\n\nUsername: ${settled.deliver.login}\nPassword: ${settled.deliver.password}\n\nYou will be asked to change it when you first sign in.`,
        html: `<p>An account has been created for you.</p><p>Username: <code>${settled.deliver.login}</code><br>Password: <code>${settled.deliver.password}</code></p><p>You will be asked to change it when you first sign in.</p>`,
      },
      {
        tenantId,
        userId: null,
        // The label, never the body. A delivery-failure audit row is the last
        // place a live credential should end up.
        purpose: 'provision.initial-password',
      },
    );
  }

  return settled.status;
}

/**
 * Resolves actions left `in_flight` by a process that died between step 2 and
 * step 3.
 *
 * An action found `in_flight` is in an *unknown* state, not a failed one, and
 * a run resolves it before planning anything: it reads the target and asks
 * whether the write landed, using the provenance marker for creates.
 *
 * **For the other seven operations it does not compare state, and does not
 * claim to.** They are set back to `proposed` and the next plan decides again.
 * That is safe because those seven are idempotent -- `update_account` writes
 * the complete desired set, `enable`/`disable` assert a state rather than
 * toggling it, and grant and revoke are set operations -- so replaying one
 * that already landed produces the same result. It is written down here
 * because an earlier docstring said "plain state comparison for everything
 * else", which was not true and would have been read as a guarantee by the
 * next person to add a non-idempotent operation.
 */
export async function resolveInFlightActions(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  options: { connector?: TargetConnector<never> } = {},
): Promise<number> {
  const connector = (options.connector ??
    adTargetConnector) as unknown as TargetConnector<unknown>;

  const prepared = await withTenant(tenantId, async (tx) => {
    const config = await targetWithCredential(tx, provider, targetSystemId);
    if (!config) throw new Error('target configuration or credential missing');
    const actions = await tx.provisionAction.findMany({
      where: { status: 'in_flight', run: { targetSystemId } },
    });
    return { config, actions };
  });

  let resolved = 0;
  if (prepared.actions.length === 0) return 0;

  // ONCE, outside any transaction, before the loop. Reading the whole target
  // per in-flight action means a process that died with forty actions in
  // flight reads the entire directory forty times, and every one of those
  // reads returns the same answer.
  const objects: { anchor: string; correlationKey: string; provenance: string | null }[] = [];
  for await (const record of connector.read(prepared.config as never)) {
    objects.push({
      anchor: record.anchor,
      correlationKey: record.attributes.sAMAccountName?.[0] ?? '',
      provenance: record.attributes.info?.[0] ?? null,
    });
  }

  for (const action of prepared.actions) {
    const after = (action.after ?? {}) as Record<string, unknown>;
    const key = String(after.correlationKey ?? '');
    const landed = objects.find(
      (o) => o.correlationKey === key && (o.provenance ?? '').includes(action.id),
    );

    await withTenant(tenantId, async (tx) => {
      if (action.actionType === 'create_account' && landed) {
        // Our own previous attempt succeeded and we lost the answer.
        await tx.provisionAction.update({
          where: { id: action.id },
          data: {
            status: 'applied',
            appliedAt: new Date(),
            message: 'resolved after an interrupted apply: the write had landed',
          },
        });
        const account = await tx.targetAccount.findFirst({
          where: { targetSystemId, correlationKey: key },
        });
        if (account) {
          await tx.targetAccount.update({
            where: { id: account.id },
            data: { anchor: landed.anchor, status: 'active', createdActionId: action.id },
          });
        }
      } else {
        // It did not land. Back to proposed, so the plan decides again.
        await tx.provisionAction.update({
          where: { id: action.id },
          data: {
            status: 'proposed',
            message: 'resolved after an interrupted apply: the write had not landed',
          },
        });
      }
      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.action.resolve_in_flight',
        targetType: 'ProvisionAction',
        targetId: action.id,
        outcome: 'success',
        sourceIp: null,
        payload: { actionType: action.actionType, landed: landed !== undefined },
      });
    });
    resolved += 1;
  }

  return resolved;
}
```

- [ ] **Step 4: Fill the in-flight seam Task 13 left in the adoption**

Task 13 defined `previewProvisionRun`'s `resolveInFlight` option and defaulted it to a no-op, because `resolveInFlightActions` did not exist yet. Fill it now.

In `packages/core/src/provision/run-service.ts`, add the import:

```ts
import { resolveInFlightActions } from './apply.js';
```

and change the default in `previewProvisionRun` from the no-op to the real function:

```ts
  // Inside `adoptStaleRunsAndStart`, before a new run is created and outside
  // any transaction. An action left `in_flight` by a dead process is in an
  // UNKNOWN state -- not a failed one -- and it has to be asked about against
  // the target before anything new is planned.
  const resolveInFlight =
    options.resolveInFlight ??
    ((id: string) =>
      resolveInFlightActions(tenantId, provider, id, {
        ...(options.connector === undefined ? {} : { connector: options.connector }),
      }));
```

**Placement is the whole point of this step.** The first draft inserted the call *after* phase 1, as a separate phase 3. Phase 1 creates the run, the partial unique index refuses a second non-terminal run for the target, and a run left `applying` by a dead process is exactly the state that makes the create throw — so the call sat behind a line that always threw first, and spec §14's in-flight resolution could never run on the production path. Its two unit tests passed the whole time, because they call `resolveInFlightActions` directly.

The test that proves the seam is wired is `starts a new run after a process died mid-apply, and resolves what it left in flight` in step 1: it goes through `previewProvisionRun`, not through `resolveInFlightActions`.

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/apply.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/apply.test.ts`
Expected: PASS, 20 tests.

"never puts a network call inside a transaction" is the one that guards the Critical this programme has shipped three times. It reads the action's status from a *separate* transaction while the connector call is in progress; that read can only see `in_flight` if step 1 committed before step 2 began.

Two others are worth watching the first time they run. "seals the initial password into the vault and never writes it anywhere else" fails in two different ways for two different reasons — a missing `Secret` row means the credential is unreachable and the account unusable, while a hit on the password inside the serialised actions and audit events means a live credential is now in a table an auditor reads. And "applies a confirmed run and records the confirming user" asserts a real user id: the version it replaces asserted `null`, which was true precisely because the gate could be satisfied without anybody confirming anything.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: apply provisioning runs with retry and in-flight resolution"
```

---

## Task 15: The Syntra-user seam — claiming, deactivation, and the paired sync

**Files:**
- Create: `packages/core/src/provision/syntra-user.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/syntra-user.test.ts`

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `recordEvent`; `SYNC_JOB`, `syncJobPayload` from `../sync/jobs.js`; `type Scheduler` from `../jobs/scheduler.js`.

> **Dispatch order: this task runs BEFORE Task 14**, which hard-imports
> `applySyntraUserAction` from the module this task creates. Nothing here depends
> on Task 14.
- Produces:
  - `async function claimSyntraUsers(tenantId: string, targetSystemId: string): Promise<{ claimed: number; conflicts: number }>`
  - `async function applySyntraUserAction(tenantId: string, actionId: string, actorUserId: string | null): Promise<void>`
  - `async function enqueuePairedSync(scheduler: Scheduler, tenantId: string, targetSystemId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/syntra-user.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { SYNC_JOB } from '../sync/jobs.js';
import {
  applySyntraUserAction,
  claimSyntraUsers,
  enqueuePairedSync,
} from './syntra-user.js';

let tenantId: string;
let targetId: string;
let sourceId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const source = await tx.directorySource.create({
      data: {
        tenantId,
        name: 'Acme AD read',
        config: {},
        secretName: 'source/bind',
      },
    });
    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'Acme AD write',
        config: { tlsMode: 'ldaps', url: 'ldaps://dc.acme.test:636' },
        secretName: 'target/bind',
        pairedDirectorySourceId: source.id,
      },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    return { sourceId: source.id, targetId: target.id, personId: person.id };
  });
  sourceId = seeded.sourceId;
  targetId = seeded.targetId;
  personId = seeded.personId;
});

describe('claimSyntraUsers', () => {
  it('links a user to the person whose account carries the same anchor', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
        },
      });
    });

    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    // Ownership is established by the anchor both subsystems already agree on,
    // never by a name.
    expect(user.personId).toBe(personId);
  });

  it('leaves a user already linked to a different person and reports drift', async () => {
    const otherPersonId = await withTenant(tenantId, async (tx) => {
      const other = await tx.person.create({
        data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
          personId: other.id,
        },
      });
      return other.id;
    });

    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 1,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    expect(user.personId).toBe(otherPersonId);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).toContain('unexpected_status');
    // Recorded with no run in flight. This fixture seeds none, and resolving
    // one with `findFirstOrThrow` turned the drift report into an exception --
    // so this test failed for a reason that had nothing to do with what it was
    // testing.
    expect(findings[0]!.runId).toBeNull();
    // And its own fingerprint, so it cannot overwrite reconcile's
    // account-status finding about the same account.
    expect(findings[0]!.fingerprint).toMatch(/:syntra_user_link$/);
  });

  it('claims nothing when the target has no paired source', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: null },
      }),
    );
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('never matches on login when the anchors differ', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'a-completely-different-guid',
        },
      });
    });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });
});

describe('applySyntraUserAction', () => {
  const seedAction = async (actionType: string, userStatus: string) =>
    withTenant(tenantId, async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
          personId,
          status: userStatus,
        },
      });
      const run = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying' },
      });
      const action = await tx.provisionAction.create({
        data: {
          tenantId,
          runId: run.id,
          actionType,
          personId,
          after: { userId: user.id, status: actionType === 'deactivate_syntra_user' ? 'inactive' : 'active' },
        },
      });
      return { userId: user.id, actionId: action.id };
    });

  it('deactivates the user and writes the audit event in the same transaction', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await applySyntraUserAction(tenantId, actionId, null);

    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    // Without this, a leaver whose AD account Provision has just disabled
    // still holds a live Syntra login with a Syntra-held password.
    expect(user.status).toBe('inactive');

    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('applied');

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetId: actionId } }),
    );
    // Exactly one event: these two action types call no connector, so there is
    // no intent-then-result pair and no in-flight state to resolve.
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('provision.action.result');
  });

  it('reactivates the user', async () => {
    const { userId, actionId } = await seedAction('reactivate_syntra_user', 'inactive');
    await applySyntraUserAction(tenantId, actionId, null);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('active');
  });

  it('writes nothing else about the user', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    const before = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    await applySyntraUserAction(tenantId, actionId, null);
    const after = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    // Not its mapped fields, not its memberships, not its person link.
    expect(after.displayName).toBe(before.displayName);
    expect(after.email).toBe(before.email);
    expect(after.personId).toBe(before.personId);
  });
});

describe('enqueuePairedSync', () => {
  it('enqueues a run of the paired directory source', async () => {
    const enqueue = vi.fn(async () => 'job-1');
    const scheduler = { enqueue } as never;
    expect(await enqueuePairedSync(scheduler, tenantId, targetId)).toBe(true);
    // An existing job on an existing queue, not a new mechanism. A freshly
    // provisioned person cannot sign in to Syntra until the next directory
    // sync, and this is the cheap mitigation.
    expect(enqueue).toHaveBeenCalledWith(SYNC_JOB, { tenantId, sourceId });
  });

  it('does nothing when there is no paired source', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: null },
      }),
    );
    const enqueue = vi.fn();
    expect(
      await enqueuePairedSync({ enqueue } as never, tenantId, targetId),
    ).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/syntra-user.test.ts`
Expected: FAIL — cannot find module `./syntra-user.js`.

- [ ] **Step 3: Write the Syntra-user module**

`packages/core/src/provision/syntra-user.ts`:

```ts
import { withTenant } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { SYNC_JOB, syncJobPayload } from '../sync/jobs.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { driftFingerprint } from './reconcile.js';

/**
 * Claims the Syntra users that correspond to accounts Provision owns.
 *
 * Provision does not create the Syntra `User` — Directory Sync does, on the
 * return leg, anchored on `objectGUID`. Once it exists, Provision claims it:
 * a `TargetAccount` whose anchor matches a `User` carrying the same
 * `sourceAnchor` on the paired source, and whose `personId` is null, has that
 * user's `personId` set to the account's person.
 *
 * **Ownership is established by the anchor both subsystems already agree on,
 * never by a name.** A `User` that already carries a different `personId` is
 * left alone and reported as drift.
 */
export async function claimSyntraUsers(
  tenantId: string,
  targetSystemId: string,
): Promise<{ claimed: number; conflicts: number }> {
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    if (target.pairedDirectorySourceId === null) return { claimed: 0, conflicts: 0 };

    const accounts = await tx.targetAccount.findMany({
      where: { targetSystemId, anchor: { not: null } },
    });
    if (accounts.length === 0) return { claimed: 0, conflicts: 0 };

    const users = await tx.user.findMany({
      where: {
        sourceId: target.pairedDirectorySourceId,
        sourceAnchor: { in: accounts.map((a) => a.anchor!) },
      },
    });
    const userByAnchor = new Map(users.map((u) => [u.sourceAnchor, u]));

    let claimed = 0;
    let conflicts = 0;
    const seenAt = new Date();

    for (const account of accounts) {
      const user = userByAnchor.get(account.anchor!);
      if (!user) continue;

      if (user.personId === null) {
        await tx.user.update({
          where: { id: user.id },
          data: { personId: account.personId },
        });
        claimed += 1;
        continue;
      }

      if (user.personId !== account.personId) {
        conflicts += 1;
        // Its OWN subject. `driftFingerprint('unexpected_status', accountId,
        // null)` is exactly the fingerprint `reconcile` uses for account
        // status drift, so the two findings would key on the same row and
        // overwrite each other on alternate runs -- the dashboard showing one
        // and never both.
        const fingerprint = driftFingerprint(
          'unexpected_status',
          account.id,
          null,
          'syntra_user_link',
        );
        // `findFirst`, and nullable. This function is called from the apply
        // route and from the job, and a target can legitimately have no run at
        // all -- a link established by hand, a first claim. `findFirstOrThrow`
        // turned "there is drift here" into an exception, which is why
        // `DriftFinding.runId` is nullable in Task 1.
        const run = await tx.provisionRun.findFirst({
          where: { targetSystemId },
          orderBy: { startedAt: 'desc' },
        });
        await tx.driftFinding.upsert({
          where: {
            tenantId_targetSystemId_fingerprint: {
              tenantId: bound,
              targetSystemId,
              fingerprint,
            },
          },
          create: {
            tenantId: bound,
            targetSystemId,
            runId: run?.id ?? null,
            accountId: account.id,
            entitlementId: null,
            subjectAnchor: null,
            kind: 'unexpected_status',
            detail: {
              reason:
                'the Syntra user carrying this account anchor is already linked to a different person',
              userId: user.id,
              linkedPersonId: user.personId,
              accountPersonId: account.personId,
            } as never,
            fingerprint,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
          },
          update: { lastSeenAt: seenAt },
        });
      }
    }

    return { claimed, conflicts };
  });
}

/**
 * Applies one of the two actions that call no connector at all.
 *
 * These are writes to Syntra's own directory, and are therefore the only two
 * that apply inside a single transaction with their audit event and need no
 * in-flight resolution — there is no gap between a write and its record,
 * because both are in the same commit.
 *
 * Nothing else about the user is written: not its mapped fields, not its
 * memberships, not its person link. A synced `GroupMembership` is owned by its
 * directory source and rewritten every run; a second writer would lose that
 * argument every night.
 */
export async function applySyntraUserAction(
  tenantId: string,
  actionId: string,
  actorUserId: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const action = await tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } });
    const after = (action.after ?? {}) as { userId?: string; status?: string };
    if (after.userId === undefined) {
      throw new Error('this action names no Syntra user');
    }

    const status =
      action.actionType === 'deactivate_syntra_user' ? 'inactive' : 'active';

    await tx.user.update({ where: { id: after.userId }, data: { status } });

    await tx.provisionAction.update({
      where: { id: actionId },
      data: { status: 'applied', appliedAt: new Date(), attempts: 1 },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: 'success',
      sourceIp: null,
      payload: { actionType: action.actionType, userId: after.userId, status },
    });
  });
}

/**
 * Enqueues a run of the paired directory source after a successful apply that
 * created or enabled accounts.
 *
 * A freshly provisioned person cannot sign in to Syntra until the next
 * directory sync: Provision creates the account in Active Directory, and the
 * Syntra `User` for it appears when the paired source next runs. That is not a
 * defect of either subsystem, it is the cost of one-directional flow, and this
 * is the cheap mitigation — an existing job on an existing queue.
 */
export async function enqueuePairedSync(
  scheduler: Scheduler,
  tenantId: string,
  targetSystemId: string,
): Promise<boolean> {
  const sourceId = await withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    return target.pairedDirectorySourceId;
  });
  if (sourceId === null) return false;
  await scheduler.enqueue(SYNC_JOB, syncJobPayload(tenantId, sourceId));
  return true;
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/syntra-user.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/syntra-user.test.ts`
Expected: PASS, 9 tests.

"never matches on login when the anchors differ" is what keeps this from becoming the defect Directory Sync already learned: a name is not an identity.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: claim Syntra users and propagate account status inward"
```

---

## Task 16: Jobs, scheduling, and the loud skip

Ruling P4: a superseded or skipped scheduled run must be surfaced **where someone looks**, and a target that has skipped repeatedly must be visibly distinguishable from one running cleanly. "It is recorded in an audit event" is explicitly not sufficient.

**Files:**
- Create: `packages/core/src/provision/jobs.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/provision/jobs.test.ts`

**Interfaces:**
- Consumes: `previewProvisionRun`; `applyProvisionRun`; `claimSyntraUsers`, `enqueuePairedSync`; `type Scheduler`, `withTenant`, `recordEvent`, `type MasterKeyProvider`.
- Produces:
  - `const PROVISION_JOB = 'provision.run'`
  - `interface ProvisionJobPayload { tenantId: string; targetSystemId: string }`
  - `function provisionJobPayload(tenantId: string, targetSystemId: string): ProvisionJobPayload`
  - `function provisionScheduleKey(tenantId: string, targetSystemId: string): string`
  - `interface SchedulableTarget { id: string; schedule: string | null; enabled: boolean }`
  - `async function applyTargetSchedule(scheduler: Scheduler, tenantId: string, target: SchedulableTarget): Promise<void>`
  - `async function removeTargetSchedule(scheduler: Scheduler, tenantId: string, targetSystemId: string): Promise<void>`
  - `async function runProvisionJob(scheduler: Scheduler, provider: MasterKeyProvider, payload: ProvisionJobPayload, options?: { connector?: TargetConnector<never>; transport?: Transport }): Promise<void>`
  - `function registerProvisionJobs(scheduler: Scheduler, provider: MasterKeyProvider, transport: Transport): void`

`options.connector` is the seam every other entry point in this plan already has. Without it `runProvisionJob` always uses `adTargetConnector`, so its own tests — the two that take the `proceed` branch — dial `ldaps://dc.acme.test:636`, `previewProvisionRun` marks the run `failed` and rethrows, the calls reject, and the assertions after them never run at all. `registerProvisionJobs` keeps calling it with no options, so production is unchanged.
  - `function registerProvisionJobs(scheduler: Scheduler, provider: MasterKeyProvider): void`

- [ ] **Step 1: Write the failing test**

`packages/core/src/provision/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile } from './target-service.js';
import { ProvisionRunInFlightError } from './run-service.js';
import {
  PROVISION_JOB,
  applyTargetSchedule,
  provisionScheduleKey,
  removeTargetSchedule,
  runProvisionJob,
} from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let targetId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

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
  // No network. Every other entry point in this plan takes a connector; this
  // one has to as well, or the two tests below that actually start a run reach
  // for a domain controller that does not exist, the promise rejects, and
  // every assertion after the call is unreachable.
  target = new FakeTarget();
  target.containers.push('OU=Users,DC=acme,DC=test');
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
    schedule: '0 2 * * *',
  });
  targetId = created.id;
  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: {},
    initialPasswordPolicy: {},
    initialPasswordDelivery: 'vaultOnly',
  });
});

describe('provisionScheduleKey', () => {
  it('names both the tenant and the target', () => {
    // pg-boss keys its schedule table on (queue, key) with key defaulting to
    // the empty string. Every directory source once shared one, and only the
    // last one scheduled ever ran.
    expect(provisionScheduleKey('tenant-a', 'target-b')).toBe('tenant-a/target-b');
  });
});

describe('applyTargetSchedule', () => {
  it('schedules an enabled target with a cron expression under its own key', async () => {
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: '0 2 * * *',
      enabled: true,
    });
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      '0 2 * * *',
      { tenantId, targetSystemId: targetId },
      `${tenantId}/${targetId}`,
    );
  });

  it('unschedules a disabled target rather than skipping it', async () => {
    // Skipping would be right only if it had never been scheduled; for a
    // target that just had `enabled` turned off it would leave the old
    // schedule firing against a target the administrator believes is stopped.
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: '0 2 * * *',
      enabled: false,
    });
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules a target whose cron expression was cleared', async () => {
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: null,
      enabled: true,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
  });
});

describe('removeTargetSchedule', () => {
  it('removes the schedule under the same key', async () => {
    const scheduler = schedulerStub();
    await removeTargetSchedule(scheduler as never, tenantId, targetId);
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
  });
});

describe('runProvisionJob — the skip, made loud', () => {
  const seedAwaitingReview = () =>
    withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'first run',
        },
      }),
    );

  it('does not start while a run is awaiting review, and records the skip on the target', async () => {
    await seedAwaitingReview();
    const scheduler = schedulerStub();
    await runProvisionJob(scheduler as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });

    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Ruling P4: on the target's own row, where somebody looks. Not only in an
    // audit event.
    expect(target.consecutiveSkippedRuns).toBe(1);
    expect(target.lastSkippedAt).not.toBeNull();
    expect(target.lastSkipReason).toContain('awaiting review');

    // And the run awaiting review is untouched.
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('blocked');
  });

  it('counts consecutive skips so a repeatedly skipping target is distinguishable', async () => {
    await seedAwaitingReview();
    const scheduler = schedulerStub();
    for (let i = 0; i < 3; i += 1) {
      await runProvisionJob(scheduler as never, provider, {
        tenantId,
        targetSystemId: targetId,
      });
    }
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target.consecutiveSkippedRuns).toBe(3);
  });

  it('audits the skip as well, in addition to the visible counter', async () => {
    await seedAwaitingReview();
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.run.skipped' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('resets the skip counter once a run actually starts', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          consecutiveSkippedRuns: 4,
          lastSkippedAt: new Date(),
          lastSkipReason: 'awaiting review',
        },
      }),
    );
    const scheduler = schedulerStub();
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
    expect(row.lastSkipReason).toBeNull();
  });

  it('does nothing for a disabled target', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { enabled: false } }),
    );
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toEqual([]);
  });

  it('does not apply a blocked run even with autoApply on', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const run = await withTenant(tenantId, (tx) => tx.provisionRun.findFirstOrThrow({}));
    // A first run is always blocked pending confirmation, and the scheduler
    // never confirms anything.
    expect(run.status).toBe('blocked');
    expect(run.confirmedByUserId).toBeNull();
  });

  it('does not start while a run is still `running`, and records that skip too', async () => {
    // `running` is one of the four statuses the partial unique index covers.
    // Omitting it from this check means the scheduler keeps firing into a
    // target whose create will throw, and does not even record a skip -- so a
    // target that has been unrunnable since a crash looks exactly like one
    // running cleanly.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'running' },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('running');
  });

  it('records a loud skip rather than throwing when a run is already in progress', async () => {
    // `ProvisionRunInFlightError` reaches this handler by two routes. The skip
    // check above catches the ordinary one, in its own transaction, and this
    // asserts the other: the run is created between that check and the create,
    // the partial unique index refuses it, and Task 13 converts the P2002 into
    // this error. Simulated by having the preview raise it directly, because
    // the real trigger is a race between two processes and a test that tried
    // to stage one would be asserting the scheduler's timing rather than this
    // handler's behaviour.
    const scheduler = schedulerStub();
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        connector: target as never,
        preview: async () => {
          throw new ProvisionRunInFlightError(targetId);
        },
      },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Recorded where somebody looks, and not thrown: a job that throws here
    // is retried by pg-boss into the same refusal.
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('already in progress');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/src/provision/jobs.test.ts`
Expected: FAIL — cannot find module `./jobs.js`.

- [ ] **Step 3: Write the jobs module**

`packages/core/src/provision/jobs.ts`:

```ts
import { withTenant } from '@syntra/db';
import type { TargetConnector } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { Transport } from '../notify/notification-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { applyProvisionRun } from './apply.js';
import { ProvisionRunInFlightError, previewProvisionRun } from './run-service.js';
import { claimSyntraUsers, enqueuePairedSync } from './syntra-user.js';

export const PROVISION_JOB = 'provision.run';

export interface ProvisionJobPayload {
  tenantId: string;
  targetSystemId: string;
}

/** A background job has no request and therefore no bound tenant. */
export function provisionJobPayload(
  tenantId: string,
  targetSystemId: string,
): ProvisionJobPayload {
  return { tenantId, targetSystemId };
}

/**
 * The schedule key for one target on the shared `provision.run` queue.
 *
 * pg-boss keys its schedule table on `(queue name, key)`, and `key` defaults
 * to the empty string — so without this, every target scheduled on this queue
 * writes the same row and only the last one survives. That exact bug shipped
 * once on the sync queue: all sources shared `key: ''` and only the last one
 * in the last tenant ever ran. The tenant is in the key as well as the target
 * because the schedule table is where anyone debugging a schedule that did not
 * fire will be looking.
 */
export function provisionScheduleKey(
  tenantId: string,
  targetSystemId: string,
): string {
  return `${tenantId}/${targetSystemId}`;
}

export interface SchedulableTarget {
  id: string;
  schedule: string | null;
  enabled: boolean;
}

export async function applyTargetSchedule(
  scheduler: Scheduler,
  tenantId: string,
  target: SchedulableTarget,
): Promise<void> {
  const key = provisionScheduleKey(tenantId, target.id);
  // Unscheduled rather than skipped: skipping would leave the old schedule
  // firing against a target the administrator believes is stopped.
  if (!target.enabled || !target.schedule) {
    await scheduler.unschedule(PROVISION_JOB, key);
    return;
  }
  await scheduler.schedule(
    PROVISION_JOB,
    target.schedule,
    provisionJobPayload(tenantId, target.id),
    key,
  );
}

export async function removeTargetSchedule(
  scheduler: Scheduler,
  tenantId: string,
  targetSystemId: string,
): Promise<void> {
  await scheduler.unschedule(
    PROVISION_JOB,
    provisionScheduleKey(tenantId, targetSystemId),
  );
}

/**
 * One scheduled provisioning run.
 *
 * **A scheduled run does not start while a run is awaiting review**, and the
 * skip is recorded where somebody looks: `consecutiveSkippedRuns`,
 * `lastSkippedAt` and `lastSkipReason` on the target's own row, which the
 * targets list and the target's screen both render (Ruling P4). Without the
 * skip rule, a target whose runs require confirmation accumulates a queue of
 * blocked runs that can never be cleared, and the review screen becomes a
 * thing people stop opening. Without the counter, a target that has silently
 * skipped for a fortnight looks exactly like one running cleanly.
 */
export interface RunProvisionJobOptions {
  /**
   * The connector to run against. Every other entry point in this plan takes
   * one; without it here, the job's own tests reach for a real domain
   * controller, `previewProvisionRun` marks the run failed and rethrows, and
   * every assertion after the call is unreachable.
   */
  connector?: TargetConnector<never>;
  /**
   * How a created account's initial password is delivered.
   *
   * An unattended `autoApply` run creates accounts, and without a transport
   * here every one of those passwords is sealed into the vault and delivered
   * to nobody -- which is the whole of Ruling P12 reintroduced on the one path
   * where no human is watching. `registerProvisionJobs` takes it and passes it
   * down.
   */
  transport?: Transport;
  /** Injected only by the test that proves the in-flight refusal is recorded. */
  preview?: typeof previewProvisionRun;
}

/**
 * Records a skipped scheduled run where somebody looks.
 *
 * Ruling P4: on the target's own row, which the targets list and the target's
 * screen both render — not only in an audit event. The audit event is written
 * as well, and in addition rather than instead.
 */
async function recordSkip(
  tenantId: string,
  targetSystemId: string,
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        consecutiveSkippedRuns: { increment: 1 },
        lastSkippedAt: new Date(),
        lastSkipReason: reason,
      },
    });
    await recordEvent(tx, {
      actorUserId: null,
      action: 'provision.run.skipped',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'failure',
      sourceIp: null,
      payload: { reason, ...detail },
    });
  });
}

export async function runProvisionJob(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  payload: ProvisionJobPayload,
  options: RunProvisionJobOptions = {},
): Promise<void> {
  const preview = options.preview ?? previewProvisionRun;
  const decision = await withTenant(payload.tenantId, async (tx) => {
    const target = await tx.targetSystem.findUnique({
      where: { id: payload.targetSystemId },
    });
    if (!target || !target.enabled) return { proceed: false as const, reason: null };

    // All FOUR non-terminal statuses, matching `provision_run_one_non_terminal`
    // exactly. Omitting `running` means the scheduler keeps firing at a target
    // whose create the index will refuse, and records nothing -- so a target
    // that has been unrunnable since a crash is indistinguishable from one
    // running cleanly, which is precisely what Ruling P4 forbids.
    const awaiting = await tx.provisionRun.findFirst({
      where: {
        targetSystemId: payload.targetSystemId,
        status: { in: ['running', 'previewed', 'blocked', 'applying'] },
      },
    });
    if (awaiting) {
      const reason = `a run from ${awaiting.startedAt.toISOString()} is awaiting review (${awaiting.status}), so this scheduled run did not start`;
      await tx.targetSystem.update({
        where: { id: payload.targetSystemId },
        data: {
          consecutiveSkippedRuns: { increment: 1 },
          lastSkippedAt: new Date(),
          lastSkipReason: reason,
        },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.run.skipped',
        targetType: 'TargetSystem',
        targetId: payload.targetSystemId,
        outcome: 'failure',
        sourceIp: null,
        payload: { reason, blockedRunId: awaiting.id },
      });
      return { proceed: false as const, reason };
    }

    // A run is actually starting, so the skip streak is over.
    await tx.targetSystem.update({
      where: { id: payload.targetSystemId },
      data: {
        consecutiveSkippedRuns: 0,
        lastSkippedAt: null,
        lastSkipReason: null,
      },
    });
    return { proceed: true as const, autoApply: target.autoApply };
  });

  if (!decision.proceed) return;

  let run;
  try {
    run = await preview(payload.tenantId, provider, payload.targetSystemId, {
      ...(options.connector === undefined ? {} : { connector: options.connector }),
    });
  } catch (cause) {
    // The skip check above and the create are in different transactions, so
    // another process can start a run between them. The partial unique index
    // refuses the second one -- which is correct -- and this records it the
    // same loud way rather than letting an opaque Prisma error fail the job
    // and be retried into the same refusal.
    if (cause instanceof ProvisionRunInFlightError) {
      await recordSkip(payload.tenantId, payload.targetSystemId, cause.message);
      return;
    }
    throw cause;
  }

  // The guard is not advisory. A blocked run does not apply, and autoApply
  // does not override it — an unattended schedule is exactly the case it
  // exists for. Note what is NOT passed: no `confirm`, and no
  // `confirmedByUserId`. The scheduler never confirms anything.
  if (decision.autoApply && run.status === 'previewed') {
    const result = await applyProvisionRun(payload.tenantId, provider, run.id, {
      ...(options.connector === undefined ? {} : { connector: options.connector }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    if (result.applied > 0) {
      await claimSyntraUsers(payload.tenantId, payload.targetSystemId);
      // A freshly provisioned person cannot sign in until the next directory
      // sync; this is the cheap mitigation.
      await enqueuePairedSync(scheduler, payload.tenantId, payload.targetSystemId);
    }
  }
}

export function registerProvisionJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  transport: Transport,
): void {
  // The real connector and no injected preview. The transport is not optional
  // at this seam: an unattended autoApply run creates accounts, and a job
  // registered without one delivers no initial password to anybody.
  scheduler.register<ProvisionJobPayload>(PROVISION_JOB, (payload) =>
    runProvisionJob(scheduler, provider, payload, { transport }),
  );
}
```

- [ ] **Step 4: Reconcile the schedule on every create, update and delete**

In `packages/core/src/provision/target-service.ts`, the three mutations must reconcile the scheduler immediately, or a target created with a cron expression is not scheduled until the process restarts. All three signatures are written out here, in full, because Task 17 already calls all three with the extra argument and a "make the equivalent change" instruction is the one place left in this plan where an implementer would have to guess.

First, the imports:

```ts
import type { Scheduler } from '../jobs/scheduler.js';
import { applyTargetSchedule, removeTargetSchedule } from './jobs.js';
```

**`createTarget`.** Signature:

```ts
export async function createTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  input: CreateTargetInput,
  scheduler?: Scheduler,
): Promise<{ id: string }> {
```

Change the body's `return withTenant(tenantId, async (tx) => { ... })` to `const created = await withTenant(tenantId, async (tx) => { ... });` — the block itself is unchanged and still ends `return { id: target.id };` — then append, after it:

```ts
  // Reconciled OUTSIDE the transaction. pg-boss writes to its own tables on
  // its own connection: a schedule write inside this transaction would neither
  // roll back with it nor be covered by it.
  if (scheduler) {
    await applyTargetSchedule(scheduler, tenantId, {
      id: created.id,
      schedule: input.schedule ?? null,
      enabled: input.enabled ?? true,
    });
  }
  return created;
```

**`updateTarget`.** Signature:

```ts
export async function updateTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
  input: UpdateTargetInput,
  scheduler?: Scheduler,
): Promise<void> {
```

The `withTenant` block is unchanged except that it now returns the two fields the reconciliation needs, read AFTER the update so a cleared cron expression or a disabled target is seen as it now stands rather than as it was:

```ts
  const after = await withTenant(tenantId, async (tx) => {
    // ... existing body, unchanged, up to and including recordEvent ...
    const row = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetId },
      select: { schedule: true, enabled: true },
    });
    return row;
  });

  if (scheduler) {
    await applyTargetSchedule(scheduler, tenantId, {
      id: targetId,
      schedule: after.schedule,
      enabled: after.enabled,
    });
  }
```

**`deleteTarget`.** Signature:

```ts
export async function deleteTarget(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  confirm: boolean,
  scheduler?: Scheduler,
): Promise<{ ok: boolean; counts?: Record<string, number> }> {
```

The `withTenant` block is unchanged. After it, and only when the delete actually happened:

```ts
  const result = await withTenant(tenantId, async (tx) => { /* unchanged */ });
  if (result.ok && scheduler) {
    // A schedule left behind fires forever at a target that no longer exists,
    // and the handler's `findUnique` returns null every time -- a job that
    // fails silently on a timer nobody remembers setting.
    await removeTargetSchedule(scheduler, tenantId, targetId);
  }
  return result;
```

Nothing in Task 12's own tests passes a scheduler, so they are unaffected; the parameter is optional for exactly that reason.

- [ ] **Step 5: Register the jobs at boot**

Both edits are in `apps/api/src/scheduler.ts`, not `server.ts` — that is where `registerSyncJobs` and `registerKeyRotationJob` are called and where `scheduleBackgroundWork` reconciles every source at boot.

In `startSyncScheduler`, beside the two existing registrations:

```ts
    registerSyncJobs(scheduler, provider);
    registerKeyRotationJob(scheduler, provider);
    registerProvisionJobs(scheduler, provider, transport);
```

`startSyncScheduler` does not currently build a transport, so give it one the same way `buildApp` does — `const transport = options.transport ?? smtpTransport(config.smtpUrl);`, with an optional `transport` on its options so a test can hand in the memory transport. Without it, an `autoApply` schedule creates accounts whose initial passwords are sealed into the vault and sent to nobody, which is Ruling P12 reintroduced on the one path where nobody is watching.

and in `scheduleBackgroundWork`, after the loop that schedules directory sources, add a third loop over the same `tenants`:

```ts
  for (const tenant of tenants) {
    let targets;
    try {
      // Every target, not only the eligible ones -- the same reasoning the
      // source loop above records. pg-boss keeps its schedules in the
      // database, so a target disabled or unscheduled while this process was
      // down still has a schedule row waiting for it; reading the whole list
      // lets `applyTargetSchedule` remove those as well as add the rest, which
      // is the difference between reconciling and appending.
      targets = await withTenant(tenant.id, (tx) =>
        tx.targetSystem.findMany({
          select: { id: true, schedule: true, enabled: true },
        }),
      );
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to load provisioning targets for scheduling',
      );
      continue;
    }

    for (const target of targets) {
      try {
        await applyTargetSchedule(scheduler, tenant.id, target);
      } catch (cause) {
        // Logged, never rethrown. This whole function is "log and do nothing
        // for this piece": an API that comes up with provisioning unscheduled
        // is strictly better than one that does not come up.
        logger.error(
          { err: cause, tenantId: tenant.id, targetSystemId: target.id },
          'failed to schedule provisioning target',
        );
      }
    }
  }
```

with `registerProvisionJobs` and `applyTargetSchedule` added to the existing `@syntra/core` import in that file.

- [ ] **Step 6: Export from core**

In `packages/core/src/index.ts`, append:

```ts
export * from './provision/jobs.js';
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/core/src/provision/jobs.test.ts`
Expected: PASS, 13 tests.

"counts consecutive skips" and "resets the skip counter once a run actually starts" together are Ruling P4. If the counter exists but nothing renders it, the ruling is not satisfied — Task 18 puts it on the targets list.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: schedule provisioning runs and surface skipped runs"
```

---

## Task 17: Previews, the "why" query, and the administration API

**Files:**
- Create: `packages/core/src/provision/explain.ts`
- Create: `packages/contracts/src/provision.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/admin/targets.ts`
- Create: `apps/api/src/routes/admin/profiles.ts`
- Create: `apps/api/src/routes/admin/rules.ts`
- Create: `apps/api/src/routes/admin/provision-runs.ts`
- Modify: `apps/api/src/routes/admin/persons.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/core/src/rbac/permissions.ts`
- Test: `packages/core/src/provision/explain.test.ts`, `apps/api/src/routes/admin/provision.test.ts`

**Read `apps/api/src/routes/admin/sources.ts` before writing any of the four route files.** It is the closest existing analogue — a plugin registered under `/api/admin` with a master key and a late-bound scheduler — and it establishes every convention these routes follow: `app.addHook('preHandler', requireSession('admin'))` inside the plugin, `requirePermission(...)` imported from `../../plugins/require-permission.js` rather than decorated onto `app`, `request.db((tx) => ...)` for a tenant-bound read, `request.session.userId` for the actor, `ProblemError` for anything that is not a 2xx, and route paths written relative to the prefix. An earlier draft of this task invented `RouteOptions`, `app.requirePermission`, `request.userId`, `buildTestServer` and `adminHeaders`, none of which exist in this repository, and mounted the routes in a `server.ts` that does not register routes.

**Interfaces:**
- Consumes: `evaluateCondition`, `conditionSchema`, `renderTemplate`, `generateCorrelationKey`, `resolveMappingContract`, `activeOn`, `personDisplayName`; `applyProvisionRun`; `createTarget`, `updateTarget`, `deleteTarget`, `testTargetConfiguration`, `upsertAccountProfile`, `upsertBusinessRule`, `deleteBusinessRule`; `refreshEntitlements`; `claimSyntraUsers`, `enqueuePairedSync`; `PROVISION_JOB`, `provisionJobPayload`; `localMasterKeyProvider`; and from `apps/api`: `requireSession`, `requirePermission`, `ProblemError`, `buildTestApp`.
- Produces:
  - `interface PersonAccess { personId: string; accounts: { targetSystemId: string; targetName: string; correlationKey: string; status: string; anchor: string | null; entitlements: { entitlementId: string; displayName: string; origin: string; ruleId: string | null; ruleName: string | null; contractId: string | null; contractDescription: string | null }[] }[] }`
  - `async function explainPersonAccess(tenantId: string, personId: string): Promise<PersonAccess>` (in `explain.ts`)
  - `interface RuleImpact { matchedPersons: number; totalPersons: number; wouldGrant: number; wouldRevoke: number; sample: { personId: string; displayName: string }[] }`
  - `async function previewRuleImpact(tenantId: string, targetSystemId: string, rule: BusinessRuleInput, now?: Date): Promise<RuleImpact>` (in `explain.ts`)
  - `interface ProfilePreview { correlationKey: string | null; taken: boolean; container: string | null; attributes: Record<string, string>; problems: string[] }`
  - `async function previewAccountProfile(tenantId: string, targetSystemId: string, profile: AccountProfileInput, personId: string, now?: Date): Promise<ProfilePreview>` (in `explain.ts`)
  - `PERMISSIONS.PROVISION_READ = 'provision.read'`, `PERMISSIONS.PROVISION_MANAGE = 'provision.manage'`

- [ ] **Step 1: Add the two permissions**

In `packages/core/src/rbac/permissions.ts`, inside the `PERMISSIONS` object, after `POLICY_MANAGE`:

```ts
  PROVISION_READ: 'provision.read',
  PROVISION_MANAGE: 'provision.manage',
```

`provision.manage` gates every configuration mutation, every apply and every confirmation. `provision.read` gates run history, drift, exceptions and the person-access view. They are separate because reading who holds what in the finance system is a reasonable thing to grant an auditor, and changing a threshold is not.

- [ ] **Step 2: Write the failing test for the three read-side helpers**

`packages/core/src/provision/explain.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { explainPersonAccess, previewAccountProfile, previewRuleImpact } from './explain.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let entitlementId: string;
let personId: string;
let ruleId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profileInput = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,DC=acme,DC=test',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: {
    displayName: '%person.givenName% %person.familyName%',
    // `Person` has businessEmail and personalEmail. There is no `email`
    // column, and spec section 15 forbids adding one.
    mail: '%person.businessEmail%',
  },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        type: 'group',
        displayName: 'Finance',
      },
    });
    const person = await tx.person.create({
      data: {
        tenantId,
        givenName: 'Anna',
        familyName: 'Novak',
        businessEmail: 'anna@acme.test',
      },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        jobTitle: 'Analyst',
      },
    });
    const bo = await tx.person.create({
      data: { tenantId, givenName: 'Bo', familyName: 'Lind', businessEmail: 'bo@acme.test' },
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
    return { entitlementId: entitlement.id, personId: person.id };
  });
  entitlementId = seeded.entitlementId;
  personId = seeded.personId;

  await upsertAccountProfile(tenantId, null, targetId, profileInput);
  ruleId = (
    await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    })
  ).id;
});

describe('explainPersonAccess', () => {
  it('answers why this person holds this, with the rule and the contract', async () => {
    const contractId = await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      const contract = await tx.contract.findFirstOrThrow({ where: { personId } });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId,
          origin: 'rule',
          grantedByRuleId: ruleId,
        },
      });
      return contract.id;
    });

    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts).toHaveLength(1);
    const holding = access.accounts[0]!.entitlements[0]!;
    // This is the single most-asked question of a provisioning product, and it
    // is cheap here only because attribution was recorded at evaluation time.
    expect(holding.displayName).toBe('Finance');
    expect(holding.origin).toBe('rule');
    expect(holding.ruleName).toBe('Finance staff');
    expect(holding.contractId).toBe(contractId);
    expect(holding.contractDescription).toContain('Analyst');
  });

  it('names a discovered holding as having no rule behind it', async () => {
    await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'discovered' },
      });
    });
    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts[0]!.entitlements[0]!.origin).toBe('discovered');
    expect(access.accounts[0]!.entitlements[0]!.ruleName).toBeNull();
  });

  it('omits revoked holdings', async () => {
    await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId,
          origin: 'rule',
          state: 'revoked',
          revokedAt: new Date(),
        },
      });
    });
    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts[0]!.entitlements).toEqual([]);
  });
});

describe('previewRuleImpact', () => {
  it('reports the blast radius before the rule is saved', async () => {
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    // "this rule matches 1 of 2 persons; enabling it would grant 1 entitlement
    // and revoke 0." A rule whose blast radius is only visible after it is
    // saved is a rule that gets saved and then discovered.
    expect(impact).toMatchObject({
      matchedPersons: 1,
      totalPersons: 2,
      wouldGrant: 1,
      wouldRevoke: 0,
    });
    expect(impact.sample[0]!.displayName).toBe('Anna Novak');
  });

  it('reports revocations a narrowed rule would cause', async () => {
    await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId,
          origin: 'rule',
          grantedByRuleId: ruleId,
        },
      });
    });
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        // Narrowed to a job title nobody holds.
        condition: { field: 'contract.jobTitle', op: 'equals', value: 'Controller' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.matchedPersons).toBe(0);
    expect(impact.wouldRevoke).toBe(1);
  });

  it('writes nothing', async () => {
    const before = await withTenant(tenantId, (tx) => tx.businessRule.count());
    await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Unsaved',
        condition: { all: [] },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      },
      NOW,
    );
    expect(await withTenant(tenantId, (tx) => tx.businessRule.count())).toBe(before);
  });
});

describe('previewAccountProfile', () => {
  it('shows what the templates would produce for a real person', async () => {
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    // A template language nobody can try is a template language everybody gets
    // wrong.
    expect(preview).toEqual({
      correlationKey: 'anna.novak',
      taken: false,
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      attributes: { displayName: 'Anna Novak', mail: 'anna@acme.test' },
      problems: [],
    });
  });

  it('says when the key is already taken', async () => {
    await withTenant(tenantId, async (tx) => {
      const other = await tx.person.create({
        data: { tenantId, givenName: 'Anne', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: other.id,
          correlationKey: 'anna.novak',
          status: 'pending',
        },
      });
    });
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.taken).toBe(true);
    expect(preview.correlationKey).toBe('anna.novak2');
  });

  it('names every template that cannot resolve rather than rendering it empty', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.update({ where: { id: personId }, data: { businessEmail: null } }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.problems).toEqual([
      'the template for "mail" references person.businessEmail, which resolves to nothing for this person',
    ]);
    expect(preview.attributes.mail).toBeUndefined();
  });

  it('falls back when the container template resolves to nothing', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { department: null } }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.container).toBe('OU=Users,DC=acme,DC=test');
  });
});
```

- [ ] **Step 3: Write the read-side helpers**

`packages/core/src/provision/explain.ts`:

```ts
import { withTenant } from '@syntra/db';
import { conditionSchema, evaluateCondition } from './condition.js';
import { activeOn, personDisplayName, resolveMappingContract } from './desired.js';
import { generateCorrelationKey } from './names.js';
import { renderTemplate, type TemplateContext } from './templates.js';
import type { AccountProfileInput, BusinessRuleInput } from './target-service.js';
import type { ConditionFacts, ContractFacts } from './types.js';

export interface PersonAccessEntitlement {
  entitlementId: string;
  displayName: string;
  origin: string;
  ruleId: string | null;
  ruleName: string | null;
  contractId: string | null;
  contractDescription: string | null;
}

export interface PersonAccess {
  personId: string;
  accounts: {
    targetSystemId: string;
    targetName: string;
    correlationKey: string;
    status: string;
    anchor: string | null;
    entitlements: PersonAccessEntitlement[];
  }[];
}

const describeContract = (c: {
  jobTitle: string | null;
  department: string | null;
  sequence: number;
}) =>
  [c.jobTitle, c.department].filter(Boolean).join(', ') || `contract ${c.sequence}`;

/**
 * Answers "why does this person hold this?" with a rule name and a contract.
 *
 * The most-asked question of any provisioning product, and unanswerable after
 * the fact if the reason is not recorded at the time — which is why
 * `AccountEntitlement.origin` and `grantedByRuleId` are written at the moment
 * of the grant rather than derived later.
 */
export async function explainPersonAccess(
  tenantId: string,
  personId: string,
): Promise<PersonAccess> {
  return withTenant(tenantId, async (tx) => {
    const accounts = await tx.targetAccount.findMany({
      where: { personId },
      include: {
        target: { select: { id: true, name: true } },
        entitlements: {
          where: { state: 'held' },
          include: { entitlement: { select: { id: true, displayName: true } } },
        },
      },
    });

    const ruleIds = accounts.flatMap((a) =>
      a.entitlements.map((h) => h.grantedByRuleId).filter((id): id is string => id !== null),
    );
    const rules = await tx.businessRule.findMany({ where: { id: { in: ruleIds } } });
    const ruleById = new Map(rules.map((r) => [r.id, r]));

    const contracts = await tx.contract.findMany({ where: { personId } });
    const now = new Date();
    const active = contracts.filter(
      (c) =>
        c.startDate.getTime() <= now.getTime() &&
        (c.endDate === null || c.endDate.getTime() >= now.getTime()),
    );

    return {
      personId,
      accounts: accounts.map((account) => ({
        targetSystemId: account.target.id,
        targetName: account.target.name,
        correlationKey: account.correlationKey,
        status: account.status,
        anchor: account.anchor,
        entitlements: account.entitlements.map((holding) => {
          const rule = holding.grantedByRuleId
            ? (ruleById.get(holding.grantedByRuleId) ?? null)
            : null;
          // Which contract satisfied the rule: the first active one whose
          // facts the rule's condition accepts.
          const contract =
            rule === null
              ? null
              : (active.find((c) =>
                  evaluateCondition(rule.condition as never, {
                    'contract.department': c.department,
                    'contract.jobTitle': c.jobTitle,
                    'contract.costCentre': c.costCentre,
                    'contract.employer': c.employer,
                    'contract.location': c.location,
                    'contract.fte': c.fte === null ? null : Number(c.fte),
                    'person.status': 'active',
                  } satisfies ConditionFacts),
                ) ?? null);
          return {
            entitlementId: holding.entitlement.id,
            displayName: holding.entitlement.displayName,
            origin: holding.origin,
            ruleId: rule?.id ?? null,
            ruleName: rule?.name ?? null,
            contractId: contract?.id ?? null,
            contractDescription: contract === null ? null : describeContract(contract),
          };
        }),
      })),
    };
  });
}

export interface RuleImpact {
  matchedPersons: number;
  totalPersons: number;
  wouldGrant: number;
  wouldRevoke: number;
  sample: { personId: string; displayName: string }[];
}

/**
 * "This rule matches 412 of 1,180 persons; enabling it would grant 412
 * entitlements and revoke 3." Computed without writing anything.
 *
 * A rule whose blast radius is only visible after it is saved is a rule that
 * gets saved and then discovered.
 */
export async function previewRuleImpact(
  tenantId: string,
  targetSystemId: string,
  rule: BusinessRuleInput,
  now: Date = new Date(),
): Promise<RuleImpact> {
  /**
   * Parsed before anything is evaluated.
   *
   * The API's `conditionRequestSchema` falls back to `z.record(z.unknown())`
   * for leaves, so a malformed leaf reaches here intact -- and
   * `evaluateCondition` falls through both of its switches and returns
   * `undefined`, which `.some()` reads as false. The rule then previews as
   * "matches 0 persons", which reads as a narrow rule rather than a broken
   * one, and somebody saves it.
   */
  const condition = conditionSchema.parse(rule.condition);

  return withTenant(tenantId, async (tx) => {
    const persons = await tx.person.findMany({ include: { contracts: true } });
    const holdings =
      rule.entitlementIds.length === 0
        ? []
        : await tx.accountEntitlement.findMany({
            where: {
              state: 'held',
              entitlementId: { in: rule.entitlementIds },
              account: { targetSystemId },
              ...(rule.id === undefined ? {} : { grantedByRuleId: rule.id }),
            },
            include: { account: { select: { personId: true } } },
          });

    const matched: { personId: string; displayName: string }[] = [];
    for (const person of persons) {
      const contracts: ContractFacts[] = person.contracts.map((c) => ({
        id: c.id,
        sequence: c.sequence,
        isPrimary: c.isPrimary,
        startDate: c.startDate,
        endDate: c.endDate,
        department: c.department,
        jobTitle: c.jobTitle,
        costCentre: c.costCentre,
        employer: c.employer,
        location: c.location,
        fte: c.fte === null ? null : Number(c.fte),
      }));
      const hit = activeOn(contracts, now).some((c) =>
        evaluateCondition(condition, {
          'contract.department': c.department,
          'contract.jobTitle': c.jobTitle,
          'contract.costCentre': c.costCentre,
          'contract.employer': c.employer,
          'contract.location': c.location,
          'contract.fte': c.fte,
          'person.status': person.status,
        } satisfies ConditionFacts),
      );
      if (hit) {
        matched.push({
          personId: person.id,
          // Derived: `Person` has no displayName column.
          displayName: personDisplayName(person),
        });
      }
    }

    const matchedIds = new Set(matched.map((m) => m.personId));
    const holdersNowUnmatched = holdings.filter(
      (h) => !matchedIds.has(h.account.personId),
    ).length;
    const alreadyHeld = holdings.filter((h) => matchedIds.has(h.account.personId)).length;

    return {
      matchedPersons: matched.length,
      totalPersons: persons.length,
      wouldGrant: matched.length * rule.entitlementIds.length - alreadyHeld,
      wouldRevoke: holdersNowUnmatched,
      // Capped: an impact preview over a 40,000-person tenant must not return
      // 40,000 names to a browser.
      sample: matched.slice(0, 25),
    };
  });
}

export interface ProfilePreview {
  correlationKey: string | null;
  taken: boolean;
  container: string | null;
  attributes: Record<string, string>;
  problems: string[];
}

/**
 * Pick a real person, see the correlation key, container and attributes the
 * templates would produce for them, and whether that key is already taken.
 */
export async function previewAccountProfile(
  tenantId: string,
  targetSystemId: string,
  profile: AccountProfileInput,
  personId: string,
  now: Date = new Date(),
): Promise<ProfilePreview> {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      include: { contracts: true },
    });
    const accounts = await tx.targetAccount.findMany({ where: { targetSystemId } });

    const contracts: ContractFacts[] = person.contracts.map((c) => ({
      id: c.id,
      sequence: c.sequence,
      isPrimary: c.isPrimary,
      startDate: c.startDate,
      endDate: c.endDate,
      department: c.department,
      jobTitle: c.jobTitle,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      fte: c.fte === null ? null : Number(c.fte),
    }));
    const mapping = resolveMappingContract(contracts, now);

    // Exactly the shape `desiredState` builds, through the same helper, so a
    // preview and a run cannot disagree about what a template resolves to.
    const context: TemplateContext = {
      person: {
        givenName: person.givenName,
        familyName: person.familyName,
        businessEmail: person.businessEmail,
        personalEmail: person.personalEmail,
        nameConvention: person.nameConvention,
        displayName: personDisplayName(person),
        status: person.status,
      },
      contract: {
        department: mapping?.department ?? null,
        jobTitle: mapping?.jobTitle ?? null,
        costCentre: mapping?.costCentre ?? null,
        employer: mapping?.employer ?? null,
        location: mapping?.location ?? null,
      },
      baseDn: (target.config as { baseDn?: string }).baseDn ?? '',
    };

    const problems: string[] = [];
    const attributes: Record<string, string> = {};
    for (const [name, template] of Object.entries(profile.attributeTemplates)) {
      const rendered = renderTemplate(template, context);
      if (rendered.ok) attributes[name] = rendered.value;
      else {
        problems.push(
          `the template for "${name}" references ${rendered.missing.join(', ')}, which resolves to nothing for this person`,
        );
      }
    }

    // AMENDED by Task 7: `renderContainer` (added to `templates.ts` there),
    // never `renderTemplate`, because this is a DN and Ruling P22 says the
    // escaping is structural. A preview that renders the container unescaped
    // also *shows the administrator the wrong answer*, which is worse than
    // silently doing the wrong thing: it is the screen they check it on.
    const containerRendered = renderContainer(profile.containerTemplate, context);
    const container = containerRendered.ok
      ? containerRendered.value
      : profile.fallbackContainer;

    const otherKeys = new Set(
      accounts.filter((a) => a.personId !== personId).map((a) => a.correlationKey),
    );
    const base = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken: new Set<string>(),
      maxLength: 20,
      maxAttempts: profile.maxUniquenessAttempts,
    });
    const unique = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken: otherKeys,
      maxLength: 20,
      maxAttempts: profile.maxUniquenessAttempts,
    });

    if (!unique.ok) {
      problems.push(
        unique.reason === 'exhausted'
          ? `no unique account name could be generated within ${profile.maxUniquenessAttempts} attempts`
          : `the account name template references ${unique.missing.join(', ')}, which resolves to nothing for this person`,
      );
    }

    return {
      correlationKey: unique.ok ? unique.correlationKey : null,
      taken: base.ok && unique.ok && base.correlationKey !== unique.correlationKey,
      container,
      attributes,
      problems,
    };
  });
}
```

- [ ] **Step 4: Run the helper tests**

Add one more test to `previewRuleImpact`, because a rule that previews as harmless when it is actually unparseable is the failure this preview exists to prevent:

```ts
  it('refuses a malformed condition rather than previewing it as matching nobody', async () => {
    // `evaluateCondition` falls through both switches on a leaf it does not
    // recognise and returns undefined, which `.some()` reads as false -- so an
    // unparseable rule previews as "matches 0 of 2 persons", which is exactly
    // what a correctly narrow rule looks like.
    await expect(
      previewRuleImpact(
        tenantId,
        targetId,
        {
          name: 'Malformed',
          condition: { field: 'contract.department', op: 'regex', value: '^a' } as never,
          grantsAccount: true,
          enabled: true,
          entitlementIds: [],
        },
        NOW,
      ),
    ).rejects.toThrow();
  });
```

Run: `pnpm vitest run packages/core/src/provision/explain.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the contracts**

`packages/contracts/src/provision.ts`:

```ts
import { z } from 'zod';

export const enforcementModeSchema = z.enum(['additive', 'authoritative']);

export const targetConfigSchema = z.object({
  url: z.string().min(1),
  // `plain` is absent: writes to a target require an encrypted transport
  // unconditionally, and a target that could be configured to write in the
  // clear is a target that eventually does.
  tlsMode: z.enum(['ldaps', 'starttls']),
  rejectUnauthorized: z.boolean().default(true),
  bindDn: z.string().min(1),
  baseDn: z.string().min(1),
  entitlementSearchBase: z.string().min(1),
  archiveContainer: z.string().min(1),
  provenanceAttribute: z.string().default('info'),
  anchorAttribute: z.string().default('objectGUID'),
  accountFilter: z.string().default('(&(objectCategory=person)(objectClass=user))'),
  groupFilter: z.string().default('(objectClass=group)'),
  primaryGroupExternalIds: z.array(z.string()).default([]),
  pageSize: z.number().int().positive().max(5000).default(1000),
  connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
});

export const createTargetRequestSchema = z.object({
  name: z.string().min(1),
  config: targetConfigSchema,
  bindPassword: z.string().min(1),
  pairedDirectorySourceId: z.string().uuid().nullable().optional(),
  schedule: z.string().nullable().optional(),
  autoApply: z.boolean().optional(),
  enabled: z.boolean().optional(),
  enforcementMode: enforcementModeSchema.optional(),
});
export type CreateTargetRequest = z.input<typeof createTargetRequestSchema>;

export const ladderSchema = z.object({
  entitlementRevocationDelayDays: z.number().int().min(0).max(3650).optional(),
  disableGraceDays: z.number().int().min(0).max(3650).optional(),
  archiveAfterDays: z.number().int().min(0).max(3650).nullable().optional(),
  reenableWithoutConfirmationDays: z.number().int().min(0).max(3650).optional(),
  renameEnabled: z.boolean().optional(),
});

export const thresholdsSchema = z.object({
  createAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
  disableAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
  archiveAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
  revokeEntitlementThresholdPercent: z.number().int().min(0).max(100).optional(),
  deactivateSyntraUserThresholdPercent: z.number().int().min(0).max(100).optional(),
  perEntitlementThresholdPercent: z.number().int().min(0).max(100).optional(),
  personPopulationDropPercent: z.number().int().min(0).max(100).optional(),
});

export const updateTargetRequestSchema = createTargetRequestSchema
  .partial()
  .extend({
    ladder: ladderSchema.optional(),
    thresholds: thresholdsSchema.optional(),
    preHireDays: z.number().int().min(0).max(365).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
  });
export type UpdateTargetRequest = z.input<typeof updateTargetRequestSchema>;

export const testTargetRequestSchema = z.object({
  config: targetConfigSchema,
  bindPassword: z.string().min(1).optional(),
  borrowFromTargetId: z.string().uuid().optional(),
});

/**
 * The TRANSPORT shape of a condition, and deliberately not the real one.
 *
 * `@syntra/contracts` cannot import the closed field and operator sets from
 * `@syntra/core` without inverting the dependency, so the leaf falls back to
 * an open record here. That makes this schema a shape check and nothing more:
 * a leaf naming `contract.salary`, or `op: 'regex'`, parses cleanly.
 *
 * **Every route that touches a condition therefore re-parses it with
 * `conditionSchema` from `@syntra/core` before evaluating or storing it** --
 * `upsertBusinessRule` already does, and Task 17's rule routes do it for the
 * impact preview as well. Without that second parse, `evaluateCondition` falls
 * through both of its switches on a malformed leaf and returns `undefined`,
 * which `.some()` reads as false: the rule previews as "matches 0 persons",
 * which is indistinguishable from a correctly narrow rule, and it gets saved.
 */
export const conditionRequestSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionRequestSchema) }).strict(),
    z.object({ any: z.array(conditionRequestSchema) }).strict(),
    z.object({ not: conditionRequestSchema }).strict(),
    z.record(z.unknown()),
  ]),
);

export const businessRuleRequestSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  condition: conditionRequestSchema,
  grantsAccount: z.boolean(),
  enabled: z.boolean(),
  entitlementIds: z.array(z.string().uuid()),
});
export type BusinessRuleRequest = z.input<typeof businessRuleRequestSchema>;

export const accountProfileRequestSchema = z.object({
  correlationKeyTemplate: z.string().min(1),
  uniquenessStrategy: z.literal('numericSuffix').default('numericSuffix'),
  maxUniquenessAttempts: z.number().int().positive().max(200),
  containerTemplate: z.string().min(1),
  fallbackContainer: z.string().min(1),
  attributeTemplates: z.record(z.string()),
  initialPasswordPolicy: z.record(z.unknown()),
  initialPasswordDelivery: z.enum(['manager', 'personalEmail', 'vaultOnly']),
});
export type AccountProfileRequest = z.input<typeof accountProfileRequestSchema>;

export const applyRunRequestSchema = z.object({
  /** Action ids to apply. Omitted, every proposed action is applied. */
  only: z.array(z.string().uuid()).optional(),
  /** Required to apply a blocked run, or any action needing confirmation. */
  confirm: z.boolean().default(false),
});
export type ApplyRunRequest = z.input<typeof applyRunRequestSchema>;

export const acknowledgeDriftRequestSchema = z.object({
  status: z.enum(['acknowledged', 'resolved']),
});
```

In `packages/contracts/src/index.ts`, append:

```ts
export * from './provision.js';
```

- [ ] **Step 6: Write the failing route test**

`apps/api/src/routes/admin/provision.test.ts`, following the harness every other admin route test in this repository uses — `buildTestApp` from `apps/api/src/test-support.js`, a real signed-in administrative session, and `host` on every request. There is no `buildTestServer` and no `adminHeaders`; an earlier draft of this task invented both, along with a `RouteOptions` type, an `app.requirePermission` decorator and a `request.userId` property, none of which exist.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let targetId: string;

const PASSWORD = 'a-long-enough-password';
// Hashed once for the file: Argon2id is deliberately expensive and has no
// business inside a per-test path, let alone a transaction.
const PASSWORD_HASH = await hashPassword(PASSWORD);

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

/** A signed-in, elevated administrative session holding exactly `permissions`. */
async function adminCookie(permissions: Permission[]): Promise<string> {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: `admin-${permissions.join('-')}`,
      email: `${permissions.join('.')}@acme.test`,
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `R-${permissions.join('-')}`, permissions);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: `admin-${permissions.join('-')}`, password: PASSWORD },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const elevated = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${elevated.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

const create = async (cookie: string) => {
  const response = await post('/api/admin/targets', cookie, {
    name: 'Acme AD',
    config,
    bindPassword: 'super-secret-bind',
  });
  targetId = response.json().id;
  return response;
};

describe('POST /api/admin/targets', () => {
  it('creates a target and never echoes the credential', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.PROVISION_READ,
    ]);
    const response = await create(cookie);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('super-secret-bind');
  });

  it('refuses a plaintext transport with a 400 rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.PROVISION_MANAGE]);
    const response = await post('/api/admin/targets', cookie, {
      name: 'Plain',
      config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
      bindPassword: 'x',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses without provision.manage', async () => {
    // Reading who holds what in the finance system is a reasonable thing to
    // grant an auditor. Changing a threshold is not, and lowering a threshold
    // is functionally the same as approving everything it would have caught.
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await post('/api/admin/targets', cookie, {
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/admin/targets', () => {
  it('lists targets with their skip history and never the credential', async () => {
    const manage = await adminCookie([
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.PROVISION_READ,
    ]);
    await create(manage);
    await withTenant(ctx.tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          consecutiveSkippedRuns: 3,
          lastSkippedAt: new Date(),
          lastSkipReason: 'a run is awaiting review',
        },
      }),
    );

    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await get('/api/admin/targets', cookie);
    const body = response.json().targets;
    // Ruling P4: the list is where somebody looks, so the list carries it.
    expect(body[0].consecutiveSkippedRuns).toBe(3);
    expect(body[0].lastSkipReason).toContain('awaiting review');
    expect(body[0].enforcementMode).toBe('additive');
    expect(JSON.stringify(body)).not.toContain('super-secret-bind');
    expect(JSON.stringify(body)).not.toContain('secretName');
  });
});

describe('POST /api/admin/targets/:id/runs/:runId/apply', () => {
  const seedRun = async (over: Record<string, unknown>) =>
    withTenant(ctx.tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId: ctx.tenantId, targetSystemId: targetId, ...over },
        })
      ).id,
    );

  it('refuses to apply a blocked run without confirm', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.PROVISION_READ,
    ]);
    await create(cookie);
    const runId = await seedRun({
      status: 'blocked',
      requiresConfirmation: true,
      blockedReason: 'first run',
    });
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: false },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain('confirm');
  });

  it('refuses to apply a run blocked for an unconfirmable reason even with confirm', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.PROVISION_READ,
    ]);
    await create(cookie);
    const runId = await seedRun({
      status: 'blocked',
      requiresConfirmation: false,
      blockedReason: 'the target returned no accounts at all',
    });
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: true },
    );
    // There is nothing an administrator could usefully confirm about a
    // directory that may simply be unreachable.
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain('cannot be confirmed');
  });
});

describe('GET /api/admin/persons/:id/access', () => {
  it('answers why this person holds this', async () => {
    const manage = await adminCookie([
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.PROVISION_READ,
    ]);
    await create(manage);
    const personId = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId: ctx.tenantId,
          targetSystemId: targetId,
          externalId: 'guid-finance',
          dn: 'CN=Finance,OU=Groups,DC=acme,DC=test',
          type: 'group',
          displayName: 'Finance',
        },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId: ctx.tenantId,
          targetSystemId: targetId,
          personId: person.id,
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: account.id,
          entitlementId: entitlement.id,
          origin: 'discovered',
        },
      });
      return person.id;
    });

    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await get(`/api/admin/persons/${personId}/access`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts[0].entitlements[0].displayName).toBe('Finance');
  });

  it('refuses without provision.read, even to somebody who can read persons', async () => {
    const cookie = await adminCookie([PERMISSIONS.IDENTITY_READ]);
    const response = await get(
      '/api/admin/persons/00000000-0000-0000-0000-000000000000/access',
      cookie,
    );
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 7: Write the target routes**

`apps/api/src/routes/admin/targets.ts`. Registered as a Fastify plugin under the `/api/admin` prefix, so every path below is relative to it — the same shape as `sources.ts`, including the session hook applied inside the plugin so a new route cannot forget it.

```ts
import type { FastifyInstance } from 'fastify';
import {
  createTargetRequestSchema,
  testTargetRequestSchema,
  updateTargetRequestSchema,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createTarget,
  deleteTarget,
  localMasterKeyProvider,
  refreshEntitlements,
  testTargetConfiguration,
  updateTarget,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface TargetRouteOptions {
  masterKey: Buffer;
  /**
   * Late-bound, exactly as the source routes take it: the scheduler talks to
   * pg-boss, is started after the app is built, and is allowed to fail to
   * start without keeping the API down.
   */
  scheduler?: () => Scheduler | null;
  authRateLimitMax: number;
}

/** Everything safe to return. `secretName` and `config.bindPassword` are not among it. */
const TARGET_FIELDS = {
  id: true,
  name: true,
  type: true,
  config: true,
  pairedDirectorySourceId: true,
  schedule: true,
  autoApply: true,
  enabled: true,
  enforcementMode: true,
  preHireDays: true,
  entitlementRevocationDelayDays: true,
  disableGraceDays: true,
  archiveAfterDays: true,
  reenableWithoutConfirmationDays: true,
  createAccountThresholdPercent: true,
  disableAccountThresholdPercent: true,
  archiveAccountThresholdPercent: true,
  revokeEntitlementThresholdPercent: true,
  deactivateSyntraUserThresholdPercent: true,
  perEntitlementThresholdPercent: true,
  personPopulationDropPercent: true,
  maxAttempts: true,
  concurrency: true,
  renameEnabled: true,
  lastRunAt: true,
  lastAppliedRunAt: true,
  // Ruling P4: a target that has skipped repeatedly must be visibly
  // distinguishable from one running cleanly, so these travel with the list.
  consecutiveSkippedRuns: true,
  lastSkippedAt: true,
  lastSkipReason: true,
} as const;

export async function registerAdminTargetRoutes(
  app: FastifyInstance,
  options: TargetRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);
  const scheduler = () => options.scheduler?.() ?? undefined;

  app.get(
    '/targets',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => ({
      targets: await request.db((tx) =>
        tx.targetSystem.findMany({ select: TARGET_FIELDS, orderBy: { name: 'asc' } }),
      ),
    }),
  );

  app.get(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: TARGET_FIELDS }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return target;
    },
  );

  app.post(
    '/targets',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const body = createTargetRequestSchema.parse(request.body);
      const created = await createTarget(
        request.tenantId,
        provider,
        request.session.userId,
        body,
        scheduler(),
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateTargetRequestSchema.parse(request.body);
      await updateTarget(
        request.tenantId,
        provider,
        request.session.userId,
        id,
        body,
        scheduler(),
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { confirm } = request.query as { confirm?: string };
      const result = await deleteTarget(
        request.tenantId,
        request.session.userId,
        id,
        confirm === 'true',
        scheduler(),
      );
      if (!result.ok) {
        throw new ProblemError(
          409,
          'target-not-empty',
          'This target still holds accounts',
          'deleting it removes Syntra record of every account it manages; the accounts themselves are never touched',
          { counts: result.counts },
        );
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/test',
    {
      preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE),
      // A test opens an outbound connection with a credential on it. Rate
      // limited for the same reason the policy simulator is.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = testTargetRequestSchema.parse(request.body);
      return testTargetConfiguration(request.tenantId, provider, body);
    },
  );

  app.post(
    '/targets/:id/entitlements/refresh',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      return refreshEntitlements(request.tenantId, provider, request.session.userId, id);
    },
  );

  app.get(
    '/targets/:id/entitlements',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      return {
        entitlements: await request.db((tx) =>
          tx.entitlement.findMany({
            where: { targetSystemId: id },
            orderBy: { displayName: 'asc' },
          }),
        ),
      };
    },
  );
}
```

- [ ] **Step 8: Write the profile and rule routes**

`apps/api/src/routes/admin/profiles.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { accountProfileRequestSchema } from '@syntra/contracts';
import { PERMISSIONS, previewAccountProfile, upsertAccountProfile } from '@syntra/core';
import { z } from 'zod';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const previewRequest = z.object({
  profile: accountProfileRequestSchema,
  personId: z.string().uuid(),
});

export async function registerAdminProfileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/profile',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      const profile = await request.db((tx) =>
        tx.accountProfile.findFirst({ where: { targetSystemId: id } }),
      );
      if (!profile) throw new ProblemError(404, 'not-found', 'No account profile yet');
      return profile;
    },
  );

  app.put(
    '/targets/:id/profile',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = accountProfileRequestSchema.parse(request.body);
      await upsertAccountProfile(request.tenantId, request.session.userId, id, body);
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/:id/profile/preview',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      // Parsed, both halves. A template language nobody can try is a template
      // language everybody gets wrong, and a preview that accepts anything is
      // a preview of something other than what would be saved.
      const body = previewRequest.parse(request.body);
      return previewAccountProfile(request.tenantId, id, body.profile, body.personId);
    },
  );
}
```

`apps/api/src/routes/admin/rules.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { businessRuleRequestSchema } from '@syntra/contracts';
import {
  PERMISSIONS,
  conditionSchema,
  deleteBusinessRule,
  previewRuleImpact,
  upsertBusinessRule,
} from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * The transport schema, then the real one.
 *
 * `businessRuleRequestSchema`'s condition falls back to `z.record(z.unknown())`
 * for leaves, so it accepts a malformed one -- and `evaluateCondition` returns
 * `undefined` for it, which `.some()` reads as false, so a broken rule previews
 * as "matches 0 persons" and saves as a rule that grants nothing. Parsing with
 * the closed schema here is what turns that into a 400.
 */
function parseRule(body: unknown) {
  const rule = businessRuleRequestSchema.parse(body);
  return { ...rule, condition: conditionSchema.parse(rule.condition) };
}

export async function registerAdminRuleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/rules',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      return {
        rules: await request.db((tx) =>
          tx.businessRule.findMany({
            where: { targetSystemId: id },
            include: { entitlements: true },
            orderBy: { name: 'asc' },
          }),
        ),
      };
    },
  );

  app.put(
    '/targets/:id/rules',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      return upsertBusinessRule(
        request.tenantId,
        request.session.userId,
        id,
        parseRule(request.body),
      );
    },
  );

  app.delete(
    '/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { ruleId } = request.params as { ruleId: string };
      await deleteBusinessRule(request.tenantId, request.session.userId, ruleId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/:id/rules/impact',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      return previewRuleImpact(request.tenantId, id, parseRule(request.body));
    },
  );
}
```

- [ ] **Step 9: Write the run routes**

`apps/api/src/routes/admin/provision-runs.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { acknowledgeDriftRequestSchema, applyRunRequestSchema } from '@syntra/contracts';
import {
  PERMISSIONS,
  PROVISION_JOB,
  applyProvisionRun,
  claimSyntraUsers,
  enqueuePairedSync,
  localMasterKeyProvider,
  provisionJobPayload,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import type { Transport } from '@syntra/core';

export interface ProvisionRunRouteOptions {
  masterKey: Buffer;
  scheduler?: () => Scheduler | null;
  /** The app's mail transport, so a created account's password can be delivered. */
  transport: Transport;
}

export async function registerAdminProvisionRunRoutes(
  app: FastifyInstance,
  options: ProvisionRunRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

  app.post(
    '/targets/:id/runs',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const scheduler = options.scheduler?.();
      if (!scheduler) {
        throw new ProblemError(
          503,
          'scheduler-unavailable',
          'Background jobs are not running',
          'the run could not be enqueued; the API is up but the job scheduler is not',
        );
      }
      // Enqueued rather than run in the request: a full target read outlasts a
      // proxy timeout, which is the shape Directory Sync's synchronous
      // `Run now` endpoint still has and this one deliberately does not.
      const jobId = await scheduler.enqueue(
        PROVISION_JOB,
        provisionJobPayload(request.tenantId, id),
      );
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/targets/:id/runs',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      return {
        runs: await request.db((tx) =>
          tx.provisionRun.findMany({
            where: { targetSystemId: id },
            orderBy: { startedAt: 'desc' },
            take: 50,
          }),
        ),
      };
    },
  );

  app.get(
    '/targets/:id/runs/:runId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const run = await request.db((tx) =>
        tx.provisionRun.findUnique({
          where: { id: runId },
          include: {
            actions: {
              // The order the apply will use, and the order the reviewer needs
              // to see. `createdAt` is transaction start time and is identical
              // across every row of the plan.
              orderBy: { sequence: 'asc' },
              include: {
                // Grouping by person is what an administrator actually reads:
                // "what is about to happen to Anna" is the question.
                person: { select: { id: true, givenName: true, familyName: true } },
              },
            },
            exceptions: {
              include: {
                person: { select: { id: true, givenName: true, familyName: true } },
              },
            },
          },
        }),
      );
      if (!run) throw new ProblemError(404, 'not-found', 'Run not found');
      return run;
    },
  );

  app.post(
    '/targets/:id/runs/:runId/apply',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, runId } = request.params as { id: string; runId: string };
      const body = applyRunRequestSchema.parse(request.body ?? {});

      const run = await request.db((tx) =>
        tx.provisionRun.findUnique({ where: { id: runId } }),
      );
      if (!run) throw new ProblemError(404, 'not-found', 'Run not found');

      if (run.status === 'blocked' && !run.requiresConfirmation) {
        // Two conditions block outright, with no confirmation available,
        // because there is nothing an administrator could usefully confirm.
        throw new ProblemError(
          409,
          'run-unconfirmable',
          'This run cannot be applied',
          `it was blocked for a reason that cannot be confirmed away: ${run.blockedReason ?? ''}`,
        );
      }
      if (run.status === 'blocked' && !body.confirm) {
        throw new ProblemError(
          409,
          'run-needs-confirmation',
          'This run needs confirmation',
          `send confirm: true to apply it — ${run.blockedReason ?? ''}`,
        );
      }

      const result = await applyProvisionRun(request.tenantId, provider, runId, {
        ...(body.only === undefined ? {} : { only: body.only }),
        // Both, together. `confirm` is the deliberate act and
        // `confirmedByUserId` is who performed it; the apply requires both,
        // so a caller cannot satisfy the gate by passing a null user.
        ...(body.confirm
          ? { confirm: true, confirmedByUserId: request.session.userId }
          : {}),
        transport: options.transport,
      });

      if (result.applied > 0) {
        await claimSyntraUsers(request.tenantId, id);
        const scheduler = options.scheduler?.();
        if (scheduler) await enqueuePairedSync(scheduler, request.tenantId, id);
      }
      return result;
    },
  );

  app.get(
    '/targets/:id/drift',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      const { status, kind } = request.query as { status?: string; kind?: string };
      return {
        findings: await request.db((tx) =>
          tx.driftFinding.findMany({
            where: {
              targetSystemId: id,
              ...(status === undefined ? {} : { status }),
              ...(kind === undefined ? {} : { kind }),
            },
            orderBy: { lastSeenAt: 'desc' },
            take: 500,
          }),
        ),
      };
    },
  );

  app.patch(
    '/drift/:findingId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { findingId } = request.params as { findingId: string };
      const body = acknowledgeDriftRequestSchema.parse(request.body);
      await request.db((tx) =>
        tx.driftFinding.update({ where: { id: findingId }, data: { status: body.status } }),
      );
      return reply.code(204).send();
    },
  );
}
```

- [ ] **Step 10: Add the person access route and mount everything**

The person routes already exist as a plugin under `/api/admin`, so the access view goes in `apps/api/src/routes/admin/persons.ts` beside `/persons/:id` rather than in a `persons.ts` at the root — there is no `/api/persons` in this application.

```ts
  app.get(
    '/persons/:id/access',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return explainPersonAccess(request.tenantId, id);
    },
  );
```

with `explainPersonAccess` added to the existing `@syntra/core` import in that file. `PROVISION_READ` and not `IDENTITY_READ`: somebody who may read the person register is not thereby entitled to see every entitlement they hold in every target system.

Then in `apps/api/src/app.ts`, beside the other admin registrations and **after** `registerAdminPersonRoutes` so `/persons/:id` cannot shadow `/persons/:id/access`:

```ts
  await app.register(registerAdminTargetRoutes, {
    prefix: '/api/admin',
    masterKey: config.masterKey,
    authRateLimitMax: config.authRateLimitMax,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminProfileRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminRuleRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminProvisionRunRoutes, {
    prefix: '/api/admin',
    masterKey: config.masterKey,
    transport,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
```

`transport` is the same value the password-reset routes are given, so a delivered initial password goes through the memory transport in tests and SMTP in production, and a test can assert on `ctx.mail`.

- [ ] **Step 11: Run the route tests**

Run: `pnpm vitest run apps/api/src/routes/admin/provision.test.ts`
Expected: PASS, 8 tests.

`refuses without provision.manage` and `refuses without provision.read, even to somebody who can read persons` are the two that make the permission split real rather than decorative. Reading who holds what in the finance system is a reasonable thing to grant an auditor; changing a threshold is not, and neither is inheriting the first from `identity.read`.

- [ ] **Step 12: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add the provisioning administration API and previews"
```

---

## Task 18: The console, the end-to-end path, and whole-slice verification

**Files:**
- Create: `apps/web/src/pages/admin/TargetsPage.tsx`
- Create: `apps/web/src/pages/admin/TargetDetailPage.tsx`
- Create: `apps/web/src/pages/admin/TargetDetailPage.test.tsx`
- Create: `apps/web/src/pages/admin/AccountProfilePage.tsx`
- Create: `apps/web/src/pages/admin/BusinessRulesPage.tsx`
- Create: `apps/web/src/pages/admin/ProvisionRunsPage.tsx`
- Create: `apps/web/src/pages/admin/ProvisionRunDetailPage.tsx`
- Create: `apps/web/src/pages/PersonAccessPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx` — the console route tree. `routes.tsx` is **not** touched: it already mounts `/admin/*` behind the elevated-session guard and lazily loads `AdminApp`.
- Create: `e2e/provision.spec.ts`
- Create: `packages/core/src/provision/loop.integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: every endpoint Task 17 registered; `api` and `ApiError` from `apps/web/src/session/api.js`, and `useApiResource` from `apps/web/src/session/use-api-resource.js`; the existing `PageHeader` primitive the admin pages already use.
- Produces: the routes `/admin/targets`, `/admin/targets/:id`, `/admin/targets/:id/profile`, `/admin/targets/:id/rules`, `/admin/targets/:id/runs`, `/admin/targets/:id/runs/:runId`, `/admin/people/:id/access`.

**There is no `apps/web/src/api.ts` and no `apiFetch`.** The helper is `api<T>(path, init?: RequestInit)` in `apps/web/src/session/api.ts`: it takes a real `RequestInit`, so a JSON body is `body: JSON.stringify(...)` and the helper adds the content type only when a body is present. It throws `ApiError` carrying an RFC 9457 problem, returns `undefined` on a 204, and every page below relies on both.

Console routes are declared in `apps/web/src/pages/admin/AdminApp.tsx` with paths **relative** to `/admin`, not in `routes.tsx` — `routes.tsx` mounts `/admin/*` behind an elevated-session guard and lazily loads `AdminApp`, and nothing else belongs there. The person register is at `/admin/people/:id`, so the access view is `/admin/people/:id/access`.

- [ ] **Step 1: Write the targets list, carrying the skip badge**

`apps/web/src/pages/admin/TargetsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../session/api.js';

interface TargetRow {
  id: string;
  name: string;
  enabled: boolean;
  enforcementMode: 'additive' | 'authoritative';
  schedule: string | null;
  lastRunAt: string | null;
  lastAppliedRunAt: string | null;
  consecutiveSkippedRuns: number;
  lastSkipReason: string | null;
}

export function TargetsPage() {
  const [targets, setTargets] = useState<TargetRow[]>([]);

  useEffect(() => {
    // The API wraps collections in a named key, as every other admin endpoint
    // in this application does.
    void api<{ targets: TargetRow[] }>('/api/admin/targets').then((body) =>
      setTargets(body.targets),
    );
  }, []);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Target systems</h1>
        <Link className="rounded bg-slate-900 px-3 py-2 text-white" to="/admin/targets/new">
          New target
        </Link>
      </div>

      {targets.length === 0 && (
        <p className="mt-6 text-slate-600">
          No target systems yet. A target is where Provision writes accounts and
          entitlements.
        </p>
      )}

      <table className="mt-6 w-full text-left">
        <thead>
          <tr className="border-b text-sm text-slate-500">
            <th className="py-2">Name</th>
            <th>Enforcement</th>
            <th>Schedule</th>
            <th>Last run</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => (
            <tr key={target.id} className="border-b">
              <td className="py-3">
                <Link className="font-medium underline" to={`/admin/targets/${target.id}`}>
                  {target.name}
                </Link>
              </td>
              <td>
                {/* Ruling P2: the mode is per target and visible on its screen. */}
                <span
                  className={
                    target.enforcementMode === 'authoritative'
                      ? 'rounded bg-amber-100 px-2 py-1 text-amber-900'
                      : 'rounded bg-slate-100 px-2 py-1 text-slate-700'
                  }
                >
                  {target.enforcementMode}
                </span>
              </td>
              <td className="text-slate-600">{target.schedule ?? 'manual'}</td>
              <td className="text-slate-600">
                {target.lastRunAt ? new Date(target.lastRunAt).toLocaleString() : 'never'}
              </td>
              <td>
                {/*
                  Ruling P4: a target that has skipped repeatedly is visibly
                  distinguishable from one running cleanly. An audit event
                  nobody reads is explicitly not sufficient.
                */}
                {target.consecutiveSkippedRuns > 0 ? (
                  <span
                    className="rounded bg-red-100 px-2 py-1 text-red-900"
                    title={target.lastSkipReason ?? ''}
                  >
                    {target.consecutiveSkippedRuns} scheduled run
                    {target.consecutiveSkippedRuns === 1 ? '' : 's'} skipped
                  </span>
                ) : !target.enabled ? (
                  <span className="rounded bg-slate-100 px-2 py-1 text-slate-700">
                    disabled
                  </span>
                ) : (
                  <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-900">
                    running cleanly
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Write the target editor, including the create path and the connection test**

One page serves both `targets/new` and `targets/:id`, which is how
`SourceDetailPage` already handles directory sources — read it before writing
this and match it. It uses the design system (`Panel`, `Field`, `Button`,
`Alert`, `Status`, `PageHeader`) rather than raw Tailwind on bare `<label>` and
`<input>` elements, and every other admin page does the same; a page that styles
itself is a page that drifts.

The connection test is not decoration. `test()` reports four effective rights
with `unverified` as a third state distinct from `granted`, and without a surface
for them that distinction ships as dead data. A bind account that can read the
directory but cannot create users passes an `ok: true` connection test — the
rights list is the only thing on this page that says so before a run tries it for
real against a live directory.

`apps/web/src/pages/admin/TargetDetailPage.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

interface TestResult {
  ok: boolean;
  message: string;
  rights?: ConnectorRight[];
}

interface Target {
  id: string;
  name: string;
  config: { url?: string; bindDn?: string; baseDn?: string };
  enabled: boolean;
  autoApply: boolean;
  schedule: string | null;
  enforcementMode: 'additive' | 'authoritative';
  preHireDays: number;
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  archiveAfterDays: number | null;
  reenableWithoutConfirmationDays: number;
  renameEnabled: boolean;
  createAccountThresholdPercent: number;
  disableAccountThresholdPercent: number;
  archiveAccountThresholdPercent: number;
  revokeEntitlementThresholdPercent: number;
  deactivateSyntraUserThresholdPercent: number;
  perEntitlementThresholdPercent: number;
  personPopulationDropPercent: number;
  consecutiveSkippedRuns: number;
  lastSkipReason: string | null;
}

const RIGHT_LABELS: Record<ConnectorRight['right'], string> = {
  createUser: 'Create accounts',
  modifyUser: 'Modify accounts',
  moveUser: 'Move accounts between containers',
  modifyMembership: 'Change group membership',
};

/**
 * `unverified` renders as its own tone, never as a quiet `granted`.
 *
 * A directory that does not publish effective rights cannot be read as having
 * granted them. Collapsing the two turns "we could not tell" into "yes", which
 * is the one reading an administrator must not be given by a screen whose whole
 * job is to answer whether this bind account can do the work.
 */
function rightTone(status: ConnectorRight['status']): 'active' | 'danger' | 'muted' {
  if (status === 'granted') return 'active';
  if (status === 'denied') return 'danger';
  return 'muted';
}

function RightsReport({ rights }: { rights: ConnectorRight[] }) {
  return (
    <ul className="space-y-2">
      {rights.map((r) => (
        <li key={r.right} className="flex flex-wrap items-center gap-2">
          <Status tone={rightTone(r.status)}>
            {r.status === 'unverified' ? 'Could not check' : r.status}
          </Status>
          <span className="text-ink">{RIGHT_LABELS[r.right]}</span>
          <span className="text-muted">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function TestReport({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Could not connect">
        {result.message}
      </Alert>
    );
  }

  return (
    <Panel title="Connection test">
      <div className="space-y-4 p-4">
        <p className="flex flex-wrap items-center gap-2">
          <Status tone="active">Connected</Status>
          <span className="text-muted">{result.message}</span>
        </p>
        {result.rights && result.rights.length > 0 && (
          <>
            <p className="text-muted">
              What this bind account is allowed to do. A right it could not
              confirm is not a right it has.
            </p>
            <RightsReport rights={result.rights} />
          </>
        )}
      </div>
    </Panel>
  );
}

export function TargetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined;
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('ldaps://');
  const [bindDn, setBindDn] = useState('');
  const [baseDn, setBaseDn] = useState('');
  const [bindPassword, setBindPassword] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'test'>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    void api<Target>(`/api/admin/targets/${id}`)
      .then((t) => {
        setTarget(t);
        setName(t.name);
        setUrl(t.config.url ?? '');
        setBindDn(t.config.bindDn ?? '');
        setBaseDn(t.config.baseDn ?? '');
      })
      .catch(() => setError('That target could not be loaded.'))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const fail = (cause: unknown, fallback: string) =>
    setError(cause instanceof ApiError ? cause.problem.title : fallback);

  async function onTest() {
    setBusy('test');
    setError(null);
    setResult(null);
    try {
      setResult(
        await api<TestResult>('/api/admin/targets/test', {
          method: 'POST',
          body: JSON.stringify({
            config: { url, bindDn, baseDn },
            // An existing target borrows its stored password when the field is
            // left blank, so testing an unchanged target does not require
            // retyping a secret the server already holds.
            ...(bindPassword === '' ? {} : { bindPassword }),
            ...(isNew ? {} : { borrowFromTargetId: id }),
          }),
        }),
      );
    } catch (cause) {
      fail(cause, 'The connection could not be tested.');
    } finally {
      setBusy(null);
    }
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError(null);
    try {
      if (isNew) {
        const created = await api<{ id: string }>('/api/admin/targets', {
          method: 'POST',
          body: JSON.stringify({
            name,
            config: { url, bindDn, baseDn },
            bindPassword,
          }),
        });
        navigate(`/admin/targets/${created.id}`, { replace: true });
        return;
      }
      await api(`/api/admin/targets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          config: { url, bindDn, baseDn },
          ...(bindPassword === '' ? {} : { bindPassword }),
        }),
      });
      setMessage('Saved.');
    } catch (cause) {
      fail(cause, 'The target could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function patch(body: Record<string, unknown>) {
    setError(null);
    try {
      await api(`/api/admin/targets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMessage('Saved.');
    } catch (cause) {
      fail(cause, 'That change could not be saved.');
    }
  }

  if (loading) return <SkeletonRows rows={6} cols={2} />;

  return (
    <>
      <PageHeader
        title={isNew ? 'New target' : name || 'Target'}
        description={
          isNew
            ? 'Where Syntra creates and maintains accounts. Nothing is written until a run is reviewed.'
            : 'Provisioning settings for this target.'
        }
        actions={
          <Button onClick={onTest} loading={busy === 'test'} disabled={!!busy}>
            Test connection
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {result && <TestReport result={result} />}

      {/*
        The skipped-run notice sits above everything a person came here to
        change, because ruling P4 is explicit that a skipped run has to be
        surfaced where somebody looks rather than only recorded. A target that
        has skipped repeatedly must read differently from one running cleanly,
        and the count is what makes that visible at a glance.
      */}
      {target && target.consecutiveSkippedRuns > 0 && (
        <Alert
          tone="danger"
          title={`${target.consecutiveSkippedRuns} scheduled run${
            target.consecutiveSkippedRuns === 1 ? '' : 's'
          } did not start`}
        >
          <p>{target.lastSkipReason}</p>
          <p className="mt-2">
            A scheduled run does not start while a run is awaiting review.
            Review the outstanding run and this clears on the next schedule.
          </p>
        </Alert>
      )}

      <Panel title="Connection">
        <form onSubmit={onSave} noValidate className="space-y-4 p-4">
          <Field label="Name" value={name} onChange={setName} required />
          <Field
            label="URL"
            value={url}
            onChange={setUrl}
            required
            hint="Writes require LDAPS or StartTLS. A Samba AD domain controller refuses even a bind in the clear."
          />
          <Field label="Bind DN" value={bindDn} onChange={setBindDn} required />
          <Field
            label="Bind password"
            type="password"
            value={bindPassword}
            onChange={setBindPassword}
            autoComplete="new-password"
            required={isNew}
            hint={isNew ? undefined : 'Leave blank to keep the stored password.'}
          />
          <Field label="Base DN" value={baseDn} onChange={setBaseDn} required />
          <Button type="submit" variant="primary" loading={busy === 'save'}>
            {isNew ? 'Create target' : 'Save'}
          </Button>
        </form>
      </Panel>

      {/*
        These three links are the only route into the rest of the target's
        configuration. Without them the sub-pages exist and are reachable only
        by typing a URL, which is the same as not existing.
      */}
      {!isNew && (
        <Panel title="Configuration">
          <ul className="space-y-2 p-4">
            <li>
              <Link
                className="text-accent underline"
                to={`/admin/targets/${id}/profile`}
              >
                Account profile
              </Link>
              <span className="ml-2 text-muted">
                How an account is named, where it is placed, and what it is
                given.
              </span>
            </li>
            <li>
              <Link
                className="text-accent underline"
                to={`/admin/targets/${id}/rules`}
              >
                Business rules
              </Link>
              <span className="ml-2 text-muted">
                Who gets an account here, and which entitlements come with it.
              </span>
            </li>
            <li>
              <Link
                className="text-accent underline"
                to={`/admin/targets/${id}/runs`}
              >
                Runs
              </Link>
              <span className="ml-2 text-muted">
                What each run proposed, what was applied, and what drifted.
              </span>
            </li>
          </ul>
        </Panel>
      )}

      {target && (
        <Panel title="Scheduling">
          <div className="space-y-4 p-4">
            <Field
              label="Schedule"
              value={target.schedule ?? ''}
              onChange={(v) => void patch({ schedule: v === '' ? null : v })}
              hint="A cron expression. Blank means this target only runs when somebody asks it to."
            />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={target.autoApply}
                onChange={(e) => void patch({ autoApply: e.target.checked })}
              />
              <span className="text-ink">
                Apply automatically when the guard does not block the run
              </span>
            </label>
            <p className="text-muted">
              The guard is not advisory: a blocked run never applies on a
              schedule, whatever this says.
            </p>
          </div>
        </Panel>
      )}
    </>
  );
}
```

Read `apps/web/src/pages/admin/SourceDetailPage.tsx` alongside this. It is the
same shape against the same helpers, and where the two differ the existing file
is right: `api(path, RequestInit)` from `session/api.js` with every body
`JSON.stringify`ed, `ApiError` for the message, `Field` with an `onChange` that
takes the value rather than the event, and `PageHeader` carrying the actions.

- [ ] **Step 2a: Test the rights report, including the state that must not be mistaken for approval**

`apps/web/src/pages/admin/TargetDetailPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TargetDetailPage } from './TargetDetailPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const renderNew = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/new']}>
      <Routes>
        <Route path="/admin/targets/new" element={<TargetDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TargetDetailPage', () => {
  it('reports a right it could not confirm as unchecked, not as granted', async () => {
    // The failure this test exists to catch: a directory that does not publish
    // effective rights renders indistinguishably from one that granted them,
    // so an administrator reads "connected" and discovers at the first run
    // that the bind account cannot create anybody.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({
        ok: true,
        message: 'Bound as CN=svc,DC=acme,DC=test',
        rights: [
          {
            right: 'createUser',
            status: 'granted',
            detail: 'Confirmed on OU=Staff',
          },
          {
            right: 'modifyUser',
            status: 'denied',
            detail: 'Refused on OU=Staff',
          },
          {
            right: 'moveUser',
            status: 'unverified',
            detail: 'The server publishes no effective rights',
          },
          {
            right: 'modifyMembership',
            status: 'granted',
            detail: 'Confirmed on CN=Finance',
          },
        ],
      }),
    );

    renderNew();
    await userEvent.click(
      screen.getByRole('button', { name: /test connection/i }),
    );

    expect(
      await screen.findByText('Move accounts between containers'),
    ).toBeVisible();
    expect(screen.getByText(/could not check/i)).toBeVisible();

    // The load-bearing assertion: exactly the two genuinely granted rights say
    // so. If `unverified` ever renders as `granted`, this count becomes three.
    expect(screen.getAllByText('granted')).toHaveLength(2);
    expect(screen.getByText('denied')).toBeVisible();
  });

  it('offers the create form without loading a target first', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderNew();

    expect(await screen.findByLabelText(/^name$/i)).toBeVisible();
    expect(screen.getByLabelText(/url/i)).toBeVisible();
    expect(screen.getByLabelText(/bind dn/i)).toBeVisible();
    expect(screen.getByLabelText(/bind password/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /create target/i }),
    ).toBeVisible();
    // A create page that fetches a target by id is a create page that 404s.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2b: Run the two tests, then break the rights report on purpose**

Run: `pnpm --filter @syntra/web test -- TargetDetailPage`
Expected: both PASS.

Then change `rightTone` to return `'active'` for `unverified` and re-run. The
first test MUST fail on the `granted` count. Restore it. A test that still
passes when `unverified` renders as granted is not testing the thing the report
exists for.


- [ ] **Step 3: Write the account profile editor with its live preview**

`apps/web/src/pages/admin/AccountProfilePage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../session/api.js';

interface Preview {
  correlationKey: string | null;
  taken: boolean;
  container: string | null;
  attributes: Record<string, string>;
  problems: string[];
}

interface Profile {
  correlationKeyTemplate: string;
  maxUniquenessAttempts: number;
  containerTemplate: string;
  fallbackContainer: string;
  attributeTemplates: Record<string, string>;
  initialPasswordPolicy: Record<string, unknown>;
  initialPasswordDelivery: 'manager' | 'personalEmail' | 'vaultOnly';
}

const EMPTY: Profile = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
  fallbackContainer: '',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly',
};

export function AccountProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [personId, setPersonId] = useState('');
  const [persons, setPersons] = useState<{ id: string; displayName: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    void api<Profile>(`/api/admin/targets/${id}/profile`)
      .then(setProfile)
      // A 404 here is "no profile saved yet", which is the ordinary state of a
      // target somebody has just created, not an error to apologise for.
      .catch(() => setProfile(EMPTY));
    void api<{ persons: { id: string; givenName: string; familyName: string }[] }>(
      '/api/admin/persons',
    ).then((body) =>
      setPersons(
        body.persons.map((p) => ({
          id: p.id,
          displayName: `${p.givenName} ${p.familyName}`.trim(),
        })),
      ),
    );
  }, [id]);

  const runPreview = async () => {
    setPreview(
      await api<Preview>(`/api/admin/targets/${id}/profile/preview`, {
        method: 'POST',
        body: JSON.stringify({ profile, personId }),
      }),
    );
  };

  return (
    <div className="grid grid-cols-2 gap-8 p-6">
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Account profile</h1>
        <p className="text-sm text-slate-600">
          Rules answer <em>whether</em> somebody gets an account. This answers
          what that account looks like.
        </p>
        {(
          [
            ['correlationKeyTemplate', 'Account name (sAMAccountName) template'],
            ['containerTemplate', 'Container template'],
            ['fallbackContainer', 'Fallback container (required)'],
          ] as const
        ).map(([field, label]) => (
          <label className="block text-sm" key={field}>
            {label}
            <input
              className="mt-1 w-full rounded border px-2 py-1 font-mono"
              value={profile[field]}
              onChange={(e) => setProfile({ ...profile, [field]: e.target.value })}
            />
          </label>
        ))}
        <label className="block text-sm">
          Initial password delivery
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={profile.initialPasswordDelivery}
            onChange={(e) =>
              setProfile({
                ...profile,
                initialPasswordDelivery: e.target.value as Profile['initialPasswordDelivery'],
              })
            }
          >
            <option value="vaultOnly">vault only — nobody is sent it</option>
            <option value="manager">the person&apos;s manager</option>
            <option value="personalEmail">the person&apos;s personal email</option>
          </select>
        </label>
        <button
          className="rounded bg-slate-900 px-3 py-2 text-white"
          onClick={() =>
            void api(`/api/admin/targets/${id}/profile`, {
              method: 'PUT',
              body: JSON.stringify(profile),
            })
          }
        >
          Save profile
        </button>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-medium">Live preview</h2>
        <p className="text-sm text-slate-600">
          A template language nobody can try is a template language everybody
          gets wrong.
        </p>
        <select
          className="w-full rounded border px-2 py-1"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
        >
          <option value="">Pick a person…</option>
          {persons.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
        <button
          className="rounded border px-3 py-2"
          disabled={personId === ''}
          onClick={() => void runPreview()}
        >
          Preview
        </button>

        {preview && (
          <dl className="rounded border p-4 text-sm">
            <dt className="font-medium">Account name</dt>
            <dd className="font-mono">
              {preview.correlationKey ?? '—'}{' '}
              {preview.taken && (
                <span className="text-amber-700">
                  (the base name is already taken; this is the next free one)
                </span>
              )}
            </dd>
            <dt className="mt-2 font-medium">Container</dt>
            <dd className="font-mono">{preview.container ?? '—'}</dd>
            {Object.entries(preview.attributes).map(([name, value]) => (
              <div key={name}>
                <dt className="mt-2 font-medium">{name}</dt>
                <dd className="font-mono">{value}</dd>
              </div>
            ))}
            {preview.problems.length > 0 && (
              <div className="mt-3 rounded bg-red-50 p-2 text-red-900">
                {preview.problems.map((problem) => (
                  <p key={problem}>{problem}</p>
                ))}
              </div>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the business rules editor with its impact preview**

`apps/web/src/pages/admin/BusinessRulesPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../session/api.js';

interface Entitlement {
  id: string;
  displayName: string;
  status: string;
}

interface Rule {
  id?: string;
  name: string;
  condition: unknown;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}

interface Impact {
  matchedPersons: number;
  totalPersons: number;
  wouldGrant: number;
  wouldRevoke: number;
  sample: { personId: string; displayName: string }[];
}

const FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
];

const OPERATORS = [
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
];

export function BusinessRulesPage() {
  const { id } = useParams<{ id: string }>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [draft, setDraft] = useState<Rule>({
    name: '',
    condition: { field: 'contract.department', op: 'equals', value: '' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
  });
  const [impact, setImpact] = useState<Impact | null>(null);

  const reload = () => {
    void api<{ rules: Rule[] }>(`/api/admin/targets/${id}/rules`).then((body) =>
      setRules(body.rules),
    );
    void api<{ entitlements: Entitlement[] }>(
      `/api/admin/targets/${id}/entitlements`,
    ).then((body) => setEntitlements(body.entitlements));
  };
  useEffect(reload, [id]);

  const leaf = draft.condition as { field: string; op: string; value?: string };

  return (
    <div className="grid grid-cols-2 gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Business rules</h1>
        <p className="text-sm text-slate-600">
          A rule is evaluated against each of a person&apos;s active contracts
          independently, and the results are unioned. Adding a rule never removes
          access.
        </p>
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <li className="rounded border p-3" key={rule.id}>
              <span className="font-medium">{rule.name}</span>
              {!rule.enabled && <span className="ml-2 text-slate-500">(disabled)</span>}
              <button
                className="ml-3 text-sm underline"
                onClick={async () => {
                  await api(`/api/admin/rules/${rule.id}`, { method: 'DELETE' });
                  reload();
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">New rule</h2>
        <input
          className="w-full rounded border px-2 py-1"
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <div className="flex gap-2">
          <select
            className="rounded border px-2 py-1"
            value={leaf.field}
            onChange={(e) =>
              setDraft({ ...draft, condition: { ...leaf, field: e.target.value } })
            }
          >
            {FIELDS.map((field) => (
              <option key={field}>{field}</option>
            ))}
          </select>
          <select
            className="rounded border px-2 py-1"
            value={leaf.op}
            onChange={(e) =>
              setDraft({ ...draft, condition: { ...leaf, op: e.target.value } })
            }
          >
            {OPERATORS.map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
          {leaf.op !== 'isEmpty' && leaf.op !== 'isNotEmpty' && (
            <input
              className="flex-1 rounded border px-2 py-1"
              value={leaf.value ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, condition: { ...leaf, value: e.target.value } })
              }
            />
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.grantsAccount}
            onChange={(e) => setDraft({ ...draft, grantsAccount: e.target.checked })}
          />
          A match requires an account in this target
        </label>
        <fieldset className="rounded border p-2">
          <legend className="text-sm">Entitlements granted</legend>
          {entitlements.map((entitlement) => (
            <label className="block text-sm" key={entitlement.id}>
              <input
                type="checkbox"
                checked={draft.entitlementIds.includes(entitlement.id)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    entitlementIds: e.target.checked
                      ? [...draft.entitlementIds, entitlement.id]
                      : draft.entitlementIds.filter((x) => x !== entitlement.id),
                  })
                }
              />{' '}
              {entitlement.displayName}
              {entitlement.status !== 'present' && (
                <span className="ml-2 text-red-700">
                  ({entitlement.status} — a rule naming it makes every person it
                  would be evaluated against unprocessable)
                </span>
              )}
            </label>
          ))}
        </fieldset>

        <div className="flex gap-2">
          <button
            className="rounded border px-3 py-2"
            onClick={async () =>
              setImpact(
                await api<Impact>(`/api/admin/targets/${id}/rules/impact`, {
                  method: 'POST',
                  body: JSON.stringify(draft),
                }),
              )
            }
          >
            Preview impact
          </button>
          <button
            className="rounded bg-slate-900 px-3 py-2 text-white"
            onClick={async () => {
              await api(`/api/admin/targets/${id}/rules`, {
                method: 'PUT',
                body: JSON.stringify(draft),
              });
              reload();
            }}
          >
            Save rule
          </button>
        </div>

        {impact && (
          <div className="rounded border p-3 text-sm">
            {/* A rule whose blast radius is only visible after it is saved is a
                rule that gets saved and then discovered. */}
            <p>
              This rule matches <strong>{impact.matchedPersons}</strong> of{' '}
              {impact.totalPersons} persons; enabling it would grant{' '}
              <strong>{impact.wouldGrant}</strong> entitlements and revoke{' '}
              <strong>{impact.wouldRevoke}</strong>.
            </p>
            <ul className="mt-2 text-slate-600">
              {impact.sample.map((person) => (
                <li key={person.personId}>{person.displayName}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the run history and run detail screens**

`apps/web/src/pages/admin/ProvisionRunsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../session/api.js';

interface Run {
  id: string;
  status: string;
  startedAt: string;
  personsEvaluated: number;
  personsUnprocessable: number;
  blockedReason: string | null;
  error: string | null;
}

/**
 * Spec section 14's status list has no `superseded`, so a run that a later run
 * stepped over is recorded `failed` with an explanatory `error` -- which is a
 * defensible choice for the data and a bad one for the screen, because it puts
 * routine supersedes and genuine failures in the same red bucket and trains
 * people to ignore red.
 */
const displayStatus = (run: Run) =>
  run.status === 'failed' && (run.error ?? '').startsWith('superseded')
    ? 'superseded'
    : run.status;

export function ProvisionRunsPage() {
  const { id } = useParams<{ id: string }>();
  const [runs, setRuns] = useState<Run[]>([]);

  const reload = () => {
    void api<{ runs: Run[] }>(`/api/admin/targets/${id}/runs`).then((body) =>
      setRuns(body.runs),
    );
  };
  useEffect(reload, [id]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Runs</h1>
        <button
          className="rounded bg-slate-900 px-3 py-2 text-white"
          onClick={async () => {
            await api(`/api/admin/targets/${id}/runs`, { method: 'POST' });
            setTimeout(reload, 1500);
          }}
        >
          Run now
        </button>
      </div>
      <table className="mt-6 w-full text-left">
        <thead>
          <tr className="border-b text-sm text-slate-500">
            <th className="py-2">Started</th>
            <th>Status</th>
            <th>Persons</th>
            <th>Exceptions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr className="border-b" key={run.id}>
              <td className="py-3">
                <Link className="underline" to={`/admin/targets/${id}/runs/${run.id}`}>
                  {new Date(run.startedAt).toLocaleString()}
                </Link>
              </td>
              <td>
                <span
                  className={
                    displayStatus(run) === 'blocked'
                      ? 'rounded bg-amber-100 px-2 py-1 text-amber-900'
                      : displayStatus(run) === 'failed'
                        ? 'rounded bg-red-100 px-2 py-1 text-red-900'
                        : 'rounded bg-slate-100 px-2 py-1'
                  }
                  title={run.error ?? ''}
                >
                  {displayStatus(run)}
                </span>
              </td>
              <td>{run.personsEvaluated}</td>
              <td className={run.personsUnprocessable > 0 ? 'text-red-800' : ''}>
                {run.personsUnprocessable}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/pages/admin/ProvisionRunDetailPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../session/api.js';

interface Action {
  id: string;
  actionType: string;
  status: string;
  message: string | null;
  requiresConfirmation: boolean;
  before: unknown;
  after: unknown;
  attributedRuleIds: string[];
  person: { id: string; givenName: string | null; familyName: string | null } | null;
}

interface Exception {
  id: string;
  kind: string;
  message: string;
  person: { id: string; givenName: string | null; familyName: string | null };
}

interface Drift {
  id: string;
  kind: string;
  status: string;
  detail: Record<string, unknown>;
}

interface Run {
  id: string;
  status: string;
  blockedReason: string | null;
  requiresConfirmation: boolean;
  actions: Action[];
  exceptions: Exception[];
}

type Tab = 'person' | 'type' | 'exceptions' | 'drift';

const nameOf = (person: { givenName: string | null; familyName: string | null } | null) =>
  person === null ? 'unattributed' : `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim();

export function ProvisionRunDetailPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [tab, setTab] = useState<Tab>('person');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = () => {
    void api<Run>(`/api/admin/targets/${id}/runs/${runId}`).then((loaded) => {
      setRun(loaded);
      setSelected(
        new Set(loaded.actions.filter((a) => a.status === 'proposed').map((a) => a.id)),
      );
    });
    void api<{ findings: Drift[] }>(`/api/admin/targets/${id}/drift`).then((body) =>
      setDrift(body.findings),
    );
  };
  useEffect(reload, [id, runId]);

  if (!run) return <div className="p-6">Loading…</div>;

  const byPerson = new Map<string, Action[]>();
  for (const action of run.actions) {
    const key = nameOf(action.person);
    byPerson.set(key, [...(byPerson.get(key) ?? []), action]);
  }

  const apply = async () => {
    try {
      const result = await api<{ status: string }>(
        `/api/admin/targets/${id}/runs/${runId}/apply`,
        { method: 'POST', body: JSON.stringify({ only: [...selected], confirm }) },
      );
      setMessage(`Applied. The run is now ${result.status}.`);
      reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not apply.');
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Run detail</h1>

      {run.status === 'blocked' && (
        <div className="mt-4 rounded border border-amber-400 bg-amber-50 p-4">
          <p className="font-medium text-amber-900">This run is blocked</p>
          {/* A blocked run leads with why and the numbers behind it. */}
          <ul className="mt-1 list-disc pl-5 text-amber-900">
            {(run.blockedReason ?? '').split('; ').map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {run.requiresConfirmation ? (
            <label className="mt-3 flex items-center gap-2 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              I have read the numbers above and want to apply this run anyway
            </label>
          ) : (
            <p className="mt-3 text-sm text-amber-900">
              This one cannot be confirmed away. An empty target and an
              unreachable one look identical, and a collapsed person population
              is the signature of a broken feed.
            </p>
          )}
        </div>
      )}

      {run.exceptions.length > 0 && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-4 text-red-900">
          {/* An exception is not a warning to be scrolled past: every person on
              that list is a person whose access is frozen until somebody fixes
              something. */}
          <strong>{run.exceptions.length}</strong> person
          {run.exceptions.length === 1 ? '' : 's'} could not be processed and were
          excluded from this plan entirely. Their existing access was not touched.
        </div>
      )}

      <nav className="mt-6 flex gap-4 border-b">
        {(['person', 'type', 'exceptions', 'drift'] as Tab[]).map((name) => (
          <button
            className={tab === name ? 'border-b-2 border-slate-900 pb-2' : 'pb-2'}
            key={name}
            onClick={() => setTab(name)}
          >
            {name === 'person'
              ? 'By person'
              : name === 'type'
                ? 'By type'
                : name === 'exceptions'
                  ? `Exceptions (${run.exceptions.length})`
                  : `Drift (${drift.length})`}
          </button>
        ))}
      </nav>

      {tab === 'person' &&
        [...byPerson].map(([person, actions]) => (
          <section className="mt-4" key={person}>
            <h2 className="font-medium">{person}</h2>
            <ul>
              {actions.map((action) => (
                <li className="flex items-center gap-2 py-1 text-sm" key={action.id}>
                  <input
                    type="checkbox"
                    disabled={action.status !== 'proposed'}
                    checked={selected.has(action.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(action.id);
                      else next.delete(action.id);
                      setSelected(next);
                    }}
                  />
                  <code>{action.actionType}</code>
                  <span className="text-slate-500">{action.status}</span>
                  {action.requiresConfirmation && (
                    <span className="rounded bg-amber-100 px-2 text-amber-900">
                      needs confirmation
                    </span>
                  )}
                  {action.message && (
                    <span className="text-slate-600">{action.message}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

      {tab === 'type' && (
        <ul className="mt-4">
          {run.actions.map((action) => (
            <li className="py-1 text-sm" key={action.id}>
              <code>{action.actionType}</code> — {nameOf(action.person)} —{' '}
              {action.status}
            </li>
          ))}
        </ul>
      )}

      {tab === 'exceptions' && (
        <ul className="mt-4">
          {run.exceptions.map((exception) => (
            <li className="py-1 text-sm" key={exception.id}>
              <strong>{nameOf(exception.person)}</strong> — {exception.kind} —{' '}
              {exception.message}
            </li>
          ))}
        </ul>
      )}

      {tab === 'drift' && (
        <ul className="mt-4">
          {drift.map((finding) => (
            <li className="flex items-center gap-3 py-1 text-sm" key={finding.id}>
              <code>{finding.kind}</code>
              <span className="text-slate-600">{String(finding.detail.reason ?? '')}</span>
              <span className="text-slate-500">{finding.status}</span>
              {finding.status === 'open' && (
                <button
                  className="underline"
                  onClick={async () => {
                    await api(`/api/admin/drift/${finding.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status: 'acknowledged' }),
                    });
                    reload();
                  }}
                >
                  Acknowledge
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-40"
          disabled={selected.size === 0}
          onClick={() => void apply()}
        >
          Apply {selected.size} action{selected.size === 1 ? '' : 's'}
        </button>
        {message && <span className="text-sm">{message}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the person access page**

`apps/web/src/pages/PersonAccessPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../session/api.js';

interface Access {
  personId: string;
  accounts: {
    targetSystemId: string;
    targetName: string;
    correlationKey: string;
    status: string;
    entitlements: {
      entitlementId: string;
      displayName: string;
      origin: string;
      ruleName: string | null;
      contractDescription: string | null;
    }[];
  }[];
}

export function PersonAccessPage() {
  const { id } = useParams<{ id: string }>();
  const [access, setAccess] = useState<Access | null>(null);

  useEffect(() => {
    void api<Access>(`/api/admin/persons/${id}/access`).then(setAccess);
  }, [id]);

  if (!access) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Why does this person hold this?</h1>
      {access.accounts.length === 0 && (
        <p className="mt-4 text-slate-600">
          This person holds no target-system accounts.
        </p>
      )}
      {access.accounts.map((account) => (
        <section className="mt-6" key={account.targetSystemId}>
          <h2 className="font-medium">
            {account.targetName} — <code>{account.correlationKey}</code>{' '}
            <span className="text-slate-500">({account.status})</span>
          </h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b text-slate-500">
                <th className="py-1">Entitlement</th>
                <th>Origin</th>
                <th>Rule</th>
                <th>Contract</th>
              </tr>
            </thead>
            <tbody>
              {account.entitlements.map((holding) => (
                <tr className="border-b" key={holding.entitlementId}>
                  <td className="py-1">{holding.displayName}</td>
                  <td>{holding.origin}</td>
                  <td>{holding.ruleName ?? '—'}</td>
                  <td>{holding.contractDescription ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Wire the routes**

In `apps/web/src/pages/admin/AdminApp.tsx`, beside the existing `<Route path="sources" .../>` entries. Paths are **relative** — `routes.tsx` already mounts `/admin/*` behind the elevated-session guard and lazily loads this component, and adding absolute `/admin/...` routes there would both duplicate the tree and bypass that guard:

```tsx
            <Route path="targets" element={<TargetsPage />} />
            <Route path="targets/new" element={<TargetDetailPage />} />
            <Route path="targets/:id" element={<TargetDetailPage />} />
            <Route path="targets/:id/profile" element={<AccountProfilePage />} />
            <Route path="targets/:id/rules" element={<BusinessRulesPage />} />
            <Route path="targets/:id/runs" element={<ProvisionRunsPage />} />
            <Route path="targets/:id/runs/:runId" element={<ProvisionRunDetailPage />} />
            <Route path="people/:id/access" element={<PersonAccessPage />} />
```

with the seven imports at the top of that file, and the `Link`s in the pages above written against the same `/admin/...` paths. Put `people/:id/access` after the existing `people/:id` entry, and `targets/:id/runs/:runId` after `targets/:id/runs`, so a more specific path is never shadowed by a less specific one.

`targets/new` and `targets/:id` both render `TargetDetailPage`, which decides between the create form and the editor from whether `useParams` gave it an id — the same arrangement `sources/new` and `sources/:id` already use for directory sources. It is listed first for readability; React Router ranks a static segment above a dynamic one regardless of order, so `new` is never captured as an id.

- [ ] **Step 8: Write the loop integration test against the real container**

`packages/core/src/provision/loop.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'ldapts';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// The plain module, not the smoke test. Importing a test file executes it:
// its hooks and its five tests would register inside THIS file's collection
// and run again, against fixtures they already created.
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
// CORRECTED: not `@syntra/connectors/src/ad/samba-connection.js`. That
// package declares an `exports` map, which denies every unlisted subpath --
// the deep path fails with TS2307. The fixture is re-exported from the
// `testing` entry point, alongside `FakeTarget`.
} from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { refreshEntitlements } from './entitlement-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun, resolveInFlightActions } from './apply.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const samba = sambaConnection();
const testOu = `OU=LoopTest,${samba.baseDn}`;
const groupsOu = `OU=LoopGroups,${samba.baseDn}`;
const archiveOu = `OU=LoopArchive,${samba.baseDn}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let personId: string;
let admin: Client;

const config = {
  url: samba.url,
  tlsMode: 'ldaps' as const,
  rejectUnauthorized: false,
  bindDn: samba.bindDn,
  baseDn: testOu,
  entitlementSearchBase: groupsOu,
  archiveContainer: archiveOu,
};

beforeEach(async () => {
  await resetDatabase();
  admin = await connectAsSambaAdmin();
  for (const ou of [testOu, groupsOu, archiveOu]) {
    await admin.add(ou, { objectClass: ['top', 'organizationalUnit'] }).catch(() => undefined);
  }
  // Every object under the three OUs, deepest first. A fixture that only
  // clears users leaves the groups behind, and the second run of this file
  // fails on AlreadyExists.
  for (const ou of [testOu, groupsOu, archiveOu]) {
    await purgeSubtree(admin, ou);
  }
  await admin
    .add(`CN=LoopFinance,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'LoopFinance',
    })
    .catch(() => undefined);

  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      name: 'Samba AD',
      config,
      bindPassword: samba.bindPassword,
    })
  ).id;

  await refreshEntitlements(tenantId, provider, null, targetId);
  const entitlementId = await withTenant(tenantId, async (tx) =>
    (await tx.entitlement.findFirstOrThrow({ where: { targetSystemId: targetId } })).id,
  );

  personId = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: {
        tenantId,
        givenName: 'Loop',
        familyName: 'Tester',
        businessEmail: 'loop@syntra.test',
      },
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
    return person.id;
  });

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: testOu,
    fallbackContainer: testOu,
    attributeTemplates: {
      displayName: '%person.givenName% %person.familyName%',
      givenName: '%person.givenName%',
      sn: '%person.familyName%',
    },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
}, 180_000);

/** A real user: confirming a run records who confirmed it, and both halves are required. */
const confirmingUser = () =>
  withTenant(tenantId, async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId,
          login: `loop-reviewer-${Date.now()}`,
          email: 'loop-reviewer@syntra.test',
          displayName: 'Loop Reviewer',
        },
      })
    ).id,
  );

const cycle = async (now: Date) => {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now,
    resolveInFlight: (id) => resolveInFlightActions(tenantId, provider, id),
  });
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId: await confirmingUser(),
  });
  return { run, result };
};

describe('the whole loop against a real domain controller', () => {
  it('creates the account and its group on a first run, and is a no-op on the second', async () => {
    await cycle(day('2026-06-15'));
    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));
    expect(account.anchor).not.toBeNull();
    expect(account.status).toBe('active');

    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: day('2026-06-16'),
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: second.id } }),
    );
    // Convergence. A second run over an unchanged world proposes nothing.
    expect(actions).toEqual([]);
  }, 180_000);

  it('carries a leaver through disable without ever deleting', async () => {
    await cycle(day('2026-06-15'));
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { endDate: day('2026-06-20') } }),
    );
    await cycle(day('2026-06-21'));

    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));
    expect(account.status).toBe('disabled');
    // The object is still there. Provision never deletes.
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=loop.tester)',
      attributes: ['userAccountControl'],
    });
    expect(searchEntries).toHaveLength(1);
    expect(String(searchEntries[0]!.userAccountControl)).toBe('514');
  }, 180_000);

  it('re-enables the same account on a rehire rather than creating a second', async () => {
    await cycle(day('2026-06-15'));
    const first = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));

    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { endDate: day('2026-06-20') } }),
    );
    await cycle(day('2026-06-21'));
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { endDate: null } }),
    );
    await cycle(day('2026-06-24'));

    const after = await withTenant(tenantId, (tx) => tx.targetAccount.findMany({}));
    expect(after).toHaveLength(1);
    // Their old login and their old files, which is what everybody expects.
    expect(after[0]!.anchor).toBe(first.anchor);
    expect(after[0]!.status).toBe('active');
  }, 180_000);

  it('reports a name collision as a conflict rather than adopting the account', async () => {
    await admin.add(`CN=loop.tester,${testOu}`, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'loop.tester',
      userAccountControl: '514',
    });
    await cycle(day('2026-06-15'));
    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({}));
    expect(account.status).toBe('conflict');
  }, 180_000);
});
```

- [ ] **Step 9: Write the end-to-end test**

`e2e/provision.spec.ts`. Self-contained, in the shape `e2e/sync.spec.ts` already uses: there is no `e2e/support` module, and `signInAsAdmin` and `seedPerson` do not exist. The console requires an *elevated* session, so signing in is not enough — every `/admin/...` navigation goes through the re-authentication screen the way `sync.spec.ts` does it.

```ts
import { expect, test, type Page } from '@playwright/test';

const ADMIN = process.env.SEED_ADMIN_PASSWORD;

test.beforeAll(() => {
  if (!ADMIN) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set to the value the database was seeded with',
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

/** Re-authenticates into an administrative session on the way to `path`. */
async function elevateTo(page: Page, path: string, password: string) {
  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('configure a target, write a rule, review a run, apply part of it', async ({
  page,
}) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/targets', ADMIN!);

  // A fresh install has no targets, and the empty state says what a target is
  // rather than showing an empty table.
  await expect(page.getByText('No target systems yet')).toBeVisible();

  await page.getByRole('link', { name: 'New target' }).click();
  await page.getByLabel('Name').fill('Samba AD');
  await page.getByLabel('URL').fill(process.env.SAMBA_LDAPS_URL ?? 'ldaps://localhost:1637');
  await page.getByLabel('Bind DN').fill('CN=Administrator,CN=Users,DC=syntra,DC=test');
  await page.getByLabel('Bind password').fill('Syntra!Passw0rd');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected to/)).toBeVisible();
  // Spec section 18: the test says which rights it could not exercise, so an
  // over-privileged bind is a visible choice rather than a default.
  await expect(page.getByText(/write rights/)).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  // Additive by default, and visible on the target's own screen (Ruling P2).
  await expect(page.getByText('additive')).toBeVisible();

  await page.getByRole('link', { name: 'Account profile' }).click();
  await page.getByLabel('Fallback container').fill('OU=LoopTest,DC=syntra,DC=test');
  await page.getByRole('combobox').selectOption({ label: 'Anna Novak' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('anna.novak')).toBeVisible();
  await page.getByRole('button', { name: 'Save profile' }).click();

  await page.getByRole('link', { name: 'Business rules' }).click();
  await page.getByPlaceholder('Name').fill('Finance staff');
  await page.getByRole('button', { name: 'Preview impact' }).click();
  await expect(page.getByText(/matches\s+1\s+of/)).toBeVisible();
  await page.getByRole('button', { name: 'Save rule' }).click();

  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByRole('button', { name: 'Run now' }).click();
  await page.getByRole('link', { name: /\d/ }).first().click();

  // A first run is always blocked pending confirmation: every population has a
  // denominator of zero, so no threshold can say anything about it.
  await expect(page.getByText('This run is blocked')).toBeVisible();
  await expect(page.getByText(/never had a run applied/)).toBeVisible();

  // Apply part of it: untick the grant, apply the create.
  await page.getByRole('checkbox', { name: /grant_entitlement/ }).uncheck();
  await page
    .getByLabel('I have read the numbers above and want to apply this run anyway')
    .check();
  await page.getByRole('button', { name: /Apply 1 action/ }).click();
  await expect(page.getByText(/now partially_applied/)).toBeVisible();

  // Then the rest.
  await page.getByRole('checkbox', { name: /grant_entitlement/ }).check();
  await page.getByRole('button', { name: /Apply 1 action/ }).click();
  await expect(page.getByText(/now applied/)).toBeVisible();

  // And the question everybody asks.
  await page.goto('/admin/people');
  await page.getByRole('link', { name: 'Anna Novak' }).click();
  await page.getByRole('link', { name: 'Access' }).click();
  await expect(page.getByText('Why does this person hold this?')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Finance staff' })).toBeVisible();
});
```

This spec needs a person named Anna Novak with a Finance contract, and the seeded database is what supplies it. If the seed does not carry one, add her there rather than creating her through the console inside this test: a spec that spends thirty lines building its own fixture stops being a test of the provisioning path.

- [ ] **Step 10: Document the operational constraint in the README**

In `README.md`, under the development-environment section, add:

```markdown
### Provisioning integration tests need a privileged Docker host

The Active Directory target connector is tested against a real Samba domain
controller (`nowsci/samba-domain:20260801025201`, pinned). That container
**must** run with `--privileged`: Samba's provisioning sets NT ACLs on the
sysvol filesystem and exits 255 without it. This is true for a self-hosted
runner and for GitHub Actions' standard Linux runners; it is **not** guaranteed
on more locked-down or sandboxed CI.

```bash
pnpm samba:up && pnpm samba:wait   # 12–20s to first LDAPS bind
pnpm vitest run packages/connectors/src/ad packages/core/src/provision
```

Everything Provision does over LDAP is encrypted. This container refuses even
a plain simple bind (`StrongAuthRequiredError: BindSimple: Transport encryption
required`), which is stricter than the OpenLDAP container, so any fixture
shared between the two must default to LDAPS or StartTLS. The certificate is
self-signed, so tests set `rejectUnauthorized: false` deliberately.
```

- [ ] **Step 11: Run the whole suite**

```bash
pnpm db:up && pnpm samba:up && pnpm samba:wait
pnpm typecheck
pnpm vitest run
pnpm e2e
```

Expected: all green. `pnpm typecheck` is a separate command on purpose: Vitest does not type-check, so a green test run says nothing about types.

- [ ] **Step 12: Verify the never-deletes property across the whole slice**

```bash
grep -rniE "\.del\(|deleteMany|\.delete\(" \
  packages/connectors/src/ad/connector.ts \
  packages/connectors/src/ad/config.ts \
  packages/connectors/src/ad/uac.ts
```

Expected: **no matches at all.** The Active Directory connector has no delete operation to call — absent, not disabled and not configuration-gated, so that no configuration mistake can produce one.

The three files are named individually rather than grepping the directory, because the directory legitimately contains two things that do delete: `samba-connection.ts`'s `purgeSubtree`, which is the fixture helper every integration test in this slice uses to start from a known-empty subtree, and the tests themselves. A grep that matched those would have to be weakened until it matched nothing, which is how a check like this stops being a check.

Also confirm the union itself still has no destructive member — the structural test in Task 2 asserts this, and this is the human-readable version of the same question:

```bash
grep -nE "op: '" packages/connectors/src/types.ts | grep -iE "delete|destroy|purge|erase|wipe|drop"
```

Expected: no matches.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add the provisioning console and the end-to-end path"
```

---

## Plan self-review

### 1. Spec coverage

Every section of `docs/superpowers/specs/2026-08-16-syntra-provision-design.md` maps to a task.

| Spec section | Task |
|---|---|
| §1 Purpose, success criteria 1–12 | 1–18; criteria 6, 7 and 11 are proven live in 11 and 18 |
| §2 Position in the programme | narrative; the seam is enforced by Task 1 changing no existing table |
| §3 Decisions | carried into Global Constraints and each task's rationale |
| §4 What Provision writes and does not | 15 (claiming, status propagation inward, paired enqueue), 9 (the two Syntra actions), 14 (they call no connector) |
| §5 Target systems, `TargetConnector`, `WriteOperation`, `WriteResult`, the anchor | 2, 11 |
| §6 The Active Directory target — transport, three-write create, names, placement, entitlements, range retrieval, deprovisioning treatment | 3 (range), 4 (container), 6 (names), 11 (everything else) |
| §7 Business rules, condition language, union across contracts, profile not rules, `desiredState` | 5, 6, 7 |
| §8 Joiner, mover, leaver, rehire, contract ending, pre-hire horizon, retroactive change, no-active-contract trichotomy | 7, 9 |
| §9 Never deletes; the ladder; account vanished | 1 (CHECK), 2 (structural test), 9 (arithmetic), 11 (no delete op), 12 (validation), 18 (grep) |
| §10 Evaluate then enforce; staleness; supersede; skip | 13 (supersede), 16 (skip), 1 (the non-terminal partial unique index) |
| §11 The guard — per type, per entitlement, the two refusals, first run, after the guard | 10, 13, 17 |
| §12 Reconciliation, four outcomes, enforcement modes, remit, the Govern seam | 8, 12 (`remitFor`), 13, 17 (drift API), 18 (drift tab) |
| §13 Persons Provision cannot process; conflicts | 7, 8, 13, 14 (conflict on apply), 17, 18 |
| §14 Failure, retry, idempotence, provenance marker, transaction shape, in-flight, ordering, partial application | 2 (fake), 9 (`ACTION_ORDER`), 11 (provenance), 14 (all of it) |
| §15 Data model, every table and index | 1 |
| §16 Pipeline and phasing | 13, 14 |
| §17 Administration surface — all eight bullets | 17 (API), 18 (screens) |
| §18 Security posture — vault, borrowing rule, initial password, encrypted transport, audit pairing, confirmation recorded, least privilege, RLS, closed interpreter | 1 (RLS), 5 (closed interpreter), 11 (password never surfaced), 12 (vault + borrowing rule), 14 (audit pairing, confirming user), 17 (permissions) |
| §19 Alternatives rejected | none needs a task; each rejection is quoted at the decision it constrains |
| §20 Testing — every listed case | 5, 6, 7 (unit matrices), 8, 9, 10 (pure stages), 2 (failure injection + never-deletes structural), 4, 11, 18 (integration against Samba), 14 (crash recovery), 13 + 18 (guard scenarios), 18 (loop with Directory Sync, e2e) |
| §21 Out of scope | respected; **one exception, deliberate** — see below |

**The one divergence from §21, and the spec is what gets corrected.** §21 listed "Active Directory range retrieval" under **Not in this slice at all**, and Task 3 implements it. Ruling P1 says the opposite — range retrieval "is a task in the plan and not a follow-up" and must land before anything writes to a real AD — and the ruling post-dates the spec. Ruling P5 resolved which wins and required the spec to be amended rather than left to contradict the plan, so **Task 3 step 10 amends §21** and step 11 closes the known-gaps entry. Both halves are now steps rather than notes; the first pass landed the ordering and left the amendment unwritten, which would have left a future reader with a spec saying the feature is out of scope, code saying it is in, and no record of which won.

Nothing else in §21 is built: no Entra ID, no SCIM, no password sync, no mailbox operations beyond the archive move, no delegated per-action approval, no historical rule simulation, and `userAccountControl` is still not read into Syntra's user `status` — the residual gap §4 names is left named, not closed.

**Two things are deliberately deferred inside the slice, and recorded rather than half-built.** `TargetSystem.concurrency` is stored, validated and rendered, and the apply loop is strictly sequential — a bounded pool has to interact correctly with the per-person ordering, the throttle budget and the fact that actions for different people are unordered relative to each other, and none of that is worth guessing at. And phase 5 loads the whole tenant inside one interactive transaction under Prisma's 5000 ms default, which will not hold at the 40,000-holding scale the guard's own docstrings assume; the constraint and the two ways out of it are written at the phase rather than discovered by whoever first runs it against a large tenant.

Two further items are covered but worth naming because they are easy to lose: **crash recovery** (§20) is Task 14's `resolveInFlightActions` plus its two tests, not a separate task; and **`origin` on `AccountEntitlement`** (§15) is written in Task 14's step 3 rather than inferred later, which is what makes §12's drift classification possible at all.

### 2. Placeholder scan

No "TBD", no "implement later", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries the code; every test step carries the test.

Four drafting artefacts were caught and corrected **inside the code blocks**, not in prose after them. That distinction is the correction: an agent that copies a code block and does not act on a paragraph underneath it ships the draft, and in two of these four cases the draft was a test that passed whether or not its subject worked.

- Task 8's "excludes a person whose account is in conflict" was drafted against a `statusless` property that does not exist, asserting `?.kind` was `undefined` — which is true whether or not conflicted accounts are excluded from the plan, and that exclusion is a security control (spec section 13: a conflict is an account somebody else may own). The finished test is now the one in the code block, and the prose patch is gone.
- Task 10's per-entitlement guard message was drafted with a `.replace` chain patching its own template string. The block now carries the direct `tripped.push(...)`.
- Task 11's `generateInitialPassword` used `require('node:crypto')` in an ESM module. There is no such function in that module now at all: the connector generates no password, because one it generated could never leave it (Ruling P12).
- Task 3's `nextRangeSpec` and `RANGE_STEP_FOR` were exported, never called, and disagreed with the walk that matters by one on the upper bound — so their own tests could not pass. Both are deleted.

Task 16's step 4 previously said "make the equivalent change in `updateTarget` and in `deleteTarget`". It now writes all three signatures and all three insertion points out in full. That was the last "describes without showing" in the plan, and Task 17 already calls all three with the extra argument.

### 3. Type consistency across tasks

Re-checked every name that crosses a task boundary.

- **`ProvisionActionType`** is defined once (Task 2, `packages/connectors/src/types.ts`) and is the element type of `CONNECTOR_ACTION_TYPES`, `SYNTRA_ONLY_ACTION_TYPES` (2), `ACTION_ORDER` (9), `PlannedAction.actionType` (9), `POPULATIONS[].actionType` (10), the guard at the top of `adTargetConnector.write` (11) and the `actionType` column (1). Ten members, spelled identically in all seven places; the structural test in Task 2 fails if they diverge.
- **`WriteOperation`** members (2) are exactly the eight `CONNECTOR_ACTION_TYPES`, asserted by Task 2's fourth test, produced by `toWriteOperation` (14) and consumed by `adTargetConnector.write` (11) and `FakeTarget.write` (2). `create_account` carries `correlationKey`, `initialPassword` and no anchor; `archive_account` carries `entitlementDns`; every other member carries an anchor and nothing else new.
- **`WriteResult.failure`** is `WriteFailure` (2), classified by `classifyLdapError` (11), routed by `isRetryable` (2) in `applyProvisionRun` (14), and the six members are spelled the same in the fake (2), the AD connector (11) and the retry loop (14).
- **`TargetConnector`** has five members: the four `Connector` ones plus `listEntitlements`, `listContainers` and `readEntitlementMembers`. All three additions are implemented by both `FakeTarget` (2) and `adTargetConnector` (11) and all three are called by `previewProvisionRun` phase 4 (13). A member nothing calls, or a caller with no fake behind it, is what let the container check and the `unreadable` status both go untested.
- **`DiscoveredEntitlement`** (2) carries `externalId` **and** `dn`. `externalId` is the identity and is what `Entitlement.externalId` stores; `dn` is what a user's `memberOf` contains, is persisted by `refreshEntitlements` (12) into `Entitlement.dn`, and is the key of the map phase 4 builds (13). Keying that map on `externalId` is the defect Ruling P8 records.
- **`DesiredState`** (7, `types.ts`) is produced by `desiredState` (7) and consumed by `reconcile` (8) and `planActions` (9). Three fields decide who is touched: `account` (`DesiredAccount | null`), `unprocessable`, and `notYetStarted`. `reconcile` skips an unprocessable person before touching anything and reports a not-yet-started one as drift; `planActions` returns early for both. `EMPTY_ACCOUNT` is a factory, not a shared object, so no consumer can corrupt the next call by mutating `attributes`.
- **`ActualState`** (8) is produced only by `reconcile` and consumed only by `planActions`. `heldWithinRemit` — not `heldEntitlements` — is what `planActions` differences against, which is what keeps an out-of-remit group unrevokable in both modes. Both fields exist and mean different things; the naming is deliberate and the reconcile tests pin the distinction.
- **`PersonFacts`** (7) names the columns `Person` has: `givenName`, `familyName`, `nameConvention`, `businessEmail`, `personalEmail`, `status`. There is no `email` and no `displayName` on the model, spec section 15 forbids adding one, and `personDisplayName` (7) is the single derivation — used by `desiredState` (7), `previewAccountProfile` and `previewRuleImpact` (17). Every account-profile example in every task says `%person.businessEmail%`.
- **`LadderSettings`** (9, `types.ts`) is filled from `TargetSystem` columns in `previewProvisionRun` (13) and validated by `assertLadder` in `updateTarget` (12); the five field names match the five columns in Task 1.
- **`GuardThresholds`** (10) field names are identical to the seven `TargetSystem` columns (1), the seven keys of `thresholdsSchema` (17), the seven entries of `THRESHOLD_FIELDS` in `updateTarget` (12) and the seven labels on the target editor (18). `updateTarget` picks from the named list rather than spreading the request body into Prisma's `data`.
- **`driftFingerprint(kind, accountId, entitlementId, subject?)`** (8) is the only producer of `DriftFinding.fingerprint`, used by `reconcile` (8), the upsert in `previewProvisionRun` (13) and `claimSyntraUsers` (15). The fourth part is what keeps an orphan's anchor out of the `@db.Uuid` `entitlementId` column and what keeps the Syntra-user link conflict from overwriting reconcile's account-status finding.
- **`ProvisionAction.sequence`** (1) is written from the sorted array index in phase 7 (13) and is the `orderBy` in the apply loop (14), the run-detail route (17) and both test helpers (13, 14). Nothing orders provisioning actions by `createdAt` anywhere in this plan, because `now()` in PostgreSQL is transaction start time.
- **`provisionScheduleKey`** (16) is the only producer of a pg-boss `key` on the `provision.run` queue, called from `applyTargetSchedule` and `removeTargetSchedule` (16) and from `createTarget`/`updateTarget`/`deleteTarget` (12, via step 4). `PROVISION_JOB` is the string `'provision.run'` in the jobs module and in the route that enqueues it (17).
- **`targetWithCredential(tx, provider, targetId)`** (12) takes a `tx` and is therefore always called *inside* a `withTenant` whose result is plain data — in `refreshEntitlements` phase 1 (12), `previewProvisionRun` phase 2 (13), `applyProvisionRun`'s prepare (14) and `resolveInFlightActions` (14). It never returns a `tx` handle, which is what stops one crossing a phase boundary.
- **`AccountProfileInput`** and **`BusinessRuleInput`** are exported from `target-service.ts` (12) and imported by `explain.ts` (17); the API's `accountProfileRequestSchema` and `businessRuleRequestSchema` (17) have field-for-field identical shapes. The one deliberate divergence is `conditionRequestSchema`, whose leaf is an open record because `@syntra/contracts` cannot import `@syntra/core` — so every route that touches a condition re-parses it with `conditionSchema` before evaluating or storing it.
- **The API surface** uses this repository's own conventions and not invented ones: plugins registered under a `/api/admin` prefix with relative paths, `requireSession('admin')` as a hook inside each plugin, `requirePermission` imported rather than decorated, `request.db`, `request.session.userId`, `ProblemError`, `buildTestApp`. Console routes are relative paths in `AdminApp.tsx`; `routes.tsx` is untouched.

### 4. What changed after the pre-flight review

The five Critical findings were all seams between tasks rather than mistakes inside one, which is why the plan's own pass did not catch them.

- **Nothing created a `TargetAccount`.** Phase 7 now reserves one for every person whose plan contains a create, before anything is written to the target, and every action for that person names it. Spec section 5's correlation-key reservation was the argument for the unique index, and the index was protecting a row that never existed.
- **The container check inferred its input.** `listContainers` reads them. The check does **not** skip itself on an empty set (Ruling P9): the plan's own self-review called that "the correct failure", and it is a deadlock wearing a safety argument — the container can never become visible, because no account can ever be created in it.
- **Membership never resolved.** Task 11 emitted DNs and Task 13 looked them up in a map keyed on objectGUID. No test caught it because `FakeTarget` emitted `memberOf` keyed the way the consumer wanted to read it. `FakeTarget` now speaks the connector's language, which is Ruling P8 and binds the two slices after this one.
- **A crashed run bricked the target.** The adoption handles all four non-terminal statuses, and the in-flight resolution sits inside it rather than behind the create that throws.
- **`Person` has no `email` and no `displayName`.** Six tasks read them.

The 16 High findings and most of the Medium ones are folded into the tasks above; the two structural ones worth naming here are that `ApplyOptions` now requires `confirm` **and** `confirmedByUserId` together, and that the initial password is generated by the caller, sealed into the vault and delivered — previously it was invented inside the connector, written to the directory and dropped, which made every account Provision created unusable by the person it was created for.

### 5. What changed after the scoped re-review

Two High findings survived the first fix wave. Both were about ordering and
surface rather than logic, and neither was visible from inside a single task.

- **Task 14 hard-imports `applySyntraUserAction` from the module Task 15
  creates**, so Task 14 cannot typecheck or run its tests if it is dispatched
  first. Task 15's Consumes block takes nothing from Task 14, so this is
  resolved by dispatch order and not by renumbering: **Task 15 runs first**, and
  both tasks now carry the note. Adding an optional `applySyntraUser?` seam to
  `ApplyOptions` would also have worked and was deliberately rejected — a seam
  that exists only to dodge task ordering is indirection a later reader has to
  decode, and this slice already carries two legitimate injection seams
  (`connector`, `transport`) that a third would dilute.
- **Task 18's end-to-end test drove a console Steps 1-7 never built**: no create
  form behind the "New target" link, no connection test, and no links from the
  target page into the account profile, business rules or runs. Step 2 is
  rewritten and Steps 2a and 2b added.

The rewrite fixed a second thing the re-review did not raise. The original
Step 2 was written in raw Tailwind on bare `<label>` and `<input>` elements
while every other admin page in this repository composes `Panel`, `Field`,
`Button`, `Alert`, `Status` and `PageHeader` from `@syntra/ui`. A page that
styles itself is a page that drifts, and the fix was to make Step 2 what
`SourceDetailPage` already is — the same shape, against the same helpers, with
one page serving both `targets/new` and `targets/:id`.

The connection test is the part that matters. Finding M20's whole fix was to
have `test()` report four effective rights with `unverified` as a third state
distinct from `granted`, and until now that shipped with no surface at all — a
bind account that can read the directory but cannot create users passes an
`ok: true` test and fails at the first run against a live directory. Step 2a
asserts exactly two rights render as granted and Step 2b requires the assertion
be mutation-checked, because the failure this guards against is precisely
`unverified` quietly rendering as approval.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-16-syntra-provision.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
