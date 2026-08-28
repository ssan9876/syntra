import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GroupDetailPage } from './GroupDetailPage.js';
import { OrgUnitDetailPage } from './OrgUnitDetailPage.js';
import { AccountDetailPage } from './AccountDetailPage.js';

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
  sourceId: null,
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
  // The record answers what is inside the unit; a unit with neither is the
  // ordinary case for these tests and has to read as empty rather than absent.
  parent: null,
  users: [],
  children: [],
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
    // BEFORE the `/users` branch, and matching the single-account path only:
    // `/api/admin/users/u1` contains `/users` too, and answering it with the
    // collection would give the account screen a body with no login in it.
    if (/\/users\/[^/]+$/.test(url)) {
      return Promise.resolve(json(rows.users?.[0] ?? {}));
    }
    // The same rule for the other two records, and for the same reason: a
    // single-record URL answered with its collection gives the screen a body
    // with no name in it.
    if (/\/groups\/[^/]+$/.test(url)) {
      return Promise.resolve(json(rows.groups?.[0] ?? {}));
    }
    if (/\/org-units\/[^/]+$/.test(url)) {
      return Promise.resolve(json(rows.orgUnits?.[0] ?? {}));
    }
    if (url.includes('/audit')) {
      return Promise.resolve(json({ events: [], chainValid: true }));
    }
    if (url.includes('/members')) return Promise.resolve(json({ users: rows.members ?? [] }));
    if (url.includes('/groups')) return Promise.resolve(json({ groups: rows.groups ?? [] }));
    if (url.includes('/users')) return Promise.resolve(json({ users: rows.users ?? [] }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: rows.orgUnits ?? [] }));
    if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
    return Promise.resolve(json({}));
  });
  return posts;
}

/**
 * The account's own screen, which is where the toggle for an account lives.
 *
 * It used to be rendered here through `AccountsTab`, because a row was the
 * only place an account could be acted on. Both assertions are unchanged --
 * what moved is the screen they are made against.
 */
// No `useCan` stub: with no provider it answers false, so the account screen
// offers no Delete — which is what these tests want anyway, and what the org
// unit case in this same file relies on.
const renderAccount = () =>
  render(
    <MemoryRouter initialEntries={['/admin/users/u1']}>
      <Routes>
        <Route path="/admin/users/:id" element={<AccountDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

/**
 * The group's and the unit's own screens, for the same reason as the account's.
 *
 * These assertions used to be made against `GroupsPage` and `OrgUnitsPage`,
 * because a row was the only place either could be acted on. What moved is the
 * screen they are made against; what they assert is unchanged.
 */
const renderGroup = () =>
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <Routes>
        <Route path="/admin/groups/:id" element={<GroupDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const renderUnit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/org-units/o1']}>
      <Routes>
        <Route path="/admin/org-units/:id" element={<OrgUnitDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

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
    renderGroup();
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
    renderGroup();
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
    renderGroup();
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'changed my mind');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('shows an inactive group WITH its reason, and the way back', async () => {
    mockApi({ groups: [group({ status: 'inactive', statusReason: 'team disbanded' })] });
    renderGroup();

    // Still readable — hiding a deactivated group would make the directory
    // unauditable. The record states the status and the reason as two facts
    // rather than one run-together label, which is the list's job.
    expect(await screen.findByRole('heading', { name: 'Ward Nurses' })).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('team disbanded')).toBeInTheDocument();
    // And the way back is offered.
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('reactivates without asking for a reason', async () => {
    const posts = mockApi({ groups: [group({ status: 'inactive' })] });
    renderGroup();
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
    renderAccount();
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
    renderAccount();
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
    renderUnit();
    await screen.findByText('Care');

    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'department closed');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/org-units/o1/deactivate');
    expect(posts[0]!.body).toEqual({ reason: 'department closed' });
  });

  it('shows an inactive unit WITH its reason, and the way back', async () => {
    mockApi({ orgUnits: [orgUnit({ status: 'inactive', statusReason: 'restructure' })] });
    renderUnit();

    // A deactivated unit keeps its name, its place in the tree and the users
    // sitting in it; hiding it would lose the shape of the organization and
    // leave the users inside it apparently nowhere.
    expect(await screen.findByRole('heading', { name: 'Care' })).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('restructure')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('offers the control on a unit that has a parent, too', async () => {
    // The two tree levels were written out twice, and the first version of the
    // change that added this control put it on the parent only. One record
    // screen for both depths is what retires that class of bug -- this asserts
    // the depth makes no difference to what is offered.
    mockApi({
      orgUnits: [
        orgUnit({
          id: 'o2',
          name: 'Ward B',
          parentId: 'o1',
          parent: { id: 'o1', name: 'Care' },
        }),
      ],
    });
    render(
      <MemoryRouter initialEntries={['/admin/org-units/o2']}>
        <Routes>
          <Route path="/admin/org-units/:id" element={<OrgUnitDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Ward B' });
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('refuses to offer it for a source-owned unit', async () => {
    // The next sync run reads the unit as present in the directory and puts it
    // back, so the button would appear to work and then quietly undo itself.
    mockApi({ orgUnits: [orgUnit({ sourceId: 'src-1' })] });
    renderUnit();
    await screen.findByText('Care');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(
      screen.getByText(/owns this unit, and the next sync run would put it back/),
    ).toBeInTheDocument();
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
    renderGroup();
    await screen.findByText('Ward Nurses');

    expect(await screen.findByText(/Nobody is in this group/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Add a member'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/members/u1');
  });

  it('removes one', async () => {
    const posts = mockApi({ groups: [group()], users: [user()], members: [user()] });
    renderGroup();
    await screen.findByText('Ward Nurses');

    // Membership is the record's own panel now, not one opened from a cell.
    await screen.findAllByText('mokafor');
    await userEvent.click(screen.getByRole('button', { name: 'Remove from group' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/members/u1');
  });
});
