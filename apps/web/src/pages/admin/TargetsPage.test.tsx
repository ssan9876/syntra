import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TargetsPage } from './TargetsPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

/**
 * Fixtures dated relative to the real clock, not a frozen one.
 *
 * Every judgement this page makes about a target is a judgement about how long
 * ago something happened, so the fixture has to be positioned against the same
 * clock the component reads. Freezing time with `vi.useFakeTimers` is the
 * obvious move and the wrong one: `findBy*` polls on a timer, so a frozen
 * clock makes every query in this file time out.
 */
const hoursAgo = (n: number) =>
  new Date(Date.now() - n * 60 * 60 * 1000).toISOString();

const target = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Samba AD',
  type: 'activeDirectory',
  enabled: true,
  enforcementMode: 'additive',
  schedule: '0 3 * * *',
  lastRunAt: hoursAgo(6),
  lastAppliedRunAt: hoursAgo(6),
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
    expect(screen.queryByText(/^Ran /)).toBeNull();
  });

  it('says one run in the singular', async () => {
    mockFetch([target({ consecutiveSkippedRuns: 1, lastSkipReason: 'busy' })]);
    renderPage();

    expect(await screen.findByText('1 scheduled run skipped')).toBeVisible();
  });

  it('reads a target that completed a run within its schedule as healthy', async () => {
    // The other half. A badge that is always red is a badge nobody reads.
    mockFetch([target()]);
    renderPage();

    expect(await screen.findByText('Ran 6 hours ago')).toBeVisible();
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(screen.queryByText(/No completed run/)).toBeNull();
  });

  it('does not call a target healthy because nothing skipped, when every run fails', async () => {
    // The defect this badge was rewritten for. `runProvisionJob` zeroes
    // `consecutiveSkippedRuns` when a run STARTS, before the preview is
    // attempted, and `run-service.ts` writes `lastRunAt` only when a preview
    // FINISHES. A target whose bind credential was rotated therefore reports
    // zero skipped runs for ever while never completing a run — and the old
    // badge read that as `Running cleanly`.
    mockFetch([
      target({
        schedule: '0 3 * * *',
        consecutiveSkippedRuns: 0,
        lastRunAt: hoursAgo(24 * 9),
      }),
    ]);
    renderPage();

    expect(await screen.findByText('No completed run for 9 days')).toBeVisible();
    expect(screen.queryByText(/^Ran /)).toBeNull();
  });

  it('measures lateness against the target’s own cadence, not a fixed window', async () => {
    // Six days without a run is a fault on a nightly schedule and entirely
    // ordinary on a weekly one, so one window for both would either shout at
    // the weekly target or stay quiet about the nightly one.
    mockFetch([
      target({ id: 'nightly', name: 'Nightly', schedule: '0 3 * * *', lastRunAt: hoursAgo(24 * 6) }),
      target({ id: 'weekly', name: 'Weekly', schedule: '0 3 * * 1', lastRunAt: hoursAgo(24 * 6) }),
    ]);
    renderPage();

    expect(await screen.findByText('No completed run for 6 days')).toBeVisible();
    expect(screen.getByText('Ran 6 days ago')).toBeVisible();
  });

  it('reports a scheduled target that has never completed a run', async () => {
    mockFetch([target({ lastRunAt: null })]);
    renderPage();

    expect(await screen.findByText('No run has ever completed')).toBeVisible();
  });

  it('keeps the last-run timestamp visible on every screen size', async () => {
    // It is the evidence the badge's judgement is made from. Hidden on small
    // screens, the badge could not be contradicted by anything on the page.
    mockFetch([target()]);
    renderPage();

    const heading = await screen.findByRole('columnheader', { name: 'Last run' });
    expect(heading.className).not.toMatch(/max-sm:hidden/);
  });

  it('reports a disabled target as disabled rather than as clean', async () => {
    mockFetch([target({ enabled: false })]);
    renderPage();

    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(screen.queryByText(/^Ran /)).toBeNull();
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

  it('badges each target with its connector type', async () => {
    mockFetch([
      target(),
      target({ id: 't2', name: 'Example SaaS', type: 'scim2' }),
    ]);
    renderPage();

    expect(await screen.findByText('Active Directory')).toBeVisible();
    expect(screen.getByText('SCIM 2.0')).toBeVisible();
  });

  it('says a target with no schedule runs by hand only', async () => {
    mockFetch([target({ schedule: null, lastRunAt: null })]);
    renderPage();

    expect(await screen.findByText('By hand only')).toBeVisible();
    // Twice: once in the Last run column, once in the badge — and nothing is
    // late when nothing is scheduled, so neither is red.
    expect(screen.getAllByText('Never run')).toHaveLength(2);
  });

  it('does not call an unscheduled target late however long it has been', async () => {
    mockFetch([target({ schedule: null, lastRunAt: hoursAgo(24 * 90) })]);
    renderPage();

    expect(await screen.findByText('Ran 90 days ago')).toBeVisible();
    expect(screen.queryByText(/No completed run/)).toBeNull();
  });
});
