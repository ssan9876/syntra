/**
 * The mark is three converging strokes: separate identities resolving into a
 * single point of access. Drawn rather than lettered so it holds at 20px in a
 * browser tab and at 32px in the sidebar.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        viewBox="0 0 28 28"
        className="size-7 shrink-0"
        aria-hidden="true"
        fill="none"
      >
        <path
          d="M4 5.5h9a7 7 0 0 1 0 14H8"
          stroke="var(--color-primary)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M24 22.5h-9a7 7 0 0 1 0-14h5"
          stroke="var(--color-accent)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-md font-semibold tracking-tight text-ink">
        Syntra
      </span>
    </div>
  );
}
