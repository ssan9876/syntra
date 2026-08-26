import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Panel, Status } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { ApiError, api } from '../session/api.js';
import { startWebAuthnRegistration } from '../mfa/webauthn.js';
// The CONTRACT, not a local restatement. The API builds this response by hand
// and this file described it independently, so the two could drift with
// nothing anywhere to notice -- which is the whole reason the schema exists.
// Type-only: a runtime parse in the browser would strip a field the server had
// legitimately started sending.
import type { MfaStatusResponse } from '@syntra/contracts';
import { PasswordPanel } from './security/PasswordPanel.js';


interface Enrolment {
  secret: string;
  uri: string;
  qr: string;
}

export function Security() {
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState('Security key');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<MfaStatusResponse>('/api/auth/mfa'));
    } catch {
      setError('Your security settings could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function beginTotp() {
    setBusy(true);
    setCodeError(null);
    try {
      setEnrolment(await api<Enrolment>('/api/auth/mfa/totp/begin', { method: 'POST' }));
    } catch {
      setError('Enrolment could not be started.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp() {
    setBusy(true);
    setCodeError(null);
    try {
      await api('/api/auth/mfa/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setEnrolment(null);
      setCode('');
      await load();
    } catch (cause) {
      setCodeError(
        cause instanceof ApiError && cause.problem.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That code did not match. Check your app and try the next one.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function addKey() {
    setBusy(true);
    setError(null);
    try {
      await startWebAuthnRegistration(keyLabel.trim() || 'Security key');
      await load();
    } catch (cause) {
      setError(
        cause instanceof DOMException
          ? 'That security key was not registered. Try again.'
          : 'That security key was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Removing a security key.
   *
   * Two things were missing and both were silent. The response carries
   * `recoveryCodesRevoked` and this function threw it away, so a user whose
   * printed codes had just stopped working was never told -- and there is no
   * other screen that would tell them. And there was no error handling at all:
   * a refusal was an unhandled rejection and the button simply appeared not to
   * work.
   */
  async function removeKey(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ recoveryCodesRevoked: number }>(
        `/api/auth/mfa/webauthn/${id}`,
        { method: 'DELETE' },
      );
      if (result.recoveryCodesRevoked > 0) {
        setNotice(
          `That key was removed, and ${result.recoveryCodesRevoked} unused recovery code${
            result.recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it. Set up a factor and generate new ones.`,
        );
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That key could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Removing the authenticator app.
   *
   * The panel used to render a bare "Set up" badge once one was enrolled, so
   * the only way to move to a new phone was through an administrator -- for a
   * control the rest of this screen manages without one.
   *
   * The count of revoked recovery codes is SHOWN rather than discarded. It is
   * the one thing the user cannot find out any other way: the codes they
   * printed have just stopped working, and a screen that quietly said nothing
   * would send them to a drawer full of dead codes in six months.
   */
  async function removeTotp() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ recoveryCodesRevoked: number }>(
        '/api/auth/mfa/totp',
        { method: 'DELETE' },
      );
      if (result.recoveryCodesRevoked > 0) {
        setNotice(
          `Your authenticator app was removed, and ${result.recoveryCodesRevoked} unused recovery code${
            result.recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it. Set up a factor and generate new ones.`,
        );
      } else {
        setNotice('Your authenticator app was removed.');
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function issueCodes() {
    setBusy(true);
    try {
      const result = await api<{ codes: string[] }>('/api/auth/mfa/recovery-codes', {
        method: 'POST',
      });
      setCodes(result.codes);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.kind === 'no-factor-to-recover'
          ? (cause.problem.detail ??
            'Set up an authenticator app or a security key first.')
          : 'Recovery codes could not be generated.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold text-ink">Security</h1>
          <p className="mt-1 text-muted">
            Your password, and the second factors that keep the account usable
            only by you even if it is guessed.
          </p>
        </header>

        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="warning">{notice}</Alert>}

        <PasswordPanel />

        <Panel
          title="Authenticator app"
          description="A six-digit code that changes every thirty seconds."
          actions={
            status?.totp.enrolled ? (
              <span className="flex items-center gap-2">
                <Status tone="active">Set up</Status>
                <Button size="sm" variant="ghost" loading={busy} onClick={removeTotp}>
                  Remove
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="primary" loading={busy} onClick={beginTotp}>
                Set up
              </Button>
            )
          }
        >
          {enrolment && (
            <div className="space-y-4 p-4">
              <p className="text-muted">
                Scan this with your authenticator app, then type the code it shows.
              </p>
              <img
                src={enrolment.qr}
                alt="QR code for your authenticator app"
                className="size-48 rounded-control border border-border-subtle"
              />
              <p className="text-sm text-muted">
                Cannot scan? Enter this key instead:{' '}
                <code className="font-mono text-ink">{enrolment.secret}</code>
              </p>
              <Field
                label="Code from your app"
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                {...(codeError ? { error: codeError } : {})}
              />
              <Button variant="primary" loading={busy} onClick={confirmTotp}>
                Confirm
              </Button>
            </div>
          )}
        </Panel>

        <Panel
          title="Security keys and passkeys"
          description="A hardware key, or the fingerprint or face unlock built into this device."
        >
          <div className="space-y-4 p-4">
            {status?.webauthn.credentials.length === 0 && (
              <p className="text-muted">Nothing registered yet.</p>
            )}
            {status && status.webauthn.credentials.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {status.webauthn.credentials.map((credential) => (
                  <li key={credential.id} className="flex items-center justify-between py-2">
                    <span>
                      <span className="block font-medium text-ink">{credential.label}</span>
                      <span className="block text-sm text-muted">
                        Added {new Date(credential.createdAt).toLocaleDateString()}
                        {credential.lastUsedAt
                          ? ` · last used ${new Date(credential.lastUsedAt).toLocaleDateString()}`
                          : ' · never used'}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => removeKey(credential.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {status && !status.webauthn.available ? (
              <Alert tone="info" title="Security keys are not available here">
                {status.webauthn.unavailableReason ??
                  'An administrator must configure this tenant before security keys can be used.'}
              </Alert>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Name this key"
                  value={keyLabel}
                  onChange={setKeyLabel}
                  className="min-w-56 flex-1"
                />
                <Button variant="primary" loading={busy} onClick={addKey}>
                  Add a key
                </Button>
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title="Recovery codes"
          description="Single-use codes for when you lose your phone or key."
          actions={
            <Button size="sm" loading={busy} onClick={issueCodes}>
              {status && status.recoveryCodes.remaining > 0 ? 'Replace codes' : 'Generate codes'}
            </Button>
          }
        >
          <div className="space-y-3 p-4">
            <p className="text-muted">
              {status?.recoveryCodes.remaining ?? 0} unused code
              {status?.recoveryCodes.remaining === 1 ? '' : 's'} remaining.
            </p>
            {codes && (
              <>
                <Alert tone="warning" title="Save these now">
                  They are shown once. Syntra stores only their fingerprints and
                  cannot show them again.
                </Alert>
                <ul className="grid grid-cols-2 gap-2 font-mono text-ink sm:grid-cols-3">
                  {codes.map((value) => (
                    <li key={value} className="rounded-control bg-surface-2 px-2 py-1 text-center">
                      {value}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
