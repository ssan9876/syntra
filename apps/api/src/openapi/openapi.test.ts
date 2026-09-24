import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig, memoryTransport } from '@syntra/core';
import { buildApp } from '../app.js';
import { TOKEN_DENIED_ROUTES } from '../plugins/bearer-token.js';
import { pageQuery } from '../routes/admin/list-query.js';
import { ADMIN_ROUTE_DESCRIPTIONS } from './descriptions.js';
import { deprecationHeaders, honoursNoticePeriod, registerDeprecationHeaders } from './deprecation.js';
import { operationId, toOpenApiPath } from './document.js';
import { toJsonSchema } from './json-schema.js';
import { OPENAPI_PATH } from './route.js';

/**
 * ADMIN ROUTES DELIBERATELY LEFT OUT OF THE PUBLISHED DESCRIPTION.
 *
 * `'METHOD /api/admin/…'`, exactly as Fastify registered it, each with the
 * reason it is not part of the published contract. Empty today: every
 * administration route — including the ones a token is refused at, which are
 * published as session-only so an integrator can see they exist and why they
 * cannot call them — is described.
 *
 * An entry here is a DECISION, and it is reviewed like one: "not documented
 * yet" is not a reason, it is the failure this test exists to catch. Good
 * reasons are narrow — a route that exists only to serve the console's own
 * rendering and is expected to change with it, say, and which the README's
 * stability promise must therefore not cover. The test below also fails if an
 * entry names a route that no longer exists or that has since been described,
 * so the list cannot quietly outlive its reasons.
 */
const UNDESCRIBED_ADMIN_ROUTES: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * Built exactly as `pnpm openapi:generate` builds it — placeholder
 * configuration, no database — because what is being tested is the
 * registration-time route table, and that is the same in every environment.
 */
let app: FastifyInstance;
let document: {
  openapi: string;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: Record<string, Record<string, unknown>>;
};

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    PORT: '3000',
    PUBLIC_URL: 'https://syntra.example.com',
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 0).toString('base64'),
    SMTP_URL: 'smtp://127.0.0.1:1',
  });
  app = await buildApp(config, { logger: false, transport: memoryTransport() });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: OPENAPI_PATH });
  document = response.json();
});

afterAll(async () => {
  await app.close();
});

const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

describe('route coverage', () => {
  it('describes every registered /api/admin route that is not deliberately excluded', () => {
    const described = new Set(ADMIN_ROUTE_DESCRIPTIONS.map(key));
    const missing = app.routeCatalog
      .filter((route) => route.url.startsWith('/api/admin/'))
      .map(key)
      .filter((route) => !described.has(route) && !UNDESCRIBED_ADMIN_ROUTES.has(route));
    // The list IS the message: it names the routes to describe in the
    // sibling `<module>.openapi.ts`, which is the fix.
    expect(missing).toEqual([]);
  });

  it('describes no route that does not exist', () => {
    const registered = new Set(app.routeCatalog.map(key));
    const stale = ADMIN_ROUTE_DESCRIPTIONS.map(key).filter((route) => !registered.has(route));
    expect(stale).toEqual([]);
  });

  it('describes each route once', () => {
    const keys = ADMIN_ROUTE_DESCRIPTIONS.map(key);
    expect(keys.filter((route, index) => keys.indexOf(route) !== index)).toEqual([]);
  });

  it('keeps the exclusion list honest: every entry exists, is undescribed, and says why', () => {
    const registered = new Set(app.routeCatalog.map(key));
    const described = new Set(ADMIN_ROUTE_DESCRIPTIONS.map(key));
    for (const [route, reason] of UNDESCRIBED_ADMIN_ROUTES) {
      expect(registered.has(route), `${route} is excluded but not registered`).toBe(true);
      expect(described.has(route), `${route} is excluded but also described`).toBe(false);
      expect(reason.trim().length, `${route} is excluded without a reason`).toBeGreaterThan(20);
    }
  });

  it('publishes every route a machine token may call', () => {
    const published = new Set(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );
    const tokenCallable = app.routeCatalog.filter(
      (route) => route.url.startsWith('/api/admin/') && route.tokenAllowed,
    );
    // Sanity: the table was captured at all, and is the size of the API.
    expect(tokenCallable.length).toBeGreaterThan(250);
    const unpublished = tokenCallable
      .filter((route) => !UNDESCRIBED_ADMIN_ROUTES.has(key(route)))
      .map((route) => `${route.method} ${toOpenApiPath(route.url)}`)
      .filter((route) => !published.has(route));
    expect(unpublished).toEqual([]);
  });

  it('gives every description a one-line summary', () => {
    for (const route of ADMIN_ROUTE_DESCRIPTIONS) {
      expect(route.summary.trim(), key(route)).not.toBe('');
      expect(route.summary, key(route)).not.toMatch(/TODO|\n|\.$/);
      expect(route.summary.length, key(route)).toBeLessThanOrEqual(90);
    }
  });
});

describe('the document', () => {
  it('is OpenAPI 3.1, served without a session or a tenant host', async () => {
    // No cookie, no token, and no Host a tenant resolves from.
    const response = await app.inject({
      method: 'GET',
      url: OPENAPI_PATH,
      headers: { host: 'nobody.invalid' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(document.openapi).toBe('3.1.0');
  });

  it('names the permission of every operation, derived from the guard that checks it', () => {
    // Routes with no route-level guard, named one at a time. The export
    // center's permission depends on the export's KIND (audit.read for the
    // audit log, govern.read + govern.export for Governance access), so the
    // service checks it at request, generation and every download, and a
    // caller only ever sees their own exports unless they hold tenant.manage.
    const unguarded = new Set([
      'post /api/admin/exports',
      'get /api/admin/exports',
      'get /api/admin/exports/{id}',
      'get /api/admin/exports/{id}/download',
      'post /api/admin/exports/{id}/revoke',
      // The break-glass banner: every administrator's console shows an
      // emergency activation, whatever permissions they hold.
      'get /api/admin/break-glass/status',
    ]);
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (unguarded.has(`${method} ${path}`)) continue;
        const permissions = operation['x-syntra-permission'] as string[];
        expect(permissions.length, `${method} ${path}`).toBeGreaterThan(0);
        for (const permission of permissions) expect(permission).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      }
    }
    // One spot check against a guard that is known: role administration is
    // rbac.manage, and nothing else.
    expect(document.paths['/api/admin/roles']!.get!['x-syntra-permission']).toEqual(['rbac.manage']);
  });

  it('offers only the session cookie where a token is refused, and both elsewhere', () => {
    for (const route of app.routeCatalog.filter((r) => r.url.startsWith('/api/admin/'))) {
      const operation = document.paths[toOpenApiPath(route.url)]?.[route.method.toLowerCase()];
      if (operation === undefined) continue;
      const refused = TOKEN_DENIED_ROUTES.some((denied) => route.url.startsWith(denied));
      expect(operation['x-syntra-token-allowed'], key(route)).toBe(!refused);
      expect(operation.security, key(route)).toEqual(
        refused ? [{ sessionCookie: [] }] : [{ bearerToken: [] }, { sessionCookie: [] }],
      );
    }
    // The minting route is the one that must never read as token-callable.
    expect(
      document.paths['/api/admin/users/{id}/tokens']!.post!['x-syntra-token-allowed'],
    ).toBe(false);
  });

  it('has unique operation ids', () => {
    const ids = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId as string),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(operationId('GET', '/api/admin/roles/:id/assignments')).toBe('getRolesByIdAssignments');
  });

  it('declares every path parameter and resolves every $ref', () => {
    const text = JSON.stringify(document);
    for (const [, section, name] of text.matchAll(/"#\/components\/(\w+)\/(\w+)"/g)) {
      expect(document.components[section!]?.[name!], `${section}/${name}`).toBeDefined();
    }
    for (const [path, methods] of Object.entries(document.paths)) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const operation of Object.values(methods)) {
        const declared = ((operation.parameters as { in: string; name: string }[] | undefined) ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name);
        expect(declared, path).toEqual(names);
      }
    }
  });

  it('publishes the paging parameters of a paged list, bounded as the server bounds them', () => {
    const users = document.paths['/api/admin/users']!.get!;
    expect(users['x-syntra-paginated']).toBe(true);
    const parameters = users.parameters as { name: string; schema: Record<string, unknown> }[];
    expect(parameters.find((p) => p.name === 'pageSize')?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
    });
  });

  it('describes errors as problem+json', () => {
    const operation = document.paths['/api/admin/roles']!.post!;
    expect((operation.responses as Record<string, unknown>)['403']).toEqual({
      $ref: '#/components/responses/Forbidden',
    });
    expect(document.components.schemas!.Problem).toMatchObject({
      required: ['type', 'title', 'status'],
    });
  });

  it('contains nothing from a tenant, the deployment, or the clock', () => {
    const text = JSON.stringify(document);
    // The placeholder configuration the document was built with must not
    // leak into it: none of it is an input.
    expect(text).not.toContain('unused@127.0.0.1');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('deprecation', () => {
  it('gives every deprecated operation at least the six months of notice the README promises', () => {
    for (const route of ADMIN_ROUTE_DESCRIPTIONS) {
      if (route.deprecated) expect(honoursNoticePeriod(route.deprecated), key(route)).toBe(true);
    }
    expect(honoursNoticePeriod({ since: '2026-01-31', sunset: '2026-07-31' })).toBe(true);
    expect(honoursNoticePeriod({ since: '2026-01-31', sunset: '2026-07-30' })).toBe(false);
  });

  it('announces a deprecated route on every response, with RFC 9745 and 8594 headers', async () => {
    // A throwaway instance: nothing in the real API is deprecated today, and
    // the hook must not be shown to work only on the day something is.
    const probe = Fastify({ logger: false });
    registerDeprecationHeaders(probe, [
      {
        method: 'GET',
        url: '/api/admin/widgets/:id',
        tag: 'Widgets',
        summary: 'Get a widget',
        deprecated: { since: '2026-01-01', sunset: '2026-07-01', replacement: 'GET /api/admin/gadgets/:id' },
      },
    ]);
    probe.get('/api/admin/widgets/:id', async () => ({ ok: true }));
    probe.get('/api/admin/gadgets/:id', async () => ({ ok: true }));
    await probe.ready();

    const old = await probe.inject({ method: 'GET', url: '/api/admin/widgets/42' });
    expect(old.headers.deprecation).toBe(`@${Date.UTC(2026, 0, 1) / 1000}`);
    expect(old.headers.sunset).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
    expect(old.headers.link).toBe('</api/admin/gadgets/{id}>; rel="successor-version"');

    const current = await probe.inject({ method: 'GET', url: '/api/admin/gadgets/42' });
    expect(current.headers.deprecation).toBeUndefined();
    await probe.close();

    expect(deprecationHeaders({ since: '2026-01-01', sunset: '2026-07-01' })).not.toHaveProperty('link');
  });
});

describe('toJsonSchema', () => {
  it('describes what a client SENDS: defaults are optional, strictness is closed', () => {
    expect(toJsonSchema(pageQuery)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        page: { type: 'integer', minimum: 1, default: 1 },
      },
    });
    expect(toJsonSchema(pageQuery).required).toBeUndefined();
  });

  it('covers the common contract constructs', () => {
    const schema = z
      .object({
        id: z.string().uuid(),
        kind: z.enum(['a', 'b']),
        note: z.string().max(10).nullable(),
        tags: z.array(z.string()).max(3),
        exact: z.literal('true').optional(),
        either: z.union([z.string(), z.number().int()]),
        trimmed: z.string().trim().transform((value) => value.toUpperCase()),
      })
      .strict();
    // A subset, not an exact match: Zod 4's native `z.toJSONSchema` adds
    // accurate extras of its own (a uuid `pattern`, safe-integer bounds, a
    // `type` beside `const`), and what this test guards is that each construct
    // a contract uses comes out as the right shape at all.
    expect(toJsonSchema(schema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'note', 'tags', 'either', 'trimmed'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['a', 'b'] },
        note: { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        exact: { const: 'true' },
        either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        trimmed: { type: 'string' },
      },
    });
  });
});
