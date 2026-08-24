import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this install actually is.
 *
 * Read from `RELEASE.json`, which CI writes into the release tarball and
 * nothing else creates. A tree without one is a developer checkout or a
 * `deploy.sh` push, and it reports itself as `dev`.
 *
 * **`dev` is never a version number.** An install that claims to be 1.4.0
 * while being somebody's working tree is an install whose update history is
 * fiction: the updater would compare against it, decide 1.4.1 is newer, and
 * overwrite uncommitted work with a release. Refusing to guess is what makes
 * the comparison in the updater safe to trust.
 */

export interface BuildInfo {
  /** A release version, or the literal `dev`. */
  version: string;
  /** True only when a RELEASE.json was found and parsed. */
  isRelease: boolean;
  commit: string | null;
  released: string | null;
  /** Migration directories this release added over the one before it. */
  migrations: string[];
}

const DEV: BuildInfo = {
  version: 'dev',
  isRelease: false,
  commit: null,
  released: null,
  migrations: [],
};

/**
 * The root of the install: the directory holding `pnpm-workspace.yaml`.
 *
 * Walked up from this module rather than taken from `process.cwd()`, which is
 * whatever directory the service happened to be started in — `apps/api` under
 * the systemd unit, the repository root under vitest, and anything at all
 * under a shell.
 */
function installRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/**
 * The whole of the decision, separated from the filesystem so it can be tested
 * without writing a RELEASE.json into somebody's checkout.
 *
 * Every failure returns `dev`. A malformed, truncated or empty release file is
 * a release that cannot say what it is -- and an install that GUESSES lets the
 * updater compare against a number nothing stands behind.
 */
export function parseRelease(raw: string | null): BuildInfo {
  if (raw === null) return DEV;
  try {
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    // A RELEASE.json with no version is a broken release, not version zero.
    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
      return DEV;
    }
    return {
      version: parsed.version.trim(),
      isRelease: true,
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
      released: typeof parsed.released === 'string' ? parsed.released : null,
      migrations: Array.isArray(parsed.migrations)
        ? parsed.migrations.filter((m): m is string => typeof m === 'string')
        : [],
    };
  } catch {
    return DEV;
  }
}

function read(): BuildInfo {
  const root = installRoot();
  if (root === null) return DEV;
  try {
    return parseRelease(readFileSync(join(root, 'RELEASE.json'), 'utf8'));
  } catch {
    return DEV;
  }
}

/**
 * Cached for the life of the process, deliberately.
 *
 * The file cannot change under a running process: an update unpacks a NEW
 * directory and restarts, so the version a process reports is the version it
 * started as. Re-reading would only make it possible to report a version this
 * process is not running.
 */
let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  cached ??= read();
  return cached;
}

/** Test seam. Never called by the product. */
export function resetBuildInfoCache(): void {
  cached = null;
}
