/**
 * What the native Entra ID connector can do, said plainly and versioned.
 *
 * The roadmap's exit criterion for this connector is that every ADVERTISED
 * capability has an automated adapter test against the fake Graph AND
 * recorded evidence from a disposable tenant. The fake proves protocol
 * handling; it cannot prove Graph's semantics, and a matrix that inferred
 * support from a successful token request would be claiming both from
 * neither. So each entry carries what validates it, and the console repeats
 * that next to the badge.
 */
export type EntraCapabilityStatus = 'available' | 'unsupported' | 'never';

export type EntraCapabilityValidation =
  /** Covered by `entra/connector.test.ts` against `fake-graph-server.ts`. */
  | 'automated'
  /** Also needs a `pnpm entra:validate --write` evidence file from a tenant. */
  | 'automated+tenant-evidence-required';

export interface EntraCapability {
  status: EntraCapabilityStatus;
  validation: EntraCapabilityValidation;
  /** Microsoft Graph *application* permissions an administrator must consent to. */
  requiredPermissions: string[];
  note: string;
}

export const ENTRA_CAPABILITY_NAMES = [
  'readAccounts',
  'createAccount',
  'updateAccount',
  'enableAccount',
  'disableAccount',
  'renameAccount',
  'archiveAccount',
  'grantEntitlement',
  'revokeEntitlement',
  'readBack',
  'searchEntitlements',
  'nestedGroups',
  'dynamicGroups',
  'deleteAccount',
  'readCredentialExpiry',
] as const;

export type EntraCapabilityName = (typeof ENTRA_CAPABILITY_NAMES)[number];

export interface EntraCapabilityMatrix {
  version: 1;
  entries: Record<EntraCapabilityName, EntraCapability>;
}

export const ENTRA_CAPABILITY_MATRIX: EntraCapabilityMatrix = {
  version: 1,
  entries: {
    readAccounts: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.Read.All', 'GroupMember.Read.All'],
      note: 'Paged GET /users with direct group memberships read per user through $batch. A user whose memberships could not be read is returned with readFailure set, never dropped.',
    },
    createAccount: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.ReadWrite.All'],
      note: 'POST /users with the ProvisionAction id written to the configured correlation field. A retried create finds the object the first attempt made and returns its anchor instead of creating a second one.',
    },
    updateAccount: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.ReadWrite.All'],
      note: 'PATCH /users/{id} with only the managed profile fields. userPrincipalName, accountEnabled and the correlation marker are never written by an update.',
    },
    enableAccount: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.ReadWrite.All'],
      note: 'PATCH accountEnabled: true.',
    },
    disableAccount: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.ReadWrite.All'],
      note: 'PATCH accountEnabled: false. The object, its mailbox and its OneDrive stay where they are.',
    },
    renameAccount: {
      status: 'available',
      validation: 'automated',
      requiredPermissions: ['User.ReadWrite.All'],
      note: 'PATCH userPrincipalName and mailNickname. Tenant evidence is not yet recorded for this one; treat it as protocol-verified only.',
    },
    archiveAccount: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.ReadWrite.All', 'GroupMember.ReadWrite.All'],
      note: 'Revokes each managed group membership, then PATCH accountEnabled: false. Entra has no containers to move an object into and nothing is ever deleted.',
    },
    grantEntitlement: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['GroupMember.ReadWrite.All'],
      note: 'POST /groups/{id}/members/$ref for an assigned-membership group. Refused, not attempted, for a dynamic group.',
    },
    revokeEntitlement: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['GroupMember.ReadWrite.All'],
      note: 'DELETE /groups/{id}/members/{userId}/$ref. A membership that is already absent is success; a group that is gone is not_found.',
    },
    readBack: {
      status: 'available',
      validation: 'automated+tenant-evidence-required',
      requiredPermissions: ['User.Read.All', 'GroupMember.Read.All'],
      note: 'GET /users/{id} plus direct memberOf after every write. Reported incomplete when the membership read fails, so a partial picture is never a verification.',
    },
    searchEntitlements: {
      status: 'available',
      validation: 'automated',
      requiredPermissions: ['Group.Read.All'],
      note: 'Server-side $search on displayName with ConsistencyLevel: eventual, falling back to startswith when advanced queries are refused.',
    },
    nestedGroups: {
      status: 'unsupported',
      validation: 'automated',
      requiredPermissions: [],
      note: 'Only DIRECT memberships are read and written. A group held through another group is not a holding Provision can revoke, so it is not one it reports.',
    },
    dynamicGroups: {
      status: 'unsupported',
      validation: 'automated',
      requiredPermissions: [],
      note: 'Listed in the catalog as unmanageable so rules cannot silently name them. Grants are refused before any request is made; Entra recomputes the membership from its rule.',
    },
    deleteAccount: {
      status: 'never',
      validation: 'automated',
      requiredPermissions: [],
      note: 'No code path issues DELETE /users. Disable, never delete: every action Provision proposes has to be one that four thousand instances of can be walked back.',
    },
    readCredentialExpiry: {
      status: 'available',
      validation: 'automated',
      requiredPermissions: ['Application.Read.All'],
      note: "OPTIONAL and never required. The credential expiry scan reads the app registration's own passwordCredentials and matches the secret Syntra holds by its three-character hint. Without this consent Graph answers 403, the expiry is shown as unknown, and nothing else changes.",
    },
  },
};
