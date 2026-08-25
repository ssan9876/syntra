# The update rehearsal

**This rehearsal has been run against the lab**, on 2026-08-25, following
`docs/superpowers/plans/2026-08-24-remediation-5-update-feature.md`, Task 11,
Steps 4-15, exactly. It found two real bugs neither the original plan nor any
unit test anticipated — one in this rehearsal's own stub server, one in
`ops/syntra-update` itself — fixed both, and re-ran the steps that exercised
them to confirm the fixes hold. The live install (`/root/syntra`, unconverted,
port 3000, database `syntra`) was never touched: Step 14 diffed it against the
Step 4 baseline afterward and found it identical.

**This rehearsal is the gate on touching the live install, and it must be run
again whenever `ops/syntra-update` changes.**

## Why not in a container

The two things under test are `systemctl restart` and `docker exec` against
a Postgres container. A container without systemd tests neither; a container
with both is a day of nesting configuration testing the nesting. So the
rehearsal runs on the lab host itself, in its own root, with its own unit,
its own port, and its own database inside the *existing* `infra-postgres-1`.
Nothing it does should be able to reach the live install:

| | Live | Rehearsal |
|---|---|---|
| Root | `/opt/syntra` (and `/root/syntra`) | `/opt/syntra-rehearsal` |
| Unit | `syntra` | `syntra-rehearsal` |
| Port | 3000 | 3999 |
| Database | `syntra` | `syntra_rehearsal` |
| Releases | GitHub | a stub on `127.0.0.1:8899` |

The stub matters for a second reason beyond isolation: the two deliberate
breaks used in Steps 10 and 11 are releases (a migration that fails, and a
release that never becomes ready) that must never exist on the real
repository.

One further isolation note the plan did not anticipate, found during the run:
`/root/syntra` (the live install) is not a git repository, so Step 6's literal
`git -C /root/syntra ls-files` has no `/root/syntra` to run against. The
scratch install's file tree is sourced from a locally-cloned checkout
(`/root/syntra-rehearsal-checkout`) instead — same idea, tracked files only,
via a git repository that actually exists — while `/root/syntra/.env` is still
used as the template for the rehearsal's own `.env`, matching the plan's
intent. Two smaller Step 6 gaps surfaced alongside this: pnpm gives every
workspace package its own `node_modules` (not just one at the root), and the
checkout had never had `pnpm db:generate` run against it — both are one-line
fixes in the standup script, not in shipped product code.

## The tooling

- `ops/syntra-update` — the forge base address is `$RELEASE_API`, defaulting
  to `https://api.github.com` and overridable with `SYNTRA_RELEASE_API`. This
  lets the rehearsal point the updater at the stub below instead of the real
  GitHub API. A second, real fix landed here during the run itself — see
  "The rollback bug this rehearsal found" below.
- `ops/rehearsal/release-server.py <dir> <port>` — serves the three GitHub
  release endpoints `syntra-update` actually calls
  (`/repos/*/releases/latest`, `/repos/*/releases/tags/v<v>`,
  `/assets/<id>`), reading whichever `syntra-<version>.tar.gz` files exist in
  `<dir>`. The highest version is `latest`. Its asset objects list `url`
  before `name` and use a bare incrementing integer for the asset id — both
  match real GitHub's actual shape, and both had to be fixed during the run;
  see below.
- `ops/rehearsal/make-release.sh <version> <outdir> [mutator]` — builds a
  release tarball from whatever checkout it is run in, the way
  `.github/workflows/release.yml` does, and writes `syntra-<version>.tar.gz`
  plus its `.sha256` into `<outdir>`. The optional third argument is a shell
  snippet run inside the assembled release tree, immediately before packing
  — this is how the rehearsal stages a release that deliberately fails (a
  migration that cannot apply) or one that deliberately never becomes ready
  (a readiness probe patched to always fail).

### If `make-release.sh` exits non-zero without printing `built ...`

Its three self-check lines (`tar -tzf ... | grep -q ...`) run under
`set -o pipefail`, inherited verbatim from `.github/workflows/release.yml`'s
own already-shipped packaging step -- deliberately, so this script rehearses
the same artefact-shape checks the real release does. `grep -q` can exit as
soon as it finds its match, before `tar -tzf` has finished writing its full
listing; when that happens, `tar` gets `SIGPIPE`, and under `pipefail` bash
reports that non-zero exit as the whole pipeline's status even though `grep`
itself matched successfully. If this happens, check whether the tarball was
actually built correctly (`tar -tzf $OUT/$NAME.tar.gz | head`) before
assuming packaging failed -- it usually did not.

## The procedure that was run (Steps 4-15)

1. **Establish the live install is untouched, and record it (Step 4).**
   `systemctl is-active syntra` → `active`; `/opt/syntra/current` → does not
   exist; live `Tenant` count → `1`, saved to
   `/var/tmp/live-tenants-before.txt`.

2. **Build four releases (Step 5)** with `make-release.sh`: `1.0.0` and
   `1.0.1` as plain, successful releases; `1.0.2` with a migration that
   references a table that does not exist (fails after the pre-migration
   dump — the one moment that must be recoverable); `1.0.3` with a migration
   that succeeds but creates a table and mutates a row the pre-update dump
   does not contain, plus a readiness probe patched to fail forever, so it
   is a release that answers `/health` with 200 but `/health/ready` with 503
   permanently. All four built and content-verified.

3. **Stand up a scratch `dev` install (Step 6)** at `/opt/syntra-rehearsal`,
   with its own `.env` pointed at `syntra_rehearsal` on port 3999, and a
   `syntra-rehearsal.service` unit running it directly (not yet converted).
   `/health/ready` → `200`.

4. **Convert it with `syntra-install` (Step 7)** and confirmed `WEB_ROOT`
   moved to `/opt/syntra-rehearsal/current/apps/web/dist` — proof for
   **U7**, the `WEB_ROOT` path that used to point at the source checkout
   instead of the release symlink. Also confirmed the installer's own
   readiness wait respects a non-3000 port — proof for **U6**. (The first
   attempt used `/root/syntra/ops/syntra-install`, per the plan's literal
   command, and reproduced U7 exactly — that copy of the script predates
   this repository's fixes. Re-run from the checkout's fixed copy, it
   passed.)

5. **Adopt the first release with `syntra-update --adopt 1.0.0` (Step 8)**,
   pointed at the stub server via `SYNTRA_RELEASE_API=http://127.0.0.1:8899`.
   Succeeded: `ready:true, version:"1.0.0"` — proof that the migrate step
   found `DATABASE_URL` in `shared/.env` (**U1**), the Prisma client
   generated (**U2**), and the readiness poll went to port 3999 rather than
   the hardcoded 3000 (**U6** again, from the updater's side this time).
   (The first attempt failed here — see "The stub server bug" below.)

6. **A plain, successful update to `1.0.1` (Step 9)**: succeeded, `current ->
   releases/1.0.1`, exactly one `pre-1.0.1-*.dump` in `shared/backups`,
   containing 111 tables of data — the assertion Task 5 added.

7. **Break it with a migration that fails (Step 10)**, updating to `1.0.2`.
   Rolled back correctly: `current -> releases/1.0.1`, `/health/ready` back
   to `1.0.1`, tenant count unchanged, the failed migration not recorded as
   applied. (This step's own ordinary failure mode — an unpacked-but-never-
   adopted `releases/1.0.2` left on disk — is what Step 13's `--rollback`
   later walked into; see "The rollback bug this rehearsal found" below.)

8. **Break it with a release that never becomes ready (Step 11)**, updating
   to `1.0.3`. Took ~1m45s (over the 90s readiness deadline, spent rather
   than short-circuited), rolled back, and — the one finding no unit test
   can reach, **U5** — the table `1.0.3`'s migration created
   (`RehearsalWidget`) was gone after rollback, and the row it mutated was
   restored. A subsequent update to `1.0.1` correctly reported "not newer
   than the running 1.0.1" rather than a duplicate-table error.

9. **Mutation check 1 (Step 12).** `dump_database()` turned out to have
   *four* independent guards, not the one the plan named — exit-code,
   non-empty, PGDMP magic bytes, and a table-data-count check. Neutering
   only the named one still failed safely, because the other three caught
   it independently; neutering all four let the update proceed past a fake
   (0-byte) backup and reach `migrating`, exactly as the plan predicts for
   an unguarded update — and, since the mutation was deliberately total,
   the subsequent rollback had nothing to restore from, landing the scratch
   database in the wedged state a real guard exists to prevent. Restored
   and reconfirmed: `failed`, `the pre-migration database dump failed;
   nothing was changed`, `current` unchanged.

10. **Mutation check 2 (Step 13).** Gated on `/health` instead of
    `/health/ready`: `succeeded`, `now running v1.0.3`, `current ->
    releases/1.0.3`, `/health/ready` `503` while `/health` `200` — the
    updater declaring success over a release that does not work, which is
    section 1.1's argument demonstrated rather than asserted. Restoring the
    real gate and running `--rollback` is where the rollback bug below
    surfaced; once fixed, it correctly returned to `v1.0.1`.

11. **Prove the live install is exactly where it was (Step 14).** `syntra`
    still `active`, tenant count still `1`, `/opt/syntra` still absent,
    the unit's uptime showing no restart across the whole rehearsal.

12. **Tear the rehearsal down (Step 15).** Scratch unit stopped and its file
    removed, stub server killed, `syntra_rehearsal` dropped, scratch roots
    and release directory removed. `/var/tmp/live-tenants-before.txt` kept,
    as the evidence for Step 14.

## The stub server bug this rehearsal found

Step 8's first attempt failed: `release v1.0.0 has no asset named
syntra-1.0.0.tar.gz`, even though the asset was right there. Nobody had ever
run `syntra-update`'s real download path against `release-server.py` before
this — the tooling's own "what has actually been done" record (below, in the
previous version of this file) says as much. `asset_url()` parses the release
JSON with `tr ',' '\n'` and a couple of greps that depend on the *exact* shape
real GitHub uses: `url` listed before `name` in each asset object, and the
asset id at the end of the URL being bare digits. `release-server.py` had
`name` before `url`, and used `/assets/<version>/<index>` (e.g.
`1.0.0/0`) instead of a bare integer — neither matches, so `asset_url()`
silently returned nothing. Fixed in `release-server.py`: `url` now precedes
`name`, and asset ids are a stateless, deterministically-recomputed integer
(`versions().index(version) * 2 + index`). Rehearsal tooling only; nothing in
`ops/syntra-update` changed for this one, because it was already correct
against the thing it actually has to talk to.

## The rollback bug this rehearsal found

Step 13's second half — restore the real readiness gate, then
`syntra-update --rollback`, expecting `v1.0.1` — instead returned `v1.0.2`.
Step 10, run earlier in this exact sequence, is what caused it: its migration
failure leaves `releases/1.0.2` on disk, unpacked but never adopted, sitting
numerically between the true previous version (`1.0.1`) and the one that
failed to replace it. `do_rollback()`'s target, `previous_release()`, had no
way to tell that apart from a real predecessor — it picks "the highest
version number present in `releases/` that is less than the one running now",
which is exactly what an orphan like this looks like. The result was v1.0.2's
code paired with v1.0.1-era restored data: a genuine version mismatch, caught
by the readiness probe (`migrations: fail`) but leaving the service down
rather than the plan's expected clean return to `v1.0.1`.

This is a distinct case from the bug `previous_release_of()`'s own comment
already documents and guards against (rolling *forward* into a newer orphan
left by a failed update) — this is the same shape of problem in the other
direction, against an *older* orphan, and nothing existing caught it because
no unit test constructs a stale unpacked release directory to test against.

Fixed with a small persisted breadcrumb, `var/previous-version`, written by
`record_previous()` at the one moment a forward update is confirmed rather
than merely attempted — after `wait_ready` has passed for the new version,
recording the version it replaced. `previous_release()` now trusts that
recorded answer first (validating it is not the currently-running version and
still exists on disk), falling back to the original directory-scan heuristic
only when no history has been recorded yet — e.g. immediately after
`--adopt`, before any update has ever completed. Deliberately not written on
a rollback: there is no well-defined "one before that" without a full history
stack, so an operator who rolls back twice in a row lands on the same target
twice rather than somewhere invented.

Six new test cases cover this in `ops/syntra-update.test.sh`, against
`previous_release()` itself (not just the already-pure `previous_release_of()`
below it) with real scratch files on disk, reproducing the exact orphan
scenario Step 10 creates. All 64 tests pass, both locally and on the lab host.

Re-run against the lab after the fix: Step 10 (recreate the orphan) through
Step 13's `--rollback` were replayed with the corrected script installed, and
`--rollback` correctly returned `v1.0.1` with readiness `200`.

## Findings this procedure closed

`U1`, `U2`, `U4`, `U5`, `U6` and `U7` are failures at the seam between a
tarball, a database, systemd and Docker — none of them reachable by a unit
test. Steps 7-11 above are where each was exercised: `U1`/`U2` in Step 8
(migrate + client generation), `U4` in Step 8 (adopt succeeds), `U6` in
Steps 7 and 8 (port 3999 respected by both the installer and the updater),
`U7` in Step 7 (`WEB_ROOT` moved to `current`), and `U5` in Step 11 (the
table a rolled-back migration created is actually dropped, and the data it
mutated is actually restored). The two mutation checks in Steps 12 and 13
are the evidence that the dump guard and the readiness gate are load-bearing
— that removing either one breaks a test that is supposed to catch exactly
that removal. Two further findings, outside the original U1-U10 list, came
from the rehearsal's own execution rather than from code review: the stub
server's asset-shape mismatch, and the `--rollback` orphan bug, both above.
