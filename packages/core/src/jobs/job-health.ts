import { scrubText } from '@syntra/connectors';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { EXPORT_JOB } from '../exports/export-service.js';
import { classifyError, type ErrorClass } from '../health/error-class.js';
import { PERSON_IMPORT_JOB } from '../person-source/jobs.js';
import { PROVISION_JOB, STALE_RUN_MS } from '../provision/jobs.js';
import { PERSON_PROVISION_JOB } from '../provision/person-receipts.js';
import { SYNC_JOB } from '../sync/jobs.js';
import { honouredCancellation, noActiveRequest } from './cancellation.js';
import { JobNotQueuedError } from './enqueue-for-row.js';
import type { Scheduler } from './scheduler.js';

/**
 * Queue recovery controls (backlog #57).
 *
 * The work Syntra does in the background has two halves that can disagree: a
 * ROW (a sync run, an HR import run, a provisioning run, a person receipt, an
 * export, a lifecycle operation) that says what state the work is in, and a
 * JOB in pg-boss that is supposed to be moving it. Every failure this module
 * reports is a disagreement between the two, or between a row and the clock:
 *
 *   orphaned   the row says work is waiting or under way, and no live job
 *              exists for it (nothing will ever move it), or -- for a
 *              provisioning apply, which runs in the request that confirmed
 *              it -- its heartbeat stopped.
 *   stuck      a live worker has made no visible progress for longer than any
 *              run this system has been measured doing (`STALE_RUN_MS`).
 *   duplicated more than one live job for the same row, or two scheduled jobs
 *              for the same source or target at once. Harmless by design --
 *              every worker claims its row conditionally -- but it is
 *              evidence of a double enqueue somebody should look at.
 *   delayed    a live job exists and has waited past the queue SLA: the queue
 *              is not keeping up.
 *   poisoned   the same payload failed repeatedly: the job threw until
 *              pg-boss's retries were exhausted, or is still retrying after
 *              failing again and again.
 *   saturation_deferred
 *              a target operation stepped back from the tenant's concurrency
 *              cap and is waiting for a slot. Informational until it keeps
 *              happening.
 *
 * ## Repairs, and what they refuse to do
 *
 * Three repairs exist, and each is offered only for the findings where it is
 * safe. They REUSE the semantics the subsystems already have rather than
 * inventing new ones:
 *
 *   requeue        enqueue the job the row is missing. Only for a row whose
 *                  worker has not started (a queued run or export, a pending,
 *                  deferred or abandoned-planning receipt). Every worker claims
 *                  its row with a conditional update, so a requeue that races
 *                  a late job does nothing twice.
 *   mark_failed    end a row nothing is working on, with the operator's
 *                  reason, exactly as the subsystem's own abandoned-run path
 *                  does: a preview that never finished wrote no plan, so it
 *                  is simply failed; a waiting cancellation request is
 *                  honoured instead.
 *   release_lease  a provisioning apply whose heartbeat stopped: the run is
 *                  closed `partially_applied`, which is what the next run's
 *                  adoption would make it. Its `in_flight` actions are NOT
 *                  touched. Their outcome is unknown, and the only thing
 *                  allowed to decide it is `resolveInFlightActions`, which the
 *                  next preview runs against the target BEFORE planning
 *                  anything. Nothing here ever re-runs a connector write.
 *
 * Lifecycle operations are reported and never repaired here: their retry
 * paths (`retry` and `retry-after-verification`) are verification-gated on
 * the operation itself, and a second button that bypassed that gate would be
 * the defect this rule exists to prevent.
 *
 * Every repair is idempotent. It re-derives the finding at the moment it runs
 * and acts through a conditional write keyed on the state it saw -- for a
 * provisioning apply, on the heartbeat value itself, so a heartbeat that lands
 * between the check and the write makes the release a no-op. A repair of
 * something that is already healthy answers `noop`. Every attempt, including
 * a `noop`, is an audit event.
 *
 * ## Tenant isolation
 *
 * Rows are read under the tenant's RLS binding. pg-boss's table is not under
 * RLS, so every read of it is filtered on the payload's `tenantId` -- every
 * job Syntra enqueues carries one -- and nothing another tenant enqueued is
 * ever returned, counted or classified.
 *
 * If the queue cannot be read at all, NOTHING is reported orphaned: "no live
 * job" cannot be concluded from "could not look". Only the clock-based
 * findings remain.
 */

export const JOB_HEALTH_KINDS = [
  'sync_run',
  'person_import_run',
  'provision_run',
  'person_provision_receipt',
  'data_export',
  'lifecycle_operation',
  'scheduled_job',
] as const;
export type JobHealthKind = (typeof JOB_HEALTH_KINDS)[number];

export const JOB_HEALTH_FINDINGS = [
  'orphaned',
  'stuck',
  'duplicated',
  'delayed',
  'poisoned',
  'saturation_deferred',
] as const;
export type JobHealthFindingKind = (typeof JOB_HEALTH_FINDINGS)[number];

export const JOB_REPAIR_ACTIONS = ['requeue', 'mark_failed', 'release_lease'] as const;
export type JobRepairAction = (typeof JOB_REPAIR_ACTIONS)[number];

/**
 * The thresholds, in one place so the documentation, the console and the
 * alert rules can name the same numbers.
 */
export const JOB_HEALTH_THRESHOLDS = {
  /**
   * How long a row may exist without a live job before it is orphaned. Longer
   * than the gap between a row's commit and its job's enqueue (milliseconds)
   * and than pg-boss's polling interval, by a wide margin.
   */
  orphanGraceMs: 10 * 60_000,
  /** How long a job may wait in the queue before it is delayed. */
  queueDelaySlaMs: 15 * 60_000,
  /** No progress for this long is stuck. The provisioning adoption threshold. */
  stuckAfterMs: STALE_RUN_MS,
  /**
   * A provisioning apply restamps its heartbeat every minute
   * (`HEARTBEAT_MS`); fifteen missed beats is a dead process, not a slow one.
   * A single connector call is bounded well inside this.
   */
  heartbeatStaleMs: 15 * 60_000,
  /** Attempts of one payload within the window that make it poisoned. */
  poisonAttempts: 3,
  poisonWindowMs: 24 * 60 * 60_000,
} as const;

/** The queues whose jobs map onto a row this module knows. */
const TRACKED_QUEUES = [SYNC_JOB, PERSON_IMPORT_JOB, PROVISION_JOB, PERSON_PROVISION_JOB, EXPORT_JOB] as const;

// ---- the queue ---------------------------------------------------------------

/**
 * One group of pg-boss jobs sharing a queue, a state and a payload key.
 * Aggregated in SQL so a deep backlog is a handful of rows, not a copy of it.
 */
export interface QueueGroup {
  name: string;
  state: 'created' | 'retry' | 'active' | 'failed';
  tenantId: string | null;
  runId: string | null;
  receiptId: string | null;
  exportId: string | null;
  sourceId: string | null;
  targetSystemId: string | null;
  count: number;
  /** Attempts made: retries, plus the final one of a job that failed. */
  attempts: number;
  oldestCreatedAt: Date;
  /** The most recent failure's message. Classified, never returned. */
  lastError: string | null;
}

/**
 * How the queue is read. The default reads pg-boss's own table; tests pass a
 * fake. `null` means the queue could not be read (no pg-boss schema yet, or
 * the query failed), which disables every finding that depends on it.
 */
export type QueueInspector = (tenantId: string | null, failedSince: Date) => Promise<QueueGroup[] | null>;

export const pgBossInspector: QueueInspector = async (tenantId, failedSince) => {
  try {
    const rows = await prisma.$queryRawUnsafe<QueueGroup[]>(
      `select name,
              state::text as state,
              data->>'tenantId' as "tenantId",
              data->>'runId' as "runId",
              data->>'receiptId' as "receiptId",
              data->>'exportId' as "exportId",
              data->>'sourceId' as "sourceId",
              data->>'targetSystemId' as "targetSystemId",
              count(*)::int as count,
              sum(retry_count + case when state = 'failed' then 1 else 0 end)::int as attempts,
              min(created_on) as "oldestCreatedAt",
              (array_agg(coalesce(output->>'message', output::text) order by completed_on desc nulls last))[1] as "lastError"
         from pgboss.job
        where (state in ('created', 'retry', 'active') or (state = 'failed' and completed_on >= $1))
          and ($2::text is null or data->>'tenantId' = $2::text)
        group by 1, 2, 3, 4, 5, 6, 7, 8
        limit 10000`,
      failedSince,
      tenantId,
    );
    return rows.map((row) => ({ ...row, oldestCreatedAt: new Date(row.oldestCreatedAt) }));
  } catch {
    // Most often: pg-boss has never started against this database. Whatever
    // the cause, the answer is "unknown", which is not "empty".
    return null;
  }
};

// ---- findings ----------------------------------------------------------------

export interface JobHealthFinding {
  /** Stable across reads: `${kind}:${subjectId}:${finding}`. */
  id: string;
  finding: JobHealthFindingKind;
  kind: JobHealthKind;
  /** The row the finding is about (or, for a scheduled job, its queue name). */
  subjectId: string;
  subjectType: string;
  /** The row's status, when there is a row. */
  status: string | null;
  /** When the condition is measured from. */
  since: string;
  ageSeconds: number;
  /** One operator-readable sentence. Never a stored error message. */
  detail: string;
  /**
   * For a poisoned payload: its last error, put through `scrubText` -- which
   * removes credentials, addresses, DNs and opaque tokens and bounds the
   * length. The class alone read "last failure: unknown" whenever the message
   * matched no known shape, which told the operator nothing at all.
   */
  error: string | null;
  /**
   * What the job is about, in words: "Provisioning run · Local AD". Filled by
   * `inspectJobHealth`, which can read names; null from the pure classifier.
   */
  subjectLabel: string | null;
  /** For a poisoned payload: the class of its last failure. */
  errorClass: ErrorClass | null;
  /** Provisioning: actions whose outcome is unknown and awaits verification. */
  inFlightActions: number | null;
  /** The repairs that are safe for this finding. */
  repairs: JobRepairAction[];
}

export interface JobHealthReport {
  generatedAt: string;
  /** Whether pg-boss's table could be read. When false, nothing is orphaned. */
  queueReadable: boolean;
  thresholds: typeof JOB_HEALTH_THRESHOLDS;
  counts: Record<JobHealthFindingKind, number>;
  findings: JobHealthFinding[];
}

const SUBJECT_TYPE: Record<JobHealthKind, string> = {
  sync_run: 'SyncRun',
  person_import_run: 'PersonImportRun',
  provision_run: 'ProvisionRun',
  person_provision_receipt: 'PersonProvisionReceipt',
  data_export: 'DataExport',
  lifecycle_operation: 'LifecycleOperation',
  scheduled_job: 'Queue',
};

const LIVE = new Set(['created', 'retry', 'active']);

/** How many rows of each kind one read considers. Oldest first. */
const ROW_LIMIT = 200;

interface Facts {
  syncRuns: { id: string; sourceId: string; status: string; startedAt: Date }[];
  importRuns: { id: string; sourceId: string; status: string; startedAt: Date }[];
  provisionRuns: {
    id: string;
    targetSystemId: string;
    status: string;
    startedAt: Date;
    lastProgressAt: Date | null;
  }[];
  inFlight: Map<string, number>;
  receipts: {
    id: string;
    targetSystemId: string;
    status: string;
    jobId: string | null;
    message: string | null;
    updatedAt: Date;
    createdAt: Date;
    evidence: unknown;
  }[];
  exports: { id: string; status: string; requestedAt: Date; startedAt: Date | null }[];
  operations: {
    id: string;
    status: string;
    kind: string;
    updatedAt: Date;
    sloDeadlineAt: Date | null;
  }[];
}

async function readFacts(tx: TenantClient, now: Date): Promise<Facts> {
  const stuckBefore = new Date(now.getTime() - JOB_HEALTH_THRESHOLDS.stuckAfterMs);
  const [syncRuns, importRuns, provisionRuns, receipts, exports, operations] = await Promise.all([
    tx.syncRun.findMany({
      where: { status: { in: ['queued', 'running', 'applying'] } },
      select: { id: true, sourceId: true, status: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: ROW_LIMIT,
    }),
    tx.personImportRun.findMany({
      where: { status: { in: ['queued', 'running', 'applying'] } },
      select: { id: true, sourceId: true, status: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: ROW_LIMIT,
    }),
    tx.provisionRun.findMany({
      where: { status: { in: ['running', 'applying'] } },
      select: { id: true, targetSystemId: true, status: true, startedAt: true, lastProgressAt: true },
      orderBy: { startedAt: 'asc' },
      take: ROW_LIMIT,
    }),
    tx.personProvisionReceipt.findMany({
      where: { status: { in: ['pending', 'planning', 'deferred'] } },
      select: {
        id: true,
        targetSystemId: true,
        status: true,
        jobId: true,
        message: true,
        updatedAt: true,
        createdAt: true,
        evidence: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: ROW_LIMIT,
    }),
    tx.dataExport.findMany({
      where: { status: { in: ['queued', 'running'] } },
      select: { id: true, status: true, requestedAt: true, startedAt: true },
      orderBy: { requestedAt: 'asc' },
      take: ROW_LIMIT,
    }),
    tx.lifecycleOperation.findMany({
      where: {
        OR: [
          { status: { in: ['queued', 'running'] }, updatedAt: { lt: stuckBefore } },
          { status: 'queued', sloDeadlineAt: { lt: now } },
        ],
      },
      select: { id: true, status: true, kind: true, updatedAt: true, sloDeadlineAt: true },
      orderBy: { updatedAt: 'asc' },
      take: ROW_LIMIT,
    }),
  ]);
  const applying = provisionRuns.map((run) => run.id);
  const grouped = applying.length
    ? await tx.provisionAction.groupBy({
        by: ['runId'],
        where: { runId: { in: applying }, status: 'in_flight' },
        _count: { _all: true },
      })
    : [];
  return {
    syncRuns,
    importRuns,
    provisionRuns,
    inFlight: new Map(grouped.map((row) => [row.runId, row._count._all])),
    receipts,
    exports,
    operations,
  };
}

const iso = (date: Date) => date.toISOString();
const ageSeconds = (now: Date, since: Date) => Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Classifies one tenant's rows against its jobs. Pure: every input is passed
 * in, so the rules can be tested without a queue.
 */
export function classifyJobHealth(facts: Facts, queue: QueueGroup[] | null, now: Date): JobHealthFinding[] {
  const T = JOB_HEALTH_THRESHOLDS;
  const findings: JobHealthFinding[] = [];
  const add = (
    finding: JobHealthFindingKind,
    kind: JobHealthKind,
    subjectId: string,
    status: string | null,
    since: Date,
    detail: string,
    extra: Partial<Pick<JobHealthFinding, 'errorClass' | 'inFlightActions' | 'repairs' | 'error'>> = {},
  ) => {
    findings.push({
      id: `${kind}:${subjectId}:${finding}`,
      finding,
      kind,
      subjectId,
      subjectType: SUBJECT_TYPE[kind],
      status,
      since: iso(since),
      ageSeconds: ageSeconds(now, since),
      detail,
      error: extra.error ?? null,
      subjectLabel: null,
      errorClass: extra.errorClass ?? null,
      inFlightActions: extra.inFlightActions ?? null,
      repairs: extra.repairs ?? [],
    });
  };
  const older = (since: Date, ms: number) => now.getTime() - since.getTime() >= ms;

  const readable = queue !== null;
  const live = (queue ?? []).filter((group) => LIVE.has(group.state));
  const liveCount = (name: string, match: (group: QueueGroup) => boolean, states?: string[]) =>
    live
      .filter((group) => group.name === name && match(group) && (!states || states.includes(group.state)))
      .reduce((sum, group) => sum + group.count, 0);
  const oldestWaiting = (name: string, match: (group: QueueGroup) => boolean) =>
    live
      .filter((group) => group.name === name && match(group) && group.state !== 'active')
      .reduce<Date | null>((min, group) => (min === null || group.oldestCreatedAt < min ? group.oldestCreatedAt : min), null);

  // ---- directory sync and HR import runs --------------------------------------
  const runKinds = [
    { kind: 'sync_run' as const, queue: SYNC_JOB, rows: facts.syncRuns, label: 'directory sync run' },
    { kind: 'person_import_run' as const, queue: PERSON_IMPORT_JOB, rows: facts.importRuns, label: 'HR import run' },
  ];
  for (const { kind, queue: name, rows, label } of runKinds) {
    for (const run of rows) {
      const own = (group: QueueGroup) => group.runId === run.id;
      if (run.status === 'queued') {
        const waiting = liveCount(name, own);
        if (readable && waiting === 0 && older(run.startedAt, T.orphanGraceMs)) {
          add('orphaned', kind, run.id, run.status, run.startedAt,
            `This ${label} is queued but no job exists to start it. Requeue it, or mark it failed.`,
            { repairs: ['requeue', 'mark_failed'] });
        } else if (waiting > 0) {
          const since = oldestWaiting(name, own);
          if (since && older(since, T.queueDelaySlaMs)) {
            add('delayed', kind, run.id, run.status, since,
              `This ${label} has waited more than ${minutes(T.queueDelaySlaMs)} minutes for a worker; the queue is not keeping up.`);
          }
        }
      } else if (run.status === 'running') {
        // A scheduled run has no run id in its payload; its job names the source.
        const working = liveCount(name, (group) => own(group) || (group.runId === null && group.sourceId === run.sourceId), ['active']);
        if (readable && working === 0 && older(run.startedAt, T.orphanGraceMs)) {
          add('orphaned', kind, run.id, run.status, run.startedAt,
            `This ${label} says it is reading, and no worker is running it. A preview writes nothing until it finishes, so marking it failed loses nothing.`,
            { repairs: ['mark_failed'] });
        } else if (older(run.startedAt, T.stuckAfterMs)) {
          add('stuck', kind, run.id, run.status, run.startedAt,
            `This ${label} has been reading for more than ${minutes(T.stuckAfterMs) / 60} hours.`,
            { repairs: readable && working > 0 ? [] : ['mark_failed'] });
        }
      } else if (run.status === 'applying' && older(run.startedAt, T.stuckAfterMs)) {
        // Applies run in the request that confirmed them and carry no
        // heartbeat, so a live apply cannot be told from a dead one. No repair
        // is offered: applying the run again resumes it, and cancelling it is
        // honoured before the resumed apply touches anything.
        add('stuck', kind, run.id, run.status, run.startedAt,
          `This ${label} has been applying for a long time. Apply it again from its run page to resume it, or cancel it.`);
      }
    }
  }

  // ---- provisioning runs --------------------------------------------------------
  const receiptTarget = new Map(facts.receipts.map((receipt) => [receipt.id, receipt.targetSystemId]));
  for (const run of facts.provisionRuns) {
    const aliveAt = run.lastProgressAt ?? run.startedAt;
    const inFlight = facts.inFlight.get(run.id) ?? 0;
    if (run.status === 'running') {
      const working =
        liveCount(PROVISION_JOB, (group) => group.targetSystemId === run.targetSystemId, ['active']) +
        liveCount(PERSON_PROVISION_JOB, (group) => group.receiptId !== null && receiptTarget.get(group.receiptId) === run.targetSystemId, ['active']);
      if (readable && working === 0 && older(aliveAt, T.orphanGraceMs)) {
        add('orphaned', 'provision_run', run.id, run.status, aliveAt,
          'This provisioning preview is not being worked on by any job. It wrote no plan, so marking it failed loses nothing.',
          { repairs: ['mark_failed'] });
      } else if (older(aliveAt, T.stuckAfterMs)) {
        add('stuck', 'provision_run', run.id, run.status, aliveAt,
          `This provisioning preview has shown no progress for more than ${minutes(T.stuckAfterMs) / 60} hours. The next scheduled run would adopt it as abandoned.`,
          { repairs: ['mark_failed'] });
      }
    } else if (run.status === 'applying' && older(aliveAt, T.heartbeatStaleMs)) {
      const unknown = inFlight > 0
        ? ` ${inFlight} action${inFlight === 1 ? ' has' : 's have'} an unknown outcome and will be verified against the target before the next run plans anything.`
        : '';
      add(older(aliveAt, T.stuckAfterMs) ? 'stuck' : 'orphaned', 'provision_run', run.id, run.status, aliveAt,
        `This provisioning apply stopped sending its heartbeat ${minutes(now.getTime() - aliveAt.getTime())} minutes ago; the process applying it is gone. Releasing it closes the run as partially applied.${unknown}`,
        { repairs: ['release_lease'], inFlightActions: inFlight });
    }
  }

  // ---- person provisioning receipts ---------------------------------------------
  for (const receipt of facts.receipts) {
    const own = (group: QueueGroup) => group.receiptId === receipt.id;
    const waiting = liveCount(PERSON_PROVISION_JOB, own);
    if (receipt.status === 'deferred') {
      const deferrals = typeof (receipt.evidence as { deferrals?: unknown } | null)?.deferrals === 'number'
        ? (receipt.evidence as { deferrals: number }).deferrals
        : 1;
      if (readable && waiting === 0 && older(receipt.updatedAt, T.orphanGraceMs)) {
        add('orphaned', 'person_provision_receipt', receipt.id, receipt.status, receipt.updatedAt,
          'This target operation was deferred by the concurrency cap and its retry job is gone. Requeue it, or mark it failed.',
          { repairs: ['requeue', 'mark_failed'] });
      } else {
        add('saturation_deferred', 'person_provision_receipt', receipt.id, receipt.status, receipt.updatedAt,
          `This target operation is waiting for a slot under the tenant's concurrency cap (deferred ${deferrals} time${deferrals === 1 ? '' : 's'}). It retries by itself.`,
          { repairs: ['mark_failed'] });
      }
    } else if (receipt.status === 'pending') {
      // A receipt the worker itself put back to `pending` with a message --
      // "the start date is outside the provisioning window" -- is waiting on
      // purpose, for somebody to retry it when it is due. Not wreckage.
      if (receipt.message !== null) continue;
      if (readable && waiting === 0 && older(receipt.updatedAt, T.orphanGraceMs)) {
        add('orphaned', 'person_provision_receipt', receipt.id, receipt.status, receipt.updatedAt,
          'This target operation is pending but no job exists to run it. Requeue it, or mark it failed.',
          { repairs: ['requeue', 'mark_failed'] });
      } else if (waiting > 0) {
        const since = oldestWaiting(PERSON_PROVISION_JOB, own);
        if (since && older(since, T.queueDelaySlaMs)) {
          add('delayed', 'person_provision_receipt', receipt.id, receipt.status, since,
            `This target operation has waited more than ${minutes(T.queueDelaySlaMs)} minutes for a worker.`);
        }
      }
    } else if (receipt.status === 'planning') {
      const working = liveCount(PERSON_PROVISION_JOB, own, ['active']);
      if (readable && working === 0 && older(receipt.updatedAt, T.orphanGraceMs)) {
        add('orphaned', 'person_provision_receipt', receipt.id, receipt.status, receipt.updatedAt,
          'This target operation was being planned or applied by a worker that is gone. Requeuing it starts a new preview, which verifies any unknown write outcomes against the target before planning.',
          { repairs: ['requeue', 'mark_failed'] });
      } else if (older(receipt.updatedAt, T.stuckAfterMs)) {
        add('stuck', 'person_provision_receipt', receipt.id, receipt.status, receipt.updatedAt,
          `This target operation has shown no progress for more than ${minutes(T.stuckAfterMs) / 60} hours.`,
          { repairs: readable && working > 0 ? [] : ['requeue', 'mark_failed'] });
      }
    }
  }

  // ---- exports ------------------------------------------------------------------
  for (const row of facts.exports) {
    const own = (group: QueueGroup) => group.exportId === row.id;
    if (row.status === 'queued') {
      const waiting = liveCount(EXPORT_JOB, own);
      if (readable && waiting === 0 && older(row.requestedAt, T.orphanGraceMs)) {
        add('orphaned', 'data_export', row.id, row.status, row.requestedAt,
          'This export is queued but no job exists to generate it. Requeue it, or mark it failed.',
          { repairs: ['requeue', 'mark_failed'] });
      } else if (waiting > 0) {
        const since = oldestWaiting(EXPORT_JOB, own);
        if (since && older(since, T.queueDelaySlaMs)) {
          add('delayed', 'data_export', row.id, row.status, since,
            `This export has waited more than ${minutes(T.queueDelaySlaMs)} minutes for a worker.`);
        }
      }
    } else {
      const since = row.startedAt ?? row.requestedAt;
      const working = liveCount(EXPORT_JOB, own, ['active']);
      if (readable && working === 0 && older(since, T.orphanGraceMs)) {
        add('orphaned', 'data_export', row.id, row.status, since,
          'This export is marked as generating and no worker is generating it. Mark it failed; the requester can ask again.',
          { repairs: ['mark_failed'] });
      }
    }
  }

  // ---- lifecycle operations (report only) ---------------------------------------
  for (const operation of facts.operations) {
    if (older(operation.updatedAt, T.stuckAfterMs)) {
      add('stuck', 'lifecycle_operation', operation.id, operation.status, operation.updatedAt,
        `This ${operation.kind} operation has not changed for more than ${minutes(T.stuckAfterMs) / 60} hours. Retry it from the operation's page, where a retry after an ambiguous target outcome requires verification first.`);
    } else if (operation.status === 'queued' && operation.sloDeadlineAt && operation.sloDeadlineAt < now) {
      add('delayed', 'lifecycle_operation', operation.id, operation.status, operation.sloDeadlineAt,
        `This ${operation.kind} operation is still queued past its service-level deadline.`);
    }
  }

  // ---- duplicated and poisoned: read off the queue itself -----------------------
  if (queue !== null) {
    const subjectOf = (group: QueueGroup): { kind: JobHealthKind; id: string } => {
      if (group.name === SYNC_JOB && group.runId) return { kind: 'sync_run', id: group.runId };
      if (group.name === PERSON_IMPORT_JOB && group.runId) return { kind: 'person_import_run', id: group.runId };
      if (group.name === PERSON_PROVISION_JOB && group.receiptId) return { kind: 'person_provision_receipt', id: group.receiptId };
      if (group.name === EXPORT_JOB && group.exportId) return { kind: 'data_export', id: group.exportId };
      // Scheduled work, keyed by what it acts on, or by its queue.
      const scope = group.sourceId ?? group.targetSystemId;
      return { kind: 'scheduled_job', id: scope ? `${group.name}/${scope}` : group.name };
    };

    const liveBySubject = new Map<string, { kind: JobHealthKind; id: string; count: number; since: Date }>();
    for (const group of live) {
      if (!(TRACKED_QUEUES as readonly string[]).includes(group.name)) continue;
      const subject = subjectOf(group);
      // A scheduled job with no scope (a per-tenant sweep) is one job per
      // cron tick by construction; two of them waiting is a slow queue, which
      // `delayed` already says.
      if (subject.kind === 'scheduled_job' && !group.sourceId && !group.targetSystemId) continue;
      const key = `${subject.kind}:${subject.id}`;
      const entry = liveBySubject.get(key) ?? { ...subject, count: 0, since: group.oldestCreatedAt };
      entry.count += group.count;
      if (group.oldestCreatedAt < entry.since) entry.since = group.oldestCreatedAt;
      liveBySubject.set(key, entry);
    }
    for (const entry of liveBySubject.values()) {
      if (entry.count < 2) continue;
      add('duplicated', entry.kind, entry.id, null, entry.since,
        `${entry.count} jobs are live for the same work. Only one can claim it; the rest will do nothing. Look for a double enqueue.`);
    }

    const attemptsBySubject = new Map<string, { kind: JobHealthKind; id: string; attempts: number; since: Date; lastError: string | null }>();
    for (const group of queue) {
      if (group.state !== 'failed' && group.state !== 'retry') continue;
      const subject = subjectOf(group);
      const key = `${subject.kind}:${subject.id}`;
      const entry = attemptsBySubject.get(key) ?? { ...subject, attempts: 0, since: group.oldestCreatedAt, lastError: null };
      entry.attempts += group.attempts;
      if (group.oldestCreatedAt < entry.since) entry.since = group.oldestCreatedAt;
      entry.lastError = entry.lastError ?? group.lastError;
      attemptsBySubject.set(key, entry);
    }
    for (const entry of attemptsBySubject.values()) {
      if (entry.attempts < T.poisonAttempts) continue;
      const errorClass = classifyError(entry.lastError);
      const error = entry.lastError ? scrubText(entry.lastError, 300) : null;
      add('poisoned', entry.kind, entry.id, null, entry.since,
        errorClass === 'unknown'
          ? `Failed ${entry.attempts} times in the last day. Retrying it unchanged will fail again; fix the cause first.`
          : `Failed ${entry.attempts} times in the last day (${errorClass.replace('_', ' ')}). Retrying it unchanged will fail again; fix the cause first.`,
        { errorClass, error });
    }
  }

  return findings;
}

function tally(findings: JobHealthFinding[]): Record<JobHealthFindingKind, number> {
  const counts = Object.fromEntries(JOB_HEALTH_FINDINGS.map((finding) => [finding, 0])) as Record<JobHealthFindingKind, number>;
  for (const finding of findings) counts[finding.finding] += 1;
  return counts;
}

export interface JobHealthOptions {
  now?: Date;
  inspector?: QueueInspector;
  /** Already-read queue groups (the metrics pass reads the queue once). */
  queue?: QueueGroup[] | null;
}

/** The job health of one tenant. */
export async function inspectJobHealth(tenantId: string, options: JobHealthOptions = {}): Promise<JobHealthReport> {
  const now = options.now ?? new Date();
  const queue = options.queue !== undefined
    ? options.queue
    : await (options.inspector ?? pgBossInspector)(tenantId, new Date(now.getTime() - JOB_HEALTH_THRESHOLDS.poisonWindowMs));
  // Defence in depth: whatever the inspector returned, only this tenant's jobs
  // are classified.
  const own = queue === null ? null : queue.filter((group) => group.tenantId === tenantId);
  const facts = await withTenant(tenantId, (tx) => readFacts(tx, now));
  const findings = await withTenant(tenantId, (tx) => labelFindings(tx, classifyJobHealth(facts, own, now)));
  return {
    generatedAt: iso(now),
    queueReadable: own !== null,
    thresholds: JOB_HEALTH_THRESHOLDS,
    counts: tally(findings),
    findings,
  };
}

const QUEUE_LABEL: Record<string, string> = {
  [SYNC_JOB]: 'Directory sync',
  [PERSON_IMPORT_JOB]: 'HR import',
  [PROVISION_JOB]: 'Provisioning run',
  [PERSON_PROVISION_JOB]: 'Target operation',
  [EXPORT_JOB]: 'Export',
};

/**
 * Names what each finding is about. A scheduled job's subject is
 * `queue/<target or source id>`; the queue becomes its label and the id the
 * target's or source's name, so "Scheduled job" reads "Provisioning run ·
 * Local AD". Run rows are named by the target or source they belong to.
 */
async function labelFindings(tx: TenantClient, findings: JobHealthFinding[]): Promise<JobHealthFinding[]> {
  if (findings.length === 0) return findings;
  const [targets, sources] = await Promise.all([
    tx.targetSystem.findMany({ select: { id: true, name: true } }),
    tx.directorySource.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map([...targets, ...sources].map((row) => [row.id, row.name]));
  const runTargets = new Map(
    (
      await tx.provisionRun.findMany({
        where: { id: { in: findings.filter((f) => f.kind === 'provision_run').map((f) => f.subjectId) } },
        select: { id: true, targetSystemId: true },
      })
    ).map((run) => [run.id, run.targetSystemId]),
  );
  const syncSources = new Map(
    (
      await tx.syncRun.findMany({
        where: { id: { in: findings.filter((f) => f.kind === 'sync_run').map((f) => f.subjectId) } },
        select: { id: true, sourceId: true },
      })
    ).map((run) => [run.id, run.sourceId]),
  );
  return findings.map((finding) => {
    let label: string | null = null;
    if (finding.kind === 'scheduled_job') {
      const [queue, scope] = finding.subjectId.split('/');
      const what = QUEUE_LABEL[queue ?? ''] ?? queue ?? 'Scheduled job';
      label = scope ? `${what} · ${names.get(scope) ?? 'removed system'}` : what;
    } else if (finding.kind === 'provision_run') {
      const target = runTargets.get(finding.subjectId);
      label = target ? (names.get(target) ?? null) : null;
    } else if (finding.kind === 'sync_run') {
      const source = syncSources.get(finding.subjectId);
      label = source ? (names.get(source) ?? null) : null;
    }
    return { ...finding, subjectLabel: label };
  });
}

// ---- repair ------------------------------------------------------------------

export class JobRepairRefusedError extends Error {
  constructor(
    readonly code: 'not-allowed' | 'scheduler-unavailable' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'JobRepairRefusedError';
  }
}

export interface JobRepairInput {
  kind: JobHealthKind;
  subjectId: string;
  action: JobRepairAction;
  reason: string;
  actorUserId: string;
  sourceIp: string | null;
}

export interface JobRepairResult {
  outcome: 'repaired' | 'noop';
  kind: JobHealthKind;
  subjectId: string;
  action: JobRepairAction;
  /** The findings the repair acted on. Empty for a `noop`. */
  findings: JobHealthFindingKind[];
  previousStatus: string | null;
  status: string | null;
  detail: string;
}

const REPAIRABLE: JobHealthKind[] = ['sync_run', 'person_import_run', 'provision_run', 'person_provision_receipt', 'data_export'];

/**
 * Applies one repair, idempotently and audited. See the module comment for
 * what each repair does and refuses.
 */
export async function repairJob(
  tenantId: string,
  input: JobRepairInput,
  options: JobHealthOptions & { scheduler: Scheduler | null },
): Promise<JobRepairResult> {
  const now = options.now ?? new Date();
  if (!REPAIRABLE.includes(input.kind)) {
    throw new JobRepairRefusedError('unsupported', input.kind === 'lifecycle_operation'
      ? 'Lifecycle operations are retried from their own page, where a retry after an ambiguous outcome requires verification.'
      : 'This kind of job has no repair; fix the cause and let the schedule run again.');
  }
  const report = await inspectJobHealth(tenantId, options);
  const matching = report.findings.filter((finding) => finding.kind === input.kind && finding.subjectId === input.subjectId);
  const permitting = matching.filter((finding) => finding.repairs.includes(input.action));

  const audit = async (
    tx: TenantClient,
    result: Omit<JobRepairResult, 'kind' | 'subjectId' | 'action'>,
  ) => {
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: `job_health.${input.action}`,
      targetType: SUBJECT_TYPE[input.kind],
      targetId: input.subjectId,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        kind: input.kind,
        result: result.outcome,
        findings: result.findings,
        previousStatus: result.previousStatus,
        status: result.status,
        reason: input.reason,
      },
    });
    return { ...result, kind: input.kind, subjectId: input.subjectId, action: input.action };
  };

  if (permitting.length === 0) {
    if (matching.length > 0) {
      throw new JobRepairRefusedError('not-allowed', `"${input.action.replace('_', ' ')}" is not a safe repair for this ${matching.map((f) => f.finding).join(' and ')} ${SUBJECT_TYPE[input.kind]}.`);
    }
    // Healthy now: already repaired, or it recovered by itself. Idempotent.
    return withTenant(tenantId, (tx) =>
      audit(tx, { outcome: 'noop', findings: [], previousStatus: null, status: null, detail: 'Nothing to repair: no finding stands against this job now.' }),
    );
  }
  const findings = [...new Set(permitting.map((finding) => finding.finding))];
  const previousStatus = permitting[0]!.status;

  if (input.action === 'requeue') {
    if (!options.scheduler) {
      throw new JobRepairRefusedError('scheduler-unavailable', 'Background jobs are not running, so nothing can be requeued.');
    }
    return requeue(tenantId, input, options.scheduler, previousStatus, findings, audit);
  }

  const reason = input.reason.trim();
  return withTenant(tenantId, async (tx) => {
    const changed = input.action === 'release_lease'
      ? await releaseLease(tx, input.subjectId, reason, now)
      : await markFailed(tx, input.kind, input.subjectId, previousStatus, reason, now);
    if (changed === null) {
      return audit(tx, { outcome: 'noop', findings, previousStatus, status: previousStatus, detail: 'The job changed state while the repair was being applied; nothing was changed.' });
    }
    return audit(tx, { outcome: 'repaired', findings, previousStatus, status: changed, detail: DETAIL[input.action] });
  });
}

const DETAIL: Record<JobRepairAction, string> = {
  requeue: 'A job was queued for this work.',
  mark_failed: 'Marked failed with your reason.',
  release_lease:
    'Released. The run is closed as partially applied; any action with an unknown outcome is verified against the target before the next run plans anything.',
};

/** Why a row was ended by an operator, in the words the row will carry. */
const operatorReason = (reason: string) => `marked failed by an operator: ${reason}`.slice(0, 500);

async function markFailed(
  tx: TenantClient,
  kind: JobHealthKind,
  id: string,
  status: string | null,
  reason: string,
  now: Date,
): Promise<string | null> {
  if (status === null) return null;
  const error = operatorReason(reason);
  if (kind === 'sync_run' || kind === 'person_import_run') {
    const runs = (kind === 'sync_run' ? tx.syncRun : tx.personImportRun) as unknown as {
      updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    };
    // A waiting cancellation is what the run's history should answer to, as
    // the provisioning adoption does it.
    const honoured = await runs.updateMany({
      where: { id, status, cancelState: 'requested' },
      data: { ...honouredCancellation(now), error },
    });
    if (honoured.count === 1) return 'cancelled';
    const failed = await runs.updateMany({
      where: { id, status, ...noActiveRequest() },
      data: { status: 'failed', finishedAt: now, error },
    });
    return failed.count === 1 ? 'failed' : null;
  }
  if (kind === 'provision_run') {
    const honoured = await tx.provisionRun.updateMany({
      where: { id, status: 'running', cancelState: 'requested' },
      data: { ...honouredCancellation(now), error },
    });
    if (honoured.count === 1) return 'cancelled';
    const failed = await tx.provisionRun.updateMany({
      where: { id, status: 'running', ...noActiveRequest() },
      data: { status: 'failed', finishedAt: now, error },
    });
    return failed.count === 1 ? 'failed' : null;
  }
  if (kind === 'person_provision_receipt') {
    const failed = await tx.personProvisionReceipt.updateMany({
      where: { id, status },
      data: { status: 'failed', message: operatorReason(reason) },
    });
    return failed.count === 1 ? 'failed' : null;
  }
  if (kind === 'data_export') {
    const row = await tx.dataExport.findUnique({ where: { id }, select: { kind: true, requestedByUserId: true } });
    const failed = await tx.dataExport.updateMany({
      where: { id, status },
      data: { status: 'failed', completedAt: now, error },
    });
    if (failed.count !== 1) return null;
    // The export's own vocabulary as well, so its history reads the same
    // whichever path ended it.
    await recordEvent(tx, {
      actorUserId: null,
      action: 'export.fail',
      targetType: 'DataExport',
      targetId: id,
      outcome: 'failure',
      sourceIp: null,
      payload: { kind: row?.kind ?? null, reason: 'operator', requestedByUserId: row?.requestedByUserId ?? null },
    });
    return 'failed';
  }
  return null;
}

/**
 * Closes a provisioning apply whose heartbeat stopped. Keyed on the heartbeat
 * value that was read, so a heartbeat landing in between wins and this does
 * nothing. `in_flight` actions are deliberately left alone: see the module
 * comment.
 */
async function releaseLease(tx: TenantClient, id: string, reason: string, now: Date): Promise<string | null> {
  const run = await tx.provisionRun.findUnique({
    where: { id },
    select: { status: true, lastProgressAt: true, startedAt: true, cancelState: true },
  });
  if (!run || run.status !== 'applying') return null;
  const aliveAt = run.lastProgressAt ?? run.startedAt;
  if (now.getTime() - aliveAt.getTime() < JOB_HEALTH_THRESHOLDS.heartbeatStaleMs) return null;
  const error = `released by an operator after its heartbeat stopped: ${reason}`.slice(0, 500);
  const where = { id, status: 'applying', lastProgressAt: run.lastProgressAt };
  if (run.cancelState === 'requested') {
    const honoured = await tx.provisionRun.updateMany({
      where: { ...where, cancelState: 'requested' },
      data: { ...honouredCancellation(now), error },
    });
    return honoured.count === 1 ? 'cancelled' : null;
  }
  const released = await tx.provisionRun.updateMany({
    where: { ...where, ...noActiveRequest() },
    data: { status: 'partially_applied', finishedAt: now, error },
  });
  return released.count === 1 ? 'partially_applied' : null;
}

async function requeue(
  tenantId: string,
  input: JobRepairInput,
  scheduler: Scheduler,
  previousStatus: string | null,
  findings: JobHealthFindingKind[],
  audit: (tx: TenantClient, result: Omit<JobRepairResult, 'kind' | 'subjectId' | 'action'>) => Promise<JobRepairResult>,
): Promise<JobRepairResult> {
  const id = input.subjectId;
  let job: { name: string; data: Record<string, unknown> } | null = null;

  if (input.kind === 'sync_run' || input.kind === 'person_import_run') {
    const run = await withTenant(tenantId, (tx) =>
      input.kind === 'sync_run'
        ? tx.syncRun.findUnique({ where: { id }, select: { status: true, sourceId: true } })
        : tx.personImportRun.findUnique({ where: { id }, select: { status: true, sourceId: true } }),
    );
    if (run?.status === 'queued') {
      job = { name: input.kind === 'sync_run' ? SYNC_JOB : PERSON_IMPORT_JOB, data: { tenantId, sourceId: run.sourceId, runId: id } };
    }
  } else if (input.kind === 'data_export') {
    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUnique({ where: { id }, select: { status: true } }));
    if (row?.status === 'queued') job = { name: EXPORT_JOB, data: { tenantId, exportId: id } };
  } else if (input.kind === 'person_provision_receipt') {
    // An abandoned `planning` receipt goes back to `pending` first, keyed on
    // the state that was read. The worker claims `pending` atomically, so a
    // late original job and this one cannot both run it.
    const ready = await withTenant(tenantId, async (tx) => {
      const receipt = await tx.personProvisionReceipt.findUnique({ where: { id }, select: { status: true, updatedAt: true } });
      if (!receipt) return false;
      if (receipt.status === 'pending' || receipt.status === 'deferred') return true;
      if (receipt.status !== 'planning') return false;
      const reset = await tx.personProvisionReceipt.updateMany({
        where: { id, status: 'planning', updatedAt: receipt.updatedAt },
        data: { status: 'pending', message: 'Requeued by an operator after its worker was lost.', jobId: null },
      });
      return reset.count === 1;
    });
    if (ready) job = { name: PERSON_PROVISION_JOB, data: { tenantId, receiptId: id } };
  }

  if (job === null) {
    return withTenant(tenantId, (tx) =>
      audit(tx, { outcome: 'noop', findings, previousStatus, status: previousStatus, detail: 'The job changed state while the repair was being applied; nothing was queued.' }),
    );
  }

  let jobId: string | null;
  try {
    jobId = await scheduler.enqueue(job.name, job.data);
  } catch (cause) {
    throw new JobNotQueuedError(job.name, cause);
  }
  if (jobId === null) throw new JobNotQueuedError(job.name);

  return withTenant(tenantId, async (tx) => {
    if (input.kind === 'person_provision_receipt') {
      await tx.personProvisionReceipt.updateMany({ where: { id, status: { in: ['pending', 'deferred'] } }, data: { jobId } });
    }
    return audit(tx, {
      outcome: 'repaired',
      findings,
      previousStatus,
      status: input.kind === 'person_provision_receipt' ? 'pending' : previousStatus,
      detail: DETAIL.requeue,
    });
  });
}

// ---- installation-wide counts, for metrics ------------------------------------

export interface JobHealthCount {
  kind: JobHealthKind;
  finding: JobHealthFindingKind;
  count: number;
}

/**
 * Findings by kind and finding across every given tenant, for the metrics
 * gauge. The queue is read ONCE for all of them and split by tenant here.
 * Returns null when the queue is unreadable AND nothing clock-based was found,
 * so the gauge can tell "none" from "could not look" -- which it only needs
 * for the queue-dependent findings, so it publishes zeros for the rest.
 */
export async function jobHealthCounts(
  tenantIds: string[],
  options: { now?: Date; inspector?: QueueInspector } = {},
): Promise<{ counts: JobHealthCount[]; queueReadable: boolean; tenantsAffected: number }> {
  const now = options.now ?? new Date();
  const queue = await (options.inspector ?? pgBossInspector)(null, new Date(now.getTime() - JOB_HEALTH_THRESHOLDS.poisonWindowMs));
  const byTenant = new Map<string, QueueGroup[]>();
  for (const group of queue ?? []) {
    if (!group.tenantId) continue;
    const list = byTenant.get(group.tenantId) ?? [];
    list.push(group);
    byTenant.set(group.tenantId, list);
  }
  const totals = new Map<string, number>();
  let tenantsAffected = 0;
  for (const tenantId of tenantIds) {
    const report = await inspectJobHealth(tenantId, { now, queue: queue === null ? null : byTenant.get(tenantId) ?? [] });
    if (report.counts.orphaned + report.counts.stuck + report.counts.poisoned > 0) tenantsAffected += 1;
    for (const finding of report.findings) {
      const key = `${finding.kind} ${finding.finding}`;
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
  }
  const counts: JobHealthCount[] = [];
  for (const kind of JOB_HEALTH_KINDS) {
    for (const finding of JOB_HEALTH_FINDINGS) {
      counts.push({ kind, finding, count: totals.get(`${kind} ${finding}`) ?? 0 });
    }
  }
  return { counts, queueReadable: queue !== null, tenantsAffected };
}
