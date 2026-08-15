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
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
