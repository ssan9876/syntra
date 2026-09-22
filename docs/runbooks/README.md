# Runbooks

Operational procedures for a running Syntra deployment. Each runbook states
what it is for, when to reach for it, what it needs, the exact commands and
console surfaces involved, how to verify the result, how to back out, and what
it deliberately does not cover.

Every command in these pages was checked against the scripts and routes in
this repository at the time of writing. Where the product has no capability a
procedure needs, the runbook says so rather than inventing one.

| Runbook | Use it when |
|---|---|
| [Backup and restore](backup-and-restore.md) | Taking, proving and restoring database backups; rehearsing a restore in isolation; reconciling before and after |
| [Master-key recovery](master-key-recovery.md) | `MASTER_KEY` is lost, wrong, or a restore refuses over a key mismatch |
| [Database migration](database-migration.md) | Applying schema migrations on the release layout, the compose path or Helm; checking migration state; backing out |
| [Secret rotation](secret-rotation.md) | Rotating `SESSION_SECRET`, `METRICS_TOKEN`, target credentials (including an Entra client secret), SMTP, API tokens, webhook signing secrets; the `MASTER_KEY` caveat |
| [Incident response](incident-response.md) | Anything is wrong and it is not yet clear what; severity, first 15 minutes, evidence, communication |
| [Target rollback](target-rollback.md) | A provisioning target must be stopped, a run must be reviewed or refused, or a bad mover has to be put back |
| [Tabletop exercises](tabletop-exercises.md) | Rehearsing four incidents on paper: expired Entra secret, Graph outage, an over-broad mover rule, an urgent leaver during an outage |

## On-call quick reference

### Which alert leads where

The starter rule group is `ops/prometheus-alerts.yml`. Its four alerts, and
the runbook each one wants:

| Alert | Expression | Severity | Go to |
|---|---|---|---|
| `SyntraNotReady` | `syntra_readiness == 0` for 5m | critical | [Incident response](incident-response.md#syntranotready), then whichever probe failed: database or migrations, [Database migration](database-migration.md); vault, [Master-key recovery](master-key-recovery.md); web, [Incident response](incident-response.md#the-web-probe) |
| `SyntraLifecycleWorkOverdue` | `syntra_lifecycle_operations_overdue > 0` for 15m | warning | [Incident response](incident-response.md#lifecycle-work-alerts); the queue is **Employee work** in the console |
| `SyntraLifecycleWorkFailed` | `syntra_lifecycle_operations_failed > 0` for 5m | warning | [Incident response](incident-response.md#lifecycle-work-alerts); for a target-side cause, [Target rollback](target-rollback.md) |
| `SyntraLifecycleServiceLevelBreached` | `syntra_lifecycle_operations_slo_breached > 0` for 1m | critical | [Tabletop: urgent leaver](tabletop-exercises.md); the operation page names the breach and who it was escalated to |
| `SyntraLifecycleApprovalsWaiting` | `syntra_lifecycle_operations_awaiting_approval > 0` for 4h | warning | Somebody with `provision.manage` other than the requester opens the operation and approves or rejects |
| `SyntraTenantSaturated` | `syntra_lifecycle_receipts_deferred > 0` for 15m | warning | Raise the cap in **Lifecycle policy** or wait; deferred receipts retry themselves every 30 s |
| `SyntraProvisioningRunsFailing` / `SyntraProvisioningRetriesExhausted` / `SyntraTargetStale` | see `ops/prometheus-alerts.yml` | warning | [Target rollback](target-rollback.md); an expired Entra secret shows here first |
| `SyntraReadinessEvidenceStale` | `syntra_target_readiness_age_seconds > 7d` | warning | [Secret rotation](secret-rotation.md): test the connection from the target page |
| `SyntraSchedulerDown` | `syntra_scheduler_running == 0` for 10m | critical | [Incident response](incident-response.md) |
| `SyntraUndeliveredLogout` | `syntra_logout_deliveries_abandoned > 0` for 5m | critical | [Incident response](incident-response.md#an-abandoned-delivery): a relying party was never told an account ended |

The rule file's `runbook` annotations still point at `docs/operate.md`. The
file is outside `docs/` and was not changed by this set; update the
annotations to the pages above when the rules are next edited.

Things worth alerting on that the starter file does not cover, and what a
rule for each would watch:

| Signal | Metric | Meaning |
|---|---|---|
| Webhooks given up | `syntra_webhook_deliveries_abandoned > 0` | An integration has stopped being fed and nothing else tells its owner |
| Signing key near expiry | `syntra_signing_key_expires_in_seconds` below, say, 14 days | Rotation is monthly and its failure is silent until every token stops verifying |
| Scheduler dead | `syntra_jobs_pending` absent, or `syntra_scheduler_running == 0` where published | No provisioning, sync, retries or lifecycle maintenance is running |
| Lockout spike | rate of `syntra_accounts_locked` | Credential stuffing, or a broken upstream password change |

### Where telemetry lives

**Metrics.** `GET /metrics`, Prometheus text format, bearer token
`METRICS_TOKEN`. Unset token means the route is not registered and answers
404. Every series is installation-wide; there are no tenant labels by design.
Names, from `apps/api/src/routes/metrics.ts`:

| Metric | Answers |
|---|---|
| `syntra_build_info` | Which release is running |
| `syntra_http_request_duration_seconds` | Latency, by method, route pattern and status |
| `syntra_readiness` | The `/health/ready` verdict, 1 or 0 |
| `syntra_scheduler_running` | 1 when the job scheduler is up (published only when the process wires one) |
| `syntra_jobs_pending` | pg-boss jobs in `created` or `retry`; absent if the scheduler has never run |
| `syntra_webhook_deliveries_pending` / `_abandoned` | Webhook sender backlog; deliveries that exhausted retries |
| `syntra_logout_deliveries_pending` / `_abandoned` | Back-channel logout backlog; logouts never delivered |
| `syntra_sessions_active` | Live sessions |
| `syntra_users_total{status}` | Accounts by status |
| `syntra_accounts_locked` | Accounts locked by failed sign-ins |
| `syntra_lifecycle_operations_unresolved` / `_failed` / `_overdue` | Lifecycle work in flight, failed, and past due without acknowledgement |
| `syntra_lifecycle_operations_awaiting_approval` / `_slo_breached` | Work waiting for a second person; unresolved work past its service-level deadline |
| `syntra_lifecycle_oldest_unresolved_age_seconds` | Age of the oldest open operation; absent when none |
| `syntra_lifecycle_retry_rate` | Share of operations resolved in the last day that needed more than one attempt; absent when none resolved |
| `syntra_lifecycle_receipts_deferred` | Target operations stepping back from a saturated tenant (concurrency cap) |
| `syntra_provision_actions_pending_retry` / `_failed_24h` | Actions that exhausted retries (the dead-letter equivalent); actions failed permanently in the last day |
| `syntra_provision_runs_failed_24h` | Provisioning runs that failed in the last day |
| `syntra_targets_stale` | Enabled, scheduled targets that have not run in a day |
| `syntra_target_readiness_age_seconds` | Age of the oldest current connection test across targets; absent when none |
| `syntra_lifecycle_operation_duration_seconds{kind,quantile}` | p50 / p95 of operations resolved in the last day |
| `syntra_target_operation_duration_seconds{target_type,quantile}` | p50 / p95 of applied target operations, by connector type, never by target |
| `syntra_signing_key_expires_in_seconds` | Nearest signing key expiry; absent if no key exists |
| `syntra_audit_events_total{action,outcome}` | Security events by kind |

Plus the Node process defaults under the `syntra_` prefix.

**Readiness.** `GET /health/ready`, unauthenticated, JSON:
`{ ready, version, probes: [{ name, status, detail }] }`. Probes are
`database`, `migrations`, `vault` and `web`; a failing probe's detail is
redacted to `this check did not pass` on the wire and the cause goes to the
process log. `GET /health` is liveness only and returns 200 with the database
down.

**Incidents.** `GET /api/admin/incidents` (permission `audit.read`), or the
console at **Activity → Attention** (`/admin/activity?tab=attention`). It
lists things that have already given up or are measurably overdue, never
warnings. Kinds: `scheduler_unavailable`, `webhook_undelivered`,
`notification_undelivered`, `target_runs_skipped`, `target_never_completed`,
`provision_run_failed`, `sync_run_failed`, `task_failing`. There is no
acknowledge or dismiss; an entry clears when the cause is fixed.

**Audit log.** `GET /api/admin/audit?limit=200&before=<sequence>&subject=<uuid>`
(permission `audit.read`), newest first, with `chainValid` on every page.
Console: **Activity → All events**.

**Process logs.** Release layout: `journalctl -u syntra`. Compose:
`docker compose logs api`. Helm: `kubectl -n <namespace> logs deploy/<release>-api`.

**Backups.** `/opt/syntra/bin/syntra-backup list`, and the journal at
`journalctl -p err -t syntra-backup --since -7d --no-pager` for failed runs.

**Update state.** `/opt/syntra/var/update.status`, or **Settings → Updates**.

### Deployment shapes these runbooks assume

Three layouts appear in this repository and the runbooks name which one a
step applies to:

- **Release layout** (`docs/lab/README.md`, `ops/syntra-install`):
  `/opt/syntra/current`, `/opt/syntra/shared/.env`, a `syntra` systemd unit,
  Postgres in a Docker container named by `PG_CONTAINER`. `syntra-update` and
  `syntra-backup` are written for this layout and only this layout.
- **Compose path** (`docker-compose.yml`, optional `docker-compose.tls.yml`):
  `postgres`, `api` and `web` services; the `api` image runs migrations before
  it starts; data in the `syntra-data` volume.
- **Helm** (`deploy/helm/syntra`): `<release>-api` and `<release>-web`
  Deployments, a `<release>-migrate` pre-install/pre-upgrade Job, secrets in
  the `syntra-runtime` Secret.

Further reading: [Operate](../operate.md), [Install](../install.md),
[Configure](../configure.md).
