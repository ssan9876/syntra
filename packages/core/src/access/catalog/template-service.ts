import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { catalogEntry, UnknownCatalogEntryError } from './catalog-service.js';
import { CATALOG_ENTRIES } from './entries.js';
import type { CatalogCategory, CatalogClaim, CatalogEntry } from './types.js';

/**
 * A tenant's own catalog entries, saved from applications configured by hand.
 *
 * Stored in the shape of a built-in `CatalogEntry` and served beside them under
 * the key `custom-<id>`, so "Add from the catalog" and `createFromCatalog`
 * treat both the same way.
 */

export const CUSTOM_KEY_PREFIX = 'custom-';

export class CatalogTemplateNameTakenError extends Error {
  constructor(readonly templateName: string) {
    super(`Catalog entry "${templateName}" already exists.`);
    this.name = 'CatalogTemplateNameTakenError';
  }
}

/** The validated body of `catalogTemplateRequest`. */
export interface CatalogTemplateInput {
  name: string;
  category: CatalogCategory;
  description: string;
  docsUrl?: string | undefined;
  launchUrl?: string | undefined;
  variables: { key: string; label: string; example: string }[];
  saml?: CatalogEntry['saml'];
  oidc?: CatalogEntry['oidc'];
}

export interface CatalogListing extends CatalogEntry {
  source: 'builtin' | 'tenant';
}

type TemplateRow = {
  id: string;
  name: string;
  category: string;
  description: string;
  docsUrl: string | null;
  entry: unknown;
};

function toEntry(row: TemplateRow): CatalogEntry {
  const stored = (row.entry ?? {}) as Pick<CatalogEntry, 'launchUrl' | 'variables' | 'saml' | 'oidc'>;
  return {
    key: `${CUSTOM_KEY_PREFIX}${row.id}`,
    name: row.name,
    category: row.category as CatalogCategory,
    description: row.description,
    docsUrl: row.docsUrl ?? '',
    ...(stored.launchUrl ? { launchUrl: stored.launchUrl } : {}),
    variables: stored.variables ?? [],
    ...(stored.saml ? { saml: stored.saml } : {}),
    ...(stored.oidc ? { oidc: stored.oidc } : {}),
  };
}

/** The built-in entries, then the tenant's own, each sorted by name. */
export async function listCatalogWithTemplates(tx: TenantClient): Promise<CatalogListing[]> {
  const rows = await tx.catalogTemplate.findMany({ orderBy: { name: 'asc' } });
  return [
    ...[...CATALOG_ENTRIES]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ ...entry, source: 'builtin' as const })),
    ...rows.map((row) => ({ ...toEntry(row), source: 'tenant' as const })),
  ];
}

/** A built-in entry by key, or the tenant's own by `custom-<id>`. */
export async function resolveCatalogEntry(tx: TenantClient, key: string): Promise<CatalogEntry> {
  if (!key.startsWith(CUSTOM_KEY_PREFIX)) return catalogEntry(key);
  const id = key.slice(CUSTOM_KEY_PREFIX.length);
  const row = /^[0-9a-f-]{36}$/.test(id) ? await tx.catalogTemplate.findUnique({ where: { id } }) : null;
  if (!row) throw new UnknownCatalogEntryError(key);
  return toEntry(row);
}

export async function createCatalogTemplate(
  tx: TenantClient,
  input: CatalogTemplateInput,
  createdById: string | null,
): Promise<CatalogEntry> {
  if (await tx.catalogTemplate.findFirst({ where: { name: input.name }, select: { id: true } })) {
    throw new CatalogTemplateNameTakenError(input.name);
  }
  const tenantId = await currentTenant(tx);
  const row = await tx.catalogTemplate.create({
    data: {
      tenantId,
      name: input.name,
      category: input.category,
      description: input.description,
      docsUrl: input.docsUrl ?? null,
      createdById,
      entry: {
        ...(input.launchUrl ? { launchUrl: input.launchUrl } : {}),
        variables: input.variables,
        ...(input.saml ? { saml: input.saml } : {}),
        ...(input.oidc ? { oidc: input.oidc } : {}),
      } as object,
    },
  });
  return toEntry(row);
}

/** The count, so a caller can tell a removal from a no-op. */
export async function deleteCatalogTemplate(tx: TenantClient, id: string): Promise<number> {
  const { count } = await tx.catalogTemplate.deleteMany({ where: { id } });
  return count;
}

/**
 * An entry pre-filled from an application's own configuration, for the
 * "Save as catalog entry" form. No variables: the administrator writes
 * `{{name}}` where a value differs between instances.
 */
export async function catalogDraftFromApplication(
  tx: TenantClient,
  applicationId: string,
): Promise<CatalogTemplateInput | null> {
  const application = await tx.application.findUnique({
    where: { id: applicationId },
    select: { name: true, description: true, launchUrl: true, type: true },
  });
  if (!application) return null;

  const claims = await tx.claimMapping.findMany({
    where: { applicationId },
    orderBy: { claimName: 'asc' },
  });
  const claimsFor = (protocol: 'saml' | 'oidc'): CatalogClaim[] =>
    claims
      .filter((c) => c.protocol === protocol)
      .map((c) => ({
        claimName: c.claimName,
        ...(c.nameFormat ? { nameFormat: c.nameFormat } : {}),
        sourceKind: c.sourceKind as CatalogClaim['sourceKind'],
        ...(c.sourceField ? { sourceField: c.sourceField } : {}),
        ...(c.literalValue ? { literalValue: c.literalValue } : {}),
        ...(c.releaseScope ? { releaseScope: c.releaseScope } : {}),
        ...(c.multiValued ? { multiValued: true } : {}),
      }));

  const draft: CatalogTemplateInput = {
    name: application.name,
    category: 'other',
    description: application.description ?? '',
    ...(application.launchUrl ? { launchUrl: application.launchUrl } : {}),
    variables: [],
  };

  if (application.type === 'saml') {
    const saml = await tx.samlConfig.findUnique({ where: { applicationId } });
    if (saml) {
      draft.saml = {
        spEntityId: saml.spEntityId,
        acsUrls: saml.acsUrls,
        nameIdFormat: saml.nameIdFormat,
        nameIdClaim: saml.nameIdClaim,
        ...(saml.sloUrl ? { sloUrl: saml.sloUrl } : {}),
        sloBinding: saml.sloBinding as 'HTTP-POST' | 'HTTP-Redirect',
        wantAuthnRequestsSigned: saml.wantAuthnRequestsSigned,
        claims: claimsFor('saml'),
      };
    }
  }
  if (application.type === 'oidc') {
    const oidc = await tx.oidcClient.findFirst({ where: { applicationId } });
    if (oidc) {
      draft.oidc = {
        redirectUris: oidc.redirectUris,
        postLogoutRedirectUris: oidc.postLogoutRedirectUris,
        scopes: oidc.scopes,
        claims: claimsFor('oidc'),
      };
    }
  }
  return draft;
}
