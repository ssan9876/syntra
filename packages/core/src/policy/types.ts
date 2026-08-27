export type PolicyOutcome = 'allow' | 'require_mfa' | 'require_factor' | 'deny';

export const POLICY_OUTCOMES: PolicyOutcome[] = [
  'allow',
  'require_mfa',
  'require_factor',
  'deny',
];

export type FactorType = 'totp' | 'webauthn' | 'email_otp';

/**
 * The policy-visible factors, in the order a person is offered them.
 *
 * Strongest first, and `email_otp` last on purpose: a rule that says
 * "require a factor" should not be satisfiable by the weakest one when a
 * better one is available, and the enrolment screen offers these in order.
 */
export const FACTOR_TYPES: FactorType[] = ['webauthn', 'totp', 'email_otp'];

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
  /**
   * Device kinds this rule applies to. Empty is unconstrained.
   *
   * Derived from the user agent, which the client chooses — so this is a
   * speed bump, not a control. Reasonable for "ask for a second factor from
   * phones"; think twice before building a `deny` on it.
   */
  devicePlatforms: string[];
  /**
   * ISO 3166-1 alpha-2 codes this rule applies to. Empty is unconstrained.
   *
   * Read from a header the deployment names, because a GeoIP database is a
   * licensed monthly binary and this product runs air-gapped. Where no header
   * is configured every country condition is unevaluable.
   */
  countries: string[];
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
  /** From the user agent. Null when none was sent. */
  devicePlatform: string | null;
  /** From the configured header. Null when unset or unrecognised. */
  country: string | null;
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
