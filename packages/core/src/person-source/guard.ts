import { populationDropRefusal } from '../identity/population-drop.js';
import type { PersonChangeType, PersonProposedChange } from './diff.js';

export interface PersonGuardInput {
  changes: PersonProposedChange[];
  recordsRead: number;
  /** Active persons this source currently owns. */
  activePersonsFromSource: number;
  /** Active contracts held by persons this source owns. */
  activeContractsFromSource: number;
  thresholdPercent: number;
  /** Tenant-wide, as it would stand after this run applied. */
  personsWithActiveContract: number;
  /** The same count as it stands now. Null on a first run. */
  previousPersonsWithActiveContract: number | null;
}

export type PersonGuardVerdict =
  | { blocked: false }
  /**
   * `requiresConfirmation` separates the two refusals, as `sync/guard.ts`
   * does. A run that read nothing is refused outright -- there is nothing an
   * administrator could usefully confirm about a file that may simply be a
   * failed export. A run over the threshold is refused pending an explicit
   * confirmation, because a real cohort departure -- a closed site, a
   * contractor batch -- has to be processable through the import rather than
   * by hand.
   */
  | { blocked: true; requiresConfirmation: boolean; reason: string };

/**
 * One population the threshold is measured against.
 *
 * Two of them, with two denominators, for the reason `sync/guard.ts` records
 * about groups: ending every contract a source owns is as destructive as
 * departing every person it owns, and a wrong mapping that did the first would
 * sail under a threshold measured against the second.
 */
interface Population {
  changeType: PersonChangeType;
  verb: string;
  noun: string;
  total(input: PersonGuardInput): number;
}

const POPULATIONS: Population[] = [
  {
    changeType: 'depart_person',
    verb: 'depart',
    noun: 'people this source owns',
    total: (i) => i.activePersonsFromSource,
  },
  {
    changeType: 'end_contract',
    verb: 'end',
    noun: 'contracts this source owns',
    total: (i) => i.activeContractsFromSource,
  },
];

/**
 * Decides whether an import is safe to apply.
 *
 * Not advisory: a blocked run will not apply on a schedule whatever
 * `autoApply` says, because an unattended schedule is exactly when nobody is
 * watching.
 *
 * Two guards, and both must pass. The share guard asks whether this run is
 * doing something disproportionate to what this source owns. The drop guard
 * asks whether the person register itself is about to collapse -- a different
 * question with a different denominator, and the one that catches a tenant
 * whose second HR source feeds most of the population.
 */
export function evaluatePersonGuard(input: PersonGuardInput): PersonGuardVerdict {
  // First and unconditional. An empty file and an unreachable server are
  // indistinguishable, and the safe reading is the second -- so there is
  // nothing a human could usefully confirm, and confirmation is not offered.
  if (input.recordsRead === 0) {
    return {
      blocked: true,
      requiresConfirmation: false,
      reason: 'the source returned no records',
    };
  }

  const tripped: string[] = [];

  for (const population of POPULATIONS) {
    const count = input.changes.filter((c) => c.changeType === population.changeType).length;
    if (count === 0) continue;

    // No denominator means nothing to protect yet -- a first run against a
    // register this source owns nothing in.
    const total = population.total(input);
    if (total === 0) continue;

    const share = (count / total) * 100;
    if (share > input.thresholdPercent) {
      tripped.push(
        `would ${population.verb} ${count} of ${total} ${population.noun} ` +
          `(${share.toFixed(1)}%), above the ${input.thresholdPercent}% threshold`,
      );
    }
  }

  // The tenant-wide count, which Provision's leaver path and Automate's expiry
  // sweep are both downstream of. Its sentence is used verbatim: a refusal
  // that carries its own sentence is one the caller cannot paraphrase into
  // something less specific.
  const drop = populationDropRefusal({
    current: input.personsWithActiveContract,
    previous: input.previousPersonsWithActiveContract,
    thresholdPercent: input.thresholdPercent,
    subject: 'import',
  });
  if (drop !== null) tripped.push(drop);

  if (tripped.length === 0) return { blocked: false };

  return { blocked: true, requiresConfirmation: true, reason: tripped.join('; ') };
}
