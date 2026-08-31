import type { TenantClient } from '@syntra/db';
import { endSessions } from '../auth/end-sessions.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-token.js';
import { currentTenant } from '../tenant-context.js';
import { DEFAULT_PAGE_SIZE, type ListOptions } from '../list.js';

export type UserStatus = 'active' | 'inactive';

export interface CreateUserInput {
  login: string;
  email: string;
  displayName: string;
  orgUnitId?: string | undefined;
}

export async function createUser(tx: TenantClient, input: CreateUserInput) {
  // Checked explicitly rather than relying on the unique constraints, so the
  // caller gets a domain error it can map to 409 instead of a driver error.
  // Case-insensitive because the index behind it is: a login that differs only
  // in case is the same login to everyone except Postgres, and two accounts
  // that read identically on screen could both sign in.
  const existing = await tx.user.findFirst({
    where: { login: { equals: input.login, mode: 'insensitive' } },
  });
  if (existing) {
    throw new Error(`login already exists: ${input.login}`);
  }

  // Active, locally managed accounts only, matching the partial index.
  //
  // A directory owns the addresses on the accounts it syncs, and Syntra
  // refusing one of them would fail a sync run mid-apply over a shared mailbox
  // somebody set up years ago — stopping a typo is not worth breaking a run.
  //
  // Active, because this directory deactivates rather than deletes: a leaver's
  // account would otherwise reserve their address for ever, and the person
  // hired into their post could not be created with the mailbox they have been
  // given. The rule is "no second USABLE account on one address"; an inactive
  // account is a record, not a login.
  const sharing = await tx.user.findFirst({
    where: {
      email: { equals: input.email, mode: 'insensitive' },
      sourceId: null,
      status: 'active',
    },
  });
  if (sharing) {
    throw new Error(`email already in use: ${input.email}`);
  }

  const tenantId = await currentTenant(tx);
  return tx.user.create({
    data: {
      tenantId,
      login: input.login,
      email: input.email,
      displayName: input.displayName,
      orgUnitId: input.orgUnitId ?? null,
    },
  });
}

export async function findUserByLogin(tx: TenantClient, login: string) {
  return tx.user.findFirst({ where: { login } });
}

/**
 * One page of accounts, and the total behind it.
 *
 * `status` is the filter this already had; it moves into the shared options bag
 * rather than keeping a signature of its own, so a caller that pages and a
 * caller that filters are writing the same call.
 */
export async function listUsers(tx: TenantClient, opts: ListOptions = {}) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const search = opts.search?.trim();

  const where = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(search
      ? {
          OR: [
            { login: { contains: search, mode: 'insensitive' as const } },
            { displayName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    tx.user.findMany({
      where,
      orderBy: { login: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    tx.user.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/**
 * Deactivation, never deletion. A directory is a record: an account that
 * existed must remain visible and auditable after it stops being usable.
 *
 * Every credential derived from the account goes with it, in the same
 * transaction as the status change — the same shape `completePasswordReset`
 * uses, and for the same reason. Deactivating an account whose session
 * survives is not offboarding: an administrator's session is good for two
 * hours of privileged writes, and "they cannot sign in again" is no comfort
 * to the tenant whose policy rules they are still editing. The status flip and
 * the revocation commit together, because a deactivation with the sessions
 * left behind is worse than no deactivation at all — it reads as done.
 *
 * The row-level check in `resolveSession` is the other half: it covers a
 * session issued before this fix existed, and any future path that creates one
 * without coming past here.
 */
export async function deactivateUser(
  tx: TenantClient,
  id: string,
  reason: string,
) {
  const user = await tx.user.update({
    where: { id },
    data: { status: 'inactive', statusReason: reason },
  });
  // Sessions, refresh tokens, and every relying party that asked to be told.
  // A leaver's refresh token outliving their sessions is the gap this
  // originally closed by hand; a relying party's session outliving both is the
  // one it could not reach.
  await endSessions(tx, id, { trigger: 'deactivation' });
  return user;
}

export async function reactivateUser(tx: TenantClient, id: string) {
  return tx.user.update({
    where: { id },
    data: { status: 'active', statusReason: null },
  });
}
