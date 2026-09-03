import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import {
  buildTestApp,
  createFakeScheduler,
  type FakeScheduler,
} from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let scheduler: FakeScheduler;
let targetId: string;

const PASSWORD = 'a-long-enough-password';
// Hashed once for the file: Argon2id is deliberately expensive and has no
// business inside a per-test path, let alone a transaction.
const PASSWORD_HASH = await hashPassword(PASSWORD);

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profile = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,DC=acme,DC=test',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly',
};

/** A signed-in, elevated administrative session holding exactly `permissions`. */
async function adminCookie(permissions: Permission[]): Promise<string> {
  const login = `admin-${permissions.join('-')}`;
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login,
      email: `${permissions.join('.')}@acme.test`,
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `R-${permissions.join('-')}`, permissions);
    await assignRole(tx, user.id, role.id);
  });

  const signIn = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const token = signIn.cookies.find((c) => c.name === 'syntra_session')!.value;
  const elevated = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${elevated.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const put = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PUT',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const patch = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

const del = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  scheduler = createFakeScheduler();
  ctx = await buildTestApp({ scheduler: () => scheduler });
  await ctx.app.ready();
});

const create = async (cookie: string) => {
  const response = await post('/api/admin/targets', cookie, {
    name: 'Acme AD',
    type: 'activeDirectory',
    config,
    bindPassword: 'super-secret-bind',
  });
  targetId = response.json().id;
  return response;
};

const manager = () =>
  adminCookie([PERMISSIONS.PROVISION_MANAGE, PERMISSIONS.PROVISION_READ]);

describe('POST /api/admin/targets', () => {
  it('creates a target and never echoes the credential', async () => {
    const cookie = await manager();
    const response = await create(cookie);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('super-secret-bind');
  });

  it('refuses a plaintext transport with a 400 rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.PROVISION_MANAGE]);
    const response = await post('/api/admin/targets', cookie, {
      name: 'Plain',
      config: { ...config, tlsMode: 'plain', url: 'ldap://dc.acme.test:389' },
      bindPassword: 'x',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses without provision.manage', async () => {
    // Reading who holds what in the finance system is a reasonable thing to
    // grant an auditor. Changing a threshold is not, and lowering a threshold
    // is functionally the same as approving everything it would have caught.
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await post('/api/admin/targets', cookie, {
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated caller before it looks at the body', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/targets',
      headers: { host: ctx.host },
      payload: { name: 'Acme AD', config, bindPassword: 'secret' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/admin/targets', () => {
  it('lists targets with their skip history and never the credential', async () => {
    const manage = await manager();
    await create(manage);
    await withTenant(ctx.tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          consecutiveSkippedRuns: 3,
          lastSkippedAt: new Date(),
          lastSkipReason: 'a run is awaiting review',
        },
      }),
    );

    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await get('/api/admin/targets', cookie);
    const body = response.json().targets;
    // Ruling P4: the list is where somebody looks, so the list carries it.
    expect(body[0].consecutiveSkippedRuns).toBe(3);
    expect(body[0].lastSkipReason).toContain('awaiting review');
    expect(body[0].enforcementMode).toBe('additive');
    expect(JSON.stringify(body)).not.toContain('super-secret-bind');
    expect(JSON.stringify(body)).not.toContain('secretName');
  });

  it('does not offer a setting nothing honours', async () => {
    // `TargetSystem.concurrency` is stored, validated and defaulted, and the
    // apply loop is sequential. A knob on a screen that does nothing is worse
    // than an absent one: it gets changed, and something else gets blamed.
    const manage = await manager();
    await create(manage);
    const listed = (await get('/api/admin/targets', manage)).json().targets;
    expect(JSON.stringify(listed)).not.toContain('concurrency');

    const rejected = await patch(`/api/admin/targets/${targetId}`, manage, {
      concurrency: 8,
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('refuses without provision.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.IDENTITY_READ]);
    expect((await get('/api/admin/targets', cookie)).statusCode).toBe(403);
  });
});

describe('PATCH and DELETE /api/admin/targets/:id', () => {
  it('saves a threshold and a ladder setting', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await patch(`/api/admin/targets/${targetId}`, cookie, {
      preHireDays: 14,
      thresholds: { createAccountThresholdPercent: 35 },
      ladder: { disableGraceDays: 7, archiveAfterDays: 30 },
    });
    expect(response.statusCode).toBe(204);
    const saved = (await get(`/api/admin/targets/${targetId}`, cookie)).json();
    expect(saved).toMatchObject({
      preHireDays: 14,
      createAccountThresholdPercent: 35,
      disableGraceDays: 7,
      archiveAfterDays: 30,
    });
  });

  it('answers 404 for a target that is not there, not 500', async () => {
    const cookie = await manager();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (await patch(`/api/admin/targets/${missing}`, cookie, { preHireDays: 1 })).statusCode,
    ).toBe(404);
    expect((await del(`/api/admin/targets/${missing}`, cookie)).statusCode).toBe(404);
    expect((await get(`/api/admin/targets/${missing}`, cookie)).statusCode).toBe(404);
  });

  it('refuses to delete a target that still holds accounts, and says how many', async () => {
    const cookie = await manager();
    await create(cookie);
    await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId: ctx.tenantId,
          targetSystemId: targetId,
          personId: person.id,
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
    });
    const response = await del(`/api/admin/targets/${targetId}`, cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json().counts.accounts).toBe(1);

    const confirmed = await del(`/api/admin/targets/${targetId}?confirm=true`, cookie);
    expect(confirmed.statusCode).toBe(204);
  });
});

describe('rules', () => {
  const seedEntitlement = (over: Record<string, unknown> = {}) =>
    withTenant(ctx.tenantId, async (tx) =>
      (
        await tx.entitlement.create({
          data: {
            tenantId: ctx.tenantId,
            targetSystemId: targetId,
            externalId: 'guid-finance',
            type: 'group',
            displayName: 'Finance',
            ...over,
          },
        })
      ).id,
    );

  const rule = (over: Record<string, unknown> = {}) => ({
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
    ...over,
  });

  it('saves a rule and lists it back with its entitlements', async () => {
    const cookie = await manager();
    await create(cookie);
    const entitlementId = await seedEntitlement();
    const saved = await put(`/api/admin/targets/${targetId}/rules`, cookie, {
      ...rule({ entitlementIds: [entitlementId] }),
    });
    expect(saved.statusCode).toBe(200);

    const listed = (await get(`/api/admin/targets/${targetId}/rules`, cookie)).json();
    expect(listed.rules).toHaveLength(1);
    expect(listed.rules[0].entitlements).toHaveLength(1);

    const removed = await del(`/api/admin/rules/${saved.json().id}`, cookie);
    expect(removed.statusCode).toBe(204);
    expect(
      (await get(`/api/admin/targets/${targetId}/rules`, cookie)).json().rules,
    ).toEqual([]);
  });

  it('refuses an operator the rule language does not have, with a 400', async () => {
    // `businessRuleRequestSchema` cannot see core's closed operator set, so a
    // `regex` leaf parses at the transport boundary and `evaluateCondition`
    // then returns undefined for it -- a rule that previews as matching
    // nobody and saves as one that grants nothing. The second parse is what
    // makes it a message.
    const cookie = await manager();
    await create(cookie);
    const response = await put(
      `/api/admin/targets/${targetId}/rules`,
      cookie,
      rule({ condition: { field: 'contract.department', op: 'regex', value: '^a' } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses a rule body carrying a key it does not know', async () => {
    // The transport schema is `.strict()` and core's `businessRuleSchema` is
    // not, so this is the one thing only the contract boundary can refuse. A
    // misspelled field that is silently dropped is a rule saved with a
    // property the author believes they set.
    const cookie = await manager();
    await create(cookie);
    const response = await put(`/api/admin/targets/${targetId}/rules`, cookie, {
      ...rule(),
      grantsAcount: true,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a condition nested past the cap without a 500', async () => {
    // The exposure Task 12 closed only half of: `conditionRequestSchema` is a
    // second `z.lazy`, parsed at the HTTP edge BEFORE core's cap runs, so
    // without the iterative walk in front of it this is a RangeError from
    // inside Zod and a bare 500 -- on a body the caller chooses the size of,
    // at the one endpoint an administrator uses to fix rules.
    //
    // The body is assembled as TEXT and sent with a content type, rather than
    // handed to `inject` as an object: light-my-request stringifies an object
    // payload itself and overflows its own stack at this depth, which would
    // make the test fail for a reason that has nothing to do with the server.
    // V8's JSON.parse walks 20,000 levels without complaint, so what Fastify
    // hands the schema is the real thing.
    const cookie = await manager();
    await create(cookie);
    const depth = 20_000;
    const body =
      '{"name":"Deep","grantsAccount":true,"enabled":true,"entitlementIds":[],"condition":' +
      '{"not":'.repeat(depth) +
      '{"field":"contract.department","op":"isNotEmpty"}' +
      '}'.repeat(depth) +
      '}';
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/targets/${targetId}/rules`,
      headers: { host: ctx.host, cookie, 'content-type': 'application/json' },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('levels deep');
  });

  it('refuses an entitlement belonging to another target, with a 400 rather than a 500', async () => {
    const cookie = await manager();
    await create(cookie);
    const otherTargetId = (
      await post('/api/admin/targets', cookie, {
        name: 'Other AD',
        type: 'activeDirectory',
        config,
        bindPassword: 'super-secret-bind',
      })
    ).json().id;
    const entitlementId = await seedEntitlement();

    const response = await put(
      `/api/admin/targets/${otherTargetId}/rules`,
      cookie,
      rule({ entitlementIds: [entitlementId] }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('does not belong to this target');
  });

  it('previews the blast radius of a rule that has not been saved', async () => {
    const cookie = await manager();
    await create(cookie);
    const entitlementId = await seedEntitlement();
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
          department: 'Finance',
        },
      });
    });

    const response = await post(
      `/api/admin/targets/${targetId}/rules/impact`,
      cookie,
      rule({ entitlementIds: [entitlementId] }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      matchedPersons: 1,
      totalPersons: 1,
      wouldGrant: 1,
      wouldRevoke: 0,
    });
    // Nothing was written: the point of the preview.
    expect(
      (await get(`/api/admin/targets/${targetId}/rules`, cookie)).json().rules,
    ).toEqual([]);
  });

  it('refuses the impact preview without provision.manage', async () => {
    const manage = await manager();
    await create(manage);
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await post(
      `/api/admin/targets/${targetId}/rules/impact`,
      cookie,
      rule(),
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('the account profile', () => {
  it('saves, reads back and previews against a real person', async () => {
    const cookie = await manager();
    await create(cookie);
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
          department: 'Finance',
        },
      });
      return person.id;
    });

    expect(
      (await put(`/api/admin/targets/${targetId}/profile`, cookie, profile)).statusCode,
    ).toBe(204);
    expect(
      (await get(`/api/admin/targets/${targetId}/profile`, cookie)).json()
        .correlationKeyTemplate,
    ).toBe(profile.correlationKeyTemplate);

    const preview = await post(
      `/api/admin/targets/${targetId}/profile/preview`,
      cookie,
      { profile, personId },
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      correlationKey: 'anna.novak',
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      attributes: { displayName: 'Anna Novak' },
    });
  });

  it('previews the container from typed facts, before any person exists', async () => {
    const cookie = await manager();
    await create(cookie);
    await put(`/api/admin/targets/${targetId}/profile`, cookie, profile);

    // No personId anywhere: that is the point. The onboarding form asks where
    // somebody WILL land while it is still free to correct, which is
    // necessarily before they have been written.
    const response = await post(
      `/api/admin/targets/${targetId}/profile/preview-container`,
      cookie,
      { givenName: 'Anna', familyName: 'Novak', department: 'Finance' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      fallbackUsed: false,
      missing: [],
    });
  });

  it('names the fallback and the missing placeholder when a field is blank', async () => {
    const cookie = await manager();
    await create(cookie);
    await put(`/api/admin/targets/${targetId}/profile`, cookie, profile);

    const response = await post(
      `/api/admin/targets/${targetId}/profile/preview-container`,
      cookie,
      { givenName: 'Anna', familyName: 'Novak', department: '' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fallbackUsed: true,
      missing: ['contract.department'],
    });
  });

  it('answers 404 rather than an empty preview when no profile is configured', async () => {
    const cookie = await manager();
    await create(cookie);

    const response = await post(
      `/api/admin/targets/${targetId}/profile/preview-container`,
      cookie,
      { givenName: 'Anna', familyName: 'Novak' },
    );

    expect(response.statusCode).toBe(404);
  });

  it('is readable by a caller who may read provisioning but not change it', async () => {
    const manage = await manager();
    await create(manage);
    await put(`/api/admin/targets/${targetId}/profile`, manage, profile);

    // provision.read, not provision.manage: asking where an account WOULD go
    // is a read. The onboarding page already needs provision.read to list
    // targets at all, so the hint asks for nothing new.
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await post(
      `/api/admin/targets/${targetId}/profile/preview-container`,
      cookie,
      { givenName: 'Anna', familyName: 'Novak', department: 'Finance' },
    );

    expect(response.statusCode).toBe(200);
  });

  it('refuses a profile that would write an attribute the guard cannot count', async () => {
    // `update_account` carries the complete managed set and is deliberately
    // absent from GUARDED_ACTION_TYPES, so a profile templating
    // `userAccountControl` disables every managed account without the guard,
    // the ladder or the review screen ever seeing it.
    const cookie = await manager();
    await create(cookie);
    const response = await put(`/api/admin/targets/${targetId}/profile`, cookie, {
      ...profile,
      attributeTemplates: { userAccountControl: '514' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('userAccountControl');
  });

  it('refuses a profile body carrying a key it does not know', async () => {
    // Same reasoning as the rule body: `accountProfileSchema` in core is not
    // strict, so a misspelled `fallbackContianer` would be dropped and the
    // profile saved without the fallback its author thought they set.
    const cookie = await manager();
    await create(cookie);
    const response = await put(`/api/admin/targets/${targetId}/profile`, cookie, {
      ...profile,
      fallbackContianer: 'OU=Users,DC=acme,DC=test',
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 before there is a profile', async () => {
    const cookie = await manager();
    await create(cookie);
    expect(
      (await get(`/api/admin/targets/${targetId}/profile`, cookie)).statusCode,
    ).toBe(404);
  });
});

describe('POST /api/admin/targets/:id/runs', () => {
  it('enqueues rather than running the read in the request', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await post(`/api/admin/targets/${targetId}/runs`, cookie);
    // 202: a full target read outlasts a proxy timeout, which is the shape
    // Directory Sync's synchronous `Run now` still has and this deliberately
    // does not.
    expect(response.statusCode).toBe(202);
  });

  it('answers 503 rather than pretending, when no scheduler is running', async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
    const cookie = await manager();
    await create(cookie);
    const response = await post(`/api/admin/targets/${targetId}/runs`, cookie);
    expect(response.statusCode).toBe(503);
  });
});

describe('POST /api/admin/targets/:id/runs/:runId/apply', () => {
  const seedRun = async (over: Record<string, unknown>) =>
    withTenant(ctx.tenantId, async (tx) =>
      (
        await tx.provisionRun.create({
          data: { tenantId: ctx.tenantId, targetSystemId: targetId, ...over },
        })
      ).id,
    );

  it('refuses to apply a blocked run without confirm', async () => {
    const cookie = await manager();
    await create(cookie);
    const runId = await seedRun({
      status: 'blocked',
      requiresConfirmation: true,
      blockedReason: 'first run',
    });
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: false },
    );
    expect(response.statusCode).toBe(409);
    // The `type` as well as the prose: RFC 9457 says the type is the
    // machine-readable half, and "needs confirmation" and "cannot be confirmed
    // away" are two different answers whose prose both contains "confirm".
    expect(response.json().type).toContain('run-needs-confirmation');
    expect(response.json().detail).toContain('confirm');
  });

  it('refuses to apply a run blocked for an unconfirmable reason even with confirm', async () => {
    const cookie = await manager();
    await create(cookie);
    const runId = await seedRun({
      status: 'blocked',
      requiresConfirmation: false,
      blockedReason: 'the target returned no accounts at all',
    });
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: true },
    );
    // There is nothing an administrator could usefully confirm about a
    // directory that may simply be unreachable.
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toContain('run-unconfirmable');
    expect(response.json().detail).toContain('cannot be confirmed');
  });

  it('refuses a run that belongs to another target', async () => {
    // Without the ownership check the run id alone decides, and the claim and
    // paired-sync enqueue below it are then performed against the target named
    // in the URL rather than the one the run belongs to.
    const cookie = await manager();
    await create(cookie);
    const runId = await seedRun({ status: 'previewed' });
    const otherTargetId = (
      await post('/api/admin/targets', cookie, {
        name: 'Other AD',
        type: 'activeDirectory',
        config,
        bindPassword: 'super-secret-bind',
      })
    ).json().id;

    expect(
      (
        await post(
          `/api/admin/targets/${otherTargetId}/runs/${runId}/apply`,
          cookie,
          { confirm: false },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/admin/targets/${otherTargetId}/runs/${runId}`, cookie)).statusCode,
    ).toBe(404);
  });

  it('refuses to apply a run that has already finished', async () => {
    const cookie = await manager();
    await create(cookie);
    const runId = await seedRun({ status: 'applied' });
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: true },
    );
    expect(response.statusCode).toBe(409);
  });

  it('refuses to apply without provision.manage', async () => {
    const manage = await manager();
    await create(manage);
    const runId = await seedRun({ status: 'previewed' });
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await post(
      `/api/admin/targets/${targetId}/runs/${runId}/apply`,
      cookie,
      { confirm: true },
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('run detail and drift', () => {
  it('returns the actions in sequence order, each naming its person', async () => {
    const cookie = await manager();
    await create(cookie);
    const { runId } = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const run = await tx.provisionRun.create({
        data: { tenantId: ctx.tenantId, targetSystemId: targetId, status: 'previewed' },
      });
      await tx.provisionAction.createMany({
        data: [
          {
            tenantId: ctx.tenantId,
            runId: run.id,
            actionType: 'grant_entitlement',
            personId: person.id,
            sequence: 2,
          },
          {
            tenantId: ctx.tenantId,
            runId: run.id,
            actionType: 'create_account',
            personId: person.id,
            sequence: 1,
          },
        ],
      });
      return { runId: run.id };
    });

    const response = await get(
      `/api/admin/targets/${targetId}/runs/${runId}`,
      cookie,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // `createdAt` is transaction start time and is identical across every row
    // one `createMany` wrote, so it orders nothing.
    expect(body.actions.map((a: { actionType: string }) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    // `ProvisionAction` has no relation to `Person`; the name is joined in
    // memory, and "what is about to happen to Anna" is the question a reviewer
    // is asking.
    expect(body.actions[0].person.givenName).toBe('Anna');
  });

  it('lists drift and acknowledges a finding', async () => {
    const cookie = await manager();
    await create(cookie);
    const findingId = await withTenant(ctx.tenantId, async (tx) =>
      (
        await tx.driftFinding.create({
          data: {
            tenantId: ctx.tenantId,
            targetSystemId: targetId,
            kind: 'unmanaged_entitlement',
            detail: {},
            fingerprint: 'f1',
          },
        })
      ).id,
    );

    const listed = await get(`/api/admin/targets/${targetId}/drift?status=open`, cookie);
    expect(listed.json().findings).toHaveLength(1);

    expect(
      (await patch(`/api/admin/drift/${findingId}`, cookie, { status: 'acknowledged' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await get(`/api/admin/targets/${targetId}/drift?status=open`, cookie)).json()
        .findings,
    ).toEqual([]);

    // And it is audited. Acknowledging a finding is a person saying "this
    // account holds access Syntra never granted, and that is fine", which is
    // exactly the decision an auditor needs a name against — and this route
    // used to be the only write in the package with no audit entry at all.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.drift.acknowledge' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).not.toBeNull();
    expect(events[0]!.targetId).toBe(findingId);
    expect(events[0]!.payload).toMatchObject({
      changed: ['status'],
      status: { from: 'open', to: 'acknowledged' },
      kind: 'unmanaged_entitlement',
    });
    // The finding's own detail is not copied into the audit log: the row holds
    // it, and this is not the second place a target's object names should live.
    expect(events[0]!.payload).not.toHaveProperty('detail');
    expect(events[0]!.payload).not.toHaveProperty('subjectAnchor');
  });

  it('answers 404 for a drift finding that is not there, not 500', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await patch(
      '/api/admin/drift/00000000-0000-4000-8000-000000000000',
      cookie,
      { status: 'resolved' },
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('malformed ids', () => {
  /**
   * A 400, not a 500, on every id-bearing provisioning route.
   *
   * These four route files reached the id with `request.params as { id: string }`
   * — the same suppression as `as never`, wearing a plausible type — so a
   * malformed id travelled to PostgreSQL and came back out of the catch-all as
   * a bare 500, where every pre-existing admin route answers 400. One case per
   * route file, and each of the three param shapes.
   */
  it('answers 400 rather than 500 on every id-bearing route', async () => {
    const cookie = await manager();
    await create(cookie);

    const cases: [string, Promise<{ statusCode: number }>][] = [
      ['GET target', get('/api/admin/targets/not-a-uuid', cookie)],
      ['GET rules', get('/api/admin/targets/not-a-uuid/rules', cookie)],
      ['DELETE rule', del('/api/admin/rules/not-a-uuid', cookie)],
      ['GET profile', get('/api/admin/targets/not-a-uuid/profile', cookie)],
      ['GET runs', get('/api/admin/targets/not-a-uuid/runs', cookie)],
      ['GET one run', get(`/api/admin/targets/${targetId}/runs/not-a-uuid`, cookie)],
      [
        'PATCH drift',
        patch('/api/admin/drift/not-a-uuid', cookie, { status: 'resolved' }),
      ],
    ];

    const statuses = await Promise.all(
      cases.map(async ([name, response]) => [name, (await response).statusCode]),
    );
    expect(statuses).toEqual(cases.map(([name]) => [name, 400]));
  });
});

describe('GET /api/admin/persons/:id/access', () => {
  it('answers why this person holds this', async () => {
    const manage = await manager();
    await create(manage);
    const personId = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId: ctx.tenantId,
          targetSystemId: targetId,
          externalId: 'guid-finance',
          dn: 'CN=Finance,OU=Groups,DC=acme,DC=test',
          type: 'group',
          displayName: 'Finance',
        },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId: ctx.tenantId,
          targetSystemId: targetId,
          personId: person.id,
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: account.id,
          entitlementId: entitlement.id,
          origin: 'discovered',
        },
      });
      return person.id;
    });

    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await get(`/api/admin/persons/${personId}/access`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts[0].entitlements[0].displayName).toBe('Finance');
  });

  it('refuses without provision.read, even to somebody who can read persons', async () => {
    const cookie = await adminCookie([PERMISSIONS.IDENTITY_READ]);
    const response = await get(
      '/api/admin/persons/00000000-0000-0000-0000-000000000000/access',
      cookie,
    );
    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for a person who does not exist, not an empty list', async () => {
    // "This person holds nothing" and "there is no such person" are opposite
    // answers to an auditor.
    const cookie = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await get(
      '/api/admin/persons/00000000-0000-4000-8000-000000000000/access',
      cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('does not shadow /persons/:id', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.IDENTITY_READ,
      PERMISSIONS.PROVISION_READ,
    ]);
    const personId = await withTenant(ctx.tenantId, async (tx) =>
      (
        await tx.person.create({
          data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak' },
        })
      ).id,
    );
    expect((await get(`/api/admin/persons/${personId}`, cookie)).json().givenName).toBe(
      'Anna',
    );
    expect((await get(`/api/admin/persons/${personId}/access`, cookie)).json()).toEqual({
      personId,
      accounts: [],
    });
  });
});

describe('the drift list parses its filters', () => {
  /**
   * `status` and `kind` were cast off the query string into a Prisma `where`,
   * so `?status=open&status=acknowledged` arrived as an array and answered
   * 500 for a caller's mistake.
   */
  it('answers 400, not 500, for a repeated status', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await get(
      `/api/admin/targets/${targetId}/drift?status=open&status=acknowledged`,
      cookie,
    );
    expect(response.statusCode).toBe(400);
  });

  it('answers 400, not 500, for a kind it does not know', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await get(`/api/admin/targets/${targetId}/drift?kind=nope`, cookie);
    expect(response.statusCode).toBe(400);
  });

  it('answers 400 for a target deletion confirmed with anything but the word true', async () => {
    const cookie = await manager();
    await create(cookie);
    const response = await del(`/api/admin/targets/${targetId}?confirm=yes`, cookie);
    expect(response.statusCode).toBe(400);
  });
});
