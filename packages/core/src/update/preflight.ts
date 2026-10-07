import { isNewer, type AvailableRelease } from './update-service.js';

/**
 * The checks the Updates page shows before **Update** runs: what the update
 * will install and change, and whether this install is ready for it. Pure
 * functions over what the route gathered, so each verdict is testable
 * without a forge, a disk or a backup agent.
 */
export type CheckStatus = 'pass' | 'info' | 'warn' | 'fail';

export interface PreflightCheck {
  id: 'release-files' | 'releases' | 'migrations' | 'disk' | 'backups';
  status: CheckStatus;
  title: string;
  detail: string;
  /** Lines under the detail: versions, migrations. */
  items?: string[];
  /** Where to go to fix it. */
  href?: string;
}

export interface ReleaseMigration {
  name: string;
  /** The release's own words about it, when the notes give any. */
  text: string;
  rewrites: boolean;
}

const MIGRATION = /\b(\d{14}_[a-z0-9_]+)\b/g;

/**
 * The migrations a release's notes name. Every release lists them (see
 * docs/releases.md), in a few formats over time, so names are read from
 * anywhere in the notes. Null when the notes neither name one nor say
 * "No migrations": unknown, which is not the same as none.
 */
export function migrationsInNotes(notes: string): ReleaseMigration[] | null {
  const found: ReleaseMigration[] = [];
  for (const line of notes.split(/\r?\n/)) {
    for (const match of line.matchAll(MIGRATION)) {
      const name = match[1]!;
      if (found.some((migration) => migration.name === name)) continue;
      const text = line
        .slice((match.index ?? 0) + name.length)
        .replace(/^[\s:—–-]+/, '')
        .trim();
      found.push({
        name,
        text,
        rewrites: /\brewrites?\b/i.test(line) && !/\b(does not|doesn't|no data is) rewrit/i.test(line),
      });
    }
  }
  if (found.length > 0) return found;
  return /\bno (database )?migrations\b/i.test(notes) ? [] : null;
}

/** The releases an update from `current` to `target` installs, oldest first. */
export function releasesBetween(releases: AvailableRelease[], current: string, target: string): AvailableRelease[] {
  return releases
    .filter((release) => isNewer(release.version, current) && !isNewer(release.version, target))
    .sort((a, b) => (isNewer(a.version, b.version) ? 1 : isNewer(b.version, a.version) ? -1 : 0));
}

export function releaseFilesCheck(release: { version: string; assets: string[] }): PreflightCheck {
  const wanted = [`syntra-${release.version}.tar.gz`, `syntra-${release.version}.tar.gz.sha256`];
  const missing = wanted.filter((name) => !release.assets.includes(name));
  if (missing.length === 0) {
    return { id: 'release-files', status: 'pass', title: 'Release files', detail: `${wanted[0]} and its checksum are published.` };
  }
  return {
    id: 'release-files',
    status: 'fail',
    title: 'Release files',
    detail: `${missing.join(' and ')} not published for ${release.version}. Check again when its release build finishes.`,
  };
}

const releaseLine = (release: AvailableRelease) =>
  release.released ? `${release.version} · released ${release.released.slice(0, 10)}` : release.version;

export function releasesCheck(between: AvailableRelease[], current: string): PreflightCheck {
  if (between.length <= 1) {
    const only = between[0];
    return {
      id: 'releases',
      status: 'pass',
      title: 'Releases',
      detail: only ? `${only.version}, the next release after ${current}.` : `The next release after ${current}.`,
    };
  }
  return {
    id: 'releases',
    status: 'info',
    title: 'Releases',
    detail: `${between.length} releases since ${current}. Their notes are below.`,
    items: between.map(releaseLine),
  };
}

export function migrationsCheck(between: AvailableRelease[]): PreflightCheck {
  const known: ReleaseMigration[] = [];
  const unlisted: string[] = [];
  for (const release of between) {
    const migrations = migrationsInNotes(release.notes);
    if (migrations === null) unlisted.push(release.version);
    else known.push(...migrations);
  }
  const items = known.map((migration) => (migration.text ? `${migration.name}: ${migration.text}` : migration.name));
  if (unlisted.length > 0) items.push(`Not listed in the notes for ${unlisted.join(', ')}.`);
  const rewriting = known.filter((migration) => migration.rewrites).length;

  if (known.length === 0 && unlisted.length === 0) {
    return { id: 'migrations', status: 'pass', title: 'Database changes', detail: 'None.' };
  }
  if (rewriting > 0) {
    return {
      id: 'migrations',
      status: 'warn',
      title: 'Database changes',
      detail: `${rewriting} of ${known.length} ${known.length === 1 ? 'change rewrites' : 'changes rewrite'} data. The update takes longer, and a rollback restores the backup it takes first.`,
      items,
    };
  }
  return {
    id: 'migrations',
    status: 'info',
    title: 'Database changes',
    detail:
      known.length === 0
        ? 'Not listed in the release notes.'
        : `${known.length} ${known.length === 1 ? 'change' : 'changes'}. The update backs up the database first.`,
    items,
  };
}

const GIB = 1024 ** 3;
/** A release with its dependencies is up to about 0.75 GiB, plus a database backup. */
export const DISK_NEEDED_BYTES = GIB;
export const DISK_COMFORTABLE_BYTES = 3 * GIB;

const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

export function diskCheck(freeBytes: number, root: string): PreflightCheck {
  if (freeBytes < DISK_NEEDED_BYTES) {
    return {
      id: 'disk',
      status: 'fail',
      title: 'Disk space',
      detail: `${gb(freeBytes)} free on ${root}. An update needs about 1 GB. Free space, then check again.`,
    };
  }
  if (freeBytes < DISK_COMFORTABLE_BYTES) {
    return { id: 'disk', status: 'warn', title: 'Disk space', detail: `${gb(freeBytes)} free on ${root}. An update needs about 1 GB.` };
  }
  return { id: 'disk', status: 'pass', title: 'Disk space', detail: `${gb(freeBytes)} free on ${root}.` };
}

/** A backup older than this is worth taking again before an update. */
export const BACKUP_FRESH_MS = 26 * 60 * 60 * 1000;

const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${Math.round(hours / 24)} days ago`;
};

export type BackupState =
  | { configured: false }
  | { configured: true; reachable: false }
  | { configured: true; reachable: true; lastSuccessAt: string | null };

export function backupsCheck(state: BackupState, now: Date): PreflightCheck {
  const base = { id: 'backups' as const, title: 'Backups', href: '/admin/backups' };
  if (!state.configured) {
    return { id: 'backups', title: 'Backups', status: 'info', detail: 'No backup service configured. The update still backs up the database first.' };
  }
  if (!state.reachable) {
    return { ...base, status: 'warn', detail: 'The backup service did not answer. The update still backs up the database first.' };
  }
  if (state.lastSuccessAt === null) {
    return { ...base, status: 'warn', detail: 'No backup yet. Select Back up now on the Backups page first.' };
  }
  const age = now.getTime() - new Date(state.lastSuccessAt).getTime();
  if (age > BACKUP_FRESH_MS) {
    return { ...base, status: 'warn', detail: `Last backup ${ago(age)}. Select Back up now on the Backups page first.` };
  }
  return { ...base, status: 'pass', detail: `Last backup ${ago(age)}.` };
}
