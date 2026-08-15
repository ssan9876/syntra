import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../plugins/problem-json.js';
import { assertWebAuthnUsable, tenantRelyingParty } from './relying-party.js';

const PUBLIC_URL = 'https://syntra.example:8443';

/** Only the Host header is read, so this is the whole of the request. */
const requestFrom = (host: string) =>
  ({ headers: { host } }) as unknown as FastifyRequest;

describe('tenantRelyingParty', () => {
  it('takes the relying party from the tenant, never from the request', () => {
    // The phishing control in one line. `tenant-context.ts` resolves a tenant
    // from the leftmost label of the Host header, so `acme.attacker.example`
    // resolves tenant `acme` — deriving the RP ID from that header would let a
    // phisher choose what their own assertion is checked against.
    const rp = tenantRelyingParty({ primaryDomain: 'acme.example' }, PUBLIC_URL);
    expect(rp).toEqual({
      id: 'acme.example',
      // Scheme and port from PUBLIC_URL: behind a TLS-terminating proxy the
      // request reports http, and a wrong expected origin fails every
      // assertion with a message that points nowhere useful.
      origin: 'https://acme.example:8443',
    });
  });

  it('falls back to PUBLIC_URL when the tenant has no primary domain', () => {
    // Usable for a single-tenant deployment served straight off PUBLIC_URL.
    // For anything else the Host check below is what refuses.
    expect(tenantRelyingParty({ primaryDomain: null }, PUBLIC_URL)).toEqual({
      id: 'syntra.example',
      origin: 'https://syntra.example:8443',
    });
  });

  it('leaves the port off when PUBLIC_URL has none', () => {
    expect(
      tenantRelyingParty({ primaryDomain: 'acme.example' }, 'https://syntra.example'),
    ).toEqual({ id: 'acme.example', origin: 'https://acme.example' });
  });
});

describe('assertWebAuthnUsable', () => {
  it('allows a request that arrived on the tenant own host', () => {
    const tenant = { primaryDomain: 'acme.example' };
    const rp = tenantRelyingParty(tenant, PUBLIC_URL);
    expect(() =>
      assertWebAuthnUsable(requestFrom('acme.example:8443'), tenant, rp),
    ).not.toThrow();
  });

  it('refuses a lookalike host that resolves to the same tenant', () => {
    // `acme.attacker.example` resolves tenant `acme` by its leftmost label, so
    // without this check the request would be served — and the assertion would
    // be verified against whatever the attacker asked for.
    const tenant = { primaryDomain: 'acme.example' };
    const rp = tenantRelyingParty(tenant, PUBLIC_URL);

    let thrown: unknown;
    try {
      assertWebAuthnUsable(requestFrom('acme.attacker.example'), tenant, rp);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ProblemError);
    const problem = thrown as ProblemError;
    expect(problem.status).toBe(409);
    expect(problem.type).toBe('webauthn-unavailable');
    expect(problem.detail).toContain('acme.example');
  });

  it('refuses, with a different explanation, when no primary domain is set', () => {
    // The dead end an administrator can actually fix, so the message names the
    // fix rather than the address.
    const tenant = { primaryDomain: null };
    const rp = tenantRelyingParty(tenant, PUBLIC_URL);
    expect(() =>
      assertWebAuthnUsable(requestFrom('acme.syntra.example'), tenant, rp),
    ).toThrow(/primary domain/);
  });

  it('ignores case and the port when comparing hosts', () => {
    const tenant = { primaryDomain: 'acme.example' };
    const rp = tenantRelyingParty(tenant, PUBLIC_URL);
    expect(() =>
      assertWebAuthnUsable(requestFrom('ACME.example:443'), tenant, rp),
    ).not.toThrow();
  });
});
