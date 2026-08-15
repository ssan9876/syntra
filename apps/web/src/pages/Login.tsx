import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';
import { Wordmark } from '../components/Wordmark.js';

export function Login() {
  const { login } = useSession();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await login(loginName, password);
      navigate('/', { replace: true });
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
          <h1 className="text-lg font-semibold text-ink">Sign in</h1>
          <p className="mt-1 text-muted">
            Use the account your organization issued you.
          </p>

          <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
            <Field
              label="Login"
              value={loginName}
              onChange={setLoginName}
              autoComplete="username"
              autoFocus
              required
              invalid={Boolean(error)}
            />
            <Field
              label="Password"
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
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          Trouble signing in? Contact your IT administrator.
        </p>
      </div>
    </main>
  );
}
