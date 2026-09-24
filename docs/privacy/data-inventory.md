# Syntra data inventory

<!-- Generated from packages/core/src/privacy/inventory.ts by `pnpm privacy:inventory`. Do not edit by hand: a test fails when this file and the inventory disagree. -->

Every column of every table Syntra stores, classified by personal-data category, with the purpose, source, retention and access of each area, and exactly what a data-subject erasure does to each column. The inventory in code is the source of truth; the data-subject search, the access bundle and the erasure all read it, so this document describes what they actually do.

**Legal bases are placeholders.** The controller decides them; each area states what is typical so a privacy reviewer has something to confirm or replace.

## Scope

- **Controller.** The organisation operating the tenant. Syntra is software; the operator of a deployment is the processor or controller as their contracts say.
- **Residency.** The PostgreSQL database of the deployment, in whatever region the operator runs it. Backups follow the operator's backup configuration (see docs/operate.md, Backups).
- **Processors.** Syntra adds no sub-processor. Connectors send data to the target systems and receive it from the sources a tenant configures; outbound email goes through the SMTP relay the operator configures; webhooks go to the endpoints a tenant configures.

## Categories

| Category | Meaning |
| --- | --- |
| `identity` | Who someone is: names, logins, identifiers, and references to a person or account. |
| `contact` | How to reach someone: email addresses. |
| `hr` | Employment: role, department, cost centre, manager, dates, HR identifiers. |
| `authentication` | Signing in: credentials, sessions, network addresses, browsers, factors. |
| `audit` | The tamper-evident record of actions. |
| `operational` | What the product did about or for the person: statuses, run and request records, free text typed during that work. |
| `none` | Not personal data. |

A column marked **secret** is credential material and is never copied into an access bundle.

## Data-subject erasure at a glance

An erasure finds rows through each table's *subject links* and then, per table, pseudonymises named columns in place, deletes the rows (credential and transient state only), or retains them for the reason given. See [Operate, Data-subject requests](../operate.md#data-subject-requests) for the procedure and its preconditions.

| Table | Linked by | Erasure | Why |
| --- | --- | --- | --- |
| `AccessGrant` | person: `subjectPersonId`, `approvedByPersonId` | retain | Access-governance evidence: what was granted, when and on whose approval. Identifiers only. |
| `AccessRequest` | person: `subjectPersonId`, `requestedByPersonId`; user: `requestedByUserId` | pseudonymize | Kept as access-governance evidence (who asked for what, and the outcome); the justification and form values the person typed are cleared. |
| `AccountAttribution` | person: `proposedPersonId` | retain | Identifiers only. |
| `AccountEntitlement` | account: `accountId` | retain | Identifiers only: what an (erased) account held. |
| `AccountPlacement` | person: `personId` | retain | The container (organisational unit) an account is placed in; not about the person beyond their unit. |
| `ApiToken` | user: `userId` | retain | Machine credentials belong to service accounts; the name is an administrator's label and the token is stored hashed. |
| `AppAssignment` | user: `userId` | retain | Identifiers only. |
| `ApprovalDecision` | person: `personId`, `onBehalfOfPersonId`; user: `userId` | retain | Append-only at the database (no update, no delete): an approval decision is access-governance evidence. The comment is retained; it is also in the audit log. |
| `ApprovalDelegation` | person: `delegatorPersonId`, `delegatePersonId` | retain | Identifiers and dates only. |
| `ApprovalStepApprover` | person: `personId`, `onBehalfOfPersonId` | retain | Identifiers only. |
| `AuditEvent` | user: `actorUserId`; any: `targetId` | retain | Immutable to the application (`audit_no_update`, `audit_no_delete`) and hash-chained. Payloads can name the person; they leave through the database-owner archive-and-prune procedure once the tenant's audit retention period ends, at or before a verified checkpoint. |
| `AuditSavedView` | user: `userId` | delete | The person's own saved search filters. |
| `AuthAttempt` | user: `userId` | pseudonymize | Kept until it expires; the source address is cleared. |
| `AuthorizationDecision` | user: `userId` | delete | Transient protocol state. |
| `BusinessFunction` | person: `ownerPersonId` | retain | Configuration naming the person as an owner. |
| `Campaign` | person: `ownerPersonId` | retain | Identifiers only. |
| `CampaignDecision` | person: `personId` | retain | Append-only at the database: a review decision is access-governance evidence. |
| `CampaignItem` | person: `personId` | retain | Access-review evidence. |
| `CampaignItemReviewer` | person: `personId` | retain | Access-review evidence. |
| `Contract` | person: `personId` | pseudonymize | Employment details are cleared. Dates, sequence and the HR employment id are kept: lifecycle decisions (departure, grace periods) are computed from the dates, and the id stops a feed from re-creating the contract. |
| `CoverageGap` | person: `personId` | retain | Snapshot evidence; removed with the snapshot. |
| `DataExport` | user: `requestedByUserId` | retain | The record of who took which copy. An access bundle about the person that still holds a file has the file erased (see the erasure procedure). |
| `DelegatedTaskRun` | user: `subjectUserId`, `runByUserId` | pseudonymize | The submitted form values are cleared. |
| `DriftFinding` | account: `accountId` | pseudonymize | The detail (target attribute values) is cleared. |
| `EmailOtpCredential` | user: `userId` | delete | Credential material. |
| `GovernFinding` | person: `ownerPersonId` | retain | Identifiers only. |
| `GroupMembership` | user: `userId` | retain | Identifiers only. Once the account is pseudonymised, the membership says only that an erased account was a member. |
| `Holding` | person: `personId` | retain | Access-review evidence frozen in a snapshot; removed with the snapshot by the Govern snapshot retention. |
| `HoldingCertification` | person: `lastCertifiedByPersonId` | retain | Certification evidence: who last certified an access. |
| `HoldingEvent` | person: `personId` | retain | Snapshot evidence; removed with the snapshot. |
| `LifecycleCaseEvent` | operation: `operationId` | pseudonymize | Messages and metadata are cleared. |
| `LifecycleLegalHold` | any: `subjectId` | retain | A preservation order. An active one refuses the erasure; a released one is the record of it. |
| `LifecycleObservation` | step: `stepId` | delete | What a target reported for the person's account; retention removes these anyway. |
| `LifecycleOperation` | person: `personId` | pseudonymize | Resolved operations are kept as the record that the work happened (retention removes them later); the input payload, which carries HR fields, is cleared. |
| `LifecycleSimulation` | person: `personId` | delete | A rehearsal; retention removes these anyway. |
| `LifecycleStep` | operation: `operationId` | pseudonymize | Evidence and messages are cleared. |
| `LifecycleStepAttempt` | operation: `operationId` | pseudonymize | Evidence and messages are cleared. |
| `LoginLockout` | user: `userId` | delete | Transient authentication state. |
| `LogoutDelivery` | user: `userId` | retain | Identifiers only: which relying party was told the session ended. |
| `NotificationOutbox` | user: `userId`; identifier: `to` | pseudonymize | The recipient address and the template variables are replaced, and an unsent message is stopped. |
| `NotificationPreference` | user: `userId` | retain | A delivery mode only. |
| `OidcArtifact` | user: `accountId` | delete | Transient protocol artifacts whose payload can carry claims (names, email). |
| `PasswordCredential` | user: `userId` | delete | Credential material. A deactivated, erased account has no use for it. |
| `PasswordHistory` | user: `userId` | delete | Credential material. |
| `PasswordResetToken` | user: `userId` | delete | Credential material. |
| `Person` | person: `id` | pseudonymize | The row is kept so every reference to it still resolves; nothing that identified the person remains on it. `externalId` and the source link are kept so an HR feed that still holds the person recognises the row and is refused by the restriction instead of re-creating them. |
| `PersonDuplicateReview` | person: `candidatePersonId` | pseudonymize | The matched value (a name or address) and the reviewer's note are cleared. |
| `PersonImportChange` | any: `targetId` | pseudonymize | Kept as the record of what an import did; the before and after values and the message are cleared. |
| `PersonProvisionReceipt` | person: `personId` | pseudonymize | Kept for its status and target; the evidence and message, which can name the person, are cleared. |
| `PersonSourceLink` | person: `personId` | retain | The HR source's key for the person. Kept so the feed recognises the row and cannot re-create an erased person while the source still holds them. |
| `PrivacyCase` | person: `personId` | retain | The record that the request was received, verified and handled (accountability, GDPR art. 5(2)). |
| `Product` | person: `ownerPersonId` | retain | Configuration naming the person as an owner. |
| `ProvisionAction` | person: `personId`; account: `accountId` | pseudonymize | Kept as the record of what was done to the account; the before and after attribute values and the message are cleared. |
| `ProvisionException` | person: `personId` | pseudonymize | The message names the person and is replaced. |
| `RecoveryCode` | user: `userId` | delete | Credential material. |
| `RefreshToken` | user: `userId` | retain | Stored hashed; kept revoked as the evidence that access ended, like sessions. |
| `RemediationItem` | person: `ownerPersonId` | retain | Identifiers only. |
| `ResourceDelegation` | person: `delegatePersonId` | retain | Configuration naming the person as a delegate. |
| `ResourceOwner` | person: `ownerPersonId` | retain | Configuration naming the person as an owner; reassign it before or after the erasure. |
| `ReviewQualitySignal` | person: `personId` | retain | Aggregate numbers about a reviewer. |
| `RevocationOrder` | person: `decidedByPersonId` | pseudonymize | The decider's name, copied onto the order when it was made, is replaced. |
| `RoleAssignment` | user: `userId` | retain | Identifiers only: which role an (erased) account held. |
| `SamlSsoSession` | identifier: `nameId` | pseudonymize | The NameID asserted to the service provider is replaced by a pseudonym. |
| `Session` | user: `userId` | pseudonymize | Kept as the evidence that sessions existed and were ended; the network address and browser are cleared. |
| `SodException` | person: `personId`, `approvedByPersonId` | retain | Risk-acceptance evidence, including its justification. |
| `SodViolation` | person: `personId` | retain | Risk evidence; identifiers only. |
| `SweepAction` | person: `subjectPersonId` | retain | Identifiers only. |
| `SweepException` | person: `personId` | pseudonymize | The message can name the person and is replaced. |
| `SyncChange` | any: `targetId` | pseudonymize | Kept as the record of what a sync did; the before and after values are cleared. |
| `TargetAccount` | person: `personId` | pseudonymize | Accounts are disabled or archived before an erasure. The login Syntra generated and the attributes it last wrote are replaced; the target's immutable object id is kept so a later run recognises the account. The copy in the target system itself must be erased there: Syntra has no delete path to a target, by design. |
| `TotpCredential` | user: `userId` | delete | Credential material; the vault secret it names is deleted with it. |
| `UpstreamLink` | user: `userId` | pseudonymize | The upstream provider's subject identifier is replaced by a pseudonym so the binding can no longer be used to recognise the person. |
| `User` | person: `personId` | pseudonymize | Accounts are deactivated before an erasure and kept afterwards (deactivate, never delete); login, email and display name are replaced by pseudonyms. The directory anchor is kept so a directory sync recognises the account and the restriction refuses its changes. |
| `UserAttribute` | user: `userId` | pseudonymize | Free-form attribute values are cleared; the keys are tenant configuration. |
| `WebAuthnChallenge` | user: `userId` | delete | Transient protocol state. |
| `WebAuthnCredential` | user: `userId` | delete | Credential material, including the device label the person typed. |

## Tables by area

### HR record

- **Purpose.** Know who is employed or engaged, in what role and for how long, so accounts and access can be derived from employment.
- **Source.** HR feeds (person sources), CSV import, and administrators.
- **Retention.** For as long as the person is known to the tenant. Deactivated, never deleted; pseudonymised by a data-subject erasure; removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically performance of the employment contract (GDPR art. 6(1)(b)) and legal obligation (6(1)(c)).
- **Access.** `identity.read`; `identity.sensitive.read` for the personal email; `identity.write` / `directory.write` to edit; `privacy.manage`.

#### `Contract`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- Employment details are cleared. Dates, sequence and the HR employment id are kept: lifecycle decisions (departure, grace periods) are computed from the dates, and the id stops a feed from re-creating the contract.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `personId` | identity | retained |  |
| `sequence` | hr | retained |  |
| `isPrimary` | hr | retained |  |
| `startDate` | hr | retained |  |
| `endDate` | hr | retained |  |
| `jobTitle` | hr | cleared |  |
| `department` | hr | cleared |  |
| `costCentre` | hr | cleared |  |
| `employer` | hr | cleared |  |
| `location` | hr | cleared |  |
| `managerPersonId` | hr | cleared |  |
| `fte` | hr | cleared |  |
| `externalId` | hr | retained |  |

Not personal data: `tenantId`.

#### `Person`

Linked to a data subject by person: `id`. Erasure: **pseudonymize** -- The row is kept so every reference to it still resolves; nothing that identified the person remains on it. `externalId` and the source link are kept so an HR feed that still holds the person recognises the row and is refused by the restriction instead of re-creating them.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `givenName` | identity | replaced by `Erased` |  |
| `familyName` | identity | replaced by `Person` |  |
| `nameConvention` | identity | retained |  |
| `businessEmail` | contact | cleared |  |
| `personalEmail` | contact | cleared |  |
| `externalId` | identity | retained |  |
| `status` | hr | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |
| `orgUnitId` | hr | retained |  |
| `departureOverride` | hr | retained |  |
| `departureOverrideBy` | identity | retained |  |
| `departureOverrideNote` | hr | cleared |  |
| `sourceId` | hr | retained |  |
| `statusReason` | hr | replaced by `erased` |  |
| `processingRestrictedAt` | operational | retained |  |
| `processingRestrictedCaseId` | operational | retained |  |
| `erasedAt` | operational | retained |  |
| `erasedCaseId` | operational | retained |  |

Not personal data: `tenantId`.

#### `PersonSourceLink`

Linked to a data subject by person: `personId`. Erasure: **retain** -- The HR source's key for the person. Kept so the feed recognises the row and cannot re-create an erased person while the source still holds them.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `sourceId` | hr | retained |  |
| `personId` | identity | retained |  |
| `externalId` | identity | retained |  |
| `linkedByUserId` | identity | retained |  |
| `linkedAt` | hr | retained |  |

Not personal data: `tenantId`.

### Directory account

- **Purpose.** The accounts people sign in with, their attributes and what they are members of.
- **Source.** Administrators, directory sync, SCIM, upstream identity providers (just-in-time).
- **Retention.** For as long as the tenant exists. Deactivated, never deleted; pseudonymised by a data-subject erasure; removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically performance of the employment contract (6(1)(b)) and legitimate interests in securing systems (6(1)(f)).
- **Access.** `directory.read`, `directory.write`; `privacy.manage`.

#### `AppAssignment`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `applicationId` | operational | retained |  |
| `subjectType` | operational | retained |  |
| `userId` | identity | retained |  |
| `groupId` | operational | retained |  |
| `orgUnitId` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `GroupMembership`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Identifiers only. Once the account is pseudonymised, the membership says only that an erased account was a member.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `groupId` | operational | retained |  |
| `userId` | identity | retained |  |

Not personal data: `tenantId`.

#### `RoleAssignment`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Identifiers only: which role an (erased) account held.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `roleId` | operational | retained |  |
| `userId` | identity | retained |  |
| `scopeOrgUnitId` | operational | retained |  |

Not personal data: `tenantId`.

#### `User`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- Accounts are deactivated before an erasure and kept afterwards (deactivate, never delete); login, email and display name are replaced by pseudonyms. The directory anchor is kept so a directory sync recognises the account and the restriction refuses its changes.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `login` | identity | pseudonym `erased-<id>` |  |
| `email` | contact | pseudonym `erased-<id>@erased.invalid` |  |
| `displayName` | identity | replaced by `Erased user` |  |
| `status` | operational | retained |  |
| `statusReason` | operational | replaced by `erased` |  |
| `passwordSource` | operational | retained |  |
| `passwordSourceHint` | operational | cleared |  |
| `orgUnitId` | operational | retained |  |
| `personId` | identity | retained |  |
| `sourceId` | operational | retained |  |
| `sourceAnchor` | identity | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `UserAttribute`

Linked to a data subject by user: `userId`. Erasure: **pseudonymize** -- Free-form attribute values are cleared; the keys are tenant configuration.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `key` | operational | retained |  |
| `type` | operational | retained |  |
| `value` | operational | cleared |  |

Not personal data: `tenantId`.

### Authentication

- **Purpose.** Prove who is signing in, keep them signed in, and let them recover access.
- **Source.** The person (enrolment, sign-in) and the product (sessions, tokens).
- **Retention.** While the credential or session is live; sessions and refresh tokens are kept revoked as the evidence that access ended. Removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legitimate interests in securing systems (6(1)(f)).
- **Access.** The person themselves; `directory.write` for administrative resets; credential material is readable by nobody.

#### `ApiToken`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Machine credentials belong to service accounts; the name is an administrator's label and the token is stored hashed.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `name` | authentication | retained |  |
| `tokenHash` | authentication | retained | secret |
| `scopes` | authentication | retained |  |
| `expiresAt` | authentication | retained |  |
| `lastUsedAt` | authentication | retained |  |
| `revokedAt` | authentication | retained |  |
| `createdAt` | operational | retained |  |
| `createdBy` | authentication | retained |  |

Not personal data: `tenantId`.

#### `EmailOtpCredential`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `confirmedAt` | authentication | row deleted |  |
| `codeHash` | authentication | row deleted | secret |
| `expiresAt` | authentication | row deleted |  |
| `attempts` | authentication | row deleted |  |
| `sentAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |
| `updatedAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `LoginLockout`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Transient authentication state.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `failedCount` | authentication | row deleted |  |
| `firstFailedAt` | authentication | row deleted |  |
| `lastFailedAt` | authentication | row deleted |  |
| `lockedAt` | authentication | row deleted |  |
| `lockedUntil` | authentication | row deleted |  |
| `updatedAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `PasswordCredential`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material. A deactivated, erased account has no use for it.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `hash` | authentication | row deleted | secret |
| `changedAt` | authentication | row deleted |  |
| `mustChange` | authentication | row deleted |  |
| `updatedAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `PasswordHistory`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `hash` | authentication | row deleted | secret |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `PasswordResetToken`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `tokenHash` | authentication | row deleted | secret |
| `expiresAt` | authentication | row deleted |  |
| `consumedAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `RecoveryCode`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `codeHash` | authentication | row deleted | secret |
| `usedAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `RefreshToken`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Stored hashed; kept revoked as the evidence that access ended, like sessions.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `tokenHash` | authentication | retained | secret |
| `clientId` | authentication | retained |  |
| `scope` | authentication | retained |  |
| `createdAt` | operational | retained |  |
| `absoluteExpiresAt` | authentication | retained |  |
| `revokedAt` | authentication | retained |  |

Not personal data: `tenantId`.

#### `Session`

Linked to a data subject by user: `userId`. Erasure: **pseudonymize** -- Kept as the evidence that sessions existed and were ended; the network address and browser are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `tokenHash` | authentication | retained | secret |
| `scope` | authentication | retained |  |
| `satisfiedFactor` | authentication | retained |  |
| `ip` | authentication | cleared |  |
| `userAgent` | authentication | cleared |  |
| `createdAt` | operational | retained |  |
| `lastSeenAt` | authentication | retained |  |
| `absoluteExpiresAt` | authentication | retained |  |
| `revokedAt` | authentication | retained |  |

Not personal data: `tenantId`.

#### `TotpCredential`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material; the vault secret it names is deleted with it.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `secretName` | authentication | row deleted |  |
| `algorithm` | authentication | row deleted |  |
| `digits` | authentication | row deleted |  |
| `period` | authentication | row deleted |  |
| `lastCounter` | authentication | row deleted |  |
| `confirmedAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `UpstreamLink`

Linked to a data subject by user: `userId`. Erasure: **pseudonymize** -- The upstream provider's subject identifier is replaced by a pseudonym so the binding can no longer be used to recognise the person.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `upstreamIdpId` | authentication | retained |  |
| `userId` | identity | retained |  |
| `subject` | identity | pseudonym `erased-<id>` |  |
| `lastLoginAt` | authentication | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `WebAuthnCredential`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Credential material, including the device label the person typed.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `credentialId` | authentication | row deleted | secret |
| `publicKey` | authentication | row deleted | secret |
| `counter` | authentication | row deleted |  |
| `transports` | authentication | row deleted |  |
| `attestationType` | authentication | row deleted |  |
| `rpId` | authentication | row deleted |  |
| `label` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |
| `lastUsedAt` | authentication | row deleted |  |

Not personal data: `tenantId`.

### Protocol state

- **Purpose.** Carry one sign-in, federation or single-logout exchange from start to finish.
- **Source.** The product, during a protocol exchange.
- **Retention.** Minutes to hours: each row expires or is consumed; removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legitimate interests in securing systems (6(1)(f)).
- **Access.** No administrative screen reads these.

#### `AuthAttempt`

Linked to a data subject by user: `userId`. Erasure: **pseudonymize** -- Kept until it expires; the source address is cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `tokenHash` | authentication | retained | secret |
| `applicationId` | authentication | retained |  |
| `sourceIp` | authentication | cleared |  |
| `purpose` | authentication | retained |  |
| `scope` | authentication | retained |  |
| `requiredOutcome` | authentication | retained |  |
| `requiredFactor` | authentication | retained |  |
| `ruleId` | authentication | retained |  |
| `expiresAt` | authentication | retained |  |
| `consumedAt` | authentication | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `AuthorizationDecision`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Transient protocol state.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `clientId` | authentication | row deleted |  |
| `interactionUid` | authentication | row deleted |  |
| `satisfiedFactor` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |
| `expiresAt` | authentication | row deleted |  |
| `consumedAt` | authentication | row deleted |  |

Not personal data: `tenantId`.

#### `FederationRequest`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `upstreamIdpId` | authentication |  |  |
| `state` | authentication |  |  |
| `expectedResponseTo` | authentication |  |  |
| `browserBinding` | authentication |  |  |
| `verifierName` | authentication |  |  |
| `returnTo` | authentication |  |  |
| `applicationId` | authentication |  |  |
| `createdAt` | operational |  |  |
| `expiresAt` | authentication |  |  |
| `consumedAt` | authentication |  |  |

Not personal data: `tenantId`.

#### `LogoutDelivery`

Linked to a data subject by user: `userId`. Erasure: **retain** -- Identifiers only: which relying party was told the session ended.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `clientId` | authentication | retained |  |
| `userId` | identity | retained |  |
| `sessionId` | authentication | retained |  |
| `attempts` | authentication | retained |  |
| `nextAttemptAt` | authentication | retained |  |
| `deliveredAt` | authentication | retained |  |
| `lastStatus` | authentication | retained |  |
| `lastError` | authentication | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `OidcArtifact`

Linked to a data subject by user: `accountId`. Erasure: **delete** -- Transient protocol artifacts whose payload can carry claims (names, email).

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `model` | authentication | row deleted |  |
| `artifactId` | authentication | row deleted |  |
| `uid` | authentication | row deleted |  |
| `userCode` | authentication | row deleted |  |
| `grantId` | authentication | row deleted |  |
| `accountId` | identity | row deleted |  |
| `payload` | authentication | row deleted |  |
| `expiresAt` | authentication | row deleted |  |
| `consumedAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `RateLimitBucket`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `key` | authentication |  |  |

Not personal data: `hits`, `resetAt`.

#### `SamlAuthnRequest`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `applicationId` | authentication |  |  |
| `handle` | authentication |  |  |
| `requestId` | authentication |  |  |
| `acsUrl` | authentication |  |  |
| `relayState` | authentication |  |  |
| `protocol` | authentication |  |  |
| `forceAuthn` | authentication |  |  |
| `browserBinding` | authentication |  |  |
| `createdAt` | operational |  |  |
| `expiresAt` | authentication |  |  |
| `consumedAt` | authentication |  |  |

Not personal data: `tenantId`.

#### `SamlSsoSession`

Linked to a data subject by identifier: `nameId`. Erasure: **pseudonymize** -- The NameID asserted to the service provider is replaced by a pseudonym.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `sessionId` | authentication | retained |  |
| `applicationId` | authentication | retained |  |
| `nameId` | identity | pseudonym `erased-<id>` |  |
| `sessionIndex` | authentication | retained |  |
| `createdAt` | operational | retained |  |
| `endedAt` | authentication | retained |  |

Not personal data: `tenantId`.

#### `WebAuthnChallenge`

Linked to a data subject by user: `userId`. Erasure: **delete** -- Transient protocol state.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `purpose` | authentication | row deleted |  |
| `challenge` | authentication | row deleted | secret |
| `expiresAt` | authentication | row deleted |  |
| `consumedAt` | authentication | row deleted |  |
| `createdAt` | operational | row deleted |  |

Not personal data: `tenantId`.

### Target-system account

- **Purpose.** Know which account each person holds in each connected system, and what it was granted, so access follows employment.
- **Source.** Provisioning runs and the target systems they read.
- **Retention.** For as long as the target is connected. Disabled and archived, never deleted; pseudonymised by a data-subject erasure; removed with the target or tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically performance of the employment contract (6(1)(b)) and legitimate interests in securing systems (6(1)(f)).
- **Access.** `provision.read`, `provision.manage`; `privacy.manage`.

#### `AccountEntitlement`

Linked to a data subject by account: `accountId`. Erasure: **retain** -- Identifiers only: what an (erased) account held.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `accountId` | identity | retained |  |
| `entitlementId` | operational | retained |  |
| `origin` | operational | retained |  |
| `grantedByRuleId` | operational | retained |  |
| `grantedByRequestId` | operational | retained |  |
| `grantedAt` | operational | retained |  |
| `revokedAt` | operational | retained |  |
| `state` | operational | retained |  |

Not personal data: `tenantId`.

#### `AccountPlacement`

Linked to a data subject by person: `personId`. Erasure: **retain** -- The container (organisational unit) an account is placed in; not about the person beyond their unit.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `personId` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `container` | operational | retained |  |
| `reason` | operational | retained |  |
| `movedByUserId` | identity | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `TargetAccount`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- Accounts are disabled or archived before an erasure. The login Syntra generated and the attributes it last wrote are replaced; the target's immutable object id is kept so a later run recognises the account. The copy in the target system itself must be erased there: Syntra has no delete path to a target, by design.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `personId` | identity | retained |  |
| `anchor` | identity | retained |  |
| `correlationKey` | identity | pseudonym `erased-<id>` |  |
| `status` | operational | retained |  |
| `statusReason` | operational | cleared |  |
| `disabledAt` | operational | retained |  |
| `disableDueAt` | operational | retained |  |
| `archiveDueAt` | operational | retained |  |
| `createdActionId` | operational | retained |  |
| `lastReconciledAt` | operational | retained |  |
| `lastAppliedAttributes` | operational | cleared |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

### Lifecycle work

- **Purpose.** Carry out and evidence joiner, mover and leaver work: what was requested, approved and done.
- **Source.** HR events, administrators, and the provisioning engine.
- **Retention.** Removed by the lifecycle retention job once resolved and past the policy (`receiptRetentionDays`, `lifecycleOperationRetentionDays`, `observationRetentionDays`, `simulationRetentionDays`), unless under legal hold.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legal obligation and legitimate interests in accountable access management (6(1)(c), 6(1)(f)).
- **Access.** `identity.read` / `provision.read` for the work pages; `privacy.manage`.

#### `LifecycleCaseEvent`

Linked to a data subject by operation: `operationId`. Erasure: **pseudonymize** -- Messages and metadata are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `operationId` | operational | retained |  |
| `kind` | operational | retained |  |
| `actorUserId` | identity | retained |  |
| `message` | operational | cleared |  |
| `metadata` | operational | cleared |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `LifecycleLegalHold`

Linked to a data subject by any: `subjectId`. Erasure: **retain** -- A preservation order. An active one refuses the erasure; a released one is the record of it.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `subjectType` | operational | retained |  |
| `subjectId` | operational | retained |  |
| `reference` | operational | retained |  |
| `reason` | operational | retained |  |
| `placedByUserId` | identity | retained |  |
| `placedAt` | operational | retained |  |
| `releasedByUserId` | identity | retained |  |
| `releasedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `LifecycleObservation`

Linked to a data subject by step: `stepId`. Erasure: **delete** -- What a target reported for the person's account; retention removes these anyway.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `stepId` | operational | row deleted |  |
| `targetSystemId` | operational | row deleted |  |
| `completeness` | operational | row deleted |  |
| `matches` | operational | row deleted |  |
| `expected` | operational | row deleted |  |
| `observed` | operational | row deleted |  |
| `differences` | operational | row deleted |  |
| `fingerprint` | operational | row deleted |  |
| `observedAt` | operational | row deleted |  |
| `expiresAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `LifecycleOperation`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- Resolved operations are kept as the record that the work happened (retention removes them later); the input payload, which carries HR fields, is cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `personId` | identity | retained |  |
| `kind` | operational | retained |  |
| `idempotencyKey` | operational | retained |  |
| `status` | operational | retained |  |
| `attempt` | operational | retained |  |
| `input` | operational | cleared |  |
| `inputFingerprint` | operational | retained |  |
| `ownerUserId` | identity | retained |  |
| `priority` | operational | retained |  |
| `dueAt` | operational | retained |  |
| `acknowledgedAt` | operational | retained |  |
| `startedAt` | operational | retained |  |
| `completedAt` | operational | retained |  |
| `approvalRequired` | operational | retained |  |
| `approvalReason` | operational | cleared |  |
| `requestedByUserId` | identity | retained |  |
| `approvedAt` | operational | retained |  |
| `approvedByUserId` | identity | retained |  |
| `rejectedAt` | operational | retained |  |
| `rejectedByUserId` | identity | retained |  |
| `rejectionReason` | operational | cleared |  |
| `sloMinutes` | operational | retained |  |
| `sloDeadlineAt` | operational | retained |  |
| `sloBreachedAt` | operational | retained |  |
| `escalatedAt` | operational | retained |  |
| `escalatedToUserId` | identity | retained |  |
| `caseStatus` | operational | retained |  |
| `resolvedAt` | operational | retained |  |
| `resolvedByUserId` | identity | retained |  |
| `resolutionCode` | operational | retained |  |
| `resolutionSummary` | operational | cleared |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `LifecycleSimulation`

Linked to a data subject by person: `personId`. Erasure: **delete** -- A rehearsal; retention removes these anyway.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `kind` | operational | row deleted |  |
| `scope` | operational | row deleted |  |
| `personId` | identity | row deleted |  |
| `department` | operational | row deleted |  |
| `input` | operational | row deleted |  |
| `result` | operational | row deleted |  |
| `peopleCount` | operational | row deleted |  |
| `writesPerformed` | operational | row deleted |  |
| `createdByUserId` | identity | row deleted |  |
| `createdAt` | operational | row deleted |  |
| `expiresAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `LifecycleStep`

Linked to a data subject by operation: `operationId`. Erasure: **pseudonymize** -- Evidence and messages are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `operationId` | operational | retained |  |
| `key` | operational | retained |  |
| `title` | operational | retained |  |
| `position` | operational | retained |  |
| `required` | operational | retained |  |
| `status` | operational | retained |  |
| `message` | operational | cleared |  |
| `evidence` | operational | cleared |  |
| `responseCategory` | operational | retained |  |
| `startedAt` | operational | retained |  |
| `completedAt` | operational | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `LifecycleStepAttempt`

Linked to a data subject by operation: `operationId`. Erasure: **pseudonymize** -- Evidence and messages are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `operationId` | operational | retained |  |
| `stepId` | operational | retained |  |
| `stepKey` | operational | retained |  |
| `attempt` | operational | retained |  |
| `status` | operational | retained |  |
| `message` | operational | cleared |  |
| `evidence` | operational | cleared |  |
| `responseCategory` | operational | retained |  |
| `startedAt` | operational | retained |  |
| `completedAt` | operational | retained |  |
| `recordedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `PersonProvisionReceipt`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- Kept for its status and target; the evidence and message, which can name the person, are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `personId` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `requestKey` | operational | retained |  |
| `targetName` | operational | retained |  |
| `status` | operational | retained |  |
| `jobId` | operational | retained |  |
| `runId` | operational | retained |  |
| `runIds` | operational | retained |  |
| `evidence` | operational | cleared |  |
| `message` | operational | cleared |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

### Run history

- **Purpose.** Show what an import, sync, provisioning run or sweep proposed and did, so an administrator can review it before it applies and explain it afterwards.
- **Source.** The product, from HR feeds, directories and target systems.
- **Retention.** For as long as the source or target exists; before/after values are cleared by a data-subject erasure; removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legitimate interests in accountable access management (6(1)(f)).
- **Access.** `sync.read`, `provision.read`, `automate.read`.

#### `DriftFinding`

Linked to a data subject by account: `accountId`. Erasure: **pseudonymize** -- The detail (target attribute values) is cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `runId` | operational | retained |  |
| `accountId` | identity | retained |  |
| `entitlementId` | operational | retained |  |
| `subjectAnchor` | identity | retained |  |
| `kind` | operational | retained |  |
| `detail` | operational | cleared |  |
| `status` | operational | retained |  |
| `fingerprint` | operational | retained |  |
| `firstSeenAt` | operational | retained |  |
| `lastSeenAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ExpirySweep`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `status` | operational |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `expireCount` | operational |  |  |
| `lapseCount` | operational |  |  |
| `reviewFlagCount` | operational |  |  |
| `personsWithActiveContract` | operational |  |  |
| `personsUnprocessable` | operational |  |  |
| `internalGrantsInTenant` | operational |  |  |
| `requiresConfirmation` | operational |  |  |
| `blockedReason` | operational |  |  |
| `confirmedByUserId` | identity |  |  |
| `error` | operational |  |  |

Not personal data: `tenantId`.

#### `PersonDuplicateReview`

Linked to a data subject by person: `candidatePersonId`. Erasure: **pseudonymize** -- The matched value (a name or address) and the reviewer's note are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `runId` | operational | retained |  |
| `changeId` | operational | retained |  |
| `candidatePersonId` | identity | retained |  |
| `matchKind` | operational | retained |  |
| `matchedValue` | operational | replaced by `[erased]` |  |
| `status` | operational | retained |  |
| `resolution` | operational | retained |  |
| `note` | operational | cleared |  |
| `reviewedByUserId` | identity | retained |  |
| `reviewedAt` | operational | retained |  |
| `restoreStatus` | operational | retained |  |
| `restoreBlockedReason` | operational | retained |  |
| `restoreRequiresConfirmation` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `PersonImportChange`

Linked to a data subject by any: `targetId`. Erasure: **pseudonymize** -- Kept as the record of what an import did; the before and after values and the message are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `runId` | operational | retained |  |
| `changeType` | operational | retained |  |
| `recordType` | operational | retained |  |
| `targetId` | operational | retained |  |
| `externalId` | identity | retained |  |
| `before` | operational | cleared |  |
| `after` | operational | cleared |  |
| `status` | operational | retained |  |
| `message` | operational | cleared |  |

Not personal data: `tenantId`.

#### `PersonImportRun`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `sourceId` | operational |  |  |
| `status` | operational |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `recordsRead` | operational |  |  |
| `requiresConfirmation` | operational |  |  |
| `blockedReason` | operational |  |  |
| `error` | operational |  |  |
| `mappingFailures` | operational |  |  |
| `mappingFailureReasons` | operational |  |  |
| `personsAbsent` | operational |  |  |
| `confirmedBy` | identity |  |  |
| `cancelState` | operational |  |  |
| `cancelRequestedAt` | operational |  |  |
| `cancelRequestedByUserId` | identity |  |  |
| `cancelResolvedAt` | operational |  |  |

Not personal data: `tenantId`.

#### `ProvisionAction`

Linked to a data subject by person: `personId`; account: `accountId`. Erasure: **pseudonymize** -- Kept as the record of what was done to the account; the before and after attribute values and the message are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `runId` | operational | retained |  |
| `actionType` | operational | retained |  |
| `personId` | identity | retained |  |
| `accountId` | identity | retained |  |
| `entitlementId` | operational | retained |  |
| `before` | operational | cleared |  |
| `after` | operational | cleared |  |
| `attributedRuleIds` | operational | retained |  |
| `revocationOrderId` | operational | retained |  |
| `grantId` | operational | retained |  |
| `sequence` | operational | retained |  |
| `status` | operational | retained |  |
| `attempts` | operational | retained |  |
| `nextAttemptAt` | operational | retained |  |
| `message` | operational | cleared |  |
| `appliedAt` | operational | retained |  |
| `requiresConfirmation` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ProvisionException`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- The message names the person and is replaced.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `runId` | operational | retained |  |
| `personId` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `kind` | operational | retained |  |
| `message` | operational | replaced by `[erased]` |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ProvisionRun`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `targetSystemId` | operational |  |  |
| `status` | operational |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `lastProgressAt` | operational |  |  |
| `createAccountCount` | operational |  |  |
| `updateAccountCount` | operational |  |  |
| `enableAccountCount` | operational |  |  |
| `disableAccountCount` | operational |  |  |
| `archiveAccountCount` | operational |  |  |
| `renameAccountCount` | operational |  |  |
| `grantEntitlementCount` | operational |  |  |
| `revokeEntitlementCount` | operational |  |  |
| `deactivateSyntraUserCount` | operational |  |  |
| `reactivateSyntraUserCount` | operational |  |  |
| `personsEvaluated` | operational |  |  |
| `personsWithActiveContract` | operational |  |  |
| `personsUnprocessable` | operational |  |  |
| `accountsReadFromTarget` | operational |  |  |
| `entitlementsReadFromTarget` | operational |  |  |
| `requiresConfirmation` | operational |  |  |
| `blockedReason` | operational |  |  |
| `confirmedByUserId` | identity |  |  |
| `error` | operational |  |  |
| `cancelState` | operational |  |  |
| `cancelRequestedAt` | operational |  |  |
| `cancelRequestedByUserId` | identity |  |  |
| `cancelResolvedAt` | operational |  |  |
| `adapterVersion` | operational |  |  |
| `capabilityRefusedCount` | operational |  |  |
| `capabilityRefusal` | operational |  |  |

Not personal data: `tenantId`.

#### `SweepAction`

Linked to a data subject by person: `subjectPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `sweepId` | operational | retained |  |
| `grantId` | operational | retained |  |
| `kind` | operational | retained |  |
| `productId` | operational | retained |  |
| `subjectPersonId` | identity | retained |  |
| `resourceType` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `targetSystemId` | operational | retained |  |
| `status` | operational | retained |  |
| `provisionActionId` | operational | retained |  |
| `message` | operational | retained |  |

Not personal data: `tenantId`.

#### `SweepException`

Linked to a data subject by person: `personId`. Erasure: **pseudonymize** -- The message can name the person and is replaced.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `sweepId` | operational | retained |  |
| `personId` | identity | retained |  |
| `kind` | operational | retained |  |
| `message` | operational | replaced by `[erased]` |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `SyncChange`

Linked to a data subject by any: `targetId`. Erasure: **pseudonymize** -- Kept as the record of what a sync did; the before and after values are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `runId` | operational | retained |  |
| `changeType` | operational | retained |  |
| `targetType` | operational | retained |  |
| `targetId` | operational | retained |  |
| `sourceAnchor` | operational | retained |  |
| `before` | operational | cleared |  |
| `after` | operational | cleared |  |
| `status` | operational | retained |  |
| `message` | operational | cleared |  |

Not personal data: `tenantId`.

#### `SyncRun`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `sourceId` | operational |  |  |
| `status` | operational |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `recordsRead` | operational |  |  |
| `requiresConfirmation` | operational |  |  |
| `blockedReason` | operational |  |  |
| `error` | operational |  |  |
| `unresolvedMembers` | operational |  |  |
| `mappingFailures` | operational |  |  |
| `mappingFailureReasons` | operational |  |  |
| `cancelState` | operational |  |  |
| `cancelRequestedAt` | operational |  |  |
| `cancelRequestedByUserId` | identity |  |  |
| `cancelResolvedAt` | operational |  |  |

Not personal data: `tenantId`.

### Access requests and grants

- **Purpose.** Record who asked for which access, who approved it and what was granted, as access-governance evidence.
- **Source.** People requesting access, approvers, and administrators.
- **Retention.** For as long as the tenant exists (governance evidence); free text is cleared by a data-subject erasure; removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legal obligation (e.g. internal-control regimes) and legitimate interests (6(1)(c), 6(1)(f)).
- **Access.** `automate.read`, `automate.manage`; the requester and approvers themselves.

#### `AccessGrant`

Linked to a data subject by person: `subjectPersonId`, `approvedByPersonId`. Erasure: **retain** -- Access-governance evidence: what was granted, when and on whose approval. Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `subjectPersonId` | identity | retained |  |
| `resourceType` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `targetSystemId` | operational | retained |  |
| `origin` | operational | retained |  |
| `requestId` | operational | retained |  |
| `productId` | operational | retained |  |
| `startsAt` | operational | retained |  |
| `endsAt` | operational | retained |  |
| `status` | operational | retained |  |
| `statusReason` | operational | retained |  |
| `needsReview` | operational | retained |  |
| `reviewReason` | operational | retained |  |
| `reviewedAt` | operational | retained |  |
| `supersededByGrantId` | operational | retained |  |
| `approvedByPersonId` | identity | retained |  |
| `writtenRowIds` | operational | retained |  |
| `createdAt` | operational | retained |  |
| `endedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `AccessRequest`

Linked to a data subject by person: `subjectPersonId`, `requestedByPersonId`; user: `requestedByUserId`. Erasure: **pseudonymize** -- Kept as access-governance evidence (who asked for what, and the outcome); the justification and form values the person typed are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `productId` | operational | retained |  |
| `subjectPersonId` | identity | retained |  |
| `requestedByUserId` | identity | retained |  |
| `requestedByPersonId` | identity | retained |  |
| `origin` | operational | retained |  |
| `resourceType` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `justification` | operational | cleared |  |
| `formValues` | operational | cleared |  |
| `requestedDurationDays` | operational | retained |  |
| `replacesGrantId` | operational | retained |  |
| `status` | operational | retained |  |
| `statusReason` | operational | cleared |  |
| `submittedAt` | operational | retained |  |
| `decidedAt` | operational | retained |  |
| `fulfilledAt` | operational | retained |  |
| `dispatchedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ApprovalDecision`

Linked to a data subject by person: `personId`, `onBehalfOfPersonId`; user: `userId`. Erasure: **retain** -- Append-only at the database (no update, no delete): an approval decision is access-governance evidence. The comment is retained; it is also in the audit log.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `stepId` | operational | retained |  |
| `personId` | identity | retained |  |
| `userId` | identity | retained |  |
| `decision` | operational | retained |  |
| `comment` | operational | retained |  |
| `shortenedToDays` | operational | retained |  |
| `via` | operational | retained |  |
| `onBehalfOfPersonId` | identity | retained |  |
| `decidedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ApprovalDelegation`

Linked to a data subject by person: `delegatorPersonId`, `delegatePersonId`. Erasure: **retain** -- Identifiers and dates only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `delegatorPersonId` | identity | retained |  |
| `delegatePersonId` | identity | retained |  |
| `category` | operational | retained |  |
| `startsAt` | operational | retained |  |
| `endsAt` | operational | retained |  |
| `createdByUserId` | identity | retained |  |
| `revokedAt` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ApprovalStep`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `requestId` | operational |  |  |
| `sequence` | operational |  |  |
| `stageSnapshot` | operational |  |  |
| `status` | operational |  |  |
| `openedAt` | operational |  |  |
| `closedAt` | operational |  |  |
| `slaDueAt` | operational |  |  |
| `escalatedAt` | operational |  |  |
| `lastRemindedAt` | operational |  |  |

Not personal data: `tenantId`.

#### `ApprovalStepApprover`

Linked to a data subject by person: `personId`, `onBehalfOfPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `stepId` | operational | retained |  |
| `personId` | identity | retained |  |
| `via` | operational | retained |  |
| `onBehalfOfPersonId` | identity | retained |  |
| `addedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `DelegatedTaskRun`

Linked to a data subject by user: `subjectUserId`, `runByUserId`. Erasure: **pseudonymize** -- The submitted form values are cleared.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `taskId` | operational | retained |  |
| `runByUserId` | identity | retained |  |
| `subjectUserId` | identity | retained |  |
| `values` | operational | cleared |  |
| `outcome` | operational | retained |  |
| `message` | operational | replaced by `[erased]` |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `RequestItem`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `requestId` | operational |  |  |
| `resourceType` | operational |  |  |
| `resourceId` | operational |  |  |
| `targetSystemId` | operational |  |  |
| `status` | operational |  |  |
| `provisionActionId` | operational |  |  |
| `grantId` | operational |  |  |
| `message` | operational |  |  |

Not personal data: `tenantId`.

### Notifications

- **Purpose.** Deliver email and webhook notifications about access and lifecycle events.
- **Source.** The product.
- **Retention.** Removed by the lifecycle retention job once sent (`notificationRetentionDays`); removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legitimate interests (6(1)(f)).
- **Access.** No administrative screen reads message bodies.

#### `NotificationOutbox`

Linked to a data subject by user: `userId`; identifier: `to`. Erasure: **pseudonymize** -- The recipient address and the template variables are replaced, and an unsent message is stopped.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `template` | operational | retained |  |
| `to` | contact | pseudonym `erased-<id>@erased.invalid` |  |
| `vars` | operational | cleared |  |
| `requestId` | operational | retained |  |
| `userId` | identity | retained |  |
| `attempts` | operational | retained |  |
| `lastError` | operational | replaced by `erased by a data-subject request` |  |
| `sentAt` | operational | retained |  |
| `digest` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `NotificationPreference`

Linked to a data subject by user: `userId`. Erasure: **retain** -- A delivery mode only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `userId` | identity | retained |  |
| `mode` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `WebhookDelivery`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `endpointId` | operational |  |  |
| `event` | operational |  |  |
| `payload` | operational |  |  |
| `attempts` | operational |  |  |
| `nextAttemptAt` | operational |  |  |
| `deliveredAt` | operational |  |  |
| `lastStatus` | operational |  |  |
| `lastError` | operational |  |  |
| `createdAt` | operational |  |  |

Not personal data: `tenantId`.

### Access governance

- **Purpose.** Snapshot who holds what, review and certify it, and record findings and revocations.
- **Source.** Govern snapshots of directories and targets; reviewers and administrators.
- **Retention.** Snapshots and what hangs off them are removed by Govern snapshot retention (`snapshotRetentionDays`); decisions and certifications are governance evidence kept with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legal obligation (internal-control and audit regimes) and legitimate interests (6(1)(c), 6(1)(f)).
- **Access.** `govern.read` (scopeable), `govern.manage`, `govern.export`.

#### `AccessSnapshot`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `kind` | operational |  |  |
| `status` | operational |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `asOf` | operational |  |  |
| `scope` | operational |  |  |
| `holdingCount` | operational |  |  |
| `unattributableCount` | operational |  |  |
| `coverageGapCount` | operational |  |  |
| `unattributedAccountCount` | operational |  |  |
| `personCount` | operational |  |  |
| `personsWithActiveContract` | operational |  |  |
| `countsByResourceKind` | operational |  |  |
| `error` | operational |  |  |

Not personal data: `tenantId`.

#### `AccountAttribution`

Linked to a data subject by person: `proposedPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `systemId` | operational | retained |  |
| `accountRef` | identity | retained |  |
| `proposedPersonId` | identity | retained |  |
| `method` | operational | retained |  |
| `confidence` | operational | retained |  |
| `status` | operational | retained |  |
| `decidedByUserId` | identity | retained |  |
| `decidedAt` | operational | retained |  |
| `decidedReason` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `Campaign`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `name` | operational | retained |  |
| `description` | operational | retained |  |
| `scope` | operational | retained |  |
| `snapshotId` | operational | retained |  |
| `rebasedFromSnapshotId` | operational | retained |  |
| `reviewerSelector` | operational | retained |  |
| `reviewerConfig` | operational | retained |  |
| `fallbackSelector` | operational | retained |  |
| `fallbackConfig` | operational | retained |  |
| `ownerPersonId` | identity | retained |  |
| `opensAt` | operational | retained |  |
| `dueAt` | operational | retained |  |
| `originalDueAt` | operational | retained |  |
| `extensionCount` | operational | retained |  |
| `recurrence` | operational | retained |  |
| `allowBulkCertify` | operational | retained |  |
| `status` | operational | retained |  |
| `totalItems` | operational | retained |  |
| `certifiedItems` | operational | retained |  |
| `revokedItems` | operational | retained |  |
| `revokeDecidedItems` | operational | retained |  |
| `dispatchedItems` | operational | retained |  |
| `failedItems` | operational | retained |  |
| `mootItems` | operational | retained |  |
| `undecidedItems` | operational | retained |  |
| `blockedItems` | operational | retained |  |
| `requiresChangeItems` | operational | retained |  |
| `coveragePercent` | operational | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `CampaignDecision`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Append-only at the database: a review decision is access-governance evidence.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `itemId` | operational | retained |  |
| `personId` | identity | retained |  |
| `decidedByUserId` | identity | retained |  |
| `decision` | operational | retained |  |
| `comment` | operational | retained |  |
| `itemOpenedAt` | operational | retained |  |
| `decidedAt` | operational | retained |  |
| `neverOpened` | operational | retained |  |
| `viaBulk` | operational | retained |  |
| `bulkSize` | operational | retained |  |
| `sessionDecisionOrdinal` | operational | retained |  |
| `coverageAtDecision` | operational | retained |  |

Not personal data: `tenantId`.

#### `CampaignItem`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Access-review evidence.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `campaignId` | operational | retained |  |
| `holdingSnapshotId` | operational | retained |  |
| `subjectKey` | identity | retained |  |
| `personId` | identity | retained |  |
| `accountRef` | identity | retained |  |
| `systemId` | operational | retained |  |
| `resourceKind` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `resourceName` | operational | retained |  |
| `attributions` | operational | retained |  |
| `observedAt` | operational | retained |  |
| `coverageStatus` | operational | retained |  |
| `riskFlags` | operational | retained |  |
| `status` | operational | retained |  |
| `statusReason` | operational | retained |  |
| `outcomeRef` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `CampaignItemReviewer`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Access-review evidence.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `itemId` | operational | retained |  |
| `personId` | identity | retained |  |
| `via` | operational | retained |  |
| `assignedAt` | operational | retained |  |
| `unassignedAt` | operational | retained |  |
| `unassignedReason` | operational | retained |  |
| `lastRemindedAt` | operational | retained |  |
| `openedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `CoverageGap`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Snapshot evidence; removed with the snapshot.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `snapshotId` | operational | retained |  |
| `kind` | operational | retained |  |
| `systemKind` | operational | retained |  |
| `systemId` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `personId` | identity | retained |  |
| `accountRef` | identity | retained |  |
| `reason` | operational | retained |  |
| `sourceRunId` | operational | retained |  |

Not personal data: `tenantId`.

#### `EvidencePack`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `kind` | operational |  |  |
| `scope` | operational |  |  |
| `snapshotId` | operational |  |  |
| `campaignId` | operational |  |  |
| `chainHeadSequence` | operational |  |  |
| `chainHeadHash` | operational |  |  |
| `chainVerificationResult` | operational |  |  |
| `chainFromSequence` | operational |  |  |
| `chainToSequence` | operational |  |  |
| `digest` | operational |  |  |
| `storageRef` | operational |  |  |
| `byteLength` | operational |  |  |
| `createdByUserId` | identity |  |  |
| `createdAt` | operational |  |  |

Not personal data: `tenantId`.

#### `GovernFinding`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `kind` | operational | retained |  |
| `severity` | operational | retained |  |
| `subjectRefType` | operational | retained |  |
| `subjectRefId` | operational | retained |  |
| `detail` | operational | retained |  |
| `driftFindingId` | operational | retained |  |
| `status` | operational | retained |  |
| `ownerPersonId` | identity | retained |  |
| `dueAt` | operational | retained |  |
| `acceptedReason` | operational | retained |  |
| `acceptedUntil` | operational | retained |  |
| `resolvedBySnapshotId` | operational | retained |  |
| `resolvedAt` | operational | retained |  |
| `firstSeenAt` | operational | retained |  |
| `lastSeenAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `Holding`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Access-review evidence frozen in a snapshot; removed with the snapshot by the Govern snapshot retention.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `snapshotId` | operational | retained |  |
| `subjectKey` | identity | retained |  |
| `personId` | identity | retained |  |
| `accountRef` | identity | retained |  |
| `systemKind` | operational | retained |  |
| `systemId` | operational | retained |  |
| `resourceKind` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `resourceName` | operational | retained |  |
| `state` | operational | retained |  |
| `privileged` | operational | retained |  |
| `observedAt` | operational | retained |  |
| `observedVia` | operational | retained |  |
| `firstSeenAt` | operational | retained |  |
| `attributionCount` | operational | retained |  |
| `unattributable` | operational | retained |  |

Not personal data: `tenantId`.

#### `HoldingAttribution`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `holdingId` | operational |  |  |
| `kind` | operational |  |  |
| `refType` | operational |  |  |
| `refId` | operational |  |  |
| `detail` | operational |  |  |
| `resolvedAt` | operational |  |  |

Not personal data: `tenantId`.

#### `HoldingCertification`

Linked to a data subject by person: `lastCertifiedByPersonId`. Erasure: **retain** -- Certification evidence: who last certified an access.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `subjectRefType` | operational | retained |  |
| `subjectRefId` | operational | retained |  |
| `systemId` | operational | retained |  |
| `resourceKind` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `lastCertifiedAt` | operational | retained |  |
| `lastCertifiedByPersonId` | identity | retained |  |
| `lastCampaignId` | operational | retained |  |
| `lastDecisionId` | operational | retained |  |

Not personal data: `tenantId`.

#### `HoldingEvent`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Snapshot evidence; removed with the snapshot.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `fromSnapshotId` | operational | retained |  |
| `toSnapshotId` | operational | retained |  |
| `subjectKey` | identity | retained |  |
| `personId` | identity | retained |  |
| `accountRef` | identity | retained |  |
| `systemId` | operational | retained |  |
| `resourceKind` | operational | retained |  |
| `resourceId` | operational | retained |  |
| `resourceName` | operational | retained |  |
| `change` | operational | retained |  |
| `beforeAttributions` | operational | retained |  |
| `afterAttributions` | operational | retained |  |
| `auditEventSequence` | operational | retained |  |
| `explained` | operational | retained |  |

Not personal data: `tenantId`.

#### `RemediationItem`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `kind` | operational | retained |  |
| `ownerPersonId` | identity | retained |  |
| `dueAt` | operational | retained |  |
| `findingId` | operational | retained |  |
| `campaignItemId` | operational | retained |  |
| `description` | operational | retained |  |
| `deepLink` | operational | retained |  |
| `status` | operational | retained |  |
| `resolutionComment` | operational | retained |  |
| `resolvedByUserId` | identity | retained |  |
| `resolvedAt` | operational | retained |  |
| `createdAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `ReviewQualitySignal`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Aggregate numbers about a reviewer.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `campaignId` | operational | retained |  |
| `personId` | identity | retained |  |
| `itemsAssigned` | operational | retained |  |
| `itemsDecided` | operational | retained |  |
| `certifiedShare` | operational | retained |  |
| `medianIntervalMs` | operational | retained |  |
| `bulkShare` | operational | retained |  |
| `largestBurst` | operational | retained |  |
| `largestBurstMs` | operational | retained |  |
| `neverOpenedShare` | operational | retained |  |
| `computedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `RevocationBatch`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `campaignId` | operational |  |  |
| `status` | operational |  |  |
| `proposedCount` | operational |  |  |
| `skippedCount` | operational |  |  |
| `dispatchedCount` | operational |  |  |
| `confirmedCount` | operational |  |  |
| `appliedCount` | operational |  |  |
| `failedCount` | operational |  |  |
| `requiresChangeCount` | operational |  |  |
| `cancelledCount` | operational |  |  |
| `requiresConfirmation` | operational |  |  |
| `blockedReason` | operational |  |  |
| `confirmedByUserId` | identity |  |  |
| `startedAt` | operational |  |  |
| `finishedAt` | operational |  |  |
| `error` | operational |  |  |

Not personal data: `tenantId`.

#### `RevocationDispatch`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `batchId` | operational |  |  |
| `itemId` | operational |  |  |
| `holdingDescriptor` | operational |  |  |
| `route` | operational |  |  |
| `status` | operational |  |  |
| `grantId` | operational |  |  |
| `revocationOrderId` | operational |  |  |
| `remediationItemId` | operational |  |  |
| `message` | operational |  |  |
| `sequence` | operational |  |  |
| `dispatchedAt` | operational |  |  |
| `confirmedAt` | operational |  |  |
| `appliedAt` | operational |  |  |

Not personal data: `tenantId`.

#### `RevocationOrder`

Linked to a data subject by person: `decidedByPersonId`. Erasure: **pseudonymize** -- The decider's name, copied onto the order when it was made, is replaced.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `targetSystemId` | operational | retained |  |
| `accountId` | identity | retained |  |
| `entitlementId` | operational | retained |  |
| `decidedByPersonId` | identity | retained |  |
| `campaignDecisionId` | operational | retained |  |
| `decidedByPersonName` | identity | replaced by `Erased person` |  |
| `campaignName` | operational | retained |  |
| `reason` | operational | retained |  |
| `status` | operational | retained |  |
| `cancelledReason` | operational | retained |  |
| `createdAt` | operational | retained |  |
| `plannedAt` | operational | retained |  |
| `appliedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `SnapshotSource`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity |  |  |
| `snapshotId` | operational |  |  |
| `sourceKind` | operational |  |  |
| `sourceId` | operational |  |  |
| `sourceName` | operational |  |  |
| `lastRunId` | operational |  |  |
| `lastSuccessfulReadAt` | operational |  |  |
| `lastAttemptedReadAt` | operational |  |  |
| `completeness` | operational |  |  |
| `staleness` | operational |  |  |
| `freshnessSlaHours` | operational |  |  |
| `gapCount` | operational |  |  |

Not personal data: `tenantId`.

#### `SodException`

Linked to a data subject by person: `personId`, `approvedByPersonId`. Erasure: **retain** -- Risk-acceptance evidence, including its justification.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `ruleId` | operational | retained |  |
| `personId` | identity | retained |  |
| `violationId` | operational | retained |  |
| `justification` | operational | retained |  |
| `compensatingControl` | operational | retained |  |
| `basisContractIds` | operational | retained |  |
| `approvalRequestId` | operational | retained |  |
| `approvedByPersonId` | identity | retained |  |
| `startsAt` | operational | retained |  |
| `endsAt` | operational | retained |  |
| `status` | operational | retained |  |
| `revokedReason` | operational | retained |  |
| `revokedByUserId` | identity | retained |  |
| `createdAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

#### `SodViolation`

Linked to a data subject by person: `personId`. Erasure: **retain** -- Risk evidence; identifiers only.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `ruleId` | operational | retained |  |
| `personId` | identity | retained |  |
| `holdingsA` | operational | retained |  |
| `holdingsB` | operational | retained |  |
| `contractsA` | operational | retained |  |
| `contractsB` | operational | retained |  |
| `severity` | operational | retained |  |
| `status` | operational | retained |  |
| `exceptionId` | operational | retained |  |
| `firstSeenAt` | operational | retained |  |
| `lastSeenAt` | operational | retained |  |
| `lastSnapshotId` | operational | retained |  |

Not personal data: `tenantId`.

### Audit record

- **Purpose.** A tamper-evident record of who did what, when, from where.
- **Source.** Every administrative and authentication action.
- **Retention.** Immutable to the application. Leaves only through the database-owner archive-and-prune procedure after the tenant's `auditRetentionDays`, at or before a verified checkpoint. Kept even after a data-subject erasure and a tenant deletion.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legal obligation and legitimate interests in security and accountability (6(1)(c), 6(1)(f)).
- **Access.** `audit.read`.

#### `AuditAnchor`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | audit |  |  |
| `sequence` | audit |  |  |
| `hash` | audit |  |  |
| `anchoredAt` | audit |  |  |
| `method` | audit |  |  |
| `receipt` | audit |  |  |
| `status` | audit |  |  |
| `error` | audit |  |  |

Not personal data: `tenantId`.

#### `AuditChainCheck`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | audit |  |  |
| `fromSequence` | audit |  |  |
| `toSequence` | audit |  |  |
| `result` | audit |  |  |
| `brokenAtSequence` | audit |  |  |
| `startedAt` | audit |  |  |
| `durationMs` | audit |  |  |
| `mode` | audit |  |  |

Not personal data: `tenantId`.

#### `AuditCheckpoint`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | audit |  |  |
| `sequence` | audit |  |  |
| `hash` | audit |  |  |
| `verifiedAt` | audit |  |  |
| `signature` | audit |  |  |
| `keyId` | audit |  |  |

Not personal data: `tenantId`.

#### `AuditEvent`

Linked to a data subject by user: `actorUserId`; any: `targetId`. Erasure: **retain** -- Immutable to the application (`audit_no_update`, `audit_no_delete`) and hash-chained. Payloads can name the person; they leave through the database-owner archive-and-prune procedure once the tenant's audit retention period ends, at or before a verified checkpoint.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | audit | retained |  |
| `sequence` | audit | retained |  |
| `occurredAt` | audit | retained |  |
| `actorUserId` | identity | retained |  |
| `action` | audit | retained |  |
| `targetType` | audit | retained |  |
| `targetId` | audit | retained |  |
| `outcome` | audit | retained |  |
| `sourceIp` | audit | retained |  |
| `payload` | audit | retained |  |
| `prevHash` | audit | retained |  |
| `hash` | audit | retained |  |
| `correlationId` | audit | retained |  |

Not personal data: `tenantId`.

### Exports and saved searches

- **Purpose.** Record who took which copy of tenant data, and keep an administrator's saved filters.
- **Source.** Administrators.
- **Retention.** The file is erased 1-72 hours after it is ready; the row is kept as the record of who took what.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legitimate interests in accountability (6(1)(f)).
- **Access.** The requester; `tenant.manage` for everybody's.

#### `AuditSavedView`

Linked to a data subject by user: `userId`. Erasure: **delete** -- The person's own saved search filters.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | row deleted |  |
| `userId` | identity | row deleted |  |
| `name` | operational | row deleted |  |
| `filters` | operational | row deleted |  |
| `createdAt` | operational | row deleted |  |
| `updatedAt` | operational | row deleted |  |

Not personal data: `tenantId`.

#### `DataExport`

Linked to a data subject by user: `requestedByUserId`. Erasure: **retain** -- The record of who took which copy. An access bundle about the person that still holds a file has the file erased (see the erasure procedure).

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `kind` | operational | retained |  |
| `status` | operational | retained |  |
| `params` | operational | retained |  |
| `format` | operational | retained |  |
| `requestedByUserId` | identity | retained |  |
| `requestedViaToken` | operational | retained |  |
| `requestedAt` | operational | retained |  |
| `ttlHours` | operational | retained |  |
| `startedAt` | operational | retained |  |
| `completedAt` | operational | retained |  |
| `expiresAt` | operational | retained |  |
| `authorityFingerprint` | operational | retained |  |
| `rowCount` | operational | retained |  |
| `byteLength` | operational | retained |  |
| `sha256` | operational | retained |  |
| `filename` | operational | retained |  |
| `contentType` | operational | retained |  |
| `error` | operational | retained |  |
| `ciphertext` | authentication | retained | secret |
| `iv` | authentication | retained | secret |
| `tag` | authentication | retained | secret |
| `wrappedDek` | authentication | retained | secret |
| `dekIv` | authentication | retained | secret |
| `dekTag` | authentication | retained | secret |
| `revokedAt` | operational | retained |  |
| `revokedByUserId` | identity | retained |  |
| `purgedAt` | operational | retained |  |
| `downloadCount` | operational | retained |  |
| `lastDownloadedAt` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

### Data-subject requests

- **Purpose.** Record a data-subject request, how the requester was verified and what was done about it.
- **Source.** Privacy administrators.
- **Retention.** Kept with the tenant as the evidence the request was handled (accountability, art. 5(2)); removed with the tenant.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Typically legal obligation (6(1)(c)).
- **Access.** `privacy.manage`.

#### `PrivacyCase`

Linked to a data subject by person: `personId`. Erasure: **retain** -- The record that the request was received, verified and handled (accountability, GDPR art. 5(2)).

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `id` | identity | retained |  |
| `personId` | identity | retained |  |
| `reference` | operational | retained |  |
| `status` | operational | retained |  |
| `requestTypes` | operational | retained |  |
| `reason` | operational | retained |  |
| `receivedAt` | operational | retained |  |
| `dueAt` | operational | retained |  |
| `verificationMethod` | operational | retained |  |
| `verificationAttestation` | operational | retained |  |
| `verifiedByUserId` | identity | retained |  |
| `openedByUserId` | identity | retained |  |
| `openedAt` | operational | retained |  |
| `accessExportId` | operational | retained |  |
| `erasureStatus` | operational | retained |  |
| `erasureRequestedByUserId` | identity | retained |  |
| `erasureRequestedAt` | operational | retained |  |
| `erasureApprovedByUserId` | identity | retained |  |
| `erasureApprovedAt` | operational | retained |  |
| `erasureApproverStepUpAt` | operational | retained |  |
| `erasureCompletedAt` | operational | retained |  |
| `erasureCancelledByUserId` | identity | retained |  |
| `erasureCancelledAt` | operational | retained |  |
| `erasureReceipt` | operational | retained |  |
| `closedAt` | operational | retained |  |
| `closedByUserId` | identity | retained |  |
| `closureNote` | operational | retained |  |
| `updatedAt` | operational | retained |  |

Not personal data: `tenantId`.

### Configuration

- **Purpose.** How the tenant is set up. Not personal data, except columns naming the administrator who changed something or a person given a role in the configuration (classified `identity`).
- **Source.** Administrators.
- **Retention.** For as long as the tenant exists.
- **Legal basis.** PLACEHOLDER -- to be confirmed by the controller. Only the administrator references are personal data; typically legitimate interests (6(1)(f)).
- **Access.** The permission of the owning module.

#### `AccountProfile`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `sensitiveApprovedByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `targetSystemId`, `correlationKeyTemplate`, `uniquenessStrategy`, `maxUniquenessAttempts`, `containerTemplate`, `fallbackContainer`, `attributeTemplates`, `initialPasswordPolicy`, `initialPasswordDelivery`, `sensitiveApprovalReason`, `sensitiveApprovedAt`, `createdAt`, `updatedAt`.

#### `Application`

No personal data. Columns: `id`, `tenantId`, `name`, `slug`, `description`, `iconUrl`, `launchUrl`, `type`, `category`, `catalogKey`, `visibility`, `status`, `createdAt`, `updatedAt`.

#### `ApprovalStage`

No personal data. Columns: `id`, `tenantId`, `workflowId`, `sequence`, `name`, `selector`, `selectorConfig`, `quorum`, `fallbackSelector`, `fallbackConfig`, `slaHours`, `onTimeout`, `escalationSelector`, `escalationConfig`, `expiryHours`.

#### `ApprovalWorkflow`

No personal data. Columns: `id`, `tenantId`, `name`, `description`, `enabled`, `createdAt`, `updatedAt`.

#### `AttributeMapping`

No personal data. Columns: `id`, `tenantId`, `sourceId`, `objectType`, `sourceAttribute`, `targetField`, `transform`, `isCorrelation`.

#### `AuthPolicy`

No personal data. Columns: `id`, `tenantId`, `defaultOutcome`, `defaultFactorType`, `updatedAt`.

#### `AuthPolicyRule`

No personal data. Columns: `id`, `tenantId`, `policyId`, `position`, `name`, `enabled`, `outcome`, `factorType`, `applicationIds`, `groupIds`, `contractField`, `contractValues`, `ipRanges`, `devicePlatforms`, `countries`, `daysOfWeek`, `startMinute`, `endMinute`, `timezone`, `upstreamIdpId`, `loginDomains`.

#### `AutomateSettings`

No personal data. Columns: `id`, `tenantId`, `sweepSchedule`, `sweepThresholdPercent`, `perProductSweepThresholdPercent`, `personPopulationDropPercent`, `fulfilmentSlaHours`, `expiryWarningDays`, `preHireHorizonDays`, `maxDelegationDays`, `maxApprovers`, `delegatedBulkLimit`, `lastAppliedSweepAt`, `personsWithActiveContractAtLastSweep`, `createdAt`, `updatedAt`.

#### `BusinessFunction`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Configuration naming the person as an owner.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `ownerPersonId` | identity | retained |  |

Not personal data: `id`, `tenantId`, `name`, `description`, `createdAt`, `updatedAt`.

#### `BusinessFunctionResource`

No personal data. Columns: `id`, `tenantId`, `functionId`, `systemId`, `resourceKind`, `resourceId`.

#### `BusinessRule`

No personal data. Columns: `id`, `tenantId`, `targetSystemId`, `name`, `description`, `condition`, `grantsAccount`, `enabled`, `createdAt`, `updatedAt`.

#### `ClaimMapping`

No personal data. Columns: `id`, `tenantId`, `applicationId`, `protocol`, `claimName`, `nameFormat`, `sourceKind`, `sourceField`, `contractStrategy`, `literalValue`, `releaseScope`, `multiValued`, `createdAt`.

#### `ClaimMappingSet`

No personal data. Columns: `id`, `tenantId`, `name`, `description`, `protocol`, `mappings`, `createdAt`, `updatedAt`.

#### `ConnectionReadinessCheck`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `actorUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `systemKind`, `systemId`, `configurationFingerprint`, `capabilities`, `status`, `latencyMs`, `message`, `checkedAt`.

#### `DelegatedTask`

No personal data. Columns: `id`, `tenantId`, `name`, `description`, `actionKey`, `formSchema`, `audienceCondition`, `enabled`, `createdAt`, `updatedAt`.

#### `DirectorySource`

No personal data. Columns: `id`, `tenantId`, `name`, `type`, `config`, `secretName`, `schedule`, `autoApply`, `deactivationThresholdPercent`, `enabled`, `writebackEnabled`, `writebackPassword`, `writebackDisable`, `writebackDelete`, `lastRunAt`, `createdAt`, `updatedAt`.

#### `Entitlement`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `displayName` | identity |  |  |

Not personal data: `id`, `tenantId`, `targetSystemId`, `externalId`, `dn`, `type`, `description`, `status`, `holderCount`, `requestable`, `lastSeenAt`, `manageable`, `unmanageableReason`, `membershipKind`, `privileged`, `createdAt`, `updatedAt`.

#### `GovernSettings`

No personal data. Columns: `id`, `tenantId`, `snapshotSchedule`, `snapshotRetentionDays`, `defaultFreshnessSlaHours`, `maxSnapshotAgeDays`, `batchThresholdPercent`, `perResourceThresholdPercent`, `personPopulationDropPercent`, `minimumCoveragePercent`, `bulkCertifyLimit`, `dispatchSlaHours`, `privilegedRecertifyDays`, `maxExceptionDays`, `exceptionWarningDays`, `minReciprocalDecisions`, `reciprocityWindowDays`, `lastAppliedBatchAt`, `personsWithActiveContractAtLastBatch`, `createdAt`, `updatedAt`.

#### `GovernSourcePolicy`

No personal data. Columns: `id`, `tenantId`, `sourceKind`, `sourceId`, `freshnessSlaHours`, `inDefaultScope`, `createdAt`, `updatedAt`.

#### `Group`

No personal data. Columns: `id`, `tenantId`, `name`, `description`, `sourceId`, `sourceAnchor`, `status`, `statusReason`.

#### `IdentityReferenceValue`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `createdByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `kind`, `value`, `normalizedValue`, `active`, `createdAt`, `updatedAt`.

#### `LifecyclePolicy`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `escalationOwnerUserId` | identity |  |  |
| `updatedByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `requireApprovalForAccountCreation`, `requireApprovalForPrivilegedGroups`, `privilegedGroupPatterns`, `requireApprovalForUrgentDeparture`, `requireApprovalForBulkRequeue`, `bulkRequeueThreshold`, `maxConcurrentTargetOperations`, `urgentLeaverSloMinutes`, `onboardSloHours`, `moveSloHours`, `offboardSloHours`, `notifyOnFailure`, `notifyOnOverdue`, `notifyOnAccessBlocked`, `receiptRetentionDays`, `observationRetentionDays`, `notificationRetentionDays`, `simulationRetentionDays`, `lifecycleOperationRetentionDays`, `auditRetentionDays`, `createdAt`, `updatedAt`.

#### `OidcClient`

No personal data. Columns: `id`, `tenantId`, `applicationId`, `clientId`, `clientSecretHash`, `redirectUris`, `postLogoutRedirectUris`, `backchannelLogoutUri`, `backchannelLogoutSessionRequired`, `grantTypes`, `clientCredentialsEnabled`, `scopes`, `requirePkce`, `tokenEndpointAuthMethod`, `idTokenSignedResponseAlg`, `accessTokenTtlSeconds`, `refreshTokenTtlSeconds`, `createdAt`, `updatedAt`.

#### `OrgUnit`

No personal data. Columns: `id`, `tenantId`, `name`, `parentId`, `sourceId`, `sourceAnchor`, `status`, `statusReason`.

#### `OrgUnitContainer`

No personal data. Columns: `id`, `tenantId`, `orgUnitId`, `targetSystemId`, `dn`, `anchor`, `state`, `createdAt`, `updatedAt`.

#### `PersonFieldMapping`

No personal data. Columns: `id`, `tenantId`, `sourceId`, `recordType`, `sourceColumn`, `targetField`, `transform`, `isCorrelation`.

#### `PersonSource`

No personal data. Columns: `id`, `tenantId`, `name`, `type`, `config`, `secretName`, `feedMode`, `schedule`, `autoApply`, `deactivationThresholdPercent`, `enabled`, `lastRunAt`, `createdAt`, `updatedAt`.

#### `Product`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Configuration naming the person as an owner.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `ownerPersonId` | identity | retained |  |

Not personal data: `id`, `tenantId`, `name`, `slug`, `description`, `category`, `iconUrl`, `requestInstructions`, `kind`, `audienceCondition`, `workflowId`, `formSchema`, `durationMode`, `defaultDurationDays`, `maxDurationDays`, `ownerGroupId`, `status`, `createdAt`, `updatedAt`.

#### `ProductGrant`

No personal data. Columns: `id`, `tenantId`, `productId`, `resourceType`, `resourceId`, `targetSystemId`, `optional`.

#### `ResourceClassification`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `setByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `systemId`, `resourceKind`, `resourceId`, `privileged`, `note`, `setAt`.

#### `ResourceDelegation`

Linked to a data subject by person: `delegatePersonId`. Erasure: **retain** -- Configuration naming the person as a delegate.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `delegatePersonId` | identity | retained |  |
| `createdByUserId` | identity | retained |  |

Not personal data: `id`, `tenantId`, `resourceType`, `resourceId`, `delegateGroupId`, `capabilities`, `audienceCondition`, `startsAt`, `endsAt`, `createdAt`.

#### `ResourceOwner`

Linked to a data subject by person: `ownerPersonId`. Erasure: **retain** -- Configuration naming the person as an owner; reassign it before or after the erasure.

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `ownerPersonId` | identity | retained |  |

Not personal data: `id`, `tenantId`, `resourceType`, `resourceId`, `ownerGroupId`, `createdAt`, `updatedAt`.

#### `Role`

No personal data. Columns: `id`, `tenantId`, `name`, `description`, `permissions`, `builtIn`.

#### `RuleEntitlement`

No personal data. Columns: `id`, `tenantId`, `ruleId`, `entitlementId`.

#### `SamlConfig`

No personal data. Columns: `id`, `tenantId`, `applicationId`, `spEntityId`, `acsUrls`, `defaultAcsUrl`, `acsBinding`, `nameIdFormat`, `nameIdClaim`, `spCertificates`, `wantAuthnRequestsSigned`, `encryptAssertions`, `encryptionCertificate`, `sloUrl`, `sloBinding`, `allowIdpInitiated`, `assertionLifetimeMs`, `wsFedEnabled`, `createdAt`, `updatedAt`.

#### `SodRule`

No personal data. Columns: `id`, `tenantId`, `name`, `functionAId`, `functionBId`, `severity`, `rationale`, `exceptionWorkflowId`, `enabled`, `createdAt`, `updatedAt`.

#### `TargetSystem`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `externalWritesPausedByUserId` | identity |  |  |
| `externalWritesResumedByUserId` | identity |  |  |
| `adapterSelectionChangedByUserId` | identity |  |  |
| `deprecationOverrideByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `name`, `type`, `config`, `secretName`, `pairedDirectorySourceId`, `schedule`, `autoApply`, `enabled`, `externalWritesPausedAt`, `externalWritesPauseReason`, `externalWritesPauseExpiresAt`, `externalWritesResumedAt`, `maintenanceWindowEnabled`, `maintenanceWindowDays`, `maintenanceWindowStartMinute`, `maintenanceWindowDurationMinutes`, `adapterChannel`, `adapterVersionPin`, `adapterRollbackVersion`, `adapterSelectionChangedAt`, `adapterSelectionReason`, `deprecationOverrideVersion`, `deprecationOverrideReason`, `deprecationOverrideAt`, `deprecationOverrideExpiresAt`, `enforcementMode`, `preHireDays`, `entitlementRevocationDelayDays`, `disableGraceDays`, `archiveAfterDays`, `reenableWithoutConfirmationDays`, `createAccountThresholdPercent`, `disableAccountThresholdPercent`, `archiveAccountThresholdPercent`, `revokeEntitlementThresholdPercent`, `deactivateSyntraUserThresholdPercent`, `perEntitlementThresholdPercent`, `personPopulationDropPercent`, `maxContainerCreatesPerRun`, `maxAttempts`, `concurrency`, `renameEnabled`, `lastRunAt`, `lastAppliedRunAt`, `consecutiveSkippedRuns`, `lastSkippedAt`, `lastSkipReason`, `createdAt`, `updatedAt`.

#### `Tenant`

No personal data. Columns: `id`, `name`, `slug`, `primaryDomain`, `additionalDomains`, `status`, `adminMfaRequired`, `passwordMinLength`, `selfEnrolmentEnabled`, `lockoutThreshold`, `lockoutWindowMinutes`, `lockoutDurationMinutes`, `passwordMaxAgeDays`, `passwordHistoryDepth`, `emailOtpEnabled`, `portalSessionIdleMinutes`, `portalSessionAbsoluteMinutes`, `adminSessionIdleMinutes`, `adminSessionAbsoluteMinutes`, `adminWebauthnRequired`, `brandName`, `brandLogo`, `brandPrimary`, `brandAccent`, `oidcConfigGeneration`, `createdAt`.

#### `TenantDeletionRequest`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `requestedByUserId` | identity |  |  |
| `approvedByUserId` | identity |  |  |
| `executedByUserId` | identity |  |  |
| `cancelledByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `status`, `assessmentDigest`, `assessmentAuditEventId`, `exportDigest`, `exportAuditEventId`, `dataRevision`, `reason`, `requestedAt`, `approvalExpiresAt`, `approvedAt`, `approverStepUpAt`, `executeNotBefore`, `executeBefore`, `executorStepUpAt`, `completedAt`, `cancelledAt`, `closedReason`, `receipt`.

#### `TenantExternalWriteStop`

| Column | Category | Erasure | Notes |
| --- | --- | --- | --- |
| `pausedByUserId` | identity |  |  |
| `resumedByUserId` | identity |  |  |

Not personal data: `id`, `tenantId`, `pausedAt`, `pauseReason`, `pauseExpiresAt`, `resumedAt`, `updatedAt`.

#### `UpstreamIdp`

No personal data. Columns: `id`, `tenantId`, `slug`, `name`, `protocol`, `enabled`, `issuerUrl`, `clientId`, `clientSecretName`, `scopes`, `idpEntityId`, `ssoUrl`, `idpSloUrl`, `ssoBinding`, `idpCertificates`, `wantAssertionsSigned`, `loginAttribute`, `emailAttribute`, `displayNameAttribute`, `groupsAttribute`, `createUsers`, `allowLoginAdoption`, `refreshOnLogin`, `defaultOrgUnitId`, `createdAt`, `updatedAt`.

#### `WebhookEndpoint`

No personal data. Columns: `id`, `tenantId`, `name`, `url`, `enabled`, `events`, `createdAt`, `updatedAt`.

### Secrets and keys

- **Purpose.** Encrypted connector credentials and signing keys.
- **Source.** Administrators and key rotation.
- **Retention.** Until replaced; crypto-erased with the tenant.
- **Legal basis.** Not personal data.
- **Access.** Nobody reads plaintext; the vault decrypts in process.

#### `Secret`

No personal data. Columns: `id`, `tenantId`, `name`, `ciphertext`, `iv`, `tag`, `wrappedDek`, `dekIv`, `dekTag`, `updatedAt`.

#### `SigningKey`

No personal data. Columns: `id`, `tenantId`, `kind`, `kid`, `alg`, `publicJwk`, `certificate`, `secretName`, `status`, `notBefore`, `notAfter`, `retiredAt`, `createdAt`.
