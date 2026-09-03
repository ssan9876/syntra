/**
 * The shape every paged list in the admin API takes and returns, and the two
 * small pieces of behaviour they cannot be allowed to drift on.
 *
 * Deliberately shared as TYPES plus two helpers, with each list keeping its
 * own query. A generic `listQuery(model, fields)` would have to be understood
 * before any single list could be read, and Prisma's types resist generic
 * model access hard enough that it ends in casts. What is worth sharing is
 * the vocabulary, so three services and three routes cannot drift on what
 * `page` means -- and the bounds and escaping, because those are the parts
 * that are wrong in the same way at every site when one of them is missed.
 */
export interface ListOptions {
  search?: string | undefined;
  status?: string | undefined;
  /** 1-based. */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface ListPage<T> {
  rows: T[];
  /**
   * How many rows match the FILTERS -- not how many are in the table. With a
   * search active, "1-50 of 12" is the useful number and the table's size is
   * not.
   */
  total: number;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 50;

/**
 * The ceiling on one query's cost. Without it `?pageSize=1000000` reinstates
 * from outside exactly the unbounded read this exists to remove.
 */
export const MAX_PAGE_SIZE = 200;

export interface Paging {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/**
 * The bounds, applied where the query is built rather than only at the HTTP
 * edge. The route layer validates too, but a service is also called from
 * SCIM, from tests and from whatever comes next, and a negative `skip` is a
 * driver error while an unbounded `take` is the read `MAX_PAGE_SIZE` exists
 * to stop. Clamping rather than throwing: a page before the first IS the
 * first, and asking for more than the ceiling gets the ceiling.
 */
export function normalisePaging(opts: ListOptions): Paging {
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(opts.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Prisma's `contains` becomes `LIKE '%' || term || '%'` with the term passed
 * through as written, so a search for `%` matches everybody and `_` matches
 * any one character. Postgres's default escape character is the backslash,
 * and the backslash itself has to be escaped first or `\%` would read as a
 * literal backslash followed by a wildcard.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}
