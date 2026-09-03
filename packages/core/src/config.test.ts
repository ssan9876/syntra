import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://syntra:syntra@localhost:5432/syntra',
  PORT: '3000',
  PUBLIC_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMTP_URL: 'smtp://localhost:1025',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.masterKey).toHaveLength(32);
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('rejects the session secret placeholder from .env.example', () => {
    expect(() =>
      loadConfig({ ...valid, SESSION_SECRET: 'change-me-at-least-32-characters-long' }),
    ).toThrow(/placeholder/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...valid, MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/MASTER_KEY/);
  });

  it('rejects a missing database url', () => {
    // The destructuring is how DATABASE_URL is REMOVED from what is passed;
    // the binding is meant to be unused. `ignoreRestSiblings` in the lint
    // config is what keeps this idiom legal.
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
});

describe('loadConfig — rate limits', () => {
  it('gives the tenant ten times the allowance one address gets', () => {
    const config = loadConfig({ ...valid, AUTH_RATE_LIMIT_MAX: '200' });
    expect(config.authRateLimitMax).toBe(200);
    // Derived rather than fixed: an end-to-end suite that raises the per-address
    // allowance is not also asking to be capped at the default per tenant.
    expect(config.authRateLimitTenantMax).toBe(2000);
  });

  it('takes an explicit tenant ceiling when one is given', () => {
    const config = loadConfig({
      ...valid,
      AUTH_RATE_LIMIT_MAX: '10',
      AUTH_RATE_LIMIT_TENANT_MAX: '40',
    });
    expect(config.authRateLimitTenantMax).toBe(40);
  });
});

describe('loadConfig — TRUST_PROXY', () => {
  it('trusts nothing when it is unset', () => {
    expect(loadConfig(valid).trustProxy).toBe(false);
  });

  it('refuses a bare true, by name', () => {
    // The one value that must never be accepted: it believes X-Forwarded-For
    // from anyone, so every client picks its own source address — which is the
    // address the policy engine's IP condition and every rate-limit key are
    // built on.
    expect(() => loadConfig({ ...valid, TRUST_PROXY: 'true' })).toThrow(
      /TRUST_PROXY must not be `true`/,
    );
  });

  it('refuses a hop count, by name, and says what to write instead', () => {
    // Fastify 5.12.1 fixed GHSA-3m5p-2c4r-xxw2 by making a hop count trust
    // NOTHING, so `1` no longer means "one proxy" -- it means the same as
    // unset. A value whose meaning reversed underneath the operator has to be
    // refused rather than carried forward silently.
    expect(() => loadConfig({ ...valid, TRUST_PROXY: '1' })).toThrow(
      /must not be a hop count/,
    );
  });

  it('refuses a hop count of zero as a hop count too, not as junk', () => {
    expect(() => loadConfig({ ...valid, TRUST_PROXY: '0' })).toThrow(
      /must not be a hop count/,
    );
  });

  it('takes a list of addresses and CIDRs', () => {
    expect(
      loadConfig({ ...valid, TRUST_PROXY: '10.0.0.0/8, 192.168.1.7' })
        .trustProxy,
    ).toBe('10.0.0.0/8,192.168.1.7');
  });

  it('refuses something that is neither', () => {
    expect(() =>
      loadConfig({ ...valid, TRUST_PROXY: 'the-load-balancer' }),
    ).toThrow(/TRUST_PROXY/);
  });
});

describe('the Govern checkpoint signer and anchor sinks', () => {
  it('accepts a deployment with no Govern signing key and says so in the parsed shape', () => {
    // A deployment with no key is not broken, and the honest default is what
    // makes `checkpointTrust` able to say `unsigned_no_signer_configured`
    // rather than pretend. What is not acceptable is the state these keys
    // remove: the integrity screen telling an operator to configure a signing
    // key while no configuration key for one exists.
    const config = loadConfig({ ...valid, GOVERN_CHECKPOINT_KEY: undefined });
    expect(config.governCheckpointKey).toBeNull();
    expect(config.governCheckpointKeyId).toBe('govern-checkpoint-1');
    expect(config.governAnchorDir).toBeNull();
    expect(config.governAnchorEmail).toBeNull();
  });

  it('REFUSES a Govern signing key of the wrong length rather than silently truncating', () => {
    expect(() =>
      loadConfig({ ...valid, GOVERN_CHECKPOINT_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/GOVERN_CHECKPOINT_KEY must be 32 bytes/);
  });

  it('parses a 32-byte key into a Buffer of exactly that length', () => {
    const config = loadConfig({
      ...valid,
      GOVERN_CHECKPOINT_KEY: Buffer.alloc(32, 7).toString('base64'),
      GOVERN_CHECKPOINT_KEY_ID: 'rotated-2',
    });
    expect(config.governCheckpointKey).toHaveLength(32);
    expect(config.governCheckpointKeyId).toBe('rotated-2');
  });
});


describe('WEB_ROOT', () => {
  it('is null when unset, which is the API-only deployment', () => {
    // `pnpm dev` and the whole test suite run this way: Vite is the origin and
    // proxies the server's prefixes here. Nothing about serving pages is
    // switched on by accident.
    expect(loadConfig({ ...valid, WEB_ROOT: undefined }).webRoot).toBeNull();
  });

  it('resolves a relative path at load rather than at use', () => {
    // The working directory when a module happens to read this is not
    // something the value should depend on — a scheduler job and a request
    // handler must not disagree about where the application lives.
    const config = loadConfig({ ...valid, WEB_ROOT: 'apps/web/dist' });
    expect(isAbsolute(config.webRoot!)).toBe(true);
    expect(config.webRoot).toBe(resolve('apps/web/dist'));
  });

  it('refuses an empty value instead of resolving it to the working directory', () => {
    // `WEB_ROOT=` in an env file is a variable somebody meant to set. Resolved,
    // it becomes the repository root and the server serves the source tree.
    expect(() => loadConfig({ ...valid, WEB_ROOT: '   ' })).toThrow(/WEB_ROOT/);
  });
});
