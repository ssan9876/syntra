export * from './config.js';
export * from './net/outbound.js';
export * from './net/guarded-fetch.js';
export * from './tenant-context.js';
export * from './tenant/tenant-service.js';
export * from './directory/user-service.js';
export * from './directory/group-service.js';
export * from './directory/org-unit-service.js';
export * from './audit/audit-service.js';
export * from './vault/master-key.js';
export * from './vault/vault-service.js';
export * from './keys/signing-key-service.js';
export * from './keys/key-change.js';
export * from './keys/jobs.js';
export * from './identity/person-service.js';
export * from './identity/contract-service.js';
export * from './identity/csv-import.js';
export * from './rbac/permissions.js';
export * from './rbac/rbac-service.js';
export * from './auth/password.js';
export * from './auth/password-policy.js';
export * from './auth/refresh-token.js';
export * from './auth/password-reset.js';
export * from './auth/session-service.js';
// authenticate() is deliberately NOT exported. It is the password half of
// authorize(), and a caller that reached it directly would skip policy
// evaluation, second factors and the audit event. authorize() is the door.
export type { AuthFailure, AuthResult } from './auth/login-service.js';
export * from './auth/authorize.js';
// Only the read. `issueAttempt` plus `authorize({ kind: 'continue' })` is a
// second door into an allow: an attempt issued by hand names its own userId,
// scope and required factor, and satisfying it yields a session at that scope
// with no primary authentication and no policy evaluation ever having run.
// Nothing calls it today; Access II adds exactly the protocol adapters the
// spec says must not have a second way in. The routes legitimately read an
// attempt to find out what it was for, so that much is exported.
export { findAttempt } from './auth/attempt-service.js';
export type { AttemptPurpose, ResolvedAttempt } from './auth/attempt-service.js';
export * from './auth/mfa/relying-party.js';
export * from './auth/mfa/types.js';
export * from './auth/mfa/registry.js';
export * from './auth/mfa/totp.js';
export * from './auth/mfa/webauthn.js';
export * from './auth/mfa/recovery-codes.js';
export * from './policy/types.js';
export * from './policy/ip-match.js';
export * from './policy/time-window.js';
export * from './policy/evaluate.js';
export * from './policy/policy-service.js';
export * from './policy/context.js';
export * from './policy/impact.js';
export * from './notify/notification-service.js';
export * from './notify/delivery.js';
export * from './notify/templates/index.js';
export * from './jobs/scheduler.js';
export * from './sync/mapping.js';
export * from './sync/correlate.js';
export * from './sync/diff.js';
export * from './sync/guard.js';
export * from './sync/defaults.js';
export * from './sync/source-service.js';
export * from './sync/run-service.js';
export * from './sync/apply.js';
export * from './sync/jobs.js';
export * from './access/application-service.js';
export * from './access/assignment-service.js';
export * from './access/resolve.js';
export * from './access/claims/types.js';
export * from './access/claims/resolve.js';
export * from './access/claims/collect.js';
export * from './access/claim-mapping-service.js';
export * from './access/saml-config-service.js';
export * from './access/browser-binding.js';
export * from './access/saml-request-service.js';
export * from './access/saml-session-service.js';
export * from './access/oidc-store.js';
export * from './access/oidc-client-service.js';
export * from './access/authorization-decision-service.js';
export * from './federation/routing.js';
// upstreamClientSecret is exported because the federation flow needs it to
// complete a token exchange. No route returns its value.
export * from './federation/upstream-service.js';
export * from './federation/federation-request-service.js';
export * from './federation/jit-service.js';
export * from './provision/condition.js';
export * from './provision/templates.js';
export * from './provision/names.js';
// Member by member, not `export *`: `provision/types.js` declares a
// `ContractFacts` — the whole contract row the rule engine reads — and
// `policy/types.js` already exports a different `ContractFacts`, the four-field
// subset an authentication policy may look at. A star export of both is
// TS2308, and the barrel silently stops exporting the name at all. Everything
// inside `provision/` imports it from `./types.js` by its own name; only this
// barrel needs the alias.
//
// Anything added to `provision/types.js` must be added here too.
export type {
  AccountStatus,
  ActualState,
  Attribution,
  ContractFacts as ProvisionContractFacts,
  DesiredAccount,
  DesiredState,
  DraftDriftFinding,
  DriftKind,
  EnforcementMode,
  KnownAccount,
  KnownHolding,
  LadderSettings,
  PersonFacts,
  PlannedAction,
  ProfileFacts,
  RuleFacts,
  TargetObject,
  UnprocessableKind,
} from './provision/types.js';
export * from './provision/desired.js';
export * from './provision/reconcile.js';
export * from './provision/plan.js';
// Member by member, not `export *`, and for the same reason as
// `provision/types.js` above: `sync/guard.js` already exports `GuardInput`
// and `GuardVerdict`. A star export of both is TS2308 twice over, and the
// barrel then exports neither name at all — the guard would compile, pass its
// own tests, and be unreachable from outside the package.
//
// The names are aliased rather than renamed at the source, because inside
// `provision/` there is only one guard and `GuardInput` is what it is called;
// the ambiguity exists only at the barrel.
export {
  GUARDED_ACTION_TYPES,
  evaluateProvisionGuard,
} from './provision/guard.js';
export type {
  GuardThresholds,
  GuardInput as ProvisionGuardInput,
  GuardVerdict as ProvisionGuardVerdict,
} from './provision/guard.js';
// Grepped for every exported name against the existing barrel before adding
// these two lines: `ContractFacts` (Task 7) and `GuardInput`/`GuardVerdict`
// (Task 10) both collided with `sync/`, and under TS2308 the barrel exports
// NEITHER side silently. Nothing in these two modules collides today.
export * from './provision/target-service.js';
export * from './provision/entitlement-service.js';
// Grepped as well: `previewProvisionRun`, `ProvisionRunInFlightError`,
// `PreviewProvisionRunOptions` and `ProvisionRunSummary` appear nowhere else in
// the workspace. `sync/run-service.js` exports `previewRun`, which is a
// different name -- the collision that has bitten this slice twice is two
// modules choosing the SAME name, and under TS2308 the barrel then exports
// neither.
export * from './provision/run-service.js';
// Grepped, as the three lines above were: none of `claimSyntraUsers`,
// `applySyntraUserAction`, `enqueuePairedSync`, `ClaimSummary`,
// `SYNTRA_USER_LINK_SUBJECT` or the five error classes appears anywhere else
// in the workspace. `sync/` and `provision/` naming the same concept is what
// collided twice on this slice, and under TS2308 the barrel then exports
// NEITHER side, silently.
export * from './provision/syntra-user.js';
// Grepped workspace-wide before adding, as the four lines above were: none of
// `applyProvisionRun`, `resolveInFlightActions`, `backoffMs`,
// `generateInitialPassword`, `ApplyOptions`, `InitialPasswordPolicy`,
// `ProvisionRunNotAppliableError` or `ProvisionRunNotConfirmableError` appears
// anywhere else in the workspace. `sync/apply.js` exports `applyChange`, which
// is a different name — the collision that has bitten this slice twice is two
// modules choosing the SAME name, and under TS2308 the barrel then exports
// neither.
export * from './provision/apply.js';
// Grepped workspace-wide before adding, as the five lines above were: none of
// `PROVISION_JOB`, `ProvisionJobPayload`, `provisionJobPayload`,
// `provisionScheduleKey`, `SchedulableTarget`, `applyTargetSchedule`,
// `removeTargetSchedule`, `runProvisionJob`, `registerProvisionJobs`,
// `RunProvisionJobOptions` or `STALE_RUN_MS` appears anywhere else in the
// workspace. `sync/jobs.js` exports `SYNC_JOB`, `syncScheduleKey`,
// `applySourceSchedule` and `registerSyncJobs` -- different names for the same
// concepts, which is the collision that has bitten this slice twice; under
// TS2308 the barrel would then export NEITHER side, silently.
export * from './provision/jobs.js';
// Member by member, not `export *`, and for the same reason as
// `provision/types.js` and `provision/guard.js` above: `policy/impact.js`
// ALREADY exports `previewRuleImpact` and `RuleImpact` -- the policy
// simulator's blast-radius preview, a different function answering a
// different question. A star export of both is TS2308 twice over, and under
// TS2308 the barrel exports NEITHER side, silently: the provisioning preview
// would compile, pass its own tests, and be unreachable from `apps/api`, and
// so would the policy one it collided with.
//
// Fourth barrel collision on this slice. The names are aliased here rather
// than renamed at the source, because inside `provision/` there is one rule
// impact and `previewRuleImpact` is what it is called; the ambiguity exists
// only at the barrel. Route code imports the aliases.
//
// `explainPersonAccess`, `previewAccountProfile`, `PersonAccess`,
// `PersonAccessEntitlement`, `ProfilePreview` and `RULE_IMPACT_SAMPLE_SIZE`
// were each grepped workspace-wide and appear nowhere else.
export {
  RULE_IMPACT_SAMPLE_SIZE,
  explainPersonAccess,
  previewAccountProfile,
  previewRuleImpact as previewProvisionRuleImpact,
} from './provision/explain.js';
export type {
  PersonAccess,
  PersonAccessEntitlement,
  ProfilePreview,
  RuleImpact as ProvisionRuleImpact,
} from './provision/explain.js';

// Automate — the request catalog, its approval chains, and the grants they
// produce. Every name below was grepped workspace-wide before being exported
// through this barrel: two modules exporting one name through one barrel makes
// TypeScript export NEITHER, silently (TS2308), which this repo has been bitten
// by four times.
export * from './automate/types.js';
export * from './automate/audience.js';
export * from './automate/form.js';
export * from './automate/duration.js';
export * from './automate/approvers.js';
export * from './automate/notify.js';
export * from './automate/catalog-service.js';
export * from './automate/workflow-service.js';
export * from './automate/eligibility.js';
export * from './automate/fulfil.js';
export * from './automate/request-service.js';
export * from './automate/decision-service.js';
export * from './automate/reflect.js';
export * from './automate/sweep-guard.js';
export * from './automate/sweep-service.js';
export * from './automate/delegation-service.js';
export * from './automate/jobs.js';

// Govern — access governance: inventory, campaigns and segregation of duties.
export * from './govern/types.js';
