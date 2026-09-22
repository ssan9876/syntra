import { describe, expect, it } from 'vitest';
import { compareObservedState, simulateLifecycle } from './verification.js';

describe('observed lifecycle state', () => {
  it('reports literal account and entitlement differences', () => {
    expect(
      compareObservedState(
        { accountPresent: true, enabled: true, attributes: { department: ['Finance'] }, entitlements: ['ap', 'erp'] },
        { accountPresent: true, enabled: false, attributes: { department: ['Sales'] }, entitlements: ['erp', 'legacy'], complete: true },
      ),
    ).toEqual({
      completeness: 'complete',
      matches: false,
      differences: [
        { path: 'enabled', expected: true, observed: false },
        { path: 'attributes.department', expected: ['Finance'], observed: ['Sales'] },
        { path: 'entitlements', expected: ['ap', 'erp'], observed: ['erp', 'legacy'] },
      ],
    });
  });

  it('never treats an incomplete read as verified even when visible values match', () => {
    expect(
      compareObservedState(
        { accountPresent: true, enabled: true, attributes: {}, entitlements: [] },
        { accountPresent: true, enabled: true, attributes: {}, entitlements: [], complete: false },
      ),
    ).toEqual({ completeness: 'incomplete', matches: false, differences: [] });
  });

  it('simulates hire, mover, and leaver without a connector mutation dependency', () => {
    expect(simulateLifecycle('hire', { accountPresent: false, enabled: false, entitlements: [] })).toEqual({
      kind: 'hire',
      effects: ['create account', 'enable account'],
      writesPerformed: false,
    });
    expect(simulateLifecycle('move', { accountPresent: true, enabled: true, entitlements: ['old'] }, ['new'])).toEqual({
      kind: 'move',
      effects: ['grant new', 'revoke old'],
      writesPerformed: false,
    });
    expect(simulateLifecycle('leaver', { accountPresent: true, enabled: true, entitlements: ['old'] })).toEqual({
      kind: 'leaver',
      effects: ['revoke old', 'disable account'],
      writesPerformed: false,
    });
  });
});
