/**
 * Assembling and taking apart distinguished names.
 *
 * Here rather than in `ad/connector.ts` because two things need them and only
 * one of them may import a connector: `@syntra/connectors/testing`'s
 * `FakeTarget` models a directory and has to split a DN the way a directory
 * does, and a fake that reaches into production code to do it drags `ldapts`
 * and a live connector into every test that touches it. This module imports
 * nothing.
 */

/**
 * Escapes one RDN *value* for a distinguished name, per RFC 4514.
 *
 * The same argument as `escapeFilterValue`, and the same ruling behind it
 * (P22): a correlation key today is `[a-z0-9.-]`, but that is enforced by a
 * generator in another package and by nothing at this boundary. Assembling
 * `CN=${key},${baseDn}` out of an unescaped value is a DN injection -- a key
 * of `x,OU=Domain Controllers` renders a VALID distinguished name naming a
 * container nobody chose -- and the escape belongs where the DN is assembled,
 * not where the value happened to come from.
 *
 * Deliberately a local copy rather than an import of `@syntra/core`'s
 * `escapeDnValue`: this package sits *below* core in the dependency graph and
 * must not depend on it.
 */
export function escapeDnValue(value: string): string {
  const escaped = [...value]
    .map((character) => {
      if (character === '\0') return '\\00';
      if (',+"\\<>;='.includes(character)) return `\\${character}`;
      return character;
    })
    .join('');
  // A leading `#` or space, or a trailing space, is significant in a DN and
  // has to be escaped even though the character itself is ordinary.
  return escaped.replace(/^([#\s])/, '\\$1').replace(/(\s)$/, '\\$1');
}

/**
 * Escapes a value for an LDAP filter, per RFC 4515.
 *
 * Here rather than in `ad/connector.ts` for the reason this module exists:
 * it imports nothing, and `anchor.ts` needs this too. A second copy would be
 * a second place for an escape to be got subtly wrong.
 *
 * The correlation key reaching `findByCorrelationKey` is produced by
 * `generateCorrelationKey`, whose `[a-z0-9.-]` allow-list already makes an
 * injection impossible today -- but that is a property of a function in
 * another package, enforced by nobody at this boundary. A connector that
 * builds a filter must not depend on a caller two packages away staying
 * careful.
 */
export function escapeFilterValue(value: string): string {
  return [...value]
    .map((character) => {
      switch (character) {
        case '\\':
          return '\\5c';
        case '*':
          return '\\2a';
        case '(':
          return '\\28';
        case ')':
          return '\\29';
        case '\0':
          return '\\00';
        default:
          return character;
      }
    })
    .join('');
}

/**
 * Splits a DN into its first RDN and the container that holds it.
 *
 * `dn.indexOf(',')` is wrong here and the failure is silent:
 * `CN=Novak\, Anna,OU=X` -- an entirely ordinary Active Directory account, and
 * one Provision meets because it correlates accounts administrators created by
 * hand -- splits at the *escaped* comma and yields the RDN `CN=Novak\`.
 * Archiving that person would then call `modifyDN` with
 * `CN=Novak\,OU=Archive,DC=...`, which names a different object in a different
 * place.
 */
export function splitDn(dn: string): { rdn: string; parent: string } {
  for (let index = 0; index < dn.length; index += 1) {
    if (dn[index] === '\\') {
      index += 1;
      continue;
    }
    if (dn[index] === ',') {
      return { rdn: dn.slice(0, index), parent: dn.slice(index + 1) };
    }
  }
  return { rdn: dn, parent: '' };
}
