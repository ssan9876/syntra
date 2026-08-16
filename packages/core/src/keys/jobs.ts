import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { retireExpiredKeys, rotateKey, type KeyKind } from './signing-key-service.js';

export const KEY_ROTATION_JOB = 'keys.rotate';

export interface KeyRotationPayload {
  tenantId: string;
  kind: KeyKind;
}

/**
 * Monthly, at 03:00 on the first. The default overlap is seven days, so an
 * outgoing key is published for a week after each rotation and every token
 * issued under it verifies for its whole life.
 */
export const KEY_ROTATION_CRON = '0 3 1 * *';

/**
 * The schedule key for one tenant's rotation of one kind of key.
 *
 * pg-boss keys its schedule table on `(queue name, key)` and `key` defaults to
 * the empty string, so several schedules on one queue without one are the same
 * row: the second silently replaces the first. Every directory source once
 * shared `key: ''` and only the last one scheduled ever ran, which is the
 * lesson this repeats rather than relearns. The tenant AND the kind are both
 * in the key -- the kind because SAML rotation is deliberately not scheduled
 * today and adding it later must not collide with this one.
 */
export function keyRotationScheduleKey(tenantId: string, kind: KeyKind): string {
  return `${tenantId}/${kind}`;
}

/**
 * Rolls one tenant's signing key over and tidies up what the last rollover
 * left.
 *
 * `rotateKey` announces the change (`key-change.ts`), which is what evicts the
 * cached OIDC `Provider`; without that the process would keep signing with the
 * old private key until it restarted, and `retireExpiredKeys` below would turn
 * that into a total outage the moment the old key stopped being published.
 */
export async function runKeyRotationJob(
  provider: MasterKeyProvider,
  payload: KeyRotationPayload,
): Promise<void> {
  await rotateKey(payload.tenantId, provider, payload.kind);
  // Whatever the *previous* rotation left outgoing, now that its overlap has
  // run out. Retiring is bookkeeping rather than a control -- `publishedKeys`
  // already filters an outgoing key on `notAfter` and `readSigningKeyPem`
  // refuses a retired one -- but a table nobody ever tidies is a table nobody
  // can read.
  await retireExpiredKeys(payload.tenantId, payload.kind);
}

export function registerKeyRotationJob(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
): void {
  scheduler.register<KeyRotationPayload>(KEY_ROTATION_JOB, (payload) =>
    runKeyRotationJob(provider, payload),
  );
}

/**
 * Puts one tenant's OIDC key rotation on the schedule.
 *
 * **OIDC only, deliberately.** A relying party fetches the JWKS and selects by
 * `kid`, so rotating an OIDC key is invisible to it. A SAML service provider
 * typically has the certificate pasted into its configuration -- Syntra's own
 * console asks administrators to paste service-provider certificates the same
 * way -- and `signing-key-service.ts` gives a SAML key a three-year lifetime
 * for exactly that reason. Rotating one on a schedule would silently break
 * every integration that pinned it, one week after each rotation, and an
 * automatic change that breaks working integrations is worse than a manual one
 * that does not happen. SAML key rotation stays an operator's decision, and
 * the README says so.
 */
export async function scheduleKeyRotation(
  scheduler: Scheduler,
  tenantId: string,
): Promise<void> {
  await scheduler.schedule(
    KEY_ROTATION_JOB,
    KEY_ROTATION_CRON,
    { tenantId, kind: 'oidc' } satisfies KeyRotationPayload,
    keyRotationScheduleKey(tenantId, 'oidc'),
  );
}
