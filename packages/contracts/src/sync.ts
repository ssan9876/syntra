import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

/**
 * A cron expression the job scheduler will actually accept.
 *
 * Validated here, at the contract boundary, because pg-boss parses the
 * expression *before* its upsert (`timekeeper.js`: `CronExpressionParser.parse`,
 * then `executeSql`). A malformed expression therefore throws with the previous
 * schedule row still in place — so without this check a `PATCH` returns 200, the
 * console renders the string it was handed, and the scheduler goes on firing the
 * expression it had. Displayed schedule and actual schedule diverge with no
 * signal anywhere but a log line, which is the same silent divergence the rest
 * of this work exists to remove. Refused before the transaction opens rather
 * than reported after it commits.
 *
 * Parsed exactly the way pg-boss parses it — same library, same `tz`, same
 * `strict: false` — so this accepts precisely what the scheduler accepts:
 * neither a stricter dialect that rejects a working expression, nor a looser
 * one that lets a broken one through.
 *
 * Exported because Provision schedules its targets through the same pg-boss
 * and had the same hole: `schedule` was `z.string()` at both of its
 * boundaries, so a malformed expression committed, audited as a success and
 * then threw out of the scheduler. One validator, not two that can disagree
 * about what the scheduler accepts.
 */
export const cronExpression = z
  .string()
  .min(1)
  .max(128)
  .superRefine((value, ctx) => {
    try {
      CronExpressionParser.parse(value, { tz: 'UTC', strict: false });
    } catch (cause) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not a cron expression the scheduler can use: ${
          cause instanceof Error ? cause.message : 'unparseable'
        }`,
      });
    }
  });

export const createSourceRequest = z.object({
  name: z.string().min(1).max(256),
  config: z.record(z.unknown()),
  bindPassword: z.string().min(1).max(1024),
  schedule: cronExpression.optional(),
  autoApply: z.boolean().optional(),
  deactivationThresholdPercent: z.number().int().min(0).max(100).optional(),
  /**
   * Absent means enabled, which is what a source created before this field
   * existed got. Sending `false` creates a source that is configured but does
   * not run — the only way to give a source a cron expression and its
   * attribute mappings without the schedule firing in between, since a create
   * is scheduled the moment it commits.
   */
  enabled: z.boolean().optional(),
  /**
   * Write-back. All four default to false, and a source that omits them
   * stays read-only: an upgrade must not hand an existing source the ability
   * to change passwords, disable accounts or delete objects.
   *
   * `writebackEnabled` is the master switch; the other three are the
   * individual writes, separate because they are separate decisions.
   * `writebackDelete` is the only one whose effect cannot be undone by
   * writing the opposite value back.
   */
  writebackEnabled: z.boolean().optional(),
  writebackPassword: z.boolean().optional(),
  writebackDisable: z.boolean().optional(),
  writebackDelete: z.boolean().optional(),
});

/**
 * Every field optional, and only what was sent is written: changing a
 * schedule must not mean resending the whole connection configuration.
 *
 * `schedule` is nullable as well as optional, and the two mean different
 * things — absent leaves the cron expression alone, `null` clears it and
 * makes the source manual-only. `bindPassword` is write-only here as it is
 * on create; the API accepts it and never returns it.
 */
export const updateSourceRequest = z
  .object({
    name: z.string().min(1).max(256).optional(),
    config: z.record(z.unknown()).optional(),
    bindPassword: z.string().min(1).max(1024).optional(),
    schedule: cronExpression.nullable().optional(),
    autoApply: z.boolean().optional(),
    deactivationThresholdPercent: z.number().int().min(0).max(100).optional(),
    enabled: z.boolean().optional(),
    writebackEnabled: z.boolean().optional(),
    writebackPassword: z.boolean().optional(),
    writebackDisable: z.boolean().optional(),
    writebackDelete: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'nothing to update',
  });

/**
 * Deleting a source deactivates every account and group it owns. That
 * revokes real access, so it is refused unless the caller says so — the same
 * shape as the run guard, which will not apply an outsized deactivation
 * without confirmation either.
 */
export const deleteSourceQuery = z.object({
  confirm: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /**
   * The counts the caller was shown when they confirmed.
   *
   * Confirmation is worth only as much as the numbers it was given, and those
   * numbers are read when a page opens. A sync run between the reading and the
   * clicking can turn "12 users will be deactivated" into twelve hundred, and
   * the caller would have confirmed something they were never told. Sent back,
   * they are checked against the counts inside the deleting transaction, and a
   * disagreement is refused with the real ones rather than acted on.
   *
   * Optional, because an API caller who never saw a screen has nothing to
   * acknowledge and `confirm=true` alone still means what it always meant.
   */
  ackUsers: z.coerce.number().int().min(0).optional(),
  ackGroups: z.coerce.number().int().min(0).optional(),
  ackOrgUnits: z.coerce.number().int().min(0).optional(),
});

export const mappingRule = z.object({
  objectType: z.enum(['user', 'group', 'orgUnit']),
  sourceAttribute: z.string().min(1).max(128),
  targetField: z.string().min(1).max(128),
  transform: z.enum(['none', 'trim', 'lowercase']),
  isCorrelation: z.boolean(),
});

export const setMappingsRequest = z.object({
  rules: z.array(mappingRule).min(1),
});

export const applyRunRequest = z.object({
  only: z.array(z.string().uuid()).optional(),
  /**
   * Applies a run the guard blocked for exceeding the deactivation threshold.
   * Only that refusal is confirmable: a run that read no records is refused
   * outright, and nothing the caller sends changes that. The scheduler never
   * sets this — an unattended schedule is the circumstance the guard exists
   * for.
   */
  confirm: z.boolean().optional(),
});

/**
 * What a `SyncRun` looks like over the wire. The counts are the honest report
 * of the run: `recordsRead` alone reads as a clean run even when a tenth of
 * the directory could not be mapped, so `mappingFailures` sits beside it and
 * carries its reasons.
 */
export const syncRunSummary = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  recordsRead: z.number(),
  mappingFailures: z.number(),
  mappingFailureReasons: z.array(z.string()),
  unresolvedMembers: z.number(),
  requiresConfirmation: z.boolean(),
  blockedReason: z.string().nullable(),
  error: z.string().nullable(),
});
export type SyncRunSummary = z.infer<typeof syncRunSummary>;

/**
 * A connection test for a configuration that may never have been saved.
 *
 * The spec's administration surface tests *before* anything is written, so
 * this carries the connection settings as typed rather than the id of a
 * stored row. The credential is the exception: an editor changing a search
 * base should not have to re-type the bind password, and the browser must
 * never be handed the stored one to send back. So a request either carries a
 * new password, or names the saved source whose vault entry should be used --
 * and the password itself stays server-side either way.
 */
export const testConnectionRequest = z
  .object({
    config: z.record(z.unknown()),
    bindPassword: z.string().min(1).max(1024).optional(),
    sourceId: z.string().uuid().optional(),
  })
  .refine(
    (body) => body.bindPassword !== undefined || body.sourceId !== undefined,
    {
      message:
        'send a bind password, or the id of a saved source whose stored password should be used',
    },
  );
