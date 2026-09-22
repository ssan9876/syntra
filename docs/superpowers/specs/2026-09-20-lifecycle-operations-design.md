# Lifecycle Operations and Verification Design

**Status:** Approved in chat on 2026-09-20.

## Purpose

Make Syntra usable as an employee lifecycle product: an operator can start, change, or end employment from one employee record and can tell whether every managed system has reached the expected state. Queue acceptance, a saved local record, and a successful write are intermediate states rather than proof of completion.

## Architecture

Syntra will represent each hire, mover, leaver, verification, and simulation as a tenant-scoped lifecycle operation. An operation contains ordered steps and target-specific results. The operation owns its idempotency key, input snapshot, actor, status, retry history, ownership, due date, and evidence. Existing `ProvisionRun`, `ProvisionAction`, and `PersonProvisionReceipt` records remain the execution evidence for target provisioning; lifecycle steps link to them instead of duplicating their action data.

The existing person page is the employee control plane. It shows the latest operation timeline, expected versus observed target state, unresolved manual work, and safe retry actions. The Employee work page remains the cross-person operations queue. Technical target run pages remain available for investigation.

## Durable onboarding

`POST /api/admin/lifecycle-operations/onboard` accepts an idempotency key and a complete person, contract, optional login, and target request. The server creates or resumes one operation, then executes local steps transactionally where possible. Retrying never creates a second person, contract, or login. A partial result remains resumable from its first incomplete step.

Statuses are `queued`, `running`, `waiting`, `completed`, `failed`, and `cancelled`. Step statuses are `pending`, `running`, `succeeded`, `failed`, `manual`, and `skipped`. Completion requires all required steps to be `succeeded` or explicitly resolved manual work.

## Observed state

Each connector publishes capabilities for account create, update, disable, entitlement reconciliation, and read-back. Verification compares a normalized expected state with a normalized observation. It stores when the observation occurred, the connector response fingerprint, differences, and whether the connector could make a complete observation.

Provisioning remains `waiting` after a write until read-back matches. A connector without read-back produces a manual verification step. Verification retries do not repeat successful writes.

## Mover workflow

A mover operation begins from proposed contract and person changes. Its preview records the current revision and shows field changes, account changes, entitlement additions, entitlement removals, unchanged access, and any destructive action. Apply rejects a stale preview. The operation updates the employee record, queues affected target work, verifies observed state, and leaves failures in the work queue.

## Readiness evidence

Connection tests create immutable readiness checks with tenant, system, configuration fingerprint, tested capabilities, result, latency, actor, and timestamp. Changing relevant connection configuration makes previous checks stale. Setup readiness requires a current successful check plus saved mappings, profile, rules, reviewed preview, and schedule state; a connection check alone never enables writes.

## Ownership and notifications

Operations may have an owner, due date, priority, and acknowledgement timestamp. Syntra creates notification outbox records for assignment, failed required steps, overdue work, and completed operations when requested. In-app delivery is required; existing email delivery can consume the same outbox without coupling lifecycle execution to SMTP availability.

## Connector expansion

The connector interface exposes capabilities and normalized observation. LDAP/Active Directory implements the contract first and is exercised against disposable Samba when available. Entra ID and Microsoft 365 are represented as connector descriptors and capability contracts only until authenticated integration and destructive-write tests exist. The UI must label unavailable capabilities accurately.

## Operations, simulation, and retention

Every operation has a chronological event timeline. Retrying creates another attempt while preserving earlier evidence. Metrics expose running, waiting, failed, overdue, and oldest-unresolved counts. A retention job deletes expired low-level observation payloads while preserving outcome metadata and audit events.

Simulation uses the same planning and comparison code with writes disabled. Built-in hire, mover, and leaver scenarios report expected steps, target effects, safety blockers, unsupported capabilities, and verification coverage. Simulation can never call a connector mutation method.

## Scale and accessibility

Employee and entitlement searches are server-backed, paginated, debounced, and retain selected values outside the current result page. Work queue filters execute on the server and counts use identical predicates. Operation status changes use accessible live regions; tables retain semantic headers; dialogs manage focus; every action is keyboard reachable; long identifiers and timelines remain usable on narrow screens.

## Safety and permissions

All records and queries are tenant-scoped. Read operations require existing provisioning read permissions; create, apply, retry, assignment, and resolution require provisioning management. Stale revisions return conflict responses. Simulation is read-only. Existing thresholds and authorization gates remain in force.

## Acceptance criteria

- Repeating an onboarding request with the same idempotency key returns the same operation and employee.
- A local failure or target failure can be retried without recreating completed resources.
- A successful mutation is not shown as complete until read-back matches or manual verification is resolved.
- A mover preview becomes unusable after the employee or configuration changes.
- Connection evidence becomes stale when its configuration fingerprint changes.
- Failed and overdue work appears once in both queue counts and rows and can be assigned and acknowledged.
- Simulation produces lifecycle results without invoking connector writes.
- Server-backed search handles more than 200 people and entitlements.
- The focused backend and frontend suites, typecheck, lint, migration validation, and production build pass.

## Delivery sequence

1. Lifecycle operation persistence and onboarding orchestration.
2. Connector capabilities and observed-state verification.
3. Mover preview and apply.
4. Readiness checks.
5. Ownership, notifications, queue filters, and metrics.
6. Simulation and connector validation fixtures.
7. Search, accessibility, responsive behavior, and final verification.
