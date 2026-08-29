import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_GROUPS } from './webhook-event.js';
import {
  isSecurityEvent,
  securityEventActions,
  securityProjection,
} from './security-events.js';

describe('isSecurityEvent', () => {
  it('is true for an action in each of the three groups', () => {
    expect(isSecurityEvent('auth.lockout')).toBe(true);
    expect(isSecurityEvent('mfa.removed')).toBe(true);
    expect(isSecurityEvent('policy.rule_added')).toBe(true);
  });

  it('is false for ordinary traffic', () => {
    expect(isSecurityEvent('application.launch')).toBe(false);
    expect(isSecurityEvent('person.update')).toBe(false);
  });

  it('is false for auth.login, which fires on every sign-in', () => {
    expect(isSecurityEvent('auth.login')).toBe(false);
  });

  it('is derived from the groups rather than restated beside them', () => {
    // Two lists would disagree the first time somebody added an action to a
    // group and forgot the allowlist, and the symptom -- a subscription that
    // matches an event nothing fans out -- looks exactly like a broken
    // receiver.
    for (const key of ['sign-in-security', 'credentials', 'configuration'] as const) {
      for (const action of WEBHOOK_EVENT_GROUPS[key].templates as readonly string[]) {
        expect(isSecurityEvent(action), action).toBe(true);
      }
    }
  });

  it('claims no Automate or Govern template', () => {
    expect(isSecurityEvent('automate-approved')).toBe(false);
    expect(isSecurityEvent('govern-finding-critical')).toBe(false);
  });
});

describe('securityProjection', () => {
  const input = {
    action: 'auth.lockout',
    outcome: 'failure' as const,
    occurredAt: new Date('2026-08-29T12:00:00.000Z'),
    sequence: 41,
    actorUserId: null,
    targetType: 'User',
    targetId: '11111111-2222-4333-8444-555555555555',
  };

  it('carries exactly seven fields and no others', () => {
    // The security property. An audit payload is written for an authenticated
    // console reader; this goes to a URL an administrator typed.
    expect(Object.keys(securityProjection(input)).sort()).toEqual([
      'action',
      'actorUserId',
      'occurredAt',
      'outcome',
      'sequence',
      'targetId',
      'targetType',
    ]);
  });

  it('renders the time as ISO 8601', () => {
    expect(securityProjection(input).occurredAt).toBe('2026-08-29T12:00:00.000Z');
  });

  it('carries the sequence, so a receiver can go and read the row', () => {
    expect(securityProjection(input).sequence).toBe(41);
  });

  it('ignores anything the caller passes that is not on the list', () => {
    // Built field by field rather than spread. A spread would carry whatever
    // the caller happened to hold, silently, the day somebody widened the
    // parameter type.
    const withExtra = securityProjection({
      ...input,
      sourceIp: '198.51.100.9',
      payload: { secretish: 'do-not-forward-me' },
    } as never);
    expect(JSON.stringify(withExtra)).not.toContain('198.51.100.9');
    expect(JSON.stringify(withExtra)).not.toContain('do-not-forward-me');
  });
});

describe('securityEventActions', () => {
  it('lists every action, sorted', () => {
    const actions = securityEventActions();
    expect(actions).toContain('auth.lockout');
    expect(actions).toEqual([...actions].sort());
    expect(new Set(actions).size).toBe(actions.length);
  });
});
