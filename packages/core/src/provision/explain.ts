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
  /**
   * The rule this holding is attributed to **as verified against the rules as
   * they stand now** — never a rule that no longer asks for this entitlement.
   *
   * The recorded stamp when the rule still names the entitlement and is still
   * enabled; otherwise, for a holding whose origin is `rule`, the first rule
   * that currently does ask for it; otherwise null. See `currentRules` for the
   * whole live set and `grantedByRuleId` for the stamp itself.
   */
  ruleId: string | null;
  ruleName: string | null;
  contractId: string | null;
  contractDescription: string | null;
  /**
   * What `apply.ts` stamped on the holding at the moment of the grant:
   * `attributedRuleIds[0]`, the first of possibly several attributing rules,
   * never updated afterwards and left dangling when that rule is deleted.
   * History, and useful as history — but not an answer to "why does this
   * person have this **now**".
   */
  grantedByRuleId: string | null;
  grantedByRuleName: string | null;
  /**
   * The AccessGrant behind an `origin: 'request'` holding, and when it ends.
   *
   * Null for everything a rule, an administrator or the target itself put
   * there. This is the other half of "why does this person hold this": a rule
   * and a contract, a request and its approver, or both -- the two
   * attributions are independent and end independently.
   */
  grantId: string | null;
  requestId: string | null;
  grantEndsAt: Date | null;
  /**
   * The stamp no longer accounts for this holding: the rule it names has been
   * deleted, disabled, or edited to stop naming this entitlement — or the
   * holding says `origin: 'rule'` and carries no stamp at all. `currentRules`
   * is then the only true answer, and an empty `currentRules` beside a true
   * `attributionStale` means nothing asks for this access any more.
   */
  attributionStale: boolean;
  /**
   * Every enabled rule on this account's target that names this entitlement
   * **and** matches an active contract of this person today: the live reason
   * the access is in place, resolved the way `desiredState` resolves it rather
   * than read off a stamp.
   */
  currentRules: {
    ruleId: string;
    ruleName: string;
    contractId: string | null;
    contractDescription: string | null;
  }[];
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
 *
 * **Recorded is not the same as still true, and this page has to say which.**
 * `grantedByRuleId` is written exactly once, at `apply.ts`, as
 * `attributedRuleIds[0]` — the first of possibly several attributing rules —
 * and nothing ever updates it: the create is skipped entirely when a live
 * holding already exists, so a later rule taking the holding over never
 * restamps it, and deleting the stamped rule leaves the column dangling
 * (`grantedByRuleId` carries no foreign key). So an answer read off that
 * column alone is plausible, complete, and can be false in the only part that
 * matters:
 *
 * - January: `R1` ("Finance staff") grants Alice `Finance-RW`, stamped `R1`.
 * - March: an administrator drops `Finance-RW` from `R1` — its condition
 *   untouched, still matching Alice — and creates `R2`, which grants it. The
 *   holding is not rewritten, because it is already held.
 * - The page said *"Finance-RW — origin: rule — rule: Finance staff"*. `R1`
 *   has not granted it since March, and `R2`, which actually holds the access
 *   in place, was never named. Revoke `R1` on that page and Alice keeps it.
 *
 * So the stamp is intersected against the rule's **current** `RuleEntitlement`
 * rows before it is presented, and the live attribution is resolved the way
 * `desiredState` resolves it: every enabled rule on that account's target that
 * names the entitlement and matches an active contract. `ruleId` never names a
 * rule that does not currently ask for this; `attributionStale` says when the
 * stamp stopped accounting for it; `currentRules` names all of them, which is
 * also the multi-attribution case — two rules attributing one grant, of which
 * `attributedRuleIds[0]` recorded one and discarded the other, so deleting the
 * recorded one used to render `origin: 'rule'` beside `ruleId: null`:
 * "granted by a rule, no rule".
 *
 * The rules read is bounded and stays inside the transaction: the stamped
 * rules, plus the enabled rules that name one of the entitlements THIS PERSON
 * holds. It follows the number of rules an administrator wrote for those
 * entitlements, never the size of the directory.
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
    // The entitlements this person actually holds, and the targets they hold
    // them at: the bound on the live-attribution read below.
    const heldEntitlementIds = [
      ...new Set(accounts.flatMap((a) => a.entitlements.map((h) => h.entitlementId))),
    ];
    const targetIds = [...new Set(accounts.map((a) => a.targetSystemId))];

    /**
     * Two questions, one read: which rules are STAMPED on these holdings, and
     * which rules currently ASK for them.
     *
     * `{ in: [] }` is a query that returns nothing and still costs a round
     * trip; more to the point, the empty case is where this slice keeps
     * finding defects, so it is written out rather than left to Prisma — and
     * an `OR: []` matches every row, which here would read every rule in the
     * tenant.
     */
    const ruleFilters = [
      ...(ruleIds.length === 0 ? [] : [{ id: { in: ruleIds } }]),
      ...(heldEntitlementIds.length === 0
        ? []
        : [
            {
              enabled: true,
              targetSystemId: { in: targetIds },
              entitlements: { some: { entitlementId: { in: heldEntitlementIds } } },
            },
          ]),
    ];
    const rules =
      ruleFilters.length === 0
        ? []
        : await tx.businessRule.findMany({
            where: { OR: ruleFilters },
            include: { entitlements: { select: { entitlementId: true } } },
            // Total and stable: `currentRules` is a list on a screen and two
            // reads of the same data must order it the same way. `name` is not
            // unique, so the id breaks the tie.
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
          });
    /** Which entitlements each rule names TODAY. */
    const namedByRule = new Map(
      rules.map((r) => [r.id, new Set(r.entitlements.map((j) => j.entitlementId))]),
    );

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

    /**
     * Which contract satisfies each rule, resolved once per rule rather than
     * once per holding: the first active one whose facts the rule's condition
     * accepts. `null` means no active contract satisfies it — or that the
     * condition could not be parsed, which is withheld rather than guessed.
     */
    const contractByRule = new Map(
      rules.map((rule) => {
        const condition = conditionById.get(rule.id) ?? null;
        const contract =
          condition === null
            ? null
            : (active.find((c) =>
                evaluateCondition(condition, contractFacts(c, person?.status ?? 'active')),
              ) ?? null);
        return [rule.id, contract];
      }),
    );
    /**
     * Every live grant this person holds, read ONCE.
     *
     * The plan's Step 9 wrote this as a `findFirst` inside the per-holding
     * map, which is one round trip per holding inside `withTenant`'s 5000 ms
     * budget -- the exact shape Global Constraint 2 forbids, and the map is
     * synchronous besides. Keyed on `entitlementId` because that is what the
     * holding has; `requestId` is carried on the holding itself and is what
     * ties the two together.
     */
    const grantRows = await tx.accessGrant.findMany({
      where: { subjectPersonId: personId, resourceType: 'entitlement' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, resourceId: true, requestId: true, endsAt: true },
    });
    const grantByEntitlementAndRequest = new Map<string, { id: string; endsAt: Date | null }>();
    for (const row of grantRows) {
      // `orderBy createdAt desc` and first-wins: the newest grant for this
      // (entitlement, request) pair is the one in force.
      const key = `${row.resourceId}:${row.requestId ?? ''}`;
      if (!grantByEntitlementAndRequest.has(key)) {
        grantByEntitlementAndRequest.set(key, { id: row.id, endsAt: row.endsAt });
      }
    }

    const attribution = (rule: { id: string; name: string }) => {
      const contract = contractByRule.get(rule.id) ?? null;
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        contractId: contract?.id ?? null,
        contractDescription: contract === null ? null : describeContract(contract),
      };
    };

    return {
      personId,
      accounts: accounts.map((account) => ({
        targetSystemId: account.target.id,
        targetName: account.target.name,
        correlationKey: account.correlationKey,
        status: account.status,
        anchor: account.anchor,
        entitlements: account.entitlements.map((holding) => {
          const stamped =
            holding.grantedByRuleId === null
              ? null
              : (ruleById.get(holding.grantedByRuleId) ?? null);
          // The stamp still accounts for this holding only if the rule it
          // names exists, is enabled, and STILL NAMES this entitlement. A
          // disabled rule grants nothing (`desiredState` skips it), and a rule
          // edited to drop the entitlement stopped asking for it on the day of
          // the edit — neither is an answer to "why does this person have this
          // now".
          const stampLives =
            stamped !== null &&
            stamped.enabled &&
            (namedByRule.get(stamped.id)?.has(holding.entitlementId) ?? false);
          // Every rule that currently asks for this entitlement FOR THIS
          // PERSON: names it, is enabled, belongs to this account's target,
          // and matches an active contract.
          const asking = rules.filter(
            (rule) =>
              rule.enabled &&
              rule.targetSystemId === account.targetSystemId &&
              (namedByRule.get(rule.id)?.has(holding.entitlementId) ?? false) &&
              (contractByRule.get(rule.id) ?? null) !== null,
          );
          /**
           * The answer presented as the reason.
           *
           * The stamp when it still holds; otherwise — and only for a holding
           * that claims a rule put it there — the first rule that currently
           * does ask for it, so that "granted by a rule, no rule" is answered
           * with the rule that is actually holding the access in place. A
           * `manual` or `discovered` holding gets no rule here however many
           * rules would also ask for it: its origin says a rule is not why it
           * is there, and `currentRules` carries the rest.
           */
          const shown = stampLives
            ? stamped
            : holding.origin === 'rule'
              ? (asking[0] ?? null)
              : null;
          const contract = shown === null ? null : (contractByRule.get(shown.id) ?? null);
          return {
            entitlementId: holding.entitlement.id,
            displayName: holding.entitlement.displayName,
            origin: holding.origin,
            ruleId: shown?.id ?? null,
            ruleName: shown?.name ?? null,
            contractId: contract?.id ?? null,
            contractDescription: contract === null ? null : describeContract(contract),
            grantedByRuleId: holding.grantedByRuleId,
            grantedByRuleName: stamped?.name ?? null,
            grantId:
              holding.grantedByRequestId === null
                ? null
                : (grantByEntitlementAndRequest.get(
                    `${holding.entitlementId}:${holding.grantedByRequestId}`,
                  )?.id ?? null),
            requestId: holding.grantedByRequestId,
            grantEndsAt:
              holding.grantedByRequestId === null
                ? null
                : (grantByEntitlementAndRequest.get(
                    `${holding.entitlementId}:${holding.grantedByRequestId}`,
                  )?.endsAt ?? null),
            attributionStale: holding.origin === 'rule' && !stampLives,
            currentRules: asking.map(attribution),
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
 *
 * **`wouldRevoke` counts what `plan.ts` and `reconcile.ts` will actually do**,
 * which is three conditions and not one:
 *
 * 1. the holding must be REVOCABLE — `reconcile` builds `heldWithinRemit` from
 *    `origin === 'rule'` holdings, plus unmanaged in-remit ones under
 *    `authoritative` only, so a group a directory administrator added by hand
 *    is never revoked under `additive` and must not be counted there;
 * 2. no OTHER enabled rule may still desire it for that person —
 *    `planActions` skips anything still in `state.entitlements`, so `R1`
 *    narrowed to nobody while `R2` still grants `E1` to Sales revokes the
 *    Finance holdings and nothing else;
 * 3. this rule must not still desire it — including the case where this edit
 *    switches the rule off, which desires nothing at all.
 *
 * Counting on the entitlement id alone reported "revokes 340" for an edit that
 * revokes twelve, and counted holdings the mode forbids touching. The
 * fix beside it — reading `mine` by `grantedByRuleId` so that emptying the
 * entitlement list reports revoking everything rather than nothing — is still
 * here and still necessary; this is the populated case next to it.
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
     * The target's enforcement mode, and every OTHER enabled rule on it.
     *
     * Both are inputs to what the planner will actually do, and neither was
     * read before. Bounded: one row, and one row per business rule an
     * administrator wrote for this target — never a person or a holding.
     */
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
      select: { enforcementMode: true },
    });
    const otherRuleRows = await tx.businessRule.findMany({
      where: {
        targetSystemId,
        enabled: true,
        ...(ruleId === undefined ? {} : { id: { not: ruleId } }),
      },
      include: { entitlements: { select: { entitlementId: true } } },
    });
    /**
     * The other rules' conditions, PARSED.
     *
     * A condition this version cannot read means this rule's population cannot
     * be computed, so it is treated as desiring nothing — which makes the
     * preview count MORE revocations, not fewer. That is the safe direction
     * for a screen whose job is to warn: a preview that under-reports says an
     * edit takes nothing away while it takes access away. The run itself
     * refuses outright on the same input (`run-service.ts`), so nothing is
     * silently planned off this reading.
     */
    const otherRules = otherRuleRows.map((r) => {
      const parsed = conditionSchema.safeParse(r.condition);
      return {
        condition: parsed.success ? parsed.data : null,
        entitlementIds: r.entitlements.map((j) => j.entitlementId),
      };
    });

    /**
     * The entitlements the rule names in the DATABASE today, which is not the
     * same set as the ones it is being edited to name.
     *
     * `mine` below finds a holding by its `grantedByRuleId` stamp, and that
     * stamp is `attributedRuleIds[0]` — so a holding this rule genuinely
     * granted can carry a DIFFERENT rule's id, and that rule may since have
     * been deleted. Preview an edit dropping such an entitlement and neither
     * read covered it: it is off the new list, and the dangling stamp is not
     * this rule's id. The preview said the edit takes nothing away, while the
     * holding is `origin: 'rule'`, therefore inside `heldWithinRemit`,
     * therefore revoked by the very next run.
     */
    const storedEntitlementIds =
      ruleId === undefined
        ? []
        : (await tx.ruleEntitlement.findMany({ where: { ruleId } })).map(
            (j) => j.entitlementId,
          );

    /**
     * Two reads, because the empty case here is not the harmless one.
     *
     * `named` is every live holding of the entitlements this edit is ABOUT —
     * the ones the rule would grant, plus the ones it names today and may be
     * dropping; `mine` is every live holding this rule HAS granted. A rule
     * edited to name fewer entitlements — or none at all — revokes the ones it
     * dropped, and computing revocations only from the named set reports that
     * as "revokes 0" precisely when it revokes everything. That is the
     * empty-set-is-the-universal-set defect this slice has now found five
     * times, and emptying an entitlement list is the one-click way to hit it.
     */
    const affectedEntitlementIds = [
      ...new Set([...entitlementIds, ...storedEntitlementIds]),
    ];
    const named =
      affectedEntitlementIds.length === 0
        ? []
        : await tx.accountEntitlement.findMany({
            where: {
              state: 'held',
              entitlementId: { in: affectedEntitlementIds },
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

    const wanted = new Set(entitlementIds);
    // A disabled rule desires nothing: `desiredState` skips it and its
    // entitlements leave the remit (Ruling P27). Previewing the edit that
    // switches a rule off has to say so, in both directions.
    const grants = rule.enabled ? wanted : new Set<string>();

    /**
     * What each person would still be DESIRED to hold after this edit, by any
     * enabled rule on this target — this one included.
     *
     * `planActions` revokes `heldWithinRemit` minus `state.entitlements`, and
     * `state.entitlements` is the union over every enabled rule, so an
     * entitlement another rule still asks for is not revoked however this one
     * is narrowed. Without this the preview counted a holding as a revocation
     * on the strength of its entitlement id alone: `R1` granting `E1` to
     * Finance and `R2` granting `E1` to Sales, narrowing `R1` to match nobody
     * reported "revokes 340" for an edit that revokes twelve.
     */
    const matched: { personId: string; displayName: string }[] = [];
    const desiredByPerson = new Map<string, Set<string>>();
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
      const activeContracts = activeOn(contracts, now);
      const hit = activeContracts.some((c) =>
        evaluateCondition(condition, contractFacts(c, person.status)),
      );
      if (hit) {
        matched.push({
          personId: person.id,
          // Derived: `Person` has no displayName column.
          displayName: personDisplayName(person),
        });
      }
      const desired = new Set<string>(hit ? grants : []);
      for (const other of otherRules) {
        if (other.condition === null) continue;
        const matches = activeContracts.some((c) =>
          evaluateCondition(other.condition!, contractFacts(c, person.status)),
        );
        if (!matches) continue;
        for (const entitlementId of other.entitlementIds) desired.add(entitlementId);
      }
      desiredByPerson.set(person.id, desired);
    }

    const matchedIds = new Set(matched.map((m) => m.personId));

    /**
     * The remit as it would stand after this edit: every entitlement named by
     * an enabled rule on this target. `reconcile` puts an UNMANAGED holding
     * into `heldWithinRemit` only under `authoritative` and only inside the
     * remit; under `additive` it is deliberately kept out and never revoked.
     */
    const remit = new Set<string>(grants);
    for (const other of otherRules) {
      for (const entitlementId of other.entitlementIds) remit.add(entitlementId);
    }
    const authoritative = target.enforcementMode === 'authoritative';
    /**
     * Whether the planner is allowed to take this holding away at all.
     *
     * `reconcile` builds `heldWithinRemit` — the set `planActions` differences
     * against — from holdings whose `origin` is `'rule'` (Provision granted
     * it, so it keeps converging even if the rule that asked has been deleted)
     * plus, under `authoritative` ONLY, unmanaged in-remit ones. A holding a
     * directory administrator added by hand is never revoked under `additive`,
     * and this preview used to count it anyway.
     */
    const revocable = (holding: { origin: string; entitlementId: string }) =>
      holding.origin === 'rule' ||
      (authoritative && remit.has(holding.entitlementId));

    // Deduplicated by holding id: a holding this rule granted, of an
    // entitlement it still names, held by somebody it no longer matches, is
    // one revocation and appears in both reads.
    const revoked = new Set<string>();
    for (const holding of [...named, ...mine]) {
      if (!revocable(holding)) continue;
      if (desiredByPerson.get(holding.account.personId)?.has(holding.entitlementId)) {
        continue;
      }
      revoked.add(holding.id);
    }

    // Only holdings of the entitlements this rule WOULD grant, held by
    // somebody it matches. `named` also covers the entitlements the rule is
    // dropping, and counting those as already held would depress the grant
    // count by the size of the edit.
    const alreadyHeld = named.filter(
      (h) => matchedIds.has(h.account.personId) && wanted.has(h.entitlementId),
    ).length;

    return {
      matchedPersons: matched.length,
      totalPersons: persons.length,
      // Clamped. `alreadyHeld` counts rows and the product counts pairs, and
      // nothing in the schema forbids two live holdings of one entitlement on
      // one account — a negative "would grant" on a review screen is worse
      // than a conservative zero.
      wouldGrant: Math.max(0, matched.length * grants.size - alreadyHeld),
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
