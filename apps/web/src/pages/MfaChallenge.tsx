import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { useT } from '../i18n/LocaleProvider.js';
import {
  challengeFromQuery,
  isServerPath,
  routeFor,
  takeChallenge,
  storeChallenge,
  type PendingChallenge,
} from '../mfa/challenge-store.js';
import { leaveTo } from '../mfa/leave.js';
import { assertWebAuthn } from '../mfa/webauthn.js';
import { ApiError, api } from '../session/api.js';
import { useSession, type AuthOutcome } from '../session/SessionProvider.js';

type Mode = 'totp' | 'webauthn' | 'email_otp' | 'recovery_code';

const isMode = (value: string | undefined): value is Mode =>
  value === 'totp' ||
  value === 'webauthn' ||
  value === 'email_otp' ||
  value === 'recovery_code';

/**
 * Which factor to open on. The first the server named, not "totp unless
 * webauthn": a user whose only remaining factor is a printed recovery code
 * would otherwise land on a screen that opens a WebAuthn prompt for a key they
 * do not have.
 */
const firstMode = (factors: string[]): Mode =>
  isMode(factors[0]) ? factors[0] : 'totp';

export function MfaChallenge() {
  const t = useT();
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('totp');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Either this application stored one on its way here, or a protocol route
    // redirected the browser here and put it in the query string — a SAML
    // service provider's sign-in, an OIDC authorization request, or a login
    // coming back from an upstream provider. The second case has no
    // sessionStorage behind it, and without reading the query every one of
    // those step-ups landed on "This step expired" one hop after Syntra itself
    // issued the redirect.
    const pending =
      takeChallenge() ?? challengeFromQuery(window.location.search, 'verify');
    setChallenge(pending);
    if (pending) {
      // Put it back: the token is spent on a successful verify, not on
      // rendering the screen, and a wrong code must not cost the user the flow.
      storeChallenge(pending);
      setMode(firstMode(pending.factors));
      // And take it out of the address bar. It is a bearer credential, and the
      // history entry, the Referer header and every proxy log downstream are
      // not places to leave one lying.
      if (window.location.search !== '') {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    setReady(true);
  }, []);

  /**
   * Asks the server to mail a code.
   *
   * The answer is 202 whatever happened, so this reports only that it asked.
   * The endpoint deliberately does not say whether a code went out — each of
   * the reasons it might not is a fact about somebody else's account.
   */
  async function sendCode() {
    if (!challenge) return;
    setSending(true);
    try {
      await api('/api/auth/mfa/email-otp/send', {
        method: 'POST',
        body: JSON.stringify({ attemptToken: challenge.attemptToken }),
      });
    } catch {
      // Swallowed on purpose. A failure here is either a rate limit or a dead
      // attempt, and the next Verify says so properly — surfacing it against
      // the send button would be a second, vaguer error for the same cause.
    } finally {
      setSent(true);
      setSending(false);
    }
  }

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

      const outcome = await api<AuthOutcome>('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      // The factor was accepted and the policy now wants something else — a
      // rule tightened while the user was reaching for their phone. The server
      // returns that arm deliberately rather than issuing a session, and
      // walking on as though it had sends the user to a page with no cookie,
      // which bounces them to /login with nothing to explain it.
      if (outcome.status !== 'authenticated') {
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
          returnTo: challenge.returnTo,
        };
        storeChallenge(next);
        if (kind === 'enrol') {
          navigate(routeFor(kind), { replace: true });
          return;
        }
        setChallenge(next);
        setCode('');
        setMode(firstMode(next.factors));
        setError(
          'Your organization now asks for a different factor. Use one of the options below.',
        );
        return;
      }

      takeChallenge();
      await refresh();
      const returnTo = challenge.returnTo.startsWith('/') ? challenge.returnTo : '/';
      // A SAML, OIDC or federation path belongs to the server, not to this
      // router: `navigate()` would fall through the catch-all to the portal,
      // and the sign-in the user just answered a challenge for would never
      // complete.
      if (isServerPath(returnTo)) {
        leaveTo(returnTo);
        return;
      }
      navigate(returnTo, { replace: true });
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
        // and neither does this. The recovery-code suggestion is only made when
        // this account actually has one to fall back on: advising it otherwise
        // sends the user round the same loop, since the server refuses a
        // recovery code against a rule that names a security key.
        setError(
          challenge.factors.includes('recovery_code')
            ? 'That did not match. Try again, or use a recovery code.'
            : 'That did not match. Try again.',
        );
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
          <h1 className="text-lg font-semibold text-ink">{t('mfa.title')}</h1>
          <p className="mt-1 text-muted">{t('mfa.lead')}</p>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            {mode === 'totp' && (
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
            )}
            {mode === 'email_otp' && (
              <>
                <Field
                  label={t('mfa.email_code')}
                  value={code}
                  onChange={setCode}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  invalid={Boolean(error)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={sending}
                  onClick={sendCode}
                >
                  {sent ? t('mfa.email_resend') : t('mfa.email_send')}
                </Button>
                {sent && (
                  // Fixed wording whatever the server did. The endpoint's own
                  // answer is deliberately the same for sent, too-soon, no
                  // address and switched-off, so this must not claim more.
                  <p className="text-sm text-muted">{t('mfa.email_sent')}</p>
                )}
              </>
            )}
            {mode === 'recovery_code' && (
              <Field
                label={t('mfa.recovery_code')}
                value={code}
                onChange={setCode}
                autoComplete="off"
                autoFocus
                required
                invalid={Boolean(error)}
              />
            )}
            {mode === 'webauthn' && (
              <p className="text-muted">{t('mfa.webauthn_lead')}</p>
            )}

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              {t('mfa.verify')}
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap gap-3">
            {offers('webauthn') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('webauthn')}>
                {t('mfa.use_key')}
              </Button>
            )}
            {offers('totp') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('totp')}>
                {t('mfa.use_totp')}
              </Button>
            )}
            {offers('email_otp') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('email_otp')}>
                {t('mfa.use_email')}
              </Button>
            )}
            {/* `offers`, like the two above it. The server decides whether a
                printed code is acceptable — it never is against a rule naming a
                security key — and offering one it will refuse walks a user into
                a loop with no way out of it. */}
            {offers('recovery_code') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('recovery_code')}>
                {t('mfa.use_recovery')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
