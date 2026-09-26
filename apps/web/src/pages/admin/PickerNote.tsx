import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { AsyncCombobox, type ComboOption } from '@syntra/ui';
import { api } from '../../session/api.js';

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
 * The honest fix is a picker that searches on its own — `PersonPicker` below,
 * for people. Until every capped picker has moved to one, this says so and
 * points at the screen that can.
 */
export function PickerNote({ shown, total, to, label }: PickerNoteProps) {
  if (total <= shown) return null;
  return (
    <p className="mt-1 text-sm text-muted">
      Showing the first {shown.toLocaleString()} of {total.toLocaleString()} ·{' '}
      <Link to={to}>Search {label}</Link>
    </p>
  );
}

interface PersonRow {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail?: string | null;
  externalId?: string | null;
}

/** How many matches one keystroke asks for. A picker is not a list screen. */
export const PERSON_SEARCH_PAGE = 20;

/**
 * One person-search request, shaped for `AsyncCombobox`.
 *
 * The directory list endpoint already searches names, external ids and
 * business email server-side (`?q=`), so the picker asks it rather than
 * filtering a first page in the browser. The detail line is what tells two
 * people with one name apart: their email, or failing that their HR id.
 */
export async function searchPeople(query: string, signal: AbortSignal): Promise<ComboOption[]> {
  const params = new URLSearchParams({ q: query.trim(), pageSize: String(PERSON_SEARCH_PAGE) });
  const result = await api<{ persons: PersonRow[] }>(`/api/admin/persons?${params.toString()}`, { signal });
  return result.persons.map((person) => ({
    value: person.id,
    label: `${person.givenName} ${person.familyName}`.trim(),
    detail: person.businessEmail ?? person.externalId ?? undefined,
  }));
}

/**
 * A person chooser that finds anybody in the directory, not the first two
 * hundred of them.
 */
export function PersonPicker({
  label,
  value,
  onChange,
  name,
  error,
  warning,
  exclude,
  className,
}: {
  label: string;
  value: ComboOption | null;
  onChange(option: ComboOption | null): void;
  name?: string | undefined;
  error?: string | undefined;
  warning?: string | undefined;
  /** A person who cannot be the answer — nobody manages themselves. */
  exclude?: string | undefined;
  className?: string | undefined;
}) {
  const load = useCallback(
    async (query: string, signal: AbortSignal) =>
      (await searchPeople(query, signal)).filter((option) => option.value !== exclude),
    [exclude],
  );
  return (
    <AsyncCombobox
      label={label}
      value={value}
      onChange={onChange}
      load={load}
      name={name}
      error={error}
      warning={warning}
      className={className}
      placeholder="Search name, email or HR id"
    />
  );
}
