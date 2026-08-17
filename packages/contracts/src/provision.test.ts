import { describe, expect, it } from 'vitest';
import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  businessRuleRequestSchema,
  conditionRequestSchema,
  createTargetRequestSchema,
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
