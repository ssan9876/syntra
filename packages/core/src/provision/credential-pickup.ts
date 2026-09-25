import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { passwordChangeForcedAtFirstSignIn } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import { deliverMessage } from '../notify/delivery.js';
import {
  renderMessage,
  type OutboundMessage,
  type Transport,
} from '../notify/notification-service.js';
import { currentTenant } from '../tenant-context.js';
import { getSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

/**
 * One-time links to a created account's initial password.
 *
 * Provision seals every initial password into the vault (`finish` in
 * `apply.ts`). What reaches the person -- or their manager -- is a link, never
 * the password: a mailbox keeps what it is sent for years, forwards it,
 * indexes it and syncs it to phones, and a password sitting in one is a
 * credential with no expiry that nobody can revoke. A `CredentialPickup` is
 * the right to read the sealed password ONCE, for 72 hours, held by whoever
 * has the link.
 *
 * Three properties carry the design:
 *
 *  - **Only the SHA-256 of the token is stored.** A read of the table, a
 *    backup or a support bundle yields no usable link -- the same argument
 *    `PasswordResetToken` makes.
 *  - **Opening the link changes nothing.** Mail scanners (Microsoft Safe Links
 *    and its peers) fetch every URL in every message before the recipient
 *    sees it. A GET that revealed the password would reveal it to the scanner
 *    and burn the link, so `credentialPickupStatus` is a pure read and the
 *    reveal is a separate POST that only a person pressing a button sends.
 *  - **The reveal is a conditional update only one caller can win.**
 *    `viewedAt` is set `WHERE viewedAt IS NULL AND revokedAt IS NULL AND
 *    expiresAt > now`, so two concurrent reveals of the same link -- a double
 *    click, a link opened on two devices -- produce one password and one
 *    refusal, never two passwords.
 *
 * No recipient address is stored. Where the link went is the person's
 * personal email or their manager's business email, both of which the Person
 * and Contract rows already hold; `recipientKind` says which. A second copy
 * of contact data would need its own retention and its own erasure, for no
 * question an administrator actually asks.
 */

export const CREDENTIAL_PICKUP_LIFETIME_MS = 72 * 60 * 60 * 1000;

export const PICKUP_RECIPIENT_KINDS = ['personalEmail', 'manager', 'admin'] as const;
export type PickupRecipientKind = (typeof PICKUP_RECIPIENT_KINDS)[number];

export type PickupState = 'ready' | 'used' | 'expired' | 'revoked';

/** The vault name of a created account's sealed initial password. */
export const initialSecretName = (targetSystemId: string, accountId: string) =>
  `target/${targetSystemId}/initial/${accountId}`;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The address a pickup link is served at. The token is in the path, not a query. */
export const credentialPickupUrl = (publicUrl: string, token: string) =>
  `${publicUrl.replace(/\/$/, '')}/credential/${token}`;

function stateOf(
  row: { viewedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): PickupState {
  // Revoked first: an administrator who revoked a link that had also expired
  // did something on purpose, and that is the more useful thing to show.
  if (row.revokedAt !== null) return 'revoked';
  if (row.viewedAt !== null) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ready';
}

/**
 * Mints a pickup inside the caller's transaction and returns the raw token.
 *
 * The token is returned once and never stored, logged or audited; what lands
 * in an audit payload is the row's id. A transaction rather than a tenantId
 * because the create path mints this in the same transaction as the
 * `putSecret` it points at -- a link to a secret that did not commit is a
 * link that says "used" to nobody and "missing" to everyone.
 */
export async function mintCredentialPickup(
  tx: TenantClient,
  input: {
    targetAccountId: string;
    secretName: string;
    recipientKind: PickupRecipientKind;
    createdByUserId: string | null;
    now?: Date | undefined;
  },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CREDENTIAL_PICKUP_LIFETIME_MS);
  const row = await tx.credentialPickup.create({
    data: {
      tenantId: await currentTenant(tx),
      targetAccountId: input.targetAccountId,
      secretName: input.secretName,
      tokenHash: hashToken(token),
      recipientKind: input.recipientKind,
      expiresAt,
      createdAt: now,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  return { id: row.id, token, expiresAt };
}

/**
 * Where a delivery mode sends the link, resolved from the person.
 *
 * Moved here from `apply.ts` so the create path and the administrator's
 * resend agree on what "the manager" means: the manager on the CONTRACT, not
 * on the person -- which is also where department and dates live -- read from
 * the primary contract, falling back to the lowest sequence.
 */
export async function resolveDeliveryAddress(
  tx: TenantClient,
  personId: string | null,
  delivery: 'manager' | 'personalEmail' | 'vaultOnly',
): Promise<{ to: string | null; reason: string }> {
  if (delivery === 'vaultOnly' || personId === null) {
    return { to: null, reason: 'delivery mode is vaultOnly' };
  }
  if (delivery === 'personalEmail') {
    const person = await tx.person.findUnique({ where: { id: personId } });
    return person?.personalEmail
      ? { to: person.personalEmail, reason: 'personal email' }
      : { to: null, reason: 'this person has no personal email address recorded' };
  }
  const contracts = await tx.contract.findMany({
    where: { personId, managerPersonId: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { sequence: 'asc' }],
    take: 1,
  });
  const managerPersonId = contracts[0]?.managerPersonId ?? null;
  if (managerPersonId === null) {
    return { to: null, reason: 'no contract for this person names a manager' };
  }
  const manager = await tx.person.findUnique({ where: { id: managerPersonId } });
  return manager?.businessEmail
    ? { to: manager.businessEmail, reason: 'manager business email' }
    : { to: null, reason: 'the named manager has no business email address recorded' };
}

export interface CredentialLinkFacts {
  tenantName: string;
  to: string;
  recipientKind: PickupRecipientKind;
  /** The person the account belongs to, as a manager or administrator reads it. */
  personName: string;
  systemName: string;
  username: string;
  pickupUrl: string;
  expiresAt: Date;
  /** Whether the target will make them choose a new password at first sign-in. */
  forcedChange: boolean;
}

/**
 * The `account-credential-link` message. Pure, like `renderMessage`.
 *
 * The one place that decides the two sentences whose truth depends on facts:
 * who the account is for, and whether a new password will be demanded. "You
 * will be asked to change it" used to be printed on every message, including
 * for targets where nothing would ever ask.
 */
export function renderCredentialLink(facts: CredentialLinkFacts): OutboundMessage {
  const intro =
    facts.recipientKind === 'personalEmail'
      ? `An account has been created for you at ${facts.tenantName}.`
      : facts.recipientKind === 'manager'
        ? `An account has been created for ${facts.personName} at ${facts.tenantName}. Please pass these sign-in details on to them.`
        : `These are the sign-in details for ${facts.personName}'s account at ${facts.tenantName}, sent at your request.`;
  return renderMessage(facts.tenantName, 'account-credential-link', facts.to, {
    intro,
    systemName: facts.systemName,
    username: facts.username,
    pickupUrl: facts.pickupUrl,
    // UTC and spelled out. The recipient's time zone is not something this
    // process knows, and an ambiguous deadline is worse than a plain one.
    expiresAt: `${facts.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    changeNote: facts.forcedChange
      ? 'You will be asked to choose a new password when you first sign in.'
      : 'Change it after you sign in.',
  });
}

export interface PickupStatus {
  state: PickupState;
  systemName: string;
  username: string;
  expiresAt: Date;
}

/**
 * What the pickup page shows before anybody presses anything. Null for a token
 * that matches nothing.
 *
 * A pure read -- no audit event, no stamp, nothing -- because this is what a
 * mail scanner fetches. Every side effect belongs to `revealCredentialPickup`.
 */
export async function credentialPickupStatus(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<PickupStatus | null> {
  const row = await withTenant(tenantId, (tx) =>
    tx.credentialPickup.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        viewedAt: true,
        revokedAt: true,
        expiresAt: true,
        targetAccount: { select: { correlationKey: true, target: { select: { name: true } } } },
      },
    }),
  );
  if (row === null) return null;
  return {
    state: stateOf(row, now),
    systemName: row.targetAccount.target.name,
    username: row.targetAccount.correlationKey,
    expiresAt: row.expiresAt,
  };
}

export type RevealOutcome =
  | { ok: true; username: string; password: string; systemName: string }
  | { ok: false };

/**
 * Reveals the password behind a link, once.
 *
 * Every refusal is the same `{ ok: false }` to the caller -- unknown, used,
 * expired, revoked, a lost race, a secret that is no longer in the vault. The
 * page has already been told the link's state by the status read, so there is
 * nothing a distinguishing answer here would add except an oracle for
 * somebody enumerating tokens. The REASON goes to the audit trail, which is
 * where an administrator asking "why did my joiner's link not work" looks.
 *
 * The secret is read BEFORE the claim, and the claim is what commits: a
 * secret that is missing leaves the link unspent rather than burning it on a
 * failure. The claim itself is the conditional update below; two concurrent
 * reveals both read the secret, and exactly one of them gets to return it.
 *
 * The vault read inside the transaction is the same trade `finish` documents
 * for `putSecret`: cheap under the local master key, a network round trip
 * under a KMS provider. Kept inside because the read, the claim and the audit
 * row must commit together or not at all.
 */
export async function revealCredentialPickup(
  tenantId: string,
  provider: MasterKeyProvider,
  token: string,
  input: { sourceIp: string | null; now?: Date | undefined },
): Promise<RevealOutcome> {
  const now = input.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const refuse = async (
      reason: PickupState | 'unknown' | 'secret_missing' | 'lost_race',
      row: { id: string; targetAccountId: string } | null,
    ): Promise<RevealOutcome> => {
      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.credential.picked_up',
        targetType: 'TargetAccount',
        targetId: row?.targetAccountId ?? null,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        // Never the token, and never a hash of it: the hash is the lookup key,
        // and an audit reader holding it holds nothing the table does not --
        // but it would make every audit export a list of lookup keys.
        payload: { pickupId: row?.id ?? null, reason },
      });
      return { ok: false };
    };

    const row = await tx.credentialPickup.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        targetAccount: { select: { correlationKey: true, target: { select: { name: true } } } },
      },
    });
    if (row === null) return refuse('unknown', null);

    const state = stateOf(row, now);
    if (state !== 'ready') return refuse(state, row);

    const password = await getSecret(tx, provider, row.secretName);
    if (password === null) return refuse('secret_missing', row);

    const claimed = await tx.credentialPickup.updateMany({
      where: {
        id: row.id,
        viewedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { viewedAt: now },
    });
    if (claimed.count !== 1) return refuse('lost_race', row);

    await recordEvent(tx, {
      actorUserId: null,
      action: 'provision.credential.picked_up',
      targetType: 'TargetAccount',
      targetId: row.targetAccountId,
      outcome: 'success',
      sourceIp: input.sourceIp,
      // The row and who it was sent to, never the password.
      payload: { pickupId: row.id, recipientKind: row.recipientKind },
    });

    return {
      ok: true,
      username: row.targetAccount.correlationKey,
      systemName: row.targetAccount.target.name,
      password,
    };
  });
}

/** Who an administrator's resend goes to. `profile` is the account profile's own setting. */
export type ResendRecipient = 'profile' | PickupRecipientKind;

export class NoTargetAccountError extends Error {
  constructor() {
    super('this person has no account on this target');
    this.name = 'NoTargetAccountError';
  }
}

/** Nothing to link to: the account was never created by Provision, or its secret is gone. */
export class NoInitialSecretError extends Error {
  constructor() {
    super('there is no initial password in the vault for this account, so there is nothing to send a link to');
    this.name = 'NoInitialSecretError';
  }
}

export class NoDeliveryAddressError extends Error {
  constructor(reason: string) {
    super(`the sign-in details cannot be sent: ${reason}`);
    this.name = 'NoDeliveryAddressError';
  }
}

export interface ResendInput {
  targetSystemId: string;
  personId: string;
  recipient: ResendRecipient;
  actorUserId: string;
  sourceIp: string | null;
  now?: Date | undefined;
}

export interface ResendResult {
  pickupId: string;
  recipientKind: PickupRecipientKind;
  expiresAt: Date;
  /** Unviewed links this send revoked. */
  revoked: number;
  /** Whether the transport accepted the message. The link exists either way. */
  delivered: boolean;
}

/**
 * An administrator sends a created account's sign-in details again.
 *
 * Every earlier link that nobody has opened is revoked in the same
 * transaction as the new one is minted, so there is only ever one live link
 * per account: a resend is what somebody does when the first one went to the
 * wrong place, and leaving it working would make the resend a second leak
 * rather than a correction.
 *
 * Refuses, with a reason, when there is nothing to send -- no account, no
 * sealed initial password, or no address for the chosen recipient -- before
 * anything is revoked, so a resend that cannot go anywhere does not also
 * kill the link that might.
 *
 * The send is awaited, unlike the create path's. The administrator is at the
 * button and should hear that the mail server refused, and `deliverMessage`
 * never throws: a dead transport returns false and writes its own audit row.
 */
export async function sendCredentialPickup(
  tenantId: string,
  transport: Transport,
  publicUrl: string,
  input: ResendInput,
): Promise<ResendResult> {
  const now = input.now ?? new Date();
  const prepared = await withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.findFirst({
      where: { targetSystemId: input.targetSystemId, personId: input.personId },
      include: {
        target: { select: { name: true, type: true, profile: true } },
        person: { select: { givenName: true, familyName: true } },
      },
    });
    if (account === null) throw new NoTargetAccountError();

    const secretName = initialSecretName(input.targetSystemId, account.id);
    if ((await tx.secret.count({ where: { name: secretName } })) === 0) {
      throw new NoInitialSecretError();
    }

    const profile = account.target.profile;
    let recipientKind: PickupRecipientKind;
    if (input.recipient === 'profile') {
      const configured = profile?.initialPasswordDelivery ?? 'vaultOnly';
      if (configured !== 'manager' && configured !== 'personalEmail') {
        throw new NoDeliveryAddressError(
          "this target's account profile keeps initial passwords in the vault and sends them to nobody; choose a recipient",
        );
      }
      recipientKind = configured;
    } else {
      recipientKind = input.recipient;
    }

    let to: string | null;
    let reason: string;
    if (recipientKind === 'admin') {
      const me = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { email: true } });
      to = me?.email ? me.email : null;
      reason = 'your own account has no email address';
    } else {
      ({ to, reason } = await resolveDeliveryAddress(tx, account.personId, recipientKind));
    }
    if (to === null) throw new NoDeliveryAddressError(reason);

    const revoked = await tx.credentialPickup.updateMany({
      where: { targetAccountId: account.id, viewedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    const pickup = await mintCredentialPickup(tx, {
      targetAccountId: account.id,
      secretName,
      recipientKind,
      createdByUserId: input.actorUserId,
      now,
    });

    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.credential.link_sent',
      targetType: 'TargetAccount',
      targetId: account.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      // Which kind of recipient, never the address and never the token.
      payload: {
        pickupId: pickup.id,
        recipientKind,
        revokedEarlierLinks: revoked.count,
        resend: true,
      },
    });

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
    return {
      message: renderCredentialLink({
        tenantName: tenant.name,
        to,
        recipientKind,
        personName: personName(account.person),
        systemName: account.target.name,
        username: account.correlationKey,
        pickupUrl: credentialPickupUrl(publicUrl, pickup.token),
        expiresAt: pickup.expiresAt,
        forcedChange: passwordChangeForcedAtFirstSignIn(
          account.target.type,
          profile?.requirePasswordChangeAtFirstSignIn ?? true,
        ),
      }),
      result: { pickupId: pickup.id, recipientKind, expiresAt: pickup.expiresAt, revoked: revoked.count },
    };
  });

  // After the commit and outside every transaction. The link is minted whether
  // or not the mail goes out; a failed send is reported and can be retried.
  const delivered = await deliverMessage(transport, prepared.message, {
    tenantId,
    userId: input.actorUserId,
    // The label, never the body: the body carries a live link.
    purpose: 'provision.credential-link',
  });
  return { ...prepared.result, delivered };
}

const personName = (person: { givenName: string | null; familyName: string | null } | null) =>
  `${person?.givenName ?? ''} ${person?.familyName ?? ''}`.trim() || 'the new starter';

export interface PickupHistoryRow {
  id: string;
  recipientKind: string;
  createdAt: Date;
  expiresAt: Date;
  viewedAt: Date | null;
  revokedAt: Date | null;
  createdByUserId: string | null;
  state: PickupState;
}

/**
 * Every link sent for one account, newest first, and whether there is a
 * sealed initial password to send another. Never a token: only its hash is
 * stored, and not even that leaves this function.
 */
export async function credentialPickupHistory(
  tx: TenantClient,
  targetSystemId: string,
  personId: string,
  now: Date = new Date(),
): Promise<{ hasInitialSecret: boolean; pickups: PickupHistoryRow[] } | null> {
  const account = await tx.targetAccount.findFirst({
    where: { targetSystemId, personId },
    select: { id: true },
  });
  if (account === null) return null;
  // Sequential: one transaction is one connection, and Prisma runs its
  // statements one at a time whatever Promise.all implies.
  const secrets = await tx.secret.count({
    where: { name: initialSecretName(targetSystemId, account.id) },
  });
  const rows = await tx.credentialPickup.findMany({
    where: { targetAccountId: account.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      recipientKind: true,
      createdAt: true,
      expiresAt: true,
      viewedAt: true,
      revokedAt: true,
      createdByUserId: true,
    },
  });
  return {
    hasInitialSecret: secrets > 0,
    pickups: rows.map((row) => ({ ...row, state: stateOf(row, now) })),
  };
}
