# Search and paging for the identity lists

**Status:** approved, not yet implemented
**Scope:** People, Accounts and Groups in the admin console

## The problem

Every identity list in the console loads its entire collection and renders all
of it. `PeopleTab` fetches `/api/admin/persons`; the route calls
`listPersons(tx)`, which takes no arguments at all and returns every person in
the tenant ordered by name (`packages/core/src/identity/person-service.ts:40`).
`listUsers(tx, { status? })` accepts one filter and no bounds
(`packages/core/src/directory/user-service.ts:66`). `listGroups(tx)` takes
nothing (`apps/api/src/routes/admin/groups.ts:88`).

No admin page has a search input. There is no way to answer "where is Brady
Archer" except to scroll, and no way to answer "how many contractors are
there" at all.

This is invisible at lab scale and fatal at customer scale. A tenant with five
thousand people ships five thousand rows on every visit to the tab, renders
them all, and offers no way to find one. The directory is the screen an
administrator opens most, and it is the one screen that does not scale.

Paging is not new ground here: `readAuditEvents` already does keyset paging on
`sequence` (`packages/core/src/audit/audit-service.ts:271`). That precedent is
deliberately **not** followed for these three lists, for the reasons in
"Paging model" below.

## Scope

In scope: People, Accounts, Groups — search, filter, paging, and the stat
cards those pages carry.

Out of scope, deliberately:

- **Run histories** (sync, provision, person-import). They grow without bound
  too, but they are filtered by status and date rather than searched by name,
  which is a different control set. They keep their current `take:` caps until
  someone designs that.
- **The audit log's missing UI.** `AuditTab` requests `?limit=100` once and
  never pages, so it silently shows only the newest hundred events. That is
  arguably a correctness problem in an audit log, and it is its own change.
- **Trigram or other search indexes.** See "Indexes and scale".
- **Sorting by arbitrary columns.** Each list keeps the order it has.

## Paging model: offset with a total

Offset paging (`page`, `pageSize`) returning a filtered `total`, rather than
the keyset paging the audit log uses.

The two data shapes differ in what a reader wants. An audit log is append-only,
read newest-first, and streamed backwards: keyset is right because it never
skips or repeats a row when new events arrive mid-read, and nobody asks how
many audit events there have ever been. A directory is browsed and counted. An
administrator wants "1-50 of 4,312", wants page 7, and wants the number itself
— the count is not a side effect of paging here, it is one of the answers the
screen exists to give.

The cost is a `COUNT` per query, which at directory scale on an indexed,
tenant-scoped table is immaterial. The risk is rows shifting between pages
while somebody else edits. That risk is real and accepted: these lists change
slowly, and the alternative costs the total.

## Core: three explicit services

Each service grows the same option bag and the same return shape. Three
near-identical functions, not one generic helper: a `listQuery(model, fields)`
abstraction would have to be understood before any single list could be read,
and Prisma's types resist generic model access hard enough that it ends in
casts this codebase only writes with a paragraph of justification attached.
The duplication is three small functions whose searchable field set stays
legible at the point somebody changes it.

```ts
export interface ListOptions {
  search?: string | undefined;
  status?: string | undefined;
  page?: number | undefined;      // 1-based
  pageSize?: number | undefined;  // default 50
}

export interface ListPage<T> {
  rows: T[];
  total: number;   // matching the filters, NOT the table
  page: number;
  pageSize: number;
}
```

`listPersons`, `listUsers` and `listGroups` each take `(tx, opts)` and return a
`ListPage`. Both queries — `findMany` and `count` — run on the same
`TenantClient` inside the caller's transaction, so the rows and the total are
read under one tenant scope and one snapshot. A total that disagreed with its
own page would be worse than no total.

`total` counts what matches the filters, not what exists. "1-50 of 12" while a
search is active is the useful number; the table's size is not.

Searchable fields, named per list rather than derived:

| List | Search matches | Filters |
|---|---|---|
| People | `givenName`, `familyName`, `externalId`, `businessEmail` | `status` |
| Accounts | `login`, `displayName`, `email` | `status` |
| Groups | `name`, `description` | none |

Search is an `OR` of `contains` with `mode: 'insensitive'` over that list's
fields. `personalEmail` is deliberately absent: it is a home address
held for contacting a leaver, and making it matchable turns an admin search box
into a way to search staff by private contact details. `businessEmail` is
corporate and stays. Empty or whitespace-only search is treated as absent, so `?q=` does not
mean "match nothing".

`listUsers`'s existing `{ status }` option keeps working: it becomes one field
of `ListOptions` rather than a separate signature, so its current callers are
unaffected.

## API: one shared query schema

A single zod schema parses the query string for all three routes, so they
cannot drift:

| Param | Rule |
|---|---|
| `q` | trimmed; empty becomes undefined |
| `status` | validated per route against that list's statuses; rejected by Groups, which has none |
| `page` | integer >= 1, default 1 |
| `pageSize` | integer 1..200, default 50 |

`pageSize` is bounded at 200, and the bound is the point: without it,
`?pageSize=1000000` reinstates from outside exactly the unbounded query this
change exists to remove. A larger value is **rejected, not clamped** — a
request that asked for a thousand and quietly got fifty is a client bug nobody
ever sees.

Groups has no status filter, so `status` on that route is rejected rather than
ignored, for the same reason.

Responses keep their existing collection key and gain the envelope:

```json
{ "persons": [], "total": 4312, "page": 1, "pageSize": 50 }
```

Additive, so any existing consumer reading `body.persons` keeps working.

`/users` computes `locked` for the rows it returns
(`apps/api/src/routes/admin/users.ts:133`); that computation now runs over one
page rather than the whole table, which is strictly less work.

## Console

Two new components in `@syntra/ui`, which today has `Table`, `Empty`, `Field`
and `Select` but nothing for driving a list:

- **`ListControls`** — a search input (debounced 250ms) and, where the list
  has one, a status `Select`.
- **`Pager`** — "1-50 of 4,312", previous/next, and a page indicator. Disabled
  rather than hidden at the ends, so the control does not move under the
  cursor.

**State lives in the URL** (`?q=&status=&page=`), not in component state. A
search worth doing is worth sending to a colleague, the back button should undo
a filter rather than leave the screen, and a page that reloads mid-triage
should come back where it was. `useSearchParams` already ships with the router
in use.

Changing the search or the filter resets to page 1. Not doing so strands
somebody on page 7 of a three-page result, looking at an empty table that reads
as broken.

Empty states distinguish two situations, because they need different actions:

- **Nothing here yet** — the existing empty state, offering the create action.
- **Nothing matches `arch`** — offers to clear the search, and names what was
  searched so a typo is visible.

## The stat cards

`UsersPage` derives `activePeople` and `lockedCount` by filtering the full
arrays it fetched (`apps/web/src/pages/admin/UsersPage.tsx:69-71`). Paging
breaks those numbers silently: they would start describing the current page
while still looking like totals, which is worse than showing nothing.

They move to `GET /api/admin/directory/summary`, one request returning:

```json
{ "people":   { "total": 0, "active": 0 },
  "accounts": { "total": 0, "active": 0, "locked": 0 } }
```

One endpoint rather than two, because one page asks all these questions at
once. `locked` stays server-side: it is derived from lockout state rather than
a `User` column, so it cannot be answered by a filter on the list query, and
pretending otherwise would put a join in the wrong layer.

This also removes two full-collection fetches from a page that already fetches
both lists again through its tabs.

## Indexes and scale

None added, deliberately.

`ILIKE '%arch%'` over a tenant-scoped table is a sequential scan of that
tenant's rows. At a few thousand people that is sub-millisecond, and the `COUNT`
reads the same rows. A trigram GIN index would help at a scale no tenant here
is near, and it is not free to adopt: `pg_trgm` is not installed (the database
has only `plpgsql`), and migrations run as the application role, which is
`NOSUPERUSER` by design — so adopting it means either a privileged step outside
the migration path or a change to who runs migrations. Neither is worth doing
before a tenant is big enough to measure the difference.

What this design does provide is the place to put it: the search predicate is
built in one function per list, so an index and a changed predicate land in
three known spots.

## Testing

**Core**, per list: search matches each named field; search is
case-insensitive; whitespace-only search behaves as no search; the status
filter applies; `total` reflects the filters rather than the table size; page
boundaries return the right slice; a page past the end returns no rows and a
truthful total; `pageSize` is honoured.

**API**: the shared schema rejects `page=0`, negative pages and non-integers;
`pageSize` above 200 is rejected rather than silently clamped, and Groups
rejects `status`; the
envelope is present; a consumer reading only the collection key still works.

**Console**: typing debounces to one request; the URL round-trips (`?q=arch`
renders with the box populated, and back undoes it); changing the search resets
to page 1; the right empty state renders for each case; the pager disables at
both ends.

**E2E**: one spec that pages through people with `?pageSize=2` rather than
creating fifty-one of them, searches for one, follows the link to their detail
page, and comes back to the same page of results.

## What could go wrong

- **A tenant with fewer rows than a page** sees a pager reading "1-12 of 12"
  with both buttons disabled. Acceptable; hiding the control would take the
  count with it.
- **Somebody deletes a row while you are on page 3.** Rows shift by one.
  Accepted with offset paging, and the reason the audit log does not use it.
- **A search that matches nothing** must not read as a broken table. Covered by
  the second empty state.
- **`pageSize` cap bypass** by repeated requests is not a threat this cap
  addresses. The cap bounds one query's cost; it does not ration access.
