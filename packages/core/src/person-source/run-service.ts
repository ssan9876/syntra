import { withTenant, type TenantClient } from '@syntra/db';
import { personSourceConnectorFor, type PersonSnapshotRecord } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { recordEvent } from '../audit/audit-service.js';
import { storableCause, storableMessage } from '../storable-text.js';
import { isPersonMappingFailure, mapPersonRecord, type MappedPerson } from './mapping.js';
import { diffPersons, type ExistingSourcePerson, type PersonChangeType } from './diff.js';
import { evaluatePersonGuard } from './guard.js';
import { personMappingsFor, personSourceWithCredential } from './source-service.js';
import { normalizeIdentityReference } from './reference-data.js';
import {
  READ_CHECKPOINT_EVERY,
  RunCancelledSignal,
  RunNotAppliableError,
  cancellationRequested,
  finishWithCancellationCheck,
  honouredCancellation,
  noActiveRequest,
  requestCancellation,
  type CancelResult,
  type CancellableRunDelegate,
} from '../jobs/cancellation.js';

/** `PersonImportRun` narrowed to the shape `jobs/cancellation.ts` works on. */
const runs = (tx: TenantClient) => tx.personImportRun as unknown as CancellableRunDelegate;

/**
 * Statuses a cancel honours on the spot, because nothing is working on the
 * run: queued, or waiting for a person to apply it (or to finish reviewing
 * its possible duplicates, which is what most `blocked` imports are).
 */
const CANCEL_IMMEDIATELY = ['queued', 'previewed', 'blocked', 'partially_applied'] as const;
/** Statuses with a worker whose checkpoints will see a request. */
const CANCEL_COOPERATIVELY = ['running', 'applying'] as const;
/** Statuses an apply refuses outright. */
const NOT_APPLIABLE = ['queued', 'running', 'cancelled', 'failed'] as const;
/** Written on every change a cancellation left unapplied. */
const CANCELLED_CHANGE_MESSAGE = 'not applied: the run was cancelled';

/**
 * The order changes are applied in.
 *
 * Departure last, so a person is never briefly departed while a contract that
 * would have kept them active is still pending. Persons before contracts,
 * because a contract names a person this run may only just have created.
 */
export const PERSON_IMPORT_APPLY_ORDER: readonly PersonChangeType[] = [
  'create_person',
  'create_contract',
  'update_contract',
  'update_person',
  'reactivate_person',
  'end_contract',
  'depart_person',
];

/** The reason written onto a person the file stopped returning. */
export const ABSENT_FROM_FILE = 'this person is not in the file';

async function loadExisting(
  tx: TenantClient,
  sourceId: string,
): Promise<ExistingSourcePerson[]> {
  const links = await tx.personSourceLink.findMany({
    where: { sourceId },
    include: { person: { include: { contracts: true } } },
  });
  return links.map((link) => {
    const row = link.person;
    return ({
    id: row.id,
    externalId: link.externalId,
    status: row.status,
    fields: {
      givenName: row.givenName,
      familyName: row.familyName,
      nameConvention: row.nameConvention,
      ...(row.businessEmail === null ? {} : { businessEmail: row.businessEmail }),
      ...(row.personalEmail === null ? {} : { personalEmail: row.personalEmail }),
    },
    contracts: row.contracts.map((c) => ({
      id: c.id,
      externalId: c.externalId,
      sequence: c.sequence,
      isPrimary: c.isPrimary,
      startDate: c.startDate,
      endDate: c.endDate,
      jobTitle: c.jobTitle,
      department: c.department,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      managerPersonId: c.managerPersonId,
      fte: c.fte === null ? null : String(c.fte),
    })),
    });
  });
}

/** People the rest of the platform counts: active, holding a live contract. */
function personsWithActiveContract(tx: TenantClient) {
  return tx.person.count({
    where: {
      status: 'active',
      contracts: { some: { OR: [{ endDate: null }, { endDate: { gte: new Date() } }] } },
    },
  });
}

export async function previewImportRun(
  tenantId: string,
  provider: MasterKeyProvider,
  sourceId: string,
  existingRunId?: string,
) {
  // Phase 1: the run row, so there is something to mark `failed` no matter
  // where the rest of this gives out.
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.personSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such person source: ${sourceId}`);
    const boundTenant = await currentTenant(tx);
    if (existingRunId !== undefined) {
      // `queued` becomes `running` HERE, not when the job was accepted: the
      // status is about what is happening to the source, and between the two a
      // job can sit in the queue for as long as the queue is busy.
      //
      // Conditional: a run cancelled while it sat in the queue stays
      // cancelled when its job finally arrives.
      await tx.personImportRun.updateMany({
        where: { id: existingRunId, status: { not: 'cancelled' } },
        data: { status: 'running', startedAt: new Date() },
      });
      return tx.personImportRun.findUniqueOrThrow({ where: { id: existingRunId } });
    }
    return tx.personImportRun.create({ data: { tenantId: boundTenant, sourceId } });
  });
  if (run.status === 'cancelled') return run;

  /**
   * A checkpoint: stop here if somebody asked. Throws to the catch below,
   * which records `cancelled` — always before phase 6, so a cancelled import
   * proposes nothing and departs nobody.
   */
  const checkpoint = async () => {
    const asked = await withTenant(tenantId, (tx) => cancellationRequested(runs(tx), run.id));
    if (asked) throw new RunCancelledSignal(run.id);
  };

  try {
    // Phase 2: read the configuration out, then close the transaction. Plain
    // data, deliberately not a `tx` handle -- nothing downstream may hold one
    // open across the SFTP read.
    const prepared = await withTenant(tenantId, async (tx) => {
      const source = await tx.personSource.findUnique({ where: { id: sourceId } });
      if (!source) throw new Error(`no such person source: ${sourceId}`);
      const config = await personSourceWithCredential(tx, provider, sourceId);
      if (!config) throw new Error('source configuration or credential missing');
      return {
        config,
        type: source.type,
        feedMode: source.feedMode as 'snapshot' | 'delta',
        rules: await personMappingsFor(tx, sourceId),
        thresholdPercent: source.deactivationThresholdPercent,
      };
    });

    // Phase 3: the read, outside any transaction, holding no connection.
    //
    // Buffered in full before anything is diffed. A diff computed against a
    // partial read is a diff in which every unread person is absent, and
    // absence departs people -- so a throw here reaches the catch below and
    // the run proposes nothing at all.
    const records: PersonSnapshotRecord[] = [];
    const connector = personSourceConnectorFor(prepared.type);
    //
    // Checkpointed every READ_CHECKPOINT_EVERY records. Leaving the loop by a
    // throw returns the connector's iterator, which closes the SFTP session.
    for await (const record of connector.read(prepared.config as never)) {
      records.push(record);
      if (records.length % READ_CHECKPOINT_EVERY === 0) await checkpoint();
    }
    await checkpoint();

    // Phase 4: map. Failures are counted and excluded -- never absent.
    let mapped: MappedPerson[] = [];
    const failureReasons = new Set<string>();
    const failureAnchors: string[] = [];
    let mappingFailures = 0;
    for (const record of records) {
      const result = mapPersonRecord(record, prepared.rules);
      if (isPersonMappingFailure(result)) {
        mappingFailures += 1;
        failureReasons.add(result.reason);
        failureAnchors.push(result.anchor);
        continue;
      }
      mapped.push(result);
    }

    // A source identity must name exactly one row in a feed. Allowing both
    // rows through would create two incompatible change sets for the same
    // durable PersonSourceLink and leave the eventual database constraint to
    // choose the winner. Reject every occurrence instead: an operator must
    // correct the source, and an already-owned person with that identity is
    // protected from snapshot absence below.
    const identityCounts = new Map<string, number>();
    for (const person of mapped) {
      identityCounts.set(person.externalId, (identityCounts.get(person.externalId) ?? 0) + 1);
    }
    const duplicateExternalIds = new Set(
      [...identityCounts].filter(([, count]) => count > 1).map(([externalId]) => externalId),
    );
    if (duplicateExternalIds.size > 0) {
      mapped = mapped.filter((person) => {
        if (!duplicateExternalIds.has(person.externalId)) return true;
        mappingFailures += 1;
        failureAnchors.push(person.externalId);
        failureReasons.add(
          `employee identifier "${person.externalId}" occurs more than once; every occurrence was withheld`,
        );
        return false;
      });
    }

    // Phase 5: one short transaction for the whole database-side snapshot the
    // diff is computed against.
    const snapshot = await withTenant(tenantId, async (tx) => {
      const incomingEmails = [...new Set(mapped.map((person) => person.fields.businessEmail?.trim()).filter((value): value is string => Boolean(value)))];
      const existing = await loadExisting(tx, sourceId);
      return {
        existing,
        referenceValues: await tx.identityReferenceValue.findMany({
          where: { active: true, kind: { in: ['department', 'location'] } },
          select: { kind: true, normalizedValue: true },
        }),
        duplicateCandidates: incomingEmails.length === 0 ? [] : await tx.person.findMany({
          where: { status: 'active', businessEmail: { in: incomingEmails, mode: 'insensitive' } },
          select: { id: true, givenName: true, familyName: true, businessEmail: true, sourceId: true },
        }),
        managerIdByExternalId: new Map(
          existing.map((person) => [person.externalId, person.id] as const),
        ),
        activeContractsFromSource: await tx.contract.count({
          where: {
            person: { sourceId },
            OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
          },
        }),
        personsNow: await personsWithActiveContract(tx),
        // `partially_applied` counts. This decides whether the drop guard has
        // a baseline to compare against, and a source that applied half a run
        // has still applied: treating it as never-applied would pass `null`
        // as the previous population and skip the guard entirely on the very
        // next run.
        lastApplied: await tx.personImportRun.findFirst({
          where: { sourceId, status: { in: ['applied', 'partially_applied'] } },
          orderBy: { finishedAt: 'desc' },
          select: { id: true },
        }),
      };
    });

    // A catalog is opt-in per kind: no active values means the tenant has not
    // chosen to govern that field yet. Once enabled, every non-empty value
    // must match after conservative whitespace/case normalization.
    const referenceValues = new Map<string, Set<string>>();
    for (const reference of snapshot.referenceValues) {
      const values = referenceValues.get(reference.kind) ?? new Set<string>();
      values.add(reference.normalizedValue);
      referenceValues.set(reference.kind, values);
    }
    mapped = mapped.filter((person) => {
      const invalid = new Set<string>();
      for (const contract of person.contracts) {
        for (const kind of ['department', 'location'] as const) {
          const allowed = referenceValues.get(kind);
          const value = contract[kind];
          if (allowed !== undefined && value !== null && !allowed.has(normalizeIdentityReference(value))) {
            invalid.add(`${kind} "${value}"`);
          }
        }
      }
      if (invalid.size === 0) return true;
      mappingFailures += 1;
      failureAnchors.push(person.externalId);
      failureReasons.add(
        `employee "${person.externalId}" uses unapproved reference value(s): ${[...invalid].join(', ')}`,
      );
      return false;
    });

    // Manager identifiers belong to the same HR identity namespace as the
    // employee identifier. Accept a manager already linked to this source or
    // one included in the same feed (their Person may be created later in the
    // ordered apply); withhold rows that point nowhere rather than silently
    // dropping an authoritative reporting line.
    const knownManagerExternalIds = new Set([
      ...snapshot.existing.map((person) => person.externalId),
      ...mapped.map((person) => person.externalId),
    ]);
    mapped = mapped.filter((person) => {
      const unknown = [...new Set(
        person.contracts
          .map((contract) => contract.managerExternalId)
          .filter((externalId): externalId is string =>
            externalId !== null && !knownManagerExternalIds.has(externalId),
          ),
      )];
      if (unknown.length === 0) return true;
      mappingFailures += 1;
      failureAnchors.push(person.externalId);
      failureReasons.add(
        `employee "${person.externalId}" references unknown manager identifier(s): ${unknown.join(', ')}`,
      );
      return false;
    });

    /**
     * Who the failures were about, and whether we could tell.
     *
     * A failure whose anchor names a person this source owns is attributable:
     * that person was returned, so they are excluded from the diff and are not
     * absent. A failure whose anchor names nobody -- the connector's row
     * placeholder, which is what a missing correlation column produces -- is
     * not attributable, and on a run carrying one the absence half of the diff
     * is withheld entirely.
     *
     * That is the renamed-column case, and it is the difference between one
     * person excluded and the whole workforce departed.
     */
    const ownedExternalIds = new Set(snapshot.existing.map((p) => p.externalId));
    const excludedExternalIds = new Set(
      failureAnchors.filter((anchor) => ownedExternalIds.has(anchor)),
    );
    const unattributable = failureAnchors.filter(
      (anchor) => !ownedExternalIds.has(anchor),
    ).length;
    const absenceReliable = unattributable === 0;
    if (!absenceReliable) {
      failureReasons.add(
        `${unattributable} row(s) could not be matched to anybody, so no ` +
          `leaver is proposed in this run: a file that cannot be read is not ` +
          `evidence that anyone has left`,
      );
    }

    const changes = diffPersons({
      mapped,
      existing: snapshot.existing,
      feedMode: prepared.feedMode,
      managerIdByExternalId: snapshot.managerIdByExternalId,
      excludedExternalIds,
      absenceReliable,
    });

    const departures = changes.filter((c) => c.changeType === 'depart_person').length;

    /**
     * What the tenant-wide count WOULD be if this run applied.
     *
     * Not the count as it stands: on a first run into an empty tenant that is
     * zero, and `populationDropRefusal` refuses a zero count unconditionally
     * -- so passing the current count would block every first run of every
     * source, which is the one run that cannot be a collapse.
     *
     * Three movements, and each is a person entering or leaving the set the
     * rest of the platform counts:
     *   departures        -- leave it;
     *   losing their last -- a person the file still returns, but with no
     *     contract that is live, so they stop counting even though nobody
     *     departed them;
     *   creations         -- enter it, if the file gives them a live contract.
     *
     * A person excluded by a mapping failure moves in none of these, which is
     * right: nothing about them changes, so they neither collapse the register
     * nor prop it up.
     */
    const today = new Date();
    const hasLiveContract = (person: MappedPerson) =>
      person.contracts.some((c) => c.endDate === null || c.endDate >= today);

    const existingByExternalId = new Map(snapshot.existing.map((p) => [p.externalId, p]));
    let losingLastContract = 0;
    let createdWithLiveContract = 0;
    for (const person of mapped) {
      const stored = existingByExternalId.get(person.externalId);
      if (stored === undefined) {
        if (hasLiveContract(person)) createdWithLiveContract += 1;
        continue;
      }
      if (stored.status === 'active' && !hasLiveContract(person)) losingLastContract += 1;
    }

    const projectedPersons =
      snapshot.personsNow - departures - losingLastContract + createdWithLiveContract;

    const verdict = evaluatePersonGuard({
      changes,
      recordsRead: records.length,
      activePersonsFromSource: snapshot.existing.filter((p) => p.status === 'active').length,
      activeContractsFromSource: snapshot.activeContractsFromSource,
      thresholdPercent: prepared.thresholdPercent,
      personsWithActiveContract: Math.max(0, projectedPersons),
      previousPersonsWithActiveContract:
        snapshot.lastApplied === null ? null : snapshot.personsNow,
    });

    // Phase 6: ONE transaction. The proposed changes and the run's terminal
    // status commit together or not at all, so a run that fails partway writes
    // no changes at all.
    return await withTenant(tenantId, async (tx) => {
      const boundTenant = await currentTenant(tx);
      // The last checkpoint, and the one that closes the race: a conditional
      // write to the run row before anything else. A request committed before
      // it makes it match nothing and the throw writes no change at all; a
      // request arriving after it waits on this row lock, then finds a
      // `previewed` or `blocked` run and cancels that outright instead.
      const claimed = await tx.personImportRun.updateMany({
        where: { id: run.id, ...noActiveRequest() },
        data: { finishedAt: new Date() },
      });
      if (claimed.count === 0) throw new RunCancelledSignal(run.id);
      const duplicateCandidatesByEmail = new Map<string, typeof snapshot.duplicateCandidates>();
      for (const candidate of snapshot.duplicateCandidates) {
        const key = candidate.businessEmail?.trim().toLocaleLowerCase();
        if (key) duplicateCandidatesByEmail.set(key, [...(duplicateCandidatesByEmail.get(key) ?? []), candidate]);
      }
      let duplicateReviewCount = 0;
      for (const change of changes) {
        const after = (change.after ?? {}) as Record<string, unknown>;
        const email = typeof after.businessEmail === 'string' ? after.businessEmail.trim().toLocaleLowerCase() : '';
        const candidates = change.changeType === 'create_person' && email !== ''
          ? (duplicateCandidatesByEmail.get(email) ?? [])
          : [];
        const createdChange = await tx.personImportChange.create({
          data: {
            tenantId: boundTenant,
            runId: run.id,
            changeType: change.changeType,
            recordType: change.recordType,
            targetId: change.targetId,
            externalId: change.externalId,
            before: (change.before ?? undefined) as never,
            after: (change.after ?? undefined) as never,
            status: candidates.length > 0 ? 'needs_review' : 'proposed',
            message: change.message === undefined ? null : storableMessage(change.message),
          },
        });
        for (const candidate of candidates) {
          await tx.personDuplicateReview.create({
            data: {
              tenantId: boundTenant,
              runId: run.id,
              changeId: createdChange.id,
              candidatePersonId: candidate.id,
              matchedValue: candidate.businessEmail ?? email,
              restoreStatus: verdict.blocked ? 'blocked' : 'previewed',
              restoreBlockedReason: verdict.blocked ? verdict.reason : null,
              restoreRequiresConfirmation: verdict.blocked ? verdict.requiresConfirmation : false,
            },
          });
          duplicateReviewCount += 1;
        }
      }
      return tx.personImportRun.update({
        where: { id: run.id },
        data: {
          status: duplicateReviewCount > 0 ? 'blocked' : verdict.blocked ? 'blocked' : 'previewed',
          finishedAt: new Date(),
          recordsRead: records.length,
          mappingFailures,
          // These quote the file's own cells and the connector's
          // readFailure, so they carry foreign text too.
          mappingFailureReasons: [...failureReasons].map(storableMessage),
          personsAbsent: departures,
          requiresConfirmation: duplicateReviewCount > 0 ? false : verdict.blocked ? verdict.requiresConfirmation : false,
          blockedReason: duplicateReviewCount > 0
            ? `${duplicateReviewCount} possible duplicate match${duplicateReviewCount === 1 ? '' : 'es'} require review before this run can apply`
            : verdict.blocked ? verdict.reason : null,
        },
      });
    });
  } catch (cause) {
    /*
     * `storableCause`, not the raw message.
     *
     * This is the catch 016c32e is about: the text explaining a failure is
     * written here, on an error path, with nothing above it to catch a second
     * throw. PostgreSQL refuses U+0000, ssh2 and the servers behind it are
     * under no obligation to keep one out of a diagnostic, and a run left
     * `running` for ever with an empty error column is indistinguishable from
     * one still working.
     */
    if (cause instanceof RunCancelledSignal) {
      return withTenant(tenantId, async (tx) => {
        await honourImportCancellation(tx, run.id, 'preview');
        return tx.personImportRun.findUniqueOrThrow({ where: { id: run.id } });
      });
    }
    // A pending request that no checkpoint reached is resolved as moot: the
    // run ended on its own.
    return withTenant(tenantId, async (tx) => {
      await finishWithCancellationCheck(runs(tx), run.id, {
        status: 'failed',
        finishedAt: new Date(),
        error: storableCause(cause),
      });
      return tx.personImportRun.findUniqueOrThrow({ where: { id: run.id } });
    });
  }
}

/**
 * Resolves a pending request as honoured, says so on every change it left
 * unapplied, and closes any duplicate review still open on the run — a run
 * that will never apply has nothing left for a reviewer to decide.
 *
 * The audit event names the person who asked as the actor, for the reason
 * `sync/run-service.ts` gives.
 */
async function honourImportCancellation(
  tx: TenantClient,
  runId: string,
  phase: 'preview' | 'apply',
  counts: Record<string, number> = {},
): Promise<void> {
  const { count } = await tx.personImportRun.updateMany({
    where: { id: runId, cancelState: 'requested' },
    data: honouredCancellation(),
  });
  if (count === 0) return;
  await abandonUnapplied(tx, runId, null);
  const run = await tx.personImportRun.findUniqueOrThrow({ where: { id: runId } });
  await recordEvent(tx, {
    actorUserId: run.cancelRequestedByUserId,
    action: 'person_import.run.cancelled',
    targetType: 'PersonImportRun',
    targetId: runId,
    outcome: 'success',
    sourceIp: null,
    payload: { phase, ...counts },
  });
}

/** What a cancelled run leaves behind: skipped changes and closed reviews. */
async function abandonUnapplied(
  tx: TenantClient,
  runId: string,
  reviewerUserId: string | null,
): Promise<void> {
  await tx.personImportChange.updateMany({
    where: { runId, status: { in: ['proposed', 'needs_review'] } },
    data: { status: 'skipped', message: CANCELLED_CHANGE_MESSAGE },
  });
  await tx.personDuplicateReview.updateMany({
    where: { runId, status: 'open' },
    data: {
      status: 'resolved',
      resolution: 'run_cancelled',
      note: 'The import run was cancelled before this review was decided.',
      reviewedByUserId: reviewerUserId,
      reviewedAt: new Date(),
    },
  });
}

/**
 * Asks an HR import run to stop. Honoured at once for a run nothing is working
 * on; recorded for the next checkpoint of one that is reading or applying.
 *
 * Takes the caller's transaction so the request and its audit event commit
 * together.
 */
export async function requestCancelImportRun(
  tx: TenantClient,
  runId: string,
  actor: { userId: string; sourceIp: string | null },
): Promise<CancelResult> {
  const result = await requestCancellation(runs(tx), runId, actor.userId, {
    immediate: CANCEL_IMMEDIATELY,
    cooperative: CANCEL_COOPERATIVELY,
  });
  if (result.outcome === 'cancelled') await abandonUnapplied(tx, runId, actor.userId);
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'person_import.run.cancel',
    targetType: 'PersonImportRun',
    targetId: runId,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: { outcome: result.outcome, previousStatus: result.previousStatus },
  });
  return result;
}

type ChangeRow = {
  id: string;
  changeType: string;
  recordType: string;
  targetId: string | null;
  externalId: string | null;
  after: unknown;
};

/**
 * The privacy case restricting the person this change would write, or null.
 *
 * Only changes that write the person's data or bring them back are withheld.
 * A departure and a contract end still apply: they narrow access, and a
 * restriction must never keep a leaver's access alive. A new person cannot be
 * restricted yet, so `create_person` never is.
 */
const RESTRICTION_WITHHELD_IMPORT_CHANGES = new Set(['update_person', 'reactivate_person', 'create_contract', 'update_contract']);

async function importRestriction(tx: TenantClient, sourceId: string, change: ChangeRow): Promise<string | null> {
  if (!RESTRICTION_WITHHELD_IMPORT_CHANGES.has(change.changeType)) return null;
  let personId: string | null = null;
  if (change.recordType === 'person') {
    personId = change.targetId;
  } else if (change.changeType === 'create_contract') {
    if (change.externalId !== null) {
      const link = await tx.personSourceLink.findUnique({
        where: { sourceId_externalId: { sourceId, externalId: change.externalId } },
        select: { personId: true },
      });
      personId = link?.personId ?? null;
    }
  } else if (change.targetId !== null) {
    const contract = await tx.contract.findUnique({ where: { id: change.targetId }, select: { personId: true } });
    personId = contract?.personId ?? null;
  }
  if (personId === null) return null;
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { processingRestrictedAt: true, processingRestrictedCaseId: true },
  });
  return person?.processingRestrictedAt ? (person.processingRestrictedCaseId ?? 'unknown') : null;
}

async function applyOne(tx: TenantClient, sourceId: string, change: ChangeRow) {
  const after = (change.after ?? {}) as Record<string, unknown>;
  const tenantId = await currentTenant(tx);
  const resolveDeferredManager = async () => {
    if (typeof after.managerExternalId !== 'string') return;
    const managerLink = await tx.personSourceLink.findUnique({
      where: {
        sourceId_externalId: { sourceId, externalId: after.managerExternalId },
      },
      select: { personId: true },
    });
    if (managerLink === null) {
      throw new Error(`manager ${after.managerExternalId} no longer exists in source ${sourceId}`);
    }
    after.managerPersonId = managerLink.personId;
  };

  switch (change.changeType) {
    case 'create_person': {
      const createdPerson = await tx.person.create({
        data: {
          tenantId,
          sourceId,
          externalId: change.externalId,
          givenName: String(after.givenName ?? ''),
          familyName: String(after.familyName ?? ''),
          ...(after.nameConvention === undefined
            ? {}
            : { nameConvention: String(after.nameConvention) }),
          ...(after.businessEmail === undefined
            ? {}
            : { businessEmail: String(after.businessEmail) }),
          ...(after.personalEmail === undefined
            ? {}
            : { personalEmail: String(after.personalEmail) }),
        },
      });
      if (change.externalId !== null) {
        await tx.personSourceLink.create({
          data: { tenantId, sourceId, personId: createdPerson.id, externalId: change.externalId },
        });
      }
      return;
    }

    case 'update_person':
      if (change.targetId === null) throw new Error('update_person names no person');
      await tx.person.update({ where: { id: change.targetId }, data: after as never });
      return;

    case 'reactivate_person':
      if (change.targetId === null) throw new Error('reactivate_person names no person');
      await tx.person.update({
        where: { id: change.targetId },
        data: { status: 'active', statusReason: null },
      });
      return;

    /**
     * Status and statusReason, never departureOverride.
     *
     * That field means a human knew something the contract table did not, and
     * `departureDate()` prefers it over contract dates for that reason. An
     * import knows only that a row was missing, and writing the override would
     * let a truncated export outrank the contract table permanently -- damage
     * that outlives the bad run, because reactivation clears the override.
     */
    case 'depart_person':
      if (change.targetId === null) throw new Error('depart_person names no person');
      await tx.person.update({
        where: { id: change.targetId },
        data: { status: 'inactive', statusReason: ABSENT_FROM_FILE },
      });
      return;

    case 'create_contract': {
      if (change.externalId === null) throw new Error('create_contract names no person external id');
      const link = await tx.personSourceLink.findUnique({
        where: { sourceId_externalId: { sourceId, externalId: change.externalId } },
      });
      const person = link === null ? null : await tx.person.findUnique({ where: { id: link.personId } });
      if (!person) throw new Error(`no person ${change.externalId} to hold this contract`);
      const highest = await tx.contract.findFirst({
        where: { personId: person.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await resolveDeferredManager();
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: (after.sequence as number | null) ?? (highest?.sequence ?? 0) + 1,
          isPrimary: Boolean(after.isPrimary),
          startDate: after.startDate as Date,
          endDate: (after.endDate as Date | null) ?? null,
          externalId: (after.externalId as string | null) ?? null,
          jobTitle: (after.jobTitle as string | null) ?? null,
          department: (after.department as string | null) ?? null,
          costCentre: (after.costCentre as string | null) ?? null,
          employer: (after.employer as string | null) ?? null,
          location: (after.location as string | null) ?? null,
          managerPersonId: (after.managerPersonId as string | null) ?? null,
          ...(after.fte === undefined || after.fte === null
            ? {}
            : { fte: after.fte as string }),
        },
      });
      return;
    }

    case 'update_contract':
    case 'end_contract': {
      if (change.targetId === null) throw new Error(`${change.changeType} names no contract`);
      // `personExternalId` rides along on the change so a create can find its
      // person; it is not a column and must not reach an update.
      await resolveDeferredManager();
      const { personExternalId: _ignored, managerExternalId: _managerExternalId, ...data } = after;
      await tx.contract.update({ where: { id: change.targetId }, data: data as never });
      return;
    }

    default:
      throw new Error(`no apply path for change type "${change.changeType}"`);
  }
}

export async function applyImportRun(
  tenantId: string,
  runId: string,
  opts: { only?: string[]; confirm?: boolean; confirmedBy?: string } = {},
) {
  const run = await withTenant(tenantId, (tx) =>
    tx.personImportRun.findUnique({ where: { id: runId } }),
  );
  if (!run) throw new Error(`no such import run: ${runId}`);

  // A run blocked only for exceeding a threshold can be applied by someone who
  // has read the numbers and said so. A run that read no records has
  // `requiresConfirmation` false and is refused whatever the caller sends, and
  // the scheduler never passes `confirm` at all -- so `autoApply` can never
  // satisfy this.
  if (run.status === 'blocked' && !(run.requiresConfirmation && opts.confirm)) {
    throw new Error(
      `run is blocked and cannot be applied: ${run.blockedReason ?? 'unknown reason'}`,
    );
  }
  if ((NOT_APPLIABLE as readonly string[]).includes(run.status)) {
    throw new RunNotAppliableError(runId, run.status);
  }

  // Into `applying`, conditionally, so the console can show an apply under
  // way and offer to stop it. A marker, not a lock — see the same step in
  // `sync/run-service.ts`: a run a dead process left `applying` is resumed by
  // applying it again, and a request already waiting is honoured here, before
  // the first change.
  const started = await withTenant(tenantId, async (tx) => {
    if (run.cancelState === 'requested') return false;
    const { count } = await tx.personImportRun.updateMany({
      where: { id: runId, status: run.status, ...noActiveRequest() },
      data: { status: 'applying' },
    });
    return count === 1;
  });
  if (!started) {
    await withTenant(tenantId, async (tx) => {
      await honourImportCancellation(tx, runId, 'apply', { applied: 0 });
      const now = await tx.personImportRun.findUniqueOrThrow({ where: { id: runId } });
      if (now.status !== 'cancelled') throw new RunNotAppliableError(runId, now.status);
    });
    return { applied: 0, failed: 0, cancelled: true };
  }

  const changes = await withTenant(tenantId, (tx) =>
    tx.personImportChange.findMany({
      where: {
        runId,
        status: 'proposed',
        ...(opts.only ? { id: { in: opts.only } } : {}),
      },
    }),
  );

  const ordered = [...changes].sort(
    (a, b) =>
      PERSON_IMPORT_APPLY_ORDER.indexOf(a.changeType as PersonChangeType) -
      PERSON_IMPORT_APPLY_ORDER.indexOf(b.changeType as PersonChangeType),
  );

  let applied = 0;
  let failed = 0;
  let withheld = 0;
  let cancelled = false;

  for (const change of ordered) {
    try {
      // The checkpoint shares the change's own transaction, so it sits
      // between changes by construction: a change commits whole — the person
      // row, its status and its audit event — or not at all.
      const outcome = await withTenant(tenantId, async (tx) => {
        if (await cancellationRequested(runs(tx), runId)) return 'cancel' as const;
        const restrictedBy = await importRestriction(tx, run.sourceId, change);
        if (restrictedBy !== null) {
          // Skipped, not failed: a skip is "not now", and the next run
          // proposes it again once the restriction is lifted.
          await tx.personImportChange.update({
            where: { id: change.id },
            data: {
              status: 'skipped',
              message: `not applied: processing of this person is restricted by privacy case ${restrictedBy}`,
            },
          });
          await recordEvent(tx, {
            actorUserId: opts.confirmedBy ?? null,
            action: 'person_import.change_withheld',
            targetType: change.recordType === 'person' ? 'Person' : 'Contract',
            targetId: change.targetId,
            outcome: 'success',
            sourceIp: null,
            payload: { runId, changeType: change.changeType, privacyCaseId: restrictedBy },
          });
          return 'withheld' as const;
        }
        await applyOne(tx, run.sourceId, change);
        await tx.personImportChange.update({
          where: { id: change.id },
          data: { status: 'applied' },
        });
        await recordEvent(tx, {
          actorUserId: opts.confirmedBy ?? null,
          action: `person_import.${change.changeType}`,
          targetType: change.recordType === 'person' ? 'Person' : 'Contract',
          targetId: change.targetId,
          outcome: 'success',
          sourceIp: null,
          payload: { runId, externalId: change.externalId },
        });
        return 'applied' as const;
      });
      if (outcome === 'cancel') {
        cancelled = true;
        break;
      }
      if (outcome === 'withheld') {
        withheld += 1;
        continue;
      }
      applied += 1;
    } catch (cause) {
      failed += 1;
      // Prisma's and the driver's words, on an error path, into a column.
      await withTenant(tenantId, (tx) =>
        tx.personImportChange.update({
          where: { id: change.id },
          data: { status: 'failed', message: storableCause(cause) },
        }),
      );
    }
  }

  // What is still proposed after this pass: the changes a partial apply left
  // behind, and the ones somebody skipped.
  const remaining = await withTenant(tenantId, (tx) =>
    tx.personImportChange.count({ where: { runId, status: 'proposed' } }),
  );

  await withTenant(tenantId, async (tx) => {
    if (cancelled) {
      // Stopped between changes: what applied stays applied and audited,
      // what was not reached is skipped with the reason. The confirmation, if
      // any, is still recorded — it authorised the part that did apply.
      if (opts.confirmedBy !== undefined) {
        await tx.personImportRun.update({
          where: { id: runId },
          data: { confirmedBy: opts.confirmedBy },
        });
      }
      await honourImportCancellation(tx, runId, 'apply', { applied, failed, notAttempted: remaining });
    } else {
      await finishWithCancellationCheck(runs(tx), runId, {
        // `partially_applied` where anything is left or anything failed, as
        // `sync/run-service.ts` does. A run whose every change failed
        // reporting itself as `applied` is a run that lies about the
        // directory, and a partial apply that reads as complete hides the
        // half nobody has looked at yet.
        status: remaining > 0 || failed > 0 ? 'partially_applied' : 'applied',
        finishedAt: new Date(),
        ...(opts.confirmedBy === undefined ? {} : { confirmedBy: opts.confirmedBy }),
      });
    }
    await tx.personSource.update({
      where: { id: run.sourceId },
      data: { lastRunAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId: opts.confirmedBy ?? null,
      action: 'person_import.run.apply',
      targetType: 'PersonImportRun',
      targetId: runId,
      outcome: failed === 0 ? 'success' : 'failure',
      sourceIp: null,
      // The confirmation is recorded where somebody can find it later. An
      // override nobody can find is not a control.
      payload: { applied, failed, withheld, confirmed: opts.confirm === true, cancelled },
    });
  });

  return { applied, failed, cancelled };
}

/** A skip is "not now", not "never": the next run proposes it again. */
export function skipImportChange(tx: TenantClient, changeId: string) {
  return tx.personImportChange.update({
    where: { id: changeId },
    data: { status: 'skipped' },
  });
}

export function listImportRuns(tx: TenantClient, sourceId?: string) {
  return tx.personImportRun.findMany({
    where: sourceId === undefined ? {} : { sourceId },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
}
