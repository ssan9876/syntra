import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * The tenant's own name, logo and colours, applied before anybody signs in.
 *
 * Fetched once and applied by writing CSS custom properties onto the document
 * root, which is where the design system already reads `--color-primary` and
 * `--color-accent` from. Nothing else in the app has to know a brand exists: a
 * button styled `bg-primary` is the tenant's colour the moment this runs.
 *
 * Renders children IMMEDIATELY, unbranded, rather than holding the tree until
 * the fetch lands. A sign-in page that waits on a decorative request before
 * drawing its password field is a sign-in page that does not work when the API
 * is slow — which is exactly when somebody most needs to get in.
 */

export interface Brand {
  name: string | null;
  logo: string | null;
  primary: string | null;
  accent: string | null;
}

const EMPTY: Brand = { name: null, logo: null, primary: null, accent: null };

const BrandContext = createContext<Brand>(EMPTY);

export const useBrand = () => useContext(BrandContext);

/** The name to show. Syntra's own when the tenant has not chosen one. */
export const brandName = (brand: Brand) => brand.name ?? 'Syntra';

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(EMPTY);

  useEffect(() => {
    let live = true;
    fetch('/api/branding', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : EMPTY))
      .then((body: Brand) => {
        if (live) setBrand({ ...EMPTY, ...body });
      })
      // Swallowed deliberately. An unreachable branding endpoint means the
      // page renders as Syntra, which is correct and is not worth an error
      // banner on a screen somebody is trying to sign in on.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // Set, or REMOVED — never set to a fallback literal. Removing lets the
    // stylesheet's own value apply, including its dark-theme override, and a
    // literal written here would pin one theme's colour into both.
    const apply = (property: string, value: string | null) => {
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    };
    apply('--color-primary', brand.primary);
    // The hover shade travels with the colour. Left alone it would stay
    // Syntra's own, so a branded button would change hue under the cursor.
    apply(
      '--color-primary-hover',
      brand.primary === null
        ? null
        : `color-mix(in oklch, ${brand.primary} 85%, var(--color-ink))`,
    );
    apply('--color-accent', brand.accent);
  }, [brand.primary, brand.accent]);

  useEffect(() => {
    document.title = brandName(brand);
    // `brand`, not `brand.name`. `brandName` reads only the name today, so
    // the narrower list was correct -- but it was correct because of what a
    // function elsewhere happens to do, which is exactly the dependency a
    // reader cannot check. Re-running this when any other brand field changes
    // assigns the same title, which costs nothing.
  }, [brand]);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
