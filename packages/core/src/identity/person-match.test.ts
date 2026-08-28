import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { linkUserToPerson } from './person-service.js';
import { matchPersonForAccount } from './person-match.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const person = (data: Record<string, unknown> = {}) =>
  withTenant(tenantId, (tx) =>
    tx.person.create({
      data: { tenantId, givenName: 'Maya', familyName: 'Okafor', ...data },
    }),
  );

const match = (email: string, displayName = '') =>
  withTenant(tenantId, (tx) => matchPersonForAccount(tx, { email, displayName }));

describe('matchPersonForAccount', () => {
  it('is confident about a unique business-email match', async () => {
    const p = await person({ businessEmail: 'maya.okafor@acme.test' });

    // Case-insensitively: an address is not two addresses.
    const result = await match('Maya.Okafor@ACME.test', 'Unrelated Name');

    expect(result.confident?.personId).toBe(p.id);
    expect(result.confident?.rule).toBe('businessEmail');
  });

  it('demotes an ambiguous business-email match to candidates', async () => {
    await person({ businessEmail: 'shared@acme.test', givenName: 'A' });
    await person({ businessEmail: 'shared@acme.test', givenName: 'B' });

    const result = await match('shared@acme.test');

    // Picking the first would link an account to whichever row the planner
    // happened to return that afternoon.
    expect(result.confident).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  it('never auto-links on a personal email', async () => {
    await person({ personalEmail: 'maya@gmail.test' });

    const result = await match('maya@gmail.test');

    // A personal address on a work account is a guess about somebody's
    // private life.
    expect(result.confident).toBeNull();
    expect(result.candidates[0]?.rule).toBe('personalEmail');
  });

  it('never auto-links on a name, and normalises whitespace to find one', async () => {
    await person({ givenName: 'Maya', familyName: 'Okafor' });

    const result = await match('nobody@acme.test', '  maya   OKAFOR ');

    expect(result.confident).toBeNull();
    expect(result.candidates[0]?.rule).toBe('displayName');
  });

  it('ignores inactive people', async () => {
    await person({ businessEmail: 'gone@acme.test', status: 'inactive' });

    const result = await match('gone@acme.test', 'Maya Okafor');

    expect(result).toEqual({ confident: null, candidates: [] });
  });

  it('says nothing when nothing matches', async () => {
    await person({ businessEmail: 'someone@acme.test' });

    const result = await match('nobody@acme.test', 'No Body');

    // Silence is the default. This runs over every service account Syntra
    // will ever hold, and a suggestion on each would train people to dismiss
    // the control.
    expect(result).toEqual({ confident: null, candidates: [] });
  });

  it('reports that a candidate already holds an active account', async () => {
    const p = await person({ businessEmail: 'taken@acme.test' });
    await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'taken',
        email: 'taken-login@acme.test',
        displayName: 'T',
      });
      await linkUserToPerson(tx, u.id, p.id);
    });

    const result = await match('taken@acme.test');

    // Still confident by rule; what to do about the existing account is the
    // caller's decision. Keeping the two facts apart is what lets the create
    // path demote it while the suggestion list still shows it.
    expect(result.confident?.hasActiveAccount).toBe(true);
  });

  it('does not count a deactivated account as one they hold', async () => {
    const p = await person({ businessEmail: 'replaced@acme.test' });
    await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'leaver',
        email: 'leaver@acme.test',
        displayName: 'L',
      });
      await linkUserToPerson(tx, u.id, p.id);
      await tx.user.update({ where: { id: u.id }, data: { status: 'inactive' } });
    });

    const result = await match('replaced@acme.test');

    // Replacing a leaver's account is not a second account.
    expect(result.confident?.hasActiveAccount).toBe(false);
  });

  it('describes a person matched by two rules once, by the stronger', async () => {
    await person({
      businessEmail: 'same@acme.test',
      personalEmail: 'same@acme.test',
      givenName: 'Maya',
      familyName: 'Okafor',
    });

    const result = await match('same@acme.test', 'Maya Okafor');

    // One confident hit on the business rule, and it does not also appear in
    // the candidate list under a weaker reason.
    expect(result.confident?.rule).toBe('businessEmail');
    expect(result.candidates).toEqual([]);
  });

  it('does not see another tenant’s people', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(other.id, (tx) =>
      tx.person.create({
        data: {
          tenantId: other.id,
          givenName: 'Maya',
          familyName: 'Okafor',
          businessEmail: 'maya@acme.test',
        },
      }),
    );

    const result = await match('maya@acme.test', 'Maya Okafor');

    expect(result).toEqual({ confident: null, candidates: [] });
  });

  it('matches nothing on an empty email and an empty name', async () => {
    await person({ businessEmail: 'someone@acme.test' });

    // A service account created with neither must not sweep up whoever
    // happens to have a blank field.
    const result = await match('', '');

    expect(result).toEqual({ confident: null, candidates: [] });
  });
});
