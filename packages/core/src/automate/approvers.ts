import type { TenantClient } from '@syntra/db';
import { activeContracts, resolveContractForMapping } from '../identity/contract-service.js';
import { listMembers } from '../directory/group-service.js';
import type { ApproverVia, ResourceType } from './types.js';

/**
 * A chain deep enough to hit this is a cycle, not an organization.
 *
 * Deliberately a constant and not a tenant setting: it terminates a walk, it
 * does not express a policy, and a tenant that could raise it could hang every
 * approval it has.
 */
export const MAX_MANAGER_DEPTH = 16;

export type ApproverSelector =
  | 'manager'
  | 'managerChain'
  | 'productOwner'
  | 'resourceOwner'
  | 'role'
  | 'group'
  | 'person';

/**
 * `| undefined` on every optional, for the reason `AudienceCondition` and
 * `FormField` carry it: `exactOptionalPropertyTypes` is on repo-wide, and zod
 * infers `depth?: number | undefined` for `z.number().optional()`. Without it
 * the schema's inferred type is NOT assignable to this one, and the HTTP layer
 * -- which parses a stage out of `@syntra/contracts` and hands it straight to
 * `upsertWorkflow` -- does not compile.
 */
export interface SelectorConfig {
  /** managerChain only, 1..5. */
  depth?: number | undefined;
  roleId?: string | undefined;
  groupId?: string | undefined;
  personId?: string | undefined;
}

/** The whole stage as it stood at submission. Written onto ApprovalStep. */
export interface StageSnapshot {
  sequence: number;
  name: string;
  selector: ApproverSelector;
  selectorConfig: SelectorConfig;
  quorum: 'any' | 'all';
  fallbackSelector: ApproverSelector | null;
  fallbackConfig: SelectorConfig;
  slaHours: number;
  onTimeout: 'remind' | 'escalate' | 'expire';
  escalationSelector: ApproverSelector | null;
  escalationConfig: SelectorConfig;
  expiryHours: number | null;
}

export interface ResolutionSubject {
  subjectPersonId: string;
  /** The person behind the submitting account, when there is one. */
  submitterPersonId: string | null;
  productOwnerPersonId: string | null;
  productOwnerGroupId: string | null;
  /** Restricts which delegations apply. */
  productCategory: string | null;
  resources: { resourceType: ResourceType; resourceId: string }[];
}

export type DropReason =
  | 'subject'
  | 'submitter'
  | 'no_user'
  | 'inactive_user'
  | 'no_active_contract';

export interface ResolvedApprover {
  personId: string;
  via: ApproverVia;
  onBehalfOfPersonId: string | null;
}

export interface ResolutionResult {
  approvers: ResolvedApprover[];
  usedFallback: boolean;
  dropped: { personId: string; reason: DropReason }[];
}

/**
 * The contract that supplies the manager: the primary contract if currently
 * active, otherwise the active contract with the lowest sequence number.
 *
 * `resolveContractForMapping` is reused rather than reimplemented. Access uses
 * it for claims and Provision uses it for account attributes, and a person's
 * approval chain disagreeing with their SAML assertion about who their manager
 * is would be a support call nobody can close.
 */
export async function mappingContractFor(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<{ id: string; managerPersonId: string | null } | null> {
  const primary = await resolveContractForMapping(tx, personId, 'primary', on);
  const contract = primary ?? (await resolveContractForMapping(tx, personId, 'lowestSequence', on));
  return contract === null
    ? null
    : { id: contract.id, managerPersonId: contract.managerPersonId };
}

/**
 * The manager, their manager, and so on, up to `depth` levels.
 *
 * Carries a seen-set and a depth cap for the reason `orgUnitChain` does:
 * `Contract.managerPersonId` is a self-relation with no database-level
 * acyclicity check, and a cycle introduced by a bad import would otherwise
 * hang every approval in the tenant.
 */
export async function managerChainFor(
  tx: TenantClient,
  personId: string,
  depth: number,
  on: Date,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>([personId]);
  let current = personId;

  const limit = Math.min(depth, MAX_MANAGER_DEPTH);
  for (let step = 0; step < limit; step += 1) {
    const contract = await mappingContractFor(tx, current, on);
    const next = contract?.managerPersonId ?? null;
    if (next === null) break;
    chain.push(next);
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
  }

  return chain;
}

/**
 * Whether somebody can actually act, and why not when they cannot.
 *
 * All three conditions, per spec section 8: a live Syntra account, that
 * account active, and at least one active contract. A person with no `User` at
 * all cannot sign in and therefore cannot decide -- the ordinary case of a
 * manager who exists in the HR record and has no account here.
 */
export async function isValidApprover(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<DropReason | null> {
  const users = await tx.user.findMany({ where: { personId }, select: { status: true } });
  if (users.length === 0) return 'no_user';
  if (!users.some((u) => u.status === 'active')) return 'inactive_user';
  const contracts = await activeContracts(tx, personId, on);
  if (contracts.length === 0) return 'no_active_contract';
  return null;
}

/**
 * Active delegations from each of `delegatorPersonIds`, as delegator to
 * delegates.
 *
 * Exactly ONE level is expanded, which is what makes delegation
 * non-transitive: A delegates to B, B delegates to C, and C is not an approver
 * of A's steps. Depth is also refused when the delegation is created, but this
 * is the half that holds even if a row got in another way.
 */
export async function activeDelegatesFor(
  tx: TenantClient,
  delegatorPersonIds: readonly string[],
  category: string | null,
  on: Date,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (delegatorPersonIds.length === 0) return out;

  const rows = await tx.approvalDelegation.findMany({
    where: {
      delegatorPersonId: { in: [...delegatorPersonIds] },
      revokedAt: null,
      startsAt: { lte: on },
      endsAt: { gt: on },
      // A delegation restricted to one product category applies only there. A
      // delegation with no category applies to everything.
      OR: [{ category: null }, ...(category === null ? [] : [{ category }])],
    },
    select: { delegatorPersonId: true, delegatePersonId: true },
  });

  for (const row of rows) {
    const list = out.get(row.delegatorPersonId) ?? [];
    if (!list.includes(row.delegatePersonId)) list.push(row.delegatePersonId);
    out.set(row.delegatorPersonId, list);
  }
  return out;
}

async function personIdsForUsers(
  tx: TenantClient,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const users = await tx.user.findMany({
    where: { id: { in: [...userIds] }, personId: { not: null } },
    select: { personId: true },
  });
  return users.map((u) => u.personId!).filter((id, i, all) => all.indexOf(id) === i);
}

/** The raw set a selector names, before delegation, subtraction or validity. */
export async function resolveSelector(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
  subject: ResolutionSubject,
  on: Date,
): Promise<string[]> {
  switch (selector) {
    case 'manager': {
      const contract = await mappingContractFor(tx, subject.subjectPersonId, on);
      return contract?.managerPersonId === null || contract === null
        ? []
        : [contract.managerPersonId];
    }
    case 'managerChain': {
      const depth = Math.min(Math.max(config.depth ?? 1, 1), 5);
      const chain = await managerChainFor(tx, subject.subjectPersonId, depth, on);
      // The n-th manager up, and only that one. A chain shorter than n
      // resolves to nobody and falls through to the required fallback.
      const nth = chain[depth - 1];
      return nth === undefined ? [] : [nth];
    }
    case 'productOwner': {
      if (subject.productOwnerPersonId !== null) return [subject.productOwnerPersonId];
      if (subject.productOwnerGroupId === null) return [];
      const members = await listMembers(tx, subject.productOwnerGroupId);
      return members
        .map((u) => u.personId)
        .filter((id): id is string => id !== null);
    }
    case 'resourceOwner': {
      if (subject.resources.length === 0) return [];
      const owners = await tx.resourceOwner.findMany({
        where: {
          OR: subject.resources.map((r) => ({
            resourceType: r.resourceType,
            resourceId: r.resourceId,
          })),
        },
      });
      const people: string[] = [];
      for (const owner of owners) {
        if (owner.ownerPersonId !== null) {
          people.push(owner.ownerPersonId);
          continue;
        }
        if (owner.ownerGroupId !== null) {
          const members = await listMembers(tx, owner.ownerGroupId);
          for (const member of members) {
            if (member.personId !== null) people.push(member.personId);
          }
        }
      }
      return people.filter((id, i, all) => all.indexOf(id) === i);
    }
    case 'role': {
      if (config.roleId === undefined) return [];
      const assignments = await tx.roleAssignment.findMany({
        where: { roleId: config.roleId },
        select: { userId: true },
      });
      return personIdsForUsers(tx, assignments.map((a) => a.userId));
    }
    case 'group': {
      if (config.groupId === undefined) return [];
      const members = await listMembers(tx, config.groupId);
      return members.map((u) => u.personId).filter((id): id is string => id !== null);
    }
    case 'person':
      return config.personId === undefined ? [] : [config.personId];
  }
}

/**
 * One selector's worth of resolution: subtract the subject and the submitter,
 * expand delegations of whoever is left, subtract again, then drop whoever
 * cannot act.
 *
 * The subtraction happens HERE, once, rather than inside each `case` above. A
 * rule applied per selector is a rule the next selector forgets, and the next
 * selector is the one somebody adds in a year.
 *
 * It happens at BOTH ends of the expansion, and that is the whole design.
 * **Every exclusion in an approver resolver must be applied at every
 * expansion step, because any expansion step can reintroduce what an earlier
 * one removed.** Delegation is such a step: a delegate's authority is
 * *entirely derived* from their delegator, so subtracting the delegator and
 * keeping their delegate is self-approval laundered through one hop, and it
 * reads in the audit log as a legitimate approval by a third party. The
 * exploit is one row: own the product (or the resource, or be the named
 * `person` on the stage), create an `ApprovalDelegation` to a colleague --
 * spec section 8 explicitly permits a delegator to create their own -- and
 * submit. Task 11's decision-time invariant does not catch it, because the
 * decider is neither the subject nor the submitter and
 * `ApprovalStepApprover` genuinely has the row.
 */
async function resolveOne(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
  subject: ResolutionSubject,
  via: 'selector' | 'fallback' | 'escalation',
  on: Date,
  dropped: { personId: string; reason: DropReason }[],
): Promise<ResolvedApprover[]> {
  const named = await resolveSelector(tx, selector, config, subject, on);

  // Subtract BEFORE expanding, so no delegation of an ineligible delegator is
  // ever constructed. Dropping them afterwards is not equivalent: the
  // delegate is a different person and survives a per-person filter.
  const eligible: string[] = [];
  for (const personId of named) {
    if (personId === subject.subjectPersonId) {
      dropped.push({ personId, reason: 'subject' });
      continue;
    }
    if (subject.submitterPersonId !== null && personId === subject.submitterPersonId) {
      dropped.push({ personId, reason: 'submitter' });
      continue;
    }
    eligible.push(personId);
  }

  const delegates = await activeDelegatesFor(tx, eligible, subject.productCategory, on);

  const candidates: ResolvedApprover[] = [];
  for (const personId of eligible) {
    candidates.push({ personId, via, onBehalfOfPersonId: null });
    for (const delegate of delegates.get(personId) ?? []) {
      candidates.push({ personId: delegate, via: 'delegate', onBehalfOfPersonId: personId });
    }
  }

  const out: ResolvedApprover[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.personId)) continue;
    seen.add(candidate.personId);

    // The invariant, applied a SECOND time, now after delegation expansion.
    // The first pass could not see a delegate; this one can, and a delegate
    // may themselves be the subject or the submitter. Neither pass is
    // redundant: drop the first and a delegate of an ineligible delegator
    // survives; drop this one and an ineligible delegate survives.
    if (candidate.personId === subject.subjectPersonId) {
      dropped.push({ personId: candidate.personId, reason: 'subject' });
      continue;
    }
    if (
      subject.submitterPersonId !== null &&
      candidate.personId === subject.submitterPersonId
    ) {
      dropped.push({ personId: candidate.personId, reason: 'submitter' });
      continue;
    }

    const invalid = await isValidApprover(tx, candidate.personId, on);
    if (invalid !== null) {
      dropped.push({ personId: candidate.personId, reason: invalid });
      continue;
    }
    out.push(candidate);
  }
  return out;
}

/**
 * The stage's approver set: the selector, and the fallback when the selector
 * left nobody.
 *
 * Returning an empty list is a legitimate outcome and not an error. The caller
 * turns it into `blocked_no_approver`, which appears on the dashboard,
 * notifies the product owner and every holder of `automate.manage`, and stays
 * there. It never auto-approves and it never sits silently, but neither of
 * those decisions belongs in a resolver.
 */
export async function resolveStageApprovers(
  tx: TenantClient,
  stage: StageSnapshot,
  subject: ResolutionSubject,
  on: Date,
): Promise<ResolutionResult> {
  const dropped: { personId: string; reason: DropReason }[] = [];
  const primary = await resolveOne(
    tx,
    stage.selector,
    stage.selectorConfig,
    subject,
    'selector',
    on,
    dropped,
  );
  if (primary.length > 0) return { approvers: primary, usedFallback: false, dropped };

  if (stage.fallbackSelector === null) {
    return { approvers: [], usedFallback: false, dropped };
  }
  const fallback = await resolveOne(
    tx,
    stage.fallbackSelector,
    stage.fallbackConfig,
    subject,
    'fallback',
    on,
    dropped,
  );
  return { approvers: fallback, usedFallback: true, dropped };
}

/**
 * The escalation set, resolved when a stage passes its SLA under
 * `onTimeout: 'escalate'`.
 *
 * These are ADDED to the stage; the original approvers remain and are told
 * they were escalated past. Escalation that silently removes somebody's
 * authority is how an approver discovers, months later, that decisions
 * attributed to their team were not theirs. The subtraction applies here too:
 * escalating to a role the subject happens to hold is a plausible accident.
 */
export async function resolveEscalationApprovers(
  tx: TenantClient,
  stage: StageSnapshot,
  subject: ResolutionSubject,
  on: Date,
): Promise<ResolutionResult> {
  const dropped: { personId: string; reason: DropReason }[] = [];
  if (stage.escalationSelector === null) {
    return { approvers: [], usedFallback: false, dropped };
  }
  const approvers = await resolveOne(
    tx,
    stage.escalationSelector,
    stage.escalationConfig,
    subject,
    'escalation',
    on,
    dropped,
  );
  return { approvers, usedFallback: false, dropped };
}
