import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { resolveApplicationIdsForUser } from '../access/resolve.js';
import { collectTenant, foldIdentifier, resolveApplicationPaths } from './collect.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('resolveApplicationPaths', () => {
  it('reports WHICH org unit produced the match and the chain up to it', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const root = await tx.orgUnit.create({ data: { tenantId, name: 'Head Office' } });
      const region = await tx.orgUnit.create({
        data: { tenantId, name: 'North region', parentId: root.id },
      });
      const care = await tx.orgUnit.create({
        data: { tenantId, name: 'Care', parentId: region.id },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          orgUnitId: care.id,
        },
      });
      const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
      const assignment = await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: root.id },
      });
      return { userId: user.id, applicationId: app.id, assignmentId: assignment.id, rootId: root.id };
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));

    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({
      userId: seeded.userId,
      applicationId: seeded.applicationId,
      via: 'orgUnit',
      assignmentId: seeded.assignmentId,
      matchedOrgUnitId: seeded.rootId,
      matchedOrgUnitName: 'Head Office',
    });
    expect(paths[0]!.chain.map((c) => c.name)).toEqual(['Care', 'North region', 'Head Office']);
  });

  it('agrees with resolveApplicationIdsForUser about WHICH applications, on the same data', async () => {
    // The paths resolver is a second reader of the same rule, so the two must
    // not be allowed to drift. This is the assertion that catches it — and it
    // is deliberately about the application SET, not the paths, because
    // resolve.ts cannot answer about paths at all.
    const seeded = await withTenant(tenantId, async (tx) => {
      const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'A', orgUnitId: ou.id },
      });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const direct = await tx.application.create({ data: { tenantId, name: 'D', slug: 'd' } });
      const byGroup = await tx.application.create({ data: { tenantId, name: 'G', slug: 'g' } });
      const byUnit = await tx.application.create({ data: { tenantId, name: 'U', slug: 'u' } });
      const retired = await tx.application.create({
        data: { tenantId, name: 'R', slug: 'r', status: 'retired' },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: direct.id, subjectType: 'user', userId: user.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: byGroup.id, subjectType: 'group', groupId: group.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: byUnit.id, subjectType: 'orgUnit', orgUnitId: ou.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: retired.id, subjectType: 'user', userId: user.id },
      });
      return { userId: user.id };
    });

    const [fromResolve, paths] = await withTenant(tenantId, async (tx) => [
      await resolveApplicationIdsForUser(tx, seeded.userId),
      await resolveApplicationPaths(tx),
    ]);

    const fromPaths = new Set(
      paths.filter((p) => p.userId === seeded.userId).map((p) => p.applicationId),
    );
    expect([...fromPaths].sort()).toEqual([...fromResolve].sort());
    expect(fromPaths.size).toBe(3);
  });

  it('reports all three paths separately when one application arrives by all three', async () => {
    // A union that deduplicated by application would report one path and lose
    // two attributions, and the person-detail screen's whole job is to show
    // all three.
    const seeded = await withTenant(tenantId, async (tx) => {
      const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'A', orgUnitId: ou.id },
      });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const app = await tx.application.create({ data: { tenantId, name: 'S', slug: 's' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'user', userId: user.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'group', groupId: group.id },
      });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: ou.id },
      });
      return { userId: user.id };
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));
    expect(paths.filter((p) => p.userId === seeded.userId).map((p) => p.via).sort()).toEqual([
      'group',
      'orgUnit',
      'user',
    ]);
  });

  it('survives a cycle in the org-unit tree rather than hanging', async () => {
    // `parentId` is a self-relation with no database-level acyclicity check,
    // and a cycle introduced by a bad import would otherwise hang the nightly
    // snapshot for every tenant on the box.
    await withTenant(tenantId, async (tx) => {
      const a = await tx.orgUnit.create({ data: { tenantId, name: 'A' } });
      const b = await tx.orgUnit.create({ data: { tenantId, name: 'B', parentId: a.id } });
      await tx.orgUnit.update({ where: { id: a.id }, data: { parentId: b.id } });
      const user = await tx.user.create({
        data: { tenantId, login: 'u', email: 'u@a.test', displayName: 'U', orgUnitId: b.id },
      });
      const app = await tx.application.create({ data: { tenantId, name: 'S', slug: 's' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: a.id },
      });
      return user;
    });

    const paths = await withTenant(tenantId, (tx) => resolveApplicationPaths(tx));
    expect(paths).toHaveLength(1);
    expect(paths[0]!.chain.length).toBeLessThanOrEqual(64);
  });

  it('returns nothing at all when the tenant has no assignments', async () => {
    // The empty case: a resolver that returned every application when there
    // were no assignments would give the whole tenant everything, and the
    // fixture that would hide it is one that always seeds an assignment.
    await withTenant(tenantId, (tx) =>
      tx.application.create({ data: { tenantId, name: 'S', slug: 's' } }),
    );
    expect(await withTenant(tenantId, (tx) => resolveApplicationPaths(tx))).toEqual([]);
  });
});

describe('foldIdentifier', () => {
  it('folds case, because AD does and PostgreSQL does not', () => {
    expect(foldIdentifier('Anna.Novak')).toBe(foldIdentifier('anna.novak'));
  });

  it('uses NFKD, so a ligature decomposes rather than surviving', () => {
    // NFD leaves the ligature intact and folding it yields `sbrand`, which is
    // a valid login belonging to somebody else. On a product whose reference
    // implementation is Dutch.
    expect(foldIdentifier('Ĳsbrand')).toBe('ijsbrand');
    expect(foldIdentifier('Ĳsbrand')).not.toBe('sbrand');
  });
});
describe('collectTenant', () => {
  it('collects a person’s Syntra account, group, application, role and target entitlement', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.contract.create({
        data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01') },
      });
      const user = await tx.user.create({
        data: { tenantId, login: 'anna', email: 'a@acme.test', displayName: 'Anna Novak', personId: person.id },
      });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance' } });
      await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
      const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
      await tx.appAssignment.create({
        data: { tenantId, applicationId: app.id, subjectType: 'user', userId: user.id },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: ['audit.read'] },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' }, lastRunAt: NOW, lastAppliedRunAt: NOW },
      });
      const entitlement = await tx.entitlement.create({
        data: { tenantId, targetSystemId: target.id, externalId: 'guid-1', type: 'group', displayName: 'Finance-Payments' },
      });
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: target.id, personId: person.id, anchor: 'guid-anna', correlationKey: 'anna.novak', status: 'active', lastReconciledAt: NOW },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'discovered' },
      });
      return { personId: person.id, targetId: target.id, entitlementId: entitlement.id };
    });

    const collected = await collectTenant(tenantId, { asOf: NOW });

    const kinds = collected.holdings
      .filter((h) => h.subject.kind === 'person' && h.subject.personId === seeded.personId)
      .map((h) => h.resourceKind)
      .sort();
    expect(kinds).toEqual([
      'application',
      'syntraGroup',
      'syntraRole',
      'syntraUser',
      'targetAccount',
      'targetEntitlement',
    ]);

    const entitlement = collected.holdings.find((h) => h.resourceKind === 'targetEntitlement');
    expect(entitlement!.attribution.discovered).toHaveLength(1);
    expect(entitlement!.observedAt).toEqual(NOW);
    expect(collected.personsWithActiveContract).toBe(1);
    expect(collected.queryCount).toBe(9);
  });

  it('produces a resource_unreadable gap and an unknown holding for an unreadable entitlement', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's', config: { tlsMode: 'ldaps' }, lastRunAt: NOW, lastAppliedRunAt: NOW },
      });
      const entitlement = await tx.entitlement.create({
        data: { tenantId, targetSystemId: target.id, externalId: 'g', type: 'group', displayName: 'Domain Admins', status: 'unreadable' },
      });
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: target.id, personId: person.id, anchor: 'x', correlationKey: 'a.b', status: 'active', lastReconciledAt: NOW },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'rule' },
      });
    });

    const collected = await collectTenant(tenantId, { asOf: NOW });
    const gap = collected.gaps.find((g) => g.kind === 'resource_unreadable');
    expect(gap!.reason).toContain('Domain Admins');
    expect(gap!.reason).toContain('not necessarily the run that failed the read');
    expect(collected.holdings.find((h) => h.resourceKind === 'targetEntitlement')!.state).toBe('unknown');
    expect(collected.sources.find((s) => s.sourceKind === 'targetSystem')!.completeness).toBe('partial');
  });

  it('reports a Syntra account with no linked person as subject_unresolvable', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.create({ data: { tenantId, login: 'svc', email: 's@a.test', displayName: 'Service' } }),
    );
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(collected.gaps.map((g) => g.kind)).toContain('subject_unresolvable');
    expect(collected.unattributedAccountKeys).toHaveLength(1);
  });

  it('copies a ProvisionException onto a person_unprocessable gap so pruning the run cannot close it', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's', config: { tlsMode: 'ldaps' } },
      });
      const run = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: target.id, status: 'applied' },
      });
      await tx.provisionException.create({
        data: {
          tenantId, runId: run.id, personId: person.id, targetSystemId: target.id,
          kind: 'unresolvable_rule', message: 'rule "Finance staff" names a missing entitlement',
        },
      });
      return { runId: run.id, personId: person.id };
    });

    const before = await collectTenant(tenantId, { asOf: NOW });
    const gap = before.gaps.find((g) => g.kind === 'person_unprocessable');
    expect(gap).toMatchObject({ personId: seeded.personId, sourceRunId: seeded.runId });
    expect(gap!.reason).toContain('Finance staff');

    // The copy is what makes the gap survive its source.
    await withTenant(tenantId, (tx) => tx.provisionRun.delete({ where: { id: seeded.runId } }));
    expect(gap!.reason).toContain('Finance staff');
  });

  it('reports NOTHING for an empty tenant rather than an empty-and-complete picture', async () => {
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(collected.holdings).toEqual([]);
    // The one source that is always there says so; a collect that reported no
    // sources at all would make worstCompleteness answer `unread`, which is
    // the correct answer for a tenant nobody has configured.
    expect(collected.sources.map((s) => s.sourceKind)).toEqual(['syntraInternal']);
  });
});

/**
 * §6: an orphan account's holdings ARE holdings, held by somebody Syntra
 * cannot name.
 *
 * `collect` skipped any user with no `personId` for groups, applications and
 * roles, so a service account holding `tenant.manage` produced a
 * `subject_unresolvable` gap and NO `syntraRole` holding -- it appeared in no
 * report, no campaign and no SoD evaluation. An account that can sign in to the
 * identity platform, belongs to nobody, and holds the permission to administer
 * tenants is the single most interesting row an access review can put in front
 * of somebody, and it was the one row that was never there.
 */
describe('an account with no person behind it', () => {
  async function seedUnlinkedUserHoldingEverything(): Promise<{ userId: string }> {
    return withTenant(tenantId, async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'svc-payments',
          email: 'svc-payments@a.test',
          displayName: 'Payments service account',
          // THE WHOLE POINT: no person behind it.
          personId: null,
        },
      });
      const group = await tx.group.create({ data: { tenantId, name: 'Ward Nurses' } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: user.id },
      });
      const application = await tx.application.create({
        data: { tenantId, name: 'Payments', slug: 'payments' },
      });
      await tx.appAssignment.create({
        data: {
          tenantId,
          applicationId: application.id,
          subjectType: 'user',
          userId: user.id,
        },
      });
      const role = await tx.role.create({ data: { tenantId, name: 'Owner' } });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
      return { userId: user.id };
    });
  }

  it('still contributes its group, application and role holdings', async () => {
    const seeded = await seedUnlinkedUserHoldingEverything();

    const collected = await collectTenant(tenantId, { asOf: NOW });
    const mine = collected.holdings.filter(
      (h) => h.subject.kind === 'account' && h.subject.accountRef === seeded.userId,
    );

    expect([...new Set(mine.map((h) => h.resourceKind))].sort()).toEqual([
      'application',
      'syntraGroup',
      'syntraRole',
    ]);
    // The subject is the ACCOUNT, named by what it is. `subjectKey` is
    // `account:syntra:<userId>`, which is what every report and every campaign
    // groups on.
    expect(mine.every((h) => h.subject.kind === 'account')).toBe(true);
  });

  it('still records the gap, because the account is ALSO unresolvable', async () => {
    // The holding and the gap are two different facts and both are true. The
    // gap says "Govern cannot name who holds this"; the holdings say what they
    // hold. Dropping either is a different kind of dishonesty.
    const seeded = await seedUnlinkedUserHoldingEverything();
    const collected = await collectTenant(tenantId, { asOf: NOW });
    expect(
      collected.gaps.some(
        (g) => g.kind === 'subject_unresolvable' && g.accountRef === seeded.userId,
      ),
    ).toBe(true);
  });
});
