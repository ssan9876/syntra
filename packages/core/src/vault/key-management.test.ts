import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  createMasterKeyProvider,
  keyManagementWarnings,
  masterKeyProviderFor,
  parseKeyManagement,
  providersFor,
} from './key-management.js';
import { localMasterKeyProvider } from './master-key.js';

const key = () => randomBytes(32).toString('base64');

describe('parseKeyManagement', () => {
  it('defaults to the local provider, which needs MASTER_KEY', () => {
    const km = parseKeyManagement({ MASTER_KEY: key() });
    expect(km.provider).toBe('local');
    expect(km.masterKey).toHaveLength(32);
    expect(() => parseKeyManagement({})).toThrow(/MASTER_KEY: MASTER_KEY must be 32 bytes, base64 encoded \(MASTER_KEY_PROVIDER is local\)/);
  });

  it('refuses a provider it does not know, listing the ones it does', () => {
    expect(() => parseKeyManagement({ MASTER_KEY_PROVIDER: 'gcp-kms' })).toThrow(/MASTER_KEY_PROVIDER.*'local' \| 'vault-transit' \| 'aws-kms'/);
  });

  it('names every missing Vault variable at once', () => {
    let message = '';
    try {
      parseKeyManagement({ MASTER_KEY_PROVIDER: 'vault-transit' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('VAULT_ADDR is required');
    expect(message).toContain('VAULT_TRANSIT_KEY is required');
    expect(message).toContain('VAULT_TOKEN, or VAULT_ROLE_ID with VAULT_SECRET_ID');
    // MASTER_KEY is not required with an external provider.
    expect(message).not.toContain('MASTER_KEY:');
  });

  it('refuses both auth methods at once, and half an AppRole', () => {
    const base = { MASTER_KEY_PROVIDER: 'vault-transit', VAULT_ADDR: 'http://127.0.0.1:8200', VAULT_TRANSIT_KEY: 'syntra' };
    expect(() => parseKeyManagement({ ...base, VAULT_TOKEN: 't', VAULT_ROLE_ID: 'r', VAULT_SECRET_ID: 's' })).toThrow(/exactly one way/);
    expect(() => parseKeyManagement({ ...base, VAULT_ROLE_ID: 'r' })).toThrow(/needs both VAULT_ROLE_ID and VAULT_SECRET_ID/);
    const approle = parseKeyManagement({ ...base, VAULT_ROLE_ID: 'r', VAULT_SECRET_ID: 's' });
    expect(approle.provider === 'vault-transit' && approle.vault.auth).toEqual({
      method: 'approle', roleId: 'r', secretId: 's', mountPath: 'approle',
    });
  });

  it('parses an AWS KMS configuration, binding the tenant by default', () => {
    const km = parseKeyManagement({
      MASTER_KEY_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'arn:aws:kms:eu-west-2:111122223333:key/abc',
      AWS_REGION: 'eu-west-2',
    });
    expect(km.provider === 'aws-kms' && km.aws).toEqual({
      keyId: 'arn:aws:kms:eu-west-2:111122223333:key/abc',
      previousKeyId: null,
      region: 'eu-west-2',
      endpoint: null,
      bindTenant: true,
    });
    expect(km.cache).toEqual({ ttlMs: 300_000, maxEntries: 1000 });
    expect(() => parseKeyManagement({ MASTER_KEY_PROVIDER: 'aws-kms' })).toThrow(/AWS_KMS_KEY_ID is required/);
  });

  it('treats an empty variable as unset, which is what compose writes for `${MASTER_KEY:-}`', () => {
    const km = parseKeyManagement({ MASTER_KEY_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'alias/syntra', MASTER_KEY: '', AWS_REGION: '' });
    expect(km.masterKey).toBeNull();
    expect(km.provider === 'aws-kms' && km.aws.region).toBeNull();
    expect(() => parseKeyManagement({ MASTER_KEY: '' })).toThrow(/MASTER_KEY_PROVIDER is local/);
  });

  it('bounds the cache settings', () => {
    expect(() => parseKeyManagement({ MASTER_KEY: key(), MASTER_KEY_CACHE_TTL_SECONDS: '7200' })).toThrow(/MASTER_KEY_CACHE_TTL_SECONDS/);
    expect(parseKeyManagement({ MASTER_KEY: key(), MASTER_KEY_CACHE_TTL_SECONDS: '0' }).cache.ttlMs).toBe(0);
  });
});

describe('providersFor', () => {
  it('keeps MASTER_KEY as a decrypt-only fallback behind an external provider, and warns about it', () => {
    const km = parseKeyManagement({
      MASTER_KEY_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'alias/syntra',
      AWS_KMS_PREVIOUS_KEY_ID: 'alias/syntra-old',
      MASTER_KEY: key(),
      AWS_REGION: 'eu-west-2',
    });
    const { primary, fallbacks } = providersFor(km);
    expect(primary.name).toBe('aws-kms');
    expect(fallbacks.map((p) => p.name)).toEqual(['aws-kms', 'local']);
    expect(keyManagementWarnings(km).join('\n')).toMatch(/MASTER_KEY is still set alongside aws-kms/);
    expect(keyManagementWarnings(km).join('\n')).toMatch(/AWS_KMS_PREVIOUS_KEY_ID is set/);
  });

  it('rotates a local key through MASTER_KEY_PREVIOUS', async () => {
    const oldKey = key();
    const km = parseKeyManagement({ MASTER_KEY: key(), MASTER_KEY_PREVIOUS: oldKey });
    const provider = createMasterKeyProvider(km);
    const dek = randomBytes(32);
    const oldRow = await localMasterKeyProvider(Buffer.from(oldKey, 'base64')).wrap(dek);
    expect((await provider.unwrap(oldRow)).equals(dek)).toBe(true);
    expect(keyManagementWarnings(km)).toEqual([
      'MASTER_KEY_PREVIOUS is set; remove it once rekey has moved every data key to the current key.',
    ]);
  });
});

describe('loadConfig and key management', () => {
  const valid = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    PUBLIC_URL: 'http://localhost:5173',
    SESSION_SECRET: 'x'.repeat(32),
    SMTP_URL: 'smtp://localhost:1025',
  };

  it('fails at boot, naming the variable, when the provider is half configured', () => {
    expect(() => loadConfig({ ...valid, MASTER_KEY_PROVIDER: 'vault-transit', VAULT_ADDR: 'http://127.0.0.1:8200', VAULT_TOKEN: 't' })).toThrow(
      /^Invalid configuration — VAULT_TRANSIT_KEY: VAULT_TRANSIT_KEY is required/,
    );
  });

  it('starts without MASTER_KEY when an external provider holds the key', () => {
    const config = loadConfig({ ...valid, MASTER_KEY_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'alias/syntra', AWS_REGION: 'eu-west-2' });
    expect(config.masterKey).toBeNull();
    expect(config.keyManagement.provider).toBe('aws-kms');
  });

  it('shares one provider per config, so routes and scheduler share one cache', () => {
    const config = loadConfig({ ...valid, MASTER_KEY: key() });
    expect(masterKeyProviderFor(config)).toBe(masterKeyProviderFor(config));
    expect(masterKeyProviderFor(config).name).toBe('local');
  });
});
