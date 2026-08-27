import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { explainPersonAccess, previewAccountProfile, previewRuleImpact } from './explain.js';
import { upsertBusinessFunction, upsertSodRule } from '../govern/sod-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let entitlementId: string;
let personId: string;
let ruleId: string;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profileInput = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,DC=acme,DC=test',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: {
    displayName: '%person.givenName% %person.familyName%',
    // `Person` has businessEmail and personalEmail. There is no `email`
    // column, and spec section 15 forbids adding one.
    mail: '%person.businessEmail%',
  },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        type: 'group',
        displayName: 'Finance',
      },
    });
    const person = await tx.person.create({
      data: {
        tenantId,
        givenName: 'Anna',
        familyName: 'Novak',
        businessEmail: 'anna@acme.test',
      },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
        jobTitle: 'Analyst',
      },
    });
    const bo = await tx.person.create({
      data: { tenantId, givenName: 'Bo', familyName: 'Lind', businessEmail: 'bo@acme.test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: bo.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Facilities',
      },
    });
    return { entitlementId: entitlement.id, personId: person.id };
  });
  entitlementId = seeded.entitlementId;
  personId = seeded.personId;

  await upsertAccountProfile(tenantId, null, targetId, profileInput);
  ruleId = (
    await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    })
  ).id;
});

/** An active account for Anna, with one holding of the seeded entitlement. */
const seedHolding = (
  over: Record<string, unknown> = {},
  accountOver: Record<string, unknown> = {},
) =>
  withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId,
        correlationKey: 'anna.novak',
        status: 'active',
        ...accountOver,
      },
    });
    const holding = await tx.accountEntitlement.create({
      data: {
        tenantId,
        accountId: account.id,
        entitlementId,
        origin: 'rule',
        grantedByRuleId: ruleId,
        ...over,
      },
    });
    return { accountId: account.id, holdingId: holding.id };
  });

describe('explainPersonAccess', () => {
  it('answers why this person holds this, with the rule and the contract', async () => {
    await seedHolding({}, { anchor: 'guid-anna' });
    const contractId = await withTenant(tenantId, async (tx) =>
      (await tx.contract.findFirstOrThrow({ where: { personId } })).id,
    );

    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts).toHaveLength(1);
    const holding = access.accounts[0]!.entitlements[0]!;
    // This is the single most-asked question of a provisioning product, and it
    // is cheap here only because attribution was recorded at evaluation time.
    expect(holding.displayName).toBe('Finance');
    expect(holding.origin).toBe('rule');
    expect(holding.ruleName).toBe('Finance staff');
    expect(holding.contractId).toBe(contractId);
    expect(holding.contractDescription).toContain('Analyst');
  });

  it('carries the account itself, not only its holdings', async () => {
    await seedHolding({}, { anchor: 'guid-anna' });
    const access = await explainPersonAccess(tenantId, personId);
    expect(access.personId).toBe(personId);
    expect(access.accounts[0]).toMatchObject({
      targetSystemId: targetId,
      targetName: 'Acme AD',
      correlationKey: 'anna.novak',
      status: 'active',
      anchor: 'guid-anna',
    });
  });

  it('names a discovered holding as having no rule behind it', async () => {
    await seedHolding({ origin: 'discovered', grantedByRuleId: null });
    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts[0]!.entitlements[0]!.origin).toBe('discovered');
    expect(access.accounts[0]!.entitlements[0]!.ruleName).toBeNull();
    expect(access.accounts[0]!.entitlements[0]!.contractId).toBeNull();
  });

  it('omits revoked holdings', async () => {
    await seedHolding({ state: 'revoked', revokedAt: new Date() });
    const access = await explainPersonAccess(tenantId, personId);
    expect(access.accounts[0]!.entitlements).toEqual([]);
  });

  it('names the rule but withholds the contract when no active contract satisfies it', async () => {
    // The rule matched when the grant was made and the person has since moved
    // department. Naming a contract that does not satisfy the condition would
    // be a worse answer than declining to name one.
    await seedHolding();
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { department: 'Facilities' } }),
    );
    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleName).toBe('Finance staff');
    expect(holding.contractId).toBeNull();
    expect(holding.contractDescription).toBeNull();
  });

  it('still names the rule when its stored condition cannot be parsed', async () => {
    // A read-only "why" view must not go down because one rule was stored by
    // an older schema. The brief cast the column with `as never` and would
    // have thrown out of the interpreter instead.
    await seedHolding();
    await withTenant(tenantId, (tx) =>
      tx.businessRule.update({
        where: { id: ruleId },
        data: { condition: { field: 'contract.department', op: 'regex', value: '^a' } },
      }),
    );
    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleName).toBe('Finance staff');
    expect(holding.contractId).toBeNull();
  });

  it('answers for a person with no accounts at all', async () => {
    const access = await explainPersonAccess(tenantId, personId);
    expect(access).toEqual({ personId, accounts: [] });
  });

  it('does not reach into another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await seedHolding();
    // Bound to a tenant that holds nothing of this person's: RLS, not a
    // where-clause, is what makes this empty.
    expect(await explainPersonAccess(other.id, personId)).toEqual({
      personId,
      accounts: [],
    });
  });

  // --- the recorded reason, checked against the rules as they stand ---

  /** Edits the seeded rule, leaving its condition alone. */
  const editSeededRule = (over: { entitlementIds?: string[]; enabled?: boolean }) =>
    upsertBusinessRule(tenantId, null, targetId, {
      id: ruleId,
      name: 'Finance staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
      ...over,
    });

  /** A second rule that also asks for the seeded entitlement. */
  const secondRule = () =>
    upsertBusinessRule(tenantId, null, targetId, {
      name: 'Finance analysts',
      condition: { field: 'contract.jobTitle', op: 'equals', value: 'Analyst' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });

  it('confirms the recorded rule still grants it, and says so', async () => {
    await seedHolding();
    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.attributionStale).toBe(false);
    expect(holding.grantedByRuleId).toBe(ruleId);
    expect(holding.currentRules.map((r) => r.ruleName)).toEqual(['Finance staff']);
  });

  it('names the rule that grants it now, not the one that granted it in January', async () => {
    // January: R1 grants Alice Finance-RW, stamped R1. March: an administrator
    // drops Finance-RW from R1 -- its condition untouched, still matching her
    // -- and creates R2, which grants it. The holding is not rewritten,
    // because `apply.ts` skips the create when a live holding exists. The page
    // read "origin: rule -- rule: Finance staff", which is complete, plausible
    // and false: R1 has not granted it since March, and R2, which actually
    // holds the access in place, was never named. Revoke R1 on that page and
    // Alice keeps the access.
    await seedHolding();
    await editSeededRule({ entitlementIds: [] });
    await secondRule();

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleName).toBe('Finance analysts');
    expect(holding.contractDescription).toContain('Analyst');
    expect(holding.attributionStale).toBe(true);
    // The stamp is still reported -- as history, which is what it is.
    expect(holding.grantedByRuleId).toBe(ruleId);
    expect(holding.grantedByRuleName).toBe('Finance staff');
    expect(holding.currentRules.map((r) => r.ruleName)).toEqual(['Finance analysts']);
  });

  it('names no rule at all when nothing asks for the entitlement any more', async () => {
    // The other half: the stamp is dead and nothing replaced it. Naming the
    // dead rule would be the same falsehood; naming nothing is true, and it
    // says the next run will revoke this.
    await seedHolding();
    await editSeededRule({ entitlementIds: [] });

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleId).toBeNull();
    expect(holding.ruleName).toBeNull();
    expect(holding.contractId).toBeNull();
    expect(holding.attributionStale).toBe(true);
    expect(holding.currentRules).toEqual([]);
  });

  it('does not credit a disabled rule with granting anything', async () => {
    // `desiredState` skips a disabled rule and Ruling P27 takes its
    // entitlements out of the remit, so it is not why anybody holds anything.
    await seedHolding();
    await editSeededRule({ enabled: false });

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleName).toBeNull();
    expect(holding.attributionStale).toBe(true);
    expect(holding.currentRules).toEqual([]);
  });

  it('names the surviving rule when the recorded one has been deleted', async () => {
    // The multi-attribution case, which needs no edit at all: two rules
    // attribute one grant, `attributedRuleIds[0]` records one and discards the
    // other. Delete the recorded one -- `grantedByRuleId` carries no foreign
    // key, so the stamp dangles -- and the page used to read `origin: 'rule'`
    // beside `ruleId: null`: granted by a rule, no rule, while the surviving
    // rule held the access in place, unnamed.
    await seedHolding();
    await secondRule();
    await withTenant(tenantId, (tx) => tx.businessRule.delete({ where: { id: ruleId } }));

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.origin).toBe('rule');
    expect(holding.ruleName).toBe('Finance analysts');
    expect(holding.grantedByRuleId).toBe(ruleId);
    expect(holding.grantedByRuleName).toBeNull();
    expect(holding.attributionStale).toBe(true);
  });

  it('lists every rule that currently asks for the entitlement', async () => {
    // "Show every rule that currently asks for it": revoking one of two and
    // expecting the access to go is exactly the mistake a single name invites.
    await seedHolding();
    await secondRule();

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.currentRules.map((r) => r.ruleName)).toEqual([
      'Finance analysts',
      'Finance staff',
    ]);
    // Each with the contract that satisfies IT, not the first contract found.
    expect(holding.currentRules.every((r) => r.contractId !== null)).toBe(true);
    expect(holding.attributionStale).toBe(false);
  });

  it('does not attribute a discovered holding to a rule that would also grant it', async () => {
    // `origin` says a rule is not why this is here. The live set still names
    // the rule that asks for it, which is the useful half, but the answer to
    // "why does this person have this" stays "somebody put them in the group".
    await seedHolding({ origin: 'discovered', grantedByRuleId: null });
    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.ruleId).toBeNull();
    expect(holding.attributionStale).toBe(false);
    expect(holding.currentRules.map((r) => r.ruleName)).toEqual(['Finance staff']);
  });

  it('ignores a rule that names the entitlement at another target', async () => {
    const otherTargetId = (
      await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
        name: 'Other AD',
        config,
        bindPassword: 'secret',
      })
    ).id;
    // The SAME entitlement row, named by a rule belonging to another target:
    // a rule cannot grant access at a target it does not manage, and
    // `upsertBusinessRule` refuses the pairing, so this is written directly.
    await seedHolding();
    await editSeededRule({ entitlementIds: [] });
    await withTenant(tenantId, async (tx) => {
      const rule = await tx.businessRule.create({
        data: {
          tenantId,
          targetSystemId: otherTargetId,
          name: 'Someone else’s rule',
          condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
          enabled: true,
        },
      });
      await tx.ruleEntitlement.create({
        data: { tenantId, ruleId: rule.id, entitlementId },
      });
    });

    const holding = (await explainPersonAccess(tenantId, personId)).accounts[0]!
      .entitlements[0]!;
    expect(holding.currentRules).toEqual([]);
    expect(holding.ruleName).toBeNull();
  });
});

describe('previewRuleImpact', () => {
  it('reports the blast radius before the rule is saved', async () => {
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    // "this rule matches 1 of 2 persons; enabling it would grant 1 entitlement
    // and revoke 0." A rule whose blast radius is only visible after it is
    // saved is a rule that gets saved and then discovered.
    expect(impact).toMatchObject({
      matchedPersons: 1,
      totalPersons: 2,
      wouldGrant: 1,
      wouldRevoke: 0,
    });
    expect(impact.sample[0]!.displayName).toBe('Anna Novak');
  });

  it('reports revocations a narrowed rule would cause', async () => {
    await seedHolding();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        // Narrowed to a job title nobody holds.
        condition: { field: 'contract.jobTitle', op: 'equals', value: 'Controller' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.matchedPersons).toBe(0);
    expect(impact.wouldRevoke).toBe(1);
  });

  it('counts what an entitlement REMOVED from the rule would revoke', async () => {
    // The empty case is the universal case, for the fifth time on this slice.
    // Computing revocations only from the entitlements the rule still names
    // reports "revokes 0" for the one edit that revokes everything — and
    // emptying the list is a single click.
    await seedHolding();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      },
      NOW,
    );
    expect(impact.matchedPersons).toBe(1);
    expect(impact.wouldGrant).toBe(0);
    expect(impact.wouldRevoke).toBe(1);
  });

  it('counts a holding it already granted to a matching person as no new grant', async () => {
    await seedHolding();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.matchedPersons).toBe(1);
    expect(impact.wouldGrant).toBe(0);
    expect(impact.wouldRevoke).toBe(0);
  });

  it('never reports a negative number of grants', async () => {
    // Two rows this query reads as live, on one account, for one entitlement.
    //
    // `account_entitlement_one_live` is UNIQUE (accountId, entitlementId)
    // WHERE "revokedAt" IS NULL -- keyed on `revokedAt`, while every reader in
    // this package (and this function) selects on `state: 'held'`. The two
    // disagreeing is a row the database accepts and this code counts twice,
    // and `matched x entitlements - alreadyHeld` goes negative on it. A
    // negative blast radius on a review screen is worse than a conservative
    // zero.
    const { accountId } = await seedHolding();
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.create({
        data: {
          tenantId,
          accountId,
          entitlementId,
          origin: 'discovered',
          state: 'held',
          revokedAt: new Date(),
        },
      }),
    );
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.wouldGrant).toBe(0);
  });

  it('ignores a holding of the same entitlement at another target', async () => {
    const otherTargetId = (
      await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
        name: 'Other AD',
        config,
        bindPassword: 'secret',
      })
    ).id;
    await withTenant(tenantId, async (tx) => {
      const bo = await tx.person.findFirstOrThrow({ where: { givenName: 'Bo' } });
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: otherTargetId,
          personId: bo.id,
          correlationKey: 'bo.lind',
          status: 'active',
        },
      });
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'discovered' },
      });
    });
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    // Bo holds it, at a target this rule says nothing about.
    expect(impact.wouldRevoke).toBe(0);
  });

  it('writes nothing', async () => {
    const before = await withTenant(tenantId, (tx) => tx.businessRule.count());
    await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Unsaved',
        condition: { all: [] },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      },
      NOW,
    );
    expect(await withTenant(tenantId, (tx) => tx.businessRule.count())).toBe(before);
  });

  it('refuses a malformed condition rather than previewing it as matching nobody', async () => {
    // `evaluateCondition` falls through both switches on a leaf it does not
    // recognise and returns undefined, which `.some()` reads as false -- so an
    // unparseable rule previews as "matches 0 of 2 persons", which is exactly
    // what a correctly narrow rule looks like.
    await expect(
      previewRuleImpact(
        tenantId,
        targetId,
        {
          name: 'Malformed',
          condition: { field: 'contract.department', op: 'regex', value: '^a' } as never,
          grantsAccount: true,
          enabled: true,
          entitlementIds: [],
        },
        NOW,
      ),
    ).rejects.toThrow();
  });

  // --- what the planner will actually revoke ---

  /** Bo Lind, with an account at this target and one holding of the seeded entitlement. */
  const seedBoHolding = (over: Record<string, unknown> = {}) =>
    withTenant(tenantId, async (tx) => {
      const bo = await tx.person.findFirstOrThrow({ where: { givenName: 'Bo' } });
      const account = await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: bo.id,
          correlationKey: 'bo.lind',
          status: 'active',
        },
      });
      const holding = await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'rule', ...over },
      });
      return { personId: bo.id, holdingId: holding.id };
    });

  /** Narrows the seeded rule to match nobody, without changing what it names. */
  const narrowedToNobody = {
    id: undefined as string | undefined,
    name: 'Finance staff',
    condition: { field: 'contract.jobTitle', op: 'equals', value: 'Controller' } as never,
    grantsAccount: true,
    enabled: true,
    entitlementIds: [] as string[],
  };

  it('does not count a holding another rule still grants', async () => {
    // `R1` grants `E1` to Finance, `R2` grants `E1` to Facilities. Narrowing
    // `R1` to match nobody revokes the Finance holdings and nothing else:
    // `planActions` skips any entitlement still in `state.entitlements`, which
    // is the union over every enabled rule. Counting on the entitlement id
    // alone said "revokes 340" for an edit that revokes twelve.
    await seedHolding();
    const bo = await seedBoHolding();
    const r2 = await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Facilities staff',
      condition: { field: 'contract.department', op: 'equals', value: 'Facilities' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.update({
        where: { id: bo.holdingId },
        data: { grantedByRuleId: r2.id },
      }),
    );

    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      { ...narrowedToNobody, id: ruleId, entitlementIds: [entitlementId] },
      NOW,
    );
    expect(impact.matchedPersons).toBe(0);
    // Anna's, and not Bo's.
    expect(impact.wouldRevoke).toBe(1);
  });

  it('does not count a hand-made holding under additive enforcement', async () => {
    // `reconcile` records a holding Provision did not grant as
    // `unmanaged_entitlement` and, under `additive`, deliberately keeps it OUT
    // of `heldWithinRemit`: it is never revoked in that mode. Counting it as a
    // revocation promises an administrator a tidy-up that will not happen.
    await seedHolding();
    await seedBoHolding({ origin: 'discovered', grantedByRuleId: null });

    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      { ...narrowedToNobody, id: ruleId, entitlementIds: [entitlementId] },
      NOW,
    );
    expect(impact.wouldRevoke).toBe(1);
  });

  it('counts a hand-made in-remit holding under authoritative enforcement', async () => {
    // The same fixture and the other mode: `authoritative` says take charge of
    // the entitlements the rules name, so `reconcile` puts the unmanaged
    // in-remit holding INTO `heldWithinRemit` and the run does revoke it.
    await seedHolding();
    await seedBoHolding({ origin: 'discovered', grantedByRuleId: null });
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { enforcementMode: 'authoritative' },
      }),
    );

    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      { ...narrowedToNobody, id: ruleId, entitlementIds: [entitlementId] },
      NOW,
    );
    expect(impact.wouldRevoke).toBe(2);
  });

  it('counts a holding whose stamp names a rule that has been deleted', async () => {
    // The under-report, and the direction that matters more. `apply.ts` stamps
    // `attributedRuleIds[0]`, so a holding this rule granted can carry another
    // rule's id -- and that rule may since have been deleted, leaving the
    // stamp dangling. Preview an edit dropping the entitlement: it is off the
    // new list so the named read missed it, and the stamp is not this rule's
    // id so the `mine` read missed it too -- while the holding is
    // `origin: 'rule'`, therefore inside `heldWithinRemit`, therefore revoked
    // by the very next run. The preview said the edit takes nothing away.
    const seeded = await seedHolding();
    const ghost = await upsertBusinessRule(tenantId, null, targetId, {
      name: 'Deleted rule',
      condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
      grantsAccount: true,
      enabled: true,
      entitlementIds: [entitlementId],
    });
    await withTenant(tenantId, async (tx) => {
      await tx.accountEntitlement.update({
        where: { id: seeded.holdingId },
        data: { grantedByRuleId: ghost.id },
      });
      await tx.businessRule.delete({ where: { id: ghost.id } });
    });

    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        // The condition still matches Anna; the entitlement is being dropped.
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [],
      },
      NOW,
    );
    expect(impact.matchedPersons).toBe(1);
    expect(impact.wouldRevoke).toBe(1);
  });

  it('counts everything the rule granted when the edit switches it off', async () => {
    // A disabled rule desires nothing: `desiredState` skips it, so every
    // holding it is the only reason for is revoked. Reporting the grant count
    // of a rule that will grant nothing would be the same untruth the other
    // way up.
    await seedHolding();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        id: ruleId,
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: false,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.wouldGrant).toBe(0);
    expect(impact.wouldRevoke).toBe(1);
  });

  // --- the segregation-of-duties column ---

  /**
   * A second entitlement at this target, a readable Govern snapshot, and a
   * `critical` rule making the two entitlements incompatible.
   *
   * The snapshot has no holdings deliberately: the case being pinned is the
   * BIRTHRIGHT one, where a single rule grants both sides at once to somebody
   * who holds neither today. That is the violation an administrator creates
   * with one click, and it is invisible to anything that looks only at what
   * people already hold.
   */
  const seedSodRule = async () => {
    const approveId = await withTenant(tenantId, async (tx) => {
      const approve = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-ap-approve',
          type: 'group',
          displayName: 'AP approve',
        },
      });
      const snapshot = await tx.accessSnapshot.create({
        data: {
          tenantId,
          kind: 'manual',
          status: 'complete',
          asOf: NOW,
          unattributedAccountCount: 0,
        },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId,
          snapshotId: snapshot.id,
          sourceKind: 'syntraInternal',
          sourceId: 'syntra',
          sourceName: 'Syntra',
          completeness: 'complete',
          staleness: 'fresh',
          freshnessSlaHours: 24,
        },
      });
      return approve.id;
    });
    const raise = await upsertBusinessFunction(tenantId, null, {
      name: 'Raise a payment',
      description: null,
      ownerPersonId: personId,
      resources: [
        { systemId: targetId, resourceKind: 'targetEntitlement', resourceId: entitlementId },
      ],
    });
    const approve = await upsertBusinessFunction(tenantId, null, {
      name: 'Approve a payment',
      description: null,
      ownerPersonId: personId,
      resources: [
        { systemId: targetId, resourceKind: 'targetEntitlement', resourceId: approveId },
      ],
    });
    await upsertSodRule(tenantId, null, {
      name: 'Payment raising and approval',
      functionAId: raise.id,
      functionBId: approve.id,
      severity: 'critical',
      rationale: 'the same person must not raise a payment and approve it',
      exceptionWorkflowId: null,
      enabled: true,
    });
    return { approveId };
  };

  it('reports zero SoD impact in a tenant that has configured no rule', async () => {
    // The overwhelmingly common tenant, and the degradation that matters: an
    // absent SoD picture is not a violation, and the rule editor must open.
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.sodIntroduced).toBe(0);
    expect(impact.sodIntroducedCritical).toBe(0);
    expect(impact.sodSample).toEqual([]);
  });

  it('counts the violation a birthright rule granting BOTH sides would INTRODUCE', async () => {
    const { approveId } = await seedSodRule();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId, approveId],
      },
      NOW,
    );
    // Anna matches; Bo does not. One person, one rule, one introduced
    // violation — and it is `critical`, which is the severity Provision's run
    // guard escalates on.
    expect(impact.matchedPersons).toBe(1);
    expect(impact.sodIntroduced).toBe(1);
    expect(impact.sodIntroducedCritical).toBe(1);
    expect(impact.sodSample).toEqual([
      { personId, ruleName: 'Payment raising and approval' },
    ]);
    // And it does not refuse, block, or otherwise change what the preview says
    // about the grant itself. The column informs; it never gates.
    expect(impact.wouldGrant).toBe(2);
  });

  it('counts nothing when the rule grants only ONE side', async () => {
    // A rule that puts nobody on both sides introduces nothing, and a column
    // that fired here would be ignored within a week.
    await seedSodRule();
    const impact = await previewRuleImpact(
      tenantId,
      targetId,
      {
        name: 'Finance staff',
        condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
        grantsAccount: true,
        enabled: true,
        entitlementIds: [entitlementId],
      },
      NOW,
    );
    expect(impact.sodIntroduced).toBe(0);
    expect(impact.sodIntroducedCritical).toBe(0);
  });

  it('refuses a condition nested past the cap, rather than previewing it', async () => {
    let condition: unknown = { field: 'contract.department', op: 'isNotEmpty' };
    for (let i = 0; i < 40; i += 1) condition = { not: condition };
    await expect(
      previewRuleImpact(
        tenantId,
        targetId,
        {
          name: 'Deep',
          condition: condition as never,
          grantsAccount: true,
          enabled: true,
          entitlementIds: [],
        },
        NOW,
      ),
    ).rejects.toThrow(/32 levels deep/);
  });
});

describe('previewAccountProfile', () => {
  it('shows what the templates would produce for a real person', async () => {
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    // A template language nobody can try is a template language everybody gets
    // wrong.
    expect(preview).toEqual({
      correlationKey: 'anna.novak',
      taken: false,
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      containerSource: 'template',
      attributes: { displayName: 'Anna Novak', mail: 'anna@acme.test' },
      problems: [],
    });
  });

  it('previews the container the org unit puts this person in', async () => {
    // An explanation that disagrees with the plan is worse than none, because
    // it is believed. Before the ladder existed here, this screen rendered the
    // template's answer for a person the run would place somewhere else.
    await withTenant(tenantId, async (tx) => {
      const unit = await tx.orgUnit.create({ data: { tenantId, name: 'Sales' } });
      await tx.orgUnitContainer.create({
        data: {
          tenantId,
          orgUnitId: unit.id,
          targetSystemId: targetId,
          dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
          state: 'adopted',
        },
      });
      await tx.person.update({ where: { id: personId }, data: { orgUnitId: unit.id } });
    });
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.container).toBe('OU=Sales,OU=Users,DC=acme,DC=test');
    expect(preview.containerSource).toBe('orgUnit');
  });

  it('previews a manual placement ahead of the org unit', async () => {
    await withTenant(tenantId, async (tx) => {
      const unit = await tx.orgUnit.create({ data: { tenantId, name: 'Sales' } });
      await tx.orgUnitContainer.create({
        data: {
          tenantId,
          orgUnitId: unit.id,
          targetSystemId: targetId,
          dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
          state: 'adopted',
        },
      });
      await tx.person.update({ where: { id: personId }, data: { orgUnitId: unit.id } });
      await tx.accountPlacement.create({
        data: {
          tenantId,
          personId,
          targetSystemId: targetId,
          container: 'OU=Contractors,OU=Users,DC=acme,DC=test',
          reason: 'seconded to the contractor team',
        },
      });
    });
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.container).toBe('OU=Contractors,OU=Users,DC=acme,DC=test');
    expect(preview.containerSource).toBe('override');
  });

  it('names the fallback as the fallback when the template cannot render', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { department: null } }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.container).toBe('OU=Users,DC=acme,DC=test');
    expect(preview.containerSource).toBe('fallback');
  });

  it('says when the key is already taken', async () => {
    await withTenant(tenantId, async (tx) => {
      const other = await tx.person.create({
        data: { tenantId, givenName: 'Anne', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: other.id,
          correlationKey: 'anna.novak',
          status: 'pending',
        },
      });
    });
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.taken).toBe(true);
    expect(preview.correlationKey).toBe('anna.novak2');
  });

  it('does not count this person against their own account', async () => {
    await seedHolding();
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.taken).toBe(false);
    expect(preview.correlationKey).toBe('anna.novak');
  });

  it('names every template that cannot resolve rather than rendering it empty', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.update({ where: { id: personId }, data: { businessEmail: null } }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.problems).toEqual([
      'the template for "mail" references person.businessEmail, which resolves to nothing for this person',
    ]);
    expect(preview.attributes.mail).toBeUndefined();
  });

  it('falls back when the container template resolves to nothing', async () => {
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { personId }, data: { department: null } }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    expect(preview.container).toBe('OU=Users,DC=acme,DC=test');
  });

  it('escapes the container it shows, exactly as the run would place it', async () => {
    // Ruling P22. A department of `Finance,OU=Domain Controllers` renders a
    // VALID distinguished name naming a container the administrator never
    // wrote — and the preview is the screen they check it on, so rendering it
    // unescaped here shows them the wrong answer at the moment they are
    // looking for the wrong answer.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId },
        data: { department: 'Finance,OU=Domain Controllers' },
      }),
    );
    const preview = await previewAccountProfile(
      tenantId,
      targetId,
      profileInput,
      personId,
      NOW,
    );
    // Both the comma and the `=` are escaped: RFC 4514 says a `=` inside an
    // attribute VALUE must be, and leaving it would let a department close
    // one RDN and open another.
    expect(preview.container).toBe(
      'OU=Finance\\,OU\\=Domain Controllers,OU=Users,DC=acme,DC=test',
    );
  });

  it('refuses a profile that would template an attribute the guard cannot count', async () => {
    // `update_account` writes the complete managed set and is deliberately
    // absent from GUARDED_ACTION_TYPES, so a profile templating
    // `userAccountControl` is a way to disable every managed account that the
    // slice's most important control never sees. The SAVE refuses it; a
    // preview that rendered it would be a working screenshot of a capability
    // that must not exist.
    await expect(
      previewAccountProfile(
        tenantId,
        targetId,
        {
          ...profileInput,
          attributeTemplates: { userAccountControl: '514' },
        },
        personId,
        NOW,
      ),
    ).rejects.toThrow(/userAccountControl/);
  });

  it('writes nothing', async () => {
    const before = await withTenant(tenantId, (tx) => tx.targetAccount.count());
    await previewAccountProfile(tenantId, targetId, profileInput, personId, NOW);
    expect(await withTenant(tenantId, (tx) => tx.targetAccount.count())).toBe(before);
  });
});
