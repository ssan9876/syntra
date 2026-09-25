export interface ConnectorCapabilities {
  available: boolean;
  readBack: boolean;
  createAccount: boolean;
  updateAccount: boolean;
  disableAccount: boolean;
  manageEntitlements: boolean;
}

const unavailable: ConnectorCapabilities = {
  available: false,
  readBack: false,
  createAccount: false,
  updateAccount: false,
  disableAccount: false,
  manageEntitlements: false,
};

const capabilities: Record<string, ConnectorCapabilities> = {
  activeDirectory: {
    available: true,
    readBack: true,
    createAccount: true,
    updateAccount: true,
    disableAccount: true,
    manageEntitlements: true,
  },
  scim2: {
    available: true,
    readBack: true,
    createAccount: true,
    updateAccount: true,
    disableAccount: true,
    // Group membership by PATCH on `members`, read back from the group, and
    // certified by the shared lifecycle runner. The flag said `false` while it
    // was display-only; once capability enforcement made it a gate, that stale
    // value refused every SCIM grant that had worked the day before.
    manageEntitlements: true,
  },
  /**
   * The ceiling for a document-driven target, not a promise about any one
   * document. `capabilitiesForTarget` below reads the document itself.
   */
  httpJson: {
    available: true,
    readBack: true,
    createAccount: true,
    updateAccount: true,
    disableAccount: true,
    manageEntitlements: true,
  },
  /** The native Graph connector: `entra/capabilities.ts` has the full matrix. */
  entraId: {
    available: true,
    readBack: true,
    createAccount: true,
    updateAccount: true,
    disableAccount: true,
    manageEntitlements: true,
  },
  microsoft365: unavailable,
};

export function targetConnectorCapabilities(type: string): ConnectorCapabilities {
  return capabilities[type] ?? unavailable;
}

/**
 * Whether a created account's initial password must be changed at first
 * sign-in, and who decides.
 *
 *   configurable  the connector honours `create_account.requirePasswordChange`
 *                 (Active Directory, by `pwdLastSet = 0`)
 *   always        the connector forces it and cannot be told otherwise
 *                 (Entra ID's `forceChangePasswordNextSignIn: true`)
 *   unsupported   nothing Syntra writes makes the target ask; whatever the
 *                 target does on its own is its business
 *
 * Deliberately NOT a field on `ConnectorCapabilities`. Those are booleans the
 * adapter lifecycle certifies and the console renders as a yes/no grid; this
 * is a three-way answer about one detail of one operation, and the only
 * readers are the account profile form and the wording of the pickup email --
 * which must not tell somebody they will be asked to choose a new password
 * when nothing is going to ask them.
 *
 * `httpJson` reads as unsupported even for a document that sets such a flag
 * in its create body: the document is administrator-editable, and promising a
 * forced change on the strength of a field somebody could delete is the
 * promise this function exists to stop being made.
 */
export type FirstSignInPasswordChange = 'configurable' | 'always' | 'unsupported';

export function firstSignInPasswordChange(type: string): FirstSignInPasswordChange {
  if (type === 'activeDirectory') return 'configurable';
  if (type === 'entraId') return 'always';
  return 'unsupported';
}

/** Whether a create on this target, under this profile setting, forces a change. */
export function passwordChangeForcedAtFirstSignIn(
  type: string,
  profileRequires: boolean,
): boolean {
  const support = firstSignInPasswordChange(type);
  return support === 'always' || (support === 'configurable' && profileRequires);
}

/** The attribute names `observedEnabled` reads an enabled state from. */
const ENABLED_SPELLINGS = new Set(['active', 'enabled', 'accountenabled']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What THIS target can do, given its configuration.
 *
 * For every hand-written connector the answer is the static table above. For
 * `httpJson` it is whatever the document actually declares: a document with
 * no `account.create` cannot create anybody, and reporting the ceiling for
 * the connector family would have the console promise a capability the first
 * run discovers is missing. Read-back needs `entitlement.members`, because
 * without it `readEntitlementMembers` throws and `readBackTarget` reports
 * every read incomplete.
 */
export function capabilitiesForTarget(type: string, config: unknown): ConnectorCapabilities {
  const base = targetConnectorCapabilities(type);
  if (type !== 'httpJson') return base;
  const document = isObject(config) ? config.document : undefined;
  if (!isObject(document)) return { ...unavailable, available: base.available };
  const account = isObject(document.account) ? document.account : {};
  const entitlement = isObject(document.entitlement) ? document.entitlement : {};
  // Read-back is complete when every entitlement's membership can be read AND
  // the account's enabled state is observable. A document with no
  // entitlements at all has nothing to read incompletely, so it needs only
  // the second -- a field mapped to one of the spellings `observedEnabled`
  // understands.
  const fields = isObject(account.fields) ? Object.values(account.fields) : [];
  const enabledObservable = fields.some(
    (name) => typeof name === 'string' && ENABLED_SPELLINGS.has(name.toLowerCase()),
  );
  return {
    available: true,
    readBack: isObject(document.entitlement)
      ? isObject(entitlement.members)
      : enabledObservable,
    createAccount:
      isObject(account.create) &&
      typeof account.correlationAt === 'string' &&
      isObject(account.provenance),
    updateAccount: isObject(account.update),
    disableAccount: isObject(account.disable) || isObject(account.enable),
    manageEntitlements: isObject(entitlement.grant) || isObject(entitlement.revoke),
  };
}
