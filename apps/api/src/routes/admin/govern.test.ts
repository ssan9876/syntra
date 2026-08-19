import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  buildSnapshot,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';
import { GOVERN_READ_ROUTES } from './govern.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

/**
 * The fixture the plan's cases needed and did not have.
 *
 * Its route tests referenced `leadOrgUnitId`, `inScopePersonName`,
 * `outOfScopePersonName`, `firstSnapshotId`, `secondSnapshotId` and
 * `outOfScopePersonId` — six identifiers that appeared nowhere else in the plan
 * — and called `seedAdmin(login, perms, { scopeOrgUnitId })` against a
 * signature taking a bare string (Ruling G-26). Everything the scope cases
 * assert about is seeded here, once.
 */
const IN_SCOPE = { given: 'Ines', family: 'Kuipers' };
const OUT_OF_SCOPE = { given: 'Otto', family: 'Vermeer' };
const SYSTEM_ID = 'sys-1';

let leadOrgUnitId: string;
let otherOrgUnitId: string;
let inScopePersonId: string;
let outOfScopePersonId: string;
let firstSnapshotId: string;
let secondSnapshotId: string;

const inScopePersonName = `${IN_SCOPE.given} ${IN_SCOPE.family}`;
const outOfScopePersonName = `${OUT_OF_SCOPE.given} ${OUT_OF_SCOPE.family}`;

async function seedAdmin(
  login: string,
  permissions: Permission[],
  options: { scopeOrgUnitId?: string } = {},
) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id, options.scopeOrgUnitId);
    return user;
  });
}

async function cookieFor(login: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

/**
 * Two snapshots with a holding gained between them, for each of two persons in
 * two different org units — so a scoped reader sees exactly one of each and the
 * withheld count is a number the test can assert on.
 */
async function seedTwoDepartments(): Promise<void> {
  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const lead = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Care' } });
    const other = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Finance' } });

    const mk = async (name: { given: string; family: string }, orgUnitId: string) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: name.given, familyName: name.family },
      });
      await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
        },
      });
      await tx.user.create({
        data: {
          tenantId: ctx.tenantId,
          login: name.given.toLowerCase(),
          email: `${name.given.toLowerCase()}@acme.test`,
          displayName: `${name.given} ${name.family}`,
          personId: person.id,
          orgUnitId,
        },
      });
      return person.id;
    };

    return {
      leadOrgUnitId: lead.id,
      otherOrgUnitId: other.id,
      inScope: await mk(IN_SCOPE, lead.id),
      outOfScope: await mk(OUT_OF_SCOPE, other.id),
    };
  });

  leadOrgUnitId = seeded.leadOrgUnitId;
  otherOrgUnitId = seeded.otherOrgUnitId;
  inScopePersonId = seeded.inScope;
  outOfScopePersonId = seeded.outOfScope;

  // The FIRST snapshot has nothing in `sys-1`; the second has one holding for
  // each person. The difference is what the change report reports.
  const first = await buildSnapshot(ctx.tenantId, { now: new Date('2026-06-01T00:00:00Z') });
  firstSnapshotId = first.snapshotId;

  const second = await buildSnapshot(ctx.tenantId, { now: new Date('2026-06-15T00:00:00Z') });
  secondSnapshotId = second.snapshotId;

  await withTenant(ctx.tenantId, async (tx) => {
    for (const [personId, label] of [
      [inScopePersonId, inScopePersonName],
      [outOfScopePersonId, outOfScopePersonName],
    ] as const) {
      await tx.holding.create({
        data: {
          tenantId: ctx.tenantId,
          snapshotId: secondSnapshotId,
          subjectKey: `person:${personId}`,
          personId,
          systemKind: 'targetSystem',
          systemId: SYSTEM_ID,
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-finance',
          resourceName: 'Finance-Payments',
          state: 'held',
          observedAt: new Date('2026-06-15T00:00:00Z'),
          observedVia: `provision:${SYSTEM_ID}`,
          firstSeenAt: new Date('2026-06-15T00:00:00Z'),
          attributionCount: 0,
          unattributable: true,
        },
      });
      await tx.holdingEvent.create({
        data: {
          tenantId: ctx.tenantId,
          fromSnapshotId: firstSnapshotId,
          toSnapshotId: secondSnapshotId,
          subjectKey: `person:${personId}`,
          personId,
          systemId: SYSTEM_ID,
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-finance',
          resourceName: 'Finance-Payments',
          change: 'gained',
          explained: false,
        },
      });
      await tx.governFinding.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'access_without_contract',
          severity: 'high',
          subjectRefType: 'person',
          subjectRefId: personId,
          detail: { label },
          firstSeenAt: new Date('2026-06-15T00:00:00Z'),
          lastSeenAt: new Date('2026-06-15T00:00:00Z'),
        },
      });
    }
  });
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('permissions', () => {
  it('refuses a caller with no govern permission at all', async () => {
    await seedAdmin('nobody', [PERMISSIONS.AUDIT_READ]);
    const res = await get('/api/admin/govern/snapshots', await cookieFor('nobody'));
    expect(res.statusCode).toBe(403);
  });

  it('ADMITS a caller whose govern.read is scoped to an org unit', async () => {
    // The whole reason `requireGovernRead` exists. With
    // `requirePermission(GOVERN_READ)` this is a 403, because Core's
    // `hasPermission` refuses a scoped assignment asked unscoped.
    const ou = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Care' } }),
    );
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], { scopeOrgUnitId: ou.id });
    const res = await get('/api/admin/govern/snapshots', await cookieFor('lead'));
    expect(res.statusCode).toBe(200);
  });

  it('refuses an export to a caller holding only govern.read', async () => {
    // Reading a screen and walking out with a file are different acts.
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const res = await post('/api/admin/govern/exports/csv', await cookieFor('reader'), {
      systemId: SYSTEM_ID,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a snapshot build to a caller holding only govern.read', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const res = await post('/api/admin/govern/snapshots', await cookieFor('reader'));
    expect(res.statusCode).toBe(403);
  });
});

describe('reports', () => {
  it('every report body carries its header', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    await buildSnapshot(ctx.tenantId, {});
    const cookie = await cookieFor('reader');
    const res = await get('/api/admin/govern/reports/system?systemId=syntra', cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { header?: { asOf?: string; sources?: unknown[] } };
    expect(body.header?.asOf).toBeTruthy();
    expect(Array.isArray(body.header?.sources)).toBe(true);
  });

  it('refuses a report over a snapshot that is still building', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const building = await withTenant(ctx.tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId: ctx.tenantId, kind: 'manual', status: 'building', asOf: new Date() },
      }),
    );
    const res = await get(
      `/api/admin/govern/reports/system?systemId=syntra&snapshotId=${building.id}`,
      await cookieFor('reader'),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('the org-unit scope on EVERY read path — §21', () => {
  // The shape §23 asks for over `readableSnapshot()`, applied to the scope:
  // ENUMERATE the routes and assert each either applies the scope or is on an
  // explicit exempt list. The worst omission this closes is the CSV export —
  // §10 calls it "a copy of everybody's access leaving the building", and
  // guarded only by `requirePermission(GOVERN_EXPORT)` it has no scope filter
  // at all, three routes below the GET of the same report.

  it('every read route is either scoped or explicitly exempt with a reason', () => {
    const source = readFileSync(new URL('./govern.ts', import.meta.url), 'utf8');
    for (const route of GOVERN_READ_ROUTES) {
      const [method, path] = route.path.split(' ') as [string, string];
      const literal = `'${path}'`;
      expect(source, `${route.path} must exist in this module`).toContain(literal);
      if (route.scoped) {
        // The handler must mention the scope. A handler that never says
        // `scopeOf` cannot be applying one.
        const from = source.indexOf(literal, source.indexOf('registerAdminGovernRoutes'));
        const handler = source.slice(from, from + 2500);
        expect(handler, `${route.path} must apply the org-unit scope`).toMatch(/scopeOf\(request\)/);
      } else {
        expect(route.why, `${route.path} is exempt and must say why`).toBeTruthy();
      }
      expect(method === 'GET' || method === 'POST').toBe(true);
    }
  });

  it('the exempt list is short and named, so adding to it is a deliberate edit', () => {
    expect(
      GOVERN_READ_ROUTES.filter((r) => !r.scoped)
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      'GET /govern/integrity',
      'GET /govern/orphans',
      'GET /govern/snapshots',
      'GET /govern/snapshots/:id',
      'GET /govern/snapshots/:id/coverage',
    ]);
  });

  it('404s a person report outside the caller’s org-unit scope', async () => {
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], { scopeOrgUnitId: leadOrgUnitId });
    const cookie = await cookieFor('lead');

    const outside = await get(`/api/admin/govern/reports/person/${outOfScopePersonId}`, cookie);
    // 404, not 403: a 403 confirms the person exists, and the existence of a
    // person in another department is itself information.
    expect(outside.statusCode).toBe(404);

    // And the same reader CAN read their own department, so the 404 above is
    // the scope and not a broken route.
    const inside = await get(`/api/admin/govern/reports/person/${inScopePersonId}`, cookie);
    expect(inside.statusCode).toBe(200);
  });

  it('the CSV export withholds rows outside the caller’s scope', async () => {
    // The disclosure this closes: a department-scoped reader who also holds
    // `govern.export` walked out with the tenant.
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ, PERMISSIONS.GOVERN_EXPORT], {
      scopeOrgUnitId: leadOrgUnitId,
    });
    const res = await post('/api/admin/govern/exports/csv', await cookieFor('lead'), {
      systemId: SYSTEM_ID,
      snapshotId: secondSnapshotId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(inScopePersonName);
    expect(res.body).not.toContain(outOfScopePersonName);
  });

  it('the CSV export’s audit event records the scope AND the row count', async () => {
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ, PERMISSIONS.GOVERN_EXPORT], {
      scopeOrgUnitId: leadOrgUnitId,
    });
    await post('/api/admin/govern/exports/csv', await cookieFor('lead'), {
      systemId: SYSTEM_ID,
      snapshotId: secondSnapshotId,
    });
    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        // `govern.report.export`, the action `exportReportCsv` actually writes.
        // The plan asserted `govern.export.csv`, which no code path emits.
        where: { action: 'govern.report.export' },
        orderBy: { sequence: 'desc' },
      }),
    );
    // A count of 40 against a scope of 12,000 people and a count of 40 against
    // a scope of 40 are different acts, and the record has to tell them apart.
    const payload = event.payload as { rowCount?: unknown; scope?: Record<string, unknown> };
    expect(payload.rowCount).toBe(1);
    expect(payload.scope?.['scopeOrgUnitId']).toEqual([leadOrgUnitId]);
  });

  it('the changes report withholds out-of-scope events AND says how many', async () => {
    // §6: nobody reads a report as complete while part of it is not shown.
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], { scopeOrgUnitId: leadOrgUnitId });
    const res = await get(
      `/api/admin/govern/reports/changes?fromSnapshotId=${firstSnapshotId}&toSnapshotId=${secondSnapshotId}`,
      await cookieFor('lead'),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json().body as { observedChanges: unknown[]; withheldForScope: number };
    expect(body.withheldForScope).toBe(1);
    expect(body.observedChanges).toHaveLength(1);
  });

  it('the findings list withholds a finding about a person outside the scope', async () => {
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], { scopeOrgUnitId: leadOrgUnitId });
    const res = await get('/api/admin/govern/findings', await cookieFor('lead'));
    const subjects = res.json().findings.map((f: { subjectRefId: string }) => f.subjectRefId);
    expect(subjects).toContain(inScopePersonId);
    expect(subjects).not.toContain(outOfScopePersonId);
  });

  it('a TENANT-scoped reader sees both departments, so the filtering is the scope', async () => {
    // The control for every case above. Without it, a filter that returned
    // nothing at all would pass all of them.
    await seedTwoDepartments();
    await seedAdmin('boss', [PERMISSIONS.GOVERN_READ]);
    const res = await get('/api/admin/govern/findings', await cookieFor('boss'));
    const subjects = res.json().findings.map((f: { subjectRefId: string }) => f.subjectRefId);
    expect(subjects).toContain(inScopePersonId);
    expect(subjects).toContain(outOfScopePersonId);
    expect(otherOrgUnitId).toBeTruthy();
  });
});

describe('Refresh now enqueues somebody else’s job and says whose', () => {
  it('503s rather than reading the source itself when no scheduler is running', async () => {
    await seedAdmin('manager', [PERMISSIONS.GOVERN_MANAGE]);
    const res = await post(
      '/api/admin/govern/sources/targetSystem/00000000-0000-0000-0000-000000000001/refresh',
      await cookieFor('manager'),
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining('never reads a source itself'),
    });
  });
});
