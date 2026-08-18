import { z } from 'zod';

/**
 * The closed field set. Rules decide who gets access, so what they can look
 * at is fixed in code rather than open to whatever an administrator types.
 */
export const CONDITION_FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

/**
 * The closed operator set.
 *
 * Regular-expression matching is deliberately absent. It is the operator
 * everybody asks for and it brings catastrophic backtracking into the code
 * path that decides who has access, on patterns typed by administrators. The
 * cases this set does not cover are usually a request for a cleaner HR field.
 */
export const CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'notIn',
  'startsWith',
  'contains',
  'isEmpty',
  'isNotEmpty',
  'greaterThan',
  'lessThan',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** The only field the numeric operators may be applied to. */
const NUMERIC_FIELD = 'contract.fte';
export type NumericConditionField = typeof NUMERIC_FIELD;

/**
 * The numeric leaf is typed to `contract.fte` alone, matching what the schema
 * accepts. The two must agree: a `Condition` value constructed in TypeScript
 * never reaches `conditionSchema`, so a type that permitted
 * `{ field: 'contract.department', op: 'greaterThan' }` would let code express
 * a rule the stored form cannot represent and the evaluator answers `false`
 * to for every person alive.
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: ConditionField; op: 'equals' | 'notEquals' | 'startsWith' | 'contains'; value: string }
  | { field: ConditionField; op: 'in' | 'notIn'; value: string[] }
  | { field: ConditionField; op: 'isEmpty' | 'isNotEmpty' }
  | { field: NumericConditionField; op: 'greaterThan' | 'lessThan'; value: number };

const fieldSchema = z.enum(CONDITION_FIELDS);

/**
 * A comparison value that survives normalisation.
 *
 * `''` and `'   '` both normalise to the empty string, and an empty needle is
 * not a narrow match — `startsWith ''` and `contains ''` are true of every
 * value including a missing one, so a half-typed rule would grant an account
 * in a system Syntra does not own to every person in the tenant. `equals ''`
 * and `in ['']` are narrower but still mean something other than they read:
 * they match exactly the contracts with nothing recorded, which is what
 * `isEmpty` is for and says out loud.
 *
 * Refused for the same reason the empty `in` list is refused: it is
 * indistinguishable from a rule somebody started and did not finish, and the
 * expensive direction here is the one that silently answers "yes, this person
 * gets an account".
 */
const comparisonValue = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: 'must not be blank — use isEmpty or isNotEmpty to test for a missing value',
  });

/**
 * `.strict()` on every member, not only on the combinators.
 *
 * A bare `z.object(...)` in Zod **strips** unknown keys rather than rejecting
 * them, so `{ field, op: 'isEmpty', value: 'x' }` parses cleanly and the
 * `value` silently disappears -- which is a rule that reads as one thing and
 * means another, in the code path that decides who has access.
 */
const leafSchema = z.union([
  z
    .object({
      field: fieldSchema,
      op: z.enum(['equals', 'notEquals', 'startsWith', 'contains']),
      value: comparisonValue,
    })
    .strict(),
  z
    .object({
      field: fieldSchema,
      op: z.enum(['in', 'notIn']),
      // An `in` over nothing matches nobody, which is indistinguishable from a
      // rule somebody started and did not finish.
      value: z.array(comparisonValue).min(1),
    })
    .strict(),
  z
    .object({
      field: fieldSchema,
      op: z.enum(['isEmpty', 'isNotEmpty']),
    })
    .strict(),
  z
    .object({
      // greaterThan and lessThan apply only to contract.fte. A literal rather
      // than the open field enum, so the schema refuses the nonsense rather
      // than the evaluator having to.
      field: z.literal(NUMERIC_FIELD),
      op: z.enum(['greaterThan', 'lessThan']),
      value: z.number(),
    })
    .strict(),
]);

/**
 * The schema and the type, checked against each other at compile time.
 *
 * `conditionSchema` below is annotated `z.ZodType<Condition>`, and that
 * annotation does NOT check what the schema accepts: `z.lazy`'s callback
 * refers to the constant it is initialising, so TypeScript falls back to the
 * declared type rather than inferring one to compare against it. Deleting a
 * whole arm of the union compiles cleanly — verified, not assumed.
 *
 * `leafSchema` is not lazy, so its type IS inferred, and this line is the
 * check the annotation cannot be. If the two ever drift — an operator added to
 * one and not the other, a field set widened on one side — it fails here
 * rather than at the far end of a rule that quietly stopped matching.
 */
type LeafCondition = Extract<Condition, { field: ConditionField }>;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _leafSchemaMatchesLeafCondition: MutuallyAssignable<
  z.infer<typeof leafSchema>,
  LeafCondition
> = true;
void _leafSchemaMatchesLeafCondition;

/**
 * And the same for the operator list, which is otherwise decorative: it is
 * exported for the console to build a picker from, so an operator listed here
 * and implemented nowhere becomes an option an administrator can choose and no
 * rule can honour.
 */
const _operatorListMatchesSchema: MutuallyAssignable<LeafCondition['op'], ConditionOperator> = true;
void _operatorListMatchesSchema;

/**
 * `.strict()` on the combinators too: a leaf or a branch carrying an
 * unexpected key is a typo in a rule that decides access.
 */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema) }).strict(),
    z.object({ any: z.array(conditionSchema) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    leafSchema,
  ]),
);

export interface ConditionFacts {
  'contract.department': string | null;
  'contract.jobTitle': string | null;
  'contract.costCentre': string | null;
  'contract.employer': string | null;
  'contract.location': string | null;
  'contract.fte': number | null;
  'person.status': string | null;
}

/**
 * String comparisons trim surrounding whitespace and fold case, because HR
 * data is typed by humans and "Finance " and "finance" are the same
 * department. A rule that misses because of a trailing space is a rule that
 * silently strips somebody's access.
 */
function normalise(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function isBlank(value: string | number | null): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Evaluates a condition against one contract's facts. Pure: no clock, no
 * database, no I/O. Nothing an administrator typed is executed — the
 * interpreter is closed over a closed field and operator set.
 *
 * WHICH WAY THE UNDECIDABLE CASES FALL, AND WHY.
 *
 * `BusinessRule` has no refusing polarity: every rule grants — an account
 * (`grantsAccount`) or an entitlement (`RuleEntitlement`) — in a system Syntra
 * does not own. So unlike `ruleMatches` in policy/evaluate.ts, which resolves
 * an undecidable condition to `true` on `deny` and `false` everywhere else,
 * there is one safe direction here and it is the same one for every rule: a
 * question this language cannot answer must not fire a write.
 *
 * Almost nothing here is undecidable, and that is by construction rather than
 * luck. A missing fact is normalised to the empty string, so it is a *value*
 * rather than an error, and every string operator has a defined answer for it:
 * `equals`/`in`/`startsWith`/`contains` are false of a missing department
 * because "the department is Finance" is a claim a contract with no department
 * does not make, and their negations are correspondingly true. There is no
 * malformed-CIDR equivalent in this grammar; the schema is what makes that so.
 *
 * The one genuinely undecidable case is an ordering against a missing number:
 * "is nothing greater than 0.5" has no answer. `greaterThan` and `lessThan`
 * therefore BOTH return false on a null fte — deliberately not complements of
 * each other, because a threshold that cannot be tested should decline to fire
 * in either direction.
 *
 * That leaves one asymmetry worth naming, because it is a trap rather than a
 * bug: `not` is exact negation, so `{ not: { fte greaterThan 0.5 } }` is TRUE
 * for a contract with no fte recorded, whereas `lessThan 0.5` is false. The
 * negation pairs are exact complements throughout (`notEquals` is `!equals`
 * including on null, `notIn` is `!in`) precisely so that the same rule written
 * two ways can never decide two different things — a divergence between
 * `{ not: X }` and the `notX` operator would be far worse than either answer.
 * An author who means "has an fte, and it is not above 0.5" writes
 * `{ all: [{ fte isNotEmpty }, { fte lessThan 0.5 }] }` and says so.
 */
export function evaluateCondition(
  condition: Condition,
  facts: ConditionFacts,
): boolean {
  // A condition this module cannot evaluate matches NOBODY. It never grants,
  // and it never widens a `not` into everybody — see `evaluate` below for why
  // the tri-state exists and where it is collapsed.
  return evaluate(condition, facts) ?? false;
}

/**
 * The recursive half, which answers `undefined` for "this module does not
 * recognise that".
 *
 * A plain boolean cannot carry that answer safely, because `not` inverts it.
 * The second `switch` below used to have no `default`: an `op` outside
 * `ConditionOperator` — which the type says cannot happen and a `condition`
 * column written by an older version or by hand can still contain — fell out
 * of the function as `undefined`, and `!undefined` is `true`. So a leaf nobody
 * could evaluate, wrapped in a `not`, matched every person in the tenant.
 * Returning `false` from the default alone would move the same hole one level
 * out rather than closing it.
 *
 * `undefined` therefore propagates through the connectives the way an unknown
 * does: decisive answers still decide (`all` is false if any child is false,
 * `any` is true if any child is true), and anything that still depends on the
 * unknown stays unknown. `evaluateCondition` collapses it to `false` at the
 * boundary, so nothing downstream has to think about it.
 *
 * The real control is upstream: `run-service.ts` parses every stored condition
 * with `conditionSchema` before a run evaluates it, and refuses the run if one
 * does not parse. This is the backstop, and it fails the way this whole module
 * fails — closed.
 */
function evaluate(condition: Condition, facts: ConditionFacts): boolean | undefined {
  if ('all' in condition) {
    // An empty `all` is true. That is how a birthright rule matching everybody
    // with any active contract is expressed without a special case.
    const answers = condition.all.map((child) => evaluate(child, facts));
    if (answers.some((a) => a === false)) return false;
    return answers.some((a) => a === undefined) ? undefined : true;
  }
  if ('any' in condition) {
    const answers = condition.any.map((child) => evaluate(child, facts));
    if (answers.some((a) => a === true)) return true;
    return answers.some((a) => a === undefined) ? undefined : false;
  }
  if ('not' in condition) {
    const inner = evaluate(condition.not, facts);
    return inner === undefined ? undefined : !inner;
  }

  const raw = facts[condition.field];

  switch (condition.op) {
    case 'isEmpty':
      return isBlank(raw);
    case 'isNotEmpty':
      return !isBlank(raw);
    case 'greaterThan':
      return typeof raw === 'number' && raw > condition.value;
    case 'lessThan':
      return typeof raw === 'number' && raw < condition.value;
    default:
      break;
  }

  const actual = normalise(typeof raw === 'number' ? String(raw) : raw);

  switch (condition.op) {
    case 'equals':
      return actual === normalise(condition.value);
    case 'notEquals':
      return actual !== normalise(condition.value);
    // `''.startsWith('')` and `''.includes('')` are both true, so a blank
    // needle here matches every person including the ones with nothing
    // recorded. `conditionSchema` refuses to store one; this is the backstop
    // for a `condition` column written before that check existed or by some
    // other route, and it fails the way this whole module fails — closed.
    case 'startsWith': {
      const prefix = normalise(condition.value);
      return prefix !== '' && actual.startsWith(prefix);
    }
    case 'contains': {
      const needle = normalise(condition.value);
      return needle !== '' && actual.includes(needle);
    }
    // The same backstop, for the operator next door, where it was missing.
    // `conditionSchema` requires `.min(1)` on the list — but an empty one
    // stored some other way makes `in` match nobody, which is harmless, and
    // `notIn` match EVERYBODY, which is exactly the defect the blank-needle
    // case above was written for. A list nobody wrote is not a filter, in
    // either direction.
    case 'in':
    case 'notIn': {
      if (condition.value.length === 0) return false;
      const hit = condition.value.some((candidate) => normalise(candidate) === actual);
      return condition.op === 'in' ? hit : !hit;
    }
    default:
      // An `op` the closed set does not contain. Unreachable through the type
      // and reachable through the column, and the honest answer is that this
      // module cannot say — NOT `false`, which a `not` one level up would
      // turn back into "everybody".
      return undefined;
  }
}
