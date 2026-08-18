import { z } from 'zod';
import { ldapTlsModeSchema } from '../ldap/config.js';

const isLdapsUrl = (url: string) => url.trim().toLowerCase().startsWith('ldaps:');

/**
 * A configured string that names something at the directory: trimmed, and
 * refused when trimming leaves nothing.
 *
 * Surrounding whitespace is invisible in a configuration form and fatal one
 * remove away, because none of these values is ever compared loosely. The
 * expensive one is `anchorAttribute`: `anchorOf` reads
 * `entry[config.anchorAttribute]` — an exact key lookup, no RFC 4512
 * case-insensitive match like `attributeOf` does — so `'objectGUID '` names an
 * attribute no object at the target carries. Every group then comes back with
 * nothing under that key, which is the first move of the sequence that ends
 * with one blank-anchored catalog row, every real entitlement of the target
 * marked `missing`, every rule naming them unresolvable, and every person
 * those rules touch unprocessable for grants. The catalog read now refuses
 * that (see `refreshEntitlements`); this refuses the way in, at the cheapest
 * point and before a run is ever scheduled.
 *
 * Whitespace only. Case is deliberately NOT touched here: this codebase folds
 * case in some comparisons and insists on it in others — AD folds attribute
 * names, container DNs are compared folded, and an anchor is an opaque
 * identifier that is not — and a schema that quietly lowercased a value would
 * be making that decision for all of them at once.
 *
 * Nothing here asks the directory whether the value means anything. Whether
 * `objectGUID` exists in the schema, or `OU=Archive,…` exists as a container,
 * is a question for a connection test against a live server; this is a
 * syntactic refusal that costs nothing and needs nobody to be reachable.
 */
const directoryString = z.string().trim().min(1);

export const adTargetConfigSchema = z
  .object({
    url: directoryString,
    /**
     * `plain` is absent from this enum, unlike the directory source schema.
     * Active Directory refuses a password write over an unencrypted
     * connection, and a target that could be configured to write in the clear
     * is a target that eventually does. The Samba container the integration
     * tests run against refuses even an ordinary bind without TLS.
     */
    tlsMode: ldapTlsModeSchema.exclude(['plain']),
    rejectUnauthorized: z.boolean().default(true),
    bindDn: directoryString,
    baseDn: directoryString,
    /** Where listEntitlements enumerates groups. */
    entitlementSearchBase: directoryString,
    /** Where archive_account moves the object. */
    archiveContainer: directoryString,
    /**
     * Where create_account writes the tenant id and originating actionId.
     * `info` on Active Directory, or a nominated extensionAttribute.
     */
    provenanceAttribute: directoryString.default('info'),
    /** objectGUID. Kept configurable only so a test fixture can vary it. */
    anchorAttribute: directoryString.default('objectGUID'),
    /**
     * Trimmed for the same reason and one of its own: `accountFilter` is
     * concatenated into `(&<accountFilter>(sAMAccountName=…))`, and RFC 4515
     * allows no whitespace between filter components, so a padded filter is a
     * filter some servers reject and others quietly read differently.
     */
    accountFilter: directoryString.default(
      '(&(objectCategory=person)(objectClass=user))',
    ),
    groupFilter: directoryString.default('(objectClass=group)'),
    /**
     * Excluded from the entitlement catalog entirely. Primary group membership
     * is not in `member` and cannot be removed by writing to it, so an attempt
     * to revoke it would be attempted and fail forever.
     *
     * Each id is trimmed and refused blank, and its CASE is left exactly as
     * given: `listEntitlements` compares these against anchors by exact
     * equality, and the connector's "excludes the primary group by exact
     * identifier, not by case" ruling stands. The two are not the same act. A
     * differently-cased id is a visible transcription of a real identifier and
     * naming nothing is the intended answer; a padded one cannot be a real
     * identifier at all, because `normaliseAnchor` trims everything it
     * returns — so it can only ever be a mistranscription that excludes
     * nothing, and the failure it produces is the revoke that fails forever
     * telling the administrator to exclude the group with
     * `primaryGroupExternalIds`, which is what they already did.
     */
    primaryGroupExternalIds: z.array(directoryString).default([]),
    pageSize: z.number().int().positive().max(5000).default(1000),
    connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  })
  .superRefine((config, ctx) => {
    if (isLdapsUrl(config.url) && config.tlsMode !== 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message: `an ldaps:// URL is implicit TLS, so it cannot also be "${config.tlsMode}"; use an ldap:// URL for starttls`,
      });
    }
    if (!isLdapsUrl(config.url) && config.tlsMode === 'ldaps') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tlsMode'],
        message: 'tlsMode "ldaps" needs an ldaps:// URL',
      });
    }
  });

export type AdTargetConfig = z.input<typeof adTargetConfigSchema>;
export type ResolvedAdTargetConfig = z.output<typeof adTargetConfigSchema>;
