import {
  AndFilter,
  Attribute,
  Change,
  Client,
  EqualityFilter,
  FilterParser,
} from 'ldapts';
import type { Filter } from 'ldapts';
import { normaliseAnchor } from '../ldap/anchor.js';
import { RANGE_STEP, readRangedAttribute } from '../ldap/range.js';
import {
  readProvenanceActionId,
  withProvenanceMarker,
  withProvenanceNote,
} from './provenance.js';
import { objectSidRid } from './sid.js';
import { CONNECTOR_ACTION_TYPES } from '../types.js';
import type {
  ConnectionResult,
  ConnectorRight,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteFailure,
  WriteOperation,
  WriteResult,
} from '../types.js';
import {
  adTargetConfigSchema,
  type AdTargetConfig,
  type ResolvedAdTargetConfig,
} from './config.js';
import {
  UAC_NORMAL_DISABLED,
  UAC_NORMAL_ENABLED,
  withDisableBit,
  withoutDisableBit,
} from './uac.js';

type Config = AdTargetConfig & { bindPassword: string };
type Resolved = ResolvedAdTargetConfig & { bindPassword: string };

function normalise(config: Config): Resolved {
  const { bindPassword, ...rest } = config;
  return { ...adTargetConfigSchema.parse(rest), bindPassword };
}

/**
 * One modification, spelled the way `ldapts` actually requires.
 *
 * `Client.modify(dn, changes)` is typed `Change | Change[]`, and
 * `ModifyRequest.writeMessage` calls `change.write(writer)` on every element;
 * `Change.write` then calls `this.modification.write(writer)`. An object
 * literal of the right *shape* therefore throws
 * `TypeError: change.write is not a function` at send time, and the `as never`
 * cast that the plan carried on nine call sites is precisely what stopped the
 * compiler from saying so. One helper, so there is a single place to be right.
 *
 * `Attribute.write` branches on `Buffer.isBuffer(value)`, so a UTF-16LE
 * `unicodePwd` buffer passes through unchanged.
 */
function change(
  operation: 'add' | 'delete' | 'replace',
  type: string,
  values: string[] | Buffer[],
): Change {
  return new Change({
    operation,
    modification: new Attribute({ type, values }),
  });
}

/**
 * Opens a connection, secures it, and binds. StartTLS runs before the bind and
 * that order is not negotiable: the bind carries the password.
 *
 * Unlike the directory-source connector there is no plaintext path at all.
 * Active Directory refuses a password write over an unencrypted connection,
 * and the Samba container the integration tests run against refuses even an
 * ordinary bind without TLS.
 */
async function connect(config: Resolved): Promise<Client> {
  const tlsOptions = { rejectUnauthorized: config.rejectUnauthorized };
  // ldapts treats the mere presence of `tlsOptions` as a request for implicit
  // TLS, independent of the URL scheme, so it is only passed for `ldaps`; a
  // `starttls` connection starts plaintext and takes its options from
  // startTLS() below.
  const client = new Client({
    url: config.url,
    connectTimeout: config.connectTimeoutMs,
    timeout: config.timeoutMs,
    ...(config.tlsMode === 'ldaps' ? { tlsOptions } : {}),
  });
  try {
    if (config.tlsMode === 'starttls') await client.startTLS(tlsOptions);
    await client.bind(config.bindDn, config.bindPassword);
  } catch (cause) {
    // A rejected bind throws without ldapts destroying the socket underneath
    // it, which would otherwise leak a live socket per failed bind.
    await client.unbind().catch(() => undefined);
    throw cause;
  }
  return client;
}

/**
 * Turns an ldapts error into the closed failure set.
 *
 * This classification is the whole reason `failure` is decided by the
 * connector rather than pattern-matched by the run: only here is it known that
 * `busy` is worth another attempt and `entryAlreadyExists` never is.
 */
export function classifyLdapError(cause: unknown): WriteFailure {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();

  // ldapts puts the discriminating signal in `cause.name` -- the class name --
  // and not in the server's diagnostic message, which is why `name` is folded
  // into `text` above. Matching on the message alone misses every one of
  // these.
  if (
    text.includes('alreadyexists') ||
    text.includes('attributeorvalueexists') ||
    text.includes('already in use')
  ) {
    return 'conflict';
  }
  if (text.includes('nosuchattribute')) return 'not_found';
  if (text.includes('invalidcredentials') || text.includes('insufficientaccess'))
    return 'unauthorized';
  if (text.includes('strongauthrequired')) return 'unauthorized';
  if (text.includes('nosuchobject')) return 'not_found';
  if (text.includes('busy') || text.includes('unavailable') || text.includes('timeout'))
    return 'transient';
  if (
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('etimedout')
  )
    return 'transient';
  if (text.includes('adminlimitexceeded')) return 'throttled';
  // A schema violation, a refused password complexity, a constraint violation.
  // None of them become true on the fourth attempt.
  return 'rejected';
}

/**
 * Active Directory requires the password UTF-16LE encoded and wrapped in
 * literal double quotes. This is also why the transport must be encrypted.
 */
export function encodeUnicodePwd(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

/**
 * Escapes a value for an LDAP filter, per RFC 4515.
 *
 * The correlation key reaching `findByCorrelationKey` is produced by
 * `generateCorrelationKey`, whose `[a-z0-9.-]` allow-list already makes an
 * injection impossible today -- but that is a property of a function in
 * another package, enforced by nobody at this boundary. A connector that
 * builds a filter must not depend on a caller two packages away staying
 * careful.
 */
export function escapeFilterValue(value: string): string {
  return [...value]
    .map((character) => {
      switch (character) {
        case '\\':
          return '\\5c';
        case '*':
          return '\\2a';
        case '(':
          return '\\28';
        case ')':
          return '\\29';
        case '\0':
          return '\\00';
        default:
          return character;
      }
    })
    .join('');
}

/**
 * Escapes one RDN *value* for a distinguished name, per RFC 4514.
 *
 * The same argument as `escapeFilterValue`, and the same ruling behind it
 * (P22): a correlation key today is `[a-z0-9.-]`, but that is enforced by a
 * generator in another package and by nothing at this boundary. Assembling
 * `CN=${key},${baseDn}` out of an unescaped value is a DN injection -- a key
 * of `x,OU=Domain Controllers` renders a VALID distinguished name naming a
 * container nobody chose -- and the escape belongs where the DN is assembled,
 * not where the value happened to come from.
 *
 * Deliberately a local copy rather than an import of `@syntra/core`'s
 * `escapeDnValue`: this package sits *below* core in the dependency graph and
 * must not depend on it.
 */
export function escapeDnValue(value: string): string {
  const escaped = [...value]
    .map((character) => {
      if (character === '\0') return '\\00';
      if (',+"\\<>;='.includes(character)) return `\\${character}`;
      return character;
    })
    .join('');
  // A leading `#` or space, or a trailing space, is significant in a DN and
  // has to be escaped even though the character itself is ordinary.
  return escaped.replace(/^([#\s])/, '\\$1').replace(/(\s)$/, '\\$1');
}

/**
 * Splits a DN into its first RDN and the container that holds it.
 *
 * `dn.indexOf(',')` is wrong here and the failure is silent:
 * `CN=Novak\, Anna,OU=X` -- an entirely ordinary Active Directory account, and
 * one Provision meets because it correlates accounts administrators created by
 * hand -- splits at the *escaped* comma and yields the RDN `CN=Novak\`.
 * Archiving that person would then call `modifyDN` with
 * `CN=Novak\,OU=Archive,DC=...`, which names a different object in a different
 * place.
 */
export function splitDn(dn: string): { rdn: string; parent: string } {
  for (let index = 0; index < dn.length; index += 1) {
    if (dn[index] === '\\') {
      index += 1;
      continue;
    }
    if (dn[index] === ',') {
      return { rdn: dn.slice(0, index), parent: dn.slice(index + 1) };
    }
  }
  return { rdn: dn, parent: '' };
}

/**
 * The raw stored bytes of an objectGUID, for a filter that finds one object
 * instead of reading the whole directory.
 *
 * The exact inverse of `normaliseAnchor`: Active Directory stores objectGUID
 * as 16 raw bytes with the first three groups little-endian, and a filter has
 * to match those bytes rather than the rendered string. Returns undefined for
 * anything that is not a 32-hex-digit GUID -- a text `entryUUID`, a fixture
 * anchor -- and the caller falls back to the scan, so this is an optimisation
 * that cannot become a correctness bug.
 *
 * A **Buffer**, and not the RFC 4515 escaped string the plan specified.
 * Measured against the container: a filter built from an object's own bytes,
 * read back from the server moments earlier and escaped `\xx` per octet,
 * returns **zero hits** -- ldapts's filter parser decodes those escapes as
 * text rather than as octets, so the value reaching the wire is not the value
 * that was written. The same bytes handed to `EqualityFilter` return the one
 * object.
 *
 * That mattered more than a misspelling usually does. With the escaped string
 * the fast path never fired at all, every anchor resolution fell through to
 * the subtree scan, and the cost this exists to avoid -- "a 500-action apply
 * performs 500 full directory reads" -- was the only behaviour there was. It
 * was invisible precisely because the fall-through is correct.
 */
export function guidBytes(anchor: string): Buffer | undefined {
  const hex = anchor.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return Buffer.from([
    ...bytes.slice(0, 4).reverse(),
    ...bytes.slice(4, 6).reverse(),
    ...bytes.slice(6, 8).reverse(),
    ...bytes.slice(8, 16),
  ]);
}

/**
 * `(&<accountFilter>(<anchorAttribute>=<bytes>))`, as a Filter object.
 *
 * The configured account filter is parsed rather than concatenated, because
 * the two halves cannot be joined as text once one of them carries raw octets.
 * The conjunction is not decoration: without it a GROUP's objectGUID handed in
 * as an anchor resolves to the group, and an operation aimed at a person lands
 * on an object that is not one.
 */
function anchorFilter(config: Resolved, anchor: string): Filter | undefined {
  const bytes = guidBytes(anchor);
  if (bytes === undefined) return undefined;
  return new AndFilter({
    filters: [
      FilterParser.parseString(config.accountFilter),
      new EqualityFilter({ attribute: config.anchorAttribute, value: bytes }),
    ],
  });
}

/**
 * The first value of an attribute, found case-insensitively.
 *
 * Attribute *names* fold case (RFC 4512) and attribute *values* do not. This
 * is the name side; every value comparison in this module is exact.
 */
export function attributeOf(
  entry: Record<string, unknown>,
  name: string,
): string | undefined {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const value = entry[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? undefined : String(first);
}

function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/** Only what any write path reads. `['*']` pulls every attribute of every user. */
function writeAttributes(config: Resolved): string[] {
  return [
    'dn',
    'userAccountControl',
    'sAMAccountName',
    // The RID of the group Active Directory holds as this account's PRIMARY
    // group. Primary membership is not in the group's `member` attribute, so
    // a revoke against it writes nothing and the directory answers
    // `noSuchAttribute` -- which is otherwise indistinguishable from "this
    // person was not in the group anyway". See the entitlement write path.
    'primaryGroupID',
    config.provenanceAttribute,
    config.anchorAttribute,
  ];
}

async function findByAnchor(
  client: Client,
  config: Resolved,
  anchor: string,
): Promise<{ dn: string; entry: Record<string, unknown> } | undefined> {
  // A scoped filter first. Every non-create write resolves an anchor, so the
  // fallback below is a full subtree read of every user with every attribute,
  // once per action: a 500-action apply performs 500 full directory reads.
  const scoped =
    config.anchorAttribute.toLowerCase() === 'objectguid'
      ? anchorFilter(config, anchor)
      : undefined;
  if (scoped !== undefined) {
    const { searchEntries } = await client.search(config.baseDn, {
      scope: 'sub',
      filter: scoped,
      attributes: writeAttributes(config),
    });
    const raw = searchEntries[0] as unknown as Record<string, unknown> | undefined;
    if (raw) {
      // The same exactness the scan below applies, for the same reason. The
      // filter matches BYTES, and `guidBytes` accepts either hex case, so
      // `A1B2…` and `a1b2…` produce one filter and resolve one object — while
      // the scan, comparing rendered strings, refuses the first. An
      // optimisation that widens what matches is not an optimisation, and the
      // widening is invisible: every other test in this file passes with the
      // fast path accepting a case it should refuse, because every anchor they
      // use came out of `normaliseAnchor` already lowercase.
      const value = raw[config.anchorAttribute];
      const source = Array.isArray(value) ? value[0] : value;
      if (source !== undefined && source !== null) {
        const normalised = normaliseAnchor(
          config.anchorAttribute,
          Buffer.isBuffer(source) ? source : String(source),
        );
        if (normalised === anchor) return { dn: String(raw.dn), entry: raw };
      }
      return undefined;
    }
    // Deliberately falls through rather than returning `not_found`. If the
    // byte ordering above is ever wrong, the scan finds the object anyway and
    // the cost is a slow apply, not a run that reports every account missing.
  }

  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter: config.accountFilter,
    attributes: writeAttributes(config),
    paged: { pageSize: config.pageSize },
  });
  for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
    const value = raw[config.anchorAttribute];
    const source = Array.isArray(value) ? value[0] : value;
    if (source === undefined || source === null) continue;
    const normalised = normaliseAnchor(
      config.anchorAttribute,
      Buffer.isBuffer(source) ? source : String(source),
    );
    // Exact, never case-folded. An anchor is an opaque objectGUID and not a
    // DN: `normaliseAnchor` renders every one of them lowercase, so an anchor
    // arriving in another case did not come out of this system, and refusing
    // to resolve it is the fail-closed reading. Folding here survives every
    // other test in this file, which is why one test exists to pin it.
    if (normalised === anchor) return { dn: String(raw.dn), entry: raw };
  }
  return undefined;
}

async function findByCorrelationKey(
  client: Client,
  config: Resolved,
  correlationKey: string,
): Promise<{ dn: string; entry: Record<string, unknown> } | undefined> {
  // Conjoined with `accountFilter` so the adoption path below is structurally
  // incapable of adopting something that is not an account. Active Directory
  // enforces sAMAccountName uniqueness across every security principal, groups
  // included, so a clashing group is still refused -- by the server, on the
  // add, and classified `conflict` from its own error.
  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter: `(&${config.accountFilter}(sAMAccountName=${escapeFilterValue(correlationKey)}))`,
    attributes: writeAttributes(config),
  });
  const raw = searchEntries[0] as unknown as Record<string, unknown> | undefined;
  return raw ? { dn: String(raw.dn), entry: raw } : undefined;
}

function anchorOf(config: Resolved, entry: Record<string, unknown>): string {
  const value = entry[config.anchorAttribute];
  const source = Array.isArray(value) ? value[0] : value;
  return normaliseAnchor(
    config.anchorAttribute,
    Buffer.isBuffer(source) ? source : String(source ?? ''),
  );
}

async function createAccount(
  client: Client,
  config: Resolved,
  op: Extract<WriteOperation, { op: 'create_account' }>,
): Promise<WriteResult> {
  // The provenance marker makes a non-idempotent create safe to retry. The
  // format lives in ./provenance.ts because `@syntra/core`'s apply loop reads
  // back what this writes, from another package.
  const existing = await findByCorrelationKey(client, config, op.correlationKey);
  if (existing) {
    if (readProvenanceActionId(existing.entry, config.provenanceAttribute) === op.actionId) {
      // Our own previous attempt succeeded and we lost the answer.
      return {
        ok: true,
        message: 'adopted the account this action already created',
        anchor: anchorOf(config, existing.entry),
      };
    }
    // Somebody else's account with our chosen name. Never adopted: anybody
    // able to create an object in the target could otherwise choose a name
    // that causes Syntra to hand them an existing person's account.
    return {
      ok: false,
      message: `an account named ${op.correlationKey} already exists in the target and does not carry this action's provenance marker`,
      failure: 'conflict',
    };
  }

  const dn =
    op.attributes.distinguishedName?.[0] ??
    `CN=${escapeDnValue(op.correlationKey)},${config.baseDn}`;

  // What an account profile's attribute templates asked for, less the keys
  // this function owns. `op.attributes` used to be spread LAST, over all four
  // of them, which is a template winning an argument it should not have been
  // in:
  //
  // - `distinguishedName` is the DN, not an attribute, and is applied above.
  // - `userAccountControl` is the disabled bit that makes step 1 safe. A
  //   template setting it enables an account whose password has not been
  //   written yet, which is the exact window the two-step create exists to
  //   close.
  // - `sAMAccountName` is the correlation key every later lookup resolves
  //   this object by, including the adoption path at the top of this function.
  // - the provenance attribute is MERGED rather than dropped, below.
  const owned = new Set(
    ['distinguishedName', 'userAccountControl', 'sAMAccountName', config.provenanceAttribute].map(
      (key) => key.toLowerCase(),
    ),
  );
  const templated = Object.entries(op.attributes).filter(
    ([key]) => !owned.has(key.toLowerCase()),
  );
  const templatedProvenance = Object.entries(op.attributes)
    .filter(([key]) => key.toLowerCase() === config.provenanceAttribute.toLowerCase())
    .flatMap(([, values]) => (Array.isArray(values) ? values : [values]))
    .join('\n');

  try {
    // Step 1: add the object, disabled. An account that exists and is enabled
    // before its password is set is a window nobody asked for.
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: op.correlationKey,
      userAccountControl: String(UAC_NORMAL_DISABLED),
      ...Object.fromEntries(templated),
      // Last, and merged with whatever a template wanted in the same
      // attribute rather than either side winning. A target whose template
      // writes `info` used to overwrite the marker outright; one failed
      // password write afterwards then made the create a permanent
      // `conflict`, because nothing could recognise the object as ours.
      [config.provenanceAttribute]: withProvenanceMarker(
        templatedProvenance === '' ? undefined : templatedProvenance,
        op.actionId,
      ),
    });
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      failure: classifyLdapError(cause),
    };
  }

  const found = await findByCorrelationKey(client, config, op.correlationKey);
  const anchor = found ? anchorOf(config, found.entry) : undefined;

  try {
    // Step 2: the password, UTF-16LE and quote-wrapped. This is why the
    // transport must be encrypted.
    //
    // `op.initialPassword`, never one generated here. A password invented
    // inside the connector is written to the directory and then dropped:
    // nothing carries it back out, so it can never be sealed into the vault or
    // delivered, and no account Provision creates is usable by the person it
    // was created for. The caller owns it (Task 14).
    await client.modify(
      dn,
      change('replace', 'unicodePwd', [encodeUnicodePwd(op.initialPassword)]),
    );
  } catch (cause) {
    // The account exists and is unusable and disabled, which is the right way
    // round to fail. The next run sees an account carrying this action's
    // provenance marker, adopts it, and proposes the remaining steps.
    return {
      ok: false,
      message: `the account was created but its password could not be set: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      failure: classifyLdapError(cause),
      ...(anchor === undefined ? {} : { anchor }),
    };
  }

  if (op.enabled) {
    try {
      // Step 3, only if the account is meant to be enabled now. A pre-hire
      // stops after step 2 and is enabled on its start date.
      await client.modify(
        dn,
        change('replace', 'userAccountControl', [String(UAC_NORMAL_ENABLED)]),
      );
    } catch (cause) {
      return {
        ok: false,
        message: `the account was created and its password set, but it could not be enabled: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        failure: classifyLdapError(cause),
        ...(anchor === undefined ? {} : { anchor }),
      };
    }
  }

  return {
    ok: true,
    message: `created ${op.correlationKey}`,
    ...(anchor === undefined ? {} : { anchor }),
  };
}

async function setDisableBit(
  client: Client,
  dn: string,
  entry: Record<string, unknown>,
  disabled: boolean,
  extra?: { attribute: string; value: string },
): Promise<void> {
  const current = Number(attributeOf(entry, 'userAccountControl') ?? UAC_NORMAL_ENABLED);
  const next = disabled ? withDisableBit(current) : withoutDisableBit(current);
  const changes = [change('replace', 'userAccountControl', [String(next)])];
  if (extra) changes.push(change('replace', extra.attribute, [extra.value]));
  await client.modify(dn, changes);
}

/**
 * The DN of a group, by objectGUID, with the RID of its objectSid.
 *
 * A paged search of `entitlementSearchBase` per grant or revoke. Deliberately
 * left as a scan where `findByAnchor` was narrowed: the entitlement search base
 * holds groups rather than the whole user population, so this is a much
 * smaller read, and narrowing it needs the same escaped-binary GUID filter
 * with the same fallback. Recorded as a known cost rather than optimised on
 * speculation -- if a domain's group count makes it hurt, the fix is
 * `guidFilterValue` here too, with the scan kept behind it.
 *
 * `objectSid` costs nothing here -- the search is already being made -- and is
 * what lets the caller tell a group that is somebody's PRIMARY group from one
 * that is not. `rid` is undefined when the server returned no usable
 * `objectSid`, which the caller must read as "not established", never as "not
 * the primary group".
 */
async function groupDnFor(
  client: Client,
  config: Resolved,
  externalId: string,
): Promise<{ dn: string; rid: number | undefined } | undefined> {
  const { searchEntries } = await client.search(config.entitlementSearchBase, {
    scope: 'sub',
    filter: config.groupFilter,
    attributes: ['dn', 'objectSid', config.anchorAttribute],
    // A SID is bytes. ldapts decodes an attribute as text whenever the bytes
    // happen to be valid UTF-8, so without this the same group comes back as
    // a Buffer or as a string depending on its own SID.
    explicitBufferAttributes: ['objectSid'],
    paged: { pageSize: config.pageSize },
  });
  for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
    // Exact, for the same reason as `findByAnchor`: an opaque identifier, not
    // a DN.
    if (anchorOf(config, raw) === externalId) {
      return { dn: String(raw.dn), rid: objectSidRid(raw.objectSid) };
    }
  }
  return undefined;
}

/**
 * The RID of the group at `dn`, or undefined if it could not be established.
 *
 * The by-DN counterpart of the lookup above, for `archive_account`, which is
 * handed entitlement DNs rather than external ids. One extra base search, and
 * only on the path where a `delete member` came back `noSuchAttribute` -- so
 * it is paid on the rare ambiguous case and never on the ordinary one.
 */
async function groupRidForDn(client: Client, dn: string): Promise<number | undefined> {
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['objectSid'],
      explicitBufferAttributes: ['objectSid'],
    });
    const raw = searchEntries[0] as unknown as Record<string, unknown> | undefined;
    return raw ? objectSidRid(raw.objectSid) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The RID of the group Active Directory holds as this account's primary one.
 *
 * `primaryGroupID` on the USER, because primary membership is not recorded on
 * the group at all.
 */
export function primaryGroupRid(entry: Record<string, unknown>): number | undefined {
  const raw = attributeOf(entry, 'primaryGroupID');
  if (raw === undefined) return undefined;
  const rid = Number(raw);
  return Number.isInteger(rid) && rid >= 0 ? rid : undefined;
}

/**
 * Whether `groupRid` names this account's primary group, with "cannot tell"
 * as an answer distinct from "no".
 *
 * The three cases are not symmetrical:
 *
 * - The account carries no `primaryGroupID` at all. Then it has no primary
 *   group and no group can be it. `not-primary`, and this is the honest
 *   answer for a directory that has no such concept rather than a guess.
 * - It carries one and the group's RID could not be read. The question is
 *   open, and the caller must refuse rather than assume, because the
 *   assumption that costs something is "no": it is the one that reports a
 *   revoke that did not happen as one that did.
 * - Both are known. Compare them.
 */
export function primaryGroupVerdict(
  entry: Record<string, unknown>,
  groupRid: number | undefined,
): 'primary' | 'not-primary' | 'unknown' {
  const primary = primaryGroupRid(entry);
  if (primary === undefined) return 'not-primary';
  if (groupRid === undefined) return 'unknown';
  return primary === groupRid ? 'primary' : 'not-primary';
}

/**
 * Whether a failed membership write means the membership was already in the
 * state that was asked for.
 *
 * Granting a held entitlement and revoking an unheld one are set operations
 * and therefore successes, not errors. That property is what makes retry free
 * for those two, everywhere.
 *
 * A pure function rather than an inline block, because the discriminating
 * signal is `cause.name` -- the ldapts error CLASS,
 * `AttributeOrValueExistsError` and `NoSuchAttributeError` -- and not the
 * server's diagnostic message, and only a unit test can prove that. Samba
 * happens to put the phrase in the message as well, so an implementation that
 * reads the message alone passes every integration test in this file and then
 * turns both cases into permanent, non-retryable failures against a directory
 * that words its errors differently.
 */
/**
 * Whether the directory refused a membership write without changing anything,
 * as opposed to failing partway or refusing for a reason of its own.
 *
 * The two codes it covers are the two an AD-shaped server answers when the
 * value it was asked to remove is not in `member`:
 *
 * - `noSuchAttribute` (0x10) -- the account was never in the group.
 * - `unwillingToPerform` (0x35) -- measured: what Samba answers for a delete
 *   against the account's PRIMARY group, whose membership is not held in
 *   `member` at all.
 *
 * They are not interchangeable, and the caller distinguishes them. What they
 * share is that the directory is in the state it was in before the write,
 * which is what makes the primary-group question worth asking; an
 * `insufficientAccess` or a dropped connection is an access or a transport
 * problem and must keep saying so.
 */
function refusedWithoutWriting(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();
  return (
    text.includes('nosuchattribute') ||
    text.includes('no such attribute') ||
    text.includes('unwillingtoperform') ||
    text.includes('unwilling to perform')
  );
}

export function isAlreadyInRequestedState(
  op: 'grant_entitlement' | 'revoke_entitlement',
  cause: unknown,
): boolean {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();
  if (op === 'grant_entitlement') {
    return text.includes('attributeorvalueexists') || text.includes('already exists');
  }
  return text.includes('nosuchattribute') || text.includes('no such attribute');
}

/** Every member DN of a group, walking range windows when AD truncates. */
export async function readGroupMembers(
  rawConfig: Config,
  groupDn: string,
): Promise<string[]> {
  const config = normalise(rawConfig);
  const client = await connect(config);
  try {
    // Throws rather than returning what it managed to collect. The caller
    // marks the entitlement `unreadable`, and a rule naming an unreadable
    // entitlement is unresolvable as a whole -- which is loud, where a
    // silently short membership is a mass revocation.
    return await readRangedAttribute(client, groupDn, 'member', {
      pageStep: RANGE_STEP,
    });
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Every value of an attribute, or undefined when the key is not there at all. */
function valuesOf(
  entry: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : toArray(entry[key]);
}

/**
 * Reads one constructed attribute and reports whether it says a right is held.
 *
 * Three outcomes, and the third is the point: a server that does not publish
 * effective rights cannot be read as having granted them.
 *
 * **An absent key is not the signal for that**, which is a measured
 * correction to the plan rather than a preference. ldapts echoes every
 * REQUESTED attribute name back as an empty-valued key whether the server
 * holds it or not -- confirmed against both containers by asking each of them
 * for `notARealAttributeAtAll` and getting the key back -- so the plan's
 * `key === undefined` test never fires, and an OpenLDAP target would have had
 * all four rights reported `denied`: "this bind cannot perform this operation
 * and the first apply that needs it will fail", which is a false statement
 * where `unverified` is a true one.
 *
 * The discriminator is the SCHEMA twin of the same constructed attribute --
 * `allowedChildClasses` beside `allowedChildClassesEffective` -- which
 * describes what the object class permits rather than what this bind may do.
 * Measured:
 *
 * | bind                | schema | effective | verdict      |
 * | ------------------- | -----: | --------: | ------------ |
 * | Samba Administrator |     69 |        69 | `granted`    |
 * | Samba unprivileged  |     69 |         0 | `denied`     |
 * | OpenLDAP admin      |      0 |         0 | `unverified` |
 *
 * An empty schema list means the server does not implement these attributes,
 * so it has said nothing about this right at all.
 */
async function effectiveRight(
  client: Client,
  right: ConnectorRight['right'],
  dn: string | undefined,
  attribute: 'allowedChildClassesEffective' | 'allowedAttributesEffective',
  wanted: string,
  absentDetail: string,
): Promise<ConnectorRight> {
  if (dn === undefined) {
    return { right, status: 'unverified', detail: absentDetail };
  }
  const schemaAttribute = attribute.replace(/Effective$/, '');
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [attribute, schemaAttribute],
    });
    const entry = (searchEntries[0] ?? {}) as Record<string, unknown>;
    const effective = valuesOf(entry, attribute);
    const schema = valuesOf(entry, schemaAttribute);
    if (effective === undefined || schema === undefined || schema.length === 0) {
      return {
        right,
        status: 'unverified',
        detail: `${dn} returned no ${schemaAttribute}, so this server does not publish effective rights and has said nothing about this one`,
      };
    }
    const held = effective.some((value) => value.toLowerCase() === wanted.toLowerCase());
    return {
      right,
      status: held ? 'granted' : 'denied',
      detail: held
        ? `${wanted} is in ${attribute} on ${dn}`
        : `${wanted} is NOT in ${attribute} on ${dn}; this bind cannot perform this operation and the first apply that needs it will fail`,
    };
  } catch (cause) {
    return {
      right,
      status: 'unverified',
      detail: `could not read ${attribute} on ${dn}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}

/**
 * The name of any range-truncated attribute in a response, or undefined.
 *
 * A user in more groups than the server's `MaxValRange` comes back carrying
 * `memberOf;range=0-1499` instead of `memberOf`, and read naively that is a
 * SHORT membership list presented as a complete one. Reconciliation then sees
 * entitlements the account no longer appears to hold, and under-revocation --
 * access outliving the reason for it -- is the failure mode this programme
 * keeps finding wearing a new hat. `SourceRecord.readFailure` exists for
 * exactly this: the record is still returned, still counted as read, and
 * excluded from the diff.
 */
function rangedAttributeIn(entry: Record<string, unknown>): string | undefined {
  return Object.keys(entry).find((key) => /;range=\d+-(\d+|\*)$/i.test(key));
}

export const adTargetConnector: TargetConnector<Config> = {
  async test(rawConfig): Promise<ConnectionResult> {
    const config = normalise(rawConfig);
    let client: Client | undefined;
    try {
      client = await connect(config);
      const accounts = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        attributes: ['dn'],
      });
      const groups = await client.search(config.entitlementSearchBase, {
        scope: 'sub',
        filter: config.groupFilter,
        attributes: ['dn'],
      });

      // Spec section 18: the bind should hold only the rights it needs, and
      // `test` reports which of those it could not exercise, so an
      // over-privileged bind is a visible choice rather than a default.
      //
      // Read, never exercised. Actually performing a create to prove the right
      // would leave a probe object behind, and there is no delete on this
      // connector to remove it -- by design. Active Directory publishes
      // `allowedChildClassesEffective` and `allowedAttributesEffective` as
      // constructed attributes for exactly this question.
      const firstAccount = accounts.searchEntries[0]?.dn;
      const firstGroup = groups.searchEntries[0]?.dn;
      const rights: ConnectorRight[] = [
        await effectiveRight(
          client,
          'createUser',
          config.baseDn,
          'allowedChildClassesEffective',
          'user',
          'no base DN to read',
        ),
        await effectiveRight(
          client,
          'moveUser',
          config.archiveContainer,
          'allowedChildClassesEffective',
          'user',
          'no archive container configured',
        ),
        await effectiveRight(
          client,
          'modifyUser',
          firstAccount === undefined ? undefined : String(firstAccount),
          'allowedAttributesEffective',
          'userAccountControl',
          'this target holds no account yet, so there is nothing to read effective rights from; the first create will be the first test of this right',
        ),
        await effectiveRight(
          client,
          'modifyMembership',
          firstGroup === undefined ? undefined : String(firstGroup),
          'allowedAttributesEffective',
          'member',
          'this target offers no group yet, so there is nothing to read effective rights from',
        ),
      ];

      const notHeld = rights.filter((r) => r.status !== 'granted');
      return {
        ok: true,
        message:
          notHeld.length === 0
            ? `Connected to ${config.url}; all four write rights confirmed`
            : `Connected to ${config.url}; ${notHeld.length} of 4 write rights not confirmed: ${notHeld
                .map((r) => `${r.right} (${r.status})`)
                .join(', ')}`,
        // A SAMPLE, and named one. Both searches are unpaged, so the server
        // caps them at its own size limit: this is an "is anything there"
        // signal for a connection test and nothing else. Ruling P25 -- a
        // denominator the guard consumes has to come from the same read as the
        // actions it describes, and neither of these does.
        sampleCounts: {
          user: accounts.searchEntries.length,
          group: groups.searchEntries.length,
          orgUnit: 0,
        },
        rights,
      };
    } catch (cause) {
      return {
        ok: false,
        message:
          cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Connection failed',
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        sizeLimit: 20,
        attributes: ['*', '+'],
      });
      const objectClasses = new Set<string>();
      const attributes = new Set<string>();
      for (const entry of searchEntries as unknown as Record<string, unknown>[]) {
        for (const cls of toArray(entry.objectClass)) objectClasses.add(cls);
        for (const key of Object.keys(entry)) {
          if (key !== 'dn' && key !== '*' && key !== '+') attributes.add(key);
        }
      }
      return {
        objectClasses: [...objectClasses].sort(),
        attributes: [...attributes].sort(),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *read(rawConfig): AsyncIterable<SourceRecord> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.accountFilter,
        paged: { pageSize: config.pageSize },
        attributes: ['*', config.anchorAttribute],
      });
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const attributes: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (key === 'dn' || key === config.anchorAttribute) continue;
          // `*` and `+` are the REQUEST's wildcards, and ldapts echoes them
          // back as empty-valued keys. Left in, `attributes['*'] = []` reaches
          // reconciliation as an attribute the target holds and Provision does
          // not manage -- a phantom difference on every account, forever.
          if (key === '*' || key === '+') continue;
          attributes[key] = toArray(value);
        }
        const ranged = rangedAttributeIn(raw);
        yield {
          anchor: anchorOf(config, raw),
          objectType: 'user',
          dn: String(raw.dn),
          attributes,
          ...(ranged === undefined
            ? {}
            : {
                readFailure:
                  `the directory returned "${ranged}" instead of the whole attribute, ` +
                  `because it exceeds the server's value-range limit; this account's ` +
                  `record is short and must not be diffed against`,
              }),
        };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *listEntitlements(rawConfig): AsyncIterable<DiscoveredEntitlement> {
    const config = normalise(rawConfig);
    const excluded = new Set(config.primaryGroupExternalIds);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.entitlementSearchBase, {
        scope: 'sub',
        filter: config.groupFilter,
        paged: { pageSize: config.pageSize },
        attributes: ['dn', 'cn', 'description', config.anchorAttribute],
      });
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const externalId = anchorOf(config, raw);
        // Primary group membership is not in `member` and cannot be removed by
        // writing to it, so the primary group is kept out of the catalog
        // entirely rather than being offered and then failing forever.
        if (excluded.has(externalId)) continue;
        const description = attributeOf(raw, 'description');
        yield {
          externalId,
          // The identity is the objectGUID; this is where the group currently
          // lives. Both are needed: a user's `memberOf` is a list of DNs, so
          // without this there is nothing to map a membership onto.
          dn: String(raw.dn),
          type: 'group',
          displayName: attributeOf(raw, 'cn') ?? externalId,
          ...(description === undefined ? {} : { description }),
        };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *listContainers(rawConfig): AsyncIterable<{ dn: string }> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        // Both classes: Active Directory's built-in `CN=Users` is a
        // `container`, not an `organizationalUnit`, and a profile whose
        // fallback points there is a perfectly ordinary configuration.
        filter: '(|(objectClass=organizationalUnit)(objectClass=container))',
        paged: { pageSize: config.pageSize },
        attributes: ['dn'],
      });
      // The search base itself is a valid place to put an account and is not
      // returned by a subtree search for those two classes when it is a
      // domain object, so it is yielded explicitly.
      yield { dn: config.baseDn };
      for (const raw of searchEntries as unknown as Record<string, unknown>[]) {
        const dn = String(raw.dn);
        // A DN comparison, so it folds case -- `OU=x,DC=y` and `ou=X,dc=Y` are
        // one container, and yielding both offers an administrator the same
        // place twice. The opposite of the anchor rule in `findByAnchor`, and
        // for the opposite reason.
        if (dn.toLowerCase() === config.baseDn.toLowerCase()) continue;
        yield { dn };
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async readEntitlementMembers(rawConfig, entitlementDn): Promise<string[]> {
    return readGroupMembers(rawConfig, entitlementDn);
  },

  async write(rawConfig, op): Promise<WriteResult> {
    const config = normalise(rawConfig);

    // Refused BEFORE the bind, before the anchor is resolved, before anything.
    //
    // There is no delete operation to call, and this is what makes that true
    // of the code and not only of the type. With the check further down, an
    // operation this connector does not implement first reached
    // `findByAnchor` -- so `{ op: 'delete_account' }` with no anchor answered
    // `not_found`, which reads as "that object is gone" rather than "this
    // connector will not do that", and a caller could not tell them apart.
    if (!(CONNECTOR_ACTION_TYPES as readonly string[]).includes(op.op)) {
      return {
        ok: false,
        message: `"${String(
          (op as { op: string }).op,
        )}" is not an operation this connector implements; there is no delete of any kind`,
        failure: 'rejected',
      };
    }

    let client: Client | undefined;
    try {
      client = await connect(config);

      if (op.op === 'create_account') {
        return await createAccount(client, config, op);
      }

      const found = await findByAnchor(client, config, op.anchor);
      if (!found) {
        return {
          ok: false,
          message: `no object at anchor ${op.anchor}`,
          failure: 'not_found',
        };
      }

      switch (op.op) {
        case 'update_account': {
          const targetDn = op.attributes.distinguishedName?.[0];
          const rest = Object.entries(op.attributes).filter(
            ([key]) => key !== 'distinguishedName',
          );
          if (rest.length > 0) {
            // The complete managed set, written as `replace`. Receiving the
            // same update twice performs the same write twice and leaves the
            // same result, which is what makes retry free.
            await client.modify(
              found.dn,
              rest.map(([type, values]) => change('replace', type, values)),
            );
          }
          if (targetDn && targetDn.toLowerCase() !== found.dn.toLowerCase()) {
            // ldapts's modifyDN(dn, fullNewDn) takes THE COMPLETE NEW DN as
            // its second argument -- NOT (dn, newRdn, newSuperior). The
            // three-argument call throws
            // `TypeError: control.write is not a function`, because the third
            // positional argument is treated as an LDAP control, which reads
            // as a library bug rather than a signature mistake. Confirmed by
            // hitting it during the Samba spike.
            await client.modifyDN(found.dn, targetDn);
          }
          return { ok: true, message: 'updated' };
        }
        case 'enable_account':
          await setDisableBit(client, found.dn, found.entry, false);
          return { ok: true, message: 'enabled' };
        case 'disable_account':
          // `config.provenanceAttribute`, not the literal `info`, and the
          // reason is MERGED into what the attribute already held rather than
          // replacing it. A `replace` of `info` destroyed whatever an
          // administrator had in Notes and, by default, destroyed the
          // provenance marker with it -- on exactly the accounts a later run
          // may still need to recognise as Syntra's.
          await setDisableBit(client, found.dn, found.entry, true, {
            attribute: config.provenanceAttribute,
            value: withProvenanceNote(
              valuesOf(found.entry, config.provenanceAttribute)?.join('\n'),
              op.reason,
            ),
          });
          return { ok: true, message: 'disabled' };
        case 'archive_account': {
          // Moves the object, strips the entitlements PROVISION MANAGES for
          // it, and leaves the object, its mailbox and its file ownership
          // intact. It does not delete, and there is no code path here that
          // could.
          await setDisableBit(client, found.dn, found.entry, true);

          // `op.entitlementDns`, not `found.entry.memberOf`. Iterating the
          // object's own memberships removes EVERY group it holds, including
          // ones no business rule mentions -- which asserts "Provision manages
          // every group in this target", a claim spec section 12 says is never
          // true. Archive is the closest thing to destructive in the ladder
          // and is the last place to widen a remit.
          for (const groupDn of op.entitlementDns) {
            try {
              await client.modify(groupDn, change('delete', 'member', [found.dn]));
            } catch (cause) {
              const name = cause instanceof Error ? cause.name : '';
              const text = `${name} ${
                cause instanceof Error ? cause.message : String(cause)
              }`.toLowerCase();
              // The same two refusals as the entitlement write path, and the
              // same reasoning. `noSuchAttribute` means the account was never
              // in the group, which for a set operation is a success and is
              // the `continue` below. Its PRIMARY group is not held in
              // `member` either, so a delete against that one also changes
              // nothing -- and continuing past it would move the object to
              // the archive container and report the archive done over an
              // entitlement it did not strip.
              const alreadyGone =
                text.includes('nosuchattribute') || text.includes('no such attribute');
              if (refusedWithoutWriting(cause)) {
                // One extra base search, on the refusal path only, because
                // archive is handed entitlement DNs rather than external ids
                // and so has no RID in hand.
                const verdict = primaryGroupVerdict(
                  found.entry,
                  await groupRidForDn(client, groupDn),
                );
                if (verdict === 'primary') {
                  return {
                    ok: false,
                    message: `the account was disabled, but ${groupDn} is its primary group: that membership is not held in \`member\` and cannot be removed by writing to it, so the account has not been moved to the archive container`,
                    failure: 'rejected',
                  };
                }
                if (alreadyGone && verdict === 'not-primary') continue;
                if (alreadyGone) {
                  return {
                    ok: false,
                    message: `the account was disabled, but the directory refused to remove its membership of ${groupDn} as "no such attribute" and whether that group is its primary group could not be established because the group returned no objectSid, so the account has not been moved to the archive container`,
                    failure: 'transient',
                  };
                }
              }
              // NOT swallowed. `.catch(() => undefined)` here reported a
              // successful archive over an account that still holds the access
              // the archive existed to strip -- and because the action was
              // then recorded applied, nothing ever retried it. Returning
              // before the modifyDN leaves the account disabled and in place,
              // which is a state the next run recognises and repeats.
              return {
                ok: false,
                message: `the account was disabled, but its membership of ${groupDn} could not be removed, so it has not been moved to the archive container: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                failure: classifyLdapError(cause),
              };
            }
          }

          const { rdn } = splitDn(found.dn);
          await client.modifyDN(found.dn, `${rdn},${config.archiveContainer}`);
          return { ok: true, message: 'archived' };
        }
        case 'rename_account': {
          const rdn = `CN=${escapeDnValue(op.correlationKey)}`;
          const { parent } = splitDn(found.dn);
          await client.modify(
            found.dn,
            change('replace', 'sAMAccountName', [op.correlationKey]),
          );
          await client.modifyDN(found.dn, `${rdn},${parent}`);
          return { ok: true, message: 'renamed' };
        }
        case 'grant_entitlement':
        case 'revoke_entitlement': {
          if (config.primaryGroupExternalIds.includes(op.entitlementId)) {
            return {
              ok: false,
              message:
                'this entitlement is the primary group: primary group membership is not held in `member` and cannot be changed by writing to it',
              failure: 'rejected',
            };
          }
          const group = await groupDnFor(client, config, op.entitlementId);
          if (!group) {
            return {
              ok: false,
              message: `no group at ${op.entitlementId}`,
              failure: 'not_found',
            };
          }
          try {
            // A single-value modification, never a replace of the whole
            // attribute: a replace turns a lost race into a mass revocation.
            await client.modify(
              group.dn,
              change(op.op === 'grant_entitlement' ? 'add' : 'delete', 'member', [
                found.dn,
              ]),
            );
          } catch (cause) {
            // Two shapes of refusal, and they mean opposite things.
            //
            // Measured against the Samba AD domain controller this suite runs
            // against, by setting an account's `primaryGroupID` to a group's
            // RID and then asking for both:
            //
            //   revoke of a group the account was never in
            //     -> NoSuchAttributeError, 0x10. The value is not in `member`
            //        and the account does not hold the access. A set
            //        operation, and a success.
            //   revoke of the account's PRIMARY group
            //     -> UnwillingToPerformError, 0x35, "Attribute member already
            //        deleted". Primary membership is not held in `member` at
            //        all -- the directory moves the DN out of `member` the
            //        moment `primaryGroupID` names the group -- so the write
            //        removes nothing and the access survives it.
            //
            // The directory tells them apart itself, which is why this is not
            // the false success the review expected to find: 0x35 is not
            // `isAlreadyInRequestedState`, so the second case already returned
            // ok: false. What it returned was the raw ldapts message, which
            // tells an operator nothing about why the revoke is impossible.
            //
            // The verdict is consulted anyway, and BEFORE the set-operation
            // test, because "which error code did this directory choose" is
            // not what the guarantee should rest on. `primaryGroupID` on the
            // account against the RID of the group's `objectSid` is the fact
            // itself, and it is already in hand: both were read by searches
            // this write had to make regardless.
            //
            // `primaryGroupExternalIds` cannot cover this. It defaults to []
            // and nothing derives it -- but even populated it is a
            // target-wide list, and which group is primary is a property of
            // the ACCOUNT. Two people in one target have two different
            // primary groups.
            //
            // Only consulted for a refusal that changed nothing. An
            // `insufficientAccess` against the primary group is still an
            // access problem and must keep saying so.
            const verdict =
              op.op === 'revoke_entitlement' && refusedWithoutWriting(cause)
                ? primaryGroupVerdict(found.entry, group.rid)
                : 'not-primary';
            if (verdict === 'primary') {
              return {
                ok: false,
                message:
                  "this entitlement is this account's primary group: primary group membership is not held in `member` and cannot be removed by writing to it, so the revoke did not happen. Move the account to a different primary group first, or exclude this group from the catalog with primaryGroupExternalIds",
                failure: 'rejected',
              };
            }
            // A set operation, so the write that finds the membership already
            // as asked is a success. See `isAlreadyInRequestedState` for why
            // that decision is a unit-testable function and not four lines
            // here.
            if (isAlreadyInRequestedState(op.op, cause)) {
              if (verdict === 'unknown') {
                // The account has a primary group and the directory did not
                // return the group's objectSid, so whether this revoke was
                // refused because the access was already gone or because it
                // cannot be removed this way is not established -- and
                // "already in the requested state" is only true with evidence
                // that the state is the one that was wanted. Transient rather
                // than rejected: a readable objectSid is the ordinary case
                // and this is a gap in what was read, not a refusal.
                return {
                  ok: false,
                  message:
                    'the directory refused the revoke as "no such attribute", and whether this entitlement is this account\'s primary group could not be established because the group returned no objectSid; the revoke cannot be reported as done',
                  failure: 'transient',
                };
              }
              return { ok: true, message: 'already in the requested state' };
            }
            return {
              ok: false,
              message:
                cause instanceof Error
                  ? `${cause.name}: ${cause.message}`
                  : String(cause),
              failure: classifyLdapError(cause),
            };
          }
          return {
            ok: true,
            message: op.op === 'grant_entitlement' ? 'granted' : 'revoked',
          };
        }
        default:
          // Unreachable: the guard at the top of `write` refuses anything not
          // in CONNECTOR_ACTION_TYPES before a connection is opened. Kept so
          // that adding a member to the union without handling it here is a
          // compile error rather than a silent fall-through.
          return {
            ok: false,
            message: 'unsupported operation on this connector',
            failure: 'rejected',
          };
      }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        failure: classifyLdapError(cause),
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },
};
