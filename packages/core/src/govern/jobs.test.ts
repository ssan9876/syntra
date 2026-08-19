import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { asDatabaseSuperuser, resetDatabase } from '@syntra/db/src/test-support.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { recordEvent } from '../audit/audit-service.js';
import { NEVER_DIGESTED } from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { TEMPLATES } from '../notify/templates/index.js';
import { fileAnchorSink, localFileCheckpointSigner } from './audit-integrity.js';
import {
  GOVERN_ANCHOR_JOB,
  GOVERN_PURPOSES,
  GOVERN_SNAPSHOT_JOB,
  GOVERN_VERIFY_JOB,
  applyGovernSchedules,
  governJobPayload,
  governScheduleKey,
  registerGovernJobs,
  runPruneJob,
  runSnapshotJob,
  runVerifyJob,
} from './jobs.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let otherTenantId: string;

const fakeScheduler = () => {
  const scheduled: { name: string; cron: string; key: string | undefined }[] = [];
  const unscheduled: { name: string; key: string | undefined }[] = [];
  const registered: string[] = [];
  // The HANDLER is kept, not only its name. A fake that discards it can prove a
  // job was registered and can prove nothing about what it was registered WITH
  // — which is the whole point here: `registerGovernJobs(scheduler)` registers
  // all four handlers correctly and hands three of them nothing.
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    scheduled,
    unscheduled,
    registered,
    handlers,
    run: (name: string, payload: unknown) => handlers.get(name)!(payload),
    scheduler: {
      register: (name: string, handler: (payload: never) => Promise<unknown>) => {
        registered.push(name);
        handlers.set(name, handler as (payload: unknown) => Promise<unknown>);
      },
      start: async () => {},
      stop: async () => {},
      enqueue: async () => null,
      schedule: async (name: string, cron: string, _data?: unknown, key?: string) => {
        scheduled.push({ name, cron, key });
      },
      unschedule: async (name: string, key?: string) => {
        unscheduled.push({ name, key });
      },
    } as Scheduler,
  };
};

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

describe('schedule keys', () => {
  it('gives every tenant and every purpose a distinct key', () => {
    // pg-boss keys its schedule table on (queue, key) with key defaulting to ''.
    // All directory sources once shared key '' and only the last one in the
    // last tenant ever ran.
    const keys = new Set<string>();
    for (const tenant of [tenantId, otherTenantId]) {
      for (const purpose of GOVERN_PURPOSES) keys.add(governScheduleKey(tenant, purpose));
    }
    expect(keys.size).toBe(2 * GOVERN_PURPOSES.length);
  });

  it('names all seven purposes', () => {
    expect([...GOVERN_PURPOSES].sort()).toEqual([
      'anchor',
      'close',
      'exception',
      'prune',
      'remind',
      'snapshot',
      'verify',
    ]);
  });
});

describe('applyGovernSchedules', () => {
  it('schedules every purpose with a distinct key when a cadence is set', async () => {
    const { scheduler, scheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, '0 1 * * *');
    expect(scheduled).toHaveLength(GOVERN_PURPOSES.length);
    expect(new Set(scheduled.map((s) => s.key)).size).toBe(GOVERN_PURPOSES.length);
  });

  it('UNSCHEDULES every purpose when the cadence is cleared', async () => {
    // Scheduling and unscheduling are two halves of one decision. pg-boss keeps
    // schedules in the database, so a tenant that turned snapshots off while
    // this process was down still has rows waiting for it.
    const { scheduler, scheduled, unscheduled } = fakeScheduler();
    await applyGovernSchedules(scheduler, tenantId, null);
    expect(scheduled).toHaveLength(0);
    expect(unscheduled).toHaveLength(GOVERN_PURPOSES.length);
  });
});

describe('registerGovernJobs', () => {
  it('registers a handler for every queue it schedules in slice 1', () => {
    const { scheduler, registered } = fakeScheduler();
    registerGovernJobs(scheduler);
    expect(registered).toEqual(
      expect.arrayContaining([GOVERN_SNAPSHOT_JOB, GOVERN_VERIFY_JOB, GOVERN_ANCHOR_JOB]),
    );
  });
});

describe('the jobs', () => {
  it('builds a snapshot and refreshes orphan proposals in one run', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: { tenantId, login: 'svc', email: 's@a.test', displayName: 'Service' },
      }),
    );
    const result = await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    expect(result.snapshotId).toBeTruthy();
    const snapshot = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findUniqueOrThrow({ where: { id: result.snapshotId } }),
    );
    expect(snapshot.status).toBe('complete');
  });

  it('verifies incrementally and records the check', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    const result = await runVerifyJob(governJobPayload(tenantId), { now: NOW });
    expect(result.result).toBe('valid');
    const checks = await withTenant(tenantId, (tx) => tx.auditChainCheck.findMany());
    expect(checks).toHaveLength(1);
  });

  it('touches no other tenant', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    const other = await withTenant(otherTenantId, (tx) => tx.accessSnapshot.count());
    expect(other).toBe(0);
  });

  it('prunes nothing when retention has not been reached', async () => {
    await runSnapshotJob(governJobPayload(tenantId), { now: NOW });
    expect(await runPruneJob(governJobPayload(tenantId), { now: NOW })).toEqual({ pruned: 0 });
  });
});

describe('the templates', () => {
  it('adds seven Govern templates, and every one renders a NAME rather than an id', () => {
    const govern = Object.keys(TEMPLATES).filter((k) => k.startsWith('govern-'));
    expect(govern).toHaveLength(7);
    for (const name of govern) {
      const template = TEMPLATES[name as keyof typeof TEMPLATES];
      const placeholders = [...`${template.subject}${template.text}`.matchAll(/\{\{(\w+)\}\}/g)].map(
        (m) => m[1],
      );
      // No `var` a template renders may be an id. UUIDs in a notification are
      // "the feature works and no human can use it".
      expect(placeholders.filter((p) => /Id$/.test(p ?? ''))).toEqual([]);
    }
  });
});

describe('what registerGovernJobs hands its handlers', () => {
  it('passes the SIGNER through, so a checkpoint is written signed', async () => {
    // The registration test, not the verifier test. `checkpointTrust` is
    // correct, unskippable and mutation-guarded inside `verifyIncremental`;
    // this is the separate assertion that a deployment ever hands it a key.
    // Without it the protection is reachable only from a test — which is what
    // it was, at the one call site that matters.
    const fake = fakeScheduler();
    registerGovernJobs(fake.scheduler, {
      signer: localFileCheckpointSigner('key-1', Buffer.alloc(32, 9)),
    });
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.test',
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    await fake.run(GOVERN_VERIFY_JOB, governJobPayload(tenantId));

    const checkpoint = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findFirstOrThrow());
    expect(checkpoint.keyId).toBe('key-1');
    expect(checkpoint.signature).not.toBeNull();
  });

  it('passes the ANCHOR SINK through, so anchoring is not `not_configured` forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-anchor-'));
    const fake = fakeScheduler();
    registerGovernJobs(fake.scheduler, { anchorSink: fileAnchorSink(dir) });
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.test',
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    await fake.run(GOVERN_ANCHOR_JOB, governJobPayload(tenantId));

    const row = await withTenant(tenantId, (tx) => tx.auditAnchor.findFirstOrThrow());
    expect(row.status).toBe('anchored');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('writes an UNSIGNED checkpoint when no signer is configured, and says nothing false about it', async () => {
    // The honest default, asserted so the two states are distinguishable. A
    // deployment with no key is not broken; a deployment with a key that never
    // reaches the verifier looks identical from here, and this pair is what
    // tells them apart.
    const fake = fakeScheduler();
    registerGovernJobs(fake.scheduler);
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.test',
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    await fake.run(GOVERN_VERIFY_JOB, governJobPayload(tenantId));

    const checkpoint = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findFirstOrThrow());
    expect(checkpoint.keyId).toBeNull();
  });
});

describe('the critical-finding producer', () => {
  // A hardened detector wired to a notification nobody sends is the same inert
  // control one layer out. Section 17 says a `critical` finding is notified
  // immediately and never digested; these are the assertions that make that a
  // fact about the code rather than a sentence in a template.
  const auditReader = async (over: { mode?: string } = {}) => {
    return withTenant(tenantId, async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          login: 'ingrid',
          email: 'ingrid@example.test',
          displayName: 'Ingrid Bakker',
        },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: [PERMISSIONS.AUDIT_READ] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: created.id },
      });
      if (over.mode !== undefined) {
        await tx.notificationPreference.create({
          data: { tenantId, userId: created.id, mode: over.mode },
        });
      }
      return created;
    });
  };

  const breakTheChain = async () => {
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        await recordEvent(tx, {
          actorUserId: null,
          action: `govern.test.${i}`,
          targetType: 'Test',
          targetId: null,
          outcome: 'success',
          sourceIp: null,
          payload: { i },
        });
      }
    });
    // The rule comes off first. PostgreSQL RULES are NOT bypassed by superuser
    // the way RLS is, so a bare superuser UPDATE here is rewritten to
    // DO INSTEAD NOTHING: it reports success, changes nothing, and every case
    // below then asserts over a chain that was never tampered with.
    await asDatabaseSuperuser('ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update');
    try {
      await asDatabaseSuperuser(
        `UPDATE "AuditEvent" SET action = 'tampered' WHERE "tenantId" = $1 AND sequence = 2`,
        [tenantId],
      );
    } finally {
      await asDatabaseSuperuser('ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update');
    }
  };

  it('NOTIFIES the audit.read holders, with a findingUrl they can open', async () => {
    const user = await auditReader();
    await breakTheChain();

    const result = await runVerifyJob(governJobPayload(tenantId), {
      now: NOW,
      publicUrl: 'https://syntra.example.test',
    });
    expect(result.result).toBe('broken');
    expect(result.notified).toBe(1);

    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ template: 'govern-finding-critical', to: user.email });

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    const vars = outbox[0]!.vars as Record<string, string>;
    // ABSOLUTE, and pointing at the row. A relative link in an email client
    // resolves to nothing, which is what `publicUrl` being unwired produced.
    expect(vars['findingUrl']).toBe(
      `https://syntra.example.test/admin/govern/findings/${finding.id}`,
    );
    // A name, never an id: nobody reading this should have to know the enum.
    expect(vars['findingKind']).not.toMatch(/_/);
    expect(vars['summary']).toContain('does not hold');
  });

  it('is NEVER digested, whatever the recipient chose', async () => {
    // The digest path is exactly where an urgent message silently rejoins the
    // queue: `enqueueOutbox` writes `digest: true` for any DIGESTIBLE template
    // whose recipient asked for a daily summary, and `runOutboxJob` skips those
    // rows. An audit chain that does not hold, arriving in tomorrow morning's
    // summary, is an audit chain nobody acted on today.
    await auditReader({ mode: 'daily' });
    await breakTheChain();

    await runVerifyJob(governJobPayload(tenantId), { now: NOW, publicUrl: 'https://x.test' });

    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.digest).toBe(false);
    // And the rule is enforced in the shared list, once, rather than at this
    // call site where the next caller would forget it.
    expect(NEVER_DIGESTED).toContain('govern-finding-critical');
  });

  it('does NOT re-send a finding that is still open from the last run', async () => {
    // A `critical` alarm that arrives every night at 04:00 for six months is an
    // alarm somebody writes a mail rule for.
    await auditReader();
    await breakTheChain();

    const first = await runVerifyJob(governJobPayload(tenantId), {
      now: NOW,
      publicUrl: 'https://x.test',
    });
    const second = await runVerifyJob(governJobPayload(tenantId), {
      now: NOW,
      publicUrl: 'https://x.test',
    });
    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);

    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox).toHaveLength(1);
  });

  it('asks the database for audit_chain_broken and nothing else, in BOTH queries', () => {
    // A SOURCE assertion, and the comment is the justification.
    //
    // The behavioural version of this case cannot fail. `fresh` excludes every
    // id in `before`, and `before` is read at the top of the same call, so any
    // pre-existing finding of any kind is already excluded — dropping the
    // `kind` filter from both queries changes no observable behaviour unless
    // another process raises a critical finding BETWEEN the two reads. The
    // filter is right to be there (the nightly build raises the standing kinds
    // in bulk, and mailing each one immediately is how a queue becomes a filter
    // rule), and it is defence against exactly that concurrent producer — but a
    // test that seeds a finding and asserts zero mail passes just as happily
    // without it, which is the "case that cannot fail" defect this plan has
    // found five times already. So the assertion is on the query.
    const source = readFileSync(
      new URL('./jobs.ts', import.meta.url),
      'utf8',
    );
    const verifyJob = source.slice(source.indexOf('export async function runVerifyJob'));
    expect(
      [...verifyJob.matchAll(/kind: 'audit_chain_broken'/g)],
      'both the before and the fresh query must name the kind',
    ).toHaveLength(2);
  });

  it('sends NOTHING for a critical finding that is not an integrity finding', async () => {
    // The standing kinds are raised by the nightly snapshot build in bulk and
    // are worked from the findings queue. Mailing every `critical` immediately
    // is how a queue becomes a filter rule, and it is not what section 17 asks
    // for.
    await auditReader();
    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'stale_source',
          severity: 'critical',
          subjectRefType: 'source',
          subjectRefId: 'src-1',
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.test',
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    const result = await runVerifyJob(governJobPayload(tenantId), {
      now: NOW,
      publicUrl: 'https://x.test',
    });
    expect(result.result).toBe('valid');
    expect(result.notified).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany())).toEqual([]);
  });

  it('RECORDS it rather than dropping it when nobody holds audit.read', async () => {
    // A silent zero here is indistinguishable from a working notifier.
    await breakTheChain();

    const result = await runVerifyJob(governJobPayload(tenantId), {
      now: NOW,
      publicUrl: 'https://x.test',
    });
    expect(result.notified).toBe(0);

    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.finding.critical_unnotified' } }),
    );
    expect(event.outcome).toBe('failure');
    expect(event.payload).toMatchObject({ findingCount: 1, permission: 'audit.read' });
  });
});
