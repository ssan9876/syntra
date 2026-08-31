import { Link } from 'react-router-dom';

export interface PickerNoteProps {
  /** How many options the picker actually holds. */
  shown: number;
  /** How many exist. */
  total: number;
  /** The list screen that can search the whole set. */
  to: string;
  /** What that screen is called, in the words its nav entry uses. */
  label: string;
}

/**
 * Said when a picker is not showing everything it is choosing from.
 *
 * These lists page now, so a picker that asks for one page and renders it is
 * quietly missing whoever is not on it — and a chooser that silently lacks the
 * person you are looking for is worse than one that admits it, because the
 * reader concludes the record does not exist.
 *
 * The honest fix is a picker that searches on its own. Until then this says so
 * and points at the screen that can.
 */
export function PickerNote({ shown, total, to, label }: PickerNoteProps) {
  if (total <= shown) return null;
  return (
    <p className="mt-1 text-sm text-muted">
      Showing the first {shown.toLocaleString()} of {total.toLocaleString()}.
      Use <Link to={to}>{label}</Link> to find one that is not listed.
    </p>
  );
}
