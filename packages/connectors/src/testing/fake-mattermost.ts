/**
 * An in-memory Mattermost API v4 for users and team membership, answering the
 * way Mattermost does: arrays paged by `page` (from 0) and `per_page` (at most
 * 200) with no total, `400` with `{id, message, status_code}` for a refusal,
 * `delete_at` for deactivation, and bot accounts mixed into `GET /users`.
 *
 * A pure request → response function, like `FakeSnipeIt`, so a test plugs it
 * into its `guardedFetch` mock.
 */
export interface FakeMattermostRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeMattermostResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeMattermostUser {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  position: string;
  delete_at: number;
  is_bot: boolean;
  props: Record<string, string>;
  /** `''` for email and password; `saml`, `ldap`, `gitlab`… otherwise. */
  auth_service: string;
  auth_data: string;
}

export interface FakeMattermostTeam {
  id: string;
  name: string;
  display_name: string;
  description: string;
}

const MAX_PER_PAGE = 200;

const appError = (status: number, id: string, message: string): FakeMattermostResponse => ({
  status,
  body: { id, message, detailed_error: '', request_id: 'req', status_code: status },
});

const notFound = (what: string) =>
  appError(404, `app.${what}.get.app_error`, `Unable to find the ${what}.`);

export class FakeMattermost {
  readonly users = new Map<string, FakeMattermostUser>();
  readonly teams = new Map<string, FakeMattermostTeam>();
  /** team id → user ids */
  readonly members = new Map<string, Set<string>>();
  readonly requests: FakeMattermostRequest[] = [];
  readonly token: string;
  /** The next N requests are answered `429` with `Retry-After: 1`. */
  throttleNext = 0;
  private nextId = 1;

  constructor(token = 'mattermost-token') {
    this.token = token;
  }

  private id(): string {
    // Mattermost ids are 26 lowercase alphanumerics.
    return `id${String(this.nextId++).padStart(24, '0')}`;
  }

  seedUser(user: Partial<FakeMattermostUser> & { username: string }): FakeMattermostUser {
    const record: FakeMattermostUser = {
      id: this.id(),
      email: `${user.username}@example.test`,
      first_name: '',
      last_name: '',
      position: '',
      delete_at: 0,
      is_bot: false,
      props: {},
      auth_service: '',
      auth_data: '',
      ...user,
    };
    this.users.set(record.id, record);
    return record;
  }

  seedTeam(name: string, displayName = name): FakeMattermostTeam {
    const team = { id: this.id(), name, display_name: displayName, description: '' };
    this.teams.set(team.id, team);
    this.members.set(team.id, new Set());
    return team;
  }

  private page<T>(url: URL, all: T[]): FakeMattermostResponse {
    const page = Number(url.searchParams.get('page') ?? '0');
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? '60'), MAX_PER_PAGE);
    return { status: 200, body: all.slice(page * perPage, (page + 1) * perPage) };
  }

  private taken(field: 'username' | 'email', value: unknown, except?: string): boolean {
    if (typeof value !== 'string') return false;
    return [...this.users.values()].some(
      (u) => u.id !== except && u[field].toLowerCase() === value.toLowerCase(),
    );
  }

  handle(request: FakeMattermostRequest): FakeMattermostResponse {
    this.requests.push(request);
    if (this.throttleNext > 0) {
      this.throttleNext -= 1;
      return {
        ...appError(429, 'api.context.rate_limit', 'Too many requests.'),
        headers: { 'retry-after': '1' },
      };
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      return appError(401, 'api.context.session_expired.app_error', 'Invalid or expired session, please login again.');
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v4/, '');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { method } = request;

    if (method === 'GET' && path === '/users') {
      const all = [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username));
      return this.page(url, all);
    }

    if (method === 'POST' && path === '/users') {
      if (this.taken('username', body.username)) {
        return appError(400, 'app.user.save.username_exists.app_error', 'An account with that username already exists.');
      }
      if (this.taken('email', body.email)) {
        return appError(400, 'app.user.save.email_exists.app_error', 'An account with that email already exists.');
      }
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return appError(400, 'model.user.is_valid.pwd_length.app_error', 'Your password must contain at least 8 characters.');
      }
      if (typeof body.username !== 'string' || typeof body.email !== 'string') {
        return appError(400, 'model.user.is_valid.username.app_error', 'Invalid username.');
      }
      const user = this.seedUser({
        username: body.username,
        email: body.email,
        first_name: typeof body.first_name === 'string' ? body.first_name : '',
        last_name: typeof body.last_name === 'string' ? body.last_name : '',
        position: typeof body.position === 'string' ? body.position : '',
        props: (body.props ?? {}) as Record<string, string>,
      });
      return { status: 201, body: user };
    }

    const byName = /^\/users\/username\/([^/]+)$/.exec(path);
    if (method === 'GET' && byName) {
      const wanted = decodeURIComponent(byName[1] ?? '').toLowerCase();
      const user = [...this.users.values()].find((u) => u.username.toLowerCase() === wanted);
      return user ? { status: 200, body: user } : notFound('user');
    }

    const one = /^\/users\/([^/]+)(\/patch|\/active|\/auth)?$/.exec(path);
    if (one) {
      const user = this.users.get(one[1] ?? '');
      if (!user) return notFound('user');
      if (method === 'GET' && one[2] === undefined) return { status: 200, body: user };
      if (method === 'PUT' && one[2] === '/patch') {
        if (this.taken('username', body.username, user.id)) {
          return appError(400, 'app.user.save.username_exists.app_error', 'An account with that username already exists.');
        }
        for (const key of ['username', 'email', 'first_name', 'last_name', 'position'] as const) {
          if (typeof body[key] === 'string') user[key] = body[key];
        }
        return { status: 200, body: user };
      }
      if (method === 'PUT' && one[2] === '/auth') {
        if (typeof body.auth_service !== 'string' || typeof body.auth_data !== 'string') {
          return appError(400, 'api.context.invalid_body_param.app_error', 'Invalid or missing user_auth in request body.');
        }
        user.auth_service = body.auth_service;
        user.auth_data = body.auth_data;
        return { status: 200, body: { auth_service: user.auth_service, auth_data: user.auth_data } };
      }
      if (method === 'PUT' && one[2] === '/active') {
        user.delete_at = body.active === true ? 0 : 1_700_000_000_000;
        return { status: 200, body: { status: 'OK' } };
      }
    }

    if (method === 'GET' && path === '/teams') {
      return this.page(url, [...this.teams.values()]);
    }

    const team = /^\/teams\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
    if (team) {
      const members = this.members.get(team[1] ?? '');
      if (!members) return notFound('team');
      if (method === 'GET' && team[2] === undefined) {
        return this.page(
          url,
          [...members].map((userId) => ({ team_id: team[1], user_id: userId, roles: 'team_user', delete_at: 0 })),
        );
      }
      if (method === 'POST' && team[2] === undefined) {
        if (typeof body.user_id !== 'string' || !this.users.has(body.user_id)) return notFound('user');
        members.add(body.user_id);
        return { status: 201, body: { team_id: team[1], user_id: body.user_id, roles: 'team_user', delete_at: 0 } };
      }
      if (method === 'DELETE' && team[2] !== undefined) {
        members.delete(team[2]);
        return { status: 200, body: { status: 'OK' } };
      }
    }

    return appError(404, 'api.context.404.app_error', 'Sorry, we could not find the page.');
  }
}
