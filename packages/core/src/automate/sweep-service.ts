import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { addDays } from '../provision/plan.js';
import type { ConditionFacts } from '../provision/condition.js';
import {
  audienceAdmits,
  type AudienceCondition,
  type SubjectSetFacts,
} from './audience.js';
import { allSubjectAudienceFacts, automateSettings } from './catalog-service.js';
import {
  displayNames,
  enqueueOutbox,
  nameList,
  recipientsForPersons,
  usersWithPermission,
} from './notify.js';
import { evaluateSweepGuard } from './sweep-guard.js';
import {
  IN_FORCE_GRANT_STATUSES,
  type ResourceType,
  type SweepActionKind,
} from './types.js';

export interface SweepGrantFacts {
  grantId: string;
  subjectPersonId: string;
  productId: string | null;
  resourceType: 'entitlement' | 'application' | 'group';
  resourceId: string;
  targetSystemId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  needsReview: boolean;
  supersededByGrantId: string | null;
}

export interface ContractWindow {
  startDate: Date;
  endDate: Date | null;
}

export interface SweepInput {
  grants: SweepGrantFacts[];
  contractsByPerson: ReadonlyMap<string, ContractWindow[]>;
  audienceByProduct: ReadonlyMap<string, AudienceCondition | null>;
  factsByPerson: ReadonlyMap<string, { contracts: ConditionFacts[] } & SubjectSetFacts>;
  /**
   * The pre-hire horizon that applies to each grant: the target system's
   * `preHireDays` for an entitlement grant, and the tenant's
   * `preHireHorizonDays` for an application or local group grant, which has no
   * target to inherit from.
   */
  horizonDaysByGrant: ReadonlyMap<string, number>;
  now: Date;
}

export interface ClassifiedAction {
  grantId: string;
  kind: SweepActionKind;
  subjectPersonId: string;
  productId: string | null;
  resourceType: string;
  resourceId: string;
  targetSystemId: string | null;
  message: string;
}

export interface SweepClassification {
  actions: ClassifiedAction[];
  reviewFlags: { grantId: string; reason: string }[];
  exceptions: { personId: string; kind: 'no_contracts' | 'not_yet_started'; message: string }[];
}

/** The LATEST end across all contracts, or null when any is open-ended. */
export function latestContractEndFor(contracts: readonly ContractWindow[]): Date | null {
  if (contracts.length === 0) return null;
  if (contracts.some((c) => c.endDate === null)) return null;
  return contracts.reduce<Date>(
    (latest, c) => (c.endDate! > latest ? c.endDate! : latest),
    contracts[0]!.endDate!,
  );
}

/**
 * Pure. Each grant becomes an `expire` action, a `lapse` action, or nothing.
 *
 * The review flag is deliberately NOT an action: it changes nothing about what
 * the person holds, so the guard does not count it and the review screen
 * cannot skip it.
 */
export function classifySweep(input: SweepInput): SweepClassification {
  const actions: ClassifiedAction[] = [];
  const reviewFlags: { grantId: string; reason: string }[] = [];
  const exceptions: SweepClassification['exceptions'] = [];
  const reported = new Set<string>();

  for (const grant of input.grants) {
    if (!(IN_FORCE_GRANT_STATUSES as readonly string[]).includes(grant.status)) continue;
    // An approved extension already replaced this one. Expiring it now would
    // revoke at the target and re-grant an hour later.
    if (grant.supersededByGrantId !== null) continue;

    const contracts = input.contractsByPerson.get(grant.subjectPersonId) ?? [];
    const horizonDays = input.horizonDaysByGrant.get(grant.grantId) ?? 0;
    const horizon = addDays(input.now, horizonDays);

    // Three meanings of "no active contract", and they are Provision's, used
    // rather than reinvented.
    if (contracts.length === 0) {
      // An incomplete record, not a departure. NOTHING lapses.
      if (!reported.has(grant.subjectPersonId)) {
        reported.add(grant.subjectPersonId);
        exceptions.push({
          personId: grant.subjectPersonId,
          kind: 'no_contracts',
          message:
            'this person holds no contract at all, so there is no departure date to lapse their requested access from',
        });
      }
      continue;
    }

    const inForce = contracts.some(
      (c) => c.startDate <= input.now && (c.endDate === null || input.now <= c.endDate),
    );
    const startingSoon = contracts.some(
      (c) => c.startDate > input.now && c.startDate <= horizon,
    );

    if (!inForce && !startingSoon) {
      const allInFuture = contracts.every((c) => c.startDate > input.now);
      if (allInFuture) {
        // A future joiner. Grants already held are left alone and reported: a
        // grant held by somebody who has not started is a question.
        if (!reported.has(grant.subjectPersonId)) {
          reported.add(grant.subjectPersonId);
          exceptions.push({
            personId: grant.subjectPersonId,
            kind: 'not_yet_started',
            message:
              'every contract this person holds starts beyond the pre-hire horizon, so nothing of theirs lapses',
          });
        }
        continue;
      }

      // A leaver. On the LATEST end date across all their contracts, with no
      // grace: requested access is access beyond what the job required.
      const end = latestContractEndFor(contracts);
      actions.push({
        grantId: grant.grantId,
        kind: 'lapse',
        subjectPersonId: grant.subjectPersonId,
        productId: grant.productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
        message: `every contract ended by ${end?.toISOString().slice(0, 10) ?? 'an unknown date'}`,
      });
      continue;
    }

    if (grant.endsAt !== null && input.now >= grant.endsAt) {
      actions.push({
        grantId: grant.grantId,
        kind: 'expire',
        subjectPersonId: grant.subjectPersonId,
        productId: grant.productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId,
        message: `the grant ended on ${grant.endsAt.toISOString().slice(0, 10)}`,
      });
      continue;
    }

    // A mover: the grant survives and is flagged, once.
    if (grant.needsReview || grant.productId === null) continue;
    const condition = input.audienceByProduct.get(grant.productId);
    if (condition === undefined) continue;
    const facts = input.factsByPerson.get(grant.subjectPersonId);
    if (facts === undefined) continue;
    if (!audienceAdmits(condition, facts.contracts, facts)) {
      reviewFlags.push({
        grantId: grant.grantId,
        reason:
          'the subject no longer satisfies the audience for the product this was granted from',
      });
    }
  }

  return { actions, reviewFlags, exceptions };
}

/**
 * Computes the plan and writes it down. Applies nothing.
 *
 * **Three phases, deliberately.** Spec section 16 requires the *plan write* to
 * be one transaction, so a sweep that fails partway writes no plan at all and
 * there is no readable state in which a sweep is `previewed` with no actions
 * or holds actions while still `running` — which is what makes the review
 * screen trustworthy. It does NOT require the loads to be in that
 * transaction, and they must not be: an earlier draft called
 * `subjectAudienceFacts` once per subject holding a grant, roughly seven
 * round trips each, inside a `prisma.$transaction` whose default timeout is
 * **5000 ms**. On the one nightly job that must not fail, that is a P2028 at
 * any real tenant size.
 *
 *   1. Load — one short `withTenant` returning plain data, a fixed number of
 *      set-based queries whatever the population.
 *   2. Classify and guard — pure, no transaction, no I/O.
 *   3. Write — one `withTenant`: supersede any stale sweep, create this one,
 *      two `createMany`s, the review flags, the audit event, the outbox rows.
 */
export async function previewExpirySweep(
  tenantId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ id: string; status: string; requiresConfirmation: boolean; blockedReason: string | null }> {
  const now = options.now ?? new Date();

  // ---- Phase 1: load ------------------------------------------------------
  const loaded = await withTenant(tenantId, async (tx) => ({
    settings: await automateSettings(tx),
    grants: await tx.accessGrant.findMany({
      where: { status: { in: [...IN_FORCE_GRANT_STATUSES] } },
    }),
    persons: await tx.person.findMany({ select: { id: true } }),
    contracts: await tx.contract.findMany({
      select: { personId: true, startDate: true, endDate: true },
    }),
    products: await tx.product.findMany({
      select: { id: true, name: true, audienceCondition: true },
    }),
    targets: await tx.targetSystem.findMany({
      select: { id: true, preHireDays: true },
    }),
    // Set-based. The per-person form must never be called in a loop over the
    // tenant — see its docstring in catalog-service.ts.
    factsByPerson: await allSubjectAudienceFacts(tx, now),
  }));

  const { settings, grants, persons, contracts, products, targets, factsByPerson } = loaded;

  // ---- Phase 2: classify and guard. Pure. --------------------------------
  const contractsByPerson = new Map<string, ContractWindow[]>();
  for (const person of persons) contractsByPerson.set(person.id, []);
  for (const contract of contracts) {
    const list = contractsByPerson.get(contract.personId) ?? [];
    list.push({ startDate: contract.startDate, endDate: contract.endDate });
    contractsByPerson.set(contract.personId, list);
  }

  const audienceByProduct = new Map<string, AudienceCondition | null>(
    products.map((product) => [
      product.id,
      product.audienceCondition as AudienceCondition | null,
    ]),
  );
  const productNameById = new Map(products.map((product) => [product.id, product.name]));
  const preHireByTarget = new Map(targets.map((target) => [target.id, target.preHireDays]));

  const horizonDaysByGrant = new Map(
    grants.map((grant) => [
      grant.id,
      // Two horizons rather than one. A domain that needs an account three
      // weeks early does not imply a portal tile three weeks early.
      grant.targetSystemId === null
        ? settings.preHireHorizonDays
        : (preHireByTarget.get(grant.targetSystemId) ?? settings.preHireHorizonDays),
    ]),
  );

  const classification = classifySweep({
    grants: grants.map((grant) => ({
      grantId: grant.id,
      subjectPersonId: grant.subjectPersonId,
      productId: grant.productId,
      resourceType: grant.resourceType as 'entitlement' | 'application' | 'group',
      resourceId: grant.resourceId,
      targetSystemId: grant.targetSystemId,
      startsAt: grant.startsAt,
      endsAt: grant.endsAt,
      status: grant.status,
      needsReview: grant.needsReview,
      supersededByGrantId: grant.supersededByGrantId,
    })),
    contractsByPerson,
    audienceByProduct,
    factsByPerson,
    horizonDaysByGrant,
    now,
  });

  const personsWithActiveContract = [...contractsByPerson.values()].filter((windows) =>
    windows.some((c) => c.startDate <= now && (c.endDate === null || now <= c.endDate)),
  ).length;

  const internal = classification.actions.filter((a) => a.resourceType !== 'entitlement');
  const internalGrantsInTenant = grants.filter(
    (grant) => grant.resourceType !== 'entitlement',
  ).length;
  const removalsByProduct = new Map<string, number>();
  for (const action of classification.actions) {
    if (action.productId === null) continue;
    removalsByProduct.set(
      action.productId,
      (removalsByProduct.get(action.productId) ?? 0) + 1,
    );
  }
  const activeGrantsByProduct = new Map<string, number>();
  for (const grant of grants) {
    if (grant.productId === null) continue;
    activeGrantsByProduct.set(
      grant.productId,
      (activeGrantsByProduct.get(grant.productId) ?? 0) + 1,
    );
  }

  const verdict = evaluateSweepGuard({
    internalRemovals: internal.length,
    internalGrantsInTenant,
    removalsByProduct,
    activeGrantsByProduct,
    productNameById,
    thresholds: {
      sweepThresholdPercent: settings.sweepThresholdPercent,
      perProductSweepThresholdPercent: settings.perProductSweepThresholdPercent,
      personPopulationDropPercent: settings.personPopulationDropPercent,
    },
    personsWithActiveContract,
    previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastSweep,
    hasEverApplied: settings.lastAppliedSweepAt !== null,
  });

  // ---- Phase 3: write. One transaction. -----------------------------------
  return withTenant(tenantId, async (tx) => {
    // A stale non-terminal sweep must not stop tonight's.
    //
    // `expiry_sweep_one_non_terminal` covers `running`, `previewed`,
    // `blocked` and `applying`, and NOTHING else in this slice moves a sweep
    // out of `blocked` — `applyExpirySweep` returns from a blocked sweep
    // without touching the row. So night 1 the person population drops 25% (a
    // truncated HR import, the accident the refusal exists for), the sweep is
    // written `blocked`; night 2 this `create` raises **P2002**; pg-boss
    // retries three times and gives up; and every night after that the same.
    // No grant in the tenant ever expires or lapses again, and nothing says
    // so — a system that silently stops removing access while continuing to
    // grant it. The same brick happens for a `previewed` sweep nobody
    // confirms, and for one a crashed process left `running` or `applying`.
    //
    // The index and its escape hatch are ONE design. Superseding is loud
    // rather than silent: the old plan stays readable, its status and reason
    // are recorded, and its proposed actions are marked `skipped` so the
    // review screen cannot offer a plan computed against last week's
    // population.
    const stale = await tx.expirySweep.findFirst({
      where: { status: { in: ['running', 'previewed', 'blocked', 'applying'] } },
    });
    if (stale !== null) {
      await tx.expirySweep.update({
        where: { id: stale.id },
        data: {
          status: 'superseded',
          finishedAt: now,
          error: `superseded by a newer sweep on ${now.toISOString().slice(0, 10)}; it was ${stale.status}${stale.blockedReason === null ? '' : `: ${stale.blockedReason}`}`,
        },
      });
      await tx.sweepAction.updateMany({
        where: { sweepId: stale.id, status: 'proposed' },
        data: { status: 'skipped', message: 'superseded by a newer sweep' },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'automate.sweep.supersede',
        targetType: 'ExpirySweep',
        targetId: stale.id,
        outcome: 'success',
        sourceIp: null,
        payload: { wasStatus: stale.status, blockedReason: stale.blockedReason },
      });
    }

    const sweep = await tx.expirySweep.create({
      data: {
        tenantId,
        status: verdict.blocked && !verdict.confirmable ? 'blocked' : 'previewed',
        startedAt: now,
        finishedAt: now,
        expireCount: classification.actions.filter((a) => a.kind === 'expire').length,
        lapseCount: classification.actions.filter((a) => a.kind === 'lapse').length,
        reviewFlagCount: classification.reviewFlags.length,
        personsWithActiveContract,
        personsUnprocessable: classification.exceptions.length,
        internalGrantsInTenant,
        requiresConfirmation: verdict.blocked && verdict.confirmable,
        blockedReason: verdict.blocked ? verdict.reasons.join('; ') : null,
      },
    });

    if (classification.actions.length > 0) {
      await tx.sweepAction.createMany({
        data: classification.actions.map((action) => ({
          tenantId,
          sweepId: sweep.id,
          grantId: action.grantId,
          kind: action.kind,
          productId: action.productId,
          subjectPersonId: action.subjectPersonId,
          resourceType: action.resourceType,
          resourceId: action.resourceId,
          targetSystemId: action.targetSystemId,
          message: action.message,
        })),
      });
    }
    if (classification.exceptions.length > 0) {
      await tx.sweepException.createMany({
        data: classification.exceptions.map((exception) => ({
          tenantId,
          sweepId: sweep.id,
          personId: exception.personId,
          kind: exception.kind,
          message: exception.message,
        })),
      });
    }

    // The flag is applied at PREVIEW, not at apply: it removes nothing, so
    // there is nothing to confirm and nothing to skip.
    if (classification.reviewFlags.length > 0) {
      const flaggedIds = classification.reviewFlags.map((f) => f.grantId);
      const flaggedGrants = await tx.accessGrant.findMany({
        where: { id: { in: flaggedIds } },
      });
      const byId = new Map(flaggedGrants.map((g) => [g.id, g]));
      // Names for every person and resource the flags touch, read once.
      const flagNames = await displayNames(tx, {
        personIds: flaggedGrants.flatMap((g) => [
          g.subjectPersonId,
          ...(g.approvedByPersonId === null ? [] : [g.approvedByPersonId]),
        ]),
        productIds: flaggedGrants.flatMap((g) => (g.productId === null ? [] : [g.productId])),
        resources: flaggedGrants.map((g) => ({
          resourceType: g.resourceType as ResourceType,
          resourceId: g.resourceId,
        })),
      });

      for (const flag of classification.reviewFlags) {
        const grant = byId.get(flag.grantId);
        if (grant === undefined) continue;
        await tx.accessGrant.update({
          where: { id: flag.grantId },
          data: { needsReview: true, reviewReason: flag.reason, reviewedAt: now },
        });
        // Spec section 13: holder, original approver, AND resource owner.
        const owner = await tx.resourceOwner.findFirst({
          where: { resourceType: grant.resourceType, resourceId: grant.resourceId },
          select: { ownerPersonId: true },
        });
        const recipients = await recipientsForPersons(tx, [
          grant.subjectPersonId,
          ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
          ...(owner?.ownerPersonId == null ? [] : [owner.ownerPersonId]),
        ]);
        await enqueueOutbox(
          tx,
          recipients.map((r) => ({
            template: 'automate-review-flagged' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              subjectName:
                flagNames.get(`person:${grant.subjectPersonId}`) ?? 'the holder',
              productName:
                (grant.productId === null
                  ? undefined
                  : flagNames.get(`product:${grant.productId}`)) ??
                nameList(flagNames, [
                  {
                    resourceType: grant.resourceType as ResourceType,
                    resourceId: grant.resourceId,
                  },
                ]),
              grantedAt: grant.createdAt.toDateString(),
              reviewReason: flag.reason,
              grantUrl: `${(options.publicUrl ?? '').replace(/\/$/, '')}/access`,
            },
            requestId: null,
            userId: r.userId,
          })),
        );
      }
    }

    await recordEvent(tx, {
      actorUserId: null,
      action: 'automate.sweep.preview',
      targetType: 'ExpirySweep',
      targetId: sweep.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        expire: sweep.expireCount,
        lapse: sweep.lapseCount,
        reviewFlags: sweep.reviewFlagCount,
        exceptions: sweep.personsUnprocessable,
        requiresConfirmation: sweep.requiresConfirmation,
        blockedReason: sweep.blockedReason,
        supersededSweepId: stale?.id ?? null,
      },
    });

    if (verdict.blocked) {
      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      await enqueueOutbox(
        tx,
        managers.map((r) => ({
          template: 'automate-sweep-confirmation' as const,
          to: r.email,
          vars: {
            displayName: r.displayName,
            actionCount: String(classification.actions.length),
            blockedReason: verdict.reasons.join('; '),
            sweepUrl: `${(options.publicUrl ?? '').replace(/\/$/, '')}/admin/automate/sweeps/${sweep.id}`,
          },
          requestId: null,
          userId: r.userId,
        })),
      );
    }

    return {
      id: sweep.id,
      status: sweep.status,
      requiresConfirmation: sweep.requiresConfirmation,
      blockedReason: sweep.blockedReason,
    };
  });
}

/**
 * Applies a previewed sweep.
 *
 * `confirm` is a separate flag from `confirmedByUserId` so the gate cannot be
 * satisfied by accident: keying it on `confirmedByUserId === undefined` means
 * `confirmedByUserId: null` — what an internal caller writes when it has no
 * user — passes the gate and records "confirmed by nobody". The scheduler
 * never confirms anything.
 *
 * **Batched, at 100 actions per transaction.** Each action is roughly eight
 * statements — a `resourceOwner.findFirst`, a manager `contract.findFirst` on
 * a lapse, an `accountEntitlement.count`, a `recipientsForPersons`, an
 * `accessGrant.update`, a `sweepAction.update`, a `recordEvent` and an
 * `enqueueOutbox` — plus one `displayNames` per batch, so a full batch is
 * 700-800 statements and a tenant-sized sweep in ONE `prisma.$transaction`
 * exceeds the 5000 ms default and raises P2028 — on the job whose whole
 * purpose is removing access that should be gone. The number is not a guess
 * left untested: the 301-action case in `sweep-service.test.ts` previews and
 * then applies, so four batches of this size run on every test run. If it
 * ever raises P2028, lower `BATCH`; there is nothing else in the sweep that
 * has to change with it. A batch that fails leaves the batches before it applied,
 * the sweep `partially_applied` and every action row carrying its own
 * outcome, which is exactly what `SweepAction.status` is for; the alternative
 * is an all-or-nothing transaction that in practice is always nothing.
 */
export async function applyExpirySweep(
  tenantId: string,
  sweepId: string,
  options: {
    confirm?: boolean;
    confirmedByUserId?: string | null;
    only?: string[];
    now?: Date;
    scheduler?: Scheduler | null;
    publicUrl?: string;
  } = {},
): Promise<{ status: string; applied: number; skipped: number; failed: number }> {
  const now = options.now ?? new Date();
  const confirmed = options.confirm === true;
  const publicUrl = (options.publicUrl ?? '').replace(/\/$/, '');
  const BATCH = 100;

  // ---- Phase 1: claim the sweep and decide what to do. Short. -------------
  const claim = await withTenant(tenantId, async (tx) => {
    const sweep = await tx.expirySweep.findUniqueOrThrow({ where: { id: sweepId } });

    if (sweep.status === 'blocked') {
      // No confirmation available. A blocked sweep is one whose own inputs are
      // not trustworthy, and confirming it would be confirming a number
      // rather than a decision. Tonight's preview supersedes it.
      return { proceed: false as const, status: sweep.status };
    }
    if (sweep.requiresConfirmation && !confirmed) {
      return { proceed: false as const, status: sweep.status };
    }
    if (sweep.status !== 'previewed') {
      return { proceed: false as const, status: sweep.status };
    }

    await tx.expirySweep.update({
      where: { id: sweepId },
      data: {
        status: 'applying',
        ...(confirmed ? { confirmedByUserId: options.confirmedByUserId ?? null } : {}),
      },
    });

    const actions = await tx.sweepAction.findMany({
      where: { sweepId, status: 'proposed' },
      orderBy: { id: 'asc' },
    });
    const chosenIds =
      options.only === undefined
        ? actions.map((a) => a.id)
        : actions.filter((a) => options.only!.includes(a.id)).map((a) => a.id);
    const chosen = new Set(chosenIds);
    const skippedIds = actions.filter((a) => !chosen.has(a.id)).map((a) => a.id);

    if (skippedIds.length > 0) {
      await tx.sweepAction.updateMany({
        where: { id: { in: skippedIds } },
        data: { status: 'skipped', message: 'skipped by the reviewer' },
      });
    }

    return {
      proceed: true as const,
      chosenIds,
      skipped: skippedIds.length,
      personsWithActiveContract: sweep.personsWithActiveContract,
    };
  });

  if (!claim.proceed) {
    return { status: claim.status, applied: 0, skipped: 0, failed: 0 };
  }

  // ---- Phase 2: apply, one transaction per batch. ------------------------
  const targets = new Set<string>();
  let applied = 0;
  let failed = 0;

  for (let offset = 0; offset < claim.chosenIds.length; offset += BATCH) {
    const batchIds = claim.chosenIds.slice(offset, offset + BATCH);

    const outcome = await withTenant(tenantId, async (tx) => {
      const batchActions = await tx.sweepAction.findMany({
        where: { id: { in: batchIds } },
      });
      const grantIds = batchActions.map((a) => a.grantId);
      const grants = await tx.accessGrant.findMany({ where: { id: { in: grantIds } } });
      const grantById = new Map(grants.map((g) => [g.id, g]));

      // Names for everything this batch touches, read once rather than per
      // action. Spec section 13 requires the expiry and lapse notices to name
      // what went away and who held it; `productName: action.productId` and
      // `resourceList: action.resourceId` put two UUIDs in a mail instead.
      const names = await displayNames(tx, {
        personIds: grants.flatMap((g) => [
          g.subjectPersonId,
          ...(g.approvedByPersonId === null ? [] : [g.approvedByPersonId]),
        ]),
        productIds: batchActions.flatMap((a) => (a.productId === null ? [] : [a.productId])),
        resources: batchActions.map((a) => ({
          resourceType: a.resourceType as ResourceType,
          resourceId: a.resourceId,
        })),
      });

      let batchApplied = 0;
      let batchFailed = 0;
      const batchTargets: string[] = [];

      for (const action of batchActions) {
        const grant = grantById.get(action.grantId);
        if (grant === undefined) {
          await tx.sweepAction.update({
            where: { id: action.id },
            data: { status: 'failed', message: 'the grant no longer exists' },
          });
          batchFailed += 1;
          continue;
        }

        await tx.accessGrant.update({
          where: { id: grant.id },
          data: {
            status: action.kind === 'expire' ? 'expired' : 'lapsed',
            statusReason: action.message,
            endedAt: now,
          },
        });

        let rowsRemoved = 0;
        if (action.resourceType === 'entitlement') {
          // The grant leaves desired state. Provision plans and applies the
          // revocation under its own guard, its own per-entitlement axis and
          // its own review — Automate writes nothing to a target.
          if (action.targetSystemId !== null) batchTargets.push(action.targetSystemId);
          await tx.sweepAction.update({
            where: { id: action.id },
            data: { status: 'dispatched' },
          });
        } else {
          // Only the rows THIS grant wrote. A membership an administrator
          // added by hand after the grant was made is not this grant's to
          // remove, and removing it with an audit event that says the grant
          // lapsed is the failure Ruling P11 describes: an operation that
          // does too much and reports too little.
          if (grant.writtenRowIds.length > 0) {
            const deleted =
              action.resourceType === 'application'
                ? await tx.appAssignment.deleteMany({
                    where: { id: { in: grant.writtenRowIds } },
                  })
                : await tx.groupMembership.deleteMany({
                    where: { id: { in: grant.writtenRowIds } },
                  });
            rowsRemoved = deleted.count;
          }
          await tx.sweepAction.update({ where: { id: action.id }, data: { status: 'applied' } });
        }

        await recordEvent(tx, {
          actorUserId: options.confirmedByUserId ?? null,
          action: action.kind === 'expire' ? 'automate.grant.expire' : 'automate.grant.lapse',
          targetType: 'AccessGrant',
          targetId: grant.id,
          outcome: 'success',
          sourceIp: null,
          payload: {
            sweepId,
            subjectPersonId: grant.subjectPersonId,
            resourceType: action.resourceType,
            resourceId: action.resourceId,
            reason: action.message,
            rowsThisGrantWrote: grant.writtenRowIds.length,
            rowsRemoved,
          },
        });

        // Spec section 13's recipients, in full: the holder and the original
        // approver for both, the RESOURCE OWNER for both — it is their list
        // of who holds their resource that just changed — and for a lapse the
        // person's most recent manager, who is the one who has to notice that
        // somebody who left still had this.
        const owner = await tx.resourceOwner.findFirst({
          where: { resourceType: action.resourceType, resourceId: action.resourceId },
          select: { ownerPersonId: true },
        });
        const managerPersonId =
          action.kind !== 'lapse'
            ? null
            : ((
                await tx.contract.findFirst({
                  where: { personId: grant.subjectPersonId, managerPersonId: { not: null } },
                  orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
                  select: { managerPersonId: true },
                })
              )?.managerPersonId ?? null);

        const recipients = await recipientsForPersons(tx, [
          grant.subjectPersonId,
          ...(grant.approvedByPersonId === null ? [] : [grant.approvedByPersonId]),
          ...(owner?.ownerPersonId == null ? [] : [owner.ownerPersonId]),
          ...(managerPersonId === null ? [] : [managerPersonId]),
        ]);

        // Where a business rule still grants the same entitlement, the holder
        // is told they still hold it. Telling somebody they lost something
        // they did not lose is its own kind of defect.
        const stillHeld = await tx.accountEntitlement.count({
          where: {
            state: 'held',
            entitlementId: action.resourceId,
            origin: 'rule',
            account: { personId: grant.subjectPersonId },
          },
        });

        const resourceName = nameList(names, [
          {
            resourceType: action.resourceType as ResourceType,
            resourceId: action.resourceId,
          },
        ]);
        await enqueueOutbox(
          tx,
          recipients.map((r) => ({
            template:
              action.kind === 'expire'
                ? ('automate-expired' as const)
                : ('automate-lapsed' as const),
            to: r.email,
            vars: {
              displayName: r.displayName,
              subjectName: names.get(`person:${grant.subjectPersonId}`) ?? 'the holder',
              productName:
                (action.productId === null
                  ? undefined
                  : names.get(`product:${action.productId}`)) ?? resourceName,
              resourceList: resourceName,
              endsAt: grant.endsAt?.toDateString() ?? '',
              lastContractEnd: action.message,
              stillHeldNote:
                stillHeld > 0
                  ? 'You still hold this through your role, so nothing has changed for you in practice.'
                  : '',
              catalogUrl: `${publicUrl}/catalog`,
            },
            requestId: null,
            userId: r.userId,
          })),
        );

        batchApplied += 1;
      }

      return { batchApplied, batchFailed, batchTargets };
    });

    applied += outcome.batchApplied;
    failed += outcome.batchFailed;
    for (const targetSystemId of outcome.batchTargets) targets.add(targetSystemId);
  }

  // ---- Phase 3: close the sweep. Short. ----------------------------------
  const status =
    failed > 0 && applied > 0 ? 'partially_applied' : failed > 0 ? 'failed' : 'applied';

  await withTenant(tenantId, async (tx) => {
    await tx.expirySweep.update({
      where: { id: sweepId },
      data: { status, finishedAt: now },
    });

    if (status !== 'failed') {
      // The denominator the NEXT sweep compares against: the last state
      // somebody accepted, not the last state observed.
      await tx.automateSettings.update({
        where: { tenantId },
        data: {
          lastAppliedSweepAt: now,
          personsWithActiveContractAtLastSweep: claim.personsWithActiveContract,
        },
      });
    }

    await recordEvent(tx, {
      actorUserId: options.confirmedByUserId ?? null,
      action: 'automate.sweep.apply',
      targetType: 'ExpirySweep',
      targetId: sweepId,
      outcome: failed > 0 ? 'failure' : 'success',
      sourceIp: null,
      payload: { applied, skipped: claim.skipped, failed, confirmed },
    });
  });

  for (const targetSystemId of targets) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return { status, applied, skipped: claim.skipped, failed };
}
