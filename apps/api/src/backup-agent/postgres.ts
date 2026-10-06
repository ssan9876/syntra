import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * The PostgreSQL client tools, run either here or inside the database's own
 * container.
 *
 * Here is the container image and Kubernetes: `pg_dump`, `pg_restore` and
 * `psql` are installed beside the agent. Inside the container
 * (`BACKUP_PG_CONTAINER`) is the release layout, where the host has Docker but
 * no client tools, and `ops/syntra-backup` already works the same way.
 *
 * The connection is passed in PG* variables, never on the command line: a
 * password in argv is readable by anybody who can list processes.
 */
export interface PgTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function pgTargetFrom(url: string): PgTarget {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

export interface PgTools {
  /** `pg_dump -Fc` of the whole database into `file`. */
  dump(file: string): Promise<void>;
  /** How many TABLE DATA sections the archive lists: zero means a backup of nothing. */
  tableDataSections(file: string): Promise<number>;
  /** `pg_restore --clean --if-exists` from `file`. Its exit status is not the test; what arrived is. */
  restore(file: string): Promise<void>;
  /** Runs SQL through `psql -v ON_ERROR_STOP=1 -tA`, with psql variables. Returns stdout. */
  sql(statements: string, variables?: Record<string, string>): Promise<string>;
}

export class PgToolError extends Error {
  constructor(readonly tool: string, readonly code: number | null, readonly stderr: string) {
    super(`${tool} exited ${code ?? 'abnormally'}${stderr ? `: ${lastLine(stderr)}` : ''}`);
    this.name = 'PgToolError';
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 300);
}

interface Run {
  args: string[];
  stdinFile?: string;
  stdinText?: string;
  stdoutFile?: string;
  /** pg_restore reports benign ownership notices as errors; the caller checks the result instead. */
  ignoreStatus?: boolean;
}

export function pgTools(target: PgTarget, options: { container?: string | null } = {}): PgTools {
  const container = options.container ?? null;
  const env = {
    PGHOST: target.host,
    PGPORT: target.port,
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGDATABASE: target.database,
  };

  async function run(tool: string, run: Run): Promise<string> {
    // Inside the container the server is local to it: the tool connects over
    // the container's own socket as the role, as ops/syntra-backup does.
    const [command, args] = container
      ? ['docker', ['exec', '-i', container, tool, '-U', target.user, ...run.args]]
      : [tool, run.args];
    const child = spawn(command, args, {
      env: container ? process.env : { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    // A child that exits early closes stdin under the writer; the exit status
    // and stderr say why, so the pipe error itself is not the story.
    child.stdin.on('error', () => undefined);

    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    const written = run.stdoutFile
      ? pipeline(child.stdout, createWriteStream(run.stdoutFile, { flags: 'r+' }))
      : (child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        }),
        Promise.resolve());
    if (run.stdinFile) {
      pipeline(createReadStream(run.stdinFile), child.stdin).catch(() => undefined);
    } else {
      child.stdin.end(run.stdinText ?? '');
    }

    let code: number | null;
    try {
      [code] = await Promise.all([exited, written]);
    } catch (err) {
      throw new PgToolError(tool, null, err instanceof Error ? err.message : String(err));
    }
    if (code !== 0 && !run.ignoreStatus) throw new PgToolError(tool, code, stderr);
    return stdout;
  }

  return {
    async dump(file) {
      await run('pg_dump', { args: ['-Fc', '-d', target.database], stdoutFile: file });
    },
    async tableDataSections(file) {
      const listing = await run('pg_restore', { args: ['-l'], stdinFile: file });
      return listing.split('\n').filter((line) => line.includes('TABLE DATA')).length;
    },
    async restore(file) {
      await run('pg_restore', { args: ['--clean', '--if-exists', '-d', target.database], stdinFile: file, ignoreStatus: true });
    },
    async sql(statements, variables = {}) {
      const vars = Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]);
      return run('psql', { args: ['-d', target.database, '-v', 'ON_ERROR_STOP=1', '-tA', '-q', ...vars], stdinText: statements });
    },
  };
}
