import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GroupsPage } from './GroupsPage.js';
import { OrgUnitsPage } from './OrgUnitsPage.js';
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

const orgUnit = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  name: 'Care',
  parentId: null,
  status: 'active',
  statusReason: null,
  sourceId: null,
  ...over,
});

function mockApi(rows: {
  groups?: unknown[];
  users?: unknown[];
  orgUnits?: unknown[];
  members?: unknown[];
}) {
  const posts: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(json({}));
    }
    // BEFORE the `/groups` branch: a members URL contains `/groups` too, and
    // answering it with the group list would look like an empty membership.
    if (url.includes('/members')) return Promise.resolve(json({ users: rows.members ?? [] }));
    if (url.includes('/groups')) return Promise.resolve(json({ groups: rows.groups ?? [] }));
    if (url.includes('/users')) return Promise.resolve(json({ users: rows.users ?? [] }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: rows.orgUnits ?? [] }));
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
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    // The reason is asked for IN THE PAGE. `window.prompt` blocks the tab and
    // returns null for ever once a browser has been told to stop the page
    // opening dialogs — which made this button silently do nothing.
    await userEvent.type(screen.getByLabelText('Reason'), 'left the ward');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/deactivate');
    expect(posts[0]!.body).toEqual({ reason: 'left the ward' });
  });

  it('will not send until a reason is typed', async () => {
    // A blank reason must not be postable. Sending one and letting the server
    // refuse it reads as a broken button.
    const posts = mockApi({ groups: [group()] });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();

    // Whitespace is not a reason either.
    await userEvent.type(screen.getByLabelText('Reason'), '   ');
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it('sends nothing at all when the reason is cancelled', async () => {
    const posts = mockApi({ groups: [group()] });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'changed my mind');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Reason')).toBeNull();
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
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/reactivate');
    // Putting access back needs no justification; taking it away does.
    expect(screen.queryByLabelText('Reason')).toBeNull();
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
    // Since write-back, the copy names the owner and the setting; with no
    // readable sources the page falls back to "A directory source".
    expect(
      screen.getByText(/owns this account, and write-back is off/),
    ).toBeInTheDocument();
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

describe('org units, the last part of the directory to get this', () => {
  it('deactivates a unit with a reason and never offers Delete', async () => {
    // Deleting a unit takes the record of who was in it, drops every
    // application assignment made on it, and orphans any administrative role
    // scoped to it. There was no way to retire one at all until now — the
    // column did not exist.
    const posts = mockApi({ orgUnits: [orgUnit()] });
    render(
      <MemoryRouter>
        <OrgUnitsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Care');

    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'department closed');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/org-units/o1/deactivate');
    expect(posts[0]!.body).toEqual({ reason: 'department closed' });
  });

  it('shows an inactive unit WITH its reason, still in the tree', async () => {
    mockApi({ orgUnits: [orgUnit({ status: 'inactive', statusReason: 'restructure' })] });
    render(
      <MemoryRouter>
        <OrgUnitsPage />
      </MemoryRouter>,
    );

    // Still in the tree — hiding it would lose the shape of the organization
    // and leave the users inside it apparently nowhere.
    expect(await screen.findByText('Care')).toBeInTheDocument();
    expect(screen.getByText(/inactive — restructure/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('offers the control on a CHILD unit too', async () => {
    // The two tree levels were written out twice, and the first version of
    // this change put the control on the parent only.
    mockApi({
      orgUnits: [orgUnit(), orgUnit({ id: 'o2', name: 'Ward B', parentId: 'o1' })],
    });
    render(
      <MemoryRouter>
        <OrgUnitsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward B');
    expect(screen.getAllByRole('button', { name: 'Deactivate' })).toHaveLength(2);
  });

  it('refuses to offer it for a source-owned unit', async () => {
    // The next sync run reads the unit as present in the directory and puts it
    // back, so the button would appear to work and then quietly undo itself.
    mockApi({ orgUnits: [orgUnit({ sourceId: 'src-1' })] });
    render(
      <MemoryRouter>
        <OrgUnitsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Care');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByText('managed by a directory source')).toBeInTheDocument();
  });
});

describe('group membership', () => {
  /**
   * `GET`, `POST` and `DELETE /groups/:id/members` all existed and the groups
   * page showed no members at all -- so the one thing a group is for could
   * only be done through the API.
   */
  it('lists members and adds one', async () => {
    const posts = mockApi({ groups: [group()], users: [user()], members: [] });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText(/Nobody is in this group yet/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Add a member'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/members/u1');
  });

  it('removes one', async () => {
    const posts = mockApi({ groups: [group()], users: [user()], members: [user()] });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    // 'mokafor' is both the member row and an option in the add picker.
    await screen.findAllByText('mokafor');
    await userEvent.click(screen.getByRole('button', { name: 'Remove from group' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/members/u1');
  });
});
