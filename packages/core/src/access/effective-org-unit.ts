import type { TenantClient } from '@syntra/db';

/**
 * Where a login's org unit for ACCESS came from.
 *
 * - `account`: the login's own `User.orgUnitId`, set on the account itself.
 * - `person`: inherited from the linked person's `Person.orgUnitId`.
 *
 * Carried alongside the id rather than collapsed into it, because "why does
 * this login reach CRM" is a question an administrator asks, and "because the
 * person behind it is in IT" is an answer they cannot reconstruct from the
 * account screen, where the account's own unit reads as empty.
 */
export type OrgUnitSource = 'account' | 'person';

export interface EffectiveOrgUnit {
  orgUnitId: string;
  source: OrgUnitSource;
}

export interface EffectiveOrgUnitOptions {
  /**
   * Whether an INACTIVE person may still pass their unit down. Default false.
   *
   * Access resolution, claims and audiences all answer "what may this login
   * reach now", and a deactivated person reaches nothing through the person
   * path: the same rule `orgUnitChain` applies to a deactivated unit and
   * `listActiveGroupsForUser` applies to a deactivated group. A login's OWN
   * unit is not gated on the person, because it never went through them.
   *
   * An access review is the one caller that passes true. Its question is
   * "whose holdings are in this part of the organisation", and a leaver's
   * leftover holdings are exactly what a review exists to catch — gating them
   * out would make an org-scoped campaign blind to the people it most needs
   * to see.
   */
  includeInactivePerson?: boolean;
}

/**
 * The org unit that decides a login's org-unit access: its own, or its
 * person's.
 *
 * WHY THIS EXISTS. `User.orgUnitId` (the login) and `Person.orgUnitId` (the
 * human) are separate columns — see the schema comment on `Person.orgUnitId`.
 * Placement reads the person's; access resolution used to read only the
 * login's. On a real install people are placed in units (it drives where the
 * directory writes their account) and logins are left with none, so an
 * application assigned to "IT" reached nobody in IT, silently: no error, no
 * audit, just a portal without the tile.
 *
 * The rule: a login's own unit WINS when it is set, because somebody set it on
 * the account deliberately — a contractor's login kept in "Contractors" while
 * their person sits in the team they work for. Only when the login has none
 * does the linked person's unit apply. A login with no person inherits
 * nothing; a service account is the usual case, and it should not pick up a
 * unit from nobody.
 *
 * Pure, so the single-login path (`effectiveOrgUnitForUser`) and the
 * set-based tenant-wide paths (Govern, Automate) share one definition rather
 * than three that drift.
 */
export function effectiveOrgUnit(
  user: { orgUnitId: string | null },
  person: { orgUnitId: string | null; status: string } | null,
  options: EffectiveOrgUnitOptions = {},
): EffectiveOrgUnit | null {
  if (user.orgUnitId !== null) return { orgUnitId: user.orgUnitId, source: 'account' };
  if (person === null || person.orgUnitId === null) return null;
  if (person.status !== 'active' && options.includeInactivePerson !== true) return null;
  return { orgUnitId: person.orgUnitId, source: 'person' };
}

/** `effectiveOrgUnit` for one login, read from the database. Two indexed reads at most. */
export async function effectiveOrgUnitForUser(
  tx: TenantClient,
  userId: string,
  options: EffectiveOrgUnitOptions = {},
): Promise<EffectiveOrgUnit | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { orgUnitId: true, personId: true },
  });
  if (!user) return null;
  // The person is read only when it can change the answer: a login with its
  // own unit never consults them, which is the sign-in path's common case on
  // an install that sets units on accounts.
  const person =
    user.orgUnitId === null && user.personId !== null
      ? await tx.person.findUnique({
          where: { id: user.personId },
          select: { orgUnitId: true, status: true },
        })
      : null;
  return effectiveOrgUnit(user, person, options);
}

/**
 * `effectiveOrgUnit` for many logins in ONE extra query, for the set-based
 * callers whose query count is fixed by design (Govern's snapshot, Automate's
 * tenant-wide audience facts). Keyed by user id; a login with no effective
 * unit is absent from the map rather than present as null.
 */
export async function effectiveOrgUnitsForUsers(
  tx: TenantClient,
  users: readonly { id: string; orgUnitId: string | null; personId: string | null }[],
  options: EffectiveOrgUnitOptions = {},
): Promise<Map<string, EffectiveOrgUnit>> {
  const personIds = [
    ...new Set(
      users
        .filter((u) => u.orgUnitId === null && u.personId !== null)
        .map((u) => u.personId!),
    ),
  ];
  const persons =
    personIds.length === 0
      ? []
      : await tx.person.findMany({
          where: { id: { in: personIds } },
          select: { id: true, orgUnitId: true, status: true },
        });
  const personById = new Map(persons.map((p) => [p.id, p]));

  const out = new Map<string, EffectiveOrgUnit>();
  for (const user of users) {
    const person = user.personId === null ? null : (personById.get(user.personId) ?? null);
    const unit = effectiveOrgUnit(user, person, options);
    if (unit !== null) out.set(user.id, unit);
  }
  return out;
}
