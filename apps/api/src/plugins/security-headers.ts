import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The response headers that bound what a browser will do with what we send.
 *
 * Written here rather than pulled in with a helmet-style package, for one
 * reason that matters more than the line count: the interesting decision in
 * this application is not WHICH headers to send but WHERE NOT to send them,
 * and a package's defaults are the wrong shape for that. Syntra emits
 * self-posting HTML on the federation paths -- a SAML Response, a WS-Fed
 * token, an OIDC front-channel logout -- and those pages carry an inline
 * `onload` handler and post their form to a service provider on another
 * origin. A blanket `script-src 'self'; form-action 'self'` would leave
 * single sign-on failing in a way nobody could read from a stack trace,
 * because a blocked form submission looks like a blank page.
 *
 * So the CSP is scoped to what it can actually protect: the console and the
 * portal, which are the pages that render tenant-supplied branding and hold
 * the session. The protocol paths keep the transport-level headers below and
 * are exempted from framing and CSP.
 */

/**
 * Paths that answer with a self-posting form to another origin.
 *
 * Kept as prefixes rather than exact routes because these trees each have
 * several endpoints (SSO, SLO, both bindings) and a new one arriving in the
 * tree should inherit the exemption rather than silently break.
 */
const AUTO_POST_PREFIXES = ['/saml/', '/oidc/', '/federation/', '/wsfed/'];

const isAutoPostPath = (url: string): boolean => {
  const pathname = url.split('?')[0] ?? '';
  return AUTO_POST_PREFIXES.some((prefix) => pathname.startsWith(prefix));
};

/**
 * What the console and portal may load.
 *
 * `style-src` allows inline styles because the application sets them from
 * JavaScript; `script-src` does NOT, which is the clause that does the work --
 * an injection that lands in tenant branding cannot execute. `connect-src`
 * stays same-origin: this deployment is one origin by design, and a page that
 * cannot phone home cannot exfiltrate a session. `frame-ancestors 'none'` is
 * the clickjacking control, and it is why `X-Frame-Options` below is only a
 * fallback for browsers that predate it.
 */
const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export interface SecurityHeaderOptions {
  /**
   * Whether this deployment is reached over HTTPS, which is the same question
   * `cookieSecure` answers -- so it is derived from the same place rather than
   * asked again. HSTS on a plain-HTTP development server would pin a browser
   * to a scheme that server does not speak, and the pin outlives the mistake.
   */
  https: boolean;
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions,
): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    // Everywhere, including JSON and the protocol paths: neither of these
    // constrains what a page may do, they only stop a browser from taking a
    // response for something it is not, and from carrying a full URL -- which
    // for this product means a SAML RelayState or an authorization code -- to
    // another origin in a Referer header.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');

    if (options.https) {
      // Two years, no preload directive. Preloading is a decision for whoever
      // owns the domain and is close to irreversible, so it is not something
      // this application should assert on their behalf.
      reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    }

    if (!isAutoPostPath(request.url)) {
      reply.header('content-security-policy', CONSOLE_CSP);
      // The pre-CSP spelling of `frame-ancestors`, for browsers that do not
      // implement the directive. Both, deliberately: a browser that honours
      // the CSP ignores this one.
      reply.header('x-frame-options', 'DENY');
    }

    return payload;
  });
}
