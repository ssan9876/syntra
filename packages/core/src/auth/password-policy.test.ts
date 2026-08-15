import { describe, expect, it } from 'vitest';
import { validateNewPassword } from './password-policy.js';

const opts = { minLength: 12, login: 'jdoe', email: 'jo.doe@acme.test' };

describe('validateNewPassword', () => {
  it('accepts a long enough password', () => {
    expect(validateNewPassword('correct horse battery staple', opts)).toEqual({ ok: true });
  });

  it('counts characters, not bytes', () => {
    // Twelve characters that are more than twelve bytes must still pass.
    expect(validateNewPassword('naïve-café-🔑x', opts)).toEqual({ ok: true });
  });

  it('rejects one shorter than the tenant minimum', () => {
    expect(validateNewPassword('short', opts)).toEqual({ ok: false, reason: 'too_short' });
    expect(validateNewPassword('elevenchars', opts)).toEqual({ ok: false, reason: 'too_short' });
  });

  it('honours a tenant minimum above the default', () => {
    expect(validateNewPassword('twelvechars!', { ...opts, minLength: 16 })).toEqual({
      ok: false,
      reason: 'too_short',
    });
  });

  it('rejects one long enough to be a denial of service against Argon2', () => {
    expect(validateNewPassword('x'.repeat(1025), opts)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('rejects the login itself, whatever the case', () => {
    expect(validateNewPassword('JDOEjdoejdoe', { ...opts, login: 'jdoejdoejdoe' })).toEqual({
      ok: false,
      reason: 'too_obvious',
    });
  });

  it('rejects the local part of the email address', () => {
    expect(
      validateNewPassword('JO.DOE.jo.doe', { ...opts, email: 'jo.doe.jo.doe@acme.test' }),
    ).toEqual({ ok: false, reason: 'too_obvious' });
  });

  it('rejects a single repeated character', () => {
    expect(validateNewPassword('aaaaaaaaaaaaaaa', opts)).toEqual({
      ok: false,
      reason: 'too_obvious',
    });
  });
});
