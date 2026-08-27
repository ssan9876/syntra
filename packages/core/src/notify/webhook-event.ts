/**
 * The events an endpoint can subscribe to, as a person would name them.
 *
 * There are thirty-odd templates. A settings screen offering all thirty by
 * their internal names, or a text field taking `automate-*`, would be a
 * control that needs a paragraph of explanation next to it — and a control
 * that needs explaining is the wrong control. These six are what somebody
 * integrating a ticketing system actually wants to choose between.
 *
 * A subscription stores the GROUP key, not the templates it currently covers.
 * That is the point: a template added to a group later is one every existing
 * subscriber starts receiving, rather than one nobody hears about until
 * somebody notices and edits thirty endpoints by hand.
 */
export const WEBHOOK_EVENT_GROUPS = {
  'access-requests': {
    label: 'Access requests',
    description: 'Somebody asked for access, or their request was decided.',
    templates: [
      'automate-request-submitted-for-you',
      'automate-approved',
      'automate-rejected',
      'automate-refused',
      'automate-cancelled',
      'automate-request-expired',
    ],
  },
  approvals: {
    label: 'Approvals waiting',
    description: 'A request needs somebody to decide, or has been waiting too long.',
    templates: [
      'automate-stage-opened',
      'automate-reminder',
      'automate-escalated',
      'automate-escalated-past',
      'automate-blocked-no-approver',
      'automate-delegation-started',
      'automate-delegation-ended',
    ],
  },
  fulfilment: {
    label: 'Fulfilment',
    description: 'Approved access being granted in the target system, or failing to be.',
    templates: [
      'automate-fulfilled',
      'automate-partially-fulfilled',
      'automate-fulfilment-failed',
      'automate-awaiting-fulfilment-sla',
    ],
  },
  'grant-lifecycle': {
    label: 'Access ending',
    description: 'Access that is about to expire, has expired, or was swept away.',
    templates: [
      'automate-expiry-warning',
      'automate-expired',
      'automate-lapsed',
      'automate-review-flagged',
      'automate-sweep-confirmation',
    ],
  },
  'access-reviews': {
    label: 'Access reviews',
    description: 'Certification campaigns and the reviewers assigned to them.',
    templates: [
      'govern-review-assigned',
      'govern-review-reminder',
      'govern-review-escalated',
      'govern-review-reassigned',
      'govern-campaign-blocked-item',
    ],
  },
  findings: {
    label: 'Governance findings',
    description: 'Separation-of-duties breaches and expiring exceptions.',
    templates: ['govern-finding-critical', 'govern-exception-expiring'],
  },
} as const;

export type WebhookEventGroup = keyof typeof WEBHOOK_EVENT_GROUPS;

export const WEBHOOK_EVENT_GROUP_KEYS = Object.keys(
  WEBHOOK_EVENT_GROUPS,
) as WebhookEventGroup[];

export function isWebhookEventGroup(value: string): value is WebhookEventGroup {
  return value in WEBHOOK_EVENT_GROUPS;
}

/**
 * Whether an endpoint subscribed to a template.
 *
 * An entry is a GROUP KEY (what the console writes), an exact template name,
 * or a prefix ending in `*` (both of which the API accepts, for an integrator
 * who wants finer control than the six groups offer).
 *
 * An empty list means EVERY event. That has to be the meaning, because
 * "subscribed to nothing yet" and "subscribed to all of them" would otherwise
 * be the same stored value, and a freshly created endpoint would silently
 * deliver nothing while looking configured.
 *
 * A bare `automate` matches nothing: treating a prefix as an implicit wildcard
 * would subscribe an endpoint to every event Automate ever adds, which is not
 * what somebody who typed one template name meant.
 */
export function eventMatches(subscribed: readonly string[], event: string): boolean {
  if (subscribed.length === 0) return true;
  return subscribed.some((pattern) => {
    if (isWebhookEventGroup(pattern)) {
      return (WEBHOOK_EVENT_GROUPS[pattern].templates as readonly string[]).includes(event);
    }
    return pattern.endsWith('*') ? event.startsWith(pattern.slice(0, -1)) : pattern === event;
  });
}

export interface WebhookEvent {
  /** The delivery's own id, so a receiver can discard a duplicate. */
  id: string;
  event: string;
  tenantId: string;
  occurredAt: Date | string;
  requestId: string | null;
  /**
   * Who Syntra notified by mail about the same thing.
   *
   * Present because a receiver routing this into a ticket needs somebody to
   * assign it to, and a delivery that says only "a stage opened" makes that
   * an extra API call the receiver may not be able to make.
   */
  recipients: string[];
  /**
   * The template's own variables: names, dates, links.
   *
   * Never a credential. The only two templates that carry one — `welcome` and
   * `password-reset` — are sent directly by Core and are not enqueueable, so
   * they cannot reach this path at all. That is not a convention: `enqueueOutbox`
   * is typed on `OutboxTemplate`, which is an `Extract` over the `automate-`
   * and `govern-` prefixes, and adding a credential-bearing template to it
   * would have to be done on purpose.
   */
  data: Record<string, unknown>;
}

/**
 * The exact bytes that get signed and sent.
 *
 * Returns a STRING, not an object, and every caller carries the string from
 * here to the socket. The signature covers the serialised body, so anything
 * that re-serialised it in between — a framework helpfully calling
 * `JSON.stringify` on an object again, with its own key order — would produce
 * a body whose signature does not verify, on every delivery, in a way that
 * only the receiver can see.
 *
 * Keys are written in a fixed order for the same reason.
 */
export function webhookBody(event: WebhookEvent): string {
  const occurredAt =
    event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt;
  return JSON.stringify({
    id: event.id,
    event: event.event,
    tenantId: event.tenantId,
    occurredAt,
    requestId: event.requestId,
    recipients: event.recipients,
    data: event.data,
  });
}
