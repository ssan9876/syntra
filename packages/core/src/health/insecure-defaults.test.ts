import { describe, expect, it } from 'vitest';
import { defaultDatabasePassword, insecureDefaults } from './insecure-defaults.js';

const config = (over: { databaseUrl?: string; superuserDatabaseUrl?: string | null; publicUrl?: string } = {}) => ({
  databaseUrl: 'postgresql://syntra_app:Xk9!long-random@postgres:5432/syntra',
  superuserDatabaseUrl: null,
  publicUrl: 'https://idm.contoso.com',
  ...over,
});

describe('defaultDatabasePassword', () => {
  it.each(['syntra', 'syntra_app', 'postgres', 'password', 'changeme'])('finds %s', (password) => {
    expect(defaultDatabasePassword(`postgresql://syntra_app:${password}@db:5432/syntra`)).toBe(password);
  });

  it('decodes a URL-encoded password before comparing', () => {
    expect(defaultDatabasePassword('postgresql://syntra_app:syntra%5Fapp@db:5432/syntra')).toBe('syntra_app');
    expect(defaultDatabasePassword('postgresql://u:%63%68%61%6E%67%65%6D%65@db/syntra')).toBe('changeme');
  });

  it('reads a password given as a query parameter, as libpq does', () => {
    expect(defaultDatabasePassword('postgresql://syntra@db:5432/syntra?password=syntra')).toBe('syntra');
  });

  it('never returns a password that is not a default', () => {
    expect(defaultDatabasePassword('postgresql://syntra_app:Syntra_App@db/syntra')).toBeNull();
    expect(defaultDatabasePassword('postgresql://syntra_app:syntra_app2@db/syntra')).toBeNull();
    expect(defaultDatabasePassword('postgresql://syntra_app:p%40ss%25word@db/syntra')).toBeNull();
    expect(defaultDatabasePassword('postgresql://syntra_app@db/syntra')).toBeNull();
  });

  it('tolerates a malformed value or none', () => {
    expect(defaultDatabasePassword('not a url')).toBeNull();
    expect(defaultDatabasePassword('postgresql://u:%E0%A4%A@db/x')).toBeNull();
    expect(defaultDatabasePassword(null)).toBeNull();
    expect(defaultDatabasePassword(undefined)).toBeNull();
  });
});

describe('insecureDefaults', () => {
  it('finds nothing in a configuration with a real password behind HTTPS', () => {
    expect(insecureDefaults(config())).toEqual([]);
  });

  it('names the variable and the default password, and says what to change', () => {
    expect(
      insecureDefaults(
        config({
          databaseUrl: 'postgresql://syntra_app:syntra_app@postgres:5432/syntra',
          superuserDatabaseUrl: 'postgresql://syntra:syntra@postgres:5432/syntra',
        }),
      ),
    ).toEqual([
      {
        kind: 'database_default_password',
        variable: 'DATABASE_URL',
        message: 'DATABASE_URL uses the password "syntra_app". Change it and update DATABASE_URL.',
      },
      {
        kind: 'database_default_password',
        variable: 'SUPERUSER_DATABASE_URL',
        message: 'SUPERUSER_DATABASE_URL uses the password "syntra". Change it and update SUPERUSER_DATABASE_URL.',
      },
    ]);
  });

  it('flags PUBLIC_URL on plain HTTP at a real address, naming scheme, host and port only', () => {
    expect(insecureDefaults(config({ publicUrl: 'http://192.168.1.10:8080/some/path?x=1' }))).toEqual([
      {
        kind: 'public_url_not_https',
        variable: 'PUBLIC_URL',
        message:
          'PUBLIC_URL is http://192.168.1.10:8080. Serve Syntra over HTTPS and set PUBLIC_URL to the https:// address.',
      },
    ]);
    expect(insecureDefaults(config({ publicUrl: 'http://idm.contoso.com' }))).toHaveLength(1);
  });

  it('leaves plain HTTP on loopback alone', () => {
    for (const publicUrl of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://acme.localhost:5173', 'http://[::1]:3000']) {
      expect(insecureDefaults(config({ publicUrl })), publicUrl).toEqual([]);
    }
  });
});
