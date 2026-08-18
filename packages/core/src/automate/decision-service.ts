import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { isValidApprover, type StageSnapshot } from './approvers.js';
import { openStage } from './request-service.js';
import { checkEligibility } from './eligibility.js';
import { applyShortening } from './duration.js';
import { fulfilRequest, requestUrl, type FulfilOptions } from './fulfil.js';
import { displayNames, enqueueOutbox, recipientsForPersons } from './notify.js';
import type { RequestStatus } from './types.js';

/**
 * Every file permitted to move a request into `approved`.
 *
 * The subject of Task 11's structural test, and the reason it is a constant
 * here rather than a literal in the test: widening the set has to be an edit
 * somebody makes in the module that owns the rule, next to this comment,
 * rather than a number somebody bumps in a test file to make it green.
 *
 *   request-service.ts     a zero-stage workflow. The empty stage list IS the
 *                          grant mechanism, and the catalog says "granted
 *                          immediately" before anybody asks.
 *   decision-service.ts    the last stage decided in favour by a person.
 *   delegation-service.ts  a delegated administrative act, which spec section
 *                          14 defines as a request with no approval stages.
 *
 * There is no fourth. In particular there is no timeout that approves:
 * `onTimeout` is `remind`, `escalate` or `expire`, enforced by a database
 * check constraint as well as by a type, so adding a fourth value is a
 * migration somebody has to write.
 */
export const APPROVED_ENTRY_POINTS: readonly string[] = [
  'packages/core/src/automate/decision-service.ts',
  'packages/core/src/automate/delegation-service.ts',
  'packages/core/src/automate/request-service.ts',
];

export class DecisionRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionRefusedError';
  }
}

export interface DecisionInput {
  requestId: string;
  deciderPersonId: string;
  deciderUserId: string;
  decision: 'approve' | 'reject';
  comment: string | null;
  shortenedToDays: number | null;
  sourceIp: string | null;
}

export interface DecisionOptions extends FulfilOptions {
  /**
   * Deciding a `blocked_no_approver` request by hand. Requires
   * `automate.manage`, is recorded with `via: 'administrator'`, and is subject
   * to the invariant like every other decision.
   */
  asAdministrator?: boolean;
}

/**
 * The one short transaction of spec section 16: re-check validity, write the
 * decision, close or advance the step, resolve the next stage's approvers,
 * audit, write the outbox rows.
 */
export async function recordDecision(
  tenantId: string,
  input: DecisionInput,
  options: DecisionOptions = {},
): Promise<{ status: RequestStatus }> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const result = await withTenant(tenantId, async (tx): Promise<{ status: RequestStatus }> => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: input.requestId },
      include: { product: true },
    });

    const administrative = options.asAdministrator === true;
    if (administrative) {
      if (request.status !== 'blocked_no_approver') {
        throw new DecisionRefusedError(
          'not-blocked',
          'Only a request with nobody to approve it can be decided by an administrator.',
        );
      }
      const allowed = await hasPermission(
        tx,
        input.deciderUserId,
        PERMISSIONS.AUTOMATE_MANAGE,
      );
      if (!allowed) {
        throw new DecisionRefusedError(
          'not-permitted',
          'Deciding a blocked request by hand requires automate.manage.',
        );
      }
    } else if (request.status !== 'pending_approval') {
      throw new DecisionRefusedError(
        'not-open',
        'That request is not waiting for a decision.',
      );
    }

    // THE INVARIANT. First, before anything else this function does, and
    // repeated here rather than trusted from resolution: the manager relation,
    // the group membership and the account status all move between the stage
    // opening and the decision.
    if (
      input.deciderPersonId === request.subjectPersonId ||
      (request.requestedByPersonId !== null &&
        input.deciderPersonId === request.requestedByPersonId)
    ) {
      throw new DecisionRefusedError(
        'self-approval',
        'Nobody may decide a request they are the subject or the submitter of.',
      );
    }

    if (input.decision === 'reject' && (input.comment ?? '').trim() === '') {
      throw new DecisionRefusedError(
        'comment-required',
        'Say why. A refusal with no reason is a request the person will simply raise again.',
      );
    }

    const invalid = await isValidApprover(tx, input.deciderPersonId, now);
    if (invalid !== null) {
      throw new DecisionRefusedError(
        'approver-invalid',
        `That account can no longer decide requests (${invalid}).`,
      );
    }

    const step = administrative
      ? await tx.approvalStep.findFirstOrThrow({
          where: { requestId: request.id, status: { in: ['open', 'waiting'] } },
          orderBy: { sequence: 'asc' },
        })
      : await tx.approvalStep.findFirstOrThrow({
          where: { requestId: request.id, status: 'open' },
        });

    // How this decision is attributed. Two branches, one binding, no `var`:
    // an administrative decision is recorded as `administrator` and is
    // confined to `blocked_no_approver` by the guard above; every other
    // decision carries the `via` the resolver materialized, so a delegate's
    // signature says whose authority it was made under.
    const routing = administrative
      ? { via: 'administrator' as const, onBehalfOfPersonId: null as string | null }
      : await (async () => {
          let onStep = await tx.approvalStepApprover.findFirst({
            where: { stepId: step.id, personId: input.deciderPersonId },
          });

          // Not on the step -- so RE-RESOLVE it once before refusing.
          //
          // A stage resolved on Monday and decided on Thursday is a stage
          // whose manager relation, group membership and account status have
          // all had three days to move. Somebody whose reports changed on
          // Tuesday is the right approver on Thursday and is not on the
          // materialized set, and without this the request sits with a person
          // who is no longer responsible for it until somebody notices.
          // Re-resolution is idempotent and derives only from current data, so
          // the worst an unrelated caller can trigger is the set the resolver
          // would produce anyway.
          //
          // Decisions already recorded on CLOSED steps stand untouched: they
          // were valid when they were made. Only the open step is re-resolved.
          //
          // The plan named this behaviour in a test -- "re-resolves an open
          // stage when the subject manager changed" -- and its service never
          // performed it; the test swallowed the resulting error with
          // `.catch(() => undefined)` and then asserted on a set nothing had
          // changed.
          if (onStep === null) {
            const reopened = await openStage(tx, request.id, step.sequence, now);
            if (reopened === 'blocked') {
              throw new DecisionRefusedError(
                'not-an-approver',
                'This request no longer resolves to anybody, including you.',
              );
            }
            onStep = await tx.approvalStepApprover.findFirst({
              where: { stepId: step.id, personId: input.deciderPersonId },
            });
          }

          if (onStep === null) {
            throw new DecisionRefusedError('not-an-approver', 'This request is not with you.');
          }
          return { via: onStep.via, onBehalfOfPersonId: onStep.onBehalfOfPersonId };
        })();
    const { via, onBehalfOfPersonId } = routing;

    const shortened = applyShortening(request.requestedDurationDays, input.shortenedToDays);
    if (!shortened.ok) throw new DecisionRefusedError('duration', shortened.message);

    await tx.approvalDecision.create({
      data: {
        tenantId,
        stepId: step.id,
        personId: input.deciderPersonId,
        userId: input.deciderUserId,
        decision: input.decision,
        comment: input.comment,
        shortenedToDays: input.shortenedToDays,
        via,
        onBehalfOfPersonId,
        decidedAt: now,
      },
    });
    if (input.shortenedToDays !== null) {
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { requestedDurationDays: shortened.days },
      });
    }

    await recordEvent(tx, {
      actorUserId: input.deciderUserId,
      action: 'automate.request.decide',
      targetType: 'AccessRequest',
      targetId: request.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        stepSequence: step.sequence,
        deciderPersonId: input.deciderPersonId,
        subjectPersonId: request.subjectPersonId,
        submitterPersonId: request.requestedByPersonId,
        decision: input.decision,
        via,
        onBehalfOfPersonId,
        shortenedToDays: input.shortenedToDays,
      },
    });

    const stage = step.stageSnapshot as unknown as StageSnapshot;
    const requesterAndSubject = await recipientsForPersons(tx, [
      request.subjectPersonId,
      ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
    ]);
    const decidedBefore = await tx.approvalDecision.findMany({
      where: { step: { requestId: request.id } },
      select: { personId: true },
    });
    const alreadyDecided = await recipientsForPersons(
      tx,
      decidedBefore.map((d) => d.personId),
    );
    // Names, not ids. Spec section 7 makes naming the approver a deliberate
    // design decision -- "anonymous approval is worse than visible approval:
    // it makes chasing impossible" -- so `approverName` in particular must be
    // a person's name or the whole point of recording it is lost.
    const names = await displayNames(tx, {
      personIds: [
        request.subjectPersonId,
        input.deciderPersonId,
        ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
      ],
    });
    const requesterName =
      request.requestedByPersonId === null
        ? 'somebody whose account is not linked to a person'
        : (names.get(`person:${request.requestedByPersonId}`) ?? 'the requester');
    const vars = {
      productName: request.product?.name ?? 'the requested access',
      subjectName:
        names.get(`person:${request.subjectPersonId}`) ?? 'the person this was for',
      approverName: names.get(`person:${input.deciderPersonId}`) ?? 'an approver',
      comment: input.comment ?? '',
      shortenedNote:
        input.shortenedToDays === null ? '' : ` for ${input.shortenedToDays} days`,
      requestUrl: requestUrl(publicUrl, request.id),
    };

    if (input.decision === 'reject') {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: { status: 'rejected', closedAt: now },
      });
      // No reject-and-continue: every later stage is skipped, not left open.
      await tx.approvalStep.updateMany({
        where: { requestId: request.id, status: 'waiting' },
        data: { status: 'skipped', closedAt: now },
      });
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { status: 'rejected', statusReason: input.comment, decidedAt: now },
      });
      await enqueueOutbox(
        tx,
        [...requesterAndSubject, ...alreadyDecided].map((r) => ({
          template: 'automate-rejected' as const,
          to: r.email,
          vars: { ...vars, displayName: r.displayName },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      return { status: 'rejected' };
    }

    // Quorum. `any` closes on the first decision; `all` needs one approval
    // from every materialized approver, and a delegate's approval satisfies
    // their delegator's obligation -- which is what a delegation means.
    if (stage.quorum === 'all' && !administrative) {
      const approvers = await tx.approvalStepApprover.findMany({
        where: { stepId: step.id },
      });
      const decisions = await tx.approvalDecision.findMany({
        where: { stepId: step.id, decision: 'approve' },
      });
      const satisfied = new Set<string>();
      for (const decision of decisions) {
        satisfied.add(decision.personId);
        if (decision.onBehalfOfPersonId !== null) satisfied.add(decision.onBehalfOfPersonId);
      }
      const outstanding = approvers.filter(
        (a) =>
          !satisfied.has(a.personId) &&
          !(a.onBehalfOfPersonId !== null && satisfied.has(a.onBehalfOfPersonId)),
      );
      if (outstanding.length > 0) return { status: 'pending_approval' };
    }

    await tx.approvalStep.update({
      where: { id: step.id },
      data: { status: 'approved', closedAt: now },
    });

    // Re-evaluated at each stage opening, per spec section 7. The naive
    // implementation -- resolve everything at submission, apply at approval --
    // grants finance access to somebody who left finance three days ago.
    if (request.productId !== null) {
      const eligibility = await checkEligibility(
        tx,
        request.productId,
        request.subjectPersonId,
        now,
      );
      if (!eligibility.ok) {
        await tx.approvalStep.updateMany({
          where: { requestId: request.id, status: { in: ['waiting', 'open'] } },
          data: { status: 'skipped', closedAt: now },
        });
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status: 'rejected',
            statusReason: `${eligibility.reason}: ${eligibility.message}`,
            decidedAt: now,
          },
        });
        // Every approver who already decided is told, because somebody's
        // approval was just made moot and they should know why.
        await enqueueOutbox(
          tx,
          [...requesterAndSubject, ...alreadyDecided].map((r) => ({
            template: 'automate-refused' as const,
            to: r.email,
            vars: { ...vars, displayName: r.displayName, reason: eligibility.message },
            requestId: request.id,
            userId: r.userId,
          })),
        );
        return { status: 'rejected' };
      }
    }

    const next = await tx.approvalStep.findFirst({
      where: { requestId: request.id, status: 'waiting' },
      orderBy: { sequence: 'asc' },
    });

    if (next !== null) {
      const opened = await openStage(tx, request.id, next.sequence, now);
      if (opened === 'blocked') {
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status: 'blocked_no_approver',
            statusReason: `stage ${next.sequence} resolved to nobody who can decide it, and so did its fallback`,
          },
        });
        return { status: 'blocked_no_approver' };
      }
      const approvers = await tx.approvalStepApprover.findMany({
        where: { stepId: next.id },
        select: { personId: true },
      });
      await enqueueOutbox(
        tx,
        (
          await recipientsForPersons(
            tx,
            approvers.map((a) => a.personId),
          )
        ).map((r) => ({
          template: 'automate-stage-opened' as const,
          to: r.email,
          vars: {
            ...vars,
            displayName: r.displayName,
            requesterName,
            justification: request.justification ?? '',
          },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      return { status: 'pending_approval' };
    }

    // The last stage, decided in favour by a person. One of the three places
    // in this slice that writes `approved`, and the only one reached by
    // somebody signing something -- see APPROVED_ENTRY_POINTS above.
    await tx.accessRequest.update({
      where: { id: request.id },
      data: { status: 'approved', decidedAt: now },
    });
    await enqueueOutbox(
      tx,
      requesterAndSubject.map((r) => ({
        template: 'automate-approved' as const,
        to: r.email,
        vars: { ...vars, displayName: r.displayName },
        requestId: request.id,
        userId: r.userId,
      })),
    );
    return { status: 'approved' };
  });

  if (result.status === 'approved') {
    const fulfilled = await fulfilRequest(tenantId, input.requestId, options);
    return { status: fulfilled.status };
  }
  return result;
}

/**
 * A requester withdrawing their own request, until it reaches `approved` and
 * not after.
 *
 * After approval the grant may already be mid-apply at a target, and a cancel
 * that races a Provision action produces a state nobody described. What a
 * person does after approval is hand the access back.
 */
export async function cancelRequest(
  tenantId: string,
  requestId: string,
  actorUserId: string,
  options: FulfilOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  await withTenant(tenantId, async (tx) => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { product: true },
    });
    if (request.requestedByUserId !== actorUserId) {
      throw new DecisionRefusedError(
        'not-the-requester',
        'Only the person who raised a request can withdraw it.',
      );
    }
    if (!['pending_approval', 'blocked_no_approver'].includes(request.status)) {
      throw new DecisionRefusedError(
        'too-late',
        'This has already been decided. To give the access back, use "hand it back" on the grant.',
      );
    }

    const openApprovers = await tx.approvalStepApprover.findMany({
      where: { step: { requestId, status: 'open' } },
      select: { personId: true },
    });

    await tx.approvalStep.updateMany({
      where: { requestId, status: { in: ['open', 'waiting'] } },
      data: { status: 'skipped', closedAt: now },
    });
    await tx.accessRequest.update({
      where: { id: requestId },
      data: { status: 'cancelled', statusReason: 'withdrawn by the requester', decidedAt: now },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.request.cancel',
      targetType: 'AccessRequest',
      targetId: requestId,
      outcome: 'success',
      sourceIp: null,
      payload: { subjectPersonId: request.subjectPersonId },
    });

    // So they stop looking at it. Named, not `requestedByUserId` -- a user id
    // in the body of a mail telling somebody to stop looking at a request is
    // a support ticket rather than a notification.
    const cancelNames = await displayNames(tx, {
      personIds: request.requestedByPersonId === null ? [] : [request.requestedByPersonId],
    });
    await enqueueOutbox(
      tx,
      (
        await recipientsForPersons(
          tx,
          openApprovers.map((a) => a.personId),
        )
      ).map((r) => ({
        template: 'automate-cancelled' as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          requesterName:
            cancelNames.get(`person:${request.requestedByPersonId ?? ''}`) ?? 'the requester',
          productName: request.product?.name ?? 'the requested access',
          requestUrl: requestUrl(publicUrl, requestId),
        },
        requestId,
        userId: r.userId,
      })),
    );
  });
}
