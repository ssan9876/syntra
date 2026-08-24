import { Client } from 'ldapts';
import { z } from 'zod';
import { ldapConfigSchema } from './config.js';

/**
 * `LdapConfig` (see config.ts) is the schema's *input* type: defaulted fields
 * (orgUnitFilter, pageSize, ...) are optional there, matching what a caller is
 * actually allowed to omit. This is the *output* type instead -- every
 * defaulted field guaranteed present -- which is what everything past
 * `normalise()` operates on.
 */
export type ResolvedLdapConfig = z.output<typeof ldapConfigSchema> & {
  bindPassword: string;
};

/**
 * Opens a connection, secures it if the config says to, and binds as whoever
 * is named.
 *
 * Here rather than inside `connector.ts` because write-back needs to bind as
 * *the user*, not as the service account, and a second copy of this would be a
 * second place for the StartTLS-before-bind ordering to be got wrong. The
 * ordering is not negotiable: the bind carries the password.
 */
export async function openBound(
  config: ResolvedLdapConfig,
  bindDn: string,
  bindPassword: string,
): Promise<Client> {
  const tlsOptions = { rejectUnauthorized: config.rejectUnauthorized };

  // ldapts treats the mere presence of `tlsOptions` (any defined key) as a
  // request for an implicit-TLS connection, independent of the URL scheme.
  // Only pass it to the constructor for `ldaps`; a `starttls` connection
  // starts out as plaintext and takes its options from startTLS() below, and
  // a `plain` one would get a TLS ClientHello thrown at a plaintext listener
  // and the socket would drop.
  const client = new Client({
    url: config.url,
    // Without these ldapts waits forever, and "forever" is reachable from
    // outside: a host that black-holes packets, or one that accepts the
    // connection and never answers the bind, holds this call -- and the
    // request handler that made it -- open until something else gives up.
    connectTimeout: config.connectTimeoutMs,
    timeout: config.timeoutMs,
    ...(config.tlsMode === 'ldaps' ? { tlsOptions } : {}),
  });
  try {
    if (config.tlsMode === 'starttls') {
      await client.startTLS(tlsOptions);
    }
    await client.bind(bindDn, bindPassword);
  } catch (cause) {
    // A rejected bind (bad credentials) throws without ldapts destroying the
    // socket underneath it -- unlike a connection-level failure (refused,
    // timed out), which the library self-cleans. Left alone, this leaves a
    // live, authenticated-at-the-TCP-level-but-not-bound socket open to the
    // server on every failed bind. unbind() tears down the socket even though
    // the client was never successfully bound.
    await client.unbind().catch(() => undefined);
    throw cause;
  }
  return client;
}

/**
 * Whether this connection protects what is sent over it.
 *
 * Read before any write-back, and the reason is narrow: a password sent over
 * `plain` is a password on the wire in cleartext. Active Directory refuses the
 * write anyway, and refusing here is not a substitute for that -- it is so
 * that the refusal happens *before* the password is transmitted rather than
 * after. A non-AD directory that accepts the write would otherwise have taken
 * it in the clear and returned success.
 */
export function isEncrypted(config: ResolvedLdapConfig): boolean {
  return config.tlsMode === 'ldaps' || config.tlsMode === 'starttls';
}
