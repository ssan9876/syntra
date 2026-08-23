import type { ReactNode } from 'react';

/**
 * The top of every console page.
 *
 * The title was `text-lg` — 1.25rem against 0.875rem body, which on a dense
 * screen is barely a title at all. At `text-xl` it anchors the page without
 * shouting, which is the whole job: an administrator arriving mid-task needs
 * to confirm where they are in one glance and then stop looking at it.
 *
 * The description is capped at a measure rather than running the width of the
 * content. Console pages are wide because tables need width; a sentence of
 * prose stretched to 1200px is unreadable, and capping it here means no page
 * has to remember to.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-[68ch] text-muted text-pretty">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
