import { withTenant } from '@syntra/db';
import {
  conditionSchema,
  evaluateCondition,
  type Condition,
  type ConditionFacts,
} from './condition.js';
import { activeOn, personDisplayName, resolveMappingContract } from './desired.js';
import { generateCorrelationKey, SAM_ACCOUNT_NAME_MAX_LENGTH } from './names.js';
import { renderContainer, renderTemplate, type TemplateContext } from './templates.js';
import {
  accountProfileSchema,
  boundedConditionSchema,
  type AccountProfileInput,
  type BusinessRuleInput,
} from './target-service.js';
import type { ContractFacts } from './types.js';

export interface PersonAccessEntitlement {
  entitlementId: string;
  displayName: string;
  origin: string;
  ruleId: string | null;
  ruleName: string | null;
  contractId: string | null;
  contractDescription: string | null;
}

export interface PersonAccess {
  personId: string;
  accounts: {
    targetSystemId: string;
    targetName: string;
    correlationKey: string;
    status: string;
    anchor: string | null;
    entitlements: PersonAccessEntitlement[];
  }[];
}

const describeContract = (c: {
  jobTitle: string | null;
  department: string | null;
  sequence: number;
}) => [c.jobTitle, c.department].filter(Boolean).join(', ') || `contract ${c.sequence}`;

/**
 * The facts one contract presents to a rule, in exactly the shape
 * `desiredState` builds — so an explanation and a run cannot disagree about
 * which contract satisfied a condition.
 */
function contractFacts(
  contract: {
    department: string | null;
    jobTitle: string | null;
    costCentre: string | null;
    employer: string | null;
    location: string | null;
    fte: number | null;
  },
  personStatus: string,
): ConditionFacts {
  return {
    'contract.department': contract.department,
    'contract.jobTitle': contract.jobTitle,
    'contract.costCentre': contract.costCentre,
    'contract.employer': contract.employer,
    'contract.location': contract.location,
    'contract.fte': contract.fte,
    'person.status': personStatus,
  };
}

/**
 * Answers "why does this person hold this?" with a rule name and a contract.
 *
 * The most-asked question of any provisioning product, and unanswerable after
 * the fact if the reason is not recorded at the time — which is why
 * `AccountEntitlement.origin` and `grantedByRuleId` are written at the moment
 * of the grant rather than derived later.
 */
export async function explainPersonAccess(
  tenantId: string,
  personId: string,
  now: Date = new Date(),
): Promise<PersonAccess> {
  return withTenant(tenantId, async (tx) => {
    const accounts = await tx.targetAccount.findMany({
      where: { personId },
      include: {
        target: { select: { id: true, name: true } },
        entitlements: {
          // Revoked holdings are history, not access. The question this view
          // answers is "what can this person do now".
          where: { state: 'held' },
          include: { entitlement: { select: { id: true, displayName: true } } },
        },
      },
    });

    const ruleIds = [
      ...new Set(
        accounts.flatMap((a) =>
          a.entitlements
            .map((h) => h.grantedByRuleId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ];
    const rules =
      // `{ in: [] }` is a query that returns nothing and still costs a round
      // trip; more to the point, the empty case is where this slice keeps
      // finding defects, so it is written out rather than left to Prisma.
      ruleIds.length === 0
        ? []
        : await tx.businessRule.findMany({ where: { id: { in: ruleIds } } });

    /**
     * Parsed, not cast.
     *
     * The brief had `evaluateCondition(rule.condition as never, …)`, and an
     * `as never` on an argument is a suppressed diagnostic rather than a
     * convenience — this programme has already paid for that once, in nine
     * places, in Task 4. `BusinessRule.condition` is a Prisma `Json` column,
     * so what comes back is `unknown` and the compiler is right to say so.
     *
     * `safeParse` rather than `parse` because this is a read-only "why" view:
     * one rule stored by an older version of the schema must not take the
     * whole page down. An unparseable rule is still named — only the contract
     * attribution is withheld, which is the part that genuinely cannot be
     * computed.
     */
    const conditionById = new Map<string, Condition | null>(
      rules.map((r) => {
        const parsed = conditionSchema.safeParse(r.condition);
        return [r.id, parsed.success ? parsed.data : null];
      }),
    );
    const ruleById = new Map(rules.map((r) => [r.id, r]));

    const person = await tx.person.findUnique({
      where: { id: personId },
      select: { status: true },
    });
    const contracts = await tx.contract.findMany({ where: { personId } });
    const active = activeOn(
      contracts.map((c) => ({
        ...c,
        fte: c.fte === null ? null : Number(c.fte),
      })),
      now,
    );

    return {
      personId,
      accounts: accounts.map((account) => ({
        targetSystemId: account.target.id,
        targetName: account.target.name,
        correlationKey: account.correlationKey,
        status: account.status,
        anchor: account.anchor,
        entitlements: account.entitlements.map((holding) => {
          const rule =
            holding.grantedByRuleId === null
              ? null
              : (ruleById.get(holding.grantedByRuleId) ?? null);
          const condition = rule === null ? null : (conditionById.get(rule.id) ?? null);
          // Which contract satisfied the rule: the first active one whose
          // facts the rule's condition accepts.
          const contract =
            condition === null
              ? null
              : (active.find((c) =>
                  evaluateCondition(condition, contractFacts(c, person?.status ?? 'active')),
                ) ?? null);
          return {
            entitlementId: holding.entitlement.id,
            displayName: holding.entitlement.displayName,
            origin: holding.origin,
            ruleId: rule?.id ?? null,
            ruleName: rule?.name ?? null,
            contractId: contract?.id ?? null,
            contractDescription: contract === null ? null : describeContract(contract),
          };
        }),
      })),
    };
  });
}

export interface RuleImpact {
  matchedPersons: number;
  totalPersons: number;
  wouldGrant: number;
  wouldRevoke: number;
  sample: { personId: string; displayName: string }[];
}

/** Capped: an impact preview must not return 40,000 names to a browser. */
export const RULE_IMPACT_SAMPLE_SIZE = 25;

/**
 * "This rule matches 412 of 1,180 persons; enabling it would grant 412
 * entitlements and revoke 3." Computed without writing anything.
 *
 * A rule whose blast radius is only visible after it is saved is a rule that
 * gets saved and then discovered.
 */
export async function previewRuleImpact(
  tenantId: string,
  targetSystemId: string,
  rule: BusinessRuleInput,
  now: Date = new Date(),
): Promise<RuleImpact> {
  /**
   * Parsed before anything is evaluated, and with the BOUNDED schema.
   *
   * The API's `conditionRequestSchema` falls back to `z.record(z.unknown())`
   * for leaves, so a malformed leaf reaches here intact -- and
   * `evaluateCondition` falls through both of its switches and returns
   * `undefined`, which `.some()` reads as false. The rule then previews as
   * "matches 0 persons", which reads as a narrow rule rather than a broken
   * one, and somebody saves it.
   *
   * `boundedConditionSchema` rather than `conditionSchema` so a preview
   * accepts exactly what a save accepts: a condition this refuses on depth
   * would otherwise preview cleanly and then fail to store.
   */
  const condition = boundedConditionSchema.parse(rule.condition);
  const entitlementIds = [...new Set(rule.entitlementIds)];
  const ruleId = rule.id;

  return withTenant(tenantId, async (tx) => {
    const persons = await tx.person.findMany({ include: { contracts: true } });

    /**
     * Two reads, because the empty case here is not the harmless one.
     *
     * `named` is every live holding of the entitlements this rule WOULD grant;
     * `mine` is every live holding this rule HAS granted. A rule edited to
     * name fewer entitlements — or none at all — revokes the ones it dropped,
     * and computing revocations only from the named set reports that as
     * "revokes 0" precisely when it revokes everything. That is the
     * empty-set-is-the-universal-set defect this slice has now found five
     * times, and emptying an entitlement list is the one-click way to hit it.
     */
    const named =
      entitlementIds.length === 0
        ? []
        : await tx.accountEntitlement.findMany({
            where: {
              state: 'held',
              entitlementId: { in: entitlementIds },
              account: { targetSystemId },
            },
            include: { account: { select: { personId: true } } },
          });
    const mine =
      ruleId === undefined
        ? []
        : await tx.accountEntitlement.findMany({
            where: {
              state: 'held',
              grantedByRuleId: ruleId,
              account: { targetSystemId },
            },
            include: { account: { select: { personId: true } } },
          });

    const matched: { personId: string; displayName: string }[] = [];
    for (const person of persons) {
      const contracts: ContractFacts[] = person.contracts.map((c) => ({
        id: c.id,
        sequence: c.sequence,
        isPrimary: c.isPrimary,
        startDate: c.startDate,
        endDate: c.endDate,
        department: c.department,
        jobTitle: c.jobTitle,
        costCentre: c.costCentre,
        employer: c.employer,
        location: c.location,
        fte: c.fte === null ? null : Number(c.fte),
      }));
      const hit = activeOn(contracts, now).some((c) =>
        evaluateCondition(condition, contractFacts(c, person.status)),
      );
      if (hit) {
        matched.push({
          personId: person.id,
          // Derived: `Person` has no displayName column.
          displayName: personDisplayName(person),
        });
      }
    }

    const matchedIds = new Set(matched.map((m) => m.personId));
    const wanted = new Set(entitlementIds);

    // Deduplicated by holding id: a holding this rule granted, of an
    // entitlement it still names, held by somebody it no longer matches, is
    // one revocation and appears in both reads.
    const revoked = new Set<string>();
    for (const holding of named) {
      if (!matchedIds.has(holding.account.personId)) revoked.add(holding.id);
    }
    for (const holding of mine) {
      if (
        !wanted.has(holding.entitlementId) ||
        !matchedIds.has(holding.account.personId)
      ) {
        revoked.add(holding.id);
      }
    }

    const alreadyHeld = named.filter((h) => matchedIds.has(h.account.personId)).length;

    return {
      matchedPersons: matched.length,
      totalPersons: persons.length,
      // Clamped. `alreadyHeld` counts rows and the product counts pairs, and
      // nothing in the schema forbids two live holdings of one entitlement on
      // one account — a negative "would grant" on a review screen is worse
      // than a conservative zero.
      wouldGrant: Math.max(0, matched.length * entitlementIds.length - alreadyHeld),
      wouldRevoke: revoked.size,
      sample: matched.slice(0, RULE_IMPACT_SAMPLE_SIZE),
    };
  });
}

export interface ProfilePreview {
  correlationKey: string | null;
  taken: boolean;
  container: string | null;
  attributes: Record<string, string>;
  problems: string[];
}

/**
 * Pick a real person, see the correlation key, container and attributes the
 * templates would produce for them, and whether that key is already taken.
 *
 * A template language nobody can try is a template language everybody gets
 * wrong.
 */
export async function previewAccountProfile(
  tenantId: string,
  targetSystemId: string,
  profileInput: AccountProfileInput,
  personId: string,
  now: Date = new Date(),
): Promise<ProfilePreview> {
  /**
   * The profile is parsed with the schema the SAVE uses, not merely with the
   * transport schema the route parsed it against.
   *
   * `accountProfileRequestSchema` in `@syntra/contracts` takes
   * `attributeTemplates` as an open `z.record(z.string())`, and Task 12's
   * `accountProfileSchema` is what refuses `userAccountControl`, `member` and
   * `distinguishedName` — the attributes `update_account` writes and the guard
   * does not count. A preview that accepted them would render an administrator
   * a working screenshot of a profile the PUT then refuses, which is the
   * clearer half of the problem; the worse half is that it reads as
   * endorsement of a capability that must not exist.
   */
  const profile = accountProfileSchema.parse(profileInput);

  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
    });
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      include: { contracts: true },
    });
    const accounts = await tx.targetAccount.findMany({
      where: { targetSystemId },
      select: { personId: true, correlationKey: true },
    });

    const contracts: ContractFacts[] = person.contracts.map((c) => ({
      id: c.id,
      sequence: c.sequence,
      isPrimary: c.isPrimary,
      startDate: c.startDate,
      endDate: c.endDate,
      department: c.department,
      jobTitle: c.jobTitle,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      fte: c.fte === null ? null : Number(c.fte),
    }));
    const mapping = resolveMappingContract(contracts, now);

    // Exactly the shape `desiredState` builds, through the same helpers, so a
    // preview and a run cannot disagree about what a template resolves to.
    const context: TemplateContext = {
      person: {
        givenName: person.givenName,
        familyName: person.familyName,
        businessEmail: person.businessEmail,
        personalEmail: person.personalEmail,
        nameConvention: person.nameConvention,
        displayName: personDisplayName(person),
        status: person.status,
      },
      contract: {
        department: mapping?.department ?? null,
        jobTitle: mapping?.jobTitle ?? null,
        costCentre: mapping?.costCentre ?? null,
        employer: mapping?.employer ?? null,
        location: mapping?.location ?? null,
      },
      baseDn: (target.config as { baseDn?: string }).baseDn ?? '',
    };

    const problems: string[] = [];
    const attributes: Record<string, string> = {};
    for (const [name, template] of Object.entries(profile.attributeTemplates)) {
      const rendered = renderTemplate(template, context);
      if (rendered.ok) attributes[name] = rendered.value;
      else {
        problems.push(
          `the template for "${name}" references ${rendered.missing.join(', ')}, which resolves to nothing for this person`,
        );
      }
    }

    // `renderContainer`, never `renderTemplate`, because this is a DN and
    // Ruling P22 says the escaping is structural. A preview that renders the
    // container unescaped also *shows the administrator the wrong answer*,
    // which is worse than silently doing the wrong thing: it is the screen
    // they check it on. `fallbackContainer` is not rendered at all — it is a
    // literal, exactly as `desiredState` treats it.
    const containerRendered = renderContainer(profile.containerTemplate, context);
    const container = containerRendered.ok
      ? containerRendered.value
      : profile.fallbackContainer;
    if (container.trim() === '') {
      // The same condition `desiredState` reports as `container_missing`. The
      // schema requires a non-empty fallback, so reaching this means one made
      // entirely of whitespace.
      problems.push(
        containerRendered.ok
          ? 'the container template resolves to nothing for this person, and the profile has no fallback container'
          : `the container template references ${containerRendered.missing.join(', ')}, which resolves to nothing for this person, and the profile has no fallback container`,
      );
    }

    const otherKeys = new Set(
      accounts.filter((a) => a.personId !== personId).map((a) => a.correlationKey),
    );
    const base = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken: new Set<string>(),
      maxLength: SAM_ACCOUNT_NAME_MAX_LENGTH,
      maxAttempts: profile.maxUniquenessAttempts,
    });
    const unique = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken: otherKeys,
      maxLength: SAM_ACCOUNT_NAME_MAX_LENGTH,
      maxAttempts: profile.maxUniquenessAttempts,
    });

    if (!unique.ok) {
      problems.push(
        unique.reason === 'exhausted'
          ? `no unique account name could be generated within ${profile.maxUniquenessAttempts} attempts`
          : `the account name template references ${unique.missing.join(', ')}, which resolves to nothing for this person`,
      );
    }

    return {
      correlationKey: unique.ok ? unique.correlationKey : null,
      taken: base.ok && unique.ok && base.correlationKey !== unique.correlationKey,
      container,
      attributes,
      problems,
    };
  });
}
