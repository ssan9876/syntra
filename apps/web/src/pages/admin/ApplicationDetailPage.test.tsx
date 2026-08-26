import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApplicationDetailPage } from './ApplicationDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const forbidden = () =>
  json(
    {
      type: 'https://syntra.dev/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'Requires access.manage',
    },
    403,
  );

function mockApi(mutation: () => Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      return Promise.resolve(mutation());
    }
    if (url.includes('/assignments')) {
      return Promise.resolve(
        json({
          assignments: [
            {
              id: 'a1',
              subjectType: 'group',
              userId: null,
              groupId: 'g1',
              orgUnitId: null,
            },
          ],
        }),
      );
    }
    if (url.includes('/groups')) {
      return Promise.resolve(json({ groups: [{ id: 'g1', name: 'Nurses' }] }));
    }
    if (url.includes('/users')) return Promise.resolve(json({ users: [] }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: [] }));
    return Promise.resolve(json({ id: 'app-1', name: 'Ledger', slug: 'ledger' }));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/applications/app-1']}>
      <Routes>
        <Route path="/admin/applications/:id" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('assignment controls', () => {
  /**
   * `assign()` and `unassign()` had no catch, so a 403 was an unhandled
   * rejection and the button simply appeared to do nothing. The caller was
   * usually a holder of `access.read` who could see the page and not change
   * it, and the interface gave them no way to find that out.
   */
  it('renders the server refusal when a removal is forbidden', async () => {
    mockApi(forbidden);
    renderPage();
    // 'Nurses' appears twice: once as the assignment row, once as the picker
    // option. Either is proof the page has loaded.
    await screen.findAllByText('Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Requires access.manage')).toBeInTheDocument();
  });

  it('renders it for an assignment too', async () => {
    mockApi(forbidden);
    renderPage();
    // 'Nurses' appears twice: once as the assignment row, once as the picker
    // option. Either is proof the page has loaded.
    await screen.findAllByText('Nurses');

    // The GROUP picker's own Assign. The page renders one picker per subject
    // kind -- user, group, org unit -- each with its own button, and clicking
    // the user picker's would return early on an empty selection and assert
    // nothing.
    const group = screen.getByLabelText('Group');
    const picker = group.closest('div.flex-wrap') as HTMLElement;
    await userEvent.selectOptions(group, 'g1');
    await userEvent.click(within(picker).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Requires access.manage')).toBeInTheDocument();
  });
});
