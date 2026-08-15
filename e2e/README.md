# End-to-end tests

These drive a real browser against a running stack, so they need the API, the
web app and a seeded database up first:

```bash
pnpm db:up
pnpm db:migrate
SEED_ADMIN_PASSWORD=... SEED_USER_PASSWORD=... pnpm seed
AUTH_RATE_LIMIT_MAX=200 pnpm dev    # api on :3000, web on :5173
pnpm e2e
```

Several things will bite otherwise:

**Run `pnpm db:reset && pnpm seed` after `pnpm test`.** The integration tests
truncate every table between cases and leave the last one's fixtures behind —
usually a tenant named `acme` with an `admin` user in it, which is enough to
fool the seed into reporting the tenant as already seeded and doing nothing.

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

The administrator does that removal from a session established *before* the
rule existed, and the user is driven through a second browser context so the
administrator's cookie survives. A policy change does not reach a live session,
which is exactly what makes the cleanup possible; signing the user in on the
administrator's own page would throw that session away and leave nobody able to
take the rule off again.

**`pnpm db:reset && pnpm seed` is required before every run of the MFA spec,
not merely advisable.** The factors enrolled during the run are not cleaned up
— this slice ships no console screen for clearing somebody's factor, only the
`DELETE /api/admin/users/:id/factors/:type` endpoint — so a second run finds
`jdoe` already holding one and the forced-enrolment test fails at its first
assertion.

**One test waits up to 31 seconds.** Confirming a TOTP enrolment sets the
replay watermark to the step it happened in, so the next code is refused until
that step ends. The integration tests backdate the enrolment; a browser cannot,
so it waits. That test raises its own timeout to 180 seconds. The
administrator's step-up test answers with recovery codes instead, which the
watermark does not apply to, so it does not wait at all.

`SEED_ADMIN_PASSWORD` and `SEED_USER_PASSWORD` must match what the database was
seeded with; the tests read them from the environment rather than hard-coding a
password into the repository.
