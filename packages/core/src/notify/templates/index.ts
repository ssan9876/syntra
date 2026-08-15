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
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
