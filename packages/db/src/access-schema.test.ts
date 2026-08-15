import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await tx.user.create({
      data: { tenantId, login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' },
    });
    return u.id;
  });
});

const appRow = (slug = 'crm') => ({
  tenantId,
  name: 'CRM',
  slug,
  type: 'bookmark',
  launchUrl: 'https://crm.acme.test/',
});

describe('access schema', () => {
  it('defaults a tenant to no admin MFA, a 12-character minimum, and self-enrolment on', async () => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.adminMfaRequired).toBe(false);
    expect(t.passwordMinLength).toBe(12);
    // On by default: off means a require_mfa rule refuses everyone who has not
    // already enrolled, which is a decision a tenant makes, not a default.
    expect(t.selfEnrolmentEnabled).toBe(true);
  });

  it('defaults an auth attempt to the verify purpose and the portal scope', async () => {
    const attempt = await withTenant(tenantId, (tx) =>
      tx.authAttempt.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'digest',
          requiredOutcome: 'require_mfa',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(attempt.purpose).toBe('verify');
    // Never inferred later from whether a cookie happened to be present.
    expect(attempt.scope).toBe('portal');
  });

  it('records which factor established a session, if any', async () => {
    const plain = await withTenant(tenantId, (tx) =>
      tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'a',
          scope: 'portal',
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(plain.satisfiedFactor).toBeNull();

    const stepped = await withTenant(tenantId, (tx) =>
      tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'b',
          scope: 'admin',
          satisfiedFactor: 'totp',
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(stepped.satisfiedFactor).toBe('totp');
  });

  it('stores a WebAuthn counter past the signed 32-bit limit', async () => {
    // Counters are uint32. An Int column would fail on this write, and it is
    // the write that cloned-key detection depends on.
    const row = await withTenant(tenantId, (tx) =>
      tx.webAuthnCredential.create({
        data: {
          tenantId,
          userId,
          credentialId: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: BigInt(4_000_000_000),
          rpId: 'acme.syntra.test',
          label: 'Key',
        },
      }),
    );
    expect(row.counter).toBe(BigInt(4_000_000_000));
  });

  it('defaults a user password to local', async () => {
    const u = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(u.passwordSource).toBe('local');
    expect(u.passwordSourceHint).toBeNull();
  });

  it('isolates applications between tenants', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) => tx.application.create({ data: appRow() }));
    const seen = await withTenant(other.id, (tx) => tx.application.findMany());
    expect(seen).toEqual([]);
  });

  it('refuses an assignment that names no subject', async () => {
    const id = await withTenant(tenantId, async (tx) =>
      (await tx.application.create({ data: appRow() })).id,
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.appAssignment.create({
          data: { tenantId, applicationId: id, subjectType: 'user' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an assignment that names two subjects', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const a = await tx.application.create({ data: appRow() });
      const g = await tx.group.create({ data: { tenantId, name: 'Nurses' } });
      return { appId: a.id, groupId: g.id };
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.appAssignment.create({
          data: {
            tenantId,
            applicationId: ids.appId,
            subjectType: 'user',
            userId,
            groupId: ids.groupId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses the same user assigned to the same application twice', async () => {
    const appId = await withTenant(tenantId, async (tx) =>
      (await tx.application.create({ data: appRow() })).id,
    );
    const row = { tenantId, applicationId: appId, subjectType: 'user', userId };
    await withTenant(tenantId, (tx) => tx.appAssignment.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.appAssignment.create({ data: row })),
    ).rejects.toThrow();
  });

  it('allows a user and a group assignment on the same application', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const a = await tx.application.create({ data: appRow() });
      const g = await tx.group.create({ data: { tenantId, name: 'Nurses' } });
      return { appId: a.id, groupId: g.id };
    });
    await withTenant(tenantId, async (tx) => {
      await tx.appAssignment.create({
        data: { tenantId, applicationId: ids.appId, subjectType: 'user', userId },
      });
      await tx.appAssignment.create({
        data: {
          tenantId,
          applicationId: ids.appId,
          subjectType: 'group',
          groupId: ids.groupId,
        },
      });
    });
    expect(await withTenant(tenantId, (tx) => tx.appAssignment.count())).toBe(2);
  });

  it('allows only one live WebAuthn challenge per user and purpose', async () => {
    const row = {
      tenantId,
      userId,
      purpose: 'authenticate',
      expiresAt: new Date(Date.now() + 60_000),
    };
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.create({ data: { ...row, challenge: 'one' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.webAuthnChallenge.create({ data: { ...row, challenge: 'two' } }),
      ),
    ).rejects.toThrow();

    // Consuming the first frees the slot; the index only covers live rows.
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.updateMany({
        where: { userId },
        data: { consumedAt: new Date() },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.create({ data: { ...row, challenge: 'two' } }),
    );
    expect(await withTenant(tenantId, (tx) => tx.webAuthnChallenge.count())).toBe(2);
  });

  it('allows only one live password reset token per user', async () => {
    const row = { tenantId, userId, expiresAt: new Date(Date.now() + 60_000) };
    await withTenant(tenantId, (tx) =>
      tx.passwordResetToken.create({ data: { ...row, tokenHash: 'a' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.passwordResetToken.create({ data: { ...row, tokenHash: 'b' } }),
      ),
    ).rejects.toThrow();
  });

  it('keeps rule positions unique within a policy', async () => {
    const policyId = await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      await tx.authPolicyRule.create({
        data: { tenantId, policyId: p.id, position: 1, name: 'First', outcome: 'allow' },
      });
      return p.id;
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: { tenantId, policyId, position: 1, name: 'Clash', outcome: 'deny' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('cascades rules when the policy is removed', async () => {
    await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      await tx.authPolicyRule.create({
        data: { tenantId, policyId: p.id, position: 1, name: 'First', outcome: 'allow' },
      });
      await tx.authPolicy.delete({ where: { id: p.id } });
    });
    expect(await withTenant(tenantId, (tx) => tx.authPolicyRule.count())).toBe(0);
  });
});
