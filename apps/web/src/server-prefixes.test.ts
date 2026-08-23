import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERVER_PATH_PREFIXES } from '@syntra/contracts';

/**
 * The development proxy and the production fallback answer the same question —
 * "is this path the server's, or the application's?" — from two lists, and the
 * lists have to be the same list.
 *
 * They cannot be ONE list in code. Vite loads `vite.config.ts` through Node's
 * own ESM resolver, which will not follow `@syntra/contracts`' `.js`
 * specifiers to their `.ts` sources, so importing the shared constant there
 * fails before the config is even parsed. This test is the next best thing:
 * the copy stays, and adding a prefix to one side without the other turns the
 * suite red rather than shipping.
 *
 * The failure it guards against has happened. `/saml`, `/oidc` and
 * `/federation` were missing from the proxy, so a SAML tile opened
 * `/saml/start/:id`, Vite served the application, the router owned no such
 * path and its catch-all redirected to `/` — no error anywhere, and the tile
 * simply appeared to do nothing.
 *
 * The import below is deliberately a RUNTIME specifier rather than a static
 * one. `vite.config.ts` sits outside this project's `rootDir`, and a static
 * import of it fails `tsc -b` with TS6059 — the config is not part of the
 * application's compiled sources and should not become part of them just so a
 * test can read it.
 */
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../vite.config.ts');

interface ProxyEntry {
  changeOrigin?: boolean;
}
let proxy: Record<string, ProxyEntry>;

beforeAll(async () => {
  const loaded = (await import(pathToFileURL(configPath).href)) as {
    default: { server?: { proxy?: Record<string, ProxyEntry> } };
  };
  proxy = loaded.default.server?.proxy ?? {};
});

describe('the paths the server owns', () => {
  it('are the same on both sides', () => {
    expect(Object.keys(proxy).sort()).toEqual([...SERVER_PATH_PREFIXES].sort());
  });

  it('are proxied without rewriting the Host header', () => {
    // Syntra picks the tenant from `Host`. Vite's string-shorthand proxy
    // rewrites it to the target, which makes every development request look
    // like an unknown tenant — a 404 on every screen at once.
    for (const [prefix, options] of Object.entries(proxy)) {
      expect(options.changeOrigin, prefix).toBe(false);
    }
  });
});
