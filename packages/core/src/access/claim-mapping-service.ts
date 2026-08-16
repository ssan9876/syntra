import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { ClaimMappingSpec, ClaimProtocol } from './claims/types.js';

const toSpec = (row: {
  id: string; protocol: string; claimName: string; nameFormat: string;
  sourceKind: string; sourceField: string | null; contractStrategy: string;
  literalValue: string | null; releaseScope: string | null; multiValued: boolean;
}): ClaimMappingSpec => ({
  id: row.id,
  protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
  claimName: row.claimName,
  nameFormat: row.nameFormat,
  sourceKind: row.sourceKind as ClaimMappingSpec['sourceKind'],
  sourceField: row.sourceField,
  contractStrategy:
    row.contractStrategy === 'lowestSequence' ? 'lowestSequence' : 'primary',
  literalValue: row.literalValue,
  releaseScope: row.releaseScope,
  multiValued: row.multiValued,
});

export async function listClaimMappings(
  tx: TenantClient,
  applicationId: string,
  protocol: ClaimProtocol,
): Promise<ClaimMappingSpec[]> {
  const rows = await tx.claimMapping.findMany({
    where: { applicationId, protocol },
    orderBy: { claimName: 'asc' },
  });
  return rows.map(toSpec);
}

export async function createClaimMapping(
  tx: TenantClient,
  applicationId: string,
  input: Omit<ClaimMappingSpec, 'id'>,
): Promise<ClaimMappingSpec> {
  const tenantId = await currentTenant(tx);
  const row = await tx.claimMapping.create({
    data: {
      tenantId,
      applicationId,
      protocol: input.protocol,
      claimName: input.claimName,
      nameFormat: input.nameFormat,
      sourceKind: input.sourceKind,
      sourceField: input.sourceField,
      contractStrategy: input.contractStrategy,
      literalValue: input.literalValue,
      releaseScope: input.releaseScope,
      multiValued: input.multiValued,
    },
  });
  return toSpec(row);
}

export async function deleteClaimMapping(
  tx: TenantClient,
  id: string,
): Promise<void> {
  await tx.claimMapping.deleteMany({ where: { id } });
}
