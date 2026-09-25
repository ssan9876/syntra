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

/** Every labelled button in the order a reader meets it (the DN's copy icon has no text). */
const buttonNames = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((name) => name !== '');

describe('ContainersPanel on a target that places accounts in OUs but does not mirror', () => {
  it('recommends turning mirroring on first, linked to the target’s Org units section', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
    });
    renderPanel();

    const row = await screen.findByTestId('unplaced-t-1');
    const link = screen.getByRole('link', { name: /turn on mirroring for this target \(recommended\)/i });
    expect(link).toHaveAttribute('href', '/admin/targets/t-1#org-units');
    // The recommendation comes before the manual path, in reading order.
    const text = row.textContent ?? '';
    expect(text.indexOf('Turn on mirroring for this target (recommended)')).toBeGreaterThan(-1);
    expect(text.indexOf('Set a DN by hand')).toBeGreaterThan(
      text.indexOf('Turn on mirroring for this target (recommended)'),
    );
    expect(screen.queryByRole('button', { name: /create container/i })).not.toBeInTheDocument();
  });

  it('offers no placement on a target with no OUs', async () => {
    mockRoutes({
      '/api/admin/targets': () =>
        json({ targets: [{ id: 't-2', name: 'Entra', config: {}, placesAccountsInContainers: false }] }),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
    });
    renderPanel();
    expect(await screen.findByText('Not in any directory yet')).toBeInTheDocument();
    expect(screen.queryByTestId('unplaced-t-2')).not.toBeInTheDocument();
  });

  it('suggests a DN built from the target base when set by hand', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^set a dn by hand$/i }));

    expect(screen.getByLabelText(/container/i)).toHaveValue(`OU=Sales,${BASE_DN}`);
    expect(screen.getByTestId('hand-typed-precedence')).toHaveTextContent(
      /takes precedence over the mirror if mirroring is turned on later/i,
    );
  });

  it('posts the typed DN to the materialise endpoint', async () => {
    let posted: string | undefined;
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': (init) => {
        if (init?.method === 'POST') {
          posted = String(init.body);
          return json({ targetSystemId: 't-1', dn: `OU=Sales,${BASE_DN}`, state: 'desired' }, 201);
        }
        return json({ containers: [] });
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^set a dn by hand$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save typed dn/i }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(JSON.parse(posted!)).toEqual({ targetSystemId: 't-1', dn: `OU=Sales,${BASE_DN}` });
  });

  it('shows an existing typed placement and its state', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () =>
        json({
          containers: [
            { targetSystemId: 't-1', targetName: 'Acme AD', dn: `OU=Sales,${BASE_DN}`, state: 'desired' },
          ],
        }),
    });
    renderPanel();

    expect(await screen.findByText(`OU=Sales,${BASE_DN}`)).toBeInTheDocument();
    // 'desired' is an ordinary state before the next run, not a fault.
    expect(screen.getByText('Awaiting the next run')).toBeInTheDocument();
    expect(screen.getByTestId('container-t-1')).toHaveTextContent('Typed by hand');
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
                errors: [{ path: 'dn', message: "CN=Users,DC=acme,DC=test is not below the target's base" }],
              },
              400,
            )
          : json({ containers: [] }),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^set a dn by hand$/i }));
    await userEvent.clear(screen.getByLabelText(/container/i));
    await userEvent.type(screen.getByLabelText(/container/i), 'CN=Users,DC=acme,DC=test');
    await userEvent.click(screen.getByRole('button', { name: /save typed dn/i }));

    const container = screen.getByLabelText(/container/i);
    await waitFor(() => expect(container).toHaveAccessibleDescription(/not below the target/i));
  });
});

describe('ContainersPanel on a mirroring target', () => {
  const view = (over: Record<string, unknown>) => ({
    targetSystemId: 't-1',
    targetName: 'Acme AD',
    dn: `OU=Sales,${BASE_DN}`,
    state: 'derived',
    source: 'mirrored',
    previousDn: null,
    mirroring: true,
    mirrored: true,
    derivedDn: `OU=Sales,${BASE_DN}`,
    problem: null,
    ...over,
  });

  it('shows the derived DN as "Mirrored automatically", with no action needed', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [view({})] }),
    });
    renderPanel();
    const row = await screen.findByTestId('container-t-1');
    expect(row).toHaveTextContent('Mirrored automatically');
    expect(row).toHaveTextContent(`OU=Sales,${BASE_DN}`);
    expect(row).toHaveTextContent('The next run creates it');
    expect(row).toHaveTextContent(/no action needed: the next run records this placement/i);
    // Automatic first: no recommendation to turn on what is already on, and the
    // typed DN is only the secondary override.
    expect(screen.queryByRole('link', { name: /turn on mirroring/i })).not.toBeInTheDocument();
    expect(buttonNames()).toEqual(['Set a DN by hand (overrides the mirror)']);
  });

  it('spells out the precedence when a DN is typed over the mirror', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [view({})] }),
    });
    renderPanel();
    await userEvent.click(
      await screen.findByRole('button', { name: /set a dn by hand \(overrides the mirror\)/i }),
    );
    expect(screen.getByText(/set a dn by hand on acme ad \(overrides the mirror\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('hand-typed-precedence')).toHaveTextContent(
      /a typed dn takes precedence over the mirror/i,
    );
  });

  it('leads a typed row with "Switch to mirrored", and posts it', async () => {
    let switched = false;
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () =>
        json({
          containers: [view({ dn: `OU=Flat,${BASE_DN}`, state: 'live', source: 'manual', mirrored: false })],
        }),
      '/api/admin/org-units/ou-1/containers/t-1/switch-to-mirrored': (init) => {
        switched = init?.method === 'POST';
        return json({ targetSystemId: 't-1', dn: `OU=Sales,${BASE_DN}`, pendingMoveFrom: `OU=Flat,${BASE_DN}` });
      },
    });
    renderPanel();
    const row = await screen.findByTestId('container-t-1');
    expect(row).toHaveTextContent('Typed by hand (overrides the mirror)');
    expect(row).toHaveTextContent('a typed DN always takes precedence over the mirror');
    expect(row).toHaveTextContent(`Mirrored, it would be OU=Sales,${BASE_DN}`);
    expect(buttonNames()[0]).toBe('Switch to mirrored');
    await userEvent.click(screen.getByRole('button', { name: /switch to mirrored/i }));
    await waitFor(() => expect(switched).toBe(true));
  });

  it('says a pending move out loud, and what stopping tracking a mirrored row does', async () => {
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () =>
        json({ containers: [view({ state: 'live', previousDn: `OU=Old,${BASE_DN}` })] }),
    });
    renderPanel();
    const row = await screen.findByTestId('container-t-1');
    expect(row).toHaveTextContent('The next run moves it');
    expect(row).toHaveTextContent(`Currently at OU=Old,${BASE_DN}`);
    expect(screen.getByRole('button', { name: /stop tracking/i })).toBeInTheDocument();
    expect(row).toHaveTextContent('the next run derives it again');
  });

  it('pre-fills the typed DN under the parent’s container on that target', async () => {
    let parentRead = false;
    mockRoutes({
      '/api/admin/targets': () => json(targets),
      '/api/admin/org-units/ou-1/containers': () => json({ containers: [] }),
      '/api/admin/org-units/ou-parent/containers': () => {
        parentRead = true;
        return json({ containers: [view({ dn: `OU=West\\, Region,${BASE_DN}`, state: 'live', source: 'manual', mirroring: false })] });
      },
    });
    render(
      <MemoryRouter>
        <ContainersPanel unit={{ id: 'ou-1', name: 'Sales, Inside', parentId: 'ou-parent' }} />
      </MemoryRouter>,
    );
    // Wait for the parent's containers before opening, as a person would see
    // the page settle before clicking.
    await screen.findByTestId('unplaced-t-1');
    await waitFor(() => expect(parentRead).toBe(true));
    await userEvent.click(await screen.findByRole('button', { name: /^set a dn by hand$/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/container/i)).toHaveValue(`OU=Sales\\, Inside,OU=West\\, Region,${BASE_DN}`),
    );
  });
});
