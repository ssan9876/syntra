import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport } from '../notify/notification-service.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createUser } from '../directory/user-service.js';
import { createGroup } from '../directory/group-service.js';
import { EscalationRefusedError } from './actions.js';
import type { AudienceCondition } from '../automate/audience.js';
import {
  TaskInputInvalidError,
  TaskNotAvailableError,
  createTask,
  runTask,
  tasksForPerson,
  type TaskInput,
} from './task-service.js';

let tenantId: string;
let helpdeskUserId: string;
let helpdeskPersonId: string;
let ordinaryUserId: string;
let ownerUserId: string;

const transport = memoryTransport();
const PUBLIC_URL = 'https://acme.test';

/** Everybody with a live contract, which is every person in these tests. */
const EVERYONE: AudienceCondition = { all: [] };

const unlockTask = (over: Partial<TaskInput> = {}): TaskInput => ({
  name: 'Unlock an account',
  description: 'For the service desk.',
  actionKey: 'unlock_account',
  formSchema: [
    { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
  ],
  audienceCondition: EVERYONE,
  enabled: true,
  ...over,
});

/** A person with one active contract and one login. */
async function seedPerson(login: string, permissions: string[] = []) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: login, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });
    const user = await createUser(tx, {
      login,
      email: `${login}@acme.test`,
      displayName: login,
    });
    await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
    if (permissions.length > 0) {
      const role = await createRole(tx, `role-${login}`, permissions as never);
      await assignRole(tx, user.id, role.id);
    }
    return { personId: person.id, userId: user.id };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;

  const helpdesk = await seedPerson('helpdesk');
  helpdeskUserId = helpdesk.userId;
  helpdeskPersonId = helpdesk.personId;
  ordinaryUserId = (await seedPerson('ordinary')).userId;
  ownerUserId = (await seedPerson('owner', [PERMISSIONS.TENANT_MANAGE])).userId;
});

const run = (taskId: string, values: Record<string, unknown>, runBy = helpdeskUserId) =>
  runTask(tenantId, {
    taskId,
    values,
    runByUserId: runBy,
    runByPersonId: helpdeskPersonId,
    sourceIp: '203.0.113.5',
    publicUrl: PUBLIC_URL,
    transport,
    lookups: { user: [ordinaryUserId, ownerUserId, helpdeskUserId] },
  });

describe('createTask', () => {
  it('refuses a form that does not ask for what the action reads', async () => {
    // Otherwise the task saves cleanly, appears in the portal, and calls a
    // service with an empty string where an account id should be.
    await expect(
      withTenant(tenantId, (tx) =>
        createTask(tx, unlockTask({ formSchema: [
          { key: 'note', type: 'text', label: 'Note', required: false },
        ] })),
      ),
    ).rejects.toThrow(/has no field called "user"/);
  });

  it('refuses a lookup pointed at the wrong thing', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createTask(tx, unlockTask({ formSchema: [
          { key: 'user', type: 'lookup', label: 'Account', dataSource: 'group', required: true },
        ] })),
      ),
    ).rejects.toThrow(/has no field called "user"/);
  });

  it('refuses a form that lets the action’s input be left blank', async () => {
    // A run with no subject skips `assertNotMorePrivileged` entirely — there
    // is no account named to check. Today no action does anything dangerous
    // with an empty subject; the next one might, and a guard that is skipped
    // rather than failed is the worst way to find that out.
    await expect(
      withTenant(tenantId, (tx) =>
        createTask(tx, unlockTask({ formSchema: [
          {
            key: 'user',
            type: 'lookup',
            label: 'Account',
            dataSource: 'user',
            required: false,
          },
        ] })),
      ),
    ).rejects.toThrow(/has no field called "user"/);
  });

  it('refuses an action that does not exist', async () => {
    await expect(
      withTenant(tenantId, (tx) => createTask(tx, unlockTask({ actionKey: 'rm_rf' }))),
    ).rejects.toThrow(/no action called/);
  });
});

describe('tasksForPerson', () => {
  it('offers a task whose audience admits the person', async () => {
    await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    const offered = await withTenant(tenantId, (tx) =>
      tasksForPerson(tx, helpdeskPersonId),
    );
    expect(offered.map((t) => t.name)).toEqual(['Unlock an account']);
  });

  it('offers nothing when the task has no audience', async () => {
    // `audienceAdmits`'s own default, and the right one: the failure mode of
    // the opposite is a task somebody built and did not finish being runnable
    // by everyone.
    await withTenant(tenantId, (tx) =>
      createTask(tx, unlockTask({ audienceCondition: null })),
    );
    expect(
      await withTenant(tenantId, (tx) => tasksForPerson(tx, helpdeskPersonId)),
    ).toEqual([]);
  });

  it('does not offer a disabled task', async () => {
    await withTenant(tenantId, (tx) => createTask(tx, unlockTask({ enabled: false })));
    expect(
      await withTenant(tenantId, (tx) => tasksForPerson(tx, helpdeskPersonId)),
    ).toEqual([]);
  });
});

describe('runTask', () => {
  it('runs the action and records what happened', async () => {
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    await withTenant(tenantId, (tx) =>
      tx.loginLockout.create({
        data: {
          tenantId,
          userId: ordinaryUserId,
          failedCount: 5,
          firstFailedAt: new Date(),
          lastFailedAt: new Date(),
          lockedAt: new Date(),
        },
      }),
    );

    const result = await run(task.id, { user: ordinaryUserId });
    expect(result.ok).toBe(true);

    expect(await withTenant(tenantId, (tx) => tx.loginLockout.count())).toBe(0);
    const record = await withTenant(tenantId, (tx) =>
      tx.delegatedTaskRun.findFirstOrThrow(),
    );
    expect(record).toMatchObject({
      runByUserId: helpdeskUserId,
      subjectUserId: ordinaryUserId,
      outcome: 'success',
    });
  });

  it('REFUSES a task aimed at somebody more privileged than the runner', async () => {
    // The rule that makes delegation safe. A task runs with Syntra's
    // authority, not the runner's — so the same "unlock an account" task
    // pointed at the owner would let a helpdesk user reach the owner's
    // account. Without this, the feature is a takeover primitive.
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));

    await expect(run(task.id, { user: ownerUserId })).rejects.toBeInstanceOf(
      EscalationRefusedError,
    );
  });

  it('records the refusal rather than swallowing it', async () => {
    // A refused attempt is exactly the thing somebody would later want to
    // find.
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    await run(task.id, { user: ownerUserId }).catch(() => undefined);

    const record = await withTenant(tenantId, (tx) =>
      tx.delegatedTaskRun.findFirstOrThrow(),
    );
    expect(record.outcome).toBe('refused');
    expect(record.subjectUserId).toBe(ownerUserId);

    // Through withTenant, or row-level security hides the audit row and the
    // assertion holds no matter what the service did.
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'automate.task_run' } }),
    );
    expect(event?.outcome).toBe('failure');
  });

  it('records a run whose action threw, and says nothing technical to the runner', async () => {
    // An action returns `{ ok: false }` for the failures it anticipated, but
    // it can also throw. Letting that propagate would mean the one kind of run
    // nobody can account for afterwards is the kind that went wrong.
    const group = await withTenant(tenantId, (tx) => createGroup(tx, 'Finance'));
    const task = await withTenant(tenantId, (tx) =>
      createTask(tx, {
        ...unlockTask(),
        name: 'Add to a group',
        actionKey: 'add_group_member',
        formSchema: [
          { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
          { key: 'group', type: 'lookup', label: 'Group', dataSource: 'group', required: true },
        ],
      }),
    );

    // The group goes away between the picker and the button.
    await withTenant(tenantId, (tx) => tx.group.delete({ where: { id: group.id } }));

    const result = await runTask(tenantId, {
      taskId: task.id,
      values: { user: ordinaryUserId, group: group.id },
      runByUserId: helpdeskUserId,
      runByPersonId: helpdeskPersonId,
      sourceIp: null,
      publicUrl: PUBLIC_URL,
      transport,
      lookups: { user: [ordinaryUserId], group: [group.id] },
    });

    expect(result.ok).toBe(false);
    // Nothing about the database. The runner holds no administrative
    // permission, which is the whole point of the feature.
    expect(result.message).toBe('That could not be completed. Ask an administrator.');

    const record = await withTenant(tenantId, (tx) =>
      tx.delegatedTaskRun.findFirstOrThrow(),
    );
    expect(record.outcome).toBe('failure');
    // The real reason is on the record, which only an administrator reads.
    expect(record.message.length).toBeGreaterThan(0);
    expect(record.message).not.toBe('That could not be completed. Ask an administrator.');
  });

  it('lets somebody act on themselves', async () => {
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    const result = await run(task.id, { user: helpdeskUserId });
    expect(result.ok).toBe(true);
  });

  it('refuses an account the caller did not offer', async () => {
    // The submitted value is an id from a picker, and a picker's contents are
    // a suggestion. The check against the caller's own set is the control.
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    const stranger = await seedPerson('stranger');

    await expect(
      runTask(tenantId, {
        taskId: task.id,
        values: { user: stranger.userId },
        runByUserId: helpdeskUserId,
        runByPersonId: helpdeskPersonId,
        sourceIp: null,
        publicUrl: PUBLIC_URL,
        transport,
        lookups: { user: [ordinaryUserId] },
      }),
    ).rejects.toBeInstanceOf(TaskInputInvalidError);
  });

  it('refuses a task the runner is not admitted to', async () => {
    const task = await withTenant(tenantId, (tx) =>
      createTask(tx, unlockTask({ audienceCondition: null })),
    );
    await expect(run(task.id, { user: ordinaryUserId })).rejects.toBeInstanceOf(
      TaskNotAvailableError,
    );
  });

  it('refuses a disabled task even to somebody its audience admits', async () => {
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    await withTenant(tenantId, (tx) =>
      tx.delegatedTask.update({ where: { id: task.id }, data: { enabled: false } }),
    );
    await expect(run(task.id, { user: ordinaryUserId })).rejects.toBeInstanceOf(
      TaskNotAvailableError,
    );
  });

  it('stores the validated values, not what was submitted', async () => {
    const task = await withTenant(tenantId, (tx) => createTask(tx, unlockTask()));
    await run(task.id, { user: ordinaryUserId, smuggled: 'not on the form' });

    const record = await withTenant(tenantId, (tx) =>
      tx.delegatedTaskRun.findFirstOrThrow(),
    );
    // A run record carrying an answer to a question nobody asked is a
    // misleading one.
    expect(record.values).toEqual({ user: ordinaryUserId });
  });

  it('adds somebody to a group', async () => {
    const group = await withTenant(tenantId, (tx) => createGroup(tx, 'Finance'));
    const task = await withTenant(tenantId, (tx) =>
      createTask(tx, {
        ...unlockTask(),
        name: 'Add to a group',
        actionKey: 'add_group_member',
        formSchema: [
          { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
          { key: 'group', type: 'lookup', label: 'Group', dataSource: 'group', required: true },
        ],
      }),
    );

    const result = await runTask(tenantId, {
      taskId: task.id,
      values: { user: ordinaryUserId, group: group.id },
      runByUserId: helpdeskUserId,
      runByPersonId: helpdeskPersonId,
      sourceIp: null,
      publicUrl: PUBLIC_URL,
      transport,
      lookups: { user: [ordinaryUserId], group: [group.id] },
    });

    expect(result.ok).toBe(true);
    expect(
      await withTenant(tenantId, (tx) =>
        tx.groupMembership.count({ where: { userId: ordinaryUserId } }),
      ),
    ).toBe(1);
  });
});
