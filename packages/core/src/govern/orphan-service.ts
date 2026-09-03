import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { foldIdentifier } from './collect.js';
import { type FindingDraft } from './finding-service.js';
import { reconcileLinkedFindings } from './drift-link.js';
import { readableSnapshot } from './readable.js';

export type AttributionMethod =
  | 'name_similarity'
  | 'mail_address'
  | 'employee_identifier'
  | 'adjacent_manager';

export interface OrphanAccount {
  systemId: string;
  systemName: string;
  accountRef: string;
  displayName: string | null;
  mail: string | null;
  employeeId: string | null;
  managerAccountRef: string | null;
}

export interface CandidatePerson {
  personId: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  personalEmail: string | null;
  externalId: string | null;
  managerPersonId: string | null;
}

export interface Proposal {
  personId: string;
  method: AttributionMethod;
  /** 0..1. A number a human reads, never a number a machine acts on. */
  confidence: number;
  because: string;
}

/** Below this, a proposal is a guess and a guess is worse than an empty list. */
const SIMILARITY_FLOOR = 0.55;

function trigrams(value: string): Set<string> {
  const padded = `  ${value.trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Jaccard over character trigrams, on NFKD-folded input.
 *
 * An EMPTY string scores 0 against everything. The empty pattern is the
 * universal pattern unless something says otherwise, and a blank display name
 * matching the whole organization at confidence 1 is Ruling P20's defect
 * wearing an orphan's clothes.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = foldIdentifier(a).trim();
  const right = foldIdentifier(b).trim();
  if (left.length === 0 || right.length === 0) return 0;

  const A = trigrams(left);
  const B = trigrams(right);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  const union = A.size + B.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function proposeOwners(
  account: OrphanAccount,
  candidates: readonly CandidatePerson[],
  accountOwnerByRef: ReadonlyMap<string, string>,
): Proposal[] {
  const proposals: Proposal[] = [];
  const accountMail = account.mail === null ? null : foldIdentifier(account.mail);
  const accountEmployeeId = account.employeeId === null ? null : foldIdentifier(account.employeeId);

  for (const person of candidates) {
    if (accountMail !== null) {
      const addresses = [person.businessEmail, person.personalEmail]
        .filter((x): x is string => x !== null)
        .map(foldIdentifier);
      if (addresses.includes(accountMail)) {
        proposals.push({
          personId: person.personId,
          method: 'mail_address',
          confidence: 0.95,
          because: `the account's mail address ${account.mail!} is this person's recorded address`,
        });
        continue;
      }
    }

    if (accountEmployeeId !== null && person.externalId !== null) {
      if (foldIdentifier(person.externalId) === accountEmployeeId) {
        proposals.push({
          personId: person.personId,
          method: 'employee_identifier',
          confidence: 0.9,
          because: `the account's employee identifier ${account.employeeId!} matches this person's externalId`,
        });
        continue;
      }
    }

    if (account.displayName !== null) {
      const score = trigramSimilarity(
        account.displayName,
        `${person.givenName} ${person.familyName}`,
      );
      if (score >= SIMILARITY_FLOOR) {
        proposals.push({
          personId: person.personId,
          method: 'name_similarity',
          confidence: Math.min(score, 0.85),
          because: `the account name "${account.displayName}" is similar to "${person.givenName} ${person.familyName}"`,
        });
        continue;
      }
    }

    // The adjacent-manager signal: the account next to this one in the
    // directory reports to somebody, and this person reports to that somebody
    // too. Weak on its own, which is why its confidence says so.
    if (account.managerAccountRef !== null && person.managerPersonId !== null) {
      const managerPersonId = accountOwnerByRef.get(account.managerAccountRef);
      if (managerPersonId !== undefined && managerPersonId === person.managerPersonId) {
        proposals.push({
          personId: person.personId,
          method: 'adjacent_manager',
          confidence: 0.4,
          because: `this account's manager and this person's manager are the same person`,
        });
      }
    }
  }

  return proposals.sort((a, b) => b.confidence - a.confidence);
}
/**
 * Rebuilds the proposal set from the current snapshot's orphan accounts.
 *
 * NEVER AUTOMATIC, AT ANY CONFIDENCE. Linking an account to a person is not a
 * labelling exercise: Provision's next run evaluates that person's desired
 * state against that account, and a wrong link is a leaver's account attached
 * to a current employee, or a current employee's account attached to somebody
 * who left and about to be disabled by the ladder. A proposal is cheap and a
 * wrong link is somebody's access.
 */
export async function refreshOrphanProposals(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ orphans: number; proposals: number }> {
  const now = options.now ?? new Date();

  const loaded = await withTenant(tenantId, async (tx) => {
    await readableSnapshot(tx, snapshotId);
    const orphanHoldings = await tx.holding.findMany({
      where: { snapshotId, personId: null, resourceKind: 'targetAccount' },
      select: { systemId: true, accountRef: true, resourceName: true },
    });
    const persons = await tx.person.findMany({
      select: {
        id: true, givenName: true, familyName: true,
        businessEmail: true, personalEmail: true, externalId: true,
      },
    });
    const contracts = await tx.contract.findMany({
      select: { personId: true, managerPersonId: true },
    });
    const linked = await tx.targetAccount.findMany({
      select: { anchor: true, personId: true },
    });
    const denied = await tx.accountAttribution.findMany({
      where: { status: 'denied' },
      select: { systemId: true, accountRef: true, proposedPersonId: true },
    });
    const confirmed = await tx.accountAttribution.findMany({
      where: { status: 'confirmed' },
      select: { systemId: true, accountRef: true },
    });
    return { orphanHoldings, persons, contracts, linked, denied, confirmed };
  });

  const managerByPerson = new Map(
    loaded.contracts
      .filter((c) => c.managerPersonId !== null)
      .map((c) => [c.personId, c.managerPersonId!]),
  );
  const candidates: CandidatePerson[] = loaded.persons.map((p) => ({
    personId: p.id,
    givenName: p.givenName,
    familyName: p.familyName,
    businessEmail: p.businessEmail,
    personalEmail: p.personalEmail,
    externalId: p.externalId,
    managerPersonId: managerByPerson.get(p.id) ?? null,
  }));
  const accountOwnerByRef = new Map(
    loaded.linked
      .filter((a) => a.anchor !== null)
      .map((a) => [a.anchor!, a.personId] as const),
  );
  const deniedKeys = new Set(
    loaded.denied.map((d) => `${d.systemId}|${d.accountRef}|${d.proposedPersonId}`),
  );
  const resolvedAccounts = new Set(loaded.confirmed.map((c) => `${c.systemId}|${c.accountRef}`));

  let proposalCount = 0;
  const findings: FindingDraft[] = [];

  for (const holding of loaded.orphanHoldings) {
    if (holding.accountRef === null) continue;
    if (resolvedAccounts.has(`${holding.systemId}|${holding.accountRef}`)) continue;

    // `resourceName` is `<correlationKey> (<status>)` from the collector, so
    // the display name is everything before the parenthesis.
    const displayName = holding.resourceName.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
    const mail = displayName !== null && displayName.includes('@') ? displayName : null;

    const proposals = proposeOwners(
      {
        systemId: holding.systemId,
        systemName: holding.systemId,
        accountRef: holding.accountRef,
        displayName,
        mail,
        employeeId: null,
        managerAccountRef: null,
      },
      candidates,
      accountOwnerByRef,
    ).filter((p) => !deniedKeys.has(`${holding.systemId}|${holding.accountRef}|${p.personId}`));

    await withTenant(tenantId, async (tx) => {
      for (const proposal of proposals) {
        await tx.accountAttribution.upsert({
          where: {
            tenantId_systemId_accountRef_proposedPersonId: {
              tenantId,
              systemId: holding.systemId,
              accountRef: holding.accountRef!,
              proposedPersonId: proposal.personId,
            },
          },
          create: {
            tenantId,
            systemId: holding.systemId,
            accountRef: holding.accountRef!,
            proposedPersonId: proposal.personId,
            method: proposal.method,
            confidence: proposal.confidence,
          },
          update: { method: proposal.method, confidence: proposal.confidence },
        });
        proposalCount += 1;
      }
    });

    findings.push({
      kind: 'orphan_account',
      severity: 'medium',
      subjectRefType: 'account',
      subjectRefId: `${holding.systemId}:${holding.accountRef}`,
      detail: {
        systemId: holding.systemId,
        accountRef: holding.accountRef,
        displayName,
        proposalCount: proposals.length,
        note:
          proposals.length === 0
            ? 'no candidate owner could be proposed; this account is outside every person-scoped review and every SoD check'
            : 'a candidate owner has been proposed; a human must confirm or deny it',
      },
    });
  }

  // `orphan_account` and NOTHING else: this function is authoritative for that
  // one kind, and the reconciliation is narrowed to it. Through `drift-link`,
  // so the draft carries Provision's DriftFinding id rather than becoming a
  // second row for the same account. Called unconditionally — an empty
  // `findings` is the case where every orphan was claimed since the last run,
  // and that is exactly when the previous findings must be closed.
  await reconcileLinkedFindings(tenantId, snapshotId, ['orphan_account'], findings, { now });

  return { orphans: loaded.orphanHoldings.length, proposals: proposalCount };
}

export async function denyProposal(
  tenantId: string,
  actorUserId: string,
  proposalId: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length === 0) throw new Error('denying a proposal requires a reason');
  await withTenant(tenantId, async (tx) => {
    await tx.accountAttribution.update({
      where: { id: proposalId },
      data: { status: 'denied', decidedByUserId: actorUserId, decidedAt: new Date(), decidedReason: reason },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.orphan.deny',
      targetType: 'AccountAttribution',
      targetId: proposalId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason },
    });
  });
}

/**
 * Confirmation calls PROVISION'S account-linking entry point — the same one an
 * administrator uses to resolve a `conflict` — and Govern never writes
 * `TargetAccount`.
 *
 * The linking function is a PARAMETER rather than an import. That keeps the
 * no-access-bearing-write assertion in `boundaries.test.ts` true of this
 * module, and makes the seam visible rather than implied.
 *
 * The link runs BEFORE the confirmation is recorded. Provision's path can
 * legitimately refuse — a conflict, a person who already holds an account on
 * that target — and a confirmation recorded against a link that did not happen
 * is a screen claiming an orphan is resolved when it is not.
 */
export async function confirmProposal(
  tenantId: string,
  actorUserId: string,
  proposalId: string,
  link: (
    tenantId: string,
    actorUserId: string,
    systemId: string,
    accountRef: string,
    personId: string,
  ) => Promise<void>,
): Promise<void> {
  const proposal = await withTenant(tenantId, async (tx) => {
    const row = await tx.accountAttribution.findUniqueOrThrow({ where: { id: proposalId } });
    const already = await tx.accountAttribution.findFirst({
      where: { systemId: row.systemId, accountRef: row.accountRef, status: 'confirmed' },
      select: { id: true },
    });
    if (already !== null) {
      throw new Error('this account already has a confirmed owner');
    }
    return row;
  });

  await link(tenantId, actorUserId, proposal.systemId, proposal.accountRef, proposal.proposedPersonId);

  await withTenant(tenantId, async (tx) => {
    await tx.accountAttribution.update({
      where: { id: proposalId },
      data: { status: 'confirmed', decidedByUserId: actorUserId, decidedAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.orphan.confirm',
      targetType: 'AccountAttribution',
      targetId: proposalId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        systemId: proposal.systemId,
        accountRef: proposal.accountRef,
        personId: proposal.proposedPersonId,
        method: proposal.method,
        confidence: proposal.confidence,
      },
    });
  });
}
