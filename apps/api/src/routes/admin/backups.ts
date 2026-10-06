import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  BACKUP_NAME,
  BackupArchiveError,
  MIN_PASSPHRASE_LENGTH,
  PERMISSIONS,
  backupManifest,
  createBackupDecryptor,
  createBackupEncryptor,
  keyVerdict,
  recordEvent,
  versionVerdict,
  buildInfo,
  type BackupManifest,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import {
  AgentError,
  AgentUnreachableError,
  backupAgentClient,
} from '../../backup-agent/client.js';
import type { StoredBackup } from '../../backup-agent/store.js';

export interface BackupRouteOptions {
  agent: { url: string; token: string } | null;
  /** The running key's fingerprint, as the agent records it in each manifest. */
  fingerprint: string | null;
}

export const nameParam = z.object({ name: z.string().regex(BACKUP_NAME) });
export const downloadRequest = z.object({ passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).max(1024) });
export const restoreRequest = z.object({
  /** The backup's name, typed again. A restore replaces every tenant's data. */
  confirm: z.string(),
});

/**
 * Backups and restores, from the console.
 *
 * `deployment.manage`, like updates: a backup holds every tenant and a restore
 * replaces every tenant. The work is done by the backup agent, which holds the
 * credential this process must not -- a role that bypasses row-level security
 * -- and the backup volume. This process only checks, records and relays.
 *
 * A download is encrypted here, under a passphrase the agent never sees; an
 * upload is decrypted here and handed to the agent as a plain dump.
 */
export async function registerAdminBackupRoutes(
  app: FastifyInstance,
  options: BackupRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  // On every route rather than as a hook, as in update.ts: the OpenAPI
  // document reads each operation's permission from its route-level guard.
  const guard = { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) };

  // The upload body is the encrypted file, streamed straight into the
  // decryptor: a backup can be gigabytes, and nothing here buffers it.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  const client = options.agent ? backupAgentClient(options.agent) : null;

  const agent = () => {
    if (!client) {
      throw new ProblemError(409, 'backups-not-configured', 'No backup service', 'BACKUP_AGENT_URL is not set.');
    }
    return client;
  };

  /** The agent's own refusal, passed on as it was said. */
  const relay = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof AgentUnreachableError) {
        throw new ProblemError(502, 'backup-service-unreachable', 'Backup service not answering', cause.message);
      }
      if (cause instanceof AgentError) {
        const status = cause.status === 404 ? 404 : cause.status === 409 ? 409 : 422;
        throw new ProblemError(status, `backup-${cause.kind}`, 'Backup service refused', cause.message);
      }
      throw cause;
    }
  };

  const running = buildInfo().version;
  const present = (backup: StoredBackup) => ({
    ...backup,
    key: keyVerdict(backup.masterKeyFingerprint, options.fingerprint),
    versionCheck: versionVerdict(backup.version, running),
  });

  const audit = (request: FastifyRequest, action: string, payload: Record<string, unknown>) =>
    request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action,
        targetType: 'Deployment',
        targetId: null,
        outcome: 'success',
        sourceIp: request.ip,
        payload,
      }),
    );

  const findBackup = async (name: string) => {
    const backup = (await relay(() => agent().list())).find((candidate) => candidate.name === name);
    if (!backup) throw new ProblemError(404, 'not-found', 'Backup not found', `No backup named ${name}.`);
    return backup;
  };

  app.get('/backups', guard, async () => {
    if (!client) return { configured: false, status: null, backups: [], version: running };
    const [status, backups] = await relay(() => Promise.all([client.status(), client.list()]));
    return { configured: true, status, backups: backups.map(present), version: running };
  });

  app.post('/backups', guard, async (request, reply) => {
    const job = await relay(() => agent().backupNow(request.session.userId));
    await audit(request, 'deployment.backup_requested', { jobId: job.id });
    return reply.status(202).send({ job });
  });

  app.get('/backups/jobs/:id', guard, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { job: await relay(() => agent().job(id)) };
  });

  app.delete('/backups/:name', guard, async (request, reply) => {
    const { name } = nameParam.parse(request.params);
    await relay(() => agent().remove(name));
    await audit(request, 'deployment.backup_deleted', { backupName: name });
    return reply.status(204).send();
  });

  app.post('/backups/:name/download', guard, async (request, reply) => {
    const { name } = nameParam.parse(request.params);
    const { passphrase } = downloadRequest.parse(request.body);
    const backup = await findBackup(name);
    const dump = await relay(() => agent().dump(name));
    const { name: _name, ...manifest } = backup;
    const encryptor = await createBackupEncryptor(passphrase, manifest);
    // Recorded before the first byte leaves: a copy of every tenant's data is
    // the event, whether or not the browser finishes saving it.
    await audit(request, 'deployment.backup_downloaded', { backupName: name, bytes: backup.bytes });
    void pipeline(dump, encryptor).catch((err: unknown) =>
      request.log.warn({ err, backupName: name }, 'backup download failed: stream ended early'),
    );
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}.syntra-backup"`)
      .header('cache-control', 'no-store')
      .send(encryptor);
  });

  app.post('/backups/upload', guard, async (request, reply) => {
    const passphrase = request.headers['x-backup-passphrase'];
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new ProblemError(400, 'passphrase-required', 'Passphrase required', `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    }
    if (!request.body || typeof (request.body as Readable).pipe !== 'function') {
      throw new ProblemError(400, 'file-required', 'File required', 'Send the backup file as application/octet-stream.');
    }
    const decryptor = createBackupDecryptor(passphrase);
    // Listened for before anything flows. A wrong passphrase fails on the
    // first frame, and an 'error' nobody is listening for ends the process.
    let decryptFailure: BackupArchiveError | null = null;
    decryptor.on('error', (err) => {
      if (err instanceof BackupArchiveError) decryptFailure = err;
    });
    const source = request.body as Readable;
    source.once('error', (err) => decryptor.destroy(err));
    source.pipe(decryptor);

    let manifest: BackupManifest;
    try {
      manifest = backupManifest.parse(await decryptor.manifest);
    } catch (cause) {
      source.resume();
      if (cause instanceof BackupArchiveError) throw new ProblemError(422, `backup-${cause.reason}`, 'Backup file refused', cause.message);
      throw new ProblemError(422, 'backup-damaged', 'Backup file refused', 'The backup file is damaged.');
    }

    let stored: StoredBackup;
    try {
      stored = await relay(() => agent().upload(manifest, decryptor));
    } catch (cause) {
      if (decryptFailure) {
        const failure = decryptFailure as BackupArchiveError;
        throw new ProblemError(422, `backup-${failure.reason}`, 'Backup file refused', failure.message);
      }
      throw cause;
    }
    await audit(request, 'deployment.backup_uploaded', { backupName: stored.name, takenAt: stored.createdAt });
    return reply.status(201).send({ backup: present(stored) });
  });

  app.post('/backups/:name/restore', guard, async (request, reply) => {
    const { name } = nameParam.parse(request.params);
    const { confirm } = restoreRequest.parse(request.body);
    if (confirm !== name) {
      throw new ProblemError(400, 'confirmation-mismatch', 'Name does not match', `Type ${name} to restore it.`);
    }
    const backup = present(await findBackup(name));
    if (backup.key === 'mismatch') {
      throw new ProblemError(
        422,
        'key-mismatch',
        'Different master key',
        `${name} was taken under a different master key. Its stored secrets would be unreadable.`,
      );
    }
    if (backup.versionCheck === 'newer') {
      throw new ProblemError(
        422,
        'backup-newer',
        'Backup is from a newer version',
        `${name} was taken on ${backup.version} and this install runs ${running}. Update first.`,
      );
    }
    // Recorded in the database about to be replaced. The safety backup the
    // agent takes first keeps it, and the restored database records the
    // resume.
    await audit(request, 'deployment.restore_requested', { backupName: name, takenAt: backup.createdAt });
    const job = await relay(() => agent().restore(name, request.session.userId));
    return reply.status(202).send({ job });
  });
}
