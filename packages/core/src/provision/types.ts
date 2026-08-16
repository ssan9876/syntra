import type { Condition } from './condition.js';

/**
 * A person, flattened to exactly what the pure stages need.
 *
 * These are the columns `Person` has. It has no `email` and no `displayName`;
 * spec section 15 says this slice changes no existing table, so neither is
 * added. `businessEmail` and `personalEmail` are the two address columns, and
 * a display name is DERIVED by `personDisplayName` in `desired.ts`.
 *
 * `givenName` and `familyName` are non-null because the column is `String`,
 * not `String?`.
 */
export interface PersonFacts {
  id: string;
  givenName: string;
  familyName: string;
  /**
   * How the person's name is composed. Carried into the template context as a
   * fact a template may read, rather than branching on it here: `Person` holds
   * no partner-name columns, so there is nothing for a convention to choose
   * between yet, and deriving one from columns that do not exist would be
   * inventing data.
   */
  nameConvention: string;
  businessEmail: string | null;
  personalEmail: string | null;
  status: string;
}

export interface ContractFacts {
  id: string;
  sequence: number;
  isPrimary: boolean;
  startDate: Date;
  /** Null means open-ended. */
  endDate: Date | null;
  department: string | null;
  jobTitle: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  fte: number | null;
}

export interface RuleFacts {
  id: string;
  name: string;
  condition: Condition;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}

export interface ProfileFacts {
  correlationKeyTemplate: string;
  maxUniquenessAttempts: number;
  containerTemplate: string;
  fallbackContainer: string;
  /** Target attribute name to template, e.g. { displayName: '%person.givenName% %person.familyName%' }. */
  attributeTemplates: Record<string, string>;
  baseDn: string;
}

/**
 * Why somebody holds something: a rule name and the contract that satisfied
 * it. Recorded at evaluation time because it is unanswerable after the fact,
 * and "why does this person hold this?" is the most-asked question of any
 * provisioning product.
 */
export interface Attribution {
  ruleId: string;
  ruleName: string;
  contractId: string;
}

export type UnprocessableKind =
  | 'no_contracts'
  | 'unresolvable_rule'
  | 'template_unresolvable'
  | 'container_missing'
  | 'name_generation_exhausted'
  | 'target_read_incomplete'
  | 'account_conflict';

export interface DesiredAccount {
  required: boolean;
  /** The complete managed set. update_account carries all of it, never a delta. */
  attributes: Record<string, string[]>;
  container: string;
  /**
   * Whether the account should be enabled *now*, as opposed to merely existing.
   * A pre-hire has required: true and enabledNow: false.
   */
  enabledNow: boolean;
  /**
   * The key this account should carry: the one it already has unless the
   * target allows renaming and generation produced another, and a freshly
   * generated one when the person has no account yet.
   *
   * Null only when no account is required, where there is nothing to name.
   */
  correlationKey: string | null;
}

export interface DesiredState {
  personId: string;
  account: DesiredAccount | null;
  entitlements: Set<string>;
  attribution: Map<string, Attribution[]>;
  /**
   * This person holds contracts and every one of them starts after the
   * horizon: they have not started yet.
   *
   * A THIRD state, not a shade of the other two. `account.required === false`
   * is equally true of a leaver, and the two need opposite treatment: a
   * leaver's contracts have ended, so the ladder has a date to measure from; a
   * future joiner's are open-ended, `latestContractEnd` returns null, and the
   * planner reads that as "still employed, no departure date" and disables
   * them and revokes everything on the spot -- to somebody who starts in six
   * weeks. Spec section 8: an account belonging to somebody whose contract has
   * not started is a question, not an instruction. Nothing is proposed, and it
   * is reported as drift.
   */
  notYetStarted: boolean;
  /**
   * When set, this person is excluded from the target's plan ENTIRELY and
   * every other field on this object is ignored. `account: null` and an
   * unprocessable person are not the same thing: the first means "this person
   * should have nothing", the second means "we could not work out what this
   * person should have". They produce identical empty sets and opposite
   * correct behaviours.
   */
  unprocessable: { kind: UnprocessableKind; message: string } | null;
}
