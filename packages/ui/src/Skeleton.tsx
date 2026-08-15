/** Shaped like the content it replaces, never a spinner floating in a panel. */
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-hidden="true" className="space-y-px">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3">
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="skeleton h-4 rounded"
              style={{ width: c === 0 ? '22%' : c === cols - 1 ? '12%' : '18%' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
