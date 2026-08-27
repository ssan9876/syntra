/**
 * The application catalog: known service providers, with the settings they
 * need already filled in.
 *
 * **What this is for, and what it is not.** Registering a SAML application by
 * hand means knowing the service provider's entity ID, its assertion consumer
 * URL, which NameID format it expects and which attribute names it insists on
 * — four values that live in a vendor documentation page and are wrong in a
 * way that produces a blank error screen at the first sign-in. Where the
 * service provider publishes SAML metadata, importing it is strictly better
 * than any catalog: it is exact, it carries the certificates, and it cannot go
 * stale. `POST /api/admin/applications/:id/saml/metadata` already does that,
 * and the console should keep offering it first.
 *
 * The catalog is for the large set of SaaS applications that publish no SP
 * metadata at all — Slack, Zoom, Google Workspace, Salesforce — where the only
 * alternative is transcription.
 *
 * **Entries are starting points, and the console says so.** Every value here
 * was correct for the vendor's documented configuration when it was written,
 * and vendors change these. An entry carries `docsUrl` so the administrator
 * can check it against the source in one click, and the copied values are the
 * application's own from the moment it is created — see `Application.catalogKey`.
 */

/**
 * A value the administrator has to supply, because it is theirs and not the
 * vendor's: a workspace subdomain, a tenant's own hostname.
 *
 * `example` is shown as the field's placeholder rather than as prose. A form
 * that has to explain what a subdomain is has already lost; one that shows
 * `acme` greyed out in the box has not.
 */
export interface CatalogVariable {
  key: string;
  label: string;
  /** Shown in the empty field. Never a real customer's name. */
  example: string;
  /** Only where the label genuinely cannot carry it. */
  hint?: string;
}

/** A claim or SAML attribute the service provider requires. */
export interface CatalogClaim {
  /** The outgoing SAML Attribute Name or OIDC claim name. */
  claimName: string;
  nameFormat?: string;
  sourceKind: 'user' | 'person' | 'contract' | 'attribute' | 'groups' | 'literal';
  sourceField?: string;
  literalValue?: string;
  releaseScope?: string;
  multiValued?: boolean;
}

export interface CatalogSaml {
  /** Templated with `{{variable}}`. */
  spEntityId: string;
  acsUrls: string[];
  nameIdFormat: string;
  /** Which mapped claim supplies the NameID. Null uses the user's email. */
  nameIdClaim?: string | null;
  sloUrl?: string;
  /**
   * Deliberately absent from most entries.
   *
   * `wantAuthnRequestsSigned` defaults to TRUE and that default is a ruling,
   * not a convenience — an unsigned AuthnRequest is something anyone can send.
   * An entry may set it false ONLY where the vendor genuinely cannot sign, and
   * where it does, the reason belongs in a comment on that entry rather than
   * here. A catalog that quietly relaxed a security default for every
   * application it touched would be the worst possible thing to put in front
   * of somebody in a hurry.
   */
  wantAuthnRequestsSigned?: boolean;
  claims: CatalogClaim[];
}

export interface CatalogOidc {
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes: string[];
  claims: CatalogClaim[];
}

export type CatalogCategory =
  | 'collaboration'
  | 'productivity'
  | 'engineering'
  | 'itsm'
  | 'security'
  | 'other';

export interface CatalogEntry {
  /** Stable. Written to `Application.catalogKey` and never renamed. */
  key: string;
  name: string;
  category: CatalogCategory;
  /** One sentence. What the application is, not what SSO is. */
  description: string;
  /** The vendor's own SSO documentation, so an entry can be checked. */
  docsUrl: string;
  /** Where the user lands from the portal tile. Templated. */
  launchUrl?: string;
  variables: CatalogVariable[];
  saml?: CatalogSaml;
  oidc?: CatalogOidc;
}

export class CatalogVariableMissingError extends Error {
  constructor(readonly variable: string) {
    super(`this application needs a value for "${variable}"`);
    this.name = 'CatalogVariableMissingError';
  }
}

/**
 * Substitutes `{{name}}` from a flat map, and refuses a hole.
 *
 * `{{…}}` rather than a third delimiter: `@syntra/connectors`' connector
 * documents already use it, and this codebase does not need a third template
 * syntax on top of that one and Provision's `%person.givenName%`. It is not
 * the connectors' renderer, and could not be — that one has a fixed
 * vocabulary of `attr.`/`anchor`/`correlationKey`, and these are arbitrary
 * per-entry names — but sharing the delimiter means an administrator who has
 * seen one recognises the other.
 *
 * A missing variable THROWS. Every one of these lands in an entity ID or an
 * assertion consumer URL, both of which are compared byte-for-byte at sign-in:
 * a half-rendered `https://.slack.com/sso/saml` is not a smaller URL, it is a
 * different one, and it would fail at the first login with nothing pointing at
 * the empty box that caused it.
 */
export function fill(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value.trim() === '') {
      throw new CatalogVariableMissingError(name);
    }
    return value.trim();
  });
}
