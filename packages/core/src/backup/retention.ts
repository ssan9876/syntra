/**
 * Which restore points to keep.
 *
 * Scheduled points thin out with age: every one from the last `hourly`, then
 * the newest of each UTC day for `daily` days, then the newest of each ISO
 * week for `weekly` weeks. A point kept by any rule is kept. Points somebody
 * took on purpose -- Back up now, an upload, the safety copy before a restore
 * -- are kept by count, newest first, and never pruned by the schedule.
 */

export type PointKind = 'scheduled' | 'manual' | 'uploaded' | 'pre-restore';

export interface RetentionPolicy {
  hourly: number;
  daily: number;
  weekly: number;
  manual: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { hourly: 48, daily: 14, weekly: 8, manual: 10 };

export interface PointForRetention {
  name: string;
  takenAt: Date;
  kind: PointKind;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO 8601 week, e.g. "2026-W41". */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function newestPerBucket(points: PointForRetention[], bucket: (date: Date) => string, count: number): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const key = bucket(point.takenAt);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > count) break;
    kept.push(point.name);
  }
  return kept;
}

/** The names to delete. Never includes the newest point of any kind. */
export function pointsToPrune(points: PointForRetention[], policy: RetentionPolicy): string[] {
  const newestFirst = [...points].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  const scheduled = newestFirst.filter((point) => point.kind === 'scheduled');
  const deliberate = newestFirst.filter((point) => point.kind !== 'scheduled');

  const keep = new Set<string>([
    ...scheduled.slice(0, Math.max(1, policy.hourly)).map((point) => point.name),
    ...newestPerBucket(scheduled, utcDay, policy.daily),
    ...newestPerBucket(scheduled, isoWeek, policy.weekly),
    ...deliberate.slice(0, Math.max(1, policy.manual)).map((point) => point.name),
  ]);
  return newestFirst.filter((point) => !keep.has(point.name)).map((point) => point.name);
}
