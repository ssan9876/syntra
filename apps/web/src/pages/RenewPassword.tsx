import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { useT } from '../i18n/LocaleProvider.js';
import { ApiError, api } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';
import { isServerPath, takeChallenge, type PendingChallenge } from '../mfa/challenge-store.js';
import { leaveTo } from '../mfa/leave.js';

/**
 * The screen a sign-in lands on when the password was right and has aged past
 * the tenant's limit.
 *
 * A sibling of `/mfa` and `/enrol` rather than of `/reset-password`: the user
 * is mid-sign-in holding an attempt token, not following a mailed link. The
 * old password is not asked for again — it was accepted a moment ago, and the
 * attempt is the proof.
 */
export function RenewPassword() {
  const t = useT();
  const navigate = useNavigate();
  const { refresh } = useSession();

  /**
   * Read once, on mount. `takeChallenge` clears as it reads, so holding it in
   * state is what lets a refused attempt be retried without the token
   * vanishing out from under the second try.
   */
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = takeChallenge();
    setChallenge(pending && pending.kind === 'renew' ? pending : null);
    setLoaded(true);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;

    // Checked here rather than at the server: the server sees one password and
    // cannot know the two boxes disagreed, and a mistyped confirmation should
    // not spend the attempt.
    if (password !== confirm) {
      setError('Those two do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/renew-password', {
        method: 'POST',
        body: JSON.stringify({
          attemptToken: challenge.attemptToken,
          newPassword: password,
        }),
      });
      // The session cookie is set by that call. `refresh` is what tells the
      // rest of the app who is signed in.
      await refresh();
      if (isServerPath(challenge.returnTo)) {
        leaveTo(challenge.returnTo);
        return;
      }
      navigate(challenge.returnTo, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        // The server's own words. It says which of "too short", "one of your
        // last five" and "that is the one that expired" applied, and each of
        // those is a different thing for the user to do next.
        setError(cause.problem.detail ?? cause.problem.title);
        // An expired or spent attempt cannot be retried from this screen.
        if (cause.problem.status === 401) setChallenge(null);
      } else {
        setError('That could not be saved. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (loaded && !challenge) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="That sign-in has expired">
            Password renewals have to be finished within a few minutes of
            signing in.
          </Alert>
          <div className="mt-4 text-center">
            <Button variant="secondary" onClick={() => navigate('/login', { replace: true })}>
              Start again
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">{t('renew.title')}</h1>
          <p className="mt-2 text-sm text-muted">{t('renew.lead_full')}</p>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <Field
              label={t('reset.password')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              autoFocus
              required
              hint={t('renew.hint')}
            />
            <Field
              label={t('reset.confirm')}
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              required
            />

            {error && <Alert tone="danger">{error}</Alert>}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              {t('renew.submit')}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
