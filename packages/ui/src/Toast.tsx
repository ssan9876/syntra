import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Tone = 'success' | 'info' | 'warning' | 'danger';

export interface ToastInput {
  tone?: Tone | undefined;
  title: string;
  /** A link or a detail. Kept short: a toast is read in passing. */
  body?: ReactNode;
}

interface ToastItem extends Required<Pick<ToastInput, 'title'>> {
  id: number;
  tone: Tone;
  body?: ReactNode;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/**
 * Confirms that something the reader did has taken.
 *
 * A save that answers by quietly re-rendering the same form is a save the
 * reader cannot tell apart from a click that did nothing, so they click
 * again. This is the small, unobtrusive "it took". It is NOT where anything
 * important goes: a toast disappears, and a job's receipt, a failure somebody
 * must act on, or a consequence that outlives the moment belongs on the page
 * as an `Alert` where it stays.
 *
 * Which is why `danger` does not time out. An error that vanishes after five
 * seconds is an error somebody at another tab never saw.
 */
export function useToast() {
  const push = useContext(ToastContext);
  // A no-op without a provider rather than a throw. A page rendered in a test
  // or out of the shell should lose its confirmation, not its content.
  return push ?? noop;
}

function noop() {}

const TIMEOUT_MS = 5000;

const TONES: Record<Tone, { box: string; title: string }> = {
  success: { box: 'border-success/35', title: 'text-success' },
  info: { box: 'border-border-control', title: 'text-ink' },
  warning: { box: 'border-warning/35', title: 'text-warning' },
  danger: { box: 'border-danger/35', title: 'text-danger' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = next.current++;
    setToasts((current) => [
      // Three at most. A stack of confirmations is a log, and there is one.
      ...current.slice(-2),
      { id, tone: input.tone ?? 'success', title: input.title, body: input.body },
    ]);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* One region, always present, so the arrival of a toast is a change
          inside a live region a screen reader was already watching. */}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-toast)] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss(): void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || toast.tone === 'danger') return;
    const timer = setTimeout(onDismiss, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [paused, toast.tone, onDismiss]);

  const style = TONES[toast.tone];
  return (
    <div
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      // Hover or focus holds it: somebody reading it, or reaching for its
      // link, should not have it pulled out from under them.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={[
        'toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-panel border bg-bg px-4 py-3 shadow-overlay',
        style.box,
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${style.title}`}>{toast.title}</p>
        {toast.body && <div className="mt-0.5 text-sm text-ink">{toast.body}</div>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink"
      >
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
