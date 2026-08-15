import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SourceDetailPage } from './SourceDetailPage.js';

const DEFAULTS = {
  flavours: {
    activeDirectory: [
      {
        objectType: 'user',
        sourceAttribute: 'sAMAccountName',
        targetField: 'login',
        transform: 'lowercase',
        isCorrelation: true,
      },
      {
        objectType: 'user',
        sourceAttribute: 'mail',
        targetField: 'email',
        transform: 'lowercase',
        isCorrelation: false,
      },
    ],
    openLdap: [
      {
        objectType: 'user',
        sourceAttribute: 'uid',
        targetField: 'login',
        transform: 'lowercase',
        isCorrelation: true,
      },
      {
        objectType: 'user',
        sourceAttribute: 'mail',
        targetField: 'email',
        transform: 'lowercase',
        isCorrelation: false,
      },
      {
        objectType: 'group',
        sourceAttribute: 'cn',
        targetField: 'name',
        transform: 'trim',
        isCorrelation: true,
      },
    ],
  },
  assignableFields: {
    user: ['login', 'email', 'displayName'],
    group: ['name', 'description'],
    orgUnit: ['name'],
  },
};

const savedSource = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Corporate LDAP',
  type: 'ldap',
  config: {
    url: 'ldaps://dc.acme.test:636',
    tlsMode: 'ldaps',
    rejectUnauthorized: true,
    bindDn: 'cn=svc,dc=acme,dc=test',
    userSearchBase: 'ou=people,dc=acme,dc=test',
    groupSearchBase: 'ou=groups,dc=acme,dc=test',
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(objectClass=groupOfNames)',
    orgUnitFilter: '(objectClass=organizationalUnit)',
    anchorAttribute: 'entryUUID',
    pageSize: 500,
  },
  schedule: '0 3 * * *',
  autoApply: false,
  enabled: true,
  deactivationThresholdPercent: 10,
  lastRunAt: null,
  owned: { users: 12, groups: 3, orgUnits: 2 },
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':
        status >= 400 ? 'application/problem+json' : 'application/json',
    },
  }) as never;

interface Routes {
  source?: Record<string, unknown>;
  mappings?: unknown[];
  onPost?(url: string, init: RequestInit): Response | undefined;
  onPatch?(url: string, init: RequestInit): Response | undefined;
}

function mockFetch(routes: Routes = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const request = (init ?? {}) as RequestInit;
    calls.push({ url, init: request });

    if (request.method === 'POST' && routes.onPost) {
      const answer = routes.onPost(url, request);
      if (answer) return Promise.resolve(answer as never);
    }
    if (request.method === 'PATCH' && routes.onPatch) {
      const answer = routes.onPatch(url, request);
      if (answer) return Promise.resolve(answer as never);
    }
    if (request.method === 'PUT') return Promise.resolve(json({ rules: [] }));
    if (request.method === 'DELETE') return Promise.resolve(json({}, 204));
    if (request.method === 'POST') return Promise.resolve(json({ id: 'new-id' }));

    // Reads. The static path has to be matched before the parametric one.
    if (url.includes('/sources/mapping-defaults')) {
      return Promise.resolve(json(DEFAULTS));
    }
    if (url.includes('/mappings')) {
      return Promise.resolve(json({ rules: routes.mappings ?? [] }));
    }
    if (url.includes('/sources/')) {
      return Promise.resolve(json(routes.source ?? savedSource()));
    }
    return Promise.resolve(json({}));
  });
  return calls;
}

const renderNew = () =>
  render(
    <MemoryRouter initialEntries={['/admin/sources/new']}>
      <Routes>
        <Route path="/admin/sources/new" element={<SourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/sources/s1']}>
      <Routes>
        <Route path="/admin/sources/:id" element={<SourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const bodyOf = (call: { init: RequestInit }) =>
  JSON.parse(String(call.init.body)) as Record<string, never>;

beforeEach(() => vi.restoreAllMocks());

describe('creating a source', () => {
  it('seeds the mapping table so the common case needs no typing', async () => {
    mockFetch();
    renderNew();

    // The OpenLDAP defaults, served by the API rather than duplicated here.
    expect(await screen.findByDisplayValue('uid')).toBeInTheDocument();
    expect(screen.getByDisplayValue('mail')).toBeInTheDocument();
  });

  it('reseeds both the mappings and the filters for Active Directory', async () => {
    // The stored userFilter default, (objectClass=person), matches every
    // computer account in an AD domain. Choosing the flavour has to fix the
    // filter as well as the attribute names, or the first run creates a user
    // per workstation.
    mockFetch();
    renderNew();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Active Directory' }),
    );

    expect(screen.getByDisplayValue('sAMAccountName')).toBeInTheDocument();
    expect(screen.getByLabelText('Anchor attribute')).toHaveValue('objectGUID');
    expect(screen.getByLabelText('User filter')).toHaveValue(
      '(&(objectCategory=person)(objectClass=user))',
    );
  });

  it('writes the mappings straight after the source they belong to', async () => {
    const calls = mockFetch();
    renderNew();

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme LDAP');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.init.method === 'PUT')).toBe(true),
    );
    const created = calls.find(
      (c) => c.init.method === 'POST' && c.url.endsWith('/sources'),
    )!;
    expect(bodyOf(created).name).toBe('Acme LDAP');
    expect(bodyOf(created).bindPassword).toBe('secret');

    const mapped = calls.find((c) => c.init.method === 'PUT')!;
    expect(mapped.url).toContain('/sources/new-id/mappings');
    expect(bodyOf(mapped).rules).toHaveLength(3);
  });

  it('carries the outcome across the move to the saved source', async () => {
    // The editor navigates from /sources/new to /sources/:id, and React keeps
    // the same component mounted across that move, so a message read only as
    // initial state is dropped exactly when it matters.
    mockFetch();
    render(
      <MemoryRouter initialEntries={['/admin/sources/new']}>
        <Routes>
          <Route path="/admin/sources/new" element={<SourceDetailPage />} />
          <Route path="/admin/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme LDAP');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/attribute mappings were saved/i),
    ).toBeInTheDocument();
  });

  it('says so, on the saved source, when the mappings were refused', async () => {
    // The source exists by then. Pretending otherwise would leave a source
    // that syncs nothing and says nothing about why.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const request = (init ?? {}) as RequestInit;
      if (request.method === 'PUT') {
        return Promise.resolve(
          json(
            {
              type: 'https://syntra.dev/problems/invalid-mappings',
              title: 'Invalid mappings',
              status: 400,
              detail: 'exactly one user mapping must be marked as the correlation key',
            },
            400,
          ),
        );
      }
      if (request.method === 'POST') return Promise.resolve(json({ id: 'new-id' }));
      if (url.includes('/sources/mapping-defaults')) {
        return Promise.resolve(json(DEFAULTS));
      }
      if (url.includes('/mappings')) return Promise.resolve(json({ rules: [] }));
      return Promise.resolve(json(savedSource()));
    });

    render(
      <MemoryRouter initialEntries={['/admin/sources/new']}>
        <Routes>
          <Route path="/admin/sources/new" element={<SourceDetailPage />} />
          <Route path="/admin/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme LDAP');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/attribute mappings were refused/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing will sync/i)).toBeInTheDocument();
  });

  it('puts a rejected cron expression on the schedule field, not in a banner', async () => {
    const calls = mockFetch({
      onPost: (url) =>
        url.endsWith('/sources')
          ? json(
              {
                type: 'https://syntra.dev/problems/validation-failed',
                title: 'Validation failed',
                status: 400,
                errors: [
                  {
                    path: 'schedule',
                    message:
                      'not a cron expression the scheduler can use: Invalid characters, got value: bogus',
                  },
                ],
              },
              400,
            )
          : undefined,
    });
    renderNew();

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.type(screen.getByLabelText('Schedule'), 'bogus');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const schedule = await screen.findByLabelText('Schedule');
    await waitFor(() => expect(schedule).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText(/not a cron expression/i)).toBeInTheDocument();
    // And no mappings were written for a source that was never created.
    expect(calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  it('marks the transport when the mode contradicts the URL scheme', async () => {
    mockFetch({
      onPost: (url) =>
        url.endsWith('/sources')
          ? json(
              {
                type: 'https://syntra.dev/problems/validation-failed',
                title: 'Validation failed',
                status: 400,
                errors: [
                  {
                    path: 'tlsMode',
                    message: 'tlsMode "ldaps" needs an ldaps:// URL',
                  },
                ],
              },
              400,
            )
          : undefined,
    });
    renderNew();

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/needs an ldaps:\/\/ URL/i),
    ).toBeInTheDocument();
  });
});

describe('the bind password', () => {
  it('is never rendered for a saved source', async () => {
    mockFetch();
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    const password = screen.getByLabelText('Bind password');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('type', 'password');
    expect(
      screen.getByText(/leave blank to keep the stored password/i),
    ).toBeInTheDocument();
  });

  it('is left out of an edit that did not change it', async () => {
    const calls = mockFetch();
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await waitFor(() =>
      calls.find((c) => c.init.method === 'PATCH')!,
    );
    expect(Object.keys(bodyOf(patch))).not.toContain('bindPassword');
  });

  it('is sent when it was retyped, and cleared from the form afterwards', async () => {
    const calls = mockFetch();
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    await userEvent.type(screen.getByLabelText('Bind password'), 'rotated');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await waitFor(() =>
      calls.find((c) => c.init.method === 'PATCH')!,
    );
    expect(bodyOf(patch).bindPassword).toBe('rotated');
    await waitFor(() =>
      expect(screen.getByLabelText('Bind password')).toHaveValue(''),
    );
  });
});

describe('editing a source', () => {
  it('shows the transport and the settings it was saved with', async () => {
    mockFetch();
    renderEdit();

    // The form renders blank and fills in when the source arrives, so wait
    // for the loaded name rather than for the control to exist.
    await screen.findByDisplayValue('Corporate LDAP');
    expect(screen.getByLabelText('Transport')).toHaveValue('ldaps');
    expect(screen.getByLabelText('Server URL')).toHaveValue(
      'ldaps://dc.acme.test:636',
    );
    expect(screen.getByLabelText('Schedule')).toHaveValue('0 3 * * *');
  });

  it('carries through a config key the form does not expose', async () => {
    // config is replaced whole on PATCH, so a field this editor has no
    // control for -- pageSize -- would be silently reset to its default by
    // anyone who saved the form.
    const calls = mockFetch();
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await waitFor(() =>
      calls.find((c) => c.init.method === 'PATCH')!,
    );
    expect((bodyOf(patch).config as unknown as { pageSize: number }).pageSize).toBe(
      500,
    );
  });

  it('clears the schedule rather than omitting it when the field is emptied', async () => {
    const calls = mockFetch();
    renderEdit();

    await screen.findByDisplayValue('0 3 * * *');
    await userEvent.clear(screen.getByLabelText('Schedule'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await waitFor(() =>
      calls.find((c) => c.init.method === 'PATCH')!,
    );
    expect(bodyOf(patch).schedule).toBeNull();
  });
});

describe('saving a mapping change', () => {
  const saved = [
    {
      objectType: 'user',
      sourceAttribute: 'uid',
      targetField: 'login',
      transform: 'lowercase',
      isCorrelation: true,
    },
  ];

  it('leaves the edited attribute on screen rather than redrawing the old one', async () => {
    // The screen used to revert to the mappings loaded when the page opened,
    // under a "Saved." message: the data was right and the display was wrong,
    // which is the one failure this product cannot afford.
    // A server that actually stores what it is sent, so a re-read returns the
    // edit. With the previous code the page never re-read the mappings at all
    // and redrew this array as it was at page load.
    let stored: unknown[] = saved;
    const written: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const request = (init ?? {}) as RequestInit;

      if (request.method === 'PUT') {
        const body = JSON.parse(String(request.body)) as { rules: unknown[] };
        written.push(...body.rules);
        stored = body.rules;
        // What the route returns: `mappingsFor` read back after the write.
        return Promise.resolve(json({ rules: stored }));
      }
      if (request.method === 'PATCH') return Promise.resolve(json({}));
      if (url.includes('/sources/mapping-defaults')) {
        return Promise.resolve(json(DEFAULTS));
      }
      if (url.includes('/mappings')) return Promise.resolve(json({ rules: stored }));
      return Promise.resolve(json(savedSource()));
    });

    renderEdit();

    const attribute = await screen.findByLabelText('Users directory attribute 1');
    await userEvent.clear(attribute);
    await userEvent.type(attribute, 'sAMAccountName');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(written).toHaveLength(1);
    expect(screen.getByLabelText('Users directory attribute 1')).toHaveValue(
      'sAMAccountName',
    );
  });

  it('re-reads the mappings after a save, not just the source', async () => {
    const calls = mockFetch({ mappings: saved });
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    const before = calls.filter(
      (c) => c.url.includes('/mappings') && c.init.method === undefined,
    ).length;

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const after = calls.filter(
        (c) => c.url.includes('/mappings') && c.init.method === undefined,
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe('testing the connection', () => {
  const result = {
    ok: true,
    message: 'Connected to ldap://dc.acme.test:389',
    sampleCounts: { user: 412, group: 22, orgUnit: 5 },
    schema: {
      objectClasses: ['groupOfNames', 'inetOrgPerson', 'organizationalUnit'],
      attributes: ['cn', 'entryUUID', 'mail', 'uid'],
    },
  };

  it('reports the counts and what the directory returned, before anything is saved', async () => {
    mockFetch({
      onPost: (url) => (url.endsWith('/sources/test') ? json(result) : undefined),
    });
    renderNew();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Test connection' }),
    );

    expect(await screen.findByText(/412/)).toBeInTheDocument();
    // Spec success criterion 1: report what object classes and attributes it
    // found. discoverSchema had no caller outside its own test before this.
    // Matched as the whole rendered list: "entryUUID" also appears in the
    // anchor attribute's hint, which is not what this is asserting.
    expect(
      screen.getByText('groupOfNames, inetOrgPerson, organizationalUnit'),
    ).toBeInTheDocument();
    expect(screen.getByText('cn, entryUUID, mail, uid')).toBeInTheDocument();
  });

  it('names the saved source instead of sending a password it was never given', async () => {
    const calls = mockFetch({
      onPost: (url) => (url.endsWith('/sources/test') ? json(result) : undefined),
    });
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    const test = await waitFor(() =>
      calls.find((c) => c.url.endsWith('/sources/test'))!,
    );
    expect(bodyOf(test).sourceId).toBe('s1');
    expect(Object.keys(bodyOf(test))).not.toContain('bindPassword');
  });

  it('reports a refused connection as a result, not as a page failure', async () => {
    mockFetch({
      onPost: (url) =>
        url.endsWith('/sources/test')
          ? json({
              ok: false,
              message: 'InvalidCredentialsError: 80090308: LdapErr',
              schema: null,
            })
          : undefined,
    });
    renderNew();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Test connection' }),
    );

    expect(await screen.findByText(/could not connect/i)).toBeInTheDocument();
    expect(screen.getByText(/InvalidCredentialsError/)).toBeInTheDocument();
  });
});

describe('deleting a source', () => {
  it('says how many accounts it will deactivate before offering the button', async () => {
    mockFetch();
    renderEdit();

    const panel = await screen.findByText(/this source owns/i);
    expect(panel).toHaveTextContent('12 users');
    expect(panel).toHaveTextContent('3 groups');
    expect(panel).toHaveTextContent('2 organizational units');
    expect(panel).toHaveTextContent(/deactivates every one of those/i);
  });

  it('keeps the button inert until the numbers are acknowledged', async () => {
    const calls = mockFetch();
    renderEdit();

    await screen.findByText(/this source owns/i);
    const remove = screen.getByRole('button', { name: 'Delete source' });
    expect(remove).toBeDisabled();

    // Every number the paragraph states, org units included.
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /12 users and 3 groups will be deactivated, and 2 units detached/i,
      }),
    );
    expect(remove).toBeEnabled();

    await userEvent.click(remove);
    const sent = await waitFor(
      () => calls.find((c) => c.init.method === 'DELETE')!,
    );
    expect(sent.url).toContain('confirm=true');
    // The figures that were on screen go with it, so the server can refuse if
    // they have moved since the page was read.
    expect(sent.url).toContain('ackUsers=12');
    expect(sent.url).toContain('ackGroups=3');
    expect(sent.url).toContain('ackOrgUnits=2');
  });

  it('asks again, with the real numbers, when they moved under the tick', async () => {
    const source = savedSource();
    let counts = { users: 12, groups: 3, orgUnits: 2 };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const request = (init ?? {}) as RequestInit;

      if (request.method === 'DELETE') {
        // A run landed between the page being read and the box being ticked.
        counts = { users: 1200, groups: 3, orgUnits: 2 };
        return Promise.resolve(
          json(
            {
              type: 'https://syntra.dev/problems/source-counts-changed',
              title: 'The numbers changed',
              status: 409,
              detail:
                'this source now owns 1200 user(s), 3 group(s) and 2 organizational unit(s), not the 12, 3 and 2 that were confirmed',
              owned: counts,
            },
            409,
          ),
        );
      }
      if (url.includes('/sources/mapping-defaults')) {
        return Promise.resolve(json(DEFAULTS));
      }
      if (url.includes('/mappings')) return Promise.resolve(json({ rules: [] }));
      return Promise.resolve(json({ ...source, owned: counts }));
    });

    renderEdit();
    await screen.findByText(/this source owns/i);
    const acknowledge = () =>
      screen.getByRole('checkbox', { name: /will be deactivated/i });
    await userEvent.click(acknowledge());
    await userEvent.click(screen.getByRole('button', { name: 'Delete source' }));

    expect(await screen.findByText(/now owns 1200/i)).toBeInTheDocument();
    // The tick is cleared and the panel redrawn with what is true now, so the
    // second decision is made on the real figure.
    expect(acknowledge()).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByText(/this source owns/i)).toHaveTextContent(
        '1200 users',
      ),
    );
    expect(screen.getByRole('button', { name: 'Delete source' })).toBeDisabled();
  });

  it('offers a plain delete when the source owns nothing', async () => {
    mockFetch({
      source: savedSource({ owned: { users: 0, groups: 0, orgUnits: 0 } }),
    });
    renderEdit();

    expect(
      await screen.findByText(/owns no users, groups or organizational units/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete source' })).toBeEnabled();
  });
});

describe('running a source by hand', () => {
  it('asks for a run and goes to the run it started', async () => {
    const calls = mockFetch({
      onPost: (url) =>
        url.endsWith('/run') ? json({ id: 'r9', status: 'previewed' }) : undefined,
    });
    renderEdit();

    await screen.findByDisplayValue('Corporate LDAP');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/sources/s1/run'))).toBe(true),
    );
  });

  it('is not offered for a source that has never been saved', async () => {
    mockFetch();
    renderNew();

    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });
});

describe('the correlation key', () => {
  it('states the rule the server enforces', async () => {
    mockFetch();
    renderNew();

    expect(
      await screen.findByText(/exactly one user mapping is the correlation key/i),
    ).toBeInTheDocument();
  });

  it('releases the previous one when another is chosen, so there is always exactly one', async () => {
    const calls = mockFetch();
    renderNew();

    const radios = await screen.findAllByRole('radio', {
      name: /correlate user records/i,
    });
    expect(radios[0]).toBeChecked();

    await userEvent.click(radios[1]!);
    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeChecked();

    await userEvent.type(screen.getByLabelText('Name'), 'Acme');
    await userEvent.type(screen.getByLabelText('Bind password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const mapped = await waitFor(() =>
      calls.find((c) => c.init.method === 'PUT')!,
    );
    const rules = bodyOf(mapped).rules as unknown as {
      objectType: string;
      isCorrelation: boolean;
    }[];
    expect(
      rules.filter((r) => r.objectType === 'user' && r.isCorrelation),
    ).toHaveLength(1);
  });
});
