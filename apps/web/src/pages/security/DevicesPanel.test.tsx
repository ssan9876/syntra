import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DevicesPanel } from './DevicesPanel.js';

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

const LIST = '/api/portal/sessions';

const device = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 's-1',
  scope: 'portal',
  ip: '198.51.100.4',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1',
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
  current: false,
  ...over,
});

beforeEach(() => vi.restoreAllMocks());

describe('DevicesPanel', () => {
  it('marks the session you are reading it from', async () => {
    mockRoutes({
      [LIST]: () =>
        json({ sessions: [device({ id: 's-1', current: true }), device({ id: 's-2' })] }),
    });
    render(<DevicesPanel />);

    expect(await screen.findByText('This device')).toBeInTheDocument();
  });

  it('names the browser and where it signed in from', async () => {
    mockRoutes({ [LIST]: () => json({ sessions: [device()] }) });
    render(<DevicesPanel />);

    expect(await screen.findByText(/Safari on macOS/)).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.4/)).toBeInTheDocument();
  });

  it('says what the button does, so no dialog has to', async () => {
    mockRoutes({ [LIST]: () => json({ sessions: [device({ current: true })] }) });
    render(<DevicesPanel />);

    expect(
      await screen.findByRole('button', { name: 'Sign out this device' }),
    ).toBeInTheDocument();
  });

  it('tells you plainly when you have signed yourself out', async () => {
    // The reply cleared the cookie this page was using. Reloading the list
    // would 401; saying so is the only honest thing left to do.
    mockRoutes({
      [LIST]: () => json({ sessions: [device({ current: true })] }),
      '/api/portal/sessions/s-1': () => json({ signedOut: true }),
    });
    render(<DevicesPanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Sign out this device' }),
    );

    expect(await screen.findByText(/You have been signed out/)).toBeInTheDocument();
  });

  it('stays on the page and reloads when the ended session was another one', async () => {
    let ended = false;
    mockRoutes({
      [LIST]: () => json({ sessions: ended ? [device({ id: 's-9', current: true })] : [device(), device({ id: 's-9', current: true })] }),
      '/api/portal/sessions/s-1': () => {
        ended = true;
        return json({ signedOut: false });
      },
    });
    render(<DevicesPanel />);

    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    await userEvent.click(buttons[0]!);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull(),
    );
    expect(screen.queryByText(/You have been signed out/)).toBeNull();
  });

  it('says so when the list cannot be loaded', async () => {
    mockRoutes({ [LIST]: () => json({ title: 'nope' }, 500) });
    render(<DevicesPanel />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i),
    );
  });
});
