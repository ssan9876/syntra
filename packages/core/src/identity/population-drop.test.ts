import { describe, expect, it } from 'vitest';
import { populationDropRefusal } from './population-drop.js';

const check = (
  current: number,
  previous: number | null,
  thresholdPercent = 20,
  subject = 'sweep',
) => populationDropRefusal({ current, previous, thresholdPercent, subject });

describe('populationDropRefusal', () => {
  it('says nothing when the population is steady', () => {
    expect(check(100, 100)).toBeNull();
  });

  it('says nothing when the population grew', () => {
    expect(check(120, 100)).toBeNull();
  });

  it('says nothing for a fall within the threshold', () => {
    expect(check(85, 100)).toBeNull();
  });

  it('refuses a fall past the threshold, naming both counts', () => {
    // Named, not summarised. The whole value of this refusal is that somebody
    // reads two numbers and recognises the shape of a truncated HR export.
    const reason = check(50, 100);
    expect(reason).toContain('100');
    expect(reason).toContain('50');
    expect(reason).toContain('50.0%');
  });

  it('refuses a population that has gone entirely', () => {
    // Checked before the percentage, because it is upstream of everything the
    // run or sweep would then do — and because there is nothing a human could
    // usefully confirm about it.
    expect(check(0, 100)).toContain('no person');
    expect(check(0, null)).toContain('no person');
  });

  it('says nothing on a first run, when there is nothing to compare against', () => {
    expect(check(100, null)).toBeNull();
  });

  it('does not divide by a previous count of zero', () => {
    // The two copies of this rule disagreed here: one guarded `previous > 0`
    // and the other did not, so the second computed `(0 - n) / 0` and leaned
    // on -Infinity failing the comparison. A safety rule that is correct by
    // accident is one flipped comparison away from not being.
    expect(check(50, 0)).toBeNull();
  });

  it('names the subject it is refusing', () => {
    // "this sweep" and "this run" are different sentences to the person
    // reading them, and the shared rule must not flatten them into one.
    expect(check(50, 100, 20, 'run')).toContain('run');
    expect(check(50, 100, 20, 'sweep')).toContain('sweep');
  });

  it('treats the threshold as a limit to exceed, not to reach', () => {
    // Exactly at the limit is within it. The two copies agreed on this and it
    // is worth pinning: an off-by-one here refuses every routine month-end.
    expect(check(80, 100, 20)).toBeNull();
    expect(check(79, 100, 20)).not.toBeNull();
  });
});
