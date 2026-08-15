import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  createApplication,
  createUser,
  localMasterKeyProvider,
  setPassword,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let cookie: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const call = (method: 'GET' | 'POST', url: string, withCookie = true) =>
  ctx.app.inject({
    method,
    url,
    headers: {
      host: ctx.host,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

/**
 * Enrols TOTP at a timestamp two minutes in the past.
 *
 * `confirmTotpEnrolment` sets the replay watermark to the step that confirmed
 * the enrolment, so a code generated at wall time immediately afterwards falls
 * in the same step and is correctly refused as a replay. Backdating puts the
 * watermark four steps behind and makes every test below deterministic instead
 * of dependent on where in the half-minute it ran.
 */
async function enrolTotpFor(id: string): Promise<string> {
  const past = new Date(Date.now() - 120_000);
  const enrolment = await withTenant(ctx.tenantId, (tx) =>
    beginTotpEnrolment(tx, provider, id),
  );
  const ok = await confirmTotpEnrolment(
    ctx.tenantId,
    provider,
    id,
    OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(enrolment.secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
      timestamp: past.getTime(),
    }),
    past,
  );
  expect(ok).toBe(true);
  return enrolment.secret;
}

async function assignedApp(slug = 'crm') {
  return withTenant(ctx.tenantId, async (tx) => {
    const application = await createApplication(tx, {
      name: 'CRM',
      slug,
      description: 'Customer records',
      launchUrl: 'https://crm.acme.test/',
    });
    await assignApplication(tx, application.id, { type: 'user', id: userId });
    return application;
  });
}

describe('GET /api/portal/applications', () => {
  it('needs a session', async () => {
    expect((await call('GET', '/api/portal/applications', false)).statusCode).toBe(401);
  });

  it('returns the tiles the user resolves to', async () => {
    await assignedApp();
    const res = await call('GET', '/api/portal/applications');
    expect(res.json().applications).toEqual([
      {
        id: expect.any(String),
        name: 'CRM',
        slug: 'crm',
        description: 'Customer records',
        iconUrl: null,
      },
    ]);
  });

  it('never returns the launch URL in the tile list', async () => {
    await assignedApp();
    const res = await call('GET', '/api/portal/applications');
    // The URL comes from /launch, which goes through the chokepoint. Putting it
    // in the tile would make the tile itself a way around policy.
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('returns nothing for a user with no assignments', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'CRM', slug: 'crm', launchUrl: 'https://crm.acme.test/' }),
    );
    expect((await call('GET', '/api/portal/applications')).json().applications).toEqual([]);
  });
});

describe('POST /api/portal/applications/:id/launch', () => {
  it('returns the launch URL for an assigned application', async () => {
    const application = await assignedApp();
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'launch', url: 'https://crm.acme.test/' });
  });

  it('refuses an application the user is not assigned', async () => {
    const application = await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'HR', slug: 'hr', launchUrl: 'https://hr.acme.test/' }),
    );
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(403);
  });

  it('reports an unknown application exactly as an unassigned one', async () => {
    const unknown = await call(
      'POST',
      '/api/portal/applications/00000000-0000-4000-8000-000000000000/launch',
    );
    const application = await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'HR', slug: 'hr', launchUrl: 'https://hr.acme.test/' }),
    );
    const unassigned = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(unknown.statusCode).toBe(unassigned.statusCode);
    expect(unknown.json()).toEqual(unassigned.json());
  });

  it('honours a policy rule scoped to that application', async () => {
    const application = await assignedApp();
    await enrolTotpFor(userId);

    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
    });
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('does not challenge for an application the rule does not name', async () => {
    const crm = await assignedApp('crm');
    const wiki = await assignedApp('wiki');
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM only',
        outcome: 'require_mfa',
        applicationIds: [crm.id],
      }),
    );
    const res = await call('POST', `/api/portal/applications/${wiki.id}/launch`);
    expect(res.json().status).toBe('launch');
  });

  it('refuses when a rule denies that application', async () => {
    const application = await assignedApp();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM closed',
        outcome: 'deny',
        applicationIds: [application.id],
      }),
    );
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(403);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.policy_denied' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ruleName: 'CRM closed' });
  });

  it('offers enrolment when a rule scoped to the application needs a factor', async () => {
    const application = await assignedApp();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    // This user has enrolled nothing, so the launch cannot be a step-up.
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('completes the challenge round trip and then launches', async () => {
    // The case whose absence let an application with a require_mfa rule be
    // permanently unlaunchable: launch issues a challenge, the challenge is
    // answered, and the relaunch is a fresh decision with nothing recorded as
    // satisfied — so it issues the same challenge again, and again.
    const application = await assignedApp();
    const secret = await enrolTotpFor(userId);
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const challenged = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(challenged.json()).toMatchObject({ status: 'challenge' });

    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'totp',
        attemptToken: challenged.json().attemptToken,
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });
    expect(verified.statusCode).toBe(200);

    // The step-up replaced the session cookie; the relaunch uses the new one.
    cookie = verified.cookies.find((c) => c.name === 'syntra_session')!.value;
    const launched = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(launched.json()).toEqual({ status: 'launch', url: 'https://crm.acme.test/' });
  });

  it('gives a portal session to a portal user who completes a launch step-up', async () => {
    // The browser sends its cookie on every request, so "a session cookie was
    // present" is true for every launch step-up ever performed. Inferring
    // scope from it would hand an administrative session to any portal user
    // who clicked a tile.
    const application = await assignedApp();
    const secret = await enrolTotpFor(userId);
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const challenged = await call('POST', `/api/portal/applications/${application.id}/launch`);
    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'totp',
        attemptToken: challenged.json().attemptToken,
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });

    expect(verified.json().scope).toBe('portal');
    const attempt = await withTenant(ctx.tenantId, (tx) => tx.authAttempt.findFirst());
    expect(attempt!.scope).toBe('portal');
  });

  it('audits a successful launch', async () => {
    const application = await assignedApp();
    await call('POST', `/api/portal/applications/${application.id}/launch`);
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'application.launch' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(application.id);
  });
});
