# Onboarding and Directory Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the console one coherent "Add someone" journey that creates a person, their contract and optionally their login in one pass, and give administrators a deliberate way to delete a user or an org unit that propagates to Active Directory.

**Architecture:** Two independent parts. Part 1 is UI-only, layered on endpoints that already exist and are already tested — no schema change, no domain change. Part 2 adds deletion on the `SourceWriteback` path (administrator-initiated, one object at a time), deliberately **not** as a `ProvisionActionType`, so the provisioning planner still cannot propose a delete. Part 1 ships working software on its own; stopping after it is a valid outcome.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, React + React Router, Tailwind, Zod, Vitest, React Testing Library, ldapts.

**Spec:** `docs/superpowers/specs/2026-08-25-onboarding-and-deletion-design.md`

## Global Constraints

- Worktree `D:/Syntra/.claude/worktrees/onboarding-and-deletion`, branch `worktree-onboarding-and-deletion`, based on `f68b1b8`. Never run commands against `D:/Syntra`.
- Run `pnpm db:generate` before the first test run in a fresh checkout, or every file importing `@syntra/db` fails to load with `Cannot find module '.prisma/client/default'`.
- TDD: write the failing test, watch it fail for the right reason, then implement. Never write implementation first.
- New migrations must sort **above** `MIGRATION_NAME_FLOOR = '20260830000000'` and above the highest existing name, `20260905000000_deployment_manage_backfill`. This plan uses `20260906000000_writeback_delete`. Add it to `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`.
- Branch `remediation-4-auth-api-console` also adds a migration (`20260903000000_builtin_role_permissions`) and edits `migration-order.ts`, `packages/contracts/src/index.ts`, `packages/core/src/index.ts`. Expect a conflict in those four at merge; resolve by keeping both additions.
- `ProvisionActionType` in `packages/connectors/src/types.ts` **must not** gain a delete member. The no-delete invariant documented at `types.ts:43` is deliberate and stays.
- Deletion writes the directory **first**, outside any transaction, and touches Syntra only if that succeeded. Mirrors `packages/core/src/directory/directory-writeback.ts:88`.
- Audit every mutation, including failed ones, via `recordEvent`.
- Prose in this codebase explains *why*, not *what*. Match the surrounding comment style.

---

# Part 1 — Onboarding

Touches no file that any other active branch touches.

## Task 1: Add-contract form on the person page

The endpoint `POST /persons/:id/contracts` exists and is tested; nothing calls it. `PersonDetailPage.tsx:67` renders a contracts table whose empty state offers no control.

**Files:**
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx`
- Test: `apps/web/src/pages/admin/PersonDetailPage.test.tsx`

**Interfaces:**
- Consumes: `RecordPanel` from `./RecordPanel.js`; `useApiResource` from `./hooks.js`.
- Produces: nothing other tasks depend on.

`PersonDetailPage` currently uses `useApiResource` without a `reload`. Destructure `reload` from it so the panel can refresh the page after a create.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/pages/admin/PersonDetailPage.test.tsx`:

```tsx
it('offers a contract form and posts what was typed', async () => {
  const user = userEvent.setup();
  const posted: unknown[] = [];
  server.use(
    http.get('/api/admin/persons/p1', () =>
      HttpResponse.json({
        id: 'p1',
        givenName: 'Maya',
        familyName: 'Okafor',
        businessEmail: null,
        externalId: null,
        status: 'active',
        contracts: [],
        users: [],
      }),
    ),
    http.post('/api/admin/persons/p1/contracts', async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json({ id: 'c1' }, { status: 201 });
    }),
  );

  renderPersonDetail('p1');

  await user.click(await screen.findByRole('button', { name: 'Add contract' }));
  await user.type(screen.getByLabelText('Job title'), 'Staff Nurse');
  await user.type(screen.getByLabelText('Department'), 'Nursing');
  await user.type(screen.getByLabelText('Start date'), '2026-09-01');
  await user.click(screen.getByRole('button', { name: 'Add contract' }));

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toMatchObject({
    sequence: 1,
    isPrimary: true,
    startDate: '2026-09-01',
    jobTitle: 'Staff Nurse',
    department: 'Nursing',
  });
});
```

Follow the existing file's helper for `renderPersonDetail` and its MSW `server` setup; if the file has no such helper, copy the render/route wrapper from `PersonAccessPage.test.tsx`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx -t 'offers a contract form'`
Expected: FAIL — no button named "Add contract".

- [ ] **Step 3: Implement**

In `PersonDetailPage.tsx`, change the resource line to keep `reload`:

```tsx
const { data, error, loading, reload } = useApiResource<PersonDetail>(
  `/api/admin/persons/${id}`,
);
```

Inside the Contracts `Panel`, below the table/empty state, add:

```tsx
{/* The endpoint has existed since Identity and nothing called it, so a
    person's contracts could only ever arrive by CSV import or a sync.
    A contract is what the provisioning planner reads to decide anybody
    should have an account at all, which made this the gap that stopped
    hand-created people provisioning anything. */}
<div className="p-4">
  <RecordPanel
    title="Add contract"
    submitLabel="Add contract"
    path={`/api/admin/persons/${data.id}/contracts`}
    onCreated={reload}
    build={(v) => ({
      // One past the highest, so a second contract does not collide with
      // the first. The API answers 409 on a duplicate sequence.
      sequence: Math.max(0, ...data.contracts.map((c) => c.sequence)) + 1,
      // Primary only when nothing else is. The partial unique index allows
      // exactly one, and the API answers 409 rather than 500 for a second.
      isPrimary: !data.contracts.some((c) => c.isPrimary),
      startDate: v.startDate ?? '',
      ...(v.endDate ? { endDate: v.endDate } : {}),
      ...(v.jobTitle ? { jobTitle: v.jobTitle } : {}),
      ...(v.department ? { department: v.department } : {}),
      ...(v.costCentre ? { costCentre: v.costCentre } : {}),
      ...(v.employer ? { employer: v.employer } : {}),
      ...(v.location ? { location: v.location } : {}),
      ...(v.fte ? { fte: Number(v.fte) } : {}),
    })}
    fields={(v, set, errs) => (
      <>
        <Field
          label="Job title"
          value={v.jobTitle ?? ''}
          onChange={(x) => set('jobTitle', x)}
          error={errs.jobTitle}
          placeholder="Staff Nurse"
        />
        <Field
          label="Department"
          value={v.department ?? ''}
          onChange={(x) => set('department', x)}
          error={errs.department}
          hint="Business rules match on this, and the account's container is built from it."
          placeholder="Nursing"
        />
        <Field
          label="Start date"
          type="date"
          value={v.startDate ?? ''}
          onChange={(x) => set('startDate', x)}
          error={errs.startDate}
        />
        <Field
          label="End date"
          type="date"
          value={v.endDate ?? ''}
          onChange={(x) => set('endDate', x)}
          error={errs.endDate}
          hint="Leave empty for an open-ended engagement."
        />
        <Field
          label="Cost centre"
          value={v.costCentre ?? ''}
          onChange={(x) => set('costCentre', x)}
          error={errs.costCentre}
        />
        <Field
          label="Employer"
          value={v.employer ?? ''}
          onChange={(x) => set('employer', x)}
          error={errs.employer}
        />
        <Field
          label="Location"
          value={v.location ?? ''}
          onChange={(x) => set('location', x)}
          error={errs.location}
        />
        <Field
          label="FTE"
          value={v.fte ?? ''}
          onChange={(x) => set('fte', x)}
          error={errs.fte}
          hint="Between 0 and 2. Rules can compare on it."
          placeholder="1.0"
        />
      </>
    )}
  />
</div>
```

Add `Field` and `RecordPanel` to the imports at the top of the file.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/PersonDetailPage.tsx apps/web/src/pages/admin/PersonDetailPage.test.tsx
git commit -m "feat(console): a contract can be created by hand at last"
```

---

## Task 2: Link-account form on the person page

`POST /persons/:id/link-user` exists and nothing calls it. The Accounts panel's empty state advises linking an account and provides no control.

**Files:**
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx`
- Test: `apps/web/src/pages/admin/PersonDetailPage.test.tsx`

**Interfaces:**
- Consumes: `useApiResource`, `RecordPanel`, `Select` from `@syntra/ui`.
- Produces: nothing other tasks depend on.

`GET /api/admin/users` returns rows straight from `listUsers`, which is an unselected `findMany` — so `personId` is present in the payload already. Only the client-side type needs it.

- [ ] **Step 1: Write the failing test**

```tsx
it('links an existing unlinked account to the person', async () => {
  const user = userEvent.setup();
  const posted: unknown[] = [];
  server.use(
    http.get('/api/admin/persons/p1', () =>
      HttpResponse.json({
        id: 'p1',
        givenName: 'Maya',
        familyName: 'Okafor',
        businessEmail: null,
        externalId: null,
        status: 'active',
        contracts: [],
        users: [],
      }),
    ),
    http.get('/api/admin/users', () =>
      HttpResponse.json({
        users: [
          { id: 'u1', login: 'mokafor', personId: null, status: 'active' },
          { id: 'u2', login: 'taken', personId: 'p9', status: 'active' },
        ],
      }),
    ),
    http.post('/api/admin/persons/p1/link-user', async ({ request }) => {
      posted.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );

  renderPersonDetail('p1');

  await user.click(await screen.findByRole('button', { name: 'Link an account' }));
  const picker = screen.getByLabelText('Account');
  // Only the unlinked one is offered: linking an account that already
  // belongs to somebody else silently moves it.
  expect(within(picker).queryByText('taken')).not.toBeInTheDocument();
  await user.selectOptions(picker, 'u1');
  await user.click(screen.getByRole('button', { name: 'Link an account' }));

  await waitFor(() => expect(posted).toEqual([{ userId: 'u1' }]));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx -t 'links an existing'`
Expected: FAIL — no button named "Link an account".

- [ ] **Step 3: Implement**

Add near the top of the component:

```tsx
// Tolerated failure, as on the users page: a caller who may read people but
// not the directory gets an empty list and a form that simply offers nothing,
// rather than a page that will not render.
const { data: usersData } = useApiResource<{
  users: { id: string; login: string; personId: string | null; status: string }[];
}>('/api/admin/users');

const unlinked = (usersData?.users ?? []).filter((u) => u.personId === null);
```

Inside the Accounts `Panel`, below the list/empty state:

```tsx
<div className="p-4">
  <RecordPanel
    title="Link an account"
    submitLabel="Link an account"
    path={`/api/admin/persons/${data.id}/link-user`}
    onCreated={reload}
    disabled={unlinked.length === 0}
    disabledReason="Every account already belongs to somebody."
    build={(v) => ({ userId: v.userId ?? '' })}
    fields={(v, set, errs) => (
      <Select
        label="Account"
        value={v.userId ?? ''}
        onChange={(x) => set('userId', x)}
        error={errs.userId}
        hint="Only accounts not already linked to a person are listed."
        options={[
          { value: '', label: 'Choose an account' },
          ...unlinked.map((u) => ({ value: u.id, label: u.login })),
        ]}
      />
    )}
  />
</div>
```

Add `Select` to the `@syntra/ui` import.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/PersonDetailPage.tsx apps/web/src/pages/admin/PersonDetailPage.test.tsx
git commit -m "feat(console): link an account to a person from the person page"
```

---

## Task 3: The onboarding page — person and contract

`RecordPanel` posts to exactly one path, so it cannot express a sequence. This page is bespoke.

**Files:**
- Create: `apps/web/src/pages/admin/OnboardPersonPage.tsx`
- Create: `apps/web/src/pages/admin/OnboardPersonPage.test.tsx`
- Modify: `apps/web/src/routes.tsx`
- Modify: `apps/web/src/pages/admin/PersonsPage.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `../../session/api.js`; `fieldErrors` from `./hooks.js`.
- Produces: default-exported `OnboardPersonPage`, routed at `/admin/people/new`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/pages/admin/OnboardPersonPage.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../test-setup.js';
import { OnboardPersonPage } from './OnboardPersonPage.js';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/people/new']}>
      <Routes>
        <Route path="/admin/people/new" element={<OnboardPersonPage />} />
        <Route path="/admin/people/:id" element={<div>person page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardPersonPage', () => {
  it('creates the person then the contract, in that order', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.use(
      http.get('/api/admin/org-units', () => HttpResponse.json({ orgUnits: [] })),
      http.get('/api/admin/targets', () => HttpResponse.json({ targets: [] })),
      http.post('/api/admin/persons', async () => {
        calls.push('person');
        return HttpResponse.json({ id: 'p1' }, { status: 201 });
      }),
      http.post('/api/admin/persons/p1/contracts', async () => {
        calls.push('contract');
        return HttpResponse.json({ id: 'c1' }, { status: 201 });
      }),
    );

    renderPage();

    await user.type(screen.getByLabelText('Given name'), 'Maya');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Start date'), '2026-09-01');
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    await waitFor(() => expect(calls).toEqual(['person', 'contract']));
  });

  it('keeps the person and says so when the contract is refused', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/org-units', () => HttpResponse.json({ orgUnits: [] })),
      http.get('/api/admin/targets', () => HttpResponse.json({ targets: [] })),
      http.post('/api/admin/persons', () =>
        HttpResponse.json({ id: 'p1' }, { status: 201 }),
      ),
      http.post('/api/admin/persons/p1/contracts', () =>
        HttpResponse.json(
          { title: 'Conflict', detail: 'contract sequence 1 already exists' },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    renderPage();

    await user.type(screen.getByLabelText('Given name'), 'Maya');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Start date'), '2026-09-01');
    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    // The half that succeeded is named, so nobody re-types a person that
    // already exists.
    expect(await screen.findByText(/Maya Okafor was created/i)).toBeInTheDocument();
    expect(screen.getByText(/contract sequence 1 already exists/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx`
Expected: FAIL — cannot resolve `./OnboardPersonPage.js`.

- [ ] **Step 3: Implement**

Create `apps/web/src/pages/admin/OnboardPersonPage.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors } from './hooks.js';
import { PageHeader } from './PageHeader.js';

/**
 * Onboarding somebody, in one pass.
 *
 * Before this the console could create a person and could create a login, and
 * had no way to record a contract or to connect the two — so an administrator
 * produced an orphan account and a person the provisioning planner had no
 * reason to act on. A contract is what `desiredState` reads; without one there
 * is no desired account and the run does nothing.
 *
 * One page rather than a stepped wizard: the point is to show what a joiner
 * needs all at once, and a wizard hides the second half of the answer behind
 * a Next button.
 */

/** What succeeded, so a failure halfway can say so precisely. */
interface Progress {
  personId: string | null;
  personName: string;
  contract: boolean;
}

export function OnboardPersonPage() {
  const navigate = useNavigate();
  const [v, setV] = useState<Record<string, string>>({
    startDate: new Date().toISOString().slice(0, 10),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) =>
    setV((current) => ({ ...current, [key]: value }));

  function describe(cause: unknown): string {
    if (cause instanceof ApiError) {
      return cause.problem.detail ?? cause.problem.title;
    }
    return 'That could not be saved.';
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    setErrors({});
    const name = `${v.givenName ?? ''} ${v.familyName ?? ''}`.trim();
    const done: Progress = { personId: null, personName: name, contract: false };

    try {
      const person = await api<{ id: string }>('/api/admin/persons', {
        method: 'POST',
        body: JSON.stringify({
          givenName: v.givenName ?? '',
          familyName: v.familyName ?? '',
          ...(v.businessEmail ? { businessEmail: v.businessEmail } : {}),
          ...(v.personalEmail ? { personalEmail: v.personalEmail } : {}),
          ...(v.externalId ? { externalId: v.externalId } : {}),
        }),
      });
      done.personId = person.id;
      setProgress({ ...done });
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setProblem(describe(cause));
      setBusy(false);
      return;
    }

    try {
      await api(`/api/admin/persons/${done.personId}/contracts`, {
        method: 'POST',
        body: JSON.stringify({
          // A person's first contract is their primary one by definition.
          sequence: 1,
          isPrimary: true,
          startDate: v.startDate ?? '',
          ...(v.endDate ? { endDate: v.endDate } : {}),
          ...(v.jobTitle ? { jobTitle: v.jobTitle } : {}),
          ...(v.department ? { department: v.department } : {}),
          ...(v.costCentre ? { costCentre: v.costCentre } : {}),
          ...(v.employer ? { employer: v.employer } : {}),
          ...(v.location ? { location: v.location } : {}),
          ...(v.fte ? { fte: Number(v.fte) } : {}),
        }),
      });
      done.contract = true;
      setProgress({ ...done });
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setProblem(describe(cause));
      setBusy(false);
      return;
    }

    setBusy(false);
    navigate(`/admin/people/${done.personId}`);
  }

  return (
    <>
      <PageHeader
        title="Add someone"
        description="Who they are and what they do. Their account in the directory is created by provisioning, and their login appears on the next sync."
      />

      {/* Named rather than counted. An administrator whose contract was
          refused needs to know the person is already there, or they retype
          it and hit a duplicate external id next. */}
      {progress?.personId && problem && (
        <div className="mb-4">
          <Alert tone="warning" title="Partly done">
            {progress.personName} was created
            {progress.contract ? ', with their contract' : ', but the contract was not'}.
            Finish the rest on their page.
          </Alert>
        </div>
      )}

      {problem && (
        <div className="mb-4">
          <Alert tone="danger">{problem}</Alert>
        </div>
      )}

      <div className="space-y-4">
        <Panel title="Who they are">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field
              label="Given name"
              value={v.givenName ?? ''}
              onChange={(x) => set('givenName', x)}
              error={errors.givenName}
              placeholder="Maya"
            />
            <Field
              label="Family name"
              value={v.familyName ?? ''}
              onChange={(x) => set('familyName', x)}
              error={errors.familyName}
              placeholder="Okafor"
            />
            <Field
              label="Business email"
              type="email"
              value={v.businessEmail ?? ''}
              onChange={(x) => set('businessEmail', x)}
              error={errors.businessEmail}
            />
            <Field
              label="Personal email"
              type="email"
              value={v.personalEmail ?? ''}
              onChange={(x) => set('personalEmail', x)}
              error={errors.personalEmail}
            />
            <Field
              label="External id"
              value={v.externalId ?? ''}
              onChange={(x) => set('externalId', x)}
              error={errors.externalId}
              hint="What the HR system knows them by. A CSV import matches on it."
              placeholder="E1042"
            />
          </div>
        </Panel>

        <Panel
          title="What they do"
          description="The contract. Rules match on these fields, and the account's container is built from them — without one, provisioning has nothing to act on."
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field
              label="Job title"
              value={v.jobTitle ?? ''}
              onChange={(x) => set('jobTitle', x)}
              error={errors.jobTitle}
              placeholder="Staff Nurse"
            />
            <Field
              label="Department"
              value={v.department ?? ''}
              onChange={(x) => set('department', x)}
              error={errors.department}
              placeholder="Nursing"
            />
            <Field
              label="Start date"
              type="date"
              value={v.startDate ?? ''}
              onChange={(x) => set('startDate', x)}
              error={errors.startDate}
            />
            <Field
              label="End date"
              type="date"
              value={v.endDate ?? ''}
              onChange={(x) => set('endDate', x)}
              error={errors.endDate}
              hint="Leave empty for an open-ended engagement."
            />
            <Field
              label="Cost centre"
              value={v.costCentre ?? ''}
              onChange={(x) => set('costCentre', x)}
              error={errors.costCentre}
            />
            <Field
              label="Employer"
              value={v.employer ?? ''}
              onChange={(x) => set('employer', x)}
              error={errors.employer}
            />
            <Field
              label="Location"
              value={v.location ?? ''}
              onChange={(x) => set('location', x)}
              error={errors.location}
            />
            <Field
              label="FTE"
              value={v.fte ?? ''}
              onChange={(x) => set('fte', x)}
              error={errors.fte}
              placeholder="1.0"
            />
          </div>
        </Panel>

        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={busy}>
            Add someone
          </Button>
          <Button variant="secondary" onClick={() => navigate('/admin/people')} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
```

Register the route in `apps/web/src/routes.tsx` alongside the other admin people routes, **before** the `:id` route so `new` is not read as an id:

```tsx
<Route path="people/new" element={<OnboardPersonPage />} />
```

In `PersonsPage.tsx`, replace the "New person" `RecordPanel` with a link to the new page:

```tsx
<div className="mb-4">
  <Link
    to="/admin/people/new"
    className="inline-block rounded-control bg-primary px-3 py-1.5 font-medium text-on-primary"
  >
    Add someone
  </Link>
</div>
```

Match the exact classes used by the primary link on `SourcesPage.tsx:71`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/OnboardPersonPage.tsx apps/web/src/pages/admin/OnboardPersonPage.test.tsx apps/web/src/routes.tsx apps/web/src/pages/admin/PersonsPage.tsx
git commit -m "feat(console): one page that onboards a person with their contract"
```

---

## Task 4: Optional login on the onboarding page

**Files:**
- Modify: `apps/web/src/pages/admin/OnboardPersonPage.tsx`
- Test: `apps/web/src/pages/admin/OnboardPersonPage.test.tsx`

**Interfaces:**
- Consumes: `Check` from `@syntra/ui`; `useApiResource` for org units.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

```tsx
it('creates and links a login only when asked', async () => {
  const user = userEvent.setup();
  const calls: string[] = [];
  server.use(
    http.get('/api/admin/org-units', () => HttpResponse.json({ orgUnits: [] })),
    http.get('/api/admin/targets', () => HttpResponse.json({ targets: [] })),
    http.post('/api/admin/persons', () => {
      calls.push('person');
      return HttpResponse.json({ id: 'p1' }, { status: 201 });
    }),
    http.post('/api/admin/persons/p1/contracts', () => {
      calls.push('contract');
      return HttpResponse.json({ id: 'c1' }, { status: 201 });
    }),
    http.post('/api/admin/users', () => {
      calls.push('user');
      return HttpResponse.json({ id: 'u1' }, { status: 201 });
    }),
    http.post('/api/admin/persons/p1/link-user', () => {
      calls.push('link');
      return new HttpResponse(null, { status: 204 });
    }),
  );

  renderPage();

  await user.type(screen.getByLabelText('Given name'), 'Maya');
  await user.type(screen.getByLabelText('Family name'), 'Okafor');
  await user.type(screen.getByLabelText('Start date'), '2026-09-01');
  await user.click(screen.getByLabelText(/Also create a Syntra login/i));
  await user.type(screen.getByLabelText('Login'), 'mokafor');
  await user.type(screen.getByLabelText('Email'), 'maya@acme.test');
  await user.click(screen.getByRole('button', { name: 'Add someone' }));

  await waitFor(() =>
    expect(calls).toEqual(['person', 'contract', 'user', 'link']),
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx -t 'only when asked'`
Expected: FAIL — no checkbox labelled "Also create a Syntra login".

- [ ] **Step 3: Implement**

Add to `Progress`: `user: boolean;` and initialise it `false` in `done`.

Add state and the org-unit read:

```tsx
const [wantsLogin, setWantsLogin] = useState(false);
const { data: unitsData } = useApiResource<{ orgUnits: { id: string; name: string }[] }>(
  '/api/admin/org-units',
);
```

After the contract block in `submit()`:

```tsx
if (wantsLogin) {
  try {
    const created = await api<{ id: string }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        login: v.login ?? '',
        email: v.loginEmail ?? '',
        // The schema requires a display name and "what shall I call this
        // account" has an obvious answer when nobody typed one.
        displayName: `${v.givenName ?? ''} ${v.familyName ?? ''}`.trim() || (v.login ?? ''),
        ...(v.orgUnitId ? { orgUnitId: v.orgUnitId } : {}),
      }),
    });
    await api(`/api/admin/persons/${done.personId}/link-user`, {
      method: 'POST',
      body: JSON.stringify({ userId: created.id }),
    });
    done.user = true;
    setProgress({ ...done });
  } catch (cause) {
    setErrors(fieldErrors(cause));
    setProblem(describe(cause));
    setBusy(false);
    return;
  }
}
```

Add the panel between "What they do" and the buttons:

```tsx
<Panel title="Syntra sign-in">
  <div className="space-y-4 p-4">
    {/* Off by default, and the copy says why. In this deployment the
        directory account is created by provisioning and the login comes
        back on the next sync, so ticking this for an ordinary joiner
        produces a second account nobody needed. */}
    <Check
      label="Also create a Syntra login"
      checked={wantsLogin}
      onChange={setWantsLogin}
      hint="Not needed for most people: provisioning creates their directory account and the login appears on the next sync. Tick it for an administrator, or somebody with no directory presence."
    />
    {wantsLogin && (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Login"
          value={v.login ?? ''}
          onChange={(x) => set('login', x)}
          error={errors.login}
          placeholder="mokafor"
        />
        <Field
          label="Email"
          type="email"
          value={v.loginEmail ?? ''}
          onChange={(x) => set('loginEmail', x)}
          error={errors.email}
        />
        <Select
          label="Org unit"
          value={v.orgUnitId ?? ''}
          onChange={(x) => set('orgUnitId', x)}
          error={errors.orgUnitId}
          hint="Scopes administrative roles and org-unit application grants. Unrelated to the directory OU the account is created in."
          options={[
            { value: '', label: 'None' },
            ...(unitsData?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
      </div>
    )}
  </div>
</Panel>
```

Extend the partial-progress alert to mention the login:

```tsx
{progress.contract ? ', with their contract' : ', but the contract was not'}
{progress.contract && wantsLogin && !progress.user ? '. The login was not created' : ''}
```

Add `Check` and `Select` to the `@syntra/ui` import and `useApiResource` to the `./hooks.js` import. If `Check` does not expose `hint`, put the sentence in a `<p className="text-muted">` beneath it instead.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx`
Expected: PASS, all three tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/OnboardPersonPage.tsx apps/web/src/pages/admin/OnboardPersonPage.test.tsx
git commit -m "feat(console): optionally create and link a login while onboarding"
```

---

## Task 5: Provision the new person automatically

A run is whole-target and asynchronous. Applying it wholesale would commit every other pending action in that target. `applyRunRequestSchema` takes `only: string[]` (`packages/contracts/src/provision.ts:329`), so only the new person's actions are applied.

**Files:**
- Modify: `apps/web/src/pages/admin/OnboardPersonPage.tsx`
- Test: `apps/web/src/pages/admin/OnboardPersonPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/targets`, `POST /api/admin/targets/:id/runs`, `GET /api/admin/targets/:id/runs/:runId`, `POST /api/admin/targets/:id/runs/:runId/apply`.
- Produces: nothing other tasks depend on.

Run status is `running` while planning, then `previewed` or `blocked`. `NON_TERMINAL` is `['running', 'previewed', 'blocked', 'applying']` (`run-service.ts:62`); planning is finished once the status is no longer `running`.

- [ ] **Step 1: Write the failing test**

```tsx
it('applies only the new person actions and leaves the rest of the run alone', async () => {
  const user = userEvent.setup();
  let applied: unknown = null;
  server.use(
    http.get('/api/admin/org-units', () => HttpResponse.json({ orgUnits: [] })),
    http.get('/api/admin/targets', () =>
      HttpResponse.json({ targets: [{ id: 't1', name: 'AD', enabled: true }] }),
    ),
    http.post('/api/admin/persons', () => HttpResponse.json({ id: 'p1' }, { status: 201 })),
    http.post('/api/admin/persons/p1/contracts', () =>
      HttpResponse.json({ id: 'c1' }, { status: 201 }),
    ),
    http.post('/api/admin/targets/t1/runs', () =>
      HttpResponse.json({ jobId: 'j1' }, { status: 202 }),
    ),
    http.get('/api/admin/targets/t1/runs', () =>
      HttpResponse.json({ runs: [{ id: 'r1', status: 'previewed' }] }),
    ),
    http.get('/api/admin/targets/t1/runs/r1', () =>
      HttpResponse.json({
        id: 'r1',
        status: 'previewed',
        actions: [
          { id: 'a1', personId: 'p1', actionType: 'create_account' },
          { id: 'a2', personId: 'p9', actionType: 'disable_account' },
        ],
      }),
    ),
    http.post('/api/admin/targets/t1/runs/r1/apply', async ({ request }) => {
      applied = await request.json();
      return HttpResponse.json({ ok: true });
    }),
  );

  renderPage();

  await user.type(screen.getByLabelText('Given name'), 'Maya');
  await user.type(screen.getByLabelText('Family name'), 'Okafor');
  await user.type(screen.getByLabelText('Start date'), '2026-09-01');
  await user.click(screen.getByRole('button', { name: 'Add someone' }));

  // a2 belongs to somebody else and is NOT applied — that is the whole point
  // of scoping, and applying the run wholesale would have disabled them.
  await waitFor(() => expect(applied).toEqual({ only: ['a1'] }));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx -t 'applies only'`
Expected: FAIL — `applied` stays `null`.

- [ ] **Step 3: Implement**

Add to `Progress`: `provisioned: number;` initialised to `0`.

Add the targets read next to the org-unit one:

```tsx
const { data: targetsData } = useApiResource<{
  targets: { id: string; name: string; enabled: boolean }[];
}>('/api/admin/targets');
```

Add above the component:

```tsx
/** Statuses a run passes through before its plan exists. */
const PLANNING = 'running';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one target and applies only what it proposed for this person.
 *
 * The scoping is load-bearing rather than tidy. A run is computed over the
 * whole target, so applying it wholesale would also commit every disable and
 * archive pending for everybody else — actions nobody reviewed and that this
 * page has no business committing on a joiner's behalf.
 *
 * `confirm` is left at its default false. A joiner's actions are additive and
 * trip no guard; anything that does trip one surfaces on the run page for
 * review instead of going through silently.
 */
async function provisionOne(targetId: string, personId: string): Promise<number> {
  await api(`/api/admin/targets/${targetId}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  // Bounded. A target that never finishes planning must not hang onboarding
  // forever; the run keeps going and the run page is where it is watched.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(1500);
    const { runs } = await api<{ runs: { id: string; status: string }[] }>(
      `/api/admin/targets/${targetId}/runs`,
    );
    const latest = runs[0];
    if (!latest || latest.status === PLANNING) continue;

    const detail = await api<{
      actions: { id: string; personId: string | null }[];
    }>(`/api/admin/targets/${targetId}/runs/${latest.id}`);
    const only = detail.actions
      .filter((action) => action.personId === personId)
      .map((action) => action.id);
    if (only.length === 0) return 0;

    await api(`/api/admin/targets/${targetId}/runs/${latest.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ only }),
    });
    return only.length;
  }
  return 0;
}
```

At the end of `submit()`, replacing the immediate `navigate`:

```tsx
// A disabled target is deliberately skipped: a new person should not be the
// thing that quietly reactivates a target somebody switched off.
const targets = (targetsData?.targets ?? []).filter((t) => t.enabled);
for (const target of targets) {
  try {
    done.provisioned += await provisionOne(target.id, done.personId!);
    setProgress({ ...done });
  } catch (cause) {
    // The person, contract and login are already saved. A provisioning
    // failure is reported and does not undo them — the run page is where
    // it gets diagnosed.
    setProblem(describe(cause));
    setBusy(false);
    return;
  }
}

setBusy(false);
navigate(`/admin/people/${done.personId}`);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/web/src/pages/admin/OnboardPersonPage.test.tsx`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/OnboardPersonPage.tsx apps/web/src/pages/admin/OnboardPersonPage.test.tsx
git commit -m "feat(console): provision a new person on creation, scoped to their own actions"
```

---

## Task 6: Re-describe the Users page

Closes the "why are there two pages" complaint without merging the tables.

**Files:**
- Modify: `apps/web/src/pages/admin/UsersPage.tsx`
- Modify: `apps/web/src/pages/admin/PersonsPage.tsx`

- [ ] **Step 1: Change the Users page description**

In `UsersPage.tsx`, replace the `PageHeader` description:

```tsx
<PageHeader
  title="Users"
  description="Accounts that sign into Syntra. Most arrive automatically from a directory sync — create one here only for an administrator, or somebody with no directory presence. To onboard a new joiner, start under People."
/>
```

- [ ] **Step 2: Change the People page description**

In `PersonsPage.tsx`:

```tsx
<PageHeader
  title="People"
  description="Everyone the organization knows, and the contracts they hold. Start here to onboard someone; their sign-in accounts are listed under Users."
/>
```

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run apps/web/src/pages/admin/UsersPage.test.tsx apps/web/src/pages/admin/PersonsPage.test.tsx`
Expected: PASS. If an assertion pinned the old copy, update it to the new sentence.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/PersonsPage.tsx
git commit -m "docs(console): say what Users is for, now that People is the front door"
```

---

**Part 1 is complete and shippable here.** Run `pnpm test` before continuing.

---

# Part 2 — Deletion

Touches the four files shared with `remediation-4-auth-api-console`. Rebase onto `main` before starting.

## Task 7: The `writebackDelete` flag

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260906000000_writeback_delete/migration.sql`
- Modify: `packages/db/src/migration-order.ts`
- Modify: `packages/core/src/sync/source-service.ts`
- Test: `apps/api/src/routes/admin/sources.test.ts`

**Interfaces:**
- Produces: `DirectorySource.writebackDelete: boolean`, default `false`; `createSource`/`updateSource` accept `writebackDelete?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/admin/sources.test.ts`, following the file's existing create-source test:

```ts
it('defaults writebackDelete to false and lets it be turned on deliberately', async () => {
  const cookie = await authCookie('admin');
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/sources',
    headers: { host: ctx.host, cookie },
    payload: sourcePayload({ name: 'AD' }),
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().writebackDelete).toBe(false);

  const patched = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/sources/${created.json().id}`,
    headers: { host: ctx.host, cookie },
    payload: { writebackEnabled: true, writebackDelete: true },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().writebackDelete).toBe(true);
});
```

Reuse the file's existing `sourcePayload` helper; if it has none, copy the payload literal from the neighbouring create test.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/api/src/routes/admin/sources.test.ts -t 'writebackDelete'`
Expected: FAIL — `writebackDelete` is `undefined`.

- [ ] **Step 3: Add the column**

In `packages/db/prisma/schema.prisma`, directly after `writebackDisable`:

```prisma
  /// Whether Syntra may DELETE an object in this source.
  ///
  /// Separate from the other two and default false for the same reason they
  /// are: a source configured before deletion existed must not acquire the
  /// ability to remove objects because it was upgraded. It is also the only
  /// write here that cannot be undone by writing the opposite value back.
  writebackDelete              Boolean   @default(false)
```

Create `packages/db/prisma/migrations/20260906000000_writeback_delete/migration.sql`:

```sql
-- Deletion is refused until a source is deliberately allowed it.
ALTER TABLE "DirectorySource"
  ADD COLUMN "writebackDelete" BOOLEAN NOT NULL DEFAULT false;
```

Append to `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`:

```ts
  '20260906000000_writeback_delete',
```

- [ ] **Step 4: Thread it through the service**

In `packages/core/src/sync/source-service.ts`, add `writebackDelete?: boolean | undefined;` to both input interfaces (beside `writebackDisable` at lines 35 and 85), add `writebackDelete: input.writebackDelete ?? false,` to the create data, and to the update:

```ts
      ...(input.writebackDelete !== undefined
        ? { writebackDelete: input.writebackDelete }
        : {}),
```

Add `writebackDelete: z.boolean().optional()` to the create and patch source schemas in `packages/contracts/src/` wherever `writebackDisable` appears.

- [ ] **Step 5: Regenerate, migrate and run**

```bash
pnpm db:generate
npx vitest run apps/api/src/routes/admin/sources.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/core/src/sync/source-service.ts packages/contracts/src apps/api/src/routes/admin/sources.test.ts
git commit -m "feat(sync): a source must be allowed deletion explicitly"
```

---

## Task 8: `deleteObject` on the writeback connector

**Files:**
- Modify: `packages/connectors/src/types.ts`
- Modify: `packages/connectors/src/ldap/writeback.ts`
- Test: `packages/connectors/src/ldap/writeback.integration.test.ts`

**Interfaces:**
- Produces: `SourceWriteback.deleteObject(config, input: DeleteObjectInput): Promise<WritebackResult>` where `DeleteObjectInput = { anchor: string }`.

This test binds the shared `infra-samba-1` container. Check no peer session is running its suite first.

- [ ] **Step 1: Write the failing test**

Add to `packages/connectors/src/ldap/writeback.integration.test.ts`, using the file's existing `makeAccount` helper:

```ts
describe('ldapWriteback.deleteObject', () => {
  it('removes the object and a second delete reports it gone', async () => {
    const account = await makeAccount();

    const first = await ldapWriteback.deleteObject(config, { anchor: account.anchor });
    expect(first.ok, first.message).toBe(true);

    // Not an error: the caller asked for the object to be absent and it is.
    // Reporting not_found lets the service distinguish "already gone" from
    // "the bind may not delete", which are different problems.
    const second = await ldapWriteback.deleteObject(config, { anchor: account.anchor });
    expect(second.ok).toBe(false);
    expect(second.failure).toBe('not_found');
  });

  it('reports an empty anchor as not found rather than searching for it', async () => {
    const result = await ldapWriteback.deleteObject(config, { anchor: '' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/connectors/src/ldap/writeback.integration.test.ts -t 'deleteObject'`
Expected: FAIL — `ldapWriteback.deleteObject is not a function`.

- [ ] **Step 3: Implement**

In `packages/connectors/src/types.ts`, beside `SetEnabledInput`:

```ts
/**
 * Deleting one directory object, by anchor.
 *
 * Deliberately NOT a `ProvisionActionType`. The invariant above — that the
 * planner has no delete and no type that could become one — is about MASS
 * action computed from state, where the characteristic accident is four
 * thousand objects rather than one. This is the other thing entirely: a named
 * object, named by a human, one at a time. It travels the write-back path for
 * the same reason `changePassword` does.
 */
export interface DeleteObjectInput {
  anchor: string;
}
```

Extend the interface:

```ts
export interface SourceWriteback<C> {
  changePassword(config: C, input: ChangePasswordInput): Promise<WritebackResult>;
  setEnabled(config: C, input: SetEnabledInput): Promise<WritebackResult>;
  deleteObject(config: C, input: DeleteObjectInput): Promise<WritebackResult>;
}
```

In `packages/connectors/src/ldap/writeback.ts`, add to the exported object:

```ts
  /**
   * Deletes the object the anchor names.
   *
   * A leaf delete, never a subtree one. `ldapts`'s `del` removes a single
   * entry and the directory refuses it for an object with children, which is
   * the behaviour that belongs here: a recursive delete triggered by hand is
   * the same mass-removal shape the provisioning invariant exists to prevent,
   * and an org unit with people in it should be refused, not emptied.
   */
  async deleteObject(rawConfig, input: DeleteObjectInput): Promise<WritebackResult> {
    const config = normalise(rawConfig);
    let client: Client | undefined;
    try {
      client = await openBound(config, config.bindDn, config.bindPassword);
      const located = await locate(client, config, input.anchor);
      if (!located) return fail('not_found');
      await client.del(located.dn);
      return { ok: true, message: `${located.dn} was deleted from the directory` };
    } catch (cause) {
      return fail(classify(cause));
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },
```

Import `DeleteObjectInput` at the top of the file alongside the other input types.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/connectors/src/ldap/writeback.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/types.ts packages/connectors/src/ldap/writeback.ts packages/connectors/src/ldap/writeback.integration.test.ts
git commit -m "feat(connectors): the write-back path can delete one named object"
```

---

## Task 9: `deleteDirectoryUser`

**Files:**
- Modify: `packages/core/src/directory/directory-writeback.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/directory/directory-delete.test.ts` (create)

**Interfaces:**
- Produces:
```ts
export type DeleteOutcome =
  | { ok: true; viaDirectory: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'delete_not_enabled'; sourceName: string }
  | { ok: false; reason: 'no_credential'; sourceName: string }
  | { ok: false; reason: 'directory_failed'; failure: WritebackFailure; message: string };

export function deleteDirectoryUser(
  tenantId: string,
  provider: MasterKeyProvider,
  input: { userId: string; actorUserId: string; sourceIp?: string | undefined },
): Promise<DeleteOutcome>;
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/directory/directory-delete.test.ts`, modelled on the existing writeback tests in this directory for tenant and provider setup:

```ts
it('keeps the person, their contracts and the audit trail', async () => {
  const { userId, personId } = await seedLinkedUser();

  const outcome = await deleteDirectoryUser(tenantId, provider, {
    userId,
    actorUserId: adminId,
  });

  expect(outcome).toEqual({ ok: true, viaDirectory: false });
  await withTenant(tenantId, async (tx) => {
    expect(await tx.user.findUnique({ where: { id: userId } })).toBeNull();
    // The record of who they were and what they did survives the login.
    expect(await tx.person.findUnique({ where: { id: personId } })).not.toBeNull();
    expect(await tx.contract.count({ where: { personId } })).toBeGreaterThan(0);
    expect(
      await tx.auditEvent.count({ where: { action: 'user.delete', targetId: userId } }),
    ).toBe(1);
  });
});

it('refuses when the source does not allow deletion, and changes nothing', async () => {
  const { userId } = await seedSourcedUser({ writebackDelete: false });

  const outcome = await deleteDirectoryUser(tenantId, provider, {
    userId,
    actorUserId: adminId,
  });

  expect(outcome).toMatchObject({ ok: false, reason: 'delete_not_enabled' });
  await withTenant(tenantId, async (tx) => {
    expect(await tx.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/src/directory/directory-delete.test.ts`
Expected: FAIL — `deleteDirectoryUser` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/directory/directory-writeback.ts`:

```ts
export type DeleteOutcome =
  | { ok: true; viaDirectory: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'delete_not_enabled'; sourceName: string }
  | { ok: false; reason: 'no_credential'; sourceName: string }
  | { ok: false; reason: 'directory_failed'; failure: WritebackFailure; message: string };

/**
 * Deleting an account, and meaning it.
 *
 * The directory goes first, and Syntra's row goes only if that succeeded. The
 * other order has a specific failure that this deployment has already seen:
 * Syntra forgets an account the directory still holds, and the next sync run
 * reads it as a new object and creates it again. Deleting the directory object
 * first means a refusal leaves both sides exactly as they were.
 *
 * The Person is deliberately untouched. The audit log is hash-chained and
 * append-only, and a deleted login whose person is gone leaves "who held this
 * access in March" unanswerable — which is the question deletion must not cost
 * the ability to answer.
 */
export async function deleteDirectoryUser(
  tenantId: string,
  provider: MasterKeyProvider,
  input: { userId: string; actorUserId: string; sourceIp?: string | undefined },
): Promise<DeleteOutcome> {
  const resolved = await withTenant(tenantId, (tx) => resolveForDelete(tx, input.userId));
  if (!resolved) return { ok: false, reason: 'not_found' };

  if (resolved.sourceId !== null) {
    if (!resolved.deletes) {
      return { ok: false, reason: 'delete_not_enabled', sourceName: resolved.sourceName };
    }
    const config = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, resolved.sourceId!),
    );
    if (config === null) {
      return { ok: false, reason: 'no_credential', sourceName: resolved.sourceName };
    }

    const result = await ldapWriteback.deleteObject(config, {
      anchor: resolved.user.sourceAnchor ?? '',
    });
    if (!result.ok) {
      await withTenant(tenantId, (tx) =>
        recordEvent(tx, {
          actorUserId: input.actorUserId,
          action: 'user.delete',
          targetType: 'User',
          targetId: input.userId,
          outcome: 'failure',
          sourceIp: input.sourceIp ?? null,
          payload: { login: resolved.user.login, failure: result.failure ?? 'transient' },
        }),
      );
      return {
        ok: false,
        reason: 'directory_failed',
        failure: result.failure ?? 'transient',
        message: result.message,
      };
    }
  }

  await withTenant(tenantId, async (tx) => {
    // Audited BEFORE the row goes, so the event still has a live foreign key
    // to name and the chain records the login rather than a bare uuid.
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'user.delete',
      targetType: 'User',
      targetId: input.userId,
      outcome: 'success',
      sourceIp: input.sourceIp ?? null,
      payload: {
        login: resolved.user.login,
        personId: resolved.user.personId,
        viaDirectory: resolved.sourceId !== null,
      },
    });
    await tx.user.delete({ where: { id: input.userId } });
  });

  return { ok: true, viaDirectory: resolved.sourceId !== null };
}

async function resolveForDelete(tx: TenantClient, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, login: true, personId: true, sourceId: true, sourceAnchor: true },
  });
  if (!user) return null;
  if (user.sourceId === null) {
    return { user, sourceId: null, sourceName: '', deletes: false };
  }
  const source = await tx.directorySource.findUnique({
    where: { id: user.sourceId },
    select: { name: true, writebackEnabled: true, writebackDelete: true },
  });
  return {
    user,
    sourceId: user.sourceId,
    sourceName: source?.name ?? 'the directory source',
    deletes: Boolean(source?.writebackEnabled && source.writebackDelete),
  };
}
```

Export `deleteDirectoryUser` and `DeleteOutcome` from `packages/core/src/index.ts` beside the existing directory-writeback exports.

If `User` has restricting foreign keys (sessions, credentials, group memberships), delete those rows in the same transaction before `tx.user.delete`, mirroring what `deactivateUser` already revokes.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/src/directory/directory-delete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/directory packages/core/src/index.ts
git commit -m "feat(directory): delete an account through the directory first, and keep the person"
```

---

## Task 10: The `directory.delete` permission

**Files:**
- Modify: `packages/core/src/rbac/permissions.ts`
- Test: `apps/api/src/routes/admin/access.test.ts`

**Interfaces:**
- Produces: `PERMISSIONS.DIRECTORY_DELETE = 'directory.delete'`.

- [ ] **Step 1: Add the permission**

In `packages/core/src/rbac/permissions.ts`, after `DIRECTORY_WRITE`:

```ts
  /**
   * Removing a directory object outright, as opposed to deactivating it.
   *
   * Separate from `directory.write` because editing the directory and
   * destroying part of it are different acts with different consequences, and
   * only one of them is reversible. Everything else in this product
   * deactivates; this is the one permission that does not.
   */
  DIRECTORY_DELETE: 'directory.delete',
```

- [ ] **Step 2: Run the permission suites**

Run: `npx vitest run packages/core/src/rbac apps/api/src/routes/admin/access.test.ts`
Expected: PASS. `ALL_PERMISSIONS` is derived from the object, so a test asserting a fixed catalogue may need the new entry adding.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/rbac/permissions.ts
git commit -m "feat(rbac): directory.delete, held separately from directory.write"
```

> At merge, `remediation-4-auth-api-console` adds `packages/db/src/builtin-role-permissions.test.ts` asserting each built-in role's permission set. Grant `directory.delete` to the highest built-in role there and update that assertion.

---

## Task 11: `DELETE /api/admin/users/:id`

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts`
- Test: `apps/api/src/routes/admin/users.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('deletes a user for a caller holding directory.delete, keeping the person', async () => {
  await seedAdmin([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.DIRECTORY_DELETE]);
  const cookie = await authCookie('admin');
  const { userId, personId } = await seedLinkedUser();

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/admin/users/${userId}`,
    headers: { host: ctx.host, cookie },
  });

  expect(res.statusCode).toBe(204);
  await withTenant(ctx.tenantId, async (tx) => {
    expect(await tx.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await tx.person.findUnique({ where: { id: personId } })).not.toBeNull();
  });
});

it('refuses a caller who may write the directory but not delete from it', async () => {
  await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
  const cookie = await authCookie('admin');
  const { userId } = await seedLinkedUser();

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/admin/users/${userId}`,
    headers: { host: ctx.host, cookie },
  });

  expect(res.statusCode).toBe(403);
  await withTenant(ctx.tenantId, async (tx) => {
    expect(await tx.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/api/src/routes/admin/users.test.ts -t 'directory.delete'`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement**

Add to `apps/api/src/routes/admin/users.ts`:

```ts
  /**
   * Deletion, which everywhere else in this product is deactivation.
   *
   * Offered because a directory that can never forget anything is its own
   * problem, and refused unless the source was deliberately allowed it. The
   * Person and the audit trail survive: see `deleteDirectoryUser`.
   */
  app.delete(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_DELETE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const outcome = await deleteDirectoryUser(request.tenantId, provider, {
        userId: id,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'not_found':
            throw new ProblemError(404, 'not-found', 'User not found');
          case 'delete_not_enabled':
            throw new ProblemError(
              409,
              'delete-not-enabled',
              'This account cannot be deleted',
              `${outcome.sourceName} is not configured to allow Syntra to delete objects in it, and deleting only the Syntra row would let the next sync run recreate the account`,
            );
          case 'no_credential':
            throw new ProblemError(
              409,
              'no-credential',
              'This account cannot be deleted',
              `the bind credential for ${outcome.sourceName} could not be unsealed`,
            );
          case 'directory_failed':
            throw new ProblemError(
              502,
              'directory-failed',
              'The directory refused the delete',
              outcome.message,
            );
        }
      }
      return reply.status(204).send();
    },
  );
```

Add `deleteDirectoryUser` to the `@syntra/core` import.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/api/src/routes/admin/users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/api/src/routes/admin/users.test.ts
git commit -m "feat(api): DELETE /admin/users/:id, directory first"
```

---

## Task 12: `DELETE /api/admin/org-units/:id`

**Files:**
- Modify: `apps/api/src/routes/admin/org-units.ts`
- Test: `apps/api/src/routes/admin/directory-edit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to delete an org unit that still holds users or child units', async () => {
  const cookie = await authCookie('admin');
  const { unitId } = await seedUnitWithUser();

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/admin/org-units/${unitId}`,
    headers: { host: ctx.host, cookie },
  });

  expect(res.statusCode).toBe(409);
  // Says what is still in it, so the reader knows what to move.
  expect(res.json().detail).toMatch(/1 user/i);
});

it('deletes an empty org unit', async () => {
  const cookie = await authCookie('admin');
  const unitId = await seedEmptyUnit();

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/admin/org-units/${unitId}`,
    headers: { host: ctx.host, cookie },
  });

  expect(res.statusCode).toBe(204);
  await withTenant(ctx.tenantId, async (tx) => {
    expect(await tx.orgUnit.findUnique({ where: { id: unitId } })).toBeNull();
  });
});
```

Seed the admin in this file with `ALL_PERMISSIONS`, which now includes `directory.delete`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/api/src/routes/admin/directory-edit.test.ts -t 'org unit'`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

Add to `apps/api/src/routes/admin/org-units.ts`:

```ts
  /**
   * Deleting a unit, which is refused unless it is empty.
   *
   * Emptiness counts EVERY user and child unit, not only the active ones: a
   * deactivated user still sits in the unit, and deleting around it orphans
   * the row. Refusing rather than reparenting matches what the directory
   * itself does — an OU with children cannot be removed without a recursive
   * tree delete, and a recursive delete triggered by hand is the mass removal
   * the provisioning invariant exists to prevent.
   */
  app.delete(
    '/org-units/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_DELETE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      await request.db(async (tx) => {
        const unit = await tx.orgUnit.findUnique({ where: { id } });
        if (!unit) throw new ProblemError(404, 'not-found', 'Org unit not found');

        const [users, children] = await Promise.all([
          tx.user.count({ where: { orgUnitId: id } }),
          tx.orgUnit.count({ where: { parentId: id } }),
        ]);
        if (users > 0 || children > 0) {
          const holds = [
            users > 0 ? `${users} user${users === 1 ? '' : 's'}` : null,
            children > 0 ? `${children} child unit${children === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' and ');
          throw new ProblemError(
            409,
            'org-unit-not-empty',
            'This unit is not empty',
            `it still holds ${holds}; move them before deleting it`,
          );
        }

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'orgUnit.delete',
          targetType: 'OrgUnit',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: unit.name, parentId: unit.parentId },
        });
        await tx.orgUnit.delete({ where: { id } });
      });

      return reply.status(204).send();
    },
  );
```

A source-owned unit (`sourceId` set) additionally needs the directory delete first, exactly as Task 9 does for users. If the unit has a `sourceAnchor`, call `ldapWriteback.deleteObject` before the transaction and refuse on failure; add a core helper `deleteDirectoryOrgUnit` mirroring `deleteDirectoryUser` rather than calling the connector from the route.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run apps/api/src/routes/admin/directory-edit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/org-units.ts apps/api/src/routes/admin/directory-edit.test.ts
git commit -m "feat(api): DELETE /admin/org-units/:id, refused unless empty"
```

---

## Task 13: Delete controls in the console

**Files:**
- Create: `apps/web/src/pages/admin/DeleteButton.tsx`
- Create: `apps/web/src/pages/admin/DeleteButton.test.tsx`
- Modify: `apps/web/src/pages/admin/UsersPage.tsx`
- Modify: `apps/web/src/pages/admin/OrgUnitsPage.tsx`

**Interfaces:**
- Produces:
```tsx
export function DeleteButton(props: {
  path: string;          // e.g. `/api/admin/users/${id}`
  label: string;         // e.g. 'user'
  confirmWord: string;   // the login or unit name the reader must type
  warning: string;       // what is about to be irreversible
  onDeleted(): void;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

```tsx
it('will not delete until the name is typed exactly', async () => {
  const user = userEvent.setup();
  let called = false;
  server.use(
    http.delete('/api/admin/users/u1', () => {
      called = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );

  render(
    <DeleteButton
      path="/api/admin/users/u1"
      label="user"
      confirmWord="mokafor"
      warning="This cannot be undone."
      onDeleted={() => {}}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const confirm = screen.getByRole('button', { name: 'Delete user' });
  expect(confirm).toBeDisabled();

  await user.type(screen.getByLabelText(/type mokafor/i), 'mokafo');
  expect(confirm).toBeDisabled();
  expect(called).toBe(false);

  await user.type(screen.getByLabelText(/type mokafor/i), 'r');
  expect(confirm).toBeEnabled();
  await user.click(confirm);
  await waitFor(() => expect(called).toBe(true));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run apps/web/src/pages/admin/DeleteButton.test.tsx`
Expected: FAIL — cannot resolve `./DeleteButton.js`.

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * The one control in this console that destroys something.
 *
 * Typing the name rather than clicking twice, because a second click is not a
 * second decision — it is the same one, reflexively. Everything else in the
 * directory deactivates, so this is the only place the difference has to be
 * made unmistakable at the moment of pressing it.
 */
export function DeleteButton({
  path,
  label,
  confirmWord,
  warning,
  onDeleted,
}: {
  path: string;
  label: string;
  confirmWord: string;
  warning: string;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      await api(path, { method: 'DELETE' });
      setOpen(false);
      setTyped('');
      onDeleted();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `That ${label} could not be deleted.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Delete
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Alert tone="danger" title={`Delete this ${label}?`}>
        {warning}
      </Alert>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Field
        label={`To confirm, type ${confirmWord}`}
        value={typed}
        onChange={setTyped}
      />
      <div className="flex gap-2">
        <Button
          variant="danger"
          disabled={typed !== confirmWord || busy}
          loading={busy}
          onClick={() => void remove()}
        >
          Delete {label}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setTyped('');
            setProblem(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

If `Button` has no `danger` variant, add one to `packages/ui/src/Button.tsx` using the existing danger tone tokens rather than inventing a colour.

- [ ] **Step 4: Wire it into the two pages**

In `UsersPage.tsx`, inside the actions cell, after the existing `StatusToggle`, rendered only when `can('directory.delete')`:

```tsx
<DeleteButton
  path={`/api/admin/users/${user.id}`}
  label="user"
  confirmWord={user.login}
  warning="The account is removed from the directory and from Syntra. The person and the audit trail are kept. This cannot be undone."
  onDeleted={reload}
/>
```

In `OrgUnitsPage.tsx`, inside `Row`'s trailing span:

```tsx
<DeleteButton
  path={`/api/admin/org-units/${unit.id}`}
  label="org unit"
  confirmWord={unit.name}
  warning="The unit is removed from the directory and from Syntra. It must be empty first. This cannot be undone."
  onDeleted={onChanged}
/>
```

`Row` needs `can` passed down, or import `useSession` inside it.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run apps/web/src/pages/admin`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/DeleteButton.tsx apps/web/src/pages/admin/DeleteButton.test.tsx apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/OrgUnitsPage.tsx packages/ui/src/Button.tsx
git commit -m "feat(console): delete a user or an empty org unit, name typed to confirm"
```

---

## Task 14: Full suite and merge preparation

- [ ] **Step 1: Regenerate and run everything**

```bash
pnpm db:generate
pnpm test
```
Expected: PASS. Check no peer session is running its suite first — `infra-samba-1` and `infra-openldap-1` are shared across all worktrees, and the LDAP integration tests bind them directly.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Rebase onto main and resolve the four known conflicts**

```bash
git fetch origin
git rebase origin/main
```

Resolve by keeping **both** sides in:
- `packages/db/src/migration-order.ts` — both migration names, in name order.
- `packages/contracts/src/index.ts` — both exports.
- `packages/core/src/index.ts` — both exports.
- `packages/core/src/rbac/permissions.ts` — both permissions.

If `packages/db/src/builtin-role-permissions.test.ts` has arrived, add `directory.delete` to the highest built-in role and update its assertion.

- [ ] **Step 4: Re-run and commit**

```bash
pnpm db:generate && pnpm test
```

---

## Self-review notes

Spec coverage checked section by section: §1 → Tasks 3–4; §2 → Task 5; §3 → Tasks 1–2; §4 → Task 6; §5 → Tasks 7–13; §6 → tests inside each task; §7 → Task 14.

Two items are deliberately thinner than the rest and are called out where they occur rather than hidden:

- **The DN hint** on the department field (spec §1) is not implemented. It needs a target's container template resolved client-side, and no endpoint exposes one. Raise it as follow-on work rather than inventing an endpoint here.
- **Org-unit directory deletion** (Task 12, step 3) describes `deleteDirectoryOrgUnit` rather than giving its body, because whether Syntra stores a `sourceAnchor` for units it did not create is unverified. Confirm against a real synced unit before writing it.
