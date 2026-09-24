import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { createUser } from '../directory/user-service.js';
import { applyImportRun } from '../person-source/run-service.js';
import { previewProvisionRun } from '../provision/run-service.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from '../provision/target-service.js';
import { applyRun } from '../sync/run-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';

/**
 * A processing restriction is honoured by every automated writer -- HR
 * imports, directory sync and provisioning -- visibly, naming the case, and
 * never keeps access alive: what narrows access still runs.
 */

const provider = localMasterKeyProvider(Buffer.alloc(32, 9));
const CASE_ID = randomUUID();
let tenantId: string;

async function restrictedPerson(options: { endDate?: Date | null; restricted?: boolean } = {}) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: {
        tenantId, givenName: 'Rita', familyName: 'Stricta', externalId: `E-${randomUUID().slice(0, 6)}`,
        ...(options.restricted === false ? {} : { processingRestrictedAt: new Date(), processingRestrictedCaseId: CASE_ID }),
      },
    });
    await tx.contract.create({
      data: {
        tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01T00:00:00Z'),
        endDate: options.endDate ?? null, department: 'Finance',
      },
    });
    return person;
  });
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
});

describe('HR import under a restriction', () => {
  it('skips updates to a restricted person, naming the case, and still applies a departure', async () => {
    const person = await restrictedPerson();
    const other = await restrictedPerson({ restricted: false });
    const runId = await withTenant(tenantId, async (tx) => {
      const source = await tx.personSource.create({
        data: { tenantId, name: 'HR', type: 'csv', config: {}, secretName: `hr.${randomUUID()}`, feedMode: 'snapshot' },
      });
      const run = await tx.personImportRun.create({ data: { tenantId, sourceId: source.id, status: 'previewed' } });
      await tx.personImportChange.createMany({
        data: [
          { tenantId, runId: run.id, changeType: 'update_person', recordType: 'person', targetId: person.id, after: { givenName: 'Renamed' } },
          { tenantId, runId: run.id, changeType: 'update_person', recordType: 'person', targetId: other.id, after: { givenName: 'Renamed' } },
          { tenantId, runId: run.id, changeType: 'depart_person', recordType: 'person', targetId: person.id, after: {} },
        ],
      });
      return run.id;
    });

    await applyImportRun(tenantId, runId);

    await withTenant(tenantId, async (tx) => {
      const changes = await tx.personImportChange.findMany({ where: { runId } });
      const restrictedUpdate = changes.find((c) => c.targetId === person.id && c.changeType === 'update_person')!;
      expect(restrictedUpdate.status).toBe('skipped');
      expect(restrictedUpdate.message).toContain(CASE_ID);
      expect(changes.find((c) => c.targetId === other.id)!.status).toBe('applied');
      expect(changes.find((c) => c.changeType === 'depart_person')!.status).toBe('applied');
      const after = await tx.person.findUniqueOrThrow({ where: { id: person.id } });
      expect(after.givenName).toBe('Rita');
      expect(after.status).toBe('inactive');
      expect(await tx.auditEvent.count({ where: { action: 'person_import.change_withheld', targetId: person.id } })).toBe(1);
    });
  });
});

describe('directory sync under a restriction', () => {
  it('skips updates to a restricted person\'s account and still deactivates it', async () => {
    const person = await restrictedPerson();
    const { runId, userId } = await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({ data: { tenantId, name: 'LDAP', config: {}, secretName: `dir.${randomUUID()}` } });
      const user = await createUser(tx, { login: 'rstricta', email: 'rita@acme.test', displayName: 'Rita Stricta' });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id, sourceId: source.id, sourceAnchor: 'uid=rita' } });
      const run = await tx.syncRun.create({ data: { tenantId, sourceId: source.id, status: 'previewed' } });
      await tx.syncChange.createMany({
        data: [
          { tenantId, runId: run.id, changeType: 'update_user', targetType: 'User', targetId: user.id, sourceAnchor: 'uid=rita', after: { displayName: 'Rita S.' } },
          { tenantId, runId: run.id, changeType: 'deactivate_user', targetType: 'User', targetId: user.id, sourceAnchor: 'uid=rita', after: {} },
        ],
      });
      return { runId: run.id, userId: user.id };
    });

    await applyRun(tenantId, runId);

    await withTenant(tenantId, async (tx) => {
      const changes = await tx.syncChange.findMany({ where: { runId } });
      const update = changes.find((c) => c.changeType === 'update_user')!;
      expect(update.status).toBe('skipped');
      expect(update.message).toContain(CASE_ID);
      expect(changes.find((c) => c.changeType === 'deactivate_user')!.status).toBe('applied');
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.displayName).toBe('Rita Stricta');
      expect(user.status).toBe('inactive');
    });
  });
});

describe('provisioning under a restriction', () => {
  const USERS = 'OU=Users,DC=acme,DC=test';
  let targetId: string;
  let target: FakeTarget;

  beforeEach(async () => {
    targetId = (await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config: {
        url: 'ldaps://dc.acme.test:636', tlsMode: 'ldaps', rejectUnauthorized: false, bindDn: 'CN=svc,DC=acme,DC=test',
        baseDn: USERS, entitlementSearchBase: 'OU=Groups,DC=acme,DC=test', archiveContainer: 'OU=Archive,DC=acme,DC=test',
      },
      bindPassword: 'secret',
    })).id;
    target = new FakeTarget();
    target.containers.push(USERS);
    await upsertAccountProfile(tenantId, null, targetId, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
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
      entitlementIds: [],
    });
  });

  it('withholds the account a restricted joiner would get, visibly on the plan', async () => {
    const person = await restrictedPerson();
    const free = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'Frank', familyName: 'Free' } });
      await tx.contract.create({
        data: { tenantId, personId: p.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01T00:00:00Z'), department: 'Finance' },
      });
      return p;
    });

    const run = await previewProvisionRun(tenantId, provider, targetId, { now: new Date('2026-06-15T00:00:00Z'), connector: target as never });
    const actions = await withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId: run.id } }));
    const restricted = actions.filter((a) => a.personId === person.id);
    expect(restricted.length).toBeGreaterThan(0);
    for (const action of restricted) {
      expect(action.status).toBe('refused');
      expect(action.message).toContain(CASE_ID);
    }
    const freeCreate = actions.find((a) => a.personId === free.id && a.actionType === 'create_account');
    expect(freeCreate?.status).toBe('proposed');
    const stored = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }));
    expect(stored.createAccountCount).toBe(1);
  });

  it('never withholds what narrows access: a restricted leaver is still disabled', async () => {
    const person = await restrictedPerson({ endDate: new Date('2026-01-31T00:00:00Z') });
    const created = await target.write({ domain: 'acme.test' } as never, {
      op: 'create_account',
      actionId: 'seed',
      correlationKey: 'r.stricta',
      attributes: { distinguishedName: [`CN=r.stricta,${USERS}`] },
      enabled: true,
      initialPassword: 'Aa1!seed-password',
    });
    await withTenant(tenantId, (tx) => tx.targetAccount.create({
      data: {
        tenantId, targetSystemId: targetId, personId: person.id, anchor: created.anchor!, correlationKey: 'r.stricta',
        status: 'active', lastAppliedAttributes: { displayName: ['Rita Stricta'] },
      },
    }));

    const run = await previewProvisionRun(tenantId, provider, targetId, { now: new Date('2026-06-15T00:00:00Z'), connector: target as never });
    const actions = await withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId: run.id, personId: person.id } }));
    const narrowing = actions.filter((a) => ['disable_account', 'archive_account', 'revoke_entitlement'].includes(a.actionType));
    expect(narrowing.length).toBeGreaterThan(0);
    for (const action of narrowing) expect(action.status).not.toBe('refused');
  });
});
