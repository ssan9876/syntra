import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignRole, createRole, createSession, createUser, PERMISSIONS } from '@syntra/core';
import { withTenant } from '@syntra/db';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let ownerId: string;

beforeEach(async () => {
  ctx = await buildTestApp();
  cookie = await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, {
      login: 'operator',
      email: 'operator@test.test',
      displayName: 'Operator',
    });
    ownerId = admin.id;
    const role = await createRole(tx, 'Lifecycle operator', [
      PERMISSIONS.IDENTITY_READ,
      PERMISSIONS.IDENTITY_WRITE,
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.DIRECTORY_WRITE,
      PERMISSIONS.PROVISION_READ,
      PERMISSIONS.PROVISION_MANAGE,
    ]);
    await assignRole(tx, admin.id, role.id);
    const session = await createSession(
      tx,
      {
        status: 'allow',
        userId: admin.id,
        mayElevate: true,
        scope: 'admin',
        applicationId: null,
        satisfiedFactor: null,
      },
      { ip: null, userAgent: null },
    );
    return `syntra_session=${session.token}`;
  });
});

afterEach(async () => ctx?.app.close());

describe('lifecycle operation routes', () => {
  it('creates and replays one durable onboarding operation', async () => {
    const payload = {
      idempotencyKey: 'HR-1042',
      person: { givenName: 'Maya', familyName: 'Okafor', externalId: 'HR-1042' },
      contract: { sequence: 1, isPrimary: true, startDate: '2026-10-01' },
      login: { login: 'maya.okafor', email: 'maya@acme.test', displayName: 'Maya Okafor' },
      targetIds: [],
    };
    const post = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/admin/lifecycle-operations/onboard',
        headers: { host: ctx.host, cookie },
        payload,
      });

    const first = await post();
    const replay = await post();

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().operation.id).toBe(first.json().operation.id);
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/lifecycle-operations/${first.json().operation.id}`,
      headers: { host: ctx.host, cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ kind: 'onboard', status: 'completed' });
  });

  it('previews and applies a revision-bound mover operation', async () => {
    const person = await withTenant(ctx.tenantId, async (tx) => {
      const created = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Maya', familyName: 'Okafor' },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: created.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
          department: 'Finance',
        },
      });
      return created;
    });
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/persons/${person.id}/mover/preview`,
      headers: { host: ctx.host, cookie },
      payload: { contractSequence: 1, changes: { department: 'Clinical Operations' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().changes).toEqual([
      { field: 'department', before: 'Finance', after: 'Clinical Operations' },
    ]);
    const applied = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/persons/${person.id}/mover/apply`,
      headers: { host: ctx.host, cookie },
      payload: preview.json(),
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ kind: 'move', status: 'completed' });
  });

  it('returns a read-only lifecycle simulation', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/lifecycle-operations/simulate',
      headers: { host: ctx.host, cookie },
      payload: {
        kind: 'leaver',
        current: { accountPresent: true, enabled: true, entitlements: ['legacy'] },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'leaver',
      effects: ['revoke legacy', 'disable account'],
      writesPerformed: false,
    });
  });

  it('assigns and acknowledges lifecycle work', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'verify',
          idempotencyKey: 'verify-1',
          inputFingerprint: 'fingerprint',
          status: 'failed',
        },
      }),
    );
    const assigned = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/lifecycle-operations/${operation.id}/assignment`,
      headers: { host: ctx.host, cookie },
      payload: { ownerUserId: ownerId, priority: 'high', dueAt: '2026-09-22T00:00:00Z' },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ ownerUserId: ownerId, priority: 'high' });
    const acknowledged = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/acknowledge`,
      headers: { host: ctx.host, cookie },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().acknowledgedAt).not.toBeNull();
  });

  it('requeues failed lifecycle work without creating another operation', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'verify',
          idempotencyKey: 'verify-retry-1',
          inputFingerprint: 'fingerprint',
          status: 'failed',
          steps: { create: { tenantId: ctx.tenantId, key: 'target', title: 'Verify target', position: 0, required: true, status: 'failed' } },
        },
      }),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/retry`,
      headers: { host: ctx.host, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: operation.id, status: 'queued', attempt: 2 });
  });

  it('does not reset a target lifecycle operation when its durable receipts cannot be queued', async () => {
    const operation = await withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId: ctx.tenantId, givenName: 'Maya', familyName: 'Okafor' } });
      const target = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'Directory', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/test' },
      });
      const created = await tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId, personId: person.id, kind: 'onboard', idempotencyKey: 'receipt-retry-1', inputFingerprint: 'receipt-retry-1', status: 'failed',
          steps: { create: { tenantId: ctx.tenantId, key: 'targets', title: 'Provision targets', position: 0, required: true, status: 'failed' } },
        },
      });
      await tx.personProvisionReceipt.create({
        data: { tenantId: ctx.tenantId, personId: person.id, targetSystemId: target.id, targetName: target.name, requestKey: created.id, status: 'failed' },
      });
      return created;
    });
    const response = await ctx.app.inject({
      method: 'POST', url: `/api/admin/lifecycle-operations/${operation.id}/retry`, headers: { host: ctx.host, cookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ type: expect.stringContaining('scheduler-unavailable') });
    const unchanged = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.findUniqueOrThrow({ where: { id: operation.id } }));
    expect(unchanged).toMatchObject({ status: 'failed', attempt: 1 });
  });

  it('acknowledges selected lifecycle work in one durable queue action', async () => {
    const operations = await withTenant(ctx.tenantId, (tx) =>
      Promise.all(['bulk-1', 'bulk-2'].map((idempotencyKey) => tx.lifecycleOperation.create({
        data: { tenantId: ctx.tenantId, kind: 'verify', idempotencyKey, inputFingerprint: idempotencyKey, status: 'waiting' },
      }))),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/lifecycle-operations/bulk',
      headers: { host: ctx.host, cookie },
      payload: { action: 'acknowledge', operationIds: operations.map((operation) => operation.id) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toHaveLength(2);
    expect(response.json().operations.every((operation: { acknowledgedAt: string | null }) => operation.acknowledgedAt !== null)).toBe(true);
  });

  it('completes a target step only after matching observed-state evidence', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'verify',
        idempotencyKey: 'observe-1',
        inputFingerprint: 'observe-1',
        status: 'waiting',
        steps: { create: { tenantId: ctx.tenantId, key: 'target', title: 'Verify target', position: 0, required: true, status: 'running' } },
      },
    }));
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/observations`,
      headers: { host: ctx.host, cookie },
      payload: {
        stepKey: 'target',
        expected: { accountPresent: true, enabled: true, attributes: {}, entitlements: ['finance'] },
        observed: { accountPresent: true, enabled: true, attributes: {}, entitlements: ['finance'], complete: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ matches: true, completeness: 'complete' });
    expect(response.json().operation).toMatchObject({ status: 'completed' });
  });
});
