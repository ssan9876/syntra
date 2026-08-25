import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from '../provision/target-service.js';
import { previewProvisionRun } from '../provision/run-service.js';
import { applyProvisionRun } from '../provision/apply.js';
import { explainPersonAccess } from '../provision/explain.js';
import { grantedEntitlementsFor, remitFor } from '../provision/entitlement-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const STATS_DN = 'CN=Stats,OU=Groups,DC=acme,DC=test';

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: USERS,
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profileInput = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: USERS,
  fallbackContainer: USERS,
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

let tenantId: string;
let targetId: string;
let financeEntitlementId: string;
let statsEntitlementId: string;
let personId: string;
let ruleId: string;
let adminUserId: string;
let target: FakeTarget;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  // Ruling P8: the fake reproduces the real system's identifier semantics --
  // opaque anchors, DN-shaped memberOf. It is reused unchanged rather than
  // re-implemented for this slice.
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push(
    { externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' },
    { externalId: 'guid-stats', dn: STATS_DN, type: 'group', displayName: 'Stats' },
  );

  targetId = (
    await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;
  await upsertAccountProfile(tenantId, null, targetId, profileInput);

  const seeded = await withTenant(tenantId, async (tx) => {
    const finance = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        dn: FINANCE_DN,
        type: 'group',
        displayName: 'Finance',
        requestable: true,
      },
    });
    const stats = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-stats',
        dn: STATS_DN,
        type: 'group',
        displayName: 'Stats',
        requestable: true,
      },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    // An administrator to confirm with, deliberately NOT linked to a person.
    //
    // `isConfirmed` (apply.ts:198) requires `confirm === true` AND a non-null
    // `confirmedByUserId`, and every run in this file is a FIRST run against a
    // target holding no accounts -- which the guard blocks confirmably, by
    // design. The plan's fixture passed `confirmedByUserId: null`, so `confirm`
    // did nothing and seven cases refused with "this run is blocked and has
    // not been confirmed" before reaching anything they assert about.
    //
    // `personId` is left null on purpose: the leaver case below asserts on the
    // absence of `deactivate_syntra_user`, and linking this account to Anna
    // would make that action real and the assertion wrong.
    const admin = await tx.user.create({
      data: {
        tenantId,
        login: 'admin',
        email: 'admin@acme.test',
        displayName: 'Admin',
      },
    });
    return {
      finance: finance.id,
      stats: stats.id,
      personId: person.id,
      adminUserId: admin.id,
    };
  });
  financeEntitlementId = seeded.finance;
  statsEntitlementId = seeded.stats;
  personId = seeded.personId;
  adminUserId = seeded.adminUserId;

  ruleId = (
    await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [financeEntitlementId],
    })
  ).id;
});

async function grant(entitlementId: string, over: Record<string, unknown> = {}) {
  return withTenant(tenantId, async (tx) => {
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        subjectPersonId: personId,
        requestedByUserId: personId,
        status: 'awaiting_fulfilment',
      },
    });
    return tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId: personId,
        resourceType: 'entitlement',
        resourceId: entitlementId,
        targetSystemId: targetId,
        requestId: request.id,
        startsAt: day('2026-06-01'),
        status: 'pending',
        ...over,
      },
    });
  });
}

const runAndApply = async () => {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: target as never,
  });
  await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId: adminUserId,
    connector: target as never,
    now: NOW,
    sleep: async () => undefined,
  });
  return run;
};

describe('a grant is a term in desired state', () => {
  it('proposes granting an entitlement no business rule names', async () => {
    const created = await grant(statsEntitlementId);
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: run.id, actionType: 'grant_entitlement' } }),
    );
    const stats = actions.find((a) => a.entitlementId === statsEntitlementId);
    expect(stats).toBeDefined();
    // The action carries the grant that caused it, which is what reflection
    // reads to move the grant to active.
    expect(stats?.grantId).toBe(created.id);
  });

  it('requires an account for somebody whose only claim is a grant', async () => {
    // A group membership without an account is not a thing a directory can
    // hold. If the grants term did not imply the account, the grant action
    // would be planned against an account that was never created and would
    // fail `not_found` every night.
    await withTenant(tenantId, (tx) =>
      tx.businessRule.update({ where: { id: ruleId }, data: { enabled: false } }),
    );
    await grant(statsEntitlementId);
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: run.id } }),
    );
    expect(actions.map((a) => a.actionType)).toContain('create_account');
  });

  it('records the holding with origin request and the request that caused it', async () => {
    await grant(statsEntitlementId);
    await runAndApply();
    const holdings = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findMany({ where: { entitlementId: statsEntitlementId } }),
    );
    expect(holdings).toHaveLength(1);
    // One value covers both grant origins; grantedByRequestId answers which
    // kind it was without a second enum value meaning the same thing.
    expect(holdings[0]?.origin).toBe('request');
    expect(holdings[0]?.grantedByRequestId).not.toBeNull();
  });

  it('does not include a scheduled grant whose start date has not arrived', async () => {
    // A scheduled grant is visible in the console, says when it starts, and
    // confers nothing until it does.
    await grant(statsEntitlementId, { status: 'scheduled', startsAt: day('2026-09-01') });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: statsEntitlementId },
      }),
    );
    expect(actions).toEqual([]);
  });

  it('does not include a grant whose end date has passed', async () => {
    await grant(statsEntitlementId, { endsAt: day('2026-06-10') });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: statsEntitlementId },
      }),
    );
    expect(actions).toEqual([]);
  });
});

describe('collision 1 — a request grants something Provision would not grant', () => {
  it('proposes no revocation and writes no drift finding, in authoritative mode', async () => {
    await grant(statsEntitlementId);
    await runAndApply();

    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { enforcementMode: 'authoritative' },
      }),
    );
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });

    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations).toEqual([]);
    // Not drift. It is neither undocumented nor unexplained: Syntra did not
    // merely see it, it caused it, and can name who approved it.
    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({ where: { entitlementId: statsEntitlementId } }),
    );
    expect(findings).toEqual([]);
  });
});

describe('collision 2 — a contract change removes what a rule granted', () => {
  it('keeps an entitlement a grant still names after the rule stops matching', async () => {
    // Losing access because ONE of two independent reasons to hold it went
    // away is the bug, and union is the fix -- the same semantics Provision
    // already applies across concurrent contracts.
    await grant(financeEntitlementId);
    await runAndApply();

    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId },
        data: { department: 'Facilities' },
      }),
    );
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations).toEqual([]);
  });

  it('proposes the revocation once BOTH terms are gone', async () => {
    await grant(financeEntitlementId);
    await runAndApply();
    await withTenant(tenantId, async (tx) => {
      await tx.contract.updateMany({
        where: { personId },
        data: { department: 'Facilities' },
      });
      await tx.accessGrant.updateMany({
        where: { subjectPersonId: personId },
        data: { status: 'expired', endedAt: NOW },
      });
    });
    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: second.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(revocations.map((r) => r.entitlementId)).toEqual([financeEntitlementId]);
  });
});

describe('the remit is NOT widened by a grant', () => {
  it('leaves remitFor rule-only when a live grant names an entitlement', async () => {
    // The remit is TENANT-WIDE: reconcile classifies every account's holding
    // of every entitlement against it. If one person's approved request added
    // "Stats" to it, every other holding of Stats in the tenant would change
    // classification at once -- a drift finding marked proposedForRevocation
    // in authoritative mode. A run that wants to revoke five hundred holdings
    // because one person asked for something is not a review a human can do.
    await grant(statsEntitlementId);
    const remit = await withTenant(tenantId, (tx) => remitFor(tx, targetId));
    expect(remit.has(financeEntitlementId)).toBe(true);
    expect(remit.has(statsEntitlementId)).toBe(false);
  });

  it('reports the grant-derived set separately, and drops it when the grant ends', async () => {
    const created = await grant(statsEntitlementId);
    const during = await withTenant(tenantId, (tx) =>
      grantedEntitlementsFor(tx, targetId),
    );
    expect(during.has(statsEntitlementId)).toBe(true);

    await withTenant(tenantId, (tx) =>
      tx.accessGrant.update({ where: { id: created.id }, data: { status: 'expired' } }),
    );
    const after = await withTenant(tenantId, (tx) =>
      grantedEntitlementsFor(tx, targetId),
    );
    expect(after.has(statsEntitlementId)).toBe(false);
  });

  it('does not reclassify a second person who holds the same entitlement by hand', async () => {
    // The blast-radius case. Two accounts hold Stats: Anna by an approved
    // request, Bo by somebody adding them at the target years ago. In
    // authoritative mode, Bo's holding must stay out of remit and must NOT be
    // proposed for revocation because Anna asked for something.
    const boId = await withTenant(tenantId, async (tx) => {
      const bo = await tx.person.create({
        data: { tenantId, givenName: 'Bo', familyName: 'Larsen' },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: bo.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
          department: 'Finance',
        },
      });
      return bo.id;
    });
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { enforcementMode: 'authoritative' },
      }),
    );

    // Bo gets an account through the Finance rule, then acquires Stats at the
    // target with nothing in Syntra recording it.
    await runAndApply();
    const boAccount = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({
        where: { personId: boId, targetSystemId: targetId },
      }),
    );
    const boHeld = target.holdings.get(boAccount.anchor!) ?? new Set<string>();
    boHeld.add(STATS_DN);
    target.holdings.set(boAccount.anchor!, boHeld);

    await grant(statsEntitlementId);
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });

    const revocations = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, actionType: 'revoke_entitlement' },
      }),
    );
    expect(
      revocations.filter(
        (a) => a.entitlementId === statsEntitlementId && a.accountId === boAccount.id,
      ),
    ).toEqual([]);

    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({
        where: { entitlementId: statsEntitlementId, accountId: boAccount.id },
      }),
    );
    // Reported in both modes -- additive must mean "I saw this and left it" --
    // but never proposed for revocation, because Bo's holding is outside the
    // remit and Anna's request must not drag it in.
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(
        (finding.detail as { proposedForRevocation?: boolean }).proposedForRevocation,
      ).not.toBe(true);
    }
  });
});

describe('a grant is never evidence that somebody is still employed', () => {
  it('still disables and revokes for a leaver holding a permanent grant', async () => {
    // NAMED for what it asserts. `deactivate_syntra_user` is deliberately NOT
    // asserted and the name no longer claims it: this fixture creates a
    // `Person` and a `Contract` and no `User` row, so that action is never
    // planned and asserting it would fail against the correct fix. The two
    // that bite are here.
    //
    // The most serious defect this plan was reviewed for. `planActions` gates
    // the whole leaver ladder on `!state.account?.required`, and a permanent
    // grant has `endsAt: null`, so its window covers `now` forever. Union the
    // grant into `accountRequired` without gating it on employment and a
    // departed person is never disabled, never deactivated and never
    // archived -- and the entitlement is kept too, because the revoke loop
    // skips anything still desired. A feature added to grant access silently
    // disables the mechanism that removes it, and it looks like it works.
    //
    // None of the other cases in this file ends a contract, which is why none
    // of them can catch it.
    await grant(statsEntitlementId);
    await runAndApply();

    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId },
        data: { endDate: day('2026-05-31') },
      }),
    );

    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: run.id } }),
    );
    const types = actions.map((a) => a.actionType);

    expect(types).toContain('disable_account');
    // The requested entitlement goes with it. Provision granted it, so it is
    // in `heldWithinRemit` whatever the tenant-wide remit says, and desired
    // state no longer names it.
    expect(
      actions
        .filter((a) => a.actionType === 'revoke_entitlement')
        .map((a) => a.entitlementId),
    ).toContain(statsEntitlementId);
    // And nothing proposes granting it again on the next pass.
    expect(types).not.toContain('grant_entitlement');
  });

  it('keeps a scheduled leaver out of desired state entirely rather than half in it', async () => {
    // The same gate, seen from the account side: with every contract ended,
    // the account is not required, so the early return fires and the person
    // carries no grant attribution at all.
    await grant(statsEntitlementId);
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId },
        data: { endDate: day('2026-05-31') },
      }),
    );
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, actionType: 'create_account' },
      }),
    );
    expect(actions).toEqual([]);
  });
});

describe('a grant naming an entitlement the catalog does not hold', () => {
  it('is skipped and reported as an exception rather than planned', async () => {
    // Proposing it produces a grant_entitlement against a group that is not
    // there, which fails `not_found` every night forever with nothing
    // recording why. Making the PERSON unprocessable -- the answer a rule
    // gets -- would revoke everything else they hold over one request.
    // `entitlementStatus` is built from the STORED catalog status in phase 6;
    // the run does not refresh the catalog itself, so writing the status here
    // is what a previous `refreshEntitlements` would have written.
    await withTenant(tenantId, (tx) =>
      tx.entitlement.update({
        where: { id: statsEntitlementId },
        data: { status: 'missing' },
      }),
    );
    await grant(statsEntitlementId);

    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const actions = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: statsEntitlementId },
      }),
    );
    expect(actions).toEqual([]);

    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany({ where: { runId: run.id } }),
    );
    expect(exceptions.map((e) => e.kind)).toContain('unresolvable_grant');
    expect(exceptions.find((e) => e.kind === 'unresolvable_grant')?.personId).toBe(personId);

    // And the rest of the person's access is untouched: Finance still lands.
    const finance = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({
        where: { runId: run.id, entitlementId: financeEntitlementId },
      }),
    );
    expect(finance.length).toBeGreaterThan(0);
  });
});

describe('explainPersonAccess', () => {
  it('answers with a rule and a contract for one entitlement and a request for the other', async () => {
    // The whole point of putting grants into desired state rather than beside
    // it: one screen, one attribution union behind it.
    const created = await grant(statsEntitlementId);
    await runAndApply();

    const access = await explainPersonAccess(tenantId, personId);
    const entitlements = access.accounts.flatMap((a) => a.entitlements);
    const finance = entitlements.find((e) => e.entitlementId === financeEntitlementId);
    const stats = entitlements.find((e) => e.entitlementId === statsEntitlementId);

    expect(finance).toMatchObject({ origin: 'rule', ruleName: 'Finance staff' });
    expect(finance?.grantId).toBeNull();
    expect(stats).toMatchObject({ origin: 'request', grantId: created.id });
    expect(stats?.requestId).not.toBeNull();
  });
});
