# Lifecycle Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build durable hire, mover, leaver, verification, readiness, ownership, notification, simulation, and scalable operator workflows on the existing provisioning engine.

**Architecture:** Persist one tenant-scoped lifecycle operation with ordered steps and attempts, linking target steps to existing provisioning receipts and runs. Add normalized connector capability and observation contracts, then expose the resulting state through employee and work-queue APIs and UI.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, React, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-20-lifecycle-operations-design.md`

## Global Constraints

- Preserve all existing uncommitted audit and lifecycle changes.
- Work in the current checkout because those approved changes do not exist in a separate branch.
- Never infer completion from queue acceptance or a successful connector mutation.
- Keep every database query tenant-scoped and every mutation permission-checked.
- Do not claim Entra ID or Microsoft 365 support without authenticated integration tests.
- Use tests first for every behavioral change.

---

### Task 1: Lifecycle operation persistence

**Files:** Prisma schema and migration; `packages/core/src/lifecycle/operation-service.ts`; matching test.

**Interfaces:** Produce `createLifecycleOperation`, `getLifecycleOperation`, `transitionLifecycleStep`, and `retryLifecycleOperation` with tenant and idempotency enforcement.

- [x] Persist idempotent tenant-scoped operations, steps, attempts, observations, readiness, and assignments with migrations and integration coverage.
- [x] Implement operation creation, transition, retrieval, retry, ownership, maintenance, and exports.
- [x] Run focused lifecycle tests and TypeScript build.

### Task 2: Durable onboarding API and UI

**Files:** lifecycle admin route/test; onboarding orchestrator/test; `OnboardPersonPage.tsx` and test; operation timeline component/test.

**Interfaces:** Produce `POST /lifecycle-operations/onboard`, `GET /lifecycle-operations/:id`, and operation timeline UI.

- [x] Implement idempotent onboarding orchestration and target receipts; focused backend/frontend tests pass.
- [ ] Complete worker-driven resumption of incomplete local onboarding steps (not just target receipts).

### Durable offboarding branch

- [x] Persist a tenant-scoped offboarding operation with independent local-access and target-revocation steps.
- [x] Link target receipts to the offboarding operation and expose its timeline from the employee record.
- [x] Verify local directory-write failure does not prevent target revocation from being queued.

### Task 3: Connector capabilities and observed-state verification

**Files:** `packages/connectors` capability/observation modules and tests; core verification service/test; receipt and employee UI.

**Interfaces:** Produce `ConnectorCapabilities`, `TargetObservation`, `compareObservedState`, and `verifyLifecycleTargetStep`.

- [x] Add capability/read-back contracts, LDAP/fake coverage, persisted observations, and receipt read-back verification.
- [x] Add an operator UI for recording/manual-confirming expected versus observed state and viewing differences/timestamps (2026-09-22: observation form and attempt history on the operation page).

### Task 4: Mover preview and apply

**Files:** mover service/test, lifecycle route/test, employee mover component/test.

**Interfaces:** Produce revision-bound `previewMoverOperation` and `applyMoverOperation`.

- [x] Implement revision-bound contract-change preview/apply and durable target reconciliation.
- [x] Derive and display rule-level entitlement add/retain/remove previews before applying a mover (2026-09-22: `provision/desired-state-loader.ts`, no connector opened).

**Implementation boundary for the remaining mover work:** Extract a read-only
`desiredStateForPerson` fact loader from `provision/run-service.ts`. It must
load the same target profile, rule facts, grant windows, entitlement catalog
status, account placement, and org-unit container facts as a run, but must not
open a connector, create a `ProvisionRun`, reserve a correlation key, or write
an action. Feed it an in-memory replacement for the selected contract, then
compare its desired entitlement IDs with held `TargetAccountEntitlement` rows.
The preview must label unavailable catalog/read-back evidence as unverified,
not as an access removal.

### Task 5: Persisted readiness

**Files:** readiness service/test, target/source routes/tests, setup page/test.

**Interfaces:** Produce immutable readiness checks keyed by configuration fingerprint and capability scope.

- [x] Persist fingerprint-bound source/target readiness records and render setup evidence.

### Task 6: Ownership, notifications, work queue, and metrics

**Files:** lifecycle assignment service/test, routes/tests, `EmployeeWorkPage` and test, metrics test/route.

**Interfaces:** Produce assignment, acknowledgement, priority, due-date, server-side filters, and lifecycle metrics.

- [x] Implement ownership, acknowledgement, outbox notifications, server paging/search, bulk queue actions, live updates, and bounded metrics.

### Task 7: Pilot simulation and connector validation

**Files:** simulation service/test, route/test, simulation page/test, Samba integration test documentation.

**Interfaces:** Produce read-only hire/mover/leaver scenario results with unsupported capability and safety blocker reporting.

- [x] Implement read-only hire/mover/leaver simulation and validate the directory connector against disposable Samba infrastructure.
- [x] Implement the native Entra ID adapter (2026-09-22: `packages/connectors/src/entra`; authenticated read-only against the saved tenant; write capabilities stay labelled until `pnpm entra:validate --write` runs on a disposable tenant). Microsoft 365 remains unavailable.

### Task 8: Scale, accessibility, retention, and release verification

**Files:** person/entitlement list routes/tests, selectors/components/tests, cleanup job/test, docs.

**Interfaces:** Produce cursor pagination and query parameters, retained selections, cleanup policy, and release evidence.

- [x] Implement server search/pagination, bulk selection, keyboard-accessible controls, live status updates, and retention cleanup.
- [x] Run a browser-based focus/responsive pass and document exact evidence (2026-09-22: Playwright pass at 320/768/1280 px, `docs/pilot-evidence-2026-09-22.md`; a manual screen-reader session is still outstanding).
- [x] Run final complete-suite, migration-from-empty-database (the test databases are migrated from empty on every run), and production-build evidence (2026-09-22, `docs/pilot-evidence-2026-09-22.md`). Deployment evidence on a second host is still outstanding.

### Task 9: Production deployment and operation

- [x] Add Prometheus lifecycle metrics and alert rules.
- [x] Add a Helm chart with hardened API pods and controlled pre-install/pre-upgrade migration Jobs; lint and render it in Docker.
- [ ] Add environment-specific ingress/gateway and network-policy examples after the deployment's ingress class, certificate issuer, database and SMTP network locations are chosen.

## Current verification ledger

- 2026-09-21: `vitest run packages/core/src/lifecycle packages/core/src/provision/person-receipts.test.ts apps/api/src/routes/admin/lifecycle-operations.test.ts apps/api/src/routes/admin/employee-lifecycle.test.ts apps/api/src/routes/admin/person-receipts.test.ts` — 8 files, 32 tests passed against the disposable PostgreSQL database.
- 2026-09-21: TypeScript project build passed after lifecycle observation and offboarding-operation changes.
- 2026-09-21: Helm chart rendered and passed `helm lint` through `alpine/helm:3.16.2` in Docker.
