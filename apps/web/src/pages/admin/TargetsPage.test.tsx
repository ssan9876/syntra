import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TargetsPage } from './TargetsPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const target = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Samba AD',
  enabled: true,
  enforcementMode: 'additive',
  schedule: '0 3 * * *',
  lastRunAt: '2026-08-01T03:00:00.000Z',
  lastAppliedRunAt: '2026-08-01T03:00:00.000Z',
  consecutiveSkippedRuns: 0,
  lastSkipReason: null,
  ...overrides,
});

const mockFetch = (targets: Record<string, unknown>[]) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(json({ targets })));

const renderPage = () =>
  render(
    <MemoryRouter>
      <TargetsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('TargetsPage', () => {
  it('says what a target is when there are none', async () => {
    // The empty case is the one a fresh install always sees, and an empty
    // table says nothing about what the missing thing would be.
    mockFetch([]);
    renderPage();

    expect(await screen.findByText('No target systems yet')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Connect a target' }),
    ).toBeVisible();
  });

  it('counts the scheduled runs a target has skipped', async () => {
    // Ruling P4. `consecutiveSkippedRuns` was written by the scheduler and
    // read by nothing: a target that has silently stopped provisioning was
    // indistinguishable in this list from one running cleanly.
    mockFetch([target({ consecutiveSkippedRuns: 3, lastSkipReason: 'a run is awaiting review' })]);
    renderPage();

    expect(await screen.findByText('3 scheduled runs skipped')).toBeVisible();
    expect(screen.queryByText('Running cleanly')).toBeNull();
  });

  it('says one run in the singular', async () => {
    mockFetch([target({ consecutiveSkippedRuns: 1, lastSkipReason: 'busy' })]);
    renderPage();

    expect(await screen.findByText('1 scheduled run skipped')).toBeVisible();
  });

  it('reads a clean target as running cleanly', async () => {
    // The other half. A badge that is always red is a badge nobody reads.
    mockFetch([target()]);
    renderPage();

    expect(await screen.findByText('Running cleanly')).toBeVisible();
    expect(screen.queryByText(/skipped/)).toBeNull();
  });

  it('reports a disabled target as disabled rather than as clean', async () => {
    mockFetch([target({ enabled: false })]);
    renderPage();

    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(screen.queryByText('Running cleanly')).toBeNull();
  });

  it('leads with the skipping when a disabled target has also been skipping', async () => {
    // The more surprising of the two wins: a schedule that did not start is a
    // fault, and "disabled" is a decision somebody made on purpose.
    mockFetch([
      target({ enabled: false, consecutiveSkippedRuns: 2, lastSkipReason: 'busy' }),
    ]);
    renderPage();

    expect(await screen.findByText('2 scheduled runs skipped')).toBeVisible();
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('marks an authoritative target differently from an additive one', async () => {
    // Ruling P2: the mode is per target and visible on its own screen.
    // Authoritative is the mode that removes what Provision did not grant, so
    // it is never the quiet one.
    mockFetch([
      target(),
      target({ id: 't2', name: 'Second', enforcementMode: 'authoritative' }),
    ]);
    renderPage();

    const additive = await screen.findByText('additive');
    const authoritative = screen.getByText('authoritative');
    expect(additive.className).not.toBe(authoritative.className);
  });

  it('says a target with no schedule runs by hand only', async () => {
    mockFetch([target({ schedule: null, lastRunAt: null })]);
    renderPage();

    expect(await screen.findByText('By hand only')).toBeVisible();
    expect(screen.getByText('Never run')).toBeVisible();
  });
});
