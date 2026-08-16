import { z } from 'zod';
import { isProtocolEndpoint } from './protocol.js';

/**
 * Every URL an administrator may register as a protocol endpoint.
 *
 * `z.string().url()` accepts `javascript:`, so it is never used alone
 * anywhere in this codebase. `isProtocolEndpoint` additionally refuses a
 * fragment and embedded credentials, both of which make an exact-match
 * allowlist ambiguous.
 */
const endpoint = z
  .string()
  .max(2048)
  .refine(isProtocolEndpoint, { message: 'Must be an http or https URL with no fragment' });

const pemCertificate = z
  .string()
  .max(16384)
  .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), {
    message: 'Must be a PEM certificate',
  });

const binding = z.enum(['HTTP-POST', 'HTTP-Redirect']);

export const samlConfigRequest = z
  .object({
    spEntityId: z.string().min(1).max(1024),
    // At least one, because an empty allowlist is a configuration that fails
    // every login later at a point nobody connects back to this form.
    acsUrls: z.array(endpoint).min(1).max(16),
    defaultAcsUrl: endpoint.nullable().default(null),
    acsBinding: binding.default('HTTP-POST'),
    nameIdFormat: z
      .string()
      .max(256)
      .default('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'),
    nameIdClaim: z.string().max(128).nullable().default(null),
    spCertificates: z.array(pemCertificate).max(8).default([]),
    /**
     * Defaults to TRUE, and the default is the whole point of ruling A2-10.
     *
     * The plan drafted this as `.default(false)`, which was written before
     * that ruling landed. It would have been inert-looking and fatal: this
     * schema fills the field in before `upsertSamlConfig` ever sees it, so the
     * service's `?? REQUIRE_SIGNED_AUTHN_REQUESTS_BY_DEFAULT` would never once
     * be consulted from the console, and the column default would never be
     * consulted either because the upsert writes every column explicitly.
     * Every service provider registered through the API would have accepted
     * unsigned AuthnRequests — the exact shape of the "a security default can
     * be inert" defect that ruling was made about.
     */
    wantAuthnRequestsSigned: z.boolean().default(true),
    encryptAssertions: z.boolean().default(false),
    encryptionCertificate: pemCertificate.nullable().default(null),
    sloUrl: endpoint.nullable().default(null),
    sloBinding: binding.default('HTTP-POST'),
    allowIdpInitiated: z.boolean().default(false),
    assertionLifetimeMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
  })
  .refine((v) => v.defaultAcsUrl === null || v.acsUrls.includes(v.defaultAcsUrl), {
    message: 'The default ACS URL must be one of the registered ones',
    path: ['defaultAcsUrl'],
  })
  .refine((v) => !v.wantAuthnRequestsSigned || v.spCertificates.length > 0, {
    message:
      'Requiring signed requests needs at least one certificate to check them against. Register the service provider’s signing certificate, or set wantAuthnRequestsSigned to false for this application.',
    path: ['spCertificates'],
  })
  .refine((v) => !v.encryptAssertions || v.encryptionCertificate !== null, {
    message: 'Encrypting assertions needs a certificate to encrypt to',
    path: ['encryptionCertificate'],
  });
export type SamlConfigRequest = z.input<typeof samlConfigRequest>;

/** The scopes a user token carries, which a machine token may never request. */
const USER_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

export const oidcClientRequest = z
  .object({
    clientId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    redirectUris: z.array(endpoint).max(16).default([]),
    postLogoutRedirectUris: z.array(endpoint).max(16).default([]),
    // `client_credentials` is deliberately absent from this enum. It is the one
    // grant that issues a token with no `authorize()` decision behind it, so it
    // is turned on by its own field below rather than by adding a string to an
    // array — see ruling A2-5 and Task 13.
    grantTypes: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .max(2)
      .default(['authorization_code', 'refresh_token']),
    clientCredentialsEnabled: z.boolean().default(false),
    scopes: z.array(z.string().max(64)).max(32).default(['openid', 'profile', 'email']),
    // Settable but not to false: spec section 7 asks for the code flow with
    // PKCE without qualification, and a client registered without it is a
    // client the provider would then have to accept without it.
    requirePkce: z.literal(true).default(true),
    tokenEndpointAuthMethod: z
      .enum(['client_secret_basic', 'client_secret_post', 'none'])
      .default('client_secret_basic'),
    idTokenSignedResponseAlg: z.literal('RS256').default('RS256'),
    /**
     * How long this client's access tokens live, in seconds. Also the lifetime
     * of a client-credentials token, which has no separate setting.
     */
    accessTokenTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
    /**
     * How long this client's refresh tokens live, in seconds.
     *
     * **`0` means this client is issued no refresh tokens at all.** The
     * `refresh_token` grant is withheld from its registration, so the
     * authorization code exchange mints none and the refresh grant itself is
     * refused — which also stops a token issued before the setting changed
     * from rotating on forever. `min(0)` was already here and an administrator
     * would reasonably read it that way; until this was implemented they were
     * answered 200, saw `0` echoed back by `GET`, and got fourteen-day
     * rotating refresh tokens.
     *
     * A client that should have refresh tokens for a shorter time gets a
     * smaller positive number; there is no "unset".
     */
    refreshTokenTtlSeconds: z.number().int().min(0).max(7_776_000).default(1_209_600),
    /**
     * Whether to mint a fresh secret.
     *
     * A boolean, not the secret itself. The plan's interface summary had this
     * as `clientSecret?: string`, which is a materially different security
     * posture: a caller-supplied secret is one an administrator can choose
     * badly, paste from a ticket, or reuse across clients, and it would arrive
     * in a request body that is logged wherever request bodies are logged.
     * The service mints 256 bits from `randomBytes` and returns them exactly
     * once. The code is what exists, and it is the safer of the two.
     */
    rotateSecret: z.boolean().default(false),
  })
  .refine((v) => v.clientCredentialsEnabled || v.grantTypes.length > 0, {
    message: 'A client needs at least one grant',
    path: ['grantTypes'],
  })
  .refine((v) => !v.grantTypes.includes('authorization_code') || v.redirectUris.length > 0, {
    message: 'A client using the authorization code flow needs a redirect URI',
    path: ['redirectUris'],
  })
  .refine(
    // A2-5 condition 3, at write time as well as at the token endpoint. A
    // machine token carrying `openid` would be presentable wherever a user
    // token is accepted, and the exemption would stop being bounded.
    (v) => !v.clientCredentialsEnabled || !v.scopes.some((s) => USER_SCOPES.includes(s as never)),
    {
      message: `A client credentials client may not be registered for ${USER_SCOPES.join(
        ', ',
      )} — that token must not be usable where a user token is`,
      path: ['scopes'],
    },
  )
  .refine((v) => !v.clientCredentialsEnabled || v.scopes.length > 0, {
    message: 'A client credentials client needs at least one scope of its own',
    path: ['scopes'],
  })
  .refine(
    // RFC 6749 section 4.4: the client credentials grant is for confidential
    // clients. Ruling A2-5 accepts the chokepoint exemption on the stated
    // ground that "the control there is the client secret" -- and a client
    // registered with `none` presents no secret, so the only thing left
    // between an anonymous caller and a bearer token is knowledge of a client
    // id. `oidc-provider` accepts the combination without complaint, so this
    // is the layer that has to refuse it, and it is refused at registration as
    // well as at the token endpoint for the same reason condition 3 is: an
    // administrator who cannot save it never has to be told later.
    (v) => !v.clientCredentialsEnabled || v.tokenEndpointAuthMethod !== 'none',
    {
      message:
        'A client credentials client must authenticate with a secret — ' +
        'a token issued to a caller that proved nothing has no control on it at all',
      path: ['tokenEndpointAuthMethod'],
    },
  );
export type OidcClientRequest = z.input<typeof oidcClientRequest>;

export const claimMappingRequest = z
  .object({
    protocol: z.enum(['saml', 'oidc']),
    claimName: z.string().min(1).max(128),
    nameFormat: z
      .string()
      .max(256)
      .default('urn:oasis:names:tc:SAML:2.0:attrname-format:basic'),
    sourceKind: z.enum(['user', 'person', 'contract', 'attribute', 'groups', 'literal']),
    sourceField: z.string().max(128).nullable().default(null),
    contractStrategy: z.enum(['primary', 'lowestSequence']).default('primary'),
    literalValue: z.string().max(1024).nullable().default(null),
    releaseScope: z.string().max(64).nullable().default(null),
    multiValued: z.boolean().default(false),
  })
  .refine((v) => v.sourceKind === 'literal' || v.sourceKind === 'groups' || v.sourceField !== null, {
    message: 'This source needs a field name',
    path: ['sourceField'],
  })
  .refine((v) => v.sourceKind !== 'literal' || v.literalValue !== null, {
    message: 'A literal mapping needs a value',
    path: ['literalValue'],
  });
export type ClaimMappingRequest = z.input<typeof claimMappingRequest>;

export const upstreamIdpRequest = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(128),
    protocol: z.enum(['saml', 'oidc']),
    enabled: z.boolean().default(true),
    issuerUrl: endpoint.nullable().default(null),
    clientId: z.string().max(256).nullable().default(null),
    clientSecret: z.string().min(1).max(1024).optional(),
    scopes: z.array(z.string().max(64)).max(32).default(['openid', 'profile', 'email']),
    idpEntityId: z.string().max(1024).nullable().default(null),
    ssoUrl: endpoint.nullable().default(null),
    idpSloUrl: endpoint.nullable().default(null),
    ssoBinding: z.enum(['HTTP-Redirect', 'HTTP-POST']).default('HTTP-Redirect'),
    idpCertificates: z.array(pemCertificate).max(8).default([]),
    wantAssertionsSigned: z.boolean().default(true),
    loginAttribute: z.string().max(128).default('preferred_username'),
    emailAttribute: z.string().max(128).default('email'),
    displayNameAttribute: z.string().max(128).default('name'),
    groupsAttribute: z.string().max(128).nullable().default(null),
    createUsers: z.boolean().default(true),
    refreshOnLogin: z.boolean().default(true),
    defaultOrgUnitId: z.string().uuid().nullable().default(null),
  })
  .refine((v) => v.protocol !== 'oidc' || (v.issuerUrl !== null && v.clientId !== null), {
    message: 'An OIDC upstream needs an issuer URL and a client id',
    path: ['issuerUrl'],
  })
  .refine((v) => v.protocol !== 'saml' || v.ssoUrl !== null, {
    message: 'A SAML upstream needs a single sign-on URL',
    path: ['ssoUrl'],
  })
  .refine((v) => v.protocol !== 'saml' || !v.wantAssertionsSigned || v.idpCertificates.length > 0, {
    message: 'Requiring signed assertions needs at least one certificate to check them against',
    path: ['idpCertificates'],
  });
export type UpstreamIdpRequest = z.input<typeof upstreamIdpRequest>;

/**
 * A metadata import, by upload or by address.
 *
 * `wantAuthnRequestsSigned` rides along because metadata cannot decide it.
 * An SP's `EntityDescriptor` says what the SP *is*, not what this tenant
 * should demand of it, and the safe default (ruling A2-10) is unsatisfiable
 * for a service provider that publishes no signing certificate. Rather than
 * silently downgrading the tenant's posture from a document somebody was
 * talked into uploading, the import refuses that combination and this field is
 * how an administrator says "yes, I know, this one does not sign".
 */
const importOptions = {
  wantAuthnRequestsSigned: z.boolean().optional(),
};

export const spMetadataImportRequest = z.union([
  z.object({ xml: z.string().min(1).max(1_048_576), ...importOptions }),
  z.object({ url: endpoint, ...importOptions }),
]);
export type SpMetadataImportRequest = z.input<typeof spMetadataImportRequest>;
