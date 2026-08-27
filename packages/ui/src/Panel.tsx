import type { ReactNode } from 'react';

/**
 * A titled region of a page.
 *
 * The title is `text-md` rather than body size. It was `font-semibold` at
 * 0.875rem — the same size as the paragraph beneath it — so the whole
 * hierarchy of a console page rested on font weight, and a panel heading and
 * a bolded word in a sentence were typographically the same event. One step
 * up the scale is enough to separate them without the panel shouting.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  bodyClassName = '',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="overflow-hidden rounded-panel border border-border-subtle bg-bg">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 py-3">
          <div>
            {title && (
              <h2 className="text-md font-semibold text-ink">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-sm text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
