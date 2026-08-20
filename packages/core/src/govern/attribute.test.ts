import { describe, expect, it } from 'vitest';
import {
  EMPTY_ATTRIBUTION_INPUT,
  attributionsFor,
  hasLiveRuleAttribution,
  isUnattributable,
  summariseAttributions,
  type AttributionInput,
} from './attribute.js';

const AT = new Date('2026-06-15T09:00:00Z');

const input = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  ...EMPTY_ATTRIBUTION_INPUT,
  ...over,
});

const rule = {
  ruleId: 'rule-finance',
  ruleName: 'Finance staff',
  contractId: 'contract-2',
  department: 'Onderwijs',
  jobTitle: 'Docent',
  ruleEnabled: true,
};

const request = {
  grantId: 'grant-1',
  requestId: 'req-1',
  productId: 'prod-1',
  productName: 'Finance payments',
  requesterName: 'Anna Novak',
  subjectName: 'Anna Novak',
  approvers: [
    { personName: 'Jan de Vries', decision: 'approve', decidedAt: '2026-03-04T10:00:00Z', comment: null },
  ],
  endsAt: '2026-06-30T00:00:00Z',
  origin: 'request' as const,
  autoGranted: false,
  delegateName: null,
  delegationCapabilities: [],
};

describe('the attribution set is a set', () => {
  it('carries a rule and a request together, not one of them', () => {
    // The case the design names: Anna holds Finance-Payments because the rule
    // matched her 0.4 FTE teaching contract AND because she requested it in
    // March and Jan approved it until 30 June. A single `origin` column would
    // have to pick, and would pick wrong exactly here.
    const drafts = attributionsFor(input({ rules: [rule], requests: [request] }), AT);
    expect(drafts.map((d) => d.kind).sort()).toEqual(['business_rule', 'request']);
  });

  it('carries one attribution per concurrent contract that satisfied the rule', () => {
    const drafts = attributionsFor(
      input({
        rules: [rule, { ...rule, contractId: 'contract-3', jobTitle: 'Onderzoeker' }],
      }),
      AT,
    );
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.detail['contractId'])).toEqual(['contract-2', 'contract-3']);
  });

  it('copies the rule name and the contract attributes rather than referencing them', () => {
    // A rule renamed next month must not silently rewrite last quarter's
    // evidence, and an approver who leaves must still have a name in the record
    // of what they approved.
    const [draft] = attributionsFor(input({ rules: [rule] }), AT);
    expect(draft!.detail).toMatchObject({
      ruleName: 'Finance staff',
      department: 'Onderwijs',
      jobTitle: 'Docent',
    });
    expect(draft!.resolvedAt).toEqual(AT);
  });

  it('copies every approver and their decision into the request attribution', () => {
    const [draft] = attributionsFor(input({ requests: [request] }), AT);
    expect(draft!.detail['approvers']).toEqual([
      { personName: 'Jan de Vries', decision: 'approve', decidedAt: '2026-03-04T10:00:00Z', comment: null },
    ]);
    expect(draft!.detail['endsAt']).toBe('2026-06-30T00:00:00Z');
  });

  it('marks a zero-stage grant auto_granted and says no human decided', () => {
    const [draft] = attributionsFor(
      input({ requests: [{ ...request, approvers: [], autoGranted: true }] }),
      AT,
    );
    expect(draft!.kind).toBe('auto_granted');
    expect(draft!.detail['noHumanDecided']).toBe(true);
  });

  it('marks a delegated administrative grant delegated_admin and names the delegate', () => {
    const [draft] = attributionsFor(
      input({
        requests: [
          {
            ...request,
            origin: 'delegated_admin',
            approvers: [],
            delegateName: 'Team lead',
            delegationCapabilities: ['grant', 'revoke'],
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('delegated_admin');
    expect(draft!.detail).toMatchObject({
      delegateName: 'Team lead',
      capabilities: ['grant', 'revoke'],
    });
  });
});

describe('the three application paths', () => {
  it('records a direct assignment with its administrator when the audit log names one', () => {
    const [draft] = attributionsFor(
      input({
        directAssignments: [
          {
            rowType: 'AppAssignment',
            rowId: 'assign-1',
            scopeOrgUnitId: null,
            scopeOrgUnitName: null,
            administratorName: 'Sam Admin',
            assignedAt: '2026-01-04T12:00:00Z',
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('direct_assignment');
    expect(draft!.detail['administratorName']).toBe('Sam Admin');
  });

  it('says in words that nobody is recorded, rather than emitting a blank', () => {
    // AppAssignment has no createdByUserId and RoleAssignment has no createdAt
    // at all, so for some rows there is genuinely nothing to say. A blank field
    // reads as a missing value somebody should go and find; a sentence reads as
    // an answer.
    const [draft] = attributionsFor(
      input({
        directAssignments: [
          {
            rowType: 'RoleAssignment',
            rowId: 'ra-1',
            scopeOrgUnitId: 'ou-9',
            scopeOrgUnitName: 'Head Office',
            administratorName: null,
            assignedAt: null,
          },
        ],
      }),
      AT,
    );
    expect(draft!.detail['administratorName']).toBeNull();
    expect(draft!.detail['note']).toBe(
      'assigned directly; no audit event records who or when',
    );
    expect(draft!.detail['scopeOrgUnitName']).toBe('Head Office');
  });

  it('records the group that carried the assignment', () => {
    const [draft] = attributionsFor(
      input({ groupInheritance: [{ groupId: 'g-1', groupName: 'Finance', assignmentId: 'a-1' }] }),
      AT,
    );
    expect(draft!.kind).toBe('group_inheritance');
    expect(draft!.detail).toMatchObject({ groupName: 'Finance' });
  });

  it('records WHICH org unit produced the match and the chain up to it', () => {
    // This is the provenance question the brief singles out and the one nobody
    // expects. "By org unit" is a shrug; "by Head Office, two levels above
    // Care, which is where your user sits" is an answer.
    const [draft] = attributionsFor(
      input({
        orgUnitInheritance: [
          {
            assignmentId: 'a-2',
            matchedOrgUnitId: 'ou-root',
            matchedOrgUnitName: 'Head Office',
            chain: [
              { orgUnitId: 'ou-care', name: 'Care' },
              { orgUnitId: 'ou-region', name: 'North region' },
              { orgUnitId: 'ou-root', name: 'Head Office' },
            ],
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('org_unit_inheritance');
    expect(draft!.detail['matchedOrgUnitName']).toBe('Head Office');
    expect(draft!.detail['chain']).toHaveLength(3);
    expect((draft!.detail['chain'] as { name: string }[])[0]!.name).toBe('Care');
  });

  it('carries all three at once when all three apply', () => {
    const drafts = attributionsFor(
      input({
        directAssignments: [
          { rowType: 'AppAssignment', rowId: 'a-1', scopeOrgUnitId: null, scopeOrgUnitName: null, administratorName: null, assignedAt: null },
        ],
        groupInheritance: [{ groupId: 'g-1', groupName: 'Finance', assignmentId: 'a-2' }],
        orgUnitInheritance: [
          { assignmentId: 'a-3', matchedOrgUnitId: 'ou-1', matchedOrgUnitName: 'HQ', chain: [{ orgUnitId: 'ou-1', name: 'HQ' }] },
        ],
      }),
      AT,
    );
    expect(drafts.map((d) => d.kind).sort()).toEqual([
      'direct_assignment',
      'group_inheritance',
      'org_unit_inheritance',
    ]);
  });
});

describe('the reason that lies outside Syntra', () => {
  it('names the source and the distinguished name so somebody knows where to go and ask', () => {
    const [draft] = attributionsFor(
      input({
        directorySources: [
          {
            sourceId: 'src-1',
            sourceName: 'Acme AD',
            anchor: 'objectguid-1',
            distinguishedName: 'CN=Anna,OU=Users,DC=acme,DC=test',
          },
        ],
      }),
      AT,
    );
    expect(draft!.kind).toBe('directory_source');
    expect(draft!.detail).toMatchObject({
      sourceName: 'Acme AD',
      distinguishedName: 'CN=Anna,OU=Users,DC=acme,DC=test',
    });
  });
});

describe('the unattributable definition', () => {
  it('is unattributable on an EMPTY set', () => {
    // The empty case is the dangerous case here, and it must be true.
    expect(isUnattributable([])).toBe(true);
  });

  it('is unattributable on `discovered` alone', () => {
    expect(isUnattributable(['discovered'])).toBe(true);
  });

  it('is unattributable on `unattributable` alone', () => {
    expect(isUnattributable(['unattributable'])).toBe(true);
  });

  it('is unattributable on `discovered` and `unattributable` together', () => {
    expect(isUnattributable(['discovered', 'unattributable'])).toBe(true);
  });

  it('is NOT unattributable on `manual`', () => {
    // Somebody in Syntra recorded that the grant exists and who they are.
    // Weaker than a rule or a request; not nothing.
    expect(isUnattributable(['manual'])).toBe(false);
  });

  it('is NOT unattributable when `discovered` sits beside `manual`', () => {
    expect(isUnattributable(['discovered', 'manual'])).toBe(false);
  });

  it('is NOT unattributable for a rule or a request', () => {
    expect(isUnattributable(['business_rule'])).toBe(false);
    expect(isUnattributable(['request'])).toBe(false);
    expect(isUnattributable(['auto_granted'])).toBe(false);
  });

  it('emits an explicit `unattributable` draft when nothing else resolved', () => {
    const drafts = attributionsFor(input(), AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'unattributable', refId: null });
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(true);
  });

  it('classifies a `discovered` holding as unattributable through the real pipeline', () => {
    const drafts = attributionsFor(
      input({ discovered: [{ firstRunId: 'run-3', discoveredAt: '2024-02-01T00:00:00Z' }] }),
      AT,
    );
    expect(drafts.map((d) => d.kind)).toEqual(['discovered']);
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(true);
  });

  it('does not classify a `manual` holding as unattributable through the real pipeline', () => {
    const drafts = attributionsFor(
      input({ manual: [{ administratorName: 'Sam', recordedAt: '2025-05-05T00:00:00Z', reason: 'leaver cover' }] }),
      AT,
    );
    expect(isUnattributable(drafts.map((d) => d.kind))).toBe(false);
  });
});

describe('hasLiveRuleAttribution — the RevocationOrder refusal', () => {
  it('is true for an enabled rule', () => {
    expect(hasLiveRuleAttribution(attributionsFor(input({ rules: [rule] }), AT))).toBe(true);
  });

  it('is FALSE for a disabled rule, which no longer wants the holding', () => {
    // A disabled rule explains how the holding arrived and does not explain why
    // it should stay. Treating it as live would refuse every RevocationOrder
    // for access a rule once granted and no longer does — which is precisely
    // the hand-granted residue a campaign exists to find.
    expect(
      hasLiveRuleAttribution(attributionsFor(input({ rules: [{ ...rule, ruleEnabled: false }] }), AT)),
    ).toBe(false);
  });

  it('is true for a live grant, which is also something that would re-create it', () => {
    expect(hasLiveRuleAttribution(attributionsFor(input({ requests: [request] }), AT))).toBe(true);
  });
});

describe('summariseAttributions', () => {
  it('reads as a sentence a manager can act on', () => {
    const summary = summariseAttributions(
      attributionsFor(input({ rules: [rule], requests: [request] }), AT),
    );
    expect(summary).toContain('Finance staff');
    expect(summary).toContain('Jan de Vries');
  });

  it('says plainly that nothing explains it', () => {
    expect(summariseAttributions(attributionsFor(input(), AT))).toBe(
      'nothing in Syntra explains this access',
    );
  });
});
