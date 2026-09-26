import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Check, ErrorSummary, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

type Scope = 'all' | 'admin';

interface RevokeResult {
  usersAffected: number;
  sessionsRevoked: number;
  logoutsEnqueued: number;
}

/** The server's floor, repeated so the button does not offer a doomed request. */
const REASON_MIN = 10;

/**
 * Ending sessions across the whole organization — the incident-response
 * button.
 *
 * Two presses, not one. The first says exactly what the second will do, in a
 * warning that names the scope; the second is a differently-labelled danger
 * button, so the press that signs an organization out is never the same
 * gesture as the one that merely opened the question. The pattern the domain
 * change on the Sign-in tab already uses.
 *
 * Step-up is the server's: it refuses unless this console session was started
 * in the last few minutes. When it does, the answer here is a way to satisfy
 * it — elevate again and come straight back — rather than a dead end.
 */
export function SettingsSessionsTab() {
  const navigate = useNavigate();
  const location = useLocation();
  const [scope, setScope] = useState<Scope>('all');
  const [keepMine, setKeepMine] = useState(true);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [result, setResult] = useState<RevokeResult | null>(null);

  const reasonOk = reason.trim().length >= REASON_MIN;

  function ask(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setStepUp(null);
    setResult(null);
    if (!reasonOk) return;
    setConfirming(true);
  }

  async function revoke() {
    setBusy(true);
    setFailure(null);
    setStepUp(null);
    try {
      const outcome = await api<RevokeResult>('/api/admin/sessions/revoke', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          keepCurrentSession: keepMine,
          reason: reason.trim(),
        }),
      });
      setResult(outcome);
      setConfirming(false);
      setReason('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'step-up-required') {
        setStepUp(cause.problem.detail ?? cause.problem.title);
      } else {
        setFailure(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'The sessions were not revoked. Try again.',
        );
      }
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const what = scope === 'admin' ? 'every console session' : 'every session';

  return (
    <form onSubmit={ask} noValidate className="space-y-6">
      <Panel title="Revoke sessions" bodyClassName="space-y-5 p-4">
        <ErrorSummary
          errors={failure ? [{ message: failure }] : []}
          title="Sessions not revoked"
        />

        <Select
          name="scope"
          label="Sessions to end"
          value={scope}
          onChange={(v) => {
            setScope(v === 'admin' ? 'admin' : 'all');
            setConfirming(false);
          }}
          options={[
            { value: 'all', label: 'Every session, portal and console' },
            { value: 'admin', label: 'Console sessions only' },
          ]}
          className="max-w-md"
        />

        <Check
          checked={keepMine}
          onChange={(v) => {
            setKeepMine(v);
            setConfirming(false);
          }}
          label="Keep my current session"
        />

        <Field
          name="reason"
          label="Reason"
          value={reason}
          onChange={(v) => {
            setReason(v);
            setConfirming(false);
          }}
          placeholder="Suspected credential compromise, incident 2026-114"
          maxLength={500}
          className="max-w-xl"
          warning={
            reason.trim().length > 0 && !reasonOk
              ? `At least ${REASON_MIN} characters`
              : undefined
          }
        />

        <div className="border-t border-border-subtle pt-4">
          {/* `danger-quiet`: this press only asks the question. The filled
              danger button is the one inside the warning below, which says
              what it will end before it ends it. */}
          <Button type="submit" variant="danger-quiet" disabled={!reasonOk || busy}>
            Revoke sessions…
          </Button>
        </div>

        {confirming && (
          <Alert tone="warning" title={`This ends ${what} in the organization`}>
            <ul className="list-disc pl-5">
              <li>Refresh tokens revoked</li>
              <li>Connected applications signed out</li>
              <li>{keepMine ? 'Your current session is kept' : 'Includes yours'}</li>
            </ul>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() => void revoke()}
              className="mt-3"
            >
              {scope === 'admin' ? 'Revoke every console session' : 'Revoke every session'}
            </Button>
          </Alert>
        )}

        {stepUp && (
          <Alert tone="warning" title="Confirm it is you first">
            <p>{stepUp}</p>
            <Button
              type="button"
              onClick={() => navigate('/elevate', { state: { from: location } })}
              className="mt-3"
            >
              Elevate again
            </Button>
          </Alert>
        )}


        {/*
          A polite live region, always mounted, so the outcome of an action
          that takes a moment is announced when it lands rather than only
          drawn.
        */}
        <p role="status" aria-live="polite" className="text-sm text-ink">
          {result &&
            `${result.sessionsRevoked} ${result.sessionsRevoked === 1 ? 'session' : 'sessions'} revoked for ${result.usersAffected} ${result.usersAffected === 1 ? 'person' : 'people'}; ${result.logoutsEnqueued} application sign-outs queued.`}
        </p>
      </Panel>
    </form>
  );
}
