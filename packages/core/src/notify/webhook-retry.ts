/**
 * What an attempt's HTTP status means for whether there will be another one.
 *
 * `permanent` is the interesting one. Retrying a 400 or a 404 five times over
 * seven hours does not make the receiver understand the request any better; it
 * just delays the moment an administrator sees the real reason, and leaves a
 * row looking transient when it is not. A receiver that answered at all has
 * told us something, and "no" is an answer.
 */
export type Classification = 'delivered' | 'retry' | 'permanent';

export function classifyStatus(status: number): Classification {
  if (status >= 200 && status < 300) return 'delivered';
  // The real poster never sees one: `guardedFetch` refuses a redirect rather
  // than following it, because following one is exactly how a URL that passed
  // the address check becomes one that did not, and that refusal arrives as a
  // transport error instead. This branch is the policy for anything that does
  // hand a 3xx to the classifier -- retry, because a redirect during a deploy
  // is transient and a receiver that has genuinely moved needs its endpoint
  // reconfigured either way.
  if (status >= 300 && status < 400) return 'retry';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retry';
}

/**
 * The delay before each retry, in order.
 *
 * Deliberately spread over hours rather than minutes. A receiver is usually
 * down for a deployment, a certificate renewal or an outage — none of which
 * are over in ninety seconds — and a schedule that spends every attempt inside
 * ten minutes has given up before anybody has finished reading the alert. The
 * first is short so that a delivery caught by a Syntra restart is retried
 * almost immediately.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  30_000, // 30 seconds
  120_000, // 2 minutes
  600_000, // 10 minutes
  3_600_000, // 1 hour
  21_600_000, // 6 hours
];

/**
 * Attempts before a delivery stops being retried and starts being evidence.
 *
 * One more than the number of delays: the first attempt is not a retry.
 */
export const WEBHOOK_MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * When the next attempt is due, or null when there is not going to be one.
 *
 * `attempts` is the count INCLUDING the one that just failed, which is what
 * the row holds after the sender increments it — so the caller passes the
 * value it is about to write and does not have to reason about an off-by-one
 * at the point where getting it wrong means either a delivery that stops early
 * or one that never stops.
 */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(now.getTime() + delay);
}
