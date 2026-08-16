import { describe, expect, it } from 'vitest';
import { resolveClaims } from './resolve.js';
import type { ClaimMappingSpec, SubjectFacts } from './types.js';

const mapping = (over: Partial<ClaimMappingSpec>): ClaimMappingSpec => ({
  id: 'm1',
  protocol: 'oidc',
  claimName: 'department',
  nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
  sourceKind: 'contract',
  sourceField: 'department',
  contractStrategy: 'primary',
  literalValue: null,
  releaseScope: null,
  multiValued: false,
  ...over,
});

const facts = (over: Partial<SubjectFacts> = {}): SubjectFacts => ({
  user: { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' },
  person: { givenName: 'J', familyName: 'Doe', businessEmail: 'j@acme.test' },
  contract: { primary: null, lowestSequence: null },
  attributes: {},
  groups: [],
  ...over,
});

describe('resolveClaims', () => {
  it('reads the primary contract when the mapping says primary', () => {
    const out = resolveClaims(
      [mapping({ contractStrategy: 'primary' })],
      facts({
        contract: {
          primary: { department: 'Finance', jobTitle: 'Controller' },
          lowestSequence: { department: 'Care', jobTitle: 'Nurse' },
        },
      }),
      'oidc',
    );
    expect(out).toEqual([
      { name: 'department', nameFormat: expect.any(String), values: ['Finance'], releaseScope: null },
    ]);
  });

  it('reads the lowest-sequence active contract when the mapping says so', () => {
    const out = resolveClaims(
      [mapping({ contractStrategy: 'lowestSequence' })],
      facts({
        contract: {
          primary: { department: 'Finance' },
          lowestSequence: { department: 'Care' },
        },
      }),
      'oidc',
    );
    expect(out[0]!.values).toEqual(['Care']);
  });

  it('omits the claim entirely when the strategy resolves to no contract', () => {
    const out = resolveClaims([mapping({})], facts(), 'oidc');
    // Not [{ name: 'department', values: [] }] and not values: ['']. The
    // claim is absent. A relying party that branches on presence must see
    // absence, and an SP that renders an empty <AttributeValue/> shows a
    // person a blank department they never had.
    expect(out).toEqual([]);
  });

  it('omits the claim when the selected contract has the field but it is null', () => {
    const out = resolveClaims(
      [mapping({})],
      facts({ contract: { primary: { department: null }, lowestSequence: null } }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('omits the claim when the selected contract has an empty string', () => {
    const out = resolveClaims(
      [mapping({})],
      facts({ contract: { primary: { department: '  ' }, lowestSequence: null } }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('emits a person with concurrent contracts once per mapping, not once per contract', () => {
    const out = resolveClaims(
      [
        mapping({ id: 'a', claimName: 'dept_primary', contractStrategy: 'primary' }),
        mapping({ id: 'b', claimName: 'dept_first', contractStrategy: 'lowestSequence' }),
      ],
      facts({
        contract: {
          primary: { department: 'Finance' },
          lowestSequence: { department: 'Care' },
        },
      }),
      'oidc',
    );
    expect(out.map((c) => [c.name, c.values])).toEqual([
      ['dept_primary', ['Finance']],
      ['dept_first', ['Care']],
    ]);
  });

  it('reads user, person, attribute, groups and literal sources', () => {
    const out = resolveClaims(
      [
        mapping({ id: '1', claimName: 'email', sourceKind: 'user', sourceField: 'email' }),
        mapping({ id: '2', claimName: 'family_name', sourceKind: 'person', sourceField: 'familyName' }),
        mapping({ id: '3', claimName: 'costCentre', sourceKind: 'attribute', sourceField: 'cost_centre' }),
        mapping({ id: '4', claimName: 'groups', sourceKind: 'groups', sourceField: null, multiValued: true }),
        mapping({ id: '5', claimName: 'tenant', sourceKind: 'literal', sourceField: null, literalValue: 'acme' }),
      ],
      facts({ attributes: { cost_centre: 'CC-1' }, groups: ['Finance', 'All Staff'] }),
      'oidc',
    );
    expect(out.map((c) => [c.name, c.values])).toEqual([
      ['email', ['j@acme.test']],
      ['family_name', ['Doe']],
      ['costCentre', ['CC-1']],
      ['groups', ['Finance', 'All Staff']],
      ['tenant', ['acme']],
    ]);
  });

  it('omits a groups claim for a user in no groups', () => {
    const out = resolveClaims(
      [mapping({ claimName: 'groups', sourceKind: 'groups', sourceField: null, multiValued: true })],
      facts({ groups: [] }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('takes only the first value when the mapping is not multi-valued', () => {
    const out = resolveClaims(
      [mapping({ claimName: 'group', sourceKind: 'groups', sourceField: null, multiValued: false })],
      facts({ groups: ['Finance', 'All Staff'] }),
      'oidc',
    );
    expect(out[0]!.values).toEqual(['Finance']);
  });

  it('ignores mappings belonging to the other protocol', () => {
    const out = resolveClaims(
      [mapping({ protocol: 'saml', claimName: 'onlySaml', sourceKind: 'literal', literalValue: 'x' })],
      facts(),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('omits an unknown source kind rather than emitting undefined', () => {
    const out = resolveClaims(
      [mapping({ sourceKind: 'nonsense' as never })],
      facts(),
      'oidc',
    );
    expect(out).toEqual([]);
  });
});
