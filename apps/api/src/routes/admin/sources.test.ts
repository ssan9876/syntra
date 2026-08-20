import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ASSIGNABLE_FIELDS,
  DEFAULT_MAPPINGS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  syncScheduleKey,
  type Permission,
} from '@syntra/core';
import {
  buildTestApp,
  createFakeScheduler,
  type FakeScheduler,
} from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let scheduler: FakeScheduler;
const PASSWORD = 'a-long-enough-password';

/**
 * Hashed once for the whole file, outside every transaction.
 *
 * There is no helper that takes a plaintext and a transaction any more:
 * Argon2id is deliberately expensive and has no business inside Prisma's
 * 5000 ms budget, so `setPasswordHash` takes a hash and the hashing is the
 * caller's to place. Hashing once per file rather than once per test is the
 * same decision made cheaply.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);


const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'ou=Shared,dc=acme,dc=test',
  groupSearchBase: 'ou=Shared,dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
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

const patch = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const del = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  scheduler = createFakeScheduler();
  ctx = await buildTestApp({ scheduler: () => scheduler });
  await ctx.app.ready();
});

describe('source administration', () => {
  it('creates a source without echoing the password', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('adminpassword');
  });

  it('refuses a duplicate name with a 409, not a bare 500', async () => {
    // The unique index on (tenantId, name) is what actually protects this, and
    // it surfaced as a 500 with nothing an administrator could act on.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(409);
    expect((await get('/api/admin/sources', cookie)).json().sources).toHaveLength(1);
  });

  it('refuses to create a source with only sync.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    expect(res.statusCode).toBe(403);
  });

  it('tests a connection and reports what it found', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().sampleCounts.user).toBeGreaterThan(0);
  });

  it('reports a bad credential as ok:false rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Bad',
      config,
      bindPassword: 'wrong-password',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it('creates a source disabled when asked, so a schedule cannot fire before its mappings exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post('/api/admin/sources', cookie, {
      name: 'Not yet',
      config,
      bindPassword: 'adminpassword',
      schedule: '0 3 * * *',
      enabled: false,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().enabled).toBe(false);
    // A create is scheduled the moment it commits, so a source saved disabled
    // with a cron expression must not be on the scheduler at all.
    expect(scheduler.scheduled).toHaveLength(0);
  });
});

describe('reading one source', () => {
  it('carries the counts of what it owns, so a delete can be described before it is offered', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const sourceId = created.json().id as string;

    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'synced',
        email: 'synced@acme.test',
        displayName: 'Synced',
      });
      await tx.user.update({
        where: { id: user.id },
        data: { sourceId, sourceAnchor: 'anchor-1' },
      });
    });

    const res = await get(`/api/admin/sources/${sourceId}`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().owned).toEqual({ users: 1, groups: 0, orgUnits: 0 });
    // The row carries the secret's name, never the secret.
    expect(res.body).not.toContain('adminpassword');
  });

  it('returns a 404, not a 500, for a source that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await get(
      '/api/admin/sources/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('answers the mappings that were set for it', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const sourceId = created.json().id as string;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${sourceId}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: { rules: DEFAULT_MAPPINGS.openLdap },
    });

    const res = await get(`/api/admin/sources/${sourceId}/mappings`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().rules).toHaveLength(DEFAULT_MAPPINGS.openLdap.length);
  });
});

describe('what the mapping editor starts from', () => {
  it('serves both flavours and the fields a mapping may write', async () => {
    // Served rather than duplicated in the browser bundle: a default the
    // console disagreed with would seed a mapping the server then refuses.
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await get('/api/admin/sources/mapping-defaults', cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().flavours.openLdap).toEqual(DEFAULT_MAPPINGS.openLdap);
    expect(res.json().flavours.activeDirectory).toEqual(
      DEFAULT_MAPPINGS.activeDirectory,
    );
    expect(res.json().assignableFields.user).toEqual(ASSIGNABLE_FIELDS.user);
  });

  it('is reachable without shadowing a source id', async () => {
    // "mapping-defaults" is not a uuid, so a router preferring the parametric
    // route would answer this with a validation failure instead.
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    expect(
      (await get('/api/admin/sources/mapping-defaults', cookie)).statusCode,
    ).toBe(200);
  });
});

describe('testing a connection that was never saved', () => {
  it('reports the counts and the object classes and attributes it found', async () => {
    // Spec success criterion 1. discoverSchema had no caller outside its own
    // test before this endpoint existed.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);

    const res = await post('/api/admin/sources/test', cookie, {
      config,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().sampleCounts.user).toBeGreaterThan(0);
    expect(res.json().schema.objectClasses).toContain('inetOrgPerson');
    expect(res.json().schema.attributes).toContain('cn');
  });

  it('uses the saved credential when the editor did not retype one', async () => {
    // The browser is never handed the stored password, so an edit that
    // changes a search base and re-tests has to name the source instead.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    const res = await post('/api/admin/sources/test', cookie, {
      config: { ...config, userSearchBase: 'ou=Care,ou=Shared,dc=acme,dc=test' },
      sourceId: created.json().id,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('reports a refused bind as a result rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const res = await post('/api/admin/sources/test', cookie, {
      config,
      bindPassword: 'wrong-password',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().schema).toBeNull();
  });

  it('names the field when the configuration itself is wrong', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const res = await post('/api/admin/sources/test', cookie, {
      config: { ...config, url: 'ldaps://localhost:1636', tlsMode: 'starttls' },
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(
      'tlsMode',
    );
  });

  it('refuses a test with only sync.read', async () => {
    // This opens a connection to any host the caller names.
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await post('/api/admin/sources/test', cookie, {
      config,
      bindPassword: 'adminpassword',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns a 404 for a saved source it was told to borrow a password from', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const res = await post('/api/admin/sources/test', cookie, {
      config,
      sourceId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a request carrying neither a password nor a source', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const res = await post('/api/admin/sources/test', cookie, { config });
    expect(res.statusCode).toBe(400);
  });

  it('records every test in the audit log, with where it connected', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.AUDIT_READ]);
    await post('/api/admin/sources/test', cookie, {
      config,
      bindPassword: 'adminpassword',
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'source.test' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
    expect(events[0]!.payload).toMatchObject({
      url: config.url,
      usedStoredCredential: false,
    });
    // The credential is not in the log, and neither is anything that would
    // let a reader reconstruct it.
    expect(JSON.stringify(events[0]!.payload)).not.toContain('adminpassword');
  });
});

describe('borrowing a saved source’s bind password', () => {
  /**
   * A socket that records everything it is sent and answers nothing.
   *
   * This is the attacker's end of the hole being closed here: point a test at
   * it, name a saved source instead of a password, and whatever crosses the
   * wire is the vault's contents in the clear.
   */
  async function sink(): Promise<{
    port: number;
    received(): string;
    close(): void;
  }> {
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    let seen = '';
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => {
        seen += chunk.toString('binary');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as { port: number }).port,
      received: () => seen,
      close: () => {
        for (const socket of sockets) socket.destroy();
        server.close();
      },
    };
  }

  const savedSource = async (cookie: string) => {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    return created.json().id as string;
  };

  it('refuses to send it to a URL other than the one the source is saved with', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const sourceId = await savedSource(cookie);
    const listener = await sink();

    try {
      const res = await post('/api/admin/sources/test', cookie, {
        config: { ...config, url: `ldap://127.0.0.1:${listener.port}` },
        sourceId,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().type).toContain('transport-changed');
      expect(res.json().errors[0].path).toBe('url');
      // Nothing was sent at all, let alone the credential.
      expect(listener.received()).toBe('');
      expect(listener.received()).not.toContain('adminpassword');
    } finally {
      listener.close();
    }
  }, 20_000);

  it('refuses to downgrade the transport it would cross on', async () => {
    // The same hole with the destination left alone: an `ldaps` source
    // re-tested as `plain` puts the stored password on the wire in cleartext.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Secure',
      config: {
        ...config,
        url: process.env.LDAPS_URL ?? 'ldaps://localhost:1636',
        tlsMode: 'ldaps',
        rejectUnauthorized: false,
      },
      bindPassword: 'adminpassword',
    });

    const res = await post('/api/admin/sources/test', cookie, {
      config: {
        ...config,
        url: process.env.LDAPS_URL ?? 'ldaps://localhost:1636',
        tlsMode: 'ldaps',
        rejectUnauthorized: true,
      },
      sourceId: created.json().id,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe('rejectUnauthorized');
  });

  it('records the refusal, so the attempt is not invisible', async () => {
    // The point of the old hole was that it changed nothing and therefore
    // left nothing behind. A refusal that is also silent would keep half of
    // that property.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const sourceId = await savedSource(cookie);

    await post('/api/admin/sources/test', cookie, {
      config: { ...config, url: 'ldap://198.51.100.9:389' },
      sourceId,
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'source.test' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
    expect(events[0]!.payload).toMatchObject({
      url: 'ldap://198.51.100.9:389',
      refused: 'transport-changed',
      usedStoredCredential: true,
    });
  });

  it('still allows a different destination when the password is typed', async () => {
    // Refusing the borrow is not refusing the test. Proof of possession is
    // what was missing, and typing the password supplies it.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const sourceId = await savedSource(cookie);

    const res = await post('/api/admin/sources/test', cookie, {
      config: { ...config, userSearchBase: 'ou=Care,ou=Shared,dc=acme,dc=test' },
      sourceId,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('lets everything that is not the transport change freely', async () => {
    // Editing a search base and re-testing is the case this borrow exists
    // for, and it must not have become collateral damage.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const sourceId = await savedSource(cookie);

    const res = await post('/api/admin/sources/test', cookie, {
      config: {
        ...config,
        userSearchBase: 'ou=Care,ou=Shared,dc=acme,dc=test',
        userFilter: '(objectClass=person)',
      },
      sourceId,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('runs', () => {
  async function seeded(cookie: string) {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
          { objectType: 'user', sourceAttribute: 'cn', targetField: 'displayName', transform: 'trim', isCorrelation: false },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    return id;
  }

  it('runs a preview and returns the proposed changes', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(cookie);

    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('previewed');

    const detail = await get(`/api/admin/sync-runs/${run.json().id}`, cookie);
    expect(detail.json().changes.length).toBeGreaterThan(0);
  });

  it('applies a run', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ, PERMISSIONS.DIRECTORY_READ]);
    const id = await seeded(cookie);
    const run = await post(`/api/admin/sources/${id}/run`, cookie);

    const applied = await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    expect(applied.statusCode).toBe(200);

    const users = await get('/api/admin/users', cookie);
    expect(users.json().users.length).toBeGreaterThan(0);
  });

  it('refuses to apply with only sync.read', async () => {
    const manage = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(manage);
    const run = await post(`/api/admin/sources/${id}/run`, manage);

    // A second administrator holding only read.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'reader',
        email: 'r@acme.test',
        displayName: 'Reader',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      const role = await createRole(tx, 'ReadOnly', [PERMISSIONS.SYNC_READ]);
      await assignRole(tx, user.id, role.id);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'reader', password: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${token}` },
      payload: { password: PASSWORD },
    });
    const readerCookie = `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;

    const res = await post(
      `/api/admin/sync-runs/${run.json().id}/apply`,
      readerCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it('returns a 404, not a 500, when applying a run that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post(
      '/api/admin/sync-runs/00000000-0000-0000-0000-000000000000/apply',
      cookie,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toContain('not-found');
  });

  it('refuses to apply a blocked run', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    // Filters that match nothing across both object types make the source
    // return zero records, which trips the guard's zero-records branch. The
    // fixture config here has no orgUnitSearchBase, so the org-unit search
    // never runs and zeroing these two filters is enough.
    const created = await post('/api/admin/sources', cookie, {
      name: 'Empty',
      config: {
        ...config,
        userFilter: '(objectClass=nothingAtAll)',
        groupFilter: '(objectClass=nothingAtAll)',
      },
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;

    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    expect(run.json().status).toBe('blocked');

    const res = await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('run-blocked');
  });
});

describe('skipping a change', () => {
  async function seededRun(cookie: string) {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    const detail = await get(`/api/admin/sync-runs/${run.json().id}`, cookie);
    return { runId: run.json().id, changes: detail.json().changes };
  }

  it('skips a proposed change and records who did it', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.AUDIT_READ,
    ]);
    const { runId, changes } = await seededRun(cookie);

    const res = await post(
      `/api/admin/sync-changes/${changes[0].id}/skip`,
      cookie,
    );
    expect(res.statusCode).toBe(204);

    const detail = await get(`/api/admin/sync-runs/${runId}`, cookie);
    const skipped = detail
      .json()
      .changes.find((c: { id: string }) => c.id === changes[0].id);
    expect(skipped.status).toBe('skipped');

    const audit = await get('/api/admin/audit', cookie);
    expect(
      audit
        .json()
        .events.some(
          (e: { action: string; targetId: string }) =>
            e.action === 'sync.skip_change' && e.targetId === changes[0].id,
        ),
    ).toBe(true);
  });

  it('refuses to rewrite an already applied change as skipped', async () => {
    // Marking an applied change `skipped` would make the run state that a
    // mutation which committed to the directory never happened.
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const { runId, changes } = await seededRun(cookie);
    await post(`/api/admin/sync-runs/${runId}/apply`, cookie);

    const res = await post(
      `/api/admin/sync-changes/${changes[0].id}/skip`,
      cookie,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('change-not-proposed');

    const detail = await get(`/api/admin/sync-runs/${runId}`, cookie);
    const still = detail
      .json()
      .changes.find((c: { id: string }) => c.id === changes[0].id);
    expect(still.status).toBe('applied');
  });

  it('returns a 404 for a change that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post(
      '/api/admin/sync-changes/00000000-0000-0000-0000-000000000000/skip',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});

/** A second administrator holding only sync.read, for the permission tests. */
async function readerCookie() {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'reader',
      email: 'r@acme.test',
      displayName: 'Reader',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'ReadOnly', [PERMISSIONS.SYNC_READ]);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'reader', password: PASSWORD },
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

const createSourceVia = (cookie: string, body: Record<string, unknown> = {}) =>
  post('/api/admin/sources', cookie, {
    name: 'Head office',
    config,
    bindPassword: 'adminpassword',
    ...body,
  });

describe('scheduling a source as it changes', () => {
  const cron = '0 3 * * *';

  it('schedules a new source there and then, not at the next restart', async () => {
    // scheduleAllSyncSources runs once at boot and the create route never
    // touched the scheduler, so before this a source created with a cron
    // expression did not run until someone restarted the API.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);

    const created = await createSourceVia(cookie, { schedule: cron });

    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]!.cron).toBe(cron);
    expect(scheduler.scheduled[0]!.key).toBe(
      syncScheduleKey(ctx.tenantId, created.json().id),
    );
    expect(scheduler.scheduled[0]!.data).toEqual({
      tenantId: ctx.tenantId,
      sourceId: created.json().id,
    });
  });

  it('schedules nothing for a source created without a cron expression', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);

    await createSourceVia(cookie);

    expect(scheduler.scheduled).toEqual([]);
  });

  it('reschedules on the new cron expression when the schedule is edited', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie, { schedule: cron });

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      schedule: '15 4 * * *',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().schedule).toBe('15 4 * * *');
    expect(scheduler.scheduled.at(-1)!.cron).toBe('15 4 * * *');
    expect(scheduler.scheduled.at(-1)!.key).toBe(
      syncScheduleKey(ctx.tenantId, created.json().id),
    );
  });

  it('unschedules a source that is disabled, rather than leaving it running', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie, { schedule: cron });

    await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      enabled: false,
    });

    expect(scheduler.unscheduled.map((c) => c.key)).toContain(
      syncScheduleKey(ctx.tenantId, created.json().id),
    );
  });

  it('unschedules a source whose cron expression is cleared', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie, { schedule: cron });

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      schedule: null,
    });

    expect(res.json().schedule).toBeNull();
    expect(scheduler.unscheduled.map((c) => c.key)).toContain(
      syncScheduleKey(ctx.tenantId, created.json().id),
    );
  });

  it('refuses a cron expression the scheduler could not parse, on create', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await createSourceVia(cookie, { schedule: 'not a cron' });

    expect(res.statusCode).toBe(400);
    expect((await get('/api/admin/sources', cookie)).json().sources).toEqual([]);
    expect(scheduler.scheduled).toEqual([]);
  });

  it('refuses a bad cron expression on edit, and leaves the working one running', async () => {
    // pg-boss parses the expression *before* its upsert, so a malformed one
    // throws with the old schedule row still in place. Without this check the
    // PATCH returned 200, the console rendered "not a cron", and the scheduler
    // went on firing the previous expression -- displayed schedule and actual
    // schedule diverging with nothing but a log line to say so.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await createSourceVia(cookie, { schedule: cron });
    const scheduledBefore = scheduler.scheduled.length;

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      schedule: 'not a cron',
    });

    expect(res.statusCode).toBe(400);

    // The stored schedule is still the one that works, and so is the scheduler.
    const listed = (await get('/api/admin/sources', cookie)).json().sources;
    expect(listed[0].schedule).toBe(cron);
    expect(scheduler.scheduled).toHaveLength(scheduledBefore);
  });

  it('unschedules a deleted source, so it cannot fire against nothing', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie, { schedule: cron });

    const res = await del(`/api/admin/sources/${created.json().id}`, cookie);

    expect(res.statusCode).toBe(204);
    expect(scheduler.unscheduled.map((c) => c.key)).toContain(
      syncScheduleKey(ctx.tenantId, created.json().id),
    );
  });
});

describe('editing a source', () => {
  it('changes the settings that used to be fixed at creation', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie);

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      name: 'Head office (renamed)',
      autoApply: true,
      deactivationThresholdPercent: 25,
      enabled: false,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Head office (renamed)',
      autoApply: true,
      deactivationThresholdPercent: 25,
      enabled: false,
    });
  });

  it('leaves alone what the request did not mention', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie, {
      schedule: '0 3 * * *',
      autoApply: true,
    });

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      name: 'Renamed',
    });

    expect(res.json().schedule).toBe('0 3 * * *');
    expect(res.json().autoApply).toBe(true);
    expect(res.json().config).toEqual(created.json().config);
  });

  it('rotates the bind password, and the new one is what the connection uses', async () => {
    // The strongest proof available that the vault entry was replaced rather
    // than added alongside: the source could not bind before, and can after.
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await createSourceVia(cookie, { bindPassword: 'wrong-password' });
    const id = created.json().id;

    expect((await post(`/api/admin/sources/${id}/test`, cookie)).json().ok).toBe(
      false,
    );

    const res = await patch(`/api/admin/sources/${id}`, cookie, {
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('adminpassword');
    expect((await post(`/api/admin/sources/${id}/test`, cookie)).json().ok).toBe(
      true,
    );
  });

  it('refuses a configuration the connector could not use', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie);

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      // An ldaps mode on an ldap:// URL. Reinterpreting either half silently
      // is how a source ends up binding in the clear.
      config: { ...config, tlsMode: 'ldaps' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().type).toContain('invalid-config');
  });

  it('refuses to rename a source onto another source name', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    await createSourceVia(cookie, { name: 'Head office' });
    const second = await createSourceVia(cookie, { name: 'Branch' });

    const res = await patch(`/api/admin/sources/${second.json().id}`, cookie, {
      name: 'Head office',
    });

    expect(res.statusCode).toBe(409);
  });

  it('lets a source keep its own name', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(cookie);

    const res = await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      name: 'Head office',
      autoApply: true,
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns a 404, not a 500, for a source that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);

    const res = await patch(
      '/api/admin/sources/00000000-0000-0000-0000-000000000000',
      cookie,
      { autoApply: true },
    );

    expect(res.statusCode).toBe(404);
  });

  it('refuses an edit with only sync.read', async () => {
    const manage = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(manage);

    const res = await patch(
      `/api/admin/sources/${created.json().id}`,
      await readerCookie(),
      { autoApply: true },
    );

    expect(res.statusCode).toBe(403);
  });

  it('audits which fields changed, and none of their values', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.AUDIT_READ]);
    const created = await createSourceVia(cookie);

    await patch(`/api/admin/sources/${created.json().id}`, cookie, {
      bindPassword: 'a-rotated-secret',
      autoApply: true,
    });

    const audit = await get('/api/admin/audit', cookie);
    const event = audit
      .json()
      .events.find((e: { action: string }) => e.action === 'source.update');

    expect(event).toBeDefined();
    expect(event.targetId).toBe(created.json().id);
    expect(event.payload.fields).toEqual(['autoApply', 'bindPassword']);
    // A bind DN and a credential have no business in a log anyone holding
    // audit.read can read.
    expect(JSON.stringify(event)).not.toContain('a-rotated-secret');
  });
});

describe('deleting a source', () => {
  /** A source that has run once, so it owns the fixture's users and group. */
  async function synced(cookie: string) {
    const created = await createSourceVia(cookie);
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    return id;
  }

  it('deletes a source that owns nothing', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await createSourceVia(cookie);

    const res = await del(`/api/admin/sources/${created.json().id}`, cookie);

    expect(res.statusCode).toBe(204);
    expect((await get('/api/admin/sources', cookie)).json().sources).toEqual([]);
  });

  it('refuses, with the numbers, to delete a source that still owns accounts', async () => {
    // Deleting deactivates every account the source owns. That revokes real
    // access, so it waits for a decision -- the same shape as the run guard,
    // which will not apply an outsized deactivation unconfirmed either.
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const id = await synced(cookie);

    const res = await del(`/api/admin/sources/${id}`, cookie);

    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('source-owns-directory-objects');
    expect(res.json().owned.users).toBe(2);

    // Nothing happened: the source is still there and so is everyone in it.
    expect((await get('/api/admin/sources', cookie)).json().sources).toHaveLength(1);
    const users = await get('/api/admin/users', cookie);
    expect(
      users.json().users.every((u: { status: string }) => u.status === 'active'),
    ).toBe(true);
  });

  it('refuses when the numbers moved under the confirmation', async () => {
    // A confirmation is worth only the figures it was given, and those are
    // read when a screen opens. A run in between can turn two accounts into
    // two thousand, and deleting anyway carries out a decision nobody made.
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const id = await synced(cookie);

    const res = await del(
      `/api/admin/sources/${id}?confirm=true&ackUsers=1&ackGroups=0&ackOrgUnits=0`,
      cookie,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('source-counts-changed');
    expect(res.json().owned.users).toBe(2);
    // And nothing was deactivated on the way to saying so.
    const users = await get('/api/admin/users', cookie);
    expect(
      users.json().users.every((u: { status: string }) => u.status === 'active'),
    ).toBe(true);
  });

  it('goes ahead when the acknowledged numbers are the real ones', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const id = await synced(cookie);

    // Read the way the console reads them, rather than assumed.
    const owned = (await get(`/api/admin/sources/${id}`, cookie)).json().owned;
    const res = await del(
      `/api/admin/sources/${id}?confirm=true&ackUsers=${owned.users}` +
        `&ackGroups=${owned.groups}&ackOrgUnits=${owned.orgUnits}`,
      cookie,
    );

    expect(res.statusCode).toBe(204);
    expect((await get('/api/admin/sources', cookie)).json().sources).toHaveLength(0);
  });

  it('deactivates and detaches the accounts it owned when the caller confirms', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const id = await synced(cookie);

    const res = await del(`/api/admin/sources/${id}?confirm=true`, cookie);
    expect(res.statusCode).toBe(204);

    expect((await get('/api/admin/sources', cookie)).json().sources).toEqual([]);

    const all = await withTenant(ctx.tenantId, (tx) => tx.user.findMany());
    const fromSource = all.filter((u) => u.login !== 'admin');
    expect(fromSource).toHaveLength(2);
    // Deactivated, never deleted: this subsystem removes no directory object
    // anywhere else either.
    expect(fromSource.every((u) => u.status === 'inactive')).toBe(true);
    expect(fromSource.every((u) => u.statusReason?.includes('Head office'))).toBe(
      true,
    );
    // And detached, so nothing carries an anchor into a source that is gone.
    expect(fromSource.every((u) => u.sourceId === null)).toBe(true);
    expect(fromSource.every((u) => u.sourceAnchor === null)).toBe(true);
  });

  it('records what the deletion deactivated', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.AUDIT_READ,
    ]);
    const id = await synced(cookie);

    await del(`/api/admin/sources/${id}?confirm=true`, cookie);

    const audit = await get('/api/admin/audit', cookie);
    const event = audit
      .json()
      .events.find((e: { action: string }) => e.action === 'source.delete');

    expect(event).toBeDefined();
    expect(event.targetId).toBe(id);
    expect(event.payload.deactivated).toEqual({
      users: 2,
      groups: 1,
      orgUnits: 0,
    });
  });

  it('returns a 404, not a 500, for a source that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE]);

    const res = await del(
      '/api/admin/sources/00000000-0000-0000-0000-000000000000',
      cookie,
    );

    expect(res.statusCode).toBe(404);
  });

  it('refuses a delete with only sync.read', async () => {
    const manage = await adminCookie([PERMISSIONS.SYNC_MANAGE]);
    const created = await createSourceVia(manage);

    const res = await del(
      `/api/admin/sources/${created.json().id}`,
      await readerCookie(),
    );

    expect(res.statusCode).toBe(403);
  });
});
