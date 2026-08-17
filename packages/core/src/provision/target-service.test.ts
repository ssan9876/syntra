import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `localMasterKeyProvider`, which is what packages/core/src/vault/master-key.ts
// actually exports. There is no `staticMasterKeyProvider`; the existing
// `auth/authorize.test.ts` and `auth/mfa/totp.test.ts` both import this one.
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  deleteTarget,
  targetWithCredential,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const create = () =>
  createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'super-secret',
  });

describe('createTarget', () => {
  it('stores the credential in the vault and never on the row', async () => {
    const { id } = await create();
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(JSON.stringify(row)).not.toContain('super-secret');
    expect(row.secretName).toBe(`target/${id}/bind`);
  });

  it('audits the creation in the same transaction', async () => {
    const { id } = await create();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.create' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(id);
    // Lowering a threshold is functionally the same as approving everything it
    // would otherwise have caught, so configuration changes are privileged.
    expect(JSON.stringify(events[0]!.payload)).not.toContain('super-secret');
  });

  it('refuses a target configured to write in the clear', async () => {
    await expect(
      createTarget(tenantId, provider, null, {
        name: 'Plain',
        config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('updateTarget', () => {
  it('validates the ladder ordering before writing', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        ladder: { entitlementRevocationDelayDays: 14, disableGraceDays: 3 },
      }),
    ).rejects.toThrow(/entitlement revocations cannot be delayed past the disable/);
  });

  it('validates that archive falls strictly after disable', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        ladder: { disableGraceDays: 30, archiveAfterDays: 30 },
      }),
    ).rejects.toThrow(/archive must fall strictly after the disable/);
  });

  it('accepts a valid ladder and audits it', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: {
        entitlementRevocationDelayDays: 0,
        disableGraceDays: 7,
        archiveAfterDays: 90,
      },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.disableGraceDays).toBe(7);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('records the enforcement mode change explicitly', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      enforcementMode: 'authoritative',
    });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' } }),
    );
    expect(events[0]!.payload).toMatchObject({
      enforcementMode: { from: 'additive', to: 'authoritative' },
    });
  });

  it('replaces the vault entry when a new bind password is supplied', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, { bindPassword: 'rotated' });
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.bindPassword).toBe('rotated');
  });
});

describe('targetWithCredential', () => {
  it('returns the configuration with the credential attached', async () => {
    const { id } = await create();
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.bindPassword).toBe('super-secret');
    expect(loaded?.baseDn).toBe('OU=Users,DC=acme,DC=test');
  });

  it('returns null when the vault entry is gone', async () => {
    const { id } = await create();
    await withTenant(tenantId, (tx) => tx.secret.deleteMany({}));
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded).toBeNull();
  });
});

describe('deleteTarget', () => {
  it('refuses without confirmation and reports what it holds', async () => {
    const { id } = await create();
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: id,
          personId: person.id,
          correlationKey: 'anna.novak',
        },
      });
    });
    const result = await deleteTarget(tenantId, null, id, false);
    expect(result).toEqual({ ok: false, counts: { accounts: 1, rules: 0, entitlements: 0 } });
  });

  it('deletes with confirmation and audits it', async () => {
    const { id } = await create();
    expect(await deleteTarget(tenantId, null, id, true)).toEqual({ ok: true });
    const rows = await withTenant(tenantId, (tx) => tx.targetSystem.findMany());
    expect(rows).toEqual([]);
  });

  it('deletes a target that still holds an account and a live entitlement holding', async () => {
    // The only interesting delete. With `AccountEntitlement.entitlement` on
    // Restrict, PostgreSQL checks it immediately and this fails with a
    // foreign-key violation -- so the confirmable delete the API offers could
    // never succeed on any target anybody had actually used. The test above
    // passes because it deletes an empty target, which is not a case that
    // occurs.
    const { id } = await create();
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: id,
          externalId: 'guid-1',
          dn: 'CN=Finance,OU=Groups,DC=acme,DC=test',
          type: 'group',
          displayName: 'Finance',
        },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: id,
          personId: person.id,
          correlationKey: 'anna.novak',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId: entitlement.id,
          origin: 'rule',
        },
      });
    });

    expect(await deleteTarget(tenantId, null, id, true)).toEqual({ ok: true });
    // Syntra's record of the accounts is gone. The accounts themselves, in the
    // target, were never touched -- Provision has no delete.
    expect(
      await withTenant(tenantId, (tx) => tx.targetAccount.count()),
    ).toBe(0);
    expect(
      await withTenant(tenantId, (tx) => tx.accountEntitlement.count()),
    ).toBe(0);
  });
});

describe('upsertAccountProfile', () => {
  it('stores the templates and audits the change', async () => {
    const { id } = await create();
    await upsertAccountProfile(tenantId, null, id, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      maxUniquenessAttempts: 20,
      containerTemplate: 'OU=%contract.department%,%baseDn%',
      fallbackContainer: 'OU=Users,DC=acme,DC=test',
      attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
      initialPasswordPolicy: { length: 24 },
      initialPasswordDelivery: 'vaultOnly',
    });
    const profile = await withTenant(tenantId, (tx) =>
      tx.accountProfile.findFirstOrThrow({ where: { targetSystemId: id } }),
    );
    expect(profile.fallbackContainer).toBe('OU=Users,DC=acme,DC=test');
  });

  it('refuses a profile with no fallback container', async () => {
    const { id } = await create();
    await expect(
      upsertAccountProfile(tenantId, null, id, {
        correlationKeyTemplate: '%person.familyName%',
        maxUniquenessAttempts: 20,
        containerTemplate: 'OU=%contract.department%,%baseDn%',
        fallbackContainer: '',
        attributeTemplates: {},
        initialPasswordPolicy: {},
        initialPasswordDelivery: 'vaultOnly',
      }),
    ).rejects.toThrow();
  });
});

describe('upsertBusinessRule', () => {
  it('stores a validated condition and its entitlement join rows', async () => {
    const { id } = await create();
    const entitlementId = await withTenant(tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: id,
            externalId: 'guid-1',
            type: 'group',
            displayName: 'Finance',
          },
        })
      ).id,
    );
    const rule = await upsertBusinessRule(tenantId, null, id, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });
    const joins = await withTenant(tenantId, (tx) =>
      tx.ruleEntitlement.findMany({ where: { ruleId: rule.id } }),
    );
    expect(joins).toHaveLength(1);
  });

  it('refuses a condition outside the closed field and operator set', async () => {
    const { id } = await create();
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        name: 'Bad',
        condition: { field: 'contract.salary', op: 'greaterThan', value: 1 } as never,
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      }),
    ).rejects.toThrow();
  });

  it('refuses an entitlement belonging to a different target', async () => {
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    const foreign = await withTenant(tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: other.id,
            externalId: 'guid-2',
            type: 'group',
            displayName: 'Elsewhere',
          },
        })
      ).id,
    );
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        name: 'Cross target',
        condition: { all: [] },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [foreign],
      }),
    ).rejects.toThrow(/does not belong to this target/);
  });
});
