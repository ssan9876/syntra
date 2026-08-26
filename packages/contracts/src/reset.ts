import { z } from "zod";

export const resetRequestRequest = z.object({
  login: z.string().min(1).max(320),
});

export const resetPreflightRequest = z.object({
  token: z.string().min(1).max(256),
});

export const resetCompleteRequest = z.object({
  token: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(1024),
  factor: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("totp"), code: z.string().min(6).max(6) }),
      z.object({
        type: z.literal("recovery_code"),
        code: z.string().min(1).max(64),
      }),
      z.object({
        type: z.literal("webauthn"),
        assertion: z.record(z.unknown()),
      }),
    ])
    .optional(),
});
export type ResetCompleteRequest = z.input<typeof resetCompleteRequest>;

export const resetPreflightResponse = z.object({
  valid: z.boolean(),
  requiresFactor: z.boolean(),
  acceptableFactors: z.array(z.enum(["totp", "webauthn", "recovery_code"])),
});
export type ResetPreflightResponse = z.infer<typeof resetPreflightResponse>;

/**
 * `.strict()`. This is the request that decides whether Syntra holds an
 * account's password at all, and there is nothing in it that should be dropped
 * without telling the caller.
 */
export const patchUserRequest = z
  .object({
    passwordSource: z.enum(["local", "upstream"]).optional(),
    passwordSourceHint: z.string().max(256).nullable().optional(),
  })
  .strict();
export type PatchUserRequest = z.input<typeof patchUserRequest>;
