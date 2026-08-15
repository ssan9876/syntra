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
