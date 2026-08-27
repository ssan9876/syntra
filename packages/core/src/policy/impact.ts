import type { TenantClient } from '@syntra/db';
import { ruleMatches } from './evaluate.js';
import type { RuleInput } from './policy-service.js';
import type { AuthContext, ContractFacts, PolicyRule } from './types.js';

export interface RuleImpact {
  totalActiveUsers: number;
  matchedUsers: number;
  /**
   * Of the users this rule matches, how many hold nothing that satisfies it
   * and would therefore be asked to enrol a factor on their next sign-in.
   */
  usersNeedingEnrolment: number;
  /** Conditions a preview cannot test, named so nobody assumes it did. */
  unevaluatedConditions: string[];
}

/**
 * Above these, the preview stops loading rows and answers from counts alone.
 *
 * A directory of a hundred thousand people would otherwise pull every user and
 * every membership into the API process to answer a question an administrator
 * asked out of curiosity. The partial answer is still useful and, crucially,
 * still honest: it says which dimensions it could not apply.
 */
export const IMPACT_USER_CAP = 25_000;
export const IMPACT_MEMBERSHIP_CAP = 100_000;

/**
 * How many people a rule would touch, answered before it is saved.
 *
 * Directory Sync learned this the expensive way: a change that silently
 * affected everyone was indistinguishable from one that affected nobody until
 * it had already happened. A rule requiring a second factor is the same shape
 * of mistake, and the same courtesy applies.
 *
 * Two honest limits, both reported rather than hidden. A preview has no request
 * behind it, so source address and time window cannot be tested and are
 * ignored — a rule constrained by either affects at most this many people, not
 * exactly this many. And an application-scoped rule is counted as though the
 * user were entering the first application it names, because that is the case
 * the administrator is reasoning about.
 *
 * Six queries, then everything is decided in memory against the same
 * `ruleMatches` the live decision uses. Per-user queries would be tens of
 * thousands of round trips on a real directory, and a preview that times out
 * teaches nobody anything.
 */
export interface ImpactCaps {
  userCap?: number;
  membershipCap?: number;
}

/**
 * Counts active users matching `scope` (optionally narrowed to a group) who
 * already hold a factor that would cover the rule.
 *
 * Written as a join rather than through `tx.user.count({ where: { totp... } })`
 * because `User` has no declared relation back to `TotpCredential`,
 * `WebAuthnCredential` or `RecoveryCode` — each of those models carries a bare
 * `userId` column with no `@relation` field, so Prisma's nested relation
 * filters (`totpCredential: {...}`, `webAuthnCredentials: { some: {} }`) are
 * not expressible against the schema as it stands. Three plain `EXISTS`
 * subqueries express the same question directly, and rely on the same
 * row-level security every other query in this module already depends on: the
 * transaction has the tenant bound by `withTenant`, and each table's
 * `tenant_isolation` policy scopes every row read here to it, raw SQL
 * included.
 */
async function countAlreadyCovered(
  tx: TenantClient,
  groupIds: string[],
  mode: 'totp' | 'webauthn' | 'any',
): Promise<number> {
  if (mode === 'totp') {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT u.id) AS count
      FROM "User" u
      WHERE u.status = 'active'
        AND (
          cardinality(${groupIds}::uuid[]) = 0
          OR EXISTS (
            SELECT 1 FROM "GroupMembership" gm
            WHERE gm."userId" = u.id AND gm."groupId" = ANY(${groupIds}::uuid[])
          )
        )
        AND EXISTS (
          SELECT 1 FROM "TotpCredential" tc
          WHERE tc."userId" = u.id AND tc."confirmedAt" IS NOT NULL
        )
    `;
    return Number(rows[0]?.count ?? 0n);
  }

  if (mode === 'webauthn') {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT u.id) AS count
      FROM "User" u
      WHERE u.status = 'active'
        AND (
          cardinality(${groupIds}::uuid[]) = 0
          OR EXISTS (
            SELECT 1 FROM "GroupMembership" gm
            WHERE gm."userId" = u.id AND gm."groupId" = ANY(${groupIds}::uuid[])
          )
        )
        AND EXISTS (
          SELECT 1 FROM "WebAuthnCredential" wc WHERE wc."userId" = u.id
        )
    `;
    return Number(rows[0]?.count ?? 0n);
  }

  const rows = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT u.id) AS count
    FROM "User" u
    WHERE u.status = 'active'
      AND (
        cardinality(${groupIds}::uuid[]) = 0
        OR EXISTS (
          SELECT 1 FROM "GroupMembership" gm
          WHERE gm."userId" = u.id AND gm."groupId" = ANY(${groupIds}::uuid[])
        )
      )
      AND (
        EXISTS (
          SELECT 1 FROM "TotpCredential" tc
          WHERE tc."userId" = u.id AND tc."confirmedAt" IS NOT NULL
        )
        OR EXISTS (SELECT 1 FROM "WebAuthnCredential" wc WHERE wc."userId" = u.id)
        OR EXISTS (
          SELECT 1 FROM "RecoveryCode" rc
          WHERE rc."userId" = u.id AND rc."usedAt" IS NULL
        )
      )
  `;
  return Number(rows[0]?.count ?? 0n);
}

export async function previewRuleImpact(
  tx: TenantClient,
  rule: RuleInput,
  now: Date = new Date(),
  caps: ImpactCaps = {},
): Promise<RuleImpact> {
  // A federate rule is a routing rule: it never reaches evaluatePolicy, it
  // matches on nothing this preview can count, and it grants nothing. Answering
  // "0 users affected" would be read as "this rule does nothing", and answering
  // with a match count would be read as "this rule allows these people in".
  // Neither is true, so this refuses rather than inventing a number. The route
  // turns it into a 400 naming the reason.
  if (rule.outcome === 'federate') {
    throw new Error(
      'a federate rule has no authorization impact to preview: it decides which identity provider a login goes to, and authorize() still runs when the user comes back',
    );
  }

  const userCap = caps.userCap ?? IMPACT_USER_CAP;
  const membershipCap = caps.membershipCap ?? IMPACT_MEMBERSHIP_CAP;
  const unevaluatedConditions: string[] = [];
  if ((rule.ipRanges ?? []).length > 0) unevaluatedConditions.push('source address');
  if ((rule.devicePlatforms ?? []).length > 0) unevaluatedConditions.push('device');
  if ((rule.countries ?? []).length > 0) unevaluatedConditions.push('country');
  if (
    (rule.daysOfWeek ?? []).length > 0 ||
    (rule.startMinute ?? null) !== null ||
    (rule.endMinute ?? null) !== null
  ) {
    unevaluatedConditions.push('time window');
  }

  const demandsFactor =
    rule.outcome === 'require_mfa' || rule.outcome === 'require_factor';
  const groupIds = rule.groupIds ?? [];

  // Count before materialising. Two cheap aggregates decide whether the honest
  // answer is the whole one or the partial one.
  const totalActiveUsers = await tx.user.count({ where: { status: 'active' } });
  const membershipCount = await tx.groupMembership.count();

  if (totalActiveUsers > userCap || membershipCount > membershipCap) {
    // Too large to reason about in memory. Answer the dimensions SQL can
    // express — group membership, and which users hold which factor — and name
    // contract conditions alongside the two a preview never evaluates, so the
    // number is understood as an upper bound rather than a count.
    if (rule.contractField && (rule.contractValues ?? []).length > 0) {
      unevaluatedConditions.push('contract attributes');
    }

    const scope =
      groupIds.length > 0
        ? { status: 'active', memberships: { some: { groupId: { in: groupIds } } } }
        : { status: 'active' };

    const matchedUsers = await tx.user.count({ where: scope });

    let usersNeedingEnrolment = 0;
    if (demandsFactor) {
      const mode: 'totp' | 'webauthn' | 'any' =
        rule.outcome === 'require_factor' && rule.factorType === 'totp'
          ? 'totp'
          : rule.outcome === 'require_factor'
            ? 'webauthn'
            : 'any';
      const already = await countAlreadyCovered(tx, groupIds, mode);
      usersNeedingEnrolment = matchedUsers - already;
    }

    return {
      totalActiveUsers,
      matchedUsers,
      usersNeedingEnrolment,
      unevaluatedConditions,
    };
  }

  const users = await tx.user.findMany({
    where: { status: 'active' },
    select: { id: true, personId: true, orgUnitId: true },
  });
  const memberships = await tx.groupMembership.findMany({
    select: { userId: true, groupId: true },
  });
  // Only the field the rule actually names. Selecting all four would carry
  // three columns of employment data across the wire for every person in the
  // tenant to answer a question about one of them.
  const contracts = await tx.contract.findMany({
    where: {
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    select: {
      personId: true,
      department: rule.contractField === 'department',
      jobTitle: rule.contractField === 'jobTitle',
      employer: rule.contractField === 'employer',
      location: rule.contractField === 'location',
    },
  });

  const totp = await tx.totpCredential.findMany({
    where: { confirmedAt: { not: null } },
    select: { userId: true },
  });
  const webauthn = await tx.webAuthnCredential.findMany({ select: { userId: true } });
  const emailOtp = await tx.emailOtpCredential.findMany({
    where: { confirmedAt: { not: null } },
    select: { userId: true },
  });
  const recovery = await tx.recoveryCode.findMany({
    where: { usedAt: null },
    select: { userId: true },
  });

  const groupsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const list = groupsByUser.get(row.userId) ?? [];
    list.push(row.groupId);
    groupsByUser.set(row.userId, list);
  }

  const contractsByPerson = new Map<string, ContractFacts[]>();
  for (const row of contracts) {
    const list = contractsByPerson.get(row.personId) ?? [];
    // Unselected columns come back undefined; the engine expects null.
    list.push({
      department: row.department ?? null,
      jobTitle: row.jobTitle ?? null,
      employer: row.employer ?? null,
      location: row.location ?? null,
    });
    contractsByPerson.set(row.personId, list);
  }

  const withTotp = new Set(totp.map((r) => r.userId));
  const withWebauthn = new Set(webauthn.map((r) => r.userId));
  const withRecovery = new Set(recovery.map((r) => r.userId));
  const withEmailOtp = new Set(emailOtp.map((r) => r.userId));

  // The rule as the engine would see it, minus the two dimensions a preview
  // cannot supply. The id and position are placeholders: ruleMatches reads
  // neither.
  const candidate: PolicyRule = {
    id: 'preview',
    name: rule.name,
    enabled: true,
    position: 0,
    outcome: rule.outcome,
    factorType: rule.factorType ?? null,
    applicationIds: rule.applicationIds ?? [],
    groupIds: rule.groupIds ?? [],
    contractField: rule.contractField ?? null,
    contractValues: rule.contractValues ?? [],
    ipRanges: [],
    // The same class as `ipRanges` and the time window above: a preview has no
    // request, so it has no user agent and no country header. Left empty, they
    // are unconstrained, which is the only honest reading — a preview cannot
    // tell you how many people sign in from a phone.
    devicePlatforms: [],
    countries: [],
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  const applicationId = candidate.applicationIds[0] ?? null;

  const covers = (userId: string): boolean => {
    if (rule.outcome === 'require_factor') {
      const wanted = rule.factorType;
      if (wanted === 'totp') return withTotp.has(userId);
      if (wanted === 'webauthn') return withWebauthn.has(userId);
      // Named explicitly rather than left to the `false` below. A rule naming
      // a factor this preview did not know about would report every user as
      // needing enrolment — the preview would say a rule affects four thousand
      // people when it affects none, which is worse than no preview.
      if (wanted === 'email_otp') return withEmailOtp.has(userId);
      return false;
    }
    // require_mfa: anything counts, including recovery codes.
    return (
      withTotp.has(userId) ||
      withWebauthn.has(userId) ||
      withEmailOtp.has(userId) ||
      withRecovery.has(userId)
    );
  };

  let matchedUsers = 0;
  let usersNeedingEnrolment = 0;

  for (const user of users) {
    const context: AuthContext = {
      userId: user.id,
      applicationId,
      groupIds: groupsByUser.get(user.id) ?? [],
      contracts: user.personId ? (contractsByPerson.get(user.personId) ?? []) : [],
      sourceIp: null,
      devicePlatform: null,
      country: null,
      now,
    };
    if (!ruleMatches(candidate, context)) continue;

    matchedUsers += 1;
    if (demandsFactor && !covers(user.id)) usersNeedingEnrolment += 1;
  }

  return {
    totalActiveUsers,
    matchedUsers,
    usersNeedingEnrolment,
    unevaluatedConditions,
  };
}
