export type ClaimProtocol = 'saml' | 'oidc';

export type ClaimSourceKind =
  | 'user'
  | 'person'
  | 'contract'
  | 'attribute'
  | 'groups'
  | 'literal';

export interface ClaimMappingSpec {
  id: string;
  protocol: ClaimProtocol;
  claimName: string;
  nameFormat: string;
  sourceKind: ClaimSourceKind;
  sourceField: string | null;
  // Deliberately not a named export: `identity/contract-service.js` already
  // exports a `ContractStrategy` type with this exact shape, and both are
  // re-exported through `packages/core/src/index.ts` via `export *`. A second
  // export of the same name from this module would make `ContractStrategy`
  // ambiguous at the package boundary.
  contractStrategy: 'primary' | 'lowestSequence';
  literalValue: string | null;
  releaseScope: string | null;
  multiValued: boolean;
}

/**
 * Everything a mapping may read, assembled once by `collect.ts`.
 *
 * The two contract slots are pre-resolved rather than a list, and that is the
 * point: spec section 6 says the *mapping* declares which contract supplies
 * the value, so the choice belongs to `resolveContractForMapping` in the
 * identity layer — which already implements both strategies and is already
 * tested — and not to a second reading of the rule inside the claim engine.
 * Either slot is null when that strategy selects no active contract.
 */
export interface SubjectFacts {
  user: Record<string, string | null>;
  person: Record<string, string | null> | null;
  contract: {
    primary: Record<string, string | null> | null;
    lowestSequence: Record<string, string | null> | null;
  };
  attributes: Record<string, string>;
  groups: string[];
}

export interface ResolvedClaim {
  name: string;
  /** SAML AttributeNameFormat. Ignored by the OIDC side. */
  nameFormat: string;
  values: string[];
  releaseScope: string | null;
}
