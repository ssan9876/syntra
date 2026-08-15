import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { ldapConnector } from '@syntra/connectors';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createUser } from '../directory/user-service.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';
import { applyChange } from './apply.js';

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

afterEach(() => {
  vi.restoreAllMocks();
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

  it('completes when the directory read takes longer than a transaction may', async () => {
    // Prisma's default interactive-transaction timeout is 5 seconds. A read
    // that takes longer than that must still produce a previewed run, which
    // it can only do if the read happens outside a transaction. This fails
    // with P2028 the moment anyone puts the read back inside `withTenant`.
    const real = ldapConnector.read.bind(ldapConnector);
    vi.spyOn(ldapConnector, 'read').mockImplementation(async function* (config) {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      yield* real(config);
    });

    const run = await previewRun(tenantId, provider, sourceId);

    expect(run.error).toBeNull();
    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBeGreaterThan(0);
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

describe('applyChange membership failure paths', () => {
  it('marks add_member failed and audits outcome failure when the group or member cannot be resolved', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const run = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'add_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: 'group-anchor-x',
          after: { groupAnchor: 'no-such-group', memberAnchor: 'no-such-member' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, run.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.add_member' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/not found/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  it('marks remove_member failed and audits outcome failure when the group or member cannot be resolved', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const run = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'remove_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: 'group-anchor-y',
          before: { groupAnchor: 'no-such-group', memberAnchor: 'no-such-member' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, run.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.remove_member' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/not found/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  it('applies remove_member and audits outcome success when the group and member resolve but the membership was already absent', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const { updated, events, membershipsBefore, membershipsAfter } = await withTenant(
      tenantId,
      async (tx) => {
        const group = await tx.group.findFirstOrThrow({ where: { sourceId } });
        // sroe is deliberately not a member of Nurses (only jdoe is): this
        // exercises the "resolved, but nothing to remove" idempotent path,
        // not an accidental removal of a real membership.
        const user = await tx.user.findFirstOrThrow({ where: { sourceId, login: 'sroe' } });

        const membershipsBefore = await tx.groupMembership.count({
          where: { groupId: group.id, userId: user.id },
        });

        const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
        const change = await tx.syncChange.create({
          data: {
            tenantId,
            runId: newRun.id,
            changeType: 'remove_member',
            targetType: 'GroupMembership',
            targetId: null,
            sourceAnchor: group.sourceAnchor,
            before: { groupAnchor: group.sourceAnchor, memberAnchor: user.sourceAnchor },
            status: 'proposed',
          },
        });

        await applyChange(tx, change, sourceId, newRun.id);

        const membershipsAfter = await tx.groupMembership.count({
          where: { groupId: group.id, userId: user.id },
        });

        return {
          updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
          events: await tx.auditEvent.findMany({
            where: { action: 'sync.remove_member' },
          }),
          membershipsBefore,
          membershipsAfter,
        };
      },
    );

    // Discriminates "removed a real row" from "was already absent": both
    // counts are zero throughout, so this run genuinely had nothing to do.
    expect(membershipsBefore).toBe(0);
    expect(membershipsAfter).toBe(0);
    expect(updated!.status).toBe('applied');
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
  });

  it('audits outcome failure for an unrecognized change type', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: newRun.id,
          changeType: 'rename_planet',
          targetType: 'User',
          targetId: null,
          sourceAnchor: null,
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, newRun.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.rename_planet' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/unknown change type/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });
});
