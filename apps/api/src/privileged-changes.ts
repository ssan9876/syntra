import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantClient } from '@syntra/db';
import {
  ChangeRequestRefusedError,
  PRIVILEGED_CHANGE_CLASS_INFO,
  ROLE_ASSIGN_OPERATION,
  ROLE_UPDATE_OPERATION,
  TENANT_SETTINGS_OPERATION,
  TOKEN_ISSUE_OPERATION,
  changeControlPolicyHandler,
  createEndpoint,
  recordEvent,
  requestPrivilegedChange,
  revisionOf,
  roleAssignHandler,
  roleUpdateHandler,
  tenantSettingsRevision,
  tokenIssueHandler,
  updateEndpoint,
  type MasterKeyProvider,
  type PrivilegedChangeClass,
  type PrivilegedChangeHandler,
  type PrivilegedChangeHandlers,
  type PrivilegedChangeRequestRow,
  type RequestChangeInput,
} from '@syntra/core';
import { ProblemError } from './plugins/problem-json.js';
import { applyTenantSettings, type TenantSettingsBody } from './routes/admin/tenant-settings.js';

/**
 * The API half of separation of duties for privileged changes.
 *
 * Core owns the lifecycle and the handlers it can apply alone. The two
 * classes whose apply logic lives in routes -- webhook endpoints (the key
 * provider and the outbound-address policy are the app's) and tenant
 * sign-in settings (the lockout guards read the approver's session) -- are
 * built here, so the change a request stores is applied by the same code the
 * direct route runs.
 */

/**
 * How a requester supplies the reason a held change needs. A header rather
 * than a body field, because every body involved is `.strict()` and one
 * convention across six endpoints is simpler than six schema changes.
 * URI-encoded by the console so any text survives.
 */
export const CHANGE_REASON_HEADER = 'x-syntra-change-reason';

export function changeReason(request: FastifyRequest): string | null {
  const raw = request.headers[CHANGE_REASON_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

/**
 * Holds a change for a second administrator.
 *
 * Without a reason the answer is 409 `change-approval-required`, carrying the
 * class, so the console can ask for one and send the same request again with
 * the header. Nothing has been written when that is thrown.
 */
export async function holdPrivilegedChange(
  request: FastifyRequest,
  tx: TenantClient,
  input: Omit<RequestChangeInput, 'reason' | 'actorUserId' | 'sourceIp'>,
): Promise<PrivilegedChangeRequestRow> {
  const reason = changeReason(request);
  const changeClass = input.changeClass;
  const label = changeClass === 'change_control' ? 'Change-control policy' : PRIVILEGED_CHANGE_CLASS_INFO[changeClass as PrivilegedChangeClass].label;
  if (!reason) {
    throw new ProblemError(
      409,
      'change-approval-required',
      'A second administrator must approve this change',
      `${label} are held for approval in this organization. Give a reason and it will be sent to another administrator; nothing has changed yet.`,
      { changeClass, summary: input.summary },
    );
  }
  try {
    return await requestPrivilegedChange(tx, {
      ...input,
      reason,
      actorUserId: request.session.userId,
      sourceIp: request.ip,
    });
  } catch (cause) {
    if (cause instanceof ChangeRequestRefusedError) {
      throw new ProblemError(400, cause.code, 'Cannot request this change', cause.message);
    }
    throw cause;
  }
}

/** What a stored request looks like on the wire. */
export function presentChangeRequest(row: PrivilegedChangeRequestRow) {
  const { tenantId: _tenantId, ...rest } = row;
  return rest;
}

export function heldReply(reply: FastifyReply, row: PrivilegedChangeRequestRow) {
  return reply.status(202).send({ status: 'pending_approval', changeRequest: presentChangeRequest(row) });
}

// ---- Handlers built from the app's own dependencies ------------------------

export const WEBHOOK_CREATE_OPERATION = 'notify.webhook_create';
export const WEBHOOK_UPDATE_OPERATION = 'notify.webhook_update';

export interface WebhookCreateProposal { name: string; url: string; enabled: boolean; events: string[] }
export interface WebhookUpdateProposal {
  id: string;
  patch: { name?: string | undefined; url?: string | undefined; enabled?: boolean | undefined; events?: string[] | undefined };
}

/** A new endpoint's revision: whether its name is still free. */
export async function webhookCreateRevision(tx: TenantClient, proposed: WebhookCreateProposal): Promise<string> {
  const clash = await tx.webhookEndpoint.findFirst({ where: { name: proposed.name }, select: { id: true } });
  return revisionOf({ create: proposed.name, clash: clash?.id ?? null });
}

export async function webhookUpdateRevision(tx: TenantClient, proposed: WebhookUpdateProposal): Promise<string> {
  const row = await tx.webhookEndpoint.findUnique({
    where: { id: proposed.id },
    select: { id: true, name: true, url: true, enabled: true, events: true, updatedAt: true },
  });
  return revisionOf(row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null);
}

export function buildPrivilegedChangeHandlers(options: {
  keyProvider: MasterKeyProvider;
  outboundAllowPrivate: boolean;
}): PrivilegedChangeHandlers {
  const guard = { allowPrivateNetworks: options.outboundAllowPrivate };

  const webhookCreate: PrivilegedChangeHandler = {
    operation: WEBHOOK_CREATE_OPERATION,
    changeClass: 'webhook_endpoint',
    revision: (tx, proposed) => webhookCreateRevision(tx, proposed as WebhookCreateProposal),
    async apply(tx, raw, context) {
      const proposed = raw as WebhookCreateProposal;
      const created = await createEndpoint(tx, options.keyProvider, proposed, guard);
      await recordEvent(tx, {
        actorUserId: context.actorUserId, action: 'notify.webhook_created', targetType: 'WebhookEndpoint', targetId: created.id,
        outcome: 'success', sourceIp: context.sourceIp,
        payload: { name: created.name, url: created.url, events: created.events, changeRequestId: context.requestId },
      });
      // The signing secret goes to the approver, once, as the direct route
      // returns it to its caller. It is never stored on the request.
      return { endpointId: created.id, secret: created.secret };
    },
    record: (result) => ({ endpointId: (result as { endpointId: string }).endpointId }),
  };

  const webhookUpdate: PrivilegedChangeHandler = {
    operation: WEBHOOK_UPDATE_OPERATION,
    changeClass: 'webhook_endpoint',
    revision: (tx, proposed) => webhookUpdateRevision(tx, proposed as WebhookUpdateProposal),
    async apply(tx, raw, context) {
      const proposed = raw as WebhookUpdateProposal;
      const saved = await updateEndpoint(tx, options.keyProvider, proposed.id, proposed.patch, guard);
      await recordEvent(tx, {
        actorUserId: context.actorUserId, action: 'notify.webhook_updated', targetType: 'WebhookEndpoint', targetId: proposed.id,
        outcome: 'success', sourceIp: context.sourceIp,
        payload: { name: saved.name, url: saved.url, events: saved.events, enabled: saved.enabled, changeRequestId: context.requestId },
      });
      return { endpointId: saved.id };
    },
    record: (result) => result as Record<string, unknown>,
  };

  const tenantSettings: PrivilegedChangeHandler = {
    operation: TENANT_SETTINGS_OPERATION,
    changeClass: 'auth_policy',
    revision: (tx) => tenantSettingsRevision(tx),
    async apply(tx, raw, context) {
      // Under the APPROVER's session: the lockout guards ask whether the
      // person making the change effective could still get in afterwards.
      const saved = await applyTenantSettings(tx, {
        userId: context.actorUserId,
        satisfiedFactor: context.satisfiedFactor,
        sourceIp: context.sourceIp,
        changeRequestId: context.requestId,
      }, raw as TenantSettingsBody);
      return { changed: Object.keys(raw as object), primaryDomain: saved.primaryDomain };
    },
    record: (result) => result as Record<string, unknown>,
  };

  return {
    [ROLE_ASSIGN_OPERATION]: roleAssignHandler,
    [ROLE_UPDATE_OPERATION]: roleUpdateHandler,
    [TOKEN_ISSUE_OPERATION]: tokenIssueHandler,
    [changeControlPolicyHandler.operation]: changeControlPolicyHandler,
    [WEBHOOK_CREATE_OPERATION]: webhookCreate,
    [WEBHOOK_UPDATE_OPERATION]: webhookUpdate,
    [TENANT_SETTINGS_OPERATION]: tenantSettings,
  };
}
