import { describe, expect, it } from 'vitest';
import {
  DISPATCHABLE_ROUTES,
  REVOCATION_ROUTES,
  ROUTE_REMEDIATION_KIND,
  routeRevocation,
  type RevocationRoute,
  type RouteInput,
} from './dispatch.js';

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  resourceKind: 'targetEntitlement',
  systemKind: 'targetSystem',
  attributionKinds: [],
  liveRuleAttribution: false,
  grantIds: [],
  directorySourceId: null,
  ...over,
});

describe('the dispatch table — exactly one route per holding', () => {
  it('routes a grant-and-nothing-else holding to Automate', () => {
    const decision = routeRevocation(
      input({ attributionKinds: ['request'], grantIds: ['g-1'], liveRuleAttribution: true }),
    );
    expect(decision).toMatchObject({ route: 'automate_grant', dispatchable: true });
  });

  it('routes a delegated_admin grant to Automate too', () => {
    expect(
      routeRevocation(
        input({
          attributionKinds: ['delegated_admin'],
          grantIds: ['g-1'],
          liveRuleAttribution: true,
        }),
      ).route,
    ).toBe('automate_grant');
  });

  it('routes a discovered target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['discovered'] })).route).toBe(
      'revocation_order',
    );
  });

  it('routes an unattributable target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['unattributable'] })).route).toBe(
      'revocation_order',
    );
  });

  it('routes a manual target holding to a RevocationOrder', () => {
    expect(routeRevocation(input({ attributionKinds: ['manual'] })).route).toBe(
      'revocation_order',
    );
  });

  it('routes a LIVE-RULE holding to requires_change, NOT to an order — even with a grant beside it', () => {
    // The case that makes the vocabulary necessary. A naive product records
    // "revoked", removes it at the target, and reports 100% remediation.
    // Provision's next run finds the rule still matches and grants it back, and
    // by the following morning the report is a lie somebody signed.
    const decision = routeRevocation(
      input({
        attributionKinds: ['business_rule', 'request'],
        liveRuleAttribution: true,
        grantIds: ['g-1'],
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_rule',
      dispatchable: false,
      remediationKind: 'rule_change_required',
    });
    // §7: the report has to say WHICH attributions were not removed.
    expect(decision.notRemoved).toContain('request');
    expect(decision.explanation).toContain('comes from');
  });

  it('routes a syntraRole holding to requires_change, to a holder of rbac.manage', () => {
    // An access-review module that could quietly remove administrators is a
    // governance module with a privilege-escalation shape.
    const decision = routeRevocation(
      input({
        resourceKind: 'syntraRole',
        systemKind: 'syntraInternal',
        attributionKinds: ['direct_assignment'],
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_role',
      dispatchable: false,
      remediationKind: 'role_assignment_change_required',
    });
  });

  it('routes a SOURCED group membership to requires_change naming the source', () => {
    const decision = routeRevocation(
      input({
        resourceKind: 'syntraGroup',
        systemKind: 'directorySource',
        attributionKinds: ['directory_source'],
        directorySourceId: 'src-1',
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_directory_source',
      remediationKind: 'directory_source_change_required',
    });
    expect(decision.explanation).toContain('rewrites that membership every run');
  });

  it('routes an administrator-assigned application to requires_change', () => {
    const decision = routeRevocation(
      input({
        resourceKind: 'application',
        systemKind: 'syntraInternal',
        attributionKinds: ['direct_assignment'],
      }),
    );
    expect(decision.route).toBe('requires_change_direct_assignment');
  });

  it('routes an application WITH a grant behind it to Automate', () => {
    expect(
      routeRevocation(
        input({
          resourceKind: 'application',
          systemKind: 'syntraInternal',
          attributionKinds: ['request'],
          grantIds: ['g-1'],
          liveRuleAttribution: true,
        }),
      ).route,
    ).toBe('automate_grant');
  });

  it('routes an EMPTY attribution set to a RevocationOrder, never to nothing', () => {
    // The empty case. A holding nothing explains is the most interesting thing
    // an access review can find, and it must be removable.
    expect(routeRevocation(input({ attributionKinds: [] })).route).toBe('revocation_order');
  });

  it('resolves EVERY (kind, resourceKind) pair to EXACTLY ONE NAMED route', () => {
    // §23 asks for the table "over every attribution combination, asserting
    // that each resolves to exactly one route". So: an explicit
    // [input, expectedRoute] array, with the EXACT route asserted.
    //
    // A loop whose only assertion is `expect(REVOCATION_ROUTES).toContain(
    // decision.route)` passes against a router that returns one route
    // unconditionally — a test whose fixture cannot distinguish pass from fail
    // is the same defect as a missing test, and it is invisible to every other
    // check.
    const rk = (k: RouteInput['resourceKind']): RouteInput['systemKind'] =>
      k.startsWith('target') ? 'targetSystem' : 'syntraInternal';

    const KINDS = [
      'business_rule',
      'request',
      'delegated_admin',
      'auto_granted',
      'direct_assignment',
      'group_inheritance',
      'org_unit_inheritance',
      'directory_source',
      'discovered',
      'manual',
      'unattributable',
    ] as const;

    /** What the route MUST be, derived from the spec rather than from the code. */
    const expected = (
      resourceKind: RouteInput['resourceKind'],
      kinds: readonly string[],
      liveRule: boolean,
      hasGrant: boolean,
    ): RevocationRoute => {
      if (resourceKind === 'syntraRole') return 'requires_change_role';
      if (resourceKind === 'syntraUser') return 'requires_change_syntra_user';
      if (kinds.includes('business_rule') && liveRule) return 'requires_change_rule';
      if (kinds.includes('directory_source')) return 'requires_change_directory_source';
      if (
        hasGrant &&
        kinds.some((k) => ['request', 'delegated_admin', 'auto_granted'].includes(k))
      ) {
        return 'automate_grant';
      }
      if (resourceKind === 'application' || resourceKind === 'syntraGroup') {
        return 'requires_change_direct_assignment';
      }
      if (resourceKind === 'targetAccount') return 'requires_change_account';
      return 'revocation_order';
    };

    const cases: { input: RouteInput; expected: RevocationRoute }[] = [];

    // Every single kind × every resource kind, INCLUDING syntraUser.
    for (const kind of KINDS) {
      for (const resourceKind of [
        'targetEntitlement',
        'targetAccount',
        'syntraGroup',
        'application',
        'syntraRole',
        'syntraUser',
      ] as const) {
        const liveRule = kind === 'business_rule';
        const hasGrant = ['request', 'delegated_admin', 'auto_granted'].includes(kind);
        cases.push({
          input: input({
            resourceKind,
            systemKind: rk(resourceKind),
            attributionKinds: [kind],
            liveRuleAttribution: liveRule,
            grantIds: hasGrant ? ['g-1'] : [],
            directorySourceId: kind === 'directory_source' ? 'src-1' : null,
          }),
          expected: expected(resourceKind, [kind], liveRule, hasGrant),
        });
      }
    }

    // The PAIRS that matter, which the single-kind sweep cannot reach.
    cases.push(
      {
        // enabled rule + request: the rule wins, and the grant is named in notRemoved.
        input: input({
          attributionKinds: ['business_rule', 'request'],
          liveRuleAttribution: true,
          grantIds: ['g-1'],
        }),
        expected: 'requires_change_rule',
      },
      {
        // DISABLED rule + request: the grant is the only live cause.
        input: input({
          attributionKinds: ['business_rule', 'request'],
          liveRuleAttribution: false,
          grantIds: ['g-1'],
        }),
        expected: 'automate_grant',
      },
      {
        // directory source + request: the source rewrites it every run.
        input: input({
          resourceKind: 'syntraGroup',
          systemKind: 'syntraInternal',
          attributionKinds: ['directory_source', 'request'],
          grantIds: ['g-1'],
          directorySourceId: 'src-1',
        }),
        expected: 'requires_change_directory_source',
      },
      {
        // discovered + manual: nothing in desired state wants it.
        input: input({ attributionKinds: ['discovered', 'manual'] }),
        expected: 'revocation_order',
      },
      // The empty set.
      { input: input({ attributionKinds: [] }), expected: 'revocation_order' },
      {
        input: input({ resourceKind: 'targetAccount', attributionKinds: [] }),
        expected: 'requires_change_account',
      },
      {
        input: input({
          resourceKind: 'syntraUser',
          systemKind: 'syntraInternal',
          attributionKinds: [],
        }),
        expected: 'requires_change_syntra_user',
      },
    );

    expect(cases.length).toBe(KINDS.length * 6 + 7);

    for (const { input: routeInput, expected: expectedRoute } of cases) {
      const decision = routeRevocation(routeInput);
      expect(
        decision.route,
        `${routeInput.resourceKind} / [${routeInput.attributionKinds.join(',')}] / liveRule=${routeInput.liveRuleAttribution}`,
      ).toBe(expectedRoute);
      // "Exactly one route" asserted rather than assumed: the decision names
      // one route, and its dispatchability follows from that route alone.
      expect(DISPATCHABLE_ROUTES.includes(decision.route)).toBe(decision.dispatchable);
    }
  });

  it('routes a DISABLED business rule beside a live grant to Automate', () => {
    // A `liveRuleAttribution` computed as "an enabled rule OR any grant kind"
    // makes a holding whose `business_rule` attribution names a DISABLED rule
    // and which also carries a `request` route to `requires_change_rule` —
    // explained as "Provision would grant it back tonight", about a rule that
    // is switched off. The grant, the only live cause, is never revoked, and a
    // `rule_change_required` remediation item is filed against a disabled rule.
    //
    // The mover shape: the birthright rule was turned off when the person
    // changed job; the requested grant is what remains.
    const decision = routeRevocation(
      input({
        attributionKinds: ['business_rule', 'request'],
        liveRuleAttribution: false,
        grantIds: ['g-1'],
      }),
    );
    expect(decision).toMatchObject({ route: 'automate_grant', dispatchable: true });
    expect(decision.notRemoved).toContain('business_rule');
  });

  it('routes a targetAccount holding to requires_change_account, never to an order', () => {
    // `RevocationOrder.entitlementId` is `String @db.Uuid` NOT NULL and an
    // account-level holding has no entitlement, so a fall-through would have
    // failed inside the dispatch loop, on an irreversible path.
    const decision = routeRevocation(
      input({ resourceKind: 'targetAccount', attributionKinds: ['discovered'] }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_account',
      dispatchable: false,
      remediationKind: 'account_removal_required',
    });
    expect(decision.explanation).toContain('leaver ladder');
  });

  it('routes a syntraUser holding to requires_change_syntra_user, never to an order', () => {
    // `RevocationOrder.targetSystemId` and `accountId` are both NOT NULL and a
    // Syntra login has neither — and Govern must not deactivate a Syntra login
    // in any case.
    const decision = routeRevocation(
      input({
        resourceKind: 'syntraUser',
        systemKind: 'syntraInternal',
        attributionKinds: ['direct_assignment'],
      }),
    );
    expect(decision).toMatchObject({
      route: 'requires_change_syntra_user',
      dispatchable: false,
      remediationKind: 'syntra_user_change_required',
    });
  });

  it('never marks a requires_change route dispatchable', () => {
    for (const route of REVOCATION_ROUTES) {
      if (route.startsWith('requires_change')) expect(DISPATCHABLE_ROUTES).not.toContain(route);
    }
    expect([...DISPATCHABLE_ROUTES].sort()).toEqual(['automate_grant', 'revocation_order']);
  });

  it('gives every requires_change route a remediation kind, and the two dispatchable ones none', () => {
    // Keyed on the route, so a route added later without a remediation kind is
    // a compile error rather than a silent fall-back to
    // `direct_assignment_change_required`. The runtime half asserts the split
    // is the one the routes describe.
    for (const route of REVOCATION_ROUTES) {
      if (DISPATCHABLE_ROUTES.includes(route)) {
        expect(ROUTE_REMEDIATION_KIND[route], route).toBeNull();
      } else {
        expect(ROUTE_REMEDIATION_KIND[route], route).toBeTruthy();
      }
    }
    // And the decision's own `remediationKind` agrees with the table, so the
    // two cannot drift.
    for (const resourceKind of ['syntraRole', 'syntraUser', 'targetAccount'] as const) {
      const decision = routeRevocation(input({ resourceKind, attributionKinds: [] }));
      expect(decision.remediationKind).toBe(ROUTE_REMEDIATION_KIND[decision.route]);
    }
  });
});
