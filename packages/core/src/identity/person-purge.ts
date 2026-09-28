import { oplog } from '@syntra/connectors';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { departureDate } from '../provision/desired.js';
import { currentTenant } from '../tenant-context.js';
import { hardDeletePerson } from './person-deletion.js';

/**
 * AUTOMATIC DELETION OF PEOPLE WHO LEFT.
 *
 * A person is deleted for good once all of these hold:
 *   - the tenant's `personPurgeAfterDays` is set, and that many days have
 *     passed since their departure (the date the provisioning ladder uses:
 *     an administrative deactivation, else the last contract end);
 *   - they are inactive;
 *   - no person source owns them (the next import would create them again);
 *   - every account they hold on a target that deletes accounts
 *     (`deleteAfterDays` set) is already deleted there.
 * Accounts on targets that never delete are left as they are: disabled, and
 * no longer tracked once the person is gone.
 *
 * A pass that would delete more than {@link PURGE_MAX_SHARE} of all people
 * deletes nobody, logs a warning and audits `person.purge.held`: a feed that
 * marked everyone as a leaver must not become an empty directory 30 days on.
 */

export const PERSON_PURGE_JOB = 'identity.person-purge';
export const PURGE_MAX_SHARE = 0.1;
/** Below this many, the share rule does not apply: a tenant of 12 may lose 2. */
export const PURGE_SHARE_FLOOR = 5;
const DAY_MS = 86_400_000;

export interface PersonPurgePolicy {
  afterDays: number | null;
}

export async function readPersonPurgePolicy(tx: TenantClient): Promise<PersonPurgePolicy> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: await currentTenant(tx) },
    select: { personPurgeAfterDays: true },
  });
  return { afterDays: tenant.personPurgeAfterDays };
}

export async function setPersonPurgePolicy(
  tx: TenantClient,
  afterDays: number | null,
  actor: { userId: string; sourceIp: string | null },
): Promise<PersonPurgePolicy> {
  if (afterDays !== null && (!Number.isInteger(afterDays) || afterDays < 1 || afterDays > 3650)) {
    throw new RangeError('afterDays must be a whole number from 1 to 3650, or null');
  }
  const tenantId = await currentTenant(tx);
  const before = await readPersonPurgePolicy(tx);
  await tx.tenant.update({ where: { id: tenantId }, data: { personPurgeAfterDays: afterDays } });
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'person.purge_policy.updated',
    targetType: 'Tenant',
    targetId: tenantId,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: { before: before.afterDays, after: afterDays },
  });
  return { afterDays };
}

export interface PurgeCandidate {
  personId: string;
  departedAt: Date;
}

export interface PurgeOutcome {
  /** The policy was off. Nothing was read. */
  off: boolean;
  due: number;
  deleted: number;
  /** People past the date who still have an account to delete, or a source. */
  waiting: number;
  /** True when the share rule stopped the pass. */
  held: boolean;
}

/** People due for deletion now, and how many are past the date but still waiting. */
export async function findPurgeCandidates(
  tx: TenantClient,
  afterDays: number,
  now: Date,
): Promise<{ due: PurgeCandidate[]; waiting: number }> {
  const cutoff = new Date(now.getTime() - afterDays * DAY_MS);
  const people = await tx.person.findMany({
    where: { status: 'inactive' },
    select: {
      id: true,
      sourceId: true,
      departureOverride: true,
      contracts: { select: { id: true, sequence: true, isPrimary: true, startDate: true, endDate: true } },
      targetAccounts: {
        select: { status: true, target: { select: { deleteAfterDays: true } } },
      },
    },
  });
  const due: PurgeCandidate[] = [];
  let waiting = 0;
  for (const person of people) {
    const departedAt = departureDate(
      person.contracts.map((c) => ({
        id: c.id,
        sequence: c.sequence,
        isPrimary: c.isPrimary,
        startDate: c.startDate,
        endDate: c.endDate,
        department: null,
        jobTitle: null,
        costCentre: null,
        employer: null,
        location: null,
        fte: null,
      })),
      now,
      person.departureOverride,
    );
    if (departedAt === null || departedAt.getTime() > cutoff.getTime()) continue;
    const accountPending = person.targetAccounts.some(
      (a) => a.target.deleteAfterDays !== null && a.status !== 'deleted',
    );
    if (person.sourceId !== null || accountPending) {
      waiting += 1;
      continue;
    }
    due.push({ personId: person.id, departedAt });
  }
  return { due, waiting };
}

/** One pass for one tenant. Each deletion is its own transaction. */
export async function purgeDepartedPersons(tenantId: string, now: Date = new Date()): Promise<PurgeOutcome> {
  const scan = await withTenant(tenantId, async (tx) => {
    const policy = await readPersonPurgePolicy(tx);
    if (policy.afterDays === null) return null;
    const found = await findPurgeCandidates(tx, policy.afterDays, now);
    const total = await tx.person.count();
    return { ...found, total, afterDays: policy.afterDays };
  });
  if (scan === null) return { off: true, due: 0, deleted: 0, waiting: 0, held: false };

  const { due, waiting, total, afterDays } = scan;
  if (due.length > PURGE_SHARE_FLOOR && due.length > total * PURGE_MAX_SHARE) {
    oplog('warn', `person purge held: ${due.length} of ${total} people are due, above ${PURGE_MAX_SHARE * 100}%`, {
      tenantId,
      due: due.length,
      total,
    });
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'person.purge.held',
        targetType: 'Tenant',
        targetId: tenantId,
        outcome: 'failure',
        sourceIp: null,
        payload: { due: due.length, total, maxShare: PURGE_MAX_SHARE, personIds: due.map((c) => c.personId) },
      }),
    );
    return { off: false, due: due.length, deleted: 0, waiting, held: true };
  }

  let deleted = 0;
  for (const candidate of due) {
    try {
      await withTenant(tenantId, (tx) =>
        hardDeletePerson(tx, candidate.personId, {
          actorUserId: null,
          reason: `Automatic: departed ${candidate.departedAt.toISOString().slice(0, 10)}, over ${afterDays} days ago.`,
        }),
      );
      deleted += 1;
    } catch (error) {
      // One person refused (say, a privacy case opened since the scan) does
      // not stop the rest.
      oplog('warn', `person purge skipped ${candidate.personId}: ${error instanceof Error ? error.message : String(error)}`, {
        tenantId,
        personId: candidate.personId,
      });
    }
  }
  if (deleted > 0) oplog('info', `person purge deleted ${deleted} people`, { tenantId, deleted, waiting });
  return { off: false, due: due.length, deleted, waiting, held: false };
}

export interface PersonPurgePayload {
  tenantId: string;
}

export function registerPersonPurgeJobs(scheduler: Scheduler): void {
  scheduler.register<PersonPurgePayload>(PERSON_PURGE_JOB, async ({ tenantId }) => {
    await purgeDepartedPersons(tenantId);
  });
}

/** Daily at 03:30. The pass is one read per tenant while the policy is off. */
export async function schedulePersonPurge(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(PERSON_PURGE_JOB, '30 3 * * *', { tenantId }, `person-purge-${tenantId}`);
}
