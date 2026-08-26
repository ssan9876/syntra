import { describe, expect, it } from 'vitest';
import { cookiesAreSecure } from './cookie-security.js';

describe('cookiesAreSecure', () => {
  /**
   * THE ONE THAT MATTERS. A deployment reached over HTTPS marks its cookies
   * Secure, whether or not anybody exported NODE_ENV -- which the lab
   * deployment does not: not in the systemd unit, not in either .env.example.
   */
  it('is true for an https public URL', () => {
    expect(cookiesAreSecure('https://id.acme.example')).toBe(true);
    expect(cookiesAreSecure('https://id.acme.example:8443/')).toBe(true);
  });

  /**
   * And a development server on plain HTTP must NOT mark them Secure: the
   * cookie would never come back, which reads as "sign-in is broken" rather
   * than as a cookie policy.
   */
  it('is false for an http public URL', () => {
    expect(cookiesAreSecure('http://localhost:3000')).toBe(false);
    expect(cookiesAreSecure('http://acme.localhost')).toBe(false);
  });

  /**
   * Unparseable falls to the SAFE side. `loadConfig` validates PUBLIC_URL as a
   * URL before this is ever called, so reaching here means something is very
   * wrong -- and the failure mode of a cookie that does not come back is a
   * broken login, while the failure mode of one sent in the clear is a stolen
   * session.
   */
  it('is true when the URL cannot be read at all', () => {
    expect(cookiesAreSecure('not-a-url')).toBe(true);
    expect(cookiesAreSecure('')).toBe(true);
  });
});
