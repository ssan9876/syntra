import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `localMasterKeyProvider`, which is what packages/core/src/vault/master-key.ts
// actually exports. There is no `staticMasterKeyProvider`; the existing
// `auth/authorize.test.ts` and `auth/mfa/totp.test.ts` both import this one.
import { localMasterKeyProvider } from '../vault/master-key.js';
import { putSecret } from '../vault/vault-service.js';
import {
  createTarget,
  deleteBusinessRule,
  deleteTarget,
  targetWithCredential,
  testTargetConfiguration,
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

// ---------------------------------------------------------------------------
// Beyond the brief. Everything above is the brief's file verbatim; everything
// below covers a defect found in it, or a path it left untested.
// ---------------------------------------------------------------------------

describe('createTarget, beyond the brief', () => {
  it('refuses a blank name', async () => {
    await expect(
      createTarget(tenantId, provider, null, {
        name: '   ',
        config,
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });

  it('refuses a type this package cannot read', async () => {
    // The column is text so a second connector family needs no migration, but
    // everything here parses the configuration with `adTargetConfigSchema`. A
    // row saying `okta` with an Active Directory config on it describes a
    // target nothing can read, and it would be discovered by a run failing.
    await expect(
      createTarget(tenantId, provider, null, {
        name: 'Okta',
        type: 'okta',
        config,
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });

  it('refuses an enforcement mode that is not one of the two', async () => {
    // `reconcile.ts` compares against the literal 'authoritative', so every
    // other string behaves as additive -- the mode the administrator did not
    // choose, displayed back to them as the mode they typed.
    await expect(
      createTarget(tenantId, provider, null, {
        name: 'Typo',
        config,
        bindPassword: 'x',
        enforcementMode: 'authoritive' as never,
      }),
    ).rejects.toThrow();
  });

  it('stores the resolved configuration, defaults and all', async () => {
    const { id } = await create();
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    // Nothing in `config` above says anything about these. A cast would have
    // handed the connector `undefined` for each.
    expect(loaded?.anchorAttribute).toBe('objectGUID');
    expect(loaded?.pageSize).toBe(1000);
    expect(loaded?.rejectUnauthorized).toBe(false);
  });
});

describe('updateTarget, beyond the brief', () => {
  it('rotates the credential into the vault entry the row actually names', async () => {
    // The row names the secret and `targetWithCredential` reads the secret the
    // row names, so a rotation that writes to a name *derived* from the target
    // id instead leaves the row pointing at the old ciphertext: the write
    // succeeds, the audit event says `credentialReplaced: true`, and the
    // target goes on binding with the credential that was just retired.
    const { id } = await create();
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id },
        data: { secretName: `target/${id}/bind-rotated-once` },
      }),
    );
    await withTenant(tenantId, (tx) =>
      putSecret(tx, provider, `target/${id}/bind-rotated-once`, 'super-secret'),
    );

    await updateTarget(tenantId, provider, null, id, { bindPassword: 'rotated-twice' });

    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.bindPassword).toBe('rotated-twice');
  });

  it('says so when no credential was replaced', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, { enabled: false });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' } }),
    );
    expect(events[0]!.payload).toMatchObject({ credentialReplaced: false });
  });

  it('writes the thresholds it accepts', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      thresholds: {
        createAccountThresholdPercent: 35,
        perEntitlementThresholdPercent: 5,
      },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.createAccountThresholdPercent).toBe(35);
    expect(row.perEntitlementThresholdPercent).toBe(5);
    // Untouched, not blanked.
    expect(row.disableAccountThresholdPercent).toBe(10);
  });

  it('refuses a threshold outside the range and writes nothing at all', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        name: 'Renamed',
        thresholds: { createAccountThresholdPercent: 400 },
      }),
    ).rejects.toThrow();
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    // The name went with it: a validation failure is not a partial save.
    expect(row.name).toBe('Acme AD');
    expect(row.createAccountThresholdPercent).toBe(20);
  });

  it('refuses a concurrency of zero, which is a run that never progresses', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, { concurrency: 0 }),
    ).rejects.toThrow();
  });

  it('refuses zero attempts, which is an action never tried and never failed', async () => {
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, { maxAttempts: 0 }),
    ).rejects.toThrow();
  });

  it('accepts the run settings and stores them', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      preHireDays: 14,
      maxAttempts: 5,
      concurrency: 8,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect([row.preHireDays, row.maxAttempts, row.concurrency]).toEqual([14, 5, 8]);
  });

  it('leaves the ladder alone when the update does not mention it', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: { disableGraceDays: 7, archiveAfterDays: 90 },
    });
    await updateTarget(tenantId, provider, null, id, { name: 'Acme AD 2' });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.disableGraceDays).toBe(7);
    expect(row.archiveAfterDays).toBe(90);
  });

  it('clears the archive step when the ladder sets it to null', async () => {
    // `undefined` means "not mentioned" and `null` means "never archive", and
    // the two have to stay distinguishable or the step can be set and not
    // unset.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: { disableGraceDays: 7, archiveAfterDays: 90 },
    });
    await updateTarget(tenantId, provider, null, id, {
      ladder: { archiveAfterDays: null },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.archiveAfterDays).toBeNull();
  });

  it('refuses a target in another tenant', async () => {
    const { id } = await create();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await expect(
      updateTarget(other.id, provider, null, id, { enabled: false }),
    ).rejects.toThrow();
  });
});

describe('deleteTarget, beyond the brief', () => {
  it('takes the bind credential with it', async () => {
    // A vault entry nothing can reach any more is a credential nobody is
    // watching, and the name is derived from an id that will never be issued
    // again, so nothing will ever overwrite it either.
    const { id } = await create();
    expect(await deleteTarget(tenantId, null, id, true)).toEqual({ ok: true });
    const secrets = await withTenant(tenantId, (tx) => tx.secret.findMany());
    expect(secrets).toEqual([]);
  });

  it('leaves another target credential alone', async () => {
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'other-secret',
    });
    await deleteTarget(tenantId, null, id, true);
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, other.id),
    );
    expect(loaded?.bindPassword).toBe('other-secret');
  });

  it('refuses a target that is not there rather than reporting three zeroes', async () => {
    await expect(
      deleteTarget(tenantId, null, '00000000-0000-4000-8000-000000000000', false),
    ).rejects.toThrow();
  });

  it('counts only this target rows', async () => {
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    await withTenant(tenantId, async (tx) => {
      await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: other.id,
          externalId: 'guid-elsewhere',
          type: 'group',
          displayName: 'Elsewhere',
        },
      });
    });
    expect(await deleteTarget(tenantId, null, id, false)).toEqual({
      ok: false,
      counts: { accounts: 0, rules: 0, entitlements: 0 },
    });
  });
});

describe('testTargetConfiguration', () => {
  const unreachable = {
    ...config,
    url: 'ldaps://127.0.0.1:2',
    connectTimeoutMs: 1000,
    timeoutMs: 1000,
  };

  it('refuses when no credential was supplied and none was named', async () => {
    const result = await testTargetConfiguration(tenantId, provider, { config });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/none to borrow/);
  });

  it('refuses to borrow for a different URL', async () => {
    // The whole point: a request naming a saved target without a password is
    // asking Syntra to send that password somewhere, and *where* is the
    // question. Splicing the vault entry into the caller's configuration would
    // let anyone who may configure targets read the credential back out by
    // naming a socket they control.
    const { id } = await create();
    const result = await testTargetConfiguration(tenantId, provider, {
      config: { ...config, url: 'ldaps://attacker.example:636' },
      borrowFromTargetId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only be borrowed for the transport/);
  });

  it('refuses to borrow with the certificate check turned off', async () => {
    const { id } = await createTarget(tenantId, provider, null, {
      name: 'Strict',
      config: { ...config, rejectUnauthorized: true },
      bindPassword: 'x',
    });
    const result = await testTargetConfiguration(tenantId, provider, {
      config: { ...config, rejectUnauthorized: false },
      borrowFromTargetId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only be borrowed for the transport/);
  });

  it('refuses to borrow from a target that is not there', async () => {
    const result = await testTargetConfiguration(tenantId, provider, {
      config,
      borrowFromTargetId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no saved credential/);
  });

  it('refuses to borrow across tenants', async () => {
    const { id } = await create();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const result = await testTargetConfiguration(other.id, provider, {
      config,
      borrowFromTargetId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no saved credential/);
  });

  it('borrows when the transport matches, and gets as far as the socket', async () => {
    // The permitting half of the rule. It has to be tested from this side too:
    // a borrow check that refuses everything passes every refusal test there
    // is, and an administrator who edited a search base can never re-test.
    // Reaching a connection failure rather than a borrow refusal is what
    // proves the credential was handed over.
    const created = await createTarget(tenantId, provider, null, {
      name: 'Unreachable',
      config: unreachable,
      bindPassword: 'x',
    });
    const result = await testTargetConfiguration(tenantId, provider, {
      config: unreachable,
      borrowFromTargetId: created.id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/borrow/);
  });

  it('refuses a configuration that would write in the clear before anything else', async () => {
    await expect(
      testTargetConfiguration(tenantId, provider, {
        config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('upsertAccountProfile, beyond the brief', () => {
  const profile = {
    correlationKeyTemplate: '%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=%contract.department%,%baseDn%',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: {},
    initialPasswordPolicy: {},
    initialPasswordDelivery: 'vaultOnly' as const,
  };

  it('replaces the profile rather than adding a second one', async () => {
    const { id } = await create();
    await upsertAccountProfile(tenantId, null, id, profile);
    await upsertAccountProfile(tenantId, null, id, {
      ...profile,
      fallbackContainer: 'OU=Staff,DC=acme,DC=test',
    });
    const rows = await withTenant(tenantId, (tx) =>
      tx.accountProfile.findMany({ where: { targetSystemId: id } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fallbackContainer).toBe('OU=Staff,DC=acme,DC=test');
  });

  it('refuses a profile for a target that is not there', async () => {
    await expect(
      upsertAccountProfile(
        tenantId,
        null,
        '00000000-0000-4000-8000-000000000000',
        profile,
      ),
    ).rejects.toThrow();
  });

  it('refuses an attribute template that would disable the account', async () => {
    // `update_account` writes every managed attribute as a `replace` and is
    // deliberately absent from GUARDED_ACTION_TYPES, so this would be a
    // disable the guard does not count and the ladder does not sequence.
    const { id } = await create();
    await expect(
      upsertAccountProfile(tenantId, null, id, {
        ...profile,
        attributeTemplates: { userAccountControl: '514' },
      }),
    ).rejects.toThrow(/may not write/);
  });

  it('audits against the target, so the event can be found from the target', async () => {
    const { id } = await create();
    await upsertAccountProfile(tenantId, null, id, profile);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.profile.upsert' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(id);
    expect(events[0]!.targetType).toBe('TargetSystem');
  });
});

describe('upsertBusinessRule, beyond the brief', () => {
  const rule = {
    name: 'Finance staff',
    condition: {
      field: 'contract.department' as const,
      op: 'equals' as const,
      value: 'Finance',
    },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [] as string[],
  };

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

  it('refuses to edit a rule that belongs to another target', async () => {
    // The ownership check asks whether the ENTITLEMENTS belong to `targetId`.
    // It says nothing about the rule, so a rule on target A, edited through
    // target B's endpoint, passes it and then acquires B's entitlements --
    // which is the cross-target grant the check exists to refuse, reached by
    // the one path the check does not look at.
    const a = await create();
    const b = await createTarget(tenantId, provider, null, {
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    const ruleOnA = await upsertBusinessRule(tenantId, null, a.id, rule);
    const entitlementOnB = await entitlement(b.id, 'guid-b');

    await expect(
      upsertBusinessRule(tenantId, null, b.id, {
        ...rule,
        id: ruleOnA.id,
        entitlementIds: [entitlementOnB],
      }),
    ).rejects.toThrow(/does not belong to this target/);

    const joins = await withTenant(tenantId, (tx) =>
      tx.ruleEntitlement.findMany({ where: { ruleId: ruleOnA.id } }),
    );
    expect(joins).toEqual([]);
  });

  it('refuses to edit a rule that is not there', async () => {
    const { id } = await create();
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        ...rule,
        id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/does not belong to this target/);
  });

  it('updates in place and audits it as an update', async () => {
    const { id } = await create();
    const created = await upsertBusinessRule(tenantId, null, id, rule);
    const updated = await upsertBusinessRule(tenantId, null, id, {
      ...rule,
      id: created.id,
      name: 'Finance staff, revised',
      enabled: false,
    });
    expect(updated.id).toBe(created.id);

    const rows = await withTenant(tenantId, (tx) => tx.businessRule.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Finance staff, revised');
    expect(rows[0]!.enabled).toBe(false);

    const actions = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: 'provision.rule.' } },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(actions.map((e) => e.action)).toEqual([
      'provision.rule.create',
      'provision.rule.update',
    ]);
  });

  it('replaces the entitlement joins rather than adding to them', async () => {
    const { id } = await create();
    const first = await entitlement(id, 'guid-1');
    const second = await entitlement(id, 'guid-2');
    const created = await upsertBusinessRule(tenantId, null, id, {
      ...rule,
      entitlementIds: [first],
    });
    await upsertBusinessRule(tenantId, null, id, {
      ...rule,
      id: created.id,
      entitlementIds: [second],
    });
    const joins = await withTenant(tenantId, (tx) =>
      tx.ruleEntitlement.findMany({ where: { ruleId: created.id } }),
    );
    expect(joins.map((j) => j.entitlementId)).toEqual([second]);
  });

  it('accepts the same entitlement named twice', async () => {
    // `@@unique([ruleId, entitlementId])` makes the second insert a P2002, and
    // the ownership count would have reported it as a foreign entitlement
    // first -- the wrong reason, for a request that names nothing wrong.
    const { id } = await create();
    const only = await entitlement(id, 'guid-1');
    const created = await upsertBusinessRule(tenantId, null, id, {
      ...rule,
      entitlementIds: [only, only],
    });
    const joins = await withTenant(tenantId, (tx) =>
      tx.ruleEntitlement.findMany({ where: { ruleId: created.id } }),
    );
    expect(joins).toHaveLength(1);
  });

  it('refuses a condition deeper than the cap, at the write boundary', async () => {
    const { id } = await create();
    let condition: unknown = { field: 'person.status', op: 'isNotEmpty' };
    for (let i = 0; i < 20_000; i += 1) condition = { all: [condition] };
    await expect(
      upsertBusinessRule(tenantId, null, id, {
        ...rule,
        condition: condition as never,
      }),
    ).rejects.toThrow(/nest at most/);
  });

  it('records the condition it stored on the audit event', async () => {
    const { id } = await create();
    await upsertBusinessRule(tenantId, null, id, rule);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.rule.create' } }),
    );
    expect(events[0]!.payload).toMatchObject({
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      entitlementCount: 0,
    });
  });
});

describe('deleteBusinessRule', () => {
  it('deletes the rule, its joins and audits it by name', async () => {
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
    const created = await upsertBusinessRule(tenantId, null, id, {
      name: 'Finance staff',
      condition: { all: [] },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });

    await deleteBusinessRule(tenantId, null, created.id);

    expect(await withTenant(tenantId, (tx) => tx.businessRule.count())).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.ruleEntitlement.count())).toBe(0);
    // The entitlement itself is a fact about the target and outlives the rule.
    expect(await withTenant(tenantId, (tx) => tx.entitlement.count())).toBe(1);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.rule.delete' } }),
    );
    expect(events[0]!.payload).toMatchObject({ name: 'Finance staff' });
  });

  it('refuses a rule that is not there', async () => {
    await expect(
      deleteBusinessRule(tenantId, null, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow();
  });
});
