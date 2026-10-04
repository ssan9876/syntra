import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  OWNER_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

/**
 * Leaving one person out of one target: the paths, the permissions, the
 * validation, the audit events and the tenant boundary. What a run then does
 * for somebody left out is `exclusion-service.test.ts`.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let targetId: string;
let personId: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Jane Doe' });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Custom', permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

async function adminCookie() {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const portal = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const list = () => `/api/admin/targets/${targetId}/exclusions`;
const one = (id = personId) => `/api/admin/targets/${targetId}/exclusions/${id}`;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Seth', familyName: 'Sander', businessEmail: 'seth@acme.test' },
    });
    const target = await tx.targetSystem.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'fmx.ssander.xyz',
        type: 'scim2',
        config: { baseUrl: 'https://fmx.example.test/scim/v2' },
        secretName: 'target:fmx',
      },
    });
    return { personId: person.id, targetId: target.id };
  });
  personId = seeded.personId;
  targetId = seeded.targetId;
});

describe('the exclusion routes', () => {
  it('need an administrative session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: list(), headers: { host: ctx.host } });
    expect(res.statusCode).toBe(401);
  });

  it('let a reader list, and refuse a reader adding or removing', async () => {
    await seedAdmin([PERMISSIONS.PROVISION_READ]);
    const cookie = await adminCookie();
    const res = await call('GET', list(), cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exclusions: [] });
    expect((await call('POST', list(), cookie, { personId, reason: 'x' })).statusCode).toBe(403);
    expect((await call('DELETE', one(), cookie, { reason: 'x' })).statusCode).toBe(403);
  });

  it('leave a person out, list them, and include them again, audited both ways', async () => {
    const admin = await seedAdmin([...OWNER_PERMISSIONS]);
    const cookie = await adminCookie();

    const added = await call('POST', list(), cookie, { personId, reason: 'FMX bootstrap administrator' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      targetSystemId: targetId,
      targetName: 'fmx.ssander.xyz',
      personId,
      personName: 'Seth Sander',
      businessEmail: 'seth@acme.test',
      reason: 'FMX bootstrap administrator',
      createdByUserId: admin.id,
      createdByName: 'Jane Doe',
    });
    expect(added.json().message).toMatch(/^Left out of this target by Jane Doe on .+: FMX bootstrap administrator\.$/);

    const listed = await call('GET', list(), cookie);
    expect(listed.json().exclusions.map((e: { personId: string }) => e.personId)).toEqual([personId]);

    const again = await call('POST', list(), cookie, { personId, reason: 'twice' });
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toContain('already-left-out');

    expect((await call('DELETE', one(), cookie, { reason: 'Handed over' })).statusCode).toBe(204);
    const missing = await call('DELETE', one(), cookie, { reason: 'Handed over' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().detail).toBe('Seth Sander is not left out of target "fmx.ssander.xyz".');

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: 'provision.target.exclusion' } },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => [e.action, e.actorUserId, e.targetId])).toEqual([
      ['provision.target.exclusion.add', admin.id, personId],
      ['provision.target.exclusion.remove', admin.id, personId],
    ]);
    expect(events[1]!.payload).toMatchObject({ targetSystemId: targetId, reason: 'Handed over' });
  });

  it('require a reason both ways, and a person id that is a uuid', async () => {
    await seedAdmin([...OWNER_PERMISSIONS]);
    const cookie = await adminCookie();
    expect((await call('POST', list(), cookie, { personId, reason: '   ' })).statusCode).toBe(400);
    expect((await call('POST', list(), cookie, { personId })).statusCode).toBe(400);
    expect((await call('POST', list(), cookie, { personId: 'nope', reason: 'x' })).statusCode).toBe(400);
    expect((await call('POST', list(), cookie, { personId, reason: 'x', extra: true })).statusCode).toBe(400);
    expect((await call('POST', list(), cookie, { personId, reason: 'x' })).statusCode).toBe(201);
    expect((await call('DELETE', one(), cookie, {})).statusCode).toBe(400);
  });

  it("answer 404 for another tenant's target or person", async () => {
    await seedAdmin([...OWNER_PERMISSIONS]);
    const cookie = await adminCookie();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other-tenant' } });
    const foreign = await withTenant(other.id, async (tx) => ({
      person: (await tx.person.create({ data: { tenantId: other.id, givenName: 'Eve', familyName: 'Other' } })).id,
      target: (
        await tx.targetSystem.create({
          data: {
            tenantId: other.id,
            name: 'Other target',
            type: 'scim2',
            config: { baseUrl: 'https://other.example.test/scim/v2' },
            secretName: 'target:other',
          },
        })
      ).id,
    }));
    await withTenant(other.id, (tx) =>
      tx.targetPersonExclusion.create({
        data: { tenantId: other.id, targetSystemId: foreign.target, personId: foreign.person, reason: 'Other tenant reason' },
      }),
    );

    const foreignList = await call('GET', `/api/admin/targets/${foreign.target}/exclusions`, cookie);
    expect(foreignList.statusCode).toBe(404);
    expect(foreignList.body).not.toContain('Other tenant reason');
    expect((await call('POST', list(), cookie, { personId: foreign.person, reason: 'x' })).statusCode).toBe(404);
    expect(
      (await call('POST', `/api/admin/targets/${foreign.target}/exclusions`, cookie, { personId, reason: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/api/admin/targets/${foreign.target}/exclusions/${foreign.person}`, cookie, { reason: 'x' }))
        .statusCode,
    ).toBe(404);
    const stillThere = await withTenant(other.id, (tx) => tx.targetPersonExclusion.count());
    expect(stillThere).toBe(1);
  });

  it('show the exclusion on Access explained', async () => {
    await seedAdmin([...OWNER_PERMISSIONS]);
    const cookie = await adminCookie();
    await call('POST', list(), cookie, { personId, reason: 'Protected' });
    const access = await call('GET', `/api/admin/persons/${personId}/access`, cookie);
    expect(access.statusCode).toBe(200);
    expect(access.json().exclusions).toEqual([
      expect.objectContaining({ targetSystemId: targetId, targetName: 'fmx.ssander.xyz', reason: 'Protected' }),
    ]);
  });

  it('refuse to adopt the conflicted account of somebody left out', async () => {
    await seedAdmin([...OWNER_PERMISSIONS]);
    const cookie = await adminCookie();
    await withTenant(ctx.tenantId, (tx) =>
      tx.targetAccount.create({
        data: { tenantId: ctx.tenantId, targetSystemId: targetId, personId, correlationKey: 'ssander', status: 'conflict' },
      }),
    );
    await call('POST', list(), cookie, { personId, reason: 'Protected' });
    // Kept: a conflict records a real collision at the target.
    expect(await withTenant(ctx.tenantId, (tx) => tx.targetAccount.count({ where: { personId } }))).toBe(1);

    const adopt = await call('POST', `/api/admin/targets/${targetId}/accounts/${personId}/adopt`, cookie, {
      reason: 'adopt',
    });
    expect(adopt.statusCode).toBe(409);
    expect(adopt.json().type).toContain('person-left-out');
    expect(adopt.json().detail).toBe('Seth Sander is left out of target "fmx.ssander.xyz". Include them again first.');
  });
});
