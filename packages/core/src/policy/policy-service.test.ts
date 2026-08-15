import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addRule, deleteRule, loadPolicy, reorderRules, setPolicyDefault, updateRule } from './policy-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('loadPolicy', () => {
  it('returns an allow fallback and no rules for a tenant that has never configured one', async () => {
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy).toEqual({ rules: [], fallback: { outcome: 'allow', factorType: null } });
  });

  it('returns the configured fallback', async () => {
    await withTenant(tenantId, (tx) =>
      setPolicyDefault(tx, { outcome: 'require_mfa', factorType: null }),
    );
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.fallback).toEqual({ outcome: 'require_mfa', factorType: null });
  });
});

describe('addRule', () => {
  it('appends at the next position', async () => {
    const positions = await withTenant(tenantId, async (tx) => {
      const first = await addRule(tx, { name: 'First', outcome: 'allow' });
      const second = await addRule(tx, { name: 'Second', outcome: 'deny' });
      return [first.position, second.position];
    });
    expect(positions).toEqual([1, 2]);
  });

  it('creates the tenant policy row on first use', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'First', outcome: 'allow' }));
    expect(await withTenant(tenantId, (tx) => tx.authPolicy.count())).toBe(1);
  });

  it('defaults every condition to unconstrained', async () => {
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Bare', outcome: 'deny' }),
    );
    expect(rule).toMatchObject({
      enabled: true,
      applicationIds: [],
      groupIds: [],
      contractField: null,
      contractValues: [],
      ipRanges: [],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    });
  });

  it('refuses require_factor without a factor type', async () => {
    await expect(
      withTenant(tenantId, (tx) => addRule(tx, { name: 'Bad', outcome: 'require_factor' })),
    ).rejects.toThrow(/factorType/);
  });

  it('refuses an unusable timezone', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, {
          name: 'Bad zone',
          outcome: 'deny',
          startMinute: 0,
          endMinute: 60,
          timezone: 'Middle/Earth',
        }),
      ),
    ).rejects.toThrow(/timezone/);
  });

  it('refuses a malformed IP range rather than storing one that can never match', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad range', outcome: 'deny', ipRanges: ['10.0.0.0/33'] }),
      ),
    ).rejects.toThrow(/ipRanges/);
  });

  it('refuses a security-key rule in a tenant that cannot use security keys', async () => {
    // The relying party comes from Tenant.primaryDomain, so without one there
    // is no way to register a key. Saving the rule anyway would leave every
    // matched user at an enrolment screen whose only button returns a 409.
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, {
          name: 'Keys only',
          outcome: 'require_factor',
          factorType: 'webauthn',
        }),
      ),
    ).rejects.toThrow(/primary domain/);
  });

  it('allows it once the tenant has a primary domain', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    expect(rule.factorType).toBe('webauthn');
  });

  it('stores the ranges a real tenant actually writes', async () => {
    // The case whose absence let a validator that rejected 192.168.0.0/16 ship
    // in the first draft: every test asserted a *rejection*, so nothing noticed
    // that acceptance was broken too.
    const ranges = [
      '10.0.0.0/8',
      '192.168.0.0/16',
      '172.16.0.0/12',
      '198.51.100.0/24',
      '8.8.8.8',
      '2001:db8::/32',
    ];
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Office network', outcome: 'allow', ipRanges: ranges }),
    );
    expect(rule.ipRanges).toEqual(ranges);
  });

  it('refuses a day outside 0..6', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad day', outcome: 'deny', daysOfWeek: [7] }),
      ),
    ).rejects.toThrow(/daysOfWeek/);
  });

  it('refuses a minute outside 0..1439', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad minute', outcome: 'deny', startMinute: 0, endMinute: 1440 }),
      ),
    ).rejects.toThrow(/Minute/);
  });
});

describe('loadPolicy with rules', () => {
  it('returns rules in position order, narrowed to the engine types', async () => {
    // This tenant needs a primary domain before it may hold a webauthn rule —
    // that restriction is exercised on its own above; here the sample rule
    // just needs to be one addRule will actually accept.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    await withTenant(tenantId, async (tx) => {
      await addRule(tx, {
        name: 'Finance needs a key',
        outcome: 'require_factor',
        factorType: 'webauthn',
        contractField: 'department',
        contractValues: ['Finance'],
      });
      await addRule(tx, { name: 'Everyone else', outcome: 'allow' });
    });

    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => r.name)).toEqual([
      'Finance needs a key',
      'Everyone else',
    ]);
    expect(policy.rules[0]).toMatchObject({
      outcome: 'require_factor',
      factorType: 'webauthn',
      contractField: 'department',
      contractValues: ['Finance'],
    });
  });
});

describe('updateRule / deleteRule / reorderRules', () => {
  it('updates in place without moving the rule', async () => {
    const rule = await withTenant(tenantId, async (tx) => {
      await addRule(tx, { name: 'First', outcome: 'allow' });
      return addRule(tx, { name: 'Second', outcome: 'allow' });
    });
    const updated = await withTenant(tenantId, (tx) =>
      updateRule(tx, rule.id, { name: 'Second, revised', outcome: 'deny' }),
    );
    expect(updated).toMatchObject({ name: 'Second, revised', outcome: 'deny', position: 2 });
  });

  it('closes the gap after a delete so positions stay contiguous', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'C', outcome: 'allow' })).id,
    ]);
    await withTenant(tenantId, (tx) => deleteRule(tx, ids[1]!));
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => [r.name, r.position])).toEqual([
      ['A', 1],
      ['C', 2],
    ]);
  });

  it('reorders to exactly the sequence given', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'C', outcome: 'allow' })).id,
    ]);
    await withTenant(tenantId, (tx) => reorderRules(tx, [ids[2]!, ids[0]!, ids[1]!]));
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('refuses a reorder that does not name every rule exactly once', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
    ]);
    await expect(
      withTenant(tenantId, (tx) => reorderRules(tx, [ids[0]!])),
    ).rejects.toThrow(/every rule/);
  });
});
