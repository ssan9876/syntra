import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { activeContracts } from '../identity/contract-service.js';
import {
  resolveStageApprovers,
  type ResolutionSubject,
  type StageSnapshot,
} from './approvers.js';
import { loadWorkflowStages } from './workflow-service.js';
import { validateFormValues, type FormSchema } from './form.js';
import { resolveRequestedDuration, type DurationMode } from './duration.js';
// `checkEligibility` lives in its own module (Task 9) and is imported here
// rather than defined here: `fulfilRequest` needs it too, and this module
// imports `fulfilRequest`, so defining it here is an import cycle.
import { checkEligibility } from './eligibility.js';
import {
  fulfilRequest,
  requestUrl,
  subjectHoldings,
  type FulfilOptions,
} from './fulfil.js';
import {
  displayNames,
  enqueueOutbox,
  recipientsForPersons,
  usersWithPermission,
} from './notify.js';
import {
  LIVE_GRANT_STATUSES,
  type RefusalReason,
  type RequestStatus,
  type ResourceType,
} from './types.js';

export type SubmitOutcome =
  | { ok: true; requestId: string; status: RequestStatus }
  | { ok: false; reason: RefusalReason; message: string };

export interface SubmitRequestInput {
  productId: string;
  subjectPersonId: string;
  requestedByUserId: string;
  justification: string | null;
  formValues: Record<string, unknown>;
  requestedDurationDays: number | null;
  /** Set when this request is an extension of an existing grant. */
  replacesGrantId?: string | null;
}

export type SubmitOptions = FulfilOptions;

const refuse = (reason: RefusalReason, message: string): SubmitOutcome => ({
  ok: false,
  reason,
  message,
});

/** The facts approver resolution needs about a request that already exists. */
export async function subjectFor(
  tx: TenantClient,
  requestId: string,
): Promise<ResolutionSubject> {
  const request = await tx.accessRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { items: true, product: true },
  });
  return {
    subjectPersonId: request.subjectPersonId,
    submitterPersonId: request.requestedByPersonId,
    productOwnerPersonId: request.product?.ownerPersonId ?? null,
    productOwnerGroupId: request.product?.ownerGroupId ?? null,
    productCategory: request.product?.category ?? null,
    resources: request.items.map((item) => ({
      resourceType: item.resourceType as ResourceType,
      resourceId: item.resourceId,
    })),
  };
}

/**
 * Opens one stage: resolves its approver set, materializes it, and says
 * whether anybody can decide.
 *
 * Materialized rather than recomputed at decision time, for the reason
 * Directory Sync materializes `SyncChange`: "who was this with, on the Tuesday
 * it was sitting there" has to be answerable a year later, against a directory
 * that has since moved.
 *
 * Lives here rather than in the decision service because both need it, and a
 * second copy is a second set of rules about who may approve.
 */
export async function openStage(
  tx: TenantClient,
  requestId: string,
  sequence: number,
  on: Date,
): Promise<'opened' | 'blocked'> {
  const step = await tx.approvalStep.findFirstOrThrow({
    where: { requestId, sequence },
  });
  const stage = step.stageSnapshot as unknown as StageSnapshot;
  const subject = await subjectFor(tx, requestId);
  const result = await resolveStageApprovers(tx, stage, subject, on);

  await tx.approvalStepApprover.deleteMany({ where: { stepId: step.id } });
  if (result.approvers.length === 0) return 'blocked';

  await tx.approvalStepApprover.createMany({
    data: result.approvers.map((approver) => ({
      tenantId: step.tenantId,
      stepId: step.id,
      personId: approver.personId,
      via: approver.via,
      onBehalfOfPersonId: approver.onBehalfOfPersonId,
    })),
  });
  await tx.approvalStep.update({
    where: { id: step.id },
    data: {
      status: 'open',
      openedAt: on,
      slaDueAt: new Date(on.getTime() + stage.slaHours * 3_600_000),
    },
  });
  return 'opened';
}

/**
 * The submission transaction of spec section 16, in order: validate, write the
 * request and its snapshot, resolve stage 1, audit, write the outbox rows.
 *
 * All of it is reads and writes over data already in PostgreSQL. Nothing
 * renders a template against a remote service and nothing sends anything, so
 * it fits comfortably inside `withTenant`.
 */
export async function submitRequest(
  tenantId: string,
  input: SubmitRequestInput,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const result = await withTenant(tenantId, async (tx): Promise<SubmitOutcome> => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      include: { grants: true, workflow: true },
    });
    // Absent and invisible read the same, so the catalog cannot be enumerated.
    if (product === null || product.status !== 'active') {
      return refuse('not_visible', 'That is not something you can ask for.');
    }

    const submitter = await tx.user.findUnique({
      where: { id: input.requestedByUserId },
      select: { id: true, personId: true, displayName: true },
    });
    if (submitter === null) {
      return refuse('not_permitted_on_behalf', 'That account no longer exists.');
    }
    const onBehalf = submitter.personId !== input.subjectPersonId;

    if (onBehalf) {
      // The subject's own manager needs no permission. Anybody else does.
      const contracts = await activeContracts(tx, input.subjectPersonId, now);
      const isManager = contracts.some((c) => c.managerPersonId === submitter.personId);
      const permitted =
        isManager ||
        (await hasPermission(tx, submitter.id, PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF));
      if (!permitted) {
        return refuse(
          'not_permitted_on_behalf',
          'You can ask for things for yourself and for the people who report to you.',
        );
      }
    }

    const eligibility = await checkEligibility(tx, input.productId, input.subjectPersonId, now);
    if (!eligibility.ok) {
      // The AUDIENCE refusal is reported as `not_visible`, with the generic
      // message, and the other three keep their own reason.
      //
      // Global Constraint 11: a product the caller's audience does not admit
      // answers 404, never 403, because the existence of a product name is
      // itself information about the organization -- "Payroll — Executive
      // Compensation Reporting" existing is a fact about the organization.
      // `no_longer_eligible`'s message names the product, so returning it here
      // would confirm both the name and that this person is outside its
      // audience. `subject_departed`, `subject_inactive` and
      // `product_withdrawn` are facts about the person or about a product the
      // caller demonstrably already knew of, and each is actionable, so those
      // stay specific.
      //
      // The plan disagreed with itself here: its service returned
      // `eligibility.reason` unconditionally while its own test expected
      // `not_visible` for the audience case. The constraint decides it.
      return eligibility.reason === 'no_longer_eligible'
        ? refuse('not_visible', 'That is not something you can ask for.')
        : refuse(eligibility.reason, eligibility.message);
    }

    // Checked at submission and nowhere else, deliberately.
    //
    // `checkEligibility` does not look at the workflow, so a request already
    // in flight under a workflow disabled afterwards keeps advancing. That is
    // the right behaviour: disabling a workflow stops NEW requests entering
    // it; retro-cancelling the ones already with an approver would discard
    // decisions people have already signed. Recorded because
    // `workflow_disabled` is a declared `RefusalReason` with exactly one
    // producer, and the next reader will wonder whether the others are
    // missing.
    if (!product.workflow.enabled) {
      return refuse(
        'workflow_disabled',
        'The approval workflow for this product has been switched off. An administrator has to turn it back on.',
      );
    }

    const stages = await loadWorkflowStages(tx, product.workflowId);

    if (stages.length > 0 && (input.justification ?? '').trim() === '') {
      return refuse(
        'invalid_form',
        'Say why this is needed. An approver asked to decide with no stated reason will decide badly or not at all.',
      );
    }

    const formSchema = product.formSchema as unknown as FormSchema;
    // `selectableResourceIds` are `ProductGrant` ROW ids, and `picked` below
    // is keyed on the same thing, so the validator and the filter agree by
    // construction.
    const form = validateFormValues(
      formSchema,
      input.formValues,
      product.grants.map((g) => g.id),
    );
    if (!form.ok) {
      return refuse(
        'invalid_form',
        form.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      );
    }

    // Which of the product's grants this request is actually for.
    //
    // Spec section 6 defines `resourcePicker` as "choose among the product's
    // own ProductGrant rows, for a product whose bundle is 'pick one of these
    // four shared mailboxes'", and `ProductGrant.optional` as existing for
    // those forms. Building the snapshot from EVERY grant regardless makes
    // both fields decorative: a tenant who configures "pick one of four"
    // grants all four to everybody who asks for one. Non-optional grants are
    // always included; optional ones only when the picker named them.
    const pickerKeys = formSchema
      .filter((f) => f.type === 'resourcePicker' || f.type === 'multiselect')
      .map((f) => f.key);
    const picked = new Set(
      pickerKeys.flatMap((key) => {
        const value = form.values[key];
        return value === undefined
          ? []
          : Array.isArray(value)
            ? value.map(String)
            : [String(value)];
      }),
    );
    const chosenGrants = product.grants.filter((g) => !g.optional || picked.has(g.id));
    if (chosenGrants.length === 0) {
      return refuse(
        'invalid_form',
        'Choose at least one of the resources this product offers.',
      );
    }

    const duration = resolveRequestedDuration(
      {
        durationMode: product.durationMode as DurationMode,
        defaultDurationDays: product.defaultDurationDays,
        maxDurationDays: product.maxDurationDays,
      },
      input.requestedDurationDays,
    );
    if (!duration.ok) return refuse('duration_not_permitted', duration.message);

    // An application or a local group needs somebody to grant it TO.
    if (product.kind !== 'targetEntitlement') {
      const users = await tx.user.count({
        where: { personId: input.subjectPersonId, status: 'active' },
      });
      if (users === 0) {
        return refuse(
          'no_user_account',
          'That person holds no active Syntra account, so there is nothing to grant this to.',
        );
      }
    }

    const held = await subjectHoldings(tx, input.subjectPersonId);

    // An extension is a new request against the same product, and the grant
    // it replaces is NOT "already held" for the purpose of refusing it --
    // that is the whole point of extending. Without this, the Extend action
    // the expiry-warning template renders cannot even be submitted: for a
    // single-resource product every wanted key is held, so the request is
    // refused `already_held` and spec section 12's "extended in place with no
    // outage" is unbuildable. Task 9's fulfilment does the same subtraction
    // and supersedes the old grant inside one transaction.
    const replaced =
      input.replacesGrantId === undefined || input.replacesGrantId === null
        ? null
        : await tx.accessGrant.findFirst({
            where: {
              id: input.replacesGrantId,
              subjectPersonId: input.subjectPersonId,
              status: { in: [...LIVE_GRANT_STATUSES] },
            },
          });
    if (input.replacesGrantId != null && replaced === null) {
      return refuse(
        'already_held',
        'That grant is no longer live; ask for it again instead of extending it.',
      );
    }
    const excluded =
      replaced === null
        ? new Set<string>()
        : new Set([`${replaced.resourceType}:${replaced.resourceId}`]);

    const wantedResources = chosenGrants.map((g) => ({
      resourceType: g.resourceType as ResourceType,
      resourceId: g.resourceId,
    }));
    const wanted = wantedResources.map((r) => `${r.resourceType}:${r.resourceId}`);
    const names = await displayNames(tx, {
      personIds: [
        input.subjectPersonId,
        ...(submitter.personId === null ? [] : [submitter.personId]),
      ],
      productIds: [product.id],
      resources: wantedResources,
    });
    const subjectName =
      names.get(`person:${input.subjectPersonId}`) ?? 'the person this is for';

    // Subtract BEFORE testing, not alongside. Writing this as
    // `wanted.every((key) => excluded.has(key) || held.has(key))` makes the
    // excluded key *satisfy* the refusal instead of escaping it: for a
    // single-resource product -- which is what every Extend link on a grant
    // points at -- `wanted` is one key, `excluded` is that same key, `every`
    // returns true, and the extension is refused with an empty list ("That is
    // already held: ."). Take the difference first, then refuse only when
    // something is still wanted and all of it is held. A plain re-request has
    // an empty `excluded` and is still refused. Task 9's `fulfilRequest`
    // reaches the same result by a different route -- `held.delete(...)`.
    const outstanding = wanted.filter((key) => !excluded.has(key));
    if (outstanding.length > 0 && outstanding.every((key) => held.has(key))) {
      const sources = outstanding.map(
        (key) => `${names.get(key) ?? key} (${held.get(key)!.detail})`,
      );
      return refuse('already_held', `That is already held: ${sources.join(', ')}.`);
    }

    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        productId: product.id,
        subjectPersonId: input.subjectPersonId,
        requestedByUserId: submitter.id,
        requestedByPersonId: submitter.personId,
        origin: 'catalog',
        justification: input.justification,
        formValues: form.values,
        requestedDurationDays: duration.days,
        replacesGrantId: input.replacesGrantId ?? null,
        status: 'pending_approval',
      },
    });

    // The snapshot. Written at submission so editing the product afterwards
    // changes nothing about this request.
    await tx.requestItem.createMany({
      data: chosenGrants.map((grant) => ({
        tenantId,
        requestId: request.id,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
      })),
    });
    if (stages.length > 0) {
      await tx.approvalStep.createMany({
        data: stages.map((stage) => ({
          tenantId,
          requestId: request.id,
          sequence: stage.sequence,
          // `as never`, not `as unknown as object`. `object` is not assignable
          // to `Prisma.InputJsonValue` either, and `StageSnapshot` is an
          // `interface`, which TypeScript never gives an implicit index
          // signature (Global Constraint 21).
          stageSnapshot: stage as never,
          status: 'waiting',
        })),
      });
    }

    await recordEvent(tx, {
      actorUserId: submitter.id,
      action: 'automate.request.submit',
      targetType: 'AccessRequest',
      targetId: request.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        productId: product.id,
        subjectPersonId: input.subjectPersonId,
        onBehalf,
        stageCount: stages.length,
        requestedDurationDays: duration.days,
        items: wanted,
      },
    });

    const drafts: Parameters<typeof enqueueOutbox>[1][number][] = [];

    if (onBehalf) {
      // Always, at submission, before anybody decides.
      for (const recipient of await recipientsForPersons(tx, [input.subjectPersonId])) {
        drafts.push({
          template: 'automate-request-submitted-for-you',
          to: recipient.email,
          vars: {
            displayName: recipient.displayName,
            submitterName: submitter.displayName,
            productName: product.name,
            requestUrl: requestUrl(publicUrl, request.id),
          },
          requestId: request.id,
          userId: recipient.userId,
        });
      }
    }

    let status: RequestStatus = 'pending_approval';
    if (stages.length === 0) {
      // The empty stage list IS the auto-grant mechanism. Fulfilment happens
      // after this transaction, so the request is left `approved` here.
      status = 'approved';
      await tx.accessRequest.update({
        where: { id: request.id },
        data: { status, decidedAt: now },
      });
    } else {
      const opened = await openStage(tx, request.id, 1, now);
      if (opened === 'blocked') {
        status = 'blocked_no_approver';
        await tx.accessRequest.update({
          where: { id: request.id },
          data: {
            status,
            statusReason:
              'stage 1 resolved to nobody who can decide it, and so did its fallback',
          },
        });
        const owners =
          product.ownerPersonId === null
            ? []
            : await recipientsForPersons(tx, [product.ownerPersonId]);
        const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
        for (const recipient of [...owners, ...managers]) {
          drafts.push({
            template: 'automate-blocked-no-approver',
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              stageName: stages[0]!.name,
              productName: product.name,
              subjectName,
              droppedNote:
                'Everybody the stage resolved to was the subject, the submitter, or unable to sign in.',
              requestUrl: requestUrl(publicUrl, request.id),
            },
            requestId: request.id,
            userId: recipient.userId,
          });
        }
      } else {
        const approvers = await tx.approvalStepApprover.findMany({
          where: { step: { requestId: request.id, sequence: 1 } },
          select: { personId: true },
        });
        for (const recipient of await recipientsForPersons(
          tx,
          approvers.map((a) => a.personId),
        )) {
          drafts.push({
            template: 'automate-stage-opened',
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              requesterName: submitter.displayName,
              productName: product.name,
              subjectName,
              justification: input.justification ?? '',
              requestUrl: requestUrl(publicUrl, request.id),
            },
            requestId: request.id,
            userId: recipient.userId,
          });
        }
      }
    }

    await enqueueOutbox(tx, drafts);
    return { ok: true, requestId: request.id, status };
  });

  // Fulfilment is its own transaction, and it enqueues outside one. Running it
  // here rather than inside the submission transaction keeps both short and
  // keeps the pg-boss enqueue out of the request path's transaction entirely.
  if (result.ok && result.status === 'approved') {
    const fulfilled = await fulfilRequest(tenantId, result.requestId, options);
    return { ok: true, requestId: result.requestId, status: fulfilled.status };
  }
  return result;
}
