import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';

interface SessionRow {
  id: string;
  scope: 'portal' | 'admin';
  satisfiedFactor: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
}

/**
 * A user agent reduced to the two things somebody uses to recognise a session.
 *
 * Presentation, and deliberately local to this file: no other screen needs it,
 * and a shared helper would invite somebody to parse the string for a decision
 * later. Unrecognised strings are shown whole rather than replaced with
 * "Unknown" -- a reader who cannot place "Firefox on Windows" can still place
 * the raw header, and cannot place a shrug at all.
 */
function describeAgent(agent: string | null): string {
  if (!agent) return 'Unknown browser';

  const browser =
    /Edg\//.test(agent) ? 'Edge'
    : /OPR\//.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari'
    : null;

  const platform =
    /Windows/.test(agent) ? 'Windows'
    : /Macintosh|Mac OS/.test(agent) ? 'macOS'
    : /Android/.test(agent) ? 'Android'
    : /iPhone|iPad/.test(agent) ? 'iOS'
    : /Linux/.test(agent) ? 'Linux'
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  return agent.length > 60 ? `${agent.slice(0, 60)}…` : agent;
}

/** "4 minutes ago" — the unit somebody thinks in when reading a session list. */
function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The sessions this account currently holds, and ending them.
 *
 * This panel is why `Session` grew an address and a user agent. A list of
 * scopes and timestamps is not something a person can act on precisely -- every
 * row looks alike, so the only safe control is "revoke all" -- and the whole
 * value of the screen is being able to end ONE session because you can tell
 * which one it is.
 *
 * Revoking is offered to `directory.write` and takes no step-up. Revocation
 * grants nothing; asking for a second factor to take access away would make
 * the safe act harder than the dangerous one.
 */
export function AccountSessions({ userId }: { userId: string }) {
  const { data, error, loading, reload } = useApiResource<{ sessions: SessionRow[] }>(
    `/api/admin/users/${userId}/sessions`,
  );
  const can = useCan();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sessions = data?.sessions ?? [];
  const mayRevoke = can('directory.write');

  const act = async (path: string, method: 'DELETE' | 'POST') => {
    setFailure(null);
    setBusy(true);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        setFailure('Could not end that session. It may have already expired.');
        return;
      }
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Sessions"
      actions={
        mayRevoke && sessions.length > 0 ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => act(`/api/admin/users/${userId}/sessions/revoke`, 'POST')}
          >
            Sign out everywhere
          </Button>
        ) : undefined
      }
      bodyClassName="p-4"
    >
      {error && <Alert tone="danger">Could not load sessions.</Alert>}
      {failure && <Alert tone="danger">{failure}</Alert>}
      {loading && <SkeletonRows rows={2} />}

      {!loading && sessions.length === 0 && (
        <Empty title="No active sessions">
          This account is not signed in anywhere. A session appears here as
          soon as somebody signs in with it.
        </Empty>
      )}

      {sessions.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {describeAgent(session.userAgent)}
                  {session.scope === 'admin' && (
                    <span className="ml-2 text-xs text-muted">administrative</span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {session.ip ?? 'address unknown'} · signed in{' '}
                  {since(session.createdAt)} · last seen {since(session.lastSeenAt)}
                </div>
              </div>
              {mayRevoke && (
                <Button
                  variant="danger-quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(`/api/admin/users/${userId}/sessions/${session.id}`, 'DELETE')
                  }
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
