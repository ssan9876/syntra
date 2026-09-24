import { withTenant } from '@syntra/db';
import {
  CONNECTOR_CAPABILITIES,
  capabilitiesForTarget,
  capabilityRefusalReason,
  compareAdapterVersions,
  defaultConnectorReleaseCatalog,
  isConnectorCapability,
  releaseIsCertified,
  releasePastDeprecation,
  releaseReadinessWarnings,
  resolveAdapterRelease,
  type ConnectorAdapterRelease,
  type ConnectorCapabilities,
  type ConnectorReleaseCatalog,
  type ResolvedAdapterRelease,
} from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';

/**
 * Capability enforcement and certification-aware rollout (backlog 18, 33).
 *
 * Three controls share one idea: the only writes Syntra makes to a target are
 * writes the exact adapter release running it was CERTIFIED to make, that the
 * target's own configuration ADVERTISES, and that the release is still
 * allowed to make on this date.
 *
 * - **Capability enforcement.** Every planned connector action is checked
 *   against both. A refused action is written into the plan with status
 *   `refused` and the reason, so the preview shows it rather than silently
 *   dropping it, and the apply never attempts it. The rest of the run is
 *   unaffected: one uncertified capability must not hold up a leaver's
 *   disable.
 * - **Rollout.** A target runs the catalog's stable release unless an
 *   administrator moved it to the canary channel or pinned an exact version.
 *   A rollback returns it to the last certified release it ran. Neither
 *   touches configuration, profile, rules, placements or accounts -- the
 *   stored intent -- only which certified code executes that intent.
 * - **Deprecation.** A deprecated or uncertified release is a readiness
 *   warning. From its deprecation date, new writes stop unless an audited,
 *   version-bound override of at most 30 days is active.
 */

export class AdapterRolloutNotFoundError extends Error {}
export class AdapterSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterSelectionError';
  }
}

/** Past its deprecation date with no override: nothing is written. */
export class AdapterWritesBlockedError extends Error {
  constructor(
    readonly targetSystemId: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'AdapterWritesBlockedError';
  }
}

/**
 * The plan was computed for one adapter release and the target now runs
 * another -- a canary promotion or a rollback happened between preview and
 * apply. The capability checks the preview made are about the old release,
 * so the plan is refused rather than executed by code it was not checked
 * against.
 */
export class AdapterVersionChangedError extends Error {
  constructor(
    readonly runId: string,
    readonly plannedVersion: string,
    readonly currentVersion: string,
  ) {
    super(
      `run ${runId} was planned for adapter ${plannedVersion}, but the target now runs ${currentVersion}; preview a new run`,
    );
    this.name = 'AdapterVersionChangedError';
  }
}

export const MAX_DEPRECATION_OVERRIDE_MS = 30 * 86_400_000;

export interface AdapterTargetFacts {
  id: string;
  type: string;
  config: unknown;
  adapterChannel: string;
  adapterVersionPin: string | null;
  deprecationOverrideVersion: string | null;
  deprecationOverrideReason: string | null;
  deprecationOverrideExpiresAt: Date | null;
}

export interface AdapterContextOptions {
  catalog?: ConnectorReleaseCatalog;
  now?: Date;
}

export interface AdapterWriteContext {
  type: string;
  resolved: ResolvedAdapterRelease;
  release: ConnectorAdapterRelease;
  advertised: ConnectorCapabilities;
  pastDeprecation: boolean;
  overrideActive: boolean;
  /** Non-null when no write may be made at all; the operator-readable reason. */
  writesBlockedReason: string | null;
  warnings: string[];
  /** Why this action type may not be written, or null when it may. */
  refusalFor(actionType: string): string | null;
}

export function deprecationOverrideActive(
  target: Pick<AdapterTargetFacts, 'deprecationOverrideVersion' | 'deprecationOverrideExpiresAt'>,
  adapterVersion: string,
  now: Date,
): boolean {
  return (
    target.deprecationOverrideVersion === adapterVersion &&
    target.deprecationOverrideExpiresAt !== null &&
    target.deprecationOverrideExpiresAt.getTime() > now.getTime()
  );
}

/**
 * Everything the engine needs to decide whether a write may be made through
 * this target's adapter, computed once per preview or apply.
 *
 * Throws `AdapterReleaseNotFoundError` for a pin this build does not hold:
 * a run cannot be planned against an adapter nobody can run.
 */
export function adapterWriteContext(
  target: AdapterTargetFacts,
  options: AdapterContextOptions = {},
): AdapterWriteContext {
  const now = options.now ?? new Date();
  const resolved = resolveAdapterRelease(
    target.type,
    { adapterChannel: target.adapterChannel, adapterVersionPin: target.adapterVersionPin },
    options.catalog ?? defaultConnectorReleaseCatalog,
  );
  const release = resolved.release;
  const advertised = capabilitiesForTarget(target.type, target.config);
  const pastDeprecation = releasePastDeprecation(release, now);
  const overrideActive = deprecationOverrideActive(target, release.adapterVersion, now);
  const writesBlockedReason =
    pastDeprecation && !overrideActive
      ? `${target.type} adapter ${release.adapterVersion} passed its deprecation date (${release.deprecationDate}); new writes are blocked until the target moves to a supported release or an administrator records a time-bounded override`
      : null;
  const warnings = releaseReadinessWarnings(target.type, release, now);
  if (pastDeprecation && overrideActive) {
    warnings.push(
      `writes continue under a deprecation override until ${target.deprecationOverrideExpiresAt!.toISOString()}: ${target.deprecationOverrideReason ?? ''}`,
    );
  }
  return {
    type: target.type,
    resolved,
    release,
    advertised,
    pastDeprecation,
    overrideActive,
    writesBlockedReason,
    warnings,
    refusalFor(actionType: string) {
      // The Syntra-only actions touch no connector and are never refused.
      if (!isConnectorCapability(actionType)) return null;
      return capabilityRefusalReason(target.type, release, advertised, actionType);
    },
  };
}

/**
 * The one-line summary written onto a run: each distinct reason with how many
 * actions it refused, most frequent first.
 */
export function summariseRefusals(refusals: readonly string[]): string | null {
  if (refusals.length === 0) return null;
  const counts = new Map<string, number>();
  for (const reason of refusals) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} action${count === 1 ? '' : 's'} ${reason}`)
    .join('; ');
}

const TARGET_SELECT = {
  id: true,
  type: true,
  config: true,
  adapterChannel: true,
  adapterVersionPin: true,
  adapterRollbackVersion: true,
  adapterSelectionChangedAt: true,
  adapterSelectionChangedByUserId: true,
  adapterSelectionReason: true,
  deprecationOverrideVersion: true,
  deprecationOverrideReason: true,
  deprecationOverrideAt: true,
  deprecationOverrideExpiresAt: true,
  deprecationOverrideByUserId: true,
} as const;

/** The target's adapter state, as the console and the API present it. */
export async function targetAdapterReport(
  tenantId: string,
  targetSystemId: string,
  options: AdapterContextOptions = {},
) {
  const now = options.now ?? new Date();
  const catalog = options.catalog ?? defaultConnectorReleaseCatalog;
  const target = await withTenant(tenantId, (tx) =>
    tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: TARGET_SELECT }),
  );
  if (!target) throw new AdapterRolloutNotFoundError('Target not found');
  const metadata = catalog(target.type);
  let context: AdapterWriteContext | null = null;
  let resolutionError: string | null = null;
  try {
    context = adapterWriteContext(target, { catalog, now });
  } catch (cause) {
    resolutionError = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    targetId: target.id,
    type: target.type,
    selection: {
      channel: target.adapterChannel,
      pinnedVersion: target.adapterVersionPin,
      rollbackVersion: target.adapterRollbackVersion,
      changedAt: target.adapterSelectionChangedAt,
      changedByUserId: target.adapterSelectionChangedByUserId,
      reason: target.adapterSelectionReason,
    },
    effective: context
      ? { source: context.resolved.source, release: context.release }
      : null,
    resolutionError,
    releases: metadata.releases,
    capabilities: context
      ? CONNECTOR_CAPABILITIES.map((capability) => ({
          capability,
          certified:
            releaseIsCertified(context.release) &&
            context.release.certification.capabilities.includes(capability),
          refusal: context.refusalFor(capability),
        }))
      : [],
    warnings: context ? context.warnings : resolutionError ? [resolutionError] : [],
    writesBlockedReason: context ? context.writesBlockedReason : resolutionError,
    deprecationOverride:
      target.deprecationOverrideVersion === null
        ? null
        : {
            version: target.deprecationOverrideVersion,
            reason: target.deprecationOverrideReason,
            grantedAt: target.deprecationOverrideAt,
            expiresAt: target.deprecationOverrideExpiresAt,
            grantedByUserId: target.deprecationOverrideByUserId,
            active:
              target.deprecationOverrideExpiresAt !== null &&
              target.deprecationOverrideExpiresAt.getTime() > now.getTime(),
          },
  };
}

/**
 * Only a release with certification evidence may be selected. A release that
 * failed or never ran certification would refuse every write anyway; letting
 * an operator choose it anyway would move a target onto an adapter that does
 * nothing, which reads as a broken target rather than a refused choice.
 */
function assertSelectable(type: string, release: ConnectorAdapterRelease) {
  if (release.supportState === 'unavailable' || release.rollout === 'disabled') {
    throw new AdapterSelectionError(`${type} adapter ${release.adapterVersion} is not available for rollout`);
  }
  if (!releaseIsCertified(release)) {
    throw new AdapterSelectionError(
      `${type} adapter ${release.adapterVersion} has no passing certification (${release.certification.status}) and cannot be selected`,
    );
  }
}

export interface AdapterSelectionInput {
  channel: 'stable' | 'canary';
  /** An exact release, or null to follow the channel. */
  version: string | null;
  reason: string;
}

/**
 * Move a target between channels, or pin it to an exact release.
 *
 * Writes ONLY the selection columns. When the effective release changes, the
 * one it is leaving becomes the rollback point -- provided that one was
 * certified, since a rollback exists to return to something known good.
 */
export async function setTargetAdapterSelection(
  tenantId: string,
  actorUserId: string | null,
  targetSystemId: string,
  input: AdapterSelectionInput,
  options: AdapterContextOptions = {},
) {
  const now = options.now ?? new Date();
  const catalog = options.catalog ?? defaultConnectorReleaseCatalog;
  const reason = input.reason.trim();
  if (reason.length < 10) throw new AdapterSelectionError('A reason of at least 10 characters is required');
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: TARGET_SELECT });
    if (!target) throw new AdapterRolloutNotFoundError('Target not found');

    const metadata = catalog(target.type);
    const next = { adapterChannel: input.channel, adapterVersionPin: input.version };
    let after: ResolvedAdapterRelease;
    try {
      after = resolveAdapterRelease(target.type, next, catalog);
    } catch (cause) {
      throw new AdapterSelectionError(cause instanceof Error ? cause.message : String(cause));
    }
    assertSelectable(target.type, after.release);

    let before: ResolvedAdapterRelease | null = null;
    try {
      before = resolveAdapterRelease(target.type, target, catalog);
    } catch {
      // The old pin no longer resolves: there is nothing to roll back to.
    }
    const changed = before === null || before.release.adapterVersion !== after.release.adapterVersion;
    const rollbackVersion =
      changed && before !== null && releaseIsCertified(before.release)
        ? before.release.adapterVersion
        : target.adapterRollbackVersion;

    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        adapterChannel: input.channel,
        adapterVersionPin: input.version,
        adapterRollbackVersion: rollbackVersion,
        adapterSelectionChangedAt: now,
        adapterSelectionChangedByUserId: actorUserId,
        adapterSelectionReason: reason,
      },
      select: TARGET_SELECT,
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.adapter.select',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        reason,
        channel: input.channel,
        pinnedVersion: input.version,
        fromVersion: before?.release.adapterVersion ?? null,
        toVersion: after.release.adapterVersion,
        rollbackVersion,
        newestAvailable:
          [...metadata.releases].sort((a, b) => compareAdapterVersions(b.adapterVersion, a.adapterVersion))[0]
            ?.adapterVersion ?? null,
      },
    });
    return updated;
  });
}

/**
 * Return a target to the last certified release it ran, immediately.
 *
 * Implemented as a PIN to that release on the stable channel, so the next
 * canary published to the catalog does not silently undo the rollback. Only
 * selection columns are written; configuration, profile, rules and accounts
 * are untouched, which is what makes a rollback safe to press mid-incident.
 */
export async function rollbackTargetAdapter(
  tenantId: string,
  actorUserId: string | null,
  targetSystemId: string,
  reasonInput: string,
  options: AdapterContextOptions = {},
) {
  const now = options.now ?? new Date();
  const catalog = options.catalog ?? defaultConnectorReleaseCatalog;
  const reason = reasonInput.trim();
  if (reason.length < 10) throw new AdapterSelectionError('A reason of at least 10 characters is required');
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: TARGET_SELECT });
    if (!target) throw new AdapterRolloutNotFoundError('Target not found');
    const rollbackVersion = target.adapterRollbackVersion;
    if (rollbackVersion === null) {
      throw new AdapterSelectionError('This target has no previous certified adapter release to roll back to');
    }
    const release = catalog(target.type).releases.find((r) => r.adapterVersion === rollbackVersion);
    if (!release) {
      throw new AdapterSelectionError(`${target.type} adapter ${rollbackVersion} is no longer in this build's catalog`);
    }
    assertSelectable(target.type, release);
    let from: string | null;
    try {
      from = resolveAdapterRelease(target.type, target, catalog).release.adapterVersion;
    } catch {
      from = target.adapterVersionPin;
    }
    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        adapterChannel: 'stable',
        adapterVersionPin: rollbackVersion,
        // Spent. Rolling "back" again would return to the release that was
        // just abandoned; moving forward is a deliberate new selection.
        adapterRollbackVersion: null,
        adapterSelectionChangedAt: now,
        adapterSelectionChangedByUserId: actorUserId,
        adapterSelectionReason: reason,
      },
      select: TARGET_SELECT,
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.adapter.rollback',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason, fromVersion: from, toVersion: rollbackVersion },
    });
    return updated;
  });
}

/**
 * Let one deprecated release keep writing to one target for a bounded time.
 *
 * Bound to the release the target runs NOW: an override granted for 1.0.0
 * says nothing about the next deprecated release. Refused when the release
 * is not deprecated, when the expiry is not in the future, and when it is
 * more than 30 days away; the database enforces the last one again.
 */
export async function grantDeprecationOverride(
  tenantId: string,
  actorUserId: string,
  targetSystemId: string,
  input: { reason: string; expiresAt: Date },
  options: AdapterContextOptions = {},
) {
  const now = options.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length < 10) throw new AdapterSelectionError('A reason of at least 10 characters is required');
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new AdapterSelectionError('The override must expire in the future');
  }
  if (input.expiresAt.getTime() - now.getTime() > MAX_DEPRECATION_OVERRIDE_MS) {
    throw new AdapterSelectionError('A deprecation override may last at most 30 days');
  }
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: TARGET_SELECT });
    if (!target) throw new AdapterRolloutNotFoundError('Target not found');
    let context: AdapterWriteContext;
    try {
      context = adapterWriteContext(target, { ...options, now });
    } catch (cause) {
      throw new AdapterSelectionError(cause instanceof Error ? cause.message : String(cause));
    }
    if (context.release.deprecationDate === null) {
      throw new AdapterSelectionError(
        `${target.type} adapter ${context.release.adapterVersion} is not deprecated; there is nothing to override`,
      );
    }
    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        deprecationOverrideVersion: context.release.adapterVersion,
        deprecationOverrideReason: reason,
        deprecationOverrideAt: now,
        deprecationOverrideExpiresAt: input.expiresAt,
        deprecationOverrideByUserId: actorUserId,
      },
      select: TARGET_SELECT,
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.adapter.deprecation_override.grant',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        reason,
        adapterVersion: context.release.adapterVersion,
        deprecationDate: context.release.deprecationDate,
        expiresAt: input.expiresAt.toISOString(),
      },
    });
    return updated;
  });
}

export async function clearDeprecationOverride(
  tenantId: string,
  actorUserId: string,
  targetSystemId: string,
  reasonInput: string,
) {
  const reason = reasonInput.trim();
  if (reason.length < 10) throw new AdapterSelectionError('A reason of at least 10 characters is required');
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: TARGET_SELECT });
    if (!target) throw new AdapterRolloutNotFoundError('Target not found');
    if (target.deprecationOverrideVersion === null) {
      throw new AdapterSelectionError('This target has no deprecation override');
    }
    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        deprecationOverrideVersion: null,
        deprecationOverrideReason: null,
        deprecationOverrideAt: null,
        deprecationOverrideExpiresAt: null,
        deprecationOverrideByUserId: null,
      },
      select: TARGET_SELECT,
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.adapter.deprecation_override.clear',
      targetType: 'TargetSystem',
      targetId: targetSystemId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        reason,
        adapterVersion: target.deprecationOverrideVersion,
        expiresAt: target.deprecationOverrideExpiresAt?.toISOString() ?? null,
      },
    });
    return updated;
  });
}
