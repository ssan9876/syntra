# Operating Syntra

Upgrades, backups, what "delete" actually means in this product, and how the
test suite and CI are put together — including the troubleshooting notes that
save the most time.

## Upgrades

Syntra's own in-console updater and the `syntra-update` / `syntra-install`
scripts under `ops/` are covered end to end, including the systemd units and
a full worked run, in [`docs/lab/README.md`](lab/README.md#why-this-is-not-an-ordinary-update-button)
— that document is written from an actual lab deployment and is the source
of truth for the update workflow. In short: the updater is not part of
Syntra, runs as its own transient systemd unit outside the API process, takes
a pre-migration database dump through the Postgres container before it acts,
and can roll back. The environment variables that configure it —
`RELEASE_REPO`, `RELEASE_TOKEN`, `RELEASE_ROOT`, `PG_CONTAINER` — are listed
in [Configuration](configure.md#updating-from-the-console); all are optional,
and an install that sets none of them simply has no update button.

The scripts themselves are not tied to the lab: `SYNTRA_ROOT` moves the
release layout away from `/opt/syntra`, and `SYNTRA_RELEASE_REPO` names the
GitHub repository whose releases they download, for a fork that cuts its own.

For the container path (`docker-compose.yml`), an upgrade is pulling a newer
image: set `SYNTRA_VERSION` to the release you want and re-run
`docker compose up -d` (see [Install](install.md#running-it-for-real-the-container-path)).

## Backups

Two things to keep, and either one alone is not enough:

- **The database.** It is the whole state of the deployment — tenants,
  persons, contracts, policy, the audit log, every application's
  configuration.
- **`MASTER_KEY`.** It encrypts every stored credential and signs SAML. A
  restored database with a lost `MASTER_KEY` means every stored secret is
  unreadable and every SAML integration has to be reconfigured. It is not
  stored in the database, so it does not come back with a database restore —
  back it up separately, and never rotate it by hand.

`syntra-backup` takes care of the first and **detects** a mismatch in the
second. It does not fix one: keeping the key is still yours.

```
syntra-backup create               take one
syntra-backup verify [name]        prove one restores, then throw the copy away
syntra-backup restore <name> --yes replace the live database with one
syntra-backup list                 what is here, and whether it can be restored
```

Backups land in `/opt/syntra/backups`, one directory each, holding a
`pg_dump` archive and a manifest. `SYNTRA_BACKUP_DIR` moves them and
`SYNTRA_BACKUP_KEEP` changes how many are kept (seven by default; the oldest
beyond that are pruned after each successful run).

**They are deliberately not in `shared/backups`.** That is where the updater
puts its pre-migration dumps, and it prunes that directory to the last three on
every upgrade — a backup history kept beside them would be silently truncated
by an unrelated update, and you would find out during a recovery.

### Turning it on

The timers are installed by `syntra-install` and **left disabled**, because a
tool that starts writing gigabytes to a disk nobody sized for it is a tool that
gets uninstalled. Turn them on deliberately:

```bash
systemctl enable --now syntra-backup.timer          # daily
systemctl enable --now syntra-backup-verify.timer   # weekly
```

**Enable the second one.** It is the point of the arrangement, not a fourth
command you might get to later. A backup schedule nobody checks produces a
directory full of files with the shape of backups, and the first time anybody
learns otherwise is the worst possible time. `verify` restores the newest
backup into a scratch database, counts what arrived, and drops it — it never
touches the live database, which is what makes it safe to run unattended.

A truncated or corrupt archive still starts with the right magic bytes and is
still non-empty. `verify` is what tells the difference between an archive that
is well-formed and one that is restorable.

### When a restore refuses

`restore` refuses an interrupted backup, a backup whose archive no longer
passes the checks it passed when taken — archives rot on disk — and this:

```
syntra-backup: this backup was taken under a different MASTER_KEY
  backup:  sha256:9f2b…
  running: sha256:41c7…
```

The manifest records a salted fingerprint of `MASTER_KEY`, never the key
itself, so a stolen backup is not a stolen key. What the fingerprint buys is
this refusal: restoring a database whose secrets were sealed under a key you no
longer have is a restore that appears to succeed and has quietly destroyed
every stored credential's usability.

The right response is almost always to go and find the original key.
`--accept-secret-loss` overrides it for the cases where the answer is genuinely
yes — a development host, or a deployment whose secrets are all being rotated
anyway. It does not imply `--yes`; you still have to say both.

A backup taken where `MASTER_KEY` could not be read records `null` and `list`
shows its key column as `unknown`. Unknown never counts as a match.

### Getting them off the host

Not this tool's job, deliberately. `rsync`, `restic` and every object-store
client already do it better than a shell script bolted onto this one would.
Each backup is a self-contained directory with a stable, sortable name; point
something at `/opt/syntra/backups` and it will do the right thing.

There is no point-in-time recovery here — that is WAL archiving, a different
feature with different operational requirements, and `pg_dump` is not a step
toward it.

## Metrics

`GET /metrics`, in Prometheus text exposition, authenticated by a bearer token.

**Set `METRICS_TOKEN` to turn it on.** With no token the route is not
registered at all and the path answers 404 — not 403. That is deliberate: a
route answering 403 confirms its own existence, and the existence of a metrics
endpoint tells somebody probing what this deployment is and how it is operated.
Sixteen characters minimum, and it should be random.

```yaml
scrape_configs:
  - job_name: syntra
    bearer_token: <METRICS_TOKEN>
    static_configs:
      - targets: ['syntra.example:3000']
```

### What it reports

Process and runtime metrics — heap, CPU, event-loop lag — plus:

| Metric | Answers |
|---|---|
| `syntra_http_request_duration_seconds` | Request latency, by route pattern and status |
| `syntra_build_info` | Which release is running |
| `syntra_webhook_deliveries_pending` | Is the webhook sender keeping up? |
| `syntra_webhook_deliveries_abandoned` | Has any integration stopped being fed? |
| `syntra_logout_deliveries_pending` | Back-channel logouts still in flight |
| `syntra_logout_deliveries_abandoned` | **Offboardings a relying party was never told about** |
| `syntra_jobs_pending` | Is the scheduler running at all? |
| `syntra_sessions_active` | |
| `syntra_users_total{status}` | Accounts, active and inactive |
| `syntra_accounts_locked` | A lockout spike, before the tickets arrive |
| `syntra_signing_key_expires_in_seconds` | The nearest signing key's expiry |
| `syntra_audit_events_total{action,outcome}` | Security events, by kind |
| `syntra_readiness` | The same probe `/health/ready` runs |

**Four are worth alerting on before the rest.**
`syntra_logout_deliveries_abandoned` and `syntra_webhook_deliveries_abandoned`
above zero each mean something that was supposed to leave the building did not.
`syntra_signing_key_expires_in_seconds` earns its place because key rotation is
scheduled monthly and its failure is completely silent until every token stops
verifying at once. `syntra_readiness` at 0 is the process telling you it cannot
do its job.

Two metrics are **absent rather than zero** when the answer is unknown:
`syntra_jobs_pending` where the scheduler has never run, and
`syntra_signing_key_expires_in_seconds` where no key exists. Zero would read as
"the queue is empty" and "expires now" respectively, and both would be wrong in
the direction that wakes somebody up.

### There are no per-tenant labels

Every series is installation-wide, and that is a decision rather than a gap. A
per-tenant label would let anybody who can scrape enumerate your customers,
count them and read their slugs, and the series count would grow with the
customer list — which is the ordinary way a Prometheus instance is brought down
by its own success.

An operator debugging one tenant has the audit log and the console. Both are
authenticated, and both are better at it than a time series.

The counts are assembled with one short transaction per tenant, because every
table involved is under row-level security and the application role has no
`BYPASSRLS` — see [the isolation note](../README.md#how-it-is-put-together).
They are cached for ten seconds, so a scrape every fifteen seconds pays for
them once and a misconfigured scraper cannot multiply the load on the database
it is trying to observe.

## What a session records about a person

A session row carries the address it was established from and the browser's
`User-Agent`, so a person reading **Where you are signed in** on their security
page — or an administrator reading **Sessions** on an account — can tell one
session from another. A list nobody can read is a list that gets revoked
wholesale instead of precisely, which is the outcome the columns exist to
avoid.

Three things are worth knowing about that data:

- **Nothing reads it to make a decision.** A session is never refused for
  having moved address or changed browser. Both fields are descriptive, which
  is also why it is safe that both are attacker-influenced.
- **It ages out with the session.** There is no separate retention schedule:
  the columns live and die with the row they are on, and a session's row is
  what expiry and revocation act on.
- **Revoking marks the row revoked; it does not delete it.** That is the same
  rule as everything below, applied to sessions — the record of a session
  having existed and having been ended is the evidence an offboarding actually
  happened.

Sessions predating the upgrade that added these columns have neither, and show
as unknown. They were not backfilled, because a backfill would have had to
invent the values.

## Finding machine credentials nobody uses

Every API token records when it was last used. `Sessions → the account → API
tokens` shows it, and a token that has never been used says so.

That column exists because a credential nobody can tell is unused is a
credential nobody ever revokes. The integration that was decommissioned two
years ago still has a working token, and the only way anybody finds it is by
being able to see that nothing has presented it since.

Two things to know when clearing them out:

- **Revoking the service account's role revokes every token it issued**, at
  once. Offboarding an integration is one act, not a hunt through its
  credentials.
- **A token that never expires is a choice somebody made**, not a default. The
  console suggests ninety days. Long-lived tokens are legitimate — an
  integration nobody is staffed to rotate is worse broken than long-lived — but
  they should be deliberate, and the list marks them so they can be reviewed as
  a set.

`api_token.issued`, `api_token.revoked` and `auth.token_denied` are in the
**Credentials** webhook group, so an endpoint subscribed to it learns when a
machine credential is minted without anybody wiring that up separately.

## Deactivate, never delete

There is no Delete anywhere in the directory, and that is a design decision
rather than an omission. Deleting a group revokes access from everybody in it
and takes the record of who had what with it; deleting a user destroys the
trail of what they held; deleting an org unit does both and orphans any
administrative role scoped to it. A deactivated row is still listed, still
shows its members, still says why it was deactivated and who did it — and
grants nothing. Reactivating puts back exactly what was there, because nothing
was thrown away.

**Grants nothing** is the part that has to be true in the code, not only in
the copy. A deactivated group is left out of the applications a user resolves
to and out of the group names asserted into SAML assertions and OIDC tokens;
a deactivated org unit stops granting the applications assigned to it and
stops any administrative role scoped to it from carrying authority.
Deactivation without that is a control that reports success and revokes
nothing.

Two deliberate exceptions:

- **The policy engine still sees every group, deactivated or not.** A rule
  can deny or demand a second factor, not only allow. Dropping a deactivated
  group there would stop those rules matching, so deactivating a group would
  quietly *remove* a restriction — the opposite of what the word means.
- **A deactivated unit does not cut off the units above it.** Somebody in a
  closed department is still under the division that contains it, and an
  assignment made there was never deactivated. Its children are untouched for
  the same reason, and because a cascade could not be undone by reactivating
  the parent.

Rows owned by a directory source cannot be deactivated or edited here at all.
The next sync run reads them as present and puts them back, so the console
says who owns them rather than offering a control that silently reverts.

Deactivation is also the one place policy changes are immediate rather than
waiting for a session to expire — a user's status is re-read on every
request, so deactivating an account, from the console or from a directory
sync, ends every session it holds at once. Everything else about policy
timing is in [Configure, "What this slice does not do"](configure.md#what-this-slice-does-not-do).

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on every push and pull request: the
unit and integration suite against a real PostgreSQL, OpenLDAP and Samba
domain controller, and the browser suite against a running, seeded stack.

Both bring the infrastructure up with `infra/docker-compose.yml` rather than
GitHub's `services:`. The OpenLDAP container needs its bootstrap LDIF and TLS
settings and the Samba container needs a domain provisioned; both are already
expressed in that file, and a second, drifting copy of it in YAML is how CI
starts testing something the developers do not run.

**A known flake, fixed by capping the worker count.** Too many vitest workers
against one PostgreSQL server made a handful of `resetDatabase()` hooks time
out at 30 seconds and take their files with them — `testWorkerCount()`'s old
`cores - 1` default put seven workers on an eight-core box, and that
oversubscribed the server badly enough to crash a backend roughly one run in
two. The fix is fewer workers, forced through `SYNTRA_TEST_WORKERS`: four on
an eight-core machine (0 crashes, 0 hook timeouts across three measured runs),
two in this job specifically, because GitHub's standard runner is two vCPUs
and four workers there trips a separate, hardcoded 60-second vitest RPC
heartbeat timeout, unrelated to `hookTimeout`. The arithmetic, the RPC timeout,
and why the number differs between a workstation and this runner are written
up in `docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`.

## Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm test:watch                 # the same suite, watching
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
pnpm typecheck                  # tsc -b, no emit
```

The integration tests run against a real PostgreSQL in Docker. They are not
mocked, because the properties worth testing here — row-level security, a
partial unique index, an append-only rule — only exist in the database.

**`pnpm test` creates and migrates a database of its own**, named after the
absolute path of the checkout it is running in, and never touches the one
`.env` names. Two checkouts on one machine therefore do not share truncations
or row locks — which used to produce about twenty-eight simultaneous failures
that all read `expected 500 to be 200` and sat nowhere near the code being
changed. It needs `SUPERUSER_DATABASE_URL` (already in `.env.example`) to
create the database, once. Exporting `DATABASE_URL` in the environment
overrides all of this and skips provisioning, which is the shape CI wants.

Start the browser stack with `AUTH_RATE_LIMIT_MAX` raised, since the suite
signs in far more often in a minute than a person would and the default limit
is right to refuse it.

**If another Syntra is already running, do not test through it.** A second
checkout — a worktree, a colleague's branch — answers `/health` and every
familiar route exactly as yours does, so a suite pointed at the wrong port
passes while testing code you did not write. Give the second stack ports and
a database of its own:

```bash
PORT=3100 pnpm --filter @syntra/api dev
WEB_PORT=5174 API_TARGET=http://127.0.0.1:3100 \
  pnpm --filter @syntra/web exec vite --host 127.0.0.1
E2E_BASE_URL=http://acme.localhost:5174 pnpm e2e
```

Then prove it is yours before believing a result: request a route that exists
only on your branch and check it is not a 404. `/health` proves nothing.
Vite's dev server uses `strictPort`, so it fails rather than quietly moving to
the next free port when 5173 is taken.

`pnpm test` no longer competes with a running stack for the development
database — it makes its own — but the browser suite still shares whatever
`DATABASE_URL` the stack was started with. Pointing a second stack at a
database of its own (`CREATE DATABASE syntra_e2e OWNER syntra_app`, then
`pnpm db:migrate` and `pnpm seed` against it) removes the rest of that class of
confusion.

The browser tests need the stack already running — Playwright starts nothing
itself. If they fail with `ERR_CONNECTION_REFUSED` while `curl` reaches the
same URL, Vite is listening on IPv6 only: `localhost` resolves to `::1` on
recent Node, while Chromium maps `*.localhost` to `127.0.0.1`. Start the web
server with `vite --host 127.0.0.1`.

### Provisioning integration tests need a privileged Docker host

The Active Directory target connector is tested against a real Samba domain
controller (`nowsci/samba-domain:20260801025201`, pinned). That container
**must** run with `--privileged`: Samba's provisioning sets NT ACLs on the
sysvol filesystem and exits 255 without it. This is true for a self-hosted
runner and for GitHub Actions' standard Linux runners; it is **not**
guaranteed on more locked-down or sandboxed CI.

```bash
pnpm samba:up && pnpm samba:wait   # 12-20s to first LDAPS bind
pnpm vitest run packages/connectors/src/ad packages/core/src/provision
```

Everything Provision does over LDAP is encrypted. This container refuses even
a plain simple bind (`StrongAuthRequiredError: BindSimple: Transport encryption
required`), which is stricter than the OpenLDAP container, so any fixture
shared between the two must default to LDAPS or StartTLS. The certificate is
self-signed, so tests set `rejectUnauthorized: false` deliberately.

The domain controller answers plain LDAP on **1390**, not 1389: the OpenLDAP
container in the same compose file already publishes 1389, and a fixture aimed
there gets its refusals from the wrong server.

**An OpenLDAP container started before the TLS tests existed has to be
recreated:** `docker compose -f infra/docker-compose.yml up -d openldap`. The
image's default `LDAP_TLS_VERIFY_CLIENT` is `demand`, which requires a client
certificate and drops the socket mid-handshake for a client that has none. The
failure reads `Client network socket disconnected before secure TLS connection
was established`, which looks like a network fault and is not one — the compose
file sets `try` instead, and also maps 636 so the LDAPS path is covered.

**A change to `infra/ldap/seed.ldif` needs the container REMOVED, not
restarted:** `docker compose -f infra/docker-compose.yml rm -sf openldap &&
docker compose -f infra/docker-compose.yml up -d openldap`. The image bootstraps
the custom LDIF only when it initialises an empty data directory, and the data
lives in the container's own filesystem — so `up -d` on an existing container
leaves the old tree in place and the sync tests fail against DNs that are not
there.

The fixture is split into two subtrees on purpose. `ou=Shared,dc=acme,dc=test`
is read by every test that only reads; `ou=Scenarios,dc=acme,dc=test` belongs to
`packages/core/src/sync/scenarios.test.ts`, the one file that writes to the
directory. One container serves up to eight parallel vitest workers, and before
the split a reader previewing twice around one of that file's mutations saw an
object appear or vanish and proposed a `create_user` or a `deactivate_user` for
it. A test that needs to mutate the directory gets a subtree of its own and
scopes its source to it.

### SFTP source integration test

The HR feed connector is unit-tested against a string for everything except
one property a fake cannot demonstrate: that a pinned host key which does not
match refuses the connection. That one property is checked against a real
server, skipped unless asked for:

```bash
pnpm sftp:up && pnpm sftp:wait
SFTP_INTEGRATION=1 pnpm vitest run packages/connectors/src/person/sftp
```

`pnpm db:up` already starts this container along with everything else in
`infra/docker-compose.yml`; `sftp:up` exists to bring up only this one, and
`sftp:wait` polls the port so the test does not race the container's start.
`SFTP_PORT` overrides the port the test connects to if 2222 is taken.

## Troubleshooting

**"Environment variable not found: DATABASE_URL" during `db:migrate`.**
Prisma's CLI reads `.env` from its own working directory, and pnpm runs
`migrate` with the cwd set to `packages/db`, so the root `.env` is not in
scope for it. Copy both env files: `cp .env.example .env` and
`cp packages/db/.env.example packages/db/.env`.

**"@prisma/client did not initialize yet".** Run `pnpm db:generate` before
`pnpm db:migrate`. `db:migrate` runs Prisma's CLI, which needs no generated
client, so it succeeds and the failure only shows up at the next step. The
client is not generated by `pnpm install` either — the postinstall cannot
find this workspace's schema from the root.

**A newer pnpm than the pinned version silently skips build scripts.**
pnpm is pinned by `packageManager` in `package.json`; `corepack enable`
selects it. A newer pnpm silently skips the build scripts for Prisma and
argon2, and the install looks clean until nothing can reach the database.

**`pnpm db:reset` refuses to run.** It empties whichever database
`DATABASE_URL` names, and refuses anything that is not a scratch
`syntra_test_*` database unless you name the one you mean with
`SYNTRA_ALLOW_RESET` — the development database and the lab's are both called
`syntra`, and nothing about the connection string tells them apart:
`SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed`.

**Suite hook timeouts / fsync-bound test runs.** See
[Continuous integration](#continuous-integration) above for the vitest worker
count issue (`SYNTRA_TEST_WORKERS`) and its two different correct values on a
workstation versus a two-vCPU CI runner.

## Further reading

- [Install](install.md) — development and container installs, TLS.
- [Configuration](configure.md) — every environment variable, directory
  sources, SSO and federation configuration.
- [docs/lab/README.md](lab/README.md) — the update workflow in full, and a
  complete worked lab build.
