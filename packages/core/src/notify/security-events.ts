import { WEBHOOK_EVENT_GROUPS } from './webhook-event.js';

/**
 * The groups whose entries are audit actions rather than templates.
 *
 * Named once. The allowlist below is DERIVED from them rather than restated
 * beside them, because two lists would disagree the first time somebody added
 * an action to a group and forgot the other — and the symptom would be a
 * subscription that matches an event nothing ever fans out, which is
 * indistinguishable from a broken receiver.
 */
const SECURITY_GROUPS = ['sign-in-security', 'credentials', 'configuration'] as const;

const SECURITY_ACTIONS: ReadonlySet<string> = new Set(
  SECURITY_GROUPS.flatMap((key) => [...WEBHOOK_EVENT_GROUPS[key].templates]),
);

/**
 * Whether an audited action is one an endpoint can subscribe to.
 *
 * Checked on every `recordEvent`, so it is a set membership test and nothing
 * else. An ordinary `application.launch` pays exactly this and goes no further.
 */
export function isSecurityEvent(action: string): boolean {
  return SECURITY_ACTIONS.has(action);
}

/** Every security action, for tests and for the documentation to check itself. */
export function securityEventActions(): string[] {
  return [...SECURITY_ACTIONS].sort();
}

/**
 * What a security event looks like once it has left the building.
 *
 * A CLOSED SET, and that is the security property of this feature.
 *
 * `AuditEvent.payload` is written for an authenticated reader inside the
 * console. It carries before-and-after values, org unit ids, statuses, reasons
 * — whatever the person writing the audit call thought an investigator would
 * want. A webhook body goes to a URL an administrator typed, over the
 * internet, to a receiver Syntra cannot vouch for.
 *
 * Forwarding the payload would turn every future `recordEvent` call into a
 * disclosure decision, made months earlier by somebody with no idea their
 * field would leave the building. So it is not forwarded, and neither is
 * `sourceIp`: an address is personal data and the receiver did not ask for it.
 *
 * A receiver that needs the detail has `sequence` and can read the audit log
 * through the API, authenticated — which is where that decision belongs.
 * Adding a field here is a deliberate act against this list.
 */
export interface SecurityEventProjection {
  action: string;
  outcome: 'success' | 'failure';
  /** ISO 8601. */
  occurredAt: string;
  /** Its place in the tamper-evident chain, so a receiver can go and read it. */
  sequence: number;
  actorUserId: string | null;
  targetType: string;
  targetId: string | null;
}

export function securityProjection(input: {
  action: string;
  outcome: 'success' | 'failure';
  occurredAt: Date;
  sequence: number;
  actorUserId: string | null;
  targetType: string;
  targetId: string | null;
}): SecurityEventProjection {
  // Field by field rather than a spread. A spread would carry whatever the
  // caller happened to hold, which is the whole thing this function exists to
  // prevent — and it would do it silently the day somebody widened the
  // parameter.
  return {
    action: input.action,
    outcome: input.outcome,
    occurredAt: input.occurredAt.toISOString(),
    sequence: input.sequence,
    actorUserId: input.actorUserId,
    targetType: input.targetType,
    targetId: input.targetId,
  };
}
