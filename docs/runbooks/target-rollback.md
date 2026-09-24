# Target rollback

## Purpose

Stop a provisioning target from doing anything further, deal with a run that
is wrong or blocked, and put back what a bad mover changed. It also states,
precisely, what Provision cannot undo and why the product never deletes.

The controls are in `packages/core/src/provision/guard.ts` (thresholds),
`target-service.ts` (target settings and schedule),
`apply.ts` (how actions end), and the routes in
`apps/api/src/routes/admin/targets.ts` and `provision-runs.ts`.

## When to use

- A run proposes far more than expected, or a run was applied and should
  not have been.
- A target must be frozen during an outage at the other end.
- A mover (a contract change) put the wrong access on somebody, or removed
  the right access.
- A target's credential was rotated or expired and runs are failing.

## Prerequisites

- An administrator with `provision.read` to look and `provision.manage` to
  act. Mover apply additionally needs `identity.write`.
- The target's id (from **Target systems**, or `GET /api/admin/targets`).
- The vocabulary:
  - **Run**: `POST /api/admin/targets/:id/runs` enqueues one; it reads the
    target, computes a plan, and lands in status `previewed` or `blocked`.
    Applying moves it through `applying` to `applied` or
    `partially_applied`; a run that could not read the target is `failed`.
    Starting a new run marks earlier `previewed` and `blocked` runs on the
    same target `failed` with the error `superseded by a later run`, and
    their `proposed` actions `superseded`.
  - **Action**: one row per proposed change, in `sequence` order:
    `create_account`, `update_account`, `enable_account`, `disable_account`,
    `archive_account`, `rename_account`, `grant_entitlement`,
    `revoke_entitlement`, `deactivate_syntra_user`,
    `reactivate_syntra_user`, and `create_container`. The schema comment on
    `ProvisionAction.actionType` reads: **there is no delete of any kind, and
    no type that could become one.**
  - **Action status**: `proposed`, `in_flight`, `applied`, `failed`,
    `conflict`, `pending_retry`, `superseded`.
  - **autoApply**: a scheduled run applies itself if, and only if, the guard
    did not block it. The scheduler never confirms anything.

## The blast-radius controls

The guard is a pure function of the plan and the counts; `autoApply` cannot
override it and there is no input that waives it. Each target carries these
settings (**Target systems → the target**, or `PATCH /api/admin/targets/:id`
with a `thresholds` object):

| Setting | What it limits | Refusal type |
|---|---|---|
| `createAccountThresholdPercent` | Creates as a share of accounts at the target | Confirmable |
| `disableAccountThresholdPercent` | Disables as a share of active accounts | Confirmable |
| `archiveAccountThresholdPercent` | Archives, **and container moves**, as a share of accounts | Confirmable |
| `revokeEntitlementThresholdPercent` | Revocations as a share of all holdings | Confirmable |
| `deactivateSyntraUserThresholdPercent` | Syntra-login deactivations as a share of linked active users | Confirmable |
| `perEntitlementThresholdPercent` | Revocations of **one** entitlement as a share of its holders at the target | Confirmable |
| `maxContainerCreatesPerRun` | Absolute cap on containers created | Confirmable |
| `personPopulationDropPercent` | Drop in persons with an active contract since the last run | **Not confirmable** |

Not confirmable either: a target that returned no accounts after a run has
ever been applied (an empty and an unreachable directory look the same), any
threshold that is not a valid percentage, and any axis whose denominator is
zero while the plan proposes work on it. A first run is always confirmed by a
person. The ladder settings (`disableGraceDays`,
`entitlementRevocationDelayDays`, `archiveAfterDays`,
`reenableWithoutConfirmationDays`, `renameEnabled`) set delays and mark a
re-enable outside its window, a rename, or a re-create of a vanished account
as `requiresConfirmation` on the action itself.

Additive actions (`enable_account`, `grant_entitlement`, `rename_account`,
`reactivate_syntra_user`, and attribute-only `update_account`) are not
guarded by a threshold: they are visible in the plan and reversible by the
next run.

## Procedure A: stop a target

Three levers, from least to most disruptive. All take effect on the
scheduler immediately because `updateTarget` re-applies the schedule after
every change (`packages/core/src/provision/jobs.ts`).

1. **Turn off auto-apply.** Runs still happen and produce plans; nothing is
   applied without a person.

   ```
   PATCH /api/admin/targets/:id   { "autoApply": false }
   ```

   Console: uncheck **Apply scheduled runs automatically**, Save.

2. **Unschedule.** No runs happen; the target stays enabled for manual
   **Run now**.

   ```
   PATCH /api/admin/targets/:id   { "schedule": null }
   ```

3. **Disable.** Unscheduled and marked disabled; the targets list shows
   `Disabled`; incidents stop counting it as stale.

   ```
   PATCH /api/admin/targets/:id   { "enabled": false }
   ```

   Console: uncheck **Enabled**, Save.

A disabled target loses nothing: accounts, entitlements, placements and run
history stay. Re-enabling restores the schedule that was saved.

### Emergency write stops: one target, or every target at once

The levers above change what runs. An **emergency write stop** changes what a
run may *do*: while it is active, no connector write is attempted, and every
apply is refused before the run enters `applying` — the run stays exactly as
previewed and can be applied unchanged later. Reads, previews, drift, and
evidence keep working, which is what the people investigating need. A manual
account move is refused too (its placement is still recorded); a scheduled
`autoApply` run records a visible skip instead of failing; a person
provisioning receipt is left `blocked` rather than `failed`.

There are two scopes with identical rules:

| Scope | Console | API (`provision.manage`) |
|---|---|---|
| One target | **Target systems → the target → External writes** | `POST /api/admin/targets/:id/external-write-stop` / `external-write-resume` |
| Every target in the tenant | **Target systems → Tenant-wide external writes** (top of the list) | `POST /api/admin/provision/external-write-stop` / `external-write-resume` |

`GET /api/admin/provision/external-write-stop` (`provision.read`) returns the
tenant stop's state.

- **Placing** a stop needs a `reason`, and may carry an `expiresAt` no more
  than 30 days out: `{ "reason": "Bad HR feed", "expiresAt": null }`.
- **Resuming** early needs a `reason` and a **different administrator** from
  the one who placed it (403 `four-eyes-required` otherwise), so the person
  whose judgement or session is in question cannot lift the containment alone.
- **Expiry** is honoured at the apply boundary the moment it passes. A
  once-a-minute sweep (`provision.write_stop_expiry`) then closes the stop and
  records who placed it and why.
- When both are active the **tenant** stop is the one a refusal names (409
  `external-writes-paused` with `scope: "tenant"`), because it is the one that
  has to be lifted first.

Every transition is audited — `provision.{tenant,target}.external_writes.pause`,
`.resume`, and `.expire` (the last with no actor: the clock lifted it) — and
each is a security event, so a webhook endpoint subscribed to **Emergency
write stops** is notified of all six (see
[Getting them out](../configure.md#getting-them-out)).

Stopping the API still stops everything, including sync and mail retries;
the tenant stop is the lever that contains writes while leaving everything
else running.

**Deleting** a target (`DELETE /api/admin/targets/:id?confirm=true`) removes
Syntra's record of the accounts it manages and never touches the accounts
themselves; it is not a rollback and there is no undelete.

## Procedure B: a run that should not be applied

1. Open it: **Target systems → the target → Runs → the run**, or
   `GET /api/admin/targets/:id/runs/:runId`. Actions are listed in the order
   apply would use, each with the person's name and, where the guard
   demanded it, `requiresConfirmation`.
2. If it is `previewed` or `blocked`, **do nothing**. There is no cancel
   route; an unapplied run applies nothing, and the next run on the target
   supersedes it. If the target is scheduled with `autoApply` and the run is
   `previewed`, the next scheduled run will compute a fresh plan and apply
   that one; stop the target first (Procedure A) if the fresh plan would be
   the same wrong plan.
3. If it is `blocked` with `requiresConfirmation: true`, read `blockedReason`.
   Confirming is `POST /api/admin/targets/:id/runs/:runId/apply` with
   `{ "confirm": true }`; the console shows a checkbox and the numbers. Do
   not confirm a run you have not read to the end.
4. If it is `blocked` with `requiresConfirmation: false`, it cannot be
   applied by anybody. The API answers 409 `run-unconfirmable`. Fix the cause
   (the HR feed, the target's reachability, a threshold that is not a
   percentage) and run again.

## Procedure C: apply part of a run

`POST /api/admin/targets/:id/runs/:runId/apply` with
`{ "only": ["<actionId>", …], "confirm": true }` when any chosen action
requires it. The console offers a checkbox per action and a button reading
**Apply N actions**. Applying part of a run **ends it**: anything left
unticked is not attempted, the run finishes `partially_applied`, and the next
run proposes again whatever the world still wants.

Use this to let the leaver's disable through while holding a hundred
questionable revocations.

## Procedure D: a run that was applied and was wrong

Nothing an apply does is a delete, so every applied action has an inverse the
next run can propose once the inputs are corrected:

| Applied | Inverse the next run proposes when the inputs say so |
|---|---|
| `disable_account` | `enable_account` (requires confirmation if outside `reenableWithoutConfirmationDays`) |
| `archive_account` (a container move) | `update_account` moving it back, guarded by the archive threshold |
| `revoke_entitlement` | `grant_entitlement`, unguarded |
| `grant_entitlement` | `revoke_entitlement`, guarded |
| `deactivate_syntra_user` | `reactivate_syntra_user` |
| `create_account` | Nothing removes it; it can be disabled |
| `update_account` (attributes) | Another `update_account` |
| `create_container` | Nothing removes it |

The sequence is therefore: correct the inputs, run, review, apply.

## Procedure E: reverting a mover

A mover is a contract change (department, job title, cost centre, employer,
location, manager, FTE) that changes which business rules match a person
and therefore what the next run proposes. It arrives by an HR import, by
**Change employment** on the person page (`POST /api/admin/persons/:id/mover/preview`
then `/mover/apply`, which creates a `move` lifecycle operation), or by
editing a contract directly (`PATCH /api/admin/persons/:id/contracts/:sequence`).

1. **Stop the target** (Procedure A, at least `autoApply: false`) so nothing
   more is applied while you work.
2. **Find what was applied.** The run's actions, filtered to the person; or
   `GET /api/admin/audit?subject=<personId>` for `provision.action.*` events.
3. **Correct the HR data at its source.** If the feed was wrong, fix the
   feed and re-run the import (`POST /api/admin/person-sources/:id/run`,
   review the preview, apply). If a contract was edited by hand, edit it
   back with the same route. If the change came through **Change
   employment**, use it again with the previous values: **Preview change**
   shows the field-level diff and the access it would retain before
   anything is saved. The apply is refused with 409 `stale-preview` if the
   person changed since the preview.
4. **If the rule was wrong**, not the data: **Target systems → the target →
   Business rules**. `POST /api/admin/targets/:id/rules/impact` previews how
   many persons a condition matches before it is saved with
   `PUT /api/admin/targets/:id/rules`. A rule that previews as matching zero
   persons after a change is usually a malformed condition, not an empty
   population; the closed condition schema refuses malformed ones with a
   400.
5. **Run now**, read the plan. Expect `enable_account` and
   `grant_entitlement` actions for what the mover removed; expect
   `revoke_entitlement` for what it wrongly granted, and expect the
   per-entitlement threshold to block if that revocation is a large share of
   one group.
6. **Apply**, whole or in part (Procedure C).
7. **If the person was deactivated as a leaver in error**:
   `POST /api/admin/persons/:id/reactivate`, then run. `deactivate_syntra_user`
   is reversed by `reactivate_syntra_user`; sessions that were revoked stay
   revoked and the person signs in again.
8. **Verify** on the person: `GET /api/admin/persons/:id/access` and the
   target account's entitlements match what the corrected rules say.
9. **Restore the target's schedule and auto-apply.**

## Procedure F: a credential that stopped working

Runs start and fail; `lastRunAt` stops moving; after two days (or twice the
cadence) `target_never_completed` appears in incidents. Replace the
credential per [Secret rotation, Procedure E](secret-rotation.md#procedure-e-a-provisioning-target-credential-including-an-entra-client-secret),
then **Run now**. Actions left `pending_retry` by earlier runs are picked up
by the next run if the plan still wants them; actions left `in_flight` by a
process that died are resolved by the next run asking the target what
actually happened (`resolveInFlightActions`).

## Verification

- `GET /api/admin/targets/:id` shows the `enabled`, `schedule` and
  `autoApply` values you intended, and `consecutiveSkippedRuns` is 0 after
  the next scheduled elapse.
- The latest run is `applied`, or `partially_applied` with every unapplied
  action carrying a message you expected.
- `GET /api/admin/targets/:id/drift` has no new `open` findings you cannot
  explain; acknowledge the ones you can (`PATCH /api/admin/drift/:id`).
- `GET /api/admin/incidents` no longer lists the target.

## Rollback

Every step in this runbook is itself reversible through the same routes:
re-enable, re-schedule, re-run. The one exception is an apply; its rollback
is Procedure D.

## What cannot be undone, and why the product never deletes

- **Provision never deletes anything at a target.** The AD connector refuses
  a delete before it binds; Entra's document has no archive because Graph's
  only removal is `DELETE /users/{id}` and the connector cannot express it.
  Archiving means moving to a container (AD) or `accountEnabled: false`
  (Entra). What happens afterwards is the target's own decision: in the lab
  a scheduled task on the domain controller deletes archived accounts after
  thirty days, with the AD Recycle Bin as the safety net
  (`docs/lab/README.md`, section 2.5). That is outside Syntra by design: an
  unrecoverable write driven by a timer from a service holding bind
  credentials for every tenant's directory is a bad trade.
- **The one delete that exists** is a directory write-back delete of a
  Syntra login: `DELETE /api/admin/users/:id`, gated on `directory.delete`
  and on the source's `writebackEnabled` and `writebackDelete` flags, both
  off by default. The directory object goes first; Syntra's row follows only
  if that succeeded; the Person and their contracts stay so the audit log
  still answers "who held what". It cannot be undone from Syntra.
- **Initial passwords** delivered on a create are not retrievable; a
  re-created account gets a new one.
- **Revoked sessions and tokens** stay revoked.
- **The audit log** is append-only. A restore is the only thing that removes
  entries, and it removes everything after the backup.
- **Data applied to the target between a backup and a restore** is not in
  the backup; after a restore, run each target and read the plan before
  applying so that Syntra catches up with the target rather than the target
  being pulled back to Syntra's older belief.
