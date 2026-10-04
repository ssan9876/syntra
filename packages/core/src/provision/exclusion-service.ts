import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';

/**
 * Leaving one person out of one target.
 *
 * Business rules match contract fields and are additive: any enabled rule
 * that matches grants the account, and there is no rule that takes one away.
 * So a rule cannot keep one named person out of a target -- the bootstrap
 * administrator of the application the target writes to, say, whom the
 * application refuses to let anybody else manage. This row can, and it wins
 * over every rule:
 *
 * - no account is created for the person there, and a `pending` reservation
 *   with no anchor is removed (it names nothing at the target);
 * - the account they already have is left exactly as it is: no update,
 *   enable, disable, archive, delete, rename, grant or revoke, and its row
 *   stays;
 * - their Syntra sign-in still follows their employment where this target is
 *   the paired directory target: that is not an account on the target, and a
 *   leaver's login staying active is the failure this subsystem exists to
 *   prevent;
 * - removing the row hands them back to the rules on the next run.
 */

export class ExclusionSubjectNotFoundError extends Error {
  constructor(readonly subject: 'target' | 'person') {
    super(subject === 'target' ? 'Target not found.' : 'Person not found.');
    this.name = 'ExclusionSubjectNotFoundError';
  }
}

export class AlreadyLeftOutError extends Error {
  constructor(personName: string, targetName: string) {
    super(`${personName} is already left out of target "${targetName}".`);
    this.name = 'AlreadyLeftOutError';
  }
}

export class NotLeftOutError extends Error {
  constructor(personName: string, targetName: string) {
    super(`${personName} is not left out of target "${targetName}".`);
    this.name = 'NotLeftOutError';
  }
}

/**
 * Refused because the person is left out of the target: the write would be
 * Syntra managing an account it has been told to leave alone.
 */
export class PersonLeftOutError extends Error {
  constructor(personName: string, targetName: string) {
    super(`${personName} is left out of target "${targetName}". Include them again first.`);
    this.name = 'PersonLeftOutError';
  }
}

export interface TargetExclusionView {
  targetSystemId: string;
  targetName: string;
  personId: string;
  personName: string;
  businessEmail: string | null;
  reason: string;
  createdByUserId: string | null;
  /** The administrator's display name, or null when they are gone or unknown. */
  createdByName: string | null;
  createdAt: Date;
  /** `Left out of this target by Jane Doe on 3 Oct 2026: <reason>.` */
  message: string;
}

const shortDate = (d: Date): string =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const fullName = (p: { givenName: string; familyName: string }) =>
  `${p.givenName} ${p.familyName}`.trim();

export function leftOutMessage(exclusion: {
  createdByName: string | null;
  createdAt: Date;
  reason: string;
}): string {
  const by = exclusion.createdByName === null ? '' : ` by ${exclusion.createdByName}`;
  const reason = exclusion.reason.trim().replace(/\.$/, '');
  return `Left out of this target${by} on ${shortDate(exclusion.createdAt)}: ${reason}.`;
}

async function views(
  tx: TenantClient,
  where: { targetSystemId?: string; personId?: string },
): Promise<TargetExclusionView[]> {
  const rows = await tx.targetPersonExclusion.findMany({
    where,
    include: {
      targetSystem: { select: { name: true } },
      person: { select: { givenName: true, familyName: true, businessEmail: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const userIds = [
    ...new Set(rows.map((r) => r.createdByUserId).filter((id): id is string => id !== null)),
  ];
  const users =
    userIds.length === 0
      ? []
      : await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true },
        });
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((row) => {
    const createdByName =
      row.createdByUserId === null ? null : (nameOf.get(row.createdByUserId) ?? null);
    return {
      targetSystemId: row.targetSystemId,
      targetName: row.targetSystem.name,
      personId: row.personId,
      personName: fullName(row.person),
      businessEmail: row.person.businessEmail,
      reason: row.reason,
      createdByUserId: row.createdByUserId,
      createdByName,
      createdAt: row.createdAt,
      message: leftOutMessage({ createdByName, createdAt: row.createdAt, reason: row.reason }),
    };
  });
}

/** Everybody left out of one target, oldest first. */
export function listTargetExclusions(
  tx: TenantClient,
  targetSystemId: string,
): Promise<TargetExclusionView[]> {
  return views(tx, { targetSystemId });
}

/** Every target one person is left out of. */
export function listPersonExclusions(
  tx: TenantClient,
  personId: string,
): Promise<TargetExclusionView[]> {
  return views(tx, { personId });
}

/** The ids of everybody left out of one target. */
export async function leftOutPersonIds(
  tx: TenantClient,
  targetSystemId: string,
): Promise<Set<string>> {
  const rows = await tx.targetPersonExclusion.findMany({
    where: { targetSystemId },
    select: { personId: true },
  });
  return new Set(rows.map((r) => r.personId));
}

/**
 * Throws `PersonLeftOutError` when the person is left out of the target.
 * For the manual paths that write to one account: a move, an adoption.
 */
export async function assertNotLeftOut(
  tx: TenantClient,
  personId: string,
  targetSystemId: string,
): Promise<void> {
  const row = await tx.targetPersonExclusion.findUnique({
    where: { targetSystemId_personId: { targetSystemId, personId } },
    select: {
      person: { select: { givenName: true, familyName: true } },
      targetSystem: { select: { name: true } },
    },
  });
  if (row !== null) throw new PersonLeftOutError(fullName(row.person), row.targetSystem.name);
}

async function subjects(tx: TenantClient, targetSystemId: string, personId: string) {
  // Both looked up in this tenant before anything is written: PostgreSQL
  // checks a foreign key without applying RLS to the referenced table, so an
  // insert naming another tenant's person would otherwise pass.
  const [target, person] = await Promise.all([
    tx.targetSystem.findUnique({ where: { id: targetSystemId }, select: { name: true } }),
    tx.person.findUnique({
      where: { id: personId },
      select: { givenName: true, familyName: true },
    }),
  ]);
  if (target === null) throw new ExclusionSubjectNotFoundError('target');
  if (person === null) throw new ExclusionSubjectNotFoundError('person');
  return { targetName: target.name, personName: fullName(person) };
}

export interface ExclusionChange {
  targetSystemId: string;
  personId: string;
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
}

/**
 * Leaves the person out of the target, with the audit event.
 *
 * A `pending` account row with no anchor is removed in the same transaction.
 * It is a reserved name and nothing more: nothing exists at the target, so
 * there is nothing to leave alone, and kept it would hold the name for an
 * account that is never created. Every other row stays exactly as it is.
 */
export async function addTargetExclusion(
  tx: TenantClient,
  input: ExclusionChange,
): Promise<TargetExclusionView> {
  const tenantId = await currentTenant(tx);
  const { targetName, personName } = await subjects(tx, input.targetSystemId, input.personId);
  const existing = await tx.targetPersonExclusion.findUnique({
    where: {
      targetSystemId_personId: { targetSystemId: input.targetSystemId, personId: input.personId },
    },
    select: { id: true },
  });
  if (existing !== null) throw new AlreadyLeftOutError(personName, targetName);

  const reason = input.reason.trim();
  await tx.targetPersonExclusion.create({
    data: {
      tenantId,
      targetSystemId: input.targetSystemId,
      personId: input.personId,
      reason,
      createdByUserId: input.actorUserId,
    },
  });
  const removed = await tx.targetAccount.deleteMany({
    where: {
      targetSystemId: input.targetSystemId,
      personId: input.personId,
      status: 'pending',
      anchor: null,
    },
  });

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'provision.target.exclusion.add',
    targetType: 'Person',
    targetId: input.personId,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: {
      targetSystemId: input.targetSystemId,
      reason,
      pendingAccountRemoved: removed.count > 0,
    },
  });

  const [view] = await views(tx, { targetSystemId: input.targetSystemId, personId: input.personId });
  return view!;
}

/**
 * Hands the person back to the rules, with the audit event. Nothing is
 * written to the target here: the next run evaluates the rules for them like
 * anybody else, through the guard, in a plan somebody can review.
 */
export async function removeTargetExclusion(
  tx: TenantClient,
  input: ExclusionChange,
): Promise<void> {
  const { targetName, personName } = await subjects(tx, input.targetSystemId, input.personId);
  const { count } = await tx.targetPersonExclusion.deleteMany({
    where: { targetSystemId: input.targetSystemId, personId: input.personId },
  });
  if (count === 0) throw new NotLeftOutError(personName, targetName);

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'provision.target.exclusion.remove',
    targetType: 'Person',
    targetId: input.personId,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: { targetSystemId: input.targetSystemId, reason: input.reason.trim() },
  });
}
