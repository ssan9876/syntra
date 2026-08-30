import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PersonSourcesTab } from './PersonSourcesTab.js';

const source = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'HR nightly',
  type: 'sftpDelimited',
  feedMode: 'snapshot',
  schedule: '0 2 * * *',
  autoApply: false,
  enabled: true,
  lastRunAt: '2026-08-29T02:00:00.000Z',
  config: {
    host: 'hr.example.test',
    remotePath: '/export/people.csv',
    hostKeyFingerprint: 'SHA256:abc',
  },
  ...over,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(sources: Record<string, unknown>[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ sources })),
  );
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <PersonSourcesTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('PersonSourcesTab', () => {
  it('lists a source with where its file lives', async () => {
    mockFetch([source()]);
    renderTab();

    expect(await screen.findByText('HR nightly')).toBeVisible();
    expect(screen.getByText('hr.example.test:/export/people.csv')).toBeVisible();
  });

  /**
   * The setting that decides whether somebody missing from tomorrow's file is
   * a leaver, shown across every source at once rather than only in the
   * editor.
   */
  it('says what the file contains, in the words the choice was made in', async () => {
    mockFetch([source(), source({ id: 's2', name: 'Weekly delta', feedMode: 'delta' })]);
    renderTab();

    expect(await screen.findByText('Everyone employed')).toBeVisible();
    expect(screen.getByText('Changes only')).toBeVisible();
  });

  /**
   * A source with no pinned key is configured but inert: `read` refuses
   * without one, so its schedule would fire and fail every night. Saying so
   * here turns a recurring failed run into something somebody can fix.
   */
  it('flags a source whose host key was never accepted', async () => {
    mockFetch([source({ config: { host: 'hr.example.test', remotePath: '/f.csv' } })]);
    renderTab();
    expect(await screen.findByText('Host key not accepted')).toBeVisible();
  });

  it('shows a pinned, enabled source as enabled', async () => {
    mockFetch([source()]);
    renderTab();
    expect(await screen.findByText('Enabled')).toBeVisible();
  });

  /**
   * Disabled beats unpinned: an administrator who switched a source off does
   * not need to be told its key is missing too.
   */
  it('shows a disabled source as disabled, whatever its key', async () => {
    mockFetch([source({ enabled: false, config: { host: 'h', remotePath: '/f' } })]);
    renderTab();
    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(screen.queryByText('Host key not accepted')).toBeNull();
  });

  it('says a source has never run rather than leaving the cell blank', async () => {
    mockFetch([source({ lastRunAt: null })]);
    renderTab();
    expect(await screen.findByText('Never run')).toBeVisible();
  });

  it('says a source with no schedule is manual only', async () => {
    mockFetch([source({ schedule: null })]);
    renderTab();
    expect(await screen.findByText('Manual only')).toBeVisible();
  });

  it('shows an empty state naming the next action', async () => {
    mockFetch([]);
    renderTab();
    expect(await screen.findByText('No HR feeds yet')).toBeVisible();
    expect(screen.getByRole('link', { name: /new HR feed/i })).toBeVisible();
  });

  it('falls back to a dash when a source names no host', async () => {
    mockFetch([source({ config: {} })]);
    renderTab();
    expect(await screen.findByText('—')).toBeVisible();
  });
});
