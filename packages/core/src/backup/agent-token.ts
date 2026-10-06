import { createHmac } from 'node:crypto';

/**
 * The token the API and the backup agent share.
 *
 * BACKUP_AGENT_TOKEN when set; otherwise an HMAC of SESSION_SECRET, which both
 * processes already have. Nothing new to put in `.env`, and nobody without
 * SESSION_SECRET can compute it.
 */
export function backupAgentToken(env: { BACKUP_AGENT_TOKEN?: string | undefined; SESSION_SECRET?: string | undefined }): string | null {
  const explicit = env.BACKUP_AGENT_TOKEN?.trim();
  if (explicit) return explicit;
  const secret = env.SESSION_SECRET?.trim();
  return secret ? createHmac('sha256', secret).update('syntra-backup-agent-v1').digest('hex') : null;
}
