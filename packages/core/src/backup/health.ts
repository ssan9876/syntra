/**
 * Whether backups are working, from what the backup agent remembers, as an
 * incident an operator can act on.
 *
 * The agent keeps the last backup, restore test and off-site copy in
 * `health.json` on its own volume. The API reads that through the agent's
 * status and, for a caller with `deployment.manage`, lists this beside the
 * other incidents. The rule each item states is also an alert in
 * ops/prometheus-alerts.yml, for an installation that has Prometheus.
 */
export interface BackupEvent {
  at: string;
  ok: boolean;
  name: string | null;
  message: string | null;
}

export interface BackupHealth {
  lastBackup: BackupEvent | null;
  lastBackupSuccessAt: string | null;
  lastVerify: BackupEvent | null;
  lastVerifySuccessAt: string | null;
  lastCopy: BackupEvent | null;
  lastCopySuccessAt: string | null;
}

export const EMPTY_BACKUP_HEALTH: BackupHealth = {
  lastBackup: null,
  lastBackupSuccessAt: null,
  lastVerify: null,
  lastVerifySuccessAt: null,
  lastCopy: null,
  lastCopySuccessAt: null,
};

/** What the agent says about itself, as far as this decision needs it. */
export interface BackupAgentHealthView {
  intervalHours: number;
  verifyEveryDays: number;
  offsite: { bucket: string } | null;
  health: BackupHealth;
  /** When the agent started: a new install has had no chance to back up yet. */
  startedAt: string;
}

export interface BackupProblem {
  label: string;
  detail: string;
  at: Date | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const time = (iso: string) =>
  `${day(iso)} ${new Date(iso).toISOString().slice(11, 16)} UTC`;

/**
 * Each thing wrong with backups, or an empty list. `agent` is null when the
 * API has a BACKUP_AGENT_URL and the agent did not answer.
 *
 * Grace periods, so a single slow run is not an incident:
 * - no successful backup for twice the interval plus an hour;
 * - no successful restore test for the test interval plus a day.
 */
export function backupProblems(agent: BackupAgentHealthView | null, now: Date): BackupProblem[] {
  if (agent === null) {
    return [{ label: 'Backup service', detail: 'Not answering.', at: now }];
  }
  const problems: BackupProblem[] = [];
  const { health } = agent;
  const age = (iso: string | null, since: string) => now.getTime() - new Date(iso ?? since).getTime();

  if (health.lastBackup && !health.lastBackup.ok) {
    problems.push({
      label: 'Last backup',
      detail: `Failed at ${time(health.lastBackup.at)}: ${health.lastBackup.message ?? 'no reason recorded'}`,
      at: new Date(health.lastBackup.at),
    });
  }
  if (agent.intervalHours > 0 && age(health.lastBackupSuccessAt, agent.startedAt) > (2 * agent.intervalHours + 1) * HOUR) {
    problems.push({
      label: 'Restore points',
      detail: health.lastBackupSuccessAt
        ? `None since ${time(health.lastBackupSuccessAt)}.`
        : 'None taken yet.',
      at: health.lastBackupSuccessAt ? new Date(health.lastBackupSuccessAt) : null,
    });
  }
  if (health.lastVerify && !health.lastVerify.ok) {
    problems.push({
      label: health.lastVerify.name ?? 'Restore test',
      detail: `Restore test failed at ${time(health.lastVerify.at)}: ${health.lastVerify.message ?? 'no reason recorded'}`,
      at: new Date(health.lastVerify.at),
    });
  } else if (agent.verifyEveryDays > 0 && age(health.lastVerifySuccessAt, agent.startedAt) > (agent.verifyEveryDays + 1) * DAY) {
    problems.push({
      label: 'Restore test',
      detail: health.lastVerifySuccessAt
        ? `None passed since ${day(health.lastVerifySuccessAt)}.`
        : 'None run yet.',
      at: health.lastVerifySuccessAt ? new Date(health.lastVerifySuccessAt) : null,
    });
  }
  if (agent.offsite && health.lastCopy && !health.lastCopy.ok) {
    problems.push({
      label: `Off-site copy to ${agent.offsite.bucket}`,
      detail: `Failed at ${time(health.lastCopy.at)}: ${health.lastCopy.message ?? 'no reason recorded'}`,
      at: new Date(health.lastCopy.at),
    });
  }
  return problems;
}
