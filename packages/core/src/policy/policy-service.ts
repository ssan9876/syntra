import type { TenantClient } from '@syntra/db';
import type { RoutingRule } from '../federation/routing.js';
import { currentTenant } from '../tenant-context.js';
import { isIpRangeUsable } from './ip-match.js';
import { isDevicePlatform } from './device-match.js';
import { isValidTimeZone } from './time-window.js';
import {
  CONTRACT_FIELDS,
  FACTOR_TYPES,
  POLICY_OUTCOMES,
  RULE_OUTCOMES,
  type ContractField,
  type FactorType,
  type PolicyFallback,
  type PolicyOutcome,
  type PolicyRule,
  type RuleOutcome,
} from './types.js';

export interface LoadedPolicy {
  rules: PolicyRule[];
  /**
   * Rows whose outcome is 'federate'. Never seen by evaluatePolicy: they say
   * where a login goes before anybody is identified, and they grant nothing.
   */
  routes: RoutingRule[];
  fallback: PolicyFallback;
}

export interface RuleInput {
  name: string;
  enabled?: boolean | undefined;
  outcome: RuleOutcome;
  factorType?: FactorType | null | undefined;
  applicationIds?: string[] | undefined;
  groupIds?: string[] | undefined;
  contractField?: ContractField | null | undefined;
  contractValues?: string[] | undefined;
  ipRanges?: string[] | undefined;
  devicePlatforms?: string[] | undefined;
  countries?: string[] | undefined;
  daysOfWeek?: number[] | undefined;
  startMinute?: number | null | undefined;
  endMinute?: number | null | undefined;
  timezone?: string | null | undefined;
  /** Required on a federate rule, refused on any other. */
  upstreamIdpId?: string | null | undefined;
  /** The login identifier's domain part. Only a federate rule matches on it. */
  loginDomains?: string[] | undefined;
}

type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: string;
  factorType: string | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: string | null;
  contractValues: string[];
  ipRanges: string[];
  devicePlatforms: string[];
  countries: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
  upstreamIdpId: string | null;
  loginDomains: string[];
};

const asOutcome = (value: string): PolicyOutcome =>
  (POLICY_OUTCOMES as string[]).includes(value) ? (value as PolicyOutcome) : 'deny';

const asFactor = (value: string | null): FactorType | null =>
  value !== null && (FACTOR_TYPES as string[]).includes(value)
    ? (value as FactorType)
    : null;

const asContractField = (value: string | null): ContractField | null =>
  value !== null && (CONTRACT_FIELDS as string[]).includes(value)
    ? (value as ContractField)
    : null;

/**
 * A stored row narrowed to what the engine accepts. An outcome the code does
 * not recognise becomes 'deny' rather than being dropped: a rule whose meaning
 * cannot be read must not quietly stop applying.
 */
function toRule(row: RuleRow): PolicyRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    outcome: asOutcome(row.outcome),
    factorType: asFactor(row.factorType),
    applicationIds: row.applicationIds,
    groupIds: row.groupIds,
    contractField: asContractField(row.contractField),
    contractValues: row.contractValues,
    ipRanges: row.ipRanges,
    devicePlatforms: row.devicePlatforms,
    countries: row.countries,
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone,
  };
}

/**
 * A stored federate row narrowed to a routing rule.
 *
 * Null when the row names no upstream, which the database's own check
 * constraint already forbids. Dropping such a row is safe in the way dropping
 * an unreadable authorization rule would not be: routing grants nothing, so a
 * row that cannot be read leaves the login local rather than letting somebody
 * in.
 */
function toRoute(row: RuleRow): RoutingRule | null {
  if (!row.upstreamIdpId) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    upstreamIdpId: row.upstreamIdpId,
    applicationIds: row.applicationIds,
    loginDomains: row.loginDomains,
    ipRanges: row.ipRanges,
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone,
  };
}

/**
 * A policy rule the administrator wrote that could never be honoured.
 *
 * A NAMED class rather than a bare Error, because the route above it used to
 * catch everything and answer 400 with the caught message attached. That
 * relabelled a lost database connection as the administrator's mistake, and
 * put a message never written for a client into the response body -- the one
 * thing the problem+json handler refuses to do, since such a message may
 * carry connection strings or stack detail. With a class to test, the route
 * answers 400 for this and rethrows everything else to be handled as the
 * server fault it is.
 */
export class PolicyRuleInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyRuleInvalidError';
  }
}

/**
 * Rejects a rule that could never be honoured as written. This is where a bad
 * rule is caught; the engine's backstops exist for rows that predate the check
 * or arrive some other way, not as a substitute for it.
 */
function validate(input: RuleInput): void {
  if (!(RULE_OUTCOMES as string[]).includes(input.outcome)) {
    throw new PolicyRuleInvalidError(`unknown outcome: ${input.outcome}`);
  }
  if (input.outcome === 'require_factor' && !input.factorType) {
    throw new PolicyRuleInvalidError('factorType is required when the outcome is require_factor');
  }
  if (input.outcome === 'federate') {
    if (!input.upstreamIdpId) {
      throw new PolicyRuleInvalidError('upstreamIdpId is required when the outcome is federate');
    }
    if (input.groupIds && input.groupIds.length > 0) {
      throw new PolicyRuleInvalidError(
        'a federate rule cannot match on group membership: the upstream is chosen before the user is known',
      );
    }
    if (input.contractField) {
      throw new PolicyRuleInvalidError(
        'a federate rule cannot match on a contract attribute: the upstream is chosen before the user is known',
      );
    }
    if (input.factorType) {
      throw new PolicyRuleInvalidError(
        'a federate rule cannot require a factor: requirements are decided by authorize() after the upstream returns',
      );
    }
  } else if (input.upstreamIdpId) {
    throw new PolicyRuleInvalidError('upstreamIdpId is only meaningful on a federate rule');
  }
  if ((input.loginDomains?.length ?? 0) > 0 && input.outcome !== 'federate') {
    throw new PolicyRuleInvalidError('loginDomains is only meaningful on a federate rule');
  }
  if (input.factorType && !(FACTOR_TYPES as string[]).includes(input.factorType)) {
    throw new PolicyRuleInvalidError(`unknown factorType: ${input.factorType}`);
  }
  if (input.contractField && !(CONTRACT_FIELDS as string[]).includes(input.contractField)) {
    throw new PolicyRuleInvalidError(`unknown contractField: ${input.contractField}`);
  }
  for (const day of input.daysOfWeek ?? []) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new PolicyRuleInvalidError(`daysOfWeek must hold integers 0..6, got ${day}`);
    }
  }
  for (const minute of [input.startMinute, input.endMinute]) {
    if (minute === null || minute === undefined) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) {
      throw new PolicyRuleInvalidError(`Minute must be an integer 0..1439, got ${minute}`);
    }
  }
  if (input.timezone && !isValidTimeZone(input.timezone)) {
    throw new PolicyRuleInvalidError(`timezone is not a zone this platform knows: ${input.timezone}`);
  }
  for (const range of input.ipRanges ?? []) {
    // A parse, which is what a syntax check is. Asking instead whether the
    // range happens to contain some probe address answers a different
    // question, and rejects 192.168.0.0/16, 172.16.0.0/12, 198.51.100.0/24 and
    // every literal host address — which is to say most of what a tenant
    // actually types into an office allowlist.
    if (!isIpRangeUsable(range)) {
      throw new PolicyRuleInvalidError(`ipRanges holds something that is not an address or CIDR: ${range}`);
    }
  }
  for (const platform of input.devicePlatforms ?? []) {
    // A closed list rather than free text. A rule naming `Windows` or `win32`
    // would save cleanly and then never match anything, and a policy that
    // silently never fires is worse than one that refuses to be written.
    if (!isDevicePlatform(platform)) {
      throw new PolicyRuleInvalidError(
        `devicePlatforms holds something that is not a device kind: ${platform}`,
      );
    }
  }
  for (const country of input.countries ?? []) {
    // Two letters, ISO 3166-1 alpha-2, which is what every header that carries
    // a country sends. Not checked against a list of countries that exist:
    // that list changes, and refusing a code because this release predates it
    // would be a bug nobody could work around.
    if (!/^[A-Za-z]{2}$/.test(country.trim())) {
      throw new PolicyRuleInvalidError(
        `countries holds something that is not a two-letter country code: ${country}`,
      );
    }
  }
}

/**
 * Refuses a rule that names WebAuthn in a tenant that cannot use it.
 *
 * Ruling F derives the relying party from `Tenant.primaryDomain`, so a tenant
 * without one cannot register or assert a security key. A
 * `require_factor: webauthn` rule saved in that state is a dead end nothing
 * else catches: `authorize()` offers enrolment, the user reaches the enrolment
 * screen, and the WebAuthn endpoint refuses with a 409 they can do nothing
 * about. Catching it at write time, where an administrator is standing in front
 * of the message, is the only place the fix is actionable.
 */
async function assertFactorUsable(
  tx: TenantClient,
  outcome: RuleOutcome,
  factorType: FactorType | null | undefined,
): Promise<void> {
  if (outcome !== 'require_factor') return;
  if (factorType !== 'webauthn' && factorType !== 'email_otp') return;
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (factorType === 'webauthn' && !tenant.primaryDomain) {
    throw new PolicyRuleInvalidError(
      'this tenant has no primary domain set, so security keys cannot be registered — set one before requiring them',
    );
  }
  // The same dead end as the one above, one switch along. Emailed codes are
  // off until a tenant turns them on, and a rule requiring one while they are
  // off sends every user it matches to an enrolment screen that cannot
  // enrol them.
  if (factorType === 'email_otp' && !tenant.emailOtpEnabled) {
    throw new PolicyRuleInvalidError(
      'emailed codes are switched off for this tenant — turn them on before requiring one',
    );
  }
}

async function policyId(tx: TenantClient): Promise<string> {
  const tenantId = await currentTenant(tx);
  const existing = await tx.authPolicy.findFirst({ where: { tenantId } });
  if (existing) return existing.id;
  const created = await tx.authPolicy.create({ data: { tenantId } });
  return created.id;
}

export async function loadPolicy(tx: TenantClient): Promise<LoadedPolicy> {
  const policy = await tx.authPolicy.findFirst();
  if (!policy) {
    return { rules: [], routes: [], fallback: { outcome: 'allow', factorType: null } };
  }

  const rows = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    orderBy: { position: 'asc' },
  });

  // The split. A federate row must never reach evaluatePolicy: `asOutcome`
  // would narrow its outcome to 'deny', and a routing rule sitting at position
  // 0 would then refuse every sign-in in the tenant.
  const federate = rows.filter((row) => row.outcome === 'federate');
  const authorization = rows.filter((row) => row.outcome !== 'federate');

  const outcome = asOutcome(policy.defaultOutcome);
  return {
    rules: authorization.map(toRule),
    routes: federate
      .map(toRoute)
      .filter((route): route is RoutingRule => route !== null),
    fallback: {
      outcome,
      factorType: outcome === 'require_factor' ? asFactor(policy.defaultFactorType) : null,
    },
  };
}

export async function setPolicyDefault(
  tx: TenantClient,
  fallback: PolicyFallback,
): Promise<void> {
  if (fallback.outcome === 'require_factor' && !fallback.factorType) {
    throw new PolicyRuleInvalidError('factorType is required when the default outcome is require_factor');
  }
  await assertFactorUsable(tx, fallback.outcome, fallback.factorType);
  const id = await policyId(tx);
  await tx.authPolicy.update({
    where: { id },
    data: {
      defaultOutcome: fallback.outcome,
      defaultFactorType: fallback.factorType,
    },
  });
}

const data = (input: RuleInput) => ({
  name: input.name,
  enabled: input.enabled ?? true,
  outcome: input.outcome,
  factorType: input.factorType ?? null,
  applicationIds: input.applicationIds ?? [],
  groupIds: input.groupIds ?? [],
  contractField: input.contractField ?? null,
  contractValues: input.contractValues ?? [],
  ipRanges: input.ipRanges ?? [],
  devicePlatforms: input.devicePlatforms ?? [],
  countries: (input.countries ?? []).map((c) => c.trim().toUpperCase()),
  daysOfWeek: input.daysOfWeek ?? [],
  startMinute: input.startMinute ?? null,
  endMinute: input.endMinute ?? null,
  timezone: input.timezone ?? null,
  upstreamIdpId: input.upstreamIdpId ?? null,
  loginDomains: input.loginDomains ?? [],
});

export async function addRule(tx: TenantClient, input: RuleInput): Promise<PolicyRule> {
  validate(input);
  await assertFactorUsable(tx, input.outcome, input.factorType);
  const tenantId = await currentTenant(tx);
  const id = await policyId(tx);

  const last = await tx.authPolicyRule.findFirst({
    where: { policyId: id },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  const row = await tx.authPolicyRule.create({
    data: { tenantId, policyId: id, position: (last?.position ?? 0) + 1, ...data(input) },
  });
  return toRule(row);
}

export async function updateRule(
  tx: TenantClient,
  ruleId: string,
  input: RuleInput,
): Promise<PolicyRule> {
  validate(input);
  await assertFactorUsable(tx, input.outcome, input.factorType);
  const row = await tx.authPolicyRule.update({ where: { id: ruleId }, data: data(input) });
  return toRule(row);
}

/**
 * Removes a rule and closes the gap, so positions stay 1..n. A gap would not
 * change evaluation order, but it makes "rule 4" in an audit event mean
 * something different from "the fourth rule on the screen".
 */
export async function deleteRule(tx: TenantClient, ruleId: string): Promise<void> {
  const row = await tx.authPolicyRule.findUnique({ where: { id: ruleId } });
  if (!row) return;

  await tx.authPolicyRule.delete({ where: { id: ruleId } });
  const rest = await tx.authPolicyRule.findMany({
    where: { policyId: row.policyId },
    orderBy: { position: 'asc' },
  });
  // Park them out of the way first: (policyId, position) is unique, so
  // renumbering in place collides with the rows not yet moved.
  await renumber(tx, rest.map((r) => r.id));
}

export async function reorderRules(tx: TenantClient, ruleIds: string[]): Promise<void> {
  const policy = await tx.authPolicy.findFirst();
  if (!policy) return;

  const existing = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    select: { id: true },
  });
  const wanted = new Set(ruleIds);
  if (wanted.size !== ruleIds.length || wanted.size !== existing.length) {
    throw new PolicyRuleInvalidError('reorderRules must name every rule in the policy exactly once');
  }
  for (const row of existing) {
    if (!wanted.has(row.id)) {
      throw new PolicyRuleInvalidError('reorderRules must name every rule in the policy exactly once');
    }
  }

  await renumber(tx, ruleIds);
}

async function renumber(tx: TenantClient, orderedIds: string[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx.authPolicyRule.update({
      where: { id },
      data: { position: -(index + 1) },
    });
  }
  for (const [index, id] of orderedIds.entries()) {
    await tx.authPolicyRule.update({
      where: { id },
      data: { position: index + 1 },
    });
  }
}
