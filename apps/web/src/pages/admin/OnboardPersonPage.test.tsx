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
