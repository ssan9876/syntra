import { describe, expect, it } from 'vitest';
import { backupAgentToken } from '@syntra/core';
import { loadAgentConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgresql://syntra_app:secret@db:5432/syntra',
  SESSION_SECRET: 'a-session-secret-of-at-least-thirty-two-chars',
};

describe('backup agent config', () => {
  it('takes the superuser connection and defaults the rest', () => {
    const config = loadAgentConfig({ ...base, SUPERUSER_DATABASE_URL: 'postgresql://syntra:pw@db:5432/syntra' });
    expect(config).toMatchObject({
      superuserUrl: 'postgresql://syntra:pw@db:5432/syntra',
      dir: '/backups',
      port: 3100,
      intervalHours: 1,
      retention: { hourly: 48, daily: 14, weekly: 8, manual: 10 },
      pgContainer: null,
      settleMs: 20_000,
    });
    expect(config.token).toBe(backupAgentToken(base));
  });

  it('on a host install, falls back to PG_CONTAINER and the role named after the database', () => {
    const config = loadAgentConfig({ ...base, PG_CONTAINER: 'infra-postgres-1' });
    expect(config.pgContainer).toBe('infra-postgres-1');
    expect(config.superuserUrl).toBe('postgresql://syntra@db:5432/syntra');
  });

  it('refuses without a superuser connection or a container to run in', () => {
    expect(() => loadAgentConfig(base)).toThrow('SUPERUSER_DATABASE_URL is required');
  });

  it('refuses a retention that is not a whole number', () => {
    expect(() => loadAgentConfig({ ...base, SUPERUSER_DATABASE_URL: 'postgresql://s@db/syntra', BACKUP_KEEP_DAILY: 'two' })).toThrow(
      'BACKUP_KEEP_DAILY must be a whole number, not "two"',
    );
  });
});
