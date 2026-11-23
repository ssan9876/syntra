import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Files moved onto the catalogs stay on them.
 *
 * Add a file here when its last hard-coded string goes. From then on a new
 * English word written straight into its JSX fails this test rather than
 * shipping English to a French reader on a page that otherwise speaks
 * French. Paths are relative to `apps/web`.
 *
 * The check is deliberately crude: literal JSX text with a letter in it, and
 * a literal `label`, `title`, `aria-label`, `placeholder` or `alt` attribute.
 * It does not read string literals in plain TypeScript, so a label built in a
 * helper is the reviewer's to catch.
 */
export const CONVERTED = [
  // packages/ui: every component that renders text of its own.
  '../../packages/ui/src/AsyncCombobox.tsx',
  '../../packages/ui/src/Filters.tsx',
  '../../packages/ui/src/Form.tsx',
  '../../packages/ui/src/Freshness.tsx',
  '../../packages/ui/src/ListControls.tsx',
  '../../packages/ui/src/Meter.tsx',
  '../../packages/ui/src/Pager.tsx',
  '../../packages/ui/src/Selection.tsx',
  '../../packages/ui/src/Status.tsx',
  '../../packages/ui/src/Table.tsx',
  '../../packages/ui/src/Toast.tsx',
  // The shell shared by the portal and the console.
  'src/components/AppShell.tsx',
  'src/components/PortalNav.tsx',
  'src/components/StatCards.tsx',
  'src/components/Tabs.tsx',
  'src/routes.tsx',
  // The console's chrome.
  'src/pages/admin/AdminApp.tsx',
  'src/pages/admin/AdminNav.tsx',
  'src/pages/admin/Breadcrumbs.tsx',
  'src/pages/admin/PageHeader.tsx',
  'src/pages/admin/DeleteButton.tsx',
  'src/pages/admin/RestoreHoldBanner.tsx',
  'src/pages/admin/BreakGlassBanner.tsx',
  'src/pages/admin/HeldChangePrompt.tsx',
  'src/pages/admin/ExternalWriteStopPanel.tsx',
  'src/pages/admin/TenantWriteStopPanel.tsx',
  'src/pages/admin/TargetWriteStopPanel.tsx',
  'src/pages/admin/run-states.tsx',
  // Reference pages.
  'src/pages/admin/TargetsPage.tsx',
  'src/pages/admin/SourcesPage.tsx',
  'src/pages/admin/RunsTab.tsx',
];

/** The offending literals in a TSX source, comments removed first. */
export function hardCoded(source: string): string[] {
  const code = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const found: string[] = [];
  // `(?<!=)`: the `>` of an arrow function is not the end of a tag.
  for (const match of code.matchAll(/(?<!=)>([^<>{}]*)</g)) {
    const text = match[1]!.replace(/\s+/g, ' ').trim();
    // Type arguments and the operators of a JSX ternary also sit between `>`
    // and `<`; text does not start with `:` or end with `?`.
    if (!/\p{L}/u.test(text) || /[=;()|&]/.test(text) || /^[:?]|[:?]$/.test(text)) continue;
    found.push(text);
  }
  for (const match of code.matchAll(/\b(label|title|aria-label|placeholder|alt)="([^"]*\p{L}[^"]*)"/gu)) {
    found.push(`${match[1]}="${match[2]}"`);
  }
  return found;
}

describe('converted files', () => {
  it('render no hard-coded text', () => {
    const offenders = CONVERTED.flatMap((file) =>
      hardCoded(readFileSync(file, 'utf8')).map((text) => `${file}: ${text}`),
    );
    expect(offenders).toEqual([]);
  });

  it('catches the shapes it is meant to', () => {
    expect(hardCoded('<p>Never run</p>')).toEqual(['Never run']);
    expect(hardCoded('<Field label="Name" />')).toEqual(['label="Name"']);
    expect(hardCoded("<p>{t('targets.never_run')}</p>")).toEqual([]);
    expect(hardCoded('const x = useState<Set<string>>(new Set());')).toEqual([]);
    expect(hardCoded('{/* <p>Commented out</p> */}')).toEqual([]);
  });
});
