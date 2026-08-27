import { describe, expect, it } from 'vitest';
import {
  countryOf,
  devicePlatformOf,
  evaluateCountries,
  evaluateDevicePlatforms,
} from './device-match.js';

describe('devicePlatformOf', () => {
  it('reads a phone before the desktop it claims to be', () => {
    // An iPhone's agent says "like Mac OS X" and an Android's says "Linux".
    // Testing for the desktop first would file every phone under a desktop,
    // which is the exact opposite of what "not from a phone" is asking for.
    expect(
      devicePlatformOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      ),
    ).toBe('ios');
    expect(
      devicePlatformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'),
    ).toBe('android');
  });

  it('reads the desktops', () => {
    expect(devicePlatformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(devicePlatformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(devicePlatformOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('separates a device it did not recognise from one that sent nothing', () => {
    expect(devicePlatformOf('curl/8.4.0')).toBe('other');
    expect(devicePlatformOf(null)).toBeNull();
    expect(devicePlatformOf('   ')).toBeNull();
  });
});

describe('evaluateDevicePlatforms', () => {
  it('is unconstrained when the rule names nothing', () => {
    expect(evaluateDevicePlatforms(null, [])).toBe('match');
  });

  it('cannot judge a request that sent no agent', () => {
    // Not 'other'. 'other' is a device we looked at and did not recognise; a
    // request with no agent is one there is nothing to look at. The engine
    // fails an unevaluable towards refusing on a deny rule, and that is only
    // correct if the two stay distinct.
    expect(evaluateDevicePlatforms(null, ['windows'])).toBe('unevaluable');
    expect(evaluateDevicePlatforms('other', ['windows'])).toBe('no-match');
  });

  it('matches a named kind', () => {
    expect(evaluateDevicePlatforms('ios', ['ios', 'android'])).toBe('match');
    expect(evaluateDevicePlatforms('windows', ['ios', 'android'])).toBe('no-match');
  });
});

describe('countryOf', () => {
  it('upper-cases and accepts a two-letter code', () => {
    expect(countryOf('nl')).toBe('NL');
    expect(countryOf(' US ')).toBe('US');
  });

  it('treats the codes that mean "unknown" as unknown', () => {
    // Cloudflare sends XX for an address it cannot place and T1 for Tor.
    // Taken at face value they are countries somebody could write a rule
    // about, and a rule allowing XX would allow every address that failed to
    // resolve.
    expect(countryOf('XX')).toBeNull();
    expect(countryOf('T1')).toBeNull();
    expect(countryOf('')).toBeNull();
    expect(countryOf('USA')).toBeNull();
    expect(countryOf(null)).toBeNull();
  });
});

describe('evaluateCountries', () => {
  it('is unconstrained when the rule names nothing', () => {
    expect(evaluateCountries(null, [])).toBe('match');
  });

  it('cannot judge a deployment that carries no country', () => {
    // The common case, not an edge one: POLICY_COUNTRY_HEADER is unset in
    // every deployment that has not been configured for it, and every country
    // condition there is unevaluable.
    expect(evaluateCountries(null, ['NL'])).toBe('unevaluable');
  });

  it('compares case- and space-insensitively on both sides', () => {
    expect(evaluateCountries('NL', [' nl '])).toBe('match');
    expect(evaluateCountries('NL', ['US'])).toBe('no-match');
  });
});
