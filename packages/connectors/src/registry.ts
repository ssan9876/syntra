import type { z } from 'zod';
import type { TargetConnector } from './types.js';
import { adTargetConnector } from './ad/connector.js';
import { adTargetConfigSchema } from './ad/config.js';
import { scimTargetConnector } from './scim/connector.js';
import { scim2TargetConfigSchema } from './scim/config.js';
import { httpTargetConnector } from './http/connector.js';
import { httpTargetConfigSchema } from './http/document.js';

/**
 * Every `TargetSystem.type` this package can read. A plain lookup, not
 * reflection or a plugin loader — `target-service.ts`'s own comment on
 * `TARGET_TYPES` says why: "a second connector family needs no migration"
 * refers to the database column, not to this list, which is exactly as
 * closed as `adTargetConnector` being the only thing `target-service.ts`
 * imported before this file existed. Adding a third connector is one more
 * entry in each of the two records below, not a new mechanism.
 */
export const TARGET_CONNECTOR_TYPES = ['activeDirectory', 'scim2', 'httpJson'] as const;
export type TargetConnectorType = (typeof TARGET_CONNECTOR_TYPES)[number];

export class UnknownTargetConnectorTypeError extends Error {
  constructor(readonly type: string) {
    super(
      `no target connector implements type "${type}"; known types are ${TARGET_CONNECTOR_TYPES.join(', ')}`,
    );
    this.name = 'UnknownTargetConnectorTypeError';
  }
}

/**
 * Type-erased to `never` deliberately: each connector's real `Config` differs
 * (`AdTargetConfig & { bindPassword }` vs `Scim2TargetConfig & { bearerToken
 * }`), and this map exists precisely so a caller can select one *by
 * `TargetSystem.type` at runtime*, when no static type can name which one it
 * will get. The caller supplies the merged config object (the stored `config`
 * JSON plus the vault-read credential) and is responsible for having built it
 * to match whichever type it read `TargetSystem.type` as — the same
 * responsibility `targetWithCredential` already carries for the single-
 * connector case this replaces.
 */
const CONNECTORS: Record<TargetConnectorType, TargetConnector<never>> = {
  activeDirectory: adTargetConnector as unknown as TargetConnector<never>,
  scim2: scimTargetConnector as unknown as TargetConnector<never>,
  // One entry, like the others -- but this one covers many targets rather
  // than one. Its config carries the document that describes which.
  httpJson: httpTargetConnector as unknown as TargetConnector<never>,
};

const CONFIG_SCHEMAS: Record<TargetConnectorType, z.ZodTypeAny> = {
  activeDirectory: adTargetConfigSchema,
  scim2: scim2TargetConfigSchema,
  httpJson: httpTargetConfigSchema,
};

function isKnownType(type: string): type is TargetConnectorType {
  return (TARGET_CONNECTOR_TYPES as readonly string[]).includes(type);
}

export function targetConnectorFor(type: string): TargetConnector<never> {
  if (!isKnownType(type)) throw new UnknownTargetConnectorTypeError(type);
  return CONNECTORS[type];
}

export function targetConfigSchemaFor(type: string): z.ZodTypeAny {
  if (!isKnownType(type)) throw new UnknownTargetConnectorTypeError(type);
  return CONFIG_SCHEMAS[type];
}
