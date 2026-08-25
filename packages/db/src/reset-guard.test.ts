import { describe, expect, it } from 'vitest';
import { resetDecision } from './reset-guard.js';

const url = (name: string) => `postgresql://syntra:syntra@localhost:5432/${name}`;

describe('resetDecision', () => {
  /**
   * The worker databases the suite provisions for itself. Emptying one is
   * the whole point of them, and requiring a ceremony here would put the
   * ceremony in CI rather than in front of the operator who needs it.
   */
  it('allows a scratch test database with no ceremony', () => {
    expect(
      resetDecision({ databaseUrl: url('syntra_test_ba9ecd06eae8_w1'), allowVar: undefined }),
    ).toEqual({ allow: true, database: 'syntra_test_ba9ecd06eae8_w1' });
  });

  /**
   * THE ONE THAT MATTERS. The development database and the lab database are
   * both named `syntra`, so nothing about the name can tell them apart --
   * which is exactly why the answer is no until somebody says otherwise.
   */
  it('refuses a database named `syntra` by default', () => {
    const decision = resetDecision({ databaseUrl: url('syntra'), allowVar: undefined });
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toContain('syntra');
    expect(decision.reason).toContain('SYNTRA_ALLOW_RESET');
  });

  it('allows it when the operator names that exact database', () => {
    expect(resetDecision({ databaseUrl: url('syntra'), allowVar: 'syntra' })).toEqual({
      allow: true,
      database: 'syntra',
    });
  });

  /**
   * Naming a DIFFERENT database is the copy-pasted-incantation case: the
   * operator carried an override from another checkout. It must not pass.
   */
  it('refuses when the named database is not the one it is pointed at', () => {
    expect(resetDecision({ databaseUrl: url('syntra'), allowVar: 'syntra_dev' }).allow).toBe(false);
  });

  it('refuses a truthy-but-meaningless override', () => {
    for (const allowVar of ['1', 'true', 'yes']) {
      expect(resetDecision({ databaseUrl: url('syntra'), allowVar }).allow).toBe(false);
    }
  });

  it('refuses when DATABASE_URL is absent or unparseable', () => {
    expect(resetDecision({ databaseUrl: undefined, allowVar: 'syntra' }).allow).toBe(false);
    expect(resetDecision({ databaseUrl: 'not-a-url', allowVar: 'syntra' }).allow).toBe(false);
  });

  it('refuses a URL with no database path', () => {
    expect(
      resetDecision({ databaseUrl: 'postgresql://u:p@localhost:5432/', allowVar: 'x' }).allow,
    ).toBe(false);
  });
});
