import { z } from 'zod';
import { httpNamingPolicy } from '../naming.js';

/** The shortest shared secret either end accepts. */
export { MIN_SECRET_LENGTH } from '@syntra/connector-sdk';

const configString = z.string().trim().min(1);

/**
 * A target served by a connector service the operator runs (`@syntra/connector-sdk`).
 *
 * The credential is the shared secret both ends sign with. It is stored in
 * the vault like every target's, and it never travels: requests carry an
 * HMAC of it, not the secret.
 */
export const remoteTargetConfigSchema = z.object({
  /** The service's base URL; methods are posted under it. `https://` once saved. */
  baseUrl: configString.refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'baseUrl must start with http:// or https://',
  }),
  /**
   * Whether the service places accounts in containers. Declared here, not
   * asked for, because a run reads it with no I/O; the connection test checks
   * it matches what the service says.
   */
  placesAccountsInContainers: z.boolean().default(false),
  pageSize: z.number().int().positive().max(1000).default(200),
  /** Per request. Writes that time out are retried, so keep it under the service's own limits. */
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  allowPrivateAddresses: z.boolean().default(false),
  /** What logins look like at the target. Absent: `sam`, as for a REST document without one. */
  naming: httpNamingPolicy.optional(),
});

export type RemoteTargetConfig = z.input<typeof remoteTargetConfigSchema>;
export type ResolvedRemoteTargetConfig = z.output<typeof remoteTargetConfigSchema>;
