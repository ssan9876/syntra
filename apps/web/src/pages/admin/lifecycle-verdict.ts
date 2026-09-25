import type { State } from '@syntra/ui';

/**
 * The one answer an employee's page owes its reader: can this person work,
 * or has their access ended?
 *
 * Before this, the answer was assembled by the reader from a list of receipts
 * in creation order — so a failed attempt from Monday sat above Tuesday's
 * successful retry and read as the current state, and "verification_pending"
 * printed as a raw word next to a target that had in fact been written. The
 * verdict is derived here, in one pure function, so the header badge, the
 * summary counts and the evidence table cannot disagree with each other.
 *
 * Two rules carry most of the weight:
 *
 * - Only the LATEST receipt per target counts. A retry supersedes what it
 *   retried; the history stays visible in the run, not in the verdict.
 * - Nothing is "ready" until the target has been READ BACK. A write the
 *   connector accepted is not a person who can sign in, and the product's
 *   whole promise is that it never implies otherwise.
 */

export type LifecycleVerdict = 'ready' | 'waiting' | 'intervention' | 'ending' | 'ended' | 'none';

/** The fields of a receipt the verdict reads. The API row carries more. */
export interface ReceiptLike {
  id: string;
  targetSystemId: string;
  status: string;
  message: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface VerdictInput {
  personStatus: string;
  receipts: readonly ReceiptLike[];
  /** Linked Syntra sign-ins still active. Always known from the person record. */
  liveSignIns: number;
  /**
   * Target accounts still active, pending or in conflict. `null` when the
   * caller may not read them (the offboarding preview answered 403): unknown
   * is not zero, and "Access ended" is never claimed on an absence of
   * evidence.
   */
  liveTargetAccounts: number | null;
}

/** Where one target's latest receipt stands, as the summary counts it. */
export type ReceiptStage =
  | 'planned'
  | 'applying'
  | 'awaiting_read_back'
  | 'observed'
  | 'no_account'
  | 'intervention';

export interface VerdictResult {
  verdict: LifecycleVerdict;
  label: string;
  state: State;
  /** Latest receipt per target, oldest target first so the order is stable. */
  latest: ReceiptLike[];
  counts: Record<ReceiptStage, number>;
  /** The first latest receipt that needs a person, if any. */
  firstIntervention: ReceiptLike | null;
}

const VERDICT: Record<LifecycleVerdict, { label: string; state: State }> = {
  ready: { label: 'Ready for work', state: 'healthy' },
  waiting: { label: 'Not ready yet', state: 'pending' },
  intervention: { label: 'Requires intervention', state: 'blocked' },
  ending: { label: 'Access ending', state: 'attention' },
  ended: { label: 'Access ended', state: 'inactive' },
  none: { label: 'No provisioning recorded', state: 'setup' },
};

/**
 * The read-back gave up and handed the check to a person.
 *
 * The core writes "Manual verification is required" whenever an automatic
 * read-back could not confirm the state. It writes one other
 * `verification_pending` message — "the target plan needed no changes.
 * Confirm the observed account…" — on a path that schedules NO read-back at
 * all, so that one is waiting on a person too. Calling it "waiting for
 * read-back" would promise an observation that is never coming.
 */
export function needsManualVerification(receipt: Pick<ReceiptLike, 'status' | 'message'>): boolean {
  return receipt.status === 'verification_pending' && /manual verification|confirm the observed/i.test(receipt.message ?? '');
}

export function receiptStage(receipt: Pick<ReceiptLike, 'status' | 'message'>): ReceiptStage {
  switch (receipt.status) {
    case 'applied':
      return 'observed';
    case 'no_match':
      return 'no_account';
    case 'failed':
    case 'blocked':
      return 'intervention';
    case 'verification_pending':
      return needsManualVerification(receipt) ? 'intervention' : 'awaiting_read_back';
    case 'applying':
      return 'applying';
    // pending, deferred, planning, and anything the server adds later: not
    // yet written. An unknown status is never counted as done.
    default:
      return 'planned';
  }
}

/** Statuses the worker is still moving on its own; worth polling for. */
export function isInFlight(status: string): boolean {
  return ['pending', 'deferred', 'planning', 'applying'].includes(status);
}

function stamp(receipt: ReceiptLike): number {
  return Date.parse(receipt.createdAt) || 0;
}

export function latestPerTarget(receipts: readonly ReceiptLike[]): ReceiptLike[] {
  const latest = new Map<string, ReceiptLike>();
  for (const receipt of receipts) {
    const current = latest.get(receipt.targetSystemId);
    if (!current || stamp(receipt) > stamp(current)) latest.set(receipt.targetSystemId, receipt);
  }
  return [...latest.values()].sort((a, b) => stamp(a) - stamp(b));
}

export function lifecycleVerdict(input: VerdictInput): VerdictResult {
  const latest = latestPerTarget(input.receipts);
  const counts: Record<ReceiptStage, number> = {
    planned: 0,
    applying: 0,
    awaiting_read_back: 0,
    observed: 0,
    no_account: 0,
    intervention: 0,
  };
  let firstIntervention: ReceiptLike | null = null;
  for (const receipt of latest) {
    const stage = receiptStage(receipt);
    counts[stage] += 1;
    if (stage === 'intervention' && !firstIntervention) firstIntervention = receipt;
  }

  const verdict = ((): LifecycleVerdict => {
    // A departed person is judged on what is still live, not on how their
    // joiner receipts ended: "Ready for work" on somebody who left would be
    // the most dangerous sentence this page could print.
    if (input.personStatus !== 'active') {
      const live = input.liveSignIns > 0 || input.liveTargetAccounts === null || input.liveTargetAccounts > 0;
      return live ? 'ending' : 'ended';
    }
    if (latest.length === 0) return 'none';
    if (counts.intervention > 0) return 'intervention';
    if (counts.observed + counts.no_account === latest.length) return 'ready';
    return 'waiting';
  })();

  return { verdict, ...VERDICT[verdict], latest, counts, firstIntervention };
}
