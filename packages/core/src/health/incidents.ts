import type { TenantClient } from '@syntra/db';

/**
 * Everything in this tenant that has quietly stopped working.
 *
 * **The problem this solves is not that the failures are invisible — it is
 * that they are visible in six different places.** A dead webhook receiver is
 * on the webhooks page, a mail server that stopped answering is a column on
 * the outbox, a provisioning target whose bind credential was rotated is a
 * badge on the targets list, a delegated task that keeps erroring is behind an
 * Activity button. Each of those screens is somewhere an administrator goes
 * for a reason, and none of them is somewhere they go to ask "is anything
 * wrong". So nothing was, until somebody complained.
 *
 * Every entry here is something that has ALREADY given up or is measurably
 * overdue — never a warning about something that might go wrong later. A list
 * that mixes the two is a list people stop reading.
 */

export type IncidentKind =
  | 'webhook_undelivered'
  | 'notification_undelivered'
  | 'target_runs_skipped'
  | 'target_never_completed'
  | 'provision_run_failed'
  | 'sync_run_failed'
  | 'task_failing';

export type IncidentSeverity = 'critical' | 'warning';

export interface Incident {
  kind: IncidentKind;
  severity: IncidentSeverity;
  /** What is wrong, named. Never a count on its own. */
  title: string;
  /** What follows from it, in one sentence. */
  detail: string;
  /** How many things are in this state. */
  count: number;
  /** The most recent time this was observed, where there is one. */
  lastAt: Date | null;
  /** Where in the console to go. A relative path. */
  href: string;
}

/** After this many attempts a webhook delivery has given up. Mirrors `WEBHOOK_MAX_ATTEMPTS`. */
const WEBHOOK_GIVEN_UP = 6;
/** Mirrors `OUTBOX_MAX_ATTEMPTS`. */
const OUTBOX_GIVEN_UP = 5;

/**
 * A target that has not completed a run in twice its own cadence.
 *
 * The same rule the targets list applies, and the same reason: `lastRunAt` is
 * written only by the transaction that records a FINISHED preview, so a target
 * whose runs all fail is a target whose timestamp has stopped moving. Two days
 * is the floor for a target with no schedule at all — those run by hand, and a
 * fortnight of silence on one is not news.
 */
const STALE_RUN_MS = 2 * 86_400_000;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Reads every failure signal in one transaction.
 *
 * Counts and one timestamp apiece, never the rows themselves: this is a
 * dashboard, and a page that loaded four thousand undelivered notifications to
 * tell somebody there are four thousand is a page that falls over exactly when
 * it is most needed.
 */
export async function listIncidents(tx: TenantClient, now: Date): Promise<Incident[]> {
  const incidents: Incident[] = [];

  // --- Webhooks that gave up -------------------------------------------
  const webhookDead = await tx.webhookDelivery.aggregate({
    where: { deliveredAt: null, attempts: { gte: WEBHOOK_GIVEN_UP } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  if (webhookDead._count._all > 0) {
    const n = webhookDead._count._all;
    incidents.push({
      kind: 'webhook_undelivered',
      // Critical: an integration that has stopped receiving is one whose owner
      // believes it is still receiving. Nothing else tells them otherwise.
      severity: 'critical',
      title: `${n} ${plural(n, 'webhook was', 'webhooks were')} never delivered`,
      detail:
        'The receiving system has not been told about these, and no further attempt will be made.',
      count: n,
      lastAt: webhookDead._max.createdAt,
      href: '/admin/webhooks',
    });
  }

  // --- Mail that gave up -------------------------------------------------
  const mailDead = await tx.notificationOutbox.aggregate({
    where: { sentAt: null, attempts: { gte: OUTBOX_GIVEN_UP } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  if (mailDead._count._all > 0) {
    const n = mailDead._count._all;
    incidents.push({
      kind: 'notification_undelivered',
      // Critical for the reason `NEVER_DIGESTED` exists: the traffic that
      // matters is the traffic saying something is stuck, and an approver who
      // was never told is a request nobody is working on.
      severity: 'critical',
      title: `${n} ${plural(n, 'message was', 'messages were')} never sent`,
      detail:
        'Somebody was meant to be told something and was not — an approval waiting, a reset link, a failure.',
      count: n,
      lastAt: mailDead._max.createdAt,
      href: '/admin/automate/requests',
    });
  }

  // --- Targets ------------------------------------------------------------
  const targets = await tx.targetSystem.findMany({
    select: {
      id: true,
      name: true,
      enabled: true,
      schedule: true,
      lastRunAt: true,
      consecutiveSkippedRuns: true,
      lastSkippedAt: true,
    },
  });

  const skipped = targets.filter((t) => t.consecutiveSkippedRuns > 0);
  if (skipped.length > 0) {
    incidents.push({
      kind: 'target_runs_skipped',
      severity: 'critical',
      title: `${skipped.length} ${plural(skipped.length, 'target has', 'targets have')} skipped scheduled runs`,
      // Ruling P4's whole point: a target that has skipped repeatedly must be
      // visibly distinguishable from one running cleanly.
      detail: `${skipped.map((t) => t.name).join(', ')} — a run was due and did not start.`,
      count: skipped.length,
      lastAt: skipped.reduce<Date | null>(
        (latest, t) =>
          t.lastSkippedAt && (latest === null || t.lastSkippedAt > latest) ? t.lastSkippedAt : latest,
        null,
      ),
      href: '/admin/targets',
    });
  }

  const stale = targets.filter(
    (t) =>
      t.enabled &&
      t.schedule !== null &&
      t.consecutiveSkippedRuns === 0 &&
      (t.lastRunAt === null || now.getTime() - t.lastRunAt.getTime() > STALE_RUN_MS),
  );
  if (stale.length > 0) {
    incidents.push({
      kind: 'target_never_completed',
      severity: 'critical',
      title: `${stale.length} scheduled ${plural(stale.length, 'target has', 'targets have')} not completed a run`,
      // `lastRunAt` moves only when a preview FINISHES. A rotated bind
      // credential starts a run every night and finishes none, which resets
      // the skip counter and leaves this as the only signal.
      detail: `${stale.map((t) => t.name).join(', ')} — runs are starting and not finishing.`,
      count: stale.length,
      lastAt: stale.reduce<Date | null>(
        (latest, t) => (t.lastRunAt && (latest === null || t.lastRunAt > latest) ? t.lastRunAt : latest),
        null,
      ),
      href: '/admin/targets',
    });
  }

  // --- Runs that failed outright -----------------------------------------
  const failedProvision = await tx.provisionRun.aggregate({
    where: { status: 'failed', startedAt: { gt: new Date(now.getTime() - 7 * 86_400_000) } },
    _count: { _all: true },
    _max: { startedAt: true },
  });
  if (failedProvision._count._all > 0) {
    const n = failedProvision._count._all;
    incidents.push({
      kind: 'provision_run_failed',
      severity: 'warning',
      title: `${n} provisioning ${plural(n, 'run', 'runs')} failed this week`,
      detail: 'Nothing was applied by these runs. Accounts are as they were.',
      count: n,
      lastAt: failedProvision._max.startedAt,
      href: '/admin/provision-runs',
    });
  }

  const failedSync = await tx.syncRun.aggregate({
    where: { status: 'failed', startedAt: { gt: new Date(now.getTime() - 7 * 86_400_000) } },
    _count: { _all: true },
    _max: { startedAt: true },
  });
  if (failedSync._count._all > 0) {
    const n = failedSync._count._all;
    incidents.push({
      kind: 'sync_run_failed',
      severity: 'warning',
      title: `${n} directory ${plural(n, 'sync', 'syncs')} failed this week`,
      // Upstream of everything: a stale person register is what the guards
      // refuse a run over.
      detail: 'The person register may be out of date, which every other decision rests on.',
      count: n,
      lastAt: failedSync._max.startedAt,
      href: '/admin/sync-runs',
    });
  }

  // --- Delegated tasks erroring ------------------------------------------
  //
  // `failure` only. A `refused` run is the escalation guard working, and
  // listing it as an incident would train people to ignore the one signal
  // that means somebody tried to reach further than they should.
  const failedTasks = await tx.delegatedTaskRun.aggregate({
    where: { outcome: 'failure', createdAt: { gt: new Date(now.getTime() - 7 * 86_400_000) } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  if (failedTasks._count._all > 0) {
    const n = failedTasks._count._all;
    incidents.push({
      kind: 'task_failing',
      severity: 'warning',
      title: `${n} delegated ${plural(n, 'task run', 'task runs')} failed this week`,
      detail:
        'Somebody on the service desk asked for something and did not get it.',
      count: n,
      lastAt: failedTasks._max.createdAt,
      href: '/admin/automate/tasks',
    });
  }

  // Critical first, then most recent. Somebody opening this page is asking
  // "what is worst", and within that "what just happened".
  const rank = (s: IncidentSeverity) => (s === 'critical' ? 0 : 1);
  return incidents.sort(
    (a, b) => rank(a.severity) - rank(b.severity) || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0),
  );
}
