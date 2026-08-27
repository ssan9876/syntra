import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The shell is one centred slab, and stays one.
 *
 * An ultrawide monitor put the console's navigation against the far-left
 * bezel and its content two feet away from it, so reading a row meant turning
 * your head. The previous layout was deliberate — its docstring argued that
 * centring the CONTENT opened a gap between the rail and the table that grew
 * with the monitor, which was true — but it fixed the gap by giving up on the
 * centring instead of by moving what gets centred.
 *
 * The resolution: centre the RAIL AND THE CONTENT TOGETHER as a single capped
 * slab. The rail stays glued to the content, so the gap the old docstring
 * warned about cannot open; the leftover width goes outside both, where it
 * belongs.
 *
 * Asserted against the source rather than a render because this is a rule
 * about the layout's structure, not about any one screen, and it is exactly
 * the sort of rule that a page-level edit quietly reintroduces. `--shell-max`
 * is the single place the cap is written down.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the console shell', () => {
  const shell = read('./AppShell.tsx');

  it('caps and centres the row holding the rail and the content together', () => {
    // Both must be inside ONE container. A cap on `main` alone is the old
    // bug wearing a new number.
    const row = shell.match(/\{sidebar\}/);
    expect(row).not.toBeNull();
    expect(shell).toMatch(/mx-auto[^"']*max-w-\[var\(--shell-max\)\]/);
  });

  it('aligns the header to the same slab, so the rule meets the rail', () => {
    // Two different caps would leave the wordmark and the navigation on
    // visibly different left edges, which reads as a misprint.
    const headerCaps = shell.match(/max-w-\[var\(--shell-max\)\]/g) ?? [];
    expect(headerCaps.length).toBeGreaterThanOrEqual(2);
  });

  it('writes the cap once, as a token', () => {
    // A hard-coded `max-w-[1600px]` in a page is how the console ends up with
    // three different widths that nobody chose.
    expect(read('../index.css')).toMatch(/--shell-max:/);
  });
});

describe('the console content area', () => {
  it('imposes no second cap of its own', () => {
    // `max-w-6xl` on the routes container was what left the content narrow
    // and left-hugging inside an already-capped shell — two caps, and the
    // inner one wins, so the outer one silently does nothing.
    const adminApp = read('../pages/admin/AdminApp.tsx');
    const routesRegion = adminApp.slice(adminApp.indexOf('<AppShell'));
    expect(routesRegion).not.toMatch(/max-w-\d/);
    expect(routesRegion).not.toMatch(/max-w-(sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)\b/);
  });
});
