import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { loadActiveKey } from '../keys/signing-key-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  classifyStatus,
  nextAttemptAt,
} from '../notify/webhook-retry.js';
import { httpPoster, WEBHOOK_TIMEOUT_MS, type WebhookPoster } from '../notify/webhook-jobs.js';
import { mintLogoutToken } from './logout-token.js';
import { oidcIssuerFor } from './protocol-base.js';

/**
 * The retry policy is IMPORTED, not restated.
 *
 * `classifyStatus`, `nextAttemptAt` and `WEBHOOK_MAX_ATTEMPTS` come from the
 * webhook sender, which had them first and has tests for them. A copied ladder
 * is two ladders, and the second one is the one nobody remembers to change.
 *
 * The TABLE is not shared, deliberately — see the model's own docstring. The
 * policy is the part that must not drift; the rows are the part that must not
 * be filtered by a screen built for something else.
 */

export interface EnqueueLogoutInput {
  userId: string;
  /** The session that ended, when one session ended rather than all of them. */
  sessionId: string | null;
}

/**
 * Queues a logout for every relying party that asked to hear about this.
 *
 * "Asked to hear" is `backchannelLogoutUri` being set; "this" is a live grant
 * for the user whose session ended. A client with no URI is not told, which is
 * the default, and a client the person never signed into is not told either --
 * there is nothing at the other end to end.
 *
 * NO TOKEN IS MINTED HERE, and that is the point. Minting needs the tenant's
 * issuer and its active signing key, and the callers that end sessions -- a
 * sync-driven leaver, a deactivation, a password reset, somebody signing out
 * -- have neither. Requiring them to acquire both in order to revoke access is
 * exactly how propagation becomes something only some callers remember to do,
 * which is the failure `refresh-token.ts` already documents happening here
 * once.
 *
 * Takes a transaction because its caller holds one. A revocation that ended
 * the sessions and then failed to queue the notifications is the same defect
 * as a password reset that changed the password and failed to revoke.
 *
 * Returns how many were queued, so a caller can say so and a test can tell
 * "told nobody because nobody asked" from "told nobody because it is broken".
 */
export async function enqueueLogoutDeliveries(
  tx: TenantClient,
  tenantId: string,
  input: EnqueueLogoutInput,
): Promise<number> {
  const clients = await tx.oidcClient.findMany({
    where: { backchannelLogoutUri: { not: null } },
    select: { id: true, clientId: true },
  });
  if (clients.length === 0) return 0;

  // Only the clients this person actually holds a grant with. Sending a logout
  // token for a session that never existed is noise a relying party has to
  // decide what to do with, and there is no good answer.
  //
  // `OidcArtifact` has no `clientId` column -- oidc-provider's client id is a
  // string it chooses and the artifact keeps its whole payload as JSON, so the
  // filter happens here rather than in the query. The row count is one
  // person's live tokens, not a table scan.
  const artifacts = await tx.oidcArtifact.findMany({
    where: { accountId: input.userId },
    select: { payload: true },
  });
  const held = new Set<string>();
  for (const artifact of artifacts) {
    const payload = artifact.payload as { clientId?: unknown } | null;
    if (payload && typeof payload.clientId === 'string') held.add(payload.clientId);
  }

  const targets = clients.filter((c) => held.has(c.clientId));
  const now = new Date();
  for (const target of targets) {
    await tx.logoutDelivery.create({
      data: {
        tenantId,
        clientId: target.id,
        userId: input.userId,
        sessionId: input.sessionId,
        // Due immediately, so the first attempt needs no special case in the
        // sender's read. The same choice `WebhookDelivery` documents.
        nextAttemptAt: now,
      },
    });
  }

  return targets.length;
}

export interface LogoutJobOptions {
  now?: Date;
  /** Where this deployment is reached, for deriving the tenant's issuer. */
  publicUrl?: string;
  poster?: WebhookPoster;
  batchSize?: number;
  allowPrivateAddresses?: boolean;
}

/**
 * Sends the logout tokens that are due.
 *
 * The same three-phase shape as the webhook sender, for the same reason it
 * documents: read the rows out, do the network with NO transaction held, write
 * the results back in one short transaction. An HTTP round trip inside
 * `prisma.$transaction` is a P2028 against Prisma's budget as soon as one
 * relying party is slow, and that has shipped as a defect on this project
 * twice already.
 *
 * A delivery that runs out of attempts stays in the table with its last status
 * and error. **A failed logout is not a silent gap** — that visibility is the
 * whole reason back-channel is worth building over the front-channel version,
 * which cannot tell anybody it failed.
 */
export async function runLogoutDeliveryJob(
  tenantId: string,
  provider: MasterKeyProvider,
  options: LogoutJobOptions = {},
): Promise<{ delivered: number; failed: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 100;
  const post = options.poster ?? httpPoster(options.allowPrivateAddresses ?? true);

  // `primaryDomain`, because the issuer is the tenant's published identity and
  // never the request's Host -- see `protocolBase`.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, primaryDomain: true },
  });
  if (tenant === null) return { delivered: 0, failed: 0 };

  // Phase 1: read out, with the destination.
  const rows = await withTenant(tenantId, (tx) =>
    tx.logoutDelivery.findMany({
      where: {
        deliveredAt: null,
        nextAttemptAt: { lte: now },
        attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: batchSize,
      include: {
        client: {
          select: {
            clientId: true,
            backchannelLogoutUri: true,
            backchannelLogoutSessionRequired: true,
          },
        },
      },
    }),
  );
  if (rows.length === 0) return { delivered: 0, failed: 0 };

  // Minted here rather than at enqueue: this is where the issuer and the
  // signing key are available, and a token minted now cannot have been
  // stranded by a key rotation since the session ended.
  const issuer = oidcIssuerFor(tenant, options.publicUrl ?? '');
  const key = await loadActiveKey(tenantId, provider, 'oidc');

  // Phase 2: the network. No transaction is held.
  const results: { id: string; attempt: Awaited<ReturnType<WebhookPoster>> }[] = [];
  for (const row of rows) {
    const url = row.client.backchannelLogoutUri;
    if (key === null) {
      // No signing key means no verifiable token. Sending an unsigned one
      // would deliver something every relying party correctly rejects, five
      // times over. Retried, because a tenant with no active key is a state an
      // administrator can fix.
      results.push({
        id: row.id,
        attempt: { error: 'no active OIDC signing key: cannot mint a logout token' },
      });
      continue;
    }
    if (url === null) {
      // The URI was cleared while the delivery was queued. There is nowhere to
      // send it and never will be, so it is spent rather than retried.
      results.push({ id: row.id, attempt: { error: 'no back-channel logout URI is configured' } });
      continue;
    }

    // No address check here. `httpPoster` goes through `guardedFetch`, which
    // checks the address it is about to connect to and then pins the socket to
    // it — strictly stronger than anything checkable from here, where the
    // answer could be stale by the time the socket opens.
    const token = await mintLogoutToken(
      {
        issuer,
        audience: row.client.clientId,
        subject: row.userId,
        sessionId: row.sessionId,
        includeSid: row.client.backchannelLogoutSessionRequired,
      },
      key,
    );

    const attempt = await post(
      url,
      new URLSearchParams({ logout_token: token }).toString(),
      {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Syntra',
        // The spec requires these on a back-channel logout request.
        'cache-control': 'no-cache, no-store',
        pragma: 'no-cache',
      },
      WEBHOOK_TIMEOUT_MS,
    );
    results.push({ id: row.id, attempt });
  }

  // Phase 3: write the results back.
  let delivered = 0;
  let failed = 0;

  await withTenant(tenantId, async (tx) => {
    for (const { id, attempt } of results) {
      const row = rows.find((r) => r.id === id)!;
      const status = 'status' in attempt ? attempt.status : null;
      const outcome = status === null ? 'retry' : classifyStatus(status);
      const error = 'error' in attempt ? attempt.error : null;

      if (outcome === 'delivered') {
        await tx.logoutDelivery.update({
          where: { id },
          data: {
            deliveredAt: now,
            attempts: row.attempts + 1,
            lastStatus: status,
            lastError: null,
          },
        });
        delivered += 1;
        continue;
      }

      // `permanent` spends every remaining attempt at once. The row stops
      // being picked up without needing a second column to say why, and the
      // status it stopped on is still on it. A cleared URI is permanent too:
      // there is no address to try again.
      const spent = outcome === 'permanent' || error === 'no back-channel logout URI is configured';
      const attempts = spent ? WEBHOOK_MAX_ATTEMPTS : row.attempts + 1;
      const due = nextAttemptAt(attempts, now);

      await tx.logoutDelivery.update({
        where: { id },
        data: {
          attempts,
          lastStatus: status,
          lastError: error,
          // A row with no attempts left keeps its last due time rather than
          // gaining a meaningless future one: `attempts` is what stops it
          // being read, and two columns saying the same thing can disagree.
          ...(due === null ? {} : { nextAttemptAt: due }),
        },
      });
      failed += 1;
    }
  });

  return { delivered, failed };
}
