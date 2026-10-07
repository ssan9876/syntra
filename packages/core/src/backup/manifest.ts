import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * What a backup says about itself, in `manifest.json` beside `database.dump`.
 *
 * The same file `ops/syntra-backup` and the Helm CronJob write, with `kind`
 * added. A manifest without `kind` is a scheduled one: that is what those two
 * tools take.
 */
export const BACKUP_KINDS = ['scheduled', 'manual', 'uploaded', 'pre-restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const backupManifest = z.object({
  createdAt: z.string(),
  version: z.string().default('unknown'),
  database: z.string().optional(),
  tableDataSections: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  masterKeyFingerprint: z.string().nullable(),
  kind: z.enum(BACKUP_KINDS).default('scheduled'),
  /** When a restore test last restored it into a scratch database, and what arrived. */
  verifiedAt: z.string().optional(),
  verifiedTables: z.number().int().nonnegative().optional(),
  verifiedRows: z.number().int().nonnegative().optional(),
});
export type BackupManifest = z.infer<typeof backupManifest>;

/** `syntra-20261005T020000Z`, and nothing else, so a name is safe in a path. */
export const BACKUP_NAME = /^syntra-\d{8}T\d{6}Z(?:-[a-z-]+)?$/;

/** A backup's name for an instant, as `ops/syntra-backup` names one. */
export function backupNameFor(at: Date, suffix?: string): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return suffix ? `syntra-${stamp}-${suffix}` : `syntra-${stamp}`;
}

/** The fixed salt in `ops/syntra-backup`. Changing it breaks every comparison. */
const FINGERPRINT_SALT = 'syntra-backup-fingerprint-v1';

/**
 * Which key a backup's secrets are sealed under, as a salted SHA-256 -- the
 * same value `ops/syntra-backup` and the Helm CronJob record.
 *
 * With Vault Transit or AWS KMS, the key REFERENCE is fingerprinted, not the
 * decrypt-only MASTER_KEY a migration leaves behind: what decides whether a
 * backup's data keys unwrap is which external key sealed them. Null when no
 * key could be read; null never matches anything.
 */
export function keyFingerprint(env: Record<string, string | undefined>): string | null {
  const value = (name: string) => env[name]?.trim() ?? '';
  let reference: string;
  switch (value('MASTER_KEY_PROVIDER') || 'local') {
    case 'vault-transit':
      reference = `vault-transit:${value('VAULT_ADDR')}:${value('VAULT_TRANSIT_MOUNT') || 'transit'}:${value('VAULT_TRANSIT_KEY')}`;
      break;
    case 'aws-kms':
      reference = `aws-kms:${value('AWS_KMS_KEY_ID')}`;
      break;
    default:
      reference = value('MASTER_KEY');
  }
  if (!reference) return null;
  return `sha256:${createHash('sha256').update(FINGERPRINT_SALT + reference).digest('hex')}`;
}

/** Whether a backup can be restored under the running key: unknown never matches. */
export function keyVerdict(backup: string | null, running: string | null): 'match' | 'mismatch' | 'unknown' {
  if (!backup || !running) return 'unknown';
  return backup === running ? 'match' : 'mismatch';
}

/**
 * Whether a backup taken on `backup` restores under `running`, as
 * `restore_version_verdict` in `ops/syntra-backup` decides it.
 */
export function versionVerdict(backup: string, running: string): 'ok' | 'newer' | 'unknown' {
  const known = (v: string) => /^\d+(\.\d+)*$/.test(v);
  if (!known(backup) || !known(running)) return 'unknown';
  const a = backup.split('.').map(Number);
  const b = running.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 'newer' : 'ok';
  }
  return 'ok';
}
