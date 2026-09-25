import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { LIVE_GRANT_STATUSES } from '../automate/types.js';
import { SYNTRA_SYSTEM_ID } from '../govern/types.js';

/**
 * DELETING AN APPLICATION: the permanent option behind "retire".
 *
 * An application can already be switched off without losing anything:
 * `status: 'inactive'` (the console's "Retire") takes it out of every
 * resolution -- no tile, no sign-in -- and keeps its SAML/OIDC configuration,
 * claim mappings and assignments for the day it is switched back on. This is
 * the other thing: the row, and everything that exists only because of it,
 * gone. It exists because retiring cannot free what an application holds that
 * is UNIQUE -- its SAML entity ID, its OIDC client_id, its slug -- so an
 * administrator who registered one by mistake, or has to register it again
 * from the catalog, was refused with `entity-id-taken` and had no way out.
 *
 * WHAT GOES, TABLE BY TABLE, AND HOW.
 *
 * Foreign keys with `ON DELETE CASCADE` from `Application`, left to the
 * cascade -- deleting the parent is the one statement that cannot miss a row
 * a later migration adds to the same relation, and the database, not this
 * list, is what keeps them consistent:
 *
 *  - `SamlConfig`     the service provider registration. Its entity ID is
 *                     unique per tenant; this is what makes it reusable.
 *  - `OidcClient`     the relying party, INCLUDING its client secret: the
 *                     secret is only ever stored as a SHA-256 on this row
 *                     (`clientSecretHash`), never in the vault, so there is no
 *                     vault entry to remove and the row going is the secret
 *                     going. Its `LogoutDelivery` rows cascade from it in turn
 *                     -- a queued logout token for a client that no longer
 *                     exists has nobody to be delivered to. The row's DELETE
 *                     also fires `OidcClient_bump_oidc_generation`, so every
 *                     replica's cached `oidc-provider` is rebuilt without the
 *                     client on its next request.
 *  - `ClaimMapping`   this application's own mappings. A `ClaimMappingSet` is
 *                     a template applied by COPY and is shared: untouched.
 *  - `AppAssignment`  who held it. Counted first, for the audit event.
 *
 * The icon is not a table: `iconImage` is a column on the row itself, stored
 * there precisely so it goes wherever the row goes.
 *
 * Rows that NAME the application without a foreign key, deleted explicitly
 * here because nothing else would:
 *
 *  - `OidcArtifact` whose payload's `clientId` is this client: access tokens,
 *    refresh tokens, authorization codes and grants `oidc-provider` issued to
 *    it. Deleted, not marked, for the reason `revokeArtifactsForUser` gives:
 *    the provider reads its artifacts back and a row that is not there is a
 *    token that does not exist. Without this a refresh token issued an hour
 *    ago keeps its holder signed in for up to fourteen days to an application
 *    the console says is gone -- and, worse, would be honoured by a NEW client
 *    re-registered under the same client_id.
 *  - `RefreshToken` (Syntra's own table) with this `clientId`: REVOKED, not
 *    deleted -- that table keeps revoked rows as the evidence access ended.
 *  - `AuthorizationDecision` for this client: an unspent `authorize()` allow
 *    must not be redeemable by a later client reusing the client_id.
 *  - `SamlSsoSession`, `SamlAuthnRequest`: single-logout bookkeeping and
 *    parked sign-ins for this service provider. There is no SP left to log out
 *    of or to answer.
 *  - `FederationRequest`, `AuthAttempt` with this `applicationId` that are
 *    still in flight: a sign-in that is half-way through an upstream IdP or a
 *    second factor ON THE WAY TO this application. "Users lose SSO to the app
 *    immediately" includes the ones mid-flow.
 *  - `ResourceOwner`, `ResourceDelegation`, `ResourceClassification`,
 *    `BusinessFunctionResource` for `(application, id)`: rows whose only
 *    subject is this application. The business function they sit in is shared
 *    and stays; only its reference to a resource that no longer exists goes.
 *
 * WHAT STAYS, DELIBERATELY:
 *
 *  - The tenant's SAML signing key (and the OIDC one). It signs for every
 *    application; deleting the last SAML app does not make the tenant stop
 *    being an identity provider, and regenerating a key breaks every SP that
 *    pinned the certificate.
 *  - Users, groups, org units: assignments pointed AT them; they are not the
 *    application's.
 *  - `AuthPolicyRule.applicationIds`. The id is left in the array. Removing it
 *    looks tidier and is dangerous: an EMPTY `applicationIds` means
 *    "unconstrained", so a "deny for this app" rule whose only app was removed
 *    would become "deny for every app". A dangling id matches nothing, which
 *    is exactly what the rule should now do. The count is audited.
 *  - Govern evidence -- snapshots, holdings, campaign items, decisions -- and
 *    the audit log. They record that people HELD this application; deleting
 *    the application does not make that untrue.
 *
 * REFUSED, rather than silently cascaded (409 `application-in-use`):
 *
 *  - a catalog `Product` that grants it. A product is shared configuration
 *    with requests and workflows hanging off it; one that grants a missing
 *    application fails at fulfilment, after somebody approved it. Take the
 *    application out of the product first -- a decision about the product.
 *  - a LIVE `AccessGrant` of it. The grant's `writtenRowIds` are assignment
 *    rows the cascade would remove underneath it, leaving Automate holding an
 *    active grant for access nobody has and a sweep that cannot end it. Ending
 *    those grants is Automate's job, with its own trail.
 *
 * ONE TRANSACTION. Every read, every delete and the audit event commit or roll
 * back together: a half-deleted application -- config gone, tokens live -- is
 * the one outcome worse than either end.
 */

export type DeleteApplicationOutcome =
  | { ok: true; summary: DeletedApplicationSummary }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'confirm_mismatch' }
  | {
      ok: false;
      reason: 'in_use';
      /** Catalog products granting it, by name. */
      products: string[];
      /** Live (scheduled, pending or active) Automate grants of it. */
      liveGrants: number;
    };

/** What the audit event records. Never a secret, never a token. */
export interface DeletedApplicationSummary {
  name: string;
  slug: string;
  type: string;
  /** 'saml', 'oidc', 'saml+oidc' or 'none' -- what it could sign in over. */
  protocol: 'saml' | 'oidc' | 'saml+oidc' | 'none';
  entityId: string | null;
  clientId: string | null;
  catalogKey: string | null;
  assignments: number;
  claimMappings: number;
  revoked: {
    oidcArtifacts: number;
    refreshTokens: number;
    authorizationDecisions: number;
    samlSessions: number;
    pendingSamlRequests: number;
    pendingSignIns: number;
  };
  governanceRowsRemoved: number;
  /** Policy rules still naming the id; left alone, see above. */
  policyRulesNamingIt: number;
}

export interface DeleteApplicationInput {
  applicationId: string;
  /** The application's name, typed by the administrator. */
  confirm: string;
  actorUserId: string;
  sourceIp?: string | undefined;
}

/**
 * The exact name, give or take surrounding whitespace. Case-SENSITIVE: the
 * point of typing it is that the administrator read which one this is, and
 * "slack" for "Slack (EU)" -- or for "SLACK" beside "Slack" -- is not that.
 */
function confirms(typed: string, name: string): boolean {
  return typed.trim() === name.trim();
}

export async function deleteApplication(
  tx: TenantClient,
  input: DeleteApplicationInput,
): Promise<DeleteApplicationOutcome> {
  const id = input.applicationId;

  // Looked up first, and under RLS: another tenant's id and an id nobody
  // holds are the same answer, and neither learns whether the name matched.
  const application = await tx.application.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      type: true,
      catalogKey: true,
      samlConfig: { select: { spEntityId: true } },
      oidcClient: { select: { clientId: true } },
    },
  });
  if (!application) return { ok: false, reason: 'not_found' };

  if (!confirms(input.confirm, application.name)) return { ok: false, reason: 'confirm_mismatch' };

  const [productGrants, liveGrants] = await Promise.all([
    tx.productGrant.findMany({
      where: { resourceType: 'application', resourceId: id },
      select: { product: { select: { name: true } } },
    }),
    tx.accessGrant.count({
      where: {
        resourceType: 'application',
        resourceId: id,
        status: { in: [...LIVE_GRANT_STATUSES] },
      },
    }),
  ]);
  if (productGrants.length > 0 || liveGrants > 0) {
    return {
      ok: false,
      reason: 'in_use',
      products: [...new Set(productGrants.map((g) => g.product.name))].sort(),
      liveGrants,
    };
  }

  const clientId = application.oidcClient?.clientId ?? null;
  const entityId = application.samlConfig?.spEntityId ?? null;

  const [assignments, claimMappings, policyRulesNamingIt] = await Promise.all([
    tx.appAssignment.count({ where: { applicationId: id } }),
    tx.claimMapping.count({ where: { applicationId: id } }),
    tx.authPolicyRule.count({ where: { applicationIds: { has: id } } }),
  ]);

  // ---- tokens and in-flight protocol state, before the rows they hang off --
  let oidcArtifacts = 0;
  let refreshTokens = 0;
  let authorizationDecisions = 0;
  if (clientId !== null) {
    oidcArtifacts = (
      await tx.oidcArtifact.deleteMany({ where: { payload: { path: ['clientId'], equals: clientId } } })
    ).count;
    refreshTokens = (
      await tx.refreshToken.updateMany({
        where: { clientId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    ).count;
    authorizationDecisions = (await tx.authorizationDecision.deleteMany({ where: { clientId } })).count;
  }
  const samlSessions = (await tx.samlSsoSession.deleteMany({ where: { applicationId: id } })).count;
  const pendingSamlRequests = (await tx.samlAuthnRequest.deleteMany({ where: { applicationId: id } })).count;
  const pendingSignIns =
    (await tx.federationRequest.deleteMany({ where: { applicationId: id, consumedAt: null } })).count +
    (await tx.authAttempt.deleteMany({ where: { applicationId: id, consumedAt: null } })).count;

  // ---- governance rows whose only subject is this application --------------
  const governanceRowsRemoved =
    (await tx.resourceOwner.deleteMany({ where: { resourceType: 'application', resourceId: id } })).count +
    (await tx.resourceDelegation.deleteMany({ where: { resourceType: 'application', resourceId: id } })).count +
    (
      await tx.resourceClassification.deleteMany({
        where: { systemId: SYNTRA_SYSTEM_ID, resourceKind: 'application', resourceId: id },
      })
    ).count +
    (
      await tx.businessFunctionResource.deleteMany({
        where: { systemId: SYNTRA_SYSTEM_ID, resourceKind: 'application', resourceId: id },
      })
    ).count;

  // ---- the row; SamlConfig, OidcClient (+ LogoutDelivery), ClaimMapping and
  // AppAssignment follow by cascade --------------------------------------------
  await tx.application.delete({ where: { id } });

  const summary: DeletedApplicationSummary = {
    name: application.name,
    slug: application.slug,
    type: application.type,
    protocol:
      entityId !== null && clientId !== null
        ? 'saml+oidc'
        : entityId !== null
          ? 'saml'
          : clientId !== null
            ? 'oidc'
            : 'none',
    entityId,
    clientId,
    catalogKey: application.catalogKey,
    assignments,
    claimMappings,
    revoked: {
      oidcArtifacts,
      refreshTokens,
      authorizationDecisions,
      samlSessions,
      pendingSamlRequests,
      pendingSignIns,
    },
    governanceRowsRemoved,
    policyRulesNamingIt,
  };

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'application.deleted',
    targetType: 'Application',
    targetId: id,
    outcome: 'success',
    sourceIp: input.sourceIp ?? null,
    // The identifiers an investigator needs to match this against a service
    // provider's own logs. The client SECRET is not here and cannot be: only
    // its hash was ever stored, and that is not evidence of anything.
    payload: { ...summary },
  });

  return { ok: true, summary };
}
