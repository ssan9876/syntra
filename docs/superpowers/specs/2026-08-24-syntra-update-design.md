# Syntra Update — Design

**Status:** implemented except the lab rehearsal; deviations in §13
**Date:** 2026-08-24
**Covers:** an administrator updating Syntra from inside Syntra — check, apply, verify, and roll back — for a self-hosted install.

---

## 1. The hazard this is designed around

Every other application can be updated carelessly, because if the update breaks it you go and fix it. Syntra cannot, for one reason:

> **Syntra is what you sign in with.** If an update breaks authentication, you cannot sign in to the console to undo it — and the SSO it fronts goes down with it. In this lab that is Snipe-IT; in a real deployment it is everything.

Three consequences run through every decision below.

**The updater cannot live inside the thing it replaces.** An update ends in a restart, so a process performing its own update dies halfway through it — after the migration, before the verification, with no record of where it stopped. The work has to happen somewhere that survives the restart.

**Rollback cannot require a human.** "Sign in and click Rollback" is exactly what a broken sign-in prevents. Recovery from a bad update must be something the updater does by itself, on evidence it collects itself, without anyone being awake.

**Verification has to be able to fail.** Which brings us to the thing that would have quietly made all of this decorative.

### 1.1 `/health` cannot gate an update

`apps/api/src/app.ts:122`, in full:

```ts
app.get('/health', async () => ({ status: 'ok' }));
```

It is a constant. It proves one thing — a process is listening on the port — and it proves that whether or not the database is reachable, the migration finished, the signing keys loaded, or anybody can log in. `deploy.sh` polls it today, which is fine for what `deploy.sh` is.

As the gate on an automatic rollback it is worse than useless: it would report every failed update as a success, roll back nothing, and leave the operator with a green check and a dead system. **An update gate needs a check that can fail**, and building one is a prerequisite, not a nicety (§6).

---

## 2. Where things stand

| | Today |
|---|---|
| Version | None. Every `package.json` is `0.0.0`; nothing at runtime knows what it is running |
| Releases | None. No tags, no artefacts, no release workflow |
| Distribution | `deploy.sh` pushes a tar of `git ls-files` from a developer's machine over ssh |
| Layout | The tree lives at `/root/syntra` and runs in place from source through `tsx` |
| Repo access | Private, and the host deliberately holds no credential for it |
| Health | A constant (§1.1) |
| Database | `postgres:16` in `infra-postgres-1`; no `pg_dump` on the host itself |
| Rollback | Restore the Proxmox snapshot |

Two of these are prerequisites rather than parts: **there is no version to compare** and **no artefact to fetch**. An update feature is mostly the machinery to create those.

`deploy.sh` is not replaced. It is how a developer iterates; this is how an operator updates. They coexist, and §7.4 says what happens when both have touched an install.

---

## 3. Decisions

### D1 — The updater is a separate unit, not a code path in the API

**Decision:** `POST /api/admin/update` records the request and launches a **transient systemd unit** (`systemd-run --unit=syntra-update --collect`) running `syntra-update`, a standalone script. The API returns immediately. The updater writes progress to a status file and an `UpdateRun` row; the console reads those.

**Why:** the alternative is the API updating itself, which cannot work. `systemctl restart syntra` kills the process performing the update at the exact moment the database has been migrated and the symlink not yet swapped — the least recoverable state the system can be in. Detaching it into its own unit means the updater outlives every restart it causes.

**Consequence accepted:** the updater is shell, not TypeScript, and is not covered by vitest. It gets its own tests (§10) in the same style as `syntra-reap.ps1` — pure functions lifted out of the shipped script, so the tests cannot pass against logic that was never shipped.

### D2 — Rollback is automatic, on a check that can fail

**Decision:** after the swap and restart, the updater polls a new **deep readiness endpoint** (§6) for up to 90 seconds. If it does not go green, the updater rolls back — symlink, database, restart — without asking anyone. The console's Rollback button exists for the *other* case: an update that is technically healthy and behaviourally wrong.

**Why:** §1. A rollback that needs a working login is not available in the failure it exists for.

**Deliberately not** rolled back on: HTTP 5xx rates, error-log volume, or anything else statistical. Those need a baseline and a window, and a wrong guess un-deploys a good release. Readiness is a yes-or-no question with a yes-or-no answer.

### D3 — Releases live beside each other; `current` is a symlink

```
/opt/syntra/
  releases/
    2026.08.1/        ← unpacked tarball, immutable
    2026.08.2/
  current -> releases/2026.08.2
  shared/
    .env              ← survives every update
    backups/          ← pre-migration dumps
  var/
    update.status     ← what the updater is doing right now
```

`WorkingDirectory=/opt/syntra/current/apps/api`. A swap is one `ln -sfn` and a restart; a rollback is the same in reverse. Configuration lives in `shared/` and is symlinked into each release, so an update never touches `.env` and a rollback never reverts it.

**Why not update in place** (what `/root/syntra` does today): an in-place update has no previous version to go back to. The old files are the ones being overwritten.

**Migration:** the installer moves the existing `/root/syntra` to `/opt/syntra/releases/<current>` and rewrites the unit. One-time, scripted, reversible, and it keeps `.env` byte for byte.

### D4 — The release token lives in the vault, not on disk

**Decision:** a fine-grained GitHub token, read-only, scoped to this one repository's contents, sealed with Syntra's existing `MASTER_KEY` vault and stored like every other credential. The updater receives it from the API at launch through an environment variable on the transient unit, and it is never written to a file.

**Why:** the repo is private, and the reason it has no credential on the host is written down in `deploy.sh` — "putting a credential that can read it on a machine whose whole job is to be experimented with trades a real secret for a convenience." A vault-sealed, read-only, single-repo token is a much smaller thing than a git credential: it can read release assets and nothing else, it cannot write, and it is revocable from GitHub without touching the host.

**Not** a `~/.netrc`, and **not** `git clone`. The host never gains the ability to read source history.

### D5 — Dump before migrating, always, and keep three

**Decision:** before `prisma migrate deploy`, the updater takes `docker exec infra-postgres-1 pg_dump -Fc`, verifies it is non-empty and restorable-looking, and only then migrates. Three dumps are kept; older ones are deleted.

A dump that fails **aborts the update**. Migrating without one is the single step in this design that cannot be undone, and "the backup failed so we went ahead" is how that becomes permanent.

**Why keep the dump at all when Proxmox snapshots exist:** a snapshot restores the whole machine, including the six containers and anything else that happened since. This restores the one database the update touched, in about a second, which is the difference between rolling back an update and rolling back an evening.

---

## 4. Versions

**Tags are `v<MAJOR>.<MINOR>.<PATCH>`**, and the tag is the only source of a version number. CI writes `VERSION` and `RELEASE.json` into the tarball root; nothing computes a version at runtime.

```json
{
  "version": "1.4.0",
  "released": "2026-08-24T19:02:11Z",
  "commit": "5f63f3e…",
  "migrations": ["20260824020657_directory_writeback"],
  "notes": "…markdown, from the tag message…"
}
```

`migrations` is the list of migration directories this release adds that the previous one did not. The console shows it, because "this update changes the database" is the one fact that decides whether an operator does it now or on Saturday.

**A tree with no `VERSION` file reports itself as `dev`**, never as a number. A development checkout and `deploy.sh` both produce one, and an install that claims to be `1.4.0` when it is a developer's working tree is an install whose update history is fiction. `dev` cannot be updated from the console; it says so and points at `deploy.sh`.

---

## 5. The release pipeline

A second workflow, `release.yml`, on tags matching `v*`:

1. Reuse CI's checks. **A tag whose tests fail produces no release** — the point of an update button is that what it installs was tested.
2. `pnpm install --frozen-lockfile`, then `pnpm --filter @syntra/web build`, so the tarball carries a **built** web bundle. `deploy.sh` rebuilds on the host today; an update must not depend on a build toolchain being present, or on it succeeding at 2am.
3. Assemble the runtime tree: `git ls-files` minus `docs/**`, `e2e/**`, `.github/**`, `*.md` — the same exclusions `deploy.sh` already applies — plus `apps/web/dist`, `VERSION` and `RELEASE.json`.
4. `tar -czf syntra-<version>.tar.gz`, and a `.sha256` beside it.
5. `gh release create` with both assets and the notes.

`node_modules` is **not** in the tarball. It is platform- and architecture-specific, it would multiply the artefact by two orders of magnitude, and `pnpm install --frozen-lockfile` on the host is both faster and correct. The updater runs it against the new release before the swap.

---

## 6. Readiness: a check that can fail

`GET /health` stays exactly as it is — a liveness probe for the tunnel and for `deploy.sh`, and it should stay cheap and constant.

`GET /health/ready` is new, unauthenticated, and answers a different question: **can this process do its job?**

| Probe | Why it is in the gate |
|---|---|
| `SELECT 1` through Prisma | the database is reachable *by this process*, with its pool and its credentials |
| No pending migrations | a half-applied schema is the characteristic bad update, and the process starts happily on one |
| Signing keys load and decrypt | proves `MASTER_KEY` still unseals the vault. Wrong or missing, every SAML and OIDC login fails while everything else looks perfect |
| One tenant resolves by hostname | the request path that every browser takes actually resolves |

200 with per-probe detail when all pass, **503 with the failing probe named** otherwise. Unauthenticated because the updater has no session and cannot get one — and it exposes nothing an unauthenticated caller could not learn by trying to log in.

This is the only part of the design that is useful on its own even if the rest is never built: it turns "the service is up" into "the service works," which is a different claim and the one people actually mean.

---

## 7. The update, step by step

`syntra-update <version>`, in order, writing each step to `var/update.status`:

1. **Refuse to start** if another update is running (lock file), if the tree is `dev`, or if the target is not newer.
2. **Download** the tarball and its `.sha256` from the release, with the vault token.
3. **Verify** the checksum. A mismatch aborts before anything is unpacked.
4. **Unpack** to `releases/<version>.partial`, then rename into place — so a failed download never leaves a half-tree that looks like a release.
5. **Link** `shared/.env` into the new release.
6. **Install** `pnpm install --frozen-lockfile` inside the new release.
7. **Dump** the database (D5). Abort if it fails.
8. **Migrate** with `prisma migrate deploy`.
9. **Swap** `current` and restart `syntra`.
10. **Verify** `/health/ready` for up to 90s.
11. **On failure: roll back** — repoint `current`, restore the dump, restart, and re-verify. Record the failure and the reason.
12. **Prune** to the last three releases and three dumps.

Steps 1–7 change nothing that a rollback cannot undo; the update is abortable up to step 8 with no consequence at all.

### 7.1 The window where it is genuinely down

Between step 9 and a green step 10, Syntra is restarting and sign-in does not work — a few seconds normally, up to 90 in the bad case, plus the rollback. That is the honest cost and the console says so before the operator commits: *"Signing in will stop working for about a minute."* An update button that implies no downtime is one people press during the working day.

### 7.2 What is not rolled back

The database dump restores the schema and the data. It does **not** restore anything that happened between the dump and the rollback — a login, a sync run, a provisioning action. The window is minutes, and this is stated rather than papered over.

### 7.3 Migrations that a rollback cannot help with

`prisma migrate deploy` is forward-only, which is why D5 dumps instead of relying on down-migrations. But a release that drops a column and then serves traffic has *already* lost that data at step 8; the dump is what makes it recoverable, and only if the restore actually runs. This is the reason step 7 aborts rather than warns.

### 7.4 When `deploy.sh` and the updater meet

A developer push writes into `current`, so the running tree no longer matches its release. The updater notices (it hashes the release manifest) and reports the install as **modified**, refusing to update over it unless `--force` is given — an update would silently discard the pushed work, and discovering that later is worse than being stopped now.

---

## 8. Data model and services

```prisma
model UpdateRun {
  id           String    @id @default(uuid()) @db.Uuid
  tenantId     String    @db.Uuid
  fromVersion  String
  toVersion    String
  status       String    // requested | running | verifying | succeeded | rolled_back | failed
  step         String?   // the step it is on or stopped at
  detail       String?
  requestedBy  String    @db.Uuid
  startedAt    DateTime  @default(now())
  finishedAt   DateTime?
}
```

One tenant's administrator updating the whole installation is a real wrinkle: this is a **deployment-wide** action recorded in a tenant-scoped table. It is recorded against the tenant whose administrator asked, and the permission required is a new deployment-level one rather than an ordinary tenant permission. A multi-tenant install where one customer's admin can restart everyone is not a thing to build by accident.

Core: `checkForUpdate()` (queries the release API, caches for an hour), `requestUpdate()` (launches the unit), `updateStatus()` (reads the status file and the row), `requestRollback()`.

---

## 9. API and console

| Route | Purpose |
|---|---|
| `GET /api/admin/update` | current version, latest available, notes, whether it migrates, install state |
| `POST /api/admin/update` | start it; 409 if one is running, 422 if the tree is `dev` or modified |
| `GET /api/admin/update/status` | poll while it runs |
| `POST /api/admin/update/rollback` | go back to the previous release deliberately |

**Console**, under Settings → Updates: the running version, what is available with its notes, an explicit warning when the release migrates, the downtime sentence from §7.1, and a confirm that names both versions. While it runs, the step it is on — and a page that expects to lose its connection mid-way and reconnect, because it will.

---

## 10. Testing

- **Pure shell functions** lifted out of `syntra-update` by the test harness, as `syntra-reap.Tests.ps1` does: version comparison, the modified-tree detection, retention pruning.
- **A full rehearsal** against a scratch install in a container: update, break the new release deliberately (a migration that fails; a release whose readiness never goes green), and assert the rollback restored both code and data.
- **`/health/ready`** unit tests: each probe fails independently and is named in the 503.
- **Mutation checks**, per this repo's habit: make the dump step non-fatal and the abort test must fail; gate the rollback on `/health` instead of `/health/ready` and the broken-update test must fail.

---

## 11. Out of scope

- **Updating anything but Syntra.** Not the OS, not Postgres, not the containers.
- **Unattended updates.** Chosen deliberately: an administrator decides when.
- **Downgrades** to an arbitrary older version. Rollback goes to the release you came from, which is the only one whose database dump exists.
- **Zero-downtime.** It needs two processes, a shared session store and a migration discipline that permits old and new schemas at once. Worth doing later; not worth pretending now.

---

## 12. Order of work

1. **`/health/ready`.** The prerequisite, and useful alone.
2. **Version file, `RELEASE.json`, and reporting the running version** in the API and console.
3. **`release.yml`** — tagging produces a tested, checksummed artefact.
4. **The release layout and its one-time migration** from `/root/syntra`.
5. **`syntra-update`**, with its rollback, plus tests.
6. **Core, API and console.**
7. **Lab rehearsal**, including deliberately breaking a release.

Steps 1 and 2 stand alone and ship first. Nothing before step 5 can break an existing install.

---

## 13. What changed during implementation

**The release token is configuration, not a vault secret.** §D4 proposed the
vault; the vault turned out to be the wrong home. It is *tenant*-scoped, and
this is a deployment-wide secret — filing it under whichever tenant's
administrator happened to configure it would make one customer's keyring the
thing the whole installation depends on, and would leave the updater guessing
which tenant to read. It sits in `.env` beside `MASTER_KEY` instead, which is
the key that unseals that vault: anybody who can read the file already holds
strictly more than this token grants, and what it grants is read-only access to
release assets in one repository. `RELEASE_REPO`, `RELEASE_TOKEN` and
`RELEASE_ROOT`, all optional — an install that sets none simply has no update
button, which is right for a development checkout.

**`UpdateRun` was not built.** The design gave it a table; the updater's status
file plus the two audit events (`deployment.update_requested`,
`deployment.rollback_requested`) carry everything the console actually reads,
and the table would have been a second record of the same thing that the
updater cannot write to — it runs detached, outside the API, with no Prisma
client and no tenant context. The audit trail answers "who asked, and when";
the status file answers "what is it doing"; nothing asked a question needing a
third.

**`deployment.manage` is a new permission** rather than a reuse of
`tenant.manage`. Not in the original text, and it should have been: one
tenant's administrator restarting the installation, migrating everybody's
database and signing everybody out is not the same authority as configuring
their own tenant. In a single-tenant deployment the two are held by the same
person and this costs nothing; in a shared one, conflating them is a mistake
that only becomes visible after somebody makes it.

**Migrations are not listed before download.** `RELEASE.json` carries them, but
`RELEASE.json` is inside the tarball — so until a release is fetched, the
console cannot say whether it migrates. It says nothing rather than "none":
claiming a release does not touch the database when nobody has looked is the
wrong way round to be wrong. The confirmation warns about database changes
unconditionally instead.

**The old tree is copied, not moved, by `syntra-install`.** Recovery from a bad
conversion is then pointing systemd back at a tree that is still sitting there
— a one-line change somebody can make over a serial console — rather than
restoring a backup.
