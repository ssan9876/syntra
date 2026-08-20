/**
 * The unions every Automate module speaks, in one place, so that a status
 * string is spelled the same way in the schema, the service, the API and the
 * console. These mirror the check constraints in
 * `20260823000000_automate_requests` exactly; if one moves, both move.
 */

export type ProductKind = 'targetEntitlement' | 'application' | 'localGroup';

export type ResourceType = 'entitlement' | 'application' | 'group';

/** Which resource type a product of each kind grants. */
export const RESOURCE_TYPE_FOR_KIND: Record<ProductKind, ResourceType> = {
  targetEntitlement: 'entitlement',
  application: 'application',
  localGroup: 'group',
};

export type RequestStatus =
  | 'pending_approval'
  | 'blocked_no_approver'
  | 'approved'
  | 'awaiting_fulfilment'
  | 'fulfilled'
  /**
   * TERMINAL. Every item reached a terminal state, some landed and some did
   * not, and the request names which. A request with items still in flight is
   * `awaiting_fulfilment`, never this.
   */
  | 'partially_fulfilled'
  | 'fulfilment_failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type RequestItemStatus =
  | 'pending'
  | 'dispatched'
  | 'fulfilled'
  | 'failed'
  | 'skipped';

export type GrantStatus =
  | 'scheduled'
  | 'pending'
  | 'active'
  | 'expired'
  | 'lapsed'
  | 'revoked';

export type StepStatus = 'waiting' | 'open' | 'approved' | 'rejected' | 'skipped';

export type ApproverVia =
  | 'selector'
  | 'delegate'
  | 'escalation'
  | 'fallback'
  | 'administrator';

export type SweepActionKind = 'expire' | 'lapse';

export type RefusalReason =
  | 'not_visible'
  | 'no_longer_eligible'
  | 'subject_departed'
  | 'subject_inactive'
  | 'already_held'
  | 'product_withdrawn'
  | 'no_user_account'
  | 'invalid_form'
  | 'duration_not_permitted'
  | 'not_permitted_on_behalf'
  /**
   * Granting this would create a CRITICAL segregation-of-duties violation.
   * Only `critical` refuses; below that the approver is told and approving
   * records an acknowledgement. Blocking on a lower severity would freeze
   * somebody for a configuration error somebody else made.
   */
  | 'sod_violation'
  | 'workflow_disabled';

/**
 * A grant that occupies the one-live-grant slot. The same predicate as the
 * `access_grant_one_live` partial unique index, written once so the query and
 * the constraint cannot drift apart.
 */
export const LIVE_GRANT_STATUSES: readonly GrantStatus[] = [
  'scheduled',
  'pending',
  'active',
];

/**
 * The grants desired state includes: those whose window covers now.
 * `scheduled` is deliberately absent -- a scheduled grant is visible in the
 * console, says when it starts, and confers NOTHING until it does.
 */
export const IN_FORCE_GRANT_STATUSES: readonly GrantStatus[] = ['pending', 'active'];

export const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
  'fulfilled',
  'partially_fulfilled',
  'fulfilment_failed',
  'rejected',
  'cancelled',
  'expired',
];
