import { Attribute, Change, EqualityFilter, type Client } from 'ldapts';
import type {
  ChangePasswordInput,
  SetEnabledInput,
  SourceWriteback,
  WritebackFailure,
  WritebackResult,
} from '../types.js';
import { isEnabled, withDisableBit, withoutDisableBit } from '../ad/uac.js';
import { withProvenanceNote } from '../ad/provenance.js';
import { anchorSearchValue } from './anchor.js';
import { ldapConfigSchema, type LdapConfig } from './config.js';
import { isEncrypted, openBound, type ResolvedLdapConfig } from './connection.js';

type Config = LdapConfig & { bindPassword: string };

function normalise(config: Config): ResolvedLdapConfig {
  const { bindPassword, ...rest } = config;
  return { ...ldapConfigSchema.parse(rest), bindPassword };
}

/**
 * The one place a `Change` is constructed, for the reason `ad/connector.ts`
 * gives at length: ldapts calls `change.write(writer)` at send time, so an
 * object literal of the right *shape* throws `change.write is not a function`
 * from inside the library, and a cast is what stops the compiler saying so.
 *
 * `Attribute.write` branches on `Buffer.isBuffer(value)`, so a UTF-16LE
 * `unicodePwd` buffer passes through unchanged.
 */
function change(
  operation: 'add' | 'delete' | 'replace',
  type: string,
  values: string[] | Buffer[],
): Change {
  return new Change({ operation, modification: new Attribute({ type, values }) });
}

/**
 * Active Directory requires a password UTF-16LE encoded and wrapped in literal
 * double quotes.
 *
 * A local copy of `ad/connector.ts`'s function rather than an import, because
 * that module pulls in the whole target connector -- and this one is reached
 * from the source side. Two lines, one citation, no dependency edge from the
 * source connector to the target connector.
 */
function encodeUnicodePwd(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

/**
 * Turns a directory error into the closed failure set, WITHOUT letting the
 * server's diagnostic text out.
 *
 * The message a directory returns for a refused password can quote the policy
 * it violated and, on some servers, echo part of what was sent. None of it
 * reaches a caller: this returns a classification, and the sentence a user
 * eventually reads is written here, in English, from that classification.
 */
export function classifyWritebackError(cause: unknown): WritebackFailure {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();

  if (text.includes('invalidcredentials')) return 'wrong_password';
  // 0000052D is AD's "password does not meet policy / history / minimum age".
  // It arrives as a constraint violation, which is otherwise a schema problem,
  // so the code is what tells the two apart.
  if (text.includes('0000052d') || text.includes('constraintviolation')) {
    return 'policy';
  }
  if (text.includes('unwillingtoperform')) return 'policy';
  if (text.includes('insufficientaccess') || text.includes('strongauthrequired')) {
    return 'unauthorized';
  }
  if (text.includes('nosuchobject')) return 'not_found';

  // NAMED, because they used to fall through. DNS resolution and TLS
  // verification fail before the directory has read anything, and the list
  // below is what those failures actually look like on Node.
  if (
    text.includes('busy') ||
    text.includes('unavailable') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('econnaborted') ||
    text.includes('etimedout') ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('ehostunreach') ||
    text.includes('enetunreach') ||
    text.includes('epipe') ||
    text.includes('socket hang up') ||
    text.includes('certificate') ||
    text.includes('self-signed') ||
    text.includes('self signed') ||
    text.includes('cert_') ||
    text.includes('depth_zero')
  ) {
    return 'transient';
  }

  // THE DEFAULT IS `transient`, NOT `policy`, and that is the fix.
  //
  // `policy` is a positive claim: the directory examined this password and
  // rejected it on its merits. Nothing unmatched here is evidence of that --
  // DNS and TLS failures matched nothing on the old list, so a user iterating
  // on ever-stronger passwords against an outage was told each one had been
  // refused, and the audit trail recorded `directory_policy` for a directory
  // that was never reached.
  //
  // `password-change.ts` maps this to `directory_unavailable`, whose message
  // invites a retry -- which is the right advice for a fault nobody has
  // classified. Being wrong in that direction costs a retry; being wrong in
  // the other costs somebody their afternoon and buries the real cause.
  return 'transient';
}

const MESSAGE: Record<WritebackFailure, string> = {
  wrong_password: 'the current password is not correct',
  policy: 'the directory refused the new password',
  unauthorized: 'the directory refused the change: the connection lacks the rights to make it',
  not_found: 'the directory holds no account with that anchor',
  unsupported: 'this directory source does not support this change',
  transient: 'the directory could not be reached',
};

const fail = (failure: WritebackFailure): WritebackResult => ({
  ok: false,
  failure,
  message: MESSAGE[failure],
});

interface Located {
  dn: string;
  uac: number | undefined;
  /** Whatever the note attribute already held, so a write can merge into it. */
  note: string | undefined;
}

/**
 * Finds the one object an anchor names.
 *
 * More than one match is `not_found` rather than a pick. Two objects sharing
 * an immutable identifier means something is wrong with the search base or the
 * anchor attribute, and choosing between them would apply a password change or
 * a disable to whichever the server happened to return first.
 */
async function locate(
  client: Client,
  config: ResolvedLdapConfig,
  anchor: string,
): Promise<Located | null> {
  // A user carrying a source but no anchor should not reach here, and if one
  // does, the answer is "no such account" rather than a search for the empty
  // string -- which is a filter the server may accept and answer with
  // something arbitrary.
  if (anchor.trim() === '') return null;

  const { searchEntries } = await client.search(config.userSearchBase, {
    // A programmatic filter, not a string. An objectGUID is sixteen raw
    // bytes, and a filter STRING cannot carry them: ldapts parses the string
    // itself and does not turn RFC 4515 hex escapes back into bytes, so the
    // search is well formed, reaches the server, and matches nothing at all.
    filter: new EqualityFilter({
      attribute: config.anchorAttribute,
      value: anchorSearchValue(anchor) as Buffer,
    }),
    scope: 'sub',
    sizeLimit: 2,
    attributes: ['dn', 'userAccountControl', config.noteAttribute],
  });
  if (searchEntries.length !== 1) return null;

  const entry = searchEntries[0] as unknown as Record<string, unknown>;
  const rawUac = entry.userAccountControl;
  const uacText = Array.isArray(rawUac) ? rawUac[0] : rawUac;
  const uac = Number(uacText);

  const rawNote = entry[config.noteAttribute];
  const note = Array.isArray(rawNote) ? rawNote.join('\n') : rawNote;

  return {
    dn: String(entry.dn),
    uac: uacText === undefined || uacText === '' || !Number.isInteger(uac)
      ? undefined
      : uac,
    note: note === undefined ? undefined : String(note),
  };
}

export const ldapWriteback: SourceWriteback<Config> = {
  /**
   * Changes a password by binding as THE USER and performing the standard
   * change form on their own object:
   *
   *     delete: unicodePwd = "<old>"
   *     add:    unicodePwd = "<new>"
   *
   * Both modifications in ONE modify request, which is what makes Active
   * Directory treat it as a change rather than two edits.
   *
   * The alternative -- bind as the service account and `replace: unicodePwd`
   * -- is the administrative *reset* form, and it requires granting the bind
   * the Reset Password right across the user OU. A service credential with
   * standing reset rights over every user is a full account-takeover
   * primitive: whoever reads that secret out of the vault owns every identity
   * in the OU. Binding as the user grants the service account nothing.
   *
   * Three things follow for free from that choice:
   *
   *   - the current password is verified BY THE DIRECTORY. A refused bind is
   *     the wrong-password answer. This matters because Syntra's local hash
   *     and the directory's password can already have diverged, and verifying
   *     locally would accept a password the domain rejects.
   *   - the domain's own policy applies in full, including password HISTORY.
   *   - minimum password age is enforced. The reset form bypasses it; a
   *     self-service portal should not quietly hand users a way around a
   *     policy the domain sets.
   */
  async changePassword(rawConfig, input: ChangePasswordInput): Promise<WritebackResult> {
    const config = normalise(rawConfig);

    // Before anything is sent. A password over a `plain` connection is a
    // password on the wire in cleartext; Active Directory refuses the write
    // anyway, but refusing here is what stops it being transmitted at all, and
    // a directory that DID accept it would have taken it in the clear and
    // returned success.
    if (!isEncrypted(config)) {
      return {
        ok: false,
        failure: 'unauthorized',
        message:
          'this directory source is configured without TLS, and a password is ' +
          'never sent over an unencrypted connection',
      };
    }

    let service: Client | undefined;
    let located: Located | null;
    try {
      service = await openBound(config, config.bindDn, config.bindPassword);
      located = await locate(service, config, input.anchor);
    } catch (cause) {
      return fail(classifyWritebackError(cause));
    } finally {
      await service?.unbind().catch(() => undefined);
    }
    if (!located) return fail('not_found');

    // The second connection: bound as the user, using the password they typed.
    let asUser: Client | undefined;
    try {
      asUser = await openBound(config, located.dn, input.currentPassword);
    } catch (cause) {
      // A refused bind here means one thing, and it is the common one.
      const failure = classifyWritebackError(cause);
      return fail(failure === 'policy' ? 'wrong_password' : failure);
    }

    try {
      await asUser.modify(located.dn, [
        change('delete', 'unicodePwd', [encodeUnicodePwd(input.currentPassword)]),
        change('add', 'unicodePwd', [encodeUnicodePwd(input.newPassword)]),
      ]);
      return { ok: true, message: 'the password was changed in the directory' };
    } catch (cause) {
      return fail(classifyWritebackError(cause));
    } finally {
      await asUser.unbind().catch(() => undefined);
    }
  },

  /**
   * Sets or clears the account-disabled bit.
   *
   * Read-modify-write on `userAccountControl`, never an assignment of a
   * literal. `514` is "disabled" only for an account that was otherwise
   * exactly `512`; writing it to a user whose password does not expire (66048,
   * entirely ordinary) would silently clear that flag as a side effect of
   * disabling them, and clear it permanently -- re-enabling later restores
   * 512, not 66048.
   *
   * Idempotent in both directions: an account already in the requested state
   * is reported as a success without a write, so a retry costs nothing and a
   * reconciliation loop does not rewrite the same value forever.
   */
  async setEnabled(rawConfig, input: SetEnabledInput): Promise<WritebackResult> {
    const config = normalise(rawConfig);
    let client: Client | undefined;
    try {
      client = await openBound(config, config.bindDn, config.bindPassword);
      const located = await locate(client, config, input.anchor);
      if (!located) return fail('not_found');
      if (located.uac === undefined) {
        return {
          ok: false,
          failure: 'unsupported',
          message:
            'this directory does not report userAccountControl, so an account ' +
            'cannot be enabled or disabled through it',
        };
      }

      if (isEnabled(located.uac) === input.enabled) {
        return {
          ok: true,
          message: `the account was already ${input.enabled ? 'enabled' : 'disabled'}`,
        };
      }

      const next = input.enabled
        ? withoutDisableBit(located.uac)
        : withDisableBit(located.uac);
      // The reason goes where the AD target connector puts it, MERGED into
      // what the attribute already held. A `replace` would destroy whatever an
      // administrator had written in Notes -- and on a disabled account, the
      // provenance marker with it, which is exactly the account a later run
      // may need to recognise as Syntra's.
      //
      // Only when disabling. Re-enabling somebody should not leave a stale
      // "disabled because..." note behind claiming something untrue.
      await client.modify(located.dn, [
        change('replace', 'userAccountControl', [String(next)]),
        ...(input.enabled
          ? []
          : [
              change('replace', config.noteAttribute, [
                withProvenanceNote(located.note, input.reason),
              ]),
            ]),
      ]);
      return {
        ok: true,
        message: `the account was ${input.enabled ? 'enabled' : 'disabled'} in the directory`,
      };
    } catch (cause) {
      return fail(classifyWritebackError(cause));
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },
};
