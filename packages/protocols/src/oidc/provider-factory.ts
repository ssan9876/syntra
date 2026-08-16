import Provider, { type Configuration } from 'oidc-provider';
import { AUTHORIZATION_CODE_TTL_SECONDS } from '@syntra/core';
import { makeAdapterFactory } from './adapter.js';
import { syntraInteractionPolicy } from './interaction-prompt.js';

export interface AccountClaims {
  accountId: string;
  claims: Record<string, unknown>;
}

export interface ProviderDeps {
  /** Reads the user and their mapped claims. Returns null if unknown. */
  findAccount(accountId: string, clientId: string | null): Promise<AccountClaims | null>;
  /** Every OIDC client this tenant has, in oidc-provider's metadata shape. */
  loadClients(): Promise<Record<string, unknown>[]>;
  /** The tenant's published JWKS: active key first, outgoing beside it. */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** Where an unresolved interaction sends the browser. */
  interactionUrl(uid: string): string;
  cookieKeys: string[];
}

const providers = new Map<string, Promise<Provider>>();

/** Drop a tenant's Provider after its clients, keys or domain change. */
export function invalidateProvider(tenantId: string): void {
  providers.delete(tenantId);
}

export function invalidateAllProviders(): void {
  providers.clear();
}

/**
 * One `Provider` per tenant, built lazily and cached.
 *
 * `new Provider(issuer, setup)` fixes the issuer at construction and asserts
 * it is a single web URI (`lib/provider.js:70-82`). Syntra serves many tenants
 * with their own hostnames, so a single shared Provider would have to publish
 * one issuer for all of them — and a relying party validates the `iss` claim
 * against the issuer it discovered, so that is not a cosmetic problem. One
 * instance per tenant is the adaptation, and the issuer handed in comes from
 * `tenantProtocolIdentity`, never from a request header.
 *
 * `clients` is loaded at construction because oidc-provider validates client
 * metadata once. Any change to a tenant's clients calls `invalidateProvider`,
 * so the next request rebuilds. That is why client administration is a write
 * that has a cache to invalidate rather than a read the provider does per
 * request.
 */
export async function providerFor(
  tenantId: string,
  issuer: string,
  deps: ProviderDeps,
): Promise<Provider> {
  const cached = providers.get(tenantId);
  if (cached) return cached;

  const built = (async () => {
    const [clients, jwks] = await Promise.all([deps.loadClients(), deps.jwks()]);

    const configuration: Configuration = {
      adapter: makeAdapterFactory(tenantId) as never,
      clients: clients as never,
      jwks: jwks as never,
      cookies: { keys: deps.cookieKeys },

      // The user store stays Syntra's. This callback is the only way
      // oidc-provider learns anything about a person.
      findAccount: async (ctx, sub) => {
        const account = await deps.findAccount(sub, ctx.oidc?.client?.clientId ?? null);
        if (!account) return undefined;
        return {
          accountId: account.accountId,
          async claims() {
            return { sub: account.accountId, ...account.claims };
          },
        };
      },

      interactions: {
        url: async (_ctx, interaction) => deps.interactionUrl(interaction.uid),
        policy: syntraInteractionPolicy(),
      },

      // PKCE for every client, not only public ones. oidc-provider's default
      // requires it when the client authenticates with 'none'
      // (lib/helpers/defaults.js:319); spec section 7 asks for the
      // authorization code flow with PKCE without qualification, and a
      // confidential client that omits it is still vulnerable to code
      // interception on a shared device.
      pkce: { required: () => true },

      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        introspection: { enabled: true },
        userinfo: { enabled: true },
        rpInitiatedLogout: {
          enabled: true,
          // Syntra's own session is ended by the logout route before
          // oidc-provider is handed control, so there is nothing to confirm.
          logoutSource: async (ctx, form) => {
            ctx.body = `<!doctype html><html><head><meta charset="utf-8"><title>Signing out</title></head><body onload="document.forms[0].submit()">${form}<noscript><button type="submit" form="op.logoutForm" name="logout" value="yes">Continue</button></noscript></body></html>`;
          },
        },
        clientCredentials: { enabled: true },
        resourceIndicators: { enabled: false },
      },

      // Consent is administrative here: an application a user is assigned is
      // one the organization has already decided they may use, and a consent
      // screen per launch is friction with no decision behind it. The grant
      // is created for whatever the client is registered for.
      loadExistingGrant: async (ctx) => {
        const grantId =
          (ctx.oidc.result?.consent as { grantId?: string } | undefined)?.grantId ??
          ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId);
        if (grantId) return ctx.oidc.provider.Grant.find(grantId);

        const grant = new ctx.oidc.provider.Grant({
          clientId: ctx.oidc.client!.clientId,
          accountId: ctx.oidc.session!.accountId,
        });
        grant.addOIDCScope(ctx.oidc.params!.scope as string);
        await grant.save();
        return grant;
      },

      // The claims a tenant mapped for an application belong in the id_token,
      // not only at /userinfo. oidc-provider's default (`conformIdTokenClaims:
      // true`) strips the id_token to `sub` alone whenever an access token is
      // issued alongside it — OIDC Core section 5.4 permits that, and it is the
      // right default for an OP whose relying parties all call /userinfo. It is
      // the wrong one here: Syntra's whole claim-mapping feature is per
      // application, and the common relying party for an internal application
      // reads the id_token and never calls /userinfo, which would leave every
      // mapping silently unreleased. `/userinfo` stays enabled, so the claims
      // are available both ways.
      conformIdTokenClaims: false,

      claims: {
        openid: ['sub'],
        email: ['email', 'email_verified'],
        profile: ['name', 'preferred_username', 'given_name', 'family_name', 'updated_at'],
      },

      // RS256 only. `none` is not an algorithm and HS256 with a client secret
      // invites the alg-confusion class of bug outright.
      enabledJWA: {
        idTokenSigningAlgValues: ['RS256'],
        userinfoSigningAlgValues: ['RS256'],
        requestObjectSigningAlgValues: ['RS256'],
      },

      ttl: {
        AccessToken: 3600,
        // The same constant `AuthorizationDecision` uses for its own lifetime.
        AuthorizationCode: AUTHORIZATION_CODE_TTL_SECONDS,
        IdToken: 3600,
        RefreshToken: 1209600,
        Interaction: 900,
        Session: 43200,
        Grant: 1209600,
      },

      rotateRefreshToken: true,
    };

    const provider = new Provider(issuer, configuration);
    // Behind a TLS-terminating proxy the raw request looks like HTTP. Fastify
    // is already told what to trust via TRUST_PROXY; this tells Koa the same
    // thing, or every cookie oidc-provider sets is dropped as insecure.
    provider.proxy = true;
    return provider;
  })();

  providers.set(tenantId, built);
  try {
    return await built;
  } catch (error) {
    // A failed build must not be cached, or one bad client configuration
    // takes the tenant's OIDC offline until a restart.
    providers.delete(tenantId);
    throw error;
  }
}
