import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { fulfilRequest, handBackGrant } from './fulfil.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let personId: string;
let userId: string;
let applicationId: string;
let groupId: string;
let entitlementId: string;
let targetSystemId: string;
let workflowId: string;

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
  seedCounter = 0;

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
    const group = await tx.group.create({ data: { tenantId, name: 'Reading room' } });
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
        requestable: true,
      },
    });
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Immediate' },
    });
    return {
      personId: person.id,
      userId: user.id,
      applicationId: application.id,
      groupId: group.id,
      targetSystemId: target.id,
      entitlementId: entitlement.id,
      workflowId: workflow.id,
    };
  });
  ({ personId, userId, applicationId, groupId, targetSystemId, entitlementId, workflowId } =
    seeded);
});

/**
 * An approved request with one item, ready to fulfil.
 *
 * The product carries `audienceCondition: { all: [] }` -- "everybody with an
 * active contract" -- because `fulfilRequest` re-checks eligibility, and the
 * schema default of NULL means NOBODY. A fixture whose product is visible to
 * nobody would make every case in this file refuse for the wrong reason.
 *
 * The slug is made unique per call: `@@unique([tenantId, slug])` means two
 * calls with the same `kind` would otherwise raise P2002, and several cases
 * below deliberately seed two requests for the same resource.
 */
let seedCounter = 0;
async function seedRequest(
  kind: 'application' | 'localGroup' | 'targetEntitlement',
  over: { durationDays?: number | null } = {},
) {
  seedCounter += 1;
  const slug = `p-${kind}-${seedCounter}`;
  return withTenant(tenantId, async (tx) => {
    const resource =
      kind === 'application'
        ? { resourceType: 'application', resourceId: applicationId, targetSystemId: null }
        : kind === 'localGroup'
          ? { resourceType: 'group', resourceId: groupId, targetSystemId: null }
          : { resourceType: 'entitlement', resourceId: entitlementId, targetSystemId };

    const product = await tx.product.create({
      data: {
        tenantId,
        name: 'Product',
        slug,
        kind,
        workflowId,
        status: 'active',
        audienceCondition: { all: [] },
        durationMode: over.durationDays === undefined ? 'permanent' : 'fixed',
        defaultDurationDays: over.durationDays ?? null,
        maxDurationDays: null,
      },
    });
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        productId: product.id,
        subjectPersonId: personId,
        requestedByUserId: userId,
        requestedByPersonId: personId,
        status: 'approved',
        requestedDurationDays: over.durationDays ?? null,
      },
    });
    await tx.requestItem.create({ data: { tenantId, requestId: request.id, ...resource } });
    return request.id;
  });
}

describe('the application path', () => {
  it('writes an AppAssignment, an active grant and an audit event in one transaction', async () => {
    const requestId = await seedRequest('application');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('fulfilled');

    const state = await withTenant(tenantId, async (tx) => ({
      assignments: await tx.appAssignment.findMany({ where: { applicationId } }),
      grants: await tx.accessGrant.findMany(),
      items: await tx.requestItem.findMany(),
      audits: await tx.auditEvent.findMany({ where: { action: 'automate.grant.create' } }),
    }));
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({ subjectType: 'user', userId });
    // Written directly, so the grant is `active` and not `pending`: there is
    // no target to confirm anything with.
    expect(state.grants[0]).toMatchObject({ status: 'active', origin: 'request' });
    expect(state.items[0]?.status).toBe('fulfilled');
    expect(state.audits).toHaveLength(1);
  });

  it('assigns to every account the person holds, not an arbitrary one', async () => {
    // An application granted to a person is granted to that person. Picking
    // one of their logins is a support call waiting to happen.
    await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'anna.admin',
          email: 'anna.admin@acme.test',
          displayName: 'Anna Novak (admin)',
          personId,
        },
      }),
    );
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const assignments = await withTenant(tenantId, (tx) =>
      tx.appAssignment.findMany({ where: { applicationId } }),
    );
    expect(assignments).toHaveLength(2);
  });
});

describe('the local group path', () => {
  it('adds the membership and records the grant', async () => {
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships.map((m) => m.userId)).toEqual([userId]);
  });
});

describe('the target entitlement path', () => {
  it('writes a pending grant, dispatches the item, and enqueues a run for that target', async () => {
    const scheduler = schedulerStub();
    const requestId = await seedRequest('targetEntitlement');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW, scheduler });

    expect(outcome.status).toBe('awaiting_fulfilment');
    expect(outcome.targetSystemIds).toEqual([targetSystemId]);
    // Pending, not active. The console must never claim somebody holds
    // something they do not.
    const state = await withTenant(tenantId, async (tx) => ({
      grants: await tx.accessGrant.findMany(),
      items: await tx.requestItem.findMany(),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.grants[0]?.status).toBe('pending');
    expect(state.items[0]?.status).toBe('dispatched');
    expect(state.request.dispatchedAt).not.toBeNull();

    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('still commits when there is no scheduler to enqueue with', async () => {
    // The enqueue is not transactional and cannot be. A request that reached
    // awaiting_fulfilment with no run enqueued is picked up by reflection; a
    // request that rolled back because pg-boss was unreachable is an approval
    // silently undone.
    const requestId = await seedRequest('targetEntitlement');
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW, scheduler: null });
    expect(outcome.status).toBe('awaiting_fulfilment');
    const grants = await withTenant(tenantId, (tx) => tx.accessGrant.findMany());
    expect(grants).toHaveLength(1);
  });
});

describe('duration and what is already held', () => {
  it('carries the person who approved it onto the grant', async () => {
    // Read by the expiry warning, the lapse notice and the review flag. Left
    // null, every one of those reaches only the holder -- and the whole point
    // of the column is that the person who allowed this hears about it.
    const requestId = await seedRequest('application');
    const approverPersonId = await withTenant(tenantId, async (tx) => {
      const jan = await tx.person.create({
        data: { tenantId, givenName: 'Jan', familyName: 'Petersen' },
      });
      const step = await tx.approvalStep.create({
        data: { tenantId, requestId, sequence: 1, stageSnapshot: {}, status: 'approved' },
      });
      await tx.approvalDecision.create({
        data: {
          tenantId,
          stepId: step.id,
          personId: jan.id,
          decision: 'approve',
          via: 'selector',
        },
      });
      return jan.id;
    });

    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    expect(grant.approvedByPersonId).toBe(approverPersonId);
  });

  it('leaves the approver null on an auto-granted product, because nobody approved it', async () => {
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    expect(grant.approvedByPersonId).toBeNull();
  });

  it('gives a fixed-duration product an end date measured from the start', async () => {
    const requestId = await seedRequest('application', { durationDays: 30 });
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    expect(grant.endsAt).toEqual(day('2026-07-15'));
  });

  it('skips an item the subject already holds, names why, and still fulfils the rest', async () => {
    // Not a refusal. The already-held item is marked skipped with the source
    // of the existing holding, and the notification names it so the requester
    // is not left wondering.
    const requestId = await seedRequest('application');
    await withTenant(tenantId, async (tx) => {
      await tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId },
      });
      const request = await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } });
      await tx.requestItem.create({
        data: {
          tenantId,
          requestId: request.id,
          resourceType: 'group',
          resourceId: groupId,
          targetSystemId: null,
        },
      });
    });

    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('fulfilled');
    const items = await withTenant(tenantId, (tx) =>
      tx.requestItem.findMany({ orderBy: { resourceType: 'asc' } }),
    );
    const skipped = items.find((i) => i.resourceType === 'application');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.message).toContain('already');
    expect(items.find((i) => i.resourceType === 'group')?.status).toBe('fulfilled');
  });

  it('does not write a second live grant when one already exists', async () => {
    // The one-live-grant index would refuse it anyway; this is the code path
    // answering before the database has to.
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const second = await seedRequest('localGroup');
    await fulfilRequest(tenantId, second, { now: NOW });
    const grants = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findMany({ where: { status: 'active' } }),
    );
    expect(grants).toHaveLength(1);
  });
});

describe('fulfilment is the last place approval is enforceable', () => {
  it('refuses to fulfil a request that was never approved', async () => {
    // The item filter is `status === 'pending'`, which is exactly what a
    // never-approved request looks like. Without this guard, any caller
    // holding a request id bypasses the entire approval control -- and the
    // resulting grant is indistinguishable in the inventory from one somebody
    // approved.
    const requestId = await seedRequest('application');
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'pending_approval' },
      }),
    );
    await expect(fulfilRequest(tenantId, requestId, { now: NOW })).rejects.toThrow(
      /not approved/,
    );
    const grants = await withTenant(tenantId, (tx) => tx.accessGrant.findMany());
    expect(grants).toEqual([]);
  });

  it('refuses to fulfil a rejected request', async () => {
    const requestId = await seedRequest('application');
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({ where: { id: requestId }, data: { status: 'rejected' } }),
    );
    await expect(fulfilRequest(tenantId, requestId, { now: NOW })).rejects.toThrow();
    expect(await withTenant(tenantId, (tx) => tx.accessGrant.findMany())).toEqual([]);
  });

  it('re-checks eligibility and refuses when the subject left between approval and fulfilment', async () => {
    // Spec section 4: "An approval given on Monday for a finance product must
    // not fulfil on Friday after the subject left finance." The auto-grant
    // path is the one with no human on it -- it checks at the top of
    // submitRequest and fulfils in a SEPARATE transaction afterwards.
    const requestId = await seedRequest('application');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { endDate: day('2026-06-01') } }),
    );

    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('rejected');
    expect(await withTenant(tenantId, (tx) => tx.accessGrant.findMany())).toEqual([]);
    expect(
      await withTenant(tenantId, (tx) => tx.appAssignment.findMany({ where: { applicationId } })),
    ).toEqual([]);
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((o) => o.template)).toContain('automate-refused');
  });
});

describe('extending a grant in place', () => {
  it('supersedes the grant it replaces in one transaction, with no outage', async () => {
    // Spec section 12's "the case worth testing, because a naive
    // implementation expires the old grant, revokes at the target, and
    // re-grants an hour later, producing an outage and two audit events that
    // say the opposite of what happened". Without `replacesGrantId` being
    // read, this is WORSE than naive: the item is skipped as already held,
    // the request reports `fulfilled`, and the access simply goes away.
    const first = await seedRequest('localGroup');
    await fulfilRequest(tenantId, first, { now: NOW });
    const original = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());

    const extension = await seedRequest('localGroup');
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({
        where: { id: extension },
        data: { replacesGrantId: original.id },
      }),
    );
    const outcome = await fulfilRequest(tenantId, extension, { now: NOW });
    expect(outcome.grantIds).toHaveLength(1);

    const state = await withTenant(tenantId, async (tx) => ({
      old: await tx.accessGrant.findUniqueOrThrow({ where: { id: original.id } }),
      live: await tx.accessGrant.findMany({ where: { status: { in: ['pending', 'active'] } } }),
      memberships: await tx.groupMembership.findMany({ where: { groupId } }),
    }));
    expect(state.old.status).toBe('revoked');
    expect(state.old.supersededByGrantId).toBe(outcome.grantIds[0]);
    expect(state.live).toHaveLength(1);
    // The membership survived. The original is retired BEFORE the replacement
    // is created -- `access_grant_one_live` is an immediate unique index over
    // the four columns both rows share, so the other order raises P2002 -- but
    // both statements are in the one transaction, so no other transaction ever
    // observes an instant in which the person holds neither.
    expect(state.memberships).toHaveLength(1);
    // And the replacement OWNS that surviving row. The "look first" guard
    // writes nothing here, because the row is already there, so without the
    // inheritance the replacement records nothing and Task 13's sweep can
    // never remove it. Task 13 carries the end-to-end case.
    expect(state.live[0]?.writtenRowIds).toEqual(state.old.writtenRowIds);
    expect(state.live[0]?.writtenRowIds).toHaveLength(1);
  });

  it('leaves the request already_held when the grant it names is no longer live', async () => {
    const first = await seedRequest('localGroup');
    await fulfilRequest(tenantId, first, { now: NOW });
    const original = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    await handBackGrant(tenantId, userId, original.id, { now: NOW });

    const extension = await seedRequest('localGroup');
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.update({
        where: { id: extension },
        data: { replacesGrantId: original.id },
      }),
    );
    // Nothing to supersede, and nothing held either, so it is an ordinary
    // grant rather than a supersession.
    const outcome = await fulfilRequest(tenantId, extension, { now: NOW });
    expect(outcome.status).toBe('fulfilled');
    const after = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: original.id } }),
    );
    expect(after.supersededByGrantId).toBeNull();
  });
});

describe('the grant owns only the rows it wrote', () => {
  it('does not delete a membership an administrator added by hand', async () => {
    // Spec section 5's safety argument for Automate writing GroupMembership
    // at all is that Core's directory surface is its only other writer.
    // Deleting by (groupId, userId) breaks that in the other direction: a
    // membership added by hand after the grant was made disappears when the
    // grant expires, with an audit event saying the grant lapsed.
    const secondUserId = await withTenant(tenantId, async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna.admin',
          email: 'anna.admin@acme.test',
          displayName: 'Anna Novak (admin)',
          personId,
        },
      });
      return user.id;
    });
    // Added BEFORE the grant, by somebody else, for their own reason.
    await withTenant(tenantId, (tx) =>
      tx.groupMembership.create({ data: { tenantId, groupId, userId: secondUserId } }),
    );

    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    // One row written by this grant: the one for the account that did not
    // already have it.
    expect(grant.writtenRowIds).toHaveLength(1);

    await handBackGrant(tenantId, userId, grant.id, { now: NOW });

    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships.map((m) => m.userId)).toEqual([secondUserId]);

    const audit = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'automate.grant.hand_back' } }),
    );
    expect(audit.payload).toMatchObject({ rowsThisGrantWrote: 1, rowsRemoved: 1 });
  });
});

describe('notifications', () => {
  it('writes outbox rows and sends nothing', async () => {
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((o) => o.template)).toContain('automate-fulfilled');
    // Nothing has been sent: `sentAt` is null on every row, and this module
    // imports no transport at all.
    for (const row of outbox) expect(row.sentAt).toBeNull();
  });

  it('names the person, the product and the resource — never an identifier', async () => {
    // Spec section 13: "names what they now hold and until when". A mail
    // reading "guid-4f2a... holds guid-91be... until Mon Jun 15 2026"
    // satisfies none of it, and Automate sends more mail than the rest of the
    // platform combined. If this assertion is deleted, the ids come back.
    const requestId = await seedRequest('application');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    const row = outbox.find((o) => o.template === 'automate-fulfilled');
    const vars = row?.vars as Record<string, string>;
    expect(vars.subjectName).toBe('Anna Novak');
    expect(vars.resourceList).toBe('Stats');
    for (const [key, value] of Object.entries(vars)) {
      // `requestUrl` is the one var that MUST carry the id: it is a link to
      // this request, and a link without the id addresses nothing. The
      // property under test is that no var a human READS as prose is an
      // identifier -- the plan's blanket sweep would have failed against
      // correct code, because `/requests/<uuid>` is the correct value.
      if (key === 'requestUrl') continue;
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('records what was already held on a request where nothing new landed', async () => {
    // `submitRequest` refuses "every resource already held" up front, but a
    // request approved between the two checks reaches here. Reporting it
    // `fulfilled` with an empty resource list tells somebody they were given
    // something when nothing happened.
    const requestId = await seedRequest('application');
    await withTenant(tenantId, (tx) =>
      tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId },
      }),
    );
    const outcome = await fulfilRequest(tenantId, requestId, { now: NOW });
    expect(outcome.status).toBe('fulfilled');
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.statusReason).toContain('already held');
    expect(request.statusReason).toContain('Stats');
  });
});

describe('handBackGrant', () => {
  it('revokes the grant and removes the membership immediately, with no sweep', async () => {
    // A guard exists to catch mass action, and this is a person giving one
    // thing back.
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());

    await handBackGrant(tenantId, userId, grant.id, { now: NOW });

    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      memberships: await tx.groupMembership.findMany({ where: { groupId } }),
      audits: await tx.auditEvent.findMany({ where: { action: 'automate.grant.hand_back' } }),
    }));
    expect(state.grant.status).toBe('revoked');
    expect(state.grant.endedAt).not.toBeNull();
    expect(state.memberships).toEqual([]);
    expect(state.audits).toHaveLength(1);
  });

  it('enqueues a Provision run for a target entitlement rather than writing to the target', async () => {
    const scheduler = schedulerStub();
    const requestId = await seedRequest('targetEntitlement');
    await fulfilRequest(tenantId, requestId, { now: NOW, scheduler });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    scheduler.enqueue.mockClear();

    await handBackGrant(tenantId, userId, grant.id, { now: NOW, scheduler });

    const after = await withTenant(tenantId, (tx) =>
      tx.accessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    );
    // The grant leaves desired state; Provision proposes and applies the
    // revocation under its own guard. Automate writes no entitlement anywhere.
    expect(after.status).toBe('revoked');
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('is idempotent on a grant that is already revoked', async () => {
    const requestId = await seedRequest('localGroup');
    await fulfilRequest(tenantId, requestId, { now: NOW });
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());
    await handBackGrant(tenantId, userId, grant.id, { now: NOW });
    await handBackGrant(tenantId, userId, grant.id, { now: NOW });
    const audits = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.grant.hand_back' } }),
    );
    expect(audits).toHaveLength(1);
  });
});
