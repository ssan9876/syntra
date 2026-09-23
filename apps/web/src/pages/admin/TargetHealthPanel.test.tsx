import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetHealthPanel } from './TargetHealthPanel.js';

const payload = {
  totals: { readinessChecks: 3, readinessFailures: 1, authenticationFailures: 1, provisionActions: 8, failedActions: 1, ambiguousActions: 1, throttledActions: 2, retries: 4, readBackChecks: 5, incompleteReadBacks: 1 },
  series: [{ date: '2026-09-22', readinessChecks: 3, readinessFailures: 1, authenticationFailures: 1, averageLatencyMs: 72, p95LatencyMs: 120, provisionActions: 8, failedActions: 1, ambiguousActions: 1, throttledActions: 2, retries: 4, readBackChecks: 5, incompleteReadBacks: 1 }],
};

afterEach(() => vi.restoreAllMocks());

describe('TargetHealthPanel', () => {
  it('shows actionable totals and reloads when the operator changes the UTC window', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    render(<TargetHealthPanel targetId="target-1" />);
    expect(await screen.findByText('Authentication failures')).toBeVisible();
    expect(screen.getByText('20%')).toBeVisible();
    expect(screen.getByText('72 / 120 ms')).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('Period'), '7');
    expect(fetch).toHaveBeenLastCalledWith('/api/admin/targets/target-1/health-series?days=7', expect.anything());
  });
});
