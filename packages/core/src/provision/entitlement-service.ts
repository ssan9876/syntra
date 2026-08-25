import { withTenant, type TenantClient } from '@syntra/db';
import type { DiscoveredEntitlement, TargetConnector } from '@syntra/connectors';
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
 * **A disabled rule's entitlements are out of remit (Ruling P27).** Task 12
 * kept the wider reading, pinned it with a test, and asked for a ruling before
 * Task 13; the ruling came back the other way and this is where it lands. The
 * difference is visible in exactly one place: under `authoritative`,
 * `reconcile.ts` proposes revoking an in-remit entitlement the target holds and
 * Provision never granted. Counting a disabled rule would mean that **disabling
 * a rule broadens what Provision deletes**, which is the opposite of what
 * anyone expects from switching something off and the wrong direction for a
 * destructive action. Those holdings become unmanaged instead: left alone and
 * reported as drift, per Ruling P2 — "I saw this and left it", never "I did not
 * look".
 *
 * Entitlements Provision itself granted are revoked regardless of the remit —
 * `reconcile` treats a recorded grant as its own to keep converging — so the
 * two readings differ only over holdings Provision never made. Cost if wrong:
 * an entitlement an administrator wanted removed is reported rather than
 * revoked, visibly, until they re-enable the rule or revoke it by hand.
 */
export async function remitFor(
  tx: TenantClient,
  targetId: string,
): Promise<Set<string>> {
  const joins = await tx.ruleEntitlement.findMany({
    where: { rule: { targetSystemId: targetId, enabled: true } },
    select: { entitlementId: true },
  });
  return new Set(joins.map((j) => j.entitlementId));
}

/**
 * Entitlements on this target that a LIVE AccessGrant names.
 *
 * Deliberately NOT unioned into `remitFor`. The remit is the tenant-wide set
 * `reconcile` classifies EVERY account's holdings against, and one person's
 * approved request must not change what five hundred other people's holdings
 * mean: nobody has ever requested "Stats", no rule names it, five hundred
 * people hold it by hand, and Anna's approved request would reclassify all
 * five hundred at once as `unmanaged_entitlement` with
 * `proposedForRevocation` under `authoritative`. Provision's per-entitlement
 * guard axis would make that run confirmable rather than silent, but a run
 * that suddenly wants to revoke five hundred holdings because one person
 * asked for something is not a review a human can do usefully.
 *
 * The revocation path does not need it either: `reconcile` puts an
 * entitlement into `heldWithinRemit` unconditionally when Provision granted
 * it, before the remit is consulted, so a requested entitlement that leaves
 * desired state is differenced out and revoked whether or not it is in remit.
 *
 * This set is for the two consumers that are PER ACCOUNT and where the
 * omission is a real defect: `apply.ts`'s `archive_account` strip list, which
 * would otherwise leave a requested membership on an archived account, and
 * `run-service.ts`'s unreadable-membership probe, which would otherwise never
 * look at the groups requests put people into.
 *
 * `expired`, `lapsed` and `revoked` are excluded, so the set narrows again
 * when the last grant ends.
 */
export async function grantedEntitlementsFor(
  tx: TenantClient,
  targetId: string,
): Promise<Set<string>> {
  const granted = await tx.accessGrant.findMany({
    where: {
      targetSystemId: targetId,
      resourceType: 'entitlement',
      status: { in: ['scheduled', 'pending', 'active'] },
    },
    select: { resourceId: true },
  });
  return new Set(granted.map((g) => g.resourceId));
}

/**
 * Thrown when a catalog read identified nothing and the catalog is not empty.
 *
 * See `refreshEntitlements`. Carries the count it declined to condemn so the
 * caller can say how big the refusal was, and the number of groups that came
 * back **unidentifiable** — read, but carrying no anchor to key them on.
 *
 * The two cases are one refusal because they are one failure: Syntra cannot
 * name a single entitlement of this target, so it must not conclude that the
 * ones it knows are gone. They carry different messages because the thing to
 * go and fix is different — a search base in the first case, an
 * `anchorAttribute` or the bind's read rights in the second.
 */
export class EmptyEntitlementReadError extends Error {
  constructor(
    readonly known: number,
    readonly unidentifiable = 0,
  ) {
    super(
      unidentifiable === 0
        ? `the target returned no entitlements at all while Syntra holds ${known} for it; ` +
            'refusing to mark the whole catalog missing, because a mistyped ' +
            'entitlementSearchBase and a domain whose every group was deleted look ' +
            'identical from here and only one of them is a thing that happens'
        : `the target returned ${unidentifiable} entitlements and Syntra could identify ` +
            `none of them — every one came back with a blank anchor — while Syntra holds ` +
            `${known} for it; refusing to mark the whole catalog missing, because an ` +
            'anchorAttribute the group objects do not carry and a bind without read ' +
            'access to the one they do carry both look exactly like this, and Active ' +
            'Directory omits an attribute it will not show you rather than saying so',
    );
    this.name = 'EmptyEntitlementReadError';
  }
}

/** The one member of the connector this function uses. */
type EntitlementReader = Pick<TargetConnector<never>, 'listEntitlements'>;

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
 * `connector` is required rather than defaulted: which connector reads this
 * target's catalog depends on `TargetSystem.type`, which is not knowable at
 * this function's own definition — a default *value* cannot be "resolved by
 * type" without a type to resolve from. Every caller already has the target
 * row in scope (entitlement refresh is always invoked with a `targetId` a
 * caller has just loaded the target for), so this asks for
 * `targetConnectorFor(target.type)` rather than assuming one.
 */
export async function refreshEntitlements(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
  connector: EntitlementReader,
): Promise<{ present: number; missing: number; unidentifiable: number }> {
  // Phase 1: read the configuration out, then close the transaction.
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetId),
  );
  if (!config) throw new Error('target configuration or credential missing');

  // Phase 2: the network read. No transaction is held.
  const discovered: DiscoveredEntitlement[] = [];
  for await (const entitlement of connector.listEntitlements(config as never)) {
    discovered.push(entitlement);
  }

  // Phase 3: one short transaction for the whole catalog update.
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const now = new Date();
    const seen = new Set<string>();

    /**
     * The identifiable groups, keyed by anchor — and the count of the ones
     * that carried no anchor at all.
     *
     * Built BEFORE the refusal below, because "how many groups came back" and
     * "how many of them can Syntra name" are different numbers and only the
     * second one is the guard's input.
     *
     * `anchorOf` in the AD connector is `String(source ?? '')`, so a group
     * whose anchor attribute is absent yields the EMPTY STRING rather than
     * `undefined`, and the connector yields it regardless. Left in, every such
     * group collapses onto one `byExternalId` entry, one row is inserted with
     * `externalId: ''` — `@@unique([tenantId, targetSystemId, externalId])`
     * makes it exactly one — and the sweep at the bottom of this function
     * marks every REAL entitlement of the target `missing`, which makes every
     * rule naming one unresolvable and every person those rules touch
     * unprocessable for grants. The audit event says `outcome: 'success'`.
     *
     * This is the same value the rest of this subsystem already refuses:
     * `syntra-user.ts` writes `a."anchor" IS NOT NULL AND a."anchor" <> ''`
     * because a blank anchor joining to everything is the same defect as a
     * blank `contains` matching every person, and the connector refuses a
     * non-exact anchor rather than widening. This was the one consumer that
     * accepted a blank one.
     *
     * Skipped rather than substituted: there is no key to invent for a group
     * whose identity the target did not report, and a synthesised one (the DN,
     * the name) would be a second identity for an object that already has one
     * — which is how the next refresh, after the read right is restored,
     * inserts every group a second time.
     */
    const byExternalId = new Map<string, DiscoveredEntitlement>();
    let unidentifiable = 0;
    for (const entitlement of discovered) {
      if (entitlement.externalId === '') {
        unidentifiable += 1;
        continue;
      }
      // Last wins. The map is also what makes a target that returns the same
      // group twice in one page walk one row rather than two writes.
      byExternalId.set(entitlement.externalId, entitlement);
      seen.add(entitlement.externalId);
    }

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
     *
     * Keyed on `seen.size`, not on `discovered.length`. "The target returned
     * nothing" and "the target returned five thousand groups and Syntra could
     * identify none of them" reach this sweep by the same route and do the
     * same damage, so they refuse together; `discovered.length === 0` alone
     * left the second one one step to the side of the guard. A read that
     * identified even one group is NOT refused here, which is the same
     * judgement the guard already made about a partial read: this function
     * cannot tell a half-read catalog from a half-deleted one, and only the
     * total loss of identification is unambiguous.
     */
    if (seen.size === 0) {
      const known = await tx.entitlement.count({
        where: { targetSystemId: targetId },
      });
      if (known > 0) throw new EmptyEntitlementReadError(known, unidentifiable);
    }

    /**
     * The catalog write, in a bounded number of statements rather than one
     * per group.
     *
     * A per-group `upsert` is one round trip each, and `withTenant` is
     * `prisma.$transaction(fn)` on Prisma's five-second default. An Active
     * Directory domain with five thousand groups — ordinary at the size of
     * directory this product is aimed at — exceeds that budget and aborts with
     * P2028, rolling the whole refresh back; retrying re-runs the same
     * statements against the same volume, so the catalog can never be
     * populated at all and the failure is permanent rather than transient.
     *
     * Splitting the transaction is not the way out. A half-written catalog
     * followed by the sweep below would mark everything the write had not
     * reached yet as `missing`, which is the same fail-open the empty-read
     * refusal above exists to prevent, arrived at from inside. So the
     * transaction stays one transaction and what shrinks is the number of
     * statements in it: read, insert the new ones, stamp `lastSeenAt`, promote,
     * sweep — five, plus one update per group whose metadata actually changed,
     * which on a directory that did not change is none.
     */
    const knownRows = await tx.entitlement.findMany({
      where: { targetSystemId: targetId },
      select: {
        id: true,
        externalId: true,
        dn: true,
        type: true,
        displayName: true,
        description: true,
      },
    });
    const knownByExternalId = new Map(knownRows.map((row) => [row.externalId, row]));

    const fresh = [...byExternalId.values()].filter(
      (entitlement) => !knownByExternalId.has(entitlement.externalId),
    );
    if (fresh.length > 0) {
      await tx.entitlement.createMany({
        data: fresh.map((entitlement) => ({
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
        })),
        // A concurrent refresh may have inserted the same group between the
        // read above and this write. Skipping is right: the row exists, with
        // that refresh's metadata, and the next refresh reconciles it. The
        // alternative is a P2002 that rolls back a catalog update over a row
        // that already says what this one was going to say.
        skipDuplicates: true,
      });
    }

    for (const [externalId, entitlement] of byExternalId) {
      const row = knownByExternalId.get(externalId);
      if (row === undefined) continue;
      const description = entitlement.description ?? null;
      if (
        row.dn === entitlement.dn &&
        row.type === entitlement.type &&
        row.displayName === entitlement.displayName &&
        row.description === description
      ) {
        continue;
      }
      await tx.entitlement.update({
        where: { id: row.id },
        data: {
          dn: entitlement.dn,
          type: entitlement.type,
          displayName: entitlement.displayName,
          description,
          // `status` is deliberately NOT written here. This function knows
          // whether a group is in the catalog; it knows nothing about whether
          // its membership could be read. Writing `present` unconditionally
          // would clear an `unreadable` the run had set, and a rule naming
          // that group would become resolvable again -- evaluated against a
          // membership nobody could read. The promotion below moves `missing`
          // back to `present` and leaves `unreadable` alone.
        },
      });
    }

    if (seen.size > 0) {
      await tx.entitlement.updateMany({
        where: { targetSystemId: targetId, externalId: { in: [...seen] } },
        data: { lastSeenAt: now },
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
      // Reported even when it is zero, and reported on the path that did NOT
      // refuse. A read where most groups are anchorless and a few are not
      // passes the guard above — correctly, since one identified group means
      // the read is not a total loss — and then marks the rest `missing`. That
      // is the shape an administrator has to be able to see afterwards, so the
      // number is in the chain rather than only in an exception nobody got.
      payload: { present, missing: missing.count, unidentifiable },
    });

    return { present, missing: missing.count, unidentifiable };
  });
}
