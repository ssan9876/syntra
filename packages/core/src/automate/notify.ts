import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { TemplateName } from '../notify/templates/index.js';
import type { Permission } from '../rbac/permissions.js';
import type { ResourceType } from './types.js';

/**
 * The templates this slice adds. A narrowing of `TemplateName` rather than a
 * second list, so a template renamed in one place fails to compile in the
 * other.
 */
export type AutomateTemplate = Extract<TemplateName, `automate-${string}`>;

/**
 * Every template the OUTBOX can carry. `AutomateTemplate` stays as it is for
 * Automate's own code; this is the wider one the outbox is typed on, because
 * the outbox is a shared table and Govern writes into it too.
 *
 * Written as an `Extract` over two prefixes rather than as `TemplateName`
 * itself, deliberately: `welcome` and `password-reset` are sent directly by
 * Core's own paths and must not become enqueueable by accident, so the prefixes
 * remain the allow-list and a third subsystem has to add itself here on purpose.
 */
export type OutboxTemplate = Extract<
  TemplateName,
  `automate-${string}` | `govern-${string}`
>;

/**
 * Failures, blocks and confirmations are never digested, regardless of
 * preference.
 *
 * A digest is a convenience for routine traffic. The traffic that matters is
 * the traffic that says something is stuck, and a stuck request that arrives
 * tomorrow morning in a summary is a stuck request nobody acted on today.
 */
export const NEVER_DIGESTED: readonly OutboxTemplate[] = [
  'automate-fulfilment-failed',
  'automate-partially-fulfilled',
  'automate-awaiting-fulfilment-sla',
  'automate-blocked-no-approver',
  'automate-sweep-confirmation',
  // Section 17: a `critical` governance finding is notified IMMEDIATELY and is
  // never digested. That sentence is in the spec, in the template's own body
  // ("It was sent the moment it was found") and in `verifyIncremental`'s
  // comment -- and until this entry existed it was enforced by none of them.
  // The digest path is exactly where an urgent message silently rejoins the
  // queue: `enqueueOutbox` writes `digest: true` for any digestible template
  // whose recipient chose a daily summary, and an audit chain that does not
  // hold, arriving in tomorrow morning's summary, is an audit chain nobody
  // acted on today.
  'govern-finding-critical',
];

export function isDigestible(template: OutboxTemplate): boolean {
  return !NEVER_DIGESTED.includes(template);
}

export interface OutboxDraft {
  template: OutboxTemplate;
  to: string;
  vars: Record<string, string>;
  requestId: string | null;
  /** Who it is for, so a digest preference can be honoured. */
  userId: string | null;
}

/**
 * Writes messages down. Sends nothing.
 *
 * Takes a `TenantClient` and no `Transport`, which is what makes the ordering
 * structural rather than remembered: `sendMessage` takes a `Transport` and no
 * `TenantClient`, so the shape that put an SMTP round trip inside
 * `prisma.$transaction` -- twice, on this project -- does not type-check from
 * either end.
 *
 * Returns how many rows were written, so a caller can assert on it without a
 * second query.
 */
export async function enqueueOutbox(
  tx: TenantClient,
  drafts: readonly OutboxDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0;
  const tenantId = await currentTenant(tx);

  const userIds = drafts
    .map((d) => d.userId)
    .filter((id): id is string => id !== null);
  const preferences =
    userIds.length === 0
      ? []
      : await tx.notificationPreference.findMany({
          where: { userId: { in: userIds }, mode: 'daily' },
          select: { userId: true },
        });
  const wantsDigest = new Set(preferences.map((p) => p.userId));

  await tx.notificationOutbox.createMany({
    data: drafts.map((draft) => ({
      tenantId,
      template: draft.template,
      to: draft.to,
      vars: draft.vars,
      requestId: draft.requestId,
      userId: draft.userId,
      digest:
        isDigestible(draft.template) &&
        draft.userId !== null &&
        wantsDigest.has(draft.userId),
    })),
  });

  return drafts.length;
}

export interface Recipient {
  userId: string;
  personId: string | null;
  email: string;
  displayName: string;
}

/**
 * The active accounts belonging to these people.
 *
 * A person with several accounts is told once per account, deliberately: an
 * application granted to a person is granted to that person, and picking one
 * of their logins arbitrarily is a support call waiting to happen. A person
 * with no account at all yields nothing, which is a fact the caller may need
 * to notice rather than an error.
 */
export async function recipientsForPersons(
  tx: TenantClient,
  personIds: readonly string[],
): Promise<Recipient[]> {
  const unique = [...new Set(personIds)];
  if (unique.length === 0) return [];
  const users = await tx.user.findMany({
    where: { personId: { in: unique }, status: 'active' },
    select: { id: true, personId: true, email: true, displayName: true },
    orderBy: { login: 'asc' },
  });
  return users.map((u) => ({
    userId: u.id,
    personId: u.personId,
    email: u.email,
    displayName: u.displayName,
  }));
}

/**
 * Everybody who holds a permission, for the notifications addressed to a
 * capability rather than to a person -- a blocked request, a failed
 * fulfilment, a sweep awaiting confirmation.
 *
 * Reads role assignments and filters in memory because `Role.permissions` is a
 * string array on the row rather than a join table: `hasPermission` does the
 * same, and this is its inverse. Inactive accounts are excluded, because
 * telling a deactivated account that a request is stuck reaches nobody and
 * makes the queue look attended.
 *
 * **`RoleAssignment.scopeOrgUnitId` is deliberately ignored, and every caller
 * is tenant-wide.** The three things this function addresses -- a request no
 * approver resolves to, a fulfilment that failed, a sweep that will not apply
 * -- are not attributable to an org unit: the sweep is tenant-wide by
 * construction, and a blocked request's subject may sit in a unit whose
 * scoped administrator is precisely the person who cannot help. The failure
 * mode of filtering is that nobody is told; the failure mode of not filtering
 * is that a scoped administrator is told about something outside their scope.
 * Between a silence and an over-notification on the queue that exists to
 * surface stuck work, the over-notification is the right side to err on. If
 * that changes, it changes here, once, and not per caller.
 */
export async function usersWithPermission(
  tx: TenantClient,
  permission: Permission,
): Promise<Recipient[]> {
  const assignments = await tx.roleAssignment.findMany({ include: { role: true } });
  const userIds = [
    ...new Set(
      assignments
        .filter((a) => a.role.permissions.includes(permission))
        .map((a) => a.userId),
    ),
  ];
  if (userIds.length === 0) return [];

  const users = await tx.user.findMany({
    where: { id: { in: userIds }, status: 'active' },
    select: { id: true, personId: true, email: true, displayName: true },
    orderBy: { login: 'asc' },
  });
  return users.map((u) => ({
    userId: u.id,
    personId: u.personId,
    email: u.email,
    displayName: u.displayName,
  }));
}

/**
 * Display names for the people, products and resources a template renders.
 *
 * Keyed `person:<id>`, `product:<id>` and `<resourceType>:<resourceId>`, so a
 * caller that already holds a `resourceType:resourceId` key -- which every
 * fulfilment and sweep path does -- looks up with the key it has.
 *
 * This exists because the alternative is what the first draft of this plan
 * did: pass `subjectName: request.subjectPersonId` and
 * `resourceList: granted.join(', ')` where each entry is
 * `"application:0f3e..."`. Spec section 13 requires each of these to NAME
 * things -- "names what they now hold and until when", "names what did not
 * land, and why", "the requester is told, by name, with the reason" -- and
 * section 7 makes naming the approver a design decision, because "anonymous
 * approval is worse than visible approval: it makes chasing impossible". A
 * mail reading "guid-4f2a... holds guid-91be... until Mon Jun 15 2026"
 * satisfies none of that, and Automate sends more mail than the rest of the
 * platform combined.
 *
 * Unknown ids are simply absent from the map, so a caller's `?? 'the
 * requested access'` fallback is what renders -- never a raw UUID.
 */
export async function displayNames(
  tx: TenantClient,
  input: {
    personIds?: readonly string[];
    productIds?: readonly string[];
    resources?: readonly { resourceType: ResourceType; resourceId: string }[];
  },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  const personIds = [...new Set(input.personIds ?? [])];
  if (personIds.length > 0) {
    const persons = await tx.person.findMany({
      where: { id: { in: personIds } },
      select: { id: true, givenName: true, familyName: true },
    });
    for (const person of persons) {
      out.set(`person:${person.id}`, `${person.givenName} ${person.familyName}`.trim());
    }
  }

  const productIds = [...new Set(input.productIds ?? [])];
  if (productIds.length > 0) {
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });
    for (const product of products) out.set(`product:${product.id}`, product.name);
  }

  const resources = input.resources ?? [];
  const byType = (type: ResourceType) => [
    ...new Set(resources.filter((r) => r.resourceType === type).map((r) => r.resourceId)),
  ];

  const entitlementIds = byType('entitlement');
  if (entitlementIds.length > 0) {
    const rows = await tx.entitlement.findMany({
      where: { id: { in: entitlementIds } },
      select: { id: true, displayName: true },
    });
    for (const row of rows) out.set(`entitlement:${row.id}`, row.displayName);
  }

  const applicationIds = byType('application');
  if (applicationIds.length > 0) {
    const rows = await tx.application.findMany({
      where: { id: { in: applicationIds } },
      select: { id: true, name: true },
    });
    for (const row of rows) out.set(`application:${row.id}`, row.name);
  }

  const groupIds = byType('group');
  if (groupIds.length > 0) {
    const rows = await tx.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, name: true },
    });
    for (const row of rows) out.set(`group:${row.id}`, row.name);
  }

  return out;
}

/**
 * The names of a list of resources, in order, as a sentence fragment a
 * template can drop into "You now hold {{resourceList}}".
 *
 * Falls back to the resource type rather than to the id: "an application" is
 * unhelpful, "application:0f3e-..." is worse, because it looks like a
 * reference the reader is supposed to be able to use.
 */
export function nameList(
  names: Map<string, string>,
  resources: readonly { resourceType: ResourceType; resourceId: string }[],
): string {
  return resources
    .map((r) => names.get(`${r.resourceType}:${r.resourceId}`) ?? `an unnamed ${r.resourceType}`)
    .join(', ');
}
