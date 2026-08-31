import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  createUser,
  deactivateUser,
  findUserByLogin,
  listUsers,
} from './user-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createUser', () => {
  it('creates a user with an active status', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'jdoe@acme.test',
        displayName: 'J Doe',
      }),
    );
    expect(user.status).toBe('active');
    expect(user.personId).toBeNull();
  });

  it('rejects a duplicate login within the same tenant', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createUser(tx, { login: 'jdoe', email: 'b@acme.test', displayName: 'B' }),
      ),
    ).rejects.toThrow(/login already exists/i);
  });

  it('rejects a login that differs only in case', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createUser(tx, { login: 'JDoe', email: 'b@acme.test', displayName: 'B' }),
      ),
    ).rejects.toThrow(/login already exists/i);
  });

  it('rejects an email already used by a locally managed account', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'a', email: 'shared@acme.test', displayName: 'A' }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createUser(tx, { login: 'b', email: 'SHARED@acme.test', displayName: 'B' }),
      ),
    ).rejects.toThrow(/email already in use/i);
  });

  it('allows a source-owned account to share an email with a local one', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Corporate LDAP',
          type: 'ldap',
          config: {},
          secretName: 'corporate-ldap',
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'local', email: 'shared@acme.test', displayName: 'L' }),
    );
    // Written directly rather than through createUser: a synced account is
    // created by the sync apply path, which is exempt from this guard by
    // design — a directory owns the addresses on the accounts it syncs.
    const synced = await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'synced',
          email: 'shared@acme.test',
          displayName: 'S',
          sourceId: source.id,
          sourceAnchor: 'anchor-1',
        },
      }),
    );
    expect(synced.email).toBe('shared@acme.test');
  });

  it('lets a replacement take a leaver’s email address', async () => {
    const leaver = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'leaver', email: 'post@acme.test', displayName: 'L' }),
    );
    await withTenant(tenantId, (tx) =>
      deactivateUser(tx, leaver.id, 'left the company'),
    );

    // This directory deactivates rather than deletes, so without a status
    // clause on the guard a leaver would reserve their address for ever and
    // the person hired into their post could not be given the mailbox they
    // have already been handed.
    const replacement = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'post@acme.test', displayName: 'J' }),
    );

    expect(replacement.email).toBe('post@acme.test');
  });

  it('allows the same login in a different tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    const second = await withTenant(other.id, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'b@other.test', displayName: 'B' }),
    );
    expect(second.login).toBe('jdoe');
  });
});

describe('deactivateUser', () => {
  it('records the reason and never deletes the row', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
    );
    const after = await withTenant(tenantId, (tx) =>
      deactivateUser(tx, user.id, 'left the company'),
    );
    expect(after.status).toBe('inactive');
    expect(after.statusReason).toBe('left the company');

    const all = await withTenant(tenantId, (tx) => listUsers(tx));
    expect(all.rows).toHaveLength(1);
    // The row is still there, which is the point of deactivation over deletion.
    expect(all.total).toBe(1);
  });
});

describe('listUsers', () => {
  it('filters by status when asked', async () => {
    await withTenant(tenantId, async (tx) => {
      const a = await createUser(tx, {
        login: 'a',
        email: 'a@acme.test',
        displayName: 'A',
      });
      await createUser(tx, { login: 'b', email: 'b@acme.test', displayName: 'B' });
      await deactivateUser(tx, a.id, 'left');
    });

    const active = await withTenant(tenantId, (tx) =>
      listUsers(tx, { status: 'active' }),
    );
    expect(active.rows.map((u) => u.login)).toEqual(['b']);
  });
});

describe('findUserByLogin', () => {
  it('returns null for an unknown login', async () => {
    const found = await withTenant(tenantId, (tx) =>
      findUserByLogin(tx, 'nobody'),
    );
    expect(found).toBeNull();
  });

  it('does not find a user belonging to another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(other.id, (tx) =>
      createUser(tx, {
        login: 'elsewhere',
        email: 'e@other.test',
        displayName: 'E',
      }),
    );

    const found = await withTenant(tenantId, (tx) =>
      findUserByLogin(tx, 'elsewhere'),
    );
    expect(found).toBeNull();
  });
});
