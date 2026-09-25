import { expect, test, type Page } from '@playwright/test';

/**
 * A small visual regression and keyboard suite over the screens the console
 * is judged by: sign-in, the portal, a list, a record, the work queue, and a
 * failure state — each at a desktop, a narrow laptop and a phone width.
 *
 * Opt-in with `E2E_VISUAL=1`, because screenshots are only comparable on the
 * machine that made the baselines: fonts are the system's own (DESIGN.md: no
 * font CDN, ever), so a Windows baseline and a Linux run disagree on every
 * glyph. Generate baselines on the machine that will check them:
 *
 *   E2E_VISUAL=1 SEED_ADMIN_PASSWORD=... SEED_USER_PASSWORD=... \
 *     pnpm e2e visual.spec.ts --update-snapshots
 *
 * Anything that changes between runs — relative times, generated ids — is
 * masked rather than tolerated with a looser threshold. A threshold loose
 * enough to absorb "4 min ago" becoming "5 min ago" is loose enough to absorb
 * a real regression.
 */

const ADMIN = process.env.SEED_ADMIN_PASSWORD;
const USER = process.env.SEED_USER_PASSWORD;

test.skip(!process.env.E2E_VISUAL, 'Set E2E_VISUAL=1 to run the visual suite');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1180, height: 760 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

async function elevateTo(page: Page, path: string, password: string) {
  await page.goto(path);
  const confirm = page.getByRole('heading', { name: /confirm your password/i });
  if (await confirm.isVisible().catch(() => false)) {
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(confirm).toBeHidden();
  }
}

/** Relative times, ids and hashes: content that is correct and never equal twice. */
function volatile(page: Page) {
  return [page.locator('time'), page.locator('code'), page.locator('[data-volatile]')];
}

async function settle(page: Page) {
  // Skeletons first, then content: a screenshot of a half-loaded page is a
  // baseline of the loading state.
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });

    test('sign-in', async ({ page }) => {
      await page.goto('/login');
      await settle(page);
      await expect(page).toHaveScreenshot(`login-${viewport.name}.png`, { fullPage: true });
    });

    test('portal', async ({ page }) => {
      test.skip(!USER, 'SEED_USER_PASSWORD is required');
      await signIn(page, 'jdoe', USER!);
      await settle(page);
      await expect(page).toHaveScreenshot(`portal-${viewport.name}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test('directory list', async ({ page }) => {
      test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
      await signIn(page, 'admin', ADMIN!);
      await elevateTo(page, '/admin/users?tab=people', ADMIN!);
      await settle(page);
      await expect(page).toHaveScreenshot(`people-${viewport.name}.png`, { mask: volatile(page) });
      // The page itself never scrolls sideways; a wide table scrolls inside
      // its own container. DESIGN.md: "The overflow belongs to the table".
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test('person record', async ({ page }) => {
      test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
      await signIn(page, 'admin', ADMIN!);
      await elevateTo(page, '/admin/users?tab=people', ADMIN!);
      await settle(page);
      await page.locator('tbody tr').first().getByRole('link').first().click();
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`person-${viewport.name}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test('employee work queue', async ({ page }) => {
      test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
      await signIn(page, 'admin', ADMIN!);
      await elevateTo(page, '/admin/employee-work', ADMIN!);
      await settle(page);
      await expect(page.getByRole('navigation', { name: 'Work lanes' })).toBeVisible();
      await expect(page).toHaveScreenshot(`employee-work-${viewport.name}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test('failure state', async ({ page }) => {
      test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
      await signIn(page, 'admin', ADMIN!);
      await elevateTo(page, '/admin/people/00000000-0000-4000-8000-000000000000', ADMIN!);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page).toHaveScreenshot(`record-missing-${viewport.name}.png`, { mask: volatile(page) });
    });
  });
}

test.describe('keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every focus stop in the console shell is visible and the rail is reachable', async ({ page }) => {
    test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/employee-work', ADMIN!);
    await settle(page);

    const seen: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40),
          // DESIGN.md: focus is never removed, only shaped.
          visible: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
        };
      });
      if (!stop) continue;
      expect(stop.visible, `focus ring on "${stop.name}"`).toBe(true);
      seen.push(stop.name);
    }
    expect(seen.some((name) => /Employee work/.test(name))).toBe(true);
  });

  test('a lane is operable from the keyboard and says it is selected', async ({ page }) => {
    test.skip(!ADMIN, 'SEED_ADMIN_PASSWORD is required');
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/employee-work', ADMIN!);
    await settle(page);
    const lane = page.getByRole('navigation', { name: 'Work lanes' }).getByRole('link', { name: /Blocked/ });
    await lane.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/lane=blocked/);
    await expect(lane).toHaveAttribute('aria-current', 'true');
  });
});
