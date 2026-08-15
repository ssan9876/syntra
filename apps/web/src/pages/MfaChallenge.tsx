import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { takeChallenge, storeChallenge, type PendingChallenge } from '../mfa/challenge-store.js';
import { assertWebAuthn } from '../mfa/webauthn.js';
import { ApiError, api } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';

type Mode = 'totp' | 'webauthn' | 'recovery_code';

export function MfaChallenge() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = takeChallenge();
    setChallenge(pending);
    if (pending) {
      // Put it back: the token is spent on a successful verify, not on
      // rendering the screen, and a wrong code must not cost the user the flow.
      storeChallenge(pending);
      // First offered, not "totp unless webauthn". A user whose only remaining
      // factor is a printed recovery code would otherwise land on a screen
      // that opens a WebAuthn prompt for a key they do not have.
      const first = pending.factors[0];
      if (first === 'totp' || first === 'webauthn' || first === 'recovery_code') {
        setMode(first);
      }
    }
    setReady(true);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);

    try {
      const body =
        mode === 'webauthn'
          ? {
              type: 'webauthn',
              attemptToken: challenge.attemptToken,
              assertion: await assertWebAuthn(challenge.attemptToken),
            }
          : { type: mode, attemptToken: challenge.attemptToken, code };

      await api('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      takeChallenge();
      await refresh();
      navigate(challenge.returnTo.startsWith('/') ? challenge.returnTo : '/', {
        replace: true,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'code-already-used-for-setup') {
        // The one refusal a user is guaranteed to meet while looking at a
        // correct code. Enrol a factor, get challenged twenty seconds later,
        // and the replay watermark refuses the code that completed setup —
        // which is the point, but only if it is explained. Unexplained it is a
        // support ticket; explained it is a sentence.
        setError(
          cause.problem.detail ??
            'That code completed your setup. Wait for your app to show the next one.',
        );
      } else if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (cause instanceof DOMException) {
        setError('Your security key was not used. Try again, or use a code.');
      } else {
        // The server does not distinguish a wrong code from an expired attempt,
        // and neither does this.
        setError('That did not match. Try again, or use a recovery code.');
      }
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

  const offers = (factor: Mode) =>
    challenge.factors.includes(factor) && mode !== factor;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">One more step</h1>
          <p className="mt-1 text-muted">
            Your organization requires a second factor for this sign-in.
          </p>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            {mode === 'totp' && (
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
            )}
            {mode === 'recovery_code' && (
              <Field
                label="Recovery code"
                value={code}
                onChange={setCode}
                autoComplete="off"
                autoFocus
                required
                hint="One of the codes you saved when you set up your second factor."
                invalid={Boolean(error)}
              />
            )}
            {mode === 'webauthn' && (
              <p className="text-muted">
                Use your security key or passkey when the browser asks.
              </p>
            )}

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Verify
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap gap-3">
            {offers('webauthn') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('webauthn')}>
                Use a security key
              </Button>
            )}
            {offers('totp') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('totp')}>
                Use a code from your app
              </Button>
            )}
            {mode !== 'recovery_code' && (
              <Button size="sm" variant="ghost" onClick={() => setMode('recovery_code')}>
                Use a recovery code
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
