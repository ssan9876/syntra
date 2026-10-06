import { backupAgentToken, DEFAULT_RETENTION, keyFingerprint, type RetentionPolicy } from '@syntra/core';

/**
 * The backup agent's settings, from its environment.
 *
 *   SUPERUSER_DATABASE_URL  required; a role that bypasses row-level security
 *   DATABASE_URL            required; the API's role, which owns the schema
 *   BACKUP_DIR              where backups live (default /backups)
 *   BACKUP_AGENT_PORT       default 3100
 *   BACKUP_AGENT_HOST       default 0.0.0.0; 127.0.0.1 on a host install
 *   BACKUP_AGENT_TOKEN      optional; derived from SESSION_SECRET otherwise
 *   BACKUP_INTERVAL_HOURS   hours between restore points (default 1; 0 is off)
 *   BACKUP_KEEP_HOURLY / _DAILY / _WEEKLY / _MANUAL   retention (48/14/8/10)
 *   BACKUP_PG_CONTAINER     run the client tools in this container
 *   BACKUP_COPY_COMMAND     shell command run after each backup, its directory as $1
 *   BACKUP_RESTORE_SETTLE_SECONDS  how long API processes get to see a restore start (20)
 */
export interface AgentConfig {
  superuserUrl: string;
  databaseUrl: string;
  dir: string;
  port: number;
  host: string;
  token: string;
  intervalHours: number;
  retention: RetentionPolicy;
  pgContainer: string | null;
  copyCommand: string | null;
  fingerprint: string | null;
  settleMs: number;
}

const count = (env: Record<string, string | undefined>, name: string, fallback: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, not "${raw}"`);
  return value;
};

export function loadAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const token = backupAgentToken(env);
  if (!token) throw new Error('BACKUP_AGENT_TOKEN or SESSION_SECRET is required');
  return {
    superuserUrl: required('SUPERUSER_DATABASE_URL'),
    databaseUrl: required('DATABASE_URL'),
    dir: env['BACKUP_DIR']?.trim() || '/backups',
    port: count(env, 'BACKUP_AGENT_PORT', 3100),
    host: env['BACKUP_AGENT_HOST']?.trim() || '0.0.0.0',
    token,
    intervalHours: count(env, 'BACKUP_INTERVAL_HOURS', 1),
    retention: {
      hourly: count(env, 'BACKUP_KEEP_HOURLY', DEFAULT_RETENTION.hourly),
      daily: count(env, 'BACKUP_KEEP_DAILY', DEFAULT_RETENTION.daily),
      weekly: count(env, 'BACKUP_KEEP_WEEKLY', DEFAULT_RETENTION.weekly),
      manual: count(env, 'BACKUP_KEEP_MANUAL', DEFAULT_RETENTION.manual),
    },
    pgContainer: env['BACKUP_PG_CONTAINER']?.trim() || null,
    copyCommand: env['BACKUP_COPY_COMMAND']?.trim() || null,
    fingerprint: keyFingerprint(env),
    settleMs: count(env, 'BACKUP_RESTORE_SETTLE_SECONDS', 20) * 1000,
  };
}
