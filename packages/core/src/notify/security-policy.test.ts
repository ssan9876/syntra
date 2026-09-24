import { describe, expect, it } from 'vitest';
import { isSecurityEvent } from './security-events.js';
import {
  SECURITY_NOTIFICATION_CATEGORIES,
  SECURITY_NOTIFICATION_CATEGORY_KEYS,
  securityEventLabel,
  securityNotificationCategoryFor,
} from './security-policy.js';

/**
 * The policy table is data, and configure.md renders it. These keep the data
 * honest: every mailed action is a real security event (so it is also
 * delivered to webhooks and counted), no action is in two categories, and
 * every mailed action reads as a sentence rather than as its dotted name.
 */
describe('the security notification policy', () => {
  it('lists only actions that are already security events', () => {
    for (const key of SECURITY_NOTIFICATION_CATEGORY_KEYS) {
      for (const action of SECURITY_NOTIFICATION_CATEGORIES[key].actions) {
        expect(isSecurityEvent(action), `${key}: ${action}`).toBe(true);
      }
    }
  });

  it('puts each action in exactly one category', () => {
    const seen = new Set<string>();
    for (const key of SECURITY_NOTIFICATION_CATEGORY_KEYS) {
      for (const action of SECURITY_NOTIFICATION_CATEGORIES[key].actions) {
        expect(seen.has(action), action).toBe(false);
        seen.add(action);
        expect(securityNotificationCategoryFor(action)).toBe(key);
      }
    }
    expect(securityNotificationCategoryFor('auth.login')).toBeNull();
  });

  it('names every action the audit hook mails', () => {
    for (const key of SECURITY_NOTIFICATION_CATEGORY_KEYS) {
      if (SECURITY_NOTIFICATION_CATEGORIES[key].mailedBy !== 'audit') continue;
      for (const action of SECURITY_NOTIFICATION_CATEGORIES[key].actions) {
        expect(securityEventLabel(action), action).not.toBe(action);
      }
    }
  });

  it('covers the events backlog #52 names', () => {
    expect(securityNotificationCategoryFor('credential.changed')).toBe('credential_changes');
    expect(securityNotificationCategoryFor('rbac.role_assigned')).toBe('privileged_role_grants');
    expect(securityNotificationCategoryFor('export.request')).toBe('data_exports');
    expect(securityNotificationCategoryFor('provision.tenant.external_writes.pause')).toBe('write_stops');
    expect(securityNotificationCategoryFor('auth.lockout')).toBe('suspicious_authentication');
    expect(securityNotificationCategoryFor('mfa.removed')).toBe('suspicious_authentication');
  });
});
