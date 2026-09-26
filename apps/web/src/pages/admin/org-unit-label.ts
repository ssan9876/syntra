/**
 * The org unit an account's application access resolves through, as the API
 * reports it on `/api/admin/users` and `/api/admin/users/:id`.
 *
 * `source` is where it came from: the account's own unit, or — when the
 * account has none — the unit of the person it is linked to. Optional on the
 * rows that carry it, so a server that predates the field renders as "no
 * unit" rather than breaking.
 */
export interface EffectiveOrgUnit {
  id: string;
  name: string;
  source: 'account' | 'person';
}

/**
 * "IT", or "IT (from the linked person)" when inherited.
 *
 * The suffix is the whole point. An account whose own unit is empty but which
 * is plainly getting IT's applications is a support ticket unless the screen
 * says why, and the why is that app access falls back to the person's unit.
 */
export function orgUnitLabel(unit: EffectiveOrgUnit | null | undefined): string | null {
  if (!unit) return null;
  return unit.source === 'person' ? `${unit.name} (from the linked person)` : unit.name;
}
