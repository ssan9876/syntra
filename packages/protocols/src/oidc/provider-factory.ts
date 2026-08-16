import Provider, { type Configuration } from 'oidc-provider';
import { AUTHORIZATION_CODE_TTL_SECONDS } from '@syntra/core';
import { makeAdapterFactory } from './adapter.js';
import { syntraInteractionPolicy } from './interaction-prompt.js';

export interface AccountClaims {
  accountId: string;
  claims: Record<string, unknown>;
}

/**
 * A client's own token lifetimes, carried alongside its metadata.
 *
 * Not `extraClientMetadata`: oidc-provider would then validate and republish
 * these as client metadata, and they are Syntra's settings about a client
 * rather than the client's own. `providerFor` lifts the key off before the
 * metadata reaches the library, and keeps the map for the `ttl` functions
 * below to read by client id. The provider is rebuilt whenever a tenant's
 * clients change (`invalidateProvider`), so the map cannot drift from the
 * `clients` array it was built beside.
 */
export interface ClientTtl {
  /** Seconds. Also the lifetime of a client-credentials token. */
  accessToken: number;
  /** Seconds. `0` means this client is issued no refresh tokens at all. */
  refreshToken: number;
}

/** One client's metadata, plus the lifetimes oidc-provider must not see. */
export type SyntraClientMetadata = Record<string, unknown> & {
  client_id: string;
  syntraTtl?: ClientTtl;
};

export interface ProviderDeps {
  /** Reads the user and their mapped claims. Returns null if unknown. */
  findAccount(accountId: string, clientId: string | null): Promise<AccountClaims | null>;
  /** Every OIDC client this tenant has, in oidc-provider's metadata shape. */
  loadClients(): Promise<SyntraClientMetadata[]>;
  /** The tenant's published JWKS: active key first, outgoing beside it. */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** Where an unresolved interaction sends the browser. */
  interactionUrl(uid: string): string;
  cookieKeys: string[];
}

/**
 * What a client with no lifetimes of its own gets. Both were the tenant-wide
 * constants in the `ttl` block before per-client lifetimes were honoured, so
 * an existing deployment's behaviour is unchanged for any client that never
 * had one set.
 */
const DEFAULT_TTL: ClientTtl = { accessToken: 3600, refreshToken: 1_209_600 };

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
    const [loaded, jwks] = await Promise.all([deps.loadClients(), deps.jwks()]);

    // Split before oidc-provider sees anything. `syntraTtl` is Syntra's, and
    // the library rejects metadata it does not recognise.
    const ttls = new Map<string, ClientTtl>();
    const clients = loaded.map(({ syntraTtl, ...metadata }) => {
      if (syntraTtl) ttls.set(metadata.client_id, syntraTtl);
      return metadata;
    });

    // oidc-provider only recognises a scope a client requests if it appears
    // in `configuration.scopes` — `openid`, `email` and `profile` arrive there
    // for free because `collectScopes` derives them from the `claims` object
    // below, but a scope with no matching claims block (an application
    // resource scope like `reports.read`, the shape a client-credentials
    // client uses) never would be, and every client that registered one would
    // fail client-metadata validation with "scope must only contain
    // Authorization Server supported scope values" — not at startup, but the
    // first time that client authenticates, which is a confusing place to
    // discover a registration mistake. Syntra's own `OidcClient.scopes` has no
    // fixed vocabulary (see `oidc-client-service.ts`), so every scope any
    // client in this tenant is actually registered for is unioned in here,
    // alongside the standard baseline oidc-provider ships as its default.
    /**
     * A client's lifetimes, falling back to the tenant-wide defaults.
     *
     * `client` can be undefined in oidc-provider's own type for some token
     * kinds, and a missing entry means a client registered before this existed
     * or one oidc-provider synthesised, so the fallback is not decorative.
     */
    const clientTtl = (client: { clientId?: string } | undefined): ClientTtl =>
      (client?.clientId !== undefined ? ttls.get(client.clientId) : undefined) ??
      DEFAULT_TTL;

    const scopes = new Set(['openid', 'offline_access']);
    for (const client of clients as { scope?: string }[]) {
      for (const scope of (client.scope ?? '').split(' ').filter((s) => s !== '')) {
        scopes.add(scope);
      }
    }

    const configuration: Configuration = {
      adapter: makeAdapterFactory(tenantId) as never,
      clients: clients as never,
      jwks: jwks as never,
      cookies: { keys: deps.cookieKeys },
      scopes: [...scopes],

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

      // A refresh token is issued when the client asked for offline_access and
      // is registered for the grant — the standard's rule, stated explicitly
      // rather than left to a default that has changed between versions.
      issueRefreshToken: async (_ctx, client, code) =>
        client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),

      // Syntra's own paths. `end_session` is answered by
      // `registerOidcLogoutRoutes` first — it ends the Syntra session — and
      // then handed on to oidc-provider.
      routes: { end_session: '/session/end', userinfo: '/me' },

      // RS256 only. `none` is not an algorithm and HS256 with a client secret
      // invites the alg-confusion class of bug outright.
      enabledJWA: {
        idTokenSigningAlgValues: ['RS256'],
        userinfoSigningAlgValues: ['RS256'],
        requestObjectSigningAlgValues: ['RS256'],
      },

      // Per client where the administrator set one, per tenant otherwise.
      //
      // These were columns on `OidcClient`, validated by the contract, stored,
      // and returned by `GET` -- and read by nothing. An administrator setting
      // `accessTokenTtlSeconds: 3600` was answered 200, saw it echoed back,
      // and got tokens on the library's default. That is the shape ruling
      // A2-10 was made about: a setting made inert by a later layer.
      //
      // `ClientCredentials` had no entry at all, so machine tokens ran on
      // oidc-provider's default and the library said so at every boot:
      // "default ttl.ClientCredentials function called, you SHOULD change it".
      // A machine token's lifetime is the client's access-token lifetime;
      // there is no second setting for it and inventing one would be a third
      // number an administrator has to keep in step.
      ttl: {
        AccessToken: (_ctx, _token, client) => clientTtl(client).accessToken,
        ClientCredentials: (_ctx, _token, client) => clientTtl(client).accessToken,
        // The same constant `AuthorizationDecision` uses for its own lifetime.
        AuthorizationCode: AUTHORIZATION_CODE_TTL_SECONDS,
        IdToken: 3600,
        // Never zero: a client whose refresh lifetime is 0 is not registered
        // for the grant at all (see `loadClients`), so nothing reaches here
        // asking for a token that expires the instant it is minted.
        RefreshToken: (_ctx, _token, client) =>
          clientTtl(client).refreshToken || DEFAULT_TTL.refreshToken,
        Interaction: 900,
        Session: 43200,
        Grant: 1209600,
      },

      // Rotate on every use, not on oidc-provider's default 70%-of-lifetime
      // heuristic. Rotation is what makes a leaked refresh token detectable:
      // the legitimate client and the attacker both present the same token,
      // the second presentation is a replay, and oidc-provider revokes the
      // whole grant. A token that is not rotated is a bearer credential valid
      // for two weeks with no way to notice it was copied.
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
