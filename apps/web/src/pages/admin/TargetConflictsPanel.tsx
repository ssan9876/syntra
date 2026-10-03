import { useState } from 'react';
import { Alert, Button, Field, Panel, Table, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

interface Candidate {
  anchor: string;
  dn: string;
  correlationKey: string;
  matchedBy: 'name' | 'email';
}

interface ConflictRow {
  personId: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  correlationKey: string;
  candidate: Candidate | null;
}

interface AdoptResult {
  personId: string;
  adopted: boolean;
  anchor: string | null;
  message: string | null;
}

/**
 * Adopting every conflicted account on the target at once: the per-person
 * Adopt, for a target where many people already had an account. The list is a
 * live read of the target, so it loads on request, and only the objects shown
 * here are adopted.
 */
export function TargetConflictsPanel({ targetId }: { targetId: string }) {
  const base = `/api/admin/targets/${targetId}/conflicts`;
  const [rows, setRows] = useState<ConflictRow[] | null>(null);
  const [results, setResults] = useState<AdoptResult[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'read' | 'adopt' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  const problemOf = (cause: unknown, fallback: string) =>
    cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;

  async function load() {
    setBusy('read');
    setProblem(null);
    setResults(null);
    try {
      const answer = await api<{ accounts: ConflictRow[] }>(`${base}/adoption-preview`);
      setRows(answer.accounts);
    } catch (cause) {
      setProblem(problemOf(cause, 'Target not read.'));
    } finally {
      setBusy(null);
    }
  }

  const adoptable = (rows ?? []).filter((row) => row.candidate !== null);

  async function adopt() {
    setBusy('adopt');
    setProblem(null);
    try {
      const answer = await api<{ results: AdoptResult[] }>(`${base}/adopt`, {
        method: 'POST',
        body: JSON.stringify({
          reason,
          adoptions: adoptable.map((row) => ({ personId: row.personId, anchor: row.candidate!.anchor })),
        }),
      });
      setResults(answer.results);
      const adopted = answer.results.filter((result) => result.adopted).length;
      toast({ tone: 'success', title: `${adopted} of ${answer.results.length} adopted` });
    } catch (cause) {
      setProblem(problemOf(cause, 'Nothing was adopted.'));
    } finally {
      setBusy(null);
    }
  }

  const resultFor = (personId: string) => results?.find((result) => result.personId === personId);

  return (
    <Panel
      title="Accounts in conflict"
      actions={
        <Button size="sm" onClick={load} loading={busy === 'read'} disabled={busy !== null}>
          {rows === null ? 'Find conflicts' : 'Read again'}
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        {problem && <Alert tone="danger">{problem}</Alert>}
        {rows !== null && rows.length === 0 && <span className="text-muted">No accounts in conflict</span>}
        {rows !== null && rows.length > 0 && (
          <>
            <Table tight>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Reserved name</th>
                  <th scope="col">Account on the target</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const result = resultFor(row.personId);
                  return (
                    <tr key={row.personId}>
                      <th scope="row">
                        {row.givenName} {row.familyName}
                        {row.businessEmail && <div className="text-sm text-muted">{row.businessEmail}</div>}
                      </th>
                      <td className="font-mono">{row.correlationKey}</td>
                      <td>
                        {row.candidate ? (
                          <>
                            <span className="font-mono">{row.candidate.correlationKey}</span>
                            {row.candidate.matchedBy === 'email' && (
                              <span className="text-sm text-muted"> (by email)</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">No match</span>
                        )}
                      </td>
                      <td>
                        {result === undefined
                          ? ''
                          : result.adopted
                            ? 'Adopted'
                            : result.message}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {results === null && adoptable.length > 0 && (
              <>
                <Alert tone="warning">
                  Syntra manages these {adoptable.length} accounts from now on, including disabling them at leave.
                </Alert>
                <Field label="Why" value={reason} onChange={setReason} required />
                <Button
                  variant="primary"
                  onClick={adopt}
                  loading={busy === 'adopt'}
                  disabled={busy !== null || reason.trim() === ''}
                >
                  Adopt {adoptable.length} {adoptable.length === 1 ? 'account' : 'accounts'}
                </Button>
              </>
            )}
            {results !== null && <Alert tone="info">Adopted accounts are updated on the next run.</Alert>}
          </>
        )}
      </div>
    </Panel>
  );
}
