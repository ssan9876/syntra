import { z } from 'zod';

export const createPersonRequest = z.object({
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  businessEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  externalId: z.string().max(128).optional(),
});

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
