export type ObjectType = 'user' | 'group' | 'orgUnit';

/**
 * One object as the source presented it. Attributes are always arrays because
 * that is what LDAP returns, regardless of what the schema claims about
 * single-valued attributes.
 */
export interface SourceRecord {
  /** Immutable identifier. Never the DN — a DN changes when an object moves. */
  anchor: string;
  objectType: ObjectType;
  dn: string;
  attributes: Record<string, string[]>;
  /** Present on groups: the DNs of members, resolved to anchors by the reader. */
  memberDns?: string[];
  /**
   * Set when the source returned this object but the connector could not read
   * it completely enough to diff against safely — an Active Directory group
   * whose membership came back range-truncated, say.
   *
   * The record is still returned rather than dropped, because the difference
   * between "this object is gone" and "we could not read this object" is the
   * difference between a correct deactivation and a catastrophic one. A reader
   * seeing this must count the record as read, exclude it from the diff, and
   * never treat it as absent.
   */
  readFailure?: string;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<ObjectType, number>;
  /** Which of the rights a target connector needs it could confirm. */
  rights?: ConnectorRight[];
}

export interface SchemaDescriptor {
  objectClasses: string[];
  attributes: string[];
}

/**
 * Every action Provision can propose. There is no delete of any kind, and no
 * type that could become one: `archive_account` moves the object and strips
 * the entitlements Provision manages, and leaves the object, its mailbox and
 * its file ownership intact.
 *
 * The failure mode of this subsystem is *mass* action -- a misconfigured
 * source, an inverted condition, an HR export that ran against an empty
 * staging database. The characteristic accident is not one wrong person, it
 * is four thousand. Every action here therefore has to be one that four
 * thousand instances of can be walked back. Disable satisfies that. Delete
 * does not.
 */
export type ProvisionActionType =
  /**
   * The one action that names an OBJECT rather than a person: it carries a
   * `dn` and a null `personId`.
   *
   * Emitted only for a container an administrator explicitly materialised --
   * Ruling P9 (revised). Provision still never creates a container to satisfy
   * a rendered template, and cannot: the emission path reads an
   * `OrgUnitContainer` row, and the template rungs of the placement ladder
   * hold none.
   */
  | 'create_container'
  | 'create_account'
  | 'update_account'
  | 'enable_account'
  | 'disable_account'
  | 'archive_account'
  | 'rename_account'
  | 'grant_entitlement'
  | 'revoke_entitlement'
  | 'deactivate_syntra_user'
  | 'reactivate_syntra_user';

/** The nine that reach a connector, in the order enforcement applies them. */
export const CONNECTOR_ACTION_TYPES = [
  // First, and not alphabetically: a container has to exist before an account
  // can be created in it or moved into it. An account applied ahead of its
  // container fails, and would fail again on every subsequent run.
  'create_container',
  'create_account',
  'update_account',
  'enable_account',
  'disable_account',
  'archive_account',
  'rename_account',
  'grant_entitlement',
  'revoke_entitlement',
] as const satisfies readonly ProvisionActionType[];

/**
 * The two that call no connector at all. They are writes to Syntra's own
 * directory, and are therefore the only two that apply inside a single
 * transaction with their audit event and need no in-flight resolution.
 */
export const SYNTRA_ONLY_ACTION_TYPES = [
  'deactivate_syntra_user',
  'reactivate_syntra_user',
] as const satisfies readonly ProvisionActionType[];

/**
 * A tagged union rather than a bag of attributes with a mode flag, because
 * the operations a target supports are genuinely different operations.
 *
 * `actionId` is on every operation: it is the id of the ProvisionAction row
 * that proposed this write, and the connector records it on the object it
 * creates wherever the target offers somewhere to put it. That is what makes
 * a non-idempotent create safe to retry.
 *
 * `update_account` carries the COMPLETE set of managed attributes, not a
 * delta. The connector writes desired state, so receiving the same
 * `update_account` twice performs the same write twice and leaves the same
 * result -- which is what makes retry free for the majority of operations.
 *
 * `create_account` carries a correlation key and no anchor, because the
 * anchor does not exist yet; it comes back in the result. Every other
 * operation carries an anchor, because by then it does.
 *
 * `create_account.initialPassword` is supplied by the caller and never
 * invented by the connector. A password the connector generates internally is
 * a password that is written to the directory and then dropped on the floor:
 * nothing carries it back out, so no account Provision creates is usable by
 * the person it was created for, and the target's `initialPasswordPolicy` and
 * `initialPasswordDelivery` settings have nothing behind them. The caller
 * generates it, seals it into the vault and delivers it (Task 14).
 *
 * `archive_account.entitlementDns` is the set Provision manages for that
 * account, resolved by the caller. The connector iterates THAT list, never the
 * object's own `memberOf`: "Provision manages this target" and "Provision
 * manages every group in this target" are different claims and only the first
 * is ever true (spec section 12), and archiving is the closest thing to
 * destructive in the ladder (spec section 9), which is the last place to widen
 * a remit.
 */
export type WriteOperation =
  | {
      op: 'create_container';
      actionId: string;
      /**
       * The container to create, in full. The connector creates THIS and
       * nothing above it: a missing parent is `not_found`, never an
       * invitation to build the tree, which is the implicit creation Ruling
       * P9 forbids.
       */
      dn: string;
    }
  | {
      op: 'create_account';
      actionId: string;
      correlationKey: string;
      attributes: Record<string, string[]>;
      enabled: boolean;
      /** Generated by the caller, never by the connector. Never logged. */
      initialPassword: string;
    }
  | {
      op: 'update_account';
      actionId: string;
      anchor: string;
      attributes: Record<string, string[]>;
    }
  | { op: 'enable_account'; actionId: string; anchor: string }
  | { op: 'disable_account'; actionId: string; anchor: string; reason: string }
  | {
      op: 'archive_account';
      actionId: string;
      anchor: string;
      /** The DNs of the entitlements Provision manages for this account. */
      entitlementDns: string[];
    }
  | {
      op: 'rename_account';
      actionId: string;
      anchor: string;
      correlationKey: string;
    }
  | {
      op: 'grant_entitlement';
      actionId: string;
      anchor: string;
      entitlementId: string;
    }
  | {
      op: 'revoke_entitlement';
      actionId: string;
      anchor: string;
      entitlementId: string;
    };

/**
 * Writing back to the system a user was READ from.
 *
 * Deliberately not part of `WriteOperation`. That union is documented as
 * "every action Provision can propose" and carries a safety argument these
 * operations do not share: every action in it has to be one that four thousand
 * instances of can be walked back, which is why it contains no delete. A
 * password change is one person, initiated by that person, and is not
 * something a misconfigured rule can propose four thousand of. Folding it in
 * would also hand it Provision's retry policy, under which a retried change
 * carrying a stale current password fails identically on every attempt while
 * looking transient.
 *
 * Neither password is ever logged, returned, or included in a message. The
 * failure classification here is deliberately coarse for the same reason: the
 * directory's own diagnostic text for a rejected password can quote policy
 * detail, and it is mapped to one of these before it goes anywhere.
 */
export type WritebackFailure =
  /** The bind as the user was refused: the current password is wrong. */
  | 'wrong_password'
  /** The directory refused the new password: complexity, history, min age. */
  | 'policy'
  /** The bind cannot do this -- rights, or an unencrypted connection. */
  | 'unauthorized'
  /** The anchor resolves to no object, or to more than one. */
  | 'not_found'
  /** This source cannot do this at all. */
  | 'unsupported'
  | 'transient';

export interface WritebackResult {
  ok: boolean;
  /**
   * Safe to show a user and safe to log. Never the directory's raw diagnostic,
   * and never anything derived from either password.
   */
  message: string;
  failure?: WritebackFailure;
}

export interface ChangePasswordInput {
  anchor: string;
  /** Verified by the directory, never by us. */
  currentPassword: string;
  newPassword: string;
}

export interface SetEnabledInput {
  anchor: string;
  enabled: boolean;
  /** Recorded on the object where the target offers somewhere to put it. */
  reason: string;
}

/**
 * A source connector that can write a narrow, closed set of changes back.
 *
 * Separate from `Connector` because most sources cannot do this and should not
 * have to pretend: a source is configured for reading, and write-back is an
 * explicit opt-in with its own rights and its own failure modes.
 */
/**
 * Deleting one directory object, named by its anchor.
 *
 * Deliberately NOT a `ProvisionActionType`, and the distinction is worth
 * stating next to the invariant that forbids one. That invariant is about the
 * PLANNER: actions computed from state, applied in bulk, where the
 * characteristic accident is four thousand objects and not one. Nothing here
 * is computed. A human names a single object and confirms it, which is the
 * same shape as `changePassword` and belongs on the same path.
 *
 * The planner still has no delete and still cannot acquire one.
 */
export interface DeleteObjectInput {
  anchor: string;
}

export interface SourceWriteback<C> {
  changePassword(config: C, input: ChangePasswordInput): Promise<WritebackResult>;
  setEnabled(config: C, input: SetEnabledInput): Promise<WritebackResult>;
  deleteObject(config: C, input: DeleteObjectInput): Promise<WritebackResult>;
}

/**
 * A closed set decided by the connector, not a string the run pattern-matches.
 * Only the connector knows whether an LDAP `busy` or an HTTP 429 is worth
 * another attempt; getting the classification into the connector, where the
 * target-specific knowledge is, is what keeps the retry logic in the run
 * generic.
 */
export type WriteFailure =
  | 'transient'
  | 'throttled'
  | 'conflict'
  | 'rejected'
  | 'unauthorized'
  | 'not_found';

export interface WriteResult {
  ok: boolean;
  message: string;
  /** Present on a successful create: the target's identifier for the object. */
  anchor?: string;
  failure?: WriteFailure;
  /** Honoured on `throttled`, where the target supplies one. */
  retryAfterMs?: number;
}

/**
 * `transient` is retried, `throttled` is retried after `retryAfterMs`, and
 * nothing else is.
 */
export function isRetryable(failure: WriteFailure | undefined): boolean {
  return failure === 'transient' || failure === 'throttled';
}

/**
 * One of the rights the bind needs, and whether `test` could confirm it.
 *
 * Spec section 18: the service account should hold only the rights it needs,
 * and `test` reports which of those it could not exercise, so an
 * over-privileged bind is a visible choice rather than a default.
 *
 * `unverified` is a third state and not a polite `granted`. A server that does
 * not publish effective rights cannot be read as having granted them, and
 * collapsing the two would turn "we could not tell" into "yes".
 */
export interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

/** The grantable things a target offers. */
export interface DiscoveredEntitlement {
  /** The target's immutable identifier. Never the display name. */
  externalId: string;
  /**
   * The target's distinguished name for this object, as read.
   *
   * Not the identity -- `externalId` is, and a rename changes this and not
   * that. It is here because Active Directory reports a user's memberships as
   * a list of DNs and never as objectGUIDs, so without it there is no way to
   * turn a membership list back into entitlement ids, and every lookup misses
   * in a way no test notices.
   */
  dn: string;
  type: 'group' | 'licence' | 'role';
  displayName: string;
  description?: string;
}

export interface Connector<C> {
  test(config: C): Promise<ConnectionResult>;
  discoverSchema(config: C): Promise<SchemaDescriptor>;
  read(config: C): AsyncIterable<SourceRecord>;
  write(config: C, op: WriteOperation): Promise<WriteResult>;
}

/**
 * A target connector is a Connector plus one member.
 *
 * `read` is not a leftover here. It is how Provision learns what the target
 * currently holds, which is the input to reconciliation: the same paged,
 * anchor-normalising reader Directory Sync uses to pull Active Directory in
 * is what Provision uses to ask the target what it thinks is true. A target
 * connector that could only write would have no way to converge.
 */
export interface TargetConnector<C> extends Connector<C> {
  /** The grantable things this target offers: groups, licences, roles. */
  listEntitlements(config: C): AsyncIterable<DiscoveredEntitlement>;

  /**
   * The containers this target holds -- organizational units and containers --
   * so that an account can be placed only where something already exists.
   *
   * Read, never inferred. Deriving the set from the DNs of the accounts the
   * target returned makes an empty-but-real container invisible, and on a
   * first run against an empty target makes EVERY container invisible: every
   * person becomes `container_missing`, the run proposes nothing, and the
   * container can never become visible because no account can ever be created
   * in it. That is a deadlock wearing a safety argument.
   *
   * The check must not skip itself when the set comes back empty either. Spec
   * section 6 is explicit that silently creating organizational units in
   * somebody else's domain is not a thing this product does, and a check that
   * disables itself on the one input that should trigger it is a fail-open on
   * exactly that (Ruling P9). An empty set from a reachable target means the
   * target genuinely has no containers, and that is a configuration error
   * somebody needs to be told about by name.
   */
  listContainers(config: C): AsyncIterable<{ dn: string }>;

  /**
   * Every member of one entitlement, in full, or a throw.
   *
   * **Never a partial list.** Half a membership read as a whole one is the
   * single most dangerous value in this subsystem: a group with 4,000 members
   * that reads as 1,500 makes the diff propose granting it to 2,500 people or
   * revoking it from them, depending on which way the rules fall. Active
   * Directory truncates above `MaxValRange` and the walk that completes it can
   * fail partway, so the contract here is all or an exception -- and the run
   * marks the entitlement `unreadable`, which makes every rule naming it
   * unresolvable rather than silently narrower.
   *
   * On the interface rather than as a loose export because the run has to call
   * it through whatever connector it was handed, and a check the fake cannot
   * exercise is a check nothing tests.
   */
  readEntitlementMembers(config: C, entitlementDn: string): Promise<string[]>;
}

/**
 * First value of an attribute, matched case-insensitively because LDAP
 * attribute names are case-insensitive and servers differ on what they return.
 */
export function first(
  record: SourceRecord,
  attribute: string,
): string | undefined {
  const wanted = attribute.toLowerCase();
  for (const [key, values] of Object.entries(record.attributes)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}
