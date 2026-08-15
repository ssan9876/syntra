export type ObjectType = 'user' | 'group' | 'orgUnit';

/**
 * One object as the source presented it. Attributes are always arrays because
 * that is what LDAP returns, regardless of what the schema claims about
 * single-valued attributes.
 */
export interface SourceRecord {
  /** Immutable identifier. Never the DN — a DN changes when an object moves. */
  anchor: string;
  objectType: ObjectType;
  dn: string;
  attributes: Record<string, string[]>;
  /** Present on groups: the DNs of members, resolved to anchors by the reader. */
  memberDns?: string[];
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<ObjectType, number>;
}

export interface SchemaDescriptor {
  objectClasses: string[];
  attributes: string[];
}

export interface WriteOperation {
  objectType: ObjectType;
  anchor: string;
  attributes: Record<string, string[]>;
}

export interface WriteResult {
  ok: boolean;
  message: string;
}

export interface Connector<C> {
  test(config: C): Promise<ConnectionResult>;
  discoverSchema(config: C): Promise<SchemaDescriptor>;
  read(config: C): AsyncIterable<SourceRecord>;
  /** Declared for Provision. Unimplemented by LDAP in this slice. */
  write(config: C, op: WriteOperation): Promise<WriteResult>;
}

/**
 * First value of an attribute, matched case-insensitively because LDAP
 * attribute names are case-insensitive and servers differ on what they return.
 */
export function first(
  record: SourceRecord,
  attribute: string,
): string | undefined {
  const wanted = attribute.toLowerCase();
  for (const [key, values] of Object.entries(record.attributes)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}
