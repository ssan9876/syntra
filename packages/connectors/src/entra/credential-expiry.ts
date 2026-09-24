import { resolveEntraConfig, type EntraTargetConfig } from './config.js';
import { graphAccessToken, graphErrorCode, graphRequest, GraphTokenError, odataLiteral } from './graph.js';

/**
 * What Microsoft Graph says about the app registration's own credentials.
 *
 * **Optional, and gated on what the app registration was granted -- never a
 * new requirement.** Reading an application object needs `Application.Read.All`
 * (or `Application.ReadWrite.OwnedBy` for an app that owns itself), which none
 * of the provisioning capabilities need. A registration without it answers 403
 * and the result is `not_permitted`: the expiry stays unknown, the inventory
 * says why, and nothing about provisioning changes. The capability matrix
 * lists it as `readCredentialExpiry` so the consent is a documented choice.
 *
 * Matching: Graph returns `hint`, the first three characters of each client
 * secret, and never the secret. The credential Syntra holds is matched on that
 * hint. More than one secret can share a hint, so an ambiguous match reports
 * the EARLIEST of the candidates -- the conservative answer for an alert --
 * and says it was ambiguous. No match at all is `unmatched`: the registration
 * is readable but none of its secrets is the one Syntra holds, which is itself
 * worth an administrator's attention (a secret already deleted at Microsoft).
 */
export type EntraCredentialExpiry =
  | {
      status: 'found';
      expiresAt: string;
      /** Other secrets and certificates on the registration, for the overlap view. */
      others: EntraRegistrationCredential[];
      ambiguous: boolean;
    }
  | { status: 'unmatched'; others: EntraRegistrationCredential[] }
  | { status: 'not_permitted'; message: string }
  | { status: 'failed'; message: string };

export interface EntraRegistrationCredential {
  type: 'secret' | 'certificate';
  /** Graph's display name, or null. Not a secret. */
  displayName: string | null;
  endDateTime: string | null;
  startDateTime: string | null;
}

interface GraphPasswordCredential {
  hint?: unknown;
  displayName?: unknown;
  endDateTime?: unknown;
  startDateTime?: unknown;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export async function discoverEntraCredentialExpiry(
  raw: EntraTargetConfig & { bindPassword: string },
): Promise<EntraCredentialExpiry> {
  let connection;
  try {
    connection = resolveEntraConfig(raw);
  } catch (cause) {
    return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
  }
  try {
    await graphAccessToken(connection);
  } catch (cause) {
    return {
      status: 'failed',
      message: cause instanceof GraphTokenError ? `credential refused: ${cause.message}` : 'the token endpoint could not be reached',
    };
  }
  try {
    const response = await graphRequest(connection, {
      method: 'GET',
      path: `/applications(appId=${odataLiteral(connection.clientId)})`,
      query: { $select: 'id,passwordCredentials,keyCredentials' },
    });
    if (response.status === 403) {
      return {
        status: 'not_permitted',
        message: 'the app registration cannot read itself; grant Application.Read.All to discover this expiry (optional)',
      };
    }
    if (response.status >= 400) {
      const code = graphErrorCode(response.body);
      return { status: 'failed', message: `Graph answered HTTP ${response.status}${code ? ` (${code})` : ''}` };
    }
    const body = (response.body ?? {}) as { passwordCredentials?: unknown; keyCredentials?: unknown };
    const secrets = (Array.isArray(body.passwordCredentials) ? body.passwordCredentials : []) as GraphPasswordCredential[];
    const certificates = (Array.isArray(body.keyCredentials) ? body.keyCredentials : []) as GraphPasswordCredential[];
    const hint = connection.clientSecret.slice(0, 3);
    const matching = secrets.filter((s) => str(s.hint) === hint && str(s.endDateTime) !== null);
    const others: EntraRegistrationCredential[] = [
      ...secrets
        .filter((s) => !matching.includes(s))
        .map((s) => ({ type: 'secret' as const, displayName: str(s.displayName), endDateTime: str(s.endDateTime), startDateTime: str(s.startDateTime) })),
      ...certificates.map((c) => ({ type: 'certificate' as const, displayName: str(c.displayName), endDateTime: str(c.endDateTime), startDateTime: str(c.startDateTime) })),
    ];
    if (matching.length === 0) return { status: 'unmatched', others };
    const earliest = matching
      .map((s) => new Date(str(s.endDateTime)!))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!earliest) return { status: 'unmatched', others };
    return { status: 'found', expiresAt: earliest.toISOString(), others, ambiguous: matching.length > 1 };
  } catch (cause) {
    return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
  }
}
