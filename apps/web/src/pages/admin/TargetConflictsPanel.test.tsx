import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetConflictsPanel } from './TargetConflictsPanel.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const ANNA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.restoreAllMocks());

describe('TargetConflictsPanel', () => {
  it('reads nothing until asked, then adopts every account that has a match', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/conflicts/adoption-preview')) {
        return json({
          accounts: [
            {
              personId: ANNA,
              givenName: 'Anna',
              familyName: 'Novak',
              businessEmail: 'anna@acme.test',
              correlationKey: 'anovak2',
              candidate: { anchor: 'mm-1', dn: 'anovak', correlationKey: 'anovak', matchedBy: 'email', attributes: {} },
            },
            { personId: BOB, givenName: 'Bob', familyName: 'Stone', businessEmail: null, correlationKey: 'bstone', candidate: null },
          ],
        });
      }
      if (url.endsWith('/conflicts/adopt') && init?.method === 'POST') {
        return json({ results: [{ personId: ANNA, adopted: true, anchor: 'mm-1', message: null }] });
      }
      throw new Error(`unmocked fetch: ${url}`);
    });

    render(<TargetConflictsPanel targetId="t-1" />);
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Find conflicts' }));
    expect(await screen.findByText('No match')).toBeVisible();
    expect(screen.getByText('(by email)')).toBeVisible();

    const adopt = screen.getByRole('button', { name: 'Adopt 1 account' });
    expect(adopt).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why/), 'existing Mattermost users');
    await userEvent.click(adopt);

    await waitFor(() => expect(screen.getByText('Adopted')).toBeVisible());
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ reason: 'existing Mattermost users', adoptions: [{ personId: ANNA, anchor: 'mm-1' }] });
  });
});
