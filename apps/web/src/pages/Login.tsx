import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  isServerPath,
  routeFor,
  safeReturnTo,
  storeChallenge,
} from '../mfa/challenge-store.js';
import { leaveTo } from '../mfa/leave.js';
import { LanguagePicker, useT } from '../i18n/LocaleProvider.js';

export function Login() {
  const t = useT();
  const { login } = useSession();
  const navigate = useNavigate();

  /**
   * Where to go once this succeeds.
   *
   * `/login?next=/saml/continue?handle=...` is how every protocol route sends
   * an unauthenticated browser here, and until now nothing read it: the user
   * signed in, landed on the portal, and the service provider's sign-in was
   * abandoned with nothing on screen to say so. Run through `safeReturnTo`,
   * because this value came off a URL somebody else may have composed.
   */
  const returnTo = safeReturnTo(
    new URLSearchParams(window.location.search).get('next'),
  );

  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const outcome = await login(loginName, password);
      if (outcome.status === 'authenticated') {
        if (isServerPath(returnTo)) {
          leaveTo(returnTo);
          return;
        }
        navigate(returnTo, { replace: true });
        return;
      }

      const kind =
        outcome.status === 'enrol'
          ? 'enrol'
          : outcome.status === 'renew'
            ? 'renew'
            : 'verify';
      storeChallenge({
        kind,
        attemptToken: outcome.attemptToken,
        expiresAt: outcome.expiresAt,
        // A renewal offers no choice of factor, so it carries none.
        factors:
          outcome.status === 'enrol'
            ? outcome.enrollableFactors
            : outcome.status === 'renew'
              ? []
              : outcome.acceptableFactors,
        // Where the sign-in was headed. A SAML service provider or an OIDC
        // relying party sends an unauthenticated browser to `/login?next=...`
        // and expects it back; without carrying that through the step-up, a
        // user asked for a second factor lands on the portal and the
        // application that sent them there never hears anything more.
        returnTo,
      });
      navigate(routeFor(kind), { replace: true });
    } catch (cause) {
      // The API answers a wrong password, an unknown login and a disabled
      // account identically. Inventing a distinction here would undo that.
      if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else {
        setError('That login or password is incorrect.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />

        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">{t('login.title')}</h1>
          <p className="mt-1 text-muted">{t('login.lead')}</p>

          <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
            <Field
              label={t('login.login')}
              value={loginName}
              onChange={setLoginName}
              autoComplete="username"
              autoFocus
              required
              invalid={Boolean(error)}
            />
            <Field
              label={t('login.password')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
              invalid={Boolean(error)}
            />

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              className="w-full"
            >
              {t('login.submit')}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/forgot-password" className="link">
            {t('login.forgot')}
          </Link>
        </p>

        <p className="mt-2 text-center text-sm text-muted">{t('login.help')}</p>

        <p className="mt-4 text-center">
          <LanguagePicker />
        </p>
      </div>
    </main>
  );
}
