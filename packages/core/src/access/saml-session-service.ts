import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/** Records that a session has signed into an application, for single logout. */
export async function startSamlSsoSession(
  tx: TenantClient,
  input: {
    sessionId: string;
    applicationId: string;
    nameId: string;
    sessionIndex: string;
  },
): Promise<void> {
  const tenantId = await currentTenant(tx);
  // A repeat launch refreshes rather than accumulating rows the logout would
  // notify twice. `saml_sso_session_one_live` is what makes this safe.
  await tx.samlSsoSession.updateMany({
    where: {
      sessionId: input.sessionId,
      applicationId: input.applicationId,
      endedAt: null,
    },
    data: { endedAt: new Date() },
  });
  await tx.samlSsoSession.create({ data: { tenantId, ...input } });
}

export async function listSsoSessionsForSession(
  tx: TenantClient,
  sessionId: string,
) {
  return tx.samlSsoSession.findMany({ where: { sessionId, endedAt: null } });
}

export async function endSsoSessions(
  tx: TenantClient,
  sessionId: string,
): Promise<void> {
  await tx.samlSsoSession.updateMany({
    where: { sessionId, endedAt: null },
    data: { endedAt: new Date() },
  });
}
