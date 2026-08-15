import { z } from 'zod';

export const policyOutcome = z.enum(['allow', 'require_mfa', 'require_factor', 'deny']);
export const policyFactorType = z.enum(['totp', 'webauthn']);
export const contractField = z.enum(['department', 'jobTitle', 'employer', 'location']);

const minuteOfDay = z.number().int().min(0).max(1439);

export const policyRuleRequest = z
  .object({
    name: z.string().min(1).max(128),
    enabled: z.boolean().default(true),
    outcome: policyOutcome,
    factorType: policyFactorType.nullable().default(null),
    applicationIds: z.array(z.string().uuid()).default([]),
    groupIds: z.array(z.string().uuid()).default([]),
    contractField: contractField.nullable().default(null),
    contractValues: z.array(z.string().min(1).max(256)).default([]),
    ipRanges: z.array(z.string().min(1).max(64)).default([]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
    startMinute: minuteOfDay.nullable().default(null),
    endMinute: minuteOfDay.nullable().default(null),
    timezone: z.string().max(64).nullable().default(null),
  })
  .refine((v) => v.outcome !== 'require_factor' || v.factorType !== null, {
    message: 'Choose which factor this rule requires',
    path: ['factorType'],
  })
  .refine((v) => (v.startMinute === null) === (v.endMinute === null), {
    message: 'A time window needs both a start and an end',
    path: ['endMinute'],
  })
  .refine((v) => v.contractField === null || v.contractValues.length > 0, {
    message: 'Name at least one value to match',
    path: ['contractValues'],
  });
export type PolicyRuleRequest = z.input<typeof policyRuleRequest>;

export const policyDefaultRequest = z
  .object({
    outcome: policyOutcome,
    factorType: policyFactorType.nullable().default(null),
  })
  .refine((v) => v.outcome !== 'require_factor' || v.factorType !== null, {
    message: 'Choose which factor the default requires',
    path: ['factorType'],
  });
export type PolicyDefaultRequest = z.input<typeof policyDefaultRequest>;

export const reorderRulesRequest = z.object({
  ruleIds: z.array(z.string().uuid()).min(1),
});

export const ruleParams = z.object({ ruleId: z.string().uuid() });
