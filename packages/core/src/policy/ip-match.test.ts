import { describe, expect, it } from 'vitest';
import { evaluateIpRanges, isIpRangeUsable, matchesIpRanges } from './ip-match.js';

describe('matchesIpRanges', () => {
  it('treats an empty range list as unconstrained', () => {
    expect(matchesIpRanges('10.0.0.1', [])).toBe(true);
    expect(matchesIpRanges(null, [])).toBe(true);
  });

  it('refuses to match when the range list is set but the address is unknown', () => {
    expect(matchesIpRanges(null, ['10.0.0.0/8'])).toBe(false);
  });

  it('matches an IPv4 address inside a CIDR', () => {
    expect(matchesIpRanges('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(matchesIpRanges('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('matches a bare address exactly', () => {
    expect(matchesIpRanges('10.1.2.3', ['10.1.2.3'])).toBe(true);
    expect(matchesIpRanges('10.1.2.4', ['10.1.2.3'])).toBe(false);
  });

  it('matches any range in the list', () => {
    expect(matchesIpRanges('192.168.5.5', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true);
  });

  it('matches IPv6 CIDRs', () => {
    expect(matchesIpRanges('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(matchesIpRanges('2001:dba::1', ['2001:db8::/32'])).toBe(false);
  });

  it('normalises an IPv4-mapped IPv6 address to IPv4', () => {
    // Node hands this shape out of a dual-stack socket. Without normalisation
    // an office allowlist written in IPv4 would never match.
    expect(matchesIpRanges('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  it('does not throw when the families differ', () => {
    // ipaddr.js's match() throws across families rather than returning false.
    expect(matchesIpRanges('2001:db8::1', ['10.0.0.0/8'])).toBe(false);
    expect(matchesIpRanges('10.1.2.3', ['2001:db8::/32'])).toBe(false);
  });

  it('ignores a malformed range instead of failing the whole rule', () => {
    expect(matchesIpRanges('10.1.2.3', ['not-an-address', '10.0.0.0/8'])).toBe(true);
    expect(matchesIpRanges('10.1.2.3', ['not-an-address'])).toBe(false);
  });

  it('treats a malformed source address as no match', () => {
    expect(matchesIpRanges('unix:/tmp/sock', ['10.0.0.0/8'])).toBe(false);
  });

  it('matches the private and documentation ranges a real tenant writes', () => {
    // Every one of these was rejected by the first draft's validator, which
    // used a matcher as a syntax check. They are the ranges people actually
    // type into an office allowlist.
    expect(matchesIpRanges('192.168.5.5', ['192.168.0.0/16'])).toBe(true);
    expect(matchesIpRanges('172.16.4.1', ['172.16.0.0/12'])).toBe(true);
    expect(matchesIpRanges('198.51.100.7', ['198.51.100.0/24'])).toBe(true);
    expect(matchesIpRanges('8.8.8.8', ['8.8.8.8'])).toBe(true);
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
