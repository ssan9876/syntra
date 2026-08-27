import { prisma, withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import {
  renderMessage,
  sendMessage,
  type Transport,
} from '../notify/notification-service.js';
import type { TemplateName } from '../notify/templates/index.js';
import { assignApplication } from '../access/assignment-service.js';
import { addMember } from '../directory/group-service.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { automateSettings } from './catalog-service.js';
import { applyExpirySweep, previewExpirySweep } from './sweep-service.js';
import { reflectProvisionOutcomes } from './reflect.js';
import { resolveEscalationApprovers, type StageSnapshot } from './approvers.js';
import { subjectFor } from './request-service.js';
import { displayNames, enqueueOutbox, recipientsForPersons } from './notify.js';
import { requestUrl } from './fulfil.js';
import { IN_FORCE_GRANT_STATUSES } from './types.js';

export const AUTOMATE_OUTBOX_JOB = 'automate.outbox';
export const AUTOMATE_TICK_JOB = 'automate.tick';
export const AUTOMATE_SWEEP_JOB = 'automate.sweep';
/**
 * The daily summary pass.
 *
 * Without it, `enqueueOutbox`'s `digest: true` is a row nothing ever sends:
 * a person who chose a daily summary receives NOTHING, including every
 * stage-opened notification, which means approvals sit in a queue nobody has
 * been told about. A half-built preference that silences mail is worse than
 * no preference, and this is the silent-drop class the spec's own constraint
 * 3 calls "the defect class this project keeps rediscovering".
 */
export const AUTOMATE_DIGEST_JOB = 'automate.digest';

export type AutomatePurpose = 'outbox' | 'tick' | 'sweep' | 'digest';

/**
 * pg-boss keys its schedule table on (queue, key), and `key` defaults to the
 * empty string. This slice runs three schedules per tenant, so a key that
 * named only the tenant would still collapse two of them.
 *
 * SLASHES, not colons. pg-boss validates the key with `assertObjectName`,
 * which permits word characters, periods, hyphens and forward slashes and
 * nothing else — a colon throws. It throws inside `scheduleBackgroundWork`,
 * whose caller logs the failure and carries on, so the process starts, reports
 * itself healthy, serves every request and silently has no scheduled work.
 * This slice's schedules had never once run in the lab installation, and the
 * only reason nobody noticed is that every one of them also has a manual path.
 * See `jobs/schedule-key.test.ts`, which asserts the character class itself.
 */
export function automateScheduleKey(tenantId: string, purpose: AutomatePurpose): string {
  return `automate/${purpose}/${tenantId}`;
}

export interface AutomateJobPayload {
  tenantId: string;
}

export function automateJobPayload(tenantId: string): AutomateJobPayload {
  return { tenantId };
}

export interface JobOptions {
  now?: Date;
  scheduler?: Scheduler | null;
  publicUrl?: string;
  batchSize?: number;
}

/** After this many failures a row stops being retried and starts being visible. */
export const OUTBOX_MAX_ATTEMPTS = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How many rows one transaction in `runTickJob` handles.
 *
 * `withTenant` is `prisma.$transaction` with Prisma's **5000 ms** default and
 * no `transactionOptions` on the client. Each open step is roughly four
 * queries and each warning-window grant carries a JSON-path `count`, so a
 * tenant-sized pass in one transaction is a P2028 every five minutes. Every
 * pass here is idempotent, so a batch that fails is simply redone on the next
 * tick rather than lost.
 */
const TICK_BATCH = 50;

/** Splits a work list into transaction-sized batches. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

/**
 * Reads the outbox, renders each message, sends it, and records what happened.
 *
 * Three phases, and the middle one holds no transaction: read the rows out,
 * send, write the results back. `renderMessage` is pure and takes the tenant
 * name as a parameter; `sendMessage` takes a transport and cannot be handed a
 * `TenantClient`, because the signature was deliberately changed after an SMTP
 * round trip inside `prisma.$transaction` shipped as a defect.
 */
export async function runOutboxJob(
  transport: Transport,
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ sent: number; failed: number }> {
  const batchSize = options.batchSize ?? 200;

  // Phase 1: read out. The tenant NAME comes with it, so nothing downstream
  // needs a transaction to render.
  const tenant = await prisma.tenant.findUnique({
    where: { id: payload.tenantId },
    select: { name: true },
  });
  if (tenant === null) return { sent: 0, failed: 0 };

  const rows = await withTenant(payload.tenantId, (tx) =>
    tx.notificationOutbox.findMany({
      where: {
        sentAt: null,
        digest: false,
        attempts: { lt: OUTBOX_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    }),
  );

  // Phase 2: the network. No transaction is held.
  const results: { id: string; error: string | null }[] = [];
  for (const row of rows) {
    try {
      const message = renderMessage(
        tenant.name,
        row.template as TemplateName,
        row.to,
        (row.vars ?? {}) as Record<string, string>,
      );
      await sendMessage(transport, message);
      results.push({ id: row.id, error: null });
    } catch (cause) {
      results.push({ id: row.id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  // Phase 3: write the results back, one short transaction.
  const now = options.now ?? new Date();
  let sent = 0;
  let failed = 0;
  await withTenant(payload.tenantId, async (tx) => {
    for (const result of results) {
      if (result.error === null) {
        await tx.notificationOutbox.update({
          where: { id: result.id },
          data: { sentAt: now, lastError: null },
        });
        sent += 1;
      } else {
        // Never deleted. A row that exhausts its attempts is surfaced, not
        // swallowed: "the approver says they never got the mail" is
        // unanswerable without it.
        await tx.notificationOutbox.update({
          where: { id: result.id },
          data: { attempts: { increment: 1 }, lastError: result.error },
        });
        failed += 1;
      }
    }
  });

  return { sent, failed };
}

/**
 * The daily pass over the digest rows.
 *
 * One message per recipient listing what was held back, rather than one
 * message per row -- which would be the immediate mode with a delay attached.
 * Failures, blocks and confirmations never reach here at all: `enqueueOutbox`
 * writes `digest: false` on every `NEVER_DIGESTED` template whatever the
 * recipient's preference says.
 *
 * Same three-phase shape as `runOutboxJob`: read out, send with no
 * transaction held, write the results back.
 */
export async function runDigestJob(
  transport: Transport,
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ sent: number }> {
  const now = options.now ?? new Date();
  const tenant = await prisma.tenant.findUnique({
    where: { id: payload.tenantId },
    select: { name: true },
  });
  if (tenant === null) return { sent: 0 };

  const rows = await withTenant(payload.tenantId, (tx) =>
    tx.notificationOutbox.findMany({
      where: { sentAt: null, digest: true, attempts: { lt: OUTBOX_MAX_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
    }),
  );
  if (rows.length === 0) return { sent: 0 };

  const byRecipient = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byRecipient.get(row.to) ?? [];
    list.push(row);
    byRecipient.set(row.to, list);
  }

  let sent = 0;
  const delivered: string[] = [];
  const failures: { id: string; error: string }[] = [];
  for (const [to, group] of byRecipient) {
    const message = renderMessage(tenant.name, 'automate-digest', to, {
      displayName: (group[0]?.vars as Record<string, string>)?.displayName ?? 'there',
      count: String(group.length),
      lines: group
        .map(
          (row) =>
            `- ${(row.vars as Record<string, string>)?.productName ?? row.template}`,
        )
        .join('\n'),
    });
    try {
      await sendMessage(transport, message);
      delivered.push(...group.map((row) => row.id));
      sent += 1;
    } catch (cause) {
      // Left unsent. The attempts column is what makes a dead recipient
      // visible rather than a row that quietly stops being tried.
      const error = cause instanceof Error ? cause.message : String(cause);
      for (const row of group) failures.push({ id: row.id, error });
    }
  }

  await withTenant(payload.tenantId, async (tx) => {
    if (delivered.length > 0) {
      await tx.notificationOutbox.updateMany({
        where: { id: { in: delivered } },
        data: { sentAt: now },
      });
    }
    for (const failure of failures) {
      await tx.notificationOutbox.update({
        where: { id: failure.id },
        data: { attempts: { increment: 1 }, lastError: failure.error },
      });
    }
  });

  return { sent };
}

/**
 * The five-minute pass: promotion of scheduled grants, reminders, escalation,
 * opt-in expiry, expiry warnings, and reflection of whatever Provision has
 * done since.
 *
 * There is NO branch in this function that approves anything. That is not a
 * convention here: `request-service.ts`, `decision-service.ts` and
 * `delegation-service.ts` are the only three modules in the slice that write
 * the approved status -- the list is `APPROVED_ENTRY_POINTS` -- and Task 11's
 * structural test asserts it over the set of files.
 */
export async function runTickJob(
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{
  reminders: number;
  escalations: number;
  expired: number;
  warnings: number;
  promoted: number;
}> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';
  const counts = { reminders: 0, escalations: 0, expired: 0, warnings: 0, promoted: 0 };
  const targetsToRun = new Set<string>();
  const batchSize = options.batchSize ?? TICK_BATCH;

  // ---- Phase 1: settings, and the three work lists. -----------------------
  //
  // Each pass below opens its OWN transaction, in batches. An earlier draft
  // ran all three inside one `withTenant`: every open `ApprovalStep` at ~4
  // queries each, then every warning-window grant with a JSON-path `count`
  // apiece, then the promotion loop. `withTenant` is `prisma.$transaction`
  // with Prisma's **5000 ms** default and no `transactionOptions` on the
  // client, so at any real tenant size that is a P2028 every five minutes,
  // on the pass that sends every reminder and every expiry warning in the
  // product. Batching is what makes the failure a batch rather than the
  // whole pass; the work is idempotent, so a batch that fails is redone on
  // the next tick.
  const settings = await withTenant(payload.tenantId, (tx) => automateSettings(tx));

  // ---- Phase 2: scheduled grants whose start date has arrived. ------------
    //
    // `GrantStatus` has `scheduled`, `LIVE_GRANT_STATUSES` includes it,
    // `fulfilRequest` writes it for a pre-hire, and until this pass existed
    // NOTHING moved a grant out of it. The consequences were permanent and
    // all silent: the run-service snapshot loads only `pending`/`active`, so
    // the pre-hire's target entitlement was never in desired state -- not
    // before the start date, correctly, and not after it either; the
    // `AppAssignment`/`GroupMembership` was written only `if (!window.scheduled)`
    // and never afterwards; and `classifySweep` skips anything outside
    // `IN_FORCE_GRANT_STATUSES`, so the row occupied the
    // `access_grant_one_live` slot forever and the person could never be
    // granted that resource again by any route. Spec section 7 says a
    // scheduled grant "becomes `pending` on the day", and on its day
    // something has to make it confer.
  const dueIds = await withTenant(payload.tenantId, async (tx) =>
    (
      await tx.accessGrant.findMany({
        where: { status: 'scheduled', startsAt: { lte: now } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  for (const batch of chunk(dueIds, batchSize)) {
    await withTenant(payload.tenantId, async (tx) => {
      const due = await tx.accessGrant.findMany({ where: { id: { in: batch } } });
      for (const grant of due) {
        if (grant.resourceType === 'entitlement') {
          // `pending` until Provision confirms it, exactly as fulfilment
          // writes it for somebody who has already started.
          await tx.accessGrant.update({
            where: { id: grant.id },
            data: { status: 'pending' },
          });
          if (grant.targetSystemId !== null) targetsToRun.add(grant.targetSystemId);
          counts.promoted += 1;
          continue;
        }
        const users = await tx.user.findMany({
          where: { personId: grant.subjectPersonId, status: 'active' },
          select: { id: true },
        });
        // Only the rows this promotion creates, recorded on the grant, so
        // ending it later deletes those and nothing else (the same rule
        // `fulfilRequest` follows).
        const writtenRowIds: string[] = [...grant.writtenRowIds];
        for (const user of users) {
          if (grant.resourceType === 'application') {
            const where = {
              applicationId: grant.resourceId,
              userId: user.id,
              groupId: null,
              orgUnitId: null,
            };
            const before = await tx.appAssignment.findFirst({ where, select: { id: true } });
            if (before !== null) continue;
            await assignApplication(tx, grant.resourceId, { type: 'user', id: user.id });
            const created = await tx.appAssignment.findFirst({ where, select: { id: true } });
            if (created !== null) writtenRowIds.push(created.id);
          } else {
            const membershipKey = { groupId: grant.resourceId, userId: user.id };
            const before = await tx.groupMembership.findUnique({
              where: { groupId_userId: membershipKey },
              select: { id: true },
            });
            if (before !== null) continue;
            await addMember(tx, grant.resourceId, user.id);
            const created = await tx.groupMembership.findUnique({
              where: { groupId_userId: membershipKey },
              select: { id: true },
            });
            if (created !== null) writtenRowIds.push(created.id);
          }
        }
        await tx.accessGrant.update({
          where: { id: grant.id },
          data: { status: 'active', writtenRowIds },
        });
        await recordEvent(tx, {
          actorUserId: null,
          action: 'automate.grant.promote',
          targetType: 'AccessGrant',
          targetId: grant.id,
          outcome: 'success',
          sourceIp: null,
          payload: {
            subjectPersonId: grant.subjectPersonId,
            resourceType: grant.resourceType,
            resourceId: grant.resourceId,
            startsAt: grant.startsAt.toISOString(),
          },
        });
        counts.promoted += 1;
      }
    });
  }

  // ---- Phase 3: the open approval steps. ---------------------------------
  const openStepIds = await withTenant(payload.tenantId, async (tx) =>
    (await tx.approvalStep.findMany({ where: { status: 'open' }, select: { id: true } })).map(
      (row) => row.id,
    ),
  );

  for (const stepBatch of chunk(openStepIds, batchSize)) {
   await withTenant(payload.tenantId, async (tx) => {
    const openSteps = await tx.approvalStep.findMany({
      where: { id: { in: stepBatch } },
      include: { request: { include: { product: true } } },
    });

    // Names for every notification the loop below writes. One read per batch;
    // an unknown id is simply absent, so nothing renders a UUID.
    const stepNames = await displayNames(tx, {
      personIds: openSteps.map((step) => step.request.subjectPersonId),
    });

    for (const step of openSteps) {
      const stage = step.stageSnapshot as unknown as StageSnapshot;
      if (step.slaDueAt === null || step.openedAt === null) continue;

      // Spec section 8: "at 50% and 100% of the SLA, then daily". A single
      // daily gate swallows the 100% reminder whenever the SLA is under 24
      // hours -- which is the case where being reminded on time matters most.
      // So the two milestones fire on their own, once each, and the daily
      // cadence starts after 100%.
      const halfway = new Date(step.openedAt.getTime() + (stage.slaHours / 2) * HOUR_MS);
      const dueAt = new Date(step.openedAt.getTime() + stage.slaHours * HOUR_MS);
      const remindedAt = step.lastRemindedAt;
      const dueForReminder =
        remindedAt === null
          ? now >= halfway
          : remindedAt < dueAt && now >= dueAt
            ? true
            : now >= dueAt && now.getTime() - remindedAt.getTime() >= DAY_MS;

      if (stage.onTimeout === 'expire' && stage.expiryHours !== null) {
        const expiresAt = new Date(step.openedAt.getTime() + stage.expiryHours * HOUR_MS);
        if (now >= expiresAt) {
          await tx.approvalStep.updateMany({
            where: { requestId: step.requestId, status: { in: ['open', 'waiting'] } },
            data: { status: 'skipped', closedAt: now },
          });
          await tx.accessRequest.update({
            where: { id: step.requestId },
            data: {
              status: 'expired',
              statusReason: `nobody decided within ${stage.expiryHours} hours`,
              decidedAt: now,
            },
          });
          await recordEvent(tx, {
            actorUserId: null,
            action: 'automate.request.expire',
            targetType: 'AccessRequest',
            targetId: step.requestId,
            outcome: 'success',
            sourceIp: null,
            payload: { stageSequence: step.sequence, expiryHours: stage.expiryHours },
          });
          const recipients = await recipientsForPersons(tx, [
            step.request.subjectPersonId,
            ...(step.request.requestedByPersonId === null
              ? []
              : [step.request.requestedByPersonId]),
          ]);
          await enqueueOutbox(
            tx,
            recipients.map((r) => ({
              template: 'automate-request-expired' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                expiryHours: String(stage.expiryHours),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          );
          counts.expired += 1;
          continue;
        }
      }

      if (stage.onTimeout === 'escalate' && now >= step.slaDueAt && step.escalatedAt === null) {
        const subject = await subjectFor(tx, step.requestId);
        const escalation = await resolveEscalationApprovers(tx, stage, subject, now);
        if (escalation.approvers.length > 0) {
          const existing = await tx.approvalStepApprover.findMany({
            where: { stepId: step.id },
            select: { personId: true },
          });
          const existingIds = new Set(existing.map((e) => e.personId));
          // ADDED, not substituted. Escalation that silently removes somebody's
          // authority is how an approver discovers, months later, that
          // decisions attributed to their team were not theirs.
          for (const approver of escalation.approvers) {
            if (existingIds.has(approver.personId)) continue;
            await tx.approvalStepApprover.create({
              data: {
                tenantId: step.tenantId,
                stepId: step.id,
                personId: approver.personId,
                via: 'escalation',
                onBehalfOfPersonId: approver.onBehalfOfPersonId,
              },
            });
          }
          await tx.approvalStep.update({
            where: { id: step.id },
            data: { escalatedAt: now },
          });

          const added = await recipientsForPersons(
            tx,
            escalation.approvers.map((a) => a.personId),
          );
          const originals = await recipientsForPersons(tx, [...existingIds]);
          await enqueueOutbox(tx, [
            ...added.map((r) => ({
              template: 'automate-escalated' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName:
                  stepNames.get(`person:${step.request.subjectPersonId}`) ??
                  'the person this is for',
                slaHours: String(stage.slaHours),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
            ...originals.map((r) => ({
              template: 'automate-escalated-past' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName:
                  stepNames.get(`person:${step.request.subjectPersonId}`) ??
                  'the person this is for',
                slaHours: String(stage.slaHours),
                escalatedTo: added.map((a) => a.displayName).join(', '),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          ]);
          counts.escalations += 1;
        }
      }

      if (dueForReminder) {
        const approvers = await tx.approvalStepApprover.findMany({
          where: { stepId: step.id },
          select: { personId: true },
        });
        const recipients = await recipientsForPersons(
          tx,
          approvers.map((a) => a.personId),
        );
        if (recipients.length > 0) {
          await enqueueOutbox(
            tx,
            recipients.map((r) => ({
              template: 'automate-reminder' as const,
              to: r.email,
              vars: {
                displayName: r.displayName,
                productName: step.request.product?.name ?? 'the requested access',
                subjectName:
                  stepNames.get(`person:${step.request.subjectPersonId}`) ??
                  'the person this is for',
                openedAt: step.openedAt!.toDateString(),
                requestUrl: requestUrl(publicUrl, step.requestId),
              },
              requestId: step.requestId,
              userId: r.userId,
            })),
          );
          await tx.approvalStep.update({
            where: { id: step.id },
            data: { lastRemindedAt: now },
          });
          counts.reminders += 1;
        }
      }
    }
   });
  }

  // ---- Phase 4: expiry warnings. -----------------------------------------
  //
  // One per grant per threshold, deduped on the outbox itself and keyed on
  // the number of days, so the 7-day and the 1-day warning are two messages
  // and the 7-day one is not repeated for six days. The dedupe is a
  // JSON-path `count` per grant, which is why this pass in particular has to
  // be batched rather than run whole.
  for (const days of settings.expiryWarningDays) {
    const from = new Date(now.getTime() + (days - 1) * DAY_MS);
    const to = new Date(now.getTime() + days * DAY_MS);
    const warnIds = await withTenant(payload.tenantId, async (tx) =>
      (
        await tx.accessGrant.findMany({
          where: {
            status: { in: [...IN_FORCE_GRANT_STATUSES] },
            endsAt: { gt: from, lte: to },
          },
          select: { id: true },
        })
      ).map((row) => row.id),
    );

    for (const grantBatch of chunk(warnIds, batchSize)) {
     await withTenant(payload.tenantId, async (tx) => {
      const grants = await tx.accessGrant.findMany({ where: { id: { in: grantBatch } } });
      for (const grant of grants) {
        const alreadyWarned = await tx.notificationOutbox.count({
          where: {
            template: 'automate-expiry-warning',
            vars: { path: ['grantId'], equals: grant.id },
            AND: [{ vars: { path: ['days'], equals: String(days) } }],
          },
        });
        if (alreadyWarned > 0) continue;
        const recipients = await recipientsForPersons(tx, [
          grant.subjectPersonId,
          ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
        ]);
        if (recipients.length === 0) continue;
        const grantNames = await displayNames(tx, {
          personIds: [grant.subjectPersonId],
          productIds: grant.productId === null ? [] : [grant.productId],
          resources: [
            {
              resourceType: grant.resourceType as 'entitlement' | 'application' | 'group',
              resourceId: grant.resourceId,
            },
          ],
        });
        await enqueueOutbox(
          tx,
          recipients.map((r) => ({
            template: 'automate-expiry-warning' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              subjectName: grantNames.get(`person:${grant.subjectPersonId}`) ?? 'the holder',
              productName:
                (grant.productId === null
                  ? undefined
                  : grantNames.get(`product:${grant.productId}`)) ??
                grantNames.get(`${grant.resourceType}:${grant.resourceId}`) ??
                'requested access',
              endsAt: grant.endsAt!.toDateString(),
              days: String(days),
              grantId: grant.id,
              // The Extend action. An extension is a NEW request against the
              // same product, pre-filled -- auto-renewal is approval by
              // inattention wearing a different hat.
              extendUrl: `${publicUrl.replace(/\/$/, '')}/access/${grant.id}/extend`,
            },
            requestId: null,
            userId: r.userId,
          })),
        );
        counts.warnings += 1;
      }
     });
    }
  }

  // Outside every transaction, deliberately: `Scheduler.enqueue` is
  // `boss.send` on pg-boss's own pool and neither joins this transaction nor
  // rolls back with it.
  for (const targetSystemId of targetsToRun) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(payload.tenantId, targetSystemId),
    );
  }

  // Reflection opens its own transaction, and enqueues.
  await reflectProvisionOutcomes(payload.tenantId, {
    now,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    publicUrl,
  });

  return counts;
}

/**
 * The nightly sweep. Previews always; applies only when the guard let it
 * through unblocked and unconfirmable.
 *
 * The scheduler never confirms anything. `applyExpirySweep` is called with no
 * `confirm`, so a sweep that trips either axis simply sits in the review
 * screen with its reasons.
 */
export async function runSweepJob(
  payload: AutomateJobPayload,
  options: JobOptions = {},
): Promise<{ sweepId: string; status: string }> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const sweep = await previewExpirySweep(payload.tenantId, { now, publicUrl });
  if (sweep.status !== 'previewed' || sweep.requiresConfirmation) {
    return { sweepId: sweep.id, status: sweep.status };
  }
  const applied = await applyExpirySweep(payload.tenantId, sweep.id, {
    now,
    publicUrl,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  return { sweepId: sweep.id, status: applied.status };
}

/**
 * Brings the scheduler into line with one tenant.
 *
 * Every queue every time, and the sweep is UNSCHEDULED when the tenant has no
 * cron for it. Scheduling and unscheduling are two halves of one decision: a
 * sweep switched off and merely left out of the next round of scheduling keeps
 * firing.
 */
export async function applyAutomateSchedules(
  scheduler: Scheduler,
  tenantId: string,
  sweepSchedule: string | null,
): Promise<void> {
  await scheduler.schedule(
    AUTOMATE_OUTBOX_JOB,
    '* * * * *',
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'outbox'),
  );
  await scheduler.schedule(
    AUTOMATE_TICK_JOB,
    '*/5 * * * *',
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'tick'),
  );
  // Daily, in the morning. Its own key: pg-boss keys the schedule table on
  // (queue, key), and this slice now runs four schedules per tenant.
  await scheduler.schedule(
    AUTOMATE_DIGEST_JOB,
    '0 7 * * *',
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'digest'),
  );
  if (sweepSchedule === null) {
    await scheduler.unschedule(
      AUTOMATE_SWEEP_JOB,
      automateScheduleKey(tenantId, 'sweep'),
    );
    return;
  }
  await scheduler.schedule(
    AUTOMATE_SWEEP_JOB,
    sweepSchedule,
    automateJobPayload(tenantId),
    automateScheduleKey(tenantId, 'sweep'),
  );
}

/**
 * Registers the four handlers.
 *
 * `transport` is a parameter rather than constructed here for the reason
 * `buildApp` takes one: no test run may put mail on the wire, and a transport
 * that is a parameter is the only way to guarantee that.
 */
export function registerAutomateJobs(
  scheduler: Scheduler,
  transport: Transport,
  options: { publicUrl?: string } = {},
): void {
  scheduler.register<AutomateJobPayload>(AUTOMATE_OUTBOX_JOB, async (payload) => {
    await runOutboxJob(transport, payload, { publicUrl: options.publicUrl ?? '' });
  });
  scheduler.register<AutomateJobPayload>(AUTOMATE_DIGEST_JOB, async (payload) => {
    await runDigestJob(transport, payload, { publicUrl: options.publicUrl ?? '' });
  });
  scheduler.register<AutomateJobPayload>(AUTOMATE_TICK_JOB, async (payload) => {
    await runTickJob(payload, { scheduler, publicUrl: options.publicUrl ?? '' });
  });
  scheduler.register<AutomateJobPayload>(AUTOMATE_SWEEP_JOB, async (payload) => {
    await runSweepJob(payload, { scheduler, publicUrl: options.publicUrl ?? '' });
  });
}
