# Secret rotation

## Purpose

Rotate each credential a Syntra deployment holds or issues, with the effect
each rotation has on running sessions, integrations and scheduled work. Only
secrets that exist in this repository are listed. Where rotation is not
supported, the page says so.

## When to use

- On a schedule the organisation sets for each class of secret.
- After a suspected exposure (a leaked `.env`, a token in a log, a departed
  administrator who knew a value).
- When an external party rotates on their side: an Entra app registration's
  client secret expires, an SMTP relay changes its credential, a webhook
  receiver asks for a new signing secret.

## Prerequisites

- A verified backup ([Backup and restore](backup-and-restore.md)).
- For environment secrets: write access to `/opt/syntra/shared/.env`
  (release layout), the compose environment, or the `syntra-runtime`
  Kubernetes Secret, and the ability to restart the API.
- For stored secrets: an administrator session with the permission the route
  requires: `provision.manage` for targets, `sync.manage` for sources,
  `token.manage` for API tokens, `tenant.manage` for webhook endpoints.
- A generator for random values:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

## Summary

| Secret | Where it lives | Rotate by | Effect of rotation |
|---|---|---|---|
| `SESSION_SECRET` | environment | new value, restart | Console and portal sessions **survive**; in-flight OIDC interactions fail once |
| `MASTER_KEY` | environment | **not rotatable in place** | See [Master-key recovery](master-key-recovery.md) |
| `METRICS_TOKEN` | environment | new value, restart, update scraper | Scrapes 401 until the scraper is updated |
| `SMTP_URL` credential | environment | new value, restart | Mail queued in the outbox retries under the new credential |
| `GOVERN_CHECKPOINT_KEY` / `_ID` | environment | new value and new id, restart | See caveat below |
| `RELEASE_TOKEN` | environment (`shared/.env`) | revoke in GitHub, new token, no restart needed for the next update | Updates fail with an auth error until replaced |
| Postgres passwords (`POSTGRES_PASSWORD`, `SYNTRA_APP_PASSWORD`) | environment + database role | `ALTER ROLE`, then environment, restart | Readiness `database` probe fails until both agree |
| Provisioning target credential (AD bind password, SCIM bearer token, Entra client secret) | vault (`Secret` row) | console or `PATCH /api/admin/targets/:id` | Next run uses it; see the Entra token-cache note |
| Directory source bind password | vault | console or `PATCH /api/admin/sources/:id` | Next sync uses it |
| Person (HR feed) source credential | vault | console or `PATCH /api/admin/person-sources/:id` | Next import uses it |
| Upstream IdP client secret | vault | API only; no console screen | Sign-ins through that upstream use the new value immediately |
| API tokens (including the SCIM machine token) | hashed in `ApiToken` | issue a new one, install it at the caller, revoke the old | Old token refused from the moment of revocation |
| Webhook signing secret | vault | `POST /api/admin/webhooks/:id/secret` | Deliveries after the call are signed with the new secret |
| SAML signing key | vault | `rotateKey(tenantId, provider, 'saml')`, no console | Every SP that pinned the certificate breaks until re-configured |
| OIDC signing key | vault | automatic, monthly | Outgoing key published beside the incoming one for a week |

## Procedure A: `SESSION_SECRET`

What it is used for, as verified in the code: `@fastify/cookie` is registered
with it as its signing secret (`apps/api/src/app.ts`), but the session cookie
is set without `signed` and the session is resolved by looking up the SHA of
the random token in the `Session` table (`apps/api/src/routes/session-reply.ts`,
`packages/core/src/auth/session-service.ts`). The one consumer that signs with
it is the OIDC provider's interaction cookies (`cookieKeys` in
`apps/api/src/routes/oidc-op.ts`).

1. Generate a new value (32 random bytes, base64; the API refuses the
   `.env.example` placeholder and anything under 32 characters).
2. Replace it in the environment.
3. Restart the API (`systemctl restart syntra`, `docker compose up -d api`,
   or restart the `api` Deployment).
4. Verify: existing console sessions still work; an OIDC sign-in that was
   mid-flow at the restart fails once and succeeds on retry.

There is no dual-key window; `cookieKeys` is a single value. Choose a quiet
minute.

## Procedure B: `MASTER_KEY`

Do not. There is no tool to re-wrap the vault under a new key, and a new key
unseals nothing. If the key must change because it was exposed, that is the
full re-entry procedure in
[Master-key recovery, "When the original key is genuinely gone"](master-key-recovery.md#when-the-original-key-is-genuinely-gone),
planned as a change with every secret owner on hand.

## Procedure C: `METRICS_TOKEN`

1. Generate a new value, at least 16 characters.
2. Update the scraper's `bearer_token` to the new value but do not reload it
   yet.
3. Replace the value in the environment and restart the API.
4. Reload the scraper.
5. Verify: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <new>" http://127.0.0.1:3000/metrics`
   is 200, and the old value is 401.

Removing the variable altogether unregisters the route; the path then answers
404.

## Procedure D: `SMTP_URL`

1. Replace the credential in the URL in the environment; restart the API.
2. Verify by causing one mail: a password-reset request for a test account,
   or assign a lifecycle operation to yourself
   (`PATCH /api/admin/lifecycle-operations/:id/assignment`), which queues a
   `lifecycle-assigned` message.
3. Watch `GET /api/admin/incidents`: a `notification_undelivered` entry means
   the outbox has given up on messages after five attempts. There is no
   console button to send a test mail; the outbox is the test.

## Procedure E: a provisioning target credential, including an Entra client secret

Applies to all three target types (`activeDirectory`, `scim2`, `httpJson`).
The credential is one vault row per target, named in `TargetSystem.secretName`,
and every connector receives it as `bindPassword`
(`packages/core/src/provision/target-service.ts`). For Entra ID it is the app
registration's client secret; the tenant id and client id are not secrets
and live in the target's config document.

1. **Create the new credential at the source.** For Entra: the app
   registration's **Certificates & secrets**, add a client secret, copy the
   value. Do not delete the old one yet.
2. **Test it before saving.** `POST /api/admin/targets/test` with
   `{ type, config, bindPassword: "<new>" }` (rate-limited like sign-in).
   In the console: **Target systems → the target**, paste the new value into
   the credential field (labelled **Application client secret** for Entra),
   press **Test connection**. A wrong Entra secret comes back as
   `the token endpoint answered HTTP 401 (AADSTS…)`; the AADSTS code is the
   only part of Microsoft's response the connector surfaces, by design.
3. **Save.** Press Save, or `PATCH /api/admin/targets/:id` with
   `{ "bindPassword": "<new>" }`. Config replaces rather than merges; omit
   `bindPassword` and the stored secret is left alone. The stored value is
   never echoed by any route.
4. **The Entra token-cache note.** The HTTP connector caches OAuth access
   tokens in process memory, keyed by token URL, client id and scope, and
   refreshes them 60 seconds before expiry (`packages/connectors/src/http/client.ts`).
   Replacing the client secret does not clear that cache; `forgetAccessTokens()`
   exists in the client but nothing in core calls it on a credential change.
   Consequences:
   - After a successful rotation, runs keep using the cached token (still
     valid at Microsoft) for up to an hour, then fetch a new one with the new
     secret. This is harmless.
   - After a **wrong** new secret, runs also keep succeeding for up to an
     hour and then start failing. **Test connection** does not use the cache
     for the run's token key in a way you can rely on either way, so treat
     its result as the truth and restart the API if you need the cache gone
     now.
   - An expired secret at Microsoft manifests as runs that start and fail at
     the token endpoint; see the [tabletop exercise](tabletop-exercises.md#exercise-1-expired-entra-client-secret).
5. **Run once by hand.** **Target systems → the target → Runs → Run now**
   (`POST /api/admin/targets/:id/runs`). Review the preview; do not apply
   anything unexpected. `lastRunAt` moving is the proof a full read
   completed.
6. **Delete the old credential at the source** only after step 5.
7. Verify: `GET /api/admin/targets/:id/readiness` reports the latest test as
   `passed` for the current configuration.

## Procedure F: a directory or HR-feed source credential

Same shape as E, on **Sources**. Test with `POST /api/admin/sources/:id/test`
or `POST /api/admin/person-sources/:id/test`, save with the `PATCH` route,
then run once (`POST /api/admin/sources/:id/run`,
`POST /api/admin/person-sources/:id/run`) and read the preview before
applying. An SFTP person source also pins the server's host key
(`POST /api/admin/person-sources/:id/host-key`); a rotated server key is a
separate change from a rotated credential.

## Procedure G: API tokens, including the SCIM machine token

Tokens are `syntra_pat_…` bearer credentials hashed at rest, shown once,
never readable again. The SCIM client (Entra, Okta) holds one of these as its
secret token ([Configure, "Provisioning into Syntra with SCIM"](../configure.md#provisioning-into-syntra-with-scim)).

1. Issue a new token against the same service account:
   **Sessions → the account → API tokens**, or
   `POST /api/admin/users/:id/tokens` (permission `token.manage`). Set an
   expiry; the console suggests ninety days.
2. Install it at the caller (the IdP's provisioning configuration).
3. Confirm the caller has used it: the token list shows last-used, and a
   token never used says so.
4. Revoke the old one: `DELETE /api/admin/users/:id/tokens/:tokenId`.
5. Verify: the IdP's next provisioning cycle succeeds; the audit log shows
   `api_token.issued` and `api_token.revoked`, both in the **Credentials**
   webhook group.

Revoking the service account's role revokes every token it issued at once;
that is the emergency stop.

## Procedure H: webhook signing secrets

```
POST /api/admin/webhooks/:id/secret
```

returns `{ endpoint, secret }` with the new secret **once**, records
`notify.webhook_secret_rotated`, and an endpoint subscribed to
**Configuration changes** is told. Give the value to the receiver before or
immediately after; deliveries made after the call are signed with it and
the receiver rejects them until updated. Pending retries of earlier
deliveries are re-signed at send time.

## Procedure I: signing keys

- **OIDC**: rotates monthly on the scheduler. Watch
  `syntra_signing_key_expires_in_seconds`; the failure mode is silent.
- **SAML**: three-year keys, never rotated automatically.
  `rotateKey(tenantId, provider, 'saml')` in
  `packages/core/src/keys/signing-key-service.ts` is the only way, there is no
  console button or CLI for it, and every service provider that pasted the
  certificate must be re-configured afterwards. Plan it as a change with
  every SP owner.

## Procedure J: `GOVERN_CHECKPOINT_KEY`

Optional; signs Govern's audit checkpoints. `config.ts` documents turning it
on for the first time: the pre-existing unsigned checkpoint is refused once,
the chain is walked from genesis once, one `critical` finding is raised and
clears on the following run. Rotation from one key to another is not
documented in the code beyond `GOVERN_CHECKPOINT_KEY_ID` existing to name the
key. Expect the same one-time finding when the id changes, and keep the old
key until the checkpoint has been re-established under the new one.

## Procedure K: database role passwords (compose path)

1. `docker compose exec postgres psql -U syntra -c "ALTER ROLE syntra_app PASSWORD '<new>'"`.
2. Export the new `SYNTRA_APP_PASSWORD` and `docker compose up -d api`.
3. Verify `/health/ready` `database` probe passes.

`POSTGRES_PASSWORD` is read by the image only at first initialisation of the
volume; changing the variable afterwards does not change the role. Use
`ALTER ROLE syntra PASSWORD` and then update the variable so a future
re-initialisation matches.

## Verification (all procedures)

- `/health/ready` is ready.
- `GET /api/admin/incidents` shows nothing new.
- The audit log carries the rotation event where one exists
  (`api_token.*`, `notify.webhook_secret_rotated`, target and source
  update events).
- The old credential is refused where that can be tested (metrics token,
  API token).

## Rollback

Environment secrets: put the previous value back and restart. Stored
credentials: the previous value is not retrievable from Syntra; re-enter it
from the source system if it still exists there. Revoked API tokens cannot
be un-revoked; issue another.

## What this does not cover

- **Rotating `MASTER_KEY`** (not possible in place).
- **Dual-key windows** for `SESSION_SECRET`, `METRICS_TOKEN` or webhook
  secrets; each has one value at a time.
- **Automatic detection of an expiring Entra client secret.** Nothing reads
  the secret's expiry from Microsoft; the first signal is a run that fails.
