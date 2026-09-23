import { createHash } from 'node:crypto';
import { withTenant } from '@syntra/db';
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
  receipt: { auditEventId: string; sequence: number; hash: string };
}

/**
 * Produces the portable, human-readable part of a tenant's identity and access
 * configuration. Authentication proofs and vault ciphertext are deliberately
 * absent: an offboarding export must not become a credential dump.
 */
export async function createTenantDataExport(
  tenantId: string,
  actorUserId: string,
): Promise<TenantDataExport> {
  return withTenant(tenantId, async (tx) => {
    const generatedAt = new Date().toISOString();
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
    const exclusions = [
      'vault secret ciphertext and encryption material',
      'password hashes and password history',
      'MFA credentials, recovery codes, and authentication challenges',
      'session, refresh, reset, and API token material',
      'signing private keys and transient protocol artifacts',
    ];
    const document = { schema: 'syntra.tenant-export.v1' as const, generatedAt, tenant, data, exclusions };
    const digest = createHash('sha256').update(stableStringify(document)).digest('hex');
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
        generatedAt,
        recordCounts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
        exclusions,
      },
    });
    return { ...document, digest, receipt: { auditEventId: event.id, sequence: event.sequence, hash: event.hash } };
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

    const generatedAt = new Date();
    const inventory = {
      people, users, contracts, targets, directorySources: sources, personSources,
      secrets, auditEvents, lifecycleOperations, lifecycleSimulations,
    };
    const blockers = { activeLegalHolds, unresolvedLifecycleOperations };
    const deletionReady = activeLegalHolds === 0 && unresolvedLifecycleOperations === 0;
    const evidence = {
      generatedAt: generatedAt.toISOString(), tenant, inventory, blockers, deletionReady,
    };
    const digest = createHash('sha256').update(stableStringify(evidence)).digest('hex');
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
      digest,
      receipt: { auditEventId: event.id, sequence: event.sequence, hash: event.hash },
    };
  });
}
