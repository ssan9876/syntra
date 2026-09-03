import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport } from '../notify/notification-service.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import {
  AUTOMATE_DIGEST_JOB,
  AUTOMATE_OUTBOX_JOB,
  AUTOMATE_SWEEP_JOB,
  AUTOMATE_TICK_JOB,
  OUTBOX_MAX_ATTEMPTS,
  applyAutomateSchedules,
  automateScheduleKey,
  runDigestJob,
  runOutboxJob,
  runSweepJob,
  runTickJob,
} from './jobs.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

/**
 * Typed to `Scheduler`'s own signatures, not to `async () => undefined`.
 *
 * `vi.fn(async () => undefined)` infers a zero-parameter mock, so
 * `mock.calls[n]` is the empty tuple and reading `c[3]` -- the schedule KEY,
 * which is the whole subject of the case below -- is `TS2493: Tuple type '[]'
 * of length '0' has no element at index '3'`. Vitest does not type-check, so
 * the case passed while the file did not compile; `pnpm typecheck` is what
 * found it, which is exactly why Global Constraint 7 makes it a separate step.
 */
const schedulerStub = () => ({
  schedule: vi.fn(
    async (_name: string, _cron: string, _data?: unknown, _key?: string) => undefined,
  ),
  unschedule: vi.fn(async (_name: string, _key?: string) => undefined),
  // A fake schedules nothing in pg-boss, so nothing it was asked for can be
  // missing. Tests that care about reconciliation build their own.
  missingSchedules: vi.fn(async () => []),
  enqueue: vi.fn(async (_name: string, _data?: unknown) => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('automateScheduleKey', () => {
  it('is distinct per tenant AND per purpose', async () => {
    // pg-boss keys its schedule table on (queue, key). All directory sources
    // once shared key: '' and only the last one in the last tenant ever ran.
    const a = automateScheduleKey('t1', 'sweep');
    const b = automateScheduleKey('t2', 'sweep');
    const c = automateScheduleKey('t1', 'tick');
    const d = automateScheduleKey('t1', 'digest');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('runDigestJob', () => {
  it('sends one summary per recipient and marks every row in it sent', async () => {
    // Without this job, `digest: true` is a row nothing ever sends: the
    // person who asked for a daily summary receives NOTHING, including every
    // stage-opened notification, so approvals sit in a queue nobody has been
    // told about.
    await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.createMany({
        data: [
          {
            tenantId,
            template: 'automate-stage-opened',
            to: 'jan@acme.test',
            vars: { displayName: 'Jan', productName: 'Statistics licence' },
            digest: true,
          },
          {
            tenantId,
            template: 'automate-stage-opened',
            to: 'jan@acme.test',
            vars: { displayName: 'Jan', productName: 'Reading room' },
            digest: true,
          },
          {
            tenantId,
            template: 'automate-stage-opened',
            to: 'bo@acme.test',
            vars: { displayName: 'Bo', productName: 'Statistics licence' },
            digest: true,
          },
        ],
      }),
    );

    const mail = memoryTransport();
    const result = await runDigestJob(mail, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 2 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['bo@acme.test', 'jan@acme.test']);
    const jan = mail.sent.find((m) => m.to === 'jan@acme.test');
    expect(jan?.text).toContain('Statistics licence');
    expect(jan?.text).toContain('Reading room');

    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    for (const row of rows) expect(row.sentAt).not.toBeNull();
  });

  it('leaves the immediate rows alone', async () => {
    await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.create({
        data: {
          tenantId,
          template: 'automate-stage-opened',
          to: 'jan@acme.test',
          vars: { displayName: 'Jan', productName: 'Statistics licence' },
          digest: false,
        },
      }),
    );
    const mail = memoryTransport();
    expect(await runDigestJob(mail, { tenantId }, { now: NOW })).toEqual({ sent: 0 });
    const row = await withTenant(tenantId, (tx) => tx.notificationOutbox.findFirstOrThrow());
    expect(row.sentAt).toBeNull();
  });
});

describe('applyAutomateSchedules', () => {
  it('schedules all four queues with their own keys', async () => {
    const scheduler = schedulerStub();
    await applyAutomateSchedules(scheduler, tenantId, '0 2 * * *');
    const names = scheduler.schedule.mock.calls.map((c) => c[0]);
    expect(names.sort()).toEqual(
      [
        AUTOMATE_DIGEST_JOB,
        AUTOMATE_OUTBOX_JOB,
        AUTOMATE_SWEEP_JOB,
        AUTOMATE_TICK_JOB,
      ].sort(),
    );
    const keys = scheduler.schedule.mock.calls.map((c) => c[3]);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key).toContain(tenantId);
  });

  it('unschedules the sweep when a tenant has no cron for it', async () => {
    // Two halves of one decision. A test that watched only `schedule` would
    // pass while a switched-off sweep kept firing.
    const scheduler = schedulerStub();
    await applyAutomateSchedules(scheduler, tenantId, null);
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      AUTOMATE_SWEEP_JOB,
      automateScheduleKey(tenantId, 'sweep'),
    );
  });
});

describe('runOutboxJob', () => {
  async function draft(over: Record<string, unknown> = {}) {
    return withTenant(tenantId, (tx) =>
      tx.notificationOutbox.create({
        data: {
          tenantId,
          template: 'automate-stage-opened',
          to: 'jan@acme.test',
          vars: { displayName: 'Jan', productName: 'Statistics licence' },
          ...over,
        },
      }),
    );
  }

  it('renders and sends unsent rows, and marks them sent', async () => {
    await draft();
    const mail = memoryTransport();
    const result = await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent[0]?.to).toBe('jan@acme.test');
    // The tenant name comes from the Tenant row, as a parameter -- renderMessage
    // is pure and takes no transaction, which is what stops the send being
    // dragged inside one.
    expect(mail.sent[0]?.subject).toContain('Acme');
    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it('does not send a row twice', async () => {
    await draft();
    const mail = memoryTransport();
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(mail.sent).toHaveLength(1);
  });

  it('records the failure and the attempt count rather than losing the message', async () => {
    await draft();
    const failing = {
      send: async () => {
        throw new Error('connection refused');
      },
    };
    const result = await runOutboxJob(failing, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 0, failed: 1 });
    const row = await withTenant(tenantId, (tx) => tx.notificationOutbox.findFirstOrThrow());
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('connection refused');
    expect(row.sentAt).toBeNull();
  });

  it('stops retrying after OUTBOX_MAX_ATTEMPTS and surfaces the row rather than swallowing it', async () => {
    await draft({ attempts: OUTBOX_MAX_ATTEMPTS });
    const mail = memoryTransport();
    const result = await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toEqual([]);
    // Exhausted, not deleted. "The approver says they never got the mail" is
    // the most common support question a request system produces, and this row
    // is the answer.
    const row = await withTenant(tenantId, (tx) => tx.notificationOutbox.findFirstOrThrow());
    expect(row.sentAt).toBeNull();
  });

  it('holds a digest row back until the daily pass', async () => {
    await draft({ digest: true });
    const mail = memoryTransport();
    await runOutboxJob(mail, { tenantId }, { now: NOW });
    expect(mail.sent).toEqual([]);
    await runOutboxJob(mail, { tenantId }, { now: NOW, batchSize: 100 });
    expect(mail.sent).toEqual([]);
  });
});

describe('runTickJob — reminders and escalation', () => {
  let requestId: string;
  let stepId: string;
  let janPersonId: string;

  beforeEach(async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const jan = await tx.person.create({
        data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
      });
      await tx.contract.create({
        data: { tenantId, personId: jan.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      const user = await tx.user.create({
        data: { tenantId, login: 'jan', email: 'jan@acme.test', displayName: 'Jan', personId: jan.id },
      });
      const anna = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          subjectPersonId: anna.id,
          requestedByUserId: user.id,
          // Set, as `submitRequest` always sets it from the submitting
          // account. Without it the request has a requester with no PERSON,
          // Anna holds no account of her own, and every notification this
          // fixture is used to assert on resolves to nobody -- so the expiry
          // case asserted one outbox row against an empty recipient set.
          requestedByPersonId: jan.id,
          status: 'pending_approval',
        },
      });
      const step = await tx.approvalStep.create({
        data: {
          tenantId,
          requestId: request.id,
          sequence: 1,
          status: 'open',
          openedAt: day('2026-06-10'),
          slaDueAt: day('2026-06-12'),
          stageSnapshot: {
            sequence: 1,
            name: 'Manager',
            selector: 'person',
            selectorConfig: { personId: jan.id },
            quorum: 'any',
            fallbackSelector: null,
            fallbackConfig: {},
            slaHours: 48,
            onTimeout: 'remind',
            escalationSelector: null,
            escalationConfig: {},
            expiryHours: null,
          },
        },
      });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: jan.id, via: 'selector' },
      });
      return { requestId: request.id, stepId: step.id, janPersonId: jan.id };
    });
    ({ requestId, stepId, janPersonId } = seeded);
  });

  it('reminds past the SLA and then no more than once a day', async () => {
    // Remind forever by default. A request never stops asking, and it never
    // approves itself for not having been read.
    const first = await runTickJob({ tenantId }, { now: NOW });
    expect(first.reminders).toBe(1);
    const again = await runTickJob({ tenantId }, { now: NOW });
    expect(again.reminders).toBe(0);
    const tomorrow = await runTickJob({ tenantId }, { now: day('2026-06-16') });
    expect(tomorrow.reminders).toBe(1);
  });

  it('never moves the request out of pending_approval, however long it waits', async () => {
    await runTickJob({ tenantId }, { now: day('2027-01-01') });
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('pending_approval');
  });

  it('adds the escalation approvers and tells the originals they were escalated past', async () => {
    const rikPersonId = await withTenant(tenantId, async (tx) => {
      const rik = await tx.person.create({
        data: { tenantId, givenName: 'Rik', familyName: 'Bos' },
      });
      await tx.contract.create({
        data: { tenantId, personId: rik.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      await tx.user.create({
        data: { tenantId, login: 'rik', email: 'rik@acme.test', displayName: 'Rik', personId: rik.id },
      });
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      await tx.approvalStep.update({
        where: { id: stepId },
        data: {
          stageSnapshot: {
            ...snapshot,
            onTimeout: 'escalate',
            escalationSelector: 'person',
            escalationConfig: { personId: rik.id },
          },
        },
      });
      return rik.id;
    });

    const result = await runTickJob({ tenantId }, { now: NOW });
    expect(result.escalations).toBe(1);

    const state = await withTenant(tenantId, async (tx) => ({
      approvers: await tx.approvalStepApprover.findMany({ where: { stepId } }),
      escalated: await tx.notificationOutbox.findMany({
        where: { template: 'automate-escalated' },
      }),
      told: await tx.notificationOutbox.findMany({
        where: { template: 'automate-escalated-past' },
      }),
    }));
    // ADDED. The originals remain, and they are told.
    expect(state.approvers.map((a) => a.personId).sort()).toEqual(
      [janPersonId, rikPersonId].sort(),
    );
    expect(state.escalated.map((o) => o.to)).toEqual(['rik@acme.test']);
    expect(state.told.map((o) => o.to)).toEqual(['jan@acme.test']);
  });

  it('escalates once, not on every tick', async () => {
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      const rik = await tx.person.create({
        data: { tenantId, givenName: 'Rik', familyName: 'Bos' },
      });
      await tx.contract.create({
        data: { tenantId, personId: rik.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      await tx.user.create({
        data: { tenantId, login: 'rik', email: 'rik@acme.test', displayName: 'Rik', personId: rik.id },
      });
      await tx.approvalStep.update({
        where: { id: stepId },
        data: {
          stageSnapshot: {
            ...snapshot,
            onTimeout: 'escalate',
            escalationSelector: 'person',
            escalationConfig: { personId: rik.id },
          },
        },
      });
    });
    await runTickJob({ tenantId }, { now: NOW });
    const second = await runTickJob({ tenantId }, { now: day('2026-06-20') });
    expect(second.escalations).toBe(0);
  });

  it('expires only where a stage opted into it, and tells the requester by name', async () => {
    // Opt-in per product, never the default, because a request that quietly
    // evaporates is exactly the silent-drop failure this platform keeps
    // rediscovering -- and even opted into, it is loud.
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findUniqueOrThrow({ where: { id: stepId } });
      const snapshot = step.stageSnapshot as Record<string, unknown>;
      await tx.approvalStep.update({
        where: { id: stepId },
        data: { stageSnapshot: { ...snapshot, onTimeout: 'expire', expiryHours: 24 } },
      });
    });
    const result = await runTickJob({ tenantId }, { now: NOW });
    expect(result.expired).toBe(1);
    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-request-expired' },
      }),
    }));
    expect(state.request.status).toBe('expired');
    expect(state.outbox).toHaveLength(1);
  });
});

describe('runTickJob — expiry warnings', () => {
  it('warns the holder at each configured number of days, once per threshold', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.user.create({
        data: { tenantId, login: 'anna', email: 'anna@acme.test', displayName: 'Anna', personId: person.id },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: person.id,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-22'),
          status: 'active',
        },
      });
    });
    const first = await runTickJob({ tenantId }, { now: NOW });
    expect(first.warnings).toBe(1);
    const again = await runTickJob({ tenantId }, { now: NOW });
    expect(again.warnings).toBe(0);
    const closer = await runTickJob({ tenantId }, { now: day('2026-06-21') });
    expect(closer.warnings).toBe(1);
  });
});

describe('runTickJob — promoting a scheduled grant', () => {
  async function preHire(resourceType: 'application' | 'group' | 'entitlement') {
    return withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Pre', familyName: 'Hire' },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: `pre-${resourceType}`,
          email: `pre-${resourceType}@acme.test`,
          displayName: 'Pre Hire',
          personId: person.id,
        },
      });
      const application = await tx.application.create({
        data: { tenantId, name: `App ${resourceType}`, slug: `app-${resourceType}` },
      });
      const group = await tx.group.create({ data: { tenantId, name: `G ${resourceType}` } });
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: `AD ${resourceType}`,
          secretName: `s/${resourceType}`,
          config: { tlsMode: 'ldaps' },
        },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: `guid-${resourceType}`,
          type: 'group',
          displayName: 'Finance',
        },
      });
      const resourceId =
        resourceType === 'application'
          ? application.id
          : resourceType === 'group'
            ? group.id
            : entitlement.id;
      const grant = await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType,
          resourceId,
          targetSystemId: resourceType === 'entitlement' ? target.id : null,
          startsAt: day('2026-06-20'),
          status: 'scheduled',
        },
      });
      return {
        grantId: grant.id,
        userId: user.id,
        applicationId: application.id,
        groupId: group.id,
        targetSystemId: target.id,
      };
    });
  }

  it('writes no assignment the day before the start date', async () => {
    // A scheduled grant confers NOTHING until its day. That half already
    // worked; the half that did not is the next case.
    const seeded = await preHire('application');
    const result = await runTickJob({ tenantId }, { now: day('2026-06-19') });
    expect(result.promoted).toBe(0);
    const state = await withTenant(tenantId, async (tx) => ({
      assignments: await tx.appAssignment.findMany(),
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: seeded.grantId } }),
    }));
    expect(state.assignments).toEqual([]);
    expect(state.grant.status).toBe('scheduled');
  });

  it('writes exactly one assignment on the day, and records it as the grant own row', async () => {
    // Nothing in the plan moved a grant out of `scheduled` before this pass
    // existed. The AppAssignment was written only `if (!window.scheduled)`
    // and never afterwards, `classifySweep` skips anything outside
    // IN_FORCE_GRANT_STATUSES, and the row occupied the one-live-grant slot
    // forever -- so the person could never be granted that resource again by
    // any route.
    const seeded = await preHire('application');
    const result = await runTickJob({ tenantId }, { now: day('2026-06-20') });
    expect(result.promoted).toBe(1);
    const state = await withTenant(tenantId, async (tx) => ({
      assignments: await tx.appAssignment.findMany(),
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: seeded.grantId } }),
    }));
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({ userId: seeded.userId });
    expect(state.grant.status).toBe('active');
    expect(state.grant.writtenRowIds).toEqual([state.assignments[0]!.id]);

    // Idempotent: the second tick finds nothing scheduled and writes nothing.
    const again = await runTickJob({ tenantId }, { now: day('2026-06-21') });
    expect(again.promoted).toBe(0);
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('moves an entitlement grant to pending and asks for a Provision run', async () => {
    const scheduler = schedulerStub();
    const seeded = await preHire('entitlement');
    const result = await runTickJob(
      { tenantId },
      { now: day('2026-06-20'), scheduler },
    );
    expect(result.promoted).toBe(1);
    const grant = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: seeded.grantId } }),
    );
    // `pending`, not `active`: nothing has confirmed it at the target yet,
    // and the console never claims somebody holds something they do not.
    expect(grant.status).toBe('pending');
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId: seeded.targetSystemId,
    });
  });
});

describe('runSweepJob', () => {
  it('previews and stops when the sweep needs confirming; the scheduler confirms nothing', async () => {
    // A POPULATION, and one grant to remove.
    //
    // The plan ran this against an empty tenant, where
    // `personsWithActiveContract` is 0 and the guard blocks HARD and
    // unconfirmably -- "no person in this tenant holds an active contract;
    // refusing to sweep anything" -- which is correct behaviour and the
    // opposite of what this case is named for. With a person and an expired
    // grant, the first-sweep axis makes it confirmable, which is the state
    // the scheduler must decline to confirm.
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: person.id,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-01'),
          status: 'active',
        },
      });
    });

    const result = await runSweepJob({ tenantId }, { now: NOW });
    const sweep = await withTenant(tenantId, (tx) =>
      tx.expirySweep.findUniqueOrThrow({ where: { id: result.sweepId } }),
    );
    expect(sweep.status).toBe('previewed');
    // The name of this case, asserted rather than implied.
    expect(sweep.requiresConfirmation).toBe(true);
    expect(sweep.confirmedByUserId).toBeNull();
  });
});

/**
 * The transaction rule, as a test rather than a convention.
 *
 * A static instrument, deliberately: a runtime probe for "is a Prisma
 * interactive transaction open on this connection" does not exist, and every
 * approximation of one is flaky enough to be worse than nothing. What IS
 * checkable, and what actually failed twice on this project, is a module
 * reaching for a transport at all.
 */
describe('nothing in the request path can send anything', () => {
  const DIR = 'packages/core/src/automate';

  /**
   * Comments and docstrings stripped before matching.
   *
   * Not cosmetic. `notify.ts`'s own docstring for `enqueueOutbox` explains
   * the rule by NAMING the forbidden symbols — "`sendMessage` takes a
   * `Transport` and no `TenantClient`, which is what makes the ordering
   * structural rather than remembered" — so a raw text match reports the one
   * module that documents the rule as the module that breaks it, and the test
   * fails on day one against correct code. A test that fails on its own
   * docstring gets "fixed" by relaxing its assertions, and then it certifies
   * nothing.
   */
  const codeOf = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('imports a transport in exactly one module, and it is the job module', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      if (file === 'jobs.ts') continue;
      if (
        /\b(sendMessage|queueMessage|deliverMessage|smtpTransport|Transport)\b/.test(
          codeOf(`${DIR}/${file}`),
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no send inside the text of any withTenant callback', () => {
    // Bracket-matched, not counted.
    //
    // The first draft compared occurrences of `withTenant(` against
    // occurrences of `});\n` — which appears after every object literal,
    // every `createMany` and every `map`, so `closed` exceeded `opened` by an
    // order of magnitude whether or not the send was inside a transaction.
    // The assertion could not fail. This walks each `withTenant(` call to its
    // matching close paren and asserts the span contains no send, so moving
    // one line into a callback fails it.
    const source = codeOf(`${DIR}/jobs.ts`);
    const SEND = /\b(sendMessage|queueMessage|deliverMessage)\s*\(/;

    const spans: [number, number][] = [];
    for (let i = source.indexOf('withTenant('); i !== -1; i = source.indexOf('withTenant(', i + 1)) {
      let depth = 0;
      let j = i + 'withTenant'.length;
      for (; j < source.length; j += 1) {
        if (source[j] === '(') depth += 1;
        else if (source[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      spans.push([i, j]);
    }
    // The fixture has to be capable of finding something. A `jobs.ts` with no
    // transactions at all would pass vacuously.
    expect(spans.length).toBeGreaterThan(0);
    expect(SEND.test(source)).toBe(true);

    const violations = spans
      .filter(([from, to]) => SEND.test(source.slice(from, to)))
      .map(([from]) => source.slice(0, from).split('\n').length);
    expect(violations).toEqual([]);
  });
});
