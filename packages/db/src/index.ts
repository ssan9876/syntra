export { prisma } from './client.js';
export { withTenant } from './with-tenant.js';
export type { TenantClient } from './with-tenant.js';

/**
 * Prisma's namespace, re-exported.
 *
 * `Prisma.DbNull` is the only way to CLEAR a nullable `Json` column: Prisma
 * reads `undefined` as "do not touch this column", so `x ?? undefined` on an
 * update path makes clearing impossible while looking like it works. Two
 * columns in Automate are security controls whose NULL means "nobody"
 * (`Product.audienceCondition`, `ResourceDelegation.audienceCondition`), so
 * this is reachable from `packages/core` rather than optional.
 *
 * Re-exported HERE rather than adding `@prisma/client` to `packages/core`'s
 * dependencies, deliberately. Under pnpm's strict layout core cannot resolve
 * the package it does not declare, and that is doing real work: it is what
 * makes `new PrismaClient()` in a service unresolvable, so every database
 * access in core has to come through `withTenant` and its forced RLS. Handing
 * core the namespace it needs without handing it the constructor keeps that
 * property. Note `PrismaClient` itself is deliberately NOT re-exported.
 */
export { Prisma } from '@prisma/client';

/**
 * The generated row types, for services that return rows to their callers.
 * Types only — none of these is a value, so none of them opens a second path
 * to the database.
 */
export type {
  AccessGrant,
  AccessRequest,
  ApprovalDecision,
  ApprovalDelegation,
  ApprovalStage,
  ApprovalStep,
  ApprovalStepApprover,
  AutomateSettings,
  ExpirySweep,
  NotificationOutbox,
  NotificationPreference,
  Product,
  ProductGrant,
  RequestItem,
  ResourceDelegation,
  ResourceOwner,
  SweepAction,
  SweepException,
} from '@prisma/client';
