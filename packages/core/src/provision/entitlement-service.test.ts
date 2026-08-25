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

/**
 * One group as the connector yields it — INCLUDING the anchorless shape.
 *
 * `group('', 'Finance')` is not a contrived input. `anchorOf`
 * (`packages/connectors/src/ad/connector.ts`) is
 * `normaliseAnchor(attr, Buffer.isBuffer(source) ? source : String(source ?? ''))`,
 * so a group whose anchor attribute is absent from the entry yields the EMPTY
 * STRING and `listEntitlements` yields the group anyway — with its `cn` and
 * `description` intact, because Active Directory omits an attribute the bind
 * cannot read rather than failing the search. An `anchorAttribute` the group
 * objects do not carry (it is administrator-settable and unvalidated) does the
 * same thing to every group at once. Until this comment was written every test
 * here passed a real id, so the whole empty-case block rested on `reader([])`
 * and the blank-anchor case had never been executed.
 */
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
    type: 'activeDirectory',
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

    expect(result).toEqual({ present: 2, missing: 0, unidentifiable: 0 });
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

    expect(result).toEqual({ present: 1, missing: 1, unidentifiable: 0 });
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
    expect(result).toEqual({ present: 1, missing: 0, unidentifiable: 0 });
    const rows = await entitlements();
    expect(rows[0]!.status).toBe('unreadable');
  });

  it('keeps the last of two entries for the same group', async () => {
    // Deduplicating by externalId is not only about the row count. The map
    // decides WHICH of the two the row ends up holding, and a version that
    // let both through would insert the first and drop the second -- so the
    // catalog would hold the entry the target sent first rather than last,
    // which is the opposite of "the latest read wins".
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([
        group('guid-1', 'Finance'),
        { ...group('guid-1', 'Finance'), displayName: 'Finance (renamed)' },
      ]),
    );
    const rows = await entitlements();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Finance (renamed)');
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
    expect(result).toEqual({ present: 0, missing: 0, unidentifiable: 0 });
  });

  it('refuses a read whose every group came back with a blank anchor', async () => {
    // The empty-read guard one step to the side. `anchorOf` is
    // `String(source ?? '')`, so a group whose anchor attribute is absent
    // yields the EMPTY STRING and is still yielded — an `anchorAttribute` the
    // group objects do not carry (it is administrator-settable and
    // unvalidated) or a delegated bind without read access on `objectGUID`
    // for the groups container does it, and AD omits an unreadable attribute
    // rather than erroring. Every one of them then collapses onto a single
    // `externalId: ''` row and the sweep marks the whole real catalog
    // `missing`, with an audit event saying `outcome: 'success'`.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('guid-2', 'Sales')]),
    );

    await expect(
      refreshEntitlements(
        tenantId,
        provider,
        null,
        targetId,
        reader([group('', 'Finance'), group('', 'Sales'), group('', 'Ops')]),
      ),
    ).rejects.toBeInstanceOf(EmptyEntitlementReadError);

    const rows = await entitlements();
    // Nothing condemned, and no blank-anchored row inserted alongside them.
    expect(rows.map((r) => [r.externalId, r.status])).toEqual([
      ['guid-1', 'present'],
      ['guid-2', 'present'],
    ]);
  });

  it('says how many groups it could not identify, and does not say the read was empty', async () => {
    // "The target returned nothing" and "the target returned three groups and
    // Syntra could name none of them" are the same refusal and different
    // repairs: a search base in the first case, an anchorAttribute or the
    // bind's read rights in the second. A message naming the wrong one sends
    // an administrator to the wrong screen.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const thrown = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('', 'Finance'), group('', 'Sales'), group('', 'Ops')]),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(EmptyEntitlementReadError);
    const error = thrown as EmptyEntitlementReadError;
    expect(error.unidentifiable).toBe(3);
    expect(error.known).toBe(1);
    expect(error.message).toContain('blank anchor');
    expect(error.message).not.toContain('no entitlements at all');
  });

  it('skips a blank-anchored group without condemning the ones it could identify', async () => {
    // A partial loss: one group's anchor is readable and the rest are not.
    // This is NOT refused — one identified group means the read is not a total
    // loss, and this function cannot tell a half-read catalog from a
    // half-deleted one — so the count has to be visible instead, on the path
    // that carried on.
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
      reader([group('guid-1', 'Finance'), group('', 'Sales')]),
    );

    expect(result).toEqual({ present: 1, missing: 1, unidentifiable: 1 });
    const rows = await entitlements();
    // No `externalId: ''` row: a group whose identity the target did not
    // report has no key to invent, and a synthesised one would be a second
    // identity for an object that already has one.
    expect(rows.map((r) => r.externalId)).toEqual(['guid-1', 'guid-2']);
  });

  it('writes the unidentified count into the audit event', async () => {
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance'), group('', 'Sales')]),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'provision.entitlements.refresh' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => e.payload)).toEqual([
      { present: 1, missing: 0, unidentifiable: 1 },
    ]);
  });

  it('accepts a blank-anchored read against a target that has no catalog yet', async () => {
    // The first-refresh case, left alone exactly as the empty read is: there
    // is nothing to condemn, so there is nothing to refuse.
    const result = await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('', 'Finance')]),
    );
    expect(result).toEqual({ present: 0, missing: 0, unidentifiable: 1 });
    expect(await entitlements()).toEqual([]);
  });

  it('leaves another target’s catalog alone', async () => {
    const other = await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      other.id,
      reader([group('guid-1', 'Finance'), group('guid-only-theirs', 'Theirs')]),
    );
    // The SAME externalId, deliberately: two targets can offer groups whose
    // identifiers collide, @@unique([tenantId, targetSystemId, externalId])
    // says they are two entitlements, and a read of the existing rows that
    // forgets to scope by target would see the other target's row, decide
    // this one already exists, and create nothing at all here.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Ops')]),
    );

    const theirs = await withTenant(tenantId, (tx) =>
      tx.entitlement.findMany({
        where: { targetSystemId: other.id },
        orderBy: { externalId: 'asc' },
      }),
    );
    // Both of theirs untouched: the shared id proves the existing-row READ
    // is scoped, and `guid-only-theirs` -- which this refresh never saw --
    // proves the vanished SWEEP is. Without the second one the sweep's
    // `notIn` happens to exclude their row anyway and the scope is untested.
    expect(theirs.map((r) => [r.externalId, r.displayName, r.status])).toEqual([
      ['guid-1', 'Finance', 'present'],
      ['guid-only-theirs', 'Theirs', 'present'],
    ]);
    const ours = await entitlements();
    expect(ours.map((r) => [r.externalId, r.displayName])).toEqual([['guid-1', 'Ops']]);
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
      { present: 2, missing: 0, unidentifiable: 0 },
      { present: 1, missing: 1, unidentifiable: 0 },
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
    type: 'activeDirectory',
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

  it('leaves a disabled rule’s entitlements out of remit', async () => {
    // Ruling P27, decided after Task 12 flagged it. Counting a disabled rule
    // would mean that DISABLING a rule broadens what Provision deletes under
    // `authoritative` -- the opposite of what switching something off means,
    // and the wrong direction for a destructive action. Those holdings become
    // unmanaged instead: reported as drift and left alone. Entitlements
    // Provision itself granted are revoked regardless of the remit, so the two
    // readings differ only over holdings Provision never made.
    const finance = await entitlement(targetId, 'guid-finance');
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      enabled: false,
      entitlementIds: [finance],
    });
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.size).toBe(0);
  });

  it('keeps an entitlement a second, enabled rule also names', async () => {
    // The narrowing is per rule, not per entitlement. A group two rules grant
    // stays in remit while either of them is on, or disabling one rule would
    // silently narrow what the other one manages.
    const finance = await entitlement(targetId, 'guid-finance');
    await upsertBusinessRule(tenantId, null, targetId, {
      ...rule,
      enabled: false,
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
    type: 'activeDirectory',
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
    expect(result).toEqual({ present: 0, missing: 0, unidentifiable: 0 });
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
    ).toEqual({ present: 1, missing: 1, unidentifiable: 0 });
    expect(
      await refreshEntitlements(
        tenantId,
        provider,
        null,
        targetId,
        reader([group('guid-1', 'Finance')]),
      ),
    ).toEqual({ present: 1, missing: 0, unidentifiable: 0 });
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

describe('the batched catalog write', () => {
  it('writes a change to any one field on its own', async () => {
    // The write skips a group whose metadata is unchanged, which is what keeps
    // a steady-state refresh to a fixed number of statements. A comparison
    // that checks only some of the fields it writes turns that optimisation
    // into a silent drop: the group is in the catalog, Syntra's copy of it is
    // wrong, and nothing ever corrects it because the next refresh compares
    // the same way. One field at a time, so no single comparison can be
    // missing and still pass.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );

    // CUMULATIVE. Rebuilding the input from the original group each time
    // changes the field under test *and* changes the previous one back, so a
    // comparison that ignores one of them still sees the other and writes the
    // whole row -- which is exactly how three of these mutants survived the
    // first pass. Each step below differs from the stored row in one field.
    let current: DiscoveredEntitlement = group('guid-1', 'Finance');
    const only = async (over: Partial<DiscoveredEntitlement>) => {
      current = { ...current, ...over };
      await refreshEntitlements(tenantId, provider, null, targetId, reader([current]));
      return (await entitlements())[0]!;
    };

    expect((await only({ displayName: 'Finance and Legal' })).displayName).toBe(
      'Finance and Legal',
    );
    expect((await only({ dn: 'CN=Finance,OU=Corporate,DC=acme,DC=test' })).dn).toBe(
      'CN=Finance,OU=Corporate,DC=acme,DC=test',
    );
    expect((await only({ type: 'role' })).type).toBe('role');
    expect((await only({ description: 'the finance team' })).description).toBe(
      'the finance team',
    );
  });

  it('stamps lastSeenAt on every refresh, not only the first', async () => {
    // `lastSeenAt` is how anybody tells a catalog that is being kept current
    // from one whose refresh has been failing quietly since March. It is
    // written for every group the target returned, including the ones the
    // change comparison skipped.
    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const first = (await entitlements())[0]!.lastSeenAt!;

    await refreshEntitlements(
      tenantId,
      provider,
      null,
      targetId,
      reader([group('guid-1', 'Finance')]),
    );
    const second = (await entitlements())[0]!.lastSeenAt!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it('writes a catalog of several hundred groups in one transaction', async () => {
    // The reason the write is batched at all. A per-group upsert is one round
    // trip each and `withTenant` is `prisma.$transaction(fn)` on Prisma's
    // five-second default, so a domain of any real size aborts with P2028 and
    // rolls the whole refresh back -- permanently, because retrying re-runs
    // the same statements against the same volume.
    const many = Array.from({ length: 400 }, (_, i) =>
      group(`guid-${i}`, `Group${i}`),
    );
    expect(
      await refreshEntitlements(tenantId, provider, null, targetId, reader(many)),
    ).toEqual({ present: 400, missing: 0, unidentifiable: 0 });

    // And the second pass, where nothing changed, must not rewrite them.
    expect(
      await refreshEntitlements(tenantId, provider, null, targetId, reader(many)),
    ).toEqual({ present: 400, missing: 0, unidentifiable: 0 });
    expect(await entitlements()).toHaveLength(400);
  });
});
