/**
 * The parent of a distinguished name: everything after the first component.
 *
 * `uid=jdoe,ou=Care,dc=acme,dc=test` → `ou=Care,dc=acme,dc=test`.
 *
 * The split has to respect escaping, which is the only reason this is a
 * function rather than an `indexOf(',')`. RFC 4514 lets a comma appear inside
 * an attribute value, escaped with a backslash, and a common name like
 * `cn=Doe\, Jo,ou=Care,dc=acme,dc=test` is not hypothetical: it is what Active
 * Directory generates by default for a person whose display name is
 * "Doe, Jo". Splitting on the first raw comma there yields
 * `Jo,ou=Care,dc=acme,dc=test`, a DN that resolves to nothing — and every
 * caller in this subsystem reads "resolves to nothing" as "this person is in
 * no organizational unit".
 *
 * Returns null for a DN with no parent — a single component, an empty string,
 * or a trailing comma — rather than an empty DN, so a caller cannot
 * accidentally look up the directory root.
 */
export function parentDn(dn: string): string | null {
  let escaped = false;
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ',') {
      const parent = dn.slice(i + 1).trim();
      return parent === '' ? null : parent;
    }
  }
  return null;
}

/**
 * Compares two DNs the way a directory does: case-insensitively, and ignoring
 * the optional space after each comma.
 *
 * The lookup this feeds is keyed on the DN a server returned for an object,
 * and probed with a DN derived from the one it returned for that object's
 * CHILD. A server is free to render those two differently — spacing after the
 * commas, or the case of the attribute types — and a lookup that misses turns
 * "this user is in Care" into "this user is in no organizational unit at all",
 * which is the one answer this subsystem must never invent.
 */
export function normaliseDn(dn: string): string {
  return dn
    .split(',')
    .map((part) => part.trim())
    .join(',')
    .toLowerCase();
}
