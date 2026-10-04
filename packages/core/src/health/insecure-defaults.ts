import type { Config } from '../config.js';
import { isLoopback } from '../notify/mail-check.js';

/**
 * Configuration that works and should not ship: a database password anybody
 * could guess, and a public address with no TLS in front of it.
 *
 * Neither stops the API. A lab on `http://192.168.1.10` is a supported way to
 * try Syntra, and a password is the operator's to change. What was missing is
 * anything saying so: an install was found running PostgreSQL with the dev
 * compose file's passwords, and nothing in the log or the console mentioned
 * it. This is what does, once at startup and as an incident on the Overview.
 */

/**
 * Passwords that are a default somewhere: the dev compose file's two roles
 * (`syntra`, `syntra_app`), the postgres image's documented example, and the
 * two every tutorial uses. Compared exactly; PostgreSQL passwords are
 * case-sensitive, so `Syntra` is not this list's business.
 */
export const DEFAULT_DATABASE_PASSWORDS: readonly string[] = [
  'syntra',
  'syntra_app',
  'postgres',
  'password',
  'changeme',
];

export type InsecureDefaultKind = 'database_default_password' | 'public_url_not_https';

export interface InsecureDefault {
  kind: InsecureDefaultKind;
  /** The variable to change. */
  variable: 'DATABASE_URL' | 'SUPERUSER_DATABASE_URL' | 'PUBLIC_URL';
  /** One sentence or two, for the log line and the incident. */
  message: string;
}

/**
 * The password in a PostgreSQL connection string when it is one of
 * `DEFAULT_DATABASE_PASSWORDS`, else null.
 *
 * Decoded first: `syntra%5Fapp` is `syntra_app` to libpq. A `password` query
 * parameter counts too, because libpq reads one. A password that is NOT a
 * default is never returned, so nothing that calls this can print a real one.
 */
export function defaultDatabasePassword(connectionString: string | null | undefined): string | null {
  if (!connectionString) return null;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  const candidates = [url.password, url.searchParams.get('password') ?? ''];
  for (const raw of candidates) {
    if (raw === '') continue;
    let password: string;
    try {
      password = decodeURIComponent(raw);
    } catch {
      password = raw;
    }
    if (DEFAULT_DATABASE_PASSWORDS.includes(password)) return password;
  }
  return null;
}

/** Every insecure default in this configuration, database first. Empty when there are none. */
export function insecureDefaults(
  config: Pick<Config, 'databaseUrl' | 'superuserDatabaseUrl' | 'publicUrl'>,
): InsecureDefault[] {
  const found: InsecureDefault[] = [];

  for (const [variable, value] of [
    ['DATABASE_URL', config.databaseUrl],
    ['SUPERUSER_DATABASE_URL', config.superuserDatabaseUrl],
  ] as const) {
    const password = defaultDatabasePassword(value);
    if (password !== null) {
      found.push({
        kind: 'database_default_password',
        variable,
        message: `${variable} uses the password "${password}". Change it and update ${variable}.`,
      });
    }
  }

  let site: URL | null;
  try {
    site = new URL(config.publicUrl);
  } catch {
    site = null;
  }
  if (site && site.protocol === 'http:' && !isLoopback(site.hostname)) {
    found.push({
      kind: 'public_url_not_https',
      variable: 'PUBLIC_URL',
      message: `PUBLIC_URL is ${site.protocol}//${site.host}. Serve Syntra over HTTPS and set PUBLIC_URL to the https:// address.`,
    });
  }

  return found;
}
