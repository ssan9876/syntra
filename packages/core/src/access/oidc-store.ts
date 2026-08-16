import { withTenant } from '@syntra/db';

export interface StoredArtifact {
  payload: Record<string, unknown>;
  consumedAt: Date | null;
}

/**
 * The storage `oidc-provider` writes through.
 *
 * Every function takes a tenantId and opens its own `withTenant`, because
 * `packages/protocols` may not import `@syntra/db` (spec section 5's package
 * boundary) and because `oidc-provider` constructs its adapter with a model
 * name and nothing else — there is no request context to carry a transaction
 * through. Tenancy is closed over by the adapter factory instead.
 *
 * These calls are all single indexed statements. None of them does crypto or
 * network work, so opening a transaction per call is cheap and Global
 * Constraint 1 is not in play.
 */

/**
 * Lifts the columns the schema indexes out of the payload.
 *
 * oidc-provider hands the adapter one opaque payload and separately expects
 * `findByUid`, `findByUserCode` and `revokeByGrantId` to work. Rather than
 * scanning JSON, the three keys it looks things up by are promoted to
 * columns; the payload remains the authority and these are a copy.
 */
function indexed(payload: Record<string, unknown>) {
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    uid: str(payload.uid),
    userCode: str(payload.userCode),
    grantId: str(payload.grantId),
    accountId: str(payload.accountId),
  };
}

export async function artifactUpsert(
  tenantId: string,
  model: string,
  id: string,
  payload: Record<string, unknown>,
  expiresIn: number | undefined,
): Promise<void> {
  const expiresAt =
    expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000);
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.upsert({
      where: { tenantId_model_artifactId: { tenantId, model, artifactId: id } },
      create: { tenantId, model, artifactId: id, payload: payload as never, expiresAt, ...indexed(payload) },
      update: { payload: payload as never, expiresAt, ...indexed(payload) },
    });
  });
}

export async function artifactFind(
  tenantId: string,
  model: string,
  id: string,
): Promise<StoredArtifact | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcArtifact.findFirst({ where: { model, artifactId: id } });
    if (!row) return null;
    // Expiry is enforced on read as well as by the sweeper, so a token whose
    // row has not been swept yet is still dead.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    return { payload: row.payload as Record<string, unknown>, consumedAt: row.consumedAt };
  });
}

const findBy = (column: 'uid' | 'userCode') =>
  async function find(
    tenantId: string,
    model: string,
    value: string,
  ): Promise<StoredArtifact | null> {
    return withTenant(tenantId, async (tx) => {
      const row = await tx.oidcArtifact.findFirst({
        where: { model, [column]: value } as never,
      });
      if (!row) return null;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
      return { payload: row.payload as Record<string, unknown>, consumedAt: row.consumedAt };
    });
  };

export const artifactFindByUid = findBy('uid');
export const artifactFindByUserCode = findBy('userCode');

/**
 * Marks an artifact consumed without deleting it.
 *
 * oidc-provider reads `consumed` off the payload and refuses a second
 * exchange itself. Deleting the row instead would turn a replayed
 * authorization code into an unknown code — the same 400 either way, but with
 * no record that a replay happened, and code replay is the signal that a
 * redirect leaked.
 */
export async function artifactConsume(
  tenantId: string,
  model: string,
  id: string,
): Promise<void> {
  const now = new Date();
  await withTenant(tenantId, async (tx) => {
    const row = await tx.oidcArtifact.findFirst({ where: { model, artifactId: id } });
    if (!row) return;
    const payload = { ...(row.payload as Record<string, unknown>), consumed: Math.floor(now.getTime() / 1000) };
    await tx.oidcArtifact.update({
      where: { id: row.id },
      data: { consumedAt: now, payload: payload as never },
    });
  });
}

export async function artifactDestroy(
  tenantId: string,
  model: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.deleteMany({ where: { model, artifactId: id } });
  });
}

/**
 * Every artifact of one grant, gone at once. This is what makes a revoked
 * consent actually revoke the access and refresh tokens issued under it.
 */
export async function artifactRevokeByGrantId(
  tenantId: string,
  grantId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.deleteMany({ where: { grantId } });
  });
}

/** Housekeeping. Called by the scheduler; expiry is enforced on read anyway. */
export async function sweepExpiredArtifacts(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.oidcArtifact.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  });
}
