import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, recordEvent, type Permission } from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let receiver: Server | null = null;
afterEach(async () => {
  await ctx?.app.close();
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()));
  receiver = null;
});

async function cookieFor(login: string, permissions: Permission[]): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(tx, {
      status: 'allow', userId: user.id, mayElevate: true,
      scope: 'admin', applicationId: null, satisfiedFactor: null,
    }, { ip: null, userAgent: null });
    return `syntra_session=${session.token}`;
  });
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

async function listen(): Promise<{ url: string; received: { body: string; auth: string | undefined }[] }> {
  const received: { body: string; auth: string | undefined }[] = [];
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (c: string) => (body += c)).on('end', () => {
      received.push({ body, auth: req.headers['authorization'] });
      res.writeHead(200).end('{"text":"Success","code":0}');
    });
  });
  await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(receiver!.address() as AddressInfo).port}/services/collector/event`, received };
}

describe('SIEM stream routes', () => {
  it('manages streams for tenant.manage, tests one against a receiver, and never returns the credential', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler(), env: { OUTBOUND_ALLOW_PRIVATE: 'true' } });
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);
    const auditor = await cookieFor('auditor', [PERMISSIONS.AUDIT_READ]);
    const { url, received } = await listen();

    expect((await call('GET', '/api/admin/audit-streams', auditor)).statusCode).toBe(403);

    const wrongFormat = await call('POST', '/api/admin/audit-streams', admin, { name: 'Splunk', transport: 'https', format: 'cef', url });
    expect(wrongFormat.statusCode).toBe(400);
    expect(wrongFormat.json().errors).toEqual([{ path: 'format', message: 'cef is not a format for https.' }]);

    const created = await call('POST', '/api/admin/audit-streams', admin, {
      name: 'Splunk', transport: 'https', format: 'splunk-hec', url, authHeader: 'Authorization', credential: 'Splunk 1234-hec-token',
    });
    expect(created.statusCode).toBe(201);
    const stream = created.json().stream;
    expect(stream).toMatchObject({ name: 'Splunk', hasCredential: true, status: 'delivering' });
    expect(created.body).not.toContain('1234-hec-token');
    expect((await call('GET', '/api/admin/audit-streams', admin)).body).not.toContain('1234-hec-token');

    const test = await call('POST', `/api/admin/audit-streams/${stream.id}/test`, admin, {});
    expect(test.statusCode).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe('Splunk 1234-hec-token');
    expect(JSON.parse(received[0]!.body)).toMatchObject({ sourcetype: 'syntra:audit', event: { action: 'audit_stream.test' } });

    const updated = await call('PUT', `/api/admin/audit-streams/${stream.id}`, admin, {
      name: 'Splunk', transport: 'https', format: 'splunk-hec', url, authHeader: 'Authorization', credential: null,
    });
    expect(updated.json().stream.hasCredential).toBe(false);

    expect((await call('DELETE', `/api/admin/audit-streams/${stream.id}`, admin)).statusCode).toBe(204);
    const actions = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'audit.stream_' } }, orderBy: { sequence: 'asc' } }));
    expect(actions.map((event) => event.action)).toEqual(['audit.stream_created', 'audit.stream_updated', 'audit.stream_deleted']);
    expect(JSON.stringify(actions.map((event) => event.payload))).not.toContain('1234-hec-token');
  });

  it('says what the receiver answered when a test fails', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler(), env: { OUTBOUND_ALLOW_PRIVATE: 'true' } });
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);
    receiver = createServer((_req, res) => res.writeHead(403).end('{"text":"Invalid token","code":4}'));
    await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/services/collector/event`;
    const stream = (await call('POST', '/api/admin/audit-streams', admin, { name: 'Splunk', transport: 'https', format: 'splunk-hec', url })).json().stream;
    const test = await call('POST', `/api/admin/audit-streams/${stream.id}/test`, admin, {});
    expect(test.statusCode).toBe(422);
    expect(test.json().detail).toBe(`${url}: HTTP 403: {"text":"Invalid token","code":4}`);
  });

  it('refuses plain http unless private addresses are allowed', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler(), env: { OUTBOUND_ALLOW_PRIVATE: 'false' } });
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);
    const refused = await call('POST', '/api/admin/audit-streams', admin, { name: 'S', transport: 'https', format: 'json', url: 'http://siem.example.com/in' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().errors[0]).toEqual({ path: 'url', message: 'Use an https:// URL.' });
  });

  it('serves the log oldest first from a cursor, for a SIEM that polls', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler() });
    const reader = await cookieFor('reader', [PERMISSIONS.AUDIT_READ]);
    for (const action of ['test.one', 'test.two', 'test.three']) {
      await withTenant(ctx.tenantId, (tx) =>
        recordEvent(tx, { actorUserId: null, action, targetType: 'Test', targetId: null, outcome: 'success', sourceIp: null, payload: {} }),
      );
    }
    const first = (await call('GET', '/api/admin/audit/stream?after=0&limit=2', reader)).json();
    expect(first.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2]);
    expect(first.events[0]).toMatchObject({ tenant: expect.any(String), hash: expect.any(String), prevHash: expect.any(String) });
    const next = (await call('GET', `/api/admin/audit/stream?after=${first.nextAfter}&limit=1000`, reader)).json();
    expect(next.events[0]?.sequence).toBe(3);
    const end = (await call('GET', `/api/admin/audit/stream?after=${next.nextAfter}`, reader)).json();
    expect(end).toEqual({ events: [], nextAfter: next.nextAfter });
  });
});
