# Incident response

## Purpose

A single starting point when something is wrong with a Syntra deployment and
the cause is not yet known: how to classify it, what to do in the first
fifteen minutes, who to tell, and what evidence to capture so the
post-incident review has facts rather than recollection.

## When to use

- An alert from `ops/prometheus-alerts.yml` or a rule of your own fires.
- **Activity → Attention** in the console lists something critical.
- People cannot sign in, an application's SSO fails, or a joiner, mover or
  leaver did not get what they should have.
- A backup, update or restore did not end the way it was supposed to.

## Prerequisites

- Access to the host or cluster (journal, `docker compose`, `kubectl`).
- An administrator account with `audit.read` at minimum; `provision.manage`
  and `deployment.manage` for the actions below.
- Somewhere to write the timeline as it happens. A shared document is fine.
- The other runbooks in this directory.

## Severity levels

| Level | Definition | Examples | Response |
|---|---|---|---|
| **SEV1** | Syntra cannot do its job for everyone, or a control that revokes access has failed | `SyntraNotReady`; `SyntraUndeliveredLogout`; sign-in down for all tenants; a leaver's access provably still live past its due date | Page now; work it until resolved; communicate every 30 minutes |
| **SEV2** | One function is down or degraded for a tenant or a target | A target's runs all fail; an HR import fails; webhooks to one receiver abandoned; a mover applied more than intended but stopped by a threshold | Respond within the hour; communicate at start and end |
| **SEV3** | Something has given up that has a manual path | One delegated task failing; a single notification undelivered; a run blocked pending confirmation | Next working day |

A SEV3 that recurs is a SEV2. A leaver is always at least SEV2 while their
access is not confirmed revoked.

## The first fifteen minutes

1. **Establish what the product thinks is wrong.**

   ```bash
   curl -s http://127.0.0.1:3000/health/ready
   ```

   Then, signed in, `GET /api/admin/incidents` or **Activity → Attention**.
   The incidents list is critical-first, then most recent, and every entry
   has an `href` into the console.

2. **Establish what changed.** The audit log, newest first:
   `GET /api/admin/audit?limit=50`, or **Activity → All events**. Look for
   `deployment.*`, `provision.*`, `policy.*`, `tenant.settings_updated`,
   `notify.*`. Check `cat /opt/syntra/var/update.status` on the release
   layout; an update in the last hour is the prime suspect.

3. **Stop the bleeding, not the product.** The controls in
   [Target rollback](target-rollback.md) stop a target without losing state.
   Do not restore a backup, disable a directory source, or rotate a key in
   the first fifteen minutes unless the failure is exactly that.

4. **Declare the severity and open the record.** Timestamp, what was seen,
   who is working it.

5. **Communicate** (below).

## Playbooks by signal

### `SyntraNotReady`

`syntra_readiness == 0` for five minutes. Read which probe failed:

```bash
curl -s http://127.0.0.1:3000/health/ready | tr ',' '\n'
journalctl -u syntra -n 200 --no-pager       # the unredacted cause
```

| Probe | Meaning | Runbook |
|---|---|---|
| `database` | This process cannot reach Postgres with its own credentials | Check the container/service; `docker ps`, `docker compose ps`, `kubectl get pods`; then credentials ([Secret rotation, Procedure K](secret-rotation.md#procedure-k-database-role-passwords-compose-path)) |
| `migrations` | Schema behind the code, or a migration half-applied | [Database migration](database-migration.md) |
| `vault` | `MASTER_KEY` does not unseal a signing key | [Master-key recovery](master-key-recovery.md) |
| `web` | `WEB_ROOT` set but no `index.html` there | The build or the path; see below |

A probe that took longer than five seconds is reported as a failure, which is
the shape of a database that accepts connections and does not answer.

### The `web` probe

Only on a single-process deployment with `WEB_ROOT` set. The API refuses to
start on a path that is not a build, so this fails at runtime only if the
bundle vanished after start (a rollback that relinked `current` while
`WEB_ROOT` was an absolute path into the old release, for example;
`ops/syntra-install` rewrites `WEB_ROOT` at conversion for this reason).
Fix the path in `shared/.env`, restart.

### Lifecycle work alerts

`SyntraLifecycleWorkOverdue` and `SyntraLifecycleWorkFailed`. The queue is
**Employee work** (`/admin/employee-work`; `GET /api/admin/employee-work`),
filterable by onboarding, offboarding and failed. Each row links to the
person and, for a lifecycle operation, to
`/admin/lifecycle-operations/:id`, where the operator can **Acknowledge
work** and **Retry operation**. Retry also re-queues the operation's
unapplied target receipts, and refuses with 503 when the scheduler is down
rather than pretending.

Metrics carry no tenant label. Use the queue to find the owner and record.
An operation with an owner and a due date past is what the alert counts;
assigning one (`PATCH /api/admin/lifecycle-operations/:id/assignment` with
`ownerUserId`, `priority`, `dueAt`) queues a `lifecycle-assigned` mail, and
the hourly `lifecycle.maintenance` job queues `lifecycle-failed` and
`lifecycle-overdue` mail to owners, deduplicated per operation.

### An abandoned delivery

`SyntraUndeliveredLogout`: a back-channel logout was never delivered. A
relying party still believes an ended session is live. There is no retry
route for logout deliveries; the compensating action is at the relying
party (revoke the session there by hand) and the incident record must name
which one. The `logout_deliveries_abandoned` count on `/metrics` tells you how
many; the `LogoutDelivery` table tells you which.

`webhook_undelivered` in the incidents list is the webhook counterpart:
`GET /api/admin/webhooks/:id/deliveries` shows them and
`POST /api/admin/webhooks/:id/deliveries/:deliveryId/retry` retries one.

### Scheduler unavailable

`scheduler_unavailable` at the top of the incidents list, `syntra_jobs_pending`
absent or `syntra_scheduler_running == 0`. Nothing scheduled runs: no
provisioning, no sync, no retries, no lifecycle maintenance, no OIDC key
rotation. Routes that need it answer 503 `scheduler-unavailable`. The API
retries starting it; read the log for the pg-boss error. It is almost always
the database (permissions on the `pgboss` schema, or a restore that dropped
it). Restart the API once the cause is fixed.

### Target signals

`target_runs_skipped`, `target_never_completed`, `provision_run_failed`.
See [Target rollback](target-rollback.md) and the
[tabletop exercises](tabletop-exercises.md) for the Entra-specific cases.

### Sign-in failing

- Password sign-in works, SSO does not: the vault (signing keys). See
  `SyntraNotReady` above even if the alert has not fired yet.
- Everything 404s: the `Host` header is not a tenant name; check
  `PUBLIC_URL`, the proxy, and **Tenant settings → Also answers on**.
- Lockouts climbing (`syntra_accounts_locked`): look at
  `auth.lockout` in the audit log; a rate of failures from one address is
  an attack, from many users at once is a broken upstream password change.

## Communication

- **Who**: the deployment's operations channel; tenant administrators for
  anything they will see (sign-in outage, a run that will not apply, a mail
  backlog); application owners for SSO or webhook failures; HR for anything
  touching joiners, movers or leavers.
- **What**: severity, what is affected, what is not, what the next update
  time is. Never the cause until it is known.
- **Cadence**: SEV1 every 30 minutes; SEV2 at start, at any change of plan,
  and at close.
- **Close**: what happened, what was lost (audit gap after a restore;
  deliveries abandoned), what remains to be done by hand (relying-party
  sessions, TOTP re-enrolment, SP metadata), and where the record is.

## Evidence capture

Capture before fixing where the fix would overwrite the evidence.

| Evidence | How |
|---|---|
| Readiness verdict | `curl -s http://127.0.0.1:3000/health/ready > ready-$(date -u +%Y%m%dT%H%M%SZ).json` |
| Incidents | `GET /api/admin/incidents`, saved as JSON |
| Audit log | `GET /api/admin/audit?limit=200` and page backwards with `before=<lowest sequence seen>`; filter with repeated `subject=<uuid>` for one person and their accounts. There is no bulk export route; the page size cap is 200 |
| Process log | `journalctl -u syntra --since '-2h' --no-pager > syntra.log`; compose `docker compose logs --since 2h api > api.log`; Helm `kubectl -n syntra logs deploy/syntra-api --since=2h` |
| Backup and update state | `syntra-backup list`; `cat /opt/syntra/var/update.status`; `journalctl -p err -t syntra-backup --since -7d` |
| Metrics snapshot | `curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics > metrics.txt` |
| A run's plan | `GET /api/admin/targets/:id/runs/:runId`, the actions in sequence order with the person named on each |
| A person's state | `GET /api/admin/persons/:id`, `/access`, `/offboarding`, `/provision-receipts` |
| Database counts | The [reconciliation queries](backup-and-restore.md#read-only-reconciliation-checklist) |

The audit log is append-only and hash-chained; `chainValid` travels with
every page. Note its value in the record. A `false` with `brokenAtSequence` is
its own SEV1.

## Verification

An incident is closed when:

- The triggering signal has cleared on its own (the incidents list has no
  acknowledge; it empties when the cause is fixed).
- `/health/ready` is ready and `syntra_readiness` is 1.
- Any lifecycle operation involved reads `completed` on
  `/admin/lifecycle-operations/:id`.
- The record names every compensating action taken outside Syntra.

## Rollback

Incident response is not a change; the rollbacks belong to the runbooks it
sends you to. If an action taken during the incident made things worse,
record it in the timeline as its own event before undoing it.

## What this does not cover

- **Security incident handling** beyond evidence capture: forensic
  preservation, legal notification and law-enforcement contact are the
  organisation's process.
- **Tenant-facing status pages.** Syntra has none.
- **Alert routing.** `ops/prometheus-alerts.yml` is a starter rule group;
  routing and paging live in Alertmanager.
