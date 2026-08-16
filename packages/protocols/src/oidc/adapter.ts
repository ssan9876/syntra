import {
  artifactConsume,
  artifactDestroy,
  artifactFind,
  artifactFindByUid,
  artifactFindByUserCode,
  artifactRevokeByGrantId,
  artifactUpsert,
} from '@syntra/core';

/**
 * The shape `oidc-provider` calls. Typed structurally rather than imported
 * from `@types/oidc-provider` so this module does not depend on the provider
 * at all — it depends only on Syntra's store.
 */
export interface OidcAdapter {
  upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
  find(id: string): Promise<Record<string, unknown> | undefined>;
  findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined>;
  findByUid(uid: string): Promise<Record<string, unknown> | undefined>;
  consume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  revokeByGrantId(grantId: string): Promise<void>;
}

/**
 * Builds the adapter constructor for one tenant.
 *
 * `oidc-provider` calls `new Adapter(modelName)` and gives the adapter no
 * further context — no request, no tenant, nothing (`lib/helpers/
 * initialize_adapter.js`). Tenancy therefore has to be closed over here, at
 * the point where a Provider instance is built for a tenant, which is the
 * same reason `provider-factory.ts` builds one Provider per tenant. An adapter
 * that read a tenant from ambient state would be one async context leak away
 * from handing one tenant's token to another.
 */
export function makeAdapterFactory(tenantId: string): new (model: string) => OidcAdapter {
  return class SyntraAdapter implements OidcAdapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      await artifactUpsert(tenantId, this.model, id, payload, expiresIn);
    }

    async find(id: string) {
      const row = await artifactFind(tenantId, this.model, id);
      return row?.payload;
    }

    async findByUserCode(userCode: string) {
      const row = await artifactFindByUserCode(tenantId, this.model, userCode);
      return row?.payload;
    }

    async findByUid(uid: string) {
      const row = await artifactFindByUid(tenantId, this.model, uid);
      return row?.payload;
    }

    async consume(id: string) {
      await artifactConsume(tenantId, this.model, id);
    }

    async destroy(id: string) {
      await artifactDestroy(tenantId, this.model, id);
    }

    async revokeByGrantId(grantId: string) {
      await artifactRevokeByGrantId(tenantId, grantId);
    }
  };
}
