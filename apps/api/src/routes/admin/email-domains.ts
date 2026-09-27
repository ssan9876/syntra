import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  addEmailDomain,
  findEmailDomain,
  listEmailDomains,
  lookupEmailDomainVerification,
  recordEmailDomainCheck,
  recordEvent,
  removeEmailDomain,
  type TxtLookup,
} from '@syntra/core';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export const emailDomainRequest = z.object({ domain: z.string().trim().min(1).max(253) }).strict();
const idParam = z.object({ id: z.string().uuid() });

export interface EmailDomainRouteOptions {
  /** The DNS lookup; tests pass a fake. */
  txtLookup?: TxtLookup;
}

/**
 * The domains this tenant may put in an address. See `email-domains.ts` in
 * core for what "verified" means and what it gates.
 */
export async function registerAdminEmailDomainRoutes(
  app: FastifyInstance,
  options: EmailDomainRouteOptions = {},
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/email-domains',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => request.db((tx) => listEmailDomains(tx)),
  );

  app.post(
    '/email-domains',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request, reply) => {
      const body = emailDomainRequest.parse(request.body);
      const created = await request.db(async (tx) => {
        const domain = await addEmailDomain(tx, body.domain, request.session.userId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'tenant.email_domain.added',
          targetType: 'EmailDomain',
          targetId: domain.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { domain: domain.domain },
        });
        return domain;
      });
      return reply.status(201).send(created);
    },
  );

  /**
   * Looks the record up and stores the outcome. The DNS lookup runs between
   * two short transactions, never inside one: a slow resolver must not hold a
   * tenant transaction open.
   */
  app.post(
    '/email-domains/:id/verify',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const current = await request.db((tx) => findEmailDomain(tx, id));
      if (current.verifiedAt !== null) return current;
      const outcome = await lookupEmailDomainVerification(current.domain, current.record, options.txtLookup);
      return request.db(async (tx) => {
        const checked = await recordEmailDomainCheck(tx, id, outcome);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: outcome.verified ? 'tenant.email_domain.verified' : 'tenant.email_domain.verification_failed',
          targetType: 'EmailDomain',
          targetId: id,
          outcome: outcome.verified ? 'success' : 'failure',
          sourceIp: request.ip,
          payload: { domain: checked.domain, ...(outcome.verified ? {} : { reason: outcome.reason }) },
        });
        return checked;
      });
    },
  );

  app.delete(
    '/email-domains/:id',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await request.db(async (tx) => {
        const removed = await removeEmailDomain(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'tenant.email_domain.removed',
          targetType: 'EmailDomain',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { domain: removed.domain, wasVerified: removed.verifiedAt !== null },
        });
      });
      return reply.status(204).send();
    },
  );
}
