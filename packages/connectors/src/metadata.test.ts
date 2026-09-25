import { describe, expect, it } from 'vitest';
import { TARGET_CONNECTOR_TYPES, implementedAdapterVersions } from './registry.js';
import { capabilitiesForTarget } from './capabilities.js';
import {
  AdapterReleaseNotFoundError,
  CONNECTOR_CAPABILITIES,
  capabilityRefusalReason,
  connectorLifecycleCatalog,
  connectorLifecycleMetadata,
  connectorMetadataFromReleases,
  releaseReadinessWarnings,
  resolveAdapterRelease,
  type ConnectorAdapterRelease,
} from './metadata.js';

const release = (over: Partial<ConnectorAdapterRelease> = {}): ConnectorAdapterRelease => ({
  adapterVersion: '1.0.0',
  connectorApiVersion: 1,
  channel: 'stable',
  supportState: 'supported',
  rollout: 'general',
  deprecationDate: null,
  certification: {
    contractVersion: 1,
    status: 'passed',
    verifiedAt: '2026-09-23',
    evidence: 'fixture',
    capabilities: CONNECTOR_CAPABILITIES,
  },
  ...over,
});

describe('connector lifecycle metadata', () => {
  it('has one complete, versioned record for every registered adapter', () => {
    expect(connectorLifecycleCatalog().map((entry) => entry.type).sort()).toEqual(
      [...TARGET_CONNECTOR_TYPES].sort(),
    );
    for (const entry of connectorLifecycleCatalog()) {
      expect(entry.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.connectorApiVersion).toBe(1);
      expect(entry.certification.contractVersion).toBe(1);
      expect(entry.certification.evidence).not.toBe('');
      if (entry.supportState === 'deprecated') expect(entry.deprecationDate).not.toBeNull();
      else expect(entry.deprecationDate).toBeNull();
    }
  });

  it('lists only releases this build implements, each with a capability list', () => {
    for (const entry of connectorLifecycleCatalog()) {
      expect(entry.releases.length).toBeGreaterThan(0);
      for (const r of entry.releases) {
        expect(implementedAdapterVersions(entry.type)).toContain(r.adapterVersion);
        for (const capability of r.certification.capabilities) {
          expect(CONNECTOR_CAPABILITIES).toContain(capability);
        }
      }
    }
  });

  it('certifies containers only for the adapter that has them', () => {
    expect(connectorLifecycleMetadata('activeDirectory').certification.capabilities).toContain('create_container');
    expect(connectorLifecycleMetadata('activeDirectory').certification.capabilities).toContain('move_container');
    for (const type of ['scim2', 'httpJson', 'entraId']) {
      expect(connectorLifecycleMetadata(type).certification.capabilities).not.toContain('create_container');
      expect(connectorLifecycleMetadata(type).certification.capabilities).not.toContain('move_container');
    }
  });

  it('keeps controlled connectors visible without claiming general support', () => {
    expect(connectorLifecycleMetadata('entraId')).toMatchObject({
      supportState: 'preview',
      rollout: 'controlled',
      certification: { status: 'partial' },
    });
  });

  it('fails closed for an unregistered type', () => {
    expect(connectorLifecycleMetadata('microsoft365')).toMatchObject({
      supportState: 'unavailable',
      rollout: 'disabled',
      certification: { status: 'not-run', capabilities: [] },
      releases: [],
    });
  });
});

describe('adapter release resolution', () => {
  const catalog = () =>
    connectorMetadataFromReleases({
      type: 'scim2',
      displayName: 'SCIM',
      releases: [
        release({ adapterVersion: '1.0.0' }),
        release({ adapterVersion: '1.1.0', channel: 'canary', rollout: 'controlled' }),
      ],
    });

  it('runs the stable default unless a target chose otherwise', () => {
    const resolved = resolveAdapterRelease('scim2', { adapterChannel: 'stable', adapterVersionPin: null }, catalog);
    expect(resolved).toMatchObject({ source: 'stable', release: { adapterVersion: '1.0.0' } });
  });

  it('gives a canary target the newest canary release, and the stable default when none exists', () => {
    expect(
      resolveAdapterRelease('scim2', { adapterChannel: 'canary', adapterVersionPin: null }, catalog),
    ).toMatchObject({ source: 'canary', release: { adapterVersion: '1.1.0' } });
    expect(
      resolveAdapterRelease('scim2', { adapterChannel: 'canary', adapterVersionPin: null }),
    ).toMatchObject({ source: 'stable', release: { adapterVersion: '1.0.0' } });
  });

  it('honours an exact pin and refuses a pin the catalog does not hold', () => {
    expect(
      resolveAdapterRelease('scim2', { adapterChannel: 'canary', adapterVersionPin: '1.0.0' }, catalog),
    ).toMatchObject({ source: 'pin', release: { adapterVersion: '1.0.0' } });
    expect(() =>
      resolveAdapterRelease('scim2', { adapterChannel: 'stable', adapterVersionPin: '9.9.9' }, catalog),
    ).toThrow(AdapterReleaseNotFoundError);
  });
});

describe('capability refusal', () => {
  const all = capabilitiesForTarget('activeDirectory', {});

  it('refuses a write the exact release is not certified for, per capability', () => {
    for (const capability of CONNECTOR_CAPABILITIES) {
      const narrow = release({
        certification: { ...release().certification, capabilities: CONNECTOR_CAPABILITIES.filter((c) => c !== capability) },
      });
      expect(capabilityRefusalReason('activeDirectory', narrow, all, capability)).toMatch(/not certified/);
      expect(capabilityRefusalReason('activeDirectory', release(), all, capability)).toBeNull();
    }
  });

  it('refuses every write through a release with no passing certification', () => {
    const failed = release({ certification: { ...release().certification, status: 'failed' } });
    expect(capabilityRefusalReason('activeDirectory', failed, all, 'disable_account')).toMatch(/no passing certification/);
  });

  it('refuses a certified write the configuration does not advertise', () => {
    // A document declaring a disable and no entitlement operations.
    const http = capabilitiesForTarget('httpJson', {
      document: { account: { disable: { method: 'POST', path: '/users/{id}/disable' } } },
    });
    expect(capabilityRefusalReason('httpJson', release(), http, 'grant_entitlement')).toMatch(/does not advertise/);
    expect(capabilityRefusalReason('httpJson', release(), http, 'disable_account')).toBeNull();
  });
});

describe('readiness warnings', () => {
  const now = new Date('2026-09-23T12:00:00Z');

  it('warns before and after the deprecation date and for incomplete certification', () => {
    expect(releaseReadinessWarnings('scim2', release(), now)).toEqual([]);
    expect(releaseReadinessWarnings('scim2', release({ deprecationDate: '2026-12-31' }), now)[0]).toMatch(/deprecated and stops accepting new writes on 2026-12-31/);
    expect(releaseReadinessWarnings('scim2', release({ deprecationDate: '2026-09-23' }), now)[0]).toMatch(/passed its deprecation date/);
    expect(releaseReadinessWarnings('scim2', release({ certification: { ...release().certification, status: 'not-run' } }), now)[0]).toMatch(/uncertified/);
    expect(releaseReadinessWarnings('entraId', connectorLifecycleMetadata('entraId'), now)[0]).toMatch(/partially certified/);
  });
});
