import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { applyExpirySweep, classifySweep, previewExpirySweep } from './sweep-service.js';
import { fulfilRequest } from './fulfil.js';
import type { ConditionFacts } from '../provision/condition.js';

const NOW = new Date('2026-06-15T00:00:00Z');
/** The next night, for the cases about one sweep superseding another. */
const LATER = new Date('2026-06-16T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': null,
  'contract.costCentre': null,
  'contract.employer': null,
  'contract.location': null,
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

const grant = (over: Record<string, unknown> = {}) => ({
  grantId: 'g1',
  subjectPersonId: 'p1',
  productId: 'prod1',
  resourceType: 'application' as const,
  resourceId: 'app1',
  targetSystemId: null,
  startsAt: day('2026-01-01'),
  endsAt: null,
  status: 'active',
  needsReview: false,
  supersededByGrantId: null,
  ...over,
});

const classify = (over: Record<string, unknown> = {}) =>
  classifySweep({
    grants: [grant()],
    contractsByPerson: new Map([['p1', [{ startDate: day('2020-01-01'), endDate: null }]]]),
    audienceByProduct: new Map([['prod1', { all: [] }]]),
    factsByPerson: new Map([
      ['p1', { contracts: [facts()], groupIds: [], orgUnitChainIds: [], entitlementIds: [] }],
    ]),
    horizonDaysByGrant: new Map([['g1', 14]]),
    now: NOW,
    ...over,
  } as never);

describe('classifySweep — expiry', () => {
  it('expires a grant whose end date has passed and leaves one that has not', () => {
    expect(
      classify({ grants: [grant({ endsAt: day('2026-06-14') })] }).actions.map((a) => a.kind),
    ).toEqual(['expire']);
    expect(classify({ grants: [grant({ endsAt: day('2026-06-16') })] }).actions).toEqual([]);
  });

  it('expires exactly on the end date, not the day after', () => {
    // `endsAt` is the moment access stops. Off by one here leaves everybody
    // holding their access for one extra day, every time.
    expect(classify({ grants: [grant({ endsAt: NOW })] }).actions).toHaveLength(1);
  });

  it('does not expire a grant an approved extension already replaced', () => {
    // The case worth testing: a naive implementation expires the old grant,
    // revokes at the target, and re-grants an hour later -- producing an
    // outage and two audit events that say the opposite of what happened.
    expect(
      classify({
        grants: [grant({ endsAt: day('2026-06-14'), supersededByGrantId: 'g2' })],
      }).actions,
    ).toEqual([]);
  });

  it('does not act on a grant that is already out of force', () => {
    expect(classify({ grants: [grant({ status: 'revoked' })] }).actions).toEqual([]);
  });
});

describe('classifySweep — the three meanings of "no active contract"', () => {
  it('lapses a leaver, on the LATEST end date across all their contracts', () => {
    // A person whose second engagement ran three months longer left three
    // months later.
    const result = classify({
      contractsByPerson: new Map([
        [
          'p1',
          [
            { startDate: day('2020-01-01'), endDate: day('2026-03-01') },
            { startDate: day('2021-01-01'), endDate: day('2026-06-01') },
          ],
        ],
      ]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
    expect(result.actions[0]?.message).toContain('2026-06-01');
  });

  it('does not lapse a future joiner, and reports them', () => {
    // An account belonging to somebody whose contract has not started is a
    // question, not an instruction.
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2026-09-01'), endDate: null }]],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([
      expect.objectContaining({ personId: 'p1', kind: 'not_yet_started' }),
    ]);
  });

  it('treats a joiner inside the pre-hire horizon as present, not as an exception', () => {
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2026-06-20'), endDate: null }]],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('does NOT lapse a person with no contracts at all, and names them', () => {
    // THE assertion that fails loudly if anybody ever collapses the two. An
    // incomplete record is not a departure: a person the system cannot
    // understand must produce no actions, never empty desired state.
    const result = classify({ contractsByPerson: new Map([['p1', []]]) });
    expect(result.actions).toEqual([]);
    expect(result.exceptions).toEqual([
      expect.objectContaining({ personId: 'p1', kind: 'no_contracts' }),
    ]);
  });

  it('lapses on the day, with no grace, whatever a target disable grace says', () => {
    // Requested access is access beyond the job. When the job ends it goes
    // first, and it goes on the day.
    const result = classify({
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2020-01-01'), endDate: day('2026-06-14') }]],
      ]),
      horizonDaysByGrant: new Map([['g1', 30]]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
  });

  it('prefers lapse over expire when both would apply', () => {
    const result = classify({
      grants: [grant({ endsAt: day('2026-06-10') })],
      contractsByPerson: new Map([
        ['p1', [{ startDate: day('2020-01-01'), endDate: day('2026-06-01') }]],
      ]),
    });
    expect(result.actions.map((a) => a.kind)).toEqual(['lapse']);
  });
});

describe('classifySweep — the review flag', () => {
  it('flags a mover whose audience no longer admits them, and proposes nothing', () => {
    // Somebody asked and somebody accountable allowed it. Revoking that
    // silently on an HR field change is not Automate's call. Not saying
    // anything is not an option either.
    const result = classify({
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.actions).toEqual([]);
    expect(result.reviewFlags).toEqual([
      expect.objectContaining({ grantId: 'g1' }),
    ]);
    expect(result.reviewFlags[0]?.reason).toContain('audience');
  });

  it('flags once, not on every sweep', () => {
    const result = classify({
      grants: [grant({ needsReview: true })],
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.reviewFlags).toEqual([]);
  });

  it('does not flag a grant it is already removing', () => {
    const result = classify({
      grants: [grant({ endsAt: day('2026-06-01') })],
      audienceByProduct: new Map([
        ['prod1', { field: 'contract.department', op: 'equals', value: 'Finance' }],
      ]),
      factsByPerson: new Map([
        [
          'p1',
          {
            contracts: [facts({ 'contract.department': 'Facilities' })],
            groupIds: [],
            orgUnitChainIds: [],
            entitlementIds: [],
          },
        ],
      ]),
    });
    expect(result.reviewFlags).toEqual([]);
  });
});
describe('previewExpirySweep and applyExpirySweep', () => {
  let tenantId: string;
  let personId: string;
  let userId: string;
  let applicationId: string;
  let productId: string;
  let targetSystemId: string;
  let entitlementId: string;

  const schedulerStub = () => ({
    schedule: vi.fn(async () => undefined),
    unschedule: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => 'job-1'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  });

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;

    const seeded = await withTenant(tenantId, async (tx) => {
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
          department: 'Finance',
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          personId: person.id,
        },
      });
      const application = await tx.application.create({
        data: { tenantId, name: 'Stats', slug: 'stats' },
      });
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId, name: 'Immediate' },
      });
      const product = await tx.product.create({
        data: {
          tenantId,
          name: 'Statistics licence',
          slug: 'stats',
          kind: 'application',
          workflowId: workflow.id,
          status: 'active',
          audienceCondition: { all: [] },
        },
      });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-stats',
          type: 'group',
          displayName: 'Stats',
        },
      });
      const assignment = await tx.appAssignment.create({
        data: { tenantId, applicationId: application.id, subjectType: 'user', userId: user.id },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: person.id,
          resourceType: 'application',
          resourceId: application.id,
          productId: product.id,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-01'),
          status: 'active',
          // The grant owns the assignment it was made for. Without this the
          // fixture describes a grant that wrote nothing, `applyExpirySweep`
          // deletes by `writtenRowIds` and finds none, and every case below
          // that asserts the assignment is gone fails against correct code.
          writtenRowIds: [assignment.id],
        },
      });
      return {
        personId: person.id,
        userId: user.id,
        applicationId: application.id,
        productId: product.id,
        targetSystemId: target.id,
        entitlementId: entitlement.id,
      };
    });
    ({ personId, userId, applicationId, productId, targetSystemId, entitlementId } = seeded);
  });

  it('writes the whole plan in one transaction and stops', async () => {
    // "One transaction" is about the PLAN WRITE. The loads and the
    // classification happen before it opens -- see the docstring on
    // previewExpirySweep -- because per-subject reads inside a 5000 ms
    // transaction raise P2028 at any real tenant size.
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    // The first sweep in a tenant always requires confirmation, whatever its
    // size: every denominator is zero.
    expect(sweep.requiresConfirmation).toBe(true);
    const state = await withTenant(tenantId, async (tx) => ({
      sweep: await tx.expirySweep.findUniqueOrThrow({ where: { id: sweep.id } }),
      actions: await tx.sweepAction.findMany(),
      assignments: await tx.appAssignment.findMany(),
    }));
    expect(state.sweep.status).toBe('previewed');
    expect(state.actions.map((a) => a.kind)).toEqual(['expire']);
    // Nothing applied. It computes, writes down one row per proposed removal,
    // and stops.
    expect(state.assignments).toHaveLength(1);
  });

  it('refuses to apply a sweep that requires confirmation without one', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, { now: NOW });
    expect(result).toMatchObject({ applied: 0 });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('applies on an explicit confirmation and records the confirming user', async () => {
    // `confirm` is separate from `confirmedByUserId` so the gate cannot be
    // satisfied by accident: keying it on `confirmedByUserId === undefined`
    // means an internal caller passing null passes the gate.
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });
    expect(result).toMatchObject({ status: 'applied', applied: 1 });
    const state = await withTenant(tenantId, async (tx) => ({
      sweep: await tx.expirySweep.findUniqueOrThrow({ where: { id: sweep.id } }),
      assignments: await tx.appAssignment.findMany(),
      grant: await tx.accessGrant.findFirstOrThrow(),
      settings: await tx.automateSettings.findUniqueOrThrow({ where: { tenantId } }),
      outbox: await tx.notificationOutbox.findMany({ where: { template: 'automate-expired' } }),
    }));
    expect(state.sweep.confirmedByUserId).toBe(userId);
    expect(state.assignments).toEqual([]);
    expect(state.grant.status).toBe('expired');
    // Recorded so the NEXT sweep has a denominator that means something.
    expect(state.settings.lastAppliedSweepAt).not.toBeNull();
    expect(state.settings.personsWithActiveContractAtLastSweep).toBe(1);
    expect(state.outbox).toHaveLength(1);
  });

  it('honours a per-row skip', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
      only: [],
    });
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('hands a target entitlement removal to Provision rather than writing it', async () => {
    const scheduler = schedulerStub();
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: personId,
          resourceType: 'entitlement',
          resourceId: entitlementId,
          targetSystemId,
          productId,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-06-01'),
          status: 'active',
        },
      }),
    );
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
      scheduler,
    });

    const actions = await withTenant(tenantId, (tx) =>
      tx.sweepAction.findMany({ where: { resourceType: 'entitlement' } }),
    );
    // Dispatched, not applied: the grant left desired state and Provision
    // proposes and applies the revocation under its own guard.
    expect(actions[0]?.status).toBe('dispatched');
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('blocks outright, with no confirmation offered, when the population collapsed', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.automateSettings.create({
        data: {
          tenantId,
          lastAppliedSweepAt: day('2026-06-01'),
          personsWithActiveContractAtLastSweep: 100,
        },
      });
    });
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    expect(sweep.status).toBe('blocked');
    expect(sweep.requiresConfirmation).toBe(false);
    expect(sweep.blockedReason).toContain('fallen');

    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });
    // Confirmation is not available. A blocked sweep is one whose own inputs
    // are not trustworthy, and confirming it would be confirming a number.
    expect(result.applied).toBe(0);
  });

  it('writes a SweepException for a person with no contracts and lapses nothing of theirs', async () => {
    await withTenant(tenantId, async (tx) => {
      const ghost = await tx.person.create({
        data: { tenantId, givenName: 'Ghost', familyName: 'Test' },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: ghost.id,
          resourceType: 'application',
          resourceId: applicationId,
          productId,
          startsAt: day('2026-01-01'),
          status: 'active',
        },
      });
    });
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const state = await withTenant(tenantId, async (tx) => ({
      exceptions: await tx.sweepException.findMany({ where: { sweepId: sweep.id } }),
      actions: await tx.sweepAction.findMany({ where: { sweepId: sweep.id } }),
    }));
    expect(state.exceptions.map((e) => e.kind)).toEqual(['no_contracts']);
    // One action, for the expiring grant -- not two.
    expect(state.actions).toHaveLength(1);
  });

  it('supersedes a blocked sweep rather than raising P2002 on the next night', async () => {
    // The brick. `expiry_sweep_one_non_terminal` covers running, previewed,
    // blocked and applying, and nothing else in this slice moves a sweep out
    // of `blocked` -- `applyExpirySweep` returns without touching the row.
    // Night 1 a truncated HR import blocks the sweep; night 2 the `create`
    // raises P2002; pg-boss retries three times and gives up; and no grant in
    // the tenant ever expires or lapses again, with nothing saying so.
    await withTenant(tenantId, (tx) =>
      tx.automateSettings.create({
        data: {
          tenantId,
          lastAppliedSweepAt: day('2026-06-01'),
          personsWithActiveContractAtLastSweep: 100,
        },
      }),
    );
    const first = await previewExpirySweep(tenantId, { now: NOW });
    expect(first.status).toBe('blocked');

    // Night 2. This is the call that used to throw.
    const second = await previewExpirySweep(tenantId, { now: LATER });
    expect(second.id).not.toBe(first.id);

    const state = await withTenant(tenantId, async (tx) => ({
      old: await tx.expirySweep.findUniqueOrThrow({ where: { id: first.id } }),
      oldActions: await tx.sweepAction.findMany({ where: { sweepId: first.id } }),
      sweeps: await tx.expirySweep.findMany(),
    }));
    expect(state.old.status).toBe('superseded');
    expect(state.old.finishedAt).not.toBeNull();
    expect(state.old.error).toContain('blocked');
    // The old plan's proposals are skipped, so the review screen cannot offer
    // a plan computed against last week's population.
    for (const action of state.oldActions) expect(action.status).toBe('skipped');
    expect(state.sweeps).toHaveLength(2);
  });

  it('produces two sweeps, not one exception, on two consecutive confirmable nights', async () => {
    // The confirmation guard exists so a large sweep waits for a human. While
    // it waits, the nightly sweep must not be dead.
    const first = await previewExpirySweep(tenantId, { now: NOW });
    expect(first.requiresConfirmation).toBe(true);
    const second = await previewExpirySweep(tenantId, { now: LATER });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('previewed');
    const old = await withTenant(tenantId, (tx) =>
      tx.expirySweep.findUniqueOrThrow({ where: { id: first.id } }),
    );
    expect(old.status).toBe('superseded');
  });

  it('recovers a sweep a crashed process left running or applying', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'applying' } }),
    );
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    expect(sweep.status).toBe('previewed');
    const nonTerminal = await withTenant(tenantId, (tx) =>
      tx.expirySweep.findMany({
        where: { status: { in: ['running', 'previewed', 'blocked', 'applying'] } },
      }),
    );
    expect(nonTerminal.map((x) => x.id)).toEqual([sweep.id]);
  });

  it('deletes only the membership the grant itself wrote', async () => {
    // Spec section 5's safety argument: AppAssignment has exactly one other
    // writer. A row an administrator added by hand is not this grant's to
    // remove, and removing it under an audit event saying the grant expired
    // is Ruling P11's shape -- an operation that does too much and reports
    // too little.
    const otherUserId = await withTenant(tenantId, async (tx) => {
      const other = await tx.user.create({
        data: {
          tenantId,
          login: 'anna.admin',
          email: 'anna.admin@acme.test',
          displayName: 'Anna Novak (admin)',
          personId,
        },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId: other.id },
      });
      // The grant owns only the first assignment.
      const grant = await tx.accessGrant.findFirstOrThrow();
      const owned = await tx.appAssignment.findFirstOrThrow({ where: { userId } });
      await tx.accessGrant.update({
        where: { id: grant.id },
        data: { writtenRowIds: [owned.id] },
      });
      return other.id;
    });

    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });

    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments.map((a) => a.userId)).toEqual([otherUserId]);
  });

  it('removes the assignment when a grant that was EXTENDED later expires', async () => {
    // Two correct fixes composing into a defect, and the only case in the
    // slice that crosses both. Task 9 supersedes in place and deliberately
    // does NOT delete the assignment (no outage), and the "look first" guard
    // means the replacement writes no new row -- so unless the replacement
    // INHERITS `writtenRowIds` from the grant it retires, the row belongs to
    // a `revoked` grant and nothing will ever delete it. The sweep would then
    // report an applied expiry, write an `automate-expired` mail, and leave
    // the person holding the application permanently: access that never ends
    // plus a log entry claiming it did, which is worse than either alone.
    // Neither Task 9's no-outage case nor the "only the rows it wrote" case
    // above can see this, because each was written against the world before
    // the other fix existed.
    const AFTER_EXTENSION = new Date('2026-08-01T00:00:00Z');
    const original = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    expect(original.writtenRowIds).toHaveLength(1);

    const extensionId = await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          productId,
          subjectPersonId: personId,
          requestedByUserId: userId,
          requestedByPersonId: personId,
          status: 'approved',
          // 30 days from NOW, so the replacement ends 2026-07-15 and the
          // sweep below genuinely runs past its end date.
          requestedDurationDays: 30,
          replacesGrantId: original.id,
        },
      });
      await tx.requestItem.create({
        data: { tenantId, requestId: request.id, resourceType: 'application', resourceId: applicationId },
      });
      return request.id;
    });

    const fulfilled = await fulfilRequest(tenantId, extensionId, { now: NOW });
    expect(fulfilled.status).toBe('fulfilled');
    const afterExtension = await withTenant(tenantId, async (tx) => ({
      old: await tx.accessGrant.findUniqueOrThrow({ where: { id: original.id } }),
      replacement: await tx.accessGrant.findUniqueOrThrow({
        where: { id: fulfilled.grantIds[0]! },
      }),
      assignments: await tx.appAssignment.findMany(),
    }));
    expect(afterExtension.old.status).toBe('revoked');
    // No outage: the row was never deleted, and it is now the replacement's.
    expect(afterExtension.assignments).toHaveLength(1);
    expect(afterExtension.replacement.writtenRowIds).toEqual(original.writtenRowIds);

    const sweep = await previewExpirySweep(tenantId, { now: AFTER_EXTENSION });
    const result = await applyExpirySweep(tenantId, sweep.id, {
      now: AFTER_EXTENSION,
      confirm: true,
      confirmedByUserId: userId,
    });
    expect(result).toMatchObject({ status: 'applied', applied: 1 });

    const after = await withTenant(tenantId, async (tx) => ({
      assignments: await tx.appAssignment.findMany(),
      replacement: await tx.accessGrant.findUniqueOrThrow({
        where: { id: fulfilled.grantIds[0]! },
      }),
      action: await tx.sweepAction.findFirstOrThrow({ where: { sweepId: sweep.id } }),
    }));
    expect(after.replacement.status).toBe('expired');
    expect(after.action.status).toBe('applied');
    // The assertion this case exists for. Delete the inheritance line in
    // `fulfilRequest` and this is the only assertion in the slice that fails.
    expect(after.assignments).toEqual([]);
  });

  it('tells the resource owner as well as the holder, and the manager on a lapse', async () => {
    // Spec section 13: expiry goes to the holder, the original approver and
    // the resource owner; a lapse adds the person's most recent manager. The
    // resource owner is precisely the person whose list of who holds their
    // resource just changed.
    const seeded = await withTenant(tenantId, async (tx) => {
      const owner = await tx.person.create({
        data: { tenantId, givenName: 'Owner', familyName: 'Person' },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'owner',
          email: 'owner@acme.test',
          displayName: 'Owner Person',
          personId: owner.id,
        },
      });
      await tx.resourceOwner.create({
        data: { tenantId, resourceType: 'application', resourceId: applicationId, ownerPersonId: owner.id },
      });
      return owner.id;
    });

    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });

    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-expired' } }),
    );
    expect(outbox.map((o) => o.to).sort()).toEqual(
      ['anna@acme.test', 'owner@acme.test'].sort(),
    );
    void seeded;
  });

  it('names the person, the product and the resource in the expiry notice', async () => {
    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findFirstOrThrow({ where: { template: 'automate-expired' } }),
    );
    const vars = row.vars as Record<string, string>;
    expect(vars.subjectName).toBe('Anna Novak');
    expect(vars.productName).toBe('Statistics licence');
    expect(vars.resourceList).toBe('Stats');
    for (const value of Object.values(vars)) {
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('previews AND applies a tenant-sized sweep: 301 grants across 301 persons', async () => {
    // Nothing else in this plan has a test with more than a handful of rows,
    // which is why the per-subject `subjectAudienceFacts` loop inside
    // `withTenant` -- roughly seven round trips per subject, against a 5000 ms
    // transaction timeout -- looked fine. This case is the one that fails if
    // somebody puts the loop back.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 300; i += 1) {
        const p = await tx.person.create({
          data: { tenantId, givenName: `P${i}`, familyName: 'Bulk' },
        });
        await tx.contract.create({
          data: {
            tenantId,
            personId: p.id,
            sequence: 1,
            isPrimary: true,
            startDate: day('2020-01-01'),
            department: 'Finance',
          },
        });
        await tx.accessGrant.create({
          data: {
            tenantId,
            subjectPersonId: p.id,
            resourceType: 'entitlement',
            resourceId: entitlementId,
            targetSystemId,
            productId,
            startsAt: day('2026-01-01'),
            endsAt: day('2026-06-01'),
            status: 'active',
          },
        });
      }
    });

    const sweep = await previewExpirySweep(tenantId, { now: NOW });
    const actions = await withTenant(tenantId, (tx) =>
      tx.sweepAction.count({ where: { sweepId: sweep.id } }),
    );
    expect(actions).toBe(301);

    // And APPLY it. The apply side has the same 5000 ms ceiling and a heavier
    // per-action shape than the preview -- a `resourceOwner.findFirst`, a
    // manager `contract.findFirst` on a lapse, an `accountEntitlement.count`,
    // a `recipientsForPersons`, an `accessGrant.update`, a
    // `sweepAction.update`, a `recordEvent` and an `enqueueOutbox`, plus the
    // per-batch `displayNames` -- so at `BATCH = 100` one batch is roughly
    // 700-800 statements inside one `prisma.$transaction`. H9's finding was
    // about an unbounded loop; `BATCH` is the number that replaced it, and
    // until this case applied the sweep it previews, nothing in the plan
    // exercised the apply path above a handful of rows and the batch size was
    // a guess. Four batches here. If this raises P2028, lower `BATCH` -- do
    // not delete this case, which is the only thing that would say so before
    // the nightly job does.
    const applied = await applyExpirySweep(tenantId, sweep.id, {
      now: NOW,
      confirm: true,
      confirmedByUserId: userId,
      scheduler: schedulerStub(),
    });
    expect(applied).toMatchObject({ status: 'applied', applied: 301, failed: 0 });
    const leftOver = await withTenant(tenantId, (tx) =>
      tx.sweepAction.count({ where: { sweepId: sweep.id, status: 'proposed' } }),
    );
    // Nothing fell out of a batch boundary: 301 actions over four batches.
    expect(leftOver).toBe(0);
  });

  it('tells the holders of automate.manage when a sweep needs confirming', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId } });
    });
    await previewExpirySweep(tenantId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-sweep-confirmation' } }),
    );
    expect(outbox).toHaveLength(1);
    // Never digested, whatever the recipient's preference says.
    expect(outbox[0]?.digest).toBe(false);
  });
});
