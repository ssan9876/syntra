import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@syntra/core';

/**
 * The query string every paged admin list takes.
 *
 * One schema for all of them, so three routes cannot drift on what `page`
 * means. `.max()` REJECTS rather than clamps, which is the intent: a caller who
 * asked for a thousand rows and quietly received fifty has a bug they cannot
 * see.
 */
export const pageQuery = z
  .object({
    q: z
      .string()
      .optional()
      // An empty box submits `?q=`. That is "no search", not "match nothing".
      .transform((value) => {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
      }),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  })
  // Strict, so `?status=active` on a list that has no status is a 400 rather
  // than a filter that silently did nothing.
  .strict();

export const statusPageQuery = pageQuery.extend({
  status: z.enum(['active', 'inactive']).optional(),
});
