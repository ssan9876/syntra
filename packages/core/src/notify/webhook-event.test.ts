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
    for (const key of WEBHOOK_EVENT_GROUP_KEYS) {
      for (const template of WEBHOOK_EVENT_GROUPS[key].templates) {
        expect(TEMPLATES).toHaveProperty(template);
      }
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
