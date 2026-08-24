/**
 * What to tell somebody whose new password was refused.
 *
 * `validateNewPassword` answers in codes, and two routes now have to turn
 * those codes into a sentence: the reset a stranger completes from a mailbox
 * link, and the change a signed-in user makes from the security page. Shared
 * so the two agree — being told "choose a longer password" in one place and
 * "that password does not meet the policy" in the other, for the same typo,
 * reads as two different products.
 *
 * The message never repeats the requirement back as a number. The tenant's
 * minimum is configurable, this module cannot see it, and a sentence naming
 * the wrong figure is worse than one naming none.
 */
export const PASSWORD_REJECTION: Record<string, string> = {
  too_short: 'Choose a longer password.',
  too_long: 'Choose a shorter password.',
  too_obvious: 'Choose something less predictable than your own name or login.',
};

/** Falls back rather than throwing: a new policy code must not become a 500. */
export function passwordRejectionMessage(detail: string | undefined): string {
  return (detail ? PASSWORD_REJECTION[detail] : undefined) ??
    'That password cannot be used.';
}
