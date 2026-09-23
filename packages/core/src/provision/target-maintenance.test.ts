import { describe, expect, it } from 'vitest';
import { maintenanceWindowOpen, urgentLeaverOverrideAllowed } from './target-maintenance.js';

const window = { maintenanceWindowEnabled: true, maintenanceWindowDays: [1], maintenanceWindowStartMinute: 23 * 60, maintenanceWindowDurationMinutes: 120 };

describe('target maintenance windows', () => {
  it('handles a UTC interval crossing midnight', () => {
    expect(maintenanceWindowOpen(window, new Date('2026-09-21T23:30:00Z'))).toBe(true);
    expect(maintenanceWindowOpen(window, new Date('2026-09-22T00:30:00Z'))).toBe(true);
    expect(maintenanceWindowOpen(window, new Date('2026-09-22T01:01:00Z'))).toBe(false);
  });

  it('only permits removal and disable actions in an urgent-leaver override', () => {
    expect(urgentLeaverOverrideAllowed(['revoke_entitlement', 'disable_account'])).toBe(true);
    expect(urgentLeaverOverrideAllowed(['disable_account', 'grant_entitlement'])).toBe(false);
    expect(urgentLeaverOverrideAllowed([])).toBe(false);
  });
});
