import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { setPassword } from './password.js';
import { authenticate } from './login-service.js';

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    userId = user.id;
    await setPassword(tx, user.id, PASSWORD);
  });
});

describe('authenticate', () => {
  it('accepts the correct password', async () => {
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe',
        password: PASSWORD,
        sourceIp: '10.0.0.1',
      }),
    );
    expect(result).toEqual({ ok: true, userId, mayElevate: false });
  });

  it('rejects the wrong password', async () => {
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: 'wrong', sourceIp: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports an unknown login identically to a wrong password', async () => {
    const unknown = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'nobody', password: 'wrong', sourceIp: null }),
    );
    expect(unknown).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('refuses an inactive user even with the right password', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: PASSWORD, sourceIp: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'user_inactive' });
  });

  it('refuses a user who has no password credential at all', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'svc',
        email: 'svc@acme.test',
        displayName: 'Service',
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'svc', password: '', sourceIp: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('does not authenticate a user belonging to another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    const result = await withTenant(other.id, (tx) =>
      authenticate(tx, { login: 'jdoe', password: PASSWORD, sourceIp: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports that an administrator may elevate', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: PASSWORD, sourceIp: null }),
    );
    expect(result).toEqual({ ok: true, userId, mayElevate: true });
  });

  it('writes an audit event for success and for failure', async () => {
    await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe',
        password: PASSWORD,
        sourceIp: '10.0.0.1',
      }),
    );
    await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe',
        password: 'wrong',
        sourceIp: '10.0.0.1',
      }),
    );

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['auth.login', 'success'],
      ['auth.login', 'failure'],
    ]);
  });

  it('records an audit event even for an unknown login', async () => {
    await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'nobody', password: 'wrong', sourceIp: null }),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBeNull();
  });

  it('records no password material in the audit payload', async () => {
    await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: 'hunter2', sourceIp: null }),
    );
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst(),
    );
    expect(JSON.stringify(event!.payload)).not.toContain('hunter2');
  });

  it('takes comparable time for an unknown login and a wrong password', async () => {
    // A user-enumeration guard: if a missing user short-circuits, its response
    // is measurably faster and the login name is disclosed by timing alone.
    const measure = async (login: string) => {
      const started = process.hrtime.bigint();
      await withTenant(tenantId, (tx) =>
        authenticate(tx, { login, password: 'wrong', sourceIp: null }),
      );
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await measure('jdoe');

    const wrongPassword = await measure('jdoe');
    const unknownUser = await measure('nobody');

    const ratio = unknownUser / wrongPassword;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3);
  });
});
