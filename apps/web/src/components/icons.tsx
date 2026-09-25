/**
 * The console's navigation icons: sixteen outline glyphs on a 16-unit grid,
 * drawn inline so an air-gapped install never reaches for an icon CDN.
 *
 * They are beside the labels, never instead of them. An icon speeds a reader
 * who already knows the rail back to a destination; it names nothing for the
 * reader who does not, and "Sources" against "Target systems" is exactly the
 * pair no picture distinguishes.
 */
export type IconName =
  | 'users'
  | 'groups'
  | 'orgUnits'
  | 'applications'
  | 'policy'
  | 'requests'
  | 'governance'
  | 'sources'
  | 'targets'
  | 'setup'
  | 'work'
  | 'lifecycle'
  | 'roles'
  | 'activity'
  | 'settings'
  | 'updates'
  | 'privacy'
  | 'operations';

const PATHS: Record<IconName, string> = {
  users: 'M5.5 7a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13.5c.4-2.3 2-3.75 4-3.75s3.6 1.45 4 3.75M10.5 2.75a2.25 2.25 0 0 1 0 4.25M11.75 9.9c1.4.4 2.4 1.6 2.75 3.6',
  groups: 'M2 3.5h5v4H2zM9 3.5h5v4H9zM5.5 9.5h5v4h-5z',
  orgUnits: 'M6 1.75h4v3H6zM2 11.25h4v3H2zM10 11.25h4v3h-4zM8 4.75v3.5M4 11.25V8.25h8v3',
  applications: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
  policy: 'M8 1.5l5.5 2v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4zM5.75 8l1.6 1.6 3-3.2',
  requests: 'M2 9.5l1.6-6h8.8L14 9.5v4H2zM2 9.5h3.5l.75 1.5h3.5l.75-1.5H14',
  governance: 'M2.5 2.5h11v11h-11zM5 6l1.25 1.25L8.5 5M5 10.5h6M9.75 6.25H11',
  sources: 'M8 2c3.3 0 5.5.9 5.5 2S11.3 6 8 6 2.5 5.1 2.5 4 4.7 2 8 2ZM2.5 4v8c0 1.1 2.2 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.2 2 5.5 2s5.5-.9 5.5-2',
  targets: 'M8 14.25A6.25 6.25 0 1 0 8 1.75a6.25 6.25 0 0 0 0 12.5ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 8h.01',
  setup: 'M3 3.5l1 1 2-2M3 8l1 1 2-2M3 12.5l1 1 2-2M8.5 3.75H14M8.5 8.25H14M8.5 12.75H14',
  work: 'M2 5h12v8.5H2zM5.5 5V3h5v2M2 8.75h12M7 8.75v1.5h2v-1.5',
  lifecycle: 'M13.5 8A5.5 5.5 0 0 1 3.4 11M2.5 8a5.5 5.5 0 0 1 10.1-3M12.75 1.75V5H9.5M3.25 14.25V11H6.5',
  roles: 'M10 9.25a3.5 3.5 0 1 0-3.4-2.7L2 11.25V14h2.75v-1.5h1.5V11h1.5l1.1-1.1c.35.1.75.15 1.15.15ZM10.75 5.25h.01',
  activity: 'M1.5 8.5h3l2-5 3 9 2-4h3',
  settings: 'M2 4h7M12 4h2M2 12h2M7 12h7M10.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  updates: 'M8 2v8M4.75 6.75 8 10l3.25-3.25M2.5 12v1.75h11V12',
  privacy: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v7h-9zM8 9.75v1.75',
  operations: 'M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.75-3.25M4.25 11.5h.01M11.75 11.5h.01M8 6h.01',
};

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${className} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
