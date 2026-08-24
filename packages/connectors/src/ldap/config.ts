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
  /**
   * Where a write-back records WHY it acted, merged into whatever the
   * attribute already held rather than replacing it.
   *
   * Named rather than hardcoded, and defaulted to the same `info` the AD
   * target connector uses, so an account disabled by the admin console and one
   * disabled by the leaver ladder carry their reason in the same place. Two
   * conventions for the same fact is how an administrator ends up trusting
   * neither.
   */
  noteAttribute: z.string().min(1).default('info'),
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
  /**
   * How long to wait for the TCP connection, and for any single LDAP
   * operation on it.
   *
   * Both have to be set. `ldapts` defaults each to zero, which it reads as
   * "wait forever": a host that drops packets rather than refusing them, or a
   * port that accepts a connection and then never answers, holds the caller
   * open indefinitely. That is a hung request handler per attempt — a
   * resource the caller of a connection test should not be able to pin.
   *
   * The operation budget is the larger of the two because a page of a large
   * directory legitimately takes seconds; the connect budget is short because
   * a reachable directory answers a TCP handshake immediately or is not there.
   */
  connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
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
