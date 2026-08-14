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

  it('rejects a master key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...valid, MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/MASTER_KEY/);
  });

  it('rejects a missing database url', () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
});
