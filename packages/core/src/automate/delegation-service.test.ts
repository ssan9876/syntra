import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import {
  DelegationRefusedError,
  createApprovalDelegation,
  delegatedGrant,
  delegatedRevoke,
  resourcesManagedBy,
  upsertResourceDelegation,
} from './delegation-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let leadPersonId: string;
let leadUserId: string;
let annaPersonId: string;
let annaUserId: string;
let boPersonId: string;
let groupId: string;

async function person(name: string, department = 'Finance') {
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
        department,
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
  ({ personId: leadPersonId, userId: leadUserId } = await person('Lead'));
  ({ personId: annaPersonId, userId: annaUserId } = await person('Anna'));
  ({ personId: boPersonId } = await person('Bo', 'Facilities'));
  groupId = await withTenant(tenantId, async (tx) =>
    (await tx.group.create({ data: { tenantId, name: 'Finance Reporting' } })).id,
  );
});

const delegateGroup = (over: Record<string, unknown> = {}) =>
  upsertResourceDelegation(tenantId, null, {
    resourceType: 'group',
    resourceId: groupId,
    delegatePersonId: leadPersonId,
    delegateGroupId: null,
    capabilities: ['view_members', 'grant', 'revoke'],
    audienceCondition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    startsAt: day('2026-01-01'),
    endsAt: null,
    ...over,
  });

describe('approval delegation', () => {
  it('records one and tells both parties', async () => {
    await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'automate-delegation-started' } }),
    );
    expect(outbox.map((o) => o.to).sort()).toEqual(['anna@acme.test', 'lead@acme.test']);
  });

  it('refuses a delegation longer than maxDelegationDays', async () => {
    // An indefinite delegation is a permanent transfer of authority that
    // nobody ever re-decides.
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2027-06-16'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('too-long');
    expect((failure as Error).message).toContain('90');
  });

  it('refuses a chain: the delegate already delegates onwards', async () => {
    // Depth 1, enforced when the delegation is created. Resolution expands
    // exactly one level regardless, so this is the second half of the same
    // rule rather than the only half.
    await createApprovalDelegation(
      tenantId,
      // Anna's own delegation, recorded by Anna. Spec section 8: by the
      // delegator, or by an administrator holding automate.manage.
      annaUserId,
      {
        delegatorPersonId: annaPersonId,
        delegatePersonId: boPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('not-transitive');
  });

  it('names both parties in the notification rather than their ids', async () => {
    // Spec section 13 wants "Delegation started / ended — delegator and
    // delegate, both ends, both times". A mail saying "guid-4f2a... has
    // delegated approvals to guid-91be..." tells neither of them anything.
    await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: annaPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findFirstOrThrow({
        where: { template: 'automate-delegation-started' },
      }),
    );
    const vars = row.vars as Record<string, string>;
    expect(vars.delegatorName).toBe('Lead Test');
    expect(vars.delegateName).toBe('Anna Test');
    for (const value of Object.values(vars)) {
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('refuses somebody recording an absence on another person behalf without automate.manage', async () => {
    // Spec section 8's rule lived nowhere in code: the function took
    // `delegatorPersonId` from its input and `actorUserId` separately and
    // never compared them. Nothing was exposed while the only caller was an
    // admin route already gated on automate.manage — but this function is
    // exported from `@syntra/core` and the portal is about to call it.
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: annaPersonId,
        delegatePersonId: boPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('not-permitted');
  });

  it('allows an administrator holding automate.manage to record one on their behalf', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: leadUserId },
      });
    });
    const created = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: annaPersonId,
        delegatePersonId: boPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    );
    expect(created.id).toBeTruthy();
  });

  it('refuses a delegation to oneself', async () => {
    const failure = await createApprovalDelegation(
      tenantId,
      leadUserId,
      {
        delegatorPersonId: leadPersonId,
        delegatePersonId: leadPersonId,
        category: null,
        startsAt: day('2026-06-16'),
        endsAt: day('2026-06-30'),
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('self');
  });
});

describe('a target entitlement is not delegable', () => {
  it('refuses the configuration, rather than producing a grant the database rejects', async () => {
    // `delegatedGrant` writes a RequestItem with `targetSystemId: null`,
    // `fulfilRequest` copies it onto the AccessGrant, and
    // `access_grant_target_matches_type` rejects ('entitlement', null) — a
    // 500 out of the portal on a capability the console would otherwise let
    // an administrator configure. Even satisfied, no Provision run would ever
    // be enqueued and the grant would sit `pending` forever.
    const failure = await upsertResourceDelegation(tenantId, null, {
      resourceType: 'entitlement',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    }).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('entitlement-not-delegable');
  });

  it('refuses the act as well, for a row written before that guard existed', async () => {
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'entitlement',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'because',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('entitlement-not-delegable');
    const grants = await withTenant(tenantId, (tx) => tx.accessGrant.findMany());
    expect(grants).toEqual([]);
  });
});

describe('clearing a delegation audience', () => {
  it('actually clears it, so the delegation stops admitting anybody by audience', async () => {
    // Same defect as `Product.audienceCondition`: `?? undefined` reads to
    // Prisma as "do not touch this column", so an administrator removing the
    // audience gets a delegation whose previous audience is still in force —
    // and this audience is the control that stops a team lead putting
    // anybody in the organization into their group.
    const { id } = await delegateGroup();
    await upsertResourceDelegation(tenantId, null, {
      id,
      resourceType: 'group',
      resourceId: groupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['view_members', 'grant', 'revoke'],
      audienceCondition: null,
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.resourceDelegation.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.audienceCondition).toBeNull();
  });
});

describe('resourcesManagedBy', () => {
  it('lists a resource delegated to the person directly', async () => {
    await delegateGroup();
    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toEqual([
      expect.objectContaining({ resourceType: 'group', resourceId: groupId }),
    ]);
  });

  it('lists a resource delegated to a group the person belongs to', async () => {
    const teamGroupId = await withTenant(tenantId, async (tx) => {
      const team = await tx.group.create({ data: { tenantId, name: 'Team leads' } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: team.id, userId: leadUserId },
      });
      return team.id;
    });
    await delegateGroup({ delegatePersonId: null, delegateGroupId: teamGroupId });
    const managed = await withTenant(tenantId, (tx) =>
      resourcesManagedBy(tx, leadPersonId, NOW),
    );
    expect(managed).toHaveLength(1);
  });

  it('does not list a delegation that has ended', async () => {
    await delegateGroup({ endsAt: day('2026-06-01') });
    expect(await withTenant(tenantId, (tx) => resourcesManagedBy(tx, leadPersonId, NOW))).toEqual(
      [],
    );
  });
});

describe('delegatedGrant', () => {
  it('creates an AccessRequest with no stages and fulfils it down the ordinary path', async () => {
    // The alternative -- a direct membership write -- is faster and forks the
    // audit trail and the fulfilment path in two.
    await delegateGroup();
    const { requestIds } = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'joined the reporting team',
        durationDays: null,
      },
      { now: NOW },
    );
    expect(requestIds).toHaveLength(1);

    const state = await withTenant(tenantId, async (tx) => ({
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestIds[0]! } }),
      steps: await tx.approvalStep.findMany(),
      grants: await tx.accessGrant.findMany(),
      memberships: await tx.groupMembership.findMany({ where: { groupId } }),
    }));
    expect(state.request).toMatchObject({ productId: null, origin: 'delegated_admin' });
    expect(state.steps).toEqual([]);
    expect(state.grants[0]).toMatchObject({ origin: 'delegated_admin', status: 'active' });
    expect(state.memberships).toHaveLength(1);
  });

  it('refuses to grant to somebody the resource audience does not admit', async () => {
    // Without this, delegation is a hole underneath the catalog: give a team
    // lead a group and they can put anybody in the organization into it.
    await delegateGroup();
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [boPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('outside-audience');
  });

  it('refuses more subjects than delegatedBulkLimit', async () => {
    // Bounded by construction. The blast radius of a capability handed out to
    // dozens of team leads should be small enough that no guard is needed.
    await delegateGroup();
    // DISTINCT people. The plan's fixture repeated `annaPersonId` 26 times,
    // and the service dedupes with `new Set(...)` before counting -- correctly,
    // because naming one person 26 times is one act and its blast radius is
    // one person. So the limit never tripped and the case asserted on an
    // exception that was never thrown. The bound is on how many people an act
    // touches, so the fixture has to name that many.
    //
    // These ids need not exist: the refusal precedes every person read, which
    // is itself the property worth having -- a bulk act is refused on its size
    // before it does any work.
    const many = Array.from(
      { length: 26 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: many,
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('too-many');
    expect((failure as Error).message).toContain('administrator');
  });

  it('refuses somebody with no grant capability', async () => {
    await delegateGroup({ capabilities: ['view_members'] });
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('not-permitted');
  });

  it('refuses a group a directory source owns', async () => {
    const syncedGroupId = await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId, name: 'Corporate LDAP', type: 'ldap', config: {}, secretName: 's/l' },
      });
      const group = await tx.group.create({
        data: { tenantId, name: 'Domain Users', sourceId: source.id, sourceAnchor: 'g1' },
      });
      return group.id;
    });
    await upsertResourceDelegation(tenantId, null, {
      resourceType: 'group',
      resourceId: syncedGroupId,
      delegatePersonId: leadPersonId,
      delegateGroupId: null,
      capabilities: ['grant'],
      audienceCondition: { all: [] },
      startsAt: day('2026-01-01'),
      endsAt: null,
    });
    const failure = await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: syncedGroupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect((failure as DelegationRefusedError).code).toBe('group-is-synced');
  });
});

describe('delegatedRevoke', () => {
  it('revokes a grant this delegation produced', async () => {
    await delegateGroup();
    await delegatedGrant(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
        justification: 'x',
        durationDays: null,
      },
      { now: NOW },
    );
    const { revoked } = await delegatedRevoke(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
      },
      { now: NOW },
    );
    expect(revoked).toBe(1);
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships).toEqual([]);
  });

  it('refuses to remove a holding that came from a business rule', async () => {
    // That is Provision's, and the console says so, naming the rule.
    await delegateGroup();
    await withTenant(tenantId, async (tx) => {
      const anna = await tx.user.findFirstOrThrow({ where: { personId: annaPersonId } });
      await tx.groupMembership.create({
        data: { tenantId, groupId, userId: anna.id },
      });
    });
    const { revoked } = await delegatedRevoke(
      tenantId,
      {
        actingPersonId: leadPersonId,
        actingUserId: leadUserId,
        resourceType: 'group',
        resourceId: groupId,
        subjectPersonIds: [annaPersonId],
      },
      { now: NOW },
    );
    // No grant to revoke: nothing here came from a request, so the membership
    // is not this delegation's to remove.
    expect(revoked).toBe(0);
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(memberships).toHaveLength(1);
  });
});
