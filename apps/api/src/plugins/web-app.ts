import { readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isServerPath } from '@syntra/contracts';

/**
 * Serving the built single-page application from this process.
 *
 * `vite` is a DEVELOPMENT server: it compiles on demand, holds a hot-reload
 * socket open and serves the source tree. Nothing about it belongs in front of
 * real users, and until now that was the only way to reach a Syntra screen.
 * This is the other half — `vite build` output, served by the same process
 * that answers the API, on one origin and one port.
 *
 * One origin matters beyond tidiness. The session cookie, the WebAuthn
 * relying party and the tenant's own hostname all have to agree, and a
 * separate web origin means arranging that agreement in a proxy nobody has
 * written yet. Same origin makes it true by construction.
 */

/**
 * The directory Vite writes hashed bundles to. Two rules key off it: those
 * files may be cached forever, and a MISS under it is a 404 rather than the
 * application — see `notFound`.
 */
const ASSETS = 'assets';

/** What the browser is told about a file it may hold on to. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * And what it is told about the one it may not. `index.html` names the hashed
 * bundles by filename; a cached copy of it after a deploy points at files that
 * no longer exist, and the application fails to boot with no way for the
 * person looking at it to know why. `no-cache` is revalidate-every-time, not
 * "do not store" — the 304 is cheap and the staleness is not.
 */
const REVALIDATE = 'no-cache';

export interface WebApp {
  /**
   * Answers a request no route claimed. Serves the application for anything
   * the SERVER does not own, so a deep link typed into the address bar or
   * reloaded reaches the router instead of a 404.
   */
  notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply;
  /** The page shown when no tenant answers for the hostname in the request. */
  unknownHostPage(hostname: string): string;
}

/**
 * Reads and validates the build, then registers it.
 *
 * Both failures below are thrown at startup rather than tolerated, because
 * each produces a server that looks healthy and serves nothing: a wrong path
 * answers every page with 404, and a directory with no `index.html` does the
 * same while looking, from outside, exactly like a routing bug.
 */
export async function registerWebApp(
  app: FastifyInstance,
  root: string,
): Promise<WebApp> {
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new Error(
      `WEB_ROOT points at ${root}, which does not exist. Build the application first (pnpm build), or unset WEB_ROOT to serve the API alone.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`WEB_ROOT points at ${root}, which is not a directory.`);
  }

  const indexPath = join(root, 'index.html');
  let index: string;
  try {
    index = readFileSync(indexPath, 'utf8');
  } catch {
    throw new Error(
      `WEB_ROOT points at ${root}, which has no index.html. That is a directory, but it is not a built application — check that the build finished and that the path is the build output rather than its parent.`,
    );
  }

  await app.register(fastifyStatic, {
    root,
    // `/` resolves to the directory itself, and a static handler with no index
    // answers a directory with 403 — before the fallback below is ever
    // consulted. That is the product's front door returning "Forbidden" to
    // everyone, so this hands `/` to `index.html` here.
    //
    // Both paths to `index.html` — this one and the fallback — send the same
    // `cache-control`, from the same constant, for the same reason. Keeping
    // them in step matters more than the duplication costs: a cached
    // `index.html` after a deploy names bundles that no longer exist.
    index: ['index.html'],
    setHeaders(reply, path) {
      // Vite writes every hashed bundle under `assets/`. The hash IS the cache
      // key: a changed file is a changed name, so the old one can be kept for
      // as long as the browser likes. Anything else keeps its name across
      // builds and must be revalidated.
      const asset = path.startsWith(`${join(root, ASSETS)}${sep}`);
      reply.header('cache-control', asset ? IMMUTABLE : REVALIDATE);
    },
  });

  return {
    notFound(request, reply) {
      // A path the SERVER owns must keep answering as the server, whatever it
      // is. Falling back to the application here would answer a mistyped or
      // withdrawn endpoint with 200 and a page of HTML, and every client
      // parsing that as JSON would report a syntax error rather than a 404.
      // Same for a write: `POST /nope` is not a page request.
      const pathname = request.url.split('?')[0]!;
      // A miss under the build's own directory is a stale reference — a page
      // cached from before a deploy asking for a bundle that no longer exists.
      // Answering it with `index.html` would return 200 and a page of HTML
      // where a script was expected, and the browser would report a MIME type
      // error that says nothing about the real cause.
      if (
        isServerPath(pathname) ||
        pathname.startsWith(`/${ASSETS}/`) ||
        (request.method !== 'GET' && request.method !== 'HEAD')
      ) {
        return reply.status(404).type('application/problem+json').send({
          type: 'https://syntra.dev/problems/not-found',
          title: 'Not Found',
          status: 404,
        });
      }

      // 200, not 404. This is the router's own path — `/admin/users` is a real
      // screen that the server has no route for, because the routing happens
      // in the browser.
      return reply.status(200).type('text/html; charset=utf-8')
        .header('cache-control', REVALIDATE)
        .send(index);
    },

    unknownHostPage,
  };
}

/**
 * What a browser is shown when it arrives on a hostname no tenant claims.
 *
 * Without this the answer is `{"title":"Not Found"}` in the address bar, which
 * is true and useless. Pointing a DNS record at an instance is the ordinary
 * next step after standing one up, and the gap between the record resolving
 * and the hostname being listed is exactly when somebody sees this page.
 *
 * It names the hostname that was asked for and says where to add it. It does
 * NOT list the hostnames that would have worked: which tenants live on a
 * server is not something an unauthenticated request gets to enumerate.
 */
export function unknownHostPage(hostname: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No tenant for this address</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         font: 16px/1.6 system-ui, sans-serif; padding: 2rem; }
  main { max-width: 34rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <h1>No tenant answers for <code>${escapeHtml(hostname)}</code></h1>
  <p>Syntra picks the organization from the address you arrived on, and nothing
     here is registered under this one.</p>
  <p>If you have just pointed a DNS record at this server, add the hostname to
     the tenant first: <strong>Tenant settings &rarr; Address &rarr; Also
     answers on</strong>, one per line. Until then, reach the instance by an
     address it already answers on.</p>
</main>
</body>
</html>
`;
}

/**
 * The hostname is attacker-controlled — it is a request header — and it is
 * echoed back into a page. Unescaped, that is reflected script execution
 * against anyone who can be induced to follow a link.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
