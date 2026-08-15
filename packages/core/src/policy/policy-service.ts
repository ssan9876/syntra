import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { isIpRangeUsable } from './ip-match.js';
import { isValidTimeZone } from './time-window.js';
import {
  CONTRACT_FIELDS,
  FACTOR_TYPES,
  POLICY_OUTCOMES,
  type ContractField,
  type FactorType,
  type PolicyFallback,
  type PolicyOutcome,
  type PolicyRule,
} from './types.js';

export interface LoadedPolicy {
  rules: PolicyRule[];
  fallback: PolicyFallback;
}

export interface RuleInput {
  name: string;
  enabled?: boolean | undefined;
  outcome: PolicyOutcome;
  factorType?: FactorType | null | undefined;
  applicationIds?: string[] | undefined;
  groupIds?: string[] | undefined;
  contractField?: ContractField | null | undefined;
  contractValues?: string[] | undefined;
  ipRanges?: string[] | undefined;
  daysOfWeek?: number[] | undefined;
  startMinute?: number | null | undefined;
  endMinute?: number | null | undefined;
  timezone?: string | null | undefined;
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
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
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
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone,
  };
}

/**
 * Rejects a rule that could never be honoured as written. This is where a bad
 * rule is caught; the engine's backstops exist for rows that predate the check
 * or arrive some other way, not as a substitute for it.
 */
function validate(input: RuleInput): void {
  if (input.outcome === 'require_factor' && !input.factorType) {
    throw new Error('factorType is required when the outcome is require_factor');
  }
  if (input.factorType && !(FACTOR_TYPES as string[]).includes(input.factorType)) {
    throw new Error(`unknown factorType: ${input.factorType}`);
  }
  if (input.contractField && !(CONTRACT_FIELDS as string[]).includes(input.contractField)) {
    throw new Error(`unknown contractField: ${input.contractField}`);
  }
  for (const day of input.daysOfWeek ?? []) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`daysOfWeek must hold integers 0..6, got ${day}`);
    }
  }
  for (const minute of [input.startMinute, input.endMinute]) {
    if (minute === null || minute === undefined) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) {
      throw new Error(`Minute must be an integer 0..1439, got ${minute}`);
    }
  }
  if (input.timezone && !isValidTimeZone(input.timezone)) {
    throw new Error(`timezone is not a zone this platform knows: ${input.timezone}`);
  }
  for (const range of input.ipRanges ?? []) {
    // A parse, which is what a syntax check is. Asking instead whether the
    // range happens to contain some probe address answers a different
    // question, and rejects 192.168.0.0/16, 172.16.0.0/12, 198.51.100.0/24 and
    // every literal host address — which is to say most of what a tenant
    // actually types into an office allowlist.
    if (!isIpRangeUsable(range)) {
      throw new Error(`ipRanges holds something that is not an address or CIDR: ${range}`);
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
  outcome: PolicyOutcome,
  factorType: FactorType | null | undefined,
): Promise<void> {
  if (outcome !== 'require_factor' || factorType !== 'webauthn') return;
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!tenant.primaryDomain) {
    throw new Error(
      'this tenant has no primary domain set, so security keys cannot be registered — set one before requiring them',
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
    return { rules: [], fallback: { outcome: 'allow', factorType: null } };
  }

  const rows = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    orderBy: { position: 'asc' },
  });

  const outcome = asOutcome(policy.defaultOutcome);
  return {
    rules: rows.map(toRule),
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
    throw new Error('factorType is required when the default outcome is require_factor');
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
  daysOfWeek: input.daysOfWeek ?? [],
  startMinute: input.startMinute ?? null,
  endMinute: input.endMinute ?? null,
  timezone: input.timezone ?? null,
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
    throw new Error('reorderRules must name every rule in the policy exactly once');
  }
  for (const row of existing) {
    if (!wanted.has(row.id)) {
      throw new Error('reorderRules must name every rule in the policy exactly once');
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
