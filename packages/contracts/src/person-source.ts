import { z } from 'zod';

const feedMode = z.enum(['snapshot', 'delta']);

/**
 * Strict, like every schema carrying a security-relevant flag.
 *
 * `strictness.test.ts` records why: zod strips an unknown key, so a request
 * carrying `feedMod: 'delta'` alongside valid fields would commit the valid
 * ones, answer success, and leave the feed mode as it was. An administrator
 * who believes they switched a source to delta and did not is one quiet night
 * away from departing everyone absent from a delta file.
 */
export const createPersonSourceRequest = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    /** No default. The caller states it or the request fails. */
    feedMode,
    config: z.record(z.unknown()),
    credential: z.string().min(1),
    schedule: z.string().min(1).optional(),
    autoApply: z.boolean().optional(),
    deactivationThresholdPercent: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updatePersonSourceRequest = z
  .object({
    name: z.string().min(1),
    config: z.record(z.unknown()),
    credential: z.string().min(1),
    feedMode,
    schedule: z.string().min(1).nullable(),
    autoApply: z.boolean(),
    deactivationThresholdPercent: z.number().int().min(1).max(100),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export const personMappingRule = z
  .object({
    recordType: z.enum(['person', 'contract']),
    sourceColumn: z.string().min(1),
    targetField: z.string().min(1),
    transform: z.enum(['none', 'trim', 'lowercase']).default('none'),
    isCorrelation: z.boolean().default(false),
  })
  .strict();

export const setPersonMappingsRequest = z
  .object({ mappings: z.array(personMappingRule) })
  .strict();

/**
 * Accepting a host key.
 *
 * The fingerprint is echoed back rather than taken on trust from the row: the
 * administrator is confirming the key they were SHOWN, and a request naming no
 * key would accept whatever the server happens to present at the moment the
 * request lands.
 */
export const acceptHostKeyRequest = z
  .object({ fingerprint: z.string().min(1) })
  .strict();

export const applyImportRunRequest = z
  .object({
    only: z.array(z.string().uuid()).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export const deletePersonSourceQuery = z
  .object({ confirm: z.coerce.boolean().optional() })
  .strict();
