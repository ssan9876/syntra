import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { renderMessage } from '../notify/notification-service.js';
import { TEMPLATES } from '../notify/templates/index.js';
import {
  NEVER_DIGESTED,
  displayNames,
  enqueueOutbox,
  isDigestible,
  nameList,
  recipientsForPersons,
  usersWithPermission,
  type AutomateTemplate,
} from './notify.js';

let tenantId: string;
let annaPersonId: string;
let annaUserId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    return { personId: person.id, userId: user.id };
  });
  annaPersonId = seeded.personId;
  annaUserId = seeded.userId;
});

describe('enqueueOutbox', () => {
  it('writes one unsent row per draft, carrying the request it belongs to', async () => {
    const written = await withTenant(tenantId, (tx) =>
      enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'jan@acme.test',
          vars: { displayName: 'Jan', productName: 'Statistics licence' },
          requestId: null,
          userId: null,
        },
      ]),
    );
    expect(written).toBe(1);

    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template: 'automate-stage-opened',
      to: 'jan@acme.test',
      attempts: 0,
      sentAt: null,
      digest: false,
    });
  });

  it('marks a digestible row for the digest when the recipient asked for one', async () => {
    await withTenant(tenantId, (tx) =>
      tx.notificationPreference.create({
        data: { tenantId, userId: annaUserId, mode: 'daily' },
      }),
    );
    const rows = await withTenant(tenantId, async (tx) => {
      await enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'anna@acme.test',
          vars: {},
          requestId: null,
          userId: annaUserId,
        },
      ]);
      return tx.notificationOutbox.findMany();
    });
    expect(rows[0]?.digest).toBe(true);
  });

  it('never digests a failure, a block or a confirmation, whatever the preference says', async () => {
    // A digest is a convenience for routine traffic. The traffic that matters
    // is the traffic that says something is stuck.
    await withTenant(tenantId, (tx) =>
      tx.notificationPreference.create({
        data: { tenantId, userId: annaUserId, mode: 'daily' },
      }),
    );
    const rows = await withTenant(tenantId, async (tx) => {
      await enqueueOutbox(
        tx,
        NEVER_DIGESTED.map((template) => ({
          template,
          to: 'anna@acme.test',
          vars: {},
          requestId: null,
          userId: annaUserId,
        })),
      );
      return tx.notificationOutbox.findMany();
    });
    expect(rows).toHaveLength(NEVER_DIGESTED.length);
    for (const row of rows) expect(row.digest).toBe(false);
  });

  it('writes nothing for an empty list rather than a row with no recipient', async () => {
    const written = await withTenant(tenantId, (tx) => enqueueOutbox(tx, []));
    expect(written).toBe(0);
  });
});

describe('isDigestible', () => {
  it('agrees with NEVER_DIGESTED for every template that exists', () => {
    for (const template of Object.keys(TEMPLATES) as AutomateTemplate[]) {
      if (!template.startsWith('automate-')) continue;
      expect(isDigestible(template)).toBe(
        !(NEVER_DIGESTED as readonly string[]).includes(template),
      );
    }
  });
});

describe('recipientsForPersons', () => {
  it('returns one recipient per active account, and none for a person with no account', async () => {
    const ghostPersonId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({
        data: { tenantId, givenName: 'Ghost', familyName: 'Test' },
      });
      return p.id;
    });
    const recipients = await withTenant(tenantId, (tx) =>
      recipientsForPersons(tx, [annaPersonId, ghostPersonId]),
    );
    expect(recipients).toEqual([
      {
        userId: annaUserId,
        personId: annaPersonId,
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
      },
    ]);
  });

  it('skips an inactive account', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: annaUserId }, data: { status: 'inactive' } }),
    );
    const recipients = await withTenant(tenantId, (tx) =>
      recipientsForPersons(tx, [annaPersonId]),
    );
    expect(recipients).toEqual([]);
  });
});

describe('usersWithPermission', () => {
  it('finds the holders of a permission through their roles', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders.map((h) => h.userId)).toEqual([annaUserId]);
  });

  it('does not find somebody holding a different permission', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: [PERMISSIONS.AUDIT_READ] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders).toEqual([]);
  });

  it('does not find somebody whose account is inactive', async () => {
    // Telling a deactivated account that a request is stuck reaches nobody and
    // makes the queue look attended.
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: annaUserId },
      });
      await tx.user.update({ where: { id: annaUserId }, data: { status: 'inactive' } });
    });
    const holders = await withTenant(tenantId, (tx) =>
      usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE),
    );
    expect(holders).toEqual([]);
  });
});

describe('displayNames', () => {
  it('names people, products and all three resource types', async () => {
    const seeded = await withTenant(tenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId, name: 'W' },
      });
      const product = await tx.product.create({
        data: {
          tenantId,
          name: 'Statistics licence',
          slug: 'statistics-licence',
          kind: 'application',
          workflowId: workflow.id,
        },
      });
      const application = await tx.application.create({
        data: { tenantId, name: 'Stats', slug: 'stats' },
      });
      const group = await tx.group.create({ data: { tenantId, name: 'Finance Reporting' } });
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-finance',
          type: 'group',
          displayName: 'Finance',
        },
      });
      return {
        productId: product.id,
        applicationId: application.id,
        groupId: group.id,
        entitlementId: entitlement.id,
      };
    });

    const names = await withTenant(tenantId, (tx) =>
      displayNames(tx, {
        personIds: [annaPersonId],
        productIds: [seeded.productId],
        resources: [
          { resourceType: 'application', resourceId: seeded.applicationId },
          { resourceType: 'group', resourceId: seeded.groupId },
          { resourceType: 'entitlement', resourceId: seeded.entitlementId },
        ],
      }),
    );

    expect(names.get(`person:${annaPersonId}`)).toBe('Anna Novak');
    expect(names.get(`product:${seeded.productId}`)).toBe('Statistics licence');
    expect(names.get(`application:${seeded.applicationId}`)).toBe('Stats');
    expect(names.get(`group:${seeded.groupId}`)).toBe('Finance Reporting');
    expect(names.get(`entitlement:${seeded.entitlementId}`)).toBe('Finance');
    expect(
      nameList(names, [
        { resourceType: 'group', resourceId: seeded.groupId },
        { resourceType: 'application', resourceId: seeded.applicationId },
      ]),
    ).toBe('Finance Reporting, Stats');
  });

  it('omits an unknown id rather than returning it, so no caller renders one', async () => {
    const names = await withTenant(tenantId, (tx) =>
      displayNames(tx, { personIds: ['00000000-0000-4000-8000-000000000000'] }),
    );
    expect(names.size).toBe(0);
    expect(
      nameList(names, [
        { resourceType: 'group', resourceId: '00000000-0000-4000-8000-000000000000' },
      ]),
    ).toBe('an unnamed group');
  });
});

describe('no rendered message contains an identifier', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it('exports the guard every service task asserts with', async () => {
    // The shape of the assertion each of Tasks 9, 10, 11, 12, 13 and 15
    // carries against its own outbox rows. A mail reading "guid-4f2a... holds
    // guid-91be... until Mon Jun 15 2026" satisfies none of spec section 13,
    // and Automate sends more mail than the rest of the platform combined.
    const rendered = renderMessage('Acme', 'automate-fulfilled', 'anna@acme.test', {
      displayName: 'Anna Novak',
      subjectName: 'Anna Novak',
      productName: 'Statistics licence',
      resourceList: 'Stats',
      endsAt: '30 June 2026',
      skippedNote: '',
      requestUrl: 'https://syntra.test/requests/x',
    });
    expect(rendered.text).not.toMatch(UUID);
    expect(rendered.html).not.toMatch(UUID);
  });
});

describe('the templates themselves', () => {
  it('leaves an unknown placeholder visible rather than rendering undefined', () => {
    // The existing rule, and it matters more here than anywhere: a request
    // notification with "undefined" where the product name should be is a
    // support ticket, and one with "{{productName}}" is a bug report.
    const message = renderMessage('Acme', 'automate-stage-opened', 'jan@acme.test', {
      displayName: 'Jan',
    });
    expect(message.text).toContain('{{productName}}');
    expect(message.text).not.toContain('undefined');
  });

  it('names the tenant in every automate subject line', async () => {
    for (const template of Object.keys(TEMPLATES)) {
      if (!template.startsWith('automate-')) continue;
      expect(TEMPLATES[template as AutomateTemplate].subject).toContain('{{tenantName}}');
    }
  });
});
