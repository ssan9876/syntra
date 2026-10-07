import { describe, expect, it } from 'vitest';
import { backupProblems, EMPTY_BACKUP_HEALTH, type BackupAgentHealthView } from './health.js';

const now = new Date('2026-10-06T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

type Overrides = Partial<Omit<BackupAgentHealthView, 'health'>> & { health?: Partial<BackupAgentHealthView['health']> };

const agent = (over: Overrides = {}): BackupAgentHealthView => ({
  intervalHours: 1,
  verifyEveryDays: 7,
  offsite: null,
  startedAt: hoursAgo(1000),
  ...over,
  health: {
    ...EMPTY_BACKUP_HEALTH,
    lastBackup: { at: hoursAgo(1), ok: true, name: 'syntra-1', message: null },
    lastBackupSuccessAt: hoursAgo(1),
    lastVerify: { at: hoursAgo(24), ok: true, name: 'syntra-1', message: null },
    lastVerifySuccessAt: hoursAgo(24),
    ...over.health,
  },
});

describe('backupProblems', () => {
  it('is quiet when backups, tests and copies are current', () => {
    expect(backupProblems(agent(), now)).toEqual([]);
  });

  it('names an agent that does not answer', () => {
    expect(backupProblems(null, now)).toEqual([{ label: 'Backup service', detail: 'Not answering.', at: now }]);
  });

  it('reports a failed backup with its reason', () => {
    const problems = backupProblems(
      agent({ health: { lastBackup: { at: hoursAgo(0.5), ok: false, name: null, message: 'pg_dump exited 1: disk full' } } }),
      now,
    );
    expect(problems).toEqual([
      { label: 'Last backup', detail: 'Failed at 6 Oct 2026 11:30 UTC: pg_dump exited 1: disk full', at: new Date(hoursAgo(0.5)) },
    ]);
  });

  it('reports restore points stopping after twice the interval and an hour', () => {
    expect(backupProblems(agent({ health: { lastBackupSuccessAt: hoursAgo(2.5) } }), now)).toEqual([]);
    const late = backupProblems(agent({ health: { lastBackupSuccessAt: hoursAgo(3.5) } }), now);
    expect(late.map((p) => p.detail)).toEqual(['None since 6 Oct 2026 08:30 UTC.']);
  });

  it('gives a new install time to take its first backup', () => {
    const fresh = agent({ startedAt: hoursAgo(1), health: { lastBackup: null, lastBackupSuccessAt: null, lastVerify: null, lastVerifySuccessAt: null } });
    expect(backupProblems(fresh, now)).toEqual([]);
  });

  it('reports a failed restore test, or none passing for a week and a day', () => {
    const failed = backupProblems(
      agent({ health: { lastVerify: { at: hoursAgo(2), ok: false, name: 'syntra-1', message: 'syntra-1 restored no tables.' } } }),
      now,
    );
    expect(failed[0]).toMatchObject({ label: 'syntra-1', detail: 'Restore test failed at 6 Oct 2026 10:00 UTC: syntra-1 restored no tables.' });
    const stale = backupProblems(agent({ health: { lastVerifySuccessAt: hoursAgo(9 * 24) } }), now);
    expect(stale.map((p) => p.detail)).toEqual(['None passed since 27 Sept 2026.']);
    expect(backupProblems(agent({ verifyEveryDays: 0, health: { lastVerifySuccessAt: null, lastVerify: null } }), now)).toEqual([]);
  });

  it('reports a failed off-site copy only when a bucket is configured', () => {
    const copy = { lastCopy: { at: hoursAgo(1), ok: false, name: 'syntra-1', message: 'AccessDenied' } };
    expect(backupProblems(agent({ health: copy }), now)).toEqual([]);
    expect(backupProblems(agent({ offsite: { bucket: 'acme-backups' }, health: copy }), now)[0]).toMatchObject({
      label: 'Off-site copy to acme-backups',
      detail: 'Failed at 6 Oct 2026 11:00 UTC: AccessDenied',
    });
  });
});
