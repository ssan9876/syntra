import { withTenant, type TenantClient } from '@syntra/db';
import { Prisma } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import {
  ACTIONS,
  EscalationRefusedError,
  actionDefinition,
  assertFormSatisfies,
  assertNotMorePrivileged,
  type ActionContext,
  type ActionKey,
  type ActionOutcome,
} from './actions.js';
import { audienceAdmits, audienceConditionSchema, type AudienceCondition } from '../automate/audience.js';
import {
  formSchemaSchema,
  validateFormValues,
  type FormSchema,
  type LookupOptions,
} from '../automate/form.js';
// The catalog's own loader, not a second one. It already reads the contracts,
// the group memberships, the org-unit chain and the held entitlements that
// `audienceAdmits` needs, and two readers of the same facts are two answers to
// "who is this person" waiting to disagree.
import { subjectAudienceFacts } from '../automate/catalog-service.js';

export interface TaskInput {
  name: string;
  description: string | null;
  actionKey: string;
  formSchema: FormSchema;
  audienceCondition: AudienceCondition | null;
  enabled: boolean;
}

export interface TaskView extends TaskInput {
  id: string;
  actionKey: ActionKey;
  actionLabel: string;
}

const view = (row: {
  id: string;
  name: string;
  description: string | null;
  actionKey: string;
  formSchema: unknown;
  audienceCondition: unknown;
  enabled: boolean;
}): TaskView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  actionKey: row.actionKey as ActionKey,
  actionLabel: actionDefinition(row.actionKey).label,
  formSchema: (row.formSchema ?? []) as FormSchema,
  audienceCondition: (row.audienceCondition ?? null) as AudienceCondition | null,
  enabled: row.enabled,
});

/**
 * Validates a task before it is written.
 *
 * Three checks, and the third is the one that is easy to leave out: the form
 * has to actually ASK for what the action reads. Without it a task saves
 * cleanly, appears in the portal, and calls a service with an empty string
 * where an account id should be.
 */
function validate(input: TaskInput): TaskInput {
  actionDefinition(input.actionKey);
  // The PARSED schema is what gets stored, not the body that was sent.
  // `formSchemaSchema` fills in defaults and strips unknown keys, and
  // discarding its result meant a task's stored form was whatever arrived on
  // the wire — validated once and then never the thing that was validated.
  const formSchema = formSchemaSchema.parse(input.formSchema);
  if (input.audienceCondition !== null) {
    audienceConditionSchema.parse(input.audienceCondition);
  }
  assertFormSatisfies(input.actionKey, formSchema);
  return { ...input, formSchema };
}

export async function createTask(tx: TenantClient, raw: TaskInput): Promise<TaskView> {
  const input = validate(raw);
  const tenantId = await currentTenant(tx);
  const row = await tx.delegatedTask.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description,
      actionKey: input.actionKey,
      formSchema: input.formSchema as never,
      audienceCondition: (input.audienceCondition ?? Prisma.DbNull) as never,
      enabled: input.enabled,
    },
  });
  return view(row);
}

export async function updateTask(
  tx: TenantClient,
  id: string,
  raw: TaskInput,
): Promise<TaskView> {
  const input = validate(raw);
  const row = await tx.delegatedTask.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      actionKey: input.actionKey,
      formSchema: input.formSchema as never,
      audienceCondition: (input.audienceCondition ?? Prisma.DbNull) as never,
      enabled: input.enabled,
    },
  });
  return view(row);
}

export async function listTasks(tx: TenantClient): Promise<TaskView[]> {
  const rows = await tx.delegatedTask.findMany({ orderBy: { name: 'asc' } });
  return rows.map(view);
}

export async function deleteTask(tx: TenantClient, id: string): Promise<void> {
  await tx.delegatedTask.delete({ where: { id } });
}

/**
 * The tasks this person may run.
 *
 * `audienceAdmits` — the same function and the same expression language the
 * catalog uses. A tenant that has written an audience for a product already
 * knows how to write one for a task, and there is one evaluator to get right.
 *
 * A disabled task is not offered. A task with no audience is offered to
 * nobody, which is `audienceAdmits`'s own default and the correct one: the
 * failure mode of the opposite is a task somebody built and did not finish
 * being runnable by everyone.
 */
export async function tasksForPerson(
  tx: TenantClient,
  personId: string,
): Promise<TaskView[]> {
  const facts = await subjectAudienceFacts(tx, personId, new Date());
  const rows = await tx.delegatedTask.findMany({
    where: { enabled: true },
    orderBy: { name: 'asc' },
  });
  return rows
    .filter((row) =>
      audienceAdmits(
        (row.audienceCondition ?? null) as AudienceCondition | null,
        facts.contracts,
        facts,
      ),
    )
    .map(view);
}

export class TaskNotAvailableError extends Error {
  constructor() {
    super('that task is not available to you');
    this.name = 'TaskNotAvailableError';
  }
}

export class TaskInputInvalidError extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super('the form was not filled in correctly');
    this.name = 'TaskInputInvalidError';
  }
}

export interface RunTaskInput {
  taskId: string;
  values: unknown;
  runByUserId: string;
  runByPersonId: string | null;
  sourceIp: string | null;
  publicUrl: string;
  transport: ActionContext['transport'];
  /** What each `lookup` field may resolve to. See `LookupOptions`. */
  lookups: LookupOptions;
}

/**
 * Runs a delegated task.
 *
 * The order of the checks is the security argument, so it is worth stating:
 *
 *  1. **The audience**, re-evaluated now rather than trusted from the listing.
 *     A listing is a snapshot; somebody's contract can end between seeing a
 *     task and pressing the button.
 *  2. **The form**, against the schema and against the lookup sets the caller
 *     supplied. An EXISTENCE check: it stops a submitted value being an
 *     arbitrary string, or a group id where an account id belongs. It is not
 *     the privilege boundary — that is the next step, and conflating the two
 *     produces a refusal that says "choose one of the offered records" when
 *     the true answer is "that account is out of your reach".
 *  3. **The escalation guard**, against the account the action names. Last of
 *     the three because it needs the validated subject, and non-negotiable
 *     because without it a task delegated to a helpdesk user reaches the
 *     owner's account.
 *
 * Every outcome is written to `DelegatedTaskRun` and to the audit chain,
 * including a refusal. A delegated task is the one place somebody exercises
 * authority they do not hold; a refused attempt is exactly the thing somebody
 * would later want to find.
 */
export async function runTask(
  tenantId: string,
  input: RunTaskInput,
): Promise<{ ok: boolean; message: string }> {
  const task = await withTenant(tenantId, async (tx) => {
    const row = await tx.delegatedTask.findUnique({ where: { id: input.taskId } });
    if (row === null || !row.enabled) return null;

    // Re-evaluated, not trusted from whatever listed it. Somebody's contract
    // can end between seeing a task and pressing the button.
    if (input.runByPersonId === null) return null;
    const facts = await subjectAudienceFacts(tx, input.runByPersonId, new Date());
    const admitted = audienceAdmits(
      (row.audienceCondition ?? null) as AudienceCondition | null,
      facts.contracts,
      facts,
    );
    return admitted ? view(row) : null;
  });
  if (task === null) throw new TaskNotAvailableError();

  const definition = ACTIONS[task.actionKey];
  const validated = validateFormValues(task.formSchema, input.values, [], input.lookups);
  if (!validated.ok) throw new TaskInputInvalidError(validated.errors);

  const subjectUserId =
    definition.subjectKey === null
      ? null
      : ((validated.values[definition.subjectKey] as string | undefined) ?? null);

  if (subjectUserId !== null) {
    try {
      await assertNotMorePrivileged(tenantId, input.runByUserId, subjectUserId);
    } catch (cause) {
      if (cause instanceof EscalationRefusedError) {
        await record(tenantId, task, input, subjectUserId, validated.values, {
          outcome: 'refused',
          message: cause.message,
        });
        throw cause;
      }
      throw cause;
    }
  }

  // A THROWN action still leaves a trace.
  //
  // An action returns `{ ok: false }` for the failures it anticipated, but it
  // can also throw — a group that was deleted between the picker and the
  // button, a database that went away. Letting that propagate would mean the
  // one kind of run nobody can account for afterwards is the kind that went
  // wrong, which is the opposite of what this table is for.
  let outcome: ActionOutcome;
  try {
    outcome = await definition.run(
      {
        tenantId,
        runnerUserId: input.runByUserId,
        sourceIp: input.sourceIp,
        publicUrl: input.publicUrl,
        transport: input.transport,
      },
      validated.values,
    );
  } catch (cause) {
    // The real reason goes on the RUN RECORD, which only an administrator
    // reads, on the console's activity view. The runner gets a sentence with
    // nothing in it about the database — they hold no administrative
    // permission, which is the whole point of the feature.
    const detail = cause instanceof Error ? cause.message : String(cause);
    await record(tenantId, task, input, subjectUserId, validated.values, {
      outcome: 'failure',
      message: detail.slice(0, 500),
    });
    return { ok: false, message: 'That could not be completed. Ask an administrator.' };
  }

  await record(tenantId, task, input, subjectUserId, validated.values, {
    outcome: outcome.ok ? 'success' : 'failure',
    message: outcome.message,
  });

  return outcome;
}

async function record(
  tenantId: string,
  task: TaskView,
  input: RunTaskInput,
  subjectUserId: string | null,
  values: Record<string, unknown>,
  result: { outcome: string; message: string },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    await tx.delegatedTaskRun.create({
      data: {
        tenantId: bound,
        taskId: task.id,
        runByUserId: input.runByUserId,
        subjectUserId,
        // The VALIDATED values, not what was submitted. A stale tab sends
        // fields the schema does not declare, and a run record carrying an
        // answer to a question nobody asked is a misleading one.
        values: values as never,
        outcome: result.outcome,
        message: result.message,
      },
    });
    await recordEvent(tx, {
      actorUserId: input.runByUserId,
      action: 'automate.task_run',
      targetType: 'DelegatedTask',
      targetId: task.id,
      outcome: result.outcome === 'success' ? 'success' : 'failure',
      sourceIp: input.sourceIp,
      payload: {
        taskName: task.name,
        actionKey: task.actionKey,
        subjectUserId,
        result: result.outcome,
      },
    });
  });
}
