import { z } from 'zod';

/**
 * The attributes this connector will read and write on a Graph user, by the
 * name Syntra uses for them, and the Graph property each one is.
 *
 * A fixed table rather than a configurable map, deliberately. The document-
 * driven `httpJson` connector lets an administrator name any property; this
 * connector exists because Graph has semantics a document cannot express,
 * and the first of those is that some properties are not profile fields at
 * all. `userPrincipalName` is the login and the correlation key, written on
 * create and rename only; `accountEnabled` is the disable ladder;
 * `employeeId` and the extension attributes are where the provenance marker
 * lives. None of them may be reached through `update_account`, and a table
 * that cannot be edited is how that is enforced.
 */
export const ENTRA_ATTRIBUTE_MAP = {
  displayName: 'displayName',
  givenName: 'givenName',
  familyName: 'surname',
  mail: 'mail',
  title: 'jobTitle',
  department: 'department',
  officeLocation: 'officeLocation',
  companyName: 'companyName',
  employeeType: 'employeeType',
  usageLocation: 'usageLocation',
} as const;

export type EntraManagedAttribute = keyof typeof ENTRA_ATTRIBUTE_MAP;

export const ENTRA_MANAGED_ATTRIBUTES = Object.keys(
  ENTRA_ATTRIBUTE_MAP,
) as EntraManagedAttribute[];

/**
 * Where the ProvisionAction id is recorded on the object a create makes.
 *
 * `employeeId` is a first-class, filterable Graph property and the default.
 * The fifteen `onPremisesExtensionAttributes` are the alternative for a
 * tenant that already uses `employeeId` for its HR number: they are writable
 * on cloud-only users and filterable with an advanced query. Whichever is
 * chosen, the marker is written ONCE, on create, and never by an update --
 * it is what lets a retried create find the object the first attempt made
 * instead of making a second one.
 */
export const ENTRA_CORRELATION_FIELDS = [
  'employeeId',
  ...Array.from({ length: 15 }, (_, i) => `extensionAttribute${i + 1}` as const),
] as const;

export type EntraCorrelationField = (typeof ENTRA_CORRELATION_FIELDS)[number];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A verified domain: `contoso.onmicrosoft.com`, `acme.example`. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * A DNS domain for `userPrincipalName`: a lowercase host name, nothing else.
 * No `@`, no scheme, no path, no port -- each of those is a UPN Graph refuses
 * at create time, which is the moment this is meant to prevent.
 */
export const userPrincipalDomainSchema = z
  .string()
  .trim()
  .refine((v) => DOMAIN.test(v) && v === v.toLowerCase(), {
    message:
      'userPrincipalDomain must be a lowercase domain name such as contoso.com, with no @, scheme or path',
  });

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must be an http(s) URL' });

/**
 * The stored configuration of one `entraId` target.
 *
 * `.strict()`, like every other target config: the configuration is replaced
 * whole on save, so a misspelled key would otherwise be dropped silently and
 * the field it meant to set would revert to its default with a 204.
 *
 * **Nested and dynamic groups are not managed, and there is no option to
 * enable them.** A dynamic group's membership is computed by Entra from a
 * rule; a grant against one is refused by Graph and a revoke would be undone
 * on the next evaluation, so Provision would propose the same action forever.
 * Transitive membership is not managed either: `read` reports DIRECT
 * memberships only, and a rule that names a group somebody holds through
 * another group would otherwise read as satisfied by a holding Provision
 * cannot revoke. Both are documented in `docs/connectors/entra-id.md`; neither
 * is a knob here because neither is a thing this connector could honour.
 */
export const entraTargetConfigSchema = z
  .object({
    /** The directory id, or one of its verified domains. */
    tenantId: z
      .string()
      .trim()
      .min(1)
      .refine((v) => GUID.test(v) || DOMAIN.test(v), {
        message: 'tenantId must be the directory (tenant) id or a verified domain name',
      }),
    /** The application (client) id of the app registration. Not a secret. */
    clientId: z.string().trim().min(1),
    /**
     * The domain a new user's `userPrincipalName` is completed with when the
     * correlation key has no `@` -- which a generated key never has, because
     * `names.ts` folds it to `[a-z0-9.-]`. Must be a verified domain in the
     * tenant. Optional only because a `tenantId` that is itself a domain can
     * stand in for it; with the directory GUID as `tenantId` (Microsoft's own
     * recommendation) no account can be created without it.
     *
     * Not part of the transport: it changes what a user is called, never
     * where the client secret is sent.
     */
    userPrincipalDomain: userPrincipalDomainSchema.optional(),
    graphBaseUrl: httpsUrl.default('https://graph.microsoft.com/v1.0'),
    /** Derived from `tenantId` when absent -- see `resolveEntraConfig`. */
    tokenUrl: httpsUrl.optional(),
    /** Lifts the private-address refusal. Tests only; mirrors `guardedFetch`. */
    allowPrivateAddresses: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(600_000).default(30_000),
    correlationField: z.enum(ENTRA_CORRELATION_FIELDS).default('employeeId'),
    /**
     * Which of `ENTRA_ATTRIBUTE_MAP`'s keys `update_account` may write.
     * `userPrincipalName` is never in this list and cannot be put in it.
     */
    managedAttributes: z
      .array(z.enum(ENTRA_MANAGED_ATTRIBUTES as [EntraManagedAttribute, ...EntraManagedAttribute[]]))
      .default([...ENTRA_MANAGED_ATTRIBUTES]),
    groupScope: z
      .object({
        /** Only security groups are entitlements. Microsoft 365 groups are not. */
        securityEnabledOnly: z.boolean().default(true),
        /** Mail-enabled security groups are excluded unless asked for. */
        includeMailEnabled: z.boolean().default(false),
      })
      .strict()
      .default({ securityEnabledOnly: true, includeMailEnabled: false }),
  })
  .strict()
  .superRefine((config, ctx) => {
    // https, and not configurable: a client secret posted over http is a
    // client secret on the wire, and a bearer token sent over http is the
    // same thing an hour at a time. The one exception is the testing escape
    // hatch, which already means "this is a fake on the loopback address".
    if (config.allowPrivateAddresses) return;
    for (const key of ['graphBaseUrl', 'tokenUrl'] as const) {
      const value = config[key];
      if (value !== undefined && !/^https:\/\//i.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must start with https://`,
        });
      }
    }
  });

export type EntraTargetConfig = z.input<typeof entraTargetConfigSchema>;
export type ResolvedEntraTargetConfig = z.output<typeof entraTargetConfigSchema>;

/**
 * The resolved configuration with the token URL filled in and the credential
 * attached under its own name.
 *
 * Every target connector is handed its vault value as `bindPassword` by core
 * (`targetWithCredential`), and for this connector that value is the client
 * SECRET. Renamed here, once, so nothing further down has to remember that
 * `bindPassword` is not a password.
 */
export interface EntraConnection extends ResolvedEntraTargetConfig {
  tokenUrl: string;
  clientSecret: string;
}

export function resolveEntraConfig(
  raw: EntraTargetConfig & { bindPassword: string },
): EntraConnection {
  const { bindPassword, ...rest } = raw;
  const parsed = entraTargetConfigSchema.parse(rest);
  return {
    ...parsed,
    tokenUrl:
      parsed.tokenUrl ??
      `https://login.microsoftonline.com/${encodeURIComponent(parsed.tenantId)}/oauth2/v2.0/token`,
    clientSecret: bindPassword,
  };
}

/** Whether `tenantId` names a domain a UPN could be completed with. */
export function tenantIsDomain(tenantId: string): boolean {
  return !GUID.test(tenantId) && DOMAIN.test(tenantId);
}

/**
 * The `userPrincipalName` a correlation key becomes, or why it cannot.
 *
 * Precedence: a key that already carries `@` is used as it is; otherwise the
 * key is completed with `userPrincipalDomain`; otherwise with `tenantId` when
 * that is a domain; otherwise there is no answer. Pure, so the account-profile
 * preview can say the same thing the connector will do at apply time --
 * before apply, which is the point.
 */
export function entraUserPrincipalName(
  config: { tenantId: string; userPrincipalDomain?: string | undefined },
  correlationKey: string,
): { upn: string } | { message: string } {
  const key = correlationKey.trim();
  if (key === '') return { message: 'the correlation key is blank' };
  if (key.includes('@')) return { upn: key };
  const domain = config.userPrincipalDomain?.trim();
  if (domain !== undefined && domain !== '') return { upn: `${key}@${domain}` };
  const tenantId = config.tenantId.trim();
  if (tenantIsDomain(tenantId)) return { upn: `${key}@${tenantId}` };
  return {
    message:
      `the correlation key "${key}" has no domain, no userPrincipalDomain is set and tenantId is a directory id, not a domain; ` +
      'set userPrincipalDomain (User principal name domain) to a verified domain of the tenant, such as contoso.com',
  };
}

/** The Graph property the correlation marker is read from and written to. */
export function correlationSelect(field: EntraCorrelationField): string {
  return field === 'employeeId' ? 'employeeId' : 'onPremisesExtensionAttributes';
}

/** The OData path the marker is filtered on. */
export function correlationFilterPath(field: EntraCorrelationField): string {
  return field === 'employeeId'
    ? 'employeeId'
    : `onPremisesExtensionAttributes/${field}`;
}
