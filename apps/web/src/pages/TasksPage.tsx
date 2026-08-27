import { useState } from 'react';
import { Alert, Button, Check, Empty, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../session/api.js';
import { useApiResource } from '../session/use-api-resource.js';

interface FormFieldSpec {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  options?: { value: string; label: string }[];
  dataSource?: string;
  visibleWhen?: { field: string; equals: string | boolean };
}

interface Task {
  id: string;
  name: string;
  description: string | null;
  actionLabel: string;
  formSchema: FormFieldSpec[];
}

type Values = Record<string, string | boolean>;

/**
 * The same rule the server applies in `fieldIsVisible`.
 *
 * Two implementations is how a field comes to be hidden on screen and required
 * at the server — the error nobody can act on. This one exists because the
 * browser cannot call the other; it is kept identical deliberately, and a rule
 * naming a field that is not on the form shows the field in both.
 */
function visible(field: FormFieldSpec, values: Values, schema: FormFieldSpec[]): boolean {
  if (!field.visibleWhen) return true;

  // A rule naming a field that is not on the form shows the field — the typo
  // protection. A rule naming one that IS on the form and is unanswered does
  // not: an unticked checkbox is `false`, not "unknown".
  const rule = field.visibleWhen;
  const trigger = schema.find((candidate) => candidate.key === rule.field);
  if (trigger === undefined) return true;

  const actual = values[rule.field];
  if (actual === undefined) return trigger.type === 'checkbox' ? rule.equals === false : false;
  return actual === rule.equals;
}

/**
 * The things somebody may do without holding the permission that normally
 * gates them.
 *
 * A portal screen, not a console one — that is the entire feature. Somebody on
 * the service desk with no administrative permission at all sees the tasks
 * their organisation has delegated to them, and nothing else.
 */
export function TasksPage() {
  const { data, error, loading } = useApiResource<{ tasks: Task[] }>('/api/portal/tasks');
  const [open, setOpen] = useState<Task | null>(null);

  const tasks = data?.tasks ?? [];

  if (open) {
    return <RunTask task={open} onDone={() => setOpen(null)} />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold text-ink">Tasks</h1>
      <p className="mt-1 max-w-[68ch] text-muted">
        Things you can do here without needing an administrator.
      </p>

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="mt-6">
          <Empty title="Nothing has been delegated to you">
            When somebody gives your team a task — unlocking an account, sending
            a reset link — it appears here.
          </Empty>
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => setOpen(task)}
            className="rounded-panel border border-border-control p-4 text-left transition-colors duration-150 ease-out hover:border-primary hover:bg-surface-2"
          >
            <span className="block font-medium text-ink">{task.name}</span>
            {task.description && (
              <span className="mt-0.5 block text-sm text-muted">{task.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunTask({ task, onDone }: { task: Task; onDone(): void }) {
  const { data: optionData, error: optionError } = useApiResource<{
    options: Record<string, { value: string; label: string }[]>;
  }>(`/api/portal/tasks/${task.id}/options`);

  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const shown = task.formSchema.filter((field) => visible(field, values, task.formSchema));
  const ready = shown.every(
    (field) => !field.required || String(values[field.key] ?? '').trim() !== '',
  );

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/api/portal/tasks/${task.id}/run`,
        {
          method: 'POST',
          // Only what is SHOWN. A hidden field's value is not an answer
          // anybody gave, and the server drops it too — sending it would make
          // the two disagree about what was submitted.
          body: JSON.stringify({
            values: Object.fromEntries(
              shown.map((field) => [field.key, values[field.key]]).filter(([, v]) => v !== undefined),
            ),
          }),
        },
      );
      setDone(result.message);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be done.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-8">
      <Panel title={task.name} {...(task.description ? { description: task.description } : {})}>
        <div className="space-y-4 p-4">
          {optionError && <Alert tone="danger">{optionError}</Alert>}

          {done ? (
            <>
              <Alert tone="success">{done}</Alert>
              <div className="flex gap-2">
                <Button variant="primary" onClick={onDone}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              {shown.map((field) => {
                const set = (v: string | boolean) =>
                  setValues((current) => ({ ...current, [field.key]: v }));

                if (field.type === 'lookup') {
                  const options = optionData?.options[field.dataSource ?? ''] ?? [];
                  return (
                    <Select
                      key={field.key}
                      label={field.label}
                      value={String(values[field.key] ?? '')}
                      onChange={set}
                      hint={field.help}
                      options={[{ value: '', label: 'Choose one' }, ...options]}
                    />
                  );
                }
                if (field.type === 'select') {
                  return (
                    <Select
                      key={field.key}
                      label={field.label}
                      value={String(values[field.key] ?? '')}
                      onChange={set}
                      hint={field.help}
                      options={[{ value: '', label: 'Choose one' }, ...(field.options ?? [])]}
                    />
                  );
                }
                if (field.type === 'checkbox') {
                  return (
                    <Check
                      key={field.key}
                      checked={values[field.key] === true}
                      onChange={set}
                      label={field.label}
                      {...(field.help ? { hint: field.help } : {})}
                    />
                  );
                }
                return (
                  <Field
                    key={field.key}
                    label={field.label}
                    value={String(values[field.key] ?? '')}
                    onChange={set}
                    hint={field.help}
                    required={field.required}
                  />
                );
              })}

              {problem && <Alert tone="danger">{problem}</Alert>}

              <div className="flex gap-2">
                <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>
                  {task.actionLabel}
                </Button>
                <Button variant="secondary" onClick={onDone}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
