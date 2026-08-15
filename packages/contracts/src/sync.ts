import { z } from 'zod';

export const createSourceRequest = z.object({
  name: z.string().min(1).max(256),
  config: z.record(z.unknown()),
  bindPassword: z.string().min(1).max(1024),
  schedule: z.string().max(128).optional(),
  autoApply: z.boolean().optional(),
  deactivationThresholdPercent: z.number().int().min(0).max(100).optional(),
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
