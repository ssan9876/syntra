/**
 * The shape every paged list in the admin API takes and returns.
 *
 * Deliberately shared as TYPES only, with each list keeping its own function.
 * A generic `listQuery(model, fields)` would have to be understood before any
 * single list could be read, and Prisma's types resist generic model access
 * hard enough that it ends in casts. What is worth sharing is the vocabulary,
 * so three services and three routes cannot drift on what `page` means.
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
