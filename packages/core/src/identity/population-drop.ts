/**
 * The refusal that fires when the person register collapses.
 *
 * **One rule, in one place, because it was in two.** `provision/guard.ts` and
 * `automate/sweep-guard.ts` each implemented this independently: the same
 * formula, the same setting, the same argument — and they had already drifted.
 * The provision copy guarded `previous > 0` before dividing; the sweep copy did
 * not, and computed `(0 - n) / 0`, leaning on `-Infinity` failing the
 * comparison to reach the right answer. Nothing was broken by that, and that is
 * the point: a safety rule that is correct by accident is one flipped
 * comparison away from not being.
 *
 * It lives in `identity` rather than in either caller because it is a statement
 * about the PERSON REGISTER, which is upstream of both. Provision acts on
 * people it believes have left; the sweep lapses grants belonging to people it
 * believes have gone. Both are downstream of the same count, and a truncated HR
 * export is the event both exist to survive.
 *
 * Returns the reason, or null. A refusal that carries its own sentence is one
 * the caller cannot paraphrase into something less specific.
 */
export interface PopulationDropInput {
  /** People holding an active contract now. */
  current: number;
  /** The same count when this subsystem last applied. Null on a first run. */
  previous: number | null;
  thresholdPercent: number;
  /**
   * What is being refused, in the reader's words: `run`, `sweep`.
   *
   * A parameter rather than a fixed noun, because "this run found no persons"
   * and "refusing to sweep anything" are different sentences to the person
   * reading them, and a shared rule must not flatten two subsystems into one
   * voice.
   */
  subject: string;
}

export function populationDropRefusal(input: PopulationDropInput): string | null {
  // Checked FIRST and unconditionally. A tenant with nobody in it is upstream
  // of every leaver action either subsystem could take, and there is nothing a
  // human could usefully confirm about a population that has entirely gone.
  if (input.current === 0) {
    return (
      `no person in this tenant holds an active contract at all, which is upstream ` +
      `of every action this ${input.subject} could take`
    );
  }

  // Nothing to compare against. A first run is not evidence of a collapse.
  if (input.previous === null || input.previous <= 0) return null;

  const drop = ((input.previous - input.current) / input.previous) * 100;
  // Strictly greater: exactly at the limit is within it. An off-by-one here
  // refuses every routine month-end.
  if (drop <= input.thresholdPercent) return null;

  return (
    `the number of people holding an active contract has fallen from ` +
    `${input.previous} to ${input.current} (${drop.toFixed(1)}%), above the ` +
    `${input.thresholdPercent}% limit; this is the signature of a broken HR feed, ` +
    `and every action in this ${input.subject} is downstream of that count`
  );
}
