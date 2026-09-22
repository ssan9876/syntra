# Tabletop exercises

## Purpose

Four incidents, rehearsed on paper by the people who would handle them for
real. Each scenario states the detection signal, what the product will do on
its own (with the exact console screen or API route), the steps an operator
takes, and the criteria for calling it done. A scorecard follows each for the
facilitator to fill in.

Run them against a real deployment's console in read-only fashion where you
can: open the pages, find the buttons, do not press the ones that write.

## When to use

- Before the first production go-live of a target.
- After any change to `ops/prometheus-alerts.yml`, the on-call rota, or the
  runbooks.
- Quarterly.

## Prerequisites

- A facilitator who has read the runbooks and holds the answers.
- The on-call operator(s), a tenant administrator, and for exercises 3 and
  4 someone who speaks for HR.
- Access to a console (production, read-only, or the lab).
- Ninety minutes for all four, or thirty for one.

## How to run one

1. The facilitator reads the scenario's opening line only.
2. Participants say what they would look at first and what they expect to
   see. The facilitator reveals the "expected product behaviour" as they get
   to each surface, and corrects mistaken expectations.
3. Participants walk the operator steps aloud. The facilitator times the
   first-fifteen-minutes checklist from
   [Incident response](incident-response.md#the-first-fifteen-minutes).
4. Score. Record every place the product, the runbook or the team fell short.

## Exercise 1: expired Entra client secret

**Opening line.** "It is Monday 08:10. Nobody has complained. Something is
wrong with the Entra ID target."

**Background.** Entra client secrets have a fixed lifetime set when they are
created. Nothing in Syntra reads that expiry. The first sign is a token
request refused.

**Detection signal.**

- The target's scheduled run starts and fails at the token endpoint. The
  connector surfaces `the token endpoint answered HTTP 401 (AADSTS7000222)`
  (the AADSTS code is the only part of Microsoft's response kept; the body
  can echo the secret). In `GET /api/admin/targets/:id/runs` the run is
  `failed`; the `provision_run_failed` incident (warning) appears in
  **Activity → Attention** within the same hour.
- `lastRunAt` stops moving because it is written only by a finished preview.
  After two days, or twice the schedule's cadence, the
  `target_never_completed` incident (critical) names the target: "runs are
  starting and not finishing". The targets list shows the same state with
  the explanation that a rotated credential is one cause.
- **No Prometheus alert fires** from the starter rule group. Nothing in
  `/metrics` counts failed provisioning runs. Detection depends on somebody
  reading the incidents page.
- Because the connector caches access tokens in memory for their lifetime,
  a run that started within the hour before expiry may have succeeded on a
  cached token; the failure can look intermittent for one cycle.

**Expected product behaviour.**

- The guard is not involved; the run failed before a plan existed. Nothing
  was applied. Accounts at Entra are as they were.
- Sync and every other target continue.
- `GET /api/admin/targets/:id/readiness` shows the last recorded check, which
  will be `passed` with an old date: readiness history is written by **Test
  connection**, not by runs.

**Operator steps.**

1. Open **Activity → Attention**; follow the incident's link to
   **Target systems**. Confirm the target's last run is `failed` and read its
   message.
2. Open the target; press **Test connection**. Expect the same AADSTS
   failure. That test with a saved target's credential records a `failed`
   readiness check with the latency and message.
3. In Entra, add a new client secret to the app registration. Do not remove
   the old one yet.
4. Back on the target page, paste it into **Application client secret**,
   press **Test connection**; expect success. Save. This is
   `PATCH /api/admin/targets/:id` with `bindPassword`, and the value is
   never shown again.
5. Because the token cache is not flushed on a credential change, either
   accept that the first run after saving may still use the old cached token
   (harmless: it is still valid at Microsoft until expiry) or restart the
   API to be certain the new secret is what the next run presents.
6. **Runs → Run now**. Read the plan: a target that missed a weekend of runs
   may propose a weekend of changes. Apply, or apply in part
   ([Target rollback, Procedure C](target-rollback.md#procedure-c-apply-part-of-a-run)).
7. Remove the old secret in Entra.
8. Write the expiry date of the new secret in the operations calendar. That
   calendar is the only warning there is.

**Exit criteria.**

- The latest run is `applied` and `lastRunAt` is today.
- The `target_never_completed` and `provision_run_failed` entries have
  cleared from the incidents list (the latter after seven days, since it
  counts failures in the last week, unless there are none).
- `GET /api/admin/targets/:id/readiness` is `passed` and `current: true`.
- The new secret's expiry is recorded somewhere a person will see it before
  it happens.

**Scorecard.**

| Question | Yes / No / Partial | Notes |
|---|---|---|
| Was the failure noticed before a user reported it? | | |
| Did the team find the run's message without help? | | |
| Did the team test before saving? | | |
| Did the team know the token cache is not flushed? | | |
| Was the old secret removed in Entra after, not before, the new one worked? | | |
| Is the new expiry date recorded? | | |
| Time from opening line to "Run now" applied | | |
| Gaps found in product or runbook | | |

## Exercise 2: Microsoft Graph outage

**Opening line.** "It is 14:00. Microsoft's status page shows a Graph API
degradation in your region. The Entra target runs hourly with auto-apply
on."

**Detection signal.**

- Runs during the outage either fail at the read (`failed` run, Graph
  answering 5xx or timing out) or complete the read and then fail or stall
  on writes. Graph answers `429` with `Retry-After` and `503` during
  throttling; the connector's document classifies both as throttled.
- Incidents: `provision_run_failed` (warning) after the first failed read;
  `target_never_completed` (critical) only after two days, so not during a
  same-day outage.
- If Graph returns an **empty** user list rather than an error, the guard
  refuses the run outright: "the target returned no accounts at all, and a
  run has been applied against it before … an empty target and an
  unreachable one look identical from here, and the safe reading is the
  second". That run is `blocked` with `requiresConfirmation: false` and
  nobody can apply it.

**Expected product behaviour.**

- Throttling is honoured: `runWrite` waits `Retry-After`, up to 20 throttled
  attempts and 120 seconds accumulated per action (`apply.ts`). A throttle
  is not counted against `maxAttempts`.
- A retryable failure that exhausts its attempts ends the action
  `pending_retry`, not `failed`. The run ends `partially_applied`. The next
  run picks the action up **if the plan still wants it**: a target that was
  down for an afternoon does not come back to a queue of decisions made
  against the afternoon's facts.
- An action whose write may or may not have landed when the process lost
  the answer stays `in_flight`; the next run asks Graph what happened and
  resolves it.
- Sync, other targets, sign-in and everything else are unaffected.
- The population-drop guard protects against a related failure: if an HR
  feed also failed and the person register collapsed, no run applies.

**Operator steps.**

1. Confirm the outage is external (Microsoft's status, the run messages
   naming HTTP status codes).
2. Decide whether to leave auto-apply on. The safe default during an outage
   is to turn it **off**
   (`PATCH /api/admin/targets/:id { "autoApply": false }`) so that the first
   run after recovery, which may be large, is read by a person. Do not
   disable the target; disabling is unnecessary and hides it from the
   staleness check.
3. Do **not** confirm any blocked run during the outage. A run blocked
   because Graph returned nothing cannot be confirmed anyway.
4. Communicate: joiners and leavers due at this target during the window
   will land late. HR and the service desk need to know.
5. For an urgent leaver during the outage, run Exercise 4.
6. After recovery: **Run now**. Read the plan end to end. Expect creates,
   disables and revocations that accumulated. Thresholds may block it; read
   the numbers and confirm if they are the outage's backlog and not a
   broken feed.
7. Apply. Watch the run's `partially_applied` count go to zero over the next
   runs as `pending_retry` and `in_flight` actions resolve.
8. Turn auto-apply back on.

**Exit criteria.**

- A run after recovery is `applied` (or `partially_applied` with every
  remaining action explained).
- No action on the target is `in_flight` or `pending_retry` older than the
  outage.
- Every lifecycle operation that touched the target during the window is
  `completed` in **Employee work**.
- The incident record lists what landed late and when.

**Scorecard.**

| Question | Yes / No / Partial | Notes |
|---|---|---|
| Did the team distinguish "failed read" from "empty read" from "throttled writes"? | | |
| Did anyone propose disabling the target? Was that corrected? | | |
| Did anyone propose confirming a blocked run? | | |
| Did the team know that `pending_retry` is re-planned, not replayed? | | |
| Was HR told about late joiners and leavers? | | |
| Was the first post-recovery run read by a person? | | |
| Gaps found in product or runbook | | |

## Exercise 3: a mistakenly broad mover rule

**Opening line.** "An administrator edited a business rule on the AD target
at 09:30 so that everyone in `Department = Sales` gets the `Sales-Team`
group. They typed `Department is not Sales`. The target is scheduled hourly
with auto-apply."

**Detection signal.**

- **Before save.** `POST /api/admin/targets/:id/rules/impact` previews how
  many persons a condition matches. The console's rule editor shows the
  count. A rule that matches almost everybody is visible here, before
  anything is written.
- **At the next run.** The plan proposes `grant_entitlement` for every
  non-Sales person and `revoke_entitlement` for every Sales person. Grants
  are unguarded. The revocations trip the per-entitlement axis: "would
  revoke "Sales-Team" from N of N holders (100.0%), above the X%
  per-entitlement threshold". The run is `blocked`,
  `requiresConfirmation: true`, and auto-apply does not touch it.
- **If the entitlement had few holders and the threshold was generous**, the
  revocations may pass and the run applies: Sales loses the group, everyone
  else gains it. Detection is then a complaint, a drift review, or the audit
  log (`provision.run.apply` with the counts).
- No alert fires. `syntra_lifecycle_operations_*` do not count provisioning
  runs.

**Expected product behaviour.**

- The guard evaluates every consequential population separately and fails
  closed: a denominator it cannot compute is a refusal, not a pass.
- A blocked run stays blocked until a person confirms with the numbers in
  front of them, and the confirmation is recorded with who did it.
- If applied, nothing was deleted. Membership removal and addition are both
  reversible by the next run.

**Operator steps.**

1. Stop the target's auto-apply (or unschedule it) so the next hourly run
   does not compute the same wrong plan and, if under threshold, apply it.
2. Open the blocked run. Read the reason. Do not confirm.
3. Open **Business rules** on the target. Find the rule; the audit log has
   the change (`GET /api/admin/audit?limit=50`, look for the rule event and
   its actor). Correct the condition; use the impact preview to see the
   matched count fall to the expected population; save.
4. **Run now**. The new run supersedes the blocked one (it is marked
   `failed`). Read the plan: it should now propose only what the corrected
   rule implies.
5. If the wrong plan **was applied** earlier: the corrected run proposes the
   inverse: `grant_entitlement` back to Sales (unguarded) and
   `revoke_entitlement` from everyone else, which trips the per-entitlement
   threshold again, this time legitimately. Read the numbers, confirm,
   apply. See
   [Target rollback, Procedure D](target-rollback.md#procedure-d-a-run-that-was-applied-and-was-wrong).
6. Check one affected person: `GET /api/admin/persons/:id/access` and the
   group in AD.
7. Restore auto-apply and the schedule.
8. Record: who changed the rule, when it was noticed, what was applied in
   between, and what the impact preview showed before the fix.

**Exit criteria.**

- The rule's impact preview matches the intended population.
- The latest run is `applied` with no unexpected revocations.
- Spot-checked persons hold exactly the intended entitlements.
- Drift findings on the target (`GET /api/admin/targets/:id/drift?status=open`)
  are reviewed and acknowledged or resolved.

**Scorecard.**

| Question | Yes / No / Partial | Notes |
|---|---|---|
| Did the team stop auto-apply before editing the rule? | | |
| Did anyone want to confirm the blocked run to "get it over with"? | | |
| Was the impact preview used before saving the fix? | | |
| Did the team know that grants are unguarded and revocations are not? | | |
| Could the team explain why the inverse run also blocks? | | |
| Was the actor found in the audit log? | | |
| Gaps found in product or runbook | | |

## Exercise 4: an urgent leaver during an outage

**Opening line.** "It is 16:45. HR calls: an employee must lose all access
now. The Entra target is in the Graph outage from Exercise 2, and the job
scheduler has been restarting since a database failover at 16:20."

**Detection signal.** None; this is a request. The complication shows up as
`scheduler_unavailable` at the top of **Activity → Attention** and
`syntra_jobs_pending` absent from `/metrics`.

**Expected product behaviour.**

- **End employment** on the person page (`POST /api/admin/persons/:id/offboarding`
  with `reason` and the preview's `revision`) does the following in the
  request, without the scheduler:
  1. Marks the Person `inactive` with the departure and reason, and records
     `person.offboarding.started` with the account and target ids.
  2. Creates an `offboard` lifecycle operation with two required steps,
     `local-access` and `targets`.
  3. For every Syntra login linked to the person, calls
     `deactivateDirectoryUser`: **Syntra sessions and refresh tokens are
     revoked** and the login is disabled. If the login is owned by a
     directory source, disable write-back must be enabled on that source or
     the result is `Enable directory disable write-back or disable this
     account in its source directory.`
  4. Marks `local-access` succeeded or failed with the per-account results.
  5. Queues target work. With the scheduler down it cannot: the `targets`
     step is marked `failed` with `Background jobs are unavailable. Target
     work remains in the employee queue.` and the operation appears under
     **Employee work → Failed**.
- The response lists each login with `disabled` or `failed` and a link to
  the operation. An administrator cannot end their own employment.
- Once the scheduler returns, **Retry operation** on
  `/admin/lifecycle-operations/:id` re-queues the unapplied target receipts.
  With Graph still down, the target step stays `running` or fails again;
  the receipts remain pending and are retried.
- `syntra_lifecycle_operations_failed` goes above 0 and
  `SyntraLifecycleWorkFailed` fires after five minutes. If the operation is
  assigned an owner with a due time, `SyntraLifecycleWorkOverdue` fires
  fifteen minutes after that passes without acknowledgement.

**Operator steps.**

1. Open the person: **Users → People → the person** (`/admin/people/:id`).
   Press **End employment**, read
   the preview (which logins, which targets, the write-back state of each
   source), enter the reason, press **End employment now**.
2. Read the results line by line. Every `failed` login is an account still
   able to sign in somewhere: disable it in its source directory by hand
   now, and say so in the record.
3. Open the offboarding operation. Assign it to yourself with priority
   `critical` and a due time
   (`PATCH /api/admin/lifecycle-operations/:id/assignment`), so the
   maintenance job mails the owner and the overdue alert has a clock.
4. **Compensate at the target by hand.** Syntra cannot reach Entra and cannot
   queue the work. Disable the account in Entra directly (or in AD for an AD
   target). This is the point of the exercise: knowing who has that access
   and how long it takes.
5. Revoke anything Syntra fronts that the target does not cover: the
   person's application sessions are ended by the login deactivation; a
   relying party with back-channel logout is told when the sender runs,
   which needs the scheduler. Check `syntra_logout_deliveries_pending` after
   recovery and `SyntraUndeliveredLogout` if it never lands.
6. When the scheduler is back: **Retry operation**. When Graph is back: the
   receipts apply; the run's `disable_account` for this person is proposed
   and, on an auto-apply target, applied, or you apply just that action
   ([Target rollback, Procedure C](target-rollback.md#procedure-c-apply-part-of-a-run)).
   Syntra reconciles against the disable you did by hand and reports
   nothing to do for it.
7. Record the observed state. The API accepts an observation for the
   `targets` step (`POST /api/admin/lifecycle-operations/:id/observations`
   with expected and observed account state); the console page has no
   control for it, so this is a `curl` or it is a note in the record.
8. **Acknowledge work** once verified, so the overdue counter stops.

**Exit criteria.**

- Every login for the person shows `disabled` in the operation's
  `local-access` evidence, or the record names where it was disabled by
  hand.
- The person's account at every target is disabled, verified by reading the
  target, not by Syntra's belief.
- The lifecycle operation is `completed`, or acknowledged with a written
  reason why a step could not complete.
- `SyntraLifecycleWorkFailed` and `SyntraLifecycleWorkOverdue` have cleared.
- The record states the time from the HR call to "no access anywhere".

**Scorecard.**

| Question | Yes / No / Partial | Notes |
|---|---|---|
| Time from HR call to Syntra sessions revoked | | |
| Time from HR call to target account disabled by hand | | |
| Did the team know End employment works without the scheduler? | | |
| Did the team read each login's result rather than the banner? | | |
| Did someone have the standing access to disable the account in Entra directly? | | |
| Was the operation assigned an owner and due time? | | |
| Was the back-channel logout delivery checked after recovery? | | |
| Gaps found in product or runbook | | |

## Verification of the exercise itself

An exercise is complete when the scorecards are filled in, every "No" has an
owner and a date, and product gaps have been filed against the repository.

## What this does not cover

- Live fault injection. These are paper exercises; a real Graph outage or a
  real secret expiry in a lab is a separate, planned test.
- Scenarios outside these four. Extend this file when a real incident
  teaches a fifth.
