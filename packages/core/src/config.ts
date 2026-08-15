import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be >= 32 characters'),
  MASTER_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'MASTER_KEY must be 32 bytes, base64 encoded',
    ),
  SMTP_URL: z.string().url(),
  // Password attempts per minute per IP. Deployment-tuned rather than fixed:
  // a busy shared-NAT site needs headroom, and an end-to-end suite signs in
  // far more often than a person does. The default is the strict value.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export interface Config {
  databaseUrl: string;
  port: number;
  publicUrl: string;
  sessionSecret: string;
  masterKey: Buffer;
  smtpUrl: string;
  authRateLimitMax: number;
}

/**
 * Parses and validates the environment. Every module reads configuration
 * through this; nothing else touches process.env directly, so a missing or
 * malformed value fails once at startup rather than at first use.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${detail}`);
  }

  const v = parsed.data;
  return {
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    publicUrl: v.PUBLIC_URL,
    sessionSecret: v.SESSION_SECRET,
    masterKey: Buffer.from(v.MASTER_KEY, 'base64'),
    smtpUrl: v.SMTP_URL,
    authRateLimitMax: v.AUTH_RATE_LIMIT_MAX,
  };
}
