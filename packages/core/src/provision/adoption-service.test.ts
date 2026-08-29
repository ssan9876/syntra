import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget } from './target-service.js';
import { adoptAccount } from './adoption-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

let tenantId: string;
let targetId: string;
let personId: string;
let adminUserId: string;
let target: FakeTarget;

/** A person with a conflicted account: the target refused the create. */
const seedConflicted = async (
  givenName: string,
  familyName: string,
  correlationKey: string,
) =>
  withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName, familyName },
    });
    await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId: person.id,
        correlationKey,
        status: 'conflict',
        statusReason: 'AlreadyExistsError: 00000524 … ENTRY_EXISTS',
      },
    });
    return person.id;
  });

const accountOf = (id: string) =>
  withTenant(tenantId, (tx) =>
    tx.targetAccount.findFirstOrThrow({ where: { personId: id } }),
  );

const adoptedEvents = () =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({ where: { action: 'provision.account.adopted' } }),
  );

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;

  const created = await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
  });
  targetId = created.id;

  target = new FakeTarget();
  target.containers.push(config.baseDn);

  personId = await seedConflicted('Anna', 'Novak', 'anna.novak');
  adminUserId = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'reviewer',
        email: 'reviewer@acme.test',
        displayName: 'Reviewer',
      },
    });
    return user.id;
  });
});

describe('adoptAccount', () => {
  it('binds the conflicted row to the object that caused the collision', async () => {
    const anchor = target.seedForeignObject('anna.novak');

    const result = await adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'this is her existing account',
      actorUserId: adminUserId,
      sourceIp: null,
      connector: target as never,
    });

    expect(result).toEqual({
      adopted: true,
      anchor,
      dn: `CN=anna.novak,${config.baseDn}`,
    });
    const after = await accountOf(personId);
    expect(after.anchor).toBe(anchor);
    expect(after.status).toBe('active');
    expect(after.statusReason).toBeNull();
  });

  it('matches the correlation key case-insensitively', async () => {
    // sAMAccountName is case-insensitive in Active Directory. A case-sensitive
    // compare refuses to adopt an account that is plainly there, and tells the
    // administrator to move an object that has not moved.
    const anchor = target.seedForeignObject('Anna.Novak');

    const result = await adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'same account, different casing',
      actorUserId: adminUserId,
      sourceIp: null,
      connector: target as never,
    });

    expect(result.adopted).toBe(true);
    expect(result.anchor).toBe(anchor);
  });

  it('writes nothing to the directory', async () => {
    // The property the whole design rests on. Adoption records a decision; the
    // next run converges the object through the guard. A later change that
    // "helpfully" stamped provenance here would overwrite an `info` field
    // Syntra does not own, in a request that can then half-fail.
    target.seedForeignObject('anna.novak');
    let wrote = 0;
    const original = target.write.bind(target);
    target.write = async (cfg, op) => {
      wrote += 1;
      return original(cfg, op);
    };

    await adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'hers',
      actorUserId: adminUserId,
      sourceIp: null,
      connector: target as never,
    });

    expect(wrote).toBe(0);
  });

  it('records who adopted it and why', async () => {
    // The audit event is what stands where the provenance check used to. An
    // adoption nobody can attribute is the thing the refusal was protecting
    // against, arrived at by a different route.
    const anchor = target.seedForeignObject('anna.novak');

    await adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'confirmed with her manager',
      actorUserId: adminUserId,
      sourceIp: '203.0.113.7',
      connector: target as never,
    });

    const events = await adoptedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(adminUserId);
    expect(events[0]!.sourceIp).toBe('203.0.113.7');
    expect(events[0]!.payload).toMatchObject({
      adopted: true,
      anchor,
      correlationKey: 'anna.novak',
      reason: 'confirmed with her manager',
    });
  });
});
