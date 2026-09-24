import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { EXPORT_JOB } from '../exports/export-service.js';
import { PERSON_PROVISION_JOB } from '../provision/person-receipts.js';
import { SYNC_JOB } from '../sync/jobs.js';
import {
  JOB_HEALTH_THRESHOLDS,
  JobRepairRefusedError,
  classifyJobHealth,
  inspectJobHealth,
  jobHealthCounts,
  pgBossInspector,
  repairJob,
  type QueueGroup,
  type QueueInspector,
} from './job-health.js';
import type { Scheduler } from './scheduler.js';

/*
 * Queue recovery controls (backlog #57): detection against the queue and the
 * clock, and repairs that are idempotent, audited and never re-run a
 * connector write.
 */

const now = new Date('2026-09-23T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

let tenantId: string;
let otherTenantId: string;
let actorId: string;
let sourceId: string;
let targetId: string;

function fakeScheduler(): Scheduler & { enqueued: { name: string; data: unknown }[] } {
  const enqueued: { name: string; data: unknown }[] = [];
  return {
    enqueued,
    start: async () => {},
    stop: async () => {},
    register: () => {},
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return `job-${enqueued.length}`;
    },
    schedule: async () => {},
    unschedule: async () => {},
    missingSchedules: async () => [],
  };
}

const group = (over: Partial<QueueGroup>): QueueGroup => ({
  name: SYNC_JOB,
  state: 'created',
  tenantId,
  runId: null,
  receiptId: null,
  exportId: null,
  sourceId: null,
  targetSystemId: null,
  count: 1,
  attempts: 0,
  oldestCreatedAt: ago(MIN),
  lastError: null,
  ...over,
});

/** A queue that is readable and empty, or holds exactly these groups. */
const queueOf = (groups: QueueGroup[] = []): QueueInspector => async () => groups;
const unreadable: QueueInspector = async () => null;

const emptyFacts = () => ({
  syncRuns: [],
  importRuns: [],
  provisionRuns: [],
  inFlight: new Map<string, number>(),
  receipts: [],
  exports: [],
  operations: [],
});

const auditActions = () =>
  withTenant(tenantId, async (tx) =>
    (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((e) => ({ action: e.action, payload: e.payload })),
  );

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  await withTenant(tenantId, async (tx) => {
    actorId = (await tx.user.create({ data: { tenantId, login: 'operator', email: 'operator@acme.test', displayName: 'Operator' } })).id;
    sourceId = (await tx.directorySource.create({ data: { tenantId, name: 'LDAP', config: {}, secretName: 'ldap' } })).id;
    targetId = (await tx.targetSystem.create({ data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 't' } })).id;
  });
});

describe('classifyJobHealth (pure)', () => {
  it('calls a queued run with no job orphaned, and one waiting in the queue delayed', () => {
    const facts = {
      ...emptyFacts(),
      syncRuns: [
        { id: 'r-orphan', sourceId: 's', status: 'queued', startedAt: ago(30 * MIN) },
        { id: 'r-waiting', sourceId: 's', status: 'queued', startedAt: ago(30 * MIN) },
        { id: 'r-young', sourceId: 's', status: 'queued', startedAt: ago(MIN) },
      ],
    };
    const findings = classifyJobHealth(facts, [group({ runId: 'r-waiting', oldestCreatedAt: ago(30 * MIN) })], now);
    expect(findings.map((f) => [f.subjectId, f.finding, f.repairs])).toEqual([
      ['r-orphan', 'orphaned', ['requeue', 'mark_failed']],
      ['r-waiting', 'delayed', []],
    ]);
  });

  it('reports nothing orphaned when the queue cannot be read', () => {
    const facts = {
      ...emptyFacts(),
      syncRuns: [{ id: 'r', sourceId: 's', status: 'queued', startedAt: ago(HOUR) }],
      exports: [{ id: 'x', status: 'running', requestedAt: ago(HOUR), startedAt: ago(HOUR) }],
    };
    expect(classifyJobHealth(facts, null, now)).toEqual([]);
  });

  it('treats a scheduled run as worked on by an active job for its source', () => {
    const facts = { ...emptyFacts(), syncRuns: [{ id: 'r', sourceId: 's', status: 'running', startedAt: ago(HOUR) }] };
    expect(classifyJobHealth(facts, [group({ state: 'active', sourceId: 's' })], now)).toEqual([]);
    const orphaned = classifyJobHealth(facts, [], now);
    expect(orphaned).toMatchObject([{ finding: 'orphaned', repairs: ['mark_failed'] }]);
  });

  it('offers no repair for an applying sync run, which has no heartbeat to judge it by', () => {
    const facts = { ...emptyFacts(), importRuns: [{ id: 'r', sourceId: 's', status: 'applying', startedAt: ago(7 * HOUR) }] };
    expect(classifyJobHealth(facts, [], now)).toMatchObject([{ finding: 'stuck', kind: 'person_import_run', repairs: [] }]);
  });

  it('judges a provisioning apply by its heartbeat and counts the actions awaiting verification', () => {
    const facts = {
      ...emptyFacts(),
      provisionRuns: [
        { id: 'dead', targetSystemId: 't', status: 'applying', startedAt: ago(10 * HOUR), lastProgressAt: ago(20 * MIN) },
        { id: 'alive', targetSystemId: 't2', status: 'applying', startedAt: ago(10 * HOUR), lastProgressAt: ago(MIN) },
      ],
      inFlight: new Map([['dead', 2]]),
    };
    const findings = classifyJobHealth(facts, [], now);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ subjectId: 'dead', finding: 'orphaned', repairs: ['release_lease'], inFlightActions: 2 });
    expect(findings[0]!.detail).toContain('verified against the target');
  });

  it('reports a deferred receipt as saturation-deferred, and a deliberately pending one not at all', () => {
    const base = { targetSystemId: 't', jobId: 'j', createdAt: ago(HOUR) };
    const facts = {
      ...emptyFacts(),
      receipts: [
        { ...base, id: 'deferred', status: 'deferred', message: 'Deferred', updatedAt: ago(MIN), evidence: { deferrals: 4 } },
        { ...base, id: 'waiting', status: 'pending', message: 'The start date is outside the provisioning window.', updatedAt: ago(HOUR), evidence: null },
      ],
    };
    const findings = classifyJobHealth(facts, [group({ name: PERSON_PROVISION_JOB, receiptId: 'deferred' })], now);
    expect(findings).toMatchObject([{ subjectId: 'deferred', finding: 'saturation_deferred' }]);
    expect(findings[0]!.detail).toContain('4 times');
  });

  it('finds duplicated jobs and poisoned payloads on the queue, classifying the failure without repeating it', () => {
    const findings = classifyJobHealth(emptyFacts(), [
      group({ name: EXPORT_JOB, exportId: 'x', count: 2 }),
      group({ name: SYNC_JOB, runId: 'r', state: 'failed', attempts: 4, lastError: 'connect ECONNREFUSED to jane.doe@acme.test' }),
    ], now);
    const duplicated = findings.find((f) => f.finding === 'duplicated');
    const poisoned = findings.find((f) => f.finding === 'poisoned');
    expect(duplicated).toMatchObject({ kind: 'data_export', subjectId: 'x' });
    expect(poisoned).toMatchObject({ kind: 'sync_run', subjectId: 'r', errorClass: 'network' });
    expect(JSON.stringify(findings)).not.toContain('jane.doe');
  });
});

describe('inspectJobHealth', () => {
  it("reads only this tenant's rows and ignores another tenant's jobs", async () => {
    await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'queued', startedAt: ago(HOUR) } }),
    );
    const otherSource = await withTenant(otherTenantId, (tx) =>
      tx.directorySource.create({ data: { tenantId: otherTenantId, name: 'LDAP', config: {}, secretName: 'x' } }),
    );
    await withTenant(otherTenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId: otherTenantId, sourceId: otherSource.id, status: 'queued', startedAt: ago(HOUR) } }),
    );
    // A job the OTHER tenant owns, naming this tenant's run id, must not make
    // this tenant's run look alive -- nor show up as anything here.
    const own = await withTenant(tenantId, (tx) => tx.syncRun.findFirstOrThrow());
    const report = await inspectJobHealth(tenantId, {
      now,
      inspector: queueOf([group({ tenantId: otherTenantId, runId: own.id }), group({ tenantId: otherTenantId, name: EXPORT_JOB, exportId: 'x', count: 3 })]),
    });
    expect(report.findings.map((f) => [f.subjectId, f.finding])).toEqual([[own.id, 'orphaned']]);
    expect(report.counts.orphaned).toBe(1);
  });
});

describe('repairJob', () => {
  const repair = (kind: Parameters<typeof repairJob>[1]['kind'], subjectId: string, action: Parameters<typeof repairJob>[1]['action'], inspector: QueueInspector = queueOf(), scheduler: Scheduler | null = fakeScheduler()) =>
    repairJob(tenantId, { kind, subjectId, action, reason: 'worker lost in a node drain', actorUserId: actorId, sourceIp: '203.0.113.5' }, { now, inspector, scheduler });

  it('requeues an orphaned queued run once, and answers noop when its job exists', async () => {
    const run = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'queued', startedAt: ago(HOUR) } }),
    );
    const scheduler = fakeScheduler();
    const first = await repair('sync_run', run.id, 'requeue', queueOf(), scheduler);
    expect(first).toMatchObject({ outcome: 'repaired', findings: ['orphaned'] });
    expect(scheduler.enqueued).toEqual([{ name: SYNC_JOB, data: { tenantId, sourceId, runId: run.id } }]);

    // The job now exists, so the run is healthy and a second press does nothing.
    const second = await repair('sync_run', run.id, 'requeue', queueOf([group({ runId: run.id })]), scheduler);
    expect(second.outcome).toBe('noop');
    expect(scheduler.enqueued).toHaveLength(1);

    const events = await auditActions();
    expect(events.map((e) => e.action)).toEqual(['job_health.requeue', 'job_health.requeue']);
    expect(events[0]!.payload).toMatchObject({ kind: 'sync_run', result: 'repaired', reason: 'worker lost in a node drain' });
    expect(events[1]!.payload).toMatchObject({ result: 'noop' });
  });

  it('marks an orphaned preview failed with the reason, and honours a waiting cancellation instead', async () => {
    const plain = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'running', startedAt: ago(HOUR) } }),
    );
    const asked = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'running', startedAt: ago(HOUR), cancelState: 'requested', cancelRequestedAt: ago(HOUR) } }),
    );
    expect(await repair('sync_run', plain.id, 'mark_failed')).toMatchObject({ outcome: 'repaired', status: 'failed' });
    expect(await repair('sync_run', asked.id, 'mark_failed')).toMatchObject({ outcome: 'repaired', status: 'cancelled' });
    const rows = await withTenant(tenantId, (tx) => tx.syncRun.findMany({ orderBy: { startedAt: 'asc' } }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(plain.id)).toMatchObject({ status: 'failed', error: 'marked failed by an operator: worker lost in a node drain' });
    expect(byId.get(asked.id)).toMatchObject({ status: 'cancelled', cancelState: 'cancelled' });
    // Idempotent: the second press finds nothing to repair.
    expect((await repair('sync_run', plain.id, 'mark_failed')).outcome).toBe('noop');
  });

  it('refuses a repair that is not safe for the finding', async () => {
    const run = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'running', startedAt: ago(HOUR) } }),
    );
    await expect(repair('sync_run', run.id, 'requeue')).rejects.toBeInstanceOf(JobRepairRefusedError);
    await expect(repair('lifecycle_operation', randomUUID(), 'mark_failed')).rejects.toMatchObject({ code: 'unsupported' });
    expect(await withTenant(tenantId, (tx) => tx.syncRun.findUniqueOrThrow({ where: { id: run.id } }))).toMatchObject({ status: 'running' });
  });

  it('releases a dead provisioning apply without touching actions whose outcome is unknown', async () => {
    const run = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({ data: { tenantId, targetSystemId: targetId, status: 'applying', startedAt: ago(2 * HOUR), lastProgressAt: ago(30 * MIN) } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.createMany({
        data: [
          { tenantId, runId: run.id, actionType: 'create_account', status: 'in_flight', sequence: 1 },
          { tenantId, runId: run.id, actionType: 'grant_entitlement', status: 'applied', sequence: 2 },
        ],
      }),
    );
    const scheduler = fakeScheduler();
    const result = await repair('provision_run', run.id, 'release_lease', queueOf(), scheduler);
    expect(result).toMatchObject({ outcome: 'repaired', status: 'partially_applied', previousStatus: 'applying' });
    const after = await withTenant(tenantId, async (tx) => ({
      run: await tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
      actions: (await tx.provisionAction.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } })).map((a) => a.status),
    }));
    expect(after.run.status).toBe('partially_applied');
    expect(after.run.error).toContain('heartbeat stopped');
    // Left for resolveInFlightActions, which asks the target before the next plan.
    expect(after.actions).toEqual(['in_flight', 'applied']);
    // Nothing was enqueued and no connector was called.
    expect(scheduler.enqueued).toEqual([]);
  });

  it('does not release an apply whose heartbeat is fresh', async () => {
    const run = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({ data: { tenantId, targetSystemId: targetId, status: 'applying', startedAt: ago(8 * HOUR), lastProgressAt: ago(MIN) } }),
    );
    expect((await repair('provision_run', run.id, 'release_lease')).outcome).toBe('noop');
    expect((await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }))).status).toBe('applying');
  });

  it('requeues an abandoned planning receipt through pending, where the worker claims it atomically', async () => {
    const person = await withTenant(tenantId, (tx) => tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } }));
    const receipt = await withTenant(tenantId, (tx) =>
      tx.personProvisionReceipt.create({ data: { tenantId, personId: person.id, targetSystemId: targetId, targetName: 'AD', requestKey: randomUUID(), status: 'planning' } }),
    );
    await withTenant(tenantId, (tx) => tx.$executeRawUnsafe(`update "PersonProvisionReceipt" set "updatedAt" = $1 where id = $2::uuid`, ago(HOUR), receipt.id));
    const scheduler = fakeScheduler();
    const result = await repair('person_provision_receipt', receipt.id, 'requeue', queueOf(), scheduler);
    expect(result).toMatchObject({ outcome: 'repaired', status: 'pending' });
    expect(scheduler.enqueued).toEqual([{ name: PERSON_PROVISION_JOB, data: { tenantId, receiptId: receipt.id } }]);
    expect(await withTenant(tenantId, (tx) => tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: receipt.id } })))
      .toMatchObject({ status: 'pending', jobId: 'job-1' });
  });

  it('marks an orphaned export failed in its own vocabulary as well', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.dataExport.create({ data: { tenantId, kind: 'audit_log', format: 'jsonl', params: {}, requestedByUserId: actorId, ttlHours: 24, status: 'running', requestedAt: ago(HOUR), startedAt: ago(HOUR) } }),
    );
    expect(await repair('data_export', row.id, 'mark_failed')).toMatchObject({ outcome: 'repaired', status: 'failed' });
    expect((await auditActions()).map((e) => e.action)).toEqual(['export.fail', 'job_health.mark_failed']);
  });

  it('refuses a requeue without a running scheduler', async () => {
    const run = await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'queued', startedAt: ago(HOUR) } }),
    );
    await expect(repair('sync_run', run.id, 'requeue', queueOf(), null)).rejects.toMatchObject({ code: 'scheduler-unavailable' });
  });
});

describe('jobHealthCounts', () => {
  it('reports every (kind, finding) pair installation-wide, split from one queue read', async () => {
    await withTenant(tenantId, (tx) =>
      tx.syncRun.create({ data: { tenantId, sourceId, status: 'queued', startedAt: ago(HOUR) } }),
    );
    const { counts, queueReadable, tenantsAffected } = await jobHealthCounts([tenantId, otherTenantId], { now, inspector: queueOf() });
    expect(queueReadable).toBe(true);
    expect(tenantsAffected).toBe(1);
    expect(counts.find((c) => c.kind === 'sync_run' && c.finding === 'orphaned')?.count).toBe(1);
    expect(counts.filter((c) => c.count > 0)).toHaveLength(1);
    expect(counts.length).toBeGreaterThan(30);
    const unknown = await jobHealthCounts([tenantId], { now, inspector: unreadable });
    expect(unknown.queueReadable).toBe(false);
    expect(unknown.counts.every((c) => c.count === 0)).toBe(true);
  });
});

describe('pgBossInspector (against pg-boss itself)', () => {
  it("groups live and failed jobs by payload, filtered to one tenant's jobs", async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await boss.createQueue(SYNC_JOB);
      const runId = randomUUID();
      await boss.send(SYNC_JOB, { tenantId, sourceId, runId });
      await boss.send(SYNC_JOB, { tenantId, sourceId, runId });
      await boss.send(SYNC_JOB, { tenantId: otherTenantId, sourceId, runId });
      const groups = await pgBossInspector(tenantId, ago(JOB_HEALTH_THRESHOLDS.poisonWindowMs));
      expect(groups).not.toBeNull();
      const mine = groups!.filter((g) => g.runId === runId);
      expect(mine).toEqual([expect.objectContaining({ name: SYNC_JOB, state: 'created', tenantId, count: 2 })]);

      const report = await inspectJobHealth(tenantId, { inspector: pgBossInspector });
      expect(report.queueReadable).toBe(true);
      expect(report.findings).toContainEqual(expect.objectContaining({ finding: 'duplicated', kind: 'sync_run', subjectId: runId }));
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
