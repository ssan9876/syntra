import { z } from 'zod';

export const createPersonRequest = z.object({
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  businessEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  externalId: z.string().max(128).optional(),
  /**
   * The unit this person belongs to, which places their provisioned account
   * in the container that unit is materialised at on each target.
   *
   * The onboarding form has been sending this since it was written and the
   * schema never accepted it, so Zod stripped it on every request and
   * `createPerson` never saw one: the form asked which unit somebody belonged
   * to, said it decided where their account would land, and dropped the
   * answer. Everybody onboarded through it fell to the fallback container.
   */
  orgUnitId: z.string().uuid().optional(),
  /**
   * Confirms somebody who looks like a person already here.
   *
   * A warning rather than a refusal, because two real people do share a name
   * and the alternative to creating the second one is not creating them at
   * all. There is no way to merge two people afterwards, which is exactly why
   * the question is asked before rather than after.
   */
  allowDuplicate: z.boolean().optional(),
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

/**
 * Correcting a contract.
 *
 * Same idiom as `patchPersonRequest`: every field optional, at least one
 * required, unknown keys refused. Before this the only way to fix a mistyped
 * department was a SECOND contract at a new sequence, which records a
 * different fact about the person than the one anybody meant to record — it
 * says they took another job, and the planner reads it that way.
 *
 * `startDate` is not nullable, for the reason the names on `patchPersonRequest`
 * are not: a contract with no start is not a correction anybody meant to make.
 * Everything else is, so it can be cleared.
 */
export const patchContractRequest = z
  .object({
    isPrimary: z.boolean().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().nullable().optional(),
    jobTitle: z.string().max(256).nullable().optional(),
    department: z.string().max(256).nullable().optional(),
    costCentre: z.string().max(128).nullable().optional(),
    employer: z.string().max(256).nullable().optional(),
    location: z.string().max(256).nullable().optional(),
    managerPersonId: z.string().uuid().nullable().optional(),
    fte: z.number().min(0).max(2).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

/**
 * A contract is addressed by the sequence its person holds it at, rather than
 * by its own id, because that is how the console reads them: `GET /persons/:id`
 * returns contracts nested under the person, and a row on that screen knows its
 * sequence and never sees a uuid.
 */
export const contractParams = z.object({
  id: z.string().uuid(),
  sequence: z.coerce.number().int().positive(),
});

export const linkUserRequest = z.object({ userId: z.string().uuid() });

export const importRequest = z.object({
  csv: z.string().min(1).max(5_000_000),
});
