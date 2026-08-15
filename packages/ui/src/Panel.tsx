import type { ReactNode } from 'react';

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
            {title && <h2 className="font-semibold text-ink">{title}</h2>}
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
