import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
  type JobHandler,
  type Scheduler,
} from '@syntra/core';
import type { CatalogRoute } from '../openapi/route-catalog.js';
import { OPENAPI_PATH } from '../openapi/route.js';
import { toOpenApiPath } from '../openapi/document.js';
import { startSyncScheduler } from '../scheduler.js';
import { buildTestApp, createFakeScheduler } from '../test-support.js';
import {
  ABSENT_IS_EMPTY,
  BODY_OVERRIDES,
  NO_ID_INPUT,
  UNPROBED_ROUTES,
  fillUrl,
  hasUuid,
  isCovered,
  kindOfField,
  resolveParams,
  sample,
  type IdOf,
  type Resolution,
} from './probe.js';
import { KINDS, createTenant, seedWorld, type Kind, type World } from './world.js';

/**
 * THE TENANT-ISOLATION PROBE (backlog #39).
 *
 * Two tenants, one of every kind of object in each (`world.ts`). Tenant A's
 * administrator -- every permission, elevated session, and a machine token for
 * SCIM -- then calls EVERY route in the running route table that takes an
 * object id, with tenant B's ids, and every list route, and every background
 * job handler with A's tenant and B's ids in its payload. For each call:
 *
 *  1. an id probe must be REFUSED: 403 or 404, or a 400/409/422 the route
 *     reached after looking (`validationFirst` counts the ones that did not);
 *     never 2xx and never 5xx;
 *  2. the response must not contain tenant B: not B's tag (which is in every
 *     B name, login and email), not any B id the request did not itself carry;
 *  3. after every write, tenant B's rows must be byte-for-byte what they were
 *     (`fingerprintB`), and no tenant A row may hold one of B's ids in any
 *     id or text column (`referencesToB`). The second is the one row-level
 *     security cannot give on its own: a foreign key is checked without RLS,
 *     so A's membership row pointing at B's user satisfies both the policy
 *     and the constraint unless the code looked first.
 *
 * Every failure is collected rather than thrown, and the list IS the
 * assertion: a red run names every route that leaked, in one go.
 *
 * The structural tests at the bottom are what keep this exhaustive: a route
 * whose parameters `probe.ts` cannot classify, or a parameterless write it
 * has not been told about, or a job queue it has no payload for, fails the
 * suite until somebody decides what it means.
 */

const PASSWORD = 'a-long-enough-password';
const B_HOST = 'bravo.syntra.test';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let A: World;
let B: World;
let cookie: string;
let bearer: string;
let document: { paths: Record<string, Record<string, OpenApiOperation>> };
const handlers = new Map<string, JobHandler<unknown>>();
/** The last error a handler threw, so a 500 in the failure list says why. */
let lastError: string | null = null;

interface OpenApiOperation {
  parameters?: { name: string; in: string; required?: boolean; schema: Record<string, unknown> }[];
  requestBody?: { content?: { 'application/json'?: { schema: Record<string, unknown> } } };
}

beforeAll(async () => {
  ctx = await buildTestApp({
    scheduler: () => createFakeScheduler(),
    // The probe logs in a handful of times and makes several hundred calls.
    // Auth limits are the only ones a single caller could plausibly reach.
    env: { AUTH_RATE_LIMIT_MAX: '1000', AUTH_RATE_LIMIT_TENANT_MAX: '10000' },
  });
  ctx.app.addHook('onError', async (_request, _reply, error) => {
    const code = (error as { code?: string }).code;
    lastError = `${error.name}${code ? ` ${code}` : ''}: ${error.message.replace(/\s+/g, ' ')}`.slice(0, 400);
  });
  await ctx.app.ready();
  const bravo = await createTenant('Bravo', 'bravo');
  A = await seedWorld(ctx.tenantId, 'zzalpha');
  B = await seedWorld(bravo, 'zzbravo');

  // A's administrator: every permission, a person of its own (the portal
  // routes act as "the person behind this session"), a password and a token.
  const hash = await hashPassword(PASSWORD);
  bearer = await withTenant(ctx.tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Probe', familyName: 'Admin' },
    });
    const user = await createUser(tx, { login: 'prober', email: 'prober@acme.test', displayName: 'Prober' });
    await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
    await setPasswordHash(tx, user.id, hash);
    const role = await createRole(tx, 'Everything', ALL_PERMISSIONS);
    await assignRole(tx, user.id, role.id);
    const issued = await issueApiToken(tx, { userId: user.id, name: 'probe', scopes: [], expiresAt: null, createdBy: user.id });
    return issued.token;
  });
  // B's user gets a password too, so "B's user cannot sign in at A's host"
  // is refused for the right reason rather than for having no password.
  await withTenant(B.tenantId, (tx) => setPasswordHash(tx, B.ids.user, hash));
  cookie = await login();

  document = (await ctx.app.inject({ method: 'GET', url: OPENAPI_PATH })).json();

  // The PRODUCTION registrations, captured: `startSyncScheduler` is what the
  // server calls, so a job added there is a job the probe sees.
  const capturing: Scheduler = {
    ...createFakeScheduler(),
    register: (name, handler) => {
      handlers.set(name, handler as JobHandler<unknown>);
    },
  };
  await startSyncScheduler(ctx.config, ctx.app.log, () => capturing, { transport: ctx.mail });
}, 120_000);

afterAll(async () => {
  await ctx?.app.close();
});

async function login(host = ctx.host, loginName = 'prober'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host },
    payload: { login: loginName, password: PASSWORD },
  });
  const portal = res.cookies.find((c) => c.name === 'syntra_session')?.value;
  if (portal === undefined) throw new Error(`login failed: ${res.statusCode} ${res.payload}`);
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

// ---- what "tenant B" looks like, from tenant A ---------------------------------

let tenantTables: string[] | null = null;
async function tables(): Promise<string[]> {
  tenantTables ??= (
    await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
      ORDER BY table_name`
  ).map((row) => row.table_name);
  return tenantTables;
}

/**
 * One digest per tenant table of one tenant's rows, plus its tenant row. Taken
 * as that tenant, so RLS scopes it exactly; equal before and after means
 * nothing inserted, updated or deleted any of its rows.
 */
async function fingerprint(tenantId: string, skip: ReadonlySet<string> = new Set()): Promise<Record<string, string>> {
  const names = (await tables()).filter((t) => !skip.has(t));
  const columns = names
    .map((t) => `(SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "${t}" x) AS "${t}"`)
    .join(',\n');
  const [row] = await withTenant(tenantId, (tx) =>
    tx.$queryRawUnsafe<Record<string, string>[]>(`SELECT ${columns}`),
  );
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return { ...row!, Tenant: JSON.stringify(tenant) };
}

/** Tenant B, whole: nothing tenant A does may change any of it. */
const fingerprintB = () => fingerprint(B.tenantId);

/**
 * Tenant A, less what every authenticated request legitimately writes: the
 * audit trail (a refusal is audited), the session's last-seen time and the
 * token's last use. A REFUSED request must not change anything else of A's
 * either -- that is what catches a route that ignores one of its own path
 * parameters, `DELETE /applications/<B's app>/assignments/<A's assignment>`
 * deleting A's assignment because it never checked whose application it was.
 */
const VOLATILE = new Set(['AuditEvent', 'Session', 'ApiToken']);
const fingerprintA = () => fingerprint(A.tenantId, VOLATILE);

function diff(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

/**
 * Tables whose text columns legitimately repeat what A's caller SENT.
 *
 * The audit log records a refused request, target id included -- that is the
 * id A supplied, already in A's hands, not a reference A's data now holds to
 * B's. Everything else is scanned.
 */
const ECHO_TABLES = new Set(['AuditEvent']);

/**
 * Columns that hold a string the CALLER chose and nothing ever looks a row up
 * by, so B's id in one is B's id as a word, not a reference to B's row. Each
 * is reviewed like an allow-list entry.
 */
const OPAQUE_COLUMNS: ReadonlyMap<string, string> = new Map([
  [
    'PersonProvisionReceipt.requestKey',
    "The caller's idempotency key for a provisioning request: any uuid it likes, unique per person and target, never resolved to a row.",
  ],
  [
    'ResourceClassification.systemId',
    "A classification LABEL keyed by free text (a system may be Syntra itself). It only ever matches this tenant's own holdings, which cannot carry another tenant's ids.",
  ],
  ['ResourceClassification.resourceId', 'See ResourceClassification.systemId.'],
]);

let referenceSql: string | null = null;
/**
 * Every (table, column, row) of tenant A that holds one of B's ids, in any
 * uuid, text or array-of-either column. Taken as A. By row, so a second route
 * writing the same column is reported too rather than hidden by the first.
 */
async function referencesToB(): Promise<string[]> {
  if (referenceSql === null) {
    const names = new Set(await tables());
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string; udt_name: string }[]>`
      SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name NOT IN ('id', 'tenantId')
        AND (data_type IN ('uuid', 'text', 'character varying')
             OR (data_type = 'ARRAY' AND udt_name IN ('_uuid', '_text')))`;
    referenceSql = cols
      .filter((c) => names.has(c.table_name) && !ECHO_TABLES.has(c.table_name))
      .filter((c) => !OPAQUE_COLUMNS.has(`${c.table_name}.${c.column_name}`))
      .map((c) =>
        c.data_type === 'ARRAY'
          ? `SELECT '${c.table_name}.${c.column_name} row ' || x."id"::text AS hit FROM "${c.table_name}" x WHERE x."${c.column_name}"::text[] && $1::text[]`
          : `SELECT '${c.table_name}.${c.column_name} row ' || x."id"::text AS hit FROM "${c.table_name}" x WHERE x."${c.column_name}"::text = ANY($1::text[])`,
      )
      .join('\nUNION ALL\n');
  }
  const bIds = Object.values(B.ids);
  const rows = await withTenant(A.tenantId, (tx) =>
    tx.$queryRawUnsafe<{ hit: string }[]>(referenceSql!, bIds),
  );
  return [...new Set(rows.map((row) => row.hit))];
}

/** Tenant B, anywhere in a response body, except the ids the request itself carried. */
function leaks(body: string, carried: Set<string>): string[] {
  const found: string[] = [];
  if (body.toLowerCase().includes(B.tag)) found.push(`B's tag "${B.tag}"`);
  for (const kind of KINDS) {
    const id = B.ids[kind];
    if (!carried.has(id) && body.includes(id)) found.push(`B's ${kind} id`);
  }
  return found;
}

// ---- calling a route --------------------------------------------------------------

const REFUSED = new Set([400, 403, 404, 409, 422]);
const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

interface Call {
  route: CatalogRoute;
  params: Record<string, string>;
  query?: Record<string, string> | undefined;
  payload?: unknown;
  host?: string;
}

async function send(call: Call) {
  const url = fillUrl(call.route.url, call.params);
  const search = call.query && Object.keys(call.query).length > 0 ? `?${new URLSearchParams(call.query)}` : '';
  const scim = call.route.url.startsWith('/scim/v2/');
  return ctx.app.inject({
    method: call.route.method as 'GET',
    url: url + search,
    headers: {
      host: call.host ?? ctx.host,
      ...(scim ? { authorization: `Bearer ${bearer}` } : { cookie }),
      ...(call.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(call.payload === undefined ? {} : { payload: JSON.stringify(call.payload) }),
  });
}

function operationOf(route: CatalogRoute): OpenApiOperation | undefined {
  return document.paths[toOpenApiPath(route.url)]?.[route.method.toLowerCase()];
}

/** A body for `route` whose id fields are `ids`' -- B's, for the probe. */
function bodyFor(route: CatalogRoute, id: IdOf, own: IdOf, optionalIds = true): unknown {
  const override = BODY_OVERRIDES.get(key(route));
  if (override) return override(id, own);
  const schema = operationOf(route)?.requestBody?.content?.['application/json']?.schema;
  if (schema === undefined) return route.method === 'GET' || route.method === 'DELETE' ? undefined : {};
  return sample(schema, (field) => id(kindOfField(field)), schema, '', 0, optionalIds);
}

/** The body with optional ids, and -- when it differs -- the body without them. */
function bodyVariants(route: CatalogRoute, id: IdOf, own: IdOf): unknown[] {
  const withIds = bodyFor(route, id, own, true);
  const without = bodyFor(route, id, own, false);
  return JSON.stringify(withIds) === JSON.stringify(without) ? [withIds] : [withIds, without];
}

function queryFor(route: CatalogRoute, id: IdOf): Record<string, string> {
  const out: Record<string, string> = {};
  for (const parameter of operationOf(route)?.parameters ?? []) {
    if (parameter.in !== 'query') continue;
    if (!parameter.required && !hasUuid(parameter.schema)) continue;
    const value = sample(parameter.schema, (field) => id(kindOfField(field)), parameter.schema, parameter.name);
    if (value !== undefined && value !== null) out[parameter.name] = String(value);
  }
  return out;
}

function bodyHasIds(route: CatalogRoute): boolean {
  if (BODY_OVERRIDES.has(key(route))) return true;
  const op = operationOf(route);
  const schema = op?.requestBody?.content?.['application/json']?.schema;
  return (schema !== undefined && hasUuid(schema)) ||
    (op?.parameters ?? []).some((p) => p.in === 'query' && hasUuid(p.schema));
}

const bId: IdOf = (kind) => B.ids[kind];
const aId: IdOf = (kind) => A.ids[kind];

function valuesFor(resolved: Resolution[], pick: (r: Resolution, index: number) => IdOf) {
  const values: Record<string, string> = {};
  resolved.forEach((r, index) => {
    values[r.name] = 'fixed' in r ? r.fixed : pick(r, index)(r.kind);
  });
  return values;
}

/**
 * `call` with every one of B's ids replaced by a fresh id nobody holds, and a
 * function that maps a ghost answer back onto B's ids for comparison.
 */
function ghostOf(call: Call): { call: Call; unghost: (text: string) => string } {
  const swap = new Map<string, string>(Object.values(B.ids).map((id) => [id, randomUUID()]));
  const back = new Map<string, string>([...swap].map(([real, ghost]) => [ghost, real]));
  const replace = <T>(value: T): T =>
    value === undefined
      ? value
      : JSON.parse(JSON.stringify(value).replace(/[0-9a-f-]{36}/g, (id) => swap.get(id) ?? id)) as T;
  return {
    call: { ...call, params: replace(call.params), query: replace(call.query), payload: replace(call.payload) },
    unghost: (text) => text.replace(/[0-9a-f-]{36}/g, (id) => back.get(id) ?? id),
  };
}

function carried(values: Record<string, string>, extra: unknown): Set<string> {
  const text = JSON.stringify(values) + JSON.stringify(extra ?? null);
  return new Set(Object.values(B.ids).filter((id) => text.includes(id)));
}

/** The routes the probe is responsible for. */
function covered(): CatalogRoute[] {
  return ctx.app.routeCatalog.filter((route) => isCovered(route) && !UNPROBED_ROUTES.has(key(route)));
}

// ---- the probe ------------------------------------------------------------------------

describe('tenant isolation: every route, tenant A calling with tenant B', () => {
  it('seeded a real object of every kind in both tenants', () => {
    for (const kind of KINDS) {
      expect(A.ids[kind], kind).toMatch(/^[0-9a-f-]{36}$/);
      expect(B.ids[kind], kind).toMatch(/^[0-9a-f-]{36}$/);
      expect(A.ids[kind]).not.toBe(B.ids[kind]);
    }
  });

  it('refuses B\'s ids on every id-bearing route, leaks nothing, and touches nothing of B', async () => {
    const failures: string[] = [];
    const stats = {
      idProbes: 0,
      mixedProbes: 0,
      bodyProbes: 0,
      listProbes: 0,
      refusedNotFoundOrForbidden: 0,
      refusedOtherwise: 0,
      absentIsEmpty: 0,
    };
    // Moving baselines, so each defect is reported once, against the call
    // that caused it, rather than against every call after it.
    let baseline = await fingerprintB();
    const knownRefs = new Set<string>();

    const check = async (label: string, call: Call, expectRefusal: boolean) => {
      // THE GHOST CALL FIRST: the same request with every B id swapped for an
      // id that never existed anywhere. Whatever the route says about B's
      // object, it must say about nothing at all -- otherwise the difference
      // is an oracle for "this id exists in some other tenant". It runs first
      // because it cannot change anything; nothing exists for it to change.
      const ghostly = expectRefusal ? ghostOf(call) : null;
      const ghost = ghostly ? await send(ghostly.call) : null;
      const aBefore = expectRefusal && call.route.method !== 'GET' ? await fingerprintA() : null;
      lastError = null;
      const res = await send(call);
      const status = res.statusCode;
      // `PROBE_LOG=<file>` writes every call and its answer, for reading what a
      // run actually exercised (which body probes validation stopped, say).
      if (process.env.PROBE_LOG) {
        appendFileSync(process.env.PROBE_LOG, `${status} ${label} ${res.payload.slice(0, 160).replace(/\s+/g, ' ')}\n`);
      }
      const allowedEmpty = ABSENT_IS_EMPTY.has(key(call.route));
      if (status >= 500) failures.push(`${label}: ${status} ${lastError ?? res.payload.slice(0, 200)}`);
      else if (status === 401 || status === 429) failures.push(`${label}: ${status} -- the probe lost its session or was rate limited, so proved nothing`);
      else if (expectRefusal && !REFUSED.has(status) && !allowedEmpty) failures.push(`${label}: ${status}, expected a refusal`);
      if (ghost !== null && ghost.statusCode !== status) {
        failures.push(`${label}: answered ${status} for B's id but ${ghost.statusCode} for an id that never existed`);
      } else if (ghost !== null && allowedEmpty && status < 300 && ghostly!.unghost(ghost.payload) !== res.payload) {
        // A success is only acceptable if it is the SAME success nothing gets.
        failures.push(`${label}: its ${status} for B's id differs from its ${status} for an id that never existed`);
      }
      if (expectRefusal) {
        if (status === 403 || status === 404) stats.refusedNotFoundOrForbidden++;
        else if (REFUSED.has(status)) stats.refusedOtherwise++;
        else if (allowedEmpty && status < 300) stats.absentIsEmpty++;
      }
      const leaked = leaks(res.payload, carried(call.params, { q: call.query, p: call.payload }));
      if (leaked.length > 0) failures.push(`${label}: response contains ${leaked.join(', ')}`);
      if (aBefore !== null) {
        const changedA = diff(aBefore, await fingerprintA());
        if (changedA.length > 0) failures.push(`${label}: was refused but changed tenant A's ${changedA.join(', ')}`);
      }
      if (call.route.method !== 'GET') {
        const after = await fingerprintB();
        const changed = diff(baseline, after);
        if (changed.length > 0) failures.push(`${label}: changed tenant B's ${changed.join(', ')}`);
        baseline = after;
        const refs = (await referencesToB()).filter((ref) => !knownRefs.has(ref));
        if (refs.length > 0) failures.push(`${label}: left tenant A holding B's ids in ${refs.join(', ')}`);
        refs.forEach((ref) => knownRefs.add(ref));
      }
    };

    // Reads first, then writes: a write that wrongly succeeded must not be
    // able to hide a read leak by changing what the read would have found.
    const routes = covered().sort((x, y) => Number(x.method !== 'GET') - Number(y.method !== 'GET'));
    for (const route of routes) {
      const { resolved, unknown } = resolveParams(route.url);
      if (unknown.length > 0) continue; // the structural test reports these
      const kinds = resolved.filter((r): r is { name: string; kind: Kind } => 'kind' in r);

      if (kinds.length === 0) {
        if (route.method === 'GET') {
          // LIST: bare, and with every id-shaped filter pointed at B.
          stats.listProbes++;
          await check(`${key(route)} (list)`, { route, params: valuesFor(resolved, () => aId), query: queryFor(route, aId) }, false);
          if (bodyHasIds(route)) {
            await check(`${key(route)} (list, B filters)`, { route, params: valuesFor(resolved, () => aId), query: queryFor(route, bId) }, false);
          }
        } else if (bodyHasIds(route) && !NO_ID_INPUT.has(key(route))) {
          // BODY: a create or bulk action whose id fields all name B.
          for (const [index, payload] of bodyVariants(route, bId, aId).entries()) {
            stats.bodyProbes++;
            await check(`${key(route)} (body→B${index === 0 ? '' : ', required fields only'})`, {
              route,
              params: valuesFor(resolved, () => aId),
              query: queryFor(route, bId),
              payload,
            }, false);
          }
        }
        continue;
      }

      // ALL B: every id parameter, and every id in the body, is B's.
      stats.idProbes++;
      await check(`${key(route)} (all B)`, {
        route,
        params: valuesFor(resolved, () => bId),
        query: queryFor(route, bId),
        payload: bodyFor(route, bId, aId),
      }, true);

      // MIXED, one B parameter at a time, the rest A's own: A's group with
      // B's user in the member slot.
      if (kinds.length > 1) {
        for (const target of kinds) {
          stats.mixedProbes++;
          await check(`${key(route)} (only :${target.name} B)`, {
            route,
            params: valuesFor(resolved, (r) => ('kind' in r && r.name === target.name ? bId : aId)),
            query: queryFor(route, aId),
            payload: bodyFor(route, aId, aId),
          }, true);
        }
      }

      // OWN PATH, FOREIGN BODY: A's object, with every id in the body B's.
      // It may succeed -- a body id can be optional or ignored -- but it must
      // not leave A pointing at B or change B.
      if (bodyHasIds(route) && route.method !== 'GET') {
        for (const [index, payload] of bodyVariants(route, bId, aId).entries()) {
          stats.mixedProbes++;
          await check(`${key(route)} (A path, body→B${index === 0 ? '' : ', required fields only'})`, {
            route,
            params: valuesFor(resolved, () => aId),
            query: queryFor(route, bId),
            payload,
          }, false);
        }
      }
    }

    // Printed so the coverage a run achieved is on the record, not only its verdict.
    console.info('tenant-isolation probe', { routes: routes.length, ...stats });
    expect(failures).toEqual([]);
  }, 600_000);
});

describe('tenant isolation: the credential is bound to the tenant that issued it', () => {
  it('refuses A\'s administrative session at B\'s host', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: B_HOST, cookie } });
    expect(res.statusCode).toBe(401);
    expect(leaks(res.payload, new Set())).toEqual([]);
  });

  it('refuses A\'s machine token at B\'s host, on the admin API and on SCIM', async () => {
    for (const url of ['/api/admin/users', '/scim/v2/Users']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { host: B_HOST, authorization: `Bearer ${bearer}` } });
      expect(res.statusCode, url).toBe(401);
      expect(leaks(res.payload, new Set()), url).toEqual([]);
    }
  });

  it('does not sign B\'s user in at A\'s host, with B\'s correct password', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: `${B.tag}-user`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });
});

/**
 * THE DEFECTS THE PROBE FOUND, PINNED BY NAME.
 *
 * The probe above would catch each of these again, but only as one line in a
 * list of hundreds. These say what the defect was, in the words of the route,
 * so a regression reads as the bug it is.
 */
describe('tenant isolation: the defects this suite found stay fixed', () => {
  const as = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    ctx.app.inject({
      method,
      url,
      headers: { host: ctx.host, cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** A fresh person with one contract, and a fresh application with one assignment and one claim. */
  async function freshA() {
    return withTenant(A.tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId: A.tenantId, givenName: 'Fresh', familyName: 'Person' } });
      await tx.contract.create({ data: { tenantId: A.tenantId, personId: person.id, sequence: 1, startDate: new Date() } });
      const app = await tx.application.create({ data: { tenantId: A.tenantId, name: 'Fresh', slug: `fresh-${randomUUID().slice(0, 8)}` } });
      const assignment = await tx.appAssignment.create({
        data: { tenantId: A.tenantId, applicationId: app.id, subjectType: 'group', groupId: A.ids.group },
      });
      const claim = await tx.claimMapping.create({
        data: { tenantId: A.tenantId, applicationId: app.id, protocol: 'oidc', claimName: 'fresh', sourceKind: 'attribute' },
      });
      return { person, app, assignment, claim };
    });
  }

  it('refuses another tenant\'s rows as body references instead of pointing at them', async () => {
    const fresh = await freshA();
    const before = new Set(await referencesToB());
    // Each of these wrote the foreign id, because a foreign key is checked
    // without RLS and nothing looked the id up first.
    const refused = [
      await as('POST', '/api/admin/persons', { givenName: 'X', familyName: 'Y', orgUnitId: B.ids.orgUnit }),
      await as('PATCH', `/api/admin/persons/${fresh.person.id}`, { orgUnitId: B.ids.orgUnit }),
      await as('PATCH', `/api/admin/persons/${fresh.person.id}/contracts/1`, { managerPersonId: B.ids.person }),
      await as('POST', `/api/admin/applications/${fresh.app.id}/assignments`, { type: 'user', id: B.ids.user }),
      await as('POST', `/api/admin/govern/findings/${A.ids.finding}/assign`, {
        ownerPersonId: B.ids.person,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      await as('PUT', '/api/admin/automate/resource-owners', {
        resourceType: 'group',
        resourceId: B.ids.group,
        ownerPersonId: A.ids.person,
        ownerGroupId: null,
      }),
    ];
    expect(refused.map((res) => res.statusCode)).toEqual(refused.map(() => 404));
    expect((await referencesToB()).filter((ref) => !before.has(ref))).toEqual([]);
  });

  it('removes an application\'s assignment or claim only through that application\'s own path', async () => {
    const fresh = await freshA();
    // B's application in the path, A's assignment and claim in the tail: both
    // were deleted, and the audit event named B's application as the target.
    expect((await as('DELETE', `/api/admin/applications/${B.ids.application}/assignments/${fresh.assignment.id}`)).statusCode).toBe(204);
    expect((await as('DELETE', `/api/admin/applications/${B.ids.application}/claims/${fresh.claim.id}`)).statusCode).toBe(204);
    const kept = await withTenant(A.tenantId, async (tx) => ({
      assignment: await tx.appAssignment.findUnique({ where: { id: fresh.assignment.id } }),
      claim: await tx.claimMapping.findUnique({ where: { id: fresh.claim.id } }),
    }));
    expect(kept.assignment).not.toBeNull();
    expect(kept.claim).not.toBeNull();
  });

  it('skips an import change only under the run it belongs to', async () => {
    const res = await as('POST', `/api/admin/person-import-runs/${B.ids.personImportRun}/changes/${A.ids.personImportChange}/skip`);
    expect(res.statusCode).toBe(404);
  });

  it('answers another tenant\'s id with 404, not a 500, where the lookup was an update or a findUniqueOrThrow', async () => {
    for (const [method, url] of [
      ['DELETE', `/api/admin/webhooks/${B.ids.webhook}`],
      ['DELETE', `/api/admin/roles/${B.ids.role}`],
      ['POST', `/api/admin/sources/${B.ids.source}/run`],
      ['POST', `/api/admin/person-sources/${B.ids.personSource}/run`],
    ] as const) {
      const res = await as(method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/govern/snapshots/${B.ids.snapshot}`,
      headers: { host: ctx.host, cookie },
    });
    expect(snapshot.statusCode).toBe(404);
    const containers = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/targets/${B.ids.target}/containers`,
      headers: { host: ctx.host, cookie },
    });
    expect(containers.statusCode).toBe(404);
  });
});

describe('tenant isolation: Govern source refresh names only this tenant\'s sources', () => {
  it.each([
    ['directorySource', () => B.ids.source],
    ['targetSystem', () => B.ids.target],
  ] as const)('refuses %s ids from tenant B instead of enqueueing a job for them', async (kind, id) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/govern/sources/${kind}/${id()}/refresh`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---- background jobs --------------------------------------------------------------

/**
 * A payload per registered queue: tenant A's context, tenant B's ids.
 *
 * Every queue the production scheduler registers must have one (the
 * structural test below), because a job is where tenancy is most easily lost:
 * it has no request, no Host header, and its tenant is whatever the payload
 * says. The handler must bind to the payload's tenant and then look the ids
 * up INSIDE it, so B's ids resolve to nothing.
 */
const JOB_PAYLOADS: ReadonlyMap<string, () => Record<string, unknown>> = new Map([
  ['sync.run', () => ({ tenantId: A.tenantId, sourceId: B.ids.source, runId: B.ids.syncRun })],
  ['personSource.run', () => ({ tenantId: A.tenantId, sourceId: B.ids.personSource, runId: B.ids.personImportRun })],
  ['notify.webhook', () => ({ tenantId: A.tenantId })],
  ['access.logout_deliver', () => ({ tenantId: A.tenantId })],
  ['keys.rotate', () => ({ tenantId: A.tenantId, kind: 'oidc' })],
  ['provision.run', () => ({ tenantId: A.tenantId, targetSystemId: B.ids.target })],
  ['provision.person', () => ({ tenantId: A.tenantId, receiptId: B.ids.receipt })],
  ['lifecycle.maintenance', () => ({ tenantId: A.tenantId })],
  ['lifecycle.retention', () => ({ tenantId: A.tenantId })],
  ['provision.write_stop_expiry', () => ({ tenantId: A.tenantId })],
  ['exports.generate', () => ({ tenantId: A.tenantId, exportId: B.ids.export })],
  ['exports.sweep', () => ({ tenantId: A.tenantId })],
  ['automate.outbox', () => ({ tenantId: A.tenantId })],
  ['automate.digest', () => ({ tenantId: A.tenantId })],
  ['automate.tick', () => ({ tenantId: A.tenantId })],
  ['automate.sweep', () => ({ tenantId: A.tenantId })],
  ['govern.snapshot.build', () => ({ tenantId: A.tenantId })],
  ['govern.snapshot.prune', () => ({ tenantId: A.tenantId })],
  ['govern.audit.verify', () => ({ tenantId: A.tenantId })],
  ['govern.audit.anchor', () => ({ tenantId: A.tenantId })],
  ['govern.campaign.remind', () => ({ tenantId: A.tenantId })],
  ['govern.campaign.close', () => ({ tenantId: A.tenantId })],
  ['govern.exception.sweep', () => ({ tenantId: A.tenantId })],
]);

describe('tenant isolation: every background job, A\'s context with B\'s ids', () => {
  it('runs every registered handler without touching tenant B or pointing A at it', async () => {
    const failures: string[] = [];
    for (const [name, handler] of handlers) {
      const payload = JOB_PAYLOADS.get(name);
      if (payload === undefined) continue; // the structural test reports it
      const before = await fingerprintB();
      const refsBefore = new Set(await referencesToB());
      let outcome = 'completed';
      try {
        await handler(payload());
      } catch (cause) {
        // Failing is a fine answer to "run B's source as A". What matters is
        // what it did to B on the way.
        outcome = `failed closed (${(cause as Error).message.slice(0, 80)})`;
      }
      const changed = diff(before, await fingerprintB());
      if (changed.length > 0) failures.push(`${name} [${outcome}]: changed tenant B's ${changed.join(', ')}`);
      const refs = (await referencesToB()).filter((ref) => !refsBefore.has(ref));
      if (refs.length > 0) failures.push(`${name} [${outcome}]: left tenant A holding B's ids in ${refs.join(', ')}`);
    }
    expect(failures).toEqual([]);
    expect(handlers.size).toBeGreaterThan(15);
  }, 300_000);
});

// ---- the structural tests: the probe cannot silently fall behind the API ----------

describe('tenant isolation: every route and job is classified', () => {
  it('knows what every path parameter of every covered route names', () => {
    const unclassified = covered()
      .map((route) => ({ route: key(route), unknown: resolveParams(route.url).unknown }))
      .filter((entry) => entry.unknown.length > 0)
      .map((entry) => `${entry.route}: ${entry.unknown.join(', ')}`);
    // The fix is an entry in PARAM_KINDS (probe.ts) -- and, for a new kind of
    // object, a row of it in world.ts.
    expect(unclassified).toEqual([]);
  });

  it('has decided about every parameterless write: probed through its body, or no id input', () => {
    const undecided = covered()
      .filter((route) => route.method !== 'GET' && !route.url.includes('/:'))
      .filter((route) => !bodyHasIds(route) && !NO_ID_INPUT.has(key(route)))
      .map(key);
    // The fix is a BODY_OVERRIDES entry that points the body at tenant B, or
    // a NO_ID_INPUT entry that says why the route names nothing.
    expect(undecided).toEqual([]);
  });

  it('keeps its allow-lists honest: every entry is a registered route and says why', () => {
    const registered = new Set(ctx.app.routeCatalog.map(key));
    for (const [route, reason] of [...NO_ID_INPUT, ...UNPROBED_ROUTES]) {
      expect(registered.has(route), `${route} is listed but not registered`).toBe(true);
      expect(reason.trim().length, `${route} is listed without a reason`).toBeGreaterThan(15);
    }
    for (const route of BODY_OVERRIDES.keys()) {
      expect(registered.has(route), `${route} has a body override but is not registered`).toBe(true);
    }
  });

  it('has a tenant-B payload for every job queue the scheduler registers, and none for a queue it does not', () => {
    expect([...handlers.keys()].filter((name) => !JOB_PAYLOADS.has(name))).toEqual([]);
    expect([...JOB_PAYLOADS.keys()].filter((name) => !handlers.has(name))).toEqual([]);
  });

  it('covers the whole administration API', () => {
    const admin = covered().filter((route) => route.url.startsWith('/api/admin/'));
    expect(admin.length).toBe(ctx.app.routeCatalog.filter((route) => route.url.startsWith('/api/admin/')).length);
    expect(admin.length).toBeGreaterThan(300);
  });
});
