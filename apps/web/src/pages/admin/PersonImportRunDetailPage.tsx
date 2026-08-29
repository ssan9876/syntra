import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

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
const RUNNING = new Set(['queued', 'running']);

export function PersonImportRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (!payload || !RUNNING.has(payload.run.status)) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [payload, load]);

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

  const appliable = run.status === 'previewed';
  const confirmable = run.status === 'blocked' && run.requiresConfirmation;

  return (
    <>
      <PageHeader title="Import run" />

      <Panel title="What this run read">
        <p>
          {run.recordsRead} record{run.recordsRead === 1 ? '' : 's'} read.{' '}
          <Status tone={run.status === 'failed' ? 'danger' : 'neutral'}>{run.status}</Status>
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
          <Alert tone="warning">
            <p>
              {run.mappingFailures} row{run.mappingFailures === 1 ? ' was' : 's were'} read
              but could not be mapped. They are not treated as leavers.
            </p>
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
          <Table>
            <thead>
              <tr>
                <th scope="col">Employee id</th>
                <th scope="col">Why</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {departures.map((change) => (
                <tr key={change.id}>
                  <td>{change.externalId}</td>
                  <td>{change.message ?? 'not in the file'}</td>
                  <td>
                    <Status tone={change.status === 'skipped' ? 'neutral' : 'warning'}>
                      {change.status}
                    </Status>
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
          <Table>
            <thead>
              <tr>
                <th scope="col">Employee id</th>
                <th scope="col">Note</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {group.map((change) => (
                <tr key={change.id}>
                  <td>{change.externalId}</td>
                  <td>{change.message ?? ''}</td>
                  <td>
                    <Status tone={change.status === 'failed' ? 'danger' : 'neutral'}>
                      {change.status}
                    </Status>
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
          <Empty title="Nothing to apply">
            The file matches the person register, so this run proposes no changes.
          </Empty>
        </Panel>
      )}
    </>
  );
}
