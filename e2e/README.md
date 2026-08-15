# End-to-end tests

These drive a real browser against a running stack, so they need the API, the
web app and a seeded database up first:

```bash
pnpm db:up
pnpm db:migrate
SEED_ADMIN_PASSWORD=... SEED_USER_PASSWORD=... pnpm seed
pnpm dev                    # api on :3000, web on :5173
pnpm e2e
```

`SEED_ADMIN_PASSWORD` and `SEED_USER_PASSWORD` must match what the database was
seeded with; the tests read them from the environment rather than hard-coding a
password into the repository.
