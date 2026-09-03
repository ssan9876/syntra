import { useEffect, useRef, useState } from 'react';
import { Field } from './Field.js';
import { Select } from './Select.js';

export interface ListControlsProps {
  /** The search currently in effect, which comes from the URL. */
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  /**
   * The fields this particular list searches, in its own words.
   *
   * Required rather than defaulted, because the default was wrong on every
   * list that had one: "Name, login or id" sat over Groups, which searches
   * name and description, and over People, which searches names, employee
   * reference and work email -- and nothing in the console searches an id at
   * all. A placeholder that names fields the server does not look at teaches
   * a reader to type something that will never match.
   */
  searchPlaceholder: string;
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
  searchPlaceholder,
  status,
}: ListControlsProps) {
  const [draft, setDraft] = useState(search);
  /**
   * The last value this component put into the URL.
   *
   * Adopting `search` on every change of it adopted the component's OWN
   * change too. Under react-router 7 that commit lands inside
   * `startTransition`, so the re-render carrying it can arrive after further
   * keystrokes -- and the box then reverted to what was typed 250ms ago,
   * mid-word. Comparing against this is what tells the two apart: a value we
   * did not submit came from back, forward, or a pasted link, and that one the
   * box does have to follow.
   */
  const submitted = useRef(search);

  useEffect(() => {
    if (search === submitted.current) return;
    submitted.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === submitted.current) return;
    const timer = setTimeout(() => {
      submitted.current = draft;
      onSearch(draft);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, onSearch]);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field
        label={searchLabel}
        type="search"
        value={draft}
        onChange={setDraft}
        placeholder={searchPlaceholder}
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
