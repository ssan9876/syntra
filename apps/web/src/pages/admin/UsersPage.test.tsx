import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { UsersPage } from './UsersPage.js';

// The page gates each tab on a permission, and `useCan` answers false when
// there is no provider — which is the right default for a control and the
// wrong one for a test, where it would hide all three tabs and leave nothing
// to assert against. Granting everything here keeps the subject of these
// tests the MERGE rather than the permission model, which has its own.
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => () => true,
}));

/**
 * The merge of Users and People.
 *
 * What is under test is the RELATIONSHIP between the two, because that is the
 * thing that used to be carried by three paragraphs of cross-referencing
 * prose. If "Awaiting an account" is wrong, the paragraphs were doing real
 * work and deleting them cost the reader something.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const PERSONS = [
  { id: 'p1', givenName: 'Andrew', familyName: 'Gray', businessEmail: 'ag@x.test', externalId: 'E1', status: 'active' },
  { id: 'p2', givenName: 'Marc', familyName: 'Puleo', businessEmail: 'mp@x.test', externalId: 'E2', status: 'active' },
  { id: 'p3', givenName: 'Kaycen', familyName: 'Tyre', businessEmail: 'kt@x.test', externalId: 'E3', status: 'active' },
];

const USERS = [
  { id: 'u1', login: 'agray', displayName: 'Andrew Gray', email: 'ag@x.test', status: 'active', statusReason: null, sourceId: null },
  { id: 'u2', login: 'mpuleo', displayName: 'Marc Puleo', email: 'mp@x.test', status: 'active', statusReason: null, sourceId: null, locked: true },
];

function mockApi(persons = PERSONS, users = USERS) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/api/admin/persons')) return Promise.resolve(json({ persons }));
    if (url.includes('/api/admin/users')) return Promise.resolve(json({ users }));
    if (url.includes('/api/admin/org-units')) return Promise.resolve(json({ orgUnits: [] }));
    if (url.includes('/api/admin/sources')) return Promise.resolve(json({ sources: [] }));
    return Promise.resolve(json({}));
  });
}

const show = (path = '/admin/users') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <UsersPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Users', () => {
  it('is one destination holding people, accounts and import', async () => {
    mockApi();
    show();
    await waitFor(() => expect(screen.getByRole('tab', { name: /People/ })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /Accounts/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Import/ })).toBeInTheDocument();
  });

  it('counts the joiners who have no account yet', async () => {
    // Three active people, two accounts. The one without is Kaycen Tyre, and
    // this figure is what replaced "their sign-in accounts are listed under
    // Users" — the split, stated as a number rather than a sentence.
    mockApi();
    show();
    await waitFor(() => expect(screen.getByText('Awaiting an account')).toBeInTheDocument());
    // The value sits immediately before its label inside the card.
    expect(screen.getByText('Awaiting an account').previousElementSibling).toHaveTextContent('1');
  });

  it('says nothing about awaiting accounts when everybody has one', async () => {
    // Quiet at zero. A permanent amber "0 awaiting" teaches the reader that
    // this row is decoration.
    mockApi(PERSONS.slice(0, 2));
    show();
    await waitFor(() => expect(screen.getByText('Awaiting an account')).toBeInTheDocument());
    const value = screen.getByText('Awaiting an account').previousElementSibling!;
    expect(value).toHaveTextContent('0');
    expect(value.className).toMatch(/text-muted/);
  });

  it('surfaces locked accounts without opening the accounts table', async () => {
    mockApi();
    show();
    await waitFor(() => expect(screen.getByText('Locked out')).toBeInTheDocument());
    expect(screen.getByText('Locked out').previousElementSibling).toHaveTextContent('1');
  });

  it('opens on people, which is where a joiner ticket starts', async () => {
    mockApi();
    show();
    await waitFor(() => expect(screen.getByRole('tab', { name: /People/ })).toHaveAttribute('aria-selected', 'true'));
  });

  it('opens on accounts when the URL says so, so the old link still works', async () => {
    mockApi();
    show('/admin/users?tab=accounts');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Accounts/ })).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('moves between the two without a page load', async () => {
    mockApi();
    show();
    await waitFor(() => expect(screen.getByText('Andrew Gray')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: /Accounts/ }));
    await waitFor(() => expect(screen.getByText('agray')).toBeInTheDocument());
  });

  it('survives a response that arrives without its collection', async () => {
    // The summary is the first thing painted on the console's front door. An
    // error document or a truncated proxy reply must read as zero, not take
    // the screen down.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json({})));
    show();
    await waitFor(() =>
      expect(screen.getByText('Awaiting an account').previousElementSibling).toHaveTextContent('0'),
    );
    expect(screen.getByRole('tab', { name: /People/ })).toBeInTheDocument();
  });
});
