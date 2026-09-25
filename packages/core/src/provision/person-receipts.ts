import { withTenant } from '@syntra/db';
import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Transport } from '../notify/notification-service.js';
import { readBackTarget, targetConnectorFor, type TargetConnector } from '@syntra/connectors';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun, closeEmptyPreviewedRun } from './apply.js';
import { ExternalWritesPausedError } from './target-write-stop.js';
import { AdapterWritesBlockedError } from './adapter-rollout.js';
import { enqueuePairedSync } from './syntra-user.js';
import { targetWithCredential } from './target-service.js';
import { compareObservedState } from '../lifecycle/verification.js';
import { transitionLifecycleStep } from '../lifecycle/operation-service.js';
import { readLifecyclePolicy } from '../lifecycle/policy.js';

export const PERSON_PROVISION_JOB = 'provision.person';
export interface PersonProvisionPayload { tenantId: string; receiptId: string }
const BUSY = ['pending', 'planning', 'deferred'];
/** How long a deferred receipt waits before it asks for a slot again. */
export const DEFERRAL_SECONDS = 30;
/**
 * A target write may be accepted before its read API reflects the change.
 * Keep this small and bounded: after this window the receipt remains visible
 * as manual work instead of allowing a worker to wait forever.
 */
export const READ_BACK_ATTEMPTS = 5;
export const READ_BACK_DELAY_MS = 2_000;

export async function waitForExpectedReadBack(
  read: () => ReturnType<typeof readBackTarget>,
  expected: Parameters<typeof compareObservedState>[0],
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const attempts = Math.max(1, options.attempts ?? READ_BACK_ATTEMPTS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = await read();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const observed = {
      accountPresent: last.account !== null,
      enabled: last.enabled ?? false,
      attributes: {},
      entitlements: last.entitlementIds,
      complete: last.complete && last.enabled !== null,
    };
    if (compareObservedState(expected, observed).matches) return { readBack: last, matched: true, attempts: attempt };
    await sleep(options.delayMs ?? READ_BACK_DELAY_MS);
    last = await read();
  }
  const observed = {
    accountPresent: last.account !== null,
    enabled: last.enabled ?? false,
    attributes: {},
    entitlements: last.entitlementIds,
    complete: last.complete && last.enabled !== null,
  };
  return { readBack: last, matched: compareObservedState(expected, observed).matches, attempts };
}

async function enqueueReceipt(tenantId: string, receiptId: string, scheduler: Scheduler, startAfterSeconds?: number) {
  try {
    const jobId = startAfterSeconds === undefined
      ? await scheduler.enqueue(PERSON_PROVISION_JOB, { tenantId, receiptId })
      : await scheduler.enqueue(PERSON_PROVISION_JOB, { tenantId, receiptId }, { startAfterSeconds });
    if (!jobId) throw new Error('The scheduler did not accept this request. Retry this saved receipt.');
    await withTenant(tenantId, tx => tx.personProvisionReceipt.update({ where: { id: receiptId }, data: { jobId } }));
  } catch (error) {
    await withTenant(tenantId, tx => tx.personProvisionReceipt.updateMany({ where: { id: receiptId, status: { in: ['pending', 'deferred'] } }, data: { status: 'failed', message: error instanceof Error ? error.message : 'Could not queue provisioning' } }));
  }
}

/** One idempotent receipt per requested target; retries never create a person or login. */
export async function requestPersonProvision(tenantId: string, personId: string, requestKey: string, scheduler: Scheduler, targetIds?: string[]) {
  const created = await withTenant(tenantId, async tx => {
    await tx.person.findUniqueOrThrow({ where: { id: personId } });
    const targets = await tx.targetSystem.findMany({ where: { enabled: true, ...(targetIds ? { id: { in: targetIds } } : {}) } });
    const receipts = [];
    for (const target of targets) {
      const existing = await tx.personProvisionReceipt.findUnique({ where: { tenantId_personId_targetSystemId_requestKey: { tenantId, personId, targetSystemId: target.id, requestKey } } });
      if (existing) { receipts.push({ receipt: existing, fresh: false }); continue; }
      const receipt = await tx.personProvisionReceipt.upsert({
        where: { tenantId_personId_targetSystemId_requestKey: { tenantId, personId, targetSystemId: target.id, requestKey } },
        create: { tenantId, personId, targetSystemId: target.id, targetName: target.name, requestKey }, update: {},
      });
      receipts.push({ receipt, fresh: receipt.jobId === null && receipt.status === 'pending' });
    }
    return receipts;
  });
  // Duplicate queue deliveries are harmless: the worker atomically claims each receipt.
  for (const item of created) if (item.fresh) await enqueueReceipt(tenantId, item.receipt.id, scheduler);
  return withTenant(tenantId, tx => tx.personProvisionReceipt.findMany({ where: { personId, requestKey }, orderBy: { createdAt: 'asc' } }));
}

export async function retryPersonProvision(tenantId: string, personId: string, receiptId: string, scheduler: Scheduler) {
  const changed = await withTenant(tenantId, async tx => {
    const receipt = await tx.personProvisionReceipt.findFirstOrThrow({ where: { id: receiptId, personId } });
    if (receipt.status === 'applied') return false;
    // A live worker cannot be overtaken; crashed requests become manually resumable.
    if (BUSY.includes(receipt.status) && Date.now() - receipt.updatedAt.getTime() < 6 * 60 * 60 * 1000) return false;
    return (await tx.personProvisionReceipt.updateMany({ where: { id: receipt.id, updatedAt: receipt.updatedAt }, data: { status: 'pending', message: null, jobId: null } })).count > 0;
  });
  if (changed) await enqueueReceipt(tenantId, receiptId, scheduler);
  return withTenant(tenantId, tx => tx.personProvisionReceipt.findFirstOrThrow({ where: { id: receiptId, personId } }));
}

export interface PersonProvisionOptions { connector?: TargetConnector<never>; transport?: Transport }

/**
 * Receipts are the target-level source of truth, but a lifecycle operation is
 * what operators actually work from. Reflect their aggregate state onto its
 * target step after every durable receipt update. A pending read-back remains
 * running (rather than being marked complete) so it stays in the work queue.
 */
async function reconcileLifecycleTargetStep(tenantId: string, requestKey: string) {
  const state = await withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirst({
      where: { id: requestKey },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!operation) return null;
    const step = operation.steps.find((candidate) => candidate.key === 'targets');
    if (!step) return null;
    const receipts = await tx.personProvisionReceipt.findMany({
      where: { requestKey },
      select: { id: true, targetSystemId: true, status: true, message: true },
    });
    return { operationId: operation.id, stepStatus: step.status, receipts };
  });
  if (!state || state.stepStatus === 'succeeded' || state.stepStatus === 'skipped') return;
  const evidence = {
    receipts: state.receipts.map(({ id, targetSystemId, status, message }) => ({ id, targetSystemId, status, message })),
    targetIds: [...new Set(state.receipts.map((receipt) => receipt.targetSystemId))],
  };
  const failed = state.receipts.filter((receipt) => ['failed', 'blocked'].includes(receipt.status));
  if (failed.length > 0) {
    await transitionLifecycleStep(tenantId, state.operationId, 'targets', 'failed', {
      message: failed.map((receipt) => receipt.message ?? receipt.status).join(' '),
      responseCategory: responseCategoryForReceipts(failed),
      evidence,
    });
  } else if (state.receipts.length > 0 && state.receipts.every((receipt) => ['applied', 'no_match'].includes(receipt.status))) {
    await transitionLifecycleStep(tenantId, state.operationId, 'targets', 'succeeded', {
      message: 'All requested target operations reached their resolved state.',
      responseCategory: state.receipts.every((receipt) => receipt.status === 'no_match') ? 'no_change_required' : 'confirmed',
      evidence,
    });
  } else {
    await transitionLifecycleStep(tenantId, state.operationId, 'targets', 'running', {
      message: 'Waiting for target execution or manual read-back verification.',
      responseCategory: state.receipts.some((receipt) => receipt.status === 'verification_pending') ? 'read_back_incomplete' : null,
      evidence,
    });
  }
}

/**
 * The closed category an operator sees, derived from what the receipts say.
 * A guard refusal is `blocked`; a connector refusal that names itself is
 * carried through; anything else that failed is `unavailable`, which is the
 * honest word for "the target did not agree and did not say why in a way
 * the connector could classify".
 */
function responseCategoryForReceipts(
  receipts: { status: string; message: string | null }[],
): 'blocked' | 'unauthorized' | 'not_found' | 'conflict' | 'throttled' | 'rejected' | 'transient' | 'unavailable' {
  if (receipts.some((receipt) => receipt.status === 'blocked')) return 'blocked';
  const text = receipts.map((receipt) => receipt.message ?? '').join(' ').toLowerCase();
  if (/unauthori[sz]ed|credential|consent|forbidden/.test(text)) return 'unauthorized';
  if (/not found|not_found|no longer exists/.test(text)) return 'not_found';
  if (/conflict/.test(text)) return 'conflict';
  if (/throttl|429|rate limit/.test(text)) return 'throttled';
  if (/rejected|refused/.test(text)) return 'rejected';
  if (/transient|timed out|timeout|unreachable|503|502|500/.test(text)) return 'transient';
  return 'unavailable';
}

/**
 * Verify the account against the target immediately after the durable apply.
 * If an adapter cannot prove every required value, this intentionally leaves
 * the receipt in verification_pending for a human rather than guessing.
 */
async function verifyReceiptAtTarget(
  tenantId: string,
  receiptId: string,
  provider: MasterKeyProvider,
  options: PersonProvisionOptions,
  readBack: { attempts?: number } = {},
): Promise<{ matched: boolean; message: string }> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const receipt = await tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    const [target, account] = await Promise.all([
      tx.targetSystem.findUniqueOrThrow({ where: { id: receipt.targetSystemId } }),
      tx.targetAccount.findFirst({
        where: { personId: receipt.personId, targetSystemId: receipt.targetSystemId },
        include: { entitlements: { include: { entitlement: { select: { externalId: true } } } } },
      }),
    ]);
    const config = await targetWithCredential(tx, provider, target.id);
    return { receipt, target, account, config };
  });
  if (!prepared.account?.anchor || !prepared.config) {
    return { matched: false, message: 'Target identity or credential is unavailable for read-back. Manual verification is required.' };
  }
  const connector = (options.connector ?? targetConnectorFor(prepared.target.type)) as unknown as TargetConnector<unknown>;
  const expected = {
    accountPresent: prepared.account.status !== 'archived',
    enabled: prepared.account.status === 'active',
    attributes: {},
    entitlements: prepared.account.entitlements.map((item) => item.entitlement.externalId).sort(),
  };
  const result = await waitForExpectedReadBack(
    () => readBackTarget(connector, prepared.config, prepared.account!.anchor!),
    expected,
    readBack.attempts === undefined ? {} : { attempts: readBack.attempts },
  );
  if (result.matched) {
    return { matched: true, message: `Target account and entitlement state were confirmed by read-back after ${result.attempts} observation${result.attempts === 1 ? '' : 's'}.` };
  }
  const complete = result.readBack.complete && result.readBack.enabled !== null;
  return {
    matched: false,
    message: complete
      ? `Target state still did not match after ${result.attempts} observations. Manual verification is required.`
      : `Target read-back remained incomplete after ${result.attempts} observations. Manual verification is required.`,
  };
}

export async function runPersonProvision(scheduler: Scheduler, provider: MasterKeyProvider, payload: PersonProvisionPayload, options: PersonProvisionOptions = {}) {
  const { tenantId, receiptId } = payload;
  const claimed = await withTenant(tenantId, tx => tx.personProvisionReceipt.updateMany({ where: { id: receiptId, status: { in: ['pending', 'deferred'] } }, data: { status: 'planning', message: null } }));
  if (!claimed.count) return;
  const receipt = await withTenant(tenantId, tx => tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: receiptId } }));
  // The tenant's concurrency cap. Counted AFTER claiming so two workers
  // racing for the last slot both see each other; the loser steps back with
  // a visible reason and a delayed requeue rather than a silent wait.
  const saturation = await withTenant(tenantId, async tx => {
    const policy = await readLifecyclePolicy(tx);
    const inFlight = await tx.personProvisionReceipt.count({ where: { status: 'planning', id: { not: receiptId } } });
    return { cap: policy.maxConcurrentTargetOperations, inFlight };
  });
  if (saturation.inFlight >= saturation.cap) {
    const evidence = (receipt.evidence ?? {}) as Record<string, unknown>;
    const deferrals = (typeof evidence.deferrals === 'number' ? evidence.deferrals : 0) + 1;
    await withTenant(tenantId, tx => tx.personProvisionReceipt.update({
      where: { id: receiptId },
      data: {
        status: 'deferred',
        message: `Deferred: this tenant already has ${saturation.inFlight} of ${saturation.cap} target operations in flight. Retrying in ${DEFERRAL_SECONDS} seconds (deferral ${deferrals}).`,
        evidence: { ...evidence, deferrals, lastDeferredAt: new Date().toISOString() },
      },
    }));
    await enqueueReceipt(tenantId, receiptId, scheduler, DEFERRAL_SECONDS);
    return;
  }
  const finish = async (status: string, message: string) => {
    const updated = await withTenant(tenantId, tx => tx.personProvisionReceipt.update({ where: { id: receiptId }, data: { status, message } }));
    // Never hide the receipt result if a non-essential operation projection
    // cannot be refreshed (for example, legacy receipts without an operation).
    await reconcileLifecycleTargetStep(tenantId, updated.requestKey).catch(() => undefined);
    return updated;
  };
  try {
    const ready = await withTenant(tenantId, async tx => {
      const target = await tx.targetSystem.findUnique({ where: { id: receipt.targetSystemId } });
      if (!target?.enabled) return 'This target is disabled or has been removed.';
      const active = await tx.provisionRun.findFirst({ where: { targetSystemId: receipt.targetSystemId, status: { in: ['running', 'applying', 'previewed', 'blocked'] } } });
      if (active && (active.id !== receipt.runId || ['running', 'applying'].includes(active.status))) return 'Another run is in progress or awaiting review. Resolve it before retrying.';
      return null;
    });
    if (ready) { await finish('blocked', ready); return; }
    const run = await previewProvisionRun(tenantId, provider, receipt.targetSystemId, { ...options, receiptId });
    if (run.status === 'blocked') { await finish('blocked', run.blockedReason ?? 'Review the guard on the linked run.'); return; }
    const plan = await withTenant(tenantId, async tx => ({
      actions: await tx.provisionAction.findMany({ where: { runId: run.id, personId: receipt.personId } }),
      receipt: await tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: receiptId } }),
    }));
    const evidence = plan.receipt.evidence as { accountRequired?: boolean; evaluated?: boolean; notYetStarted?: boolean; exceptions?: unknown[] } | null;
    // A preview this receipt started that planned nothing for ANYBODY is
    // closed here, before any of the outcomes below. Left `previewed`, it
    // counts as "awaiting review" to every later receipt and scheduled run on
    // this target, which is how one onboarding whose account already existed
    // stopped every onboarding after it. `closeEmptyPreviewedRun` re-checks
    // that the run is `previewed` (never `blocked`) and has no actions and no
    // exceptions at all, so a plan that holds work for somebody else is left
    // exactly as it was, for a person to apply or for the next run to
    // supersede.
    if (run.status === 'previewed') {
      await closeEmptyPreviewedRun(tenantId, run.id, 'A person provisioning request found nothing to change on this target.');
    }
    if ((evidence?.exceptions?.length ?? 0) > 0) { await finish('blocked', 'This person has planning exceptions. Review the linked run.'); return; }
    if (!plan.actions.length) {
      if (evidence?.notYetStarted) await finish('pending', 'The start date is outside the provisioning window. Retry when due.');
      else if (!evidence?.evaluated) await finish('blocked', 'This person was not evaluated by the target.');
      else if (!evidence.accountRequired) await finish('no_match', 'No account is required by the evaluated rules. No access-completion claim is made.');
      else {
        // Nothing to change is a claim about the plan, not about the target:
        // the account may have been created or adopted by a different run,
        // and the plan only compares against the inventory that run left.
        // Read the account back, as the apply path does, before completing
        // anything. Once: nothing was written, so there is no propagation
        // delay to wait out, and a mismatch now is a real one.
        const verification = await verifyReceiptAtTarget(tenantId, receiptId, provider, options, { attempts: 1 })
          .catch((error: unknown) => ({
            matched: false,
            message: `Target read-back failed (${error instanceof Error ? error.message : 'unknown error'}). Manual verification is required.`,
          }));
        await finish(
          verification.matched ? 'applied' : 'verification_pending',
          verification.matched
            ? 'The target plan needed no changes, and the existing account and entitlement state were confirmed by read-back.'
            : `The target plan needed no changes. ${verification.message}`,
        );
      }
      return;
    }
    // The exact persisted plan and explicit person filter are both required.
    const only = plan.actions.filter(action => action.status === 'proposed').map(action => action.id);
    if (only.length) await applyProvisionRun(tenantId, provider, run.id, { ...options, only });
    const observed = await withTenant(tenantId, tx => tx.provisionAction.findMany({ where: { runId: run.id, personId: receipt.personId } }));
    const failed = observed.some(action => ['failed', 'conflict'].includes(action.status));
    const unfinished = observed.some(action => action.status !== 'applied');
    if (failed) await finish('failed', 'Some actions failed. Review the run and retry unfinished work.');
    else if (unfinished) await finish('blocked', 'Some actions require review or confirmation on the run.');
    else {
      const verification = await verifyReceiptAtTarget(tenantId, receiptId, provider, options);
      await finish(verification.matched ? 'applied' : 'verification_pending', verification.message);
    }
    if (observed.some(action => action.status === 'applied')) await enqueuePairedSync(scheduler, tenantId, receipt.targetSystemId);
  } catch (error) {
    // An emergency stop refused before anything was attempted: the work is
    // waiting, not broken, and "failed" would send somebody to debug a target
    // that is fine.
    if (error instanceof ExternalWritesPausedError) {
      await finish('blocked', `${error.message}. Retry after external writes resume.`);
      return;
    }
    if (error instanceof AdapterWritesBlockedError) {
      await finish('blocked', error.message);
      return;
    }
    await finish('failed', error instanceof Error ? error.message : 'Provisioning failed');
  }
}
