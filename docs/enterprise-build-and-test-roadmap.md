# Syntra enterprise build and test roadmap

## Status

As of 22 September 2026 the four workstreams are built and verified to the extent this repository allows; see [the pilot evidence record](pilot-evidence-2026-09-22.md) for what passed, what was measured, and the items that need a disposable Entra tenant or a second host.

## Purpose

This is the practical path from the current working local deployment to an
enterprise-ready pilot. It deliberately separates **working now**, **safe to
pilot after validation**, and **not yet a supported promise**. The priority is
to prove safe lifecycle behaviour before adding more connectors or automation.

## Current baseline

Syntra currently has the foundations needed for a controlled pilot:

- Durable lifecycle operations with idempotency, receipts, retry and operation
  timelines.
- Joiner, mover and leaver workflows, including mover previews and a no-write
  lifecycle simulation.
- Readiness records for saved targets, configuration fingerprints, ownership,
  due dates, acknowledgement and queue actions.
- A connected Microsoft Entra ID target. Its OAuth client-credential flow and
  Microsoft Graph account read both succeed. The connection test currently
  sees two Graph users.
- Target adapters have an observed-state concept; unavailable read-back is
  surfaced as manual verification rather than treated as success.
- Work queues expose retry and acknowledgement actions, plus live-status
  announcements and keyboard-selectable bulk queue actions.

The Entra target is presently a document-driven REST connector. It is valid
for authenticated discovery and connection testing, but it must not be
described as a completed Entra provisioning connector until each write and
read-back operation below has passed against a disposable tenant.

## Delivery principles

1. **No silent success.** A write is only completed when the target confirms
   the intended account or entitlement state. If the target cannot provide
   read-back, create a visible manual-verification task.
2. **No production-first connector work.** Run every new adapter capability
   against disposable infrastructure, fixture accounts and synthetic groups.
3. **Least privilege first.** Request only the Graph permissions needed for
   the capability being tested. Admin consent, credential rotation and
   production scope expansion require a change record.
4. **One durable operation per HR event.** Re-submission must reuse an
   idempotency key and receipt rather than create duplicate people or target
   accounts.
5. **Simulation before application.** Pilot rules are demonstrated in
   simulation, then previewed, then applied to a small canary population.

## Workstream 1 — finish the Entra ID connector

### Build

1. Define a versioned Entra capability matrix in the connector document and
   UI:
   - `readAccounts`, `createAccount`, `updateAccount`, `disableAccount`,
     `grantEntitlement`, `revokeEntitlement`, `readBack`.
   - Mark unavailable items as unavailable; do not infer support merely from a
     successful token request.
2. Implement Graph user operations using stable identity anchors:
   - Create with an immutable correlation marker stored in a supported Graph
     field or extension.
   - Update only explicitly managed profile fields.
   - Disable with `accountEnabled: false`; do not delete accounts.
   - Read back user identity, enabled state and managed fields after every
     write.
3. Implement group entitlement operations:
   - Discover selectable security groups with server-side search and paging.
   - Grant and revoke group membership using the Graph API.
   - Read back direct membership after each operation.
   - Explicitly document whether nested groups and dynamic groups are
     supported; default to not managing either.
4. Add Graph-specific error classification:
   - `401/403`: credential or consent problem; no retry.
   - `404`: stale target object or group; route to manual work.
   - `429` and Graph retry hints: scheduled retry with recorded delay.
   - `5xx`/network errors: bounded retry and dead-letter outcome.
5. Add credential rotation support that invalidates the in-memory access-token
   cache and records an auditable readiness check.

### Test

Use a disposable Entra test tenant and at least two test users plus two test
security groups. Record test evidence (operation ID, target anchor, expected
state, observed state, timestamp) for each case.

| Capability | Test | Pass condition |
| --- | --- | --- |
| OAuth | Valid secret, invalid secret, rotated secret | Valid succeeds; invalid reports safe AADSTS code; rotation works without restart |
| Read | Graph users list, pagination, missing permissions | Stable anchors returned; page boundary has no omission or duplicate |
| Create | Create the same lifecycle operation twice | One Graph account and one Syntra receipt |
| Update | Change only a managed field | Intended field changes; unmanaged fields are unchanged |
| Disable | Offboard a test account | Account remains present and becomes disabled |
| Groups | Add then remove a direct membership | Membership is observed after each action |
| Read-back | Simulate delayed Graph visibility | Operation waits/retries or becomes manual verification; never claims verified early |
| Failure | `429`, `403`, unavailable Graph endpoint | Correct retry/dead-letter/manual classification and owner notification |

**Exit criterion:** every advertised Entra capability has an automated adapter
test plus recorded disposable-tenant evidence. Capabilities lacking either
remain unavailable in the UI.

## Workstream 2 — lifecycle pilot hardening

### Build

1. Finish the lifecycle operation view so every step exposes planned action,
   attempts, target response category, observed state, owner, due date and
   acknowledgement.
2. Add policy controls for required approvals before high-impact actions:
   account creation, privilege-bearing group changes, urgent departures and
   bulk requeues.
3. Ensure mover previews show field-level before/after data for contract,
   department, manager, location and role, as well as access to add, retain
   and remove. The apply call must be revision-bound so a stale preview cannot
   be applied.
4. Define service-level objectives (for example, urgent leaver disable within
   15 minutes) and calculate breach state from durable timestamps.
5. Complete notification delivery records for lifecycle failure, overdue
   departure and access blockage. Add a configured mail transport only after
   templates, opt-in/out policy and delivery monitoring are ready.

### Test

- Run a joiner, mover and leaver in simulation for every pilot department.
- Replay each request key three times; assert one person/contract/operation.
- Change a mover input after preview; assert apply rejects the stale revision.
- Force an adapter write failure; assert a visible owned task, notification
  record, retry control and dead-letter history.
- Create an overdue leaver; assert escalation goes to the configured owner and
  the UI exposes the overdue reason.
- Test retry after target recovery; assert a new attempt is appended rather
  than overwriting the original evidence.

**Exit criterion:** pilot stakeholders can explain the status of any employee
without checking logs or the target system manually.

## Workstream 3 — operating model and production readiness

### Build

1. Add deployment runbooks for backup/restore, master-key recovery, database
   migration, secret rotation, incident response and target rollback.
2. Publish health and capacity telemetry:
   queue depth, oldest pending age, failed/dead-letter count, retry rate,
   readiness freshness and operation latency by target.
3. Establish retention schedules for operation receipts, audit records,
   readiness evidence, notification delivery records and stale simulations.
   Retention cleanup must be auditable and tested against legal requirements.
4. Add tenant-scoped operational roles: platform operator, lifecycle owner,
   target administrator, auditor and read-only reviewer.
5. Add rate limits and concurrency caps per connector/tenant, with clear
   saturation feedback rather than hidden delays.

### Test

- Restore a recent backup into an isolated environment and perform a read-only
  reconciliation.
- Rotate the master key in a staging copy and prove old secrets can still be
  read during the approved migration window.
- Force 10x normal queue load; measure SLOs and ensure tenant isolation.
- Verify a retention cleanup removes only expired records and emits an audit
  event.
- Perform a tabletop incident: expired Entra secret, Graph outage, mistakenly
  broad mover rule and urgent leaver during outage.

**Exit criterion:** a small operations team can diagnose, mitigate and recover
from the common failure modes using runbooks and product telemetry.

## Workstream 4 — scale, accessibility and usability

### Build

1. Complete server-side filtering, sorting and cursor/page navigation for all
   high-volume lists: people, lifecycle work, operations, entitlements and
   audit activity.
2. Make entitlement search debounced, permission-aware and clear about which
   groups are direct/manageable versus dynamic or unsupported.
3. Add bulk operations only where an individual result is retained for every
   selected item; privileged changes should keep per-item confirmation and
   audit evidence.
4. Audit responsive layouts at 320px, 768px and desktop widths. Tables must
   remain contained, preserve headers or use accessible row cards, and never
   clip vital status or actions.
5. Expand keyboard and screen-reader coverage: focus order, focus return from
   dialogs, error summaries, live updates and bulk-selection feedback.

### Test

- Seed 10,000 people, 1,000 groups and 10,000 historical operations in a
  non-production database; verify query plans and user-facing latency.
- Test keyboard-only joiner/mover/leaver flows and queue actions.
- Run automated accessibility checks plus manual screen-reader checks for the
  core pilot journeys.
- Test reduced-motion, high zoom (200%), narrow viewport and translated UI.

**Exit criterion:** the core tasks are usable without a mouse and remain
responsive at pilot-scale data volumes.

## Suggested delivery sequence

1. **Weeks 1–2: Entra validation.** Build only user read/create/update/disable
   and direct group membership where validated; run disposable-tenant tests.
2. **Weeks 3–4: lifecycle pilot.** Configure one department, execute
   simulations, then canary real joiners/movers/leavers with daily review.
3. **Weeks 5–6: operations.** Finish alerts, mail delivery, runbooks, metrics,
   backup recovery and retention evidence.
4. **Weeks 7–8: scale and accessibility.** Load-test realistic volume,
   remediate accessibility findings and expand the pilot deliberately.

Do not add a second production connector before Entra’s capability matrix and
failure handling are proven. The reusable connector contract is the
acceleration; a broad but unverified connector catalogue is a liability.

## Pilot go/no-go checklist

- [ ] Entra connection and least-privilege permissions recorded in a readiness
      check.
- [ ] Entra capability matrix lists only features validated in disposable
      infrastructure.
- [ ] Joiner, mover and leaver simulations reviewed by HR, IT and security.
- [ ] Canary population and rollback owner named.
- [ ] Lifecycle work has owners, due dates, escalation policy and monitored
      delivery records.
- [ ] Backups, restore rehearsal, key rotation and incident runbooks complete.
- [ ] Audit retention and privacy policy approved.
- [ ] Accessibility and load-test exit criteria met.
- [ ] Production enablement recorded as a change approval.

## Immediate next actions

1. Create a disposable Entra test group and a non-production test user.
2. Decide which four Entra capabilities are required for the first pilot:
   normally read, create, disable and direct group membership.
3. Implement and prove those capabilities before enabling any automated
   provisioning rule.
4. Configure a single pilot department and run all three lifecycle simulations
   with its real HR data shape but no external writes.
