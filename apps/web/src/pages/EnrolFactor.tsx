import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { useT } from '../i18n/LocaleProvider.js';
import {
  challengeFromQuery,
  isServerPath,
  routeFor,
  storeChallenge,
  takeChallenge,
  type PendingChallenge,
} from '../mfa/challenge-store.js';
import { leaveTo } from '../mfa/leave.js';
import { enrolWebAuthnForAttempt } from '../mfa/webauthn.js';
import { ApiError, api, isRateLimited } from '../session/api.js';
import { useSession, type AuthOutcome } from '../session/SessionProvider.js';

interface Enrolment {
  secret: string;
  uri: string;
  qr: string;
}

export function EnrolFactor() {
  const t = useT();
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
    // As on the verify screen: a protocol route redirects a browser here and
    // carries the attempt in the query string, because there is no response
    // body it could have stored anything from.
    const pending =
      takeChallenge() ?? challengeFromQuery(window.location.search, 'enrol');
    if (pending && pending.kind === 'enrol') {
      // Put it back: the attempt is spent when enrolment succeeds, not when
      // this screen renders, and a mistyped code must not cost the user the
      // whole sign-in.
      storeChallenge(pending);
      setChallenge(pending);
      setMode(pending.factors.includes('totp') ? 'totp' : 'webauthn');
      // The attempt token does not stay in the address bar.
      if (window.location.search !== '') {
        window.history.replaceState({}, '', window.location.pathname);
      }
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
    const returnTo = challenge!.returnTo.startsWith('/') ? challenge!.returnTo : '/';
    void refresh().then(() => {
      // A server path — a SAML or OIDC flow resuming — needs a real
      // navigation; this router owns none of those and would land the user on
      // the portal with the sign-in silently unfinished.
      if (isServerPath(returnTo)) {
        leaveTo(returnTo);
        return;
      }
      navigate(returnTo, { replace: true });
    });
  }

  /**
   * What the enrolment endpoints answer when the policy moved underneath.
   *
   * Both routes hand back the chokepoint's own `challenge` and `enrol` arms —
   * a rule tightened between the sign-in and the enrolment finishing, and no
   * session was issued. Walking on as though one had takes the user to a page
   * with no cookie, which bounces them straight to /login with nothing said.
   * Returns true when the outcome was handled and the caller should stop.
   */
  function handedBack(outcome: AuthOutcome): boolean {
    if (outcome.status === 'authenticated') return false;
    const kind =
      outcome.status === 'enrol'
        ? 'enrol'
        : outcome.status === 'renew'
          ? 'renew'
          : 'verify';
    const next: PendingChallenge = {
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
      returnTo: challenge!.returnTo,
    };
    storeChallenge(next);
    if (kind === 'enrol') {
      // Still enrolment, but a different kind is wanted now. Reset this screen
      // onto it rather than navigating to the route it is already on.
      setChallenge(next);
      setEnrolment(null);
      setCode('');
      setMode(next.factors.includes('totp') ? 'totp' : 'webauthn');
      setError('Your organization now asks for a different kind of factor.');
      return true;
    }
    navigate(routeFor(kind), { replace: true });
    return true;
  }

  async function confirmTotp(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api<AuthOutcome>('/api/auth/enrol/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ attemptToken: challenge.attemptToken, code }),
      });
      if (handedBack(outcome)) return;
      done();
    } catch (cause) {
      if (isRateLimited(cause)) {
        setError(t('common.rate_limited'));
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
      const outcome = await enrolWebAuthnForAttempt(
        challenge.attemptToken,
        label.trim() || 'Security key',
      );
      if (handedBack(outcome)) return;
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
          <h1 className="text-lg font-semibold text-ink">{t('enrol.title')}</h1>
          <p className="mt-1 text-muted">{t('enrol.lead')}</p>

          {mode === 'totp' && (
            <div className="mt-6 space-y-4">
              {!enrolment && (
                <>
                  <p className="text-muted">{t('enrol.totp_lead')}</p>
                  <Button variant="primary" loading={busy} className="w-full" onClick={beginTotp}>
                    {t('enrol.start')}
                  </Button>
                </>
              )}

              {enrolment && (
                <form onSubmit={confirmTotp} noValidate className="space-y-4">
                  <p className="text-muted">{t('enrol.scan')}</p>
                  <img
                    src={enrolment.qr}
                    alt={t('enrol.qr_alt')}
                    className="size-48 rounded-control border border-border-subtle"
                  />
                  <p className="text-sm text-muted">
                    {t('enrol.cannot_scan')}{' '}
                    <code className="font-mono text-ink">{enrolment.secret}</code>
                  </p>
                  <Field
                    label={t('mfa.totp_code')}
                    value={code}
                    onChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    invalid={Boolean(error)}
                  />
                  <Button type="submit" variant="primary" loading={busy} className="w-full">
                    {t('enrol.confirm')}
                  </Button>
                </form>
              )}
            </div>
          )}

          {mode === 'webauthn' && (
            <div className="mt-6 space-y-4">
              <p className="text-muted">{t('enrol.webauthn_lead')}</p>
              <Field label={t('enrol.name_key')} value={label} onChange={setLabel} />
              <Button variant="primary" loading={busy} className="w-full" onClick={addKey}>
                {t('common.continue')}
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
                {mode === 'totp' ? t('enrol.switch_to_key') : t('enrol.switch_to_app')}
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
