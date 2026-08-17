import { describe, expect, it } from 'vitest';
import {
  UAC_DISABLE_BIT,
  UAC_NORMAL_DISABLED,
  UAC_NORMAL_ENABLED,
  isEnabled,
  withDisableBit,
  withoutDisableBit,
} from './uac.js';

describe('userAccountControl', () => {
  it('uses the two values Active Directory expects', () => {
    expect(UAC_NORMAL_ENABLED).toBe(512);
    expect(UAC_NORMAL_DISABLED).toBe(514);
    expect(UAC_DISABLE_BIT).toBe(2);
  });

  it('sets and clears only the disable bit, preserving every other flag', () => {
    // 66048 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD. Disabling somebody must
    // not silently re-enable password expiry, or smart-card requirement, or
    // any of the dozen other flags an administrator set by hand.
    expect(withDisableBit(66_048)).toBe(66_050);
    expect(withoutDisableBit(66_050)).toBe(66_048);
  });

  it('is idempotent in both directions', () => {
    // disable_account asserts a state rather than toggling one, which is what
    // makes it free to retry.
    expect(withDisableBit(withDisableBit(512))).toBe(514);
    expect(withoutDisableBit(withoutDisableBit(514))).toBe(512);
  });

  it('reads enabled from the bit, not from equality with 512', () => {
    expect(isEnabled(512)).toBe(true);
    expect(isEnabled(66_048)).toBe(true);
    expect(isEnabled(514)).toBe(false);
    expect(isEnabled(66_050)).toBe(false);
  });

  it('leaves an already-correct value untouched', () => {
    // The two constants have to be fixed points of their own helpers, or a
    // create writes 514 and the very next assertion of "disabled" changes it.
    expect(withDisableBit(UAC_NORMAL_DISABLED)).toBe(UAC_NORMAL_DISABLED);
    expect(withoutDisableBit(UAC_NORMAL_ENABLED)).toBe(UAC_NORMAL_ENABLED);
    expect(withDisableBit(UAC_NORMAL_ENABLED)).toBe(UAC_NORMAL_DISABLED);
    expect(withoutDisableBit(UAC_NORMAL_DISABLED)).toBe(UAC_NORMAL_ENABLED);
  });
});
