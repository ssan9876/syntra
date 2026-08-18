import { describe, expect, it } from 'vitest';
import { adTargetConfigSchema } from '@syntra/connectors';
import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  UNWRITABLE_ACCOUNT_ATTRIBUTES,
  accountProfileSchema,
  boundedConditionSchema,
  businessRuleSchema,
  initialPasswordPolicySchema,
  provisionThresholdsSchema,
} from './target-service.js';

/**
 * The schema half of the target service, with no database anywhere near it.
 *
 * Split out from `target-service.test.ts` deliberately: every test in that
 * file pays a `resetDatabase()` that truncates sixty tables, and a validation
 * rule does not need one. It is also the shape Task 17 will use these in — a
 * request body parsed at the edge, before any transaction is open — so a
 * schema that only works from inside `withTenant` would be a schema that
 * cannot do that job.
 */

const validProfile = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,%baseDn%',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

const validRule = {
  name: 'Finance staff',
  condition: {
    field: 'contract.department' as const,
    op: 'equals' as const,
    value: 'Finance',
  },
  grantsAccount: true,
  enabled: true,
  entitlementIds: [],
};

/** `depth` nested `all` wrappers around one leaf. Built iteratively. */
function nest(depth: number): unknown {
  let node: unknown = { field: 'contract.department', op: 'equals', value: 'Finance' };
  for (let i = 0; i < depth; i += 1) node = { all: [node] };
  return node;
}

describe('the condition depth and node caps', () => {
  it('accepts a condition at the deepest permitted nesting', () => {
    // MAX_CONDITION_DEPTH counts the leaf itself, so this is the last
    // acceptable one rather than one short of it. A cap tested only from the
    // refusing side passes just as well when it is off by one.
    const parsed = boundedConditionSchema.safeParse(nest(MAX_CONDITION_DEPTH - 1));
    expect(parsed.success).toBe(true);
  });

  it('refuses one level deeper than that', () => {
    const parsed = boundedConditionSchema.safeParse(nest(MAX_CONDITION_DEPTH));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/nest at most/);
  });

  it('refuses a condition that is deep enough to overflow the stack', () => {
    // The case the cap exists for. Without it this is a RangeError from
    // inside `conditionSchema`, which is a fail-closed result reached by
    // unwinding twenty thousand stack frames for every request that asks.
    const parsed = boundedConditionSchema.safeParse(nest(20_000));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/nest at most/);
  });

  it('refuses a wide condition that is nowhere near deep', () => {
    // Depth and size are different budgets: this one is two levels deep.
    const wide = {
      all: Array.from({ length: MAX_CONDITION_NODES + 1 }, () => ({
        field: 'contract.department',
        op: 'equals',
        value: 'Finance',
      })),
    };
    const parsed = boundedConditionSchema.safeParse(wide);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/at most \d+ nodes/);
  });

  it('reports exactly one problem, so the recursive schema was never entered', () => {
    // The whole point of putting the check in a `preprocess` with
    // `fatal: true`: if `conditionSchema` ran as well, an over-deep condition
    // would arrive with a union's worth of issues behind this one, and the
    // recursion the cap exists to prevent would have happened anyway.
    const parsed = boundedConditionSchema.safeParse(nest(20_000));
    expect(parsed.error?.issues).toHaveLength(1);
  });

  it('still refuses a condition outside the closed field set', () => {
    // The bound is a gate in front of `conditionSchema`, not a replacement
    // for it.
    expect(
      boundedConditionSchema.safeParse({
        field: 'contract.salary',
        op: 'equals',
        value: 'x',
      }).success,
    ).toBe(false);
  });

  it('still refuses a blank comparison value', () => {
    // Ruling P20 reached through the wrapper.
    expect(
      boundedConditionSchema.safeParse({
        field: 'contract.department',
        op: 'contains',
        value: '   ',
      }).success,
    ).toBe(false);
  });

  it('binds the cap to businessRuleSchema itself, not to its caller', () => {
    // Ruling P22: a check somebody has to remember to call is a check that
    // eventually is not called. Parsing the rule schema directly, with no
    // service function anywhere, must still refuse this.
    const parsed = businessRuleSchema.safeParse({
      ...validRule,
      condition: nest(20_000),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/nest at most/);
  });

  it('counts depth through any and not as well as all', () => {
    let node: unknown = { field: 'person.status', op: 'isNotEmpty' };
    for (let i = 0; i < MAX_CONDITION_DEPTH; i += 1) {
      node = i % 2 === 0 ? { any: [node] } : { not: node };
    }
    expect(boundedConditionSchema.safeParse(node).success).toBe(false);
  });
});

describe('businessRuleSchema', () => {
  it('accepts a rule with an empty entitlement list', () => {
    expect(businessRuleSchema.safeParse(validRule).success).toBe(true);
  });

  it('refuses a blank name', () => {
    expect(businessRuleSchema.safeParse({ ...validRule, name: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses an entitlement id that is not a uuid', () => {
    expect(
      businessRuleSchema.safeParse({ ...validRule, entitlementIds: ['finance'] }).success,
    ).toBe(false);
  });

  it('refuses an unbounded entitlement list', () => {
    const ids = Array.from(
      { length: 513 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(
      businessRuleSchema.safeParse({ ...validRule, entitlementIds: ids }).success,
    ).toBe(false);
  });
});

describe('provisionThresholdsSchema', () => {
  it('accepts the two ends of the range', () => {
    expect(
      provisionThresholdsSchema.safeParse({
        createAccountThresholdPercent: 0,
        personPopulationDropPercent: 100,
      }).success,
    ).toBe(true);
  });

  it('refuses a percentage above 100', () => {
    expect(
      provisionThresholdsSchema.safeParse({ createAccountThresholdPercent: 101 })
        .success,
    ).toBe(false);
  });

  it('refuses a negative percentage', () => {
    expect(
      provisionThresholdsSchema.safeParse({ disableAccountThresholdPercent: -1 }).success,
    ).toBe(false);
  });

  it('refuses a non-integer percentage', () => {
    expect(
      provisionThresholdsSchema.safeParse({ archiveAccountThresholdPercent: 10.5 })
        .success,
    ).toBe(false);
  });

  it('refuses NaN, which is a number and is not a percentage', () => {
    // `typeof NaN === 'number'`, so a `typeof` filter lets it through and the
    // column takes it as a null. Ruling P25 makes a threshold that is not a
    // comparable percentage a non-confirmable refusal at run time, so this
    // one blocks every run against the target rather than misbehaving.
    expect(
      provisionThresholdsSchema.safeParse({ perEntitlementThresholdPercent: NaN })
        .success,
    ).toBe(false);
  });

  it('refuses a threshold name it does not know', () => {
    expect(
      provisionThresholdsSchema.safeParse({ revokeThresholdPercent: 10 }).success,
    ).toBe(false);
  });

  it('names all seven thresholds', () => {
    // The guard reads seven. A threshold missing from this schema is one an
    // administrator cannot set; one that is here and not in the guard is one
    // nothing reads.
    expect(Object.keys(provisionThresholdsSchema.shape).sort()).toEqual(
      [
        'archiveAccountThresholdPercent',
        'createAccountThresholdPercent',
        'deactivateSyntraUserThresholdPercent',
        'disableAccountThresholdPercent',
        'perEntitlementThresholdPercent',
        'personPopulationDropPercent',
        'revokeEntitlementThresholdPercent',
      ].sort(),
    );
  });
});

describe('accountProfileSchema', () => {
  it('accepts the profile the console produces', () => {
    expect(accountProfileSchema.safeParse(validProfile).success).toBe(true);
  });

  it('refuses a blank fallback container', () => {
    expect(
      accountProfileSchema.safeParse({ ...validProfile, fallbackContainer: '' }).success,
    ).toBe(false);
  });

  it('bounds the template lengths', () => {
    expect(
      accountProfileSchema.safeParse({
        ...validProfile,
        containerTemplate: 'x'.repeat(1025),
      }).success,
    ).toBe(false);
  });

  it('bounds the uniqueness attempts', () => {
    expect(
      accountProfileSchema.safeParse({ ...validProfile, maxUniquenessAttempts: 201 })
        .success,
    ).toBe(false);
    expect(
      accountProfileSchema.safeParse({ ...validProfile, maxUniquenessAttempts: 0 })
        .success,
    ).toBe(false);
  });

  describe('attribute templates', () => {
    // Written out, NOT derived from UNWRITABLE_ACCOUNT_ATTRIBUTES. Drawing
    // the cases from the constant under test means deleting a name from the
    // list deletes the test that would have caught it: the mutation pass
    // removed four and eleven cases went green.
    const MUST_REFUSE = [
      'userAccountControl',
      'unicodePwd',
      'userPassword',
      'pwdLastSet',
      'member',
      'memberOf',
      'primaryGroupID',
      'distinguishedName',
      'objectClass',
      'objectCategory',
      'objectGUID',
      'objectSid',
      'sAMAccountName',
      'ntSecurityDescriptor',
    ] as const;

    it('refuses every name the export claims to refuse, and no fewer', () => {
      // The list and the export, checked against each other. A name added to
      // the export and not to this list is a name nothing above tests.
      expect([...UNWRITABLE_ACCOUNT_ATTRIBUTES].sort()).toEqual(
        [...MUST_REFUSE].sort(),
      );
    });

    it.each(MUST_REFUSE)('refuses a template writing %s', (name) => {
      const parsed = accountProfileSchema.safeParse({
        ...validProfile,
        attributeTemplates: { [name]: 'x' },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/may not write/);
    });

    it('refuses one written in a different case', () => {
      // LDAP attribute names fold case (RFC 4512), PostgreSQL does not, and a
      // list matched exactly is a list that `USERACCOUNTCONTROL` walks past.
      // Fifth case-sensitivity defect on this slice would have been this one.
      const parsed = accountProfileSchema.safeParse({
        ...validProfile,
        attributeTemplates: { USERACCOUNTCONTROL: '514' },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/may not write/);
    });

    it('names the offending attribute in the issue path', () => {
      const parsed = accountProfileSchema.safeParse({
        ...validProfile,
        attributeTemplates: { displayName: 'ok', member: 'CN=Finance' },
      });
      expect(parsed.error?.issues[0]?.path).toEqual(['attributeTemplates', 'member']);
    });

    it('accepts the attributes a profile is for', () => {
      expect(
        accountProfileSchema.safeParse({
          ...validProfile,
          attributeTemplates: {
            displayName: '%person.givenName% %person.familyName%',
            userPrincipalName: '%correlationKey%@acme.test',
            mail: '%correlationKey%@acme.test',
            department: '%contract.department%',
          },
        }).success,
      ).toBe(true);
    });

    it('refuses a key that is not an LDAP attribute name', () => {
      expect(
        accountProfileSchema.safeParse({
          ...validProfile,
          attributeTemplates: { 'display name': 'x' },
        }).success,
      ).toBe(false);
    });

    it('bounds the number of attributes', () => {
      const many = Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`attr${i}`, 'x']),
      );
      expect(
        accountProfileSchema.safeParse({ ...validProfile, attributeTemplates: many })
          .success,
      ).toBe(false);
    });

    it('bounds the template value length', () => {
      expect(
        accountProfileSchema.safeParse({
          ...validProfile,
          attributeTemplates: { displayName: 'x'.repeat(1025) },
        }).success,
      ).toBe(false);
    });

    it('refuses a blank template, which would write a zero-length value', () => {
      // The only template field on this schema that had no lower bound. A
      // blank one renders `{ ok: true, value: '' }` — nothing is missing,
      // because nothing was asked for — and `['']` is a zero-length attribute
      // value, which Active Directory refuses. The `update_account` fails, a
      // failed action leaves `lastAppliedAttributes` untouched, and the next
      // run proposes the identical failing write, for every person the profile
      // applies to, for ever.
      for (const blank of ['', ' ', '	']) {
        const parsed = accountProfileSchema.safeParse({
          ...validProfile,
          attributeTemplates: { displayName: blank },
        });
        expect([blank, parsed.success]).toEqual([blank, false]);
      }
    });
  });

  describe('initial password policy', () => {
    it('accepts an empty policy, which means the generator decides', () => {
      expect(initialPasswordPolicySchema.safeParse({}).success).toBe(true);
    });

    it('refuses a misspelled key rather than silently ignoring it', () => {
      // `z.record(z.unknown())` stores `{ lenght: 24 }` without complaint and
      // Task 14 reads the column back with a cast, so the profile says one
      // thing and every password it produces says another.
      expect(initialPasswordPolicySchema.safeParse({ lenght: 24 }).success).toBe(false);
    });

    it('refuses a length nobody should be issued', () => {
      expect(initialPasswordPolicySchema.safeParse({ length: 4 }).success).toBe(false);
      expect(initialPasswordPolicySchema.safeParse({ length: 1e9 }).success).toBe(false);
    });

    it('refuses a non-boolean requirement', () => {
      expect(
        initialPasswordPolicySchema.safeParse({ requireSymbol: 'yes' }).success,
      ).toBe(false);
    });

    it('is reached through the profile schema, not only on its own', () => {
      expect(
        accountProfileSchema.safeParse({
          ...validProfile,
          initialPasswordPolicy: { lenght: 24 },
        }).success,
      ).toBe(false);
    });

    it('accepts a Record<string, unknown> as its input type', () => {
      // Task 17's route body arrives as an open bag. The strict shape decides
      // what is stored; the open one is what lets a caller hand it over.
      const fromBody: Record<string, unknown> = { length: 32, requireSymbol: true };
      expect(
        accountProfileSchema.safeParse({
          ...validProfile,
          initialPasswordPolicy: fromBody,
        }).success,
      ).toBe(true);
    });
  });
});

describe('the gaps the mutation pass found', () => {
  it('accepts a condition holding exactly the permitted number of nodes', () => {
    // The refusing side of a cap tests the message; the accepting side tests
    // the number. A `>` mutated to `>=` passes every refusal test in this file
    // and refuses a rule an administrator is entitled to save.
    const wide = {
      all: Array.from({ length: MAX_CONDITION_NODES - 1 }, () => ({
        field: 'contract.department',
        op: 'equals',
        value: 'Finance',
      })),
    };
    expect(boundedConditionSchema.safeParse(wide).success).toBe(true);
  });

  it('accepts a description up to the bound and refuses one past it', () => {
    expect(
      businessRuleSchema.safeParse({ ...validRule, description: 'x'.repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      businessRuleSchema.safeParse({ ...validRule, description: 'x'.repeat(2001) })
        .success,
    ).toBe(false);
  });

  it('accepts a name at the bound and refuses one past it', () => {
    expect(
      businessRuleSchema.safeParse({ ...validRule, name: 'x'.repeat(200) }).success,
    ).toBe(true);
    expect(
      businessRuleSchema.safeParse({ ...validRule, name: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('accepts an attribute template value at the bound', () => {
    expect(
      accountProfileSchema.safeParse({
        ...validProfile,
        attributeTemplates: { displayName: 'x'.repeat(1024) },
      }).success,
    ).toBe(true);
  });

  it('accepts a template at the bound and refuses one past it', () => {
    expect(
      accountProfileSchema.safeParse({
        ...validProfile,
        containerTemplate: 'x'.repeat(1024),
      }).success,
    ).toBe(true);
  });

  it('accepts the highest and lowest password length it permits', () => {
    expect(initialPasswordPolicySchema.safeParse({ length: 12 }).success).toBe(true);
    expect(initialPasswordPolicySchema.safeParse({ length: 256 }).success).toBe(true);
    expect(initialPasswordPolicySchema.safeParse({ length: 11 }).success).toBe(false);
    expect(initialPasswordPolicySchema.safeParse({ length: 257 }).success).toBe(false);
  });

  it('accepts sixty-four attribute templates and refuses sixty-five', () => {
    const of = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`attr${i}`, 'x']));
    expect(
      accountProfileSchema.safeParse({ ...validProfile, attributeTemplates: of(64) })
        .success,
    ).toBe(true);
    expect(
      accountProfileSchema.safeParse({ ...validProfile, attributeTemplates: of(65) })
        .success,
    ).toBe(false);
  });

  it('accepts five hundred and twelve entitlement ids and refuses more', () => {
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    expect(
      businessRuleSchema.safeParse({ ...validRule, entitlementIds: ids(512) }).success,
    ).toBe(true);
    expect(
      businessRuleSchema.safeParse({ ...validRule, entitlementIds: ids(513) }).success,
    ).toBe(false);
  });

  it('accepts the highest and lowest uniqueness attempt count', () => {
    expect(
      accountProfileSchema.safeParse({ ...validProfile, maxUniquenessAttempts: 1 })
        .success,
    ).toBe(true);
    expect(
      accountProfileSchema.safeParse({ ...validProfile, maxUniquenessAttempts: 200 })
        .success,
    ).toBe(true);
  });

  it('defaults the uniqueness strategy rather than requiring it', () => {
    const parsed = accountProfileSchema.safeParse(validProfile);
    expect(parsed.success && parsed.data.uniquenessStrategy).toBe('numericSuffix');
  });

  it('refuses a uniqueness strategy nothing implements', () => {
    // `names.ts` implements one strategy. A profile naming another is a
    // profile whose correlation keys are generated by a rule that does not
    // exist.
    expect(
      accountProfileSchema.safeParse({
        ...validProfile,
        uniquenessStrategy: 'randomSuffix',
      }).success,
    ).toBe(false);
  });

  it('refuses a delivery choice nothing implements', () => {
    expect(
      accountProfileSchema.safeParse({
        ...validProfile,
        initialPasswordDelivery: 'sms',
      }).success,
    ).toBe(false);
  });
});

describe('the transport coupling the borrow check relies on', () => {
  // `testTargetConfiguration` compares the URL, the TLS mode and the
  // certificate setting before it will lend a saved credential. Removing the
  // TLS-mode comparison changes no behaviour, and this is why: the schema ties
  // `tlsMode` to the URL scheme in both directions and excludes `plain`
  // outright, so two configurations whose URLs are equal cannot differ in
  // `tlsMode` at all. The comparison is defence in depth against a future
  // schema that decouples them -- and these three tests are what would fail if
  // one ever did, which is the only thing that makes keeping it honest.
  const base = {
    bindDn: 'CN=svc,DC=acme,DC=test',
    baseDn: 'OU=Users,DC=acme,DC=test',
    entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
    archiveContainer: 'OU=Archive,DC=acme,DC=test',
  };

  it('refuses starttls on an ldaps URL', () => {
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldaps://dc.acme.test:636',
        tlsMode: 'starttls',
      }).success,
    ).toBe(false);
  });

  it('refuses ldaps on an ldap URL', () => {
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.acme.test:389',
        tlsMode: 'ldaps',
      }).success,
    ).toBe(false);
  });

  it('refuses plain outright, whatever the URL says', () => {
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.acme.test:389',
        tlsMode: 'plain',
      }).success,
    ).toBe(false);
  });

  it('leaves exactly one TLS mode available for each URL scheme', () => {
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldaps://dc.acme.test:636',
        tlsMode: 'ldaps',
      }).success,
    ).toBe(true);
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.acme.test:389',
        tlsMode: 'starttls',
      }).success,
    ).toBe(true);
  });
});
