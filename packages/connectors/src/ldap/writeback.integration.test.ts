import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'ldapts';
import { normaliseAnchor } from './anchor.js';
import { ldapWriteback } from './writeback.js';
import { adTargetConnector } from '../ad/connector.js';
// A plain module, not the smoke test: importing a test file registers its
// hooks and its tests inside THIS file's collection and runs them again.
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
} from '../ad/samba-connection.js';
import type { LdapConfig } from './config.js';

const samba = sambaConnection();
const testOu = `OU=WritebackTest,${samba.baseDn}`;

/**
 * The write-back operates on a *source* config, which is what a directory
 * source is configured with -- not a target config. That is the point: the
 * system a user is read FROM is the system their password lives in.
 */
const config: LdapConfig & { bindPassword: string } = {
  url: samba.url,
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: samba.bindDn,
  bindPassword: samba.bindPassword,
  userSearchBase: testOu,
  groupSearchBase: testOu,
  anchorAttribute: 'objectGUID',
  noteAttribute: 'info',
};

let admin: Client;

/**
 * The domain's minimum password age, in the negative 100-nanosecond intervals
 * Active Directory stores it as. The container ships with one day.
 *
 * These tests create an account and change its password seconds later, which a
 * one-day minimum correctly refuses -- so the suite sets it to zero and one
 * test puts it back to assert the refusal deliberately. That refusal is not an
 * obstacle: it is the evidence that the CHANGE form is in use rather than the
 * administrative reset form, because the reset form bypasses minimum password
 * age and this would then silently succeed.
 */
const ONE_DAY = '-864000000000';

async function setMinPwdAge(value: string): Promise<void> {
  const { Attribute, Change } = await import('ldapts');
  await admin.modify(samba.baseDn, [
    new Change({
      operation: 'replace',
      modification: new Attribute({ type: 'minPwdAge', values: [value] }),
    }),
  ]);
}

const PASSWORD = 'Writeback!Initial0';
const NEXT_PASSWORD = 'Writeback!Second1';

beforeAll(async () => {
  admin = await connectAsSambaAdmin();
  await admin
    .add(testOu, { objectClass: ['top', 'organizationalUnit'] })
    .catch(() => undefined);
  await setMinPwdAge('0');
}, 120_000);

beforeEach(() => purgeSubtree(admin, testOu));

afterAll(async () => {
  await purgeSubtree(admin, testOu).catch(() => undefined);
  await setMinPwdAge(ONE_DAY).catch(() => undefined);
  await admin?.unbind().catch(() => undefined);
});

/**
 * Creates an enabled account with a known password, through the target
 * connector, and returns its anchor and DN.
 *
 * Through the connector rather than by hand because getting an AD account into
 * a usable, password-set, enabled state is the exact sequence that connector
 * already implements and got right; reimplementing it here would test a
 * different account than the product creates.
 */
async function makeAccount(correlationKey: string): Promise<{
  anchor: string;
  dn: string;
}> {
  const result = await adTargetConnector.write(
    {
      url: samba.url,
      tlsMode: 'ldaps',
      rejectUnauthorized: false,
      bindDn: samba.bindDn,
      bindPassword: samba.bindPassword,
      baseDn: testOu,
      entitlementSearchBase: testOu,
      archiveContainer: testOu,
      provenanceAttribute: 'info',
    },
    {
      op: 'create_account',
      actionId: `act-${correlationKey}`,
      correlationKey,
      attributes: {
        displayName: ['Test Person'],
        givenName: ['Test'],
        sn: ['Person'],
        userPrincipalName: [`${correlationKey}@syntra.test`],
        distinguishedName: [`CN=${correlationKey},${testOu}`],
      },
      enabled: true,
      initialPassword: PASSWORD,
    },
  );
  expect(result.ok, result.message).toBe(true);
  return { anchor: result.anchor!, dn: `CN=${correlationKey},${testOu}` };
}

async function readUac(dn: string): Promise<number> {
  const { searchEntries } = await admin.search(dn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['userAccountControl'],
  });
  return Number(searchEntries[0]!.userAccountControl);
}

async function readNote(dn: string): Promise<string> {
  const { searchEntries } = await admin.search(dn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['info'],
  });
  return String(searchEntries[0]?.info ?? '');
}

/** Whether the directory accepts this password for this account. */
async function canBind(dn: string, password: string): Promise<boolean> {
  const { Client: LdapClient } = await import('ldapts');
  const client = new LdapClient({
    url: samba.url,
    tlsOptions: { rejectUnauthorized: false },
  });
  try {
    await client.bind(dn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

describe('ldapWriteback.changePassword', () => {
  /**
   * The assertion that matters is not the return value -- it is that the
   * DIRECTORY now accepts a password it refused a moment ago. A write that
   * reported success while leaving the password alone is the exact failure
   * this feature exists to prevent, and only a bind can tell.
   *
   * Deliberately NOT asserting that the old password stops working. This
   * container accepts a recently-superseded password for a grace period, and
   * it does so for an administrative `replace` just as much as for the change
   * form -- verified directly rather than assumed. Asserting it here would be
   * asserting the container's grace window, and the test would fail for a
   * reason that has nothing to do with this code.
   */
  it('changes the password in the directory', async () => {
    const { anchor, dn } = await makeAccount('pw.change');
    expect(await canBind(dn, NEXT_PASSWORD)).toBe(false);

    const result = await ldapWriteback.changePassword(config, {
      anchor,
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
    });

    expect(result.ok, result.message).toBe(true);
    expect(await canBind(dn, NEXT_PASSWORD)).toBe(true);
  });

  it('refuses a wrong current password and leaves the old one working', async () => {
    const { anchor, dn } = await makeAccount('pw.wrong');

    const result = await ldapWriteback.changePassword(config, {
      anchor,
      currentPassword: 'not the password',
      newPassword: NEXT_PASSWORD,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('wrong_password');
    expect(await canBind(dn, PASSWORD)).toBe(true);
    expect(await canBind(dn, NEXT_PASSWORD)).toBe(false);
  });

  /**
   * The domain's policy is the authority, not Syntra's. A password Syntra
   * would accept and the domain would not must fail here rather than diverge.
   */
  it('reports the directory refusing a new password on policy', async () => {
    const { anchor, dn } = await makeAccount('pw.policy');

    const result = await ldapWriteback.changePassword(config, {
      anchor,
      currentPassword: PASSWORD,
      newPassword: 'short',
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('policy');
    expect(await canBind(dn, PASSWORD)).toBe(true);
  });

  /**
   * The evidence that this is the change form and not an administrative reset.
   *
   * `delete unicodePwd + add unicodePwd`, bound as the user, is subject to the
   * domain's minimum password age. `replace unicodePwd`, bound as a service
   * account holding Reset Password, is not. If this test ever passes the
   * change through, the implementation has quietly become the privileged form
   * -- which would mean the service account needs reset rights over every user
   * in the OU, and anyone who reads that credential out of the vault owns
   * every identity in it.
   */
  it('honours the domain minimum password age, which a reset would bypass', async () => {
    const { anchor, dn } = await makeAccount('pw.minage');
    await setMinPwdAge(ONE_DAY);
    try {
      const result = await ldapWriteback.changePassword(config, {
        anchor,
        currentPassword: PASSWORD,
        newPassword: NEXT_PASSWORD,
      });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe('policy');
      expect(await canBind(dn, PASSWORD)).toBe(true);
    } finally {
      await setMinPwdAge('0');
    }
  });

  /**
   * The domain's password history is the domain's, and it applies. Changing
   * back to a password the account has recently held is refused by the
   * directory, not by Syntra -- Syntra has no idea what the last 24 were.
   */
  it('lets the domain refuse a password from its own history', async () => {
    const { anchor, dn } = await makeAccount('pw.history');

    const forward = await ldapWriteback.changePassword(config, {
      anchor,
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
    });
    expect(forward.ok, forward.message).toBe(true);

    const back = await ldapWriteback.changePassword(config, {
      anchor,
      currentPassword: NEXT_PASSWORD,
      newPassword: PASSWORD,
    });
    expect(back.ok).toBe(false);
    expect(back.failure).toBe('policy');
    expect(await canBind(dn, NEXT_PASSWORD)).toBe(true);
  });

  /** Neither password may reach a message that is shown or logged. */
  it('never puts either password in the result', async () => {
    const { anchor } = await makeAccount('pw.quiet');

    for (const attempt of [
      { currentPassword: PASSWORD, newPassword: 'short' },
      { currentPassword: 'wrong one', newPassword: NEXT_PASSWORD },
    ]) {
      const result = await ldapWriteback.changePassword(config, {
        anchor,
        ...attempt,
      });
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(attempt.currentPassword);
      expect(serialised).not.toContain(attempt.newPassword);
    }
  });

  it('reports an anchor that names nothing', async () => {
    const result = await ldapWriteback.changePassword(config, {
      anchor: normaliseAnchor(
        'objectGUID',
        Buffer.from([
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
          0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        ]),
      ),
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
    });
    expect(result.failure).toBe('not_found');
  });

  /**
   * Refused BEFORE the password is transmitted, not after. A directory that
   * accepted the write would have taken it in the clear and returned success.
   */
  it('refuses to send a password over an unencrypted connection', async () => {
    const result = await ldapWriteback.changePassword(
      { ...config, url: 'ldap://localhost:1390', tlsMode: 'plain' },
      { anchor: 'irrelevant', currentPassword: PASSWORD, newPassword: NEXT_PASSWORD },
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unauthorized');
    expect(result.message).toContain('without TLS');
  });
});

describe('ldapWriteback.setEnabled', () => {
  it('disables an account and stops it binding', async () => {
    const { anchor, dn } = await makeAccount('en.disable');
    expect(await canBind(dn, PASSWORD)).toBe(true);

    const result = await ldapWriteback.setEnabled(config, {
      anchor,
      enabled: false,
      reason: 'deactivated by an administrator',
    });

    expect(result.ok, result.message).toBe(true);
    expect(await canBind(dn, PASSWORD)).toBe(false);
  });

  it('enables it again', async () => {
    const { anchor, dn } = await makeAccount('en.enable');
    await ldapWriteback.setEnabled(config, { anchor, enabled: false, reason: 'x' });

    const result = await ldapWriteback.setEnabled(config, {
      anchor,
      enabled: true,
      reason: 'reinstated',
    });

    expect(result.ok, result.message).toBe(true);
    expect(await canBind(dn, PASSWORD)).toBe(true);
  });

  /**
   * The bit, never a literal 514. An account whose password does not expire is
   * 66048, and writing 514 to disable it would silently clear that flag --
   * permanently, since re-enabling would then restore 512.
   */
  it('sets the disable bit without clobbering the other flags', async () => {
    const { anchor, dn } = await makeAccount('en.flags');
    // 66048 = 512 (normal account) | 65536 (password never expires)
    await admin.modify(dn, [
      new (await import('ldapts')).Change({
        operation: 'replace',
        modification: new (await import('ldapts')).Attribute({
          type: 'userAccountControl',
          values: ['66048'],
        }),
      }),
    ]);

    await ldapWriteback.setEnabled(config, { anchor, enabled: false, reason: 'x' });
    expect(await readUac(dn)).toBe(66050);

    await ldapWriteback.setEnabled(config, { anchor, enabled: true, reason: 'y' });
    expect(await readUac(dn)).toBe(66048);
  });

  it('is idempotent and does not report a second disable as a failure', async () => {
    const { anchor } = await makeAccount('en.twice');
    const first = await ldapWriteback.setEnabled(config, {
      anchor,
      enabled: false,
      reason: 'x',
    });
    const second = await ldapWriteback.setEnabled(config, {
      anchor,
      enabled: false,
      reason: 'x',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.message).toContain('already');
  });

  /**
   * Merged into the note, not replacing it. A `replace` would destroy whatever
   * an administrator had written there -- and on a disabled account, the
   * provenance marker with it.
   */
  it('records the reason without destroying what was already there', async () => {
    const { anchor, dn } = await makeAccount('en.note');
    const ldapts = await import('ldapts');
    await admin.modify(dn, [
      new ldapts.Change({
        operation: 'replace',
        modification: new ldapts.Attribute({
          type: 'info',
          values: ['do not delete, owns the payroll share'],
        }),
      }),
    ]);

    await ldapWriteback.setEnabled(config, {
      anchor,
      enabled: false,
      reason: 'deactivated by an administrator',
    });

    const note = await readNote(dn);
    expect(note).toContain('do not delete, owns the payroll share');
    expect(note).toContain('deactivated by an administrator');
  });

  /**
   * A user row carrying a source but no anchor. The answer is "no such
   * account", not a search for the empty string -- which some servers accept
   * and answer with whatever the first match happens to be.
   */
  it('reports an empty anchor as not found rather than searching for it', async () => {
    for (const anchor of ['', '   ']) {
      expect(
        await ldapWriteback.setEnabled(config, { anchor, enabled: false, reason: 'x' }),
      ).toMatchObject({ failure: 'not_found' });
    }
  });

  it('reports an anchor that names nothing', async () => {
    const result = await ldapWriteback.setEnabled(config, {
      anchor: normaliseAnchor(
        'objectGUID',
        Buffer.from([
          0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
          0x1c, 0x1d, 0x1e, 0x1f, 0x20,
        ]),
      ),
      enabled: false,
      reason: 'x',
    });
    expect(result.failure).toBe('not_found');
  });
});
