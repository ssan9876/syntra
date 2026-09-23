import type { ProvisionActionType } from '@syntra/connectors';

export interface MaintenanceWindowTarget {
  maintenanceWindowEnabled: boolean;
  maintenanceWindowDays: number[];
  maintenanceWindowStartMinute: number | null;
  maintenanceWindowDurationMinutes: number | null;
}

const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** True when `now` falls in any configured UTC interval, including one crossing midnight/week-end. */
export function maintenanceWindowOpen(target: MaintenanceWindowTarget, now = new Date()): boolean {
  if (!target.maintenanceWindowEnabled) return true;
  const start = target.maintenanceWindowStartMinute;
  const duration = target.maintenanceWindowDurationMinutes;
  if (start === null || duration === null || duration < 1) return false;
  const current = now.getUTCDay() * DAY_MINUTES + now.getUTCHours() * 60 + now.getUTCMinutes();
  return target.maintenanceWindowDays.some((day) => {
    const intervalStart = day * DAY_MINUTES + start;
    const elapsed = (current - intervalStart + WEEK_MINUTES) % WEEK_MINUTES;
    return elapsed < duration;
  });
}

const URGENT_LEAVER_ACTIONS = new Set<ProvisionActionType>([
  'revoke_entitlement',
  'disable_account',
  'archive_account',
  'deactivate_syntra_user',
]);

export function urgentLeaverOverrideAllowed(actionTypes: readonly string[]): boolean {
  return actionTypes.length > 0 && actionTypes.every((type) => URGENT_LEAVER_ACTIONS.has(type as ProvisionActionType));
}

export class MaintenanceWindowClosedError extends Error {
  constructor(readonly targetId: string, readonly overrideAllowed: boolean) {
    super(overrideAllowed
      ? `target ${targetId} is outside its maintenance window; a confirmed urgent-leaver override with a reason is available`
      : `target ${targetId} is outside its maintenance window and the selected actions are not eligible for an urgent-leaver override`);
    this.name = 'MaintenanceWindowClosedError';
  }
}
