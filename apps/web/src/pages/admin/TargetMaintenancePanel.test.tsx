import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetMaintenancePanel } from './TargetMaintenancePanel.js';
import type { Target } from './target-form.js';

const target = (): Target => ({
  id: 'target-1', name: 'Directory', type: 'activeDirectory', config: {}, enabled: true, autoApply: false,
  schedule: null, enforcementMode: 'additive', preHireDays: 0, entitlementRevocationDelayDays: 0,
  disableGraceDays: 0, archiveAfterDays: null, reenableWithoutConfirmationDays: 7, renameEnabled: false,
  createAccountThresholdPercent: 20, disableAccountThresholdPercent: 10, archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10, deactivateSyntraUserThresholdPercent: 10, perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20, maxAttempts: 3, consecutiveSkippedRuns: 0, lastSkipReason: null,
  externalWritesPausedAt: null, externalWritesPausedByUserId: null, externalWritesPauseReason: null,
  externalWritesPauseExpiresAt: null, externalWritesResumedAt: null, externalWritesResumedByUserId: null,
  maintenanceWindowEnabled: false, maintenanceWindowDays: [], maintenanceWindowStartMinute: null,
  maintenanceWindowDurationMinutes: null,
});

afterEach(() => vi.restoreAllMocks());

describe('TargetMaintenancePanel', () => {
  it('validates days and saves a UTC window', async () => {
    const changed = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<TargetMaintenancePanel target={target()} onChanged={changed} />);
    await userEvent.click(screen.getByLabelText('Restrict external writes to a UTC maintenance window'));
    await userEvent.click(screen.getByRole('button', { name: 'Save maintenance window' }));
    expect(screen.getByText('Select at least one UTC day.')).toBeVisible();
    await userEvent.click(screen.getByLabelText('Monday'));
    await userEvent.clear(screen.getByLabelText('Starts at (UTC)'));
    await userEvent.type(screen.getByLabelText('Starts at (UTC)'), '23:30');
    await userEvent.click(screen.getByRole('button', { name: 'Save maintenance window' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      maintenanceWindow: { enabled: true, days: [1], startMinute: 1410, durationMinutes: 120 },
    });
  });
});
