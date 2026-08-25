import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildInfo } from '../health/version.js';

/**
 * What the console needs to offer an update, and how it starts one.
 *
 * This module deliberately does almost nothing. The work is in
 * `ops/syntra-update`, which runs detached, and the reason is structural: an
 * update ends in `systemctl restart syntra`, so any code path in this process
 * that performed one would be killed partway through it — after the migration
 * and before the symlink swap, which is the least recoverable state this
 * system has. So the API's whole job is to check, to launch, and to read back
 * what the detached script is doing.
 */

export interface AvailableRelease {
  version: string;
  released: string | null;
  notes: string;
  /** Migration directories this release adds. Empty means it does not migrate. */
  migrations: string[];
}

export interface UpdateAvailability {
  current: string;
  /** False for a working tree or a `deploy.sh` push: nothing to update FROM. */
  updatable: boolean;
  reason: string | null;
  latest: AvailableRelease | null;
  updateAvailable: boolean;
}

export interface UpdateProgress {
  step: string;
  detail: string;
  at: string | null;
  running: boolean;
}

/** Steps the updater is still working through. Anything else has stopped. */
const IN_FLIGHT = new Set([
  'downloading',
  'verifying',
  'unpacking',
  'installing',
  'generating',
  'backing-up',
  'migrating',
  'switching',
  'rolling-back',
  'pruning',
]);

/**
 * Strictly newer, compared field by field as numbers.
 *
 * NOT a string comparison: `'1.10.0' > '1.9.0'` is false, so a lexical
 * comparison silently offers a DOWNGRADE as an update, and does it first at
 * version 10 when nobody is expecting it any more. The updater's shell has the
 * same rule, and both are tested.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (current === 'dev' || candidate === 'dev') return false;
  const parts = (value: string) => value.split('.').map((n) => Number.parseInt(n, 10));
  const a = parts(candidate);
  const b = parts(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

interface ReleaseApi {
  tag_name?: unknown;
  published_at?: unknown;
  body?: unknown;
}

/**
 * The newest published release, as the forge reports it.
 *
 * Any failure returns null rather than throwing. A GitHub outage, a revoked
 * token or a rate limit must not take the console's settings page down with
 * it — "we could not check" is a perfectly good answer, and a page that 500s
 * because a third party is unreachable is worse than one that says so.
 */
export async function fetchLatestRelease(
  token: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableRelease | null> {
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;

    const body = (await response.json()) as ReleaseApi;
    const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
    if (tag === null) return null;

    return {
      version: tag.replace(/^v/, ''),
      released: typeof body.published_at === 'string' ? body.published_at : null,
      notes: typeof body.body === 'string' ? body.body : '',
      // What the release CONTAINS is read from the release itself once it is
      // downloaded; the API's notes are prose. Migrations are surfaced from
      // RELEASE.json after unpacking, and until then the console says
      // "unknown" rather than "none" -- claiming a release does not touch the
      // database when nobody has looked is the wrong way to be wrong.
      migrations: [],
    };
  } catch {
    return null;
  }
}

export interface UpdateEnvironment {
  /** The GitHub repository releases are published to. */
  repo: string;
  /** Read-only, single-repo, and sealed in the vault. Never logged. */
  token: string | null;
  /** Where the release layout lives. */
  root: string;
  /**
   * Where the updater should ask whether the new release works.
   *
   * Passed in rather than assumed, because THIS process is the only thing
   * that knows for certain what port it bound. The updater has a fallback --
   * it reads PORT out of shared/.env, so a rollback run by hand from a serial
   * console still works with no API alive to tell it anything -- and this is
   * the authoritative answer when there is one.
   */
  readyUrl: string;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Why this install may or may not be updated from the console.
 *
 * A working tree is refused and told to use `deploy.sh`. It is not a failure:
 * it is a developer's checkout, and an updater that overwrote one with a
 * release would take uncommitted work with it — silently, because a tarball
 * unpacks cleanly over anything.
 */
export async function checkForUpdate(
  env: UpdateEnvironment,
): Promise<UpdateAvailability> {
  const build = buildInfo();

  if (!build.isRelease) {
    return {
      current: build.version,
      updatable: false,
      reason:
        'this install is a working tree rather than a release, so there is no ' +
        'version to update from; use deploy.sh',
      latest: null,
      updateAvailable: false,
    };
  }

  if (env.token === null) {
    return {
      current: build.version,
      updatable: false,
      reason: 'no release token is configured, so new versions cannot be looked up',
      latest: null,
      updateAvailable: false,
    };
  }

  const latest = await fetchLatestRelease(env.token, env.repo, env.fetchImpl);
  return {
    current: build.version,
    updatable: true,
    reason: latest === null ? 'the release list could not be read just now' : null,
    latest,
    updateAvailable: latest !== null && isNewer(latest.version, build.version),
  };
}

/**
 * What the detached updater is doing, from the file it writes.
 *
 * Read from disk rather than held in memory for the obvious reason: the
 * process that started the update is restarted by it, so anything it
 * remembered is gone by the time the answer matters.
 */
export function readProgress(root: string): UpdateProgress | null {
  let raw: string;
  try {
    raw = readFileSync(`${root}/var/update.status`, 'utf8').trim();
  } catch {
    return null;
  }
  const [at, step, detail] = raw.split('\t');
  if (!step) return null;
  return {
    at: at ?? null,
    step,
    detail: detail ?? '',
    running: IN_FLIGHT.has(step),
  };
}

/**
 * Launches the updater in its own transient systemd unit.
 *
 * `systemd-run` rather than a child process, and this is the crux of the
 * design: a child of this process is in this process's cgroup, and
 * `systemctl restart syntra` kills the cgroup. The update would die between
 * the migration and the swap. A transient unit belongs to systemd, outlives
 * every restart it causes, and is still there to roll back when the new
 * release does not come up.
 *
 * The token is passed as a unit environment variable, never written to a file
 * and never on the command line — `--setenv` is read by systemd from this
 * process, while argv is world-readable in /proc for as long as it runs.
 */
export function launchUpdater(
  env: UpdateEnvironment,
  argument: string,
): { ok: true } | { ok: false; reason: string } {
  if (env.token === null) return { ok: false, reason: 'no release token is configured' };

  const child = spawn(
    'systemd-run',
    [
      '--unit=syntra-update',
      '--collect',
      '--quiet',
      `--setenv=SYNTRA_RELEASE_TOKEN=${env.token}`,
      `--setenv=SYNTRA_ROOT=${env.root}`,
      `--setenv=SYNTRA_RELEASE_REPO=${env.repo}`,
      `--setenv=SYNTRA_READY_URL=${env.readyUrl}`,
      `${env.root}/bin/syntra-update`,
      argument,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  // Not awaited. `systemd-run` returns as soon as the unit is queued, and
  // waiting for the UPDATE would mean waiting for our own restart.
  return { ok: true };
}
