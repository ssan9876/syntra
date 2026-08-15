import type { MappingRule } from './mapping.js';

/**
 * Sensible starting points so the common case needs no typing. An
 * administrator can change any of it; these only seed the editor.
 */
export const DEFAULT_MAPPINGS: Record<
  'activeDirectory' | 'openLdap',
  MappingRule[]
> = {
  activeDirectory: [
    { objectType: 'user', sourceAttribute: 'sAMAccountName', targetField: 'login', transform: 'lowercase', isCorrelation: true },
    { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
    { objectType: 'user', sourceAttribute: 'displayName', targetField: 'displayName', transform: 'trim', isCorrelation: false },
    { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
    { objectType: 'group', sourceAttribute: 'description', targetField: 'description', transform: 'trim', isCorrelation: false },
    { objectType: 'orgUnit', sourceAttribute: 'ou', targetField: 'name', transform: 'trim', isCorrelation: true },
  ],
  openLdap: [
    { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
    { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
    { objectType: 'user', sourceAttribute: 'cn', targetField: 'displayName', transform: 'trim', isCorrelation: false },
    { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
    { objectType: 'orgUnit', sourceAttribute: 'ou', targetField: 'name', transform: 'trim', isCorrelation: true },
  ],
};
