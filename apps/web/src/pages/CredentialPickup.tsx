import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { ApiError, api } from '../session/api.js';

type State = 'ready' | 'used' | 'expired' | 'revoked';

interface Status {
  state: State;
  systemName: string;
  username: string;
  expiresAt: string;
}

type View =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'status'; status: Status }
  | { kind: 'revealed'; status: Status; password: string }
  | { kind: 'refused'; status: Status };

const UNUSABLE: Record<Exclude<State, 'ready'>, string> = {
  used: 'This link has already been used',
  expired: 'This link has expired',
  revoked: 'This link has been withdrawn',
};

/**
 * The page behind a created account's one-time sign-in link.
 *
 * Opening it shows the system and the username and NOTHING else: mail
 * scanners open every link in every message, and a page that revealed the
 * password on load would have spent the link before the person ever saw it.
 * The password comes from a POST that only the button sends, and the server
 * answers that once.
 *
 * Styled like the reset page -- the same frame, the same single card -- because
 * it is the same kind of moment: somebody outside the console, holding a link,
 * with one thing to do.
 */
export function CredentialPickup() {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<Status>(`/api/credential-pickup/${encodeURIComponent(token)}`)
      .then((status) => {
        if (active) setView({ kind: 'status', status });
      })
      .catch(() => {
        if (active) setView({ kind: 'unknown' });
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function reveal(status: Status) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api<{ username: string; password: string }>(
        `/api/credential-pickup/${encodeURIComponent(token)}/reveal`,
        { method: 'POST' },
      );
      setView({ kind: 'revealed', status: { ...status, username: result.username }, password: result.password });
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem.status === 410) {
        // Every refusal reads the same from the server. The likeliest one --
        // the link opened in two places at once -- is "already used".
        setView({ kind: 'refused', status });
      } else {
        // Anything else (a rate limit, the network) has NOT spent the link,
        // so the button stays and says to try again.
        setProblem('That did not work. Try again in a minute.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // No clipboard (an insecure origin, a locked-down browser). The
      // password is on screen and selectable; nothing else to do.
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        {view.kind === 'loading' && (
          <div className="rounded-panel border border-border-subtle bg-bg p-6">
            <span className="sr-only">Loading</span>
            <div className="skeleton h-2 w-32 rounded-full" />
          </div>
        )}

        {view.kind === 'unknown' && (
          <Alert tone="warning" title="This link is not recognised">
            Check the whole link was copied.
          </Alert>
        )}

        {view.kind === 'status' && view.status.state !== 'ready' && (
          <Unusable state={view.status.state} />
        )}

        {view.kind === 'refused' && <Unusable state="used" />}

        {(view.kind === 'revealed' || (view.kind === 'status' && view.status.state === 'ready')) && (
          <div className="rounded-panel border border-border-subtle bg-bg p-6">
            <h1 className="text-lg font-semibold text-ink">Your sign-in details</h1>
            <dl className="mt-6 space-y-3 text-sm">
              <div>
                <dt className="text-muted">System</dt>
                <dd className="text-ink">{view.status.systemName}</dd>
              </div>
              <div>
                <dt className="text-muted">Username</dt>
                <dd>
                  <code className="select-all font-mono text-ink">{view.status.username}</code>
                </dd>
              </div>
              {view.kind === 'revealed' && (
                <div>
                  <dt className="text-muted">Password</dt>
                  <dd className="flex items-center gap-2">
                    <code
                      className="select-all break-all font-mono text-ink"
                      data-testid="revealed-password"
                    >
                      {view.password}
                    </code>
                    <Button size="sm" variant="secondary" onClick={() => void copy(view.password)}>
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </dd>
                </div>
              )}
            </dl>

            {problem && (
              <div className="mt-4">
                <Alert tone="danger">{problem}</Alert>
              </div>
            )}

            {view.kind === 'status' ? (
              <Button
                variant="primary"
                className="mt-6 w-full"
                loading={busy}
                onClick={() => void reveal(view.status)}
              >
                Show password
              </Button>
            ) : (
              <p className="mt-6 text-sm text-muted">
                Shown once — this link no longer works.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function Unusable({ state }: { state: Exclude<State, 'ready'> }) {
  return (
    <Alert tone="warning" title={UNUSABLE[state]}>
      Contact your administrator for a new one.
    </Alert>
  );
}
