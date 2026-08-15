import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@syntra/connectors';
import {
  isMappingFailure,
  mapRecord,
  type MappingRule,
} from './mapping.js';

const rules: MappingRule[] = [
  {
    objectType: 'user',
    sourceAttribute: 'sAMAccountName',
    targetField: 'login',
    transform: 'lowercase',
    isCorrelation: true,
  },
  {
    objectType: 'user',
    sourceAttribute: 'mail',
    targetField: 'email',
    transform: 'lowercase',
    isCorrelation: false,
  },
  {
    objectType: 'user',
    sourceAttribute: 'displayName',
    targetField: 'displayName',
    transform: 'trim',
    isCorrelation: false,
  },
];

const record = (attributes: Record<string, string[]>): SourceRecord => ({
  anchor: 'a1',
  objectType: 'user',
  dn: 'cn=Jo,dc=acme,dc=test',
  attributes,
});

describe('mapRecord', () => {
  it('applies each rule and its transform', () => {
    const result = mapRecord(
      record({
        sAMAccountName: ['JDoe'],
        mail: ['Jo.Doe@ACME.test'],
        displayName: ['  Jo Doe  '],
      }),
      rules,
    );

    expect(isMappingFailure(result)).toBe(false);
    if (isMappingFailure(result)) return;
    expect(result.fields).toEqual({
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'Jo Doe',
    });
  });

  it('records the correlation value from the rule marked as the key', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['JDoe'], mail: ['j@acme.test'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.correlationValue).toBe('jdoe');
  });

  it('omits a field whose source attribute is absent', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.fields).not.toHaveProperty('email');
  });

  it('fails the record when the correlation attribute is missing', () => {
    // Without a correlation value the object cannot be matched to anything,
    // and guessing would risk attaching it to the wrong account.
    const result = mapRecord(record({ mail: ['j@acme.test'] }), rules);
    expect(isMappingFailure(result)).toBe(true);
    if (!isMappingFailure(result)) return;
    expect(result.reason).toMatch(/correlation/i);
  });

  it('ignores rules for a different object type', () => {
    const mixed: MappingRule[] = [
      ...rules,
      {
        objectType: 'group',
        sourceAttribute: 'cn',
        targetField: 'name',
        transform: 'none',
        isCorrelation: true,
      },
    ];
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], cn: ['Nurses'], displayName: ['Jo'] }),
      mixed,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.fields).not.toHaveProperty('name');
  });

  it('carries member DNs through untouched', () => {
    const group: SourceRecord = {
      anchor: 'g1',
      objectType: 'group',
      dn: 'cn=Nurses,dc=acme,dc=test',
      attributes: { cn: ['Nurses'] },
      memberDns: ['cn=Jo,dc=acme,dc=test'],
    };
    const result = mapRecord(group, [
      {
        objectType: 'group',
        sourceAttribute: 'cn',
        targetField: 'name',
        transform: 'none',
        isCorrelation: true,
      },
    ]);
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.memberDns).toEqual(['cn=Jo,dc=acme,dc=test']);
  });

  it('returns an empty member list when there are none', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.memberDns).toEqual([]);
  });
});
