import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { permissionsForUser } from '../rbac/rbac-service.js';
import { clearLockout } from '../auth/login-lockout.js';
import { requestPasswordReset } from '../auth/password-reset.js';
import { addMember, removeMember } from '../directory/group-service.js';
import type { Transport } from '../notify/notification-service.js';
import type { DataSource, FormFieldType } from '../automate/form.js';

/**
 * The closed library of things a delegated task may do.
 *
 * **This is the answer to "we need a script host", and the reason there isn't
 * one.** HelloID delegates a form plus a PowerShell script; whoever can define
 * a form can then run arbitrary code as the product, which is a strictly
 * larger privilege than any role in this system grants and one nobody would
 * choose on purpose. Every entry here instead calls a service that already
 * exists, with arguments the form validated, and there is no entry that takes
 * a command.
 *
 * The cost is real and worth stating: a tenant who needs something not on this
 * list cannot have it without a release. That is the trade — a shorter list of
 * things that can go wrong, in exchange for a shorter list of things you can
 * do.
 */
export const ACTION_KEYS = [
  'unlock_account',
  'send_password_reset',
  'add_group_member',
  'remove_group_member',
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

export interface ActionInput {
  key: string;
  type: FormFieldType;
  label: string;
  dataSource?: DataSource;
}

export interface ActionContext {
  tenantId: string;
  /** Who pressed the button. Named on every audit event this writes. */
  runnerUserId: string;
  sourceIp: string | null;
  publicUrl: string;
  transport: Transport;
}

export type ActionValues = Record<string, string | number | boolean | string[]>;

export interface ActionOutcome {
  ok: boolean;
  /** Shown to the person who ran it. Never a directory diagnostic. */
  message: string;
}

export interface ActionDefinition {
  key: ActionKey;
  label: string;
  /** What it does, in the words somebody choosing it would use. */
  description: string;
  /**
   * The fields this action needs, which the task's form must supply.
   *
   * Declared rather than assumed, so `assertFormSatisfies` can refuse a task
   * whose form does not ask for what its action reads — otherwise the failure
   * is a task that saves cleanly and does nothing at run time.
   */
  inputs: readonly ActionInput[];
  /**
   * Whether this action touches a USER, and under which input key.
   *
   * Named here rather than inferred, because it drives the escalation guard:
   * a delegated task may not act on somebody who holds a permission the
   * runner does not. See `assertNotMorePrivileged`.
   */
  subjectKey: string | null;
  run(context: ActionContext, values: ActionValues): Promise<ActionOutcome>;
}

const str = (values: ActionValues, key: string): string => {
  const value = values[key];
  return typeof value === 'string' ? value : '';
};

export const ACTIONS: Record<ActionKey, ActionDefinition> = {
  unlock_account: {
    key: 'unlock_account',
    label: 'Unlock an account',
    description:
      'Clears a lockout so somebody can sign in again. Their password is unchanged.',
    inputs: [{ key: 'user', type: 'lookup', label: 'Account', dataSource: 'user' }],
    subjectKey: 'user',
    async run(context, values) {
      const userId = str(values, 'user');
      // Idempotent: clearing a lock that is not there is what somebody whose
      // colleague already unlocked them means.
      await withTenant(context.tenantId, (tx) => clearLockout(tx, userId));
      // The same action the admin route writes when an administrator unlocks
      // somebody by hand, so one search finds every unlock however it was
      // done — and the runner is named on it either way.
      await audit(context, 'auth.lockout_cleared', userId, {});
      return { ok: true, message: 'That account can sign in again.' };
    },
  },

  send_password_reset: {
    key: 'send_password_reset',
    label: 'Send a password reset link',
    description:
      'Emails a reset link to the address on the account. Nobody, including the sender, sees the new password.',
    inputs: [{ key: 'user', type: 'lookup', label: 'Account', dataSource: 'user' }],
    subjectKey: 'user',
    async run(context, values) {
      const userId = str(values, 'user');
      const login = await withTenant(context.tenantId, async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { login: true },
        });
        return user?.login ?? null;
      });
      if (login === null) return { ok: false, message: 'That account no longer exists.' };

      // Outside any transaction, and it never rejects: `requestPasswordReset`
      // queues the mail and answers in the same time whether or not it had
      // anything to send. That timing property is a non-enumeration control on
      // the public form; it costs nothing to keep here.
      await requestPasswordReset(context.tenantId, context.transport, context.publicUrl, {
        login,
        sourceIp: context.sourceIp,
      });
      return { ok: true, message: 'A reset link is on its way to the address on file.' };
    },
  },

  add_group_member: {
    key: 'add_group_member',
    label: 'Add somebody to a group',
    description: 'Adds an account to a directory group.',
    inputs: [
      { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user' },
      { key: 'group', type: 'lookup', label: 'Group', dataSource: 'group' },
    ],
    subjectKey: 'user',
    async run(context, values) {
      await withTenant(context.tenantId, (tx) =>
        addMember(tx, str(values, 'group'), str(values, 'user')),
      );
      await audit(context, 'directory.group_member_added', str(values, 'user'), {
        groupId: str(values, 'group'),
      });
      return { ok: true, message: 'Added to the group.' };
    },
  },

  remove_group_member: {
    key: 'remove_group_member',
    label: 'Remove somebody from a group',
    description: 'Removes an account from a directory group.',
    inputs: [
      { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user' },
      { key: 'group', type: 'lookup', label: 'Group', dataSource: 'group' },
    ],
    subjectKey: 'user',
    async run(context, values) {
      await withTenant(context.tenantId, (tx) =>
        removeMember(tx, str(values, 'group'), str(values, 'user')),
      );
      await audit(context, 'directory.group_member_removed', str(values, 'user'), {
        groupId: str(values, 'group'),
      });
      return { ok: true, message: 'Removed from the group.' };
    },
  },
};

async function audit(
  context: ActionContext,
  action: string,
  targetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await withTenant(context.tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: context.runnerUserId,
      action,
      targetType: 'User',
      targetId,
      outcome: 'success',
      sourceIp: context.sourceIp,
      payload,
    }),
  );
}

export function actionDefinition(key: string): ActionDefinition {
  const definition = (ACTIONS as Record<string, ActionDefinition | undefined>)[key];
  if (definition === undefined) throw new UnknownActionError(key);
  return definition;
}

export class UnknownActionError extends Error {
  constructor(readonly key: string) {
    super(`no action called "${key}"`);
    this.name = 'UnknownActionError';
  }
}

export class EscalationRefusedError extends Error {
  constructor() {
    super(
      'this task cannot act on that account: it holds a permission you do not, ' +
        'and a delegated task may not be used to reach further than the person running it',
    );
    this.name = 'EscalationRefusedError';
  }
}

/**
 * Refuses a delegated task aimed at somebody more privileged than the runner.
 *
 * **This is what makes delegation safe, and without it the feature is a
 * takeover primitive.** A delegated task runs with Syntra's authority, not the
 * runner's — that is the entire point: a helpdesk user who holds no
 * administrative permission can nevertheless unlock an account. The obvious
 * consequence, and the one that has to be closed here, is that the same task
 * pointed at the owner's account resets the owner's password and mails the
 * link to an address the helpdesk user may control.
 *
 * The rule is a comparison, not a list: the runner may act on anybody whose
 * permissions are a subset of their own. Somebody with no permissions can act
 * on anybody with no permissions, which is the helpdesk case, and on nobody
 * who administers anything — which is exactly the boundary that was missing.
 *
 * Acting on YOURSELF is always allowed. The subset test would permit it
 * anyway; saying so explicitly means the rule does not accidentally depend on
 * set equality behaving a particular way for the case people hit most.
 */
export async function assertNotMorePrivileged(
  tenantId: string,
  runnerUserId: string,
  subjectUserId: string,
): Promise<void> {
  if (runnerUserId === subjectUserId) return;
  await withTenant(tenantId, async (tx) => {
    const [runner, subject] = await Promise.all([
      permissionsForUser(tx, runnerUserId),
      permissionsForUser(tx, subjectUserId),
    ]);
    for (const permission of subject) {
      if (!runner.has(permission)) throw new EscalationRefusedError();
    }
  });
}

export class FormMissingInputError extends Error {
  constructor(
    readonly actionKey: string,
    readonly missing: string,
  ) {
    super(`the form for "${actionKey}" has no field called "${missing}"`);
    this.name = 'FormMissingInputError';
  }
}

/**
 * Refuses a task whose form does not ask for what its action reads.
 *
 * Checked when the task is SAVED, not when it is run. The failure it prevents
 * is the quiet kind: a task that saves cleanly, appears in the portal, and
 * does nothing at all — or worse, calls a service with an empty string where
 * an id should be.
 */
export function assertFormSatisfies(
  actionKey: string,
  fields: readonly {
    key: string;
    type: FormFieldType;
    required: boolean;
    dataSource?: DataSource | undefined;
  }[],
): void {
  const definition = actionDefinition(actionKey);
  for (const input of definition.inputs) {
    const field = fields.find((candidate) => candidate.key === input.key);
    if (
      field === undefined ||
      field.type !== input.type ||
      (input.dataSource !== undefined && field.dataSource !== input.dataSource) ||
      // REQUIRED, not merely present. An action's declared input is something
      // it reads, and a form that lets it be left blank produces a run with no
      // subject — which skips `assertNotMorePrivileged` entirely, because
      // there is no account named to check. Today no action does anything
      // dangerous with an empty subject; the next one might, and a guard that
      // is skipped rather than failed is the worst way to find out.
      !field.required
    ) {
      throw new FormMissingInputError(actionKey, input.key);
    }
  }
}

/**
 * The accounts this person may aim a delegated task at.
 *
 * The same rule `assertNotMorePrivileged` enforces, computed for the whole
 * directory at once — and it is the SAME rule on purpose. A picker that
 * offered accounts the guard will refuse is a control that needs a paragraph
 * of explanation attached to a failure, which is the wrong shape: the list
 * should simply not contain what cannot be chosen.
 *
 * Two queries rather than one per candidate: `permissionsForUser` is a query
 * apiece, and a directory of five thousand people would make opening a picker
 * five thousand round trips.
 *
 * Deactivated accounts are still offered. "Unlock an account" and "send a
 * reset link" are exactly the things somebody needs for an account that is not
 * currently working, and filtering by status would hide the cases the feature
 * exists for.
 */
export async function actionableUserIds(
  tx: TenantClient,
  runnerUserId: string,
): Promise<string[]> {
  const assignments = await tx.roleAssignment.findMany({ include: { role: true } });

  const held = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const set = held.get(assignment.userId) ?? new Set<string>();
    for (const permission of assignment.role.permissions) set.add(permission);
    held.set(assignment.userId, set);
  }

  const runner = held.get(runnerUserId) ?? new Set<string>();
  const users = await tx.user.findMany({ select: { id: true } });

  return users
    .filter((user) => {
      if (user.id === runnerUserId) return true;
      const theirs = held.get(user.id);
      if (theirs === undefined) return true;
      for (const permission of theirs) if (!runner.has(permission)) return false;
      return true;
    })
    .map((user) => user.id);
}
