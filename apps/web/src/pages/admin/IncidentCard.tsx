import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, StateBadge, Status, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { ago } from './DashboardPage.js';

export interface IncidentItem {
  label: string;
  detail: string | null;
  at: string | null;
  href: string | null;
}

export interface Incident {
  kind: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  count: number;
  lastAt: string | null;
  href: string;
  items?: IncidentItem[];
  resolvable?: boolean;
  acknowledged?: { at: string; by: string | null; note: string | null } | null;
}

/** Items shown before "Show all": enough to see the pattern, not a wall. */
const FOLD = 3;

/**
 * One incident: what is wrong, every failure behind it with the error it gave,
 * and what a person can say about it.
 *
 * The items are the point. "14 provisioning runs failed" is a count; the run
 * underneath, its target and "401 Unauthorized" are what somebody can act on,
 * and each links to the run itself rather than to a list to search.
 *
 * Acknowledge hides nothing -- it marks the incident as being handled, by
 * whom, and lapses when something newer fails. Resolve is offered only for
 * events (a condition clears when it is fixed) and is a watermark: a new
 * failure brings the incident straight back.
 */
export function IncidentCard({ incident, onChanged }: { incident: Incident; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState<'acknowledge' | 'resolve' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const items = incident.items ?? [];
  const shown = open ? items : items.slice(0, FOLD);
  const ack = incident.acknowledged ?? null;

  const submit = async () => {
    if (!acting) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/incidents/${incident.kind}/${acting}`, {
        method: 'POST',
        body: JSON.stringify(note.trim() === '' ? {} : { note: note.trim() }),
      });
      toast({ tone: 'success', title: acting === 'resolve' ? 'Resolved' : 'Acknowledged' });
      setActing(null);
      setNote('');
      onChanged();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Not saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {incident.severity === 'critical' ? (
              <StateBadge state="blocked">Broken</StateBadge>
            ) : (
              <StateBadge state="attention">Degraded</StateBadge>
            )}
            <span className="font-medium text-ink">{incident.title}</span>
            {ack && (
              <Status tone="info" glyph="check">
                Acknowledged{ack.by ? ` by ${ack.by}` : ''} · {ago(ack.at)}
              </Status>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {incident.detail}
            {incident.lastAt && (
              <>
                {' · '}
                <time dateTime={incident.lastAt} title={new Date(incident.lastAt).toLocaleString()}>
                  last {ago(incident.lastAt)}
                </time>
              </>
            )}
          </p>
          {ack?.note && <p className="mt-1 text-sm text-ink">“{ack.note}”</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!ack && acting === null && (
            <Button size="sm" variant="secondary" onClick={() => setActing('acknowledge')}>
              Acknowledge
            </Button>
          )}
          {incident.resolvable && acting === null && (
            <Button size="sm" variant="secondary" onClick={() => setActing('resolve')}>
              Resolve
            </Button>
          )}
          <Link className="link text-sm" to={incident.href}>
            Open
          </Link>
        </div>
      </div>

      {acting && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 rounded-panel bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Field
              name="note"
              label={acting === 'resolve' ? 'Resolution note' : 'Note'}
              value={note}
              onChange={setNote}
              maxLength={500}
              placeholder={acting === 'resolve' ? 'Rotated the bind password' : 'Looking into it'}
            />
          </div>
          <Button type="submit" size="sm" variant="primary" loading={busy}>
            {acting === 'resolve' ? 'Resolve' : 'Acknowledge'}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setActing(null)}>
            Cancel
          </Button>
          {problem && (
            <div className="basis-full">
              <Alert tone="warning">{problem}</Alert>
            </div>
          )}
        </form>
      )}

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle rounded-panel border border-border-subtle">
          {shown.map((item, index) => (
            <li key={`${item.label}-${item.at ?? index}`} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-baseline sm:gap-3">
              <span className="truncate text-sm font-medium text-ink">
                {item.href ? (
                  <Link to={item.href} className="underline-offset-2 hover:text-primary hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </span>
              <span className="break-words font-mono text-xs text-danger">
                {item.detail ?? <span className="font-sans text-muted">No error recorded</span>}
              </span>
              {item.at && (
                <time
                  dateTime={item.at}
                  title={new Date(item.at).toLocaleString()}
                  className="text-xs tabular-nums text-muted sm:text-right"
                >
                  {ago(item.at)}
                </time>
              )}
            </li>
          ))}
          {items.length > FOLD && (
            <li className="px-3 py-1.5">
              <button
                type="button"
                className="text-sm font-medium text-accent underline underline-offset-2 hover:text-primary"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
              >
                {open ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
