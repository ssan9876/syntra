import { withTenant, type TenantClient } from '@syntra/db';
import { discoverEntraCredentialExpiry, type EntraCredentialExpiry } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from '../provision/target-service.js';
import { currentTenant } from '../tenant-context.js';
import {
  consoleUrl,
  enqueueSecurityMail,
  tenantAdministrators,
  type MailRecipient,
} from '../notify/security-policy.js';
import {
  alertStage,
  buildCredentialInventory,
  credentialItemView,
  credentialKey,
  parseCredentialKey,
  type CredentialItem,
} from './inventory.js';

/**
 * The credential expiry scan (backlog #34): discover what can be discovered,
 * then raise each advance alert once.
 *
 * **Discovery** is Entra-only today, because Entra is the only issuer that
 * publishes a connector credential's expiry -- and only to a registration that
 * was granted `Application.Read.All`, which Syntra never requires. A refusal is
 * recorded as `not_permitted` and not retried for a week, so a tenant that
 * chose not to grant it does not produce a 403 in Microsoft's sign-in logs
 * every morning. Every other connector credential's expiry is whatever an
 * administrator declared.
 *
 * **Alerts** are de-duplicated on the record: the expiry an alert was raised
 * for and the smallest threshold raised. A claim is a conditional update keyed
 * on the values read, so two replicas running the scan at once raise an alert
 * once between them. Only the most urgent crossed threshold is raised, and a
 * changed expiry (a rotation, a new declaration) starts the ladder again.
 *
 * Each alert is an audit event -- `credential.expiring` or `credential.expired`,
 * in the Credentials webhook group -- and a mail to the credential's owner,
 * plus every `tenant.manage` holder when the tenant has switched the
 * `credential_expiry` category on or the credential has no owner. Somebody is
 * always told.
 */

const DAY_MS = 86_400_000;
/** How long a `not_permitted` discovery answer is trusted before asking again. */
export const DISCOVERY_REFUSAL_BACKOFF_MS = 7 * DAY_MS;

export type EntraDiscoverer = (config: Record<string, unknown> & { bindPassword: string }) => Promise<EntraCredentialExpiry>;

export interface ScanOptions {
  now?: Date;
  /** Ask Entra again even inside the refusal backoff (the console's "scan now"). */
  forceDiscovery?: boolean;
  /** Replaces the Graph call. Tests only. */
  discover?: EntraDiscoverer;
}

export interface ScanSummary {
  discovered: number;
  alertsRaised: number;
  mailsQueued: number;
  expired: number;
  expiring: number;
  unknown: number;
}

export class CredentialRefusedError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_declarable' | 'owner_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialRefusedError';
  }
}

async function discoverEntra(
  tenantId: string,
  provider: MasterKeyProvider,
  now: Date,
  options: ScanOptions,
): Promise<number> {
  const candidates = await withTenant(tenantId, async (tx) => {
    const targets = await tx.targetSystem.findMany({ where: { type: 'entraId' }, select: { id: true } });
    const out: { key: string; config: Record<string, unknown> & { bindPassword: string } }[] = [];
    for (const target of targets) {
      const key = credentialKey('target_secret', target.id);
      const record = await tx.credentialRecord.findUnique({
        where: { tenantId_credentialKey: { tenantId, credentialKey: key } },
        select: { discoveryStatus: true, discoveredAt: true },
      });
      if (
        !options.forceDiscovery &&
        record?.discoveryStatus === 'not_permitted' &&
        record.discoveredAt &&
        now.getTime() - record.discoveredAt.getTime() < DISCOVERY_REFUSAL_BACKOFF_MS
      ) {
        continue;
      }
      const config = await targetWithCredential(tx, provider, target.id);
      if (config) out.push({ key, config });
    }
    return out;
  });
  if (candidates.length === 0) return 0;

  // Outside any transaction: each of these is a token request and a Graph read.
  const discover = options.discover ?? ((config) => discoverEntraCredentialExpiry(config as never));
  const results: { key: string; result: EntraCredentialExpiry }[] = [];
  for (const candidate of candidates) {
    results.push({ key: candidate.key, result: await discover(candidate.config) });
  }

  await withTenant(tenantId, async (tx) => {
    for (const { key, result } of results) {
      const data = {
        discoveryStatus: result.status,
        discoveryMessage:
          result.status === 'found'
            ? result.ambiguous
              ? 'more than one secret on the registration shares this hint; the earliest expiry is shown'
              : null
            : result.status === 'unmatched'
              ? 'none of the app registration secrets matches the one Syntra holds'
              : result.message.slice(0, 500),
        discoveredExpiresAt: result.status === 'found' ? new Date(result.expiresAt) : null,
        discoveredAt: now,
      };
      await tx.credentialRecord.upsert({
        where: { tenantId_credentialKey: { tenantId, credentialKey: key } },
        create: { tenantId, credentialKey: key, kind: 'target_secret', ...data },
        update: data,
      });
    }
  });
  return results.filter((r) => r.result.status === 'found').length;
}

async function recipientsFor(
  tx: TenantClient,
  item: CredentialItem,
  mailAdministrators: boolean,
): Promise<MailRecipient[]> {
  const out: MailRecipient[] = [];
  let ownerTold = false;
  if (item.ownerUserId) {
    const owner = await tx.user.findUnique({
      where: { id: item.ownerUserId },
      select: { id: true, email: true, displayName: true, status: true },
    });
    if (owner && owner.status === 'active' && owner.email !== '') {
      out.push({ userId: owner.id, email: owner.email, displayName: owner.displayName });
      ownerTold = true;
    }
  }
  if (mailAdministrators || !ownerTold) out.push(...(await tenantAdministrators(tx)));
  return out;
}

async function raiseAlerts(tenantId: string, now: Date): Promise<Omit<ScanSummary, 'discovered'>> {
  return withTenant(tenantId, async (tx) => {
    const { alertDays, items } = await buildCredentialInventory(tx, now);
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { securityEmailCategories: true },
    });
    const mailAdministrators = tenant?.securityEmailCategories.includes('credential_expiry') ?? false;

    // Make sure every entry has a record, then keep `effectiveExpiresAt`
    // current -- the incident list reads it.
    await tx.credentialRecord.createMany({
      data: items.map((item) => ({ tenantId, credentialKey: item.key, kind: item.kind })),
      skipDuplicates: true,
    });
    const records = new Map((await tx.credentialRecord.findMany()).map((r) => [r.credentialKey, r]));
    const live = new Set(items.map((i) => i.key));
    const stale = [...records.keys()].filter((key) => !live.has(key));
    if (stale.length > 0) await tx.credentialRecord.deleteMany({ where: { credentialKey: { in: stale } } });

    let alertsRaised = 0;
    let mailsQueued = 0;
    for (const item of items) {
      const record = records.get(item.key)!;
      const effective = item.alertable ? item.expiresAt : null;
      if ((record.effectiveExpiresAt?.getTime() ?? null) !== (effective?.getTime() ?? null)) {
        await tx.credentialRecord.update({ where: { id: record.id }, data: { effectiveExpiresAt: effective } });
      }
      if (!item.alertable || item.expiresAt === null) continue;
      const stage = alertStage(item.expiresAt, now, alertDays);
      if (stage === null) continue;
      const sameExpiry = record.alertedExpiresAt?.getTime() === item.expiresAt.getTime();
      if (sameExpiry && record.alertedThresholdDays !== null && record.alertedThresholdDays <= stage) continue;

      const claimed = await tx.credentialRecord.updateMany({
        where: {
          id: record.id,
          alertedExpiresAt: record.alertedExpiresAt,
          alertedThresholdDays: record.alertedThresholdDays,
        },
        data: { alertedExpiresAt: item.expiresAt, alertedThresholdDays: stage, alertedAt: now },
      });
      if (claimed.count !== 1) continue;
      alertsRaised += 1;

      const expired = stage === 0;
      await recordEvent(tx, {
        actorUserId: null,
        action: expired ? 'credential.expired' : 'credential.expiring',
        targetType: 'Credential',
        targetId: record.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          credentialKey: item.key,
          kind: item.kind,
          subjectType: item.subject.type,
          subjectId: item.subject.id,
          expiresAt: item.expiresAt.toISOString(),
          expirySource: item.expirySource,
          thresholdDays: stage,
          daysRemaining: item.daysRemaining,
        },
      });
      const recipients = await recipientsFor(tx, item, mailAdministrators);
      mailsQueued += await enqueueSecurityMail(
        tx,
        tenantId,
        expired ? 'security-credential-expired' : 'security-credential-expiring',
        recipients,
        {
          credentialLabel: item.label,
          subjectName: item.subject.name,
          expiresAt: item.expiresAt.toISOString().slice(0, 10),
          daysRemaining: String(Math.max(item.daysRemaining ?? 0, 0)),
          expirySource: item.expirySource,
          inventoryUrl: consoleUrl('/admin/settings?tab=credentials'),
        },
      );
    }
    return {
      alertsRaised,
      mailsQueued,
      expired: items.filter((i) => i.status === 'expired').length,
      expiring: items.filter((i) => i.status === 'expiring').length,
      unknown: items.filter((i) => i.status === 'unknown').length,
    };
  });
}

/** Discovery, then alerts. Safe to run concurrently and repeatedly. */
export async function scanCredentials(
  tenantId: string,
  provider: MasterKeyProvider,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const now = options.now ?? new Date();
  const discovered = await discoverEntra(tenantId, provider, now, options);
  const alerts = await raiseAlerts(tenantId, now);
  return { discovered, ...alerts };
}

export interface CredentialMetadataPatch {
  ownerUserId?: string | null | undefined;
  declaredExpiresAt?: Date | null | undefined;
  note?: string | null | undefined;
}

/**
 * Sets an owner, a declared expiry or a note on one inventory entry.
 *
 * A declared expiry is refused for a credential whose expiry is intrinsic --
 * a certificate, a signing key, a token -- because a typed date beside a
 * certificate's own `notAfter` would be a second, wrong answer.
 */
export async function updateCredentialMetadata(
  tx: TenantClient,
  actorUserId: string | null,
  key: string,
  patch: CredentialMetadataPatch,
  now: Date = new Date(),
) {
  const parsed = parseCredentialKey(key);
  if (!parsed) throw new CredentialRefusedError('not_found', 'no such credential');
  const { items } = await buildCredentialInventory(tx, now);
  const item = items.find((i) => i.key === key);
  if (!item) throw new CredentialRefusedError('not_found', 'no such credential');
  if (
    patch.declaredExpiresAt !== undefined &&
    !['target_secret', 'source_secret', 'person_source_secret', 'upstream_client_secret'].includes(item.kind)
  ) {
    throw new CredentialRefusedError(
      'not_declarable',
      'this credential carries its own expiry; a declared date would contradict it',
    );
  }
  if (patch.ownerUserId) {
    const owner = await tx.user.findUnique({ where: { id: patch.ownerUserId }, select: { id: true } });
    if (!owner) throw new CredentialRefusedError('owner_not_found', 'no such user');
  }
  const tenantId = await currentTenant(tx);
  const data = {
    ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
    ...(patch.declaredExpiresAt !== undefined ? { declaredExpiresAt: patch.declaredExpiresAt } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  };
  await tx.credentialRecord.upsert({
    where: { tenantId_credentialKey: { tenantId, credentialKey: key } },
    create: { tenantId, credentialKey: key, kind: item.kind, ...data },
    update: data,
  });
  await recordEvent(tx, {
    actorUserId,
    action: 'credential.metadata_updated',
    targetType: 'Credential',
    targetId: null,
    outcome: 'success',
    sourceIp: null,
    payload: {
      credentialKey: key,
      kind: item.kind,
      ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
      ...(patch.declaredExpiresAt !== undefined
        ? { declaredExpiresAt: patch.declaredExpiresAt?.toISOString() ?? null }
        : {}),
      noteChanged: patch.note !== undefined,
    },
  });
  const after = (await buildCredentialInventory(tx, now)).items.find((i) => i.key === key)!;
  await tx.credentialRecord.update({
    where: { tenantId_credentialKey: { tenantId, credentialKey: key } },
    data: { effectiveExpiresAt: after.alertable ? after.expiresAt : null },
  });
  return credentialItemView(after);
}

export const CREDENTIAL_EXPIRY_SCAN_JOB = 'credentials.expiry_scan';
export interface CredentialExpiryScanPayload {
  tenantId: string;
}

export function registerCredentialJobs(scheduler: Scheduler, provider: MasterKeyProvider): void {
  scheduler.register<CredentialExpiryScanPayload>(CREDENTIAL_EXPIRY_SCAN_JOB, async ({ tenantId }) => {
    await scanCredentials(tenantId, provider);
  });
}

export function credentialScanScheduleKey(tenantId: string): string {
  return `credential-expiry-${tenantId}`;
}

/**
 * Daily, early morning UTC. A threshold is measured in days, so a daily pass
 * raises each one on the day it is crossed; the console's "scan now" is there
 * for the administrator who has just declared an expiry and wants to see it.
 */
export async function scheduleCredentialScan(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(
    CREDENTIAL_EXPIRY_SCAN_JOB,
    '20 6 * * *',
    { tenantId } satisfies CredentialExpiryScanPayload,
    credentialScanScheduleKey(tenantId),
  );
}

/** Tenant settings for the policy screen. */
export async function readSecurityNotificationSettings(tx: TenantClient) {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: await currentTenant(tx) },
    select: { securityEmailCategories: true, credentialAlertDays: true },
  });
  return {
    emailCategories: tenant.securityEmailCategories,
    alertDays: [...tenant.credentialAlertDays].sort((a, b) => b - a),
  };
}

export async function updateSecurityNotificationSettings(
  tx: TenantClient,
  actorUserId: string | null,
  patch: { emailCategories?: string[] | undefined; alertDays?: number[] | undefined },
) {
  const tenantId = await currentTenant(tx);
  const before = await readSecurityNotificationSettings(tx);
  const alertDays = patch.alertDays ? [...new Set(patch.alertDays)].sort((a, b) => b - a) : undefined;
  const emailCategories = patch.emailCategories ? [...new Set(patch.emailCategories)].sort() : undefined;
  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      ...(emailCategories ? { securityEmailCategories: emailCategories } : {}),
      ...(alertDays ? { credentialAlertDays: alertDays } : {}),
    },
  });
  const after = await readSecurityNotificationSettings(tx);
  await recordEvent(tx, {
    actorUserId,
    action: 'tenant.security_notifications_updated',
    targetType: 'Tenant',
    targetId: null,
    outcome: 'success',
    sourceIp: null,
    payload: { before, after },
  });
  return after;
}
