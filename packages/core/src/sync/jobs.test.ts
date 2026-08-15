import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun } from './run-service.js';
import { runSyncJob, SYNC_JOB, syncJobPayload } from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 11));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
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
