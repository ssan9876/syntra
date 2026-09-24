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
  return {
    available: true,
    readBack: isObject(entitlement.members),
    createAccount:
      isObject(account.create) &&
      typeof account.correlationAt === 'string' &&
      isObject(account.provenance),
    updateAccount: isObject(account.update),
    disableAccount: isObject(account.disable) || isObject(account.enable),
    manageEntitlements: isObject(entitlement.grant) || isObject(entitlement.revoke),
  };
}
