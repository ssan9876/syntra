import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhook,
  verifyWebhook,
} from './webhook-signature.js';

const SECRET = 'whsec_a-long-enough-shared-secret';
const BODY = '{"event":"automate-stage-opened"}';
const AT = new Date('2026-08-26T12:00:00.000Z');

describe('signWebhook', () => {
  it('produces a header naming the scheme, the time and the digest', () => {
    expect(signWebhook(SECRET, BODY, AT)).toBe(
      `t=1787745600,v1=${createHmac('sha256', SECRET)
        .update(`1787745600.${BODY}`)
        .digest('hex')}`,
    );
  });

  it('covers the timestamp, not just the body', () => {
    // Otherwise the header is a replay token: an attacker who captured one
    // delivery could resend it for ever with a fresh `t` the receiver trusts.
    const early = signWebhook(SECRET, BODY, AT);
    const late = signWebhook(SECRET, BODY, new Date(AT.getTime() + 1000));
    expect(early.split('v1=')[1]).not.toBe(late.split('v1=')[1]);
  });
});

describe('verifyWebhook', () => {
  it('accepts what signWebhook produced', () => {
    expect(verifyWebhook(SECRET, BODY, signWebhook(SECRET, BODY, AT), AT)).toBe(true);
  });

  it('refuses a body that was edited in flight', () => {
    const header = signWebhook(SECRET, BODY, AT);
    expect(verifyWebhook(SECRET, `${BODY} `, header, AT)).toBe(false);
  });

  it('refuses a digest made with another secret', () => {
    const header = signWebhook('whsec_someone-elses-secret', BODY, AT);
    expect(verifyWebhook(SECRET, BODY, header, AT)).toBe(false);
  });

  it('refuses a delivery older than the tolerance', () => {
    const header = signWebhook(SECRET, BODY, AT);
    const late = new Date(AT.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);
    expect(verifyWebhook(SECRET, BODY, header, late)).toBe(false);
  });

  it('refuses a delivery timestamped in the future by more than the tolerance', () => {
    // A receiver whose clock is behind must not accept an unbounded future
    // timestamp: that is the replay window reopened from the other side.
    const header = signWebhook(SECRET, BODY, AT);
    const early = new Date(AT.getTime() - (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);
    expect(verifyWebhook(SECRET, BODY, header, early)).toBe(false);
  });

  it('refuses a header it cannot parse', () => {
    for (const header of ['', 'nonsense', 't=1787745600', 'v1=abcd', 't=abc,v1=abcd']) {
      expect(verifyWebhook(SECRET, BODY, header, AT)).toBe(false);
    }
  });

  it('refuses a digest of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and a receiver that throws
    // on a malformed signature is a receiver an attacker can crash.
    expect(verifyWebhook(SECRET, BODY, 't=1787745600,v1=ff', AT)).toBe(false);
  });
});
