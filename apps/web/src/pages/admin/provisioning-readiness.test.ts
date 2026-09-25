import { describe, expect, it } from 'vitest';
import { deriveSetupSteps, overallState, readinessState, unknown, type SetupEvidence } from './provisioning-readiness.js';

const source = { id: 's1', enabled: true, schedule: '0 2 * * *' };
const target = { id: 't1', enabled: true, schedule: '0 3 * * *', autoApply: false };
const correlation = { recordType: 'person', targetField: 'externalId', sourceColumn: 'EmployeeId', isCorrelation: true };

/** Everything proven: a read import, a passed and current test, a fresh preview. */
const proven: SetupEvidence = {
  source,
  mappings: [correlation],
  importRuns: [{ id: 'i1', status: 'applied', startedAt: '2026-09-20T00:00:00Z', recordsRead: 40, mappingFailures: 0 }],
  sample: { personId: 'p1', name: 'Maya Okafor', contracts: 1 },
  target,
  readiness: { current: true, status: 'passed', checkedAt: '2026-09-20T00:00:00Z', adapterWarnings: [] },
  profile: { updatedAt: '2026-09-19T00:00:00Z' },
  rules: [{ enabled: true, grantsAccount: true, entitlements: [], updatedAt: '2026-09-19T00:00:00Z' }],
  runs: [{ id: 'r1', status: 'previewed', startedAt: '2026-09-21T00:00:00Z', personsUnprocessable: 0 }],
};

const state = (evidence: SetupEvidence, key: string) => deriveSetupSteps(evidence).find((step) => step.key === key)!;

describe('deriveSetupSteps', () => {
  it('verifies all eight steps only from tested evidence', () => {
    const steps = deriveSetupSteps(proven);
    expect(steps.map((step) => step.state)).toEqual(Array(8).fill('healthy'));
    expect(steps.map((step) => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(overallState(steps)).toEqual({ state: 'healthy', label: 'Ready' });
  });

  it('never shows saved-but-unexercised configuration as verified', () => {
    const saved: SetupEvidence = { ...proven, importRuns: [], sample: null, readiness: { current: false, status: 'untested' }, runs: [] };
    expect(state(saved, 'hr')).toMatchObject({ state: 'pending', label: 'Saved, not tested' });
    expect(state(saved, 'map')).toMatchObject({ state: 'pending' });
    expect(state(saved, 'target')).toMatchObject({ state: 'pending', label: 'Not tested' });
    expect(state(saved, 'naming')).toMatchObject({ state: 'pending', label: 'Saved, not previewed' });
    expect(state(saved, 'rules')).toMatchObject({ state: 'pending' });
    expect(state(saved, 'preview')).toMatchObject({ state: 'setup' });
    // A saved schedule over unverified steps is a setting, not readiness.
    expect(state(saved, 'schedule')).toMatchObject({ state: 'attention', label: 'Scheduled before verification' });
  });

  it('treats a preview older than the last rule or profile change as stale', () => {
    const edited: SetupEvidence = { ...proven, rules: [{ enabled: true, grantsAccount: true, entitlements: [], updatedAt: '2026-09-22T00:00:00Z' }] };
    expect(state(edited, 'rules')).toMatchObject({ state: 'pending', label: 'Saved, not previewed' });
    expect(state(edited, 'preview')).toMatchObject({ state: 'attention', label: 'Older than configuration' });
    expect(state(edited, 'naming').state).toBe('healthy');
  });

  it('reads a connection test against the saved configuration', () => {
    expect(readinessState({ current: false, status: 'passed' })).toEqual({ state: 'attention', label: 'Changed since test' });
    expect(readinessState({ current: true, status: 'failed' })).toEqual({ state: 'blocked', label: 'Test failed' });
    expect(readinessState({ current: true, status: 'passed', adapterWarnings: ['uncertified'] }).state).toBe('attention');
  });

  it('blocks on the newest run, not an older good one', () => {
    const failed: SetupEvidence = { ...proven, runs: [{ id: 'r2', status: 'failed', startedAt: '2026-09-22T00:00:00Z', error: 'LDAP down' }, ...(proven.runs as never[])] };
    const preview = state(failed, 'preview');
    expect(preview).toMatchObject({ state: 'blocked', href: '/admin/targets/t1/runs/r2' });
    expect(preview.facts).toContainEqual({ label: 'Reason', value: 'LDAP down' });
    expect(overallState(deriveSetupSteps(failed)).state).toBe('blocked');
  });

  it('reports unreadable evidence as unavailable rather than absent', () => {
    const forbidden: SetupEvidence = { ...proven, profile: unknown('Profile access denied') };
    expect(state(forbidden, 'naming')).toMatchObject({ state: 'attention', label: 'Evidence unavailable' });
    expect(state(forbidden, 'naming').facts).toEqual([{ label: 'Account profile', value: 'Profile access denied' }]);
  });

  it('flags mapping failures and an import that read nothing', () => {
    const partial: SetupEvidence = { ...proven, importRuns: [{ id: 'i2', status: 'applied', startedAt: '2026-09-20T00:00:00Z', recordsRead: 40, mappingFailures: 3 }] };
    expect(state(partial, 'map')).toMatchObject({ state: 'attention', label: 'Rows not mapped' });
    const broken: SetupEvidence = { ...proven, importRuns: [{ id: 'i3', status: 'failed', startedAt: '2026-09-20T00:00:00Z', recordsRead: 0, error: 'SFTP refused' }] };
    expect(state(broken, 'hr')).toMatchObject({ state: 'blocked', label: 'Import failed' });
  });

  it('links every unstarted step to the editor that starts it', () => {
    const empty: SetupEvidence = { ...proven, source: null, target: null, mappings: [], importRuns: [], sample: null, profile: null, rules: [], runs: [] };
    const steps = deriveSetupSteps(empty);
    expect(steps.every((step) => step.state === 'setup')).toBe(true);
    expect(steps[0]).toMatchObject({ href: '/admin/person-sources/new', action: 'Connect HR source' });
    expect(steps[3]).toMatchObject({ href: '/admin/targets/new', action: 'Connect target' });
    expect(overallState(steps).state).toBe('setup');
  });
});
