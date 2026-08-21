import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { hashPassword, setPasswordHash } from '../auth/password.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { ALL_PERMISSIONS } from '../rbac/permissions.js';
import { upsertUpstream } from './upstream-service.js';
import { linkOrProvision, mapClaims } from './jit-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import type { UpstreamIdpRecord } from './upstream-service.js';

const keyProvider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let upstream: UpstreamIdpRecord;

const base = {
  slug: 'entra',
  name: 'Entra ID',
  protocol: 'oidc' as const,
  enabled: true,
  issuerUrl: 'https://login.example/entra',
  clientId: 'syntra',
  scopes: ['openid', 'profile', 'email'],
  idpEntityId: null,
  ssoUrl: null,
  idpSloUrl: null,
  ssoBinding: 'HTTP-Redirect' as const,
  idpCertificates: [],
  wantAssertionsSigned: true,
  loginAttribute: 'preferred_username',
  emailAttribute: 'email',
  displayNameAttribute: 'name',
  groupsAttribute: null,
  createUsers: true,
  allowLoginAdoption: false,
  refreshOnLogin: true,
  defaultOrgUnitId: null,
};

const profile = (over: Record<string, unknown> = {}) => ({
  subject: 'upstream-sub-1',
  login: 'jdoe@acme.test',
  email: 'jdoe@acme.test',
  displayName: 'J Doe',
  groups: [] as string[],
  ...over,
});

/**
 * Reads through `withTenant`, never through the bare client.
 *
 * Every table here is FORCE ROW LEVEL SECURITY against
 * `current_setting('app.current_tenant')`, so `prisma.user.findMany()` outside
 * a bound transaction matches no rows whatever the database holds. An
 * assertion written that way that expects rows fails for a reason that has
 * nothing to do with the code under test, and — far worse — one that expects
 * *no* rows passes without ever looking.
 */
const users = (id: string = tenantId) => withTenant(id, (tx) => tx.user.findMany());
const links = (id: string = tenantId) =>
  withTenant(id, (tx) => tx.upstreamLink.findMany());

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  upstream = await withTenant(tenantId, (tx) => upsertUpstream(tx, keyProvider, base));
});

describe('linkOrProvision', () => {
  it('creates a local user on first login and marks the password as upstream', async () => {
    const result = await linkOrProvision(tenantId, upstream, profile());
    expect(result).toMatchObject({ created: true });

    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: (result as { userId: string }).userId } }),
    );
    expect(user.login).toBe('jdoe@acme.test');
    expect(user.displayName).toBe('J Doe');
    // Self-service reset must send them to the upstream, not mail a token.
    expect(user.passwordSource).toBe('upstream');
    expect(user.passwordSourceHint).toBe('Entra ID');
  });

  it('finds the same user again by upstream subject, not by email', async () => {
    const first = await linkOrProvision(tenantId, upstream, profile());
    // The upstream renamed them. A lookup by email would create a second
    // account; a lookup by subject is the whole reason UpstreamLink exists.
    const second = await linkOrProvision(
      tenantId,
      upstream,
      profile({
        email: 'jane.doe@acme.test',
        login: 'jane.doe@acme.test',
        displayName: 'Jane Doe',
      }),
    );
    expect(second).toMatchObject({
      userId: (first as { userId: string }).userId,
      created: false,
    });

    const rows = await users();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('jane.doe@acme.test');
    expect(rows[0]!.displayName).toBe('Jane Doe');
    // The login is the account's name in this directory and stays put; the
    // link, not the attribute, is what carried the identity across the rename.
    expect(rows[0]!.login).toBe('jdoe@acme.test');
  });

  it('leaves the local user alone when refreshOnLogin is off', async () => {
    const noRefresh = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, refreshOnLogin: false }),
    );
    await linkOrProvision(tenantId, noRefresh, profile());
    await linkOrProvision(tenantId, noRefresh, profile({ displayName: 'Renamed' }));
    const rows = await users();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('J Doe');
  });

  it('refuses to create a user when createUsers is off, and reports why', async () => {
    const noCreate = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, createUsers: false }),
    );
    expect(await linkOrProvision(tenantId, noCreate, profile())).toEqual({
      userId: null,
      reason: 'no_local_user',
    });
    expect(await users()).toHaveLength(0);
  });

  it('REFUSES an existing local account by default, and touches nothing', async () => {
    // This asserted the adoption for a long time, and the adoption is a
    // takeover: the upstream chooses what it asserts, so an identity provider
    // naming `admin` was handed the Syntra account called `admin`. Directory
    // Sync refuses exactly this and calls it a conflict; the reason does not
    // change because the claim arrived over SAML.
    const existing = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe@acme.test', email: 'x@acme.test', displayName: 'Old' }),
    );

    expect(await linkOrProvision(tenantId, upstream, profile())).toEqual({
      userId: null,
      reason: 'adoption_not_allowed',
    });

    // No link, and the account is exactly as it was — a refusal that still
    // rewrote `passwordSource` would have pointed this person's password reset
    // at an upstream that does not know them.
    expect(await links()).toHaveLength(0);
    const after = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: existing.id } }),
    );
    expect(after.displayName).toBe('Old');
    expect(after.passwordSource).toBe(existing.passwordSource);
  });

  it('links an existing local account when the upstream is permitted to', async () => {
    // The migration case the flag exists for: accounts pre-created for people
    // who have not signed in yet, holding nothing.
    const adopting = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, allowLoginAdoption: true }),
    );
    const existing = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe@acme.test', email: 'x@acme.test', displayName: 'Old' }),
    );
    const result = await linkOrProvision(tenantId, adopting, profile());
    expect(result).toMatchObject({ userId: existing.id, created: false });
    const rows = await links();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('upstream-sub-1');
  });

  it('refuses an account holding a PASSWORD, however the upstream is configured', async () => {
    const adopting = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, allowLoginAdoption: true }),
    );
    const existing = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe@acme.test',
        email: 'x@acme.test',
        displayName: 'Old',
      });
      await setPasswordHash(tx, user.id, await hashPassword('a-long-enough-password'));
      return user;
    });

    expect(await linkOrProvision(tenantId, adopting, profile())).toEqual({
      userId: null,
      reason: 'adoption_refused_privileged',
    });
    expect(await links()).toHaveLength(0);
    // The credential is still there and still theirs.
    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findFirst({ where: { userId: existing.id } }),
    );
    expect(credential).not.toBeNull();
  });

  it('refuses an account holding a ROLE, however the upstream is configured', async () => {
    // The account worth stealing. An administrator turning the flag on is
    // consenting to a migration, not to handing over authority somebody
    // granted — so the flag does not reach this, and no setting does.
    const adopting = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, allowLoginAdoption: true }),
    );
    await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe@acme.test',
        email: 'x@acme.test',
        displayName: 'Old',
      });
      const role = await createRole(tx, 'Owner', [...ALL_PERMISSIONS]);
      await assignRole(tx, user.id, role.id);
    });

    expect(await linkOrProvision(tenantId, adopting, profile())).toEqual({
      userId: null,
      reason: 'adoption_refused_privileged',
    });
    expect(await links()).toHaveLength(0);
  });

  it('refuses to adopt an account the same upstream already bound to another subject', async () => {
    const first = await linkOrProvision(tenantId, upstream, profile());
    const userId = (first as { userId: string }).userId;

    // The upstream has handed a leaver's login to their replacement, or has
    // been persuaded to assert it. Adopting it would give a second person the
    // first person's Syntra account and everything assigned to it.
    const second = await linkOrProvision(
      tenantId,
      upstream,
      profile({ subject: 'upstream-sub-2' }),
    );
    expect(second).toEqual({ userId: null, reason: 'link_conflict' });

    expect(await users()).toHaveLength(1);
    const rows = await links();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('upstream-sub-1');
    expect(rows[0]!.userId).toBe(userId);
  });

  it('lets a second upstream link the same local account, when permitted to', async () => {
    // Two identity providers for one person is a real arrangement, and it is
    // still an adoption: the second upstream is being handed an account it did
    // not create. `allowLoginAdoption` is what says the tenant meant it.
    const first = await linkOrProvision(tenantId, upstream, profile());
    const okta = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, {
        ...base,
        slug: 'okta',
        name: 'Okta',
        allowLoginAdoption: true,
      }),
    );
    const second = await linkOrProvision(tenantId, okta, profile({ subject: 'okta-1' }));
    expect(second).toMatchObject({
      userId: (first as { userId: string }).userId,
      created: false,
    });
    expect(await links()).toHaveLength(2);
    expect(await users()).toHaveLength(1);
  });

  it('refuses a profile with no usable login identifier rather than inventing one', async () => {
    expect(
      await linkOrProvision(tenantId, upstream, profile({ login: null, email: null })),
    ).toEqual({ userId: null, reason: 'incomplete_profile' });
    expect(await users()).toHaveLength(0);
  });

  it('does not reactivate a deactivated account', async () => {
    const result = await linkOrProvision(tenantId, upstream, profile());
    const userId = (result as { userId: string }).userId;
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left the company'));

    const again = await linkOrProvision(tenantId, upstream, profile());
    // The link still resolves, and the account is returned as it is. Nothing
    // here reactivates it — `authorize()` refuses an inactive user, which is
    // the correct place for that decision and the only place it is made. An
    // offboarded employee who still holds an upstream account must not be
    // signed back in by their own login.
    expect(again).toMatchObject({ userId, created: false });
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
  });

  it('keeps two tenants apart even when the upstream subject is identical', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    const otherUpstream = await withTenant(other.id, (tx) =>
      upsertUpstream(tx, keyProvider, base),
    );
    const a = await linkOrProvision(tenantId, upstream, profile());
    const b = await linkOrProvision(other.id, otherUpstream, profile());
    expect((a as { userId: string }).userId).not.toBe((b as { userId: string }).userId);
    expect(await users()).toHaveLength(1);
    expect(await users(other.id)).toHaveLength(1);
  });

  it('records the provisioning, so an account a third party caused is findable', async () => {
    await linkOrProvision(tenantId, upstream, profile({ groups: ['Finance'] }));
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'federation.user_provisioned' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      subject: 'upstream-sub-1',
      upstream: 'Entra ID',
      assertedGroups: ['Finance'],
    });
  });
});

describe('mapClaims', () => {
  it('reads only the attributes the upstream is configured to send', async () => {
    expect(
      mapClaims(upstream, {
        sub: 's-1',
        preferred_username: 'jdoe@acme.test',
        email: 'jdoe@acme.test',
        name: 'J Doe',
        groups: ['Finance'],
      }),
    ).toEqual({
      subject: 's-1',
      login: 'jdoe@acme.test',
      email: 'jdoe@acme.test',
      displayName: 'J Doe',
      // groupsAttribute is null on this upstream, so nothing is read even
      // though the token carries a `groups` claim.
      groups: [],
    });
  });

  it('treats a claim that is present but not a string as absent', async () => {
    // An upstream is free to send whatever it likes. Coercing a number or an
    // object here is how `[object Object]` ends up in a directory, and how a
    // login identifier gets invented for somebody who has none.
    expect(
      mapClaims(upstream, { sub: 's-1', preferred_username: 42, email: null, name: '' }),
    ).toEqual({ subject: 's-1', login: null, email: null, displayName: null, groups: [] });
  });

  it('drops the entries of a groups claim that are not names', async () => {
    const withGroups = { ...upstream, groupsAttribute: 'groups' };
    expect(mapClaims(withGroups, { sub: 's-1', groups: ['Finance', 7, null] }).groups).toEqual([
      'Finance',
    ]);
    expect(mapClaims(withGroups, { sub: 's-1', groups: 'Finance' }).groups).toEqual([
      'Finance',
    ]);
    expect(mapClaims(withGroups, { sub: 's-1', groups: { a: 1 } }).groups).toEqual([]);
  });

  it('reports a missing subject as an empty one rather than as "undefined"', async () => {
    expect(mapClaims(upstream, { preferred_username: 'jdoe@acme.test' }).subject).toBe('');
  });
});
