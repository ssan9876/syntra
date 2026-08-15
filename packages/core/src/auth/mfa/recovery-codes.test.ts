import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import {
  RECOVERY_CODE_COUNT,
  countUnusedRecoveryCodes,
  generateRecoveryCodes,
  hasRecoveryCodesFor,
  recoveryCodeVerifier,
  removeRecoveryCodes,
} from './recovery-codes.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const generate = () =>
  withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));

const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

const use = (code: string) =>
  recoveryCodeVerifier().verify(
    tenantId,
    userId,
    { type: 'recovery_code', code },
    { now: new Date(), relyingParty: RP },
  );

describe('generateRecoveryCodes', () => {
  it('returns ten distinct codes', async () => {
    const codes = await generate();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('uses an unambiguous alphabet and a readable shape', async () => {
    for (const code of await generate()) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('stores hashes, never the codes', async () => {
    const codes = await generate();
    const rows = await withTenant(tenantId, (tx) => tx.recoveryCode.findMany());
    const stored = JSON.stringify(rows);
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace('-', ''));
    }
  });

  it('replaces the previous set rather than adding to it', async () => {
    const first = await generate();
    await generate();
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT,
    );
    expect(await use(first[0]!)).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });
});

describe('recoveryCodeVerifier', () => {
  it('accepts a code once', async () => {
    const codes = await generate();
    expect(await use(codes[0]!)).toEqual({ ok: true });
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });

  it('refuses the same code twice', async () => {
    const codes = await generate();
    await use(codes[0]!);
    expect(await use(codes[0]!)).toEqual({ ok: false, reason: 'recovery_code_used' });
  });

  it('accepts a code typed in lower case with spaces', async () => {
    const codes = await generate();
    const messy = ` ${codes[0]!.toLowerCase()} `;
    expect(await use(messy)).toEqual({ ok: true });
  });

  it('accepts a code typed without the separator', async () => {
    const codes = await generate();
    expect(await use(codes[0]!.replace('-', ''))).toEqual({ ok: true });
  });

  it('refuses a code that was never issued', async () => {
    await generate();
    expect(await use('ZZZZZ-ZZZZZ')).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });

  it('refuses when the user has no codes at all', async () => {
    expect(await use('ZZZZZ-ZZZZZ')).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });

  it('lets exactly one of two concurrent uses of the same code succeed', async () => {
    const codes = await generate();
    const [a, b] = await Promise.all([use(codes[0]!), use(codes[0]!)]);
    const outcomes = [a.ok, b.ok].sort();
    expect(outcomes).toEqual([false, true]);
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });
});

describe('hasRecoveryCodesFor / removeRecoveryCodes', () => {
  it('reports false once every code is spent', async () => {
    const codes = await generate();
    for (const code of codes) await use(code);
    expect(await withTenant(tenantId, (tx) => hasRecoveryCodesFor(tx, userId))).toBe(false);
  });

  it('removes every code, spent or not', async () => {
    await generate();
    await withTenant(tenantId, (tx) => removeRecoveryCodes(tx, userId));
    expect(await withTenant(tenantId, (tx) => tx.recoveryCode.count())).toBe(0);
  });
});
