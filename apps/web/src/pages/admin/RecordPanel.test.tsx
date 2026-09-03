import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RecordPanel } from './RecordPanel.js';
import { GroupsPage } from './GroupsPage.js';
import { OrgUnitsPage } from './OrgUnitsPage.js';
import { GroupDetailPage } from './GroupDetailPage.js';

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
    // The record screen's own reads. Editing moved off the list, so the form
    // under test is now opened on a screen that first fetches ONE group.
    if (url.includes('/members')) return Promise.resolve(json({ users: [] }));
    if (url.includes('/audit')) {
      return Promise.resolve(json({ events: [], chainValid: true }));
    }
    if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
    if (/\/groups\/[^/]+$/.test(url)) return Promise.resolve(json(groups[0]!));
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

/**
 * Editing, on the record screen it moved to.
 *
 * The form is the same `RecordPanel` in its controlled mode and these
 * assertions are unchanged; what moved is the screen they are made against. A
 * form opened from a table cell could never have room to say what it was about
 * to do, which is why the edit went to the record with everything else.
 *
 * The source-owned case is not repeated here — `GroupDetailPage.test.tsx`
 * makes it against the screen that decides it.
 */
const renderGroupRecord = () =>
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <Routes>
        <Route path="/admin/groups/:id" element={<GroupDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('editing a record that already exists', () => {
  it('opens with the current values and PATCHes the change', async () => {
    // Editing was missing for longer than creating was. A group named wrongly
    // had to be deactivated and replaced, which loses its memberships and its
    // assignments and leaves a permanent inactive row created by a typo.
    const writes = mockApi();
    renderGroupRecord();
    await screen.findByRole('heading', { name: 'Existing' });

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
    renderGroupRecord();
    await screen.findByRole('heading', { name: 'Existing' });
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
    renderGroupRecord();
    await screen.findByRole('heading', { name: 'Existing' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('group already exists: Payroll'),
    ).toBeInTheDocument();
  });
});

/**
 * Turning a refusal into a question.
 *
 * Rendered directly rather than through a page, unlike the tests above: this
 * is the contract of a shared primitive with eight consumers, and testing it
 * through one of them would tie the contract to that page's shape.
 */
describe('RecordPanel confirmable refusals', () => {
  const problemResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 409,
      headers: { 'content-type': 'application/problem+json' },
    });

  const SECOND_ACCOUNT = {
    type: 'https://syntra.dev/problems/second-account',
    title: 'They already have an account',
    status: 409,
    detail: 'Maya Okafor already signs in as mokafor.',
    existingAccount: { id: 'u9', login: 'mokafor' },
  };

  function renderPanel(
    confirmable: NonNullable<Parameters<typeof RecordPanel>[0]['confirmable']>,
    onCreated = vi.fn(),
  ) {
    render(
      <MemoryRouter>
        <RecordPanel
          title="New user"
          submitLabel="New user"
          path="/api/admin/users"
          onCreated={onCreated}
          build={(v) => ({ login: v.login ?? 'typed' })}
          confirmable={confirmable}
          fields={(v, set) => (
            <input
              aria-label="Login"
              value={v.login ?? ''}
              onChange={(e) => set('login', e.target.value)}
            />
          )}
        />
      </MemoryRouter>,
    );
    return onCreated;
  }

  it('puts focus in the first field when the form opens', async () => {
    // Opening the panel unmounts the button that opened it, so focus fell to
    // <body> and a keyboard reader had to tab from the top of the document to
    // reach the form they had just asked for.
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    expect(screen.getByLabelText('Login')).toHaveFocus();
  });

  it('puts focus back on the trigger when the form is cancelled', async () => {
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'New user' })).toHaveFocus();
  });

  const asksToConfirm = (problem: { type: string }) =>
    problem.type.endsWith('second-account')
      ? { message: 'They already have an account.', retryWith: { allowSecondAccount: true } }
      : null;

  it('offers Continue instead of an error, and re-posts with the flag', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(problemResponse(SECOND_ACCOUNT))
      .mockResolvedValueOnce(json({ id: 'u10' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    expect(
      await screen.findByText('They already have an account.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({
      login: 'typed',
      allowSecondAccount: true,
    });
  });

  it('does not resubmit until somebody confirms', async () => {
    const fetchMock = vi.fn().mockResolvedValue(problemResponse(SECOND_ACCOUNT));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await screen.findByText('They already have an account.');

    // The whole point is that somebody reads the warning and decides. A
    // confirmation that resubmits what it just refused is a 409 spelled
    // slowly.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps what was typed while the question is on screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(problemResponse(SECOND_ACCOUNT)),
    );
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.clear(screen.getByLabelText('Login'));
    await userEvent.type(screen.getByLabelText('Login'), 'ktyre');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    await screen.findByText('They already have an account.');
    expect(screen.getByLabelText('Login')).toHaveValue('ktyre');
  });

  it('falls through to the ordinary banner for a problem it does not claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse({
          type: 'https://syntra.dev/problems/conflict',
          title: 'Conflict',
          status: 409,
          detail: 'login already exists: mokafor',
        }),
      ),
    );
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    // A form may claim one problem type and leave every other refusal alone.
    expect(await screen.findByText(/login already exists/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
  });

  it('drops the question when the form is cancelled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(problemResponse(SECOND_ACCOUNT)),
    );
    renderPanel(asksToConfirm);

    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));
    await screen.findByText('They already have an account.');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryByText('They already have an account.'),
    ).not.toBeInTheDocument();
  });
});
