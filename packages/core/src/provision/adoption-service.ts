import { withTenant } from '@syntra/db';
import { targetConnectorFor, type TargetConnector } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';
import { observedCorrelationKey } from './observed-key.js';
import { assertNotLeftOut } from './exclusion-service.js';

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
    super('This person has no account on this target.');
    this.name = 'NoAccountToAdoptError';
  }
}

export class NotInConflictError extends Error {
  constructor(readonly status: string) {
    super(
      `Account is ${status}, not in conflict. Only a conflicted account can be adopted.`,
    );
    this.name = 'NotInConflictError';
  }
}

export class AnchorAlreadyBoundError extends Error {
  constructor(readonly anchor: string) {
    super(
      `Object ${anchor} already belongs to another account on this target.`,
    );
    this.name = 'AnchorAlreadyBoundError';
  }
}

export class CandidateNotVisibleError extends Error {
  /**
   * `baseDn` is null for a FLAT target -- Entra ID, SCIM, a document with no
   * containers -- where "move it into the managed subtree, or widen the base
   * DN" is advice about a thing that does not exist.
   */
  constructor(
    readonly correlationKey: string,
    readonly baseDn: string | null,
  ) {
    super(
      baseDn === null
        ? `Account ${correlationKey} already exists on the target but cannot be found by that name. ` +
            'If it was deleted, run again to create it.'
        : `Account ${correlationKey} already exists but is not inside ${baseDn}. ` +
            "Move it under the base DN or widen the target's base DN. If it was deleted, run again to create it.",
    );
    this.name = 'CandidateNotVisibleError';
  }
}

/**
 * The scope the candidate search covers, for the refusal to name: the base DN
 * of a target that places accounts in containers, null for a flat one.
 * A config the connector cannot read is treated as placing accounts, which
 * keeps the message it always had.
 */
function searchedScope(type: string, config: unknown): string | null {
  let places: boolean;
  try {
    places = targetConnectorFor(type).placesAccountsInContainers(config as never);
  } catch {
    places = true;
  }
  if (!places) return null;
  return (config as { baseDn?: string } | null)?.baseDn ?? '(no base DN configured)';
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
  /** The account's own correlation key, as the target holds it. */
  correlationKey: string;
  /**
   * `name` when the account carries the conflicted key; `email` when nothing
   * did and the one account holding the person's business email was taken
   * instead. See `findCandidate`.
   */
  matchedBy: 'name' | 'email';
}

export class CorrelationKeyTakenError extends Error {
  constructor(readonly correlationKey: string) {
    super(`Account ${correlationKey} already belongs to another person on this target.`);
    this.name = 'CorrelationKeyTakenError';
  }
}

/** The record attributes a target's email address is read into. */
const EMAIL_ATTRIBUTES = ['mail', 'email'];

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
    await assertNotLeftOut(tx, personId, targetSystemId);
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
      select: { type: true, config: true },
    });
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      select: { businessEmail: true },
    });
    return { account, target, businessEmail: person.businessEmail };
  });
}

/**
 * The object at the target carrying this correlation key, or null.
 *
 * Folded on both sides. `sAMAccountName` is case-insensitive in Active
 * Directory, so an object stored as `Anna.Novak` is the account Syntra tried
 * to create as `anna.novak` — and a case-sensitive compare would report it
 * absent, sending the administrator to move an object that has not moved.
 *
 * The object's key is read through `observedCorrelationKey`, not as
 * `sAMAccountName`: on Entra ID it is the local part of a UPN in the domain
 * Syntra would create it in (`jdoe@contoso.com` is `jdoe`), and a UPN
 * in any other domain never matches.
 */
async function findCandidate(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  type: string,
  correlationKey: string,
  businessEmail: string | null,
  override: TargetConnector<never> | undefined,
): Promise<Candidate | null> {
  const records = await readTarget(tenantId, provider, targetSystemId, type, override);
  return matchCandidate(records, correlationKey, businessEmail);
}

type ObservedRecord = Omit<Candidate, 'matchedBy'>;

/** Every account at the target, each with its own correlation key. */
async function readTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  type: string,
  override: TargetConnector<never> | undefined,
): Promise<ObservedRecord[]> {
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetSystemId),
  );
  if (!config) throw new Error(`Target ${targetSystemId} has no configuration or credential.`);
  const connector = (override ??
    targetConnectorFor(type)) as unknown as TargetConnector<unknown>;
  const records: ObservedRecord[] = [];
  for await (const record of connector.read(config as never)) {
    records.push({
      anchor: record.anchor,
      dn: record.dn,
      attributes: record.attributes,
      correlationKey: observedCorrelationKey(type, config, record).trim(),
    });
  }
  return records;
}

function matchCandidate(
  records: ObservedRecord[],
  correlationKey: string,
  businessEmail: string | null,
): Candidate | null {
  const wanted = correlationKey.trim().toLowerCase();
  const email = businessEmail?.trim().toLowerCase() || null;
  const byEmail: Candidate[] = [];
  for (const record of records) {
    if (record.correlationKey.toLowerCase() === wanted) return { ...record, matchedBy: 'name' };
    const emails = EMAIL_ATTRIBUTES.flatMap((name) => record.attributes[name] ?? []);
    if (
      email !== null &&
      record.correlationKey !== '' &&
      emails.some((value) => value.trim().toLowerCase() === email)
    ) {
      byEmail.push({ ...record, matchedBy: 'email' });
    }
  }
  // A create refused because the EMAIL is taken (Mattermost, most REST
  // targets) reserves a name nobody holds, so nothing carries the key. The
  // account in the way is the one with the person's business email -- when
  // there is exactly one. Two is ambiguous, and an administrator picks.
  return byEmail.length === 1 ? byEmail[0]! : null;
}

/**
 * The object an adoption would bind, for the administrator to look at first.
 *
 * Separate from `adoptAccount` because the safeguard being replaced is a
 * technical one, and the only thing that can stand in for it is a named human
 * having looked at a SPECIFIC object. Confirming a name is not that.
 */
export async function adoptionCandidate(
  tenantId: string,
  provider: MasterKeyProvider,
  personId: string,
  targetSystemId: string,
  connector?: TargetConnector<never>,
): Promise<Candidate> {
  const { account, target, businessEmail } = await conflictedAccount(
    tenantId,
    personId,
    targetSystemId,
  );
  const candidate = await findCandidate(
    tenantId,
    provider,
    targetSystemId,
    target.type,
    account.correlationKey,
    businessEmail,
    connector,
  );
  if (candidate === null) {
    throw new CandidateNotVisibleError(
      account.correlationKey,
      searchedScope(target.type, target.config),
    );
  }
  return candidate;
}

export async function adoptAccount(
  tenantId: string,
  provider: MasterKeyProvider,
  input: AdoptAccountInput,
): Promise<AdoptAccountResult> {
  const { account, target, businessEmail } = await conflictedAccount(
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
    businessEmail,
    input.connector,
  );

  if (candidate === null) {
    const baseDn = searchedScope(target.type, target.config);
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

  await bindCandidate(tenantId, account, candidate, input);
  return { adopted: true, anchor: candidate.anchor, dn: candidate.dn };
}

/** Binds the row to the object, with the audit event, in one transaction. */
async function bindCandidate(
  tenantId: string,
  account: { id: string; correlationKey: string },
  candidate: Candidate,
  input: { targetSystemId: string; reason: string; actorUserId: string | null; sourceIp: string | null },
): Promise<void> {
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
    // Found by email, the account goes by its own name, and the row takes it:
    // left at the reserved name, the next run would propose renaming the
    // person's existing account to it.
    const renamed =
      candidate.matchedBy === 'email' &&
      candidate.correlationKey.toLowerCase() !== account.correlationKey.toLowerCase();
    if (renamed) {
      const taken = await tx.targetAccount.findFirst({
        where: {
          targetSystemId: input.targetSystemId,
          correlationKey: { equals: candidate.correlationKey, mode: 'insensitive' },
          id: { not: account.id },
        },
        select: { id: true },
      });
      if (taken !== null) throw new CorrelationKeyTakenError(candidate.correlationKey);
    }
    await tx.targetAccount.update({
      where: { id: account.id },
      data: {
        anchor: candidate.anchor,
        status: 'active',
        statusReason: null,
        ...(renamed ? { correlationKey: candidate.correlationKey } : {}),
      },
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
        correlationKey: candidate.matchedBy === 'email' ? candidate.correlationKey : account.correlationKey,
        matchedBy: candidate.matchedBy,
        reason: input.reason,
      },
    });
  });
}

/** One account in conflict on a target, with the object it would adopt. */
export interface ConflictAdoption {
  personId: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  /** The name Syntra reserved and the target refused. */
  correlationKey: string;
  /** Null when no object carries the name and no one object has the email. */
  candidate: Candidate | null;
}

/** Every conflicted account on the target and the object each would adopt. */
async function conflictAdoptions(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  override: TargetConnector<never> | undefined,
): Promise<{ id: string; adoption: ConflictAdoption }[]> {
  const { target, accounts } = await withTenant(tenantId, async (tx) => ({
    target: await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
      select: { type: true },
    }),
    accounts: await tx.targetAccount.findMany({
      // Nobody left out of this target: adopting their account would be
      // Syntra taking charge of it.
      where: { targetSystemId, status: 'conflict', person: { targetExclusions: { none: { targetSystemId } } } },
      select: {
        id: true,
        correlationKey: true,
        person: {
          select: { id: true, givenName: true, familyName: true, businessEmail: true },
        },
      },
      orderBy: { correlationKey: 'asc' },
    }),
  }));
  if (accounts.length === 0) return [];
  // One read of the target for all of them, not one per person.
  const records = await readTarget(tenantId, provider, targetSystemId, target.type, override);
  return accounts.map((account) => ({
    id: account.id,
    adoption: {
      personId: account.person.id,
      givenName: account.person.givenName,
      familyName: account.person.familyName,
      businessEmail: account.person.businessEmail,
      correlationKey: account.correlationKey,
      candidate: matchCandidate(records, account.correlationKey, account.person.businessEmail),
    },
  }));
}

/**
 * Every conflicted account on the target, for the administrator to look at
 * before adopting them together. The same lookup as `adoptionCandidate`.
 */
export async function conflictAdoptionPreview(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  connector?: TargetConnector<never>,
): Promise<ConflictAdoption[]> {
  const rows = await conflictAdoptions(tenantId, provider, targetSystemId, connector);
  return rows.map((row) => row.adoption);
}

export interface AdoptConflictsInput {
  targetSystemId: string;
  /**
   * The person and the object the administrator saw in the preview. A person
   * whose candidate is now a different object is not adopted.
   */
  adoptions: { personId: string; anchor: string }[];
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
  connector?: TargetConnector<never>;
}

export interface AdoptConflictResult {
  personId: string;
  adopted: boolean;
  anchor: string | null;
  /** Why it was not adopted. Null when it was. */
  message: string | null;
}

/**
 * Adopts the conflicted accounts the administrator confirmed from
 * `conflictAdoptionPreview`, each in its own transaction with its own audit
 * event. One refusal does not stop the rest.
 */
export async function adoptConflicts(
  tenantId: string,
  provider: MasterKeyProvider,
  input: AdoptConflictsInput,
): Promise<AdoptConflictResult[]> {
  const rows = await conflictAdoptions(tenantId, provider, input.targetSystemId, input.connector);
  const byPerson = new Map(rows.map((row) => [row.adoption.personId, row]));
  const results: AdoptConflictResult[] = [];
  for (const { personId, anchor } of input.adoptions) {
    const row = byPerson.get(personId);
    const refuse = (message: string) => results.push({ personId, adopted: false, anchor: null, message });
    if (row === undefined) {
      refuse('Account is no longer in conflict.');
      continue;
    }
    const { candidate, correlationKey } = row.adoption;
    if (candidate === null) {
      refuse(`No account at the target has the name ${correlationKey} or the email ${row.adoption.businessEmail ?? '(none)'}.`);
      continue;
    }
    if (candidate.anchor !== anchor) {
      refuse(`Account ${correlationKey} now matches a different object at the target. Preview again.`);
      continue;
    }
    try {
      await bindCandidate(tenantId, { id: row.id, correlationKey }, candidate, input);
      results.push({ personId, adopted: true, anchor: candidate.anchor, message: null });
    } catch (cause) {
      if (cause instanceof AnchorAlreadyBoundError || cause instanceof CorrelationKeyTakenError) {
        refuse(cause.message);
        continue;
      }
      throw cause;
    }
  }
  return results;
}
