import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_KINDS,
  AUDIT_CHAIN_REF,
  AUDIT_CHECKPOINT_REF,
  COVERAGE_GAP_KINDS,
  FINDING_KINDS,
  RESOURCE_KINDS,
  SEVERITY_ORDER,
  SYNTRA_SYSTEM_ID,
  countRegion,
  known,
  mapTri,
  parseSubjectKey,
  percentOf,
  raiseSeverity,
  resourceKey,
  subjectKey,
  sumRegions,
  unknownValue,
  type CountableRegion,
  type Tri,
} from './types.js';

describe('subject keys', () => {
  it('round-trips a person and an account, and they cannot collide', () => {
    const person = { kind: 'person' as const, personId: 'p-1' };
    const account = { kind: 'account' as const, systemId: 'sys-1', accountRef: 'anchor-7' };

    expect(subjectKey(person)).toBe('person:p-1');
    expect(subjectKey(account)).toBe('account:sys-1:anchor-7');
    expect(parseSubjectKey(subjectKey(person))).toEqual(person);
    expect(parseSubjectKey(subjectKey(account))).toEqual(account);
  });

  it('parses an account whose ref itself contains a colon', () => {
    // AD anchors are objectGUIDs, but a second connector family may return a
    // DN, and a DN is full of colons and commas. Splitting on every colon
    // would silently truncate the ref and merge two accounts into one subject.
    const account = { kind: 'account' as const, systemId: 'sys-1', accountRef: 'CN=a:b,OU=x' };
    expect(parseSubjectKey(subjectKey(account))).toEqual(account);
  });

  it('returns null for a key it does not recognise rather than guessing', () => {
    expect(parseSubjectKey('')).toBeNull();
    expect(parseSubjectKey('person:')).toBeNull();
    expect(parseSubjectKey('user:p-1')).toBeNull();
    expect(parseSubjectKey('account:sys-1')).toBeNull();
  });
});

describe('resource keys', () => {
  it('distinguishes two resources with the same id in different systems', () => {
    const a = resourceKey({
      systemKind: 'targetSystem',
      systemId: 'sys-1',
      resourceKind: 'targetEntitlement',
      resourceId: 'ent-1',
    });
    const b = resourceKey({
      systemKind: 'targetSystem',
      systemId: 'sys-2',
      resourceKind: 'targetEntitlement',
      resourceId: 'ent-1',
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes two resource kinds with the same id in one system', () => {
    const group = resourceKey({
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceKind: 'syntraGroup',
      resourceId: 'x',
    });
    const app = resourceKey({
      systemKind: 'syntraInternal',
      systemId: SYNTRA_SYSTEM_ID,
      resourceKind: 'application',
      resourceId: 'x',
    });
    expect(group).not.toBe(app);
  });
});

describe('three-valued counting', () => {
  const clean = (held: number): CountableRegion => ({
    held,
    unknownHoldings: 0,
    gapReasons: [],
  });

  it('counts a region that was read completely', () => {
    expect(countRegion(clean(1500))).toEqual({ known: true, value: 1500 });
  });

  it('counts an empty, completely-read region as zero rather than unknown', () => {
    // The empty case is not the unknown case. A group that was read and had
    // nobody in it holds a real, defensible zero, and refusing to say so would
    // make every honest zero look like a failure.
    expect(countRegion(clean(0))).toEqual({ known: true, value: 0 });
  });

  it('refuses to produce a number for a region with a gap in it', () => {
    const result = countRegion({
      held: 1500,
      unknownHoldings: 0,
      gapReasons: ['ent-domain-admins could not be read completely'],
    });
    expect(result.known).toBe(false);
    if (result.known) throw new Error('unreachable');
    expect(result.reason).toContain('ent-domain-admins');
  });

  it('refuses to produce a number for a region holding an unknown-state holding', () => {
    const result = countRegion({ held: 3, unknownHoldings: 1, gapReasons: [] });
    expect(result.known).toBe(false);
  });

  it('poisons a sum with one unknown region, and names which', () => {
    const total = sumRegions([
      clean(10),
      { held: 5, unknownHoldings: 0, gapReasons: ['the domain controller was last read nine days ago'] },
      clean(7),
    ]);
    expect(total.known).toBe(false);
    if (total.known) throw new Error('unreachable');
    expect(total.reason).toContain('nine days ago');
  });

  it('sums clean regions, including an empty list', () => {
    expect(sumRegions([clean(10), clean(7)])).toEqual({ known: true, value: 17 });
    expect(sumRegions([])).toEqual({ known: true, value: 0 });
  });

  it('never lets a percentage escape an unknown denominator', () => {
    const p = percentOf(91, unknownValue<number>('Finance-Payments could not be read'));
    expect(p.known).toBe(false);
  });

  it('carries the denominator alongside a known percentage', () => {
    const p = percentOf(91, known(1840));
    expect(p).toEqual({
      known: true,
      value: { percent: 4.9, numerator: 91, denominator: 1840 },
    });
  });

  it('refuses a percentage of zero rather than dividing', () => {
    // "0% certified of 0 items" is a sentence that has made an audit go badly.
    const p = percentOf(0, known(0));
    expect(p.known).toBe(false);
  });

  it('propagates unknown through mapTri without inventing a value', () => {
    const doubled = mapTri(unknownValue<number>('unread'), (n) => n * 2);
    expect(doubled).toEqual({ known: false, reason: 'unread' });
  });
});

describe('the property that must hold over generated input', () => {
  // Deliberately a seeded loop rather than a property-testing dependency: the
  // property is small, the generator is four lines, and adding a devDependency
  // for it would be the largest thing in this task.
  function* generated(): Generator<CountableRegion[]> {
    let seed = 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 500; n += 1) {
      const count = next() % 6;
      const regions: CountableRegion[] = [];
      for (let i = 0; i < count; i += 1) {
        const held = next() % 2000;
        const unknownHoldings = next() % 3 === 0 ? next() % 50 : 0;
        const hasGap = next() % 4 === 0;
        regions.push({
          held,
          unknownHoldings,
          gapReasons: hasGap ? [`region ${n}.${i} was not read`] : [],
        });
      }
      yield regions;
    }
  }

  it('never reports a number for a scope that contains an unknown, over 500 generated scopes', () => {
    for (const regions of generated()) {
      const dirty = regions.some((r) => r.unknownHoldings > 0 || r.gapReasons.length > 0);
      const total = sumRegions(regions);
      expect(total.known).toBe(!dirty);
    }
  });

  it('equals the plain sum exactly when nothing is unknown', () => {
    for (const regions of generated()) {
      const dirty = regions.some((r) => r.unknownHoldings > 0 || r.gapReasons.length > 0);
      if (dirty) continue;
      const total = sumRegions(regions);
      expect(total).toEqual({
        known: true,
        value: regions.reduce((acc, r) => acc + r.held, 0),
      });
    }
  });
});

describe('the closed sets', () => {
  it('has no duplicates in any vocabulary', () => {
    for (const set of [RESOURCE_KINDS, ATTRIBUTION_KINDS, COVERAGE_GAP_KINDS, FINDING_KINDS]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('raises severity one step and stops at critical', () => {
    expect(SEVERITY_ORDER).toEqual(['low', 'medium', 'high', 'critical']);
    expect(raiseSeverity('low')).toBe('medium');
    expect(raiseSeverity('high')).toBe('critical');
    expect(raiseSeverity('critical')).toBe('critical');
  });

  it('names all fifteen standing and derived finding kinds', () => {
    expect(FINDING_KINDS).toHaveLength(15);
    expect(FINDING_KINDS).toContain('unattributable_holding');
    expect(FINDING_KINDS).toContain('unexplained_gain');
    expect(FINDING_KINDS).toContain('access_without_contract');
    expect(FINDING_KINDS).toContain('dispatch_not_applied');
    expect(FINDING_KINDS).toContain('unmergeable_actor');
  });

  it('carries the two deliberate departures from section 16 and says which way', () => {
    // Both are amended in the spec at Task 1 Step 13, and both are the kind of
    // decision that gets quietly reverted by somebody reading section 16's kind
    // table on its own. This is the assertion that stops that.
    //
    // IN: the audit integrity alarm needs a kind the nightly detect-stage sweep
    // does not own. `STANDING_KINDS` is a written-out literal in
    // `snapshot-service.ts` and `audit_chain_broken` is deliberately not in it.
    expect(FINDING_KINDS).toContain('audit_chain_broken');
    // OUT: a lapsed exception ages the EXISTING `sod_violation` finding
    // (section 15 rule 3, implemented by `lapse()`), so a second kind would be
    // two rows for one problem — the thing Task 8A exists to prevent.
    expect(FINDING_KINDS).not.toContain('lapsed_exception');
  });

  it('gives the two audit subject references exactly one definition each', () => {
    // `audit-integrity.ts` writes them, `finding-service.ts` parses them back.
    // Two literals is how a writer and a reader drift.
    expect(AUDIT_CHECKPOINT_REF).toBe('audit-checkpoint:');
    expect(AUDIT_CHAIN_REF).toBe('audit-chain:');
    expect(AUDIT_CHECKPOINT_REF).not.toBe(AUDIT_CHAIN_REF);
  });
});
