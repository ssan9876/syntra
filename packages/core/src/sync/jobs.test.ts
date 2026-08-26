import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun } from './run-service.js';
import { queueRun, runSyncJob, SourceDisabledError, SYNC_JOB, syncJobPayload } from './jobs.js';
import type { Scheduler } from '../jobs/scheduler.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 11));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'ou=Shared,dc=acme,dc=test',
  groupSearchBase: 'ou=Shared,dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 100,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Scheduled LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('syncJobPayload', () => {
  it('carries the tenant, because a job has no ambient one', () => {
    expect(syncJobPayload(tenantId, sourceId)).toEqual({ tenantId, sourceId });
    expect(SYNC_JOB).toBe('sync.run');
  });
});

describe('runSyncJob', () => {
  it('previews without applying when autoApply is off', async () => {
    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const run = await withTenant(tenantId, (tx) => tx.syncRun.findFirst());
    expect(run?.status).toBe('previewed');

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('applies when autoApply is on', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: { autoApply: true },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.length).toBeGreaterThan(0);
  });

  it('does not apply a blocked run even with autoApply on', async () => {
    // A filter that excludes only users still leaves the group search
    // returning the fixture's one group, so recordsRead stays nonzero and
    // the guard's only trigger on a first run (no records at all) never
    // fires. Both filters must exclude everything for this run to be
    // genuinely blocked, matching the pattern in scenarios.test.ts's
    // "blocks a run where the source returns no records at all".
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          autoApply: true,
          config: {
            ...config,
            userFilter: '(objectClass=nothing)',
            groupFilter: '(objectClass=nothing)',
          } as never,
        },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const run = await withTenant(tenantId, (tx) => tx.syncRun.findFirst());
    expect(run?.status).toBe('blocked');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('does not apply a requires-confirmation run even with autoApply on', async () => {
    // The load-bearing guarantee of the whole subsystem: a run over the
    // deactivation threshold can be waved through by a person who has read
    // the numbers, and never by the scheduler. runSyncJob applies only a run
    // that reached `previewed`, and a threshold run never does.
    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));
    const first = await withTenant(tenantId, (tx) => tx.syncRun.findFirst());
    await applyRun(tenantId, first!.id);

    const before = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(before).toHaveLength(2);

    // Users vanish from the read while groups still come back, so records
    // were read and the guard's zero-record branch does not fire: this is the
    // threshold branch, the confirmable one.
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          autoApply: true,
          config: { ...config, userFilter: '(objectClass=nothing)' } as never,
        },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const run = await withTenant(tenantId, (tx) =>
      tx.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    );
    expect(run?.status).toBe('blocked');
    expect(run?.requiresConfirmation).toBe(true);

    const after = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(after.every((u) => u.status === 'active')).toBe(true);
  });

  it('records lastRunAt on the source', async () => {
    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.findUnique({ where: { id: sourceId } }),
    );
    expect(source?.lastRunAt).not.toBeNull();
  });

  it('skips a disabled source without creating a run', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: { enabled: false },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));
    expect(await withTenant(tenantId, (tx) => tx.syncRun.count())).toBe(0);
  });
});

describe('queueing a run for a disabled source', () => {
  /**
   * A minimal `Scheduler`, local to this file: `queueRun` only ever calls
   * `enqueue`, and a fake covering the other four methods it never touches
   * would be dead weight kept in step with an interface for no reason.
   */
  const fakeScheduler = (): Scheduler & { enqueued: { name: string; data: unknown }[] } => {
    const enqueued: { name: string; data: unknown }[] = [];
    return {
      enqueued,
      async start() {},
      async stop() {},
      register() {},
      async enqueue(name: string, data: unknown) {
        enqueued.push({ name, data });
        return 'job-1';
      },
      async schedule() {},
      async unschedule() {},
    } as unknown as Scheduler & { enqueued: { name: string; data: unknown }[] };
  };

  /**
   * Neither the route nor queueRun checked `enabled`, and runSyncJob
   * early-returns without touching the run row. Nothing reaps `queued`, so the
   * row sat there for ever, the console followed it, and the page spun with no
   * error anywhere -- for a source somebody had deliberately switched off.
   */
  it('refuses rather than writing a run nothing will ever pick up', async () => {
    const scheduler = fakeScheduler();
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({ where: { id: sourceId }, data: { enabled: false } }),
    );

    await expect(queueRun(scheduler, tenantId, sourceId)).rejects.toBeInstanceOf(
      SourceDisabledError,
    );

    const runs = await withTenant(tenantId, (tx) => tx.syncRun.findMany());
    expect(runs).toHaveLength(0);
    expect(scheduler.enqueued).toHaveLength(0);
  });

  it('still queues one for an enabled source', async () => {
    const scheduler = fakeScheduler();
    const run = await queueRun(scheduler, tenantId, sourceId);
    expect(run.status).toBe('queued');
    expect(scheduler.enqueued).toHaveLength(1);
  });
});
