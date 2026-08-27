import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentsPage } from './IncidentsPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const incident = (over: Record<string, unknown> = {}) => ({
  kind: 'webhook_undelivered',
  severity: 'critical',
  title: '3 webhooks were never delivered',
  detail: 'The receiving system has not been told about these.',
  count: 3,
  lastAt: '2026-08-26T12:00:00.000Z',
  href: '/admin/webhooks',
  ...over,
});

const mockIncidents = (incidents: unknown[]) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ incidents })),
  );

const renderPage = () =>
  render(
    <MemoryRouter>
      <IncidentsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('IncidentsPage', () => {
  it('says nothing is broken rather than showing an empty table', async () => {
    // The answer somebody wants most often. A dashboard that manufactures a
    // row to look busy is one people stop reading.
    mockIncidents([]);
    renderPage();
    expect(await screen.findByText(/nothing is broken/i)).toBeInTheDocument();
  });

  it('states the problem and what follows from it', async () => {
    mockIncidents([incident()]);
    renderPage();
    expect(await screen.findByText('3 webhooks were never delivered')).toBeInTheDocument();
    expect(screen.getByText(/has not been told/i)).toBeInTheDocument();
  });

  it('links every row to the screen that can fix it', async () => {
    // A dashboard whose rows are dead ends is one people read once.
    mockIncidents([incident()]);
    renderPage();
    expect(await screen.findByRole('link', { name: /go there/i })).toHaveAttribute(
      'href',
      '/admin/webhooks',
    );
  });

  it('distinguishes broken from degraded', async () => {
    mockIncidents([
      incident(),
      incident({ kind: 'sync_run_failed', severity: 'warning', title: '1 directory sync failed' }),
    ]);
    renderPage();
    expect(await screen.findByText('Broken')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('offers no way to dismiss anything', async () => {
    // A row disappears when the thing behind it is fixed and not before, so
    // nobody can make this page look clean except by making it true.
    mockIncidents([incident()]);
    renderPage();
    await screen.findByText('3 webhooks were never delivered');
    expect(screen.queryByRole('button', { name: /dismiss|acknowledge|snooze/i })).toBeNull();
  });
});
