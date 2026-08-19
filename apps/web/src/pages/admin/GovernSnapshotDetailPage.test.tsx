import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GovernSnapshotDetailPage } from './GovernSnapshotDetailPage.js';

const snapshot = {
  snapshot: {
    id: 's-1',
    asOf: '2026-06-15T09:00:00.000Z',
    status: 'complete',
    holdingCount: 4120,
    unattributableCount: 17,
    coverageGapCount: 2,
    unattributedAccountCount: 3,
    personsWithActiveContract: 1180,
    sources: [
      {
        sourceKind: 'targetSystem',
        sourceId: 'sys-1',
        sourceName: 'Acme AD',
        lastSuccessfulReadAt: '2026-06-06T09:00:00.000Z',
        completeness: 'partial',
        staleness: 'stale',
        ageHours: 216,
        gapCount: 1,
        freshnessSlaHours: 24,
      },
      {
        sourceKind: 'syntraInternal',
        sourceId: 'syntra',
        sourceName: 'Syntra',
        lastSuccessfulReadAt: '2026-06-15T09:00:00.000Z',
        completeness: 'complete',
        staleness: 'fresh',
        ageHours: 0,
        gapCount: 0,
        freshnessSlaHours: 24,
      },
    ],
  },
  gapsByKind: [{ kind: 'resource_unreadable', _count: { _all: 2 } }],
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/govern/snapshots/s-1']}>
      <Routes>
        <Route path="/admin/govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 })),
  );
});

describe('GovernSnapshotDetailPage', () => {
  // The dates are formatted with the VIEWER's locale, so the assertion cannot
  // hardcode "15 June 2026" — under jsdom's default that renders "June 15,
  // 2026" and the case would fail in one region and pass in another. What is
  // being asserted is WHICH DATE appears where, so the expected strings are
  // built from the ISO values with the same options the page uses, and the
  // fifteenth and the sixth are required to land in different places.
  const long = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  const ASSEMBLED = long('2026-06-15T09:00:00.000Z');
  const LAST_READ = long('2026-06-06T09:00:00.000Z');

  it('shows BOTH clocks: the snapshot as-of and each source last successful read', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Acme AD/)).toBeInTheDocument());

    // The snapshot was assembled on the 15th...
    const assembled = screen.getByText(/Assembled/).textContent ?? '';
    expect(assembled).toContain(ASSEMBLED);
    expect(assembled).not.toContain(LAST_READ);

    // ...and the target was last read on the 6th, which is the clock that
    // matters. A page showing only one of these is the defect this catches.
    expect(screen.getByText(new RegExp(LAST_READ))).toBeInTheDocument();
    expect(screen.getByText(/216 hours ago/)).toBeInTheDocument();
    expect(screen.getAllByText(/24-hour SLA/).length).toBeGreaterThan(0);
  });

  it('labels a stale, partial source in words rather than with a colour alone', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Stale')).toBeInTheDocument());
    expect(screen.getByText('Partially read')).toBeInTheDocument();
  });

  it('puts the unattributable count ABOVE the totals', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('17')).toBeInTheDocument());
    const html = document.body.innerHTML;
    expect(html.indexOf('nobody can explain')).toBeLessThan(html.indexOf('4,120'));
  });
});
