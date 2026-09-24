# Syntra enterprise-readiness backlog

Updated 23 September 2026. This is the current gap register for taking Syntra
from a strong development build to a supportable enterprise product. It is
based on the repository, the pilot evidence, the operating runbooks, and the
continuous-improvement backlog. It is not a claim that Syntra is production
certified.

## How to read this list

- **Build** — product or deployment engineering is still required.
- **Validate** — the control exists, but needs evidence from realistic or
  independent infrastructure.
- **Decide** — an accountable owner must approve policy, risk, or scope.
- **Operate** — repeatable evidence must be collected after every release or
  on a schedule.

Priorities are **P0** (pilot blocker), **P1** (required before broad
production), **P2** (required for mature enterprise operation), and **P3**
(later differentiation). An item is complete only when its acceptance evidence
is retained; merged code alone is not enough.

## P0 — controlled-pilot blockers

1. **Validate — Native Entra direct membership.** Create two disposable
   security groups; prove add, observed membership, remove, and observed
   absence with retained operation evidence.
2. **Validate — Native Entra least privilege.** Run every advertised Entra
   capability with only its documented Microsoft Graph application
   permissions and retain the consent/readiness record.
3. **Build — Shared connector certification kit.** Make every adapter pass the
   same create/update/disable/entitlement/read-back, idempotency, throttling,
   ambiguity, and secret-rotation contract where it advertises support.
   The shared lifecycle/read-back runner now passes against native Entra,
   SCIM, disposable Samba/Active Directory, and document-driven HTTP. HTTP
   creation is advertised and executed only when the document declares
   correlation plus scalar or collection provenance read-back.
4. **Build — Connector release metadata.** Persist adapter version, support
   tier, compatibility range, rollout state, deprecation date, and last
   certification result. The authoritative connector catalog, API response,
   and target console now expose this record; native Entra and document-driven
   HTTP are deliberately marked preview/controlled.
5. **Build — Legacy Entra migration.** Add an audited preview/apply workflow
   from document-driven Entra targets to native Entra without duplicating
   accounts, secrets, or entitlements. Implemented in place with a revision
   check, dedicated audit receipt, preserved linked state and credential, and
   an operator preview/confirmation panel.
6. **Validate — End-to-end joiner canary.** Run one approved synthetic hire
   from HR input through durable operation, Entra write, read-back, receipt,
   notification, and audit export.
7. **Validate — End-to-end mover canary.** Prove revision-bound preview,
   add/retain/remove decisions, approvals, target updates, and exact read-back.
8. **Validate — End-to-end leaver canary.** Prove urgent disable, session
   revocation, entitlement removal, escalation, and bounded manual fallback
   during a simulated Graph outage.
9. **Decide — Pilot scope.** Name the tenant, department, canary population,
   permitted capabilities, external-write window, rollback owner, and stop
   conditions.
10. **Decide — Production owners.** Assign accountable owners for platform,
    HR data, identity security, connectors, incidents, privacy, and business
    approval; configure their escalation paths.
11. **Validate — Backup on a second host.** Restore a non-empty encrypted
    backup onto independent infrastructure and reconcile people, contracts,
    operations, vault rows, and migration state.
12. **Validate — Master-key rotation drill.** Exercise dual-key rewrap,
    readiness verification, cutover, rollback, and evidence retention in a
    staging copy with the deployment's actual secret provider.
13. **Decide — Retention and legal hold.** Privacy/legal owners approve each
    record class, deletion window, legal-hold authority, export policy, and
    audit checkpoint procedure.
14. **Validate — Accessibility pilot journeys.** Complete keyboard,
    screen-reader, 200% zoom, reduced-motion, narrow-width, focus-return, and
    live-status tests for joiner, mover, leaver, approvals, and retry.
15. **Validate — Release security gates.** Run CodeQL, dependency audit,
    secret scanning, SBOM/provenance, and container scanning on the hosted CI
    system; triage findings with documented exceptions and expiry dates.
16. **Decide — Go/no-go.** Record a signed change approval referencing the
    evidence above, residual risks, monitoring window, and rollback decision.

## P1 — identity, connector, and lifecycle safety

17. **Build — Connector conformance fixtures.** Provide disposable AD, SCIM,
    HTTP, and Graph test environments with deterministic reset and seeded
    identities.
18. **Build — Capability enforcement.** Refuse plans that request capabilities
    not certified for the exact adapter version and target configuration.
    **Implemented:** catalog releases carry a per-version certified-capability
    list; every planned connector action is checked against it and against the
    target's advertised capabilities at preview and again at apply. Refused
    actions stay visible in the plan with status `refused` and a reason, the
    run records the adapter version and a refusal summary, and nothing refused
    is attempted. See `docs/connectors/certification-and-rollout.md`.
19. **Build — Connector health history.** Chart authentication failures,
    throttling, latency, retries, ambiguous writes, and read-back completeness
    per target and adapter version.
    **Implemented per target:** the console exposes 7/30/90-day UTC series
    derived from readiness checks, provision actions, retry counts, unknown
    in-flight writes, and lifecycle observations. Exact historical attribution
    to an adapter version still requires version snapshots on operation rows.
20. **Build — Configurable bounded retries.** Allow target-specific policies
    only within safe platform limits and never retry closed error classes.
    **Implemented:** each target has an operator-visible 1–10 attempt limit;
    exponential waits are capped, throttling has independent attempt and time
    budgets, and only the closed `transient`/`throttled` classes retry.
21. **Build — Maintenance windows.** Defer non-urgent writes visibly and allow
    urgent leavers through an explicitly approved exception path.
22. **Build — External-write circuit breaker.** Add tenant and target stops,
    reviewed resume, reason, expiry, notifications, and immutable audit trail.
    **Implemented:** tenant and target stops share one apply-boundary guard
    with an audited reason, optional expiry of at most 30 days, and four-eyes
    resume; a minute-level sweep closes expired stops, and every pause,
    resume, and expiry is a security event delivered to endpoints subscribed
    to the Emergency write stops webhook group.
23. **Build — Dead-letter case management.** Add owner, severity, due date,
    acknowledgement, notes, escalation history, evidence, and resolution code.
    **Implemented:** lifecycle operations now retain assignment,
    acknowledgement, automated escalation, operator-note, resolution, and
    reopening events; resolution uses a controlled code and audited actor,
    and the operator console exposes the append-only case trail.
24. **Build — Reconciliation campaigns.** Compare desired and observed state
    in bounded batches without mutating targets; require review before repair.
25. **Build — Drift policy.** Classify benign, managed-field, entitlement,
    security-critical, and ownership drift with different response rules.
26. **Build — Account correlation review.** Surface weak, conflicting, and
    duplicate matches; never merge or take ownership automatically.
27. **Build — Source conflict workflow.** Let owners resolve contradictory HR
    sources with provenance and a before/after preview.
28. **Complete — Duplicate-person review.** Exact business-email matches create
    a durable tenant-isolated review before person creation. The console shows
    survivor candidates and affected changes; decisions can keep separate,
    skip, or add an audited reversible source link. Removing the link preserves
    the person and contracts, and no automatic or destructive merge path exists.
29. **Build — Reference-data governance.** Validate department, manager,
    location, employer, role, and employee identifiers against owned catalogs.
30. **Build — Sensitive mapping controls.** Classify HR attributes, require
    approval for sensitive target mappings, and report unnecessary disclosure.
31. **Build — Separation-of-duties rules.** Prevent users from requesting,
    approving, executing, and closing the same privileged change.
    **Implemented (first classes):** a tenant-configurable policy holds
    privileged role grants, admin-scoped token minting, authentication-policy
    relaxation and webhook endpoint changes as revision-bound change requests;
    a different, stepped-up administrator approves and approval applies; the
    requester can only withdraw; 72-hour expiry; every step audited and in the
    Privileged access webhook group. Federation configuration and target
    credentials are not yet covered (configure.md).
32. **Build — Emergency-access lifecycle.** Time-bound elevation, explicit
    reason, second-person review, continuous alerting, automatic expiry, and
    post-event review.
    **Implemented:** designated emergency accounts with a sealed offline
    recovery credential; session-less activation with a mandatory reason,
    announced at once by mail to every `tenant.manage` holder and by the
    Privileged access webhook group, effective after a tenant delay unless
    cancelled or on a second administrator's stepped-up approval; sign-in still
    through `authorize()` with only the WebAuthn-console requirement lifted;
    15–240 minute automatic expiry; a post-event review a different
    administrator must complete; a console banner while active. Threat model
    in configure.md. Needs a tabletop drill with the user.
33. **Build — Certification-aware rollout.** Canary new connector versions by
    target and support immediate rollback without changing stored intent.
    **Implemented:** per-target channel (`stable`/`canary`) and exact-version
    pin, a recorded certified rollback point, and an audited, permission-checked
    rollback that changes only the adapter selection; a run previewed under a
    different release refuses to apply. Deprecated or uncertified releases are
    readiness warnings; past the deprecation date new writes stop unless an
    audited, version-bound override of at most 30 days is active. Target-page
    console panel. Only one release per adapter ships today, so a real canary
    still needs a second implementation registered in the connector registry.
34. **Build — Credential lifecycle.** Expiry discovery, advance alerts,
    rotation workflow, dual-secret overlap, verification, revocation, and
    evidence for every connector type.
    *Built (2026-09-23): a tenant credential inventory (**Settings →
    Credentials**, `GET /api/admin/credentials`) with expiry source, last
    rotation and owner for every credential Syntra holds or depends on;
    optional Entra expiry discovery gated on `Application.Read.All`; declared
    expiry for the rest; a daily, de-duplicated expiry scan raising
    `credential.expiring`/`credential.expired` at configurable thresholds by
    webhook and mail, and an incident on expiry; and a dual-secret rotation
    workflow (stage, verify, cut over, complete or roll back) for target,
    directory-source and HR-feed credentials with audited evidence
    ([Configure](configure.md#credentials-and-security-notifications)).
    Remaining: revocation at the issuer is still the administrator's step
    (Syntra holds no permission to delete an Entra secret), upstream client
    secrets have no rotation workflow, and discovery exists only for Entra.*
35. **Build — Entitlement risk metadata.** Mark privileged, birthright,
    dynamic, nested, license-bearing, and externally managed access.
36. **Build — Access review campaigns.** Manager/application-owner review,
    delegation, reminders, decisions, revocation execution, read-back, and
    immutable completion evidence.

## P1 — platform security and tenant isolation

37. **Build — Formal threat model.** Cover admin/API auth, SAML/OIDC/SCIM,
    connector egress, webhooks, imports, exports, queues, vault, and support
    access; review it for every architectural change.
38. **Validate — Independent penetration test.** Include tenant escape,
    authorization, injection, SSRF/DNS rebinding, protocol attacks, upload
    handling, rate limits, and business-logic abuse; retest fixes.
39. **Build — Tenant-isolation test suite.** Generate cross-tenant identifiers
    for every API and background job path and prove reads and writes fail
    closed.
40. **Build — Database isolation defense.** Evaluate PostgreSQL row-level
    security or an equivalent independently enforced boundary for all tenant
    data.
41. **Build — Field-level authorization.** Restrict sensitive HR, identity,
    recovery, and connector-secret metadata independently of page access.
42. **Build — Support-access controls.** Just-in-time, tenant-approved,
    time-bound impersonation/support sessions with reason, recording, and
    customer-visible audit.
43. **Build — Session hardening.** Device/session inventory, configurable idle
    and absolute timeouts, risk-triggered revocation, secure cookies, and
    administrator mass-revoke.
44. **Build — Phishing-resistant admin MFA.** Require WebAuthn/passkeys or an
    equivalent strong factor for privileged roles and recovery actions.
45. **Build — Administrative federation.** Production-grade SAML/OIDC setup,
    metadata/key rollover, group/role mapping, break-glass fallback, and
    tenant lockout prevention.
46. **Build — Network policy.** Document and enforce ingress, connector egress,
    proxy trust, private-address exceptions, DNS behavior, TLS floors, and
    certificate rotation.
47. **Build — Key-management integration.** Support a selected KMS/HSM or
    external secret provider with envelope encryption, key versioning, access
    logs, and tested revocation.
    *Built (2026-09-23): `MASTER_KEY_PROVIDER=local|vault-transit|aws-kms`,
    validated at boot, with tenant-bound data keys, a bounded unwrap cache
    with documented outage behaviour, a `key-management` readiness probe, and
    `pnpm rekey` for local-to-KMS migration and rotation. Revocation (token
    revoke, `min_decryption_version`, disabled KMS key) is tested against a
    real Vault dev server and an in-memory KMS; access logs are the KMS's own
    (configure.md, "Who logs what"). Remaining: choosing the organisation's
    provider, a staging drill against it (#12), a LocalStack/real-AWS test,
    and Azure Key Vault.*
48. **Build — Secure export service.** Permission recheck at execution and
    download, asynchronous generation, encryption, watermark, expiry,
    revocation, and full audit history. *Engineering slice done:* one
    asynchronous service for the audit log and the Governance access report —
    authority checked at request, at generation and at download (including a
    changed Govern scope), batched generation, envelope-sealed storage with a
    SHA-256 digest, a per-export watermark, a 1–72 hour expiry with a sweep,
    revocation, and an audit event for every step
    ([Operate, Exports](operate.md#exports)). The security notification group
    for export creation is done (#52, the Data exports webhook group).
    Remaining: an external object store for files beyond 64 MiB, and moving
    the remaining synchronous reports.
49. **Operate — Dependency governance.** Automated updates, supported-runtime
    policy, license inventory, vulnerability SLA, exception owner, and expiry.
50. **Operate — Secure development evidence.** Protected branches, required
    reviews, signed/provenance-linked releases, CI isolation, and annual access
    review for repositories and registries.
51. **Build — Abuse protection.** Tenant-aware API limits, import bounds,
    decompression limits, pagination caps, queue quotas, and clear 429/retry
    behavior.
52. **Build — Security notification policy.** Define customer-visible alerts
    for credential changes, role grants, break-glass use, export creation,
    circuit-breaker changes, and suspicious authentication.
    *Built (2026-09-23): six categories defined once in code and rendered as
    the policy table in [Configure](configure.md#the-security-notification-policy);
    every event is a webhook security event, and a tenant setting (**Settings
    → Security alerts**) chooses which categories also email `tenant.manage`
    holders. Gaps closed: `credential.changed`, `signing_key.rotated`, an
    audited HR-feed credential change, and a Data exports webhook group.
    Remaining: there is no break-glass account type to alert on (the policy
    points at `auth.elevate`), and no per-recipient channel beyond mail.*

## P1 — reliability, recovery, and operability

53. **Decide — Service objectives.** Set availability, lifecycle latency,
    urgent-leaver latency, recovery, durability, and support-response targets
    with measurement definitions.
54. **Build — SLO dashboards.** Measure success and latency from durable
    operation timestamps, not process uptime alone; expose error budgets.
55. **Build — End-to-end tracing.** Correlate HR event, operation, job,
    connector request, observation, notification, and audit event without
    logging secrets or excess personal data.
    **Implemented:** every request and job runs under a correlation id that is
    returned as `x-correlation-id`, stamped on every log line, carried through
    pg-boss payloads across job hops, and recorded on audit events
    (`AuditEvent.correlationId`, outside the hash chain, format-constrained,
    filterable). Optional OpenTelemetry (off unless
    `OTEL_EXPORTER_OTLP_ENDPOINT` is set; not loaded when off) traces HTTP
    requests, job execution parented on the enqueuer, connector operations,
    outbound `guardedFetch` calls and, opt-in, Prisma; span attributes pass
    the same redaction rules. Remaining: webhook/notification delivery is
    correlated through its job but has no dedicated span, and raw `pg` and
    pg-boss polling queries are not traced.
56. **Build — Structured redaction.** Centralize safe error serialization and
    test logs, traces, metrics labels, exports, and support bundles for secret
    and personal-data leakage.
    **Implemented for logs, traces and metrics labels:** one rule set and one
    application logger (safe error serializer, redacting formatter, message
    scrubbing, pino `redact` paths) with tests that push connector errors
    carrying `Authorization` headers, LDAP bind errors with DN and password,
    and person/vault/MFA context through the real logger and a real span
    exporter and assert nothing sensitive survives; metrics labels are pinned
    to a closed set. Support bundles (#64) are routed through the shared
    rules. Remaining: other exports are not (the offboarding export excludes
    secrets by construction), and client addresses are deliberately kept on
    request log lines.
57. **Build — Queue recovery controls.** Detect orphaned, stuck, duplicated,
    delayed, poisoned, and saturation-deferred jobs; keep repair idempotent.
    **Implemented:** a tenant-scoped job-health report compares sync, HR
    import, provisioning, person target operations, exports and lifecycle
    operations with pg-boss's table and the clock; audited, idempotent
    `requeue`, `mark_failed` and `release_lease` repairs reuse the existing
    recovery and cancellation semantics and never re-run a connector write
    (unknown outcomes stay for `resolveInFlightActions`). Console Operations
    page, `syntra_job_health_findings{kind,finding}`, six alert rules and a
    runbook. Remaining: lifecycle operations and sync/HR applies (no
    heartbeat) are reported but repaired from their own pages; pg-boss jobs
    themselves are never cancelled or deleted from here; a heartbeat for
    sync/HR applies would let them be judged like provisioning.
58. **Build — Cooperative cancellation.** Add explicit cancellation states and
    checkpoints to imports, syncs, simulations, exports, and provisioning runs.
59. **Build — Graceful deployment behavior.** Drain workers, preserve leases,
    complete or safely resume operations, and prove rolling upgrades under
    load.
60. **Build — Database migration safety.** Add expand/contract enforcement,
    forward/backward compatibility tests, runtime checks, lock-time budgets,
    and rollback decision records.
61. **Validate — Disaster-recovery exercise.** Run region/host-loss scenario,
    restore service within approved RTO/RPO, reconcile external state, and
    retain the timeline.
62. **Validate — Incident tabletops.** Exercise expired Entra secret, Graph
    outage, broad mover rule, compromised admin, audit-integrity alert, queue
    saturation, and urgent leaver during recovery.
63. **Build — Customer-safe status reporting.** Separate component health,
    tenant degradation, stale readiness, and connector outages without leaking
    another tenant's activity.
    **Implemented:** `GET /api/admin/status` (shared API, database, queue, key
    provider and SMTP health, then this tenant's write stops, stale or
    failing readiness, connector outages by error class and job findings;
    no queue depth or other cross-tenant quantity) and an operator-only
    `GET /api/admin/deployment/status` (`deployment.manage`; counts only, no
    tenant named), shown on the console's Operations page. Remaining: no
    public or unauthenticated status page, and no history of past incidents.
64. **Build — Operational support bundle.** Produce a tenant-scoped, redacted,
    time-bounded evidence package with configuration fingerprints and no
    credentials.
    **Implemented:** a `support_bundle` kind of the secure export service
    (`tenant.manage`, window of at most seven days fixed at request, sealed,
    watermarked, requester-only, audited): versions, migration state,
    settings and configuration fingerprints, write stops, connector
    readiness, job health, recent failures by error class and audit event
    counts, built by allow-list and passed through the shared redaction
    rules, with a test seeding secrets and personal data. Remaining:
    installation-level log excerpts are not included (logs stay with the
    operator), and there is no signed attestation of the bundle beyond its
    recorded SHA-256.
65. **Operate — Capacity management.** Forecast database, queue, audit,
    notification, and connector load; define scale thresholds and ownership.
66. **Operate — Restore verification.** Automatically restore sampled backups,
    run integrity/reconciliation checks, alert on failure, and retain evidence.
67. **Operate — Certificate and domain lifecycle.** Inventory expiry,
    ownership, renewal, validation, and emergency replacement for every public
    endpoint and federation key.
    *In-product part built (2026-09-23): the credential inventory lists every
    federation key and certificate a tenant uses — Syntra's SAML/OIDC signing
    keys, upstream IdP certificates, trusted service-provider certificates —
    with expiry, owner and advance alerts. Remaining (operational): the public
    endpoints' TLS certificates and domains live outside Syntra (ingress,
    load balancer, DNS) and need the deployment's own monitoring, renewal
    ownership and an emergency-replacement drill.*
68. **Operate — On-call readiness.** Rotations, escalation, alert routing,
    runbook access, authority boundaries, and quarterly effectiveness review.

## P1 — privacy, compliance, and auditability

69. **Build — Data inventory.** Map each personal, credential, operational,
    and audit field to purpose, source, processor, residency, retention, and
    access roles. *Engineering slice done:* every column classified in code
    (`packages/core/src/privacy/inventory.ts`), a structural test that fails
    on an unclassified column, and the generated
    [data inventory](privacy/data-inventory.md). Legal bases are placeholders
    awaiting the controller's decision (#13, #79).
70. **Build — Data-subject workflows.** Search, export, correction, restriction,
    and deletion with identity verification, legal-hold refusal, and evidence.
    *Engineering slice done:* privacy cases with verification attestation and
    due dates, inventory-driven search and sealed access bundle, rectification
    through the normal edit paths, restriction honoured by provisioning,
    imports and sync, and a four-eyes, hold-refusing erasure that pseudonymises
    in place with a receipt ([Operate, Data-subject requests](operate.md#data-subject-requests)).
    Legal review of what is retained (the audit record) remains.
71. **Build — Tenant export and deletion.** Full portable export, two-person
    destructive approval, dependency preview, cryptographic erasure strategy,
    completion proof, and backup-expiry treatment. *Engineering slice done:*
    revision-bound, four-eyes, cooling-off deletion with crypto-erasure,
    tombstone and receipt ([Operate, Tenant deletion](operate.md#tenant-deletion)).
    External validation (restore drill against a deleted tenant, legal review
    of the retained audit record) remains.
72. **Build — Audit-integrity monitoring.** Schedule chain/checkpoint
    verification, alert on gaps or mutation, and document independent evidence
    retention.
73. **Build — Audit search at scale.** Server-side filters, cursor pagination,
    actor/resource/correlation search, saved views, and bounded export.
    *Engineering slice done:* server-side actor, action-prefix, target,
    outcome, time-window and subject filters with keyset pagination on
    `sequence`, a page cap of 200, supporting indexes whose plans are asserted
    at 100,000 events, per-administrator saved searches, and "export these
    results" through the secure export service
    ([Operate, Audit search](operate.md#audit-search)). The log records no
    correlation id, so none is searchable. Remaining: per-page chain
    verification still walks the whole log, and a plan rehearsal at
    production-sized history.
74. **Build — Audit schema governance.** Version events, define required
    fields, prohibit secrets, preserve actor and delegation context, and test
    coverage of privileged actions.
75. **Decide — Data residency.** Define supported regions, replication,
    subprocessors, support access, telemetry routing, and backup location.
76. **Decide — Compliance target.** Choose the actual assurance path (for
    example SOC 2 Type II and applicable privacy obligations) instead of
    presenting controls as certification.
77. **Operate — Evidence collection.** Automate control evidence for access
    review, backups, restores, security scans, incidents, releases, retention,
    and change approvals.
78. **Operate — Vendor management.** Maintain subprocessor inventory,
    security reviews, data-processing terms, incident obligations, and exit
    plans.
79. **Operate — Privacy review.** Perform DPIA/privacy impact assessment for
    HR ingestion, automated access decisions, monitoring, exports, and support
    access.
80. **Operate — Policy lifecycle.** Owners and review dates for security,
    privacy, retention, incident response, business continuity, change
    management, vulnerability management, and acceptable use.

## P2 — scale, usability, and product administration

81. **Build — Complete high-volume pagination.** Audit every remaining admin
    and governance list; replace unbounded reads and client-side unions.
82. **Build — Saved filters and queues.** Let operators share scoped views for
    overdue departures, blocked access, manual verification, and dead letters.
83. **Build — Safe bulk actions.** Preflight authorization and impact, preserve
    per-item results, support partial failure, and require step-up for high
    impact.
84. **Build — Large import pipeline.** Streaming validation, resumable upload,
    row-level errors, deduplication, cancellation, quarantine, and safe retry.
85. **Build — Searchable entitlement catalog.** Permission-aware search,
    paging, selected-value persistence, risk labels, ownership, and stale-cache
    indication.
86. **Build — Internationalization completion.** Externalize remaining strings,
    locale-aware date/number formatting, long-text layouts, RTL assessment,
    and translated error/live-status messages.
87. **Validate — Accessibility conformance.** Test against the chosen WCAG
    target, remediate findings, publish limitations, and repeat each major
    release.
88. **Build — Guided enterprise onboarding.** Preflight environment,
    federation, roles, HR source, target, mappings, simulation, canary, and
    go-live with retained evidence and explicit blockers.
89. **Build — Configuration promotion.** Export/review/promote non-secret
    configuration across environments with stable IDs, diff, validation,
    approval, and rollback.
90. **Build — Policy-as-code support.** Version lifecycle and access policies,
    validate syntax/semantics, simulate against fixtures, review diffs, and
    roll back safely.
91. **Build — Notification delivery adapters.** Production email first, then
    optional enterprise channels; templates, tenant branding, throttling,
    bounce/failure handling, opt-out rules, and delivery monitoring.
92. **Build — Product diagnostics.** Explain why a person received or lost
    access using source facts, policy version, approvals, connector result, and
    observations.
93. **Build — Delegated administration.** Scope operators by department,
    target, application, or region while preserving central audit and
    separation of duties.
94. **Build — License governance.** Track license-bearing entitlements,
    availability, assignment failure, reclamation, and cost-owner evidence.
95. **Validate — Multi-tenant performance.** Test noisy-neighbor behavior,
    fairness, connection-pool pressure, queue isolation, and storage growth
    across realistic tenant shapes.
96. **Validate — Long-duration soak.** Run mixed hire/mover/leaver, imports,
    sync, reconciliation, exports, and outages for days; measure leaks,
    backlog recovery, and data consistency.

## P2 — commercial supportability

97. **Decide — Supported deployment model.** Define cloud/self-hosted scope,
    supported databases, proxies, browsers, regions, upgrade paths, and end of
    life policy.
98. **Build — Upgrade readiness report.** Detect incompatible configuration,
    deprecated connectors, pending migrations, insufficient capacity, and
    rollback prerequisites before deployment.
99. **Build — Tenant administration APIs.** Versioned, documented, scoped,
    rate-limited APIs with idempotency, consistent errors, deprecation policy,
    and generated client examples.
    *Foundation in place:* all 305 `/api/admin` routes are published as a
    versioned OpenAPI 3.1 description. It is served at `GET /api/openapi.json`
    and committed as `docs/api/openapi.json`, with a CI freshness check. For
    every operation the description derives the required permission and
    whether a machine token may call it from the live guards. A test fails
    when a route has no description. Deprecation (a six-month minimum, enforced
    by test) is sent as `Deprecation`/`Sunset` response headers. The
    versioning, error, idempotency, rate-limit and client-generation
    conventions are in [docs/api/README.md](api/README.md).
    *Still open:*
    - response-body schemas for most operations;
    - a general `Idempotency-Key` for POSTs, which only onboarding and
      provision receipts have today;
    - per-token rate limits on ordinary admin reads and writes;
    - a distinct problem type for `429`.
100. **Build — Webhook reliability contract.** Signed payloads, replay
     protection, delivery attempts, ordering semantics, rotation, test event,
     dead-letter handling, and customer-visible status.
101. **Operate — Release train.** Semantic/version policy, changelog, upgrade
     notes, migration timing, security advisories, support windows, and tested
     rollback for every release.
102. **Operate — Customer support model.** Severity definitions, response
     targets, escalation, safe diagnostic access, communication templates, and
     incident review sharing.
103. **Operate — Compatibility matrix.** Track browsers, identity providers,
     connector versions, directory versions, APIs, and known limitations.
104. **Operate — Product documentation QA.** Test installation, configuration,
     recovery, connector, and API instructions from clean environments on each
     release.
105. **Decide — Service terms.** Availability commitments, maintenance,
     security responsibilities, data processing, support, limits, and exit
     assistance must match measured capabilities.
106. **Decide — Responsible automation policy.** Define which lifecycle
     decisions may be automatic, which require approval, and how customers can
     inspect, override, and appeal outcomes.

## P3 — later enterprise differentiation

107. **Build — Entra application-role assignments.** Treat app roles separately
     from groups with dedicated discovery, risk, write, and read-back contracts.
108. **Build — Microsoft 365 adapter.** Establish the capability contract and
     disposable-tenant certification before presenting it as supported.
109. **Build — Additional connector SDK.** Versioned schemas, test kit,
     sandbox, signing, review requirements, and compatibility guarantees for
     third-party adapters.
110. **Build — Event-stream integration.** Durable, versioned lifecycle and
     audit events with replay, partitioning, tenant isolation, and documented
     delivery semantics.
111. **Build — Advanced access analytics.** Explainable recommendations for
     anomalous or unused access that never auto-revoke without configured
     governance.
112. **Build — Regional failover.** Only after single-region restore and
     reconciliation are repeatedly proven; define consistency and connector
     write ownership during failover.

## Recommended execution order

The autonomous improvement loop should take the first safe engineering item
whose prerequisites exist. The current order is:

1. Shared connector certification kit (item 3).
2. Connector release metadata and enforcement (items 4 and 18).
3. Legacy-to-native Entra migration (item 5).
4. Dead-letter case management (item 23).
5. Connector health history and bounded retry policy (items 19 and 20).
6. External-write circuit breaker and maintenance windows (items 21 and 22).
7. HR conflict, duplicate-person, and reference-data governance (items 27–29).
8. Sensitive mapping controls and field-level authorization (items 30 and 41).
9. Tenant export/deletion and privacy workflows (items 70 and 71).
10. Cooperative cancellation and remaining high-volume pagination (items 58
    and 81).

Items requiring external infrastructure or accountable approval remain visible
but must not be silently marked complete by an automated pass.
