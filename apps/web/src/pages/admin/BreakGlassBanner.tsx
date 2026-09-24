import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@syntra/ui';
import { api } from '../../session/api.js';

export interface BreakGlassStatus {
  activations: {
    id: string;
    userId: string;
    displayName: string | null;
    status: 'pending' | 'active';
    reason: string;
    activatesAt: string;
    expiresAt: string | null;
  }[];
  reviewsDue: number;
  viewerActivationId: string | null;
}

const POLL_MS = 60_000;

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/**
 * Shown on every console page while emergency access is pending or active,
 * or a post-event review is outstanding. Every administrator sees it,
 * whatever part of the console they work in: an emergency activation is the
 * one change nobody should be able to miss.
 *
 * Polls once a minute. A failed poll hides nothing it already showed.
 */
export function BreakGlassBanner() {
  const [status, setStatus] = useState<BreakGlassStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<BreakGlassStatus>('/api/admin/break-glass/status')
      .then((next) => { if (alive) setStatus(next); })
      .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!status || (status.activations.length === 0 && status.reviewsDue === 0)) return null;

  return (
    <div className="mb-4 space-y-2">
      {status.activations.map((activation) => (
        <Alert
          key={activation.id}
          tone={activation.status === 'active' ? 'danger' : 'warning'}
          title={activation.status === 'active'
            ? `Emergency access is active for ${activation.displayName ?? 'an emergency account'} until ${when(activation.expiresAt)}`
            : `Emergency access requested for ${activation.displayName ?? 'an emergency account'}: takes effect ${when(activation.activatesAt)}`}
        >
          {activation.id === status.viewerActivationId ? 'You are signed in under this activation. ' : ''}
          Reason: {activation.reason}{' '}
          <Link className="link" to="/admin/settings?tab=break-glass">Review or end it</Link>
        </Alert>
      ))}
      {status.reviewsDue > 0 ? (
        <Alert tone="warning" title={`${status.reviewsDue} emergency access review${status.reviewsDue === 1 ? '' : 's'} outstanding`}>
          <Link className="link" to="/admin/settings?tab=break-glass">Complete the review</Link>
        </Alert>
      ) : null}
    </div>
  );
}
