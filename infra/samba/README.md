# Samba Active Directory domain controller (test fixture)

Provision's Active Directory target connector is tested against a real domain
controller, not a fake. OpenLDAP cannot exercise any of the four behaviours
that make Active Directory hard, and those four are precisely what the
connector does: `sAMAccountName` uniqueness, `userAccountControl`,
`unicodePwd` over an encrypted transport, and `modifyDN`.

## The image is pinned, and the pin matters

`nowsci/samba-domain:20260801025201` — a dated, immutable tag, pull-verified
(`sha256:898cca89c3a229bcfa496fcad9cbe0e1d13b9c0ecd1716af78dd40bdadb70061`)
before it was written into the compose file.

Do not switch to `:latest`, and do not substitute another image from memory.
Five plausible-sounding names — `elswork/samba-dc`,
`svenpetersen1965/samba-ad-dc`, `phillamon/samba-dc`, `domainc/samba-ad-dc`
and `athenian/samba-dc` — return 404 from Docker Hub's API. If you need a
newer build, take another dated tag from this same repository and `docker
pull` it before writing it down.

## `--privileged` is required

Not a convenience, not a workaround. Samba's provisioning sets NT ACLs on the
sysvol filesystem. Without the flag the container gets most of the way through
provisioning and then exits 255:

```
set_nt_acl_no_snum: fset_nt_acl returned NT_STATUS_ACCESS_DENIED.
ERROR(runtime): uncaught exception - (3221225506, '{Access Denied} ...')
  ... setsysvolacl ... setntacl ... smbd.set_nt_acl
```

**This constrains where the suite can run.** It needs a Docker host that
permits privileged containers: true for a self-hosted runner and for GitHub
Actions' standard Linux runners, **not** guaranteed on more locked-down or
sandboxed CI. Say so in the CI configuration rather than letting it surface
as a mysterious CI-only failure.

## Everything is encrypted, including reads

This server refuses a plain LDAP simple bind outright — not just a password
write:

```
StrongAuthRequiredError: BindSimple: Transport encryption required. Code: 0x8
```

That is stricter than the OpenLDAP container, which serves plaintext happily.
A fixture shared between the two must default to encrypted rather than assume
plain works, even for a read-only sanity check. The certificate is
self-signed, so tests connect with `rejectUnauthorized: false` deliberately —
the same pattern the OpenLDAP tests already use.

## Startup

12.5s, 16.6s and 18.5s to first successful LDAPS bind across three cold
starts in the spike, 3 for 3, no flakiness.

Re-measured on this checkout, `docker compose rm -fsv samba` then
`pnpm samba:up && pnpm samba:wait` end to end: **9.7s and 9.7s** across two
trials. Both numbers include the two `pnpm`/`node` process spawns, and
`samba:wait` polls every 2s, so the container itself was bindable somewhere
between 7.7s and 9.7s. Budget well under a minute; `samba:wait` allows 120s,
which is deliberately generous.

Worth re-timing once on a genuinely cold Docker host: none of these trials
paid for the image pull.

## Ports

Only 636 (LDAPS, published on 1637) is used. 389 is published on **1390** for
diagnostics; nothing in the suite binds to it, because it refuses to bind.

1390 rather than 1389 because the `openldap` service in the same compose file
already publishes its 389 on 1389, and Docker refuses the second claim:

```
Bind for 0.0.0.0:1389 failed: port is already allocated
```

With both on 1389 the two containers could never be up at the same time, and
the smoke test's "refuses a plain simple bind" case would have been answered
by whichever server won the race for the port.

## Running it

```bash
pnpm samba:up && pnpm samba:wait
pnpm vitest run packages/connectors/src/ad/samba.smoke.test.ts
```

The environment contract every Active Directory integration test reads, with
its defaults:

| Variable                | Default                                          |
| ----------------------- | ------------------------------------------------ |
| `SAMBA_LDAPS_URL`       | `ldaps://localhost:1637`                          |
| `SAMBA_LDAP_URL`        | `ldap://localhost:1390` (diagnostics only)        |
| `SAMBA_BIND_DN`         | `CN=Administrator,CN=Users,DC=syntra,DC=test`     |
| `SAMBA_BIND_PASSWORD`   | `Syntra!Passw0rd`                                 |
| `SAMBA_BASE_DN`         | `DC=syntra,DC=test`                               |

They are read by `packages/connectors/src/ad/samba-connection.ts`, which is a
plain module and not an export of the smoke test — importing a test file
executes it, and the importer would silently re-run the smoke suite.

Tests inside `@syntra/connectors` import it by relative path. Tests in other
packages import it from **`@syntra/connectors/testing`**, alongside
`FakeTarget`, and not by a deep path: this package declares an `exports` map,
and an `exports` map denies every subpath it does not list, so
`@syntra/connectors/src/ad/samba-connection.js` does not resolve at all.

## The suite must pass twice against one container

`pnpm samba:up` is not part of the test run, so the same domain controller
outlives many runs. The smoke test owns `OU=Smoke,DC=syntra,DC=test` and
empties it before every test; nothing it creates lives outside that OU. A
fixture that only passes against a container nobody has touched is a fixture
that passes once.
