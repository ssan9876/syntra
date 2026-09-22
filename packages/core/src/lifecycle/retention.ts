import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { OUTBOX_MAX_ATTEMPTS } from '../automate/jobs.js';
import { readLifecyclePolicy, type LifecyclePolicy } from './policy.js';

const MS_PER_DAY = 86_400_000;
const RESOLVED = ['completed', 'cancelled', 'rejected'];

export interface RetentionReport {
  ranAt: string;
  receiptsRemoved: number;
  observationsRemoved: number;
  notificationsRemoved: number;
  simulationsRemoved: number;
  readinessChecksRemoved: number;
  /**
   * Always zero from this job. Audit events are immutable at the database
   * (`audit_no_delete` is a rule that turns DELETE into a no-op), so the
   * retention pass can only report how many are past the policy and eligible
   * for the documented archive-and-prune procedure, which runs as the
   * database owner and only ever removes events at or before a verified
   * checkpoint so the chain still verifies.
   */
  auditEventsRemoved: number;
  auditEventsEligible: number;
  /** Why audit events were left alone, when they were. */
  auditNote: string;
  policy: Pick<
    LifecyclePolicy,
    | 'receiptRetentionDays'
    | 'observationRetentionDays'
    | 'notificationRetentionDays'
    | 'simulationRetentionDays'
    | 'auditRetentionDays'
  >;
}

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Removes only what has aged past the tenant's policy AND is no longer
 * evidence for open work. The pass writes one audit event naming every
 * count, so a record's absence is itself recorded.
 *
 * Audit events are the special case: the database refuses to delete them
 * from the application role, so this pass only counts what the policy makes
 * eligible. The archive procedure in `docs/runbooks` removes events at or
 * before the latest verified checkpoint, and `verifyChain` seeds from that
 * checkpoint's hash when the log no longer starts at sequence 1. No
 * checkpoint, nothing is eligible.
 */
export async function runLifecycleRetention(
  tenantId: string,
  now: Date = new Date(),
  options: { dryRun?: boolean; actorUserId?: string | null } = {},
): Promise<RetentionReport> {
  return withTenant(tenantId, async (tx) => {
    const policy = await readLifecyclePolicy(tx);
    const dry = options.dryRun === true;

    const receiptWhere = {
      updatedAt: { lt: cutoff(now, policy.receiptRetentionDays) },
      status: { in: ['applied', 'no_match'] },
    };
    const observationWhere = {
      observedAt: { lt: cutoff(now, policy.observationRetentionDays) },
      step: { operation: { status: { in: RESOLVED } } },
    };
    const notificationWhere = {
      createdAt: { lt: cutoff(now, policy.notificationRetentionDays) },
      OR: [{ sentAt: { not: null } }, { attempts: { gte: OUTBOX_MAX_ATTEMPTS } }],
    };
    const simulationWhere = {
      OR: [
        { createdAt: { lt: cutoff(now, policy.simulationRetentionDays) } },
        { expiresAt: { lt: now } },
      ],
    };

    const staleReadiness = await staleReadinessCheckIds(tx, cutoff(now, policy.receiptRetentionDays));

    const counts = dry
      ? {
          receipts: await tx.personProvisionReceipt.count({ where: receiptWhere }),
          observations: await tx.lifecycleObservation.count({ where: observationWhere }),
          notifications: await tx.notificationOutbox.count({ where: notificationWhere }),
          simulations: await tx.lifecycleSimulation.count({ where: simulationWhere }),
          readiness: staleReadiness.length,
        }
      : {
          receipts: (await tx.personProvisionReceipt.deleteMany({ where: receiptWhere })).count,
          observations: (await tx.lifecycleObservation.deleteMany({ where: observationWhere })).count,
          notifications: (await tx.notificationOutbox.deleteMany({ where: notificationWhere })).count,
          simulations: (await tx.lifecycleSimulation.deleteMany({ where: simulationWhere })).count,
          readiness:
            staleReadiness.length === 0
              ? 0
              : (await tx.connectionReadinessCheck.deleteMany({ where: { id: { in: staleReadiness } } })).count,
        };

    let auditEventsEligible = 0;
    let auditNote: string;
    if (policy.auditRetentionDays === null) {
      auditNote = 'audit retention is not configured; nothing is eligible';
    } else {
      const checkpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
      if (!checkpoint) {
        auditNote = 'no verified audit checkpoint exists, so no audit event is eligible: removing one would break the chain';
      } else {
        auditEventsEligible = await tx.auditEvent.count({
          where: {
            occurredAt: { lt: cutoff(now, policy.auditRetentionDays) },
            sequence: { lte: checkpoint.sequence },
          },
        });
        auditNote = `${auditEventsEligible} audit events at or before checkpoint sequence ${checkpoint.sequence} are past the retention period; audit events are immutable to the application and are archived by the documented database-owner procedure`;
      }
    }

    const report: RetentionReport = {
      ranAt: now.toISOString(),
      receiptsRemoved: counts.receipts,
      observationsRemoved: counts.observations,
      notificationsRemoved: counts.notifications,
      simulationsRemoved: counts.simulations,
      readinessChecksRemoved: counts.readiness,
      auditEventsRemoved: 0,
      auditEventsEligible,
      auditNote,
      policy: {
        receiptRetentionDays: policy.receiptRetentionDays,
        observationRetentionDays: policy.observationRetentionDays,
        notificationRetentionDays: policy.notificationRetentionDays,
        simulationRetentionDays: policy.simulationRetentionDays,
        auditRetentionDays: policy.auditRetentionDays,
      },
    };
    if (!dry) {
      await recordEvent(tx, {
        actorUserId: options.actorUserId ?? null,
        action: 'lifecycle.retention.run',
        targetType: 'Tenant',
        targetId: tenantId,
        outcome: 'success',
        sourceIp: null,
        payload: { ...report },
      });
    }
    return report;
  });
}

/** Every readiness check older than the cutoff except the newest per system, which is current evidence. */
async function staleReadinessCheckIds(tx: TenantClient, before: Date): Promise<string[]> {
  const old = await tx.connectionReadinessCheck.findMany({
    where: { checkedAt: { lt: before } },
    select: { id: true, systemKind: true, systemId: true, checkedAt: true },
  });
  if (old.length === 0) return [];
  const newest = await tx.connectionReadinessCheck.groupBy({
    by: ['systemKind', 'systemId'],
    _max: { checkedAt: true },
  });
  const keep = new Set(newest.map((row) => `${row.systemKind}:${row.systemId}:${row._max.checkedAt?.toISOString()}`));
  return old
    .filter((row) => !keep.has(`${row.systemKind}:${row.systemId}:${row.checkedAt.toISOString()}`))
    .map((row) => row.id);
}
