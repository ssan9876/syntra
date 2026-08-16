import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELDS,
  conditionSchema,
  evaluateCondition,
  type Condition,
  type ConditionFacts,
} from './condition.js';

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  'contract.department': 'Finance',
  'contract.jobTitle': 'Analyst',
  'contract.costCentre': 'CC-100',
  'contract.employer': 'Acme Care',
  'contract.location': 'Utrecht',
  'contract.fte': 1,
  'person.status': 'active',
  ...over,
});

describe('evaluateCondition — leaf operators', () => {
  it('matches equals case-insensitively and trimming whitespace', () => {
    // HR data is typed by humans and "Finance " and "finance" are the same
    // department. A rule that misses because of a trailing space is a rule
    // that silently strips access.
    const condition: Condition = {
      field: 'contract.department',
      op: 'equals',
      value: 'finance',
    };
    expect(evaluateCondition(condition, facts())).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': '  FINANCE  ' })),
    ).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': 'Facilities' })),
    ).toBe(false);
  });

  it('notEquals is the negation of equals, including on null', () => {
    const condition: Condition = {
      field: 'contract.department',
      op: 'notEquals',
      value: 'finance',
    };
    expect(evaluateCondition(condition, facts())).toBe(false);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': 'Facilities' })),
    ).toBe(true);
    expect(
      evaluateCondition(condition, facts({ 'contract.department': null })),
    ).toBe(true);
  });

  it('in and notIn compare against a list, case-insensitively', () => {
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'in', value: ['UTRECHT', 'Delft'] },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'notIn', value: ['Delft'] },
        facts(),
      ),
    ).toBe(true);
  });

  it('startsWith and contains are case-insensitive and trimmed', () => {
    expect(
      evaluateCondition(
        { field: 'contract.costCentre', op: 'startsWith', value: 'cc-' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: 'naly' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: 'manager' },
        facts(),
      ),
    ).toBe(false);
    // The needle is normalised too, not only the fact. Without these two the
    // test cannot tell a normalised needle from an unnormalised one — 'cc-'
    // and 'naly' are already lower case and already trimmed, so they match
    // either way, and the property in this test's name goes untested.
    expect(
      evaluateCondition(
        { field: 'contract.costCentre', op: 'startsWith', value: '  CC-  ' },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: ' NALY ' },
        facts(),
      ),
    ).toBe(true);
  });

  it('distinguishes isEmpty on null from isEmpty on an empty string', () => {
    // Both are empty, and both must read as empty. A rule written to catch
    // "no department recorded" has to catch the import that wrote "" as well
    // as the one that wrote nothing.
    const isEmpty: Condition = { field: 'contract.department', op: 'isEmpty' };
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': null }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': '' }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts({ 'contract.department': '   ' }))).toBe(true);
    expect(evaluateCondition(isEmpty, facts())).toBe(false);
  });

  it('isNotEmpty is the negation of isEmpty', () => {
    const isNotEmpty: Condition = { field: 'contract.jobTitle', op: 'isNotEmpty' };
    expect(evaluateCondition(isNotEmpty, facts())).toBe(true);
    expect(evaluateCondition(isNotEmpty, facts({ 'contract.jobTitle': '' }))).toBe(false);
  });

  it('greaterThan and lessThan apply to fte and compare numerically', () => {
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': 0.6 }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ 'contract.fte': 0.4 }),
      ),
    ).toBe(true);
    // Not lexicographic: "0.9" < "1" as strings would be wrong here.
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.9 },
        facts({ 'contract.fte': 1 }),
      ),
    ).toBe(true);
  });

  it('does not match a numeric comparison against a null fte', () => {
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
  });

  it('matches person.status as well as contract fields', () => {
    expect(
      evaluateCondition({ field: 'person.status', op: 'equals', value: 'active' }, facts()),
    ).toBe(true);
  });
});

describe('evaluateCondition — combinators', () => {
  it('treats an empty all as true', () => {
    // This is how a birthright rule matching everybody with any active
    // contract is expressed, without a special case anywhere else.
    expect(evaluateCondition({ all: [] }, facts())).toBe(true);
  });

  it('treats an empty any as false', () => {
    expect(evaluateCondition({ any: [] }, facts())).toBe(false);
  });

  it('requires every member of all', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'contract.department', op: 'equals', value: 'Finance' },
            { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
          ],
        },
        facts(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'contract.department', op: 'equals', value: 'Finance' },
            { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
          ],
        },
        facts({ 'contract.fte': 0.2 }),
      ),
    ).toBe(false);
  });

  it('requires one member of any', () => {
    expect(
      evaluateCondition(
        {
          any: [
            { field: 'contract.department', op: 'equals', value: 'Facilities' },
            { field: 'contract.location', op: 'equals', value: 'Utrecht' },
          ],
        },
        facts(),
      ),
    ).toBe(true);
  });

  it('negates with not, and nests to arbitrary depth', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { not: { field: 'contract.department', op: 'equals', value: 'Facilities' } },
            {
              any: [
                { field: 'contract.jobTitle', op: 'contains', value: 'analyst' },
                { field: 'contract.jobTitle', op: 'contains', value: 'controller' },
              ],
            },
          ],
        },
        facts(),
      ),
    ).toBe(true);
  });
});

describe('conditionSchema', () => {
  it('accepts a nested condition and returns it typed', () => {
    const parsed = conditionSchema.parse({
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { not: { field: 'contract.fte', op: 'lessThan', value: 0.5 } },
      ],
    });
    expect(parsed).toEqual({
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { not: { field: 'contract.fte', op: 'lessThan', value: 0.5 } },
      ],
    });
  });

  it('accepts every field in the closed set, and the facts cover all of them', () => {
    // The complement of the refusals below, and the one nothing else checks:
    // a field quietly dropped from the set breaks live rules that name it,
    // and every other test in this file uses contract.department or
    // contract.fte, so five of the seven would go unmentioned.
    for (const field of CONDITION_FIELDS) {
      expect(conditionSchema.parse({ field, op: 'isEmpty' })).toEqual({ field, op: 'isEmpty' });
      // …and the evaluator can read each of them: the fixture populates all
      // seven, so isEmpty is false for each. A field with no entry in
      // ConditionFacts would read `undefined`, which is neither null nor a
      // string, and would come back isNotEmpty — a fail-open.
      expect(evaluateCondition({ field, op: 'isEmpty' }, facts())).toBe(false);
      expect(evaluateCondition({ field, op: 'isNotEmpty' }, facts())).toBe(true);
    }
    expect(Object.keys(facts()).sort()).toEqual([...CONDITION_FIELDS].sort());
  });

  it('accepts an in with a single member', () => {
    // The commonest shape there is, and the boundary of the `.min(1)` above.
    expect(
      conditionSchema.parse({ field: 'contract.location', op: 'in', value: ['Utrecht'] }),
    ).toEqual({ field: 'contract.location', op: 'in', value: ['Utrecht'] });
  });

  it('refuses a field outside the closed set', () => {
    // The closed field set is the point. A rule that decides access must be
    // readable by somebody who did not write it, diffable, and evaluable in a
    // unit test without a runtime.
    expect(() =>
      conditionSchema.parse({ field: 'contract.salary', op: 'greaterThan', value: 1 }),
    ).toThrow();
    // The line above is refused by the numeric arm's `z.literal('contract.fte')`
    // and would still be refused with the field enum thrown wide open, so on
    // its own it does not test the closed field set at all. These two reach
    // the arms that actually use the enum.
    expect(() =>
      conditionSchema.parse({ field: 'contract.salary', op: 'equals', value: 'x' }),
    ).toThrow();
    expect(() => conditionSchema.parse({ field: 'contract.salary', op: 'isEmpty' })).toThrow();
  });

  it('refuses an operator outside the closed set', () => {
    // Notably `regex`. It is the operator everybody asks for and it brings
    // catastrophic backtracking into the code path that decides who has
    // access, on patterns typed by administrators.
    expect(() =>
      conditionSchema.parse({ field: 'contract.jobTitle', op: 'regex', value: '^a.*' }),
    ).toThrow();
  });

  it('refuses greaterThan on a string field', () => {
    // greaterThan and lessThan apply only to contract.fte.
    expect(() =>
      conditionSchema.parse({
        field: 'contract.department',
        op: 'greaterThan',
        value: 3,
      }),
    ).toThrow();
  });

  it('refuses a leaf that carries no value where one is required', () => {
    expect(() =>
      conditionSchema.parse({ field: 'contract.department', op: 'equals' }),
    ).toThrow();
  });

  it('refuses a value on isEmpty', () => {
    expect(() =>
      conditionSchema.parse({
        field: 'contract.department',
        op: 'isEmpty',
        value: 'x',
      }),
    ).toThrow();
  });

  it('refuses an in with an empty list', () => {
    // An `in` over nothing matches nobody, which is almost certainly not what
    // was meant and is indistinguishable from a rule that was never finished.
    expect(() =>
      conditionSchema.parse({ field: 'contract.location', op: 'in', value: [] }),
    ).toThrow();
  });

  it('refuses a blank comparison value', () => {
    // The other half of the empty-`in` argument, and the more expensive half.
    // `contains ''` and `startsWith ''` are true of every value including a
    // missing one, so a half-typed rule would grant an account in a system
    // Syntra does not own to every person in the tenant.
    expect(() =>
      conditionSchema.parse({ field: 'contract.jobTitle', op: 'contains', value: '' }),
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ field: 'contract.jobTitle', op: 'startsWith', value: '   ' }),
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ field: 'contract.department', op: 'equals', value: '' }),
    ).toThrow();
  });

  it('refuses a blank member inside an in list', () => {
    expect(() =>
      conditionSchema.parse({
        field: 'contract.location',
        op: 'in',
        value: ['Utrecht', ''],
      }),
    ).toThrow();
  });

  it('refuses a numeric operator carrying a string value', () => {
    // "0.9" < "1" as strings is false; as numbers it is true. A stored rule
    // whose threshold arrived as a string must not reach the evaluator.
    expect(() =>
      conditionSchema.parse({ field: 'contract.fte', op: 'lessThan', value: '0.5' }),
    ).toThrow();
  });

  it('refuses an unknown key on a leaf', () => {
    // Same argument as the stray `value` on isEmpty, one arm over: without
    // `.strict()` Zod strips the key and the rule parses as something its
    // author did not write. `values` for `value` is the typo that produces it.
    expect(() =>
      conditionSchema.parse({
        field: 'contract.department',
        op: 'equals',
        value: 'Finance',
        values: ['Finance', 'Facilities'],
      }),
    ).toThrow();
    expect(() =>
      conditionSchema.parse({
        field: 'contract.location',
        op: 'in',
        value: ['Utrecht'],
        not: { field: 'contract.department', op: 'isEmpty' },
      }),
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ field: 'contract.fte', op: 'lessThan', value: 0.5, unit: 'hours' }),
    ).toThrow();
  });

  it('refuses a combinator carrying a second combinator key', () => {
    // `.strict()` on the branches, not only the leaves. Without it Zod strips
    // `any` and the rule parses as `{ all: [] }` — which matches everybody,
    // rather than as the intersection its author wrote.
    expect(() => conditionSchema.parse({ all: [], any: [] })).toThrow();
    expect(() =>
      conditionSchema.parse({
        not: { field: 'contract.department', op: 'isEmpty' },
        all: [],
      }),
    ).toThrow();
  });
});

describe('evaluateCondition — the cases that decide which way a doubt falls', () => {
  it('does not match either ordering against a null fte', () => {
    // Deliberately not complements. "Is nothing greater than 0.5" has no
    // answer, and every rule in this language grants, so an untestable
    // threshold declines to fire in both directions.
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
    // A negative threshold, because JavaScript coerces null to 0 in a
    // relational comparison: `null > 0.5` is false by accident, and only
    // `null > -1` — which is TRUE without the typeof guard — shows whether the
    // guard is doing the work or the arithmetic is covering for its absence.
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: -1 },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
  });

  it('excludes the threshold itself from both orderings', () => {
    // Strict comparisons. "fte greaterThan 0.5" written to mean "at least a
    // half-time contract" would exclude the half-timers, so the boundary is
    // the assertion that says which reading this is.
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        facts({ 'contract.fte': 0.5 }),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'lessThan', value: 0.5 },
        facts({ 'contract.fte': 0.5 }),
      ),
    ).toBe(false);
  });

  it('reads a missing value and an empty one identically, for every operator', () => {
    // The design in one assertion: a missing fact is normalised to the empty
    // string, so it is a value rather than an error, and that is why nothing
    // in this language except an ordering is undecidable.
    const conditions: Condition[] = [
      { field: 'contract.department', op: 'equals', value: 'n' },
      { field: 'contract.department', op: 'notEquals', value: 'n' },
      { field: 'contract.department', op: 'in', value: ['n'] },
      { field: 'contract.department', op: 'notIn', value: ['n'] },
      { field: 'contract.department', op: 'startsWith', value: 'n' },
      { field: 'contract.department', op: 'contains', value: 'n' },
      { field: 'contract.department', op: 'isEmpty' },
      { field: 'contract.department', op: 'isNotEmpty' },
    ];
    for (const condition of conditions) {
      expect(
        evaluateCondition(condition, facts({ 'contract.department': null })),
        `${JSON.stringify(condition)} disagreed between null and ''`,
      ).toBe(evaluateCondition(condition, facts({ 'contract.department': '' })));
    }
    // …and pinned, so that "identical" cannot become "identically wrong".
    expect(
      evaluateCondition(
        { field: 'contract.department', op: 'contains', value: 'n' },
        facts({ 'contract.department': null }),
      ),
    ).toBe(false);
  });

  it('negates an untestable ordering to true, which is the documented trap', () => {
    // `not` is exact negation, so this matches a contract with no fte. The
    // spelling that means "has an fte and it is not above 0.5" is the `all`
    // below, and the two are deliberately different rules.
    expect(
      evaluateCondition(
        { not: { field: 'contract.fte', op: 'greaterThan', value: 0.5 } },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'contract.fte', op: 'isNotEmpty' },
            { not: { field: 'contract.fte', op: 'greaterThan', value: 0.5 } },
          ],
        },
        facts({ 'contract.fte': null }),
      ),
    ).toBe(false);
  });

  it('treats an fte of zero as recorded rather than empty', () => {
    // 0 is a real fte — an unpaid or suspended engagement — not a missing one.
    expect(
      evaluateCondition({ field: 'contract.fte', op: 'isEmpty' }, facts({ 'contract.fte': 0 })),
    ).toBe(false);
    expect(
      evaluateCondition({ field: 'contract.fte', op: 'isNotEmpty' }, facts({ 'contract.fte': 0 })),
    ).toBe(true);
  });

  it('notIn matches a contract with nothing recorded, as !in', () => {
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'notIn', value: ['Utrecht'] },
        facts({ 'contract.location': null }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.location', op: 'in', value: ['Utrecht'] },
        facts({ 'contract.location': null }),
      ),
    ).toBe(false);
  });

  it('compares a numeric fact as text when a string operator names it', () => {
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'equals', value: '0.8' },
        facts({ 'contract.fte': 0.8 }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'contract.fte', op: 'equals', value: '0.8' },
        facts({ 'contract.fte': 0.5 }),
      ),
    ).toBe(false);
  });

  it('refuses to match on a blank needle even when one reaches the evaluator', () => {
    // conditionSchema will not store one. This is the backstop for a
    // `condition` column written before that check existed or by some other
    // route: `''.includes('')` is true of everybody, and everybody getting an
    // account in a system Syntra does not own is the expensive direction.
    expect(
      evaluateCondition({ field: 'contract.jobTitle', op: 'contains', value: '' }, facts()),
    ).toBe(false);
    expect(
      evaluateCondition({ field: 'contract.jobTitle', op: 'startsWith', value: '  ' }, facts()),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: 'contract.jobTitle', op: 'contains', value: '' },
        facts({ 'contract.jobTitle': null }),
      ),
    ).toBe(false);
  });
});
