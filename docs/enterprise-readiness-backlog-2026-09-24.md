# Syntra enterprise-readiness backlog — 24 September 2026

This supersedes the gap list in
[the 23 September register](enterprise-readiness-backlog-2026-09-23.md) as the
place to start. That register keeps its item numbers and per-item notes; this
one says what is left after three engineering batches, what those batches
found, and what only people and infrastructure can close. It is not a claim of
production certification.

Status words: **Build** (engineering remains), **Validate** (the control
exists; evidence from real infrastructure or an independent party is
missing), **Decide** (an accountable owner must choose), **Operate** (must be
repeated on a schedule, with evidence kept).

## What changed since the 23 September register

Built, tested and merged or in review (PRs #13, #14 and the batch-3 branch):

| Area | Register items |
|---|---|
| Tenant-wide external-write stop, notifications | #22 |
| Tenant session lifetimes, mass revoke, WebAuthn-only console | #43, #44 |
| Four-eyes tenant deletion with crypto-erasure | #71 |
| Cooperative cancellation of runs | #58 |
| Production Helm chart, HA Postgres/PgBouncer guidance, multi-replica safety | #46 (part), #59 (part) |
| Capability enforcement, canary/pin/rollback of connector releases | #18, #33 |
| Published OpenAPI 3.1 document with coverage and freshness gates | #99 (foundation) |
| Correlation ids, OpenTelemetry, central redaction | #55, #56 |
| Vault Transit and AWS KMS master-key providers, `pnpm rekey` | #47 |
| Sealed, watermarked async exports; server-side audit search | #48, #73 |
| Generated cross-tenant isolation probe (408 routes, 25 jobs) | #39 |
| Separation of duties for privileged changes; break-glass | #31, #32 |
| Credential inventory, expiry alerts, rotation; security notification policy | #34, #52, #67 (in-product) |
| Queue recovery, tenant status, redacted support bundle | #57, #63, #64 |
| Data inventory with schema-drift test; data-subject requests | #69, #70 |

Defects the batches found and fixed: cross-tenant references on ten write
paths, routes ignoring a parent id, remove routes auditing success for foreign
ids, a Govern read guard that ignored token scopes, missing RLS on two
lifecycle tables, a non-recomputable export digest, SCIM rejecting
`application/scim+json`, an idempotency 500, and ReDoS-prone regexes.

## Immediate — before the batch-3 changes can merge

1. **Done — batch-3 push.** Push protection flagged a fake `sk_live_…`
   redaction-test input; the unpushed history was rewritten so the fixture
   builds it at runtime, and the branch was pushed.
2. **Done — SCIM entitlements.** `manageEntitlements` for `scim2` now
   matches the implemented, certified grant/revoke, so enforcement no longer
   refuses SCIM grants.
3. **Operate — migrate local and lab databases.** Thirteen new migrations
   (`20261023…` to `20261104…`); run `pnpm db:migrate` with the root
   `DATABASE_URL` and restart the API.
4. **Build — flaky timing test.** `govern/graph.test.ts` "costs almost
   nothing per rule" exceeds its 5 s budget under a loaded local run (passes
   alone and in CI). Measure CPU time rather than wall time, or run it
   serially.

## P0 — pilot blockers that need people or real infrastructure

Unchanged in substance; engineering cannot close these.

5. **Validate — Entra** direct membership and least-privilege runs in the
   disposable tenant (register #1, #2).
6. **Validate — joiner, mover and leaver canaries** end to end, including the
   Graph-outage leaver (#6–#8).
7. **Validate — backup restore on a second host** and a **master-key rotation
   drill** — now including a `local → vault-transit` or `aws-kms` rekey with the
   deployment's real provider (#11, #12).
8. **Validate — AWS KMS against real AWS** (only an in-memory KMS has been
   exercised) and the chart's **multi-replica** deployment on a real cluster
   with two API pods (new).
9. **Validate — accessibility** of the pilot journeys, including the new
   Change control, Break-glass, Credentials, Operations and Privacy screens
   (#14).
10. **Validate — security gates.** CodeQL, dependency, secret and container
    scans now run and pass on PRs; triage policy with owners and expiry is
    still needed (#15).
11. **Validate — break-glass tabletop.** Designate, activate with delay,
    approve early, expire, review — with the people who would do it (new).
12. **Decide — pilot scope, production owners, retention and legal hold,
    go/no-go** (#9, #10, #13, #16).
13. **Decide — legal bases and DPIA.** The data inventory carries placeholder
    legal bases per area; the controller must fill them (#13, #79).
14. **Decide — KMS-outage readiness policy.** Today a key-provider outage
    marks every replica not-ready even while cached keys still serve reads.
    Confirm or change it.

## P1 — engineering still open

Identity, connectors and lifecycle:

15. **Build — reconciliation campaigns and drift policy** (#24, #25).
16. **Build — account-correlation review** and **HR source-conflict
    workflow** (#26, #27).
17. **Build — entitlement risk metadata** and **access-review campaigns**
    beyond Govern's recertification (#35, #36).
18. **Build — change control for SSO/federation and target-credential
    changes** — the two classes #31 does not cover yet — and let approvers
    without `tenant.manage` reach the Change control tab.
19. **Build — heartbeat for sync and HR applies** so queue recovery can repair
    them as it repairs provisioning (#57 follow-up), and surface job findings
    in the Attention list.
20. **Build — connector follow-ups:** in-flight resolution should honour a
    target's pinned adapter release; audit a deprecation override's expiry; a
    real second adapter release to exercise canaries; issuer-side revocation
    of rotated secrets; rotation for upstream IdP client secrets; expiry
    discovery beyond Entra.
21. **Build — per-tenant sweeps for tenants created at runtime.** Write-stop
    expiry, export sweep, credential scan and lifecycle maintenance are
    scheduled per tenant at boot; a tenant created later waits for a restart.

Platform security and isolation:

22. **Build — database-level same-tenant references** (#40). The probe found
    ten paths where RLS let a row reference another tenant's row; the code now
    refuses them, but a trigger or composite foreign keys would make it a
    database guarantee. Measure against the bulk-insert paths first.
23. **Build — support-access controls** (#42) and **administrative federation
    hardening** — SAML key rotation, metadata rollover, role mapping (#45).
24. **Build — abuse protection:** per-token rate limits, a proper `429`
    problem type, an `Idempotency-Key` header, import and pagination caps
    (#51, #99 follow-up).
25. **Validate — formal threat model and independent penetration test**
    (#37, #38). The isolation probe and CodeQL are inputs, not substitutes.
26. **Build — NetworkPolicy egress by destination.** The chart limits connector
    egress by port only, because NetworkPolicy cannot match hostnames; an
    egress proxy or CNI FQDN policy is needed for a real allow-list (#46).

Reliability and operability:

27. **Decide, then Build — service objectives and SLO dashboards** from
    durable operation timestamps (#53, #54).
28. **Build — incremental audit-chain verification.** Every audit page still
    walks the whole hash chain; use Govern's checkpointed verification so page
    latency does not grow with the log (#73 follow-up).
29. **Build — migration safety:** expand/contract enforcement, lock-time
    budgets, rolling-upgrade tests under load (#59, #60).
30. **Build — tracing gaps:** webhook and notification delivery spans; raw
    `pg` and pg-boss queries (#55 follow-up).
31. **Build — exports beyond 64 MiB** through an object store, and exports that
    survive a master-key rotation (#48 follow-up).
32. **Build — Helm backup CronJob** fingerprinting the external key reference,
    not only `MASTER_KEY`; kubeconform in CI.
33. **Validate — DR exercise, incident tabletops, on-call, capacity** (#61,
    #62, #65, #68) and **Operate — scheduled restore verification** (#66).

Privacy and compliance:

34. **Build — target-side erasure hand-off.** Syntra never deletes in target
    systems; an erasure should raise a tracked task per target holding the
    person (#70 follow-up).
35. **Build — audit-log archive-and-prune for erased people and deleted
    tenants** on the retention schedule, run and evidenced rather than
    documented only.
36. **Decide — compliance target, data residency, vendor management, policy
    lifecycle** (#75–#80).

## P2 — scale, usability and supportability

37. **Build — OpenAPI response schemas** for the operations that lack them, and
    generated client examples (#99).
38. **Build — webhook reliability contract:** signed payloads with rotation,
    replay protection, ordering, dead-letter and customer-visible status
    (#100).
39. **Build — high-volume pagination, saved queues, safe bulk actions, large
    import pipeline, searchable entitlement catalog** (#81–#85).
40. **Build — internationalization** of console and new screens (#86).
41. **Build — onboarding wizard, configuration promotion, policy-as-code,
    access diagnostics, delegated administration, license governance**
    (#88–#94).
42. **Build — public status page and incident history** (#63 follow-up).
43. **Validate — multi-tenant performance and multi-day soak** (#95, #96).
44. **Decide/Operate — supported deployment model, release train, support
    model, compatibility matrix, documentation QA, service terms, responsible
    automation policy** (#97, #101–#106).

## P3 — later differentiation

45. Entra app-role assignments, Microsoft 365 adapter, connector SDK,
    event-stream integration, access analytics, regional failover (#107–#112).
    Azure Key Vault as a third master-key provider joins this list.

## Suggested next engineering order

1. Items 2 and 4 (small, unblock correctness and CI).
2. Database-level same-tenant references (22).
3. Incremental audit-chain verification (28).
4. Per-tenant sweeps for runtime-created tenants (21).
5. Change control for federation and credentials (18).
6. Abuse protection and the 429/idempotency contract (24).
7. Reconciliation campaigns and drift policy (15).
8. Webhook reliability contract (38).
