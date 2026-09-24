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
      PERMISSIONS.GOVERN_READ,
      PERMISSIONS.GOVERN_MANAGE,
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

    // The same key with DIFFERENT input is the client's mistake, answered as
    // a 409 with a stable type -- it used to escape as a bare 500 -- and it
    // creates nothing.
    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/lifecycle-operations/onboard',
      headers: { host: ctx.host, cookie },
      payload: { ...payload, person: { ...payload.person, givenName: 'Someone else' } },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      type: 'https://syntra.dev/problems/idempotency-key-reused',
    });
    const operations = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.count());
    expect(operations).toBe(1);
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
    const note = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/case-notes`,
      headers: { host: ctx.host, cookie },
      payload: { message: 'Waiting for a target owner.' },
    });
    expect(note.statusCode).toBe(201);
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/resolve`,
      headers: { host: ctx.host, cookie },
      payload: { code: 'configuration_corrected', summary: 'Credential replaced and verified.' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().operation).toMatchObject({ caseStatus: 'resolved', resolutionCode: 'configuration_corrected' });
    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle-operations/${operation.id}/resolve`,
      headers: { host: ctx.host, cookie },
      payload: { code: 'duplicate', summary: 'Duplicate closure.' },
    });
    expect(duplicate.statusCode).toBe(409);
    const read = await ctx.app.inject({
      method: 'GET', url: `/api/admin/lifecycle-operations/${operation.id}`, headers: { host: ctx.host, cookie },
    });
    expect(read.json().caseEvents.map((event: { kind: string }) => event.kind)).toEqual([
      'assignment', 'acknowledgement', 'note', 'resolution',
    ]);
    expect(read.json().caseEvents[2]).toMatchObject({ actorName: 'Operator', message: 'Waiting for a target owner.' });
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

  it('places, lists and releases a legal hold on lifecycle evidence', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.create({
      data: { tenantId: ctx.tenantId, kind: 'verify', idempotencyKey: 'legal-hold-api', inputFingerprint: 'f', status: 'completed' },
    }));
    const placed = await ctx.app.inject({
      method: 'POST', url: '/api/admin/lifecycle-legal-holds', headers: { host: ctx.host, cookie },
      payload: { subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'LEGAL-42', reason: 'Preserve for counsel' },
    });
    expect(placed.statusCode).toBe(201);
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/admin/lifecycle-legal-holds', headers: { host: ctx.host, cookie } });
    expect(listed.json().holds).toHaveLength(1);
    const released = await ctx.app.inject({
      method: 'POST', url: `/api/admin/lifecycle-legal-holds/${placed.json().id}/release`, headers: { host: ctx.host, cookie },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().releasedAt).not.toBeNull();
  });

  it('refuses retry-after-verification until a complete divergent observation exists', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.create({
      data: {
        tenantId: ctx.tenantId, kind: 'verify', idempotencyKey: 'verify-after-readback', inputFingerprint: 'f', status: 'failed',
        steps: { create: { tenantId: ctx.tenantId, key: 'target', title: 'Verify target', position: 0, required: true, status: 'failed' } },
      },
    }));
    const response = await ctx.app.inject({
      method: 'POST', url: `/api/admin/lifecycle-operations/${operation.id}/retry-after-verification`, headers: { host: ctx.host, cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: expect.stringContaining('verification-required') });
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
