import { describe, expect, it } from 'vitest';
import { challengeFromQuery, isServerPath, safeReturnTo } from './challenge-store.js';

describe('safeReturnTo', () => {
  it('keeps a path on this origin', () => {
    expect(safeReturnTo('/saml/continue?handle=abc')).toBe('/saml/continue?handle=abc');
    expect(safeReturnTo('/?launch=1')).toBe('/?launch=1');
  });

  it('refuses anything that leaves this origin', () => {
    // `//evil.test` is protocol-relative and absolute in a browser: "starts
    // with a slash" is not the check, "starts with exactly one" is.
    for (const hostile of [
      '//evil.test',
      '///evil.test',
      String.raw`/\evil.test`,
      'https://evil.test',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnTo(hostile)).toBe('/');
    }
  });
});

describe('isServerPath', () => {
  it('names the prefixes this router does not own', () => {
    expect(isServerPath('/saml/continue?handle=a')).toBe(true);
    expect(isServerPath('/oidc/interaction/abc')).toBe(true);
    expect(isServerPath('/federation/callback')).toBe(true);
  });

  it('leaves this application\'s own routes to the router', () => {
    expect(isServerPath('/')).toBe(false);
    expect(isServerPath('/?launch=abc')).toBe(false);
    expect(isServerPath('/admin/audit')).toBe(false);
    // Not a prefix match on a bare word: `/samlish` is not a protocol path.
    expect(isServerPath('/samlish')).toBe(false);
  });
});

describe('challengeFromQuery', () => {
  const future = new Date(Date.now() + 300_000).toISOString();

  it('reads what a protocol route redirected here with', () => {
    const query = `?attempt=tok&factors=totp,recovery_code&expires=${encodeURIComponent(
      future,
    )}&next=${encodeURIComponent('/saml/continue?handle=abc')}`;
    expect(challengeFromQuery(query, 'verify')).toEqual({
      kind: 'verify',
      attemptToken: 'tok',
      expiresAt: future,
      factors: ['totp', 'recovery_code'],
      returnTo: '/saml/continue?handle=abc',
    });
  });

  it('answers nothing when there is nothing to answer', () => {
    expect(challengeFromQuery('', 'verify')).toBeNull();
    expect(challengeFromQuery('?next=/', 'verify')).toBeNull();
  });

  it('refuses an attempt that has already expired', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(
      challengeFromQuery(`?attempt=t&factors=totp&expires=${encodeURIComponent(past)}`, 'verify'),
    ).toBeNull();
  });

  it('refuses one that names no factor', () => {
    // The screen decides what to offer from this list. Empty would mean
    // offering everything, including a recovery code the server would refuse.
    expect(
      challengeFromQuery(`?attempt=t&factors=&expires=${encodeURIComponent(future)}`, 'verify'),
    ).toBeNull();
  });

  it('will not let a redirect target somebody else composed leave the origin', () => {
    const query = `?attempt=t&factors=totp&expires=${encodeURIComponent(
      future,
    )}&next=${encodeURIComponent('https://evil.test/steal')}`;
    expect(challengeFromQuery(query, 'verify')?.returnTo).toBe('/');
  });
});
