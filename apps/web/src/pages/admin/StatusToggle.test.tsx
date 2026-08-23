import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GroupsPage } from './GroupsPage.js';
import { UsersPage } from './UsersPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  name: 'Ward Nurses',
  description: null,
  status: 'active',
  statusReason: null,
  ...over,
});

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  login: 'mokafor',
  displayName: 'Maya Okafor',
  email: 'm@acme.test',
  status: 'active',
  statusReason: null,
  sourceId: null,
  ...over,
});

function mockApi(rows: { groups?: unknown[]; users?: unknown[] }) {
  const posts: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(json({}));
    }
    if (url.includes('/groups')) return Promise.resolve(json({ groups: rows.groups ?? [] }));
    if (url.includes('/users')) return Promise.resolve(json({ users: rows.users ?? [] }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: [] }));
    if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
    return Promise.resolve(json({}));
  });
  return posts;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deactivate, never delete', () => {
  it('offers Deactivate — never Delete — and sends the typed reason', async () => {
    // Deleting a group revokes access from everybody in it and takes the record
    // of who had what with it. The specs say "Deactivation never deletes", and
    // the absence of a Delete control is what makes that true in the product
    // rather than only in the document.
    const posts = mockApi({ groups: [group()] });
    vi.stubGlobal('prompt', vi.fn(() => 'left the ward'));
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/deactivate');
    expect(posts[0]!.body).toEqual({ reason: 'left the ward' });
  });

  it('sends nothing at all when the reason is cancelled', async () => {
    // A blank reason must abandon the action rather than post one the server
    // rejects — a refusal after the fact reads as a broken button.
    const posts = mockApi({ groups: [group()] });
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(posts).toHaveLength(0);
  });

  it('shows an inactive group WITH its reason, still listed', async () => {
    mockApi({ groups: [group({ status: 'inactive', statusReason: 'team disbanded' })] });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );

    // Still on the page — hiding it would make the directory unauditable.
    expect(await screen.findByText('Ward Nurses')).toBeInTheDocument();
    expect(screen.getByText(/inactive — team disbanded/)).toBeInTheDocument();
    // And the way back is offered.
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('reactivates without asking for a reason', async () => {
    const posts = mockApi({ groups: [group({ status: 'inactive' })] });
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/reactivate');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses to offer the control for a source-owned account', async () => {
    // The next sync run reads the account as present in the directory and
    // proposes reactivating it, so the button would appear to work and then
    // quietly undo itself. Saying who owns the account is the honest answer.
    mockApi({ users: [user({ sourceId: 'src-1' })] });
    render(
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>,
    );
    await screen.findByText('mokafor');

    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByText('managed by a directory source')).toBeInTheDocument();
  });

  it('offers it for a locally managed account', async () => {
    mockApi({ users: [user()] });
    render(
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>,
    );
    await screen.findByText('mokafor');
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});
