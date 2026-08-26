/**
 * Whether this deployment's cookies carry `Secure`.
 *
 * Read off `PUBLIC_URL`, which is a validated configuration key meaning
 * exactly "where this deployment is reached". It replaces
 * `process.env.NODE_ENV === 'production'`, which three cookie definitions
 * consulted independently and which `config.ts` had no say in at all.
 *
 * That mattered in both directions. The lab deployment sets NODE_ENV NOWHERE
 * -- not in `docs/lab/systemd/syntra.service`, not in `.env.example`, not in
 * `packages/db/.env.example` -- so an instance behind TLS sent its session
 * cookie without `Secure`, and the federation binding cookie fell back to
 * `SameSite=Lax`, which `federation.ts`'s own comment says breaks every
 * cross-site federation POST. Neither produced a configuration error anywhere;
 * the first is a session token on the wire and the second is a login that
 * simply stops working.
 *
 * Unparseable answers TRUE. `loadConfig` parses PUBLIC_URL as a URL before
 * anything reaches here, so this branch means something is badly wrong -- and
 * between a cookie that does not come back and a cookie sent in the clear, the
 * broken login is the one you can see.
 */
export function cookiesAreSecure(publicUrl: string): boolean {
  try {
    return new URL(publicUrl).protocol === 'https:';
  } catch {
    return true;
  }
}
