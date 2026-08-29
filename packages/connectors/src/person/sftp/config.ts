import { z } from 'zod';

/**
 * A delimited export fetched over SFTP.
 *
 * `hostKeyFingerprint` is optional in the schema and mandatory at run time: a
 * source is saved before it has one -- `test` is how a fingerprint is obtained
 * -- but `read` refuses without it. Making it required here would mean the
 * only way to create a source is to already know the answer to the question
 * `test` exists to ask.
 */
export const sftpDelimitedConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    /** A path, or a glob that must resolve to exactly one file. */
    remotePath: z.string().min(1),
    delimiter: z.string().min(1).max(1).default(','),
    quoteChar: z.string().min(1).max(1).default('"'),
    encoding: z.enum(['utf8', 'latin1']).default('utf8'),
    hasHeaderRow: z.boolean().default(true),
    hostKeyFingerprint: z.string().optional(),
    maxBytes: z.number().int().positive().default(52_428_800),
    maxRows: z.number().int().positive().default(200_000),
  })
  .strict();

export type SftpDelimitedConfig = z.infer<typeof sftpDelimitedConfigSchema>;

/** Read from the vault, never stored in `config`. */
export type SftpDelimitedCredential =
  | { privateKey: string; passphrase?: string }
  | { password: string };
