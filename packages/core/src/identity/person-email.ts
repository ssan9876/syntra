import type { TenantClient } from '@syntra/db';

/**
 * One address per person, and their logins use it.
 *
 * A person's business email is unique per tenant, case-insensitively, and
 * every login linked to that person carries it as its own email. A login with
 * no person (a service account, the bootstrap admin) keeps its own address.
 *
 * Backed by `Person_tenantId_lower_businessEmail_key` in migration
 * `20261110000000_person_email_unique`; these checks run first so the caller
 * gets a named refusal rather than a driver error.
 */

/** What already holds an address: a person, or a login of nobody's. */
export interface EmailHolder {
  kind: 'person' | 'user';
  id: string;
  /** The person's full name, or the login. */
  name: string;
}

export class EmailInUseError extends Error {
  constructor(
    /** The request field the address came in on. */
    readonly field: string,
    readonly email: string,
    readonly holder: EmailHolder,
  ) {
    super(
      holder.kind === 'person'
        ? `${holder.name} already has ${email}.`
        : `Account ${holder.name} already has ${email}.`,
    );
    this.name = 'EmailInUseError';
  }
}

const blank = (value: string | null | undefined): value is null | undefined | '' =>
  value === null || value === undefined || value.trim() === '';

// Compared again in code: an insensitive `equals` is ILIKE underneath, where
// `_` in an address is a wildcard.
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The other person whose business email this is, of any status. */
export async function personHoldingEmail(
  tx: TenantClient,
  email: string | null | undefined,
  exceptPersonId?: string | null,
): Promise<EmailHolder | null> {
  if (blank(email)) return null;
  const rows = await tx.person.findMany({
    where: {
      businessEmail: { equals: email.trim(), mode: 'insensitive' },
      ...(exceptPersonId ? { id: { not: exceptPersonId } } : {}),
    },
    select: { id: true, givenName: true, familyName: true, businessEmail: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  const row = rows.find((p) => p.businessEmail !== null && same(p.businessEmail, email));
  return row ? { kind: 'person', id: row.id, name: `${row.givenName} ${row.familyName}` } : null;
}

/**
 * Another usable login on this address: active and locally managed, the scope
 * of `User_tenantId_lower_email_local_key`. Logins of `exceptPersonId` share
 * that person's address and are not a collision.
 */
export async function userHoldingEmail(
  tx: TenantClient,
  email: string | null | undefined,
  opts: { exceptUserId?: string | null; exceptPersonId?: string | null } = {},
): Promise<EmailHolder | null> {
  if (blank(email)) return null;
  const rows = await tx.user.findMany({
    where: {
      email: { equals: email.trim(), mode: 'insensitive' },
      sourceId: null,
      status: 'active',
      ...(opts.exceptUserId ? { id: { not: opts.exceptUserId } } : {}),
    },
    select: { id: true, login: true, email: true, personId: true },
    take: 10,
  });
  const row = rows.find(
    (u) =>
      same(u.email, email) &&
      (opts.exceptPersonId === undefined ||
        opts.exceptPersonId === null ||
        u.personId !== opts.exceptPersonId),
  );
  return row ? { kind: 'user', id: row.id, name: row.login } : null;
}

/** Throws `EmailInUseError` when another person has this business email. */
export async function assertPersonEmailFree(
  tx: TenantClient,
  email: string | null | undefined,
  opts: { exceptPersonId?: string | null; field?: string } = {},
): Promise<void> {
  const holder = await personHoldingEmail(tx, email, opts.exceptPersonId);
  if (holder) throw new EmailInUseError(opts.field ?? 'businessEmail', email!.trim(), holder);
}

/**
 * The address a login linked to this person must carry, or null when the
 * person has none (or there is no person) and the login keeps its own.
 */
export async function personOwnedEmail(
  tx: TenantClient,
  personId: string | null | undefined,
): Promise<string | null> {
  if (!personId) return null;
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { businessEmail: true },
  });
  return blank(person?.businessEmail) ? null : person!.businessEmail!;
}

/**
 * Sets every login linked to this person to the person's business email.
 * Returns how many changed. Refuses, changing nothing, when another usable
 * login already has that address.
 */
export async function followPersonEmail(
  tx: TenantClient,
  personId: string,
  field = 'businessEmail',
): Promise<number> {
  const email = await personOwnedEmail(tx, personId);
  if (email === null) return 0;
  const linked = await tx.user.findMany({
    where: { personId },
    select: { id: true, email: true },
  });
  const stale = linked.filter((u) => u.email !== email);
  if (stale.length === 0) return 0;
  const holder = await userHoldingEmail(tx, email, { exceptPersonId: personId });
  if (holder) throw new EmailInUseError(field, email, holder);
  await tx.user.updateMany({
    where: { id: { in: stale.map((u) => u.id) } },
    data: { email },
  });
  return stale.length;
}
