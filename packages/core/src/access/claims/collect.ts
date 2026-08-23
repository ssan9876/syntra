import type { TenantClient } from '@syntra/db';
import { listActiveGroupsForUser } from '../../directory/group-service.js';
import { resolveContractForMapping } from '../../identity/contract-service.js';
import type { SubjectFacts } from './types.js';

/** The Contract columns a claim may read. Cost centre and FTE included. */
const CONTRACT_FIELDS = [
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
] as const;

const PERSON_FIELDS = [
  'givenName',
  'familyName',
  'nameConvention',
  'businessEmail',
  'personalEmail',
  'externalId',
] as const;

const USER_FIELDS = ['login', 'email', 'displayName'] as const;

function pick<T extends Record<string, unknown>>(
  row: T | null,
  fields: readonly string[],
): Record<string, string | null> | null {
  if (!row) return null;
  const out: Record<string, string | null> = {};
  for (const field of fields) {
    const value = row[field];
    out[field] = typeof value === 'string' ? value : null;
  }
  return out;
}

/**
 * Reads everything the claim engine may see, and nothing else.
 *
 * Both contract strategies are resolved here, through the identity layer's
 * `resolveContractForMapping`, so the multi-contract rule has exactly one
 * implementation. Either may come back null — a person whose contracts have
 * all ended, or one whose primary contract ended while another continues —
 * and null is what makes `resolveClaims` omit the claim.
 *
 * Read-only, so it takes the caller's transaction. Nothing here is expensive:
 * five indexed lookups, no crypto, no network.
 */
export async function collectSubjectFacts(
  tx: TenantClient,
  userId: string,
  now: Date = new Date(),
): Promise<SubjectFacts> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  const person = user.personId
    ? await tx.person.findUnique({ where: { id: user.personId } })
    : null;

  const primary = user.personId
    ? await resolveContractForMapping(tx, user.personId, 'primary', now)
    : null;
  const lowestSequence = user.personId
    ? await resolveContractForMapping(tx, user.personId, 'lowestSequence', now)
    : null;

  // ACTIVE groups only. This list is asserted into SAML assertions and OIDC
  // tokens, where the receiving application grants on it — so a deactivated
  // group named here is access Syntra believes it has revoked and the other
  // side is still honouring.
  const groups = await listActiveGroupsForUser(tx, userId);
  const attributeRows = await tx.userAttribute.findMany({ where: { userId } });

  const attributes: Record<string, string> = {};
  for (const row of attributeRows) attributes[row.key] = row.value;

  return {
    user: pick(user as unknown as Record<string, unknown>, USER_FIELDS)!,
    person: pick(person as unknown as Record<string, unknown> | null, PERSON_FIELDS),
    contract: {
      primary: pick(primary as unknown as Record<string, unknown> | null, CONTRACT_FIELDS),
      lowestSequence: pick(
        lowestSequence as unknown as Record<string, unknown> | null,
        CONTRACT_FIELDS,
      ),
    },
    attributes,
    groups: groups.map((g) => g.name),
  };
}
