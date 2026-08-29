import type { z } from 'zod';
import type { SourceConnector } from './types.js';
import { sftpDelimitedConnector } from './sftp/connector.js';
import { sftpDelimitedConfigSchema } from './sftp/config.js';

/**
 * Every `PersonSource.type` this package can read.
 *
 * A plain lookup, for the reason `registry.ts` gives for target connectors: a
 * second family needs no migration of the database column, and adding one is
 * one more entry in each of the two records below rather than a new mechanism.
 */
export const PERSON_SOURCE_TYPES = ['sftpDelimited'] as const;
export type PersonSourceType = (typeof PERSON_SOURCE_TYPES)[number];

export class UnknownPersonSourceTypeError extends Error {
  constructor(readonly type: string) {
    super(
      `no person source connector implements type "${type}"; known types are ` +
        PERSON_SOURCE_TYPES.join(', '),
    );
    this.name = 'UnknownPersonSourceTypeError';
  }
}

/**
 * Type-erased to `never` for the reason the target registry records: each
 * connector's real `Config` differs, and this map exists precisely so a caller
 * can select one by `PersonSource.type` at runtime, when no static type can
 * name which one it will get.
 */
const CONNECTORS: Record<PersonSourceType, SourceConnector<never>> = {
  sftpDelimited: sftpDelimitedConnector as unknown as SourceConnector<never>,
};

const CONFIG_SCHEMAS: Record<PersonSourceType, z.ZodTypeAny> = {
  sftpDelimited: sftpDelimitedConfigSchema,
};

function isKnownType(type: string): type is PersonSourceType {
  return (PERSON_SOURCE_TYPES as readonly string[]).includes(type);
}

export function personSourceConnectorFor(type: string): SourceConnector<never> {
  if (!isKnownType(type)) throw new UnknownPersonSourceTypeError(type);
  return CONNECTORS[type];
}

export function personSourceConfigSchemaFor(type: string): z.ZodTypeAny {
  if (!isKnownType(type)) throw new UnknownPersonSourceTypeError(type);
  return CONFIG_SCHEMAS[type];
}
