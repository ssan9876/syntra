import type { AttributionKind } from './types.js';

/**
 * How somebody got each piece. Spec section 7.
 *
 * PROVENANCE IS A SET, NOT A LABEL. Provision unions across concurrent
 * contracts, Automate unions rules with grants, and a person can reach an
 * application by three paths at once. A single `origin` column would have to
 * choose, and it would choose wrong exactly in the cases that matter.
 *
 * Every attribution is resolved AS AT the snapshot's observation time, and the
 * values it copies — the rule's name, the contract's department, the approver's
 * display name — are COPIED, not referenced. A rule renamed next month must not
 * silently rewrite last quarter's evidence.
 *
 * PURE.
 */

export interface AttributionDraft {
  kind: AttributionKind;
  refType: string;
  refId: string | null;
  detail: Record<string, unknown>;
  resolvedAt: Date;
}

/** Provision's `AccountEntitlement.grantedByRuleId` plus its evaluation-time attribution. */
export interface RuleFact {
  ruleId: string;
  ruleName: string;
  contractId: string;
  department: string | null;
  jobTitle: string | null;
  /**
   * Whether the rule is enabled TODAY. A disabled rule explains how the
   * holding arrived and does not explain why it should stay, which is the
   * difference between `revocation_requires_change` and a revocation order.
   */
  ruleEnabled: boolean;
}

/** Automate's `AccessGrant` + `AccessRequest` + `ApprovalDecision`. */
export interface RequestFact {
  grantId: string;
  requestId: string | null;
  productId: string | null;
  productName: string | null;
  requesterName: string | null;
  subjectName: string;
  approvers: {
    personName: string;
    decision: string;
    decidedAt: string;
    comment: string | null;
  }[];
  endsAt: string | null;
  origin: 'request' | 'delegated_admin';
  /** A zero-stage workflow: the grant exists and no human decided. */
  autoGranted: boolean;
  delegateName: string | null;
  delegationCapabilities: string[];
}

export interface DirectAssignmentFact {
  rowType: 'AppAssignment' | 'RoleAssignment';
  rowId: string;
  scopeOrgUnitId: string | null;
  scopeOrgUnitName: string | null;
  /**
   * From the audit log, where an event names one. `AppAssignment` has no
   * `createdByUserId` and `RoleAssignment` has no `createdAt` at all, so for
   * some rows this is genuinely null and the draft says so in words.
   */
  administratorName: string | null;
  assignedAt: string | null;
}

export interface GroupInheritanceFact {
  groupId: string;
  groupName: string;
  assignmentId: string;
}

export interface OrgUnitInheritanceFact {
  assignmentId: string;
  matchedOrgUnitId: string;
  matchedOrgUnitName: string;
  /** The user's own unit first, the matched unit last. */
  chain: { orgUnitId: string; name: string }[];
}

export interface DirectorySourceFact {
  sourceId: string;
  sourceName: string;
  anchor: string | null;
  distinguishedName: string | null;
}

export interface DiscoveredFact {
  firstRunId: string | null;
  discoveredAt: string;
}

export interface ManualFact {
  administratorName: string | null;
  recordedAt: string;
  reason: string | null;
}

export interface AttributionInput {
  rules: readonly RuleFact[];
  requests: readonly RequestFact[];
  directAssignments: readonly DirectAssignmentFact[];
  groupInheritance: readonly GroupInheritanceFact[];
  orgUnitInheritance: readonly OrgUnitInheritanceFact[];
  directorySources: readonly DirectorySourceFact[];
  discovered: readonly DiscoveredFact[];
  manual: readonly ManualFact[];
}

export const EMPTY_ATTRIBUTION_INPUT: AttributionInput = {
  rules: [],
  requests: [],
  directAssignments: [],
  groupInheritance: [],
  orgUnitInheritance: [],
  directorySources: [],
  discovered: [],
  manual: [],
};
export function attributionsFor(
  input: AttributionInput,
  resolvedAt: Date,
): AttributionDraft[] {
  const drafts: AttributionDraft[] = [];

  for (const rule of input.rules) {
    drafts.push({
      kind: 'business_rule',
      refType: 'BusinessRule',
      refId: rule.ruleId,
      detail: {
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        contractId: rule.contractId,
        department: rule.department,
        jobTitle: rule.jobTitle,
        ruleEnabled: rule.ruleEnabled,
      },
      resolvedAt,
    });
  }

  for (const request of input.requests) {
    // Three kinds share one source row, and the distinction is the whole
    // point: `auto_granted` means a legitimate configuration produced access
    // NOBODY DECIDED, and section 14 treats that as its own class rather than
    // as a weak request.
    const kind: AttributionKind = request.autoGranted
      ? 'auto_granted'
      : request.origin === 'delegated_admin'
        ? 'delegated_admin'
        : 'request';

    drafts.push({
      kind,
      refType: 'AccessGrant',
      refId: request.grantId,
      detail: {
        grantId: request.grantId,
        requestId: request.requestId,
        productId: request.productId,
        productName: request.productName,
        requesterName: request.requesterName,
        subjectName: request.subjectName,
        approvers: request.approvers,
        endsAt: request.endsAt,
        ...(kind === 'auto_granted' ? { noHumanDecided: true } : {}),
        ...(kind === 'delegated_admin'
          ? {
              delegateName: request.delegateName,
              capabilities: request.delegationCapabilities,
            }
          : {}),
      },
      resolvedAt,
    });
  }

  for (const assignment of input.directAssignments) {
    drafts.push({
      kind: 'direct_assignment',
      refType: assignment.rowType,
      refId: assignment.rowId,
      detail: {
        rowType: assignment.rowType,
        rowId: assignment.rowId,
        scopeOrgUnitId: assignment.scopeOrgUnitId,
        scopeOrgUnitName: assignment.scopeOrgUnitName,
        administratorName: assignment.administratorName,
        assignedAt: assignment.assignedAt,
        // A sentence rather than a blank. A blank field reads as a missing
        // value somebody should go and find; this reads as an answer.
        ...(assignment.administratorName === null
          ? { note: 'assigned directly; no audit event records who or when' }
          : {}),
      },
      resolvedAt,
    });
  }

  for (const group of input.groupInheritance) {
    drafts.push({
      kind: 'group_inheritance',
      refType: 'Group',
      refId: group.groupId,
      detail: {
        groupId: group.groupId,
        groupName: group.groupName,
        assignmentId: group.assignmentId,
      },
      resolvedAt,
    });
  }

  for (const unit of input.orgUnitInheritance) {
    // Not merely "by org unit" but WHICH one, and the path from the user's own
    // unit up to it. It costs one array on the attribution row and it is the
    // difference between an answer and a shrug.
    drafts.push({
      kind: 'org_unit_inheritance',
      refType: 'OrgUnit',
      refId: unit.matchedOrgUnitId,
      detail: {
        assignmentId: unit.assignmentId,
        matchedOrgUnitId: unit.matchedOrgUnitId,
        matchedOrgUnitName: unit.matchedOrgUnitName,
        chain: unit.chain,
      },
      resolvedAt,
    });
  }

  for (const source of input.directorySources) {
    // The reason lies OUTSIDE Syntra, and the attribution says so: it names
    // where to go and ask.
    drafts.push({
      kind: 'directory_source',
      refType: 'DirectorySource',
      refId: source.sourceId,
      detail: {
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        anchor: source.anchor,
        distinguishedName: source.distinguishedName,
        note: 'this membership is rewritten by its source on every run; a removal here would come back',
      },
      resolvedAt,
    });
  }

  for (const discovery of input.discovered) {
    drafts.push({
      kind: 'discovered',
      refType: 'ProvisionRun',
      refId: discovery.firstRunId,
      detail: { firstRunId: discovery.firstRunId, discoveredAt: discovery.discoveredAt },
      resolvedAt,
    });
  }

  for (const entry of input.manual) {
    drafts.push({
      kind: 'manual',
      refType: 'AccountEntitlement',
      refId: null,
      detail: {
        administratorName: entry.administratorName,
        recordedAt: entry.recordedAt,
        reason: entry.reason,
      },
      resolvedAt,
    });
  }

  if (drafts.length === 0) {
    drafts.push({
      kind: 'unattributable',
      refType: 'none',
      refId: null,
      detail: {},
      resolvedAt,
    });
  }

  return drafts;
}

/**
 * The definition, exactly, because it is used as a filter in four places: the
 * unattributable register, the standing finding, the bulk-certify carve-out and
 * the revocation dispatch router.
 *
 * A holding is unattributable when its attribution set is EMPTY, or when its
 * only kinds are `discovered` and `unattributable`. Both mean the same
 * operational thing — the access exists and nothing in Syntra caused it — and a
 * filter that caught one but not the other would leave the more common half out
 * of the register it exists for.
 *
 * `manual` does NOT make a holding unattributable. Somebody in Syntra recorded
 * that the grant exists and who they are, which is a weaker record than a rule
 * or a request and is not nothing.
 */
const UNEXPLAINING_KINDS: ReadonlySet<AttributionKind> = new Set<AttributionKind>([
  'discovered',
  'unattributable',
]);

export function isUnattributable(kinds: readonly AttributionKind[]): boolean {
  return kinds.length === 0 || kinds.every((kind) => UNEXPLAINING_KINDS.has(kind));
}

/**
 * Whether anything in the set would re-create this holding if it were removed.
 *
 * A `RevocationOrder` is refused at creation when this is true: if a rule or a
 * live grant wants the holding, the honest answer is to change the rule or end
 * the grant, and that is the remediation item rather than the order.
 *
 * A DISABLED rule does not count. It explains how the holding arrived and does
 * not explain why it should stay, and treating it as live would refuse every
 * order for access a rule once granted and no longer does — which is precisely
 * the residue a campaign exists to find.
 */
export function hasLiveRuleAttribution(drafts: readonly AttributionDraft[]): boolean {
  return drafts.some(
    (d) =>
      (d.kind === 'business_rule' && d.detail['ruleEnabled'] === true) ||
      d.kind === 'request' ||
      d.kind === 'delegated_admin' ||
      d.kind === 'auto_granted',
  );
}

/** One sentence a manager can act on, for the reviewer's item and the report. */
export function summariseAttributions(drafts: readonly AttributionDraft[]): string {
  if (drafts.length === 0 || drafts.every((d) => d.kind === 'unattributable')) {
    return 'nothing in Syntra explains this access';
  }

  const parts: string[] = [];
  for (const draft of drafts) {
    switch (draft.kind) {
      case 'business_rule':
        parts.push(`the business rule "${String(draft.detail['ruleName'])}" matched their contract`);
        break;
      case 'request':
      case 'delegated_admin':
      case 'auto_granted': {
        const approvers = (draft.detail['approvers'] as { personName: string }[] | undefined) ?? [];
        parts.push(
          approvers.length > 0
            ? `a request approved by ${approvers.map((a) => a.personName).join(', ')}`
            : 'a request that no human decided',
        );
        break;
      }
      case 'direct_assignment':
        parts.push('an administrator assigned it directly in Syntra');
        break;
      case 'group_inheritance':
        parts.push(`membership of the group "${String(draft.detail['groupName'])}"`);
        break;
      case 'org_unit_inheritance':
        parts.push(
          `an assignment on the organizational unit "${String(draft.detail['matchedOrgUnitName'])}"`,
        );
        break;
      case 'directory_source':
        parts.push(`the directory source "${String(draft.detail['sourceName'])}"`);
        break;
      case 'discovered':
        parts.push('it was already present at the target when Syntra first looked');
        break;
      case 'manual':
        parts.push('an administrator recorded in Syntra that this grant exists');
        break;
      case 'unattributable':
        break;
    }
  }
  return parts.join('; ');
}
