export type PolicyOutcome = 'allow' | 'require_mfa' | 'require_factor' | 'deny';

export const POLICY_OUTCOMES: PolicyOutcome[] = [
  'allow',
  'require_mfa',
  'require_factor',
  'deny',
];

export type FactorType = 'totp' | 'webauthn';

export const FACTOR_TYPES: FactorType[] = ['totp', 'webauthn'];

export type ContractField = 'department' | 'jobTitle' | 'employer' | 'location';

export const CONTRACT_FIELDS: ContractField[] = [
  'department',
  'jobTitle',
  'employer',
  'location',
];

/** The subset of a Contract a policy rule may read. */
export interface ContractFacts {
  department: string | null;
  jobTitle: string | null;
  employer: string | null;
  location: string | null;
}

/**
 * One rule, already loaded and narrowed. Every condition that is empty or null
 * is unconstrained; the ones that are set must all hold.
 */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: PolicyOutcome;
  factorType: FactorType | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: ContractField | null;
  contractValues: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

/** What applies when no rule matches. */
export interface PolicyFallback {
  outcome: PolicyOutcome;
  factorType: FactorType | null;
}

/**
 * Everything the engine is allowed to know. Assembled once by
 * buildAuthContext; the engine never reaches past it.
 */
export interface AuthContext {
  userId: string;
  /** The application being entered, or null for the Syntra portal itself. */
  applicationId: string | null;
  groupIds: string[];
  /** One entry per contract in force right now. Empty is ordinary. */
  contracts: ContractFacts[];
  sourceIp: string | null;
  now: Date;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  factorType: FactorType | null;
  /** The rule that decided, or null when the fallback applied. */
  ruleId: string | null;
  ruleName: string | null;
}

/**
 * What a stored rule row may say. A superset of `PolicyOutcome`.
 *
 * `federate` is deliberately not a `PolicyOutcome`: `authorize.ts` maps every
 * `PolicyOutcome` exhaustively in its STRENGTH table, and a fifth member there
 * would change the meaning of a floor, of `satisfiesRequirement` and of the
 * fallback. A federate row is a routing rule — it says where a browser goes
 * before anyone is identified, and it grants nothing. `loadPolicy` splits the
 * two apart so the authorization engine never sees one.
 */
export type RuleOutcome = PolicyOutcome | 'federate';

export const RULE_OUTCOMES: RuleOutcome[] = [...POLICY_OUTCOMES, 'federate'];
