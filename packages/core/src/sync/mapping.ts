import { first, type ObjectType, type SourceRecord } from '@syntra/connectors';

export interface MappingRule {
  objectType: ObjectType;
  sourceAttribute: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

export interface DirectoryObject {
  anchor: string;
  objectType: ObjectType;
  dn: string;
  fields: Record<string, string>;
  correlationValue?: string;
  memberDns: string[];
}

export type MappingFailure = {
  failed: true;
  anchor: string;
  reason: string;
};

export function isMappingFailure(
  value: DirectoryObject | MappingFailure,
): value is MappingFailure {
  return (value as MappingFailure).failed === true;
}

function applyTransform(value: string, transform: MappingRule['transform']) {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    default:
      return value;
  }
}

/**
 * Turns a raw source record into the shape Syntra stores, using the mappings
 * configured for its object type.
 *
 * A record with no correlation value is failed rather than mapped: it cannot
 * be matched to anything, and guessing risks attaching it to the wrong
 * account.
 */
export function mapRecord(
  record: SourceRecord,
  rules: MappingRule[],
): DirectoryObject | MappingFailure {
  const applicable = rules.filter((r) => r.objectType === record.objectType);

  const fields: Record<string, string> = {};
  let correlationValue: string | undefined;

  for (const rule of applicable) {
    const raw = first(record, rule.sourceAttribute);
    if (raw === undefined) continue;

    const value = applyTransform(raw, rule.transform);
    fields[rule.targetField] = value;
    if (rule.isCorrelation) correlationValue = value;
  }

  if (correlationValue === undefined) {
    return {
      failed: true,
      anchor: record.anchor,
      reason: 'the correlation attribute is missing from this record',
    };
  }

  return {
    anchor: record.anchor,
    objectType: record.objectType,
    dn: record.dn,
    fields,
    correlationValue,
    memberDns: record.memberDns ?? [],
  };
}
