import { downloadRequest, restoreRequest } from './backups.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `backups.ts`. They act on the
 * DEPLOYMENT: a backup holds every tenant, and a restore replaces every tenant.
 */
export const backupsOpenApi = describeAdminRoutes('Backups', {
  'GET /backups': {
    summary: 'List restore points and the backup service status',
    description:
      '`configured` is false when BACKUP_AGENT_URL is not set. Each backup carries `key` (`match`, `mismatch`, `unknown`) against the running master key and `versionCheck` (`ok`, `newer`, `unknown`).',
  },
  'POST /backups': {
    summary: 'Take a backup now',
    description: 'Accepted, not finished; poll `GET /api/admin/backups/jobs/{id}`. `409 backup-busy` while another backup or restore runs.',
    status: 202,
  },
  'GET /backups/jobs/:id': { summary: 'Read a backup or restore job' },
  'DELETE /backups/:name': { summary: 'Delete a backup', status: 204 },
  'POST /backups/:name/download': {
    summary: 'Download a backup, encrypted under a passphrase',
    description:
      'The body is the backup file: the manifest and the `pg_dump` archive, encrypted with AES-256-GCM under a key derived from the passphrase with scrypt. The same passphrase is needed to upload it. Recorded as `deployment.backup_downloaded`.',
    body: downloadRequest,
  },
  'POST /backups/upload': {
    summary: 'Upload a backup file',
    description:
      'Send the file as `application/octet-stream` with the passphrase in `X-Backup-Passphrase`. Stored as an uploaded restore point; `422 backup-wrong-passphrase`, `backup-incomplete` or `backup-damaged` when it cannot be read.',
    status: 201,
  },
  'POST /backups/:name/restore': {
    summary: 'Restore a backup over the whole installation',
    description:
      'Accepted, not finished. A backup of the current state is taken first; the API restarts twice and comes back held until somebody resumes it. `422 key-mismatch` for a backup taken under a different master key, `422 backup-newer` for one from a newer release.',
    body: restoreRequest,
    status: 202,
  },
});
