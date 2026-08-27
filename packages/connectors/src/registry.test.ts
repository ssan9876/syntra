import { describe, expect, it } from 'vitest';
import {
  TARGET_CONNECTOR_TYPES,
  targetConnectorFor,
  targetConfigSchemaFor,
  UnknownTargetConnectorTypeError,
} from './registry.js';
import { adTargetConnector } from './ad/connector.js';
import { scimTargetConnector } from './scim/connector.js';
import { adTargetConfigSchema } from './ad/config.js';
import { scim2TargetConfigSchema } from './scim/config.js';
import { httpTargetConnector } from './http/connector.js';
import { httpTargetConfigSchema } from './http/document.js';

describe('registry', () => {
  it('lists every connector type', () => {
    expect(TARGET_CONNECTOR_TYPES).toEqual(['activeDirectory', 'scim2', 'httpJson']);
  });

  it('resolves activeDirectory to the AD connector and config schema', () => {
    expect(targetConnectorFor('activeDirectory')).toBe(adTargetConnector);
    expect(targetConfigSchemaFor('activeDirectory')).toBe(adTargetConfigSchema);
  });

  it('resolves scim2 to the SCIM connector and config schema', () => {
    expect(targetConnectorFor('scim2')).toBe(scimTargetConnector);
    expect(targetConfigSchemaFor('scim2')).toBe(scim2TargetConfigSchema);
  });

  it('resolves httpJson to the declarative connector and config schema', () => {
    expect(targetConnectorFor('httpJson')).toBe(httpTargetConnector);
    expect(targetConfigSchemaFor('httpJson')).toBe(httpTargetConfigSchema);
  });

  it('has a schema and a connector for every declared type', () => {
    // The two records are hand-maintained and separate, so a type added to
    // one and not the other compiles and then throws at the first run against
    // it. Asserted rather than trusted.
    for (const type of TARGET_CONNECTOR_TYPES) {
      expect(targetConnectorFor(type)).toBeDefined();
      expect(targetConfigSchemaFor(type)).toBeDefined();
    }
  });

  it('refuses a type nothing implements, by name', () => {
    expect(() => targetConnectorFor('okta')).toThrow(UnknownTargetConnectorTypeError);
    expect(() => targetConnectorFor('okta')).toThrow(/okta/);
  });
});
