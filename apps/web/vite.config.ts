import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * Both are overridable so a second stack can run beside the first — a
 * worktree checked out next to the main one, say — without either answering
 * for the other. A browser test that hits the wrong port tests the wrong
 * build, which is a failure mode that reports as success.
 */
const port = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port,
    // IPv4 LOOPBACK, EXPLICITLY. Vite's default binds whatever `localhost`
    // resolves to, and on Linux that is `::1` alone — while Playwright's
    // chromium is launched with `--host-resolver-rules=MAP acme.localhost
    // 127.0.0.1`, because Syntra selects the tenant from the Host header and
    // the browser has to arrive on a name a tenant claims. The two miss each
    // other and every browser test fails with ERR_CONNECTION_REFUSED on the
    // first `page.goto`, which reads as "the app is broken" rather than "the
    // server is on the other loopback".
    //
    // 127.0.0.1 rather than 0.0.0.0: this is a development server, and putting
    // it on every interface to fix a loopback mismatch would be answering the
    // wrong question.
    host: '127.0.0.1',
    // Fail rather than silently move to the next free port: a suite pointed at
    // 5173 must not quietly be served by whatever else was already there.
    strictPort: true,
    // Everything the API owns, not only `/api`.
    //
    // In production both halves sit behind one origin and this file is not
    // involved. In development Vite is the origin, and a prefix missing from
    // this list is served the single-page application instead: the router owns
    // none of these paths, so its catch-all quietly redirects to the portal.
    // That is what happened to every protocol endpoint — a SAML tile opened
    // `/saml/start/:id` and the browser landed on `/` with no error anywhere,
    // which reads as "the tile does nothing" rather than as a proxy gap.
    //
    // Must NOT change origin, in any of them. Syntra resolves the tenant from
    // the Host header, and Vite's string-shorthand proxy rewrites it to the
    // target, which makes every request look like an unknown tenant.
    proxy: Object.fromEntries(
      ['/api', '/saml', '/oidc', '/federation', '/health'].map((prefix) => [
        prefix,
        { target: apiTarget, changeOrigin: false },
      ]),
    ),
  },
});
