import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignApplication,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { MAX_APP_ICON_BYTES } from '@syntra/contracts';
import { buildTestApp } from '../../test-support.js';

/**
 * Self-hosted application logos: `PUT /api/admin/applications/:id/icon`, the
 * `icon` on the admin list, the route that serves an upload, and what a
 * portal tile is told to draw.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let readerCookie: string;
let portalCookie: string;
let applicationId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size = 128) =>
  Buffer.from([...PNG_HEADER, ...new Array<number>(size - PNG_HEADER.length).fill(7)]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const dataUri = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

async function signIn(login: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  return res.cookies.find((c) => c.name === 'syntra_session')!.value;
}

async function elevated(login: string): Promise<string> {
  const portal = await signIn(login);
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return up.cookies.find((c) => c.name === 'syntra_session')!.value;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Ada' });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    await assignRole(tx, admin.id, (await createRole(tx, 'Owner', ALL_PERMISSIONS)).id);

    const reader = await createUser(tx, { login: 'reader', email: 'reader@acme.test', displayName: 'Rea' });
    await setPasswordHash(tx, reader.id, PASSWORD_HASH);
    await assignRole(tx, reader.id, (await createRole(tx, 'Reader', [PERMISSIONS.ACCESS_READ])).id);

    const employee = await createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' });
    await setPasswordHash(tx, employee.id, PASSWORD_HASH);

    const application = await tx.application.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'CRM',
        slug: 'crm',
        launchUrl: 'https://crm.acme.test/',
        // A legacy remote logo: the thing this feature exists to replace.
        iconUrl: 'https://cdn.example.com/crm.png',
      },
    });
    applicationId = application.id;
    await assignApplication(tx, application.id, { type: 'user', id: employee.id });
  });

  adminCookie = await elevated('admin');
  readerCookie = await elevated('reader');
  portalCookie = await signIn('jdoe');
});

const inject = (
  method: 'GET' | 'PUT',
  url: string,
  cookie: string | null,
  payload?: object,
  extraHeaders: Record<string, string> = {},
) => {
  const headers = {
    host: ctx.host,
    ...(cookie === null ? {} : { cookie: `syntra_session=${cookie}` }),
    ...extraHeaders,
  };
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

const putIcon = (icon: unknown, cookie = adminCookie, id = applicationId) =>
  inject('PUT', `/api/admin/applications/${id}/icon`, cookie, { icon });

const listed = async () => {
  const res = await inject('GET', '/api/admin/applications', adminCookie);
  expect(res.statusCode).toBe(200);
  return (res.json().applications as { id: string; icon: unknown; iconUrl: string | null }[]).find(
    (a) => a.id === applicationId,
  )!;
};

const tileIconUrl = async () => {
  const res = await inject('GET', '/api/portal/applications', portalCookie);
  expect(res.statusCode).toBe(200);
  return (res.json().applications as { id: string; iconUrl: string | null }[]).find(
    (a) => a.id === applicationId,
  )!.iconUrl;
};

describe('a built-in mark', () => {
  it('is set, reported on the list, and drawn on the tile', async () => {
    const res = await putIcon({ kind: 'builtin', key: 'calendar' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      icon: { kind: 'builtin', key: 'calendar', url: '/app-icons/calendar.svg' },
    });

    const row = await listed();
    expect(row.icon).toEqual({ kind: 'builtin', key: 'calendar', url: '/app-icons/calendar.svg' });
    // The legacy remote URL went with it.
    expect(row.iconUrl).toBeNull();
    // No bookkeeping column, and never the bytes, on the admin record.
    expect(row).not.toHaveProperty('iconImage');
    expect(row).not.toHaveProperty('iconKey');

    expect(await tileIconUrl()).toBe('/app-icons/calendar.svg');
  });

  it('refuses a key that is not in the library', async () => {
    const res = await putIcon({ kind: 'builtin', key: 'slack' });
    expect(res.statusCode).toBe(400);
  });

  it('is audited', async () => {
    await putIcon({ kind: 'builtin', key: 'mail' });
    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'application.icon_update' } }),
    );
    expect(event.targetId).toBe(applicationId);
    expect(event.payload).toMatchObject({ slug: 'crm', icon: { kind: 'builtin', key: 'mail' } });
  });
});

describe('an uploaded image', () => {
  it('is stored, served with its headers, and revalidates to 304', async () => {
    const bytes = png();
    const hash = createHash('sha256').update(bytes).digest('hex');

    const res = await putIcon({ kind: 'image', dataUri: dataUri('image/png', bytes) });
    expect(res.statusCode).toBe(200);
    const url = `/api/portal/applications/${applicationId}/icon?v=${hash.slice(0, 12)}`;
    expect(res.json()).toEqual({ icon: { kind: 'image', url, contentType: 'image/png', bytes: bytes.length } });

    expect((await listed()).icon).toEqual(res.json().icon);
    expect(await tileIconUrl()).toBe(url);

    // Served to an ordinary portal session, not only to administrators.
    const served = await inject('GET', url, portalCookie);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'");
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(served.headers.etag).toBe(`"${hash}"`);
    expect(served.rawPayload.equals(bytes)).toBe(true);

    // And to the console's admin session.
    expect((await inject('GET', url, adminCookie)).statusCode).toBe(200);

    const again = await inject('GET', url, portalCookie, undefined, { 'if-none-match': `"${hash}"` });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);

    const weak = await inject('GET', url, portalCookie, undefined, { 'if-none-match': `"x", W/"${hash}"` });
    expect(weak.statusCode).toBe(304);

    const stale = await inject('GET', url, portalCookie, undefined, { 'if-none-match': '"something-else"' });
    expect(stale.statusCode).toBe(200);
  });

  it('is not served without a session', async () => {
    await putIcon({ kind: 'image', dataUri: dataUri('image/png', png()) });
    const res = await inject('GET', `/api/portal/applications/${applicationId}/icon`, null);
    expect(res.statusCode).toBe(401);
  });

  it('replaces a built-in mark, and a built-in mark replaces it', async () => {
    await putIcon({ kind: 'builtin', key: 'crm' });
    await putIcon({ kind: 'image', dataUri: dataUri('image/png', png()) });
    expect((await listed()).icon).toMatchObject({ kind: 'image' });

    await putIcon({ kind: 'builtin', key: 'crm' });
    expect((await listed()).icon).toMatchObject({ kind: 'builtin', key: 'crm' });
    // The bytes are gone, not merely hidden behind the mark.
    const res = await inject('GET', `/api/portal/applications/${applicationId}/icon`, portalCookie);
    expect(res.statusCode).toBe(404);
  });
});

describe('refusals', () => {
  const refused = async (icon: unknown, pattern: RegExp) => {
    const res = await putIcon(icon);
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json();
    expect(body.errors).toEqual([{ path: 'icon', message: expect.stringMatching(pattern) }]);
    // Nothing was written.
    expect((await listed()).icon).toBeNull();
  };

  it('refuses an SVG', async () => {
    await refused({ kind: 'image', dataUri: dataUri('image/svg+xml', Buffer.from('<svg/>')) }, /SVG/);
  });

  it('refuses an image whose content does not match its type', async () => {
    await refused({ kind: 'image', dataUri: dataUri('image/png', jpeg()) }, /actually a JPEG/);
  });

  it('refuses markup dressed as a PNG', async () => {
    await refused({ kind: 'image', dataUri: dataUri('image/png', Buffer.from('<html><script>1</script>')) }, /markup/);
  });

  it('refuses an image over the limit', async () => {
    // Just over the decoded limit, which still fits the request schema's
    // encoded-length bound — so this is the service's refusal, not zod's.
    await refused({ kind: 'image', dataUri: dataUri('image/png', png(MAX_APP_ICON_BYTES + 1)) }, /limit is 64 KB/);
  });

  it('answers 404 for an application that does not exist', async () => {
    const res = await putIcon({ kind: 'builtin', key: 'mail' }, adminCookie, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('refuses somebody who may read applications but not manage them', async () => {
    const res = await putIcon({ kind: 'builtin', key: 'mail' }, readerCookie);
    expect(res.statusCode).toBe(403);
    expect((await listed()).icon).toBeNull();
  });

  it('refuses a portal session outright', async () => {
    const res = await putIcon({ kind: 'builtin', key: 'mail' }, portalCookie);
    expect(res.statusCode).toBe(403);
  });
});

describe('clearing', () => {
  it('drops the logo, the bytes and the legacy URL together', async () => {
    await putIcon({ kind: 'image', dataUri: dataUri('image/png', png()) });
    const res = await putIcon(null);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ icon: null });

    const row = await listed();
    expect(row.icon).toBeNull();
    expect(row.iconUrl).toBeNull();
    expect(await tileIconUrl()).toBeNull();
    expect((await inject('GET', `/api/portal/applications/${applicationId}/icon`, portalCookie)).statusCode).toBe(404);
  });
});

describe('a portal tile with no self-hosted logo', () => {
  it('drops a legacy remote URL, which the page could never load', async () => {
    expect(await tileIconUrl()).toBeNull();
  });

  it('keeps a legacy path on this origin', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      tx.application.update({ where: { id: applicationId }, data: { iconUrl: '/static/crm.png' } }),
    );
    expect(await tileIconUrl()).toBe('/static/crm.png');
  });

  it('drops a protocol-relative URL, which is another origin', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      tx.application.update({ where: { id: applicationId }, data: { iconUrl: '//cdn.example.com/crm.png' } }),
    );
    expect(await tileIconUrl()).toBeNull();
  });

  it('serves nothing for an application without an upload', async () => {
    const res = await inject('GET', `/api/portal/applications/${applicationId}/icon`, portalCookie);
    expect(res.statusCode).toBe(404);
  });
});
