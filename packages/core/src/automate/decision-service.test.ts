import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createProduct } from './catalog-service.js';
import { upsertWorkflow } from './workflow-service.js';
import { submitRequest } from './request-service.js';
import {
  APPROVED_ENTRY_POINTS,
  DecisionRefusedError,
  cancelRequest,
  recordDecision,
} from './decision-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const LATER = new Date('2026-06-18T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;
let janPersonId: string;
let janUserId: string;
let boPersonId: string;
let boUserId: string;
let applicationId: string;
let productId: string;

async function person(name: string, over: { manager?: string } = {}) {
  return withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: p.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        ...(over.manager === undefined ? {} : { managerPersonId: over.manager }),
      },
    });
    const u = await tx.user.create({
      data: {
        tenantId,
        login: name.toLowerCase(),
        email: `${name.toLowerCase()}@acme.test`,
        displayName: name,
        personId: p.id,
      },
    });
    return { personId: p.id, userId: u.id };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  ({ personId: janPersonId, userId: janUserId } = await person('Jan'));
  ({ personId: boPersonId, userId: boUserId } = await person('Bo'));
  ({ personId: annaPersonId, userId: annaUserId } = await person('Anna', {
    manager: janPersonId,
  }));

  applicationId = await withTenant(tenantId, async (tx) =>
    (await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } })).id,
  );

  const workflow = await upsertWorkflow(tenantId, null, null, {
    name: 'Two stage',
    description: null,
    enabled: true,
    stages: [
      {
        sequence: 1,
        name: 'Manager',
        selector: 'manager',
        selectorConfig: {},
        quorum: 'any',
        fallbackSelector: 'person',
        fallbackConfig: { personId: boPersonId },
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
      {
        sequence: 2,
        name: 'Security',
        selector: 'person',
        selectorConfig: { personId: boPersonId },
        quorum: 'any',
        fallbackSelector: null,
        fallbackConfig: {},
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
    ],
  });

  productId = (
    await createProduct(tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: workflow.id,
      formSchema: [],
      durationMode: 'requesterChoice',
      defaultDurationDays: 30,
      maxDurationDays: 90,
      ownerPersonId: janPersonId,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;
});

async function open() {
  const outcome = await submitRequest(
    tenantId,
    {
      productId,
      subjectPersonId: annaPersonId,
      requestedByUserId: annaUserId,
      justification: 'Q3 audit',
      formValues: {},
      requestedDurationDays: 30,
    },
    { now: NOW },
  );
  if (!outcome.ok) throw new Error(`submit refused: ${outcome.reason}`);
  return outcome.requestId;
}

describe('recordDecision — walking the stages', () => {
  it('closes stage one, opens stage two, and does not fulfil yet', async () => {
    const requestId = await open();
    const result = await recordDecision(
      tenantId,
      {
        requestId,
        deciderPersonId: janPersonId,
        deciderUserId: janUserId,
        decision: 'approve',
        comment: null,
        shortenedToDays: null,
        sourceIp: null,
      },
      { now: LATER },
    );
    expect(result.status).toBe('pending_approval');

    const steps = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } }),
    );
    expect(steps.map((s) => s.status)).toEqual(['approved', 'open']);
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toEqual([]);
  });

  it('fulfils once the last stage is decided in favour', async () => {
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('fulfilled');
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('ends the request on a rejection at any stage, with no reject-and-continue', async () => {
    const requestId = await open();
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'reject', comment: 'not this quarter', shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('rejected');
    const steps = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } }),
    );
    expect(steps.map((s) => s.status)).toEqual(['rejected', 'skipped']);
  });

  it('refuses a rejection with no comment', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'reject', comment: '   ', shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('comment-required');
  });

  it('lets an approver shorten a duration and records it on the decision', async () => {
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: 7, sourceIp: null },
      { now: LATER },
    );
    const state = await withTenant(tenantId, async (tx) => ({
      decision: await tx.approvalDecision.findFirstOrThrow(),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.decision.shortenedToDays).toBe(7);
    expect(state.request.requestedDurationDays).toBe(7);
  });

  it('refuses an approver trying to lengthen', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: 365, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('duration');
  });

  it('requires every approver under an all quorum', async () => {
    const groupId = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
      for (const userId of [janUserId, boUserId]) {
        await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId } });
      }
      return group.id;
    });
    const workflow = await upsertWorkflow(tenantId, null, null, {
      name: 'Unanimous',
      description: null,
      enabled: true,
      stages: [
        {
          sequence: 1,
          name: 'Security',
          selector: 'group',
          selectorConfig: { groupId },
          quorum: 'all',
          fallbackSelector: null,
          fallbackConfig: {},
          slaHours: 48,
          onTimeout: 'remind',
          escalationSelector: null,
          escalationConfig: {},
          expiryHours: null,
        },
      ],
    });
    await withTenant(tenantId, (tx) =>
      tx.product.update({ where: { id: productId }, data: { workflowId: workflow.id } }),
    );
    const requestId = await open();

    const first = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(first.status).toBe('pending_approval');
    const second = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(second.status).toBe('fulfilled');
  });
});

describe('the invariant, at the moment of decision', () => {
  it('refuses a decision from the subject even when they are in the resolved set', async () => {
    // Materialized rows are the record of who it was WITH; they are not the
    // authorisation. The check runs again here.
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      const step = await tx.approvalStep.findFirstOrThrow({ where: { requestId, sequence: 1 } });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: annaPersonId, via: 'selector' },
      });
    });
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: annaPersonId, deciderUserId: annaUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses a decision from the on-behalf submitter', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Helpdesk', permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });
    const outcome = await submitRequest(
      tenantId,
      {
        productId,
        subjectPersonId: annaPersonId,
        requestedByUserId: boUserId,
        justification: 'for Anna',
        formValues: {},
        requestedDurationDays: 30,
      },
      { now: NOW },
    );
    if (!outcome.ok) throw new Error('unreachable');
    await recordDecision(
      tenantId,
      { requestId: outcome.requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    // Stage 2 names Bo by person, and Bo is the submitter -- so the RESOLVER
    // already dropped him and the stage opened with nobody, leaving the
    // request `blocked_no_approver`. That is the invariant working one step
    // earlier, and it is the stronger outcome; but it means the plan's
    // fixture never reached the DECISION-time check it is named for, and
    // answered `not-open` instead.
    //
    // So put him on the step by hand, exactly as the sibling case does for the
    // subject. Materialized rows are the record of who it was with; they are
    // not the authorisation, and this is the assertion that says so.
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: outcome.requestId },
        data: { status: 'pending_approval' },
      });
      const step = await tx.approvalStep.findFirstOrThrow({
        where: { requestId: outcome.requestId, sequence: 2 },
      });
      await tx.approvalStep.update({ where: { id: step.id }, data: { status: 'open' } });
      await tx.approvalStepApprover.create({
        data: { tenantId, stepId: step.id, personId: boPersonId, via: 'selector' },
      });
    });
    const failure = await recordDecision(
      tenantId,
      { requestId: outcome.requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses a decision from somebody who was resolved and has since been deactivated', async () => {
    // Deactivation revokes sessions in Core, which covers most of it. "Most of
    // it" is not a security control, so the check is repeated at the act.
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: janUserId }, data: { status: 'inactive' } }),
    );
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('approver-invalid');
  });

  it('refuses a decision from somebody who was never on the step at all', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-an-approver');
  });
});

describe('re-checking eligibility between the stages', () => {
  it('refuses the request when the subject stops matching the audience mid-flight', async () => {
    // An approval given on Monday for a finance product must not fulfil on
    // Friday after the subject left finance.
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    const result = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(result.status).toBe('rejected');
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.statusReason).toContain('no_longer_eligible');
  });

  it('tells the approver who already decided that their approval was made moot', async () => {
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-refused' } }),
    );
    expect(outbox.map((o) => o.to)).toContain('jan@acme.test');
  });

  it('re-resolves an open stage when the subject manager changed', async () => {
    // Decisions already recorded on COMPLETED stages stand -- they were valid
    // when made. The open one is reassigned, and both parties are told.
    const { personId: rikPersonId } = await person('Rik');
    const requestId = await open();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: rikPersonId },
      }),
    );
    const rikUserId = (
      await withTenant(tenantId, (tx) =>
        tx.user.findFirstOrThrow({ where: { personId: rikPersonId } }),
      )
    ).id;
    // NOT swallowed. The plan wrote `.catch(() => undefined)` here, which is
    // what let this case pass against a service that never re-resolved
    // anything: the decision threw `not-an-approver`, the error was discarded,
    // and the assertion below then read a set nothing had touched. Rik is the
    // manager now, so this must SUCCEED.
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: rikPersonId, deciderUserId: rikUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    // Rik is not on the materialized set until the stage is re-resolved, which
    // is what the reassignment does; the old approver is gone afterwards.
    const approvers = await withTenant(tenantId, (tx) =>
      tx.approvalStepApprover.findMany({ where: { step: { requestId, sequence: 1 } } }),
    );
    expect(approvers.map((a) => a.personId)).toEqual([rikPersonId]);
  });
});

describe('an administrator deciding a blocked request', () => {
  it('records the decision with the administrator named, and still applies the invariant', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: boUserId } });
    });

    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: 'fixed by hand', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    );
    const decision = await withTenant(tenantId, (tx) => tx.approvalDecision.findFirstOrThrow());
    expect(decision.via).toBe('administrator');

    // And the subject still cannot do it, administrator or not.
    const second = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: second },
        data: { status: 'blocked_no_approver' },
      });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'Automate admin' } });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: annaUserId } });
    });
    const failure = await recordDecision(
      tenantId,
      { requestId: second, deciderPersonId: annaPersonId, deciderUserId: annaUserId, decision: 'approve', comment: 'me', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('self-approval');
  });

  it('refuses an administrator override on a request that is not blocked', async () => {
    const requestId = await open();
    const failure = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: 'x', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    ).catch((e: unknown) => e);
    expect((failure as DecisionRefusedError).code).toBe('not-blocked');
  });

  /**
   * The two-stage blocked request, which nothing tested.
   *
   * `recordDecision` returns `pending_approval` for it and used to leave the
   * row on `blocked_no_approver`, so the mail went out to stage 2's approvers
   * and every one of them was refused `not-open` on arrival. The request could
   * then only be moved by a second administrative override -- which is refused
   * too, because the step it would take is `open` rather than `waiting`.
   */
  it('leaves a request PENDING, not blocked, when the administrator opens a second stage', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      // Stage 1 blocked: nobody materialized on it.
      await tx.approvalStepApprover.deleteMany({ where: { step: { requestId } } });
      await tx.approvalStep.updateMany({
        where: { requestId, sequence: 1 },
        data: { status: 'waiting' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      // JAN, who decides below. Bo is stage 2's approver and the party this
      // case is about NOT being mailed prematurely; granting the override to
      // Bo left Jan without it, and the case died on `not-permitted` at the
      // gate rather than reaching the behaviour it was written for.
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: janUserId } });
    });

    const result = await recordDecision(
      tenantId,
      {
        requestId,
        deciderPersonId: janPersonId,
        deciderUserId: janUserId,
        decision: 'approve',
        comment: 'stage one has nobody; approving by hand',
        shortenedToDays: null,
        sourceIp: null,
      },
      { now: LATER, asAdministrator: true },
    );
    expect(result.status).toBe('pending_approval');

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      steps: await tx.approvalStep.findMany({
        where: { requestId },
        orderBy: { sequence: 'asc' },
      }),
    }));
    expect(state.request.status).toBe('pending_approval');
    expect(state.request.statusReason).toBeNull();
    expect(state.steps.map((s) => s.status)).toEqual(['approved', 'open']);
  });

  /**
   * And stage 2's approver can actually decide it. This is the assertion the
   * defect was really about: the mail was sent either way, and what the
   * recipient met was a 'not-open' refusal.
   */
  it('lets the second stage approver decide after an administrative unblock', async () => {
    const requestId = await open();
    await withTenant(tenantId, async (tx) => {
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'blocked_no_approver' },
      });
      await tx.approvalStepApprover.deleteMany({ where: { step: { requestId } } });
      await tx.approvalStep.updateMany({
        where: { requestId, sequence: 1 },
        data: { status: 'waiting' },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: janUserId } });
    });
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: 'by hand', shortenedToDays: null, sourceIp: null },
      { now: LATER, asAdministrator: true },
    );

    const second = await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    expect(second.status).toBe('fulfilled');
  });
});

describe('cancelRequest', () => {
  it('withdraws before approval and tells the open stage approvers', async () => {
    const requestId = await open();
    await cancelRequest(tenantId, requestId, annaUserId, { now: LATER });
    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-cancelled' },
      }),
    }));
    expect(state.request.status).toBe('cancelled');
    expect(state.outbox.map((o) => o.to)).toEqual(['jan@acme.test']);
  });

  it('refuses to cancel after approval', async () => {
    // After approval the honest act is to hand the access back, which is its
    // own recorded event, not a race with an apply in flight.
    const requestId = await open();
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: janPersonId, deciderUserId: janUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    await recordDecision(
      tenantId,
      { requestId, deciderPersonId: boPersonId, deciderUserId: boUserId, decision: 'approve', comment: null, shortenedToDays: null, sourceIp: null },
      { now: LATER },
    );
    const failure = await cancelRequest(tenantId, requestId, annaUserId, { now: LATER }).catch(
      (e: unknown) => e,
    );
    expect((failure as DecisionRefusedError).code).toBe('too-late');
  });

  it('refuses a cancel by somebody who is not the requester', async () => {
    const requestId = await open();
    const failure = await cancelRequest(tenantId, requestId, boUserId, { now: LATER }).catch(
      (e: unknown) => e,
    );
    expect((failure as DecisionRefusedError).code).toBe('not-the-requester');
  });
});

/**
 * The structural test, in the shape of Provision's never-deletes test.
 *
 * Not a behaviour test: a behaviour test proves that the paths that exist
 * today behave. This proves that no OTHER path can exist. Adding a
 * timeout-approval later fails here rather than passing review.
 */
describe('no transition into approved exists that is not caused by a decision', () => {
  const FILES = [
    'packages/core/src/automate/decision-service.ts',
    'packages/core/src/automate/request-service.ts',
    'packages/core/src/automate/jobs.ts',
    'packages/core/src/automate/sweep-service.ts',
    'packages/core/src/automate/reflect.ts',
    'packages/core/src/automate/delegation-service.ts',
    'packages/core/src/automate/fulfil.ts',
    'packages/core/src/automate/eligibility.ts',
  ];

  /**
   * The source with every comment blanked out, so a docstring that QUOTES the
   * rule is not read as breaking it. `jobs.ts` says in its own comment that it
   * never approves anything, and it says so by naming the literal; without
   * this, that sentence puts `jobs.ts` in the offending set and the test fails
   * on the module whose comment states the constraint. This is the same trap
   * Task 15's transaction-rule test hit and the same remedy. Newlines are
   * preserved inside blanked block comments so the reported line numbers still
   * point at the real line.
   */
  const codeOf = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/.*$/gm, '');

  it('writes status approved only at the declared entry points', () => {
    // Matches BOTH spellings. `request-service.ts` assigns to a local first
    // -- `status = 'approved';` -- and then writes `data: { status, ... }`, so
    // a regex anchored on `status:` finds it nowhere and finds
    // `decision-service.ts`'s and `delegation-service.ts`'s literals instead.
    // The first draft of this test asserted a length of two and passed for
    // entirely the wrong reason while its named-file assertion failed. A
    // structural test that certifies the wrong set is worse than no
    // structural test.
    const hits: string[] = [];
    for (const file of FILES) {
      let source: string;
      try {
        source = codeOf(file);
      } catch {
        // A module this plan has not written yet cannot contain a violation.
        continue;
      }
      for (const [index, line] of source.split('\n').entries()) {
        // EITHER quote style. The first version of this matched `'approved'`
        // only, and prettier's default is double quotes -- so a module whose
        // write had been reformatted dropped silently out of the offending
        // set. That is the wrong direction for a guard: a FOURTH entry point
        // written as `status: "approved"` would have been invisible to it,
        // which is the failure this test exists to make impossible.
        if (/status\s*[:=]\s*['"]approved['"]/.test(line)) {
          hits.push(`${file}:${index + 1}`);
        }
      }
    }

    // Three entry points, and the list is `APPROVED_ENTRY_POINTS` in the
    // service, not a literal here, so adding one is an edit somebody makes
    // deliberately in the module that owns the rule:
    //
    //   request-service.ts    the zero-stage workflow, where the empty stage
    //                         list IS the grant and the catalog says
    //                         "granted immediately" before anybody asks.
    //   decision-service.ts   the last stage decided in favour by a person.
    //   delegation-service.ts a delegated administrative act, which spec
    //                         section 14 defines as a request with no
    //                         approval stages -- the same mechanism as the
    //                         first, reached from the portal.
    //
    // Nowhere else. Not a timeout, not a sweep, not a job, not a reflection.
    // The assertion is over the SET OF FILES, and there is deliberately no
    // assertion on `hits.length`. `hits` is one entry per matching line, not
    // per file: `decision-service.ts` alone matches three -- the ApprovalStep
    // closing, the AccessRequest transition and the returned verdict -- and
    // only one of those is "a transition of the request into approved". A
    // count over lines certifies a number nobody will maintain and fails the
    // next time somebody splits a statement across two lines. Global
    // Constraint 13 is a statement about WHICH MODULES may write it, and that
    // is exactly what this compares. Add a fourth file and the set gains a
    // member; delete the write from one of the three and it loses one.
    const files = new Set(hits.map((h) => h.slice(0, h.lastIndexOf(':'))));
    // Compared against the entry points that EXIST, by the same rule the
    // `catch` above applies to the scan: a module this plan has not written
    // yet cannot contain a violation, and it cannot contain the required
    // write either. `delegation-service.ts` arrives in Task 14; from the
    // moment it does, it must carry the write or this fails -- which is the
    // property wanted. Comparing against the unfiltered list would make this
    // test red for three tasks for a reason that is not a defect, and a test
    // that is expected to be red is a test nobody reads.
    const expected = APPROVED_ENTRY_POINTS.filter((file) => {
      try {
        readFileSync(file, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    expect([...files].sort()).toEqual([...expected].sort());
  });

  it('has no onTimeout value that could mean approve', () => {
    const source = readFileSync('packages/core/src/automate/approvers.ts', 'utf8');
    expect(source).toContain("'remind' | 'escalate' | 'expire'");
    expect(source).not.toMatch(/onTimeout[^\n]*approve/);
  });
});
