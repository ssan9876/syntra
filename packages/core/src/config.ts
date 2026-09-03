import { cookiesAreSecure } from './cookie-security.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isIpRangeUsable } from './policy/ip-match.js';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url(),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be >= 32 characters')
    // The example file's value is long enough to pass the length check, and a
    // copied .env that nobody edited would otherwise start with a secret that
    // is in the repository.
    .refine(
      (v) => !/^change-me/i.test(v),
      'SESSION_SECRET is the placeholder from .env.example; generate one with 32 random bytes, base64 encoded (see .env.example)',
    ),
  MASTER_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'MASTER_KEY must be 32 bytes, base64 encoded',
    ),
  SMTP_URL: z.string().url(),
  /**
   * A base64 32-byte key that signs audit checkpoints, and the id it is known
   * by. Optional, and deliberately so: a deployment that has not configured one
   * is honest about what its verification is worth -- `checkpointTrust` returns
   * `unsigned_no_signer_configured` and `integrityStatus` says so on the screen
   * in words. What is NOT acceptable is the state this key removes: the screen
   * telling an operator to configure a signing key while no configuration key
   * for one exists.
   *
   * Turning it on for the first time refuses the pre-existing unsigned
   * checkpoint once, walks from genesis once, raises one `critical` finding and
   * re-establishes a signed checkpoint. The finding clears on the following run.
   */
  GOVERN_CHECKPOINT_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'GOVERN_CHECKPOINT_KEY must be 32 bytes, base64 encoded',
    )
    .optional(),
  GOVERN_CHECKPOINT_KEY_ID: z.string().min(1).default('govern-checkpoint-1'),
  /**
   * Where the weekly anchor receipt goes. A directory for a write-once volume,
   * or an address. Neither configured means `runAnchorJob` returns
   * `not_configured` and the integrity screen states, in words, that nothing
   * protects against the operator -- which is true, and is why `AuditAnchor`'s
   * own schema comment calls anchoring the only protection against them.
   */
  GOVERN_ANCHOR_DIR: z.string().min(1).optional(),
  GOVERN_ANCHOR_EMAIL: z.string().email().optional(),
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
  /**
   * Whether outbound fetches to an administrator-supplied address may reach
   * this deployment's own network.
   *
   * Off by default. SAML metadata import and upstream OIDC discovery both
   * fetch a URL an administrator typed, and the import path echoes what it
   * read back to them — so by default a hostname resolving to loopback,
   * link-local, a private range or a unique-local range is refused, naming the
   * address so an operator can see why.
   *
   * A self-hosted deployment federating to an on-premises identity provider
   * genuinely needs this on, which is why it is a switch and not a rule.
   */
  /**
   * Where the built single-page application lives, so this process serves the
   * console and the portal as well as the API.
   *
   * Unset means it serves the API alone, which is what the test suite and
   * `pnpm dev` want — in development Vite is the origin and proxies the
   * server's prefixes here. Set, this becomes the whole deployment: one
   * origin, one port, no proxy in front, and no `vite` in front of real users.
   *
   * A path, not a switch, because the answer depends on how the tree was
   * laid out — a container copies `dist` somewhere flat, a checkout leaves it
   * under `apps/web`. A relative path is resolved against the working
   * directory.
   */
  WEB_ROOT: z.string().trim().min(1).optional(),

  /**
   * Where the in-console updater looks for releases, and what it authenticates
   * with. Both optional: an install that never sets them simply has no update
   * button, which is the correct behaviour for a development checkout and for
   * anybody who would rather update by hand.
   *
   * The token belongs here rather than in the vault, and the reason is worth
   * writing down because the spec proposed the vault. The vault is
   * TENANT-scoped, and this is a deployment-wide secret: filing it under
   * whichever tenant's administrator happened to configure it would make one
   * customer's keyring the thing the whole installation depends on. It also
   * sits beside MASTER_KEY, which unseals that vault -- so anybody who can
   * read this file already holds strictly more than this token grants, and
   * what it grants is read-only access to release assets in one repository.
   */
  RELEASE_REPO: z.string().trim().min(1).optional(),
  RELEASE_TOKEN: z.string().trim().min(1).optional(),
  /** Where the release layout lives. Only meaningful once syntra-install has run. */
  RELEASE_ROOT: z.string().trim().min(1).default('/opt/syntra'),
  /**
   * The bearer token a scraper presents at `/metrics`.
   *
   * Optional, and its absence is the OFF SWITCH: with no token the route is
   * never registered, so an installation that never opted in answers 404 like
   * any other path that does not exist. A route that answered 403 would be a
   * route whose existence is discoverable, and the existence of a metrics
   * endpoint tells somebody probing what this deployment is and how it is run.
   *
   * Sixteen characters minimum. A token short enough to guess is worse than no
   * metrics at all, because it reads as a control while granting a read of the
   * installation's shape.
   */
  METRICS_TOKEN: z.string().trim().min(16).optional(),
  OUTBOUND_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * Turns TRUST_PROXY into what Fastify wants: `false`, or a list of trusted
 * proxies. `true` is refused by name rather than quietly accepted, because it
 * is the one value that turns the source address into a client-supplied
 * string.
 *
 * A HOP COUNT IS REFUSED TOO, and that is newer than the rest of this
 * function. Fastify accepted a number until 5.12.1, which fixed
 * GHSA-3m5p-2c4r-xxw2 by making hop-count trust fail CLOSED: a count cannot
 * validate the immediate peer, so a direct client could supply enough hops to
 * choose its own `X-Forwarded-For`. The upstream fix now trusts NOTHING when
 * given a number. Accepting one here would therefore be accepting a value
 * whose meaning silently changed from "trust one proxy" to "trust no proxy" --
 * and the symptom of that is every per-IP rate limit collapsing into one
 * bucket and every source-address policy condition matching the proxy, which
 * is exactly the failure this variable exists to prevent, arriving quietly.
 * So it is refused loudly, with the address form to use instead.
 */
function parseTrustProxy(raw: string | undefined): false | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') {
    throw new Error(
      'TRUST_PROXY must not be `true` — that trusts X-Forwarded-For from any client, letting anyone choose their own source address. Give a hop count (1) or the proxy addresses to trust (10.0.0.0/8).',
    );
  }
  if (/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY must not be a hop count — Fastify stopped trusting them in 5.12.1 (GHSA-3m5p-2c4r-xxw2) because a count cannot check which proxy actually connected, and it now trusts nothing at all when given one. Name the proxies instead, as addresses or CIDRs: TRUST_PROXY=10.0.0.0/8 rather than TRUST_PROXY=${raw}.`,
    );
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
  /**
   * Whether cookies carry `Secure`, derived from `publicUrl`'s scheme.
   *
   * On the config rather than read from `process.env` at three cookie
   * definitions, which is what it replaced: NODE_ENV is a variable this
   * product's own configuration loader never sees, and the lab deployment
   * exports it nowhere.
   */
  cookieSecure: boolean;
  sessionSecret: string;
  masterKey: Buffer;
  smtpUrl: string;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
  /** Null when this deployment signs no checkpoints, which is a supported state. */
  governCheckpointKey: Buffer | null;
  governCheckpointKeyId: string;
  governAnchorDir: string | null;
  governAnchorEmail: string | null;
  /** false, or a comma-separated list of trusted proxies. Never a hop count. */
  trustProxy: false | string;
  outboundAllowPrivate: boolean;
  /** Absolute path to the built web application, or null to serve the API alone. */
  webRoot: string | null;
  /** Null disables the update button entirely rather than offering a broken one. */
  releaseRepo: string | null;
  releaseToken: string | null;
  /** Null means `/metrics` is not registered at all. */
  metricsToken: string | null;
  releaseRoot: string;
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
  let trustProxy: false | string;
  try {
    trustProxy = parseTrustProxy(v.TRUST_PROXY);
  } catch (cause) {
    // Same shape as every other configuration failure: one message, at
    // startup, naming the variable.
    throw new Error(
      `Invalid configuration — ${cause instanceof Error ? cause.message : String(cause)}`,
      // The original is kept as the cause. The message above is what an
      // operator reads; the chain is what somebody debugging a parse failure
      // needs, and rethrowing without it discards the only stack there was.
      { cause },
    );
  }

  return {
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    publicUrl: v.PUBLIC_URL,
    cookieSecure: cookiesAreSecure(v.PUBLIC_URL),
    sessionSecret: v.SESSION_SECRET,
    masterKey: Buffer.from(v.MASTER_KEY, 'base64'),
    smtpUrl: v.SMTP_URL,
    governCheckpointKey:
      v.GOVERN_CHECKPOINT_KEY === undefined
        ? null
        : Buffer.from(v.GOVERN_CHECKPOINT_KEY, 'base64'),
    governCheckpointKeyId: v.GOVERN_CHECKPOINT_KEY_ID,
    governAnchorDir: v.GOVERN_ANCHOR_DIR ?? null,
    governAnchorEmail: v.GOVERN_ANCHOR_EMAIL ?? null,
    authRateLimitMax: v.AUTH_RATE_LIMIT_MAX,
    authRateLimitTenantMax:
      v.AUTH_RATE_LIMIT_TENANT_MAX ?? v.AUTH_RATE_LIMIT_MAX * 10,
    trustProxy,
    outboundAllowPrivate: v.OUTBOUND_ALLOW_PRIVATE,
    // Resolved here rather than where it is used, so the value the rest of the
    // process sees does not depend on the working directory at the moment it
    // is read.
    webRoot: v.WEB_ROOT === undefined ? null : resolve(v.WEB_ROOT),
    releaseRepo: v.RELEASE_REPO ?? null,
    releaseToken: v.RELEASE_TOKEN ?? null,
    metricsToken: v.METRICS_TOKEN ?? null,
    releaseRoot: v.RELEASE_ROOT,
  };
}
