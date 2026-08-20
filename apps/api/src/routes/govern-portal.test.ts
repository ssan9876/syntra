import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser, hashPassword, setPasswordHash } from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const NOW = new Date('2026-06-15T09:00:00Z');

const person: Record<string, string> = {};
let campaignId: string;
let itemId: string;
let unrelatedItemId: string;
let ownItemId: string;

/** A PORTAL session only. No elevate, no permission, no role. */
async function portalCookie(login: string) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: ctx.host }, payload: { login, password: PASSWORD },
  });
  return `syntra_session=${res.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host, cookie }, payload: payload as object });

beforeEach(async () => {
  ctx = await buildTestApp();
  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const tenantId = ctx.tenantId;
    const mk = async (name: string) => {
      const p = await tx.person.create({ data: { tenantId, givenName: name, familyName: 'Test' } });
      await tx.contract.create({
        data: { tenantId, personId: p.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01') },
      });
      const u = await createUser(tx, {
        login: name.toLowerCase(), email: `${name.toLowerCase()}@a.test`, displayName: `${name} Test`,
      });
      await tx.user.update({ where: { id: u.id }, data: { personId: p.id } });
      await setPasswordHash(tx, u.id, PASSWORD_HASH);
      person[name] = p.id;
      return p.id;
    };
    const jan = await mk('Jan');
    const anna = await mk('Anna');
    const ola = await mk('Ola');

    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId, name: 'Q2 review', scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id, reviewerSelector: 'manager', reviewerConfig: {},
        fallbackSelector: 'person', fallbackConfig: { personId: ola },
        ownerPersonId: ola, opensAt: NOW, dueAt: new Date(NOW.getTime() + 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 86_400_000), status: 'open',
      },
    });

    const mkItem = async (subjectId: string, resourceId: string, riskFlags: string[] = []) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId, campaignId: campaign.id, holdingSnapshotId: snapshot.id,
          subjectKey: `person:${subjectId}`, personId: subjectId,
          systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId, resourceName: `Group ${resourceId}`,
          attributions: [], observedAt: NOW, coverageStatus: 'complete', riskFlags,
        },
      });
      return item.id;
    };

    const assigned = await mkItem(anna, 'ent-1');
    const own = await mkItem(jan, 'ent-2');
    const unrelated = await mkItem(anna, 'ent-3');
    for (const id of [assigned, own]) {
      await tx.campaignItemReviewer.create({
        data: { tenantId, itemId: id, personId: jan, via: 'selector' },
      });
    }
    await tx.campaignItemReviewer.create({
      data: { tenantId, itemId: unrelated, personId: ola, via: 'selector' },
    });

    return { campaignId: campaign.id, itemId: assigned, ownItemId: own, unrelatedItemId: unrelated };
  });
  campaignId = seeded.campaignId;
  itemId = seeded.itemId;
  ownItemId = seeded.ownItemId;
  unrelatedItemId = seeded.unrelatedItemId;
});

describe('review authority comes from resolution, never from a permission', () => {
  it('serves a reviewer their own queue with a PORTAL session and no permission at all', async () => {
    // Requiring an administrative session with step-up MFA for reviewing would
    // mean either nobody reviews or everybody gets one, and the second is worse.
    const res = await get('/api/portal/govern/reviews', await portalCookie('jan'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string }[] };
    expect(body.items.map((i) => i.id).sort()).toEqual([itemId, ownItemId].sort());
  });

  it('serves NOTHING to a person who is nobody’s reviewer', async () => {
    const res = await get('/api/portal/govern/reviews', await portalCookie('anna'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it('404s an item that is not assigned to the caller', async () => {
    // 403 would confirm the item exists, and the existence of a holding is
    // itself information about somebody's access.
    const res = await get(`/api/portal/govern/reviews/${unrelatedItemId}`, await portalCookie('jan'));
    expect(res.statusCode).toBe(404);
  });

  it('rejects an ADMIN-only campaign route from a portal session', async () => {
    const res = await get('/api/admin/govern/campaigns', await portalCookie('jan'));
    expect(res.statusCode).toBe(403);
  });
});

describe('deciding', () => {
  it('records itemOpenedAt server-side when the detail is fetched', async () => {
    const cookie = await portalCookie('jan');
    await get(`/api/portal/govern/reviews/${itemId}`, cookie);
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, cookie, {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(200);
    const decision = await withTenant(ctx.tenantId, (tx) => tx.campaignDecision.findFirstOrThrow());
    // Not a client-reported dwell time, which is worth nothing.
    expect(decision.itemOpenedAt.getTime()).toBeLessThanOrEqual(decision.decidedAt.getTime());
  });

  it('refuses a decision on the caller’s OWN access, from the API as well as the console', async () => {
    // Deciding through the API rather than the console is one of the paths
    // Automate enumerated, and it closes here.
    const res = await post(`/api/portal/govern/reviews/${ownItemId}/decide`, await portalCookie('jan'), {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: expect.stringContaining('self_review') });
  });

  it('refuses a revoke with no comment', async () => {
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'revoke', comment: '   ',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('a departed subject', () => {
  beforeEach(async () => {
    await withTenant(ctx.tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: new Date('2026-06-01') },
      }),
    );
  });

  it('refuses a certification and moots the item', async () => {
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'certify', comment: null,
    });
    expect(res.statusCode).toBe(409);
    const item = await withTenant(ctx.tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
  });

  it('ALLOWS a revoke of a departed subject’s access', async () => {
    // A departure never suppresses a revocation.
    const res = await post(`/api/portal/govern/reviews/${itemId}/decide`, await portalCookie('jan'), {
      decision: 'revoke', comment: 'they left',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'revoke_decided' });
  });
});

describe('bulk certify', () => {
  it('refuses a high-risk item IN WORDS and certifies the rest', async () => {
    const highRisk = await withTenant(ctx.tenantId, async (tx) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId: ctx.tenantId, campaignId, holdingSnapshotId: (
            await tx.accessSnapshot.findFirstOrThrow()
          ).id,
          subjectKey: `person:${person['Anna']}`, personId: person['Anna']!,
          systemId: 'sys-1', resourceKind: 'targetEntitlement',
          resourceId: 'ent-9', resourceName: 'Domain Admins',
          attributions: [], observedAt: NOW, coverageStatus: 'complete',
          riskFlags: ['privileged'],
        },
      });
      await tx.campaignItemReviewer.create({
        data: { tenantId: ctx.tenantId, itemId: item.id, personId: person['Jan']!, via: 'selector' },
      });
      return item.id;
    });

    const res = await post('/api/portal/govern/reviews/bulk-certify', await portalCookie('jan'), {
      campaignId, itemIds: [itemId, highRisk],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { certified: number; refused: { itemId: string; reason: string }[] };
    expect(body.certified).toBe(1);
    expect(body.refused[0]).toMatchObject({ itemId: highRisk });
    // In words, not a disabled button with no explanation.
    expect(body.refused[0]!.reason).toContain('one at a time');
  });
});
