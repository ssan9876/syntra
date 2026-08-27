import { randomBytes, randomUUID } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import { eventMatches, webhookBody } from './webhook-event.js';
import { assertOutboundUrl } from '../net/outbound.js';

/**
 * Where an endpoint's signing secret is filed in the vault.
 *
 * Derived from the endpoint id rather than its name, so renaming an endpoint
 * on a settings screen does not orphan the credential that authenticates it.
 */
export function webhookSecretName(endpointId: string): string {
  return `webhook:${endpointId}`;
}

export interface EndpointInput {
  name: string;
  url: string;
  enabled: boolean;
  events: string[];
}

/**
 * Spelled with an explicit `| undefined` rather than as `Partial<EndpointInput>`,
 * because `exactOptionalPropertyTypes` treats "present and undefined" as a
 * different thing from "absent" — and a zod `.optional()` produces the first.
 * The same shape, and for the same reason, as `TenantSettingsPatch`.
 */
export type EndpointPatch = {
  [K in keyof EndpointInput]?: EndpointInput[K] | undefined;
};

/** What a settings screen may read. Never the secret. */
export interface EndpointView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EndpointOptions {
  /**
   * Lifts the private-address refusal, from `OUTBOUND_ALLOW_PRIVATE`.
   *
   * Defaulted TRUE here and false in the config, deliberately. Syntra is
   * deployed on-premise, where a webhook pointed at the ticketing system on
   * the same LAN is the ordinary case rather than the attack — so the library
   * default is permissive and the deployment decides. The route passes the
   * configured value; only a test calls this without one.
   */
  allowPrivateNetworks?: boolean;
}

const view = (row: {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}): EndpointView => ({
  id: row.id,
  name: row.name,
  url: row.url,
  enabled: row.enabled,
  events: row.events,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * A fresh signing secret.
 *
 * Prefixed, so that one found in a log or a config file is identifiable as a
 * Syntra webhook secret by whoever finds it — which is the difference between
 * a credential that gets rotated and one that gets ignored. 32 random bytes,
 * base64url so it survives being pasted into any configuration format.
 */
function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Registers a receiver and returns its signing secret — the ONLY time that
 * value is ever returned.
 *
 * The secret is sealed in the vault and never read back to a client. An
 * administrator who loses it rotates it; there is no screen that shows it
 * again, because a screen that shows it again is a screen that leaks it every
 * time somebody opens the wrong tab.
 */
export async function createEndpoint(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: EndpointInput,
  options: EndpointOptions = {},
): Promise<EndpointView & { secret: string }> {
  await assertOutboundUrl(input.url, {
    allowPrivateAddresses: options.allowPrivateNetworks ?? true,
  });
  const tenantId = await currentTenant(tx);

  const row = await tx.webhookEndpoint.create({
    data: {
      tenantId,
      name: input.name,
      url: input.url,
      enabled: input.enabled,
      events: input.events,
    },
  });

  const secret = newSecret();
  await putSecret(tx, provider, webhookSecretName(row.id), secret);
  return { ...view(row), secret };
}

export async function listEndpoints(tx: TenantClient): Promise<EndpointView[]> {
  const rows = await tx.webhookEndpoint.findMany({ orderBy: { name: 'asc' } });
  return rows.map(view);
}

export async function updateEndpoint(
  tx: TenantClient,
  _provider: MasterKeyProvider,
  id: string,
  patch: EndpointPatch,
  options: EndpointOptions = {},
): Promise<EndpointView> {
  if (patch.url !== undefined) {
    // Re-checked on every change, not only at creation. Editing a saved
    // endpoint to point somewhere this deployment will not send is the same
    // act as creating one there.
    await assertOutboundUrl(patch.url, {
      allowPrivateAddresses: options.allowPrivateNetworks ?? true,
    });
  }
  const row = await tx.webhookEndpoint.update({
    where: { id },
    data: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.events === undefined ? {} : { events: patch.events }),
    },
  });
  return view(row);
}

/**
 * Removes the endpoint, its queued deliveries (by cascade) and its secret.
 *
 * The secret goes deliberately and explicitly. A sealed credential that
 * outlives the thing it authenticated belongs to nobody, appears on no screen,
 * and will never be rotated by anyone — which makes it exactly the kind of key
 * that is still valid years later when it turns up somewhere it should not be.
 */
export async function deleteEndpoint(tx: TenantClient, id: string): Promise<void> {
  await tx.webhookEndpoint.delete({ where: { id } });
  await deleteSecret(tx, webhookSecretName(id));
}

/** Internal. The sender's only reason to read a secret. */
export async function endpointSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<string | null> {
  return getSecret(tx, provider, webhookSecretName(id));
}

export async function rotateEndpointSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<string> {
  // Read first, so rotating a secret for an id that is not this tenant's
  // endpoint cannot write one into the vault under its name.
  await tx.webhookEndpoint.findUniqueOrThrow({ where: { id } });
  const secret = newSecret();
  await putSecret(tx, provider, webhookSecretName(id), secret);
  return secret;
}

/**
 * One thing that happened, as the webhook side sees it.
 *
 * Deliberately NOT `OutboxDraft`. This module must not import from
 * `automate/notify.ts`, because that module imports this one — the fan-out is
 * called from inside `enqueueOutbox` so that no future caller can enqueue mail
 * and forget the integrations. Defining the shape here keeps the dependency
 * pointing one way.
 */
export interface WebhookEventInput {
  event: string;
  requestId: string | null;
  recipients: string[];
  data: Record<string, unknown>;
}

/**
 * Writes a delivery per (event, subscribed endpoint).
 *
 * ONE delivery per event, not per recipient. Five approvers being mailed about
 * a stage opening is one thing that happened; a receiver that opened a ticket
 * per delivery would open five, and the recipients are carried on the single
 * payload precisely so it does not have to.
 *
 * Returns how many deliveries were written, so a caller can assert on it
 * without a second query. A tenant with no endpoints costs one indexed read
 * and nothing else.
 */
export async function enqueueWebhooks(
  tx: TenantClient,
  events: readonly WebhookEventInput[],
  now: Date = new Date(),
): Promise<number> {
  if (events.length === 0) return 0;
  const tenantId = await currentTenant(tx);

  const endpoints = await tx.webhookEndpoint.findMany({
    where: { enabled: true },
    select: { id: true, events: true },
  });
  if (endpoints.length === 0) return 0;

  const rows = [];
  for (const event of events) {
    for (const endpoint of endpoints) {
      if (!eventMatches(endpoint.events, event.event)) continue;
      // The id is minted here rather than left to the column default, because
      // it goes INSIDE the signed body as well as on the row: a receiver
      // discards a duplicate by it, and it has to be the same value in both
      // places for that to work.
      const id = randomUUID();
      rows.push({
        id,
        tenantId,
        endpointId: endpoint.id,
        event: event.event,
        payload: webhookBody({
          id,
          event: event.event,
          tenantId,
          occurredAt: now,
          requestId: event.requestId,
          recipients: event.recipients,
          data: event.data,
        }),
        // Due immediately. The sender runs on a short cadence, so "now" is the
        // first pass rather than a special case in the read.
        nextAttemptAt: now,
      });
    }
  }
  if (rows.length === 0) return 0;

  // The payload column is JSONB and `webhookBody` returns the exact string
  // that will be signed. Stored parsed, and rebuilt by `webhookBody` at send
  // time from the same key order, so the bytes that are hashed are the bytes
  // that go on the wire.
  await tx.webhookDelivery.createMany({
    data: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as object })),
  });
  return rows.length;
}
