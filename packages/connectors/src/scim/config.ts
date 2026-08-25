import { z } from 'zod';

/**
 * A configured URL or bearer token: trimmed, refused blank. Same reasoning as
 * `directoryString` in `ad/config.ts` — a padded value is invisible in a form
 * and compared exactly everywhere it is used.
 */
const configString = z.string().trim().min(1);

export const scim2TargetConfigSchema = z.object({
  /** Scheme + host, no trailing slash — e.g. `https://api.example.com/scim/v2`. */
  baseUrl: configString.refine(
    (v) => v.startsWith('http://') || v.startsWith('https://'),
    { message: 'baseUrl must start with http:// or https://' },
  ),
  /** RFC 7644 §3.2: the path segment under `baseUrl` for User resources. */
  userResourcePath: configString.default('/Users'),
  /** RFC 7644 §3.2: the path segment under `baseUrl` for Group resources. */
  groupResourcePath: configString.default('/Groups'),
  pageSize: z.number().int().positive().max(1000).default(200),
  connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /**
   * Whether this deployment may be reached at a private address. Mirrors
   * `GuardedFetchOptions.allowPrivateAddresses`; default false, same as every
   * other outbound-guarded call in this codebase (`ad/config.ts` has no
   * equivalent because LDAP does not go through `guardedFetch`).
   */
  allowPrivateAddresses: z.boolean().default(false),
});

export type Scim2TargetConfig = z.input<typeof scim2TargetConfigSchema>;
export type ResolvedScim2TargetConfig = z.output<typeof scim2TargetConfigSchema>;
