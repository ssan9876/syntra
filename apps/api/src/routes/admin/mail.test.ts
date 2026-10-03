import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, type Permission, type Transport } from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

/*
 * Outgoing mail: the transport as configured, the test send, and the warning
 * for mail that goes to a local test server.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await ctx?.app.close(); });

async function cookieFor(login: string, permissions: Permission[]): Promise<{ cookie: string; userId: string }> {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(tx, {
      status: 'allow', userId: user.id, mayElevate: true,
      scope: 'admin', applicationId: null, satisfiedFactor: null,
    }, { ip: null, userAgent: null });
    return { cookie: `syntra_session=${session.token}`, userId: user.id };
  });
}

const call = (method: 'GET' | 'POST', url: string, cookie?: string) =>
  ctx.app.inject({ method, url, headers: { host: ctx.host, ...(cookie ? { cookie } : {}) } });

const auditEvents = () =>
  withTenant(ctx.tenantId, (tx) => tx.auditEvent.findMany({ where: { action: 'notify.test_email' }, orderBy: { occurredAt: 'asc' } }));

describe('outgoing mail', () => {
  it('shows the transport and sends a test email to the caller only, with deployment.manage', async () => {
    ctx = await buildTestApp({ env: { PUBLIC_URL: 'https://acme.syntra.test', SMTP_URL: 'smtp://relay:secret-pass@mail.contoso.com:587' } });
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);

    expect((await call('GET', '/api/admin/mail')).statusCode).toBe(401);
    expect((await call('GET', '/api/admin/mail', admin.cookie)).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/mail/test', admin.cookie)).statusCode).toBe(403);

    const settings = await call('GET', '/api/admin/mail', operator.cookie);
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({
      transport: 'smtp',
      server: 'smtp://mail.contoso.com:587',
      from: 'Syntra <no-reply@syntra.local>',
      recipient: 'operator@acme.test',
      warning: null,
    });
    expect(settings.body).not.toContain('secret-pass');

    const sent = await call('POST', '/api/admin/mail/test', operator.cookie);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      ok: true,
      to: 'operator@acme.test',
      server: 'smtp://mail.contoso.com:587',
      message: 'Test email sent to operator@acme.test through smtp://mail.contoso.com:587.',
    });
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]).toMatchObject({ to: 'operator@acme.test', subject: 'Test email from Acme' });

    const [event] = await auditEvents();
    expect(event).toMatchObject({ actorUserId: operator.userId, targetId: operator.userId, outcome: 'success' });
    expect(event!.payload).toEqual({ server: 'smtp://mail.contoso.com:587' });
  });

  it("reports a refusal with the server and the transport's error, and audits it as a failure", async () => {
    const refusing: Transport = {
      send: async () => { throw new Error('Invalid login: 535 5.7.8 Authentication failed'); },
    };
    ctx = await buildTestApp({ transport: refusing, env: { SMTP_URL: 'smtp://mail.contoso.com:587' } });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);

    const sent = await call('POST', '/api/admin/mail/test', operator.cookie);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      ok: false,
      message: 'Email to operator@acme.test was not sent through smtp://mail.contoso.com:587: Invalid login: 535 5.7.8 Authentication failed',
    });
    const [event] = await auditEvents();
    expect(event).toMatchObject({ outcome: 'failure' });
    expect(event!.payload).toMatchObject({ server: 'smtp://mail.contoso.com:587', error: 'Invalid login: 535 5.7.8 Authentication failed' });
  });

  it('allows five test sends a minute', async () => {
    ctx = await buildTestApp();
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    for (let i = 0; i < 5; i += 1) {
      expect((await call('POST', '/api/admin/mail/test', operator.cookie)).statusCode).toBe(200);
    }
    expect((await call('POST', '/api/admin/mail/test', operator.cookie)).statusCode).toBe(429);
    expect(ctx.mail.sent).toHaveLength(5);
  });
});

describe('mail to a local test server', () => {
  it('is an incident, a degraded mail component and a warning beside the test button', async () => {
    ctx = await buildTestApp({ env: { PUBLIC_URL: 'https://acme.syntra.test', SMTP_URL: 'smtp://localhost:1025' } });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE, PERMISSIONS.AUDIT_READ]);
    const message = 'Mail goes to smtp://localhost:1025, a local test server. Set SMTP_URL to a real mail server.';

    expect((await call('GET', '/api/admin/mail', operator.cookie)).json()).toMatchObject({ warning: message });
    expect((await call('POST', '/api/admin/mail/test', operator.cookie)).json()).toMatchObject({ ok: true, warning: message });

    const incidents = (await call('GET', '/api/admin/incidents', operator.cookie)).json().incidents;
    expect(incidents).toContainEqual(expect.objectContaining({
      kind: 'mail_to_test_server',
      severity: 'critical',
      title: 'Mail goes to a test server',
      detail: 'SMTP_URL is smtp://localhost:1025. Set it to a real mail server.',
    }));

    // Acknowledged, never resolved: it clears when SMTP_URL changes.
    const resolve = await ctx.app.inject({
      method: 'POST', url: '/api/admin/incidents/mail_to_test_server/resolve',
      headers: { host: ctx.host, cookie: operator.cookie, 'content-type': 'application/json' }, payload: '{}',
    });
    expect(resolve.statusCode).toBe(409);

    const status = (await call('GET', '/api/admin/status', operator.cookie)).json();
    expect(status.components).toContainEqual(expect.objectContaining({ name: 'smtp', state: 'degraded' }));
    expect(status.overall).not.toBe('operational');
  });

  it('says nothing on an install whose own address is local', async () => {
    ctx = await buildTestApp({ env: { PUBLIC_URL: 'http://localhost:3000', SMTP_URL: 'smtp://localhost:1025' } });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE, PERMISSIONS.AUDIT_READ]);
    expect((await call('GET', '/api/admin/mail', operator.cookie)).json()).toMatchObject({ warning: null });
    const incidents = (await call('GET', '/api/admin/incidents', operator.cookie)).json().incidents;
    expect(incidents).not.toContainEqual(expect.objectContaining({ kind: 'mail_to_test_server' }));
  });
});
