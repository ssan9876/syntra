import { z } from 'zod';
import { awsKmsProvider } from './aws-kms.js';
import { cachingMasterKeyProvider } from './key-cache.js';
import {
  fallbackMasterKeyProvider,
  localMasterKeyProvider,
  type MasterKeyProvider,
} from './master-key.js';
import { vaultTransitProvider, type VaultAuth } from './vault-transit.js';

/**
 * Which master-key provider a deployment runs, and everything it needs.
 *
 * Parsed from the environment ONCE, at boot, by `loadConfig` -- so a
 * half-configured KMS is a startup refusal naming the variable, not a sign-in
 * that fails an hour later. Reachability is a different question and is the
 * readiness probe's (`key-management` in `/health/ready`).
 */
export type KeyManagementConfig = {
  /**
   * The local MASTER_KEY. REQUIRED when `provider` is `local`; with an
   * external provider it is optional and, if present, DECRYPT-ONLY: it reads
   * rows not yet rewrapped, and is never used to wrap anything new. That is
   * the migration window, and removing it afterwards is the end of it.
   */
  masterKey: Buffer | null;
  /** The key being rotated away from, decrypt-only. `MASTER_KEY_PREVIOUS`. */
  previousMasterKey: Buffer | null;
  cache: { ttlMs: number; maxEntries: number };
  timeoutMs: number;
} & (
  | { provider: 'local' }
  | {
      provider: 'vault-transit';
      vault: {
        address: string;
        keyName: string;
        previousKeyName: string | null;
        mountPath: string;
        namespace: string | null;
        auth: VaultAuth;
      };
    }
  | {
      provider: 'aws-kms';
      aws: {
        keyId: string;
        previousKeyId: string | null;
        region: string | null;
        endpoint: string | null;
        bindTenant: boolean;
      };
    }
);

export const MASTER_KEY_PROVIDERS = ['local', 'vault-transit', 'aws-kms'] as const;

const base64Key = (name: string) =>
  z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, `${name} must be 32 bytes, base64 encoded`);

const optionalText = z.string().trim().min(1).optional();

const schema = z
  .object({
    MASTER_KEY_PROVIDER: z.enum(MASTER_KEY_PROVIDERS).default('local'),
    MASTER_KEY: base64Key('MASTER_KEY').optional(),
    MASTER_KEY_PREVIOUS: base64Key('MASTER_KEY_PREVIOUS').optional(),
    // Five minutes and a thousand keys: a tenant has tens of secrets, so the
    // working set of a busy deployment fits, and five minutes is the longest
    // a revoked KMS grant keeps serving reads from memory. 0 turns it off.
    MASTER_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
    MASTER_KEY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).max(100_000).default(1000),
    MASTER_KEY_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),

    VAULT_ADDR: z.string().url().optional(),
    VAULT_TRANSIT_KEY: optionalText,
    VAULT_TRANSIT_PREVIOUS_KEY: optionalText,
    VAULT_TRANSIT_MOUNT: z.string().trim().min(1).default('transit'),
    VAULT_NAMESPACE: optionalText,
    VAULT_TOKEN: optionalText,
    VAULT_ROLE_ID: optionalText,
    VAULT_SECRET_ID: optionalText,
    VAULT_APPROLE_MOUNT: z.string().trim().min(1).default('approle'),

    AWS_KMS_KEY_ID: optionalText,
    AWS_KMS_PREVIOUS_KEY_ID: optionalText,
    AWS_KMS_ENDPOINT: z.string().url().optional(),
    AWS_KMS_ENCRYPTION_CONTEXT: z.enum(['tenant', 'none']).default('tenant'),
    AWS_REGION: optionalText,
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (v.MASTER_KEY_PROVIDER === 'local') {
      need(v.MASTER_KEY !== undefined, 'MASTER_KEY', 'MASTER_KEY must be 32 bytes, base64 encoded (MASTER_KEY_PROVIDER is local)');
    }
    if (v.MASTER_KEY_PROVIDER === 'vault-transit') {
      need(v.VAULT_ADDR !== undefined, 'VAULT_ADDR', 'VAULT_ADDR is required when MASTER_KEY_PROVIDER is vault-transit');
      need(v.VAULT_TRANSIT_KEY !== undefined, 'VAULT_TRANSIT_KEY', 'VAULT_TRANSIT_KEY is required when MASTER_KEY_PROVIDER is vault-transit');
      const token = v.VAULT_TOKEN !== undefined;
      const approle = v.VAULT_ROLE_ID !== undefined || v.VAULT_SECRET_ID !== undefined;
      need(
        token !== approle,
        'VAULT_TOKEN',
        'vault-transit needs exactly one way to authenticate: VAULT_TOKEN, or VAULT_ROLE_ID with VAULT_SECRET_ID',
      );
      if (approle) {
        need(
          v.VAULT_ROLE_ID !== undefined && v.VAULT_SECRET_ID !== undefined,
          'VAULT_SECRET_ID',
          'AppRole needs both VAULT_ROLE_ID and VAULT_SECRET_ID',
        );
      }
    }
    if (v.MASTER_KEY_PROVIDER === 'aws-kms') {
      need(v.AWS_KMS_KEY_ID !== undefined, 'AWS_KMS_KEY_ID', 'AWS_KMS_KEY_ID is required when MASTER_KEY_PROVIDER is aws-kms');
    }
  });

/**
 * Throws `Error('<VAR>: <message>; …')`, the same shape `loadConfig` reports
 * every other variable in, so the operator sees one message at startup.
 */
export function parseKeyManagement(env: NodeJS.ProcessEnv | Record<string, string | undefined>): KeyManagementConfig {
  // An EMPTY variable is an unset one. Compose writes `${MASTER_KEY:-}` as
  // `MASTER_KEY=` when the operator has moved to a KMS, and "an empty string
  // is not 32 bytes of base64" would be a true refusal of a correct setup.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const v = parsed.data;
  const common = {
    masterKey: v.MASTER_KEY === undefined ? null : Buffer.from(v.MASTER_KEY, 'base64'),
    previousMasterKey: v.MASTER_KEY_PREVIOUS === undefined ? null : Buffer.from(v.MASTER_KEY_PREVIOUS, 'base64'),
    cache: { ttlMs: v.MASTER_KEY_CACHE_TTL_SECONDS * 1000, maxEntries: v.MASTER_KEY_CACHE_MAX_ENTRIES },
    timeoutMs: v.MASTER_KEY_PROVIDER_TIMEOUT_MS,
  };
  switch (v.MASTER_KEY_PROVIDER) {
    case 'local':
      return { ...common, provider: 'local' };
    case 'vault-transit':
      return {
        ...common,
        provider: 'vault-transit',
        vault: {
          address: v.VAULT_ADDR!,
          keyName: v.VAULT_TRANSIT_KEY!,
          previousKeyName: v.VAULT_TRANSIT_PREVIOUS_KEY ?? null,
          mountPath: v.VAULT_TRANSIT_MOUNT,
          namespace: v.VAULT_NAMESPACE ?? null,
          auth:
            v.VAULT_TOKEN !== undefined
              ? { method: 'token', token: v.VAULT_TOKEN }
              : { method: 'approle', roleId: v.VAULT_ROLE_ID!, secretId: v.VAULT_SECRET_ID!, mountPath: v.VAULT_APPROLE_MOUNT },
        },
      };
    case 'aws-kms':
      return {
        ...common,
        provider: 'aws-kms',
        aws: {
          keyId: v.AWS_KMS_KEY_ID!,
          previousKeyId: v.AWS_KMS_PREVIOUS_KEY_ID ?? null,
          region: v.AWS_REGION ?? null,
          endpoint: v.AWS_KMS_ENDPOINT ?? null,
          bindTenant: v.AWS_KMS_ENCRYPTION_CONTEXT === 'tenant',
        },
      };
  }
}

/**
 * The providers a configuration names, split into the one that wraps and the
 * ones that only unwrap. Exposed for `rekey`, which needs to know which is
 * which; everything else wants `createMasterKeyProvider`.
 */
export function providersFor(km: KeyManagementConfig): {
  primary: MasterKeyProvider;
  fallbacks: MasterKeyProvider[];
} {
  const fallbacks: MasterKeyProvider[] = [];
  let primary: MasterKeyProvider;
  switch (km.provider) {
    case 'local':
      primary = localMasterKeyProvider(km.masterKey!);
      break;
    case 'vault-transit': {
      const vault = (keyName: string) =>
        vaultTransitProvider({
          address: km.vault.address,
          keyName,
          mountPath: km.vault.mountPath,
          namespace: km.vault.namespace ?? undefined,
          auth: km.vault.auth,
          timeoutMs: km.timeoutMs,
        });
      primary = vault(km.vault.keyName);
      if (km.vault.previousKeyName) fallbacks.push(vault(km.vault.previousKeyName));
      break;
    }
    case 'aws-kms': {
      const aws = (keyId: string) =>
        awsKmsProvider({
          keyId,
          bindTenant: km.aws.bindTenant,
          region: km.aws.region ?? undefined,
          endpoint: km.aws.endpoint ?? undefined,
          timeoutMs: km.timeoutMs,
        });
      primary = aws(km.aws.keyId);
      if (km.aws.previousKeyId) fallbacks.push(aws(km.aws.previousKeyId));
      break;
    }
  }
  // Local keys last: with an external primary they are the migration source,
  // and a row they recognise is never one an external provider recognises, so
  // the order among formats does not matter -- only within one.
  if (km.provider !== 'local' && km.masterKey) fallbacks.push(localMasterKeyProvider(km.masterKey));
  if (km.previousMasterKey) fallbacks.push(localMasterKeyProvider(km.previousMasterKey));
  return { primary, fallbacks };
}

/**
 * The provider the process uses: the primary, any decrypt-only fallbacks, and
 * -- for an external primary -- the bounded unwrap cache in front of all of
 * them (see `key-cache.ts` for what that means during an outage).
 *
 * The local provider is not cached: its unwrap is a microsecond of AES, and a
 * cache would only lengthen how long plaintext data keys sit in memory.
 */
export function createMasterKeyProvider(km: KeyManagementConfig): MasterKeyProvider {
  const { primary, fallbacks } = providersFor(km);
  const composite = fallbackMasterKeyProvider(primary, fallbacks);
  if (km.provider === 'local') return composite;
  return cachingMasterKeyProvider(composite, km.cache);
}

/**
 * What to warn about at startup. Not errors -- each is a supported state --
 * but each is one an operator should see written down rather than discover.
 */
export function keyManagementWarnings(km: KeyManagementConfig): string[] {
  const warnings: string[] = [];
  if (km.provider !== 'local' && km.masterKey) {
    warnings.push(
      `MASTER_KEY is still set alongside ${km.provider}; it is used only to read data keys not yet rewrapped. Run rekey, confirm rekey --status shows no local rows, then remove it.`,
    );
  }
  if (km.previousMasterKey) {
    warnings.push('MASTER_KEY_PREVIOUS is set; remove it once rekey has moved every data key to the current key.');
  }
  if (km.provider === 'vault-transit' && km.vault.previousKeyName) {
    warnings.push('VAULT_TRANSIT_PREVIOUS_KEY is set; remove it once rekey has moved every data key to VAULT_TRANSIT_KEY.');
  }
  if (km.provider === 'aws-kms' && km.aws.previousKeyId) {
    warnings.push('AWS_KMS_PREVIOUS_KEY_ID is set; remove it once rekey has moved every data key to AWS_KMS_KEY_ID.');
  }
  return warnings;
}

const shared = new WeakMap<object, MasterKeyProvider>();

/**
 * One provider per configuration object, so the API's routes, its readiness
 * probe and its scheduler share one cache and one Vault token rather than
 * building a dozen. Keyed by identity: two `loadConfig` calls are two configs.
 *
 * Accepts the `Config` shape structurally, and tolerates a config built by a
 * test that predates key management (no `keyManagement`, only `masterKey`) by
 * treating it as local.
 */
export function masterKeyProviderFor(config: {
  keyManagement?: KeyManagementConfig | undefined;
  masterKey?: Buffer | null | undefined;
}): MasterKeyProvider {
  const existing = shared.get(config);
  if (existing) return existing;
  const km: KeyManagementConfig = config.keyManagement ?? {
    provider: 'local',
    masterKey: config.masterKey ?? null,
    previousMasterKey: null,
    cache: { ttlMs: 0, maxEntries: 0 },
    timeoutMs: 5000,
  };
  if (km.provider === 'local' && !km.masterKey) {
    throw new Error('MASTER_KEY is not configured');
  }
  const provider = createMasterKeyProvider(km);
  shared.set(config, provider);
  return provider;
}
