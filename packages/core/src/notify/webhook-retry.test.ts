import { describe, expect, it } from 'vitest';
import {
  RETRY_DELAYS_MS,
  WEBHOOK_MAX_ATTEMPTS,
  classifyStatus,
  nextAttemptAt,
} from './webhook-retry.js';

describe('classifyStatus', () => {
  it('treats any 2xx as delivered', () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classifyStatus(status)).toBe('delivered');
    }
  });

  it('retries a server error', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyStatus(status)).toBe('retry');
    }
  });

  it('retries a rate limit and a request timeout', () => {
    // The only two 4xx that mean "not now" rather than "not ever".
    expect(classifyStatus(429)).toBe('retry');
    expect(classifyStatus(408)).toBe('retry');
  });

  it('gives up on the rest of the 4xx range', () => {
    // A 400, a 401 or a 404 says the receiver understood us and refused.
    // Retrying it five times changes nothing except how long it takes the
    // administrator to see the real reason.
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(classifyStatus(status)).toBe('permanent');
    }
  });

  it('retries a redirect, because deliveries do not follow one', () => {
    // Following redirects is how a checked URL becomes an unchecked one.
    // A receiver that moved should be reconfigured, so this is surfaced
    // rather than obeyed -- but it is transient-shaped, so it is retried.
    expect(classifyStatus(301)).toBe('retry');
    expect(classifyStatus(307)).toBe('retry');
  });
});

describe('nextAttemptAt', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');

  it('spaces the retries further apart each time', () => {
    const gaps = Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) =>
      nextAttemptAt(i + 1, now)!.getTime() - now.getTime(),
    );
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
    }
  });

  it('starts soon enough to ride out a restart', () => {
    expect(nextAttemptAt(1, now)!.getTime() - now.getTime()).toBe(RETRY_DELAYS_MS[0]);
  });

  it('gives up once the attempts are spent', () => {
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, now)).toBeNull();
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS + 1, now)).toBeNull();
  });

  it('spreads the last retry over hours, not minutes', () => {
    // A receiver is usually down for a deploy or an outage, not a blip. A
    // schedule that spends every attempt inside ten minutes has given up
    // before anybody has read the alert.
    const last = nextAttemptAt(WEBHOOK_MAX_ATTEMPTS - 1, now)!;
    expect(last.getTime() - now.getTime()).toBeGreaterThanOrEqual(3_600_000);
  });
});
