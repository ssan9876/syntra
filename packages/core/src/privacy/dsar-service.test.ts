import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import { createUser } from '../directory/user-service.js';
import { downloadExport, runExportJob } from '../exports/export-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { placeLifecycleLegalHold, releaseLifecycleLegalHold } from '../lifecycle/legal-hold.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  PrivacyCaseRefusedError,
  approvePersonErasure,
  cancelPersonErasure,
  closePrivacyCase,
  getPrivacyCase,
  liftPersonRestriction,
  listPrivacyCases,
  openPrivacyCase,
  requestPersonErasure,
  requestPrivacyAccessBundle,
  restrictPersonProcessing,
  searchPrivacyCaseSubject,
} from './dsar-service.js';

const provider = localMasterKeyProvider(randomBytes(32));

const GIVEN = 'Zelda';
const FAMILY = 'Quixote';
const BUSINESS = 'zelda.quixote@acme.test';
const PERSONAL = 'zq.home@example.org';
const LOGIN = 'zquixote';
const IP = '203.0.113.77';
const AGENT = 'Mozilla/5.0 ZeldaPhone';
const NEEDLES = [GIVEN, FAMILY, BUSINESS, PERSONAL, LOGIN, IP, AGENT, 'Chief Quibbler', 'Quibble Dept'];

let tenantId: string;
let otherTenantId: string;
let officer: string;
let secondOfficer: string;

function fakeScheduler(): Scheduler & { enqueued: { name: string; data: unknown }[] } {
  const enqueued: { name: string; data: unknown }[] = [];
  return {
    enqueued,
    start: async () => {},
    stop: async () => {},
    register: () => {},
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return `job-${enqueued.length}`;
    },
    schedule: async () => {},
    unschedule: async () => {},
    missingSchedules: async () => [],
  };
}

interface Subject {
  personId: string;
  userId: string;
  accountId: string;
  operationId: string;
}

/**
 * One person with data in as many tables as the erasure touches: HR record,
 * account, credentials, sessions, target account, run history, requests,
 * notifications, lifecycle work -- and an audit event naming them, which the
 * erasure must leave alone.
 */
async function seedSubject(tenant: string, options: { active?: boolean } = {}): Promise<Subject> {
  return withTenant(tenant, async (tx) => {
    const person = await tx.person.create({
      data: {
        tenantId: tenant, givenName: GIVEN, familyName: FAMILY, businessEmail: BUSINESS, personalEmail: PERSONAL,
        externalId: 'E-1001', status: options.active ? 'active' : 'inactive', departureOverrideNote: `${GIVEN} left`,
      },
    });
    await tx.contract.create({
      data: {
        tenantId: tenant, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01'),
        endDate: new Date('2026-01-31'), jobTitle: 'Chief Quibbler', department: 'Quibble Dept', externalId: 'C-1',
      },
    });
    const user = await createUser(tx, { login: LOGIN, email: BUSINESS, displayName: `${GIVEN} ${FAMILY}` });
    await tx.user.update({ where: { id: user.id }, data: { personId: person.id, status: options.active ? 'active' : 'inactive' } });
    await tx.userAttribute.create({ data: { tenantId: tenant, userId: user.id, key: 'nickname', type: 'string', value: `${GIVEN}Q` } });
    const group = await tx.group.create({ data: { tenantId: tenant, name: 'Staff' } });
    await tx.groupMembership.create({ data: { tenantId: tenant, groupId: group.id, userId: user.id } });
    await tx.passwordCredential.create({ data: { tenantId: tenant, userId: user.id, hash: '$argon2id$fake' } });
    await tx.recoveryCode.create({ data: { tenantId: tenant, userId: user.id, codeHash: 'fake-code-hash' } });
    await tx.webAuthnCredential.create({
      data: { tenantId: tenant, userId: user.id, credentialId: `cred-${randomUUID()}`, publicKey: new Uint8Array([1, 2, 3]), rpId: 'acme.test', label: `${GIVEN}'s key` },
    });
    await tx.session.create({
      data: {
        tenantId: tenant, userId: user.id, tokenHash: `session-${randomUUID()}`, scope: 'portal', ip: IP, userAgent: AGENT,
        absoluteExpiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date(),
      },
    });
    const target = await tx.targetSystem.create({ data: { tenantId: tenant, name: 'AD', config: { tlsMode: 'ldaps' }, secretName: `target.${randomUUID()}` } });
    const account = await tx.targetAccount.create({
      data: {
        tenantId: tenant, targetSystemId: target.id, personId: person.id, anchor: 'guid-zq', correlationKey: LOGIN,
        status: 'archived', lastAppliedAttributes: { displayName: [`${GIVEN} ${FAMILY}`], mail: [BUSINESS] },
      },
    });
    const run = await tx.provisionRun.create({ data: { tenantId: tenant, targetSystemId: target.id, status: 'applied' } });
    await tx.provisionAction.create({
      data: {
        tenantId: tenant, runId: run.id, actionType: 'update_account', personId: person.id, accountId: account.id, status: 'applied',
        before: { displayName: [`${GIVEN} ${FAMILY}`] }, after: { displayName: [`${GIVEN} Q. ${FAMILY}`] }, message: `renamed ${LOGIN}`,
      },
    });
    await tx.accessRequest.create({
      data: {
        tenantId: tenant, subjectPersonId: person.id, requestedByUserId: user.id, status: 'fulfilled',
        justification: `${GIVEN} needs the quibble share`, formValues: { phone: '555-0100', name: FAMILY },
      },
    });
    await tx.notificationOutbox.create({
      data: { tenantId: tenant, template: 'welcome', to: PERSONAL, vars: { name: GIVEN }, userId: user.id },
    });
    const operation = await tx.lifecycleOperation.create({
      data: {
        tenantId: tenant, personId: person.id, kind: 'offboard', idempotencyKey: `op-${randomUUID()}`, inputFingerprint: 'fp',
        status: 'completed', input: { person: { givenName: GIVEN, familyName: FAMILY } },
      },
    });
    await tx.lifecycleStep.create({
      data: { tenantId: tenant, operationId: operation.id, key: 'target', title: 'Disable', position: 1, status: 'completed', evidence: { account: LOGIN } },
    });
    const source = await tx.directorySource.create({ data: { tenantId: tenant, name: 'LDAP', config: {}, secretName: `dir.${randomUUID()}` } });
    const syncRun = await tx.syncRun.create({ data: { tenantId: tenant, sourceId: source.id, status: 'applied' } });
    await tx.syncChange.create({
      data: {
        tenantId: tenant, runId: syncRun.id, changeType: 'update_user', targetType: 'User', targetId: user.id, status: 'applied',
        before: { displayName: GIVEN }, after: { displayName: `${GIVEN} ${FAMILY}` },
      },
    });
    // The audit record, which the erasure keeps.
    await recordEvent(tx, {
      actorUserId: user.id, action: 'auth.login', targetType: 'User', targetId: user.id, outcome: 'success', sourceIp: IP,
      payload: { login: LOGIN, name: `${GIVEN} ${FAMILY}` },
    });
    return { personId: person.id, userId: user.id, accountId: account.id, operationId: operation.id };
  });
}

async function seedOfficers(tenant: string) {
  return withTenant(tenant, async (tx) => {
    const role = await createRole(tx, 'Privacy officer', [PERMISSIONS.PRIVACY_MANAGE]);
    const a = await createUser(tx, { login: 'dpo', email: 'dpo@acme.test', displayName: 'DPO One' });
    const b = await createUser(tx, { login: 'dpo2', email: 'dpo2@acme.test', displayName: 'DPO Two' });
    await assignRole(tx, a.id, role.id);
    await assignRole(tx, b.id, role.id);
    return [a.id, b.id] as const;
  });
}

const open = (personId: string, requestTypes: ('access' | 'rectification' | 'restriction' | 'erasure')[] = ['access', 'erasure'], tenant = tenantId, actor = officer) =>
  openPrivacyCase(tenant, {
    actorUserId: actor,
    personId,
    requestTypes,
    reason: 'Received by post, reference letter 2026-07',
    verificationMethod: 'document',
    verificationAttestation: 'Passport sighted by DPO, number matched HR file',
  });

async function refusal(promise: Promise<unknown>): Promise<PrivacyCaseRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PrivacyCaseRefusedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Every row of every tenant table, as JSON, except the audit log. */
async function tenantRowsText(tenant: string): Promise<Map<string, string>> {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenantId' ORDER BY table_name`;
  const out = new Map<string, string>();
  await withTenant(tenant, async (tx) => {
    for (const { table_name } of tables) {
      if (table_name === 'AuditEvent') continue;
      const rows = await tx.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM "${table_name}" t`);
      out.set(table_name, rows.map((r) => r.j).join('\n'));
    }
  });
  return out;
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  [officer, secondOfficer] = await seedOfficers(tenantId);
});

describe('privacy cases', () => {
  it('opens a case with a due date, a verification record and a timeline', async () => {
    const subject = await seedSubject(tenantId);
    const received = new Date('2026-09-01T10:00:00Z');
    const first = await openPrivacyCase(tenantId, {
      actorUserId: officer, personId: subject.personId, requestTypes: ['access'], reason: 'Email from the subject to privacy@',
      verificationMethod: 'known_channel', verificationAttestation: 'Replied from the address on file', receivedAt: received,
    }, new Date('2026-09-02T00:00:00Z'));
    expect(first.reference).toBe('DSAR-2026-0001');
    expect(first.dueAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    const second = await open(subject.personId);
    expect(second.reference).toMatch(/^DSAR-\d{4}-000[12]$/);

    const detail = await getPrivacyCase(tenantId, first.id, new Date('2026-10-02T00:00:00Z'));
    expect(detail.overdue).toBe(true);
    expect(detail.timeline.map((e) => e.action)).toEqual(['privacy.case.open']);
    expect(detail.holdings.Person).toBe(1);
    expect(detail.holdings.AuditEvent).toBeGreaterThan(0);

    const listed = await withTenant(tenantId, (tx) => listPrivacyCases(tx, { status: 'open' }));
    expect(listed).toHaveLength(2);
    expect(listed[0]!.personName).toBe(`${GIVEN} ${FAMILY}`);
  });

  it('refuses a case without a verification attestation, or due beyond three months', async () => {
    const subject = await seedSubject(tenantId);
    const short = await refusal(openPrivacyCase(tenantId, {
      actorUserId: officer, personId: subject.personId, requestTypes: ['access'], reason: 'Reason long enough',
      verificationMethod: 'other', verificationAttestation: 'ok',
    }));
    expect(short.code).toBe('invalid');
    const late = await refusal(openPrivacyCase(tenantId, {
      actorUserId: officer, personId: subject.personId, requestTypes: ['access'], reason: 'Reason long enough',
      verificationMethod: 'other', verificationAttestation: 'Attested at length', dueInDays: 120,
    }));
    expect(late.code).toBe('invalid');
  });

  it('finds everything linked to the person through the inventory, and audits the search', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId);
    const result = await searchPrivacyCaseSubject(tenantId, privacyCase.id, officer);
    const tables = Object.fromEntries(result.sections.map((s) => [s.table, s]));
    for (const table of ['Person', 'Contract', 'User', 'UserAttribute', 'GroupMembership', 'Session', 'PasswordCredential',
      'TargetAccount', 'ProvisionAction', 'AccessRequest', 'NotificationOutbox', 'LifecycleOperation', 'LifecycleStep',
      'SyncChange', 'AuditEvent', 'PrivacyCase']) {
      expect(tables[table], table).toBeDefined();
    }
    // Credential material is never in a result, even though the row is found.
    expect(tables.PasswordCredential!.rows[0]).not.toHaveProperty('hash');
    expect(tables.Session!.rows[0]).not.toHaveProperty('tokenHash');
    expect(tables.Session!.rows[0]).toMatchObject({ ip: IP });
    const detail = await getPrivacyCase(tenantId, privacyCase.id);
    expect(detail.timeline.map((e) => e.action)).toContain('privacy.case.search');
  });

  it('restricts processing, refuses to restrict twice, and lifts it', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId, ['restriction']);
    await restrictPersonProcessing(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null });
    const person = await withTenant(tenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: subject.personId } }));
    expect(person.processingRestrictedCaseId).toBe(privacyCase.id);
    expect((await refusal(restrictPersonProcessing(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }))).code)
      .toBe('already-restricted');
    await liftPersonRestriction(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null });
    const lifted = await withTenant(tenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: subject.personId } }));
    expect(lifted.processingRestrictedAt).toBeNull();
    const actions = (await getPrivacyCase(tenantId, privacyCase.id)).timeline.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual([
      'privacy.case.open:success', 'privacy.case.restrict:success', 'privacy.case.restrict:failure', 'privacy.case.lift_restriction:success',
    ]);
  });
});

describe('erasure refusals', () => {
  it('is refused while a legal hold covers the person, and audited', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId);
    const hold = await placeLifecycleLegalHold(tenantId, {
      subjectType: 'person', subjectId: subject.personId, reference: 'LIT-42', reason: 'Employment tribunal', actorUserId: officer,
    });
    const refused = await refusal(requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }));
    expect(refused.code).toBe('erasure-blocked');
    expect(refused.blockers.map((b) => b.code)).toEqual(['legal-hold-active']);
    expect(refused.message).toContain('LIT-42');

    // A hold on one of the person's lifecycle operations blocks it as well.
    await releaseLifecycleLegalHold(tenantId, hold.id, officer);
    await placeLifecycleLegalHold(tenantId, {
      subjectType: 'lifecycle_operation', subjectId: subject.operationId, reference: 'AUD-7', reason: 'Audit sample', actorUserId: officer,
    });
    expect((await refusal(requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }))).blockers[0]!.code)
      .toBe('legal-hold-active');

    const detail = await getPrivacyCase(tenantId, privacyCase.id);
    expect(detail.timeline.filter((e) => e.action === 'privacy.erasure.request').map((e) => e.outcome)).toEqual(['failure', 'failure']);
    expect(detail.erasureBlockers.map((b) => b.code)).toEqual(['legal-hold-active']);
  });

  it('is refused while lifecycle work is unresolved, the person is active, or accounts are live', async () => {
    const subject = await seedSubject(tenantId, { active: true });
    await withTenant(tenantId, async (tx) => {
      await tx.lifecycleOperation.create({
        data: { tenantId, personId: subject.personId, kind: 'offboard', idempotencyKey: 'open-op', inputFingerprint: 'fp', status: 'queued' },
      });
      await tx.targetAccount.update({ where: { id: subject.accountId }, data: { status: 'active' } });
    });
    const privacyCase = await open(subject.personId);
    const refused = await refusal(requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }));
    expect(refused.blockers.map((b) => b.code)).toEqual(['lifecycle-work-unresolved', 'person-active', 'accounts-active']);
  });

  it('is refused when the subject did not ask for erasure', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId, ['access']);
    expect((await refusal(requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }))).code).toBe('not-requested');
  });

  it('needs a different administrator, from a fresh session, and re-checks blockers at approval', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId);
    await requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null });

    const self = await refusal(approvePersonErasure(tenantId, privacyCase.id, { actorUserId: officer, stepUpAt: new Date(), sourceIp: null }));
    expect(self.code).toBe('four-eyes-required');
    const stale = await refusal(approvePersonErasure(tenantId, privacyCase.id, {
      actorUserId: secondOfficer, stepUpAt: new Date(Date.now() - 60 * 60 * 1000), sourceIp: null,
    }));
    expect(stale.code).toBe('step-up-required');

    // A hold placed between request and approval refuses the approval.
    const hold = await placeLifecycleLegalHold(tenantId, {
      subjectType: 'person', subjectId: subject.personId, reference: 'LATE-1', reason: 'Late hold', actorUserId: secondOfficer,
    });
    expect((await refusal(approvePersonErasure(tenantId, privacyCase.id, { actorUserId: secondOfficer, stepUpAt: new Date(), sourceIp: null }))).code)
      .toBe('erasure-blocked');
    await releaseLifecycleLegalHold(tenantId, hold.id, secondOfficer);

    // The database refuses the requester as approver whatever the code does.
    await expect(withTenant(tenantId, (tx) => tx.privacyCase.update({
      where: { id: privacyCase.id },
      data: {
        erasureStatus: 'completed', erasureApprovedByUserId: officer, erasureApprovedAt: new Date(),
        erasureApproverStepUpAt: new Date(), erasureCompletedAt: new Date(), erasureReceipt: {},
      },
    }))).rejects.toThrow(/PrivacyCase_erasure_four_eyes/);

    // Nothing was erased by any of that.
    const person = await withTenant(tenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: subject.personId } }));
    expect(person.givenName).toBe(GIVEN);

    await cancelPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null });
    expect((await refusal(approvePersonErasure(tenantId, privacyCase.id, { actorUserId: secondOfficer, stepUpAt: new Date(), sourceIp: null }))).code)
      .toBe('not-pending');
  });
});

describe('erasure', () => {
  it('pseudonymises, deletes and retains exactly as the inventory says, across every table, and only in its tenant', async () => {
    const subject = await seedSubject(tenantId);
    const twin = await seedSubject(otherTenantId);
    const privacyCase = await open(subject.personId);

    const before = await tenantRowsText(tenantId);
    const found = [...before].filter(([, text]) => NEEDLES.some((n) => text.includes(n))).map(([t]) => t);
    // The fixture really does spread the person across the tables.
    expect(found.length).toBeGreaterThanOrEqual(12);

    await requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: '198.51.100.1' });
    const { receipt, case: done } = await approvePersonErasure(tenantId, privacyCase.id, {
      actorUserId: secondOfficer, stepUpAt: new Date(), sourceIp: '198.51.100.2',
    });
    expect(done.erasureStatus).toBe('completed');
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.pseudonymized).toMatchObject({ Person: 1, Contract: 1, User: 1, Session: 1, TargetAccount: 1, AccessRequest: 1 });
    expect(receipt.deleted).toMatchObject({ PasswordCredential: 1, RecoveryCode: 1, WebAuthnCredential: 1 });
    expect(receipt.retained.AuditEvent).toBeGreaterThan(0);
    expect(receipt.retained.GroupMembership).toBe(1);

    // No identifying value survives anywhere in the tenant but the audit log.
    const after = await tenantRowsText(tenantId);
    const leaks = [...after].flatMap(([table, text]) => NEEDLES.filter((n) => text.includes(n)).map((n) => `${table}: ${n}`));
    expect(leaks).toEqual([]);

    // The audit log is retained unchanged, and still names them.
    const audit = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow({ where: { action: 'auth.login' } }));
    expect(audit.payload).toMatchObject({ login: LOGIN });

    // Deactivate, never delete: the rows are still there, pseudonymised.
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.findUniqueOrThrow({ where: { id: subject.personId } });
      expect(person).toMatchObject({ givenName: 'Erased', familyName: 'Person', businessEmail: null, personalEmail: null, externalId: 'E-1001' });
      expect(person.erasedCaseId).toBe(privacyCase.id);
      expect(person.processingRestrictedCaseId).toBe(privacyCase.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: subject.userId } });
      expect(user.login).toBe(`erased-${user.id}`);
      expect(user.email).toBe(`erased-${user.id}@erased.invalid`);
      const contract = await tx.contract.findFirstOrThrow({ where: { personId: subject.personId } });
      expect(contract).toMatchObject({ jobTitle: null, department: null, externalId: 'C-1' });
      expect(contract.endDate?.toISOString().slice(0, 10)).toBe('2026-01-31');
      expect(await tx.groupMembership.count({ where: { userId: subject.userId } })).toBe(1);
      const outbox = await tx.notificationOutbox.findFirstOrThrow({ where: { userId: subject.userId } });
      expect(outbox.attempts).toBeGreaterThanOrEqual(5);
    });

    // The other tenant's identical person is untouched.
    const twinRows = await tenantRowsText(otherTenantId);
    expect([...twinRows.values()].join('\n')).toContain(PERSONAL);
    const twinPerson = await withTenant(otherTenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: twin.personId } }));
    expect(twinPerson.givenName).toBe(GIVEN);

    // Erased stays restricted, and cannot be erased twice.
    const lift = await refusal(liftPersonRestriction(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }));
    expect(lift.code).toBe('erased-permanently-restricted');
    const again = await open(subject.personId, ['erasure']);
    expect((await refusal(requestPersonErasure(tenantId, again.id, { actorUserId: officer, sourceIp: null }))).blockers[0]!.code)
      .toBe('already-erased');

    const detail = await getPrivacyCase(tenantId, privacyCase.id);
    expect(detail.timeline.map((e) => `${e.action}:${e.outcome}`)).toEqual([
      'privacy.case.open:success', 'privacy.erasure.request:success', 'privacy.erasure.completed:success',
      'privacy.case.lift_restriction:failure',
    ]);
    expect((detail.case.erasureReceipt as { digest: string }).digest).toBe(receipt.digest);

    await closePrivacyCase(tenantId, privacyCase.id, { actorUserId: officer, note: 'Erasure completed and confirmed to the subject', sourceIp: null });
  });

  it('is invisible across tenants', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId);
    expect((await refusal(getPrivacyCase(otherTenantId, privacyCase.id))).code).toBe('not-found');
    expect((await refusal(requestPersonErasure(otherTenantId, privacyCase.id, { actorUserId: officer, sourceIp: null }))).code).toBe('not-found');
    // And a person from another tenant cannot be the subject of a case here.
    const twin = await seedSubject(otherTenantId);
    expect((await refusal(open(twin.personId))).code).toBe('person-not-found');
  });
});

describe('the access bundle', () => {
  it('is a sealed, watermarked JSON export of the person, without credential material, erased by an erasure', async () => {
    const subject = await seedSubject(tenantId);
    const privacyCase = await open(subject.personId);
    const scheduler = fakeScheduler();
    const queued = await requestPrivacyAccessBundle(scheduler, tenantId, privacyCase.id, {
      actorUserId: officer, viaToken: false, sourceIp: null,
    });
    expect(queued.kind).toBe('dsar_bundle');
    expect(scheduler.enqueued).toHaveLength(1);
    expect(await runExportJob(tenantId, queued.id, provider)).toBe('ready');

    const file = await downloadExport(tenantId, { exportId: queued.id, userId: officer, provider, sourceIp: null });
    expect(file.contentType).toContain('application/json');
    const bundle = JSON.parse(file.body.toString('utf8'));
    expect(bundle.watermark).toMatchObject({ export_id: queued.id, tenant_id: tenantId, exported_by_user_id: officer, case_reference: privacyCase.reference });
    const sections = Object.fromEntries((bundle.sections as { table: string; rows: Record<string, unknown>[]; purpose: string }[]).map((s) => [s.table, s]));
    expect(sections.Person!.rows[0]).toMatchObject({ givenName: GIVEN, personalEmail: PERSONAL });
    expect(sections.Person!.purpose).toBeTruthy();
    expect(sections.PasswordCredential!.rows[0]).not.toHaveProperty('hash');
    expect(file.body.toString('utf8')).not.toContain('$argon2id$fake');
    expect(bundle.exclusions.columns).toContain('PasswordCredential.hash');
    expect(bundle.end.row_count).toBeGreaterThan(10);

    // Somebody without privacy.manage cannot take one.
    const outsider = await withTenant(tenantId, (tx) => createUser(tx, { login: 'nosy', email: 'nosy@acme.test', displayName: 'Nosy' }));
    await expect(requestPrivacyAccessBundle(fakeScheduler(), tenantId, privacyCase.id, {
      actorUserId: outsider.id, viaToken: false, sourceIp: null,
    })).rejects.toThrow(/privacy\.manage/);

    // An erasure erases the file of any bundle about the person.
    await requestPersonErasure(tenantId, privacyCase.id, { actorUserId: officer, sourceIp: null });
    const { receipt } = await approvePersonErasure(tenantId, privacyCase.id, { actorUserId: secondOfficer, stepUpAt: new Date(), sourceIp: null });
    expect(receipt.bundlesErased).toBe(1);
    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: queued.id } }));
    expect(row.status).toBe('revoked');
    expect(row.ciphertext).toBeNull();
  });
});
