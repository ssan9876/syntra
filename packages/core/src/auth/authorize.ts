import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { buildAuthContext } from '../policy/context.js';
import { evaluatePolicy } from '../policy/evaluate.js';
import { loadPolicy } from '../policy/policy-service.js';
import type {
  FactorType,
  PolicyDecision,
  PolicyOutcome,
} from '../policy/types.js';
import { isAdministrator } from '../rbac/rbac-service.js';
import {
  consumeAttempt,
  findAttempt,
  issueAttempt,
  type ResolvedAttempt,
} from './attempt-service.js';
import { authenticate } from './login-service.js';
import type { SessionScope } from './session-service.js';
import {
  enrolledFactorTypes,
  enrollableFactorTypes,
  hasRecoveryCodes,
  verifyFactor,
} from './mfa/registry.js';
import type { RelyingParty } from './mfa/relying-party.js';
import type { FactorPresentation, FactorPresentationType } from './mfa/types.js';

export type Principal =
  | { kind: 'password'; login: string; password: string }
  /**
   * An existing Syntra session re-entering — used when launching an app.
   *
   * `satisfiedFactor` is what that session was established with, read off the
   * Session row. Without it every launch of an application covered by a
   * `require_mfa` rule re-issues the same challenge the user just answered,
   * and the application becomes permanently unreachable.
   */
  | {
      kind: 'session';
      userId: string;
      sessionId: string;
      satisfiedFactor: FactorPresentationType | null;
    }
  /**
   * Primary authentication happened somewhere else. Access II's upstream
   * federation adapter constructs this after the upstream provider has
   * asserted the identity; `issuer` goes into the audit event so a decision
   * can be traced back to who vouched for it.
   */
  | { kind: 'external'; userId: string; issuer: string };

export type AuthorizeRequest =
  | {
      kind: 'primary';
      principal: Principal;
      applicationId: string | null;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      /**
       * What kind of session to issue if this succeeds, and what to record on
       * any attempt this has to open along the way. The caller knows; nothing
       * downstream can work it out from ambient state without getting it
       * wrong.
       */
      scope: SessionScope;
      /**
       * A minimum the caller imposes regardless of policy. Elevation to an
       * administrative session uses it. It can only strengthen the outcome —
       * a floor never turns a deny into an allow.
       */
      floor?: PolicyOutcome | undefined;
      now?: Date | undefined;
    }
  | {
      kind: 'continue';
      attemptToken: string;
      factor: FactorPresentation;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      now?: Date | undefined;
    }
  | {
      /**
       * The user has just enrolled a factor under a forced-enrolment attempt.
       * The claim is not trusted: this re-reads what they actually hold before
       * treating the requirement as satisfied.
       */
      kind: 'enrolled';
      attemptToken: string;
      enrolledFactor: FactorType;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      now?: Date | undefined;
    };

export type DenyReason =
  | 'invalid_credentials'
  | 'user_inactive'
  | 'policy_denied'
  | 'factor_not_enrolled'
  | 'factor_invalid'
  /**
   * The code was arithmetically correct but belongs to the counter step that
   * completed enrolment, and the replay watermark refuses it. Distinct from
   * `factor_invalid` because the caller must be able to say so: an unexplained
   * rejection of a code the user can see on their screen is a support ticket,
   * and an explained one is a sentence.
   */
  | 'factor_used_for_enrolment'
  | 'attempt_invalid';

export type AuthorizeResult =
  | {
      status: 'allow';
      userId: string;
      mayElevate: boolean;
      applicationId: string | null;
      /** Carried from the request, or from the attempt on a step-up. */
      scope: SessionScope;
      satisfiedFactor: FactorPresentationType | null;
    }
  | {
      /** Present a factor you already hold. */
      status: 'challenge';
      attemptToken: string;
      expiresAt: Date;
      /**
       * Includes 'recovery_code' when one would be accepted. It is a
       * `FactorPresentationType[]` rather than `FactorType[]` for exactly that
       * reason: a user whose only remaining factor is a printed code would
       * otherwise be handed an empty list, and the screen would open a
       * WebAuthn prompt for a key they do not have.
       */
      acceptableFactors: FactorPresentationType[];
      enrolledFactors: FactorType[];
    }
  | {
      /** Enrol a factor of the required kind. No session until you do. */
      status: 'enrol';
      attemptToken: string;
      expiresAt: Date;
      enrollableFactors: FactorType[];
    }
  | { status: 'deny'; reason: DenyReason };

const STRENGTH: Record<PolicyOutcome, number> = {
  allow: 0,
  require_mfa: 1,
  require_factor: 2,
  deny: 3,
};

/** A floor may only strengthen. Ordering the outcomes is what makes that true. */
function applyFloor(
  decision: PolicyDecision,
  floor: PolicyOutcome | undefined,
): PolicyDecision {
  if (!floor) return decision;
  if (STRENGTH[floor] <= STRENGTH[decision.outcome]) return decision;
  return { outcome: floor, factorType: null, ruleId: null, ruleName: null };
}

/**
 * Whether a factor that has already been presented or enrolled during this
 * flow satisfies what the policy is asking for.
 *
 * A recovery code satisfies "any second factor" and never a named one: a rule
 * that asks for WebAuthn is asking for the hardware, and a printed code is not
 * it.
 */
function satisfiesRequirement(
  decision: PolicyDecision,
  satisfied: FactorPresentationType | null,
): boolean {
  if (!satisfied) return false;
  if (decision.outcome === 'require_mfa') return true;
  if (decision.outcome === 'require_factor') {
    return satisfied === decision.factorType;
  }
  return false;
}

async function audit(
  tx: TenantClient,
  input: {
    userId: string | null;
    action: string;
    outcome: 'success' | 'failure';
    sourceIp: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: input.userId,
    action: input.action,
    targetType: 'User',
    targetId: input.userId,
    outcome: input.outcome,
    sourceIp: input.sourceIp,
    payload: input.payload,
  });
}

/**
 * The single authentication chokepoint.
 *
 * Every path that establishes who the caller is — local login, elevation,
 * application launch, and in Access II every protocol adapter and upstream
 * federation — comes through here. Policy evaluation, second-factor
 * requirements and the audit trail live here and nowhere else. A caller that
 * wants a session asks this function first; there is no second way to get an
 * allow, which is what stops a policy bypass hiding inside one adapter's code
 * path.
 *
 * It takes a tenantId rather than a caller's transaction, and opens one
 * transaction per phase. Factor verification is signature and hash work that
 * may reach outside the process, and Prisma's interactive transactions time
 * out at 5000 ms; running it inside the caller's transaction would make a slow
 * authenticator into an aborted transaction rather than a failed login.
 *
 * Everything request-derived that a decision depends on — the source address,
 * the relying party — is a field on the request rather than ambient state, so
 * a caller that cannot supply it fails to compile.
 */
export async function authorize(
  tenantId: string,
  request: AuthorizeRequest,
): Promise<AuthorizeResult> {
  const now = request.now ?? new Date();
  if (request.kind === 'primary') return primary(tenantId, request, now);
  if (request.kind === 'continue') {
    return continueAttempt(tenantId, request, now);
  }
  return completeEnrolment(tenantId, request, now);
}

async function primary(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'primary' }>,
  now: Date,
): Promise<AuthorizeResult> {
  // Phase 1 — establish the principal. authenticate() audits its own outcome.
  //
  // Deliberately not inside a transaction. It hashes with Argon2id, which is
  // expensive by design, and it opens its own transactions around that work
  // for exactly the reason given in this function's docstring.
  const identified = await identify(tenantId, request);

  if (!identified.ok) return { status: 'deny', reason: identified.reason };

  return decide(tenantId, {
    userId: identified.userId,
    applicationId: request.applicationId,
    sourceIp: request.sourceIp,
    scope: request.scope,
    floor: request.floor,
    // A session principal brings whatever factor established it. Launching an
    // application is a fresh decision, but it is not a fresh sign-in, and the
    // factor the user already presented still counts.
    satisfied: identified.satisfied,
    now,
  });
}

type Identified =
  | { ok: true; userId: string; satisfied: FactorPresentationType | null }
  | { ok: false; reason: 'invalid_credentials' | 'user_inactive' };

async function identify(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'primary' }>,
): Promise<Identified> {
  if (request.principal.kind === 'password') {
    const result = await authenticate(tenantId, {
      login: request.principal.login,
      password: request.principal.password,
      sourceIp: request.sourceIp,
    });
    return result.ok
      ? { ok: true, userId: result.userId, satisfied: null }
      : {
          ok: false,
          reason:
            result.reason === 'user_inactive'
              ? 'user_inactive'
              : 'invalid_credentials',
        };
  }

  const principal = request.principal;

  return withTenant(tenantId, async (tx): Promise<Identified> => {
    const userId = principal.userId;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      await audit(tx, {
        userId: null,
        action: 'auth.login',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: {
          reason: 'invalid_credentials',
          principal: principal.kind,
        },
      });
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (user.status !== 'active') {
      await audit(tx, {
        userId,
        action: 'auth.login',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: { reason: 'user_inactive', principal: principal.kind },
      });
      return { ok: false, reason: 'user_inactive' };
    }
    await audit(tx, {
      userId,
      action: 'auth.login',
      outcome: 'success',
      sourceIp: request.sourceIp,
      payload:
        principal.kind === 'external'
          ? { principal: 'external', issuer: principal.issuer }
          : { principal: 'session' },
    });
    return {
      ok: true,
      userId,
      satisfied:
        principal.kind === 'session' ? principal.satisfiedFactor : null,
    };
  });
}

interface DecideInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  /** What session to issue, and what to stamp on any attempt opened here. */
  scope: SessionScope;
  floor: PolicyOutcome | undefined;
  /**
   * A factor presented or enrolled during this flow, or the one that
   * established the caller's existing session.
   */
  satisfied: FactorPresentationType | null;
  now: Date;
}

async function decide(
  tenantId: string,
  input: DecideInput,
): Promise<AuthorizeResult> {
  // Phase 2 — evaluate policy and, if a factor is needed, open an attempt.
  return withTenant(tenantId, async (tx): Promise<AuthorizeResult> => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    const policy = await loadPolicy(tx);
    const context = await buildAuthContext(tx, {
      userId: input.userId,
      applicationId: input.applicationId,
      sourceIp: input.sourceIp,
      now: input.now,
    });

    const decision = applyFloor(
      evaluatePolicy(policy.rules, policy.fallback, context),
      input.floor,
    );

    if (decision.outcome === 'deny') {
      await audit(tx, {
        userId: input.userId,
        action: 'auth.policy_denied',
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: {
          reason: 'policy_denied',
          ruleId: decision.ruleId,
          ruleName: decision.ruleName ?? 'tenant default',
          applicationId: input.applicationId,
        },
      });
      return { status: 'deny', reason: 'policy_denied' };
    }

    const allow = async (): Promise<AuthorizeResult> => {
      const mayElevate = await isAdministrator(tx, input.userId);
      return {
        status: 'allow',
        userId: input.userId,
        mayElevate,
        applicationId: input.applicationId,
        scope: input.scope,
        satisfiedFactor: input.satisfied,
      };
    };

    if (decision.outcome === 'allow') return allow();

    // A factor presented or enrolled earlier in this flow settles the
    // requirement without a second round trip. Re-evaluating rather than
    // trusting the earlier decision is what makes a rule tightened mid-flow
    // still apply; this is what stops that costing an extra challenge when it
    // did not tighten.
    if (satisfiesRequirement(decision, input.satisfied)) return allow();

    const enrolled = await enrolledFactorTypes(tx, input.userId);
    const acceptable: FactorPresentationType[] =
      decision.outcome === 'require_factor' && decision.factorType
        ? enrolled.filter((type) => type === decision.factorType)
        : [...enrolled];

    // A recovery code substitutes for "any second factor", never for a named
    // one. It goes into the list the caller is shown, not just into the
    // decision to issue a challenge — a user whose codes are all that is left
    // must be offered them rather than shown an empty screen.
    const recovery =
      decision.outcome === 'require_mfa' &&
      (await hasRecoveryCodes(tx, input.userId));
    if (recovery) acceptable.push('recovery_code');

    if (acceptable.length > 0) {
      // The attempt and the audit event that explains it commit together. An
      // attempt row with no record of why it exists is a half-open door
      // nobody can account for.
      const attempt = await issueAttempt(tx, {
        userId: input.userId,
        applicationId: input.applicationId,
        sourceIp: input.sourceIp,
        purpose: 'verify',
        scope: input.scope,
        requiredOutcome:
          decision.outcome === 'require_factor'
            ? 'require_factor'
            : 'require_mfa',
        requiredFactor: decision.factorType,
        ruleId: decision.ruleId,
        now: input.now,
      });
      await audit(tx, {
        userId: input.userId,
        action: 'auth.mfa_challenged',
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          required: decision.outcome,
          requiredFactor: decision.factorType,
          ruleName: decision.ruleName ?? 'tenant default',
        },
      });
      return {
        status: 'challenge',
        attemptToken: attempt.token,
        expiresAt: attempt.expiresAt,
        acceptableFactors: acceptable,
        enrolledFactors: enrolled,
      };
    }

    // The user holds nothing that satisfies the rule. Rather than refusing —
    // which would lock out everyone the first time a tenant switches MFA on,
    // with no self-service way back — offer to enrol one now.
    //
    // SECURITY TRADE, ACCEPTED DELIBERATELY: a stolen password now buys the
    // attacker the ability to enrol their own factor, because primary
    // authentication has already succeeded by the time we get here. The
    // alternative is a product no tenant can ever turn MFA on in. The same
    // stolen password previously bought a full session with no factor at all,
    // so this is not a step backwards — but it is visible after the fact,
    // which is why the enrolment writes its own audit event naming the
    // forced-enrolment challenge it happened under.
    const offerable = enrollableFactorTypes().filter((type) => {
      // A tenant with no primary domain has no relying party, so a security
      // key cannot be registered against it — the WebAuthn endpoints refuse
      // with a 409 the user standing at the enrolment screen can do nothing
      // about. `policy-service.ts` catches this at write time for a rule that
      // names WebAuthn, where an administrator is there to read the message;
      // a plain `require_mfa` rule reaches the same dead end by another door,
      // and offering the type at all is what walks the user into it.
      if (type === 'webauthn' && !tenant.primaryDomain) return false;
      if (decision.outcome === 'require_factor' && decision.factorType) {
        return type === decision.factorType;
      }
      return true;
    });

    if (tenant.selfEnrolmentEnabled && offerable.length > 0) {
      const attempt = await issueAttempt(tx, {
        userId: input.userId,
        applicationId: input.applicationId,
        sourceIp: input.sourceIp,
        purpose: 'enrol',
        scope: input.scope,
        requiredOutcome:
          decision.outcome === 'require_factor'
            ? 'require_factor'
            : 'require_mfa',
        requiredFactor: decision.factorType,
        ruleId: decision.ruleId,
        now: input.now,
      });
      await audit(tx, {
        userId: input.userId,
        action: 'auth.enrolment_required',
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          required: decision.outcome,
          requiredFactor: decision.factorType,
          ruleName: decision.ruleName ?? 'tenant default',
          offered: offerable,
        },
      });
      return {
        status: 'enrol',
        attemptToken: attempt.token,
        expiresAt: attempt.expiresAt,
        enrollableFactors: offerable,
      };
    }

    // Either the tenant issues factors by hand and has turned self-enrolment
    // off, or this deployment has no verifier for the required type. Both are
    // genuine dead ends, and saying so is honest.
    await audit(tx, {
      userId: input.userId,
      action: 'auth.mfa_unavailable',
      outcome: 'failure',
      sourceIp: input.sourceIp,
      payload: {
        reason: 'factor_not_enrolled',
        required: decision.outcome,
        requiredFactor: decision.factorType,
        ruleName: decision.ruleName ?? 'tenant default',
        selfEnrolmentEnabled: tenant.selfEnrolmentEnabled,
      },
    });
    return { status: 'deny', reason: 'factor_not_enrolled' };
  });
}

/** Reads a live attempt of the expected purpose, or null. */
async function liveAttempt(
  tenantId: string,
  token: string,
  purpose: 'verify' | 'enrol',
  now: Date,
): Promise<ResolvedAttempt | null> {
  const attempt = await withTenant(tenantId, (tx) =>
    findAttempt(tx, token, now),
  );
  // An enrolment attempt cannot be spent on a verification, or a user could be
  // walked into enrolling one factor and signing in with another.
  if (!attempt || attempt.purpose !== purpose) return null;
  return attempt;
}

/** The user must still be there and still be active between the two calls. */
async function stillActive(tenantId: string, userId: string): Promise<boolean> {
  const user = await withTenant(tenantId, (tx) =>
    tx.user.findUnique({ where: { id: userId } }),
  );
  return Boolean(user && user.status === 'active');
}

async function continueAttempt(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'continue' }>,
  now: Date,
): Promise<AuthorizeResult> {
  // Phase 1 — read the attempt. Not consumed yet: a wrong code should cost the
  // user a retry, not the whole sign-in.
  const attempt = await liveAttempt(
    tenantId,
    request.attemptToken,
    'verify',
    now,
  );
  if (!attempt) return { status: 'deny', reason: 'attempt_invalid' };

  // A named factor cannot be satisfied by a different one, and a recovery code
  // never satisfies a named factor.
  if (
    attempt.requiredOutcome === 'require_factor' &&
    attempt.requiredFactor !== request.factor.type
  ) {
    await withTenant(tenantId, (tx) =>
      audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_failed',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: {
          reason: 'wrong_factor_type',
          required: attempt.requiredFactor,
          presented: request.factor.type,
        },
      }),
    );
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // Checked before the factor is verified, not after. A recovery code is spent
  // by the act of verifying it, so a user deactivated mid-flow would otherwise
  // burn one of their ten codes on a sign-in that was always going to be
  // refused. The window between this check and the consume below is still
  // non-zero — a deactivation landing inside it spends the code — and that is
  // accepted: the alternative is holding a transaction open across the
  // verification, which is the constraint this whole design exists to respect.
  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  // Phase 2 — verify. Outside any transaction: this is crypto and, for
  // WebAuthn, possibly a network read.
  const verification = await verifyFactor(
    tenantId,
    attempt.userId,
    request.factor,
    { now, relyingParty: request.relyingParty },
  );

  if (!verification.ok) {
    await withTenant(tenantId, (tx) =>
      audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_failed',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: { reason: verification.reason, factor: request.factor.type },
      }),
    );
    // One verifier reason is surfaced rather than collapsed: the code that
    // completed enrolment is refused by the replay watermark, and a user
    // looking at a correct-looking code on their phone needs to be told that
    // rather than left to guess. It is safe to distinguish here and nowhere
    // else, because reaching this point already required a valid attempt token
    // issued after primary authentication succeeded — it discloses nothing an
    // attacker does not already hold.
    if (verification.reason === 'totp_used_for_enrolment') {
      return { status: 'deny', reason: 'factor_used_for_enrolment' };
    }
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // Phase 3 — consume the attempt and audit it together, then re-decide.
  const consumed = await withTenant(tenantId, async (tx) => {
    const ok = await consumeAttempt(tx, attempt.id, now);
    if (ok) {
      await audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_verified',
        outcome: 'success',
        sourceIp: request.sourceIp,
        payload: { factor: request.factor.type },
      });
    }
    return ok;
  });
  if (!consumed) return { status: 'deny', reason: 'attempt_invalid' };

  // Re-evaluating rather than trusting the stored decision means a rule
  // tightened while the user was reaching for their phone still applies.
  return decide(tenantId, {
    userId: attempt.userId,
    applicationId: attempt.applicationId,
    sourceIp: request.sourceIp,
    // From the attempt, which recorded what its issuer intended. Never from
    // whether this request happened to arrive with a cookie.
    scope: attempt.scope,
    floor: undefined,
    satisfied: request.factor.type,
    now,
  });
}

async function completeEnrolment(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'enrolled' }>,
  now: Date,
): Promise<AuthorizeResult> {
  const attempt = await liveAttempt(
    tenantId,
    request.attemptToken,
    'enrol',
    now,
  );
  if (!attempt) return { status: 'deny', reason: 'attempt_invalid' };
  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  if (
    attempt.requiredOutcome === 'require_factor' &&
    attempt.requiredFactor !== request.enrolledFactor
  ) {
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // The caller's claim is not evidence. Read what the user actually holds now:
  // the enrolment endpoint and this call are separate requests, and only the
  // database knows whether the enrolment committed.
  const enrolled = await withTenant(tenantId, (tx) =>
    enrolledFactorTypes(tx, attempt.userId),
  );
  if (!enrolled.includes(request.enrolledFactor)) {
    return { status: 'deny', reason: 'factor_not_enrolled' };
  }

  const consumed = await withTenant(tenantId, async (tx) => {
    const ok = await consumeAttempt(tx, attempt.id, now);
    if (ok) {
      // Named explicitly, so a factor enrolled by whoever held the password
      // during a forced-enrolment challenge is visible in the log afterwards
      // rather than looking like an ordinary self-service enrolment.
      await audit(tx, {
        userId: attempt.userId,
        action: 'auth.forced_enrolment_completed',
        outcome: 'success',
        sourceIp: request.sourceIp,
        payload: {
          factor: request.enrolledFactor,
          required: attempt.requiredOutcome,
          requiredFactor: attempt.requiredFactor,
          ruleId: attempt.ruleId,
          underForcedEnrolment: true,
        },
      });
    }
    return ok;
  });
  if (!consumed) return { status: 'deny', reason: 'attempt_invalid' };

  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  // Enrolling is itself proof of possession — a TOTP enrolment is confirmed by
  // a live code, and a WebAuthn registration carries an attestation the
  // authenticator signed. So the factor counts as presented for this sign-in,
  // and the user is not asked for it twice in a row.
  return decide(tenantId, {
    userId: attempt.userId,
    applicationId: attempt.applicationId,
    sourceIp: request.sourceIp,
    scope: attempt.scope,
    floor: undefined,
    satisfied: request.enrolledFactor,
    now,
  });
}
