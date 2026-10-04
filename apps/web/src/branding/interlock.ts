/** Shared geometry for live SVGs and downloadable raster exports. */
export interface InterlockGlyph { outline: string; detail: string }
export const INTERLOCK_MARK = {
  orange: 'M23 7.5H18a8 8 0 0 0-5.66 2.34l-5 5a8 8 0 0 0 11.32 11.32l5-5',
  blue: 'M17 32.5h5a8 8 0 0 0 5.66-2.34l5-5a8 8 0 0 0-11.32-11.32l-5 5',
};
export const CONSOLE_ICONS = {
  users: { outline: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2H4', detail: 'M20 19v2h-3' },
  groups: { outline: 'M4.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM19.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1 20v-2a4 4 0 0 1 4-4M23 20v-2a4 4 0 0 0-4-4M6 21v-3a6 6 0 0 1 12 0v3', detail: 'M12 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' },
  orgUnits: { outline: 'M9 2h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM6 16v-4h12v4', detail: 'M12 7v5' },
  applications: { outline: 'M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z', detail: 'M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z' },
  policy: { outline: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM8 16h5', detail: 'M8 7h8M8 11h8' },
  requests: { outline: 'M3 14l2-9h14l2 9v6H3v-6ZM3 14h5l1.5 3h5l1.5-3h5', detail: 'M12 4v7M9.5 8.5 12 11l2.5-2.5' },
  governance: { outline: 'M7 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M8 2h8v4H8zM8 17h8', detail: 'M8 11l2.5 2.5L16 9' },
  sources: { outline: 'M20 6c0 2-3.6 3.5-8 3.5S4 8 4 6s3.6-3.5 8-3.5S20 4 20 6ZM4 6v12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V6', detail: 'M4 12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5' },
  targets: { outline: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', detail: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 12h.01' },
  setup: { outline: 'M11 5h10M11 12h10M11 19h10', detail: 'M3 5l2 2 3-4M3 12l2 2 3-4M3 19l2 2 3-4' },
  work: { outline: 'M4 7h16a2 2 0 0 1 2 2v11H2V9a2 2 0 0 1 2-2ZM8 7V3h8v4M2 12l6 2h8l6-2', detail: 'M10 13v3h4v-3' },
  lifecycle: { outline: 'M3 10a9 9 0 0 1 16-4M21 14a9 9 0 0 1-16 4', detail: 'M19 2v4h-4M5 22v-4h4' },
  roles: { outline: 'M15.5 13a5.5 5.5 0 1 0-5.2-3.7L3 16.5V21h4v-3h3v-3l2-2.7', detail: 'M16.5 6.5h.01' },
  activity: { outline: 'M2 13h4l3-8 5 15 3-7h5', detail: 'M17 13h5' },
  settings: { outline: 'M9 2h6l.5 3 2 1.2 2.6-1 2 3.6-2.1 2.1v2.2l2.1 2.1-2 3.6-2.6-1-2 1.2-.5 3H9l-.5-3-2-1.2-2.6 1-2-3.6L4 13.1v-2.2L1.9 8.8l2-3.6 2.6 1 2-1.2.5-3Z', detail: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
  updates: { outline: 'M4 17v4h16v-4M12 2v12', detail: 'M7 9l5 5 5-5' },
  privacy: { outline: 'M5 10h14v12H5zM8 10V6a4 4 0 0 1 8 0v4', detail: 'M12 15v3' },
  operations: { outline: 'M3 19a10 10 0 1 1 18 0H3ZM6 14h.01M12 6h.01M18 14h.01', detail: 'M12 16l4-6' },
  overview: { outline: 'M3 3h7v8H3zM3 15h7v6H3zM14 11h7v10h-7z', detail: 'M14 3h7v4h-7z' },
} satisfies Record<string, InterlockGlyph>;
