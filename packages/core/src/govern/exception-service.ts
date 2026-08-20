import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  resolveStageApprovers,
  type ResolutionSubject,
  type StageSnapshot,
} from '../automate/approvers.js';
import {
  displayNames,
  enqueueOutbox,
  recipientsForPersons,
  usersWithPermission,
} from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createRemediationItem } from './finding-service.js';
import { governSettings } from './settings-service.js';
import { raiseSeverity, type Severity } from './types.js';

/**
 * Section 15. An exception is a RISK ACCEPTANCE, not a decision on a campaign
 * item and not a grant of anything.
 *
 * NOTHING IN THIS MODULE REVOKES ANYTHING AND NOTHING IN IT BLOCKS A REQUEST.
 * Every ending — the end date, the early contract lapse, the approver's early
 * revocation — reopens a finding and tells people. That is the whole of it, and
 * it is what makes the one unattended ending (`lapse`) safe: a timer expiring
 * is not a decision anybody made, and treating it as an instruction to strip
 * access would mean an administrator's holiday becomes a production outage in
 * the finance system.
 */
export class ExceptionRefusedError extends Error {
  constructor(
    readonly code:
      | 'no_end_date'
      | 'too_long'
      | 'beneficiary_is_approver'
      | 'blocked_no_approver'
      | 'missing_justification',
    message: string,
  ) {
    super(message);
    this.name = 'ExceptionRefusedError';
  }
}

export interface RequestExceptionInput {
  ruleId: string;
  personId: string;
  violationId: string;
  justification: string;
  compensatingControl: string;
  basisContractIds?: string[];
  startsAt: Date;
  endsAt: Date;
}

/**
 * The people who may accept this risk, with the beneficiary removed.
 *
 * §15's fallback is the holders of `govern.accept_risk`, DELIBERATELY DISTINCT
 * from `govern.manage`: administering the governance module and accepting the
 * organization's risk are different jobs, and a product that conflates them
 * hands risk acceptance to whoever configures the software.
 *
 * Where the rule names a workflow, Automate's RESOLVER is reused rather than a
 * second one written — §12's reason, applied here: an approval chain and a
 * risk-acceptance chain disagreeing about who somebody's manager is would be a
 * support call nobody can close. It is the resolver that is reused and not
 * `submitRequest`, which is keyed on a `Product`; an exception is not a catalog
 * item and inventing a synthetic product per rule to borrow the plumbing would
 * put a risk acceptance in the request queue, where somebody would eventually
 * approve it the way they approve a mailbox.
 */
async function resolveAcceptors(
  tx: TenantClient,
  rule: { exceptionWorkflowId: string | null },
  beneficiaryPersonId: string,
  on: Date,
): Promise<string[]> {
  let personIds: string[];

  if (rule.exceptionWorkflowId === null) {
    const holders = await usersWithPermission(tx, PERMISSIONS.GOVERN_ACCEPT_RISK);
    personIds = holders
      .map((holder) => holder.personId)
      .filter((id): id is string => id !== null);
  } else {
    const stage = await tx.approvalStage.findFirst({
      where: { workflowId: rule.exceptionWorkflowId },
      orderBy: { sequence: 'asc' },
    });
    if (stage === null) return [];
    const snapshot: StageSnapshot = {
      sequence: stage.sequence,
      name: stage.name,
      selector: stage.selector as StageSnapshot['selector'],
      selectorConfig: stage.selectorConfig as StageSnapshot['selectorConfig'],
      quorum: stage.quorum as 'any' | 'all',
      fallbackSelector: stage.fallbackSelector as StageSnapshot['fallbackSelector'],
      fallbackConfig: stage.fallbackConfig as StageSnapshot['selectorConfig'],
      slaHours: stage.slaHours,
      onTimeout: stage.onTimeout as StageSnapshot['onTimeout'],
      escalationSelector: stage.escalationSelector as StageSnapshot['escalationSelector'],
      escalationConfig: stage.escalationConfig as StageSnapshot['selectorConfig'],
      expiryHours: stage.expiryHours,
    };
    const subject: ResolutionSubject = {
      subjectPersonId: beneficiaryPersonId,
      submitterPersonId: null,
      productOwnerPersonId: null,
      productOwnerGroupId: null,
      // An exception is not a catalog request: there is no product and no
      // resource, so a `resourceOwner` or category-scoped delegation selector
      // resolves to nobody rather than to somebody arbitrary.
      productCategory: null,
      resources: [],
    };
    const resolved = await resolveStageApprovers(tx, snapshot, subject, on);
    personIds = resolved.approvers.map((approver) => approver.personId);
  }

  // THE SELF-APPROVAL INVARIANT, applied unchanged to an exception. The common
  // case is the one that matters: the beneficiary is a holder of
  // `govern.accept_risk` themselves, because senior people are both the ones
  // who accumulate incompatible access and the ones trusted to accept risk.
  return [...new Set(personIds)].filter((id) => id !== beneficiaryPersonId);
}

export async function requestSodException(
  tenantId: string,
  actorUserId: string | null,
  input: RequestExceptionInput,
): Promise<{ id: string; status: string }> {
  // Both required, and checked before anything is written. A perpetual,
  // unjustified, uncompensated exception is how an SoD programme dies quietly.
  if (input.justification.trim() === '' || input.compensatingControl.trim() === '') {
    throw new ExceptionRefusedError(
      'missing_justification',
      'an exception needs both a justification and a compensating control, in words a reader who was not in the room can follow',
    );
  }

  return withTenant(tenantId, async (tx) => {
    const settings = await governSettings(tx);
    const rule = await tx.sodRule.findUniqueOrThrow({ where: { id: input.ruleId } });

    // There is no such thing as a permanent exception. The schema requires an
    // end date; this requires it to be a REVIEWABLE distance away.
    const lengthDays = Math.ceil(
      (input.endsAt.getTime() - input.startsAt.getTime()) / 86_400_000,
    );
    if (lengthDays > settings.maxExceptionDays) {
      throw new ExceptionRefusedError(
        'too_long',
        `an exception may run for at most ${settings.maxExceptionDays} days; this one asks for ${lengthDays}. Renewal is a new decision, which is the point.`,
      );
    }
    if (input.endsAt <= input.startsAt) {
      throw new ExceptionRefusedError(
        'no_end_date',
        'an exception must end after it starts; there is no such thing as a permanent risk acceptance',
      );
    }

    const acceptors = await resolveAcceptors(tx, rule, input.personId, input.startsAt);

    const exception = await tx.sodException.create({
      data: {
        tenantId,
        ruleId: input.ruleId,
        personId: input.personId,
        violationId: input.violationId,
        justification: input.justification,
        compensatingControl: input.compensatingControl,
        basisContractIds: (input.basisContractIds ?? []) as never,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        // BLOCKED, not silently pending forever, and not approved by the
        // requester. A request nobody can decide is a state somebody has to see.
        status: acceptors.length === 0 ? 'blocked_no_approver' : 'pending',
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.exception.request',
      targetType: 'SodException',
      targetId: exception.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        ruleId: input.ruleId,
        personId: input.personId,
        status: exception.status,
        acceptorCount: acceptors.length,
        lengthDays,
        // Stated in the event: asking for an exception grants nothing.
        accessGranted: false,
      },
    });

    return { id: exception.id, status: exception.status };
  });
}

export async function decideSodException(
  tenantId: string,
  actorUserId: string,
  exceptionId: string,
  decision: 'approve' | 'refuse',
  comment: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const exception = await tx.sodException.findUniqueOrThrow({
      where: { id: exceptionId },
      include: { rule: true },
    });
    if (exception.status !== 'pending') {
      throw new ExceptionRefusedError(
        'blocked_no_approver',
        `this exception is ${exception.status} and is not open for a decision`,
      );
    }

    const actor = await tx.user.findUniqueOrThrow({
      where: { id: actorUserId },
      select: { personId: true, status: true },
    });

    // RE-RESOLVED at the decision, never trusted from the request. Somebody
    // who held `govern.accept_risk` when the exception was raised and does not
    // hold it now is not an acceptor, and the beneficiary is subtracted here
    // for the second time rather than once.
    const acceptors = await resolveAcceptors(tx, exception.rule, exception.personId, new Date());
    if (actor.personId === null || !acceptors.includes(actor.personId)) {
      throw new ExceptionRefusedError(
        actor.personId === exception.personId ? 'beneficiary_is_approver' : 'blocked_no_approver',
        actor.personId === exception.personId
          ? 'the beneficiary of an exception may not accept it on their own behalf'
          : 'this account is not among the people who may accept this risk',
      );
    }

    if (decision === 'approve') {
      await tx.sodException.update({
        where: { id: exceptionId },
        data: { status: 'active', approvedByPersonId: actor.personId },
      });
      await tx.sodViolation.update({
        where: { id: exception.violationId },
        // `excepted`, never `resolved`. Somebody accepted it; nobody fixed it,
        // and every report that counts open violations has to be able to tell
        // those apart.
        data: { status: 'excepted', exceptionId },
      });
    } else {
      await tx.sodException.update({
        where: { id: exceptionId },
        data: { status: 'refused', revokedReason: comment, revokedByUserId: actorUserId },
      });

      // A REFUSAL REVOKES NOTHING. Auto-revoking here would make an exception
      // decision an unattended access removal at one remove — the reviewer
      // refuses a piece of paper and somebody loses access to the payments
      // system an hour later, with no revocation batch, no guard and nobody
      // named. The violation stays open, the finding says a risk acceptance
      // was refused, and a human is given the job.
      const finding = await tx.governFinding.findFirst({
        where: {
          kind: 'sod_violation',
          subjectRefType: 'sod_violation',
          subjectRefId: `${exception.ruleId}:${exception.personId}`,
        },
      });
      if (finding !== null) {
        await tx.governFinding.update({
          where: { id: finding.id },
          data: {
            detail: {
              ...(finding.detail as Record<string, unknown>),
              riskAcceptanceRefused: true,
              riskAcceptanceRefusedAt: new Date().toISOString(),
              riskAcceptanceRefusedReason: comment,
            } as never,
          },
        });
        await createRemediationItem(tx, tenantId, {
          kind: 'sod_violation_unaccepted',
          ownerPersonId: exception.personId,
          dueAt: new Date(Date.now() + 30 * 86_400_000),
          findingId: finding.id,
          description:
            `The risk acceptance for "${exception.rule.name}" was refused: ${comment}. ` +
            'Nothing was removed. The incompatible access has to be separated by a person, ' +
            'through a campaign decision or a change to what grants it.',
          deepLink: `/admin/govern/sod/violations/${exception.violationId}`,
        });
      }
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.exception.decide',
      targetType: 'SodException',
      targetId: exceptionId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        decision,
        comment,
        violationId: exception.violationId,
        // Stated in the event, for both branches: no access moved either way.
        accessRevoked: false,
        accessGranted: false,
      },
    });
  });
}

/** An early ending by a person. Same tail as the timer, and same guarantee. */
export async function revokeSodException(
  tenantId: string,
  actorUserId: string,
  exceptionId: string,
  reason: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const exception = await tx.sodException.findUniqueOrThrow({ where: { id: exceptionId } });
    await lapse(tx, tenantId, exception, new Date(), reason, 'revoked');
    await tx.sodException.update({
      where: { id: exceptionId },
      data: { revokedByUserId: actorUserId },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.exception.revoke',
      targetType: 'SodException',
      targetId: exceptionId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason, violationId: exception.violationId, accessRevoked: false },
    });
  });
}

/**
 * A lapse is a TIMER EXPIRING, not a decision anybody made. Treating it as an
 * instruction to strip access would mean an administrator's holiday becomes a
 * production outage in the finance system.
 *
 * NOTHING IS REVOKED. The violation returns to `open`, its finding's severity
 * goes up one step because a violation somebody once formally accepted and then
 * let quietly expire is a different and worse thing than one nobody has looked
 * at yet, and everybody involved is told.
 */
export async function sweepExceptions(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ warned: number; lapsed: number; lapsedByContract: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const settings = await governSettings(tx);
    const active = await tx.sodException.findMany({
      where: { status: 'active' },
      include: { rule: true },
    });

    let warned = 0;
    let lapsed = 0;
    let lapsedByContract = 0;

    for (const exception of active) {
      // The one place an exception ends early without a human, and it is safe
      // because ending an exception TAKES NOTHING AWAY FROM ANYBODY — it
      // reopens a finding. Where the stated basis is a pair of concurrent
      // contracts, the justification stopped being true when one of them ended.
      const basis = (exception.basisContractIds as string[] | null) ?? [];
      if (basis.length > 0) {
        const stillRunning = await tx.contract.count({
          where: { id: { in: basis }, OR: [{ endDate: null }, { endDate: { gte: now } }] },
        });
        if (stillRunning < basis.length) {
          await lapse(
            tx,
            tenantId,
            exception,
            now,
            'a contract its justification rested on has ended',
          );
          lapsed += 1;
          lapsedByContract += 1;
          continue;
        }
      }

      if (exception.endsAt <= now) {
        await lapse(tx, tenantId, exception, now, 'it reached its end date and was not renewed');
        lapsed += 1;
        continue;
      }

      const daysLeft = Math.ceil((exception.endsAt.getTime() - now.getTime()) / 86_400_000);
      if (!settings.exceptionWarningDays.includes(daysLeft)) continue;

      const parties = await recipientsForPersons(
        tx,
        [exception.personId, exception.approvedByPersonId].filter(
          (x): x is string => typeof x === 'string',
        ),
      );
      const names = await displayNames(tx, { personIds: [exception.personId] });
      await enqueueOutbox(
        tx,
        parties.map((recipient) => ({
          template: 'govern-exception-expiring' as const,
          to: recipient.email,
          vars: {
            displayName: recipient.displayName,
            ruleName: exception.rule.name,
            beneficiaryName: names.get(`person:${exception.personId}`) ?? 'the beneficiary',
            endsAt: exception.endsAt.toDateString(),
            // Renewal is a NEW exception with a new decision, pre-filled with
            // the old justification. Never auto-renewal, which is approval by
            // inattention wearing a different hat.
            renewUrl: `${options.publicUrl ?? ''}/admin/govern/sod/exceptions/new?renew=${exception.id}`,
          },
          requestId: null,
          userId: recipient.userId,
        })),
      );
      warned += 1;
    }

    return { warned, lapsed, lapsedByContract };
  });
}

/**
 * The shared tail of every ending: the timer, the early contract lapse, and the
 * approver's early revocation all land here.
 *
 * THE VIOLATION REOPENS AT ITS ORIGINAL SEVERITY and NOTHING IS REVOKED. What
 * changes is the FINDING's severity, one step up, because a violation somebody
 * once formally accepted and then let quietly expire is a different and worse
 * thing than one nobody has looked at yet.
 */
async function lapse(
  tx: TenantClient,
  tenantId: string,
  exception: { id: string; ruleId: string; personId: string; violationId: string },
  now: Date,
  reason: string,
  status: 'lapsed' | 'revoked' = 'lapsed',
): Promise<void> {
  await tx.sodException.update({
    where: { id: exception.id },
    data: { status, revokedReason: reason },
  });
  const violation = await tx.sodViolation.update({
    where: { id: exception.violationId },
    // Its ORIGINAL severity: the exception never changed what the violation is,
    // only whether somebody had accepted it.
    data: { status: 'open', exceptionId: null },
  });

  const finding = await tx.governFinding.findFirst({
    where: {
      kind: 'sod_violation',
      subjectRefType: 'sod_violation',
      subjectRefId: `${exception.ruleId}:${exception.personId}`,
    },
  });
  if (finding !== null) {
    await tx.governFinding.update({
      where: { id: finding.id },
      data: {
        severity: raiseSeverity(finding.severity as Severity),
        detail: {
          ...(finding.detail as Record<string, unknown>),
          lapsedExceptionAt: now.toISOString(),
          lapsedExceptionReason: reason,
        } as never,
      },
    });
  }

  const parties = await recipientsForPersons(tx, [exception.personId, violation.personId]);
  const names = await displayNames(tx, { personIds: [exception.personId] });
  const rule = await tx.sodRule.findUniqueOrThrow({
    where: { id: exception.ruleId },
    select: { name: true },
  });
  await enqueueOutbox(
    tx,
    parties.map((recipient) => ({
      template: 'govern-exception-expiring' as const,
      to: recipient.email,
      vars: {
        displayName: recipient.displayName,
        ruleName: rule.name,
        beneficiaryName: names.get(`person:${exception.personId}`) ?? 'the beneficiary',
        endsAt: now.toDateString(),
        renewUrl: `/admin/govern/sod/exceptions/new?renew=${exception.id}`,
      },
      requestId: null,
      userId: recipient.userId,
    })),
  );

  await recordEvent(tx, {
    actorUserId: null,
    action: 'govern.exception.lapse',
    targetType: 'SodException',
    targetId: exception.id,
    outcome: 'success',
    sourceIp: null,
    // Stated in the event as well as on the screen: nothing was removed.
    payload: { reason, violationId: exception.violationId, status, accessRevoked: false },
  });
}
