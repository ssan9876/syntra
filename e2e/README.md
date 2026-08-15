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

Two things will bite otherwise:

**Run `pnpm db:reset && pnpm seed` after `pnpm test`.** The integration tests
truncate every table between cases and leave the last one's fixtures behind —
usually a tenant named `acme` with an `admin` user in it, which is enough to
fool the seed into reporting the tenant as already seeded and doing nothing.

**Raise `AUTH_RATE_LIMIT_MAX`.** The suite signs in far more often in a minute
than a person ever would, and the default limit of ten password attempts per
minute is doing its job when it refuses. Raise it for the run rather than
removing it from the product.

`SEED_ADMIN_PASSWORD` and `SEED_USER_PASSWORD` must match what the database was
seeded with; the tests read them from the environment rather than hard-coding a
password into the repository.
