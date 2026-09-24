import type { TenantClient } from '@syntra/db';

/**
 * A REFERENCE TO ANOTHER TENANT'S ROW, REFUSED BEFORE IT IS WRITTEN.
 *
 * Row-level security stops a transaction bound to tenant A from READING or
 * WRITING tenant B's rows. It does not stop A from writing a row of its own
 * that POINTS at one of B's: PostgreSQL checks a foreign key without applying
 * the referenced table's policies (the check has to see the row to be a
 * constraint at all), so `Person.orgUnitId = <B's org unit>` satisfies both
 * the policy -- the person is A's -- and the constraint -- the unit exists.
 *
 * The tenant-isolation probe (`apps/api/src/tenant-isolation`) found four
 * write paths doing exactly that, each taking the id from a request body and
 * writing it without looking it up first. The damage is quiet rather than
 * loud: A's person is placed by B's org-unit template, A's contract names B's
 * person as manager, A's application is assigned to B's user; and every read
 * back through the relation comes back empty under RLS, so nobody sees why.
 *
 * The fix is to look the id up under the SAME transaction before writing it.
 * The lookup is RLS-scoped, so a foreign id and a nonexistent one are the same
 * answer: not found. That is also what makes the refusal safe to show -- it
 * tells the caller nothing about whether the id exists anywhere else.
 */
export type ReferenceKind =
  | 'person'
  | 'orgUnit'
  | 'user'
  | 'group'
  | 'application'
  | 'entitlement'
  | 'businessFunction'
  | 'approvalWorkflow';

export class UnknownReferenceError extends Error {
  constructor(
    /** The request field that carried the id, for the problem's `errors[].path`. */
    readonly field: string,
    readonly kind: ReferenceKind,
  ) {
    super(`${field}: no such ${kind}`);
    this.name = 'UnknownReferenceError';
  }
}

const exists: Record<ReferenceKind, (tx: TenantClient, id: string) => Promise<unknown>> = {
  person: (tx, id) => tx.person.findUnique({ where: { id }, select: { id: true } }),
  orgUnit: (tx, id) => tx.orgUnit.findUnique({ where: { id }, select: { id: true } }),
  user: (tx, id) => tx.user.findUnique({ where: { id }, select: { id: true } }),
  group: (tx, id) => tx.group.findUnique({ where: { id }, select: { id: true } }),
  application: (tx, id) => tx.application.findUnique({ where: { id }, select: { id: true } }),
  entitlement: (tx, id) => tx.entitlement.findUnique({ where: { id }, select: { id: true } }),
  businessFunction: (tx, id) => tx.businessFunction.findUnique({ where: { id }, select: { id: true } }),
  approvalWorkflow: (tx, id) => tx.approvalWorkflow.findUnique({ where: { id }, select: { id: true } }),
};

/**
 * Throws `UnknownReferenceError` unless `id` is a row of `kind` in the tenant
 * `tx` is bound to. `null` and `undefined` are "no reference" and pass: a
 * caller clearing a manager is not naming one.
 *
 * Automate's polymorphic `(resourceType, resourceId)` pairs -- an owner, a
 * delegation -- pass their `resourceType` as the kind. Those have no foreign
 * key at all, so this lookup is the only thing that stops them naming another
 * tenant's group.
 */
export async function assertReferenceInTenant(
  tx: TenantClient,
  kind: ReferenceKind,
  id: string | null | undefined,
  field: string,
): Promise<void> {
  if (id === null || id === undefined) return;
  if ((await exists[kind](tx, id)) === null) throw new UnknownReferenceError(field, kind);
}
