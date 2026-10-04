import { useState } from 'react';
import { Alert, Button, Field, Panel, SkeletonRows, Table, useToast, type ComboOption } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PersonPicker } from './PickerNote.js';

export interface TargetExclusion {
  personId: string;
  personName: string;
  businessEmail: string | null;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  message: string;
}

const problemOf = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;

/**
 * The people left out of this target: no account is created for them here
 * and the one they have is no longer managed, whatever the business rules
 * say. Adding and removing both take a reason, which goes on the audit event.
 */
export function TargetExclusionsPanel({
  targetId,
  canManage,
}: {
  targetId: string;
  canManage: boolean;
}) {
  const base = `/api/admin/targets/${targetId}/exclusions`;
  const { data, error, loading, reload } = useApiResource<{ exclusions: TargetExclusion[] }>(base);
  const [adding, setAdding] = useState(false);
  const [person, setPerson] = useState<ComboOption | null>(null);
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  const rows = data?.exclusions ?? [];

  async function add() {
    if (person === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(base, {
        method: 'POST',
        body: JSON.stringify({ personId: person.value, reason }),
      });
      toast({ tone: 'success', title: `${person.label} left out` });
      setAdding(false);
      setPerson(null);
      setReason('');
      reload();
    } catch (cause) {
      setProblem(problemOf(cause, 'Not saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: TargetExclusion) {
    setBusy(true);
    setProblem(null);
    try {
      await api(`${base}/${row.personId}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: removeReason }),
      });
      toast({ tone: 'success', title: `${row.personName} included again` });
      setRemoving(null);
      setRemoveReason('');
      reload();
    } catch (cause) {
      setProblem(problemOf(cause, 'Not saved.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Left out"
      actions={
        canManage && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4 p-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}

        {adding && (
          <div className="space-y-3">
            <PersonPicker label="Person" value={person} onChange={setPerson} />
            <Field
              label="Why"
              value={reason}
              onChange={setReason}
              required
              placeholder="Bootstrap administrator of this application"
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={busy || person === null || reason.trim() === ''}
                onClick={add}
              >
                Leave out
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {loading && !data ? (
          <SkeletonRows rows={2} cols={3} />
        ) : rows.length === 0 ? (
          <span className="text-muted">No one is left out</span>
        ) : (
          <Table tight>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Why</th>
                {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.personId}>
                  <th scope="row">
                    {row.personName}
                    {row.businessEmail && <div className="text-sm text-muted">{row.businessEmail}</div>}
                  </th>
                  <td>{row.message}</td>
                  {canManage && (
                    <td>
                      {removing === row.personId ? (
                        <div className="space-y-2">
                          <Field label="Why" value={removeReason} onChange={setRemoveReason} required />
                          <div className="flex gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              loading={busy}
                              disabled={busy || removeReason.trim() === ''}
                              onClick={() => remove(row)}
                            >
                              Remove
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setRemoving(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRemoving(row.personId);
                            setRemoveReason('');
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Panel>
  );
}
