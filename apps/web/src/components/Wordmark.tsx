import { brandName, useBrand } from '../branding/BrandProvider.js';
import { INTERLOCK_MARK } from '../branding/interlock.js';

/**
 * Two interlocking links form an S: identities joined at one point of access.
 * Shared vector geometry keeps the console and exported assets consistent.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  const brand = useBrand();

  // A tenant that uploaded a logo gets THEIR mark and their name, and Syntra's
  // drawn mark does not sit beside it. Two marks side by side reads as a
  // partnership, which is not what this is.
  if (brand.logo) {
    return (
      <div className={`flex items-center gap-2.5 ${className}`}>
        <img
          src={brand.logo}
          alt={brandName(brand)}
          className="h-7 w-auto max-w-40 shrink-0 object-contain"
        />
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        viewBox="0 0 40 40"
        className="size-7 shrink-0"
        aria-hidden="true"
        fill="none"
      >
        <path
          d={INTERLOCK_MARK.orange}
          stroke="var(--color-primary)"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d={INTERLOCK_MARK.blue}
          stroke="var(--color-accent)"
          strokeWidth="7"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-md font-semibold tracking-tight text-ink">
        {brandName(brand)}
      </span>
    </div>
  );
}
