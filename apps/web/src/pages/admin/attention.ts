/**
 * The shape of `GET /api/admin/attention/summary`, and the sentences the
 * banner and the Attention tab build from it.
 *
 * A section is `null` when the viewer may not read what it lists, which is
 * different from a section with nothing in it: the banner never says "no runs
 * are waiting" to somebody who cannot see runs.
 */
export interface AttentionRunItem {
  runId: string;
  targetSystemId: string;
  targetName: string;
  status: 'previewed' | 'blocked';
  requiresConfirmation: boolean;
  blockedReason: string | null;
  plannedChanges: number;
  planned: string | null;
  summary: string;
  startedAt: string;
  href: string;
}

/**
 * Changes a finished run left waiting for a person's approval, per target: a
 * rename, a re-enable outside the window. They stop no later run, which is why
 * they went unseen -- the target looked healthy and the rename never happened.
 */
export interface AttentionHeldActionsItem {
  targetSystemId: string;
  targetName: string;
  runId: string;
  count: number;
  actionTypes: string[];
  finishedAt: string | null;
  href: string;
}

export interface AttentionLifecycleItem {
  operationId: string;
  kind: string;
  state: 'failed' | 'awaiting_verification';
  message: string | null;
  updatedAt: string;
  href: string;
}

export interface AttentionChangeItem {
  id: string;
  summary: string;
  changeClass: string;
  requestedAt: string;
  expiresAt: string;
  href: string;
}

export interface AttentionSummary {
  total: number;
  provisionRuns: { count: number; items: AttentionRunItem[] } | null;
  /** Absent from an older API, which is read as nothing to show. */
  heldActions?: { count: number; items: AttentionHeldActionsItem[] } | null;
  lifecycle: { failed: number; awaitingVerification: number; items: AttentionLifecycleItem[] } | null;
  changeRequests: { count: number; items: AttentionChangeItem[] } | null;
}

export const ATTENTION_URL = '/api/admin/attention/summary';
export const ATTENTION_TAB = '/admin/activity?tab=attention';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 items need your attention" */
export function attentionHeadline(total: number): string {
  return `${count(total, 'item needs', 'items need')} your attention`;
}

/**
 * One run, as a sentence: which target, and what it would do.
 *
 * Leads with the target name because that is what an operator recognises; the
 * guard's own reason follows for a held run, since "would create 1 of 2
 * accounts (50.0%), above the 20% threshold" is the thing they must decide.
 */
export function runSentence(item: AttentionRunItem): string {
  const what = item.status === 'blocked'
    ? item.requiresConfirmation ? 'is held for review' : 'was refused by the safety guard'
    : 'is waiting to be applied';
  const detail = item.status === 'blocked'
    ? (item.blockedReason?.split('; ')[0] ?? item.summary)
    : (item.planned ?? 'no changes planned');
  return `A provisioning run on ${item.targetName} ${what} — ${detail}`;
}

const HELD_NOUNS: Record<string, [string, string]> = {
  rename_account: ['rename', 'renames'],
  enable_account: ['re-enable', 're-enables'],
  create_account: ['re-create', 're-creates'],
};

/**
 * "2 renames on Entra ID are waiting for your approval". Named by type when
 * there is one type, because "a rename" is the decision and "a change" is not.
 */
export function heldActionsSentence(item: AttentionHeldActionsItem): string {
  const only = item.actionTypes.length === 1 ? HELD_NOUNS[item.actionTypes[0]!] : undefined;
  const [one, many] = only ?? ['held change', 'held changes'];
  return `${count(item.count, one, many)} on ${item.targetName} ${item.count === 1 ? 'is' : 'are'} waiting for your approval`;
}

/** "1 lifecycle operation failed", "2 onboardings wait for read-back verification". */
export function lifecycleSentences(section: NonNullable<AttentionSummary['lifecycle']>): string[] {
  const lines: string[] = [];
  if (section.failed > 0) lines.push(`${count(section.failed, 'lifecycle operation has', 'lifecycle operations have')} failed`);
  if (section.awaitingVerification > 0) {
    lines.push(`${count(section.awaitingVerification, 'lifecycle operation is', 'lifecycle operations are')} waiting for the target account to be verified`);
  }
  return lines;
}

export function changeRequestSentence(n: number): string {
  return `${count(n, 'privileged change is', 'privileged changes are')} waiting for a second administrator`;
}

/**
 * A fingerprint of what the banner showed. Dismissing it hides exactly this
 * set; anything new arriving later shows the banner again, because a
 * dismissal of yesterday's run is not a dismissal of today's.
 */
export function attentionSignature(summary: AttentionSummary): string {
  return [
    ...(summary.provisionRuns?.items.map((item) => `run:${item.runId}:${item.status}`) ?? []),
    ...(summary.heldActions?.items.map((item) => `held:${item.runId}:${item.count}`) ?? []),
    `lifecycle:${summary.lifecycle?.failed ?? 0}:${summary.lifecycle?.awaitingVerification ?? 0}`,
    `changes:${summary.changeRequests?.count ?? 0}`,
    `runs:${summary.provisionRuns?.count ?? 0}`,
  ].join('|');
}
