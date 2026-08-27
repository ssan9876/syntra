import { randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { createApplication } from '../application-service.js';
import { upsertSamlConfig } from '../saml-config-service.js';
import { hashClientSecret } from '../oidc-client-service.js';
import { CATALOG_ENTRIES } from './entries.js';
import { fill, type CatalogClaim, type CatalogEntry } from './types.js';

export class UnknownCatalogEntryError extends Error {
  constructor(readonly key: string) {
    super(`no catalog entry called "${key}"`);
    this.name = 'UnknownCatalogEntryError';
  }
}

/**
 * Raised when another application already claims the entity ID this entry
 * would use.
 *
 * `SamlConfig` is unique on `[tenantId, spEntityId]` deliberately:
 * `findSamlConfigByEntityId` resolves an incoming AuthnRequest by entity ID,
 * and two applications claiming one makes an allowlist-based control
 * non-deterministic.
 *
 * It bites here because several vendors use a CONSTANT entity ID — Slack's is
 * `https://slack.com` and Salesforce's is `https://saml.salesforce.com`,
 * whatever the workspace or org. Two of them genuinely cannot be told apart
 * from the AuthnRequest, so this is a protocol fact rather than a limitation
 * of this product, and the way out is to change the entity ID in the vendor's
 * own settings. The message says so, and names the application already
 * holding it — the alternative was a raw unique-constraint error out of the
 * driver.
 */
export class EntityIdTakenError extends Error {
  constructor(
    readonly entityId: string,
    readonly heldBy: string,
  ) {
    super(
      `"${heldBy}" is already registered with the entity ID ${entityId}. ` +
        'A service provider is identified by that value, so two applications ' +
        'cannot share one — give this instance a different entity ID in its ' +
        'own SSO settings, then register it by hand.',
    );
    this.name = 'EntityIdTakenError';
  }
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`an application called "${slug}" already exists`);
    this.name = 'SlugTakenError';
  }
}

export function catalogEntry(key: string): CatalogEntry {
  const entry = CATALOG_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) throw new UnknownCatalogEntryError(key);
  return entry;
}

export function listCatalog(): CatalogEntry[] {
  return [...CATALOG_ENTRIES].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A URL-safe slug from a name, deduplicated against what is already there.
 *
 * Two Slack workspaces is an ordinary thing to want, and the slug is unique
 * per tenant — so the second one becomes `slack-2` rather than a 409 the
 * administrator has to resolve by inventing a name.
 */
async function freeSlug(tx: TenantClient, base: string): Promise<string> {
  const root =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'application';

  const taken = new Set(
    (await tx.application.findMany({ select: { slug: true } })).map((a) => a.slug),
  );
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SlugTakenError(root);
}

export interface CreateFromCatalogInput {
  key: string;
  /** What the administrator supplied for the entry's variables. */
  variables: Record<string, string>;
  /** Overrides the entry's own name, for a second instance of one. */
  name?: string | undefined;
}

export interface CreatedFromCatalog {
  applicationId: string;
  slug: string;
  name: string;
  protocol: 'saml' | 'oidc' | 'bookmark';
  /**
   * The OIDC client secret, returned once and never again — the same
   * handling `OidcClient.clientSecretHash` already implies. Absent for a
   * SAML application, which has no shared secret.
   */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Creates an application from a catalog entry, with its protocol
 * configuration and claim mappings.
 *
 * One transaction. A half-created application — the row present, the SAML
 * config missing — is an entry in the console that cannot be signed in to and
 * that nothing marks as broken; the administrator's next move would be to
 * create it again and hit the slug clash.
 *
 * **The entry's values are COPIED, not referenced.** `catalogKey` records
 * where they came from and nothing reads the entry again. An entry corrected
 * in a later release must not silently change an integration that is working,
 * and one removed must not orphan the application built from it.
 */
export async function createFromCatalog(
  tx: TenantClient,
  input: CreateFromCatalogInput,
): Promise<CreatedFromCatalog> {
  const entry = catalogEntry(input.key);
  const tenantId = await currentTenant(tx);

  // Rendered BEFORE anything is written. `fill` throws on a variable nobody
  // supplied, and a throw here leaves no rows behind rather than an
  // application whose entity ID has a hole in it.
  const render = (template: string) => fill(template, input.variables);

  const name = input.name?.trim() || entry.name;
  const slug = await freeSlug(tx, name);
  const protocol: 'saml' | 'oidc' | 'bookmark' = entry.saml
    ? 'saml'
    : entry.oidc
      ? 'oidc'
      : 'bookmark';

  // Checked BEFORE anything is written, and by name. The unique constraint
  // would catch it either way, but as a driver error with no application named
  // in it and a half-created row already committed inside this transaction.
  if (entry.saml) {
    const entityId = render(entry.saml.spEntityId);
    const clash = await tx.samlConfig.findFirst({
      where: { spEntityId: entityId },
      select: { application: { select: { name: true } } },
    });
    if (clash) throw new EntityIdTakenError(entityId, clash.application.name);
  }

  const application = await createApplication(tx, {
    name,
    slug,
    description: entry.description,
    type: protocol,
    ...(entry.launchUrl ? { launchUrl: render(entry.launchUrl) } : {}),
  });
  await tx.application.update({
    where: { id: application.id },
    data: { catalogKey: entry.key },
  });

  const claims: { protocol: 'saml' | 'oidc'; claims: CatalogClaim[] }[] = [];

  if (entry.saml) {
    await upsertSamlConfig(tx, application.id, {
      spEntityId: render(entry.saml.spEntityId),
      acsUrls: entry.saml.acsUrls.map(render),
      defaultAcsUrl: entry.saml.acsUrls[0] ? render(entry.saml.acsUrls[0]) : null,
      acsBinding: 'HTTP-POST',
      nameIdFormat: entry.saml.nameIdFormat,
      nameIdClaim: entry.saml.nameIdClaim ?? null,
      // Empty: the catalog knows the SP's URLs and cannot know its signing
      // certificate, which is per-installation. The administrator pastes it,
      // or imports the SP's metadata, before the first sign-in.
      spCertificates: [],
      ...(entry.saml.wantAuthnRequestsSigned === undefined
        ? {}
        : { wantAuthnRequestsSigned: entry.saml.wantAuthnRequestsSigned }),
      encryptAssertions: false,
      encryptionCertificate: null,
      sloUrl: entry.saml.sloUrl ? render(entry.saml.sloUrl) : null,
      sloBinding: 'HTTP-POST',
      // Never true from a catalog entry. IdP-initiated sign-in is a posture
      // an administrator adopts for a named application, not one that arrives
      // with a template they picked off a list.
      allowIdpInitiated: false,
      assertionLifetimeMs: 300_000,
    });
    claims.push({ protocol: 'saml', claims: entry.saml.claims });
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (entry.oidc) {
    clientId = `${slug}-${randomBytes(6).toString('hex')}`;
    clientSecret = randomBytes(32).toString('base64url');
    await tx.oidcClient.create({
      data: {
        tenantId,
        applicationId: application.id,
        clientId,
        clientSecretHash: hashClientSecret(clientSecret),
        redirectUris: entry.oidc.redirectUris.map(render),
        postLogoutRedirectUris: (entry.oidc.postLogoutRedirectUris ?? []).map(render),
        grantTypes: ['authorization_code', 'refresh_token'],
        // Off, always, whatever an entry says — there is no entry field for
        // it. This is the one grant that issues a token without a decision
        // from `authorize()`, and it is not something a template turns on.
        clientCredentialsEnabled: false,
        scopes: entry.oidc.scopes,
        requirePkce: true,
      },
    });
    claims.push({ protocol: 'oidc', claims: entry.oidc.claims });
  }

  for (const group of claims) {
    for (const claim of group.claims) {
      await tx.claimMapping.create({
        data: {
          tenantId,
          applicationId: application.id,
          protocol: group.protocol,
          claimName: claim.claimName,
          ...(claim.nameFormat === undefined ? {} : { nameFormat: claim.nameFormat }),
          sourceKind: claim.sourceKind,
          sourceField: claim.sourceField ?? null,
          literalValue: claim.literalValue ?? null,
          releaseScope: claim.releaseScope ?? null,
          multiValued: claim.multiValued ?? false,
        },
      });
    }
  }

  return {
    applicationId: application.id,
    slug,
    name,
    protocol,
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}
