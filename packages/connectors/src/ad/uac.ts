/**
 * Active Directory's `userAccountControl`, as a bitfield rather than as two
 * magic numbers.
 *
 * The two constants are what a *newly created* account is written at, in that
 * order. Everything after creation goes through the bit helpers, because by
 * then the value belongs to whoever last edited the account and not to us.
 */

/** A normal account, disabled. Every account is created at this value first. */
export const UAC_NORMAL_DISABLED = 514;
/** A normal account, enabled. */
export const UAC_NORMAL_ENABLED = 512;
/** ACCOUNTDISABLE. */
export const UAC_DISABLE_BIT = 2;

/**
 * Sets the disable bit and leaves every other flag alone.
 *
 * Writing a bare 514 would clear DONT_EXPIRE_PASSWORD, SMARTCARD_REQUIRED and
 * everything else an administrator set by hand on that account. Disabling
 * somebody is not licence to reset their account's other properties.
 */
export function withDisableBit(uac: number): number {
  return uac | UAC_DISABLE_BIT;
}

/** Clears the disable bit and leaves every other flag alone. */
export function withoutDisableBit(uac: number): number {
  return uac & ~UAC_DISABLE_BIT;
}

/**
 * Reads enabled from the bit, never from equality with 512.
 *
 * `uac === 512` is false for every account an administrator has ever touched
 * — 66048 is a perfectly ordinary enabled account with a non-expiring
 * password — and reading it that way makes `enable_account` propose itself
 * forever against an account that is already enabled.
 */
export function isEnabled(uac: number): boolean {
  return (uac & UAC_DISABLE_BIT) === 0;
}
