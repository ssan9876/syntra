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
    text: 'Hello {{displayName}},\n\nA {{factor}} was added to your account on {{when}}, from {{sourceIp}}.\n\nIf that was you, nothing further is needed. If it was not, contact your administrator immediately and change your password — a second factor added by someone else survives a password change, so the factor has to be removed too.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was added to your account on {{when}}, from {{sourceIp}}.</p><p>If that was you, nothing further is needed. If it was not, contact your administrator immediately and change your password — a second factor added by someone else survives a password change, so the factor has to be removed too.</p>',
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
    text: 'Hello {{displayName}},\n\nYour code is {{code}}. It works for the next {{minutes}} minutes and once only.\n\nIf you did not ask to sign in, ignore this message and tell your administrator — somebody has your password.',
    html: '<p>Hello {{displayName}},</p><p>Your code is <strong>{{code}}</strong></p><p>It works for the next {{minutes}} minutes and once only.</p><p>If you did not ask to sign in, ignore this message and tell your administrator — somebody has your password.</p>',
  },
  'factor-removed': {
    subject: 'A second factor was removed from your {{tenantName}} account',
    text: 'Hello {{displayName}},\n\nA {{factor}} was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}\n\nIf that was you, nothing further is needed. If it was not, change your password and contact your administrator immediately \u2014 removing a factor is what an attacker holding your session does before they do anything else, and it is the step nobody notices.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}</p><p>If that was you, nothing further is needed. If it was not, change your password and contact your administrator immediately \u2014 removing a factor is what an attacker holding your session does before they do anything else, and it is the step nobody notices.</p>',
  },
  'password-reset': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nOpen this link to choose a new password. It works once and expires in 30 minutes.\n\n{{resetUrl}}\n\nIf you did not ask for this, nothing has changed and you can ignore this message.',
    html: '<p>Hello {{displayName}},</p><p>Open this link to choose a new password. It works once and expires in 30 minutes.</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p><p>If you did not ask for this, nothing has changed and you can ignore this message.</p>',
  },
  'password-reset-upstream': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nYour password is not held by {{tenantName}}. It is managed by {{provider}}, and that is where you reset it.\n\nIf you are not sure what that means, contact your IT administrator.',
    html: '<p>Hello {{displayName}},</p><p>Your password is not held by {{tenantName}}. It is managed by <strong>{{provider}}</strong>, and that is where you reset it.</p><p>If you are not sure what that means, contact your IT administrator.</p>',
  },
  'automate-request-submitted-for-you': {
    subject: 'A request was raised for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{submitterName}} has asked for {{productName}} on your behalf. You are being told now, before anybody decides, so that you can say something if this is not what you expected.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{submitterName}}</strong> has asked for <strong>{{productName}}</strong> on your behalf. You are being told now, before anybody decides, so that you can say something if this is not what you expected.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-stage-opened': {
    subject: 'A request at {{tenantName}} is waiting for you',
    text: 'Hello {{displayName}},\n\n{{requesterName}} has asked for {{productName}} for {{subjectName}}.\n\nWhy: {{justification}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> has asked for <strong>{{productName}}</strong> for {{subjectName}}.</p><p>Why: {{justification}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-reminder': {
    subject: 'Still waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} has been waiting for your decision since {{openedAt}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} has been waiting for your decision since {{openedAt}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated': {
    subject: 'A request at {{tenantName}} has been escalated to you',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour service level and has been escalated to you. The original approvers remain and have been told.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour service level and has been escalated to you. The original approvers remain and have been told.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-escalated-past': {
    subject: 'A request of yours at {{tenantName}} was escalated',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} passed its {{slaHours}}-hour service level, so {{escalatedTo}} were added as approvers. You have not been removed and you can still decide it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} passed its {{slaHours}}-hour service level, so {{escalatedTo}} were added as approvers. You have <em>not</em> been removed and you can still decide it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-approved': {
    subject: 'Your request at {{tenantName}} was approved',
    text: 'Hello {{displayName}},\n\n{{productName}} was approved by {{approverName}}{{shortenedNote}}.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was approved by {{approverName}}{{shortenedNote}}.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-rejected': {
    subject: 'Your request at {{tenantName}} was refused',
    text: 'Hello {{displayName}},\n\n{{productName}} was refused by {{approverName}}.\n\nReason: {{comment}}\n\nIf that reason has changed, you can ask again.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> was refused by {{approverName}}.</p><p>Reason: {{comment}}</p><p>If that reason has changed, you can ask again.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-refused': {
    subject: 'A request at {{tenantName}} could not go ahead',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was refused automatically.\n\nReason: {{reason}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was refused automatically.</p><p>Reason: {{reason}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-cancelled': {
    subject: 'A request at {{tenantName}} was withdrawn',
    text: 'Hello {{displayName}},\n\n{{requesterName}} has withdrawn their request for {{productName}}. There is nothing left for you to decide.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> has withdrawn their request for {{productName}}. There is nothing left for you to decide.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-request-expired': {
    subject: 'Your request at {{tenantName}} expired',
    text: 'Hello {{displayName}},\n\nNobody decided {{productName}} within {{expiryHours}} hours, so the request has expired. Nothing was granted. You can ask again.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Nobody decided <strong>{{productName}}</strong> within {{expiryHours}} hours, so the request has expired. Nothing was granted. You can ask again.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilled': {
    subject: 'You now hold {{productName}} at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{productName}} has been granted to {{subjectName}}.\n\nWhat this includes: {{resourceList}}\nUntil: {{endsAt}}\n{{skippedNote}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> has been granted to {{subjectName}}.</p><p>What this includes: {{resourceList}}<br>Until: {{endsAt}}</p><p>{{skippedNote}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-partially-fulfilled': {
    subject: 'Part of a request at {{tenantName}} did not go through',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} landed in part.\n\nGranted: {{grantedList}}\nNot granted: {{failedList}}\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} landed in part.</p><p>Granted: {{grantedList}}<br>Not granted: {{failedList}}</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-fulfilment-failed': {
    subject: 'A request at {{tenantName}} could not be applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved but could not be applied to {{targetName}}.\n\nThe system said: {{message}}\n\nNothing has been granted, and the request is waiting for somebody to look at it.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved but could not be applied to {{targetName}}.</p><p>The system said: {{message}}</p><p>Nothing has been granted, and the request is waiting for somebody to look at it.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-awaiting-fulfilment-sla': {
    subject: 'A request at {{tenantName}} has been waiting to be applied',
    text: 'Hello {{displayName}},\n\n{{productName}} for {{subjectName}} was approved {{waitingHours}} hours ago and has not been applied to {{targetName}} yet.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> for {{subjectName}} was approved {{waitingHours}} hours ago and has not been applied to {{targetName}} yet.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-blocked-no-approver': {
    subject: 'A request at {{tenantName}} has nobody to approve it',
    text: 'Hello {{displayName}},\n\nStage {{stageName}} of {{productName}} for {{subjectName}} resolved to nobody who can decide it, and so did its fallback.\n\n{{droppedNote}}\n\nNothing will happen to this request until somebody fixes the workflow, records a resource owner, or decides it by hand.\n\n{{requestUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Stage <strong>{{stageName}}</strong> of {{productName}} for {{subjectName}} resolved to nobody who can decide it, and so did its fallback.</p><p>{{droppedNote}}</p><p>Nothing will happen to this request until somebody fixes the workflow, records a resource owner, or decides it by hand.</p><p><a href="{{requestUrl}}">{{requestUrl}}</a></p>',
  },
  'automate-expiry-warning': {
    subject: '{{productName}} at {{tenantName}} ends in {{days}} days',
    text: 'Hello {{displayName}},\n\n{{subjectName}} holds {{productName}} until {{endsAt}}.\n\nIf it is still needed, ask for an extension before then and there will be no gap:\n{{extendUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} holds <strong>{{productName}}</strong> until {{endsAt}}.</p><p>If it is still needed, ask for an extension before then and there will be no gap:</p><p><a href="{{extendUrl}}">Extend</a></p>',
  },
  'automate-expired': {
    subject: '{{productName}} at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\n{{productName}} ended on {{endsAt}} and has been removed.\n\n{{stillHeldNote}}\n\nTo ask for it again: {{catalogUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{productName}}</strong> ended on {{endsAt}} and has been removed.</p><p>{{stillHeldNote}}</p><p>To ask for it again: <a href="{{catalogUrl}}">the catalog</a></p>',
  },
  'automate-lapsed': {
    subject: 'Requested access at {{tenantName}} ended with the contract',
    text: 'Hello {{displayName}},\n\n{{subjectName}} had no contract in force after {{lastContractEnd}}, so the access they had asked for has been removed: {{resourceList}}\n\nIf a handover needs some of it back, request it with an end date.',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} had no contract in force after {{lastContractEnd}}, so the access they had asked for has been removed: {{resourceList}}</p><p>If a handover needs some of it back, request it with an end date.</p>',
  },
  'automate-review-flagged': {
    subject: 'Access at {{tenantName}} may no longer be needed',
    text: 'Hello {{displayName}},\n\n{{subjectName}} still holds {{productName}}, granted on {{grantedAt}}, but no longer matches the audience for it: {{reviewReason}}\n\nNothing has been removed. Somebody should decide whether it should be.\n\n{{grantUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{subjectName}} still holds <strong>{{productName}}</strong>, granted on {{grantedAt}}, but no longer matches the audience for it: {{reviewReason}}</p><p><em>Nothing has been removed.</em> Somebody should decide whether it should be.</p><p><a href="{{grantUrl}}">{{grantUrl}}</a></p>',
  },
  'automate-delegation-started': {
    subject: 'An approval delegation at {{tenantName}} has started',
    text: 'Hello {{displayName}},\n\n{{delegatorName}} has delegated approvals to {{delegateName}} until {{endsAt}}.\n\nThis ADDS an approver. {{delegatorName}} still receives every request and can still decide it.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{delegatorName}}</strong> has delegated approvals to <strong>{{delegateName}}</strong> until {{endsAt}}.</p><p>This <em>adds</em> an approver. {{delegatorName}} still receives every request and can still decide it.</p>',
  },
  'automate-delegation-ended': {
    subject: 'An approval delegation at {{tenantName}} has ended',
    text: 'Hello {{displayName}},\n\nThe delegation from {{delegatorName}} to {{delegateName}} ended on {{endsAt}}.',
    html: '<p>Hello {{displayName}},</p><p>The delegation from <strong>{{delegatorName}}</strong> to <strong>{{delegateName}}</strong> ended on {{endsAt}}.</p>',
  },
  'automate-sweep-confirmation': {
    subject: 'An expiry sweep at {{tenantName}} needs a decision',
    text: 'Hello {{displayName}},\n\nTonight’s sweep proposed {{actionCount}} removals and stopped without applying any of them.\n\nWhy: {{blockedReason}}\n\n{{sweepUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Tonight’s sweep proposed {{actionCount}} removals and stopped without applying any of them.</p><p>Why: {{blockedReason}}</p><p><a href="{{sweepUrl}}">{{sweepUrl}}</a></p>',
  },
  // The daily summary. Without it, `digest: true` is a row nothing ever
  // sends, and a person who chose a daily summary receives NOTHING at all --
  // including every stage-opened notification, which means approvals sit in a
  // queue nobody has been told about. Task 15's `runDigestJob` renders it.
  'automate-digest': {
    subject: 'Your daily summary from {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThere are {{count}} things waiting for you:\n\n{{lines}}\n\nAnything urgent — a failure, a block, or a sweep needing confirmation — is sent to you immediately and is never in this summary.',
    html: '<p>Hello {{displayName}},</p><p>There are {{count}} things waiting for you:</p><pre>{{lines}}</pre><p>Anything urgent — a failure, a block, or a sweep needing confirmation — is sent to you immediately and is never in this summary.</p>',
  },
  // ---- Govern (spec sections 12, 17, 19) ----------------------------------
  //
  // Every `var` these render is a NAME, a count or a date. Never an id: a UUID
  // in a notification is "the feature works and no human can use it".
  'govern-review-assigned': {
    subject: '{{itemCount}} access reviews are waiting for you at {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe access review "{{campaignName}}" has {{itemCount}} items for you to decide, and closes on {{dueAt}}.\n\n{{reviewUrl}}\n\nEach item says what the access is, how the person got it, and when it was last confirmed. Certifying an item records that you decided to keep it, against the facts shown, at the time you clicked. It does not say the access is appropriate \u2014 only that you looked.',
    html: '<p>Hello {{displayName}},</p><p>The access review <strong>{{campaignName}}</strong> has {{itemCount}} items for you to decide, and closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>Each item says what the access is, how the person got it, and when it was last confirmed. Certifying an item records that you decided to keep it, against the facts shown, at the time you clicked. It does not say the access is appropriate \u2014 only that you looked.</p>',
  },
  'govern-review-reminder': {
    subject: '{{itemCount}} access reviews still waiting \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" are still undecided. The review closes on {{dueAt}}.\n\n{{reviewUrl}}\n\nNothing is certified and nothing is removed if you do not respond. The items are recorded as undecided, they are listed against your name on the campaign report, and somebody has to decide them by hand afterwards.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> are still undecided. The review closes on {{dueAt}}.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>Nothing is certified and nothing is removed if you do not respond. The items are recorded as undecided, they are listed against your name on the campaign report, and somebody has to decide them by hand afterwards.</p>',
  },
  'govern-review-escalated': {
    subject: 'An access review was escalated past you \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" have been escalated to {{escalatedTo}} because they were still undecided.\n\nYou have NOT been removed as a reviewer and you can still decide them: {{reviewUrl}}\n\nYou are being told because decisions attributed to you should never be decisions somebody else made.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> have been escalated to {{escalatedTo}} because they were still undecided.</p><p>You have <strong>not</strong> been removed as a reviewer and you can still decide them: <a href="{{reviewUrl}}">{{reviewUrl}}</a></p><p>You are being told because decisions attributed to you should never be decisions somebody else made.</p>',
  },
  'govern-review-reassigned': {
    subject: 'Access reviews have moved to you \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" have been reassigned to you, because {{previousReviewer}} can no longer decide them.\n\n{{reviewUrl}}',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> have been reassigned to you, because {{previousReviewer}} can no longer decide them.</p><p><a href="{{reviewUrl}}">{{reviewUrl}}</a></p>',
  },
  'govern-campaign-blocked-item': {
    subject: 'An access review item has no reviewer \u2014 {{campaignName}}',
    text: 'Hello {{displayName}},\n\n{{itemCount}} items in "{{campaignName}}" resolved to nobody who can decide them, and the fallback resolved to nobody either.\n\n{{campaignUrl}}\n\nThey will not auto-decide and they will not go away. Somebody has to name a reviewer, or the scope has to change.',
    html: '<p>Hello {{displayName}},</p><p>{{itemCount}} items in <strong>{{campaignName}}</strong> resolved to nobody who can decide them, and the fallback resolved to nobody either.</p><p><a href="{{campaignUrl}}">{{campaignUrl}}</a></p><p>They will not auto-decide and they will not go away. Somebody has to name a reviewer, or the scope has to change.</p>',
  },
  'govern-finding-critical': {
    subject: 'A critical governance finding was raised at {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{findingKind}}: {{summary}}\n\n{{findingUrl}}\n\nThis is not part of a digest and it is not batched. It was sent the moment it was found.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{findingKind}}</strong>: {{summary}}</p><p><a href="{{findingUrl}}">{{findingUrl}}</a></p><p>This is not part of a digest and it is not batched. It was sent the moment it was found.</p>',
  },
  'govern-exception-expiring': {
    subject: 'An SoD exception expires on {{endsAt}} \u2014 {{ruleName}}',
    text: 'Hello {{displayName}},\n\nThe exception to "{{ruleName}}" for {{beneficiaryName}} expires on {{endsAt}}.\n\nRenew it here, pre-filled with the existing justification: {{renewUrl}}\n\nNothing is removed when it lapses. The violation reopens and everybody involved is told.',
    html: '<p>Hello {{displayName}},</p><p>The exception to <strong>{{ruleName}}</strong> for {{beneficiaryName}} expires on {{endsAt}}.</p><p><a href="{{renewUrl}}">Renew it</a>, pre-filled with the existing justification.</p><p>Nothing is removed when it lapses. The violation reopens and everybody involved is told.</p>',
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
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} has failed and needs a person: {{summary}}\n\n{{operationUrl}}\n\nNothing about this is retried until somebody looks at it.',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} has failed and needs a person: {{summary}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p><p>Nothing about this is retried until somebody looks at it.</p>',
  },
  'lifecycle-overdue': {
    subject: 'Lifecycle work for {{personName}} is overdue — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} passed its due time ({{dueAt}}) and has not been acknowledged.{{breachNote}}\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} passed its due time ({{dueAt}}) and has not been acknowledged.{{breachNote}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-escalated': {
    subject: 'Escalated: lifecycle work for {{personName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} has been escalated to you: {{reason}}\n\nThe original owner{{ownerNote}} remains on it.\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} has been escalated to you: {{reason}}</p><p>The original owner{{ownerNote}} remains on it.</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-access-blocked': {
    subject: 'Access for {{personName}} is blocked — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nTarget work for {{personName}} on {{targetName}} is blocked and will not proceed on its own: {{summary}}\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>Target work for {{personName}} on <strong>{{targetName}}</strong> is blocked and will not proceed on its own: {{summary}}</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-approval-requested': {
    subject: 'Approval needed: {{operationKind}} for {{personName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\n{{requesterName}} started a {{operationKind}} operation for {{personName}} that policy says a second person must approve. {{reason}}\n\nNothing has been written to any target. Approve or reject it here:\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p><strong>{{requesterName}}</strong> started a {{operationKind}} operation for {{personName}} that policy says a second person must approve. {{reason}}</p><p>Nothing has been written to any target. Approve or reject it here:</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
  },
  'lifecycle-completed': {
    subject: 'Lifecycle work for {{personName}} is complete — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{operationKind}} operation for {{personName}} completed: every required step reached its observed state or was resolved by hand.\n\n{{operationUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{operationKind}}</strong> operation for {{personName}} completed: every required step reached its observed state or was resolved by hand.</p><p><a href="{{operationUrl}}">{{operationUrl}}</a></p>',
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
    text: 'Hello {{displayName}},\n\n{{eventLabel}} ({{action}}, {{outcome}}) at {{occurredAt}}.\n\nCategory: {{categoryLabel}}. Audit sequence {{sequence}}.\n\nReview it in the audit log: {{auditUrl}}\n\nYou receive this because you hold tenant.manage and this category is set to email administrators.',
    html: '<p>Hello {{displayName}},</p><p><strong>{{eventLabel}}</strong> ({{action}}, {{outcome}}) at {{occurredAt}}.</p><p>Category: {{categoryLabel}}. Audit sequence {{sequence}}.</p><p><a href="{{auditUrl}}">Review it in the audit log</a></p><p>You receive this because you hold tenant.manage and this category is set to email administrators.</p>',
  },
  'security-credential-expiring': {
    subject: 'A credential expires in {{daysRemaining}} days — {{credentialLabel}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{credentialLabel}} for {{subjectName}} expires on {{expiresAt}} ({{daysRemaining}} days). Expiry source: {{expirySource}}.\n\nRotate it before then: {{inventoryUrl}}\n\nYou will be told again at each remaining threshold and when it expires.',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{credentialLabel}}</strong> for {{subjectName}} expires on {{expiresAt}} ({{daysRemaining}} days). Expiry source: {{expirySource}}.</p><p><a href="{{inventoryUrl}}">Rotate it before then</a></p><p>You will be told again at each remaining threshold and when it expires.</p>',
  },
  'security-credential-expired': {
    subject: 'A credential has expired — {{credentialLabel}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nThe {{credentialLabel}} for {{subjectName}} expired on {{expiresAt}}. Anything that depends on it is failing now or will fail at its next use.\n\n{{inventoryUrl}}',
    html: '<p>Hello {{displayName}},</p><p>The <strong>{{credentialLabel}}</strong> for {{subjectName}} expired on {{expiresAt}}. Anything that depends on it is failing now or will fail at its next use.</p><p><a href="{{inventoryUrl}}">{{inventoryUrl}}</a></p>',
  },
  /**
   * Break-glass. Sent to every holder of `tenant.manage` the moment emergency
   * access is ASKED for, so the delay before it takes effect is time somebody
   * knows about. Names the account and the reason, never the credential.
   */
  'break-glass-requested': {
    subject: 'Emergency access requested for {{accountName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nEmergency (break-glass) console access was requested for {{accountName}} ({{login}}) from {{sourceIp}}.\n\nReason given: {{reason}}\n\nIt takes effect at {{activatesAt}} unless an administrator cancels it before then, and lasts {{durationMinutes}} minutes. If you do not recognise this, cancel it now under Settings → Break-glass in the console and treat the sealed credential as compromised.',
    html: '<p>Hello {{displayName}},</p><p>Emergency (break-glass) console access was requested for <strong>{{accountName}}</strong> ({{login}}) from {{sourceIp}}.</p><p>Reason given: {{reason}}</p><p>It takes effect at <strong>{{activatesAt}}</strong> unless an administrator cancels it before then, and lasts {{durationMinutes}} minutes. If you do not recognise this, cancel it now under Settings → Break-glass in the console and treat the sealed credential as compromised.</p>',
  },
  'break-glass-activated': {
    subject: 'Emergency access is active for {{accountName}} — {{tenantName}}',
    text: 'Hello {{displayName}},\n\nEmergency (break-glass) console access for {{accountName}} ({{login}}) is now active ({{activatedBy}}) until {{expiresAt}}.\n\nReason given: {{reason}}\n\nAny administrator can end it early under Settings → Break-glass. When it ends, a different administrator must complete the post-event review.',
    html: '<p>Hello {{displayName}},</p><p>Emergency (break-glass) console access for <strong>{{accountName}}</strong> ({{login}}) is now active ({{activatedBy}}) until <strong>{{expiresAt}}</strong>.</p><p>Reason given: {{reason}}</p><p>Any administrator can end it early under Settings → Break-glass. When it ends, a different administrator must complete the post-event review.</p>',
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
