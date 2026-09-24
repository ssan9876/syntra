import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { PERMISSIONS, type Permission } from '../rbac/permissions.js';
import { isSecurityEvent } from './security-events.js';

/**
 * The customer-visible security notification policy (backlog #52).
 *
 * Every event named here is ALREADY a security event: it is audited, and it is
 * delivered to any webhook endpoint subscribed to its group. What this adds is
 * a second, opt-in channel for the categories a customer's administrators
 * should hear about by mail without having to build an integration first --
 * and a single place that says which events those are, so the policy table in
 * configure.md is a rendering of this object rather than a second copy of it.
 *
 * A CLOSED SET, like the webhook projection. A category lists audit actions by
 * name; an event qualifies only if its action is listed AND, where the
 * category narrows further, its `qualifies` check agrees. The mail carries the
 * same fields as a webhook body -- action, outcome, time, sequence -- and
 * never the audit payload.
 */
export interface SecurityNotificationCategory {
  label: string;
  /** One sentence, for the settings screen and the policy table. */
  description: string;
  actions: readonly string[];
  /**
   * Who sends the mail. `audit` is the `recordEvent` hook below; `scan` is the
   * credential expiry scan, which mails the credential's owner as well and
   * builds a richer message than an audit event can carry.
   */
  mailedBy: 'audit' | 'scan';
}

/**
 * Permissions whose grant is a privilege escalation worth telling people about.
 *
 * Broader than change control's `PRIVILEGED_PERMISSIONS`: a grant of
 * `provision.manage` is worth an email without being worth a second approver.
 *
 * Authority over authority (`rbac.manage`, `tenant.manage`), over credentials
 * (`secrets.write`, `token.manage`), over the installation (`deployment.manage`),
 * over who may sign in and how (`policy.manage`, `access.manage`), over writes
 * into connected systems (`provision.manage`, `sync.manage`), and the two
 * that remove or accept what cannot be walked back.
 */
export const NOTIFIABLE_PRIVILEGED_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.TENANT_MANAGE,
  PERMISSIONS.RBAC_MANAGE,
  PERMISSIONS.SECRETS_WRITE,
  PERMISSIONS.TOKEN_MANAGE,
  PERMISSIONS.DEPLOYMENT_MANAGE,
  PERMISSIONS.POLICY_MANAGE,
  PERMISSIONS.ACCESS_MANAGE,
  PERMISSIONS.PROVISION_MANAGE,
  PERMISSIONS.SYNC_MANAGE,
  PERMISSIONS.DIRECTORY_DELETE,
  PERMISSIONS.GOVERN_ACCEPT_RISK,
];

export const SECURITY_NOTIFICATION_CATEGORIES = {
  credential_changes: {
    label: 'Credential changes',
    description:
      'A connector credential was replaced or rotated, an API token was issued or revoked, a webhook signing secret was rotated, an SFTP host key was pinned, or the SAML signing key was rolled over.',
    actions: [
      'credential.changed',
      'credential.rotation_cut_over',
      'credential.rotation_completed',
      'credential.rotation_rolled_back',
      'api_token.issued',
      'api_token.revoked',
      'notify.webhook_secret_rotated',
      'person_source.host_key_accepted',
      'signing_key.rotated',
    ],
    mailedBy: 'audit',
  },
  privileged_role_grants: {
    label: 'Privileged role grants',
    description:
      'Somebody was assigned a role that carries a privileged permission (tenant, role, secret, token, deployment, policy, access, provisioning or sync management, directory deletion or risk acceptance).',
    actions: ['rbac.role_assigned'],
    mailedBy: 'audit',
  },
  data_exports: {
    label: 'Data exports',
    description: 'A bulk export of tenant data (the audit log or a Governance access report) was requested.',
    actions: ['export.request'],
    mailedBy: 'audit',
  },
  write_stops: {
    label: 'Emergency write stops',
    description:
      'A tenant-wide or per-target external-write stop was placed, resumed by a second administrator, or expired.',
    actions: [
      'provision.tenant.external_writes.pause',
      'provision.tenant.external_writes.resume',
      'provision.tenant.external_writes.expire',
      'provision.target.external_writes.pause',
      'provision.target.external_writes.resume',
      'provision.target.external_writes.expire',
    ],
    mailedBy: 'audit',
  },
  suspicious_authentication: {
    label: 'Suspicious authentication',
    description:
      "An account was locked out or unlocked, an administrator removed somebody's second factor, or a token was requested with no authorization decision behind it.",
    actions: ['auth.lockout', 'auth.lockout_cleared', 'mfa.removed', 'oidc.decision_missing'],
    mailedBy: 'audit',
  },
  credential_expiry: {
    label: 'Credential expiry',
    description:
      "A credential crossed an advance-warning threshold or expired. The credential's owner is always told; administrators are told when this is on, or when the credential has no owner.",
    actions: ['credential.expiring', 'credential.expired'],
    mailedBy: 'scan',
  },
} as const satisfies Record<string, SecurityNotificationCategory>;

export type SecurityNotificationCategoryKey = keyof typeof SECURITY_NOTIFICATION_CATEGORIES;

export const SECURITY_NOTIFICATION_CATEGORY_KEYS = Object.keys(
  SECURITY_NOTIFICATION_CATEGORIES,
) as SecurityNotificationCategoryKey[];

export function isSecurityNotificationCategory(value: string): value is SecurityNotificationCategoryKey {
  return value in SECURITY_NOTIFICATION_CATEGORIES;
}

/** Plain-language names for the mailed actions. The action itself is in the mail too. */
const EVENT_LABELS: Record<string, string> = {
  'credential.changed': 'A connector credential was replaced',
  'credential.rotation_cut_over': 'A credential rotation cut over to the new secret',
  'credential.rotation_completed': 'A credential rotation completed and the old secret was retired',
  'credential.rotation_rolled_back': 'A credential rotation was rolled back to the old secret',
  'api_token.issued': 'An API token was issued',
  'api_token.revoked': 'An API token was revoked',
  'notify.webhook_secret_rotated': 'A webhook signing secret was rotated',
  'person_source.host_key_accepted': 'An SFTP host key was pinned',
  'signing_key.rotated': 'The SAML signing key was rolled over',
  'rbac.role_assigned': 'A privileged role was assigned',
  'export.request': 'A data export was requested',
  'provision.tenant.external_writes.pause': 'All connector writes were stopped',
  'provision.tenant.external_writes.resume': 'Connector writes were resumed tenant-wide',
  'provision.tenant.external_writes.expire': 'The tenant-wide write stop expired',
  'provision.target.external_writes.pause': 'Writes to a target were stopped',
  'provision.target.external_writes.resume': 'Writes to a target were resumed',
  'provision.target.external_writes.expire': 'A target write stop expired',
  'auth.lockout': 'An account was locked out',
  'auth.lockout_cleared': 'An account lockout was cleared',
  'mfa.removed': "An administrator removed a user's second factor",
  'oidc.decision_missing': 'A token was requested with no authorization decision',
};

const CATEGORY_BY_ACTION = new Map<string, SecurityNotificationCategoryKey>();
for (const key of SECURITY_NOTIFICATION_CATEGORY_KEYS) {
  for (const action of SECURITY_NOTIFICATION_CATEGORIES[key].actions) {
    CATEGORY_BY_ACTION.set(action, key);
  }
}

/** The category an action belongs to, or null. */
export function securityNotificationCategoryFor(action: string): SecurityNotificationCategoryKey | null {
  return CATEGORY_BY_ACTION.get(action) ?? null;
}

export function securityEventLabel(action: string): string {
  return EVENT_LABELS[action] ?? action;
}

/** Where a mail points. Relative when no public URL is configured. */
export function consoleUrl(path: string): string {
  const base = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

export interface MailRecipient {
  userId: string;
  email: string;
  displayName: string;
}

/**
 * Active holders of `tenant.manage`, tenant-wide.
 *
 * The same read `usersWithPermission` makes, restated here rather than
 * imported because this module is imported by the audit service, and the
 * Automate notification module imports the webhook service that imports the
 * audit service's neighbours -- a cycle waiting for a refactor to close it.
 */
export async function tenantAdministrators(tx: TenantClient): Promise<MailRecipient[]> {
  const assignments = await tx.roleAssignment.findMany({ include: { role: true } });
  const ids = [
    ...new Set(
      assignments.filter((a) => a.role.permissions.includes(PERMISSIONS.TENANT_MANAGE)).map((a) => a.userId),
    ),
  ];
  if (ids.length === 0) return [];
  const users = await tx.user.findMany({
    where: { id: { in: ids }, status: 'active' },
    select: { id: true, email: true, displayName: true },
    orderBy: { login: 'asc' },
  });
  return users
    .filter((u) => u.email !== '')
    .map((u) => ({ userId: u.id, email: u.email, displayName: u.displayName }));
}

/** Writes security mail into the outbox. Sends nothing, fans out no webhook. */
export async function enqueueSecurityMail(
  tx: TenantClient,
  tenantId: string,
  template: 'security-event' | 'security-credential-expiring' | 'security-credential-expired',
  recipients: readonly MailRecipient[],
  vars: Record<string, string>,
): Promise<number> {
  const unique = new Map<string, MailRecipient>();
  for (const r of recipients) if (!unique.has(r.email.toLowerCase())) unique.set(r.email.toLowerCase(), r);
  if (unique.size === 0) return 0;
  await tx.notificationOutbox.createMany({
    data: [...unique.values()].map((r) => ({
      tenantId,
      template,
      to: r.email,
      vars: { ...vars, displayName: r.displayName },
      requestId: null,
      userId: r.userId,
      // Never held for a digest: a security notification in tomorrow's summary
      // is one nobody acted on today.
      digest: false,
    })),
  });
  return unique.size;
}

interface MailableEvent {
  action: string;
  outcome: 'success' | 'failure';
  occurredAt: Date;
  sequence: number;
  actorUserId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Whether an event in a listed action also passes its category's narrowing.
 *
 * Three actions are broader than the category they sit in: a role assignment
 * is only a *privileged* grant when the role carries a privileged permission,
 * `mfa.removed` is only a reset when an administrator did it (a person
 * removing their own factor is housekeeping), and a signing-key rollover is
 * only news for SAML (the OIDC key rolls monthly, invisibly to every relying
 * party).
 */
async function qualifies(tx: TenantClient, event: MailableEvent): Promise<boolean> {
  switch (event.action) {
    case 'rbac.role_assigned': {
      const roleId = event.payload.roleId;
      if (event.outcome !== 'success') return false;
      if (typeof roleId !== 'string') return false;
      const role = await tx.role.findUnique({ where: { id: roleId }, select: { permissions: true } });
      return role?.permissions.some((p) => (NOTIFIABLE_PRIVILEGED_PERMISSIONS as readonly string[]).includes(p)) ?? false;
    }
    case 'mfa.removed':
      return event.payload.by === 'administrator';
    case 'signing_key.rotated':
      return event.payload.kind === 'saml';
    default:
      return true;
  }
}

/**
 * The `recordEvent` hook: mails `tenant.manage` holders when the tenant has
 * switched this event's category on.
 *
 * Inside the audit transaction, for the reason the webhook fan-out is: an
 * event audited and not announced is two records disagreeing. Costs nothing
 * for an action outside the policy (one map lookup), and one indexed tenant
 * read for a listed action in a tenant that has not opted in.
 */
export async function enqueueSecurityNotification(tx: TenantClient, event: MailableEvent): Promise<number> {
  if (!isSecurityEvent(event.action)) return 0;
  const category = securityNotificationCategoryFor(event.action);
  if (category === null) return 0;
  const definition: SecurityNotificationCategory = SECURITY_NOTIFICATION_CATEGORIES[category];
  if (definition.mailedBy !== 'audit') return 0;

  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { securityEmailCategories: true },
  });
  if (!tenant?.securityEmailCategories.includes(category)) return 0;
  if (!(await qualifies(tx, event))) return 0;

  const recipients = await tenantAdministrators(tx);
  return enqueueSecurityMail(tx, tenantId, 'security-event', recipients, {
    eventLabel: securityEventLabel(event.action),
    action: event.action,
    outcome: event.outcome,
    occurredAt: event.occurredAt.toISOString(),
    sequence: String(event.sequence),
    categoryLabel: definition.label,
    auditUrl: consoleUrl(`/admin/activity?tab=all`),
  });
}
