import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { ldapConnector } from '@syntra/connectors';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { RunNotAppliableError, RunNotCancellableError } from '../jobs/cancellation.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun, requestCancelSyncRun } from './run-service.js';
import { applyChange } from './apply.js';

/*
 * Cooperative cancellation of directory sync runs, against the same fixture
 * directory the rest of this package's tests read.
 *
 * `applyChange` is wrapped so a test can land a cancellation request at an
 * exact point in the apply loop — the only way to prove the checkpoint sits
 * BETWEEN changes rather than merely "somewhere".
 */
vi.mock('./apply.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./apply.js')>();
  return { ...real, applyChange: vi.fn(real.applyChange) };
});

const provider = localMasterKeyProvider(Buffer.alloc(32, 5));
let tenantId: string;
let sourceId: string;
let actorId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'ou=Shared,dc=acme,dc=test',
  groupSearchBase: 'ou=Shared,dc=acme,dc=test',
  orgUnitSearchBase: 'ou=Shared,dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
    const actor = await tx.user.create({
      data: { tenantId, login: 'operator', email: 'operator@acme.test', displayName: 'Operator' },
    });
    actorId = actor.id;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(applyChange).mockClear();
});

const cancel = (runId: string) =>
  withTenant(tenantId, (tx) =>
    requestCancelSyncRun(tx, runId, { userId: actorId, sourceIp: '203.0.113.9' }),
  );

const runOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.syncRun.findUniqueOrThrow({ where: { id: runId } }));

const changesOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.syncChange.findMany({ where: { runId } }));

const eventsOf = (action: string) =>
  withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action } }));

describe('sync run cancellation', () => {
  it('stops an apply between changes and leaves an honest partial record', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const proposed = (await changesOf(run.id)).filter((c) => c.status === 'proposed');
    expect(proposed.length).toBeGreaterThan(2);

    // The request lands while the SECOND change is being written — committed
    // from its own transaction, as the API's would be. That change must still
    // complete (a checkpoint never interrupts a write), and nothing after it
    // may start.
    const real = vi.mocked(applyChange).getMockImplementation()!;
    let calls = 0;
    vi.mocked(applyChange).mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) {
        const status = await cancel(run.id);
        expect(status.outcome).toBe('requested');
      }
      return real(...args);
    });

    const result = await applyRun(tenantId, run.id);

    expect(calls).toBe(2);
    expect(result.status).toBe('cancelled');
    expect(result.cancelState).toBe('cancelled');
    expect(result.cancelRequestedByUserId).toBe(actorId);
    expect(result.cancelResolvedAt).not.toBeNull();

    const after = await changesOf(run.id);
    expect(after.filter((c) => c.status === 'applied')).toHaveLength(2);
    const abandoned = after.filter((c) => c.status === 'skipped');
    expect(abandoned).toHaveLength(proposed.length - 2);
    expect(abandoned.every((c) => c.message === 'not applied: the run was cancelled')).toBe(true);
    expect(after.some((c) => c.status === 'proposed')).toBe(false);

    // What committed to the directory is exactly what the run says applied.
    const users = await withTenant(tenantId, (tx) => tx.user.count({ where: { sourceId } }));
    const groups = await withTenant(tenantId, (tx) => tx.group.count({ where: { sourceId } }));
    const units = await withTenant(tenantId, (tx) => tx.orgUnit.count({ where: { sourceId } }));
    expect(users + groups + units).toBeLessThanOrEqual(2);

    const [requested] = await eventsOf('sync.run.cancel');
    expect(requested?.actorUserId).toBe(actorId);
    expect(requested?.payload).toMatchObject({ outcome: 'requested', previousStatus: 'applying' });
    const [honoured] = await eventsOf('sync.run.cancelled');
    expect(honoured?.actorUserId).toBe(actorId);
    expect(honoured?.payload).toMatchObject({ phase: 'apply', applied: 2 });

    // Cancelled is terminal: the rest cannot be applied later by mistake.
    await expect(applyRun(tenantId, run.id)).rejects.toBeInstanceOf(RunNotAppliableError);
    await expect(cancel(run.id)).rejects.toBeInstanceOf(RunNotCancellableError);
  });

  it('records a request the apply finished before observing as moot', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const proposed = (await changesOf(run.id)).filter((c) => c.status === 'proposed');
    // A group: it names no unit and no member, so it applies on its own.
    const last = proposed.find((c) => c.changeType === 'create_group')!;
    expect(last).toBeDefined();

    // One change, and the request arrives while it is being written: there is
    // no later checkpoint to see it, so the run ends normally.
    const real = vi.mocked(applyChange).getMockImplementation()!;
    vi.mocked(applyChange).mockImplementationOnce(async (...args) => {
      await cancel(run.id);
      return real(...args);
    });

    const result = await applyRun(tenantId, run.id, { only: [last.id] });

    expect(result.status).toBe('partially_applied');
    expect(result.cancelState).toBe('moot');
    expect(result.cancelResolvedAt).not.toBeNull();
    expect((await changesOf(run.id)).find((c) => c.id === last.id)?.status).toBe('applied');

    // A moot request is history, not a lock: the rest can still be applied,
    // and the run can be asked to stop again.
    const again = await cancel(run.id);
    expect(again.outcome).toBe('cancelled');
  });

  it('stops a preview at a read checkpoint and proposes nothing', async () => {
    const real = ldapConnector.read.bind(ldapConnector);
    let runId: string | undefined;
    vi.spyOn(ldapConnector, 'read').mockImplementation(async function* (cfg) {
      for await (const record of real(cfg)) {
        if (runId === undefined) {
          const running = await withTenant(tenantId, (tx) =>
            tx.syncRun.findFirstOrThrow({ where: { sourceId, status: 'running' } }),
          );
          runId = running.id;
          expect((await cancel(runId)).outcome).toBe('requested');
        }
        yield record;
      }
    });

    const run = await previewRun(tenantId, provider, sourceId);

    expect(run.id).toBe(runId);
    expect(run.status).toBe('cancelled');
    expect(run.cancelState).toBe('cancelled');
    expect(await changesOf(run.id)).toEqual([]);
    expect(await withTenant(tenantId, (tx) => tx.user.count())).toBe(1); // the operator
    const [honoured] = await eventsOf('sync.run.cancelled');
    expect(honoured?.payload).toMatchObject({ phase: 'preview' });
  });

  it('cancels a queued run at once, and its job then does nothing', async () => {
    const queued = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'queued' } }),
    );
    const read = vi.spyOn(ldapConnector, 'read');

    const result = await cancel(queued.id);
    expect(result).toEqual({ outcome: 'cancelled', previousStatus: 'queued' });

    const run = await previewRun(tenantId, provider, sourceId, queued.id);
    expect(run.status).toBe('cancelled');
    expect(read).not.toHaveBeenCalled();
    expect((await runOf(queued.id)).cancelState).toBe('cancelled');
  });

  it('discards a previewed run outright and refuses to apply it', async () => {
    const run = await previewRun(tenantId, provider, sourceId);

    const result = await cancel(run.id);

    expect(result).toEqual({ outcome: 'cancelled', previousStatus: 'previewed' });
    const changes = await changesOf(run.id);
    expect(changes.some((c) => c.status === 'proposed')).toBe(false);
    await expect(applyRun(tenantId, run.id)).rejects.toBeInstanceOf(RunNotAppliableError);
    expect(await withTenant(tenantId, (tx) => tx.user.count({ where: { sourceId } }))).toBe(0);
  });

  it('refuses to cancel a run that has already finished', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    await expect(cancel(run.id)).rejects.toBeInstanceOf(RunNotCancellableError);
    expect((await runOf(run.id)).cancelState).toBeNull();
  });
});
