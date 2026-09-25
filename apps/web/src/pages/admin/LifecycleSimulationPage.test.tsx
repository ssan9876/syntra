import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LifecycleSimulationPage } from './LifecycleSimulationPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const simulation = {
  id: 'sim-1',
  kind: 'leaver',
  scope: 'department',
  personId: null,
  department: 'Finance',
  peopleCount: 1,
  createdAt: '2026-09-24T09:00:00Z',
  expiresAt: null,
  result: {
    kind: 'leaver',
    scope: 'department',
    writesPerformed: false,
    computedAt: '2026-09-24T09:00:00Z',
    people: [
      {
        personId: 'p1',
        personName: 'Maya Okafor',
        department: 'Finance',
        targets: [],
        syntraLogins: [],
        summary: [],
      },
    ],
    unsupported: [],
    safetyBlockers: [],
  },
};

function mockApi(post: () => Response = () => json(simulation, 201)) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
    init?.method === 'POST'
      ? post()
      : String(input).endsWith('/sim-1')
        ? json(simulation)
        : json({ simulations: [simulation] }),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <LifecycleSimulationPage />
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('LifecycleSimulationPage', () => {
  it('labels the result out of date as soon as the scenario is edited', async () => {
    // The table of effects sits directly under the fields that produced it.
    // A reviewer who changes the department after running has a result on
    // screen for a rehearsal that was never run — so it says so.
    mockApi();
    renderPage();

    await userEvent.selectOptions(screen.getByLabelText('Scenario'), 'leaver');
    await userEvent.type(screen.getByLabelText('Department'), 'Finance');
    await userEvent.click(screen.getByRole('button', { name: 'Simulate without writes' }));

    expect(await screen.findByText(/Expected effects/)).toBeInTheDocument();
    expect(screen.queryByText('Out of date')).toBeNull();

    await userEvent.type(screen.getByLabelText('Department'), ' Ops');
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simulate again' })).toBeInTheDocument();

    // Putting the input back makes the result current again.
    await userEvent.clear(screen.getByLabelText('Department'));
    await userEvent.type(screen.getByLabelText('Department'), 'Finance');
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('does not call a stored simulation out of date against the form', async () => {
    // One opened from the history describes its own scenario in its row; the
    // form above was never its input.
    mockApi();
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Expected effects/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Department'), 'Anything');
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('puts a refused run in an error summary', async () => {
    mockApi(() =>
      json({ title: 'Refused', status: 400, detail: 'No department called Finanse' }, 400),
    );
    renderPage();

    await userEvent.type(screen.getByLabelText('Department'), 'Finanse');
    await userEvent.click(screen.getByRole('button', { name: 'Simulate without writes' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Not simulated');
    expect(summary).toHaveTextContent('No department called Finanse');
  });
});
