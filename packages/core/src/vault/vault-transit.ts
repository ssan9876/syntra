import {
  externalMarker,
  parseMarker,
  roundTrip,
  type KeyContext,
  type MasterKeyProvider,
  type WrappedKey,
} from './master-key.js';

/**
 * How Syntra authenticates to Vault / OpenBao.
 *
 * A static token is the simple case and the one a dev server hands out.
 * AppRole is the production case: a role id that is not secret plus a secret
 * id that is, exchanged for a short-lived token that this provider renews by
 * logging in again. Neither is ever logged.
 */
export type VaultAuth =
  | { method: 'token'; token: string }
  | { method: 'approle'; roleId: string; secretId: string; mountPath: string };

export interface VaultTransitOptions {
  /** `https://vault.example.internal:8200`, no trailing path. */
  address: string;
  /** The Transit key's name. Its VERSIONS are Transit's business, not ours. */
  keyName: string;
  /** Where the Transit engine is mounted. `transit` unless somebody moved it. */
  mountPath: string;
  /** Vault Enterprise / HCP namespace, sent as `X-Vault-Namespace`. */
  namespace?: string | undefined;
  auth: VaultAuth;
  /** Per-request deadline. */
  timeoutMs: number;
  /** Replaced by the unit tests; `globalThis.fetch` otherwise. */
  fetch?: typeof fetch;
  /** Overridden by the tests only. */
  now?: () => number;
}

export const VAULT_TRANSIT = 'vault-transit';

/**
 * The tenant binding, as Transit's `associated_data`.
 *
 * AAD, not Transit's `context` parameter: `context` only means anything for a
 * DERIVED key, and requiring operators to create a derived key would be one
 * more thing to get wrong at setup. AAD is authenticated by the default
 * `aes256-gcm96` key type -- decrypting with a different tenant's AAD fails --
 * which the integration test demonstrates against a real server rather than
 * assuming.
 */
function associatedData(context: KeyContext | undefined): string | undefined {
  return context ? Buffer.from(`syntra-tenant:${context.tenantId}`, 'utf8').toString('base64') : undefined;
}

class VaultError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Strips leading and/or trailing slashes by walking the string rather than
 * with a regex: an anchored `/+` alternation is quadratic on a value made of
 * many slashes, and these values come from configuration.
 */
function trimSlashes(value: string, side: 'end' | 'both'): string {
  let start = 0;
  let end = value.length;
  if (side === 'both') while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/**
 * HashiCorp Vault / OpenBao Transit as the master key.
 *
 * The master key never leaves Vault: `wrap` sends a data key to
 * `transit/encrypt/<key>` and stores the `vault:vN:…` ciphertext that comes
 * back; `unwrap` sends that ciphertext to `transit/decrypt/<key>`.
 *
 * KEY VERSIONING is Transit's: `vault write -f transit/keys/<key>/rotate`
 * makes a new version that every subsequent `wrap` uses, while every older
 * version keeps decrypting until `min_decryption_version` is raised past it.
 * The `vN` in each stored ciphertext is the version that sealed it --
 * `rekey --status` counts rows per version, and `rekey` moves every row to
 * the latest version, after which raising `min_decryption_version` is the
 * REVOCATION of the old versions. See docs/operate.md (Runbooks).
 *
 * ACCESS LOGGING is Vault's too: every encrypt and decrypt this provider
 * makes is an authenticated request in Vault's audit device, with the token's
 * accessor and -- through the AAD -- nothing that reveals the tenant in clear
 * (AAD is HMAC'd in the audit log like every other request field). Syntra
 * does not duplicate that log; it records the administrative events.
 */
export function vaultTransitProvider(options: VaultTransitOptions): MasterKeyProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const base = trimSlashes(options.address, 'end');
  const mount = trimSlashes(options.mountPath, 'both');
  const key = encodeURIComponent(options.keyName);

  let token: string | null = options.auth.method === 'token' ? options.auth.token : null;
  let tokenExpiresAt = options.auth.method === 'token' ? Number.POSITIVE_INFINITY : 0;
  let login: Promise<string> | null = null;

  const headers = (withToken: string | null): Record<string, string> => ({
    'content-type': 'application/json',
    ...(withToken ? { 'x-vault-token': withToken } : {}),
    ...(options.namespace ? { 'x-vault-namespace': options.namespace } : {}),
  });

  async function request(path: string, body: unknown, withToken: string | null): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await doFetch(`${base}/v1/${path}`, {
        method: 'POST',
        headers: headers(withToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (cause) {
      // The address is configuration, not a secret, and naming it is what
      // makes "Vault is unreachable" actionable. The body is never included.
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new VaultError(0, `vault-transit: ${base} did not answer (${why})`);
    }
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A proxy's HTML error page; the status is what matters.
    }
    if (!response.ok) {
      // Vault's `errors` are written for operators ("permission denied",
      // "encryption key not found", "cipher: message authentication failed")
      // and never echo request fields back.
      // Collapsed to one line: Vault wraps policy refusals as a multi-line
      // "1 error occurred: <newline><tab>* permission denied", which is one
      // fact.
      const errors = (Array.isArray(parsed.errors) ? parsed.errors.join('; ') : text.slice(0, 200))
        .replace(/\s+/g, ' ')
        .trim();
      throw new VaultError(response.status, `vault-transit: ${path.split('/').slice(0, 2).join('/')} answered HTTP ${response.status}: ${errors}`);
    }
    return parsed;
  }

  async function currentToken(): Promise<string> {
    if (token && now() < tokenExpiresAt) return token;
    if (options.auth.method === 'token') return options.auth.token;
    const auth = options.auth;
    // One login in flight at a time: a burst of unwraps at startup must not
    // become a burst of AppRole logins, each minting a token.
    login ??= (async () => {
      try {
        const answer = await request(
          `auth/${trimSlashes(auth.mountPath, 'both')}/login`,
          { role_id: auth.roleId, secret_id: auth.secretId },
          null,
        );
        const result = answer.auth as { client_token?: string; lease_duration?: number } | undefined;
        if (!result?.client_token) throw new Error('vault-transit: the AppRole login returned no token');
        token = result.client_token;
        // Renewed a minute early -- or at half its life, for a token shorter
        // than two minutes -- so a request never goes out on a token that
        // expires in flight. A lease of 0 means "does not expire".
        const leaseMs = (result.lease_duration ?? 0) * 1000;
        tokenExpiresAt = leaseMs <= 0 ? Number.POSITIVE_INFINITY : now() + Math.max(leaseMs - 60_000, leaseMs / 2);
        return token;
      } finally {
        login = null;
      }
    })();
    return login;
  }

  /** One retry after a 403 with AppRole: the token may have been revoked or expired early. */
  async function authed(path: string, body: unknown): Promise<Record<string, unknown>> {
    try {
      return await request(path, body, await currentToken());
    } catch (cause) {
      if (cause instanceof VaultError && cause.status === 403 && options.auth.method === 'approle') {
        tokenExpiresAt = 0;
        return request(path, body, await currentToken());
      }
      throw cause;
    }
  }

  const provider: MasterKeyProvider = {
    name: VAULT_TRANSIT,

    async wrap(dek, context) {
      const aad = associatedData(context);
      const answer = await authed(`${mount}/encrypt/${key}`, {
        plaintext: dek.toString('base64'),
        ...(aad ? { associated_data: aad } : {}),
      });
      const ciphertext = (answer.data as { ciphertext?: string } | undefined)?.ciphertext;
      if (typeof ciphertext !== 'string' || !ciphertext.startsWith('vault:')) {
        throw new Error('vault-transit: encrypt returned no ciphertext');
      }
      return {
        ciphertext: Buffer.from(ciphertext, 'utf8'),
        iv: externalMarker(VAULT_TRANSIT, aad !== undefined),
        tag: Buffer.from(options.keyName, 'utf8'),
      };
    },

    async unwrap(wrapped: WrappedKey, context) {
      const marker = parseMarker(wrapped);
      if (marker?.provider !== VAULT_TRANSIT) {
        throw new Error('vault-transit: this data key was not wrapped by Vault Transit');
      }
      if (marker.bound && !context) {
        throw new Error('vault-transit: this data key is bound to a tenant, and none was given');
      }
      const aad = marker.bound ? associatedData(context) : undefined;
      const answer = await authed(`${mount}/decrypt/${key}`, {
        ciphertext: wrapped.ciphertext.toString('utf8'),
        ...(aad ? { associated_data: aad } : {}),
      });
      const plaintext = (answer.data as { plaintext?: string } | undefined)?.plaintext;
      if (typeof plaintext !== 'string') throw new Error('vault-transit: decrypt returned no plaintext');
      const dek = Buffer.from(plaintext, 'base64');
      if (dek.length !== 32) {
        dek.fill(0);
        throw new Error('vault-transit: decrypt returned a data key of the wrong length');
      }
      return dek;
    },

    recognizes(wrapped) {
      return parseMarker(wrapped)?.provider === VAULT_TRANSIT;
    },

    async check() {
      await roundTrip(provider);
    },
  };
  return provider;
}
