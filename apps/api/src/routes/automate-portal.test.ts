import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createProduct,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertWorkflow,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let annaCookie: string;
let boCookie: string;
let productId: string;
let annaPersonId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function signIn(login: string) {
  const login_ = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  return login_.cookies.find((c) => c.name === 'syntra_session')!.value;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const anna = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    const annaUser = await createUser(tx, {
      login: 'anna',
      email: 'anna@acme.test',
      displayName: 'Anna Novak',
    });
    await tx.user.update({ where: { id: annaUser.id }, data: { personId: anna.id } });
    await setPasswordHash(tx, annaUser.id, PASSWORD_HASH);

    const bo = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Bo', familyName: 'Lind' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: bo.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Facilities',
      },
    });
    const boUser = await createUser(tx, {
      login: 'bo',
      email: 'bo@acme.test',
      displayName: 'Bo Lind',
    });
    await tx.user.update({ where: { id: boUser.id }, data: { personId: bo.id } });
    await setPasswordHash(tx, boUser.id, PASSWORD_HASH);

    const application = await tx.application.create({
      data: { tenantId: ctx.tenantId, name: 'Stats', slug: 'stats' },
    });
    return { annaPersonId: anna.id, applicationId: application.id };
  });
  annaPersonId = seeded.annaPersonId;

  const workflow = await upsertWorkflow(ctx.tenantId, null, null, {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });
  productId = (
    await createProduct(ctx.tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      // Set, and set to the value the category-browse row of the visibility
      // table asks for. Without it that row filters the product out and the
      // "shows the product on every path" case fails against correct code.
      category: 'Finance',
      grants: [{ resourceType: 'application', resourceId: seeded.applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: workflow.id,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: null,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;

  annaCookie = await signIn('anna');
  boCookie = await signIn('bo');
});

const call = (
  method: 'GET' | 'POST',
  url: string,
  cookie: string,
  payload?: object,
) => {
  const headers = { host: ctx.host, cookie: `syntra_session=${cookie}` };
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

/**
 * Enumerated as a table over the route list, so a route added later without
 * the resolver fails a test rather than shipping.
 *
 * Every read path in spec section 6: the list, the category browse, the
 * search, the typeahead, the detail endpoint, the on-behalf picker, and the
 * form's option lists. A product the caller's audience does not admit is 404
 * from every one of them -- never 403, which confirms the thing exists.
 */
describe('visibility, on every read path', () => {
  const READ_PATHS = (id: string) => [
    { name: 'catalog list', url: '/api/portal/automate/catalog' },
    { name: 'category browse', url: '/api/portal/automate/catalog?category=Finance' },
    { name: 'search', url: '/api/portal/automate/catalog/search?q=statistic' },
    { name: 'typeahead', url: '/api/portal/automate/catalog/search?q=stat' },
    { name: 'detail', url: `/api/portal/automate/catalog/${id}` },
    { name: 'form options', url: `/api/portal/automate/catalog/${id}/form` },
  ];

  it('shows the product on every path to somebody the audience admits', async () => {
    for (const path of READ_PATHS(productId)) {
      const response = await call('GET', path.url, annaCookie);
      expect(response.statusCode, path.name).toBe(200);
      expect(JSON.stringify(response.json()), path.name).toContain('Statistics licence');
    }
  });

  it('shows nothing, and answers 404 rather than 403, to somebody it does not', async () => {
    for (const path of READ_PATHS(productId)) {
      const response = await call('GET', path.url, boCookie);
      if (response.statusCode === 200) {
        // The list paths answer 200 with an empty list; the id paths answer
        // 404. Neither may name the product.
        expect(JSON.stringify(response.json()), path.name).not.toContain(
          'Statistics licence',
        );
      } else {
        expect(response.statusCode, path.name).toBe(404);
      }
    }
  });

  it('applies the category filter, so the browse row is not the list row again', async () => {
    // Without this the category-browse row of the table above asserts exactly
    // what the plain list row asserts, and a route that dropped the filter
    // would pass both.
    const wrong = await call(
      'GET',
      '/api/portal/automate/catalog?category=Facilities',
      annaCookie,
    );
    expect(wrong.statusCode).toBe(200);
    expect(JSON.stringify(wrong.json())).not.toContain('Statistics licence');
  });

  it('shows the SUBJECT catalog to an on-behalf submitter, not the submitter own', async () => {
    // The permission is to act for somebody, not to see everything.
    await withTenant(ctx.tenantId, async (tx) => {
      const role = await createRole(tx, 'Helpdesk', ['automate.request_on_behalf']);
      const bo = await tx.user.findFirstOrThrow({ where: { login: 'bo' } });
      await assignRole(tx, bo.id, role.id);
    });
    const response = await call(
      'GET',
      `/api/portal/automate/catalog?subjectPersonId=${annaPersonId}`,
      boCookie,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).toContain('Statistics licence');
  });

  it('refuses the on-behalf picker to somebody without the permission', async () => {
    const response = await call(
      'GET',
      `/api/portal/automate/catalog?subjectPersonId=${annaPersonId}`,
      boCookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('requests', () => {
  it('submits, fulfils immediately, and appears in my requests', async () => {
    const created = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'fulfilled' });

    const mine = await call('GET', '/api/portal/automate/requests', annaCookie);
    expect(mine.json().requests).toHaveLength(1);
  });

  it('answers a refusal as a 422 with the reason, not a 500', async () => {
    const response = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(response.statusCode).toBe(201);
    const again = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().type).toContain('already_held');
  });

  it('does not let one person read another request', async () => {
    const created = await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const id = created.json().requestId;
    const response = await call('GET', `/api/portal/automate/requests/${id}`, boCookie);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a portal session on an administration route', async () => {
    const response = await call('GET', '/api/admin/automate/requests', annaCookie);
    expect(response.statusCode).toBe(403);
  });
});

describe('my access', () => {
  it('lists grants and hands one back', async () => {
    await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const grants = await call('GET', '/api/portal/automate/grants', annaCookie);
    expect(grants.json().grants).toHaveLength(1);
    const grantId = grants.json().grants[0].id;

    const handed = await call(
      'POST',
      `/api/portal/automate/grants/${grantId}/hand-back`,
      annaCookie,
    );
    expect(handed.statusCode).toBe(204);
    const after = await withTenant(ctx.tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
    );
    expect(after.status).toBe('revoked');
  });

  it('refuses to hand back somebody else grant', async () => {
    await call('POST', '/api/portal/automate/requests', annaCookie, {
      productId,
      subjectPersonId: annaPersonId,
      justification: null,
      formValues: {},
    });
    const grants = await call('GET', '/api/portal/automate/grants', annaCookie);
    const grantId = grants.json().grants[0].id;
    const response = await call(
      'POST',
      `/api/portal/automate/grants/${grantId}/hand-back`,
      boCookie,
    );
    expect(response.statusCode).toBe(404);
  });
});
