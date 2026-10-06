import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, pointsToPrune, type PointForRetention } from './retention.js';

const end = Date.UTC(2026, 9, 5, 14);
const hourly = (hours: number): PointForRetention[] =>
  Array.from({ length: hours }, (_, h) => {
    const takenAt = new Date(end - h * 3_600_000);
    return { name: `s-${takenAt.toISOString()}`, takenAt, kind: 'scheduled' as const };
  });

describe('restore point retention', () => {
  it('keeps every hour, then a day, then a week', () => {
    const points = hourly(120 * 24);
    const pruned = new Set(pointsToPrune(points, DEFAULT_RETENTION));
    const kept = points.filter((p) => !pruned.has(p.name));
    const ages = kept.map((p) => (end - p.takenAt.getTime()) / 3_600_000);
    expect([...Array(48).keys()].every((h) => ages.includes(h))).toBe(true);
    expect(new Set(kept.map((p) => p.takenAt.toISOString().slice(0, 10))).size).toBeGreaterThanOrEqual(14);
    expect(kept.at(-1)!.takenAt.toISOString()).toBe('2026-08-23T23:00:00.000Z');
    expect(kept).toHaveLength(64);
  });

  it('keeps deliberate backups by count, apart from the schedule', () => {
    const kinds = ['manual', 'uploaded', 'pre-restore'] as const;
    const deliberate: PointForRetention[] = Array.from({ length: 12 }, (_, i) => ({
      name: `m-${i}`,
      takenAt: new Date(end - i * 86_400_000 * 30),
      kind: kinds[i % 3]!,
    }));
    const pruned = pointsToPrune([...hourly(3), ...deliberate], DEFAULT_RETENTION);
    expect(pruned.sort()).toEqual(['m-10', 'm-11']);
  });

  it('never prunes the newest of each kind, whatever the policy says', () => {
    const points: PointForRetention[] = [...hourly(3), { name: 'm', takenAt: new Date(end), kind: 'manual' }];
    const pruned = pointsToPrune(points, { hourly: 0, daily: 0, weekly: 0, manual: 0 });
    expect(pruned).not.toContain('m');
    expect(pruned).not.toContain(points[0]!.name);
  });
});
