import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { UnlinkedAccountsPage } from './UnlinkedAccountsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const confidentRow = {
  id: 'u1',
  login: 'mokafor',
  displayName: 'Maya Okafor',
  email: 'maya@acme.test',
  topCandidate: {
    personId: 'p1',
    givenName: 'Maya',
    familyName: 'Okafor',
    rule: 'businessEmail',
    hasActiveAccount: false,
  },
};

const weakRow = {
  id: 'u2',
  login: 'ktyre',
  displayName: 'Kaycen Tyre',
  email: 'kaycen@gmail.test',
  topCandidate: {
    personId: 'p2',
    givenName: 'Kaycen',
    familyName: 'Tyre',
    rule: 'personalEmail',
    hasActiveAccount: false,
  },
};

const serviceRow = {
  id: 'u3',
  login: 'svc-backup',
  displayName: 'Backup',
  email: 'svc@acme.test',
  topCandidate: null,
};

/** Serves the list, and records every link written. */
function mockUnlinked(accounts: Record<string, unknown>[]) {
  const links: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if ((init?.method ?? 'GET') !== 'GET') {
      links.push({ url, body: JSON.parse(String(init!.body)) });
      return Promise.resolve(json({ ok: true }));
    }
    return Promise.resolve(json({ accounts }));
  }) as typeof fetch);
  return links;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <UnlinkedAccountsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('UnlinkedAccountsPage', () => {
  it('names both sides on the link button', async () => {
    mockUnlinked([confidentRow]);
    renderPage();

    // A table of identical "Link" buttons is announced one after another with
    // no way to tell the rows apart.
    expect(
      await screen.findByRole('button', { name: /link mokafor to Maya Okafor/i }),
    ).toBeInTheDocument();
  });

  it('links one account from the list', async () => {
    const links = mockUnlinked([confidentRow]);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /link mokafor to Maya Okafor/i }),
    );

    await waitFor(() => expect(links).toHaveLength(1));
    expect(links[0]!.url).toContain('/api/admin/persons/p1/link-user');
    expect(links[0]!.body).toEqual({ userId: 'u1' });
  });

  it('lists a service account with no suggestion rather than hiding it', async () => {
    mockUnlinked([serviceRow]);
    renderPage();

    // Hiding it would make the count irreconcilable with the accounts table.
    expect(await screen.findByText('svc-backup')).toBeInTheDocument();
    expect(screen.getByText(/nobody obvious/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^link /i })).not.toBeInTheDocument();
  });

  it('offers the bulk action only for confident rows, and counts them', async () => {
    mockUnlinked([confidentRow, weakRow, serviceRow]);
    renderPage();

    // One of the three qualifies: a work-email match to somebody with no
    // account. The other two are rows somebody looks at.
    expect(
      await screen.findByRole('button', { name: /link all 1 confident/i }),
    ).toBeInTheDocument();
  });

  it('does not offer the bulk action when nothing is confident', async () => {
    mockUnlinked([weakRow, serviceRow]);
    renderPage();

    await screen.findByText('ktyre');
    expect(
      screen.queryByRole('button', { name: /link all/i }),
    ).not.toBeInTheDocument();
  });

  it('does not treat a confident match who already signs in as bulk-linkable', async () => {
    mockUnlinked([
      {
        ...confidentRow,
        topCandidate: { ...confidentRow.topCandidate, hasActiveAccount: true },
      },
    ]);
    renderPage();

    await screen.findByText('mokafor');
    // That is the second-account case, which is a decision and not a chore.
    expect(
      screen.queryByRole('button', { name: /link all/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/already has an account/i)).toBeInTheDocument();
  });

  it('links every confident row in one press', async () => {
    const links = mockUnlinked([
      confidentRow,
      {
        ...confidentRow,
        id: 'u4',
        login: 'sroe',
        topCandidate: { ...confidentRow.topCandidate, personId: 'p4' },
      },
      weakRow,
    ]);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /link all 2 confident/i }),
    );

    await waitFor(() => expect(links).toHaveLength(2));
    expect(links.map((l) => l.url)).toEqual([
      expect.stringContaining('/persons/p1/link-user'),
      expect.stringContaining('/persons/p4/link-user'),
    ]);
  });

  it('says so when there is no backlog', async () => {
    mockUnlinked([]);
    renderPage();

    expect(
      await screen.findByText(/every account has a person/i),
    ).toBeInTheDocument();
  });

  it('reports a failed link rather than silently reloading', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        return Promise.resolve(
          json(
            {
              type: 'https://syntra.dev/problems/conflict',
              title: 'Conflict',
              status: 409,
              detail: 'that person already has this account',
            },
            409,
          ),
        );
      }
      return Promise.resolve(json({ accounts: [confidentRow] }));
    }) as typeof fetch);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /link mokafor to Maya Okafor/i }),
    );

    expect(
      await screen.findByText(/already has this account/i),
    ).toBeInTheDocument();
  });
});
