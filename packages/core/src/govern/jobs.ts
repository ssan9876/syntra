import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { enqueueOutbox, usersWithPermission } from '../automate/notify.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { Transport } from '../notify/notification-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import {
  anchorHead,
  verifyIncremental,
  type AnchorSink,
  type CheckpointSigner,
} from './audit-integrity.js';
import { sweepAcceptedFindings } from './finding-service.js';
import { refreshOrphanProposals } from './orphan-service.js';
import {
  closeDueCampaigns,
  mootDepartedSubjects,
  mootVanishedHoldings,
  reassignInvalidReviewers,
  runCampaignReminders,
} from './reviewer-service.js';
import { reflectRevocationOutcomes } from './revocation-service.js';
import { detectSodViolations } from './sod-service.js';
import { governSettings } from './settings-service.js';
import { buildSnapshot, pruneSnapshots } from './snapshot-service.js';

export const GOVERN_SNAPSHOT_JOB = 'govern.snapshot.build';
export const GOVERN_PRUNE_JOB = 'govern.snapshot.prune';
export const GOVERN_VERIFY_JOB = 'govern.audit.verify';
export const GOVERN_ANCHOR_JOB = 'govern.audit.anchor';
export const GOVERN_REMIND_JOB = 'govern.campaign.remind';
export const GOVERN_CLOSE_JOB = 'govern.campaign.close';
export const GOVERN_EXCEPTION_JOB = 'govern.exception.sweep';

export type GovernPurpose =
  | 'snapshot'
  | 'prune'
  | 'verify'
  | 'anchor'
  | 'remind'
  | 'close'
  | 'exception';

export const GOVERN_PURPOSES: readonly GovernPurpose[] = [
  'snapshot',
  'prune',
  'verify',
  'anchor',
  'remind',
  'close',
  'exception',
];

const QUEUE_FOR: Record<GovernPurpose, string> = {
  snapshot: GOVERN_SNAPSHOT_JOB,
  prune: GOVERN_PRUNE_JOB,
  verify: GOVERN_VERIFY_JOB,
  anchor: GOVERN_ANCHOR_JOB,
  remind: GOVERN_REMIND_JOB,
  close: GOVERN_CLOSE_JOB,
  exception: GOVERN_EXCEPTION_JOB,
};

/**
 * pg-boss keys its schedule table on (queue, key) and `Scheduler.schedule`
 * defaults `key` to the empty string. All directory sources once shared
 * `key: ''` and only the last one in the last tenant ever ran. Mandatory on
 * every schedule and unschedule this module makes.
 */
export function governScheduleKey(tenantId: string, purpose: GovernPurpose): string {
  return `govern:${purpose}:${tenantId}`;
}

export interface GovernJobPayload {
  tenantId: string;
}

/** A background job has no request and therefore no ambient tenant. */
export function governJobPayload(tenantId: string): GovernJobPayload {
  return { tenantId };
}

export interface GovernJobOptions {
  now?: Date;
  publicUrl?: string;
  signer?: CheckpointSigner | null;
  anchorSink?: AnchorSink | null;
  batchSize?: number;
}

export async function runSnapshotJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ snapshotId: string; holdingCount: number; orphanProposals: number }> {
  const now = options.now ?? new Date();
  const built = await buildSnapshot(payload.tenantId, {
    now,
    kind: 'scheduled',
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
  const orphans = await refreshOrphanProposals(payload.tenantId, built.snapshotId, { now });

  // Detection is over a snapshot, per person, and it runs as part of the
  // nightly job so the violation count and the picture it came from are never a
  // day apart.
  //
  // Called from HERE rather than from `buildSnapshot`, deliberately:
  // `sod-service.ts` imports `readableSnapshot` from `readable.ts`, which
  // `snapshot-service.ts` also owns the writing half of, and a detect call in
  // the other direction closes the loop. ESM tolerates a cycle until the day an
  // initialisation order changes and one of them is half-constructed, and the
  // failure reads as an unrelated `undefined is not a function`. `jobs.ts`
  // already depends on both and on neither's internals, which is where a
  // sequencer belongs.
  await detectSodViolations(payload.tenantId, built.snapshotId, { now });

  // Campaign upkeep, over the picture the build just produced. All three
  // read the CURRENT snapshot, so they belong here rather than on their own
  // schedule: a moot decided against yesterday's holdings is a moot decided
  // against a world that has moved.
  const openCampaigns = await withTenant(payload.tenantId, (tx) =>
    tx.campaign.findMany({ where: { status: 'open' }, select: { id: true } }),
  );
  for (const campaign of openCampaigns) {
    await mootDepartedSubjects(payload.tenantId, campaign.id, { now });
    await mootVanishedHoldings(payload.tenantId, campaign.id, built.snapshotId, { now });
    await reassignInvalidReviewers(payload.tenantId, campaign.id, { now });
  }

  // The snapshot is what closes the loop: `applied` requires BOTH the owning
  // subsystem's confirmation AND a subsequent snapshot that no longer shows
  // the holding, so this runs against the build that just completed. Called
  // from here rather than from its own test: a function nothing in the
  // product calls leaves every dispatch on `dispatched` for ever, the
  // `dispatch_not_applied` SLA finding never fires, and a campaign closes
  // with 91 revocations of which 34 never happened.
  await reflectRevocationOutcomes(payload.tenantId, built.snapshotId, { now });

  await sweepAcceptedFindings(payload.tenantId, now);
  return {
    snapshotId: built.snapshotId,
    holdingCount: built.holdingCount,
    orphanProposals: orphans.proposals,
  };
}

export async function runPruneJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ pruned: number }> {
  const result = await pruneSnapshots(payload.tenantId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { pruned: result.pruned };
}

export async function runAnchorJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ status: string }> {
  if (options.anchorSink == null) {
    // Not an error. A tenant with no anchoring configured sees that stated on
    // its own integrity screen, in words; a job that threw here would fill the
    // log with failures about a feature nobody turned on.
    return { status: 'not_configured' };
  }
  const result = await anchorHead(payload.tenantId, options.anchorSink, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { status: result.status };
}

/**
 * The one plain-language sentence this finding is known by.
 *
 * It is the same sentence as `HEADLINE['audit_chain_broken']` on the findings
 * console, and the duplication is deliberate rather than missed: that map lives
 * in `apps/web` and cannot be imported from `packages/core`. Every `var` a
 * template renders is a NAME and never an id, so `audit_chain_broken` itself
 * must not be what a recipient reads.
 */
const INTEGRITY_HEADLINE = 'The audit log cannot be shown to be intact';

const NOBODY_TO_TELL =
  'a critical audit-integrity finding was raised and no active user holds ' +
  'audit.read, so nobody was notified; this is recorded rather than dropped ' +
  'because a silent zero here is indistinguishable from a working notifier';

/**
 * Verify, then TELL SOMEBODY.
 *
 * Notification is keyed on the FINDING and not on `result.result`, for the same
 * reason the finding is the record: a message derived from a second computation
 * can disagree with the row an operator opens, and then two numbers describe
 * one event.
 *
 * WHICH findings: `audit_chain_broken` and nothing else. Not "every critical
 * finding" — the standing kinds are raised by the nightly snapshot build in
 * bulk, are worked from the findings queue, and mailing every one of them
 * immediately is how a queue becomes a filter rule.
 *
 * WHEN: on the transition INTO open, computed as a set difference across the
 * verification rather than from a timestamp. A finding still open from last
 * night is not re-sent — a `critical` alarm arriving every night at 04:00 for
 * six months is an alarm somebody writes a mail rule for. A finding that was
 * RESOLVED and has broken again is not in `before`, so it is sent again, which
 * is correct: it is a new event. An `accepted` finding is in neither set and is
 * never sent, because somebody already decided about it.
 */
export async function runVerifyJob(
  payload: GovernJobPayload,
  options: GovernJobOptions = {},
): Promise<{ result: string; notified: number }> {
  const now = options.now ?? new Date();

  const before = new Set(
    (
      await withTenant(payload.tenantId, (tx) =>
        tx.governFinding.findMany({
          where: { kind: 'audit_chain_broken', status: { in: ['open', 'acknowledged'] } },
          select: { id: true },
        }),
      )
    ).map((f) => f.id),
  );

  const result = await verifyIncremental(payload.tenantId, {
    now,
    ...(options.signer === undefined ? {} : { signer: options.signer }),
  });

  const fresh = await withTenant(payload.tenantId, (tx) =>
    tx.governFinding.findMany({
      where: {
        kind: 'audit_chain_broken',
        status: { in: ['open', 'acknowledged'] },
        // An EMPTY `notIn` excludes nothing, which is the behaviour wanted on
        // the first run of a fresh tenant. Written as `notIn` rather than
        // filtered in memory so the difference is computed by the database over
        // the rows that exist now, not over a list read a moment earlier.
        id: { notIn: [...before] },
      },
      select: { id: true, subjectRefId: true, detail: true },
    }),
  );

  if (fresh.length === 0) return { result: result.result, notified: 0 };

  const publicUrl = options.publicUrl ?? '';
  const notified = await withTenant(payload.tenantId, async (tx) => {
    const recipients = await usersWithPermission(tx, PERMISSIONS.AUDIT_READ);
    if (recipients.length === 0) {
      await recordEvent(tx, {
        actorUserId: null,
        action: 'govern.finding.critical_unnotified',
        targetType: 'GovernFinding',
        targetId: fresh[0]!.id,
        outcome: 'failure',
        sourceIp: null,
        payload: {
          findingCount: fresh.length,
          permission: PERMISSIONS.AUDIT_READ,
          statement: NOBODY_TO_TELL,
        },
      });
      return 0;
    }

    return enqueueOutbox(
      tx,
      fresh.flatMap((finding) =>
        recipients.map((recipient) => ({
          // `NEVER_DIGESTED` carries this template, so `enqueueOutbox` writes
          // `digest: false` whatever the recipient's preference says. The rule
          // is enforced there, once, for every caller — not repeated here,
          // where the next caller would forget it.
          template: 'govern-finding-critical' as const,
          to: recipient.email,
          vars: {
            displayName: recipient.displayName,
            findingKind: INTEGRITY_HEADLINE,
            summary: String(
              (finding.detail as Record<string, unknown>)['statement'] ?? finding.subjectRefId,
            ),
            findingUrl: `${publicUrl}/admin/govern/findings/${finding.id}`,
          },
          requestId: null,
          userId: recipient.userId,
        })),
      ),
    );
  });

  return { result: result.result, notified };
}

/**
 * Reconciles EVERY purpose, not only the eligible ones.
 *
 * pg-boss keeps its schedules in the database, so a tenant that turned
 * snapshots off while this process was down still has schedule rows waiting for
 * it. Reading the whole list lets this function remove those as well as add the
 * rest, which is the difference between reconciling and appending.
 */
export async function applyGovernSchedules(
  scheduler: Scheduler,
  tenantId: string,
  snapshotSchedule: string | null,
): Promise<void> {
  const CRON: Record<GovernPurpose, string> = {
    snapshot: snapshotSchedule ?? '',
    prune: '30 3 * * *',
    verify: '0 4 * * *',
    anchor: '0 5 * * 0',
    remind: '0 8 * * *',
    close: '0 6 * * *',
    exception: '0 7 * * *',
  };

  for (const purpose of GOVERN_PURPOSES) {
    const key = governScheduleKey(tenantId, purpose);
    const cron = CRON[purpose];
    if (snapshotSchedule === null || cron === '') {
      await scheduler.unschedule(QUEUE_FOR[purpose], key);
      continue;
    }
    await scheduler.schedule(QUEUE_FOR[purpose], cron, governJobPayload(tenantId), key);
  }
}

/**
 * Slice 1 registers four handlers. The campaign tasks add `remind`, `close` and
 * `exception` to this same function — the queues and keys are declared above so
 * that `applyGovernSchedules` reconciles all seven from the start and no purpose
 * ends up with a schedule row nothing removes.
 */
export function registerGovernJobs(
  scheduler: Scheduler,
  options: {
    transport?: Transport;
    signer?: CheckpointSigner | null;
    anchorSink?: AnchorSink | null;
    publicUrl?: string;
  } = {},
): void {
  scheduler.register<GovernJobPayload>(GOVERN_SNAPSHOT_JOB, async (payload) => {
    await runSnapshotJob(payload);
  });
  scheduler.register<GovernJobPayload>(GOVERN_PRUNE_JOB, async (payload) => {
    await runPruneJob(payload);
  });
  scheduler.register<GovernJobPayload>(GOVERN_VERIFY_JOB, async (payload) => {
    // `publicUrl` as well as the signer: the verify job NOTIFIES on a critical
    // integrity finding, and `{{findingUrl}}` is the whole difference between
    // an alarm somebody can act on and one that says something is wrong
    // somewhere. Without it the link is `/admin/govern/...` in an email client,
    // which resolves to nothing.
    await runVerifyJob(payload, {
      signer: options.signer ?? null,
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
  scheduler.register<GovernJobPayload>(GOVERN_ANCHOR_JOB, async (payload) => {
    await runAnchorJob(payload, { anchorSink: options.anchorSink ?? null });
  });
  // `publicUrl` for the same reason the verify job takes it: every one of these
  // notifications carries a link into a review queue, and a link that resolves
  // to nothing is a reminder nobody can act on.
  scheduler.register<GovernJobPayload>(GOVERN_REMIND_JOB, async (payload) => {
    await runCampaignReminders(payload.tenantId, {
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
  scheduler.register<GovernJobPayload>(GOVERN_CLOSE_JOB, async (payload) => {
    await closeDueCampaigns(payload.tenantId, {
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
}

/**
 * The tenant's snapshot cadence, for the caller that reconciles schedules at
 * boot. Get-or-create, so a tenant that has never opened the Govern settings
 * screen is scheduled on the default rather than skipped.
 */
export async function governSnapshotSchedule(tenantId: string): Promise<string | null> {
  const settings = await withTenant(tenantId, (tx) => governSettings(tx));
  return settings.snapshotSchedule;
}
