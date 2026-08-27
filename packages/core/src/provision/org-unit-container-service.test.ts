import { describe, expect, it } from 'vitest';
import { validateContainerDn } from './org-unit-container-service.js';

const base = 'OU=Users,OU=Syntra,DC=ssander,DC=local';

function refusal(result: ReturnType<typeof validateContainerDn>) {
  if (result.ok) throw new Error('expected a refusal, got a valid DN');
  return result;
}

describe('validateContainerDn', () => {
  it('accepts a DN one level below the base', () => {
    expect(validateContainerDn(`OU=Sales,${base}`, base)).toEqual({
      ok: true,
      dn: `OU=Sales,${base}`,
    });
  });

  it('accepts a DN several levels below the base', () => {
    const dn = `OU=West,OU=Sales,${base}`;
    expect(validateContainerDn(dn, base)).toEqual({ ok: true, dn });
  });

  it('accepts the base itself, which is where an adopted root unit sits', () => {
    expect(validateContainerDn(base, base)).toEqual({ ok: true, dn: base });
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    expect(validateContainerDn(`  OU=Sales,${base}  `, base)).toEqual({
      ok: true,
      dn: `OU=Sales,${base}`,
    });
  });

  it('refuses a DN outside the base', () => {
    // The failure this closes: a materialisation pointing at CN=Users, or at
    // another domain's subtree, would have Provision writing where the target
    // configuration never said it could.
    const result = refusal(validateContainerDn('CN=Users,DC=ssander,DC=local', base));
    expect(result.reason).toBe('outside_base');
    expect(result.message).toContain(base);
  });

  it('refuses a DN that is not a DN', () => {
    expect(refusal(validateContainerDn('Sales', base)).reason).toBe('malformed');
  });

  it('refuses an empty DN rather than treating it as the base', () => {
    expect(refusal(validateContainerDn('   ', base)).reason).toBe('malformed');
  });

  it('refuses an RDN with no attribute type', () => {
    expect(refusal(validateContainerDn(`=Sales,${base}`, base)).reason).toBe('malformed');
  });

  it('refuses an RDN with no value', () => {
    expect(refusal(validateContainerDn(`OU=,${base}`, base)).reason).toBe('malformed');
  });

  it('compares case-insensitively, because DNs are', () => {
    expect(validateContainerDn(`ou=sales,${base.toUpperCase()}`, base).ok).toBe(true);
  });

  it('refuses a suffix that merely looks like the base', () => {
    // `OU=Evil,OU=XUsers,OU=Syntra,...` ends with a STRING containing the
    // base's tail while sitting nowhere below it. A naive endsWith() accepts
    // this, which is why the comparison is on RDN boundaries.
    expect(
      refusal(
        validateContainerDn('OU=Evil,OU=XUsers,OU=Syntra,DC=ssander,DC=local', base),
      ).reason,
    ).toBe('outside_base');
  });

  it('refuses a DN shorter than the base', () => {
    expect(refusal(validateContainerDn('DC=ssander,DC=local', base)).reason).toBe(
      'outside_base',
    );
  });

  it('keeps an escaped comma inside one RDN', () => {
    // `OU=Sales\,West` is ONE unit whose name contains a comma, not two
    // units. Splitting on it would compare the wrong number of RDNs against
    // the base and refuse a legitimate DN.
    const dn = `OU=Sales\\,West,${base}`;
    expect(validateContainerDn(dn, base)).toEqual({ ok: true, dn });
  });

  it('refuses a DN ending in a dangling escape', () => {
    expect(refusal(validateContainerDn(`OU=Sales,${base}\\`, base)).reason).toBe(
      'malformed',
    );
  });

  it('refuses when the target has no base DN to validate against', () => {
    // A non-AD target renders `baseDn` as an empty string. Materialising
    // against one must refuse rather than accept every DN in the world.
    expect(refusal(validateContainerDn(`OU=Sales,${base}`, '')).reason).toBe('malformed');
  });
});
