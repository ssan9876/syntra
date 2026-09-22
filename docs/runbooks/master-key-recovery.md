# Master-key recovery

## Purpose

What to do when `MASTER_KEY` is missing, wrong, or does not match the key a
backup was taken under. Read this whole page before acting: the wrong move
here is a restore that reports success and has quietly made every stored
credential unusable.

## The facts

- `MASTER_KEY` is 32 random bytes, base64, supplied by the environment
  (`shared/.env` on the release layout, the `MASTER_KEY` variable on the
  compose path, the `syntra-runtime` Secret under Helm). The API refuses to
  start without a well-formed one (`packages/core/src/config.ts`).
- It is never stored in the database. The backup manifest records a salted
  SHA-256 fingerprint of it, and nothing else.
- Every stored secret is a row in the `Secret` table sealed with a per-secret
  data key, and that data key is wrapped under `MASTER_KEY` with AES-256-GCM
  (`packages/core/src/vault/master-key.ts`, `vault-service.ts`). GCM
  authenticates, so a wrong key produces a loud decryption error, not garbage.
- **There is no key-rotation or re-wrap tool.** `vault-service.ts` notes that
  the two-layer design would allow rotating the master key by re-wrapping data
  keys; nothing in the repository implements that. There is no CLI, no route,
  and no migration that re-wraps `Secret` rows.
- Readiness checks the key on every `/health/ready`: the `vault` probe unseals
  one active signing key per tenant and fails if it cannot
  (`packages/core/src/health/readiness.ts`). `syntra_readiness` goes to 0 and
  `SyntraNotReady` fires after five minutes.

## Which secrets live under the key

Every `putSecret` caller in `packages/core/src`. If the key is gone, each of
these has to be re-entered or re-issued:

| Secret | Written by | How to re-enter |
|---|---|---|
| Provisioning target credential: AD bind password, SCIM bearer token, or Entra/HTTP client secret (`bindPassword`) | `provision/target-service.ts` | Console **Target systems → the target**, credential field, Save; or `PATCH /api/admin/targets/:id` with `bindPassword` |
| Directory source bind password | `sync/source-service.ts` | Console **Sources → the source**; or `PATCH /api/admin/sources/:id` with `bindPassword` |
| Person (HR feed) source credential | `person-source/source-service.ts` | Console **Sources → the person source**; or `PATCH /api/admin/person-sources/:id` |
| Upstream identity provider client secret | `federation/upstream-service.ts` | No console screen for upstreams (see [Configure](../configure.md)); re-create the upstream through its API |
| Signing keys, SAML and OIDC (private key PEM) | `keys/signing-key-service.ts` | New keys must be minted (`rotateKey(tenantId, provider, 'saml')` has no console button; OIDC keys rotate monthly on the scheduler). Every SAML service provider that pinned the old certificate must be given the new metadata |
| Webhook endpoint signing secrets | `notify/webhook-service.ts` | `POST /api/admin/webhooks/:id/secret` returns a new secret once; give it to the receiver |
| TOTP secrets for every enrolled user | `auth/mfa/totp.ts` | Users must re-enrol; an administrator removes the dead factor with `DELETE /api/admin/users/:id/factors/:type` |
| Federation PKCE verifiers | `federation/federation-request-service.ts` | Transient; in-flight sign-ins fail once and users retry |
| Initial passwords sealed for delivery by an apply | `provision/apply.ts` | Not recoverable; the account gets a new password on the next create or reset |

Add to that everything the `Secret` table holds that this list has not
caught up with:

```bash
docker exec -i <PG_CONTAINER> psql -U <PG_ROLE> -d <PG_DB> -tA \
  -c 'SELECT "tenantId", name FROM "Secret" ORDER BY 1,2'
```

The `name` column is the inventory of what has to be re-entered.

## When to use

- `syntra-backup restore` prints `this backup was taken under a different MASTER_KEY`.
- `syntra-backup list` shows `KEY MISMATCH` or `unknown` beside the backup you need.
- `/health/ready` reports the `vault` probe failed after a host rebuild, an
  `.env` edit, a Secret rotation under Helm, or a restore.
- The key file or secret store is known to be lost.

## Prerequisites

- Access to wherever the key was backed up (password manager, KMS, sealed
  envelope). This runbook cannot substitute for that.
- Root on the host, or `kubectl` on the namespace.
- A current backup of the database in its present state
  (`syntra-backup create`), before any change.

## Procedure A: the key is wrong, not lost

The commonest case: a rebuilt host, a copied `.env` with a fresh placeholder,
a Helm Secret recreated with a new value.

1. **Confirm the symptom.**

   ```bash
   curl -s http://127.0.0.1:3000/health/ready
   ```

   `vault` is `fail`. The wire detail is redacted; the cause is in the log:

   ```bash
   journalctl -u syntra -n 200 --no-pager | grep -i vault
   ```

2. **Compare fingerprints without exposing the key.** `syntra-backup list`
   shows `KEY ok` beside any backup taken under the key now running. If every
   recent backup says `MISMATCH`, the running key is the odd one out.

3. **Put the original key back.** Release layout: edit
   `/opt/syntra/shared/.env`, then `systemctl restart syntra`. Compose:
   export the correct `MASTER_KEY` and `docker compose up -d api`. Helm:
   update the `MASTER_KEY` key in the `syntra-runtime` Secret and restart the
   `api` Deployment.

4. **Verify** as in [Verification](#verification).

Never "fix" a mismatch by generating a new key. A new key runs, passes every
probe on a fresh install, and unseals nothing that already exists.

## Procedure B: a restore refuses over the fingerprint

```
syntra-backup: this backup was taken under a different MASTER_KEY
  backup:  sha256:9f2b…
  running: sha256:41c7…
```

1. **Stop.** The refusal is the control working. Do not add
   `--accept-secret-loss` yet.
2. Work out which key the backup expects: the fingerprint is
   `sha256(salt || key)` with the fixed salt `syntra-backup-fingerprint-v1`,
   so any candidate key can be checked against the manifest without restoring:

   ```bash
   printf '%s%s' 'syntra-backup-fingerprint-v1' "$CANDIDATE_KEY" | sha256sum
   ```

   Compare with `masterKeyFingerprint` in
   `/opt/syntra/backups/<name>/manifest.json`.
3. Install the matching key (Procedure A, step 3), then restore normally
   with [Backup and restore, Procedure D](backup-and-restore.md#procedure-d-restore-the-live-database).

## When the original key is genuinely gone

There is no recovery of the sealed values. The choice is between the database
without its secrets and no database.

1. **Decide, and record who decided.** This is an incident; open one
   ([Incident response](incident-response.md)).
2. **Generate a new key** once, and back it up before using it:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. **Restore with the override**, if a restore is what you were doing:

   ```bash
   /opt/syntra/bin/syntra-backup restore <name> --yes --accept-secret-loss
   ```

   If the database is simply running under a lost key, there is nothing to
   restore; install the new key and restart.

4. **Clear the unreadable rows.** A `Secret` row that cannot be unsealed
   throws when read. The readiness `vault` probe fails on the first active
   signing key it tries, so the deployment will report not-ready until the
   signing keys are replaced. Re-enter or re-issue every item in the
   [inventory](#which-secrets-live-under-the-key), in this order:
   1. Signing keys, so SSO returns.
   2. Target and source credentials, so provisioning and sync return
      (test each: **Test connection**).
   3. Webhook secrets, then tell each receiver.
   4. Upstream IdP secrets.
   5. Announce TOTP re-enrolment to users.

5. **Take a fresh backup** so the first backup under the new key exists, and
   confirm `syntra-backup list` shows `KEY ok` for it.

## Verification

- `GET /health/ready`: `vault` is `pass`.
- `syntra_readiness` back to 1; `SyntraNotReady` resolves.
- **Target systems → each target → Test connection** succeeds.
- One SAML and one OIDC sign-in succeed.
- `syntra-backup create` then `syntra-backup list` shows `KEY ok` for the new
  backup.

## Rollback

Procedure A's rollback is restoring the previous `.env` (or Secret) value and
restarting. Procedure B changes nothing until a restore runs.
`--accept-secret-loss` has no rollback: the values are gone. That is why the
runbook insists on a backup of the current state first and a written
decision.

## What this does not cover

- **Rotating a working key.** There is no tool. The design would allow
  re-wrapping data keys under a new master key without touching ciphertext;
  it is not built. Until it is, "rotate `MASTER_KEY`" means the full
  re-entry above, planned as a change rather than an incident.
- **A KMS-backed provider.** `MasterKeyProvider` is an interface; only the
  local provider exists.
- **`SESSION_SECRET` and `GOVERN_CHECKPOINT_KEY`.** Different keys, different
  consequences; see [Secret rotation](secret-rotation.md).
