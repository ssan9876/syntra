import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RolesPage } from './RolesPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const CATALOG = ['directory.read', 'deployment.manage', 'rbac.manage'];

const roles = [
  {
    id: 'r1',
    name: 'Owner',
    description: 'Full administrative access to this tenant.',
    permissions: ['directory.read', 'rbac.manage'],
    builtIn: true,
    assignmentCount: 1,
  },
];

function mockApi(over: { patch?: Response } = {}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'PATCH') return Promise.resolve(over.patch ?? json({}, 204));
      return Promise.resolve(json({}, 204));
    }
    if (url.includes('/api/admin/roles')) {
      return Promise.resolve(json({ catalog: CATALOG, roles }));
    }
    if (url.includes('/api/admin/users')) return Promise.resolve(json({ users: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <RolesPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the roles screen', () => {
  it('lists each role with its holder count', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByText(/1 holder/)).toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS. `deployment.manage` was added to the catalogue after
   * most installations were seeded, so their Owner does not hold it, the
   * Updates page is hidden and every update route answers 403. This checkbox
   * is the whole path back -- a permission in the catalogue and not on the
   * role has to be visible and grantable, not merely absent.
   */
  it('offers a catalogue permission the role does not hold, and grants it', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByText('Owner');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('group', { name: 'Permissions' });
    const box = within(editor).getByRole('checkbox', { name: /deployment\.manage/ });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.url).toContain('/api/admin/roles/r1');
    expect((sent[0]!.body as { permissions: string[] }).permissions).toEqual(
      expect.arrayContaining(['directory.read', 'rbac.manage', 'deployment.manage']),
    );
  });

  /**
   * The lockout guard's refusal is a sentence the reader can act on, and it
   * has to reach the screen. A 409 rendered as "something went wrong" would
   * leave somebody clicking Save again.
   */
  it('renders the server refusal when a change would strand rbac.manage', async () => {
    mockApi({
      patch: json(
        {
          type: 'https://syntra.dev/problems/would-strand-rbac',
          title: 'Cannot be saved',
          status: 409,
          detail:
            'That would leave nobody able to administer roles, and there is no way back from it but a database client. Give somebody else rbac.manage first.',
        },
        409,
      ),
    });
    renderPage();
    await screen.findByText('Owner');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/nobody able to administer roles/)).toBeInTheDocument();
  });

  /**
   * A built-in role's permissions are editable -- that is the entire point --
   * but deleting it is not. RoleAssignment cascades, and the backfill
   * migration targets exactly these rows.
   */
  it('does not offer Delete for a built-in role', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Owner');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
