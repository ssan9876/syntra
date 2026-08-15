export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path?: string; line?: number; message: string }[];
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
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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
