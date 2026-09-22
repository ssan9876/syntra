import { Prisma, withTenant } from '@syntra/db';
import {
  accessDeltaFor,
  projectPersonOnTargets,
  type AccessDelta,
} from '../provision/desired-state-loader.js';
import { readLifecyclePolicy } from './policy.js';
import type { ContractOverride } from '../provision/desired-state-loader.js';

export type LifecycleSimulationKind = 'hire' | 'move' | 'leaver';
const MS_PER_DAY = 86_400_000;

export interface SimulatedTarget extends AccessDelta {
  /**
   * The ladder a departure would follow on this target, from the target's
   * own timers. Present only for a leaver rehearsal.
   */
  departure?: {
    disableAt: string;
    revokeEntitlementsAt: string;
    archiveAt: string | null;
  };
  /** Which advertised capability each step needs, and whether it is there. */
  blockers: string[];
  verificationCoverage: 'read-back' | 'manual';
}

export interface PersonSimulation {
  personId: string;
  personName: string;
  department: string | null;
  targets: SimulatedTarget[];
  syntraLogins: { userId: string; login: string; status: string; effect: 'deactivate' | 'keep' | 'none' }[];
  summary: string[];
}

export interface SimulationResult {
  kind: LifecycleSimulationKind;
  scope: 'person' | 'department';
  writesPerformed: false;
  computedAt: string;
  people: PersonSimulation[];
  unsupported: string[];
  safetyBlockers: string[];
}

function capabilityFor(type: string): { readBack: boolean; create: boolean; disable: boolean; entitlements: boolean } {
  // Kept in step with `@syntra/connectors` capabilities. Read here as a plain
  // table so a simulation never opens a connector even to ask what it can do.
  switch (type) {
    case 'activeDirectory':
    case 'entraId':
    case 'httpJson':
      return { readBack: true, create: true, disable: true, entitlements: true };
    case 'scim2':
      return { readBack: true, create: true, disable: true, entitlements: false };
    default:
      return { readBack: false, create: false, disable: false, entitlements: false };
  }
}

async function simulatePerson(
  tenantId: string,
  personId: string,
  kind: LifecycleSimulationKind,
  now: Date,
  changes: Omit<ContractOverride, 'sequence'> | undefined,
): Promise<PersonSimulation> {
  const { person, primary, logins } = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      include: { contracts: { orderBy: { sequence: 'asc' } } },
    });
    const primary = person.contracts.find((c) => c.isPrimary) ?? person.contracts[0] ?? null;
    const logins = await tx.user.findMany({
      where: { personId },
      select: { id: true, login: true, status: true },
      orderBy: { login: 'asc' },
    });
    return { person, primary, logins };
  });
  const override: ContractOverride | undefined =
    primary === null
      ? undefined
      : kind === 'leaver'
        // Ended yesterday: a contract whose last day is today is still in force
        // today, and the rehearsal is of the day after the person has gone.
        ? { sequence: primary.sequence, endDate: new Date(now.getTime() - MS_PER_DAY) }
        : kind === 'move'
          ? { sequence: primary.sequence, ...(changes ?? {}) }
          : undefined;
  const projections = await projectPersonOnTargets(tenantId, personId, {
    now,
    ...(override ? { contractOverride: override } : {}),
  });
  const targets: SimulatedTarget[] = projections.map((projection) => {
    const delta = accessDeltaFor(projection);
    const capability = capabilityFor(projection.targetType);
    const blockers: string[] = [];
    if (!projection.hasProfile) blockers.push('no account profile');
    if (delta.account === 'create' && !capability.create) blockers.push('connector cannot create accounts');
    if (delta.account === 'disable' && !capability.disable) blockers.push('connector cannot disable accounts');
    if ((delta.add.length > 0 || delta.remove.length > 0) && !capability.entitlements) {
      blockers.push('connector cannot manage entitlements');
    }
    if (delta.unverified) blockers.push('entitlement catalog not confirmed against the target');
    if (delta.unprocessable) blockers.push(delta.unprocessable.message);
    const unmanageable = [...delta.add, ...delta.remove].filter(
      (change) => projection.entitlements.get(change.entitlementId)?.manageable === false,
    );
    for (const change of unmanageable) blockers.push(`${change.displayName} is not manageable (dynamic or unsupported group)`);
    const simulated: SimulatedTarget = {
      ...delta,
      blockers,
      verificationCoverage: capability.readBack ? 'read-back' : 'manual',
    };
    if (kind === 'leaver') {
      const disableAt = new Date(now.getTime() + projection.ladder.disableGraceDays * MS_PER_DAY);
      const revokeAt = new Date(now.getTime() + projection.ladder.entitlementRevocationDelayDays * MS_PER_DAY);
      simulated.departure = {
        disableAt: disableAt.toISOString(),
        revokeEntitlementsAt: revokeAt.toISOString(),
        archiveAt:
          projection.ladder.archiveAfterDays === null
            ? null
            : new Date(now.getTime() + projection.ladder.archiveAfterDays * MS_PER_DAY).toISOString(),
      };
    }
    return simulated;
  });
  const syntraLogins = logins.map((login) => ({
    userId: login.id,
    login: login.login,
    status: login.status,
    effect:
      kind === 'leaver' && login.status === 'active'
        ? ('deactivate' as const)
        : kind === 'leaver'
          ? ('none' as const)
          : ('keep' as const),
  }));
  const summary: string[] = [];
  for (const target of targets) {
    const parts: string[] = [];
    if (target.account !== 'none' && target.account !== 'keep') parts.push(`${target.account} account`);
    if (target.add.length) parts.push(`grant ${target.add.map((a) => a.displayName).join(', ')}`);
    if (target.remove.length) parts.push(`revoke ${target.remove.map((r) => r.displayName).join(', ')}`);
    if (parts.length === 0) parts.push('no change');
    summary.push(`${target.targetName}: ${parts.join('; ')}${target.blockers.length ? ` (blocked: ${target.blockers.join('; ')})` : ''}`);
  }
  if (kind === 'leaver' && syntraLogins.some((l) => l.effect === 'deactivate')) {
    summary.push(`Syntra: deactivate ${syntraLogins.filter((l) => l.effect === 'deactivate').length} sign-in(s)`);
  }
  return {
    personId,
    personName: `${person.givenName} ${person.familyName}`,
    department: primary?.department ?? null,
    targets,
    syntraLogins,
    summary,
  };
}

export interface SimulationRequest {
  kind: LifecycleSimulationKind;
  personId?: string;
  department?: string;
  /** For a mover rehearsal: the contract fields to change. */
  changes?: Omit<ContractOverride, 'sequence'>;
  /** Cap on people in a department sweep. */
  limit?: number;
  now?: Date;
}

/**
 * Computes the whole rehearsal with the planner and no connector, then
 * stores it so a reviewer can point at what they approved. Never calls a
 * connector mutation: the loader it uses has no connector at all.
 */
export async function runLifecycleSimulation(
  tenantId: string,
  request: SimulationRequest,
  actorUserId: string | null,
) {
  const now = request.now ?? new Date();
  const limit = Math.min(Math.max(request.limit ?? 100, 1), 500);
  const personIds = request.personId
    ? [request.personId]
    : await withTenant(tenantId, (tx) =>
        tx.person
          .findMany({
            where: {
              status: 'active',
              contracts: { some: { department: request.department ?? null, isPrimary: true } },
            },
            select: { id: true },
            orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
            take: limit,
          })
          .then((rows) => rows.map((row) => row.id)),
      );
  const people: PersonSimulation[] = [];
  for (const personId of personIds) {
    people.push(await simulatePerson(tenantId, personId, request.kind, now, request.changes));
  }
  const unsupported = [...new Set(people.flatMap((p) => p.targets.flatMap((t) => t.blockers.filter((b) => b.includes('connector cannot') || b.includes('not manageable')))))];
  const safetyBlockers = [...new Set(people.flatMap((p) => p.targets.flatMap((t) => t.blockers.filter((b) => !unsupported.includes(b)))))];
  const result: SimulationResult = {
    kind: request.kind,
    scope: request.personId ? 'person' : 'department',
    writesPerformed: false,
    computedAt: now.toISOString(),
    people,
    unsupported,
    safetyBlockers,
  };
  const policy = await withTenant(tenantId, readLifecyclePolicy);
  return withTenant(tenantId, (tx) =>
    tx.lifecycleSimulation.create({
      data: {
        tenantId,
        kind: request.kind,
        scope: result.scope,
        personId: request.personId ?? null,
        department: request.department ?? null,
        input: JSON.parse(JSON.stringify({ changes: request.changes ?? null, limit })) as Prisma.InputJsonValue,
        result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        peopleCount: people.length,
        writesPerformed: false,
        createdByUserId: actorUserId,
        expiresAt: new Date(now.getTime() + policy.simulationRetentionDays * MS_PER_DAY),
      },
    }),
  );
}

export async function listLifecycleSimulations(tenantId: string, limit = 50) {
  return withTenant(tenantId, (tx) =>
    tx.lifecycleSimulation.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: {
        id: true,
        kind: true,
        scope: true,
        personId: true,
        department: true,
        peopleCount: true,
        createdByUserId: true,
        createdAt: true,
        expiresAt: true,
      },
    }),
  );
}

export async function getLifecycleSimulation(tenantId: string, id: string) {
  return withTenant(tenantId, (tx) => tx.lifecycleSimulation.findFirstOrThrow({ where: { id } }));
}
