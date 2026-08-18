type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

/**
 * The statuses that mean somebody has to do something are the loud ones.
 * `blocked_no_approver` and `fulfilment_failed` are danger because they are
 * stuck; `awaiting_fulfilment` is primary because it is working.
 */
export const REQUEST_TONE: Record<string, Tone> = {
  pending_approval: 'primary',
  blocked_no_approver: 'danger',
  approved: 'primary',
  awaiting_fulfilment: 'primary',
  fulfilled: 'active',
  partially_fulfilled: 'warning',
  fulfilment_failed: 'danger',
  rejected: 'inactive',
  cancelled: 'neutral',
  expired: 'warning',
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

export const GRANT_TONE: Record<string, Tone> = {
  scheduled: 'neutral',
  pending: 'primary',
  active: 'active',
  expired: 'inactive',
  lapsed: 'inactive',
  revoked: 'neutral',
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
