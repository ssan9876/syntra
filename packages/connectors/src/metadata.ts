import type { TargetConnectorType } from './registry.js';
import { CONNECTOR_ACTION_TYPES } from './types.js';
import type { ConnectorCapabilities } from './capabilities.js';

export type ConnectorSupportState = 'supported' | 'preview' | 'deprecated' | 'unavailable';
export type ConnectorRollout = 'general' | 'controlled' | 'disabled';
export type ConnectorCertificationStatus = 'passed' | 'partial' | 'failed' | 'not-run';

/**
 * The unit a certification speaks about: one connector WRITE. Exactly the
 * action types that reach a connector (`CONNECTOR_ACTION_TYPES`) and nothing
 * else -- the two Syntra-only actions touch no adapter and are never subject
 * to adapter certification.
 */
export type ConnectorCapability = (typeof CONNECTOR_ACTION_TYPES)[number];
export const CONNECTOR_CAPABILITIES: readonly ConnectorCapability[] = CONNECTOR_ACTION_TYPES;

export function isConnectorCapability(value: string): value is ConnectorCapability {
  return (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Which rollout lane a release is offered on.
 *
 * `stable` is what every target runs unless somebody chose otherwise; the
 * newest stable release is the default. `canary` is offered only to targets
 * an administrator explicitly moved to the canary channel, which is how a new
 * adapter version is tried on selected targets before it becomes the default
 * everywhere.
 */
export type ConnectorReleaseChannel = 'stable' | 'canary';

/**
 * One adapter release, as the catalog records it.
 *
 * `certification.capabilities` is the load-bearing field: the exact writes
 * this EXACT version was certified to perform, by the shared contract runner
 * (`testing/target-connector-certification.ts`) plus the adapter's own
 * fixture suites named in `evidence`. A capability absent from the list is
 * uncertified for this version, and the provisioning engine refuses to plan
 * or apply it -- a release certified for `create_account` at 1.0.0 says
 * nothing about 1.1.0, and inheriting the claim silently is exactly the drift
 * this record exists to prevent.
 */
export interface ConnectorAdapterRelease {
  adapterVersion: string;
  connectorApiVersion: number;
  channel: ConnectorReleaseChannel;
  supportState: ConnectorSupportState;
  rollout: ConnectorRollout;
  /** ISO date (a UTC day). From that day on, new writes need an audited override. */
  deprecationDate: string | null;
  certification: {
    contractVersion: number;
    status: ConnectorCertificationStatus;
    verifiedAt: string | null;
    evidence: string;
    capabilities: readonly ConnectorCapability[];
  };
}

/**
 * The record for a connector TYPE: its default stable release's fields at
 * the top level (what every existing reader already renders), plus every
 * release the catalog knows about.
 */
export interface ConnectorLifecycleMetadata extends ConnectorAdapterRelease {
  type: string;
  displayName: string;
  releases: readonly ConnectorAdapterRelease[];
}

const CONTRACT_VERSION = 1;
const VERIFIED_AT = '2026-09-23';

/** Every write the account-and-entitlement contract and fixture suites cover. */
const ACCOUNT_AND_ENTITLEMENT_WRITES: readonly ConnectorCapability[] = [
  'create_account',
  'update_account',
  'rename_account',
  'enable_account',
  'disable_account',
  'archive_account',
  'grant_entitlement',
  'revoke_entitlement',
];

interface TypeRecord {
  type: TargetConnectorType;
  displayName: string;
  releases: readonly ConnectorAdapterRelease[];
}

const catalog = {
  activeDirectory: {
    type: 'activeDirectory',
    displayName: 'Active Directory',
    releases: [
      {
        adapterVersion: '1.0.0',
        connectorApiVersion: 1,
        channel: 'stable',
        supportState: 'supported',
        rollout: 'general',
        deprecationDate: null,
        certification: {
          contractVersion: CONTRACT_VERSION,
          status: 'passed',
          verifiedAt: VERIFIED_AT,
          evidence: 'Shared contract against disposable Samba infrastructure',
          // The only adapter with containers: an org unit is materialised as
          // an OU, and the Samba integration suite creates, renames, enables
          // and archives against real infrastructure.
          capabilities: ['create_container', ...ACCOUNT_AND_ENTITLEMENT_WRITES],
        },
      },
    ],
  },
  scim2: {
    type: 'scim2',
    displayName: 'SCIM 2.0',
    releases: [
      {
        adapterVersion: '1.0.0',
        connectorApiVersion: 1,
        channel: 'stable',
        supportState: 'supported',
        rollout: 'general',
        deprecationDate: null,
        certification: {
          contractVersion: CONTRACT_VERSION,
          status: 'passed',
          verifiedAt: VERIFIED_AT,
          evidence: 'Shared contract against the disposable SCIM service',
          capabilities: ACCOUNT_AND_ENTITLEMENT_WRITES,
        },
      },
    ],
  },
  httpJson: {
    type: 'httpJson',
    displayName: 'Document-driven HTTP',
    releases: [
      {
        adapterVersion: '1.0.0',
        connectorApiVersion: 1,
        channel: 'stable',
        supportState: 'preview',
        rollout: 'controlled',
        deprecationDate: null,
        certification: {
          contractVersion: CONTRACT_VERSION,
          status: 'passed',
          verifiedAt: VERIFIED_AT,
          evidence: 'Shared contract with correlation and provenance read-back enforced',
          capabilities: ACCOUNT_AND_ENTITLEMENT_WRITES,
        },
      },
    ],
  },
  entraId: {
    type: 'entraId',
    displayName: 'Microsoft Entra ID',
    releases: [
      {
        adapterVersion: '1.0.0',
        connectorApiVersion: 1,
        channel: 'stable',
        supportState: 'preview',
        rollout: 'controlled',
        deprecationDate: null,
        certification: {
          contractVersion: CONTRACT_VERSION,
          status: 'partial',
          verifiedAt: VERIFIED_AT,
          evidence: 'Shared fake-Graph contract passed; direct-group tenant evidence remains required',
          capabilities: ACCOUNT_AND_ENTITLEMENT_WRITES,
        },
      },
    ],
  },
} as const satisfies Record<TargetConnectorType, TypeRecord>;

/** Numeric `major.minor.patch` comparison; the catalog holds only that shape. */
export function compareAdapterVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const newest = (
  releases: readonly ConnectorAdapterRelease[],
): ConnectorAdapterRelease | undefined =>
  [...releases].sort((x, y) => compareAdapterVersions(y.adapterVersion, x.adapterVersion))[0];

const unavailableRelease: ConnectorAdapterRelease = {
  adapterVersion: '0.0.0',
  connectorApiVersion: 1,
  channel: 'stable',
  supportState: 'unavailable',
  rollout: 'disabled',
  deprecationDate: null,
  certification: {
    contractVersion: CONTRACT_VERSION,
    status: 'not-run',
    verifiedAt: null,
    evidence: 'No registered connector adapter',
    capabilities: [],
  },
};

/** Build a type record from its releases; exported so tests can make catalogs. */
export function connectorMetadataFromReleases(record: {
  type: string;
  displayName: string;
  releases: readonly ConnectorAdapterRelease[];
}): ConnectorLifecycleMetadata {
  const stable =
    newest(record.releases.filter((r) => r.channel === 'stable')) ?? unavailableRelease;
  return { ...stable, type: record.type, displayName: record.displayName, releases: record.releases };
}

export function connectorLifecycleMetadata(type: string): ConnectorLifecycleMetadata {
  return type in catalog
    ? connectorMetadataFromReleases(catalog[type as TargetConnectorType])
    : { ...unavailableRelease, type, displayName: type, releases: [] };
}

export function connectorLifecycleCatalog(): ConnectorLifecycleMetadata[] {
  return Object.values(catalog).map(connectorMetadataFromReleases);
}

/**
 * The catalog as a lookup, so the engine and its tests can be handed a
 * different one. Production always uses `connectorLifecycleMetadata`; a test
 * that needs a canary release the shipped catalog does not have supplies its
 * own, rather than the shipped record being bent to fit a test.
 */
export type ConnectorReleaseCatalog = (type: string) => ConnectorLifecycleMetadata;
export const defaultConnectorReleaseCatalog: ConnectorReleaseCatalog = connectorLifecycleMetadata;

/** A target's stored choice: channel, and an optional exact pin. */
export interface AdapterSelection {
  adapterChannel: string;
  adapterVersionPin: string | null;
}

export interface ResolvedAdapterRelease {
  release: ConnectorAdapterRelease;
  /** Why this release: an exact pin, the canary channel, or the stable default. */
  source: 'pin' | 'canary' | 'stable';
}

export class AdapterReleaseNotFoundError extends Error {
  constructor(
    readonly type: string,
    readonly adapterVersion: string,
  ) {
    super(
      `the connector catalog has no ${type} adapter release ${adapterVersion}; this build cannot run it`,
    );
    this.name = 'AdapterReleaseNotFoundError';
  }
}

/**
 * Which release a target runs, from its stored selection.
 *
 * An exact pin wins. Otherwise the canary channel gets the newest canary
 * release, falling back to the stable default when there is none, so a
 * canary target is never left without an adapter. A pin naming a version
 * this build's catalog does not hold is a refusal, never a silent fallback:
 * the operator pinned it for a reason, and running something else under
 * their pin is the one outcome they did not choose.
 */
export function resolveAdapterRelease(
  type: string,
  selection: AdapterSelection,
  catalogLookup: ConnectorReleaseCatalog = defaultConnectorReleaseCatalog,
): ResolvedAdapterRelease {
  const metadata = catalogLookup(type);
  if (selection.adapterVersionPin !== null) {
    const pinned = metadata.releases.find(
      (r) => r.adapterVersion === selection.adapterVersionPin,
    );
    if (!pinned) throw new AdapterReleaseNotFoundError(type, selection.adapterVersionPin);
    return { release: pinned, source: 'pin' };
  }
  if (selection.adapterChannel === 'canary') {
    const canary = newest(
      metadata.releases.filter((r) => r.channel === 'canary' && r.supportState !== 'unavailable'),
    );
    if (canary) return { release: canary, source: 'canary' };
  }
  const { type: _type, displayName: _displayName, releases: _releases, ...stable } = metadata;
  return { release: stable, source: 'stable' };
}

/**
 * Whether a release carries certification evidence at all. A failed or
 * never-run certification certifies nothing, whatever its capability list
 * says.
 */
export function releaseIsCertified(release: ConnectorAdapterRelease): boolean {
  return release.certification.status === 'passed' || release.certification.status === 'partial';
}

/**
 * The flag a TARGET'S configuration must advertise for each write.
 *
 * `capabilitiesForTarget` reports coarse flags; certification speaks per
 * action. Rename is an attribute write like update; enable, disable and
 * archive are the account-state family; a container is only ever created to
 * place an account in it.
 */
export const ADVERTISED_FLAG_FOR: Record<ConnectorCapability, keyof ConnectorCapabilities> = {
  create_container: 'createAccount',
  create_account: 'createAccount',
  update_account: 'updateAccount',
  rename_account: 'updateAccount',
  enable_account: 'disableAccount',
  disable_account: 'disableAccount',
  archive_account: 'disableAccount',
  grant_entitlement: 'manageEntitlements',
  revoke_entitlement: 'manageEntitlements',
};

export const CAPABILITY_LABEL: Record<ConnectorCapability, string> = {
  create_container: 'create containers',
  create_account: 'create accounts',
  update_account: 'update accounts',
  rename_account: 'rename accounts',
  enable_account: 'enable accounts',
  disable_account: 'disable accounts',
  archive_account: 'archive accounts',
  grant_entitlement: 'grant entitlements',
  revoke_entitlement: 'revoke entitlements',
};

/**
 * Why a write may not be performed through this release against this
 * configuration, or null when it may. Both conditions must hold: the exact
 * release is certified for the write, AND the target's configuration
 * advertises it. Worded for an operator reading a run.
 */
export function capabilityRefusalReason(
  type: string,
  release: ConnectorAdapterRelease,
  advertised: ConnectorCapabilities,
  capability: ConnectorCapability,
): string | null {
  const label = CAPABILITY_LABEL[capability];
  if (!releaseIsCertified(release)) {
    return `refused: ${type} adapter ${release.adapterVersion} has no passing certification (${release.certification.status}), so it may not ${label}`;
  }
  if (!release.certification.capabilities.includes(capability)) {
    return `refused: ${type} adapter ${release.adapterVersion} is not certified to ${label}`;
  }
  if (!advertised.available || !advertised[ADVERTISED_FLAG_FOR[capability]]) {
    return `refused: this target's configuration does not advertise the ability to ${label}`;
  }
  return null;
}

/** Whether a release is past its deprecation date on `now` (UTC days). */
export function releasePastDeprecation(release: ConnectorAdapterRelease, now: Date): boolean {
  if (release.deprecationDate === null) return false;
  return now.getTime() >= new Date(`${release.deprecationDate}T00:00:00Z`).getTime();
}

/**
 * Readiness warnings for a release: deprecated, past deprecation, or not
 * fully certified. Warnings rather than refusals -- the refusals are made per
 * write, where they can be recorded against the action they stop.
 */
export function releaseReadinessWarnings(
  type: string,
  release: ConnectorAdapterRelease,
  now: Date,
): string[] {
  const warnings: string[] = [];
  if (releasePastDeprecation(release, now)) {
    warnings.push(
      `${type} adapter ${release.adapterVersion} passed its deprecation date (${release.deprecationDate}); new writes are blocked unless an audited override is active`,
    );
  } else if (release.supportState === 'deprecated' || release.deprecationDate !== null) {
    warnings.push(
      `${type} adapter ${release.adapterVersion} is deprecated${release.deprecationDate ? ` and stops accepting new writes on ${release.deprecationDate}` : ''}`,
    );
  }
  if (!releaseIsCertified(release)) {
    warnings.push(
      `${type} adapter ${release.adapterVersion} is uncertified (${release.certification.status}); every write through it is refused`,
    );
  } else if (release.certification.status === 'partial') {
    warnings.push(
      `${type} adapter ${release.adapterVersion} is only partially certified: ${release.certification.evidence}`,
    );
  }
  return warnings;
}
