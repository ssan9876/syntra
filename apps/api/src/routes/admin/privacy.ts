import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExportRefusedError,
  JobNotQueuedError,
  PERMISSIONS,
  PRIVACY_CASE_DEFAULT_DUE_DAYS,
  PRIVACY_CASE_MAX_DUE_DAYS,
  PRIVACY_ERASURE_STEP_UP_MAX_AGE_MS,
  PRIVACY_REQUEST_TYPES,
  PRIVACY_TEXT_MIN_LENGTH,
  PRIVACY_VERIFICATION_METHODS,
  PrivacyCaseRefusedError,
  approvePersonErasure,
  cancelPersonErasure,
  closePrivacyCase,
  getPrivacyCase,
  liftPersonRestriction,
  listPrivacyCases,
  openPrivacyCase,
  requestPersonErasure,
  requestPrivacyAccessBundle,
  restrictPersonProcessing,
  searchPrivacyCaseSubject,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';
import { assertTokenCovers, exportProblem, schedulerOr503 } from './exports.js';

/**
 * Data-subject request cases (backlog #70). Every route is `privacy.manage`.
 *
 * The erasure routes also refuse machine tokens (`TOKEN_DENIED_ROUTES`):
 * erasing a person is a decision two people make, each signed in. Approval
 * also needs a FRESH administrative session, whose creation time core checks
 * and records as the step-up evidence.
 */

export const privacyCaseParams = z.object({ id: z.string().uuid() });

export const privacyCaseListQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  personId: z.string().uuid().optional(),
});

export const openPrivacyCaseRequest = z
  .object({
    personId: z.string().uuid(),
    requestTypes: z.array(z.enum(PRIVACY_REQUEST_TYPES)).min(1).max(4),
    /** What the subject asked for and how it arrived. Not the subject's personal data. */
    reason: z.string().trim().min(PRIVACY_TEXT_MIN_LENGTH).max(2000),
    verificationMethod: z.enum(PRIVACY_VERIFICATION_METHODS),
    /** How the requester was shown to be the person: what was checked, by whom. */
    verificationAttestation: z.string().trim().min(PRIVACY_TEXT_MIN_LENGTH).max(2000),
    receivedAt: z.coerce.date().optional(),
    dueInDays: z.number().int().min(1).max(PRIVACY_CASE_MAX_DUE_DAYS).default(PRIVACY_CASE_DEFAULT_DUE_DAYS),
  })
  .strict();

export const privacyAccessBundleRequest = z
  .object({ ttlHours: z.number().int().min(1).max(72).optional() })
  .strict();

export const closePrivacyCaseRequest = z
  .object({ note: z.string().trim().max(2000).default('') })
  .strict();

const STATUS: Partial<Record<string, number>> = {
  'not-found': 404,
  'person-not-found': 404,
  invalid: 400,
  'four-eyes-required': 403,
  'step-up-required': 403,
};

/** Core's refusals, each with its own code for the console to explain. */
async function refusalsAsProblems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof PrivacyCaseRefusedError)) throw error;
    throw new ProblemError(STATUS[error.code] ?? 409, `privacy-${error.code}`, 'Privacy case refused', error.message, {
      blockers: error.blockers,
    });
  }
}

export async function registerAdminPrivacyRoutes(
  app: FastifyInstance,
  options: { scheduler?: () => Scheduler | null },
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const guard = { preHandler: requirePermission(PERMISSIONS.PRIVACY_MANAGE) };

  app.get('/privacy/cases', guard, async (request) => {
    const query = privacyCaseListQuery.parse(request.query ?? {});
    const cases = await request.db((tx) =>
      listPrivacyCases(tx, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.personId ? { personId: query.personId } : {}),
      }),
    );
    return { cases };
  });

  app.post('/privacy/cases', guard, async (request, reply) => {
    const body = openPrivacyCaseRequest.parse(request.body ?? {});
    const created = await refusalsAsProblems(() =>
      openPrivacyCase(request.tenantId, { ...body, actorUserId: request.session.userId, sourceIp: request.ip }),
    );
    return reply.status(201).send({ case: created });
  });

  app.get('/privacy/cases/:id', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    const detail = await refusalsAsProblems(() => getPrivacyCase(request.tenantId, id));
    return {
      ...detail,
      viewerUserId: request.session.userId,
      policy: { erasureStepUpMaxAgeMinutes: PRIVACY_ERASURE_STEP_UP_MAX_AGE_MS / 60_000 },
    };
  });

  app.get('/privacy/cases/:id/subject-data', guard, async (request) =>
    refusalsAsProblems(() => {
      const { id } = privacyCaseParams.parse(request.params);
      return searchPrivacyCaseSubject(request.tenantId, id, request.session.userId, request.ip);
    }),
  );

  app.post('/privacy/cases/:id/access-bundle', guard, async (request, reply) => {
    const { id } = privacyCaseParams.parse(request.params);
    const body = privacyAccessBundleRequest.parse(request.body ?? {});
    const scheduler = schedulerOr503(options.scheduler);
    assertTokenCovers(request, 'dsar_bundle');
    try {
      const created = await refusalsAsProblems(() =>
        requestPrivacyAccessBundle(scheduler, request.tenantId, id, {
          actorUserId: request.session.userId,
          viaToken: request.session.viaToken,
          ttlHours: body.ttlHours,
          sourceIp: request.ip,
        }),
      );
      return reply.status(202).send({ export: created });
    } catch (cause) {
      if (cause instanceof ExportRefusedError) throw exportProblem(cause);
      if (cause instanceof JobNotQueuedError) {
        throw new ProblemError(503, 'job-not-queued', 'The bundle was recorded but not queued', cause.message);
      }
      throw cause;
    }
  });

  app.post('/privacy/cases/:id/restriction', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    return {
      case: await refusalsAsProblems(() =>
        restrictPersonProcessing(request.tenantId, id, { actorUserId: request.session.userId, sourceIp: request.ip }),
      ),
    };
  });

  app.post('/privacy/cases/:id/restriction/lift', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    return {
      case: await refusalsAsProblems(() =>
        liftPersonRestriction(request.tenantId, id, { actorUserId: request.session.userId, sourceIp: request.ip }),
      ),
    };
  });

  app.post('/privacy/cases/:id/erasure/request', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    return {
      case: await refusalsAsProblems(() =>
        requestPersonErasure(request.tenantId, id, { actorUserId: request.session.userId, sourceIp: request.ip }),
      ),
    };
  });

  /**
   * The irreversible one. A different administrator than the requester, from
   * a session minted in the last few minutes; the response carries the
   * receipt, which the case also keeps.
   */
  app.post('/privacy/cases/:id/erasure/approve', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    return refusalsAsProblems(() =>
      approvePersonErasure(request.tenantId, id, {
        actorUserId: request.session.userId,
        stepUpAt: request.session.createdAt,
        sourceIp: request.ip,
      }),
    );
  });

  app.post('/privacy/cases/:id/erasure/cancel', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    return {
      case: await refusalsAsProblems(() =>
        cancelPersonErasure(request.tenantId, id, { actorUserId: request.session.userId, sourceIp: request.ip }),
      ),
    };
  });

  app.post('/privacy/cases/:id/close', guard, async (request) => {
    const { id } = privacyCaseParams.parse(request.params);
    const body = closePrivacyCaseRequest.parse(request.body ?? {});
    return {
      case: await refusalsAsProblems(() =>
        closePrivacyCase(request.tenantId, id, { actorUserId: request.session.userId, note: body.note, sourceIp: request.ip }),
      ),
    };
  });
}
