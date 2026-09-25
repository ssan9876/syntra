import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LoginInfo } from './PersonAccessLoginInfo.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  }) as never;

const BASE = '/api/admin/targets/t1/accounts/p1';

const history = (over: Record<string, unknown> = {}) => ({
  hasInitialSecret: true,
  pickups: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      recipientKind: 'manager',
      createdAt: '2026-09-20T10:00:00.000Z',
      expiresAt: '2026-09-23T10:00:00.000Z',
      viewedAt: '2026-09-20T11:00:00.000Z',
      revokedAt: null,
      createdByUserId: null,
      state: 'used',
    },
  ],
  ...over,
});

function mockRoutes(handlers: Record<string, (init: RequestInit | undefined) => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[String(input)];
    if (!handler) return Promise.reject(new Error(`unmocked fetch: ${String(input)}`));
    return Promise.resolve(handler(init));
  }) as never);
}

const renderIt = () =>
  render(
    <MemoryRouter>
      <LoginInfo personId="p1" targetSystemId="t1" />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('LoginInfo', () => {
  it('shows the links already sent, and who they went to', async () => {
    granted.add('provision.read');
    mockRoutes({ [`${BASE}/credential-pickups`]: () => json(history()) });
    renderIt();

    expect(await screen.findByText('Manager')).toBeInTheDocument();
    expect(screen.getByText(/^Viewed /)).toBeInTheDocument();
    // provision.read alone does not send anything.
    expect(screen.queryByRole('button', { name: /send login info/i })).not.toBeInTheDocument();
  });

  it('sends to the chosen recipient and reloads the history', async () => {
    granted.add('provision.read');
    granted.add('provision.manage');
    let sent: unknown = null;
    const fetch = mockRoutes({
      [`${BASE}/credential-pickups`]: () => json(history()),
      [`${BASE}/send-login-info`]: (init) => {
        sent = JSON.parse(String(init?.body));
        return json({ pickupId: 'x', recipientKind: 'personalEmail', expiresAt: '', revoked: 0, delivered: true });
      },
    });
    renderIt();

    await userEvent.selectOptions(await screen.findByLabelText('Send to'), 'personalEmail');
    await userEvent.click(screen.getByRole('button', { name: /send login info/i }));

    await waitFor(() => expect(sent).toEqual({ recipient: 'personalEmail' }));
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/credential-pickups'))).toHaveLength(2),
    );
  });

  it('offers a way to elevate when the server wants a fresh session', async () => {
    granted.add('provision.read');
    granted.add('provision.manage');
    mockRoutes({
      [`${BASE}/credential-pickups`]: () => json(history()),
      [`${BASE}/send-login-info`]: () =>
        json(
          {
            type: 'https://syntra.dev/problems/step-up-required',
            title: 'Confirm it is you first',
            status: 403,
            detail: 'Elevate again, then retry.',
          },
          403,
        ),
    });
    renderIt();

    await userEvent.click(await screen.findByRole('button', { name: /send login info/i }));
    expect(await screen.findByRole('button', { name: /elevate again/i })).toBeInTheDocument();
  });

  it('offers nothing to send when no initial password is held', async () => {
    granted.add('provision.read');
    granted.add('provision.manage');
    mockRoutes({ [`${BASE}/credential-pickups`]: () => json(history({ hasInitialSecret: false, pickups: [] })) });
    renderIt();

    expect(await screen.findByText(/no initial password held/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send login info/i })).not.toBeInTheDocument();
  });
});
