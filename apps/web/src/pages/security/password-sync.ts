/** One target's result, as every password route returns it. */
export interface PasswordSyncTarget {
  targetName: string;
  result: 'synced' | 'skipped' | 'failed';
  message: string;
}

/**
 * The server's sentences for the targets that did not take the password, one
 * per line. Empty when every target took it, or there were none.
 */
export function passwordSyncProblems(targets: PasswordSyncTarget[] | undefined): string[] {
  return (targets ?? []).filter((t) => t.result !== 'synced').map((t) => t.message);
}
