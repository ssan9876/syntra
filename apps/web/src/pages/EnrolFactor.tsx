import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import {
  storeChallenge,
  takeChallenge,
  type PendingChallenge,
} from '../mfa/challenge-store.js';
import { enrolWebAuthnForAttempt } from '../mfa/webauthn.js';
import { ApiError, api } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';

interface Enrolment {
  secret: string;
  uri: string;
  qr: string;
}

export function EnrolFactor() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'totp' | 'webauthn'>('totp');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Security key');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = takeChallenge();
    if (pending && pending.kind === 'enrol') {
      // Put it back: the attempt is spent when enrolment succeeds, not when
      // this screen renders, and a mistyped code must not cost the user the
      // whole sign-in.
      storeChallenge(pending);
      setChallenge(pending);
      setMode(pending.factors.includes('totp') ? 'totp' : 'webauthn');
    }
    setReady(true);
  }, []);

  async function beginTotp() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      setEnrolment(
        await api<Enrolment>('/api/auth/enrol/totp/begin', {
          method: 'POST',
          body: JSON.stringify({ attemptToken: challenge.attemptToken }),
        }),
      );
    } catch {
      setError('That did not work. Sign in again to start over.');
    } finally {
      setBusy(false);
    }
  }

  function done() {
    takeChallenge();
    void refresh().then(() =>
      navigate(challenge!.returnTo.startsWith('/') ? challenge!.returnTo : '/', {
        replace: true,
      }),
    );
  }

  async function confirmTotp(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/enrol/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ attemptToken: challenge.attemptToken, code }),
      });
      done();
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (cause instanceof ApiError && cause.problem.status === 401) {
        setError('This step expired. Sign in again to start over.');
      } else {
        setError('That code did not match. Check your app and try the next one.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function addKey() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await enrolWebAuthnForAttempt(challenge.attemptToken, label.trim() || 'Security key');
      done();
    } catch (cause) {
      // A tenant with no primary domain set cannot register a security key at
      // all, and the server says so with a message naming the fix. Showing it
      // is better than a generic failure the user cannot act on.
      setError(
        cause instanceof ApiError && cause.kind === 'webauthn-unavailable'
          ? (cause.problem.detail ?? 'Security keys are not available here.')
          : cause instanceof DOMException
            ? 'That security key was not registered. Try again.'
            : 'That security key was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;

  if (!challenge) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm text-center">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="This step expired">
            Sign in again to continue.
          </Alert>
          <Button className="mt-4 w-full" variant="primary" onClick={() => navigate('/login')}>
            Back to sign in
          </Button>
        </div>
      </main>
    );
  }

  const offersBoth = challenge.factors.length > 1;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">Set up a second factor</h1>
          <p className="mt-1 text-muted">
            Your organization now requires one. It takes a minute, and you will
            be signed in straight afterwards.
          </p>

          {mode === 'totp' && (
            <div className="mt-6 space-y-4">
              {!enrolment && (
                <>
                  <p className="text-muted">
                    Use an authenticator app — the one your organization
                    recommends, or any that shows six-digit codes.
                  </p>
                  <Button variant="primary" loading={busy} className="w-full" onClick={beginTotp}>
                    Start
                  </Button>
                </>
              )}

              {enrolment && (
                <form onSubmit={confirmTotp} noValidate className="space-y-4">
                  <p className="text-muted">
                    Scan this with your app, then type the code it shows.
                  </p>
                  <img
                    src={enrolment.qr}
                    alt="QR code for your authenticator app"
                    className="size-48 rounded-control border border-border-subtle"
                  />
                  <p className="text-sm text-muted">
                    Cannot scan? Enter this key instead:{' '}
                    <code className="font-mono text-ink">{enrolment.secret}</code>
                  </p>
                  <Field
                    label="Six-digit code"
                    value={code}
                    onChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    invalid={Boolean(error)}
                  />
                  <Button type="submit" variant="primary" loading={busy} className="w-full">
                    Confirm
                  </Button>
                </form>
              )}
            </div>
          )}

          {mode === 'webauthn' && (
            <div className="mt-6 space-y-4">
              <p className="text-muted">
                Use a security key, or the fingerprint or face unlock built into
                this device.
              </p>
              <Field label="Name this key" value={label} onChange={setLabel} />
              <Button variant="primary" loading={busy} className="w-full" onClick={addKey}>
                Continue
              </Button>
            </div>
          )}

          {error && (
            <Alert tone="danger">
              <span>{error}</span>
            </Alert>
          )}

          {offersBoth && (
            <div className="mt-4">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setEnrolment(null);
                  setMode(mode === 'totp' ? 'webauthn' : 'totp');
                }}
              >
                {mode === 'totp' ? 'Use a security key instead' : 'Use an app instead'}
              </Button>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          Recovery codes are not offered here. Generate a set from the Security
          page once you are signed in.
        </p>
      </div>
    </main>
  );
}
