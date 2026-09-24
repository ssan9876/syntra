# Queue recovery

## Purpose

Background work in Syntra has two halves: a **row** that says what state the
work is in (a directory sync run, an HR import run, a provisioning run, a
person's target operation, an export, a lifecycle operation) and a **job** in
pg-boss that is supposed to move it. This runbook is for when the two
disagree: a run that says `queued` with no job behind it, a provisioning apply
whose process died, a job that fails on the same payload again and again.

The console's **Operations** page (`/admin/operations`) and
`GET /api/admin/job-health` find these; `POST /api/admin/job-health/repair`
repairs them. Every repair reuses the subsystem's own recovery semantics, is
idempotent, and is audited.

## When to use

- `SyntraJobsOrphaned`, `SyntraJobsStuck`, `SyntraJobsPoisoned`,
  `SyntraJobsDelayed`, `SyntraJobsDuplicated` or `SyntraJobHealthBlind` fires.
- A run page has shown `queued` or `running` for far longer than usual.
- After a node drain, an OOM kill or a database failover, to check that
  nothing was left behind.

## Prerequisites

- `audit.read` to read job health; `tenant.manage` to repair.
- The metrics carry no tenant label. Sign in to each tenant's console (or ask
  its administrator) to see which of its work is affected.

## What each finding means

| Finding | Means | Safe repairs |
|---|---|---|
| `orphaned` | The row says work is waiting or under way and no live job exists for it (after 10 minutes), or a provisioning apply's heartbeat stopped more than 15 minutes ago | queued run, export or target operation: **requeue** or **mark failed**; reading run or generating export: **mark failed**; provisioning apply: **release** |
| `stuck` | No progress for more than 6 hours | as for orphaned where no worker is running it; none while a live worker holds it |
| `delayed` | A live job has waited more than 15 minutes for a worker | none: the queue is behind. See *Queue is behind* below |
| `duplicated` | More than one live job for the same work | none needed: every worker claims its row conditionally, so the extra job does nothing. Find the double enqueue |
| `poisoned` | The same payload failed 3 or more times in 24 hours | none: fix the cause (the finding names its error class) and let the schedule or a person start it again |
| `saturation_deferred` | A target operation stepped back from the tenant's concurrency cap | none needed: it retries every 30 s. Raise the cap in **Lifecycle policy** if it persists |

Nothing is reported **orphaned** while the queue cannot be read — "no live
job" cannot be concluded from "could not look". The page says so, and
`syntra_job_queue_readable` is 0.

## Procedure

1. **Open Operations** in the affected tenant's console, or
   `GET /api/admin/job-health`. Read the finding's sentence: it says what the
   row is doing and why it is a finding.
2. **Check the cause before repairing.** A finding after a node drain or a
   crash needs only the repair. A finding that comes back after a repair means
   something is still wrong: the scheduler (`syntra_scheduler_running`), the
   database, or — for `poisoned` — the payload itself.
3. **Repair**, with a reason of at least ten characters. The reason is written
   to the audit event and, for **mark failed**, onto the row.
   - **Requeue** enqueues the job the row is missing. Only offered where no
     worker has started. A requeue that races a late original job does
     nothing twice.
   - **Mark failed** ends a row nothing is working on. A preview that never
     finished wrote no plan, so nothing is lost; a waiting cancellation request
     is honoured (`cancelled`) instead.
   - **Release** closes a provisioning apply whose process is gone as
     `partially_applied` — what the next run's adoption would make it.
     Actions whose outcome is unknown (`in_flight`) are **not** touched: the
     next preview asks the target about each one (`resolveInFlightActions`)
     before planning anything. Nothing here re-runs a connector write.
4. **Verify.** Reload the page: the finding is gone. A second press of the
   same repair answers *nothing to do*. The audit log has
   `job_health.requeue`, `job_health.mark_failed` or
   `job_health.release_lease` with the reason and the before and after
   status.

## Things that are deliberately not repairable here

- **Lifecycle operations.** Retry them from the operation's own page. A retry
  after an ambiguous target outcome requires fresh verification evidence
  there, and a second button that bypassed it would defeat the control.
- **Directory sync and HR import runs in `applying`.** These applies carry no
  heartbeat, so a live apply cannot be told from a dead one. Apply the run
  again from its page (it resumes) or cancel it (the cancellation is honoured
  before anything is touched).
- **pg-boss's own rows.** Nothing here deletes or edits a job.

## Queue is behind

`delayed` findings or `SyntraJobQueueDeep`: the scheduler is running but not
keeping up. Check the API process's CPU and event-loop lag, the database's
connection pool (`docs/operate.md`, *Connection-pool sizing*), and whether one
tenant's scheduled work is dominating (the per-tenant consoles show it). Adding
API replicas adds workers.

## Back-out

A repair cannot be undone as such, and none needs to be:

- a requeued job that was not needed claims nothing;
- a run marked failed or released is reviewable history, and the next run
  re-proposes whatever is still true;
- a released provisioning run's unknown actions are verified before anything
  new is planned.

## Evidence

Record in the incident timeline: the findings (the Operations page or the JSON
from `GET /api/admin/job-health`), each repair's audit event, and — for a
support case — a **support bundle** (Operations → Support bundle), which
includes job health and recent failures by error class with no personal data.
