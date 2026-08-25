import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OnboardPersonPage } from './OnboardPersonPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: 'Conflict', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
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
    <MemoryRouter initialEntries={['/admin/people/new']}>
      <Routes>
        <Route path="/admin/people/new" element={<OnboardPersonPage />} />
        <Route path="/admin/people/:id" element={<div>person page</div>} />
      </Routes>
    </MemoryRouter>,
  );

async function fillMinimum(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Given name'), 'Maya');
  await user.type(screen.getByLabelText('Family name'), 'Okafor');
  // `fireEvent.change` rather than `user.type`: the field opens prefilled with
  // today, and typing into a populated date input appends per-segment rather
  // than replacing the value, which lands an empty string on the request.
  fireEvent.change(screen.getByLabelText('Start date'), {
    target: { value: '2026-09-01' },
  });
}

beforeEach(() => vi.restoreAllMocks());

describe('OnboardPersonPage', () => {
  it('creates the person, then their contract, in that order', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    mockRoutes({
      '/api/admin/persons': (init) => {
        calls.push('person');
        bodies.push(JSON.parse(String(init?.body)));
        return json({ id: 'p1' }, 201);
      },
      '/api/admin/persons/p1/contracts': (init) => {
        calls.push('contract');
        bodies.push(JSON.parse(String(init?.body)));
        return json({ id: 'c1' }, 201);
      },
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    // The contract cannot be posted before the person exists: it is addressed
    // by their id.
    await waitFor(() => expect(calls).toEqual(['person', 'contract']));
    expect(bodies[0]).toMatchObject({ givenName: 'Maya', familyName: 'Okafor' });
    expect(bodies[1]).toMatchObject({
      sequence: 1,
      isPrimary: true,
      startDate: '2026-09-01',
    });
  });

  it('lands on the new person once both are written', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/admin/persons': () => json({ id: 'p1' }, 201),
      '/api/admin/persons/p1/contracts': () => json({ id: 'c1' }, 201),
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    expect(await screen.findByText('person page')).toBeInTheDocument();
  });

  it('keeps the person and names what is missing when the contract is refused', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/admin/persons': () => json({ id: 'p1' }, 201),
      '/api/admin/persons/p1/contracts': () =>
        problem(409, 'contract sequence 1 already exists for this person'),
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    // Named, so nobody retypes a person who is already there and collides on
    // the external id next time.
    expect(await screen.findByText(/Maya Okafor was created/i)).toBeInTheDocument();
    expect(
      screen.getByText(/contract sequence 1 already exists/i),
    ).toBeInTheDocument();
    // Still on the form rather than navigated away from the half-done record.
    expect(screen.queryByText('person page')).not.toBeInTheDocument();
  });

  it('creates and links a login only when asked for one', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    mockRoutes({
      '/api/admin/org-units': () => json({ orgUnits: [] }),
      '/api/admin/persons': () => {
        calls.push('person');
        return json({ id: 'p1' }, 201);
      },
      '/api/admin/persons/p1/contracts': () => {
        calls.push('contract');
        return json({ id: 'c1' }, 201);
      },
      '/api/admin/users': (init) => {
        calls.push('user');
        bodies.user = JSON.parse(String(init?.body));
        return json({ id: 'u1' }, 201);
      },
      '/api/admin/persons/p1/link-user': (init) => {
        calls.push('link');
        bodies.link = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 }) as never;
      },
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByLabelText(/Also create a Syntra login/i));
    await user.type(screen.getByLabelText('Login'), 'mokafor');
    await user.type(screen.getByLabelText('Email'), 'maya@acme.test');
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    await waitFor(() =>
      expect(calls).toEqual(['person', 'contract', 'user', 'link']),
    );
    // The display name falls back to the person's name rather than being sent
    // empty: the schema requires one.
    expect(bodies.user).toMatchObject({
      login: 'mokafor',
      email: 'maya@acme.test',
      displayName: 'Maya Okafor',
    });
    expect(bodies.link).toEqual({ userId: 'u1' });
  });

  it('creates no login when the box is left alone', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    mockRoutes({
      '/api/admin/org-units': () => json({ orgUnits: [] }),
      '/api/admin/persons': () => {
        calls.push('person');
        return json({ id: 'p1' }, 201);
      },
      '/api/admin/persons/p1/contracts': () => {
        calls.push('contract');
        return json({ id: 'c1' }, 201);
      },
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    // An unmocked POST /api/admin/users would reject and fail this.
    await waitFor(() => expect(calls).toEqual(['person', 'contract']));
  });

  it('applies only the new person actions and leaves the rest of the run alone', async () => {
    const user = userEvent.setup();
    let applied: unknown = null;
    let listed = 0;
    mockRoutes({
      '/api/admin/org-units': () => json({ orgUnits: [] }),
      '/api/admin/targets': () =>
        json({ targets: [{ id: 't1', name: 'AD', enabled: true }] }),
      '/api/admin/persons': () => json({ id: 'p1' }, 201),
      '/api/admin/persons/p1/contracts': () => json({ id: 'c1' }, 201),
      '/api/admin/targets/t1/runs': (init) => {
        if (init?.method === 'POST') return json({ jobId: 'j1' }, 202);
        listed += 1;
        // The FIRST read happens before the run is enqueued and returns the
        // previous run, which must not be mistaken for this one.
        return listed === 1
          ? json({ runs: [{ id: 'r0', status: 'previewed' }] })
          : json({ runs: [{ id: 'r1', status: 'previewed' }] });
      },
      '/api/admin/targets/t1/runs/r1': () =>
        json({
          id: 'r1',
          status: 'previewed',
          actions: [
            { id: 'a1', personId: 'p1', actionType: 'create_account' },
            { id: 'a2', personId: 'p9', actionType: 'disable_account' },
          ],
        }),
      '/api/admin/targets/t1/runs/r1/apply': (init) => {
        applied = JSON.parse(String(init?.body));
        return json({ ok: true });
      },
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    // a2 belongs to somebody else. Applying the run wholesale would have
    // disabled them on the strength of somebody else being hired.
    await waitFor(() => expect(applied).toEqual({ only: ['a1'] }), {
      timeout: 5000,
    });
  });

  // The stale-run and never-plans cases live in provision-on-create.test.ts,
  // where the poll interval is injectable and they cost milliseconds rather
  // than the real thirty-second bound.

  it('skips a disabled target', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/admin/org-units': () => json({ orgUnits: [] }),
      '/api/admin/targets': () =>
        json({ targets: [{ id: 't1', name: 'Retired AD', enabled: false }] }),
      '/api/admin/persons': () => json({ id: 'p1' }, 201),
      '/api/admin/persons/p1/contracts': () => json({ id: 'c1' }, 201),
      // No handler for t1's runs: touching them rejects and fails the test.
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    expect(await screen.findByText('person page')).toBeInTheDocument();
  });

  it('reports a refused person without claiming anything was created', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/admin/persons': () => problem(409, 'external id already exists: E1042'),
    });

    renderPage();
    await fillMinimum(user);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    expect(await screen.findByText(/external id already exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/was created/i)).not.toBeInTheDocument();
  });
});
