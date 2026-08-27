import { z } from 'zod';

/**
 * A declarative connector: how to talk to one REST API, written as JSON.
 *
 * This exists instead of a script host. HelloID's answer to "we need to
 * provision into system X" is a PowerShell script per system, executed by the
 * product; the same capability, in this product, would mean that anybody who
 * can edit a target's configuration can run code in the API process — which
 * is a strictly larger privilege than administering a target, and one nobody
 * would have chosen to grant on purpose. A document is data. It is read,
 * validated by this schema, and used to fill in blanks in requests whose shape
 * is decided here rather than by the document.
 *
 * The cost is honest: a target that needs real logic (a multi-step create, a
 * response that has to be reshaped) cannot be expressed. That is a target for
 * a hand-written connector, and the two live side by side in the registry.
 */

const trimmed = z.string().trim().min(1);

/**
 * A dotted path into a JSON response — `value`, `data.items`, `name.givenName`.
 *
 * No wildcards, no filters, no bracket syntax. A path expression rich enough
 * to select is a path expression rich enough to be a second language nobody
 * asked for; this one reads properties and nothing else.
 */
const jsonPath = z
  .string()
  .trim()
  .min(1)
  // `@` and `$` are here for Microsoft Graph, whose real property names are
  // `@odata.nextLink` and `$select`. `constructor`, `__proto__` and
  // `prototype` are refused by name: `readPath` checks own properties too, but
  // a path that cannot be written is better than one that is merely defused.
  .regex(/^[@$a-zA-Z_][a-zA-Z0-9_-]*(\.[@$a-zA-Z_][a-zA-Z0-9_-]*)*$/, {
    message: 'A dotted property path, e.g. "value" or "data.items"',
  })
  .refine(
    (v) => !/(^|\.)(constructor|__proto__|prototype)(\.|$)/.test(v),
    { message: 'That property name is not readable' },
  );

/**
 * A path under `baseUrl`. Must start with `/` and must not contain `..`.
 *
 * `..` is refused HERE, on the literal text, as well as by the escaping in
 * `renderPath` — the two catch different things. Escaping stops a `..` that
 * arrives inside an anchor at run time; this stops one an administrator writes
 * into the document, which escaping never sees.
 */
const requestPath = z
  .string()
  .trim()
  .min(1)
  .startsWith('/')
  .refine((v) => !v.includes('..'), { message: 'A path may not contain ".."' });

/**
 * The methods a document may name for an ACCOUNT operation. `DELETE` is
 * absent, and its absence is the point.
 *
 * `WriteOperation` deliberately contains no delete: every action Provision can
 * propose has to be one that four thousand instances of can be walked back,
 * and `archive_account` moves and strips rather than destroys. A document that
 * could write `"archive": { "method": "DELETE", "path": "/users/{{anchor}}" }`
 * would reintroduce the delete through the back door, wearing the name of the
 * operation that exists to avoid it — and it would be a delete the planner
 * believes is safe to propose in bulk.
 *
 * Refused by the schema, so it is a configuration error at save time rather
 * than four thousand destroyed accounts at apply time.
 */
const accountMethod = z.enum(['POST', 'PUT', 'PATCH']);

/**
 * Membership operations may use `DELETE`, and this is not an inconsistency.
 *
 * `DELETE /groups/{group}/members/{user}` is how most REST APIs spell "revoke",
 * and what it destroys is the membership edge — which is exactly what
 * `revoke_entitlement` means and is exactly as reversible as granting it
 * again. The account is untouched. The distinction the rule above protects is
 * between removing an edge and removing a person.
 */
const membershipMethod = z.enum(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * How a response says where the next page is.
 *
 * `none` is a real answer and not a default to fall back into: a target that
 * returns everything in one response is common, and pretending otherwise
 * costs a wasted request. What is NOT allowed is guessing — see
 * `readEntitlementMembers`, where an incomplete read is the most dangerous
 * value in the subsystem.
 */
const paging = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }),
  z.object({
    style: z.literal('cursor'),
    /** Where the next page's URL or token lives in the response. */
    nextAt: jsonPath,
    /**
     * Whether `nextAt` holds a whole URL (Microsoft Graph's `@odata.nextLink`)
     * or an opaque token to send back as a query parameter.
     */
    kind: z.enum(['url', 'token']).default('url'),
    /** The query parameter the token goes in, when `kind` is `token`. */
    tokenParam: trimmed.default('pageToken'),
  }),
  z.object({
    style: z.literal('offset'),
    limitParam: trimmed.default('limit'),
    offsetParam: trimmed.default('offset'),
    pageSize: z.number().int().positive().max(1000).default(200),
  }),
]);

/** Reads a collection. */
const listSpec = z.object({
  path: requestPath,
  /** Fixed query parameters, e.g. `{"$select": "id,displayName"}`. */
  query: z.record(z.string()).default({}),
  /**
   * Where the array of items is. Absent means the body IS the array.
   */
  itemsAt: jsonPath.optional(),
  paging: paging.default({ style: 'none' }),
});

/** Writes something. */
const writeSpec = (method: z.ZodTypeAny) =>
  z.object({
    method,
    path: requestPath,
    query: z.record(z.string()).default({}),
    /** A templated JSON body. Absent sends none. */
    body: z.unknown().optional(),
    /**
     * Where the target's identifier for the new object is in the response.
     * Only meaningful on `create`.
     */
    anchorAt: jsonPath.optional(),
  });

/**
 * How a target's own field names map to the attribute names Syntra uses.
 *
 * Written target-side-first (`"id": "anchor"`) because that is the direction
 * a reader goes and the direction an administrator reads the target's own
 * documentation in.
 */
const fieldMap = z.record(jsonPath, trimmed);

const accountResource = z.object({
  list: listSpec,
  /** Where each item's immutable identifier is. Never its display name. */
  anchorAt: jsonPath,
  /** Where the item's login-ish natural key is, for correlation. */
  correlationAt: jsonPath.optional(),
  /** Target field → Syntra attribute, for everything else worth reading. */
  fields: fieldMap.default({}),
  create: writeSpec(accountMethod).optional(),
  update: writeSpec(accountMethod).optional(),
  enable: writeSpec(accountMethod).optional(),
  disable: writeSpec(accountMethod).optional(),
  archive: writeSpec(accountMethod).optional(),
  rename: writeSpec(accountMethod).optional(),
});

const entitlementResource = z.object({
  list: listSpec,
  anchorAt: jsonPath,
  displayNameAt: jsonPath,
  descriptionAt: jsonPath.optional(),
  type: z.enum(['group', 'licence', 'role']).default('group'),
  /**
   * Reads the complete membership of one entitlement.
   *
   * Optional in the schema and required in practice: without it,
   * `readEntitlementMembers` throws, which marks the entitlement `unreadable`
   * and makes every rule naming it unresolvable. That is the correct
   * behaviour — see the contract on `TargetConnector.readEntitlementMembers`.
   * What must never happen is a partial list read as a whole one, so a
   * document with paging it cannot complete fails loudly rather than
   * returning what it managed to fetch.
   */
  members: listSpec.extend({ memberAnchorAt: jsonPath }).optional(),
  grant: writeSpec(membershipMethod).optional(),
  revoke: writeSpec(membershipMethod).optional(),
});

const containerResource = z.object({
  list: listSpec,
  /** Where the container's distinguished name or path is. */
  dnAt: jsonPath,
});

/**
 * How this target authenticates.
 *
 * The document names the SHAPE; the credential itself comes from the vault at
 * run time and is never part of the document. A document is tenant
 * configuration an administrator edits on a form and that appears in exports;
 * a bearer token in it would be a credential stored in plaintext in a JSON
 * column, which is the thing `Secret` exists to prevent.
 */
const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('basic'), username: trimmed }),
  z.object({
    type: z.literal('header'),
    /** e.g. `X-Api-Key`. The value is the vault credential. */
    header: trimmed,
    /** Prefix put in front of the credential, e.g. `Token `. */
    prefix: z.string().default(''),
  }),
  /**
   * OAuth 2.0 client credentials, which is what the two targets anybody
   * actually asks for require.
   *
   * Without this, `bearer` means a STATIC token — and Microsoft Graph's expire
   * in an hour, so an Entra ID document using it would work when an
   * administrator tested it and stop working overnight, silently, in a way
   * that looks like a credential problem rather than a design one. Shipping an
   * example document that cannot survive the night would be worse than
   * shipping none.
   *
   * The vault credential is the client SECRET. Nothing here holds it.
   */
  z.object({
    type: z.literal('oauth2'),
    tokenUrl: trimmed.refine((v) => /^https:\/\//i.test(v), {
      // https only, and not configurable. A client secret posted over http is
      // a client secret on the wire, and there is no deployment where that is
      // the right trade for one fewer certificate.
      message: 'tokenUrl must start with https://',
    }),
    clientId: trimmed,
    scope: trimmed.optional(),
  }),
]);

/**
 * Which HTTP statuses mean what.
 *
 * Defaulted rather than required, because the defaults are right for almost
 * every API and a document that had to restate them would be mostly
 * boilerplate — and boilerplate is where a subtly wrong value hides. A target
 * that answers 200 with an error body in it is a target for a hand-written
 * connector.
 */
const failureMap = z
  .object({
    unauthorized: z.array(z.number().int()).default([401, 403]),
    notFound: z.array(z.number().int()).default([404]),
    conflict: z.array(z.number().int()).default([409]),
    throttled: z.array(z.number().int()).default([429]),
  })
  .default({});

export const httpConnectorDocument = z
  .object({
    /** Shown in the console. What an administrator calls this integration. */
    name: trimmed,
    /**
     * The document format's version, not the target's.
     *
     * Present from the first release, and checked, so that a document written
     * against a later format is refused by name instead of being read with
     * half its meaning silently missing.
     */
    version: z.literal(1),
    baseUrl: trimmed.refine((v) => /^https?:\/\//i.test(v), {
      message: 'baseUrl must start with http:// or https://',
    }),
    auth,
    /** Sent on every request. The credential never goes here. */
    headers: z.record(z.string()).default({}),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
    /** Mirrors `GuardedFetchOptions.allowPrivateAddresses`. */
    allowPrivateAddresses: z.boolean().default(false),
    failures: failureMap,
    account: accountResource,
    entitlement: entitlementResource.optional(),
    container: containerResource.optional(),
  })
  .strict();

export type HttpConnectorDocument = z.input<typeof httpConnectorDocument>;
export type ResolvedHttpConnectorDocument = z.output<typeof httpConnectorDocument>;
export type ListSpec = z.output<typeof listSpec>;
export type WriteSpec = z.output<ReturnType<typeof writeSpec>>;

/**
 * The stored configuration of one `httpJson` target.
 *
 * The document is embedded rather than referenced by name. A target that
 * pointed at a shared document would change behaviour when somebody edited
 * that document for a different target — and would do it between a preview and
 * the apply that was supposed to enact the preview.
 */
export const httpTargetConfigSchema = z.object({
  document: httpConnectorDocument,
});

export type HttpTargetConfig = z.input<typeof httpTargetConfigSchema>;
export type ResolvedHttpTargetConfig = z.output<typeof httpTargetConfigSchema>;
