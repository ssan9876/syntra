import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageFacts, PageHeader } from './PageHeader.js';

type Kind = 'scheduled' | 'manual' | 'uploaded' | 'pre-restore';

export interface BackupRow {
  name: string;
  createdAt: string;
  version: string;
  bytes: number;
  kind: Kind;
  key: 'match' | 'mismatch' | 'unknown';
  versionCheck: 'ok' | 'newer' | 'unknown';
  /** When a restore test last passed for this backup. */
  verifiedAt?: string | undefined;
}

export interface BackupEvent {
  at: string;
  ok: boolean;
  name: string | null;
  message: string | null;
}

export interface BackupJob {
  id: string;
  kind: 'backup' | 'restore' | 'verify';
  state: 'running' | 'succeeded' | 'failed';
  step: string;
  message: string | null;
  backupName: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BackupsResponse {
  configured: boolean;
  version: string;
  backups: BackupRow[];
  status: {
    intervalHours: number;
    intervalSetAt: string | null;
    retention: { hourly: number; daily: number; weekly: number; manual: number };
    copyConfigured: boolean;
    current: BackupJob | null;
    recent: BackupJob[];
    verifyEveryDays: number;
    offsite: { bucket: string; endpoint: string | null; prefix: string } | null;
    health: {
      lastBackup: BackupEvent | null;
      lastBackupSuccessAt: string | null;
      lastVerify: BackupEvent | null;
      lastVerifySuccessAt: string | null;
      lastCopy: BackupEvent | null;
      lastCopySuccessAt: string | null;
    };
  } | null;
}

const KIND_LABEL: Record<Kind, string> = {
  scheduled: 'Scheduled',
  manual: 'Manual',
  uploaded: 'Uploaded',
  'pre-restore': 'Before restore',
};

const MIN_PASSPHRASE = 12;

/** The intervals `PUT /api/admin/backups/schedule` accepts. */
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24, 0];

function every(hours: number): string {
  if (hours === 0) return 'Off';
  if (hours === 1) return 'Every hour';
  if (hours === 24) return 'Once a day';
  return `Every ${hours} hours`;
}

const JOB_TITLE: Record<BackupJob['kind'], (name: string | null) => string> = {
  backup: () => 'Backing up',
  restore: (name) => `Restoring ${name ?? ''}`,
  verify: (name) => `Testing a restore of ${name ?? 'the newest backup'}`,
};
const POLL_MS = 2_000;

const when = (iso: string) => new Date(iso).toLocaleString();

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function problemText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;
}

/** fetch, with a problem+json failure turned into an ApiError like `api()` does. */
async function raw(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (response.ok) return response;
  let problem = { type: 'about:blank', title: 'Request failed', status: response.status };
  try {
    problem = { ...problem, ...(await response.json()) };
  } catch {
    // Not JSON; the status is what there is.
  }
  throw new ApiError(problem);
}

/**
 * Backups of the whole installation: restore points on a schedule, Back up
 * now, download and upload, and restore. `deployment.manage`, like Updates.
 */
export function BackupsPage() {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<BackupRow | null>(null);
  const [restoring, setRestoring] = useState<BackupRow | null>(null);
  const [deleting, setDeleting] = useState<BackupRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const [restoreJob, setRestoreJob] = useState<{ id: string; name: string } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [testingBucket, setTestingBucket] = useState(false);
  const [bucketResult, setBucketResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function testBucket() {
    setTestingBucket(true);
    setBucketResult(null);
    try {
      await api('/api/admin/backups/offsite/test', { method: 'POST', body: '{}' });
      setBucketResult({ ok: true, message: 'A test object was written and deleted.' });
    } catch (cause) {
      setBucketResult({ ok: false, message: problemText(cause, 'The bucket did not answer.') });
    } finally {
      setTestingBucket(false);
    }
  }

  async function testRestore(backup: BackupRow) {
    try {
      await api(`/api/admin/backups/${backup.name}/verify`, { method: 'POST', body: '{}' });
      await load();
    } catch (cause) {
      setError(problemText(cause, 'Restore test did not start.'));
    }
  }

  const load = useCallback(async () => {
    try {
      setData(await api<BackupsResponse>('/api/admin/backups'));
      setError(null);
    } catch (cause) {
      setError(problemText(cause, 'Could not read backups.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a job runs, follow it.
  const running = data?.status?.current ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  async function backUpNow() {
    setBusy(true);
    try {
      await api('/api/admin/backups', { method: 'POST', body: '{}' });
      await load();
    } catch (cause) {
      setError(problemText(cause, 'Backup did not start.'));
    } finally {
      setBusy(false);
    }
  }

  if (restoreJob) return <RestoreProgress job={restoreJob} />;

  const header = (
    <PageHeader
      title="Backups"
      actions={
        data?.configured ? (
          <>
            <Button variant="secondary" onClick={() => setUploading(true)}>
              Upload backup
            </Button>
            <Button variant="primary" loading={busy} disabled={busy || running !== null} onClick={() => void backUpNow()}>
              Back up now
            </Button>
          </>
        ) : null
      }
    />
  );

  if (!data) {
    return (
      <>
        {header}
        {error ? <Alert tone="danger">{error}</Alert> : <SkeletonRows rows={4} />}
      </>
    );
  }

  if (!data.configured || !data.status) {
    return (
      <>
        {header}
        <Empty title="No backup service configured">
          Set <code>BACKUP_AGENT_URL</code>. See{' '}
          <a className="link" href="https://ssan9876.github.io/syntra/operate/#backups-from-the-console">
            Backups
          </a>
          .
        </Empty>
      </>
    );
  }

  const { status } = data;
  const { health } = status;
  const lastFinished = status.recent[0];
  const retention = status.retention;
  const testedValue = health.lastVerify
    ? health.lastVerify.ok
      ? `Passed ${when(health.lastVerify.at)}`
      : `Failed ${when(health.lastVerify.at)}`
    : status.verifyEveryDays === 0
      ? 'Off'
      : 'Not yet';

  return (
    <>
      {header}
      <PageFacts
        facts={[
          {
            label: 'Restore points',
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                {every(status.intervalHours)}
                <Button size="sm" variant="ghost" onClick={() => setScheduling(true)}>
                  Change
                </Button>
              </span>
            ),
          },
          {
            label: 'Kept',
            value: `${retention.hourly} hourly · ${retention.daily} daily · ${retention.weekly} weekly`,
          },
          { label: 'Last backup', value: health.lastBackupSuccessAt ? when(health.lastBackupSuccessAt) : 'None yet' },
          { label: 'Restore test', value: testedValue },
          {
            label: 'Off-site',
            value: status.offsite ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{status.offsite.bucket}</span>
                <Button size="sm" variant="ghost" loading={testingBucket} onClick={() => void testBucket()}>
                  Test bucket
                </Button>
              </span>
            ) : status.copyConfigured ? 'Copy command' : 'Off',
          },
        ]}
      />

      <div className="mb-4 space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {bucketResult ? (
          <Alert tone={bucketResult.ok ? 'success' : 'danger'} title={bucketResult.ok ? 'Bucket works' : 'Bucket test failed'}>
            {bucketResult.message}
          </Alert>
        ) : null}
        {running ? (
          <Alert tone="info" title={JOB_TITLE[running.kind](running.backupName)}>
            {running.step}
          </Alert>
        ) : lastFinished?.state === 'failed' && lastFinished.kind === 'restore' ? (
          <Alert tone="danger" title="Restore failed">
            {lastFinished.message}
          </Alert>
        ) : null}
        {health.lastBackup && !health.lastBackup.ok ? (
          <Alert tone="danger" title="Backup failed">
            {health.lastBackup.message}
          </Alert>
        ) : null}
        {health.lastVerify && !health.lastVerify.ok ? (
          <Alert tone="danger" title={`Restore test failed: ${health.lastVerify.name ?? ''}`}>
            {health.lastVerify.message}
          </Alert>
        ) : null}
        {status.offsite && health.lastCopy && !health.lastCopy.ok ? (
          <Alert tone="danger" title="Off-site copy failed">
            {health.lastCopy.message}
          </Alert>
        ) : null}
      </div>

      <Panel>
        {data.backups.length === 0 ? (
          <Empty title="No backups yet" />
        ) : (
          <>
          {/* Phones get one card per backup: a six-column table there is a
              sideways scroll to reach the buttons. */}
          <ul className="divide-y divide-border-subtle sm:hidden" aria-label="Backups">
            {data.backups.map((backup) => (
              <li key={backup.name} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{when(backup.createdAt)}</p>
                    <p className="text-sm text-muted">
                      {KIND_LABEL[backup.kind]} · {backup.version} · {size(backup.bytes)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <KeyStatus backup={backup} />
                    <TestedStatus backup={backup} />
                  </div>
                </div>
                <BackupActions
                  backup={backup}
                  disabled={running !== null}
                  version={data.version}
                  onDownload={() => setDownloading(backup)}
                  onRestore={() => setRestoring(backup)}
                  onDelete={() => setDeleting(backup)}
                  onTest={() => void testRestore(backup)}
                />
              </li>
            ))}
          </ul>
          <div className="max-sm:hidden">
          <Table label="Backups">
            <thead>
              <tr>
                <th scope="col">Taken</th>
                <th scope="col">Kind</th>
                <th scope="col">Version</th>
                <th scope="col">Size</th>
                <th scope="col">Checks</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((backup) => (
                <tr key={backup.name}>
                  <th scope="row" className="font-medium">
                    {when(backup.createdAt)}
                    <span className="block font-mono text-xs font-normal text-muted">{backup.name}</span>
                  </th>
                  <td>{KIND_LABEL[backup.kind]}</td>
                  <td className="tabular-nums">{backup.version}</td>
                  <td className="tabular-nums whitespace-nowrap">{size(backup.bytes)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <KeyStatus backup={backup} />
                      <TestedStatus backup={backup} />
                    </div>
                  </td>
                  <td>
                    <BackupActions
                      backup={backup}
                      disabled={running !== null}
                      version={data.version}
                      onDownload={() => setDownloading(backup)}
                      onRestore={() => setRestoring(backup)}
                      onDelete={() => setDeleting(backup)}
                      onTest={() => void testRestore(backup)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          </div>
          </>
        )}
      </Panel>

      {scheduling ? (
        <ScheduleDialog
          intervalHours={status.intervalHours}
          onClose={() => setScheduling(false)}
          onSaved={() => {
            setScheduling(false);
            void load();
          }}
        />
      ) : null}
      {downloading ? <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} /> : null}
      {uploading ? (
        <UploadDialog
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      ) : null}
      {restoring ? (
        <RestoreDialog
          backup={restoring}
          onClose={() => setRestoring(null)}
          onStarted={(id) => {
            setRestoreJob({ id, name: restoring.name });
            setRestoring(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          backup={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function KeyStatus({ backup }: { backup: BackupRow }) {
  if (backup.key === 'match') return <Status tone="active" glyph="check">Same</Status>;
  if (backup.key === 'mismatch') return <Status tone="danger" glyph="blocked">Different</Status>;
  return <Status tone="neutral" glyph="minus">Unknown</Status>;
}

function TestedStatus({ backup }: { backup: BackupRow }) {
  if (!backup.verifiedAt) return null;
  return (
    <Status tone="active" glyph="check">
      <span title={`Restore test passed ${when(backup.verifiedAt)}`}>Tested</span>
    </Status>
  );
}

function BackupActions({
  backup,
  disabled,
  version,
  onDownload,
  onRestore,
  onDelete,
  onTest,
}: {
  backup: BackupRow;
  disabled: boolean;
  version: string;
  onDownload(): void;
  onRestore(): void;
  onDelete(): void;
  onTest(): void;
}) {
  return (
    <div className="row-actions max-sm:justify-start">
      <Button size="sm" variant="secondary" onClick={onDownload}>
        Download
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || backup.key === 'mismatch' || backup.versionCheck === 'newer'}
        title={
          backup.key === 'mismatch'
            ? 'Taken under a different master key'
            : backup.versionCheck === 'newer'
              ? `Taken on ${backup.version}; this install runs ${version}`
              : undefined
        }
        onClick={onRestore}
      >
        Restore
      </Button>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={onTest}>
        Test
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

function DownloadDialog({ backup, onClose }: { backup: BackupRow; onClose(): void }) {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const differs = again.length > 0 && again !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE && again === passphrase;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await raw(`/api/admin/backups/${backup.name}/download`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${backup.name}.syntra-backup`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch (cause) {
      setError(problemText(cause, 'Download failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Download backup"
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!ready || busy} onClick={() => void download()}>
            Download
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>The file is encrypted. Uploading it needs the same passphrase.</p>
        <Field
          label="Passphrase"
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={setPassphrase}
          error={tooShort ? `At least ${MIN_PASSPHRASE} characters.` : undefined}
        />
        <Field
          label="Passphrase again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={setAgain}
          error={differs ? 'Does not match.' : undefined}
        />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

function UploadDialog({ onClose, onUploaded }: { onClose(): void; onUploaded(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await raw('/api/admin/backups/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-backup-passphrase': passphrase },
        body: file,
      });
      onUploaded();
    } catch (cause) {
      setError(problemText(cause, 'Upload failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload backup"
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!file || passphrase.length < MIN_PASSPHRASE || busy} onClick={() => void upload()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor="backup-file" className="mb-1.5 block font-medium text-ink">
            Backup file
          </label>
          <input
            id="backup-file"
            type="file"
            accept=".syntra-backup"
            className="block w-full text-sm"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <Field label="Passphrase" type="password" autoComplete="off" value={passphrase} onChange={setPassphrase} />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

function ScheduleDialog({
  intervalHours,
  onClose,
  onSaved,
}: {
  intervalHours: number;
  onClose(): void;
  onSaved(): void;
}) {
  const [value, setValue] = useState(String(intervalHours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An interval set by BACKUP_INTERVAL_HOURS outside the offered ones stays
  // selectable, so opening and saving does not change it.
  const options = (INTERVALS.includes(intervalHours) ? INTERVALS : [intervalHours, ...INTERVALS]).map((hours) => ({
    value: String(hours),
    label: every(hours),
  }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/backups/schedule', {
        method: 'PUT',
        body: JSON.stringify({ intervalHours: Number(value) }),
      });
      onSaved();
    } catch (cause) {
      setError(problemText(cause, 'Schedule was not saved.'));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore point schedule"
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={busy || value === String(intervalHours)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select
          label="Take a restore point"
          value={value}
          onChange={setValue}
          options={options}
          warning={value === '0' ? 'No scheduled backups. Back up now still works.' : undefined}
        />
        {value !== '0' ? <p className="text-sm text-muted">{value === '24' ? 'At 00:00 UTC.' : 'On the hour, UTC.'}</p> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

function RestoreDialog({
  backup,
  onClose,
  onStarted,
}: {
  backup: BackupRow;
  onClose(): void;
  onStarted(jobId: string): void;
}) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const { job } = await api<{ job: BackupJob }>(`/api/admin/backups/${backup.name}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      });
      onStarted(job.id);
    } catch (cause) {
      setError(problemText(cause, 'Restore did not start.'));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Restore ${when(backup.createdAt)}?`}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={confirm !== backup.name || busy} onClick={() => void restore()}>
            Restore
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ul className="list-disc space-y-1 pl-5">
          <li>Every tenant goes back to this backup.</li>
          <li>The current state is backed up first.</li>
          <li>Everybody is signed out.</li>
          <li>Background work stays paused until you resume it.</li>
        </ul>
        {backup.key === 'unknown' ? (
          <Alert tone="warning">Key unknown: stored secrets may not decrypt.</Alert>
        ) : null}
        <Field label={`Type ${backup.name}`} value={confirm} onChange={setConfirm} autoComplete="off" spellCheck={false} />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

function DeleteDialog({ backup, onClose, onDeleted }: { backup: BackupRow; onClose(): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/admin/backups/${backup.name}`, { method: 'DELETE' });
      onDeleted();
    } catch (cause) {
      setError(problemText(cause, 'Delete failed.'));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete backup?"
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </>
      }
    >
      <p>
        {KIND_LABEL[backup.kind]} backup from {when(backup.createdAt)}.
      </p>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * The restore, followed until the API comes back. It restarts twice during a
 * restore and the database refuses it in between, so a failed poll is
 * expected: the page waits for readiness, then reloads.
 */
function RestoreProgress({ job }: { job: { id: string; name: string } }) {
  const [step, setStep] = useState('Starting');
  const [failed, setFailed] = useState<string | null>(null);
  const away = useRef(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (!away.current) {
        try {
          const { job: current } = await api<{ job: BackupJob }>(`/api/admin/backups/jobs/${job.id}`);
          setStep(current.step);
          if (current.state === 'failed') {
            setFailed(current.message);
            return;
          }
          if (current.state === 'succeeded') {
            window.location.assign('/admin');
            return;
          }
        } catch {
          away.current = true;
          setStep('Syntra is restarting. This page reloads when it is back.');
        }
      } else {
        const ready = await fetch('/health/ready').then((r) => r.ok, () => false);
        if (ready) {
          window.location.assign('/admin');
          return;
        }
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [job.id]);

  return (
    <>
      <PageHeader title="Backups" />
      {failed ? (
        <Alert tone="danger" title="Restore failed">
          {failed}
        </Alert>
      ) : (
        <Alert tone="info" title={`Restoring ${job.name}`}>
          {step}
        </Alert>
      )}
    </>
  );
}
