# Syntra continuous improvement loop

This is the living backlog for autonomous maintenance. Every scheduled pass
must inspect current code and evidence first, update this ordering, complete one
safe item end to end, run focused verification, and record material evidence.
It must not claim external validation from unit tests or make production writes.

## Selection rule

Choose the first item that is both incomplete and executable without new user
authority. Prefer safety and data-integrity defects over features, and prefer a
verified vertical slice over several half-built changes. A pass is complete
only when implementation, tests, documentation, and any required migration are
consistent.

## Prioritized backlog

The complete gap register is maintained in
[the enterprise-readiness backlog](enterprise-readiness-backlog-2026-09-23.md).
This shorter queue is the autonomous engineering order; external validation
and organizational decisions stay in the full register until their evidence
exists.

1. Add a revision-bound, four-eyes tenant deletion execution path that consumes a current offboarding assessment and refuses stale exports, legal holds, or unresolved lifecycle work.
2. Add asynchronous, permission-checked, watermarked exports for large reports.
3. Add cursor pagination for long operation timelines and remaining high-volume audit/governance lists.
4. Add live-region status updates to every remaining asynchronous admin action.
5. Run the security workflows in GitHub and resolve real CodeQL, dependency, secret, and container findings.
6. Complete manual accessibility, onboarding, pilot, and go/no-go validation with the user.

## Completed recently

- Add cooperative cancellation for directory sync runs, HR person imports, and provisioning runs. Each run carries an explicit, constraint-checked cancellation state (`requested` → `cancelled`, or `moot` when the run finished before observing it) with requester and timestamps; an audited `POST …/cancel` action uses the same permission that applies the run. Queued and review-pending runs cancel immediately (abandoned changes are marked with the reason, open duplicate reviews close, and revocation orders a cancelled provisioning plan carried are re-opened); reading and applying runs stop at checkpoints between items — never between a provisioning action's `in_flight` marker and the target's answer — leaving every applied item recorded and the run an honest, reviewable partial. Cancelled runs cannot be applied. The three run pages offer a confirmed Cancel control with polite live status. Migration 83 applied to the scratch database; 284 focused core and database tests (13 new cancellation tests proving checkpoints stop between items), 150 focused API tests, 80 focused web tests, the full TypeScript build, and focused lint pass.
- Add a permission-checked tenant offboarding export artifact. The downloadable, versioned JSON document contains portable identity, organization, role, source, target, account, and entitlement data in stable order; it excludes vault ciphertext, password proofs, MFA and recovery material, tokens, private signing keys, and transient protocol artifacts by construction. A SHA-256 digest is returned both in the document and response header, while a permanent hash-chained audit receipt records the digest, exclusions, and per-section counts without duplicating the exported personal data into the audit log. Thirty-three focused core and API tests, the full TypeScript build, focused lint, and diff validation pass.
- Add a durable tenant-offboarding preflight. The `tenant.manage`-only API inventories key tenant record classes without decrypting secrets, refuses deletion readiness when an active legal hold or unresolved lifecycle operation exists, binds the exact assessment to a SHA-256 digest, and stores a permanent hash-chained audit receipt. No deletion path exists yet. Thirty focused core and API tests, the full TypeScript build, focused lint, and diff validation pass.
- Complete the account-profile data-minimization UI. The editor detects each personal-email template before save, names every receiving target attribute and its sensitive classification, requires a 20-character purpose locally, preserves the recorded reason, shows approval status and timestamp, and sends no incomplete approval request. The layout remains responsive and its inventory uses the shared table primitive. Nineteen focused web tests, the full TypeScript build, focused lint, and the Impeccable detector pass.
- Add the server-side data-minimization gate for target account profiles. Attribute templates that reference `person.personalEmail` are classified and blocked until the save carries a substantive purpose; accepted saves persist the reason, approving actor and timestamp, expose a structured sensitive-mapping inventory, and include the decision in audit evidence. Removing the sensitive mapping atomically clears the approval so stale purpose cannot authorize a future disclosure. The database constraint prevents partial approval evidence. Migration 82 applied successfully; 148 focused profile, API, and migration tests, the full TypeScript build, focused lint, and diff validation pass.
- Add field-level classification and least-privilege reads for private HR contact data. `personalEmail` is classified sensitive and omitted—not nulled—from person lists and detail responses unless the caller holds the new `identity.sensitive.read` permission, preventing unauthorized callers from learning whether a value exists. Personal-email correlation suggestions are protected by the same permission so the value cannot leak indirectly as a match reason; internal lifecycle/provisioning behavior remains intact. 140 focused RBAC, person, matching, and API tests, the full TypeScript build, focused lint, and diff validation pass.
- Complete the governed-reference-data console on the Sources page. Departments and locations each expose their enforcement state, responsive add form, allowed/inactive rows, enable/disable controls, accessible loading and error status, and a first-value empty state that makes the opt-in consequence explicit. Nine focused web tests, the full TypeScript build, focused lint, and the Impeccable detector pass.
- Add the server-side governed reference-data foundation for departments and locations: tenant-isolated catalogs, database kind constraints and RLS, normalized uniqueness, audited create/enable/disable APIs, and opt-in enforcement during HR preview. A field remains permissive until it has an active value; afterward, unapproved rows are withheld and recorded without turning them into false leavers. The migration applied successfully; 102 focused database, API, mapping, diff, and import tests, the full TypeScript build, and focused lint pass.
- Harden HR identity references at ingestion: duplicate employee identifiers now withhold every conflicting occurrence and protect already-owned people from false snapshot absence; manager identifiers must resolve within the source namespace or the same feed; and same-feed managers are resolved through durable source links during the ordered apply, without a second import. Focused person-source coverage (71 tests) and the full TypeScript build pass.
- Complete non-destructive duplicate-person governance: exact business-email matches block before creation under tenant RLS; the console shows incoming identities, survivor candidates, and affected person/contract changes; reviewed decisions can keep separate, skip, or create an audited reversible source link to a selected survivor. Link removal preserves both the Person and their contracts. No merge path exists.
- Durable per-target UTC maintenance-window enforcement, including cross-midnight intervals, database constraints, fail-closed configuration, target-console controls, and an audited confirmed-and-reasoned urgent-leaver-only exception surfaced directly in the run console.
- Per-target emergency external-write circuit breaker enforced before a provision run enters `applying`: audited stop reason and optional bounded expiry, a conspicuous operator-console state, no connector writes while active, and four-eyes resume by a different administrator. Reads, previews, and durable evidence remain available during containment.
- Target-specific retry limits are now visible and editable in the target console with a server-enforced range of 1–10 attempts. The connector contract uses a closed failure vocabulary: only transient and throttled outcomes retry; conflict, rejection, unauthorized, and not-found outcomes stop immediately. Exponential delay and throttle attempts/time remain platform-bounded.
- Per-target connector health history derived from durable evidence, with empty-day continuity and 7/30/90-day UTC views for connection failures, authentication failures, average/p95 latency, provisioning failures, unknown write outcomes, throttling, retries, and read-back completeness. The target editor fails closed when a rolling-upgrade API cannot supply the new contract.
- Durable lifecycle case management on the existing operation record: ownership, severity, due date, acknowledgement, automated escalation, operator notes, controlled resolution codes, reopening, actor attribution, append-only history, and audit events. The operation console exposes the full case trail and retention/legal holds preserve it with the operation.
- Audited, revision-bound document-driven Entra to native Entra migration. It preserves the target identifier, vault credential, schedule, profile, accounts, entitlements, rules, and run history; refuses non-Microsoft endpoints and stale previews; invalidates old readiness by changing the fingerprint; and is available as a preview/confirm workflow on the target page.
- Connector lifecycle catalog with adapter version, connector API compatibility, support state, rollout state, deprecation date, and contract-certification evidence. The API and target console expose the same authoritative record; Entra and HTTP remain visibly controlled/preview rather than overstated as generally supported.
- Shared connector certification runner covering connection, idempotent create/update/disable, observed-state verification, entitlement grant/revoke, and missing-object classification; native Entra, SCIM, disposable Samba/Active Directory, and document-driven HTTP fixtures pass it.
- HTTP connector documents now declare correlation and scalar/collection provenance read-back. Unsafe documents neither advertise nor execute account creation; exact action IDs are adopted and foreign collisions are refused.
- SCIM create idempotency: an exact action marker is adopted on retry, while a same-name foreign account is a conflict rather than a duplicate or silent takeover.
- Native Entra delayed read-back and manual-verification fallback.
- Explicit Graph application permissions per Entra capability.
- Verification-gated retry for ambiguous target outcomes.
- Database-backed employee work queue and 10,000-record query-plan rehearsal.
- Tenant-configurable lifecycle idempotency retention.
- Lifecycle legal holds with audited placement/release and retention enforcement.
- Legal-hold UI on operation timelines, including released-history visibility and preservation of linked receipts, observations, and delivery records.
- CI definitions for CodeQL, dependency audit/update, secret scan, SBOM, provenance, and image scan.
