# Watching Syntra

Status: designed, 2026-08-29
Based on `2836235`

Two features that share one sentence: **Syntra records a great deal and exposes
almost none of it.** A security webhook group, so the events the documentation
tells operators to alert on can actually reach an alert; and a metrics
endpoint, so the things that silently back up can be seen backing up.

This is sub-project B of four. A (ending access) is built. D is backup and
restore; C is machine access — API tokens, then an inbound SCIM server. They
are separate documents.

## Why

`docs/configure.md` lists the audit events a tenant's security depends on and
then says:

> Nothing watches these by default — they are written to the tamper-evident log
> and nothing reads them. The forced-enrolment trade above is defensible
> *because* the enrolment is visible after the fact, so **wire these into your
> alerting.** An audit row nobody reads does not discharge the obligation.

There is no wire. `packages/core/src/notify/webhook-event.ts` defines six event
groups and every one of them is Automate or Govern — access requests,
approvals, fulfilment, grant lifecycle, access reviews, findings. Not one
security event can reach a webhook endpoint, so the instruction cannot be
followed by any means the product offers.

The second half is thinner but the same shape. There is no `prom-client`, no
OpenTelemetry and no `/metrics` anywhere in the tree.
`packages/core/src/health/readiness.ts` is a good gate — it was written against
the question "would a bad update pass it?" — but it is a boolean at one
instant. Nothing can alert on a webhook queue that stopped draining, a signing
key three days from expiry, or a sign-in failure rate that tripled at 03:00.
Cluster A just added a second delivery queue with its own retry ladder, on the
argument that **a failed logout is a row somebody can look at**. Nobody is
looking.

## Ruling: one hook, two consumers

**`recordEvent` is where both halves attach.**

Every security-relevant thing Syntra does already calls it — that is what makes
the audit log complete — so a fan-out placed inside it is a fan-out no future
caller can forget. The alternative, calling `enqueueWebhooks` beside each of
the twenty-odd security `recordEvent` sites, is precisely the "callers must
remember" shape that left a phished refresh token alive for fourteen days
(`packages/core/src/auth/refresh-token.ts`) and that cluster A spent sixteen
tasks eliminating. It is not being reintroduced one slice later.

The same hook increments the metrics counter, so `syntra_audit_events_total`
and the webhook fan-out cannot disagree about what happened.

**The cost, stated plainly.** `recordEvent` takes a per-tenant advisory lock and
is on the write path of most things the product does. The fan-out adds one
indexed read of `WebhookEndpoint` — and only for actions on the allowlist, so
an ordinary `application.launch` pays a set membership test and nothing else.
`enqueueWebhooks` already returns after one read when a tenant has no
endpoints.

## 1. Security events on the wire

### Three groups, not one

The existing file argues for few groups with human names:

> There are thirty-odd templates. A settings screen offering all thirty by
> their internal names, or a text field taking `automate-*`, would be a control
> that needs a paragraph of explanation next to it — and a control that needs
> explaining is the wrong control.

One "Security" group covering forty actions would be that control again. Three,
named for what a person wants to be woken for:

**`sign-in-security` — "Somebody is being refused, or has just gained
administrative access."**
`auth.lockout`, `auth.lockout_cleared`, `auth.mfa_failed`,
`auth.mfa_unavailable`, `auth.policy_denied`, `auth.elevate`,
`auth.password_reset_requested`, `auth.password_reset_factor_failed`,
`auth.password_reset_completed`, `saml.signature_refused`, `saml.acs_refused`,
`federation.assertion_refused`, `federation.exchange_refused`,
`federation.provision_refused`, `oidc.decision_missing`.

**`credentials` — "What somebody signs in with has changed."**
`mfa.enrolled`, `mfa.removed`, `mfa.enrol_failed`,
`mfa.recovery_codes_issued`, `auth.password_changed`, `auth.password_renewed`,
`auth.password_setup_issued`, `auth.forced_enrolment_completed`,
`session.revoked`, `oidc.token_revoked`.

**`configuration` — "Who may do what, or who we trust, has changed."**
`policy.rule_added`, `policy.rule_updated`, `policy.rule_deleted`,
`policy.rules_reordered`, `policy.default_set`, `tenant.settings_updated`,
`rbac.role_created`, `rbac.role_updated`, `rbac.role_deleted`,
`rbac.role_assigned`, `rbac.role_revoked`, `access.saml_configured`,
`access.oidc_configured`, `access.upstream_configured`,
`access.claim_mapping_changed`, `notify.webhook_created`,
`notify.webhook_updated`, `notify.webhook_deleted`,
`notify.webhook_secret_rotated`, `deployment.update_requested`,
`deployment.rollback_requested`.

**`auth.login` is deliberately absent from all three, and the reasoning
matters.** It fires on every successful sign-in as well as every failed one, so
a group containing it would deliver a webhook per sign-in — for a thousand-user
tenant on a Monday morning, a thousand deliveries an endpoint has to discard,
each with its own retry ladder. The aggregated signal is already here:
`auth.lockout` fires when repeated failures cross the threshold, and that is
the event worth waking somebody for. A receiver that genuinely wants every
attempt should poll the audit log, which is indexed for exactly that and does
not need a delivery queue to do it.

The allowlist is therefore over ACTIONS ONLY, never action-and-outcome. A
matcher that had to consider outcome would be a second matching rule beside
`eventMatches`, and the two would eventually disagree about what a subscription
means.

`notify.webhook_*` is in `configuration` deliberately. An endpoint subscribed
to configuration changes is told when webhook endpoints change, including its
own — somebody quietly repointing an integration is exactly the change an
integration should announce.

### What goes on the wire is a projection, not the row

**The audit payload is not forwarded.** This is the security decision of the
section, and it is easy to get wrong by doing the obvious thing.

An `AuditEvent.payload` is written for an authenticated reader inside the
console — it carries before-and-after values, org unit ids, statuses, reasons,
whatever the writer thought a person investigating would want. A webhook body
goes to a third-party URL over the internet, to a receiver an administrator
configured and Syntra cannot vouch for. Forwarding the payload would turn every
future `recordEvent` call into a disclosure decision made by whoever wrote it,
months earlier, with no idea it would leave the building.

So the body carries a fixed projection and nothing else:

```ts
{
  action: string;          // 'auth.lockout'
  outcome: 'success' | 'failure';
  occurredAt: string;      // ISO 8601
  sequence: number;        // its place in the tamper-evident chain
  actorUserId: string | null;
  targetType: string;
  targetId: string | null;
}
```

No `sourceIp`, no payload. A receiver that needs the detail has the sequence
number and can read the audit log through the API, authenticated — which is the
correct place to make that decision. If a future event genuinely needs a field
on the wire, adding it is a deliberate act against this list rather than a
side effect of writing an audit call.

### Ordering

The fan-out runs **after** the audit row is written and inside the same
transaction. After, because the sequence number and hash do not exist until it
is; inside, because an event that was audited but not announced, or announced
but not audited, is a disagreement between two records that are supposed to
describe the same thing.

## 2. Metrics

### Reaching it

`GET /metrics`, on the existing port, authenticated by a bearer token from
`METRICS_TOKEN`.

**No token configured means no route.** Not a route that answers 403 — no
route, answering 404 like any other path that does not exist. That is how
`RELEASE_TOKEN` already gates the updater, and it means a deployment that never
opted in cannot leak through a misconfiguration, because there is nothing
there.

The comparison is constant-time. The route is rate-limited like
`/health/ready`, and excluded from request logging the way `/health` is —
a scrape every fifteen seconds is not a thing anybody wants in the journal.

### No tenant labels

Every series is installation-wide. A scrape cannot enumerate tenants, count
them, or learn a slug — and cardinality does not grow with customers, which is
the standard way a Prometheus instance is brought down by its own success.

An operator debugging one tenant has the audit log and the console. Both are
authenticated, and both are better at it than a time series.

### What is exposed

**Process and runtime**, from `prom-client`'s default registry: heap, CPU,
event-loop lag, handles. These are the metrics somebody actually wants when the
API is slow, and hand-rolling an event-loop lag histogram to avoid a dependency
would be the wrong trade in an auth product.

**HTTP**: `syntra_http_request_duration_seconds`, a histogram labelled
`method`, `route`, `status`. `route` is **Fastify's route pattern**
(`/api/admin/users/:id/sessions`), never `request.url` — a raw URL puts user
ids and tenant hostnames into label values, which is both unbounded cardinality
and a disclosure.

**Build**: `syntra_build_info{version="…"} 1`, so a dashboard can tell which
release a symptom belongs to.

**Queues and backlogs**, gauges read from the database at scrape time:

| Metric | Answers |
|---|---|
| `syntra_webhook_deliveries_pending` | Is the webhook sender keeping up? |
| `syntra_webhook_deliveries_abandoned` | Has anything given up entirely? |
| `syntra_logout_deliveries_pending` | Cluster A's queue, same question |
| `syntra_logout_deliveries_abandoned` | **A failed logout nobody looked at** |
| `syntra_jobs_pending` | Is the scheduler running at all? |
| `syntra_sessions_active` | |
| `syntra_users_total{status}` | active / inactive |
| `syntra_accounts_locked` | A lockout spike, before the tickets |
| `syntra_signing_key_expires_in_seconds` | The nearest key's expiry |
| `syntra_readiness` | 1 or 0, the same probe `/health/ready` runs |

`syntra_signing_key_expires_in_seconds` earns its place specifically: key
rotation is scheduled monthly and its failure is completely silent until every
token stops verifying at once.

**Counters** incremented in `recordEvent`, for the allowlisted actions only:
`syntra_audit_events_total{action, outcome}`. Bounded by the allowlist, which
is why it is bounded at all — labelling by every action would grow with the
audit vocabulary.

Process-local, and honestly so: they reset on restart and a two-process
deployment reports two series. That is what a counter is, and Prometheus knows
how to handle it.

### Scrape cost

The database gauges are **cached for ten seconds**. A scrape every fifteen
seconds pays for them once; a misconfigured scraper polling every second does
not multiply the load on the database it is trying to observe.

Every query is a bounded `COUNT` over an indexed predicate. `readiness` is
already rate-limited for the same reason and is reused rather than
reimplemented.

### What this is not

**No tracing, no OpenTelemetry.** A different, larger decision with a
collector attached to it, and nothing here forecloses it.

**No per-tenant dashboards.** See above; it is a deliberate absence, not a
missing feature.

**No alerting rules shipped.** What is worth waking somebody for differs per
installation, and a rule file in this repository would be wrong for most of
them. The documentation names the four metrics worth starting from.

## Testing

**Fan-out.** That an allowlisted action reaches a subscribed endpoint and a
non-allowlisted one does not. That the body carries the projection and **not**
the audit payload — asserted by writing an event with a distinctive value in
its payload and searching the delivery body for it. That an endpoint subscribed
to `access-requests` receives no security events, and the reverse. That the
delivery and the audit row are in one transaction: a failed enqueue rolls back
the audit row.

**Metrics.** That the route is absent with no token, 401 with a wrong one, 200
with the right one. That the body parses as Prometheus text exposition. That no
label anywhere contains a tenant id, slug, or a uuid from a URL — asserted over
the whole rendered body, because that is the property that matters and it is
easy to reintroduce. That the gauges reflect seeded rows. That the cache holds
for ten seconds.

## Order

1. **The three event groups and the fan-out** in `recordEvent`, with the
   projection. Independently useful and makes the documentation true.
2. **The metrics endpoint**, its token, and the process/HTTP metrics.
3. **The database gauges and the audit counters**, which depend on 2 existing
   and on 1 for the counter hook.

## Not in this document

**Alerting on the metrics.** See above.

**A console screen for security events.** The audit log already is one.

**Anything about SIEM formats** — CEF, LEEF, syslog. A webhook is the general
mechanism; a receiver that wants CEF can be a thirty-line adapter, and shipping
a format nobody in this deployment uses is how integrations rot.
