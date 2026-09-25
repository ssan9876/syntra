import { z } from 'zod';

/**
 * What a target accepts as a correlation key: which characters, and how many.
 *
 * A property of the TARGET, declared here by the connector layer, rather than
 * a rule of the key generator. The generator used to apply Active Directory's
 * `sAMAccountName` rules -- `[a-z0-9.-]`, 20 characters -- to every target,
 * which was right for the directory it was written for and wrong for every
 * other one. On a Snipe-IT target the standard SSO template,
 * `%person.businessEmail%`, rendered `anna.novakcontoso.com`: the `@` was
 * folded out, the username no longer matched the SAML NameID Syntra's IdP
 * sends, and single sign-on for that target could not be set up at all.
 *
 * - `sam`   -- `[a-z0-9.-]`, the Active Directory rule, exactly as it always
 *              was. Every existing key was generated under it.
 * - `email` -- `[a-z0-9._+-]` with at most one `@`, never first or last. An
 *              email-shaped key is split at the `@`; the part before it is
 *              the local part (at most 64 characters, RFC 5321 §4.5.3.1.1) and
 *              the part after it is a domain (`[a-z0-9.-]`), which is never
 *              truncated and never receives a uniqueness suffix.
 *
 * `maxLength` bounds the WHOLE key, the domain included.
 */
export type CorrelationKeyCharset = 'sam' | 'email';

export interface CorrelationKeyPolicy {
  charset: CorrelationKeyCharset;
  maxLength: number;
}

/**
 * `sAMAccountName` is capped at 20 characters by Active Directory, must be
 * unique in the domain, and is the thing a collision actually collides on.
 */
export const SAM_ACCOUNT_NAME_MAX_LENGTH = 20;

/** RFC 5321 §4.5.3.1.1: the local part of a mailbox is at most 64 octets. */
export const EMAIL_LOCAL_PART_MAX_LENGTH = 64;

/**
 * RFC 5321 §4.5.3.1.3 caps a path at 256 octets including the two angle
 * brackets, which leaves 254 for the address itself.
 */
export const EMAIL_MAX_LENGTH = 254;

export const SAM_KEY_POLICY: CorrelationKeyPolicy = {
  charset: 'sam',
  maxLength: SAM_ACCOUNT_NAME_MAX_LENGTH,
};

export const EMAIL_KEY_POLICY: CorrelationKeyPolicy = {
  charset: 'email',
  maxLength: EMAIL_MAX_LENGTH,
};

/**
 * The `naming` block of an HTTP connector document.
 *
 * Optional, and a document that omits it gets `sam` -- NOT `email`, even
 * though `email` is the more useful rule for almost every SaaS target. The
 * two are identical for a template with no `@` in it except in two ways: the
 * `email` rule keeps `_` and `+`, and it allows 64 characters where `sam`
 * allows 20. Either changes the key a long or underscored name renders to,
 * and on a target with `renameEnabled` a changed key is a proposed rename of
 * an account that already works. A document therefore opts in; the shipped
 * Snipe-IT document does.
 */
export const httpNamingPolicy = z
  .object({
    allow: z.enum(['sam', 'email']),
    /**
     * A tighter cap than the charset's own, for a target with a shorter
     * username column. Never a looser one: the charset's cap is what the
     * rest of the chain was written against.
     */
    maxLength: z.number().int().min(1).max(EMAIL_MAX_LENGTH).optional(),
  })
  .strict();

export type HttpNamingPolicy = z.input<typeof httpNamingPolicy>;

/**
 * The key policy of one configured target.
 *
 * - **Active Directory** -- `sam`. The rule the generator was written for.
 * - **Entra ID** -- `sam`, deliberately unchanged. Its key is the LOCAL part
 *   of a userPrincipalName; `entraUserPrincipalName` appends the configured
 *   domain and `observedCorrelationKey` strips it back off for comparison. A
 *   live tenant whose profile renders `%person.businessEmail%` has every
 *   existing UPN built from the `@`-folded key, and allowing `@` here would
 *   make the next generated key a different login -- and a UPN with two `@`
 *   in it.
 * - **SCIM** -- `email`. RFC 7643 §4.1.1 `userName` is conventionally the
 *   address a SAML or OIDC login asserts.
 * - **HTTP documents** -- whatever the document's `naming` block declares,
 *   `sam` when it declares none (see `httpNamingPolicy` for why).
 *
 * A document's `maxLength` can only tighten the charset's cap.
 */
export function correlationKeyPolicyFor(targetType: string, config: unknown): CorrelationKeyPolicy {
  if (targetType === 'scim2') return EMAIL_KEY_POLICY;
  if (targetType === 'httpJson') {
    const naming = (config as { document?: { naming?: unknown } } | null)?.document?.naming;
    const parsed = httpNamingPolicy.safeParse(naming);
    if (!parsed.success) return SAM_KEY_POLICY;
    const base = parsed.data.allow === 'email' ? EMAIL_KEY_POLICY : SAM_KEY_POLICY;
    const declared = parsed.data.maxLength;
    return declared === undefined
      ? base
      : { charset: base.charset, maxLength: Math.min(declared, base.maxLength) };
  }
  return SAM_KEY_POLICY;
}
