/**
 * An in-memory Snipe-IT users API, answering the way Snipe-IT does: `200 OK`
 * for nearly everything, with `{"status":"error"}` in the body when a request
 * was refused.
 *
 * A pure request → response function rather than a listening server, so a
 * test can plug it into whatever transport double it already has (the HTTP
 * connector tests mock `guardedFetch`). Shapes follow the Snipe-IT API v1
 * reference: `GET /users` → `{ total, rows }`, `POST /users` →
 * `{ status, messages, payload }`, and `GET /users/{id}` → the user object.
 */
export interface FakeSnipeItRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeSnipeItResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeSnipeItUser {
  id: number;
  username: string;
  first_name: string;
  last_name: string | null;
  name: string;
  email: string | null;
  jobtitle: string | null;
  employee_num: string | null;
  activated: boolean;
}

const ok = (messages: string, payload: unknown): FakeSnipeItResponse => ({
  status: 200,
  body: { status: 'success', messages, payload },
});

const refused = (messages: unknown): FakeSnipeItResponse => ({
  status: 200,
  body: { status: 'error', messages, payload: null },
});

export class FakeSnipeIt {
  readonly users = new Map<number, FakeSnipeItUser>();
  readonly apiKey: string;
  /** Snipe-IT's `max_results`: a larger `limit` is silently reduced to it. */
  maxResults = 500;
  /** Requests that reached the fake, for assertions about what was sent. */
  readonly requests: FakeSnipeItRequest[] = [];
  private nextId = 1;

  constructor(apiKey = 'snipe-api-key') {
    this.apiKey = apiKey;
  }

  seed(user: Partial<FakeSnipeItUser> & { username: string }): FakeSnipeItUser {
    const id = this.nextId++;
    const first = user.first_name ?? user.username;
    const record: FakeSnipeItUser = {
      id,
      first_name: first,
      last_name: user.last_name ?? null,
      name: [first, user.last_name].filter(Boolean).join(' '),
      email: user.email ?? null,
      jobtitle: user.jobtitle ?? null,
      employee_num: user.employee_num ?? null,
      activated: user.activated ?? true,
      ...user,
    };
    this.users.set(id, record);
    return record;
  }

  handle(request: FakeSnipeItRequest): FakeSnipeItResponse {
    this.requests.push(request);
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      return { status: 401, body: { status: 'error', messages: 'Unauthenticated.' } };
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');

    if (request.method === 'GET' && path === '/users') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), this.maxResults);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const all = [...this.users.values()].sort((a, b) => a.id - b.id);
      return { status: 200, body: { total: all.length, rows: all.slice(offset, offset + limit) } };
    }

    if (request.method === 'POST' && path === '/users') {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const errors: Record<string, string[]> = {};
      const username = typeof body.username === 'string' ? body.username : '';
      if (username === '') errors.username = ['The username field is required.'];
      else if ([...this.users.values()].some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        errors.username = ['The username has already been taken.'];
      }
      if (typeof body.first_name !== 'string' || body.first_name === '') {
        errors.first_name = ['The first name field is required.'];
      }
      if (typeof body.password !== 'string' || body.password.length < 8) {
        errors.password = ['The password must be at least 8 characters.'];
      } else if (body.password !== body.password_confirmation) {
        errors.password = ['The password confirmation does not match.'];
      }
      if (Object.keys(errors).length > 0) return refused(errors);
      const user = this.seed({
        username,
        first_name: body.first_name as string,
        last_name: typeof body.last_name === 'string' ? body.last_name : null,
        email: typeof body.email === 'string' ? body.email : null,
        jobtitle: typeof body.jobtitle === 'string' ? body.jobtitle : null,
        employee_num: typeof body.employee_num === 'string' ? body.employee_num : null,
        activated: body.activated === true,
      });
      return ok('User created successfully.', user);
    }

    const one = /^\/users\/(\d+)$/.exec(path);
    if (one) {
      const user = this.users.get(Number(one[1]));
      if (!user) return refused('User not found');
      if (request.method === 'GET') return { status: 200, body: user };
      if (request.method === 'PATCH' || request.method === 'PUT') {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const renamed = body.username;
        if (typeof renamed === 'string') {
          const clash = [...this.users.values()].some(
            (u) => u.id !== user.id && u.username.toLowerCase() === renamed.toLowerCase(),
          );
          if (clash) return refused({ username: ['The username has already been taken.'] });
        }
        for (const key of ['username', 'first_name', 'last_name', 'email', 'jobtitle', 'activated'] as const) {
          if (key in body) (user as unknown as Record<string, unknown>)[key] = body[key];
        }
        user.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
        return ok('User updated successfully.', user);
      }
    }

    return { status: 404, body: { status: 'error', messages: 'Route not found' } };
  }
}
