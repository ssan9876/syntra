import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { DiscoveredEntitlement } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertBusinessRule } from './target-service.js';
import {
  EmptyEntitlementReadError,
  refreshEntitlements,
  remitFor,
} from './entitlement-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 9));
let tenantId: string;
let targetId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

/**
 * The one connector member `refreshEntitlements` uses, and nothing else.
 *
 * Ruling P8 says a fake reproduces the real system's identifier semantics, and
 * the semantics that matter here are that the catalog is keyed on
 * `externalId` and carries a `dn` alongside it — which is exactly the pair
 * `DiscoveredEntitlement` declares. Anything richer would be reproducing the
 * connector rather than standing in for it.
 */
const reader = (items: DiscoveredEntitlement[]) => ({
  async *listEntitlements(): AsyncIterable<DiscoveredEntitlement> {
    for (const item of items) yield item;
  },
});

const group = (
  externalId: string,
  displayName: string,
  extra: Partial<DiscoveredEntitlement> = {},
): DiscoveredEntitlement => ({
  externalId,
  dn: `CN=${displayName},OU=Groups,DC=acme,DC=test`,
  type: 'group',
  displayName,
  ...extra,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'super-secret',
  });
  targetId = created.id;
});

const entitlements = () =>
  withTenant(tenantId, (tx) =>
    tx.entitlement.findMany({ where: { targetSystemId: targetId }, orderBy: { externalId: 'asc' } }),
  );

describe('refreshEntitlements', () => {
  it('writes the catalog it read, identity and DN both', async () => {
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );

    expect(result).toEqual({ present: 2, missing: 0 });
    const rows = await entitlements();
    expect(rows.map((r) => [r.externalId, r.displayName, r.dn, r.status])).toEqual([
      ['guid-1', 'Finance', 'CN=Finance,OU=Groups,DC=acme,DC=test', 'present'],
      ['guid-2', 'Sales', 'CN=Sales,OU=Groups,DC=acme,DC=test', 'present'],
    ]);
    expect(rows[0]!.lastSeenAt).not.toBeNull();
  });

  it('updates a group that was renamed and moved, keeping its identity', async () => {
    // `externalId` is the identity and the DN is not. A catalog keyed on the
    // name would turn a rename into a delete and a create, which reads
    // downstream as a mass revoke followed by a mass grant.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([
        {
          externalId: 'guid-1',
          dn: 'CN=Finance and Legal,OU=Corporate,DC=acme,DC=test',
          type: 'group',
          displayName: 'Finance and Legal',
          description: 'merged',
        },
      ]),
    );

    const rows = await entitlements();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Finance and Legal');
    expect(rows[0]!.dn).toBe('CN=Finance and Legal,OU=Corporate,DC=acme,DC=test');
    expect(rows[0]!.description).toBe('merged');
  });

  it('clears a description the target stopped returning', async () => {
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance', { description: 'the finance team' })]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const rows = await entitlements();
    expect(rows[0]!.description).toBeNull();
  });

  it('marks a vanished entitlement missing rather than deleting it', async () => {
    // Deleting it would orphan every holding pointing at it and silently
    // narrow every rule that named it, which produces a desired set lacking it
    // and proposes revoking it from everybody. `missing` makes those rules
    // unresolvable instead, which is loud.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );

    expect(result).toEqual({ present: 1, missing: 1 });
    const rows = await entitlements();
    expect(rows.map((r) => [r.externalId, r.status])).toEqual([
      ['guid-1', 'present'],
      ['guid-2', 'missing'],
    ]);
  });

  it('promotes a missing entitlement back to present when it returns', async () => {
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );

    const rows = await entitlements();
    expect(rows.map((r) => r.status)).toEqual(['present', 'present']);
  });

  it('leaves an unreadable entitlement unreadable', async () => {
    // This function knows whether a group is in the catalog. It knows nothing
    // about whether its membership could be read, and writing `present`
    // unconditionally would clear an `unreadable` the run had set — making
    // every rule naming that group resolvable again, evaluated against a
    // membership nobody could read.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    await withTenant(tenantId, (tx) =>
      tx.entitlement.updateMany({
        where: { targetSystemId: targetId },
        data: { status: 'unreadable' },
      }),
    );
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );

    // Not counted as missing either: it is in the catalog, it just could not
    // be read through.
    expect(result).toEqual({ present: 1, missing: 0 });
    const rows = await entitlements();
    expect(rows[0]!.status).toBe('unreadable');
  });

  it('counts an entitlement the target returned twice once', async () => {
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-1', 'Finance')]),
    );
    expect(result.present).toBe(1);
    expect(await entitlements()).toHaveLength(1);
  });

  it('refuses to condemn a whole catalog on a read that returned nothing', async () => {
    // `notIn: []` matches every row, so one empty read marks every
    // entitlement of this target `missing` — and a missing entitlement makes
    // every rule naming it unresolvable, which makes every person the rule
    // touches unprocessable for grants. A mistyped entitlementSearchBase, a
    // base moved by a restructure, and a bind that lost its read right on the
    // groups container all look exactly like this.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );

    await expect(
      refreshEntitlements(tenantId, provider, null, targetId, reader([])),
    ).rejects.toBeInstanceOf(EmptyEntitlementReadError);

    const rows = await entitlements();
    expect(rows.map((r) => r.status)).toEqual(['present', 'present']);
  });

  it('accepts an empty read against a target that has no catalog yet', async () => {
    // The ordinary first refresh. There is nothing to condemn, so there is
    // nothing to refuse — a check that fired here would make an empty target
    // impossible to refresh at all.
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([]),
    );
    expect(result).toEqual({ present: 0, missing: 0 });
  });

  it('leaves another target’s catalog alone', async () => {
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      other.id,
      reader([group('guid-1', 'Finance')]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-9', 'Ops')]),
    );

    const theirs = await withTenant(tenantId, (tx) =>
      tx.entitlement.findMany({ where: { targetSystemId: other.id } }),
    );
    expect(theirs.map((r) => [r.externalId, r.status])).toEqual([['guid-1', 'present']]);
    // The same externalId in two targets is two entitlements, per
    // @@unique([tenantId, targetSystemId, externalId]).
    expect(await entitlements()).toHaveLength(1);
  });

  it('audits the refresh with the numbers it returned', async () => {
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'provision.entitlements.refresh' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => e.payload)).toEqual([
      { present: 2, missing: 0 },
      { present: 1, missing: 1 },
    ]);
    expect(events[0]!.targetId).toBe(targetId);
  });

  it('refuses a target whose vault entry is gone', async () => {
    await withTenant(tenantId, (tx) => tx.secret.deleteMany({}));
    await expect(
      refreshEntitlements(
        tenantId,
        provider,
        null,
        targetId,
        reader([group('guid-1', 'Finance')]),
      ),
    ).rejects.toThrow(/configuration or credential missing/);
  });

  it('refuses a target in another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await expect(
      refreshEntitlements(
        other.id,
        provider,
        null,
        targetId,
        reader([group('guid-1', 'Finance')]),
      ),
    ).rejects.toThrow(/configuration or credential missing/);
  });
});

describe('remitFor', () => {
  const entitlement = (targetSystemId: string, externalId: string) =>
    withTenant(tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId,
            externalId,
            type: 'group',
            displayName: externalId,
          },
        })
      ).id,
    );

  const rule = {
    name: 'Finance staff',
    condition: { all: [] },
    grantsAccount: true,
    enabled: true,
  };

  it('is empty for a target no rule names anything on', async () => {
    await entitlement(targetId, 'guid-unnamed');
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.size).toBe(0);
  });

  it('holds every entitlement any rule for this target names', async () => {
    const finance = await entitlement(targetId, 'guid-finance');
    const sales = await entitlement(targetId, 'guid-sales');
    await entitlement(targetId, 'guid-unnamed');
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      entitlementIds: [finance],
    });
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      name: 'Sales staff',
      entitlementIds: [sales],
    });

    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect([...remit].sort()).toEqual([finance, sales].sort());
  });

  it('names each entitlement once even when two rules grant it', async () => {
    const finance = await entitlement(targetId, 'guid-finance');
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      entitlementIds: [finance],
    });
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      name: 'Finance contractors',
      entitlementIds: [finance],
    });
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect([...remit]).toEqual([finance]);
  });

  it('excludes an entitlement only another target’s rules name', async () => {
    // The remit is what decides, under `authoritative`, whether an
    // entitlement the target holds and Provision never granted is proposed
    // for revocation. Reading across targets would revoke on one target
    // because a rule on another mentioned something.
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    const theirs = await entitlement(other.id, 'guid-theirs');
    await upsertBusinessRule(tenantId, null, other.id, {
      ...rule,
      entitlementIds: [theirs],
    });

    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.size).toBe(0);
    const theirRemit = await withTenant(tenantId, (tx) => remitFor(tx, other.id));
    expect([...theirRemit]).toEqual([theirs]);
  });

  it('counts a disabled rule’s entitlements as in remit', async () => {
    // Pinned rather than assumed. Narrowing the remit to enabled rules would
    // make disabling a rule quietly stop `authoritative` from proposing to
    // revoke holdings Provision never granted; widening it, as here, means the
    // remit says what an administrator configured this target to care about
    // rather than what is switched on this minute. Entitlements Provision
    // itself granted are revoked regardless of the remit, so the two readings
    // differ only over holdings Provision never made. Flagged for review; this
    // test is here so a change of mind is a deliberate one.
    const finance = await entitlement(targetId, 'guid-finance');
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      enabled: false,
      entitlementIds: [finance],
    });
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect([...remit]).toEqual([finance]);
  });

  it('drops out of the remit when the rule is deleted', async () => {
    const finance = await entitlement(targetId, 'guid-finance');
    const created = await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      entitlementIds: [finance],
    });
    await withTenant(tenantId, (tx) =>
      tx.businessRule.delete({ where: { id: created.id } }),
    );
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.size).toBe(0);
  });
});

describe('the gaps the mutation pass found', () => {
  it('scopes the empty-read refusal to this target', async () => {
    // The refusal counts what Syntra holds *for this target*. Counting the
    // tenant would make a first refresh of a new target refuse because some
    // other target has a catalog, which is a target that can never be
    // populated at all.
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      other.id,
      reader([group('guid-1', 'Finance')]),
    );
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([]),
    );
    expect(result).toEqual({ present: 0, missing: 0 });
  });

  it('does not recount an entitlement that was already missing', async () => {
    // `missing` is the count of entitlements that went missing on THIS
    // refresh. Without the `status: { not: 'missing' }` filter it is the count
    // of everything absent, which never falls and makes the number on the
    // audit event mean nothing.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );
    expect(
      await refreshEntitlements(
        tenantId,
        provider,
        null,
        targetId,
        reader([group('guid-1', 'Finance')]),
      ),
    ).toEqual({ present: 1, missing: 1 });
    expect(
      await refreshEntitlements(
        tenantId,
        provider,
        null,
        targetId,
        reader([group('guid-1', 'Finance')]),
      ),
    ).toEqual({ present: 1, missing: 0 });
  });

  it('records the type the target reported', async () => {
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([
        {
          externalId: 'guid-lic',
          dn: 'CN=E3,OU=Licences,DC=acme,DC=test',
          type: 'licence',
          displayName: 'E3',
        },
      ]),
    );
    const rows = await entitlements();
    expect(rows[0]!.type).toBe('licence');
  });

  it('starts a newly discovered entitlement with no holders', async () => {
    // `holderCount` is the denominator of the per-entitlement guard axis and
    // Task 13 writes it from the reconciled target inventory. A catalog
    // refresh must not invent one: Ruling P25 makes a zero denominator against
    // a proposed revocation a non-confirmable refusal, and a guess here would
    // be a denominator that came from a different read than the plan.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const rows = await entitlements();
    expect(rows[0]!.holderCount).toBe(0);
  });
});
