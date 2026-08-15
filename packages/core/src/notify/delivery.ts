import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  sendMessage,
  type OutboundMessage,
  type Transport,
} from './notification-service.js';

/**
 * Everything the failure path needs to say something useful, and nothing the
 * failure path could leak.
 *
 * `purpose` is the template name or an equally coarse label. The rendered body
 * is deliberately not carried here: a password-reset message contains a live
 * credential, and an audit row is the last place it should end up.
 */
export interface DeliveryContext {
  tenantId: string;
  userId: string | null;
  purpose: string;
  /**
   * Where a failure is written. Defaults to `console.error`; `apps/api` hands
   * in the Fastify logger so a dead mail server appears in the same log as
   * everything else.
   */
  log?: ((error: unknown, purpose: string) => void) | undefined;
}

const inFlight = new Set<Promise<void>>();

/**
 * Sends a message and, if that fails, says so — to the log and to the audit
 * trail — instead of throwing.
 *
 * This exists because of one shape that keeps reappearing: an operation
 * commits, and then its notification is awaited on the same path as the
 * response. A mail server that is down then turns a *committed* change into a
 * 500. The user has enrolled a factor, or reset their password, and sees an
 * error page telling them it did not work.
 *
 * Swallowing the failure silently is not the fix either. Mailing the account
 * owner when a second factor appears is one of only two controls that make
 * "a stolen password can enrol a factor" an acceptable trade, and a control
 * nobody can tell has stopped working is not a control. So: caught, logged,
 * and recorded as a failure event against the user it was meant to reach.
 *
 * Never rejects. Returns whether the message actually went out.
 */
export async function deliverMessage(
  transport: Transport,
  message: OutboundMessage,
  context: DeliveryContext,
): Promise<boolean> {
  try {
    await sendMessage(transport, message);
    return true;
  } catch (cause) {
    reportToLog(context, cause);
    await reportToAudit(context, cause);
    return false;
  }
}

/**
 * Hands a message to `deliverMessage` without waiting for it.
 *
 * Used where the caller's own duration must not depend on the mail server:
 * `requestPasswordReset` answers in the same time whether or not it had
 * anything to send, and awaiting an SMTP round trip in one branch and not the
 * other would put that back. `notificationsSettled()` is how a shutdown — or a
 * test — waits for the queue to drain.
 */
export function queueMessage(
  transport: Transport,
  message: OutboundMessage,
  context: DeliveryContext,
): void {
  const promise = deliverMessage(transport, message, context).then(
    () => undefined,
    // deliverMessage does not reject; this is belt and braces so a queued
    // send can never become an unhandled rejection that takes the process out.
    (cause: unknown) => {
      reportToLog(context, cause);
    },
  );
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
}

/** Resolves once every queued message has been delivered or given up on. */
export async function notificationsSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

function reportToLog(context: DeliveryContext, cause: unknown): void {
  if (context.log) {
    context.log(cause, context.purpose);
    return;
  }
  // Not silent, by construction. A notification that vanishes without trace is
  // the failure mode this module exists to prevent.
  console.error(
    `notification "${context.purpose}" could not be delivered`,
    cause,
  );
}

async function reportToAudit(
  context: DeliveryContext,
  cause: unknown,
): Promise<void> {
  try {
    await withTenant(context.tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'notify.delivery_failed',
        targetType: 'User',
        targetId: context.userId,
        outcome: 'failure',
        sourceIp: null,
        payload: {
          purpose: context.purpose,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
  } catch (auditFailure) {
    // The database is unreachable too, most likely. There is nowhere left to
    // record this but the log, and it must still not propagate — the caller's
    // operation has already committed.
    reportToLog(context, auditFailure);
  }
}
