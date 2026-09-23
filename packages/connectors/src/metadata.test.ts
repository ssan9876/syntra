import { describe, expect, it } from 'vitest';
import { TARGET_CONNECTOR_TYPES } from './registry.js';
import { connectorLifecycleCatalog, connectorLifecycleMetadata } from './metadata.js';

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
      certification: { status: 'not-run' },
    });
  });
});
