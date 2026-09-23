import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DuplicateReviewsTab, type DuplicateReview } from './DuplicateReviewsTab.js';

const review: DuplicateReview = {
  id: '11111111-1111-4111-8111-111111111111', changeId: 'change-1', matchedValue: 'ada@example.test',
  change: { id: 'change-1', externalId: 'EMP-2', status: 'needs_review', after: { givenName: 'Ada', familyName: 'Byron', businessEmail: 'ada@example.test' } },
  candidatePerson: { id: 'person-1', givenName: 'Ada', familyName: 'Lovelace', businessEmail: 'ada@example.test', externalId: 'EMP-1' },
  run: { id: 'run-1', sourceId: 'source-1', startedAt: '2026-09-23T12:00:00Z' },
  affectedChanges: [
    { id: 'change-1', changeType: 'create_person', recordType: 'person', status: 'needs_review' },
    { id: 'change-2', changeType: 'create_contract', recordType: 'contract', status: 'proposed' },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('DuplicateReviewsTab', () => {
  it('requires an audit note and resolves without offering a merge', async () => {
    const reload = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<MemoryRouter><DuplicateReviewsTab reviews={[review]} loading={false} error={null} reload={reload} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Keep as separate people' }));
    expect(screen.getByText(/at least 10 characters/)).toBeVisible();
    await userEvent.type(screen.getByLabelText('Decision note'), 'Different employees confirmed');
    await userEvent.click(screen.getByRole('button', { name: 'Keep as separate people' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ resolution: 'keep_separate', note: 'Different employees confirmed' });
  });
});
