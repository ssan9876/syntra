# Pilot build evidence — 22 September 2026

This records what was built against the [enterprise build and test roadmap](enterprise-build-and-test-roadmap.md), how each piece was verified, and what still needs infrastructure nobody in this repository can provide. It is the companion to the [operations runbooks](runbooks/README.md) and the [Entra ID connector notes](connectors/entra-id.md).

The build it describes was committed as `b986ad8`; the follow-up section near the end came after.

## Verification ledger

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| Backend suite (`vitest run`, real PostgreSQL) | Final rerun: 275 files, 5124 tests, 5115 passed, 8 skipped, 1 failed; that one exposed a NULL hole in the transport check constraint, closed by migration `20261010000000_target_transport_not_null` (its file and the container-preview file now pass) |
| Connector package | 25 files, 459 tests passed, 8 skipped (Samba integration needs a container host) |
| Web suite (`apps/web`) | 94 files, 882 tests passed |
| Production web build | `pnpm build` passed; the admin chunk was 589 kB minified, and after the follow-up below each console page is its own chunk (console frame 14 kB, largest page 23 kB) |
| Live instance | API restarted on the new code; `/health/ready` reports 69 migrations applied and vault unsealed |
| Native Entra connector against the saved tenant, read-only | token issued, Graph reachable, one user on the first page, no write attempted |
| Responsive pass (Playwright, 320 / 768 / 1280 px) | no horizontal overflow on eight console pages after the header fix; every visible control reachable by Tab (42 of 42 on the policy page) |

## Workstream 1 — Entra ID connector

Built: a native `entraId` connector kind (`packages/connectors/src/entra`) beside the document-driven one, with a versioned capability matrix, an immutable correlation marker on create, managed-field-only updates, disable-not-delete, direct-membership read-back after every write, server-side group search with paging, dynamic and mail-enabled groups reported as not manageable, Graph error classification (401/403 not retried, 404 manual, 429 honoured, 5xx bounded), a token cache keyed by secret fingerprint plus an explicit flush on rotation, and a readiness record written on every credential rotation.

Verified: 43 connector tests against an in-process fake Graph covering the roadmap's whole test table (OAuth valid / invalid / rotated, page boundary, create twice, managed-field update, disable keeps the account, add then remove membership with read-back, delayed visibility never claims verified, every failure class, private-address guard). The console shows the matrix and says which entries still need tenant evidence.

Disposable-tenant evidence (23 September 2026): `entra:validate --write`
completed successfully against the approved disposable tenant. OAuth, paged
read, entitlement discovery/search, create, idempotent create retry,
read-back, managed-field update, disable and final disabled read-back all
passed; evidence is in
`test-results/entra-evidence-2026-09-23T00-07-35-716Z.json`. The run left
`syntra-validate-ccabbe78@ssanderxyz1234.onmicrosoft.com` disabled and did not
delete it. The tenant had no security groups, so grant/revoke membership remain
the only native Entra write capabilities awaiting disposable-tenant evidence.

**Observation-window follow-up (23 September 2026):** a successful target
write is now followed by up to five read-back observations, two seconds apart.
The receipt becomes `applied` only after an exact observed match; it remains
`verification_pending` with manual-verification wording after the window. The
adapter tests now cover a delayed marker that initially causes a duplicate-UPN
response and a delayed group-membership removal. The saved tenant credentials
are not present in this development shell, so the group evidence should be
rerun through `pnpm entra:validate --write` with the approved disposable-group
IDs before that capability is marked tenant-verified. A distinct
`retry-after-verification` endpoint now refuses to reissue an ambiguous target
write until a complete read-back proves the expected state is still absent.

## Workstream 2 — lifecycle pilot hardening

Built:

- Operation view: every step shows its planned action, attempts (append-only; a retry adds an attempt and keeps the original evidence), target response category, latest observed state, owner, due date, acknowledgement, and the overdue reason. Operators can record an observed state by hand and confirm a mismatch as manual verification.
- Approvals: a per-tenant policy gates account creation, privileged-group changes, urgent departures and bulk requeues behind a second person. The requester can never approve their own request. Local facts (the employee, the contract, a blocked sign-in) are saved regardless; only target writes wait. A large requeue becomes an operation of its own that an approver runs.
- Mover preview: field-level before/after for contract dates, department, role, manager, location, cost centre and employer, plus per-target account action and entitlement add / retain / remove derived from the rules with no connector opened. A target whose catalog is unconfirmed is marked unverified. Apply is revision-bound and recomputes the plan server-side.
- Service levels: deadlines are fixed at creation from the policy (urgent departure defaults to 15 minutes); breach is recorded from the clock by the hourly maintenance pass, escalated once to the configured owner, and shown on the operation and in the work queue.
- Notifications: seven lifecycle templates that actually render (the earlier rows named templates that did not exist and could never send), a delivery-record panel per operation, and opt-out flags in the policy. Mail transport is unchanged: the outbox is the record, SMTP is the delivery.
- Simulation: a stored, no-write rehearsal of joiner, mover and leaver for one person or a whole department, using the planner's own desired-state code.

Verified: 15 core tests (`packages/core/src/lifecycle/hardening.test.ts`) and 10 API tests (`apps/api/src/routes/admin/lifecycle-hardening.test.ts`) covering every bullet of the roadmap's Workstream 2 test list except the two that need a live target: replay of a request key, stale-revision refusal, forced write failure with an owned task and delivery record, overdue leaver escalation with the reason exposed, retry appending rather than overwriting, and department-wide simulations.

## Workstream 3 — operating model

Built:

- Runbooks under `docs/runbooks/` for backup and restore, master-key recovery, database migration, secret rotation, incident response, target rollback, and four tabletop exercises, each grounded in the scripts that exist. Each runbook ends with its limits: what it does not cover, or what cannot be undone.
- Telemetry: queue depth, oldest unresolved age, failed and retry-exhausted actions (the dead-letter equivalent), retry rate, readiness freshness, stale targets, approvals waiting, service-level breaches, deferred (saturated) operations, and duration quantiles by operation kind and by connector type. Alert rules for each, pointing at the runbooks.
- Retention: a nightly pass removes resolved receipts, resolved lifecycle operations (releasing their idempotency keys only after the explicit tenant policy window), observations on resolved work, delivered notification records, expired simulations and superseded readiness checks per the tenant policy, and writes one audit event with every count. Audit events are immutable at the database (a rule turns DELETE into a no-op), so the pass only counts what is past policy; the chain verifier now accepts a log pruned up to a verified checkpoint so the documented owner procedure does not break it.
- Roles: five presets (platform operator, lifecycle owner, target administrator, auditor, read-only reviewer) an administrator creates on purpose.
- Concurrency: a per-tenant cap on target operations in flight; the worker defers the rest with a visible "at capacity" state, a delayed requeue, a metric and an alert. Per-target concurrency already existed.

**Non-empty restore and scale rehearsal (23 September 2026):** an isolated
`syntra_staging` copy was populated with 10,000 synthetic people and 10,000
lifecycle operations, dumped in custom PostgreSQL format, and restored into a
separate `syntra_restore_verify` database. The source and restore both had
`10000 / 10000 / 70` persons / lifecycle operations / applied migrations.
After `ANALYZE`, the people page used its `(tenantId, familyName, givenName)`
index in 0.049 ms. The open-operation page initially scanned and sorted 9,000
rows in 1.733 ms; migration `20261011000000_lifecycle_open_queue_index` made
the same page an index-only scan in 0.042 ms. These are local development
measurements, not a production latency guarantee.

**Master-key rotation drill (23 September 2026):** the vault test now stores
two secrets under one provider, re-wraps both data keys under a distinct next
provider, proves the former provider cannot unseal them and proves the next
provider can. The code has no deployment-facing rotation command yet: the
environment-specific maintenance wrapper must provide both keys, invoke the
transaction, verify readiness and only then switch `MASTER_KEY`.

**Local restore rehearsal (22 September 2026):** a logical dump of the
durable Compose `syntra` database was restored into an isolated temporary
`syntra_rehearsal` database on the same Postgres host, then reconciled before
teardown. Persons, contracts, users, targets, lifecycle operations and vault
rows all matched (zero on this clean development database); all 70 applied
migrations matched as well. This proves the Compose dump/restore path, not a
second-host recovery or a non-empty production-scale restore.

## Workstream 4 — scale, accessibility, usability

Built: a server-paged, filterable, sortable operations list; bulk actions that return one result per item and never hide a refusal; a debounced, server-backed entitlement search in the rule editor that keeps selected values visible and marks dynamic or unsupported groups; a shell header that wraps at phone widths instead of pushing the page sideways (the cause of the 232 px overflow on every page at 320 px).

Verified: the Playwright pass above, with screenshots in `test-results/ui-audit/`.

Not done: a manual screen-reader session and translated-UI checks. The employee work queue uses one database-backed union query with server-side paging rather than assembling sources in memory. The 10,000-person seed and query-plan review are recorded in Workstream 3 above.

## Defects found and fixed along the way

- Lifecycle alert outbox rows named templates that did not exist, so no lifecycle mail could ever send.
- The db package's own `.env` points at port 5432 while the running instance uses 5433; migrations applied from that directory land on the wrong database. Apply with `DATABASE_URL` set explicitly from the root `.env`.
- The container-preview test fixture created a target of type `ad`, which the transport check constraint (added in an earlier uncommitted migration) refuses.
- Under Tailwind 4 a `hidden sm:inline-flex` language picker still rendered at phone widths because the component hard-coded `inline-flex` too.

## Follow-up the same day

- **Runs that were never queued.** A manual directory-sync or HR-import run commits its `queued` row before asking pg-boss for the job. When that enqueue threw, or pg-boss declined the job, the row stayed `queued` for ever with nothing to reap it (item 4 of the [20 September audit](audit-2026-09-20.md)). The refusal is now written onto the run as `failed` with the reason, and the console gets a 503 that says so. Four tests fail without the fix and pass with it.
- **Route-level splitting.** Every console page loads on first visit. The applications page had been pulling the whole contracts package, every zod schema in it, for one URL check; that check now lives in a file with no imports.
- **A stale fixture.** The lifecycle hardening tests created an AD target with no TLS mode, which the NULL-hole migration above now refuses. Full backend suite after all three: 274 files passed, 1 skipped; 5120 tests passed, 8 skipped. Web: 94 files, 882 tests passed.

## Go / no-go checklist, as of today

- [x] Entra connection recorded in a readiness check (read-only, on the saved tenant)
- [ ] Entra capability matrix backed by disposable-tenant evidence for writes
- [ ] Joiner, mover and leaver simulations reviewed by HR, IT and security (the tool exists; the review is a meeting)
- [ ] Canary population and rollback owner named
- [x] Lifecycle work has owners, due dates, escalation policy and monitored delivery records
- [x] Runbooks complete; backup, restore rehearsal and key rotation drills still to be performed
- [ ] Audit retention and privacy policy approved (the controls exist; the approval is yours)
- [x] Accessibility exit criteria met for keyboard and 320 px; load-test criteria not yet exercised
- [ ] Production enablement recorded as a change approval
