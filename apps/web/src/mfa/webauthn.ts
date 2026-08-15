import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from '../session/api.js';
import type { AuthOutcome } from '../session/SessionProvider.js';

/**
 * Enrols a security key or passkey for a user who is already signed in.
 *
 * The options come from the server, go straight to the authenticator, and the
 * response goes straight back. Nothing in between is inspected here — the
 * verification that matters happens server-side, and any check made in the
 * browser is a convenience the caller can skip.
 */
export async function startWebAuthnRegistration(label: string): Promise<void> {
  const optionsJSON = await api<Record<string, unknown>>('/api/auth/mfa/webauthn/begin', {
    method: 'POST',
  });
  const response = await startRegistration({ optionsJSON: optionsJSON as never });
  await api('/api/auth/mfa/webauthn/finish', {
    method: 'POST',
    body: JSON.stringify({ label, response }),
  });
}

/**
 * The same thing during a forced-enrolment challenge, where there is no session
 * and the attempt token is the credential. A separate pair of endpoints, not a
 * flag on the first pair: the two are authenticated differently and mixing them
 * is how one rule gets applied where the other was meant.
 *
 * Returns whatever the server answers, which is a session on success and a
 * further challenge if the policy moved underneath.
 */
export async function enrolWebAuthnForAttempt(
  attemptToken: string,
  label: string,
): Promise<AuthOutcome> {
  const optionsJSON = await api<Record<string, unknown>>(
    '/api/auth/enrol/webauthn/begin',
    { method: 'POST', body: JSON.stringify({ attemptToken }) },
  );
  const response = await startRegistration({ optionsJSON: optionsJSON as never });
  return api<AuthOutcome>('/api/auth/enrol/webauthn/finish', {
    method: 'POST',
    body: JSON.stringify({ attemptToken, label, response }),
  });
}

/** Signs a step-up challenge. The caller holds an attempt token, not a session. */
export async function assertWebAuthn(
  attemptToken: string,
): Promise<Record<string, unknown>> {
  const optionsJSON = await api<Record<string, unknown>>(
    '/api/auth/mfa/webauthn/challenge',
    { method: 'POST', body: JSON.stringify({ attemptToken }) },
  );
  const assertion = await startAuthentication({ optionsJSON: optionsJSON as never });
  return assertion as unknown as Record<string, unknown>;
}
