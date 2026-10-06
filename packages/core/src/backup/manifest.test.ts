import { describe, expect, it } from 'vitest';
import { backupManifest, backupNameFor, keyFingerprint, keyVerdict, versionVerdict } from './manifest.js';

describe('backup manifest', () => {
  it('reads a manifest written by ops/syntra-backup as a scheduled backup', () => {
    const parsed = backupManifest.parse({
      createdAt: '2026-10-05T02:00:00Z',
      version: '1.20.0',
      database: 'syntra',
      tableDataSections: 147,
      bytes: 641722,
      masterKeyFingerprint: null,
    });
    expect(parsed.kind).toBe('scheduled');
  });

  it('names a backup as ops/syntra-backup does', () => {
    expect(backupNameFor(new Date('2026-10-05T02:00:00.123Z'))).toBe('syntra-20261005T020000Z');
    expect(backupNameFor(new Date('2026-10-05T02:00:00Z'), 'upload')).toBe('syntra-20261005T020000Z-upload');
  });

  // The values fingerprint_of in ops/syntra-backup prints for the same input.
  it('fingerprints the key reference exactly as ops/syntra-backup does', () => {
    expect(keyFingerprint({ MASTER_KEY_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'arn:x', MASTER_KEY: 'ignored' })).toBe(
      'sha256:7e3581c1575d7d5a06893df86c3288566879213011d54973c230d5018c14e5fc',
    );
    expect(
      keyFingerprint({ MASTER_KEY_PROVIDER: 'vault-transit', VAULT_ADDR: 'https://v:8200', VAULT_TRANSIT_KEY: 'syntra' }),
    ).toBe('sha256:75ec96d972224df9bb5dacfc043cb7e020e6e1e135bbb3fb179a2c46a99e1011');
    expect(keyFingerprint({ MASTER_KEY: 'k' })).toBe(
      'sha256:3c8536b0ba734b729ee674093ebbf56caa6481f07ccd1808ff6c59f0429d5d34',
    );
    expect(keyFingerprint({})).toBeNull();
  });

  it('never treats an unknown fingerprint as a match', () => {
    expect(keyVerdict('sha256:a', 'sha256:a')).toBe('match');
    expect(keyVerdict('sha256:a', 'sha256:b')).toBe('mismatch');
    expect(keyVerdict(null, 'sha256:a')).toBe('unknown');
  });

  it('refuses only a newer version', () => {
    expect(versionVerdict('1.20.0', '1.20.0')).toBe('ok');
    expect(versionVerdict('1.19.1', '1.20.0')).toBe('ok');
    expect(versionVerdict('1.21.0', '1.20.0')).toBe('newer');
    expect(versionVerdict('1.10.0', '1.9.0')).toBe('newer');
    expect(versionVerdict('unknown', '1.20.0')).toBe('unknown');
    expect(versionVerdict('1.20.0', 'dev')).toBe('unknown');
  });
});
