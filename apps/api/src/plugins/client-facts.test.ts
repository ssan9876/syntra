import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { clientFacts, countryHeaderName } from './client-facts.js';

const ROUTES = join(import.meta.dirname, '..', 'routes');

const request = (headers: Record<string, string | string[]>) =>
  ({ headers }) as never;

afterEach(() => {
  delete process.env.POLICY_COUNTRY_HEADER;
});

describe('clientFacts', () => {
  it('carries the user agent', () => {
    expect(clientFacts(request({ 'user-agent': 'curl/8.4.0' })).userAgent).toBe('curl/8.4.0');
  });

  it('reads no country until the deployment names the header', () => {
    // The default state, and the important one: a header nobody named is a
    // header an untrusted client could have set, so nothing is read from one.
    expect(countryHeaderName()).toBeNull();
    expect(clientFacts(request({ 'cf-ipcountry': 'NL' })).countryHeader).toBeNull();

    process.env.POLICY_COUNTRY_HEADER = 'CF-IPCountry';
    expect(clientFacts(request({ 'cf-ipcountry': 'NL' })).countryHeader).toBe('NL');
  });

  it('takes the first of a repeated header rather than an array', () => {
    process.env.POLICY_COUNTRY_HEADER = 'x-country';
    expect(clientFacts(request({ 'x-country': ['NL', 'US'] })).countryHeader).toBe('NL');
  });
});

/**
 * The invariant, not a nicety.
 *
 * A device or country rule that applies on the password screen and not on the
 * SAML one is worse than no rule at all: an administrator reads "not from a
 * phone", believes it, and has no way to find the one entry point that ignores
 * it. Every `authorize()` call is a door, so every door reads the same facts.
 */
describe('every authorize() call site supplies the client facts', () => {
  const files = readdirSync(ROUTES, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(ROUTES, f));

  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    // The whole call, up to the line closing its argument object.
    for (const match of source.matchAll(/authorize\((?:request\.)?tenantId, \{[\s\S]*?\n {4}\}\)/g)) {
      it(`${file.replace(ROUTES, '').slice(1)} at offset ${match.index}`, () => {
        expect(match[0]).toContain('client: clientFacts(request)');
      });
    }
  }
});
