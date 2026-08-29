import { z } from "zod";

/**
 * The named groups an endpoint subscribes to.
 *
 * Duplicated from `@syntra/core`'s `WEBHOOK_EVENT_GROUPS` rather than imported,
 * because contracts is the boundary package and depends on nothing. A test in
 * `apps/api` asserts the two lists are the same, so the duplication cannot
 * drift silently -- and it did its job when the three security groups were
 * added, failing before anything shipped.
 *
 * The first six carry notification templates; the last three carry audit
 * action names. `source` on the core map is what records the difference; here
 * they are simply the values the console may write.
 */
export const webhookEventGroups = [
  "access-requests",
  "approvals",
  "fulfilment",
  "grant-lifecycle",
  "access-reviews",
  "findings",
  "sign-in-security",
  "credentials",
  "configuration",
] as const;

/**
 * A subscription entry: one of the named groups, an exact template name, or a
 * prefix wildcard.
 *
 * The console only ever writes group keys — the other two forms exist for an
 * integrator driving the API directly, who may want one specific event rather
 * than the group containing it. Kept deliberately narrow so a typo is a 400
 * rather than a subscription that matches nothing and looks like a delivery
 * failure for the rest of its life.
 */
const eventSelector = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*\*?$/,
    "An event group, a template name, or a name ending in *",
  );

const endpointName = z.string().trim().min(1).max(80);

/**
 * `http` and `https` only, and no credentials.
 *
 * The scheme is checked here as well as in `assertOutboundUrl`, so a bad one
 * is a field-level validation error on the form rather than a 500 from the
 * service — and the deeper check still runs, because this one cannot resolve
 * a name.
 */
const endpointUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Must start with http:// or https://",
  })
  .refine((value) => !/^https?:\/\/[^/@]*@/i.test(value), {
    message: "No username or password in the URL",
  });

/** `.strict()` throughout: a misspelt field must not come back 200 unchanged. */
export const webhookCreateRequest = z
  .object({
    name: endpointName,
    url: endpointUrl,
    enabled: z.boolean().default(true),
    events: z.array(eventSelector).max(64).default([]),
  })
  .strict();

export const webhookUpdateRequest = z
  .object({
    name: endpointName.optional(),
    url: endpointUrl.optional(),
    enabled: z.boolean().optional(),
    events: z.array(eventSelector).max(64).optional(),
  })
  .strict();

export const webhookEndpointResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  events: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * What the console needs to show health without a second request: how many
   * deliveries are queued, and when one last failed.
   */
  pending: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(),
  lastFailureAt: z.string().nullable(),
});

export const webhookListResponse = z.object({
  endpoints: z.array(webhookEndpointResponse),
});

/**
 * The one response that carries a secret, returned by create and by rotate.
 *
 * There is no route that reads it back. A secret redisplayable on demand is a
 * secret that leaks by being looked at, so the console shows it once, at the
 * moment it can still be copied somewhere useful.
 */
export const webhookSecretResponse = z.object({
  endpoint: webhookEndpointResponse,
  secret: z.string(),
});

export const webhookDeliveryResponse = z.object({
  id: z.string().uuid(),
  event: z.string(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.string(),
  deliveredAt: z.string().nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  /** `delivered`, `queued` or `failed`, decided server-side so two screens agree. */
  state: z.enum(["delivered", "queued", "failed"]),
});

export const webhookDeliveryListResponse = z.object({
  deliveries: z.array(webhookDeliveryResponse),
});

export type WebhookCreateRequest = z.infer<typeof webhookCreateRequest>;
export type WebhookUpdateRequest = z.infer<typeof webhookUpdateRequest>;
export type WebhookEndpointResponse = z.infer<typeof webhookEndpointResponse>;
export type WebhookListResponse = z.infer<typeof webhookListResponse>;
export type WebhookSecretResponse = z.infer<typeof webhookSecretResponse>;
export type WebhookDeliveryResponse = z.infer<typeof webhookDeliveryResponse>;
export type WebhookDeliveryListResponse = z.infer<
  typeof webhookDeliveryListResponse
>;
