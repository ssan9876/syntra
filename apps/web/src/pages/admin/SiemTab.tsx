import { useState } from 'react';
import { Alert, Button, Check, Dialog, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

type Transport = 'https' | 'syslog';
type Format = 'json' | 'splunk-hec' | 'cef';

export interface AuditStream {
  id: string;
  name: string;
  enabled: boolean;
  transport: Transport;
  format: Format;
  url: string | null;
  host: string | null;
  port: number | null;
  tls: boolean;
  authHeader: string | null;
  hasCredential: boolean;
  behind: number;
  status: 'delivering' | 'behind' | 'failing' | 'paused';
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

const FORMAT_LABEL: Record<Format, string> = { json: 'JSON', 'splunk-hec': 'Splunk HEC', cef: 'CEF' };
const FORMATS: Record<Transport, Format[]> = { https: ['json', 'splunk-hec'], syslog: ['json', 'cef'] };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');
const destination = (s: AuditStream) =>
  s.transport === 'https' ? (s.url ?? '') : `${s.host}:${s.port}${s.tls ? ' (TLS)' : ''}`;

function problemText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;
}

/**
 * Settings -> SIEM: where the tenant's audit log is streamed. Every audit
 * event, in order, over HTTPS or syslog; a destination that is down gets the
 * same events when it is back, never a gap.
 */
export function SiemTab() {
  const { data, error, loading, reload } = useApiResource<{ streams: AuditStream[] }>('/api/admin/audit-streams');
  const [editing, setEditing] = useState<AuditStream | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AuditStream | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; title: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function test(stream: AuditStream) {
    setBusy(stream.id);
    setNotice(null);
    try {
      await api(`/api/admin/audit-streams/${stream.id}/test`, { method: 'POST', body: '{}' });
      setNotice({ ok: true, title: 'Test event accepted', text: `${stream.name}: ${destination(stream)}` });
    } catch (cause) {
      setNotice({ ok: false, title: 'Test event not accepted', text: problemText(cause, 'No answer.') });
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(stream: AuditStream, enabled: boolean) {
    setBusy(stream.id);
    try {
      await api(`/api/admin/audit-streams/${stream.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...bodyOf(stream), enabled }),
      });
      reload();
    } catch (cause) {
      setNotice({ ok: false, title: 'Not changed', text: problemText(cause, 'Request failed.') });
    } finally {
      setBusy(null);
    }
  }

  const streams = data?.streams ?? [];

  return (
    <div className="space-y-4">
      {notice ? (
        <Alert tone={notice.ok ? 'success' : 'danger'} title={notice.title}>
          {notice.text}
        </Alert>
      ) : null}
      <Panel
        title="SIEM streams"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            Add stream
          </Button>
        }
      >
        {loading && !data ? (
          <SkeletonRows rows={3} />
        ) : error ? (
          <div className="p-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : streams.length === 0 ? (
          <Empty title="No streams yet" />
        ) : (
          <Table label="SIEM streams">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Destination</th>
                <th scope="col">Format</th>
                <th scope="col">Status</th>
                <th scope="col">Last delivered</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {streams.map((stream) => (
                <tr key={stream.id}>
                  <th scope="row" className="font-medium">
                    {stream.name}
                  </th>
                  <td className="max-w-xs break-all font-mono text-sm">{destination(stream)}</td>
                  <td>{FORMAT_LABEL[stream.format]}</td>
                  <td>
                    <StreamStatus stream={stream} />
                  </td>
                  <td className="whitespace-nowrap">{when(stream.lastDeliveredAt)}</td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="secondary" loading={busy === stream.id} onClick={() => void test(stream)}>
                        Test
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(stream)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy === stream.id} onClick={() => void setEnabled(stream, !stream.enabled)}>
                        {stream.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(stream)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <p className="text-sm text-muted">
        To poll instead, read <code>GET /api/admin/audit/stream</code> with an API token holding <code>audit.read</code>.
      </p>
      {editing ? (
        <StreamDialog
          stream={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
      {deleting ? (
        <Dialog
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}?`}
          actions={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  void api(`/api/admin/audit-streams/${deleting.id}`, { method: 'DELETE' })
                    .then(() => {
                      setDeleting(null);
                      return reload();
                    })
                    .catch((cause: unknown) => setNotice({ ok: false, title: 'Not deleted', text: problemText(cause, 'Request failed.') }))
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <p>{destination(deleting)} stops receiving the audit log.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function StreamStatus({ stream }: { stream: AuditStream }) {
  switch (stream.status) {
    case 'paused':
      return <Status tone="neutral" glyph="minus">Paused</Status>;
    case 'failing':
      return (
        <div className="space-y-1">
          <Status tone="danger" glyph="blocked">Failing</Status>
          <p className="text-sm text-danger">{stream.lastError}</p>
        </div>
      );
    case 'behind':
      return <Status tone="warning" glyph="clock">{`Behind by ${stream.behind.toLocaleString()}`}</Status>;
    default:
      return <Status tone="active" glyph="check">Delivering</Status>;
  }
}

interface Draft {
  name: string;
  transport: Transport;
  format: Format;
  url: string;
  host: string;
  port: string;
  tls: boolean;
  authHeader: string;
  credential: string;
  startFrom: 'now' | 'beginning';
  enabled: boolean;
}

function bodyOf(stream: AuditStream) {
  return {
    name: stream.name,
    enabled: stream.enabled,
    transport: stream.transport,
    format: stream.format,
    url: stream.url,
    host: stream.host,
    port: stream.port,
    tls: stream.tls,
    authHeader: stream.authHeader,
  };
}

function StreamDialog({ stream, onClose, onSaved }: { stream: AuditStream | null; onClose(): void; onSaved(): void }) {
  const [draft, setDraft] = useState<Draft>({
    name: stream?.name ?? '',
    transport: stream?.transport ?? 'https',
    format: stream?.format ?? 'json',
    url: stream?.url ?? '',
    host: stream?.host ?? '',
    port: stream?.port ? String(stream.port) : '6514',
    tls: stream?.tls ?? true,
    authHeader: stream?.authHeader ?? 'Authorization',
    credential: '',
    startFrom: 'now',
    enabled: stream?.enabled ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  function setTransport(transport: Transport) {
    setDraft((current) => ({ ...current, transport, format: FORMATS[transport].includes(current.format) ? current.format : 'json' }));
  }

  async function save() {
    setBusy(true);
    setErrors({});
    setProblem(null);
    const body = {
      name: draft.name,
      enabled: draft.enabled,
      transport: draft.transport,
      format: draft.format,
      url: draft.transport === 'https' ? draft.url : null,
      host: draft.transport === 'syslog' ? draft.host : null,
      port: draft.transport === 'syslog' ? Number(draft.port) || null : null,
      tls: draft.tls,
      authHeader: draft.transport === 'https' ? draft.authHeader || null : null,
      // Blank on an existing stream keeps the stored credential.
      ...(draft.credential ? { credential: draft.credential } : stream ? {} : { credential: null }),
      ...(stream ? {} : { startFrom: draft.startFrom }),
    };
    try {
      await api(stream ? `/api/admin/audit-streams/${stream.id}` : '/api/admin/audit-streams', {
        method: stream ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (cause) {
      const fieldErrors = cause instanceof ApiError ? (cause.problem as { errors?: { path: string; message: string }[] }).errors : undefined;
      if (fieldErrors?.length) {
        setErrors(Object.fromEntries(fieldErrors.map((e) => [e.path, e.message])));
      } else {
        setProblem(problemText(cause, 'Not saved.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={stream ? `Edit ${stream.name}` : 'Add SIEM stream'}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={busy || !draft.name} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" value={draft.name} onChange={(v) => set('name', v)} error={errors['name']} />
        <Select
          label="Send over"
          value={draft.transport}
          onChange={(v) => setTransport(v as Transport)}
          options={[
            { value: 'https', label: 'HTTPS' },
            { value: 'syslog', label: 'Syslog (TCP)' },
          ]}
        />
        <Select
          label="Format"
          value={draft.format}
          onChange={(v) => set('format', v as Format)}
          options={FORMATS[draft.transport].map((format) => ({ value: format, label: FORMAT_LABEL[format] }))}
          error={errors['format']}
        />
        {draft.transport === 'https' ? (
          <>
            <Field
              label="URL"
              value={draft.url}
              onChange={(v) => set('url', v)}
              placeholder={draft.format === 'splunk-hec' ? 'https://splunk.example.com:8088/services/collector/event' : 'https://'}
              error={errors['url']}
            />
            <Field label="Header" value={draft.authHeader} onChange={(v) => set('authHeader', v)} error={errors['authHeader']} />
            <Field
              label="Header value"
              type="password"
              autoComplete="off"
              value={draft.credential}
              onChange={(v) => set('credential', v)}
              placeholder={stream?.hasCredential ? 'Unchanged' : draft.format === 'splunk-hec' ? 'Splunk <token>' : 'Bearer <token>'}
            />
          </>
        ) : (
          <>
            <Field label="Host" value={draft.host} onChange={(v) => set('host', v)} error={errors['host']} />
            <Field label="Port" inputMode="numeric" value={draft.port} onChange={(v) => set('port', v)} error={errors['port']} />
            <Check label="TLS" checked={draft.tls} onChange={(v) => set('tls', v)} />
          </>
        )}
        {stream ? null : (
          <Select
            label="Start with"
            value={draft.startFrom}
            onChange={(v) => set('startFrom', v as Draft['startFrom'])}
            options={[
              { value: 'now', label: 'New events only' },
              { value: 'beginning', label: 'The whole audit log' },
            ]}
          />
        )}
        {problem ? <Alert tone="danger">{problem}</Alert> : null}
      </div>
    </Dialog>
  );
}
