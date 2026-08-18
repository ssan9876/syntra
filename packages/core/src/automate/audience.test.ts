import { describe, expect, it } from 'vitest';
import {
  audienceAdmits,
  audienceConditionSchema,
  evaluateAudience,
  type AudienceCondition,
  type AudienceFacts,
} from './audience.js';
import type { ConditionFacts } from '../provision/condition.js';

const contract = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': 'Analyst',
  'contract.costCentre': 'CC-100',
  'contract.employer': 'Acme Care',
  'contract.location': 'Utrecht',
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

const facts = (over: Partial<AudienceFacts> = {}): AudienceFacts => ({
  contract: contract(),
  groupIds: ['group-finance'],
  orgUnitChainIds: ['ou-finance', 'ou-head-office'],
  entitlementIds: ['ent-base-licence'],
  ...over,
});

describe('evaluateAudience — the seven fields Provision already knows', () => {
  it('delegates a contract leaf to the shared evaluator, trimming and folding case', () => {
    // Not reimplemented here. The expression that decides who SEES a product
    // and the one that decides who GETS birthright access compare strings the
    // same way, or a tenant learns two languages.
    const condition: AudienceCondition = {
      field: 'contract.department',
      op: 'equals',
      value: 'finance',
    };
    expect(evaluateAudience(condition, facts())).toBe(true);
    expect(
      evaluateAudience(
        condition,
        facts({ contract: contract({ 'contract.department': '  FINANCE  ' }) }),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        condition,
        facts({ contract: contract({ 'contract.department': 'Facilities' }) }),
      ),
    ).toBe(false);
  });

  it('compares fte numerically through the shared evaluator', () => {
    expect(
      evaluateAudience(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ contract: contract({ 'contract.fte': 0.4 }) }),
      ),
    ).toBe(true);
  });
});

describe('evaluateAudience — the three fields the catalog adds', () => {
  it('matches a group the subject belongs to, and does not match one they do not', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-finance' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-payroll' },
        facts(),
      ),
    ).toBe(false);
  });

  it('matches an org unit above the subject, not only their own', () => {
    // An assignment on Head Office reaches everyone under it; that is what
    // makes the tree worth having. The chain is supplied already walked.
    expect(
      evaluateAudience(
        { field: 'user.orgUnit', op: 'equals', value: 'ou-head-office' },
        facts(),
      ),
    ).toBe(true);
  });

  it('matches an entitlement the subject already holds', () => {
    // The common real case: a product that only makes sense to somebody who
    // already holds the base licence. Without it, tenants express that as a
    // department list that drifts.
    expect(
      evaluateAudience(
        { field: 'person.hasEntitlement', op: 'equals', value: 'ent-base-licence' },
        facts(),
      ),
    ).toBe(true);
  });

  it('reads in as any-of and notIn as none-of over the whole set', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'in', value: ['group-payroll', 'group-finance'] },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'notIn', value: ['group-finance'] },
        facts(),
      ),
    ).toBe(false);
    expect(
      evaluateAudience(
        { field: 'person.hasEntitlement', op: 'notEquals', value: 'ent-other' },
        facts(),
      ),
    ).toBe(true);
  });

  it('does not match a set field against an empty set', () => {
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'equals', value: 'group-finance' },
        facts({ groupIds: [] }),
      ),
    ).toBe(false);
    // notEquals over an empty set is vacuously true: the subject is in no
    // group, so they are in no group named here.
    expect(
      evaluateAudience(
        { field: 'user.memberOfGroup', op: 'notEquals', value: 'group-finance' },
        facts({ groupIds: [] }),
      ),
    ).toBe(true);
  });
});

describe('evaluateAudience — combinators', () => {
  it('treats an empty all as true and an empty any as false', () => {
    // `{ all: [] }` is how a product genuinely meant for everybody says so.
    // It is a deliberate keystroke, not an omission.
    expect(evaluateAudience({ all: [] }, facts())).toBe(true);
    expect(evaluateAudience({ any: [] }, facts())).toBe(false);
  });

  it('mixes contract fields and set fields inside one expression', () => {
    const condition: AudienceCondition = {
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { field: 'person.hasEntitlement', op: 'equals', value: 'ent-base-licence' },
        { not: { field: 'user.memberOfGroup', op: 'equals', value: 'group-contractors' } },
      ],
    };
    expect(evaluateAudience(condition, facts())).toBe(true);
    expect(
      evaluateAudience(condition, facts({ groupIds: ['group-contractors'] })),
    ).toBe(false);
  });
});

describe('audienceAdmits', () => {
  const sets = { groupIds: ['group-finance'], orgUnitChainIds: [], entitlementIds: [] };

  it('admits nobody when the condition is null', () => {
    // THE security default of this slice. An unconfigured access control
    // reads as "nobody", and a catalog listing things you may not have
    // describes the organization to you.
    expect(audienceAdmits(null, [contract()], sets)).toBe(false);
    // Not even with `{ all: [] }`-shaped facts, and not even for somebody who
    // would match everything. Null is null.
    expect(audienceAdmits(null, [contract(), contract()], sets)).toBe(false);
  });

  it('admits anybody with an active contract when the condition is an empty all', () => {
    expect(audienceAdmits({ all: [] }, [contract()], sets)).toBe(true);
  });

  it('admits nobody with no active contracts, even for an empty all', () => {
    // "Any of the person's currently ACTIVE contracts satisfies it" is
    // vacuously false when there are none. A leaver does not keep seeing the
    // catalog because the condition was permissive.
    expect(audienceAdmits({ all: [] }, [], sets)).toBe(false);
  });

  it('admits when ANY active contract satisfies the condition', () => {
    const condition: AudienceCondition = {
      field: 'contract.department',
      op: 'equals',
      value: 'Facilities',
    };
    expect(
      audienceAdmits(
        condition,
        [contract(), contract({ 'contract.department': 'Facilities' })],
        sets,
      ),
    ).toBe(true);
  });
});

describe('audienceConditionSchema', () => {
  it('accepts every one of the ten fields', () => {
    for (const field of [
      'contract.department',
      'contract.jobTitle',
      'contract.costCentre',
      'contract.employer',
      'contract.location',
      'contract.fte',
      'person.status',
      'user.memberOfGroup',
      'user.orgUnit',
      'person.hasEntitlement',
    ]) {
      expect(
        audienceConditionSchema.safeParse({ field, op: 'equals', value: 'x' }).success,
      ).toBe(true);
    }
  });

  it('refuses a field outside the closed set', () => {
    expect(
      audienceConditionSchema.safeParse({
        field: 'person.salary',
        op: 'greaterThan',
        value: 100000,
      }).success,
    ).toBe(false);
  });

  it('refuses an operator that means nothing over a set field', () => {
    // `startsWith` over a list of opaque ids would match on a prefix of a
    // UUID, which is a coincidence rather than a rule.
    expect(
      audienceConditionSchema.safeParse({
        field: 'user.memberOfGroup',
        op: 'startsWith',
        value: 'group-',
      }).success,
    ).toBe(false);
  });

  it('refuses a leaf with no value where the operator needs one', () => {
    expect(
      audienceConditionSchema.safeParse({ field: 'contract.department', op: 'equals' })
        .success,
    ).toBe(false);
    expect(
      audienceConditionSchema.safeParse({ field: 'contract.department', op: 'isEmpty' })
        .success,
    ).toBe(true);
  });

  it('parses a nested expression to the same shape it was given', () => {
    const condition = {
      any: [
        { all: [{ field: 'contract.location', op: 'in', value: ['Utrecht', 'Delft'] }] },
        { not: { field: 'person.status', op: 'equals', value: 'inactive' } },
      ],
    };
    expect(audienceConditionSchema.parse(condition)).toEqual(condition);
  });
});
