import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GroupsPage } from './GroupsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

/**
 * The list and the summary are separate reads, so a test that answers both with
 * the same body would let a page that asked the wrong one still pass.
 */
function mockReads(
  groups: Record<string, unknown>[],
  summary = { groups: { total: groups.length, fromDirectory: 0, inactive: 0 } },
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      String(input).includes('/groups/summary')
        ? json(summary)
        : json({ groups, total: groups.length, page: 1, pageSize: 50 }),
    ),
  );
}

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <GroupsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('GroupsPage', () => {
  it('sends the search from the URL to the API', async () => {
    const fetchSpy = mockReads([]);
    renderAt('/admin/groups?q=payroll');

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/groups?q=payroll'),
        expect.anything(),
      ),
    );
  });

  it('offers the status filter its own inactive card advertises', async () => {
    // A group has always had a status -- deactivating one sets it, and the
    // card above this list counts them -- so the list that could not be
    // filtered by it was showing a number with nowhere to go.
    mockReads([]);
    renderAt('/admin/groups');

    await screen.findByLabelText('Search groups');
    expect(screen.getByLabelText('Status')).toBeVisible();
  });

  it('sends the status from the URL to the API', async () => {
    const fetchSpy = mockReads([]);
    renderAt('/admin/groups?status=inactive');

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('status=inactive'),
        expect.anything(),
      ),
    );
  });

  it('reads its counts from the groups summary, which needs no identity permission', async () => {
    // The combined directory summary demands identity.read as well, so a
    // group administrator got a 403 and three confident zeroes above a table
    // listing thousands of groups.
    const fetchSpy = mockReads([]);
    renderAt('/admin/groups');

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/groups/summary'),
        expect.anything(),
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/directory/summary'),
      expect.anything(),
    );
  });

  it('says when a search matches no group, and offers to clear it', async () => {
    mockReads([]);
    renderAt('/admin/groups?q=zzz');

    expect(await screen.findByText(/No group matches/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /clear the search/i }),
    ).toBeVisible();
  });

  it('counts every group, not the page it is showing', async () => {
    // The cards used to filter the fetched array. Paging would have made them
    // describe fifty rows while still reading as totals.
    mockReads([{ id: 'g1', name: 'Payroll', description: null, status: 'active', sourceId: null }], {
      groups: { total: 4312, fromDirectory: 900, inactive: 7 },
    });
    renderAt('/admin/groups');

    // Unformatted, as every other StatCard in the console renders its number.
    expect(await screen.findByText('4312')).toBeVisible();
    expect(screen.getByText('900')).toBeVisible();
    expect(screen.getByText('7')).toBeVisible();
  });
});
