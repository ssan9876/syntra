import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { UpdatesPage } from './UpdatesPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  }) as never;

const availability = (over: Record<string, unknown> = {}) => ({
  current: '1.4.0',
  updatable: true,
  reason: null,
  updateAvailable: true,
  latest: {
    version: '1.5.0',
    released: '2026-08-24T19:02:11Z',
    notes: 'Directory write-back.',
    migrations: [],
  },
  progress: null,
  ...over,
});

const readyPreflight = {
  target: '1.5.0',
  ready: true,
  releases: [{ version: '1.5.0', released: '2026-08-24T19:02:11Z', notes: 'Directory write-back.' }],
  checks: [{ id: 'release-files', status: 'pass', title: 'Release files', detail: 'syntra-1.5.0.tar.gz and its checksum are published.' }],
};

/** GET /update returns `body`, the checks `preflight`; every POST returns 202. */
function mockApi(body: unknown, onPost?: (init: RequestInit) => Response, preflight: unknown = readyPreflight) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if ((init as RequestInit | undefined)?.method === 'POST') {
      return Promise.resolve(onPost?.(init as RequestInit) ?? json({ started: true }, 202));
    }
    if (String(input).endsWith('/update/preflight')) return Promise.resolve(json(preflight));
    return Promise.resolve(json(body));
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe('UpdatesPage', () => {
  it('shows the running version and what is available', async () => {
    mockApi(availability());
    render(<UpdatesPage />);

    expect(await screen.findByText('1.4.0')).toBeInTheDocument();
    expect(screen.getByText('1.5.0')).toBeInTheDocument();
    expect(screen.getByText(/Directory write-back/)).toBeInTheDocument();
  });

  it('says so when this is already the newest release', async () => {
    mockApi(
      availability({
        updateAvailable: false,
        latest: { version: '1.4.0', released: null, notes: '', migrations: [] },
      }),
    );
    render(<UpdatesPage />);

    expect(await screen.findByText(/This is the newest release/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update to/i })).toBeNull();
  });

  /**
   * A developer checkout being un-updatable is the CORRECT state for a
   * developer checkout. Colouring it as an error teaches people to ignore
   * errors.
   */
  it('explains a working tree without treating it as a failure', async () => {
    mockApi(
      availability({
        current: 'dev',
        updatable: false,
        reason: 'this install is a working tree rather than a release; use deploy.sh',
        updateAvailable: false,
        latest: null,
      }),
    );
    render(<UpdatesPage />);

    // The explanation carries somewhere to go, which the old dead-end copy
    // did not.
    expect(await screen.findByText(/use deploy\.sh/)).toBeInTheDocument();
    expect(screen.getByText(/Not updatable from here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update to/i })).toBeNull();
  });

  /**
   * The confirmation names the consequences in order. Above all the downtime:
   * an update button that implies none is one people press at eleven on a
   * Tuesday morning.
   */
  it('states the downtime and the automatic rollback before committing', async () => {
    mockApi(availability());
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));

    expect(screen.getByText(/Sign-in unavailable for about a minute/i)).toBeInTheDocument();
    expect(screen.getByText(/Back up the database; stop if that fails/i)).toBeInTheDocument();
    expect(screen.getByText(/Roll back to 1\.4\.0 automatically/i)).toBeInTheDocument();
  });

  it('does not start anything until the confirmation is taken', async () => {
    const fetch = mockApi(availability());
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));

    expect(fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('posts the version the operator was shown, not "latest"', async () => {
    const fetch = mockApi(availability());
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
    await userEvent.click(screen.getByRole('button', { name: /^update now$/i }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ version: '1.5.0' });
    });
  });

  /**
   * A FAILED LOOKUP IS NOT AN EMPTY ONE.
   *
   * Both used to render as "Nothing to show" with the reason beneath, so a
   * deployment whose token had been revoked looked exactly like one already
   * on the newest release. The heading is what a reader takes away, and it
   * was telling four different faults and one healthy state apart for nobody.
   */
  it('says the check failed, rather than that there is nothing', async () => {
    mockApi(
      availability({
        latest: null,
        updateAvailable: false,
        reason: 'the forge refused the request (403)',
      }),
    );
    render(<UpdatesPage />);

    expect(await screen.findByText(/could not check for updates/i)).toBeInTheDocument();
    expect(screen.getByText(/refused the request \(403\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to show/i)).not.toBeInTheDocument();
  });

  it('surfaces the reason the server refused', async () => {
    mockApi(availability(), () =>
      json(
        {
          type: 'https://syntra.dev/problems/not-newer',
          title: 'That version is not newer',
          status: 422,
          detail: 'Running 1.4.0; 1.5.0 is not newer.',
        },
        422,
      ),
    );
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
    await userEvent.click(screen.getByRole('button', { name: /^update now$/i }));

    expect(await screen.findByText(/1.5.0 is not newer/)).toBeInTheDocument();
  });

  it('reports the step an update is on in words', async () => {
    mockApi(
      availability({
        progress: { step: 'migrating', detail: 'applying migrations', at: null, running: true },
      }),
    );
    render(<UpdatesPage />);

    expect(await screen.findByText(/Applying database changes/)).toBeInTheDocument();
  });

  /**
   * The outcome this whole design exists to make possible: the update failed,
   * and the system put itself back without anybody being awake.
   */
  it('explains a rollback as a completed recovery, not a disaster', async () => {
    mockApi(
      availability({
        updateAvailable: false,
        progress: {
          step: 'rolled_back',
          detail: 'v1.5.0 did not become ready within 90s; restored v1.4.0',
          at: null,
          running: false,
        },
      }),
    );
    render(<UpdatesPage />);

    expect(await screen.findByText(/Update rolled back/)).toBeInTheDocument();
    expect(screen.getByText(/Changes made during the update are lost/)).toBeInTheDocument();
  });

  /**
   * The middle of a SUCCESSFUL update looks exactly like a broken API, because
   * the API is restarting. Reporting that as an error would put a red banner
   * on every update that ever works.
   */
  it('treats the server going away mid-update as the restart, not a failure', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return Promise.resolve(json({ started: true }, 202));
      }
      calls += 1;
      // The first load succeeds; everything after the restart fails.
      return calls === 1
        ? Promise.resolve(json(availability()))
        : Promise.reject(new TypeError('Failed to fetch'));
    });

    render(<UpdatesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
    await userEvent.click(screen.getByRole('button', { name: /^update now$/i }));

    expect(await screen.findByText(/Syntra is restarting/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  /**
   * THE ONE THAT MADE THE PAGE LIE.
   *
   * After a 202 the page used to call load() immediately. That request SUCCEEDS
   * -- the API is still up, the restart has not happened -- so `restarting`
   * cleared, and with no status file written yet the page decided nothing was
   * running and cleared its interval for good. It then sat there, static, with
   * the button enabled, while the update restarted the server; a second click
   * launched a second updater that lost the lock.
   *
   * The fix is that a page which has just LAUNCHED an update keeps polling until
   * it sees a terminal step, whatever the first poll happens to catch.
   */
  it('keeps polling after a 202 even when no status file exists yet', async () => {
    const fetchSpy = mockApi(availability({ progress: null }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
    await userEvent.click(screen.getByRole('button', { name: /update now/i }));

    const afterLaunch = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);

    // Three ticks at three seconds. The old page made zero: it had already
    // cleared the interval.
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterLaunch);
    // And it polls the CHEAP route, which does not go to GitHub.
    const polled = fetchSpy.mock.calls.at(-1)![0];
    expect(String(polled)).toBe('/api/admin/update/status');
  });

  it('does not offer the button again while an update it launched is running', async () => {
    mockApi(availability({ progress: null }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<UpdatesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
    await userEvent.click(screen.getByRole('button', { name: /update now/i }));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(screen.queryByRole('button', { name: /update to 1\.5\.0/i })).toBeNull();
  });

  it('lists the checks before updating, with every release it installs', async () => {
    mockApi(availability({ current: '1.3.0' }), undefined, {
      target: '1.5.0',
      ready: true,
      releases: [
        { version: '1.4.0', released: '2026-08-01T00:00:00Z', notes: 'Older notes.' },
        { version: '1.5.0', released: '2026-08-24T19:02:11Z', notes: 'Directory write-back.' },
      ],
      checks: [
        { id: 'releases', status: 'info', title: 'Releases', detail: '2 releases since 1.3.0. Their notes are below.', items: ['1.4.0', '1.5.0'] },
        { id: 'migrations', status: 'info', title: 'Database changes', detail: '1 change. The update backs up the database first.', items: ['20260801000000_x: adds a table. Does not rewrite data.'] },
        { id: 'backups', status: 'warn', title: 'Backups', detail: 'Last backup 3 days ago. Select Back up now on the Backups page first.', href: '/admin/backups' },
      ],
    });
    render(<MemoryRouter><UpdatesPage /></MemoryRouter>);

    const checks = await screen.findByRole('list', { name: 'Update checks' });
    const rows = within(checks).getAllByRole('listitem').filter((item) => item.parentElement === checks);
    expect(rows[1]).toHaveTextContent('20260801000000_x: adds a table. Does not rewrite data.');
    expect(rows[2]).toHaveTextContent('Check');
    expect(within(rows[2]!).getByRole('link', { name: 'Go to Backups' })).toHaveAttribute('href', '/admin/backups');
    expect(screen.getByText('1.4.0 release notes')).toBeInTheDocument();
    expect(screen.getByText('Older notes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update to 1.5.0' })).toBeEnabled();
  });

  it('holds the update while a check is blocked, and checks again on request', async () => {
    const blocked = {
      ...readyPreflight,
      ready: false,
      checks: [{ id: 'disk', status: 'fail', title: 'Disk space', detail: '0.5 GB free on /opt/syntra. An update needs about 1 GB. Free space, then check again.' }],
    };
    const fetch = mockApi(availability(), undefined, blocked);
    render(<MemoryRouter><UpdatesPage /></MemoryRouter>);

    expect(await screen.findByText(/0.5 GB free on \/opt\/syntra/)).toBeInTheDocument();
    expect(screen.getByText('Fix the blocked check first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update to 1.5.0' })).toBeDisabled();

    fetch.mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('/update/preflight') ? json(readyPreflight) : json(availability())),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update to 1.5.0' })).toBeEnabled());
    expect(screen.queryByText('Fix the blocked check first.')).toBeNull();
  });
});
