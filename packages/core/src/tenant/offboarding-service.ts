import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { stableStringify, recordEvent } from '../audit/audit-service.js';

const RESOLVED_OPERATION_STATUSES = ['completed', 'cancelled'] as const;

export interface TenantOffboardingAssessment {
  generatedAt: Date;
  tenant: { id: string; name: string; slug: string };
  inventory: Record<string, number>;
  blockers: {
    activeLegalHolds: number;
    unresolvedLifecycleOperations: number;
  };
  deletionReady: boolean;
  /**
   * SHA-256 of the tenant's exportable data at assessment time -- the same
   * value an export taken over unchanged data carries. A deletion request is
   * bound to it, and a later recomputation that differs is staleness.
   */
  dataRevision: string;
  digest: string;
  receipt: { auditEventId: string; sequence: number; hash: string };
}

export interface TenantDataExport {
  schema: 'syntra.tenant-export.v1';
  generatedAt: string;
  tenant: Record<string, unknown>;
  data: Record<string, unknown[]>;
  exclusions: string[];
  digest: string;
  /** See `TenantOffboardingAssessment.dataRevision`. Outside the digest. */
  dataRevision: string;
  receipt: { auditEventId: string; sequence: number; hash: string };
}

const EXPORT_EXCLUSIONS = [
  'vault secret ciphertext and encryption material',
  'password hashes and password history',
  'MFA credentials, recovery codes, and authentication challenges',
  'session, refresh, reset, and API token material',
  'signing private keys and transient protocol artifacts',
];

/**
 * The value as it will exist once serialised: Dates become ISO strings.
 *
 * `stableStringify` walks an object's own enumerable keys, and a Date has
 * none, so hashed raw it contributes `{}` -- every timestamp in the export
 * would have been outside its own digest, and the digest of the JSON an
 * operator actually downloaded would not have matched the one in the header.
 * Hashing the round-tripped value makes the digest verifiable from the file.
 */
function asSerialised<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Reads the portable, human-readable part of a tenant's identity and access
 * configuration. Authentication proofs and vault ciphertext are deliberately
 * absent: an offboarding export must not become a credential dump.
 */
async function readExportableData(tx: TenantClient, tenantId: string) {
  const [tenant, users, attributes, orgUnits, groups, memberships, roles, roleAssignments,
    people, contracts, directorySources, directoryMappings, personSources, personMappings,
    targets, accountProfiles, businessRules, ruleEntitlements, entitlements, targetAccounts,
    accountEntitlements] = await Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, name: true, slug: true, primaryDomain: true, additionalDomains: true, status: true, adminMfaRequired: true, passwordMinLength: true, selfEnrolmentEnabled: true, lockoutThreshold: true, lockoutWindowMinutes: true, lockoutDurationMinutes: true, passwordMaxAgeDays: true, passwordHistoryDepth: true },
      }),
      tx.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, login: true, email: true, displayName: true, status: true, statusReason: true, passwordSource: true, passwordSourceHint: true, orgUnitId: true, personId: true, sourceId: true, sourceAnchor: true, createdAt: true, updatedAt: true } }),
      tx.userAttribute.findMany({ orderBy: { id: 'asc' } }),
      tx.orgUnit.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, parentId: true, sourceId: true, sourceAnchor: true, status: true, statusReason: true } }),
      tx.group.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, description: true, sourceId: true, sourceAnchor: true, status: true, statusReason: true } }),
      tx.groupMembership.findMany({ orderBy: { id: 'asc' }, select: { id: true, groupId: true, userId: true } }),
      tx.role.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, description: true, permissions: true, builtIn: true } }),
      tx.roleAssignment.findMany({ orderBy: { id: 'asc' }, select: { id: true, roleId: true, userId: true, scopeOrgUnitId: true } }),
      tx.person.findMany({ orderBy: { id: 'asc' } }),
      tx.contract.findMany({ orderBy: { id: 'asc' } }),
      tx.directorySource.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, type: true, config: true, secretName: true, schedule: true, autoApply: true, deactivationThresholdPercent: true, enabled: true, writebackEnabled: true, writebackPassword: true, writebackDisable: true, writebackDelete: true, lastRunAt: true, createdAt: true, updatedAt: true } }),
      tx.attributeMapping.findMany({ orderBy: { id: 'asc' } }),
      tx.personSource.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, type: true, config: true, secretName: true, feedMode: true, schedule: true, autoApply: true, deactivationThresholdPercent: true, enabled: true, lastRunAt: true, createdAt: true, updatedAt: true } }),
      tx.personFieldMapping.findMany({ orderBy: { id: 'asc' } }),
      tx.targetSystem.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, type: true, config: true, secretName: true, pairedDirectorySourceId: true, schedule: true, autoApply: true, enabled: true, enforcementMode: true, preHireDays: true, entitlementRevocationDelayDays: true, disableGraceDays: true, archiveAfterDays: true, reenableWithoutConfirmationDays: true } }),
      tx.accountProfile.findMany({ orderBy: { id: 'asc' } }),
      tx.businessRule.findMany({ orderBy: { id: 'asc' } }),
      tx.ruleEntitlement.findMany({ orderBy: { id: 'asc' } }),
      tx.entitlement.findMany({ orderBy: { id: 'asc' } }),
      tx.targetAccount.findMany({ orderBy: { id: 'asc' } }),
      tx.accountEntitlement.findMany({ orderBy: { id: 'asc' } }),
    ]);

  const data = { users, userAttributes: attributes, orgUnits, groups, groupMemberships: memberships,
    roles, roleAssignments, people, contracts, directorySources, directoryMappings, personSources,
    personMappings, targets, accountProfiles, businessRules, ruleEntitlements, entitlements,
    targetAccounts, accountEntitlements } as unknown as Record<string, unknown[]>;
  return asSerialised({ tenant: tenant as Record<string, unknown>, data });
}

/**
 * The tenant's data revision: SHA-256 over exactly what an export carries,
 * without the export's own timestamp.
 *
 * This is what "the assessment is stale" means. An export is the copy the
 * customer leaves with; if the data it was taken from has changed since, the
 * copy is no longer complete, and erasing the difference would destroy data
 * nobody took away. Counts alone would miss an edited record; this does not.
 * Audit events and authentication churn (sessions, attempts) are outside it,
 * so an approver signing in to approve does not make the request stale.
 */
export async function computeTenantDataRevision(tx: TenantClient, tenantId: string): Promise<string> {
  return sha256(await readExportableData(tx, tenantId));
}

/**
 * The record classes a deletion reviewer is shown, and the blockers. Shared
 * by the assessment and by the deletion preflight, which recomputes it at
 * request, approval and execution and refuses on any difference.
 */
export async function countOffboardingInventory(tx: TenantClient) {
  const [people, users, contracts, targets, sources, personSources, secrets, auditEvents,
    lifecycleOperations, lifecycleSimulations, activeLegalHolds, unresolvedLifecycleOperations] =
    await Promise.all([
      tx.person.count(),
      tx.user.count(),
      tx.contract.count(),
      tx.targetSystem.count(),
      tx.directorySource.count(),
      tx.personSource.count(),
      tx.secret.count(),
      tx.auditEvent.count(),
      tx.lifecycleOperation.count(),
      tx.lifecycleSimulation.count(),
      tx.lifecycleLegalHold.count({ where: { releasedAt: null } }),
      tx.lifecycleOperation.count({
        where: { status: { notIn: [...RESOLVED_OPERATION_STATUSES] } },
      }),
    ]);
  return {
    inventory: {
      people, users, contracts, targets, directorySources: sources, personSources,
      secrets, auditEvents, lifecycleOperations, lifecycleSimulations,
    } as Record<string, number>,
    blockers: { activeLegalHolds, unresolvedLifecycleOperations },
  };
}

/**
 * Produces the portable export artifact and its permanent receipt.
 */
export async function createTenantDataExport(
  tenantId: string,
  actorUserId: string,
): Promise<TenantDataExport> {
  return withTenant(tenantId, async (tx) => {
    const generatedAt = new Date().toISOString();
    const { tenant, data } = await readExportableData(tx, tenantId);
    const dataRevision = sha256({ tenant, data });
    const exclusions = [...EXPORT_EXCLUSIONS];
    const document = { schema: 'syntra.tenant-export.v1' as const, generatedAt, tenant, data, exclusions };
    const digest = sha256(document);
    const event = await recordEvent(tx, {
      actorUserId,
      action: 'tenant.offboarding.exported',
      targetType: 'Tenant',
      targetId: tenantId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        schema: document.schema,
        digest,
        dataRevision,
        generatedAt,
        recordCounts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
        exclusions,
      },
    });
    return { ...document, digest, dataRevision, receipt: { auditEventId: event.id, sequence: event.sequence, hash: event.hash } };
  });
}

/**
 * A durable, read-only deletion preflight. Counts prove the scope an operator
 * reviewed; the digest binds the receipt to that exact snapshot. Secrets are
 * counted but never read, decrypted, or copied into the evidence.
 */
export async function assessTenantOffboarding(
  tenantId: string,
  actorUserId: string,
): Promise<TenantOffboardingAssessment> {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true },
    });
    const { inventory, blockers } = await countOffboardingInventory(tx);
    const dataRevision = await computeTenantDataRevision(tx, tenantId);

    const generatedAt = new Date();
    const deletionReady = blockers.activeLegalHolds === 0 && blockers.unresolvedLifecycleOperations === 0;
    const evidence = {
      generatedAt: generatedAt.toISOString(), tenant, inventory, blockers, deletionReady, dataRevision,
    };
    const digest = sha256(evidence);
    const event = await recordEvent(tx, {
      actorUserId,
      action: 'tenant.offboarding.assessed',
      targetType: 'Tenant',
      targetId: tenant.id,
      outcome: 'success',
      sourceIp: null,
      payload: { ...evidence, digest },
    });

    return {
      generatedAt,
      tenant,
      inventory,
      blockers,
      deletionReady,
      dataRevision,
      digest,
      receipt: { auditEventId: event.id, sequence: event.sequence, hash: event.hash },
    };
  });
}
