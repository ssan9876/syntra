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
    holders: [
      {
        userId: 'u1',
        login: 'ssander',
        displayName: 'Seth Sander',
        status: 'active',
        scopeOrgUnitId: null,
      },
    ],
  },
];

const USERS = [
  { id: 'u1', login: 'ssander', displayName: 'Seth Sander', status: 'active' },
  { id: 'u2', login: 'agray', displayName: 'Andrew Gray', status: 'active' },
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
    if (url.includes('/api/admin/users')) return Promise.resolve(json({ users: USERS }));
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

  it('names who holds the role rather than only counting them', async () => {
    mockApi();
    renderPage();

    // "1 holder" is not something anybody can revoke from. Until this, the
    // only way to find out WHO, or to take it off them, was a database client.
    expect(await screen.findByText('ssander')).toBeInTheDocument();
  });

  it('assigns the role to somebody who does not hold it', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Grant to someone' }));
    const picker = screen.getByLabelText('Account');
    // ssander already holds it: offering them again invites an assignment the
    // unique index refuses.
    expect(within(picker).queryByText('ssander')).not.toBeInTheDocument();
    await user.selectOptions(picker, 'u2');
    await user.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/api/admin/roles/r1/assignments'),
      body: { userId: 'u2' },
    });
  });

  it('revokes a holder, naming them in the confirmation', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke ssander' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: 'DELETE',
      url: expect.stringContaining('/api/admin/roles/r1/assignments/u1'),
    });
  });

  it('says so when everybody already holds the role', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(json({ users: [USERS[0]] }) as never);
      }
      return Promise.resolve(json({ catalog: CATALOG, roles }) as never);
    });
    renderPage();

    await screen.findByText('Owner');
    // Disabled with the reason beside it, rather than a control that opens
    // onto an empty picker.
    expect(
      screen.getByText(/everybody who can sign in already holds it/i),
    ).toBeInTheDocument();
    expect(user).toBeTruthy();
  });
});

/**
 * Creating one, which is the whole reason the screen exists for anybody who is
 * not repairing an upgraded Owner.
 *
 * `POST /api/admin/roles` was built, guarded, audited and tested on the server
 * and then never called: the console only ever PATCHed an id it already had,
 * so an installation had exactly the roles its seed wrote -- one -- and
 * "give the help desk read access and nothing else" was a database client.
 */
describe('creating a role', () => {
  const CREATE_CATALOG = [
    'directory.read',
    'directory.write',
    'directory.delete',
    'deployment.manage',
    'rbac.manage',
  ];

  function mockCreate() {
    const sent: { url: string; method: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        // The create route answers 201 with the row, unlike every other
        // mutation on this screen.
        if (method === 'POST' && !url.includes('/assignments')) {
          return Promise.resolve(json({ id: 'r2' }, 201) as never);
        }
        return Promise.resolve(json({}, 204) as never);
      }
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(json({ users: USERS }) as never);
      }
      return Promise.resolve(json({ catalog: CREATE_CATALOG, roles }) as never);
    });
    return sent;
  }

  it('posts a new role carrying only the permissions that were chosen', async () => {
    const user = userEvent.setup();
    const sent = mockCreate();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New role' }));
    await user.type(screen.getByLabelText('Name'), 'Help desk');
    await user.type(
      screen.getByLabelText('Description'),
      'Reads the directory. Changes nothing.',
    );

    const editor = screen.getByRole('group', { name: 'Permissions' });
    await user.click(within(editor).getByRole('checkbox', { name: /directory\.read/ }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
    // The collection, not a role's id: posting to `/roles/r1` would edit Owner.
    expect(sent[0]!.url).toMatch(/\/api\/admin\/roles$/);
    expect(sent[0]!.body).toEqual({
      name: 'Help desk',
      description: 'Reads the directory. Changes nothing.',
      permissions: ['directory.read'],
    });
  });

  /**
   * `roleBody` requires `.min(1)`: a role granting nothing is indistinguishable
   * from a mistake. Refused here rather than by a round trip, because the
   * reader can see the empty fieldset that caused it.
   */
  it('will not submit a role that grants nothing', async () => {
    const user = userEvent.setup();
    const sent = mockCreate();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New role' }));
    await user.type(screen.getByLabelText('Name'), 'Empty');

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(sent).toHaveLength(0);
  });

  /**
   * Twenty-four permissions as one flat list of dotted keys is a list you can
   * read but not choose from: building a narrow role means knowing from memory
   * that `directory.delete` is a separate right from `directory.write`. The
   * grouping is DERIVED from the prefix rather than mapped in this bundle --
   * the catalogue arrives from the server on every load precisely so no second
   * copy of it lives here, and a split on '.' cannot drift out of step.
   */
  it('groups the catalogue by module so a narrow set can be picked', async () => {
    const user = userEvent.setup();
    mockCreate();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New role' }));

    const directory = screen.getByRole('group', { name: 'directory' });
    expect(within(directory).getAllByRole('checkbox')).toHaveLength(3);
    expect(
      within(directory).getByRole('checkbox', { name: /directory\.delete/ }),
    ).toBeInTheDocument();

    // A module holding one permission still gets its heading; the alternative
    // is a rule about when grouping applies that the reader has to infer.
    const deployment = screen.getByRole('group', { name: 'deployment' });
    expect(within(deployment).getAllByRole('checkbox')).toHaveLength(1);
  });

  it('offers the create control from the empty state, which otherwise dead-ends', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(json({ users: USERS }) as never);
      }
      return Promise.resolve(json({ catalog: CREATE_CATALOG, roles: [] }) as never);
    });
    renderPage();

    expect(await screen.findByText('No roles yet')).toBeInTheDocument();
    // Two: the header's and the empty state's. Neither is the odd one out.
    expect(screen.getAllByRole('button', { name: 'New role' })).toHaveLength(2);
  });
});

/**
 * `description` is accepted by `roleBody`, stored by the API and returned by
 * the list query, and until now was set by nothing and shown nowhere. That is
 * survivable for one built-in role whose name says everything, and is not once
 * there are four narrow ones whose names do not.
 */
describe('a role description', () => {
  it('shows the description against the role it belongs to', async () => {
    mockApi();
    renderPage();
    expect(
      await screen.findByText('Full administrative access to this tenant.'),
    ).toBeInTheDocument();
  });

  it('carries the description through an edit', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPage();
    await screen.findByText('Owner');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const description = screen.getByLabelText('Description');
    expect(description).toHaveValue('Full administrative access to this tenant.');

    await user.clear(description);
    await user.type(description, 'Everything.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ description: 'Everything.' });
  });
});

/**
 * The account picker is fed by `/api/admin/users`, which is gated on
 * `directory.read` — a permission distinct from the `rbac.manage` that reaches
 * this screen at all. Holding one without the other is not hypothetical now
 * that narrow roles can be built here; an rbac-only role is among the first
 * things anybody would make.
 *
 * The empty list has TWO causes and they are opposites: everybody already
 * holds the role, or the caller cannot see who exists. Reporting the second as
 * the first states something false about the tenant and hides the only control
 * on the row.
 */
describe('when the caller cannot read the directory', () => {
  const forbid = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(
          json(
            {
              type: 'https://syntra.dev/problems/forbidden',
              title: 'Forbidden',
              status: 403,
            },
            403,
          ) as never,
        );
      }
      return Promise.resolve(json({ catalog: CATALOG, roles }) as never);
    });

  it('does not claim everybody already holds the role', async () => {
    forbid();
    renderPage();
    await screen.findByText('Owner');

    await waitFor(() =>
      expect(
        screen.queryByText(/everybody who can sign in already holds it/i),
      ).toBeNull(),
    );
  });

  it('names the permission the picker needs, so it can be asked for', async () => {
    forbid();
    renderPage();
    await screen.findByText('Owner');

    // Named, not merely refused. The reader cannot grant `directory.read` to
    // themselves, but they cannot ask for a thing they cannot name either —
    // and it is a literal row on this very screen, not jargon, to this reader.
    expect(await screen.findByText(/directory\.read/)).toBeInTheDocument();
  });

  it('still lets the role be revoked from somebody who holds it', async () => {
    const user = userEvent.setup();
    forbid();
    renderPage();

    // Revoking reads nothing from the directory: the holders travel with the
    // role. Losing that control along with the picker would make an
    // rbac-only role unable to undo its own grants.
    await user.click(await screen.findByRole('button', { name: 'Revoke ssander' }));
    expect(screen.getByText('ssander')).toBeInTheDocument();
  });
});
/**
 * Granting over one organizational unit rather than the whole tenant.
 *
 * `RoleAssignment.scopeOrgUnitId` has worked end to end since it was written
 * -- `hasPermission` honours it, and a scoped grant on a deactivated unit
 * stops counting -- and the console could only ever grant tenant-wide. The
 * holders it renders have carried `scopeOrgUnitId` the whole time and it was
 * dropped on the floor, so two grants to one person drew two identical rows
 * over a count that deduplicated them.
 */
describe('granting within one org unit', () => {
  const UNITS = [
    { id: 'ou1', name: 'Cardiology' },
    { id: 'ou2', name: 'Oncology' },
  ];

  /** A role held tenant-wide by one account and over Cardiology by another. */
  const scopedRoles = [
    {
      id: 'r1',
      name: 'Auditor',
      description: null,
      permissions: ['audit.read'],
      builtIn: false,
      assignmentCount: 2,
      holders: [
        {
          userId: 'u1',
          login: 'ssander',
          displayName: 'Seth Sander',
          status: 'active',
          scopeOrgUnitId: null,
        },
        {
          userId: 'u2',
          login: 'agray',
          displayName: 'Andrew Gray',
          status: 'active',
          scopeOrgUnitId: 'ou1',
        },
      ],
    },
  ];

  function mockScoped() {
    const sent: { url: string; method: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return Promise.resolve(json({}, 204) as never);
      }
      if (url.includes('/api/admin/org-units')) {
        return Promise.resolve(json({ orgUnits: UNITS }) as never);
      }
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(json({ users: USERS }) as never);
      }
      return Promise.resolve(json({ catalog: CATALOG, roles: scopedRoles }) as never);
    });
    return sent;
  }

  it('grants over the chosen unit rather than the whole tenant', async () => {
    const user = userEvent.setup();
    const sent = mockScoped();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Grant to someone' }));
    await user.selectOptions(screen.getByLabelText('Scope'), 'ou2');
    await user.selectOptions(screen.getByLabelText('Account'), 'u2');
    await user.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ userId: 'u2', scopeOrgUnitId: 'ou2' });
  });

  /**
   * Tenant-wide is the default and says what it DOES rather than what it is
   * called. "Unscoped" is a word about the data model; "Everywhere in this
   * tenant" is the consequence, and it is the whole of the explanation this
   * control needs.
   */
  it('grants tenant-wide by default, sending an explicit null', async () => {
    const user = userEvent.setup();
    const sent = mockScoped();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Grant to someone' }));
    expect(screen.getByLabelText('Scope')).toHaveDisplayValue('Everywhere in this tenant');
    await user.selectOptions(screen.getByLabelText('Account'), 'u2');
    await user.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // Null and not absent: the two readings of a missing field are "tenant-wide"
    // and "I forgot", which is the difference between one department and
    // everything.
    expect(sent[0]!.body).toEqual({ userId: 'u2', scopeOrgUnitId: null });
  });

  /**
   * The candidates depend on the scope. Somebody holding the role over
   * Cardiology is a perfectly good candidate for Oncology, and excluding them
   * on the strength of holding it somewhere makes the second grant
   * unreachable; offering them for Cardiology again invites the refusal of a
   * unique index.
   */
  it('offers an account that holds the role in a different unit', async () => {
    const user = userEvent.setup();
    mockScoped();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Grant to someone' }));
    const picker = screen.getByLabelText('Account');

    await user.selectOptions(screen.getByLabelText('Scope'), 'ou1');
    expect(within(picker).queryByText('agray')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Scope'), 'ou2');
    expect(within(picker).getByText('agray')).toBeInTheDocument();
  });

  it('names the unit a scoped holder holds it in', async () => {
    mockScoped();
    renderPage();

    await screen.findByText('agray');
    // Otherwise the two holders draw as one repeated login with no way to tell
    // which grant a Revoke would take.
    expect(screen.getByText('Cardiology')).toBeInTheDocument();
  });

  it('revokes one scope without touching the other', async () => {
    const user = userEvent.setup();
    const sent = mockScoped();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke agray in Cardiology' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('DELETE');
    expect(sent[0]!.url).toContain('/assignments/u2?scopeOrgUnitId=ou1');
  });

  it('revokes every scope when the holder is tenant-wide', async () => {
    const user = userEvent.setup();
    const sent = mockScoped();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke ssander' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // No query at all: the path alone has always meant every scope, and a
    // tenant-wide holder has exactly one.
    expect(sent[0]!.url).not.toContain('scopeOrgUnitId');
  });
});
