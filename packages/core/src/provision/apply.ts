import { randomInt } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import {
  targetConnectorFor,
  isRetryable,
  provenanceActionId,
  SYNTRA_ONLY_ACTION_TYPES,
  type SourceRecord,
  type TargetConnector,
  type WriteOperation,
  type WriteResult,
} from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import { storableMessage } from '../storable-text.js';
import { queueMessage } from '../notify/delivery.js';
import type { Transport } from '../notify/notification-service.js';
import { putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { grantedEntitlementsFor, remitFor } from './entitlement-service.js';
// Core's own, from the module that owns DN rendering in this package
// (Ruling P22). `@syntra/connectors` carries a byte-identical local copy
// because it sits below core in the dependency graph; there is no reason for
// core to reach across for it.
import { escapeDnValue } from './templates.js';
import { movesContainer } from './guard.js';
import { targetWithCredential } from './target-service.js';
import { applySyntraUserAction } from './syntra-user.js';

/**
 * The longest one backoff may be.
 *
 * `2 ** (attempt - 1)` reaches `Infinity` at attempt 1025 and passes 60 s at
 * attempt 7. `maxAttempts` is capped at 10 by the profile schema today, so the
 * uncapped form is an eight-and-a-half minute sleep for one action and, if
 * that cap ever moves, `sleep(Infinity)` — a run that never finishes and never
 * says why. A ceiling costs nothing: past a minute the exponent has already
 * done everything it is for.
 */
const MAX_BACKOFF_MS = 60_000;

/** Exponential, with jitter, so a hundred retries do not arrive together. */
export function backoffMs(attempt: number, jitter: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(base * (1 + jitter() * 0.25));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long one action may spend being throttled before it gives up, and how
 * many times.
 *
 * A throttle is the target asking for patience, so it is not counted against
 * `maxAttempts` — but "not counted" is not "unbounded". Without a ceiling a
 * target throttling indefinitely hangs the apply forever, the run stays
 * `applying`, and every leaver action behind that one in `sequence` order is
 * never attempted at all.
 *
 * **Both bounds, because either alone can be defeated by the target.** The
 * accumulated-wait budget is a bound only if every wait is positive: a target
 * answering `retryAfterMs: 0` — or a negative number, or `NaN` — never
 * advances the total, and the budget stops being a ceiling at all. The count
 * bounds that case; the budget bounds the opposite one, where a target asks
 * for an hour and would otherwise get it.
 */
const THROTTLE_BUDGET_MS = 120_000;
const MAX_THROTTLED_ATTEMPTS = 20;

/**
 * How often an apply in progress restamps `ProvisionRun.lastProgressAt`.
 *
 * Well under `STALE_RUN_MS`, and coarse enough that a run of four thousand
 * actions writes a handful of rows rather than four thousand. It is a sign of
 * life, not a progress bar: the only reader is the scheduled job's staleness
 * check, which is asking whether the process that owns this run is still
 * alive.
 */
const HEARTBEAT_MS = 60_000;

export interface InitialPasswordPolicy {
  length?: number;
  requireUpper?: boolean;
  requireLower?: boolean;
  requireDigit?: boolean;
  requireSymbol?: boolean;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';

/**
 * The initial password, generated here and not in the connector.
 *
 * Generated with `crypto` (Global Constraint 14), honouring the profile's
 * policy rather than a hardcoded shape — the earlier draft's connector
 * produced `Aa1!` plus 24 random bytes regardless of what the profile said,
 * which made `initialPasswordPolicy` a column nothing read.
 *
 * Never logged, never returned by an API, never written to a ProvisionAction
 * or an audit payload. It leaves this module twice: into the vault, and into
 * one message.
 */
export function generateInitialPassword(policy: InitialPasswordPolicy = {}): string {
  const length = Math.max(16, Math.min(128, policy.length ?? 24));
  const classes: string[] = [];
  if (policy.requireUpper !== false) classes.push(UPPER);
  if (policy.requireLower !== false) classes.push(LOWER);
  if (policy.requireDigit !== false) classes.push(DIGIT);
  if (policy.requireSymbol !== false) classes.push(SYMBOL);
  // Every class switched off would leave nothing to draw from and an empty
  // password. A policy that asks for no character at all is not a policy this
  // function can honour, and the safe reading of it is the default alphabet.
  if (classes.length === 0) classes.push(UPPER, LOWER, DIGIT);
  const alphabet = classes.join('');

  // One character from each required class, then fill, then shuffle — so the
  // result satisfies the policy without a rejection loop that could, on a
  // narrow alphabet, not terminate.
  const chars = classes.map((set) => set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(alphabet[randomInt(alphabet.length)]!);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * The run is not in a state an apply may act on.
 *
 * Applying a run twice, or applying one a later run has already superseded and
 * adopted, rewrites a terminal row's outcome — and a superseded run's actions
 * are the decisions a later run already reversed. A superseded
 * `reactivate_syntra_user` re-applied is a departed person's login handed back,
 * which is route six on this programme's list and the reason Task 15 put the
 * same gate on the action.
 */
export class ProvisionRunNotAppliableError extends Error {
  constructor(
    readonly runId: string,
    readonly status: string,
  ) {
    super(
      `run ${runId} is ${status}, which is not a state an apply may act on; only a previewed or blocked run can be applied`,
    );
    this.name = 'ProvisionRunNotAppliableError';
  }
}

/** A blocked run the guard refused outright, which no confirmation unlocks. */
export class ProvisionRunNotConfirmableError extends Error {
  constructor(
    readonly runId: string,
    readonly blockedReason: string | null,
  ) {
    super(
      `run ${runId} was refused outright and cannot be confirmed: ${blockedReason ?? 'no reason recorded'}`,
    );
    this.name = 'ProvisionRunNotConfirmableError';
  }
}

/**
 * The two statuses an apply may act on.
 *
 * `running` is a preview still in progress, `applying` belongs to another
 * process, and everything else is terminal.
 */
const APPLIABLE_RUN_STATUSES = ['previewed', 'blocked'] as const;

export interface ApplyOptions {
  /** Action ids to apply. Omitted, every proposed action is applied. */
  only?: string[];
  /**
   * A human is applying this deliberately, and `confirmedByUserId` names them.
   *
   * Both are required to satisfy either confirmation gate. Keying the gates on
   * `confirmedByUserId === undefined` alone means `confirmedByUserId: null` —
   * what any internal caller writes when it has nobody to name — satisfies
   * them, so a blocked run applies with no confirming user recorded. The
   * guard's own contract must not depend on a caller's discipline.
   */
  confirm?: boolean;
  confirmedByUserId?: string | null;
  connector?: TargetConnector<never>;
  /**
   * How the initial password is delivered. Absent, the password is still
   * sealed into the vault and an audit event records that delivery could not
   * be attempted — which is a visible gap, not a silent one.
   */
  transport?: Transport;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Both halves, in one place, so no call site can satisfy half of it. */
function isConfirmed(options: ApplyOptions): boolean {
  return (
    options.confirm === true &&
    options.confirmedByUserId !== null &&
    options.confirmedByUserId !== undefined
  );
}

interface ActionRow {
  id: string;
  actionType: string;
  personId: string | null;
  accountId: string | null;
  entitlementId: string | null;
  before: unknown;
  after: unknown;
  attempts: number;
  requiresConfirmation: boolean;
}

/** What the database says about the object this action is aimed at. */
interface ActionContext {
  accountId: string;
  anchor: string | null;
  correlationKey: string;
  entitlementExternalId: string | null;
  /** The entitlements Provision manages for this account, with their DNs. */
  managed: { entitlementId: string; dn: string }[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value === null || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : (value as Record<string, unknown>);

const asAttributes = (value: unknown): Record<string, string[]> =>
  value === null || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : (value as Record<string, string[]>);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Every attribute value the target returned under this name, matched
 * case-insensitively.
 *
 * LDAP attribute names are case-insensitive (RFC 4512) and servers differ on
 * the case they echo back, so `record.attributes.info` is a lookup that works
 * against one directory and silently returns nothing against the next — and
 * "this object carries no provenance marker" is not a value this subsystem may
 * guess at, because the answer to it is whether a create landed. `first()`
 * from `@syntra/connectors` is the single-value half of the same fold; this is
 * the multi-value half, which that function cannot express.
 *
 * Exported so `run-service.ts` reads target attributes the same way. Two folds
 * that must agree is a fold that eventually does not.
 */
export function valuesOf(record: SourceRecord, attribute: string): string[] {
  const wanted = attribute.toLowerCase();
  for (const [key, values] of Object.entries(record.attributes)) {
    if (key.toLowerCase() === wanted) return values;
  }
  return [];
}

/**
 * The distinguished name an object is to be placed at.
 *
 * `escapeDnValue`, always — Ruling P22, at the one site left in this subsystem
 * that renders a DN outside `renderContainer`. The AD connector escapes the
 * correlation key when IT builds the DN and uses
 * `attributes.distinguishedName` **verbatim** when the caller supplies one, so
 * an unescaped value here is a valid distinguished name naming a container
 * nobody chose. Today's generator emits `[a-z0-9.-]` only and cannot produce
 * one; a function that is safe only because of what happens to be upstream of
 * it is a function that will eventually be called with something else.
 */
export function placeAt(correlationKey: string, container: string): string {
  return `CN=${escapeDnValue(correlationKey)},${container}`;
}

function toWriteOperation(
  action: ActionRow,
  context: ActionContext,
  /** Generated by the caller for this create, and by nobody else. */
  initialPassword: string,
): WriteOperation | null {
  const after = asRecord(action.after);
  const before = asRecord(action.before);
  switch (action.actionType) {
    case 'create_container':
      // Applied by `applyContainerAction`, which never reaches this function:
      // it needs no account context and no initial password. Present so the
      // switch stays exhaustive rather than falling to a default nobody reads.
      return null;
    case 'create_account': {
      const correlationKey = text(after.correlationKey) || context.correlationKey;
      const container = text(after.container);
      // A blank container renders `CN=x,` — a malformed DN the directory
      // refuses, one network round trip after it could have been refused here.
      // The empty case, for the fifth time on this slice.
      if (correlationKey === '' || container === '') return null;
      return {
        op: 'create_account',
        actionId: action.id,
        correlationKey,
        attributes: {
          ...asAttributes(after.attributes),
          distinguishedName: [placeAt(correlationKey, container)],
        },
        enabled: after.enabled === true,
        // Generated here, sealed and delivered by `finish`. The connector uses
        // this value and invents nothing.
        initialPassword,
      };
    }
    case 'update_account': {
      if (context.anchor === null) return null;
      const container = text(after.container);
      // The distinguished name is carried ONLY for a move, and the connector
      // treats it as one: it calls `modifyDN` whenever the DN it was handed
      // differs from the object's own. Rebuilding the RDN from the correlation
      // key on every update therefore renames any object whose RDN is not
      // `CN=<sAMAccountName>` — which is a rename, an operation this product
      // makes opt-in and always confirmable, arriving as a side effect of an
      // attribute write.
      //
      // `movesContainer` is the GUARD's predicate, imported rather than
      // restated. The guard counts the moving updates against a threshold, and
      // a second copy of "is this a move" here is how the thing that is capped
      // and the thing that happens come apart.
      const moving = movesContainer(before, after);
      return {
        op: 'update_account',
        actionId: action.id,
        anchor: context.anchor,
        attributes: {
          ...asAttributes(after.attributes),
          ...(moving
            ? { distinguishedName: [placeAt(context.correlationKey, container)] }
            : {}),
        },
      };
    }
    case 'enable_account':
      return context.anchor === null
        ? null
        : { op: 'enable_account', actionId: action.id, anchor: context.anchor };
    case 'disable_account':
      return context.anchor === null
        ? null
        : {
            op: 'disable_account',
            actionId: action.id,
            anchor: context.anchor,
            reason: text(after.reason) || 'no longer required by any business rule',
          };
    case 'archive_account':
      return context.anchor === null
        ? null
        : {
            op: 'archive_account',
            actionId: action.id,
            anchor: context.anchor,
            // ONLY what Provision manages for this account. The connector must
            // not fall back to the object's own memberOf: that strips groups
            // no business rule mentions, on the step spec section 9 calls the
            // closest thing to destructive in the ladder.
            entitlementDns: context.managed.map((m) => m.dn),
          };
    case 'rename_account': {
      const correlationKey = text(after.correlationKey);
      if (context.anchor === null || correlationKey === '') return null;
      return {
        op: 'rename_account',
        actionId: action.id,
        anchor: context.anchor,
        correlationKey,
      };
    }
    case 'grant_entitlement':
    case 'revoke_entitlement':
      return context.anchor === null || context.entitlementExternalId === null
        ? null
        : {
            op: action.actionType,
            actionId: action.id,
            anchor: context.anchor,
            entitlementId: context.entitlementExternalId,
          };
    default:
      // Includes the two Syntra-directory actions, which call no connector at
      // all, and anything unrecognised. There is no delete to fall through to.
      return null;
  }
}

/**
 * Applies a run, one action at a time, in three steps per action.
 *
 * **The transaction shape is the point.** Each action that calls a connector
 * is applied as:
 *
 * 1. One short `withTenant`: mark the action `in_flight`, write the audit
 *    event recording the *intent*, commit.
 * 2. The connector call. No transaction is held. No database connection is
 *    held.
 * 3. One short `withTenant`: write the outcome onto the action, update
 *    `TargetAccount` or `AccountEntitlement`, write the audit event recording
 *    the *result*, commit.
 *
 * There is an honest gap between 2 and 3 that no amount of transaction
 * discipline closes, because the target is not in the database and cannot join
 * a transaction. The `in_flight` marker is what makes that gap observable
 * rather than silent — and recording the intent *before* the call is what
 * makes it resolvable, because an audit log that only records completions
 * cannot distinguish "we never tried" from "we tried and never found out".
 *
 * The two Syntra-directory actions are the only exception: they call no
 * connector, so they apply inside a single transaction with their audit event
 * and need no in-flight resolution.
 *
 * **Every action is attempted, whatever the one before it did.** The loop
 * catches per action rather than per run: an action that throws — a refusal
 * out of `applySyntraUserAction`, a socket that hangs up, a row somebody
 * deleted between the preview and the apply — is marked `failed` and the loop
 * continues. Abandoning the rest of the run on the first throw abandons them
 * in `sequence` order, which puts every disable, revoke, archive and
 * deactivation behind whichever action happened to break; and since Ruling P29
 * a person's two logins are two actions, so one failing must not take the
 * other with it.
 */
export async function applyProvisionRun(
  tenantId: string,
  provider: MasterKeyProvider,
  runId: string,
  options: ApplyOptions = {},
): Promise<{
  status: string;
  applied: number;
  failed: number;
  pendingRetry: number;
  /**
   * Actions whose outcome this apply could not record.
   *
   * The write was attempted; whether it landed is unknown, and the row is left
   * `in_flight` for `resolveInFlightActions` to ask the target about. Counted
   * separately from `failed` because a failure to RECORD an action is not the
   * same event as a failure to PERFORM one.
   */
  inFlight: number;
  /**
   * Actions this apply DEFERRED because they require confirmation and it was
   * not confirmed — a rename, a re-enable outside the window, a re-create of a
   * vanished account.
   *
   * Distinct from `skipped`, which is every action left `proposed` however it
   * got there, including the ones an `only` list deliberately excluded. A
   * scheduled `autoApply` run is where this number matters: it is the whole of
   * "the target looks healthy and is doing nothing", and it used to be
   * computed, returned and discarded.
   */
  deferred: number;
  skipped: number;
}> {
  const sleep = options.sleep ?? defaultSleep;

  const confirmed = isConfirmed(options);
  // One value, used for every event this apply writes. Naming a user who did
  // not confirm anything as the actor on an unconfirmed apply is the same
  // conflation the gate above exists to prevent, one table over.
  const actorUserId = confirmed ? (options.confirmedByUserId ?? null) : null;

  const prepared = await withTenant(tenantId, async (tx) => {
    const run = await tx.provisionRun.findUniqueOrThrow({ where: { id: runId } });
    if (!(APPLIABLE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new ProvisionRunNotAppliableError(runId, run.status);
    }
    if (run.status === 'blocked') {
      // Two different refusals, and only one of them is a question.
      // `GuardVerdict` carries `requiresConfirmation: false` where there is
      // nothing an administrator could usefully confirm — an empty or
      // unreachable target, a collapsed person population, an axis with no
      // denominator — and `ProvisionRun.requiresConfirmation` records it. A
      // gate keyed on the status alone lets a tick override all of them
      // (Ruling P25).
      if (!run.requiresConfirmation) {
        throw new ProvisionRunNotConfirmableError(runId, run.blockedReason);
      }
      if (!confirmed) {
        throw new Error(
          `this run is blocked and has not been confirmed: ${run.blockedReason ?? ''}`,
        );
      }
    }
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: run.targetSystemId },
    });
    const config = await targetWithCredential(tx, provider, run.targetSystemId);
    if (!config) throw new Error('target configuration or credential missing');
    const profile = await tx.accountProfile.findFirst({
      where: { targetSystemId: run.targetSystemId },
    });
    // Provision only ever touches entitlements a business rule for this target
    // names, in both enforcement modes. The archive's strip list is filtered
    // through this.
    const remit = await remitFor(tx, run.targetSystemId);
    // Beside the remit, never merged into it. Archive strips what Provision
    // manages for THIS account, which includes anything a live grant put
    // there; because the filter is per account, widening it here reclassifies
    // nobody else's holdings. See `grantedEntitlementsFor`.
    const grantedEntitlements = await grantedEntitlementsFor(tx, run.targetSystemId);

    await tx.provisionRun.update({
      where: { id: runId },
      data: {
        status: 'applying',
        // The phase transition, stamped. `startedAt` belongs to the preview
        // and answers "when was this plan computed"; overloading it here would
        // make the run's own history unreadable and would still leave the
        // staleness check asking the wrong question. A run previewed at T and
        // confirmed at T+7h is not six hours abandoned — it is one second into
        // writing to a domain controller, and the next scheduled job used to
        // adopt it and start a second run against the same objects.
        lastProgressAt: new Date(),
        // Recorded only when somebody actually confirmed. Writing whatever
        // arrived would put a null in the column on an unconfirmed apply and
        // read as "confirmed by nobody" rather than "not confirmed".
        ...(confirmed ? { confirmedByUserId: options.confirmedByUserId } : {}),
      },
    });
    return { run, target, config, profile, remit, grantedEntitlements };
  });

  const connector = (options.connector ??
    targetConnectorFor(prepared.target.type)) as unknown as TargetConnector<unknown>;

  const actions = await withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({
      where: {
        runId,
        status: { in: ['proposed', 'pending_retry'] },
        ...(options.only === undefined ? {} : { id: { in: options.only } }),
      },
      // Spec section 14's ordering, recoverable because the run wrote it down.
      // `createdAt` cannot carry it: PostgreSQL's now() is transaction start
      // time, so every row phase 7 wrote shares one timestamp and a grant can
      // be attempted before the create it depends on — nondeterministically,
      // which passes CI and fails in production.
      orderBy: { sequence: 'asc' },
    }),
  );

  // Spec section 14 also says writes against a single target run at a bounded
  // concurrency, default 4, and `TargetSystem.concurrency` stores it. This
  // loop is strictly sequential and that setting is not yet honoured. Recorded
  // rather than half-implemented: a bounded pool has to interact correctly
  // with the ordering above, with the throttle budget, and with the fact that
  // two actions for the same person are ordered relative to each other and
  // actions for different people are not. Sequential is slow and correct.

  let applied = 0;
  let failed = 0;
  let pendingRetry = 0;
  let inFlight = 0;
  const deferredIds: string[] = [];
  let heartbeatAt = Date.now();

  for (const action of actions) {
    if (action.requiresConfirmation && !confirmed) {
      // A rename, a re-enable outside the window, or a re-create of a vanished
      // account. Never auto-applied, and never unlocked by a caller that
      // merely passed the parameter — but recorded rather than dropped. Ruling
      // P4 exists because a silent skip is how a target looks healthy while
      // doing nothing, and on an unattended `autoApply` run nobody is watching
      // this happen.
      deferredIds.push(action.id);
      continue;
    }

    // The heartbeat, at most once a minute, in a transaction of its own that
    // holds nothing. The transition stamp above is enough only while an apply
    // is shorter than STALE_RUN_MS; a run with four thousand creates on a slow
    // directory is not, and the staleness check has to keep answering "when
    // did this run last show a sign of life" rather than "when did it begin".
    // One small UPDATE per minute of applying is not a cost worth optimising
    // against a second process writing to the same objects.
    if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
      heartbeatAt = Date.now();
      await withTenant(tenantId, (tx) =>
        tx.provisionRun.update({
          where: { id: runId },
          data: { lastProgressAt: new Date() },
        }),
      );
    }

    let outcome: ActionOutcome;
    try {
      outcome = await applyOneAction(tenantId, provider, action, {
        connector,
        config: prepared.config,
        maxAttempts: prepared.target.maxAttempts,
        targetSystemId: prepared.run.targetSystemId,
        remit: prepared.remit,
        grantedEntitlements: prepared.grantedEntitlements,
        profile: prepared.profile,
        actorUserId,
        sleep,
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      });
    } catch (cause) {
      // A throw out of one action is one action's problem. Left uncaught it
      // abandons every later action in `sequence` order — the disables, the
      // revocations, the archives and, since Ruling P29, the second of a
      // person's two logins.
      outcome = await recordActionThrew(tenantId, action.id, actorUserId, cause);
    }

    if (outcome === 'applied') applied += 1;
    else if (outcome === 'pending_retry') pendingRetry += 1;
    else if (outcome === 'in_flight') inFlight += 1;
    else failed += 1;
  }

  return withTenant(tenantId, async (tx) => {
    // Said on the actions themselves, which is where the run's own screen
    // shows them. A row left `proposed` on a finished run with no message is
    // indistinguishable from one nobody got to.
    if (deferredIds.length > 0) {
      await tx.provisionAction.updateMany({
        where: { runId, id: { in: deferredIds }, status: 'proposed' },
        data: {
          message:
            'not attempted: this action requires an explicit confirmation and this run was not confirmed',
        },
      });
    }

    const remaining = await tx.provisionAction.count({
      where: { runId, status: { in: ['proposed', 'pending_retry', 'in_flight'] } },
    });
    const anyFailed = await tx.provisionAction.count({
      where: { runId, status: { in: ['failed', 'conflict'] } },
    });
    // A run reaches `applied` only when every action it proposed reached a
    // terminal state and none failed.
    const status = remaining === 0 && anyFailed === 0 ? 'applied' : 'partially_applied';
    const skipped = await tx.provisionAction.count({
      where: { runId, status: 'proposed' },
    });
    const deferred = deferredIds.length;

    await tx.provisionRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date() },
    });
    // `applied > 0`, and NOT `status === 'applied'` as well.
    //
    // A run that applied nothing reaches `applied` — no action remained and
    // none failed, which is exactly what an empty plan looks like — and
    // stamping `lastAppliedRunAt` for it flips `hasEverApplied` on a target
    // nothing has ever been written to. The guard then leaves its confirmable
    // first-run branch for the NON-confirmable empty-target refusal, which on
    // a still-empty target can never clear itself: no run can apply, so no run
    // can put an account there, so the refusal holds for ever. The column
    // means "a run has written something at this target", and a run that wrote
    // nothing has not.
    if (applied > 0) {
      await tx.targetSystem.update({
        where: { id: prepared.run.targetSystemId },
        data: { lastAppliedRunAt: new Date() },
      });
    }
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.run.apply',
      targetType: 'ProvisionRun',
      targetId: runId,
      outcome: status === 'applied' ? 'success' : 'failure',
      sourceIp: null,
      payload: { status, applied, failed, pendingRetry, inFlight, deferred, skipped },
    });

    return { status, applied, failed, pendingRetry, inFlight, deferred, skipped };
  });
}

interface ApplyOneOptions {
  connector: TargetConnector<unknown>;
  config: unknown;
  maxAttempts: number;
  targetSystemId: string;
  remit: ReadonlySet<string>;
  /**
   * Entitlements a live grant names on this target. Read beside the remit and
   * never merged into it: the remit is tenant-wide and the archive strip is
   * per account. See `grantedEntitlementsFor`.
   */
  grantedEntitlements: ReadonlySet<string>;
  profile: { initialPasswordPolicy: unknown; initialPasswordDelivery: string } | null;
  actorUserId: string | null;
  sleep: (ms: number) => Promise<void>;
  transport?: Transport;
}

type ActionOutcome =
  | 'applied'
  | 'failed'
  | 'pending_retry'
  | 'conflict'
  | 'in_flight';

/**
 * One action, all three steps.
 *
 * Throws only what the caller records as failed. **A failure to RECORD an
 * action is not the same event as a failure to PERFORM it**, and step 3 is
 * where the two used to be collapsed: a throw out of the finish transaction —
 * Prisma's P2028 is the ordinary one — was recorded as `failed` even though
 * the connector had already answered and the account had already landed at the
 * target. `failed` loses its anchor and its sealed password, and every later
 * run re-proposes the create into a permanent `conflict`.
 *
 * `in_flight` is the state that exists for "we do not know whether this
 * landed", and `resolveInFlightActions` is the machinery that asks the target
 * and resolves it on the next run.
 */
/**
 * `create_container`, which is unlike every other connector action: it names
 * an object rather than a person, so there is no account row to read, no
 * anchor to resolve and no initial password to generate.
 *
 * It is also not retried in a loop. `createContainer` either lands, comes back
 * `conflict` (which is success by adoption), or comes back `not_found` because
 * the parent is missing -- and none of those becomes true on a fourth attempt.
 * A genuinely transient failure leaves the row in state 'desired', so the next
 * run proposes it again, through the guard, in a plan somebody reviews. That
 * is the right place for a write that could not be made now.
 */
async function applyContainerAction(
  tenantId: string,
  action: ActionRow,
  options: ApplyOneOptions,
): Promise<ActionOutcome> {
  const after = asRecord(action.after);
  const dn = text(after.dn);
  const orgUnitContainerId = text(after.orgUnitContainerId);
  if (dn === '' || orgUnitContainerId === '') {
    return finish(tenantId, action.id, {
      ok: false,
      message: 'this action names no container to create',
      failure: 'rejected',
    });
  }

  await withTenant(tenantId, async (tx) => {
    await tx.provisionAction.update({
      where: { id: action.id },
      data: { status: 'in_flight' },
    });
    await recordEvent(tx, {
      actorUserId: options.actorUserId,
      action: 'provision.action.intent',
      targetType: 'ProvisionAction',
      targetId: action.id,
      outcome: 'success',
      sourceIp: null,
      payload: { actionType: action.actionType, dn, attempt: action.attempts + 1 },
    });
  });

  const result = await options.connector.write(options.config as never, {
    op: 'create_container',
    actionId: action.id,
    dn,
  });

  if (result.ok) {
    await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.update({
        where: { id: orgUnitContainerId },
        data: {
          state: 'live',
          ...(result.anchor === undefined ? {} : { anchor: result.anchor }),
        },
      }),
    );
    return finish(tenantId, action.id, result, { attempts: action.attempts + 1 });
  }

  if (result.failure === 'conflict') {
    // Success by adoption. The container is there; Syntra did not put it
    // there. Recorded as 'adopted' rather than 'live' because "we made this"
    // and "this was already here" are different answers to the question
    // somebody asks when a container turns up in a domain nobody expected it
    // in -- and no anchor is recorded, because a conflict returns none.
    await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.update({
        where: { id: orgUnitContainerId },
        data: { state: 'adopted' },
      }),
    );
    return finish(
      tenantId,
      action.id,
      { ok: true, message: `${dn} already existed at the target and was adopted` },
      { attempts: action.attempts + 1 },
    );
  }

  // Everything else leaves the row in 'desired', untouched, so the intent
  // survives and the next run proposes it again.
  return finish(tenantId, action.id, result, { attempts: action.attempts + 1 });
}

async function applyOneAction(
  tenantId: string,
  provider: MasterKeyProvider,
  action: ActionRow,
  options: ApplyOneOptions,
): Promise<ActionOutcome> {
  if ((SYNTRA_ONLY_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
    // No connector, no in-flight window: one transaction with its own audit
    // event, in `syntra-user.ts`, which checks the type and the status itself.
    await applySyntraUserAction(tenantId, action.id, options.actorUserId);
    return 'applied';
  }

  if (action.actionType === 'create_container') {
    // Handled before `readActionContext`, which resolves an ACCOUNT and would
    // answer null for the one action type that names an object instead.
    return applyContainerAction(tenantId, action, options);
  }

  const context = await readActionContext(tenantId, action, options);
  if (context === null) {
    // Every connector action is about an account: the create records its
    // anchor on one, the grant records a holding against one, and the rest
    // address the object through one. Falling back to `findFirst` on a null
    // `personId` — which Prisma drops from the `where` entirely — returns the
    // first account at the target, which is somebody else's.
    return finish(tenantId, action.id, {
      ok: false,
      message: 'this action names no account row at this target, so there is nothing to apply it to',
      failure: 'rejected',
    });
  }

  // Generated per create, here, and carried no further than the operation and
  // `finish`. Not stored on the action, not returned, not logged.
  const initialPassword =
    action.actionType === 'create_account'
      ? generateInitialPassword(
          (options.profile?.initialPasswordPolicy ?? {}) as InitialPasswordPolicy,
        )
      : '';

  const operation = toWriteOperation(action, context, initialPassword);
  if (operation === null) {
    return finish(tenantId, action.id, {
      ok: false,
      message: 'this action could not be expressed as a write operation',
      failure: 'rejected',
    });
  }

  let attempts = action.attempts;
  let result: WriteResult;
  let throttledForMs = 0;
  let throttledAttempts = 0;

  for (;;) {
    const attempt = attempts + 1;

    // Step 1: mark in_flight and record the INTENT, committed before the call.
    // This is what makes the gap observable.
    await withTenant(tenantId, async (tx) => {
      await tx.provisionAction.update({
        where: { id: action.id },
        data: { status: 'in_flight' },
      });
      await recordEvent(tx, {
        actorUserId: options.actorUserId,
        action: 'provision.action.intent',
        targetType: 'ProvisionAction',
        targetId: action.id,
        outcome: 'success',
        sourceIp: null,
        payload: { actionType: action.actionType, attempt },
      });
    });

    // Step 2: the connector call. No transaction. No connection held.
    result = await options.connector.write(options.config as never, operation);

    if (result.ok && operation.op === 'create_account' && result.anchor === undefined) {
      // A create with no anchor is an object Syntra can never address again:
      // the next run cannot match it to the row it reserved, proposes another
      // create, and the connector answers `conflict` — permanently, because
      // the object carries a different action's provenance marker. Retried
      // rather than recorded: the connector's own adopt-by-provenance path
      // returns the anchor once the directory catches up.
      result = {
        ok: false,
        message:
          'the target reported the account was created and returned no anchor for it, so Syntra cannot address the object again',
        failure: 'transient',
      };
    }

    if (result.ok) {
      attempts = attempt;
      break;
    }

    if (result.failure === 'throttled') {
      // Not counted against maxAttempts: a throttle is the target asking for
      // patience, not the operation being wrong. Bounded all the same — see
      // THROTTLE_BUDGET_MS.
      const wait = throttleWait(result.retryAfterMs, attempt);
      throttledAttempts += 1;
      if (
        throttledAttempts >= MAX_THROTTLED_ATTEMPTS ||
        throttledForMs + wait > THROTTLE_BUDGET_MS
      ) {
        attempts = attempt;
        // A retryable failure, so `finish` records `pending_retry`: the action
        // is not wrong, the target is busy, and the next run for this target
        // picks it up provided the plan still wants it.
        result = {
          ok: false,
          message: `the target throttled this action ${throttledAttempts} times over ${Math.round(
            throttledForMs / 1000,
          )}s and did not accept it; the next run for this target picks it up`,
          failure: 'transient',
        };
        break;
      }
      throttledForMs += wait;
      await options.sleep(wait);
      continue;
    }

    attempts = attempt;
    if (!isRetryable(result.failure)) break;
    if (attempts >= options.maxAttempts) break;
    await options.sleep(backoffMs(attempts));
  }

  // Step 3: the outcome, the state change and the RESULT event, together.
  //
  // Wrapped, and ONLY this call. The connector has been asked to perform the
  // operation and has answered; everything left is bookkeeping, and a throw
  // out of bookkeeping — Prisma's P2028 on this transaction is the ordinary
  // one — says nothing about what happened at the target. Recording `failed`
  // there discards a landed create's anchor and its sealed password, and every
  // later run re-proposes the create into a permanent `conflict`. The two
  // `finish` calls above are deliberately outside this: they are reached
  // before step 1 commits and before any connector call, so a throw from
  // either really does mean nothing was attempted.
  try {
    return await finish(tenantId, action.id, result, {
      attempts,
      accountId: context.accountId,
      entitlementId: action.entitlementId,
      actorUserId: options.actorUserId,
      provider,
      targetSystemId: options.targetSystemId,
      // Exactly what the connector was told to strip, so what Syntra records
      // revoked and what it actually removed cannot diverge.
      strippedEntitlementIds: context.managed.map((m) => m.entitlementId),
      ...(action.actionType === 'create_account'
        ? {
            initialPassword,
            delivery: (options.profile?.initialPasswordDelivery ?? 'vaultOnly') as
              | 'manager'
              | 'personalEmail'
              | 'vaultOnly',
            ...(options.transport === undefined ? {} : { transport: options.transport }),
          }
        : {}),
    });
  } catch (cause) {
    return recordActionUnresolved(tenantId, action.id, options.actorUserId, cause);
  }
}

/**
 * An action whose OUTCOME could not be recorded, after the connector was asked
 * to perform it.
 *
 * Left `in_flight` — deliberately, and this is the one place in the apply that
 * leaves a row non-terminal on purpose. The write may have landed; the next
 * run's `resolveInFlightActions` reads the target and answers the question
 * this process cannot. Marking it `failed` would discard a landed create's
 * anchor and its sealed password and re-propose the create into a permanent
 * `conflict`; marking it `applied` would claim something nobody observed.
 *
 * Best-effort, and it swallows its own failure. The likeliest cause of getting
 * here is that the database has just gone away, which is also what would make
 * this write fail; the row is already `in_flight` from step 1, so the state
 * that matters is correct even if the message never lands.
 */
async function recordActionUnresolved(
  tenantId: string,
  actionId: string,
  actorUserId: string | null,
  cause: unknown,
): Promise<'in_flight'> {
  const message = storableMessage(cause instanceof Error ? cause.message : String(cause));
  await withTenant(tenantId, async (tx) => {
    await tx.provisionAction.update({
      where: { id: actionId },
      // The STATUS IS NOT TOUCHED. It is `in_flight` and stays `in_flight`.
      data: {
        message: `this apply could not record the outcome of this action, so whether it landed at the target is unknown until the next run resolves it: ${message}`,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: 'failure',
      sourceIp: null,
      payload: { status: 'in_flight', message },
    });
  }).catch(() => undefined);
  return 'in_flight';
}

/**
 * How long to wait on a throttle.
 *
 * The target's own number when it is one — a positive, finite millisecond
 * count — and the ordinary backoff otherwise. `retryAfterMs` arrives from
 * whatever the target said; zero, a negative number and `NaN` all make the
 * accumulated-wait budget stop advancing, and a budget that does not advance
 * is not a bound.
 */
function throttleWait(retryAfterMs: number | undefined, attempt: number): number {
  return typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
    ? Math.min(retryAfterMs, THROTTLE_BUDGET_MS)
    : backoffMs(attempt);
}

/**
 * Everything one connector action needs from the database, in one short
 * transaction that returns plain data.
 *
 * Null when the action names no account row that exists. Resolved by
 * `accountId` alone: phase 7 fills that column for every action it writes,
 * including the ones whose account it had to reserve first, so a fallback
 * search by `personId` buys nothing and costs the case where `personId` is
 * also null — Prisma drops an `undefined` from a `where`, and
 * `findFirst({ targetSystemId })` then returns the first account at the
 * target, belonging to somebody else entirely.
 */
async function readActionContext(
  tenantId: string,
  action: ActionRow,
  options: ApplyOneOptions,
): Promise<ActionContext | null> {
  if (action.accountId === null) return null;
  return withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.findUnique({
      where: { id: action.accountId! },
    });
    if (account === null || account.targetSystemId !== options.targetSystemId) {
      return null;
    }
    const entitlement =
      action.entitlementId === null
        ? null
        : await tx.entitlement.findUnique({ where: { id: action.entitlementId } });

    // The entitlements Provision manages for this account: what it recorded
    // granting, narrowed to the remit. `archive_account` strips exactly these
    // and nothing else, and `finish` marks exactly these revoked.
    const holdings =
      action.actionType !== 'archive_account'
        ? []
        : await tx.accountEntitlement.findMany({
            where: { accountId: account.id, state: 'held' },
            include: { entitlement: { select: { id: true, dn: true } } },
          });

    return {
      accountId: account.id,
      anchor: account.anchor,
      correlationKey: account.correlationKey,
      entitlementExternalId: entitlement?.externalId ?? null,
      managed: holdings
        // Archive strips what Provision manages for THIS account, which
        // includes anything a live grant put there. Without the second term a
        // requested membership survives on an archived account -- access that
        // outlives employment by the shortest possible route.
        .filter(
          (h) =>
            (options.remit.has(h.entitlement.id) ||
              options.grantedEntitlements.has(h.entitlement.id)) &&
            h.entitlement.dn !== null,
        )
        .map((h) => ({ entitlementId: h.entitlement.id, dn: h.entitlement.dn! })),
    };
  });
}

/**
 * An action whose apply threw outside step 3.
 *
 * Marked failed so the run can carry on, and the throw really is the answer
 * here. A connector does not signal an operational failure by throwing —
 * `adTargetConnector.write` catches everything and returns a `WriteResult`
 * (`ad/connector.ts`, the outer `catch` around the whole switch) — so a throw
 * out of step 2 is a connector that does not honour its contract, not a socket
 * whose answer was lost. A throw out of step 3, where the operation HAS been
 * performed and only the recording failed, goes to `recordActionUnresolved`
 * instead and is left `in_flight`.
 */
async function recordActionThrew(
  tenantId: string,
  actionId: string,
  actorUserId: string | null,
  cause: unknown,
): Promise<'failed'> {
  const message = storableMessage(cause instanceof Error ? cause.message : String(cause));
  await withTenant(tenantId, async (tx) => {
    await tx.provisionAction.update({
      where: { id: actionId },
      // Never left `in_flight`: an action nothing ever resolves is a run the
      // next one has to adopt, and this one is not in an unknown state — the
      // throw is the answer.
      data: { status: 'failed', message },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: 'failure',
      sourceIp: null,
      payload: { status: 'failed', message },
    });
  });
  return 'failed';
}

/**
 * Step 3 for one action: the outcome, the inventory change and the result
 * audit event, in one transaction. Nothing here touches the network, which is
 * what makes that safe.
 */
interface FinishMeta {
  attempts?: number;
  accountId?: string | null;
  entitlementId?: string | null;
  actorUserId?: string | null;
  provider?: MasterKeyProvider;
  targetSystemId?: string;
  /** The entitlements the archive was told to strip, and only those. */
  strippedEntitlementIds?: string[];
  /** Present only on a create. Sealed here, delivered here, kept nowhere else. */
  initialPassword?: string;
  delivery?: 'manager' | 'personalEmail' | 'vaultOnly';
  transport?: Transport;
}

/** Where the message goes, resolved from the person and the delivery mode. */
async function resolveDeliveryAddress(
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
  // `manager`. The manager is on the CONTRACT, not on the person — which is
  // also where department and dates live — so it is read from the primary
  // contract, falling back to the lowest sequence.
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

async function finish(
  tenantId: string,
  actionId: string,
  result: WriteResult,
  meta: FinishMeta = {},
): Promise<'applied' | 'failed' | 'pending_retry' | 'conflict'> {
  // Derived once, before the transaction, because it reaches the action's
  // message, the account's status reason and the audit payload — and a throw
  // out of any of those is a throw out of step 3, which leaves an action the
  // target has already answered stranded `in_flight`.
  const message = storableMessage(result.message);
  const settled = await withTenant(tenantId, async (tx) => {
    const action = await tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } });

    let status: 'applied' | 'failed' | 'pending_retry' | 'conflict';
    if (result.ok) status = 'applied';
    else if (result.failure === 'conflict') status = 'conflict';
    else if (isRetryable(result.failure)) {
      // A retryable failure only ever reaches here having exhausted its
      // attempts or its throttle budget, so this IS the give-up. pending_retry
      // rather than failed: the next run for this target picks it up, provided
      // the plan still wants it. A target that was down for a night does not
      // come back to a queue of decisions made against last night's facts.
      status = 'pending_retry';
    } else status = 'failed';

    await tx.provisionAction.update({
      where: { id: actionId },
      data: {
        status,
        attempts: meta.attempts ?? action.attempts,
        message,
        ...(status === 'applied' ? { appliedAt: new Date() } : {}),
      },
    });

    if (status === 'applied' && meta.accountId) {
      const now = new Date();
      switch (action.actionType) {
        case 'create_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: {
              // Only when the target gave one. `?? null` overwrites an anchor
              // an earlier attempt already recorded.
              ...(result.anchor === undefined ? {} : { anchor: result.anchor }),
              // `active`, including for a pre-hire created disabled. `plan.ts`
              // gates the confirmable re-enable on the RECORDED status, so an
              // account recorded `disabled` with a `disabledAt` of its creation
              // date turns the joiner's first enable — the happy path — into
              // something an administrator has to tick, `preHireDays` after the
              // fact and therefore outside the window.
              status: 'active',
              statusReason: null,
              createdActionId: actionId,
              lastReconciledAt: now,
              lastAppliedAttributes: asAttributes(
                asRecord(action.after).attributes,
              ) as never,
            },
          });
          break;
        case 'update_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: {
              lastAppliedAttributes: asAttributes(
                asRecord(action.after).attributes,
              ) as never,
              lastReconciledAt: now,
            },
          });
          break;
        case 'enable_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            // `disabledAt` cleared with the status it belongs to. A stale date
            // beside an active status is a record of something that is no
            // longer true, and the ladder reads it.
            data: { status: 'active', disabledAt: null },
          });
          break;
        case 'disable_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            // The DATE, always, and not only the status. `plan.ts` refuses to
            // auto-apply a re-enable it cannot show to be inside the
            // `reenableWithoutConfirmationDays` window, and an account recorded
            // disabled with no date cannot be shown to be inside it — so every
            // re-enable of it, forever, needs a tick nobody can explain.
            data: { status: 'disabled', disabledAt: now },
          });
          break;
        case 'archive_account':
          await tx.targetAccount.update({
            where: { id: meta.accountId },
            data: { status: 'archived' },
          });
          // EXACTLY what the connector was told to strip. Marking every held
          // row revoked records the removal of memberships that are still at
          // the target — and it takes them out of drift reporting too, which
          // is "I did not look" rather than "I saw this and left it"
          // (Ruling P2).
          if ((meta.strippedEntitlementIds ?? []).length > 0) {
            await tx.accountEntitlement.updateMany({
              where: {
                accountId: meta.accountId,
                entitlementId: { in: meta.strippedEntitlementIds! },
                state: 'held',
              },
              data: { state: 'revoked', revokedAt: now },
            });
          }
          break;
        case 'rename_account': {
          const correlationKey = text(asRecord(action.after).correlationKey);
          if (correlationKey !== '') {
            await tx.targetAccount.update({
              where: { id: meta.accountId },
              data: { correlationKey },
            });
          }
          break;
        }
        case 'grant_entitlement':
          if (meta.entitlementId) {
            // Not blindly created: there is no unique index over
            // (accountId, entitlementId), so a second row for a holding that
            // is already recorded held is a duplicate nothing ever reconciles.
            const held = await tx.accountEntitlement.findFirst({
              where: {
                accountId: meta.accountId,
                entitlementId: meta.entitlementId,
                state: 'held',
              },
              select: { id: true },
            });
            if (held === null) {
              // The origin is decided by what CAUSED the action, not by a
              // default. `origin` separates convergence from drift and is not
              // derivable after the fact, which is why Provision records it at
              // the moment of the grant -- and a request grant recorded as
              // `rule` would answer "why does this person hold this?" with a
              // rule that does not name it.
              const requestId =
                action.grantId === null
                  ? null
                  : ((
                      await tx.accessGrant.findUnique({
                        where: { id: action.grantId },
                        select: { requestId: true },
                      })
                    )?.requestId ?? null);

              await tx.accountEntitlement.create({
                data: {
                  tenantId: action.tenantId,
                  accountId: meta.accountId,
                  entitlementId: meta.entitlementId,
                  origin: action.grantId === null ? 'rule' : 'request',
                  grantedByRuleId: action.attributedRuleIds[0] ?? null,
                  grantedByRequestId: requestId,
                },
              });
            }
          }
          break;
        case 'revoke_entitlement':
          if (meta.entitlementId) {
            await tx.accountEntitlement.updateMany({
              where: {
                accountId: meta.accountId,
                entitlementId: meta.entitlementId,
                state: 'held',
              },
              data: { state: 'revoked', revokedAt: now },
            });
          }
          break;
      }
    }

    /**
     * The initial password, sealed into the vault in the SAME transaction as
     * the state change that says the account exists.
     *
     * Global Constraint 14 and spec section 18. Without this the password is
     * written to the directory and dropped, so nobody — not the person, not
     * their manager, not an administrator — can ever obtain it, and no account
     * Provision creates is usable by the person it was created for.
     *
     * `putSecret` is inside this transaction because the sealed password and
     * the row that says the account exists have to commit or not commit
     * together — not because the seal is cheap. **It is cheap only under
     * `localMasterKeyProvider`**, where wrapping the data key is a local AES
     * operation. `MasterKeyProvider` is an interface precisely so a KMS-backed
     * provider can be dropped in without any caller changing, and under one
     * this line, and the three other `putSecret` call sites in this package,
     * become network round trips inside `withTenant` — Global Constraint 2's
     * exact prohibition, arriving through a seam designed to be swapped.
     *
     * Not restructured here, because the atomicity is worth more today than
     * the hypothetical is worth avoiding. Written down so that the day a KMS
     * provider is added, this comment does not read as a licence for it.
     *
     * The message is queued AFTER the commit, below: telling somebody their
     * password before the row that says the account exists has committed is
     * the wrong order to fail in.
     */
    let deliver: { to: string; login: string; password: string } | null = null;
    let deliveryNote = 'not applicable';

    if (
      status === 'applied' &&
      action.actionType === 'create_account' &&
      meta.accountId &&
      meta.initialPassword &&
      meta.provider &&
      meta.targetSystemId
    ) {
      await putSecret(
        tx,
        meta.provider,
        `target/${meta.targetSystemId}/initial/${meta.accountId}`,
        meta.initialPassword,
      );

      const account = await tx.targetAccount.findUnique({ where: { id: meta.accountId } });
      const address = await resolveDeliveryAddress(
        tx,
        account?.personId ?? null,
        meta.delivery ?? 'vaultOnly',
      );
      deliveryNote = address.reason;
      if (address.to !== null && meta.transport !== undefined) {
        deliver = {
          to: address.to,
          login: account?.correlationKey ?? '',
          password: meta.initialPassword,
        };
      } else if (address.to !== null) {
        deliveryNote = `${address.reason}, but no message transport was configured for this apply; the password is in the vault and was not sent`;
      }

      await recordEvent(tx, {
        actorUserId: meta.actorUserId ?? null,
        action: 'provision.credential.sealed',
        targetType: 'TargetAccount',
        targetId: meta.accountId,
        outcome: 'success',
        sourceIp: null,
        // The secret's NAME and where it was sent. Never the secret, and never
        // the address of a person who was not sent anything.
        payload: {
          secretName: `target/${meta.targetSystemId}/initial/${meta.accountId}`,
          delivery: meta.delivery ?? 'vaultOnly',
          delivered: deliver !== null,
          note: deliveryNote,
        },
      });
    }

    if (status === 'conflict' && meta.accountId) {
      // Never a silent adoption: anybody able to create an object in the
      // target could otherwise choose a name that causes Syntra to hand them
      // an existing person's account.
      await tx.targetAccount.update({
        where: { id: meta.accountId },
        data: { status: 'conflict', statusReason: message },
      });
    }

    await recordEvent(tx, {
      actorUserId: meta.actorUserId ?? null,
      action: 'provision.action.result',
      targetType: 'ProvisionAction',
      targetId: actionId,
      outcome: result.ok ? 'success' : 'failure',
      sourceIp: null,
      payload: {
        actionType: action.actionType,
        status,
        // The connector's own message. Never a password: no code path puts one
        // in a WriteResult, and no code path puts `unicodePwd` in one either.
        message,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      },
    });

    return { status, deliver };
  });

  // After the commit, and fire-and-forget. `queueMessage` never rejects and
  // never blocks: a dead mail server must not turn a committed apply into a
  // failure, and it reports its own failure to the log and the audit trail.
  if (settled.deliver !== null && meta.transport !== undefined) {
    queueMessage(
      meta.transport,
      {
        to: settled.deliver.to,
        subject: 'Your new account',
        text: `An account has been created for you.\n\nUsername: ${settled.deliver.login}\nPassword: ${settled.deliver.password}\n\nYou will be asked to change it when you first sign in.`,
        html: `<p>An account has been created for you.</p><p>Username: <code>${settled.deliver.login}</code><br>Password: <code>${settled.deliver.password}</code></p><p>You will be asked to change it when you first sign in.</p>`,
      },
      {
        tenantId,
        userId: null,
        // The label, never the body. A delivery-failure audit row is the last
        // place a live credential should end up.
        purpose: 'provision.initial-password',
      },
    );
  }

  return settled.status;
}

/**
 * Resolves actions left `in_flight` by a process that died between step 2 and
 * step 3.
 *
 * An action found `in_flight` is in an *unknown* state, not a failed one, and
 * a run resolves it before planning anything: it reads the target and asks
 * whether the write landed, using the provenance marker for creates.
 *
 * **For the other seven operations it does not compare state, and does not
 * claim to.** They are set back to `proposed` and the next plan decides again.
 * That is safe because those seven are idempotent — `update_account` writes
 * the complete desired set, `enable`/`disable` assert a state rather than
 * toggling it, and grant and revoke are set operations — so replaying one
 * that already landed produces the same result. It is written down here
 * because an earlier docstring said "plain state comparison for everything
 * else", which was not true and would have been read as a guarantee by the
 * next person to add a non-idempotent operation.
 */
/**
 * The attribute each connector's `read()` reports the correlation key under.
 *
 * Active Directory correlates on `sAMAccountName`; SCIM's core schema
 * reserves `userName` for exactly this purpose (RFC 7643 §4.1.1) and
 * `scimTargetConnector.read` reports it under that key. Not part of
 * `TargetConnector` because it names an attribute key in `SourceRecord`
 * rather than a network operation — the same reason `provenanceAttribute`
 * below is read off the config rather than off the connector.
 */
function correlationAttributeFor(targetType: string): string {
  return targetType === 'activeDirectory' ? 'sAMAccountName' : 'userName';
}

export async function resolveInFlightActions(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  options: { connector?: TargetConnector<never> } = {},
): Promise<number> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const actions = await tx.provisionAction.findMany({
      where: { status: 'in_flight', run: { targetSystemId } },
      orderBy: { sequence: 'asc' },
    });
    // The credential is decrypted only when there is something to resolve. A
    // target with nothing in flight is the ordinary case and must not pay for
    // this at all.
    if (actions.length === 0) return { config: null, actions, targetType: null };
    const target = await tx.targetSystem.findUniqueOrThrow({ where: { id: targetSystemId } });
    const config = await targetWithCredential(tx, provider, targetSystemId);
    if (!config) throw new Error('target configuration or credential missing');
    return { config, actions, targetType: target.type };
  });

  if (prepared.actions.length === 0) return 0;

  const connector = (options.connector ??
    targetConnectorFor(prepared.targetType!)) as unknown as TargetConnector<unknown>;

  /**
   * The attribute this target actually keeps the provenance marker in.
   *
   * `adTargetConfigSchema` defaults `provenanceAttribute` to `info` and lets a
   * tenant set anything else — and `createAccount` writes the marker into
   * whatever it says. Reading a hardcoded `info` back therefore finds nothing
   * on any target configured otherwise, so a landed create is never adopted:
   * permanent `conflict`, by a different route to the same place.
   */
  const provenanceAttribute =
    (prepared.config as { provenanceAttribute?: string } | null)?.provenanceAttribute ??
    'info';

  // ONCE, outside any transaction, before the loop. Reading the whole target
  // per in-flight action means a process that died with forty actions in
  // flight reads the entire directory forty times, and every one of those
  // reads returns the same answer.
  const objects: { anchor: string; correlationKey: string; provenance: string[] }[] = [];
  const correlationAttribute = correlationAttributeFor(prepared.targetType!);
  for await (const record of connector.read(prepared.config as never)) {
    objects.push({
      anchor: record.anchor,
      // Folded. Active Directory compares `sAMAccountName` case-insensitively
      // and PostgreSQL does not, so an exact comparison reads a write that
      // landed as one that did not — and the next run then creates a second
      // object and lands in `conflict`. Fifth case defect on this programme.
      correlationKey: (valuesOf(record, correlationAttribute)[0] ?? '').toLowerCase(),
      provenance: valuesOf(record, provenanceAttribute),
    });
  }

  let resolved = 0;
  for (const action of prepared.actions) {
    const key = text(asRecord(action.after).correlationKey).toLowerCase();
    // Only a create is adopted, and only against its OWN provenance marker.
    // An empty key matches an object the target returned no sAMAccountName
    // for, which is the empty-value trap this slice has now hit five times;
    // and matching on the name alone would let anybody able to create an
    // object in the target hand Syntra an existing person's account.
    const landed =
      action.actionType === 'create_account' && key !== ''
        ? objects.find(
            (o) =>
              o.correlationKey === key &&
              // PARSED AND COMPARED WHOLE, with the connector's own parser.
              // `value.includes(action.id)` adopts the account created by
              // action `abc-10` while replaying action `abc-1`, which is the
              // one outcome the marker exists to prevent — handing one
              // person's account to another — and `provenanceActionId` says so
              // in as many words. Their parser and not a second one: the
              // format is written in `@syntra/connectors` and must be read
              // there too, or the two drift and nothing notices.
              o.provenance.some((value) => provenanceActionId(value) === action.id),
          )
        : undefined;

    await withTenant(tenantId, async (tx) => {
      if (landed !== undefined) {
        // Our own previous attempt succeeded and we lost the answer.
        await tx.provisionAction.update({
          where: { id: action.id },
          data: {
            status: 'applied',
            appliedAt: new Date(),
            message:
              'resolved after an interrupted apply: the write had landed, but the initial password it generated was lost with the process and could not be sealed',
          },
        });
        // By id, never by correlation key. Phase 7 fills `accountId` for every
        // action it writes, and a lookup on the key would have to decide what
        // case to compare in — a question with two wrong answers, since
        // PostgreSQL compares exactly and the directory does not.
        const account =
          action.accountId === null
            ? null
            : await tx.targetAccount.findUnique({ where: { id: action.accountId } });
        if (account) {
          await tx.targetAccount.update({
            where: { id: account.id },
            data: {
              anchor: landed.anchor,
              status: 'active',
              // Said plainly rather than left to be discovered. The password
              // was generated in the process that died and is sealed nowhere,
              // because sealing happens in step 3: the account exists, is
              // enabled, and nobody can sign in to it. Silence here is a
              // support call with no starting point.
              statusReason:
                'created by an apply that was interrupted before its initial password could be sealed; the password must be reset before this account can be used',
              createdActionId: action.id,
            },
          });
        }
      } else {
        // It did not land, or it is one of the seven idempotent operations.
        // Back to proposed, so the plan decides again.
        await tx.provisionAction.update({
          where: { id: action.id },
          data: {
            status: 'proposed',
            message: 'resolved after an interrupted apply: the write had not landed',
          },
        });
      }
      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.action.resolve_in_flight',
        targetType: 'ProvisionAction',
        targetId: action.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          actionType: action.actionType,
          landed: landed !== undefined,
          // False whenever a create is adopted: the credential died with the
          // process. Recorded so the gap is countable, not anecdotal.
          credentialSealed: landed === undefined ? null : false,
        },
      });
    });
    resolved += 1;
  }

  return resolved;
}
