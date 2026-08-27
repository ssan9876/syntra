import type { ConditionResult } from './ip-match.js';

/**
 * The two conditions that describe WHERE a sign-in is coming from beyond its
 * address: the kind of device, and the country.
 *
 * Both can be `unevaluable`, and that is the whole reason they live beside
 * `ip-match.ts` rather than being plain string comparisons. A country nobody
 * told us and a user agent nobody sent are not "does not match" — they are
 * "cannot say", and `ruleMatches` already knows to fail those towards refusing
 * on a `deny` rule and towards not-matching on the others.
 */

/**
 * The device kinds a rule may name.
 *
 * Deliberately coarse. A policy that could name a browser version would be a
 * policy an administrator has to maintain against a release train they do not
 * control, and the decisions people actually want are "not from a phone" and
 * "company laptops only" — which is a platform, not a build number.
 */
export const DEVICE_PLATFORMS = [
  'windows',
  'macos',
  'linux',
  'ios',
  'android',
  'other',
] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export function isDevicePlatform(value: string): value is DevicePlatform {
  return (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The platform a user agent claims.
 *
 * **Claims, and the word is load-bearing.** A user agent is a string the
 * client chooses, so this is not evidence of anything and a policy resting on
 * it is a speed bump rather than a control. It is offered because "require a
 * second factor from phones" is a reasonable thing to want and the failure
 * mode of getting it wrong is an extra factor prompt, not a bypass —
 * `deny` rules built on it are the ones to think twice about, and the
 * console says so.
 *
 * Order matters: iOS and Android both mention Linux or Mac in their agents, so
 * the mobile tests come first. `null` for an agent that was never sent, which
 * `evaluateDevicePlatforms` turns into `unevaluable` rather than `other`.
 */
export function devicePlatformOf(userAgent: string | null): DevicePlatform | null {
  if (userAgent === null || userAgent.trim() === '') return null;
  const ua = userAgent.toLowerCase();

  // Before the desktop tests: an iPhone's agent says "like Mac OS X" and an
  // Android's says "Linux".
  if (/\biphone|ipad|ipod\b/.test(ua)) return 'ios';
  if (/\bandroid\b/.test(ua)) return 'android';
  // iPadOS 13+ presents as a Mac and is only distinguishable by touch support,
  // which a header cannot carry. It reads as macOS here, and that is a limit
  // worth knowing rather than a bug to chase.
  if (/\bmacintosh|mac os x\b/.test(ua)) return 'macos';
  if (/\bwindows\b/.test(ua)) return 'windows';
  if (/\blinux|x11|cros\b/.test(ua)) return 'linux';
  return 'other';
}

export function evaluateDevicePlatforms(
  platform: string | null,
  wanted: readonly string[],
): ConditionResult {
  if (wanted.length === 0) return 'match';
  // No agent at all. Not `other` — `other` is a device we looked at and did
  // not recognise, and a request with no agent is one we cannot judge.
  if (platform === null) return 'unevaluable';
  return wanted.includes(platform) ? 'match' : 'no-match';
}

/**
 * An ISO 3166-1 alpha-2 country code, upper-cased, or null.
 *
 * **Read from a header the deployment names, never from a database this
 * product ships.** A GeoIP database is a licensed, monthly-updated binary, and
 * bundling one into an on-premise installation means either shipping stale
 * data or requiring an internet feed from a product whose whole point is
 * running without one. Every deployment that cares about country is already
 * behind something that knows it — a reverse proxy, a CDN, a load balancer —
 * and those set a header.
 *
 * `POLICY_COUNTRY_HEADER` names it. Unset, every country condition is
 * `unevaluable`, which on a `deny` rule refuses and on the others does not
 * match. That is the honest behaviour for "this deployment cannot tell", and
 * it is the reason this is not simply a string comparison.
 */
export function countryOf(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().toUpperCase();
  // Cloudflare sends `XX` for an address it cannot place, and `T1` for Tor.
  // Both are "unknown", not a country somebody can write a rule about.
  if (!/^[A-Z]{2}$/.test(value) || value === 'XX' || value === 'T1') return null;
  return value;
}

export function evaluateCountries(
  country: string | null,
  wanted: readonly string[],
): ConditionResult {
  if (wanted.length === 0) return 'match';
  if (country === null) return 'unevaluable';
  const set = new Set(wanted.map((c) => c.trim().toUpperCase()));
  return set.has(country) ? 'match' : 'no-match';
}
