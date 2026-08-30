# Inbound SCIM

Status: designed, 2026-08-30
Based on `86d8f13`

A SCIM 2.0 target: Entra, Okta or Workday pushes users and groups into Syntra,
authenticating with a machine token, and what arrives is owned by the source
that pushed it.

Sub-project **C2**, the last of four. **C1 (machine tokens) is its
prerequisite** and is built — a SCIM client authenticates with exactly that
credential, which is why it came first.

## Why

Every inbound path into Syntra's directory is a **pull**. LDAP sync connects
out and reads; the HR feed fetches a file over SFTP and reads it. Both run on a
schedule, and both mean Syntra must be able to reach the system that holds the
truth.

That is the wrong shape for a modern IdP. Entra and Okta provision by
**pushing**: they hold the user list, they know the moment it changes, and they
expect to POST that change to a SCIM endpoint. An organisation whose identities
live in Entra and who wants them in Syntra currently has to stand up LDAP sync
against something else, or export a file, or click.

The absence also shapes the product's edges. `docs/README.md` lists an inbound
SCIM server nowhere, `packages/connectors/src/scim/` is an outbound *client*
for provisioning **to** other systems, and the two get confused in conversation
precisely because one exists and the other does not.

## Ruling: SCIM is a directory source

A configured SCIM client is a `DirectorySource` with `type: 'scim'`, and
everything it creates carries that source's id in `User.sourceId`.

The alternative — a separate `ScimClient` model with its own ownership pointer
— produces a cleaner row and a worse system. Every ownership rule in the
product reads `sourceId`:

- `PATCH /api/admin/users/:id` already answers **409 `source-owned`** with
  "this account is read from a directory source, and the next sync run would
  overwrite the change." A SCIM-owned account inherits that sentence for free,
  and it is true for SCIM in exactly the way it is true for LDAP.
- An LDAP-owned account cannot be taken over by SCIM, and a SCIM-owned account
  cannot be taken over by LDAP, because both check the same field.
- The console already shows which source owns an account.

A second ownership pointer would mean a second case in each of those, and each
second case is a place SCIM can be forgotten — which is how a source-owned
record gets quietly overwritten by the writer nobody remembered to check for.

**The cost, stated plainly.** A `DirectorySource` carries `schedule`,
`config`, `secretName`, `deactivationThresholdPercent` and three write-back
flags, and a SCIM source has no use for any of them. They are set to
inert values, the console hides them for this type, and this paragraph is why.
That is a real wart. It is smaller than the wart of two ownership models.

## Ruling: DELETE deactivates

SCIM's `DELETE /Users/{id}` means "remove this user". Syntra's most-stated rule
is that there is no Delete anywhere in the directory — deactivation "revokes
real access, **grants nothing**, and keeps the trail of who had what and why it
changed."

The two are reconciled the only honest way: **`DELETE` deactivates, and the
`ServiceProviderConfig` and the documentation say so.** The client gets its
`204`, the account stops working immediately, and the record survives.

The alternative — implementing a real delete for SCIM only — would give an
integration a capability the product deliberately denies its own
administrators, reachable by whoever holds a machine token. `active: false` on
a `PUT` or `PATCH` deactivates identically, which is the operation Entra and
Okta actually send for offboarding.

## Ruling: SCIM speaks its own error language

Every other route in this API answers RFC 9457 `application/problem+json`. SCIM
clients parse `urn:ietf:params:scim:api:messages:2.0:Error` and nothing else.

The SCIM routes therefore answer in SCIM's shape, and this is a **local**
exception with a boundary: it applies under `/scim/v2` and nowhere else,
implemented as one error serialiser on that plugin rather than by weakening the
shared one. A client that cannot parse the error cannot tell a conflict from a
crash, and an integrator debugging a provisioning failure is reading their
IdP's log, not ours.

## The surface

Mounted at `/scim/v2`, and reachable **only** by a machine token — a cookie
session is refused. A browser has no business here, and every SCIM client in
the world sends a bearer token.

The token needs `directory.write`. The intersection rule from C1 applies, so a
token scoped to `directory.read` can GET and nothing more, which is a genuinely
useful way to let an IdP verify a connection before it is trusted to change
anything.

| Route | |
|---|---|
| `GET /Users`, `GET /Users/{id}` | list and read |
| `POST /Users` | create |
| `PUT /Users/{id}` | replace |
| `PATCH /Users/{id}` | modify |
| `DELETE /Users/{id}` | **deactivate** |
| `GET /Groups`, `GET /Groups/{id}` | |
| `POST /Groups`, `PUT`, `PATCH`, `DELETE` | as above |
| `GET /ServiceProviderConfig` | what this server supports |
| `GET /ResourceTypes`, `GET /Schemas` | discovery |

The three discovery endpoints are not optional politeness. Entra reads
`ServiceProviderConfig` before it will provision, and a target that 404s there
fails setup with a message naming nothing useful.

### Mapping

| SCIM | Syntra |
|---|---|
| `userName` | `User.login` |
| `externalId` | `User.sourceAnchor` |
| `emails[primary].value` | `User.email` |
| `displayName`, or given + family | `User.displayName` |
| `active` | `User.status` |
| `id` | `User.id` |

`externalId` into `sourceAnchor` is the correlation key, and it is the same
column LDAP sync uses for the same purpose — which is what lets an
administrator see, on one screen, which source anchored an account and to what.

**A Person is created and linked only when the payload carries a family name
and a given name.** An IdP frequently knows a login, an address and nothing
else, and inventing a Person from that fills the register with half-records no
HR feed will ever reconcile against. When the names are there, the Person is
real and worth having; when they are not, the account stands alone, which is
what a service account does anyway.

### Filtering

`userName eq "…"` and `externalId eq "…"`, on `/Users`; `displayName eq "…"` on
`/Groups`. Nothing else — an unsupported filter is a
`400 invalidFilter`, naming what is supported.

That is not a shortcut. It is what Entra and Okta actually send: their
provisioning flows correlate by exactly these before deciding to POST or PATCH.
The rest of the filter grammar — `and`, `or`, `not`, complex attribute paths,
`co`/`sw`/`pr` — is a parser with its own injection surface, written to serve
no client this product will meet.

### PATCH

RFC 7644's operations, on the paths IdPs send: `replace` of `active`, of
`userName`, of an email; `add` and `remove` of `members` on a group. A path
this server does not implement is a `400`, not a silent success — a PATCH that
reports 200 and changes nothing is the failure mode that takes days to find,
because the IdP believes the change landed.

### Pagination

`startIndex` and `count`, **1-based**, as the RFC specifies and as everybody
gets wrong once. `count` is capped, and the cap is in
`ServiceProviderConfig` so a client can read it rather than discover it.

## What a SCIM write may not do

The token's permissions bound it, and two things sit outside them entirely:

- **It cannot take over an account another source owns.** A `POST` whose
  `userName` matches an LDAP-owned account is a `409 uniqueness`, not a
  takeover. The account belongs to the system that anchored it.
- **It cannot set a password.** SCIM's `password` attribute is accepted and
  **ignored**, and `ServiceProviderConfig` does not advertise it. Syntra's
  password rules — ageing, the tenant floor, write-back — all live in
  `authorize()` and the password services, and a provisioning protocol is not
  the place to route around them.

## Audit

Every write records `scim.user_created`, `scim.user_updated`,
`scim.user_deactivated`, `scim.group_created`, `scim.group_updated`,
`scim.member_added` or `scim.member_removed`, with the actor being the service
account the token acts as.

They join the **Configuration changes** webhook group from cluster B: an IdP
that starts creating accounts is a configuration change somebody should be able
to watch.

## Testing

Integration against the real database, driving the HTTP surface as a client
would.

- **The round trip a client performs at setup**: read `ServiceProviderConfig`,
  filter `/Users` by `userName`, get nothing, POST, get the same resource back
  at the `Location` it returned.
- `POST` twice with one `userName` is a `409` with SCIM's error body and
  `scimType: "uniqueness"` — not a 500, and not a second account.
- **`DELETE` deactivates and does not delete.** The row is still there, its
  status is inactive, and the account cannot sign in.
- `PATCH replace active:false` does the same thing, because that is what Entra
  sends.
- A `POST` colliding with an **LDAP-owned** account is refused, and the LDAP
  account is untouched.
- A user created by SCIM refuses a hand edit through the admin API with
  `409 source-owned` — the existing rule, asserted for the new writer.
- **`password` in a payload is ignored**, and the account has no usable
  password afterwards.
- An unsupported filter is a `400 invalidFilter` naming what is supported; a
  PATCH on an unimplemented path is a `400` and changes nothing.
- Pagination is 1-based: `startIndex=1` returns the first resource, and
  `startIndex=0` is refused rather than silently treated as 1.
- **Authentication**: no token is a `401` in SCIM's shape; a token scoped
  `directory.read` may GET and not POST; a cookie session is refused.
- RLS: a token from one tenant cannot read another's users through SCIM.

## Documentation

`configure.md` gains setting up a SCIM source: creating the source, issuing the
token, the base URL, and what to expect — that DELETE deactivates, that
passwords are ignored, that a SCIM-owned account is not editable by hand, and
which filters are supported.

The README's module table gains it, and the Directory Sync row should say that
inbound SCIM is a **push** alternative to the pull connectors rather than a
replacement for them.

## Not in this document

**`/Me`.** It answers "who is this token", and a machine token acts as a
service account rather than as a person — the answer would be a service account
nobody is interested in.

**Bulk.** No mainstream IdP provisioning flow uses it, and it is a second
request-shaping surface with its own failure modes.

**ETags and versioning.** Optional in the RFC and unused by the clients this
targets. `ServiceProviderConfig` says so rather than leaving a client to find
out.

**Outbound SCIM.** Already built, in `packages/connectors/src/scim/`, and a
different feature that happens to share a protocol name.
