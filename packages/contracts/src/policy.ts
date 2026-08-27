import { z } from 'zod';

/**
 * What the tenant default may be. `federate` is deliberately absent: a
 * fallback that federates would send every unmatched sign-in — including one
 * with no login typed — to an upstream, and `loadPolicy` narrows an
 * unrecognised default to `deny`, so it could not be read back anyway.
 */
export const policyOutcome = z.enum(['allow', 'require_mfa', 'require_factor', 'deny']);

/**
 * What a *rule* may be, which is the same set plus `federate`.
 *
 * Without this a routing rule could not be written through the API at all —
 * Task 14 added the column, the service validation and the evaluator, and
 * left the one enum that gates the endpoint behind. A federate rule chooses
 * which upstream identity provider a login goes to; it authorizes nothing,
 * and `loadPolicy` keeps those rows out of `evaluatePolicy` entirely.
 */
export const policyRuleOutcome = z.enum([
  'allow',
  'require_mfa',
  'require_factor',
  'deny',
  'federate',
]);
/**
 * Kept in step with `FACTOR_TYPES` in the policy engine by hand, because the
 * contracts package cannot import from core. A factor the engine knows and
 * this enum does not is a factor no rule can name from the console — which is
 * what happened to `email_otp` between its being added and being listed here.
 */
export const policyFactorType = z.enum(['totp', 'webauthn', 'email_otp']);
export const contractField = z.enum(['department', 'jobTitle', 'employer', 'location']);

const minuteOfDay = z.number().int().min(0).max(1439);

export const policyRuleRequest = z
  .object({
    name: z.string().min(1).max(128),
    enabled: z.boolean().default(true),
    outcome: policyRuleOutcome,
    factorType: policyFactorType.nullable().default(null),
    applicationIds: z.array(z.string().uuid()).default([]),
    groupIds: z.array(z.string().uuid()).default([]),
    contractField: contractField.nullable().default(null),
    contractValues: z.array(z.string().min(1).max(256)).default([]),
    ipRanges: z.array(z.string().min(1).max(64)).default([]),
    devicePlatforms: z
      .array(z.enum(['windows', 'macos', 'linux', 'ios', 'android', 'other']))
      .default([]),
    countries: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z]{2}$/, { message: 'Use a two-letter country code, like NL' }),
      )
      .max(64)
      .default([]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
    startMinute: minuteOfDay.nullable().default(null),
    endMinute: minuteOfDay.nullable().default(null),
    timezone: z.string().max(64).nullable().default(null),
    /** Required on a federate rule, refused on any other. */
    upstreamIdpId: z.string().uuid().nullable().default(null),
    /**
     * The domain part of the login identifier — `acme.test` for
     * `jo@acme.test`. Matched whole and exactly; a suffix match would send
     * `x@notacme.test` to acme's upstream.
     */
    loginDomains: z
      .array(
        z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
            message: 'Use a bare lower-case domain, with no @ and no scheme',
          }),
      )
      .max(32)
      .default([]),
  })
  .refine((v) => v.outcome !== 'require_factor' || v.factorType !== null, {
    message: 'Choose which factor this rule requires',
    path: ['factorType'],
  })
  // The same four rules `policy-service.ts` enforces, refused here as a 400
  // with a field path rather than there as a message with none. The service
  // keeps its copy: it is reachable from the seed and from any future caller,
  // and a check that exists in only one of the two is a check that moves.
  .refine((v) => v.outcome !== 'federate' || v.upstreamIdpId !== null, {
    message: 'Choose which identity provider this rule sends people to',
    path: ['upstreamIdpId'],
  })
  .refine((v) => v.outcome === 'federate' || v.upstreamIdpId === null, {
    message: 'Only a federate rule names an upstream identity provider',
    path: ['upstreamIdpId'],
  })
  .refine((v) => v.outcome === 'federate' || v.loginDomains.length === 0, {
    message: 'Only a federate rule matches on a login domain',
    path: ['loginDomains'],
  })
  .refine(
    // The upstream is chosen before anybody is identified, so there is no
    // user to look a group, a contract or an enrolled factor up for.
    (v) =>
      v.outcome !== 'federate' ||
      (v.groupIds.length === 0 && v.contractField === null && v.factorType === null),
    {
      message:
        'A federate rule is evaluated before the user is known, so it cannot match on group membership or a contract attribute, and it cannot require a factor',
      path: ['outcome'],
    },
  )
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
