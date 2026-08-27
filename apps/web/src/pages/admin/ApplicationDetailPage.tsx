import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { ApplicationSso } from './ApplicationSso.js';

type SubjectType = 'user' | 'group' | 'orgUnit';

interface Assignment {
  id: string;
  subjectType: SubjectType;
  userId: string | null;
  groupId: string | null;
  orgUnitId: string | null;
}

interface Named {
  id: string;
  name: string;
}

const LABELS: Record<SubjectType, string> = {
  user: 'User',
  group: 'Group',
  orgUnit: 'Org unit',
};

export function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();

  const {
    data: assignmentsData,
    error,
    loading,
    reload,
  } = useApiResource<{ assignments: Assignment[] }>(
    id ? `/api/admin/applications/${id}/assignments` : null,
  );
  const { data: usersData } = useApiResource<{
    users: { id: string; displayName: string }[];
  }>('/api/admin/users');
  const { data: groupsData } = useApiResource<{ groups: Named[] }>('/api/admin/groups');
  const { data: orgUnitsData } = useApiResource<{ orgUnits: Named[] }>('/api/admin/org-units');

  const users: Named[] = (usersData?.users ?? []).map((row) => ({
    id: row.id,
    name: row.displayName,
  }));
  const groups = groupsData?.groups ?? [];
  const orgUnits = orgUnitsData?.orgUnits ?? [];
  const assignments = assignmentsData?.assignments ?? null;

  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<SubjectType, string>>({
    user: '',
    group: '',
    orgUnit: '',
  });

  const nameOf = (assignment: Assignment): string => {
    if (assignment.subjectType === 'user') {
      return users.find((row) => row.id === assignment.userId)?.name ?? 'Unknown user';
    }
    if (assignment.subjectType === 'group') {
      return groups.find((row) => row.id === assignment.groupId)?.name ?? 'Unknown group';
    }
    return orgUnits.find((row) => row.id === assignment.orgUnitId)?.name ?? 'Unknown org unit';
  };

  /**
   * The refusal, rendered.
   *
   * Both of these had no catch at all. A 403 -- which is the ORDINARY case
   * here, because `access.read` is enough to open this page and not enough to
   * change it -- was an unhandled rejection, and the button appeared to do
   * nothing at all. The reader had no way to learn that the thing they were
   * clicking was not theirs to click.
   */
  const report = (cause: unknown) =>
    setProblem(
      cause instanceof ApiError
        ? (cause.problem.detail ?? cause.problem.title)
        : 'That could not be saved.',
    );

  async function assign(type: SubjectType) {
    const subjectId = chosen[type];
    if (!subjectId) return;
    setProblem(null);
    try {
      await api(`/api/admin/applications/${id}/assignments`, {
        method: 'POST',
        body: JSON.stringify({ type, id: subjectId }),
      });
      setChosen((current) => ({ ...current, [type]: '' }));
      reload();
    } catch (cause) {
      report(cause);
    }
  }

  async function unassign(assignmentId: string) {
    setProblem(null);
    try {
      await api(`/api/admin/applications/${id}/assignments/${assignmentId}`, {
        method: 'DELETE',
      });
      reload();
    } catch (cause) {
      report(cause);
    }
  }

  const picker = (type: SubjectType, options: Named[]) => (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1">
        <label htmlFor={`pick-${type}`} className="mb-1.5 block font-medium text-ink">
          {LABELS[type]}
        </label>
        <select
          id={`pick-${type}`}
          value={chosen[type]}
          onChange={(e) => setChosen((c) => ({ ...c, [type]: e.target.value }))}
          className="h-9 w-full rounded-control border border-border-control bg-bg px-3 text-ink"
        >
          <option value="">Choose one…</option>
          {options.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>
      <Button onClick={() => assign(type)} disabled={!chosen[type]}>
        Assign
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader title="Assignments" />

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      {loading && !error && (
        <Panel>
          <SkeletonRows rows={3} cols={2} />
        </Panel>
      )}

      {!loading && assignments && (
        <Panel
          title="Assigned to"
        >
          <div className="space-y-4 p-4">
            {assignments.length === 0 && (
              <Empty title="Not assigned to anyone yet">
                Assign a group or an organizational unit rather than a list of
                people — it stays correct as people join and leave.
              </Empty>
            )}

            {assignments.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {assignments.map((assignment) => (
                  <li key={assignment.id} className="flex items-center justify-between py-2">
                    <span>
                      <span className="text-sm text-muted">{LABELS[assignment.subjectType]}</span>
                      <span className="ml-2 font-medium text-ink">{nameOf(assignment)}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => unassign(assignment.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-3 border-t border-border-subtle pt-4">
              {picker('user', users)}
              {picker('group', groups)}
              {picker('orgUnit', orgUnits)}
            </div>
          </div>
        </Panel>
      )}

      {/*
        Below the assignments, because who holds it is the question people
        arrive with and how it signs in is the question they come back for.
        Renders nothing when the application uses neither protocol.
      */}
      {id && (
        <div className="mt-4 space-y-4">
          <ApplicationSso applicationId={id} />
        </div>
      )}
    </>
  );
}
