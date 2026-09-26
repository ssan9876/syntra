import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsSessionsTab } from './SettingsSessionsTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

let calls: { url: string; init?: RequestInit }[];

const stub = (handler: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return handler(String(url), init);
    }),
  );
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/settings?tab=sessions']}>
      <Routes>
        <Route path="/admin/settings" element={<SettingsSessionsTab />} />
        <Route path="/elevate" element={<p>Elevation screen</p>} />
      </Routes>
    </MemoryRouter>,
  );

const REASON = 'Suspected credential compromise';

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsSessionsTab', () => {
  it('asks once, says what it will do, and only the second press revokes', async () => {
    stub(() => json({ usersAffected: 4, sessionsRevoked: 9, logoutsEnqueued: 2 }));
    renderPage();

    const start = screen.getByRole('button', { name: /revoke sessions/i });
    // Nothing to send until there is a reason worth recording.
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason'), REASON);
    await userEvent.click(start);

    expect(calls).toHaveLength(0);
    expect(
      await screen.findByText(/this ends every session in the organization/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/your current session is kept/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke every session' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/admin/sessions/revoke');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      scope: 'all',
      keepCurrentSession: true,
      reason: REASON,
    });
    // Announced through the live region, not only drawn.
    expect(await screen.findByRole('status')).toHaveTextContent(
      '9 sessions revoked for 4 people; 2 application sign-outs queued.',
    );
  });

  it('narrows to console sessions and can include the caller', async () => {
    stub(() => json({ usersAffected: 1, sessionsRevoked: 1, logoutsEnqueued: 0 }));
    renderPage();

    await userEvent.selectOptions(screen.getByLabelText('Sessions to end'), 'admin');
    await userEvent.click(screen.getByRole('checkbox', { name: /keep my current session/i }));
    await userEvent.type(screen.getByLabelText('Reason'), REASON);
    await userEvent.click(screen.getByRole('button', { name: /revoke sessions/i }));

    expect(await screen.findByText(/includes yours/i)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke every console session' }),
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({
      scope: 'admin',
      keepCurrentSession: false,
    });
  });

  it('turns a step-up refusal into a way to satisfy it', async () => {
    stub(() =>
      json(
        {
          type: 'https://syntra.dev/problems/step-up-required',
          title: 'Confirm it is you first',
          status: 403,
          detail: 'Elevate again, then retry.',
        },
        403,
      ),
    );
    renderPage();

    await userEvent.type(screen.getByLabelText('Reason'), REASON);
    await userEvent.click(screen.getByRole('button', { name: /revoke sessions/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke every session' }));

    expect(await screen.findByText('Elevate again, then retry.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Elevate again' }));
    expect(await screen.findByText('Elevation screen')).toBeInTheDocument();
  });

  it('shows any other refusal in the server\'s words', async () => {
    stub(() =>
      json(
        {
          type: 'https://syntra.dev/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Missing permission tenant.manage.',
        },
        403,
      ),
    );
    renderPage();

    await userEvent.type(screen.getByLabelText('Reason'), REASON);
    await userEvent.click(screen.getByRole('button', { name: /revoke sessions/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke every session' }));

    expect(await screen.findByText('Missing permission tenant.manage.')).toBeInTheDocument();
  });
});
