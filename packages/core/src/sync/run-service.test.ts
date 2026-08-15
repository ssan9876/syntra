import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createUser } from '../directory/user-service.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 5));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('previewRun', () => {
  it('proposes creates on a first run and applies none of them', async () => {
    const run = await previewRun(tenantId, provider, sourceId);

    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBeGreaterThan(0);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes.filter((c) => c.changeType === 'create_user')).toHaveLength(2);
    expect(changes.every((c) => c.status === 'proposed')).toBe(true);

    // Nothing has been written to the directory yet.
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('proposes nothing on a second run over an unchanged directory', async () => {
    const first = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, first.id);

    const second = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes).toEqual([]);
  });

  it('reports a collision with a locally created account as a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );

    const run = await previewRun(tenantId, provider, sourceId);
    const conflicts = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id, status: 'conflict' } }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toMatch(/locally managed/i);
  });
});

describe('applyRun', () => {
  it('creates the users the preview proposed', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const applied = await applyRun(tenantId, run.id);

    expect(applied.status).toBe('applied');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.map((u) => u.login).sort()).toEqual(['jdoe', 'sroe']);
    expect(users.every((u) => u.sourceId === sourceId)).toBe(true);
    expect(users.every((u) => u.sourceAnchor !== null)).toBe(true);
  });

  it('brings group memberships across', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ include: { user: true, group: true } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.user.login).toBe('jdoe');
    expect(memberships[0]!.group.name).toBe('Nurses');
  });

  it('never applies a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const local = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'jdoe' } }),
    );
    // The hand-made account is untouched: still local, still its own email.
    expect(local!.sourceId).toBeNull();
    expect(local!.email).toBe('local@acme.test');
  });

  it('writes an audit event for every applied change', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'sync.' } } }),
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('applies only the changes it was asked to', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({
        where: { runId: run.id, changeType: 'create_user' },
      }),
    );

    const applied = await applyRun(tenantId, run.id, { only: [changes[0]!.id] });
    expect(applied.status).toBe('partially_applied');

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toHaveLength(1);
  });

  it('refuses to apply a blocked run', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: { status: 'blocked', blockedReason: 'test' },
      }),
    );

    await expect(applyRun(tenantId, run.id)).rejects.toThrow(/blocked/i);
  });
});
