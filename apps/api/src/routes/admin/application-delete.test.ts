import { randomUUID } from 'node:crypto';
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
  issueApiToken,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

/**
 * `DELETE /api/admin/applications/:id`: who may, what it takes with it, what
 * it must leave alone, and that the entity ID it held can be registered again.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let readerCookie: string;
let portalCookie: string;
let employeeId: string;
let adminId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

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

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: object,
) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });

const del = (id: string, confirm: string, cookie = adminCookie) =>
  call('DELETE', `/api/admin/applications/${id}`, cookie, { confirm });

const db = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx.tenantId, fn);

async function fromCatalog(key: string, variables: Record<string, string>) {
  const res = await call('POST', '/api/admin/applications/from-catalog', adminCookie, { key, variables });
  expect(res.statusCode).toBe(201);
  const applicationId = res.json().applicationId as string;
  const row = await db((tx) => tx.application.findUniqueOrThrow({ where: { id: applicationId } }));
  return row;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await db(async (tx) => {
    const admin = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Ada' });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    await assignRole(tx, admin.id, (await createRole(tx, 'Owner', ALL_PERMISSIONS)).id);
    adminId = admin.id;

    const reader = await createUser(tx, { login: 'reader', email: 'reader@acme.test', displayName: 'Rea' });
    await setPasswordHash(tx, reader.id, PASSWORD_HASH);
    await assignRole(tx, reader.id, (await createRole(tx, 'Reader', [PERMISSIONS.ACCESS_READ])).id);

    const employee = await createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' });
    await setPasswordHash(tx, employee.id, PASSWORD_HASH);
    employeeId = employee.id;
  });

  adminCookie = await elevated('admin');
  readerCookie = await elevated('reader');
  portalCookie = await signIn('jdoe');
});

/** Ages every console session past the step-up window. */
const ageAdminSessions = (minutes: number) =>
  db((tx) =>
    tx.session.updateMany({
      where: { scope: 'admin' },
      data: { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
    }),
  );

describe('who may delete an application', () => {
  it('refuses a caller without access.manage', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    const res = await del(app.id, app.name, readerCookie);
    expect(res.statusCode).toBe(403);
    expect(await db((tx) => tx.application.count({ where: { id: app.id } }))).toBe(1);
  });

  it('demands a fresh elevation, and audits the refusal', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    await ageAdminSessions(11);

    const res = await del(app.id, app.name);
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/step-up-required$/);
    expect(await db((tx) => tx.application.count({ where: { id: app.id } }))).toBe(1);

    const refusal = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'application.deleted', outcome: 'failure' } }),
    );
    expect(refusal.payload).toMatchObject({ reason: 'step_up_required' });
  });

  it('refuses a machine token, whatever it holds', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    const token = await db(async (tx) => {
      const svc = await createUser(tx, { login: 'svc', email: 'svc@acme.test', displayName: 'Service' });
      await assignRole(tx, svc.id, (await createRole(tx, 'Svc', ALL_PERMISSIONS)).id);
      return (await issueApiToken(tx, { userId: svc.id, name: 't', scopes: [], expiresAt: null, createdBy: null }))
        .token;
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applications/${app.id}`,
      headers: { host: ctx.host, authorization: `Bearer ${token}` },
      payload: { confirm: app.name },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/token-not-accepted$/);

    // The same token may still read and edit the application: only the
    // delete is refused.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applications',
      headers: { host: ctx.host, authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(await db((tx) => tx.application.count({ where: { id: app.id } }))).toBe(1);
  });

  it('refuses a name that does not match, and removes nothing', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });

    for (const typed of ['', 'slack-wrong', app.name.toUpperCase()]) {
      const res = await del(app.id, typed);
      expect(res.statusCode, typed).toBe(400);
      expect(res.json().type).toMatch(/confirm-mismatch$/);
    }
    expect(await db((tx) => tx.application.count({ where: { id: app.id } }))).toBe(1);
    expect(await db((tx) => tx.samlConfig.count({ where: { applicationId: app.id } }))).toBe(1);

    // A body with no confirmation at all is a schema failure, not a delete.
    const bare = await call('DELETE', `/api/admin/applications/${app.id}`, adminCookie);
    expect(bare.statusCode).toBe(400);
  });

  it('answers 404 for an application that is not there, including the second time', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    expect((await del(app.id, app.name)).statusCode).toBe(200);

    const again = await del(app.id, app.name);
    expect(again.statusCode).toBe(404);
    expect((await del(randomUUID(), 'anything')).statusCode).toBe(404);
  });
});

describe('what a delete removes', () => {
  it('removes a SAML application and everything that is only its own', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    const entityId = (await db((tx) => tx.samlConfig.findUniqueOrThrow({ where: { applicationId: app.id } })))
      .spEntityId;

    const person = await db(async (tx) => {
      await assignApplication(tx, app.id, { type: 'user', id: employeeId });
      await tx.claimMapping.create({
        data: {
          tenantId: ctx.tenantId,
          applicationId: app.id,
          protocol: 'saml',
          claimName: 'department',
          sourceKind: 'literal',
          literalValue: 'Sales',
        },
      });
      await tx.samlSsoSession.create({
        data: {
          tenantId: ctx.tenantId,
          sessionId: randomUUID(),
          applicationId: app.id,
          nameId: 'j@acme.test',
          sessionIndex: 'idx-1',
        },
      });
      await tx.samlAuthnRequest.create({
        data: {
          tenantId: ctx.tenantId,
          applicationId: app.id,
          handle: 'parked',
          acsUrl: 'https://acme.slack.com/sso/saml',
          browserBinding: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      await tx.authAttempt.create({
        data: {
          tenantId: ctx.tenantId,
          userId: employeeId,
          tokenHash: `attempt-${randomUUID()}`,
          applicationId: app.id,
          requiredOutcome: 'require_mfa',
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const owner = await tx.person.create({ data: { tenantId: ctx.tenantId, givenName: 'Fin', familyName: 'Owner' } });
      await tx.resourceOwner.create({
        data: { tenantId: ctx.tenantId, resourceType: 'application', resourceId: app.id, ownerPersonId: owner.id },
      });
      await tx.resourceClassification.create({
        data: { tenantId: ctx.tenantId, systemId: 'syntra', resourceKind: 'application', resourceId: app.id, privileged: true },
      });
      const fn = await tx.businessFunction.create({
        data: { tenantId: ctx.tenantId, name: 'Pay suppliers', ownerPersonId: owner.id },
      });
      await tx.businessFunctionResource.create({
        data: { tenantId: ctx.tenantId, functionId: fn.id, systemId: 'syntra', resourceKind: 'application', resourceId: app.id },
      });
      return owner;
    });

    // Shared things, counted before.
    const shared = () =>
      db(async (tx) => ({
        signingKeys: await tx.signingKey.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
        users: await tx.user.count(),
        groups: await tx.group.count(),
        persons: await tx.person.count(),
        functions: await tx.businessFunction.count(),
      }));
    const before = await shared();
    expect(before.signingKeys.length).toBeGreaterThan(0);

    const res = await del(app.id, app.name);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { id: app.id, name: app.name, assignments: 1 } });

    const left = await db(async (tx) => ({
      application: await tx.application.count({ where: { id: app.id } }),
      samlConfig: await tx.samlConfig.count({ where: { applicationId: app.id } }),
      claimMappings: await tx.claimMapping.count({ where: { applicationId: app.id } }),
      assignments: await tx.appAssignment.count({ where: { applicationId: app.id } }),
      samlSessions: await tx.samlSsoSession.count({ where: { applicationId: app.id } }),
      parked: await tx.samlAuthnRequest.count({ where: { applicationId: app.id } }),
      attempts: await tx.authAttempt.count({ where: { applicationId: app.id } }),
      owners: await tx.resourceOwner.count({ where: { resourceId: app.id } }),
      classifications: await tx.resourceClassification.count({ where: { resourceId: app.id } }),
      functionResources: await tx.businessFunctionResource.count({ where: { resourceId: app.id } }),
    }));
    expect(left).toEqual({
      application: 0,
      samlConfig: 0,
      claimMappings: 0,
      assignments: 0,
      samlSessions: 0,
      parked: 0,
      attempts: 0,
      owners: 0,
      classifications: 0,
      functionResources: 0,
    });

    // The signing key, the people and the business function are the
    // tenant's, not the application's.
    expect(await shared()).toEqual(before);
    expect(await db((tx) => tx.person.count({ where: { id: person.id } }))).toBe(1);

    const event = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'application.deleted', outcome: 'success' } }),
    );
    expect(event.targetId).toBe(app.id);
    expect(event.actorUserId).toBe(adminId);
    expect(event.payload).toMatchObject({
      name: app.name,
      protocol: 'saml',
      entityId,
      clientId: null,
      catalogKey: 'slack',
      assignments: 1,
      revoked: { samlSessions: 1, pendingSamlRequests: 1, pendingSignIns: 1 },
      governanceRowsRemoved: 3,
    });
  });

  it('removes an OIDC client and revokes what was issued to it, and only to it', async () => {
    const app = await fromCatalog('grafana', { host: 'grafana.acme.test' });
    const other = await fromCatalog('grafana', { host: 'grafana2.acme.test' }).catch(() => null);
    const client = await db((tx) => tx.oidcClient.findUniqueOrThrow({ where: { applicationId: app.id } }));
    const otherClientId = other
      ? (await db((tx) => tx.oidcClient.findUniqueOrThrow({ where: { applicationId: other.id } }))).clientId
      : 'some-other-client';

    await db(async (tx) => {
      for (const [model, clientId] of [
        ['AccessToken', client.clientId],
        ['RefreshToken', client.clientId],
        ['Grant', client.clientId],
        ['AccessToken', otherClientId],
      ] as const) {
        await tx.oidcArtifact.create({
          data: {
            tenantId: ctx.tenantId,
            model,
            artifactId: randomUUID(),
            accountId: employeeId,
            payload: { clientId, accountId: employeeId },
          },
        });
      }
      await tx.refreshToken.create({
        data: {
          tenantId: ctx.tenantId,
          userId: employeeId,
          tokenHash: `rt-${randomUUID()}`,
          clientId: client.clientId,
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await tx.authorizationDecision.create({
        data: {
          tenantId: ctx.tenantId,
          userId: employeeId,
          clientId: client.clientId,
          interactionUid: 'uid-1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await tx.logoutDelivery.create({
        data: { tenantId: ctx.tenantId, clientId: client.id, userId: employeeId, nextAttemptAt: new Date() },
      });
    });

    const res = await del(app.id, app.name);
    expect(res.statusCode).toBe(200);

    const left = await db(async (tx) => ({
      client: await tx.oidcClient.count({ where: { id: client.id } }),
      artifacts: await tx.oidcArtifact.count({ where: { payload: { path: ['clientId'], equals: client.clientId } } }),
      otherArtifacts: await tx.oidcArtifact.count({ where: { payload: { path: ['clientId'], equals: otherClientId } } }),
      liveRefreshTokens: await tx.refreshToken.count({ where: { clientId: client.clientId, revokedAt: null } }),
      revokedRefreshTokens: await tx.refreshToken.count({ where: { clientId: client.clientId, NOT: { revokedAt: null } } }),
      decisions: await tx.authorizationDecision.count({ where: { clientId: client.clientId } }),
      deliveries: await tx.logoutDelivery.count({ where: { clientId: client.id } }),
    }));
    expect(left).toEqual({
      client: 0,
      artifacts: 0,
      otherArtifacts: 1,
      liveRefreshTokens: 0,
      // Kept, revoked: the evidence that access ended.
      revokedRefreshTokens: 1,
      decisions: 0,
      deliveries: 0,
    });

    const event = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'application.deleted', outcome: 'success' } }),
    );
    expect(event.payload).toMatchObject({
      protocol: 'oidc',
      clientId: client.clientId,
      entityId: null,
      revoked: { oidcArtifacts: 3, refreshTokens: 1, authorizationDecisions: 1 },
    });
    // Never the secret, nor its hash.
    expect(JSON.stringify(event.payload)).not.toContain(client.clientSecretHash);
    expect(Object.keys(event.payload as object)).not.toContain('clientSecret');
  });

  it('takes the tile out of the portal at once', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    await db((tx) => assignApplication(tx, app.id, { type: 'user', id: employeeId }));

    const tiles = async () =>
      (await call('GET', '/api/portal/applications', portalCookie)).json().applications as { id: string }[];
    expect((await tiles()).map((t) => t.id)).toContain(app.id);

    expect((await del(app.id, app.name)).statusCode).toBe(200);
    expect((await tiles()).map((t) => t.id)).not.toContain(app.id);
  });

  it('frees the entity ID: the same catalog entry registers again', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });

    const duplicate = await call('POST', '/api/admin/applications/from-catalog', adminCookie, {
      key: 'slack',
      variables: { workspace: 'acme' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().type).toMatch(/entity-id-taken$/);

    expect((await del(app.id, app.name)).statusCode).toBe(200);

    const again = await call('POST', '/api/admin/applications/from-catalog', adminCookie, {
      key: 'slack',
      variables: { workspace: 'acme' },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().applicationId).not.toBe(app.id);
  });
});

describe('what a delete refuses to disturb', () => {
  it('refuses while a catalog product grants it, and names the product', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    await db(async (tx) => {
      const workflow = await tx.approvalWorkflow.create({ data: { tenantId: ctx.tenantId, name: 'Straight through' } });
      const product = await tx.product.create({
        data: { tenantId: ctx.tenantId, name: 'Slack access', slug: 'slack-access', kind: 'application', workflowId: workflow.id },
      });
      await tx.productGrant.create({
        data: { tenantId: ctx.tenantId, productId: product.id, resourceType: 'application', resourceId: app.id },
      });
    });

    const res = await del(app.id, app.name);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ products: ['Slack access'], liveGrants: 0 });
    expect(res.json().type).toMatch(/application-in-use$/);
    expect(await db((tx) => tx.application.count({ where: { id: app.id } }))).toBe(1);
    expect(await db((tx) => tx.samlConfig.count({ where: { applicationId: app.id } }))).toBe(1);
  });

  it('leaves an authentication policy rule naming it exactly as it was', async () => {
    const app = await fromCatalog('slack', { workspace: 'acme' });
    const rule = await db(async (tx) => {
      const policy = await tx.authPolicy.create({ data: { tenantId: ctx.tenantId } });
      return tx.authPolicyRule.create({
        data: {
          tenantId: ctx.tenantId,
          policyId: policy.id,
          position: 0,
          name: 'Deny Slack off-network',
          outcome: 'deny',
          applicationIds: [app.id],
        },
      });
    });

    expect((await del(app.id, app.name)).statusCode).toBe(200);

    // Emptying the list would make the rule apply to EVERY application.
    const after = await db((tx) => tx.authPolicyRule.findUniqueOrThrow({ where: { id: rule.id } }));
    expect(after.applicationIds).toEqual([app.id]);
    const event = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'application.deleted', outcome: 'success' } }),
    );
    expect(event.payload).toMatchObject({ policyRulesNamingIt: 1 });
  });
});
