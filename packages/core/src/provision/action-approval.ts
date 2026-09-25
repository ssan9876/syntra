import { createHash } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { recordEvent, stableStringify } from '../audit/audit-service.js';

/**
 * Held actions, confirmed after the run that held them has finished.
 *
 * **The problem.** A target with `autoApply` on applies every run it starts --
 * a schedule, and a Run now alike -- and an unattended apply confirms nothing.
 * An action that needs an explicit tick (a rename, a re-enable outside the
 * window, the re-create of a vanished account) is therefore left `proposed`
 * on a run that ends `partially_applied`, and a finished run cannot be applied
 * again: `APPLIABLE_RUN_STATUSES` is `previewed` and `blocked`. With auto-apply
 * on, a held action could never be confirmed through the console at all. The
 * live case was a business email change: the Entra run applied the attribute
 * update and left the UPN rename it implied waiting for a tick nobody could
 * give.
 *
 * **Why not re-apply it.** The held action was planned against the target as
 * it was when that run read it. Replaying it later writes a stale plan -- the
 * same hazard the run page describes for a partial apply. So an approval here
 * writes nothing. It is a STANDING approval: "the next time a run proposes
 * exactly this change, it is confirmed". The next run reads the target
 * afresh, re-derives the plan, and applies the change only if it is still the
 * same change.
 *
 * **Exactly this change, never a wider one.** The approval is matched on a
 * fingerprint of the action's type, account, and before/after values. A plan
 * that has moved on -- a second name change since, a different starting
 * value -- does not match, and the approval simply expires unused. It is
 * single-use, consumed in the same transaction as the action's intent. It
 * lives 24 hours. And it only ever stands in for the per-action tick: a run
 * the guard held, confirmable or not, is exactly as held as it was.
 */

/** How long an approval stands. Long enough for the next scheduled run; no longer. */
export const ACTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The run statuses a held action can be approved from: runs that have ended. */
export const APPROVABLE_RUN_STATUSES = ['applied', 'partially_applied'] as const;

/** What an action is, for the purpose of recognising it again in a later plan. */
export interface FingerprintedAction {
  actionType: string;
  accountId: string | null;
  before: unknown;
  after: unknown;
}

/**
 * sha256 over the stable JSON of `{ actionType, accountId, before, after }`.
 *
 * `stableStringify`, the audit chain's own canonical form, so key order in a
 * `jsonb` column -- which PostgreSQL normalises however it likes -- never
 * decides whether two identical changes match. `null` and an absent `before`
 * are the same thing here, as they are to Prisma.
 */
export function actionFingerprint(action: FingerprintedAction): string {
  return createHash('sha256')
    .update(
      stableStringify({
        actionType: action.actionType,
        accountId: action.accountId,
        before: action.before ?? null,
        after: action.after ?? null,
      }),
    )
    .digest('hex');
}

export type ActionApprovalState = 'pending' | 'consumed' | 'expired' | 'revoked';

interface ApprovalRow {
  id: string;
  accountId: string;
  actionType: string;
  fingerprint: string;
  sourceActionId: string;
  approvedByUserId: string;
  approvedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedByActionId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}

/**
 * One word for where an approval stands. `pending` is the only live one: it
 * is waiting for a run to propose the change it covers.
 */
export function actionApprovalState(row: ApprovalRow, now: Date): ActionApprovalState {
  if (row.consumedAt !== null) return 'consumed';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** The `where` for approvals that still stand. */
const live = (now: Date) => ({
  consumedAt: null,
  revokedAt: null,
  expiresAt: { gt: now },
});

/** No such run, or no such action in it, through this target. */
export class HeldActionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldActionNotFoundError';
  }
}

/**
 * The action exists and cannot be approved, with a code the API turns into a
 * problem type and a sentence that says why.
 */
export class HeldActionNotApprovableError extends Error {
  constructor(
    readonly code:
      | 'run-not-finished'
      | 'action-not-held'
      | 'action-names-no-account'
      | 'action-superseded'
      | 'already-approved'
      | 'approval-not-revocable',
    message: string,
  ) {
    super(message);
    this.name = 'HeldActionNotApprovableError';
  }
}

export interface HeldActionRef {
  targetSystemId: string;
  runId: string;
  actionId: string;
}

async function readHeldAction(tx: TenantClient, ref: HeldActionRef) {
  const run = await tx.provisionRun.findUnique({
    where: { id: ref.runId },
    select: { id: true, targetSystemId: true, status: true },
  });
  // Named through this target or not at all, as every run route is: the run
  // id alone would let target A's URL approve target B's action.
  if (!run || run.targetSystemId !== ref.targetSystemId) {
    throw new HeldActionNotFoundError('Run not found');
  }
  const action = await tx.provisionAction.findUnique({ where: { id: ref.actionId } });
  if (!action || action.runId !== run.id) throw new HeldActionNotFoundError('Action not found');
  return { run, action };
}

/**
 * Records a standing approval of one held action, and audits it.
 *
 * Refused (with the reason) unless every one of these holds:
 *
 * - the run has ENDED (`applied` or `partially_applied`). A run still
 *   `previewed` or `blocked` is confirmed the ordinary way, on its own Apply;
 *   an approval there would be a second, weaker route to the same decision.
 * - the action is still `proposed` and requires confirmation. Anything else
 *   either happened or was never waiting for a person.
 * - it names an account. The approval is matched on the account; an action
 *   with none could never be recognised again.
 * - it is the LATEST proposal of this type for this account on this target.
 *   An older run's copy describes an older plan; approving it would approve
 *   a change a newer run has already re-derived, possibly differently.
 * - no approval for this account and type is already standing. Two would be
 *   two answers to one question.
 *
 * The caller enqueues the run that acts on it; this writes nothing to any
 * target.
 */
export async function approveHeldAction(
  tx: TenantClient,
  ref: HeldActionRef,
  actor: { userId: string; sourceIp: string | null },
  now: Date = new Date(),
) {
  const { run, action } = await readHeldAction(tx, ref);
  if (!(APPROVABLE_RUN_STATUSES as readonly string[]).includes(run.status)) {
    throw new HeldActionNotApprovableError(
      'run-not-finished',
      `this run is ${run.status}; approve its actions by applying the run itself, which can still be confirmed`,
    );
  }
  if (action.status !== 'proposed' || !action.requiresConfirmation) {
    throw new HeldActionNotApprovableError(
      'action-not-held',
      `this action is ${action.status}${action.requiresConfirmation ? '' : ' and never needed a confirmation'}, so there is nothing waiting to be approved`,
    );
  }
  if (action.accountId === null) {
    throw new HeldActionNotApprovableError(
      'action-names-no-account',
      'this action names no account, so a later run could not recognise it as the same change',
    );
  }
  const latest = await tx.provisionAction.findFirst({
    where: {
      accountId: action.accountId,
      actionType: action.actionType,
      run: { targetSystemId: ref.targetSystemId },
    },
    orderBy: [{ run: { startedAt: 'desc' } }, { sequence: 'desc' }],
    select: { id: true, runId: true },
  });
  if (latest !== null && latest.id !== action.id) {
    throw new HeldActionNotApprovableError(
      'action-superseded',
      `a later run (${latest.runId}) has planned this account's ${action.actionType} again; approve it there, where the plan is current`,
    );
  }
  const standing = await tx.provisionActionApproval.findFirst({
    where: {
      targetSystemId: ref.targetSystemId,
      accountId: action.accountId,
      actionType: action.actionType,
      ...live(now),
    },
    select: { id: true },
  });
  if (standing !== null) {
    throw new HeldActionNotApprovableError(
      'already-approved',
      `this account's ${action.actionType} is already approved (${standing.id}) and waiting for the next run`,
    );
  }

  const fingerprint = actionFingerprint(action);
  const approval = await tx.provisionActionApproval.create({
    data: {
      tenantId: action.tenantId,
      targetSystemId: ref.targetSystemId,
      accountId: action.accountId,
      actionType: action.actionType,
      fingerprint,
      sourceActionId: action.id,
      approvedByUserId: actor.userId,
      approvedAt: now,
      expiresAt: new Date(now.getTime() + ACTION_APPROVAL_TTL_MS),
    },
  });
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'provision.action.approved',
    targetType: 'ProvisionAction',
    targetId: action.id,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: {
      approvalId: approval.id,
      targetSystemId: ref.targetSystemId,
      runId: run.id,
      accountId: action.accountId,
      actionType: action.actionType,
      fingerprint,
      // What was approved, as the person saw it. The fingerprint alone says
      // that SOMETHING was approved; this says what.
      before: action.before,
      after: action.after,
      expiresAt: approval.expiresAt.toISOString(),
    },
  });
  return approval;
}

/**
 * Withdraws a standing approval before any run has used it, and audits it.
 *
 * Only a `pending` one. A consumed approval has already been acted on, and an
 * expired or revoked one already approves nothing; "revoking" either would be
 * an audit event claiming a change that did not happen.
 */
export async function revokeHeldActionApproval(
  tx: TenantClient,
  ref: HeldActionRef,
  actor: { userId: string; sourceIp: string | null },
  now: Date = new Date(),
) {
  const { action } = await readHeldAction(tx, ref);
  const approval = await tx.provisionActionApproval.findFirst({
    where: { targetSystemId: ref.targetSystemId, sourceActionId: action.id },
    orderBy: { approvedAt: 'desc' },
  });
  if (!approval) throw new HeldActionNotFoundError('This action has no approval');
  const state = actionApprovalState(approval, now);
  if (state !== 'pending') {
    throw new HeldActionNotApprovableError(
      'approval-not-revocable',
      `this approval is ${state}, so there is nothing left to revoke`,
    );
  }
  // Conditional on still being live, so a run consuming it between the read
  // above and this write wins, and this answers that it was too late.
  const { count } = await tx.provisionActionApproval.updateMany({
    where: { id: approval.id, ...live(now) },
    data: { revokedAt: now, revokedByUserId: actor.userId },
  });
  if (count === 0) {
    throw new HeldActionNotApprovableError(
      'approval-not-revocable',
      'a run used this approval before it could be revoked',
    );
  }
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'provision.action.approval_revoked',
    targetType: 'ProvisionAction',
    targetId: action.id,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: {
      approvalId: approval.id,
      targetSystemId: ref.targetSystemId,
      accountId: approval.accountId,
      actionType: approval.actionType,
      approvedByUserId: approval.approvedByUserId,
    },
  });
  return tx.provisionActionApproval.findUniqueOrThrow({ where: { id: approval.id } });
}

/**
 * Why an action that requires confirmation may proceed in an apply nobody
 * confirmed. Null means it may not, and is deferred as it always was.
 */
export type StandingConfirmation =
  | { kind: 'approval'; approvalId: string; approvedByUserId: string; approvedAt: Date; sourceActionId: string }
  | { kind: 'target_setting'; setting: 'autoConfirmRenames' };

/**
 * The standing confirmation for one action, if there is one. Read-only: the
 * approval is consumed later, with the action's intent.
 *
 * An approval first, because it names the person who decided; the target's
 * `autoConfirmRenames` second, and for `rename_account` ONLY -- not a
 * re-enable, not a re-create, not any other type that may one day require
 * confirmation. A setting that silently widened with the action catalogue
 * would be a setting nobody chose.
 */
export async function standingConfirmationFor(
  tx: TenantClient,
  input: {
    targetSystemId: string;
    autoConfirmRenames: boolean;
    action: FingerprintedAction;
    now: Date;
  },
): Promise<StandingConfirmation | null> {
  const { action } = input;
  if (action.accountId !== null) {
    const approval = await tx.provisionActionApproval.findFirst({
      where: {
        targetSystemId: input.targetSystemId,
        accountId: action.accountId,
        actionType: action.actionType,
        // The whole change, not its type: a mismatch is a plan that moved on.
        fingerprint: actionFingerprint(action),
        ...live(input.now),
      },
      orderBy: { approvedAt: 'asc' },
    });
    if (approval) {
      return {
        kind: 'approval',
        approvalId: approval.id,
        approvedByUserId: approval.approvedByUserId,
        approvedAt: approval.approvedAt,
        sourceActionId: approval.sourceActionId,
      };
    }
  }
  if (input.autoConfirmRenames && action.actionType === 'rename_account') {
    return { kind: 'target_setting', setting: 'autoConfirmRenames' };
  }
  return null;
}

/** The approval stood when it was read and does not now: revoked, or used by another apply. */
export class StandingConfirmationLostError extends Error {
  constructor(readonly approvalId: string) {
    super(`approval ${approvalId} no longer stands, so the action is deferred as unconfirmed`);
    this.name = 'StandingConfirmationLostError';
  }
}

/**
 * Spends a standing confirmation on one action, inside the transaction that
 * records the action's intent, and says so in the audit log.
 *
 * Conditional on the approval still standing. Two applies racing for one
 * approval cannot both spend it: the second `updateMany` matches nothing and
 * this throws, rolling back that apply's intent with it.
 */
export async function spendStandingConfirmation(
  tx: TenantClient,
  confirmation: StandingConfirmation,
  action: { id: string; actionType: string; accountId: string | null },
  context: { targetSystemId: string; actorUserId: string | null; now: Date },
): Promise<void> {
  if (confirmation.kind === 'approval') {
    const { count } = await tx.provisionActionApproval.updateMany({
      where: { id: confirmation.approvalId, ...live(context.now) },
      data: { consumedAt: context.now, consumedByActionId: action.id },
    });
    if (count === 0) throw new StandingConfirmationLostError(confirmation.approvalId);
    await recordEvent(tx, {
      actorUserId: context.actorUserId,
      action: 'provision.action.confirmed_by_approval',
      targetType: 'ProvisionAction',
      targetId: action.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        approvalId: confirmation.approvalId,
        approvedByUserId: confirmation.approvedByUserId,
        approvedAt: confirmation.approvedAt.toISOString(),
        sourceActionId: confirmation.sourceActionId,
        targetSystemId: context.targetSystemId,
        accountId: action.accountId,
        actionType: action.actionType,
      },
    });
    return;
  }
  await recordEvent(tx, {
    actorUserId: context.actorUserId,
    action: 'provision.action.auto_confirmed',
    targetType: 'ProvisionAction',
    targetId: action.id,
    outcome: 'success',
    sourceIp: null,
    payload: {
      setting: confirmation.setting,
      targetSystemId: context.targetSystemId,
      accountId: action.accountId,
      actionType: action.actionType,
      reason: 'confirmed by the target setting "Apply renames automatically"',
    },
  });
}

export interface HeldActionView {
  actionId: string;
  /** `proposed` while it is held; `superseded` once a later run re-planned it. */
  status: string;
  /** Whether the approve endpoint would accept it now; `reason` says why not. */
  approvable: boolean;
  reason: string | null;
  /** The newest approval given on this action, whatever state it is in. */
  approval: {
    id: string;
    state: ActionApprovalState;
    approvedByUserId: string;
    approvedAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
    consumedByActionId: string | null;
    revokedAt: Date | null;
  } | null;
}

/**
 * The held actions of one finished run, each with whether it can be approved
 * and where its approval stands. Empty for a run that has not ended: those
 * are confirmed on the run's own Apply.
 */
export async function describeHeldActions(
  tx: TenantClient,
  run: { id: string; targetSystemId: string; status: string },
  now: Date = new Date(),
): Promise<HeldActionView[]> {
  if (!(APPROVABLE_RUN_STATUSES as readonly string[]).includes(run.status)) return [];
  // Every action of the run that needed a tick, then narrowed to the ones
  // still held OR carrying an approval. The next run supersedes whatever an
  // older run left `proposed`, so the approved rename is `superseded` here by
  // the time the run that applied it has finished -- and "approved, and a
  // later run used it" is the one answer this page must still give.
  const confirmable = await tx.provisionAction.findMany({
    where: { runId: run.id, requiresConfirmation: true },
    orderBy: { sequence: 'asc' },
  });
  if (confirmable.length === 0) return [];
  const approvals = await tx.provisionActionApproval.findMany({
    where: { targetSystemId: run.targetSystemId, sourceActionId: { in: confirmable.map((a) => a.id) } },
    orderBy: { approvedAt: 'desc' },
  });
  const approvedIds = new Set(approvals.map((a) => a.sourceActionId));
  const held = confirmable.filter((a) => a.status === 'proposed' || approvedIds.has(a.id));
  if (held.length === 0) return [];
  const accountIds = [...new Set(held.map((a) => a.accountId).filter((id): id is string => id !== null))];
  const { startedAt } = await tx.provisionRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { startedAt: true },
  });
  const [newer, standing] = await Promise.all([
    // The same rule `approveHeldAction` applies -- only the latest proposal
    // for an account and type is approvable -- so the button is never offered
    // for a request the server would refuse.
    tx.provisionAction.findMany({
      where: {
        accountId: { in: accountIds },
        runId: { not: run.id },
        run: { targetSystemId: run.targetSystemId, startedAt: { gt: startedAt } },
      },
      select: { accountId: true, actionType: true },
    }),
    tx.provisionActionApproval.findMany({
      where: { targetSystemId: run.targetSystemId, accountId: { in: accountIds }, ...live(now) },
      select: { id: true, accountId: true, actionType: true },
    }),
  ]);
  const liveByKey = new Map<string, string>();
  for (const row of standing) liveByKey.set(`${row.accountId}:${row.actionType}`, row.id);
  const superseded = new Set(newer.map((a) => `${a.accountId}:${a.actionType}`));

  return held.map((action) => {
    const own = approvals.find((a) => a.sourceActionId === action.id) ?? null;
    const key = `${action.accountId}:${action.actionType}`;
    let reason: string | null = null;
    if (action.status !== 'proposed') reason = `this action is ${action.status}`;
    else if (action.accountId === null) reason = 'this action names no account';
    else if (superseded.has(key)) reason = 'a later run has planned this change again';
    else if (liveByKey.has(key)) reason = 'already approved and waiting for the next run';
    return {
      actionId: action.id,
      status: action.status,
      approvable: reason === null,
      reason,
      approval: own && {
        id: own.id,
        state: actionApprovalState(own, now),
        approvedByUserId: own.approvedByUserId,
        approvedAt: own.approvedAt,
        expiresAt: own.expiresAt,
        consumedAt: own.consumedAt,
        consumedByActionId: own.consumedByActionId,
        revokedAt: own.revokedAt,
      },
    };
  });
}

/** Held actions per run, for the run list's badge. Finished runs only. */
export async function heldActionCounts(
  tx: TenantClient,
  runIds: string[],
): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const rows = await tx.provisionAction.groupBy({
    by: ['runId'],
    where: {
      runId: { in: runIds },
      status: 'proposed',
      requiresConfirmation: true,
      run: { status: { in: [...APPROVABLE_RUN_STATUSES] } },
    },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.runId, row._count._all]));
}

export interface HeldActionsAttentionItem {
  targetSystemId: string;
  targetName: string;
  runId: string;
  /** Distinct held changes in the target's latest finished run with no standing approval. */
  count: number;
  actionTypes: string[];
  finishedAt: Date | null;
  href: string;
}

/**
 * Per target, the held actions nobody has decided on yet.
 *
 * Read from each target's LATEST finished run only. An older run's held
 * actions are either repeated in the latest one -- a still-needed change is
 * re-planned every run -- or no longer needed, and counting them again would
 * make one rename read as fifteen on a target that runs every fifteen
 * minutes. Distinct by change (the fingerprint), and a change with a standing
 * approval is not waiting for anybody, so it is not counted.
 */
export async function heldActionsAttention(
  tx: TenantClient,
  now: Date = new Date(),
): Promise<HeldActionsAttentionItem[]> {
  const latestRuns = await tx.provisionRun.findMany({
    where: { status: { in: [...APPROVABLE_RUN_STATUSES] } },
    distinct: ['targetSystemId'],
    orderBy: [{ targetSystemId: 'asc' }, { startedAt: 'desc' }],
    select: {
      id: true,
      targetSystemId: true,
      finishedAt: true,
      target: { select: { name: true } },
    },
  });
  if (latestRuns.length === 0) return [];
  const [held, standing] = await Promise.all([
    tx.provisionAction.findMany({
      where: {
        runId: { in: latestRuns.map((run) => run.id) },
        status: 'proposed',
        requiresConfirmation: true,
      },
      select: { runId: true, actionType: true, accountId: true, before: true, after: true },
    }),
    tx.provisionActionApproval.findMany({
      where: { targetSystemId: { in: latestRuns.map((run) => run.targetSystemId) }, ...live(now) },
      select: { targetSystemId: true, fingerprint: true },
    }),
  ]);
  const approved = new Set(standing.map((row) => `${row.targetSystemId}:${row.fingerprint}`));
  const items: HeldActionsAttentionItem[] = [];
  for (const run of latestRuns) {
    const waiting = new Map<string, string>();
    for (const action of held) {
      if (action.runId !== run.id) continue;
      const fingerprint = actionFingerprint(action);
      if (approved.has(`${run.targetSystemId}:${fingerprint}`)) continue;
      waiting.set(fingerprint, action.actionType);
    }
    if (waiting.size === 0) continue;
    items.push({
      targetSystemId: run.targetSystemId,
      targetName: run.target.name,
      runId: run.id,
      count: waiting.size,
      actionTypes: [...new Set(waiting.values())].sort(),
      finishedAt: run.finishedAt,
      href: `/admin/targets/${run.targetSystemId}/runs/${run.id}`,
    });
  }
  return items.sort((a, b) => a.targetName.localeCompare(b.targetName));
}
