import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AccountProfilePage } from './AccountProfilePage.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Exactly what `GET /targets/:id/profile` returns: the stored Prisma row. */
const STORED = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '44444444-4444-4444-8444-444444444444',
  targetSystemId: 't1',
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  uniquenessStrategy: 'numericSuffix',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=Staff,DC=acme,DC=test',
  fallbackContainer: 'OU=Unplaced,DC=acme,DC=test',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function mockFetch(
  options: {
    profile?: unknown;
    profileStatus?: number;
    profileProblem?: Record<string, unknown>;
    saveProblem?: { status: number; body: Record<string, unknown> };
  } = {},
) {
  const status = options.profileStatus ?? 200;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') {
      return Promise.resolve(
        options.saveProblem
          ? json(options.saveProblem.body, options.saveProblem.status)
          : json(null, 204),
      );
    }
    if (path.endsWith('/profile/preview'))
      return Promise.resolve(
        json({
          correlationKey: 'anna.novak',
          taken: false,
          container: 'OU=Staff,DC=acme,DC=test',
          attributes: {},
          problems: [],
        }),
      );
    if (path.endsWith('/profile'))
      return status === 200
        ? Promise.resolve(json(options.profile ?? STORED))
        : Promise.resolve(
            json(
              options.profileProblem ?? {
                type: 'x/not-found',
                title: 'No account profile yet',
                status,
              },
              status,
            ),
          );
    return Promise.resolve(json({ persons: [] }));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/t1/profile']}>
      <Routes>
        <Route
          path="/admin/targets/:id/profile"
          element={<AccountProfilePage />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('AccountProfilePage', () => {
  it('sends back only the fields the strict schema accepts', async () => {
    // `accountProfileRequestSchema` is `.strict()` and the GET returns the
    // stored row — id, tenantId, targetSystemId, createdAt, updatedAt and all.
    // Echoing what was read is a 400 on every save of an existing profile,
    // which is the only path this page has.
    const fetchMock = mockFetch();
    renderPage();

    await screen.findByDisplayValue('OU=Unplaced,DC=acme,DC=test');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    const put = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    expect(put).toBeDefined();
    expect(Object.keys(JSON.parse(String(put![1]!.body))).sort()).toEqual([
      'attributeTemplates',
      'containerTemplate',
      'correlationKeyTemplate',
      'fallbackContainer',
      'initialPasswordDelivery',
      'initialPasswordPolicy',
      'maxUniquenessAttempts',
      'uniquenessStrategy',
    ]);
  });

  it('treats no profile yet as the ordinary state of a new target', async () => {
    // A 404 here means nobody has saved one, which is what every target looks
    // like the minute after it is created. Apologising for it would send
    // somebody hunting for a fault that is not there.
    //
    // Asserted on something ONLY the 404 branch produces. The previous version
    // of this test looked for the default naming template, which is on screen
    // at first paint from `EMPTY` — the whole 404 branch could have been
    // deleted and it would still have passed.
    mockFetch({ profileStatus: 404 });
    renderPage();

    expect(
      await screen.findByText(/This target has no account profile yet/),
    ).toBeVisible();
    expect(
      screen.getByDisplayValue('%person.givenName.first%.%person.familyName%'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('will not offer to save defaults over a profile it could not read', async () => {
    // The catastrophe this page was one click away from. `profile` initialised
    // to full defaults, no loading gate, Save enabled on any failure that was
    // not a 404 — so one click PUT the defaults over the stored profile and
    // took the naming convention and every attribute template with them.
    const fetchMock = mockFetch({
      profileStatus: 500,
      profileProblem: { title: 'Internal Server Error', status: 500 },
    });
    renderPage();

    expect(
      await screen.findByText('This profile could not be read'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull();
    // And nothing on screen that could be mistaken for what is stored.
    expect(
      screen.queryByDisplayValue('%person.givenName.first%.%person.familyName%'),
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('will not offer to save defaults when the read was refused', async () => {
    // A 403 is not "no profile yet" either: there is one, and this caller may
    // not see it.
    mockFetch({
      profileStatus: 403,
      profileProblem: { title: 'Forbidden', status: 403 },
    });
    renderPage();

    expect(
      await screen.findByText('This profile could not be read'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull();
  });

  it('keeps what was typed in a number box, and refuses it by name', async () => {
    // `Number(v)` on each keystroke turned `3o` into the literal text `NaN` in
    // the box and then a `null` in the body, which the schema 400s on against
    // a field nobody typed a null into.
    const fetchMock = mockFetch();
    renderPage();

    const attempts = await screen.findByLabelText('Maximum uniqueness attempts');
    await userEvent.clear(attempts);
    await userEvent.type(attempts, '3o');
    expect(attempts).toHaveValue('3o');

    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(screen.getByText('Some of this was refused')).toBeVisible();
    expect(
      screen.getByText('a whole number between 1 and 200'),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('marks the attribute row the server named, and says what it said', async () => {
    // The banner has always promised "the fields concerned are marked below"
    // while the attribute rows carried no mark at all, and `fail` threw the
    // server's explanation away on top of that.
    mockFetch({
      saveProblem: {
        status: 400,
        body: {
          title: 'Validation failed',
          status: 400,
          errors: [
            {
              path: 'attributeTemplates.userAccountControl',
              message: 'an account profile may not write userAccountControl',
            },
          ],
        },
      },
      profile: {
        ...STORED,
        attributeTemplates: { userAccountControl: '512' },
      },
    });
    renderPage();

    await screen.findByDisplayValue('userAccountControl');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(
      await screen.findByText(
        'an account profile may not write userAccountControl',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('Attribute 1')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('carries through the password-policy keys it has no control for', async () => {
    // `initialPasswordPolicySchema` is `.strict()` and takes five keys. This
    // page renders one, so rebuilding the policy from the form alone would
    // drop the other four on every save.
    const fetchMock = mockFetch({
      profile: {
        ...STORED,
        initialPasswordPolicy: { length: 24, requireSymbol: true },
      },
    });
    renderPage();

    await screen.findByDisplayValue('OU=Unplaced,DC=acme,DC=test');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(
      JSON.parse(String(put![1]!.body)).initialPasswordPolicy,
    ).toEqual({ length: 24, requireSymbol: true });
  });

  it('drops an attribute row whose name was left blank', async () => {
    // An empty key is not an LDAP attribute, and `attributeTemplatesSchema`
    // refuses it — so a half-typed row would make the save fail with a message
    // about a field nobody meant to add.
    const fetchMock = mockFetch();
    renderPage();

    await screen.findByDisplayValue('OU=Unplaced,DC=acme,DC=test');
    await userEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
    await userEvent.type(screen.getByLabelText('Template 2'), 'unfinished');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(
      JSON.parse(String(put![1]!.body)).attributeTemplates,
    ).toEqual({ displayName: '%person.givenName% %person.familyName%' });
  });

  it('will not preview until a person is chosen', async () => {
    mockFetch();
    renderPage();

    await screen.findByDisplayValue('OU=Unplaced,DC=acme,DC=test');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });
});
