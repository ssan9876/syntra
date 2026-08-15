import { z } from 'zod';

export const ldapConfigSchema = z.object({
  url: z.string().min(1),
  bindDn: z.string().min(1),
  userSearchBase: z.string().min(1),
  groupSearchBase: z.string().min(1),
  orgUnitSearchBase: z.string().optional(),
  userFilter: z.string().default('(objectClass=person)'),
  groupFilter: z.string().default('(objectClass=group)'),
  orgUnitFilter: z.string().default('(objectClass=organizationalUnit)'),
  /** objectGUID on Active Directory, entryUUID on OpenLDAP. */
  anchorAttribute: z.string().default('objectGUID'),
  pageSize: z.number().int().positive().max(5000).default(1000),
  /** Off is a deliberate, per-source decision the interface labels plainly. */
  rejectUnauthorized: z.boolean().default(true),
});

// The *input* type, not `z.infer`'s output type: every field with a
// `.default(...)` (userFilter, orgUnitFilter, pageSize, ...) stays optional
// here, matching what a caller -- a saved connection record, a config built
// by hand for a test -- is actually allowed to omit. The connector applies
// the schema's `.parse()` before using any of these fields, so it never sees
// an unresolved default; this type only governs what's required to *call*
// the connector, not what the connector operates on internally.
export type LdapConfig = z.input<typeof ldapConfigSchema>;
