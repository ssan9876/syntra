import { z } from 'zod';
import {
  evaluateCondition,
  type Condition,
  type ConditionFacts,
  type ConditionOperator,
} from '../provision/condition.js';

/**
 * The audience field set: Provision's seven, plus the three the catalog
 * needs.
 *
 * Provision's `ConditionField` is deliberately NOT widened to include these.
 * A business rule naming `user.memberOfGroup` would be a rule Provision has no
 * facts to evaluate -- it would parse, save, and then silently never match,
 * which is the worst of the three possible behaviours.
 */
export type AudienceField =
  | 'contract.department'
  | 'contract.jobTitle'
  | 'contract.costCentre'
  | 'contract.employer'
  | 'contract.location'
  | 'contract.fte'
  | 'person.status'
  | 'user.memberOfGroup'
  | 'user.orgUnit'
  | 'person.hasEntitlement';

/** The seven `evaluateCondition` already knows how to answer. */
export const CONTRACT_AUDIENCE_FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
] as const satisfies readonly AudienceField[];

/**
 * The three this slice adds. Each is set membership over a list of opaque
 * identifiers, which is why only four operators are permitted over them.
 */
export const SET_AUDIENCE_FIELDS = [
  'user.memberOfGroup',
  'user.orgUnit',
  'person.hasEntitlement',
] as const satisfies readonly AudienceField[];

const SET_OPERATORS = ['equals', 'notEquals', 'in', 'notIn'] as const;
type SetOperator = (typeof SET_OPERATORS)[number];

const VALUELESS_OPERATORS = ['isEmpty', 'isNotEmpty'] as const;

export type AudienceCondition =
  | { all: AudienceCondition[] }
  | { any: AudienceCondition[] }
  | { not: AudienceCondition }
  // `| undefined` is not noise. `exactOptionalPropertyTypes` is on in
  // `tsconfig.base.json`, and zod infers `value?: ... | undefined` for a
  // `.optional()` property; without it the two are NOT mutually assignable and
  // the guard below cannot be written -- which is exactly why the first draft
  // reached for a cast instead.
  | {
      field: AudienceField;
      op: ConditionOperator;
      value?: string | number | string[] | undefined;
    };

const isSetField = (field: AudienceField): boolean =>
  (SET_AUDIENCE_FIELDS as readonly string[]).includes(field);

const leafSchema = z
  .object({
    field: z.enum([
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
    ]),
    op: z.enum([
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
    ]),
    value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  })
  .superRefine((leaf, ctx) => {
    const needsValue = !(VALUELESS_OPERATORS as readonly string[]).includes(leaf.op);
    if (needsValue && leaf.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${leaf.op} needs a value`,
      });
    }
    if (!needsValue && leaf.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${leaf.op} takes no value`,
      });
    }
    // A prefix match over a list of opaque identifiers matches on a
    // coincidence rather than a rule, and a numeric comparison over one is
    // meaningless. Refused at save time so nobody has to discover it from a
    // product that is visible to nobody for no stated reason.
    if (isSetField(leaf.field) && !(SET_OPERATORS as readonly string[]).includes(leaf.op)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['op'],
        message: `${leaf.field} accepts only ${SET_OPERATORS.join(', ')}`,
      });
    }
  });

/**
 * The schema and the type, checked against each other at compile time.
 *
 * `audienceConditionSchema` below is annotated `z.ZodType<AudienceCondition>`,
 * and **that annotation checks nothing**. Provision measured it (Ruling P21):
 * `z.lazy`'s callback refers to the constant it is initialising, so TypeScript
 * falls back to the declared type rather than inferring one to compare against
 * it, and deleting an entire arm of the union still compiles cleanly. The
 * `as z.ZodType<AudienceCondition>` an earlier draft carried was a second
 * suppression on top of an annotation that was already inert -- the same
 * disease as `as never` on `client.modify`: a construct that reads as
 * enforcement and enforces nothing.
 *
 * `leafSchema` is not lazy, so its type IS inferred, and the guard below is
 * the check the annotation cannot be. If the two ever drift -- an operator
 * added to one and not the other, a field enum widened on one side -- it fails
 * here rather than at the far end of a product that quietly became visible to
 * nobody. This is the shape `packages/core/src/provision/condition.ts` carries
 * as shipped (`_leafSchemaMatchesLeafCondition` and
 * `_operatorListMatchesSchema`); the plan previously cited that file for the
 * pre-fix version of itself, which no longer exists.
 */
type AudienceLeaf = Extract<AudienceCondition, { field: AudienceField }>;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _leafSchemaMatchesAudienceLeaf: MutuallyAssignable<
  z.infer<typeof leafSchema>,
  AudienceLeaf
> = true;
void _leafSchemaMatchesAudienceLeaf;

/**
 * And the field partition, which the guard above does NOT cover.
 *
 * `as const satisfies readonly AudienceField[]` on the two exported lists
 * checks only that everything in them is a field; it does not check that the
 * two together are ALL the fields. Add an eleventh `AudienceField` and the
 * schema enum, and both compile: `isSetField` answers `false` for it, so it is
 * handed to Provision's `evaluateCondition`, which has never heard of it and
 * answers `false` for every person alive -- a product visible to nobody, for no
 * stated reason. The two lists are also what the console builds its pickers
 * from. This is the line that fails instead.
 *
 * Note that an operator guard here would be decoration and is deliberately
 * absent: `AudienceCondition`'s leaf declares `op: ConditionOperator`
 * directly, so `AudienceLeaf['op'] extends ConditionOperator` is true by
 * construction, and the guard above already ties the schema's hard-coded
 * operator list to it. `provision/condition.ts` needs its second guard
 * because its `Condition` type spells the operators out per arm; this module
 * does not.
 */
const _everyAudienceFieldIsClassified: MutuallyAssignable<
  (typeof CONTRACT_AUDIENCE_FIELDS)[number] | (typeof SET_AUDIENCE_FIELDS)[number],
  AudienceField
> = true;
void _everyAudienceFieldIsClassified;

/**
 * Recursive, so the schema is declared lazily and annotated. No cast: with the
 * guard above in place the union's own inferred type lines up, and a cast here
 * would only re-hide whatever moved.
 */
export const audienceConditionSchema: z.ZodType<AudienceCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(audienceConditionSchema) }).strict(),
    z.object({ any: z.array(audienceConditionSchema) }).strict(),
    z.object({ not: audienceConditionSchema }).strict(),
    leafSchema,
  ]),
);

export interface SubjectSetFacts {
  /** Every group the subject's user accounts belong to. */
  groupIds: readonly string[];
  /** The subject's org unit and every unit above it, already walked. */
  orgUnitChainIds: readonly string[];
  /** Entitlements the subject already holds, by any origin. */
  entitlementIds: readonly string[];
}

export interface AudienceFacts extends SubjectSetFacts {
  /** One contract's worth of facts, in the shape Provision's evaluator reads. */
  contract: ConditionFacts;
}

function setFor(field: AudienceField, facts: AudienceFacts): readonly string[] {
  if (field === 'user.memberOfGroup') return facts.groupIds;
  if (field === 'user.orgUnit') return facts.orgUnitChainIds;
  return facts.entitlementIds;
}

function evaluateSetLeaf(
  field: AudienceField,
  op: SetOperator,
  value: string | number | string[] | undefined,
  facts: AudienceFacts,
): boolean {
  const held = new Set(setFor(field, facts));
  const wanted = (Array.isArray(value) ? value : [String(value ?? '')]).map((v) =>
    v.trim(),
  );
  const anyHeld = wanted.some((v) => held.has(v));
  return op === 'equals' || op === 'in' ? anyHeld : !anyHeld;
}

/**
 * Evaluates one expression against one contract's worth of facts.
 *
 * Every leaf on one of Provision's seven fields is handed to
 * `evaluateCondition` unchanged. That is the point: the trimmed
 * case-insensitive comparison, the null handling, the empty-string handling
 * and the numeric `fte` path have exactly one implementation and exactly one
 * test suite, and a tenant learns one language.
 */
export function evaluateAudience(
  condition: AudienceCondition,
  facts: AudienceFacts,
): boolean {
  if ('all' in condition) {
    return condition.all.every((child) => evaluateAudience(child, facts));
  }
  if ('any' in condition) {
    return condition.any.some((child) => evaluateAudience(child, facts));
  }
  if ('not' in condition) {
    return !evaluateAudience(condition.not, facts);
  }

  if (isSetField(condition.field)) {
    return evaluateSetLeaf(
      condition.field,
      condition.op as SetOperator,
      condition.value,
      facts,
    );
  }

  // Narrowed by the branch above: what remains is one of the seven, which is
  // exactly `Condition`'s leaf shape.
  return evaluateCondition(condition as Condition, facts.contract);
}

/**
 * Whether a product's audience admits a person.
 *
 * A null condition admits NOBODY. This is the security default of the whole
 * catalog and it is written here, once, rather than at each of the seven read
 * paths -- a default applied by six of seven callers is not a default.
 *
 * A person with no active contracts is admitted by nothing, including
 * `{ all: [] }`: the rule is "any of the person's currently active contracts
 * satisfies it", and there are none to satisfy it.
 */
export function audienceAdmits(
  condition: AudienceCondition | null,
  contracts: readonly ConditionFacts[],
  sets: SubjectSetFacts,
): boolean {
  if (condition === null) return false;
  return contracts.some((contract) => evaluateAudience(condition, { ...sets, contract }));
}
