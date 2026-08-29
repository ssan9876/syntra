# End-to-end tests

These drive a real browser against a running stack, so they need the API, the
web app and a seeded database up first:

```bash
pnpm db:up
pnpm db:migrate
SYNTRA_ALLOW_RESET=syntra pnpm db:reset
SEED_ADMIN_PASSWORD=... SEED_USER_PASSWORD=... pnpm seed
AUTH_RATE_LIMIT_MAX=200 pnpm dev    # api on :3000, web on :5173
pnpm e2e
```

Several things will bite otherwise:

**Run `SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed` after `pnpm test`.**
The integration tests truncate every table between cases and leave the last
one's fixtures behind — usually a tenant named `acme` with an `admin` user in
it, which is enough to fool the seed into reporting the tenant as already
seeded and doing nothing.

`db:reset` refuses to empty anything that is not a scratch `syntra_test_*`
database unless you name the database you mean, and it prints the tenant, user
and audit counts it is about to destroy. That is not ceremony for its own sake:
the development database and the lab database are both called `syntra`, so the
connection string cannot tell them apart, and the guard this replaced tested
`NODE_ENV=production` — which the lab sets nowhere.

**Raise `AUTH_RATE_LIMIT_MAX`.** The suite signs in far more often in a minute
than a person ever would, and the default limit of ten password attempts per
minute is doing its job when it refuses. Raise it for the run rather than
removing it from the product.

**The MFA spec runs `describe.serial` and cleans up after itself.** It signs in
as the administrator, saves a rule requiring a second factor for everyone,
drives a user through forced enrolment and a step-up, and then removes the rule
again. The removal is not tidiness: a rule left in force sends every later
sign-in in the file — the administrator's included — to a step-up screen, and
the failure surfaces in a test that has nothing to do with it.

It goes through `withRule`, which puts the removal in a `finally`. It used to
be the last statement of the test, so any failure before it left the rule
standing and one genuine failure reported as eleven, none of them anywhere near
their cause. `withRule` only swallows a cleanup error when the body has already
failed — a session the failure killed cannot remove anything, and a throw from
the `finally` would replace the error that matters.

The administrator does that removal from a session established *before* the
rule existed, and the user is driven through a second browser context so the
administrator's cookie survives. A policy change does not reach a live session,
which is exactly what makes the cleanup possible; signing the user in on the
administrator's own page would throw that session away and leave nobody able to
take the rule off again.

**`SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed` is required before every run of the MFA spec,
not merely advisable.** The factors enrolled during the run are not cleaned up
— the account detail page can remove one, over the same
`DELETE /api/admin/users/:id/factors/:type` endpoint, but nothing in the spec
calls it — so a second run finds `jdoe` already holding one and the
forced-enrolment test fails at its first assertion.

**One test waits up to 31 seconds.** Confirming a TOTP enrolment sets the
replay watermark to the step it happened in, so the next code is refused until
that step ends. The integration tests backdate the enrolment; a browser cannot,
so it waits. That test raises its own timeout to 180 seconds. The
administrator's step-up test answers with recovery codes instead, which the
watermark does not apply to, so it does not wait at all.

**`sso.spec.ts` needs the seed's `CRM` tile and a SAML signing key.** The seed
creates both: a service-provider application pointed at `sp.example.test`, and
the tenant's SAML signing key — the latter only if `MASTER_KEY` is set to 32
base64 bytes in the environment the seed runs in, and it says so loudly when it
is not. The same `MASTER_KEY` must then be given to the API, because the
private half is wrapped with it.

`sp.example.test` deliberately does not resolve. The spec fulfils the POST with
a Playwright route handler registered on the *context* rather than on the page:
a launch opens the application in a tab of its own, and a handler on the page
that did the clicking never sees the new tab's request.

**One `sso.spec.ts` case adds and removes a policy rule through the API.** The
console writes tenant-wide rules only, and a tenant-wide `require_mfa` would
interrupt the sign-in rather than the launch — a different claim, and one the
MFA spec already makes. The rule is removed in a `finally`, for the same reason
the MFA spec removes its own.

**Running a second stack beside the first.** `WEB_PORT`, `API_TARGET` and
`E2E_BASE_URL` exist so a worktree can run its own API, its own Vite and its
own database without either answering for the other. Point `PUBLIC_URL` at the
Vite origin, not the API's: the protocol launch address is derived from it, and
`/login?next=...` and `/mfa?...&next=...` are relative to whichever origin the
browser is on.

`SEED_ADMIN_PASSWORD` and `SEED_USER_PASSWORD` must match what the database was
seeded with; the tests read them from the environment rather than hard-coding a
password into the repository. Seeding a second stack with passwords of its own
is also the only reliable way to prove a browser run reached *your* build:
a route that exists in both checkouts answers identically, and a password that
only one of them knows does not.
