import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { BACKUP_NAME, backupManifest } from '@syntra/core';
import { AgentBusyError, type Agent } from './agent.js';
import { BackupRefusedError, type BackupStore } from './store.js';

/**
 * The agent's API, for the Syntra API only. Never published: Compose keeps it
 * on the internal network, a host install binds it to loopback, and the Helm
 * chart puts a NetworkPolicy in front of it. Every request carries the shared
 * token as a bearer; there is no anonymous route.
 *
 *   GET    /v1/status
 *   GET    /v1/backups
 *   POST   /v1/backups                  { requestedBy }        -> 202 job
 *   DELETE /v1/backups/:name
 *   GET    /v1/backups/:name/dump       the pg_dump archive
 *   POST   /v1/uploads                  x-syntra-manifest: base64 JSON; body: the dump
 *   POST   /v1/restores                 { name, requestedBy }  -> 202 job
 *   POST   /v1/verifies                 { name?, requestedBy } -> 202 job
 *   POST   /v1/offsite/test             write and delete a test object
 *   GET    /v1/jobs/:id
 */
export function agentServer(agent: Agent, store: BackupStore, token: string): Server {
  const expected = Buffer.from(token);

  const authorized = (request: IncomingMessage) => {
    const header = request.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const send = (response: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      response.writeHead(status).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 64 * 1024) throw new BackupRefusedError('Request body too large.');
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  };

  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://agent');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method ?? 'GET';
    const [version, collection, id, sub] = parts;
    if (version !== 'v1') return send(response, 404, { error: 'not-found' });

    if (collection === 'status' && method === 'GET' && !id) return send(response, 200, agent.status());

    if (collection === 'backups') {
      if (!id && method === 'GET') return send(response, 200, { backups: await store.list() });
      if (!id && method === 'POST') {
        const body = await readJson(request);
        return send(response, 202, { job: agent.backupNow(text(body['requestedBy'])) });
      }
      if (id && !BACKUP_NAME.test(id)) return send(response, 404, { error: 'not-found' });
      if (id && !sub && method === 'DELETE') {
        if (!(await store.get(id))) return send(response, 404, { error: 'not-found' });
        await agent.remove(id);
        return send(response, 204);
      }
      if (id && sub === 'dump' && method === 'GET') {
        if (!(await store.get(id))) return send(response, 404, { error: 'not-found' });
        const file = store.dumpPath(id);
        const { size } = await stat(file);
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(size),
          'cache-control': 'no-store',
        });
        await pipeline(createReadStream(file), response);
        return;
      }
    }

    if (collection === 'uploads' && method === 'POST' && !id) {
      const header = request.headers['x-syntra-manifest'];
      if (typeof header !== 'string') return send(response, 400, { error: 'invalid', message: 'Manifest missing.' });
      const manifest = backupManifest.safeParse(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
      if (!manifest.success) return send(response, 400, { error: 'invalid', message: 'Manifest is not valid.' });
      return send(response, 201, { backup: await agent.upload(manifest.data, request) });
    }

    if (collection === 'restores' && method === 'POST' && !id) {
      const body = await readJson(request);
      const name = text(body['name']);
      if (!name || !BACKUP_NAME.test(name)) return send(response, 400, { error: 'invalid', message: 'Backup name missing.' });
      if (!(await store.get(name))) return send(response, 404, { error: 'not-found' });
      return send(response, 202, { job: agent.restore(name, text(body['requestedBy'])) });
    }

    if (collection === 'verifies' && method === 'POST' && !id) {
      const body = await readJson(request);
      const name = text(body['name']);
      if (name !== null && (!BACKUP_NAME.test(name) || !(await store.get(name)))) {
        return send(response, 404, { error: 'not-found' });
      }
      return send(response, 202, { job: agent.verify(name, text(body['requestedBy'])) });
    }

    if (collection === 'offsite' && id === 'test' && method === 'POST') {
      await agent.testOffsite();
      return send(response, 200, { ok: true });
    }

    if (collection === 'jobs' && id && method === 'GET') {
      const job = agent.job(id);
      return job ? send(response, 200, { job }) : send(response, 404, { error: 'not-found' });
    }

    return send(response, 404, { error: 'not-found' });
  }

  return createServer((request, response) => {
    if (!authorized(request)) {
      request.resume();
      return send(response, 401, { error: 'unauthorized' });
    }
    route(request, response).catch((err: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (err instanceof AgentBusyError) return send(response, 409, { error: 'busy', message: err.message, job: err.job });
      if (err instanceof BackupRefusedError) return send(response, 422, { error: 'refused', message: err.message });
      if (err instanceof SyntaxError) return send(response, 400, { error: 'invalid', message: 'Body is not JSON.' });
      return send(response, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
    });
  });
}
