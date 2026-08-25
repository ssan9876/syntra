# Remediation 5 — The Update Feature: Make It Able To Install A Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a feature that cannot complete a single update into one that can, and then prove it — by updating a scratch install, breaking two releases on purpose, and asserting the rollback put both the code and the data back.

**Architecture:** Eleven tasks. Tasks 1–2 close the two blockers that end *every* update in a rollback (no `DATABASE_URL` at the migrate step, no generated Prisma client) and the one that means nobody can press the button in the first place (`deployment.manage` is held by no role). Tasks 3–4 give the only deployment that exists — a converted in-place tree — a path to its first release and a `WEB_ROOT` that survives the conversion. Task 5 makes the rollback an actual restore. Task 6 stops the updater assuming one port, one container name and one database role. Tasks 7–10 are the ordering bug, the readiness endpoint, the console's polling, and the six smaller ones. Task 11 is the rehearsal the design has been waiting on, including the two mutation checks §10 asks for, and it is the gate on any of this touching the live lab.

**Tech Stack:** Bash (the updater and installer; tested by `ops/syntra-update.test.sh`, which sources the shipped script), TypeScript (ESM, strict, `exactOptionalPropertyTypes`), Prisma + PostgreSQL, React + vitest/jsdom for the console, systemd and Docker on the target, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-24-audit-findings.md` §5 (U1–U10 and the six lower-severity findings listed at the end of it), against the design in `docs/superpowers/specs/2026-08-24-syntra-update-design.md` — §7 (the twelve steps), §10 (testing), §12 step 7 (the rehearsal), §13 (what changed during implementation).

## Global Constraints

- Node `>=22`; pnpm pinned to `9.12.0` via `packageManager`. Never run `npm` or a different pnpm.
- The root vitest suite takes ~155 minutes at `SYNTRA_TEST_WORKERS=4`. **Never run the whole suite to check one change** — run the specific file, e.g. `npx vitest run packages/core/src/update/update-service.test.ts`.
- **The working tree is not clean and is not yours alone.** Another session is mid-TDD on `packages/core/src/auth/password-reset.test.ts`. Never `git add -A`, never `git commit -a`, and never stage that file. Stage only the exact paths each task names.
- `npx tsc -b` must exit 0 at every commit, and `pnpm --filter @syntra/web build` must stay green.
- **`bash -n` every shell file you edit, every time**, before running anything else: `bash -n ops/syntra-update ops/syntra-install`. A syntax error in the updater is discovered at 2am by a system that has already migrated its database.
- `ops/syntra-update.test.sh` is fast (under a second) and hermetic. Run it after every edit to the updater: `bash ops/syntra-update.test.sh`. It currently reports `24 passed, 0 failed`.
- The test harness **sources the shipped script** (`SYNTRA_UPDATE_SOURCE_ONLY=1`), which means `set -euo pipefail` is in force inside the harness too. A new assertion that calls a helper expected to return non-zero must wrap it — `"$(pg_url_field db "$url" || echo ERR)"` — or the harness exits mid-file and reports a pass count that looks fine.
- **The updater runs detached, under `systemd-run`, and must never assume the API process survives.** It has no Prisma client, no tenant context, no session and no way to ask anybody anything. Everything it needs it reads from `shared/.env` or from its own arguments, and everything it reports it writes to `var/update.status`.
- Anything the updater writes to `var/update.status` is read by the console. A new step name means a new entry in `IN_FLIGHT` (`packages/core/src/update/update-service.ts`) **and** in `STEP_TEXT` (`apps/web/src/pages/admin/UpdatesPage.tsx`), or the console shows a raw slug and decides the update has stopped.
- **Nothing in this plan may be exercised against the live lab (192.168.88.20, `/root/syntra`, `infra-postgres-1`, the `syntra` unit) until Task 11 passes against a scratch install.** Not the updater, not `syntra-install`, not the migration. Task 11 runs on the lab host but against its own root, its own unit, its own port and its own database, and it asserts the live install is untouched before it starts and after it finishes.
- Commit messages: lower-case type prefix, imperative, no trailing period — e.g. `fix(update): give the migrate step the DATABASE_URL it has never had`.

---

### Task 1: Give the migrate step a `DATABASE_URL`, and a client to run against

**Closes U1 and U2.** These are one task because they are one failure: the release unpacks, and then nothing in it can reach the database. `prisma migrate deploy` runs with its cwd set to `packages/db`, where the Prisma CLI reads `.env` — and `packages/db/.env` is gitignored, so it is not in the tarball and never will be. Only the root `.env` is symlinked, and the CLI does not look there. Every console update fails at `migrating` and rolls back. If it did not, the release would still boot without a generated client: `node_modules` is excluded from the tarball and `@prisma/client`'s postinstall cannot find `packages/db/prisma/schema.prisma` from the release root, so the first query throws `@prisma/client did not initialize yet`, readiness stays 503 for 90 s, and the rollback discards whatever was written in between.

Both fixes need one thing the updater does not have: the deployment's connection string. It reads it out of `shared/.env` — the same file the service itself is started with — through a helper that parses rather than sources.

**Files:**
- Modify: `ops/syntra-update` — new pure helpers in the block at lines 43–78; new `resolve_environment` beside the other I/O functions; the `installing` and `migrating` steps at lines 219–230; `main` at lines 324–338.
- Modify: `ops/syntra-update.test.sh` — new sections for `env_value` and `pg_url_field`.
- Modify: `packages/core/src/update/update-service.ts` — the `IN_FLIGHT` set at lines 41–51.
- Modify: `apps/web/src/pages/admin/UpdatesPage.tsx` — the `STEP_TEXT` map at lines 28–41.

**Interfaces:**
- Consumes: `$SHARED/.env` (`/opt/syntra/shared/.env`), which `syntra-install` created and every release symlinks to.
- Produces:
  - `env_value KEY FILE` → prints the value of `KEY`, or nothing. **Always exits 0**, including when the file does not exist; an absent key and an empty key are the same answer and the caller decides what it means.
  - `pg_url_field FIELD URL` where `FIELD` is `user` or `db` → prints the field, exit 0; exit 1 when the URL does not carry it; exit 2 for an unknown field name.
  - `resolve_environment` → sets the globals `DB_URL` and `SHADOW_URL`. Calls `die` when `DATABASE_URL` cannot be found. Task 6 extends this same function.
  - A new status step, `generating`, between `installing` and `backing-up`.

- [ ] **Step 1: Write the failing tests for the two parsers**

Add to `ops/syntra-update.test.sh`, after the `status_line` section and before `# --- report ---`:

```bash
# --- env_value --------------------------------------------------------------
#
# The updater has to learn the deployment's connection string, its port and its
# container name from the same file the service is started with. It must NOT
# learn them by sourcing it: that file holds MASTER_KEY and RELEASE_TOKEN, whose
# values are chosen by base64 and by GitHub rather than by anybody thinking
# about shell quoting.

ENVFILE="$(mktemp)"
cat > "$ENVFILE" <<'EOF'
# A comment, and a commented-out key that must not be found.
# PORT=9999
DATABASE_URL=postgresql://syntra_app:syntra_app@localhost:5432/syntra
PORT=3000
QUOTED="quoted value"
SINGLE='single value'
export EXPORTED=exported
TRAILING=value   
EOF

ok "reads a plain value"        "$(env_value DATABASE_URL "$ENVFILE")" \
  "postgresql://syntra_app:syntra_app@localhost:5432/syntra"
ok "reads a numeric value"      "$(env_value PORT "$ENVFILE")" "3000"
ok "strips double quotes"       "$(env_value QUOTED "$ENVFILE")" "quoted value"
ok "strips single quotes"       "$(env_value SINGLE "$ENVFILE")" "single value"
ok "reads an exported key"      "$(env_value EXPORTED "$ENVFILE")" "exported"
ok "strips trailing whitespace" "$(env_value TRAILING "$ENVFILE")" "value"
ok "ignores a commented key"    "$(env_value PORT "$ENVFILE")" "3000"
ok "an absent key is empty"     "$(env_value NOPE "$ENVFILE")" ""
# Not an error: an install may legitimately not have the file yet, and the
# caller decides what a missing value means. Exiting non-zero here would take
# the whole updater down under `set -e` for a key nobody required.
ok "an absent file is empty"    "$(env_value PORT /nonexistent/env)" ""
rm -f "$ENVFILE"

# --- pg_url_field -----------------------------------------------------------
#
# The dump, the restore and the migration all need to know WHICH database, and
# the answer is in DATABASE_URL rather than in this script.

PGURL="postgresql://syntra_app:s3cr3t@localhost:5432/syntra"
ok "reads the role"    "$(pg_url_field user "$PGURL")" "syntra_app"
ok "reads the database" "$(pg_url_field db  "$PGURL")" "syntra"
ok "drops query parameters" \
  "$(pg_url_field db 'postgresql://u:p@h:5432/syntra?schema=public&sslmode=require')" "syntra"
ok "reads a url with no password" "$(pg_url_field user 'postgresql://syntra@h:5432/syntra')" "syntra"
# Refused rather than guessed. A default database name is how a restore lands
# somewhere nobody chose.
ok "refuses a url with no database" "$(pg_url_field db 'postgresql://u:p@h:5432' || echo ERR)" "ERR"
ok "refuses a url with no role"     "$(pg_url_field user 'postgresql://h:5432/syntra' || echo ERR)" "ERR"
ok "refuses an unknown field"       "$(pg_url_field port "$PGURL" || echo ERR)" "ERR"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash ops/syntra-update.test.sh`

Expected: the harness aborts with `env_value: command not found` — the helpers do not exist yet.

- [ ] **Step 3: Add the two parsers to the pure block**

In `ops/syntra-update`, insert immediately after `status_line()` (line 78) and before the `# --- everything below does I/O ---` banner:

```bash
# The value of KEY in an env file, WITHOUT sourcing it.
#
# `. "$SHARED/.env"` would EXECUTE that file, and it holds MASTER_KEY and
# RELEASE_TOKEN -- values produced by base64 and by GitHub, not by anybody
# thinking about shell quoting. Sourcing it to learn a port number is a way to
# run whatever a stray backtick happens to spell, as root, from a unit nobody
# is watching.
#
# Always exits 0, including for a file that does not exist. An absent key and
# an empty key are the same answer here, and the CALLER decides what that
# means -- a missing PORT is a default, a missing DATABASE_URL is fatal.
env_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}${key}[[:space:]]*=[[:space:]]*\(.*\)\$/\2/p" "$file" \
    | tail -1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# One field out of a PostgreSQL connection URL.
#
#   pg_url_field user postgresql://syntra_app:pw@localhost:5432/syntra -> syntra_app
#   pg_url_field db   postgresql://syntra_app:pw@localhost:5432/syntra -> syntra
#
# Refuses rather than defaults. `pg_dump -d syntra` when the URL named
# something else is a backup of the wrong database, and it looks like a
# backup right up to the moment it is restored over the right one.
pg_url_field() {
  local field="$1" url="$2" rest
  rest="${url#*://}"
  case "$field" in
    user)
      case "$rest" in
        *@*) rest="${rest%%@*}"; printf '%s\n' "${rest%%:*}"; return 0 ;;
        *)   return 1 ;;
      esac
      ;;
    db)
      case "$rest" in
        */*)
          rest="${rest#*/}"
          rest="${rest%%\?*}"
          [ -n "$rest" ] || return 1
          printf '%s\n' "$rest"
          return 0
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 2 ;;
  esac
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash ops/syntra-update.test.sh`

Expected: `40 passed, 0 failed`.

- [ ] **Step 5: Resolve the database configuration once, after the lock**

In `ops/syntra-update`, add after `swap_to()` (which ends at line 180) and before the `# --- the update ---` banner:

```bash
# What this deployment's database actually is, read from the configuration the
# SERVICE is started with rather than assumed.
#
# `resolve_environment` is called from main(), after the lock and never at
# source time: the test harness sources this file to reach the pure helpers
# above, and a script that read files on import would make the tests depend on
# a machine that has been installed.
DB_URL=""
SHADOW_URL=""

resolve_environment() {
  DB_URL="${SYNTRA_DATABASE_URL:-$(env_value DATABASE_URL "$SHARED/.env")}"
  [ -n "$DB_URL" ] \
    || die "no DATABASE_URL in $SHARED/.env, so the migration step has nothing to connect to"

  # Named in the datasource block, so the schema does not LOAD without it --
  # even though `migrate deploy` never connects to it and only `migrate dev`
  # does. Falling back to the real URL is therefore correct rather than a
  # compromise: nothing will open it.
  SHADOW_URL="${SYNTRA_SHADOW_DATABASE_URL:-$(env_value SHADOW_DATABASE_URL "$SHARED/.env")}"
  [ -n "$SHADOW_URL" ] || SHADOW_URL="$DB_URL"
}
```

- [ ] **Step 6: Call it from `main`**

In `ops/syntra-update`, in `main()`, immediately after the `flock -n 9 || die …` line (line 335) and before the `if [ "$1" = "--rollback" ]` line:

```bash
  resolve_environment
```

- [ ] **Step 7: Generate the client after installing, and pass the URL to both Prisma invocations**

In `ops/syntra-update`, replace lines 219–230 (from `status "installing"` through the `migrating` block) with:

```bash
  status "installing" "installing dependencies"
  ( cd "$dir" && pnpm install --frozen-lockfile --prod=false ) \
    || die "dependencies could not be installed for v$target"

  status "generating" "generating the database client"
  # U2. `node_modules` is deliberately not in the tarball, and @prisma/client's
  # postinstall cannot find packages/db/prisma/schema.prisma from the release
  # root -- so `pnpm install` alone leaves a release whose every query throws
  # "@prisma/client did not initialize yet". The API starts fine, `/health`
  # answers 200 throughout, readiness stays 503 for the full 90 seconds, and
  # the rollback then discards anything written in between.
  #
  # Before the dump, deliberately: this is the last step that can fail with
  # nothing to undo.
  ( cd "$dir" && env DATABASE_URL="$DB_URL" SHADOW_DATABASE_URL="$SHADOW_URL" \
      pnpm --filter @syntra/db exec prisma generate ) \
    || die "the database client could not be generated for v$target"

  local dump="$BACKUPS/pre-$target-$(date -u +%Y%m%dT%H%M%SZ).dump"
  status "backing-up" "dumping the database"
  dump_database "$dump"

  status "migrating" "applying migrations"
  # In the NEW release: the migrations being applied are its own.
  #
  # DATABASE_URL is passed IN, and that is the whole of U1. The Prisma CLI
  # reads `.env` from ITS OWN working directory -- `packages/db`, under
  # `pnpm --filter` -- and `packages/db/.env` is gitignored, so it is not in
  # the tarball and never will be. The root `.env` symlinked into the release
  # is not in scope for it. Every console update reached this line and failed
  # with "Environment variable not found: DATABASE_URL", and every one of them
  # rolled back.
  ( cd "$dir" && env DATABASE_URL="$DB_URL" SHADOW_DATABASE_URL="$SHADOW_URL" \
      pnpm --filter @syntra/db exec prisma migrate deploy ) \
    || { restore_after_failure "$from" "$dump" "migrations failed"; }
```

Note the original `local dump=…` and `status "backing-up"` lines at 223–225 are folded into the replacement above; do not leave a second copy.

- [ ] **Step 8: Check the syntax and the tests**

```bash
bash -n ops/syntra-update && bash ops/syntra-update.test.sh
```

Expected: no output from `bash -n`, then `40 passed, 0 failed`.

- [ ] **Step 9: Teach the console the new step**

In `packages/core/src/update/update-service.ts`, in the `IN_FLIGHT` set (lines 41–51), add `'generating',` immediately after `'installing',`.

In `apps/web/src/pages/admin/UpdatesPage.tsx`, in `STEP_TEXT` (lines 28–41), add after the `installing` line:

```tsx
  generating: 'Preparing the database client',
```

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add ops/syntra-update ops/syntra-update.test.sh \
        packages/core/src/update/update-service.ts \
        apps/web/src/pages/admin/UpdatesPage.tsx
git commit -m "$(cat <<'EOF'
fix(update): give the migrate step a DATABASE_URL and a client to use

Two blockers, one failure: the release unpacks and then nothing in it can
reach the database.

The Prisma CLI reads `.env` from its own working directory, which under
`pnpm --filter @syntra/db` is packages/db -- and packages/db/.env is
gitignored, so it is not in the tarball and never will be. The root .env
symlinked into the release is not in scope for it. Every console update
reached `migrating`, failed with "Environment variable not found:
DATABASE_URL", and rolled back.

And node_modules is deliberately not shipped, so @prisma/client's
postinstall cannot find packages/db/prisma/schema.prisma from the release
root. Without an explicit `prisma generate` the new release booted, /health
answered 200, and the first query threw "did not initialize yet" until the
90s readiness deadline rolled it back.

Both need the connection string, which the updater now reads out of
shared/.env -- parsed, never sourced: that file holds MASTER_KEY and
RELEASE_TOKEN, and sourcing it to learn a port is a way to execute whatever
a stray backtick spells.
EOF
)"
```

---

### Task 2: Put `deployment.manage` in the hands of an existing install

**Closes U3.** The permission was added to the catalog, but `Role.permissions` is a stored snapshot written only by the seed — which exits early on an already-seeded database. There is no migration, no backfill and no role-editing API, so on the lab every `/api/admin/update` route answers 403 and the Updates page never renders. The only remedy today is hand-written SQL.

**The decision this task had to make.** Remediation plan 4 (H2) builds general role management: an API, and a backfill that re-syncs built-in roles to the catalog. That subsumes this — and this plan still owns a narrow migration, for three reasons. Plan 4 is not written yet and this plan must be landable without it. Plan 4's backfill grants *every* permission the catalog grew, which is a broader decision that wants the role editor beside it so somebody can review the result. And the two do not conflict: both are idempotent, and a permission already present is not appended twice. **If plan 4 lands first, this migration is a no-op and should still be applied** — it is the record of when the lab got the permission.

The rule is deliberately narrow: `deployment.manage` is granted only when the deployment has **exactly one tenant**. §13 of the design says why — one customer's administrator restarting the installation, migrating everybody's database and signing everybody out is not the same authority as configuring their own tenant. A backfill that handed it to every tenant's Owner would reproduce, by migration, exactly the conflation the permission exists to prevent. A multi-tenant install gets nothing here and chooses deliberately, through plan 4's role API.

**Files:**
- Create: `packages/db/prisma/migrations/20260905000000_deployment_manage_backfill/migration.sql`
- Modify (only if remediation plan 1 Task 5 has landed): `packages/db/src/migration-order.ts` — the `KNOWN_MIGRATIONS` array.

**Interfaces:**
- Consumes: the `Role` table (`permissions text[]`, `builtIn boolean`, RLS `tenant_isolation` with `FORCE`), and the `Tenant` table, which deliberately carries no RLS.
- Produces: no code symbols. After it, on a single-tenant install, every built-in role holding `tenant.manage` also holds `deployment.manage`.

- [ ] **Step 1: Confirm the name will not sort before what is already deployed**

```bash
ls packages/db/prisma/migrations | tail -3
```

Expected: the highest is `20260830000000_org_unit_status`. `20260831000000_…` sorts after it, which is the rule remediation plan 1 Task 5 encodes as `MIGRATION_NAME_FLOOR`.

- [ ] **Step 2: Write the migration**

Create `packages/db/prisma/migrations/20260905000000_deployment_manage_backfill/migration.sql`:

```sql
-- `deployment.manage` reaches a deployment that already exists.
--
-- Role.permissions is a STORED SNAPSHOT of the catalogue, written once by the
-- seed -- which returns early on an already-seeded database. So the permission
-- the update routes are gated on was held by nobody: every request answered
-- 403 and the Updates page was hidden from the person the feature was built
-- for, with raw SQL as the only remedy.
--
-- ONE TENANT ONLY, and that is the whole design of this backfill rather than a
-- limitation of it. This permission restarts the installation, migrates
-- everybody's database and signs everybody out for a minute. In a
-- single-tenant deployment its holder already had that power under
-- `tenant.manage` and nothing changes; in a shared one, handing it to every
-- tenant's Owner by migration would reproduce exactly the conflation the
-- permission was separated out to prevent. A multi-tenant install grants it
-- deliberately, through the role API, or not at all.
--
-- Built-in roles only. A role somebody wrote by hand is a role somebody chose
-- the permissions of, and a migration that edits it is a migration overruling
-- an administrator.
DO $$
DECLARE
  tenant_count integer;
  only_tenant  uuid;
  granted      integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  IF tenant_count <> 1 THEN
    RAISE NOTICE
      'deployment.manage was not granted: this deployment has % tenants, and choosing which one may restart the installation is not a decision a migration should make. Grant it deliberately.',
      tenant_count;
    RETURN;
  END IF;

  SELECT id INTO only_tenant FROM "Tenant";

  -- Role carries FORCE ROW LEVEL SECURITY and migrations run as syntra_app,
  -- which is NOSUPERUSER NOBYPASSRLS and therefore subject to its own
  -- policies. Without this the UPDATE below matches zero rows, commits
  -- happily, and reports success. `true` scopes the setting to this
  -- transaction, the same way withTenant does.
  PERFORM set_config('app.current_tenant', only_tenant::text, true);

  UPDATE "Role"
     SET permissions = array_append(permissions, 'deployment.manage')
   WHERE "builtIn"
     AND 'tenant.manage' = ANY(permissions)
     AND NOT ('deployment.manage' = ANY(permissions));

  GET DIAGNOSTICS granted = ROW_COUNT;
  RAISE NOTICE 'deployment.manage granted to % built-in role(s)', granted;
END $$;
```

- [ ] **Step 3: Keep the grandfather list honest, if it exists yet**

```bash
test -f packages/db/src/migration-order.ts && echo present || echo "plan 1 task 5 has not landed"
```

If present, add `'20260905000000_deployment_manage_backfill',` to the end of `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`. Its fourth test asserts the list still describes the directory, and would otherwise fail on a change that is not a defect.

- [ ] **Step 4: Apply it against a local database and prove it granted something**

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "SELECT name, 'deployment.manage' = ANY(permissions) AS has_it FROM \"Role\";"
```

Expected: `pnpm db:migrate` reports `1 migration applied`, and the `Owner` row shows `has_it = t`. If your local database has no tenants, the `NOTICE` says `0 tenants` and nothing is granted — seed first (`pnpm seed`) and re-apply on a fresh database.

- [ ] **Step 5: Prove it is idempotent**

```bash
psql "$DATABASE_URL" -c "SELECT array_length(permissions, 1) FROM \"Role\" WHERE name = 'Owner';"
```

Note the number. Then re-run the `DO $$ … $$;` block by hand:

```bash
psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260905000000_deployment_manage_backfill/migration.sql
psql "$DATABASE_URL" -c "SELECT array_length(permissions, 1) FROM \"Role\" WHERE name = 'Owner';"
```

Expected: the same number, and `NOTICE: deployment.manage granted to 0 built-in role(s)`. This is what makes it safe to run alongside plan 4's general backfill.

- [ ] **Step 6: Verify against the migration replay the readiness check uses**

Run: `npx vitest run packages/core/src/health/readiness.test.ts`
Expected: PASS. The migrations probe compares applied names against the directory; a new directory that is applied locally must not leave it reporting `pending`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma/migrations/20260905000000_deployment_manage_backfill/migration.sql
# Only if it exists and you edited it:
git add packages/db/src/migration-order.ts
git commit -m "$(cat <<'EOF'
fix(rbac): grant deployment.manage to an install that already exists

Role.permissions is a stored snapshot of the catalogue written once by the
seed, which returns early on an already-seeded database. The permission the
update routes are gated on was therefore held by nobody: every request
answered 403 and the Updates page was hidden from the person the feature
exists for, with hand-written SQL as the only way out.

Granted only when the deployment has exactly one tenant, and only to
built-in roles that already hold tenant.manage. Choosing which of several
customers' administrators may restart the installation, migrate everybody's
database and sign everybody out is not a decision to make by migration --
that is the conflation this permission was separated from tenant.manage to
prevent. A shared deployment grants it deliberately.

Sets app.current_tenant inside the transaction: Role is FORCE RLS and
migrations run as syntra_app, so without it the UPDATE matches nothing,
commits, and reports success.

The general case is H2, and remediation 4's role API and catalogue re-sync
subsume this. They do not conflict: both are idempotent, and this one is the
record of when the lab got it.
EOF
)"
```

---

### Task 3: A path from a converted install to its first release

**Closes U4.** `syntra-install` creates `releases/dev` with no `RELEASE.json`, so `current_version` reports `dev`; the updater refuses `dev` at line 189 and `checkForUpdate` refuses it too. `deploy.sh` never writes a `RELEASE.json` either. There is no route from the only deployment that exists to a first console update, and there is deliberately not going to be one *from the console* — a tarball unpacks cleanly over a working tree and takes uncommitted work with it silently.

So the path is a one-time command a person runs at a keyboard, exactly like `syntra-install`: `syntra-update --adopt <version>`. It runs the whole update — dump, migrate, swap, verify, roll back on failure — and differs in one respect only: it permits `dev` as the version it is coming *from*, and rolls back to `releases/dev` if the release does not come up.

The README's claim that the updater "notices a modified tree and refuses" is false — only `RELEASE.json` presence is checked. This task stops claiming it rather than implementing manifest hashing, which §7.4 describes and nothing implements.

**Files:**
- Modify: `ops/syntra-update` — the header comment (lines 17–19), `do_update` (lines 184–190), `main` (lines 324–338).
- Modify: `ops/syntra-install` — the closing message (lines 119–123).
- Modify: `ops/syntra-update.test.sh` — a new section for `adoption_allowed`.

**Interfaces:**
- Consumes: `current_version` (prints `dev` when `current/RELEASE.json` is absent), `version_valid`, `version_newer`.
- Produces:
  - `adoption_allowed FROM ADOPT` → exit 0 when this update may proceed. `ADOPT` is `1` or empty. Exit 1 when `FROM` is `dev` and `ADOPT` is not `1`. Pure; no I/O.
  - `syntra-update --adopt <version>` — a new invocation. `do_update` gains a second positional argument, `adopt`.

- [ ] **Step 1: Write the failing test**

Add to `ops/syntra-update.test.sh`, after the `version_valid` section:

```bash
# --- adoption_allowed -------------------------------------------------------
#
# A converted in-place tree is `dev`, and `dev` must never be updatable FROM
# THE CONSOLE: a tarball unpacks cleanly over a working tree and takes
# uncommitted work with it without saying so. But `dev` is also the only
# deployment that exists, so refusing it everywhere leaves no path to a first
# release at all. The path is a person at a keyboard passing --adopt.

ok "an ordinary release may be updated"    "$(yes_no adoption_allowed 1.4.0 '')" yes
ok "dev is refused without adoption"       "$(yes_no adoption_allowed dev '')" no
ok "dev is permitted with adoption"        "$(yes_no adoption_allowed dev 1)" yes
# --adopt is for the FIRST release only. Passing it on a real install would
# skip the is-this-newer check, which is the guard against installing a
# downgrade by typing the wrong number.
ok "adoption is refused on a real release" "$(yes_no adoption_allowed 1.4.0 1)" no
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash ops/syntra-update.test.sh`
Expected: the harness aborts with `adoption_allowed: command not found`.

- [ ] **Step 3: Add the helper to the pure block**

In `ops/syntra-update`, after `version_valid()` (line 63):

```bash
# May an update proceed from version $1, given whether --adopt was passed ($2)?
#
# `dev` is refused from the console and always will be: an install that is
# somebody's working tree has uncommitted work in it, and a tarball unpacks
# over that cleanly and silently. But a converted in-place install IS `dev` --
# syntra-install writes no RELEASE.json, because inventing a version number for
# a working tree is how an install comes to have a fictional update history --
# so a blanket refusal leaves the only deployment that exists with no route to
# a first release.
#
# --adopt is that route, and it is deliberately not reachable from the console:
# it is a one-time command run by a person who knows what is in the tree they
# are replacing, exactly like syntra-install. On a real release it is refused,
# because there it would only skip the is-this-newer check.
adoption_allowed() {
  local from="$1" adopt="${2:-}"
  if [ "$from" = "dev" ]; then
    [ "$adopt" = "1" ]
  else
    [ "$adopt" != "1" ]
  fi
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash ops/syntra-update.test.sh`
Expected: `44 passed, 0 failed`.

- [ ] **Step 5: Use it in `do_update`**

In `ops/syntra-update`, replace lines 184–190 (the head of `do_update`) with:

```bash
do_update() {
  local target="$1"
  local adopt="${2:-}"
  local from; from=$(current_version)

  version_valid "$target" || die "\"$target\" is not a version this will install"

  adoption_allowed "$from" "$adopt" \
    || if [ "$from" = "dev" ]; then
         die "this install is a working tree, not a release; push to it with deploy.sh, or adopt a release once with: syntra-update --adopt <version>"
       else
         die "--adopt is for a working tree taking its first release; this install is already v$from"
       fi

  # Skipped for an adoption and only for one: `dev` cannot be ordered against
  # a number -- that is what makes the comparison safe to trust everywhere
  # else -- so there is nothing here to compare and the operator naming the
  # version IS the decision.
  if [ "$from" != "dev" ]; then
    version_newer "$target" "$from" || die "$target is not newer than the running $from"
  fi
```

- [ ] **Step 6: Accept the flag in `main`**

In `ops/syntra-update`, replace `main()` (lines 324–338) with:

```bash
main() {
  local adopt=""
  case "${1:-}" in
    --check)    do_check; return ;;
    --rollback) : ;;
    --adopt)
      adopt=1
      shift
      [ -n "${1:-}" ] || refuse "usage: syntra-update --adopt <version>"
      ;;
    '')         refuse "usage: syntra-update <version> | --adopt <version> | --rollback | --check" ;;
  esac

  mkdir -p "$VAR"
  # One at a time. Two updaters sharing a symlink and a database is a way to
  # end up running neither version.
  exec 9>"$LOCK"
  flock -n 9 || refuse "another update is already running"

  resolve_environment

  if [ "$1" = "--rollback" ]; then do_rollback; else do_update "$1" "$adopt"; fi
}
```

`refuse` is added in Task 10 (the lock-loser must not overwrite the running update's status). Until then this will fail; if you are executing tasks out of order, add it now — it is four lines and Task 10's step for it becomes a no-op:

```bash
# Refused before anything started, so it does NOT touch update.status.
refuse() { log "REFUSED: $1"; exit 1; }
```

- [ ] **Step 7: Update the header comment**

In `ops/syntra-update`, replace lines 17–19 with:

```bash
#   syntra-update <version>          update to that release
#   syntra-update --adopt <version>  take a converted working tree to its first
#                                    release; by hand, once, not from the console
#   syntra-update --rollback         go back to the release we came from
#   syntra-update --check            print current and available, change nothing
```

- [ ] **Step 8: Say so at the end of the conversion**

In `ops/syntra-install`, replace lines 119–123 with:

```bash
    say "ready. Running from $ROOT/current"
    echo
    echo "The old tree is untouched at $SRC."
    echo "If anything is wrong: restore $UNIT.pre-release-layout, daemon-reload, restart."
    echo
    # This install is `dev` and the console will say so and refuse to update
    # it, which is correct -- but it means the Updates page cannot take it to
    # its first release either. This is the one-time command that can, run by
    # the person who knows what is in the tree it replaces.
    echo "This install reports itself as \"$VERSION\". A working tree cannot be updated"
    echo "from the console -- it would overwrite uncommitted work. To take it to its"
    echo "first release, once, by hand:"
    echo
    echo "    SYNTRA_RELEASE_TOKEN=… $ROOT/bin/syntra-update --adopt <version>"
    exit 0
```

- [ ] **Step 9: Stop the README claiming a check that does not exist**

```bash
grep -rn "modified tree" ops/ docs/ README.md 2>/dev/null
```

For each hit, replace the claim that the updater "notices a modified tree and refuses" with what it actually does: it refuses an install with no `RELEASE.json` — which covers a working tree and a `deploy.sh` push, and does **not** detect a push made on top of a release. §7.4's manifest hashing is not implemented and this plan does not implement it; say so rather than imply it.

- [ ] **Step 10: Check syntax, run the tests, commit**

```bash
bash -n ops/syntra-update ops/syntra-install && bash ops/syntra-update.test.sh
```

Expected: `44 passed, 0 failed`.

```bash
git add ops/syntra-update ops/syntra-update.test.sh ops/syntra-install
# plus any file step 9 changed
git commit -m "$(cat <<'EOF'
feat(update): a converted install can take its first release

syntra-install writes no RELEASE.json -- inventing a version number for a
working tree is how an install comes to have a fictional update history --
so a converted install is `dev`, and both the updater and checkForUpdate
refuse `dev`. There was no path at all from the only deployment that exists
to a first console update.

--adopt is that path, and deliberately not a console button: a tarball
unpacks over a working tree cleanly and silently, so the decision belongs to
a person who knows what is in the tree they are replacing. It is the same
update in every other respect -- dump, migrate, swap, verify, and roll back
to releases/dev if it does not come up. On an install that is already a
release it is refused, where it would only skip the is-this-newer guard.

syntra-install now ends by printing the command.

Also stopped the README claiming the updater "notices a modified tree and
refuses". It checks for RELEASE.json and nothing else; the manifest hashing
the design describes is not implemented, and a documented control that does
not exist is worse than an absent one.
EOF
)"
```

---

### Task 4: `syntra-install` rewrites `WEB_ROOT`

**Closes U7.** The installer copies `.env` verbatim and rewrites only `WorkingDirectory` and `--env-file-if-exists`. `WEB_ROOT` is the path `registerWebApp` serves the console from and the path the readiness `web` probe checks. An absolute one keeps pointing into `/root/syntra` — so the converted install serves the *old* bundle forever while `probeWeb` passes and nothing looks wrong; a relative one resolves against the new working directory and breaks readiness, so every update rolls back.

The rewrite is a pure function, so it is tested. `syntra-install` reaches it by sourcing the updater's pure block — one harness, one copy of the logic.

**Files:**
- Modify: `ops/syntra-update` — a new pure helper in the block ending at line 78.
- Modify: `ops/syntra-install` — source the helpers (after line 29), rewrite `shared/.env` (after line 87).
- Modify: `ops/syntra-update.test.sh` — a new section for `rewritten_web_root`.

**Interfaces:**
- Consumes: `env_value` (Task 1), `$SRC`, `$ROOT`.
- Produces:
  - `rewritten_web_root VALUE SRC ROOT` → prints the value `WEB_ROOT` should have after conversion, and exits 0. Prints nothing and exits 1 when `VALUE` is empty or is already under `$ROOT` (nothing to do).
  - `ops/syntra-install` sources `ops/syntra-update` with `SYNTRA_UPDATE_SOURCE_ONLY=1`, which defines the pure helpers and runs nothing.

- [ ] **Step 1: Write the failing test**

Add to `ops/syntra-update.test.sh`, after the `pg_url_field` section:

```bash
# --- rewritten_web_root -----------------------------------------------------
#
# WEB_ROOT is what makes one process serve the console as well as the API, and
# syntra-install used to copy .env verbatim. An absolute path kept serving the
# OLD tree's bundle forever -- with the readiness `web` probe passing, because
# a file was there -- and a relative one resolved against the new working
# directory and failed readiness, so every update rolled back.

ok "an absolute path under the old tree is re-anchored" \
  "$(rewritten_web_root /root/syntra/apps/web/dist /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

# A relative WEB_ROOT resolves against the process's working directory, which
# systemd sets to <root>/apps/api. Made absolute here rather than left to
# resolve somewhere new.
ok "a relative path is made absolute against the release" \
  "$(rewritten_web_root apps/web/dist /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

ok "a trailing slash does not double up" \
  "$(rewritten_web_root /root/syntra/apps/web/dist/ /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

# Somebody serving a bundle from outside the tree meant it. Re-anchoring that
# would point the console at a directory that does not exist.
ok "a path outside the old tree is left alone" \
  "$(rewritten_web_root /srv/syntra-console /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"

ok "a path already under the new root is left alone" \
  "$(rewritten_web_root /opt/syntra/current/apps/web/dist /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"

ok "an unset WEB_ROOT is left alone" \
  "$(rewritten_web_root '' /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash ops/syntra-update.test.sh`
Expected: the harness aborts with `rewritten_web_root: command not found`.

- [ ] **Step 3: Add the helper to the pure block**

In `ops/syntra-update`, after `adoption_allowed()`:

```bash
# What WEB_ROOT should say after the install has been converted, given its
# current value ($1), the old tree ($2) and the new root ($3).
#
# WEB_ROOT is the path `registerWebApp` serves the console from AND the path
# the readiness `web` probe checks, which is why getting it wrong is so quiet:
# an absolute path into the old tree keeps serving the OLD bundle forever with
# the probe passing, because a file is indeed there. A relative one resolves
# against the process's working directory -- which systemd points at
# <release>/apps/api -- so after conversion it resolves somewhere that does not
# exist, readiness fails, and every update rolls itself back.
#
# Re-anchored at `current`, not at the release directory: the console must
# follow the symlink, or a rollback would leave the API serving the bundle of
# the release it just undid.
#
# Prints nothing and returns 1 when there is nothing to do -- unset, already
# under the new root, or somewhere outside the old tree entirely, which is a
# choice somebody made and not this script's to overrule.
rewritten_web_root() {
  local value="$1" src="$2" root="$3" rest
  [ -n "$value" ] || return 1
  src="${src%/}"
  root="${root%/}"
  value="${value%/}"

  case "$value" in
    "$root"/*) return 1 ;;
    "$src"/*)
      rest="${value#"$src"/}"
      printf '%s/current/%s\n' "$root" "$rest"
      return 0
      ;;
    /*) return 1 ;;
    *)
      # Relative: the same path, spelled from the release root instead of from
      # whatever directory the service happened to start in.
      printf '%s/current/%s\n' "$root" "$value"
      return 0
      ;;
  esac
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash ops/syntra-update.test.sh`
Expected: `50 passed, 0 failed`.

- [ ] **Step 5: Let `syntra-install` reach the pure helpers**

In `ops/syntra-install`, insert immediately after `set -euo pipefail` (line 29) and **before** the `SRC=`/`ROOT=` assignments:

```bash
# The pure helpers out of the updater, which lives beside this file.
#
# Sourced rather than copied, and the guard at the bottom of that script means
# sourcing defines the functions and runs nothing. One copy of the logic and
# one test harness: a version of `rewritten_web_root` that lived here would be
# a second opinion nothing tests, which is how the two come to disagree.
#
# It must come BEFORE this script's own say/run/die, because syntra-update
# defines a `die` that writes an update status file -- which is exactly wrong
# for a conversion that has not started an update.
SYNTRA_UPDATE_SOURCE_ONLY=1 . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/syntra-update"
unset SYNTRA_UPDATE_SOURCE_ONLY
```

- [ ] **Step 6: Rewrite `WEB_ROOT` in the copied configuration**

In `ops/syntra-install`, after the three `.env` lines (85–87) and before `say "pointing current at releases/$VERSION"`:

```bash
# WEB_ROOT follows the install; nothing else in .env does.
#
# It is the one key whose value is a path INTO the tree being moved. An
# absolute one keeps serving /root/syntra's bundle after the conversion --
# with readiness passing, because a bundle is there -- and a relative one
# resolves against the new working directory and fails readiness, which rolls
# back every update that follows.
OLD_WEB_ROOT=$(env_value WEB_ROOT "$SRC/.env")
if NEW_WEB_ROOT=$(rewritten_web_root "$OLD_WEB_ROOT" "$SRC" "$ROOT"); then
  say "rewriting WEB_ROOT: $OLD_WEB_ROOT -> $NEW_WEB_ROOT"
  run "sed -i 's#^\([[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}WEB_ROOT[[:space:]]*=\).*#\1$NEW_WEB_ROOT#' '$ROOT/shared/.env'"
elif [ -n "$OLD_WEB_ROOT" ]; then
  say "leaving WEB_ROOT as it is ($OLD_WEB_ROOT) -- it is not inside $SRC"
else
  say "no WEB_ROOT set; this install serves the API alone"
fi
```

- [ ] **Step 7: Prove the rewrite lands, on a scratch copy, without touching anything real**

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/src" "$TMP/root/shared"
printf 'MASTER_KEY=abc\nWEB_ROOT=%s/src/apps/web/dist\nPORT=3000\n' "$TMP" > "$TMP/src/.env"
cp "$TMP/src/.env" "$TMP/root/shared/.env"
SYNTRA_UPDATE_SOURCE_ONLY=1 . ops/syntra-update
NEW=$(rewritten_web_root "$(env_value WEB_ROOT "$TMP/src/.env")" "$TMP/src" "$TMP/root")
sed -i "s#^\([[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}WEB_ROOT[[:space:]]*=\).*#\1$NEW#" "$TMP/root/shared/.env"
cat "$TMP/root/shared/.env"
rm -rf "$TMP"
```

Expected: `WEB_ROOT=<tmp>/root/current/apps/web/dist`, with `MASTER_KEY` and `PORT` unchanged.

- [ ] **Step 8: Check syntax and commit**

```bash
bash -n ops/syntra-update ops/syntra-install && bash ops/syntra-update.test.sh
```

Expected: `50 passed, 0 failed`.

```bash
git add ops/syntra-update ops/syntra-install ops/syntra-update.test.sh
git commit -m "$(cat <<'EOF'
fix(install): rewrite WEB_ROOT when converting to the release layout

syntra-install copied .env verbatim and rewrote only WorkingDirectory and
--env-file-if-exists. WEB_ROOT is the one key whose value is a path into the
tree being moved, and it is both what serves the console and what the
readiness `web` probe checks -- so getting it wrong is silent in both
directions. An absolute path kept serving /root/syntra's bundle forever with
the probe passing, because a bundle was indeed there. A relative one
resolved against the new working directory, failed readiness, and rolled
back every update that followed.

Re-anchored at `current` rather than at the release directory, so a rollback
does not leave the API serving the bundle of the release it just undid. A
path outside the old tree is left alone: somebody meant that.

syntra-install now sources the updater's pure block instead of carrying its
own copy, so there is one implementation and one test harness.
EOF
)"
```

---

### Task 5: Make the rollback an actual restore

**Closes U5.** `pg_restore --clean --if-exists` drops only objects that are *in the archive*. Every table, type, index and policy the new release's migration created is absent from a dump taken before it, so all of it survives the rollback while the restored `_prisma_migrations` table no longer records it. The next attempt then fails at `migrating` with `relation "X" already exists`, and repeats until somebody drops objects by hand — while the console says "Nothing was left half-applied."

The fix is to make the restore a restore: drop every non-system schema first, so afterwards the database holds exactly what the dump holds and nothing else. Every schema, not just `public`: pg-boss keeps its queue tables in one of its own.

This task also hardens the dump, because a rollback is only as good as what it restores. `pg_dump` run as a role that does not bypass RLS produces either an error or an archive with no rows, and the current size and magic-number checks pass on both.

**Files:**
- Modify: `ops/syntra-update` — `dump_database` (lines 152–165) and `restore_database` (lines 167–175).

**Interfaces:**
- Consumes: `PG_CONTAINER`, and — from Task 6 — `PG_ROLE`, `PG_DB`, `APP_ROLE`. If Task 6 has not landed yet, `PG_ROLE=syntra`, `PG_DB=syntra` and `APP_ROLE=syntra_app` as literals; Task 6 replaces the literals with resolved values and nothing else about this task changes.
- Produces: no signature change. `dump_database DEST` still calls `die` on any failure; `restore_database SRC` still returns 0 when the schema is usable afterwards and non-zero otherwise.

- [ ] **Step 1: Assert the dump contains data, not just bytes**

In `ops/syntra-update`, replace `dump_database` (lines 152–165) with:

```bash
dump_database() {
  local dest="$1"
  mkdir -p "$BACKUPS"
  # Through the container: there is no pg_dump on the host, and the version
  # inside always matches the server.
  #
  # As a role that BYPASSES RLS, which is not a detail. Every tenant-scoped
  # table here is FORCE ROW LEVEL SECURITY, and the application role is
  # deliberately NOSUPERUSER NOBYPASSRLS -- so a dump taken as the application
  # role either errors out or, with row security enabled, quietly captures the
  # rows visible to a session that has set no tenant, which is none of them.
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_ROLE" -d "$PG_DB" -Fc > "$dest" 2>/dev/null \
    || die "the pre-migration database dump failed; nothing was changed"
  # A dump that exists and is empty is worse than none, because it looks like
  # a backup. pg_dump's custom format starts with the magic "PGDMP".
  [ -s "$dest" ] || die "the pre-migration dump is empty; nothing was changed"
  head -c 5 "$dest" | grep -q PGDMP \
    || die "the pre-migration dump is not a PostgreSQL archive; nothing was changed"
  # AND IT CONTAINS ROWS. The two checks above pass on a structurally perfect
  # archive of nothing, which is exactly what an RLS-filtered dump is. This is
  # the check that can tell a backup from something shaped like one.
  local sections
  sections=$(docker exec -i "$PG_CONTAINER" pg_restore -l < "$dest" 2>/dev/null \
    | grep -c 'TABLE DATA' || true)
  [ "${sections:-0}" -gt 0 ] \
    || die "the pre-migration dump contains no table data, so it is not a backup; nothing was changed"
  log "dumped $(wc -c < "$dest") bytes, $sections table(s) of data, to $dest"
}
```

- [ ] **Step 2: Empty the database before restoring into it**

In `ops/syntra-update`, replace `restore_database` (lines 167–175) with:

```bash
restore_database() {
  local src="$1"
  [ -s "$src" ] || { log "no dump to restore from"; return 1; }

  # THE SCHEMAS GO FIRST, and this is the whole of the fix.
  #
  # `pg_restore --clean --if-exists` drops only what is IN THE ARCHIVE. Every
  # table, type, index and policy the new release's migration created is
  # absent from a dump taken BEFORE that migration -- so all of it survives a
  # rollback, while the restored _prisma_migrations no longer has a row saying
  # it was ever applied. The next attempt then dies at `migrating` with
  # `relation "X" already exists` and repeats forever, while the console says
  # "Nothing was left half-applied."
  #
  # Every non-system schema, not just `public`: pg-boss creates and migrates
  # its own, and a release that moved its queue tables would leave them behind
  # the same way.
  #
  # Afterwards the database holds exactly what the dump holds, which is what
  # the word restore means.
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_ROLE" -d "$PG_DB" >/dev/null 2>&1 <<SQL
DO \$\$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);
  END LOOP;
END \$\$;
CREATE SCHEMA public;
-- Mirrors infra/initdb/01-app-role.sql. The application role OWNS the schema
-- and its tables, which is what makes FORCE ROW LEVEL SECURITY bind the owner
-- -- so restoring into a schema owned by the dumping superuser would leave a
-- database whose isolation model is subtly not the one that was tested.
ALTER SCHEMA public OWNER TO "$APP_ROLE";
GRANT ALL ON SCHEMA public TO "$APP_ROLE";
SQL
  if [ "$?" -ne 0 ]; then
    log "the schemas could not be dropped before restoring; NOT restoring over a database in an unknown state"
    return 1
  fi

  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_ROLE" -d "$PG_DB" --clean --if-exists \
    < "$src" >/dev/null 2>&1
  # pg_restore exits non-zero on benign "does not exist" noise from --clean,
  # so its status is not the test. Whether the schema is usable is.
  docker exec "$PG_CONTAINER" psql -U "$PG_ROLE" -d "$PG_DB" -c 'SELECT 1' >/dev/null 2>&1
}
```

- [ ] **Step 3: Add the literals Task 6 will replace**

If Task 6 has not landed, add beside `PG_CONTAINER` (line 36):

```bash
PG_ROLE="${SYNTRA_PG_ROLE:-syntra}"
PG_DB="${SYNTRA_PG_DB:-syntra}"
APP_ROLE="${SYNTRA_PG_APP_ROLE:-syntra_app}"
```

- [ ] **Step 4: Correct the console's claim about what a rollback restores**

In `apps/web/src/pages/admin/UpdatesPage.tsx`, replace the `rolled_back` alert body (lines 184–190) with:

```tsx
                {progress.step === 'rolled_back' && (
                  <Alert tone="warning" title="The update was undone">
                    The new version did not come up, so the previous one was put
                    back automatically, along with the database as it was
                    immediately before the update — schema and data both.
                    Anything that happened in the minutes between the backup and
                    the rollback is not in it: a sign-in, a sync run, a
                    provisioning action.
                  </Alert>
                )}
```

Design §7.2 states this and the console did not. "Nothing was left half-applied" was two claims: one that is now true, and one that never was.

- [ ] **Step 5: Check syntax, run tests, commit**

```bash
bash -n ops/syntra-update && bash ops/syntra-update.test.sh && npx tsc -b
cd apps/web && npx vitest run src/pages/admin/UpdatesPage.test.tsx; cd ../..
```

Expected: `50 passed, 0 failed`, `tsc` exit 0, and the console suite green. If a UpdatesPage test asserts the old sentence, update the assertion to the new one — it is the same test, about a message that was wrong.

```bash
git add ops/syntra-update apps/web/src/pages/admin/UpdatesPage.tsx \
        apps/web/src/pages/admin/UpdatesPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(update): make the rollback restore, instead of restoring over

`pg_restore --clean --if-exists` drops only objects that are in the archive.
Every table, type, index and policy the new release's migration created is
absent from a dump taken before it, so a rollback left all of it standing
while restoring a _prisma_migrations that no longer recorded it. The next
attempt failed at `migrating` with `relation "X" already exists`, and every
attempt after that too, until somebody dropped objects by hand -- while the
console said "Nothing was left half-applied".

Now every non-system schema is dropped first, so afterwards the database
holds exactly what the dump holds. Every schema and not just public, because
pg-boss owns one of its own. The schema is recreated owned by the
application role, mirroring initdb: it is the owner being subject to FORCE
row level security that makes tenant isolation hold at all.

The dump is checked for table data as well as for size and magic number. A
pg_dump taken as a role that does not bypass RLS produces an archive that is
structurally perfect and empty, and the old checks passed on it.

And the console now says what a rollback does not restore -- the minutes
between the backup and the rollback -- which the design has said since it
was written.
EOF
)"
```

---

### Task 6: Stop assuming one port, one container and one database

**Closes U6.** `READY_URL` (`127.0.0.1:3000`), the Postgres container name (`infra-postgres-1`) and the `pg_dump` role and database (`syntra`/`syntra`) are fixed in the script, while `launchUpdater` forwards only the token, the root and the repository. `PORT` is a real, validated configuration key: a deployment that sets it has its perfectly healthy new release judged broken at step 10 and rolled back — and the rollback's own readiness check fails the same way, so the updater ends at `failed` on a system that was never broken.

Two sources, deliberately. `shared/.env` is the primary one, because the updater has to work when a person runs `--rollback` from a serial console with no API alive to hand it anything. `launchUpdater` additionally passes the readiness URL, because the API is the one thing that knows for certain what port it actually bound.

**Files:**
- Modify: `ops/syntra-update` — the configuration block (lines 34–36), `resolve_environment`, `ready()` (lines 134–138), `dump_database`, `restore_database`.
- Modify: `ops/syntra-install` — the hard-coded readiness poll (line 117).
- Modify: `packages/core/src/update/update-service.ts` — `UpdateEnvironment` and `launchUpdater`.
- Modify: `packages/core/src/update/update-service.test.ts`.
- Modify: `apps/api/src/routes/admin/update.ts` — `UpdateRouteOptions` and `env()`.
- Modify: `apps/api/src/app.ts:225-230` — the registration.
- Modify: `.env.example` — document `PG_CONTAINER`.

**Interfaces:**
- Consumes: `env_value`, `pg_url_field`, `$SHARED/.env`.
- Produces:
  - `resolve_environment` additionally sets `READY_URL`, `PG_CONTAINER`, `PG_ROLE`, `PG_DB`, `APP_ROLE`. Every one is overridable by its `SYNTRA_*` environment variable, which is what `--setenv` sets and what the rehearsal uses.
  - `UpdateEnvironment` gains `readyUrl: string`.
  - `UpdateRouteOptions` gains `readyUrl: string`.

- [ ] **Step 1: Replace the fixed values with empty ones**

In `ops/syntra-update`, replace lines 34–36 (and the literals Task 5 added, if present) with:

```bash
# Resolved in resolve_environment() from shared/.env, or overridden by the
# environment the transient unit was launched with. Empty here, deliberately:
# a default assigned at the top of the file is a default nobody sees until it
# is wrong, and the one that was here judged every deployment not serving on
# port 3000 to be broken.
READY_URL="${SYNTRA_READY_URL:-}"
PG_CONTAINER="${SYNTRA_PG_CONTAINER:-}"
PG_ROLE="${SYNTRA_PG_ROLE:-}"
PG_DB="${SYNTRA_PG_DB:-}"
APP_ROLE="${SYNTRA_PG_APP_ROLE:-}"
REPO="${SYNTRA_RELEASE_REPO:-ssan9876/syntra}"
```

- [ ] **Step 2: Resolve them from the configuration the service itself reads**

In `ops/syntra-update`, extend `resolve_environment` (added in Task 1) with, after the `SHADOW_URL` lines:

```bash
  # THE PORT THIS DEPLOYMENT ACTUALLY SERVES ON.
  #
  # PORT is a validated configuration key, and the fixed 127.0.0.1:3000 that
  # was here meant a deployment that set it had its healthy new release judged
  # broken at the verify step and rolled back -- and then the ROLLBACK's own
  # readiness check failed identically, so a system that was never broken ended
  # at `failed`. Read here rather than defaulted, because a default is a value
  # nobody looks at until it is wrong.
  if [ -z "$READY_URL" ]; then
    local port; port=$(env_value PORT "$SHARED/.env")
    READY_URL="http://127.0.0.1:${port:-3000}/health/ready"
  fi

  # WHICH DATABASE, AND AS WHOM.
  #
  # The database name comes from the connection string the service uses, so a
  # dump and a restore cannot land on a database nobody named.
  #
  # The ROLE deliberately does not: the application role is NOSUPERUSER
  # NOBYPASSRLS by design, and every tenant-scoped table is FORCE ROW LEVEL
  # SECURITY -- so a pg_dump as that role captures the rows visible to a
  # session with no tenant set, which is none of them. The dump has to be
  # taken by a role that bypasses RLS, which is SUPERUSER_DATABASE_URL's role
  # where one is configured.
  [ -n "$PG_DB" ]    || PG_DB=$(pg_url_field db "$DB_URL") \
    || die "DATABASE_URL names no database, so there is nothing to dump or migrate"
  [ -n "$APP_ROLE" ] || APP_ROLE=$(pg_url_field user "$DB_URL") \
    || die "DATABASE_URL names no role, so the restored schema would have no owner"
  if [ -z "$PG_ROLE" ]; then
    local super; super=$(env_value SUPERUSER_DATABASE_URL "$SHARED/.env")
    if [ -n "$super" ]; then
      PG_ROLE=$(pg_url_field user "$super") || PG_ROLE=""
    fi
    # Falls back to the database's own name, which is the convention this
    # deployment's infra follows: the owning role and the database share it.
    [ -n "$PG_ROLE" ] || PG_ROLE="$PG_DB"
  fi

  # The container the database runs in. Not derivable from a connection string
  # -- `localhost:5432` says nothing about which container answers it -- so it
  # is configuration, with the lab's compose project name as the default.
  [ -n "$PG_CONTAINER" ] || PG_CONTAINER=$(env_value PG_CONTAINER "$SHARED/.env")
  [ -n "$PG_CONTAINER" ] || PG_CONTAINER="infra-postgres-1"

  log "database $PG_DB in $PG_CONTAINER as $PG_ROLE; readiness at $READY_URL"
}
```

- [ ] **Step 3: Document `PG_CONTAINER`**

In `.env.example`, in the block that documents `RELEASE_*`, add:

```bash
# The container PostgreSQL runs in, which is what the updater takes its
# pre-migration dump through -- there is no pg_dump on the host, and the
# version inside the container always matches the server. Not derivable from
# DATABASE_URL: `localhost:5432` says nothing about which container answers.
# PG_CONTAINER=infra-postgres-1
```

- [ ] **Step 4: Let `syntra-install` use the same answer**

In `ops/syntra-install`, replace line 117 with:

```bash
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$(env_value PORT "$ROOT/shared/.env" || true)/health/ready" || echo 000)
```

and immediately above the `for _ in $(seq 1 30); do` line (116), add:

```bash
# The port this deployment serves on, not 3000. The installer had the same
# fixed address the updater did, so converting an install that sets PORT ended
# in "it did not become ready" on an install that was ready the whole time.
PORT_VALUE=$(env_value PORT "$ROOT/shared/.env")
[ -n "$PORT_VALUE" ] || PORT_VALUE=3000
```

then use `$PORT_VALUE` in the curl line instead of the inline substitution:

```bash
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PORT_VALUE/health/ready" || echo 000)
```

- [ ] **Step 5: Write the failing test for the launcher**

Add to `packages/core/src/update/update-service.test.ts`, at the end of the file:

```ts
/**
 * The API is the one process that knows for certain what port it bound, and
 * the updater's automatic rollback hangs entirely on reaching it. Forwarding
 * only the token, the root and the repository meant a deployment with a
 * PORT of its own had every healthy release judged broken -- and then the
 * rollback judged the previous release broken too, for the same reason.
 */
describe('launchUpdater', () => {
  it('passes the readiness URL to the transient unit', () => {
    const spawn = vi.spyOn(child, 'spawn').mockReturnValue({
      unref: () => {},
      on: () => {},
    } as never);

    launchUpdater(
      {
        repo: 'acme/syntra',
        token: 'tok',
        root: '/opt/syntra',
        readyUrl: 'http://127.0.0.1:8443/health/ready',
      },
      '1.5.0',
    );

    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--setenv=SYNTRA_READY_URL=http://127.0.0.1:8443/health/ready');
  });
});
```

and add the imports this needs at the top of the file:

```ts
import * as child from 'node:child_process';
import { launchUpdater } from './update-service.js';
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/src/update/update-service.test.ts -t 'readiness URL'`
Expected: FAIL — the arguments do not contain `--setenv=SYNTRA_READY_URL=…`, and `readyUrl` is not a property of `UpdateEnvironment`.

- [ ] **Step 7: Add it to the environment and the launcher**

In `packages/core/src/update/update-service.ts`, in `UpdateEnvironment`, after `root`:

```ts
  /**
   * Where the updater should ask whether the new release works.
   *
   * Passed in rather than assumed, because THIS process is the only thing
   * that knows for certain what port it bound. The updater has a fallback --
   * it reads PORT out of shared/.env, so a rollback run by hand from a serial
   * console still works with no API alive to tell it anything -- and this is
   * the authoritative answer when there is one.
   */
  readyUrl: string;
```

and in `launchUpdater`, in the argument array, after the `SYNTRA_RELEASE_REPO` line:

```ts
      `--setenv=SYNTRA_READY_URL=${env.readyUrl}`,
```

- [ ] **Step 8: Thread it from configuration**

In `apps/api/src/routes/admin/update.ts`, add to `UpdateRouteOptions`:

```ts
  /** Built from the port this process actually bound. See launchUpdater. */
  readyUrl: string;
```

and in `env()` (lines 42–46), add `readyUrl: options.readyUrl,`.

In `apps/api/src/app.ts`, in the `registerAdminUpdateRoutes` registration (lines 225–230), add:

```ts
    readyUrl: `http://127.0.0.1:${config.port}/health/ready`,
```

- [ ] **Step 9: Run everything this touches**

```bash
npx vitest run packages/core/src/update/update-service.test.ts
npx tsc -b
bash -n ops/syntra-update ops/syntra-install && bash ops/syntra-update.test.sh
```

Expected: the core file green, `tsc` exit 0, `50 passed, 0 failed`.

- [ ] **Step 10: Commit**

```bash
git add ops/syntra-update ops/syntra-install .env.example \
        packages/core/src/update/update-service.ts \
        packages/core/src/update/update-service.test.ts \
        apps/api/src/routes/admin/update.ts apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
fix(update): read the deployment instead of assuming it

READY_URL was fixed at 127.0.0.1:3000, the Postgres container at
infra-postgres-1, and the pg_dump role and database at syntra/syntra, while
launchUpdater forwarded only the token, the root and the repository. PORT is
a real, validated configuration key: a deployment that set it had its
perfectly healthy new release judged broken at the verify step and rolled
back -- and then the rollback's own readiness check failed identically, so a
system that was never broken ended at `failed`.

Two sources, and both on purpose. shared/.env is primary, because the
updater has to work when somebody runs --rollback from a serial console with
no API alive to hand it anything. launchUpdater also passes the readiness
URL, because this process is the only thing that knows for certain what port
it bound.

The database name comes from DATABASE_URL. The dump ROLE deliberately does
not: the application role is NOSUPERUSER NOBYPASSRLS and every tenant-scoped
table is FORCE RLS, so a dump as that role captures the rows visible to a
session with no tenant -- none of them. It comes from
SUPERUSER_DATABASE_URL where one is configured.

syntra-install had the same fixed address, so converting an install that
sets PORT reported "it did not become ready" on one that was ready
throughout.
EOF
)"
```

---

### Task 7: Stop `sort -V` picking `dev` and `.partial` as releases

**Closes U8.** `previous_release()` and `releases_to_prune()` both sort the raw directory listing with `sort -V`, which orders the literal `dev` and any `<v>.partial` directory *after* real versions. So a rollback can target the unversioned copy of somebody's working tree, or a half-unpacked directory that failed its checksum; `dev` is never pruned because it always lands in the newest-three; and a `.partial` left by an interrupted download counts against the retention limit and deletes a real release.

**Files:**
- Modify: `ops/syntra-update` — `releases_to_prune` (lines 68–75), a new pure `previous_release_of`, `previous_release` (lines 99–102), `prune` (lines 294–307).
- Modify: `ops/syntra-update.test.sh` — extend the `releases_to_prune` section, add one for `previous_release_of`.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `release_candidates ITEM…` → prints the entries that name an installable release, `sort -V` ordered, newest last. Drops empty lines, `dev`, `*.partial` and anything not matching `[0-9]+(\.[0-9]+)*`.
  - `previous_release_of CURRENT ITEM…` → prints the newest candidate that is not `CURRENT`; prints `dev` when there is no numeric candidate and `dev` is in the list; prints nothing and exits 1 when there is nowhere to go.
  - `releases_to_prune KEEP PROTECT ITEM…` — unchanged signature, now candidate-filtered.

- [ ] **Step 1: Write the failing tests**

Add to `ops/syntra-update.test.sh`, in the `releases_to_prune` section, after the existing assertions:

```bash
# `sort -V` puts the literal `dev` and any `<v>.partial` AFTER real versions,
# so both used to land in the newest-three and count against the limit -- which
# means a half-unpacked download could evict a release somebody may need to
# roll back to, and the conversion's copy of the working tree was never pruned
# at all.

ok "a partial directory is not a release" \
  "$(releases_to_prune 2 1.3.0 1.1.0 1.2.0 1.3.0 1.4.0.partial | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0"

ok "dev does not count against the limit" \
  "$(releases_to_prune 2 1.3.0 dev 1.1.0 1.2.0 1.3.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0"

# It is the recovery point for a bad conversion. Deleting it is how somebody
# loses the tree they were told was still sitting there.
ok "dev is never pruned" \
  "$(releases_to_prune 1 1.3.0 dev 1.1.0 1.2.0 1.3.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0 1.2.0"

# --- previous_release_of ----------------------------------------------------
#
# Where a rollback goes. Sorting the raw listing meant it could go to a
# half-unpacked download that failed its checksum, or to an unversioned copy
# of somebody's working tree.

ok "the newest older release" \
  "$(previous_release_of 1.5.0 1.3.0 1.4.0 1.5.0)" "1.4.0"

ok "ordered numerically, not lexically" \
  "$(previous_release_of 1.10.0 1.2.0 1.9.0 1.10.0)" "1.9.0"

ok "a partial download is never a rollback target" \
  "$(previous_release_of 1.5.0 1.4.0 1.5.0 1.6.0.partial)" "1.4.0"

# After an adoption there is exactly one release and the tree it replaced.
# Going back to that tree is the correct and only answer.
ok "falls back to the adopted working tree" \
  "$(previous_release_of 1.0.0 dev 1.0.0)" "dev"

ok "refuses when there is nowhere to go" \
  "$(previous_release_of 1.0.0 1.0.0 || echo NONE)" "NONE"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash ops/syntra-update.test.sh`

Expected: FAIL. The three `releases_to_prune` assertions report the partial and `dev` in the output or the wrong entries pruned, and the harness then aborts on `previous_release_of: command not found`.

- [ ] **Step 3: Filter the candidates in the pure block**

In `ops/syntra-update`, replace `releases_to_prune` (lines 68–75) with:

```bash
# The entries in a releases directory that name a release we could actually
# run, `sort -V` ordered, newest last.
#
# `sort -V` orders the literal `dev` and any `<v>.partial` AFTER every real
# version, so both used to land in the newest-three: a rollback could target a
# half-unpacked download that had failed its checksum, a partial could evict a
# real release from the retention limit, and the conversion's copy of the
# working tree was never pruned at all.
release_candidates() {
  printf '%s\n' "$@" | grep -v '^$' | grep -Ex '[0-9]+(\.[0-9]+)*' | sort -V || true
}

# Which releases to delete, given how many to keep and the list to choose
# from. Never the one passed as $2 -- deleting the release you are running is a
# way to make a rollback impossible at the moment it is needed -- and never
# `dev`, which is the recovery point for a bad conversion and is not a release
# anybody is counting.
releases_to_prune() {
  local keep="$1" protect="$2"; shift 2
  local sorted
  sorted=$(release_candidates "$@")
  local total; total=$(printf '%s\n' "$sorted" | grep -c . || true)
  [ "$total" -le "$keep" ] && return 0
  printf '%s\n' "$sorted" | head -n "$(( total - keep ))" | grep -vx "$protect" || true
}

# Where a rollback goes: the newest release that is not the running one.
#
# Falls back to `dev` when there is no numeric candidate, and only then. That
# is the state immediately after an adoption -- one release, plus the working
# tree it was installed over -- and going back to that tree is both the correct
# answer and the only one.
previous_release_of() {
  local now="$1"; shift
  local candidate
  candidate=$(release_candidates "$@" | grep -vx "$now" | tail -1)
  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [ "$now" != "dev" ] && printf '%s\n' "$@" | grep -qx dev; then
    printf 'dev\n'
    return 0
  fi
  return 1
}
```

- [ ] **Step 4: Use it from the I/O side**

In `ops/syntra-update`, replace `previous_release` (lines 99–102) with:

```bash
previous_release() {
  local now; now=$(current_version)
  # shellcheck disable=SC2046
  previous_release_of "$now" $(ls -1 "$RELEASES" 2>/dev/null) || true
}
```

- [ ] **Step 5: Sweep abandoned partials while pruning**

In `ops/syntra-update`, in `prune()` (lines 294–307), after the `for name in $doomed` loop and before the dump pruning:

```bash
  # Partial directories are no longer counted as releases, which also means
  # nothing was ever removing them. An interrupted download leaves one behind,
  # and the next attempt at the same version starts with `rm -rf "$tmp"` -- but
  # an attempt at a DIFFERENT version never touches it.
  for partial in "$RELEASES"/*.partial; do
    [ -d "$partial" ] || continue
    log "removing abandoned $(basename "$partial")"
    rm -rf "$partial"
  done
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bash -n ops/syntra-update && bash ops/syntra-update.test.sh`
Expected: `58 passed, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add ops/syntra-update ops/syntra-update.test.sh
git commit -m "$(cat <<'EOF'
fix(update): dev and .partial are not releases to roll back to

`sort -V` orders the literal `dev` and any `<version>.partial` AFTER every
real version, and both previous_release and releases_to_prune sorted the raw
directory listing. So a rollback could target a half-unpacked download that
had just failed its checksum, or the unversioned copy of somebody's working
tree; a partial counted against the retention limit and evicted a real
release; and `dev` always landed in the newest three, so it was never pruned
and never even considered.

Candidates are now filtered to names that are actually versions. `dev` stays
out of the count and out of the prune list deliberately -- it is the
recovery point for a bad conversion, and the one place a rollback goes when
an adopted install has nowhere else. Abandoned partials are swept instead,
which nothing was doing.
EOF
)"
```

---

### Task 8: `/health/ready` — limited, and quiet about why

**Closes U9.** `rateLimit` is registered `global: false` and this route sets no config, so an unauthenticated caller can run several queries, two `withTenant` transactions and an AES unseal per request, as fast as they can ask. And when Postgres is down the body carries Prisma's own message — `Can't reach database server at 'host:5432'` — which contradicts the comment claiming it discloses nothing a sign-in attempt would not. A hostname and port are exactly that.

The endpoint stays unauthenticated: the updater holds no session and cannot get one while the thing it is checking is broken. What changes is that the *cause* goes to the journal and the *name* goes on the wire.

**Files:**
- Modify: `packages/core/src/health/readiness.ts` — a new exported `redactReport`.
- Modify: `packages/core/src/health/readiness.test.ts`.
- Modify: `apps/api/src/app.ts:139-147` — the route.

**Interfaces:**
- Consumes: `ReadinessReport`, `Probe`.
- Produces: `export function redactReport(report: ReadinessReport): ReadinessReport` — every `fail` probe keeps its `name` and `status` and gets a fixed sentence as its `detail`. `pass` and `skip` probes are returned unchanged; their details are already constants.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/health/readiness.test.ts`, at the end of the file:

```ts
/**
 * The answer is unauthenticated, because the updater holds no session and
 * cannot get one while the thing it is checking is broken. That is the whole
 * reason the endpoint exists, and it is also why the failure DETAIL cannot go
 * on the wire: Prisma's message names the host and port it could not reach,
 * which is not something a sign-in attempt tells anybody.
 *
 * The probe NAME stays. Section 6 wants the failing probe named, and "the
 * database" is not a disclosure -- every deployment has one.
 */
describe('redactReport', () => {
  const report = (probes: Probe[]): ReadinessReport => ({
    ready: probes.every((p) => p.status !== 'fail'),
    version: '1.4.0',
    probes,
  });

  it('drops the cause of a failure and keeps the name', () => {
    const redacted = redactReport(
      report([
        {
          name: 'database',
          status: 'fail',
          detail: "not reachable: Can't reach database server at `db.internal:5432`",
        },
      ]),
    );
    expect(redacted.probes[0]!.name).toBe('database');
    expect(redacted.probes[0]!.status).toBe('fail');
    expect(redacted.probes[0]!.detail).not.toContain('5432');
    expect(redacted.probes[0]!.detail).not.toContain('db.internal');
    expect(redacted.probes[0]!.detail).toBe('this check did not pass');
  });

  it('leaves passing and skipped probes exactly as they are', () => {
    const original = report([
      { name: 'migrations', status: 'pass', detail: '31 applied' },
      { name: 'vault', status: 'skip', detail: 'no tenants yet' },
    ]);
    expect(redactReport(original)).toEqual(original);
  });

  it('keeps the readiness verdict and the version', () => {
    const redacted = redactReport(
      report([{ name: 'web', status: 'fail', detail: 'the console bundle is missing' }]),
    );
    expect(redacted.ready).toBe(false);
    expect(redacted.version).toBe('1.4.0');
  });
});
```

Add `Probe`, `ReadinessReport` and `redactReport` to the file's import from `./readiness.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/health/readiness.test.ts -t 'redactReport'`
Expected: FAIL — `redactReport is not a function`.

- [ ] **Step 3: Write it**

In `packages/core/src/health/readiness.ts`, at the end of the file:

```ts
/**
 * The same verdict, with the causes removed.
 *
 * `/health/ready` is unauthenticated on purpose: the updater holds no session
 * and cannot obtain one while the thing it is checking is broken, and the
 * automatic rollback hangs on the status code. The comment on that route used
 * to say it "discloses nothing a caller could not learn by trying to sign in".
 * That was true of the status code and false of the body -- with Postgres
 * down, `reason()` put Prisma's own message on the wire, which names the host
 * and port it could not reach.
 *
 * So: the status code and the failing probe's NAME go out, because §6 wants
 * the failing probe named and "the database" is not a disclosure. The cause
 * goes to the journal, where the operator restoring a broken update at three
 * in the morning is already looking.
 */
export function redactReport(report: ReadinessReport): ReadinessReport {
  return {
    ...report,
    probes: report.probes.map((probe) =>
      probe.status === 'fail' ? { ...probe, detail: 'this check did not pass' } : probe,
    ),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/core/src/health/readiness.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Limit the route and log what it will not say**

In `apps/api/src/app.ts`, replace the `/health/ready` handler (lines 139–147) with:

```ts
  app.get(
    '/health/ready',
    {
      // A RATE LIMIT, because this one is not free: several queries, two
      // withTenant transactions and an AES unseal per request, unauthenticated,
      // as fast as anybody cares to ask. `rateLimit` is registered
      // `global: false`, so a route that sets no config has none at all.
      //
      // Thirty a minute is roughly double what the updater's three-second poll
      // spends during the ninety seconds it is allowed, and it is keyed per
      // address, so the updater on loopback and a container orchestrator's
      // probe do not share a bucket with anybody.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const report = await readiness({
        provider: localMasterKeyProvider(config.masterKey),
        webRoot: config.webRoot ?? undefined,
        version: buildInfo().version,
      });

      // The CAUSE goes to the journal and the NAME goes on the wire. This
      // answer is unauthenticated, and Prisma's message names the host and
      // port it could not reach -- which is not something a sign-in attempt
      // tells anybody, whatever the old comment here claimed.
      if (!report.ready) {
        request.log.warn(
          { probes: report.probes.filter((probe) => probe.status === 'fail') },
          'readiness check failed',
        );
      }

      return reply.status(report.ready ? 200 : 503).send(redactReport(report));
    },
  );
```

and add `redactReport` to the `@syntra/core` import at the top of `apps/api/src/app.ts`.

- [ ] **Step 6: Export it**

```bash
grep -rn "readiness" packages/core/src/index.ts
```

Add `redactReport` to whatever export line carries `readiness`, in the same shape.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/health/readiness.ts packages/core/src/health/readiness.test.ts \
        packages/core/src/index.ts apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
fix(health): rate-limit /health/ready and stop it naming the database host

`rateLimit` is registered global:false, so a route that sets no config has
none -- and this one runs several queries, two withTenant transactions and
an AES unseal per request, unauthenticated, as fast as anybody asks. Thirty
a minute: roughly double what the updater's three-second poll spends inside
its ninety-second window, keyed per address.

And the body carried Prisma's own message when the database was down, which
names the host and port it could not reach. The comment on the route claimed
it disclosed nothing a sign-in attempt would not; that was true of the
status code and false of the body. The cause now goes to the journal and the
failing probe's name goes on the wire, which is what section 6 asked for.

Still unauthenticated, and that is not negotiable: the updater holds no
session and cannot get one while the thing it is checking is broken.
EOF
)"
```

---

### Task 9: The Updates page stops tearing down its own polling

**Closes U10, and the redundant GitHub round trips on `POST /update` and on the poll.** After a 202 the page calls `load(true)` immediately. That succeeds — the API is still up, the restart has not happened yet — which clears `restarting`, and if the updater has not written the status file yet the page concludes nothing is running and clears the interval for good. It then sits static with the button re-enabled while the update restarts the server underneath it; a second click launches a second updater, which loses the lock and (before Task 10) overwrites the status file with `failed`.

The same poll also calls `GET /api/admin/update`, which makes a GitHub round trip every three seconds, and `POST /update` makes another one to re-check availability it was just shown.

**Files:**
- Modify: `apps/web/src/pages/admin/UpdatesPage.tsx` — the polling effect (lines 89–96), `start` (lines 98–118), the button guard (line 237).
- Modify: `apps/web/src/pages/admin/UpdatesPage.test.tsx`.
- Modify: `packages/core/src/update/update-service.ts` — a TTL cache in `checkForUpdate`.
- Modify: `packages/core/src/update/update-service.test.ts`.

**Interfaces:**
- Consumes: `GET /api/admin/update/status` (exists; returns `{ progress }` and makes no outbound request).
- Produces:
  - `UpdatesPage` gains a `launched` state. Polling runs while `running || restarting || launched`, and `launched` is cleared only by a `progress` whose `step` is terminal.
  - `checkForUpdate` caches the release lookup for 60 seconds per `(repo, token)`; `resetUpdateCache()` is exported as a test seam.

- [ ] **Step 1: Write the failing console test**

Add to `apps/web/src/pages/admin/UpdatesPage.test.tsx`, at the end of the file:

```tsx
/**
 * THE ONE THAT MADE THE PAGE LIE.
 *
 * After a 202 the page used to call load() immediately. That request SUCCEEDS
 * -- the API is still up, the restart has not happened -- so `restarting`
 * cleared, and with no status file written yet the page decided nothing was
 * running and cleared its interval for good. It then sat there, static, with
 * the button enabled, while the update restarted the server; a second click
 * launched a second updater that lost the lock.
 *
 * The fix is that a page which has just LAUNCHED an update keeps polling until
 * it sees a terminal step, whatever the first poll happens to catch.
 */
it('keeps polling after a 202 even when no status file exists yet', async () => {
  const fetchSpy = mockApi(availability({ progress: null }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<UpdatesPage />);

  await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
  await userEvent.click(screen.getByRole('button', { name: /update now/i }));

  const afterLaunch = fetchSpy.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9_000);

  // Three ticks at three seconds. The old page made zero: it had already
  // cleared the interval.
  expect(fetchSpy.mock.calls.length).toBeGreaterThan(afterLaunch);
  // And it polls the CHEAP route, which does not go to GitHub.
  const polled = fetchSpy.mock.calls.at(-1)![0];
  expect(String(polled)).toBe('/api/admin/update/status');
});

it('does not offer the button again while an update it launched is running', async () => {
  mockApi(availability({ progress: null }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<UpdatesPage />);

  await userEvent.click(await screen.findByRole('button', { name: /update to 1\.5\.0/i }));
  await userEvent.click(screen.getByRole('button', { name: /update now/i }));
  await vi.advanceTimersByTimeAsync(3_000);

  expect(screen.queryByRole('button', { name: /update to 1\.5\.0/i })).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web && npx vitest run src/pages/admin/UpdatesPage.test.tsx -t 'keeps polling'; cd ../..
```

Expected: FAIL — the call count does not grow after the launch, because the interval was cleared.

- [ ] **Step 3: Poll the cheap route, and keep polling until something terminal**

In `apps/web/src/pages/admin/UpdatesPage.tsx`, add beside the other state (after line 60):

```tsx
  /**
   * True from the moment this page launched an update until it has seen the
   * updater stop. Not derived from `progress`: for the first few seconds there
   * IS no progress -- the status file is written by a detached unit that has
   * not started yet -- and a page that trusted the absence of one concluded
   * nothing was happening and stopped looking.
   */
  const [launched, setLaunched] = useState(false);
```

and a terminal-step set beside `STEP_TEXT`:

```tsx
/** Steps after which the updater is not coming back. */
const TERMINAL = new Set(['succeeded', 'rolled_back', 'failed']);
```

Replace `load` (lines 62–83) with a version that can poll cheaply:

```tsx
  const load = useCallback(async (quiet = false) => {
    try {
      // The QUIET path asks the cheap route. `/api/admin/update` re-queries
      // the forge every time; at one poll every three seconds that is a
      // GitHub round trip per tick, to re-learn a release list that cannot
      // have changed during an update. `/update/status` reads the status file
      // and nothing else.
      if (quiet) {
        const { progress } = await api<{ progress: Progress | null }>(
          '/api/admin/update/status',
        );
        setData((previous) => (previous ? { ...previous, progress } : previous));
        setRestarting(false);
        if (progress && TERMINAL.has(progress.step)) {
          setLaunched(false);
          // One full read, now that it is over: the running version has
          // changed and the availability with it.
          void load();
        }
        return;
      }

      const next = await api<Availability>('/api/admin/update');
      setData(next);
      setRestarting(false);
      setError(null);
      if (next.progress && TERMINAL.has(next.progress.step)) setLaunched(false);
    } catch (cause) {
      // While the service is restarting this WILL fail, and that is the
      // update working. Only a foreground load reports a problem.
      if (quiet) {
        setRestarting(true);
        return;
      }
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The update status could not be read.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
```

Replace the polling effect (lines 89–96) with:

```tsx
  // Poll only while something is happening. A page that polls forever keeps a
  // request every three seconds against a system nobody is updating.
  //
  // `launched` is in the condition and it is load-bearing. The updater is a
  // detached systemd unit: for the first seconds after a 202 there is no
  // status file at all, and a condition built only on `running` read that
  // absence as "finished" and stopped -- leaving the page static, with the
  // button live, while the server restarted underneath it.
  const running = data?.progress?.running ?? false;
  useEffect(() => {
    if (!running && !restarting && !launched) return;
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [running, restarting, launched, load]);
```

Replace `start` (lines 98–118) with:

```tsx
  async function start(version: string) {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/update', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      setConfirming(false);
      setLaunched(true);
      setRestarting(true);
      // Deliberately NOT loading here. That request succeeds -- the API is
      // still up, the restart has not happened yet -- and its success used to
      // clear `restarting` before the first tick, which with no status file
      // yet written cleared the interval for good. The first poll is three
      // seconds away and knows more than this one would.
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The update could not be started.',
      );
    } finally {
      setBusy(false);
    }
  }
```

And in the button guard (line 237), replace `disabled={busy || (progress?.running ?? false)}` with:

```tsx
                        disabled={busy || launched || (progress?.running ?? false)}
```

- [ ] **Step 4: Run the console tests**

```bash
cd apps/web && npx vitest run src/pages/admin/UpdatesPage.test.tsx; cd ../..
```

Expected: PASS, the whole file including the two new cases.

- [ ] **Step 5: Write the failing test for the release-lookup cache**

Add to `packages/core/src/update/update-service.test.ts`:

```ts
/**
 * The design says the check caches for an hour; nothing did. So the settings
 * page, the POST that starts an update, and every tick of the console's
 * three-second poll each made their own round trip to GitHub -- which is a
 * rate limit spent on re-learning a release list that cannot change during an
 * update, and a settings page whose load time is somebody else's uptime.
 */
describe('checkForUpdate caching', () => {
  it('asks the forge once for repeated checks', async () => {
    resetUpdateCache();
    vi.spyOn(version, 'buildInfo').mockReturnValue({
      version: '1.4.0',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release())));
    const env = {
      repo: 'acme/syntra',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await checkForUpdate(env);
    await checkForUpdate(env);
    await checkForUpdate(env);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /** A failure must not be remembered: "we could not check" for an hour after
   *  a blip is worse than checking again. */
  it('does not cache a failure', async () => {
    resetUpdateCache();
    vi.spyOn(version, 'buildInfo').mockReturnValue({
      version: '1.4.0',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const env = {
      repo: 'acme/syntra',
      token: 'tok',
      root: '/opt/syntra',
      readyUrl: 'http://127.0.0.1:3000/health/ready',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await checkForUpdate(env);
    await checkForUpdate(env);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/src/update/update-service.test.ts -t 'caching'`
Expected: FAIL — `resetUpdateCache is not a function`, and three round trips rather than one.

- [ ] **Step 7: Add the cache**

In `packages/core/src/update/update-service.ts`, above `checkForUpdate`:

```ts
/**
 * The last successful release lookup, and when it was taken.
 *
 * The design said "caches for an hour" and nothing did, so the settings page,
 * the POST that starts an update and every tick of the console's poll each
 * spent a round trip re-learning a release list that had not moved. Sixty
 * seconds rather than an hour: an operator who has just cut a release and
 * refreshes the page should see it, and an hour of "there is nothing new" is
 * the kind of stale that gets diagnosed as a broken button.
 *
 * Keyed on repository and token together, so a configuration change is not
 * answered from the previous configuration's cache. Failures are NOT cached --
 * "we could not check" is a fine answer once and a poor one for a minute.
 */
const RELEASE_CACHE_MS = 60_000;
let releaseCache: { key: string; at: number; value: AvailableRelease } | null = null;

/** Test seam. Never called by the product. */
export function resetUpdateCache(): void {
  releaseCache = null;
}
```

and in `checkForUpdate`, replace the `const latest = await fetchLatestRelease(…)` line with:

```ts
  // `\u0000` as the separator, written as an escape rather than a raw byte:
  // it cannot occur in a repository name or a token, so no pair of values
  // can collide by concatenating to the same string.
  const key = `${env.repo}\u0000${env.token}`;
  let latest: AvailableRelease | null = null;
  if (releaseCache !== null && releaseCache.key === key && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
    latest = releaseCache.value;
  } else {
    latest = await fetchLatestRelease(env.token, env.repo, env.fetchImpl);
    if (latest !== null) releaseCache = { key, at: Date.now(), value: latest };
  }
```

- [ ] **Step 8: Export the seam and run both suites**

Add `resetUpdateCache` to the `@syntra/core` export alongside `checkForUpdate` in `packages/core/src/index.ts`.

```bash
npx vitest run packages/core/src/update/update-service.test.ts
npx tsc -b
cd apps/web && npx vitest run src/pages/admin/UpdatesPage.test.tsx; cd ../..
```

Expected: all green, `tsc` exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/admin/UpdatesPage.tsx apps/web/src/pages/admin/UpdatesPage.test.tsx \
        packages/core/src/update/update-service.ts \
        packages/core/src/update/update-service.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
fix(console): the Updates page stopped watching its own update

After a 202 it called load() immediately. That request SUCCEEDS -- the API
is still up, the restart has not happened yet -- so `restarting` cleared,
and with no status file written yet the page concluded nothing was running
and cleared its interval for good. It then sat static, with the button live,
while the update restarted the server underneath it; a second click launched
a second updater that lost the lock.

The page now remembers that IT launched something and keeps polling until it
sees a terminal step, which is a fact about this page rather than an
inference from a file a detached systemd unit has not written yet. The
immediate load is gone: the first poll is three seconds away and knows more.

It also polls /update/status instead of /update. The full route re-queries
GitHub, so the three-second poll was a round trip per tick to re-learn a
release list that cannot change mid-update. And checkForUpdate now caches
for sixty seconds, which is the "caches for an hour" the design asked for,
shortened so that cutting a release and refreshing shows it. Failures are
not cached.
EOF
)"
```

---

### Task 10: The six smaller ones

**Closes the lower-severity findings listed at the end of §5:** the unhandled `spawn` error in `launchUpdater`; the lock-loser's `die` overwriting the live `update.status`; `workflow_dispatch` verifying branch HEAD rather than the input tag; the reused `verifying` step label; and the bare `fetch` bypassing `guardedFetch`. (The redundant round trips, also listed there, are closed by Task 9.)

**Files:**
- Modify: `packages/core/src/update/update-service.ts` — `launchUpdater`, `fetchLatestRelease`.
- Modify: `packages/core/src/update/update-service.test.ts`.
- Modify: `ops/syntra-update` — `refuse`, and the `verifying`/`checking` step names.
- Modify: `apps/web/src/pages/admin/UpdatesPage.tsx` — `STEP_TEXT`.
- Modify: `.github/workflows/release.yml` — the trigger and a guard.

**Interfaces:**
- Consumes: `guardedFetch` from `../net/guarded-fetch.js`; `outboundAllowPrivate` from configuration.
- Produces:
  - `refuse MESSAGE` → logs and exits 1 **without writing `update.status`**.
  - A new step name `checking`, for the post-restart readiness wait. `verifying` keeps its original meaning, the checksum.
  - `launchUpdater` attaches an `error` handler that writes a `failed` status line, so the console learns about a missing `systemd-run` instead of watching a spinner.

- [ ] **Step 1: Write the failing test for the spawn error**

Add to `packages/core/src/update/update-service.test.ts`, inside the `launchUpdater` describe added in Task 6:

```ts
  /**
   * `spawn` reports a missing executable ASYNCHRONOUSLY, on the child's
   * 'error' event. With no handler that is an unhandled 'error' on an
   * EventEmitter, which in Node is a thrown exception with nothing to catch it
   * -- so a host without systemd-run took the API down, having already
   * answered 202 and written an audit event saying an update had begun.
   */
  it('records a failure instead of crashing when systemd-run is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'syntra-launch-'));
    mkdirSync(join(root, 'var'), { recursive: true });

    const handlers: Record<string, (cause: Error) => void> = {};
    vi.spyOn(child, 'spawn').mockReturnValue({
      unref: () => {},
      on: (event: string, handler: (cause: Error) => void) => {
        handlers[event] = handler;
      },
    } as never);

    launchUpdater(
      { repo: 'a/b', token: 't', root, readyUrl: 'http://127.0.0.1:3000/health/ready' },
      '1.5.0',
    );

    expect(handlers.error).toBeDefined();
    expect(() => handlers.error!(new Error('spawn systemd-run ENOENT'))).not.toThrow();

    const progress = readProgress(root);
    expect(progress?.step).toBe('failed');
    expect(progress?.running).toBe(false);
    expect(progress?.detail).toContain('systemd-run');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/update/update-service.test.ts -t 'systemd-run is missing'`
Expected: FAIL — no `error` handler is registered, so `handlers.error` is undefined.

- [ ] **Step 3: Handle it, and say so where the console is looking**

In `packages/core/src/update/update-service.ts`, in `launchUpdater`, replace `child.unref();` and the comment below it with:

```ts
  // `spawn` reports a missing executable asynchronously, on 'error'. Without a
  // handler that is an unhandled 'error' on an EventEmitter, which Node turns
  // into a thrown exception with nothing to catch it -- so a host with no
  // systemd-run took the whole API down, after this route had already answered
  // 202 and audited that an update was beginning.
  //
  // It writes the failure where the console is already looking. The updater
  // owns that file, but the updater is precisely what did not start, and a
  // console left watching a spinner for an update that never began is the
  // worst of the available answers.
  child.on('error', (cause: Error) => {
    try {
      mkdirSync(`${env.root}/var`, { recursive: true });
      writeFileSync(
        `${env.root}/var/update.status`,
        `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\tfailed\t` +
          `the updater could not be started: ${cause.message}\n`,
      );
    } catch {
      // A root that cannot be written to is a deployment that was never
      // installed. There is nowhere left to report this to; the log line
      // below is the record.
    }
  });
  child.unref();

  // Not awaited. `systemd-run` returns as soon as the unit is queued, and
  // waiting for the UPDATE would mean waiting for our own restart.
  return { ok: true };
```

and extend the imports at the top of the file:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/core/src/update/update-service.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Stop the lock-loser overwriting a running update's status**

In `ops/syntra-update`, add after `die()` (which ends at line 89):

```bash
# Refused before anything started, so it does NOT touch update.status.
#
# `die` writes `failed` into that file, which is right for an update that got
# somewhere and wrong for one that never began: the second updater loses the
# lock, writes `failed` over the status of the FIRST -- which is still running
# -- and the console then tells an operator their update has failed while it is
# quietly migrating their database.
refuse() { log "REFUSED: $1"; exit 1; }
```

Then confirm `main` uses it (Task 3 step 6 already does) for the usage message, the missing `--adopt` argument and the lock loss. If Task 3 has not landed, make those three call sites `refuse` rather than `die` now.

- [ ] **Step 6: Give the readiness wait its own step name**

`verifying` was used twice: for the checksum at line 202 and for the post-restart readiness wait at line 235. The console shows "Checking it is intact" for both, so an operator watching a release get verified after the restart is being told the download is being checked again.

In `ops/syntra-update`, change line 235 from:

```bash
  status "verifying" "waiting for v$target to become ready"
```

to:

```bash
  # NOT `verifying`, which is the checksum. This is a different question asked
  # at a different time -- "does the release that is now running actually
  # work?" -- and reusing the label meant the console told an operator their
  # download was being checked while their service was down.
  status "checking" "waiting for v$target to become ready"
```

Add `'checking',` to `IN_FLIGHT` in `packages/core/src/update/update-service.ts`, after `'switching',`, and to `STEP_TEXT` in `apps/web/src/pages/admin/UpdatesPage.tsx`:

```tsx
  checking: 'Checking the new version works',
```

- [ ] **Step 7: Route the release lookup through the outbound guard**

In `packages/core/src/update/update-service.ts`, `fetchLatestRelease` takes `fetchImpl: typeof fetch = fetch` — a bare global `fetch`, which follows redirects and reaches any address DNS answers with. Every other administrator-influenced outbound call in this codebase goes through `guardedFetch`. `RELEASE_REPO` is configuration, and configuration is a thing somebody sets.

Change the default:

```ts
import { guardedFetch } from '../net/guarded-fetch.js';

/**
 * The forge, reached through the same outbound guard every other
 * administrator-influenced request uses.
 *
 * `RELEASE_REPO` is configuration, so the URL this builds is partly somebody's
 * input -- and the bare global `fetch` that was here followed redirects and
 * would connect to whatever address the name resolved to, including this
 * deployment's own network. `guardedFetch` checks every resolved address, pins
 * the connection to the one it checked, and refuses redirects. It is not a
 * second opinion about which addresses may be reached; it is the same one.
 */
const forgeFetch: typeof fetch = guardedFetch({ timeoutMs: 10_000 }) as typeof fetch;
```

and in the signature, `fetchImpl: typeof fetch = forgeFetch`.

`guardedFetch`'s `GuardedFetch` type is deliberately narrower than `typeof fetch` — it follows no redirects and streams no bodies. The cast is safe here and only here, because this call site is one `GET` whose whole response is JSON; note that in a comment beside it. Existing tests pass `fetchImpl` explicitly and are unaffected.

- [ ] **Step 8: Make the release workflow build the tag it says it builds**

In `.github/workflows/release.yml`, `verify: uses: ./.github/workflows/ci.yml` runs the reusable workflow **at the caller's ref**. On `push: tags` that is the tag, which is right. On `workflow_dispatch` with a `tag` input it is the branch the run was started from — so the gate tests branch HEAD while `build` checks out and packages the tag. A tag whose tests fail can be released, which is precisely the promise the gate exists to make.

Replace the `on:` block (lines 12–20) with:

```yaml
on:
  push:
    tags: ['v*']
  # For re-cutting an artefact when the tag is right and the build was not.
  #
  # NO `tag` INPUT. A reusable workflow called with `uses: ./…` runs at the
  # CALLER's ref, so a dispatch from a branch ran the gate against branch HEAD
  # while the build below packaged the input tag -- releasing a tag whose tests
  # nobody ran, which is the one thing this workflow exists to prevent.
  #
  # Run it from the tag instead: GitHub's ref picker lists tags, and then the
  # gate, the checkout and the artefact are all the same commit by
  # construction rather than by agreement.
  workflow_dispatch:
```

Add a guard as the first job:

```yaml
jobs:
  # A dispatch from a branch would build something that is not a release.
  guard:
    runs-on: ubuntu-latest
    steps:
      - name: Refuse anything that is not a tag
        run: |
          set -euo pipefail
          if [ "${{ github.ref_type }}" != "tag" ]; then
            echo "This workflow builds a RELEASE, and ${{ github.ref }} is not a tag." >&2
            echo "Re-run it with a tag selected as the ref." >&2
            exit 1
          fi
          case "${{ github.ref_name }}" in
            v*) : ;;
            *) echo "Tag ${{ github.ref_name }} does not look like a release tag (v*)." >&2; exit 1 ;;
          esac
```

Make `verify` depend on it (`needs: guard`), make `build` depend on both (`needs: [guard, verify]`), and remove every `github.event.inputs.tag` fallback — three places: the checkout `ref` (line 44, which becomes `${{ github.ref }}`) and the `TAG=` line in the meta step (line 78, which becomes `TAG="${{ github.ref_name }}"`).

- [ ] **Step 9: Check everything this touched**

```bash
bash -n ops/syntra-update && bash ops/syntra-update.test.sh
npx vitest run packages/core/src/update/update-service.test.ts
npx tsc -b
cd apps/web && npx vitest run src/pages/admin/UpdatesPage.test.tsx; cd ../..
node -e "const y=require('fs').readFileSync('.github/workflows/release.yml','utf8'); if(/inputs\.tag/.test(y)) { console.error('an inputs.tag fallback is still there'); process.exit(1); } if(!/needs: guard/.test(y)) { console.error('verify does not depend on the guard'); process.exit(1); } console.log('ok')"
```

Expected: `58 passed, 0 failed`, both vitest files green, `tsc` exit 0, and `ok`.

- [ ] **Step 10: Commit**

```bash
git add ops/syntra-update packages/core/src/update/update-service.ts \
        packages/core/src/update/update-service.test.ts \
        apps/web/src/pages/admin/UpdatesPage.tsx .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
fix(update): five smaller ways this told the truth badly

launchUpdater had no 'error' handler on the spawn. `spawn` reports a missing
executable asynchronously, and an unhandled 'error' on an EventEmitter is a
thrown exception with nothing to catch it -- so a host without systemd-run
took the API down, after the route had already answered 202 and audited that
an update was beginning. It now writes the failure into the status file the
console is already watching.

The lock loser called `die`, which writes `failed` into that same file --
over the status of the update that is STILL RUNNING, so the console told an
operator their update had failed while it was migrating their database. A
refusal before anything started now refuses without touching it.

`verifying` meant two things: the checksum, and the post-restart readiness
wait. The console showed "Checking it is intact" for both, so an operator
watching their service be down was told the download was being checked. The
second one is `checking` now.

release.yml's workflow_dispatch took a tag input, but a reusable workflow
called with `uses: ./` runs at the CALLER's ref -- so the gate tested branch
HEAD while the build packaged the tag. A tag whose tests failed could ship,
which is the single thing that workflow exists to prevent. The input is gone
and a guard refuses any ref that is not a v* tag; run it from the tag.

And the release lookup used the bare global fetch, which follows redirects
and connects wherever DNS points. RELEASE_REPO is configuration, so that URL
is partly somebody's input; it goes through guardedFetch now, like every
other outbound call here.
EOF
)"
```

---

### Task 11: The lab rehearsal

**Closes design §10 (the full rehearsal and both mutation checks) and §12 step 7.** It also is the evidence for U1, U2, U4, U5, U6 and U7, none of which any unit test can reach: they are failures of the seam between a tarball, a database, systemd and Docker.

**This is the gate.** Nothing in this plan touches the live install — not the updater, not `syntra-install`, not the migration — until every assertion below has passed.

**Where it runs and why not in a container.** §10 says "a scratch install in a container". The two things being tested are `systemctl restart` and `docker exec` against a Postgres container; a container without systemd tests neither, and a container with both is a day of nesting configuration testing the nesting. So: on the lab host, in its own root, with its own unit, its own port and its own database inside the *existing* `infra-postgres-1`. Nothing it does can reach the live install:

| | Live | Rehearsal |
|---|---|---|
| Root | `/opt/syntra` (and `/root/syntra`) | `/opt/syntra-rehearsal` |
| Unit | `syntra` | `syntra-rehearsal` |
| Port | 3000 | 3999 |
| Database | `syntra` | `syntra_rehearsal` |
| Releases | GitHub | a stub on `127.0.0.1:8899` |

The stub matters for a second reason: the two deliberate breaks are releases that must never exist on the real repository.

**Files:**
- Modify: `ops/syntra-update` — one line, so the forge address is configurable.
- Create: `ops/rehearsal/release-server.py` — the stub forge.
- Create: `ops/rehearsal/make-release.sh` — builds a tarball the way `release.yml` does.
- Create: `ops/rehearsal/README.md` — how to run it, and what each assertion proves.

**Interfaces:**
- Consumes: `ops/syntra-update`, `ops/syntra-install`, a checkout on the lab host, `infra-postgres-1`, systemd.
- Produces:
  - `SYNTRA_RELEASE_API` (default `https://api.github.com`) — the forge base address.
  - `ops/rehearsal/make-release.sh <version> <outdir> [mutator]` — writes `syntra-<version>.tar.gz` and its `.sha256`. `mutator` is an optional shell snippet run inside the assembled tree before it is packed.
  - `ops/rehearsal/release-server.py <dir> <port>` — serves the GitHub release API shapes `syntra-update` calls: `/repos/*/releases/latest`, `/repos/*/releases/tags/v<v>`, and `/assets/<n>`.

- [ ] **Step 1: Make the forge address configurable**

In `ops/syntra-update`, in `api()`, `latest_version()`, `asset_url()`, replace the three occurrences of `https://api.github.com` with `$RELEASE_API`, and add beside `REPO` (line 35):

```bash
# The forge. Configurable for one reason: the rehearsal has to install
# releases that must never exist on the real repository -- a migration that
# fails, and a release whose readiness never goes green -- and a rehearsal that
# cannot stage its own failures is a rehearsal of the happy path.
RELEASE_API="${SYNTRA_RELEASE_API:-https://api.github.com}"
```

Check: `bash -n ops/syntra-update && grep -c 'api\.github\.com' ops/syntra-update` → expect `1` (the default only).

- [ ] **Step 2: Write the stub forge**

Create `ops/rehearsal/release-server.py`:

```python
#!/usr/bin/env python3
"""The three GitHub release endpoints `syntra-update` actually calls.

Not a mock of GitHub. It answers exactly what the updater parses -- a
`tag_name`, an asset list carrying `name` and the API `url` (never
`browser_download_url`, which a private repository 404s), and the asset bytes
under an octet-stream Accept -- so that a rehearsal exercises the real
download, the real checksum check and the real unpack.

    ./release-server.py <directory-of-tarballs> <port>

Every syntra-<version>.tar.gz in the directory is a release; the highest
version is `latest`.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

DIR = sys.argv[1]
PORT = int(sys.argv[2])


def versions():
    found = []
    for name in os.listdir(DIR):
        m = re.fullmatch(r'syntra-([0-9.]+)\.tar\.gz', name)
        if m:
            found.append(m.group(1))
    return sorted(found, key=lambda v: [int(p) for p in v.split('.')])


def assets(version):
    out = []
    for index, name in enumerate(
        [f'syntra-{version}.tar.gz', f'syntra-{version}.tar.gz.sha256']
    ):
        out.append(
            {
                'name': name,
                'url': f'http://127.0.0.1:{PORT}/assets/{version}/{index}',
            }
        )
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        m = re.fullmatch(r'/assets/([0-9.]+)/([01])', self.path)
        if m:
            version, index = m.group(1), int(m.group(2))
            name = [f'syntra-{version}.tar.gz', f'syntra-{version}.tar.gz.sha256'][index]
            path = os.path.join(DIR, name)
            if not os.path.exists(path):
                self.send_error(404)
                return
            with open(path, 'rb') as handle:
                body = handle.read()
            self.send_response(200)
            self.send_header('content-type', 'application/octet-stream')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        m = re.fullmatch(r'/repos/[^/]+/[^/]+/releases/tags/v([0-9.]+)', self.path)
        if m:
            version = m.group(1)
            if version not in versions():
                self.send_error(404)
                return
            return self.json({'tag_name': f'v{version}', 'assets': assets(version)})

        if re.fullmatch(r'/repos/[^/]+/[^/]+/releases/latest', self.path):
            available = versions()
            if not available:
                self.send_error(404)
                return
            version = available[-1]
            return self.json(
                {
                    'tag_name': f'v{version}',
                    'published_at': '2026-08-24T19:02:11Z',
                    'body': f'Rehearsal release {version}.',
                    'assets': assets(version),
                }
            )

        self.send_error(404)

    def json(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
```

- [ ] **Step 3: Write the release builder**

Create `ops/rehearsal/make-release.sh`:

```bash
#!/usr/bin/env bash
#
# Assemble a release tarball the way .github/workflows/release.yml does, from
# the checkout this is run in.
#
#   ./make-release.sh 1.0.1 /var/tmp/releases
#   ./make-release.sh 1.0.3 /var/tmp/releases 'sed -i ... apps/api/src/x.ts'
#
# The third argument is a shell snippet run with the assembled tree as its
# working directory, immediately before packing. That is how the rehearsal
# stages a release that fails -- which is the whole point of having one.
#
# The exclusions and the three tar assertions are the same as release.yml's,
# because a rehearsal against a differently-shaped artefact rehearses a
# different feature.
set -euo pipefail

VERSION="$1"
OUT="$2"
MUTATE="${3:-}"

cd "$(git rev-parse --show-toplevel)"
mkdir -p "$OUT"

STAGE=$(mktemp -d)
NAME="syntra-$VERSION"
TREE="$STAGE/$NAME"
mkdir -p "$TREE"

git ls-files -- . \
  ':(exclude)docs/**' \
  ':(exclude)e2e/**' \
  ':(exclude).github/**' \
  ':(exclude)*.md' \
  > "$STAGE/manifest.txt"
tar -cf - -T "$STAGE/manifest.txt" | tar -xf - -C "$TREE"

[ -f apps/web/dist/index.html ] || pnpm --filter @syntra/web build
mkdir -p "$TREE/apps/web"
cp -a apps/web/dist "$TREE/apps/web/dist"

printf '%s\n' "$VERSION" > "$TREE/VERSION"
cat > "$TREE/RELEASE.json" <<JSON
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$(git rev-parse HEAD)",
  "migrations": []
}
JSON

if [ -n "$MUTATE" ]; then
  ( cd "$TREE" && eval "$MUTATE" )
fi

tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/RELEASE.json$"
tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/apps/web/dist/index.html$"
tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/pnpm-lock.yaml$"

rm -rf "$STAGE"
echo "built $OUT/$NAME.tar.gz"
```

`chmod +x ops/rehearsal/*.sh ops/rehearsal/*.py`.

- [ ] **Step 4: Establish that the live install is untouched, and record it**

On the lab host (`ssh root@192.168.88.20`):

```bash
systemctl is-active syntra; ls -l /opt/syntra/current 2>/dev/null || echo "not converted"
docker exec infra-postgres-1 psql -U syntra -d syntra -tAc \
  "SELECT count(*) FROM \"Tenant\";" > /var/tmp/live-tenants-before.txt
cat /var/tmp/live-tenants-before.txt
```

Expected: `active`, and a tenant count. Write both down. Every later step must leave them identical, and the last step checks.

- [ ] **Step 5: Build the four releases**

On the lab host, in a checkout of this branch:

```bash
mkdir -p /var/tmp/rehearsal-releases
ops/rehearsal/make-release.sh 1.0.0 /var/tmp/rehearsal-releases
ops/rehearsal/make-release.sh 1.0.1 /var/tmp/rehearsal-releases
```

The failing-migration release:

```bash
ops/rehearsal/make-release.sh 1.0.2 /var/tmp/rehearsal-releases '
  mkdir -p packages/db/prisma/migrations/20261001000000_rehearsal_fails
  cat > packages/db/prisma/migrations/20261001000000_rehearsal_fails/migration.sql <<SQL
-- Deliberately impossible. The rehearsal needs a migration that fails AFTER
-- the dump, which is the one moment the design says must be recoverable.
ALTER TABLE "NoSuchTableExistsHere" ADD COLUMN "x" integer;
SQL
'
```

The never-ready release, which also changes the schema and the data so the rollback has something to put back:

```bash
ops/rehearsal/make-release.sh 1.0.3 /var/tmp/rehearsal-releases '
  mkdir -p packages/db/prisma/migrations/20261002000000_rehearsal_widget
  cat > packages/db/prisma/migrations/20261002000000_rehearsal_widget/migration.sql <<SQL
-- Succeeds. It creates an object the pre-update dump does not contain and
-- changes a row the dump does contain -- which is exactly what a rollback has
-- to undo, and exactly what --clean alone left standing.
CREATE TABLE "RehearsalWidget" (id integer PRIMARY KEY);
UPDATE "Tenant" SET name = name || " [BROKEN BY 1.0.3]";
SQL
  sed -i "s/^  const probes = \[/  const probes = [\n    fail(\"rehearsal\", \"deliberately never ready\"),/" \
    packages/core/src/health/readiness.ts
'
```

Verify the last mutation landed — everything downstream depends on it:

```bash
tar -xzOf /var/tmp/rehearsal-releases/syntra-1.0.3.tar.gz \
  syntra-1.0.3/packages/core/src/health/readiness.ts | grep -n 'deliberately never ready'
```

Expected: one match. This release **listens and answers `/health` with 200**, and answers `/health/ready` with 503 forever — which is what makes the second mutation check able to detect anything.

- [ ] **Step 6: Stand up a scratch `dev` install**

On the lab host:

```bash
REH=/opt/syntra-rehearsal
SRC=/opt/syntra-rehearsal-src
rm -rf "$REH" "$SRC"
mkdir -p "$SRC"
git -C /root/syntra ls-files | tar -cf - -C /root/syntra -T - | tar -xf - -C "$SRC"
cp -a /root/syntra/node_modules "$SRC/node_modules" 2>/dev/null || (cd "$SRC" && pnpm install --frozen-lockfile)
docker exec infra-postgres-1 psql -U syntra -c 'DROP DATABASE IF EXISTS syntra_rehearsal'
docker exec infra-postgres-1 psql -U syntra -c 'CREATE DATABASE syntra_rehearsal OWNER syntra_app'
sed -e 's#/syntra$#/syntra_rehearsal#' \
    -e 's#^PORT=.*#PORT=3999#' \
    -e "s#^WEB_ROOT=.*#WEB_ROOT=$SRC/apps/web/dist#" /root/syntra/.env > "$SRC/.env"
grep -q '^PORT=' "$SRC/.env" || echo 'PORT=3999' >> "$SRC/.env"
grep -q '^WEB_ROOT=' "$SRC/.env" || echo "WEB_ROOT=$SRC/apps/web/dist" >> "$SRC/.env"
echo 'PG_CONTAINER=infra-postgres-1' >> "$SRC/.env"
echo "SUPERUSER_DATABASE_URL=postgresql://syntra:syntra@localhost:5432/syntra_rehearsal" >> "$SRC/.env"
(cd "$SRC" && DATABASE_URL="postgresql://syntra_app:syntra_app@localhost:5432/syntra_rehearsal" \
   pnpm --filter @syntra/db exec prisma migrate deploy)
(cd "$SRC" && pnpm --filter @syntra/web build)
```

Note `WEB_ROOT` is **absolute and inside `$SRC`** — that is U7's case, and Task 4 is what has to rewrite it.

Write the scratch unit:

```bash
cat > /etc/systemd/system/syntra-rehearsal.service <<UNIT
[Unit]
Description=Syntra rehearsal
After=docker.service
Requires=docker.service

[Service]
Type=exec
WorkingDirectory=/opt/syntra-rehearsal-src/apps/api
ExecStart=/usr/bin/env node --env-file-if-exists=/opt/syntra-rehearsal-src/.env --import tsx src/server.ts
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=45
UNIT
systemctl daemon-reload && systemctl start syntra-rehearsal
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/health/ready
```

Expected: `200`.

- [ ] **Step 7: Convert it, and check `WEB_ROOT` moved**

```bash
SYNTRA_SRC=/opt/syntra-rehearsal-src SYNTRA_ROOT=/opt/syntra-rehearsal \
  SYNTRA_SERVICE=syntra-rehearsal /root/syntra/ops/syntra-install
grep WEB_ROOT /opt/syntra-rehearsal/shared/.env
ls -l /opt/syntra-rehearsal/current
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/health/ready
```

**Assert:** `WEB_ROOT=/opt/syntra-rehearsal/current/apps/web/dist` (U7 — before Task 4 it still said `/opt/syntra-rehearsal-src/...`); `current -> /opt/syntra-rehearsal/releases/dev`; readiness `200`. The installer's own wait used port 3999 rather than 3000 (U6).

- [ ] **Step 8: Adopt the first release**

```bash
/usr/bin/python3 /root/syntra/ops/rehearsal/release-server.py /var/tmp/rehearsal-releases 8899 &
sleep 1
export SYNTRA_ROOT=/opt/syntra-rehearsal SYNTRA_SERVICE=syntra-rehearsal \
       SYNTRA_RELEASE_API=http://127.0.0.1:8899 SYNTRA_RELEASE_TOKEN=unused
/opt/syntra-rehearsal/bin/syntra-update --adopt 1.0.0
cat /opt/syntra-rehearsal/var/update.status
```

**Assert:** the final status line's step is `succeeded` and its detail is `now running v1.0.0` (U4). `curl -s http://127.0.0.1:3999/health/ready | head -c 200` reports `"version":"1.0.0"`.

That single command also proves U1, U2 and U6: the migrate step found a `DATABASE_URL` in `shared/.env`, the client generated, and the readiness poll went to port 3999.

- [ ] **Step 9: A plain, successful update**

```bash
docker exec infra-postgres-1 psql -U syntra -d syntra_rehearsal -tAc \
  'SELECT count(*) FROM "Tenant";' | tee /var/tmp/reh-tenants.txt
/opt/syntra-rehearsal/bin/syntra-update 1.0.1
cat /opt/syntra-rehearsal/var/update.status
ls -l /opt/syntra-rehearsal/current
ls -1 /opt/syntra-rehearsal/shared/backups
```

**Assert:** status `succeeded`, `now running v1.0.1`; `current -> releases/1.0.1`; exactly one `pre-1.0.1-*.dump` in `backups/`; and `docker exec infra-postgres-1 pg_restore -l < <that dump> | grep -c 'TABLE DATA'` is greater than zero (Task 5's dump assertion).

- [ ] **Step 10: Break it with a migration that fails**

```bash
/opt/syntra-rehearsal/bin/syntra-update 1.0.2 || true
cat /opt/syntra-rehearsal/var/update.status
ls -l /opt/syntra-rehearsal/current
curl -s http://127.0.0.1:3999/health/ready | head -c 200; echo
docker exec infra-postgres-1 psql -U syntra -d syntra_rehearsal -tAc 'SELECT count(*) FROM "Tenant";'
```

**Assert, in order:**
1. The status step is `rolled_back` and the detail begins `migrations failed;` and ends `restored v1.0.1`.
2. `current -> releases/1.0.1`.
3. `/health/ready` is `200` and reports `"version":"1.0.1"`.
4. The tenant count equals `/var/tmp/reh-tenants.txt`.
5. `docker exec infra-postgres-1 psql -U syntra -d syntra_rehearsal -tAc "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261001000000_rehearsal_fails'"` is `0`.

- [ ] **Step 11: Break it with a release that is never ready**

```bash
docker exec infra-postgres-1 psql -U syntra -d syntra_rehearsal -tAc \
  'SELECT name FROM "Tenant" ORDER BY name LIMIT 1;' | tee /var/tmp/reh-tenant-name.txt
time /opt/syntra-rehearsal/bin/syntra-update 1.0.3 || true
cat /opt/syntra-rehearsal/var/update.status
```

**Assert, in order:**
1. The run took a little over 90 seconds — the readiness deadline, spent rather than short-circuited.
2. The status step is `rolled_back`; the detail names `v1.0.3 did not become ready within 90s` and `restored v1.0.1`.
3. `ls -l /opt/syntra-rehearsal/current` → `releases/1.0.1`.
4. `curl -s http://127.0.0.1:3999/health/ready` → 200, `"version":"1.0.1"`.
5. **U5, the one no unit test can reach:** `docker exec infra-postgres-1 psql -U syntra -d syntra_rehearsal -tAc "SELECT to_regclass('public.\"RehearsalWidget\"') IS NULL;"` → `t`. The table the new migration created is **gone**. Before Task 5 this is `f`, and the next update dies at `migrating`.
6. `SELECT name FROM "Tenant" ORDER BY name LIMIT 1;` equals `/var/tmp/reh-tenant-name.txt` — no `[BROKEN BY 1.0.3]`. The data was restored, not merely the schema.
7. `/opt/syntra-rehearsal/bin/syntra-update 1.0.1 || true` reports `1.0.1 is not newer than the running 1.0.1` rather than `relation "RehearsalWidget" already exists`. That is the loop U5 described, proven absent.

- [ ] **Step 12: Mutation check 1 — make the dump non-fatal, and watch the abort test fail**

```bash
cp /opt/syntra-rehearsal/bin/syntra-update /var/tmp/syntra-update.good
sed -i 's#|| die "the pre-migration database dump failed; nothing was changed"#|| log "MUTANT: dump failed, carrying on"#' \
  /opt/syntra-rehearsal/bin/syntra-update
bash -n /opt/syntra-rehearsal/bin/syntra-update
SYNTRA_PG_CONTAINER=no-such-container /opt/syntra-rehearsal/bin/syntra-update 1.0.2 || true
cat /opt/syntra-rehearsal/var/update.status
```

**Assert the test FAILS:** the status reaches `migrating` or beyond, with no dump written for `1.0.2`, i.e. the update proceeded past a backup that did not happen. That is what the guard exists to prevent, and its absence is now visible.

Restore, and prove the guard is what was doing the work:

```bash
cp /var/tmp/syntra-update.good /opt/syntra-rehearsal/bin/syntra-update
SYNTRA_PG_CONTAINER=no-such-container /opt/syntra-rehearsal/bin/syntra-update 1.0.2 || true
cat /opt/syntra-rehearsal/var/update.status
```

**Assert:** step `failed`, detail `the pre-migration database dump failed; nothing was changed`, and `ls -l /opt/syntra-rehearsal/current` still `releases/1.0.1`.

- [ ] **Step 13: Mutation check 2 — gate on `/health`, and watch the broken-update test fail**

No code change: the gate is configuration now, which is exactly what makes this checkable.

```bash
SYNTRA_READY_URL=http://127.0.0.1:3999/health \
  /opt/syntra-rehearsal/bin/syntra-update 1.0.3 || true
cat /opt/syntra-rehearsal/var/update.status
curl -s -o /dev/null -w 'ready=%{http_code}\n' http://127.0.0.1:3999/health/ready
ls -l /opt/syntra-rehearsal/current
```

**Assert the test FAILS:** status `succeeded`, `now running v1.0.3`; `current -> releases/1.0.3`; and `/health/ready` answers **503** while `/health` answers 200. The updater declared success over a release that does not work — which is precisely §1.1's claim, demonstrated rather than asserted.

Then put it back and prove the real gate catches it:

```bash
/opt/syntra-rehearsal/bin/syntra-update --rollback
cat /opt/syntra-rehearsal/var/update.status
curl -s http://127.0.0.1:3999/health/ready | head -c 120; echo
```

**Assert:** step `rolled_back`, `returned to v1.0.1`, and readiness 200 reporting `1.0.1`.

- [ ] **Step 14: Prove the live install is exactly where it was**

```bash
systemctl is-active syntra
docker exec infra-postgres-1 psql -U syntra -d syntra -tAc 'SELECT count(*) FROM "Tenant";'
diff <(docker exec infra-postgres-1 psql -U syntra -d syntra -tAc 'SELECT count(*) FROM "Tenant";') \
     /var/tmp/live-tenants-before.txt && echo "live database untouched"
ls -l /opt/syntra 2>/dev/null || echo "/opt/syntra does not exist"
systemctl status syntra --no-pager -n 3 | head -5
```

**Assert:** `active`, the tenant count identical to Step 4, and `/opt/syntra` in whatever state it was before. **If any of these differ, stop and report it — the rehearsal has leaked into the live install and the isolation this task rests on is wrong.**

- [ ] **Step 15: Tear the rehearsal down**

```bash
systemctl stop syntra-rehearsal && systemctl disable syntra-rehearsal 2>/dev/null || true
rm -f /etc/systemd/system/syntra-rehearsal.service && systemctl daemon-reload
kill %1 2>/dev/null || pkill -f release-server.py
docker exec infra-postgres-1 psql -U syntra -c 'DROP DATABASE IF EXISTS syntra_rehearsal'
rm -rf /opt/syntra-rehearsal /opt/syntra-rehearsal-src /var/tmp/rehearsal-releases
```

Leave `/var/tmp/live-tenants-before.txt` — it is the evidence for Step 14.

- [ ] **Step 16: Write down what it proved**

Create `ops/rehearsal/README.md` recording: the layout table from the head of this task; the exact sequence of Steps 5–13; each assertion and the finding it closes (U1, U2, U4, U5, U6, U7 in Steps 7–11; the two mutation checks in 12 and 13); and the sentence that makes it repeatable — **the rehearsal is the gate on touching the live install, and it is run again whenever `ops/syntra-update` changes.**

- [ ] **Step 17: Commit**

```bash
git add ops/syntra-update ops/rehearsal/release-server.py ops/rehearsal/make-release.sh \
        ops/rehearsal/README.md
git commit -m "$(cat <<'EOF'
test(update): rehearse an update, and break two releases on purpose

The design has listed this as outstanding since it was written, and it is
the only thing that can see the failures the unit tests cannot: every
blocker in this plan lives at the seam between a tarball, a database,
systemd and Docker.

A scratch install with its own root, unit, port and database, converted from
a `dev` tree, adopted to its first release, updated once successfully, then
broken twice -- a migration that fails, and a release that listens and never
becomes ready. The assertions are that the rollback restored the CODE and
the DATA, including dropping the table the new migration created, which is
the failure that would otherwise have wedged every later attempt.

Plus both mutation checks the design asks for. Make the dump non-fatal and
the abort test stops failing; gate on /health instead of /health/ready and
the updater declares success over a release answering 503 -- which is
section 1.1's argument, demonstrated instead of asserted.

Not in a container, deliberately: the two things under test are `systemctl
restart` and `docker exec`, and a container without systemd tests neither.
Isolation comes from a separate root, unit, port and database instead, and
the last step asserts the live install is byte-for-byte where it was.

The forge address is configurable so the rehearsal can serve releases that
must never exist on the real repository.
EOF
)"
```

---

## Done when

- [ ] `ops/syntra-update.test.sh` reports `58 passed, 0 failed`, and every one of them exercises a function sourced out of the shipped script.
- [ ] `npx tsc -b` exits 0; `npx vitest run packages/core/src/update/update-service.test.ts packages/core/src/health/readiness.test.ts` is green; `pnpm --filter @syntra/web test` is green.
- [ ] An update applied to a scratch install migrates, generates its client, swaps and comes up — no `Environment variable not found: DATABASE_URL`, no `@prisma/client did not initialize yet`. (U1, U2)
- [ ] The Owner of a single-tenant install holds `deployment.manage` and the Updates page renders for them. (U3)
- [ ] A converted `dev` install reaches a release through `syntra-update --adopt`, and its `WEB_ROOT` points at `current`. (U4, U7)
- [ ] A rollback leaves no table the failed release's migration created, and restores a row that release changed. (U5)
- [ ] An install on a port that is not 3000, in a container that is not `infra-postgres-1`, updates and rolls back correctly. (U6)
- [ ] `previous_release` never answers `dev` while a numeric release exists, and never answers a `.partial`. (U8)
- [ ] `/health/ready` refuses the 31st request in a minute and never puts a database host on the wire. (U9)
- [ ] The Updates page keeps polling after a 202 with no status file yet, polls `/update/status`, and will not offer the button twice. (U10)
- [ ] A missing `systemd-run` shows as a failed update rather than crashing the API; a second updater that loses the lock leaves the first one's status alone; `release.yml` refuses a ref that is not a `v*` tag; the readiness wait says `checking`; the release lookup goes through `guardedFetch`.
- [ ] Both mutation checks fail the tests they are supposed to fail, and pass again when reverted.
- [ ] The live lab install is untouched: `syntra` active, the `syntra` database's tenant count unchanged, `/opt/syntra` as it was.
- [ ] `packages/core/src/auth/password-reset.test.ts` is still uncommitted and untouched.

## Deliberately not in this plan

- **Remediation 1 — Urgent.** C1 (the duplicate-holding snapshot failure), D1 (`db:reset`), R1–R3, X1–X3. Task 2 here depends on plan 1 Task 5's `KNOWN_MIGRATIONS` only if that has landed, and says so.
- **Remediation 2 — Governance.** G1–G27.
- **Remediation 3 — Approvals and provisioning.** A1–A9, P1–P8.
- **Remediation 4 — Auth, API and console.** H1–H6, N1–N6, W1–W9, S1–S7, B1–B5 — including **H2**, the general case of U3: role management, and a backfill that re-syncs built-in roles to the whole catalogue. Task 2 here is the narrow, single-permission, single-tenant migration; the two are idempotent with each other and the reasoning for keeping both is written into that task.
- **`UpdateRun`.** §13 says why it was not built and nothing in the findings asks for it.
- **Manifest hashing for the modified-tree check** (§7.4). Task 3 stops the README claiming it exists; implementing it is a separate piece of work with its own design question — what counts as modified when `deploy.sh` has legitimately pushed to a release.
- **S5** — `/health/ready` having no timeout of its own. It is filed under §7.3 rather than §5 and belongs with the readiness work in another plan; note that it interacts with this one, since a database that accepts TCP and stops answering hangs the gate the rollback decision waits on.
- **Zero-downtime updates, unattended updates, and downgrades.** §11 of the design rules all three out, with reasons.
