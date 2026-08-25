import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  CERTIFYING_TRANSITIONS,
  CampaignDecisionRefusedError,
  DECISION_ENTRY_POINTS,
  HIGH_RISK_FLAGS,
  bulkCertify,
  computeReviewQualitySignals,
  isBulkCertifiable,
  openItem,
  recordCampaignDecision,
} from './decision-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const SYSTEM_AD = '10000000-0000-0000-0000-0000000000ad';

let tenantId: string;
let campaignId: string;
let snapshotId: string;
const person: Record<string, string> = {};
const user: Record<string, string> = {};

/** A person with one open contract and one active login — a valid reviewer. */
async function seedPerson(name: string): Promise<void> {
  const seeded = await withTenant(tenantId, async (tx) => {
    const row = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: row.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
      },
    });
    const login = await createUser(tx, {
      login: name.toLowerCase(),
      email: `${name.toLowerCase()}@acme.test`,
      displayName: `${name} Test`,
    });
    await tx.user.update({ where: { id: login.id }, data: { personId: row.id } });
    return { personId: row.id, userId: login.id };
  });
  person[name] = seeded.personId;
  user[name] = seeded.userId;
}

let resourceSequence = 0;

/** One campaign item over `subject`'s holding of a distinct entitlement. */
async function seedItem(
  subject: string,
  over: { riskFlags?: string[]; coverageStatus?: string } = {},
): Promise<string> {
  resourceSequence += 1;
  const resourceId = `20000000-0000-0000-0000-${String(resourceSequence).padStart(12, '0')}`;
  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.create({
      data: {
        tenantId,
        campaignId,
        holdingSnapshotId: snapshotId,
        subjectKey: `person:${person[subject]!}`,
        personId: person[subject]!,
        systemId: SYSTEM_AD,
        resourceKind: 'targetEntitlement',
        resourceId,
        resourceName: `Group ${resourceSequence}`,
        observedAt: NOW,
        coverageStatus: over.coverageStatus ?? 'complete',
        riskFlags: over.riskFlags ?? [],
      },
    });
    return item.id;
  });
}

/** Assigns `reviewer` to `itemId`, the way Task 18's resolution will. */
async function assign(itemId: string, reviewer: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.campaignItemReviewer.create({
      data: { tenantId, itemId, personId: person[reviewer]!, via: 'selector', assignedAt: NOW },
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  resourceSequence = 0;
  for (const key of Object.keys(person)) delete person[key];
  for (const key of Object.keys(user)) delete user[key];

  for (const name of ['Anna', 'Bram', 'Jan', 'Ola']) await seedPerson(name);

  const seeded = await withTenant(tenantId, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId,
        kind: 'campaign',
        status: 'complete',
        asOf: NOW,
        unattributedAccountCount: 0,
      },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: 'Quarterly review',
        scope: {},
        snapshotId: snapshot.id,
        reviewerSelector: 'manager',
        fallbackSelector: 'campaign_owner',
        ownerPersonId: person['Ola']!,
        opensAt: NOW,
        dueAt: new Date(NOW.getTime() + 14 * 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 14 * 86_400_000),
        status: 'open',
      },
    });
    return { snapshotId: snapshot.id, campaignId: campaign.id };
  });
  snapshotId = seeded.snapshotId;
  campaignId = seeded.campaignId;
});

/**
 * A WRITE of the status, not the WORD.
 *
 * Defined once and used by both structural tests below, because the second test
 * exists to prove this exact pattern is the narrow one. Building it inline in
 * the scan and asserting about it somewhere else is how the two drift, and a
 * scan whose regex nothing constrains is a scan that can be widened back to
 * `/['"]certified['"]/` — at which point every legitimate READ of the status is
 * an offender, and the cheapest fix is to add those files to
 * `DECISION_ENTRY_POINTS`, which permits them to WRITE it.
 */
const CERTIFY_WRITE = /status:\s*['"]certified['"]/;

describe('the structural tests that must fail if somebody forgets', () => {
  it('every transition into `certified` is caused by a CampaignDecision row', () => {
    // Exhaustive over the item state machine. This is the test that would fail
    // if anybody ever adds a negative-confirmation setting.
    expect(CERTIFYING_TRANSITIONS.length).toBeGreaterThan(0);
    for (const transition of CERTIFYING_TRANSITIONS) {
      expect(transition.causedBy).toBe('CampaignDecision');
    }
    expect(CERTIFYING_TRANSITIONS.map((t) => t.from)).toEqual(['pending']);
  });

  it('only the files in DECISION_ENTRY_POINTS WRITE status = certified', () => {
    // A convention that lives in a document is a convention that survives until
    // the third person touches the code.
    //
    // THE REGEX MATCHES A WRITE, NOT THE WORD. `/['"]certified['"]/` matches
    // every READ of the status too, so every file comparing against it would be
    // an offender on day one and the cheapest fix would be to add them to
    // `DECISION_ENTRY_POINTS` — at which point the test PERMITS those files to
    // write `certified` and proves nothing.
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => CERTIFY_WRITE.test(readFileSync(join(dir, f), 'utf8')))
      .filter((f) => !DECISION_ENTRY_POINTS.includes(f));
    expect(offenders).toEqual([]);
    // ONE entry. Growing this list is the failure mode, not the fix.
    expect(DECISION_ENTRY_POINTS).toEqual(['decision-service.ts']);
  });

  it('reading the status is still allowed, which is what makes the write test meaningful', () => {
    // The negative half: the scan must match a WRITE and not the WORD. If it is
    // ever widened back to `/['"]certified['"]/`, the test above silently
    // becomes a test about vocabulary.
    //
    // ASSERTED ON THE PATTERN, AND ON `decision-service.ts` ITSELF — never on a
    // second file. A witness file chosen today stops witnessing the moment
    // somebody rewrites the one comparison it stands on. The pattern is the
    // invariant; assert the invariant.
    expect(CERTIFY_WRITE.test("if (item.status === 'certified') return;")).toBe(false);
    expect(CERTIFY_WRITE.test('const done = items.filter((i) => i.status === "certified");')).toBe(
      false,
    );
    expect(CERTIFY_WRITE.test("where: { status: 'certified' }")).toBe(true);
    expect(CERTIFY_WRITE.test('data: { status: "certified" }')).toBe(true);

    // And it must still match the one file that legitimately writes it, so the
    // scan above cannot pass by matching nothing at all.
    const dir = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(dir, 'decision-service.ts'), 'utf8')).toMatch(CERTIFY_WRITE);
  });

  it('no Govern function whose job is closing, sweeping or expiring CERTIFIES', () => {
    // Scoped to the FUNCTION, not to a character window.
    //
    // A proximity regex (`/close[\s\S]{0,600}status: 'certified'/`) depends on
    // how far apart the two happen to sit in the file: a `status: 'certified'`
    // forty lines below `export async function closeDueCampaigns` is more than
    // 600 characters away and slips through, which is exactly where such a
    // write would be. Splitting on the top-level function declarations and
    // checking the whole body of any function NAMED for closing, sweeping,
    // timing out or expiring does not depend on layout at all.
    //
    // This is the half `DECISION_ENTRY_POINTS` cannot cover: that scan permits
    // `decision-service.ts` to write the status, so a certify-on-timeout added
    // to THIS file would pass it.
    const dir = dirname(fileURLToPath(import.meta.url));
    const DECLARATION = /^(?:export )?(?:async )?function (\w+)/gm;
    const TIMEOUT_NAME = /close|sweep|timeout|expire/i;

    for (const file of readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    )) {
      const text = readFileSync(join(dir, file), 'utf8');
      const declarations = [...text.matchAll(DECLARATION)];
      for (const [index, declaration] of declarations.entries()) {
        const name = declaration[1]!;
        if (!TIMEOUT_NAME.test(name)) continue;
        const body = text.slice(
          declaration.index!,
          declarations[index + 1]?.index ?? text.length,
        );
        expect(
          CERTIFY_WRITE.test(body),
          `${file}: ${name}() certifies, and silence must never certify`,
        ).toBe(false);
      }
    }
  });

  it('has NO bulk revoke at all', () => {
    // Revoking is one at a time, with a comment, and the batch of §13 is what
    // makes the aggregate safe.
    const dir = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(dir, 'decision-service.ts'), 'utf8');
    expect(/export async function bulkRevoke/.test(text)).toBe(false);
  });
});

describe('the self-review invariant, at the moment of decision', () => {
  it('refuses a decision by the subject, even when a reviewer row somehow names them', async () => {
    // Enforced in the domain service, at the moment of decision, as well as at
    // resolution — because deciding through the API rather than the console is
    // one of the paths Automate enumerated and closed.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Anna');
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Anna']!,
          deciderUserId: user['Anna']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'self_review' });
  });

  it('refuses a decision by somebody who is not a reviewer of this item', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Ola']!,
          deciderUserId: user['Ola']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'not_reviewer' });
  });

  it('RE-CHECKS reviewer validity at the moment of the decision', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.user.updateMany({ where: { personId: person['Jan']! }, data: { status: 'inactive' } }),
    );
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'reviewer_invalid' });
  });
});

describe('a departed subject', () => {
  it('REFUSES a certification and moots the item instead', async () => {
    // A certification is a signed statement about somebody's access. Signing
    // one for a person who left is exactly the false assurance this module
    // exists to prevent.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-06-01') },
      }),
    );

    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'subject_departed' });

    // THE ASSERTION IS ON THE ITEM, NOT ON THE THROW.
    //
    // A version that set `status: 'moot'` and then threw inside the SAME
    // `withTenant` would have the throw roll the update back with it: the item
    // stays `pending`, the reviewer is told it "is now moot" when it is not,
    // and at `dueAt` the item becomes `undecided` and raises a remediation item
    // — so a leaver's holding lands in the manual-chase queue instead of on the
    // `moot` line. A test that asserted only the rejection would pass against
    // that code.
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
    expect(item.statusReason).toContain('contracts have all ended');

    // And a second attempt refuses on the item's status rather than repeating
    // the departure refusal, because the moot really happened.
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'item_not_pending' });
  });

  it('ALLOWS a revoke decision on a departed subject’s item', async () => {
    // A departure never suppresses a revocation. A leaver's access must still
    // be removable, and the decision dispatches.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-06-01') },
      }),
    );
    const result = await recordCampaignDecision(
      tenantId,
      {
        itemId,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
        decision: 'revoke',
        comment: 'they left; remove it',
      },
      { now: NOW },
    );
    expect(result.status).toBe('revoke_decided');
  });
});

describe('recording a decision', () => {
  it('writes the decision, the item status, the audit event and the projection', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await openItem(tenantId, person['Jan']!, itemId, NOW);
    const decidedAt = new Date(NOW.getTime() + 45_000);

    await recordCampaignDecision(
      tenantId,
      {
        itemId,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
        decision: 'certify',
        comment: null,
      },
      { now: decidedAt },
    );

    const [decision, item, projection, event] = await withTenant(tenantId, async (tx) => [
      await tx.campaignDecision.findFirstOrThrow(),
      await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
      await tx.holdingCertification.findFirstOrThrow(),
      await tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.decision.record' } }),
    ]);

    expect(item.status).toBe('certified');
    expect(decision.decidedByUserId).toBe(user['Jan']);
    // The SERVER-SIDE interval, not a client-reported dwell time.
    expect(decision.itemOpenedAt).toEqual(NOW);
    expect(decision.sessionDecisionOrdinal).toBe(1);
    expect(projection).toMatchObject({
      lastCertifiedByPersonId: person['Jan'],
      lastDecisionId: decision.id,
    });
    expect(event.targetId).toBe(itemId);
  });

  it('requires a comment on a revoke and refuses one without', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'revoke',
          comment: '   ',
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'comment_required' });
  });

  it('requires a comment to certify an UNATTRIBUTABLE holding', async () => {
    // "Somebody said it was fine" is not a record. The one holding whose cause
    // nobody can name is the one whose certification has to name a human.
    const itemId = await seedItem('Anna', { riskFlags: ['unattributable'] });
    await assign(itemId, 'Jan');
    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'comment_required' });
  });

  it('records itemOpenedAt as the decision time when the detail was NEVER fetched', async () => {
    // The share of items whose detail was never fetched at all is one of the
    // quality signals, so "never opened" has to be representable rather than
    // silently becoming a zero interval.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await recordCampaignDecision(
      tenantId,
      {
        itemId,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
        decision: 'certify',
        comment: null,
      },
      { now: NOW },
    );
    const decision = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findFirstOrThrow(),
    );
    expect(decision.itemOpenedAt).toEqual(decision.decidedAt);
    expect(decision.neverOpened).toBe(true);
  });

  it('increments the session ordinal across consecutive decisions', async () => {
    const a = await seedItem('Anna');
    const b = await seedItem('Bram');
    await assign(a, 'Jan');
    await assign(b, 'Jan');
    for (const itemId of [a, b]) {
      await recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      );
    }
    const decisions = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findMany({ orderBy: { sessionDecisionOrdinal: 'asc' } }),
    );
    expect(decisions.map((d) => d.sessionDecisionOrdinal)).toEqual([1, 2]);
  });
});

describe('bulk certify', () => {
  it('caps at bulkCertifyLimit and refuses a larger selection', async () => {
    // The cap is TENANT-WIDE, so a campaign cannot quietly raise it for itself.
    await withTenant(tenantId, (tx) =>
      tx.governSettings.upsert({
        where: { tenantId },
        create: { tenantId, bulkCertifyLimit: 2 },
        update: { bulkCertifyLimit: 2 },
      }),
    );
    const ids = [await seedItem('Anna'), await seedItem('Bram'), await seedItem('Anna')];
    for (const id of ids) await assign(id, 'Jan');
    await expect(
      bulkCertify(
        tenantId,
        {
          campaignId,
          itemIds: ids,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'bulk_too_large' });
  });

  it('REFUSES a high-risk item from the bulk action and certifies the rest', async () => {
    const ordinary = await seedItem('Anna');
    const privileged = await seedItem('Bram', { riskFlags: ['privileged'] });
    const unattributable = await seedItem('Anna', { riskFlags: ['unattributable'] });
    const stale = await seedItem('Bram', { riskFlags: ['stale'] });
    const mover = await seedItem('Anna', { riskFlags: ['needs_review'] });
    const partial = await seedItem('Bram', { coverageStatus: 'partial' });
    const all = [ordinary, privileged, unattributable, stale, mover, partial];
    for (const id of all) await assign(id, 'Jan');

    const result = await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: all,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
      },
      { now: NOW },
    );

    expect(result.certified).toBe(1);
    expect(result.refused.map((r) => r.itemId).sort()).toEqual(
      [privileged, unattributable, stale, mover, partial].sort(),
    );
    // Refused IN WORDS, not as a disabled button with no explanation.
    expect(result.refused[0]!.reason).toContain('one at a time');
  });

  it('records viaBulk and the SIZE on every decision it produces', async () => {
    const ids = [await seedItem('Anna'), await seedItem('Bram')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: ids,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
      },
      { now: NOW },
    );

    const decisions = await withTenant(tenantId, (tx) => tx.campaignDecision.findMany());
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) {
      expect(decision).toMatchObject({ viaBulk: true, bulkSize: 2 });
    }
  });

  it('writes ONE audit event naming every item, not one per item', async () => {
    // recordEvent takes a per-tenant advisory lock for the duration of its
    // transaction, so fifty thousand separately-audited decisions would be
    // fifty thousand serialized transactions on one tenant's chain. Nothing is
    // lost: CampaignDecision is append-only, one row per decision, complete.
    const ids = [await seedItem('Anna'), await seedItem('Bram')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: ids,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
      },
      { now: NOW },
    );

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'govern.decision.bulk_certify' } }),
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { itemIds?: string[] }).itemIds).toHaveLength(2);
  });

  it('refuses bulk entirely when the campaign disallows it', async () => {
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { allowBulkCertify: false } }),
    );
    const ids = [await seedItem('Anna')];
    await assign(ids[0]!, 'Jan');
    await expect(
      bulkCertify(
        tenantId,
        {
          campaignId,
          itemIds: ids,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'bulk_not_allowed' });
  });

  it('classifies the carve-outs the same way one at a time as in bulk', () => {
    // The pure predicate, so the vocabulary cannot drift between the two paths.
    for (const flag of HIGH_RISK_FLAGS) {
      expect(isBulkCertifiable({ riskFlags: [flag], coverageStatus: 'complete' })).toBe(false);
    }
    expect(isBulkCertifiable({ riskFlags: [], coverageStatus: 'partial' })).toBe(false);
    expect(isBulkCertifiable({ riskFlags: [], coverageStatus: 'unread' })).toBe(false);
    expect(isBulkCertifiable({ riskFlags: [], coverageStatus: 'complete' })).toBe(true);
  });
});

describe('quality signals', () => {
  it('computes the share certified, the median interval, the bulk share and the largest burst', async () => {
    const ids = [await seedItem('Anna'), await seedItem('Bram'), await seedItem('Anna')];
    for (const id of ids) await assign(id, 'Jan');
    await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: ids.slice(0, 2),
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
      },
      { now: NOW },
    );
    await recordCampaignDecision(
      tenantId,
      {
        itemId: ids[2]!,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
        decision: 'revoke',
        comment: 'not needed',
      },
      { now: new Date(NOW.getTime() + 120_000) },
    );

    const computed = await computeReviewQualitySignals(tenantId, campaignId, NOW);
    expect(computed).toBe(1);
    const signal = await withTenant(tenantId, (tx) =>
      tx.reviewQualitySignal.findFirstOrThrow(),
    );
    // All three decisions are consecutive by `sessionDecisionOrdinal`, so the
    // run is 3 — not `max(bulkSize)`, which is 2.
    expect(signal).toMatchObject({ itemsDecided: 3, largestBurst: 3 });
    expect(signal.certifiedShare).toBeCloseTo(2 / 3, 5);
    expect(signal.bulkShare).toBeCloseTo(2 / 3, 5);
    expect(signal.neverOpenedShare).toBe(1);
    // The elapsed time across the run, which §12 asks for.
    expect(signal.largestBurstMs).toBe(120_000);
  });

  it('largestBurst counts a RUN OF CONSECUTIVE DECISIONS, not the biggest bulk action', async () => {
    // `max(bulkSize)` reports 0 for a reviewer who decides forty items one at a
    // time in ninety seconds — which is exactly the behaviour this signal
    // exists to surface — and it is not what the screen's label says.
    const ids = [await seedItem('Anna'), await seedItem('Bram'), await seedItem('Anna')];
    for (const id of ids) await assign(id, 'Jan');
    for (const [index, id] of ids.entries()) {
      await recordCampaignDecision(
        tenantId,
        {
          itemId: id,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'revoke',
          comment: 'not needed',
        },
        { now: new Date(NOW.getTime() + index * 20_000) },
      );
    }

    await computeReviewQualitySignals(tenantId, campaignId, NOW);
    const signal = await withTenant(tenantId, (tx) =>
      tx.reviewQualitySignal.findFirstOrThrow(),
    );
    expect(signal.bulkShare).toBe(0);
    expect(signal.largestBurst).toBe(3);
    expect(signal.largestBurstMs).toBe(40_000);
  });

  it('neverOpenedShare counts the RECORDED FACT, not a timestamp coincidence', async () => {
    // A decision made in the same second as the open is not a decision made
    // without opening, and the evidence bundle carries this figure as "the
    // closest thing to evidence of engagement the system can honestly
    // produce". Accusing a reviewer who read everything is worse than silence.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await openItem(tenantId, person['Jan']!, itemId, NOW);
    await recordCampaignDecision(
      tenantId,
      {
        itemId,
        deciderPersonId: person['Jan']!,
        deciderUserId: user['Jan']!,
        decision: 'certify',
        comment: null,
      },
      { now: NOW },
    );

    const decision = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findFirstOrThrow(),
    );
    expect(decision.neverOpened).toBe(false);
    expect(decision.itemOpenedAt).toEqual(NOW);

    await computeReviewQualitySignals(tenantId, campaignId, NOW);
    const signal = await withTenant(tenantId, (tx) =>
      tx.reviewQualitySignal.findFirstOrThrow(),
    );
    expect(signal.neverOpenedShare).toBe(0);
  });

  it('openItem PERSISTS the open time, so it survives a different process', async () => {
    // A module-level `Map<string, Date>` is empty at decision time across two
    // API workers, behind any load balancer, and after any restart.
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Jan');
    await openItem(tenantId, person['Jan']!, itemId, NOW);

    const row = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findFirstOrThrow({ where: { itemId, personId: person['Jan']! } }),
    );
    expect(row.openedAt).toEqual(NOW);

    // Opening again does not restart the clock.
    const later = new Date(NOW.getTime() + 60_000);
    const second = await openItem(tenantId, person['Jan']!, itemId, later);
    expect(second.openedAt).toEqual(NOW);
  });
});

/**
 * TWO REVIEWERS, ONE ITEM, AT THE SAME MOMENT.
 *
 * `quorum: 'any'` is the normal shape for a role or group selector and it is
 * true of EVERY escalated item, because escalation ADDS a reviewer rather than
 * replacing one. So two people holding one item is ordinary, not exotic.
 *
 * The old form read the status here and then wrote with
 * `update({ where: { id } })` -- no predicate, under READ COMMITTED. Both
 * transactions read `pending`, both committed, and the item ended up carrying a
 * certify AND a revoke: `HoldingCertification` said "certified" for a holding
 * on its way into a revocation batch, and `closeDueCampaigns` broke the tie on
 * `decidedAt`, which is identical within a second.
 */
describe('two reviewers deciding one item at once', () => {
  const race = async (itemId: string) =>
    Promise.allSettled([
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Jan']!,
          deciderUserId: user['Jan']!,
          decision: 'revoke',
          comment: 'not needed any more',
        },
        { now: NOW },
      ),
    ]);

  it('lets exactly one of them through', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await assign(itemId, 'Jan');

    const outcomes = await race(itemId);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CampaignDecisionRefusedError);
    expect(rejected.reason.code).toBe('item_not_pending');
  });

  it('records ONE decision row, and the projection agrees with the item', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await assign(itemId, 'Jan');

    await race(itemId);

    const decisions = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findMany({ where: { itemId } }),
    );
    expect(decisions).toHaveLength(1);

    // The half that made the race visible to an AUDITOR rather than only to
    // the database: a certification row for an item in `revoke_decided`.
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    const certifications = await withTenant(tenantId, (tx) =>
      tx.holdingCertification.findMany(),
    );
    expect(certifications).toHaveLength(item.status === 'certified' ? 1 : 0);
  });
});

/**
 * §11's item table has no `blocked_no_reviewer -> certified` transition, and
 * `CERTIFYING_TRANSITIONS` -- the constant the structural test asserts over --
 * names `pending` as the only `from`. The gate admitted both, which is
 * unreachable today ONLY because a blocked item has no active reviewer row so
 * the `not_reviewer` refusal fires first. Two guards, one of them wrong, is one
 * move away from the wrong one being the only guard.
 */
describe('a blocked item', () => {
  it('cannot be certified even by somebody assigned to it', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: itemId }, data: { status: 'blocked_no_reviewer' } }),
    );
    await assign(itemId, 'Bram');

    await expect(
      recordCampaignDecision(
        tenantId,
        {
          itemId,
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
          decision: 'certify',
          comment: null,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'item_not_pending' });
  });
});

/**
 * `bulkCertify` checked NEITHER of the two gates `recordCampaignDecision`
 * refuses on: the campaign's status, and a departed subject.
 *
 * A leaver's items stay `pending` until the nightly `mootDepartedSubjects`
 * sweep runs, so between the departure and that sweep their manager could
 * bulk-certify a person who has left -- which the single path treats as false
 * assurance and refuses in words.
 */
describe('bulkCertify honours the gates the single path enforces', () => {
  it('refuses a campaign that is not open', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { status: 'closed_incomplete' } }),
    );

    await expect(
      bulkCertify(
        tenantId,
        {
          campaignId,
          itemIds: [itemId],
          deciderPersonId: person['Bram']!,
          deciderUserId: user['Bram']!,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'campaign_not_open' });
  });

  it('refuses a departed subject and MOOTS the item, as the single path does', async () => {
    const itemId = await seedItem('Anna');
    await assign(itemId, 'Bram');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-01-01') },
      }),
    );

    const result = await bulkCertify(
      tenantId,
      {
        campaignId,
        itemIds: [itemId],
        deciderPersonId: person['Bram']!,
        deciderUserId: user['Bram']!,
      },
      { now: NOW },
    );

    expect(result.certified).toBe(0);
    expect(result.refused[0]!.reason).toMatch(/has left/);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
  });
});
