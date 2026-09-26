import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetWriteStopPanel } from './TargetWriteStopPanel.js';
import type { Target } from './target-form.js';

const target = (over: Partial<Target> = {}): Target => ({
  id: 'target-1', name: 'Directory', type: 'activeDirectory', config: {}, enabled: true, autoApply: false,
  schedule: null, enforcementMode: 'additive', preHireDays: 0, entitlementRevocationDelayDays: 0,
  disableGraceDays: 0, archiveAfterDays: null, reenableWithoutConfirmationDays: 7, renameEnabled: false,
  createAccountThresholdPercent: 20, disableAccountThresholdPercent: 10, archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10, deactivateSyntraUserThresholdPercent: 10, perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20, maxAttempts: 3, consecutiveSkippedRuns: 0, lastSkipReason: null,
  externalWritesPausedAt: null, externalWritesPausedByUserId: null, externalWritesPauseReason: null,
  externalWritesPauseExpiresAt: null, externalWritesResumedAt: null, externalWritesResumedByUserId: null,
  maintenanceWindowEnabled: false, maintenanceWindowDays: [], maintenanceWindowStartMinute: null,
  maintenanceWindowDurationMinutes: null, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('TargetWriteStopPanel', () => {
  it('stops writes only with a reason', async () => {
    const changed = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<TargetWriteStopPanel target={target()} onChanged={changed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop writes' }));
    const button = screen.getByRole('button', { name: 'Stop external writes' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for stopping writes'), 'Unexpected writes');
    await userEvent.click(button);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ reason: 'Unexpected writes', expiresAt: null });
  });

  it('shows the stopped state and the four-eyes resume requirement', () => {
    render(<TargetWriteStopPanel target={target({
      externalWritesPausedAt: '2026-09-23T12:00:00Z', externalWritesPausedByUserId: 'user-1',
      externalWritesPauseReason: 'Incident containment', externalWritesPauseExpiresAt: null,
    })} onChanged={() => undefined} />);
    expect(screen.getByText('Provisioning writes are stopped')).toBeVisible();
    expect(screen.getByText('Needs another administrator')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request reviewed resume' })).toBeDisabled();
  });
});
