import { z } from 'zod';
import { isIpRangeUsable } from './policy/ip-match.js';

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
  // Password attempts per minute per tenant per IP. Deployment-tuned rather
  // than fixed: a busy shared-NAT site needs headroom, and an end-to-end suite
  // signs in far more often than a person does. The default is the strict
  // value.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Attempts per minute per tenant, across every address at once.
  //
  // Spec section 12 asks for per-tenant *and* per-IP limiting, and the second
  // without the first is close to no limit at all: a wrong second factor
  // deliberately does not consume the attempt, so a six-digit TOTP code is
  // roughly twenty bits, and twenty bits guessed at the per-IP rate from a
  // thousand addresses is an afternoon. This is the ceiling that does not move
  // when the attacker rents more addresses.
  //
  // Defaults to ten times the per-IP allowance, so an operator who raises one
  // gets the other raised with it — an end-to-end suite that needs 200 per
  // address is not also asking to be capped at 10 per tenant.
  AUTH_RATE_LIMIT_TENANT_MAX: z.coerce.number().int().positive().optional(),
  /**
   * Which proxies may be believed about a request's source address.
   *
   * `request.ip` is the socket address unless Fastify is told otherwise, so
   * behind any reverse proxy every request carries the proxy's own address:
   * the policy engine's source-IP condition then matches everyone or nobody,
   * and every per-IP rate limit collapses into a single global bucket.
   *
   * A hop count ('1') or a list of trusted proxy addresses and CIDRs
   * ('10.0.0.0/8, 192.168.1.7'). Never a bare `true`, which trusts an
   * X-Forwarded-For header from anyone who sends one and hands every client a
   * source address of their choosing. Unset means no proxy is trusted, which
   * is correct for a deployment that has none.
   */
  TRUST_PROXY: z.string().trim().optional(),
});

/**
 * Turns TRUST_PROXY into what Fastify wants: `false`, a hop count, or a list
 * of trusted proxies. `true` is refused by name rather than quietly accepted,
 * because it is the one value that turns the source address into a
 * client-supplied string.
 */
function parseTrustProxy(raw: string | undefined): false | number | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') {
    throw new Error(
      'TRUST_PROXY must not be `true` — that trusts X-Forwarded-For from any client, letting anyone choose their own source address. Give a hop count (1) or the proxy addresses to trust (10.0.0.0/8).',
    );
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1) {
      throw new Error('TRUST_PROXY as a hop count must be 1 or more');
    }
    return hops;
  }
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const bad = entries.filter((entry) => !isIpRangeUsable(entry));
  if (entries.length === 0 || bad.length > 0) {
    throw new Error(
      `TRUST_PROXY must be a hop count or a list of addresses and CIDRs; this is neither: ${bad.join(', ') || raw}`,
    );
  }
  return entries.join(',');
}

export interface Config {
  databaseUrl: string;
  port: number;
  publicUrl: string;
  sessionSecret: string;
  masterKey: Buffer;
  smtpUrl: string;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
  /** false, a hop count, or a comma-separated list of trusted proxies. */
  trustProxy: false | number | string;
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
  let trustProxy: false | number | string;
  try {
    trustProxy = parseTrustProxy(v.TRUST_PROXY);
  } catch (cause) {
    // Same shape as every other configuration failure: one message, at
    // startup, naming the variable.
    throw new Error(
      `Invalid configuration — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return {
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    publicUrl: v.PUBLIC_URL,
    sessionSecret: v.SESSION_SECRET,
    masterKey: Buffer.from(v.MASTER_KEY, 'base64'),
    smtpUrl: v.SMTP_URL,
    authRateLimitMax: v.AUTH_RATE_LIMIT_MAX,
    authRateLimitTenantMax:
      v.AUTH_RATE_LIMIT_TENANT_MAX ?? v.AUTH_RATE_LIMIT_MAX * 10,
    trustProxy,
  };
}
