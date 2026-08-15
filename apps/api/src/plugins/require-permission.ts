import type { FastifyRequest } from 'fastify';
import { hasPermission, type Permission } from '@syntra/core';
import { ProblemError } from './problem-json.js';

/**
 * Requires a permission. Runs after requireSession('admin'), which is what
 * establishes request.session.
 *
 * Authorization is decided here and only here. The web application hides
 * navigation the caller cannot use, but hiding a link is presentation, not a
 * control — this is the control.
 */
export function requirePermission(permission: Permission) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const allowed = await request.db((tx) =>
      hasPermission(tx, request.session.userId, permission),
    );
    if (!allowed) {
      throw new ProblemError(
        403,
        'forbidden',
        'Forbidden',
        `Requires ${permission}`,
      );
    }
  };
}
