import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from './audit-service.js';
import {
  auditSearchSql,
  prefixUpperBound,
  searchAuditEvents,
  type AuditSearchFilters,
  type AuditSearchPage,
} from './audit-search.js';

let tenantId: string;
let otherTenantId: string;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
});

async function record(
  action: string,
  over: Partial<{ actorUserId: string | null; targetId: string | null; outcome: 'success' | 'failure' }> = {},
  tenant = tenantId,
) {
  return withTenant(tenant, (tx) =>
    recordEvent(tx, {
      actorUserId: over.actorUserId ?? null,
      action,
      targetType: 'User',
      targetId: over.targetId ?? null,
      outcome: over.outcome ?? 'success',
      sourceIp: null,
      payload: {},
    }),
  );
}

const search = (filters: AuditSearchFilters, opts: { before?: number; limit?: number } = {}) =>
  withTenant(tenantId, (tx) => searchAuditEvents(tx, filters, opts));

describe('searchAuditEvents filters', () => {
  beforeEach(async () => {
    await record('auth.login', { actorUserId: ALICE });
    await record('auth.logout', { actorUserId: ALICE });
    await record('authz.check', { actorUserId: BOB });
    await record('user.update', { actorUserId: BOB, targetId: TARGET });
    await record('auth.login', { actorUserId: BOB, outcome: 'failure' });
    await record('auth.login', { actorUserId: ALICE }, otherTenantId);
  });

  it('filters by actor, newest first, and never crosses the tenant', async () => {
    const page = await search({ actorUserId: ALICE });
    expect(page.events.map((e) => e.action)).toEqual(['auth.logout', 'auth.login']);
    expect(page.nextBefore).toBeNull();
  });

  it('treats the action filter as a prefix, not as a substring or a pattern', async () => {
    // `auth.` must not match `authz.check`: the prefix is an exact byte range.
    const page = await search({ actionPrefix: 'auth.' });
    expect(page.events.map((e) => e.action)).toEqual(['auth.login', 'auth.logout', 'auth.login']);
    expect((await search({ actionPrefix: 'auth' })).events).toHaveLength(4);
    expect(prefixUpperBound('auth.')).toBe('auth/');
  });

  it('filters by target and by outcome', async () => {
    expect((await search({ targetId: TARGET })).events.map((e) => e.action)).toEqual(['user.update']);
    const failures = await search({ outcome: 'failure' });
    expect(failures.events.map((e) => [e.action, e.actorUserId])).toEqual([['auth.login', BOB]]);
  });

  it('matches a subject in either direction, and an empty subject list matches nothing', async () => {
    expect((await search({ subjectIds: [TARGET] })).events).toHaveLength(1);
    expect((await search({ subjectIds: [BOB] })).events).toHaveLength(3);
    expect((await search({ subjectIds: [] })).events).toEqual([]);
  });

  it('bounds a time window inclusively below and exclusively above', async () => {
    const all = (await search({})).events;
    const oldest = all[all.length - 1]!;
    const within = await search({ from: oldest.occurredAt, to: new Date(oldest.occurredAt.getTime() + 1) });
    expect(within.events.map((e) => e.sequence)).toContain(oldest.sequence);
    const none = await search({ to: oldest.occurredAt });
    expect(none.events).toEqual([]);
  });

  it('pages by keyset without repeating or skipping an event', async () => {
    const first = await search({}, { limit: 2 });
    expect(first.events.map((e) => e.sequence)).toEqual([5, 4]);
    expect(first.nextBefore).toBe(4);
    // An event written between pages lands above the cursor, not on page two.
    await record('user.create');
    const second = await search({}, { limit: 2, before: first.nextBefore! });
    expect(second.events.map((e) => e.sequence)).toEqual([3, 2]);
    const third = await search({}, { limit: 2, before: second.nextBefore! });
    expect(third.events.map((e) => e.sequence)).toEqual([1]);
    expect(third.nextBefore).toBeNull();
  });
});

// ---- query plans at 100,000 events -----------------------------------------
//
// The rehearsal docs/runbooks/scale-validation.md describes, for the audit
// log, run by the suite rather than by hand: 100,000 events in one tenant,
// `ANALYZE`, then `EXPLAIN (ANALYZE, BUFFERS)` of the exact statement
// `searchAuditEvents` runs for each filter at page size 51 (50 plus the
// look-ahead row). A sequential scan of the log, or a page that touches a
// meaningful fraction of it, fails the test.

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

const SEEDED = 100_000;
const ACTORS = 50;
const TARGETS = 2000;
const RARE_ACTOR = '44444444-4444-4444-8444-444444444444';

async function seed(): Promise<void> {
  await withTenant(
    tenantId,
    async (tx) => {
      // md5(...)::uuid gives stable, well-spread ids without a lookup table.
      await tx.$executeRawUnsafe(`
        INSERT INTO "AuditEvent" ("id", "tenantId", "sequence", "occurredAt", "actorUserId", "action",
                                  "targetType", "targetId", "outcome", "sourceIp", "payload", "prevHash", "hash")
        SELECT gen_random_uuid(), '${tenantId}'::uuid, g,
               timestamp '2026-01-01' + g * interval '1 minute',
               CASE WHEN g % 10000 = 7 THEN '${RARE_ACTOR}'::uuid ELSE md5('actor' || (g % ${ACTORS}))::uuid END,
               CASE WHEN g <= 50 THEN 'legacy.import' ELSE (ARRAY['auth.login','auth.logout','auth.mfa.verify','auth.elevate','user.create','user.update',
                      'user.deactivate','group.member.add','group.member.remove','role.assign','role.revoke',
                      'sync.apply','provision.apply','provision.run','govern.snapshot','govern.decision',
                      'export.request','export.download','tenant.update','session.revoked'])[1 + g % 20] END,
               'User', md5('target' || (g % ${TARGETS}))::uuid,
               CASE WHEN g % 20 = 0 THEN 'failure' ELSE 'success' END,
               NULL, '{"note":"scale-rehearsal"}'::jsonb, repeat('0', 64), repeat('0', 64)
        FROM generate_series(1, ${SEEDED}) AS g
      `);
      await tx.$executeRawUnsafe('ANALYZE "AuditEvent"');
    },
    { timeoutMs: 180_000 },
  );
}

async function explain(filters: AuditSearchFilters, page: Partial<AuditSearchPage> = {}) {
  return withTenant(tenantId, async (tx) => {
    const sql = auditSearchSql(filters, { limit: 51, order: 'desc', ...page });
    const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`,
      ...sql.values,
    );
    const top = rows[0]!['QUERY PLAN'][0];
    const all = nodes(top.Plan);
    // EXPLAIN's buffer counts are cumulative, so the top node's are the page's.
    const summary = {
      nodes: all.map((n) => (n['Index Name'] ? `${n['Node Type']} ${n['Index Name']}` : n['Node Type'])),
      blocks: (top.Plan['Shared Hit Blocks'] ?? 0) + (top.Plan['Shared Read Blocks'] ?? 0),
      ms: top['Execution Time'],
    };
    if (process.env['SYNTRA_PRINT_PLANS'] === '1') {
      process.stdout.write(`${JSON.stringify({ filters, page, ...summary })}\n`);
    }
    return summary;
  });
}

describe('audit search query plans at 100,000 events', () => {
  beforeEach(seed, 240_000);

  it('never scans the log, and every filtered page reads a small, bounded number of blocks', async () => {
    const actor = await withTenant(tenantId, async (tx) =>
      (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT md5('actor' || 3)::uuid::text AS id`))[0]!.id,
    );
    const target = await withTenant(tenantId, async (tx) =>
      (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT md5('target' || 11)::uuid::text AS id`))[0]!.id,
    );

    const cases: [string, AuditSearchFilters, Partial<AuditSearchPage>, string | null][] = [
      ['newest page', {}, {}, 'AuditEvent_tenantId_sequence_key'],
      ['deep keyset page', {}, { before: 50_000 }, 'AuditEvent_tenantId_sequence_key'],
      ['common actor', { actorUserId: actor }, {}, 'AuditEvent_tenantId_actorUserId_sequence_idx'],
      ['rare actor', { actorUserId: RARE_ACTOR }, {}, 'AuditEvent_tenantId_actorUserId_sequence_idx'],
      ['target', { targetId: target }, {}, 'AuditEvent_tenantId_targetId_sequence_idx'],
      ['failures', { outcome: 'failure' }, {}, null],
      ['action prefix', { actionPrefix: 'auth.' }, {}, null],
      ['narrow action prefix', { actionPrefix: 'export.download' }, {}, null],
      // Fifty events at the very start of the log: walking back from the head
      // to find them is the whole table, so this has to use the prefix index.
      ['rare, old action', { actionPrefix: 'legacy.' }, {}, 'AuditEvent_tenantId_action_prefix_idx'],
      [
        'one day in the middle',
        { from: new Date('2026-02-10T00:00:00Z'), to: new Date('2026-02-11T00:00:00Z') },
        {},
        null,
      ],
      ['subject, either direction', { subjectIds: [RARE_ACTOR, target] }, {}, null],
    ];

    for (const [name, filters, page, index] of cases) {
      const plan = await explain(filters, page);
      expect(plan.nodes.some((n) => n.startsWith('Seq Scan')), `${name}: ${plan.nodes.join(' > ')}`).toBe(false);
      if (index !== null) {
        expect(plan.nodes.some((n) => n.endsWith(index)), `${name}: ${plan.nodes.join(' > ')}`).toBe(true);
      }
      // The table is roughly 2,500 blocks at this size; a page that touches
      // more than a fifth of it is a scan by another name.
      expect(plan.blocks, `${name}: ${plan.blocks} blocks`).toBeLessThan(500);
    }
  }, 240_000);
});
