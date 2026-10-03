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
      `Entity ID ${entityId} is already used by "${heldBy}". ` +
        'Give this instance a different entity ID in its SSO settings, then register it by hand.',
    );
    this.name = 'EntityIdTakenError';
  }
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Slug ${slug} is already in use.`);
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
  let root = '';
  let separatorPending = false;
  for (const character of base.toLowerCase()) {
    const isAsciiLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (!isAsciiLetter && !isDigit) {
      separatorPending = root.length > 0;
      continue;
    }
    if (separatorPending) {
      // Leave room for both the separator and the character. This also means
      // truncation can never leave a trailing hyphen.
      if (root.length >= 47) break;
      root += '-';
      separatorPending = false;
    }
    if (root.length >= 48) break;
    root += character;
  }
  root ||= 'application';

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

const BASIC_NAME_FORMAT = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';

/**
 * The claims "New application" starts an application with unless told
 * otherwise. OpenID Connect already sends email and name through the `email`
 * and `profile` scopes, so it only adds groups.
 */
export function standardClaims(protocol: 'saml' | 'oidc'): CatalogClaim[] {
  if (protocol === 'oidc') {
    return [{ claimName: 'groups', sourceKind: 'groups', multiValued: true, releaseScope: 'profile' }];
  }
  return [
    { claimName: 'email', nameFormat: BASIC_NAME_FORMAT, sourceKind: 'user', sourceField: 'email' },
    { claimName: 'firstName', nameFormat: BASIC_NAME_FORMAT, sourceKind: 'person', sourceField: 'givenName' },
    { claimName: 'lastName', nameFormat: BASIC_NAME_FORMAT, sourceKind: 'person', sourceField: 'familyName' },
    { claimName: 'displayName', nameFormat: BASIC_NAME_FORMAT, sourceKind: 'user', sourceField: 'displayName' },
    { claimName: 'groups', nameFormat: BASIC_NAME_FORMAT, sourceKind: 'groups', multiValued: true },
  ];
}

/**
 * A fully rendered application: what a catalog entry becomes once its
 * variables are filled in, and what the one-step "New application" form
 * submits directly.
 */
export interface ApplicationDefinition {
  name: string;
  /** Used as given, refused when taken. Absent derives a free one from the name. */
  slug?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  launchUrl?: string | undefined;
  /** Where the definition came from, written to `Application.catalogKey`. */
  catalogKey?: string | undefined;
  saml?:
    | {
        spEntityId: string;
        acsUrls: string[];
        defaultAcsUrl?: string | null | undefined;
        nameIdFormat: string;
        nameIdClaim?: string | null | undefined;
        sloUrl?: string | null | undefined;
        sloBinding?: 'HTTP-POST' | 'HTTP-Redirect' | undefined;
        /** PEM. Empty until the administrator pastes one or imports metadata. */
        spCertificates?: string[] | undefined;
        encryptionCertificate?: string | null | undefined;
        wantAuthnRequestsSigned?: boolean | undefined;
        claims: CatalogClaim[];
      }
    | undefined;
  oidc?:
    | {
        redirectUris: string[];
        postLogoutRedirectUris?: string[] | undefined;
        scopes: string[];
        claims: CatalogClaim[];
      }
    | undefined;
}

/**
 * Creates an application from a catalog entry, with its protocol
 * configuration and claim mappings.
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
  return createApplicationFromDefinition(tx, renderEntry(entry, input.variables, input.name));
}

/**
 * An entry with its variables filled in. Throws `CatalogVariableMissingError`
 * before anything is written, so a hole never reaches an entity ID.
 */
export function renderEntry(
  entry: CatalogEntry,
  variables: Record<string, string>,
  name?: string | undefined,
): ApplicationDefinition {
  const render = (template: string) => fill(template, variables);
  return {
    name: name?.trim() || entry.name,
    description: entry.description,
    catalogKey: entry.key,
    ...(entry.launchUrl ? { launchUrl: render(entry.launchUrl) } : {}),
    ...(entry.saml
      ? {
          saml: {
            spEntityId: render(entry.saml.spEntityId),
            acsUrls: entry.saml.acsUrls.map(render),
            nameIdFormat: entry.saml.nameIdFormat,
            nameIdClaim: entry.saml.nameIdClaim ?? null,
            sloUrl: entry.saml.sloUrl ? render(entry.saml.sloUrl) : null,
            sloBinding: entry.saml.sloBinding ?? 'HTTP-POST',
            ...(entry.saml.wantAuthnRequestsSigned === undefined
              ? {}
              : { wantAuthnRequestsSigned: entry.saml.wantAuthnRequestsSigned }),
            claims: entry.saml.claims,
          },
        }
      : {}),
    ...(entry.oidc
      ? {
          oidc: {
            redirectUris: entry.oidc.redirectUris.map(render),
            postLogoutRedirectUris: (entry.oidc.postLogoutRedirectUris ?? []).map(render),
            scopes: entry.oidc.scopes,
            claims: entry.oidc.claims,
          },
        }
      : {}),
  };
}

/**
 * Creates an application with its protocol configuration and claim mappings.
 *
 * One transaction. A half-created application -- the row present, the SAML
 * config missing -- is an entry in the console that cannot be signed in to and
 * that nothing marks as broken; the administrator's next move would be to
 * create it again and hit the slug clash.
 */
export async function createApplicationFromDefinition(
  tx: TenantClient,
  definition: ApplicationDefinition,
): Promise<CreatedFromCatalog> {
  const tenantId = await currentTenant(tx);

  const name = definition.name.trim();
  let slug: string;
  if (definition.slug) {
    if (await tx.application.findFirst({ where: { slug: definition.slug }, select: { id: true } })) {
      throw new SlugTakenError(definition.slug);
    }
    slug = definition.slug;
  } else {
    slug = await freeSlug(tx, name);
  }
  const protocol: 'saml' | 'oidc' | 'bookmark' = definition.saml
    ? 'saml'
    : definition.oidc
      ? 'oidc'
      : 'bookmark';

  // Checked BEFORE anything is written, and by name. The unique constraint
  // would catch it either way, but as a driver error with no application named
  // in it and a half-created row already committed inside this transaction.
  if (definition.saml) {
    const entityId = definition.saml.spEntityId;
    const clash = await tx.samlConfig.findFirst({
      where: { spEntityId: entityId },
      select: { application: { select: { name: true } } },
    });
    if (clash) throw new EntityIdTakenError(entityId, clash.application.name);
  }

  const application = await createApplication(tx, {
    name,
    slug,
    type: protocol,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.category ? { category: definition.category } : {}),
    ...(definition.launchUrl ? { launchUrl: definition.launchUrl } : {}),
  });
  if (definition.catalogKey) {
    await tx.application.update({
      where: { id: application.id },
      data: { catalogKey: definition.catalogKey },
    });
  }

  const claims: { protocol: 'saml' | 'oidc'; claims: CatalogClaim[] }[] = [];

  if (definition.saml) {
    const saml = definition.saml;
    await upsertSamlConfig(tx, application.id, {
      spEntityId: saml.spEntityId,
      acsUrls: saml.acsUrls,
      defaultAcsUrl: saml.defaultAcsUrl ?? saml.acsUrls[0] ?? null,
      acsBinding: 'HTTP-POST',
      nameIdFormat: saml.nameIdFormat,
      nameIdClaim: saml.nameIdClaim ?? null,
      // A catalog entry cannot know the SP's signing certificate, which is
      // per-installation; the administrator pastes it or imports metadata
      // before the first sign-in.
      spCertificates: saml.spCertificates ?? [],
      ...(saml.wantAuthnRequestsSigned === undefined
        ? {}
        : { wantAuthnRequestsSigned: saml.wantAuthnRequestsSigned }),
      encryptAssertions: false,
      encryptionCertificate: saml.encryptionCertificate ?? null,
      sloUrl: saml.sloUrl ?? null,
      sloBinding: saml.sloBinding ?? 'HTTP-POST',
      // Never true at creation. IdP-initiated sign-in is a posture an
      // administrator adopts for a named application, on its SSO settings.
      allowIdpInitiated: false,
      assertionLifetimeMs: 300_000,
    });
    claims.push({ protocol: 'saml', claims: saml.claims });
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (definition.oidc) {
    clientId = `${slug}-${randomBytes(6).toString('hex')}`;
    clientSecret = randomBytes(32).toString('base64url');
    await tx.oidcClient.create({
      data: {
        tenantId,
        applicationId: application.id,
        clientId,
        clientSecretHash: hashClientSecret(clientSecret),
        redirectUris: definition.oidc.redirectUris,
        postLogoutRedirectUris: definition.oidc.postLogoutRedirectUris ?? [],
        grantTypes: ['authorization_code', 'refresh_token'],
        // Off, always. This is the one grant that issues a token without a
        // decision from `authorize()`, and creation does not turn it on.
        clientCredentialsEnabled: false,
        scopes: definition.oidc.scopes,
        requirePkce: true,
      },
    });
    claims.push({ protocol: 'oidc', claims: definition.oidc.claims });
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
