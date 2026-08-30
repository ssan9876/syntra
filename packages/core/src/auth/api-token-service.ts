import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/**
 * The prefix every machine token carries.
 *
 * Not decoration. A prefix means a leaked token is RECOGNISABLE — in a log, in
 * a paste, to a secret scanner watching a repository — as a Syntra credential
 * rather than as an opaque blob nobody investigates. It also lets a support
 * conversation name what somebody is holding without either party seeing it.
 */
export const API_TOKEN_PREFIX = 'syntra_pat_';

/**
 * SHA-256, deliberately not Argon2id.
 *
 * The same argument `hashClientSecret` makes, and it holds for the same
 * reason: this is 256 bits drawn from `randomBytes`, not a human-chosen
 * password. There is no dictionary to grind, so a memory-hard KDF buys nothing
 * against it — and it costs something real, because a token is verified on
 * EVERY API request rather than once per sign-in. Argon2id here is a latency
 * floor under every integration this product has.
 *
 * The reasoning does not transfer to `PasswordCredential`, which stays
 * Argon2id, because a human-chosen password is exactly the case a memory-hard
 * KDF exists for.
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time, so the digest lookup cannot become a timing oracle. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface IssuedToken {
  id: string;
  /** The only time this value exists outside the caller's hands. */
  token: string;
  expiresAt: Date | null;
}

export interface IssueApiTokenInput {
  userId: string;
  name: string;
  /** Intersected with the account's roles. Empty means the account's own. */
  scopes: string[];
  expiresAt: Date | null;
  createdBy: string | null;
}

/**
 * Mints a token and returns it ONCE.
 *
 * The value is not stored and cannot be recovered. A caller that loses it
 * issues another and revokes this one, which is the same contract a client
 * secret has and for the same reason: a credential that can be read back is a
 * credential every future reader of the database holds.
 */
export async function issueApiToken(
  tx: TenantClient,
  input: IssueApiTokenInput,
): Promise<IssuedToken> {
  const tenantId = await currentTenant(tx);
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

  const row = await tx.apiToken.create({
    data: {
      tenantId,
      userId: input.userId,
      name: input.name,
      tokenHash: hashApiToken(token),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    },
  });

  return { id: row.id, token, expiresAt: row.expiresAt };
}

export interface ResolvedApiToken {
  id: string;
  userId: string;
  /** Empty means "whatever the account holds". */
  scopes: string[];
}

/**
 * The token behind a presented value, or null.
 *
 * ONE SHAPE OF NULL. Unknown, revoked, expired and malformed all return the
 * same nothing, so a caller — and anybody probing through a caller — learns
 * that the credential did not work and not which of the four it was. The audit
 * log records the distinction; the answer on the wire does not.
 */
export async function resolveApiToken(
  tx: TenantClient,
  token: string,
  now: Date = new Date(),
): Promise<ResolvedApiToken | null> {
  // Checked before the query. A value without the prefix is not a token this
  // product ever issued, and hashing it to find out is work done on behalf of
  // whoever sent it.
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;

  const digest = hashApiToken(token);
  const row = await tx.apiToken.findUnique({ where: { tokenHash: digest } });
  if (!row) return null;

  // The lookup above is already an equality match on an indexed column, so
  // this is belt and braces against a future reader that switches to a
  // scan-and-compare and reintroduces a timing signal.
  if (!digestsEqual(row.tokenHash, digest)) return null;

  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;

  return { id: row.id, userId: row.userId, scopes: row.scopes };
}

/** How stale `lastUsedAt` may be before another write is worth it. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Records that a token was used, at most once a minute.
 *
 * A busy integration would otherwise turn every read of the API into a write,
 * and "used within the last minute" is exactly as useful as "used at
 * 14:03:22.481" for the only question this column answers: is anything still
 * using this credential?
 *
 * The staleness test is IN THE `where`, not read-then-write. Two concurrent
 * requests both pass a read-then-write and both write; this lets the database
 * settle it, and a losing update simply matches no rows.
 */
export async function touchApiToken(
  tx: TenantClient,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.apiToken.updateMany({
    where: {
      id,
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(now.getTime() - TOUCH_INTERVAL_MS) } },
      ],
    },
    data: { lastUsedAt: now },
  });
}

/** Returns whether anything changed, so a route can answer 404 for a no-op. */
export async function revokeApiToken(tx: TenantClient, id: string): Promise<boolean> {
  const { count } = await tx.apiToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

export interface ApiTokenView {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}

/**
 * An account's live tokens, newest first.
 *
 * Never the digest. There is no screen on which the stored hash of a
 * credential is a thing anybody needs, and putting it in a response is one
 * copy-paste away from putting it in a bug report.
 */
export async function listApiTokens(
  tx: TenantClient,
  userId: string,
): Promise<ApiTokenView[]> {
  const rows = await tx.apiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }));
}
