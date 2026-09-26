import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@syntra/ui';
import { IncidentCard, type Incident } from './IncidentCard.js';

const RECENT = new Date(Date.now() - 10 * 60_000).toISOString();

const incident = (over: Partial<Incident> = {}): Incident => ({
  kind: 'provision_run_failed',
  severity: 'warning',
  title: '4 provisioning runs failed this week',
  detail: 'Nothing was applied by these runs.',
  count: 4,
  lastAt: RECENT,
  href: '/admin/targets/t1/runs',
  resolvable: true,
  acknowledged: null,
  items: [
    { label: 'Contoso AD', detail: 'connect ETIMEDOUT 10.0.0.5:636', at: RECENT, href: '/admin/targets/t1/runs/r1' },
    { label: 'Contoso AD', detail: 'connect ETIMEDOUT 10.0.0.5:636', at: RECENT, href: '/admin/targets/t1/runs/r2' },
    { label: 'Snipe-IT', detail: '401 Unauthorized', at: RECENT, href: '/admin/targets/t2/runs/r3' },
    { label: 'Snipe-IT', detail: null, at: RECENT, href: '/admin/targets/t2/runs/r4' },
  ],
  ...over,
});

const renderCard = (value: Incident, onChanged = vi.fn()) =>
  render(
    <ToastProvider>
      <MemoryRouter>
        <ul>
          <IncidentCard incident={value} onChanged={onChanged} />
        </ul>
      </MemoryRouter>
    </ToastProvider>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('IncidentCard', () => {
  it('shows each failure with its error and a link to it, folded after three', async () => {
    renderCard(incident());
    expect(screen.getAllByText('connect ETIMEDOUT 10.0.0.5:636')).toHaveLength(2);
    expect(screen.getByText('401 Unauthorized')).toBeInTheDocument();
    expect(screen.queryByText('No error recorded')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Snipe-IT' })).toHaveAttribute('href', '/admin/targets/t2/runs/r3');

    await userEvent.click(screen.getByRole('button', { name: 'Show all 4' }));
    expect(screen.getByText('No error recorded')).toBeInTheDocument();
  });

  it('acknowledges with a note', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }) as never);
    const changed = vi.fn();
    renderCard(incident(), changed);

    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await userEvent.type(screen.getByLabelText('Note'), 'checking the DC');
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(changed).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/incidents/provision_run_failed/acknowledge');
    expect(JSON.parse(String(init?.body))).toEqual({ note: 'checking the DC' });
  });

  it('says who acknowledged it, and offers no second acknowledgement', () => {
    renderCard(incident({ acknowledged: { at: RECENT, by: 'Ops Person', note: 'on it' } }));
    expect(screen.getByText(/Acknowledged by Ops Person/)).toBeInTheDocument();
    expect(screen.getByText('“on it”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('offers no resolve for a condition', () => {
    renderCard(incident({ kind: 'target_runs_skipped', resolvable: false }));
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('keeps a refusal on the card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ type: 'x/forbidden', title: 'Not allowed', status: 403, detail: 'Resolving this needs provision.manage.' }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }) as never,
    );
    renderCard(incident());
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('Resolving this needs provision.manage.')).toBeInTheDocument();
  });
});
