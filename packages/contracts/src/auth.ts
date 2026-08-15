import { z } from 'zod';

export const loginRequest = z.object({
  login: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const elevateRequest = z.object({
  password: z.string().min(1).max(1024),
});
export type ElevateRequest = z.infer<typeof elevateRequest>;

export const sessionResponse = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  scope: z.enum(['portal', 'admin']),
  mayElevate: z.boolean(),
  permissions: z.array(z.string()),
});
export type SessionResponse = z.infer<typeof sessionResponse>;
