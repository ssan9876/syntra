import { withTenant, type TenantClient } from '@syntra/db';
import { LIVE_GRANT_STATUSES } from '../automate/types.js';
import type {
  AttributionInput,
  DirectAssignmentFact,
  DiscoveredFact,
  GroupInheritanceFact,
  ManualFact,
  OrgUnitInheritanceFact,
  RequestFact,
  RuleFact,
} from './attribute.js';
import { EMPTY_ATTRIBUTION_INPUT } from './attribute.js';
import type { SourceObservation } from './freshness.js';
import { SYNTRA_SYSTEM_ID, subjectKey, type ResourceKind, type SubjectRef, type SystemKind } from './types.js';

/** A tree deep enough to hit this is a cycle, not an organization. */
export const MAX_ORG_UNIT_DEPTH = 64;

/**
 * Every comparison between an identifier that came from a directory and one
 * that came from PostgreSQL goes through here.
 *
 * NFKD, not NFD. NFD leaves the ligature in `Ĳsbrand` intact, so folding it
 * yields `sbrand` — a valid login that belongs to somebody else. Three
 * case-sensitivity defects on the Provision slice came from AD folding case
 * where PostgreSQL does not.
 */
export function foldIdentifier(value: string): string {
  return value.normalize('NFKD').toLowerCase();
}

export interface ApplicationPath {
  userId: string;
  applicationId: string;
  via: 'user' | 'group' | 'orgUnit';
  assignmentId: string;
  groupId: string | null;
  groupName: string | null;
  matchedOrgUnitId: string | null;
  matchedOrgUnitName: string | null;
  /** The user's own unit first, the matched unit last. Empty for the other two. */
  chain: { orgUnitId: string; name: string }[];
}

/**
 * Every application every user resolves to, WITH THE PATH.
 *
 * `resolveApplicationIdsForUser` answers the same question for one user and
 * returns `Set<string>`: it issues one `findMany` with an `OR` and selects
 * `applicationId` alone, so which assignment matched — and, for the org-unit
 * arm, which unit — is discarded. `orgUnitChain` is module-private. Spec
 * section 7 asserts that function already knows which unit produced the match;
 * it does not, and this is where Govern learns it.
 *
 * Set-based over the whole tenant in FOUR queries, because calling a per-user
 * helper in a loop over 1,180 users inside one 5000 ms transaction is a P2028
 * on the one nightly job that must not fail.
 *
 * `resolve.ts` is deliberately NOT modified: it is on the sign-in path, and a
 * second consumer with different needs is exactly the pressure that turns a
 * focused function into a general one nobody can reason about.
 */
export async function resolveApplicationPaths(tx: TenantClient): Promise<ApplicationPath[]> {
  const [users, memberships, units, assignments] = await Promise.all([
    tx.user.findMany({ select: { id: true, orgUnitId: true } }),
    tx.groupMembership.findMany({ select: { userId: true, groupId: true, group: { select: { name: true } } } }),
    tx.orgUnit.findMany({ select: { id: true, name: true, parentId: true } }),
    tx.appAssignment.findMany({
      where: { application: { status: 'active' } },
      select: {
        id: true,
        applicationId: true,
        subjectType: true,
        userId: true,
        groupId: true,
        orgUnitId: true,
      },
    }),
  ]);

  const unitById = new Map(units.map((u) => [u.id, u]));

  // Built once for the tenant, not once per user. The seen-set and the depth
  // cap are not paranoia: parentId is a self-relation with no acyclicity
  // check, and a cycle from a bad import would otherwise hang the snapshot.
  const chainCache = new Map<string, { orgUnitId: string; name: string }[]>();
  const chainFor = (start: string | null): { orgUnitId: string; name: string }[] => {
    if (start === null) return [];
    const cached = chainCache.get(start);
    if (cached) return cached;

    const chain: { orgUnitId: string; name: string }[] = [];
    const seen = new Set<string>();
    let current: string | null = start;
    for (let depth = 0; current !== null && depth < MAX_ORG_UNIT_DEPTH; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const unit = unitById.get(current);
      if (unit === undefined) break;
      chain.push({ orgUnitId: unit.id, name: unit.name });
      current = unit.parentId;
    }
    chainCache.set(start, chain);
    return chain;
  };

  const groupsByUser = new Map<string, { groupId: string; groupName: string }[]>();
  for (const m of memberships) {
    const list = groupsByUser.get(m.userId) ?? [];
    list.push({ groupId: m.groupId, groupName: m.group.name });
    groupsByUser.set(m.userId, list);
  }

  const byUser = new Map<string, typeof assignments>();
  const byGroup = new Map<string, typeof assignments>();
  const byUnit = new Map<string, typeof assignments>();
  for (const a of assignments) {
    if (a.subjectType === 'user' && a.userId) {
      byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
    } else if (a.subjectType === 'group' && a.groupId) {
      byGroup.set(a.groupId, [...(byGroup.get(a.groupId) ?? []), a]);
    } else if (a.subjectType === 'orgUnit' && a.orgUnitId) {
      byUnit.set(a.orgUnitId, [...(byUnit.get(a.orgUnitId) ?? []), a]);
    }
  }

  const paths: ApplicationPath[] = [];
  for (const user of users) {
    for (const a of byUser.get(user.id) ?? []) {
      paths.push({
        userId: user.id,
        applicationId: a.applicationId,
        via: 'user',
        assignmentId: a.id,
        groupId: null,
        groupName: null,
        matchedOrgUnitId: null,
        matchedOrgUnitName: null,
        chain: [],
      });
    }

    for (const group of groupsByUser.get(user.id) ?? []) {
      for (const a of byGroup.get(group.groupId) ?? []) {
        paths.push({
          userId: user.id,
          applicationId: a.applicationId,
          via: 'group',
          assignmentId: a.id,
          groupId: group.groupId,
          groupName: group.groupName,
          matchedOrgUnitId: null,
          matchedOrgUnitName: null,
          chain: [],
        });
      }
    }

    const chain = chainFor(user.orgUnitId);
    for (const unit of chain) {
      for (const a of byUnit.get(unit.orgUnitId) ?? []) {
        // The chain is truncated AT THE MATCH, so the recorded path is the
        // actual path: "Care, then North region, then Head Office, which is
        // where the assignment is" rather than the whole ancestry.
        const upToMatch = chain.slice(0, chain.findIndex((c) => c.orgUnitId === unit.orgUnitId) + 1);
        paths.push({
          userId: user.id,
          applicationId: a.applicationId,
          via: 'orgUnit',
          assignmentId: a.id,
          groupId: null,
          groupName: null,
          matchedOrgUnitId: unit.orgUnitId,
          matchedOrgUnitName: unit.name,
          chain: upToMatch,
        });
      }
    }
  }

  return paths;
}
export interface CollectedHolding {
  subject: SubjectRef;
  systemKind: SystemKind;
  systemId: string;
  systemName: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: 'held' | 'unknown';
  observedAt: Date;
  observedVia: string;
  attribution: AttributionInput;
}

export interface CollectedGap {
  kind: 'resource_unreadable' | 'account_unreadable' | 'person_unprocessable' | 'subject_unresolvable';
  systemKind: SystemKind;
  systemId: string;
  resourceId: string | null;
  personId: string | null;
  accountRef: string | null;
  reason: string;
  sourceRunId: string | null;
}

export interface CollectedTenant {
  asOf: Date;
  holdings: CollectedHolding[];
  gaps: CollectedGap[];
  sources: SourceObservation[];
  personIds: string[];
  personsWithActiveContract: number;
  unattributedAccountKeys: string[];
  /** Asserted by the budget test in Task 12: fixed, and independent of population. */
  queryCount: number;
}

export interface CollectOptions {
  asOf?: Date;
  freshnessSlaFor?: (kind: SystemKind, id: string) => number;
  defaultFreshnessSlaHours?: number;
}
/**
 * The collect stage. Nine short transactions, each returning plain data.
 *
 * NOT one long transaction: `withTenant` is `prisma.$transaction(fn)` under a
 * 5000 ms default and a tenant-sized read blows it. NOT a read outside a
 * transaction either: a bare `prisma.<model>` read returns [] under forced RLS
 * whether or not the code works, which is a silent, green, completely wrong
 * snapshot. The resolution is always a short transaction returning plain data.
 *
 * `asOf` is the instant this function STARTS, not when it finishes, so a build
 * taking twenty minutes describes a world as it stood at one stated moment
 * rather than over a smeared window.
 */
/**
 * The subject for a `User` row, whether or not Govern can name the person
 * behind it.
 *
 * All three of the loops below used to be `if (user?.personId == null) continue;`
 * -- so an account with no person contributed NO holdings at all, only a
 * `subject_unresolvable` gap. §6 is explicit that an orphan account's holdings
 * are holdings, held by somebody Syntra cannot name, and the consequence of
 * dropping them is that a service account holding `tenant.manage` appeared in
 * no report, no campaign and no SoD evaluation. That is the single most
 * interesting row an access review can produce, and it was the one row that was
 * never there.
 *
 * `SYNTRA_SYSTEM_ID` rather than the resource's own system: the SUBJECT is a
 * Syntra account, whatever system the thing it holds lives in.
 */
function subjectForUser(user: { id: string; personId: string | null }): SubjectRef {
  return user.personId === null
    ? { kind: 'account', systemId: SYNTRA_SYSTEM_ID, accountRef: user.id }
    : { kind: 'person', personId: user.personId };
}

export async function collectTenant(
  tenantId: string,
  options: CollectOptions = {},
): Promise<CollectedTenant> {
  const asOf = options.asOf ?? new Date();
  const defaultSla = options.defaultFreshnessSlaHours ?? 24;
  const slaFor = options.freshnessSlaFor ?? (() => defaultSla);

  const holdings: CollectedHolding[] = [];
  const gaps: CollectedGap[] = [];
  const sources: SourceObservation[] = [];

  // (1) People and contracts.
  const people = await withTenant(tenantId, async (tx) => {
    const persons = await tx.person.findMany({
      select: { id: true, givenName: true, familyName: true, status: true },
    });
    const contracts = await tx.contract.findMany({
      select: { id: true, personId: true, startDate: true, endDate: true, department: true, jobTitle: true },
    });
    return { persons, contracts };
  });

  const activeByPerson = new Map<string, boolean>();
  for (const c of people.contracts) {
    const active = c.startDate <= asOf && (c.endDate === null || c.endDate >= asOf);
    activeByPerson.set(c.personId, (activeByPerson.get(c.personId) ?? false) || active);
  }
  const personsWithActiveContract = [...activeByPerson.values()].filter(Boolean).length;

  // (2) Users — the ability to sign in to Syntra at all, with its status.
  const users = await withTenant(tenantId, (tx) =>
    tx.user.findMany({
      select: { id: true, login: true, displayName: true, email: true, status: true, personId: true, orgUnitId: true, sourceId: true, sourceAnchor: true },
    }),
  );
  const userById = new Map(users.map((u) => [u.id, u]));

  for (const user of users) {
    if (user.personId === null) continue;
    holdings.push({
      subject: { kind: 'person', personId: user.personId },
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'syntraUser',
      resourceId: user.id,
      resourceName: `${user.displayName} (${user.login}, ${user.status})`,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        ...(user.sourceId === null
          ? {}
          : { directorySources: [{ sourceId: user.sourceId, sourceName: 'directory source', anchor: user.sourceAnchor, distinguishedName: null }] }),
      },
    });
  }

  // A user with no linked person is a subject Govern cannot name. It is a gap,
  // not an omission: an account that can sign in to the identity platform and
  // belongs to nobody is exactly the row an access review exists to surface.
  for (const user of users) {
    if (user.personId !== null) continue;
    gaps.push({
      kind: 'subject_unresolvable',
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceId: user.id,
      personId: null,
      accountRef: user.id,
      reason: `the Syntra account "${user.login}" is linked to no person`,
      sourceRunId: null,
    });
  }

  // (3) Group memberships. Both synced and locally managed; the distinction
  // lives in the attribution, never in a second resource kind.
  const memberships = await withTenant(tenantId, (tx) =>
    tx.groupMembership.findMany({
      select: {
        userId: true,
        groupId: true,
        group: { select: { name: true, sourceId: true, sourceAnchor: true, source: { select: { name: true } } } },
      },
    }),
  );

  for (const m of memberships) {
    const user = userById.get(m.userId);
    // The USER must exist; the PERSON need not. A membership whose user row is
    // missing is a referential impossibility under the foreign key, and
    // guessing at it would invent a subject.
    if (user === undefined) continue;
    holdings.push({
      subject: subjectForUser(user),
      systemKind: m.group.sourceId === null ? 'syntraInternal' : 'directorySource',
      systemId: m.group.sourceId ?? SYNTRA_SYSTEM_ID,
      systemName: m.group.sourceId === null ? 'Syntra' : (m.group.source?.name ?? 'directory source'),
      resourceKind: 'syntraGroup',
      resourceId: m.groupId,
      resourceName: m.group.name,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        ...(m.group.sourceId === null
          ? {}
          : {
              directorySources: [
                {
                  sourceId: m.group.sourceId,
                  sourceName: m.group.source?.name ?? 'directory source',
                  anchor: m.group.sourceAnchor,
                  distinguishedName: m.group.sourceAnchor,
                },
              ],
            }),
      },
    });
  }

  // (4) Applications, with the path. Integration finding 2.
  const [appPaths, applications] = await withTenant(tenantId, async (tx) => [
    await resolveApplicationPaths(tx),
    await tx.application.findMany({ select: { id: true, name: true } }),
  ]);
  const appNameById = new Map(applications.map((a) => [a.id, a.name]));

  const appByUserAndApp = new Map<string, ApplicationPath[]>();
  for (const path of appPaths) {
    const key = `${path.userId}|${path.applicationId}`;
    appByUserAndApp.set(key, [...(appByUserAndApp.get(key) ?? []), path]);
  }

  for (const [key, paths] of appByUserAndApp) {
    const [userId, applicationId] = key.split('|') as [string, string];
    const user = userById.get(userId);
    // The USER must exist; the PERSON need not. A membership whose user row is
    // missing is a referential impossibility under the foreign key, and
    // guessing at it would invent a subject.
    if (user === undefined) continue;

    const directAssignments: DirectAssignmentFact[] = paths
      .filter((p) => p.via === 'user')
      .map((p) => ({
        rowType: 'AppAssignment',
        rowId: p.assignmentId,
        scopeOrgUnitId: null,
        scopeOrgUnitName: null,
        administratorName: null,
        assignedAt: null,
      }));
    const groupInheritance: GroupInheritanceFact[] = paths
      .filter((p) => p.via === 'group')
      .map((p) => ({ groupId: p.groupId!, groupName: p.groupName ?? 'a group', assignmentId: p.assignmentId }));
    const orgUnitInheritance: OrgUnitInheritanceFact[] = paths
      .filter((p) => p.via === 'orgUnit')
      .map((p) => ({
        assignmentId: p.assignmentId,
        matchedOrgUnitId: p.matchedOrgUnitId!,
        matchedOrgUnitName: p.matchedOrgUnitName ?? 'an organizational unit',
        chain: p.chain,
      }));

    holdings.push({
      subject: subjectForUser(user),
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'application',
      resourceId: applicationId,
      resourceName: appNameById.get(applicationId) ?? applicationId,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        directAssignments,
        groupInheritance,
        orgUnitInheritance,
      },
    });
  }

  // (5) Role assignments. PRIVILEGED BY DEFINITION: an access review that
  // ignores who holds `tenant.manage` has missed the most powerful access in
  // the product.
  const roleAssignments = await withTenant(tenantId, (tx) =>
    tx.roleAssignment.findMany({
      select: {
        id: true,
        userId: true,
        roleId: true,
        scopeOrgUnitId: true,
        role: { select: { name: true, permissions: true } },
      },
    }),
  );
  const orgUnitNames = await withTenant(tenantId, (tx) =>
    tx.orgUnit.findMany({ select: { id: true, name: true } }),
  );
  const orgUnitNameById = new Map(orgUnitNames.map((o) => [o.id, o.name]));

  for (const ra of roleAssignments) {
    const user = userById.get(ra.userId);
    // The USER must exist; the PERSON need not. A membership whose user row is
    // missing is a referential impossibility under the foreign key, and
    // guessing at it would invent a subject.
    if (user === undefined) continue;
    holdings.push({
      subject: subjectForUser(user),
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      systemName: 'Syntra',
      resourceKind: 'syntraRole',
      resourceId: ra.roleId,
      resourceName: `${ra.role.name} (${ra.role.permissions.join(', ')})`,
      state: 'held',
      observedAt: asOf,
      observedVia: 'syntra',
      attribution: {
        ...EMPTY_ATTRIBUTION_INPUT,
        directAssignments: [
          {
            rowType: 'RoleAssignment',
            rowId: ra.id,
            scopeOrgUnitId: ra.scopeOrgUnitId,
            scopeOrgUnitName: ra.scopeOrgUnitId === null ? null : (orgUnitNameById.get(ra.scopeOrgUnitId) ?? null),
            administratorName: null,
            assignedAt: null,
          },
        ],
      },
    });
  }

  // (6) Target accounts and entitlements, plus the entitlements that could not
  // be read at all.
  const targets = await withTenant(tenantId, (tx) =>
    tx.targetSystem.findMany({
      select: { id: true, name: true, lastRunAt: true, lastAppliedRunAt: true },
    }),
  );
  const targetNameById = new Map(targets.map((t) => [t.id, t.name]));

  const provision = await withTenant(tenantId, async (tx) => {
    const accounts = await tx.targetAccount.findMany({
      select: {
        id: true, targetSystemId: true, personId: true, anchor: true, correlationKey: true,
        status: true, lastReconciledAt: true,
      },
    });
    const holdingsRows = await tx.accountEntitlement.findMany({
      where: { state: 'held' },
      select: {
        accountId: true, entitlementId: true, origin: true, grantedByRuleId: true, grantedAt: true,
        entitlement: { select: { id: true, targetSystemId: true, displayName: true, status: true, externalId: true } },
      },
    });
    const rules = await tx.businessRule.findMany({
      select: { id: true, name: true, enabled: true, targetSystemId: true },
    });
    const unreadable = await tx.entitlement.findMany({
      where: { status: { in: ['missing', 'unreadable'] } },
      select: { id: true, targetSystemId: true, displayName: true, status: true },
    });
    return { accounts, holdingsRows, rules, unreadable };
  });

  const ruleById = new Map(provision.rules.map((r) => [r.id, r]));
  const accountById = new Map(provision.accounts.map((a) => [a.id, a]));

  for (const account of provision.accounts) {
    const observedAt = account.lastReconciledAt ?? asOf;
    holdings.push({
      subject: { kind: 'person', personId: account.personId },
      systemKind: 'targetSystem',
      systemId: account.targetSystemId,
      systemName: targetNameById.get(account.targetSystemId) ?? account.targetSystemId,
      resourceKind: 'targetAccount',
      resourceId: account.anchor ?? account.correlationKey,
      resourceName: `${account.correlationKey} (${account.status})`,
      state: account.status === 'missing_at_target' ? 'unknown' : 'held',
      observedAt,
      observedVia: `provision:${account.targetSystemId}`,
      attribution: EMPTY_ATTRIBUTION_INPUT,
    });
  }

  const grantFactsByHolding = new Map<string, RequestFact[]>();

  for (const row of provision.holdingsRows) {
    const account = accountById.get(row.accountId);
    if (account === undefined) continue;
    const observedAt = account.lastReconciledAt ?? asOf;

    const rules: RuleFact[] = [];
    const discovered: DiscoveredFact[] = [];
    const manual: ManualFact[] = [];
    if (row.origin === 'rule' && row.grantedByRuleId !== null) {
      const rule = ruleById.get(row.grantedByRuleId);
      rules.push({
        ruleId: row.grantedByRuleId,
        ruleName: rule?.name ?? 'a rule that no longer exists',
        contractId: '',
        department: null,
        jobTitle: null,
        ruleEnabled: rule?.enabled ?? false,
      });
    } else if (row.origin === 'discovered') {
      discovered.push({ firstRunId: null, discoveredAt: row.grantedAt.toISOString() });
    } else if (row.origin === 'manual') {
      manual.push({ administratorName: null, recordedAt: row.grantedAt.toISOString(), reason: null });
    }

    holdings.push({
      subject: { kind: 'person', personId: account.personId },
      systemKind: 'targetSystem',
      systemId: row.entitlement.targetSystemId,
      systemName: targetNameById.get(row.entitlement.targetSystemId) ?? row.entitlement.targetSystemId,
      resourceKind: 'targetEntitlement',
      resourceId: row.entitlementId,
      resourceName: row.entitlement.displayName,
      state: row.entitlement.status === 'unreadable' ? 'unknown' : 'held',
      observedAt,
      observedVia: `provision:${row.entitlement.targetSystemId}`,
      attribution: { ...EMPTY_ATTRIBUTION_INPUT, rules, discovered, manual },
    });

    grantFactsByHolding.set(
      `person:${account.personId}|${row.entitlement.targetSystemId}|targetEntitlement|${row.entitlementId}`,
      [],
    );
  }

  for (const entitlement of provision.unreadable) {
    gaps.push({
      kind: 'resource_unreadable',
      systemKind: 'targetSystem',
      systemId: entitlement.targetSystemId,
      resourceId: entitlement.id,
      personId: null,
      accountRef: null,
      // Nothing in the platform records WHICH run failed to read it: the only
      // signal is `Entitlement.status`, and `DriftFinding` has no matching
      // kind. Naming the target's last run and saying so is honest; implying a
      // precision the data does not have is not.
      reason:
        `"${entitlement.displayName}" is ${entitlement.status} at its target, so who holds it is unknown. ` +
        `The run named is the target's most recent run, not necessarily the run that failed the read.`,
      sourceRunId: null,
    });
  }

  // (7) Automate grants, and the request record behind each.
  const automate = await withTenant(tenantId, async (tx) => {
    const grants = await tx.accessGrant.findMany({
      where: { status: { in: [...LIVE_GRANT_STATUSES] } },
      select: {
        id: true, subjectPersonId: true, resourceType: true, resourceId: true, targetSystemId: true,
        origin: true, requestId: true, productId: true, endsAt: true, needsReview: true,
      },
    });
    const requests = await tx.accessRequest.findMany({
      where: { id: { in: grants.map((g) => g.requestId).filter((x): x is string => x !== null) } },
      select: {
        id: true, subjectPersonId: true, requestedByUserId: true, requestedByPersonId: true,
        productId: true, product: { select: { name: true } },
        steps: {
          select: {
            id: true,
            decisions: { select: { personId: true, decision: true, decidedAt: true, comment: true } },
          },
        },
      },
    });
    return { grants, requests };
  });

  const requestById = new Map(automate.requests.map((r) => [r.id, r]));
  const personNameById = new Map(
    people.persons.map((p) => [p.id, `${p.givenName} ${p.familyName}`.trim()]),
  );

  for (const grant of automate.grants) {
    const request = grant.requestId === null ? undefined : requestById.get(grant.requestId);
    const approvers = (request?.steps ?? []).flatMap((step) =>
      step.decisions.map((d) => ({
        personName: personNameById.get(d.personId) ?? 'a person no longer recorded',
        decision: d.decision,
        decidedAt: d.decidedAt.toISOString(),
        comment: d.comment,
      })),
    );

    const fact: RequestFact = {
      grantId: grant.id,
      requestId: grant.requestId,
      productId: grant.productId,
      productName: request?.product?.name ?? null,
      requesterName:
        request?.requestedByPersonId == null
          ? null
          : (personNameById.get(request.requestedByPersonId) ?? null),
      subjectName: personNameById.get(grant.subjectPersonId) ?? 'a person no longer recorded',
      approvers,
      endsAt: grant.endsAt?.toISOString() ?? null,
      origin: grant.origin === 'delegated_admin' ? 'delegated_admin' : 'request',
      // A zero-stage workflow. A legitimate configuration whose grant has no
      // approver, so it contributes no decision-graph edge and is its own class.
      autoGranted: grant.origin !== 'delegated_admin' && approvers.length === 0,
      delegateName:
        grant.origin === 'delegated_admin' && request?.requestedByPersonId != null
          ? (personNameById.get(request.requestedByPersonId) ?? null)
          : null,
      delegationCapabilities: [],
    };

    const resourceKind: ResourceKind =
      grant.resourceType === 'entitlement'
        ? 'targetEntitlement'
        : grant.resourceType === 'application'
          ? 'application'
          : 'syntraGroup';
    const systemId = grant.targetSystemId ?? SYNTRA_SYSTEM_ID;
    const holdingKey = `person:${grant.subjectPersonId}|${systemId}|${resourceKind}|${grant.resourceId}`;
    grantFactsByHolding.set(holdingKey, [...(grantFactsByHolding.get(holdingKey) ?? []), fact]);
  }

  // The union: a grant explains a holding that already exists, and creates one
  // only where the fulfilment has not yet been observed at the target.
  const holdingByKey = new Map(
    holdings.map((h) => [
      `${subjectKey(h.subject)}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
      h,
    ]),
  );
  for (const [key, facts] of grantFactsByHolding) {
    if (facts.length === 0) continue;
    const existing = holdingByKey.get(key);
    if (existing !== undefined) {
      existing.attribution = { ...existing.attribution, requests: facts };
    }
  }

  // (8) Provision's unprocessable people, from the latest run per target.
  // ProvisionException rows are per-run and cascade-delete with the run, so the
  // person, kind and message are COPIED here — a gap that dangles when a run is
  // pruned is a gap that silently closes.
  const exceptions = await withTenant(tenantId, async (tx) => {
    const latestRuns = await tx.provisionRun.findMany({
      where: { status: { in: ['applied', 'partially_applied', 'previewed'] } },
      orderBy: [{ targetSystemId: 'asc' }, { startedAt: 'desc' }],
      select: { id: true, targetSystemId: true, startedAt: true },
    });
    const newestByTarget = new Map<string, string>();
    for (const run of latestRuns) {
      if (!newestByTarget.has(run.targetSystemId)) newestByTarget.set(run.targetSystemId, run.id);
    }
    const runIds = [...newestByTarget.values()];
    if (runIds.length === 0) return [];
    return tx.provisionException.findMany({
      where: { runId: { in: runIds } },
      select: { runId: true, personId: true, targetSystemId: true, kind: true, message: true },
    });
  });

  for (const exception of exceptions) {
    gaps.push({
      kind: 'person_unprocessable',
      systemKind: 'targetSystem',
      systemId: exception.targetSystemId,
      resourceId: null,
      personId: exception.personId,
      accountRef: null,
      reason: `Provision could not fully evaluate this person: ${exception.kind} — ${exception.message}`,
      sourceRunId: exception.runId,
    });
  }

  // (9) Sources and their read history.
  const sourceRuns = await withTenant(tenantId, async (tx) => {
    const directorySources = await tx.directorySource.findMany({ select: { id: true, name: true } });
    const syncRuns = await tx.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      select: { id: true, sourceId: true, status: true, startedAt: true, finishedAt: true },
    });
    return { directorySources, syncRuns };
  });

  sources.push({
    sourceKind: 'syntraInternal',
    sourceId: SYNTRA_SYSTEM_ID,
    sourceName: 'Syntra',
    lastRunId: null,
    lastSuccessfulReadAt: asOf,
    lastAttemptedReadAt: asOf,
    completeness: 'complete',
    freshnessSlaHours: slaFor('syntraInternal', SYNTRA_SYSTEM_ID),
    gapCount: 0,
  });

  for (const source of sourceRuns.directorySources) {
    const runs = sourceRuns.syncRuns.filter((r) => r.sourceId === source.id);
    const lastOk = runs.find((r) => r.status === 'applied');
    sources.push({
      sourceKind: 'directorySource',
      sourceId: source.id,
      sourceName: source.name,
      lastRunId: lastOk?.id ?? runs[0]?.id ?? null,
      lastSuccessfulReadAt: lastOk?.finishedAt ?? null,
      lastAttemptedReadAt: runs[0]?.startedAt ?? null,
      completeness: lastOk === undefined ? 'unread' : 'complete',
      freshnessSlaHours: slaFor('directorySource', source.id),
      gapCount: 0,
    });
  }

  for (const target of targets) {
    const unreadableHere = provision.unreadable.filter((e) => e.targetSystemId === target.id).length;
    sources.push({
      sourceKind: 'targetSystem',
      sourceId: target.id,
      sourceName: target.name,
      lastRunId: null,
      lastSuccessfulReadAt: target.lastAppliedRunAt ?? target.lastRunAt,
      lastAttemptedReadAt: target.lastRunAt,
      completeness:
        target.lastAppliedRunAt === null && target.lastRunAt === null
          ? 'unread'
          : unreadableHere > 0
            ? 'partial'
            : 'complete',
      freshnessSlaHours: slaFor('targetSystem', target.id),
      gapCount: unreadableHere,
    });
  }

  const unattributedAccountKeys = [
    ...new Set(
      gaps
        .filter((g) => g.kind === 'subject_unresolvable' && g.accountRef !== null)
        .map((g) => `account:${g.systemId}:${g.accountRef}`),
    ),
  ];

  return {
    asOf,
    holdings,
    gaps,
    sources,
    personIds: people.persons.map((p) => p.id),
    personsWithActiveContract,
    unattributedAccountKeys,
    queryCount: 9,
  };
}
