import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole, hasPermission } from '../rbac/rbac-service.js';
import {
  governReadScope,
  holdsGovernPermission,
  orgUnitDescendants,
  personIdsInScope,
  scopeAdmitsPerson,
} from './scope.js';

let tenantId: string;
let root: string;
let region: string;
let care: string;
let unscopedUserId: string;
let scopedUserId: string;
let noneUserId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const rootOu = await tx.orgUnit.create({ data: { tenantId, name: 'Head Office' } });
    const regionOu = await tx.orgUnit.create({
      data: { tenantId, name: 'North', parentId: rootOu.id },
    });
    const careOu = await tx.orgUnit.create({
      data: { tenantId, name: 'Care', parentId: regionOu.id },
    });

    const role = await createRole(tx, 'Governance reader', [PERMISSIONS.GOVERN_READ]);
    const mk = async (login: string) =>
      (
        await tx.user.create({
          data: { tenantId, login, email: `${login}@acme.test`, displayName: login },
        })
      ).id;

    const unscoped = await mk('unscoped');
    const scoped = await mk('scoped');
    const none = await mk('none');
    await assignRole(tx, unscoped, role.id);
    await assignRole(tx, scoped, role.id, rootOu.id);

    return { rootOu: rootOu.id, regionOu: regionOu.id, careOu: careOu.id, unscoped, scoped, none };
  });

  root = seeded.rootOu;
  region = seeded.regionOu;
  care = seeded.careOu;
  unscopedUserId = seeded.unscoped;
  scopedUserId = seeded.scoped;
  noneUserId = seeded.none;
});

describe('the gap in Core’s hasPermission this module closes', () => {
  it('Core refuses a scoped holder asked unscoped — which is what requirePermission does', async () => {
    // Recorded as a test rather than as a comment, because the whole reason
    // `requireGovernRead` exists is this behaviour, and a future reader will
    // otherwise assume the standard guard would have worked.
    const answer = await withTenant(tenantId, (tx) =>
      hasPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ),
    );
    expect(answer).toBe(false);
  });

  it('Core also refuses a scope BENEATH the assignment', async () => {
    const answer = await withTenant(tenantId, (tx) =>
      hasPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ, care),
    );
    expect(answer).toBe(false);
  });
});

describe('governReadScope', () => {
  it('gives an unscoped holder the whole tenant', async () => {
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, unscopedUserId));
    expect(scope).toEqual({ kind: 'tenant' });
  });

  it('gives a scoped holder their unit AND every unit beneath it', async () => {
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, scopedUserId));
    expect(scope.kind).toBe('orgUnits');
    if (scope.kind !== 'orgUnits') throw new Error('unreachable');
    expect([...scope.orgUnitIds].sort()).toEqual([root, region, care].sort());
  });

  it('gives a holder of nothing an empty scope, not a tenant one', async () => {
    // The empty case, in the dangerous direction: a `none` that fell back to
    // `tenant` would hand everybody's access to anybody with a session.
    const scope = await withTenant(tenantId, (tx) => governReadScope(tx, noneUserId));
    expect(scope).toEqual({ kind: 'none' });
  });
});

describe('orgUnitDescendants', () => {
  it('includes the roots themselves', async () => {
    const ids = await withTenant(tenantId, (tx) => orgUnitDescendants(tx, [region]));
    expect([...ids].sort()).toEqual([region, care].sort());
  });

  it('returns nothing for an EMPTY root list rather than everything', async () => {
    expect(await withTenant(tenantId, (tx) => orgUnitDescendants(tx, []))).toEqual([]);
  });

  it('terminates on a cycle', async () => {
    await withTenant(tenantId, (tx) =>
      tx.orgUnit.update({ where: { id: root }, data: { parentId: care } }),
    );
    const ids = await withTenant(tenantId, (tx) => orgUnitDescendants(tx, [root]));
    expect(ids.length).toBeLessThanOrEqual(3);
  });
});

describe('scopeAdmitsPerson and personIdsInScope', () => {
  it('admits everybody under a tenant scope', () => {
    expect(scopeAdmitsPerson({ kind: 'tenant' }, null)).toBe(true);
  });

  it('admits nobody under a none scope', () => {
    expect(scopeAdmitsPerson({ kind: 'none' }, care)).toBe(false);
  });

  it('admits a person in a unit beneath the scoped unit, and refuses one outside', () => {
    const scope = { kind: 'orgUnits' as const, orgUnitIds: [root, region, care] };
    expect(scopeAdmitsPerson(scope, care)).toBe(true);
    expect(scopeAdmitsPerson(scope, 'ou-elsewhere')).toBe(false);
  });

  it('REFUSES a person with no org unit under an org-unit scope', () => {
    // A person whose user sits in no unit is not "in every unit". Admitting
    // them would silently widen every scoped read to the unplaced population,
    // which on a fresh import is everybody.
    expect(scopeAdmitsPerson({ kind: 'orgUnits', orgUnitIds: [root] }, null)).toBe(false);
  });

  it('resolves the person set for an org-unit scope, and `all` for a tenant one', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      await tx.user.create({
        data: {
          tenantId,
          login: 'ab',
          email: 'ab@a.test',
          displayName: 'A B',
          personId: p.id,
          orgUnitId: care,
        },
      });
      return p.id;
    });
    const scoped = await withTenant(tenantId, (tx) =>
      personIdsInScope(tx, { kind: 'orgUnits', orgUnitIds: [root, region, care] }),
    );
    expect(scoped).not.toBe('all');
    expect([...(scoped as Set<string>)]).toEqual([personId]);
    expect(await withTenant(tenantId, (tx) => personIdsInScope(tx, { kind: 'tenant' }))).toBe('all');
  });
});

describe('holdsGovernPermission', () => {
  it('says yes for a SCOPED assignment, which Core’s hasPermission refuses', async () => {
    // The export pairs `govern.export` with the scoped read, and the same role
    // usually carries both. Asking Core unscoped refuses a scoped assignment,
    // which would leave a department lead able to read their department on the
    // screen and unable to export the very same rows.
    const [core, govern] = await withTenant(tenantId, async (tx) => [
      await hasPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ),
      await holdsGovernPermission(tx, scopedUserId, PERMISSIONS.GOVERN_READ),
    ]);
    expect(core).toBe(false);
    expect(govern).toBe(true);
  });

  it('says no for a permission nobody granted', async () => {
    const held = await withTenant(tenantId, (tx) =>
      holdsGovernPermission(tx, scopedUserId, PERMISSIONS.GOVERN_EXPORT),
    );
    expect(held).toBe(false);
  });
});

