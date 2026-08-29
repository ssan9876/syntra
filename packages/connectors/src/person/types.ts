/**
 * One employment or engagement, as the source presented it.
 *
 * Every field is a string because a delimited file has no types. Parsing
 * `startDate` into a Date happens in `@syntra/core`'s mapping layer, where a
 * bad value becomes a mapping failure against a named person rather than an
 * exception that fails the whole read.
 */
export interface ContractSnapshot {
  /** The HR system's own employment id. See `Contract.externalId`. */
  externalId?: string;
  sequence?: number;
  isPrimary?: boolean;
  startDate: string;
  endDate?: string;
  jobTitle?: string;
  department?: string;
  costCentre?: string;
  employer?: string;
  location?: string;
  managerExternalId?: string;
  fte?: string;
}

/**
 * One person and their contracts, read as one unit.
 *
 * Together or not at all: a person imported without their contracts has no
 * department, no start date and no manager, and the placement ladder and every
 * business rule would read that as true rather than as missing.
 *
 * Values are single strings, unlike `SourceRecord.attributes`. That type uses
 * arrays because LDAP returns arrays regardless of what the schema claims; a
 * delimited file has one value per cell, and pretending otherwise would push
 * the unwrapping into every consumer.
 */
export interface PersonSnapshotRecord {
  /** The anchor. Correlates to `Person.externalId`. */
  externalId: string;
  fields: Record<string, string>;
  contracts: ContractSnapshot[];
  /**
   * Set when the source returned this person but the connector could not read
   * them completely enough to diff against safely.
   *
   * The record is still returned rather than dropped, because the difference
   * between "this person is gone" and "we could not read this person" is the
   * difference between a correct departure and a catastrophic one. A reader
   * seeing this must count the record as read, exclude it from the diff, and
   * never treat it as absent.
   */
  readFailure?: string;
}

/**
 * What a person source's `test` reports back.
 *
 * Deliberately not `ConnectionResult`. That type carries `sampleCounts` keyed
 * by `ObjectType` and `rights` describing what a bind may write, and neither
 * means anything for a read-only person source. What the console needs from a
 * test here is the column names to map against and the host key to confirm.
 */
export interface SourceConnectionResult {
  ok: boolean;
  message: string;
  /** Column names as the file presents them. Drives the mapping editor. */
  columns?: string[];
  recordsSampled?: number;
  /**
   * The key the server presented, and how it compares to what is stored.
   *
   * Three-valued, not a boolean, and on the result rather than thrown: an
   * unknown key on a first test is the ordinary path -- it is how a
   * fingerprint is obtained -- while a mismatch is a failure that sets
   * `ok: false` and offers no accept action. Collapsing the two would make
   * accepting a changed key one click away from accepting a first one.
   */
  hostKey?: {
    fingerprint: string;
    status: 'matched' | 'unknown' | 'mismatch';
  };
}

/**
 * A system Syntra reads persons from.
 *
 * Much smaller than `Connector<C>`, and the omissions are the design. There is
 * no `write`, no `discoverSchema` and no `SourceWriteback`: an HR system is
 * authoritative, Syntra reads it and never writes to it, and an interface with
 * no write path enforces that rather than asking a docstring to.
 *
 * **`read` yields every record the source holds, or throws.** There is no
 * third outcome and no partial-success return value, because a partial read a
 * caller could mistake for a complete one is the input that departs a
 * workforce. Ceilings throw when reached rather than ending the iteration, and
 * a transport error mid-stream propagates. Per-record incompleteness has its
 * own channel -- `readFailure` -- which is a statement about one person and
 * never about the file.
 */
export interface SourceConnector<C> {
  test(config: C): Promise<SourceConnectionResult>;
  read(config: C): AsyncIterable<PersonSnapshotRecord>;
}
