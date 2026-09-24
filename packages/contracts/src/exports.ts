import { z } from 'zod';
import { systemReportQuery } from './govern.js';

/**
 * Audit search filters and the asynchronous export service (backlog #48, #73).
 *
 * The same filter object is the query string of `GET /audit`, the `params` of
 * an `audit_log` export, and the body of a saved view -- one definition, so
 * "export these results" exports exactly the results on the screen and a
 * saved view re-runs exactly the search that was saved.
 */

/**
 * An action name or the start of one. Action names are dotted lowercase words
 * (`auth.login`, `provision.target.external_writes.pause`), and the service
 * turns a prefix into an exact byte range by incrementing its last character
 * -- which is only exact for characters below `~`, so the set is closed here.
 */
export const auditActionPrefix = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits, and . _ : - only');

const isoInstant = z.string().datetime({ offset: true });

const auditFilterShape = {
  /** Exactly this actor (a user id). */
  actor: z.string().uuid().optional(),
  /** Actions starting with this. */
  action: auditActionPrefix.optional(),
  /** Exactly this target id. */
  target: z.string().uuid().optional(),
  /** Exactly this target type, e.g. `User`. */
  targetType: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_]+$/)
    .optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  /** Inclusive lower bound, ISO 8601 with offset. */
  from: isoInstant.optional(),
  /** Exclusive upper bound, ISO 8601 with offset. */
  to: isoInstant.optional(),
  /**
   * Every event recorded in one request or job: the id each response returns
   * in `x-correlation-id`. The same 32-hex format the column's CHECK enforces,
   * so a malformed value is a 400 and not a scan.
   */
  correlation: z.string().regex(/^[0-9a-f]{32}$/).optional(),
};

const orderedWindow = (v: { from?: string | undefined; to?: string | undefined }) =>
  v.from === undefined || v.to === undefined || Date.parse(v.from) < Date.parse(v.to);
const windowMessage = { message: '`from` must be before `to`', path: ['to'] };

/**
 * STRICT, because it is also a body. A misspelt filter in an export request
 * that zod stripped would export the whole log where the caller asked for one
 * person's slice of it, and report success.
 */
export const auditSearchFilters = z
  .object(auditFilterShape)
  .strict()
  .refine(orderedWindow, windowMessage);

export type AuditSearchFilterInput = z.infer<typeof auditSearchFilters>;

/**
 * The query string of `GET /audit`. Not strict: a query string travels
 * through proxies and link-sharing tools that add their own parameters.
 */
export const auditSearchQuery = z
  .object({
    ...auditFilterShape,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Keyset cursor: only events with a lower sequence. */
    before: z.coerce.number().int().positive().optional(),
    /**
     * Whose log this is. Repeatable, because a person's log is their own id
     * together with every account linked to them. `uuid()` is load-bearing:
     * both columns it filters are `uuid`, so an arbitrary string would reach
     * PostgreSQL as a cast failure and a 500.
     */
    subject: z
      .preprocess(
        (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
        z.array(z.string().uuid()).max(50),
      )
      .optional(),
  })
  .refine(orderedWindow, windowMessage);

/** Hours an export stays downloadable once ready. The database enforces 1-72. */
export const exportTtlHours = z.number().int().min(1).max(72).default(24);

/**
 * The window of an operational support bundle (backlog #64). Both optional:
 * `to` defaults to now and `from` to a day before `to`. At most seven days --
 * the service checks it again, and fixes the window as explicit instants when
 * the request is recorded.
 */
export const SUPPORT_BUNDLE_MAX_WINDOW_DAYS = 7;
export const supportBundleParams = z
  .object({ from: isoInstant.optional(), to: isoInstant.optional() })
  .strict()
  .refine(orderedWindow, windowMessage)
  .refine(
    (v) =>
      v.from === undefined ||
      (v.to === undefined ? Date.now() : Date.parse(v.to)) - Date.parse(v.from) <=
        SUPPORT_BUNDLE_MAX_WINDOW_DAYS * 86_400_000,
    { message: 'a support bundle covers at most seven days', path: ['from'] },
  );

export const exportRequestBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('audit_log'),
      params: auditSearchFilters.default({}),
      ttlHours: exportTtlHours,
    })
    .strict(),
  z
    .object({
      kind: z.literal('govern_access'),
      params: systemReportQuery.strict(),
      ttlHours: exportTtlHours,
    })
    .strict(),
  z
    .object({
      kind: z.literal('support_bundle'),
      params: supportBundleParams.default({}),
      ttlHours: exportTtlHours,
    })
    .strict(),
]);

export type ExportRequestBody = z.infer<typeof exportRequestBody>;

export const exportListQuery = z.object({
  /** Every administrator's exports, for `tenant.manage`. Otherwise your own. */
  scope: z.enum(['mine', 'all']).default('mine'),
});

export const auditSavedViewBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    filters: auditSearchFilters,
  })
  .strict();
