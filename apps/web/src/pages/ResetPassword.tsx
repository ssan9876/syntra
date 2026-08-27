import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { useT } from '../i18n/LocaleProvider.js';
import { ApiError, api } from '../session/api.js';
import { assertWebAuthnForReset } from '../mfa/webauthn.js';

interface Preflight {
  valid: boolean;
  requiresFactor: boolean;
  acceptableFactors: string[];
}

export function ResetPassword() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [password, setPassword] = useState('');
  const [factorMode, setFactorMode] = useState<'totp' | 'recovery_code' | 'webauthn'>('totp');
  const [factorCode, setFactorCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setPreflight({ valid: false, requiresFactor: false, acceptableFactors: [] });
      return;
    }
    api<Preflight>('/api/auth/password-reset/preflight', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((result) => {
        setPreflight(result);
        const first = result.acceptableFactors[0];
        if (first === 'webauthn' || first === 'recovery_code' || first === 'totp') {
          setFactorMode(first);
        }
      })
      .catch(() =>
        setPreflight({ valid: false, requiresFactor: false, acceptableFactors: [] }),
      );
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preflight?.valid) return;
    setBusy(true);
    setError(null);

    try {
      const factor = !preflight.requiresFactor
        ? undefined
        : factorMode === 'webauthn'
          ? { type: 'webauthn' as const, assertion: await assertWebAuthnForReset(token) }
          : { type: factorMode, code: factorCode };

      await api('/api/auth/password-reset/complete', {
        method: 'POST',
        body: JSON.stringify({
          token,
          newPassword: password,
          ...(factor ? { factor } : {}),
        }),
      });
      navigate('/login', { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.problem.detail ?? cause.problem.title);
      } else {
        setError('That could not be completed. Request a new link.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (preflight && !preflight.valid) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="That link is no longer usable">
            Reset links work once and expire after thirty minutes.
          </Alert>
          <p className="mt-4 text-center text-sm text-muted">
            <Link to="/forgot-password" className="link">
              Request a new one
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">{t('reset.title')}</h1>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <Field
              label={t('reset.password')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              autoFocus
              required
              hint={t('reset.hint')}
            />

            {preflight?.requiresFactor && factorMode !== 'webauthn' && (
              <Field
                label={factorMode === 'totp' ? t('reset.factor_totp') : t('mfa.recovery_code')}
                value={factorCode}
                onChange={setFactorCode}
                autoComplete="one-time-code"
                required
                hint={t('reset.factor_hint')}
              />
            )}
            {preflight?.requiresFactor && factorMode === 'webauthn' && (
              <p className="text-muted">
                Use your security key when the browser asks. Your account has a
                second factor, so resetting the password needs it too.
              </p>
            )}

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Set the password
            </Button>
          </form>

          {preflight && preflight.acceptableFactors.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {preflight.acceptableFactors
                .filter((f) => f !== factorMode)
                .map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant="ghost"
                    onClick={() => setFactorMode(f as typeof factorMode)}
                  >
                    {f === 'totp'
                      ? 'Use a code from your app'
                      : f === 'webauthn'
                        ? 'Use a security key'
                        : 'Use a recovery code'}
                  </Button>
                ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
