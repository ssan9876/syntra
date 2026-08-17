import { withTenant, type TenantClient } from '@syntra/db';
import {
  adTargetConnector,
  type AdTargetConfig,
  type DiscoveredEntitlement,
  type TargetConnector,
} from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';

/**
 * Entitlements named by at least one business rule for this target.
 *
 * Provision's remit. "Provision manages this target" and "Provision manages
 * every group in this target" are different claims, and only the first is
 * ever true — so a group no rule mentions is never revoked, in either
 * enforcement mode.
 *
 * Rules are counted whether or not they are `enabled`. That is a deliberate
 * choice and it is visible in exactly one place: under `authoritative`,
 * `reconcile.ts` proposes revoking an in-remit entitlement the target holds
 * and Provision never granted. Narrowing the remit to enabled rules would make
 * disabling a rule quietly stop that; widening it, as here, means the remit is
 * a statement about what an administrator has configured this target to care
 * about rather than about what is switched on this minute. Entitlements
 * Provision itself granted are revoked regardless of the remit — `reconcile`
 * treats a recorded grant as its own to keep converging — so the two readings
 * differ only over holdings Provision never made.
 */
export async function remitFor(
  tx: TenantClient,
  targetId: string,
): Promise<Set<string>> {
  const joins = await tx.ruleEntitlement.findMany({
    where: { rule: { targetSystemId: targetId } },
    select: { entitlementId: true },
  });
  return new Set(joins.map((j) => j.entitlementId));
}

/**
 * Thrown when a catalog read returned nothing and the catalog is not empty.
 *
 * See `refreshEntitlements`. Carries the count it declined to condemn so the
 * caller can say how big the refusal was.
 */
export class EmptyEntitlementReadError extends Error {
  constructor(readonly known: number) {
    super(
      `the target returned no entitlements at all while Syntra holds ${known} for it; ` +
        'refusing to mark the whole catalog missing, because a mistyped ' +
        'entitlementSearchBase and a domain whose every group was deleted look ' +
        'identical from here and only one of them is a thing that happens',
    );
    this.name = 'EmptyEntitlementReadError';
  }
}

/** The one member of the connector this function uses. */
type EntitlementReader = Pick<
  TargetConnector<AdTargetConfig & { bindPassword: string }>,
  'listEntitlements'
>;

/**
 * Reads the target's entitlement catalog and reconciles it with Syntra's.
 *
 * Phased: the network read happens outside any transaction, and the write is
 * one short transaction afterwards.
 *
 * An entitlement Syntra knows and the target no longer offers becomes
 * `missing` rather than being deleted. Deleting it would orphan every
 * AccountEntitlement pointing at it and, worse, silently narrow every rule
 * that named it — which produces a desired set lacking it and proposes
 * revoking it from everybody. `missing` makes those rules unresolvable
 * instead, which is loud.
 *
 * `connector` is injectable so this can be exercised against a fake. The
 * default is the real Active Directory connector, so no caller has to know
 * that it is injectable.
 */
export async function refreshEntitlements(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
  connector: EntitlementReader = adTargetConnector,
): Promise<{ present: number; missing: number }> {
  // Phase 1: read the configuration out, then close the transaction.
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetId),
  );
  if (!config) throw new Error('target configuration or credential missing');

  // Phase 2: the network read. No transaction is held.
  const discovered: DiscoveredEntitlement[] = [];
  for await (const entitlement of connector.listEntitlements(config)) {
    discovered.push(entitlement);
  }

  // Phase 3: one short transaction for the whole catalog update.
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const now = new Date();
    const seen = new Set<string>();

    /**
     * An empty read does not condemn a whole catalog.
     *
     * With `seen` empty, the `notIn: []` below matches every row, so one read
     * that came back with nothing marks every entitlement of this target
     * `missing` — and a missing entitlement makes every rule naming it
     * unresolvable, which makes every person the rule touches unprocessable
     * for grants. A mistyped `entitlementSearchBase`, a base moved by a domain
     * restructure, or a bind that lost its read right on the groups container
     * all produce exactly this: zero results, no error.
     *
     * This is the shape the empty needle had in Ruling P20, the other way up.
     * There the empty pattern matched everybody; here the empty result set
     * condemns everybody. Both are the case where "nothing" is silently read
     * as "everything".
     *
     * A first refresh against a target Syntra knows no entitlements for is
     * untouched — nothing is condemned, because there is nothing to condemn —
     * so the ordinary path through this function is unaffected.
     */
    if (discovered.length === 0) {
      const known = await tx.entitlement.count({
        where: { targetSystemId: targetId },
      });
      if (known > 0) throw new EmptyEntitlementReadError(known);
    }

    for (const entitlement of discovered) {
      seen.add(entitlement.externalId);
      await tx.entitlement.upsert({
        where: {
          tenantId_targetSystemId_externalId: {
            tenantId: bound,
            targetSystemId: targetId,
            externalId: entitlement.externalId,
          },
        },
        create: {
          tenantId: bound,
          targetSystemId: targetId,
          externalId: entitlement.externalId,
          // Persisted so the person-access view and the rules editor can show
          // where a group lives without a second directory read. The identity
          // is still the externalId; this is allowed to go stale between
          // refreshes, and the run reads a live one in its own phase 4.
          dn: entitlement.dn,
          type: entitlement.type,
          displayName: entitlement.displayName,
          description: entitlement.description ?? null,
          status: 'present',
          lastSeenAt: now,
        },
        update: {
          dn: entitlement.dn,
          type: entitlement.type,
          displayName: entitlement.displayName,
          description: entitlement.description ?? null,
          // `status` is deliberately NOT written here. This function knows
          // whether a group is in the catalog; it knows nothing about whether
          // its membership could be read. Writing `present` unconditionally
          // would clear an `unreadable` the run had set, and a rule naming
          // that group would become resolvable again -- evaluated against a
          // membership nobody could read. The line below promotes `missing`
          // back to `present` and leaves `unreadable` alone.
          lastSeenAt: now,
        },
      });
    }

    await tx.entitlement.updateMany({
      where: {
        targetSystemId: targetId,
        externalId: { in: [...seen] },
        status: 'missing',
      },
      data: { status: 'present' },
    });

    const missing = await tx.entitlement.updateMany({
      where: {
        targetSystemId: targetId,
        externalId: { notIn: [...seen] },
        status: { not: 'missing' },
      },
      data: { status: 'missing' },
    });

    // `seen.size`, not `discovered.length`: a target that returns the same
    // group twice in one page walk has one entitlement, and the upsert makes
    // one row of it. Reporting the raw count would have the audit event and
    // the return value disagree with the table they describe.
    const present = seen.size;

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.entitlements.refresh',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: { present, missing: missing.count },
    });

    return { present, missing: missing.count };
  });
}
