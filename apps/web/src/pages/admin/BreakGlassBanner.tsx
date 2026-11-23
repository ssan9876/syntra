import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@syntra/ui';
import { api } from '../../session/api.js';
import { useConsoleT } from '../../i18n/console/index.js';
import { useLocale } from '../../i18n/LocaleProvider.js';

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


/**
 * Shown on every console page while emergency access is pending or active,
 * or a post-event review is outstanding. Every administrator sees it,
 * whatever part of the console they work in: an emergency activation is the
 * one change nobody should be able to miss.
 *
 * Polls once a minute. A failed poll hides nothing it already showed.
 */
export function BreakGlassBanner() {
  const t = useConsoleT();
  const { format } = useLocale();
  const when = (iso: string | null) => (iso ? format.dateTime(iso) : '—');
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
            ? t('console.breakglass.active', {
                name: activation.displayName ?? t('console.breakglass.account'),
                until: when(activation.expiresAt),
              })
            : t('console.breakglass.requested', {
                name: activation.displayName ?? t('console.breakglass.account'),
                starts: when(activation.activatesAt),
              })}
        >
          {activation.id === status.viewerActivationId ? `${t('console.breakglass.you')} ` : ''}
          {t('console.breakglass.reason', { reason: activation.reason })}{' '}
          <Link className="link" to="/admin/settings?tab=break-glass">{t('console.breakglass.review')}</Link>
        </Alert>
      ))}
      {status.reviewsDue > 0 ? (
        <Alert tone="warning" title={t.plural('console.breakglass.reviews_due', status.reviewsDue)}>
          <Link className="link" to="/admin/settings?tab=break-glass">{t('console.breakglass.complete_review')}</Link>
        </Alert>
      ) : null}
    </div>
  );
}
