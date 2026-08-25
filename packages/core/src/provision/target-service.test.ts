import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `localMasterKeyProvider`, which is what packages/core/src/vault/master-key.ts
// actually exports. There is no `staticMasterKeyProvider`; the existing
// `auth/authorize.test.ts` and `auth/mfa/totp.test.ts` both import this one.
import { localMasterKeyProvider } from '../vault/master-key.js';
import { putSecret } from '../vault/vault-service.js';
import {
  LadderConfigurationError,
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
      type: 'activeDirectory',
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
      type: 'activeDirectory',
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

  // The two tests above assert the message and would pass just as well against
  // a bare `Error` -- which is what this used to throw, and why a caller who
  // ordered the rungs wrongly got a 500 with an empty body while the server
  // logged the exact sentence explaining it. What makes the message reach them
  // is the TYPE, so that is what this pins.
  it('refuses a mis-ordered ladder as a coded configuration error, not a fault', async () => {
    const { id } = await create();

    // `updateTarget` resolves to void, so catching the rejection gives a
    // `void | Error` union. Failing the test on the resolve path is what
    // narrows it -- and is worth asserting anyway: an update that quietly
    // succeeded here would be the same defect wearing different clothes.
    const refusal = async (
      ladder: NonNullable<Parameters<typeof updateTarget>[4]['ladder']>,
    ) => {
      try {
        await updateTarget(tenantId, provider, null, id, { ladder });
      } catch (cause) {
        expect(cause).toBeInstanceOf(LadderConfigurationError);
        return cause as LadderConfigurationError;
      }
      throw new Error('expected the update to be refused, but it was accepted');
    };

    const archive = await refusal({ disableGraceDays: 0, archiveAfterDays: 0 });
    expect(archive.code).toBe('ladder-archive-not-after-disable');
    // The field the console highlights. A message with nowhere to put it sends
    // an administrator hunting through a form of seven numbers.
    expect(archive.field).toBe('ladder.archiveAfterDays');

    const revocation = await refusal({
      entitlementRevocationDelayDays: 14,
      disableGraceDays: 3,
    });
    expect(revocation.code).toBe('ladder-revocation-after-disable');
    expect(revocation.field).toBe('ladder.entitlementRevocationDelayDays');
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
      type: 'activeDirectory',
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
      type: 'activeDirectory',
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
      type: 'activeDirectory',
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
    ).rejects.toThrow(/no such target system/);
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
      type: 'activeDirectory',
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
    ).rejects.toThrow(/no such target system/);
  });

  it('counts only this target rows', async () => {
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
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

  it('refuses an empty bind password rather than binding anonymously', async () => {
    // An empty string is not an absent value, and this is the third place on
    // this branch where treating them as one cost something. `''` is not
    // `undefined`, so it skipped the borrow, the transport comparison and the
    // vault read, and reached the directory as `client.bind(bindDn, '')` --
    // RFC 4513 §5.1.2's *unauthenticated authentication mechanism*, which
    // OpenLDAP and Samba answer with `success` and an anonymous authorization.
    // The connector reports `ok: true` for any successful bind, so the caller
    // was told the target was reachable with a rights problem, not that the
    // credential never authenticated.
    //
    // The message is asserted rather than `toThrow()`: `testTargetRequestSchema`
    // refuses this over HTTP already, and the point of the check here is that
    // the service refuses it for the callers the route does not speak for.
    await expect(
      testTargetConfiguration(tenantId, provider, {
        type: 'activeDirectory',
        config,
        bindPassword: '',
      }),
    ).rejects.toThrow(/at least 1 character/);
  });

  it('refuses a borrow target that is not a uuid', async () => {
    // The other unvalidated scalar. A non-uuid reached
    // `tx.targetSystem.findUnique` and came back as a driver error, which the
    // route turns into a 500.
    await expect(
      testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
        config,
        borrowFromTargetId: 'the head office one',
      }),
    ).rejects.toThrow(/Invalid uuid/);
  });

  it('refuses when no credential was supplied and none was named', async () => {
    const result = await testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
      config,
    });
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
      type: 'activeDirectory',
      config: { ...config, url: 'ldaps://attacker.example:636' },
      borrowFromTargetId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only be borrowed for a target of the same type/);
  });

  it('refuses to borrow with the certificate check turned off', async () => {
    const { id } = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Strict',
      config: { ...config, rejectUnauthorized: true },
      bindPassword: 'x',
    });
    const result = await testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
      config: { ...config, rejectUnauthorized: false },
      borrowFromTargetId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only be borrowed for a target of the same type/);
  });

  it('refuses to borrow from a target that is not there', async () => {
    const result = await testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
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
      type: 'activeDirectory',
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
      type: 'activeDirectory',
      name: 'Unreachable',
      config: unreachable,
      bindPassword: 'x',
    });
    const result = await testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
      config: unreachable,
      borrowFromTargetId: created.id,
    });
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/borrow/);
  });

  it('refuses a configuration that would write in the clear before anything else', async () => {
    await expect(
      testTargetConfiguration(tenantId, provider, {
      type: 'activeDirectory',
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
    ).rejects.toThrow(/no such target system/);
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
      type: 'activeDirectory',
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
    ).rejects.toThrow(/no such business rule/);
  });
});

describe('the gaps the mutation pass found', () => {
  it('accepts a revocation that falls on the disable day itself', async () => {
    // The ladder rule is `<=`, not `<`. Revoking the entitlements on the same
    // day the account is disabled is the ordinary configuration, and a `>`
    // mutated to `>=` refuses exactly it while every refusal test still
    // passes.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: { entitlementRevocationDelayDays: 7, disableGraceDays: 7 },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.entitlementRevocationDelayDays).toBe(7);
  });

  it('refuses a disable pushed past an archive step already set', async () => {
    // The merge is what makes this work: the update mentions only the disable,
    // and the archive has to be read off the row for the comparison to happen
    // at all. Without the merge this reaches the CHECK constraint and comes
    // back as a 500 with a constraint name in it.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      ladder: { disableGraceDays: 7, archiveAfterDays: 90 },
    });
    await expect(
      updateTarget(tenantId, provider, null, id, {
        ladder: { disableGraceDays: 100 },
      }),
    ).rejects.toThrow(/archive must fall strictly after the disable/);
  });

  it('creates a target enabled and not auto-applying', async () => {
    // A target created disabled is configured but never runs; one created
    // auto-applying writes to a live directory before anybody has looked at a
    // preview.
    const { id } = await create();
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.enabled).toBe(true);
    expect(row.autoApply).toBe(false);
    expect(row.enforcementMode).toBe('additive');
  });

  it('honours an explicit disabled, non-additive create', async () => {
    const created = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Staged',
      config,
      bindPassword: 'x',
      enabled: false,
      autoApply: true,
      enforcementMode: 'authoritative',
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.enabled).toBe(false);
    expect(row.autoApply).toBe(true);
    expect(row.enforcementMode).toBe('authoritative');
  });

  it('records where the target points on the creation event', async () => {
    // Not decoration: this is the record of what an administrator pointed
    // Syntra at, and it is the only place the transport is written down
    // outside the row itself.
    const { id } = await create();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.create' } }),
    );
    expect(events[0]!.payload).toMatchObject({
      name: 'Acme AD',
      url: 'ldaps://dc.acme.test:636',
      tlsMode: 'ldaps',
      enforcementMode: 'additive',
    });
    expect(events[0]!.targetId).toBe(id);
  });

  it('refuses a name longer than the column should hold', async () => {
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'x'.repeat(201),
        config,
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });

  it('refuses a paired directory source that is not a uuid', async () => {
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'Paired',
        config,
        bindPassword: 'x',
        pairedDirectorySourceId: 'the head office one',
      }),
    ).rejects.toThrow();
  });

  it('pairs a target with a directory source and stores it', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Head office AD',
          type: 'ldap',
          config: {},
          secretName: 'source/x',
        },
      }),
    );
    const created = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Paired',
      config,
      bindPassword: 'x',
      pairedDirectorySourceId: source.id,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.pairedDirectorySourceId).toBe(source.id);
  });

  it('refuses a pairing that names a directory source this tenant does not have', async () => {
    // A uuid is not a source. Every reader of this column asks only whether it
    // is non-null -- `claimSyntraUsers`, `enqueuePairedSync`, the run summary's
    // `pairedDirectorySource` flag -- so a well-formed id naming nothing passes
    // the gate that exists to fail closed, claims zero logins, and reports the
    // same result a healthy target reports. The message is asserted, not just
    // "it threw": the foreign key refuses this too, and the difference between
    // the check and its absence is a 400 an editor can highlight versus a 500
    // with a constraint name in it.
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'Paired',
        config,
        bindPassword: 'x',
        pairedDirectorySourceId: randomUUID(),
      }),
    ).rejects.toThrow(/no such directory source to pair with/);
  });

  it('refuses a pairing with another tenant’s directory source', async () => {
    // The half the foreign key cannot do. It references `DirectorySource(id)`
    // alone, so another tenant's source satisfies it perfectly; only a read
    // under the bound tenant's row-level security can tell them apart. A
    // cross-tenant pairing is a target whose inward status propagation reads
    // somebody else's directory.
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const theirs = await withTenant(other.id, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId: other.id,
          name: 'Their AD',
          type: 'ldap',
          config: {},
          secretName: 'source/theirs',
        },
      }),
    );
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'Paired',
        config,
        bindPassword: 'x',
        pairedDirectorySourceId: theirs.id,
      }),
    ).rejects.toThrow(/no such directory source to pair with/);
  });

  it('leaves an existing pairing alone when an update names a source that is not there', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Head office AD',
          type: 'ldap',
          config: {},
          secretName: 'source/x',
        },
      }),
    );
    const created = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Paired',
      config,
      bindPassword: 'x',
      pairedDirectorySourceId: source.id,
    });
    await expect(
      updateTarget(tenantId, provider, null, created.id, {
        pairedDirectorySourceId: randomUUID(),
      }),
    ).rejects.toThrow(/no such directory source to pair with/);
    // The refusal has to take the whole transaction with it. A target left
    // pointing at nothing is the state this check exists to prevent, and one
    // repointed at nothing by a rejected request is the same state arrived at
    // more confusingly.
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.pairedDirectorySourceId).toBe(source.id);
  });

  it('still accepts an update that clears the pairing', async () => {
    // `null` names nothing on purpose, and must not be read as a source that
    // does not exist. Unpairing is how a target is taken off a directory.
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Head office AD',
          type: 'ldap',
          config: {},
          secretName: 'source/x',
        },
      }),
    );
    const created = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Paired',
      config,
      bindPassword: 'x',
      pairedDirectorySourceId: source.id,
    });
    await updateTarget(tenantId, provider, null, created.id, {
      pairedDirectorySourceId: null,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.pairedDirectorySourceId).toBeNull();
  });

  it('stores the schedule an update sets and clears it with null', async () => {
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, { schedule: '0 2 * * *' });
    expect(
      (
        await withTenant(tenantId, (tx) =>
          tx.targetSystem.findUniqueOrThrow({ where: { id } }),
        )
      ).schedule,
    ).toBe('0 2 * * *');
    await updateTarget(tenantId, provider, null, id, { schedule: null });
    expect(
      (
        await withTenant(tenantId, (tx) =>
          tx.targetSystem.findUniqueOrThrow({ where: { id } }),
        )
      ).schedule,
    ).toBeNull();
  });

  it('refuses a malformed cron expression rather than committing it', async () => {
    // An hour of 25. It used to commit, audit as a success and only then throw
    // out of pg-boss, leaving the stored schedule and the firing schedule
    // permanently disagreeing -- and where the target had no schedule before,
    // leaving one that never fires at all, which produces no run, therefore no
    // `consecutiveSkippedRuns` and no `lastSkipReason`: a target that has
    // stopped running looks exactly like one running cleanly.
    //
    // NOT the four-field `'0 2 * *'` this fixture started as, and the reason is
    // worth leaving here. `CronExpressionParser.parse('0 2 * *', { strict:
    // false })` -- pg-boss's own call -- ACCEPTS it, left-pads the missing
    // field and stringifies it back as `* 0 2 * *`: every minute of hour 0 on
    // the 2nd of the month. So a dropped field is not the throw this test is
    // about; it is a silent reinterpretation, and no validator that accepts
    // exactly what the scheduler accepts can refuse it. Checked, not assumed.
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, { schedule: '0 25 * * *' }),
    ).rejects.toThrow(/not a cron expression the scheduler can use/);

    // And it took the whole transaction with it. A row carrying a schedule the
    // scheduler refused is the divergence this check exists to prevent.
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.schedule).toBeNull();
  });

  it('refuses a malformed cron expression on a create, before the row exists', async () => {
    // The create is the worse half: the target and its vault entry commit, the
    // 500 arrives instead of the id, and the retry hits
    // `@@unique([tenantId, name])` -- so the administrator cannot create the
    // target, is not told one exists, and the one that does has a schedule
    // that will never fire.
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'Nightly',
        config,
        bindPassword: 'x',
        schedule: 'every night at two',
      }),
    ).rejects.toThrow(/not a cron expression the scheduler can use/);
    const rows = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findMany({ where: { name: 'Nightly' } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses the empty string as a schedule, which is not how a schedule is cleared', async () => {
    // An empty string is not an absent value. `null` clears the schedule;
    // `''` is a cron expression nobody wrote, and letting it mean `null` by
    // accident is the same conflation as a blank anchor matching everything.
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, { schedule: '' }),
    ).rejects.toThrow();
  });

  it('replaces the configuration whole on an update', async () => {
    // Replaced, never merged: the schema resolves defaults and cross-checks
    // the TLS mode against the URL scheme, and merging a fragment over a
    // stored blob would let a half-configuration reach the connector with the
    // checks having passed on the fragment alone.
    //
    // The assertions on the first update are NOT what proves that. Replace and
    // merge produce identical results for a key the incoming object sets, so
    // this test used to pass unchanged against
    // `{ config: { ...(before.config as object), ...config } }` -- verified by
    // making that edit and running it. The distinguishing case is a key the
    // second update OMITS, and that is the second half below.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      config: {
        ...config,
        baseDn: 'OU=Staff,DC=acme,DC=test',
        pageSize: 250,
        primaryGroupExternalIds: ['guid-domain-users'],
      },
    });
    const first = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(first?.baseDn).toBe('OU=Staff,DC=acme,DC=test');
    expect(first?.pageSize).toBe(250);
    expect(first?.primaryGroupExternalIds).toEqual(['guid-domain-users']);

    // The same six required fields again and nothing else. Under a merge,
    // `pageSize` stays 250 and the primary group survives; under a replace,
    // both revert to what `adTargetConfigSchema` resolves for a config that
    // does not mention them.
    await updateTarget(tenantId, provider, null, id, { config });
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.pageSize).toBe(1000);
    expect(loaded?.primaryGroupExternalIds).toEqual([]);
    // Worth stating, because nothing else records it: this is the production
    // behaviour, not an artefact of the test. An update that omits an optional
    // config key silently reverts that key to its default, so a caller
    // PATCHing only the required fields to correct a URL also resets the
    // account filter and the primary groups.
    expect(loaded?.accountFilter).toBe('(&(objectCategory=person)(objectClass=user))');
  });

  it('refuses a configuration fragment rather than merging it over the stored one', async () => {
    // The other half of "replaced, never merged", and the half the omitted-key
    // assertions above cannot reach. `updateTarget` parses the incoming config
    // before it writes, and every optional key in `adTargetConfigSchema` has a
    // default -- so the parsed object is total, and merging THAT over the
    // stored blob is indistinguishable from replacing it. What is
    // distinguishable is merging the RAW body: under that, this fragment
    // completes itself from the stored row and saves, and a configuration
    // nobody validated as a whole reaches the connector. Under a replace it is
    // six missing required fields and a validation error.
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, { config: { pageSize: 250 } }),
    ).rejects.toThrow(/Required/);
  });

  it('refuses an update that would put the configuration in the clear', async () => {
    // `Invalid enum value` is Zod's. The CHECK constraint
    // `target_system_encrypted_transport` refuses this too, and a bare
    // `toThrow()` cannot tell the schema from the backstop -- which is the
    // difference between a field an editor can highlight and a 500 with a
    // constraint name in it.
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
      }),
    ).rejects.toThrow(/Invalid enum value/);
  });
});

describe('the second gaps the mutation pass found', () => {
  it('resolves the configuration defaults into the stored column', async () => {
    // The create-time parse and the read-time parse each hid the other: with
    // both in place, dropping either one still produced a resolved config at
    // every assertion, because whichever survived filled the defaults in.
    // This one looks at the column itself.
    const { id } = await create();
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.config).toMatchObject({
      anchorAttribute: 'objectGUID',
      pageSize: 1000,
      provenanceAttribute: 'info',
      rejectUnauthorized: false,
    });
  });

  it('resolves defaults a stored row never had', async () => {
    // And the other half: a column written before the schema grew a field.
    // A cast asserts that such a row satisfies today's schema; parsing makes
    // it true, and the difference reaches the connector as `undefined` in a
    // live LDAP request.
    const { id } = await create();
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id },
        data: {
          config: {
            url: 'ldaps://dc.acme.test:636',
            tlsMode: 'ldaps',
            bindDn: 'CN=svc,DC=acme,DC=test',
            baseDn: 'OU=Users,DC=acme,DC=test',
            entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
            archiveContainer: 'OU=Archive,DC=acme,DC=test',
          },
        },
      }),
    );
    const loaded = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, id),
    );
    expect(loaded?.anchorAttribute).toBe('objectGUID');
    expect(loaded?.pageSize).toBe(1000);
    expect(loaded?.rejectUnauthorized).toBe(true);
  });

  it('writes the fields an update names', async () => {
    // Every other update test asserted a *derived* consequence -- an audit
    // payload, a ladder column -- so an update that silently dropped `name`
    // or `enabled` passed all of them.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      name: 'Acme AD (renamed)',
      enabled: false,
      autoApply: true,
      pairedDirectorySourceId: null,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.name).toBe('Acme AD (renamed)');
    expect(row.enabled).toBe(false);
    expect(row.autoApply).toBe(true);
  });

  it('resolves the configuration defaults into the column on an update', async () => {
    // Named for what it checks. It used to be called "...on an update that
    // replaces the config", but both of its assertions -- a key the update
    // sets and a default a merge over an already-defaulted blob also yields --
    // hold under a merge too. The replacement semantics are pinned by
    // 'replaces the configuration whole on an update' above, which omits a key
    // on the second write; this one pins that the stored column is the
    // RESOLVED config rather than what arrived.
    const { id } = await create();
    await updateTarget(tenantId, provider, null, id, {
      config: { ...config, pageSize: 250 },
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.config).toMatchObject({ pageSize: 250, anchorAttribute: 'objectGUID' });
  });

  it('refuses an out-of-range threshold as a validation error, not a constraint', async () => {
    // `target_system_thresholds_are_percent` catches this too, so a test that
    // only asserts "it threw" cannot tell the service's validation from the
    // database's backstop -- and the difference is a message an administrator
    // can act on versus a 500 with a constraint name in it.
    const { id } = await create();
    await expect(
      updateTarget(tenantId, provider, null, id, {
        thresholds: { createAccountThresholdPercent: 400 },
      }),
    ).rejects.toThrow(/less than or equal to 100/);
  });

  it('refuses a non-uuid paired source as a validation error, not a driver error', async () => {
    // Prisma rejects a non-uuid for a `@db.Uuid` column too, so the same
    // problem: the check and its absence are indistinguishable unless the
    // message is asserted.
    await expect(
      createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
        name: 'Paired',
        config,
        bindPassword: 'x',
        pairedDirectorySourceId: 'the head office one',
      }),
    // `Invalid uuid` is Zod's wording. Prisma's is "Error creating UUID,
    // invalid character", so a case-insensitive /uuid/ matches both and the
    // check and its absence stay indistinguishable -- the exact failure this
    // assertion was added to fix, one layer in.
    ).rejects.toThrow(/Invalid uuid/);
  });

  it('counts only this target’s accounts and rules', async () => {
    // The earlier version of this test gave the other target an entitlement
    // and nothing else, so dropping the `where` from the ACCOUNT count -- a
    // different statement -- changed nothing anybody looked at.
    const { id } = await create();
    const other = await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Other AD',
      config,
      bindPassword: 'x',
    });
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: other.id,
          personId: person.id,
          correlationKey: 'anna.novak',
        },
      });
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
    await upsertBusinessRule(tenantId, null, other.id, {
      name: 'Elsewhere staff',
      condition: { all: [] },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [],
    });

    expect(await deleteTarget(tenantId, null, id, false)).toEqual({
      ok: false,
      counts: { accounts: 0, rules: 0, entitlements: 0 },
    });
  });
});
