import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ContainersPanel } from './ContainersPanel.js';

const BASE_DN = 'OU=Users,OU=Syntra,DC=acme,DC=test';

const targets = {
  targets: [{ id: 't-1', name: 'Acme AD', config: { baseDn: BASE_DN } }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockRoutes(
  handlers: Record<string, (init: RequestInit | undefined) => Response>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) return Promise.reject(new Error(`unmocked fetch: ${url}`));
    return Promise.resolve(handler(init));
  }) as never);
}

// The panel is a section of the unit's record, so it is rendered outright
// rather than opened: these tests mount it the way the record does.
const renderPanel = () =>
  render(
    <MemoryRouter>
      <ContainersPanel unit={{ id: 'ou-1', name: 'Sales' }} />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('ContainersPanel', () => {
  it('suggests a DN built from the chosen target base', async () => {
    // The preview IS the explanation. A control that needs a paragraph beside
    // it to be usable is a control that needs redesigning.
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
    });
    renderPanel();

    // The trigger and the submit share their label: RecordPanel renders one
    // button when closed and the same wording on the panel's submit.
    await userEvent.click(
      await screen.findByRole('button', { name: /create container/i }),
    );
    await userEvent.selectOptions(await screen.findByLabelText(/target/i), 't-1');

    await waitFor(() =>
      expect(screen.getByLabelText(/container/i)).toHaveValue(`OU=Sales,${BASE_DN}`),
    );
  });

  it('posts the container to the materialise endpoint', async () => {
    let posted: string | undefined;
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': (init) => {
        if (init?.method === 'POST') {
          posted = String(init.body);
          return json(
            { targetSystemId: 't-1', dn: `OU=Sales,${BASE_DN}`, state: 'desired' },
            201,
          );
        }
        return json({ containers: [] });
      },
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: /create container/i }),
    );
    await userEvent.selectOptions(await screen.findByLabelText(/target/i), 't-1');
    await userEvent.click(screen.getByRole('button', { name: /create container/i }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(JSON.parse(posted!)).toEqual({
      targetSystemId: 't-1',
      dn: `OU=Sales,${BASE_DN}`,
    });
  });

  it('shows an existing materialisation and its state', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () =>
        json({
          containers: [
            {
              targetSystemId: 't-1',
              targetName: 'Acme AD',
              dn: `OU=Sales,${BASE_DN}`,
              state: 'desired',
            },
          ],
        }),
    });
    renderPanel();

    expect(await screen.findByText(`OU=Sales,${BASE_DN}`)).toBeInTheDocument();
    // 'desired' is an ordinary state before the next run, not a fault, and it
    // has to be visible so nobody reads a pending container as a broken one.
    expect(screen.getByText('desired')).toBeInTheDocument();
  });

  it('surfaces an out-of-base refusal on the field', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': (init) =>
        init?.method === 'POST'
          ? json(
              {
                title: "CN=Users,DC=acme,DC=test is not below the target's base",
                reason: 'outside_base',
                errors: [
                  {
                    path: 'dn',
                    message: "CN=Users,DC=acme,DC=test is not below the target's base",
                  },
                ],
              },
              400,
            )
          : json({ containers: [] }),
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: /create container/i }),
    );
    await userEvent.selectOptions(await screen.findByLabelText(/target/i), 't-1');
    await userEvent.clear(screen.getByLabelText(/container/i));
    await userEvent.type(screen.getByLabelText(/container/i), 'CN=Users,DC=acme,DC=test');
    await userEvent.click(screen.getByRole('button', { name: /create container/i }));

    expect(await screen.findByText(/not below the target/i)).toBeInTheDocument();
  });
});
