import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  DensityToggle,
  Empty,
  Field,
  Panel,
  RefreshStatus,
  Select,
  SkeletonRows,
  StateBadge,
  Table,
  TableToolbar,
  buttonClasses,
  useDensity,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface AuditEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  sourceIp: string | null;
  payload: Record<string, unknown>;
}

interface AuditResponse {
  events: AuditEvent[];
  nextBefore: number | null;
  chainValid: boolean;
  brokenAtSequence?: number;
}

/**
 * The filters as the server takes them: the same object is the query string
 * here, the `params` of an audit export, and a saved search. Empty strings
 * never leave this module -- an empty filter is an absent one.
 */
export interface AuditFilters {
  actor?: string;
  action?: string;
  target?: string;
  outcome?: 'success' | 'failure';
  from?: string;
  to?: string;
}

interface SavedView {
  id: string;
  name: string;
  filters: AuditFilters;
}

const PAGE_SIZE = 50;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** `datetime-local` is wall-clock time in the browser's zone; the server takes an instant. */
const toInstant = (local: string) => (local === '' ? undefined : new Date(local).toISOString());
const toLocal = (iso: string | undefined) => {
  if (iso === undefined) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function auditQuery(filters: AuditFilters, before: number | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  if (before !== null) params.set('before', String(before));
  return `/api/admin/audit?${params.toString()}`;
}

function clean(draft: Record<keyof AuditFilters, string>): AuditFilters {
  const out: AuditFilters = {};
  if (draft.actor.trim()) out.actor = draft.actor.trim();
  if (draft.action.trim()) out.action = draft.action.trim();
  if (draft.target.trim()) out.target = draft.target.trim();
  if (draft.outcome === 'success' || draft.outcome === 'failure') out.outcome = draft.outcome;
  const from = toInstant(draft.from);
  const to = toInstant(draft.to);
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

const draftOf = (f: AuditFilters): Record<keyof AuditFilters, string> => ({
  actor: f.actor ?? '',
  action: f.action ?? '',
  target: f.target ?? '',
  outcome: f.outcome ?? '',
  from: toLocal(f.from),
  to: toLocal(f.to),
});

export function AuditTab() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [draft, setDraft] = useState(draftOf({}));
  // Keyset paging: the cursors of the pages behind this one, so "Newer" can
  // go back without the server having to page upwards.
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1] ?? null;
  const { data, error, loading, updatedAt, reload } = useApiResource<AuditResponse>(
    auditQuery(filters, before),
  );
  const [density, setDensity] = useDensity('audit');
  const toast = useToast();
  const views = useApiResource<{ views: SavedView[] }>('/api/admin/audit/views');
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string; exportId?: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [viewName, setViewName] = useState('');

  const apply = (next: AuditFilters) => {
    setFilters(next);
    setDraft(draftOf(next));
    setCursors([null]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply(clean(draft));
  };

  const set = (key: keyof AuditFilters) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  async function exportResults() {
    setExporting(true);
    setNotice(null);
    try {
      const res = await api<{ export: { id: string } }>('/api/admin/exports', {
        method: 'POST',
        body: JSON.stringify({ kind: 'audit_log', params: filters }),
      });
      setNotice({ tone: 'info', text: 'Export requested.', exportId: res.export.id });
    } catch (cause) {
      setNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The export could not be requested.',
      });
    } finally {
      setExporting(false);
    }
  }

  async function saveCurrent() {
    const name = viewName.trim();
    if (name === '') return;
    try {
      await api('/api/admin/audit/views', { method: 'PUT', body: JSON.stringify({ name, filters }) });
      setViewName('');
      // A saved search is confirmed in passing; an export keeps its inline
      // receipt below, because it carries the link to follow it.
      toast({ title: `Saved “${name}”` });
      views.reload();
    } catch (cause) {
      setNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The search could not be saved.',
      });
    }
  }

  const savedViews = views.data?.views ?? [];
  const events = data?.events ?? [];

  return (
    <>
      <form onSubmit={submit} aria-label="Audit search" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Action starts with" value={draft.action} onChange={set('action')} placeholder="auth." />
        <Field label="Actor id" value={draft.actor} onChange={set('actor')} />
        <Field label="Target id" value={draft.target} onChange={set('target')} />
        <Select
          label="Outcome"
          value={draft.outcome}
          onChange={set('outcome')}
          options={[
            { value: '', label: 'Any' },
            { value: 'success', label: 'Success' },
            { value: 'failure', label: 'Failure' },
          ]}
        />
        <Field label="From" type="datetime-local" value={draft.from} onChange={set('from')} />
        <Field label="Until" type="datetime-local" value={draft.to} onChange={set('to')} />
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit" variant="primary">
            Search
          </Button>
          <Button type="button" variant="ghost" onClick={() => apply({})}>
            Clear
          </Button>
          <Button type="button" loading={exporting} onClick={() => void exportResults()}>
            Export these results
          </Button>
        </div>
      </form>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        {savedViews.length > 0 && (
          <Select
            label="Saved searches"
            value=""
            onChange={(id) => {
              const view = savedViews.find((v) => v.id === id);
              if (view) apply(view.filters);
            }}
            options={[{ value: '', label: 'Choose…' }, ...savedViews.map((v) => ({ value: v.id, label: v.name }))]}
          />
        )}
        <Field label="Save this search as" value={viewName} onChange={setViewName} maxLength={80} />
        <Button type="button" onClick={() => void saveCurrent()} disabled={viewName.trim() === ''}>
          Save
        </Button>
      </div>

      {/* Present on every render, so a screen reader hears the change: an
          export requested, a search saved, or the failure of either. */}
      <div role="status" aria-live="polite" className="mb-4">
        {notice && (
          <Alert tone={notice.tone}>
            {notice.text}{' '}
            {notice.exportId && (
              <Link className="link" to="/admin/activity?tab=exports">
                Follow it in Exports
              </Link>
            )}
          </Alert>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && data && !data.chainValid && (
        // Rendering a tampered log as if it were trustworthy would be worse
        // than having no log, so the warning leads the page.
        <div className="mb-6">
          <Alert tone="danger" title="This audit log has been altered">
            Verification failed at entry {data.brokenAtSequence}. An entry at or
            before that point was changed or removed outside Syntra. Treat
            everything below as unverified and investigate the database
            directly.
          </Alert>
        </div>
      )}

      {!error && data?.chainValid && events.length > 0 && (
        <p className="mb-4 flex items-center gap-2 text-muted">
          <StateBadge state="healthy">Chain verified</StateBadge>
          <span>No entry has been altered or removed.</span>
        </p>
      )}

      {!error && data && (
        <TableToolbar>
          <RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={loading} />
          <DensityToggle value={density} onChange={setDensity} />
        </TableToolbar>
      )}

      {!error && (
        <Panel>
          {!data && loading && <SkeletonRows rows={8} cols={4} />}

          {data && events.length === 0 && Object.keys(filters).length > 0 && (
            <div className="p-6">
              <Empty
                title="No matching events"
                action={
                  <Button variant="secondary" onClick={() => apply({})}>
                    Reset filters
                  </Button>
                }
              />
            </div>
          )}

          {data && events.length === 0 && Object.keys(filters).length === 0 && (
            <div className="p-6">
              <Empty title="Nothing recorded yet">
                Sign-ins, account changes and permission grants appear here as they happen.
              </Empty>
            </div>
          )}

          {data && events.length > 0 && (
            <Table stickyHeader label="Audit log" density={density}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="max-lg:hidden">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="tabular-nums">{event.sequence}</td>
                    <td className="whitespace-nowrap">{when(event.occurredAt)}</td>
                    <td className="text-ink">{event.action}</td>
                    <td>
                      {event.outcome === 'success' ? (
                        <StateBadge state="healthy">Success</StateBadge>
                      ) : (
                        <StateBadge state="blocked">
                          {event.outcome.charAt(0).toUpperCase() + event.outcome.slice(1)}
                        </StateBadge>
                      )}
                    </td>
                    <td className="max-w-[28ch] truncate max-lg:hidden">{summarize(event.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      {/* Keyset paging has no total -- counting a log that grows for ever is
          the cost this search exists to avoid -- so the pager says where you
          are by the entries on screen, and each button is disabled rather
          than hidden at its end, as the list pager does. */}
      <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
        <span aria-live="polite" aria-atomic="true">
          {events.length === 0
            ? 'No results'
            : `Entries ${events[events.length - 1]!.sequence}–${events[0]!.sequence}`}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClasses('secondary', 'md', 'aria-disabled:opacity-55 aria-disabled:pointer-events-none')}
            aria-disabled={cursors.length <= 1 || undefined}
            onClick={() => {
              if (cursors.length > 1) setCursors((c) => c.slice(0, -1));
            }}
          >
            Newer
          </button>
          <button
            type="button"
            className={buttonClasses('secondary', 'md', 'aria-disabled:opacity-55 aria-disabled:pointer-events-none')}
            aria-disabled={!data?.nextBefore || undefined}
            onClick={() => {
              const next = data?.nextBefore;
              if (next) setCursors((c) => [...c, next]);
            }}
          >
            Older
          </button>
        </div>
      </nav>
    </>
  );
}

/** The payload shape varies by action, so render it as readable pairs. */
function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
}
