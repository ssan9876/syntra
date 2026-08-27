import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Incident {
  kind: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  count: number;
  lastAt: string | null;
  href: string;
}

/**
 * What has quietly stopped working.
 *
 * **The failures were never invisible — they were visible in six places.** A
 * dead webhook receiver is on the webhooks page, a mail server that stopped
 * answering is a column on the outbox, a provisioning target whose credential
 * was rotated is a badge on the targets list. Each of those is somewhere an
 * administrator goes for a reason, and none is somewhere they go to ask "is
 * anything wrong".
 *
 * Every row links to the screen that can fix it, because a dashboard whose
 * rows are dead ends is a dashboard people read once.
 *
 * There is no dismiss. A row disappears when the thing behind it is fixed and
 * not before, so nobody can make this page look clean except by making it
 * true.
 */
export function IncidentsPage() {
  const { data, error, loading } = useApiResource<{ incidents: Incident[] }>(
    '/api/admin/incidents',
  );

  const incidents = data?.incidents ?? [];
  const critical = incidents.filter((i) => i.severity === 'critical').length;

  return (
    <>
      <PageHeader
        title="What needs attention"
        description="Things that have already failed — not warnings about what might."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={3} cols={2} />}

          {!loading && incidents.length === 0 && (
            <div className="p-6">
              {/* The answer somebody wants most often. A dashboard that
                  manufactures a row to look busy is one people stop reading. */}
              <Empty title="Nothing is broken">
                No undelivered messages, no skipped runs, no failed syncs.
              </Empty>
            </div>
          )}

          {!loading && incidents.length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {incidents.map((incident) => (
                <li key={incident.kind} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Status tone={incident.severity === 'critical' ? 'danger' : 'warning'}>
                          {incident.severity === 'critical' ? 'Broken' : 'Degraded'}
                        </Status>
                        <span className="font-medium text-ink">{incident.title}</span>
                      </div>
                      <p className="mt-1 max-w-[68ch] text-muted">{incident.detail}</p>
                      {incident.lastAt && (
                        <p className="mt-0.5 text-sm text-muted">
                          Last seen {new Date(incident.lastAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    {/* The screen that can fix it. A row that only states a
                        problem leaves the reader to work out where to go. */}
                    <Link className="link shrink-0 text-sm" to={incident.href}>
                      Go there
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {!loading && critical > 0 && (
        <p className="mt-3 text-sm text-muted">
          {critical} of these {critical === 1 ? 'is' : 'are'} something somebody
          believes is working.
        </p>
      )}
    </>
  );
}
