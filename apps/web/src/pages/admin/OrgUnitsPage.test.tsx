import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OrgUnitsPage } from './OrgUnitsPage.js';

// `useCan` answers false without a provider, which would hide the control
// under test. Granting everything keeps the subject of these tests the SCREEN
// rather than the permission model, which has its own.
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => () => true,
}));

const BASE_DN = 'OU=Users,OU=Syntra,DC=acme,DC=test';

const orgUnits = {
  orgUnits: [
    {
      id: 'ou-1',
      name: 'Sales',
      parentId: null,
      status: 'active',
      statusReason: null,
      sourceId: null,
    },
  ],
};

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

const renderPage = () =>
  render(
    <MemoryRouter>
      <OrgUnitsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('OrgUnitsPage containers', () => {
  it('does not materialise anything when a unit is created', async () => {
    // Two decisions, two controls. Creating a unit in Syntra writes nothing to
    // any directory, and that separation is what Ruling P9 (revised) rests on.
    const calls: string[] = [];
    mockRoutes({
      '/api/admin/org-units': (init) => {
        calls.push(`${init?.method ?? 'GET'} /api/admin/org-units`);
        return json(orgUnits);
      },
      '/api/admin/targets': () => json(targets),
    });
    renderPage();

    await screen.findByText('Sales');

    expect(calls.some((c) => c.includes('containers'))).toBe(false);
  });

  it('suggests a DN built from the chosen target base', async () => {
    // The preview IS the explanation. A control that needs a paragraph beside
    // it to be usable is a control that needs redesigning.
    mockRoutes({
      '/api/admin/org-units': () => json(orgUnits),
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /containers/i }));
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
      '/api/admin/org-units': () => json(orgUnits),
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': (init) => {
        if (init?.method === 'POST') {
          posted = String(init.body);
          return json({ targetSystemId: 't-1', dn: `OU=Sales,${BASE_DN}`, state: 'desired' }, 201);
        }
        return json({ containers: [] });
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /containers/i }));
    // The trigger and the submit share their label: RecordPanel renders one
    // button when closed and the same wording on the panel's submit.
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
      '/api/admin/org-units': () => json(orgUnits),
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
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /containers/i }));

    expect(await screen.findByText(`OU=Sales,${BASE_DN}`)).toBeInTheDocument();
    // 'desired' is an ordinary state before the next run, not a fault, and it
    // has to be visible so nobody reads a pending container as a broken one.
    expect(screen.getByText('desired')).toBeInTheDocument();
  });

  it('surfaces an out-of-base refusal on the field', async () => {
    mockRoutes({
      '/api/admin/org-units': () => json(orgUnits),
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
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /containers/i }));
    // The trigger and the submit share their label: RecordPanel renders one
    // button when closed and the same wording on the panel's submit.
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
