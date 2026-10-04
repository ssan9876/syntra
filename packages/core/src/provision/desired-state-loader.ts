import { orgUnitPlacementDn } from './org-unit-mirror.js';
import { withTenant, type TenantClient } from '@syntra/db';
import { correlationKeyPolicyFor } from '@syntra/connectors';
import { conditionSchema } from './condition.js';
import { desiredState } from './desired.js';
import type { ContractFacts, GrantFacts, PersonFacts, RuleFacts } from './types.js';
import { verifiedEmailDomains } from '../tenant/email-domains.js';
import { listPersonExclusions } from './exclusion-service.js';

const MS_PER_DAY = 86_400_000;

/**
 * A change to one contract, applied in memory before the rules are read.
 * `endDate` set to a date is how a departure is rehearsed; every other field
 * is a mover field.
 */
export interface ContractOverride {
  sequence: number;
  department?: string | null;
  jobTitle?: string | null;
  costCentre?: string | null;
  employer?: string | null;
  location?: string | null;
  fte?: number | null;
  endDate?: Date | null;
}

export interface EntitlementFacts {
  id: string;
  externalId: string;
  displayName: string;
  status: string;
  manageable: boolean;
  privileged: boolean;
}

export interface PersonTargetProjection {
  targetSystemId: string;
  targetName: string;
  targetType: string;
  enforcementMode: string;
  hasProfile: boolean;
  /** What the rules ask for, or null when the target has no profile to evaluate against. */
  desired: {
    accountRequired: boolean;
    enabledNow: boolean;
    correlationKey: string | null;
    container: string | null;
    entitlementIds: string[];
  } | null;
  notYetStarted: boolean;
  unprocessable: { kind: string; message: string } | null;
  /**
   * Why the person is left out of this target, or null. When set, `desired`
   * is null: no rule is evaluated and nothing is proposed for the account.
   */
  leftOut: string | null;
  /** The account Syntra has recorded for this person here, if any. */
  held: {
    accountId: string;
    anchor: string | null;
    status: string;
    correlationKey: string;
    entitlements: { entitlementId: string; origin: string }[];
  } | null;
  /**
   * True when something the projection depends on has not been confirmed
   * against the target: a catalog never refreshed, an entitlement the target
   * no longer reports, or a group the connector could not read. A preview
   * built on this must say so rather than present a removal as certain.
   */
  catalogUnverified: boolean;
  entitlements: Map<string, EntitlementFacts>;
  ladder: {
    preHireDays: number;
    disableGraceDays: number;
    entitlementRevocationDelayDays: number;
    archiveAfterDays: number | null;
    deleteAfterDays: number | null;
  };
}

export interface ProjectionOptions {
  now?: Date;
  contractOverride?: ContractOverride;
  /** Limits the projection to these targets; default is every enabled target. */
  targetIds?: string[];
}

function applyOverride(contracts: ContractFacts[], override: ContractOverride | undefined) {
  if (!override) return contracts;
  return contracts.map((contract) => {
    if (contract.sequence !== override.sequence) return contract;
    return {
      ...contract,
      ...(override.department === undefined ? {} : { department: override.department }),
      ...(override.jobTitle === undefined ? {} : { jobTitle: override.jobTitle }),
      ...(override.costCentre === undefined ? {} : { costCentre: override.costCentre }),
      ...(override.employer === undefined ? {} : { employer: override.employer }),
      ...(override.location === undefined ? {} : { location: override.location }),
      ...(override.fte === undefined ? {} : { fte: override.fte }),
      ...(override.endDate === undefined ? {} : { endDate: override.endDate }),
    };
  });
}

/**
 * Read-only: what every enabled target's rules and profile would want for
 * one person, computed by the same `desiredState` a run uses, with no
 * connector opened, no run created, no correlation key reserved and nothing
 * written. The contract change is applied in memory, which is what makes
 * this usable for "what would happen if" before anything happens.
 *
 * One short transaction per target. This is a per-person read, so the
 * five-second transaction budget that constrains a whole-tenant run does
 * not bite here.
 */
export async function projectPersonOnTargets(
  tenantId: string,
  personId: string,
  options: ProjectionOptions = {},
): Promise<PersonTargetProjection[]> {
  const now = options.now ?? new Date();
  const { person, contracts, targets, users, exclusions } = await withTenant(tenantId, async (tx) => ({
    users: await tx.user.findMany({ where: { personId }, select: { id: true } }),
    exclusions: await listPersonExclusions(tx, personId),
    person: await tx.person.findUniqueOrThrow({ where: { id: personId } }),
    contracts: await tx.contract.findMany({ where: { personId }, orderBy: { sequence: 'asc' } }),
    targets: await tx.targetSystem.findMany({
      where: { enabled: true, ...(options.targetIds ? { id: { in: options.targetIds } } : {}) },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        config: true,
        enforcementMode: true,
        preHireDays: true,
        disableGraceDays: true,
        entitlementRevocationDelayDays: true,
        archiveAfterDays: true,
        deleteAfterDays: true,
        renameEnabled: true,
        mirrorOrgUnits: true,
        orgUnitRootDn: true,
      },
    }),
  }));

  const facts: PersonFacts = {
    id: person.id,
    syntraUserId: users.length === 1 ? users[0]!.id : null,
    givenName: person.givenName,
    familyName: person.familyName,
    nameConvention: person.nameConvention,
    businessEmail: person.businessEmail,
    personalEmail: person.personalEmail,
    status: person.status,
  };
  const contractFacts = applyOverride(
    contracts.map((c) => ({
      id: c.id,
      sequence: c.sequence,
      isPrimary: c.isPrimary,
      startDate: c.startDate,
      endDate: c.endDate,
      department: c.department,
      jobTitle: c.jobTitle,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      fte: c.fte === null ? null : Number(c.fte),
    })),
    options.contractOverride,
  );

  const leftOut = new Map(exclusions.map((e) => [e.targetSystemId, e.message]));
  const projections: PersonTargetProjection[] = [];
  for (const target of targets) {
    projections.push(
      await withTenant(tenantId, (tx) =>
        projectOne(tx, target, facts, contractFacts, person.orgUnitId, now, leftOut.get(target.id) ?? null),
      ),
    );
  }
  return projections;
}

async function projectOne(
  tx: TenantClient,
  target: {
    id: string;
    name: string;
    type: string;
    config: unknown;
    enforcementMode: string;
    preHireDays: number;
    disableGraceDays: number;
    entitlementRevocationDelayDays: number;
    archiveAfterDays: number | null;
    deleteAfterDays: number | null;
    renameEnabled: boolean;
    mirrorOrgUnits: boolean;
    orgUnitRootDn: string | null;
  },
  person: PersonFacts,
  contracts: ContractFacts[],
  orgUnitId: string | null,
  now: Date,
  leftOut: string | null,
): Promise<PersonTargetProjection> {
  const ladder = {
    preHireDays: target.preHireDays,
    disableGraceDays: target.disableGraceDays,
    entitlementRevocationDelayDays: target.entitlementRevocationDelayDays,
    archiveAfterDays: target.archiveAfterDays,
    deleteAfterDays: target.deleteAfterDays,
  };
  const [profile, ruleRows, entitlementRows, account, grants, placement, container] =
    await Promise.all([
      tx.accountProfile.findFirst({ where: { targetSystemId: target.id } }),
      tx.businessRule.findMany({
        where: { targetSystemId: target.id },
        include: { entitlements: { select: { entitlementId: true } } },
      }),
      tx.entitlement.findMany({ where: { targetSystemId: target.id } }),
      tx.targetAccount.findFirst({
        where: { targetSystemId: target.id, personId: person.id },
        include: { entitlements: { where: { state: 'held' } } },
      }),
      tx.accessGrant.findMany({
        where: {
          targetSystemId: target.id,
          resourceType: 'entitlement',
          subjectPersonId: person.id,
          status: { in: ['pending', 'active'] },
        },
        select: { id: true, requestId: true, resourceId: true, startsAt: true, endsAt: true },
      }),
      tx.accountPlacement.findFirst({
        where: { targetSystemId: target.id, personId: person.id },
        select: { container: true },
      }),
      // The row, or -- for a mirroring target the next run has not synced
      // yet -- the DN that run will derive, so this projection and the run
      // agree about a unit created a minute ago.
      orgUnitId === null ? Promise.resolve(null) : orgUnitPlacementDn(tx, target, orgUnitId),
    ]);

  const entitlements = new Map<string, EntitlementFacts>(
    entitlementRows.map((row) => [
      row.id,
      {
        id: row.id,
        externalId: row.externalId,
        displayName: row.displayName,
        status: row.status,
        manageable: row.manageable,
        privileged: row.privileged,
      },
    ]),
  );
  const held = account
    ? {
        accountId: account.id,
        anchor: account.anchor,
        status: account.status,
        correlationKey: account.correlationKey,
        entitlements: account.entitlements.map((h) => ({
          entitlementId: h.entitlementId,
          origin: h.origin,
        })),
      }
    : null;
  const base = {
    targetSystemId: target.id,
    targetName: target.name,
    targetType: target.type,
    enforcementMode: target.enforcementMode,
    held,
    entitlements,
    ladder,
    leftOut,
  };

  // Ahead of every rule: nothing is evaluated for somebody left out.
  if (leftOut !== null) {
    return {
      ...base,
      hasProfile: profile !== null,
      desired: null,
      notYetStarted: false,
      unprocessable: null,
      catalogUnverified: false,
    };
  }

  if (!profile) {
    return {
      ...base,
      hasProfile: false,
      desired: null,
      notYetStarted: false,
      unprocessable: {
        kind: 'no_profile',
        message: 'This target has no account profile.',
      },
      catalogUnverified: true,
    };
  }

  let ruleUnreadable: string | null = null;
  const rules: RuleFacts[] = [];
  for (const rule of ruleRows) {
    const parsed = conditionSchema.safeParse(rule.condition);
    if (!parsed.success) {
      ruleUnreadable = `Business rule "${rule.name}" has a condition this version cannot read.`;
      continue;
    }
    rules.push({
      id: rule.id,
      name: rule.name,
      condition: parsed.data,
      grantsAccount: rule.grantsAccount,
      enabled: rule.enabled,
      entitlementIds: rule.entitlements.map((j) => j.entitlementId),
    });
  }
  const grantFacts: GrantFacts[] = grants.map((g) => ({
    grantId: g.id,
    requestId: g.requestId,
    entitlementId: g.resourceId,
    startsAt: g.startsAt,
    endsAt: g.endsAt,
  }));
  const entitlementStatus = new Map(
    entitlementRows.map((e) => [e.id, e.status as 'present' | 'missing' | 'unreadable']),
  );
  const horizon = new Date(now.getTime() + target.preHireDays * MS_PER_DAY);
  const config = (target.config ?? {}) as Record<string, unknown>;
  const state = desiredState({
    person,
    contracts,
    rules,
    grants: grantFacts,
    profile: {
      correlationKeyTemplate: profile.correlationKeyTemplate,
      maxUniquenessAttempts: profile.maxUniquenessAttempts,
      containerTemplate: profile.containerTemplate,
      fallbackContainer: profile.fallbackContainer,
      attributeTemplates: (profile.attributeTemplates ?? {}) as Record<string, string>,
      baseDn: typeof config.baseDn === 'string' ? config.baseDn : '',
    },
    entitlementStatus,
    existingCorrelationKey: account?.correlationKey ?? null,
    // Only this person's own key is known here; a fresh key may collide with
    // one a run would have avoided. The preview names the key as provisional
    // by not writing it anywhere.
    takenCorrelationKeys: new Set<string>(),
    correlationKeyPolicy: correlationKeyPolicyFor(target.type, target.config),
    verifiedEmailDomains: await verifiedEmailDomains(tx),
    containerOverride: placement?.container ?? null,
    orgUnitContainer: container,
    renameEnabled: target.renameEnabled,
    now,
    horizon,
  });

  const desiredIds = [...state.entitlements];
  const touched = new Set([...desiredIds, ...(held?.entitlements.map((h) => h.entitlementId) ?? [])]);
  const catalogUnverified =
    entitlementRows.length === 0 ||
    entitlementRows.every((e) => e.lastSeenAt === null) ||
    [...touched].some((id) => (entitlementStatus.get(id) ?? 'missing') !== 'present');

  return {
    ...base,
    hasProfile: true,
    desired: {
      accountRequired: state.account?.required ?? false,
      enabledNow: state.account?.enabledNow ?? false,
      correlationKey: state.account?.correlationKey ?? null,
      container: state.account?.container ?? null,
      entitlementIds: desiredIds.sort(),
    },
    notYetStarted: state.notYetStarted,
    unprocessable:
      state.unprocessable ??
      (ruleUnreadable ? { kind: 'rule_unreadable', message: ruleUnreadable } : null),
    catalogUnverified,
  };
}

export interface AccessDelta {
  targetSystemId: string;
  targetName: string;
  accountStatus: string;
  /** What the run would do to the account itself. */
  account: 'create' | 'enable' | 'keep' | 'disable' | 'none';
  add: { entitlementId: string; displayName: string; privileged: boolean }[];
  retain: { entitlementId: string; displayName: string; privileged: boolean }[];
  remove: { entitlementId: string; displayName: string; privileged: boolean }[];
  unverified: boolean;
  unprocessable: { kind: string; message: string } | null;
  /** Why the person is left out of this target, or null. Nothing changes there when set. */
  leftOut: string | null;
}

/**
 * The entitlement diff a projection implies, in Provision's own terms: in
 * additive mode only holdings Provision itself granted are candidates for
 * removal; in authoritative mode everything the account holds is.
 */
export function accessDeltaFor(projection: PersonTargetProjection): AccessDelta {
  if (projection.leftOut !== null) {
    return {
      targetSystemId: projection.targetSystemId,
      targetName: projection.targetName,
      accountStatus: projection.held?.status ?? 'absent',
      account: 'none',
      add: [],
      retain: [],
      remove: [],
      unverified: false,
      unprocessable: null,
      leftOut: projection.leftOut,
    };
  }
  const name = (id: string) => {
    const facts = projection.entitlements.get(id);
    return {
      entitlementId: id,
      displayName: facts?.displayName ?? id,
      privileged: facts?.privileged ?? false,
    };
  };
  const heldIds = new Set(projection.held?.entitlements.map((h) => h.entitlementId) ?? []);
  const desiredIds = new Set(projection.desired?.entitlementIds ?? []);
  const managedOrigins = new Set(['rule', 'request']);
  const removable = (projection.held?.entitlements ?? []).filter(
    (h) => projection.enforcementMode === 'authoritative' || managedOrigins.has(h.origin),
  );
  const add = projection.unprocessable ? [] : [...desiredIds].filter((id) => !heldIds.has(id)).map(name);
  const remove = projection.unprocessable
    ? []
    : removable.filter((h) => !desiredIds.has(h.entitlementId)).map((h) => name(h.entitlementId));
  const retain = [...heldIds].filter((id) => desiredIds.has(id)).map(name);
  const accountPresent =
    projection.held !== null &&
    projection.held.status !== 'archived' &&
    projection.held.status !== 'deleted';
  const accountEnabled = projection.held?.status === 'active';
  let account: AccessDelta['account'] = 'none';
  if (projection.desired?.accountRequired) {
    account = !accountPresent ? 'create' : !accountEnabled && projection.desired.enabledNow ? 'enable' : 'keep';
  } else if (accountPresent && accountEnabled) {
    account = 'disable';
  } else if (accountPresent) {
    account = 'keep';
  }
  return {
    targetSystemId: projection.targetSystemId,
    targetName: projection.targetName,
    accountStatus: projection.held?.status ?? 'absent',
    account,
    add,
    retain,
    remove,
    unverified: projection.catalogUnverified,
    unprocessable: projection.unprocessable,
    leftOut: null,
  };
}
