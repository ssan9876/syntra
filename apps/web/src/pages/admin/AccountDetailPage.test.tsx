import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AccountDetailPage } from './AccountDetailPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const ACCOUNT = {
  id: 'u1',
  login: 'jdoe',
  displayName: 'J Doe',
  email: 'j@acme.test',
  status: 'active',
  statusReason: null,
  sourceId: null,
  passwordSource: 'local',
  personId: 'p1',
  person: { id: 'p1', givenName: 'Jo', familyName: 'Doe' },
  locked: false,
};

const SOURCES = [
  {
    id: 's1',
    name: 'Corporate LDAP',
    writebackEnabled: true,
    writebackDisable: true,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

/**
 * Routes the stubbed fetch by path, like the person page's tests.
 *
 * This screen reads three resources and writes to five endpoints, so a blanket
 * `mockResolvedValue` would answer a POST with the account body and hide
 * whatever the button actually sent.
 */
function mockApi(
  account: Record<string, unknown> = ACCOUNT,
  overrides: Record<string, (url: string, init?: RequestInit) => Response> = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Promise.resolve(handler(url, init));
    }
    if (url.includes('/sources')) return Promise.resolve(json({ sources: SOURCES }));
    if (url.includes('/audit')) {
      return Promise.resolve(json({ events: [], chainValid: true }));
    }
    return Promise.resolve(json(account));
  }) as typeof fetch);
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/users/u1']}>
      <Routes>
        <Route path="/admin/users/:id" element={<AccountDetailPage />} />
        <Route path="/admin/users" element={<div>the accounts list</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
  granted.add('directory.read');
  granted.add('directory.write');
  granted.add('audit.read');
});

describe('AccountDetailPage', () => {
  it('reads the one account rather than the whole directory', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'J Doe' });
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/api/admin/users/u1')),
    ).toBe(true);
  });

  it('identifies the account by its login and email', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('jdoe')).toBeInTheDocument();
    expect(screen.getByText('j@acme.test')).toBeInTheDocument();
  });

  it("says when the org unit is inherited from the linked person", async () => {
    // App access follows the person's unit when the account has none, and an
    // administrator reading "None" would have no way to see why IT's
    // applications apply.
    mockApi({
      ...ACCOUNT,
      orgUnitId: null,
      effectiveOrgUnit: { id: 'ou1', name: 'IT', source: 'person' },
    });
    renderPage();
    expect(await screen.findByText('IT (from the linked person)')).toBeInTheDocument();
  });

  it("shows the account's own org unit plainly, and None when there is none", async () => {
    mockApi({
      ...ACCOUNT,
      orgUnitId: 'ou2',
      effectiveOrgUnit: { id: 'ou2', name: 'Ops', source: 'account' },
    });
    const { unmount } = renderPage();
    expect(await screen.findByText('Ops')).toBeInTheDocument();
    unmount();

    mockApi({ ...ACCOUNT, orgUnitId: null, effectiveOrgUnit: null });
    renderPage();
    await screen.findByText('jdoe');
    expect(screen.getByText('Org unit').parentElement).toHaveTextContent('None');
  });

  /**
   * The cross-link that replaces the paragraph. Users is one screen showing two
   * subjects, and a person named here with no way to reach them would put the
   * split back as a sentence.
   */
  it('links back to the person behind the account, by name', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Jo Doe' });
    expect(link).toHaveAttribute('href', '/admin/people/p1');
  });

  it('unlinks the account from its person after asking once', async () => {
    granted.add('identity.write');
    const unlinked = vi.fn((_url: string, _init?: RequestInit) => new Response(null, { status: 204 }) as never);
    mockApi(ACCOUNT, { '/unlink-user': unlinked });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(unlinked).not.toHaveBeenCalled();
    expect(screen.getByText(/their leaver no longer disables it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Unlink jdoe' }));
    await waitFor(() => expect(unlinked).toHaveBeenCalled());
    expect(unlinked.mock.calls[0]![0]).toContain('/api/admin/persons/p1/unlink-user');
    expect(JSON.parse(String(unlinked.mock.calls[0]![1]!.body))).toEqual({ userId: 'u1' });
  });

  it('offers no unlink without identity.write', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('link', { name: 'Jo Doe' });
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  it('says so when no person owns the account', async () => {
    mockApi({ ...ACCOUNT, personId: null, person: null });
    renderPage();

    await screen.findByRole('heading', { name: 'J Doe' });
    expect(screen.queryByRole('link', { name: 'Jo Doe' })).not.toBeInTheDocument();
    expect(screen.getByText(/not linked/i)).toBeInTheDocument();
  });

  it('names the directory that owns a synced account', async () => {
    mockApi({ ...ACCOUNT, sourceId: 's1' });
    renderPage();

    expect(await screen.findByText('Corporate LDAP')).toBeInTheDocument();
  });

  describe('editing', () => {
    it('saves the display name and email', async () => {
      const patched = vi.fn((_url: string, _init?: RequestInit) =>
        json({ ...ACCOUNT, displayName: 'Jo Doe' }),
      );
      mockApi(ACCOUNT, { '/details': patched });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      await userEvent.click(screen.getByRole('button', { name: /edit/i }));
      const name = screen.getByLabelText(/display name/i);
      await userEvent.clear(name);
      await userEvent.type(name, 'Jo Doe');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(patched).toHaveBeenCalled());
      const body = JSON.parse(String(patched.mock.calls[0]![1]!.body));
      expect(body.displayName).toBe('Jo Doe');
    });

    /**
     * A directory owns the login, name and email of an account it syncs, and
     * rewrites them on every run. Offering the form would be offering a change
     * that is silently undone.
     */
    it('offers no edit form for an account a directory owns', async () => {
      mockApi({ ...ACCOUNT, sourceId: 's1' });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    });
  });

  describe('locked out', () => {
    it('offers no unlock while the account is not locked', async () => {
      mockApi();
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
    });

    it('unlocks a locked account and reloads it', async () => {
      const unlocked = vi.fn((_url: string, _init?: RequestInit) => json({}));
      mockApi({ ...ACCOUNT, locked: true }, { '/unlock': unlocked });
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /unlock/i }));

      await waitFor(() => expect(unlocked).toHaveBeenCalled());
      expect(unlocked.mock.calls[0]![1]!.method).toBe('POST');
    });

    it('reports a failed unlock rather than appearing to succeed', async () => {
      mockApi(
        { ...ACCOUNT, locked: true },
        {
          '/unlock': () =>
            json({ title: 'Nope', detail: 'That account could not be unlocked.' }, 500),
        },
      );
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /unlock/i }));

      expect(
        await screen.findByText(/could not be unlocked/i),
      ).toBeInTheDocument();
    });
  });

  describe('password setup link', () => {
    it('shows the generated link without following it', async () => {
      mockApi(ACCOUNT, {
        '/password-setup': () =>
          json({
            url: 'https://acme.test/reset-password?token=abc',
            expiresAt: '2026-08-28T00:00:00.000Z',
          }),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      await userEvent.click(screen.getByRole('button', { name: /password link/i }));

      // A read-only input, never an anchor: an administrator who clicks a link
      // to check it spends the one-time token.
      const field = await screen.findByLabelText(/password setup link/i);
      expect(field).toHaveValue('https://acme.test/reset-password?token=abc');
      expect(
        screen.queryByRole('link', { name: /reset-password/ }),
      ).not.toBeInTheDocument();
    });

    it('offers nothing for an account whose password lives elsewhere', async () => {
      mockApi({ ...ACCOUNT, passwordSource: 'upstream' });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      expect(
        screen.queryByRole('button', { name: /password link/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('second factors', () => {
    it('removes a factor and says what went with it', async () => {
      const removed = vi.fn((_url: string, _init?: RequestInit) =>
        json({ recoveryCodesRevoked: 3 }),
      );
      mockApi(ACCOUNT, { '/factors/': removed });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      await userEvent.click(
        screen.getByRole('button', { name: /remove authenticator app/i }),
      );

      await waitFor(() => expect(removed).toHaveBeenCalled());
      expect(String(removed.mock.calls[0]![0])).toContain('/factors/totp');
      // The count is said, because taking the last factor takes the printed
      // recovery codes with it and nothing else tells their owner.
      expect(await screen.findByText(/3 unused recovery codes/i)).toBeInTheDocument();
    });
  });

  describe('status', () => {
    it('names what deactivating a local account does', async () => {
      mockApi();
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /deactivate/i }));
      expect(screen.getByText(/every session and refresh token is revoked/i)).toBeInTheDocument();
    });

    /**
     * Write-back off means a status changed here is undone by the next run.
     * Naming the source and the setting is the difference between a dead end
     * and something an administrator can act on.
     */
    it('refuses to offer deactivation where write-back is off', async () => {
      mockApi({ ...ACCOUNT, sourceId: 's2' });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      expect(
        screen.queryByRole('button', { name: /deactivate/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/write-back is off/i)).toBeInTheDocument();
    });
  });

  describe('deletion', () => {
    it('is not offered without directory.delete', async () => {
      mockApi();
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    });

    it('returns to the list once the account is gone', async () => {
      granted.add('directory.delete');
      mockApi(ACCOUNT, {
        '/api/admin/users/u1': (_url, init) =>
          init?.method === 'DELETE' ? json({}) : json(ACCOUNT),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'J Doe' });
      await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
      await userEvent.type(screen.getByLabelText(/type jdoe/i), 'jdoe');
      await userEvent.click(
        screen.getByRole('button', { name: /^delete user$/i }),
      );

      // Staying on the screen for a record that no longer exists would leave
      // the reader looking at a page whose every control now 404s.
      expect(await screen.findByText('the accounts list')).toBeInTheDocument();
    });
  });

  it('shows the account’s own log', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'J Doe' });
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('subject=u1')),
      ).toBe(true),
    );
  });

  it('reports a missing account instead of rendering an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) =>
      String(input).includes('/api/admin/users/u1')
        ? Promise.resolve(
            json({ title: 'Not found', detail: 'User not found', status: 404 }, 404),
          )
        : Promise.resolve(json({ sources: [] }))) as typeof fetch);
    renderPage();

    expect(await screen.findByText(/user not found/i)).toBeInTheDocument();
  });

  it('offers a way back to the list', async () => {
    mockApi();
    renderPage();

    const back = await screen.findByRole('link', { name: /back to accounts/i });
    expect(back).toHaveAttribute('href', '/admin/users?tab=accounts');
  });
});

/**
 * Setting a password from the account's own screen.
 *
 * The setup link beside it is right for a joiner and wrong for the support
 * call where somebody is reading a password down the phone.
 */
describe('AccountDetailPage set password', () => {
  it('warns what it will cost before anything is typed', async () => {
    mockApi();
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Set password' }),
    );

    // The consequence is stated UP FRONT, because it is irreversible and the
    // page knows it for certain. The length rule is not, because the page does
    // not know the tenant's minimum and a wrong number is worse than none.
    expect(await screen.findByText(/every session is revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/choose their own/i)).toBeInTheDocument();
  });

  it('sets a password and says what happened, in order', async () => {
    let sent: unknown;
    mockApi(ACCOUNT, {
      '/password': (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return json({ sessionsRevoked: 2, mustChange: true });
      },
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Set password' }),
    );
    await userEvent.type(
      await screen.findByLabelText('New password'),
      'a-long-enough-password',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set it' }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent).toEqual({ password: 'a-long-enough-password' });
    expect(
      await screen.findByText(/2 sessions were revoked/i),
    ).toBeInTheDocument();
  });

  it('counts one revoked session as a session', async () => {
    mockApi(ACCOUNT, {
      '/password': () => json({ sessionsRevoked: 1, mustChange: true }),
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Set password' }),
    );
    await userEvent.type(
      await screen.findByLabelText('New password'),
      'a-long-enough-password',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set it' }));

    expect(await screen.findByText(/1 session was revoked/i)).toBeInTheDocument();
  });

  it('shows the server’s reason when the password is refused', async () => {
    mockApi(ACCOUNT, {
      '/password': () =>
        json(
          {
            type: 'https://syntra.dev/problems/weak-password',
            title: 'That password was refused',
            status: 422,
            detail: 'too_short',
          },
          422,
        ),
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Set password' }),
    );
    await userEvent.type(await screen.findByLabelText('New password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Set it' }));

    // The server owns the rule, so the server's words are what the reader
    // gets — the same decision the portal's own change form made.
    expect(await screen.findByText(/too_short/)).toBeInTheDocument();
  });

  it('says a service account is not forced to change the password', async () => {
    const service = { ...ACCOUNT, kind: 'service', personId: null, person: null };
    mockApi(service, {
      '/password': () => json({ sessionsRevoked: 0, mustChange: false }),
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Set password' }),
    );
    // Before anything is typed: the dialog states the different rule.
    expect(
      await screen.findByText(/API tokens keep working/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/must choose their own password/i)).not.toBeInTheDocument();

    await userEvent.type(
      await screen.findByLabelText('New password'),
      'a-long-enough-password',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set it' }));

    expect(
      await screen.findByText(/does not have to be changed at next sign-in/i),
    ).toBeInTheDocument();
  });

  it('is not offered for an account whose password lives upstream', async () => {
    mockApi({ ...ACCOUNT, passwordSource: 'upstream' });
    renderPage();

    await screen.findByText('jdoe');
    expect(
      screen.queryByRole('button', { name: 'Set password' }),
    ).not.toBeInTheDocument();
  });
});

/**
 * The org unit on the account's own edit form.
 *
 * `PATCH /users/:id/details` has accepted and validated `orgUnitId` since it
 * was written; only the form never sent one, so an account's unit could be set
 * at creation and never corrected.
 */
describe('AccountDetailPage org unit', () => {
  const UNITS = { orgUnits: [{ id: 'ou1', name: 'Sales' }, { id: 'ou2', name: 'Care' }] };

  it('offers the unit on the edit form and sends what was chosen', async () => {
    let sent: Record<string, unknown> | undefined;
    mockApi(ACCOUNT, {
      '/org-units': () => json(UNITS),
      '/details': (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return json({ ...ACCOUNT, orgUnitId: 'ou2' });
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(await screen.findByLabelText('Org unit'), 'ou2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent!.orgUnitId).toBe('ou2');
  });

  it('sends null when the unit is cleared', async () => {
    let sent: Record<string, unknown> | undefined;
    mockApi(
      { ...ACCOUNT, orgUnitId: 'ou1' },
      {
        '/org-units': () => json(UNITS),
        '/details': (_url, init) => {
          sent = JSON.parse(String(init?.body));
          return json({ ...ACCOUNT, orgUnitId: null });
        },
      },
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(await screen.findByLabelText('Org unit'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Null takes the account out of the hierarchy, which the schema
    // distinguishes from an omitted field. Sending '' would be a 400 on a uuid.
    await waitFor(() => expect(sent).toBeDefined());
    expect(sent!.orgUnitId).toBeNull();
  });

  it('opens the picker on the unit the account already has', async () => {
    mockApi(
      { ...ACCOUNT, orgUnitId: 'ou1' },
      { '/org-units': () => json(UNITS) },
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(await screen.findByLabelText('Org unit')).toHaveValue('ou1');
  });
});

/**
 * Offering a person for an account that has none.
 *
 * The suggestion carries its REASON. One without is a claim an administrator
 * has to verify from scratch, which is the work the suggestion was meant to
 * save.
 */
describe('AccountDetailPage person suggestions', () => {
  const ORPHAN = { ...ACCOUNT, personId: null, person: null };

  const withCandidates = (candidates: Record<string, unknown>[]) =>
    mockApi(ORPHAN, { '/person-candidates': () => json({ candidates }) });

  it('offers a candidate, naming both the person and the reason', async () => {
    withCandidates([
      {
        personId: 'p1',
        givenName: 'Maya',
        familyName: 'Okafor',
        rule: 'personalEmail',
        hasActiveAccount: false,
      },
    ]);
    renderPage();

    expect(
      await screen.findByRole('button', { name: /link Maya Okafor/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/same personal email/i)).toBeInTheDocument();
  });

  it('says when a candidate already signs in somewhere', async () => {
    withCandidates([
      {
        personId: 'p1',
        givenName: 'Maya',
        familyName: 'Okafor',
        rule: 'businessEmail',
        hasActiveAccount: true,
      },
    ]);
    renderPage();

    // The contractor-with-two-accounts case is legitimate, so it is offered
    // and labelled rather than hidden.
    expect(await screen.findByText(/already has an account/i)).toBeInTheDocument();
  });

  it('links the account when the button is pressed', async () => {
    let linked: { url: string; body: unknown } | undefined;
    mockApi(ORPHAN, {
      '/person-candidates': () => json({ candidates: [
        {
          personId: 'p1',
          givenName: 'Maya',
          familyName: 'Okafor',
          rule: 'businessEmail',
          hasActiveAccount: false,
        },
      ] }),
      '/link-user': (url, init) => {
        linked = { url, body: JSON.parse(String(init?.body)) };
        return json({ ok: true });
      },
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /link Maya Okafor/i }),
    );

    await waitFor(() => expect(linked).toBeDefined());
    expect(linked!.url).toContain('/api/admin/persons/p1/link-user');
    expect(linked!.body).toEqual({ userId: 'u1' });
  });

  it('says only "Not linked" when nothing matches', async () => {
    withCandidates([]);
    renderPage();

    // A service account is the ordinary case here, not a fault. It is stated
    // flatly and given no call to action for that reason.
    expect(await screen.findByText('Not linked')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^link /i }),
    ).not.toBeInTheDocument();
  });

  it('offers nothing for an account that already has a person', async () => {
    mockApi(ACCOUNT, { '/person-candidates': () => json({ candidates: [] }) });
    renderPage();

    expect(await screen.findByRole('link', { name: 'Jo Doe' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^link /i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * Service accounts: shown as such, and toggled only where the server would
 * accept it (an account linked to a person is never a service account).
 */
describe('AccountDetailPage account type', () => {
  const UNLINKED = { ...ACCOUNT, kind: 'person', personId: null, person: null };

  it('shows a service account and explains what differs', async () => {
    mockApi({ ...UNLINKED, kind: 'service' });
    renderPage();

    expect(await screen.findByText('Service account')).toBeInTheDocument();
    expect(screen.getByText(/used by integrations through API tokens/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark as person account' }),
    ).toBeInTheDocument();
  });

  it('marks an unlinked account as a service account', async () => {
    let sent: unknown;
    const fetchSpy = mockApi(UNLINKED);
    const fallback = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sent = JSON.parse(String(init.body));
        return Promise.resolve(json({ id: 'u1', kind: 'service' }));
      }
      return fallback(input, init);
    }) as typeof fetch);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Mark as service account' }),
    );
    await waitFor(() => expect(sent).toEqual({ kind: 'service' }));
  });

  it('does not offer it for an account a person owns', async () => {
    mockApi();
    renderPage();

    await screen.findByText('jdoe');
    expect(screen.getByText('Person account')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark as service account' }),
    ).not.toBeInTheDocument();
  });

  it('is not offered without directory.write', async () => {
    granted.delete('directory.write');
    mockApi(UNLINKED);
    renderPage();

    await screen.findByText('jdoe');
    expect(
      screen.queryByRole('button', { name: 'Mark as service account' }),
    ).not.toBeInTheDocument();
  });
});
