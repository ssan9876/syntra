import type { TenantClient } from '@syntra/db';
import { OUTBOX_MAX_ATTEMPTS } from '../automate/jobs.js';
import { subjectLinkedTables, type ErasureTreatment, type TableEntry } from './inventory.js';
import { delegateFor, subjectWhere, type SubjectIds } from './subject-data.js';

/**
 * Data-subject erasure: what it refuses on, and what it does.
 *
 * Driven by the data inventory. For every table linked to the person:
 *
 *  - `pseudonymize`: the rows stay, and every field the inventory gives a
 *    treatment is rewritten in place -- a pseudonym, a literal, or cleared.
 *    Directory objects are never deleted ("deactivate, never delete"): the
 *    person, their contracts and their accounts stay as rows that still
 *    resolve and no longer say who anybody was.
 *  - `delete`: the rows go. Only credential material and transient protocol
 *    or rehearsal state is classified this way.
 *  - `retain`: the rows stay unchanged, for the reason the inventory gives.
 *    The audit log is the principal case: it is immutable to the application
 *    and leaves only through the audit-retention archive-and-prune.
 *
 * The rows are found through the inventory's links, read by id, and rewritten
 * by id with SQL the inventory's constants compose -- never from input. Every
 * statement runs inside the caller's tenant-bound transaction, so row-level
 * security confines it to the tenant whatever it says.
 */

const RESOLVED_OPERATION_STATUSES = ['completed', 'cancelled', 'rejected'];
const LIVE_ACCOUNT_STATUSES = ['pending', 'active', 'conflict'];
const LIVE_GRANT_STATUSES = ['pending', 'active', 'scheduled'];
const IN_FLIGHT_ACTION_STATUSES = ['in_flight', 'pending_retry'];

export type ErasureBlockerCode =
  | 'already-erased'
  | 'legal-hold-active'
  | 'lifecycle-work-unresolved'
  | 'provisioning-in-flight'
  | 'person-active'
  | 'accounts-active'
  | 'access-active';

export interface ErasureBlocker {
  code: ErasureBlockerCode;
  count: number;
  message: string;
}

/**
 * Everything that stops an erasure now. Blockers are listed in the order an
 * administrator should work them: a hold first (it is somebody else's
 * decision to release), then unfinished work, then what is still live.
 */
export async function erasureBlockers(tx: TenantClient, ids: SubjectIds): Promise<ErasureBlocker[]> {
  const person = await tx.person.findUniqueOrThrow({
    where: { id: ids.personId },
    select: { status: true, erasedAt: true },
  });
  const blockers: ErasureBlocker[] = [];
  if (person.erasedAt !== null) {
    blockers.push({ code: 'already-erased', count: 1, message: 'This person has already been erased.' });
    return blockers;
  }

  const simulations = await tx.lifecycleSimulation.findMany({ where: { personId: ids.personId }, select: { id: true } });
  const holds = await tx.lifecycleLegalHold.findMany({
    where: {
      releasedAt: null,
      OR: [
        { subjectType: 'person', subjectId: ids.personId },
        ...(ids.operationIds.length ? [{ subjectType: 'lifecycle_operation', subjectId: { in: ids.operationIds } }] : []),
        ...(simulations.length ? [{ subjectType: 'lifecycle_simulation', subjectId: { in: simulations.map((s) => s.id) } }] : []),
      ],
    },
    select: { reference: true },
  });
  if (holds.length > 0) {
    blockers.push({
      code: 'legal-hold-active',
      count: holds.length,
      message: `${holds.length} active legal hold(s) cover this person (${[...new Set(holds.map((h) => h.reference))].join(', ')}); they must be released first.`,
    });
  }

  const unresolved = await tx.lifecycleOperation.count({
    where: { personId: ids.personId, status: { notIn: RESOLVED_OPERATION_STATUSES } },
  });
  if (unresolved > 0) {
    blockers.push({
      code: 'lifecycle-work-unresolved',
      count: unresolved,
      message: `${unresolved} lifecycle operation(s) for this person are unresolved; complete or cancel them first.`,
    });
  }

  const inFlight = await tx.provisionAction.count({
    where: {
      status: { in: IN_FLIGHT_ACTION_STATUSES },
      OR: [
        { personId: ids.personId },
        ...(ids.accountIds.length ? [{ accountId: { in: ids.accountIds } }] : []),
      ],
    },
  });
  if (inFlight > 0) {
    blockers.push({
      code: 'provisioning-in-flight',
      count: inFlight,
      message: `${inFlight} provisioning action(s) for this person are in flight or waiting to retry; let the run finish first.`,
    });
  }

  if (person.status === 'active') {
    blockers.push({
      code: 'person-active',
      count: 1,
      message: 'The person is active. Deactivate them (and end their contracts) before erasing: an erasure never replaces an offboarding.',
    });
  }

  const [activeUsers, liveAccounts] = await Promise.all([
    tx.user.count({ where: { personId: ids.personId, status: 'active' } }),
    tx.targetAccount.count({ where: { personId: ids.personId, status: { in: LIVE_ACCOUNT_STATUSES } } }),
  ]);
  if (activeUsers + liveAccounts > 0) {
    blockers.push({
      code: 'accounts-active',
      count: activeUsers + liveAccounts,
      message: `${activeUsers} Syntra account(s) and ${liveAccounts} target-system account(s) are still active or pending; deactivate, disable or archive them first.`,
    });
  }

  const grants = await tx.accessGrant.count({
    where: { subjectPersonId: ids.personId, status: { in: LIVE_GRANT_STATUSES } },
  });
  if (grants > 0) {
    blockers.push({
      code: 'access-active',
      count: grants,
      message: `${grants} access grant(s) are still pending or active; end them first.`,
    });
  }
  return blockers;
}

export interface ErasureCounts {
  /** Rows rewritten in place, per table. */
  pseudonymized: Record<string, number>;
  /** Rows deleted, per table. */
  deleted: Record<string, number>;
  /** Rows kept unchanged, per table. */
  retained: Record<string, number>;
  /** Vault secrets deleted with the credentials that named them. */
  secretsDeleted: number;
  /** Access bundles about the person whose file was erased. */
  bundlesErased: number;
}

/**
 * Nullability and array-ness of one table's columns, read from the database.
 *
 * Not from Prisma's runtime DMMF: Prisma 7 trimmed it to name, kind and type,
 * so `isRequired` and `isList` read as undefined and every column looked
 * optional -- clearing a required JSON column then wrote NULL and failed its
 * NOT NULL constraint. The catalog is the authority on what the column
 * accepts, whichever ORM version wrote the schema.
 */
type ColumnMeta = { nullable: boolean; isArray: boolean; dataType: string };

async function columnMeta(tx: TenantClient, model: string): Promise<Map<string, ColumnMeta>> {
  const rows = await tx.$queryRaw<{ column_name: string; is_nullable: string; data_type: string }[]>`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${model}`;
  return new Map(
    rows.map((r) => [r.column_name, { nullable: r.is_nullable === 'YES', isArray: r.data_type === 'ARRAY', dataType: r.data_type }]),
  );
}

const quoteIdent = (name: string) => {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`refusing to quote identifier ${name}`);
  return `"${name}"`;
};

/**
 * The SQL expression a treatment writes. Values are bound parameters; only
 * identifiers from the Prisma schema are interpolated, and only after
 * `quoteIdent` has checked them.
 */
function assignment(
  model: string,
  field: string,
  treatment: ErasureTreatment,
  params: unknown[],
  columns: Map<string, ColumnMeta>,
): string {
  const meta = columns.get(field);
  if (meta === undefined) throw new Error(`${model}.${field} is not a column`);
  const column = quoteIdent(field);
  switch (treatment.kind) {
    case 'pseudonym':
      return `${column} = 'erased-' || "id"::text`;
    case 'pseudonym-email':
      return `${column} = 'erased-' || "id"::text || '@erased.invalid'`;
    case 'literal':
      params.push(treatment.value);
      return `${column} = $${params.length}`;
    case 'clear':
      if (meta.isArray) return `${column} = '{}'`;
      if (meta.nullable) return `${column} = NULL`;
      if (meta.dataType === 'jsonb' || meta.dataType === 'json') return `${column} = '{}'::jsonb`;
      if (meta.dataType === 'text' || meta.dataType === 'character varying') return `${column} = ''`;
      throw new Error(`${model}.${field}: a required ${meta.dataType} cannot be cleared`);
  }
}

async function pseudonymizeRows(tx: TenantClient, entry: TableEntry, rowIds: string[]): Promise<number> {
  const params: unknown[] = [rowIds];
  const columns = await columnMeta(tx, entry.model);
  const sets = entry.fields
    .filter((f) => f.treatment !== null)
    .map((f) => assignment(entry.model, f.name, f.treatment!, params, columns));
  const sql = `UPDATE ${quoteIdent(entry.model)} SET ${sets.join(', ')} WHERE "id" = ANY($1::uuid[])`;
  return tx.$executeRawUnsafe(sql, ...params);
}

/**
 * Erases one person, in the caller's transaction. The caller has already
 * checked `erasureBlockers` in this same transaction.
 */
export async function eraseSubject(
  tx: TenantClient,
  ids: SubjectIds,
  context: { caseId: string; actorUserId: string; now: Date },
): Promise<ErasureCounts> {
  const counts: ErasureCounts = { pseudonymized: {}, deleted: {}, retained: {}, secretsDeleted: 0, bundlesErased: 0 };

  // Access bundles about this person that still hold a file: the file is a
  // copy of exactly the data being erased.
  const bundles = await tx.dataExport.updateMany({
    where: {
      kind: 'dsar_bundle',
      status: { in: ['queued', 'running', 'ready'] },
      params: { path: ['personId'], equals: ids.personId },
    },
    data: {
      status: 'revoked',
      revokedAt: context.now,
      revokedByUserId: context.actorUserId,
      purgedAt: context.now,
      ciphertext: null,
      iv: null,
      tag: null,
      wrappedDek: null,
      dekIv: null,
      dekTag: null,
    },
  });
  counts.bundlesErased = bundles.count;

  // Deletes first, while the identifiers they are found by are intact; then
  // pseudonymisation, with the person's own row last so every other table is
  // found through the values it still holds.
  const tables = subjectLinkedTables().sort((a, b) => {
    const rank = (e: TableEntry) => (e.erasure === 'delete' ? 0 : e.model === 'Person' ? 2 : 1);
    return rank(a) - rank(b) || a.model.localeCompare(b.model);
  });
  for (const entry of tables) {
    const where = subjectWhere(entry.links!, ids);
    if (where === null) continue;
    const delegate = delegateFor(tx, entry.model);
    if (entry.erasure === 'retain') {
      const retained = await delegate.count({ where });
      if (retained > 0) counts.retained[entry.model] = retained;
      continue;
    }
    if (entry.erasure === 'delete') {
      if (entry.model === 'TotpCredential') {
        const named = await tx.totpCredential.findMany({ where, select: { secretName: true } });
        if (named.length > 0) {
          counts.secretsDeleted += (await tx.secret.deleteMany({ where: { name: { in: named.map((n) => n.secretName) } } })).count;
        }
      }
      const deleted = (await delegate.deleteMany({ where })).count;
      if (deleted > 0) counts.deleted[entry.model] = deleted;
      continue;
    }
    const rows = await delegate.findMany({ where, select: { id: true } });
    if (rows.length === 0) continue;
    const rowIds = rows.map((r) => r.id as string);
    for (let at = 0; at < rowIds.length; at += 1000) {
      await pseudonymizeRows(tx, entry, rowIds.slice(at, at + 1000));
    }
    counts.pseudonymized[entry.model] = rowIds.length;
    if (entry.model === 'NotificationOutbox') {
      // A message not yet sent is not sent: its recipient is now a pseudonym,
      // and the worker gives up on a row at the attempt ceiling.
      await tx.notificationOutbox.updateMany({
        where: { id: { in: rowIds }, sentAt: null },
        data: { attempts: OUTBOX_MAX_ATTEMPTS },
      });
    }
  }

  // The markers. The restriction becomes permanent: an HR feed or directory
  // that still holds the person must not write them back.
  await tx.person.update({
    where: { id: ids.personId },
    data: {
      erasedAt: context.now,
      erasedCaseId: context.caseId,
      processingRestrictedAt: context.now,
      processingRestrictedCaseId: context.caseId,
    },
  });
  return counts;
}
