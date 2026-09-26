import type { ZodTypeAny } from 'zod';
import { API_TOKEN_PREFIX, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@syntra/core';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import type { CatalogRoute } from './route-catalog.js';
import type { DescribedRoute } from './describe.js';
import { toJsonSchema, type JsonSchema } from './json-schema.js';

/**
 * THE VERSION OF THE PUBLISHED CONTRACT — not of the product.
 *
 * Semantic, and governed by docs/configure.md (The administration API): within major version 1 only
 * additive changes ship (a new operation, a new optional field or parameter,
 * a new response member, a new enum value on a response). Anything else — a
 * removed or renamed operation or field, a newly required input, a narrowed
 * type — is a new major version, preceded by the deprecation notice the README
 * promises. Bump the minor for an addition, the patch for a correction to the
 * description that changes no behaviour.
 *
 * A constant rather than the build's version, deliberately: the committed
 * `apps/api/openapi.json` is checked for freshness in CI, and a document that
 * changed on every release would make that check meaningless.
 */
export const API_VERSION = '1.0.0';

/**
 * The OpenAPI 3.1 description of the administration API.
 *
 * Built from TWO inputs, and the split is the point:
 *
 * - `catalog` is the route table the running server registered — method, URL,
 *   the permissions its guards check, whether a machine token may call it, its
 *   rate limit. None of that is ever written down twice.
 * - `descriptions` is what a person wrote about each route: a summary and the
 *   contracts schemas the handler parses with.
 *
 * An operation is published only when BOTH have it. A description whose route
 * no longer exists is left out (and fails `openapi.test.ts`), and a route with
 * no description is left out (and fails the same test) — so the document can
 * lag the code for at most one red build.
 *
 * Pure and deterministic: paths and methods are sorted, and nothing about the
 * deployment, the tenant or the clock goes in. The same code always produces
 * the same bytes, which is what lets CI diff the committed copy.
 */
export function buildOpenApiDocument(
  catalog: readonly CatalogRoute[],
  descriptions: readonly DescribedRoute[],
): Record<string, unknown> {
  const byKey = new Map(catalog.map((route) => [`${route.method} ${route.url}`, route]));
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  const sorted = [...descriptions].sort((a, b) =>
    a.url === b.url ? METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method) : a.url < b.url ? -1 : 1,
  );

  for (const described of sorted) {
    const route = byKey.get(`${described.method} ${described.url}`);
    if (route === undefined) continue;
    tags.add(described.tag);
    const path = toOpenApiPath(route.url);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = operation(route, described);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Syntra administration API',
      version: API_VERSION,
      summary: 'Tenant administration and machine-token API for Syntra.',
      description: INFO_DESCRIPTION,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    // Relative to the host the document was fetched from. Every tenant is
    // served on its own hostname, and the tenant IS the hostname (see
    // plugins/tenant-context.ts) — so there is no single base URL to publish,
    // and inventing one would put a deployment's address in a document that
    // is committed to the repository.
    servers: [
      {
        url: 'https://{tenantHost}',
        description: 'Your tenant, addressed by its own hostname.',
        variables: {
          tenantHost: {
            default: 'syntra.example.com',
            description: 'The hostname your Syntra tenant is served on.',
          },
        },
      },
    ],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: COMPONENTS,
  };
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const INFO_DESCRIPTION = [
  'The API the Syntra administration console itself uses, published so that',
  'integrations can call it with a machine token.',
  '',
  'Every operation names the permission it requires in `x-syntra-permission`',
  '(every listed permission is required) and says in `x-syntra-token-allowed`',
  'whether an API token may call it at all. A token is always the',
  'INTERSECTION of its own scopes and its service account\'s roles.',
  '',
  'The few unauthenticated routes a person reaches from a link in an email',
  'are described too, marked `x-syntra-public` and with no security',
  'requirement.',
  '',
  'Errors are RFC 9457 problem details (`application/problem+json`). See',
  'docs/configure.md (The administration API) for versioning, deprecation, idempotency and rate limits.',
].join('\n');

/** `/api/admin/roles/:id` → `/api/admin/roles/{id}`. */
export function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, '{$1}');
}

function pathParamNames(url: string): string[] {
  return [...url.matchAll(/:(\w+)/g)].map((match) => match[1]!);
}

/**
 * A stable operation id: the method, then the path with `/api/admin` dropped,
 * static segments camel-cased and parameters as `By<Name>`.
 * `GET /api/admin/roles/:id/assignments` → `getRolesByIdAssignments`.
 *
 * Derived, not written, so it cannot collide: two routes that produced the
 * same id would be the same method and path, which Fastify refuses to
 * register. Client generators name their methods after it, which is why it
 * must never change for an existing operation — see the README.
 */
export function operationId(method: string, url: string): string {
  const words = url
    .replace(/^\/api\/admin/, '')
    .split('/')
    .filter(Boolean)
    .flatMap((segment) =>
      segment.startsWith(':')
        ? ['by', ...segment.slice(1).split(/[-_]/)]
        : segment.split(/[-_.]/),
    )
    .filter(Boolean);
  return [method.toLowerCase(), ...words.map((word) => word[0]!.toUpperCase() + word.slice(1))].join('');
}

function operation(route: CatalogRoute, described: DescribedRoute): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = [];

  const paramProperties = objectProperties(described.params);
  for (const name of pathParamNames(route.url)) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: paramProperties.properties[name] ?? { type: 'string' },
    });
  }

  const query = objectProperties(described.query);
  for (const [name, schema] of Object.entries(query.properties)) {
    parameters.push({
      name,
      in: 'query',
      required: query.required.has(name),
      schema,
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    });
  }
  // Paged lists share one vocabulary (`routes/admin/list-query.ts`): 1-based
  // `page`, a bounded `pageSize`, and a `{ rows, total, page, pageSize }`
  // envelope back. Flagged so a generated client can offer an iterator.
  const paginated = 'page' in query.properties && 'pageSize' in query.properties;

  const status = described.status ?? 200;
  const success: Record<string, unknown> =
    status === 204
      ? { description: 'Success; no content.' }
      : {
          description: 'Success.',
          content: {
            [described.produces ?? 'application/json']: {
              schema: described.response
                ? toJsonSchema(described.response)
                : described.produces && described.produces !== 'application/json'
                  ? { type: 'string' }
                  : paginated
                    ? { $ref: '#/components/schemas/Page' }
                    : {},
            },
          },
        };

  const responses: Record<string, unknown> = {
    [String(status)]: success,
    '400': { $ref: '#/components/responses/BadRequest' },
    ...(described.public
      ? {}
      : {
          '401': { $ref: '#/components/responses/Unauthenticated' },
          '403': { $ref: '#/components/responses/Forbidden' },
        }),
  };
  if (pathParamNames(route.url).length > 0) {
    responses['404'] = { $ref: '#/components/responses/NotFound' };
  }
  if (route.rateLimit !== null) {
    responses['429'] = { $ref: '#/components/responses/TooManyRequests' };
  }
  responses['503'] = { $ref: '#/components/responses/Unavailable' };
  responses.default = { $ref: '#/components/responses/Problem' };

  const permissionLine = described.public
    ? 'Unauthenticated; the tenant is the hostname the request is sent to.'
    : route.permissions.length === 0
      ? 'Requires an administrative session; no further permission.'
      : `Requires ${route.permissions.map((permission) => `\`${permission}\``).join(' and ')}.`;
  const tokenLine = route.tokenAllowed || described.public
    ? ''
    : ' API tokens are refused here (`403 token-not-accepted`); sign in as a person.';

  return {
    operationId: operationId(route.method, route.url),
    tags: [described.tag],
    summary: described.summary,
    description: [deprecationLine(described), described.description, `${permissionLine}${tokenLine}`]
      .filter(Boolean)
      .join('\n\n'),
    ...(described.deprecated
      ? {
          deprecated: true,
          // The dates in machine-readable form, beside the prose above, so a
          // client generator or a linter can warn without parsing English.
          'x-syntra-deprecation': { ...described.deprecated },
        }
      : {}),
    'x-syntra-permission': route.permissions,
    'x-syntra-token-allowed': route.tokenAllowed,
    ...(described.public ? { 'x-syntra-public': true } : {}),
    ...(paginated ? { 'x-syntra-paginated': true } : {}),
    ...(route.rateLimit !== null && typeof route.rateLimit.max === 'number'
      ? { 'x-syntra-rate-limit': { max: route.rateLimit.max, window: String(route.rateLimit.timeWindow) } }
      : {}),
    security: described.public
      ? []
      : route.tokenAllowed
        ? [{ bearerToken: [] }, { sessionCookie: [] }]
        : [{ sessionCookie: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(described.body
      ? {
          requestBody: {
            required: !accepts(described.body, undefined),
            content: { 'application/json': { schema: toJsonSchema(described.body) } },
          },
        }
      : {}),
    responses,
  };
}

function deprecationLine(described: DescribedRoute): string | undefined {
  const deprecation = described.deprecated;
  if (deprecation === undefined) return undefined;
  const instead = deprecation.replacement ? ` Use \`${deprecation.replacement}\` instead.` : '';
  return `**Deprecated** since ${deprecation.since}; may be removed after ${deprecation.sunset}.${instead}`;
}

/** Whether a schema accepts a value — used to ask "may the body be omitted". */
function accepts(schema: ZodTypeAny, value: unknown): boolean {
  return schema.safeParse(value).success;
}

/** The properties of an object schema, for turning into parameters. */
function objectProperties(schema: ZodTypeAny | undefined): {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
} {
  if (schema === undefined) return { properties: {}, required: new Set() };
  const json = toJsonSchema(schema);
  return {
    properties: (json.properties as Record<string, JsonSchema> | undefined) ?? {},
    required: new Set((json.required as string[] | undefined) ?? []),
  };
}

const problemContent = (schema: string) => ({
  'application/problem+json': { schema: { $ref: `#/components/schemas/${schema}` } },
});

/**
 * The shared parts: how a caller proves who it is, and what every failure
 * looks like. These describe `plugins/problem-json.ts` and
 * `plugins/require-session.ts`; a change to either is a change here.
 */
const COMPONENTS = {
  securitySchemes: {
    bearerToken: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: `${API_TOKEN_PREFIX}…`,
      description: [
        `A Syntra API token (\`${API_TOKEN_PREFIX}…\`), issued to a service account by an`,
        'administrator. Acts as that account, narrowed to the token\'s scopes.',
        'Ignored when a session cookie is also present.',
      ].join(' '),
    },
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: SESSION_COOKIE,
      description:
        'An administrative console session, established by signing in. Documented for completeness; integrations should use a token.',
    },
  },
  schemas: {
    Problem: {
      type: 'object',
      description:
        'An RFC 9457 problem. `type` is a stable URI naming the failure (`https://syntra.dev/problems/<code>`); branch on it, never on `title` or `detail`. Some problems carry extension members with data a client can act on.',
      required: ['type', 'title', 'status'],
      properties: {
        type: { type: 'string', format: 'uri', examples: ['https://syntra.dev/problems/forbidden'] },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' },
      },
      additionalProperties: true,
    },
    ValidationProblem: {
      description: 'The problem answered when a request fails its schema: `type` ends `validation-failed`.',
      allOf: [
        { $ref: '#/components/schemas/Problem' },
        {
          type: 'object',
          required: ['errors'],
          properties: {
            errors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'message'],
                properties: {
                  path: { type: 'string', description: 'Dotted path to the offending field; empty for the whole input.' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      ],
    },
    Page: {
      type: 'object',
      description:
        'One page of a list. `total` counts the rows matching the filters, not the table.',
      required: ['rows', 'total', 'page', 'pageSize'],
      properties: {
        rows: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer', minimum: 0 },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
      },
    },
  },
  responses: {
    BadRequest: {
      description: 'The request was malformed or failed validation.',
      content: {
        'application/problem+json': {
          schema: {
            anyOf: [
              { $ref: '#/components/schemas/ValidationProblem' },
              { $ref: '#/components/schemas/Problem' },
            ],
          },
        },
      },
    },
    Unauthenticated: {
      description: 'No valid session or token was presented (`unauthenticated`).',
      content: problemContent('Problem'),
    },
    Forbidden: {
      description:
        'The caller lacks the required permission (`forbidden`), the token\'s scopes do not include it, or the route refuses tokens (`token-not-accepted`).',
      content: problemContent('Problem'),
    },
    NotFound: { description: 'No such resource in this tenant.', content: problemContent('Problem') },
    TooManyRequests: {
      description: 'Rate limit exceeded. `Retry-After` gives the seconds to wait.',
      headers: { 'Retry-After': { schema: { type: 'integer' } } },
      content: problemContent('Problem'),
    },
    Unavailable: {
      description:
        'The database did not answer within the transaction budget (`unavailable`). Safe to retry after a short delay.',
      content: problemContent('Problem'),
    },
    Problem: { description: 'Any other failure, as a problem.', content: problemContent('Problem') },
  },
} as const;
