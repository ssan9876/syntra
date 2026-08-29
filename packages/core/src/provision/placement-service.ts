import { withTenant, type TenantClient } from '@syntra/db';
import { targetConnectorFor } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { storableCause } from '../storable-text.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';
import { placeAt } from './apply.js';

/**
 * Moving one person's account to a container somebody chose.
 *
 * This is the human path, and it is deliberately not the planner's. The
 * planner computes a container for everybody from the account profile's
 * template — usually from the contract's department — and its characteristic
 * accident is four thousand objects, which is why every action it proposes is
 * counted against a threshold and reviewed before it is applied. Nothing here
 * is computed: an administrator names one person, chooses a container that
 * already exists in the target, and says why.
 *
 * The row it writes is what makes the move STICK. Without it the next run
 * compares the account's actual container against the template's answer, finds
 * they disagree, and proposes a `modifyDN` putting the person straight back —
 * within five minutes, silently, with the console still showing the move as
 * successful. See `AccountPlacement`.
 */

export class ContainerNotInTargetError extends Error {
  constructor(readonly container: string) {
    super(
      `the container ${container} does not exist in this target, and Provision does not create one`,
    );
    this.name = 'ContainerNotInTargetError';
  }
}

export class NoCorrelationKeyError extends Error {
  constructor() {
    super(
      'this account has not been created in the target yet, so there is nothing there to move. ' +
        'The container is recorded, and the account will be created there.',
    );
    this.name = 'NoCorrelationKeyError';
  }
}

export class NoAccountToMoveError extends Error {
  constructor() {
    super('this person has no account in that target to move');
    this.name = 'NoAccountToMoveError';
  }
}

export interface PlacementView {
  personId: string;
  targetSystemId: string;
  container: string;
  reason: string;
  movedByUserId: string | null;
  updatedAt: Date;
}

export async function findPlacement(
  tx: TenantClient,
  personId: string,
  targetSystemId: string,
): Promise<PlacementView | null> {
  const row = await tx.accountPlacement.findUnique({
    where: { personId_targetSystemId: { personId, targetSystemId } },
  });
  return row === null
    ? null
    : {
        personId: row.personId,
        targetSystemId: row.targetSystemId,
        container: row.container,
        reason: row.reason,
        movedByUserId: row.movedByUserId,
        updatedAt: row.updatedAt,
      };
}

export interface SetPlacementInput {
  personId: string;
  targetSystemId: string;
  container: string;
  reason: string;
  movedByUserId: string | null;
  /**
   * The containers the target actually holds, read from the target itself.
   *
   * Passed in rather than read here, because reading them is a network call
   * and this runs inside a transaction. The caller reads the target's
   * inventory through `listContainers` first — the same read `reconcile` uses
   * for `container_missing` — and hands the result over.
   */
  existingContainers: readonly string[];
}

/**
 * Pins a person's account to a container.
 *
 * Refuses a container the target does not have. Provision creates no
 * containers anywhere — spec section 6 — so a placement naming one that does
 * not exist is an account that fails to move on every run afterwards, with the
 * failure appearing as a connector error rather than as the typo it is.
 *
 * Compared case-insensitively and after trimming, because distinguished names
 * are case-insensitive and a pasted DN arrives with whitespace on it. The
 * value STORED is the target's own casing, not what was typed: the planner
 * compares the desired container against what the directory reports, and two
 * spellings of one DN would look like a move that never completes.
 */
export async function setPlacement(
  tx: TenantClient,
  input: SetPlacementInput,
): Promise<PlacementView> {
  const tenantId = await currentTenant(tx);

  const wanted = input.container.trim().toLowerCase();
  const canonical = input.existingContainers.find(
    (candidate) => candidate.trim().toLowerCase() === wanted,
  );
  if (canonical === undefined) throw new ContainerNotInTargetError(input.container);

  // The account has to exist before it can be moved. Pinning a container for
  // somebody with no account there would silently change where their account
  // is CREATED — which is a different decision, made by the profile template,
  // and not the one the person clicking Move is making.
  const account = await tx.targetAccount.findFirst({
    where: { personId: input.personId, targetSystemId: input.targetSystemId },
    select: { id: true },
  });
  if (account === null) throw new NoAccountToMoveError();

  const row = await tx.accountPlacement.upsert({
    where: {
      personId_targetSystemId: {
        personId: input.personId,
        targetSystemId: input.targetSystemId,
      },
    },
    create: {
      tenantId,
      personId: input.personId,
      targetSystemId: input.targetSystemId,
      container: canonical,
      reason: input.reason.trim(),
      movedByUserId: input.movedByUserId,
    },
    update: {
      container: canonical,
      reason: input.reason.trim(),
      movedByUserId: input.movedByUserId,
    },
  });

  return {
    personId: row.personId,
    targetSystemId: row.targetSystemId,
    container: row.container,
    reason: row.reason,
    movedByUserId: row.movedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Hands the person back to the rule.
 *
 * The account is NOT moved here, and that is the point: the next run computes
 * the template's answer, sees the account is somewhere else, and proposes the
 * move — through the guard, in a plan somebody reviews, like every other
 * placement decision. Moving it here would be the manual path doing the
 * planner's job without the planner's controls.
 *
 * Idempotent. Clearing a placement that is not there is what somebody pressing
 * the button twice means.
 */
export async function clearPlacement(
  tx: TenantClient,
  personId: string,
  targetSystemId: string,
): Promise<boolean> {
  const { count } = await tx.accountPlacement.deleteMany({
    where: { personId, targetSystemId },
  });
  return count > 0;
}

/**
 * The containers this target holds, read from the target itself.
 *
 * Read, never inferred from the DNs of the accounts already there — the same
 * rule `TargetConnector.listContainers` states and for the same reason: an
 * empty-but-real container would be invisible, which on a Move screen means
 * the one place somebody is trying to move an account to is the one place the
 * list does not offer.
 *
 * Network I/O, so no transaction is held across it.
 */
export async function targetContainers(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
): Promise<string[]> {
  const target = await withTenant(tenantId, (tx) =>
    tx.targetSystem.findUnique({ where: { id: targetSystemId }, select: { type: true } }),
  );
  if (target === null) throw new Error('no such target');

  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetSystemId),
  );
  if (!config) throw new Error('target configuration or credential missing');

  const connector = targetConnectorFor(target.type);
  const containers: string[] = [];
  for await (const container of connector.listContainers(config as never)) {
    containers.push(container.dn);
  }
  return [...new Set(containers)].sort();
}

export interface MoveAccountInput {
  personId: string;
  targetSystemId: string;
  container: string;
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
}

/**
 * Moves one person's account, and records the decision that keeps it moved.
 *
 * The order matters and is not the obvious one: the PLACEMENT is written
 * first, and the directory is written second. If the directory write fails,
 * the placement stands and the next run proposes the move — through the guard,
 * in a plan somebody reviews, which is the right place for a write that could
 * not be made now. The other order loses the decision entirely on a transient
 * failure, and the administrator's only evidence that they ever pressed the
 * button is an error message they have already dismissed.
 *
 * The audit event is written either way, with the outcome on it. "Who moved
 * this and why" is the only question anybody asks about an account that is not
 * where the rule says.
 */
export async function moveAccount(
  tenantId: string,
  provider: MasterKeyProvider,
  input: MoveAccountInput,
): Promise<{ moved: boolean; message: string }> {
  const containers = await targetContainers(tenantId, provider, input.targetSystemId);

  const account = await withTenant(tenantId, async (tx) => {
    await setPlacement(tx, {
      personId: input.personId,
      targetSystemId: input.targetSystemId,
      container: input.container,
      reason: input.reason,
      movedByUserId: input.actorUserId,
      existingContainers: containers,
    });
    return tx.targetAccount.findFirstOrThrow({
      where: { personId: input.personId, targetSystemId: input.targetSystemId },
      select: { anchor: true, correlationKey: true },
    });
  });

  // A distinguished name is `CN=<name>,<container>`, so without a name there
  // is nothing to move to. The placement is already written, which is the
  // right outcome: the next run generates a key and moves the account there.
  // A distinguished name is `CN=<name>,<container>`, and the write is
  // addressed by anchor. An account row with neither is one Syntra has
  // planned but the target has never seen, so there is nothing there to move.
  //
  // The placement is ALREADY written at this point, and that is the right
  // outcome rather than an oversight: when the account is eventually created
  // it is created at the container somebody chose, which is what they were
  // asking for.
  const correlationKey = account.correlationKey;
  const anchor = account.anchor;
  if (correlationKey === null || correlationKey.trim() === '' || anchor === null) {
    throw new NoCorrelationKeyError();
  }

  const target = await withTenant(tenantId, (tx) =>
    tx.targetSystem.findUniqueOrThrow({
      where: { id: input.targetSystemId },
      select: { type: true },
    }),
  );
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, input.targetSystemId),
  );
  if (!config) throw new Error('target configuration or credential missing');

  // Phase 2: the directory. No transaction is held — this is network I/O.
  //
  // `update_account` carrying a distinguished name is how a move is spelled
  // everywhere in this product; `apply.ts` issues exactly this for a planned
  // move. Using the same operation rather than inventing a second one is what
  // stops the manual path and the planned path drifting into two behaviours.
  const canonical = containers.find(
    (candidate) => candidate.trim().toLowerCase() === input.container.trim().toLowerCase(),
  )!;
  // A THROWN write still gets audited. The connector returns a `WriteResult`
  // for the refusals it anticipated, but a directory that stopped answering
  // mid-call throws — and letting that propagate would mean the one move
  // nobody can account for afterwards is the one that went wrong. The
  // placement is already written either way, so the next run retries it.
  const result = await targetConnectorFor(target.type)
    .write(config as never, {
      op: 'update_account',
      // No `ProvisionAction` behind this one. A human named the object; there
      // is no planned action to attribute it to, and inventing an id would put
      // a row in the run history that no run produced.
      actionId: 'manual-move',
      anchor,
      attributes: {
        // `placeAt`, which `apply.ts` uses for a PLANNED move — one function,
        // so the manual path and the planned path cannot escape a
        // distinguished name differently. Ruling P22: an unescaped value here
        // is a valid DN naming a container nobody chose.
        distinguishedName: [placeAt(correlationKey, canonical)],
      },
    })
    .catch((cause: unknown) => ({
      ok: false as const,
      message: storableCause(cause),
    }));

  await withTenant(tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.account_moved',
      targetType: 'Person',
      targetId: input.personId,
      outcome: result.ok ? 'success' : 'failure',
      sourceIp: input.sourceIp,
      payload: {
        targetSystemId: input.targetSystemId,
        container: canonical,
        reason: input.reason,
        ...(result.ok ? {} : { error: result.message }),
      },
    }),
  );

  return {
    moved: result.ok,
    message: result.ok
      ? `moved to ${canonical}`
      : // The placement stands regardless, so the next run will try again.
        `${result.message}. The move is recorded and the next run will retry it.`,
  };
}
