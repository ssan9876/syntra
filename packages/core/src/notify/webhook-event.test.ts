import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_GROUP_KEYS,
  eventMatches,
  webhookBody,
} from './webhook-event.js';
import { TEMPLATES } from './templates/index.js';

describe('eventMatches', () => {
  it('subscribes to everything when no filter is set', () => {
    // The default for a new endpoint. "All of them" has to be the meaning of
    // the empty list, or a freshly created endpoint delivers nothing and
    // looks broken.
    expect(eventMatches([], 'automate-stage-opened')).toBe(true);
  });

  it('matches an exact template name', () => {
    expect(eventMatches(['automate-stage-opened'], 'automate-stage-opened')).toBe(true);
    expect(eventMatches(['automate-stage-opened'], 'govern-finding-critical')).toBe(false);
  });

  it('matches a trailing wildcard', () => {
    expect(eventMatches(['automate-*'], 'automate-stage-opened')).toBe(true);
    expect(eventMatches(['automate-*'], 'govern-finding-critical')).toBe(false);
  });

  it('matches when any one of several entries does', () => {
    const subscribed = ['govern-*', 'automate-fulfilment-failed'];
    expect(eventMatches(subscribed, 'automate-fulfilment-failed')).toBe(true);
    expect(eventMatches(subscribed, 'govern-finding-critical')).toBe(true);
    expect(eventMatches(subscribed, 'automate-stage-opened')).toBe(false);
  });

  it('matches every template in a subscribed group', () => {
    for (const template of WEBHOOK_EVENT_GROUPS.fulfilment.templates) {
      expect(eventMatches(['fulfilment'], template)).toBe(true);
    }
    expect(eventMatches(['fulfilment'], 'automate-stage-opened')).toBe(false);
  });

  it('does not treat a bare prefix as a wildcard', () => {
    // Otherwise "automate" silently subscribes to everything Automate will
    // ever add, which is not what somebody who typed a name meant.
    expect(eventMatches(['automate'], 'automate-stage-opened')).toBe(false);
  });
});

describe('the event groups', () => {
  it('name only templates that exist', () => {
    // Narrowed to the template-backed groups when the security groups landed.
    // Those carry AUDIT ACTION names, which are not templates and never will
    // be -- `source` is what says which kind a group holds, so this invariant
    // keeps its teeth for the six it applies to instead of being deleted.
    for (const key of WEBHOOK_EVENT_GROUP_KEYS) {
      const group = WEBHOOK_EVENT_GROUPS[key];
      if (group.source !== 'template') continue;
      for (const template of group.templates) {
        expect(TEMPLATES).toHaveProperty(template);
      }
    }
  });

  it('says which kind of name every group holds', () => {
    // Without this, a group added with no `source` would silently fall out of
    // the check above rather than failing it.
    for (const key of WEBHOOK_EVENT_GROUP_KEYS) {
      expect(['template', 'audit']).toContain(WEBHOOK_EVENT_GROUPS[key].source);
    }
  });

  it('cover every enqueueable template between them', () => {
    // The groups ARE the console's whole vocabulary. A template in no group is
    // an event nobody can subscribe to from the screen, and nothing would say
    // so -- it would simply never arrive.
    const grouped = new Set<string>(
      WEBHOOK_EVENT_GROUP_KEYS.flatMap((key) => [...WEBHOOK_EVENT_GROUPS[key].templates]),
    );
    const enqueueable = Object.keys(TEMPLATES).filter(
      (name) =>
        (name.startsWith('automate-') || name.startsWith('govern-')) &&
        // The digest is a summary OF other events, not an event.
        name !== 'automate-digest',
    );
    expect([...enqueueable].filter((name) => !grouped.has(name))).toEqual([]);
  });

  it('put each template in exactly one group', () => {
    const seen = new Set<string>();
    for (const key of WEBHOOK_EVENT_GROUP_KEYS) {
      for (const template of WEBHOOK_EVENT_GROUPS[key].templates) {
        expect(seen.has(template)).toBe(false);
        seen.add(template);
      }
    }
  });
});

describe('webhookBody', () => {
  const built = () =>
    webhookBody({
      id: 'a3f0c9d2-0000-4000-8000-000000000001',
      event: 'automate-stage-opened',
      tenantId: 'ten-1',
      occurredAt: new Date('2026-08-26T12:00:00.000Z'),
      requestId: 'req-9',
      recipients: ['approver@example.com', 'other@example.com'],
      data: { productName: 'Finance — read only', requesterName: 'Ada Lovelace' },
    });

  it('is stable json a receiver can verify against the signature', () => {
    // Signed as a string, so the body that is hashed must be the body that is
    // sent, byte for byte. Re-serialising it anywhere between here and the
    // socket would break every signature.
    expect(JSON.parse(built())).toEqual({
      id: 'a3f0c9d2-0000-4000-8000-000000000001',
      event: 'automate-stage-opened',
      tenantId: 'ten-1',
      occurredAt: '2026-08-26T12:00:00.000Z',
      requestId: 'req-9',
      recipients: ['approver@example.com', 'other@example.com'],
      data: { productName: 'Finance — read only', requesterName: 'Ada Lovelace' },
    });
  });

  it('orders its keys the same way every time', () => {
    expect(built()).toBe(webhookBody(JSON.parse(built()) as never));
  });
});

describe('the security groups', () => {
  it('matches a lockout for a sign-in-security subscriber', () => {
    expect(eventMatches(['sign-in-security'], 'auth.lockout')).toBe(true);
    expect(eventMatches(['credentials'], 'mfa.removed')).toBe(true);
    expect(eventMatches(['configuration'], 'policy.rule_added')).toBe(true);
  });

  it('keeps the security and Automate audiences apart', () => {
    // The groups are how somebody says what they want. A ticketing system
    // subscribed to access requests must not start receiving lockouts, and a
    // SIEM subscribed to sign-in security must not receive approvals.
    expect(eventMatches(['access-requests'], 'auth.lockout')).toBe(false);
    expect(eventMatches(['sign-in-security'], 'automate-approved')).toBe(false);
  });

  it('puts no event in two groups', () => {
    // An event in two groups delivers twice to an endpoint subscribed to
    // both, and a receiver cannot tell that from a genuine duplicate.
    const seen = new Set<string>();
    for (const group of Object.values(WEBHOOK_EVENT_GROUPS)) {
      for (const template of group.templates as readonly string[]) {
        expect(seen.has(template), template).toBe(false);
        seen.add(template);
      }
    }
  });

  it('carries auth.login in no group at all', () => {
    // Deliberate. It fires on success as well as failure, so a group holding
    // it would deliver a webhook per sign-in -- a thousand on a Monday morning
    // for a thousand-user tenant, each with its own retry ladder.
    // `auth.lockout` is the aggregated signal, and a receiver that genuinely
    // wants every attempt should read the audit log.
    for (const group of Object.values(WEBHOOK_EVENT_GROUPS)) {
      expect(group.templates as readonly string[]).not.toContain('auth.login');
    }
  });

  it('names every security group with a label somebody could choose from', () => {
    for (const key of ['sign-in-security', 'credentials', 'configuration'] as const) {
      expect(WEBHOOK_EVENT_GROUPS[key].label).toMatch(/\S/);
      expect(WEBHOOK_EVENT_GROUPS[key].templates.length).toBeGreaterThan(0);
    }
  });
});
