import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { ApiError, api, isRateLimited } from '../session/api.js';

const REASON_MIN = 20;

/**
 * Requesting emergency (break-glass) console access with a sealed recovery
 * credential.
 *
 * Reached without a session, because it exists for when no administrator can
 * sign in to the console. It grants nothing by itself: the request is
 * announced to every administrator at once and takes effect only after the
 * organization's delay, or when another administrator approves it. After
 * that, the account signs in and elevates as usual.
 *
 * English only, like the console it leads to: it is for the few people who
 * hold an emergency account, not for everybody who signs in.
 */
export function BreakGlass() {
  const [login, setLogin] = useState('');
  const [credential, setCredential] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('60');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<{ activatesAt: string; durationMinutes: number } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setProblem(null);
    try {
      setPending(await api<{ activatesAt: string; durationMinutes: number }>('/api/auth/break-glass/activate', {
        method: 'POST',
        body: JSON.stringify({ login, credential, reason, durationMinutes: Number(duration) }),
      }));
      setCredential('');
    } catch (cause) {
      setProblem(isRateLimited(cause)
        ? 'Too many attempts. Wait a minute and try again.'
        : cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The request failed.');
    } finally {
      setBusy(false);
    }
  }

  const durationNumber = Number(duration);
  const ready = login.trim() !== '' && credential.trim() !== '' && reason.trim().length >= REASON_MIN &&
    Number.isInteger(durationNumber) && durationNumber >= 15 && durationNumber <= 240;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">Emergency console access</h1>
          {pending ? (
            <Alert tone="warning" title="Requested">
              Every administrator has been told. It takes effect at {new Date(pending.activatesAt).toLocaleString()} unless
              somebody cancels it, and lasts {pending.durationMinutes} minutes. Then sign in and open the console as usual.
            </Alert>
          ) : (
            <form onSubmit={submit} noValidate className="mt-6 space-y-4">
              <div role="status" aria-live="polite">{problem ? <Alert tone="danger">{problem}</Alert> : null}</div>
              <Field label="Emergency account login" value={login} onChange={setLogin} autoComplete="username" required />
              <Field label="Sealed credential" value={credential} onChange={setCredential} type="password" autoComplete="off" required />
              <Field
                label="Reason"
                value={reason}
                onChange={setReason}
                required
                warning={reason.trim().length > 0 && reason.trim().length < REASON_MIN ? `At least ${REASON_MIN} characters` : undefined}
              />
              <Field
                label="Minutes of access"
                value={duration}
                onChange={setDuration}
                inputMode="numeric"
                warning={Number.isInteger(durationNumber) && durationNumber >= 15 && durationNumber <= 240 ? undefined : '15–240 minutes'}
              />
              <Button type="submit" variant="danger" loading={busy} disabled={!ready} className="w-full">Request emergency access</Button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/login" className="link">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
