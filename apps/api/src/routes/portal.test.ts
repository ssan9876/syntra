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
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let cookie: string;

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
  ctx = await buildTestApp();
  await ctx.app.ready();

  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, u.id, PASSWORD_HASH);
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

  it('caps launches for the whole tenant, not only per address', async () => {
    // A launch runs authorize() and can mint an attempt, so it is a
    // credential-issuing endpoint whatever the URL looks like. It carried only
    // the per-address limit, which is bounded by how many addresses the
    // attacker has — the same reasoning that put the second dimension on every
    // other route that reaches the chokepoint.
    ctx = await buildTestApp({
      env: { AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_TENANT_MAX: '4' },
    });
    await ctx.app.ready();
    userId = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'jdoe',
        email: 'j@acme.test',
        displayName: 'J Doe',
      });
      await setPasswordHash(tx, u.id, PASSWORD_HASH);
      return u.id;
    });
    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'jdoe', password: PASSWORD },
    });
    cookie = signIn.cookies.find((c) => c.name === 'syntra_session')!.value;
    const application = await assignedApp();

    const codes: number[] = [];
    // Six addresses, one launch each: nothing trips the per-address limit of
    // two, so only the tenant ceiling can refuse any of them.
    for (let i = 1; i <= 6; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/portal/applications/${application.id}/launch`,
        headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
        remoteAddress: `203.0.113.${i}`,
      });
      codes.push(res.statusCode);
    }

    expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(codes.slice(4)).toEqual([429, 429]);
  });
});

/**
 * Launching a service provider or a relying party.
 *
 * The address a protocol tile sends the browser to is *derived* — from the
 * tenant's own protocol identity and from PUBLIC_URL — and never stored and
 * never taken from the request. `tenant-context.ts` resolves a tenant from the
 * leftmost label of the Host header, so `acme.attacker.example` resolves
 * tenant `acme`; a launch address built from that header would let an attacker
 * choose where a signed-in user's browser is sent next.
 */
describe('launching a protocol application', () => {
  const protocolApp = async (type: 'saml' | 'oidc', launchUrl?: string) =>
    withTenant(ctx.tenantId, async (tx) => {
      const application = await createApplication(tx, {
        name: type.toUpperCase(),
        slug: type,
        type,
        ...(launchUrl ? { launchUrl } : {}),
      });
      await assignApplication(tx, application.id, { type: 'user', id: userId });
      return application;
    });

  it('derives a SAML launch from the tenant identity, not from a stored URL', async () => {
    const application = await protocolApp('saml');
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'launch',
      url: `http://${ctx.host}/saml/start/${application.id}`,
    });
  });

  it('ignores the Host header when it derives that address', async () => {
    const application = await protocolApp('saml');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/portal/applications/${application.id}/launch`,
      // Resolves the same tenant — the leftmost label is the slug — and must
      // not appear anywhere in the answer.
      headers: { host: 'acme.attacker.example', cookie: `syntra_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).not.toContain('attacker.example');
    expect(res.json().url).toBe(`http://${ctx.host}/saml/start/${application.id}`);
  });

  it('sends an OIDC launch to the relying party through a Syntra redirect', async () => {
    const application = await protocolApp('oidc', 'https://rp.acme.test/start');
    const launch = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(launch.json().url).toBe(
      `http://${ctx.host}/api/portal/oidc-start/${application.id}`,
    );

    // OpenID Connect has no identity-provider-initiated flow: only the relying
    // party knows its own state, nonce and PKCE verifier, so the browser is
    // handed back to the application to start the code flow itself.
    const start = await call('GET', `/api/portal/oidc-start/${application.id}`);
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe('https://rp.acme.test/start');
  });

  it('refuses an OIDC start for an application the user is not assigned', async () => {
    const application = await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, {
        name: 'Other',
        slug: 'other',
        type: 'oidc',
        launchUrl: 'https://other.acme.test/start',
      }),
    );
    const res = await call('GET', `/api/portal/oidc-start/${application.id}`);
    expect(res.statusCode).toBe(403);
  });

  it('will not redirect an OIDC start to a scheme a browser must not follow', async () => {
    const application = await protocolApp('oidc', 'https://rp.acme.test/start');
    // A row that predates the check — an old migration, a seed, a restore.
    // The admin API refuses this on the way in; the launch refuses it on the
    // way out as well, because storage is not evidence.
    await withTenant(ctx.tenantId, (tx) =>
      tx.application.update({
        where: { id: application.id },
        data: { launchUrl: 'javascript:alert(1)' },
      }),
    );
    const res = await call('GET', `/api/portal/oidc-start/${application.id}`);
    expect(res.statusCode).toBe(409);
  });

  it('still refuses a bookmark with no launch address', async () => {
    const application = await withTenant(ctx.tenantId, async (tx) => {
      const created = await createApplication(tx, { name: 'B', slug: 'b' });
      await assignApplication(tx, created.id, { type: 'user', id: userId });
      return created;
    });
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(409);
  });
});
