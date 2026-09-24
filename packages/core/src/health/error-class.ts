/**
 * An error message reduced to a CLASS from a closed vocabulary.
 *
 * Operational surfaces that leave the tenant's console -- a support bundle, a
 * metric label, a queue-health finding -- need to say what KIND of failure
 * happened without repeating what the failure said. A connector's message can
 * carry a person's name, a DN, an email address or a URL with credentials in
 * it; the class never can, because it is chosen from this list and nothing
 * else. The message itself stays where it already was: on the run, behind the
 * permissions that guard the run.
 *
 * Ordered: the first matching rule wins, and the specific rules (a write stop,
 * a cancellation) come before the generic transport ones they may mention.
 */
export const ERROR_CLASSES = [
  'write_stop',
  'cancelled',
  'abandoned',
  'guard',
  'queue',
  'timeout',
  'throttled',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation',
  'network',
  'database',
  'crypto',
  'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

const RULES: [ErrorClass, RegExp][] = [
  ['write_stop', /external writes are paused|write stop|writes? (?:are )?(?:blocked|stopped)/i],
  ['cancelled', /\bcancel(?:led|ed)\b/i],
  ['abandoned', /abandon|left running by a process|interrupted mid-apply|did not finish|released by an operator|marked failed by an operator/i],
  ['guard', /\bguard\b|population|would (?:disable|deactivate|remove)|requires? confirmation|refused outright|blocked/i],
  ['queue', /job queue|not queued|scheduler|pg-boss/i],
  ['timeout', /time(?:d)? ?out|ETIMEDOUT|deadline|did not answer within/i],
  ['throttled', /\b429\b|throttl|rate limit|too many requests/i],
  ['unauthorized', /\b401\b|unauthori[sz]ed|invalid credentials|authentication failed|bind failed|invalid_client|expired (?:secret|credential|password)/i],
  ['forbidden', /\b403\b|forbidden|permission|insufficient (?:rights|privileges)|access denied/i],
  ['not_found', /\b404\b|not found|no such|does not exist/i],
  ['conflict', /\b409\b|conflict|already exists|duplicate/i],
  ['validation', /\b(?:400|422)\b|invalid|malformed|validation|unexpected (?:token|value)|mapping/i],
  ['network', /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|socket|network|TLS|certificate|unreachable|fetch failed/i],
  ['database', /prisma|postgres|database|deadlock|serializ|P\d{4}\b/i],
  ['crypto', /decrypt|unseal|master key|unwrap|cipher|kms|transit/i],
];

export function classifyError(message: string | null | undefined): ErrorClass {
  if (!message) return 'unknown';
  for (const [kind, pattern] of RULES) {
    if (pattern.test(message)) return kind;
  }
  return 'unknown';
}
