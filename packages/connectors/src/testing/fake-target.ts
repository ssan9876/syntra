import {
  provenanceActionId,
  withProvenanceMarker,
  withProvenanceNote,
} from '../ad/provenance.js';
import { splitDn } from '../ldap/dn.js';
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
  /**
   * Where this target holds the provenance marker, as `adTargetConfigSchema`
   * calls it and with the same default.
   *
   * Optional so that every existing `{ domain }` still constructs, but it is
   * READ: a fake that only ever answers under `info` cannot exercise a
   * consumer that resolves the configured name, which is exactly the defect
   * such a consumer has.
   */
  provenanceAttribute?: string;
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
  /**
   * The whole value of the provenance attribute, exactly as a directory holds
   * it -- `syntra-provision action=<id>`, plus any `[syntra]` disable note and
   * anything an administrator wrote beside them. Null for an object Syntra
   * never made.
   *
   * The MARKER, not the bare action id. This used to store `op.actionId` on
   * its own, which no connector ever writes, so `provenanceActionId` answered
   * undefined for every object the fake created and only core's substring
   * match made the tests pass. Composed and read with the same pair the real
   * connector uses so the two cannot drift again.
   */
  provenance: string | null;
}

/** Where a create lands when the operation names no distinguished name. */
const DEFAULT_CONTAINER = 'OU=Users,DC=acme,DC=test';

/**
 * What stands in for the initial password in `calls`.
 *
 * A placeholder rather than a deleted key, so the recorded operation keeps
 * the shape a caller inspecting `calls` expects, and so a test searching the
 * recorded calls for the password it supplied finds nothing.
 */
const REDACTED = '[redacted by FakeTarget]';

/**
 * Correlation keys, folded.
 *
 * Active Directory compares `sAMAccountName` case-insensitively and refuses
 * `A.Novak` beside `a.novak`; PostgreSQL does not, which is why `apply.ts`
 * folds it on its side too. A fake that compares exactly creates the second
 * one happily, so a duplicate the real target would reject looks like an
 * ordinary create -- and the conflict path a create is supposed to take never
 * runs in any test that uses this. A fake stricter than the real thing hides
 * bugs; a fake looser than it invents them.
 */
const foldKey = (key: string): string => key.toLowerCase();

/** Whatever an attribute template asked to put in the provenance attribute. */
const templatedProvenance = (
  attributes: Record<string, string[]>,
  provenanceAttribute: string,
): string | undefined => {
  const values = Object.entries(attributes)
    .filter(([key]) => foldKey(key) === foldKey(provenanceAttribute))
    .flatMap(([, value]) => value);
  return values.length === 0 ? undefined : values.join('\n');
};

/** The provenance attribute this target holds, defaulted as the real one is. */
const provenanceAttributeOf = (config: FakeTargetConfig): string =>
  config.provenanceAttribute ?? 'info';

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

  async *read(config: FakeTargetConfig): AsyncIterable<SourceRecord> {
    if (this.returnsNothing) return;
    const provenanceAttribute = provenanceAttributeOf(config);
    for (const object of this.objects.values()) {
      yield {
        anchor: object.anchor,
        objectType: 'user',
        dn: object.dn,
        attributes: {
          // Any same-named key an attribute template left behind is dropped
          // first: a directory holds ONE value for this attribute, and the
          // marker was merged into `provenance` when the object was created.
          ...Object.fromEntries(
            Object.entries(object.attributes).filter(
              ([key]) => foldKey(key) !== foldKey(provenanceAttribute),
            ),
          ),
          sAMAccountName: [object.correlationKey],
          userAccountControl: [object.enabled ? '512' : '514'],
          // The CONFIGURED name, and the whole marker under it -- which is
          // what adTargetConnector writes. This answered under a hardcoded
          // `info`, so a consumer resolving the configured attribute could
          // never be exercised against it.
          [provenanceAttribute]: object.provenance ? [object.provenance] : [],
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
    config: FakeTargetConfig,
    op: WriteOperation,
  ): Promise<WriteResult> {
    // A COPY with the password taken out, not the operation object itself.
    //
    // `calls.push(op)` retained the whole operation, `initialPassword`
    // included, while the comment on `perform` claimed "nothing in `calls`'
    // stored copy that a later assertion could read back" -- and the test
    // pinning that claim looked only at `objects`, so the claim was never
    // checked. The fake exists partly to prove no initial password survives
    // into the action and audit rows; one that keeps a copy of it lets
    // exactly that leak pass unnoticed.
    this.calls.push(
      op.op === 'create_account' ? { ...op, initialPassword: REDACTED } : op,
    );
    const outcome = this.programmed.get(op.op);

    if (outcome?.loseResponseTimes) {
      outcome.loseResponseTimes -= 1;
      this.perform(op, provenanceAttributeOf(config));
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

    return this.perform(op, provenanceAttributeOf(config));
  }

  private perform(op: WriteOperation, provenanceAttribute: string): WriteResult {
    switch (op.op) {
      case 'create_container': {
        // Every branch the real connector has, so no branch of the caller
        // goes untested: conflict for a container already present, not_found
        // for a missing parent, and never the invention of that parent.
        const present = this.containers.some(
          (dn) => dn.toLowerCase() === op.dn.toLowerCase(),
        );
        if (present) {
          return {
            ok: false,
            message: `${op.dn} already exists`,
            failure: 'conflict',
          };
        }
        const separator = indexOfUnescapedComma(op.dn);
        const parent = separator === -1 ? '' : op.dn.slice(separator + 1);
        const parentPresent =
          parent !== '' &&
          this.containers.some((dn) => dn.toLowerCase() === parent.toLowerCase());
        if (!parentPresent) {
          return {
            ok: false,
            message: `the parent of ${op.dn} does not exist`,
            failure: 'not_found',
          };
        }
        this.containers.push(op.dn);
        return {
          ok: true,
          message: `created ${op.dn}`,
          anchor: this.nextAnchor(),
        };
      }

      case 'create_account': {
        const existing = [...this.objects.values()].find(
          (o) => foldKey(o.correlationKey) === foldKey(op.correlationKey),
        );
        if (existing) {
          // Present, carrying THIS actionId -- our own previous attempt
          // succeeded and we lost the answer. Adopt it.
          // Parsed out of the marker, never compared against the bare id and
          // never a substring test -- the same rule the real connector's
          // adopt path follows, through the same function.
          if (provenanceActionId(existing.provenance ?? '') === op.actionId) {
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
        // The password is used and not kept. Nothing on FakeObject, and
        // nothing in any WriteResult: a fake that retained it would let a leak
        // through the action and audit rows pass unnoticed. `calls` is the
        // third place it could hide, and `write` above redacts it there --
        // this comment used to claim that and `write` used to push the
        // operation object itself.
        this.objects.set(anchor, {
          anchor,
          correlationKey: op.correlationKey,
          dn:
            op.attributes.distinguishedName?.[0] ??
            `CN=${op.correlationKey},${this.containers[0] ?? DEFAULT_CONTAINER}`,
          attributes: Object.fromEntries(
            Object.entries(op.attributes).filter(
              ([key]) =>
                key !== 'distinguishedName' &&
                foldKey(key) !== foldKey(provenanceAttribute),
            ),
          ),
          enabled: op.enabled,
          archived: false,
          // `provenanceValue(op.actionId)` by way of `withProvenanceMarker`,
          // which is what adTargetConnector writes -- merged with whatever an
          // attribute template asked for in the same attribute, exactly as the
          // real one merges it, rather than either side winning.
          provenance: withProvenanceMarker(
            templatedProvenance(op.attributes, provenanceAttribute),
            op.actionId,
          ),
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
        // Merged into the provenance attribute, keeping the marker, because
        // that is what the real connector does. It used to `replace` a
        // hardcoded `info` with the reason alone -- which destroyed the
        // marker, and was F-A-2 on the real one. A fake that still destroys it
        // cannot show that the real one stopped.
        object.provenance = withProvenanceNote(object.provenance ?? undefined, op.reason);
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
        // `splitDn`, not `indexOf(',')`. `CN=Novak\, Anna,OU=Staff,...` is an
        // entirely ordinary account -- Provision correlates accounts
        // administrators created by hand -- and splitting at the ESCAPED
        // comma takes ` Anna,OU=Staff,...` as the container, so the rename
        // moves the object somewhere nobody chose. The real connector has
        // had this right since it merged.
        const { parent: container } = splitDn(object.dn);
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

/** The first comma that is not escaped, or -1. Mirrors `splitDn`. */
function indexOfUnescapedComma(dn: string): number {
  for (let index = 0; index < dn.length; index += 1) {
    if (dn[index] === '\\') {
      index += 1;
      continue;
    }
    if (dn[index] === ',') return index;
  }
  return -1;
}
