import { z } from 'zod';

/**
 * Hard-deleting a person. `confirm` is the person's full name typed back
 * (`givenName familyName`); the server compares it against the stored name.
 * Strict: a misspelt key is refused, never ignored.
 */
export const deletePersonRequest = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Give a reason of at least 10 characters')
      .max(1000),
    confirm: z.string().max(512),
  })
  .strict();
export type DeletePersonRequest = z.infer<typeof deletePersonRequest>;
