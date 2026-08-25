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

describe('registry', () => {
  it('lists both connector types', () => {
    expect(TARGET_CONNECTOR_TYPES).toEqual(['activeDirectory', 'scim2']);
  });

  it('resolves activeDirectory to the AD connector and config schema', () => {
    expect(targetConnectorFor('activeDirectory')).toBe(adTargetConnector);
    expect(targetConfigSchemaFor('activeDirectory')).toBe(adTargetConfigSchema);
  });

  it('resolves scim2 to the SCIM connector and config schema', () => {
    expect(targetConnectorFor('scim2')).toBe(scimTargetConnector);
    expect(targetConfigSchemaFor('scim2')).toBe(scim2TargetConfigSchema);
  });

  it('refuses a type nothing implements, by name', () => {
    expect(() => targetConnectorFor('okta')).toThrow(UnknownTargetConnectorTypeError);
    expect(() => targetConnectorFor('okta')).toThrow(/okta/);
  });
});
