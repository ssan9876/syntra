import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GroupsPage } from './GroupsPage.js';
import { OrgUnitsPage } from './OrgUnitsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Records every write, so a test can assert on the BODY and not just the call. */
function mockApi(overrides: { post?: () => Response } = {}) {
  const writes: { url: string; method: string; body: unknown }[] = [];
  let groups: Record<string, unknown>[] = [
    { id: 'g1', name: 'Existing', description: null, status: 'active', statusReason: null, sourceId: null },
  ];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' || method === 'PATCH') {
      writes.push({ url, method, body: JSON.parse(String(init!.body)) });
      const response = overrides.post?.();
      if (response) return Promise.resolve(response);
      if (method === 'POST') {
        groups = [
          ...groups,
          { id: 'g2', name: 'Ward Nurses', description: null, status: 'active', statusReason: null, sourceId: null },
        ];
        return Promise.resolve(json({ id: 'g2' }, 201));
      }
      groups = groups.map((g) =>
        g.id === 'g1' ? { ...g, ...(writes.at(-1)!.body as object) } : g,
      );
      return Promise.resolve(json(groups[0]!));
    }
    if (url.includes('/org-units')) {
      return Promise.resolve(
        json({
          orgUnits: [
            { id: 'u1', name: 'Head Office', parentId: null, status: 'active', statusReason: null, sourceId: null },
          ],
        }),
      );
    }
    return Promise.resolve(json({ groups }));
  });
  return writes;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('creating from a directory listing page', () => {
  it('saves a group and shows it in the list without a reload', async () => {
    // These four pages were read-only: the API had POST /groups since Core and
    // no screen called it. This is the whole path — open the form, type, save,
    // and see the row — because a form that renders is not a form that saves.
    const posts = mockApi();
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');

    await userEvent.click(screen.getByRole('button', { name: 'New group' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ward Nurses');
    await userEvent.type(screen.getByLabelText('Description'), 'Clinical staff');
    await userEvent.click(screen.getByRole('button', { name: 'New group' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups');
    expect(posts[0]!.body).toEqual({ name: 'Ward Nurses', description: 'Clinical staff' });

    // The list re-reads rather than optimistically appending: what the server
    // stored is the truth.
    expect(await screen.findByText('Ward Nurses')).toBeInTheDocument();
  });

  it('omits an empty optional rather than sending an empty string', async () => {
    // `description` is optional in the schema, and '' is a description
    // somebody wrote. The same rule is what keeps `parentId` from being sent
    // as '', which the server rejects as a malformed uuid.
    const posts = mockApi();
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');

    await userEvent.click(screen.getByRole('button', { name: 'New group' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Payroll');
    await userEvent.click(screen.getByRole('button', { name: 'New group' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ name: 'Payroll' });
  });

  it('sends no parentId at all when the unit is top level', async () => {
    const posts = mockApi();
    render(
      <MemoryRouter>
        <OrgUnitsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Head Office');

    await userEvent.click(screen.getByRole('button', { name: 'New org unit' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Finance');
    await userEvent.click(screen.getByRole('button', { name: 'New org unit' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ name: 'Finance' });
    expect(Object.keys(posts[0]!.body as object)).not.toContain('parentId');
  });

  it('marks the offending field when the server refuses, not a banner', async () => {
    // A form-wide "invalid" leaves the reader hunting across four fields. The
    // API answers RFC 9457 with an `errors[]` carrying a path, and
    // `fieldErrors` puts each message against its own control.
    mockApi({
      post: () =>
        json(
          {
            type: 'https://syntra.dev/problems/validation',
            title: 'Validation failed',
            status: 400,
            errors: [{ path: 'name', message: 'A group with that name exists' }],
          },
          400,
        ),
    });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');

    await userEvent.click(screen.getByRole('button', { name: 'New group' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Existing');
    await userEvent.click(screen.getByRole('button', { name: 'New group' }));

    expect(await screen.findByText('A group with that name exists')).toBeInTheDocument();
    // The form stays open with the typed value intact — a refusal that clears
    // the box makes the reader retype what was nearly right.
    expect(screen.getByLabelText('Name')).toHaveValue('Existing');
  });
});

describe('editing a record that already exists', () => {
  it('opens with the current values and PATCHes the change', async () => {
    // Editing was missing for longer than creating was. A group named wrongly
    // had to be deactivated and replaced, which loses its memberships and its
    // assignments and leaves a permanent inactive row created by a typo.
    const writes = mockApi();
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Pre-filled, not blank. A form that opens empty invites somebody to
    // retype a name that was almost right.
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Existing');

    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.url).toContain('/api/admin/groups/g1');
    expect(writes[0]!.body).toEqual({ name: 'Renamed', description: null });
  });

  it('sends NULL for a cleared optional, not an omission', async () => {
    // In a PATCH, an omitted field means "leave alone". Omitting an emptied
    // description would silently keep the old one — the save would report
    // success and change nothing.
    const writes = mockApi();
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0]!.body as { description: unknown }).description).toBeNull();
  });

  it('marks the field when the server says the name is taken', async () => {
    mockApi({
      post: () =>
        json(
          {
            type: 'https://syntra.dev/problems/conflict',
            title: 'Conflict',
            status: 409,
            errors: [{ path: 'name', message: 'group already exists: Payroll' }],
          },
          409,
        ),
    });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Existing');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('group already exists: Payroll'),
    ).toBeInTheDocument();
  });

  it('offers no Edit for a source-owned group', async () => {
    // The API refuses it — the next sync run reads the name out of the
    // directory and would overwrite the change — so the control is absent
    // rather than present and rejected.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: [] }));
      return Promise.resolve(
        json({
          groups: [
            {
              id: 'g1',
              name: 'AD Nurses',
              description: null,
              status: 'active',
              statusReason: null,
              sourceId: 'src-1',
            },
          ],
        }),
      );
    });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('AD Nurses');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
