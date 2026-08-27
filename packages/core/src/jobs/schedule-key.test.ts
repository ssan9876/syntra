import { describe, expect, it } from 'vitest';
import { automateScheduleKey, type AutomatePurpose } from '../automate/jobs.js';
import { governScheduleKey, GOVERN_PURPOSES } from '../govern/jobs.js';
import { keyRotationScheduleKey } from '../keys/jobs.js';
import { webhookScheduleKey } from '../notify/webhook-jobs.js';
import { provisionScheduleKey } from '../provision/jobs.js';
import { syncScheduleKey } from '../sync/jobs.js';

/**
 * Every schedule key pg-boss will accept.
 *
 * pg-boss validates the key with `assertObjectName`, which permits word
 * characters, periods, hyphens and forward slashes — and NOTHING else. A key
 * containing anything outside that throws, and it throws at
 * `scheduleBackgroundWork` time, where the caller logs the failure and carries
 * on. So the process starts, reports itself healthy, serves every request, and
 * silently has no scheduled work.
 *
 * That is exactly what was happening. Three of the six key builders separated
 * their parts with COLONS and three with slashes, and only the slashed three
 * ever registered anything. On the lab installation the schedule table held
 * `keys.rotate` and two `sync.run` rows and nothing else: Automate's outbox and
 * tick, all seven Govern purposes, and webhook delivery had never once run on
 * a timer. Nobody noticed because every one of them also has a manual path,
 * and the manual path works.
 *
 * Asserted against the real character class rather than against "no colons",
 * so the next separator somebody reaches for is caught by the same test.
 */

/** pg-boss's own rule, copied from `assertObjectName`. */
const PG_BOSS_KEY = /^[\w.\-/]+$/;

const TENANT = '55e42c8d-f871-4d0e-a992-056ef1f733cf';
const AUTOMATE_PURPOSES: AutomatePurpose[] = ['outbox', 'tick', 'sweep', 'digest'];

const keys: [string, string][] = [
  ...AUTOMATE_PURPOSES.map(
    (p): [string, string] => [`automate/${p}`, automateScheduleKey(TENANT, p)],
  ),
  ...GOVERN_PURPOSES.map(
    (p): [string, string] => [`govern/${p}`, governScheduleKey(TENANT, p)],
  ),
  ['keys', keyRotationScheduleKey(TENANT, 'oidc')],
  ['webhook', webhookScheduleKey(TENANT)],
  ['provision', provisionScheduleKey(TENANT, 'a-target-id')],
  ['sync', syncScheduleKey(TENANT, 'a-source-id')],
];

describe('schedule keys', () => {
  it.each(keys)('%s produces a key pg-boss will accept', (_name, key) => {
    expect(key).toMatch(PG_BOSS_KEY);
  });

  it('still distinguishes the purposes that share a queue', () => {
    // The reason these keys have parts at all: pg-boss keys its schedule table
    // on (queue, key) and `key` defaults to ''. Two purposes that collapsed to
    // one key would leave only the last one scheduled — which is the bug that
    // shipped once on the sync queue.
    const governKeys = GOVERN_PURPOSES.map((p) => governScheduleKey(TENANT, p));
    expect(new Set(governKeys).size).toBe(governKeys.length);

    const automateKeys = AUTOMATE_PURPOSES.map((p) => automateScheduleKey(TENANT, p));
    expect(new Set(automateKeys).size).toBe(automateKeys.length);
  });

  it('names the tenant in every key', () => {
    // Two tenants scheduling the same purpose must not overwrite each other,
    // and the schedule table is where somebody debugging a schedule that did
    // not fire will be looking.
    for (const [, key] of keys) expect(key).toContain(TENANT);
  });
});
