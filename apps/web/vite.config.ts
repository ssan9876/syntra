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
    host: process.env.WEB_HOST ?? '127.0.0.1',
    // WHICH HOSTNAMES THE DEV SERVER WILL ANSWER FOR.
    //
    // Vite refuses an unrecognised Host with 403 "This host is not allowed",
    // before any Syntra code runs — so pointing a DNS record at an instance
    // served this way fails at the dev server, and the tenant resolution
    // underneath never gets a chance to say anything. The default list is
    // localhost and IPs only, which is why `acme.localhost` works and
    // `syntra.example.com` does not.
    //
    // `WEB_ALLOWED_HOSTS` is a comma-separated list; `true` allows any host,
    // which is what a private test instance reached by a name that changes
    // wants. It is deliberately opt-in and deliberately NOT the default: the
    // protection is against DNS rebinding, and a developer's laptop should
    // keep it.
    //
    // None of this belongs in front of real users. `vite` is a development
    // server — no production build, HMR sockets open, sources served. An
    // instance somebody points a domain at should be running `vite build`
    // output behind a real server.
    allowedHosts:
      process.env.WEB_ALLOWED_HOSTS === 'true'
        ? true
        : (process.env.WEB_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ??
          []),
    // Fail rather than silently move to the next free port: a suite pointed at
    // 5173 must not quietly be served by whatever else was already there.
    strictPort: true,
    // Everything the API owns, not only `/api`.
    //
    // This list must match `SERVER_PATH_PREFIXES` in @syntra/contracts, which
    // is what the production fallback uses to decide the same question — and
    // `server-prefixes.test.ts` fails if the two ever disagree. It cannot be
    // imported from there: Vite loads this file through Node's own ESM
    // resolver, which will not follow the package's `.js` specifiers to their
    // `.ts` sources.
    //
    // A prefix missing from this side is served the single-page application
    // instead, and since the router owns none of these paths its catch-all
    // quietly redirects to the portal — which is what happened to every
    // protocol endpoint once: a SAML tile opened `/saml/start/:id`, the
    // browser landed on `/`, and no error appeared anywhere.
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
