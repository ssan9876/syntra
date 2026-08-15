import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { hashPassword, setPasswordHash } from './password.js';
import { authenticate } from './login-service.js';

/**
 * How many transactions were open at the moment Argon2 was asked to verify.
 *
 * The Global Constraint says password verification happens between
 * transactions and never inside one, and there is no way to see that from the
 * outside: a hash inside a transaction is simply a slower login until the day
 * a loaded box crosses Prisma's 5000 ms budget and every sign-in starts
 * failing. So the wrapper below records the depth, and the test asserts it.
 */
const probe = vi.hoisted(() => ({ depths: [] as number[] }));

vi.mock('./password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.js')>();
  return {
    ...actual,
    verifyPassword: async (hash: string, plain: string) => {
      probe.depths.push(openTransactions);
      return actual.verifyPassword(hash, plain);
    },
  };
});

/**
 * Counts open transactions by wrapping `prisma.$transaction`, which is what
 * `withTenant` calls. Installed once for the file and never restored: it
 * delegates to the real implementation, so nothing else here can tell.
 */
let openTransactions = 0;
const realTransaction = prisma.$transaction.bind(prisma);
prisma.$transaction = (async (...args: Parameters<typeof realTransaction>) => {
  openTransactions += 1;
  try {
    return await realTransaction(...args);
  } finally {
    openTransactions -= 1;
  }
}) as typeof prisma.$transaction;

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';

/**
 * Hashed once for the whole file, outside every transaction.
 *
 * There is no helper that takes a plaintext and a transaction any more:
 * Argon2id is deliberately expensive and has no business inside Prisma's
 * 5000 ms budget, so `setPasswordHash` takes a hash and the hashing is the
 * caller's to place. Hashing once per file rather than once per test is the
 * same decision made cheaply.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);


beforeEach(async () => {
  probe.depths.length = 0;
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
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
  });
});

describe('authenticate', () => {
  it('verifies the password outside every transaction', async () => {
    // The counter has to be able to see a transaction, or the assertion below
    // would hold however this function were written.
    expect(await withTenant(tenantId, async () => openTransactions)).toBe(1);

    await authenticate(tenantId, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: null,
    });
    expect(probe.depths).toEqual([0]);
  });

  it('runs the dummy verification for an unknown login outside one too', async () => {
    // The costliest of the three paths to get wrong: an unknown login pays the
    // full Argon2 price by design, so holding a transaction across it hands an
    // attacker a way to exhaust the connection pool with names that do not
    // exist.
    await authenticate(tenantId, {
      login: 'nobody',
      password: 'wrong',
      sourceIp: null,
    });
    expect(probe.depths).toEqual([0]);
  });

  it('accepts the correct password', async () => {
    const result = await authenticate(tenantId, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: '10.0.0.1',
    });
    expect(result).toEqual({ ok: true, userId, mayElevate: false });
  });

  it('rejects the wrong password', async () => {
    const result = await authenticate(tenantId, {
      login: 'jdoe',
      password: 'wrong',
      sourceIp: null,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports an unknown login identically to a wrong password', async () => {
    const unknown = await authenticate(tenantId, {
      login: 'nobody',
      password: 'wrong',
      sourceIp: null,
    });
    expect(unknown).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('refuses an inactive user even with the right password', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    const result = await authenticate(tenantId, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: null,
    });
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
    const result = await authenticate(tenantId, {
      login: 'svc',
      password: '',
      sourceIp: null,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('does not authenticate a user belonging to another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    const result = await authenticate(other.id, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: null,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports that an administrator may elevate', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const result = await authenticate(tenantId, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: null,
    });
    expect(result).toEqual({ ok: true, userId, mayElevate: true });
  });

  it('writes an audit event for success and for failure', async () => {
    await authenticate(tenantId, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: '10.0.0.1',
    });
    await authenticate(tenantId, {
      login: 'jdoe',
      password: 'wrong',
      sourceIp: '10.0.0.1',
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['auth.login', 'success'],
      ['auth.login', 'failure'],
    ]);
  });

  it('records an audit event even for an unknown login', async () => {
    await authenticate(tenantId, {
      login: 'nobody',
      password: 'wrong',
      sourceIp: null,
    });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBeNull();
  });

  it('records no password material in the audit payload', async () => {
    await authenticate(tenantId, {
      login: 'jdoe',
      password: 'hunter2',
      sourceIp: null,
    });
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
      await authenticate(tenantId, { login, password: 'wrong', sourceIp: null });
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
