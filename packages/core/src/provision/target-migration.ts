import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { entraTargetConfigSchema, capabilitiesForTarget } from '@syntra/connectors';
import { recordEvent, stableStringify } from '../audit/audit-service.js';
import { TargetNotFoundError } from './target-service.js';

export class TargetMigrationNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetMigrationNotAvailableError';
  }
}

export class TargetMigrationPreviewStaleError extends Error {
  constructor() {
    super('the target changed after this migration was previewed; refresh the preview before applying');
    this.name = 'TargetMigrationPreviewStaleError';
  }
}

interface LegacyDocument {
  baseUrl?: unknown;
  auth?: { type?: unknown; tokenUrl?: unknown; clientId?: unknown };
}

export interface EntraMigrationPreview {
  targetId: string;
  revision: string;
  from: { type: 'httpJson'; adapter: 'Document-driven HTTP' };
  to: {
    type: 'entraId';
    adapter: 'Microsoft Entra ID';
    config: Record<string, unknown>;
  };
  preserved: {
    targetId: true;
    credential: true;
    schedule: true;
    accountProfile: boolean;
    accounts: number;
    entitlements: number;
    rules: number;
    runs: number;
  };
  capabilityChanges: Array<{ capability: string; before: boolean; after: boolean }>;
  warnings: string[];
}

const deriveNativeConfig = (raw: unknown): Record<string, unknown> => {
  const config = raw as { document?: LegacyDocument };
  const document = config?.document;
  if (!document || document.auth?.type !== 'oauth2') {
    throw new TargetMigrationNotAvailableError('only an OAuth document-driven Entra target can be migrated');
  }
  if (
    typeof document.baseUrl !== 'string' ||
    new URL(document.baseUrl).hostname.toLowerCase() !== 'graph.microsoft.com'
  ) {
    throw new TargetMigrationNotAvailableError('the legacy target is not pointed at Microsoft Graph');
  }
  if (typeof document.auth.tokenUrl !== 'string' || typeof document.auth.clientId !== 'string') {
    throw new TargetMigrationNotAvailableError('the legacy target has no concrete token endpoint and client id');
  }
  let token: URL;
  try {
    token = new URL(document.auth.tokenUrl);
  } catch {
    throw new TargetMigrationNotAvailableError('the legacy target token endpoint is not a valid URL');
  }
  const match = /^\/([^/]+)\/oauth2\/v2\.0\/token\/?$/i.exec(token.pathname);
  if (token.protocol !== 'https:' || token.hostname.toLowerCase() !== 'login.microsoftonline.com' || !match) {
    throw new TargetMigrationNotAvailableError('the legacy target does not use the supported Microsoft identity token endpoint');
  }
  const tenantId = decodeURIComponent(match[1]!);
  return entraTargetConfigSchema.parse({
    tenantId,
    clientId: document.auth.clientId,
    graphBaseUrl: document.baseUrl.replace(/\/$/, ''),
    tokenUrl: document.auth.tokenUrl,
  }) as Record<string, unknown>;
};

type MigrationRow = Awaited<ReturnType<typeof loadTarget>>;

const loadTarget = async (tx: TenantClient, targetId: string) =>
  tx.targetSystem.findUnique({
    where: { id: targetId },
    include: { _count: { select: { accounts: true, entitlements: true, rules: true, runs: true } }, profile: { select: { id: true } } },
  });

const buildPreview = (target: NonNullable<MigrationRow>): EntraMigrationPreview => {
  if (target.type !== 'httpJson') {
    throw new TargetMigrationNotAvailableError('only a document-driven HTTP target can use this migration');
  }
  const nativeConfig = deriveNativeConfig(target.config);
  const before = capabilitiesForTarget(target.type, target.config);
  const after = capabilitiesForTarget('entraId', nativeConfig);
  const capabilityChanges = (
    ['readBack', 'createAccount', 'updateAccount', 'disableAccount', 'manageEntitlements'] as const
  ).filter((capability) => before[capability] !== after[capability])
    .map((capability) => ({ capability, before: before[capability], after: after[capability] }));
  const revision = createHash('sha256').update(stableStringify({
    id: target.id,
    type: target.type,
    config: target.config,
    updatedAt: target.updatedAt.toISOString(),
    nativeConfig,
  })).digest('hex');
  return {
    targetId: target.id,
    revision,
    from: { type: 'httpJson', adapter: 'Document-driven HTTP' },
    to: { type: 'entraId', adapter: 'Microsoft Entra ID', config: nativeConfig },
    preserved: {
      targetId: true,
      credential: true,
      schedule: true,
      accountProfile: target.profile !== null,
      accounts: target._count.accounts,
      entitlements: target._count.entitlements,
      rules: target._count.rules,
      runs: target._count.runs,
    },
    capabilityChanges,
    warnings: [
      'The saved credential is preserved and is not returned by this preview.',
      'Existing readiness evidence becomes stale because the adapter and configuration fingerprint change.',
      'Run a native Entra connection test and simulation before enabling external writes.',
    ],
  };
};

export async function previewDocumentEntraMigration(
  tenantId: string,
  targetId: string,
): Promise<EntraMigrationPreview> {
  return withTenant(tenantId, async (tx) => {
    const target = await loadTarget(tx, targetId);
    if (!target) throw new TargetNotFoundError(targetId);
    return buildPreview(target);
  });
}

export async function applyDocumentEntraMigration(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  revision: string,
): Promise<EntraMigrationPreview> {
  return withTenant(tenantId, async (tx) => {
    const target = await loadTarget(tx, targetId);
    if (!target) throw new TargetNotFoundError(targetId);
    const preview = buildPreview(target);
    if (preview.revision !== revision) throw new TargetMigrationPreviewStaleError();

    const changed = await tx.targetSystem.updateMany({
      where: { id: targetId, type: 'httpJson', updatedAt: target.updatedAt },
      data: { type: 'entraId', config: preview.to.config as never },
    });
    if (changed.count !== 1) throw new TargetMigrationPreviewStaleError();

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.connector-migrate',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        revision,
        fromType: preview.from.type,
        toType: preview.to.type,
        preserved: preview.preserved,
        capabilityChanges: preview.capabilityChanges,
      },
    });
    return preview;
  });
}
