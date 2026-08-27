import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from './session/SessionProvider.js';
import { BrandProvider } from './branding/BrandProvider.js';
import { LocaleProvider } from './i18n/LocaleProvider.js';
import { AppRoutes } from './routes.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Outside the session provider: the sign-in page is unauthenticated
          and is the first screen a brand has to reach. */}
      <BrandProvider>
        <LocaleProvider>
          <SessionProvider>
            <AppRoutes />
          </SessionProvider>
        </LocaleProvider>
      </BrandProvider>
    </BrowserRouter>
  </StrictMode>,
);
