import type { ReactNode } from 'react';

/**
 * A titled region of a page.
 *
 * No description. Thirty-four panels carried one and they behaved exactly as
 * the page-level descriptions did — restating the title, or explaining a
 * control that should have explained itself. One of them was not prose at all
 * but a client ID smuggled in as a sentence, which is what made the prop worth
 * removing rather than merely emptying: a slot for prose will be filled, and
 * eventually filled with something that is not prose.
 *
 * The title is `text-md` rather than body size. It was `font-semibold` at
 * 0.875rem — the same size as the paragraph beneath it — so the whole
 * hierarchy of a console page rested on font weight, and a panel heading and
 * a bolded word in a sentence were typographically the same event. One step
 * up the scale is enough to separate them without the panel shouting.
 */
export function Panel({
  title,
  actions,
  children,
  bodyClassName = '',
  clip = true,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  /**
   * Clips content to the rounded corners — a table head or a hovered row
   * otherwise pokes square corners through the panel's edge. Turn it off for
   * a panel holding something that must escape it: an `AsyncCombobox` list
   * drawn inside a clipping panel is cut off at the panel's bottom edge, and a
   * picker whose results cannot be seen is a picker that does not work.
   *
   * `overflow: clip`, not `hidden`. Both cut the corners; `hidden` also makes
   * the panel a scroll container, and a sticky `FormActions` inside it then
   * sticks to the panel — which does not scroll — rather than to the page.
   */
  clip?: boolean;
}) {
  return (
    <section
      className={[
        'rounded-panel border border-border-subtle bg-bg',
        clip ? 'overflow-clip' : '',
      ].join(' ')}
    >
      {(title || actions) && (
        <header className="rounded-t-panel flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 py-3">
          {title && <h2 className="text-md font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
