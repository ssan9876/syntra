import { scrubText } from '@syntra/connectors';
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
  | 'scheduler_unavailable'
  | 'webhook_undelivered'
  | 'notification_undelivered'
  | 'target_runs_skipped'
  | 'target_never_completed'
  | 'provision_run_failed'
  | 'sync_run_failed'
  | 'task_failing'
  | 'credential_expired';

export type IncidentSeverity = 'critical' | 'warning';

/**
 * One thing behind an incident: the run that failed, the webhook that was
 * never delivered, the target that keeps skipping -- with the error it gave.
 *
 * `detail` is the stored error put through `scrubText`, which removes
 * credentials, addresses, DNs and long opaque tokens and bounds the length.
 * "14 runs failed" is a count; "Snipe-IT: 401 Unauthorized" is something an
 * administrator can act on, and was the difference asked for.
 */
export interface IncidentItem {
  /** What it is: a target, source, endpoint or credential, by name. */
  label: string;
  /** What went wrong, scrubbed. Null where nothing was recorded. */
  detail: string | null;
  at: Date | null;
  /** Where that one thing is in the console. */
  href: string | null;
}

export interface IncidentAcknowledgement {
  at: Date;
  byUserId: string | null;
  note: string | null;
}

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
  /** The individual failures, newest first, at most `ITEM_LIMIT`. */
  items: IncidentItem[];
  /**
   * Whether "resolved" means anything for this kind.
   *
   * An EVENT -- a run that failed, a message never sent -- is over once it has
   * happened, so resolving it is a watermark: only newer ones count. A
   * CONDITION -- a target skipping its runs, an expired credential -- is still
   * true until somebody fixes it, and disappears on its own when they do.
   * Offering "resolve" on a condition would be offering to hide a problem that
   * is still there, so a condition can be acknowledged and nothing else.
   */
  resolvable: boolean;
  /**
   * Somebody said they are handling it. Null once something newer has
   * happened since, so a fresh failure is never hidden behind an old answer.
   */
  acknowledged: IncidentAcknowledgement | null;
}

export const INCIDENT_KINDS: readonly IncidentKind[] = [
  'scheduler_unavailable',
  'webhook_undelivered',
  'notification_undelivered',
  'target_runs_skipped',
  'target_never_completed',
  'provision_run_failed',
  'sync_run_failed',
  'task_failing',
  'credential_expired',
];

export const RESOLVABLE_INCIDENTS: readonly IncidentKind[] = [
  'webhook_undelivered',
  'notification_undelivered',
  'provision_run_failed',
  'sync_run_failed',
  'task_failing',
];

const WEBHOOK_GIVEN_UP = 6;
const OUTBOX_GIVEN_UP = 5;
const STALE_RUN_MS = 2 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;
const ITEM_LIMIT = 10;
const DETAIL_MAX = 300;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const scrub = (text: string | null | undefined): string | null =>
  text === null || text === undefined || text.trim() === '' ? null : scrubText(text.trim(), DETAIL_MAX);

const latest = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((max, d) => (d && (max === null || d > max) ? d : max), null);

interface StoredState {
  kind: string;
  acknowledgedAt: Date | null;
  acknowledgedById: string | null;
  acknowledgeNote: string | null;
  resolvedAt: Date | null;
}

/** The later of the start of the window and the last resolution. */
const since = (windowStart: Date | null, state: StoredState | undefined): Date | null => {
  const resolved = state?.resolvedAt ?? null;
  if (windowStart === null) return resolved;
  if (resolved === null) return windowStart;
  return resolved > windowStart ? resolved : windowStart;
};

export async function listIncidents(tx: TenantClient, now: Date): Promise<Incident[]> {
  const stored = await tx.incidentState.findMany();
  const stateOf = new Map<string, StoredState>(stored.map((row) => [row.kind, row]));
  const weekAgo = new Date(now.getTime() - WEEK_MS);

  type Draft = Omit<Incident, 'resolvable' | 'acknowledged'>;
  const drafts: Draft[] = [];

  // --- Webhooks that gave up -------------------------------------------
  {
    const after = since(null, stateOf.get('webhook_undelivered'));
    const where = {
      deliveredAt: null,
      attempts: { gte: WEBHOOK_GIVEN_UP },
      ...(after ? { createdAt: { gt: after } } : {}),
    };
    const n = await tx.webhookDelivery.count({ where });
    if (n > 0) {
      const rows = await tx.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ITEM_LIMIT,
        select: { createdAt: true, event: true, lastStatus: true, lastError: true, endpoint: { select: { name: true } } },
      });
      drafts.push({
        kind: 'webhook_undelivered',
        // Critical: an integration that has stopped receiving is one whose owner
        // believes it is still receiving. Nothing else tells them otherwise.
        severity: 'critical',
        title: `${n} ${plural(n, 'webhook was', 'webhooks were')} never delivered`,
        detail: 'The receiving system was not told, and no further attempt will be made.',
        count: n,
        lastAt: rows[0]?.createdAt ?? null,
        href: '/admin/settings?tab=webhooks',
        items: rows.map((row) => ({
          label: `${row.endpoint.name} · ${row.event}`,
          detail: [row.lastStatus === null ? null : `HTTP ${row.lastStatus}`, scrub(row.lastError)]
            .filter(Boolean)
            .join(' — ') || null,
          at: row.createdAt,
          href: '/admin/settings?tab=webhooks',
        })),
      });
    }
  }

  // --- Mail that gave up -------------------------------------------------
  {
    const after = since(null, stateOf.get('notification_undelivered'));
    const where = {
      sentAt: null,
      attempts: { gte: OUTBOX_GIVEN_UP },
      ...(after ? { createdAt: { gt: after } } : {}),
    };
    const n = await tx.notificationOutbox.count({ where });
    if (n > 0) {
      // The template, never the recipient: an address is personal data and
      // the template says what kind of message went missing.
      const rows = await tx.notificationOutbox.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ITEM_LIMIT,
        select: { createdAt: true, template: true, lastError: true },
      });
      drafts.push({
        kind: 'notification_undelivered',
        severity: 'critical',
        title: `${n} ${plural(n, 'message was', 'messages were')} never sent`,
        detail: 'Somebody was meant to be told something and was not.',
        count: n,
        lastAt: rows[0]?.createdAt ?? null,
        href: '/admin/operations',
        items: rows.map((row) => ({
          label: row.template,
          detail: scrub(row.lastError),
          at: row.createdAt,
          href: null,
        })),
      });
    }
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
      lastSkipReason: true,
    },
  });
  const targetName = new Map(targets.map((t) => [t.id, t.name]));

  const skipped = targets.filter((t) => t.consecutiveSkippedRuns > 0);
  if (skipped.length > 0) {
    drafts.push({
      kind: 'target_runs_skipped',
      severity: 'critical',
      title: `${skipped.length} ${plural(skipped.length, 'target has', 'targets have')} skipped scheduled runs`,
      detail: 'A run was due and did not start.',
      count: skipped.length,
      lastAt: latest(skipped.map((t) => t.lastSkippedAt)),
      href: '/admin/targets',
      items: skipped.map((t) => ({
        label: `${t.name} · ${t.consecutiveSkippedRuns} skipped`,
        detail: scrub(t.lastSkipReason),
        at: t.lastSkippedAt,
        href: `/admin/targets/${t.id}`,
      })),
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
    // `lastRunAt` moves only when a preview FINISHES. A rotated bind
    // credential starts a run every night and finishes none, so the latest
    // run's own error is the one worth showing.
    const items: IncidentItem[] = [];
    for (const t of stale) {
      const run = await tx.provisionRun.findFirst({
        where: { targetSystemId: t.id },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, error: true, blockedReason: true },
      });
      items.push({
        label: t.name,
        detail: scrub(run?.error ?? run?.blockedReason ?? null),
        at: run?.startedAt ?? t.lastRunAt,
        href: run ? `/admin/targets/${t.id}/runs/${run.id}` : `/admin/targets/${t.id}`,
      });
    }
    drafts.push({
      kind: 'target_never_completed',
      severity: 'critical',
      title: `${stale.length} scheduled ${plural(stale.length, 'target has', 'targets have')} not completed a run`,
      detail: 'Runs are starting and not finishing.',
      count: stale.length,
      lastAt: latest(stale.map((t) => t.lastRunAt)),
      href: '/admin/targets',
      items,
    });
  }

  // --- Runs that failed outright -----------------------------------------
  {
    const after = since(weekAgo, stateOf.get('provision_run_failed'))!;
    const where = { status: 'failed', startedAt: { gt: after } };
    const n = await tx.provisionRun.count({ where });
    if (n > 0) {
      const rows = await tx.provisionRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: ITEM_LIMIT,
        select: { id: true, targetSystemId: true, startedAt: true, error: true },
      });
      drafts.push({
        kind: 'provision_run_failed',
        severity: 'warning',
        title: `${n} provisioning ${plural(n, 'run', 'runs')} failed this week`,
        detail: 'Nothing was applied by these runs. Accounts are as they were.',
        count: n,
        lastAt: rows[0]?.startedAt ?? null,
        href: rows[0] ? `/admin/targets/${rows[0].targetSystemId}/runs` : '/admin/targets',
        items: rows.map((row) => ({
          label: targetName.get(row.targetSystemId) ?? 'Target system',
          detail: scrub(row.error),
          at: row.startedAt,
          href: `/admin/targets/${row.targetSystemId}/runs/${row.id}`,
        })),
      });
    }
  }

  {
    const after = since(weekAgo, stateOf.get('sync_run_failed'))!;
    const where = { status: 'failed', startedAt: { gt: after } };
    const n = await tx.syncRun.count({ where });
    if (n > 0) {
      const rows = await tx.syncRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: ITEM_LIMIT,
        select: { id: true, startedAt: true, error: true, source: { select: { name: true } } },
      });
      drafts.push({
        kind: 'sync_run_failed',
        severity: 'warning',
        title: `${n} directory ${plural(n, 'sync', 'syncs')} failed this week`,
        // Upstream of everything: a stale person register is what the guards
        // refuse a run over.
        detail: 'The person register may be out of date.',
        count: n,
        lastAt: rows[0]?.startedAt ?? null,
        href: '/admin/sources?tab=runs',
        items: rows.map((row) => ({
          label: row.source.name,
          detail: scrub(row.error),
          at: row.startedAt,
          href: `/admin/sync-runs/${row.id}`,
        })),
      });
    }
  }

  // --- Delegated tasks erroring ------------------------------------------
  //
  // `failure` only. A `refused` run is the escalation guard working, and
  // listing it as an incident would train people to ignore the one signal
  // that means somebody tried to reach further than they should.
  {
    const after = since(weekAgo, stateOf.get('task_failing'))!;
    const where = { outcome: 'failure', createdAt: { gt: after } };
    const n = await tx.delegatedTaskRun.count({ where });
    if (n > 0) {
      const rows = await tx.delegatedTaskRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ITEM_LIMIT,
        select: { createdAt: true, message: true, task: { select: { name: true } } },
      });
      drafts.push({
        kind: 'task_failing',
        severity: 'warning',
        title: `${n} delegated ${plural(n, 'task run', 'task runs')} failed this week`,
        detail: 'Somebody on the service desk asked for something and did not get it.',
        count: n,
        lastAt: rows[0]?.createdAt ?? null,
        href: '/admin/requests?tab=tasks',
        items: rows.map((row) => ({
          label: row.task.name,
          detail: scrub(row.message),
          at: row.createdAt,
          href: '/admin/requests?tab=tasks',
        })),
      });
    }
  }

  // --- Credentials past their expiry -------------------------------------
  // An expired credential is not a warning about later: whatever depends on it
  // fails at its next use.
  {
    const rows = await tx.credentialRecord.findMany({
      where: { effectiveExpiresAt: { lte: now } },
      orderBy: { effectiveExpiresAt: 'desc' },
      select: { credentialKey: true, kind: true, effectiveExpiresAt: true, discoveryMessage: true },
    });
    if (rows.length > 0) {
      const n = rows.length;
      drafts.push({
        kind: 'credential_expired',
        severity: 'critical',
        title: `${n} ${plural(n, 'credential has', 'credentials have')} expired`,
        detail: 'Whatever depends on it fails at its next use.',
        count: n,
        lastAt: rows[0]?.effectiveExpiresAt ?? null,
        href: '/admin/settings?tab=credentials',
        items: rows.slice(0, ITEM_LIMIT).map((row) => ({
          label: `${row.credentialKey} · ${row.kind}`,
          detail: scrub(row.discoveryMessage),
          at: row.effectiveExpiresAt,
          href: '/admin/settings?tab=credentials',
        })),
      });
    }
  }

  const incidents = drafts.map((draft) => withState(draft, stateOf.get(draft.kind)));

  // Critical first, then most recent. Somebody opening this page is asking
  // "what is worst", and within that "what just happened".
  const rank = (s: IncidentSeverity) => (s === 'critical' ? 0 : 1);
  return incidents.sort(
    (a, b) => rank(a.severity) - rank(b.severity) || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0),
  );
}

/**
 * Attaches what somebody said about the incident, if it still applies.
 *
 * An acknowledgement stands only while nothing newer has happened: an
 * incident whose `lastAt` is after the acknowledgement is a new failure, and
 * reads as unacknowledged again.
 */
export function withState(
  draft: Omit<Incident, 'resolvable' | 'acknowledged'>,
  state: StoredState | undefined,
): Incident {
  const resolvable = (RESOLVABLE_INCIDENTS as readonly string[]).includes(draft.kind);
  const ack = state?.acknowledgedAt ?? null;
  const current = ack !== null && (draft.lastAt === null || draft.lastAt <= ack);
  return {
    ...draft,
    resolvable,
    acknowledged: current
      ? { at: ack!, byUserId: state?.acknowledgedById ?? null, note: state?.acknowledgeNote ?? null }
      : null,
  };
}

/** Marks an incident kind as being handled. */
export async function acknowledgeIncident(
  tx: TenantClient,
  tenantId: string,
  kind: IncidentKind,
  userId: string,
  note: string | null,
  now: Date,
): Promise<void> {
  await tx.incidentState.upsert({
    where: { tenantId_kind: { tenantId, kind } },
    create: { tenantId, kind, acknowledgedAt: now, acknowledgedById: userId, acknowledgeNote: note },
    update: { acknowledgedAt: now, acknowledgedById: userId, acknowledgeNote: note },
  });
}

/**
 * Resolves an event incident: what happened up to now is dealt with, and only
 * newer events count from here. Clears the acknowledgement with it -- a
 * resolved incident that comes back is a new one.
 */
export async function resolveIncident(
  tx: TenantClient,
  tenantId: string,
  kind: IncidentKind,
  userId: string,
  note: string | null,
  now: Date,
): Promise<void> {
  await tx.incidentState.upsert({
    where: { tenantId_kind: { tenantId, kind } },
    create: { tenantId, kind, resolvedAt: now, resolvedById: userId, resolveNote: note },
    update: {
      resolvedAt: now,
      resolvedById: userId,
      resolveNote: note,
      acknowledgedAt: null,
      acknowledgedById: null,
      acknowledgeNote: null,
    },
  });
}
