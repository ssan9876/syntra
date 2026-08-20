import type { ResourceKind, SystemKind } from './types.js';

/**
 * The §5 dispatch table, as a pure function.
 *
 * Every campaign decision of `revoke`, and every SoD remediation, resolves to
 * PRECISELY ONE of these outcomes, chosen by what the holding's attribution set
 * contains. THE LAST FOUR ARE NOT REVOCATIONS AND NO REPORT CALLS THEM ONE.
 *
 * §7 says a revoke on a holding with three attributions "removes at most the
 * ones Govern can dispatch, and the report has to say which". Exactly one route
 * still holds: where the route is a `requires_change`, `notRemoved` names every
 * attribution that survives, and the remediation item and the report both carry
 * it. Dispatching a partial removal under one decision would produce exactly
 * the subtly-wrong report this module must not produce — access removed from
 * one path and re-granted from another by morning.
 */

export type RevocationRoute =
  | 'automate_grant'
  | 'revocation_order'
  | 'requires_change_rule'
  | 'requires_change_role'
  | 'requires_change_directory_source'
  | 'requires_change_direct_assignment'
  | 'requires_change_account'
  | 'requires_change_syntra_user';

export const REVOCATION_ROUTES: readonly RevocationRoute[] = [
  'automate_grant',
  'revocation_order',
  'requires_change_rule',
  'requires_change_role',
  'requires_change_directory_source',
  'requires_change_direct_assignment',
  'requires_change_account',
  'requires_change_syntra_user',
];

export const DISPATCHABLE_ROUTES: readonly RevocationRoute[] = [
  'automate_grant',
  'revocation_order',
];

/**
 * Keyed on the route, so a route added later without a remediation kind is a
 * COMPILE ERROR rather than a silent fall-back to
 * `direct_assignment_change_required`.
 */
export const ROUTE_REMEDIATION_KIND: Readonly<Record<RevocationRoute, string | null>> = {
  automate_grant: null,
  revocation_order: null,
  requires_change_rule: 'rule_change_required',
  requires_change_role: 'role_assignment_change_required',
  requires_change_directory_source: 'directory_source_change_required',
  requires_change_direct_assignment: 'direct_assignment_change_required',
  requires_change_account: 'account_removal_required',
  requires_change_syntra_user: 'syntra_user_change_required',
};

export interface RouteInput {
  resourceKind: ResourceKind;
  systemKind: SystemKind;
  attributionKinds: readonly string[];
  /**
   * TRUE only when an ENABLED business rule is in the attribution set.
   *
   * It is NOT "anything that would re-create the holding". A holding whose
   * `business_rule` attribution names a DISABLED rule and which also carries a
   * `request` attribution would then route to `requires_change_rule` with the
   * explanation "a business rule grants it … Provision would grant it back
   * tonight" — about a rule that is switched off. The grant, which is the only
   * live cause, is never revoked, and a `rule_change_required` remediation item
   * is filed against a rule nobody can change because it is already off. That
   * is the common mover shape: the birthright rule was turned off when the
   * person changed job and the requested grant is what remains, so access
   * outlives its own cause and the campaign reports it as somebody else's
   * problem.
   *
   * The broader "any live rule OR grant attribution" test §5 requires belongs
   * on `createRevocationOrder`'s `liveAttribution` parameter, which is a
   * different question about a different thing and is already separate.
   */
  liveRuleAttribution: boolean;
  grantIds: readonly string[];
  directorySourceId: string | null;
}

export interface RouteDecision {
  route: RevocationRoute;
  dispatchable: boolean;
  remediationKind: string | null;
  explanation: string;
  /** The attributions this route does NOT remove. The report says which. */
  notRemoved: string[];
}

const GRANT_KINDS = new Set(['request', 'delegated_admin', 'auto_granted']);

export function routeRevocation(input: RouteInput): RouteDecision {
  const kinds = new Set(input.attributionKinds);
  const grantKinds = [...kinds].filter((k) => GRANT_KINDS.has(k));
  const hasRule = kinds.has('business_rule');

  // 1. A Syntra role. Core's RBAC surface is the only writer of that table, and
  //    an access-review module that could quietly remove administrators is a
  //    governance module with a privilege-escalation shape.
  if (input.resourceKind === 'syntraRole') {
    return {
      route: 'requires_change_role',
      dispatchable: false,
      remediationKind: 'role_assignment_change_required',
      explanation:
        'this is a Syntra role assignment. Govern does not write RoleAssignment; a holder of rbac.manage has to remove it.',
      notRemoved: [...kinds],
    };
  }

  // 2. A Syntra LOGIN. `RevocationOrder` has `targetSystemId`, `accountId` and
  //    `entitlementId`, all NOT NULL, and a `syntraUser` holding has none of
  //    them; a fall-through would produce an invalid-uuid failure inside the
  //    dispatch loop, on the irreversible path. Beyond the mechanics, Govern
  //    must not deactivate a Syntra login: that is Core's user administration,
  //    and it is the same privilege-escalation shape as route 1.
  if (input.resourceKind === 'syntraUser') {
    return {
      route: 'requires_change_syntra_user',
      dispatchable: false,
      remediationKind: 'syntra_user_change_required',
      explanation:
        'this is a Syntra login. Govern does not deactivate accounts in Syntra itself; a holder of rbac.manage has to do it in user administration, and a departure is normally handled by Provision’s leaver ladder rather than by a campaign.',
      notRemoved: [...kinds],
    };
  }

  // 3. A live business rule would grant it again tonight. This comes BEFORE the
  //    grant route deliberately: a holding explained by both a rule and a grant
  //    is not "a grant and nothing else", and removing the grant would leave
  //    the rule to re-create it. `liveRuleAttribution` means an ENABLED rule
  //    and nothing else — see the field's docstring.
  if (hasRule && input.liveRuleAttribution) {
    return {
      route: 'requires_change_rule',
      dispatchable: false,
      remediationKind: 'rule_change_required',
      explanation:
        'this access comes from the person’s job: a business rule grants it, and removing it means changing either the rule or the job. Provision would grant it back tonight.',
      notRemoved: [...kinds],
    };
  }

  // 4. A membership on a group carrying a sourceId. The source rewrites it
  //    every run; a removal here would survive until the small hours and then
  //    come back, which is worse than refusing.
  if (kinds.has('directory_source') || input.directorySourceId !== null) {
    return {
      route: 'requires_change_directory_source',
      dispatchable: false,
      remediationKind: 'directory_source_change_required',
      explanation:
        'this membership comes from a directory source, which rewrites that membership every run. It has to change at the source.',
      notRemoved: [...kinds],
    };
  }

  // 5. An Automate grant — request or delegated admin — and nothing else.
  if (grantKinds.length > 0 && input.grantIds.length > 0) {
    return {
      route: 'automate_grant',
      dispatchable: true,
      remediationKind: null,
      explanation:
        'Automate holds a grant for this. Ending the grant removes its term from desired state, and Provision plans and applies the removal under its own guard.',
      notRemoved: [...kinds].filter((k) => !GRANT_KINDS.has(k)),
    };
  }

  // 6. A Syntra application or local group with NO grant behind it: an
  //    administrator assigned it in the console.
  if (input.resourceKind === 'application' || input.resourceKind === 'syntraGroup') {
    return {
      route: 'requires_change_direct_assignment',
      dispatchable: false,
      remediationKind: 'direct_assignment_change_required',
      explanation:
        'an administrator assigned this directly in Syntra and no grant stands behind it. Govern does not write AppAssignment or GroupMembership.',
      notRemoved: [...kinds],
    };
  }

  // 7. A TARGET ACCOUNT. `RevocationOrder.entitlementId` is NOT NULL and an
  //    account-level holding has no entitlement, so this cannot go to route 8
  //    either. Removing an account is the leaver ladder's job — disable, then
  //    delete after a retention window, with the whole ladder's safety around
  //    it — and a campaign item is not the place to shortcut it.
  if (input.resourceKind === 'targetAccount') {
    return {
      route: 'requires_change_account',
      dispatchable: false,
      remediationKind: 'account_removal_required',
      explanation:
        'this is an account at a target system, not an entitlement within one. Govern dispatches entitlement removals; removing the account itself belongs to Provision’s leaver ladder, which disables first and deletes only after the retention window.',
      notRemoved: [...kinds],
    };
  }

  // 8. A target ENTITLEMENT whose attributions are all `discovered` or
  //    `manual`, or which is unattributable — nothing in desired state wants
  //    it. Including the EMPTY set: a holding nothing explains is the most
  //    interesting thing an access review can find, and it must be removable.
  if (input.resourceKind === 'targetEntitlement') {
    return {
      route: 'revocation_order',
      dispatchable: true,
      remediationKind: null,
      explanation:
        'nothing in desired state wants this holding, so a one-shot revocation order carrying the deciding human is written for Provision to plan.',
      notRemoved: [],
    };
  }

  // NO FALL-THROUGH. `ResourceKind` is a closed union and every member is
  // routed above, so this line is unreachable and `never` proves it: adding a
  // seventh resource kind is a COMPILE ERROR here rather than a silent
  // `revocation_order` against a table whose three id columns are NOT NULL.
  const exhaustive: never = input.resourceKind;
  throw new Error(`unroutable resource kind: ${String(exhaustive)}`);
}
