import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal, built on the browser's own `<dialog>`.
 *
 * `showModal()` is what gets the three things a hand-rolled overlay always
 * gets wrong: focus is moved in and trapped, Escape closes, and everything
 * behind it is inert to a screen reader as well as to the pointer. Focus goes
 * back to whatever opened it on close, which the browser also does, and which
 * a `<div role="dialog">` with a backdrop does not.
 *
 * For a decision that must be made before anything else on the page — a
 * confirmation, a short form that does not belong in the flow. Not for
 * anything the reader would want to compare with what is behind it: a modal
 * hides the evidence, and an impact preview belongs beside the change.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // jsdom has no `showModal`; fall back to the attribute so the content is
    // still rendered and testable.
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
      className="dialog-enter m-auto w-[min(32rem,calc(100vw-2rem))] rounded-panel border border-border-subtle bg-bg p-0 text-ink shadow-overlay backdrop:bg-ink/30"
    >
      {open && (
        <div className="px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <div className="mt-3">{children}</div>
          {actions && <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}
