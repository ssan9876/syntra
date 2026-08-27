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

  it('EVERY route guarded by requireGovernRead is enumerated — the list is the control', () => {
    // The scoping test iterates `GOVERN_READ_ROUTES`, so a route missing from
    // the list is invisible to it. It used to scan `app.get(` only, and three
    // POST previews -- campaign scope, campaign reviewers, SoD rule impact --
    // were guarded by `requireGovernRead()` with no scope filter and appeared
    // in neither the list nor the scan. They returned tenant-wide holding
    // counts, person counts and subject-key samples to a department-scoped
    // reader.
    //
    // Guarded-by, not method: `POST /govern/exports/csv` was always in the
    // list, so the enumeration was never really about GET. What makes a route
    // this test's business is `requireGovernRead`, which is what admits a
    // scoped holder in the first place.
    const source = readFileSync(new URL('./govern.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function registerAdminGovernRoutes'));
    const declared = new Set(GOVERN_READ_ROUTES.map((r) => r.path));

    const found = [
      // `\s` already spans newlines, so the pattern does not need to say so.
      ...body.matchAll(
        /app\.(get|post)\(\s*'([^']+)',\s*\{[^}]*requireGovernRead\(/g,
      ),
    ].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);

    expect(found.length).toBeGreaterThan(10);
    for (const path of found) {
      expect(declared, `${path} is admitted by govern.read and must be in GOVERN_READ_ROUTES`)
        .toContain(path);
    }
  });

  it('the exempt list is short and named, so adding to it is a deliberate edit', () => {
    expect(
      GOVERN_READ_ROUTES.filter((r) => !r.scoped)
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      'GET /govern/campaigns',
      // The signed bundle. Unscoped because it is an artifact over a campaign
      // or a snapshot AS A WHOLE -- there is no partial disclosure of a
      // document whose whole point is a digest over all of it -- and it is
      // gated on `govern.export` rather than `govern.read` for that reason.
      'GET /govern/evidence/:id',
      'GET /govern/integrity',
      'GET /govern/orphans',
      'GET /govern/settings',
      'GET /govern/snapshots',
      'GET /govern/snapshots/:id',
      'GET /govern/snapshots/:id/coverage',
      'GET /govern/sod/functions',
      'GET /govern/sod/rules',
    ]);
  });

  /**
   * A mined candidate names no person, which is the argument for exempting it
   * from the scope — and the argument is wrong. It names a COHORT and counts
   * it: "everyone in Engineering holds all-staff, and forty others do too"
   * tells a department lead the size and the access shape of a department they
   * cannot otherwise see. Aggregates over people are still about people.
   *
   * This case only proves the scoped route answers a scoped reader at all —
   * the two-person fixture here has no departments, so it can produce no
   * cohorts and an assertion about withheld rows would pass vacuously. The
   * filtering itself is held by `rule-mining-scope.test.ts`, which seeds a
   * population large enough to mine.
   */
  it('answers a scoped reader rather than failing under the scope', async () => {
    await seedTwoDepartments();
    await seedAdmin('lead', [PERMISSIONS.GOVERN_READ], { scopeOrgUnitId: leadOrgUnitId });

    const res = await get(
      `/api/admin/govern/snapshots/${secondSnapshotId}/rule-candidates`,
      await cookieFor('lead'),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toEqual([]);
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

/**
 * The chain §13 calls "revocation is a run", end to end over HTTP.
 *
 * Every link is a route somebody has to be able to reach: without
 * `POST /govern/campaigns/:id/revocations` nothing computes a batch, and
 * `POST /govern/batches/:id/confirm` has nothing to confirm. The services are
 * tested in `packages/core`; what this asserts is that the product exposes them
 * at all, and with the right permission on each.
 */
describe('the slice-2 admin surface — campaigns, batches and SoD', () => {
  let manager: string;
  let subject: string;
  let snapshot: string;

  beforeEach(async () => {
    const seeded = await withTenant(ctx.tenantId, async (tx) => {
      const tenantId = ctx.tenantId;
      const mk = async (given: string) => {
        const person = await tx.person.create({
          data: { tenantId, givenName: given, familyName: 'Test' },
        });
        await tx.contract.create({
          data: {
            tenantId,
            personId: person.id,
            sequence: 1,
            isPrimary: true,
            startDate: new Date('2020-01-01'),
          },
        });
        return person.id;
      };
      const ownerPersonId = await mk('Ola');
      const annaPersonId = await mk('Anna');

      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 's/ad',
          config: { tlsMode: 'ldaps' },
          lastRunAt: new Date(),
          lastAppliedRunAt: new Date(),
        },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-1',
          type: 'group',
          displayName: 'Finance-Payments',
        },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          personId: annaPersonId,
          anchor: 'guid-anna',
          correlationKey: 'anna',
          status: 'active',
          lastReconciledAt: new Date(),
        },
      });
      await tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId: account.id,
          entitlementId: entitlement.id,
          origin: 'discovered',
        },
      });
      return { ownerPersonId, subjectPersonId: annaPersonId };
    });
    manager = seeded.ownerPersonId;
    subject = seeded.subjectPersonId;
    const built = await buildSnapshot(ctx.tenantId, {});
    snapshot = built.snapshotId;
  });

  it('runs a campaign from creation to a confirmed revocation batch', async () => {
    await seedAdmin('gov', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov');

    // The scope preview, BEFORE anything is created. The screen that catches a
    // campaign covering nothing, or everything.
    const preview = await post('/api/admin/govern/campaigns/preview-scope', cookie, {
      scope: { resourceKinds: ['targetEntitlement'] },
      snapshotId: snapshot,
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { holdings: number }).holdings).toBeGreaterThan(0);

    const created = await post('/api/admin/govern/campaigns', cookie, {
      name: 'Q2 review',
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'person',
      reviewerConfig: { personId: manager },
      fallbackSelector: 'person',
      fallbackConfig: { personId: manager },
      ownerPersonId: manager,
      opensAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      snapshotId: snapshot,
    });
    expect(created.statusCode).toBe(201);
    const campaignId = (created.json() as { id: string }).id;

    expect((await post(`/api/admin/govern/campaigns/${campaignId}/start`, cookie)).statusCode).toBe(
      200,
    );

    // Decide every item `revoke`, the way a reviewer would.
    await withTenant(ctx.tenantId, async (tx) => {
      const items = await tx.campaignItem.findMany({ where: { campaignId } });
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        await tx.campaignDecision.create({
          data: {
            tenantId: ctx.tenantId,
            itemId: item.id,
            personId: manager,
            decision: 'revoke',
            comment: 'no longer needed',
            itemOpenedAt: new Date(),
            decidedAt: new Date(),
            sessionDecisionOrdinal: 1,
            coverageAtDecision: {},
          },
        });
        await tx.campaignItem.update({
          where: { id: item.id },
          data: { status: 'revoke_decided' },
        });
      }
    });

    const computed = await post(`/api/admin/govern/campaigns/${campaignId}/revocations`, cookie);
    expect(computed.statusCode).toBe(200);
    const batch = computed.json() as {
      batchId: string;
      status: string;
      requiresConfirmation: boolean;
      blockedReason: string | null;
    };
    // The FIRST batch in a tenant always requires confirmation, whatever its
    // size: every denominator is zero and no percentage can say anything.
    expect(batch.status).toBe('previewed');
    expect(batch.requiresConfirmation).toBe(true);
    expect(batch.blockedReason).toContain('first revocation batch');

    const detail = await get(`/api/admin/govern/batches/${batch.batchId}`, cookie);
    expect(detail.statusCode).toBe(200);
    const rows = (detail.json() as { dispatches: { route: string; sequence: number }[] }).dispatches;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.sequence)).toEqual([...rows.keys()]);

    // A body with no `confirmed` is a 400, not a silent refusal and not a
    // silent pass: the field is required, never defaulted.
    const unconfirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/govern/batches/${batch.batchId}/confirm`,
      headers: { host: ctx.host, cookie },
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);

    // `confirmed: false` reaches the service and is REFUSED, with the code.
    const declined = await post(`/api/admin/govern/batches/${batch.batchId}/confirm`, cookie, {
      confirmed: false,
    });
    expect(declined.statusCode).toBe(409);
    expect(declined.json()).toMatchObject({ type: expect.stringContaining('confirmation_required') });

    const confirmed = await post(`/api/admin/govern/batches/${batch.batchId}/confirm`, cookie, {
      confirmed: true,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'applied' });

    const order = await withTenant(ctx.tenantId, (tx) => tx.revocationOrder.findFirstOrThrow());
    // Ruling G1's condition: the order names a human, a campaign and a reason.
    expect(order.campaignName).toBe('Q2 review');
    expect(order.decidedByPersonName).toContain('Ola');
    expect(order.reason).toContain('no longer needed');
  });

  it('refuses the whole chain to a reader who cannot manage', async () => {
    await seedAdmin('reader', [PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('reader');
    // The READ is allowed...
    expect((await get('/api/admin/govern/campaigns', cookie)).statusCode).toBe(200);
    // ...and every write is not.
    for (const url of [
      '/api/admin/govern/campaigns',
      `/api/admin/govern/campaigns/${'00000000-0000-0000-0000-000000000001'}/start`,
      `/api/admin/govern/campaigns/${'00000000-0000-0000-0000-000000000001'}/revocations`,
      `/api/admin/govern/batches/${'00000000-0000-0000-0000-000000000001'}/confirm`,
      '/api/admin/govern/sod/rules',
    ]) {
      expect((await post(url, cookie, {})).statusCode, url).toBe(403);
    }
  });

  it('keeps risk acceptance behind govern.accept_risk, not govern.manage', async () => {
    // Administering the governance module and accepting the organization's risk
    // are different jobs, and a product that conflates them hands risk
    // acceptance to whoever configures the software.
    await seedAdmin('gov2', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov2');
    const res = await post(
      `/api/admin/govern/sod/exceptions/${'00000000-0000-0000-0000-000000000001'}/decide`,
      cookie,
      { decision: 'approve', comment: 'fine' },
    );
    expect(res.statusCode).toBe(403);
  });

  it('previews a SoD rule before it is saved, and saves nothing doing it', async () => {
    await seedAdmin('gov3', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov3');
    const holdings = await withTenant(ctx.tenantId, (tx) =>
      tx.holding.findMany({ where: { snapshotId: snapshot }, take: 2 }),
    );
    expect(holdings.length).toBeGreaterThan(0);

    const fn = async (name: string, resourceId: string) => {
      const res = await post('/api/admin/govern/sod/functions', cookie, {
        name,
        ownerPersonId: manager,
        resources: [
          { systemId: holdings[0]!.systemId, resourceKind: 'targetEntitlement', resourceId },
        ],
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as { id: string }).id;
    };
    const a = await fn('Raise', holdings[0]!.resourceId);
    const b = await fn('Approve', '20000000-0000-0000-0000-0000000000ff');

    const before = await withTenant(ctx.tenantId, (tx) => tx.sodRule.count());
    const preview = await post('/api/admin/govern/sod/rules/preview', cookie, {
      functionAId: a,
      functionBId: b,
      severity: 'critical',
    });
    expect(preview.statusCode).toBe(200);
    // A rule that would fire against 400 people is a configuration error, and
    // the person with the console open is who should see it — before it exists.
    expect(preview.json()).toHaveProperty('violatingPersons');
    expect(await withTenant(ctx.tenantId, (tx) => tx.sodRule.count())).toBe(before);
    expect(subject).toBeTruthy();
  });
});

describe('the integrity buttons', () => {
  it('“Verify now” does not condemn a legitimately signed checkpoint', async () => {
    // The route called `verifyIncremental(tenantId)` with NO options, so
    // `signer` defaulted to null while the scheduler passed a real one built
    // from GOVERN_CHECKPOINT_KEY. `checkpointTrust` then returned `unknown_key`
    // for a checkpoint this deployment had signed itself.
    //
    // What followed: the result was forced to `broken`, a `critical`
    // `audit_chain_broken` finding was raised and mailed, a full genesis walk
    // ran inside the HTTP request -- and the recovery branch wrote a new head
    // checkpoint UNSIGNED, so that night's scheduled run refused to seed on it
    // and walked from genesis again. Pressing the button made the integrity
    // story permanently worse until somebody pressed it again.
    await seedAdmin('gov-integrity', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-integrity');

    const first = await post('/api/admin/govern/integrity/verify', cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: 'valid' });

    const checkpoint = await withTenant(ctx.tenantId, (tx) =>
      tx.auditCheckpoint.findFirstOrThrow({ orderBy: { sequence: 'desc' } }),
    );
    // The test app configures GOVERN_CHECKPOINT_KEY, so the checkpoint the
    // route wrote carries a key id -- which is the state the second call used
    // to condemn.
    expect(checkpoint.keyId).not.toBeNull();

    const second = await post('/api/admin/govern/integrity/verify', cookie);
    expect(second.json()).toMatchObject({ result: 'valid', signatureState: 'signed_and_verified' });

    const critical = await withTenant(ctx.tenantId, (tx) =>
      tx.governFinding.count({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(critical).toBe(0);
  });

  it('exposes full verification as its own explicitly invoked route', async () => {
    // §17: "Full verification from genesis remains available as a separate,
    // explicitly invoked, paged job." `verifyFull` was exported, tested, and
    // reachable from nothing -- so the one thing an investigation actually
    // wants was not in the product.
    await seedAdmin('gov-full', [PERMISSIONS.GOVERN_MANAGE, PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-full');

    const res = await post('/api/admin/govern/integrity/verify-full', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'valid', fromSequence: 1 });

    const check = await withTenant(ctx.tenantId, (tx) =>
      tx.auditChainCheck.findFirstOrThrow({ where: { mode: 'full' } }),
    );
    expect(check.result).toBe('valid');
  });

  it('keeps full verification behind govern.manage', async () => {
    await seedAdmin('gov-full-reader', [PERMISSIONS.GOVERN_READ]);
    const cookie = await cookieFor('gov-full-reader');
    expect((await post('/api/admin/govern/integrity/verify-full', cookie)).statusCode).toBe(403);
  });
});

it('refuses an early exception revocation to somebody with no standing', async () => {
  // §15's authority lives in the service, not on the route, because the rule
  // OWNER need not hold govern.accept_risk. So the route must still refuse a
  // plain reader — and it does, from the service rather than the guard.
  await seedAdmin('gov-ex-reader', [PERMISSIONS.GOVERN_READ]);
  const cookie = await cookieFor('gov-ex-reader');
  const res = await post(
    `/api/admin/govern/sod/exceptions/${'00000000-0000-0000-0000-000000000001'}/revoke`,
    cookie,
    { reason: 'no' },
  );
  // A 404-shaped failure from findUniqueOrThrow is acceptable here, because the
  // id does not exist. What must NOT happen is a 204.
  expect(res.statusCode).not.toBe(204);
});

it('answers 400 for a person report path that is not a uuid', async () => {
  await seedAdmin('uuidreader', [PERMISSIONS.GOVERN_READ]);
  const res = await get(
    '/api/admin/govern/reports/person/not-a-uuid',
    await cookieFor('uuidreader'),
  );
  expect(res.statusCode).toBe(400);
});
