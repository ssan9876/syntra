import type { TenantClient } from '@syntra/db';
import { activeContracts } from '../identity/contract-service.js';
import { sodImpactForProducts } from '../govern/sod-service.js';
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

  // Segregation of duties, re-checked at each stage opening and again AT
  // FULFILMENT, because an approval given on Monday must not fulfil on Friday
  // into a world that changed.
  //
  // ONLY `critical` REFUSES. Below that the approver is told and approving
  // records an acknowledgement that becomes a pending exception request.
  // Blocking here for a lower severity would freeze somebody for a
  // configuration error somebody else made -- the unprocessable-person trap,
  // inverted, produced by a governance control.
  //
  // Set-based over the product's grants, and one call: `sodImpactForProducts`
  // loads the tenant's rules and the subject's holdings once. A per-grant loop
  // would re-read both for every grant of every product.
  const grants = await tx.productGrant.findMany({
    where: { productId },
    select: { targetSystemId: true, resourceType: true, resourceId: true },
  });
  const sod = await sodImpactForProducts(tx, subjectPersonId, [{ id: productId, grants }], {
    now: on,
  });
  const impact = sod.get(productId);
  if (impact !== undefined && impact.hasCritical) {
    const named = impact.violations.filter((v) => v.severity === 'critical');
    return {
      ok: false,
      reason: 'sod_violation',
      message:
        `granting this would create a critical segregation-of-duties violation of ` +
        `"${named[0]!.ruleName}", against ${named[0]!.otherSideHoldings.join(', ') || 'access already held'}. ` +
        `An approved exception is required first.`,
    };
  }

  return { ok: true };
}
