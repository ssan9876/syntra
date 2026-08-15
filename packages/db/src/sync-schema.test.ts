import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;

const source = (name = 'Head office AD') => ({
  name,
  type: 'ldap',
  config: { host: 'ldap.acme.test', port: 636 },
  secretName: 'ldap.bindPassword',
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('directory sync schema', () => {
  it('stores a source without its password', async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({ data: { tenantId, ...source() } }),
    );
    expect(created.deactivationThresholdPercent).toBe(10);
    expect(created.autoApply).toBe(false);
    // The credential lives in the vault; only its name is on the row.
    expect(JSON.stringify(created)).not.toContain('password":');
  });

  it('isolates sources between tenants', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) =>
      tx.directorySource.create({ data: { tenantId, ...source() } }),
    );

    const seen = await withTenant(other.id, (tx) =>
      tx.directorySource.findMany(),
    );
    expect(seen).toEqual([]);
  });

  it('refuses two users with the same anchor from one source', async () => {
    const srcId = await withTenant(tenantId, async (tx) => {
      const s = await tx.directorySource.create({
        data: { tenantId, ...source() },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'a',
          email: 'a@acme.test',
          displayName: 'A',
          sourceId: s.id,
          sourceAnchor: 'anchor-1',
        },
      });
      return s.id;
    });

    await expect(
      withTenant(tenantId, (tx) =>
        tx.user.create({
          data: {
            tenantId,
            login: 'b',
            email: 'b@acme.test',
            displayName: 'B',
            sourceId: srcId,
            sourceAnchor: 'anchor-1',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows many locally managed users, which all have a null source', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.user.create({
        data: { tenantId, login: 'a', email: 'a@acme.test', displayName: 'A' },
      });
      await tx.user.create({
        data: { tenantId, login: 'b', email: 'b@acme.test', displayName: 'B' },
      });
    });

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toHaveLength(2);
    expect(users.every((u) => u.sourceId === null)).toBe(true);
  });

  it('gives a group a status, so it can be deactivated like a user', async () => {
    const group = await withTenant(tenantId, (tx) =>
      tx.group.create({ data: { tenantId, name: 'Nurses' } }),
    );
    expect(group.status).toBe('active');

    const off = await withTenant(tenantId, (tx) =>
      tx.group.update({
        where: { id: group.id },
        data: { status: 'inactive', statusReason: 'Absent from source' },
      }),
    );
    expect(off.statusReason).toBe('Absent from source');
  });

  it('refuses to remove a source while directory rows still point at it', async () => {
    // Without this foreign key a deleted source left its users carrying a
    // sourceId that resolved to nothing: never synced again, and invisible as
    // a problem. The database now refuses, so releasing those rows is a
    // deliberate step rather than something a DELETE does behind your back.
    const srcId = await withTenant(tenantId, async (tx) => {
      const s = await tx.directorySource.create({
        data: { tenantId, ...source() },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'a',
          email: 'a@acme.test',
          displayName: 'A',
          sourceId: s.id,
          sourceAnchor: 'anchor-1',
        },
      });
      return s.id;
    });

    await expect(
      withTenant(tenantId, (tx) =>
        tx.directorySource.delete({ where: { id: srcId } }),
      ),
    ).rejects.toThrow();

    expect(await withTenant(tenantId, (tx) => tx.directorySource.count())).toBe(1);
  });

  it('cascades runs and changes when a source is removed', async () => {
    await withTenant(tenantId, async (tx) => {
      const s = await tx.directorySource.create({
        data: { tenantId, ...source() },
      });
      const run = await tx.syncRun.create({
        data: { tenantId, sourceId: s.id },
      });
      await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'create_user',
          targetType: 'User',
        },
      });
      await tx.directorySource.delete({ where: { id: s.id } });
    });

    expect(await withTenant(tenantId, (tx) => tx.syncRun.count())).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.syncChange.count())).toBe(0);
  });
});
