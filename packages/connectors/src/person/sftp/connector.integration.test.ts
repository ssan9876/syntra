import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sftpDelimitedConfigSchema } from './config.js';
import { sftpDelimitedConnector } from './connector.js';
import { HostKeyMismatchError, fetchFile } from './transport.js';

/**
 * Skipped unless a real server is up.
 *
 *   pnpm sftp:up && pnpm sftp:wait && SFTP_INTEGRATION=1 pnpm vitest run \
 *     packages/connectors/src/person/sftp/connector.integration.test.ts
 *
 * This suite exists for what a fake cannot prove. Every other property of this
 * connector is covered by unit tests against a string; host-key verification
 * can only be demonstrated by a server that presents a key, and the REFUSAL
 * can only be demonstrated by pinning a different one.
 */
const enabled = process.env.SFTP_INTEGRATION === '1';

const base = {
  host: '127.0.0.1',
  port: Number(process.env.SFTP_PORT ?? 2222),
  username: 'syntra',
  remotePath: '/export/people.csv',
};

function config(over: Record<string, unknown> = {}) {
  return {
    ...sftpDelimitedConfigSchema.parse({ ...base, ...over }),
    password: 'Syntra!Passw0rd',
  };
}

describe.skipIf(!enabled)('sftpDelimited against a real server', () => {
  // The container is on loopback, which classifyAddress blocks by default.
  const previous = process.env.OUTBOUND_ALLOW_PRIVATE;
  process.env.OUTBOUND_ALLOW_PRIVATE = 'true';

  it('reports the presented key as unknown, and the columns it read', async () => {
    const result = await sftpDelimitedConnector.test(config());
    expect(result.hostKey?.status).toBe('unknown');
    expect(result.hostKey?.fingerprint).toMatch(/^SHA256:/);
    expect(result.columns).toEqual([
      'employeeId',
      'firstName',
      'lastName',
      'hireDate',
      'dept',
    ]);
  });

  it('reads every row once the key it presented is pinned', async () => {
    const seen = await sftpDelimitedConnector.test(config());
    const pinned = config({ hostKeyFingerprint: seen.hostKey?.fingerprint });

    const rows: string[] = [];
    for await (const record of sftpDelimitedConnector.read(pinned)) {
      rows.push(record.fields.employeeId as string);
    }
    expect(rows).toEqual(['1', '2']);
  });

  /**
   * THE test. A pinned key that does not match must refuse the connection --
   * not warn, not proceed.
   */
  it('refuses to connect when the pinned key is not the one presented', async () => {
    await expect(
      fetchFile(config({ hostKeyFingerprint: 'SHA256:notthekeyyouarelookingfor' }), {
        allowPrivate: true,
        requirePinned: true,
      }),
    ).rejects.toThrow(HostKeyMismatchError);
  });

  it('refuses to read at all when no key is pinned', async () => {
    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read(config())) void _;
    }).rejects.toThrow(/no host key pinned/);
  });

  /**
   * The address check runs against a real connect, so a regression that
   * resolved the name instead of connecting to the checked address shows up
   * here rather than nowhere.
   */
  it('refuses a loopback address when private addresses are not allowed', async () => {
    process.env.OUTBOUND_ALLOW_PRIVATE = 'false';
    try {
      const result = await sftpDelimitedConnector.test(config());
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/refuses to connect to/);
    } finally {
      process.env.OUTBOUND_ALLOW_PRIVATE = 'true';
    }
  });

  /**
   * A glob must resolve to exactly one file. Picking the first of two would
   * import last week's export the week somebody left a copy behind.
   */
  it('reads a glob that matches exactly one file', async () => {
    const seen = await sftpDelimitedConnector.test(config());
    const pinned = config({
      remotePath: '/export/people*.csv',
      hostKeyFingerprint: seen.hostKey?.fingerprint,
    });

    const rows: string[] = [];
    for await (const record of sftpDelimitedConnector.read(pinned)) {
      rows.push(record.fields.employeeId as string);
    }
    expect(rows).toEqual(['1', '2']);

    process.env.OUTBOUND_ALLOW_PRIVATE = previous ?? 'true';
  });
});

/**
 * The case the unit tests can only assert indirectly, and the one that was
 * broken: `test` against an export larger than the sample.
 *
 * It used to pass its sample size as the refusing ceiling, so a connection
 * test reported failure for every real export. The committed fixture is 143
 * bytes, which is why nothing caught it -- so this writes a genuinely large
 * one into the mounted directory and takes it away again.
 */
describe.skipIf(!enabled)('sampling a file larger than the sample', () => {
  const big = resolve(process.cwd(), 'infra/sftp/big.csv');

  beforeAll(() => {
    const rows = Array.from(
      { length: 4000 },
      (_, i) => `${i},Ada,Lovelace,2026-01-05,Research`,
    );
    writeFileSync(big, `employeeId,firstName,lastName,hireDate,dept\n${rows.join('\n')}\n`);
    // Comfortably past the 64 KB sample.
    expect(statSync(big).size).toBeGreaterThan(64 * 1024);
  });

  afterAll(() => {
    rmSync(big, { force: true });
  });

  it('reports the columns rather than refusing the file', async () => {
    const seen = await sftpDelimitedConnector.test(config({ remotePath: '/export/big.csv' }));
    expect(seen.hostKey?.status).toBe('unknown');
    expect(seen.columns).toEqual([
      'employeeId',
      'firstName',
      'lastName',
      'hireDate',
      'dept',
    ]);
    // Sampled, not read whole: 4000 rows do not fit in 64 KB.
    expect(seen.recordsSampled).toBeGreaterThan(0);
    expect(seen.recordsSampled).toBeLessThan(4000);
  });

  /**
   * `read` still refuses to truncate. Sampling is for `test` alone; a short
   * read the diff could mistake for a complete one is what departs a
   * workforce.
   */
  it('still refuses to truncate a read that exceeds the ceiling', async () => {
    const seen = await sftpDelimitedConnector.test(config({ remotePath: '/export/big.csv' }));
    const pinned = config({
      remotePath: '/export/big.csv',
      hostKeyFingerprint: seen.hostKey?.fingerprint,
      maxBytes: 1024,
    });

    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read(pinned)) void _;
    }).rejects.toThrow(/larger than 1024 bytes/);
  });
});
