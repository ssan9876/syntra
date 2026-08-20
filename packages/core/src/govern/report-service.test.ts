import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  accountDormancy,
  bodyOf,
  buildHeader,
  envelope,
  headerOf,
  snapshotInForceOn,
  whatDoesPersonHold,
  whoHasAccessToSystem,
} from './report-service.js';
import { readableSnapshot } from './readable.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });
    // A Syntra user and a sign-in, without which §16's dormancy read has
    // nothing to report. The plan's fixture had neither, so its dormancy test
    // asked for one row from a person with no account (Ruling G-15).
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna.novak',
        email: 'anna@example.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    await tx.session.create({
      data: {
        tenantId,
        userId: user.id,
        tokenHash: 'session-anna-1',
        scope: 'portal',
        createdAt: new Date('2026-06-01T08:00:00Z'),
        absoluteExpiresAt: new Date('2026-07-01T08:00:00Z'),
      },
    });
    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId,
        kind: 'manual',
        status: 'complete',
        asOf: NOW,
        holdingCount: 2,
        unattributableCount: 1,
        coverageGapCount: 1,
        unattributedAccountCount: 1,
        personsWithActiveContract: 1,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        sourceKind: 'targetSystem',
        sourceId: 'sys-1',
        sourceName: 'Acme AD',
        lastSuccessfulReadAt: new Date('2026-06-06T09:00:00Z'),
        completeness: 'partial',
        staleness: 'stale',
        freshnessSlaHours: 24,
        gapCount: 1,
      },
    });
    await tx.coverageGap.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        kind: 'resource_unreadable',
        systemKind: 'targetSystem',
        systemId: 'sys-1',
        resourceId: 'ent-admins',
        reason: 'Domain Admins could not be read completely',
      },
    });
    const held = await tx.holding.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        subjectKey: `person:${person.id}`,
        personId: person.id,
        systemKind: 'targetSystem',
        systemId: 'sys-1',
        resourceKind: 'targetEntitlement',
        resourceId: 'ent-finance',
        resourceName: 'Finance-Payments',
        state: 'held',
        observedAt: new Date('2026-06-03T00:00:00Z'),
        observedVia: 'provision:sys-1',
        firstSeenAt: NOW,
        attributionCount: 1,
        unattributable: false,
      },
    });
    await tx.holdingAttribution.create({
      data: {
        tenantId,
        holdingId: held.id,
        kind: 'business_rule',
        refType: 'BusinessRule',
        refId: 'rule-1',
        detail: { ruleName: 'Finance staff', ruleEnabled: true },
        resolvedAt: NOW,
      },
    });
    // Sorts alphabetically BEFORE 'an account with no person (anchor-7)'.
    // Without a subject on that side of the account, bucket order and
    // alphabetical order produce the same sequence and the mutation that
    // replaces one with the other cannot be caught (Ruling G-19).
    const aad = await tx.person.create({
      data: { tenantId, givenName: 'Aad', familyName: 'Bakker' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: aad.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2021-01-01'),
      },
    });
    const aadHolding = await tx.holding.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        subjectKey: `person:${aad.id}`,
        personId: aad.id,
        systemKind: 'targetSystem',
        systemId: 'sys-1',
        resourceKind: 'targetEntitlement',
        resourceId: 'ent-finance',
        resourceName: 'Finance-Payments',
        state: 'held',
        observedAt: NOW,
        observedVia: 'provision:sys-1',
        firstSeenAt: NOW,
        attributionCount: 1,
        unattributable: false,
      },
    });
    await tx.holdingAttribution.create({
      data: {
        tenantId,
        holdingId: aadHolding.id,
        kind: 'business_rule',
        refType: 'BusinessRule',
        refId: 'rule-1',
        detail: { ruleName: 'Finance staff', ruleEnabled: true },
        resolvedAt: NOW,
      },
    });
    await tx.holding.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        subjectKey: 'account:sys-1:anchor-7',
        accountRef: 'anchor-7',
        systemKind: 'targetSystem',
        systemId: 'sys-1',
        resourceKind: 'targetEntitlement',
        resourceId: 'ent-finance',
        resourceName: 'Finance-Payments',
        state: 'held',
        observedAt: NOW,
        observedVia: 'provision:sys-1',
        firstSeenAt: NOW,
        attributionCount: 0,
        unattributable: true,
      },
    });
    return { snapshotId: snapshot.id, personId: person.id };
  });
  snapshotId = seeded.snapshotId;
  personId = seeded.personId;
});

describe('the header is not optional', () => {
  it('carries the snapshot, its as-of, every source, and both counts', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'the Acme AD target'),
    );
    expect(header).toMatchObject({
      snapshotId,
      live: false,
      coverageGapCount: 1,
      unattributableCount: 1,
      unattributedAccountCount: 1,
    });
    expect(header.asOf).toBe(NOW.toISOString());
    expect(header.sources[0]).toMatchObject({
      sourceName: 'Acme AD',
      completeness: 'partial',
      staleness: 'stale',
    });
  });

  it('a bare object literal is NOT a ReportEnvelope — the brand bites at compile time', () => {
    // The construct that stands in for verification, shown to bite. `envelope`
    // is the only constructor, so a report DTO cannot be assembled without its
    // header. Vitest does not typecheck, so this only fails under `tsc` — and
    // if the brand is removed the directive becomes unused, which tsc reports
    // as TS2578. It bites in BOTH directions.
    //
    // The header below is VALID on purpose (Ruling G-17). The plan wrote
    // `header: null`, which is an error whether or not the brand exists — so
    // removing the brand would not have produced TS2578 and the mutation that
    // watches for its removal would not have bitten. The missing brand has to
    // be the only thing wrong with this literal.
    // @ts-expect-error a report body without its header brand is not constructible
    const bad: import('./report-service.js').ReportEnvelope<{ rows: [] }> = {
      header: { live: true, computedAt: NOW.toISOString(), exportable: false, caveat: 'live' },
      body: { rows: [] },
    };
    expect(bad).toBeDefined();
  });

  it('round-trips through envelope/headerOf/bodyOf', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'everything'),
    );
    const e = envelope(header, { rows: [1, 2, 3] });
    expect(headerOf(e)).toBe(header);
    expect(bodyOf(e)).toEqual({ rows: [1, 2, 3] });
  });
});

describe('who has access to this system', () => {
  it('groups into the four buckets, uncomfortable first', async () => {
    // The default sort of a governance report is not alphabetical.
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const rows = bodyOf(report).rows;
    expect(rows.map((r) => r.bucket)).toEqual(['unattributable', 'other', 'other']);
    expect(rows[0]!.displayName).toContain('an account with no person');

    // And the account does NOT lead by accident: 'Aad Bakker' sorts before
    // 'an account with no person (anchor-7)', so an alphabetical sort would put
    // Aad first. The bucket is what puts the uncomfortable row at the top.
    const alphabetical = [...rows]
      .map((r) => r.displayName)
      .sort((a, b) => a.localeCompare(b));
    expect(alphabetical[0]).toBe('Aad Bakker');
  });

  it('reports the holder count as UNKNOWN when the scope contains a gap', async () => {
    // Section 8 rule 3. Two holdings are visible and the honest answer is still
    // not "2", because one entitlement in this system could not be read at all.
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const count = bodyOf(report).holderCount;
    expect(count.known).toBe(false);
    if (count.known) throw new Error('unreachable');
    expect(count.reason).toContain('Domain Admins');
  });

  it('reports a NUMBER when the scope contains no gap', async () => {
    await withTenant(tenantId, (tx) => tx.coverageGap.deleteMany({}));
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    expect(bodyOf(report).holderCount).toEqual({ known: true, value: 3 });
  });

  it('carries each holding’s provenance as a sentence and its own observedAt', async () => {
    const report = await whoHasAccessToSystem(tenantId, { snapshotId, systemId: 'sys-1' });
    const anna = bodyOf(report).rows.find((r) => r.personId === personId);
    expect(anna!.resources[0]!.provenance).toContain('Finance staff');
    // The snapshot's asOf is 15 June; this holding was last confirmed on the
    // 3rd, and the report shows BOTH.
    expect(anna!.resources[0]!.observedAt).toBe('2026-06-03T00:00:00.000Z');
    expect(headerOf(report)).toMatchObject({ asOf: NOW.toISOString() });
  });

  it('refuses a snapshot that is not readable rather than reporting on it', async () => {
    const building = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'building', asOf: NOW },
      });
      return s.id;
    });
    await expect(
      whoHasAccessToSystem(tenantId, { snapshotId: building, systemId: 'sys-1' }),
    ).rejects.toThrow(/still being built/i);
  });
});

describe('what does this person hold', () => {
  it('lists every system, the full attribution set, and the other accounts', async () => {
    const report = await whatDoesPersonHold(tenantId, { snapshotId, personId });
    const body = bodyOf(report);
    expect(body.displayName).toBe('Anna Novak');
    expect(body.holdings).toHaveLength(1);
    expect(body.holdings[0]!.attributions).toHaveLength(1);
    expect(body.holdings[0]!.attributions[0]).toMatchObject({ kind: 'business_rule' });
  });

  it('carries the tenant’s unattributed-account count in its footer', async () => {
    // Nobody may read a per-person report as complete while accounts belonging
    // to nobody are in the same systems.
    const report = await whatDoesPersonHold(tenantId, { snapshotId, personId });
    expect(headerOf(report)).toMatchObject({ unattributedAccountCount: 1 });
  });
});

describe('snapshotInForceOn — Ruling G-4', () => {
  it('returns the snapshot in force on a date inside its coverage', async () => {
    const result = await withTenant(tenantId, (tx) => snapshotInForceOn(tx, NOW));
    expect(result.covered).toBe(true);
    if (result.covered) expect(result.snapshot.id).toBe(snapshotId);
  });

  it('answers NOT COVERED for a date before the first snapshot, naming the nearest', async () => {
    const result = await withTenant(tenantId, (tx) =>
      snapshotInForceOn(tx, new Date('2026-01-01T00:00:00Z')),
    );
    expect(result.covered).toBe(false);
    if (!result.covered) {
      expect(result.nearest).toEqual(NOW);
      expect(result.statement).toContain('no snapshot covers 2026-01-01');
    }
  });

  it('answers NOT COVERED for a date in a GAP between two snapshots', async () => {
    // The case the whole ruling is about. There is a snapshot on 15 June and
    // another on 15 July; nothing observed the world on 1 July, and answering
    // with either picture would be a different date wearing this one's label.
    await withTenant(tenantId, async (tx) => {
      const later = await tx.accessSnapshot.create({
        data: {
          tenantId,
          kind: 'manual',
          status: 'complete',
          asOf: new Date('2026-07-15T09:00:00Z'),
        },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId,
          snapshotId: later.id,
          sourceKind: 'syntraInternal',
          sourceId: 'syntra',
          sourceName: 'Syntra',
          completeness: 'complete',
          staleness: 'fresh',
          freshnessSlaHours: 24,
        },
      });
    });

    const result = await withTenant(tenantId, (tx) =>
      snapshotInForceOn(tx, new Date('2026-07-01T00:00:00Z')),
    );
    expect(result.covered).toBe(false);
    if (!result.covered) {
      expect(result.nearest).toEqual(NOW);
      expect(result.statement).toContain('a gap of 30 days');
    }
  });
});

describe('Syntra account dormancy — §16', () => {
  it('reports the last sign-in AND says in words that it is not entitlement usage', async () => {
    const rows = await withTenant(tenantId, (tx) => accountDormancy(tx, personId, NOW));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caveat).toContain('NOT entitlement usage');
    expect(rows[0]!.dormantDays).toBeGreaterThanOrEqual(0);
  });
});
