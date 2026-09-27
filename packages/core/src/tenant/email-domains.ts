import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { entraUserPrincipalName } from '@syntra/connectors';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/**
 * EMAIL DOMAINS A TENANT HAS PROVED IT CONTROLS.
 *
 * Syntra writes addresses: a person's business email, an account name a
 * profile generates, a `mail` attribute, an Entra userPrincipalName. Without
 * this, any of them could name any domain -- an administrator typo, or a test
 * record, becomes an account in somebody else's namespace, and the target
 * refuses it or (worse) accepts it.
 *
 * A domain is added as a claim and becomes usable once its apex publishes a
 * TXT record `syntra-domain-verification=<token>`. The token is per tenant and
 * per domain, so publishing one tenant's record proves nothing for another.
 * A verified domain covers its subdomains: whoever runs `contoso.com` runs
 * `eu.contoso.com` too.
 *
 * Addresses a source brings in (LDAP, the HR feed, SCIM) are not refused on
 * the way in -- the source is authoritative for what it holds -- but nothing
 * is WRITTEN to a target in an unverified domain: provisioning makes that
 * person unprocessable for that target and says why.
 */

export const EMAIL_DOMAIN_TXT_PREFIX = 'syntra-domain-verification=';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The domain as stored and compared: lowercase ASCII (an internationalised
 * name becomes its punycode), no trailing dot, at least two labels, and not an
 * IP address. Null when the input is not a domain name.
 */
export function normalizeEmailDomain(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, '');
  if (trimmed === '' || trimmed.length > 253 || /[@/:\s]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (ascii === '' || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // A top-level label is never all digits; this is what refuses 10.0.0.1.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return ascii;
}

/** The normalised domain of an address, or null when it has none. */
export function emailDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return normalizeEmailDomain(address.slice(at + 1));
}

/** Whether `domain` is one of `verified` or a subdomain of one. */
export function domainIsCovered(domain: string, verified: readonly string[]): boolean {
  const d = normalizeEmailDomain(domain);
  if (d === null) return false;
  return verified.some((v) => d === v || d.endsWith(`.${v}`));
}

export function verificationRecord(token: string): string {
  return `${EMAIL_DOMAIN_TXT_PREFIX}${token}`;
}

export class EmailDomainError extends Error {
  constructor(
    readonly code: 'invalid-domain' | 'duplicate-domain' | 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'EmailDomainError';
  }
}

/**
 * An address, or a domain an address would be built from, outside every
 * verified domain. `field` is the request field that carried it, for the
 * problem's `errors[].path`.
 */
export class EmailDomainNotVerifiedError extends Error {
  constructor(
    readonly field: string,
    readonly domain: string,
  ) {
    super(`${domain} is not a verified email domain.`);
    this.name = 'EmailDomainNotVerifiedError';
  }
}

export interface EmailDomainView {
  id: string;
  domain: string;
  /** The exact TXT record to publish at the domain's apex. */
  record: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
  createdAt: Date;
}

type Row = {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
  createdAt: Date;
};

function view(row: Row): EmailDomainView {
  return {
    id: row.id,
    domain: row.domain,
    record: verificationRecord(row.verificationToken),
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckError: row.lastCheckError,
    createdAt: row.createdAt,
  };
}

export async function listEmailDomains(tx: TenantClient): Promise<EmailDomainView[]> {
  const rows = await tx.emailDomain.findMany({ orderBy: { domain: 'asc' } });
  return rows.map(view);
}

export async function findEmailDomain(tx: TenantClient, id: string): Promise<EmailDomainView> {
  const row = await tx.emailDomain.findFirst({ where: { id } });
  if (!row) throw new EmailDomainError('not-found', 'No such domain');
  return view(row);
}

export async function addEmailDomain(
  tx: TenantClient,
  input: string,
  actorUserId: string | null,
): Promise<EmailDomainView> {
  const domain = normalizeEmailDomain(input);
  if (domain === null) {
    throw new EmailDomainError('invalid-domain', `"${input.trim()}" is not a domain name, such as contoso.com`);
  }
  const existing = await tx.emailDomain.findFirst({ where: { domain } });
  if (existing) throw new EmailDomainError('duplicate-domain', `${domain} is already added.`);
  const row = await tx.emailDomain.create({
    data: {
      tenantId: await currentTenant(tx),
      domain,
      verificationToken: randomBytes(18).toString('base64url'),
      createdById: actorUserId,
    },
  });
  return view(row);
}

export async function removeEmailDomain(tx: TenantClient, id: string): Promise<EmailDomainView> {
  const row = await tx.emailDomain.findFirst({ where: { id } });
  if (!row) throw new EmailDomainError('not-found', 'No such domain');
  await tx.emailDomain.delete({ where: { id } });
  return view(row);
}

/** The TXT strings published at a name; each record's chunks joined. */
export type TxtLookup = (name: string) => Promise<string[]>;

export const dnsTxtLookup: TxtLookup = async (name) => {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  const records = await resolver.resolveTxt(name);
  return records.map((chunks) => chunks.join(''));
};

export type VerificationOutcome = { verified: true } | { verified: false; reason: string };

/**
 * Looks for the domain's record. Network I/O: call it OUTSIDE a transaction,
 * then store the outcome with `recordEmailDomainCheck`.
 */
export async function lookupEmailDomainVerification(
  domain: string,
  record: string,
  lookup: TxtLookup = dnsTxtLookup,
): Promise<VerificationOutcome> {
  let found: string[];
  try {
    found = await lookup(domain);
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { verified: false, reason: `${domain} has no TXT records yet.` };
    }
    return { verified: false, reason: `DNS lookup for ${domain} failed (${code ?? 'error'}). Try again shortly.` };
  }
  if (found.some((txt) => txt.trim() === record)) return { verified: true };
  return {
    verified: false,
    reason: found.some((txt) => txt.startsWith(EMAIL_DOMAIN_TXT_PREFIX))
      ? `${domain} publishes a ${EMAIL_DOMAIN_TXT_PREFIX} record, but not this one`
      : `${domain} does not publish the verification record yet`,
  };
}

/**
 * Stores a check's outcome. A domain that verified stays verified: the record
 * proved control once, and removing it afterwards is ordinary DNS hygiene,
 * not a change of owner.
 */
export async function recordEmailDomainCheck(
  tx: TenantClient,
  id: string,
  outcome: VerificationOutcome,
  now: Date = new Date(),
): Promise<EmailDomainView> {
  const row = await tx.emailDomain.findFirst({ where: { id } });
  if (!row) throw new EmailDomainError('not-found', 'No such domain');
  if (row.verifiedAt !== null) return view(row);
  const updated = await tx.emailDomain.update({
    where: { id },
    data: outcome.verified
      ? { verifiedAt: now, lastCheckedAt: now, lastCheckError: null }
      : { lastCheckedAt: now, lastCheckError: outcome.reason.slice(0, 500) },
  });
  return view(updated);
}

export async function verifiedEmailDomains(tx: TenantClient): Promise<string[]> {
  const rows = await tx.emailDomain.findMany({
    where: { verifiedAt: { not: null } },
    select: { domain: true },
    orderBy: { domain: 'asc' },
  });
  return rows.map((r) => r.domain);
}

/**
 * Throws `EmailDomainNotVerifiedError` unless `address` is in a verified
 * domain. Null, undefined and blank are "no address" and pass.
 */
export async function assertVerifiedEmailAddress(
  tx: TenantClient,
  address: string | null | undefined,
  field: string,
): Promise<void> {
  if (address === null || address === undefined || address.trim() === '') return;
  const domain = emailDomainOf(address.trim()) ?? address.trim().slice(address.lastIndexOf('@') + 1);
  if (!domainIsCovered(domain, await verifiedEmailDomains(tx))) {
    throw new EmailDomainNotVerifiedError(field, domain);
  }
}

/**
 * Attribute names whose value is an address: `mail`, `email`,
 * `userPrincipalName`, `otherMails`, `proxyAddresses` and the like.
 */
export function isAddressAttribute(name: string): boolean {
  return /e?mails?$|^emails?|userprincipalname|^upn$|proxyaddress/i.test(name);
}

/**
 * The domain an attribute value addresses, or null when it is not an address
 * (a `mailNickname`, say). `SMTP:`/`smtp:` proxy-address prefixes are read
 * through.
 */
export function addressedDomain(value: string): string | null {
  const address = value.trim().replace(/^smtp:/i, '');
  if (!address.includes('@')) return null;
  return emailDomainOf(address) ?? address.slice(address.lastIndexOf('@') + 1);
}

/**
 * Literal domains written into a template after an `@` -- the `contoso.com`
 * of `%person.givenName%@contoso.com` -- that no verified domain covers. A
 * domain built from a placeholder is not knowable here and is checked when
 * the template renders.
 */
export function unverifiedTemplateDomains(template: string, verified: readonly string[]): string[] {
  const literal = template.replace(/%[^%]*%/g, '\u0000');
  const found = new Set<string>();
  for (const match of literal.matchAll(/@([a-z0-9.-]+)(?![a-z0-9.-]|\u0000)/gi)) {
    const domain = normalizeEmailDomain(match[1]!);
    if (domain !== null && !domainIsCovered(domain, verified)) found.add(domain);
  }
  return [...found];
}

/**
 * The domain an Entra ID target completes a userPrincipalName with --
 * `userPrincipalDomain`, else a tenantId that is a domain -- or null when the
 * config names neither (the connector refuses that on its own).
 */
export function entraUpnDomain(config: unknown): string | null {
  const stored = (config ?? {}) as { tenantId?: unknown; userPrincipalDomain?: unknown };
  const named = entraUserPrincipalName(
    {
      tenantId: typeof stored.tenantId === 'string' ? stored.tenantId : '',
      ...(typeof stored.userPrincipalDomain === 'string' ? { userPrincipalDomain: stored.userPrincipalDomain } : {}),
    },
    'x',
  );
  return 'upn' in named ? named.upn.slice(named.upn.lastIndexOf('@') + 1).toLowerCase() : null;
}

/**
 * Throws `EmailDomainNotVerifiedError` when a target's configuration would
 * make it write addresses in an unverified domain. Today that is Entra ID's
 * userPrincipalName domain; other targets take their domain from the account
 * profile, which is checked on its own save.
 */
export function assertTargetDomainsVerified(
  targetType: string,
  config: unknown,
  verified: readonly string[],
): void {
  if (targetType !== 'entraId') return;
  const domain = entraUpnDomain(config);
  if (domain !== null && !domainIsCovered(domain, verified)) {
    const stored = (config ?? {}) as { userPrincipalDomain?: unknown };
    throw new EmailDomainNotVerifiedError(
      typeof stored.userPrincipalDomain === 'string' && stored.userPrincipalDomain.trim() !== ''
        ? 'config.userPrincipalDomain'
        : 'config.tenantId',
      domain,
    );
  }
}
