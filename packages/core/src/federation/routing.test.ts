import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { evaluateRouting } from './routing.js';
import type { RoutingContext, RoutingRule } from './routing.js';
import { addRule, loadPolicy } from '../policy/policy-service.js';
import { evaluatePolicy } from '../policy/evaluate.js';
import { previewRuleImpact } from '../policy/impact.js';

const rule = (over: Partial<RoutingRule>): RoutingRule => ({
  id: 'r1',
  name: 'entra for staff',
  enabled: true,
  position: 1,
  upstreamIdpId: 'up-1',
  applicationIds: [],
  loginDomains: [],
  ipRanges: [],
  daysOfWeek: [],
  startMinute: null,
  endMinute: null,
  timezone: null,
  ...over,
});

const context = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  login: 'jdoe@acme.test',
  applicationId: null,
  sourceIp: '203.0.113.5',
  now: new Date('2024-06-05T10:00:00Z'),
  ...over,
});

describe('evaluateRouting', () => {
  it('returns null when there are no rules, so the login stays local', () => {
    expect(evaluateRouting([], context())).toBeNull();
  });

  it('matches an unconditional rule', () => {
    expect(evaluateRouting([rule({})], context())).toEqual({
      upstreamIdpId: 'up-1', ruleId: 'r1', ruleName: 'entra for staff',
    });
  });

  it('matches on the login domain, case-insensitively, and not on a suffix', () => {
    const rules = [rule({ loginDomains: ['acme.test'] })];
    expect(evaluateRouting(rules, context({ login: 'JDOE@ACME.TEST' }))).not.toBeNull();
    // "notacme.test" ends with "acme.test". A suffix match would federate a
    // stranger's login to this tenant's upstream.
    expect(evaluateRouting(rules, context({ login: 'x@notacme.test' }))).toBeNull();
    expect(evaluateRouting(rules, context({ login: 'nobody' }))).toBeNull();
    expect(evaluateRouting(rules, context({ login: null }))).toBeNull();
  });

  it('matches on the target application', () => {
    const rules = [rule({ applicationIds: ['app-1'] })];
    expect(evaluateRouting(rules, context({ applicationId: 'app-1' }))).not.toBeNull();
    expect(evaluateRouting(rules, context({ applicationId: 'app-2' }))).toBeNull();
    expect(evaluateRouting(rules, context({ applicationId: null }))).toBeNull();
  });

  it('matches on the source address', () => {
    const rules = [rule({ ipRanges: ['203.0.113.0/24'] })];
    expect(evaluateRouting(rules, context({ sourceIp: '203.0.113.5' }))).not.toBeNull();
    expect(evaluateRouting(rules, context({ sourceIp: '198.51.100.1' }))).toBeNull();
  });

  it('does not federate when a condition cannot be evaluated', () => {
    // No source address to test against an address condition. Routing fails
    // towards LOCAL authentication, which is the direction that keeps a user
    // able to sign in — the opposite of a deny rule, and correct here because
    // this decision grants nothing and refusing to route costs a login only
    // if the local password no longer exists.
    const rules = [rule({ ipRanges: ['203.0.113.0/24'] })];
    expect(evaluateRouting(rules, context({ sourceIp: null }))).toBeNull();
    expect(evaluateRouting([rule({ ipRanges: ['not-a-cidr'] })], context())).toBeNull();
  });

  it('takes the first matching rule by position, and skips disabled ones', () => {
    const rules = [
      rule({ id: 'b', position: 2, upstreamIdpId: 'up-2' }),
      rule({ id: 'a', position: 1, upstreamIdpId: 'up-1', enabled: false }),
    ];
    expect(evaluateRouting(rules, context())?.upstreamIdpId).toBe('up-2');
  });

  it('requires every condition a rule sets, not any of them', () => {
    const rules = [rule({ loginDomains: ['acme.test'], applicationIds: ['app-1'] })];
    expect(evaluateRouting(rules, context({ applicationId: 'app-1' }))).not.toBeNull();
    // Domain matches, application does not. Conjunctive, like every other
    // rule in this product.
    expect(evaluateRouting(rules, context({ applicationId: 'app-2' }))).toBeNull();
  });
});

describe('loadPolicy keeps routing rules out of the authorization engine', () => {
  let tenantId: string;
  let upstreamId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    upstreamId = await withTenant(tenantId, async (tx) => {
      const u = await tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      });
      return u.id;
    });
  });

  it('splits federate rows into routes and leaves rules untouched', async () => {
    const loaded = await withTenant(tenantId, async (tx) => {
      await tx.authPolicy.create({ data: { tenantId } });
      await addRule(tx, { name: 'mfa everywhere', outcome: 'require_mfa' });
      const policy = await tx.authPolicy.findFirstOrThrow();
      await tx.authPolicyRule.create({
        data: {
          tenantId, policyId: policy.id, position: 0, name: 'entra',
          outcome: 'federate', upstreamIdpId: upstreamId,
        },
      });
      return loadPolicy(tx);
    });

    expect(loaded.routes.map((r) => r.upstreamIdpId)).toEqual([upstreamId]);
    expect(loaded.rules.map((r) => r.outcome)).toEqual(['require_mfa']);
    // The federate row sits at position 0 — ahead of the MFA rule. If it
    // leaked into `rules` it would be the first match, its outcome would be
    // narrowed to 'deny' by `asOutcome`, and every sign-in would be refused.
    // Or, worse, a future change to asOutcome would make it an allow.
    const decision = evaluatePolicy(loaded.rules, loaded.fallback, {
      userId: 'u1', applicationId: null, groupIds: [], contracts: [],
      sourceIp: null, now: new Date(),
    });
    expect(decision.outcome).toBe('require_mfa');
  });
});

describe('writing a routing rule through addRule', () => {
  let tenantId: string;
  let upstreamId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    upstreamId = await withTenant(tenantId, async (tx) => {
      const u = await tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      });
      return u.id;
    });
  });

  it('round-trips a federate rule into routes, keeping its conditions', async () => {
    const loaded = await withTenant(tenantId, async (tx) => {
      await addRule(tx, {
        name: 'entra for staff',
        outcome: 'federate',
        upstreamIdpId: upstreamId,
        loginDomains: ['ACME.test'],
        ipRanges: ['203.0.113.0/24'],
      });
      return loadPolicy(tx);
    });

    expect(loaded.rules).toEqual([]);
    expect(loaded.routes).toHaveLength(1);
    expect(loaded.routes[0]).toMatchObject({
      name: 'entra for staff',
      upstreamIdpId: upstreamId,
      loginDomains: ['ACME.test'],
      ipRanges: ['203.0.113.0/24'],
    });

    // The stored rule is what evaluateRouting is handed at login time, so the
    // stored shape has to be one it can actually match on. A casing difference
    // between what an administrator typed and what a user types must not
    // decide a login.
    expect(
      evaluateRouting(loaded.routes, context({ login: 'jdoe@acme.test' })),
    ).toMatchObject({ upstreamIdpId: upstreamId });
    expect(
      evaluateRouting(loaded.routes, context({ login: 'jdoe@other.test' })),
    ).toBeNull();
  });

  it('refuses a federate rule that names no upstream', async () => {
    await expect(
      withTenant(tenantId, (tx) => addRule(tx, { name: 'nowhere', outcome: 'federate' })),
    ).rejects.toThrow(/upstreamIdpId is required/);
  });

  it('refuses a federate rule that matches on facts the login does not yet have', async () => {
    const attempt = (input: Partial<Parameters<typeof addRule>[1]>) =>
      withTenant(tenantId, (tx) =>
        addRule(tx, {
          name: 'entra',
          outcome: 'federate',
          upstreamIdpId: upstreamId,
          ...input,
        } as Parameters<typeof addRule>[1]),
      );

    await expect(attempt({ groupIds: ['11111111-1111-4111-8111-111111111111'] })).rejects.toThrow(
      /group membership/,
    );
    await expect(
      attempt({ contractField: 'department', contractValues: ['Care'] }),
    ).rejects.toThrow(/contract attribute/);
    await expect(attempt({ factorType: 'totp' })).rejects.toThrow(/cannot require a factor/);
  });

  it('refuses an upstream or a login domain on a rule that is not federate', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'mfa', outcome: 'require_mfa', upstreamIdpId: upstreamId }),
      ),
    ).rejects.toThrow(/only meaningful on a federate rule/);
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'mfa', outcome: 'require_mfa', loginDomains: ['acme.test'] }),
      ),
    ).rejects.toThrow(/only meaningful on a federate rule/);
  });

  it('refuses to preview the authorization impact of a routing rule', async () => {
    // previewRuleImpact takes a RuleInput, whose outcome now widens to include
    // 'federate'. Counting "users affected" for a rule that never reaches the
    // authorization engine would answer a question nobody asked with a number
    // an administrator would read as an allow.
    await expect(
      withTenant(tenantId, (tx) =>
        previewRuleImpact(tx, {
          name: 'entra',
          outcome: 'federate',
          upstreamIdpId: upstreamId,
        }),
      ),
    ).rejects.toThrow(/no authorization impact/);
  });
});
