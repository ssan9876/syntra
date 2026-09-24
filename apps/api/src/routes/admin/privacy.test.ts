import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  runExportJob,
  localMasterKeyProvider,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp, createFakeScheduler, type FakeScheduler } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let scheduler: FakeScheduler;

/** The MASTER_KEY `buildTestApp` configures. */
const MASTER = localMasterKeyProvider(Buffer.alloc(32, 7));
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(login: string, permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

async function cookieFor(login: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: ctx.host }, payload: { login, password: PASSWORD } });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate', headers: { host: ctx.host, cookie: `syntra_session=${token}` }, payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, auth: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: auth.startsWith('Bearer ') ? { host: ctx.host, authorization: auth } : { host: ctx.host, cookie: auth },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function seedPerson(status: 'active' | 'inactive' = 'inactive') {
  return withTenant(ctx.tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Petra', familyName: 'Privata', personalEmail: 'petra@home.example', status },
    });
    await tx.contract.create({
      data: { tenantId: ctx.tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2021-01-01'), jobTitle: 'Analyst' },
    });
    return person;
  });
}

const OPEN = {
  requestTypes: ['access', 'rectification', 'restriction', 'erasure'],
  reason: 'Letter received 2026-09-01, ref PRIV-9',
  verificationMethod: 'document',
  verificationAttestation: 'ID card checked against the HR file by the DPO',
};

beforeEach(async () => {
  scheduler = createFakeScheduler();
  ctx = await buildTestApp({ scheduler: () => scheduler });
  await ctx.app.ready();
});

describe('privacy case routes', () => {
  it('require privacy.manage', async () => {
    await seedAdmin('hr', [PERMISSIONS.IDENTITY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await cookieFor('hr');
    expect((await call('GET', '/api/admin/privacy/cases', cookie)).statusCode).toBe(403);
    const person = await seedPerson();
    expect((await call('POST', '/api/admin/privacy/cases', cookie, { ...OPEN, personId: person.id })).statusCode).toBe(403);
  });

  it('open a case, search the person, queue the access bundle and record a rectification', async () => {
    const officer = await seedAdmin('dpo', [PERMISSIONS.PRIVACY_MANAGE, PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE]);
    const cookie = await cookieFor('dpo');
    const person = await seedPerson();

    const bad = await call('POST', '/api/admin/privacy/cases', cookie, { ...OPEN, personId: person.id, verificationAttestation: 'short' });
    expect(bad.statusCode).toBe(400);

    const opened = await call('POST', '/api/admin/privacy/cases', cookie, { ...OPEN, personId: person.id });
    expect(opened.statusCode).toBe(201);
    const privacyCase = opened.json().case as { id: string; reference: string; dueAt: string };
    expect(privacyCase.reference).toMatch(/^DSAR-\d{4}-0001$/);

    const listed = await call('GET', '/api/admin/privacy/cases?status=open', cookie);
    expect(listed.json().cases).toHaveLength(1);
    expect(listed.json().cases[0].personName).toBe('Petra Privata');

    const search = await call('GET', `/api/admin/privacy/cases/${privacyCase.id}/subject-data`, cookie);
    expect(search.statusCode).toBe(200);
    const tables = (search.json().sections as { table: string }[]).map((s) => s.table);
    expect(tables).toEqual(expect.arrayContaining(['Person', 'Contract', 'PrivacyCase']));

    const bundle = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/access-bundle`, cookie, {});
    expect(bundle.statusCode).toBe(202);
    const exportId = bundle.json().export.id as string;
    expect(await runExportJob(ctx.tenantId, exportId, MASTER)).toBe('ready');
    const file = await call('GET', `/api/admin/exports/${exportId}/download`, cookie);
    expect(file.statusCode).toBe(200);
    expect(file.headers['x-syntra-export-sha256']).toMatch(/^[a-f0-9]{64}$/);
    const document = file.json();
    expect(document.watermark).toMatchObject({ case_reference: privacyCase.reference, exported_by_user_id: officer.id });

    // Rectification is the ordinary edit, with the case named.
    const edited = await call('PATCH', `/api/admin/persons/${person.id}`, cookie, { familyName: 'Privata-Correct', privacyCaseId: privacyCase.id });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().familyName).toBe('Privata-Correct');
    const contract = await call('PATCH', `/api/admin/persons/${person.id}/contracts/1`, cookie, { jobTitle: 'Senior Analyst', privacyCaseId: privacyCase.id });
    expect(contract.statusCode).toBe(200);
    const nothing = await call('PATCH', `/api/admin/persons/${person.id}`, cookie, { privacyCaseId: privacyCase.id });
    expect(nothing.statusCode).toBe(400);

    const other = await seedPerson();
    const wrong = await call('PATCH', `/api/admin/persons/${other.id}`, cookie, { familyName: 'X', privacyCaseId: privacyCase.id });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().type).toContain('privacy-wrong-person');

    const detail = await call('GET', `/api/admin/privacy/cases/${privacyCase.id}`, cookie);
    expect(detail.statusCode).toBe(200);
    const actions = (detail.json().timeline as { action: string; payload: Record<string, unknown> }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      'privacy.case.open', 'privacy.case.search', 'privacy.case.access_export', 'export.request', 'export.ready', 'export.download',
      'privacy.case.rectify',
    ]));
    const rectified = (detail.json().timeline as { action: string; payload: Record<string, unknown> }[])
      .filter((e) => e.action === 'privacy.case.rectify')
      .map((e) => e.payload);
    expect(rectified).toEqual([
      expect.objectContaining({ record: 'person', fields: ['familyName'] }),
      expect.objectContaining({ record: 'contract', fields: ['jobTitle'] }),
    ]);
  });

  it('refuses a rectification citing a case from an editor without privacy.manage', async () => {
    await seedAdmin('dpo', [PERMISSIONS.PRIVACY_MANAGE]);
    await seedAdmin('editor', [PERMISSIONS.DIRECTORY_WRITE]);
    const person = await seedPerson();
    const opened = await call('POST', '/api/admin/privacy/cases', await cookieFor('dpo'), { ...OPEN, personId: person.id });
    const res = await call('PATCH', `/api/admin/persons/${person.id}`, await cookieFor('editor'), {
      familyName: 'X', privacyCaseId: opened.json().case.id,
    });
    expect(res.statusCode).toBe(403);
  });

  it('restricts, then erases with four eyes, refusing blockers and machine tokens', async () => {
    const officer = await seedAdmin('dpo', [PERMISSIONS.PRIVACY_MANAGE]);
    await seedAdmin('dpo2', [PERMISSIONS.PRIVACY_MANAGE]);
    const requester = await cookieFor('dpo');
    const approver = await cookieFor('dpo2');
    const person = await seedPerson('active');
    const privacyCase = (await call('POST', '/api/admin/privacy/cases', requester, { ...OPEN, personId: person.id })).json().case as { id: string };

    const restricted = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/restriction`, requester);
    expect(restricted.statusCode).toBe(200);
    expect((await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/restriction`, requester)).json().type)
      .toContain('privacy-already-restricted');

    const blocked = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/erasure/request`, requester);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().blockers.map((b: { code: string }) => b.code)).toEqual(['person-active']);

    await withTenant(ctx.tenantId, (tx) => tx.person.update({ where: { id: person.id }, data: { status: 'inactive' } }));
    expect((await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/erasure/request`, requester)).statusCode).toBe(200);

    // A token, even one holding privacy.manage, is refused on the erasure routes.
    const token = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, { userId: officer.id, name: 'automation', scopes: [PERMISSIONS.PRIVACY_MANAGE], expiresAt: null, createdBy: officer.id }),
    );
    const viaToken = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/erasure/approve`, `Bearer ${token.token}`);
    expect([401, 403]).toContain(viaToken.statusCode);

    const self = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/erasure/approve`, requester);
    expect(self.statusCode).toBe(403);
    expect(self.json().type).toContain('privacy-four-eyes-required');

    const approved = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/erasure/approve`, approver);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().receipt).toMatchObject({ schema: 'syntra.erasure-receipt.v1', pseudonymized: { Person: 1, Contract: 1 } });

    const erased = await withTenant(ctx.tenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: person.id } }));
    expect(erased).toMatchObject({ givenName: 'Erased', personalEmail: null });

    const closed = await call('POST', `/api/admin/privacy/cases/${privacyCase.id}/close`, requester, { note: 'Confirmed to the subject' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().case.status).toBe('closed');
  });
});
