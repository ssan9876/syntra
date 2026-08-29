import { describe, expect, it } from 'vitest';
import {
  PERSON_SOURCE_TYPES,
  UnknownPersonSourceTypeError,
  personSourceConfigSchemaFor,
  personSourceConnectorFor,
} from './registry.js';

describe('the person source registry', () => {
  it('resolves every type it claims to know', () => {
    for (const type of PERSON_SOURCE_TYPES) {
      expect(personSourceConnectorFor(type)).toBeDefined();
      expect(personSourceConfigSchemaFor(type)).toBeDefined();
    }
  });

  it('refuses an unknown type by name, listing what it knows', () => {
    expect(() => personSourceConnectorFor('workday')).toThrow(
      UnknownPersonSourceTypeError,
    );
    expect(() => personSourceConnectorFor('workday')).toThrow(/sftpDelimited/);
  });

  /**
   * The registry is a lookup, not a plugin loader. A type that resolved to a
   * connector but not to a schema would accept any configuration at all.
   */
  it('refuses an unknown type on the schema lookup too', () => {
    expect(() => personSourceConfigSchemaFor('workday')).toThrow(
      UnknownPersonSourceTypeError,
    );
  });

  /**
   * Every connector this registry hands out is read-only. The interface has no
   * write method, and this asserts no implementation quietly grew one.
   */
  it('hands out connectors with no write path', () => {
    for (const type of PERSON_SOURCE_TYPES) {
      const connector = personSourceConnectorFor(type) as unknown as Record<string, unknown>;
      expect(typeof connector.read).toBe('function');
      expect(typeof connector.test).toBe('function');
      expect(connector.write).toBeUndefined();
      expect(connector.discoverSchema).toBeUndefined();
    }
  });
});
