import type { TargetConnectorType } from './registry.js';

export type ConnectorSupportState = 'supported' | 'preview' | 'deprecated' | 'unavailable';
export type ConnectorRollout = 'general' | 'controlled' | 'disabled';
export type ConnectorCertificationStatus = 'passed' | 'partial' | 'failed' | 'not-run';

export interface ConnectorLifecycleMetadata {
  type: string;
  displayName: string;
  adapterVersion: string;
  connectorApiVersion: number;
  supportState: ConnectorSupportState;
  rollout: ConnectorRollout;
  deprecationDate: string | null;
  certification: {
    contractVersion: number;
    status: ConnectorCertificationStatus;
    verifiedAt: string | null;
    evidence: string;
  };
}

const CONTRACT_VERSION = 1;
const VERIFIED_AT = '2026-09-23';

const metadata = {
  activeDirectory: {
    type: 'activeDirectory',
    displayName: 'Active Directory',
    adapterVersion: '1.0.0',
    connectorApiVersion: 1,
    supportState: 'supported',
    rollout: 'general',
    deprecationDate: null,
    certification: {
      contractVersion: CONTRACT_VERSION,
      status: 'passed',
      verifiedAt: VERIFIED_AT,
      evidence: 'Shared contract against disposable Samba infrastructure',
    },
  },
  scim2: {
    type: 'scim2',
    displayName: 'SCIM 2.0',
    adapterVersion: '1.0.0',
    connectorApiVersion: 1,
    supportState: 'supported',
    rollout: 'general',
    deprecationDate: null,
    certification: {
      contractVersion: CONTRACT_VERSION,
      status: 'passed',
      verifiedAt: VERIFIED_AT,
      evidence: 'Shared contract against the disposable SCIM service',
    },
  },
  httpJson: {
    type: 'httpJson',
    displayName: 'Document-driven HTTP',
    adapterVersion: '1.0.0',
    connectorApiVersion: 1,
    supportState: 'preview',
    rollout: 'controlled',
    deprecationDate: null,
    certification: {
      contractVersion: CONTRACT_VERSION,
      status: 'passed',
      verifiedAt: VERIFIED_AT,
      evidence: 'Shared contract with correlation and provenance read-back enforced',
    },
  },
  entraId: {
    type: 'entraId',
    displayName: 'Microsoft Entra ID',
    adapterVersion: '1.0.0',
    connectorApiVersion: 1,
    supportState: 'preview',
    rollout: 'controlled',
    deprecationDate: null,
    certification: {
      contractVersion: CONTRACT_VERSION,
      status: 'partial',
      verifiedAt: VERIFIED_AT,
      evidence: 'Shared fake-Graph contract passed; direct-group tenant evidence remains required',
    },
  },
} as const satisfies Record<TargetConnectorType, ConnectorLifecycleMetadata>;

const unavailable = (type: string): ConnectorLifecycleMetadata => ({
  type,
  displayName: type,
  adapterVersion: '0.0.0',
  connectorApiVersion: 1,
  supportState: 'unavailable',
  rollout: 'disabled',
  deprecationDate: null,
  certification: {
    contractVersion: CONTRACT_VERSION,
    status: 'not-run',
    verifiedAt: null,
    evidence: 'No registered connector adapter',
  },
});

export function connectorLifecycleMetadata(type: string): ConnectorLifecycleMetadata {
  return type in metadata
    ? metadata[type as TargetConnectorType]
    : unavailable(type);
}

export function connectorLifecycleCatalog(): ConnectorLifecycleMetadata[] {
  return Object.values(metadata);
}
