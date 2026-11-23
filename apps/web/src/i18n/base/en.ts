import { uiMessages } from '@syntra/ui';

/**
 * The BASE catalog: sign in, forgotten password, second factor, enrolment,
 * password renewal, the portal, the header shared with the console, and the
 * strings of the `@syntra/ui` components.
 *
 * Everything here ships in the entry chunk, because the sign-in page must
 * render in the reader's language on its first paint and must load on a bad
 * connection. Keep it to what those screens use. Strings used only by the
 * administrative console belong in `../console/`, which is loaded by console
 * routes alone, one language at a time.
 *
 * English is the SOURCE, and its keys are the type. A locale missing a key
 * falls back to English rather than rendering the key: a screen reading
 * `login.submit` is a screen nobody can use, and a missing translation is a
 * gap in a catalogue, not a reason to break a sign-in.
 */
export const en = {
  ...uiMessages,

  'common.back_to_sign_in': 'Back to sign in',
  'common.cancel': 'Cancel',
  'common.continue': 'Continue',
  'common.language': 'Language',
  'common.loading': 'Loading',
  'common.rate_limited': 'Too many attempts. Wait a minute and try again.',

  'login.title': 'Sign in',
  'login.login': 'Login',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.forgot': 'Forgotten your password?',
  'login.help': 'Trouble signing in? Contact your IT administrator.',
  'login.trouble': 'Trouble signing in?',
  'common.get_help': 'Get help',
  'login.failed': 'Wrong login or password.',

  'forgot.title': 'Reset your password',
  'forgot.field': 'Login or email',
  'forgot.submit': 'Send the link',
  'forgot.sent_title': 'Check your inbox',
  // Says "if", and means it. The server answers identically whether or not the
  // account exists, and a translation that promised delivery would give away
  // what the endpoint carefully does not.
  'forgot.sent':
    'If that account exists, a link is on its way. It works once and expires in 30 minutes.',

  'reset.title': 'Choose a new password',
  'reset.password': 'New password',
  'reset.confirm': 'New password again',
  'reset.submit': 'Save the new password',
  'reset.mismatch': 'Those two passwords are not the same.',

  'renew.title': 'Your password has expired',
  'renew.lead': 'Choose a new one to carry on.',
  'reset.too_short': 'At least 12 characters.',
  'reset.factor_totp': 'Code from your app',
  'reset.factor_hint': 'Your account has a second factor. Enter its code too.',
  'renew.too_short': 'At least 12 characters, and not one you have used before.',
  'renew.submit': 'Save and sign in',

  'mfa.title': 'One more step',
  'mfa.code': 'Code',
  'mfa.verify': 'Verify',
  'mfa.wrong_code': 'Wrong code. Try the next one your app shows.',
  'mfa.use_recovery': 'Use a recovery code instead',
  'mfa.recovery_code': 'Recovery code',
  'mfa.use_key': 'Use your security key',
  'mfa.email_send': 'Send me a code',
  // "If", for the same reason as `forgot.sent`.
  'mfa.email_sent': 'If a code can be sent to your address, it is on its way.',
  'mfa.expired': 'That step expired. Sign in again.',
  'mfa.totp_code': 'Six-digit code',
  'mfa.email_code': 'Code from your email',
  'mfa.email_resend': 'Send it again',
  'mfa.recovery_hint': 'One of the recovery codes you saved at setup.',
  'mfa.webauthn_lead': 'Use your security key or passkey when the browser asks.',
  'mfa.use_totp': 'Use a code from your app',
  'mfa.use_email': 'Email me a code',

  'enrol.title': 'Set up a second factor',
  'enrol.totp': 'Authenticator app',
  'enrol.webauthn': 'Security key or passkey',
  'enrol.email_otp': 'Emailed code',
  'enrol.start': 'Start',
  'enrol.scan': 'Scan this with your app, then type the code it shows.',
  'enrol.qr_alt': 'QR code for your authenticator app',
  'enrol.cannot_scan': 'Cannot scan? Enter this key instead:',
  'enrol.confirm': 'Confirm',
  'enrol.name_key': 'Name this key',
  'enrol.switch_to_key': 'Use a security key instead',
  'enrol.switch_to_app': 'Use an app instead',

  'portal.title': 'Your applications',
  'portal.empty': 'No applications yet.',
  'portal.search': 'Search',
  'portal.sign_out': 'Sign out',
  'portal.greeting': 'Good day, {name}',
  'portal.empty_title': 'No applications assigned yet',
  'portal.other_group': 'Everything else',
  'portal.pinned': 'Pinned',
  'portal.recent': 'Recently used',
  'portal.all_group': 'All applications',
  'portal.pin': 'Pin',
  'portal.unpin': 'Unpin',
  'portal.pin_label': 'Pin {name}',
  'portal.unpin_label': 'Unpin {name}',
  'portal.filter': 'Filter applications',
  'portal.no_match': 'No applications match “{query}”',
  'portal.clear_filter': 'Clear filter',
  'shell.administration': 'Administration',
  'shell.security': 'Security',
  'shell.portal_nav': 'Portal',

  'nav.applications': 'Applications',
  'nav.catalog': 'Request access',
  'nav.requests': 'My requests',
  'nav.access': 'My access',
  'nav.approvals': 'Approvals',
  'nav.managed': 'Managed by me',
  'nav.tasks': 'Tasks',
  'nav.reviews': 'Reviews',
} as const;

/** Every base key the application may ask for. English is the source of truth. */
export type MessageKey = keyof typeof en;

/**
 * A translation. Partial on purpose.
 *
 * `Partial` rather than a full `Record`, so adding an English string does not
 * break the build for every locale at once — which in practice means either
 * the string does not get added or the locales get filled with English text
 * pretending to be translated. A missing key falls back, visibly and safely.
 */
export type Catalog = Partial<Record<MessageKey, string>>;
