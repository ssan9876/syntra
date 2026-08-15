import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { SessionScope } from './session-service.js';

/** A step-up attempt is short-lived on purpose: it is a half-open door. */
export const ATTEMPT_LIFETIME_MS = 5 * 60 * 1000;

/**
 * 'verify' — present a factor you already hold.
 * 'enrol'  — enrol a factor of the required kind, because you hold none.
 */
export type AttemptPurpose = 'verify' | 'enrol';

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface IssueAttemptInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  purpose: AttemptPurpose;
  /**
   * The scope of the session to issue once this attempt is satisfied.
   *
   * Recorded here because the issuer is the only party that knows: signing in
   * means 'portal', elevating means 'admin', and launching an application
   * means 'portal' even though the caller already holds a session. Working it
   * out at the far end from whether a cookie was present hands an
   * administrative session to any portal user who completes a step-up, because
   * the browser sends its cookie on every request.
   */
  scope: SessionScope;
  requiredOutcome: 'require_mfa' | 'require_factor';
  requiredFactor: string | null;
  ruleId: string | null;
  now: Date;
}

export interface ResolvedAttempt {
  id: string;
  userId: string;
  applicationId: string | null;
  purpose: AttemptPurpose;
  scope: SessionScope;
  requiredOutcome: 'require_mfa' | 'require_factor';
  requiredFactor: string | null;
  ruleId: string | null;
}

/**
 * The attempt token is a bearer credential for the second half of a sign-in,
 * so only its digest is stored — same reasoning as Session.
 *
 * The caller must record the audit event explaining the attempt in the same
 * transaction as this call. An attempt with no record of why it exists is a
 * half-open door nobody can account for.
 */
export async function issueAttempt(
  tx: TenantClient,
  input: IssueAttemptInput,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + ATTEMPT_LIFETIME_MS);

  await tx.authAttempt.create({
    data: {
      tenantId,
      userId: input.userId,
      tokenHash: hashToken(token),
      applicationId: input.applicationId,
      sourceIp: input.sourceIp,
      purpose: input.purpose,
      scope: input.scope,
      requiredOutcome: input.requiredOutcome,
      requiredFactor: input.requiredFactor,
      ruleId: input.ruleId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/** Reads a live attempt without consuming it. Null for anything unusable. */
export async function findAttempt(
  tx: TenantClient,
  token: string,
  now: Date,
): Promise<ResolvedAttempt | null> {
  const row = await tx.authAttempt.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    applicationId: row.applicationId,
    purpose: row.purpose as AttemptPurpose,
    scope: row.scope as SessionScope,
    requiredOutcome: row.requiredOutcome as 'require_mfa' | 'require_factor',
    requiredFactor: row.requiredFactor,
    ruleId: row.ruleId,
  };
}

/**
 * Marks the attempt used. Conditional on it still being unused, and the caller
 * must check the count: two requests presenting the same attempt token
 * concurrently must not both proceed.
 */
export async function consumeAttempt(
  tx: TenantClient,
  attemptId: string,
  now: Date,
): Promise<boolean> {
  const result = await tx.authAttempt.updateMany({
    where: { id: attemptId, consumedAt: null },
    data: { consumedAt: now },
  });
  return result.count === 1;
}
