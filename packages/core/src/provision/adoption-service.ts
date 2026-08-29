import { withTenant } from '@syntra/db';
import { targetConnectorFor, type TargetConnector } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';
import { valuesOf } from './apply.js';

/**
 * Binding a conflicted account to the object that caused the collision.
 *
 * This is the human path out of a state the subsystem has no other exit from.
 * `apply.ts` sets `conflict` when the target refuses a create because the name
 * is already taken, and nothing writes it back: `reconcile` makes the person
 * unprocessable at scope `all` and returns before anything else is evaluated,
 * and the reservation step excludes them by name. Every later run stops in the
 * same place, whatever the administrator does in the directory.
 *
 * The refusal being overridden here is correct and stays. Syntra does not bind
 * to an object it did not create, because anybody able to create an object in
 * a target could otherwise choose a name that hands them somebody else's
 * account. What replaces that safeguard is a named human confirming a specific
 * object, and an audit event recording who and why.
 *
 * **It performs one directory READ and no write.** Provenance is consulted
 * only on creates — `apply.ts` when a create is refused as already existing,
 * and `resolveInFlightActions` when a create's response was lost — so an
 * adopted account needs no marker. Writing one would overwrite `info`, a field
 * this deployment's provenance attribute shares with an administrator's own
 * notes, in order to record something no code reads. Attributes converge on
 * the next run, through the guard, in a plan somebody reviews.
 */

export interface AdoptAccountInput {
  personId: string;
  targetSystemId: string;
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
  /**
   * The connector to read the target with. A seam for tests, exactly as
   * `applyProvisionRun` has one; production passes nothing and gets the
   * connector the target's type names.
   */
  connector?: TargetConnector<never>;
}

export interface AdoptAccountResult {
  adopted: boolean;
  anchor: string | null;
  dn: string | null;
}

interface Candidate {
  anchor: string;
  dn: string;
  attributes: Record<string, string[]>;
}

/** The row to adopt, plus the target details the read needs. */
async function conflictedAccount(
  tenantId: string,
  personId: string,
  targetSystemId: string,
) {
  return withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.findFirstOrThrow({
      where: { personId, targetSystemId },
      select: { id: true, status: true, correlationKey: true },
    });
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
      select: { type: true, config: true },
    });
    return { account, target };
  });
}

/**
 * The object at the target carrying this correlation key, or null.
 *
 * Folded on both sides. `sAMAccountName` is case-insensitive in Active
 * Directory, so an object stored as `Anna.Novak` is the account Syntra tried
 * to create as `anna.novak` — and a case-sensitive compare would report it
 * absent, sending the administrator to move an object that has not moved.
 */
async function findCandidate(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  type: string,
  correlationKey: string,
  override: TargetConnector<never> | undefined,
): Promise<Candidate | null> {
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetSystemId),
  );
  if (!config) throw new Error('target configuration or credential missing');
  const connector = (override ??
    targetConnectorFor(type)) as unknown as TargetConnector<unknown>;

  const wanted = correlationKey.trim().toLowerCase();
  for await (const record of connector.read(config as never)) {
    const key = (valuesOf(record, 'sAMAccountName')[0] ?? '').trim().toLowerCase();
    if (key !== wanted) continue;
    return { anchor: record.anchor, dn: record.dn, attributes: record.attributes };
  }
  return null;
}

export async function adoptAccount(
  tenantId: string,
  provider: MasterKeyProvider,
  input: AdoptAccountInput,
): Promise<AdoptAccountResult> {
  const { account, target } = await conflictedAccount(
    tenantId,
    input.personId,
    input.targetSystemId,
  );

  const candidate = await findCandidate(
    tenantId,
    provider,
    input.targetSystemId,
    target.type,
    account.correlationKey,
    input.connector,
  );

  if (candidate === null) return { adopted: false, anchor: null, dn: null };

  await withTenant(tenantId, async (tx) => {
    await tx.targetAccount.update({
      where: { id: account.id },
      data: { anchor: candidate.anchor, status: 'active', statusReason: null },
    });
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.account.adopted',
      targetType: 'TargetAccount',
      targetId: account.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        adopted: true,
        anchor: candidate.anchor,
        dn: candidate.dn,
        correlationKey: account.correlationKey,
        reason: input.reason,
      },
    });
  });

  return { adopted: true, anchor: candidate.anchor, dn: candidate.dn };
}
