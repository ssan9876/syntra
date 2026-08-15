import { Attribute, Change, Client } from 'ldapts';

const URL = process.env.LDAP_URL ?? 'ldap://localhost:1389';
const BIND_DN = 'cn=admin,dc=acme,dc=test';
const BIND_PASSWORD = 'adminpassword';

async function client(): Promise<Client> {
  const c = new Client({ url: URL });
  await c.bind(BIND_DN, BIND_PASSWORD);
  return c;
}

/** Adds an entry for the duration of `fn`, then removes it. */
export async function withLdapEntry<T>(
  dn: string,
  attributes: Record<string, string | string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const c = await client();
  await c.add(dn, attributes);
  try {
    return await fn();
  } finally {
    await c.del(dn).catch(() => undefined);
    await c.unbind().catch(() => undefined);
  }
}

/** Moves an entry to a new parent, the way a reorganisation would. */
export async function moveLdapEntry(
  dn: string,
  newRdn: string,
  newParent: string,
): Promise<void> {
  const c = await client();
  try {
    await c.modifyDN(dn, `${newRdn},${newParent}`);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/**
 * Replaces every value of a multi-valued attribute on an entry, e.g.
 * shrinking a `groupOfNames`'s `member` list to match a directory change.
 */
export async function replaceLdapAttribute(
  dn: string,
  type: string,
  values: string[],
): Promise<void> {
  const c = await client();
  try {
    await c.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type, values }),
      }),
    );
  } finally {
    await c.unbind().catch(() => undefined);
  }
}
