import type { FastifyInstance } from 'fastify';
import { businessRuleRequestSchema } from '@syntra/contracts';
import {
  BusinessRuleNotFoundError,
  PERMISSIONS,
  ProvisionOwnershipError,
  TargetNotFoundError,
  boundedConditionSchema,
  deleteBusinessRule,
  previewProvisionRuleImpact,
  upsertBusinessRule,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * The transport schema, then the real one.
 *
 * `businessRuleRequestSchema`'s condition falls back to `z.record(z.unknown())`
 * for leaves, so it accepts a malformed one -- and `evaluateCondition` returns
 * `undefined` for it, which `.some()` reads as false, so a broken rule previews
 * as "matches 0 persons" and saves as a rule that grants nothing. Parsing with
 * the closed schema here is what turns that into a 400.
 *
 * `boundedConditionSchema` and not the bare `conditionSchema`: it is the same
 * closed grammar with the depth and node caps in front of it, so an impact
 * preview refuses exactly what the save would refuse. (The transport schema
 * caps the same two numbers from the same definition, before its own `z.lazy`
 * recurses — a cap behind the parser it protects is not a cap.)
 */
function parseRule(body: unknown) {
  const rule = businessRuleRequestSchema.parse(body);
  return { ...rule, condition: boundedConditionSchema.parse(rule.condition) };
}

/**
 * The two ways a rule can name something that is not this target's to name.
 *
 * Both are the caller's mistake — a group picked from the wrong list, a rule
 * id pasted from another target — so both are 400s. Without this they reach
 * the error handler as unhandled faults and an administrator is told the
 * server broke.
 */
function refuseOwnership(cause: unknown): never {
  if (cause instanceof ProvisionOwnershipError) {
    throw new ProblemError(400, 'rule-ownership', 'This rule names another target', cause.message);
  }
  if (cause instanceof TargetNotFoundError) {
    throw new ProblemError(404, 'not-found', 'Target not found');
  }
  throw cause;
}

export async function registerAdminRuleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/rules',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      return {
        rules: await request.db((tx) =>
          tx.businessRule.findMany({
            where: { targetSystemId: id },
            include: { entitlements: true },
            orderBy: { name: 'asc' },
          }),
        ),
      };
    },
  );

  app.put(
    '/targets/:id/rules',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      const rule = parseRule(request.body);
      try {
        return await upsertBusinessRule(
          request.tenantId,
          request.session.userId,
          id,
          rule,
        );
      } catch (cause) {
        return refuseOwnership(cause);
      }
    },
  );

  app.delete(
    '/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { ruleId } = request.params as { ruleId: string };
      try {
        await deleteBusinessRule(request.tenantId, request.session.userId, ruleId);
      } catch (cause) {
        if (cause instanceof BusinessRuleNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Business rule not found');
        }
        throw cause;
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/:id/rules/impact',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      const rule = parseRule(request.body);
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return previewProvisionRuleImpact(request.tenantId, id, rule);
    },
  );
}
