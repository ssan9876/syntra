/**
 * The directory source editor's form shape and the pure functions that move
 * data between it and the API.
 *
 * Split out of `SourceDetailPage.tsx` so the page component holds only what
 * actually needs React: these are plain data transforms, easiest to read (and
 * to test) with no hooks or JSX in the way.
 */

export type TlsMode = 'plain' | 'starttls' | 'ldaps';

export interface OwnedCounts {
  users: number;
  groups: number;
  orgUnits: number;
}

export interface SourceDetail {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  schedule: string | null;
  autoApply: boolean;
  writebackEnabled: boolean;
  writebackPassword: boolean;
  writebackDisable: boolean;
  writebackDelete: boolean;
  enabled: boolean;
  deactivationThresholdPercent: number;
  lastRunAt: string | null;
  owned: OwnedCounts;
}

export interface Form {
  name: string;
  url: string;
  tlsMode: TlsMode;
  rejectUnauthorized: boolean;
  bindDn: string;
  bindPassword: string;
  userSearchBase: string;
  groupSearchBase: string;
  orgUnitSearchBase: string;
  userFilter: string;
  groupFilter: string;
  orgUnitFilter: string;
  anchorAttribute: string;
  schedule: string;
  enabled: boolean;
  autoApply: boolean;
  writebackEnabled: boolean;
  writebackPassword: boolean;
  writebackDisable: boolean;
  writebackDelete: boolean;
  deactivationThresholdPercent: string;
}

export const BLANK: Form = {
  name: '',
  url: 'ldap://',
  tlsMode: 'starttls',
  rejectUnauthorized: true,
  bindDn: '',
  bindPassword: '',
  userSearchBase: '',
  groupSearchBase: '',
  orgUnitSearchBase: '',
  userFilter: '(objectClass=person)',
  groupFilter: '(objectClass=group)',
  orgUnitFilter: '(objectClass=organizationalUnit)',
  anchorAttribute: 'objectGUID',
  schedule: '',
  enabled: true,
  autoApply: false,
  // Off for a new source too. Write-back is something somebody turns on
  // having decided to, never something a source arrives holding.
  writebackEnabled: false,
  writebackPassword: false,
  writebackDisable: false,
  writebackDelete: false,
  deactivationThresholdPercent: '10',
};

/**
 * What each directory flavour usually wants, so the common case needs no
 * typing. The mappings come from the server (one definition, shared with the
 * validator); the connection settings are here because they are the console's
 * own suggestion and nothing on the server defaults per flavour.
 *
 * The user filter is the reason this exists. The stored default,
 * `(objectClass=person)`, is right for OpenLDAP and wrong for Active
 * Directory, where `computer` derives from `person` and that filter matches
 * every machine account in the domain — one Syntra user per workstation. The
 * conventional Active Directory filter is offered instead, without changing
 * the server-side default that OpenLDAP relies on.
 */
export const FLAVOURS = {
  activeDirectory: {
    label: 'Active Directory',
    anchorAttribute: 'objectGUID',
    userFilter: '(&(objectCategory=person)(objectClass=user))',
    groupFilter: '(objectClass=group)',
  },
  openLdap: {
    label: 'OpenLDAP',
    anchorAttribute: 'entryUUID',
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(objectClass=groupOfNames)',
  },
} as const;

export type Flavour = keyof typeof FLAVOURS;

/** Config keys the form owns. Anything else on a saved source is carried through. */
export const OWNED_CONFIG_KEYS = [
  'url',
  'tlsMode',
  'rejectUnauthorized',
  'bindDn',
  'userSearchBase',
  'groupSearchBase',
  'orgUnitSearchBase',
  'userFilter',
  'groupFilter',
  'orgUnitFilter',
  'anchorAttribute',
];

export const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

export function formFrom(source: SourceDetail): Form {
  const config = source.config ?? {};
  const url = text(config.url, BLANK.url);
  return {
    name: source.name,
    url,
    // The same fallback the connector applies to a source saved before the
    // mode existed, so the form shows the transport actually in use rather
    // than a default that would change it on the next save.
    tlsMode:
      (config.tlsMode as TlsMode | undefined) ??
      (url.trim().toLowerCase().startsWith('ldaps:') ? 'ldaps' : 'plain'),
    rejectUnauthorized: config.rejectUnauthorized !== false,
    bindDn: text(config.bindDn),
    // Never populated. The vault holds it, the API never returns it, and an
    // empty box on an edit form means "leave it alone".
    bindPassword: '',
    userSearchBase: text(config.userSearchBase),
    groupSearchBase: text(config.groupSearchBase),
    orgUnitSearchBase: text(config.orgUnitSearchBase),
    userFilter: text(config.userFilter, BLANK.userFilter),
    groupFilter: text(config.groupFilter, BLANK.groupFilter),
    orgUnitFilter: text(config.orgUnitFilter, BLANK.orgUnitFilter),
    anchorAttribute: text(config.anchorAttribute, BLANK.anchorAttribute),
    schedule: source.schedule ?? '',
    enabled: source.enabled,
    autoApply: source.autoApply,
    writebackEnabled: source.writebackEnabled,
    writebackPassword: source.writebackPassword,
    writebackDisable: source.writebackDisable,
    writebackDelete: source.writebackDelete,
    deactivationThresholdPercent: String(source.deactivationThresholdPercent),
  };
}

export function configFromForm(
  form: Form,
  extraConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extraConfig,
    url: form.url.trim(),
    tlsMode: form.tlsMode,
    rejectUnauthorized: form.rejectUnauthorized,
    bindDn: form.bindDn.trim(),
    userSearchBase: form.userSearchBase.trim(),
    groupSearchBase: form.groupSearchBase.trim(),
    ...(form.orgUnitSearchBase.trim()
      ? { orgUnitSearchBase: form.orgUnitSearchBase.trim() }
      : {}),
    userFilter: form.userFilter.trim(),
    groupFilter: form.groupFilter.trim(),
    orgUnitFilter: form.orgUnitFilter.trim(),
    anchorAttribute: form.anchorAttribute.trim(),
  };
}
