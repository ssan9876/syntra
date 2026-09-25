import { describe, expect, it } from 'vitest';
import { isInFlight, latestPerTarget, lifecycleVerdict, receiptStage, type ReceiptLike } from './lifecycle-verdict.js';

let seq = 0;
function receipt(target: string, status: string, message: string | null = null, minute = seq++): ReceiptLike {
  return {
    id: `r${seq}-${target}`,
    targetSystemId: target,
    status,
    message,
    runId: `run-${target}`,
    createdAt: new Date(Date.UTC(2026, 8, 1, 9, minute)).toISOString(),
  };
}

const active = { personStatus: 'active', liveSignIns: 1, liveTargetAccounts: null };

describe('lifecycleVerdict', () => {
  it('is none for an active person with nothing recorded', () => {
    const result = lifecycleVerdict({ ...active, receipts: [] });
    expect(result.verdict).toBe('none');
    expect(result.state).toBe('setup');
  });

  it('is ready when every target is observed or needs no account', () => {
    const result = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'applied'), receipt('hr', 'no_match')] });
    expect(result).toMatchObject({ verdict: 'ready', label: 'Ready for work', state: 'healthy' });
    expect(result.counts).toMatchObject({ observed: 1, no_account: 1 });
  });

  it('is waiting while a target is planned, applying or awaiting read-back', () => {
    for (const status of ['pending', 'deferred', 'planning', 'applying', 'verification_pending']) {
      const result = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'applied'), receipt('mail', status, 'Confirmed later.')] });
      expect(result.verdict, status).toBe('waiting');
      expect(result.label).toBe('Not ready yet');
    }
  });

  it('never calls applied-but-unobserved work ready', () => {
    const result = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'verification_pending', 'Awaiting read-back.')] });
    expect(result.verdict).toBe('waiting');
    expect(result.counts.awaiting_read_back).toBe(1);
  });

  it('requires intervention for a failed or blocked latest receipt', () => {
    for (const status of ['failed', 'blocked']) {
      const bad = receipt('mail', status, 'Directory unavailable.');
      const result = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'planning'), bad] });
      expect(result).toMatchObject({ verdict: 'intervention', label: 'Requires intervention', state: 'blocked' });
      expect(result.firstIntervention).toBe(bad);
    }
  });

  it('requires intervention when read-back handed the check to a person', () => {
    const manual = receipt('ad', 'verification_pending', 'Target read-back remained incomplete after 3 observations. Manual verification is required.');
    expect(lifecycleVerdict({ ...active, receipts: [manual] }).verdict).toBe('intervention');
    const noReadBack = receipt('hr', 'verification_pending', 'The target plan needed no changes. Confirm the observed account and entitlement state before completing this work.');
    expect(lifecycleVerdict({ ...active, receipts: [noReadBack] }).verdict).toBe('intervention');
  });

  it('judges only the latest receipt per target', () => {
    const resolved = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'applied', null, 50), receipt('ad', 'failed', 'Old failure.', 10)] });
    expect(resolved.verdict).toBe('ready');
    expect(resolved.latest).toHaveLength(1);
    const regressed = lifecycleVerdict({ ...active, receipts: [receipt('ad', 'applied', null, 10), receipt('ad', 'failed', 'New failure.', 50)] });
    expect(regressed.verdict).toBe('intervention');
  });

  it('is ending for an inactive person with live sign-ins or target accounts', () => {
    const base = { personStatus: 'inactive', receipts: [receipt('ad', 'applied')] };
    expect(lifecycleVerdict({ ...base, liveSignIns: 1, liveTargetAccounts: 0 })).toMatchObject({ verdict: 'ending', label: 'Access ending' });
    expect(lifecycleVerdict({ ...base, liveSignIns: 0, liveTargetAccounts: 2 }).verdict).toBe('ending');
  });

  it('does not claim access ended when the target accounts could not be read', () => {
    expect(lifecycleVerdict({ personStatus: 'inactive', receipts: [], liveSignIns: 0, liveTargetAccounts: null }).verdict).toBe('ending');
  });

  it('is ended for an inactive person with nothing live, whatever the joiner receipts said', () => {
    const result = lifecycleVerdict({ personStatus: 'inactive', receipts: [receipt('ad', 'failed')], liveSignIns: 0, liveTargetAccounts: 0 });
    expect(result).toMatchObject({ verdict: 'ended', label: 'Access ended', state: 'inactive' });
  });
});

describe('receipt helpers', () => {
  it('stages every status, counting unknown ones as not yet applied', () => {
    expect(receiptStage({ status: 'applied', message: null })).toBe('observed');
    expect(receiptStage({ status: 'applying', message: null })).toBe('applying');
    expect(receiptStage({ status: 'something_new', message: null })).toBe('planned');
  });

  it('polls only statuses the worker is still moving', () => {
    expect(['pending', 'deferred', 'planning', 'applying'].every(isInFlight)).toBe(true);
    expect(['applied', 'verification_pending', 'failed', 'blocked', 'no_match'].some(isInFlight)).toBe(false);
  });

  it('orders the latest receipts by when their target was first touched', () => {
    const rows = latestPerTarget([receipt('b', 'applied', null, 30), receipt('a', 'applied', null, 20)]);
    expect(rows.map((r) => r.targetSystemId)).toEqual(['a', 'b']);
  });
});
