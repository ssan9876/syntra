import { describe, expect, it } from 'vitest';
import { classifyWritebackError } from './writeback.js';

const named = (name: string, message: string) => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe('classifying a write-back failure', () => {
  /**
   * THE ONE THAT MATTERS. DNS and TLS failures matched nothing on the list and
   * fell to the default, which was `policy` -- "the directory refused the new
   * password". So a user iterating on ever-stronger passwords against an
   * outage was told each one was rejected on its merits, and the audit trail
   * recorded `directory_policy` for a directory that was never reached.
   */
  it('reads an unreachable host as transient, not as a policy refusal', () => {
    expect(classifyWritebackError(named('Error', 'getaddrinfo ENOTFOUND dc1.acme.test'))).toBe(
      'transient',
    );
    expect(classifyWritebackError(named('Error', 'getaddrinfo EAI_AGAIN dc1.acme.test'))).toBe(
      'transient',
    );
    expect(classifyWritebackError(named('Error', 'connect EHOSTUNREACH 10.0.0.5:636'))).toBe(
      'transient',
    );
  });

  it('reads a TLS failure as transient too', () => {
    expect(
      classifyWritebackError(named('Error', 'unable to verify the first certificate')),
    ).toBe('transient');
    expect(classifyWritebackError(named('Error', 'socket hang up'))).toBe('transient');
  });

  /**
   * And the fall-through itself. An error nobody has seen before is not
   * evidence that the directory examined a password and rejected it, and
   * `password-change.ts` turns `transient` into "the directory could not be
   * reached" -- which invites a retry, the right advice for an unknown fault.
   */
  it('falls through to transient rather than to policy', () => {
    expect(classifyWritebackError(named('WeirdError', 'something nobody has seen'))).toBe(
      'transient',
    );
  });

  /** Every case that was already right stays right. */
  it('still recognises the ones it always did', () => {
    expect(classifyWritebackError(named('InvalidCredentialsError', ''))).toBe('wrong_password');
    expect(classifyWritebackError(named('ConstraintViolationError', '0000052D'))).toBe('policy');
    expect(classifyWritebackError(named('UnwillingToPerformError', ''))).toBe('policy');
    expect(classifyWritebackError(named('InsufficientAccessError', ''))).toBe('unauthorized');
    expect(classifyWritebackError(named('NoSuchObjectError', ''))).toBe('not_found');
    expect(classifyWritebackError(named('Error', 'ECONNREFUSED'))).toBe('transient');
  });
});
