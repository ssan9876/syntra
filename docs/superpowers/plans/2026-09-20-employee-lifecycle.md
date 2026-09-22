# Employee lifecycle implementation plan

> Use superpowers:subagent-driven-development for independent tasks, with integration and final review in the parent task.

**Goal:** Implement all five approved provisioning usability priorities and reassess remaining pilot requirements.

**Architecture:** Extend the existing tenant-scoped services and provisioning engine. Reuse persisted runs/actions and audit events for evidence; never infer success from queue acceptance. All writes retain existing permission, safety threshold and tenant isolation boundaries. UI uses the existing design system.

**Tech stack:** TypeScript, Fastify, Prisma/PostgreSQL, React, Vitest.

**Spec:** `docs/provisioning-usability-2026-09-20.md` (approved priorities in the user's request).

## Constraints and rulings

- Preserve prior uncommitted audit fixes; no commits, deployments or real directory mutations.
- Work in the current checkout because the approved audit changes are already here.
- Use existing safe operations; incomplete and manual work must stay visible.
- Do not claim directory integration validation without real test services.
- Existing skill approval ceremonies are satisfied by the user's explicit request to implement the presented five priorities.

## Tasks

- [x] Fresh previews: bind business-rule/profile results to exact input and target/person; cover edits and delayed responses in component tests.
- [x] Guided setup: derive readiness checklist from saved source/target/profile/rule/run state, link blockers to actual editors; retain expert paths.
- [x] Completion receipts: persist and expose exact person-scoped target provisioning attempts, preserve target outcomes, and offer safe continuation without re-creating records.
- [x] Unified offboarding: person-level preview and execution using existing deactivation, directory-writeback/session invalidation and target policies, with reason and explicit immediate scope.
- [x] Employee queue: tenant-scoped actionable list with filters and links for incomplete hires/departures/failed provisioning; counts and rows use identical predicates.
- [x] Integration: typecheck, lint, focused backend/frontend tests and production build.
- [x] Reassessment: update audit with implemented behavior, evidence and concrete remaining pilot requirements.

## Test strategy

Write meaningful regressions before implementation for stale preview responses, receipt correlation and partial failure, permission boundaries, offboarding multi-account failure and queue filters. Use disposable PostgreSQL for integration tests. Run shared-database suites sequentially. Validate UI error/empty/loading states and mobile containment. Mark environment-blocked tests accurately.

## Execution ledger

- Plan prepared from the approved five-item review; prior audit changes retained.
- Fresh previews reject late responses and require current impact evidence for destructive rule changes.
- Provisioning receipts correlate the exact run and person evidence, survive navigation, and retry the saved work only.
- Offboarding blocks linked sign-ins, revokes sessions, records partial failures and queues target work through receipts.
- Guided setup and employee work pages are linked from Connected systems navigation.
- Remaining pilot gates are recorded in `docs/audit-2026-09-20.md`.
