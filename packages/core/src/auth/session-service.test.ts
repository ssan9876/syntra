import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  createSession,
  resolveSession,
  revokeAllForUser,
  revokeSession,
  type SessionAllowance,
  type SessionScope,
} from './session-service.js';

let tenantId: string;
let userId: string;

/**
 * The decision a session is minted from. Assembled by hand here because there
 * is no authorize() in this suite — which is the point of the type: outside a
 * test, the only way to hold one of these is to have been past the chokepoint.
 */
const allowed = (
  scope: SessionScope,
  satisfiedFactor: SessionAllowance['satisfiedFactor'] = null,
): SessionAllowance => ({
  status: 'allow',
  userId,
  mayElevate: false,
  applicationId: null,
  scope,
  satisfiedFactor,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
  );
  userId = user.id;
});

describe('sessions', () => {
  it('resolves a freshly issued token', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const resolved = await withTenant(tenantId, (tx) =>
      resolveSession(tx, token),
    );
    expect(resolved).toMatchObject({ userId, scope: 'portal' });
  });

  it('stores only a hash of the token', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const rows = await withTenant(tenantId, (tx) => tx.session.findMany());
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it('issues a different token each time', async () => {
    const a = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const b = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    expect(a.token).not.toBe(b.token);
  });

  it('gives an admin session a shorter absolute lifetime than a portal session', async () => {
    const portal = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const admin = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('admin'), { ip: null, userAgent: null }),
    );
    expect(admin.expiresAt.getTime()).toBeLessThan(portal.expiresAt.getTime());
  });

  it('returns null for a revoked token', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    await withTenant(tenantId, (tx) => revokeSession(tx, token));
    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, token)),
    ).toBeNull();
  });

  it('returns null for a garbage token', async () => {
    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, 'not-a-token')),
    ).toBeNull();
  });

  it('returns null once the absolute expiry has passed', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    await withTenant(tenantId, (tx) =>
      tx.session.updateMany({
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      }),
    );
    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, token)),
    ).toBeNull();
  });

  it('returns null once the idle timeout has passed', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('admin'), { ip: null, userAgent: null }),
    );
    // Admin idle timeout is 15 minutes; place the last sighting an hour ago.
    await withTenant(tenantId, (tx) =>
      tx.session.updateMany({
        data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      }),
    );
    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, token)),
    ).toBeNull();
  });

  it('refreshes the idle clock on each use', async () => {
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const before = await withTenant(tenantId, (tx) => tx.session.findFirst());

    await new Promise((r) => setTimeout(r, 20));
    await withTenant(tenantId, (tx) => resolveSession(tx, token));

    const after = await withTenant(tenantId, (tx) => tx.session.findFirst());
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(
      before!.lastSeenAt.getTime(),
    );
  });

  it('revokes every session a user holds', async () => {
    const a = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    const b = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('admin'), { ip: null, userAgent: null }),
    );
    await withTenant(tenantId, (tx) => revokeAllForUser(tx, userId));

    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, a.token)),
    ).toBeNull();
    expect(
      await withTenant(tenantId, (tx) => resolveSession(tx, b.token)),
    ).toBeNull();
  });

  it('does not resolve a session issued in another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    expect(
      await withTenant(other.id, (tx) => resolveSession(tx, token)),
    ).toBeNull();
  });
});

describe('session origin', () => {
  it('records the address and user agent the session was established from', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/141.0',
      });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.ip).toBe('203.0.113.7');
      expect(row.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0) Firefox/141.0');
    });
  });

  it('truncates a user agent that is trying to be a payload', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), {
        ip: null,
        userAgent: 'x'.repeat(5000),
      });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.userAgent).toHaveLength(256);
    });
  });

  it('accepts a session with no origin at all', async () => {
    // Not every caller has a request behind it, and a null column is the
    // honest answer rather than a fabricated one.
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), { ip: null, userAgent: null });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.ip).toBeNull();
      expect(row.userAgent).toBeNull();
    });
  });
});
