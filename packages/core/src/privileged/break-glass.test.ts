import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { verifyChain } from '../audit/audit-service.js';
import { authorize } from '../auth/authorize.js';
import { hashPassword, setPasswordHash } from '../auth/password.js';
import { createSession, resolveSession, type SessionAllowance } from '../auth/session-service.js';
import { createUser } from '../directory/user-service.js';
import { issueApiToken } from '../auth/api-token-service.js';
import { memoryTransport } from '../notify/notification-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import {
  BreakGlassRefusedError,
  approveBreakGlassActivation,
  breakGlassBanner,
  designateBreakGlassAccount,
  endBreakGlassActivation,
  requestBreakGlassActivation,
  reviewBreakGlassActivation,
  revokeBreakGlassAccount,
  rotateBreakGlassCredential,
} from './break-glass.js';
import { mailBreakGlassNotice, runPrivilegedAccessSweep } from './jobs.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };
const MINUTE = 60_000;

let tenantId: string; let admin: string; let second: string; let glass: string;

const actions = () => withTenant(tenantId, async (tx) =>
  (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((event) => event.action));

const elevate = (now: Date) => authorize(tenantId, {
  kind: 'primary',
  principal: { kind: 'password', login: 'glass', password: PASSWORD },
  applicationId: null,
  sourceIp: '10.0.0.9',
  relyingParty: RP,
  scope: 'admin',
  now,
});

const stepUp = (actorUserId: string, at: Date) => ({ actorUserId, stepUpAt: at, sourceIp: null });

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({
    data: { name: 'Acme', slug: 'acme', primaryDomain: 'acme.syntra.test', adminWebauthnRequired: true, breakGlassActivationDelayMinutes: 30 },
  })).id;
  await withTenant(tenantId, async (tx) => {
    const owner = await createRole(tx, 'Owner', [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.RBAC_MANAGE]);
    admin = (await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Admin' })).id;
    second = (await createUser(tx, { login: 'second', email: 'second@acme.test', displayName: 'Second' })).id;
    glass = (await createUser(tx, { login: 'glass', email: 'glass@acme.test', displayName: 'Emergency' })).id;
    for (const id of [admin, second, glass]) await assignRole(tx, id, owner.id);
    await setPasswordHash(tx, glass, PASSWORD_HASH);
  });
});

async function designate(now: Date) {
  return (await designateBreakGlassAccount(tenantId, glass, stepUp(admin, now), now)).credential;
}

describe('designation', () => {
  it('is done by somebody else, from a stepped-up session, and shows the sealed credential once', async () => {
    const now = new Date();
    await expect(designateBreakGlassAccount(tenantId, glass, stepUp(glass, now), now)).rejects.toMatchObject({ code: 'self-not-allowed' });
    await expect(designateBreakGlassAccount(tenantId, glass, stepUp(admin, new Date(now.getTime() - 11 * MINUTE)), now))
      .rejects.toMatchObject({ code: 'step-up-required' });
    const credential = await designate(now);
    expect(credential).toMatch(/^syntra_bg_[A-Za-z0-9_-]{43}$/);
    const row = await withTenant(tenantId, (tx) => tx.breakGlassAccount.findFirstOrThrow({ where: { userId: glass } }));
    expect(row.credentialHash).not.toContain(credential);
    const rotated = (await rotateBreakGlassCredential(tenantId, glass, stepUp(second, now), now)).credential;
    expect(rotated).not.toBe(credential);
    await expect(requestBreakGlassActivation(tenantId, { login: 'glass', credential, reason: 'All security keys lost in the office fire', durationMinutes: 60, sourceIp: null }, now))
      .rejects.toMatchObject({ code: 'invalid-credentials' });
  });
});

describe('the emergency account outside an activation', () => {
  it('is refused the console outright, whatever it holds', async () => {
    const now = new Date();
    await designate(now);
    expect(await elevate(now)).toEqual({ status: 'deny', reason: 'policy_denied' });
    expect(await actions()).toContain('auth.break_glass_refused');
  });

  it('refuses any machine token acting as it, even during an activation', async () => {
    const now = new Date();
    const credential = await designate(now);
    const { activation } = await requestBreakGlassActivation(tenantId, { login: 'glass', credential, reason: 'All security keys lost in the office fire', durationMinutes: 30, sourceIp: null }, now);
    await approveBreakGlassActivation(tenantId, activation.id, stepUp(second, now), now);
    const { token } = await withTenant(tenantId, (tx) => issueApiToken(tx, { userId: glass, name: 't', scopes: [], expiresAt: null, createdBy: admin }));
    expect(await authorize(tenantId, { kind: 'token', token, sourceIp: null, now })).toEqual({ status: 'deny', reason: 'policy_denied' });
  });
});

describe('activation', () => {
  it('answers one refusal for every way of not being an emergency account', async () => {
    const now = new Date();
    const credential = await designate(now);
    const attempt = (login: string, value: string) =>
      requestBreakGlassActivation(tenantId, { login, credential: value, reason: 'All security keys lost in the office fire', durationMinutes: 60, sourceIp: '203.0.113.5' }, now);
    for (const [login, value] of [['nobody', credential], ['admin', credential], ['glass', 'syntra_bg_wrong']] as const) {
      const refusal = await attempt(login, value).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(BreakGlassRefusedError);
      expect(refusal).toMatchObject({ code: 'invalid-credentials' });
    }
    const refused = await withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action: 'break_glass.activation_refused' }, orderBy: { sequence: 'asc' } }));
    expect(refused.map((event) => (event.payload as { reason: string }).reason)).toEqual(['unknown_login', 'not_designated', 'wrong_credential']);
  });

  it('announces at once, waits out the delay, lifts the key requirement for that account only, and ends on its own', async () => {
    const start = new Date(Date.now() - 45 * MINUTE);
    const credential = await designate(start);
    const notice = await requestBreakGlassActivation(tenantId, {
      login: 'GLASS', credential, reason: 'All security keys lost in the office fire', durationMinutes: 60, sourceIp: '203.0.113.5',
    }, start);
    expect(notice.activation).toMatchObject({ status: 'pending', durationMinutes: 60 });
    expect(notice.activation.activatesAt.getTime() - start.getTime()).toBe(30 * MINUTE);
    expect(notice.recipients.map((r) => r.email).sort()).toEqual(['admin@acme.test', 'glass@acme.test', 'second@acme.test']);

    const mail = memoryTransport();
    expect(await mailBreakGlassNotice(mail, tenantId, notice, 'requested')).toBe(3);
    expect(mail.sent[0]!.subject).toContain('Emergency access requested for Emergency');
    expect(mail.sent[0]!.text).not.toContain(credential);

    // Still inside the delay: refused.
    expect(await elevate(new Date(start.getTime() + 10 * MINUTE))).toMatchObject({ status: 'deny' });
    expect((await breakGlassBanner(tenantId, new Date(start.getTime() + 10 * MINUTE))).activations[0]).toMatchObject({ status: 'pending' });

    // Past the delay, sign-in goes through authorize() and carries the activation.
    const now = new Date();
    const decision = await elevate(now);
    expect(decision).toMatchObject({ status: 'allow', scope: 'admin' });
    const activationId = (decision as SessionAllowance).breakGlassActivationId!;
    expect(activationId).toBe(notice.activation.id);

    // The session lives while the activation does, despite the key requirement.
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, decision as SessionAllowance, { ip: null, userAgent: null }));
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token))).toMatchObject({ breakGlassActivationId: activationId });

    // Somebody else, without an activation, is still held to the key.
    await withTenant(tenantId, (tx) => setPasswordHash(tx, second, PASSWORD_HASH));
    const other = await authorize(tenantId, {
      kind: 'primary', principal: { kind: 'password', login: 'second', password: PASSWORD }, applicationId: null,
      sourceIp: null, relyingParty: RP, scope: 'admin', now,
    });
    expect(other).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });

    // Past its expiry the sweep closes it, owes a review, and the session stops.
    const after = new Date(start.getTime() + 91 * MINUTE);
    await runPrivilegedAccessSweep(tenantId, null, after);
    const row = await withTenant(tenantId, (tx) => tx.breakGlassActivation.findUniqueOrThrow({ where: { id: activationId } }));
    expect(row).toMatchObject({ status: 'expired', reviewStatus: 'pending', activatedBy: 'delay' });
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token))).toBeNull();

    expect(await actions()).toEqual(expect.arrayContaining([
      'break_glass.account_designated', 'break_glass.activation_requested', 'break_glass.activated', 'break_glass.expired',
    ]));
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('can be approved early only by somebody else, cancelled by anyone, and ended early', async () => {
    const now = new Date();
    const credential = await designate(now);
    const ask = () => requestBreakGlassActivation(tenantId, { login: 'glass', credential, reason: 'Keys lost; SSO provider down too', durationMinutes: 30, sourceIp: null }, now);
    const first = (await ask()).activation;
    await expect(ask()).rejects.toMatchObject({ code: 'activation-open' });
    await expect(approveBreakGlassActivation(tenantId, first.id, stepUp(glass, now), now)).rejects.toMatchObject({ code: 'self-not-allowed' });
    const cancelled = await endBreakGlassActivation(tenantId, first.id, { actorUserId: second, sourceIp: null }, now);
    expect(cancelled.status).toBe('cancelled');

    const again = (await ask()).activation;
    const approved = await approveBreakGlassActivation(tenantId, again.id, stepUp(second, now), now);
    expect(approved.activation).toMatchObject({ status: 'active', activatedBy: 'approval', approvedByUserId: second });
    const decision = await elevate(now);
    expect(decision).toMatchObject({ status: 'allow', breakGlassActivationId: again.id });
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, decision as SessionAllowance, { ip: null, userAgent: null }));

    await expect(revokeBreakGlassAccount(tenantId, glass, stepUp(admin, now), now)).rejects.toMatchObject({ code: 'activation-open' });
    const ended = await endBreakGlassActivation(tenantId, again.id, { actorUserId: admin, sourceIp: null }, now);
    expect(ended).toMatchObject({ status: 'ended', reviewStatus: 'pending' });
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token))).toBeNull();
    expect((await breakGlassBanner(tenantId, now)).reviewsDue).toBe(1);
  });
});

describe('post-event review', () => {
  it('must be completed by somebody else, with findings, from a stepped-up session', async () => {
    const now = new Date();
    const credential = await designate(now);
    const { activation } = await requestBreakGlassActivation(tenantId, { login: 'glass', credential, reason: 'Keys lost; SSO provider down too', durationMinutes: 30, sourceIp: null }, now);
    await approveBreakGlassActivation(tenantId, activation.id, stepUp(second, now), now);
    await endBreakGlassActivation(tenantId, activation.id, { actorUserId: glass, sourceIp: null }, now);

    const review = (actor: string, notes: string, at = now) =>
      reviewBreakGlassActivation(tenantId, activation.id, { ...stepUp(actor, at), notes }, now);
    await expect(review(glass, 'I reviewed my own session thoroughly')).rejects.toMatchObject({ code: 'self-not-allowed' });
    await expect(review(admin, 'fine')).rejects.toMatchObject({ code: 'reason-required' });
    await expect(review(admin, 'Reset keys for two admins; nothing else', new Date(now.getTime() - 11 * MINUTE))).rejects.toMatchObject({ code: 'step-up-required' });
    const done = await review(admin, 'Reset keys for two admins; nothing else');
    expect(done).toMatchObject({ reviewStatus: 'completed', reviewedByUserId: admin });
    expect((await breakGlassBanner(tenantId, now)).reviewsDue).toBe(0);

    // And the database refuses the account reviewing itself whatever the code does.
    await expect(withTenant(tenantId, (tx) => tx.breakGlassActivation.update({ where: { id: activation.id }, data: { reviewedByUserId: glass } })))
      .rejects.toThrow(/reviewer_not_self/);
  });
});
