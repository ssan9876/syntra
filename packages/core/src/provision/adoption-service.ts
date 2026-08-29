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

export class NoAccountToAdoptError extends Error {
  constructor() {
    super('this person has no account on this target, so there is nothing to adopt');
    this.name = 'NoAccountToAdoptError';
  }
}

export class NotInConflictError extends Error {
  constructor(readonly status: string) {
    super(
      `this account is ${status}, not in conflict. Adoption is the exit from a conflict, ` +
        'not a way to re-point an account that already works.',
    );
    this.name = 'NotInConflictError';
  }
}

export class AnchorAlreadyBoundError extends Error {
  constructor(readonly anchor: string) {
    super(
      `the object ${anchor} is already held by another account in this target, ` +
        'so adopting it here would give two people one account',
    );
    this.name = 'AnchorAlreadyBoundError';
  }
}

export class CandidateNotVisibleError extends Error {
  constructor(
    readonly correlationKey: string,
    readonly baseDn: string,
  ) {
    super(
      `the account ${correlationKey} was refused as already existing, and no object with that name is inside ${baseDn}. ` +
        'Either it is elsewhere in the domain where this target cannot see it — move it into the managed subtree, ' +
        "or widen the target's base DN — or it has since been deleted, in which case the account can be created again.",
    );
    this.name = 'CandidateNotVisibleError';
  }
}

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
  /**
   * What to do when no object with this name is visible under the base DN.
   *
   * The two causes are indistinguishable from a base-scoped read — the object
   * is outside the base, or it has been deleted — and they need opposite
   * treatments. The status cannot separate them either: `finish` sets
   * `conflict` only on an already-exists refusal, so every row in this state
   * carries identical evidence. The only other signal is `statusReason`, which
   * holds the directory's own error text, and branching on strings a foreign
   * system produced is the coupling that stranded actions until v1.6.3.
   *
   * So the administrator answers, because the administrator can look. The
   * default is the one that changes nothing.
   */
  ifNoCandidate?: 'refuse' | 'reset';
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
    const account = await tx.targetAccount.findFirst({
      where: { personId, targetSystemId },
      select: { id: true, status: true, correlationKey: true },
    });
    if (account === null) throw new NoAccountToAdoptError();
    if (account.status !== 'conflict') throw new NotInConflictError(account.status);
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

  if (candidate === null) {
    const baseDn =
      (target.config as { baseDn?: string } | null)?.baseDn ?? '(no base DN configured)';
    if ((input.ifNoCandidate ?? 'refuse') === 'refuse') {
      throw new CandidateNotVisibleError(account.correlationKey, baseDn);
    }
    // The administrator has answered the question this service cannot: the
    // object is gone, not merely out of sight. Back to `pending`, and the next
    // run creates the account — which is what a reservation is for.
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.update({
        where: { id: account.id },
        data: { status: 'pending', statusReason: null },
      });
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'provision.account.adopted',
        targetType: 'TargetAccount',
        targetId: account.id,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          adopted: false,
          correlationKey: account.correlationKey,
          reason: input.reason,
        },
      });
    });
    return { adopted: false, anchor: null, dn: null };
  }

  await withTenant(tenantId, async (tx) => {
    const held = await tx.targetAccount.findFirst({
      where: { targetSystemId: input.targetSystemId, anchor: candidate.anchor },
      select: { id: true },
    });
    // The partial unique index on `(tenantId, targetSystemId, anchor)` refuses
    // this anyway. Checked first so the administrator gets a sentence rather
    // than a constraint violation — and inside the transaction, so a
    // concurrent adoption cannot slip between the check and the write.
    if (held !== null && held.id !== account.id) {
      throw new AnchorAlreadyBoundError(candidate.anchor);
    }
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
