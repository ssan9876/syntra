/**
 * Text from outside, made safe to store.
 *
 * PostgreSQL refuses U+0000 in a text column and in a jsonb string —
 * `22021, invalid byte sequence for encoding "UTF8": 0x00`. Active Directory
 * puts one in its diagnostics: both `AlreadyExistsError … data 0` and
 * `NoSuchObjectError … data 0` carry a NUL immediately after the code, and
 * ldapts hands the message through untouched.
 *
 * Every caller here is storing somebody else's words — a directory's
 * diagnostic, a driver's exception, an HTTP client's failure. None of it has
 * been near a validator, and none of it is read programmatically.
 *
 * **The failure mode this exists to prevent is silence, not corruption.**
 * These messages are almost always written on an error path, and a write that
 * throws inside a `catch` has nothing above it to catch again. Twice now that
 * has meant the record of a failure was destroyed by the failure's own
 * explanation: an action left `in_flight` with its outcome unknown (fixed in
 * v1.6.3), and a sync run left `running` for six and a half hours while the
 * read behind it had failed in 34 milliseconds.
 *
 * Shared rather than copied because the first fix was scoped to the one file
 * that had visibly broken, and the same defect was still sitting in three
 * others. A sanitiser that has to be remembered at each new call site is one
 * that will be forgotten at the next.
 */
export function storableMessage(raw: string): string {
  return raw.replaceAll(NUL, '');
}

/**
 * Written as a code point rather than an escape so that no editor, patch tool
 * or copy-paste can silently turn this file into one containing a real NUL —
 * which is what happened twice while writing the tests for it.
 */
const NUL = String.fromCharCode(0);

/** The same, for a value that may not be a string at all. */
export function storableCause(cause: unknown): string {
  return storableMessage(cause instanceof Error ? cause.message : String(cause));
}
