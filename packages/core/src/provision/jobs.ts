import { withTenant } from '@syntra/db';
import type { TargetConnector } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { Transport } from '../notify/notification-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { applyProvisionRun } from './apply.js';
import { ProvisionRunInFlightError, previewProvisionRun } from './run-service.js';
import { claimSyntraUsers, enqueuePairedSync } from './syntra-user.js';

export const PROVISION_JOB = 'provision.run';

export interface ProvisionJobPayload {
  tenantId: string;
  targetSystemId: string;
}

/** A background job has no request and therefore no bound tenant. */
export function provisionJobPayload(
  tenantId: string,
  targetSystemId: string,
): ProvisionJobPayload {
  return { tenantId, targetSystemId };
}

/**
 * The schedule key for one target on the shared `provision.run` queue.
 *
 * pg-boss keys its schedule table on `(queue name, key)`, and `key` defaults
 * to the empty string — so without this, every target scheduled on this queue
 * writes the same row and only the last one survives. That exact bug shipped
 * once on the sync queue: all sources shared `key: ''` and only the last one
 * in the last tenant ever ran. The tenant is in the key as well as the target
 * because the schedule table is where anyone debugging a schedule that did not
 * fire will be looking.
 */
export function provisionScheduleKey(
  tenantId: string,
  targetSystemId: string,
): string {
  return `${tenantId}/${targetSystemId}`;
}

/** What scheduling a target needs to know about it. */
export interface SchedulableTarget {
  id: string;
  schedule: string | null;
  enabled: boolean;
}

/**
 * Brings the scheduler into line with one target's current settings.
 *
 * Called at boot for every target, and again on every create, update and
 * delete — without which a target created with a cron expression is not
 * scheduled until the process restarts, and one whose schedule was cleared
 * keeps running on the old one.
 *
 * A target that is disabled or has no cron expression is **unscheduled rather
 * than skipped**. Skipping would be right only if it had never been scheduled;
 * for a target that just had `enabled` turned off it would leave the old
 * schedule firing against a target the administrator believes is stopped.
 * The empty string counts as no cron expression for the same reason it counts
 * as no pattern everywhere else on this slice: it is not an expression, and
 * pg-boss would either refuse it or store a schedule nobody wrote.
 */
export async function applyTargetSchedule(
  scheduler: Scheduler,
  tenantId: string,
  target: SchedulableTarget,
): Promise<void> {
  const key = provisionScheduleKey(tenantId, target.id);

  if (!target.enabled || !target.schedule) {
    await scheduler.unschedule(PROVISION_JOB, key);
    return;
  }

  await scheduler.schedule(
    PROVISION_JOB,
    target.schedule,
    provisionJobPayload(tenantId, target.id),
    key,
  );
}

/** Removes a deleted target's schedule, so it cannot fire against nothing. */
export async function removeTargetSchedule(
  scheduler: Scheduler,
  tenantId: string,
  targetSystemId: string,
): Promise<void> {
  await scheduler.unschedule(
    PROVISION_JOB,
    provisionScheduleKey(tenantId, targetSystemId),
  );
}

/**
 * The four statuses `provision_run_one_non_terminal` covers, verbatim.
 *
 * Kept identical to `run-service.ts`'s own list and to the migration. A status
 * the index constrains and this list omits is a target the scheduler keeps
 * firing at while every create is refused, recording nothing — so a target
 * unrunnable since a crash would look exactly like one running cleanly, which
 * is precisely what Ruling P4 forbids.
 */
const NON_TERMINAL = ['running', 'previewed', 'blocked', 'applying'] as const;

/** The two that mean "a person has been asked something and has not answered". */
const AWAITING_REVIEW: readonly string[] = ['previewed', 'blocked'];

/**
 * How long a `running` or `applying` run may sit before it is treated as the
 * wreckage of a dead process rather than as work in progress.
 *
 * This exists because the skip rule and the partial unique index together can
 * recreate the defect the index has already caused twice on this programme: a
 * "one non-terminal row per target" index whose stale rows nothing clears.
 * `previewProvisionRun` has the supersession path — it adopts every
 * non-terminal run before it starts a new one — but a skip check that refuses
 * to call it for *any* `running` row means a process killed in phase 4 leaves
 * that row behind for ever and the schedule never runs again. The counter
 * would make that visible, which is Ruling P4 satisfied; it would not make it
 * recoverable without a human pressing a button, which is not.
 *
 * Six hours, and the direction of the error is deliberate. Too short and a
 * genuinely long run is adopted out from under a live process; too long and a
 * crashed target waits, loudly counting skips, for a recovery that is coming.
 * Six hours is longer than any single directory read or apply this system has
 * been measured doing and shorter than the interval at which a nightly
 * schedule would notice.
 *
 * It applies **only** to `running` and `applying`. A `previewed` or `blocked`
 * run is somebody's outstanding decision, not wreckage: ageing one out would
 * silently supersede a plan a person was asked to approve, which is the whole
 * reason the skip rule exists.
 */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

export interface RunProvisionJobOptions {
  /**
   * The connector to run against. Every other entry point in this plan takes
   * one; without it here, the job's own tests reach for a real domain
   * controller, `previewProvisionRun` marks the run failed and rethrows, and
   * every assertion after the call is unreachable.
   */
  connector?: TargetConnector<never>;
  /**
   * How a created account's initial password is delivered.
   *
   * An unattended `autoApply` run creates accounts, and without a transport
   * here every one of those passwords is sealed into the vault and delivered
   * to nobody — which is the whole of Ruling P12 reintroduced on the one path
   * where no human is watching. `registerProvisionJobs` takes it and passes it
   * down; `applyProvisionRun` carries it to `applyOneAction` and on to
   * `finish`, which is where the message is queued.
   */
  transport?: Transport;
  /** Injected only by tests. The default is the real function. */
  preview?: typeof previewProvisionRun;
  /** Injected only by tests. The default is the real function. */
  apply?: typeof applyProvisionRun;
}

/**
 * Records a skipped scheduled run where somebody looks.
 *
 * Ruling P4: on the target's own row, which the targets list and the target's
 * screen both render — not only in an audit event. The audit event is written
 * as well, and in addition rather than instead.
 *
 * One short transaction: an increment, a timestamp, a reason and the event.
 * No network and no read of the target.
 */
async function recordSkip(
  tenantId: string,
  targetSystemId: string,
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        consecutiveSkippedRuns: { increment: 1 },
        lastSkippedAt: new Date(),
        lastSkipReason: reason,
      },
    });
    await recordEvent(tx, {
      actorUserId: null,
      action: 'provision.run.skipped',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'failure',
      sourceIp: null,
      payload: { reason, ...detail },
    });
  });
}

/**
 * One scheduled provisioning run.
 *
 * **A scheduled run does not start while a run is awaiting review**, and the
 * skip is recorded where somebody looks: `consecutiveSkippedRuns`,
 * `lastSkippedAt` and `lastSkipReason` on the target's own row, which the
 * targets list and the target's screen both render (Ruling P4). Without the
 * skip rule, `previewProvisionRun` would supersede the blocked run somebody
 * was asked to approve, every night, so the review screen would become a thing
 * people stop opening. Without the counter, a target that has silently skipped
 * for a fortnight looks exactly like one running cleanly.
 *
 * The guard is not advisory here either. A blocked run does not apply, and
 * `autoApply` does not override it — an unattended schedule is exactly the
 * case it exists for. Note what is **not** passed to the apply: no `confirm`
 * and no `confirmedByUserId`. Ruling P25's non-confirmable verdicts include
 * "no persons hold an active contract at all" and "the target returned no
 * accounts at all", and a scheduled run must be at least as strict as a human
 * one, never less.
 */
export async function runProvisionJob(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  payload: ProvisionJobPayload,
  options: RunProvisionJobOptions = {},
): Promise<void> {
  const preview = options.preview ?? previewProvisionRun;
  const apply = options.apply ?? applyProvisionRun;
  const connectorOption =
    options.connector === undefined ? {} : { connector: options.connector };

  const decision = await withTenant(payload.tenantId, async (tx) => {
    const target = await tx.targetSystem.findUnique({
      where: { id: payload.targetSystemId },
    });
    // A target that is gone or switched off is not a target that is failing to
    // run, so neither case counts as a skip: the counter is the one signal
    // Ruling P4 leans on, and firing it for the cases nobody needs telling
    // about is how a signal stops being read.
    if (!target || !target.enabled) return { proceed: false as const };

    const inFlight = await tx.provisionRun.findFirst({
      where: {
        targetSystemId: payload.targetSystemId,
        status: { in: [...NON_TERMINAL] },
      },
      orderBy: { startedAt: 'desc' },
    });

    if (inFlight) {
      const awaitingReview = AWAITING_REVIEW.includes(inFlight.status);
      const ageMs = Date.now() - inFlight.startedAt.getTime();
      // Wreckage, not work: the process that owned this run is not coming
      // back, and `previewProvisionRun` adopts it. Never for a run awaiting a
      // human decision, however old.
      const abandoned = !awaitingReview && ageMs >= STALE_RUN_MS;

      if (!abandoned) {
        const reason = awaitingReview
          ? `a run from ${inFlight.startedAt.toISOString()} is awaiting review (${inFlight.status}), so this scheduled run did not start`
          : `a run from ${inFlight.startedAt.toISOString()} is still in progress (${inFlight.status}), so this scheduled run did not start`;
        await tx.targetSystem.update({
          where: { id: payload.targetSystemId },
          data: {
            consecutiveSkippedRuns: { increment: 1 },
            lastSkippedAt: new Date(),
            lastSkipReason: reason,
          },
        });
        await recordEvent(tx, {
          actorUserId: null,
          action: 'provision.run.skipped',
          targetType: 'TargetSystem',
          targetId: payload.targetSystemId,
          outcome: 'failure',
          sourceIp: null,
          payload: { reason, blockedRunId: inFlight.id, status: inFlight.status },
        });
        return { proceed: false as const };
      }
    }

    // A run is actually starting, so the skip streak is over.
    await tx.targetSystem.update({
      where: { id: payload.targetSystemId },
      data: {
        consecutiveSkippedRuns: 0,
        lastSkippedAt: null,
        lastSkipReason: null,
      },
    });
    return { proceed: true as const, autoApply: target.autoApply };
  });

  if (!decision.proceed) return;

  let run;
  try {
    run = await preview(payload.tenantId, provider, payload.targetSystemId, {
      ...connectorOption,
    });
  } catch (cause) {
    // The check above and the create inside `previewProvisionRun` are in
    // different transactions, so another process can start a run between them.
    // The partial unique index refuses the second one — which is correct — and
    // this records it the same loud way rather than letting an opaque Prisma
    // error fail the job and be retried into the same refusal.
    if (cause instanceof ProvisionRunInFlightError) {
      await recordSkip(payload.tenantId, payload.targetSystemId, cause.message);
      return;
    }
    throw cause;
  }

  if (decision.autoApply && run.status === 'previewed') {
    const result = await apply(payload.tenantId, provider, run.id, {
      ...connectorOption,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    if (result.applied > 0) {
      await claimSyntraUsers(payload.tenantId, payload.targetSystemId);
      // A freshly provisioned person cannot sign in until the next directory
      // sync; this is the cheap mitigation.
      await enqueuePairedSync(scheduler, payload.tenantId, payload.targetSystemId);
    }
  }
}

/**
 * Wires the `provision.run` queue to `runProvisionJob`.
 *
 * The transport is **not optional at this seam**. An unattended `autoApply`
 * run creates accounts, and a job registered without one seals every initial
 * password into the vault and delivers it to nobody. The scheduled path is
 * where a missing delivery goes unnoticed longest, so it is the one place the
 * option is required rather than defaulted.
 *
 * `seams` exists so a test can prove what this registration passes actually
 * arrives at the callee — the defect this programme has now seen three times
 * is a registration that wires one option and drops it at the next hop.
 * Production passes nothing here, so the real connector and the real preview
 * and apply are used.
 */
export function registerProvisionJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  transport: Transport,
  seams: Omit<RunProvisionJobOptions, 'transport'> = {},
): void {
  scheduler.register<ProvisionJobPayload>(PROVISION_JOB, (payload) =>
    runProvisionJob(scheduler, provider, payload, { ...seams, transport }),
  );
}
