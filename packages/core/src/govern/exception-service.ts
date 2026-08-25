import { withTenant, type TenantClient } from "@syntra/db";
import { recordEvent } from "../audit/audit-service.js";
import {
  resolveStageApprovers,
  type ResolutionSubject,
  type StageSnapshot,
} from "../automate/approvers.js";
import {
  displayNames,
  enqueueOutbox,
  recipientsForPersons,
  usersWithPermission,
} from "../automate/notify.js";
import { PERMISSIONS } from "../rbac/permissions.js";
import { createRemediationItem } from "./finding-service.js";
import { governSettings } from "./settings-service.js";
import { raiseSeverity, type Severity } from "./types.js";

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
      | "no_end_date"
      | "too_long"
      | "beneficiary_is_approver"
      | "blocked_no_approver"
      | "missing_justification"
      | "not_an_acceptor"
      | "not_active",
    message: string,
  ) {
    super(message);
    this.name = "ExceptionRefusedError";
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
    const holders = await usersWithPermission(
      tx,
      PERMISSIONS.GOVERN_ACCEPT_RISK,
    );
    personIds = holders
      .map((holder) => holder.personId)
      .filter((id): id is string => id !== null);
  } else {
    const stage = await tx.approvalStage.findFirst({
      where: { workflowId: rule.exceptionWorkflowId },
      orderBy: { sequence: "asc" },
    });
    if (stage === null) return [];
    const snapshot: StageSnapshot = {
      sequence: stage.sequence,
      name: stage.name,
      selector: stage.selector as StageSnapshot["selector"],
      selectorConfig: stage.selectorConfig as StageSnapshot["selectorConfig"],
      quorum: stage.quorum as "any" | "all",
      fallbackSelector:
        stage.fallbackSelector as StageSnapshot["fallbackSelector"],
      fallbackConfig: stage.fallbackConfig as StageSnapshot["selectorConfig"],
      slaHours: stage.slaHours,
      onTimeout: stage.onTimeout as StageSnapshot["onTimeout"],
      escalationSelector:
        stage.escalationSelector as StageSnapshot["escalationSelector"],
      escalationConfig:
        stage.escalationConfig as StageSnapshot["selectorConfig"],
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
  if (
    input.justification.trim() === "" ||
    input.compensatingControl.trim() === ""
  ) {
    throw new ExceptionRefusedError(
      "missing_justification",
      "an exception needs both a justification and a compensating control, in words a reader who was not in the room can follow",
    );
  }

  return withTenant(tenantId, async (tx) => {
    const settings = await governSettings(tx);
    const rule = await tx.sodRule.findUniqueOrThrow({
      where: { id: input.ruleId },
    });

    // There is no such thing as a permanent exception. The schema requires an
    // end date; this requires it to be a REVIEWABLE distance away.
    const lengthDays = Math.ceil(
      (input.endsAt.getTime() - input.startsAt.getTime()) / 86_400_000,
    );
    if (lengthDays > settings.maxExceptionDays) {
      throw new ExceptionRefusedError(
        "too_long",
        `an exception may run for at most ${settings.maxExceptionDays} days; this one asks for ${lengthDays}. Renewal is a new decision, which is the point.`,
      );
    }
    if (input.endsAt <= input.startsAt) {
      throw new ExceptionRefusedError(
        "no_end_date",
        "an exception must end after it starts; there is no such thing as a permanent risk acceptance",
      );
    }

    const acceptors = await resolveAcceptors(
      tx,
      rule,
      input.personId,
      input.startsAt,
    );

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
        status: acceptors.length === 0 ? "blocked_no_approver" : "pending",
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: "govern.exception.request",
      targetType: "SodException",
      targetId: exception.id,
      outcome: "success",
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
  decision: "approve" | "refuse",
  comment: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const exception = await tx.sodException.findUniqueOrThrow({
      where: { id: exceptionId },
      // `functionA` as well as the rule: §14 routes a refused risk acceptance
      // to the RULE OWNER, and `SodRule` has no owner column -- the owner of a
      // rule is the owner of the business function it constrains, which is
      // where `ownerPersonId` lives.
      include: { rule: { include: { functionA: true } } },
    });
    if (exception.status !== "pending") {
      throw new ExceptionRefusedError(
        "blocked_no_approver",
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
    const acceptors = await resolveAcceptors(
      tx,
      exception.rule,
      exception.personId,
      new Date(),
    );
    if (actor.personId === null || !acceptors.includes(actor.personId)) {
      throw new ExceptionRefusedError(
        actor.personId === exception.personId
          ? "beneficiary_is_approver"
          : "blocked_no_approver",
        actor.personId === exception.personId
          ? "the beneficiary of an exception may not accept it on their own behalf"
          : "this account is not among the people who may accept this risk",
      );
    }

    if (decision === "approve") {
      await tx.sodException.update({
        where: { id: exceptionId },
        data: { status: "active", approvedByPersonId: actor.personId },
      });
      await tx.sodViolation.update({
        where: { id: exception.violationId },
        // `excepted`, never `resolved`. Somebody accepted it; nobody fixed it,
        // and every report that counts open violations has to be able to tell
        // those apart.
        data: { status: "excepted", exceptionId },
      });
    } else {
      await tx.sodException.update({
        where: { id: exceptionId },
        data: {
          status: "refused",
          revokedReason: comment,
          revokedByUserId: actorUserId,
        },
      });

      // A REFUSAL REVOKES NOTHING. Auto-revoking here would make an exception
      // decision an unattended access removal at one remove — the reviewer
      // refuses a piece of paper and somebody loses access to the payments
      // system an hour later, with no revocation batch, no guard and nobody
      // named. The violation stays open, the finding says a risk acceptance
      // was refused, and a human is given the job.
      const finding = await tx.governFinding.findFirst({
        where: {
          kind: "sod_violation",
          subjectRefType: "sod_violation",
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
        const actorNames = await displayNames(tx, {
          personIds: actor.personId === null ? [] : [actor.personId],
        });
        const actorName =
          actor.personId === null
            ? "an administrator"
            : (actorNames.get(`person:${actor.personId}`) ?? "an approver");

        await createRemediationItem(tx, tenantId, {
          kind: "sod_violation_unaccepted",
          // THE RULE OWNER, not the beneficiary.
          //
          // §14 routes this to the rule owner and the approver who allowed the
          // grant. It went to `exception.personId` -- the person the control
          // exists to CONSTRAIN -- so the beneficiary was handed a task whose
          // completion means giving up their own access, and the one person who
          // can change what the rule names was never told there was work to do.
          //
          // A `RemediationItem` carries ONE owner, so the approver is named in
          // the description rather than given a second row: two rows for one
          // piece of work is two people each assuming the other has it.
          ownerPersonId: exception.rule.functionA.ownerPersonId,
          dueAt: new Date(Date.now() + 30 * 86_400_000),
          findingId: finding.id,
          description:
            `The risk acceptance for "${exception.rule.name}" was refused by ${actorName}: ${comment}. ` +
            "Nothing was removed. The incompatible access has to be separated by a person, " +
            "through a campaign decision or a change to what grants it.",
          deepLink: `/admin/govern/sod/violations/${exception.violationId}`,
        });
      }
    }

    await recordEvent(tx, {
      actorUserId,
      action: "govern.exception.decide",
      targetType: "SodException",
      targetId: exceptionId,
      outcome: "success",
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
/**
 * An early ending by a person. Same tail as the timer, and same guarantee:
 * NOTHING IS REVOKED. The violation reopens, everybody involved is told, and
 * the audit event says in words that no access moved.
 *
 * §15 names who may do it: "an approver or the rule owner". Neither was
 * checked, because nothing called this function -- it was exported, tested, and
 * reachable from no route and no job, so the capability was in the codebase and
 * not in the product.
 *
 * THE BENEFICIARY IS REFUSED, at the other end of the exception's life from
 * where the self-approval invariant usually applies. They gain nothing by
 * ending their own acceptance -- it reopens a finding against them -- but the
 * person who accepts a risk is the person who carries it, and ending the
 * acceptance is the same decision in reverse.
 */
export async function revokeSodException(
  tenantId: string,
  actorUserId: string,
  exceptionId: string,
  reason: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const exception = await tx.sodException.findUniqueOrThrow({
      where: { id: exceptionId },
      include: { rule: { include: { functionA: true } } },
    });
    if (exception.status !== "active") {
      throw new ExceptionRefusedError(
        "not_active",
        `this exception is ${exception.status}; only an active one can be ended early`,
      );
    }

    const actor = await tx.user.findUniqueOrThrow({
      where: { id: actorUserId },
      select: { personId: true },
    });
    if (actor.personId === null) {
      throw new ExceptionRefusedError(
        "not_an_acceptor",
        "this account is linked to no person, so it cannot end a risk acceptance",
      );
    }
    if (actor.personId === exception.personId) {
      throw new ExceptionRefusedError(
        "not_an_acceptor",
        "the beneficiary of an exception may not end it on their own behalf",
      );
    }

    // RE-RESOLVED at the decision, never trusted from the request, and the same
    // resolver the acceptance used -- so a rule that names a workflow is ended
    // by the same people who could have approved it.
    const acceptors = await resolveAcceptors(tx, exception.rule, exception.personId, new Date());
    const permitted =
      acceptors.includes(actor.personId) ||
      actor.personId === exception.approvedByPersonId ||
      actor.personId === exception.rule.functionA.ownerPersonId;
    if (!permitted) {
      throw new ExceptionRefusedError(
        "not_an_acceptor",
        "only an approver of this exception, or the owner of the rule it covers, may end it early",
      );
    }

    await lapse(tx, tenantId, exception, new Date(), reason, "revoked");
    await tx.sodException.update({
      where: { id: exceptionId },
      data: { revokedByUserId: actorUserId },
    });
    await recordEvent(tx, {
      actorUserId,
      action: "govern.exception.revoke",
      targetType: "SodException",
      targetId: exceptionId,
      outcome: "success",
      sourceIp: null,
      // Stated in the event, as on every other ending: no access moved.
      payload: {
        reason,
        violationId: exception.violationId,
        accessRevoked: false,
      },
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
/**
 * EXCEPTIONS PER SWEEP TRANSACTION.
 *
 * 100 rather than 200, because `lapse` is heavy per row: it updates the
 * exception, updates the violation, reads and updates the finding, resolves
 * recipients, enqueues outbox rows, and calls `recordEvent` -- which takes a
 * PER-TENANT ADVISORY LOCK for the duration of its transaction. So a loop over
 * every active exception in one transaction does not merely risk the 5000 ms
 * ceiling, it serialises every other audited action in the tenant behind
 * itself while it runs.
 *
 * And this sweep runs inside `runSnapshotJob`, AFTER earlier stages have
 * committed, so an abort here retries the whole job and builds a second
 * snapshot -- which is how one slow sweep turned into two nights of inventory.
 */
/**
 * The warning threshold this exception has crossed and not yet passed below,
 * or null.
 *
 * EDGE-TRIGGERED ON AN EXACT DAY COUNT IS WHAT THIS REPLACES. The old form was
 * `if (!warningDays.includes(daysLeft)) continue;` with defaults of `[14, 3]`,
 * and the sweep runs daily -- so ONE skipped run lost the warning entirely. A
 * restart, a failed job, or a paused cadence (which, until the schedule switch
 * was fixed, is what pausing SNAPSHOTS did) meant the three-day warning was
 * never sent and the exception lapsed with nobody told. §15's entire point is
 * that somebody is told BEFORE it lapses.
 *
 * The LOWEST threshold crossed, so an exception with one day left reports the
 * three-day warning rather than the fourteen-day one: the message that matters
 * is the near one, and reporting the far one would mask it.
 *
 * PURE, so the arithmetic is tested as plain values rather than by seeding a
 * database and moving a clock.
 */
export function shouldWarn(
  endsAt: Date,
  now: Date,
  warningDays: readonly number[],
): number | null {
  const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000);
  // Already over. The lapse branch owns it, and a warning about something that
  // has ended is a notification nobody can act on.
  if (daysLeft <= 0) return null;
  const crossed = [...warningDays].filter((threshold) => daysLeft <= threshold);
  return crossed.length === 0 ? null : Math.min(...crossed);
}

export const EXCEPTION_SWEEP_BATCH = 100;

export async function sweepExceptions(
  tenantId: string,
  options: { now?: Date; publicUrl?: string; batchSize?: number } = {},
): Promise<{ warned: number; lapsed: number; lapsedByContract: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? EXCEPTION_SWEEP_BATCH;

  const settings = await withTenant(tenantId, (tx) => governSettings(tx));

  let warned = 0;
  let lapsed = 0;
  let lapsedByContract = 0;

  // A SHORT TRANSACTION RETURNING PLAIN DATA, then per-batch work in its own.
  // Paged by id, not by status: `lapse` moves rows out of `active`, so a
  // status-only page would be re-read as "the next page" and a warning-only
  // page would loop forever.
  let cursor: string | null = null;
  for (;;) {
    const page = await withTenant(tenantId, (tx) =>
      tx.sodException.findMany({
        where: {
          status: "active",
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        include: { rule: true },
        orderBy: { id: "asc" },
        take: batchSize,
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      let pageWarned = 0;
      let pageLapsed = 0;
      let pageByContract = 0;

      for (const exception of page) {
        // The one place an exception ends early without a human, and it is safe
        // because ending an exception TAKES NOTHING AWAY FROM ANYBODY — it
        // reopens a finding. Where the stated basis is a pair of concurrent
        // contracts, the justification stopped being true when one of them ended.
        const basis = (exception.basisContractIds as string[] | null) ?? [];
        if (basis.length > 0) {
          const stillRunning = await tx.contract.count({
            where: {
              id: { in: basis },
              OR: [{ endDate: null }, { endDate: { gte: now } }],
            },
          });
          if (stillRunning < basis.length) {
            await lapse(
              tx,
              tenantId,
              exception,
              now,
              "a contract its justification rested on has ended",
            );
            pageLapsed += 1;
            pageByContract += 1;
            continue;
          }
        }

        if (exception.endsAt <= now) {
          await lapse(
            tx,
            tenantId,
            exception,
            now,
            "it reached its end date and was not renewed",
          );
          pageLapsed += 1;
          continue;
        }

        const threshold = shouldWarn(exception.endsAt, now, settings.exceptionWarningDays);
        if (threshold === null) continue;

        // DE-DUPLICATED AGAINST WHAT WAS ACTUALLY SENT, because a bucket fires
        // every day inside itself and §15 asks for a warning, not a daily nag.
        //
        // The outbox is the record: it holds the template, a `renewUrl` naming
        // this exception, and -- written for exactly this purpose --
        // `warningDays`, the threshold that row was sent for. A `lastWarnedAt`
        // column would be tidier and would need a migration for a fact already
        // written down.
        //
        // KEYED ON THE THRESHOLD, NOT ON A TIME WINDOW. The obvious form is
        // "any warning since this bucket opened", and it is wrong here: the
        // outbox row's `createdAt` is the database's wall clock, while the
        // bucket is derived from `endsAt` and the sweep's INJECTED `now`. Those
        // two agree in production and diverge in every test that moves the
        // clock, which is every test of this function. The threshold is the
        // fact being de-duplicated on, so it is the thing to store.
        const alreadySent = await tx.notificationOutbox.count({
          where: {
            template: "govern-exception-expiring",
            AND: [
              { vars: { path: ["renewUrl"], string_contains: exception.id } },
              { vars: { path: ["warningDays"], equals: String(threshold) } },
            ],
          },
        });
        if (alreadySent > 0) continue;

        const parties = await recipientsForPersons(
          tx,
          [exception.personId, exception.approvedByPersonId].filter(
            (x): x is string => typeof x === "string",
          ),
        );
        const names = await displayNames(tx, {
          personIds: [exception.personId],
        });
        await enqueueOutbox(
          tx,
          parties.map((recipient) => ({
            template: "govern-exception-expiring" as const,
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              ruleName: exception.rule.name,
              beneficiaryName:
                names.get(`person:${exception.personId}`) ?? "the beneficiary",
              endsAt: exception.endsAt.toDateString(),
              // Renewal is a NEW exception with a new decision, pre-filled with
              // the old justification. Never auto-renewal, which is approval by
              // inattention wearing a different hat.
              renewUrl: `${options.publicUrl ?? ""}/admin/govern/sod/exceptions/new?renew=${exception.id}`,
              // Not rendered by the template. Written so the next sweep can
              // tell WHICH warning this row was, which is what makes the
              // bucket fire once rather than every day inside itself.
              warningDays: String(threshold),
            },
            requestId: null,
            userId: recipient.userId,
          })),
        );
        pageWarned += 1;
      }

      return { pageWarned, pageLapsed, pageByContract };
    });

    warned += outcome.pageWarned;
    lapsed += outcome.pageLapsed;
    lapsedByContract += outcome.pageByContract;
  }

  return { warned, lapsed, lapsedByContract };
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
  exception: {
    id: string;
    ruleId: string;
    personId: string;
    violationId: string;
  },
  now: Date,
  reason: string,
  status: "lapsed" | "revoked" = "lapsed",
): Promise<void> {
  await tx.sodException.update({
    where: { id: exception.id },
    data: { status, revokedReason: reason },
  });
  const violation = await tx.sodViolation.update({
    where: { id: exception.violationId },
    // Its ORIGINAL severity: the exception never changed what the violation is,
    // only whether somebody had accepted it.
    data: { status: "open", exceptionId: null },
  });

  const finding = await tx.governFinding.findFirst({
    where: {
      kind: "sod_violation",
      subjectRefType: "sod_violation",
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

  const parties = await recipientsForPersons(tx, [
    exception.personId,
    violation.personId,
  ]);
  const names = await displayNames(tx, { personIds: [exception.personId] });
  const rule = await tx.sodRule.findUniqueOrThrow({
    where: { id: exception.ruleId },
    select: { name: true },
  });
  await enqueueOutbox(
    tx,
    parties.map((recipient) => ({
      template: "govern-exception-expiring" as const,
      to: recipient.email,
      vars: {
        displayName: recipient.displayName,
        ruleName: rule.name,
        beneficiaryName:
          names.get(`person:${exception.personId}`) ?? "the beneficiary",
        endsAt: now.toDateString(),
        renewUrl: `/admin/govern/sod/exceptions/new?renew=${exception.id}`,
      },
      requestId: null,
      userId: recipient.userId,
    })),
  );

  await recordEvent(tx, {
    actorUserId: null,
    action: "govern.exception.lapse",
    targetType: "SodException",
    targetId: exception.id,
    outcome: "success",
    sourceIp: null,
    // Stated in the event as well as on the screen: nothing was removed.
    payload: {
      reason,
      violationId: exception.violationId,
      status,
      accessRevoked: false,
    },
  });
}
