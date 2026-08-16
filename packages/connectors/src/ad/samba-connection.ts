import { Client } from 'ldapts';

/**
 * The connection every Active Directory integration test in this plan uses.
 *
 * A plain module, deliberately, and not an export from the smoke test.
 * Importing a test file executes it, which registers its hooks and its
 * `describe` inside the importing file's collection -- so every file that
 * wanted this helper would silently re-run the smoke suite as well.
 */
export function sambaConnection(): {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
} {
  return {
    url: process.env.SAMBA_LDAPS_URL ?? 'ldaps://localhost:1637',
    bindDn: process.env.SAMBA_BIND_DN ?? 'CN=Administrator,CN=Users,DC=syntra,DC=test',
    bindPassword: process.env.SAMBA_BIND_PASSWORD ?? 'Syntra!Passw0rd',
    baseDn: process.env.SAMBA_BASE_DN ?? 'DC=syntra,DC=test',
  };
}

/**
 * A bound administrative client.
 *
 * The container's certificate is self-signed, so verification is turned off
 * deliberately and explicitly. It cannot be left at its default: with
 * verification on, every connection fails to establish at all.
 */
export async function connectAsSambaAdmin(): Promise<Client> {
  const connection = sambaConnection();
  const client = new Client({
    url: connection.url,
    tlsOptions: { rejectUnauthorized: false },
    connectTimeout: 10_000,
    timeout: 60_000,
  });
  await client.bind(connection.bindDn, connection.bindPassword);
  return client;
}

/**
 * Deletes everything under `base`, deepest first, and leaves `base` itself.
 *
 * Every integration test in this slice starts from a known-empty subtree
 * rather than from whatever the last run left. A fixture that only passes
 * against a freshly created container is a fixture that passes once.
 *
 * Deepest-first is what the length sort buys: a child's DN is always its
 * parent's DN plus an RDN and a comma, so it is always strictly longer.
 * Sorting descending by length therefore orders every child before its
 * parent, which is what the directory requires -- a non-leaf delete is
 * refused with `NotAllowedOnNonLeaf`.
 */
export async function purgeSubtree(client: Client, base: string): Promise<void> {
  const { searchEntries } = await client
    .search(base, { scope: 'sub', filter: '(objectClass=*)', attributes: ['dn'] })
    .catch(() => ({ searchEntries: [] as { dn: string }[] }));
  const deepestFirst = [...searchEntries].sort(
    (a, b) => String(b.dn).length - String(a.dn).length,
  );
  for (const entry of deepestFirst) {
    if (String(entry.dn) === base) continue;
    await client.del(String(entry.dn)).catch(() => undefined);
  }
}
