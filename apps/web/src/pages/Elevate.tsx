import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';
import { AppShell } from '../components/AppShell.js';

/**
 * Elevation is a fresh authentication, not a mode switch, so the screen asks
 * for the password again and says plainly why.
 */
export function Elevate() {
  const { elevate } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the guard bounced them from, if anywhere.
  const intended =
    (location.state as { from?: { pathname?: string } } | null)?.from
      ?.pathname ?? '/admin/users';

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const outcome = await elevate(password);
      if (outcome.status === 'authenticated') {
        navigate(intended, { replace: true });
      } else if (outcome.status === 'challenge') {
        // Elevation re-authenticates from scratch, so any require_mfa rule
        // lands here every time — a factor presented at sign-in does not carry
        // over. Task 14 replaces this with the step-up screen; until then, say
        // so and leave the portal session exactly as it was.
        setError(
          'Administration requires a second factor. That screen is not built yet.',
        );
      } else {
        // Task 14 replaces this with the forced-enrolment screen.
        setError(
          'Administration requires a second factor you have not registered. That screen is not built yet.',
        );
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'not-an-administrator') {
        setError(
          'This account holds no administrative roles. Ask an administrator to grant you one.',
        );
      } else if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else {
        setError('That password is incorrect.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-md px-6 py-16">
        <h1 className="text-lg font-semibold text-ink">
          Confirm your password
        </h1>
        <p className="mt-1.5 text-muted">
          Administration runs in a separate, shorter session. Entering your
          password again starts one.
        </p>

        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            autoFocus
            required
            invalid={Boolean(error)}
          />

          {error && <Alert tone="danger">{error}</Alert>}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Continue
            </Button>
            <Button type="button" onClick={() => navigate('/')}>
              Cancel
            </Button>
          </div>
        </form>
      </main>
    </AppShell>
  );
}
