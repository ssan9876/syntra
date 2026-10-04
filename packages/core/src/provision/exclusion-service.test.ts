import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';
import { setPlacement } from './placement-service.js';
import { explainPersonAccess, previewRuleImpact } from './explain.js';
import { accessDeltaFor, projectPersonOnTargets } from './desired-state-loader.js';
import {
  AlreadyLeftOutError,
  ExclusionSubjectNotFoundError,
  NotLeftOutError,
  PersonLeftOutError,
  addTargetExclusion,
  leftOutMessage,
  listTargetExclusions,
  removeTargetExclusion,
} from './exclusion-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noSleep = async () => {};

let tenantId: string;
let targetId: string;
let entitlementId: string;
let adminId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: USERS,
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

async function seedPerson(givenName: string, familyName: string, endDate: Date | null = null) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName, familyName } });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        endDate,
        department: 'Finance',
      },
    });
    return person.id;
  });
}

/** A person with an account at the target that Syntra already manages. */
async function seedManaged(givenName: string, familyName: string, endDate: Date | null = null) {
  const personId = await seedPerson(givenName, familyName, endDate);
  const key = `${givenName}.${familyName}`.toLowerCase();
  const created = await target.write({ domain: 'acme.test' } as never, {
    op: 'create_account',
    actionId: `seed-${key}`,
    correlationKey: key,
    attributes: { distinguishedName: [`CN=${key},${USERS}`] },
    enabled: true,
    initialPassword: 'Aa1!seed-password',
  });
  await target.write({ domain: 'acme.test' } as never, {
    op: 'grant_entitlement',
    actionId: `seed-g-${key}`,
    anchor: created.anchor!,
    entitlementId: 'guid-finance',
  });
  const accountId = await withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId,
        anchor: created.anchor!,
        correlationKey: key,
        status: 'active',
        lastAppliedAttributes: { displayName: [`${givenName} ${familyName}`] },
      },
    });
    await tx.accountEntitlement.create({
      data: { tenantId, accountId: account.id, entitlementId, origin: 'rule' },
    });
    return account.id;
  });
  return { personId, accountId, anchor: created.anchor! };
}

const markApplied = () =>
  withTenant(tenantId, (tx) =>
    tx.targetSystem.update({ where: { id: targetId }, data: { lastAppliedRunAt: new Date() } }),
  );

const leaveOut = (personId: string, reason = 'Bootstrap administrator') =>
  withTenant(tenantId, (tx) =>
    addTargetExclusion(tx, { targetSystemId: targetId, personId, reason, actorUserId: adminId, sourceIp: null }),
  );

const includeAgain = (personId: string, reason = 'Handed over') =>
  withTenant(tenantId, (tx) =>
    removeTargetExclusion(tx, { targetSystemId: targetId, personId, reason, actorUserId: adminId, sourceIp: null }),
  );

const preview = () =>
  previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector: target as never });

const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  adminId = await withTenant(tenantId, async (tx) =>
    (await tx.user.create({ data: { tenantId, login: 'jane', email: 'jane@acme.test', displayName: 'Jane Doe' } })).id,
  );

  targetId = (
    await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;

  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push({ externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' });

  entitlementId = await withTenant(tenantId, async (tx) =>
    (
      await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-finance',
          dn: FINANCE_DN,
          type: 'group',
          displayName: 'Finance',
          status: 'present',
        },
      })
    ).id,
  );

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: USERS,
    fallbackContainer: USERS,
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });

  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
});

describe('addTargetExclusion and removeTargetExclusion', () => {
  it('records who left the person out and why, and audits both directions', async () => {
    const personId = await seedPerson('Seth', 'Sander');
    const view = await leaveOut(personId, 'FMX bootstrap administrator.');
    expect(view).toMatchObject({ personName: 'Seth Sander', targetName: 'Acme AD', createdByName: 'Jane Doe' });
    expect(view.message).toMatch(/^Left out of this target by Jane Doe on \d{1,2} \w{3} \d{4}: FMX bootstrap administrator\.$/);

    await includeAgain(personId, 'FMX retired');
    expect(await withTenant(tenantId, (tx) => listTargetExclusions(tx, targetId))).toEqual([]);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'provision.target.exclusion' } }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => [e.action, e.actorUserId, e.targetId])).toEqual([
      ['provision.target.exclusion.add', adminId, personId],
      ['provision.target.exclusion.remove', adminId, personId],
    ]);
    expect(events[0]!.payload).toMatchObject({ targetSystemId: targetId, reason: 'FMX bootstrap administrator.' });
    expect(events[1]!.payload).toMatchObject({ targetSystemId: targetId, reason: 'FMX retired' });
  });

  it('refuses a person already left out, and removing one who is not', async () => {
    const personId = await seedPerson('Seth', 'Sander');
    await leaveOut(personId);
    await expect(leaveOut(personId)).rejects.toBeInstanceOf(AlreadyLeftOutError);
    await includeAgain(personId);
    await expect(includeAgain(personId)).rejects.toBeInstanceOf(NotLeftOutError);
  });

  it("refuses another tenant's person or target", async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const foreignPerson = await withTenant(other.id, async (tx) =>
      (await tx.person.create({ data: { tenantId: other.id, givenName: 'Eve', familyName: 'Other' } })).id,
    );
    await expect(leaveOut(foreignPerson)).rejects.toBeInstanceOf(ExclusionSubjectNotFoundError);
    const personId = await seedPerson('Seth', 'Sander');
    await expect(
      withTenant(other.id, (tx) =>
        addTargetExclusion(tx, { targetSystemId: targetId, personId, reason: 'x', actorUserId: null, sourceIp: null }),
      ),
    ).rejects.toBeInstanceOf(ExclusionSubjectNotFoundError);
  });

  it('removes a pending reservation with no anchor, and keeps an account that exists', async () => {
    const joiner = await seedPerson('Seth', 'Sander');
    const first = await preview();
    expect((await actionsOf(first.id)).map((a) => a.actionType)).toContain('create_account');
    const pending = await withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({ where: { personId: joiner } }));
    expect(pending.status).toBe('pending');

    const added = await leaveOut(joiner);
    expect(added.personId).toBe(joiner);
    expect(await withTenant(tenantId, (tx) => tx.targetAccount.count({ where: { personId: joiner } }))).toBe(0);
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'provision.target.exclusion.add' } }),
    );
    expect(event.payload).toMatchObject({ pendingAccountRemoved: true });

    const { personId, accountId } = await seedManaged('Bea', 'Olsen');
    await leaveOut(personId);
    const kept = await withTenant(tenantId, (tx) => tx.targetAccount.findUniqueOrThrow({ where: { id: accountId } }));
    expect(kept.status).toBe('active');
  });

  it('says who left them out without a name when the administrator is unknown', () => {
    expect(leftOutMessage({ createdByName: null, createdAt: day('2026-10-03'), reason: 'Protected' })).toBe(
      'Left out of this target on 3 Oct 2026: Protected.',
    );
  });
});

describe('a run with somebody left out', () => {
  it('creates no account and reserves no name for a joiner left out', async () => {
    const left = await seedPerson('Anna', 'Novak');
    await leaveOut(left);
    // Same name, added after: gets the plain login, because nothing was
    // generated for the person left out.
    const other = await seedPerson('Anna', 'Novak');

    const run = await preview();
    const actions = await actionsOf(run.id);
    expect(actions.some((a) => a.personId === left)).toBe(false);
    const accounts = await withTenant(tenantId, (tx) => tx.targetAccount.findMany());
    expect(accounts.map((a) => [a.personId, a.correlationKey])).toEqual([[other, 'anna.novak']]);
    expect(await withTenant(tenantId, (tx) => tx.provisionException.count())).toBe(0);
  });

  it('leaves the account of a leaver left out exactly as it is', async () => {
    await updateLadder({ archiveAfterDays: 30, deleteAfterDays: 60 });
    const leaver = await seedManaged('Anna', 'Novak', day('2026-01-01'));
    await markApplied();
    await leaveOut(leaver.personId);

    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);
    const account = await withTenant(tenantId, (tx) => tx.targetAccount.findUniqueOrThrow({ where: { id: leaver.accountId } }));
    expect(account.status).toBe('active');
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings).toEqual([]);
  });

  it('proposes nothing for an employee left out whose rules changed', async () => {
    const kept = await seedManaged('Anna', 'Novak');
    await markApplied();
    await leaveOut(kept.personId);
    // The rule stops matching: without the exclusion this is a disable and a revoke.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId: kept.personId }, data: { department: 'Sales' } }),
    );
    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);
  });

  it('removes a reservation a run made while the person was being left out', async () => {
    const joiner = await seedPerson('Seth', 'Sander');
    await preview();
    // Written directly, the way a run's reservation lands after the exclusion
    // committed: the service's own cleanup has already run.
    await withTenant(tenantId, (tx) =>
      tx.targetPersonExclusion.create({ data: { tenantId, targetSystemId: targetId, personId: joiner, reason: 'x' } }),
    );
    expect(await withTenant(tenantId, (tx) => tx.targetAccount.count({ where: { personId: joiner } }))).toBe(1);
    await preview();
    expect(await withTenant(tenantId, (tx) => tx.targetAccount.count({ where: { personId: joiner } }))).toBe(0);
  });

  it('hands the person back to the rules once included again', async () => {
    const joiner = await seedPerson('Seth', 'Sander');
    await leaveOut(joiner);
    const before = await preview();
    expect((await actionsOf(before.id)).some((a) => a.personId === joiner)).toBe(false);

    await includeAgain(joiner);
    const after = await preview();
    expect(
      (await actionsOf(after.id)).filter((a) => a.personId === joiner).map((a) => a.actionType),
    ).toEqual(['create_account', 'grant_entitlement']);
  });

  it('still ends the Syntra login of a leaver left out of the paired target', async () => {
    const leaver = await seedManaged('Anna', 'Novak', day('2026-06-01'));
    await markApplied();
    const userId = await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId, name: 'Acme AD read', config: {}, secretName: 'source/bind' },
      });
      await tx.targetSystem.update({ where: { id: targetId }, data: { pairedDirectorySourceId: source.id } });
      return (
        await tx.user.create({
          data: {
            tenantId,
            login: 'anna.novak',
            email: 'anna.novak@acme.test',
            displayName: 'anna.novak',
            sourceId: source.id,
            sourceAnchor: 'anchor-anna',
            personId: leaver.personId,
          },
        })
      ).id;
    });
    await leaveOut(leaver.personId);

    const run = await preview();
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual(['deactivate_syntra_user']);
    expect((actions[0]!.after as { userId: string }).userId).toBe(userId);
  });
});

describe('the guard with somebody left out', () => {
  it('measures a disable against every account at the target, left out or not', async () => {
    const leaver = await seedManaged('Anna', 'Novak', day('2026-06-01'));
    const kept = await seedManaged('Bea', 'Olsen');
    await seedManaged('Cato', 'Praz');
    await markApplied();
    await leaveOut(kept.personId);

    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toContain('would disable 1 of 3 active accounts');
    expect((await actionsOf(run.id)).filter((a) => a.actionType === 'disable_account').map((a) => a.personId)).toEqual([
      leaver.personId,
    ]);
  });

  it('reads no exclusion as a fall in the population, and holds no run for one', async () => {
    const people = [await seedManaged('Anna', 'Novak'), await seedManaged('Bea', 'Olsen'), await seedManaged('Cato', 'Praz')];
    await markApplied();
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applied', personsWithActiveContract: 3, startedAt: day('2026-06-14') },
      }),
    );
    await leaveOut(people[0]!.personId);
    await leaveOut(people[1]!.personId);

    const run = await preview();
    expect(run.status).not.toBe('blocked');
    const stored = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }));
    expect(stored.personsWithActiveContract).toBe(3);
    expect(stored.disableAccountCount).toBe(0);
  });
});

describe('applying a plan computed before somebody was left out', () => {
  it('attempts nothing for them and still finishes the run', async () => {
    const joiner = await seedPerson('Seth', 'Sander');
    const other = await seedPerson('Bea', 'Olsen');
    const run = await preview();
    await leaveOut(joiner);
    target.calls.length = 0;

    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: adminId,
      connector: target as never,
      now: NOW,
      sleep: noSleep,
    });
    expect(result.status).toBe('applied');
    const actions = await actionsOf(run.id);
    const theirs = actions.filter((a) => a.personId === joiner);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((a) => a.status === 'superseded')).toBe(true);
    expect(theirs[0]!.message).toBe('Not attempted: Seth Sander is left out of this target.');
    expect(actions.filter((a) => a.personId === other).every((a) => a.status === 'applied')).toBe(true);
    expect(target.calls.some((c) => 'correlationKey' in c && c.correlationKey === 'seth.sander')).toBe(false);
  });
});

describe('the manual paths', () => {
  it('refuses to pin the account of somebody left out', async () => {
    const { personId } = await seedManaged('Anna', 'Novak');
    await leaveOut(personId);
    await expect(
      withTenant(tenantId, (tx) =>
        setPlacement(tx, {
          personId,
          targetSystemId: targetId,
          container: USERS,
          reason: 'move',
          movedByUserId: adminId,
          existingContainers: [USERS],
        }),
      ),
    ).rejects.toBeInstanceOf(PersonLeftOutError);
  });
});

describe('explaining access', () => {
  it('names the exclusion on Access explained and in the projection', async () => {
    const { personId } = await seedManaged('Anna', 'Novak');
    await leaveOut(personId, 'Protected by the application');

    const access = await explainPersonAccess(tenantId, personId);
    expect(access.exclusions).toHaveLength(1);
    expect(access.exclusions[0]!.targetName).toBe('Acme AD');
    expect(access.exclusions[0]!.message).toMatch(/^Left out of this target by Jane Doe on .+: Protected by the application\.$/);

    const [projection] = await projectPersonOnTargets(tenantId, personId, { now: NOW, contractOverride: { sequence: 1, endDate: day('2026-06-01') } });
    expect(projection!.leftOut).toMatch(/^Left out of this target/);
    expect(projection!.desired).toBeNull();
    const delta = accessDeltaFor(projection!);
    expect(delta).toMatchObject({ account: 'none', add: [], remove: [] });
    expect(delta.leftOut).toBe(projection!.leftOut);
  });
});

describe('previewing a rule edit', () => {
  it('counts nobody left out of the target', async () => {
    const anna = await seedManaged('Anna', 'Novak');
    await seedManaged('Bea', 'Olsen');
    await leaveOut(anna.personId);
    const ruleId = await withTenant(tenantId, async (tx) => (await tx.businessRule.findFirstOrThrow()).id);
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.updateMany({ data: { grantedByRuleId: ruleId } }),
    );

    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: false,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.totalPersons).toBe(1);
    expect(impact.wouldRevoke).toBe(1);
  });
});

async function updateLadder(ladder: { archiveAfterDays?: number | null; deleteAfterDays?: number | null }) {
  await withTenant(tenantId, (tx) => tx.targetSystem.update({ where: { id: targetId }, data: ladder }));
}
