import { describe, expect, it } from 'vitest';
import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  businessRuleRequestSchema,
  conditionRequestSchema,
  createTargetRequestSchema,
  targetConfigSchema,
  testTargetRequestSchema,
  updateTargetRequestSchema,
} from './provision.js';

const nest = (depth: number): unknown => {
  let node: unknown = { field: 'contract.department', op: 'isNotEmpty' };
  for (let i = 1; i < depth; i += 1) node = { not: node };
  return node;
};

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

describe('the condition a rule may arrive over HTTP as', () => {
  it('accepts a condition at the cap', () => {
    // The cap counts the leaf itself, so this is the last accepted depth.
    expect(conditionRequestSchema.safeParse(nest(MAX_CONDITION_DEPTH)).success).toBe(true);
  });

  it('refuses one level past it', () => {
    const parsed = conditionRequestSchema.safeParse(nest(MAX_CONDITION_DEPTH + 1));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('32 levels deep');
  });

  /**
   * The whole reason this cap is duplicated at the transport boundary.
   *
   * `conditionRequestSchema` is a `z.lazy` and it is parsed at the HTTP edge,
   * BEFORE `@syntra/core`'s `businessRuleSchema` — which carries the same cap —
   * is ever entered. Without the bounds walk in front of the recursion, a body
   * a client chooses the size of overflows the stack inside Zod and returns a
   * bare 500 from the one endpoint an administrator uses to fix rules.
   *
   * This test fails with a `RangeError` rather than a refusal if the walk is
   * removed, which is exactly the distinction that matters: a cap sitting
   * behind the parser it is meant to protect is not a cap.
   */
  it('refuses a 20,000-deep condition without recursing into it', () => {
    const parsed = conditionRequestSchema.safeParse(nest(20_000));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('levels deep');
  });

  it('refuses a condition wider than the node cap', () => {
    const wide = {
      all: Array.from({ length: MAX_CONDITION_NODES + 1 }, () => ({
        field: 'contract.department',
        op: 'isNotEmpty',
      })),
    };
    const parsed = conditionRequestSchema.safeParse(wide);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('512 nodes');
  });

  it('still accepts a leaf this package cannot check, and says so by accepting it', () => {
    // Deliberate: `@syntra/contracts` cannot import core's closed field and
    // operator sets without inverting the dependency. `op: 'regex'` parses
    // HERE and is refused by `boundedConditionSchema` in the route. The test
    // exists so that a later change making this schema strict is a decision
    // rather than an accident.
    expect(
      conditionRequestSchema.safeParse({
        field: 'contract.salary',
        op: 'regex',
        value: '^a',
      }).success,
    ).toBe(true);
  });

  it('caps a condition arriving inside a whole rule, not only on its own', () => {
    const parsed = businessRuleRequestSchema.safeParse({
      name: 'Deep',
      condition: nest(20_000),
      grantsAccount: true,
      enabled: true,
      entitlementIds: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the target a caller may create', () => {
  it('refuses a plaintext transport outright', () => {
    // Not a policy an operator can relax: a target that could be configured
    // to write in the clear is a target that eventually does.
    expect(
      createTargetRequestSchema.safeParse({
        name: 'Plain',
        config: { ...config, tlsMode: 'plain' },
        bindPassword: 'x',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown key on a create rather than dropping it', () => {
    expect(
      createTargetRequestSchema.safeParse({
        name: 'Acme AD',
        config,
        bindPassword: 'x',
        concurrency: 8,
      }).success,
    ).toBe(false);
  });

  it('refuses a field it does not implement rather than dropping it', () => {
    // `concurrency` is stored, validated and rendered, and the apply loop is
    // sequential — the column has never had a reader. Without `.strict()` Zod
    // strips it and the caller gets a 204 for a setting that was discarded,
    // which is the same lie as honouring it badly.
    const parsed = updateTargetRequestSchema.safeParse({ concurrency: 8 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('concurrency');
  });

  it('refuses a misspelled threshold rather than silently saving none', () => {
    expect(
      updateTargetRequestSchema.safeParse({
        thresholds: { createAccountThreshold: 5 },
      }).success,
    ).toBe(false);
  });

  it('refuses a misspelled config field rather than reverting it to its default', () => {
    // The one request object on this slice that was left without `.strict()`,
    // and the one where it costs the most: target config is REPLACED WHOLE
    // rather than merged, so a dropped key does not leave the stored value
    // alone -- it reverts the field to its schema default, and the caller is
    // told 204. `primaryGroupExternalIds` misspelled goes back to `[]`;
    // `provenanceAttribute` misspelled goes back to `info`. An administrator
    // narrowing a target after an incident gets a save that reports success
    // and changed nothing.
    const parsed = createTargetRequestSchema.safeParse({
      name: 'Acme AD',
      config: { ...config, primaryGroupExternalIDs: ['513'] },
      bindPassword: 'x',
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('primaryGroupExternalIDs');
  });

  it('keeps that strictness through .partial() and .extend() on the update body', () => {
    // Zod PRESERVES `unknownKeys` through `.partial()` and `.extend()`, which
    // is why `updateTargetRequestSchema` inherits it -- and why a test that
    // proves it must reverse the flag with `.passthrough()` rather than by
    // deleting `.strict()` from the derived schema, which would prove nothing.
    expect(
      updateTargetRequestSchema.safeParse({
        config: { ...config, anchorAttrib: 'objectGUID' },
      }).success,
    ).toBe(false);

    const loosened = targetConfigSchema.passthrough();
    expect(loosened.safeParse({ ...config, anchorAttrib: 'objectGUID' }).success).toBe(
      true,
    );
  });

  it('trims a config value and refuses one that is nothing but whitespace', () => {
    // The connector reads `entry[config.anchorAttribute]` by exact key, so
    // `'objectGUID '` names an attribute no object carries: every group in the
    // catalog read comes back unidentifiable at once. This schema is what the
    // save is checked against and what gets stored, so it has to refuse
    // exactly what `adTargetConfigSchema` refuses -- otherwise a 204 buys a
    // target whose own configuration fails to parse on every run.
    expect(
      targetConfigSchema.parse({ ...config, anchorAttribute: 'objectGUID ' })
        .anchorAttribute,
    ).toBe('objectGUID');
    expect(
      targetConfigSchema.parse({ ...config, baseDn: '  OU=Users,DC=acme,DC=test ' })
        .baseDn,
    ).toBe('OU=Users,DC=acme,DC=test');
    for (const field of [
      'url',
      'bindDn',
      'baseDn',
      'entitlementSearchBase',
      'archiveContainer',
      'anchorAttribute',
      'provenanceAttribute',
      'accountFilter',
      'groupFilter',
    ] as const) {
      expect(targetConfigSchema.safeParse({ ...config, [field]: '   ' }).success).toBe(
        false,
      );
    }
    expect(
      targetConfigSchema.safeParse({ ...config, primaryGroupExternalIds: [' '] }).success,
    ).toBe(false);
  });

  it('leaves the case of a config value exactly as it was given', () => {
    // Trimming whitespace is not lowercasing. An external id is an opaque
    // anchor compared by exact equality, and folding it here would quietly
    // decide a question this codebase answers differently per comparison.
    const parsed = targetConfigSchema.parse({
      ...config,
      anchorAttribute: 'objectGUID',
      primaryGroupExternalIds: ['AB12-cd'],
    });
    expect(parsed.anchorAttribute).toBe('objectGUID');
    expect(parsed.primaryGroupExternalIds).toEqual(['AB12-cd']);
  });

  it('caps the bind password the way the merged directory-source schema does', () => {
    // `sync.ts` has carried `.max(1024)` since it merged. An unbounded string
    // here is an unbounded write to the credential vault from an anonymous
    // request body, and the twin schemas disagreeing is how that stays
    // unnoticed.
    const long = 'x'.repeat(1025);
    expect(
      createTargetRequestSchema.safeParse({
        name: 'Acme AD',
        type: 'activeDirectory',
        config,
        bindPassword: long,
      }).success,
    ).toBe(false);
    expect(
      testTargetRequestSchema.safeParse({ type: 'activeDirectory', config, bindPassword: long })
        .success,
    ).toBe(false);
    expect(
      createTargetRequestSchema.safeParse({
        name: 'Acme AD',
        type: 'activeDirectory',
        config,
        bindPassword: 'x'.repeat(1024),
      }).success,
    ).toBe(true);
  });

  it('accepts the settings it does implement', () => {
    const parsed = updateTargetRequestSchema.safeParse({
      preHireDays: 14,
      maxAttempts: 3,
      thresholds: { createAccountThresholdPercent: 20 },
      ladder: { disableGraceDays: 7, archiveAfterDays: null },
    });
    expect(parsed.success).toBe(true);
  });
});
