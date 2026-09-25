import type { State } from '@syntra/ui';

/**
 * A request's status in the console's state language (`StateBadge`).
 *
 * The two that mean somebody has to do something — nobody can approve it, or
 * it was approved and could not be applied — are `blocked`. Waiting on an
 * approver is `pending`: a thing outside the reader's hands. A request that
 * ended without being granted (refused, withdrawn, expired) is `inactive` —
 * an outcome, shown and never hidden, not a fault.
 */
export const REQUEST_STATE: Record<string, State> = {
  pending_approval: 'pending',
  blocked_no_approver: 'blocked',
  approved: 'pending',
  awaiting_fulfilment: 'running',
  fulfilled: 'healthy',
  partially_fulfilled: 'attention',
  fulfilment_failed: 'blocked',
  rejected: 'inactive',
  cancelled: 'inactive',
  expired: 'inactive',
};

export const REQUEST_LABEL: Record<string, string> = {
  pending_approval: 'Waiting for approval',
  blocked_no_approver: 'Nobody can approve this',
  approved: 'Approved',
  awaiting_fulfilment: 'Approved, being applied',
  fulfilled: 'Granted',
  partially_fulfilled: 'Partly granted',
  fulfilment_failed: 'Could not be applied',
  rejected: 'Refused',
  cancelled: 'Withdrawn',
  expired: 'Expired without a decision',
};

export const GRANT_STATE: Record<string, State> = {
  scheduled: 'pending',
  pending: 'running',
  active: 'healthy',
  expired: 'inactive',
  lapsed: 'inactive',
  revoked: 'inactive',
};

export const GRANT_LABEL: Record<string, string> = {
  scheduled: 'Starts later',
  pending: 'Being applied',
  active: 'Held',
  expired: 'Ended',
  lapsed: 'Ended with the contract',
  revoked: 'Given back',
};

export const when = (iso: string | null): string =>
  iso === null ? '—' : new Date(iso).toLocaleDateString();
