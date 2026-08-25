import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as child from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  checkForUpdate,
  fetchLatestRelease,
  isNewer,
  launchUpdater,
  readProgress,
  resetUpdateCache,
} from './update-service.js';
import * as version from '../health/version.js';

// Node's own ESM namespace for a built-in module is frozen, so `vi.spyOn`
// cannot redefine `spawn` on the real `node:child_process` -- this replaces
// it with a plain, mutable object (everything else untouched) purely so the
// spy below has something it is allowed to patch.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: actual.spawn };
});

/**
 * The comparison the whole feature rests on. Get it wrong and the console
 * offers a DOWNGRADE as an update — and gets it wrong first at version 10,
 * long after anyone is still watching for it.
 */
describe('isNewer', () => {
  it('compares ordinary versions', () => {
    expect(isNewer('1.4.1', '1.4.0')).toBe(true);
    expect(isNewer('1.4.0', '1.4.1')).toBe(false);
    expect(isNewer('1.4.0', '1.4.0')).toBe(false);
  });

  /** `'1.10.0' > '1.9.0'` is false as strings. This is that test. */
  it('orders numerically, not lexically', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.9.0', '1.10.0')).toBe(false);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.0.10', '1.0.9')).toBe(true);
  });

  it('treats a missing field as zero', () => {
    expect(isNewer('1.4', '1.4.0')).toBe(false);
    expect(isNewer('1.4.1', '1.4')).toBe(true);
  });

  /**
   * `dev` is never newer and never older. An install that is somebody's
   * working tree must be refused, not compared — the alternative is an
   * updater that overwrites uncommitted work with a release.
   */
  it('refuses to order dev against anything', () => {
    expect(isNewer('1.4.0', 'dev')).toBe(false);
    expect(isNewer('dev', '1.4.0')).toBe(false);
  });

  it('refuses anything that is not a number', () => {
    expect(isNewer('1.4.0-rc1', '1.4.0')).toBe(false);
    expect(isNewer('latest', '1.4.0')).toBe(false);
  });
});

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.5.0',
  published_at: '2026-08-24T19:02:11Z',
  body: 'Directory write-back.',
  ...over,
});

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

describe('fetchLatestRelease', () => {
  it('reads the version, notes and date', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const latest = await fetchLatestRelease('tok', 'acme/syntra', fetchImpl as never);

    expect(latest).toMatchObject({
      version: '1.5.0',
      released: '2026-08-24T19:02:11Z',
      notes: 'Directory write-back.',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('acme/syntra/releases/latest');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer tok',
    });
  });

  it('strips the v from the tag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release({ tag_name: 'v2.0.0' })));
    expect((await fetchLatestRelease('t', 'r', fetchImpl as never))?.version).toBe('2.0.0');
  });

  /**
   * A GitHub outage, a revoked token or a rate limit must not take the
   * settings page down. "We could not check" is a fine answer; a 500 because
   * a third party is unreachable is not.
   */
  it('returns null rather than throwing when the forge is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    expect(await fetchLatestRelease('t', 'r', fetchImpl as never)).toBeNull();
  });

  it('returns null on an error response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    expect(await fetchLatestRelease('t', 'r', fetchImpl as never)).toBeNull();
  });

  it('returns null for a response with no tag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ body: 'notes' }));
    expect(await fetchLatestRelease('t', 'r', fetchImpl as never)).toBeNull();
  });
});

describe('checkForUpdate', () => {
  /**
   * This repository is a checkout, so `buildInfo()` reports `dev` and the
   * answer must be a refusal with somewhere to go — not an offer to overwrite
   * it with a release.
   */
  it('refuses a working tree and says what to use instead', async () => {
    const result = await checkForUpdate({
      repo: 'acme/syntra',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: vi.fn() as never,
    });

    expect(result.updatable).toBe(false);
    expect(result.current).toBe('dev');
    expect(result.reason).toContain('deploy.sh');
    expect(result.updateAvailable).toBe(false);
  });

  it('does not call the forge for a working tree', async () => {
    const fetchImpl = vi.fn();
    await checkForUpdate({
      repo: 'r',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says so when no token is configured', async () => {
    // On a RELEASE install. In this checkout `buildInfo()` reports `dev`, and
    // the working-tree refusal above wins before the token is ever looked at —
    // so the release case has to be arranged, not assumed.
    const spy = vi.spyOn(version, 'buildInfo').mockReturnValue({
      version: '1.4.0',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
    try {
      const result = await checkForUpdate({
        repo: 'r',
        token: null,
        root: '/opt/syntra',
        readyUrl: 'http://127.0.0.1:3000/health/ready',
      });
      expect(result.updatable).toBe(false);
      expect(result.reason).toContain('token');
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The design says the check caches for an hour; nothing did. So the settings
 * page, the POST that starts an update, and every tick of the console's
 * three-second poll each made their own round trip to GitHub -- which is a
 * rate limit spent on re-learning a release list that cannot change during an
 * update, and a settings page whose load time is somebody else's uptime.
 */
describe('checkForUpdate caching', () => {
  it('asks the forge once for repeated checks', async () => {
    resetUpdateCache();
    vi.spyOn(version, 'buildInfo').mockReturnValue({
      version: '1.4.0',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release())));
    const env = {
      repo: 'acme/syntra',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await checkForUpdate(env);
    await checkForUpdate(env);
    await checkForUpdate(env);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /** A failure must not be remembered: "we could not check" for an hour after
   *  a blip is worse than checking again. */
  it('does not cache a failure', async () => {
    resetUpdateCache();
    vi.spyOn(version, 'buildInfo').mockReturnValue({
      version: '1.4.0',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const env = {
      repo: 'acme/syntra',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await checkForUpdate(env);
    await checkForUpdate(env);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('readProgress', () => {
  const withStatus = (line: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'syntra-root-'));
    mkdirSync(join(root, 'var'));
    writeFileSync(join(root, 'var', 'update.status'), line);
    return root;
  };

  it('reads the step and detail the updater wrote', () => {
    const root = withStatus('2026-08-24T19:10:00Z\tmigrating\tapplying migrations\n');
    expect(readProgress(root)).toEqual({
      at: '2026-08-24T19:10:00Z',
      step: 'migrating',
      detail: 'applying migrations',
      running: true,
    });
  });

  it('knows which steps mean the updater has stopped', () => {
    for (const [step, running] of [
      ['downloading', true],
      ['migrating', true],
      ['rolling-back', true],
      ['succeeded', false],
      ['failed', false],
      ['rolled_back', false],
    ] as const) {
      const root = withStatus(`2026-08-24T19:10:00Z\t${step}\tx\n`);
      expect(readProgress(root)?.running, step).toBe(running);
    }
  });

  /**
   * The status file lives on the far side of a restart. Its absence is the
   * ordinary state of an install that has never been updated, not an error.
   */
  it('is null when no update has ever run', () => {
    expect(readProgress(mkdtempSync(join(tmpdir(), 'syntra-empty-')))).toBeNull();
  });

  it('is null rather than a broken record for a malformed line', () => {
    expect(readProgress(withStatus('nonsense\n'))).toBeNull();
  });

  it('tolerates a status with no detail', () => {
    const root = withStatus('2026-08-24T19:10:00Z\tsucceeded\t\n');
    expect(readProgress(root)).toMatchObject({ step: 'succeeded', detail: '' });
  });
});

/**
 * The API is the one process that knows for certain what port it bound, and
 * the updater's automatic rollback hangs entirely on reaching it. Forwarding
 * only the token, the root and the repository meant a deployment with a
 * PORT of its own had every healthy release judged broken -- and then the
 * rollback judged the previous release broken too, for the same reason.
 */
describe('launchUpdater', () => {
  it('passes the readiness URL to the transient unit', () => {
    const spawn = vi.spyOn(child, 'spawn').mockReturnValue({
      unref: () => {},
      on: () => {},
    } as never);

    launchUpdater(
      {
        repo: 'acme/syntra',
        token: 'tok',
        root: '/opt/syntra',
        readyUrl: 'http://127.0.0.1:8443/health/ready',
      },
      '1.5.0',
    );

    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--setenv=SYNTRA_READY_URL=http://127.0.0.1:8443/health/ready');
  });

  /**
   * `spawn` reports a missing executable ASYNCHRONOUSLY, on the child's
   * 'error' event. With no handler that is an unhandled 'error' on an
   * EventEmitter, which in Node is a thrown exception with nothing to catch it
   * -- so a host without systemd-run took the API down, having already
   * answered 202 and written an audit event saying an update had begun.
   */
  it('records a failure instead of crashing when systemd-run is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'syntra-launch-'));
    mkdirSync(join(root, 'var'), { recursive: true });

    const handlers: Record<string, (cause: Error) => void> = {};
    vi.spyOn(child, 'spawn').mockReturnValue({
      unref: () => {},
      on: (event: string, handler: (cause: Error) => void) => {
        handlers[event] = handler;
      },
    } as never);

    launchUpdater(
      { repo: 'a/b', token: 't', root, readyUrl: 'http://127.0.0.1:3000/health/ready' },
      '1.5.0',
    );

    expect(handlers.error).toBeDefined();
    expect(() => handlers.error!(new Error('spawn systemd-run ENOENT'))).not.toThrow();

    const progress = readProgress(root);
    expect(progress?.step).toBe('failed');
    expect(progress?.running).toBe(false);
    expect(progress?.detail).toContain('systemd-run');
  });
});
