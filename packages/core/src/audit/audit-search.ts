import { Prisma, type TenantClient } from '@syntra/db';

/**
 * Server-side audit search (backlog #73).
 *
 * The log is append-only and grows for ever, so everything here is shaped by
 * one rule: a page costs the same on the ten-millionth event as on the tenth.
 * That means
 *
 *  - every filter is applied in SQL, never to a page already fetched -- a
 *    filter applied in the browser to the newest hundred events answers "what
 *    did this person do" with "nothing" for anybody who did it last week;
 *  - pagination is KEYSET on `sequence`, never OFFSET. `sequence` is the
 *    chain's own order, unique per tenant, assigned under the tenant's
 *    advisory lock, and so it is monotonic with `occurredAt` as well. OFFSET
 *    reads and throws away every row before the page, and on a log that is
 *    being appended to it also skips or repeats rows as the page boundary
 *    moves under the reader;
 *  - every filter has an index that leads with `tenantId` and ends with
 *    `sequence` (migration `20261030120000_data_exports_audit_search`), so a
 *    filtered page is a range read in cursor order. `audit-search.test.ts`
 *    seeds 100,000 events and asserts the plans.
 *
 * There is no correlation id. `AuditEvent` has never recorded one -- a
 * request id is not written by `recordEvent` and appears in no payload by
 * convention -- so a filter for it would search a column that does not exist.
 * The closest honest thing is the subject filter, which follows a person or an
 * object through everything done by it and to it.
 */

/** The largest page a caller may ask for. The console asks for 50. */
export const AUDIT_SEARCH_MAX_PAGE = 200;

export interface AuditSearchFilters {
  /** Exactly this actor. */
  actorUserId?: string | undefined;
  /**
   * Actions starting with this. `auth.` is every authentication event;
   * `auth.login` is that action and anything that extends its name. Limited to
   * the characters action names are made of (see the contract), which is what
   * lets the prefix become an exact byte range below.
   */
  actionPrefix?: string | undefined;
  /** Exactly this target id. */
  targetId?: string | undefined;
  /** Exactly this target type, e.g. `User`. */
  targetType?: string | undefined;
  outcome?: 'success' | 'failure' | undefined;
  /** Inclusive. */
  from?: Date | undefined;
  /** Exclusive, so consecutive windows neither overlap nor leave a gap. */
  to?: Date | undefined;
  /**
   * Done BY or TO any of these. An empty array matches nothing -- see
   * `listEvents` for why an empty subject list must not mean "everybody".
   */
  subjectIds?: string[] | undefined;
}

export interface AuditSearchPage {
  /** Only events with a sequence below this (newest-first paging). */
  before?: number | undefined;
  /** Only events with a sequence above this (oldest-first, for exports). */
  after?: number | undefined;
  /** Only events with a sequence at or below this: an export's fixed head. */
  maxSequence?: number | undefined;
  limit: number;
  order: 'desc' | 'asc';
}

export interface AuditEventRow {
  id: string;
  sequence: number;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  sourceIp: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

/**
 * The smallest string greater than every string that starts with `prefix`,
 * under byte-wise comparison: the prefix with its last character incremented.
 *
 * Exact only because the contract limits a prefix to printable ASCII below
 * `~`, so the increment never wraps and never leaves one byte.
 */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * The one query, as SQL, so the service and the query-plan test run exactly
 * the same statement. A plan asserted over a hand-written copy proves the copy.
 *
 * The prefix is a RANGE under `text_pattern_ops` (`~>=~` and `~<~`) rather
 * than `LIKE $1 || '%'`. A parameterised LIKE cannot use an index once
 * PostgreSQL switches the prepared statement to a generic plan, which it does
 * silently after five executions -- the search would be fast in a test and
 * slow in production. A range over bound parameters is indexable in both.
 *
 * Tenant isolation is not repeated here: the FORCE RLS policy on `AuditEvent`
 * adds `tenantId = current_setting(...)` to every read, and the planner uses
 * it as the leading index condition.
 */
export function auditSearchSql(filters: AuditSearchFilters, page: AuditSearchPage): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters.actorUserId !== undefined) {
    conditions.push(Prisma.sql`"actorUserId" = ${filters.actorUserId}::uuid`);
  }
  if (filters.targetId !== undefined) {
    conditions.push(Prisma.sql`"targetId" = ${filters.targetId}::uuid`);
  }
  if (filters.targetType !== undefined) {
    conditions.push(Prisma.sql`"targetType" = ${filters.targetType}`);
  }
  if (filters.actionPrefix !== undefined && filters.actionPrefix !== '') {
    conditions.push(
      Prisma.sql`"action" ~>=~ ${filters.actionPrefix} AND "action" ~<~ ${prefixUpperBound(filters.actionPrefix)}`,
    );
  }
  if (filters.outcome !== undefined) {
    conditions.push(Prisma.sql`"outcome" = ${filters.outcome}`);
  }
  // A TIME WINDOW IS ALSO A SEQUENCE RANGE, and the query says so.
  //
  // `occurredAt` is `timestamp(3)` holding UTC, which is how Prisma writes
  // every DateTime; the bound is converted to exactly that, explicitly, rather
  // than left to the session's time zone. Filtering on it alone is correct and
  // was measurably slow: with `ORDER BY sequence ... LIMIT 51` the planner
  // walks the sequence index backwards from the head, assuming matches are
  // spread evenly, and for a day in the middle of the log it read 2,000 blocks
  // to reach it (the query-plan test caught this). The two scalar subqueries
  // turn the window into the first and last sequence inside it -- each one
  // row from the `(tenantId, occurredAt)` index -- so the same walk starts at
  // the window's newest event and stops at its oldest.
  //
  // Exact because `recordEvent` never lets time run backwards along the chain.
  // A window with no event at or after `from` (or before `to`) yields NULL,
  // and `sequence >= NULL` matches nothing, which is the right answer. The
  // `occurredAt` conditions stay as the definition; the sequence range is how
  // it is found.
  if (filters.from !== undefined) {
    const from = Prisma.sql`(${filters.from.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    conditions.push(Prisma.sql`"occurredAt" >= ${from}`);
    conditions.push(Prisma.sql`"sequence" >= (
      SELECT "sequence" FROM "AuditEvent" WHERE "occurredAt" >= ${from}
      ORDER BY "occurredAt" ASC, "sequence" ASC LIMIT 1)`);
  }
  if (filters.to !== undefined) {
    const to = Prisma.sql`(${filters.to.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    conditions.push(Prisma.sql`"occurredAt" < ${to}`);
    conditions.push(Prisma.sql`"sequence" <= (
      SELECT "sequence" FROM "AuditEvent" WHERE "occurredAt" < ${to}
      ORDER BY "occurredAt" DESC, "sequence" DESC LIMIT 1)`);
  }
  if (filters.subjectIds !== undefined) {
    if (filters.subjectIds.length === 0) {
      conditions.push(Prisma.sql`FALSE`);
    } else {
      const ids = Prisma.join(filters.subjectIds.map((id) => Prisma.sql`${id}::uuid`));
      conditions.push(Prisma.sql`("targetId" IN (${ids}) OR "actorUserId" IN (${ids}))`);
    }
  }
  if (page.before !== undefined) conditions.push(Prisma.sql`"sequence" < ${page.before}`);
  if (page.after !== undefined) conditions.push(Prisma.sql`"sequence" > ${page.after}`);
  if (page.maxSequence !== undefined) {
    conditions.push(Prisma.sql`"sequence" <= ${page.maxSequence}`);
  }

  const where =
    conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
  const order = page.order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const limit = Math.max(1, Math.min(page.limit, 5000));

  return Prisma.sql`
    SELECT "id", "sequence", "occurredAt", "actorUserId", "action", "targetType",
           "targetId", "outcome", "sourceIp", "payload", "prevHash", "hash"
    FROM "AuditEvent"
    ${where}
    ORDER BY "sequence" ${order}
    LIMIT ${limit}
  `;
}

/**
 * A page of the log, newest first, with the cursor for the next one.
 *
 * One row more than the page is read, so `nextBefore` is null exactly when
 * there is nothing further -- a "Next" button that leads to an empty page is
 * a control that lies about the list.
 */
export async function searchAuditEvents(
  tx: TenantClient,
  filters: AuditSearchFilters,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<{ events: AuditEventRow[]; nextBefore: number | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, AUDIT_SEARCH_MAX_PAGE));
  const rows = await tx.$queryRaw<AuditEventRow[]>(
    auditSearchSql(filters, { before: opts.before, limit: limit + 1, order: 'desc' }),
  );
  const events = rows.slice(0, limit);
  const last = events[events.length - 1];
  return {
    events,
    nextBefore: rows.length > limit && last !== undefined ? last.sequence : null,
  };
}
