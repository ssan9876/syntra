import { PASSWORD_SYNC_TARGET_TYPES, oplog, targetPasswordResetFor } from '@syntra/connectors';
import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from '../provision/target-service.js';
import { assertExternalWritesAllowed } from '../provision/tenant-write-stop.js';
import { ExternalWritesPausedError } from '../provision/target-write-stop.js';
import { adapterWriteContext } from '../provision/adapter-rollout.js';

export type PasswordSyncTrigger = 'change' | 'reset' | 'renewal' | 'admin_set';

export interface PushPasswordInput {
  userId: string;
  /** Never logged, stored, or included in a message or an audit payload. */
  newPassword: string;
  /** Ask each target to make the person choose another at next sign-in. */
  requireChange: boolean;
  actorUserId: string | null;
  sourceIp: string | null;
  trigger: PasswordSyncTrigger;
  /**
   * Something already holds the new password (a directory source's write-back),
   * so a policy refusal can no longer stop the change and is only reported.
   */
  alreadyApplied?: boolean;
  /** Targets paired with this directory source are skipped: it was written already. */
  excludePairedSourceId?: string | null;
}

export interface PasswordSyncResult {
  targetSystemId: string;
  targetName: string;
  result: 'synced' | 'skipped' | 'failed';
  /** Safe to show the person and to log. */
  message: string;
}

export type PushPasswordOutcome =
  | { ok: true; results: PasswordSyncResult[] }
  /** The first target written refused the password. Nothing was changed anywhere. */
  | { ok: false; rejectedBy: { targetSystemId: string; targetName: string; message: string } };

/** Accounts that exist at the target. Pending, archived and deleted ones are left alone. */
const LIVE_STATUSES = ['active', 'disabled'];

/**
 * Sets a person's new Syntra password on their account at every target with
 * `syncPassword` on, before Syntra's own hash is written.
 *
 * Active Directory goes first, then Entra ID: a domain's policy is usually the
 * stricter, and a refusal from the first target written stops the change with
 * nothing applied. Once any target holds the new password, later failures are
 * recorded and returned, and the caller commits.
 *
 * One target at a time, no retry. Each result is audited as
 * `auth.password_synced` or `auth.password_sync_failed`.
 */
export async function pushPasswordToTargets(
  tenantId: string,
  provider: MasterKeyProvider,
  input: PushPasswordInput,
): Promise<PushPasswordOutcome> {
  const accounts = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { personId: true },
    });
    if (!user?.personId) return { personId: null, rows: [] };
    const rows = await tx.targetAccount.findMany({
      where: {
        personId: user.personId,
        anchor: { not: null },
        status: { in: LIVE_STATUSES },
        target: {
          syncPassword: true,
          enabled: true,
          type: { in: [...PASSWORD_SYNC_TARGET_TYPES] },
          ...(input.excludePairedSourceId
            ? { NOT: { pairedDirectorySourceId: input.excludePairedSourceId } }
            : {}),
        },
      },
      select: {
        anchor: true,
        target: {
          select: {
            id: true,
            name: true,
            type: true,
            config: true,
            externalWritesPausedAt: true,
            externalWritesPauseReason: true,
            externalWritesPauseExpiresAt: true,
            adapterChannel: true,
            adapterVersionPin: true,
            deprecationOverrideVersion: true,
            deprecationOverrideReason: true,
            deprecationOverrideExpiresAt: true,
          },
        },
      },
    });
    return { personId: user.personId, rows };
  });

  const ordered = [...accounts.rows].sort(
    (a, b) =>
      Number(a.target.type !== 'activeDirectory') - Number(b.target.type !== 'activeDirectory') ||
      a.target.name.localeCompare(b.target.name),
  );

  const results: PasswordSyncResult[] = [];
  let applied = input.alreadyApplied === true;

  for (const { anchor, target } of ordered) {
    const named = `Target "${target.name}"`;
    const record = async (
      result: PasswordSyncResult['result'],
      message: string,
      failure?: string,
    ) => {
      await withTenant(tenantId, (tx) =>
        recordEvent(tx, {
          actorUserId: input.actorUserId,
          action: result === 'synced' ? 'auth.password_synced' : 'auth.password_sync_failed',
          targetType: 'User',
          targetId: input.userId,
          outcome: result === 'synced' ? 'success' : 'failure',
          sourceIp: input.sourceIp,
          payload: {
            targetSystemId: target.id,
            personId: accounts.personId,
            trigger: input.trigger,
            result,
            ...(failure === undefined ? {} : { failure }),
            ...(result === 'synced' ? {} : { message }),
          },
        }),
      );
      if (result === 'failed') {
        oplog('warn', `password sync failed: ${message}`, {
          tenantId,
          targetSystemId: target.id,
          personId: accounts.personId,
        });
      }
    };

    // The same gates as any other write to this target.
    const blocked = await withTenant(tenantId, async (tx) => {
      try {
        await assertExternalWritesAllowed(tx, target);
      } catch (cause) {
        if (cause instanceof ExternalWritesPausedError) {
          return `external writes are paused on ${named}`;
        }
        throw cause;
      }
      const adapter = adapterWriteContext(target);
      return adapter.writesBlockedReason;
    });
    if (blocked !== null) {
      const message = `Skipped: ${blocked}.`;
      results.push({ targetSystemId: target.id, targetName: target.name, result: 'skipped', message });
      await record('skipped', message, 'blocked');
      continue;
    }

    const reset = targetPasswordResetFor(target.type)!;
    const config = await withTenant(tenantId, (tx) =>
      targetWithCredential(tx, provider, target.id),
    );
    if (!config) {
      const message = `Password not updated on ${named}: it has no credential.`;
      results.push({ targetSystemId: target.id, targetName: target.name, result: 'failed', message });
      await record('failed', message, 'no_credential');
      continue;
    }

    // No transaction is held: this is network I/O.
    const written = await reset
      .resetPassword(config as never, {
        anchor: anchor!,
        newPassword: input.newPassword,
        requireChange: input.requireChange,
      })
      .catch(() => ({ ok: false as const, failure: 'transient' as const, message: 'the target could not be reached' }));

    if (written.ok) {
      applied = true;
      results.push({
        targetSystemId: target.id,
        targetName: target.name,
        result: 'synced',
        message: `Password updated on ${named}.`,
      });
      await record('synced', 'synced');
      continue;
    }

    if (written.failure === 'policy' && !applied) {
      const message = `${named} refused the new password. Choose another password.`;
      await record('failed', message, 'policy_blocked');
      return {
        ok: false,
        rejectedBy: { targetSystemId: target.id, targetName: target.name, message },
      };
    }

    const skipped = written.failure === 'unsupported';
    const message = skipped
      ? `Skipped ${named}: ${written.message}.`
      : `Password not updated on ${named}: ${written.message}.`;
    results.push({
      targetSystemId: target.id,
      targetName: target.name,
      result: skipped ? 'skipped' : 'failed',
      message,
    });
    await record(skipped ? 'skipped' : 'failed', message, written.failure ?? 'transient');
  }

  return { ok: true, results };
}

/**
 * Records that targets hold a password Syntra's own hash does not, after the
 * local write failed. The same event a directory source's write-back records.
 */
export async function recordPasswordSyncDesync(
  tenantId: string,
  input: { userId: string; actorUserId: string | null; sourceIp: string | null },
  results: PasswordSyncResult[],
  cause: unknown,
): Promise<void> {
  const synced = results.filter((r) => r.result === 'synced').map((r) => r.targetSystemId);
  if (synced.length === 0) return;
  await withTenant(tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'auth.password_writeback_desync',
      targetType: 'User',
      targetId: input.userId,
      outcome: 'failure',
      sourceIp: input.sourceIp,
      payload: {
        targetSystemIds: synced,
        localApplied: false,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
    }),
  );
}
