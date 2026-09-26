import { useState } from 'react';
import { Alert, Button, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * Emergency (break-glass) access: the accounts designated for it, how long
 * an activation waits before taking effect, and every activation with the
 * decisions still open on it -- approve early, cancel or end, and the
 * post-event review somebody other than the emergency account must write.
 *
 * Requesting an activation is not here. It happens at /break-glass, without
 * a session, because it exists for when nobody can sign in to this console.
 */

export interface BreakGlassActivation {
  id: string;
  userId: string;
  login: string | null;
  displayName: string | null;
  status: 'pending' | 'active' | 'ended' | 'expired' | 'cancelled';
  reason: string;
  durationMinutes: number;
  requestedAt: string;
  requestedFromIp: string | null;
  activatesAt: string;
  activatedAt: string | null;
  activatedBy: 'delay' | 'approval' | null;
  expiresAt: string | null;
  endedAt: string | null;
  reviewStatus: 'not_due' | 'pending' | 'completed';
  reviewedByUserId: string | null;
  reviewNotes: string | null;
}

export interface BreakGlassState {
  activationDelayMinutes: number;
  accounts: { userId: string; login: string | null; displayName: string | null; status: string; designatedAt: string; credentialIssuedAt: string }[];
  activations: BreakGlassActivation[];
  viewerUserId: string;
  policy: {
    delayBounds: { min: number; max: number };
    durationBounds: { min: number; max: number };
    reviewMinLength: number;
    stepUpMaxAgeMinutes: number;
  };
}

const STATUS: Record<BreakGlassActivation['status'], { label: string; tone: 'warning' | 'danger' | 'neutral' }> = {
  pending: { label: 'pending', tone: 'warning' },
  active: { label: 'active', tone: 'danger' },
  ended: { label: 'ended', tone: 'neutral' },
  expired: { label: 'expired', tone: 'neutral' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

function message(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : 'The request failed.';
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function BreakGlassTab() {
  const { data, error, loading, reload } = useApiResource<BreakGlassState>('/api/admin/break-glass');
  const users = useApiResource<{ users: { id: string; login: string; displayName: string }[] }>('/api/admin/users?pageSize=200');
  const [chosen, setChosen] = useState('');
  const [delay, setDelay] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, string>>({});
  const [credential, setCredential] = useState<{ login: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success'; text: string } | null>(null);

  if (loading && !data) return <SkeletonRows rows={3} cols={2} />;
  if (error || !data) return <Alert tone="danger">{error ?? 'Break-glass could not be loaded.'}</Alert>;

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await action(); } catch (cause) { setNotice({ tone: 'warning', text: message(cause) }); }
    finally { setBusy(null); }
  };

  const designated = new Set(data.accounts.map((account) => account.userId));
  const candidates = (users.data?.users ?? []).filter((user) => !designated.has(user.id) && user.id !== data.viewerUserId);
  const loginOf = (userId: string) => data.accounts.find((account) => account.userId === userId)?.login
    ?? users.data?.users.find((user) => user.id === userId)?.login ?? userId;

  const designate = () => run('designate', async () => {
    const issued = await api<{ credential: string; userId: string }>('/api/admin/break-glass/accounts', {
      method: 'POST', body: JSON.stringify({ userId: chosen }),
    });
    setCredential({ login: loginOf(issued.userId), value: issued.credential });
    setChosen('');
    reload();
  });
  const rotate = (userId: string) => run(`rotate:${userId}`, async () => {
    const issued = await api<{ credential: string }>(`/api/admin/break-glass/accounts/${userId}/rotate`, { method: 'POST' });
    setCredential({ login: loginOf(userId), value: issued.credential });
  });
  const remove = (userId: string) => run(`remove:${userId}`, async () => {
    await api(`/api/admin/break-glass/accounts/${userId}`, { method: 'DELETE' });
    setNotice({ tone: 'success', text: 'No longer an emergency account.' });
    reload();
  });
  const saveDelay = () => run('delay', async () => {
    await api('/api/admin/break-glass/settings', { method: 'PUT', body: JSON.stringify({ activationDelayMinutes: Number(delay) }) });
    setDelay(null);
    setNotice({ tone: 'success', text: 'Activation delay saved.' });
    reload();
  });
  const act = (activation: BreakGlassActivation, verb: 'approve' | 'end' | 'review') => run(`${verb}:${activation.id}`, async () => {
    await api(`/api/admin/break-glass/activations/${activation.id}/${verb}`, {
      method: 'POST',
      ...(verb === 'review' ? { body: JSON.stringify({ notes: reviews[activation.id] ?? '' }) } : {}),
    });
    setNotice({
      tone: 'success',
      text: verb === 'approve' ? 'Emergency access is active.' : verb === 'end' ? 'Emergency access ended.' : 'Review recorded.',
    });
    reload();
  });

  const delayValue = delay ?? String(data.activationDelayMinutes);
  const delayNumber = Number(delayValue);
  const delayValid = Number.isInteger(delayNumber) && delayNumber >= data.policy.delayBounds.min && delayNumber <= data.policy.delayBounds.max;

  return <div className="space-y-6">
    <div role="status" aria-live="polite">
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
    </div>

    {credential ? <Alert tone="warning" title={`Sealed credential for ${credential.login}`}>
      <p className="font-mono break-all">{credential.value}</p>
      <p className="mt-2 text-sm">Shown once — print it, seal it, keep it offline.</p>
      <Button variant="secondary" onClick={() => setCredential(null)}>It is stored offline</Button>
    </Alert> : null}

    <Panel title="Emergency accounts">
      <div className="space-y-4 p-4">
        {data.accounts.length === 0 ? <p className="text-sm text-muted">No account is designated.</p> : <ul className="divide-y divide-border-subtle">
          {data.accounts.map((account) => (
            <li key={account.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span>
                <span className="font-medium text-ink">{account.displayName ?? account.userId}</span>
                <span className="ml-2 text-sm text-muted">{account.login} · credential issued {when(account.credentialIssuedAt)}</span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy === `rotate:${account.userId}`} onClick={() => void rotate(account.userId)}>New credential</Button>
                <Button variant="secondary" loading={busy === `remove:${account.userId}`} onClick={() => void remove(account.userId)}>Remove</Button>
              </span>
            </li>
          ))}
        </ul>}
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Designate an account"
            value={chosen}
            onChange={setChosen}
            options={[{ value: '', label: 'Choose an account' }, ...candidates.map((user) => ({ value: user.id, label: `${user.displayName} (${user.login})` }))]}
          />
          <Button loading={busy === 'designate'} disabled={chosen === ''} onClick={() => void designate()}>Designate</Button>
        </div>
      </div>
    </Panel>

    <Panel title="Activation delay">
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field
          label="Minutes before an activation takes effect"
          value={delayValue}
          onChange={setDelay}
          inputMode="numeric"
          warning={delayValid ? undefined : `${data.policy.delayBounds.min}–${data.policy.delayBounds.max} minutes`}
        />
        <Button loading={busy === 'delay'} disabled={delay === null || !delayValid} onClick={() => void saveDelay()}>Save</Button>
      </div>
    </Panel>

    <Panel title="Activations">
      <div className="divide-y divide-border-subtle">
        {data.activations.length === 0 ? <p className="p-4 text-sm text-muted">No emergency access has been requested.</p> : null}
        {data.activations.map((activation) => {
          const self = activation.userId === data.viewerUserId;
          const notes = reviews[activation.id] ?? '';
          return <div key={activation.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-ink">{activation.displayName ?? activation.login ?? activation.userId}</span>
              <span className="flex gap-2">
                <Status tone={STATUS[activation.status].tone}>{STATUS[activation.status].label}</Status>
                {activation.reviewStatus === 'pending' ? <Status tone="warning">review due</Status> : null}
                {activation.reviewStatus === 'completed' ? <Status tone="neutral">reviewed</Status> : null}
              </span>
            </div>
            <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
              <dt className="text-muted">Reason</dt><dd>{activation.reason}</dd>
              <dt className="text-muted">Requested</dt><dd>{when(activation.requestedAt)}{activation.requestedFromIp ? ` from ${activation.requestedFromIp}` : ''}</dd>
              {activation.status === 'pending'
                ? <><dt className="text-muted">Takes effect</dt><dd>{when(activation.activatesAt)}</dd></>
                : <><dt className="text-muted">Window</dt><dd>{when(activation.activatedAt)} – {when(activation.endedAt ?? activation.expiresAt)}</dd></>}
              {activation.reviewNotes ? <><dt className="text-muted">Review</dt><dd>{activation.reviewNotes}</dd></> : null}
            </dl>
            {activation.status === 'pending' ? <div className="flex flex-wrap gap-3">
              {self ? null : <Button variant="danger" loading={busy === `approve:${activation.id}`} onClick={() => void act(activation, 'approve')}>Approve now</Button>}
              <Button variant="secondary" loading={busy === `end:${activation.id}`} onClick={() => void act(activation, 'end')}>Cancel</Button>
            </div> : null}
            {activation.status === 'active'
              ? <Button variant="danger" loading={busy === `end:${activation.id}`} onClick={() => void act(activation, 'end')}>End now</Button>
              : null}
            {activation.reviewStatus === 'pending' && !self ? <div className="space-y-3">
              <Field
                label="Review findings"
                value={notes}
                onChange={(value) => setReviews({ ...reviews, [activation.id]: value })}
                warning={notes.trim().length > 0 && notes.trim().length < data.policy.reviewMinLength ? `At least ${data.policy.reviewMinLength} characters` : undefined}
              />
              <Button loading={busy === `review:${activation.id}`} disabled={notes.trim().length < data.policy.reviewMinLength} onClick={() => void act(activation, 'review')}>Complete review</Button>
            </div> : null}
          </div>;
        })}
      </div>
    </Panel>
  </div>;
}
