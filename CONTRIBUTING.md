# Contributing to Syntra

Thanks for helping. Bug reports, connector requests, docs fixes and pull
requests are all welcome.

- Questions and ideas: [GitHub Discussions](https://github.com/ssan9876/syntra/discussions).
- Bugs and feature requests: [open an issue](https://github.com/ssan9876/syntra/issues/new/choose).
- Vulnerabilities: never in public. See [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requires Node 22+ and Docker. The full version, with the reasons for each
step, is [docs/install.md → Development install](docs/install.md#development-install).

```bash
corepack enable                  # selects the pnpm version pinned in package.json
pnpm install
pnpm db:up                       # PostgreSQL, postgres-test, MailDev, OpenLDAP, SFTP, Samba

cp .env.example .env             # both files, before db:migrate
cp packages/db/.env.example packages/db/.env
# Replace the two placeholder secrets in .env with the output of this, run twice:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

pnpm db:generate                 # before anything imports the Prisma client
pnpm db:migrate

SEED_ADMIN_PASSWORD='choose-a-long-one' \
SEED_USER_PASSWORD='choose-another-one' \
  pnpm seed

pnpm dev                         # API on :3000, console on :5173
```

Open http://acme.localhost:5173 and sign in as `admin`. Outgoing mail is at
http://localhost:1080.

## Tests

The suite runs against a real PostgreSQL. Use the throwaway `postgres-test`
container on port 5433, not the development database on 5432:

```bash
docker compose -f infra/docker-compose.yml up -d --wait postgres-test
```

Point `DATABASE_URL` and `SUPERUSER_DATABASE_URL` in `.env` at port 5433, then
run the suite with `DATABASE_URL` **unset** in your shell. The suite then
creates and migrates scratch databases of its own. An exported `DATABASE_URL`
skips that and tests against the database it names.

```bash
pnpm test                        # vitest: domain, API and database tests
pnpm --filter @syntra/web test   # console component tests
pnpm typecheck
pnpm lint
```

Connector tests need their systems running: `pnpm db:up` starts OpenLDAP and the
Samba domain controller (Samba needs a privileged Docker host). Run
`pnpm samba:wait` before the Active Directory tests. More detail, including
browser tests: [docs/operate.md → Tests](docs/operate.md#tests).

If you change an API route, run `pnpm openapi:generate` and commit the result.
`pnpm openapi:check` fails in CI otherwise.

## Pull requests

1. Branch from `main`.
2. Keep one change per pull request. Say what changed and why.
3. Before pushing: tests, `pnpm typecheck` and `pnpm lint` pass locally.
4. CI must be green. A red check is not merged.
5. Pull requests are squash-merged. The pull request title becomes the commit
   message, so make it describe the change.

Update the docs in `docs/` when behaviour, configuration or a console label
changes. Name every new database migration in the pull request description.

## Writing messages

Any text a person reads (console, API error, incident, run error, log line)
follows [CLAUDE.md → Writing messages](CLAUDE.md#writing-messages). In short:

1. **What happened**, as a plain statement.
2. **Where**: the target, run, person or field, by name.
3. **What to do**, only if there is a clear next step.

`Skipped: run from 15:57 is waiting for review. Apply or cancel it.` Not a
paragraph explaining why.

## Connectors

A new REST system is usually a **connector document**, not new code: JSON that
describes the system's API. See
[docs/configure.md → REST API connector documents](docs/configure.md#rest-api-connector-documents).

To ship one with Syntra:

- Add the document under `packages/connectors/src/http/documents/` and register
  it in `index.ts`.
- Add tests against a fake of the system's API, like
  `packages/connectors/src/http/mattermost.test.ts` with
  `testing/fake-mattermost.ts`. Run it through `certifyTargetConnector`.
- Say in the pull request which real system and version you tested against. A
  document nobody has run against the real API is not shipped.

Not sure a system fits? Open a connector request first.
