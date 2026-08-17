import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { explainPersonAccess, previewAccountProfile, previewRuleImpact } from './explain.js';

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
      attributes: { displayName: 'Anna Novak', mail: 'anna@acme.test' },
      problems: [],
    });
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
