import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { currentTenant } from '../tenant-context.js';
import {
  attributionsFor,
  isUnattributable,
  type AttributionDraft,
} from './attribute.js';
import { collectTenant, type CollectedTenant } from './collect.js';
import { diffSnapshots, type DiffHolding, type DiffRegion } from './diff.js';
import {
  classifySources,
  gapsForSources,
  worstCompleteness,
  worstStaleness,
  type ClassifiedSource,
} from './freshness.js';
import { SYNTRA_SYSTEM_ID, subjectKey, type ResourceKind } from './types.js';
import {
  detectAccessWithoutContract,
  detectCoverageGaps,
  detectNoHumanDecision,
  detectPrivilegedUncertified,
  detectStaleSources,
  detectUnattributableHoldings,
  detectUnexplainedGains,
  reconcileFindings,
  type DetectHolding,
} from './finding-service.js';
// The STANDING kinds are closed through `reconcileLinkedFindings`, which also
// carries the Provision `DriftFinding` linkage: a bare reconcile there would
// close a Govern finding while leaving the drift row it aggregates open.
// `reconcileFindings` is still used, for `unexplained_gain` alone -- that kind
// has no drift counterpart, and it is reconciled over the gains of THIS
// snapshot rather than the tenant.
import { adoptDriftClosures, reconcileLinkedFindings } from './drift-link.js';
import type { FindingKind } from './types.js';

// NOTE: this module does NOT import './readable.js'. It has no use for the
// accessor — it writes snapshots, it does not read them back — and Task 8 makes
// it import './finding-service.js', which does. Keeping the dependency
// one-directional is Ruling G-6's whole point; `boundaries.test.ts` asserts it.

export const SNAPSHOT_WRITE_BATCH = 500;
export const EVENT_WRITE_BATCH = 500;

/**
 * How old a `building` snapshot must be before a new build supersedes it.
 *
 * A code constant, not a setting: a tenant that could raise it could brick its
 * own snapshot pipeline for as long as it liked, and the number only has to be
 * longer than the longest honest build.
 */
export const SNAPSHOT_STALL_MINUTES = 60;

/**
 * Creates the `building` row in one short transaction, so there is something to
 * mark `failed` however the rest gives out.
 *
 * SUPERSESSION IS IN THE SAME FUNCTION AS THE INDEX IT ESCAPES.
 * `govern_snapshot_one_building` is a one-non-terminal-row constraint, and this
 * programme has shipped two of those with no adoption path: one permanently
 * bricked a target, the other permanently stopped every grant expiring. A
 * `building` snapshot older than SNAPSHOT_STALL_MINUTES is a crashed process,
 * and it is failed at the head of the same transaction that creates the new one.
 */
export async function beginSnapshot(
  tenantId: string,
  kind: 'scheduled' | 'manual' | 'campaign',
  asOf: Date,
  actorUserId: string | null,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const stallCutoff = new Date(asOf.getTime() - SNAPSHOT_STALL_MINUTES * 60_000);
    const inFlight = await tx.accessSnapshot.findFirst({ where: { status: 'building' } });

    if (inFlight !== null) {
      if (inFlight.startedAt > stallCutoff) {
        throw new Error(
          `a snapshot is already building for this tenant (started ${inFlight.startedAt.toISOString()})`,
        );
      }
      await tx.accessSnapshot.update({
        where: { id: inFlight.id },
        data: {
          status: 'failed',
          finishedAt: asOf,
          error: `superseded by a later build: this build had been running for more than ${SNAPSHOT_STALL_MINUTES} minutes`,
        },
      });
    }

    const created = await tx.accessSnapshot.create({
      data: { tenantId, kind, status: 'building', asOf, startedAt: asOf },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.snapshot.begin',
      targetType: 'AccessSnapshot',
      targetId: created.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        kind,
        asOf: asOf.toISOString(),
        ...(inFlight === null ? {} : { supersededSnapshotId: inFlight.id }),
      },
    });

    return created.id;
  });
}
export interface BuildOptions {
  now?: Date;
  actorUserId?: string | null;
  kind?: 'scheduled' | 'manual' | 'campaign';
  batchSize?: number;
  /** The seam the tests fill. Production always uses `collectTenant`. */
  collect?: (tenantId: string, options: { asOf: Date }) => Promise<CollectedTenant>;
}

export interface BuildResult {
  snapshotId: string;
  status: 'complete' | 'failed';
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  eventCount: number;
}

interface PreparedHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemKind: string;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: 'held' | 'unknown';
  privileged: boolean;
  observedAt: Date;
  observedVia: string;
  firstSeenAt: Date;
  unattributable: boolean;
  attributions: AttributionDraft[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function buildSnapshot(
  tenantId: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const now = options.now ?? new Date();
  const kind = options.kind ?? 'scheduled';
  const actorUserId = options.actorUserId ?? null;
  const batchSize = options.batchSize ?? SNAPSHOT_WRITE_BATCH;
  const collect = options.collect ?? ((id, o) => collectTenant(id, { asOf: o.asOf }));

  const snapshotId = await beginSnapshot(tenantId, kind, now, actorUserId);

  try {
    // ---- collect (database only, its own short transactions) -------------
    const collected = await collect(tenantId, { asOf: now });

    // ---- classify sources -------------------------------------------------
    const sources = classifySources(collected.sources, collected.asOf);
    const sourceGaps = gapsForSources(sources);

    // ---- previous snapshot, for firstSeenAt and the diff -------------------
    const previous = await withTenant(tenantId, async (tx) => {
      const row = await tx.accessSnapshot.findFirst({
        where: { status: 'complete', id: { not: snapshotId } },
        orderBy: { asOf: 'desc' },
        select: { id: true },
      });
      if (row === null) return null;
      const holdings = await tx.holding.findMany({
        where: { snapshotId: row.id },
        select: {
          subjectKey: true, personId: true, accountRef: true, systemId: true,
          resourceKind: true, resourceId: true, resourceName: true, state: true,
          firstSeenAt: true,
          attributions: { select: { kind: true, refId: true } },
        },
      });
      const gaps = await tx.coverageGap.findMany({
        where: { snapshotId: row.id },
        select: { systemId: true, resourceId: true, personId: true },
      });
      return { id: row.id, holdings, gaps };
    });

    // ---- classification of privilege ---------------------------------------
    const classifications = await withTenant(tenantId, (tx) =>
      tx.resourceClassification.findMany({
        select: { systemId: true, resourceKind: true, resourceId: true, privileged: true },
      }),
    );
    const privilegedByKey = new Set(
      classifications
        .filter((c) => c.privileged)
        .map((c) => `${c.systemId}|${c.resourceKind}|${c.resourceId}`),
    );

    const firstSeenByKey = new Map(
      (previous?.holdings ?? []).map((h) => [
        `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
        h.firstSeenAt,
      ]),
    );

    // ---- attribute + classify (pure) ---------------------------------------
    //
    // ONE ROW PER (subject, resource), and that is load-bearing rather than
    // tidy. `collect` emits a holding per (userId, resource) while the
    // subject key here is the PERSON, and a person may hold several `User`
    // rows -- so two accounts in one group, or under one org unit carrying an
    // application assignment, or holding one role, produce two entries that
    // collide on `Holding`'s unique key.
    //
    // `createMany` has no upsert. Before this, that collision failed the
    // snapshot with P2002 and failed EVERY nightly build afterwards, because
    // the shape does not resolve itself: snapshots stopped, sources went
    // stale, and past `maxSnapshotAgeDays` every campaign start and every
    // revocation batch was refused. Governance halted and did not restart.
    //
    // Deliberately NOT `skipDuplicates` on the write instead. That would
    // silently drop the second row's attribution -- the holding would read as
    // less attributable than it is, which is a claim a reviewer acts on --
    // and it would hide a genuinely new duplicate shape rather than
    // surfacing it.
    const preparedByKey = new Map<string, PreparedHolding>();
    const prepared: PreparedHolding[] = [];

    for (const h of collected.holdings) {
      const key = subjectKey(h.subject);
      const compositeKey = `${key}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;
      const attributions = attributionsFor(h.attribution, collected.asOf);
      // Every syntraRole holding is privileged with NO configuration: a
      // Syntra role carries permissions from the closed catalogue and there
      // is no version of that which is not.
      const privileged =
        h.resourceKind === 'syntraRole' ||
        privilegedByKey.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`);

      const existing = preparedByKey.get(compositeKey);
      if (existing !== undefined) {
        // Union, because each account is a separate true reason the person
        // holds this and section 7 wants all of them.
        existing.attributions.push(...attributions);
        existing.unattributable = isUnattributable(
          existing.attributions.map((a) => a.kind),
        );
        // `held` beats `unknown`: one readable account is enough to know the
        // person holds it, and the other account's blindness does not unmake
        // that.
        if (h.state === 'held') existing.state = 'held';
        // Privilege is a property of the RESOURCE, so in practice the two
        // agree; taking the disjunction means a future per-account
        // difference cannot quietly downgrade it.
        existing.privileged = existing.privileged || privileged;
        if (h.observedAt.getTime() > existing.observedAt.getTime()) {
          existing.observedAt = h.observedAt;
        }
        continue;
      }

      const row: PreparedHolding = {
        subjectKey: key,
        personId: h.subject.kind === 'person' ? h.subject.personId : null,
        accountRef: h.subject.kind === 'account' ? h.subject.accountRef : null,
        systemKind: h.systemKind,
        systemId: h.systemId,
        resourceKind: h.resourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state,
        privileged,
        observedAt: h.observedAt,
        observedVia: h.observedVia,
        firstSeenAt: firstSeenByKey.get(compositeKey) ?? collected.asOf,
        unattributable: isUnattributable(attributions.map((a) => a.kind)),
        attributions,
      };
      preparedByKey.set(compositeKey, row);
      prepared.push(row);
    }

    const allGaps = [
      ...collected.gaps.map((g) => ({
        kind: g.kind as string,
        systemKind: g.systemKind as string | null,
        systemId: g.systemId as string | null,
        resourceId: g.resourceId,
        personId: g.personId,
        accountRef: g.accountRef,
        reason: g.reason,
        sourceRunId: g.sourceRunId,
      })),
      ...sourceGaps.map((g) => ({
        kind: g.kind as string,
        systemKind: g.sourceKind as string | null,
        systemId: g.sourceId as string | null,
        resourceId: null,
        personId: null,
        accountRef: null,
        reason: g.reason,
        sourceRunId: g.sourceRunId,
      })),
    ];

    // ---- write, in batches, each its own short transaction ------------------
    await withTenant(tenantId, async (tx) => {
      await tx.snapshotSource.createMany({
        data: sources.map((s) => ({
          tenantId, snapshotId,
          sourceKind: s.sourceKind, sourceId: s.sourceId, sourceName: s.sourceName,
          lastRunId: s.lastRunId,
          lastSuccessfulReadAt: s.lastSuccessfulReadAt,
          lastAttemptedReadAt: s.lastAttemptedReadAt,
          completeness: s.completeness, staleness: s.staleness,
          freshnessSlaHours: s.freshnessSlaHours,
          gapCount: allGaps.filter((g) => g.systemId === s.sourceId).length,
        })),
      });
    });

    for (const batch of chunk(allGaps, batchSize)) {
      await withTenant(tenantId, (tx) =>
        tx.coverageGap.createMany({
          data: batch.map((g) => ({
            tenantId, snapshotId, kind: g.kind,
            systemKind: g.systemKind, systemId: g.systemId,
            resourceId: g.resourceId, personId: g.personId, accountRef: g.accountRef,
            reason: g.reason, sourceRunId: g.sourceRunId,
          })),
        }),
      );
    }

    for (const batch of chunk(prepared, batchSize)) {
      await withTenant(tenantId, async (tx) => {
        // createMany then a read-back, rather than a create per row: the
        // attributions need the generated holding ids, and one round trip per
        // holding is what makes a 5000 ms transaction a P2028.
        await tx.holding.createMany({
          data: batch.map((h) => ({
            tenantId, snapshotId,
            subjectKey: h.subjectKey, personId: h.personId, accountRef: h.accountRef,
            systemKind: h.systemKind, systemId: h.systemId,
            resourceKind: h.resourceKind, resourceId: h.resourceId, resourceName: h.resourceName,
            state: h.state, privileged: h.privileged,
            observedAt: h.observedAt, observedVia: h.observedVia, firstSeenAt: h.firstSeenAt,
            attributionCount: h.attributions.length,
            unattributable: h.unattributable,
          })),
        });

        const written = await tx.holding.findMany({
          where: { snapshotId, subjectKey: { in: batch.map((h) => h.subjectKey) } },
          select: { id: true, subjectKey: true, systemId: true, resourceKind: true, resourceId: true },
        });
        const idByKey = new Map(
          written.map((w) => [`${w.subjectKey}|${w.systemId}|${w.resourceKind}|${w.resourceId}`, w.id]),
        );

        await tx.holdingAttribution.createMany({
          data: batch.flatMap((h) => {
            const holdingId = idByKey.get(
              `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`,
            );
            if (holdingId === undefined) return [];
            return h.attributions.map((a) => ({
              tenantId, holdingId,
              kind: a.kind, refType: a.refType, refId: a.refId,
              detail: a.detail as never,
              resolvedAt: a.resolvedAt,
            }));
          }),
        });
      });
    }

    // ---- detect: the diff against the previous snapshot ---------------------
    let eventCount = 0;
    if (previous !== null) {
      const toDiff = (h: {
        subjectKey: string; personId: string | null; accountRef: string | null;
        systemId: string; resourceKind: string; resourceId: string; resourceName: string;
        state: string; attributions: { kind: string; refId: string | null }[];
      }): DiffHolding => ({
        subjectKey: h.subjectKey,
        personId: h.personId,
        accountRef: h.accountRef,
        systemId: h.systemId,
        resourceKind: h.resourceKind as ResourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state === 'unknown' ? 'unknown' : 'held',
        attributionKinds: h.attributions.map((a) => a.kind) as DiffHolding['attributionKinds'],
        attributionRefs: h.attributions.map((a) => `${a.kind}:${a.refId ?? ''}`),
      });

      const beforeGapRegions: DiffRegion[] = previous.gaps.map((g) => ({
        systemId: g.systemId ?? SYNTRA_SYSTEM_ID,
        resourceId: g.resourceId,
        personId: g.personId,
      }));
      const afterGapRegions: DiffRegion[] = allGaps.map((g) => ({
        systemId: g.systemId ?? SYNTRA_SYSTEM_ID,
        resourceId: g.resourceId,
        personId: g.personId,
      }));

      const events = diffSnapshots({
        before: previous.holdings.map(toDiff),
        after: prepared.map((h) =>
          toDiff({
            ...h,
            attributions: h.attributions.map((a) => ({ kind: a.kind, refId: a.refId })),
          }),
        ),
        beforeGapRegions,
        afterGapRegions,
      });
      eventCount = events.length;

      for (const batch of chunk(events, EVENT_WRITE_BATCH)) {
        await withTenant(tenantId, (tx) =>
          tx.holdingEvent.createMany({
            data: batch.map((e) => ({
              tenantId,
              fromSnapshotId: previous.id,
              toSnapshotId: snapshotId,
              subjectKey: e.subjectKey, personId: e.personId, accountRef: e.accountRef,
              systemId: e.systemId, resourceKind: e.resourceKind,
              resourceId: e.resourceId, resourceName: e.resourceName,
              change: e.change,
              beforeAttributions: e.beforeAttributions as never,
              afterAttributions: e.afterAttributions as never,
              explained: false,
            })),
          }),
        );
      }

      // Cross-reference each gain to the audit event that explains it, where
      // one exists. `explained = false` on a gain is the most valuable row this
      // system produces: access appeared, and SYNTRA DID NOT CAUSE IT. It is
      // only meaningful once this pass has run, which is why
      // `detectUnexplainedGains` is called here rather than in the detect stage.
      await withTenant(tenantId, async (tx) => {
        const gains = await tx.holdingEvent.findMany({
          where: { toSnapshotId: snapshotId, change: 'gained' },
          select: { id: true, personId: true, resourceId: true },
        });
        if (gains.length === 0) return;

        const since = previous === null ? new Date(0) : collected.asOf;
        const candidates = await tx.auditEvent.findMany({
          where: {
            occurredAt: { gte: new Date(since.getTime() - 86_400_000 * 2) },
            action: {
              in: [
                'provision.apply.grant_entitlement',
                'automate.grant.fulfilled',
                'access.assignment.create',
                'directory.group.add_member',
                'rbac.role.assign',
              ],
            },
          },
          select: { sequence: true, targetId: true, payload: true },
        });
        const bySubject = new Map<string, number>();
        for (const event of candidates) {
          const payload = event.payload as Record<string, unknown>;
          const person = typeof payload['personId'] === 'string' ? payload['personId'] : null;
          const resource =
            typeof payload['resourceId'] === 'string'
              ? payload['resourceId']
              : typeof payload['entitlementId'] === 'string'
                ? payload['entitlementId']
                : null;
          if (person !== null && resource !== null) bySubject.set(`${person}|${resource}`, event.sequence);
        }

        for (const gain of gains) {
          if (gain.personId === null) continue;
          const sequence = bySubject.get(`${gain.personId}|${gain.resourceId}`);
          if (sequence === undefined) continue;
          await tx.holdingEvent.update({
            where: { id: gain.id },
            data: { auditEventSequence: sequence, explained: true },
          });
        }
      });

      const gainRows = await withTenant(tenantId, (tx) =>
        tx.holdingEvent.findMany({
          where: { toSnapshotId: snapshotId },
          select: {
            subjectKey: true, systemId: true, resourceKind: true,
            resourceId: true, resourceName: true, change: true, explained: true,
          },
        }),
      );
      // `['unexplained_gain']` and NOTHING else. This call runs inside the same
      // `buildSnapshot` that opened the six standing kinds moments earlier, and
      // a reconciliation that swept the whole tenant here would mark every one
      // of them `resolved` with `resolvedBySnapshotId` naming a snapshot that
      // never showed them gone. That is C1, and it emptied slice 1's headline
      // output on every nightly run.
      await reconcileFindings(tenantId, snapshotId, ['unexplained_gain'], detectUnexplainedGains(gainRows), {
        now: collected.asOf,
      });
    }

    // ---- detect: the standing findings ------------------------------------
    const contracts = await withTenant(tenantId, (tx) =>
      tx.contract.findMany({ select: { personId: true, startDate: true, endDate: true } }),
    );
    const certifications = await withTenant(tenantId, (tx) =>
      tx.holdingCertification.findMany({
        select: {
          subjectRefType: true, subjectRefId: true, systemId: true,
          resourceKind: true, resourceId: true, lastCertifiedAt: true,
        },
      }),
    );
    const settings = await withTenant(tenantId, (tx) =>
      tx.governSettings.findUnique({ where: { tenantId }, select: { privilegedRecertifyDays: true } }),
    );

    const detectHoldings: DetectHolding[] = prepared.map((h) => ({
      subjectKey: h.subjectKey,
      personId: h.personId,
      accountRef: h.accountRef,
      systemId: h.systemId,
      systemName: h.systemId,
      resourceKind: h.resourceKind,
      resourceId: h.resourceId,
      resourceName: h.resourceName,
      privileged: h.privileged,
      unattributable: h.unattributable,
      attributionKinds: h.attributions.map((a) => a.kind),
    }));

    const certifiedAt = new Map(
      certifications.map((c) => [
        `${c.subjectRefType === 'person' ? 'person' : 'account'}:${c.subjectRefId}|${c.systemId}|${c.resourceKind}|${c.resourceId}`,
        c.lastCertifiedAt,
      ]),
    );

    /**
     * The detect stage is authoritative for EXACTLY these six kinds and names
     * them, so the reconciliation cannot reach `unexplained_gain` (Task 10),
     * `orphan_account` (Task 8A), `audit_chain_broken` (Task 10) or any
     * campaign kind. The list is written out rather than derived from the
     * drafts: a detector that legitimately produces zero drafts this run must
     * still close last run's findings.
     *
     * `audit_chain_broken` MUST STAY OUT OF THIS LIST, and it is the reason the
     * kind exists at all. The audit verifier's two `critical` findings were
     * once raised under `coverage_gap` — a member here, whose only producer is
     * `detectCoverageGaps` and which can only ever emit
     * `subjectRefType: 'source'`. So this sweep, running nightly, resolved
     * every audit integrity alarm with a snapshot that had read no audit events
     * whatever. That is C1's defect reproduced at the two sites C5's fix
     * created: the alarm switched off overnight, every night, by the thing that
     * tidies up findings. Nothing in a snapshot build can show an audit chain
     * break gone, so nothing in a snapshot build may close one.
     */
    const STANDING_KINDS: readonly FindingKind[] = [
      'unattributable_holding',
      'access_without_contract',
      'no_human_decision',
      'stale_source',
      'coverage_gap',
      'privileged_uncertified',
    ];

    await reconcileLinkedFindings(
      tenantId,
      snapshotId,
      STANDING_KINDS,
      [
        ...detectUnattributableHoldings(detectHoldings),
        ...detectAccessWithoutContract(detectHoldings, contracts, collected.asOf),
        ...detectNoHumanDecision(detectHoldings),
        ...detectStaleSources(sources),
        ...detectCoverageGaps(allGaps),
        ...detectPrivilegedUncertified(
          detectHoldings,
          certifiedAt,
          collected.asOf,
          settings?.privilegedRecertifyDays ?? 90,
        ),
      ],
      { now: collected.asOf },
    );

    // The other direction, in the same build: a `DriftFinding` Provision has
    // closed since the last snapshot resolves the Govern finding that
    // aggregates it. One problem, one row, closed from either end.
    await adoptDriftClosures(tenantId, snapshotId, { now: collected.asOf });

    // ---- flip to complete, with the counts and the audit event --------------
    const unattributableCount = prepared.filter((h) => h.unattributable).length;
    const countsByResourceKind: Record<string, number> = {};
    for (const h of prepared) {
      countsByResourceKind[h.resourceKind] = (countsByResourceKind[h.resourceKind] ?? 0) + 1;
    }

    await withTenant(tenantId, async (tx) => {
      await tx.accessSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'complete',
          finishedAt: new Date(),
          holdingCount: prepared.length,
          unattributableCount,
          coverageGapCount: allGaps.length,
          unattributedAccountCount: collected.unattributedAccountKeys.length,
          personCount: collected.personIds.length,
          personsWithActiveContract: collected.personsWithActiveContract,
          countsByResourceKind: countsByResourceKind as never,
        },
      });

      await recordEvent(tx, {
        actorUserId,
        action: 'govern.snapshot.build',
        targetType: 'AccessSnapshot',
        targetId: snapshotId,
        outcome: 'success',
        sourceIp: null,
        payload: {
          kind,
          asOf: collected.asOf.toISOString(),
          holdingCount: prepared.length,
          unattributableCount,
          coverageGapCount: allGaps.length,
          eventCount,
          completeness: worstCompleteness(sources),
          staleness: worstStaleness(sources),
        },
      });
    });

    return {
      snapshotId,
      status: 'complete',
      holdingCount: prepared.length,
      unattributableCount,
      coverageGapCount: allGaps.length,
      eventCount,
    };
  } catch (cause) {
    // The rows already written stay, marked by their snapshot. Deleting several
    // million rows inside a failure handler is the same mistake in a different
    // costume; `pruneSnapshots` removes them.
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
    throw cause;
  }
}

/**
 * Retention, with one exception that is not negotiable: any snapshot referenced
 * by a campaign, an evidence bundle or an open finding is NEVER pruned while
 * that reference lives. Pruning a snapshot that a signed attestation points at
 * would destroy the evidence the attestation was about.
 */
export async function pruneSnapshots(
  tenantId: string,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ pruned: number; retainedForReference: number }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const settings = await tx.governSettings.findUnique({ where: { tenantId } });
    const retentionDays = options.retentionDays ?? settings?.snapshotRetentionDays ?? 400;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    const candidates = await tx.accessSnapshot.findMany({
      where: { asOf: { lt: cutoff } },
      select: { id: true },
    });
    if (candidates.length === 0) return { pruned: 0, retainedForReference: 0 };
    const ids = candidates.map((c) => c.id);

    // THE THREE REFERENCE KINDS THE DOCSTRING PROMISES, and the third of them
    // was missing.
    //
    // `Campaign.snapshotId`, `Campaign.rebasedFromSnapshotId` and
    // `CampaignItem.holdingSnapshotId` are bare uuid columns with NO foreign
    // key, so nothing stopped the delete at the database either: the campaign
    // was left pointing at a snapshot that no longer exists, and
    // `readableSnapshot` then throws `not_found` for its report, its re-base
    // and its evidence pack. A campaign closed 400 days ago is exactly the one
    // an auditor asks about, so the window this defect fires in is the window
    // the evidence matters in.
    //
    // A foreign key was considered and rejected in both forms. `RESTRICT` turns
    // the prune into an exception rather than a retention -- the job dies and
    // nothing else is pruned either -- and `SET NULL` silently unlinks a
    // campaign from its own evidence, which is the same data loss wearing a
    // constraint.
    const referenced = new Set<string>();

    for (const pack of await tx.evidencePack.findMany({
      where: { snapshotId: { in: ids } },
      select: { snapshotId: true },
    })) {
      if (pack.snapshotId !== null) referenced.add(pack.snapshotId);
    }

    // EVERY campaign, not only open ones. A closed campaign is the one whose
    // evidence somebody comes back for; an open one still has reviewers looking
    // at it. Neither may lose the picture it was generated from.
    for (const campaign of await tx.campaign.findMany({
      where: {
        OR: [{ snapshotId: { in: ids } }, { rebasedFromSnapshotId: { in: ids } }],
      },
      select: { snapshotId: true, rebasedFromSnapshotId: true },
    })) {
      if (ids.includes(campaign.snapshotId)) referenced.add(campaign.snapshotId);
      if (campaign.rebasedFromSnapshotId !== null && ids.includes(campaign.rebasedFromSnapshotId)) {
        referenced.add(campaign.rebasedFromSnapshotId);
      }
    }

    // And the item's OWN snapshot, which a re-base moves per item -- so a
    // campaign whose items sit on three snapshots holds all three.
    // `holdingSnapshotId` names where the copied attribution set came from, and
    // that is what "attested against these facts" means. `distinct` rather than
    // a read of every item: a 50,000-item campaign has at most a handful of
    // distinct values and this transaction has a 5000 ms budget.
    for (const item of await tx.campaignItem.findMany({
      where: { holdingSnapshotId: { in: ids } },
      select: { holdingSnapshotId: true },
      distinct: ['holdingSnapshotId'],
    })) {
      referenced.add(item.holdingSnapshotId);
    }

    for (const finding of await tx.governFinding.findMany({
      where: { status: { not: 'resolved' }, subjectRefType: 'snapshot', subjectRefId: { in: ids } },
      select: { subjectRefId: true },
    })) {
      referenced.add(finding.subjectRefId);
    }
    for (const finding of await tx.governFinding.findMany({
      where: { resolvedBySnapshotId: { in: ids } },
      select: { resolvedBySnapshotId: true },
    })) {
      if (finding.resolvedBySnapshotId !== null) referenced.add(finding.resolvedBySnapshotId);
    }

    const prunable = ids.filter((id) => !referenced.has(id));
    if (prunable.length > 0) {
      await tx.accessSnapshot.deleteMany({ where: { id: { in: prunable } } });
    }
    return { pruned: prunable.length, retainedForReference: referenced.size };
  });
}
