import { useState } from 'react';

type Size = 'sm' | 'md' | 'lg';

const SIZES: Record<Size, { box: string; px: number; text: string }> = {
  sm: { box: 'size-6 rounded-[0.3rem]', px: 24, text: 'text-[0.625rem]' },
  md: { box: 'size-10 rounded-control', px: 40, text: 'text-sm' },
  lg: { box: 'size-16 rounded-panel', px: 64, text: 'text-lg' },
};

/**
 * Only sources this page can actually load: a same-origin path — a built-in
 * mark under `/app-icons/`, or an uploaded logo the API serves — or an inline
 * raster. A remote http(s) URL is refused here rather than attempted: the
 * page's security policy blocks it anyway, and trying costs a failed request
 * and a flash of broken image on every portal load.
 */
export function isAppLogoSource(url: string): boolean {
  return /^\/(?!\/)/.test(url) || /^data:image\/(png|jpeg|webp);base64,/i.test(url);
}

/** Two letters from the name: no icon service, no network call, no CDN. */
export function monogram(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * An application's logo, or its monogram.
 *
 * One component for the portal tile, the applications list and the logo
 * picker, so the three can never disagree about what a tile will look like —
 * the picker's preview is only worth trusting if it is the same code.
 *
 * `alt=""`: the name is always written beside it, and "Payroll logo, Payroll"
 * is the name twice. `object-contain` at a fixed size, so a wide wordmark and
 * a square mark sit on one line and neither is cropped.
 */
export function AppLogo({
  name,
  src,
  size = 'md',
}: {
  name: string;
  src: string | null | undefined;
  size?: Size;
}) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const style = SIZES[size];
  if (!src || failedFor === src || !isAppLogoSource(src)) {
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center bg-primary-soft font-semibold text-primary ${style.box} ${style.text}`}
      >
        {monogram(name)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={style.px}
      height={style.px}
      loading="lazy"
      onError={() => setFailedFor(src)}
      className={`shrink-0 object-contain ${style.box}`}
    />
  );
}
