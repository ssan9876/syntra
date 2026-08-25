# The update rehearsal

**This rehearsal has NOT yet been run against the lab.** The tooling below
(`ops/syntra-update`'s configurable forge address, `release-server.py`,
`make-release.sh`) is written and locally verified — see "What has actually
been done" at the end of this file — but the procedure that exercises it
against a real scratch install, a real `infra-postgres-1`, and real systemd
units has not been executed by anyone yet. Running it requires deliberate,
separately-authorized access to the lab host (`ssh root@192.168.88.20`) and
must follow the exact commands in the plan document,
`docs/superpowers/plans/2026-08-24-remediation-5-update-feature.md`, Task 11,
Steps 4-15. Do not treat anything below as a report of a run that happened —
it is the specification of a run that is still owed.

**This rehearsal is the gate on touching the live install, and it must be
run again whenever `ops/syntra-update` changes.**

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

## The tooling

- `ops/syntra-update` — the forge base address is now `$RELEASE_API`,
  defaulting to `https://api.github.com` and overridable with
  `SYNTRA_RELEASE_API`. This is the only change to the shipped script; it
  lets the rehearsal point the updater at the stub below instead of the real
  GitHub API.
- `ops/rehearsal/release-server.py <dir> <port>` — serves the three GitHub
  release endpoints `syntra-update` actually calls
  (`/repos/*/releases/latest`, `/repos/*/releases/tags/v<v>`,
  `/assets/<version>/<index>`), reading whichever `syntra-<version>.tar.gz`
  files exist in `<dir>`. The highest version is `latest`.
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

## The procedure Steps 4-15 would follow (not yet run)

This is a description of what the plan's Task 11 asks for, so a reader can
evaluate the rehearsal design without re-opening the plan document. It is
not a record of execution.

1. **Establish the live install is untouched, and record it (Step 4).**
   Capture `systemctl is-active syntra` and the live `Tenant` count before
   touching anything, so Step 14 has something to diff against.

2. **Build four releases (Step 5)** with `make-release.sh`: `1.0.0` and
   `1.0.1` as plain, successful releases; `1.0.2` with a migration that
   references a table that does not exist (fails after the pre-migration
   dump — the one moment that must be recoverable); `1.0.3` with a migration
   that succeeds but creates a table and mutates a row the pre-update dump
   does not contain, plus a readiness probe patched to fail forever, so it
   is a release that answers `/health` with 200 but `/health/ready` with 503
   permanently.

3. **Stand up a scratch `dev` install (Step 6)** at `/opt/syntra-rehearsal`,
   with its own `.env` pointed at `syntra_rehearsal` on port 3999, and a
   `syntra-rehearsal.service` unit running it directly (not yet converted).

4. **Convert it with `syntra-install` (Step 7)** and confirm `WEB_ROOT`
   moved to `/opt/syntra-rehearsal/current/apps/web/dist` — proof for
   **U7**, the `WEB_ROOT` path that used to point at the source checkout
   instead of the release symlink. Also confirms the installer's own
   readiness wait respects a non-3000 port — proof for **U6**.

5. **Adopt the first release with `syntra-update --adopt 1.0.0` (Step 8)**,
   pointed at the stub server via `SYNTRA_RELEASE_API=http://127.0.0.1:8899`.
   A successful adopt is proof that the migrate step found `DATABASE_URL` in
   `shared/.env` (**U1**), the Prisma client generated (**U2**), and the
   readiness poll went to port 3999 rather than the hardcoded 3000 (**U6**
   again, from the updater's side this time).

6. **A plain, successful update to `1.0.1` (Step 9)**, asserting exactly one
   pre-update dump lands in `shared/backups` and that dump actually contains
   table data — the assertion Task 5 added.

7. **Break it with a migration that fails (Step 10)**, updating to `1.0.2`.
   Asserts the run rolls back, `current` returns to `releases/1.0.1`,
   `/health/ready` reports `1.0.1` again, the tenant count is unchanged, and
   the failed migration is not recorded as applied.

8. **Break it with a release that never becomes ready (Step 11)**, updating
   to `1.0.3`. Asserts the run spends the full 90-second readiness deadline
   rather than short-circuiting, rolls back, and — the one finding no unit
   test can reach, **U5** — that the table `1.0.3`'s migration created
   (`RehearsalWidget`) is gone after rollback, and the row it mutated is
   restored to its original value. Also asserts a subsequent update to
   `1.0.1` reports "not newer than the running 1.0.1" rather than a
   duplicate-table error, proving the rollback left the database in a state
   a later update can build on rather than a wedged one.

9. **Mutation check 1 (Step 12).** Neuter the guard that makes a failed
   pre-migration dump fatal, and confirm the test that is supposed to catch
   an unguarded update *fails* — the update proceeds past a backup that
   never happened. Then restore the guard and confirm the same scenario now
   fails safely with `current` unchanged. This is the evidence that the
   dump-fatality guard is actually doing the work it is credited with, not
   just present in the diff.

10. **Mutation check 2 (Step 13).** Point the readiness gate at `/health`
    instead of `/health/ready` (a configuration change, not a code change)
    and confirm the broken-update test *fails*: the updater reports success
    over `1.0.3`, a release that never becomes ready, because `/health`
    alone reports 200. This is section 1.1's argument — that readiness must
    be a distinct check from liveness — demonstrated by breaking it, not
    merely asserted. Then restore the real gate and roll back to confirm it
    catches the same release correctly.

11. **Prove the live install is exactly where it was (Step 14).** Re-run the
    Step 4 checks and diff against the recorded values. Any difference means
    the rehearsal leaked into the live install and the isolation this task
    rests on is wrong — that is treated as a stop-and-report condition, not
    a warning.

12. **Tear the rehearsal down (Step 15).** Stop and remove the scratch unit,
    kill the stub server, drop `syntra_rehearsal`, and remove the scratch
    roots and release directory. `/var/tmp/live-tenants-before.txt` is kept,
    since it is the evidence for Step 14.

## Findings this procedure is the evidence for

`U1`, `U2`, `U4`, `U5`, `U6` and `U7` are failures at the seam between a
tarball, a database, systemd and Docker — none of them reachable by a unit
test. Steps 7-11 above are where each is exercised: `U1`/`U2` in Step 8
(migrate + client generation), `U4` in Step 8 (adopt succeeds), `U6` in
Steps 7 and 8 (port 3999 respected by both the installer and the updater),
`U7` in Step 7 (`WEB_ROOT` moved to `current`), and `U5` in Step 11 (the
table a rolled-back migration created is actually dropped, and the data it
mutated is actually restored). The two mutation checks in Steps 12 and 13
are the evidence that the dump guard and the readiness gate are load-bearing
— that removing either one breaks a test that is supposed to catch exactly
that removal.

## What has actually been done in this repository

Only the parts of Task 11 that are pure code/doc artifacts, not requiring
the lab:

- `ops/syntra-update`'s forge address is configurable
  (`SYNTRA_RELEASE_API`), defaulting to `https://api.github.com`. Verified:
  `bash -n ops/syntra-update` passes and `grep -c 'api\.github\.com'
  ops/syntra-update` reports `1` (only the default in the variable
  assignment). `ops/syntra-update.test.sh` still reports `58 passed, 0
  failed`.
- `ops/rehearsal/release-server.py` was smoke-tested locally: started
  against a scratch directory holding one built tarball, it served
  `/repos/x/y/releases/latest` and `/repos/x/y/releases/tags/v<version>`
  with the expected JSON shape, and served the asset byte-for-byte
  identical to the tarball on disk over `/assets/<version>/<index>`.
- `ops/rehearsal/make-release.sh` was run locally (against this checkout,
  into a local scratch directory — not against any release or install) and
  produced a `.tar.gz` and matching `.sha256` containing `RELEASE.json`,
  `apps/web/dist/index.html` and `pnpm-lock.yaml` at the expected paths.

Steps 4-15 — standing up `/opt/syntra-rehearsal`, adopting and updating
releases against the real `infra-postgres-1`, breaking two releases on
purpose, both mutation checks, and tearing the scratch install down — were
deliberately not attempted in this session. They require SSH access to
`192.168.88.20` and mutate real systemd units and a real Postgres container
next to the live database; that is out of scope for a code-only change and
is left for a session explicitly authorized to touch the lab.
