import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PERMISSIONS,
  describeMailServer,
  recordEvent,
  sendTestEmail,
  type MailConfig,
  type MailSinkWarning,
  type Transport,
} from '@syntra/core';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * Outgoing mail, as the installation is configured, and a test send.
 *
 *   GET  /mail        the transport, the server it reaches, the From, and the
 *                     local-test-server warning when there is one
 *   POST /mail/test   sends one message to the caller's own address and
 *                     reports what the server answered
 *
 * `deployment.manage`, not `tenant.manage`: the transport is configured in the
 * installation's environment and serves every tenant, and a failed send names
 * its server. The recipient is always the caller -- there is no address to
 * choose -- so the route cannot be used to mail anybody else.
 */
export async function registerAdminMailRoutes(
  app: FastifyInstance,
  options: { mail: MailConfig; transport: Transport; mailSink: MailSinkWarning | null },
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const server = describeMailServer(options.mail);
  const from = options.mail.transport === 'smtp' ? options.mail.from : (options.mail.from ?? options.mail.sender);

  const caller = (request: FastifyRequest) =>
    request.db(async (tx) => ({
      user: await tx.user.findUniqueOrThrow({
        where: { id: request.session.userId },
        select: { id: true, email: true, displayName: true },
      }),
      tenantName: (await tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId }, select: { name: true } })).name,
    }));

  app.get(
    '/mail',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async (request) => {
      const { user } = await caller(request);
      return {
        transport: options.mail.transport,
        server,
        from,
        recipient: user.email,
        warning: options.mailSink?.message ?? null,
      };
    },
  );

  app.post(
    '/mail/test',
    {
      preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE),
      // Each press is a real message and a connection to the mail server.
      // Five a minute is enough to retry after a fix.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { user, tenantName } = await caller(request);
      // Outside `request.db`: a transaction has a five-second budget, and
      // this waits on a mail server for up to thirty.
      const result = await sendTestEmail(options.transport, {
        tenantName,
        to: user.email,
        displayName: user.displayName,
        server,
      });
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'notify.test_email',
          targetType: 'User',
          targetId: user.id,
          outcome: result.ok ? 'success' : 'failure',
          sourceIp: request.ip,
          payload: { server, ...(result.ok ? {} : { error: result.error }) },
        }),
      );
      if (!result.ok) {
        request.log.warn({ tenantId: request.tenantId, server }, `test email failed: ${result.error}`);
      }
      return {
        ok: result.ok,
        to: user.email,
        server,
        message: result.ok
          ? `Test email sent to ${user.email} through ${server}.`
          : `Email to ${user.email} was not sent through ${server}: ${result.error}`,
        warning: options.mailSink?.message ?? null,
      };
    },
  );
}
