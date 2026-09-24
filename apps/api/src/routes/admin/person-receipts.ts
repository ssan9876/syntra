import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam } from '@syntra/contracts';
import { PERMISSIONS, recordEvent, requestPersonProvision, retryPersonProvision, type Scheduler } from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * The body of a person provisioning request. `requestKey` is the caller's
 * idempotency key: the same key for the same person returns the receipts the
 * first request created rather than queueing the work again.
 */
export const provisionReceiptRequest = z.object({ requestKey: z.string().uuid(), targetIds: z.array(z.string().uuid()).max(100).optional() }).strict();
export const receiptParams = idParam.extend({ receiptId: z.string().uuid() });

export async function registerAdminPersonReceiptRoutes(app: FastifyInstance, options: { scheduler?: () => Scheduler | null }) {
  app.addHook('preHandler', requireSession('admin'));
  const scheduler = () => {
    const value = options.scheduler?.();
    if (!value) throw new ProblemError(503, 'scheduler-unavailable', 'Background jobs are not running');
    return value;
  };
  app.get('/persons/:id/provision-receipts', { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) }, async request => {
    const { id } = idParam.parse(request.params);
    return { receipts: await request.db(tx => tx.personProvisionReceipt.findMany({ where: { personId: id }, orderBy: { createdAt: 'desc' }, take: 100 })) };
  });
  app.post('/persons/:id/provision-receipts', { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = provisionReceiptRequest.parse(request.body);
    const person = await request.db(tx => tx.person.findUnique({ where: { id }, select: { id: true } }));
    if (!person) throw new ProblemError(404, 'not-found', 'Person not found');
    const receipts = await requestPersonProvision(request.tenantId, id, body.requestKey, scheduler(), body.targetIds);
    await request.db((tx) => recordEvent(tx, {
      actorUserId: request.session.userId,
      action: 'person.provision.requested',
      targetType: 'Person',
      targetId: id,
      outcome: receipts.some((receipt) => receipt.status === 'failed') ? 'failure' : 'success',
      sourceIp: request.ip,
      payload: { requestKey: body.requestKey, receiptIds: receipts.map((receipt) => receipt.id), targetIds: receipts.map((receipt) => receipt.targetSystemId) },
    }));
    return reply.code(202).send({ receipts });
  });
  app.post('/persons/:id/provision-receipts/:receiptId/retry', { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) }, async (request, reply) => {
    const { id, receiptId } = receiptParams.parse(request.params);
    const existing = await request.db(tx => tx.personProvisionReceipt.findFirst({ where: { id: receiptId, personId: id } }));
    if (!existing) throw new ProblemError(404, 'not-found', 'Receipt not found');
    const receipt = await retryPersonProvision(request.tenantId, id, receiptId, scheduler());
    await request.db((tx) => recordEvent(tx, {
      actorUserId: request.session.userId,
      action: 'person.provision.retried',
      targetType: 'Person',
      targetId: id,
      outcome: receipt.status === 'failed' ? 'failure' : 'success',
      sourceIp: request.ip,
      payload: { receiptId, targetSystemId: receipt.targetSystemId, status: receipt.status },
    }));
    return reply.code(202).send(receipt);
  });
}
