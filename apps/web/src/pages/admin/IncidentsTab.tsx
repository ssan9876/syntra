import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  Panel,
  RefreshStatus,
  SkeletonRows,
  StateBadge,
  TableToolbar,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { IncidentCard, type Incident } from './IncidentCard.js';
import {
  ATTENTION_URL,
  changeRequestSentence,
  heldActionsSentence,
  lifecycleSentences,
  runSentence,
  type AttentionSummary,
} from './attention.js';


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
export function IncidentsTab() {
  const { data, error, loading, updatedAt, reload } = useApiResource<{ incidents: Incident[] }>(
    '/api/admin/incidents',
  );

  const incidents = data?.incidents ?? [];
  // Work waiting for a decision, beside what is broken. Read separately: it
  // is gated per section on the viewer's own permissions, not on audit.read,
  // and a failure to read it must not hide the incidents.
  const attention = useApiResource<AttentionSummary>(ATTENTION_URL);
  const runs = attention.data?.provisionRuns?.items ?? [];
  const moreRuns = (attention.data?.provisionRuns?.count ?? 0) - runs.length;
  const lifecycle = attention.data?.lifecycle ? lifecycleSentences(attention.data.lifecycle) : [];
  const changes = attention.data?.changeRequests?.count ?? 0;
  const held = attention.data?.heldActions?.items ?? [];
  const waiting = runs.length > 0 || held.length > 0 || lifecycle.length > 0 || changes > 0;

  return (
    <>
      {waiting && (
        <Panel>
          <h2 className="px-4 pt-4 text-md font-semibold text-ink">Waiting for a decision</h2>
          <ul className="divide-y divide-border-subtle">
            {runs.map((run) => (
              <li key={run.runId} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateBadge state="attention">
                        {run.status === 'blocked' ? 'Held for review' : 'Awaiting apply'}
                      </StateBadge>
                      <span className="font-medium text-ink">{runSentence(run)}</span>
                    </div>
                    {run.planned && run.status === 'blocked' && (
                      <p className="mt-1 max-w-[68ch] text-muted">The plan would {run.planned.replace(/^would /, '')}.</p>
                    )}
                    <p className="mt-0.5 text-sm text-muted">
                      Planned {new Date(run.startedAt).toLocaleString()}
                      {run.status === 'blocked' && run.requiresConfirmation && (
                        <span className="text-warning"> · Blocks this target&rsquo;s runs</span>
                      )}
                    </p>
                  </div>
                  <Link className="link shrink-0 text-sm" to={run.href}>
                    Review the run
                  </Link>
                </div>
              </li>
            ))}
            {moreRuns > 0 && (
              <li className="p-4 text-muted">
                {moreRuns} more provisioning {moreRuns === 1 ? 'run' : 'runs'} waiting
              </li>
            )}
            {held.map((item) => (
              <li key={`held-${item.runId}`} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateBadge state="attention">Held action</StateBadge>
                      <span className="font-medium text-ink">{heldActionsSentence(item)}</span>
                    </div>
                  </div>
                  <Link className="link shrink-0 text-sm" to={item.href}>
                    Review and approve
                  </Link>
                </div>
              </li>
            ))}
            {lifecycle.map((line) => (
              <li key={line} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <span className="font-medium text-ink">{line}</span>
                <Link className="link shrink-0 text-sm" to="/admin/employee-work">Open employee work</Link>
              </li>
            ))}
            {changes > 0 && (
              <li className="flex flex-wrap items-start justify-between gap-3 p-4">
                <span className="font-medium text-ink">{changeRequestSentence(changes)}</span>
                <Link className="link shrink-0 text-sm" to="/admin/settings?tab=change-control">Open change control</Link>
              </li>
            )}
          </ul>
        </Panel>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {/* How old "nothing is broken" is matters as much as the answer: a
          clean page left open since this morning is this morning's answer. */}
      {!error && data && (
        <TableToolbar>
          <RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={loading} />
        </TableToolbar>
      )}

      {!error && (
        <div className={waiting ? 'mt-4' : undefined}>
        <Panel>
          {!data && loading && <SkeletonRows rows={3} cols={2} />}

          {data && incidents.length === 0 && (
            <div className="p-6">
              {/* The answer somebody wants most often. A dashboard that
                  manufactures a row to look busy is one people stop reading. */}
              <Empty title="Nothing is broken" />
            </div>
          )}

          {incidents.length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {incidents.map((incident) => (
                <IncidentCard key={incident.kind} incident={incident} onChanged={reload} />
              ))}
            </ul>
          )}
        </Panel>
        </div>
      )}

    </>
  );
}
