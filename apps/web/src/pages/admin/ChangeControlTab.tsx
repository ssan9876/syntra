import { useState } from 'react';
import { Alert, Button, Check, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, ChangeHeldError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * Separation of duties for privileged administrative changes.
 *
 * Two halves on one tab: which classes of change this organization holds for
 * a second administrator, and the queue of held changes. The queue offers
 * each person only what they may do -- the requester can withdraw, anyone
 * else with the class's permission can approve or reject -- and every refusal
 * the server gives is shown in its own words.
 */

export interface ChangeRequest {
  id: string;
  changeClass: string;
  operation: string;
  summary: string;
  reason: string;
  status: 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'expired' | 'invalidated';
  requestedByUserId: string;
  requestedAt: string;
  expiresAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  closedReason: string | null;
}

export interface ChangeControlState {
  classes: string[];
  catalog: { key: string; label: string; description: string; approverPermission: string }[];
  requests: ChangeRequest[];
  viewerUserId: string;
  policy: { approvalWindowHours: number; stepUpMaxAgeMinutes: number; reasonMinLength: number };
}

const STATUS: Record<ChangeRequest['status'], { label: string; tone: 'warning' | 'active' | 'neutral' | 'danger' }> = {
  pending: { label: 'awaiting approval', tone: 'warning' },
  applied: { label: 'applied', tone: 'active' },
  rejected: { label: 'rejected', tone: 'neutral' },
  withdrawn: { label: 'withdrawn', tone: 'neutral' },
  expired: { label: 'expired', tone: 'neutral' },
  invalidated: { label: 'stale', tone: 'danger' },
};

function message(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : 'The request failed.';
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** A secret the approval produced: shown once, never again. */
function secretOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const value = (result as { token?: unknown; secret?: unknown }).token ?? (result as { secret?: unknown }).secret;
  return typeof value === 'string' ? value : null;
}

export function ChangeControlTab() {
  const { data, error, loading, reload } = useApiResource<ChangeControlState>('/api/admin/change-control');
  const [selected, setSelected] = useState<string[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success'; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  if (loading && !data) return <SkeletonRows rows={3} cols={2} />;
  if (error || !data) return <Alert tone="danger">{error ?? 'Change control could not be loaded.'}</Alert>;

  const classes = selected ?? data.classes;
  const dirty = [...classes].sort().join(',') !== [...data.classes].sort().join(',');

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await action(); } catch (cause) {
      setNotice({ tone: cause instanceof ChangeHeldError ? 'success' : 'warning', text: message(cause) });
      if (cause instanceof ChangeHeldError) { setSelected(null); reload(); }
    } finally { setBusy(null); }
  };

  const savePolicy = () => run('policy', async () => {
    await api('/api/admin/change-control/policy', { method: 'PUT', body: JSON.stringify({ classes }) });
    setSelected(null);
    setNotice({ tone: 'success', text: 'Change control saved.' });
    reload();
  });

  const decide = (request: ChangeRequest, verb: 'approve' | 'reject' | 'withdraw') => run(`${verb}:${request.id}`, async () => {
    const note = notes[request.id]?.trim();
    const response = await api<{ result?: unknown }>(`/api/admin/change-control/requests/${request.id}/${verb}`, {
      method: 'POST',
      body: JSON.stringify(verb === 'withdraw' ? {} : { note: note || null }),
    });
    setSecret(verb === 'approve' ? secretOf(response.result) : null);
    setNotice({ tone: 'success', text: verb === 'approve' ? 'Approved and applied.' : verb === 'reject' ? 'Rejected.' : 'Withdrawn.' });
    reload();
  });

  const pending = data.requests.filter((request) => request.status === 'pending');
  const closed = data.requests.filter((request) => request.status !== 'pending');

  return <div className="space-y-6">
    <div role="status" aria-live="polite">
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
    </div>

    {secret ? <Alert tone="warning" title="Copy this secret now">
      <p className="font-mono break-all">{secret}</p>
      <p className="mt-2 text-sm">It is shown once and stored nowhere. Hand it to whoever asked for the change through your usual secure channel.</p>
      <Button variant="secondary" onClick={() => setSecret(null)}>I have copied it</Button>
    </Alert> : null}

    <Panel title="Held for a second administrator">
      <div className="space-y-3 p-4">
        {data.catalog.map((entry) => (
          <Check
            key={entry.key}
            label={entry.label}
            checked={classes.includes(entry.key)}
            onChange={(on) => setSelected(on ? [...classes, entry.key] : classes.filter((key) => key !== entry.key))}
          />
        ))}
        {dirty && data.classes.some((key) => !classes.includes(key))
          ? <p className="text-sm text-warning">Switching a class off is itself held for a second administrator.</p>
          : null}
        <Button loading={busy === 'policy'} disabled={!dirty} onClick={() => void savePolicy()}>Save</Button>
      </div>
    </Panel>

    <Panel title="Awaiting approval" actions={<Status tone={pending.length > 0 ? 'warning' : 'neutral'}>{String(pending.length)}</Status>}>
      <div className="divide-y divide-border-subtle">
        {pending.length === 0 ? <p className="p-4 text-sm text-muted">Nothing is waiting.</p> : null}
        {pending.map((request) => {
          const own = request.requestedByUserId === data.viewerUserId;
          return <div key={request.id} className="space-y-3 p-4">
            <p className="font-medium text-ink">{request.summary}</p>
            <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
              <dt className="text-muted">Reason</dt><dd>{request.reason}</dd>
              <dt className="text-muted">Requested</dt><dd>{when(request.requestedAt)}{own ? ' (by you)' : ''}</dd>
              <dt className="text-muted">Expires</dt><dd>{when(request.expiresAt)}</dd>
            </dl>
            {own
              ? <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted">A different administrator must approve this.</p>
                  <Button variant="secondary" loading={busy === `withdraw:${request.id}`} onClick={() => void decide(request, 'withdraw')}>Withdraw</Button>
                </div>
              : <div className="space-y-3">
                  <Field
                    label="Note (optional)"
                    value={notes[request.id] ?? ''}
                    onChange={(value) => setNotes({ ...notes, [request.id]: value })}
                  />
                  <div className="flex flex-wrap gap-3">
                    <Button variant="primary" loading={busy === `approve:${request.id}`} onClick={() => void decide(request, 'approve')}>Approve and apply</Button>
                    <Button variant="secondary" loading={busy === `reject:${request.id}`} onClick={() => void decide(request, 'reject')}>Reject</Button>
                  </div>
                </div>}
          </div>;
        })}
      </div>
    </Panel>

    {closed.length > 0 ? <Panel title="Recent decisions">
      <ul className="divide-y divide-border-subtle">
        {closed.map((request) => (
          <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="text-ink">{request.summary}</span>
            <Status tone={STATUS[request.status].tone}>{STATUS[request.status].label}</Status>
          </li>
        ))}
      </ul>
    </Panel> : null}
  </div>;
}
