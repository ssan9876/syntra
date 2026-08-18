import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let readOnlyCookie: string;
let workflowId: string;
let applicationId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function elevated(login: string) {
  const signed = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const portal = signed.cookies.find((c) => c.name === 'syntra_session')!.value;
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
    const admin = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada',
    });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    await assignRole(tx, admin.id, (await createRole(tx, 'Owner', ALL_PERMISSIONS)).id);

    const reader = await createUser(tx, {
      login: 'reader',
      email: 'reader@acme.test',
      displayName: 'Rea',
    });
    await setPasswordHash(tx, reader.id, PASSWORD_HASH);
    await assignRole(
      tx,
      reader.id,
      (await createRole(tx, 'Reader', [PERMISSIONS.AUTOMATE_READ])).id,
    );

    const application = await tx.application.create({
      data: { tenantId: ctx.tenantId, name: 'Stats', slug: 'stats' },
    });
    applicationId = application.id;
  });

  adminCookie = await elevated('admin');
  readOnlyCookie = await elevated('reader');

  const workflow = await call('POST', '/api/admin/automate/workflows', {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });
  workflowId = workflow.json().id;
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  cookie = adminCookie,
) => {
  const headers = { host: ctx.host, cookie: `syntra_session=${cookie}` };
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

const productPayload = (over: Record<string, unknown> = {}) => ({
  name: 'Statistics licence',
  slug: 'statistics-licence',
  kind: 'application',
  grants: [{ resourceType: 'application', resourceId: applicationId }],
  audienceCondition: { all: [] },
  workflowId,
  formSchema: [],
  durationMode: 'permanent',
  status: 'active',
  ...over,
});

describe('products', () => {
  it('creates one and lists it', async () => {
    expect((await call('POST', '/api/admin/automate/products', productPayload())).statusCode).toBe(
      201,
    );
    const list = await call('GET', '/api/admin/automate/products');
    expect(list.json().products).toHaveLength(1);
  });

  it('turns a refused configuration into a 422 naming the code', async () => {
    const syncedGroupId = await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Corporate LDAP',
          type: 'ldap',
          config: {},
          secretName: 's/l',
        },
      });
      const group = await tx.group.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Domain Users',
          sourceId: source.id,
          sourceAnchor: 'g1',
        },
      });
      return group.id;
    });
    const response = await call(
      'POST',
      '/api/admin/automate/products',
      productPayload({
        slug: 'domain-users',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: syncedGroupId }],
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().type).toContain('group-is-synced');
    expect(response.json().detail).toContain('Corporate LDAP');
  });

  it('refuses a write from somebody holding only automate.read', async () => {
    const response = await call(
      'POST',
      '/api/admin/automate/products',
      productPayload({ slug: 'other' }),
      readOnlyCookie,
    );
    expect(response.statusCode).toBe(403);
  });

  it('allows a read from somebody holding only automate.read', async () => {
    expect((await call('GET', '/api/admin/automate/products', undefined, readOnlyCookie)).statusCode).toBe(
      200,
    );
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/automate/products',
      headers: { host: ctx.host },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('previews', () => {
  it('answers the audience preview with a count and a sample', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01T00:00:00Z'),
        },
      });
    });
    const response = await call('POST', '/api/admin/automate/products/audience-preview', {
      audienceCondition: { all: [] },
      limit: 5,
    });
    expect(response.json()).toMatchObject({ matched: 1, total: 1 });
  });

  it('answers the workflow resolution preview stage by stage', async () => {
    const personId = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01T00:00:00Z'),
        },
      });
      return person.id;
    });
    const response = await call('POST', '/api/admin/automate/workflows/resolution-preview', {
      workflowId,
      subjectPersonId: personId,
      productId: null,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stages).toEqual([]);
  });
});

describe('workflows', () => {
  it('turns a refused workflow into a 422 naming the field', async () => {
    const response = await call('POST', '/api/admin/automate/workflows', {
      name: 'Broken',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Manager',
          selector: 'manager',
          selectorConfig: {},
          quorum: 'any',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'remind',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().type).toContain('fallback-required');
  });

  it('refuses onTimeout: approve at the edge, before it reaches the domain', async () => {
    const response = await call('POST', '/api/admin/automate/workflows', {
      name: 'Auto',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Manager',
          selector: 'person',
          selectorConfig: { personId: '00000000-0000-0000-0000-000000000001' },
          quorum: 'any',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'approve',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('sweeps', () => {
  /**
   * A person with a contract, and one grant that has already ended.
   *
   * Without it the tenant has nothing to remove: the sweep previews with zero
   * actions, `requiresConfirmation` is false, and the FIRST call -- the one
   * sending `confirm: false` -- applies it. The second call then finds an
   * `applied` sweep, declines, and `confirmedByUserId` is still null, which is
   * what the plan's fixture asserted against. The case is named for a sweep
   * that needs confirming, so the tenant has to contain one.
   */
  async function somethingToSweep() {
    await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01T00:00:00Z'),
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId: ctx.tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: person.id,
          startsAt: new Date('2024-01-01T00:00:00Z'),
          endsAt: new Date('2024-06-01T00:00:00Z'),
          status: 'active',
        },
      });
    });
  }

  it('previews, refuses to apply without a confirmation, then applies with one', async () => {
    await somethingToSweep();
    const preview = await call('POST', '/api/admin/automate/sweeps');
    expect(preview.statusCode).toBe(201);
    const sweepId = preview.json().id;

    const unconfirmed = await call('POST', `/api/admin/automate/sweeps/${sweepId}/apply`, {
      confirm: false,
    });
    expect(unconfirmed.json().applied).toBe(0);

    const confirmed = await call('POST', `/api/admin/automate/sweeps/${sweepId}/apply`, {
      confirm: true,
    });
    expect(confirmed.statusCode).toBe(200);
    const sweep = await withTenant(ctx.tenantId, (tx) =>
      tx.expirySweep.findUniqueOrThrow({ where: { id: sweepId } }),
    );
    // The confirming user is recorded on the run. The scheduler never confirms
    // anything, and neither does an anonymous call.
    expect(sweep.confirmedByUserId).not.toBeNull();
  });

  it('refuses a sweep confirmation from somebody holding only automate.read', async () => {
    const preview = await call('POST', '/api/admin/automate/sweeps');
    const response = await call(
      'POST',
      `/api/admin/automate/sweeps/${preview.json().id}/apply`,
      { confirm: true },
      readOnlyCookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('does not show one tenant products to another', async () => {
    // The policy is what makes this empty, and the route never writes a tenant
    // filter of its own.
    await call('POST', '/api/admin/automate/products', productPayload());
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const products = await withTenant(other.id, (tx) => tx.product.findMany());
    expect(products).toEqual([]);
  });
});
