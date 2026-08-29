import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AccountSessions } from './AccountSessions.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockRoutes(
  handlers: Record<string, (init: RequestInit | undefined) => Response>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) return Promise.reject(new Error(`unmocked fetch: ${url}`));
    return Promise.resolve(handler(init));
  }) as never);
}

const LIST = '/api/admin/users/u-1/sessions';

const session = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 's-1',
  scope: 'portal',
  satisfiedFactor: null,
  ip: '198.51.100.4',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64) Gecko/20100101 Firefox/141.0',
  createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...over,
});

const renderPanel = () =>
  render(
    <MemoryRouter>
      <AccountSessions userId="u-1" />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('AccountSessions', () => {
  it('describes a session in terms somebody can recognise', async () => {
    // The whole reason the columns exist. "portal session, 2 hours old" is not
    // something a person can pick out of four rows.
    mockRoutes({ [LIST]: () => json({ sessions: [session()] }) });
    renderPanel();

    expect(await screen.findByText(/Firefox on Windows/)).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.4/)).toBeInTheDocument();
    expect(screen.getByText(/last seen 4 minutes ago/)).toBeInTheDocument();
  });

  it('shows the raw agent when it recognises neither browser nor platform', async () => {
    // Better than "Unknown": a reader who cannot place a friendly name can
    // still place the header, and cannot place a shrug at all.
    mockRoutes({
      [LIST]: () => json({ sessions: [session({ userAgent: 'curl/8.4.0' })] }),
    });
    renderPanel();

    expect(await screen.findByText(/curl\/8\.4\.0/)).toBeInTheDocument();
  });

  it('names the next action when there are no sessions', async () => {
    mockRoutes({ [LIST]: () => json({ sessions: [] }) });
    renderPanel();

    expect(await screen.findByText(/No active sessions/)).toBeInTheDocument();
  });

  it('offers no revoke control without directory.write', async () => {
    // Reading the list and ending a session are different authorities, and the
    // console must not offer a control the API will refuse.
    granted.add('directory.read');
    mockRoutes({ [LIST]: () => json({ sessions: [session()] }) });
    renderPanel();

    await screen.findByText(/Firefox on Windows/);
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out everywhere/i })).toBeNull();
  });

  it('revokes one session and stops showing it', async () => {
    granted.add('directory.write');
    let revoked = false;
    mockRoutes({
      [LIST]: () => json({ sessions: revoked ? [] : [session()] }),
      '/api/admin/users/u-1/sessions/s-1': () => {
        revoked = true;
        return new Response(null, { status: 204 }) as never;
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }));

    expect(await screen.findByText(/No active sessions/)).toBeInTheDocument();
  });

  it('says so when a revoke fails rather than quietly leaving the row', async () => {
    granted.add('directory.write');
    mockRoutes({
      [LIST]: () => json({ sessions: [session()] }),
      '/api/admin/users/u-1/sessions/s-1': () => json({ title: 'gone' }, 404),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not end that session/i),
    );
  });
});
