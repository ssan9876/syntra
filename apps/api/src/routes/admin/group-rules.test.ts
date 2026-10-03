import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  OWNER_PERMISSIONS,
  assignRole,
  createGroup,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let groupId: string;
let annId: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const FINANCE = { field: 'contract.department', op: 'equals', value: 'Finance' };

const send = (method: 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Admin' });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Everything', [...OWNER_PERMISSIONS]);
    await assignRole(tx, admin.id, role.id);

    groupId = (await createGroup(tx, 'Finance')).id;
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Ann', familyName: 'Lee' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: person.id,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
        department: 'Finance',
      },
    });
    const ann = await createUser(tx, { login: 'alee', email: 'alee@acme.test', displayName: 'Ann Lee' });
    await tx.user.update({ where: { id: ann.id }, data: { personId: person.id } });
    annId = ann.id;
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

describe('group membership rule routes', () => {
  it('previews without writing, then saves and applies', async () => {
    const preview = await send('POST', `/api/admin/groups/${groupId}/rule/preview`, { rule: FINANCE });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().add).toEqual({
      count: 1,
      users: [{ id: annId, login: 'alee', displayName: 'Ann Lee' }],
    });
    expect(await withTenant(ctx.tenantId, (tx) => tx.groupMembership.count())).toBe(0);

    const saved = await send('PUT', `/api/admin/groups/${groupId}/rule`, { rule: FINANCE });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ added: 1, removed: 0 });
    expect(saved.json().group.membershipRule).toEqual(FINANCE);
  });

  it('refuses a field outside the closed set with 400', async () => {
    const res = await send('PUT', `/api/admin/groups/${groupId}/rule`, {
      rule: { field: 'contract.salary', op: 'equals', value: '1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to remove a member the rule added', async () => {
    await send('PUT', `/api/admin/groups/${groupId}/rule`, { rule: FINANCE });
    const res = await send('DELETE', `/api/admin/groups/${groupId}/members/${annId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("Ann Lee matches this group's rule. Change the rule to remove them.");
  });

  it('refuses apply on a group with no rule', async () => {
    const res = await send('POST', `/api/admin/groups/${groupId}/rule/apply`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('Group "Finance" has no membership rule.');
  });

  it('refuses a rule on a source-owned group', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId: ctx.tenantId, name: 'AD', config: {}, secretName: 'ad' },
      });
      await tx.group.update({ where: { id: groupId }, data: { sourceId: source.id, sourceAnchor: 'g' } });
    });
    const res = await send('PUT', `/api/admin/groups/${groupId}/rule`, { rule: FINANCE });
    expect(res.statusCode).toBe(409);
  });
  it('holds Apply now when it would remove too many, until confirmed', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      for (let i = 0; i < 9; i += 1) {
        const person = await tx.person.create({
          data: { tenantId: ctx.tenantId, givenName: `P${i}`, familyName: 'Test' },
        });
        await tx.contract.create({
          data: { tenantId: ctx.tenantId, personId: person.id, isPrimary: true, startDate: new Date('2020-01-01'), department: 'Finance' },
        });
        const user = await createUser(tx, { login: `p${i}`, email: `p${i}@acme.test`, displayName: `P${i}` });
        await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      }
    });
    await send('PUT', `/api/admin/groups/${groupId}/rule`, { rule: FINANCE });
    await withTenant(ctx.tenantId, (tx) => tx.contract.updateMany({ data: { department: 'Sales' } }));

    const held = await send('POST', `/api/admin/groups/${groupId}/rule/apply`, {});
    expect(held.statusCode).toBe(409);
    expect(held.json().detail).toBe('Rule would remove 10 of 10 members of "Finance". Apply anyway to confirm.');

    const confirmed = await send('POST', `/api/admin/groups/${groupId}/rule/apply`, { confirm: true });
    expect(confirmed.json()).toEqual({ added: 0, removed: 10 });
  });
});
