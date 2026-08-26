import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '@syntra/db';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { putSecret } from '../vault/vault-service.js';
import { readiness, redactReport, type Probe, type ReadinessReport } from './readiness.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 23));
let tenantId: string;
let webRoot: string;

/** A directory that looks like a built console. */
function builtConsole(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syntra-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  return dir;
}

const deps = (over: Partial<Parameters<typeof readiness>[0]> = {}) => ({
  provider,
  webRoot,
  version: '1.4.0',
  ...over,
});

const probe = (report: Awaited<ReturnType<typeof readiness>>, name: string) =>
  report.probes.find((p) => p.name === name)!;

beforeEach(async () => {
  await resetDatabase();
  webRoot = builtConsole();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

afterEach(() => vi.restoreAllMocks());

describe('readiness', () => {
  it('is ready when everything it checks is true', async () => {
    const report = await readiness(deps());
    expect(report.ready).toBe(true);
    expect(report.version).toBe('1.4.0');
    expect(probe(report, 'database').status).toBe('pass');
    expect(probe(report, 'migrations').status).toBe('pass');
    expect(probe(report, 'web').status).toBe('pass');
  });

  /**
   * The whole point of this module. `/health` returns 200 in every situation
   * below; if any of these passed here too, the updater's automatic rollback
   * would report a broken release as a good one.
   */
  describe('the failures a bad update actually produces', () => {
    it('fails when the schema is behind the code', async () => {
      vi.spyOn(db, 'migrationState').mockResolvedValue({
        ok: false,
        applied: 41,
        pending: ['20260824020657_directory_writeback'],
        failed: [],
        unknown: [],
      });

      const report = await readiness(deps());

      expect(report.ready).toBe(false);
      expect(probe(report, 'migrations').status).toBe('fail');
      // NAMED. An operator at three in the morning should not have to go
      // looking for which migration.
      expect(probe(report, 'migrations').detail).toContain('directory_writeback');
    });

    /**
     * Worse than pending: a pending migration has not run, while a failed one
     * ran PARTLY and left tables in a state no migration describes.
     */
    it('fails when a migration started and did not finish', async () => {
      vi.spyOn(db, 'migrationState').mockResolvedValue({
        ok: false,
        applied: 40,
        pending: [],
        failed: ['20260824020657_directory_writeback'],
        unknown: [],
      });

      const report = await readiness(deps());
      expect(report.ready).toBe(false);
      expect(probe(report, 'migrations').detail).toMatch(/did not finish/i);
    });

    /**
     * The release whose web bundle never got built. Every API route answers
     * perfectly and the browser gets nothing at all.
     */
    it('fails when the console bundle is missing', async () => {
      const report = await readiness(deps({ webRoot: mkdtempSync(join(tmpdir(), 'empty-')) }));
      expect(report.ready).toBe(false);
      expect(probe(report, 'web').status).toBe('fail');
    });

    /**
     * A wrong master key leaves password sign-in working and every SAML and
     * OIDC login broken, because the signing key is sealed and will not
     * decrypt. Nothing complains until the applications do.
     */
    it('fails when the master key no longer unseals stored secrets', async () => {
      await withTenant(tenantId, async (tx) => {
        await putSecret(tx, provider, 'signing.test', 'PEM');
        await tx.signingKey.create({
          data: {
            tenantId,
            kind: 'saml',
            kid: 'k1',
            status: 'active',
            secretName: 'signing.test',
            publicJwk: {},
            certificate: 'cert',
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 86_400_000),
          },
        });
      });

      // A DIFFERENT key: exactly what a restored .env or a rotated secret
      // looks like to the running process.
      const wrong = localMasterKeyProvider(Buffer.alloc(32, 99));
      const report = await readiness(deps({ provider: wrong }));

      expect(report.ready).toBe(false);
      expect(probe(report, 'vault').status).toBe('fail');
    });

    it('fails when the database is not reachable by this process', async () => {
      // NOT vi.spyOn. `prisma` is a Proxy that materialises its methods on
      // access, and restoring a spy installed through it leaves
      // `$queryRawUnsafe` undefined — every later test in this file then
      // failed with "$queryRawUnsafe is not a function" in the database and
      // migrations probes. Swap the method by hand and put the materialised
      // original back in a finally instead.
      type RawQuery = typeof prisma.$queryRawUnsafe;
      const target = prisma as unknown as { $queryRawUnsafe: RawQuery };
      const original = prisma.$queryRawUnsafe.bind(prisma) as RawQuery;
      target.$queryRawUnsafe = (() =>
        Promise.reject(
          new Error('Connection refused\nat somewhere internal'),
        )) as unknown as RawQuery;

      try {
        const report = await readiness(deps());

        expect(report.ready).toBe(false);
        expect(probe(report, 'database').status).toBe('fail');
        // One line, not a stack: this answer is served unauthenticated.
        expect(probe(report, 'database').detail).not.toContain('\n');
      } finally {
        target.$queryRawUnsafe = original;
      }
    });
  });

  /**
   * A rollback to an older release leaves the database carrying migrations the
   * code has never heard of. That is the EXPECTED state after a rollback, and
   * a readiness check that refused it would make the rollback roll itself back.
   */
  it('stays ready when the database is newer than the code', async () => {
    vi.spyOn(db, 'migrationState').mockResolvedValue({
      ok: true,
      applied: 42,
      pending: [],
      failed: [],
      unknown: ['20260901_something_newer'],
    });

    const report = await readiness(deps());

    expect(report.ready).toBe(true);
    expect(probe(report, 'migrations').detail).toContain('newer than this build');
  });

  it('skips rather than fails what a fresh install has not got yet', async () => {
    const report = await readiness(deps({ webRoot: undefined }));
    expect(report.ready).toBe(true);
    expect(probe(report, 'vault').status).toBe('skip');
    expect(probe(report, 'web').status).toBe('skip');
  });

  /**
   * An operator restoring a broken update should learn everything that is
   * wrong in one look, not one restart at a time.
   */
  it('reports every failure at once rather than stopping at the first', async () => {
    vi.spyOn(db, 'migrationState').mockResolvedValue({
      ok: false,
      applied: 1,
      pending: ['20260824_x'],
      failed: [],
      unknown: [],
    });

    const report = await readiness(deps({ webRoot: mkdtempSync(join(tmpdir(), 'empty-')) }));

    const failed = report.probes.filter((p) => p.status === 'fail').map((p) => p.name);
    expect(failed).toContain('migrations');
    expect(failed).toContain('web');
  });

  it('never puts a secret in the report', async () => {
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'signing.test', 'SUPER-SECRET-PEM');
      await tx.signingKey.create({
        data: {
          tenantId,
          kind: 'saml',
          kid: 'k1',
          status: 'active',
          secretName: 'signing.test',
          publicJwk: {},
          certificate: 'cert',
          notBefore: new Date(),
          notAfter: new Date(Date.now() + 86_400_000),
        },
      });
    });

    const report = await readiness(deps());
    expect(JSON.stringify(report)).not.toContain('SUPER-SECRET-PEM');
  });
});

/**
 * The answer is unauthenticated, because the updater holds no session and
 * cannot get one while the thing it is checking is broken. That is the whole
 * reason the endpoint exists, and it is also why the failure DETAIL cannot go
 * on the wire: Prisma's message names the host and port it could not reach,
 * which is not something a sign-in attempt tells anybody.
 *
 * The probe NAME stays. Section 6 wants the failing probe named, and "the
 * database" is not a disclosure -- every deployment has one.
 */
describe('redactReport', () => {
  const report = (probes: Probe[]): ReadinessReport => ({
    ready: probes.every((p) => p.status !== 'fail'),
    version: '1.4.0',
    probes,
  });

  it('drops the cause of a failure and keeps the name', () => {
    const redacted = redactReport(
      report([
        {
          name: 'database',
          status: 'fail',
          detail: "not reachable: Can't reach database server at `db.internal:5432`",
        },
      ]),
    );
    expect(redacted.probes[0]!.name).toBe('database');
    expect(redacted.probes[0]!.status).toBe('fail');
    expect(redacted.probes[0]!.detail).not.toContain('5432');
    expect(redacted.probes[0]!.detail).not.toContain('db.internal');
    expect(redacted.probes[0]!.detail).toBe('this check did not pass');
  });

  it('leaves passing and skipped probes exactly as they are', () => {
    const original = report([
      { name: 'migrations', status: 'pass', detail: '31 applied' },
      { name: 'vault', status: 'skip', detail: 'no tenants yet' },
    ]);
    expect(redactReport(original)).toEqual(original);
  });

  it('keeps the readiness verdict and the version', () => {
    const redacted = redactReport(
      report([{ name: 'web', status: 'fail', detail: 'the console bundle is missing' }]),
    );
    expect(redacted.ready).toBe(false);
    expect(redacted.version).toBe('1.4.0');
  });
});

describe('a probe that never answers', () => {
  /**
   * The updater's automatic rollback hangs on this endpoint. A database that
   * accepts TCP and then stops answering -- a failed-over primary, a saturated
   * pool, a paused container -- leaves every query pending for ever, so the
   * readiness gate never resolves and the rollback that was waiting on it
   * never happens. A gate that cannot answer "no" is not a gate.
   *
   * The hand-swap, not `vi.spyOn`: `prisma` is a Proxy that materialises its
   * methods on access, and a spy restored through it leaves `$queryRawUnsafe`
   * undefined for every later test in the file -- documented above, at the
   * existing `fails when the database is not reachable` case.
   */
  it('fails the probe rather than hanging the gate', async () => {
    type RawQuery = typeof prisma.$queryRawUnsafe;
    const target = prisma as unknown as { $queryRawUnsafe: RawQuery };
    const original = prisma.$queryRawUnsafe.bind(prisma) as RawQuery;
    target.$queryRawUnsafe = (() => new Promise(() => {})) as unknown as RawQuery;

    try {
      const report = await readiness(deps({ probeTimeoutMs: 25 }));
      expect(probe(report, 'database').status).toBe('fail');
      expect(probe(report, 'database').detail).toMatch(/did not answer/i);
      expect(report.ready).toBe(false);
    } finally {
      target.$queryRawUnsafe = original;
    }
  });

  /** And the other probes still run: the report says everything at once. */
  it('still reports every other probe', async () => {
    type RawQuery = typeof prisma.$queryRawUnsafe;
    const target = prisma as unknown as { $queryRawUnsafe: RawQuery };
    const original = prisma.$queryRawUnsafe.bind(prisma) as RawQuery;
    target.$queryRawUnsafe = (() => new Promise(() => {})) as unknown as RawQuery;

    try {
      const report = await readiness(deps({ probeTimeoutMs: 25 }));
      expect(report.probes.map((p) => p.name)).toEqual([
        'database',
        'migrations',
        'vault',
        'web',
      ]);
    } finally {
      target.$queryRawUnsafe = original;
    }
  });
});
