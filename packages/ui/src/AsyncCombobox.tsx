import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  /** A second line that tells two "Sam Taylor"s apart: an email, a login, a DN. */
  detail?: string | undefined;
}

export interface AsyncComboboxProps {
  label: string;
  value: ComboOption | null;
  onChange(option: ComboOption | null): void;
  /**
   * Asks the SERVER. The signal is aborted when a newer query supersedes this
   * one, so a slow answer to "ar" can never land on top of "archer".
   */
  load(query: string, signal: AbortSignal): Promise<ComboOption[]>;
  placeholder?: string | undefined;
  warning?: string | undefined;
  error?: string | undefined;
  name?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

type Phase = 'idle' | 'loading' | 'ready' | 'failed';

const DEBOUNCE_MS = 250;

/**
 * A searchable picker whose options live on the server.
 *
 * The console's pickers were `<select>`s filled from the first two hundred
 * rows of a list endpoint, which on a directory of four thousand is a picker
 * that states, with complete confidence, that most people do not exist. The
 * usability review found it twice — the person picker and the entitlement
 * list. This asks the server for what was typed instead of filtering a sample.
 *
 * ARIA 1.2 combobox: focus stays in the input, the highlighted option is
 * `aria-activedescendant`, arrows move, Enter picks, Escape closes and then
 * clears. The result count is announced politely, because a listbox that
 * silently empties reads to a screen reader as a picker that did nothing.
 *
 * Leaving the box without picking puts the committed choice back. Half-typed
 * text in a picker that still holds the old value is two answers on screen
 * and only one of them will be submitted.
 */
export function AsyncCombobox({
  label,
  value,
  onChange,
  load,
  placeholder,
  warning,
  error,
  name,
  disabled,
  className = '',
}: AsyncComboboxProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [options, setOptions] = useState<ComboOption[]>([]);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  // Follow a value set from outside — a reset, a record loading.
  useEffect(() => {
    if (!open) setText(value?.label ?? '');
  }, [value, open]);

  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPhase('loading');
      loadRef
        .current(query, controller.signal)
        .then((rows) => {
          if (controller.signal.aborted) return;
          setOptions(rows);
          setActive(rows.length > 0 ? 0 : -1);
          setPhase('ready');
        })
        .catch(() => {
          if (!controller.signal.aborted) setPhase('failed');
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function openWith(next: string) {
    setOpen(true);
    setQuery(next);
  }

  function pick(option: ComboOption) {
    onChange(option);
    setText(option.label);
    setOpen(false);
    setQuery(null);
  }

  function close() {
    setOpen(false);
    setQuery(null);
    setText(value?.label ?? '');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) return openWith(text === value?.label ? '' : text);
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter' && open) {
      const option = options[active];
      if (option) {
        event.preventDefault();
        pick(option);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        close();
      } else if (value) {
        onChange(null);
        setText('');
      }
    }
  }

  const invalid = Boolean(error);
  const describedBy = error ? `${id}-error` : warning ? `${id}-warning` : undefined;
  const activeId = open && options[active] ? `${id}-opt-${active}` : undefined;
  const status =
    phase === 'loading'
      ? 'Searching…'
      : phase === 'failed'
        ? 'Search failed. Keep typing to try again.'
        : phase === 'ready'
          ? options.length === 0
            ? 'No matches'
            : `${options.length} result${options.length === 1 ? '' : 's'}`
          : '';

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            openWith(e.target.value);
          }}
          onFocus={() => {
            if (!value) openWith(text);
          }}
          onBlur={() => {
            // After the click on an option has landed: `mousedown` on the
            // list prevents the blur, but a Tab out must close it.
            setTimeout(close, 0);
          }}
          onKeyDown={onKeyDown}
          className={[
            'h-9 w-full rounded-control border bg-bg pl-3 pr-8 text-ink',
            'transition-colors duration-150 placeholder:text-muted',
            'disabled:bg-surface-2 disabled:text-muted',
            invalid ? 'border-danger' : 'border-border-control hover:border-border-strong',
          ].join(' ')}
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(null);
              setText('');
            }}
            className="absolute inset-y-0 right-1 my-auto flex size-7 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink"
          >
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {open ? status : ''}
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-[var(--z-dropdown)] mt-1 max-h-72 w-full overflow-y-auto rounded-control border border-border-control bg-bg py-1 shadow-overlay"
        >
          {phase !== 'ready' || options.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted">
              {status || 'Type to search'}
            </li>
          ) : (
            options.map((option, index) => (
              <li
                key={option.value}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
                className={[
                  'cursor-pointer px-3 py-1.5',
                  index === active ? 'bg-primary-soft' : '',
                ].join(' ')}
              >
                <span className="block font-medium text-ink">{option.label}</span>
                {option.detail && <span className="block text-sm text-muted">{option.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
      {warning && !error && (
        <p id={`${id}-warning`} className="mt-1.5 text-sm text-warning">
          {warning}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
