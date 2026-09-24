import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { createApplication } from '../access/application-service.js';
import { upsertOidcClient } from '../access/oidc-client-service.js';
import { createSession, listSessionsForUser, type SessionAllowance } from './session-service.js';
import { endSessions, revokeTenantSessions } from './end-sessions.js';

let tenantId: string;
let userId: string;

const allowed = (scope: 'portal' | 'admin' = 'portal'): SessionAllowance => ({
  status: 'allow',
  userId,
  mayElevate: false,
  applicationId: null,
  scope,
  satisfiedFactor: null,
});

const NO_ORIGIN = { ip: null, userAgent: null };

/** A relying party that asked to be told, and a grant the user holds with it. */
async function seedRelyingParty(clientId = 'crm') {
  await withTenant(tenantId, async (tx) => {
    const application = await createApplication(tx, {
      name: `App ${clientId}`,
      slug: `app-${clientId}`,
    });
    await upsertOidcClient(tx, application.id, {
      clientId,
      redirectUris: ['https://rp.acme.test/cb'],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['openid'],
      requirePkce: true,
      clientCredentialsEnabled: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      idTokenSignedResponseAlg: 'RS256',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 1_209_600,
      backchannelLogoutUri: 'https://rp.acme.test/backchannel-logout',
    });
    await tx.oidcArtifact.create({
      data: {
        tenantId,
        model: 'Grant',
        artifactId: `grant-${clientId}`,
        accountId: userId,
        grantId: `grant-${clientId}`,
        payload: { clientId, accountId: userId },
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  });
}

const queuedLogouts = () =>
  withTenant(tenantId, (tx) => tx.logoutDelivery.count());

const liveSessions = () =>
  withTenant(tenantId, (tx) => listSessionsForUser(tx, userId));

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' }),
  );
  userId = user.id;
});

describe('endSessions', () => {
  it('ends the sessions, the refresh tokens and the relying parties at once', async () => {
    await seedRelyingParty();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed(), NO_ORIGIN);
      await createSession(tx, allowed('admin'), NO_ORIGIN);
    });

    const result = await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, { trigger: 'admin', actorUserId: userId }),
    );

    expect(result).toEqual({ sessionsRevoked: 2, logoutsEnqueued: 1 });
    expect(await liveSessions()).toEqual([]);
    // The artifacts a relying party's tokens live in, gone with the sessions.
    expect(await withTenant(tenantId, (tx) => tx.oidcArtifact.count())).toBe(0);
    expect(await queuedLogouts()).toBe(1);
  });

  it('spares the session a self-service change is being made from', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed(), NO_ORIGIN);
      await createSession(tx, allowed(), NO_ORIGIN);
    });
    const keep = (await liveSessions())[0]!.id;

    await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, {
        trigger: 'password_change',
        actorUserId: userId,
        exceptSessionId: keep,
      }),
    );

    expect((await liveSessions()).map((s) => s.id)).toEqual([keep]);
  });

  it('ends exactly one session when told to', async () => {
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowed(), NO_ORIGIN);
      await createSession(tx, allowed(), NO_ORIGIN);
    });
    const victim = (await liveSessions())[0]!.id;

    const result = await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, {
        trigger: 'self',
        actorUserId: userId,
        onlySessionId: victim,
      }),
    );

    expect(result.sessionsRevoked).toBe(1);
    expect(await liveSessions()).toHaveLength(1);
  });

  it('revokes refresh tokens even for a single-session revoke', async () => {
    // A refresh token outlives the session that minted it and is not scoped to
    // it. Ending one session and leaving the token alive would be a revocation
    // somebody could refresh their way straight past.
    await seedRelyingParty();
    await withTenant(tenantId, (tx) => createSession(tx, allowed(), NO_ORIGIN));
    const victim = (await liveSessions())[0]!.id;

    await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, { trigger: 'self', onlySessionId: victim }),
    );

    expect(await withTenant(tenantId, (tx) => tx.oidcArtifact.count())).toBe(0);
  });

  it('records one audit event naming what caused it', async () => {
    await withTenant(tenantId, (tx) => createSession(tx, allowed(), NO_ORIGIN));

    await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, { trigger: 'deactivation' }),
    );

    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'session.revoked' } }),
    );
    expect((event.payload as Record<string, unknown>).trigger).toBe('deactivation');
    expect(event.targetId).toBe(userId);
  });

  it('queues nothing for a relying party that did not ask', async () => {
    await withTenant(tenantId, (tx) => createSession(tx, allowed(), NO_ORIGIN));

    const result = await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, { trigger: 'admin' }),
    );

    expect(result.logoutsEnqueued).toBe(0);
  });
});

/**
 * These are written against the CALLERS, not against `endSessions`.
 *
 * The defect this guards was never in the function — it was in who called it.
 * `refresh-token.ts` records the last time that distinction mattered: a
 * revocation that satisfied the letter of every caller and none of the point,
 * leaving a phished refresh token alive for fourteen days.
 */
describe('every path that takes access away propagates it', () => {
  it('a deactivation tells the relying parties', async () => {
    await seedRelyingParty();
    await withTenant(tenantId, (tx) => createSession(tx, allowed(), NO_ORIGIN));

    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));

    expect(await queuedLogouts()).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.oidcArtifact.count())).toBe(0);
  });

  it('a deactivation with nobody signed in still tells them', async () => {
    // The grant is what matters, not the session. Somebody who closed their
    // browser still holds a refresh token at the relying party.
    await seedRelyingParty();

    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));

    expect(await queuedLogouts()).toBe(1);
  });

  it('a tenant-wide revoke tells them too', async () => {
    await seedRelyingParty();
    await withTenant(tenantId, (tx) => createSession(tx, allowed(), NO_ORIGIN));

    await revokeTenantSessions(tenantId, {
      scope: 'all',
      actorUserId: userId,
      sourceIp: null,
      reason: 'suspected compromise',
    });

    expect(await queuedLogouts()).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.oidcArtifact.count())).toBe(0);
  });
});

describe('revokeTenantSessions', () => {
  let otherId: string;
  let adminId: string;

  const sessionFor = (who: string, scope: 'portal' | 'admin') =>
    withTenant(tenantId, (tx) =>
      createSession(tx, { ...allowed(scope), userId: who }, NO_ORIGIN),
    );
  const liveFor = (who: string) =>
    withTenant(tenantId, (tx) => listSessionsForUser(tx, who));

  beforeEach(async () => {
    const [other, admin] = await withTenant(tenantId, async (tx) => [
      await createUser(tx, { login: 'other', email: 'o@acme.test', displayName: 'O' }),
      await createUser(tx, { login: 'admin', email: 'a@acme.test', displayName: 'A' }),
    ]);
    otherId = other!.id;
    adminId = admin!.id;
  });

  it('ends every session in the tenant and records why', async () => {
    await sessionFor(userId, 'portal');
    await sessionFor(otherId, 'portal');
    await sessionFor(otherId, 'admin');

    const result = await revokeTenantSessions(tenantId, {
      scope: 'all',
      actorUserId: adminId,
      sourceIp: '203.0.113.9',
      reason: 'phishing campaign reported',
    });

    expect(result).toMatchObject({ usersAffected: 2, sessionsRevoked: 3 });
    expect(await liveFor(userId)).toEqual([]);
    expect(await liveFor(otherId)).toEqual([]);

    const summary = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'session.mass_revoked' } }),
    );
    expect(summary.actorUserId).toBe(adminId);
    expect(summary.outcome).toBe('success');
    expect(summary.payload).toMatchObject({
      scope: 'all',
      reason: 'phishing campaign reported',
      usersAffected: 2,
      sessionsRevoked: 3,
    });
    // And each user's own revocation is visible per user, by cause.
    const perUser = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'session.revoked' } }),
    );
    expect(perUser).toHaveLength(2);
    for (const e of perUser) {
      expect((e.payload as Record<string, unknown>).trigger).toBe('mass_revoke');
    }
  });

  it('spares only the session making the request', async () => {
    await sessionFor(adminId, 'admin');
    await sessionFor(adminId, 'admin');
    await sessionFor(userId, 'portal');
    const keep = (await liveFor(adminId))[0]!.id;

    await revokeTenantSessions(tenantId, {
      scope: 'all',
      actorUserId: adminId,
      exceptSessionId: keep,
      sourceIp: null,
      reason: 'rotating after an incident',
    });

    expect((await liveFor(adminId)).map((s) => s.id)).toEqual([keep]);
    expect(await liveFor(userId)).toEqual([]);
  });

  it('ends only administrative sessions when narrowed to them', async () => {
    await sessionFor(userId, 'portal');
    await sessionFor(otherId, 'portal');
    await sessionFor(otherId, 'admin');

    const result = await revokeTenantSessions(tenantId, {
      scope: 'admin',
      actorUserId: adminId,
      sourceIp: null,
      reason: 'administrator credential leak',
    });

    expect(result).toMatchObject({ usersAffected: 1, sessionsRevoked: 1 });
    expect(await liveFor(userId)).toHaveLength(1);
    expect((await liveFor(otherId)).map((s) => s.scope)).toEqual(['portal']);
  });

  it('reaches a refresh token whose session is already gone', async () => {
    // A refresh token outlives the session that minted it. "Revoke every
    // session" that left one alive would not be what was asked for.
    await withTenant(tenantId, (tx) =>
      tx.refreshToken.create({
        data: {
          tenantId,
          userId: otherId,
          tokenHash: 'refresh-hash',
          absoluteExpiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    );

    const result = await revokeTenantSessions(tenantId, {
      scope: 'all',
      actorUserId: adminId,
      sourceIp: null,
      reason: 'suspected token theft',
    });

    expect(result.usersAffected).toBe(1);
    const token = await withTenant(tenantId, (tx) =>
      tx.refreshToken.findFirstOrThrow(),
    );
    expect(token.revokedAt).not.toBeNull();
  });

  it('does not reach into another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const stranger = await withTenant(other.id, (tx) =>
      createUser(tx, { login: 'x', email: 'x@other.test', displayName: 'X' }),
    );
    await withTenant(other.id, (tx) =>
      createSession(tx, { ...allowed(), userId: stranger.id }, NO_ORIGIN),
    );

    await revokeTenantSessions(tenantId, {
      scope: 'all',
      actorUserId: adminId,
      sourceIp: null,
      reason: 'suspected compromise',
    });

    expect(
      await withTenant(other.id, (tx) => listSessionsForUser(tx, stranger.id)),
    ).toHaveLength(1);
  });
});
