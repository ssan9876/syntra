# Employee lifecycle and provisioning usability

Method: dual-agent (A: `/root/provisioning_ux_review` · B: `/root/provisioning_ux_evidence`). Assessment A completed independently before detector findings were reviewed. A was source-based because its browser inventory was empty. B completed read-only browser review on a disposable seeded instance. No complete connector lifecycle was executed.

## Product direction

An administrator should be able to answer two questions from an employee's page: **Can this person start work? Has this person's access been ended everywhere Syntra manages?** Today, the answer requires following separate person, account, rule, target and run pages.

HelloID documents provisioning as source import and mapping, target configuration, business rules and enforcement. Syntra already has equivalents of many of those building blocks. The recommendation is to connect those pieces into a guided and observable employee workflow, not to claim equivalent connector coverage. References: [HelloID provisioning](https://docs.helloid.com/en/provisioning.html), [setup sequence](https://docs.helloid.com/en/provisioning/set-up-provisioning.html).

## Design health

Source-based heuristic score before the onboarding repair: **22/40**. This is a qualitative workflow assessment, not an accessibility certification.

| Heuristic | Score / 4 | Principal issue |
|---|---:|---|
| System status | 2 | Onboarding discards provisioning results |
| Real-world match | 2 | Completing a hire requires understanding several technical modules |
| User control | 2 | No durable resumable lifecycle operation |
| Consistency | 3 | Person and account deactivation have materially different scope |
| Error prevention | 2 | Previews can describe a previous draft |
| Recognition | 2 | Operators must remember state between pages |
| Efficiency | 2 | Person picker caps at 200; entitlement lists lack search |
| Minimalism | 3 | Restrained interface, but advanced settings compete with basic setup |
| Error recovery | 2 | Partial lifecycle completion is not directly resumable |
| Help | 2 | Local guidance exists; end-to-end setup guidance is missing |

The scoped detector reported **zero findings across ten TSX pages**. It is a regex scan, not a rendered accessibility or usability test; it does not contradict the workflow findings. No browser overlay was injected because the available evaluation API was read-only. No false positives were returned.

## Priorities and acceptance criteria

### 1. Reliable onboarding receipt

Keep the existing person/contract/login machinery, but put orchestration on the server with durable identity, idempotency and authorization checks. Record every target's requested, planned and observed result. Refreshing or losing a tab must not lose the operation.

- Display person and contract saved, Syntra login created/linked when requested, and each target's pending/applied/blocked/failed/no-rule result.
- Correlate the submitted job to its exact run. Never infer completion from the newest run or a zero action count.
- Link failures to the relevant run and explain the next action. Retry only failed or unfinished steps without creating another person/account.
- Test login-created/link-failed, target A success/target B failure, delayed planning, no rule match, concurrent submissions and refresh during work.

The current patch corrects partial-failure copy, preserves links to saved records, and prevents resubmitting the create action. Durable resumption and complete target receipts remain future work.

### 2. Person-scoped offboarding

Add “End employment” with a preview of linked sign-ins and all managed target accounts. Reuse existing directory write-back, session revocation and leaver policies. Distinguish immediate access blocking from delayed disable/archive/delete retention actions; unsupported targets must appear as manual tasks.

- Show effective date, target action dates, reasons, approval/authorization requirements and irreversible actions.
- Keep “incomplete” visible until every required target result is verified or explicitly assigned for manual handling.
- Test multiple contracts, rehire, future departure, already-disabled accounts, unreachable targets, retries and sessions issued before departure.

### 3. Guided setup with proven readiness

Provide a persistent checklist: **connect HR → map fields → inspect a sample employee → connect target → configure naming/placement → assign access rules → preview lifecycle → enable schedule**. Preserve direct expert editors.

Readiness must derive from saved/tested configuration. Each blocker links to its editor. Offer understandable schedule controls with advanced cron, safe presets with explicit assumptions, and a sample employee showing concrete lifecycle dates. Do not enable writes merely because a connection test passed.

### 4. Trustworthy previews

Bind preview responses to target, person and exact draft version. Clear or label stale results immediately on edits, including responses arriving after an edit. Require an appropriate fresh review before destructive enforcement. Cover delayed responses in component tests.

### 5. Employee work queue and scalable search

Make the daily landing view show employees awaiting access, incomplete departures, blocked changes and failed tasks. Clicking a count should open its filtered backlog. Add server-backed person search and searchable entitlement selection with selected values easy to inspect.

## Evidence from the interface

- “Add someone” has five identity fields and eight contract fields, then optional Syntra login. Required/optional distinctions are unclear and the primary action is below the fold.
- The Access empty state offers two possible explanations—no rule matches or no target has run—but no diagnosis or next action.
- HR-feed empty-state guidance is useful; creation immediately exposes SFTP settings and raw cron without a visible setup sequence.
- New target combines connection, enforcement, lifecycle timings and seven safety thresholds. Terms such as “Authoritative” and “Confirmable by number” need contextual explanations. Bottom-of-form completion controls would reduce unnecessary scrolling.
- Populated connector runs, directory failures and actual entitlement state could not be validated on the empty fixture.

## Strengths to preserve

The compact visual system fits IT administration; no strong source-level AI-template concern was found. Explicit snapshot/delta selection, threshold guards, person-scoped apply, entitlement provenance and detailed run history are valuable. Keep these safeguards and make them easier to discover.

## Cognitive load and employee journey

The main burden is remembering state across modules. Raw cron, templates and enforcement terms create a second burden during initial setup. The emotional low point is saving a hire without knowing whether they can work, followed by ending a contract without knowing whether sign-in access ended. Clear receipts and unresolved-action queues address those moments better than cosmetic redesign.

Power administrators need arbitrary-person search, fast exception handling and linked evidence. First-time operators need tested setup steps and clear consequences. Keyboard/screen-reader users need manageable selector lists; a full focus, contrast and assistive-technology review remains outstanding. Hospital IT operators need a morning list of people whose access is incomplete, rather than component health alone.

## Minor improvements

Filter Failed/Blocked run links to match their labels; put the employee name in access-explanation titles; teach supported template syntax with examples; add explicit required-field guidance and bottom actions to long forms.

## Release gate for an employee-lifecycle pilot

Demonstrate one imported hire, a department change and a departure against an actual test directory. Interrupt one target deliberately and demonstrate safe resumption. Confirm observed target state and old-session revocation. A saved record or successful queue submission is not sufficient evidence of completion.

The next implementation should answer: can an operator verify a complete hire or departure from one employee page without searching connector run histories?

## Implementation status

The five priorities in this review are now implemented as a coherent first pass. Person pages show durable per-target provisioning receipts and unified offboarding; the new Employee work page exposes unresolved hires, departures and failures; the setup checklist connects existing editors; previews are draft-bound. The remaining limitations are tracked in [the repository audit](audit-2026-09-20.md), especially browser-driven creation of person/contract/login before provisioning and the absence of post-apply directory read-back as a completion gate.
