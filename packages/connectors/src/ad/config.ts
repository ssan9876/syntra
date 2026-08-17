import { z } from 'zod';
import { ldapTlsModeSchema } from '../ldap/config.js';

const isLdapsUrl = (url: string) => url.trim().toLowerCase().startsWith('ldaps:');

export const adTargetConfigSchema = z
  .object({
    url: z.string().min(1),
    /**
     * `plain` is absent from this enum, unlike the directory source schema.
     * Active Directory refuses a password write over an unencrypted
     * connection, and a target that could be configured to write in the clear
     * is a target that eventually does. The Samba container the integration
     * tests run against refuses even an ordinary bind without TLS.
     */
    tlsMode: ldapTlsModeSchema.exclude(['plain']),
    rejectUnauthorized: z.boolean().default(true),
    bindDn: z.string().min(1),
    baseDn: z.string().min(1),
    /** Where listEntitlements enumerates groups. */
    entitlementSearchBase: z.string().min(1),
    /** Where archive_account moves the object. */
    archiveContainer: z.string().min(1),
    /**
     * Where create_account writes the tenant id and originating actionId.
     * `info` on Active Directory, or a nominated extensionAttribute.
     */
    provenanceAttribute: z.string().default('info'),
    /** objectGUID. Kept configurable only so a test fixture can vary it. */
    anchorAttribute: z.string().default('objectGUID'),
    accountFilter: z
      .string()
      .default('(&(objectCategory=person)(objectClass=user))'),
    groupFilter: z.string().default('(objectClass=group)'),
    /**
     * Excluded from the entitlement catalog entirely. Primary group membership
     * is not in `member` and cannot be removed by writing to it, so an attempt
     * to revoke it would be attempted and fail forever.
     */
    primaryGroupExternalIds: z.array(z.string()).default([]),
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
