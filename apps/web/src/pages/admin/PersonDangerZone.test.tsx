import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonDangerZone } from './PersonDangerZone.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const inactive = { id: 'p1', givenName: 'Anna', familyName: 'Novak', status: 'inactive' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderZone(person = inactive) {
  return render(
    <MemoryRouter initialEntries={['/admin/people/p1']}>
      <Routes>
        <Route path="/admin/people/:id" element={<PersonDangerZone person={person} />} />
        <Route path="/admin/users" element={<p>People list</p>} />
        <Route path="/elevate" element={<p>Elevate page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  granted.clear();
  vi.restoreAllMocks();
});

describe('PersonDangerZone', () => {
  it('is hidden without person.purge', () => {
    renderZone();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
  });

  it('is hidden for an active person, even for a holder', () => {
    granted.add('person.purge');
    renderZone({ ...inactive, status: 'active' });
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
  });

  it('needs the full name and a reason, then sends both and leaves the page', async () => {
    granted.add('person.purge');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderZone();

    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    const dialogs = screen.getAllByRole('button', { name: 'Delete permanently' });
    const confirm = dialogs[dialogs.length - 1]!;
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Type Anna Novak to confirm'), 'Anna Novak');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Duplicate from CSV import');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => expect(screen.getByText('People list')).toBeInTheDocument());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/persons/p1');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Duplicate from CSV import', confirm: 'Anna Novak' });
  });

  it("shows the server's refusal", async () => {
    granted.add('person.purge');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          type: 'https://syntra.dev/problems/open-privacy-case',
          title: 'Open privacy case',
          status: 409,
          detail: 'Anna Novak has open privacy case DSAR-2026-0001. Close it, then delete.',
        },
        409,
      ),
    );
    const user = userEvent.setup();
    renderZone();

    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await user.type(screen.getByLabelText('Type Anna Novak to confirm'), 'Anna Novak');
    await user.type(screen.getByLabelText('Reason'), 'Duplicate from CSV import');
    const buttons = screen.getAllByRole('button', { name: 'Delete permanently' });
    await user.click(buttons[buttons.length - 1]!);

    expect(
      await screen.findByText('Anna Novak has open privacy case DSAR-2026-0001. Close it, then delete.'),
    ).toBeInTheDocument();
  });
});
