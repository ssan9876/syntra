import { entraUserPrincipalName, first, type SourceRecord } from '@syntra/connectors';

/**
 * The attribute each connector's `read()` reports the correlation key under.
 *
 * Active Directory correlates on `sAMAccountName`; SCIM's core schema
 * reserves `userName` for exactly this purpose (RFC 7643 §4.1.1) and
 * `scimTargetConnector.read` reports it under that key. Not part of
 * `TargetConnector` because it names an attribute key in `SourceRecord`
 * rather than a network operation — the same reason `provenanceAttribute`
 * is read off the config rather than off the connector.
 */
export function correlationAttributeFor(targetType: string, config: unknown): string {
  if (targetType === 'activeDirectory') return 'sAMAccountName';
  // The native Graph connector reports the login under Graph's own name.
  if (targetType === 'entraId') return 'userPrincipalName';
  if (targetType === 'httpJson') {
    // Whatever Syntra attribute the document maps its `correlationAt` field
    // to. `toRecord` in the connector reads the correlation value from that
    // field and reports the mapped fields under their Syntra names, so this
    // is the name the value is reachable by -- when the document maps it at
    // all. A document that names `correlationAt` but does not list it under
    // `fields` reports the value nowhere but the dn, and falls through.
    const document = (
      config as {
        document?: { account?: { correlationAt?: string; fields?: Record<string, string> } };
      } | null
    )?.document;
    const at = document?.account?.correlationAt;
    const mapped = at === undefined ? undefined : document?.account?.fields?.[at];
    if (mapped !== undefined) return mapped;
  }
  return 'userName';
}

/**
 * The value of an object read from a target that is comparable with a Syntra
 * correlation key, or `''` when the object carries none.
 *
 * The ONE place an observed object is turned into a key. Every comparison of
 * target inventory against Syntra's keys -- the run's taken-key set and its
 * observed objects, the adoption candidate search, in-flight resolution --
 * goes through here, because each of them spelled `sAMAccountName` on its own
 * and every non-AD target therefore read as an inventory of nameless objects.
 *
 * Not case-folded: callers fold where they compare, as they always have, so
 * the Active Directory value is exactly the one read before this existed.
 *
 * **Entra ID.** A Syntra key never contains `@` (`names.ts` folds it out);
 * Graph reports the full `userPrincipalName`. The key becomes a UPN by
 * `entraUserPrincipalName`, which appends the configured domain, so the
 * inverse is taken here: the local part is returned ONLY when the UPN's
 * domain is the one that function would append. A user in any other domain
 * comes back as the full UPN, which cannot equal an `@`-less key -- so
 * `anna.novak@partner.example` is never mistaken for, or adopted as, the
 * account Syntra would create as `anna.novak@contoso.com`.
 */
export function observedCorrelationKey(
  targetType: string,
  config: unknown,
  record: SourceRecord,
): string {
  const value = first(record, correlationAttributeFor(targetType, config)) ?? '';
  if (targetType !== 'entraId') return value;

  const at = value.lastIndexOf('@');
  // A Graph user always has a UPN with a domain; the connector falls back to
  // the object id when the property is missing. Neither is a login.
  if (at <= 0) return '';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).trim().toLowerCase();
  const stored = (config ?? {}) as { tenantId?: unknown; userPrincipalDomain?: unknown };
  const named = entraUserPrincipalName(
    {
      tenantId: typeof stored.tenantId === 'string' ? stored.tenantId : '',
      ...(typeof stored.userPrincipalDomain === 'string'
        ? { userPrincipalDomain: stored.userPrincipalDomain }
        : {}),
    },
    // Any `@`-less key: only the domain the function completes it with is used.
    'x',
  );
  if (!('upn' in named)) return value;
  const expected = named.upn.slice(named.upn.lastIndexOf('@') + 1).trim().toLowerCase();
  return domain === expected ? local : value;
}
