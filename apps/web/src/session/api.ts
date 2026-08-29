export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path?: string; line?: number; message: string }[];
  /**
   * RFC 9457 extension members. Several refusals carry the numbers behind the
   * decision — the accounts a source owns, the passkeys a domain change would
   * invalidate — because "confirm this" without the figure is not a question
   * anybody can answer. Typed loosely because the members differ per problem;
   * each caller reads the one its own endpoint documents.
   */
  [extension: string]: unknown;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title || `Request failed (${problem.status})`);
    this.name = 'ApiError';
  }

  /** The stable slug from the problem type URI, e.g. 'invalid-credentials'. */
  get kind(): string {
    return this.problem.type?.split('/').pop() ?? 'unknown';
  }
}

/**
 * Whether a failure was the rate limiter, not the credential itself.
 *
 * Five pre-authentication screens catch this the same way and used to say so
 * with five copies of the same English sentence, hardcoded rather than
 * catalogued. One check here, one catalog key (`common.rate_limited`) at each
 * call site.
 */
export function isRateLimited(cause: unknown): boolean {
  return cause instanceof ApiError && cause.problem.status === 429;
}

/**
 * The paths where a 401 means "that credential was wrong", not "your session
 * is gone".
 *
 * Every credential-presenting endpoint lives under `/api/auth/`: login,
 * elevate, the MFA verify and challenge pair, enrolment, and the reset flow.
 * `/api/auth/elevate` answers 401 for a mistyped password while the caller
 * holds a perfectly good portal session, and `/api/auth/session` answers 401
 * on every cold load before anybody has signed in. Treating either as expiry
 * would sign people out for typing badly, or bounce a first-time visitor off a
 * page they had never reached.
 *
 * Everything else -- `/api/admin/*`, `/api/portal/*` -- is behind
 * `requireSession`, where a 401 has exactly one meaning.
 */
const CREDENTIAL_PATHS = '/api/auth/';

let expiredHandler: (() => void) | null = null;

/**
 * Registers what happens when a live session stops being one.
 *
 * A registry rather than a direct import of the session store, because `api()`
 * is not a React module and must not become one. `SessionProvider` registers a
 * handler that clears the session; the router's `RequireSession` then does the
 * navigating, which keeps "where does an unauthenticated browser go" in the
 * one place that already answers it.
 *
 * Returns an unsubscribe, so a test can put it back.
 */
export function onSessionExpired(handler: () => void): () => void {
  expiredHandler = handler;
  return () => {
    if (expiredHandler === handler) expiredHandler = null;
  };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only declare a JSON body when there is one. Sending
  // `content-type: application/json` with an empty body is rejected outright
  // by the server, which silently broke sign-out: the request never arrived
  // and the session stayed alive while the interface looked like it worked.
  const headers: HeadersInit = {
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.headers ?? {}),
  };

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    let problem: Problem = {
      type: 'about:blank',
      title: 'Request failed',
      status: response.status,
    };
    try {
      problem = { ...problem, ...(await response.json()) };
    } catch {
      // A non-JSON error body is still an error; the fallback stands.
    }
    // A 401 from anything but a credential-presenting endpoint means the
    // session is gone. Nothing handled this: `GENERIC` mapped 403 and 404, and
    // an expired admin session -- the deliberately short one, fifteen minutes
    // idle -- turned every panel in the console into "Something went wrong"
    // with no route back but typing a URL.
    if (response.status === 401 && !path.startsWith(CREDENTIAL_PATHS)) {
      expiredHandler?.();
    }
    throw new ApiError(problem);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
