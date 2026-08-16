import type {
  ClaimMappingSpec,
  ClaimProtocol,
  ResolvedClaim,
  SubjectFacts,
} from './types.js';

/**
 * A value counts as present only if it is a non-empty string once trimmed.
 *
 * Null, undefined and whitespace all mean "this person has no such value",
 * and spec section 6 says such a claim is omitted rather than emitted empty.
 * Emitting an empty attribute is worse than omitting it in both directions: a
 * relying party that branches on presence takes the wrong branch, and one that
 * renders the value shows a person a blank field they never had.
 */
function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function valuesFor(
  mapping: ClaimMappingSpec,
  facts: SubjectFacts,
): string[] {
  switch (mapping.sourceKind) {
    case 'literal':
      return present(mapping.literalValue) ? [mapping.literalValue] : [];

    case 'groups':
      return facts.groups.filter(present);

    case 'user': {
      if (!mapping.sourceField) return [];
      const value = facts.user[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'person': {
      if (!mapping.sourceField || !facts.person) return [];
      const value = facts.person[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'attribute': {
      if (!mapping.sourceField) return [];
      const value = facts.attributes[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'contract': {
      if (!mapping.sourceField) return [];
      // The mapping declares the strategy; the strategy declares the
      // contract. A person holding several concurrent contracts gets the one
      // their administrator named, and a person holding none gets nothing.
      const contract = facts.contract[mapping.contractStrategy];
      if (!contract) return [];
      const value = contract[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    default:
      // A source kind this build does not know. Omitted rather than guessed:
      // a row written by a newer version must not become an empty claim in an
      // older one.
      return [];
  }
}

/**
 * Turns a tenant's mappings into the claims one application receives.
 *
 * Pure. Everything it may read is in `facts`, which is what makes the
 * multi-contract matrix exhaustively testable without a database, as spec
 * section 13 requires.
 *
 * Mappings for the other protocol are skipped, and a mapping that resolves to
 * no value produces no entry at all.
 */
export function resolveClaims(
  mappings: ClaimMappingSpec[],
  facts: SubjectFacts,
  protocol: ClaimProtocol,
): ResolvedClaim[] {
  const out: ResolvedClaim[] = [];

  for (const mapping of mappings) {
    if (mapping.protocol !== protocol) continue;

    const all = valuesFor(mapping, facts);
    if (all.length === 0) continue;

    const values = mapping.multiValued ? all : [all[0]!];
    out.push({
      name: mapping.claimName,
      nameFormat: mapping.nameFormat,
      values,
      releaseScope: mapping.releaseScope,
    });
  }

  return out;
}
