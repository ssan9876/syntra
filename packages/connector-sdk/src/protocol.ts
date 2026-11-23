import { z } from 'zod';

/**
 * The Syntra connector protocol, version 1.
 *
 * Syntra calls a connector service the operator runs; the service talks to the
 * target system. Every call is `POST {baseUrl}/{method}` with a JSON body and a
 * JSON answer, signed by Syntra (see `signing.ts`). The methods map one to one
 * onto Syntra's own `TargetConnector` interface, so a service that passes
 * certification behaves, to a provisioning run, exactly like a built-in target.
 *
 * These schemas are the protocol. Syntra's client and this SDK's server both
 * validate against them, and `protocol.schema.json` is generated from them, so
 * the three cannot disagree.
 *
 * Compatibility within a version: a receiver ignores fields it does not know.
 * Anything that would change the meaning of an existing field is a new
 * version number.
 */

export const PROTOCOL_VERSION = 1;

/** The versions this build speaks. A service answers `describe` with its own. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/** Request and response headers. Lowercase, as Node presents them. */
export const HEADERS = {
  /** The protocol version the request is written in. Sent on every request. */
  version: 'syntra-protocol-version',
  /** Unix time in seconds when Syntra signed the request. */
  timestamp: 'syntra-timestamp',
  /** A fresh random value per request, refused if seen twice. */
  nonce: 'syntra-nonce',
  /** `v1=<hex HMAC-SHA256>`; see `signing.ts`. */
  signature: 'syntra-signature',
  /** How long Syntra waits for the answer, in milliseconds. */
  timeout: 'syntra-timeout-ms',
} as const;

/** Every method, as the last segment of the request path. */
export const METHODS = [
  'describe',
  'test',
  'accounts.list',
  'accounts.read',
  'entitlements.list',
  'entitlements.members',
  'containers.list',
  'write',
] as const;
export type Method = (typeof METHODS)[number];

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

/** Every write, the same set as Syntra's `WriteOperation['op']`. */
export const WRITE_OPERATIONS = [
  'create_container',
  'move_container',
  'create_account',
  'update_account',
  'enable_account',
  'disable_account',
  'archive_account',
  'delete_account',
  'rename_account',
  'grant_entitlement',
  'revoke_entitlement',
] as const;
export type WriteOperationName = (typeof WRITE_OPERATIONS)[number];

/** Syntra's `WriteFailure`. `transient` and `throttled` are retried; nothing else is. */
export const WRITE_FAILURES = [
  'transient',
  'throttled',
  'conflict',
  'rejected',
  'unauthorized',
  'not_found',
] as const;
export type WriteFailure = (typeof WRITE_FAILURES)[number];

export function isRetryable(failure: WriteFailure | undefined): boolean {
  return failure === 'transient' || failure === 'throttled';
}

const id = z.string().min(1).max(1024);

/**
 * Attribute names Syntra derives from typed fields of an account. A service
 * reports enabled state in `enabled` and the login in `correlationKey`, never
 * as attributes, so there is exactly one place each can come from.
 */
export const RESERVED_ATTRIBUTES = [
  'active',
  'enabled',
  'accountenabled',
  'useraccountcontrol',
  'correlationkey',
] as const;

/**
 * Multi-valued, always: `{ "mail": ["anna@acme.test"] }`. Single values are
 * one-element arrays, the same shape Syntra's LDAP connectors read.
 */
export const attributesSchema = z
  .record(z.string().min(1).max(256), z.array(z.string()))
  .superRefine((attributes, ctx) => {
    for (const key of Object.keys(attributes)) {
      if ((RESERVED_ATTRIBUTES as readonly string[]).includes(key.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"${key}" is reserved. Report it in the account's own field.`,
        });
      }
    }
  });

export const accountSchema = z.object({
  /** The target's immutable id for the account. Never the login: a rename changes that. */
  anchor: id,
  /** The login Syntra correlates on: what `create_account` and `rename_account` set. */
  correlationKey: z.string(),
  /** Where the account sits, for a target with containers. Defaults to the anchor. */
  dn: z.string().exactOptional(),
  attributes: attributesSchema,
  /** `null` when the target does not say. Read-back then stays incomplete. */
  enabled: z.boolean().nullable(),
  /**
   * Set when the account exists but could not be read completely. Syntra
   * counts it as present and leaves it out of the diff; it is never treated
   * as absent.
   */
  readFailure: z.string().exactOptional(),
});
export type Account = z.infer<typeof accountSchema>;

export const entitlementSchema = z.object({
  /** The target's immutable id. Grants, revokes and member reads name it. */
  id,
  type: z.enum(['group', 'licence', 'role']),
  displayName: z.string(),
  description: z.string().exactOptional(),
  /** `false` lists an entitlement Syntra may not grant, such as a dynamic group. */
  manageable: z.boolean().exactOptional(),
  unmanageableReason: z.string().exactOptional(),
  membershipKind: z.enum(['assigned', 'dynamic']).exactOptional(),
});
export type Entitlement = z.infer<typeof entitlementSchema>;

export const containerSchema = z.object({ dn: id });
export type Container = z.infer<typeof containerSchema>;

// ---------------------------------------------------------------- writes

const actionId = id;

/**
 * One write, exactly Syntra's `WriteOperation`.
 *
 * `actionId` is the idempotency key. Syntra sends the same operation with the
 * same `actionId` again after a timeout or a transient failure, and the
 * service must answer the retry as it answered the first: a repeated
 * `create_account` returns the anchor of the account it already created.
 */
export const writeOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_container'), actionId, dn: id }),
  z.object({ op: z.literal('move_container'), actionId, fromDn: id, toDn: id }),
  z.object({
    op: z.literal('create_account'),
    actionId,
    correlationKey: id,
    attributes: z.record(z.string(), z.array(z.string())),
    enabled: z.boolean(),
    /** Generated by Syntra. Never log it. */
    initialPassword: z.string(),
    requirePasswordChange: z.boolean().exactOptional(),
  }),
  z.object({
    op: z.literal('update_account'),
    actionId,
    anchor: id,
    /** The complete set of attributes Syntra manages, not a delta. */
    attributes: z.record(z.string(), z.array(z.string())),
  }),
  z.object({ op: z.literal('enable_account'), actionId, anchor: id }),
  z.object({ op: z.literal('disable_account'), actionId, anchor: id, reason: z.string() }),
  z.object({
    op: z.literal('archive_account'),
    actionId,
    anchor: id,
    /** The entitlement ids Syntra manages for this account. Revoke these, no others. */
    entitlementDns: z.array(id),
  }),
  z.object({ op: z.literal('delete_account'), actionId, anchor: id }),
  z.object({ op: z.literal('rename_account'), actionId, anchor: id, correlationKey: id }),
  z.object({ op: z.literal('grant_entitlement'), actionId, anchor: id, entitlementId: id }),
  z.object({ op: z.literal('revoke_entitlement'), actionId, anchor: id, entitlementId: id }),
]);
export type WriteOperation = z.infer<typeof writeOperationSchema>;
export type WriteOperationOf<K extends WriteOperationName> = Extract<WriteOperation, { op: K }>;

/**
 * The outcome of a write. A failure the target reported is an ordinary 200
 * answer with `ok: false`; HTTP errors are kept for the protocol itself.
 */
export const writeResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    message: z.string(),
    /** Required on `create_account`: the new account's anchor. */
    anchor: id.exactOptional(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    failure: z.enum(WRITE_FAILURES),
    /** Honoured on `throttled`. */
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).exactOptional(),
  }),
]);
export type WriteResultBody = z.infer<typeof writeResultSchema>;

// ------------------------------------------------------- requests and answers

const page = z.object({
  /** `null` for the first page; afterwards the previous answer's `nextCursor`. */
  cursor: z.string().max(4096).nullable(),
  /** An upper bound. A service may answer with fewer. */
  pageSize: z.number().int().min(1).max(1000),
});

const nextCursor = z.string().min(1).max(4096).nullable();

export const describeResponseSchema = z.object({
  /** Every protocol version the service speaks. Syntra refuses a service without its own. */
  protocolVersions: z.array(z.number().int().positive()).min(1),
  connector: z.object({ name: z.string().min(1).max(200), version: z.string().min(1).max(100) }),
  capabilities: z.object({
    /** Whether accounts are placed in containers. Must match the target's setting. */
    placesAccountsInContainers: z.boolean(),
    entitlements: z.boolean(),
    /** The writes the service performs. Anything else is answered `rejected`. */
    operations: z.array(z.enum(WRITE_OPERATIONS)),
  }),
  schema: z.object({
    objectClasses: z.array(z.string()),
    attributes: z.array(z.string()),
  }),
});
export type DescribeResponse = z.infer<typeof describeResponseSchema>;

export const testResponseSchema = z.object({
  ok: z.boolean(),
  /** Shown to the administrator as the connection test result. */
  message: z.string(),
});
export type TestResponse = z.infer<typeof testResponseSchema>;

export const listRequestSchema = page;
export type ListRequest = z.infer<typeof listRequestSchema>;

export const accountsListResponseSchema = z.object({
  accounts: z.array(accountSchema),
  nextCursor,
});
export type AccountsListResponse = z.infer<typeof accountsListResponseSchema>;

export const accountsReadRequestSchema = z.object({ anchor: id });
export type AccountsReadRequest = z.infer<typeof accountsReadRequestSchema>;

/**
 * One account and every entitlement it holds, for read-back after a write.
 * `entitlementsComplete: false` when any membership could not be read: half a
 * list must never be reported as the whole one.
 */
export const accountsReadResponseSchema = z.object({
  account: accountSchema.nullable(),
  entitlementIds: z.array(id),
  entitlementsComplete: z.boolean(),
});
export type AccountsReadResponse = z.infer<typeof accountsReadResponseSchema>;

export const entitlementsListResponseSchema = z.object({
  entitlements: z.array(entitlementSchema),
  nextCursor,
});
export type EntitlementsListResponse = z.infer<typeof entitlementsListResponseSchema>;

export const entitlementMembersRequestSchema = z.object({ entitlementId: id });
export type EntitlementMembersRequest = z.infer<typeof entitlementMembersRequestSchema>;

/** Every member's anchor, or an error. Never a partial list. */
export const entitlementMembersResponseSchema = z.object({ members: z.array(id) });
export type EntitlementMembersResponse = z.infer<typeof entitlementMembersResponseSchema>;

export const containersListResponseSchema = z.object({
  containers: z.array(containerSchema),
  nextCursor,
});
export type ContainersListResponse = z.infer<typeof containersListResponseSchema>;

export const writeRequestSchema = z.object({ operation: writeOperationSchema });
export type WriteRequest = z.infer<typeof writeRequestSchema>;

const emptyRequest = z.object({});

export const REQUEST_SCHEMAS = {
  describe: emptyRequest,
  test: emptyRequest,
  'accounts.list': listRequestSchema,
  'accounts.read': accountsReadRequestSchema,
  'entitlements.list': listRequestSchema,
  'entitlements.members': entitlementMembersRequestSchema,
  'containers.list': listRequestSchema,
  write: writeRequestSchema,
} as const satisfies Record<Method, z.ZodType>;

export const RESPONSE_SCHEMAS = {
  describe: describeResponseSchema,
  test: testResponseSchema,
  'accounts.list': accountsListResponseSchema,
  'accounts.read': accountsReadResponseSchema,
  'entitlements.list': entitlementsListResponseSchema,
  'entitlements.members': entitlementMembersResponseSchema,
  'containers.list': containersListResponseSchema,
  write: writeResultSchema,
} as const satisfies Record<Method, z.ZodType>;

export type RequestOf<M extends Method> = z.infer<(typeof REQUEST_SCHEMAS)[M]>;
export type ResponseOf<M extends Method> = z.infer<(typeof RESPONSE_SCHEMAS)[M]>;

// ------------------------------------------------------------------ errors

/**
 * A protocol error: the request could not be answered at all. Sent with a
 * non-2xx status and `{ "error": { ... } }`.
 */
export const ERROR_CODES = {
  /** Signature missing, wrong, stale or replayed. */
  unauthenticated: 401,
  /** The request's protocol version is not one the service speaks. */
  unsupported_version: 400,
  /** The body is not JSON or does not match the method's schema. */
  invalid_request: 400,
  /** No such method. */
  unknown_method: 404,
  /** The body is larger than the service accepts. */
  payload_too_large: 413,
  /** Slow down; `retryAfterMs` says how long. */
  throttled: 429,
  /** The service failed. */
  internal: 500,
  /** The service does not implement this method, e.g. `entitlements.members` without entitlements. */
  not_implemented: 501,
  /** The target system is unreachable or failing. Try again. */
  unavailable: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** On `unsupported_version`: what the service speaks. */
    supportedVersions: z.array(z.number().int().positive()).exactOptional(),
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).exactOptional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** The first problem in a failed parse, as `path: message`. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const path = issue.path.map(String).join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
