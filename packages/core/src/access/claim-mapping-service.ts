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

/**
 * A named set of mappings, applied to many applications at once.
 *
 * The set is a TEMPLATE. `applyClaimMappingSet` copies its rows onto an
 * application and the copies become that application's own — editable,
 * removable, and listed beside the ones added by hand. Nothing at sign-in ever
 * reads a set: `ClaimMapping` stays the single thing the assertion builder
 * consults, so there is no second lookup path and no way for editing a set to
 * change what an application already sends without somebody applying it again.
 *
 * That is the whole design decision, and the alternative is worth naming: a
 * set applied BY REFERENCE would make one edit change fourteen live
 * integrations at once, which is the blast radius this product spends its
 * effort avoiding everywhere else.
 */
export interface ClaimMappingSetView {
  id: string;
  name: string;
  description: string | null;
  protocol: ClaimProtocol;
  mappings: Omit<ClaimMappingSpec, 'id'>[];
}

const setView = (row: {
  id: string;
  name: string;
  description: string | null;
  protocol: string;
  mappings: unknown;
}): ClaimMappingSetView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
  mappings: (row.mappings ?? []) as Omit<ClaimMappingSpec, 'id'>[],
});

export async function listClaimMappingSets(
  tx: TenantClient,
): Promise<ClaimMappingSetView[]> {
  const rows = await tx.claimMappingSet.findMany({ orderBy: { name: 'asc' } });
  return rows.map(setView);
}

export interface ClaimMappingSetInput {
  name: string;
  description: string | null;
  protocol: ClaimProtocol;
  mappings: Omit<ClaimMappingSpec, 'id'>[];
}

export async function createClaimMappingSet(
  tx: TenantClient,
  input: ClaimMappingSetInput,
): Promise<ClaimMappingSetView> {
  const tenantId = await currentTenant(tx);
  const row = await tx.claimMappingSet.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description,
      protocol: input.protocol,
      mappings: input.mappings as never,
    },
  });
  return setView(row);
}

export async function deleteClaimMappingSet(
  tx: TenantClient,
  id: string,
): Promise<void> {
  // The applications keep what was stamped onto them. Deleting a template is
  // not a decision about the integrations built from it, and taking their
  // mappings away would break every one of them at once.
  await tx.claimMappingSet.deleteMany({ where: { id } });
}

export class ClaimMappingSetProtocolMismatchError extends Error {
  constructor(
    readonly setProtocol: string,
    readonly applicationProtocol: string,
  ) {
    super(
      `that set is for ${setProtocol} and this application uses ${applicationProtocol}`,
    );
    this.name = 'ClaimMappingSetProtocolMismatchError';
  }
}

/**
 * Stamps a set onto an application.
 *
 * A claim the application already sends is LEFT ALONE rather than overwritten.
 * `@@unique([applicationId, protocol, claimName])` makes a duplicate
 * impossible anyway, but the choice of which side wins is a real one: an
 * administrator who tuned one mapping by hand and then applied a set would
 * otherwise lose the tuning silently, and the set is the general case while
 * the hand edit is the specific one.
 *
 * Returns what it added and what it left, so the console can say which —
 * "applied" with no numbers is indistinguishable from "did nothing".
 */
export async function applyClaimMappingSet(
  tx: TenantClient,
  applicationId: string,
  setId: string,
): Promise<{ added: number; alreadyPresent: number }> {
  const tenantId = await currentTenant(tx);
  const set = await tx.claimMappingSet.findUniqueOrThrow({ where: { id: setId } });
  const view = setView(set);

  const application = await tx.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { type: true },
  });
  // A SAML set on an OIDC application would write rows the assertion builder
  // for that protocol never reads — mappings that look configured and send
  // nothing.
  if (application.type !== view.protocol) {
    throw new ClaimMappingSetProtocolMismatchError(view.protocol, application.type);
  }

  const existing = await tx.claimMapping.findMany({
    where: { applicationId, protocol: view.protocol },
    select: { claimName: true },
  });
  const held = new Set(existing.map((row) => row.claimName));

  let added = 0;
  for (const mapping of view.mappings) {
    if (held.has(mapping.claimName)) continue;
    await tx.claimMapping.create({
      data: {
        tenantId,
        applicationId,
        protocol: view.protocol,
        claimName: mapping.claimName,
        nameFormat: mapping.nameFormat,
        sourceKind: mapping.sourceKind,
        sourceField: mapping.sourceField,
        contractStrategy: mapping.contractStrategy,
        literalValue: mapping.literalValue,
        releaseScope: mapping.releaseScope,
        multiValued: mapping.multiValued,
      },
    });
    added += 1;
  }

  return { added, alreadyPresent: view.mappings.length - added };
}
