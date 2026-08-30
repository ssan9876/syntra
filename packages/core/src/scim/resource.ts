export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/**
 * A refusal a SCIM client can read.
 *
 * `scimType` is the machine-readable half and is what an IdP's provisioning
 * log shows an administrator. `status` is carried as a number here and
 * serialised as a STRING on the wire, which the RFC requires and clients check
 * — a numeric status is the kind of thing that works against one client and
 * fails against another for reasons nobody enjoys finding.
 */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: string | null,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ScimError';
  }
}

export interface ScimUserInput {
  userName: string;
  externalId: string | null;
  email: string | null;
  displayName: string;
  active: boolean;
  givenName: string | null;
  familyName: string | null;
}

interface ScimEmail {
  value?: unknown;
  primary?: unknown;
}

/**
 * The primary address, or the first one.
 *
 * Okta sends a single address with no `primary` flag; Entra sends several with
 * one flagged. A reader that required the flag would take no address at all
 * from one of them, and an account with no email is an account nothing can
 * reach.
 */
function pickEmail(emails: unknown): string | null {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const entries = emails as ScimEmail[];
  const primary = entries.find(
    (entry) => entry.primary === true && typeof entry.value === 'string',
  );
  if (primary) return primary.value as string;
  const first = entries.find((entry) => typeof entry.value === 'string');
  return first ? (first.value as string) : null;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * A SCIM User payload, read into the fields Syntra keeps.
 *
 * **A `password` attribute is dropped here**, in the parser, so that no route
 * can forget to. SCIM allows one; Syntra's password rules — the tenant floor,
 * ageing, renewal, write-back — live in `authorize()` and the password
 * services, and a provisioning protocol is not the place to route around them.
 * `ServiceProviderConfig` advertises `changePassword: false` to say so before
 * a client tries.
 */
export function parseScimUser(body: unknown): ScimUserInput {
  if (typeof body !== 'object' || body === null) {
    throw new ScimError(400, 'invalidValue', 'The request body is not an object');
  }
  const source = body as Record<string, unknown>;

  const userName = asString(source.userName);
  if (userName === null) {
    throw new ScimError(400, 'invalidValue', 'userName is required');
  }

  const name = (source.name ?? {}) as Record<string, unknown>;
  const givenName = asString(name.givenName);
  const familyName = asString(name.familyName);

  // `displayName` when the client sends one, otherwise built from the parts.
  // An account with no readable name is one an administrator cannot pick out
  // of a list, so `userName` is the last resort rather than an empty string.
  const displayName =
    asString(source.displayName) ??
    ([givenName, familyName].filter((part) => part !== null).join(' ') || null) ??
    userName;

  return {
    userName,
    externalId: asString(source.externalId),
    email: pickEmail(source.emails),
    displayName,
    // A POST that says nothing about `active` is a POST creating an active
    // user. Defaulting to false would silently provision accounts nobody can
    // use, and the IdP would report success.
    active: source.active === undefined ? true : source.active !== false,
    givenName,
    familyName,
  };
}

export interface ScimUserRow {
  id: string;
  login: string;
  email: string;
  displayName: string;
  status: string;
  sourceAnchor: string | null;
  createdAt: Date;
}

export function toScimUser(user: ScimUserRow, baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.sourceAnchor === null ? {} : { externalId: user.sourceAnchor }),
    userName: user.login,
    displayName: user.displayName,
    active: user.status === 'active',
    emails: user.email === '' ? [] : [{ value: user.email, primary: true }],
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}

export interface ScimGroupRow {
  id: string;
  name: string;
  status: string;
  sourceAnchor: string | null;
}

export function toScimGroup(
  group: ScimGroupRow,
  members: { id: string; displayName: string }[],
  baseUrl: string,
): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    ...(group.sourceAnchor === null ? {} : { externalId: group.sourceAnchor }),
    displayName: group.name,
    members: members.map((member) => ({
      value: member.id,
      display: member.displayName,
      $ref: `${baseUrl}/Users/${member.id}`,
    })),
    meta: {
      resourceType: 'Group',
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

/**
 * A list response.
 *
 * `startIndex` is 1-BASED, which the RFC says and which everybody gets wrong
 * once. `totalResults` is the whole matching set and not the page, which is
 * how a client knows to ask for another one.
 */
export function toScimList(
  resources: unknown[],
  total: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    itemsPerPage: resources.length,
    startIndex,
    Resources: resources,
  };
}
