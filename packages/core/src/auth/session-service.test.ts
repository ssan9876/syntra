import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  createSession,
  listSessionsForUser,
  resolveSession,
  revokeAllForUser,
  revokeSession,
  revokeSessionById,
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

describe('listSessionsForUser', () => {
  it('returns live sessions newest first, without the token hash', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), { ip: '198.51.100.1', userAgent: 'A' });
      await createSession(tx, allowed('admin'), { ip: '198.51.100.2', userAgent: 'B' });

      const sessions = await listSessionsForUser(tx, userId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        sessions[1]!.createdAt.getTime(),
      );
      expect(sessions[0]).not.toHaveProperty('tokenHash');
    });
  });

  it('omits a revoked session', async () => {
    await withTenant(tenantId, async (tx) => {
      const { token } = await createSession(tx, allowed('portal'), {
        ip: null,
        userAgent: null,
      });
      await revokeSession(tx, token);
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });

  it('omits a session past its absolute expiry, which revokedAt alone would miss', async () => {
    // The liveness rules are resolveSession's. A row with a null revokedAt and
    // an expiry in the past is dead, and a list that shows it invites somebody
    // to revoke a session that already ended and wonder why nothing changed.
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), { ip: null, userAgent: null });
      await tx.session.updateMany({
        where: { userId },
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      });
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });

  it('omits an idle session past its scope timeout', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('admin'), { ip: null, userAgent: null });
      // Admin idles out at fifteen minutes.
      await tx.session.updateMany({
        where: { userId },
        data: { lastSeenAt: new Date(Date.now() - 16 * 60 * 1000) },
      });
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });

  it('does not list a session belonging to another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other2', slug: 'other2' } });
    await withTenant(tenantId, (tx) =>
      createSession(tx, allowed('portal'), { ip: null, userAgent: null }),
    );
    // No `where` on tenant anywhere: row-level security is the thing being
    // asserted, not an application filter.
    expect(
      await withTenant(other.id, (tx) => listSessionsForUser(tx, userId)),
    ).toEqual([]);
  });
});

describe('revokeSessionById', () => {
  it('revokes one session and leaves the others', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), { ip: null, userAgent: null });
      await createSession(tx, allowed('portal'), { ip: null, userAgent: null });
      const [first] = await listSessionsForUser(tx, userId);

      expect(await revokeSessionById(tx, first!.id)).toBe(true);
      expect(await listSessionsForUser(tx, userId)).toHaveLength(1);
    });
  });

  it('answers false for a session that is not there', async () => {
    await withTenant(tenantId, async (tx) => {
      expect(
        await revokeSessionById(tx, '00000000-0000-0000-0000-000000000001'),
      ).toBe(false);
    });
  });

  it('answers false for a session already revoked', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed('portal'), { ip: null, userAgent: null });
      const [only] = await listSessionsForUser(tx, userId);
      expect(await revokeSessionById(tx, only!.id)).toBe(true);
      expect(await revokeSessionById(tx, only!.id)).toBe(false);
    });
  });
});
