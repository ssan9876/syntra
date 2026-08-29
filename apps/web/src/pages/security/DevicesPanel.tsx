import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Panel } from '@syntra/ui';
import { api } from '../../session/api.js';

interface DeviceRow {
  id: string;
  scope: 'portal' | 'admin';
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/**
 * A user agent reduced to what somebody uses to recognise their own session.
 *
 * A second copy of the console's helper, deliberately. The two answer the same
 * question for different readers and neither is a rule: an administrator's
 * list and a person's own list can diverge in wording without either being
 * wrong, and a shared helper would make the first change to one a change to
 * both. Presentation duplicated is cheaper than presentation coupled.
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
 * Where you are signed in, and signing one of them out.
 *
 * The case this exists for is somebody who suspects a session they did not
 * start, and until now the only remedy available to them was changing their
 * password — a blunt instrument that also signs out the laptop they left at
 * home. This lets them end the one session that worries them.
 *
 * The current session is LABELLED, not hidden, and its control says what it
 * does: "Sign out this device". The label is the confirmation — a dialog
 * asking "are you sure?" over a button that already says what follows is a
 * second click for no information.
 */
export function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api<{ sessions: DeviceRow[] }>('/api/portal/sessions');
      // `?? []` rather than trusting the shape: a render that throws takes the
      // whole security page with it, and an empty list is a far smaller lie
      // than a blank screen.
      setDevices(body.sessions ?? []);
    } catch {
      setError('Your devices could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function end(device: DeviceRow) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ signedOut: boolean }>(
        `/api/portal/sessions/${device.id}`,
        { method: 'DELETE' },
      );
      if (result.signedOut) {
        // Nothing more to load: the cookie the reply cleared was the one this
        // page was using. Saying so beats a list that silently starts 401ing.
        setSignedOut(true);
        return;
      }
      await load();
    } catch {
      setError('That device could not be signed out.');
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) {
    return (
      <Panel title="Where you are signed in" bodyClassName="p-4">
        <Alert tone="success" title="You have been signed out">
          This device is signed out. Sign in again to carry on.
        </Alert>
      </Panel>
    );
  }

  return (
    <Panel title="Where you are signed in" bodyClassName="p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {devices !== null && devices.length === 0 && (
        <Empty title="Nothing to show yet">
          Sessions appear here as you sign in from a browser.
        </Empty>
      )}

      {devices !== null && devices.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {describeAgent(device.userAgent)}
                  {device.current && (
                    <span className="ml-2 text-xs text-muted">This device</span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {device.ip ?? 'address unknown'} · signed in{' '}
                  {since(device.createdAt)} · last seen {since(device.lastSeenAt)}
                </div>
              </div>
              <Button
                variant="danger-quiet"
                size="sm"
                disabled={busy}
                onClick={() => void end(device)}
              >
                {device.current ? 'Sign out this device' : 'Sign out'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
