import type {
  ConnectionResult,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteFailure,
  WriteOperation,
  WriteResult,
} from '../types.js';

export interface FakeTargetConfig {
  domain: string;
}

/** How the next N calls of one operation should behave. */
export interface ProgrammedOutcome {
  /** How many of the next calls fail. `Infinity` for a permanent failure. */
  failTimes?: number;
  failure?: WriteFailure;
  retryAfterMs?: number;
  /**
   * The write LANDS at the target and then the response is lost. Distinct
   * from `failTimes`, which does not land. This is the case the provenance
   * marker exists for, and the one a naive retry duplicates.
   */
  loseResponseTimes?: number;
}

interface FakeObject {
  anchor: string;
  correlationKey: string;
  /** Where the object sits. A directory has one; a Map keyed on anchor does not. */
  dn: string;
  attributes: Record<string, string[]>;
  enabled: boolean;
  archived: boolean;
  /** The actionId that created it, or null for an object Syntra never made. */
  provenance: string | null;
}

/** Where a create lands when the operation names no distinguished name. */
const DEFAULT_CONTAINER = 'OU=Users,DC=acme,DC=test';

/**
 * An in-memory TargetConnector with programmable failures.
 *
 * Exists so that every failure path in the enforcement loop -- transient,
 * permanent, throttled, lost response, foreign collision, empty target -- is
 * exercised deterministically and without a container. The Samba container in
 * Task 4 proves the Active Directory *connector*; this proves the *run*.
 */
export class FakeTarget implements TargetConnector<FakeTargetConfig> {
  readonly objects = new Map<string, FakeObject>();
  /**
   * Anchor to the set of group **distinguished names** it holds.
   *
   * DNs, not entitlement ids and not objectGUIDs, because that is what a
   * directory holds: `member` on the group and `memberOf` on the user are both
   * lists of DNs. Keying this the way the caller finds convenient was the
   * defect Ruling P8 exists to prevent -- it made the whole externalId-to-DN
   * mapping untested, and against real Active Directory every managed holding
   * became permanent drift.
   */
  readonly holdings = new Map<string, Set<string>>();
  readonly calls: WriteOperation[] = [];
  /** The catalog. `write` resolves an entitlementId to a DN through this. */
  readonly entitlements: DiscoveredEntitlement[] = [];
  /** The containers this target holds. Read by `listContainers`, never inferred. */
  readonly containers: string[] = [];
  /**
   * Entitlement DNs whose membership cannot be read.
   *
   * Seedable so the run-service tests can exercise the path a truncated Active
   * Directory group takes: the read throws, the run marks the entitlement
   * `unreadable`, and every rule naming it makes its people exceptions instead
   * of proposing grants and revocations against half a membership.
   */
  readonly unreadableEntitlementDns = new Set<string>();
  /** Makes `read` return nothing while objects exist -- an outage, not an empty domain. */
  returnsNothing = false;

  private programmed = new Map<WriteOperation['op'], ProgrammedOutcome>();
  private counter = 0;

  program(op: WriteOperation['op'], outcome: ProgrammedOutcome): void {
    this.programmed.set(op, { ...outcome });
  }

  /** An object at this correlation key that Syntra did not create. */
  seedForeignObject(correlationKey: string, container = DEFAULT_CONTAINER): string {
    const anchor = this.nextAnchor();
    this.objects.set(anchor, {
      anchor,
      correlationKey,
      dn: `CN=${correlationKey},${container}`,
      attributes: {},
      enabled: true,
      archived: false,
      provenance: null,
    });
    return anchor;
  }

  /** The DN of an entitlement, or undefined. The fake's `groupDnFor`. */
  private dnForEntitlement(externalId: string): string | undefined {
    return this.entitlements.find((e) => e.externalId === externalId)?.dn;
  }

  async test(_config: FakeTargetConfig): Promise<ConnectionResult> {
    return { ok: true, message: 'fake target reachable' };
  }

  async discoverSchema(_config: FakeTargetConfig): Promise<SchemaDescriptor> {
    return { objectClasses: ['user', 'group'], attributes: ['displayName'] };
  }

  async *read(_config: FakeTargetConfig): AsyncIterable<SourceRecord> {
    if (this.returnsNothing) return;
    for (const object of this.objects.values()) {
      yield {
        anchor: object.anchor,
        objectType: 'user',
        dn: object.dn,
        attributes: {
          ...object.attributes,
          sAMAccountName: [object.correlationKey],
          userAccountControl: [object.enabled ? '512' : '514'],
          info: object.provenance ? [object.provenance] : [],
          // DNs. Ruling P8: where the real system returns DNs, so does this.
          memberOf: [...(this.holdings.get(object.anchor) ?? [])],
        },
      };
    }
  }

  async *listEntitlements(_config: FakeTargetConfig): AsyncIterable<DiscoveredEntitlement> {
    for (const entitlement of this.entitlements) yield entitlement;
  }

  async readEntitlementMembers(
    _config: FakeTargetConfig,
    entitlementDn: string,
  ): Promise<string[]> {
    if (this.unreadableEntitlementDns.has(entitlementDn)) {
      throw new Error(
        `the directory stopped returning member on ${entitlementDn} partway through a ranged read`,
      );
    }
    const members: string[] = [];
    for (const [anchor, held] of this.holdings) {
      if (!held.has(entitlementDn)) continue;
      const object = this.objects.get(anchor);
      if (object) members.push(object.dn);
    }
    return members;
  }

  async *listContainers(_config: FakeTargetConfig): AsyncIterable<{ dn: string }> {
    // Exactly what it was seeded with. Never derived from the accounts it
    // holds: an empty container is a real thing, and a first run against an
    // empty target must still be able to place an account somewhere.
    for (const dn of this.containers) yield { dn };
  }

  async write(
    _config: FakeTargetConfig,
    op: WriteOperation,
  ): Promise<WriteResult> {
    this.calls.push(op);
    const outcome = this.programmed.get(op.op);

    if (outcome?.loseResponseTimes) {
      outcome.loseResponseTimes -= 1;
      this.perform(op);
      // The write landed. The caller is told it did not, which is exactly the
      // state a lost response leaves the run in.
      return { ok: false, message: 'connection reset after write', failure: 'transient' };
    }

    if (outcome?.failTimes && outcome.failTimes > 0) {
      outcome.failTimes -= 1;
      const failure = outcome.failure ?? 'transient';
      return {
        ok: false,
        message: `programmed ${failure}`,
        failure,
        ...(outcome.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: outcome.retryAfterMs }),
      };
    }

    return this.perform(op);
  }

  private perform(op: WriteOperation): WriteResult {
    switch (op.op) {
      case 'create_account': {
        const existing = [...this.objects.values()].find(
          (o) => o.correlationKey === op.correlationKey,
        );
        if (existing) {
          // Present, carrying THIS actionId -- our own previous attempt
          // succeeded and we lost the answer. Adopt it.
          if (existing.provenance === op.actionId) {
            return {
              ok: true,
              message: 'adopted the account this action already created',
              anchor: existing.anchor,
            };
          }
          // Present, carrying anything else or nothing. Never adopted.
          return {
            ok: false,
            message: `an account named ${op.correlationKey} already exists and was not created by this action`,
            failure: 'conflict',
          };
        }
        const anchor = this.nextAnchor();
        // The password is used and not kept. Nothing on FakeObject, nothing in
        // `calls`' stored copy that a later assertion could read back, and
        // nothing in any WriteResult: a fake that retained it would let a leak
        // through the action and audit rows pass unnoticed.
        this.objects.set(anchor, {
          anchor,
          correlationKey: op.correlationKey,
          dn:
            op.attributes.distinguishedName?.[0] ??
            `CN=${op.correlationKey},${this.containers[0] ?? DEFAULT_CONTAINER}`,
          attributes: Object.fromEntries(
            Object.entries(op.attributes).filter(([key]) => key !== 'distinguishedName'),
          ),
          enabled: op.enabled,
          archived: false,
          provenance: op.actionId,
        });
        return { ok: true, message: 'created', anchor };
      }
      case 'update_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        // Desired state, not a delta: the same update twice leaves the same
        // result, which is what makes retry free. A distinguishedName in the
        // set is a move, exactly as it is on the AD connector, and the anchor
        // is unchanged by it -- which is the point of anchoring on objectGUID.
        const moved = op.attributes.distinguishedName?.[0];
        if (moved !== undefined) object.dn = moved;
        object.attributes = Object.fromEntries(
          Object.entries(op.attributes).filter(([key]) => key !== 'distinguishedName'),
        );
        return { ok: true, message: 'updated' };
      }
      case 'enable_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.enabled = true;
        return { ok: true, message: 'enabled' };
      }
      case 'disable_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.enabled = false;
        object.attributes = { ...object.attributes, info: [op.reason] };
        return { ok: true, message: 'disabled' };
      }
      case 'archive_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        object.archived = true;
        object.enabled = false;
        // Strips ONLY the entitlements it was handed -- the ones Provision
        // manages for this account. Clearing every membership would assert
        // that Provision manages every group in the target, which is never
        // true, and archive is the closest thing to destructive in the ladder.
        // The object, its attributes and any membership outside the remit are
        // left intact. It never deletes.
        const held = this.holdings.get(op.anchor);
        if (held) for (const dn of op.entitlementDns) held.delete(dn);
        return { ok: true, message: 'archived' };
      }
      case 'rename_account': {
        const object = this.objects.get(op.anchor);
        if (!object) return this.gone(op.anchor);
        const container = object.dn.slice(object.dn.indexOf(',') + 1);
        object.correlationKey = op.correlationKey;
        object.dn = `CN=${op.correlationKey},${container}`;
        return { ok: true, message: 'renamed' };
      }
      case 'grant_entitlement': {
        if (!this.objects.has(op.anchor)) return this.gone(op.anchor);
        // The caller passes the target's own identifier for the entitlement --
        // an objectGUID -- and the connector resolves it to the DN the
        // directory actually holds. An identifier the target does not offer is
        // not_found, which is what adTargetConnector answers when groupDnFor
        // comes back undefined.
        const dn = this.dnForEntitlement(op.entitlementId);
        if (dn === undefined) return this.noSuchEntitlement(op.entitlementId);
        const held = this.holdings.get(op.anchor) ?? new Set<string>();
        held.add(dn);
        this.holdings.set(op.anchor, held);
        return { ok: true, message: 'granted' };
      }
      case 'revoke_entitlement': {
        if (!this.objects.has(op.anchor)) return this.gone(op.anchor);
        const dn = this.dnForEntitlement(op.entitlementId);
        if (dn === undefined) return this.noSuchEntitlement(op.entitlementId);
        // A set operation: revoking an unheld entitlement is a success.
        this.holdings.get(op.anchor)?.delete(dn);
        return { ok: true, message: 'revoked' };
      }
    }
  }

  private gone(anchor: string): WriteResult {
    return { ok: false, message: `no object at ${anchor}`, failure: 'not_found' };
  }

  private noSuchEntitlement(externalId: string): WriteResult {
    return {
      ok: false,
      message: `no entitlement at ${externalId}`,
      failure: 'not_found',
    };
  }

  private nextAnchor(): string {
    this.counter += 1;
    return `fake-anchor-${String(this.counter).padStart(4, '0')}`;
  }
}
