import { describe, expect, it } from 'vitest';
import { trackIntents, missingFrom, type ScheduleRef } from './reconcile.js';

/**
 * Verifying that a schedule was actually registered.
 *
 * `scheduleBackgroundWork` called `schedule()` and assumed it worked. It does
 * not always: pg-boss validates the key and the cron, the call happens inside
 * a per-tenant try/catch that logs and carries on, and the process then starts,
 * passes its readiness probe, serves every request and has NO scheduled work.
 *
 * That is not hypothetical. Three of six key builders separated their parts
 * with colons, which pg-boss's `assertObjectName` refuses, so Automate's four
 * jobs, all seven Govern purposes and webhook delivery had never once been
 * registered on the lab installation — for months, silently, while every
 * health check passed.
 *
 * The product already states the principle this restores, on the revocation
 * batch screen: "A dispatch is not an outcome." It applied that scepticism to
 * other people's subsystems and not to its own scheduler.
 *
 * The comparison is pure and lives here so it can be tested without pg-boss;
 * the wrapper supplies the two sides.
 */

const ref = (name: string, key: string): ScheduleRef => ({ name, key });

describe('tracking what was intended', () => {
  it('records a schedule before it is attempted', () => {
    // BEFORE, deliberately. A call that throws is exactly the one worth
    // reporting, so recording after a successful return would blind the
    // reconciliation to every failure it exists to catch.
    const intents = trackIntents();
    intents.scheduled('automate.sweep', 'automate/sweep/t1');
    expect(intents.list()).toEqual([ref('automate.sweep', 'automate/sweep/t1')]);
  });

  it('forgets one that was deliberately removed', () => {
    // `applySourceSchedule` unschedules a source that has been disabled. That
    // is a schedule that SHOULD be absent, and reporting it as missing would
    // train somebody to ignore the report.
    const intents = trackIntents();
    intents.scheduled('sync.run', 't1/s1');
    intents.unscheduled('sync.run', 't1/s1');
    expect(intents.list()).toEqual([]);
  });

  it('keeps schedules on one queue apart by key', () => {
    const intents = trackIntents();
    intents.scheduled('govern.run', 'govern/snapshot/t1');
    intents.scheduled('govern.run', 'govern/verify/t1');
    expect(intents.list()).toHaveLength(2);
  });

  it('records the same intent once, however often it is reconciled', () => {
    // Startup re-runs are reconciliation, not accumulation.
    const intents = trackIntents();
    intents.scheduled('automate.tick', 'automate/tick/t1');
    intents.scheduled('automate.tick', 'automate/tick/t1');
    expect(intents.list()).toHaveLength(1);
  });

  it('treats a missing key as the empty key pg-boss defaults to', () => {
    const intents = trackIntents();
    intents.scheduled('keys.rotate', undefined);
    expect(intents.list()).toEqual([ref('keys.rotate', '')]);
  });
});

describe('what is missing', () => {
  it('names an intent with no schedule row behind it', () => {
    const missing = missingFrom(
      [ref('automate.sweep', 'automate/sweep/t1'), ref('sync.run', 't1/s1')],
      [ref('sync.run', 't1/s1')],
    );
    expect(missing).toEqual([ref('automate.sweep', 'automate/sweep/t1')]);
  });

  it('is empty when everything intended is present', () => {
    const refs = [ref('sync.run', 't1/s1'), ref('keys.rotate', 't1/oidc')];
    expect(missingFrom(refs, refs)).toEqual([]);
  });

  it('ignores rows nobody in this process asked for', () => {
    // Another process, an older release, or a tenant this instance does not
    // serve. Reconciliation asks "is what I asked for there", never "is
    // anything there I did not ask for" — the second question has legitimate
    // answers and would make the report noise.
    expect(missingFrom([ref('sync.run', 't1/s1')], [
      ref('sync.run', 't1/s1'),
      ref('some.other.queue', 'not-ours'),
    ])).toEqual([]);
  });

  it('does not match a key across queues', () => {
    // (queue, key) is the pg-boss identity. A key that happens to repeat on a
    // different queue is a different schedule.
    expect(missingFrom([ref('a.queue', 'k')], [ref('b.queue', 'k')])).toEqual([
      ref('a.queue', 'k'),
    ]);
  });
});
