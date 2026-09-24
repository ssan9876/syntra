import { createHash, X509Certificate } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { webhookSecretName } from '../notify/webhook-service.js';
import { currentTenant } from '../tenant-context.js';

/**
 * The tenant's credential inventory (backlog #34, #67): every credential
 * Syntra holds, issues, or depends on, with what is known about its expiry,
 * when it was last rotated, and who owns it.
 *
 * COMPUTED, not stored. Each credential already lives somewhere -- a vault row
 * named by a target, a signing key, an API token, a certificate pasted into an
 * application -- and a second list of them would be wrong the first time
 * somebody added a target and the list did not hear about it. What cannot be
 * computed (an owner, a declared expiry, the Entra discovery result, which
 * alert was last raised) is kept in `CredentialRecord`, keyed by the entry's
 * `key`, and merged in here.
 *
 * Never a secret, a vault name, or a digest of a secret. Certificates are
 * identified by their public SHA-256 fingerprint, which is not a secret.
 *
 * Deployment-level secrets (`SESSION_SECRET`, the master key, `METRICS_TOKEN`,
 * SMTP) are not tenant data and are not here; the secret-rotation runbook
 * covers them.
 */

export const CREDENTIAL_KINDS = [
  'target_secret',
  'source_secret',
  'person_source_secret',
  'person_source_host_key',
  'upstream_client_secret',
  'upstream_certificate',
  'saml_sp_certificate',
  'signing_key',
  'api_token',
  'webhook_secret',
  'oidc_client_secret',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * Where the expiry came from.
 *
 * - `certificate` / `issued`: intrinsic -- read from the certificate or the row
 *   Syntra itself wrote (a signing key's `notAfter`, a token's `expiresAt`).
 * - `discovered`: read from the issuer (Entra `passwordCredentials`).
 * - `declared`: typed by an administrator.
 * - `none`: the credential genuinely has no expiry (a webhook secret, a host key
 *   pin, a token issued without one).
 * - `unknown`: it may well expire, and nothing has said when.
 */
export type ExpirySource = 'certificate' | 'issued' | 'discovered' | 'declared' | 'none' | 'unknown';

export type CredentialStatus = 'expired' | 'expiring' | 'ok' | 'no_expiry' | 'unknown';

/** The systems whose credential the dual-secret rotation workflow can rotate. */
export type RotatableSystemKind = 'target' | 'source' | 'person_source';

export interface CredentialItem {
  key: string;
  kind: CredentialKind;
  label: string;
  subject: { type: string; id: string; name: string; href: string | null };
  expiresAt: Date | null;
  expirySource: ExpirySource;
  /** Whether the scan raises advance alerts for this entry. */
  alertable: boolean;
  lastRotatedAt: Date | null;
  ownerUserId: string | null;
  ownerName: string | null;
  note: string | null;
  declaredExpiresAt: Date | null;
  discovery: { status: string; message: string | null; at: Date | null; expiresAt: Date | null } | null;
  status: CredentialStatus;
  daysRemaining: number | null;
  /** Present when the dual-secret rotation workflow applies. */
  rotation: { systemKind: RotatableSystemKind; systemId: string } | null;
}

const DAY_MS = 86_400_000;

export function credentialKey(kind: CredentialKind, subjectId: string, ref?: string): string {
  return ref ? `${kind}.${subjectId}.${ref}` : `${kind}.${subjectId}`;
}

const KEY_SHAPE = /^([a-z_]+)\.([0-9a-f-]{36})(?:\.([0-9a-f]{16,64}))?$/;

export function parseCredentialKey(key: string): { kind: CredentialKind; subjectId: string; ref: string | null } | null {
  const m = KEY_SHAPE.exec(key);
  if (!m || !(CREDENTIAL_KINDS as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as CredentialKind, subjectId: m[2]!, ref: m[3] ?? null };
}

/**
 * The public facts of a PEM certificate. A certificate that does not parse is
 * reported, not dropped: an unreadable certificate an application trusts is
 * exactly what an inventory exists to surface.
 */
export function certificateFacts(pem: string): { ref: string; notAfter: Date | null; notBefore: Date | null; subject: string | null } {
  try {
    const cert = new X509Certificate(pem);
    return {
      ref: cert.fingerprint256.replace(/:/g, '').toLowerCase().slice(0, 32),
      notAfter: new Date(cert.validTo),
      notBefore: new Date(cert.validFrom),
      subject: cert.subject.split('\n').find((part) => part.startsWith('CN='))?.slice(3) ?? null,
    };
  } catch {
    return {
      ref: createHash('sha256').update(pem.trim()).digest('hex').slice(0, 32),
      notAfter: null,
      notBefore: null,
      subject: null,
    };
  }
}

const TARGET_LABELS: Record<string, string> = {
  activeDirectory: 'Active Directory bind password',
  scim2: 'SCIM bearer token',
  httpJson: 'HTTP connector credential',
  entraId: 'Entra ID client secret',
};

export function statusFor(
  expiresAt: Date | null,
  expirySource: ExpirySource,
  now: Date,
  alertDays: readonly number[],
): { status: CredentialStatus; daysRemaining: number | null } {
  if (expiresAt === null) {
    return { status: expirySource === 'none' ? 'no_expiry' : 'unknown', daysRemaining: null };
  }
  const ms = expiresAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(ms / DAY_MS);
  if (ms <= 0) return { status: 'expired', daysRemaining };
  const horizon = Math.max(...alertDays, 0);
  return { status: ms <= horizon * DAY_MS ? 'expiring' : 'ok', daysRemaining };
}

/**
 * The advance-alert stage an expiry is in: 0 once it has passed, otherwise
 * the SMALLEST configured threshold it is inside, or null when it is inside
 * none. Only the most urgent stage is ever raised, so a credential discovered
 * three days from expiry is told about once (at 7), not four times.
 */
export function alertStage(expiresAt: Date, now: Date, alertDays: readonly number[]): number | null {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  const crossed = alertDays.filter((days) => ms <= days * DAY_MS);
  return crossed.length === 0 ? null : Math.min(...crossed);
}

interface Draft {
  key: string;
  kind: CredentialKind;
  label: string;
  subject: CredentialItem['subject'];
  intrinsicExpiresAt: Date | null;
  intrinsicSource: ExpirySource;
  /** False where only a declared or discovered expiry could exist. */
  intrinsic: boolean;
  alertable: boolean;
  lastRotatedAt: Date | null;
  defaultOwnerUserId: string | null;
  rotation: CredentialItem['rotation'];
}

/** Every credential, with the metadata rows merged in. One transaction. */
export async function buildCredentialInventory(tx: TenantClient, now: Date = new Date()): Promise<{
  alertDays: number[];
  items: CredentialItem[];
}> {
  const tenant = await tx.tenant.findUnique({
    where: { id: await currentTenant(tx) },
    select: { credentialAlertDays: true },
  });
  const alertDays = tenant?.credentialAlertDays.length ? [...tenant.credentialAlertDays].sort((a, b) => b - a) : [30, 14, 7, 1];

  const secrets = new Map(
    (await tx.secret.findMany({ select: { name: true, updatedAt: true } })).map((s) => [s.name, s.updatedAt]),
  );
  const drafts: Draft[] = [];
  const connector = (
    kind: CredentialKind,
    id: string,
    label: string,
    subject: CredentialItem['subject'],
    secretName: string,
    rotation: CredentialItem['rotation'],
  ) =>
    drafts.push({
      key: credentialKey(kind, id),
      kind,
      label,
      subject,
      intrinsicExpiresAt: null,
      intrinsicSource: 'unknown',
      intrinsic: false,
      alertable: true,
      lastRotatedAt: secrets.get(secretName) ?? null,
      defaultOwnerUserId: null,
      rotation,
    });

  // --- Connector credentials -------------------------------------------
  for (const t of await tx.targetSystem.findMany({ select: { id: true, name: true, type: true, secretName: true }, orderBy: { name: 'asc' } })) {
    connector('target_secret', t.id, TARGET_LABELS[t.type] ?? 'Target credential',
      { type: 'TargetSystem', id: t.id, name: t.name, href: `/admin/targets/${t.id}` },
      t.secretName, { systemKind: 'target', systemId: t.id });
  }
  for (const s of await tx.directorySource.findMany({ select: { id: true, name: true, type: true, secretName: true }, orderBy: { name: 'asc' } })) {
    // A SCIM source holds no credential of its own; its caller authenticates
    // with an API token, which is listed below.
    if (s.secretName === '') continue;
    connector('source_secret', s.id, 'LDAP bind password',
      { type: 'DirectorySource', id: s.id, name: s.name, href: `/admin/sources/${s.id}` },
      s.secretName, { systemKind: 'source', systemId: s.id });
  }
  const personSources = await tx.personSource.findMany({ select: { id: true, name: true, type: true, secretName: true, config: true }, orderBy: { name: 'asc' } });
  const hostKeyAccepted = personSources.length === 0 ? [] : await tx.auditEvent.findMany({
    where: { action: 'person_source.host_key_accepted', targetId: { in: personSources.map((p) => p.id) } },
    select: { targetId: true, occurredAt: true },
    orderBy: { sequence: 'desc' },
  });
  for (const p of personSources) {
    const subject = { type: 'PersonSource', id: p.id, name: p.name, href: `/admin/person-sources/${p.id}` };
    connector('person_source_secret', p.id, 'SFTP password or private key', subject, p.secretName,
      { systemKind: 'person_source', systemId: p.id });
    const pinned = (p.config as Record<string, unknown> | null)?.hostKeyFingerprint;
    if (typeof pinned === 'string' && pinned !== '') {
      drafts.push({
        key: credentialKey('person_source_host_key', p.id),
        kind: 'person_source_host_key',
        label: `Pinned SFTP host key ${pinned.length > 24 ? `${pinned.slice(0, 24)}…` : pinned}`,
        subject,
        intrinsicExpiresAt: null,
        intrinsicSource: 'none',
        intrinsic: true,
        alertable: false,
        lastRotatedAt: hostKeyAccepted.find((e) => e.targetId === p.id)?.occurredAt ?? null,
        defaultOwnerUserId: null,
        rotation: null,
      });
    }
  }

  // --- Federation: upstream identity providers ---------------------------
  for (const u of await tx.upstreamIdp.findMany({ select: { id: true, name: true, clientSecretName: true, idpCertificates: true }, orderBy: { name: 'asc' } })) {
    const subject = { type: 'UpstreamIdp', id: u.id, name: u.name, href: null };
    if (u.clientSecretName) {
      connector('upstream_client_secret', u.id, 'Upstream identity provider client secret', subject, u.clientSecretName, null);
    }
    for (const pem of u.idpCertificates) {
      const facts = certificateFacts(pem);
      drafts.push({
        key: credentialKey('upstream_certificate', u.id, facts.ref),
        kind: 'upstream_certificate',
        label: facts.notAfter ? `Upstream signing certificate${facts.subject ? ` (${facts.subject})` : ''}` : 'Upstream signing certificate (unreadable)',
        subject,
        intrinsicExpiresAt: facts.notAfter,
        intrinsicSource: facts.notAfter ? 'certificate' : 'unknown',
        intrinsic: facts.notAfter !== null,
        alertable: true,
        lastRotatedAt: facts.notBefore,
        defaultOwnerUserId: null,
        rotation: null,
      });
    }
  }

  // --- Federation: service-provider certificates Syntra trusts -------------
  const samlConfigs = await tx.samlConfig.findMany({
    select: { applicationId: true, spCertificates: true, encryptionCertificate: true, application: { select: { name: true } } },
  });
  for (const c of samlConfigs) {
    const subject = { type: 'Application', id: c.applicationId, name: c.application.name, href: `/admin/applications/${c.applicationId}` };
    const certs: [string, string][] = [
      ...c.spCertificates.map((pem): [string, string] => [pem, 'Service provider signing certificate']),
      ...(c.encryptionCertificate ? [[c.encryptionCertificate, 'Service provider encryption certificate'] as [string, string]] : []),
    ];
    for (const [pem, label] of certs) {
      const facts = certificateFacts(pem);
      drafts.push({
        key: credentialKey('saml_sp_certificate', c.applicationId, facts.ref),
        kind: 'saml_sp_certificate',
        label: facts.notAfter ? label : `${label} (unreadable)`,
        subject,
        intrinsicExpiresAt: facts.notAfter,
        intrinsicSource: facts.notAfter ? 'certificate' : 'unknown',
        intrinsic: facts.notAfter !== null,
        alertable: true,
        lastRotatedAt: facts.notBefore,
        defaultOwnerUserId: null,
        rotation: null,
      });
    }
  }

  // --- Syntra's own signing keys -----------------------------------------
  for (const k of await tx.signingKey.findMany({ where: { status: { in: ['active', 'outgoing'] } }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }] })) {
    drafts.push({
      key: credentialKey('signing_key', k.id),
      kind: 'signing_key',
      label: `${k.kind === 'saml' ? 'SAML' : 'OIDC'} signing key${k.status === 'outgoing' ? ' (outgoing, published for the overlap)' : ''}`,
      subject: { type: 'SigningKey', id: k.id, name: k.kid.slice(0, 16), href: null },
      intrinsicExpiresAt: k.notAfter,
      intrinsicSource: 'issued',
      intrinsic: true,
      // An outgoing key's `notAfter` is the END OF ITS OVERLAP, which is the
      // rotation working as designed rather than something to warn about.
      alertable: k.status === 'active',
      lastRotatedAt: k.createdAt,
      defaultOwnerUserId: null,
      rotation: null,
    });
  }

  // --- Machine credentials Syntra issues -----------------------------------
  const tokens = await tx.apiToken.findMany({
    where: {
      revokedAt: null,
      // A token that expired more than a month ago is a dead row, not a
      // credential; one that expired last week is an integration that broke.
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now.getTime() - 30 * DAY_MS) } }],
    },
    select: { id: true, name: true, expiresAt: true, createdAt: true, createdBy: true, userId: true, user: { select: { login: true } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const t of tokens) {
    drafts.push({
      key: credentialKey('api_token', t.id),
      kind: 'api_token',
      label: `API token "${t.name}"`,
      subject: { type: 'User', id: t.userId, name: t.user.login, href: `/admin/users/${t.userId}` },
      intrinsicExpiresAt: t.expiresAt,
      intrinsicSource: t.expiresAt ? 'issued' : 'none',
      intrinsic: true,
      alertable: true,
      lastRotatedAt: t.createdAt,
      defaultOwnerUserId: t.createdBy,
      rotation: null,
    });
  }
  for (const w of await tx.webhookEndpoint.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })) {
    drafts.push({
      key: credentialKey('webhook_secret', w.id),
      kind: 'webhook_secret',
      label: 'Webhook signing secret',
      subject: { type: 'WebhookEndpoint', id: w.id, name: w.name, href: '/admin/settings?tab=webhooks' },
      intrinsicExpiresAt: null,
      intrinsicSource: 'none',
      intrinsic: true,
      alertable: false,
      lastRotatedAt: secrets.get(webhookSecretName(w.id)) ?? null,
      defaultOwnerUserId: null,
      rotation: null,
    });
  }
  const clients = await tx.oidcClient.findMany({
    where: { tokenEndpointAuthMethod: { not: 'none' } },
    select: { applicationId: true, application: { select: { name: true } } },
  });
  for (const c of clients) {
    drafts.push({
      key: credentialKey('oidc_client_secret', c.applicationId),
      kind: 'oidc_client_secret',
      label: 'OIDC client secret (issued by Syntra)',
      subject: { type: 'Application', id: c.applicationId, name: c.application.name, href: `/admin/applications/${c.applicationId}` },
      intrinsicExpiresAt: null,
      intrinsicSource: 'none',
      intrinsic: true,
      alertable: false,
      lastRotatedAt: null,
      defaultOwnerUserId: null,
      rotation: null,
    });
  }

  // --- Merge the metadata --------------------------------------------------
  const records = new Map((await tx.credentialRecord.findMany()).map((r) => [r.credentialKey, r]));
  const ownerIds = [
    ...new Set(
      drafts
        .map((d) => records.get(d.key)?.ownerUserId ?? d.defaultOwnerUserId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const owners = new Map(
    ownerIds.length === 0
      ? []
      : (await tx.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]),
  );

  const items = drafts.map((d): CredentialItem => {
    const record = records.get(d.key);
    let expiresAt = d.intrinsicExpiresAt;
    let expirySource = d.intrinsicSource;
    if (!d.intrinsic) {
      if (record?.discoveryStatus === 'found' && record.discoveredExpiresAt) {
        expiresAt = record.discoveredExpiresAt;
        expirySource = 'discovered';
      } else if (record?.declaredExpiresAt) {
        expiresAt = record.declaredExpiresAt;
        expirySource = 'declared';
      }
    }
    const { status, daysRemaining } = statusFor(expiresAt, expirySource, now, alertDays);
    const ownerUserId = record?.ownerUserId ?? d.defaultOwnerUserId;
    return {
      key: d.key,
      kind: d.kind,
      label: d.label,
      subject: d.subject,
      expiresAt,
      expirySource,
      alertable: d.alertable,
      lastRotatedAt: d.lastRotatedAt,
      ownerUserId,
      ownerName: ownerUserId ? (owners.get(ownerUserId) ?? null) : null,
      note: record?.note ?? null,
      declaredExpiresAt: record?.declaredExpiresAt ?? null,
      discovery: record?.discoveryStatus
        ? {
            status: record.discoveryStatus,
            message: record.discoveryMessage,
            at: record.discoveredAt,
            expiresAt: record.discoveredExpiresAt,
          }
        : null,
      status,
      daysRemaining,
      rotation: d.rotation,
    };
  });

  // Most urgent first: expired, then soonest to expire, then the unknowns
  // (which somebody should declare), then everything that never expires.
  const rank: Record<CredentialStatus, number> = { expired: 0, expiring: 1, unknown: 2, ok: 3, no_expiry: 4 };
  items.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
      a.subject.name.localeCompare(b.subject.name),
  );
  return { alertDays, items };
}

/** Serialises an item for a JSON response. */
export function credentialItemView(item: CredentialItem) {
  return {
    ...item,
    expiresAt: item.expiresAt?.toISOString() ?? null,
    lastRotatedAt: item.lastRotatedAt?.toISOString() ?? null,
    declaredExpiresAt: item.declaredExpiresAt?.toISOString() ?? null,
    discovery: item.discovery
      ? {
          ...item.discovery,
          at: item.discovery.at?.toISOString() ?? null,
          expiresAt: item.discovery.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}
