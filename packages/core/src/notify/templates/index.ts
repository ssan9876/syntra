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
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
