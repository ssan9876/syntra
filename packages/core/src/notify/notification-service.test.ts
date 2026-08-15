import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  memoryTransport,
  renderMessage,
  sendMessage,
} from './notification-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({
    data: { name: 'Acme Care', slug: 'acme' },
  });
  tenantId = t.id;
});

describe('renderMessage', () => {
  it('renders the tenant name into the message', () => {
    const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {
      displayName: 'Jo',
    });
    expect(message.subject).toContain('Acme Care');
    expect(message.text).toContain('Jo');
    expect(message.to).toBe('jo@acme.test');
  });

  it('escapes html in a variable so a display name cannot inject markup', () => {
    const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {
      displayName: '<script>alert(1)</script>',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('leaves the plain-text part unescaped', () => {
    // Escaping a text/plain body would show the entity to the reader.
    const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {
      displayName: 'Jo & Sam',
    });
    expect(message.text).toContain('Jo & Sam');
  });

  it('refuses an unknown template', () => {
    expect(() =>
      renderMessage('Acme Care', 'nope' as never, 'jo@acme.test', {}),
    ).toThrow(/unknown template/i);
  });

  it('leaves an unreplaced placeholder visible rather than rendering "undefined"', () => {
    const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {});
    expect(message.text).not.toContain('undefined');
    expect(message.text).toContain('{{displayName}}');
  });

  it('renders the password-changed template', () => {
    const message = renderMessage(
      'Acme Care',
      'password-changed',
      'jo@acme.test',
      { displayName: 'Jo' },
    );
    expect(message.subject).toMatch(/password/i);
    expect(message.text).toContain('Jo');
  });

  it('names the factor, the time and the source address in factor-added', () => {
    // The three things that let the account owner tell their own enrolment
    // from an attacker's. Without them the mail says only that something
    // happened, which is not actionable.
    const message = renderMessage('Acme Care', 'factor-added', 'jo@acme.test', {
      displayName: 'Jo',
      factor: 'authenticator app',
      when: '2026-08-15T09:00:00.000Z',
      sourceIp: '203.0.113.9',
    });
    expect(message.subject).toContain('second factor');
    expect(message.text).toContain('authenticator app');
    expect(message.text).toContain('2026-08-15T09:00:00.000Z');
    expect(message.text).toContain('203.0.113.9');
    // The sentence that makes it worth sending: a factor added by whoever
    // stole the password outlives the password change.
    expect(message.text).toMatch(/survives a password change/);
  });

  it('uses each tenant own name', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other Ltd', slug: 'other' },
    });

    // The two names are still read per tenant — but each read is its own
    // transaction, and neither of them contains the send.
    const acme = await withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    );
    const otherTenant = await withTenant(other.id, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: other.id } }),
    );

    const first = renderMessage(acme.name, 'welcome', 'a@acme.test', {
      displayName: 'A',
    });
    const second = renderMessage(otherTenant.name, 'welcome', 'b@other.test', {
      displayName: 'B',
    });

    expect(first.subject).toContain('Acme Care');
    expect(second.subject).toContain('Other Ltd');
    expect(first.subject).not.toBe(second.subject);
  });
});

describe('sendMessage', () => {
  it('sends what it was given', async () => {
    const transport = memoryTransport();
    await sendMessage(
      transport,
      renderMessage('Acme Care', 'welcome', 'jo@acme.test', {}),
    );
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('jo@acme.test');
  });
});
