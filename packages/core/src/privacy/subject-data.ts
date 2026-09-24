import type { TenantClient } from '@syntra/db';
import {
  INVENTORY_PROFILES,
  projectForBundle,
  subjectLinkedTables,
  type LinkKind,
  type SubjectLinks,
  type TableEntry,
} from './inventory.js';

/**
 * Finding everything linked to one person, from the data inventory.
 *
 * The search does not have its own list of tables. It reads every table whose
 * inventory entry declares `links`, through the columns named there, so a
 * table classified as linked to people is searched without anybody editing
 * this file -- and a table that is not searched is visibly one the inventory
 * says is not linked.
 */

export interface SubjectIds {
  personId: string;
  userIds: string[];
  accountIds: string[];
  contractIds: string[];
  operationIds: string[];
  stepIds: string[];
  /** Email addresses and logins, for tables that record one instead of an id. */
  identifiers: string[];
}

/** Every id the person is known by, or null when there is no such person. */
export async function resolveSubjectIds(tx: TenantClient, personId: string): Promise<SubjectIds | null> {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { id: true, businessEmail: true, personalEmail: true },
  });
  if (person === null) return null;
  const [users, accounts, contracts, operations] = await Promise.all([
    tx.user.findMany({ where: { personId }, select: { id: true, login: true, email: true }, orderBy: { id: 'asc' } }),
    tx.targetAccount.findMany({ where: { personId }, select: { id: true }, orderBy: { id: 'asc' } }),
    tx.contract.findMany({ where: { personId }, select: { id: true }, orderBy: { id: 'asc' } }),
    tx.lifecycleOperation.findMany({ where: { personId }, select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  const operationIds = operations.map((o) => o.id);
  const steps = operationIds.length === 0
    ? []
    : await tx.lifecycleStep.findMany({ where: { operationId: { in: operationIds } }, select: { id: true } });
  const identifiers = new Set<string>();
  for (const value of [person.businessEmail, person.personalEmail, ...users.flatMap((u) => [u.login, u.email])]) {
    if (value !== null && value.trim() !== '') identifiers.add(value);
  }
  return {
    personId,
    userIds: users.map((u) => u.id),
    accountIds: accounts.map((a) => a.id),
    contractIds: contracts.map((c) => c.id),
    operationIds,
    stepIds: steps.map((s) => s.id),
    identifiers: [...identifiers].sort(),
  };
}

function idsFor(kind: LinkKind, ids: SubjectIds): string[] {
  switch (kind) {
    case 'person':
      return [ids.personId];
    case 'user':
      return ids.userIds;
    case 'account':
      return ids.accountIds;
    case 'operation':
      return ids.operationIds;
    case 'step':
      return ids.stepIds;
    case 'any':
      return [ids.personId, ...ids.userIds, ...ids.accountIds, ...ids.contractIds];
    case 'identifier':
      return ids.identifiers;
  }
}

/**
 * The Prisma `where` that finds a table's rows for this subject, or null when
 * the subject has no id of any kind the table links through (a person with no
 * accounts has no rows in an account-linked table, and `in: []` would be a
 * query for nothing).
 */
export function subjectWhere(links: SubjectLinks, ids: SubjectIds): Record<string, unknown> | null {
  const clauses: Record<string, unknown>[] = [];
  for (const [kind, columns] of Object.entries(links) as [LinkKind, string[]][]) {
    const values = idsFor(kind, ids);
    if (values.length === 0) continue;
    for (const column of columns) clauses.push({ [column]: { in: values } });
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0]! : { OR: clauses };
}

interface Delegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

/** The Prisma delegate for a model name (`AuditEvent` -> `tx.auditEvent`). */
export function delegateFor(tx: TenantClient, model: string): Delegate {
  const key = `${model[0]!.toLowerCase()}${model.slice(1)}`;
  const delegate = (tx as unknown as Record<string, Delegate | undefined>)[key];
  if (delegate === undefined) throw new Error(`no Prisma delegate for ${model}`);
  return delegate;
}

export interface SubjectSection {
  table: string;
  area: string;
  erasure: TableEntry['erasure'];
  count: number;
  rows: Record<string, unknown>[];
  /** True when `rows` holds fewer than `count`. */
  truncated: boolean;
}

/**
 * Every linked table's rows for the subject, projected for a bundle (no
 * credential material). `limitPerTable` bounds the rows returned per table
 * for the console; the count is always the full count. Tables with no rows are
 * left out.
 */
export async function collectSubjectData(
  tx: TenantClient,
  ids: SubjectIds,
  options: { limitPerTable?: number } = {},
): Promise<SubjectSection[]> {
  const sections: SubjectSection[] = [];
  for (const entry of subjectLinkedTables().sort((a, b) => a.model.localeCompare(b.model))) {
    const where = subjectWhere(entry.links!, ids);
    if (where === null) continue;
    const delegate = delegateFor(tx, entry.model);
    const count = await delegate.count({ where });
    if (count === 0) continue;
    const orderBy = entry.model === 'AuditEvent' ? { sequence: 'asc' } : { id: 'asc' };
    const rows = await delegate.findMany({
      where,
      orderBy,
      ...(options.limitPerTable === undefined ? {} : { take: options.limitPerTable }),
    });
    sections.push({
      table: entry.model,
      area: INVENTORY_PROFILES[entry.profile].title,
      erasure: entry.erasure,
      count,
      rows: rows.map((row) => projectForBundle(entry.model, row)),
      truncated: rows.length < count,
    });
  }
  return sections;
}

/** Rows per linked table, without reading them. */
export async function countSubjectData(tx: TenantClient, ids: SubjectIds): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of subjectLinkedTables()) {
    const where = subjectWhere(entry.links!, ids);
    if (where === null) continue;
    const count = await delegateFor(tx, entry.model).count({ where });
    if (count > 0) counts[entry.model] = count;
  }
  return counts;
}

/** JSON.stringify replacer for database rows: bigint as text, bytes never. */
export function rowReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return undefined;
  return value;
}
