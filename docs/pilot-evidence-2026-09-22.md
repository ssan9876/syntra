# Pilot build evidence — 22 September 2026

This records what was built against the [enterprise build and test roadmap](enterprise-build-and-test-roadmap.md), how each piece was verified, and what still needs infrastructure nobody in this repository can provide. It is the companion to the [operations runbooks](runbooks/README.md) and the [Entra ID connector notes](connectors/entra-id.md).

Everything below is uncommitted in the working tree, alongside the earlier lifecycle work it builds on.

## Verification ledger

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| Backend suite (`vitest run`, real PostgreSQL) | Final rerun: 275 files, 5124 tests, 5115 passed, 8 skipped, 1 failed; that one exposed a NULL hole in the transport check constraint, closed by migration `20261010000000_target_transport_not_null` (its file and the container-preview file now pass) |
| Connector package | 25 files, 459 tests passed, 8 skipped (Samba integration needs a container host) |
| Web suite (`apps/web`) | 94 files, 882 tests passed |
| Production web build | `pnpm build` passed; the admin chunk is 589 kB minified (route-level splitting remains a follow-up) |
| Live instance | API restarted on the new code; `/health/ready` reports 69 migrations applied and vault unsealed |
| Native Entra connector against the saved tenant, read-only | token issued, Graph reachable, one user on the first page, no write attempted |
| Responsive pass (Playwright, 320 / 768 / 1280 px) | no horizontal overflow on eight console pages after the header fix; every visible control reachable by Tab (42 of 42 on the policy page) |

## Workstream 1 — Entra ID connector

Built: a native `entraId` connector kind (`packages/connectors/src/entra`) beside the document-driven one, with a versioned capability matrix, an immutable correlation marker on create, managed-field-only updates, disable-not-delete, direct-membership read-back after every write, server-side group search with paging, dynamic and mail-enabled groups reported as not manageable, Graph error classification (401/403 not retried, 404 manual, 429 honoured, 5xx bounded), a token cache keyed by secret fingerprint plus an explicit flush on rotation, and a readiness record written on every credential rotation.

Verified: 43 connector tests against an in-process fake Graph covering the roadmap's whole test table (OAuth valid / invalid / rotated, page boundary, create twice, managed-field update, disable keeps the account, add then remove membership with read-back, delayed visibility never claims verified, every failure class, private-address guard). The console shows the matrix and says which entries still need tenant evidence.

Not done, and cannot be done here: the disposable-tenant write evidence. `pnpm entra:validate --write` with `ENTRA_DISPOSABLE_TENANT=yes` performs the create / update / group / disable sequence and writes evidence rows to `test-results/`. Until somebody runs it against a throwaway tenant, every write capability stays labelled "automated + tenant evidence required" in the console, exactly as the roadmap requires. The saved tenant in this instance is a document-driven target; the native connector can borrow its secret for a read-only connection test (done, above) but was deliberately not pointed at it for writes.

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

- Runbooks under `docs/runbooks/` for backup and restore, master-key recovery, database migration, secret rotation, incident response, target rollback, and four tabletop exercises, each grounded in the scripts that exist. The gap list the runbook author found is at the end of that index.
- Telemetry: queue depth, oldest unresolved age, failed and retry-exhausted actions (the dead-letter equivalent), retry rate, readiness freshness, stale targets, approvals waiting, service-level breaches, deferred (saturated) operations, and duration quantiles by operation kind and by connector type. Alert rules for each, pointing at the runbooks.
- Retention: a nightly pass removes resolved receipts, observations on resolved work, delivered notification records, expired simulations and superseded readiness checks per the tenant policy, and writes one audit event with every count. Audit events are immutable at the database (a rule turns DELETE into a no-op), so the pass only counts what is past policy; the chain verifier now accepts a log pruned up to a verified checkpoint so the documented owner procedure does not break it.
- Roles: five presets (platform operator, lifecycle owner, target administrator, auditor, read-only reviewer) an administrator creates on purpose.
- Concurrency: a per-tenant cap on target operations in flight; the worker defers the rest with a visible "at capacity" state, a delayed requeue, a metric and an alert. Per-target concurrency already existed.

Not done: restoring a backup into an isolated environment, rotating the master key in a staging copy, and the 10x load test. The runbooks describe each procedure; running them needs a second host.

## Workstream 4 — scale, accessibility, usability

Built: a server-paged, filterable, sortable operations list; bulk actions that return one result per item and never hide a refusal; a debounced, server-backed entitlement search in the rule editor that keeps selected values visible and marks dynamic or unsupported groups; a shell header that wraps at phone widths instead of pushing the page sideways (the cause of the 232 px overflow on every page at 320 px).

Verified: the Playwright pass above, with screenshots in `test-results/ui-audit/`.

Not done: the 10,000-person seed and query-plan review, a manual screen-reader session, and translated-UI checks. The employee work queue still assembles its three sources in memory; the new operations list is paged in the database and is the surface to grow.

## Defects found and fixed along the way

- Lifecycle alert outbox rows named templates that did not exist, so no lifecycle mail could ever send.
- The db package's own `.env` points at port 5432 while the running instance uses 5433; migrations applied from that directory land on the wrong database. Apply with `DATABASE_URL` set explicitly from the root `.env`.
- The container-preview test fixture created a target of type `ad`, which the transport check constraint (added in an earlier uncommitted migration) refuses.
- Under Tailwind 4 a `hidden sm:inline-flex` language picker still rendered at phone widths because the component hard-coded `inline-flex` too.

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
