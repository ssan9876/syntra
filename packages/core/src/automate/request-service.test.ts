import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createProduct } from './catalog-service.js';
import { upsertWorkflow } from './workflow-service.js';
import { submitRequest } from './request-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;
let janPersonId: string;
let helpdeskUserId: string;
let helpdeskPersonId: string;
let applicationId: string;
let productId: string;
let immediateProductId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const jan = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
    });
    await tx.contract.create({
      data: { tenantId, personId: jan.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
    });
    await tx.user.create({
      data: { tenantId, login: 'jan', email: 'jan@acme.test', displayName: 'Jan de Vries', personId: jan.id },
    });

    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        managerPersonId: jan.id,
      },
    });
    const annaUser = await tx.user.create({
      data: { tenantId, login: 'anna', email: 'anna@acme.test', displayName: 'Anna Novak', personId: anna.id },
    });

    const helpdesk = await tx.person.create({
      data: { tenantId, givenName: 'Hel', familyName: 'Desk' },
    });
    await tx.contract.create({
      data: { tenantId, personId: helpdesk.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
    });
    const helpdeskUser = await tx.user.create({
      data: { tenantId, login: 'hel', email: 'hel@acme.test', displayName: 'Hel Desk', personId: helpdesk.id },
    });

    const application = await tx.application.create({
      data: { tenantId, name: 'Stats', slug: 'stats' },
    });
    return {
      annaPersonId: anna.id,
      annaUserId: annaUser.id,
      janPersonId: jan.id,
      helpdeskPersonId: helpdesk.id,
      helpdeskUserId: helpdeskUser.id,
      applicationId: application.id,
    };
  });
  ({ annaPersonId, annaUserId, janPersonId, helpdeskPersonId, helpdeskUserId, applicationId } =
    seeded);

  const withStage = await upsertWorkflow(tenantId, null, null, {
    name: 'Manager approval',
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
        fallbackConfig: { personId: janPersonId },
        slaHours: 48,
        onTimeout: 'remind',
        escalationSelector: null,
        escalationConfig: {},
        expiryHours: null,
      },
    ],
  });
  const immediate = await upsertWorkflow(tenantId, null, null, {
    name: 'Granted immediately',
    description: null,
    enabled: true,
    stages: [],
  });

  productId = (
    await createProduct(tenantId, null, {
      name: 'Statistics licence',
      slug: 'statistics-licence',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      workflowId: withStage.id,
      formSchema: [{ key: 'project', type: 'text', label: 'Project', required: true }],
      durationMode: 'requesterChoice',
      defaultDurationDays: 30,
      maxDurationDays: 90,
      ownerPersonId: janPersonId,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;

  immediateProductId = (
    await createProduct(tenantId, null, {
      name: 'Reading room',
      slug: 'reading-room',
      kind: 'application',
      grants: [{ resourceType: 'application', resourceId: applicationId }],
      audienceCondition: { all: [] },
      workflowId: immediate.id,
      formSchema: [],
      durationMode: 'permanent',
      defaultDurationDays: null,
      maxDurationDays: null,
      ownerPersonId: null,
      ownerGroupId: null,
      status: 'active',
    })
  ).id;
});

const submit = (over: Record<string, unknown> = {}) =>
  submitRequest(
    tenantId,
    {
      productId,
      subjectPersonId: annaPersonId,
      requestedByUserId: annaUserId,
      justification: 'Q3 audit',
      formValues: { project: 'Audit' },
      requestedDurationDays: 30,
      ...over,
    },
    { now: NOW },
  );

describe('submitRequest — the happy path', () => {
  it('writes the request, one item per product grant, and one step per stage', async () => {
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, status: 'pending_approval' });
    if (!outcome.ok) throw new Error('unreachable');

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
      items: await tx.requestItem.findMany({ where: { requestId: outcome.requestId } }),
      steps: await tx.approvalStep.findMany({ where: { requestId: outcome.requestId } }),
      approvers: await tx.approvalStepApprover.findMany(),
    }));
    expect(state.items).toHaveLength(1);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.status).toBe('open');
    // The snapshot: the whole stage as it stood at submission.
    expect(state.steps[0]?.stageSnapshot).toMatchObject({ selector: 'manager' });
    expect(state.approvers.map((a) => a.personId)).toEqual([janPersonId]);
  });

  it('carries the stage SLA onto the step so a reminder has something to measure', async () => {
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const step = await withTenant(tenantId, (tx) =>
      tx.approvalStep.findFirstOrThrow({ where: { requestId: outcome.requestId } }),
    );
    expect(step.slaDueAt).toEqual(new Date('2026-06-17T00:00:00Z'));
  });

  it('is unaffected by a later edit to the product it was submitted under', async () => {
    // What was reviewed is what is applied, literally. The same principle as
    // Directory Sync's materialized SyncChange and Provision's ProvisionAction.
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    await withTenant(tenantId, (tx) =>
      tx.productGrant.deleteMany({ where: { productId } }),
    );
    const items = await withTenant(tenantId, (tx) =>
      tx.requestItem.findMany({ where: { requestId: outcome.requestId } }),
    );
    expect(items).toHaveLength(1);
  });

  it('grants immediately when the workflow has zero stages', async () => {
    const outcome = await submitRequest(
      tenantId,
      {
        productId: immediateProductId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: null,
        formValues: {},
        requestedDurationDays: null,
      },
      { now: NOW },
    );
    expect(outcome).toMatchObject({ ok: true, status: 'fulfilled' });
    const assignments = await withTenant(tenantId, (tx) => tx.appAssignment.findMany());
    expect(assignments).toHaveLength(1);
  });

  it('writes an audit event naming the subject, the submitter and what was asked for', async () => {
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.request.submit' } }),
    );
    expect(events[0]?.payload).toMatchObject({
      subjectPersonId: annaPersonId,
      productId,
      onBehalf: false,
    });
  });
});

describe('submitRequest — the refusals', () => {
  it('refuses a product the subject audience does not admit, without saying it exists', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { department: 'Facilities' },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('refuses when the subject has no contracts in force', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { endDate: day('2026-01-01') },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'subject_departed' });
  });

  it('refuses when the subject person record is inactive', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.update({ where: { id: annaPersonId }, data: { status: 'inactive' } }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'subject_inactive' });
  });

  it('refuses when the subject already holds every resource, naming where from', async () => {
    // Refused rather than silently fulfilled into a no-op: a person who asks
    // for something they already have has a different problem.
    await withTenant(tenantId, (tx) =>
      tx.appAssignment.create({
        data: { tenantId, applicationId, subjectType: 'user', userId: annaUserId },
      }),
    );
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, reason: 'already_held' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toContain('already');
  });

  it('refuses a retired product', async () => {
    await withTenant(tenantId, (tx) =>
      tx.product.update({ where: { id: productId }, data: { status: 'retired' } }),
    );
    expect(await submit()).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('refuses an application product when the subject holds no account', async () => {
    // Refused at submission with that reason, rather than approved and then
    // found to be unfulfillable.
    //
    // Submitted by JAN, not the helpdesk. Anna's own account is deleted here,
    // so she cannot be the requester; and the helpdesk holds no
    // `automate.request_on_behalf`, so the plan's fixture was refused
    // `not_permitted_on_behalf` and never reached the check it names. Jan is
    // her manager, which needs no permission at all.
    const janUserId = await withTenant(tenantId, async (tx) =>
      (await tx.user.findFirstOrThrow({ where: { personId: janPersonId } })).id,
    );
    await withTenant(tenantId, (tx) => tx.user.deleteMany({ where: { personId: annaPersonId } }));
    const outcome = await submit({ requestedByUserId: janUserId });
    expect(outcome).toMatchObject({ ok: false, reason: 'no_user_account' });
  });

  it('refuses a duration beyond the product cap, and names the cap', async () => {
    const outcome = await submit({ requestedDurationDays: 400 });
    expect(outcome).toMatchObject({ ok: false, reason: 'duration_not_permitted' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toContain('90');
  });

  it('refuses a form submission missing a required field', async () => {
    expect(await submit({ formValues: {} })).toMatchObject({
      ok: false,
      reason: 'invalid_form',
    });
  });

  it('refuses a request with no justification when the workflow has a stage', async () => {
    // An approver asked to decide with no stated reason will decide badly or
    // not at all.
    expect(await submit({ justification: '  ' })).toMatchObject({
      ok: false,
      reason: 'invalid_form',
    });
  });

  it('allows no justification when the workflow has no stages', async () => {
    const outcome = await submitRequest(
      tenantId,
      {
        productId: immediateProductId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: null,
        formValues: {},
        requestedDurationDays: null,
      },
      { now: NOW },
    );
    expect(outcome.ok).toBe(true);
  });

  it('refuses a product whose workflow has been disabled', async () => {
    await withTenant(tenantId, (tx) =>
      tx.approvalWorkflow.updateMany({ where: {}, data: { enabled: false } }),
    );
    expect(await submit()).toMatchObject({ ok: false, reason: 'workflow_disabled' });
  });
});

describe('a resourcePicker names which of the product grants this request is for', () => {
  it('creates one item per required grant plus only the optional ones the picker named', async () => {
    // Spec section 6: `resourcePicker` is "choose among the product's own
    // ProductGrant rows, for a product whose bundle is 'pick one of these
    // four shared mailboxes'". Building the snapshot from every grant makes
    // both `resourcePicker` and `ProductGrant.optional` decorative, and a
    // tenant who configures "pick one of four" grants all four to everybody
    // who asks for one.
    const seeded = await withTenant(tenantId, async (tx) => {
      const a = await tx.application.create({ data: { tenantId, name: 'Mailbox A', slug: 'mb-a' } });
      const b = await tx.application.create({ data: { tenantId, name: 'Mailbox B', slug: 'mb-b' } });
      const c = await tx.application.create({ data: { tenantId, name: 'Mailbox C', slug: 'mb-c' } });
      return { a: a.id, b: b.id, c: c.id };
    });

    const bundleId = (
      await createProduct(tenantId, null, {
        name: 'Shared mailbox',
        slug: 'shared-mailbox',
        kind: 'application',
        grants: [
          { resourceType: 'application', resourceId: applicationId },
          { resourceType: 'application', resourceId: seeded.a, optional: true },
          { resourceType: 'application', resourceId: seeded.b, optional: true },
          { resourceType: 'application', resourceId: seeded.c, optional: true },
        ],
        audienceCondition: { all: [] },
        workflowId: (
          await withTenant(tenantId, (tx) =>
            tx.approvalWorkflow.findFirstOrThrow({ where: { name: 'Granted immediately' } }),
          )
        ).id,
        formSchema: [
          { key: 'mailbox', type: 'resourcePicker', label: 'Which mailbox', required: true },
        ],
        durationMode: 'permanent',
        defaultDurationDays: null,
        maxDurationDays: null,
        ownerPersonId: null,
        ownerGroupId: null,
        status: 'active',
      })
    ).id;

    const grants = await withTenant(tenantId, (tx) =>
      tx.productGrant.findMany({ where: { productId: bundleId }, orderBy: { resourceId: 'asc' } }),
    );
    const chosen = grants.find((g) => g.resourceId === seeded.b)!;

    const outcome = await submitRequest(
      tenantId,
      {
        productId: bundleId,
        subjectPersonId: annaPersonId,
        requestedByUserId: annaUserId,
        justification: null,
        formValues: { mailbox: chosen.id },
        requestedDurationDays: null,
      },
      { now: NOW },
    );
    if (!outcome.ok) throw new Error(outcome.message);

    const items = await withTenant(tenantId, (tx) =>
      tx.requestItem.findMany({ where: { requestId: outcome.requestId } }),
    );
    // Two: the required grant, and the one optional grant the picker named.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.resourceId).sort()).toEqual(
      [applicationId, seeded.b].sort(),
    );
  });
});

describe('extending a grant that is about to expire', () => {
  it('is not refused already_held for the grant it replaces', async () => {
    // The action the expiry-warning template renders at /access/:id/extend.
    // For a single-resource product every wanted key is held, so without the
    // subtraction the extension cannot even be submitted -- and spec section
    // 12's "extended in place with no outage" is unbuildable.
    const first = await submit({ productId: immediateProductId, formValues: {} });
    if (!first.ok) throw new Error(first.message);
    const grant = await withTenant(tenantId, (tx) => tx.accessGrant.findFirstOrThrow());

    const plain = await submit({ productId: immediateProductId, formValues: {} });
    expect(plain).toMatchObject({ ok: false, reason: 'already_held' });

    const extension = await submit({
      productId: immediateProductId,
      formValues: {},
      replacesGrantId: grant.id,
    });
    expect(extension.ok).toBe(true);
  });

  it('refuses when the grant it names is no longer live, and says to ask again', async () => {
    const dead = await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: annaPersonId,
          resourceType: 'application',
          resourceId: applicationId,
          startsAt: day('2026-01-01'),
          status: 'expired',
        },
      }),
    );
    const outcome = await submit({
      productId: immediateProductId,
      formValues: {},
      replacesGrantId: dead.id,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'already_held' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toContain('no longer live');
  });
});

describe('requesting on behalf of somebody', () => {
  it('lets the subject own manager submit with no permission at all', async () => {
    const janUserId = await withTenant(tenantId, async (tx) =>
      (await tx.user.findFirstOrThrow({ where: { personId: janPersonId } })).id,
    );
    const outcome = await submit({ requestedByUserId: janUserId });
    expect(outcome.ok).toBe(true);
  });

  it('refuses anybody else without automate.request_on_behalf', async () => {
    expect(await submit({ requestedByUserId: helpdeskUserId })).toMatchObject({
      ok: false,
      reason: 'not_permitted_on_behalf',
    });
  });

  it('allows a helpdesk agent holding the permission', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          name: 'Helpdesk',
          permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF],
        },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
    });
    const outcome = await submit({ requestedByUserId: helpdeskUserId });
    expect(outcome.ok).toBe(true);
  });

  it('tells the subject at submission, before anybody decides', async () => {
    // A request made for you that you were never told about is the shape of a
    // privilege escalation, and the notification is what makes it visible
    // while it can still be stopped.
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          name: 'Helpdesk',
          permissions: [PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF],
        },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
    });
    await submit({ requestedByUserId: helpdeskUserId });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    const told = outbox.find((o) => o.template === 'automate-request-submitted-for-you');
    expect(told?.to).toBe('anna@acme.test');
    expect(told?.sentAt).toBeNull();
  });

  it('never routes the stage to the submitter, even when they are the resolved approver', async () => {
    // The path a design that only checks the subject leaves open.
    const janUserId = await withTenant(tenantId, async (tx) =>
      (await tx.user.findFirstOrThrow({ where: { personId: janPersonId } })).id,
    );
    const outcome = await submit({ requestedByUserId: janUserId });
    if (!outcome.ok) throw new Error('unreachable');
    const approvers = await withTenant(tenantId, (tx) => tx.approvalStepApprover.findMany());
    expect(approvers.map((a) => a.personId)).not.toContain(janPersonId);
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
    );
    // Manager was the only selector and the fallback names the same person, so
    // there is nobody left. It says so rather than approving itself.
    expect(request.status).toBe('blocked_no_approver');
  });
});

describe('blocked_no_approver', () => {
  it('tells the product owner and the holders of automate.manage', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: helpdeskUserId },
      });
      await tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { managerPersonId: annaPersonId },
      });
      await tx.approvalStage.updateMany({ where: {}, data: { fallbackConfig: {} } });
    });
    const outcome = await submit();
    if (!outcome.ok) throw new Error('unreachable');
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: outcome.requestId } }),
    );
    expect(request.status).toBe('blocked_no_approver');
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-blocked-no-approver' } }),
    );
    expect(outbox.map((o) => o.to).sort()).toEqual(['hel@acme.test', 'jan@acme.test']);
  });
});
