import type { ReactNode } from 'react';

/**
 * An empty state names the next action rather than announcing absence.
 * "No users yet" tells the reader nothing they did not already know.
 *
 * NO BORDER OF ITS OWN. This is used inside a `Panel` in every place it
 * appears, and a dashed box drawn inside the panel's own border is a card
 * inside a card — two containers describing one absence, with the padding
 * counted twice. The panel is the container; this is what goes in it.
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
    <div className="py-8 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {children && (
        <p className="mx-auto mt-1.5 max-w-[52ch] text-muted">{children}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
