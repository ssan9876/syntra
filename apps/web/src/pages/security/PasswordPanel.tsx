import { useState } from 'react';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

interface ChangeResult {
  ok: true;
  otherSessionsRevoked: number;
}

/**
 * Changing your own password, without an administrator and without a trip
 * through your inbox.
 *
 * The FIRST panel on the security page, above the second-factor sections.
 * Enrolling an authenticator is the more interesting thing on this screen and
 * was the only thing on it; changing a password is the thing people actually
 * arrive wanting to do, and burying it under two sections about factors they
 * may not have would answer the wrong question first.
 *
 * The server owns every rule. This component checks that the two new entries
 * match — which is a typing mistake, knowable here, and not worth a round
 * trip — and otherwise renders whatever the server said. Restating the length
 * minimum or the predictability rule in the browser would put a second copy of
 * the tenant's policy somewhere it cannot see the tenant.
 */
export function PasswordPanel() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm !== '' && next !== confirm;
  const ready = current !== '' && next !== '' && confirm !== '' && !mismatch;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setError(null);
    setFieldError({});
    setDone(null);

    try {
      const result = await api<ChangeResult>('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });

      // Cleared on success only. A rejected attempt keeps what was typed —
      // being made to retype a long passphrase because the OTHER field was
      // wrong is the kind of small cruelty that teaches people to pick
      // shorter ones.
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(
        result.otherSessionsRevoked > 0
          ? `Password changed. ${result.otherSessionsRevoked} other ${
              result.otherSessionsRevoked === 1 ? 'session was' : 'sessions were'
            } signed out.`
          : 'Password changed.',
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        // `detail` is the sentence the server wrote for this exact refusal;
        // `title` is the category. Preferring the category would replace
        // "Choose something less predictable than your own name or login"
        // with "Password rejected".
        setError(cause.problem.detail ?? cause.problem.title);
        const errors = cause.problem.errors ?? [];
        setFieldError(
          Object.fromEntries(errors.map((e) => [e.path, e.message])),
        );
      } else {
        setError('The password could not be changed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Password"
    >
      <form onSubmit={submit} className="space-y-4">
        {done && <Alert tone="success">{done}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}

        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          error={fieldError['currentPassword']}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          error={fieldError['newPassword']}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          // Shown against the field being compared, and only once something
          // has been typed into it — flagging an empty box as a mismatch
          // scolds somebody who has not finished.
          error={mismatch ? 'This does not match the new password.' : undefined}
        />

        <div className="flex justify-end">
          <Button type="submit" disabled={!ready || busy}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
