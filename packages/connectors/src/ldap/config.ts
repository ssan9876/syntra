import { z } from 'zod';

/**
 * How the connection is protected on the wire (spec section 8: "Transport —
 * LDAPS or StartTLS").
 *
 * - `ldaps` — TLS from the first byte, on the LDAPS port.
 * - `starttls` — a plaintext connection on the ordinary port, upgraded by the
 *   StartTLS extended operation *before* the bind. The ordering matters: bind
 *   first and the password has already crossed the wire in the clear, which is
 *   the whole failure this mode exists to prevent.
 * - `plain` — no transport security at all. The bind password crosses in the
 *   clear. Kept because a test fixture and a local server need it, and named
 *   plainly so choosing it is a decision rather than an accident.
 */
export const ldapTlsModeSchema = z.enum(['plain', 'starttls', 'ldaps']);
export type LdapTlsMode = z.infer<typeof ldapTlsModeSchema>;

const isLdapsUrl = (url: string) => url.trim().toLowerCase().startsWith('ldaps:');

const ldapConfigObject = z.object({
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
  /**
   * Left out, this is derived from the URL scheme -- `ldaps://` means
   * `ldaps`, anything else means `plain` -- which is exactly what the
   * connector did before the mode existed. That keeps a source saved before
   * this field behaving as it did rather than silently changing transport on
   * upgrade. `starttls` has no URL spelling of its own and can only be asked
   * for explicitly.
   */
  tlsMode: ldapTlsModeSchema.optional(),
  /** Off is a deliberate, per-source decision the interface labels plainly. */
  rejectUnauthorized: z.boolean().default(true),
});

/**
 * The connection configuration, with the TLS mode resolved.
 *
 * The mode and the URL scheme have to agree, and a disagreement is refused
 * rather than reconciled. Either way of resolving it silently is a trap: honour
 * the mode and an `ldaps://` URL with `tlsMode: 'plain'` connects a plaintext
 * client to a TLS port and hangs; honour the scheme and the mode an
 * administrator chose is quietly ignored. A configuration this contradictory
 * is a mistake, and saying so is the only safe reading.
 */
export const ldapConfigSchema = ldapConfigObject
  .superRefine((config, ctx) => {
    if (config.tlsMode === undefined) return;

    if (isLdapsUrl(config.url) && config.tlsMode !== 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message:
          `an ldaps:// URL is implicit TLS, so it cannot also be ` +
          `"${config.tlsMode}"; use an ldap:// URL for that mode`,
      });
    }

    if (!isLdapsUrl(config.url) && config.tlsMode === 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message: 'tlsMode "ldaps" needs an ldaps:// URL',
      });
    }
  })
  .transform((config) => ({
    ...config,
    tlsMode: config.tlsMode ?? (isLdapsUrl(config.url) ? 'ldaps' : 'plain'),
  }));

// The *input* type, not `z.infer`'s output type: every field with a
// `.default(...)` (userFilter, orgUnitFilter, pageSize, ...) stays optional
// here, matching what a caller -- a saved connection record, a config built
// by hand for a test -- is actually allowed to omit. The connector applies
// the schema's `.parse()` before using any of these fields, so it never sees
// an unresolved default; this type only governs what's required to *call*
// the connector, not what the connector operates on internally.
export type LdapConfig = z.input<typeof ldapConfigSchema>;
