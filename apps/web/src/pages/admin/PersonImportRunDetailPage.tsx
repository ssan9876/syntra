import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Table, useToast } from '@syntra/ui';
import { api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';
import { ActionState, RunState } from './run-states.js';
import {
  CancelRunButton,
  CancellationStatus,
  cancelPending,
  isCancellable,
  type CancelState,
} from './RunCancellation.js';

interface ImportRun {
  id: string;
  sourceId: string;
  status: string;
  recordsRead: number;
  mappingFailures: number;
  mappingFailureReasons: string[];
  personsAbsent: number;
  requiresConfirmation: boolean;
  blockedReason: string | null;
  error: string | null;
  cancelState?: CancelState;
  cancelRequestedAt?: string | null;
  cancelResolvedAt?: string | null;
}

interface ImportChange {
  id: string;
  changeType: string;
  recordType: string;
  externalId: string | null;
  status: string;
  message: string | null;
  after: Record<string, unknown> | null;
}

interface RunPayload {
  run: ImportRun;
  changes: ImportChange[];
  denominators: { activePersonsFromSource: number };
}

const LABELS: Record<string, string> = {
  create_person: 'People to create',
  update_person: 'People to update',
  reactivate_person: 'People returning',
  create_contract: 'Contracts to create',
  update_contract: 'Contracts to update',
  end_contract: 'Contracts ending',
};

/** The run is still moving, so the page keeps asking. */
const RUNNING = new Set(['queued', 'running', 'applying']);
/** Statuses with something left to cancel, as the server's policy has them. */
const CANCELLABLE = ['queued', 'running', 'applying', 'previewed', 'blocked', 'partially_applied'];
/** Statuses in which a worker is active, so a cancel waits for a checkpoint. */
const WORKING = ['running', 'applying'];

export function PersonImportRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPayload(await api<RunPayload>(`/api/admin/person-import-runs/${id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Followed while this page's own apply POST is open, too: that is when the
  // run reads `applying`, and when Cancel is worth offering.
  useEffect(() => {
    if (!payload) return;
    if (!busy && !RUNNING.has(payload.run.status) && !cancelPending(payload.run)) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [payload, load, busy]);

  async function apply(confirm: boolean) {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/person-import-runs/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify(confirm ? { confirm: true } : {}),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function skip(changeId: string) {
    if (!id) return;
    await api(`/api/admin/person-import-runs/${id}/changes/${changeId}/skip`, {
      method: 'POST',
    });
    toast({ title: 'Change skipped' });
    await load();
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!payload) return <SkeletonRows />;

  const { run, changes, denominators } = payload;
  const departures = changes.filter((c) => c.changeType === 'depart_person');
  const rest = changes.filter((c) => c.changeType !== 'depart_person');
  const byType = new Map<string, ImportChange[]>();
  for (const change of rest) {
    byType.set(change.changeType, [...(byType.get(change.changeType) ?? []), change]);
  }

  // `partially_applied` too: a run somebody applied half of still has the
  // other half proposed, and a page that offered no action would strand it.
  const appliable =
    run.status === 'previewed' ||
    (run.status === 'partially_applied' && changes.some((c) => c.status === 'proposed'));
  const confirmable = run.status === 'blocked' && run.requiresConfirmation;

  return (
    <>
      <PageHeader
        title="Import run"
        status={<RunState status={run.status} />}
        actions={
          isCancellable(run, CANCELLABLE) ? (
            <CancelRunButton
              path={`/api/admin/person-import-runs/${run.id}/cancel`}
              run={run}
              working={WORKING}
              noun="import run"
              onChanged={() => void load()}
            />
          ) : undefined
        }
      />

      <CancellationStatus run={run} noun="import run" />

      <Panel title="What this run read">
        <p>
          {run.recordsRead} record{run.recordsRead === 1 ? '' : 's'} read.
        </p>

        {run.error && <Alert tone="danger">{run.error}</Alert>}

        {/*
          * Printed verbatim, not summarised. populationDropRefusal returns a
          * complete sentence for the reason its own comment gives: a refusal
          * that carries its own sentence is one the caller cannot paraphrase
          * into something less specific.
          */}
        {run.blockedReason && <Alert tone="warning">{run.blockedReason}</Alert>}

        {run.mappingFailures > 0 && (
          <Alert
            tone="warning"
            title={`${run.mappingFailures} row${run.mappingFailures === 1 ? '' : 's'} could not be mapped`}
          >
            <p>Not treated as leavers.</p>
            <ul>
              {run.mappingFailureReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Alert>
        )}

        {(appliable || confirmable) && (
          <div className="mt-3">
            <Button onClick={() => apply(confirmable)} disabled={busy}>
              {confirmable ? 'Apply — I have read the numbers' : 'Apply'}
            </Button>
          </div>
        )}
      </Panel>

      {/*
        * Leavers first, and with the count against the denominator the guard
        * measured -- so the administrator confirming reads the same number the
        * refusal was computed from, rather than confirming a bare count.
        */}
      {departures.length > 0 && (
        <Panel title="Leavers">
          {/* One string, not interpolated fragments: a sentence split across
              text nodes is one a reader's find, and a screen reader, meet in
              pieces. */}
          <p className="text-muted">
            {`${departures.length} of ${denominators.activePersonsFromSource} people this source owns`}
          </p>
          <Table stickyHeader label="Leavers">
            <thead>
              <tr>
                <th scope="col">Employee id</th>
                <th scope="col">Why</th>
                <th scope="col">State</th>
                <th scope="col"><span className="sr-only">Skip</span></th>
              </tr>
            </thead>
            <tbody>
              {departures.map((change) => (
                <tr key={change.id}>
                  <td>{change.externalId}</td>
                  <td>{change.message ?? 'not in the file'}</td>
                  <td>
                    <ActionState status={change.status} />
                  </td>
                  <td>
                    {change.status === 'proposed' && (
                      <Button variant="secondary" onClick={() => void skip(change.id)}>
                        Skip
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}

      {[...byType.entries()].map(([changeType, group]) => (
        <Panel key={changeType} title={`${LABELS[changeType] ?? changeType} (${group.length})`}>
          <Table stickyHeader label={`${LABELS[changeType] ?? changeType} changes`}>
            <thead>
              <tr>
                <th scope="col">Employee id</th>
                <th scope="col">Note</th>
                <th scope="col">State</th>
                <th scope="col"><span className="sr-only">Skip</span></th>
              </tr>
            </thead>
            <tbody>
              {group.map((change) => (
                <tr key={change.id}>
                  <td>{change.externalId}</td>
                  <td>{change.message ?? ''}</td>
                  <td>
                    <ActionState status={change.status} />
                  </td>
                  <td>
                    {change.status === 'proposed' && (
                      <Button variant="secondary" onClick={() => void skip(change.id)}>
                        Skip
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ))}

      {changes.length === 0 && (
        <Panel>
          <Empty title="Nothing to apply" />
        </Panel>
      )}
    </>
  );
}
