import type { TenantClient } from '@syntra/db';
import { ldapConfigSchema, type LdapConfig } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { MappingRule } from './mapping.js';

export interface CreateSourceInput {
  name: string;
  config: unknown;
  bindPassword: string;
  schedule?: string | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
}

export async function createSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: CreateSourceInput,
) {
  const tenantId = await currentTenant(tx);
  const config = ldapConfigSchema.parse(input.config);

  const source = await tx.directorySource.create({
    data: {
      tenantId,
      name: input.name,
      type: 'ldap',
      config: config as never,
      // Filled in below, once the row has an id to name the secret after.
      secretName: 'pending',
      schedule: input.schedule ?? null,
      autoApply: input.autoApply ?? false,
      deactivationThresholdPercent: input.deactivationThresholdPercent ?? 10,
    },
  });

  const secretName = `source.${source.id}.bindPassword`;
  await putSecret(tx, provider, secretName, input.bindPassword);

  return tx.directorySource.update({
    where: { id: source.id },
    data: { secretName },
  });
}

export async function listSources(tx: TenantClient) {
  return tx.directorySource.findMany({ orderBy: { name: 'asc' } });
}

export async function findSource(tx: TenantClient, id: string) {
  return tx.directorySource.findUnique({ where: { id } });
}

/**
 * The connection configuration with its credential attached, for a run. The
 * password is never on the row and never leaves this function's caller.
 */
export async function sourceWithPassword(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<(LdapConfig & { bindPassword: string }) | null> {
  const source = await tx.directorySource.findUnique({ where: { id } });
  if (!source) return null;

  const bindPassword = await getSecret(tx, provider, source.secretName);
  if (bindPassword === null) return null;

  return { ...ldapConfigSchema.parse(source.config), bindPassword };
}

export async function setMappings(
  tx: TenantClient,
  sourceId: string,
  rules: MappingRule[],
): Promise<void> {
  const userCorrelation = rules.filter(
    (r) => r.objectType === 'user' && r.isCorrelation,
  );
  if (userCorrelation.length !== 1) {
    throw new Error(
      'exactly one user mapping must be marked as the correlation key',
    );
  }

  const tenantId = await currentTenant(tx);
  await tx.attributeMapping.deleteMany({ where: { sourceId } });
  await tx.attributeMapping.createMany({
    data: rules.map((r) => ({ tenantId, sourceId, ...r })),
  });
}

export async function mappingsFor(
  tx: TenantClient,
  sourceId: string,
): Promise<MappingRule[]> {
  const rows = await tx.attributeMapping.findMany({ where: { sourceId } });
  return rows.map((r) => ({
    objectType: r.objectType as MappingRule['objectType'],
    sourceAttribute: r.sourceAttribute,
    targetField: r.targetField,
    transform: r.transform as MappingRule['transform'],
    isCorrelation: r.isCorrelation,
  }));
}
