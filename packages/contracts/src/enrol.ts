import { z } from 'zod';

export const enrolBeginRequest = z.object({
  attemptToken: z.string().min(1).max(256),
});
export type EnrolBeginRequest = z.infer<typeof enrolBeginRequest>;

export const enrolTotpConfirmRequest = z.object({
  attemptToken: z.string().min(1).max(256),
  code: z.string().min(6).max(6),
});
export type EnrolTotpConfirmRequest = z.infer<typeof enrolTotpConfirmRequest>;

export const enrolWebauthnFinishRequest = z.object({
  attemptToken: z.string().min(1).max(256),
  label: z.string().min(1).max(64).default('Security key'),
  response: z.record(z.unknown()),
});
export type EnrolWebauthnFinishRequest = z.input<typeof enrolWebauthnFinishRequest>;

export const ruleImpactResponse = z.object({
  totalActiveUsers: z.number(),
  matchedUsers: z.number(),
  usersNeedingEnrolment: z.number(),
  unevaluatedConditions: z.array(z.string()),
});
export type RuleImpactResponse = z.infer<typeof ruleImpactResponse>;
