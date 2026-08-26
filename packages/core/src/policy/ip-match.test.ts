import { describe, expect, it } from 'vitest';
import { evaluateIpRanges, isIpRangeUsable } from './ip-match.js';

/**
 * These cases used to go through a boolean `matchesIpRanges` wrapper that
 * collapsed 'unevaluable' into `false` along with a genuine 'no-match'. Moved
 * onto `evaluateIpRanges` directly, most keep the shape they had -- `true`
 * becomes 'match', an ordinary miss becomes 'no-match' -- except the two
 * marked below, where the old `false` was standing in for "this could not be
 * decided" rather than "this was checked and missed".
 */
describe('evaluateIpRanges — address and range matching', () => {
  it('treats an empty range list as unconstrained', () => {
    expect(evaluateIpRanges('10.0.0.1', [])).toBe('match');
    expect(evaluateIpRanges(null, [])).toBe('match');
  });

  /** No address to test: not a miss, an unanswerable question. */
  it('is unevaluable when the range list is set but the address is unknown', () => {
    expect(evaluateIpRanges(null, ['10.0.0.0/8'])).toBe('unevaluable');
  });

  it('matches an IPv4 address inside a CIDR', () => {
    expect(evaluateIpRanges('10.1.2.3', ['10.0.0.0/8'])).toBe('match');
    expect(evaluateIpRanges('11.1.2.3', ['10.0.0.0/8'])).toBe('no-match');
  });

  it('matches a bare address exactly', () => {
    expect(evaluateIpRanges('10.1.2.3', ['10.1.2.3'])).toBe('match');
    expect(evaluateIpRanges('10.1.2.4', ['10.1.2.3'])).toBe('no-match');
  });

  it('matches any range in the list', () => {
    expect(evaluateIpRanges('192.168.5.5', ['10.0.0.0/8', '192.168.0.0/16'])).toBe('match');
  });

  it('matches IPv6 CIDRs', () => {
    expect(evaluateIpRanges('2001:db8::1', ['2001:db8::/32'])).toBe('match');
    expect(evaluateIpRanges('2001:dba::1', ['2001:db8::/32'])).toBe('no-match');
  });

  it('normalises an IPv4-mapped IPv6 address to IPv4', () => {
    // Node hands this shape out of a dual-stack socket. Without normalisation
    // an office allowlist written in IPv4 would never match.
    expect(evaluateIpRanges('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe('match');
  });

  it('does not throw when the families differ', () => {
    // ipaddr.js's match() throws across families rather than returning false.
    // Both ranges here are usable, so a family mismatch is a genuine no-match,
    // not an unevaluable one.
    expect(evaluateIpRanges('2001:db8::1', ['10.0.0.0/8'])).toBe('no-match');
    expect(evaluateIpRanges('10.1.2.3', ['2001:db8::/32'])).toBe('no-match');
  });

  it('ignores a malformed range instead of failing the whole rule', () => {
    expect(evaluateIpRanges('10.1.2.3', ['not-an-address', '10.0.0.0/8'])).toBe('match');
  });

  /** Every range in the list is unusable, so there is nothing left to decide. */
  it('is unevaluable when no range in the list can be read', () => {
    expect(evaluateIpRanges('10.1.2.3', ['not-an-address'])).toBe('unevaluable');
  });

  /** A malformed source address is the same kind of gap as no address at all. */
  it('is unevaluable for a malformed source address', () => {
    expect(evaluateIpRanges('unix:/tmp/sock', ['10.0.0.0/8'])).toBe('unevaluable');
  });

  it('matches the private and documentation ranges a real tenant writes', () => {
    // Every one of these was rejected by the first draft's validator, which
    // used a matcher as a syntax check. They are the ranges people actually
    // type into an office allowlist.
    expect(evaluateIpRanges('192.168.5.5', ['192.168.0.0/16'])).toBe('match');
    expect(evaluateIpRanges('172.16.4.1', ['172.16.0.0/12'])).toBe('match');
    expect(evaluateIpRanges('198.51.100.7', ['198.51.100.0/24'])).toBe('match');
    expect(evaluateIpRanges('8.8.8.8', ['8.8.8.8'])).toBe('match');
  });
});

describe('isIpRangeUsable', () => {
  it('accepts every well-formed range and address', () => {
    for (const range of [
      '10.0.0.0/8',
      '192.168.0.0/16',
      '172.16.0.0/12',
      '198.51.100.0/24',
      '0.0.0.0/0',
      '8.8.8.8',
      '2001:db8::/32',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isIpRangeUsable(range)).toBe(true);
    }
  });

  it('rejects a prefix length that is not a prefix length', () => {
    expect(isIpRangeUsable('10.0.0.0/33')).toBe(false);
    expect(isIpRangeUsable('10.0.0.0/-1')).toBe(false);
  });

  it('rejects an address that is not an address', () => {
    expect(isIpRangeUsable('999.1.1.1/8')).toBe(false);
    expect(isIpRangeUsable('10.0.0.256')).toBe(false);
    expect(isIpRangeUsable('the office')).toBe(false);
    expect(isIpRangeUsable('')).toBe(false);
  });
});

describe('evaluateIpRanges', () => {
  it('is unconstrained when no ranges are named', () => {
    expect(evaluateIpRanges('10.0.0.1', [])).toBe('match');
    expect(evaluateIpRanges(null, [])).toBe('match');
  });

  it('separates "did not match" from "could not be decided"', () => {
    expect(evaluateIpRanges('11.0.0.1', ['10.0.0.0/8'])).toBe('no-match');
    // No address to test: not a miss, an unanswerable question.
    expect(evaluateIpRanges(null, ['10.0.0.0/8'])).toBe('unevaluable');
    expect(evaluateIpRanges('unix:/tmp/sock', ['10.0.0.0/8'])).toBe('unevaluable');
    expect(evaluateIpRanges('10.0.0.1', ['nonsense'])).toBe('unevaluable');
  });

  it('reports unevaluable when a usable range misses and an unusable one remains', () => {
    // The rule meant to cover both. One of them cannot be read, so "no" is not
    // an honest answer.
    expect(evaluateIpRanges('11.0.0.1', ['10.0.0.0/8', 'nonsense'])).toBe('unevaluable');
    // …but a hit on the readable half settles it.
    expect(evaluateIpRanges('10.0.0.1', ['10.0.0.0/8', 'nonsense'])).toBe('match');
  });
});
