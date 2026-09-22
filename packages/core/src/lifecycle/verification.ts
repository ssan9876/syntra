export interface ExpectedTargetState {
  accountPresent: boolean;
  enabled: boolean;
  attributes: Record<string, string[]>;
  entitlements: string[];
}

export interface ObservedTargetState extends ExpectedTargetState {
  complete: boolean;
}

export interface StateDifference {
  path: string;
  expected: unknown;
  observed: unknown;
}

const normalized = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function compareObservedState(
  expected: ExpectedTargetState,
  observed: ObservedTargetState,
) {
  const differences: StateDifference[] = [];
  if (expected.accountPresent !== observed.accountPresent) {
    differences.push({
      path: 'accountPresent',
      expected: expected.accountPresent,
      observed: observed.accountPresent,
    });
  }
  if (expected.enabled !== observed.enabled) {
    differences.push({ path: 'enabled', expected: expected.enabled, observed: observed.enabled });
  }
  for (const key of Object.keys(expected.attributes).sort()) {
    const wanted = normalized(expected.attributes[key] ?? []);
    const found = normalized(observed.attributes[key] ?? []);
    if (!same(wanted, found)) {
      differences.push({ path: `attributes.${key}`, expected: wanted, observed: found });
    }
  }
  const wantedEntitlements = normalized(expected.entitlements);
  const foundEntitlements = normalized(observed.entitlements);
  if (!same(wantedEntitlements, foundEntitlements)) {
    differences.push({
      path: 'entitlements',
      expected: wantedEntitlements,
      observed: foundEntitlements,
    });
  }
  return {
    completeness: observed.complete ? ('complete' as const) : ('incomplete' as const),
    matches: observed.complete && differences.length === 0,
    differences,
  };
}

/** Persist normalized evidence; raw connector responses never become proof. */
export async function recordLifecycleObservation(
  tenantId: string,
  stepId: string,
  expected: ExpectedTargetState,
  observed: ObservedTargetState,
  options: { targetSystemId?: string; fingerprint?: string; expiresAt?: Date } = {},
) {
  const result = compareObservedState(expected, observed);
  return withTenant(tenantId, (tx) =>
    tx.lifecycleObservation.create({
      data: {
        tenantId,
        stepId,
        targetSystemId: options.targetSystemId ?? null,
        completeness: result.completeness,
        matches: result.matches,
        expected: expected as unknown as Prisma.InputJsonValue,
        observed: observed as unknown as Prisma.InputJsonValue,
        differences: result.differences as unknown as Prisma.InputJsonValue,
        fingerprint: options.fingerprint ?? null,
        expiresAt: options.expiresAt ?? null,
      },
    }),
  );
}

/**
 * Removes only observation payloads that were explicitly given an expiry.
 * Lifecycle operations and their step outcomes remain as durable audit facts;
 * this is retention for low-level target evidence, not a way to erase work.
 */
export async function pruneExpiredLifecycleObservations(
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  return withTenant(tenantId, async (tx) =>
    (await tx.lifecycleObservation.deleteMany({ where: { expiresAt: { lt: now } } })).count,
  );
}

export type SimulationKind = 'hire' | 'move' | 'leaver';

export function simulateLifecycle(
  kind: SimulationKind,
  current: Pick<ObservedTargetState, 'accountPresent' | 'enabled' | 'entitlements'>,
  desiredEntitlements: string[] = [],
) {
  const effects: string[] = [];
  if (kind === 'hire') {
    if (!current.accountPresent) effects.push('create account');
    if (!current.enabled) effects.push('enable account');
  } else {
    for (const entitlement of normalized(desiredEntitlements)) {
      if (!current.entitlements.includes(entitlement)) effects.push(`grant ${entitlement}`);
    }
    for (const entitlement of normalized(current.entitlements)) {
      if (!desiredEntitlements.includes(entitlement)) effects.push(`revoke ${entitlement}`);
    }
    if (kind === 'leaver' && current.enabled) effects.push('disable account');
  }
  return { kind, effects, writesPerformed: false as const };
}
import { Prisma, withTenant } from '@syntra/db';
