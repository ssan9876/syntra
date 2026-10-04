/** Separate, development-only entry. Never imported by the production app. */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, Link, useLocation } from 'react-router-dom';
import { BrandProvider } from '../branding/BrandProvider.js';
import { LocaleProvider } from '../i18n/LocaleProvider.js';
import { SessionProvider } from '../session/SessionProvider.js';
import { AppShell } from '../components/AppShell.js';
import { AdminNav, GROUPS } from '../pages/admin/AdminNav.js';
import { DashboardPage } from '../pages/admin/DashboardPage.js';
import { Icon, type IconName } from '../components/icons.js';
import { CONSOLE_ICONS } from '../branding/interlock.js';
import { BUILTIN_APP_ICONS, BUILTIN_APP_ICON_LABELS } from '@syntra/contracts/src/app-icon-keys.js';
import { installPreviewData } from './sample-data.js';
import '../index.css';

if (!import.meta.env.DEV) throw new Error('The icon preview is available only in development.');
installPreviewData();

function IconGallery() {
  const { pathname } = useLocation();
  const current = GROUPS.flatMap((g) => g.items).find((item) => item.to === pathname);
  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold text-ink">{current?.label ?? 'All icons'}</h1>
      <p className="mb-6 text-sm text-muted">Interlock icons at console size and export size.</p>
      <div className="mb-8 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
        {(Object.keys(CONSOLE_ICONS) as IconName[]).map((name) => (
          <div key={name} className="flex items-center gap-3">
            <Icon name={name} className="size-7" /><Icon name={name} />
            <a className="link text-sm" href={`/brand/icons/${name}.webp`} download>{name}</a>
          </div>
        ))}
      </div>
      <h2 className="mb-5 text-lg font-semibold text-ink">Application icons</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
        {BUILTIN_APP_ICONS.map((key) => (
          <a key={key} className="flex items-center gap-3 rounded-control text-sm text-ink" href={`/app-icons/${key}.webp`} download>
            <img src={`/app-icons/${key}.svg`} width="40" height="40" alt="" />
            {BUILTIN_APP_ICON_LABELS[key]}
          </a>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap gap-5 text-sm">
        <a className="link" href="/brand/syntra-logo.webp" download>Download logo WebP</a>
        <a className="link" href="/brand/syntra-mark.webp" download>Download mark WebP</a>
      </div>
    </>
  );
}

function Preview() {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface px-6 py-2 text-sm text-muted">
        <span>Design preview · Sample data</span>
        <div className="flex gap-5">
          <Link className="link" to="/admin">Overview</Link>
          <Link className="link" to="/admin/icons">All icons + WebP downloads</Link>
        </div>
      </div>
      <AppShell sidebar={<AdminNav />}>
        <Routes>
          <Route path="/admin" element={<DashboardPage />} />
          <Route path="*" element={<IconGallery />} />
        </Routes>
      </AppShell>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/admin']}>
    <BrandProvider><LocaleProvider><SessionProvider><Preview /></SessionProvider></LocaleProvider></BrandProvider>
  </MemoryRouter>,
);
