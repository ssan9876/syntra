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
  const posts: { url: string; body: unknown }[] = [];
  let groups = [{ id: 'g1', name: 'Existing', description: null }];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const response = overrides.post?.();
      if (response) return Promise.resolve(response);
      groups = [...groups, { id: 'g2', name: 'Ward Nurses', description: null }];
      return Promise.resolve(json({ id: 'g2' }, 201));
    }
    if (url.includes('/org-units')) {
      return Promise.resolve(json({ orgUnits: [{ id: 'u1', name: 'Head Office', parentId: null }] }));
    }
    return Promise.resolve(json({ groups }));
  });
  return posts;
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
