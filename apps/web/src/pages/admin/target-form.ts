/**
 * The target editor's form shape and the pure functions that move data
 * between it and the API.
 *
 * Split out of `TargetDetailPage.tsx` so the page component holds only what
 * actually needs React: these are plain data transforms, easiest to read (and
 * to test) with no hooks or JSX in the way.
 */

export type TlsMode = 'ldaps' | 'starttls';
export type EnforcementMode = 'additive' | 'authoritative';
export type TargetType = 'activeDirectory' | 'scim2' | 'httpJson';

export interface Target {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  autoApply: boolean;
  schedule: string | null;
  enforcementMode: EnforcementMode;
  preHireDays: number;
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  archiveAfterDays: number | null;
  reenableWithoutConfirmationDays: number;
  renameEnabled: boolean;
  createAccountThresholdPercent: number;
  disableAccountThresholdPercent: number;
  archiveAccountThresholdPercent: number;
  revokeEntitlementThresholdPercent: number;
  deactivateSyntraUserThresholdPercent: number;
  perEntitlementThresholdPercent: number;
  personPopulationDropPercent: number;
  consecutiveSkippedRuns: number;
  lastSkipReason: string | null;
}

export interface Form {
  name: string;
  type: TargetType;
  url: string;
  tlsMode: TlsMode;
  rejectUnauthorized: boolean;
  bindDn: string;
  // Shared by both connector types: the Active Directory bind password and
  // the SCIM bearer token are both, structurally, "the one credential this
  // target holds" -- `CreateTargetInput.bindPassword` names it that
  // generically for exactly this reason, so the form does too rather than
  // inventing a second field that means the same thing.
  bindPassword: string;
  baseDn: string;
  entitlementSearchBase: string;
  archiveContainer: string;
  // SCIM 2.0 only.
  baseUrl: string;
  // Declarative HTTP only. `documentKey` is which shipped document was
  // started from -- kept so the picker can show it, never sent: the document
  // itself is what is stored, so editing a shipped one later cannot change a
  // target that was built from it.
  documentKey: string;
  documentJson: string;
  schedule: string;
  enabled: boolean;
  autoApply: boolean;
  enforcementMode: EnforcementMode;
  preHireDays: string;
  entitlementRevocationDelayDays: string;
  disableGraceDays: string;
  archiveAfterDays: string;
  reenableWithoutConfirmationDays: string;
  renameEnabled: boolean;
  createAccountThresholdPercent: string;
  disableAccountThresholdPercent: string;
  archiveAccountThresholdPercent: string;
  revokeEntitlementThresholdPercent: string;
  deactivateSyntraUserThresholdPercent: string;
  perEntitlementThresholdPercent: string;
  personPopulationDropPercent: string;
}

export const BLANK: Form = {
  name: '',
  type: 'activeDirectory',
  url: 'ldaps://',
  // No `plain`. `targetConfigSchema` does not offer it, and a target that
  // could be configured to write in the clear is a target that eventually
  // does.
  tlsMode: 'ldaps',
  rejectUnauthorized: true,
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  entitlementSearchBase: '',
  archiveContainer: '',
  baseUrl: 'https://',
  documentKey: '',
  documentJson: '',
  schedule: '',
  enabled: true,
  autoApply: false,
  enforcementMode: 'additive',
  preHireDays: '0',
  entitlementRevocationDelayDays: '0',
  disableGraceDays: '0',
  archiveAfterDays: '',
  reenableWithoutConfirmationDays: '7',
  renameEnabled: false,
  createAccountThresholdPercent: '20',
  disableAccountThresholdPercent: '10',
  archiveAccountThresholdPercent: '2',
  revokeEntitlementThresholdPercent: '10',
  deactivateSyntraUserThresholdPercent: '10',
  perEntitlementThresholdPercent: '50',
  personPopulationDropPercent: '20',
};

/** Config keys this form owns. Anything else on a saved target is carried through. */
export const OWNED_CONFIG_KEYS = [
  'url',
  'tlsMode',
  'rejectUnauthorized',
  'bindDn',
  'baseDn',
  'entitlementSearchBase',
  'archiveContainer',
  'baseUrl',
];

export const THRESHOLDS = [
  ['createAccountThresholdPercent', 'Accounts created'],
  ['disableAccountThresholdPercent', 'Accounts disabled'],
  ['archiveAccountThresholdPercent', 'Accounts archived'],
  ['revokeEntitlementThresholdPercent', 'Entitlements revoked'],
  ['deactivateSyntraUserThresholdPercent', 'Syntra logins deactivated'],
  ['perEntitlementThresholdPercent', 'Holders of any one entitlement'],
  ['personPopulationDropPercent', 'Drop in the person population'],
] as const;

export const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

/**
 * What to do about a skipped schedule, per the reason that was actually
 * recorded.
 *
 * `jobs.ts` writes three distinct reasons and they call for three different
 * things, so one sentence covering all of them is wrong for at least two:
 *
 * - `…is awaiting review (previewed|blocked)…` — there is a plan somebody has
 *   been asked to decide about. Reviewing it is what clears this.
 * - `…is still in progress (running|applying)…` — there is nothing to review.
 *   It clears when the run finishes, or after `STALE_RUN_MS`, at which point
 *   `previewProvisionRun` treats the row as the wreckage of a dead process and
 *   adopts it.
 * - `another run for target … is already in progress; this one did not start`
 *   — `recordSkip` on `ProvisionRunInFlightError`: two runs raced between the
 *   skip check and the create, and the partial unique index refused the second.
 *
 * Matched on the phrases `jobs.ts` and `run-service.ts` compose, not on the
 * status in the brackets, because the reason string is what the API returns and
 * the status is embedded in it.
 */
export function skipAdvice(reason: string | null): string {
  if (reason !== null && reason.includes('is awaiting review')) {
    return (
      'A scheduled run does not start while a run is awaiting review, so that ' +
      'the plan somebody was asked to approve is not superseded every night. ' +
      'Review the outstanding run and this clears on the next schedule.'
    );
  }
  if (reason !== null && reason.includes('already in progress')) {
    return (
      'Two runs raced for this target and the second did not start. There is ' +
      'nothing to review and nothing to do: the next schedule runs normally.'
    );
  }
  if (reason !== null && reason.includes('is still in progress')) {
    return (
      'There is nothing to review here: a run was still going when this ' +
      'schedule fired. It clears when that run finishes — or six hours after ' +
      'that run last showed any sign of progress, when a later run treats it ' +
      'as the wreckage of a process that died and adopts it.'
    );
  }
  return (
    'A scheduled run did not start. The reason was not recorded, so the runs ' +
    'for this target are the place to look.'
  );
}

/**
 * Parses a connector document, or null.
 *
 * Used both to show a message under the box and to build the config, so the
 * form and the request can never disagree about whether the document is
 * readable.
 */
export function parseDocument(json: string): Record<string, unknown> | null {
  if (json.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formFrom(target: Target): Form {
  const config = target.config ?? {};
  const url = text(config.url, BLANK.url);
  return {
    name: target.name,
    type:
      target.type === 'scim2'
        ? 'scim2'
        : target.type === 'httpJson'
          ? 'httpJson'
          : 'activeDirectory',
    documentKey: '',
    documentJson:
      config.document === undefined ? '' : JSON.stringify(config.document, null, 2),
    baseUrl: text(config.baseUrl, BLANK.baseUrl),
    url,
    tlsMode:
      config.tlsMode === 'starttls' || config.tlsMode === 'ldaps'
        ? config.tlsMode
        : url.trim().toLowerCase().startsWith('ldaps:')
          ? 'ldaps'
          : 'starttls',
    rejectUnauthorized: config.rejectUnauthorized !== false,
    bindDn: text(config.bindDn),
    // Never populated. The vault holds it, the API never returns it, and an
    // empty box on an edit form means "leave it alone".
    bindPassword: '',
    baseDn: text(config.baseDn),
    entitlementSearchBase: text(config.entitlementSearchBase),
    archiveContainer: text(config.archiveContainer),
    schedule: target.schedule ?? '',
    enabled: target.enabled,
    autoApply: target.autoApply,
    enforcementMode: target.enforcementMode,
    preHireDays: String(target.preHireDays),
    entitlementRevocationDelayDays: String(target.entitlementRevocationDelayDays),
    disableGraceDays: String(target.disableGraceDays),
    // Null means never, and an empty box is how "never" is typed.
    archiveAfterDays:
      target.archiveAfterDays === null ? '' : String(target.archiveAfterDays),
    reenableWithoutConfirmationDays: String(
      target.reenableWithoutConfirmationDays,
    ),
    renameEnabled: target.renameEnabled,
    createAccountThresholdPercent: String(target.createAccountThresholdPercent),
    disableAccountThresholdPercent: String(target.disableAccountThresholdPercent),
    archiveAccountThresholdPercent: String(target.archiveAccountThresholdPercent),
    revokeEntitlementThresholdPercent: String(
      target.revokeEntitlementThresholdPercent,
    ),
    deactivateSyntraUserThresholdPercent: String(
      target.deactivateSyntraUserThresholdPercent,
    ),
    perEntitlementThresholdPercent: String(target.perEntitlementThresholdPercent),
    personPopulationDropPercent: String(target.personPopulationDropPercent),
  };
}

export function configFromForm(
  form: Form,
  extraConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (form.type === 'httpJson') {
    // Parsed here so a malformed document is a message under the box rather
    // than a 400 from a field the reader cannot see. `submit` checks the
    // same thing first and stops; this is the shape the server gets.
    return { document: parseDocument(form.documentJson) ?? {} };
  }
  if (form.type === 'scim2') {
    return { ...extraConfig, baseUrl: form.baseUrl.trim() };
  }
  return {
    ...extraConfig,
    url: form.url.trim(),
    tlsMode: form.tlsMode,
    rejectUnauthorized: form.rejectUnauthorized,
    bindDn: form.bindDn.trim(),
    baseDn: form.baseDn.trim(),
    entitlementSearchBase: form.entitlementSearchBase.trim(),
    archiveContainer: form.archiveContainer.trim(),
  };
}

/**
 * The numbers, or the fields that are not one.
 *
 * Checked here rather than left to the server because a `PATCH` carrying
 * `NaN` serialises to `null` and comes back as a type error against a field
 * nobody typed in. Every one of these is a percentage or a day count that
 * the guard or the ladder reads.
 *
 * Pure: every bad field found this pass is returned in one map rather than
 * stopping at the first, so a form with three malformed thresholds can be
 * told about all three at once instead of one at a time as each is fixed in
 * turn. The caller merges `bad` into its own `invalid` state.
 */
export function validateNumbers(
  form: Form,
): { values: Record<string, number | null> } | { bad: Record<string, string> } {
  const values: Record<string, number | null> = {};
  const bad: Record<string, string> = {};
  const whole = (key: keyof Form, max: number) => {
    const raw = String(form[key]).trim();
    const value = Number(raw);
    if (raw === '' || !Number.isInteger(value) || value < 0 || value > max) {
      bad[key] = `a whole number between 0 and ${max}`;
      return;
    }
    values[key] = value;
  };

  for (const [key] of THRESHOLDS) {
    whole(key, 100);
  }
  for (const key of [
    'preHireDays',
    'entitlementRevocationDelayDays',
    'disableGraceDays',
    'reenableWithoutConfirmationDays',
  ] as const) {
    whole(key, key === 'preHireDays' ? 365 : 3650);
  }
  // Blank is `null`, which is what "never archive" is stored as.
  const archive = form.archiveAfterDays.trim();
  if (archive === '') {
    values.archiveAfterDays = null;
  } else {
    const value = Number(archive);
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      bad.archiveAfterDays = 'a whole number of days, or blank for never';
    } else {
      values.archiveAfterDays = value;
    }
  }

  if (Object.keys(bad).length > 0) return { bad };
  return { values };
}
