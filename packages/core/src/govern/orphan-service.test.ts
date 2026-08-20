import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  confirmProposal,
  denyProposal,
  proposeOwners,
  refreshOrphanProposals,
  trigramSimilarity,
  type CandidatePerson,
  type OrphanAccount,
} from './orphan-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');

const account = (over: Partial<OrphanAccount> = {}): OrphanAccount => ({
  systemId: 'sys-1',
  systemName: 'Acme AD',
  accountRef: 'anchor-7',
  displayName: 'A.Novak',
  mail: null,
  employeeId: null,
  managerAccountRef: null,
  ...over,
});

const anna: CandidatePerson = {
  personId: 'p-anna',
  givenName: 'Anna',
  familyName: 'Novak',
  businessEmail: 'Anna.Novak@acme.test',
  personalEmail: null,
  externalId: 'E1001',
  managerPersonId: 'p-jan',
};

const bram: CandidatePerson = {
  personId: 'p-bram',
  givenName: 'Bram',
  familyName: 'Visser',
  businessEmail: 'bram.visser@acme.test',
  personalEmail: null,
  externalId: 'E2002',
  managerPersonId: null,
};

describe('proposeOwners', () => {
  it('matches on mail address, case-insensitively', () => {
    // AD folds case and PostgreSQL does not. Three defects on the Provision
    // slice came from that, and a mail match that missed on casing would send
    // every orphan to the bottom of a list nobody works.
    const proposals = proposeOwners(account({ mail: 'ANNA.NOVAK@ACME.TEST' }), [anna, bram], new Map());
    expect(proposals[0]).toMatchObject({ personId: 'p-anna', method: 'mail_address' });
    expect(proposals[0]!.confidence).toBeGreaterThan(0.9);
  });

  it('matches on employee identifier', () => {
    const proposals = proposeOwners(account({ employeeId: 'E2002' }), [anna, bram], new Map());
    expect(proposals[0]).toMatchObject({ personId: 'p-bram', method: 'employee_identifier' });
  });

  it('matches on name similarity, and folds with NFKD', () => {
    const proposals = proposeOwners(
      account({ displayName: 'Ĳsbrand Novak' }),
      [{ ...anna, givenName: 'Ijsbrand' }, bram],
      new Map(),
    );
    expect(proposals[0]!.personId).toBe('p-anna');
    expect(proposals[0]!.method).toBe('name_similarity');
  });

  it('matches on the manager of an adjacent account', () => {
    const proposals = proposeOwners(
      account({ displayName: null, managerAccountRef: 'anchor-jan' }),
      [anna, bram],
      new Map([['anchor-jan', 'p-jan']]),
    );
    expect(proposals.map((p) => p.personId)).toContain('p-anna');
    expect(proposals.find((p) => p.personId === 'p-anna')!.method).toBe('adjacent_manager');
  });

  it('returns NOTHING when the account carries no identifying attribute at all', () => {
    // The empty case, and the dangerous direction is the other one: a matcher
    // that returned every candidate for a blank account would put the whole
    // organization on a claim screen at equal confidence.
    expect(
      proposeOwners(account({ displayName: null, mail: null, employeeId: null }), [anna, bram], new Map()),
    ).toEqual([]);
  });

  it('returns nothing for a similarity below the floor rather than a weak guess', () => {
    expect(proposeOwners(account({ displayName: 'zzzz qqqq' }), [anna, bram], new Map())).toEqual([]);
  });

  it('carries a `because` sentence per proposal', () => {
    const [proposal] = proposeOwners(account({ mail: 'anna.novak@acme.test' }), [anna], new Map());
    expect(proposal!.because).toContain('anna.novak@acme.test');
  });

  it('orders by confidence, highest first, and never exceeds 1', () => {
    const proposals = proposeOwners(
      account({ mail: 'anna.novak@acme.test', displayName: 'Anna Novak' }),
      [anna, bram],
      new Map(),
    );
    expect(proposals[0]!.confidence).toBeLessThanOrEqual(1);
    for (let i = 1; i < proposals.length; i += 1) {
      expect(proposals[i - 1]!.confidence).toBeGreaterThanOrEqual(proposals[i]!.confidence);
    }
  });
});

describe('the claim flow', () => {
  let tenantId: string;
  let snapshotId: string;
  let personId: string;
  // A REAL user id. `AccountAttribution.decidedByUserId` is `@db.Uuid`, so the
  // plan's `actorUserId` is refused by PostgreSQL before any behaviour is
  // exercised -- "Error creating UUID, invalid character ... found `u` at 1".
  let actorUserId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak', businessEmail: 'anna.novak@acme.test' },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          login: 'reviewer',
          email: 'reviewer@acme.test',
          displayName: 'Reviewer',
        },
      });
      const snapshot = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId, snapshotId: snapshot.id, sourceKind: 'syntraInternal', sourceId: 'syntra',
          sourceName: 'Syntra', completeness: 'complete', staleness: 'fresh', freshnessSlaHours: 24,
        },
      });
      await tx.holding.create({
        data: {
          tenantId, snapshotId: snapshot.id,
          subjectKey: 'account:sys-1:anchor-7', accountRef: 'anchor-7',
          systemKind: 'targetSystem', systemId: 'sys-1',
          resourceKind: 'targetAccount', resourceId: 'anchor-7',
          resourceName: 'anna.novak@acme.test (active)',
          state: 'held', observedAt: NOW, observedVia: 'provision:sys-1', firstSeenAt: NOW,
          unattributable: true,
        },
      });
      return { snapshotId: snapshot.id, personId: person.id, actorUserId: actor.id };
    });
    snapshotId = seeded.snapshotId;
    personId = seeded.personId;
    actorUserId = seeded.actorUserId;
  });

  it('writes a proposal and an orphan_account finding, and never links anything', async () => {
    const result = await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    expect(result.orphans).toBe(1);
    expect(result.proposals).toBeGreaterThan(0);

    const [proposals, findings, accounts] = await withTenant(tenantId, async (tx) => [
      await tx.accountAttribution.findMany(),
      await tx.governFinding.findMany({ where: { kind: 'orphan_account' } }),
      await tx.targetAccount.findMany(),
    ]);
    expect(proposals[0]).toMatchObject({ status: 'proposed', proposedPersonId: personId });
    expect(findings).toHaveLength(1);
    // Never automatic, at any confidence. Provision's next run evaluates that
    // person's desired state against that account, and a wrong link is a
    // leaver's account attached to a current employee.
    expect(accounts).toEqual([]);
  });

  it('a denial is recorded and suppresses that candidate on the next refresh', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await denyProposal(tenantId, actorUserId, proposal.id, 'that is a service account, not Anna');

    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const rows = await withTenant(tenantId, (tx) => tx.accountAttribution.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'denied', decidedReason: 'that is a service account, not Anna' });
  });

  it('confirmation calls the injected linking function and writes ONE confirmation', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    const link = vi.fn(async () => undefined);

    await confirmProposal(tenantId, actorUserId, proposal.id, link);

    expect(link).toHaveBeenCalledWith(tenantId, actorUserId, 'sys-1', 'anchor-7', personId);
    const row = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    expect(row.status).toBe('confirmed');
  });

  it('refuses a second confirmation for the same account', async () => {
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await confirmProposal(tenantId, actorUserId, proposal.id, async () => undefined);

    // A DIFFERENT candidate. `@@unique([tenantId, systemId, accountRef,
    // proposedPersonId])` allows one proposal per person per account, so a
    // second row naming the same person is refused by that index before the
    // confirmation this case is about is ever reached. Many candidates may be
    // proposed for one orphan; exactly one may be confirmed, and that second
    // half is what is under test here.
    const second = await withTenant(tenantId, async (tx) => {
      const other = await tx.person.create({
        data: { tenantId, givenName: 'Bram', familyName: 'Visser' },
      });
      return tx.accountAttribution.create({
        data: {
          tenantId, systemId: 'sys-1', accountRef: 'anchor-7',
          proposedPersonId: other.id, method: 'name_similarity', confidence: 0.5,
        },
      });
    });
    await expect(
      confirmProposal(tenantId, actorUserId, second.id, async () => undefined),
    ).rejects.toThrow(/already/i);
  });

  it('does not roll the confirmation forward when the link throws', async () => {
    // Provision's linking path can refuse — a conflict, a person who already
    // holds an account on that target. A confirmation recorded against a link
    // that did not happen is a screen claiming an orphan is resolved when it is
    // not.
    await refreshOrphanProposals(tenantId, snapshotId, { now: NOW });
    const proposal = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    await expect(
      confirmProposal(tenantId, actorUserId, proposal.id, async () => {
        throw new Error('this person already holds an account on that target');
      }),
    ).rejects.toThrow(/already holds an account/);

    const row = await withTenant(tenantId, (tx) => tx.accountAttribution.findFirstOrThrow());
    expect(row.status).toBe('proposed');
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(trigramSimilarity('anna novak', 'anna novak')).toBe(1);
    expect(trigramSimilarity('anna novak', 'zzzzz qqqqq')).toBe(0);
  });

  it('is 0 for an EMPTY needle rather than 1', () => {
    // The empty pattern is the universal pattern unless something says
    // otherwise. A blank display name matching everybody at confidence 1 is
    // Ruling P20's defect wearing an orphan's clothes.
    expect(trigramSimilarity('', 'anna novak')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });
});
