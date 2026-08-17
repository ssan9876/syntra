import type { ProvisionActionType } from '@syntra/connectors';

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

export type EnforcementMode = 'additive' | 'authoritative';

export type DriftKind =
  | 'unmanaged_entitlement'
  | 'missing_grant'
  | 'orphan_account'
  | 'account_missing_at_target'
  | 'unexpected_status';

export type AccountStatus =
  | 'pending'
  | 'active'
  | 'disabled'
  | 'archived'
  | 'missing_at_target'
  | 'conflict';

/** One account as the target returned it. */
export interface TargetObject {
  anchor: string;
  correlationKey: string;
  dn: string;
  enabled: boolean;
  /** The tenant id and originating actionId Provision wrote when it created this. */
  provenance: string | null;
  /** Entitlement ids (Syntra's, resolved from externalIds), not externalIds. */
  entitlementIds: string[];
  /**
   * False when the connector saw the object but could not read it in full — a
   * range walk that could not finish. Every person whose account this is
   * becomes unprocessable rather than being diffed against half a truth.
   */
  readComplete: boolean;
}

export interface KnownHolding {
  entitlementId: string;
  origin: 'rule' | 'manual' | 'discovered';
  grantedByRuleId: string | null;
}

/** One account as Syntra believes it to be. */
export interface KnownAccount {
  id: string;
  personId: string;
  anchor: string | null;
  correlationKey: string;
  status: AccountStatus;
  disabledAt: Date | null;
  lastAppliedAttributes: Record<string, string[]>;
  holdings: KnownHolding[];
}

export interface ActualState {
  personId: string;
  accountId: string | null;
  anchor: string | null;
  correlationKey: string | null;
  status: AccountStatus | 'absent';
  existsAtTarget: boolean;
  enabledAtTarget: boolean;
  disabledAt: Date | null;
  dn: string | null;
  attributes: Record<string, string[]>;
  /** Everything the target holds for this account. */
  heldEntitlements: Set<string>;
  /**
   * The subset the planner is allowed to act on: what the target holds, inside
   * Provision's remit, that Provision either granted itself or -- under
   * `authoritative` only -- has been told to take charge of.
   *
   * This is the set `planActions` differences against, in BOTH directions:
   * anything in it and not desired is revoked, anything desired and not in it
   * is granted. Membership therefore means "revocable", which is why an
   * unmanaged entitlement is kept OUT of it under `additive` and put IN it
   * under `authoritative`, and why an entitlement no business rule names is
   * kept out under both.
   *
   * "Provision manages this target" and "Provision manages every group in this
   * target" are different claims, and only the first is ever true.
   */
  heldWithinRemit: Set<string>;
}

export interface DraftDriftFinding {
  kind: DriftKind;
  accountId: string | null;
  /** A Syntra Entitlement id, or null. Never a target anchor: the column is @db.Uuid. */
  entitlementId: string | null;
  /**
   * The target's own identifier for the object a finding is about, when
   * Syntra holds no row for it -- an orphan account.
   */
  subjectAnchor: string | null;
  detail: Record<string, unknown>;
  fingerprint: string;
}

export interface LadderSettings {
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  /** Null means never. */
  archiveAfterDays: number | null;
  reenableWithoutConfirmationDays: number;
  renameEnabled: boolean;
}

export interface PlannedAction {
  actionType: ProvisionActionType;
  personId: string | null;
  accountId: string | null;
  entitlementId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  attributedRuleIds: string[];
  /**
   * True for a rename, a re-enable outside the window, and a re-create of a
   * vanished account. These need an explicit tick even in a run the guard did
   * not block.
   */
  requiresConfirmation: boolean;
  message: string | null;
}
