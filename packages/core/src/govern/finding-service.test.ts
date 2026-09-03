import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  acceptFinding,
  assignFinding,
  createRemediationItem,
  detectAccessWithoutContract,
  detectNoHumanDecision,
  detectPrivilegedUncertified,
  detectStaleSources,
  detectUnattributableHoldings,
  detectUnexplainedGains,
  reconcileFindings,
  resolveAuditIntegrityFindings,
  resolveRemediationItem,
  sweepAcceptedFindings,
  upsertFindings,
  type DetectHolding,
  type FindingDraft,
} from './finding-service.js';
import { AUDIT_CHAIN_REF, AUDIT_CHECKPOINT_REF } from './types.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const holding = (over: Partial<DetectHolding> = {}): DetectHolding => ({
  subjectKey: 'person:p-1',
  personId: 'p-1',
  accountRef: null,
  systemId: 'sys-1',
  systemName: 'Acme AD',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-1',
  resourceName: 'Finance-Payments',
  privileged: false,
  unattributable: false,
  attributionKinds: ['business_rule'],
  ...over,
});

describe('detectUnattributableHoldings', () => {
  it('raises one finding per unattributable holding, naming the resource', () => {
    const drafts = detectUnattributableHoldings([
      holding(),
      holding({ resourceId: 'ent-2', resourceName: 'Domain Admins', unattributable: true, attributionKinds: [] }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'unattributable_holding', subjectRefType: 'holding' });
    expect(drafts[0]!.detail['resourceName']).toBe('Domain Admins');
  });

  it('raises `critical` for an unattributable PRIVILEGED holding', () => {
    // A hand grant on a Syntra role, or an entitlement a tenant marked
    // privileged, that nothing in Syntra explains, is what a compromised
    // administrator's persistence looks like.
    const [draft] = detectUnattributableHoldings([
      holding({ unattributable: true, privileged: true, attributionKinds: ['discovered'] }),
    ]);
    expect(draft!.severity).toBe('critical');
  });
});

describe('detectAccessWithoutContract — the leaver finding', () => {
  it('raises a finding for a person holding something with no active contract', () => {
    const drafts = detectAccessWithoutContract(
      [holding()],
      [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: day('2026-05-01') }],
      NOW,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'access_without_contract', subjectRefId: 'p-1' });
    expect(drafts[0]!.detail['holdingCount']).toBe(1);
  });

  it('raises nothing for a person with a live contract', () => {
    expect(
      detectAccessWithoutContract(
        [holding()],
        [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: null }],
        NOW,
      ),
    ).toEqual([]);
  });

  it('raises nothing for a person with a FUTURE contract who has not started', () => {
    // Not yet started is not departed. Provision's Ruling P10 is the same
    // distinction one subsystem over, and getting it wrong here would put
    // every pre-hire on the leaver list on their first day.
    expect(
      detectAccessWithoutContract(
        [holding()],
        [{ personId: 'p-1', startDate: day('2026-09-01'), endDate: null }],
        NOW,
      ),
    ).toEqual([]);
  });

  it('raises a finding for a person with NO contracts at all who holds something', () => {
    // The empty case. A person with no contract row and live access is the
    // most interesting version of this finding and the one a naive
    // "endDate < now" filter misses entirely.
    const drafts = detectAccessWithoutContract([holding()], [], NOW);
    expect(drafts).toHaveLength(1);
  });

  it('ignores an unattributed account, which belongs to nobody to have a contract', () => {
    expect(
      detectAccessWithoutContract(
        [holding({ subjectKey: 'account:sys-1:a7', personId: null, accountRef: 'a7' })],
        [],
        NOW,
      ),
    ).toEqual([]);
  });

  it('groups every holding of one departed person into ONE finding', () => {
    const drafts = detectAccessWithoutContract(
      [holding(), holding({ resourceId: 'ent-2' }), holding({ resourceId: 'ent-3' })],
      [{ personId: 'p-1', startDate: day('2020-01-01'), endDate: day('2026-05-01') }],
      NOW,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.detail['holdingCount']).toBe(3);
  });

  it('TAKES NO GOVERN STATE — the signature has exactly three parameters', () => {
    // The structural half of the leaver rule. Automate's C1 kept a leaver's
    // account enabled forever by teaching desired state about grants;
    // Provision's P23 froze a leaver's deprovisioning behind an unrelated flag.
    // A fourth parameter here — exceptions, certifications, accepted findings —
    // is how the same defect arrives a third time, so the arity is asserted.
    expect(detectAccessWithoutContract).toHaveLength(3);
  });
});

describe('the other standing findings', () => {
  it('raises no_human_decision for an auto_granted holding', () => {
    const [draft] = detectNoHumanDecision([holding({ attributionKinds: ['auto_granted'] })]);
    expect(draft).toMatchObject({ kind: 'no_human_decision' });
  });

  it('raises nothing for a holding whose request a human approved', () => {
    expect(detectNoHumanDecision([holding({ attributionKinds: ['request'] })])).toEqual([]);
  });

  it('raises stale_source per stale source, naming the age', () => {
    const [draft] = detectStaleSources([
      {
        sourceKind: 'targetSystem', sourceId: 'sys-1', sourceName: 'Acme AD',
        lastRunId: null, lastSuccessfulReadAt: day('2026-06-01'), lastAttemptedReadAt: null,
        completeness: 'complete', staleness: 'stale', freshnessSlaHours: 24, gapCount: 0,
        ageHours: 336,
      },
    ]);
    expect(draft).toMatchObject({ kind: 'stale_source', subjectRefId: 'sys-1' });
    expect(draft!.detail['ageHours']).toBe(336);
  });

  it('raises unexplained_gain only for a GAIN Syntra did not cause', () => {
    // The most valuable row this system produces: access appeared, and Syntra
    // did not cause it. An explained gain is a grant working correctly.
    const drafts = detectUnexplainedGains([
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'g', resourceName: 'G', change: 'gained', explained: false },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'h', resourceName: 'H', change: 'gained', explained: true },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'i', resourceName: 'I', change: 'lost', explained: false },
      { subjectKey: 'person:p-1', systemId: 's', resourceKind: 'syntraGroup', resourceId: 'j', resourceName: 'J', change: 'became_unknown', explained: false },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.detail['resourceName']).toBe('G');
  });

  it('raises privileged_uncertified for a privileged holding never certified', () => {
    const [draft] = detectPrivilegedUncertified([holding({ privileged: true })], new Map(), NOW, 90);
    expect(draft).toMatchObject({ kind: 'privileged_uncertified' });
    expect(draft!.detail['lastCertifiedAt']).toBeNull();
  });

  it('raises privileged_uncertified for one certified longer ago than the window', () => {
    const key = 'person:p-1|sys-1|targetEntitlement|ent-1';
    const drafts = detectPrivilegedUncertified(
      [holding({ privileged: true })],
      new Map([[key, day('2026-01-01')]]),
      NOW,
      90,
    );
    expect(drafts).toHaveLength(1);
  });

  it('raises nothing for one certified inside the window', () => {
    const key = 'person:p-1|sys-1|targetEntitlement|ent-1';
    expect(
      detectPrivilegedUncertified([holding({ privileged: true })], new Map([[key, day('2026-06-01')]]), NOW, 90),
    ).toEqual([]);
  });

  it('raises nothing for an UNPRIVILEGED holding never certified', () => {
    expect(detectPrivilegedUncertified([holding()], new Map(), NOW, 90)).toEqual([]);
  });
});

describe('the lifecycle', () => {
  let tenantId: string;
  let snapshotId: string;
  let personId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const snapshot = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      const person = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } });
      return { snapshotId: snapshot.id, personId: person.id };
    });
    snapshotId = seeded.snapshotId;
    personId = seeded.personId;
  });

  // Typed as Partial<FindingDraft>, not Record<string, unknown>: overriding
  // `kind` through an index-signature spread would widen it to `unknown` and
  // the call sites below would stop type-checking against FindingDraft.
  const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    kind: 'stale_source',
    severity: 'medium',
    subjectRefType: 'source',
    subjectRefId: 'sys-1',
    detail: {},
    ...over,
  });

  it('opens a finding, then UPDATES it on the next snapshot rather than duplicating', async () => {
    const first = await upsertFindings(tenantId, [draft()], { now: NOW });
    expect(first).toMatchObject({ opened: 1, updated: 0 });

    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await upsertFindings(tenantId, [draft()], { now: later });
    expect(second).toMatchObject({ opened: 0, updated: 1 });

    const rows = await withTenant(tenantId, (tx) => tx.governFinding.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstSeenAt).toEqual(NOW);
    expect(rows[0]!.lastSeenAt).toEqual(later);
  });

  it('upsertFindings RESOLVES NOTHING — an empty draft list closes no finding', async () => {
    // The fixture that could not distinguish pass from fail is the one that
    // calls upsertFindings with drafts and never checks what happened to the
    // findings it did not pass. This is that check.
    await upsertFindings(tenantId, [draft()], { now: NOW });
    await upsertFindings(tenantId, [], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(row.status).toBe('open');
    expect(row.resolvedBySnapshotId).toBeNull();
  });

  it('reconcileFindings resolves a finding that stopped being observed, NAMING the snapshot that showed it gone', async () => {
    // Not silently deleted. "It went away and we do not know why" is itself
    // worth a row, and a resolution with no snapshot behind it is a
    // disappearance nobody can audit.
    await upsertFindings(tenantId, [draft()], { now: NOW });
    const result = await reconcileFindings(tenantId, snapshotId, ['stale_source'], [], { now: NOW });
    expect(result.resolved).toBe(1);

    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(row).toMatchObject({ status: 'resolved', resolvedBySnapshotId: snapshotId });
  });

  it('reconcileFindings NEVER touches a kind it was not handed — the C1 defect, asserted', async () => {
    // Task 8 Step 5 opens the six standing kinds; Task 10 Step 6 reconciles
    // `unexplained_gain` against the SAME snapshot moments later. If resolution
    // is not narrowed by kind, the second call closes everything the first
    // opened and slice 1's headline output is empty on every run.
    await upsertFindings(
      tenantId,
      [draft({ kind: 'unattributable_holding', subjectRefType: 'holding', subjectRefId: 'person:p-1|sys-1|targetEntitlement|ent-1' })],
      { now: NOW },
    );

    const result = await reconcileFindings(tenantId, snapshotId, ['unexplained_gain'], [], { now: NOW });
    expect(result.resolved).toBe(0);

    const row = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'unattributable_holding' } }),
    );
    expect(row.status).toBe('open');
    expect(row.resolvedBySnapshotId).toBeNull();
  });

  it('reconcileFindings with an EMPTY kinds array resolves nothing at all', async () => {
    await upsertFindings(tenantId, [draft()], { now: NOW });
    const result = await reconcileFindings(tenantId, snapshotId, [], [], { now: NOW });
    expect(result.resolved).toBe(0);
    expect((await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow())).status).toBe('open');
  });

  it('resolveAuditIntegrityFindings closes ONLY audit_chain_broken, and only on the evidence it was given', async () => {
    // The third resolver, and the one with no snapshot behind it. It exists
    // because `audit_chain_broken` is deliberately outside `STANDING_KINDS` —
    // raising the audit integrity alarm under `coverage_gap` had the nightly
    // detect stage close it with a snapshot that had read no audit events
    // (C-a) — and a kind nothing sweeps is a kind nothing can ever clear
    // unless its own producer clears it (Ruling G-12).
    await upsertFindings(
      tenantId,
      [
        draft({ kind: 'audit_chain_broken', subjectRefType: 'snapshot', subjectRefId: `${AUDIT_CHECKPOINT_REF}4` }),
        draft({ kind: 'audit_chain_broken', subjectRefType: 'snapshot', subjectRefId: `${AUDIT_CHAIN_REF}2` }),
        draft({ kind: 'stale_source', subjectRefType: 'source', subjectRefId: 'src-1' }),
      ],
      { now: NOW },
    );

    // No evidence at all: nothing closes. This is the arm that matters, because
    // a resolver that closes on an empty argument is a whole-tenant sweep with
    // extra steps.
    expect(
      (await resolveAuditIntegrityFindings(tenantId, {
        trustedCheckpointSequence: null,
        genesisWalkClean: false,
      }, { now: NOW })).resolved,
    ).toBe(0);

    // A checkpoint at 4 that verifies does NOT close the finding about
    // checkpoint 4 — only about checkpoints strictly before it. That is what
    // stops a recovery closing the alarm it raised in the same run.
    expect(
      (await resolveAuditIntegrityFindings(tenantId, {
        trustedCheckpointSequence: 4,
        genesisWalkClean: false,
      }, { now: NOW })).resolved,
    ).toBe(0);

    // A LATER trusted checkpoint closes the checkpoint finding and leaves the
    // chain finding alone, because a clean incremental run said nothing about
    // the range before its checkpoint.
    expect(
      (await resolveAuditIntegrityFindings(tenantId, {
        trustedCheckpointSequence: 7,
        genesisWalkClean: false,
      }, { now: NOW })).resolved,
    ).toBe(1);

    const chain = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { subjectRefId: `${AUDIT_CHAIN_REF}2` } }),
    );
    expect(chain.status).toBe('open');

    // A clean walk from genesis closes it, and resolves with NO snapshot — the
    // one kind the CHECK constraint exempts.
    expect(
      (await resolveAuditIntegrityFindings(tenantId, {
        trustedCheckpointSequence: 7,
        genesisWalkClean: true,
      }, { now: NOW })).resolved,
    ).toBe(1);

    const closed = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { subjectRefId: `${AUDIT_CHAIN_REF}2` } }),
    );
    expect(closed).toMatchObject({ status: 'resolved', resolvedBySnapshotId: null });

    // And the unrelated standing finding was never touched by any of it.
    const stale = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'stale_source' } }),
    );
    expect(stale.status).toBe('open');
  });

  it('does not resurrect a finding an operator ACCEPTED', async () => {
    await upsertFindings(tenantId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    await acceptFinding(tenantId, null, row.id, 'known and tolerated', day('2026-07-01'), NOW);

    await upsertFindings(tenantId, [draft()], { now: NOW });
    const after = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(after.status).toBe('accepted');
  });

  it('lapses an acceptance back to open and RAISES its severity one step', async () => {
    // A finding somebody once formally accepted and then let quietly expire is
    // a different and worse thing than one nobody has looked at yet.
    await upsertFindings(tenantId, [draft({ severity: 'medium' })], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    // Accepted until a date in the FUTURE -- an acceptance whose expiry has
    // already passed cannot be created at all, and rightly so -- and then
    // swept from a day after it. The fixture asked for the impossible: an
    // acceptance until 2026-06-10 made on 2026-06-15, which the guard refuses.
    await acceptFinding(tenantId, null, row.id, 'until the migration lands', day('2026-07-01'), NOW);

    const result = await sweepAcceptedFindings(tenantId, day('2026-07-02'));
    expect(result.lapsed).toBe(1);

    const after = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(after).toMatchObject({ status: 'open', severity: 'high' });
  });

  it('refuses an acceptance with no expiry', async () => {
    await upsertFindings(tenantId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    // Not representable in the type either; this is the runtime backstop.
    await expect(
      acceptFinding(tenantId, null, row.id, 'forever', new Date('1970-01-01'), NOW),
    ).rejects.toThrow(/expiry must be in the future/i);
  });

  it('writes an audit event when a finding is assigned or accepted', async () => {
    await upsertFindings(tenantId, [draft()], { now: NOW });
    const row = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    await assignFinding(tenantId, null, row.id, personId, day('2026-07-01'));
    await acceptFinding(tenantId, null, row.id, 'known', day('2026-07-01'), NOW);

    const actions = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'govern.finding.assign',
      'govern.finding.accept',
    ]);
  });
});

describe('remediation items', () => {
  let tenantId: string;
  let personId: string;
  let findingId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } });
      const finding = await tx.governFinding.create({
        data: {
          tenantId, kind: 'orphan_account', severity: 'medium',
          subjectRefType: 'account', subjectRefId: 'sys:a7',
          detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
        },
      });
      return { personId: person.id, findingId: finding.id };
    });
    personId = seeded.personId;
    findingId = seeded.findingId;
  });

  it('creates one item and returns null rather than throwing on a duplicate', async () => {
    // A nightly snapshot re-observes the same problem. Chasing it once is
    // correct; a P2002 that kills the whole detect stage is not.
    const input = {
      kind: 'orphan_attribution',
      ownerPersonId: personId,
      dueAt: day('2026-07-01'),
      findingId,
      description: 'confirm or deny the proposed owner',
      deepLink: '/admin/govern/orphans',
    };
    const first = await withTenant(tenantId, (tx) => createRemediationItem(tx, tenantId, input));
    const second = await withTenant(tenantId, (tx) => createRemediationItem(tx, tenantId, input));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('admits a new item once the previous one is closed', async () => {
    const input = {
      kind: 'orphan_attribution',
      ownerPersonId: personId,
      dueAt: day('2026-07-01'),
      findingId,
      description: 'confirm or deny',
      deepLink: '/admin/govern/orphans',
    };
    const first = await withTenant(tenantId, (tx) => createRemediationItem(tx, tenantId, input));
    await resolveRemediationItem(tenantId, null, first!, 'wont_fix', 'a service account, deliberately');
    const second = await withTenant(tenantId, (tx) => createRemediationItem(tx, tenantId, input));
    expect(second).not.toBeNull();
  });

  it('requires a comment on wont_fix', async () => {
    const id = await withTenant(tenantId, (tx) =>
      createRemediationItem(tx, tenantId, {
        kind: 'orphan_attribution', ownerPersonId: personId, dueAt: day('2026-07-01'),
        findingId, description: 'x', deepLink: '/y',
      }),
    );
    await expect(resolveRemediationItem(tenantId, null, id!, 'wont_fix', '')).rejects.toThrow(
      /comment/i,
    );
  });
});
