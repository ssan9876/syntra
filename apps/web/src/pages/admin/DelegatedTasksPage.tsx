import { Fragment, useState } from 'react';
import {
  Alert,
  Button,
  Check,
  Empty,
  Field,
  Panel,
  SkeletonRows,
  Status,
  Table,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { DeleteButton } from './DeleteButton.js';

interface ActionInput {
  key: string;
  type: string;
  label: string;
  dataSource?: string;
}

interface Action {
  key: string;
  label: string;
  description: string;
  inputs: ActionInput[];
}

interface TaskRun {
  id: string;
  runByUserId: string;
  subjectUserId: string | null;
  outcome: 'success' | 'failure' | 'refused';
  message: string;
  createdAt: string;
}

interface Task {
  id: string;
  name: string;
  description: string | null;
  actionKey: string;
  actionLabel: string;
  audienceCondition: Record<string, unknown> | null;
  enabled: boolean;
}

/** Everybody with an active contract — `audienceAdmits`'s "any contract". */
const EVERYONE = { all: [] };

const groupAudience = (groupIds: string[]) => ({
  field: 'user.memberOfGroup',
  op: 'in',
  value: groupIds,
});

/** Which of the two shapes the console offers this condition is, if either. */
function readAudience(
  condition: Record<string, unknown> | null,
): { kind: 'nobody' } | { kind: 'everyone' } | { kind: 'groups'; ids: string[] } | { kind: 'other' } {
  if (condition === null) return { kind: 'nobody' };
  if (Array.isArray(condition.all) && condition.all.length === 0) return { kind: 'everyone' };
  if (condition.field === 'user.memberOfGroup' && Array.isArray(condition.value)) {
    return { kind: 'groups', ids: condition.value as string[] };
  }
  return { kind: 'other' };
}

/**
 * Delegated tasks: what somebody may do here without holding the permission
 * that normally gates it.
 *
 * **The form is not built by hand.** Each action declares the inputs it reads,
 * and the task's form is generated from them — so choosing "Unlock an account"
 * produces a form that asks for an account, correctly, with no way to get it
 * wrong. A form builder here would be a screen where the commonest outcome is
 * a task that saves cleanly and then does nothing, which the API refuses
 * anyway.
 */
export function DelegatedTasksPage() {
  const { data, error, loading, reload } = useApiResource<{ tasks: Task[] }>(
    '/api/admin/automate/tasks',
  );
  const { data: actionData } = useApiResource<{ actions: Action[] }>(
    '/api/admin/automate/tasks/actions',
  );
  const [adding, setAdding] = useState(false);
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tasks = data?.tasks ?? [];
  const actions = actionData?.actions ?? [];

  return (
    <>
      <PageHeader
        title="Delegated tasks"
        description="One narrow thing somebody may do without an administrator — unlocking an account, sending a reset link."
        actions={
          <Button variant="primary" onClick={() => setAdding((v) => !v)}>
            New task
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {adding && (
        <TaskForm
          actions={actions}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={3} cols={4} />}
          {!loading && tasks.length === 0 && !adding && (
            <div className="p-6">
              <Empty title="Nothing is delegated yet">
                A task lets somebody on the service desk do one thing —
                unlock an account, send a reset link — without giving them the
                permission that normally covers it.
              </Empty>
            </div>
          )}

          {!loading && tasks.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Does</th>
                  <th scope="col">Who can run it</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {tasks.map((task) => {
                  const audience = readAudience(task.audienceCondition);
                  return (
                    // A keyed Fragment: the row and its activity panel are two
                    // siblings for one task, and a bare fragment carries no key.
                    <Fragment key={task.id}>
                    <tr>
                      <td>
                        <div className="font-medium text-ink">{task.name}</div>
                        {task.description && (
                          <div className="text-sm text-muted">{task.description}</div>
                        )}
                      </td>
                      <td>{task.actionLabel}</td>
                      <td>
                        {/* A task nobody can run is the state somebody left
                            half-configured, and it is worth saying so loudly
                            rather than showing an empty cell. */}
                        {audience.kind === 'nobody' && <Status tone="warning">Nobody</Status>}
                        {audience.kind === 'everyone' && (
                          <Status tone="neutral">Anyone with a contract</Status>
                        )}
                        {audience.kind === 'groups' && (
                          <Status tone="neutral">
                            {audience.ids.length} group{audience.ids.length === 1 ? '' : 's'}
                          </Status>
                        )}
                        {audience.kind === 'other' && <Status tone="neutral">A rule</Status>}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setOpenRuns(openRuns === task.id ? null : task.id)
                            }
                          >
                            {openRuns === task.id ? 'Hide activity' : 'Activity'}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy === task.id}
                            onClick={async () => {
                              setBusy(task.id);
                              try {
                                await api(`/api/admin/automate/tasks/${task.id}`, {
                                  method: 'PUT',
                                  body: JSON.stringify({
                                    name: task.name,
                                    description: task.description,
                                    actionKey: task.actionKey,
                                    formSchema: formFor(actions, task.actionKey),
                                    audienceCondition: task.audienceCondition,
                                    enabled: !task.enabled,
                                  }),
                                });
                                reload();
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            {task.enabled ? 'Pause' : 'Resume'}
                          </Button>
                          <span aria-hidden="true" className="h-5 w-px bg-border-subtle" />
                          <DeleteButton
                            path={`/api/admin/automate/tasks/${task.id}`}
                            label="task"
                            confirmWord={task.name}
                            warning="Anybody it was delegated to stops seeing it. What it has already done stays in the audit trail."
                            onDeleted={reload}
                          />
                        </div>
                      </td>
                    </tr>
                    {openRuns === task.id && (
                      <tr>
                        <td colSpan={4} className="bg-surface-2">
                          <TaskRuns taskId={task.id} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}

/**
 * What this task has actually done.
 *
 * The evidence that makes delegating safe to agree to. A delegated task is the
 * one place in this product where somebody exercises authority they do not
 * hold, so the interesting rows are the REFUSED ones — an attempt aimed at an
 * account out of the runner's reach is exactly what somebody would come here
 * looking for, and a list that only showed successes would be the wrong list.
 */
function TaskRuns({ taskId }: { taskId: string }) {
  const { data, error, loading } = useApiResource<{ runs: TaskRun[] }>(
    `/api/admin/automate/tasks/${taskId}/runs`,
  );

  if (loading) return <SkeletonRows rows={2} cols={3} />;
  if (error) return <Alert tone="danger">{error}</Alert>;

  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return <div className="p-4 text-muted">Nobody has run this yet.</div>;
  }

  return (
    <div className="p-3">
      <Table tight>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Outcome</th>
            <th scope="col">What happened</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="whitespace-nowrap">
                {new Date(run.createdAt).toLocaleString()}
              </td>
              <td>
                {run.outcome === 'success' && <Status tone="active">Done</Status>}
                {run.outcome === 'failure' && <Status tone="danger">Failed</Status>}
                {/* Its own tone, not `danger`. A refusal is the rule working,
                    and reading it as a fault sends somebody to fix the wrong
                    thing. */}
                {run.outcome === 'refused' && <Status tone="warning">Refused</Status>}
              </td>
              <td className="text-muted">{run.message}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** The form an action needs, generated from what it declares it reads. */
function formFor(actions: Action[], actionKey: string) {
  const action = actions.find((candidate) => candidate.key === actionKey);
  return (action?.inputs ?? []).map((input) => ({
    key: input.key,
    type: input.type,
    label: input.label,
    required: true,
    ...(input.dataSource ? { dataSource: input.dataSource } : {}),
  }));
}

function TaskForm({
  actions,
  onCancel,
  onSaved,
}: {
  actions: Action[];
  onCancel(): void;
  onSaved(): void;
}) {
  const { data: groupData } = useApiResource<{ groups: { id: string; name: string }[] }>(
    '/api/admin/groups',
  );
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const groups = groupData?.groups ?? [];
  const ready = action !== null && name.trim() !== '' && (everyone || groupIds.length > 0);

  async function save() {
    if (!action) return;
    setBusy(true);
    setProblem(null);
    try {
      await api('/api/admin/automate/tasks', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          actionKey: action.key,
          // Generated, not built by hand. The API refuses a form that does not
          // ask for what its action reads, and there is no reason to make
          // somebody discover that the hard way.
          formSchema: formFor(actions, action.key),
          audienceCondition: everyone ? EVERYONE : groupAudience(groupIds),
          enabled: true,
        }),
      });
      onSaved();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4">
      <Panel title="New task">
        <div className="space-y-5 p-4">
          <div>
            <span className="font-medium text-ink">What it does</span>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {actions.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onClick={() => {
                    setAction(candidate);
                    if (name.trim() === '') setName(candidate.label);
                  }}
                  className={[
                    'rounded-panel border p-3 text-left transition-colors duration-150 ease-out',
                    action?.key === candidate.key
                      ? 'border-primary bg-primary-soft'
                      : 'border-border-control hover:border-primary hover:bg-surface-2',
                  ].join(' ')}
                >
                  <span className="block font-medium text-ink">{candidate.label}</span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {candidate.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <Field label="Name" value={name} onChange={setName} required />
          <Field label="Description" value={description} onChange={setDescription} />

          <fieldset>
            <legend className="font-medium text-ink">Who can run it</legend>
            <div className="mt-2 space-y-2">
              <Check
                checked={everyone}
                onChange={(on) => {
                  setEveryone(on);
                  if (on) setGroupIds([]);
                }}
                label="Anyone with an active contract"
              />
              {!everyone &&
                groups.map((group) => (
                  <Check
                    key={group.id}
                    checked={groupIds.includes(group.id)}
                    onChange={(on) =>
                      setGroupIds((current) =>
                        on ? [...current, group.id] : current.filter((id) => id !== group.id),
                      )
                    }
                    label={`Members of ${group.name}`}
                  />
                ))}
            </div>
          </fieldset>

          {problem && <Alert tone="danger">{problem}</Alert>}

          <div className="flex gap-2">
            <Button variant="primary" loading={busy} disabled={!ready} onClick={save}>
              Create task
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
