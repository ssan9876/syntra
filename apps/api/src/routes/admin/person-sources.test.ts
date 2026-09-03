import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@syntra/db';
import { FakePersonSource } from '@syntra/connectors/testing';
import {
  PERMISSIONS,
  PERSON_IMPORT_JOB,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  previewImportRun,
  localMasterKeyProvider,
  setPasswordHash,
  setPersonMappings,
  type Permission,
} from '@syntra/core';
import { buildTestApp, createFakeScheduler, type FakeScheduler } from '../../test-support.js';

const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let scheduler: FakeScheduler;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const testProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

const config = {
  host: 'hr.example.test',
  username: 'syntra',
  remotePath: '/export/people.csv',
};

async function adminCookie(permissions: Permission[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'a@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'R', permissions);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });
const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });
const put = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PUT',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });
const del = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

const correlation = {
  recordType: 'person' as const,
  sourceColumn: 'employeeId',
  targetField: 'externalId',
  transform: 'trim' as const,
  isCorrelation: true,
};
const startDateRule = {
  recordType: 'contract' as const,
  sourceColumn: 'hireDate',
  targetField: 'startDate',
  transform: 'none' as const,
  isCorrelation: false,
};

function row(employeeId: string) {
  return {
    externalId: `row-${employeeId}`,
    fields: { employeeId, hireDate: '2026-01-05' },
    contracts: [],
  };
}

beforeEach(async () => {
  scheduler = createFakeScheduler();
  ctx = await buildTestApp({ scheduler: () => scheduler });
  connectorFor.mockReset();
});

async function createSource(cookie: string, over: Record<string, unknown> = {}) {
  const response = await post('/api/admin/person-sources', cookie, {
    name: 'HR nightly',
    type: 'sftpDelimited',
    feedMode: 'snapshot',
    config,
    credential: 'hunter2',
    ...over,
  });
  return response;
}

describe('POST /person-sources', () => {
  it('creates a source and never echoes the credential', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const response = await createSource(cookie);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('hunter2');
    expect(response.json().feedMode).toBe('snapshot');
  });

  /**
   * There is no default anywhere in the stack, and this is the outermost
   * place one could appear.
   */
  it('refuses a create that names no feed mode', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const response = await post('/api/admin/person-sources', cookie, {
      name: 'HR',
      type: 'sftpDelimited',
      config,
      credential: 'x',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a source type no connector implements', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const response = await createSource(cookie, { type: 'workday' });
    expect(response.statusCode).toBe(400);
    expect(response.json().type).toMatch(/unknown-source-type/);
  });

  it('refuses a caller without sync.manage', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    expect((await createSource(cookie)).statusCode).toBe(403);
  });
});

describe('PUT /person-sources/:id/mappings', () => {
  it('refuses a mapping onto a field a source may not write', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();

    const response = await put(`/api/admin/person-sources/${source.id}/mappings`, cookie, {
      mappings: [
        correlation,
        {
          recordType: 'person',
          sourceColumn: 'active',
          targetField: 'status',
          transform: 'none',
          isCorrelation: false,
        },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().type).toMatch(/unassignable-field/);
    expect(response.json().errors[0].path).toBe('status');
  });

  it('stores a valid set and reads it back', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();

    const saved = await put(`/api/admin/person-sources/${source.id}/mappings`, cookie, {
      mappings: [correlation, startDateRule],
    });
    expect(saved.statusCode).toBe(200);

    const read = await get(`/api/admin/person-sources/${source.id}/mappings`, cookie);
    expect(read.json().rules).toHaveLength(2);
  });

  /**
   * Served rather than duplicated in the browser bundle: a target field the
   * console offered but the service rejects is a 400 nobody can act on.
   */
  it('publishes the fields a mapping may write', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const response = await get('/api/admin/person-sources/mapping-defaults', cookie);
    expect(response.json().assignableFields.person).not.toContain('status');
    expect(response.json().assignableFields.contract).toContain('externalId');
  });
});

describe('POST /person-sources/:id/test and the host key', () => {
  it('reports an unknown host key with a fingerprint to accept', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    connectorFor.mockReturnValue({
      test: async () => ({
        ok: false,
        message: 'not pinned yet',
        columns: ['employeeId'],
        hostKey: { fingerprint: 'SHA256:abc', status: 'unknown' },
      }),
      read: async function* () {},
    });

    const response = await post(`/api/admin/person-sources/${source.id}/test`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().hostKey).toEqual({
      fingerprint: 'SHA256:abc',
      status: 'unknown',
    });
    expect(response.json().columns).toEqual(['employeeId']);
  });

  it('pins the fingerprint the test showed', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();

    const accepted = await post(
      `/api/admin/person-sources/${source.id}/host-key`,
      cookie,
      { fingerprint: 'SHA256:abc' },
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().config.hostKeyFingerprint).toBe('SHA256:abc');
  });

  /**
   * A changed key is a rebuilt server or an interception. Re-pinning it is an
   * edit of the source, not a confirmation dialog.
   */
  it('refuses to re-pin a different key', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await post(`/api/admin/person-sources/${source.id}/host-key`, cookie, {
      fingerprint: 'SHA256:abc',
    });

    const again = await post(`/api/admin/person-sources/${source.id}/host-key`, cookie, {
      fingerprint: 'SHA256:zzz',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toMatch(/host-key-mismatch/);
  });

  it('records accepting a key in the audit log', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await post(`/api/admin/person-sources/${source.id}/host-key`, cookie, {
      fingerprint: 'SHA256:abc',
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'person_source.host_key_accepted' } }),
    );
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { fingerprint: string }).fingerprint).toBe('SHA256:abc');
  });
});

describe('POST /person-sources/:id/run', () => {
  it('queues a run and answers 202 with the row it will fill in', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();

    const response = await post(`/api/admin/person-sources/${source.id}/run`, cookie);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('queued');
    expect(scheduler.enqueued.some((job) => job.name === PERSON_IMPORT_JOB)).toBe(true);
  });

  it('refuses a run on a disabled source', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie, { enabled: false })).json();

    const response = await post(`/api/admin/person-sources/${source.id}/run`, cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toMatch(/source-disabled/);
  });
});

describe('applying a run', () => {
  it('refuses a blocked run without confirmation, and accepts it with one', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await put(`/api/admin/person-sources/${source.id}/mappings`, cookie, {
      mappings: [correlation, startDateRule],
    });

    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(ctx.tenantId, testProvider, source.id);
    await post(`/api/admin/person-import-runs/${first.id}/apply`, cookie);

    // Both gone at once: over the threshold, so blocked pending confirmation.
    connectorFor.mockReturnValue(new FakePersonSource([row('3')]));
    const second = await previewImportRun(ctx.tenantId, testProvider, source.id);
    expect(second.status).toBe('blocked');

    const refused = await post(`/api/admin/person-import-runs/${second.id}/apply`, cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().type).toMatch(/run-blocked/);

    const confirmed = await post(
      `/api/admin/person-import-runs/${second.id}/apply`,
      cookie,
      { confirm: true },
    );
    expect(confirmed.statusCode).toBe(200);
  });

  /**
   * The denominator the guard measured travels with the run, so the
   * confirming administrator reads the same number the refusal came from.
   */
  it('serves a run with its changes and the guard denominator', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await put(`/api/admin/person-sources/${source.id}/mappings`, cookie, {
      mappings: [correlation, startDateRule],
    });
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(ctx.tenantId, testProvider, source.id);

    const response = await get(`/api/admin/person-import-runs/${run.id}`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().changes.length).toBeGreaterThan(0);
    expect(response.json().denominators).toHaveProperty('activePersonsFromSource');
  });
});

describe('skipping a change', () => {
  /**
   * A skip is "not now", not "never": the change is marked skipped so this
   * apply passes it over, and the next run proposes it again because the file
   * is still saying it.
   */
  it('marks the change skipped and leaves it out of the apply', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await put(`/api/admin/person-sources/${source.id}/mappings`, cookie, {
      mappings: [correlation, startDateRule],
    });
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const run = await previewImportRun(ctx.tenantId, testProvider, source.id);

    const creates = await withTenant(ctx.tenantId, (tx) =>
      tx.personImportChange.findMany({
        where: { runId: run.id, changeType: 'create_person' },
        orderBy: { externalId: 'asc' },
      }),
    );

    const skipped = await post(
      `/api/admin/person-import-runs/${run.id}/changes/${creates[0]!.id}/skip`,
      cookie,
    );
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().status).toBe('skipped');

    await post(`/api/admin/person-import-runs/${run.id}/apply`, cookie);
    const persons = await withTenant(ctx.tenantId, (tx) => tx.person.findMany());
    expect(persons.map((p) => p.externalId)).toEqual(['2']);
  });

  it('refuses a caller without sync.manage', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const response = await post(
      `/api/admin/person-import-runs/${'00000000-0000-0000-0000-000000000000'}/changes/${'00000000-0000-0000-0000-000000000001'}/skip`,
      cookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('DELETE /person-sources/:id', () => {
  it('refuses while it owns people, naming how many', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const source = (await createSource(cookie)).json();
    await withTenant(ctx.tenantId, (tx) =>
      tx.person.create({
        data: {
          tenantId: ctx.tenantId,
          givenName: 'Ada',
          familyName: 'Lovelace',
          externalId: '1',
          sourceId: source.id,
        },
      }),
    );

    const refused = await del(`/api/admin/person-sources/${source.id}`, cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().persons).toBe(1);

    const confirmed = await del(
      `/api/admin/person-sources/${source.id}?confirm=true`,
      cookie,
    );
    expect(confirmed.statusCode).toBe(200);
  });
});

describe('naming something that is not there', () => {
  const MISSING = '00000000-0000-0000-0000-000000000000';

  /**
   * A caller's mistake, not this server's. Left to the service's own throw
   * these answered 500, which sends an operator to the logs for a request
   * that was simply wrong.
   */
  it('answers 404 for applying a run that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const response = await post(`/api/admin/person-import-runs/${MISSING}/apply`, cookie);
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for skipping a change that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const response = await post(
      `/api/admin/person-import-runs/${MISSING}/changes/${MISSING}/skip`,
      cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a source that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    expect((await get(`/api/admin/person-sources/${MISSING}`, cookie)).statusCode).toBe(404);
    expect(
      (await get(`/api/admin/person-sources/${MISSING}/mappings`, cookie)).statusCode,
    ).toBe(404);
    expect(
      (await del(`/api/admin/person-sources/${MISSING}`, cookie)).statusCode,
    ).toBe(404);
  });

  it('answers 404 for a run that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const response = await get(`/api/admin/person-import-runs/${MISSING}`, cookie);
    expect(response.statusCode).toBe(404);
  });
});

describe('the run list filter', () => {
  /**
   * `sourceId` used to be cast straight off the query string, so a value that
   * was not a uuid reached Prisma and came back as a 500 -- the logs, for a
   * request that was simply wrong.
   */
  it('answers 400 for a source id that is not a uuid', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const response = await get('/api/admin/person-import-runs?sourceId=abc', cookie);
    expect(response.statusCode).toBe(400);
  });

  it('answers 400 for a confirmation that is not the word true', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const { id } = (await createSource(cookie)).json();
    // `z.coerce.boolean()` read the string "false" as true. A confirmation
    // that cannot be declined is not one.
    const response = await del(`/api/admin/person-sources/${id}?confirm=false`, cookie);
    expect(response.statusCode).toBe(400);
  });
});
