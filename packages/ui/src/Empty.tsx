import type { ReactNode } from 'react';

/**
 * An empty state names the next action rather than announcing absence.
 * "No users yet" tells the reader nothing they did not already know.
 */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-panel border border-dashed border-border-subtle px-6 py-12 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {children && (
        <p className="mx-auto mt-1.5 max-w-[52ch] text-muted">{children}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
