import { ldapWriteback, type WritebackFailure } from '@syntra/connectors';
import { withTenant } from '@syntra/db';
import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { sourceWithPassword } from '../sync/source-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { revokeAllForUser } from '../auth/session-service.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-token.js';
import { deactivateUser, reactivateUser } from './user-service.js';

/**
 * Deactivating a user whose account is owned by a directory source, and
 * meaning it.
 *
 * The console has always refused this, and the refusal was honest: `diff.ts`
 * proposes `reactivate_user` for any matched object that is not active, so a
 * status flipped here was undone by the next sync run. Two things had to
 * change before a button could exist. Sync now reads the source's own disabled
 * state and will not resurrect an account the source reports disabled; and
 * this writes the disable THROUGH to the source, so that what sync reads next
 * agrees with what Syntra decided.
 *
 * Either half alone is worse than neither. The write-back without the sync
 * guard is undone on the run between the write and the next read; the guard
 * without the write-back leaves Syntra and the directory permanently
 * disagreeing about whether somebody works here.
 */

export type DeactivateOutcome =
  | { ok: true; viaDirectory: boolean; ladderStarted: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'writeback_not_enabled'; sourceName: string }
  | { ok: false; reason: 'no_credential'; sourceName: string }
  | { ok: false; reason: 'directory_failed'; failure: WritebackFailure; message: string };

export interface DeactivateInput {
  userId: string;
  reason: string;
  actorUserId: string;
  sourceIp?: string | undefined;
}

interface Resolved {
  user: { id: string; login: string; personId: string | null; sourceAnchor: string | null };
  sourceId: string | null;
  sourceName: string;
  writes: boolean;
}

async function resolve(tx: TenantClient, userId: string): Promise<Resolved | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, login: true, personId: true, sourceId: true, sourceAnchor: true },
  });
  if (!user) return null;
  if (user.sourceId === null) {
    return {
      user,
      sourceId: null,
      sourceName: '',
      writes: false,
    };
  }
  const source = await tx.directorySource.findUnique({
    where: { id: user.sourceId },
    select: { id: true, name: true, writebackEnabled: true, writebackDisable: true },
  });
  return {
    user,
    sourceId: user.sourceId,
    sourceName: source?.name ?? 'the directory source',
    writes: Boolean(source?.writebackEnabled && source.writebackDisable),
  };
}

/**
 * The shared body of deactivate and reactivate.
 *
 * The directory is written FIRST, outside any transaction, and the local
 * change happens only if that succeeded.
 *
 * Outside a transaction because an LDAP round trip inside a Prisma interactive
 * transaction spends the 5,000 ms budget on somebody else's network. First
 * because of what each ordering does when it fails halfway: directory-then-
 * local leaves a failure with nothing changed anywhere and an account exactly
 * as it was, while local-then-directory leaves Syntra believing something the
 * directory never agreed to -- which is the divergence this whole feature
 * exists to remove.
 */
async function writeThrough(
  tenantId: string,
  provider: MasterKeyProvider,
  input: DeactivateInput,
  enabled: boolean,
): Promise<DeactivateOutcome> {
  const resolved = await withTenant(tenantId, (tx) => resolve(tx, input.userId));
  if (!resolved) return { ok: false, reason: 'not_found' };

  // A locally-managed account has no directory to write to and never had the
  // problem this function exists for. It takes the path it always took.
  if (resolved.sourceId === null) {
    await withTenant(tenantId, async (tx) => {
      if (enabled) await reactivateUser(tx, input.userId);
      else await deactivateUser(tx, input.userId, input.reason);
      await audit(tx, input, enabled, { viaDirectory: false });
    });
    return { ok: true, viaDirectory: false, ladderStarted: false };
  }

  // Refused rather than quietly done locally. A local-only status change on a
  // directory-managed account is precisely the state that produces the
  // sync-reactivates-them fight, and doing it silently would hand somebody a
  // button that appears to work and does not.
  if (!resolved.writes) {
    return {
      ok: false,
      reason: 'writeback_not_enabled',
      sourceName: resolved.sourceName,
    };
  }

  const config = await withTenant(tenantId, (tx) =>
    sourceWithPassword(tx, provider, resolved.sourceId!),
  );
  if (config === null) {
    return { ok: false, reason: 'no_credential', sourceName: resolved.sourceName };
  }

  const result = await ldapWriteback.setEnabled(config, {
    anchor: resolved.user.sourceAnchor ?? '',
    enabled,
    reason: input.reason,
  });
  if (!result.ok) {
    // Audited even though nothing changed: an administrator who clicked
    // Deactivate and got an error needs the attempt on the record, and a run
    // of these is how a broken bind is noticed.
    await withTenant(tenantId, (tx) =>
      audit(tx, input, enabled, {
        viaDirectory: true,
        outcome: 'failure',
        failure: result.failure ?? 'transient',
      }),
    );
    return {
      ok: false,
      reason: 'directory_failed',
      failure: result.failure ?? 'transient',
      message: result.message,
    };
  }

  const ladderStarted = await withTenant(tenantId, async (tx) => {
    if (enabled) await reactivateUser(tx, input.userId);
    else await deactivateUser(tx, input.userId, input.reason);

    // The person, not the login. Provision's ladder is anchored on a Person's
    // departure, and this is what carries an administrative deactivation onto
    // it: entitlement revocation, the archive into the deactivated OU, and
    // then the reap on the domain controller, all on the timers the target
    // already has configured.
    //
    // A user with no linked person is not an error and not a gap. They have no
    // contracts, no entitlement rules and no provisioned account; the disable
    // above is the whole of what there is to do for them.
    if (resolved.user.personId === null) return false;

    await tx.person.update({
      where: { id: resolved.user.personId },
      data: enabled
        ? { departureOverride: null, departureOverrideBy: null, departureOverrideNote: null }
        : {
            departureOverride: new Date(),
            departureOverrideBy: input.actorUserId,
            departureOverrideNote: input.reason,
          },
    });
    return true;
  });

  await withTenant(tenantId, (tx) =>
    audit(tx, input, enabled, { viaDirectory: true, ladderStarted }),
  );

  return { ok: true, viaDirectory: true, ladderStarted };
}

async function audit(
  tx: TenantClient,
  input: DeactivateInput,
  enabled: boolean,
  payload: Record<string, unknown> & { outcome?: 'success' | 'failure' },
): Promise<void> {
  const { outcome = 'success', ...rest } = payload;
  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: enabled ? 'user.reactivate' : 'user.deactivate',
    targetType: 'User',
    targetId: input.userId,
    outcome,
    sourceIp: input.sourceIp ?? null,
    payload: { reason: input.reason, ...rest },
  });
}

export function deactivateDirectoryUser(
  tenantId: string,
  provider: MasterKeyProvider,
  input: DeactivateInput,
): Promise<DeactivateOutcome> {
  return writeThrough(tenantId, provider, input, false);
}

export function reactivateDirectoryUser(
  tenantId: string,
  provider: MasterKeyProvider,
  input: DeactivateInput,
): Promise<DeactivateOutcome> {
  return writeThrough(tenantId, provider, input, true);
}

export type DeleteOutcome =
  | { ok: true; viaDirectory: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'delete_not_enabled'; sourceName: string }
  | { ok: false; reason: 'no_credential'; sourceName: string }
  | { ok: false; reason: 'directory_failed'; failure: WritebackFailure; message: string };

export interface DeleteInput {
  userId: string;
  actorUserId: string;
  sourceIp?: string | undefined;
}

interface ResolvedForDelete {
  user: { id: string; login: string; personId: string | null; sourceAnchor: string | null };
  sourceId: string | null;
  sourceName: string;
  deletes: boolean;
}

async function resolveForDelete(
  tx: TenantClient,
  userId: string,
): Promise<ResolvedForDelete | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, login: true, personId: true, sourceId: true, sourceAnchor: true },
  });
  if (!user) return null;
  if (user.sourceId === null) {
    return { user, sourceId: null, sourceName: '', deletes: false };
  }
  const source = await tx.directorySource.findUnique({
    where: { id: user.sourceId },
    select: { name: true, writebackEnabled: true, writebackDelete: true },
  });
  return {
    user,
    sourceId: user.sourceId,
    sourceName: source?.name ?? 'the directory source',
    // Both, as everywhere else: the master switch and the individual write.
    deletes: Boolean(source?.writebackEnabled && source.writebackDelete),
  };
}

/**
 * Deleting an account, and meaning it.
 *
 * Everything else in this directory deactivates. This is the one operation
 * that does not, which is why it is gated on a per-source flag of its own and
 * on a permission of its own.
 *
 * **The directory goes first**, outside any transaction, and Syntra's row goes
 * only if that succeeded. The reverse order has a failure this deployment has
 * already lived through: Syntra forgets an account the directory still holds,
 * and the next sync run reads it as a new object and creates it again. Writing
 * the directory first means a refusal leaves both sides exactly as they were.
 *
 * **The Person is deliberately untouched**, and so are their contracts. The
 * audit log is append-only and hash-chained, and an event naming a person who
 * no longer exists answers nothing: "who held this access in March" is the
 * question deletion must not cost the ability to answer, and keeping the
 * person is what makes destroying the login safe to offer at all.
 */
export async function deleteDirectoryUser(
  tenantId: string,
  provider: MasterKeyProvider,
  input: DeleteInput,
): Promise<DeleteOutcome> {
  const resolved = await withTenant(tenantId, (tx) =>
    resolveForDelete(tx, input.userId),
  );
  if (!resolved) return { ok: false, reason: 'not_found' };

  if (resolved.sourceId !== null) {
    // Refused rather than quietly done locally, for the same reason the
    // deactivate path refuses: a local-only change to a directory-managed
    // account is precisely what produces the sync-puts-it-back fight.
    if (!resolved.deletes) {
      return { ok: false, reason: 'delete_not_enabled', sourceName: resolved.sourceName };
    }

    const config = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, resolved.sourceId!),
    );
    if (config === null) {
      return { ok: false, reason: 'no_credential', sourceName: resolved.sourceName };
    }

    const result = await ldapWriteback.deleteObject(config, {
      anchor: resolved.user.sourceAnchor ?? '',
    });
    if (!result.ok) {
      // Audited even though nothing changed. Somebody who clicked Delete and
      // got an error needs the attempt on the record, and a run of these is
      // how a bind without delete rights gets noticed.
      await withTenant(tenantId, (tx) =>
        auditDelete(tx, input, resolved, 'failure', {
          failure: result.failure ?? 'transient',
        }),
      );
      return {
        ok: false,
        reason: 'directory_failed',
        failure: result.failure ?? 'transient',
        message: result.message,
      };
    }
  }

  await withTenant(tenantId, async (tx) => {
    // Audited BEFORE the row goes, so the event is written while the login is
    // still readable and records the name rather than a bare uuid.
    await auditDelete(tx, input, resolved, 'success', {
      viaDirectory: resolved.sourceId !== null,
    });

    // Revoked first, then removed. The revocation is what `deactivateUser`
    // does and it also reaches the OIDC artifacts hanging off the refresh
    // tokens, which a bare delete of these two tables would strand.
    await revokeAllForUser(tx, input.userId);
    await revokeAllRefreshTokensForUser(tx, input.userId);

    // REMOVED, not merely revoked, and this is where delete parts company
    // with deactivate. Both tables carry `userId` as a bare column with no
    // foreign key, so `user.delete` does not reach them, and a revoked row is
    // still a row: for a deactivated user it is history worth keeping, and for
    // a deleted one it points at an account that no longer exists.
    await tx.session.deleteMany({ where: { userId: input.userId } });
    await tx.refreshToken.deleteMany({ where: { userId: input.userId } });

    await tx.user.delete({ where: { id: input.userId } });
  });

  return { ok: true, viaDirectory: resolved.sourceId !== null };
}

async function auditDelete(
  tx: TenantClient,
  input: DeleteInput,
  resolved: ResolvedForDelete,
  outcome: 'success' | 'failure',
  payload: Record<string, unknown>,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'user.delete',
    targetType: 'User',
    targetId: input.userId,
    outcome,
    sourceIp: input.sourceIp ?? null,
    payload: {
      login: resolved.user.login,
      // Kept on the event so the surviving person can be found from it. The
      // row that pointed at them is about to stop existing.
      personId: resolved.user.personId,
      ...payload,
    },
  });
}
