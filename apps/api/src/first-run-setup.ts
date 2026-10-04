import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '@syntra/db';

/** How long a setup link works after the API prints it. */
export const SETUP_TOKEN_TTL_MS = 60 * 60_000;

export type SetupTokenCheck = 'ok' | 'invalid' | 'expired';

export interface SetupLink {
  token: string;
  expiresAt: Date;
}

/**
 * The one-time link that lets a browser create the first tenant.
 *
 * HELD IN MEMORY, and only as a hash. The link is printed once, at startup,
 * by the process that holds it; a restart prints a new one and the old one is
 * gone with the process. That is the whole lifecycle, so a table would add a
 * migration, a privacy-inventory row and a cleanup job for nothing. With more
 * than one replica each prints its own link, and a link works on the replica
 * that printed it.
 *
 * CLOSED FOR GOOD once any tenant exists. The answer is cached the first time
 * a tenant is seen, so a configured install pays one query per process, and
 * nothing short of a restart against an empty database opens it again.
 */
export interface FirstRunSetup {
  /**
   * Generates the link when no tenant exists. Null when one does. Called
   * once at startup; calling it again replaces the link.
   */
  open(): Promise<SetupLink | null>;
  /** True while no tenant exists. */
  pending(): Promise<boolean>;
  /** Whether `token` is the current link, and still in date. */
  check(token: string | undefined): SetupTokenCheck;
  /** When the current link stops working. Null when there is none. */
  expiresAt(): Date | null;
  /**
   * Runs `create` once, holding the link while it runs. The link is spent
   * when `create` resolves and kept when it throws, so a failed attempt can
   * be sent again. A second call while the first is running answers `busy`
   * rather than racing it.
   */
  complete<T>(token: string, create: () => Promise<T>): Promise<
    { status: 'done'; value: T } | { status: SetupTokenCheck | 'busy' | 'closed' }
  >;
}

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export function createFirstRunSetup(options: { now?: () => Date } = {}): FirstRunSetup {
  const now = options.now ?? (() => new Date());
  let link: { hash: Buffer; expiresAt: Date } | null = null;
  let closed = false;
  let busy = false;

  async function pending(): Promise<boolean> {
    if (closed) return false;
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (tenant) {
      closed = true;
      link = null;
    }
    return !closed;
  }

  function check(token: string | undefined): SetupTokenCheck {
    if (!link || !token) return 'invalid';
    if (!timingSafeEqual(digest(token), link.hash)) return 'invalid';
    return now() < link.expiresAt ? 'ok' : 'expired';
  }

  return {
    async open() {
      if (!(await pending())) return null;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now().getTime() + SETUP_TOKEN_TTL_MS);
      link = { hash: digest(token), expiresAt };
      return { token, expiresAt };
    },

    pending,
    check,
    expiresAt: () => link?.expiresAt ?? null,

    async complete(token, create) {
      if (!(await pending())) return { status: 'closed' };
      const checked = check(token);
      if (checked !== 'ok') return { status: checked };
      if (busy) return { status: 'busy' };
      busy = true;
      try {
        const value = await create();
        link = null;
        closed = true;
        return { status: 'done', value };
      } finally {
        busy = false;
      }
    },
  };
}
