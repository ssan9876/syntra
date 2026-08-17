import { SYNTRA_ONLY_ACTION_TYPES } from '@syntra/connectors';
import { withTenant } from '@syntra/db';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { SYNC_JOB, syncJobPayload } from '../sync/jobs.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { driftFingerprint } from './reconcile.js';

/**
 * The fourth part of the fingerprint for a Syntra-user link conflict.
 *
 * `driftFingerprint('unexpected_status', accountId, null)` is exactly the
 * fingerprint `reconcile` builds for account-status drift, so without a
 * subject of its own the two findings key on the same row and overwrite each
 * other on alternate runs — the dashboard showing one and never both.
 */
export const SYNTRA_USER_LINK_SUBJECT = 'syntra_user_link';

export interface ClaimSummary {
  claimed: number;
  conflicts: number;
}

interface LinkConflict {
  userId: string;
  linkedPersonId: string;
  accountId: string;
  accountPersonId: string;
}

interface ConflictDetail {
  reason: string;
  userId: string;
  linkedPersonId: string;
  accountPersonId: string;
}

const CONFLICT_REASON =
  'the Syntra user carrying this account anchor is already linked to a different ' +
  'person, so this login is not deactivated when the account holder leaves and is ' +
  'deactivated when somebody else does';

function conflictDetail(conflict: LinkConflict): ConflictDetail {
  return {
    reason: CONFLICT_REASON,
    userId: conflict.userId,
    linkedPersonId: conflict.linkedPersonId,
    accountPersonId: conflict.accountPersonId,
  };
}

/**
 * Every field the detail carries, compared one by one.
 *
 * Not a JSON string comparison: `detail` comes back out of a `jsonb` column,
 * and PostgreSQL does not preserve a jsonb object's key order, so two
 * serialisations of the same object are not equal as text. A comparison that
 * checked fewer fields than the write sets would turn "update only what
 * changed" into a silent drop, which is the way round Task 12's catalog
 * comparison had to be tested field by field.
 */
function sameDetail(stored: unknown, fresh: ConflictDetail): boolean {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return false;
  }
  const before = stored as Partial<ConflictDetail>;
  return (
    before.reason === fresh.reason &&
    before.userId === fresh.userId &&
    before.linkedPersonId === fresh.linkedPersonId &&
    before.accountPersonId === fresh.accountPersonId
  );
}

/**
 * Claims the Syntra users that correspond to accounts Provision owns.
 *
 * Provision does not create the Syntra `User` — Directory Sync does, on the
 * return leg, anchored on `objectGUID`. Once it exists, Provision claims it:
 * a `TargetAccount` whose anchor matches a `User` carrying the same
 * `sourceAnchor` on the paired source, and whose `personId` is null, has that
 * user's `personId` set to the account's person.
 *
 * **Ownership is established by the anchor both subsystems already agree on,
 * never by a name.** A `User` that already carries a different `personId` is
 * left alone and reported as drift.
 *
 * ## Why no account status is filtered out
 *
 * The claim looks at every account that has an anchor — `active`, `disabled`,
 * `archived`, `conflict`, all of them. That is deliberate, and it is the
 * whole point of the function. `planActions` emits `deactivate_syntra_user`
 * from `syntraUserByPerson`, which `previewProvisionRun` builds from the users
 * whose `personId` is set — so an unclaimed user is a login no plan can ever
 * propose deactivating. Narrowing this to `active` accounts would mean the
 * leaver whose account was disabled before the login was ever claimed keeps
 * that login, with its Syntra-held password, for good. Every exclusion in
 * this function was weighed against that sentence.
 *
 * ## Bounded statements
 *
 * The claim is one `UPDATE ... FROM`, not one update per user. `withTenant`
 * is `prisma.$transaction(fn)` on Prisma's five-second default, and the first
 * claim against a target paired with a source that already holds the whole
 * directory claims every user at once — thousands of round trips, over
 * budget, and permanently so, because a retry re-runs the same volume.
 *
 * Raw SQL is governed by the same forced row-level security as every Prisma
 * query here: the transaction has the tenant bound and each table's
 * `tenant_isolation` policy scopes both sides of the join to it. The tenant
 * predicates are written out as well, so the statement is right on its own
 * terms and not only because a policy is doing the work for it.
 */
export async function claimSyntraUsers(
  tenantId: string,
  targetSystemId: string,
): Promise<ClaimSummary> {
  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    const sourceId = target.pairedDirectorySourceId;
    if (sourceId === null) return { claimed: 0, conflicts: 0 };

    /**
     * `a."anchor" <> ''` is not defensive noise. An empty anchor is not a null
     * one, and an empty `sourceAnchor` joins to it: a blank value matching
     * everything it is compared against is the same defect as a blank
     * `contains` matching every person (Ruling P20) and an empty `notIn`
     * excluding nobody. Here it would hand an arbitrary login to an arbitrary
     * person. One predicate covers both columns, because equality against a
     * non-empty anchor already excludes an empty `sourceAnchor`.
     *
     * The anchors are compared EXACTLY. Both sides are written by
     * `normaliseAnchor`, which lower-cases a text anchor and renders a GUID's
     * bytes as lower-case hex, so they already agree; and Task 11's fast path
     * was a defect precisely because it resolved anchors case-insensitively
     * where the path beside it did not. An identity match is not the place to
     * widen what matches.
     */
    const claimed = await tx.$executeRaw`
      UPDATE "User" AS u
      SET "personId" = a."personId", "updatedAt" = now()
      FROM "TargetAccount" AS a
      WHERE u."tenantId" = ${bound}::uuid
        AND a."tenantId" = ${bound}::uuid
        AND a."targetSystemId" = ${targetSystemId}::uuid
        AND u."sourceId" = ${sourceId}::uuid
        AND a."anchor" IS NOT NULL
        AND a."anchor" <> ''
        AND u."sourceAnchor" = a."anchor"
        AND u."personId" IS NULL
    `;

    const conflicts = await tx.$queryRaw<LinkConflict[]>`
      SELECT u."id" AS "userId",
             u."personId" AS "linkedPersonId",
             a."id" AS "accountId",
             a."personId" AS "accountPersonId"
      FROM "User" AS u
      JOIN "TargetAccount" AS a ON u."sourceAnchor" = a."anchor"
      WHERE u."tenantId" = ${bound}::uuid
        AND a."tenantId" = ${bound}::uuid
        AND a."targetSystemId" = ${targetSystemId}::uuid
        AND u."sourceId" = ${sourceId}::uuid
        AND a."anchor" IS NOT NULL
        AND a."anchor" <> ''
        AND u."personId" IS NOT NULL
        AND u."personId" <> a."personId"
      ORDER BY a."id"
    `;

    if (conflicts.length > 0) {
      await recordLinkConflicts(tx, bound, targetSystemId, conflicts);
    }

    if (claimed > 0 || conflicts.length > 0) {
      // Which login belongs to which person decides whose departure takes it
      // away, so establishing that binding automatically is an identity change
      // and belongs in the chain. Only when something happened: this runs
      // after every apply and on demand from the route, and an event per call
      // saying nothing changed is a chain nobody reads.
      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.users.claimed',
        targetType: 'TargetSystem',
        targetId: targetSystemId,
        outcome: 'success',
        sourceIp: null,
        payload: { claimed, conflicts: conflicts.length, sourceId },
      });
    }

    return { claimed, conflicts: conflicts.length };
  });
}

/**
 * Writes the link conflicts down, in a fixed number of statements plus one
 * update per finding whose detail genuinely changed — which on a target whose
 * conflicts are the same conflicts as last time is none.
 *
 * The shape is `previewProvisionRun`'s, deliberately: read what is there,
 * insert what is not, stamp the rest. A per-conflict `upsert` is a round trip
 * each, and a mis-paired source conflicts for every user at once rather than
 * for one.
 */
async function recordLinkConflicts(
  tx: TenantClient,
  bound: string,
  targetSystemId: string,
  conflicts: LinkConflict[],
): Promise<void> {
  /**
   * `findFirst`, and nullable. This function is called from the apply route
   * and from the job, and a target can legitimately have no run at all — a
   * link established by hand, a first claim. `findFirstOrThrow` would turn
   * "there is drift here" into an exception, which is why `DriftFinding.runId`
   * is nullable in the data model. Resolved once, outside the loop: it is the
   * same answer for every finding.
   */
  const run = await tx.provisionRun.findFirst({
    where: { targetSystemId },
    orderBy: { startedAt: 'desc' },
  });

  const seenAt = new Date();
  const drafts = conflicts.map((conflict) => ({
    conflict,
    detail: conflictDetail(conflict),
    fingerprint: driftFingerprint(
      'unexpected_status',
      conflict.accountId,
      null,
      SYNTRA_USER_LINK_SUBJECT,
    ),
  }));
  const fingerprints = drafts.map((d) => d.fingerprint);

  const existing = await tx.driftFinding.findMany({
    where: { targetSystemId, fingerprint: { in: fingerprints } },
    select: { fingerprint: true, detail: true },
  });
  const existingByFingerprint = new Map(existing.map((e) => [e.fingerprint, e]));

  const fresh = drafts.filter((d) => !existingByFingerprint.has(d.fingerprint));
  if (fresh.length > 0) {
    await tx.driftFinding.createMany({
      data: fresh.map((d) => ({
        tenantId: bound,
        targetSystemId,
        runId: run?.id ?? null,
        accountId: d.conflict.accountId,
        entitlementId: null,
        // Never an anchor: `subjectAnchor` is for an object Syntra holds no
        // row for, and this finding is about an account it does.
        subjectAnchor: null,
        kind: 'unexpected_status',
        detail: d.detail as never,
        fingerprint: d.fingerprint,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })),
      // A concurrent claim may have inserted the same fingerprint between the
      // read above and this write. The row exists and says the same thing;
      // the stamp below covers it.
      skipDuplicates: true,
    });
  }

  await tx.driftFinding.updateMany({
    where: { targetSystemId, fingerprint: { in: fingerprints } },
    data: {
      lastSeenAt: seenAt,
      // Only when there is one. Writing `null` over a run id would erase the
      // record of which run last observed a finding a run HAS observed.
      // `firstSeenAt` is never touched: it answers "how long has this been
      // wrong", which is what makes a drift list actionable.
      ...(run === null ? {} : { runId: run.id }),
    },
  });

  for (const d of drafts) {
    const before = existingByFingerprint.get(d.fingerprint);
    if (before === undefined) continue;
    if (sameDetail(before.detail, d.detail)) continue;
    await tx.driftFinding.update({
      where: {
        tenantId_targetSystemId_fingerprint: {
          tenantId: bound,
          targetSystemId,
          fingerprint: d.fingerprint,
        },
      },
      data: { detail: d.detail as never },
    });
  }
}

export class ProvisionActionNotFoundError extends Error {
  constructor(readonly actionId: string) {
    super(`no such provision action: ${actionId}`);
    this.name = 'ProvisionActionNotFoundError';
  }
}

export class NotASyntraUserActionError extends Error {
  constructor(
    readonly actionId: string,
    readonly actionType: string,
  ) {
    super(
      `action ${actionId} is a ${actionType}, which is not one of the two actions ` +
        `that write to Syntra's own directory`,
    );
    this.name = 'NotASyntraUserActionError';
  }
}

export class SyntraUserActionNotApplicableError extends Error {
  constructor(
    readonly actionId: string,
    readonly status: string,
  ) {
    super(
      `action ${actionId} is ${status}, which is not a status it can be applied from`,
    );
    this.name = 'SyntraUserActionNotApplicableError';
  }
}

export class SyntraUserActionPayloadError extends Error {
  constructor(readonly actionId: string) {
    super(`action ${actionId} names no Syntra user to write`);
    this.name = 'SyntraUserActionPayloadError';
  }
}

export class SyntraUserNotFoundError extends Error {
  constructor(
    readonly actionId: string,
    readonly userId: string,
  ) {
    super(`action ${actionId} names Syntra user ${userId}, which does not exist`);
    this.name = 'SyntraUserNotFoundError';
  }
}

/**
 * The statuses an action may still be applied from.
 *
 * `skipped`, `superseded`, `conflict`, `failed` and `applied` are records that
 * this action is not to be carried out, or has been already. Applying one
 * anyway is how a `reactivate_syntra_user` that a later run superseded gives a
 * leaver their login back — the failure this subsystem exists to prevent,
 * reached by re-running a decision somebody had already reversed. `in_flight`
 * is here for completeness: these two types never reach it, because they call
 * no connector, and if one somehow did then finishing it is the resolution.
 */
const APPLICABLE_ACTION_STATUSES = ['proposed', 'in_flight', 'pending_retry'];

/**
 * Applies one of the two actions that call no connector at all.
 *
 * These are writes to Syntra's own directory, and are therefore the only two
 * that apply inside a single transaction with their audit event and need no
 * in-flight resolution — there is no gap between a write and its record,
 * because both are in the same commit. A failure therefore writes no event at
 * all, because it writes nothing at all; recording a failed attempt belongs to
 * the apply loop that called this, which is the only party that knows whether
 * it means to retry.
 *
 * The status written is derived from `actionType` and never read from the
 * payload. `after.status` is what the planner recorded for the review screen;
 * treating it as the instruction would let a row whose payload and whose type
 * disagree decide which of the two wins, and one of those two answers hands a
 * departed person an active login.
 *
 * Nothing else about the user is written: not its mapped fields, not its
 * memberships, not its person link. A synced `GroupMembership` is owned by its
 * directory source and rewritten every run; a second writer would lose that
 * argument every night. The person link in particular is left alone even when
 * it disagrees with the action's `personId` — refusing to deactivate over a
 * disagreement would leave a departed person's login live, and this action is
 * the recorded decision about this login.
 */
export async function applySyntraUserAction(
  tenantId: string,
  actionId: string,
  actorUserId: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const action = await tx.provisionAction.findUnique({ where: { id: actionId } });
    if (action === null) throw new ProvisionActionNotFoundError(actionId);

    // Checked against the constant the connector package publishes, so the
    // routing decision the apply loop makes and the refusal made here can
    // never disagree about which two types these are. Without it the ternary
    // below reads every OTHER action type as "reactivate", and a mis-routed
    // `disable_account` becomes an active Syntra login.
    if (!(SYNTRA_ONLY_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
      throw new NotASyntraUserActionError(actionId, action.actionType);
    }
    if (!APPLICABLE_ACTION_STATUSES.includes(action.status)) {
      throw new SyntraUserActionNotApplicableError(actionId, action.status);
    }

    const after = (action.after ?? {}) as { userId?: unknown };
    const userId = after.userId;
    // `typeof`, not `!== undefined`: `after` is whatever is in a `jsonb`
    // column, and a number or an object there reaches Prisma as a `where` it
    // cannot handle. The empty string is refused for the reason every empty
    // value in this subsystem is — it is not a user id, and `where: { id: '' }`
    // is a lookup that finds nothing rather than an error that says why.
    if (typeof userId !== 'string' || userId === '') {
      throw new SyntraUserActionPayloadError(actionId);
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    // Named rather than left to Prisma's P2025, which says only that some
    // record some operation depended on was not found. It throws rather than
    // passing quietly: an action naming a login nobody can find is a
    // deactivation nobody can show happened.
    if (user === null) throw new SyntraUserNotFoundError(actionId, userId);

    const status =
      action.actionType === 'deactivate_syntra_user' ? 'inactive' : 'active';

    // Written unconditionally, including when it already says this. A branch
    // that skipped the write when the status already matched would be one more
    // place a deactivation can be skipped, and it would save one statement on
    // the path that matters least.
    await tx.user.update({ where: { id: userId }, data: { status } });

    await tx.provisionAction.update({
      where: { id: actionId },
      data: {
        status: 'applied',
        appliedAt: new Date(),
        // Incremented, not set to 1: this may be the second attempt, and a
        // column that says 1 after three tries is a column nobody can use.
        attempts: { increment: 1 },
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        actionType: action.actionType,
        userId,
        status,
        previousStatus: user.status,
      },
    });
  });
}

/**
 * Enqueues a run of the paired directory source after a successful apply that
 * created or enabled accounts.
 *
 * A freshly provisioned person cannot sign in to Syntra until the next
 * directory sync: Provision creates the account in Active Directory, and the
 * Syntra `User` for it appears when the paired source next runs. That is not a
 * defect of either subsystem, it is the cost of one-directional flow, and this
 * is the cheap mitigation — an existing job on an existing queue.
 *
 * The transaction ends before the queue is touched. `scheduler.enqueue` is a
 * write to pg-boss over its own connection, and holding a `withTenant`
 * transaction open across it spends the five-second budget on somebody else's
 * I/O.
 *
 * Returns whether a run was actually enqueued. `false` means either that there
 * is no paired source or that the queue declined the job. Whether the source
 * is enabled is deliberately not checked here: `runSyncJob` reads that when
 * the job runs, and a second copy of the test is a second thing that can
 * disagree about whether a source is due.
 */
export async function enqueuePairedSync(
  scheduler: Scheduler,
  tenantId: string,
  targetSystemId: string,
): Promise<boolean> {
  const sourceId = await withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    return target.pairedDirectorySourceId;
  });
  if (sourceId === null) return false;

  const jobId = await scheduler.enqueue(SYNC_JOB, syncJobPayload(tenantId, sourceId));
  return jobId !== null;
}
