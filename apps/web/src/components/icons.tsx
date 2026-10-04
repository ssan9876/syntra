import { CONSOLE_ICONS } from '../branding/interlock.js';

export type IconName = keyof typeof CONSOLE_ICONS;

/** Interlock's rounded outlines and amber details, always beside readable labels. */
export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  const icon = CONSOLE_ICONS[name];
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0`} fill="none"
      stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={icon.outline} />
      <path d={icon.detail} stroke="var(--color-primary)" />
    </svg>
  );
}
