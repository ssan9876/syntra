import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GovernRuleCandidates } from './GovernRuleCandidates.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

const candidate = (over: Record<string, unknown> = {}) => ({
  field: 'department',
  value: 'Finance',
  resourceKey: 'targetEntitlement:fin-read',
  resourceName: 'Finance — read only',
  holders: 9,
  population: 10,
  confidence: 0.9,
  outsideHolders: 0,
  ...over,
});

describe('GovernRuleCandidates', () => {
  it('mines nothing until asked', () => {
    const spy = vi.fn(async () => ok({ candidates: [] }));
    vi.stubGlobal('fetch', spy);
    render(<GovernRuleCandidates snapshotId="snap-1" />);
    // Mining reads every holding in the snapshot. Somebody opening a snapshot
    // to check its freshness must not pay for that.
    expect(spy).not.toHaveBeenCalled();
  });

  it('states the rule as a sentence, with both sides of the arithmetic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ candidates: [candidate()] })));
    render(<GovernRuleCandidates snapshotId="snap-1" />);
    await userEvent.click(screen.getByRole('button', { name: /look for rules/i }));

    expect(await screen.findByText(/Everyone whose department is/i)).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Finance — read only')).toBeInTheDocument();
    // The fraction, not only the percentage: 90% hides whether it is nine of
    // ten or nine hundred of a thousand, and those are different claims.
    expect(screen.getByText('9 of 10')).toBeInTheDocument();
  });

  it('says how many hold it for unrelated reasons', async () => {
    // The half a confidence figure hides. At 100% over six people, with forty
    // others holding the same thing, the candidate describes six people and
    // not the resource — and the row has to say so.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({ candidates: [candidate({ holders: 6, population: 6, confidence: 1, outsideHolders: 40 })] }),
      ),
    );
    render(<GovernRuleCandidates snapshotId="snap-1" />);
    await userEvent.click(screen.getByRole('button', { name: /look for rules/i }));

    expect(await screen.findByText(/40 others, for other reasons/)).toBeInTheDocument();
  });

  it('says plainly when there is no pattern rather than showing an empty table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ candidates: [] })));
    render(<GovernRuleCandidates snapshotId="snap-1" />);
    await userEvent.click(screen.getByRole('button', { name: /look for rules/i }));

    expect(await screen.findByText(/No pattern strong enough/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
