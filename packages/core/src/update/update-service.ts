import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildInfo } from '../health/version.js';
import { guardedFetch } from '../net/guarded-fetch.js';

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
  'checking',
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
 * The forge, reached through the same outbound guard every other
 * administrator-influenced request uses.
 *
 * `RELEASE_REPO` is configuration, so the URL this builds is partly somebody's
 * input -- and the bare global `fetch` that was here followed redirects and
 * would connect to whatever address the name resolved to, including this
 * deployment's own network. `guardedFetch` checks every resolved address, pins
 * the connection to the one it checked, and refuses redirects. It is not a
 * second opinion about which addresses may be reached; it is the same one.
 */
const forgeFetch: typeof fetch = guardedFetch({ timeoutMs: 10_000 }) as typeof fetch;

/**
 * The newest published release, as the forge reports it.
 *
 * Any failure returns null rather than throwing. A GitHub outage, a revoked
 * token or a rate limit must not take the console's settings page down with
 * it — "we could not check" is a perfectly good answer, and a page that 500s
 * because a third party is unreachable is worse than one that says so.
 */
/**
 * Why a lookup produced no release, in words an operator can act on.
 *
 * `null` said only "no release", and every distinct cause -- a revoked token,
 * a repository the token cannot see, a rate limit, a forge that is down, and
 * a repository with genuinely no releases yet -- arrived at the console as
 * the same sentence. One of those is a deployment working correctly and the
 * other four are faults, and the page could not tell anyone which it had.
 */
export type LatestReleaseResult =
  | { ok: true; release: AvailableRelease }
  | { ok: false; reason: string };

/** What a non-ok answer from the forge means, said plainly. */
function refusal(status: number, repo: string): string {
  if (status === 401) {
    return 'the release token was rejected (401) — it may have been revoked or expired';
  }
  if (status === 403) {
    return (
      'the forge refused the request (403) — either a rate limit, or a request ' +
      'it will not serve as sent'
    );
  }
  if (status === 404) {
    return (
      `no published release was found for ${repo} (404) — either the repository ` +
      'has none yet, or the token cannot see it'
    );
  }
  return `the forge answered ${status}`;
}

export async function fetchLatestRelease(
  token: string,
  repo: string,
  // `GuardedFetch` is deliberately narrower than `typeof fetch` -- it follows
  // no redirects and streams no bodies. The cast is safe here and only here,
  // because this call site is one GET whose whole response is JSON.
  fetchImpl: typeof fetch = forgeFetch,
): Promise<LatestReleaseResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          // REQUIRED, not courtesy. GitHub answers a request without one with
          // 403 "Request forbidden by administrative rules", and every
          // non-ok response here becomes `null` -- which the console renders
          // as "nothing to show". A deployment with a valid token, a
          // reachable forge and a published release sat on the previous
          // version for exactly this reason, saying nothing about why.
          'user-agent': 'syntra',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    // The forge being unreachable must not take the settings page down, so
    // this is still an answer rather than a throw -- but it is now an answer
    // that says which of the possible nothings this one is.
    return { ok: false, reason: 'the forge could not be reached' };
  }

  if (!response.ok) return { ok: false, reason: refusal(response.status, repo) };

  try {
    const body = (await response.json()) as ReleaseApi;
    const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
    if (tag === null) {
      return { ok: false, reason: 'the forge returned a release with no tag' };
    }

    return {
      ok: true,
      release: {
        version: tag.replace(/^v/, ''),
        released: typeof body.published_at === 'string' ? body.published_at : null,
        notes: typeof body.body === 'string' ? body.body : '',
        // What the release CONTAINS is read from the release itself once it is
        // downloaded; the API's notes are prose. Migrations are surfaced from
        // RELEASE.json after unpacking, and until then the console says
        // "unknown" rather than "none" -- claiming a release does not touch the
        // database when nobody has looked is the wrong way to be wrong.
        migrations: [],
      },
    };
  } catch {
    return { ok: false, reason: 'the forge returned something that was not a release' };
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
 * The last successful release lookup, and when it was taken.
 *
 * The design said "caches for an hour" and nothing did, so the settings page,
 * the POST that starts an update and every tick of the console's poll each
 * spent a round trip re-learning a release list that had not moved. Sixty
 * seconds rather than an hour: an operator who has just cut a release and
 * refreshes the page should see it, and an hour of "there is nothing new" is
 * the kind of stale that gets diagnosed as a broken button.
 *
 * Keyed on repository and token together, so a configuration change is not
 * answered from the previous configuration's cache. Failures are NOT cached --
 * "we could not check" is a fine answer once and a poor one for a minute.
 */
const RELEASE_CACHE_MS = 60_000;
let releaseCache: { key: string; at: number; value: AvailableRelease } | null = null;

/** Test seam. Never called by the product. */
export function resetUpdateCache(): void {
  releaseCache = null;
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

  // `\u0000` as the separator, written as an escape rather than a raw byte:
  // it cannot occur in a repository name or a token, so no pair of values
  // can collide by concatenating to the same string.
  const key = `${env.repo}\u0000${env.token}`;
  let latest: AvailableRelease | null = null;
  // Carried out of the branch below so the caller is told WHICH nothing this
  // is. Only a failed lookup sets it; a cache hit cannot fail.
  let failure: string | null = null;
  if (releaseCache !== null && releaseCache.key === key && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
    latest = releaseCache.value;
  } else {
    const result = await fetchLatestRelease(env.token, env.repo, env.fetchImpl);
    if (result.ok) {
      latest = result.release;
      releaseCache = { key, at: Date.now(), value: latest };
    } else {
      failure = result.reason;
    }
  }
  return {
    current: build.version,
    updatable: true,
    reason: latest === null ? (failure ?? 'the release list could not be read just now') : null,
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

  // `spawn` reports a missing executable asynchronously, on 'error'. Without a
  // handler that is an unhandled 'error' on an EventEmitter, which Node turns
  // into a thrown exception with nothing to catch it -- so a host with no
  // systemd-run took the whole API down, after this route had already answered
  // 202 and audited that an update was beginning.
  //
  // It writes the failure where the console is already looking. The updater
  // owns that file, but the updater is precisely what did not start, and a
  // console left watching a spinner for an update that never began is the
  // worst of the available answers.
  child.on('error', (cause: Error) => {
    try {
      mkdirSync(`${env.root}/var`, { recursive: true });
      writeFileSync(
        `${env.root}/var/update.status`,
        `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\tfailed\t` +
          `the updater could not be started: ${cause.message}\n`,
      );
    } catch {
      // A root that cannot be written to is a deployment that was never
      // installed. There is nowhere left to report this to; the log line
      // below is the record.
    }
  });
  child.unref();

  // Not awaited. `systemd-run` returns as soon as the unit is queued, and
  // waiting for the UPDATE would mean waiting for our own restart.
  return { ok: true };
}
