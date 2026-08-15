import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { addMember, createGroup } from '../directory/group-service.js';
import {
  addRule,
  setPolicyDefault,
  updateRule,
} from '../policy/policy-service.js';
import type { FactorType } from '../policy/types.js';
import { setPassword } from './password.js';
import { createSession, resolveSession } from './session-service.js';
import {
  registerFactorVerifier,
  resetFactorVerifiers,
} from './mfa/registry.js';
import type {
  FactorPresentation,
  FactorPresentationType,
  FactorVerifier,
} from './mfa/types.js';
import { authorize } from './authorize.js';
import * as OTPAuth from 'otpauth';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  TOTP_PERIOD_SECONDS,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  installTotpVerifier,
} from './mfa/totp.js';
import { generateRecoveryCodes, installRecoveryCodeVerifier } from './mfa/recovery-codes.js';
import { SoftKey } from './mfa/soft-key.js';
import {
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
  installWebAuthnVerifier,
} from './mfa/webauthn.js';

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-08-12T09:00:00Z');

/**
 * The relying party is a required field on every request. It is only read when
 * a WebAuthn assertion is verified, but it is not optional: an ambient store
 * would let a caller forget it and find out at run time, inside the one
 * chokepoint every authentication path funnels through.
 */
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

beforeEach(async () => {
  // The registry is process-wide and the whole suite runs in one fork. Each
  // describe below installs exactly the verifiers it means to exercise, so
  // "the user has no factor" means that and not "some other file installed
  // one".
  resetFactorVerifiers();

  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

const signIn = (password = PASSWORD, sourceIp: string | null = '10.1.2.3') =>
  authorize(tenantId, {
    kind: 'primary',
    principal: { kind: 'password', login: 'jdoe', password },
    applicationId: null,
    sourceIp,
    relyingParty: RP,
    scope: 'portal',
    now: NOW,
  });

const auditActions = () =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }),
  );

describe('authorize — primary authentication', () => {
  it('allows a correct password when no policy is configured', async () => {
    const result = await signIn();
    expect(result).toEqual({
      status: 'allow',
      userId,
      mayElevate: false,
      applicationId: null,
      scope: 'portal',
      satisfiedFactor: null,
    });
  });

  it('denies a wrong password', async () => {
    expect(await signIn('wrong')).toEqual({
      status: 'deny',
      reason: 'invalid_credentials',
    });
  });

  it('reports an unknown login exactly as it reports a wrong password', async () => {
    const unknown = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'nobody', password: 'wrong' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(unknown).toEqual({ status: 'deny', reason: 'invalid_credentials' });
  });

  it('denies an inactive user', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    expect(await signIn()).toEqual({ status: 'deny', reason: 'user_inactive' });
  });

  it('accepts an already-established principal without a password', async () => {
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'external', userId, issuer: 'entra:acme' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'allow', userId });
  });

  it('still refuses an inactive user on an established principal', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'external', userId, issuer: 'entra:acme' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'user_inactive' });
  });
});

describe('authorize — policy', () => {
  it('denies when a rule says deny, and records the rule in the audit log', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Blocked outright', outcome: 'deny' }),
    );

    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });

    const events = await auditActions();
    const denial = events.find((e) => e.action === 'auth.policy_denied');
    expect(denial).toBeDefined();
    expect(denial!.outcome).toBe('failure');
    expect(denial!.payload).toMatchObject({ ruleName: 'Blocked outright' });
  });

  it('denies when the tenant default is deny and nothing matches', async () => {
    await withTenant(tenantId, (tx) =>
      setPolicyDefault(tx, { outcome: 'deny', factorType: null }),
    );
    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });
  });

  it('denies before evaluating policy when the password is wrong', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Allow', outcome: 'allow' }),
    );
    expect(await signIn('wrong')).toEqual({
      status: 'deny',
      reason: 'invalid_credentials',
    });
  });

  it('matches a rule on group membership', async () => {
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, userId);
      await addRule(tx, {
        name: 'Finance blocked',
        outcome: 'deny',
        groupIds: [g.id],
      });
    });
    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });
  });

  it('matches a rule on source address', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, {
        name: 'Offsite blocked',
        outcome: 'deny',
        ipRanges: ['203.0.113.0/24'],
      }),
    );
    expect(await signIn(PASSWORD, '203.0.113.9')).toEqual({
      status: 'deny',
      reason: 'policy_denied',
    });
    expect(await signIn(PASSWORD, '10.1.2.3')).toMatchObject({
      status: 'allow',
    });
  });

  it('denies with factor_not_enrolled when nothing is enrollable in this process', async () => {
    // No verifier is registered in this test file, so enrollableFactorTypes()
    // is empty and there is genuinely nothing to offer. Task 5 registers TOTP
    // and asserts that the same rule produces an enrolment challenge instead.
    // That is the normal path; this is the degenerate one.
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Everyone needs MFA', outcome: 'require_mfa' }),
    );

    expect(await signIn()).toEqual({
      status: 'deny',
      reason: 'factor_not_enrolled',
    });

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.mfa_unavailable')).toBe(true);
  });

  it('applies a caller-supplied floor on top of the policy outcome', async () => {
    // The policy says allow; the caller (elevation) demands MFA anyway.
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      floor: 'require_mfa',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('never lets a floor weaken a policy denial', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Deny', outcome: 'deny' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      floor: 'allow',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'policy_denied' });
  });
});

describe('authorize — continue and enrolled', () => {
  it('denies a continue against an attempt token that was never issued', async () => {
    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: 'nonsense',
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('denies an enrolled claim against an attempt token that was never issued', async () => {
    const result = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: 'nonsense',
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });
});

describe('authorize — audit', () => {
  it('writes exactly one success event for a clean sign-in', async () => {
    await signIn();
    const events = await auditActions();
    expect(events.filter((e) => e.action === 'auth.login')).toHaveLength(1);
    expect(events[events.length - 1]!.outcome).toBe('success');
  });

  it('never records the password', async () => {
    await signIn('wrong');
    const events = await auditActions();
    expect(JSON.stringify(events)).not.toContain('wrong');
  });
});

/**
 * A verifier standing in for the real TOTP and WebAuthn implementations, which
 * arrive in Tasks 5 and 6. It records what it was asked so the tests can prove
 * the chokepoint never runs verification inside a transaction it is holding,
 * and so that "enrolled" is a fact the test controls rather than a claim the
 * request carries.
 */
const held = new Set<FactorPresentationType>();
const goodCode = '123456';

function stubVerifier(
  type: FactorPresentationType,
  options: { enrollable?: boolean } = {},
): FactorVerifier {
  return {
    type,
    enrollable: options.enrollable ?? type !== 'recovery_code',
    enrolled: async () => held.has(type),
    verify: async (
      _tenantId: string,
      _userId: string,
      presentation: FactorPresentation,
    ) => {
      const code =
        presentation.type === 'webauthn'
          ? String(presentation.assertion)
          : presentation.code;
      return code === goodCode
        ? { ok: true as const }
        : { ok: false as const, reason: `${presentation.type}_invalid` };
    },
  };
}

describe('authorize — the step-up round trip', () => {
  beforeEach(() => {
    held.clear();
    held.add('totp');
    registerFactorVerifier(stubVerifier('totp'));
  });

  const requireMfa = () =>
    withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Everyone needs MFA', outcome: 'require_mfa' }),
    );

  it('challenges a user who holds a factor rather than refusing them', async () => {
    await requireMfa();
    const result = await signIn();

    expect(result).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
      enrolledFactors: ['totp'],
    });
    expect((result as { expiresAt: Date }).expiresAt.getTime()).toBe(
      NOW.getTime() + 5 * 60 * 1000,
    );

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.mfa_challenged')).toBe(true);
  });

  /**
   * The whole loop, in one test, because the defect this guards against is
   * exactly the one that survives being tested in halves: challenge, verify,
   * establish a session carrying the factor, then re-enter with that session
   * and get an allow rather than the same challenge again.
   */
  it('challenges, verifies, and does not demand the same factor again on relaunch', async () => {
    await requireMfa();

    const challenge = await signIn();
    expect(challenge.status).toBe('challenge');
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const verified = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      now: NOW,
    });
    expect(verified).toEqual({
      status: 'allow',
      userId,
      mayElevate: false,
      applicationId: null,
      scope: 'portal',
      satisfiedFactor: 'totp',
    });

    // The session records what established it...
    const allow = verified as { scope: 'portal'; satisfiedFactor: string };
    const { token } = await withTenant(tenantId, (tx) =>
      createSession(tx, userId, allow.scope, allow.satisfiedFactor),
    );
    const session = await withTenant(tenantId, (tx) =>
      resolveSession(tx, token),
    );
    expect(session!.satisfiedFactor).toBe('totp');

    // ...so relaunching an application under the same rule is an allow, not
    // the beginning of an identical challenge that never terminates.
    const relaunch = await authorize(tenantId, {
      kind: 'primary',
      principal: {
        kind: 'session',
        userId,
        sessionId: session!.sessionId,
        satisfiedFactor: session!.satisfiedFactor as FactorPresentationType,
      },
      applicationId: null,
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(relaunch).toMatchObject({
      status: 'allow',
      userId,
      satisfiedFactor: 'totp',
    });
  });

  it('re-challenges a session that was established with no factor at all', async () => {
    await requireMfa();
    const relaunch = await authorize(tenantId, {
      kind: 'primary',
      principal: {
        kind: 'session',
        userId,
        sessionId: '00000000-0000-4000-8000-000000000000',
        satisfiedFactor: null,
      },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(relaunch.status).toBe('challenge');
  });

  it('refuses a wrong code and leaves the attempt usable for a retry', async () => {
    await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const wrong = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(wrong).toEqual({ status: 'deny', reason: 'factor_invalid' });

    const retry = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(retry).toMatchObject({ status: 'allow' });
  });

  it('spends an attempt exactly once', async () => {
    await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const first = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(first).toMatchObject({ status: 'allow' });

    const second = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(second).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('expires an attempt', async () => {
    await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const late = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: new Date(NOW.getTime() + 6 * 60 * 1000),
    });
    expect(late).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses a user deactivated between the challenge and the code', async () => {
    await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'user_inactive' });
  });

  it('issues the scope recorded on the attempt, never the one the answer implies', async () => {
    await requireMfa();
    // An elevation: the issuer says 'admin', and the request that answers the
    // challenge carries nothing that says so.
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'admin',
      now: NOW,
    });
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'allow', scope: 'admin' });
  });

  it('does not hand a portal sign-in an administrative scope', async () => {
    await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'allow', scope: 'portal' });
  });

  it('re-evaluates policy after the factor rather than trusting the earlier decision', async () => {
    const rule = await requireMfa();
    const challenge = await signIn();
    const attemptToken = (challenge as { attemptToken: string }).attemptToken;

    // The administrator tightens the policy while the user reaches for their
    // phone. The correct code no longer buys a session.
    await withTenant(tenantId, (tx) =>
      updateRule(tx, rule.id, { name: 'Blocked outright', outcome: 'deny' }),
    );

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'policy_denied' });
  });

  it('will not let a recovery code stand in for a named factor', async () => {
    registerFactorVerifier(stubVerifier('recovery_code'));
    held.add('recovery_code');
    await withTenant(tenantId, (tx) =>
      addRule(tx, {
        name: 'Authenticator app only',
        outcome: 'require_factor',
        factorType: 'totp',
      }),
    );

    const challenge = await signIn();
    expect(challenge).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
    });

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: (challenge as { attemptToken: string }).attemptToken,
      factor: { type: 'recovery_code', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_invalid' });
  });

  it('offers a recovery code when a printed code is all that is left', async () => {
    registerFactorVerifier(stubVerifier('recovery_code'));
    held.clear();
    held.add('recovery_code');
    await requireMfa();

    const challenge = await signIn();
    expect(challenge).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['recovery_code'],
      enrolledFactors: [],
    });

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: (challenge as { attemptToken: string }).attemptToken,
      factor: { type: 'recovery_code', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toMatchObject({
      status: 'allow',
      satisfiedFactor: 'recovery_code',
    });
  });
});

describe('authorize — forced enrolment', () => {
  beforeEach(() => {
    held.clear();
    registerFactorVerifier(stubVerifier('totp'));
    registerFactorVerifier(stubVerifier('webauthn'));
  });

  const requireMfa = () =>
    withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Everyone needs MFA', outcome: 'require_mfa' }),
    );

  const enrol = (token: string, factor: FactorType, now = NOW) =>
    authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: token,
      enrolledFactor: factor,
      sourceIp: null,
      relyingParty: RP,
      now,
    });

  it('offers enrolment rather than locking out a user who holds nothing', async () => {
    await requireMfa();
    const result = await signIn();

    expect(result).toMatchObject({
      status: 'enrol',
      enrollableFactors: ['totp', 'webauthn'],
    });

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.enrolment_required')).toBe(
      true,
    );
  });

  it('denies instead when the tenant has turned self-enrolment off', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { selfEnrolmentEnabled: false },
    });
    await requireMfa();

    expect(await signIn()).toEqual({
      status: 'deny',
      reason: 'factor_not_enrolled',
    });
  });

  it('offers only the factor a named rule demands', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    await withTenant(tenantId, (tx) =>
      addRule(tx, {
        name: 'Security keys only',
        outcome: 'require_factor',
        factorType: 'webauthn',
      }),
    );

    expect(await signIn()).toMatchObject({
      status: 'enrol',
      enrollableFactors: ['webauthn'],
    });
  });

  it('cannot be exchanged for a session directly', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    // The enrolment attempt is not a verification attempt, so presenting a
    // factor against it buys nothing at all.
    held.add('totp');
    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'totp', code: goodCode },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses an enrolment claim the database does not bear out', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    // Nothing was actually enrolled; the claim in the request is not evidence.
    expect(await enrol(attemptToken, 'totp')).toEqual({
      status: 'deny',
      reason: 'factor_not_enrolled',
    });
  });

  it('refuses to enrol a weaker factor than the rule demanded', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    await withTenant(tenantId, (tx) =>
      addRule(tx, {
        name: 'Security keys only',
        outcome: 'require_factor',
        factorType: 'webauthn',
      }),
    );
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    // Even with TOTP genuinely enrolled, it is not what the rule asked for.
    held.add('totp');
    expect(await enrol(attemptToken, 'totp')).toEqual({
      status: 'deny',
      reason: 'factor_invalid',
    });
  });

  it('expires', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    held.add('totp');
    expect(
      await enrol(attemptToken, 'totp', new Date(NOW.getTime() + 6 * 60 * 1000)),
    ).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('allows once the factor really exists, and audits the forced enrolment', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    held.add('totp');
    const result = await enrol(attemptToken, 'totp');
    expect(result).toEqual({
      status: 'allow',
      userId,
      mayElevate: false,
      applicationId: null,
      scope: 'portal',
      satisfiedFactor: 'totp',
    });

    const events = await auditActions();
    const completed = events.find(
      (e) => e.action === 'auth.forced_enrolment_completed',
    );
    expect(completed).toBeDefined();
    expect(completed!.payload).toMatchObject({
      factor: 'totp',
      underForcedEnrolment: true,
    });
  });

  it('re-evaluates the original decision after enrolment rather than assuming it passes', async () => {
    const rule = await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    held.add('totp');
    // The rule the user was enrolling under is replaced by a flat denial
    // while they are scanning the QR code.
    await withTenant(tenantId, (tx) =>
      updateRule(tx, rule.id, { name: 'Blocked outright', outcome: 'deny' }),
    );

    expect(await enrol(attemptToken, 'totp')).toEqual({
      status: 'deny',
      reason: 'policy_denied',
    });
  });

  it('is spent exactly once', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    held.add('totp');
    expect(await enrol(attemptToken, 'totp')).toMatchObject({
      status: 'allow',
    });
    expect(await enrol(attemptToken, 'totp')).toEqual({
      status: 'deny',
      reason: 'attempt_invalid',
    });
  });

  it('refuses a user deactivated during enrolment', async () => {
    await requireMfa();
    const offer = await signIn();
    const attemptToken = (offer as { attemptToken: string }).attemptToken;

    held.add('totp');
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));

    expect(await enrol(attemptToken, 'totp')).toEqual({
      status: 'deny',
      reason: 'user_inactive',
    });
  });
});

const totpProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

const codeAt = (secret: string, at: Date) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD_SECONDS,
    digits: 6,
    algorithm: 'SHA1',
    timestamp: at.getTime(),
  });

describe('authorize — TOTP step-up', () => {
  // Installed here rather than at module scope: the outer beforeEach empties
  // the registry, so each describe declares exactly what it exercises.
  beforeEach(() => installTotpVerifier(totpProvider));

  async function enrolTotp(): Promise<string> {
    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    return enrolment.secret;
  }

  it('challenges instead of allowing when a rule requires MFA', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });

    expect(challenge).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
      enrolledFactors: ['totp'],
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const allowed = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, later) },
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      now: later,
    });
    expect(allowed).toMatchObject({ status: 'allow', userId, satisfiedFactor: 'totp' });
  });

  it('refuses a wrong code without burning the attempt', async () => {
    await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const wrong = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: later,
    });
    expect(wrong).toEqual({ status: 'deny', reason: 'factor_invalid' });

    const attempt = await withTenant(tenantId, (tx) => tx.authAttempt.findFirst());
    expect(attempt!.consumedAt).toBeNull();
  });

  it('refuses to reuse a consumed attempt token', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, later) },
      sourceIp: null,
      relyingParty: RP,
      now: later,
    });

    const nextStep = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    const again = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, nextStep) },
      sourceIp: null,
      relyingParty: RP,
      now: nextStep,
    });
    expect(again).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses an expired attempt token', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const muchLater = new Date(later.getTime() + 10 * 60 * 1000);
    const expired = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, muchLater) },
      sourceIp: null,
      relyingParty: RP,
      now: muchLater,
    });
    expect(expired).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('pairs every attempt it issues with an audit event, in one transaction', async () => {
    await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: new Date(NOW.getTime() + 60_000),
    });

    const attempts = await withTenant(tenantId, (tx) => tx.authAttempt.count());
    const challenged = await withTenant(tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'auth.mfa_challenged' } }),
    );
    expect(attempts).toBe(1);
    expect(challenged).toBe(1);
  });
});

describe('authorize — real TOTP forced enrolment', () => {
  beforeEach(() => installTotpVerifier(totpProvider));

  it('offers enrolment rather than refusing a user who holds nothing', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });

    expect(result).toMatchObject({ status: 'enrol', enrollableFactors: ['totp'] });

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.enrolment_required')).toBe(true);
  });

  it('issues a session once the factor is enrolled, without asking for it twice', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );

    const allowed = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    // Enrolling is proof of possession: a TOTP enrolment is confirmed with a
    // live code, so the user is not immediately challenged for the same thing.
    expect(allowed).toMatchObject({ status: 'allow', userId, satisfiedFactor: 'totp' });
  });

  it('records the enrolment as having happened under a forced challenge', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });

    // A stolen password can now buy an attacker their own factor. The trade is
    // accepted; being able to see it afterwards is what makes it acceptable.
    const events = await auditActions();
    const forced = events.find((e) => e.action === 'auth.forced_enrolment_completed');
    expect(forced).toBeDefined();
    expect(forced!.payload).toMatchObject({ factor: 'totp', underForcedEnrolment: true });
  });

  it('refuses an enrolled claim the database does not support', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    // Nothing was enrolled. Saying so must not be enough.
    const result = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('refuses to spend an enrolment attempt on a verification', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: offer.attemptToken,
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses outright when the tenant has turned self-enrolment off', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { selfEnrolmentEnabled: false },
    });
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    // The tenant issues factors by hand. There is genuinely no way forward and
    // saying so is honest.
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('refuses when the rule names a factor this deployment cannot enrol', async () => {
    // A primary domain is a write-time prerequisite for any webauthn rule
    // (assertFactorUsable, added in Task 3) — unrelated to what this test
    // exercises, which is that only TOTP is installed in this describe, so a
    // rule demanding WebAuthn has nothing to offer and nothing to accept.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('does not offer a factor the rule did not ask for', async () => {
    // A rule naming TOTP offers TOTP and nothing else, even when more types
    // are installed.
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'App codes only', outcome: 'require_factor', factorType: 'totp' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'enrol', enrollableFactors: ['totp'] });
  });
});

describe('authorize — recovery codes', () => {
  // Only recovery codes are installed here, so nothing is enrollable and the
  // fallback branch is exercised rather than forced enrolment.
  beforeEach(() => installRecoveryCodeVerifier());

  it('satisfies require_mfa', async () => {
    const codes = await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(challenge.status).toBe('challenge');
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const allowed = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'recovery_code', code: codes[0]! },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(allowed).toMatchObject({ status: 'allow', satisfiedFactor: 'recovery_code' });
  });

  it('does not satisfy a rule that names WebAuthn', async () => {
    // A require_factor: webauthn rule needs a primary domain set first
    // (assertFactorUsable, added in Task 3) — otherwise addRule itself throws.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    // A printed code is not a hardware key, and a rule that asks for one is not
    // satisfied by the other. Recovery codes are not enrollable either, so
    // there is nothing to offer and the answer is an honest refusal.
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('is never offered as the way to satisfy a forced enrolment', async () => {
    // The user holds no recovery codes and no factor. A require_mfa rule must
    // not answer "generate yourself some codes" — that would let a user prove
    // possession of a second factor by printing one.
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });
});

describe('authorize — WebAuthn step-up, with a key that really signs', () => {
  /** Registration wants a name for the browser prompt; verification does not. */
  const RP_IDENTITY = { ...RP, name: 'Acme' };

  /**
   * A relying party that is not this tenant's. `tenant-context.ts` resolves a
   * tenant from the leftmost label of the Host header, so a request arriving at
   * `acme.attacker.example` reaches tenant `acme` — this is what the caller
   * would be handing authorize() in a phishing flow if the relying party came
   * from the request rather than from the tenant row.
   */
  const ATTACKER = {
    id: 'acme.attacker.example',
    origin: 'http://acme.attacker.example',
  };

  let key: SoftKey;

  beforeEach(async () => {
    installWebAuthnVerifier();
    // A require_factor: webauthn rule is refused at write time unless the
    // tenant has a primary domain, since that is where its relying party
    // comes from.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });

    key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_IDENTITY);
    const registered = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_IDENTITY,
      'YubiKey',
      key.register(options.challenge, RP) as never,
    );
    expect(registered).toMatchObject({ ok: true });

    await withTenant(tenantId, (tx) =>
      addRule(tx, {
        name: 'Keys only',
        outcome: 'require_factor',
        factorType: 'webauthn',
      }),
    );
  });

  /** Signs a fresh assertion the way a browser would. */
  const assertion = async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP, NOW);
    return key.assert(options.challenge, RP);
  };

  const challengeToken = async () => {
    const challenge = await signIn();
    expect(challenge).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['webauthn'],
    });
    return (challenge as { attemptToken: string }).attemptToken;
  };

  it('allows a real assertion presented against the tenant relying party', async () => {
    const attemptToken = await challengeToken();

    const verified = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'webauthn', assertion: await assertion() },
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      now: NOW,
    });

    expect(verified).toEqual({
      status: 'allow',
      userId,
      mayElevate: false,
      applicationId: null,
      scope: 'portal',
      satisfiedFactor: 'webauthn',
    });
  });

  it('refuses the same assertion when the caller names another relying party', async () => {
    // The assertion is genuine and the challenge is live; only the relying
    // party the caller supplies differs. This is what makes the threading of
    // `request.relyingParty` into the verifier visible: a regression that
    // dropped it, or answered from the credential row instead, would allow
    // this — and a security key's whole purpose is that it does not.
    const attemptToken = await challengeToken();

    const denied = await authorize(tenantId, {
      kind: 'continue',
      attemptToken,
      factor: { type: 'webauthn', assertion: await assertion() },
      sourceIp: '10.1.2.3',
      relyingParty: ATTACKER,
      now: NOW,
    });

    expect(denied).toEqual({ status: 'deny', reason: 'factor_invalid' });

    const events = await auditActions();
    expect(events.at(-1)).toMatchObject({
      action: 'auth.mfa_failed',
      payload: { reason: 'webauthn_wrong_rp' },
    });
  });
});
