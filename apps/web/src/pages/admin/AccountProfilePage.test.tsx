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

function mockFetch(options: { profile?: unknown; profileStatus?: number } = {}) {
  const status = options.profileStatus ?? 200;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') return Promise.resolve(json(null, 204));
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
            json({ type: 'x/not-found', title: 'No account profile yet', status }, status),
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
    mockFetch({ profileStatus: 404 });
    renderPage();

    expect(
      await screen.findByDisplayValue(
        '%person.givenName.first%.%person.familyName%',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
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
