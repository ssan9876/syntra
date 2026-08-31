import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PeopleTab } from './PeopleTab.js';

const persons = [
  {
    id: 'p1',
    givenName: 'Jo',
    familyName: 'Doe',
    businessEmail: 'jo@acme.test',
    externalId: 'E1',
    status: 'active',
  },
  {
    id: 'p2',
    givenName: 'Sam',
    familyName: 'Roe',
    businessEmail: null,
    externalId: null,
    status: 'inactive',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const renderTab = () =>
  render(
    <MemoryRouter>
      <PeopleTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <PeopleTab />
    </MemoryRouter>,
  );

describe('PeopleTab, finding somebody', () => {
  it('sends the search from the URL to the API', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ persons: [], total: 0, page: 1, pageSize: 50 }));
    renderAt('/admin/users?tab=people&q=arch');

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('q=arch'),
        expect.anything(),
      ),
    );
  });

  it('distinguishes an empty directory from a search that found nobody', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ persons: [], total: 0, page: 1, pageSize: 50 }),
    );
    renderAt('/admin/users?tab=people&q=zzz');

    expect(await screen.findByText(/Nobody matches/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /clear the search/i }),
    ).toBeVisible();
  });

  it('goes back to page one when the search changes', async () => {
    // Leaving page=7 in the URL strands somebody on an empty table that reads
    // as broken rather than as a narrower search.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ persons: [], total: 0, page: 7, pageSize: 50 }));
    renderAt('/admin/users?tab=people&page=7');

    await user.type(await screen.findByLabelText('Search people'), 'arch');
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      const url = String(fetchSpy.mock.calls.at(-1)?.[0]);
      expect(url).toContain('q=arch');
      expect(url).not.toContain('page=7');
    });
    vi.useRealTimers();
  });
});

describe('PeopleTab', () => {
  it('lists the people the organization knows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    expect(await screen.findByText('Jo Doe')).toBeInTheDocument();
    expect(screen.getByText('Sam Roe')).toBeInTheDocument();
  });

  it('opens the person when their name is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    expect(await screen.findByRole('link', { name: 'Jo Doe' })).toHaveAttribute(
      'href',
      '/admin/people/p1',
    );
  });

  /**
   * The negative half of the person screen's tests. Editing and deactivation
   * live on the record, and an action that exists in both places is an action
   * with two implementations — one of which sits in a table cell with no room
   * to say what it is about to do.
   */
  it('carries no per-row controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    const row = (await screen.findByText('Jo Doe')).closest('tr')!;
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });

  it('labels a deactivated person rather than hiding them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    const row = (await screen.findByText('Sam Roe')).closest('tr')!;
    expect(row).toHaveTextContent(/inactive/i);
  });

  it('shows a missing email and reference as absent, not as blank cells', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    const row = (await screen.findByText('Sam Roe')).closest('tr')!;
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('offers the way to add somebody, which is an action on the list itself', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons }));
    renderTab();

    expect(
      (await screen.findAllByRole('link', { name: /add someone/i }))[0],
    ).toHaveAttribute('href', '/admin/people/new');
  });

  it('names the next action when nobody is recorded yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ persons: [] }));
    renderTab();

    expect(await screen.findByText(/no people yet/i)).toBeInTheDocument();
  });

  /**
   * A 200 without its collection must render an empty table rather than take
   * the console to a blank page. This is the shape a truncated proxy reply or
   * an error document arrives in.
   */
  it('survives a response that arrives without its collection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}));
    renderTab();

    expect(await screen.findByText(/no people yet/i)).toBeInTheDocument();
  });

  it('surfaces a refusal as a message, not a blank page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ title: 'Forbidden', status: 403 }, 403),
    );
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /do not have permission/i,
    );
  });
});
