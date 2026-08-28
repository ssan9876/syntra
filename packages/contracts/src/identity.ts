import { z } from 'zod';

export const createPersonRequest = z.object({
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  businessEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  externalId: z.string().max(128).optional(),
});

/**
 * Editing a person. Same rules as the directory patches: every field optional,
 * at least one required, unknown keys refused.
 *
 * The two email fields and `externalId` are nullable so they can be cleared;
 * the names are not, because a person with no family name is not a correction
 * anybody meant to make.
 */
export const patchPersonRequest = z
  .object({
    givenName: z.string().min(1).max(128).optional(),
    familyName: z.string().min(1).max(128).optional(),
    businessEmail: z.string().email().nullable().optional(),
    personalEmail: z.string().email().nullable().optional(),
    externalId: z.string().max(128).nullable().optional(),
    /**
     * The unit this person belongs to, which places their account in the
     * container that unit is materialised at on each target.
     *
     * Nullable as well as optional, and the two mean different things:
     * omitted leaves the assignment alone, `null` clears it. Without the
     * null there would be no way to un-assign somebody, and the only
     * remaining route back to the template would be deleting the unit.
     */
    orgUnitId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const createContractRequest = z.object({
  sequence: z.number().int().positive(),
  isPrimary: z.boolean().default(false),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  jobTitle: z.string().max(256).optional(),
  department: z.string().max(256).optional(),
  costCentre: z.string().max(128).optional(),
  employer: z.string().max(256).optional(),
  location: z.string().max(256).optional(),
  managerPersonId: z.string().uuid().optional(),
  fte: z.number().min(0).max(2).optional(),
});

export const linkUserRequest = z.object({ userId: z.string().uuid() });

export const importRequest = z.object({
  csv: z.string().min(1).max(5_000_000),
});
