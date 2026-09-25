// No imports, on purpose -- like `launchable-url.ts`. The console bundles
// this file directly for the logo picker, and reaching it through the package
// index would pull every zod schema in the contracts package into the page.

/**
 * The application logos Syntra ships and serves itself.
 *
 * A logo fetched from a vendor's site is a request, from every employee's
 * browser, to somebody else's server — which is why the page's security policy
 * only allows images from its own origin, and why every remote `iconUrl` has
 * always fallen back to a monogram. So the logos are hosted here: a small
 * library of generic marks, one per kind of application an organisation
 * actually assigns, plus a raster an administrator uploads, which the API
 * stores and serves from this origin.
 *
 * Generic on purpose. A vendor's trademark in the product would be a licence
 * question for every tenant; "calendar" is not.
 *
 * The keys are stable: they are stored. A new mark is a new key, and a key is
 * never renamed or reused for a different picture.
 */
export const BUILTIN_APP_ICONS = [
  'calendar',
  'mail',
  'chat',
  'video',
  'documents',
  'files',
  'wiki',
  'rota',
  'clinical',
  'pharmacy',
  'learning',
  'hr',
  'finance',
  'expenses',
  'crm',
  'helpdesk',
  'analytics',
  'security',
  'building',
  'globe',
] as const;

export type BuiltinAppIcon = (typeof BUILTIN_APP_ICONS)[number];

/** Human names for the picker, in the order it shows them. */
export const BUILTIN_APP_ICON_LABELS: Record<BuiltinAppIcon, string> = {
  calendar: 'Calendar',
  mail: 'Mail',
  chat: 'Chat',
  video: 'Video meetings',
  documents: 'Documents',
  files: 'File storage',
  wiki: 'Handbook',
  rota: 'Rota',
  clinical: 'Clinical records',
  pharmacy: 'Pharmacy',
  learning: 'Learning',
  hr: 'HR',
  finance: 'Finance',
  expenses: 'Expenses',
  crm: 'Customer records',
  helpdesk: 'Help desk',
  analytics: 'Reports',
  security: 'Security',
  building: 'Facilities',
  globe: 'Website',
};

/** Where the web app serves a built-in mark. Static, same origin. */
export function builtinAppIconPath(key: BuiltinAppIcon): string {
  return `/app-icons/${key}.svg`;
}

/** Raster types an administrator may upload. SVG is refused: it can carry script. */
export const APP_ICON_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Decoded size limit for an uploaded logo. A tile draws it at 40px. */
export const MAX_APP_ICON_BYTES = 64 * 1024;

/**
 * The logo as the API reports it. Mirrors `applicationIconView` in
 * `app-icons.ts`, written as a plain type so the console can use it without
 * the schema.
 */
export type ApplicationIconView =
  | { kind: 'builtin'; key: BuiltinAppIcon; url: string }
  | { kind: 'image'; url: string; contentType: (typeof APP_ICON_IMAGE_TYPES)[number]; bytes: number }
  | null;
