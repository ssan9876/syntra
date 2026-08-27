import { evaluateCondition, type ConditionFacts } from './condition.js';
import { generateCorrelationKey, SAM_ACCOUNT_NAME_MAX_LENGTH } from './names.js';
import { renderContainer, renderTemplate, type TemplateContext } from './templates.js';
import type {
  Attribution,
  ContractFacts,
  DesiredAccount,
  DesiredState,
  GrantAttribution,
  GrantException,
  GrantFacts,
  PersonFacts,
  ProfileFacts,
  RuleFacts,
} from './types.js';

export interface DesiredStateInput {
  person: PersonFacts;
  contracts: ContractFacts[];
  rules: RuleFacts[];
  /**
   * The subject's grants for THIS target whose window can cover `now`. The
   * caller filters by target and status; this function applies the window and
   * the employment gate and then unions.
   */
  grants: GrantFacts[];
  profile: ProfileFacts;
  /** The target's catalog. A rule naming anything but `present` is unresolvable. */
  entitlementStatus: ReadonlyMap<string, 'present' | 'missing' | 'unreadable'>;
  /**
   * The key this person's account already holds, if any. Regenerated only
   * when `renameEnabled` is on -- somebody marrying does not get a new login
   * by default, because renaming breaks certificate subjects, profile paths,
   * file ownership and mailbox aliases.
   */
  existingCorrelationKey: string | null;
  takenCorrelationKeys: ReadonlySet<string>;
  /**
   * A container somebody pinned this person's account to by hand, or null.
   *
   * When set it REPLACES the rendered template — it does not merge with it and
   * it is not a default. That is the whole point of the row: the planner
   * proposes a `modifyDN` whenever the account is not where the desired
   * container says, so a manual move that left the template in charge would be
   * undone on the next five-minute tick. See `AccountPlacement`.
   *
   * The fallback is not consulted either. An override is a decision somebody
   * made and recorded a reason for; falling back from it would silently
   * discard that decision at exactly the moment it mattered.
   */
  containerOverride: string | null;
  /**
   * The target's `renameEnabled`. Without it here the setting has nothing
   * behind it: the existing key is returned unconditionally, so the planner's
   * `state.account.correlationKey !== current.correlationKey` can never hold
   * and `rename_account` is unreachable.
   */
  renameEnabled: boolean;
  /** Decides whether the account is ENABLED and which entitlements it holds. */
  now: Date;
  /**
   * `now + preHireDays`. Together with `now` it bounds the window over which
   * an account is REQUIRED, and it supplies the attributes.
   */
  horizon: Date;
}

/**
 * Contracts in force at any point between `from` and `to`, both bounds
 * inclusive.
 *
 * This is the window an account requirement is decided over, and it is an
 * interval rather than a single instant on purpose. See {@link desiredState}:
 * asking only at the horizon answers "will they be employed in a fortnight",
 * which is the wrong question for somebody leaving next Tuesday.
 *
 * The bounds are ordered internally, so a caller that passes them the wrong
 * way round gets the same window rather than the empty one — the empty one
 * being the answer that strips somebody's access.
 */
export function activeBetween(
  contracts: ContractFacts[],
  from: Date,
  to: Date,
): ContractFacts[] {
  const start = Math.min(from.getTime(), to.getTime());
  const end = Math.max(from.getTime(), to.getTime());
  return contracts.filter(
    (c) =>
      c.startDate.getTime() <= end &&
      (c.endDate === null || c.endDate.getTime() >= start),
  );
}

/**
 * Contracts in force on `on`. Both boundaries inclusive — a contract is active
 * on its first and last day — matching `activeContracts` in
 * `packages/core/src/identity/contract-service.ts`.
 */
export function activeOn(contracts: ContractFacts[], on: Date): ContractFacts[] {
  return activeBetween(contracts, on, on);
}

/**
 * The day this person stopped being employed, as at `on`, or null if they
 * have not.
 *
 * **Not "the latest end date on any contract".** That is what this used to
 * compute, and it is a different question with the same answer only in the
 * simple case. Take a person holding contract A which ended on 31 January and
 * contract B which runs from 1 June to 31 May the following year, and ask on
 * 1 March. Nothing is open-ended, so the maximum end date is fifteen months in
 * the FUTURE — the ladder reads them as departed and then measures every timer
 * from a date that has not arrived, so the revocation is not due, the disable
 * is not due and the archive is not due. Not one step fires for the whole gap.
 * `planActions` proposes nothing, `reconcile` reports nothing, and they keep
 * an enabled account and every entitlement until June. Both halves silent.
 *
 * The old docstring's escape — "null when any contract is open-ended (they
 * have not left)" — was an assumption about the data, not a fact about it: it
 * holds for fixed-term-to-permanent and fails for fixed-term-to-fixed-term.
 *
 * So the answer is taken over the contracts that HAVE STARTED, and only those:
 *
 * - Any started contract that is open-ended means they have not stopped. Null.
 * - Otherwise, the latest end date among the started ones. A person whose
 *   second contract ran three months longer left three months later, and that
 *   part was always right.
 * - No contract has started: null. That is somebody with no contracts at all,
 *   or a pre-hire, and `desiredState` answers both of those elsewhere.
 *   Inventing a departure date for them would be inventing data.
 *
 * A contract that has not started is deliberately invisible here whether it is
 * fixed-term or open-ended, so the two shapes of the same gap are read the
 * same way. A person whose next engagement begins in September did not stop
 * being employed on a different day because that engagement happens to be
 * permanent.
 *
 * A future end date is still a departure date. Somebody employed today on a
 * fixed-term contract ending next month has stopped-being-employed scheduled,
 * and the ladder anchors to it rather than treating them as a mover and
 * disabling them now — which is what the timers are for.
 */
export function departureDate(
  contracts: ContractFacts[],
  on: Date,
  override?: Date | null,
): Date | null {
  // An administrative departure wins over the contract table unconditionally.
  //
  // Somebody who clicked Deactivate knows something the contracts do not: the
  // resignation nobody has keyed yet, the compromised account, the person
  // walked out this morning. Letting an open-ended contract overrule that
  // would make the button a no-op for precisely the population it is most
  // needed for -- permanent employees, whose `endDate` is null and who
  // therefore read as "not leaving" forever.
  if (override) return override;

  const started = contracts.filter((c) => c.startDate.getTime() <= on.getTime());
  if (started.length === 0) return null;
  if (started.some((c) => c.endDate === null)) return null;
  return started.reduce<Date>(
    (latest, c) => (c.endDate!.getTime() > latest.getTime() ? c.endDate! : latest),
    started[0]!.endDate!,
  );
}

/**
 * The primary contract if it is among the candidates, otherwise the one with
 * the lowest sequence number. Null for an empty list.
 */
function preferPrimary(candidates: ContractFacts[]): ContractFacts | null {
  const ordered = [...candidates].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length === 0) return null;
  return ordered.find((c) => c.isPrimary) ?? ordered[0]!;
}

/**
 * Which contract supplies attribute values: the primary contract if it is
 * currently active, otherwise the active contract with the lowest sequence.
 *
 * This is `resolveContractForMapping`'s precedence, restated over plain values
 * because this module is pure and takes no transaction. Two subsystems
 * disagreeing about somebody's department is a support call nobody can close,
 * so a test in this task asserts the two agree rather than trusting the
 * restatement.
 */
export function resolveMappingContract(
  contracts: ContractFacts[],
  on: Date,
): ContractFacts | null {
  return preferPrimary(activeOn(contracts, on));
}

function conditionFacts(person: PersonFacts, contract: ContractFacts): ConditionFacts {
  return {
    'contract.department': contract.department,
    'contract.jobTitle': contract.jobTitle,
    'contract.costCentre': contract.costCentre,
    'contract.employer': contract.employer,
    'contract.location': contract.location,
    'contract.fte': contract.fte,
    'person.status': person.status,
  };
}

function templateContext(
  person: PersonFacts,
  contract: ContractFacts | null,
  baseDn: string,
): TemplateContext {
  return {
    person: {
      givenName: person.givenName,
      familyName: person.familyName,
      // The two address columns Person actually has. There is no `email`
      // column, so there is no `%person.email%` placeholder; a template naming
      // one is reported as unresolvable rather than rendered empty, which is
      // exactly what renderTemplate does with any unknown name.
      businessEmail: person.businessEmail,
      personalEmail: person.personalEmail,
      nameConvention: person.nameConvention,
      // Derived, not stored. Offered so an attributeTemplate can say
      // `%person.displayName%` without every profile restating the join.
      displayName: personDisplayName(person),
      status: person.status,
    },
    contract: {
      department: contract?.department ?? null,
      jobTitle: contract?.jobTitle ?? null,
      costCentre: contract?.costCentre ?? null,
      employer: contract?.employer ?? null,
      location: contract?.location ?? null,
    },
    baseDn,
  };
}

/**
 * The name to print for a person, derived because `Person` has no
 * `displayName` column and spec section 15 forbids adding one.
 *
 * `nameConvention` is deliberately not branched on: the only name parts the
 * record holds are `givenName` and `familyName`, so there is nothing for a
 * convention to select between until partner-name columns exist. It is passed
 * through to the template context as a fact instead, so a profile that wants
 * to act on it can, and this function does not invent data.
 */
export function personDisplayName(person: PersonFacts): string {
  return [person.givenName, person.familyName]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * The same name, with a last resort for the message paths.
 *
 * The explicit empty check is load-bearing: `Array.join` returns `''` and
 * never null or undefined, so a `?? person.id` written after it is dead code
 * and a person with both names blank produces an exception reading
 * " holds no contracts at all", with nothing in it anybody can look up.
 */
function fullName(person: PersonFacts): string {
  const name = personDisplayName(person);
  return name === '' ? person.id : name;
}

/**
 * A factory, not a shared constant.
 *
 * `{ ...EMPTY_ACCOUNT }` is a shallow copy: every caller would receive the
 * SAME `attributes` object, so one consumer mutating it corrupts every
 * subsequent call in the process.
 */
function emptyAccount(): DesiredAccount {
  return {
    required: false,
    attributes: {},
    container: '',
    enabledNow: false,
    correlationKey: null,
  };
}

/**
 * Whether any enabled account-granting rule matches any of these contracts.
 *
 * Called twice with different contract sets, which is the whole two-date
 * design: over the pre-hire window it decides whether the account must EXIST,
 * and over the contracts active now it decides whether it is ENABLED.
 */
function accountGrantedBy(
  rules: RuleFacts[],
  person: PersonFacts,
  contracts: ContractFacts[],
): boolean {
  for (const rule of rules) {
    if (!rule.enabled || !rule.grantsAccount) continue;
    for (const contract of contracts) {
      if (evaluateCondition(rule.condition, conditionFacts(person, contract))) return true;
    }
  }
  return false;
}

/**
 * What a person should hold in one target, as a pure function of their record
 * as it stands.
 *
 * There are no joiner, mover and leaver *events* here. There is a desired
 * state computed from the record, an actual state read from the target, and a
 * diff. Joiner, mover and leaver are names for shapes that diff takes. That is
 * what makes a retroactive correction a non-event: whatever happened upstream,
 * the next run converges, because there is no memory to corrupt.
 *
 * Two dates, deliberately. Whether an account is required is decided over the
 * WINDOW `[now, horizon]`, and whether it is enabled and what it holds is
 * decided at `now`. A pre-hire therefore gets their account created, named,
 * placed and password-set, and left disabled holding nothing.
 *
 * The window is an interval and not the horizon alone, and that distinction is
 * load-bearing rather than pedantic. `horizon` is `now + preHireDays`, so
 * asking "is a contract active at the horizon" asks whether the person will
 * still be employed in a fortnight. Somebody whose contract ends next Tuesday
 * answers no, and a one-sided horizon therefore reports `required: false` for
 * an employee who is at their desk — which the planner reads as a mover, whose
 * treatment is an immediate disable and an immediate revoke of everything,
 * with no grace and no ladder, five days before they actually leave. Their
 * entitlements are meanwhile still computed at `now`, so the state is
 * self-contradictory as well as wrong. Widening one side to `now` costs a
 * pre-hire nothing and is the only formulation in which `preHireDays` is
 * purely additive, which is what a setting called "pre-hire days" must be.
 *
 * Pure: no clock of its own, no database, no I/O.
 */
export function desiredState(input: DesiredStateInput): DesiredState {
  const { person, contracts, rules, profile, now, horizon } = input;
  const empty: DesiredState = {
    personId: person.id,
    account: null,
    entitlements: new Set<string>(),
    attribution: new Map<string, Attribution[]>(),
    grantAttribution: new Map<string, GrantAttribution[]>(),
    grantExceptions: [],
    notYetStarted: false,
    unprocessable: null,
  };

  // No contracts at all is an incomplete record -- a person created by hand
  // and not finished, or an import that dropped the contract rows. It is not a
  // departure, and computing it as one revokes real access.
  if (contracts.length === 0) {
    return {
      ...empty,
      unprocessable: {
        kind: 'no_contracts',
        message: `${fullName(person)} holds no contracts at all, so their access cannot be computed; this is an incomplete record, not a departure`,
      },
    };
  }

  const activeNow = activeOn(contracts, now);
  // Every contract in force at any point between now and the horizon.
  const activeInWindow = activeBetween(contracts, now, horizon);
  const windowEnd = now.getTime() > horizon.getTime() ? now : horizon;

  /**
   * A rule naming an entitlement that is missing or unreadable is unresolvable
   * — for the persons it would have been evaluated FOR, and for nobody else.
   *
   * This used to return before the conditions were evaluated at all, so ONE
   * entitlement deleted from the target froze `grants` for every person in the
   * tenant: a rule affecting three people in one department stopped every
   * joiner, every mover and every grant everywhere. `unresolvable_rule` is
   * scoped to `grants` precisely because it is a narrow failure, and applying
   * it to the whole population is the same over-reach in a different place —
   * an entitlement Provision cannot resolve for the Finance rule says nothing
   * about somebody in Facilities.
   *
   * Matched over `activeInWindow`, which is the wider of the two contract sets
   * the rules are read against: `accountGrantedBy` uses it and the entitlement
   * loop below uses `activeNow`, a subset. Anybody a rule could reach either
   * way is covered.
   *
   * A condition this module cannot evaluate matches nobody, so it cannot pull
   * a person into this refusal either — which is safe here only because
   * `run-service.ts` parses every stored condition before a run evaluates it
   * and refuses the run outright if one does not parse. A rule whose
   * population cannot be computed never reaches this loop.
   */
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const unresolvable = rule.entitlementIds.find(
      (id) => (input.entitlementStatus.get(id) ?? 'missing') !== 'present',
    );
    if (unresolvable === undefined) continue;
    const reaches = activeInWindow.some((contract) =>
      evaluateCondition(rule.condition, conditionFacts(person, contract)),
    );
    if (!reaches) continue;
    const status = input.entitlementStatus.get(unresolvable) ?? 'missing';
    return {
      ...empty,
      unprocessable: {
        kind: 'unresolvable_rule',
        message: `the rule "${rule.name}" names entitlement ${unresolvable}, which is ${status} in the target catalog; the rule cannot be resolved for this person and produces no desired state`,
      },
    };
  }

  /**
   * Contracts exist and every one of them starts after the window.
   *
   * A third state beside "should have something" and "should have nothing",
   * and it has to be carried out of here because it is not recoverable
   * downstream: none of their contracts has started, so `departureDate` is
   * null, so the planner sees no departure date and treats them as a mover --
   * which means an immediate revoke of everything they hold and an immediate
   * disable, for somebody who has not started (Ruling P10).
   *
   * `contracts` is non-empty here, so this is never vacuously true.
   */
  const notYetStarted = contracts.every(
    (c) => c.startDate.getTime() > windowEnd.getTime(),
  );

  const entitlements = new Set<string>();
  const attribution = new Map<string, Attribution[]>();

  // A grant says what an ACTIVE person may ADDITIONALLY have. It must never
  // be evidence that somebody is still employed.
  //
  // `activeInWindow.length === 0` is the whole of this gate and it is not
  // defensive. It is the SAME contract set the account decision below is taken
  // over, deliberately: a person the account decision treats as gone is a
  // person the grant gate treats as gone. `planActions` gates
  // `disable_account`, `deactivate_syntra_user` and `archive_account` on
  // `!state.account?.required`, and a `permanent` grant has `endsAt: null`, so
  // its window covers `now` forever. Ungated, a departed person holding any
  // live grant is never disabled, never deactivated and never archived -- and
  // the requested entitlement is kept too, because it goes back into
  // `entitlements` and the revoke loop skips anything still desired. A feature
  // added to GRANT access would have silently disabled the mechanism that
  // REMOVES it, and it would have looked like it worked, because the grants
  // apply correctly and nobody watches for an absence.
  //
  // Automate's sweep lapsing these grants on the contract end date is not a
  // substitute: the sweep and the run are independent jobs with no ordering,
  // a sweep that trips either guard axis sits unapplied, and a sweep can sit
  // `blocked` waiting for a human. None of those may keep a leaver's account
  // alive in the meantime.
  const grantsInWindow =
    activeInWindow.length === 0
      ? []
      : input.grants.filter(
          (grant) =>
            grant.startsAt <= input.now &&
            (grant.endsAt === null || input.now < grant.endsAt),
        );

  // A grant naming an entitlement the catalog does not hold is skipped and
  // named, not proposed. Proposing it produces a `grant_entitlement` against
  // a group that is not there, which fails `not_found` every night forever
  // with nothing recording why; making the PERSON unprocessable for it -- the
  // answer the rule pre-check above gives -- would revoke everything else
  // they hold over one request.
  const grantExceptions: GrantException[] = [];
  const grantsInForce = grantsInWindow.filter((grant) => {
    const status = input.entitlementStatus.get(grant.entitlementId) ?? 'missing';
    if (status === 'present') return true;
    grantExceptions.push({
      grantId: grant.grantId,
      entitlementId: grant.entitlementId,
      message: `grant ${grant.grantId} names entitlement ${grant.entitlementId}, which is ${status} in the target catalog; it is left out of desired state rather than planned against a group that is not there`,
    });
    return false;
  });

  // Whether an account is required is decided over the whole pre-hire window,
  // so a pre-hire's account exists before their start date and somebody whose
  // contract ends inside the window keeps theirs until it does.
  const accountRequiredFromRules = accountGrantedBy(rules, person, activeInWindow);

  // A group membership without an account is not a thing a directory can
  // hold. Somebody whose only claim on this target is a request grant still
  // needs an account to hold it, or the grant action is planned against an
  // account nothing created and fails `not_found` every night. The employment
  // gate above is what stops this reading as "still employed", and the union
  // is taken AFTER it so it cannot bypass the gate.
  const accountRequired = accountRequiredFromRules || grantsInForce.length > 0;

  // Which entitlements are held is decided at `now`, so a pre-hire holds
  // nothing until the day they start. This is the security property the two
  // dates exist for.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const contract of activeNow) {
      if (!evaluateCondition(rule.condition, conditionFacts(person, contract))) continue;
      for (const entitlementId of rule.entitlementIds) {
        entitlements.add(entitlementId);
        const list = attribution.get(entitlementId) ?? [];
        list.push({ ruleId: rule.id, ruleName: rule.name, contractId: contract.id });
        attribution.set(entitlementId, list);
      }
    }
  }

  // The union. The entitlement set is what the rules produce PLUS what the
  // grants name, and the two attributions are kept apart so each can end
  // without taking the other with it (spec section 10's matrix).
  const grantAttribution = new Map<string, GrantAttribution[]>();
  for (const grant of grantsInForce) {
    entitlements.add(grant.entitlementId);
    const existing = grantAttribution.get(grant.entitlementId) ?? [];
    existing.push({
      grantId: grant.grantId,
      requestId: grant.requestId,
      endsAt: grant.endsAt,
    });
    grantAttribution.set(grant.entitlementId, existing);
  }

  if (!accountRequired) {
    // No account is required. This covers a leaver (every contract ended), a
    // mover whose target is no longer theirs, and a future joiner. The first
    // two differ by a contract end date and telling them apart is plan.ts's
    // job; the third cannot be recovered downstream at all, which is why
    // `notYetStarted` travels with the state rather than being re-derived.
    return {
      ...empty,
      account: emptyAccount(),
      entitlements,
      attribution,
      // A leaver reaches here with both empty by construction -- the gate
      // emptied `grantsInWindow`. An ACTIVE person with no rule-granted
      // account and one unresolvable grant also reaches here, carrying an
      // exception that must not be dropped.
      grantAttribution,
      grantExceptions,
      notYetStarted,
    };
  }

  const mappingContract =
    resolveMappingContract(contracts, now) ?? preferPrimary(activeInWindow);
  const context = templateContext(person, mappingContract, profile.baseDn);

  const attributes: Record<string, string[]> = {};
  for (const [name, template] of Object.entries(profile.attributeTemplates)) {
    const rendered = renderTemplate(template, context);
    if (!rendered.ok) {
      return {
        ...empty,
        unprocessable: {
          kind: 'template_unresolvable',
          message: `the account profile template for "${name}" references ${rendered.missing.join(', ')}, which resolves to nothing for this person`,
        },
      };
    }
    // A template with no reference in it at all renders `ok: true` with an
    // EMPTY value — nothing was missing, because nothing was asked for — and
    // `['']` is a zero-length attribute value, which Active Directory refuses.
    // The action fails, a failed action leaves `lastAppliedAttributes`
    // untouched, and the next run computes the same difference and proposes
    // the same failing write, for ever. `accountProfileSchema` refuses a blank
    // template at the write boundary; this is the backstop for a profile row
    // written before that check existed or by some other route, and it fails
    // the way the container check below fails — closed and loudly, rather than
    // by writing something the directory will reject on every run.
    if (rendered.value.trim() === '') {
      return {
        ...empty,
        unprocessable: {
          kind: 'template_unresolvable',
          message: `the account profile template for "${name}" renders an empty value, which is not a value the directory accepts; an attribute a profile does not want written is one it does not name`,
        },
      };
    }
    attributes[name] = [rendered.value];
  }

  // A container template that resolves to nothing falls back, which is what
  // the required fallbackContainer is for. A container that does not EXIST in
  // the target is a different failure and is detected in reconcile, against
  // the target's own inventory.
  //
  // `renderContainer`, never `renderTemplate`, because this is a DN: a
  // department of `Finance,OU=Domain Controllers` otherwise renders a VALID
  // distinguished name naming a container the administrator never wrote
  // (Ruling P22). `fallbackContainer` is not rendered at all — it is a literal
  // DN from target configuration with no HR data in it.
  const containerRendered = renderContainer(profile.containerTemplate, context);
  // An override wins outright. Not rendered, because it is a literal DN a
  // human chose from the target's own inventory rather than a template with
  // HR data in it — the same reason `fallbackContainer` is not rendered.
  const container =
    input.containerOverride !== null && input.containerOverride.trim() !== ''
      ? input.containerOverride
      : containerRendered.ok
        ? containerRendered.value
        : profile.fallbackContainer;

  // The write boundary requires a non-empty fallback, so this is a profile
  // that got past it by some other route. Placing an account at an empty DN
  // is a write into somebody else's directory at a location nobody chose, so
  // it fails closed instead: spec section 13, "a template that resolves to
  // nothing and has no fallback".
  if (container.trim() === '') {
    return {
      ...empty,
      unprocessable: {
        kind: 'template_unresolvable',
        message: containerRendered.ok
          ? 'the container template resolves to nothing for this person, and the profile has no fallback container'
          : `the container template references ${containerRendered.missing.join(', ')}, which resolves to nothing for this person, and the profile has no fallback container`,
      },
    };
  }

  // A correlation key, once assigned, is not regenerated -- unless the target
  // says renaming is on. Somebody marrying does not get a new login by
  // default, because renaming breaks certificate subjects, profile paths, file
  // ownership and mailbox aliases.
  let correlationKey = input.existingCorrelationKey;
  if (correlationKey === null || input.renameEnabled) {
    // When a key already exists, it is not "taken" as far as its own owner is
    // concerned: leaving it in the set would make generation invent a
    // suffixed variant of the name this person already holds.
    //
    // Compared case-insensitively, because `takenCorrelationKeys` is Syntra's
    // own rows unioned with the TARGET's inventory, and the target's copy of
    // this person's own account carries the directory's casing. A
    // case-sensitive comparison leaves `Anna.Novak` in the set, generation
    // folds it to `anna.novak`, and the person is proposed a rename to
    // `anna.novak2` away from the account they already have.
    const owned = input.existingCorrelationKey?.trim().toLowerCase();
    const taken =
      owned === undefined
        ? input.takenCorrelationKeys
        : new Set(
            [...input.takenCorrelationKeys].filter(
              (key) => key.trim().toLowerCase() !== owned,
            ),
          );

    const generated = generateCorrelationKey({
      template: profile.correlationKeyTemplate,
      context,
      taken,
      maxLength: SAM_ACCOUNT_NAME_MAX_LENGTH,
      maxAttempts: profile.maxUniquenessAttempts,
    });

    if (!generated.ok) {
      // A person who already has a working login keeps it. A rename is never
      // worth making somebody unprocessable for: their login is not the thing
      // that needs fixing, and freezing them would stop every other action
      // this target would take for them.
      if (input.existingCorrelationKey !== null) {
        correlationKey = input.existingCorrelationKey;
      } else {
        return {
          ...empty,
          unprocessable:
            generated.reason === 'exhausted'
              ? {
                  kind: 'name_generation_exhausted',
                  message: `no unique account name could be generated for ${fullName(person)} within ${generated.attempts} attempts`,
                }
              : {
                  kind: 'template_unresolvable',
                  message: `the account name template references ${generated.missing.join(', ')}, which resolves to nothing for this person`,
                },
        };
      }
    } else {
      correlationKey = generated.correlationKey;
    }
  }

  return {
    personId: person.id,
    account: {
      required: true,
      attributes,
      container,
      // Enabled only if an account-granting rule matches a contract that is
      // active NOW, as opposed to merely somewhere in the pre-hire window.
      // This is what separates a pre-hire's disabled account from a joiner's.
      enabledNow: accountGrantedBy(rules, person, activeNow),
      correlationKey,
    },
    entitlements,
    attribution,
    grantAttribution,
    grantExceptions,
    // An account is required, so by construction a contract is in force
    // somewhere in the window and this person has started or is about to.
    notYetStarted: false,
    unprocessable: null,
  };
}
