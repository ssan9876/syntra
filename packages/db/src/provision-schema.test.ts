import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let personId: string;
let targetId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
  provenanceAttribute: 'info',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', config, secretName: 'target/ad/bind' },
    });
    return { personId: person.id, targetId: target.id };
  });
  personId = seeded.personId;
  targetId = seeded.targetId;
});

describe('provision schema', () => {
  it('defaults a target to additive enforcement and the spec ladder', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Additive, because an engine that silently strips what it did not grant
    // gets switched off inside a week (Ruling P2).
    expect(target.enforcementMode).toBe('additive');
    expect(target.preHireDays).toBe(0);
    expect(target.entitlementRevocationDelayDays).toBe(0);
    // Zero: a leaver's access ends when their contract ends. Handover time is
    // a choice an organization makes, not a default it inherits.
    expect(target.disableGraceDays).toBe(0);
    expect(target.archiveAfterDays).toBeNull();
    expect(target.reenableWithoutConfirmationDays).toBe(7);
    expect(target.renameEnabled).toBe(false);
    expect(target.autoApply).toBe(false);
  });

  it('defaults every guard threshold to the spec value', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target.createAccountThresholdPercent).toBe(20);
    expect(target.disableAccountThresholdPercent).toBe(10);
    expect(target.archiveAccountThresholdPercent).toBe(2);
    expect(target.revokeEntitlementThresholdPercent).toBe(10);
    expect(target.deactivateSyntraUserThresholdPercent).toBe(10);
    expect(target.perEntitlementThresholdPercent).toBe(50);
    expect(target.personPopulationDropPercent).toBe(20);
    expect(target.maxAttempts).toBe(3);
    expect(target.concurrency).toBe(4);
  });

  it('starts a target with no skip history', async () => {
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Ruling P4: this lives on the target row, not only in an audit event,
    // because the target row is where somebody looks.
    expect(target.consecutiveSkippedRuns).toBe(0);
    expect(target.lastSkippedAt).toBeNull();
    expect(target.lastSkipReason).toBeNull();
  });

  it('refuses a target configured to write in the clear', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.create({
          data: {
            tenantId,
            name: 'Plaintext',
            config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
            secretName: 'target/plain/bind',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a target whose config names no transport at all', async () => {
    // `config ->> 'tlsMode'` is SQL NULL when the key is absent, and a CHECK
    // constraint passes on NULL. The one config that says nothing about its
    // transport must not be the one config that gets through.
    const { tlsMode: _omitted, ...withoutTlsMode } = config;
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.create({
          data: {
            tenantId,
            name: 'Silent',
            config: withoutTlsMode,
            secretName: 'target/silent/bind',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a ladder that revokes entitlements after the account is disabled', async () => {
    // An account whose entitlements were stripped a week before it was
    // disabled belongs to somebody who is still employed as far as the
    // directory is concerned and cannot do anything.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.update({
          where: { id: targetId },
          data: { entitlementRevocationDelayDays: 7, disableGraceDays: 3 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an archive that lands on or before the disable', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.update({
          where: { id: targetId },
          data: { disableGraceDays: 30, archiveAfterDays: 30 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('accepts a ladder in the right order', async () => {
    const updated = await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          entitlementRevocationDelayDays: 0,
          disableGraceDays: 7,
          archiveAfterDays: 90,
        },
      }),
    );
    expect(updated.archiveAfterDays).toBe(90);
  });

  it('isolates OrgUnitContainer rows between tenants', async () => {
    const unit = await withTenant(tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }),
    );
    const created = await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: {
          tenantId,
          orgUnitId: unit.id,
          targetSystemId: targetId,
          dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
        },
      }),
    );
    expect(created.state).toBe('desired');
    expect(created.anchor).toBeNull();

    // Written without a tenant filter on purpose: the point is that the
    // database refuses it, not that the application remembered to ask.
    const other = await prisma.tenant.create({ data: { name: 'Two', slug: 'two' } });
    const leaked = await withTenant(other.id, (tx) => tx.orgUnitContainer.findMany());
    expect(leaked).toEqual([]);
  });

  it('allows one materialisation per unit per target and refuses a second', async () => {
    const unit = await withTenant(tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }),
    );
    const row = {
      tenantId,
      orgUnitId: unit.id,
      targetSystemId: targetId,
      dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
    };
    await withTenant(tenantId, (tx) => tx.orgUnitContainer.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) =>
        tx.orgUnitContainer.create({
          data: { ...row, dn: 'OU=Sales2,OU=Users,DC=acme,DC=test' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses two units claiming one container on the same target', async () => {
    // Two units on one DN would converge two departments' accounts into a
    // single container with no error raised anywhere, and the drift check
    // would then read one row's intent as the other's reality.
    const [sales, support] = await withTenant(tenantId, async (tx) => [
      await tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }),
      await tx.orgUnit.create({ data: { tenantId, name: 'Support' } }),
    ]);
    const dn = 'OU=Shared,OU=Users,DC=acme,DC=test';
    await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: { tenantId, orgUnitId: sales!.id, targetSystemId: targetId, dn },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.orgUnitContainer.create({
          data: { tenantId, orgUnitId: support!.id, targetSystemId: targetId, dn },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a blank container DN and an unknown state', async () => {
    const unit = await withTenant(tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.orgUnitContainer.create({
          data: { tenantId, orgUnitId: unit.id, targetSystemId: targetId, dn: '   ' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.orgUnitContainer.create({
          data: {
            tenantId,
            orgUnitId: unit.id,
            targetSystemId: targetId,
            dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
            state: 'probably',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('defaults a target to five container creates per run', async () => {
    // An absolute count, not a share. Asserted here so that a future change
    // turning it into a percentage has to come through this test.
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target.maxContainerCreatesPerRun).toBe(5);
  });

  it('keeps a person when their org unit is deleted', async () => {
    // SET NULL, not CASCADE. Deleting a unit must never delete people.
    const unit = await withTenant(tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.person.update({ where: { id: personId }, data: { orgUnitId: unit.id } }),
    );
    await withTenant(tenantId, (tx) => tx.orgUnit.delete({ where: { id: unit.id } }));
    const person = await withTenant(tenantId, (tx) =>
      tx.person.findUniqueOrThrow({ where: { id: personId } }),
    );
    expect(person.orgUnitId).toBeNull();
  });

  it('isolates targets between tenants', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const seen = await withTenant(other.id, (tx) => tx.targetSystem.findMany());
    expect(seen).toEqual([]);
  });

  it('allows one account profile per target and refuses a second', async () => {
    // The brief enforced this with a hand-written `account_profile_one_per_target`
    // index; it is `@unique` on AccountProfile.targetSystemId instead, because
    // Prisma refuses a one-to-one relation whose defining side is not unique
    // (P1012) and `TargetSystem.profile` is `AccountProfile?`. Same rule, same
    // column -- and this asserts the swap did not weaken it.
    const profile = {
      tenantId,
      targetSystemId: targetId,
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
      fallbackContainer: 'OU=Users,DC=acme,DC=test',
      attributeTemplates: {},
      initialPasswordPolicy: {},
    };
    await withTenant(tenantId, (tx) => tx.accountProfile.create({ data: profile }));
    await expect(
      withTenant(tenantId, (tx) => tx.accountProfile.create({ data: profile })),
    ).rejects.toThrow();
  });

  it('allows one account per person per target and refuses a second', async () => {
    const row = {
      tenantId,
      targetSystemId: targetId,
      personId,
      correlationKey: 'a.novak',
    };
    await withTenant(tenantId, (tx) => tx.targetAccount.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.create({ data: { ...row, correlationKey: 'a.novak2' } }),
      ),
    ).rejects.toThrow();
  });

  it('reserves a correlation key even before the account exists in the target', async () => {
    const second = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Anne', familyName: 'Novak' },
      });
      return p.id;
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'a.novak' },
      }),
    );
    // Two runs generating the same name for two different people is a race
    // the database refuses, not one the application is trusted to avoid.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.create({
          data: {
            tenantId,
            targetSystemId: targetId,
            personId: second,
            correlationKey: 'a.novak',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows many pending accounts with a null anchor but only one per anchor', async () => {
    const second = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
      });
      return p.id;
    });
    // Two null anchors coexist -- this is the case a plain @@unique would
    // have permitted anyway, and it must keep working.
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'k1' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: second,
          correlationKey: 'k2',
        },
      });
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.updateMany({
        where: { correlationKey: 'k1' },
        data: { anchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'active' },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetAccount.updateMany({
          where: { correlationKey: 'k2' },
          data: { anchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows only one live holding per account and entitlement, and re-granting after a revoke', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: targetId, personId, correlationKey: 'a.novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: '11111111-2222-3333-4444-555555555555',
          type: 'group',
          displayName: 'Finance',
        },
      });
      return { accountId: account.id, entitlementId: entitlement.id };
    });
    const holding = { tenantId, ...ids, origin: 'rule' };
    await withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding }));
    await expect(
      withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding })),
    ).rejects.toThrow();

    // Revoking frees the slot; the index only covers live rows, and the
    // revoked row stays for history.
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.updateMany({
        where: { accountId: ids.accountId },
        data: { revokedAt: new Date(), state: 'revoked' },
      }),
    );
    await withTenant(tenantId, (tx) => tx.accountEntitlement.create({ data: holding }));
    expect(
      await withTenant(tenantId, (tx) => tx.accountEntitlement.count()),
    ).toBe(2);
  });

  it('allows only one non-terminal run per target', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'running' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new run once the previous one reached a terminal status', async () => {
    const first = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({
        where: { id: first.id },
        data: { status: 'applied', finishedAt: new Date() },
      }),
    );
    const second = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'running' },
      }),
    );
    expect(second.status).toBe('running');
  });

  it('keeps one drift finding per fingerprint across runs', async () => {
    const runIds = await withTenant(tenantId, async (tx) => {
      const a = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applied' },
      });
      const b = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      });
      return [a.id, b.id];
    });
    const fingerprint = 'unmanaged_entitlement:acct-1:ent-1';
    await withTenant(tenantId, (tx) =>
      tx.driftFinding.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          runId: runIds[0]!,
          kind: 'unmanaged_entitlement',
          detail: {},
          fingerprint,
        },
      }),
    );
    // A finding that persists is updated, not duplicated, so the dashboard
    // counts problems rather than runs.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.driftFinding.create({
          data: {
            tenantId,
            targetSystemId: targetId,
            runId: runIds[1]!,
            kind: 'unmanaged_entitlement',
            detail: {},
            fingerprint,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('records an exception by person, not as a count', async () => {
    const runId = await withTenant(tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'previewed' },
        })
      ).id,
    );
    await withTenant(tenantId, (tx) =>
      tx.provisionException.create({
        data: {
          tenantId,
          runId,
          personId,
          targetSystemId: targetId,
          kind: 'no_contracts',
          message: 'Anna Novak holds no contracts at all',
        },
      }),
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany({ include: { person: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person.givenName).toBe('Anna');
    expect(rows[0]!.kind).toBe('no_contracts');
  });

  it('defaults an action to proposed and no confirmation', async () => {
    const runId = await withTenant(tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status: 'previewed' },
        })
      ).id,
    );
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.create({
        data: { tenantId, runId, actionType: 'create_account', personId },
      }),
    );
    expect(action.status).toBe('proposed');
    expect(action.attempts).toBe(0);
    expect(action.requiresConfirmation).toBe(false);
    expect(action.attributedRuleIds).toEqual([]);
    // Defaulted so every fixture in this plan can create an action without
    // one; the run sets it explicitly from ACTION_ORDER (Task 13, phase 7).
    expect(action.sequence).toBe(0);
  });
});
