export interface Template {
  subject: string;
  text: string;
  html: string;
}

/**
 * Templates use {{name}} placeholders. tenantName is supplied automatically;
 * everything else comes from the caller.
 */
export const TEMPLATES = {
  welcome: {
    subject: 'Welcome to {{tenantName}}',
    text: 'Hello {{displayName}},\n\nAn account has been created for you at {{tenantName}}.',
    html: '<p>Hello {{displayName}},</p><p>An account has been created for you at {{tenantName}}.</p>',
  },
  'password-changed': {
    subject: 'Your {{tenantName}} password was changed',
    text: 'Hello {{displayName}},\n\nYour password was changed. If this was not you, contact your administrator immediately.',
    html: '<p>Hello {{displayName}},</p><p>Your password was changed. If this was not you, contact your administrator immediately.</p>',
  },
  'factor-added': {
    subject: 'A second factor was added to your {{tenantName}} account',
    text: 'Hello {{displayName}},\n\nA {{factor}} was added to your account on {{when}}, from {{sourceIp}}.\n\nIf this was not you, change your password and ask your administrator to remove this factor.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was added to your account on {{when}}, from {{sourceIp}}.</p><p>If this was not you, change your password and ask your administrator to remove this factor.</p>',
  },
  /**
   * The sign-in code itself.
   *
   * Says what to do if it was not you, and deliberately does NOT name the
   * application or the address it was requested from: this mail reaches
   * somebody who may not have asked for it, and the useful facts are 'a code
   * exists' and 'ignore it if you did not ask' — not a description of
   * whoever is trying to get in.
   */
  'email-otp': {
    subject: 'Your {{tenantName}} sign-in code',
    text: 'Hello {{displayName}},\n\nYour code is {{code}}. It works for the next {{minutes}} minutes and once only.\n\nIf you did not ask to sign in, tell your administrator: someone else knows your password.',
    html: '<p>Hello {{displayName}},</p><p>Your code is <strong>{{code}}</strong></p><p>It works for the next {{minutes}} minutes and once only.</p><p>If you did not ask to sign in, tell your administrator: someone else knows your password.</p>',
  },
  'factor-removed': {
    subject: 'A second factor was removed from your {{tenantName}} account',
    text: 'Hello {{displayName}},\n\nA {{factor}} was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}\n\nIf this was not you, change your password and contact your administrator now.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}</p><p>If this was not you, change your password and contact your administrator now.</p>',
  },
  'password-reset': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nOpen this link to choose a new password. It works once and expires in 30 minutes.\n\n{{resetUrl}}\n\nIf you did not ask for this, ignore this message.',
    html: '<p>Hello {{displayName}},</p><p>Open this link to choose a new password. It works once and expires in 30 minutes.</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p><p>If you did not ask for this, ignore this message.</p>',
  },
  /**
   * A created account's sign-in details, as a LINK to the password.
   *
   * Never the password itself. A mailbox keeps what it is sent for years,
   * forwards it, indexes it and syncs it to phones; a link that works once and
   * expires in three days is a credential that stops being one. The page
   * behind it shows nothing until somebody presses a button, because mail
   * scanners (Safe Links and its peers) open every link in every message, and
   * a GET that revealed the password would have been spent by the scanner.
   *
   * `intro` says who the account is for -- "you", or the person a manager is
   * being asked to pass it to -- and `changeNote` only promises a forced
   * change at first sign-in when the target will actually ask for one.
   */
  'account-credential-link': {
    subject: '{{tenantName}}: sign-in details for a new {{systemName}} account',
    text: '{{intro}}\n\nSystem: {{systemName}}\nUsername: {{username}}\n\nThe password is not in this message. Open this link and press "Show password" to see it:\n\n{{pickupUrl}}\n\nThe link works once and expires on {{expiresAt}}. {{changeNote}}\n\nIf you were not expecting this, do not open the link; tell your administrator.',
    html: '<p>{{intro}}</p><p>System: <strong>{{systemName}}</strong><br>Username: <code>{{username}}</code></p><p>The password is not in this message. Open this link and press <strong>Show password</strong> to see it:</p><p><a href="{{pickupUrl}}">{{pickupUrl}}</a></p><p>The link works once and expires on {{expiresAt}}. {{changeNote}}</p><p>If you were not expecting this, do not open the link; tell your administrator.</p>',
  },
  'password-reset-upstream': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nYour password is managed by {{provider}}. Reset it there.',
    html: '<p>Hello {{displayName}},</p><p>Your password is managed by <strong>{{provider}}</strong>. Reset it there.</p>',
  },
  'automate-request-submitted-for-you': {
    subject: 'A request was raised for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{submitterName}} has asked for {{productName}} for you. If you did not expect this, tell your administrator.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{submitterName}}</strong> has asked for <strong>{{productName}}</strong> for you. If you did not expect this, tell your administrator.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-stage-opened': {
    subject: 'A request at {{tenantName}} is waiting for you',
    text: 'Hello {{displayName}},\n\n{{requesterName}} has asked for {{productName}} for {{subjectName}}.\n\nWhy: {{justification}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> has asked for <strong>{{productName}}</strong> for {{subjectName}}.</p><p>Why: {{justification}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-reminder': {
    subject: 'Still waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} has waited for your decision since {{openedAt}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} has waited for your decision since {{openedAt}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated': {
    subject: 'A request at {{tenantName}} has been escalated to you',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour limit and was escalated to you. The original approvers can still decide it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour limit and was escalated to you. The original approvers can still decide it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated-past': {
    subject: 'A request of yours at {{tenantName}} was escalated',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour limit. {{escalatedTo}} were added as approvers; you can still decide it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour limit. {{escalatedTo}} were added as approvers; you can still decide it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-approved': {
    subject: 'Your request at {{tenantName}} was approved',
    text: 'Hello {{displayName}},\n\n{{productName}} was approved by {{approverName}}{{shortenedNote}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was approved by {{approverName}}{{shortenedNote}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-rejected': {
    subject: 'Your request at {{tenantName}} was refused',
    text: 'Hello {{displayName}},\n\n{{productName}} was refused by {{approverName}}.\n\nReason: {{comment}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was refused by {{approverName}}.</p><p>Reason: {{comment}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-refused': {
    subject: 'A request at {{tenantName}} could not go ahead',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was refused automatically.\n\nReason: {{reason}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was refused automatically.</p><p>Reason: {{reason}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-cancelled': {
    subject: 'A request at {{tenantName}} was withdrawn',
    text: 'Hello {{displayName}},\n\n{{requesterName}} withdrew the request for {{productName}}. No decision needed.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> withdrew the request for {{productName}}. No decision needed.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-request-expired': {
    subject: 'Your request at {{tenantName}} expired',
    text: 'Hello {{displayName}},\n\n{{productName}} was not decided within {{expiryHours}} hours and has expired. Nothing was granted.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was not decided within {{expiryHours}} hours and has expired. Nothing was granted.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilled': {
    subject: 'You now hold {{productName}} at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} has been granted to {{subjectName}}.\n\nWhat this includes: {{resourceList}}\nUntil: {{endsAt}}\n{{skippedNote}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> has been granted to {{subjectName}}.</p><p>What this includes: {{resourceList}}<br>Until: {{endsAt}}</p><p>{{skippedNote}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-partially-fulfilled': {
    subject: 'Request at {{tenantName}} partly granted',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was only partly granted.\n\nGranted: {{grantedList}}\nNot granted: {{failedList}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was only partly granted.</p><p>Granted: {{grantedList}}<br>Not granted: {{failedList}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilment-failed': {
    subject: 'A request at {{tenantName}} could not be applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved but could not be applied to {{targetName}}: {{message}}\n\nNothing was granted.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved but could not be applied to {{targetName}}: {{message}}</p><p>Nothing was granted.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-awaiting-fulfilment-sla': {
    subject: 'Approved request at {{tenantName}} not yet applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved {{waitingHours}} hours ago and is not yet applied to {{targetName}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved {{waitingHours}} hours ago and is not yet applied to {{targetName}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-blocked-no-approver': {
    subject: 'A request at {{tenantName}} has no approver',
    text: 'Hello {{displayName}},\n\nStage {{stageName}} of {{productName}} for {{subjectName}} has no approver, and neither does its fallback.\n\n{{droppedNote}}\n\nFix the workflow, set a resource owner, or decide the request by hand.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Stage <strong>{{stageName}}</strong> of {{productName}} for {{subjectName}} has no approver, and neither does its fallback.</p><p>{{droppedNote}}</p><p>Fix the workflow, set a resource owner, or decide the request by hand.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-expiry-warning': {
    subject: '{{productName}} at {{tenantName}} ends in {{days}} days',
    text: 'Hello {{displayName}},\n\n{{subjectName}} holds {{productName}} until {{endsAt}}.\n\nTo keep it, ask for an extension before then:\n{{extendUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} holds <strong>{{productName}}</strong> until {{endsAt}}.</p><p>To keep it, ask for an extension before then:</p><p><a href="{{extendUrl}}">Extend</a></p>',
  },
  'automate-expired': {
    subject: '{{productName}} at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\n{{productName}} ended on {{endsAt}} and has been removed.\n\n{{stillHeldNote}}\n\nTo ask for it again: {{catalogUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> ended on {{endsAt}} and has been removed.</p><p>{{stillHeldNote}}</p><p>To ask for it again: <a href="{{catalogUrl}}">the catalog</a></p>',
  },
  'automate-lapsed': {
    subject: 'Access at {{tenantName}} removed: contract ended',
    text: 'Hello {{displayName}},\n\n{{subjectName}} has had no contract since {{lastContractEnd}}. Requested access removed: {{resourceList}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} has had no contract since {{lastContractEnd}}. Requested access removed: {{resourceList}}</p>',
  },
  'automate-review-flagged': {
    subject: 'Access at {{tenantName}} may no longer be needed',
    text: 'Hello {{displayName}},\n\n{{subjectName}} still holds {{productName}}, granted on {{grantedAt}}, but no longer qualifies: {{reviewReason}}\n\nNothing was removed. Keep or remove it.\n\n{{grantUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} still holds <strong>{{productName}}</strong>, granted on {{grantedAt}}, but no longer qualifies: {{reviewReason}}</p><p>Nothing was removed. Keep or remove it.</p><p><a href="{{grantUrl}}">{{grantUrl}}</a></p>',
  },
  'automate-delegation-started': {
    subject: 'An approval delegation at {{tenantName}} has started',
    text: 'Hello {{displayName}},\n\n{{delegatorName}} has delegated approvals to {{delegateName}} until {{endsAt}}. {{delegatorName}} can still decide requests too.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{delegatorName}}</strong> has delegated approvals to <strong>{{delegateName}}</strong> until {{endsAt}}. {{delegatorName}} can still decide requests too.</p>',
  },
  'automate-delegation-ended': {
    subject: 'An approval delegation at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\nThe delegation from {{delegatorName}} to {{delegateName}} ended on {{endsAt}}.',
    html: '<p>Hello {{displayName}},</p><p>The delegation from <strong>{{delegatorName}}</strong> to <strong>{{delegateName}}</strong> ended on {{endsAt}}.</p>',
  },
  'automate-sweep-confirmation': {
    subject: 'Expiry sweep at {{tenantName}} needs confirmation',
    text: 'Hello {{displayName}},\n\nTonight’s sweep proposed {{actionCount}} removals and applied none.\n\nWhy: {{blockedReason}}\n\n{{sweepUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Tonight’s sweep proposed {{actionCount}} removals and applied none.</p><p>Why: {{blockedReason}}</p><p><a href="{{sweepUrl}}">{{sweepUrl}}</a></p>',
  },
  // The daily summary. Without it, `digest: true` is a row nothing ever
  // sends, and a person who chose a daily summary receives NOTHING at all --
  // including every stage-opened notification, which means approvals sit in a
  // queue nobody has been told about. Task 15's `runDigestJob` renders it.
  'automate-digest': {
    subject: 'Your daily summary from {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{count}} items are waiting for you:\n\n{{lines}}',
    html: '<p>Hello {{displayName}},</p><p>{{count}} items are waiting for you:</p><pre>{{lines}}</pre>',
  },
  // ---- Govern (spec sections 12, 17, 19) ----------------------------------
  //
  // Every `var` these render is a NAME, a count or a date. Never an id: a UUID
  // in a notification is "the feature works and no human can use it".
  'govern-review-assigned': {
    subject: '{{itemCount}} access reviews are waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe access review "{{campaignName}}" has {{itemCount}} items for you. It closes on {{dueAt}}.\n\n{{reviewUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The access review <strong>{{campaignName}}</strong> has {{itemCount}} items for you. It closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p>',
  },
  'govern-review-reminder': {
    subject: '{{itemCount}} access reviews still waiting \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" are still undecided. The review closes on {{dueAt}}.\n\n{{reviewUrl}}\n\nUndecided items are listed against your name on the campaign report.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> are still undecided. The review closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>Undecided items are listed against your name on the campaign report.</p>',
  },
  'govern-review-escalated': {
    subject: 'An access review was escalated past you \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" were escalated to {{escalatedTo}}. You can still decide them: {{reviewUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> were escalated to {{escalatedTo}}. You can still decide them: <a href="{{reviewUrl}}">{{reviewUrl}}</a></p>',
  },
  'govern-review-reassigned': {
    subject: 'Access reviews have moved to you \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" were moved to you from {{previousReviewer}}.\n\n{{reviewUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> were moved to you from {{previousReviewer}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p>',
  },
  'govern-campaign-blocked-item': {
    subject: 'Review items without a reviewer \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" have no reviewer, and the fallback has none either. Name a reviewer or change the scope.\n\n{{campaignUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> have no reviewer, and the fallback has none either. Name a reviewer or change the scope.</p><p><a href="{{campaignUrl}}">{{campaignUrl}}</a></p>',
  },
  'govern-finding-critical': {
    subject: 'A critical governance finding was raised at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{findingKind}}: {{summary}}\n\n{{findingUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{findingKind}}</strong>: {{summary}}</p><p><a href="{{findingUrl}}">{{findingUrl}}</a></p>',
  },
  'govern-exception-expiring': {
    subject: 'An SoD exception expires on {{endsAt}} \u2014 {{ruleName}}',
    text: 'Hello {{displayName}},\n\nThe exception to "{{ruleName}}" for {{beneficiaryName}} expires on {{endsAt}}.\n\nRenew it here, pre-filled with the existing justification: {{renewUrl}}\n\nWhen it lapses, the violation reopens. Nothing is removed.',
    html: '<p>Hello {{displayName}},</p><p>The exception to <strong>{{ruleName}}</strong> for {{beneficiaryName}} expires on {{endsAt}}.</p><p><a href="{{renewUrl}}">Renew it</a>, pre-filled with the existing justification.</p><p>When it lapses, the violation reopens. Nothing is removed.</p>',
  },
  /**
   * Employee lifecycle work. Every one of these names the employee and the
   * operation and links to the timeline, because the reader's next act is to
   * open it. None quotes a target's error text: the timeline holds that,
   * behind a sign-in, and a mail is neither.
   */
  'lifecycle-assigned': {
    subject: 'Lifecycle work for {{personName}} is yours — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} has been assigned to you at {{priority}} priority{{dueNote}}.\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} has been assigned to you at {{priority}} priority{{dueNote}}.</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-failed': {
    subject: 'Lifecycle work for {{personName}} failed — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} failed: {{summary}}\n\n{{operationUrl}}\n\nIt will not retry until someone acts on it.',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} failed: {{summary}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p><p>It will not retry until someone acts on it.</p>',
  },
  'lifecycle-overdue': {
    subject: 'Lifecycle work for {{personName}} is overdue — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} was due {{dueAt}} and is not acknowledged.{{breachNote}}\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} was due {{dueAt}} and is not acknowledged.{{breachNote}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-escalated': {
    subject: 'Escalated: lifecycle work for {{personName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} has been escalated to you: {{reason}}\n\nThe original owner{{ownerNote}} is still assigned.\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} has been escalated to you: {{reason}}</p><p>The original owner{{ownerNote}} is still assigned.</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-access-blocked': {
    subject: 'Access for {{personName}} is blocked — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nTarget work for {{personName}} on {{targetName}} is blocked: {{summary}}\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Target work for {{personName}} on <strong>{{targetName}}</strong> is blocked: {{summary}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-approval-requested': {
    subject: 'Approval needed: {{operationKind}} for {{personName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{requesterName}} started a {{operationKind}} operation for {{personName}} that needs a second approval. {{reason}}\n\nNothing has been changed yet. Approve or reject it:\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> started a {{operationKind}} operation for {{personName}} that needs a second approval. {{reason}}</p><p>Nothing has been changed yet. Approve or reject it:</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-completed': {
    subject: 'Lifecycle work for {{personName}} is complete — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} is complete.\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} is complete.</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  /**
   * Customer-visible security notifications (backlog #52) and credential
   * expiry alerts (backlog #34).
   *
   * Written into the outbox directly by `notify/security-policy.ts` and
   * `credentials/expiry-scan.ts`, never through `enqueueOutbox`: the audit
   * event behind each one has already been fanned out to webhook subscribers
   * by `recordEvent`, and a second delivery under a template name would reach
   * an all-events endpoint twice. Like a webhook body, none of these carries
   * the audit payload -- the reader is sent to the audit log, behind a
   * sign-in, for the detail.
   */
  'security-event': {
    subject: 'Security notification: {{eventLabel}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{eventLabel}} ({{action}}, {{outcome}}) at {{occurredAt}}.\n\nCategory: {{categoryLabel}}. Audit sequence {{sequence}}.\n\nReview it in the audit log: {{auditUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{eventLabel}}</strong> ({{action}}, {{outcome}}) at {{occurredAt}}.</p><p>Category: {{categoryLabel}}. Audit sequence {{sequence}}.</p><p><a href="{{auditUrl}}">Review it in the audit log</a></p>',
  },
  'security-credential-expiring': {
    subject: 'A credential expires in {{daysRemaining}} days — {{credentialLabel}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{credentialLabel}} for {{subjectName}} expires on {{expiresAt}} ({{daysRemaining}} days). Expiry source: {{expirySource}}.\n\nRotate it before then: {{inventoryUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{credentialLabel}}</strong> for {{subjectName}} expires on {{expiresAt}} ({{daysRemaining}} days). Expiry source: {{expirySource}}.</p><p><a href="{{inventoryUrl}}">Rotate it before then</a></p>',
  },
  'security-credential-expired': {
    subject: 'A credential has expired — {{credentialLabel}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{credentialLabel}} for {{subjectName}} expired on {{expiresAt}}. Rotate it now.\n\n{{inventoryUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{credentialLabel}}</strong> for {{subjectName}} expired on {{expiresAt}}. Rotate it now.</p><p><a href="{{inventoryUrl}}">{{inventoryUrl}}</a></p>',
  },
  /**
   * Break-glass. Sent to every holder of `tenant.manage` the moment emergency
   * access is ASKED for, so the delay before it takes effect is time somebody
   * knows about. Names the account and the reason, never the credential.
   */
  'break-glass-requested': {
    subject: 'Emergency access requested for {{accountName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nEmergency (break-glass) console access was requested for {{accountName}} ({{login}}) from {{sourceIp}}.\n\nReason given: {{reason}}\n\nIt starts at {{activatesAt}} and lasts {{durationMinutes}} minutes. If you do not recognise this, cancel it under Settings → Break-glass and treat the sealed credential as compromised.',
    html: '<p>Hello {{displayName}},</p><p>Emergency (break-glass) console access was requested for <strong>{{accountName}}</strong> ({{login}}) from {{sourceIp}}.</p><p>Reason given: {{reason}}</p><p>It starts at <strong>{{activatesAt}}</strong> and lasts {{durationMinutes}} minutes. If you do not recognise this, cancel it under Settings → Break-glass and treat the sealed credential as compromised.</p>',
  },
  'break-glass-activated': {
    subject: 'Emergency access is active for {{accountName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nEmergency (break-glass) console access for {{accountName}} ({{login}}) is now active ({{activatedBy}}) until {{expiresAt}}.\n\nReason given: {{reason}}\n\nEnd it early under Settings → Break-glass. Afterwards, a different administrator must complete the review.',
    html: '<p>Hello {{displayName}},</p><p>Emergency (break-glass) console access for <strong>{{accountName}}</strong> ({{login}}) is now active ({{activatedBy}}) until <strong>{{expiresAt}}</strong>.</p><p>Reason given: {{reason}}</p><p>End it early under Settings → Break-glass. Afterwards, a different administrator must complete the review.</p>',
  },
  /**
   * The console's "Send test email", to the administrator who pressed it.
   * Names the server it went through, so a message that arrives also says
   * which configuration delivered it.
   */
  'mail-test': {
    subject: 'Test email from {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThis test email was sent through {{server}} at {{sentAt}}. Mail delivery works.',
    html: '<p>Hello {{displayName}},</p><p>This test email was sent through {{server}} at {{sentAt}}. Mail delivery works.</p>',
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
