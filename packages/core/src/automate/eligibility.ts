import type { TenantClient } from '@syntra/db';
import { activeContracts } from '../identity/contract-service.js';
import { findVisibleProduct } from './catalog-service.js';
import type { RefusalReason } from './types.js';

/**
 * Everything that makes a subject ineligible, checked in one place.
 *
 * Called at submission, at each stage opening, and again immediately before
 * fulfilment. The evaluation is the audience condition plus the subject's
 * employment state, both cheap and both pure -- which is what makes running it
 * three times affordable, and what stops an approval given on Monday for a
 * finance product from fulfilling on Friday after the subject left finance.
 *
 * Its own module, and not `request-service.ts`, because `fulfilRequest` needs
 * it and `request-service.ts` imports `fulfilRequest`. A cycle here would be
 * resolved by somebody dropping the fulfilment-time check, which is the one
 * spec section 4 names.
 */
export async function checkEligibility(
  tx: TenantClient,
  productId: string,
  subjectPersonId: string,
  on: Date,
): Promise<{ ok: true } | { ok: false; reason: RefusalReason; message: string }> {
  const person = await tx.person.findUnique({
    where: { id: subjectPersonId },
    select: { status: true, givenName: true, familyName: true },
  });
  if (person === null || person.status !== 'active') {
    return {
      ok: false,
      reason: 'subject_inactive',
      message: 'The person this was for is no longer active.',
    };
  }

  const contracts = await activeContracts(tx, subjectPersonId, on);
  if (contracts.length === 0) {
    return {
      ok: false,
      reason: 'subject_departed',
      message: `${person.givenName} ${person.familyName} holds no contract in force.`,
    };
  }

  const product = await tx.product.findUnique({ where: { id: productId } });
  if (product === null || product.status !== 'active') {
    return {
      ok: false,
      reason: 'product_withdrawn',
      message: 'That catalog entry has been withdrawn.',
    };
  }

  const visible = await findVisibleProduct(tx, subjectPersonId, productId, on);
  if (visible === null) {
    return {
      ok: false,
      reason: 'no_longer_eligible',
      message: `${person.givenName} ${person.familyName} no longer matches the audience for ${product.name}.`,
    };
  }

  return { ok: true };
}
