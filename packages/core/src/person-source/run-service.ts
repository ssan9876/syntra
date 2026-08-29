import { withTenant, type TenantClient } from '@syntra/db';
import { personSourceConnectorFor, type PersonSnapshotRecord } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { recordEvent } from '../audit/audit-service.js';
import { isPersonMappingFailure, mapPersonRecord, type MappedPerson } from './mapping.js';
import { diffPersons, type ExistingSourcePerson, type PersonChangeType } from './diff.js';
import { evaluatePersonGuard } from './guard.js';
import { personMappingsFor, personSourceWithCredential } from './source-service.js';

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
  const rows = await tx.person.findMany({
    where: { sourceId },
    include: { contracts: true },
  });
  return rows.map((row) => ({
    id: row.id,
    externalId: row.externalId ?? '',
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
  }));
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
      return tx.personImportRun.update({
        where: { id: existingRunId },
        data: { status: 'running', startedAt: new Date() },
      });
    }
    return tx.personImportRun.create({ data: { tenantId: boundTenant, sourceId } });
  });

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
    for await (const record of connector.read(prepared.config as never)) {
      records.push(record);
    }

    // Phase 4: map. Failures are counted and excluded -- never absent.
    const mapped: MappedPerson[] = [];
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

    // Phase 5: one short transaction for the whole database-side snapshot the
    // diff is computed against.
    const snapshot = await withTenant(tenantId, async (tx) => {
      const managers = await tx.person.findMany({
        where: { externalId: { not: null } },
        select: { id: true, externalId: true },
      });
      return {
        existing: await loadExisting(tx, sourceId),
        managerIdByExternalId: new Map(
          managers.flatMap((m) =>
            m.externalId === null ? [] : ([[m.externalId, m.id]] as const),
          ),
        ),
        activeContractsFromSource: await tx.contract.count({
          where: {
            person: { sourceId },
            OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
          },
        }),
        personsNow: await personsWithActiveContract(tx),
        lastApplied: await tx.personImportRun.findFirst({
          where: { sourceId, status: 'applied' },
          orderBy: { finishedAt: 'desc' },
          select: { id: true },
        }),
      };
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
      if (changes.length > 0) {
        await tx.personImportChange.createMany({
          data: changes.map((change) => ({
            tenantId: boundTenant,
            runId: run.id,
            changeType: change.changeType,
            recordType: change.recordType,
            targetId: change.targetId,
            externalId: change.externalId,
            before: (change.before ?? undefined) as never,
            after: (change.after ?? undefined) as never,
            status: 'proposed',
            message: change.message ?? null,
          })),
        });
      }
      return tx.personImportRun.update({
        where: { id: run.id },
        data: {
          status: verdict.blocked ? 'blocked' : 'previewed',
          finishedAt: new Date(),
          recordsRead: records.length,
          mappingFailures,
          mappingFailureReasons: [...failureReasons],
          personsAbsent: departures,
          requiresConfirmation: verdict.blocked ? verdict.requiresConfirmation : false,
          blockedReason: verdict.blocked ? verdict.reason : null,
        },
      });
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return withTenant(tenantId, (tx) =>
      tx.personImportRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: message },
      }),
    );
  }
}

type ChangeRow = {
  id: string;
  changeType: string;
  recordType: string;
  targetId: string | null;
  externalId: string | null;
  after: unknown;
};

async function applyOne(tx: TenantClient, sourceId: string, change: ChangeRow) {
  const after = (change.after ?? {}) as Record<string, unknown>;
  const tenantId = await currentTenant(tx);

  switch (change.changeType) {
    case 'create_person':
      await tx.person.create({
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
      return;

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
      const person = await tx.person.findFirst({
        where: { sourceId, externalId: change.externalId },
      });
      if (!person) throw new Error(`no person ${change.externalId} to hold this contract`);
      const highest = await tx.contract.findFirst({
        where: { personId: person.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
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
      const { personExternalId: _ignored, ...data } = after;
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

  for (const change of ordered) {
    try {
      await withTenant(tenantId, async (tx) => {
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
      });
      applied += 1;
    } catch (cause) {
      failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      await withTenant(tenantId, (tx) =>
        tx.personImportChange.update({
          where: { id: change.id },
          data: { status: 'failed', message },
        }),
      );
    }
  }

  await withTenant(tenantId, async (tx) => {
    await tx.personImportRun.update({
      where: { id: runId },
      data: {
        status: 'applied',
        ...(opts.confirmedBy === undefined ? {} : { confirmedBy: opts.confirmedBy }),
      },
    });
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
      payload: { applied, failed, confirmed: opts.confirm === true },
    });
  });

  return { applied, failed };
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
