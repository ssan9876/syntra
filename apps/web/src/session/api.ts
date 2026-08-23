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
    throw new ApiError(problem);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
