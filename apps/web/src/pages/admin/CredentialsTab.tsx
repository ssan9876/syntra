import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

type CredentialStatus = 'expired' | 'expiring' | 'ok' | 'no_expiry' | 'unknown';

interface Rotation {
  id: string;
  systemKind: string;
  systemId: string;
  status: string;
  reason: string | null;
  newExpiresAt: string | null;
  stagedAt: string;
  verifiedAt: string | null;
  verificationOk: boolean | null;
  verificationMessage: string | null;
  cutOverAt: string | null;
  completedAt: string | null;
  overlapActive: boolean;
  evidence: { step: string; at: string; ok?: boolean; message?: string }[];
}

export interface CredentialItem {
  key: string;
  kind: string;
  label: string;
  subject: { type: string; id: string; name: string; href: string | null };
  expiresAt: string | null;
  expirySource: 'certificate' | 'issued' | 'discovered' | 'declared' | 'none' | 'unknown';
  lastRotatedAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  note: string | null;
  declaredExpiresAt: string | null;
  discovery: { status: string; message: string | null; at: string | null } | null;
  status: CredentialStatus;
  daysRemaining: number | null;
  rotation: { systemKind: string; systemId: string } | null;
  openRotation: Rotation | null;
}

const DECLARABLE = new Set(['target_secret', 'source_secret', 'person_source_secret', 'upstream_client_secret']);

const SOURCE_LABEL: Record<CredentialItem['expirySource'], string> = {
  certificate: 'from the certificate',
  issued: 'set by Syntra',
  discovered: 'discovered from Entra ID',
  declared: 'declared',
  none: 'never expires',
  unknown: 'not known',
};

const problem = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

/** The badge beside every entry: how long, or that it has gone, or that nobody knows. */
export function ExpiryBadge({ item }: { item: Pick<CredentialItem, 'status' | 'daysRemaining'> }) {
  switch (item.status) {
    case 'expired':
      return <Status tone="danger">Expired</Status>;
    case 'expiring':
      return (
        <Status tone="warning">
          {item.daysRemaining === 0 ? 'Expires today' : `${item.daysRemaining} ${item.daysRemaining === 1 ? 'day' : 'days'} left`}
        </Status>
      );
    case 'ok':
      return <Status tone="active">Valid</Status>;
    case 'no_expiry':
      return <Status>No expiry</Status>;
    default:
      return <Status tone="warning">Expiry unknown</Status>;
  }
}

/**
 * Every credential Syntra holds or depends on, soonest to expire first, with
 * the rotation workflow for connector secrets.
 *
 * Tenant settings, not an operations page: the owner and declared expiry are
 * configuration, and the rotation actions are gated server-side on the
 * permission that already governs each connector.
 */
export function CredentialsTab() {
  const { data, error, loading, reload } = useApiResource<{ alertDays: number[]; items: CredentialItem[] }>(
    '/api/admin/credentials',
  );
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);

  const items = data?.items ?? [];
  const count = (status: CredentialStatus) => items.filter((i) => i.status === status).length;

  async function scan() {
    setScanning(true);
    setNotice(null);
    try {
      const result = await api<{ alertsRaised: number; discovered: number }>('/api/admin/credentials/scan', {
        method: 'POST',
        body: JSON.stringify({ forceDiscovery: true }),
      });
      setNotice({
        tone: 'success',
        text: `Scan complete: ${result.alertsRaised} ${result.alertsRaised === 1 ? 'alert' : 'alerts'} raised, ${result.discovered} ${result.discovered === 1 ? 'expiry' : 'expiries'} discovered.`,
      });
      reload();
    } catch (cause) {
      setNotice({ tone: 'warning', text: problem(cause, 'The scan did not run.') });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div aria-live="polite">{notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}</div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel
          title="Credential inventory"
          actions={
            <Button size="sm" loading={scanning} onClick={() => void scan()}>
              Scan now
            </Button>
          }
        >
          {loading && <SkeletonRows rows={4} cols={5} />}
          {!loading && items.length === 0 && (
            <div className="p-6">
              <Empty title="No credentials yet" />
            </div>
          )}
          {!loading && items.length > 0 && (
            <>
              <p className="px-4 pt-3 text-sm text-muted">
                {count('expired')} expired · {count('expiring')} expiring within {Math.max(...(data?.alertDays ?? [30]))} days ·{' '}
                {count('unknown')} with no known expiry · alerts at {(data?.alertDays ?? []).join(', ')} days
              </p>
              <Table>
                <thead>
                  <tr>
                    <th>Credential</th>
                    <th>Expiry</th>
                    <th>Last rotated</th>
                    <th>Owner</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <CredentialRow
                      key={item.key}
                      item={item}
                      editing={editing === item.key}
                      rotating={rotating === item.key}
                      onEdit={() => {
                        setRotating(null);
                        setEditing(editing === item.key ? null : item.key);
                      }}
                      onRotate={() => {
                        setEditing(null);
                        setRotating(rotating === item.key ? null : item.key);
                      }}
                      onChanged={(text) => {
                        if (text) setNotice({ tone: 'success', text });
                        reload();
                      }}
                      onDone={() => {
                        setEditing(null);
                      }}
                    />
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

function CredentialRow({
  item,
  editing,
  rotating,
  onEdit,
  onRotate,
  onChanged,
  onDone,
}: {
  item: CredentialItem;
  editing: boolean;
  rotating: boolean;
  onEdit(): void;
  onRotate(): void;
  onChanged(text?: string): void;
  onDone(): void;
}) {
  return (
    <>
      <tr>
        <td>
          <div className="font-medium text-ink">{item.label}</div>
          <div className="text-sm text-muted">
            {item.subject.href ? <Link className="link" to={item.subject.href}>{item.subject.name}</Link> : item.subject.name}
            {item.discovery && item.discovery.status !== 'found' && item.discovery.message ? ` · ${item.discovery.message}` : ''}
          </div>
        </td>
        <td>
          <div className="flex flex-wrap items-center gap-2">
            <ExpiryBadge item={item} />
            <span className="text-sm text-muted">
              {item.expiresAt ? day(item.expiresAt) : ''} {SOURCE_LABEL[item.expirySource]}
            </span>
          </div>
          {item.openRotation && (
            <div className="mt-1">
              <Status tone="primary">Rotation {item.openRotation.status.replace(/_/g, ' ')}</Status>
            </div>
          )}
        </td>
        <td className="text-sm">{day(item.lastRotatedAt)}</td>
        <td className="text-sm">{item.ownerName ?? <span className="text-muted">Unassigned</span>}</td>
        <td>
          <div className="row-actions">
            <Button size="sm" variant="ghost" aria-expanded={editing} onClick={onEdit}>
              Edit
            </Button>
            {item.rotation && (
              <Button size="sm" variant="ghost" aria-expanded={rotating} onClick={onRotate}>
                Rotate
              </Button>
            )}
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <MetadataForm item={item} onSaved={() => { onChanged('Saved.'); onDone(); }} onCancel={onDone} />
          </td>
        </tr>
      )}
      {rotating && item.rotation && (
        <tr>
          <td colSpan={5}>
            <RotationPanel item={item} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function MetadataForm({ item, onSaved, onCancel }: { item: CredentialItem; onSaved(): void; onCancel(): void }) {
  const users = useApiResource<{ users?: { id: string; displayName: string; login: string }[] }>(
    '/api/admin/users?pageSize=200',
  );
  const [owner, setOwner] = useState(item.ownerUserId ?? '');
  const [declared, setDeclared] = useState(item.declaredExpiresAt ? item.declaredExpiresAt.slice(0, 10) : '');
  const [note, setNote] = useState(item.note ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const declarable = DECLARABLE.has(item.kind);

  const options = [
    { value: '', label: 'Unassigned' },
    ...(users.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.displayName} (${u.login})` })),
  ];
  if (item.ownerUserId && !options.some((o) => o.value === item.ownerUserId)) {
    options.push({ value: item.ownerUserId, label: item.ownerName ?? item.ownerUserId });
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await api(`/api/admin/credentials/${item.key}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ownerUserId: owner === '' ? null : owner,
          ...(declarable ? { declaredExpiresAt: declared ? new Date(`${declared}T00:00:00Z`).toISOString() : null } : {}),
          note: note.trim() === '' ? null : note.trim(),
        }),
      });
      onSaved();
    } catch (cause) {
      setFailure(problem(cause, 'The change was not saved.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 p-2 sm:grid-cols-3">
      <Select label="Owner" value={owner} onChange={setOwner} options={options} />
      {declarable && (
        <Field
          label="Expires on (declared)"
          type="date"
          value={declared}
          onChange={setDeclared}
          warning={item.discovery?.status === 'found' ? 'Overridden by the discovered expiry.' : undefined}
        />
      )}
      <Field label="Note" value={note} onChange={setNote} maxLength={500} />
      <div aria-live="polite" className="sm:col-span-3">{failure ? <Alert tone="warning">{failure}</Alert> : null}</div>
      <div className="flex gap-2 sm:col-span-3">
        <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  staged: 'New secret staged',
  verified: 'Connection test',
  cut_over: 'Cut over; previous secret kept',
  post_cut_over_check: 'Check after cut-over',
  completed: 'Completed; previous secret erased',
  rolled_back: 'Rolled back to the previous secret',
  cancelled: 'Cancelled',
};

/**
 * Stage, test, cut over, complete: the dual-secret rotation, one step per
 * press, each answered by the server with the rotation as it now stands.
 */
function RotationPanel({ item, onChanged }: { item: CredentialItem; onChanged(text?: string): void }) {
  const rotation = item.openRotation;
  const [secret, setSecret] = useState('');
  const [expires, setExpires] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(step: string, path: string, body?: unknown, success?: string) {
    setBusy(step);
    setFailure(null);
    try {
      await api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      setSecret('');
      onChanged(success);
    } catch (cause) {
      setFailure(problem(cause, 'That step did not complete.'));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  const base = rotation ? `/api/admin/credentials/rotations/${rotation.id}` : '';

  return (
    <div className="space-y-3 p-2">
      <div aria-live="polite">{failure ? <Alert tone="warning">{failure}</Alert> : null}</div>
      {!rotation && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="New secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={setSecret}
            warning={secret ? 'Keep the current secret valid until completion.' : undefined}
          />
          <Field label="New secret expires on (optional)" type="date" value={expires} onChange={setExpires} />
          <Field label="Reason (optional)" value={reason} onChange={setReason} maxLength={500} />
          <div className="sm:col-span-3">
            <Button
              variant="primary"
              size="sm"
              disabled={secret === ''}
              loading={busy === 'stage'}
              onClick={() =>
                void run(
                  'stage',
                  '/api/admin/credentials/rotations',
                  {
                    systemKind: item.rotation!.systemKind,
                    systemId: item.rotation!.systemId,
                    secret,
                    newExpiresAt: expires ? new Date(`${expires}T00:00:00Z`).toISOString() : null,
                    reason: reason.trim() === '' ? null : reason.trim(),
                  },
                  'New secret staged.',
                )
              }
            >
              Stage new secret
            </Button>
          </div>
        </div>
      )}
      {rotation && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Status tone={rotation.status === 'verification_failed' ? 'danger' : 'primary'}>
              {rotation.status.replace(/_/g, ' ')}
            </Status>
            {rotation.verificationMessage && <span className="text-sm text-muted">{rotation.verificationMessage}</span>}
          </div>
          <ol className="list-decimal space-y-0.5 pl-5 text-sm">
            {rotation.evidence.map((entry, index) => (
              <li key={index}>
                {STEP_LABEL[entry.step] ?? entry.step}
                {entry.ok === undefined ? '' : entry.ok ? ': passed' : ': failed'} · {new Date(entry.at).toLocaleString()}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {['staged', 'verified', 'verification_failed'].includes(rotation.status) && (
              <Button size="sm" loading={busy === 'verify'} onClick={() => void run('verify', `${base}/verify`)}>
                Test staged secret
              </Button>
            )}
            {rotation.status === 'verified' && (
              <Button
                variant="primary"
                size="sm"
                loading={busy === 'cutover'}
                onClick={() => void run('cutover', `${base}/cutover`, undefined, 'Cut over; previous secret kept.')}
              >
                Cut over
              </Button>
            )}
            {rotation.status === 'cut_over' && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === 'complete'}
                  onClick={() => void run('complete', `${base}/complete`, undefined, 'Rotation complete. Revoke the old secret at the issuer.')}
                >
                  Complete and erase old secret
                </Button>
                <Button
                  variant="danger-quiet"
                  size="sm"
                  loading={busy === 'rollback'}
                  onClick={() => void run('rollback', `${base}/rollback`, undefined, 'Rolled back to the previous secret.')}
                >
                  Roll back
                </Button>
              </>
            )}
            {['staged', 'verified', 'verification_failed'].includes(rotation.status) && (
              <Button
                variant="ghost"
                size="sm"
                loading={busy === 'cancel'}
                onClick={() => void run('cancel', `${base}/cancel`, undefined, 'Rotation cancelled.')}
              >
                Cancel rotation
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
