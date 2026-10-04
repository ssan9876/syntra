# Interlock identity assets

The approved first concept is implemented as two rounded interlocking links,
with blue outlines and amber details across all 19 console navigation glyphs
and the 20 built-in application icons. The application icon keys remain stable.

The console uses inline SVG geometry from
`apps/web/src/branding/interlock.ts`, with tenant-aware primary and accent
colors. Tenant-uploaded logos still replace Syntra's wordmark.

Raster exports are lossless WebP: a 512px mark, 1184px-wide wordmark,
and 192px icons. The mark, wordmark and navigation icons have transparent
backgrounds; application tiles have a pale background with transparent corners.
Assets live in `apps/web/public/brand/` and `apps/web/public/app-icons/`.

Regenerate using Node and an available Sharp installation:

```powershell
node --import tsx scripts/export-interlock.ts <absolute-path-to-sharp-module>
```

The optional module argument defaults to `sharp`. Both SVG and WebP assets
are regenerated from the same source geometry. Application outlines are
stored in `apps/web/src/branding/application-glyphs.json`.

Start Vite from `apps/web` and open `/preview.html` for a read-only design
preview using the real console shell, navigation and overview components.
The separate preview entry supplies explicitly labeled sample data and
an icon gallery with WebP downloads. Sidebar destinations display the gallery;
this preview is for inspecting assets, not exercising backend workflows.
It is not included in the production build or imported by the main app.
