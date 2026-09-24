import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import {
  forgetAccessTokens,
  forgetEntraTokens,
  ldapConfigSchema,
  ldapConnector,
  personSourceConnectorFor,
} from '@syntra/connectors';
import { recordEvent, stableStringify } from '../audit/audit-service.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { testTargetConfiguration } from '../provision/target-service.js';
import { recordReadinessCheck } from '../lifecycle/management.js';
import { credentialKey, type CredentialKind, type RotatableSystemKind } from './inventory.js';

/**
 * The dual-secret rotation of a connector credential (backlog #34).
 *
 * The problem with replacing a credential in place -- the `PATCH` every
 * connector screen offers -- is that the only test of the new secret is the
 * next run, and the old secret is gone by then. This workflow keeps both:
 *
 *  1. **Stage.** The new secret is sealed in the vault beside the live one.
 *     Nothing uses it. The administrator has already created it at the
 *     issuer (Entra, the directory, the SFTP server) WITHOUT deleting the
 *     old one -- that is the overlap, and the console says so.
 *  2. **Verify.** The staged secret is tried against the SAVED configuration
 *     with the connector's own connection test. Pass or fail, the result is
 *     evidence on the rotation.
 *  3. **Cut over.** Only from a passed verification, of the configuration as
 *     it is now, within a day. The live secret is moved aside (sealed, still
 *     recoverable) and the staged one takes its vault entry, in one
 *     transaction. Cached access tokens are dropped.
 *  4. **Complete.** The now-live secret is tested once more; only if that
 *     passes is the old one erased. The administrator then revokes it at the
 *     issuer. Or **roll back**: the old secret returns, the new one is erased.
 *
 * Every step is audited (a security event in the Credentials group) and
 * appended to the rotation's evidence. Evidence never holds a secret, a
 * digest of one, or a vault name.
 */

export type RotationStatus =
  | 'staged'
  | 'verified'
  | 'verification_failed'
  | 'cut_over'
  | 'completed'
  | 'rolled_back'
  | 'cancelled';

export const OPEN_ROTATION_STATUSES: readonly RotationStatus[] = ['staged', 'verified', 'verification_failed', 'cut_over'];

/** A verification older than this no longer licenses a cut-over. */
export const ROTATION_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export type RotationRefusal =
  | 'not_found'
  | 'system_not_found'
  | 'no_credential'
  | 'already_open'
  | 'state'
  | 'not_verified'
  | 'verification_stale'
  | 'configuration_changed'
  | 'check_failed';

export class RotationRefusedError extends Error {
  constructor(
    readonly code: RotationRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RotationRefusedError';
  }
}

export interface RotationSystem {
  kind: RotatableSystemKind;
  id: string;
  name: string;
  /** Connector type: `entraId`, `ldap`, `sftp`, ... */
  type: string;
  config: unknown;
  secretName: string;
}

export interface RotationCheck {
  ok: boolean;
  message: string;
}

/** Tries a secret against a system's saved configuration. Opens a socket. */
export type RotationTester = (system: RotationSystem, secret: string) => Promise<RotationCheck>;

export interface RotationOptions {
  now?: Date;
  /** Replaces the connector test. Tests only. */
  tester?: RotationTester;
}

const KIND_FOR: Record<RotatableSystemKind, CredentialKind> = {
  target: 'target_secret',
  source: 'source_secret',
  person_source: 'person_source_secret',
};

function fingerprint(config: unknown): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex');
}

const clip = (message: string) => (message.length > 500 ? `${message.slice(0, 497)}...` : message);

function stagedName(id: string): string {
  return `credential-rotation.${id}.staged`;
}
function previousName(id: string): string {
  return `credential-rotation.${id}.previous`;
}

async function loadSystem(tx: TenantClient, kind: RotatableSystemKind, id: string): Promise<RotationSystem | null> {
  if (kind === 'target') {
    const t = await tx.targetSystem.findUnique({ where: { id }, select: { id: true, name: true, type: true, config: true, secretName: true } });
    return t ? { kind, id: t.id, name: t.name, type: t.type, config: t.config, secretName: t.secretName } : null;
  }
  if (kind === 'source') {
    const s = await tx.directorySource.findUnique({ where: { id }, select: { id: true, name: true, type: true, config: true, secretName: true } });
    return s ? { kind, id: s.id, name: s.name, type: s.type, config: s.config, secretName: s.secretName } : null;
  }
  const p = await tx.personSource.findUnique({ where: { id }, select: { id: true, name: true, type: true, config: true, secretName: true } });
  return p ? { kind, id: p.id, name: p.name, type: p.type, config: p.config, secretName: p.secretName } : null;
}

/** The connector's own connection test, with the given secret in place of the saved one. */
export function connectorTester(tenantId: string, provider: MasterKeyProvider): RotationTester {
  return async (system, secret) => {
    try {
      if (system.kind === 'target') {
        const result = await testTargetConfiguration(tenantId, provider, {
          type: system.type,
          config: system.config,
          bindPassword: secret,
        });
        return { ok: result.ok, message: result.message };
      }
      if (system.kind === 'source') {
        const result = await ldapConnector.test({ ...ldapConfigSchema.parse(system.config), bindPassword: secret });
        return { ok: result.ok, message: result.message };
      }
      // The same split `personSourceWithCredential` makes: a PEM private key
      // or a password, sharing one vault entry.
      const isKey = secret.includes('BEGIN') && secret.includes('PRIVATE KEY');
      const result = await personSourceConnectorFor(system.type).test({
        ...(system.config as Record<string, unknown>),
        ...(isKey ? { privateKey: secret } : { password: secret }),
      } as never);
      return { ok: result.ok, message: result.message };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  };
}

type Evidence = Record<string, unknown>[];

/** `never` for the same reason `DataExport.params` is cast: Prisma's JSON input type. */
function appendEvidence(existing: unknown, entry: Record<string, unknown>): never {
  return [...(Array.isArray(existing) ? (existing as Evidence) : []), entry] as never;
}

export interface RotationView {
  id: string;
  systemKind: string;
  systemId: string;
  credentialKey: string;
  status: string;
  reason: string | null;
  newExpiresAt: string | null;
  stagedByUserId: string | null;
  stagedAt: string;
  verifiedAt: string | null;
  verificationOk: boolean | null;
  verificationMessage: string | null;
  cutOverAt: string | null;
  cutOverByUserId: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  /** Whether the previous secret is still held for rollback. */
  overlapActive: boolean;
  evidence: Evidence;
}

type RotationRow = Awaited<ReturnType<TenantClient['credentialRotation']['findUniqueOrThrow']>>;

/** What a client may read. Never the vault names. */
export function rotationView(row: RotationRow): RotationView {
  return {
    id: row.id,
    systemKind: row.systemKind,
    systemId: row.systemId,
    credentialKey: row.credentialKey,
    status: row.status,
    reason: row.reason,
    newExpiresAt: row.newExpiresAt?.toISOString() ?? null,
    stagedByUserId: row.stagedByUserId,
    stagedAt: row.stagedAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verificationOk: row.verificationOk,
    verificationMessage: row.verificationMessage,
    cutOverAt: row.cutOverAt?.toISOString() ?? null,
    cutOverByUserId: row.cutOverByUserId,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedByUserId: row.completedByUserId,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedByUserId: row.closedByUserId,
    overlapActive: row.status === 'cut_over',
    evidence: Array.isArray(row.evidence) ? (row.evidence as Evidence) : [],
  };
}

async function audit(
  tx: TenantClient,
  action: string,
  actorUserId: string | null,
  row: { id: string; systemKind: string; systemId: string; credentialKey: string },
  outcome: 'success' | 'failure',
  extra: Record<string, unknown> = {},
) {
  await recordEvent(tx, {
    actorUserId,
    action,
    targetType: 'CredentialRotation',
    targetId: row.id,
    outcome,
    sourceIp: null,
    payload: { systemKind: row.systemKind, systemId: row.systemId, credentialKey: row.credentialKey, ...extra },
  });
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'P2002';
}

export interface StageRotationInput {
  systemKind: RotatableSystemKind;
  systemId: string;
  secret: string;
  newExpiresAt?: Date | null | undefined;
  reason?: string | null | undefined;
}

export async function stageRotation(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  input: StageRotationInput,
  options: RotationOptions = {},
): Promise<RotationView> {
  const now = options.now ?? new Date();
  if (input.secret.length === 0) throw new RotationRefusedError('no_credential', 'the new secret is empty');
  try {
    return await withTenant(tenantId, async (tx) => {
      const system = await loadSystem(tx, input.systemKind, input.systemId);
      if (!system) throw new RotationRefusedError('system_not_found', 'no such system');
      if (system.secretName === '') {
        throw new RotationRefusedError('no_credential', 'this system holds no credential of its own to rotate');
      }
      const key = credentialKey(KIND_FOR[input.systemKind], input.systemId);
      const row = await tx.credentialRotation.create({
        data: {
          tenantId,
          systemKind: input.systemKind,
          systemId: input.systemId,
          credentialKey: key,
          status: 'staged',
          reason: input.reason ?? null,
          newExpiresAt: input.newExpiresAt ?? null,
          stagedByUserId: actorUserId,
          stagedAt: now,
          evidence: [{ step: 'staged', at: now.toISOString(), actorUserId, systemName: system.name }],
        },
      });
      await putSecret(tx, provider, stagedName(row.id), input.secret);
      const updated = await tx.credentialRotation.update({
        where: { id: row.id },
        data: { stagedSecretName: stagedName(row.id) },
      });
      await audit(tx, 'credential.rotation_staged', actorUserId, updated, 'success', {
        newExpiresAt: input.newExpiresAt?.toISOString() ?? null,
      });
      return rotationView(updated);
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new RotationRefusedError(
        'already_open',
        'a rotation of this credential is already open; complete, roll back or cancel it first',
      );
    }
    throw cause;
  }
}

async function openRow(tx: TenantClient, id: string, allowed: readonly RotationStatus[]) {
  const row = await tx.credentialRotation.findUnique({ where: { id } });
  if (!row) throw new RotationRefusedError('not_found', 'no such rotation');
  if (!(allowed as readonly string[]).includes(row.status)) {
    throw new RotationRefusedError('state', `this rotation is ${row.status.replace(/_/g, ' ')}`);
  }
  return row;
}

/** Tries the staged secret against the saved configuration. */
export async function verifyRotation(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  id: string,
  options: RotationOptions = {},
): Promise<RotationView> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['staged', 'verified', 'verification_failed']);
    const system = await loadSystem(tx, row.systemKind as RotatableSystemKind, row.systemId);
    if (!system) throw new RotationRefusedError('system_not_found', 'the system this rotation belongs to no longer exists');
    const secret = row.stagedSecretName ? await getSecret(tx, provider, row.stagedSecretName) : null;
    if (secret === null) throw new RotationRefusedError('no_credential', 'the staged secret is missing');
    return { row, system, secret };
  });

  // Outside any transaction: this opens a socket to a third party.
  const tester = options.tester ?? connectorTester(tenantId, provider);
  const started = Date.now();
  const check = await tester(prepared.system, prepared.secret);
  const latencyMs = Date.now() - started;
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    // Re-read: a cancel may have landed while the test ran.
    const row = await openRow(tx, id, ['staged', 'verified', 'verification_failed']);
    const updated = await tx.credentialRotation.update({
      where: { id },
      data: {
        status: check.ok ? 'verified' : 'verification_failed',
        verifiedAt: now,
        verifiedByUserId: actorUserId,
        verificationOk: check.ok,
        verificationMessage: clip(check.message),
        verificationFingerprint: fingerprint(prepared.system.config),
        evidence: appendEvidence(row.evidence, {
          step: 'verified',
          at: now.toISOString(),
          actorUserId,
          ok: check.ok,
          message: clip(check.message),
          latencyMs,
          configurationFingerprint: fingerprint(prepared.system.config),
        }),
      },
    });
    await audit(tx, 'credential.rotation_verified', actorUserId, updated, check.ok ? 'success' : 'failure', {
      message: clip(check.message),
    });
    return rotationView(updated);
  });
}

/**
 * Makes the staged secret the live one and keeps the old one aside.
 *
 * Refused unless the last verification passed, is less than a day old, and
 * was made against the configuration as it is saved NOW -- a URL or tenant
 * changed since the test means the test proved nothing about this cut-over.
 */
export async function cutOverRotation(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  id: string,
  options: RotationOptions = {},
): Promise<RotationView> {
  const now = options.now ?? new Date();
  const view = await withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['staged', 'verified', 'verification_failed']);
    if (row.status !== 'verified' || row.verificationOk !== true || row.verifiedAt === null) {
      throw new RotationRefusedError('not_verified', 'the staged secret has not passed a connection test');
    }
    if (now.getTime() - row.verifiedAt.getTime() > ROTATION_VERIFICATION_TTL_MS) {
      throw new RotationRefusedError('verification_stale', 'the connection test is more than a day old; test again');
    }
    const system = await loadSystem(tx, row.systemKind as RotatableSystemKind, row.systemId);
    if (!system) throw new RotationRefusedError('system_not_found', 'the system this rotation belongs to no longer exists');
    if (fingerprint(system.config) !== row.verificationFingerprint) {
      throw new RotationRefusedError(
        'configuration_changed',
        'the connection settings changed after the test; test the staged secret again',
      );
    }
    const staged = row.stagedSecretName ? await getSecret(tx, provider, row.stagedSecretName) : null;
    const current = await getSecret(tx, provider, system.secretName);
    if (staged === null) throw new RotationRefusedError('no_credential', 'the staged secret is missing');

    // The overlap: the live secret is kept, sealed, until completion or
    // rollback. A system with no live secret (never set) has nothing to keep.
    if (current !== null) await putSecret(tx, provider, previousName(row.id), current);
    await putSecret(tx, provider, system.secretName, staged);
    if (row.stagedSecretName) await deleteSecret(tx, row.stagedSecretName);

    const updated = await tx.credentialRotation.update({
      where: { id },
      data: {
        status: 'cut_over',
        stagedSecretName: null,
        previousSecretName: current !== null ? previousName(row.id) : null,
        cutOverAt: now,
        cutOverByUserId: actorUserId,
        evidence: appendEvidence(row.evidence, {
          step: 'cut_over',
          at: now.toISOString(),
          actorUserId,
          previousRetained: current !== null,
        }),
      },
    });

    // The inventory's view of this credential starts again: a new declared
    // expiry if one was given, and no stale discovery or alert state carried
    // over from the secret that is no longer live.
    await tx.credentialRecord.upsert({
      where: { tenantId_credentialKey: { tenantId, credentialKey: row.credentialKey } },
      create: {
        tenantId,
        credentialKey: row.credentialKey,
        kind: KIND_FOR[row.systemKind as RotatableSystemKind],
        declaredExpiresAt: row.newExpiresAt,
        effectiveExpiresAt: row.newExpiresAt,
      },
      update: {
        ...(row.newExpiresAt ? { declaredExpiresAt: row.newExpiresAt } : {}),
        discoveryStatus: null,
        discoveryMessage: null,
        discoveredExpiresAt: null,
        discoveredAt: null,
        effectiveExpiresAt: row.newExpiresAt,
        alertedExpiresAt: null,
        alertedThresholdDays: null,
        alertedAt: null,
      },
    });
    await audit(tx, 'credential.rotation_cut_over', actorUserId, updated, 'success');
    return rotationView(updated);
  });

  // After the commit, as `updateTarget` does: a run holding a token minted by
  // the old secret must not keep using it for the rest of its hour.
  forgetAccessTokens();
  forgetEntraTokens();
  return view;
}

/**
 * Tests the live (new) secret once more and, only if it passes, erases the
 * old one. A failure is recorded and refused; the overlap stays open, so a
 * rollback is still possible.
 */
export async function completeRotation(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  id: string,
  options: RotationOptions = {},
): Promise<RotationView> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['cut_over']);
    const system = await loadSystem(tx, row.systemKind as RotatableSystemKind, row.systemId);
    if (!system) throw new RotationRefusedError('system_not_found', 'the system this rotation belongs to no longer exists');
    const secret = await getSecret(tx, provider, system.secretName);
    if (secret === null) throw new RotationRefusedError('no_credential', 'the live secret is missing');
    return { system, secret };
  });

  const tester = options.tester ?? connectorTester(tenantId, provider);
  const started = Date.now();
  const check = await tester(prepared.system, prepared.secret);
  const latencyMs = Date.now() - started;
  const now = options.now ?? new Date();

  // Durable readiness evidence for the configuration as it now stands, with
  // the credential that is now live -- the same history a credential change
  // made through the connector screen leaves behind.
  if (prepared.system.kind !== 'person_source') {
    await recordReadinessCheck(tenantId, {
      systemKind: prepared.system.kind,
      systemId: prepared.system.id,
      configuration: prepared.system.config,
      capabilities: [],
      status: check.ok ? 'passed' : 'failed',
      latencyMs,
      message: clip(`credential rotation ${check.ok ? 'completed' : 'post-cut-over check'}: ${check.message}`),
      ...(actorUserId ? { actorUserId } : {}),
    });
  }

  return withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['cut_over']);
    if (!check.ok) {
      const updated = await tx.credentialRotation.update({
        where: { id },
        data: {
          evidence: appendEvidence(row.evidence, {
            step: 'post_cut_over_check',
            at: now.toISOString(),
            actorUserId,
            ok: false,
            message: clip(check.message),
            latencyMs,
          }),
        },
      });
      await audit(tx, 'credential.rotation_completed', actorUserId, updated, 'failure', { message: clip(check.message) });
      return { refused: true as const, view: rotationView(updated), message: check.message };
    }
    if (row.previousSecretName) await deleteSecret(tx, row.previousSecretName);
    const updated = await tx.credentialRotation.update({
      where: { id },
      data: {
        status: 'completed',
        previousSecretName: null,
        completedAt: now,
        completedByUserId: actorUserId,
        evidence: appendEvidence(row.evidence, {
          step: 'completed',
          at: now.toISOString(),
          actorUserId,
          ok: true,
          message: clip(check.message),
          latencyMs,
          previousErased: true,
        }),
      },
    });
    await audit(tx, 'credential.rotation_completed', actorUserId, updated, 'success');
    return { refused: false as const, view: rotationView(updated), message: check.message };
  }).then((result) => {
    if (result.refused) {
      throw new RotationRefusedError(
        'check_failed',
        `the live secret failed its check, so the previous one was kept for rollback: ${result.message}`,
      );
    }
    return result.view;
  });
}

/** Puts the previous secret back and erases the new one. */
export async function rollbackRotation(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  id: string,
  options: RotationOptions = {},
): Promise<RotationView> {
  const now = options.now ?? new Date();
  const view = await withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['cut_over']);
    const system = await loadSystem(tx, row.systemKind as RotatableSystemKind, row.systemId);
    if (!system) throw new RotationRefusedError('system_not_found', 'the system this rotation belongs to no longer exists');
    const previous = row.previousSecretName ? await getSecret(tx, provider, row.previousSecretName) : null;
    if (previous === null) {
      throw new RotationRefusedError('no_credential', 'no previous secret was kept, so there is nothing to roll back to');
    }
    await putSecret(tx, provider, system.secretName, previous);
    await deleteSecret(tx, row.previousSecretName!);
    const updated = await tx.credentialRotation.update({
      where: { id },
      data: {
        status: 'rolled_back',
        previousSecretName: null,
        closedAt: now,
        closedByUserId: actorUserId,
        evidence: appendEvidence(row.evidence, { step: 'rolled_back', at: now.toISOString(), actorUserId }),
      },
    });
    await tx.credentialRecord.updateMany({
      where: { credentialKey: row.credentialKey },
      data: { discoveryStatus: null, discoveryMessage: null, discoveredExpiresAt: null, discoveredAt: null, alertedExpiresAt: null, alertedThresholdDays: null },
    });
    await audit(tx, 'credential.rotation_rolled_back', actorUserId, updated, 'success');
    return rotationView(updated);
  });
  forgetAccessTokens();
  forgetEntraTokens();
  return view;
}

/** Abandons a rotation before cut-over and erases the staged secret. */
export async function cancelRotation(
  tenantId: string,
  actorUserId: string | null,
  id: string,
  options: RotationOptions = {},
): Promise<RotationView> {
  const now = options.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const row = await openRow(tx, id, ['staged', 'verified', 'verification_failed']);
    if (row.stagedSecretName) await deleteSecret(tx, row.stagedSecretName);
    const updated = await tx.credentialRotation.update({
      where: { id },
      data: {
        status: 'cancelled',
        stagedSecretName: null,
        closedAt: now,
        closedByUserId: actorUserId,
        evidence: appendEvidence(row.evidence, { step: 'cancelled', at: now.toISOString(), actorUserId }),
      },
    });
    await audit(tx, 'credential.rotation_cancelled', actorUserId, updated, 'success');
    return rotationView(updated);
  });
}

export async function listRotations(
  tx: TenantClient,
  filter: { systemKind?: RotatableSystemKind | undefined; systemId?: string | undefined; open?: boolean | undefined } = {},
): Promise<RotationView[]> {
  const rows = await tx.credentialRotation.findMany({
    where: {
      ...(filter.systemKind ? { systemKind: filter.systemKind } : {}),
      ...(filter.systemId ? { systemId: filter.systemId } : {}),
      ...(filter.open ? { status: { in: [...OPEN_ROTATION_STATUSES] } } : {}),
    },
    orderBy: { stagedAt: 'desc' },
    take: 100,
  });
  return rows.map(rotationView);
}

export async function readRotation(tx: TenantClient, id: string): Promise<RotationView | null> {
  const row = await tx.credentialRotation.findUnique({ where: { id } });
  return row ? rotationView(row) : null;
}

/** Which system a rotation belongs to, for the route's permission check. */
export async function rotationSystemKind(tx: TenantClient, id: string): Promise<RotatableSystemKind | null> {
  const row = await tx.credentialRotation.findUnique({ where: { id }, select: { systemKind: true } });
  return (row?.systemKind as RotatableSystemKind | undefined) ?? null;
}
