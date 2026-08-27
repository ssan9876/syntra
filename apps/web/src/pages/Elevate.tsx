import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';
import { AppShell } from '../components/AppShell.js';
import { routeFor, storeChallenge } from '../mfa/challenge-store.js';

/**
 * Elevation is a fresh authentication, not a mode switch, so the screen asks
 * for the password again and says plainly why.
 */
export function Elevate() {
  const { elevate } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the guard bounced them from, IN FULL.
  //
  // This read `from.pathname` alone and dropped the query string, which was
  // invisible for as long as no console URL carried meaningful query state.
  // Then the console's navigation collapsed into tabbed destinations whose
  // selected tab lives in `?tab=`, and every deep link through this guard
  // began landing on the wrong tab of the right page — the worst shape of bug
  // to be on the receiving end of, because it looks like it worked. Somebody
  // follows a link to the orphan accounts screen, is asked for their
  // password, and arrives at findings.
  const from = location.state as
    | { from?: { pathname?: string; search?: string; hash?: string } }
    | null;
  const intended = from?.from?.pathname
    ? `${from.from.pathname}${from.from.search ?? ''}${from.from.hash ?? ''}`
    : '/admin/users';

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
        return;
      }

      // Elevation re-authenticates from scratch, so any require_mfa rule lands
      // here every time — a factor presented at sign-in does not carry over.
      // The handoff is the login page's, with one difference: the return is to
      // wherever the guard bounced them from, so satisfying the factor does not
      // also cost them their place.
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
        returnTo: intended,
      });
      navigate(routeFor(kind), { replace: true });
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
