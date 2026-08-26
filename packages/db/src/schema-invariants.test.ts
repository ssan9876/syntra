import { describe, expect, it } from 'vitest';
import { prisma } from './client.js';

/**
 * The indexes that carry an invariant, asked of the live database.
 *
 * The two in this first block already existed before this file did --
 * `signing_key_one_active` from `20260817000000_access_2`,
 * `target_account_anchor_unique` from `20260820000000_provision_targets` --
 * despite a comment in `signing-key-service.ts` that reads as though it were
 * naming a gap: "Only after the previous row has left 'active' --
 * signing_key_one_active is what makes this ordering load-bearing rather than
 * stylistic." The audit that named this task read that comment as evidence
 * the index was missing; it names one that was already there. Both cases
 * stay, as regression coverage for an invariant worth keeping true, not as
 * proof of a fix.
 */
const indexes = async (table: string): Promise<string[]> => {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    table,
  );
  return rows.map((r) => r.indexname);
};

describe('the schema one-per invariants', () => {
  it('allows only one active signing key per tenant and kind', async () => {
    expect(await indexes('SigningKey')).toContain('signing_key_one_active');
  });

  /**
   * `TargetAccount.anchor` is the target's immutable object identifier. Two
   * rows claiming one is two Syntra accounts pointing at one directory object,
   * and every convergence decision after that is made against whichever the
   * query happened to return.
   */
  it('allows only one account per target and anchor', async () => {
    expect(await indexes('TargetAccount')).toContain('target_account_anchor_unique');
  });
});

describe('the index every portal render needs', () => {
  /**
   * The unique index leads with `groupId`, so the per-USER lookup -- which is
   * what a portal render, a SAML assertion and an OIDC token each do -- fell
   * back to the bare `tenantId` index and filtered the tenant's whole
   * membership table. `RoleAssignment` carries exactly this index; this table
   * did not.
   */
  it('indexes GroupMembership on userId', async () => {
    expect(await indexes('GroupMembership')).toContain('GroupMembership_userId_idx');
  });
});
