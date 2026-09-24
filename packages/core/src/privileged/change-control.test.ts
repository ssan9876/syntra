import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { verifyChain } from '../audit/audit-service.js';
import { STEP_UP_MAX_AGE_MS } from '../auth/session-service.js';
import { createUser } from '../directory/user-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole, hasPermission } from '../rbac/rbac-service.js';
import { isSecurityEvent } from '../notify/security-events.js';
import { BREAK_GLASS_STEP_UP_MAX_AGE_MS } from './break-glass.js';
import { authPolicyRelaxations } from './auth-policy.js';
import {
  CHANGE_REQUEST_WINDOW_MS,
  ChangeRequestRefusedError,
  approvePrivilegedChange,
  changeControlPolicyHandler,
  expirePrivilegedChanges,
  readChangeControlPolicy,
  rejectPrivilegedChange,
  requestPrivilegedChange,
  setChangeControlPolicy,
  withdrawPrivilegedChange,
  type PrivilegedChangeHandlers,
} from './change-control.js';
import {
  ROLE_ASSIGN_OPERATION,
  roleAssignHandler,
  roleAssignRevision,
  roleIsPrivileged,
  tokenIsAdminScoped,
} from './rbac-handlers.js';

let tenantId: string; let requester: string; let approver: string; let subject: string; let adminRole: string;
const now = new Date('2026-11-01T12:00:00Z');
const handlers: PrivilegedChangeHandlers = {
  [ROLE_ASSIGN_OPERATION]: roleAssignHandler,
  [changeControlPolicyHandler.operation]: changeControlPolicyHandler,
};

const actions = () => withTenant(tenantId, async (tx) =>
  (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((event) => event.action));

async function requestGrant() {
  return withTenant(tenantId, async (tx) => {
    const proposed = { roleId: adminRole, userId: subject, scopeOrgUnitId: null };
    return requestPrivilegedChange(tx, {
      changeClass: 'role_grant', operation: ROLE_ASSIGN_OPERATION, targetType: 'User', targetId: subject,
      summary: 'Grant Tenant admin', proposed, baseRevision: await roleAssignRevision(tx, proposed),
      reason: 'New on-call administrator for the platform team', actorUserId: requester, sourceIp: null,
    }, now);
  });
}

const approve = (id: string, actorUserId: string, stepUpAt = now, at = now) =>
  approvePrivilegedChange(tenantId, id, { actorUserId, stepUpAt, satisfiedFactor: 'webauthn', sourceIp: null }, handlers, at);

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    requester = (await createUser(tx, { login: 'req', email: 'req@acme.test', displayName: 'Requester' })).id;
    approver = (await createUser(tx, { login: 'appr', email: 'appr@acme.test', displayName: 'Approver' })).id;
    subject = (await createUser(tx, { login: 'subj', email: 'subj@acme.test', displayName: 'Subject' })).id;
    const rbac = await createRole(tx, 'Role admins', [PERMISSIONS.RBAC_MANAGE, PERMISSIONS.TENANT_MANAGE]);
    await assignRole(tx, requester, rbac.id);
    await assignRole(tx, approver, rbac.id);
    adminRole = (await createRole(tx, 'Tenant admin', [PERMISSIONS.TENANT_MANAGE])).id;
  });
});

describe('what counts as privileged', () => {
  it('treats a role carrying a privileged permission, and an unscoped token on a privileged account, as privileged', async () => {
    await withTenant(tenantId, async (tx) => {
      const plain = await createRole(tx, 'Readers', [PERMISSIONS.DIRECTORY_READ]);
      expect(await roleIsPrivileged(tx, adminRole)).toBe(true);
      expect(await roleIsPrivileged(tx, plain.id)).toBe(false);
      expect(await tokenIsAdminScoped(tx, subject, [PERMISSIONS.DIRECTORY_READ])).toBe(false);
      expect(await tokenIsAdminScoped(tx, subject, [PERMISSIONS.RBAC_MANAGE])).toBe(true);
      expect(await tokenIsAdminScoped(tx, subject, [])).toBe(false);
      expect(await tokenIsAdminScoped(tx, requester, [])).toBe(true);
    });
  });
});

describe('privileged change requests', () => {
  it('applies only when a different, freshly stepped-up administrator approves, and audits every step', async () => {
    const request = await requestGrant();
    expect(request.status).toBe('pending');
    expect(request.expiresAt.getTime() - now.getTime()).toBe(CHANGE_REQUEST_WINDOW_MS);
    expect(await withTenant(tenantId, (tx) => hasPermission(tx, subject, PERMISSIONS.TENANT_MANAGE))).toBe(false);

    await expect(approve(request.id, requester)).rejects.toMatchObject({ code: 'four-eyes-required' });
    await expect(approve(request.id, approver, new Date(now.getTime() - STEP_UP_MAX_AGE_MS - 1)))
      .rejects.toMatchObject({ code: 'step-up-required' });

    const { request: applied } = await approve(request.id, approver);
    expect(applied).toMatchObject({ status: 'applied', decidedByUserId: approver, result: { roleId: adminRole, userId: subject } });
    expect(await withTenant(tenantId, (tx) => hasPermission(tx, subject, PERMISSIONS.TENANT_MANAGE))).toBe(true);
    await expect(approve(request.id, approver)).rejects.toMatchObject({ code: 'not-pending' });

    expect(await actions()).toEqual([
      'change_request.created',
      'change_request.approve_refused',
      'change_request.approve_refused',
      'rbac.role_assigned',
      'change_request.approved',
      'change_request.approve_refused',
    ]);
    for (const action of ['change_request.created', 'change_request.approved']) expect(isSecurityEvent(action)).toBe(true);
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('refuses an approver without the class permission', async () => {
    const outsider = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, { login: 'out', email: 'out@acme.test', displayName: 'Outsider' });
      await assignRole(tx, user.id, (await createRole(tx, 'Tenant only', [PERMISSIONS.TENANT_MANAGE])).id);
      return user.id;
    });
    const request = await requestGrant();
    await expect(approve(request.id, outsider)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('invalidates the request when the role changed after it was made', async () => {
    const request = await requestGrant();
    await withTenant(tenantId, (tx) => tx.role.update({ where: { id: adminRole }, data: { permissions: [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.RBAC_MANAGE] } }));
    await expect(approve(request.id, approver)).rejects.toMatchObject({ code: 'stale' });
    const row = await withTenant(tenantId, (tx) => tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id: request.id } }));
    expect(row).toMatchObject({ status: 'invalidated', closedReason: 'stale' });
    expect(await withTenant(tenantId, (tx) => hasPermission(tx, subject, PERMISSIONS.TENANT_MANAGE))).toBe(false);
  });

  it('expires, and a decision after the window is refused', async () => {
    const request = await requestGrant();
    const late = new Date(now.getTime() + CHANGE_REQUEST_WINDOW_MS + 1);
    await expect(approve(request.id, approver, late, late)).rejects.toMatchObject({ code: 'expired' });
    expect(await expirePrivilegedChanges(tenantId, late)).toBe(0);
    const row = await withTenant(tenantId, (tx) => tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id: request.id } }));
    expect(row.status).toBe('expired');
    expect(await actions()).toContain('change_request.expired');
  });

  it('lets only the requester withdraw and only somebody else reject', async () => {
    const first = await requestGrant();
    await expect(withdrawPrivilegedChange(tenantId, first.id, { actorUserId: approver, sourceIp: null }, now)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rejectPrivilegedChange(tenantId, first.id, { actorUserId: requester, sourceIp: null }, now)).rejects.toMatchObject({ code: 'four-eyes-required' });
    expect((await withdrawPrivilegedChange(tenantId, first.id, { actorUserId: requester, sourceIp: null }, now)).status).toBe('withdrawn');
    const second = await requestGrant();
    const rejected = await rejectPrivilegedChange(tenantId, second.id, { actorUserId: approver, sourceIp: null, note: 'Not on the rota' }, now);
    expect(rejected).toMatchObject({ status: 'rejected', decidedByUserId: approver, decisionNote: 'Not on the rota' });
  });

  it('is enforced by the database: the requester can never be recorded as the decider', async () => {
    const request = await requestGrant();
    await expect(withTenant(tenantId, (tx) => tx.privilegedChangeRequest.update({
      where: { id: request.id },
      data: { status: 'applied', decidedByUserId: requester, decidedAt: now, deciderStepUpAt: now },
    }))).rejects.toThrow(/four_eyes/);
    await expect(withTenant(tenantId, (tx) => tx.privilegedChangeRequest.update({
      where: { id: request.id },
      data: { status: 'applied', decidedByUserId: approver, decidedAt: now, deciderStepUpAt: new Date(now.getTime() - 11 * 60_000) },
    }))).rejects.toThrow(/applied_step_up/);
  });

  it('requires a substantive reason', async () => {
    await expect(withTenant(tenantId, (tx) => requestPrivilegedChange(tx, {
      changeClass: 'role_grant', operation: ROLE_ASSIGN_OPERATION, targetType: 'User', targetId: subject, summary: 's',
      proposed: {}, baseRevision: 'a'.repeat(64), reason: 'short', actorUserId: requester, sourceIp: null,
    }, now))).rejects.toBeInstanceOf(ChangeRequestRefusedError);
  });
});

describe('the policy itself', () => {
  it('applies tightening at once and holds switching a class off for a second administrator', async () => {
    const on = await withTenant(tenantId, (tx) => setChangeControlPolicy(tx, ['role_grant', 'auth_policy'], { actorUserId: requester, sourceIp: null }, now));
    expect(on).toEqual({ held: false, classes: ['auth_policy', 'role_grant'] });
    const off = await withTenant(tenantId, (tx) => setChangeControlPolicy(tx, ['auth_policy'], { actorUserId: requester, sourceIp: null, reason: 'Role grants are reviewed in Govern now' }, now));
    expect(off.held).toBe(true);
    expect(await withTenant(tenantId, (tx) => readChangeControlPolicy(tx))).toEqual(['auth_policy', 'role_grant']);
    if (!off.held) throw new Error('unreachable');
    await approve(off.request.id, approver);
    expect(await withTenant(tenantId, (tx) => readChangeControlPolicy(tx))).toEqual(['auth_policy']);
  });

  it('refuses a class the database does not know', async () => {
    await expect(withTenant(tenantId, (tx) => setChangeControlPolicy(tx, ['federation'], { actorUserId: requester, sourceIp: null }, now)))
      .rejects.toMatchObject({ code: 'unknown-class' });
  });

  it('keeps the break-glass step-up window equal to the shared one', () => {
    expect(BREAK_GLASS_STEP_UP_MAX_AGE_MS).toBe(STEP_UP_MAX_AGE_MS);
  });
});

describe('authentication-policy relaxation', () => {
  const base = {
    adminMfaRequired: true, adminWebauthnRequired: true, emailOtpEnabled: false, passwordMinLength: 14, passwordHistoryDepth: 5,
    lockoutThreshold: 5, lockoutWindowMinutes: 15, lockoutDurationMinutes: 30, passwordMaxAgeDays: 0,
    portalSessionIdleMinutes: 60, portalSessionAbsoluteMinutes: 720, adminSessionIdleMinutes: 15, adminSessionAbsoluteMinutes: 120,
  };

  it('names each setting a change weakens, and nothing it tightens', () => {
    expect(authPolicyRelaxations(base, { passwordMinLength: 16, lockoutThreshold: 3, adminSessionIdleMinutes: 10 })).toEqual([]);
    expect(authPolicyRelaxations(base, {
      adminWebauthnRequired: false, emailOtpEnabled: true, passwordMinLength: 12, lockoutThreshold: 0,
      lockoutDurationMinutes: 10, adminSessionAbsoluteMinutes: 240,
    })).toEqual(['adminWebauthnRequired', 'emailOtpEnabled', 'passwordMinLength', 'lockoutThreshold', 'lockoutDurationMinutes', 'adminSessionAbsoluteMinutes']);
  });

  it('reads zero as the strictest lock and as "never expires" for passwords', () => {
    expect(authPolicyRelaxations({ ...base, lockoutDurationMinutes: 0 }, { lockoutDurationMinutes: 60 })).toEqual(['lockoutDurationMinutes']);
    expect(authPolicyRelaxations(base, { lockoutDurationMinutes: 0 })).toEqual([]);
    expect(authPolicyRelaxations(base, { passwordMaxAgeDays: 90 })).toEqual([]);
    expect(authPolicyRelaxations({ ...base, passwordMaxAgeDays: 90 }, { passwordMaxAgeDays: 0 })).toEqual(['passwordMaxAgeDays']);
  });
});
