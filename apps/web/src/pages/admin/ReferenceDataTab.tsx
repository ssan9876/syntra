import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

type ReferenceKind = 'department' | 'location';

interface ReferenceValue {
  id: string;
  kind: ReferenceKind;
  value: string;
  active: boolean;
}

const groups: { kind: ReferenceKind; title: string; singular: string }[] = [
  { kind: 'department', title: 'Departments', singular: 'department' },
  { kind: 'location', title: 'Locations', singular: 'location' },
];

export function ReferenceDataTab() {
  const resource = useApiResource<{ values: ReferenceValue[] }>('/api/admin/identity-reference-values');
  const [drafts, setDrafts] = useState<Record<ReferenceKind, string>>({ department: '', location: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function add(kind: ReferenceKind) {
    const value = drafts[kind].trim();
    if (!value) return;
    setBusy(`add:${kind}`);
    setProblem(null);
    try {
      await api('/api/admin/identity-reference-values', {
        method: 'POST',
        body: JSON.stringify({ kind, value }),
      });
      setDrafts((current) => ({ ...current, [kind]: '' }));
      resource.reload();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The reference value could not be added.');
    } finally {
      setBusy(null);
    }
  }

  async function setActive(item: ReferenceValue) {
    setBusy(item.id);
    setProblem(null);
    try {
      await api(`/api/admin/identity-reference-values/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !item.active }),
      });
      resource.reload();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The reference value could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  if (resource.error) return <Alert tone="danger">{resource.error}</Alert>;

  return (
    <div className="space-y-4">
      {problem && <Alert tone="danger" aria-live="assertive">{problem}</Alert>}
      {resource.loading && <Panel><div className="p-6" role="status">Loading reference data…</div></Panel>}
      {!resource.loading && groups.map(({ kind, title, singular }) => {
        const values = (resource.data?.values ?? []).filter((item) => item.kind === kind);
        const enforced = values.some((item) => item.active);
        return (
          <Panel
            key={kind}
            title={title}
            actions={<Status tone={enforced ? 'active' : 'neutral'}>{enforced ? 'Enforced on import' : 'Not enforced'}</Status>}
          >
            <div className="space-y-4 p-4">
              <form
                className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => { event.preventDefault(); void add(kind); }}
              >
                <div className="min-w-0 flex-1">
                  <Field
                    label={`Add ${singular}`}
                    value={drafts[kind]}
                    onChange={(value) => setDrafts((current) => ({ ...current, [kind]: value }))}
                    maxLength={200}
                  />
                </div>
                <Button variant="primary" type="submit" loading={busy === `add:${kind}`} disabled={busy !== null || drafts[kind].trim() === ''}>
                  Add {singular}
                </Button>
              </form>

              {values.length === 0 ? (
                <Empty title={`No governed ${title.toLocaleLowerCase()}`}>
                  Add the first {singular} to begin rejecting unrecognized {title.toLocaleLowerCase()} in HR imports.
                </Empty>
              ) : (
                <Table tight>
                  <thead><tr><th scope="col">Value</th><th scope="col">Import state</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {values.map((item) => (
                      <tr key={item.id}>
                        <th scope="row">{item.value}</th>
                        <td><Status tone={item.active ? 'active' : 'neutral'}>{item.active ? 'Allowed' : 'Inactive'}</Status></td>
                        <td className="text-right">
                          <Button size="sm" onClick={() => void setActive(item)} disabled={busy !== null} loading={busy === item.id}>
                            {item.active ? 'Disable' : 'Enable'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
