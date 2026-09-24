# Connector certification, capability enforcement and rollout

Syntra writes to a target only what the exact adapter release running it was
certified to write, what that target's configuration advertises, and only
while the release is not past its deprecation date. This page describes the
three controls that enforce that and the console and API to operate them.

Code: `packages/connectors/src/metadata.ts` (catalog and resolution),
`packages/core/src/provision/adapter-rollout.ts` (enforcement and rollout
services). Certification runner:
`packages/connectors/src/testing/target-connector-certification.ts`.

## The lifecycle catalog

Every connector type has one or more adapter **releases**. Each release
records its version, connector API version, channel (`stable` or `canary`),
support state, rollout state, deprecation date, and its certification:
status (`passed`, `partial`, `failed`, `not-run`), evidence, and the list of
**capabilities** (connector writes) it was certified for:
`create_container`, `create_account`, `update_account`, `rename_account`,
`enable_account`, `disable_account`, `archive_account`, `grant_entitlement`,
`revoke_entitlement`.

A certification speaks only for its own version. A capability missing from a
release's list is uncertified for that release, whatever an earlier release
was certified for. A `failed` or `not-run` certification certifies nothing.

Shipped releases (all 1.0.0, stable):

| Type | Certification | Certified writes |
| --- | --- | --- |
| `activeDirectory` | passed | everything, including `create_container` |
| `scim2` | passed | all account and entitlement writes; no containers |
| `httpJson` | passed | all account and entitlement writes; no containers |
| `entraId` | partial | all account and entitlement writes; no containers |

A catalog release is runnable only when this build implements it
(`implementedAdapterVersions` in `registry.ts`); a test enforces that the two
agree.

## Capability enforcement

Every connector action a run plans is checked against both conditions:

1. the target's effective release is certified for the write, and
2. the target's configuration advertises it (`capabilitiesForTarget`: for
   `httpJson` this reads the document, so a document without `account.create`
   cannot create).

An action that fails either is **refused**, not dropped: it is written into
the plan with status `refused` and an operator-readable reason (for example
`refused: this target's configuration does not advertise the ability to grant
entitlements`). The run records `adapterVersion`, `capabilityRefusedCount`
and a one-line `capabilityRefusal` summary, and the run page shows a banner
listing the reasons. Refused actions are excluded from the guard's
thresholds, never attempted, and leave the run `partially_applied` rather than
`applied`. A Govern revocation order behind a revocation refused at plan time
stays open, so a later run can execute it once the capability exists.

The check is repeated at apply time. If the configuration stopped advertising
a capability after the preview, the affected actions are refused then and
recorded on the run the same way. Syntra-only actions (deactivating or
reactivating a Syntra login) touch no adapter and are never refused. The
manual account move is an `update_account` and is subject to the same checks.

Refusal is per action, not per run: one uncertified capability does not hold
up a leaver's disable on the same target.

Note: the `scim2` capability table advertises entitlement management,
matching what the adapter implements (group membership by PATCH, read back
from the group) and what its certification covers. Before enforcement the
flag was display-only and said `false`; enforcing that stale value refused
every SCIM grant, so it was corrected rather than worked around.

## Rollout: canary, pin and rollback

Each target has an adapter selection: a **channel** (`stable`, the default,
runs the newest stable release; `canary` runs the newest canary release and
falls back to stable when none is published) and an optional exact **pin**.
Only a release with passing or partial certification that is not
`unavailable`/`disabled` can be selected.

When a selection changes the effective release, the release being left is
recorded as the target's **rollback point** (if it was certified). A rollback
pins the target to that release on the stable channel immediately, so the
next published canary cannot silently undo it.

Neither a selection nor a rollback changes stored intent. Configuration,
account profile, rules, placements and accounts are untouched; only which
certified code executes them changes. Each run records the release it was
planned for, and an apply refuses (`409 adapter-version-changed`) when the
target has moved to a different release since the preview. Preview again.

## Deprecation

A release with a deprecation date, or support state `deprecated`, and any
release that is not fully certified, produces a **readiness warning** on the
target's adapter panel, the provisioning setup checklist and
`GET /api/admin/targets/:id/readiness` (`adapterWarnings`).

From the deprecation date (a UTC day) the release **writes nothing**: a new
preview is blocked outright (it cannot be confirmed away), and an apply is
refused with `409 adapter-writes-blocked`. An administrator can record a
**deprecation override**: a reason of at least 10 characters and an expiry at
most 30 days away, bound to the exact release the target runs. The database
enforces the 30-day bound and the completeness of the record. Writes resume
while the override is active and stop again when it expires, with no sweep
required. Moving the target to a supported release is the permanent fix.

## API

All under `/api/admin`. Reads need `provision.read`; changes need
`provision.manage` and a reason of at least 10 characters.

| Method and path | Purpose |
| --- | --- |
| `GET /targets/:id/adapter` | Selection, effective release and why, all releases, per-capability certification and refusal, warnings, whether writes are blocked, and the override |
| `PUT /targets/:id/adapter` | `{ channel, version \| null, reason }` — change channel or pin |
| `POST /targets/:id/adapter/rollback` | `{ reason }` — return to the rollback point |
| `POST /targets/:id/adapter/deprecation-override` | `{ reason, expiresAt }` — time-bounded override |
| `POST /targets/:id/adapter/deprecation-override/clear` | `{ reason }` — end the override early |

Each change writes an audit event in the **Configuration changes** webhook
group: `provision.target.adapter.select`, `provision.target.adapter.rollback`,
`provision.target.adapter.deprecation_override.grant` and
`provision.target.adapter.deprecation_override.clear`.

The console exposes the same controls in the **Adapter release** panel on the
target page.

## Publishing a new adapter release

1. Implement it beside the current one and register it in
   `IMPLEMENTATIONS` (`registry.ts`) under its version.
2. Run the shared certification runner and the adapter's fixture suites
   against it, and add a catalog release on the `canary` channel whose
   capability list names only what passed.
3. Move selected targets to the canary channel, preview, and watch their runs
   and health history.
4. Promote by publishing it on the `stable` channel. Roll back any target that
   misbehaves ([runbook, Procedure G](../runbooks/target-rollback.md#procedure-g-a-canary-adapter-release-that-misbehaves)).
5. Deprecate the old release with a date; targets still on it get a warning
   until then and stop writing after it.
