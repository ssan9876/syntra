import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { BUILTIN_CONNECTOR_DOCUMENTS } from '@syntra/connectors';
import {
  OWNER_PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const validate = (document: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/admin/targets/connector-documents/validate',
    headers: { host: ctx.host, cookie },
    payload: { document } as object,
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Admin' });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Everything', [...OWNER_PERMISSIONS]);
    await assignRole(tx, admin.id, role.id);
  });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const first = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${first}` },
    payload: { password: PASSWORD },
  });
  cookie = `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
});

describe('POST /targets/connector-documents/validate', () => {
  it('accepts a shipped document', async () => {
    const res = await validate(BUILTIN_CONNECTOR_DOCUMENTS['snipe-it']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, errors: [] });
  });

  it('names each problem by its path in the document', async () => {
    const res = await validate({
      name: 'Acme',
      version: 1,
      baseUrl: 'ftp://acme',
      auth: { type: 'bearer' },
      account: { list: { path: 'users' } },
    });
    const { valid, errors } = res.json() as { valid: boolean; errors: { path: string }[] };
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['baseUrl', 'account.list.path', 'account.anchorAt']),
    );
  });
});
