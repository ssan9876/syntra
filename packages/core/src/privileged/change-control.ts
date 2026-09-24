import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent, stableStringify } from '../audit/audit-service.js';
import { STEP_UP_MAX_AGE_MS } from '../auth/session-service.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS, type Permission } from '../rbac/permissions.js';
import { currentTenant } from '../tenant-context.js';

/**
 * Separation of duties for privileged administrative changes.
 *
 * Govern's SoD is about BUSINESS access: two entitlements one person should
 * not hold together. This is about ADMINISTRATION: one administrator should
 * not be able to request, approve, execute and close the same privileged
 * change. A tenant names the classes of change it wants held; a change in a
 * held class is not applied, it is stored as a request, and a DIFFERENT
 * administrator applies it from a freshly stepped-up console session.
 *
 * The idioms are the ones tenant deletion and the tenant write stop already
 * use, so an administrator learns one rule:
 *
 *  - The requester can never decide. The database refuses it too
 *    (`PrivilegedChangeRequest_four_eyes`).
 *  - Approval needs the ten-minute step-up (`STEP_UP_MAX_AGE_MS`), recorded
 *    as evidence and checked again by a constraint.
 *  - The request is revision-bound. It stores a SHA-256 over the state of the
 *    object it changes, and approval recomputes it: if the role, account,
 *    endpoint or settings moved since, the request is invalidated rather than
 *    applied over a state nobody reviewed.
 *  - It expires (72 hours). A request nobody approved in three days is a
 *    request nobody should approve on its original evidence.
 *  - Approval IS execution: the change is applied in the approver's
 *    transaction, under the approver's authority, and the request closes
 *    with it. There is no approved-but-unapplied state for a third party to
 *    execute or the requester to trigger later.
 *  - Every step is an audit event in the Privileged access webhook group.
 *
 * The requester may WITHDRAW a pending request. Withdrawal applies nothing
 * and decides nothing; it is the one action open to them, and it is audited.
 *
 * The mechanism is generic: a change class supplies a handler that computes
 * the revision of what it changes and applies the stored proposal. The four
 * implemented classes are listed in `PRIVILEGED_CHANGE_CLASSES`; others
 * (federation configuration, target credentials) adopt it by adding a class
 * and a handler.
 */

export const PRIVILEGED_CHANGE_CLASSES = ['role_grant', 'admin_token', 'auth_policy', 'webhook_endpoint'] as const;
export type PrivilegedChangeClass = (typeof PRIVILEGED_CHANGE_CLASSES)[number];
/**
 * The implicit class of a change to this policy itself. It is held whenever
 * the change would switch off a class that is currently on -- otherwise the
 * first thing a lone administrator would do is turn the control off.
 */
export type ChangeRequestClass = PrivilegedChangeClass | 'change_control';

export const PRIVILEGED_CHANGE_CLASS_INFO: Record<PrivilegedChangeClass, { label: string; description: string; approverPermission: Permission }> = {
  role_grant: {
    label: 'Privileged role grants',
    description: 'Assigning a role that carries a privileged permission, or adding a privileged permission to a role.',
    approverPermission: PERMISSIONS.RBAC_MANAGE,
  },
  admin_token: {
    label: 'Admin-scoped API tokens',
    description: 'Minting a machine token that can exercise a privileged permission.',
    approverPermission: PERMISSIONS.TOKEN_MANAGE,
  },
  auth_policy: {
    label: 'Authentication policy relaxation',
    description: 'Weakening sign-in settings: second-factor or security-key requirements, password and lockout rules, session lifetimes.',
    approverPermission: PERMISSIONS.TENANT_MANAGE,
  },
  webhook_endpoint: {
    label: 'Webhook endpoints',
    description: 'Creating a webhook endpoint or changing where one sends, what it receives, or whether it is enabled.',
    approverPermission: PERMISSIONS.TENANT_MANAGE,
  },
};

export function approverPermissionFor(changeClass: ChangeRequestClass): Permission {
  return changeClass === 'change_control'
    ? PERMISSIONS.TENANT_MANAGE
    : PRIVILEGED_CHANGE_CLASS_INFO[changeClass].approverPermission;
}

/**
 * Permissions whose grant is itself a privileged change: each confers
 * authority over who may do what, over credentials, or over the tenant.
 */
export const PRIVILEGED_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.RBAC_MANAGE,
  PERMISSIONS.TENANT_MANAGE,
  PERMISSIONS.TOKEN_MANAGE,
  PERMISSIONS.POLICY_MANAGE,
  PERMISSIONS.SECRETS_WRITE,
  PERMISSIONS.DEPLOYMENT_MANAGE,
  PERMISSIONS.ACCESS_MANAGE,
];

export function privilegedPermissionsIn(permissions: readonly string[]): string[] {
  return permissions.filter((permission) => (PRIVILEGED_PERMISSIONS as readonly string[]).includes(permission));
}

export const CHANGE_REQUEST_WINDOW_MS = 72 * 60 * 60 * 1000;
export const CHANGE_REQUEST_REASON_MIN_LENGTH = 10;
export const CHANGE_REQUEST_STEP_UP_MAX_AGE_MS = STEP_UP_MAX_AGE_MS;

export type ChangeRequestRefusalCode =
  | 'not-found'
  | 'not-pending'
  | 'expired'
  | 'four-eyes-required'
  | 'step-up-required'
  | 'forbidden'
  | 'stale'
  | 'reason-required'
  | 'unknown-operation'
  | 'unknown-class';

export class ChangeRequestRefusedError extends Error {
  constructor(readonly code: ChangeRequestRefusalCode, message: string) {
    super(message);
    this.name = 'ChangeRequestRefusedError';
  }
}

const refuse = (code: ChangeRequestRefusalCode, message: string): never => {
  throw new ChangeRequestRefusedError(code, message);
};

/** SHA-256 over a canonical serialisation. Dates must already be strings. */
export function revisionOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// ---- Policy ---------------------------------------------------------------

export async function readChangeControlPolicy(tx: TenantClient): Promise<PrivilegedChangeClass[]> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { privilegedChangeClasses: true } });
  return tenant.privilegedChangeClasses.filter((value): value is PrivilegedChangeClass =>
    (PRIVILEGED_CHANGE_CLASSES as readonly string[]).includes(value));
}

export async function isChangeClassHeld(tx: TenantClient, changeClass: PrivilegedChangeClass): Promise<boolean> {
  return (await readChangeControlPolicy(tx)).includes(changeClass);
}

export function assertChangeClasses(values: readonly string[]): PrivilegedChangeClass[] {
  const unknown = values.filter((value) => !(PRIVILEGED_CHANGE_CLASSES as readonly string[]).includes(value));
  if (unknown.length > 0) refuse('unknown-class', `Not a privileged change class: ${unknown.join(', ')}`);
  return [...new Set(values)].sort() as PrivilegedChangeClass[];
}

/** Writes the policy. The caller decides first whether this change is held. */
export async function writeChangeControlPolicy(
  tx: TenantClient,
  classes: readonly PrivilegedChangeClass[],
  actor: { actorUserId: string; sourceIp: string | null; requestId?: string },
): Promise<PrivilegedChangeClass[]> {
  const tenantId = await currentTenant(tx);
  const before = await readChangeControlPolicy(tx);
  const next = [...new Set(classes)].sort();
  await tx.tenant.update({ where: { id: tenantId }, data: { privilegedChangeClasses: next } });
  await recordEvent(tx, {
    actorUserId: actor.actorUserId,
    action: 'change_control.policy_updated',
    targetType: 'Tenant',
    targetId: tenantId,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: { before, after: next, ...(actor.requestId ? { changeRequestId: actor.requestId } : {}) },
  });
  return next;
}

// ---- Handlers -------------------------------------------------------------

export interface ApplyContext {
  /** The approving administrator: the change is made under their authority. */
  actorUserId: string;
  /** The factor behind the approver's session, for handlers that check it. */
  satisfiedFactor: string | null;
  sourceIp: string | null;
  requestId: string;
}

/**
 * What a change class supplies to the generic lifecycle.
 *
 * `revision` must read the CURRENT state of the object the proposal changes
 * and nothing else, so an unrelated write elsewhere does not invalidate it.
 * `apply` performs the write and its own audit event exactly as the direct
 * route would, and returns what the approver is shown. `record` reduces that
 * to what may be stored on the request: identifiers, never secrets.
 */
export interface PrivilegedChangeHandler {
  operation: string;
  changeClass: ChangeRequestClass;
  revision(tx: TenantClient, proposed: unknown): Promise<string>;
  apply(tx: TenantClient, proposed: unknown, context: ApplyContext): Promise<unknown>;
  record?(result: unknown): Record<string, unknown>;
}

export type PrivilegedChangeHandlers = Readonly<Record<string, PrivilegedChangeHandler>>;

// ---- Lifecycle --------------------------------------------------------------

export type PrivilegedChangeRequestRow = Awaited<ReturnType<TenantClient['privilegedChangeRequest']['findFirstOrThrow']>>;

export interface RequestChangeInput {
  changeClass: ChangeRequestClass;
  operation: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  proposed: Record<string, unknown>;
  baseRevision: string;
  reason: string | null | undefined;
  actorUserId: string;
  sourceIp: string | null;
}

/**
 * Stores a held change. Runs in the caller's transaction, after the caller
 * has validated the proposal as far as it can without applying it.
 */
export async function requestPrivilegedChange(
  tx: TenantClient,
  input: RequestChangeInput,
  now: Date = new Date(),
): Promise<PrivilegedChangeRequestRow> {
  const tenantId = await currentTenant(tx);
  const reason = (input.reason ?? '').trim();
  if (reason.length < CHANGE_REQUEST_REASON_MIN_LENGTH) {
    refuse('reason-required', `This change needs a second administrator. Give a reason of at least ${CHANGE_REQUEST_REASON_MIN_LENGTH} characters for them to review (changeReason).`);
  }
  const created = await tx.privilegedChangeRequest.create({
    data: {
      tenantId,
      changeClass: input.changeClass,
      operation: input.operation,
      targetType: input.targetType,
      targetId: input.targetId,
      summary: input.summary,
      proposed: input.proposed as object,
      baseRevision: input.baseRevision,
      reason,
      requestedByUserId: input.actorUserId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + CHANGE_REQUEST_WINDOW_MS),
    },
  });
  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'change_request.created',
    targetType: 'PrivilegedChangeRequest',
    targetId: created.id,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: {
      changeClass: input.changeClass,
      operation: input.operation,
      targetType: input.targetType,
      targetId: input.targetId,
      summary: input.summary,
      reason,
      baseRevision: input.baseRevision,
      expiresAt: created.expiresAt.toISOString(),
    },
  });
  return created;
}

async function closeIfExpired(tx: TenantClient, row: PrivilegedChangeRequestRow, now: Date): Promise<boolean> {
  if (row.status !== 'pending' || row.expiresAt > now) return false;
  const { count } = await tx.privilegedChangeRequest.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'expired', closedReason: 'expired' },
  });
  if (count === 1) {
    await recordEvent(tx, {
      actorUserId: null,
      action: 'change_request.expired',
      targetType: 'PrivilegedChangeRequest',
      targetId: row.id,
      outcome: 'success',
      sourceIp: null,
      payload: { changeClass: row.changeClass, operation: row.operation, expiresAt: row.expiresAt.toISOString() },
    });
  }
  return true;
}

/** Closes every pending request past its window. Returns how many. */
export async function expirePrivilegedChanges(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const lapsed = await tx.privilegedChangeRequest.findMany({ where: { status: 'pending', expiresAt: { lte: now } } });
    let closed = 0;
    for (const row of lapsed) if (await closeIfExpired(tx, row, now)) closed += 1;
    return closed;
  });
}

export async function listPrivilegedChanges(tenantId: string, now: Date = new Date(), limit = 100) {
  await expirePrivilegedChanges(tenantId, now);
  return withTenant(tenantId, (tx) =>
    tx.privilegedChangeRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: limit }));
}

async function recordRefusal(
  tenantId: string,
  requestId: string,
  actorUserId: string,
  action: string,
  error: ChangeRequestRefusedError,
) {
  await withTenant(tenantId, async (tx) => {
    if (error.code === 'stale') {
      await tx.privilegedChangeRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'invalidated', closedReason: 'stale' },
      });
    }
    await recordEvent(tx, {
      actorUserId,
      action,
      targetType: 'PrivilegedChangeRequest',
      targetId: requestId,
      outcome: 'failure',
      sourceIp: null,
      payload: { code: error.code, reason: error.message },
    });
  }).catch(() => undefined);
}

async function loadPending(tx: TenantClient, id: string, now: Date) {
  const row = await tx.privilegedChangeRequest.findFirst({ where: { id } });
  if (!row) return refuse('not-found', 'Change request not found');
  if (row.status === 'pending' && row.expiresAt <= now) {
    refuse('expired', 'This request was not decided in time; ask for the change again');
  }
  if (row.status !== 'pending') refuse('not-pending', `This request is ${row.status}, not awaiting a decision`);
  return row;
}

export interface ApproveInput {
  actorUserId: string;
  stepUpAt: Date;
  satisfiedFactor: string | null;
  sourceIp: string | null;
  note?: string | null | undefined;
}

/**
 * A second administrator approves, and the change is applied in the same
 * transaction. Refusals are audited in their own transaction, because the
 * refused one rolls back; a stale revision also invalidates the request.
 *
 * Errors thrown by the handler's own validation (a lockout guard, an
 * unusable URL) roll the approval back and leave the request pending, so the
 * approver can reject it with a note instead.
 */
export async function approvePrivilegedChange(
  tenantId: string,
  requestId: string,
  input: ApproveInput,
  handlers: PrivilegedChangeHandlers,
  now: Date = new Date(),
): Promise<{ request: PrivilegedChangeRequestRow; result: unknown }> {
  try {
    return await withTenant(tenantId, async (tx) => {
      const row = await loadPending(tx, requestId, now);
      if (row.requestedByUserId === input.actorUserId) {
        refuse('four-eyes-required', 'A different administrator must approve a change you requested');
      }
      const permission = approverPermissionFor(row.changeClass as ChangeRequestClass);
      if (!(await hasPermission(tx, input.actorUserId, permission))) {
        refuse('forbidden', `Approving this change requires ${permission}`);
      }
      const age = now.getTime() - input.stepUpAt.getTime();
      if (!(age >= 0 && age <= CHANGE_REQUEST_STEP_UP_MAX_AGE_MS)) {
        refuse('step-up-required', `Approving a privileged change needs a console session started in the last ${CHANGE_REQUEST_STEP_UP_MAX_AGE_MS / 60_000} minutes. Elevate again, then approve.`);
      }
      const handler = handlers[row.operation];
      if (!handler) return refuse('unknown-operation', `No handler applies ${row.operation}`);
      const current = await handler.revision(tx, row.proposed);
      if (current !== row.baseRevision) {
        refuse('stale', 'What this request changes has been modified since it was made; it can no longer be applied as reviewed. Ask for the change again.');
      }

      // Conditional on the status read above, so two approvers racing cannot
      // both apply it.
      const { count } = await tx.privilegedChangeRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: {
          status: 'applied',
          decidedByUserId: input.actorUserId,
          decidedAt: now,
          deciderStepUpAt: input.stepUpAt,
          decisionNote: input.note?.trim() || null,
        },
      });
      if (count !== 1) refuse('not-pending', 'This request is no longer awaiting a decision');

      const result = await handler.apply(tx, row.proposed, {
        actorUserId: input.actorUserId,
        satisfiedFactor: input.satisfiedFactor,
        sourceIp: input.sourceIp,
        requestId,
      });
      const recorded = handler.record ? handler.record(result) : {};
      await tx.privilegedChangeRequest.update({ where: { id: requestId }, data: { result: recorded as object } });
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'change_request.approved',
        targetType: 'PrivilegedChangeRequest',
        targetId: requestId,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          changeClass: row.changeClass,
          operation: row.operation,
          requestedByUserId: row.requestedByUserId,
          stepUpAt: input.stepUpAt.toISOString(),
          revision: current,
          result: recorded,
        },
      });
      return { request: await tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id: requestId } }), result };
    }, { timeoutMs: 30_000 });
  } catch (error) {
    if (error instanceof ChangeRequestRefusedError) {
      if (error.code === 'expired') await expirePrivilegedChanges(tenantId, now);
      await recordRefusal(tenantId, requestId, input.actorUserId, 'change_request.approve_refused', error);
    }
    throw error;
  }
}

export async function rejectPrivilegedChange(
  tenantId: string,
  requestId: string,
  input: { actorUserId: string; sourceIp: string | null; note?: string | null | undefined },
  now: Date = new Date(),
): Promise<PrivilegedChangeRequestRow> {
  try {
    return await withTenant(tenantId, async (tx) => {
      const row = await loadPending(tx, requestId, now);
      if (row.requestedByUserId === input.actorUserId) {
        refuse('four-eyes-required', 'You cannot decide your own request; withdraw it instead');
      }
      const permission = approverPermissionFor(row.changeClass as ChangeRequestClass);
      if (!(await hasPermission(tx, input.actorUserId, permission))) {
        refuse('forbidden', `Rejecting this change requires ${permission}`);
      }
      const { count } = await tx.privilegedChangeRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: {
          status: 'rejected', decidedByUserId: input.actorUserId, decidedAt: now,
          decisionNote: input.note?.trim() || null, closedReason: 'rejected',
        },
      });
      if (count !== 1) refuse('not-pending', 'This request is no longer awaiting a decision');
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'change_request.rejected',
        targetType: 'PrivilegedChangeRequest',
        targetId: requestId,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: { changeClass: row.changeClass, operation: row.operation, requestedByUserId: row.requestedByUserId, note: input.note?.trim() || null },
      });
      return tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
    });
  } catch (error) {
    if (error instanceof ChangeRequestRefusedError) {
      if (error.code === 'expired') await expirePrivilegedChanges(tenantId, now);
      await recordRefusal(tenantId, requestId, input.actorUserId, 'change_request.reject_refused', error);
    }
    throw error;
  }
}

/** The requester takes a pending request back. Nobody else may. */
export async function withdrawPrivilegedChange(
  tenantId: string,
  requestId: string,
  input: { actorUserId: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<PrivilegedChangeRequestRow> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadPending(tx, requestId, now);
    if (row.requestedByUserId !== input.actorUserId) {
      refuse('forbidden', 'Only the administrator who asked for a change can withdraw it; reject it instead');
    }
    const { count } = await tx.privilegedChangeRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'withdrawn', closedReason: 'withdrawn' },
    });
    if (count !== 1) refuse('not-pending', 'This request is no longer awaiting a decision');
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'change_request.withdrawn',
      targetType: 'PrivilegedChangeRequest',
      targetId: requestId,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: { changeClass: row.changeClass, operation: row.operation },
    });
    return tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// ---- The policy as a held change --------------------------------------------

export const CHANGE_CONTROL_POLICY_OPERATION = 'change_control.policy';

/** The one handler core can own outright: the policy itself. */
export const changeControlPolicyHandler: PrivilegedChangeHandler = {
  operation: CHANGE_CONTROL_POLICY_OPERATION,
  changeClass: 'change_control',
  async revision(tx) {
    return revisionOf({ classes: await readChangeControlPolicy(tx) });
  },
  async apply(tx, proposed, context) {
    const { classes } = proposed as { classes: string[] };
    return writeChangeControlPolicy(tx, assertChangeClasses(classes), context);
  },
  record(result) {
    return { classes: result as string[] };
  },
};

/**
 * Sets the policy, or holds the change when it would switch a class off.
 * Turning a class on is never held: tightening needs no second opinion.
 */
export async function setChangeControlPolicy(
  tx: TenantClient,
  requested: readonly string[],
  actor: { actorUserId: string; sourceIp: string | null; reason?: string | null | undefined },
  now: Date = new Date(),
): Promise<{ held: false; classes: PrivilegedChangeClass[] } | { held: true; request: PrivilegedChangeRequestRow }> {
  const classes = assertChangeClasses(requested);
  const before = await readChangeControlPolicy(tx);
  const removed = before.filter((value) => !classes.includes(value));
  if (removed.length === 0) {
    return { held: false, classes: await writeChangeControlPolicy(tx, classes, actor) };
  }
  const request = await requestPrivilegedChange(tx, {
    changeClass: 'change_control',
    operation: CHANGE_CONTROL_POLICY_OPERATION,
    targetType: 'Tenant',
    targetId: await currentTenant(tx),
    summary: `Stop holding: ${removed.map((value) => PRIVILEGED_CHANGE_CLASS_INFO[value].label).join(', ')}`,
    proposed: { classes },
    baseRevision: revisionOf({ classes: before }),
    reason: actor.reason,
    actorUserId: actor.actorUserId,
    sourceIp: actor.sourceIp,
  }, now);
  return { held: true, request };
}
