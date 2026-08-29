/**
 * The strings on the screens people see before they are signed in.
 *
 * **Scope, stated rather than left to be discovered.** These are the
 * pre-authentication surfaces and the portal — sign in, forgotten password,
 * second factor, enrolment, password renewal. The ADMINISTRATIVE CONSOLE is
 * not translated and is not meant to be: it is used by a handful of people who
 * chose to administer an identity product, whereas these screens are seen by
 * everyone who works at the organization, in whatever language they work in.
 * A half-translated console is worse than an English one, because a reader
 * cannot tell which half they are looking at.
 *
 * No library. The requirement is a lookup and a plural rule over about ninety
 * strings; `react-intl` is 40 KB on the one page that must load on a bad
 * connection, and ICU message syntax buys nothing where nothing needs a
 * gendered ordinal.
 *
 * English is the SOURCE, and its keys are the type. A locale missing a key
 * falls back to English rather than rendering the key — a screen reading
 * `login.submit` is a screen nobody can use, and a missing translation is a
 * gap in a catalogue, not a reason to break a sign-in.
 */

export const en = {
  'common.back_to_sign_in': 'Back to sign in',
  'common.cancel': 'Cancel',
  'common.continue': 'Continue',
  'common.language': 'Language',
  'common.rate_limited': 'Too many attempts. Wait a minute and try again.',

  'login.title': 'Sign in',
  'login.login': 'Login',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.forgot': 'Forgotten your password?',
  'login.lead': 'Use the account your organization issued you.',
  'login.help': 'Trouble signing in? Contact your IT administrator.',
  'login.failed': 'That login and password do not match an account.',

  'forgot.title': 'Reset your password',
  'forgot.lead': 'Enter your login or work email address.',
  'forgot.field': 'Login or email',
  'forgot.submit': 'Send the link',
  'forgot.sent_title': 'Check your inbox',
  // Says "if", and means it. The server answers identically whether or not the
  // account exists, and a translation that promised delivery would give away
  // what the endpoint carefully does not.
  'forgot.sent':
    'If that account exists, we have sent it a link. It works once and expires in thirty minutes.',
  'forgot.sent_help':
    'Nothing arrived? Check spam, or ask your IT administrator — some accounts have their password managed elsewhere.',

  'reset.title': 'Choose a new password',
  'reset.password': 'New password',
  'reset.confirm': 'New password again',
  'reset.submit': 'Save the new password',
  'reset.mismatch': 'Those two passwords are not the same.',

  'renew.title': 'Your password has expired',
  'renew.lead': 'Choose a new one to carry on.',
  'reset.too_short': 'At least twelve characters. A short sentence works well.',
  'reset.factor_totp': 'Code from your app',
  'reset.factor_hint':
    'Your account has a second factor, so resetting the password needs it too.',
  'renew.lead_full': 'Choose a new one to finish signing in. You are not signed in yet.',
  'renew.too_short':
    'At least twelve characters, and not one you have used before. A short sentence works well.',
  'renew.submit': 'Save and sign in',

  'mfa.title': 'One more step',
  'mfa.code': 'Code',
  'mfa.verify': 'Verify',
  'mfa.wrong_code': 'That code did not match. Try the next one your app shows.',
  'mfa.use_recovery': 'Use a recovery code instead',
  'mfa.recovery_code': 'Recovery code',
  'mfa.use_key': 'Use your security key',
  'mfa.email_send': 'Send me a code',
  'mfa.email_sent': 'If a code can be sent to your address, it is on its way.',
  'mfa.expired': 'That step expired. Sign in again.',
  'mfa.lead': 'Your organization requires a second factor for this sign-in.',
  'mfa.totp_code': 'Six-digit code',
  'mfa.email_code': 'Code from your email',
  'mfa.email_resend': 'Send it again',
  'mfa.recovery_hint': 'One of the codes you saved when you set up your second factor.',
  'mfa.webauthn_lead': 'Use your security key or passkey when the browser asks.',
  'mfa.use_totp': 'Use a code from your app',
  'mfa.use_email': 'Email me a code',

  'enrol.title': 'Set up a second factor',
  'enrol.totp': 'Authenticator app',
  'enrol.webauthn': 'Security key or passkey',
  'enrol.email_otp': 'Emailed code',
  'enrol.lead':
    'Your organization now requires one. It takes a minute, and you will be signed in straight afterwards.',
  'enrol.totp_lead':
    'Use an authenticator app — the one your organization recommends, or any that shows six-digit codes.',
  'enrol.start': 'Start',
  'enrol.scan': 'Scan this with your app, then type the code it shows.',
  'enrol.qr_alt': 'QR code for your authenticator app',
  'enrol.cannot_scan': 'Cannot scan? Enter this key instead:',
  'enrol.confirm': 'Confirm',
  'enrol.webauthn_lead':
    'Use a security key, or the fingerprint or face unlock built into this device.',
  'enrol.name_key': 'Name this key',
  'enrol.switch_to_key': 'Use a security key instead',
  'enrol.switch_to_app': 'Use an app instead',

  'portal.title': 'Your applications',
  'portal.empty': 'Nothing has been made available to you yet.',
  'portal.search': 'Search',
  'portal.sign_out': 'Sign out',
  'portal.greeting': 'Good day, {name}',
  'portal.empty_title': 'No applications assigned yet',
  'portal.empty_body':
    'When your administrator assigns applications to you, they appear here and open with a single click.',
  'portal.other_group': 'Everything else',
  'shell.administration': 'Administration',
  'shell.security': 'Security',

  'nav.applications': 'Applications',
  'nav.catalog': 'Request access',
  'nav.requests': 'My requests',
  'nav.access': 'My access',
  'nav.approvals': 'Approvals',
  'nav.managed': 'Managed by me',
  'nav.tasks': 'Tasks',
  'nav.reviews': 'Reviews',
} as const;

/** Every key the application may ask for. English is the source of truth. */
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

/**
 * Dutch.
 *
 * First because it is the market this product competes in: HelloID is Dutch,
 * and an identity product sold there whose sign-in page is English-only is
 * answering a question every prospect asks in the first meeting.
 */
export const nl: Catalog = {
  'common.back_to_sign_in': 'Terug naar aanmelden',
  'common.cancel': 'Annuleren',
  'common.continue': 'Doorgaan',
  'common.language': 'Taal',
  'common.rate_limited': 'Te veel pogingen. Wacht een minuut en probeer het opnieuw.',

  'login.title': 'Aanmelden',
  'login.login': 'Gebruikersnaam',
  'login.password': 'Wachtwoord',
  'login.submit': 'Aanmelden',
  'login.forgot': 'Wachtwoord vergeten?',
  'login.lead': 'Gebruik het account dat je organisatie je heeft gegeven.',
  'login.help': 'Lukt aanmelden niet? Neem contact op met je IT-beheerder.',
  'login.failed': 'Deze gebruikersnaam en dit wachtwoord horen niet bij een account.',

  'forgot.title': 'Wachtwoord opnieuw instellen',
  'forgot.lead': 'Vul je gebruikersnaam of zakelijke e-mailadres in.',
  'forgot.field': 'Gebruikersnaam of e-mail',
  'forgot.submit': 'Stuur de link',
  'forgot.sent_title': 'Kijk in je inbox',
  'forgot.sent':
    'Als dit account bestaat, is er een link verstuurd. Die werkt één keer en verloopt na dertig minuten.',
  'forgot.sent_help':
    'Niets ontvangen? Kijk in je spam, of vraag het je IT-beheerder — sommige accounts hebben hun wachtwoord elders staan.',

  'reset.title': 'Kies een nieuw wachtwoord',
  'reset.password': 'Nieuw wachtwoord',
  'reset.confirm': 'Nieuw wachtwoord nogmaals',
  'reset.submit': 'Nieuw wachtwoord opslaan',
  'reset.mismatch': 'Deze twee wachtwoorden zijn niet gelijk.',

  'renew.title': 'Je wachtwoord is verlopen',
  'renew.lead': 'Kies een nieuw wachtwoord om verder te gaan.',
  'reset.too_short': 'Minstens twaalf tekens. Een korte zin werkt goed.',
  'reset.factor_totp': 'Code uit je app',
  'reset.factor_hint':
    'Je account heeft een tweede factor, dus die is ook nodig om je wachtwoord opnieuw in te stellen.',
  'renew.lead_full': 'Kies een nieuw wachtwoord om het aanmelden af te ronden. Je bent nog niet aangemeld.',
  'renew.too_short':
    'Minstens twaalf tekens, en niet één die je eerder gebruikt hebt. Een korte zin werkt goed.',
  'renew.submit': 'Opslaan en aanmelden',

  'mfa.title': 'Nog één stap',
  'mfa.code': 'Code',
  'mfa.verify': 'Verifiëren',
  'mfa.wrong_code': 'Deze code klopte niet. Probeer de volgende die je app laat zien.',
  'mfa.use_recovery': 'Gebruik in plaats daarvan een herstelcode',
  'mfa.recovery_code': 'Herstelcode',
  'mfa.use_key': 'Gebruik je beveiligingssleutel',
  'mfa.email_send': 'Stuur mij een code',
  'mfa.email_sent': 'Als er een code naar je adres verstuurd kan worden, is die onderweg.',
  'mfa.expired': 'Deze stap is verlopen. Meld je opnieuw aan.',
  'mfa.lead': 'Je organisatie vraagt een tweede factor voor deze aanmelding.',
  'mfa.totp_code': 'Zescijferige code',
  'mfa.email_code': 'Code uit je e-mail',
  'mfa.email_resend': 'Stuur opnieuw',
  'mfa.recovery_hint': 'Een van de codes die je bewaarde toen je je tweede factor instelde.',
  'mfa.webauthn_lead': 'Gebruik je beveiligingssleutel of passkey wanneer de browser erom vraagt.',
  'mfa.use_totp': 'Gebruik een code uit je app',
  'mfa.use_email': 'Mail mij een code',

  'enrol.title': 'Stel een tweede factor in',
  'enrol.totp': 'Authenticator-app',
  'enrol.webauthn': 'Beveiligingssleutel of passkey',
  'enrol.email_otp': 'Code per e-mail',
  'enrol.lead':
    'Je organisatie vraagt er nu om. Het kost een minuut, en daarna ben je meteen aangemeld.',
  'enrol.totp_lead':
    'Gebruik een authenticator-app — die je organisatie aanraadt, of een andere die zescijferige codes toont.',
  'enrol.start': 'Beginnen',
  'enrol.scan': 'Scan dit met je app en typ daarna de code die hij toont.',
  'enrol.qr_alt': 'QR-code voor je authenticator-app',
  'enrol.cannot_scan': 'Lukt scannen niet? Voer dan deze sleutel in:',
  'enrol.confirm': 'Bevestigen',
  'enrol.webauthn_lead':
    'Gebruik een beveiligingssleutel, of de vingerafdruk of gezichtsherkenning van dit apparaat.',
  'enrol.name_key': 'Geef deze sleutel een naam',
  'enrol.switch_to_key': 'Gebruik in plaats daarvan een beveiligingssleutel',
  'enrol.switch_to_app': 'Gebruik in plaats daarvan een app',

  'portal.title': 'Je applicaties',
  'portal.empty': 'Er is nog niets voor je beschikbaar gesteld.',
  'portal.search': 'Zoeken',
  'portal.sign_out': 'Afmelden',
  'portal.greeting': 'Goedendag, {name}',
  'portal.empty_title': 'Nog geen applicaties toegewezen',
  'portal.empty_body':
    'Zodra je beheerder applicaties aan je toewijst, verschijnen ze hier en open je ze met één klik.',
  'portal.other_group': 'Al het overige',
  'shell.administration': 'Beheer',
  'shell.security': 'Beveiliging',

  'nav.applications': 'Applicaties',
  'nav.catalog': 'Toegang aanvragen',
  'nav.requests': 'Mijn aanvragen',
  'nav.access': 'Mijn toegang',
  'nav.approvals': 'Goedkeuringen',
  'nav.managed': 'Door mij beheerd',
  'nav.tasks': 'Taken',
  'nav.reviews': 'Reviews',
};

/**
 * German.
 *
 * The second market, and included for a structural reason as much as a
 * commercial one: a mechanism with exactly one translation is a mechanism
 * nobody has tested against a language that disagrees with English about word
 * order and string length.
 */
export const de: Catalog = {
  'common.back_to_sign_in': 'Zurück zur Anmeldung',
  'common.cancel': 'Abbrechen',
  'common.continue': 'Weiter',
  'common.language': 'Sprache',
  'common.rate_limited': 'Zu viele Versuche. Warten Sie eine Minute und versuchen Sie es erneut.',

  'login.title': 'Anmelden',
  'login.login': 'Benutzername',
  'login.password': 'Passwort',
  'login.submit': 'Anmelden',
  'login.forgot': 'Passwort vergessen?',
  'login.lead': 'Verwenden Sie das Konto, das Ihre Organisation Ihnen ausgestellt hat.',
  'login.help': 'Probleme bei der Anmeldung? Wenden Sie sich an Ihre IT-Administration.',
  'login.failed': 'Benutzername und Passwort gehören zu keinem Konto.',

  'forgot.title': 'Passwort zurücksetzen',
  'forgot.lead': 'Geben Sie Ihren Benutzernamen oder Ihre dienstliche E-Mail-Adresse ein.',
  'forgot.field': 'Benutzername oder E-Mail',
  'forgot.submit': 'Link senden',
  'forgot.sent_title': 'Sehen Sie in Ihrem Posteingang nach',
  'forgot.sent':
    'Falls dieses Konto existiert, wurde ein Link gesendet. Er gilt einmal und läuft nach dreißig Minuten ab.',
  'forgot.sent_help':
    'Nichts angekommen? Sehen Sie im Spam nach, oder fragen Sie Ihre IT-Administration — bei manchen Konten wird das Passwort woanders verwaltet.',

  'reset.title': 'Neues Passwort wählen',
  'reset.password': 'Neues Passwort',
  'reset.confirm': 'Neues Passwort wiederholen',
  'reset.submit': 'Neues Passwort speichern',
  'reset.mismatch': 'Diese beiden Passwörter stimmen nicht überein.',

  'renew.title': 'Ihr Passwort ist abgelaufen',
  'renew.lead': 'Wählen Sie ein neues, um fortzufahren.',
  'reset.too_short': 'Mindestens zwölf Zeichen. Ein kurzer Satz eignet sich gut.',
  'reset.factor_totp': 'Code aus Ihrer App',
  'reset.factor_hint':
    'Ihr Konto hat einen zweiten Faktor, der auch zum Zurücksetzen des Passworts nötig ist.',
  'renew.lead_full':
    'Wählen Sie ein neues, um die Anmeldung abzuschließen. Sie sind noch nicht angemeldet.',
  'renew.too_short':
    'Mindestens zwölf Zeichen, und keines, das Sie schon verwendet haben. Ein kurzer Satz eignet sich gut.',
  'renew.submit': 'Speichern und anmelden',

  'mfa.title': 'Noch ein Schritt',
  'mfa.code': 'Code',
  'mfa.verify': 'Bestätigen',
  'mfa.wrong_code': 'Dieser Code stimmte nicht. Versuchen Sie den nächsten aus Ihrer App.',
  'mfa.use_recovery': 'Stattdessen einen Wiederherstellungscode verwenden',
  'mfa.recovery_code': 'Wiederherstellungscode',
  'mfa.use_key': 'Sicherheitsschlüssel verwenden',
  'mfa.email_send': 'Code per E-Mail senden',
  'mfa.email_sent': 'Falls ein Code an Ihre Adresse gesendet werden kann, ist er unterwegs.',
  'mfa.expired': 'Dieser Schritt ist abgelaufen. Melden Sie sich erneut an.',
  'mfa.lead': 'Ihre Organisation verlangt für diese Anmeldung einen zweiten Faktor.',
  'mfa.totp_code': 'Sechsstelliger Code',
  'mfa.email_code': 'Code aus Ihrer E-Mail',
  'mfa.email_resend': 'Erneut senden',
  'mfa.recovery_hint': 'Einer der Codes, die Sie beim Einrichten Ihres zweiten Faktors gespeichert haben.',
  'mfa.webauthn_lead': 'Verwenden Sie Ihren Sicherheitsschlüssel oder Passkey, wenn der Browser danach fragt.',
  'mfa.use_totp': 'Code aus Ihrer App verwenden',
  'mfa.use_email': 'Code per E-Mail schicken',

  'enrol.title': 'Zweiten Faktor einrichten',
  'enrol.totp': 'Authenticator-App',
  'enrol.webauthn': 'Sicherheitsschlüssel oder Passkey',
  'enrol.email_otp': 'Code per E-Mail',
  'enrol.lead':
    'Ihre Organisation verlangt jetzt einen. Es dauert eine Minute, danach sind Sie direkt angemeldet.',
  'enrol.totp_lead':
    'Verwenden Sie eine Authenticator-App — die von Ihrer Organisation empfohlene, oder eine beliebige mit sechsstelligen Codes.',
  'enrol.start': 'Starten',
  'enrol.scan': 'Scannen Sie dies mit Ihrer App und geben Sie dann den angezeigten Code ein.',
  'enrol.qr_alt': 'QR-Code für Ihre Authenticator-App',
  'enrol.cannot_scan': 'Scannen nicht möglich? Geben Sie stattdessen diesen Schlüssel ein:',
  'enrol.confirm': 'Bestätigen',
  'enrol.webauthn_lead':
    'Verwenden Sie einen Sicherheitsschlüssel oder den Fingerabdruck- bzw. Gesichtsentsperrer dieses Geräts.',
  'enrol.name_key': 'Diesen Schlüssel benennen',
  'enrol.switch_to_key': 'Stattdessen einen Sicherheitsschlüssel verwenden',
  'enrol.switch_to_app': 'Stattdessen eine App verwenden',

  'portal.title': 'Ihre Anwendungen',
  'portal.empty': 'Ihnen wurde noch nichts bereitgestellt.',
  'portal.search': 'Suchen',
  'portal.sign_out': 'Abmelden',
  'portal.greeting': 'Guten Tag, {name}',
  'portal.empty_title': 'Noch keine Anwendungen zugewiesen',
  'portal.empty_body':
    'Sobald Ihre Administration Ihnen Anwendungen zuweist, erscheinen sie hier und öffnen sich mit einem Klick.',
  'portal.other_group': 'Alles Übrige',
  'shell.administration': 'Verwaltung',
  'shell.security': 'Sicherheit',

  'nav.applications': 'Anwendungen',
  'nav.catalog': 'Zugriff anfordern',
  'nav.requests': 'Meine Anfragen',
  'nav.access': 'Mein Zugriff',
  'nav.approvals': 'Genehmigungen',
  'nav.managed': 'Von mir verwaltet',
  'nav.tasks': 'Aufgaben',
  'nav.reviews': 'Überprüfungen',
};

export const CATALOGS = { en, nl, de } as const;

export type Locale = keyof typeof CATALOGS;

export const LOCALES: { code: Locale; name: string }[] = [
  // Each language named IN ITSELF. A picker that lists "Dutch" in English is a
  // picker the reader who needs it cannot read.
  { code: 'en', name: 'English' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'de', name: 'Deutsch' },
];

export const isLocale = (value: string): value is Locale => value in CATALOGS;
