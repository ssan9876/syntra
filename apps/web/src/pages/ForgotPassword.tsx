import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { api } from '../session/api.js';

export function ForgotPassword() {
  const [login, setLogin] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ login }),
      });
    } catch {
      // Deliberately swallowed. The server answers identically whether or not
      // the account exists, and a visible failure here would give that away.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          {sent ? (
            <>
              <h1 className="text-lg font-semibold text-ink">Check your inbox</h1>
              <Alert tone="info">
                If that account exists, we have sent it a link. It works once and
                expires in thirty minutes.
              </Alert>
              <p className="mt-4 text-sm text-muted">
                Nothing arrived? Check spam, or ask your IT administrator — some
                accounts have their password managed elsewhere.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
              <p className="mt-1 text-muted">
                Enter your login or work email address.
              </p>
              <form onSubmit={submit} noValidate className="mt-6 space-y-4">
                <Field
                  label="Login or email"
                  value={login}
                  onChange={setLogin}
                  autoComplete="username"
                  autoFocus
                  required
                />
                <Button type="submit" variant="primary" loading={busy} className="w-full">
                  Send the link
                </Button>
              </form>
            </>
          )}
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/login" className="text-accent underline-offset-2 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
