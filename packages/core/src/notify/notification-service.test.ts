import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport, notify } from './notification-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({
    data: { name: 'Acme Care', slug: 'acme' },
  });
  tenantId = t.id;
});

describe('notify', () => {
  it('renders the tenant name into the message', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', { displayName: 'Jo' }),
    );

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toContain('Acme Care');
    expect(transport.sent[0]!.text).toContain('Jo');
    expect(transport.sent[0]!.to).toBe('jo@acme.test');
  });

  it('escapes html in a variable so a display name cannot inject markup', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', {
        displayName: '<script>alert(1)</script>',
      }),
    );

    expect(transport.sent[0]!.html).not.toContain('<script>');
    expect(transport.sent[0]!.html).toContain('&lt;script&gt;');
  });

  it('leaves the plain-text part unescaped', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', {
        displayName: 'Jo & Sam',
      }),
    );

    // Escaping a text/plain body would show the entity to the reader.
    expect(transport.sent[0]!.text).toContain('Jo & Sam');
  });

  it('throws for an unknown template rather than sending an empty message', async () => {
    const transport = memoryTransport();
    await expect(
      withTenant(tenantId, (tx) =>
        notify(tx, transport, 'nope' as never, 'jo@acme.test', {}),
      ),
    ).rejects.toThrow(/unknown template/i);
    expect(transport.sent).toEqual([]);
  });

  it('leaves an unreplaced placeholder visible rather than sending "undefined"', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', {}),
    );

    expect(transport.sent[0]!.text).not.toContain('undefined');
    expect(transport.sent[0]!.text).toContain('{{displayName}}');
  });

  it('uses each tenant own name', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other Ltd', slug: 'other' },
    });
    const transport = memoryTransport();

    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'a@acme.test', { displayName: 'A' }),
    );
    await withTenant(other.id, (tx) =>
      notify(tx, transport, 'welcome', 'b@other.test', { displayName: 'B' }),
    );

    expect(transport.sent[0]!.subject).toContain('Acme Care');
    expect(transport.sent[1]!.subject).toContain('Other Ltd');
  });

  it('renders the password-changed template', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'password-changed', 'jo@acme.test', {
        displayName: 'Jo',
      }),
    );

    expect(transport.sent[0]!.subject).toMatch(/password/i);
    expect(transport.sent[0]!.text).toContain('Jo');
  });
});
