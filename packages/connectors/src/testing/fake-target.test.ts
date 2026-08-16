import { describe, expect, it } from 'vitest';
import { isRetryable, type WriteOperation } from '../types.js';
import { FakeTarget } from './fake-target.js';

const config = { domain: 'acme.test' };
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';

const create = (actionId: string, correlationKey: string) =>
  ({
    op: 'create_account' as const,
    actionId,
    correlationKey,
    attributes: {
      displayName: ['Anna Novak'],
      distinguishedName: [`CN=${correlationKey},${USERS}`],
    },
    enabled: true,
    // Supplied by the caller, never invented by the connector. The fake stores
    // nothing of it, which is what lets Task 14 assert that no ProvisionAction
    // and no AuditEvent ever carries it.
    initialPassword: 'Aa1!fake-initial-password',
  });

/** A target that offers one group, in one container. */
const seeded = () => {
  const target = new FakeTarget();
  target.containers.push(USERS, 'OU=Groups,DC=acme,DC=test');
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });
  return target;
};

describe('FakeTarget', () => {
  it('creates an account and returns an anchor', async () => {
    const target = new FakeTarget();
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.ok).toBe(true);
    expect(result.anchor).toBeDefined();
    expect(target.objects.get(result.anchor!)?.correlationKey).toBe('a.novak');
  });

  it('retries a transient failure and succeeds on the second attempt', async () => {
    const target = new FakeTarget();
    target.program('create_account', { failTimes: 1, failure: 'transient' });
    const first = await target.write(config, create('act-1', 'a.novak'));
    expect(first.ok).toBe(false);
    expect(first.failure).toBe('transient');
    const second = await target.write(config, create('act-1', 'a.novak'));
    expect(second.ok).toBe(true);
  });

  it('reports a permanent rejection that must not be retried', async () => {
    const target = new FakeTarget();
    target.program('create_account', { failTimes: Infinity, failure: 'rejected' });
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.failure).toBe('rejected');
  });

  it('reports a throttle with a retry-after', async () => {
    const target = seeded();
    target.program('grant_entitlement', {
      failTimes: 1,
      failure: 'throttled',
      retryAfterMs: 2500,
    });
    const result = await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: 'anchor-1',
      entitlementId: 'guid-finance',
    });
    expect(result.failure).toBe('throttled');
    expect(result.retryAfterMs).toBe(2500);
  });

  it('adopts its own lost create rather than duplicating it', async () => {
    // The create landed at the target and the response was lost. On retry the
    // connector looks up the correlation key, finds the provenance marker
    // carrying THIS actionId, and adopts.
    const target = new FakeTarget();
    target.program('create_account', { loseResponseTimes: 1 });
    const lost = await target.write(config, create('act-1', 'a.novak'));
    expect(lost.ok).toBe(false);
    expect(lost.failure).toBe('transient');
    expect(target.objects.size).toBe(1);

    const retry = await target.write(config, create('act-1', 'a.novak'));
    expect(retry.ok).toBe(true);
    // One object, not two. This is the whole point of the provenance marker.
    expect(target.objects.size).toBe(1);
    expect(retry.message).toContain('adopted');
  });

  it('conflicts rather than adopting somebody else account', async () => {
    // Same name, different provenance. Never a silent adoption: anybody able
    // to create an object in the target could otherwise choose a name that
    // causes Syntra to hand them an existing person's account, along with
    // every entitlement the rules will then grant it.
    const target = new FakeTarget();
    target.seedForeignObject('a.novak');
    const result = await target.write(config, create('act-1', 'a.novak'));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('conflict');
    expect(target.objects.size).toBe(1);
  });

  it('treats granting a held entitlement and revoking an unheld one as successes', async () => {
    const target = seeded();
    target.entitlements.push({
      externalId: 'guid-teaching',
      dn: 'CN=Teaching,OU=Groups,DC=acme,DC=test',
      type: 'group',
      displayName: 'Teaching',
    });
    const created = await target.write(config, create('act-1', 'a.novak'));
    const anchor = created.anchor!;
    const grant = {
      op: 'grant_entitlement' as const,
      actionId: 'act-2',
      anchor,
      entitlementId: 'guid-finance',
    };
    expect((await target.write(config, grant)).ok).toBe(true);
    // Set operations. Granting twice is the same state, not an error.
    expect((await target.write(config, grant)).ok).toBe(true);
    // Held BY DN, because that is what Active Directory holds and what its
    // `member` and `memberOf` attributes contain. The caller passes an
    // objectGUID and the connector resolves it, exactly as groupDnFor does.
    expect(target.holdings.get(anchor)).toEqual(new Set([FINANCE_DN]));

    const revoke = {
      op: 'revoke_entitlement' as const,
      actionId: 'act-3',
      anchor,
      entitlementId: 'guid-teaching',
    };
    expect((await target.write(config, revoke)).ok).toBe(true);
  });

  it('refuses a grant of an entitlement the target does not offer', async () => {
    // groupDnFor returns undefined and the real connector answers not_found.
    // A fake that quietly accepted an unknown identifier would let the whole
    // externalId-to-DN mapping go untested.
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    const result = await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: created.anchor!,
      entitlementId: 'guid-nowhere',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });

  it('reports membership the way a directory does: as distinguished names', async () => {
    // Ruling P8. Active Directory reports memberOf as DNs, never as
    // objectGUIDs, so this fake does too -- which is what makes Task 13's
    // DN-to-entitlement mapping something the run-service tests exercise
    // rather than something production discovers.
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor: created.anchor!,
      entitlementId: 'guid-finance',
    });
    const records = [];
    for await (const record of target.read(config)) records.push(record);
    expect(records[0]!.attributes.memberOf).toEqual([FINANCE_DN]);
    expect(records[0]!.dn).toBe(`CN=a.novak,${USERS}`);
  });

  it('lists the containers it was seeded with, and nothing derived from its accounts', async () => {
    // Containers are read, not inferred. An empty-but-real container has to be
    // visible or a first run against an empty target proposes nothing at all.
    const target = seeded();
    const found = [];
    for await (const container of target.listContainers(config)) found.push(container.dn);
    expect(found).toEqual([USERS, 'OU=Groups,DC=acme,DC=test']);
  });

  it('archives by stripping only the entitlements it was handed', async () => {
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    const anchor = created.anchor!;
    await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor,
      entitlementId: 'guid-finance',
    });
    // A membership no business rule mentions: outside Provision's remit, and
    // an archive must not touch it.
    target.holdings.get(anchor)!.add('CN=Sports Club,OU=Groups,DC=acme,DC=test');

    const result = await target.write(config, {
      op: 'archive_account',
      actionId: 'act-3',
      anchor,
      entitlementDns: [FINANCE_DN],
    });
    expect(result.ok).toBe(true);
    expect(target.holdings.get(anchor)).toEqual(
      new Set(['CN=Sports Club,OU=Groups,DC=acme,DC=test']),
    );
    // The object itself is intact and merely disabled. It never deletes.
    expect(target.objects.get(anchor)?.archived).toBe(true);
  });

  it('returns nothing at all when programmed empty', async () => {
    // An empty target and an unreachable one look identical from here, and
    // the guard has to be able to exercise that.
    const target = new FakeTarget();
    target.seedForeignObject('someone');
    target.returnsNothing = true;
    const records = [];
    for await (const record of target.read(config)) records.push(record);
    expect(records).toEqual([]);
  });

  it('has no delete method of any kind', async () => {
    const target = new FakeTarget();
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(target));
    expect(names.filter((n) => /delete|destroy|purge|remove/i.test(n))).toEqual([]);
  });
});

/**
 * The members of the write union the block above does not reach, and the
 * membership read. The run applies all of them, so a fake that got any of them
 * wrong would mislead every later task rather than fail here.
 */
describe('FakeTarget: the rest of the target-connector surface', () => {
  it('reads every member of an entitlement, as distinguished names', async () => {
    // Ruling P8 on the other direction of the same mapping: a group's `member`
    // attribute is a list of DNs, so this returns DNs.
    const target = seeded();
    const anna = (await target.write(config, create('act-1', 'a.novak'))).anchor!;
    const beata = (await target.write(config, create('act-2', 'b.kral'))).anchor!;
    for (const [actionId, anchor] of [
      ['act-3', anna],
      ['act-4', beata],
    ] as const) {
      await target.write(config, {
        op: 'grant_entitlement',
        actionId,
        anchor,
        entitlementId: 'guid-finance',
      });
    }
    const members = await target.readEntitlementMembers(config, FINANCE_DN);
    expect([...members].sort()).toEqual(
      [`CN=a.novak,${USERS}`, `CN=b.kral,${USERS}`].sort(),
    );
  });

  it('throws rather than returning half a membership', async () => {
    // All, or an exception. A group of 4,000 that reads as 1,500 is the single
    // most dangerous value in this subsystem: the diff would propose revoking
    // it from 2,500 people. The run marks the entitlement unreadable instead.
    const target = seeded();
    const anchor = (await target.write(config, create('act-1', 'a.novak'))).anchor!;
    await target.write(config, {
      op: 'grant_entitlement',
      actionId: 'act-2',
      anchor,
      entitlementId: 'guid-finance',
    });
    target.unreadableEntitlementDns.add(FINANCE_DN);
    await expect(target.readEntitlementMembers(config, FINANCE_DN)).rejects.toThrow(
      /ranged read/i,
    );
  });

  it('applies an update as desired state, so the same update twice is the same result', async () => {
    const target = seeded();
    const anchor = (await target.write(config, create('act-1', 'a.novak'))).anchor!;
    const update = {
      op: 'update_account' as const,
      actionId: 'act-2',
      anchor,
      attributes: { displayName: ['Anna Novakova'], department: ['Finance'] },
    };
    expect((await target.write(config, update)).ok).toBe(true);
    const once = { ...target.objects.get(anchor)!.attributes };
    // The same operation twice is the same result. That is what makes retry
    // free for the majority of operations.
    expect((await target.write(config, update)).ok).toBe(true);
    expect(target.objects.get(anchor)!.attributes).toEqual(once);
    expect(once).toEqual({ displayName: ['Anna Novakova'], department: ['Finance'] });

    // Desired state, not a delta: an attribute the operation no longer names is
    // gone afterwards. A connector that merged instead would make it impossible
    // to ever clear a managed attribute, and the drift would never converge.
    await target.write(config, {
      op: 'update_account',
      actionId: 'act-3',
      anchor,
      attributes: { displayName: ['Anna Novakova'] },
    });
    expect(target.objects.get(anchor)!.attributes).toEqual({
      displayName: ['Anna Novakova'],
    });
  });

  it('treats a distinguishedName in an update as a move that leaves the anchor alone', async () => {
    // The point of anchoring on objectGUID: the object moves, the identifier
    // does not, and nothing downstream has to re-correlate.
    const target = seeded();
    const anchor = (await target.write(config, create('act-1', 'a.novak'))).anchor!;
    const moved = 'CN=a.novak,OU=Leavers,DC=acme,DC=test';
    await target.write(config, {
      op: 'update_account',
      actionId: 'act-2',
      anchor,
      attributes: { displayName: ['Anna Novak'], distinguishedName: [moved] },
    });
    expect(target.objects.get(anchor)!.dn).toBe(moved);
    // The move is not left behind as an attribute of the object.
    expect(target.objects.get(anchor)!.attributes).toEqual({
      displayName: ['Anna Novak'],
    });
    expect(target.objects.size).toBe(1);
  });

  it('renames within the container the object already sits in', async () => {
    // Deliberately NOT the default container: a rename that quietly relocated
    // the object into whichever container the connector happens to default to
    // would move a person out of the OU their access is scoped by, and a test
    // seeded into that same default could never see it.
    const target = seeded();
    const staff = 'OU=Staff,DC=acme,DC=test';
    const created = await target.write(config, {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'a.novak',
      attributes: { distinguishedName: [`CN=a.novak,${staff}`] },
      enabled: true,
      initialPassword: 'Aa1!fake-initial-password',
    });
    const anchor = created.anchor!;
    const result = await target.write(config, {
      op: 'rename_account',
      actionId: 'act-2',
      anchor,
      correlationKey: 'a.novakova',
    });
    expect(result.ok).toBe(true);
    expect(target.objects.get(anchor)!.dn).toBe(`CN=a.novakova,${staff}`);
    expect(target.objects.get(anchor)!.correlationKey).toBe('a.novakova');
  });

  it('disables with a reason and enables again, and never removes the object', async () => {
    const target = seeded();
    const anchor = (await target.write(config, create('act-1', 'a.novak'))).anchor!;
    await target.write(config, {
      op: 'disable_account',
      actionId: 'act-2',
      anchor,
      reason: 'left the organisation',
    });
    expect(target.objects.get(anchor)!.enabled).toBe(false);
    expect(target.objects.get(anchor)!.attributes.info).toEqual([
      'left the organisation',
    ]);
    const records = [];
    for await (const record of target.read(config)) records.push(record);
    // Still there, and still readable. Disable is the whole safety argument for
    // there being no delete: four thousand of these can be walked back.
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes.userAccountControl).toEqual(['514']);

    await target.write(config, { op: 'enable_account', actionId: 'act-3', anchor });
    expect(target.objects.get(anchor)!.enabled).toBe(true);
  });

  it('answers not_found for every operation against an anchor that is gone', async () => {
    // Not a transient. An object somebody else removed does not come back on
    // the fourth attempt, and isRetryable says so.
    const target = seeded();
    const gone = 'fake-anchor-9999';
    const operations: WriteOperation[] = [
      { op: 'update_account', actionId: 'act-1', anchor: gone, attributes: {} },
      { op: 'enable_account', actionId: 'act-2', anchor: gone },
      { op: 'disable_account', actionId: 'act-3', anchor: gone, reason: 'x' },
      { op: 'archive_account', actionId: 'act-4', anchor: gone, entitlementDns: [] },
      { op: 'rename_account', actionId: 'act-5', anchor: gone, correlationKey: 'x' },
      {
        op: 'grant_entitlement',
        actionId: 'act-6',
        anchor: gone,
        entitlementId: 'guid-finance',
      },
      {
        op: 'revoke_entitlement',
        actionId: 'act-7',
        anchor: gone,
        entitlementId: 'guid-finance',
      },
    ];
    for (const operation of operations) {
      const result = await target.write(config, operation);
      expect({ op: operation.op, ok: result.ok, failure: result.failure }).toEqual({
        op: operation.op,
        ok: false,
        failure: 'not_found',
      });
      expect(isRetryable(result.failure)).toBe(false);
    }
  });

  it('records every operation it was asked to perform, and keeps no password', async () => {
    // `calls` is what a later task asserts a dry run leaves empty. It has to
    // hold the operations -- and the object it created must not become a place
    // an initial password can be read back out of.
    const target = seeded();
    const created = await target.write(config, create('act-1', 'a.novak'));
    await target.write(config, {
      op: 'enable_account',
      actionId: 'act-2',
      anchor: created.anchor!,
    });
    expect(target.calls.map((call) => call.op)).toEqual([
      'create_account',
      'enable_account',
    ]);
    expect(JSON.stringify([...target.objects.values()])).not.toContain(
      'fake-initial-password',
    );
  });
});
