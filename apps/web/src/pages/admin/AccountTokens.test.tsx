import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AccountTokens } from './AccountTokens.js';

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

const LIST = '/api/admin/users/u-1/tokens';

const token = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 't-1',
  name: 'SCIM from Workday',
  scopes: [],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
});

const renderPanel = () =>
  render(
    <MemoryRouter>
      <AccountTokens userId="u-1" />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('AccountTokens', () => {
  it('shows a token by name and when it was last used', async () => {
    // A credential nobody can tell is unused is a credential nobody revokes.
    mockRoutes({ [LIST]: () => json({ tokens: [token()] }) });
    renderPanel();

    expect(await screen.findByText('SCIM from Workday')).toBeInTheDocument();
    expect(screen.getByText(/last used 5 minutes ago/)).toBeInTheDocument();
  });

  it('says plainly when a token has never been used', async () => {
    mockRoutes({ [LIST]: () => json({ tokens: [token({ lastUsedAt: null })] }) });
    renderPanel();

    expect(await screen.findByText(/never used/)).toBeInTheDocument();
  });

  it('marks a token that never expires', async () => {
    // Allowed, and a choice somebody made rather than a default.
    mockRoutes({ [LIST]: () => json({ tokens: [token({ expiresAt: null })] }) });
    renderPanel();

    expect(await screen.findByText(/never expires/)).toBeInTheDocument();
  });

  it('never shows a token value in the list', async () => {
    mockRoutes({ [LIST]: () => json({ tokens: [token()] }) });
    renderPanel();

    await screen.findByText('SCIM from Workday');
    expect(screen.queryByText(/syntra_pat_/)).toBeNull();
  });

  it('shows a newly issued token once, and says it will not be shown again', async () => {
    granted.add('token.manage');
    mockRoutes({
      [LIST]: () => json({ tokens: [] }),
      // The POST goes to the same URL as the list.
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === 'POST') {
        return Promise.resolve(json({ id: 't-9', token: 'syntra_pat_abcdef' }, 201));
      }
      return Promise.resolve(json({ tokens: [] }));
    }) as never);
    renderPanel();

    await userEvent.type(await screen.findByLabelText(/new token/i), 'CI');
    await userEvent.click(screen.getByRole('button', { name: /issue/i }));

    expect(await screen.findByText('syntra_pat_abcdef')).toBeInTheDocument();
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
  });

  it('offers no issue or revoke control without token.manage', async () => {
    // Reading the list and minting a credential are different authorities,
    // and the console must not offer a control the API will refuse.
    granted.add('directory.write');
    mockRoutes({ [LIST]: () => json({ tokens: [token()] }) });
    renderPanel();

    await screen.findByText('SCIM from Workday');
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /issue/i })).toBeNull();
  });

  it('says so when a revoke fails rather than quietly leaving the row', async () => {
    granted.add('token.manage');
    mockRoutes({
      [LIST]: () => json({ tokens: [token()] }),
      '/api/admin/users/u-1/tokens/t-1': () => json({ title: 'nope' }, 404),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not be revoked/i),
    );
  });
});
