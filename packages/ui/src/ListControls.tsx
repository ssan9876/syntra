import { useEffect, useState } from 'react';
import { Field } from './Field.js';
import { Select } from './Select.js';

export interface ListControlsProps {
  /** The search currently in effect, which comes from the URL. */
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  status?:
    | {
        value: string;
        onChange(value: string): void;
        options: { value: string; label: string }[];
      }
    | undefined;
}

/** How long typing must settle before it becomes a request. */
const DEBOUNCE_MS = 250;

/**
 * The controls above a list.
 *
 * The input holds its own draft and reports it on a delay: the search in the
 * URL is the one in effect, and a keystroke is not yet a decision. Without
 * this, "archer" is six requests and five of them are stale before they land.
 */
export function ListControls({
  search,
  onSearch,
  searchLabel,
  status,
}: ListControlsProps) {
  const [draft, setDraft] = useState(search);

  // The URL is the source of truth: back, forward, or a link somebody shared
  // changes the search underneath us, and the box has to follow it.
  useEffect(() => setDraft(search), [search]);

  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearch(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, search, onSearch]);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field
        label={searchLabel}
        type="search"
        value={draft}
        onChange={setDraft}
        placeholder="Name, login or id"
      />
      {status && (
        <Select
          label="Status"
          value={status.value}
          onChange={status.onChange}
          options={status.options}
        />
      )}
    </div>
  );
}
