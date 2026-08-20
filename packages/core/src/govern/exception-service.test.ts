import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS, assignRole, createRole } from '@syntra/core';
import {
  ExceptionRefusedError,
  decideSodException,
  requestSodException,
  revokeSodException,
  sweepExceptions,
} from './exception-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

let tenantId: string;
let ruleId: string;
let violationId: string;
let beneficiaryId: string;
let acceptorUserId: string;
let acceptorPersonId: string;
let teachingContractId: string;
let researchContractId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const anna = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    const dirk = await tx.person.create({ data: { tenantId, givenName: 'Dirk', familyName: 'Finance' } });
    const teaching = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    const research = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 2, startDate: new Date('2021-01-01') },
    });
    await tx.contract.create({
      data: { tenantId, personId: dirk.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
    });
    await tx.user.create({
      data: { tenantId, login: 'anna', email: 'anna@a.test', displayName: 'Anna Novak', personId: anna.id },
    });
    const dirkUser = await tx.user.create({
      data: { tenantId, login: 'dirk', email: 'dirk@a.test', displayName: 'Dirk Finance', personId: dirk.id },
    });
    const role = await createRole(tx, 'Risk acceptor', [PERMISSIONS.GOVERN_ACCEPT_RISK]);
    await assignRole(tx, dirkUser.id, role.id);

    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const a = await tx.businessFunction.create({ data: { tenantId, name: 'Raise', ownerPersonId: dirk.id } });
    const b = await tx.businessFunction.create({ data: { tenantId, name: 'Approve', ownerPersonId: dirk.id } });
    const rule = await tx.sodRule.create({
      data: {
        tenantId, name: 'Payment raising and approval', functionAId: a.id, functionBId: b.id,
        severity: 'critical', rationale: 'raise and approve', enabled: true,
      },
    });
    const violation = await tx.sodViolation.create({
      data: {
        tenantId, ruleId: rule.id, personId: anna.id,
        holdingsA: [], holdingsB: [], contractsA: [teaching.id], contractsB: [research.id],
        severity: 'critical', firstSeenAt: NOW, lastSeenAt: NOW, lastSnapshotId: snapshot.id,
      },
    });
    await tx.governFinding.create({
      data: {
        tenantId, kind: 'sod_violation', severity: 'critical',
        subjectRefType: 'sod_violation', subjectRefId: `${rule.id}:${anna.id}`,
        detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
      },
    });

    // A LIVE GRANT for the beneficiary. Without one, every "revokes nothing"
    // in this file is a title rather than an assertion: the mutation that
    // revokes on lapse or on refusal has nothing to take away, so it passes.
    await tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId: anna.id,
        resourceType: 'application',
        resourceId: '30000000-0000-0000-0000-000000000001',
        origin: 'request',
        startsAt: new Date('2020-01-01'),
        status: 'active',
      },
    });

    return {
      ruleId: rule.id, violationId: violation.id, beneficiaryId: anna.id,
      acceptorUserId: dirkUser.id, acceptorPersonId: dirk.id,
      teachingContractId: teaching.id, researchContractId: research.id,
    };
  });

  ruleId = seeded.ruleId;
  violationId = seeded.violationId;
  beneficiaryId = seeded.beneficiaryId;
  acceptorUserId = seeded.acceptorUserId;
  acceptorPersonId = seeded.acceptorPersonId;
  teachingContractId = seeded.teachingContractId;
  researchContractId = seeded.researchContractId;
});

const request = (over: Record<string, unknown> = {}) => ({
  ruleId, personId: beneficiaryId, violationId,
  justification: 'these are two separate engagements',
  compensatingControl: 'monthly review of every payment she raises',
  basisContractIds: [teachingContractId, researchContractId],
  startsAt: NOW,
  endsAt: days(30),
  ...over,
});

/** Every live grant the beneficiary holds is still live. */
async function grantsUntouched(): Promise<void> {
  const grants = await withTenant(tenantId, (tx) =>
    tx.accessGrant.findMany({ where: { subjectPersonId: beneficiaryId } }),
  );
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ status: 'active', endsAt: null });
}

describe('for how long', () => {
  it('refuses an exception longer than maxExceptionDays', async () => {
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ endsAt: days(400) })),
    ).rejects.toMatchObject({ code: 'too_long' });
  });

  it('refuses one with no justification or no compensating control', async () => {
    // Both required. A perpetual, unjustified, uncompensated exception is how
    // an SoD programme dies quietly.
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ justification: '  ' })),
    ).rejects.toMatchObject({ code: 'missing_justification' });
    await expect(
      requestSodException(tenantId, acceptorUserId, request({ compensatingControl: '' })),
    ).rejects.toMatchObject({ code: 'missing_justification' });
  });
});

describe('who may grant one', () => {
  it('falls back to the holders of govern.accept_risk when the rule names no workflow', async () => {
    const { id, status } = await requestSodException(tenantId, acceptorUserId, request());
    expect(status).toBe('pending');
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'accepted for one quarter');

    const [exception, violation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
    ]);
    expect(exception).toMatchObject({ status: 'active', approvedByPersonId: acceptorPersonId });
    expect(violation.status).toBe('excepted');
  });

  it('uses the rule’s WORKFLOW when it names one, and drops the beneficiary from it', async () => {
    // §12's reason, applied to risk acceptance: Automate's resolver is reused
    // rather than a second one written, because an approval chain and a
    // risk-acceptance chain disagreeing about who somebody's manager is would
    // be a support call nobody can close. Untested, this branch would be a
    // second resolver in all but name.
    await withTenant(tenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId, name: 'Risk acceptance' },
      });
      // A THIRD person as the fallback — `approval_stage_fallback_required`
      // demands one for `manager`, and pointing it at Dirk would make the
      // assertion below pass whether the manager selector ran or not.
      const eva = await tx.person.create({
        data: { tenantId, givenName: 'Eva', familyName: 'Fallback' },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: eva.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'eva',
          email: 'eva@a.test',
          displayName: 'Eva Fallback',
          personId: eva.id,
        },
      });
      await tx.approvalStage.create({
        data: {
          tenantId,
          workflowId: workflow.id,
          sequence: 1,
          name: 'Manager',
          selector: 'manager',
          selectorConfig: {},
          fallbackSelector: 'person',
          fallbackConfig: { personId: eva.id },
        },
      });
      await tx.sodRule.update({
        where: { id: ruleId },
        data: { exceptionWorkflowId: workflow.id },
      });
      // Anna's manager is Dirk, so the workflow resolves to Dirk and NOT to the
      // `govern.accept_risk` holders — who are also Dirk here, which is why the
      // assertion below is on the manager relationship rather than on the id.
      await tx.contract.updateMany({
        where: { personId: beneficiaryId },
        data: { managerPersonId: acceptorPersonId },
      });
      // And the permission is taken away, so a fallback to the permission
      // holders would resolve to nobody and block.
      await tx.roleAssignment.deleteMany({});
    });

    const { id, status } = await requestSodException(tenantId, acceptorUserId, request());
    expect(status).toBe('pending');
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'accepted');
    const exception = await withTenant(tenantId, (tx) =>
      tx.sodException.findUniqueOrThrow({ where: { id } }),
    );
    expect(exception).toMatchObject({ status: 'active', approvedByPersonId: acceptorPersonId });
  });

  it('refuses a decision from somebody who is not among the acceptors', async () => {
    // Re-resolved AT THE DECISION, never trusted from the request: somebody who
    // held `govern.accept_risk` when the exception was raised and does not hold
    // it now is not an acceptor.
    const { id } = await requestSodException(tenantId, acceptorUserId, request());
    await withTenant(tenantId, (tx) => tx.roleAssignment.deleteMany({}));
    await expect(
      decideSodException(tenantId, acceptorUserId, id, 'approve', 'still me'),
    ).rejects.toMatchObject({ code: 'blocked_no_approver' });
    const exception = await withTenant(tenantId, (tx) =>
      tx.sodException.findUniqueOrThrow({ where: { id } }),
    );
    expect(exception.status).toBe('pending');
  });

  it('BLOCKS when the beneficiary is the only holder of govern.accept_risk', async () => {
    // The self-approval invariant applies unchanged. Where the beneficiary is
    // themselves a holder they are dropped, and where they are the only holder
    // the exception blocks and says so.
    await withTenant(tenantId, async (tx) => {
      await tx.roleAssignment.deleteMany({});
      const annaUser = await tx.user.findFirstOrThrow({ where: { personId: beneficiaryId } });
      const role = await tx.role.findFirstOrThrow({ where: { name: 'Risk acceptor' } });
      await assignRole(tx, annaUser.id, role.id);
    });
    const { status } = await requestSodException(tenantId, acceptorUserId, request());
    expect(status).toBe('blocked_no_approver');
  });
});

describe('a refused exception revokes NOTHING', () => {
  it('leaves the violation open, records a finding and routes a remediation item', async () => {
    // Auto-revoking on a refused exception would make an exception decision an
    // unattended access removal at one remove.
    const { id } = await requestSodException(tenantId, acceptorUserId, request());
    await decideSodException(tenantId, acceptorUserId, id, 'refuse', 'the compensating control is not enough');

    const [exception, violation, finding, remediation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
      await tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
      await tx.remediationItem.findFirst({ where: { findingId: { not: null } } }),
    ]);
    expect(exception.status).toBe('refused');
    expect(violation.status).toBe('open');
    // The sentence in the title, as an assertion.
    await grantsUntouched();
    expect((finding.detail as { riskAcceptanceRefused?: boolean }).riskAcceptanceRefused).toBe(true);
    expect(remediation).not.toBeNull();
  });
});

describe('when it lapses', () => {
  it('warns at each of exceptionWarningDays and not on other days', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(14) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');

    expect((await sweepExceptions(tenantId, { now: NOW })).warned).toBe(1);
    expect((await sweepExceptions(tenantId, { now: days(5) })).warned).toBe(0);
    expect((await sweepExceptions(tenantId, { now: days(11) })).warned).toBe(1);

    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'govern-exception-expiring' } }),
    );
    expect(outbox.length).toBeGreaterThan(0);
    // Renewal is a NEW exception with a new decision, pre-filled with the old
    // justification. Never auto-renewal.
    expect((outbox[0]!.vars as { renewUrl?: string }).renewUrl).toContain('renew=');
  });

  it('reopens the violation at its ORIGINAL severity and raises the finding one step, revoking nothing', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(1) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');

    const result = await sweepExceptions(tenantId, { now: days(2) });
    expect(result.lapsed).toBe(1);

    const [exception, violation, finding] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
      await tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
    ]);
    expect(exception.status).toBe('lapsed');
    expect(violation).toMatchObject({ status: 'open', severity: 'critical' });
    // A violation somebody once formally accepted and then let quietly expire
    // is a different and worse thing than one nobody has looked at yet. It is
    // already `critical`, so raising stops there and the finding names the lapse.
    expect(finding.severity).toBe('critical');
    expect((finding.detail as { lapsedExceptionAt?: string }).lapsedExceptionAt).toBeTruthy();
    await grantsUntouched();
  });

  it('RAISES the finding one step when it has room to be raised', async () => {
    // The case above starts at `critical`, where `raiseSeverity` is capped and
    // the raise is invisible — so deleting the raise altogether passed it. The
    // property is that a violation somebody once formally accepted and then let
    // quietly expire is a different and worse thing than one nobody has looked
    // at yet, and it needs a finding with somewhere to go.
    await withTenant(tenantId, (tx) =>
      tx.governFinding.updateMany({ where: { kind: 'sod_violation' }, data: { severity: 'low' } }),
    );
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(1) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');
    await sweepExceptions(tenantId, { now: days(2) });

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
    );
    expect(finding.severity).toBe('medium');
    // And the VIOLATION keeps its own severity: the exception never changed
    // what the violation is, only whether somebody had accepted it.
    const violation = await withTenant(tenantId, (tx) =>
      tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
    );
    expect(violation.severity).toBe('critical');
    await grantsUntouched();
  });

  it('LAPSES EARLY when a basis contract ends, ahead of the end date', async () => {
    // The one place an exception ends early without a human, and it is safe
    // because ending an exception takes nothing away from anybody.
    const { id } = await requestSodException(tenantId, acceptorUserId, request({ endsAt: days(60) }));
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');
    await withTenant(tenantId, (tx) =>
      tx.contract.update({ where: { id: researchContractId }, data: { endDate: days(1) } }),
    );

    const result = await sweepExceptions(tenantId, { now: days(5) });
    expect(result).toMatchObject({ lapsed: 1, lapsedByContract: 1 });
    const exception = await withTenant(tenantId, (tx) => tx.sodException.findUniqueOrThrow({ where: { id } }));
    expect(exception.status).toBe('lapsed');
    expect(exception.revokedReason).toContain('contract');
    await grantsUntouched();
  });

  it('an early revocation by the rule owner reopens the violation immediately', async () => {
    const { id } = await requestSodException(tenantId, acceptorUserId, request());
    await decideSodException(tenantId, acceptorUserId, id, 'approve', 'ok');
    await revokeSodException(tenantId, acceptorUserId, id, 'the compensating control was withdrawn');

    const [exception, violation] = await withTenant(tenantId, async (tx) => [
      await tx.sodException.findUniqueOrThrow({ where: { id } }),
      await tx.sodViolation.findUniqueOrThrow({ where: { id: violationId } }),
    ]);
    expect(exception.status).toBe('revoked');
    expect(violation.status).toBe('open');
    await grantsUntouched();
  });
});
