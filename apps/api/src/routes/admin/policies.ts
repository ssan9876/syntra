import type { FastifyInstance } from 'fastify';
import {
  policyDefaultRequest,
  policyRuleRequest,
  reorderRulesRequest,
  ruleParams,
  type RuleImpactResponse,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  addRule,
  deleteRule,
  loadPolicy,
  recordEvent,
  previewRuleImpact,
  reorderRules,
  setPolicyDefault,
  updateRule,
  type RuleInput,
} from '@syntra/core';
import { PolicyRuleInvalidError } from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The service throws for a rule that could never be honoured — a malformed
 * CIDR, a timezone the platform cannot resolve. Those are the administrator's
 * mistakes, not server faults, so they come back as 400 with the message
 * attached rather than as a 500 with nothing.
 *
 * NARROWED to the service's own error class, which is the whole point. These
 * calls write to the database, so an untyped catch swept up a dropped
 * connection, a transaction timeout and any genuine bug in here too --
 * answering 400 for all of them, with the raw message as the client-facing
 * detail. That destroyed the 400/500 distinction and published text never
 * written for a client, which is exactly what problem-json.ts refuses to do
 * for unrecognised errors. Anything that is not this class is rethrown and
 * handled there.
 */
async function domainError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof PolicyRuleInvalidError) {
      throw new ProblemError(
        400,
        'invalid-policy-rule',
        'That rule cannot be stored as written',
        cause.message,
      );
    }
    throw cause;
  }
}

export interface PolicyRouteOptions {
  authRateLimitMax: number;
}

export async function registerAdminPolicyRoutes(
  app: FastifyInstance,
  options: PolicyRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/policy',
    { preHandler: requirePermission(PERMISSIONS.POLICY_READ) },
    async (request) => request.db((tx) => loadPolicy(tx)),
  );

  app.put(
    '/policy/default',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const body = policyDefaultRequest.parse(request.body);
      await request.db(async (tx) => {
        await domainError(() => setPolicyDefault(tx, body));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.default_set',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { outcome: body.outcome, factorType: body.factorType },
        });
      });
      return request.db((tx) => loadPolicy(tx));
    },
  );

  /**
   * How many people a rule would touch, answered before it is saved and
   * without storing anything. A rule requiring a second factor now sends
   * everyone it matches through forced enrolment on their next sign-in, and an
   * administrator is entitled to know how many people that is first.
   *
   * Rate-limited like a write and gated on POLICY_MANAGE rather than
   * POLICY_READ, despite storing nothing. It is the most expensive endpoint in
   * the console — it can count every user and every membership in the tenant
   * — and it answers "how many of your people have no second factor", which
   * is reconnaissance if it leaks. The permission to see that is the
   * permission to change the rule that acts on it.
   */
  app.post(
    '/policy/rules/impact',
    {
      preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE),
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    },
    // Annotated against the contract, which nothing referred to before: the
    // handler returned core's `RuleImpact` and the console described the shape
    // again locally, so the schema pinned nothing.
    async (request): Promise<RuleImpactResponse> => {
      const body = policyRuleRequest.parse(request.body);
      return request.db((tx) =>
        domainError(() => previewRuleImpact(tx, body as RuleInput)),
      );
    },
  );

  app.post(
    '/policy/rules',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const body = policyRuleRequest.parse(request.body);
      const rule = await request.db(async (tx) => {
        const created = await domainError(() => addRule(tx, body as RuleInput));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_added',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId: created.id, name: created.name, outcome: created.outcome },
        });
        return created;
      });
      return reply.status(201).send(rule);
    },
  );

  app.put(
    '/policy/rules/order',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const body = reorderRulesRequest.parse(request.body);
      await request.db(async (tx) => {
        await domainError(() => reorderRules(tx, body.ruleIds));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rules_reordered',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { order: body.ruleIds },
        });
      });
      return request.db((tx) => loadPolicy(tx));
    },
  );

  app.put(
    '/policy/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const { ruleId } = ruleParams.parse(request.params);
      const body = policyRuleRequest.parse(request.body);
      return request.db(async (tx) => {
        const updated = await domainError(() => updateRule(tx, ruleId, body as RuleInput));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_updated',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId, name: updated.name, outcome: updated.outcome },
        });
        return updated;
      });
    },
  );

  app.delete(
    '/policy/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const { ruleId } = ruleParams.parse(request.params);
      await request.db(async (tx) => {
        await deleteRule(tx, ruleId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_deleted',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId },
        });
      });
      return reply.status(204).send();
    },
  );
}
