import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './test-database.js';

/**
 * THE RULE: outside `packages/db`, nothing touches a Prisma model directly.
 *
 * Every tenant-scoped table is `FORCE ROW LEVEL SECURITY` against
 * `current_setting('app.current_tenant')`, and that setting is established by
 * `withTenant` and nowhere else. A query issued on the bare client therefore
 * runs with no tenant bound, and the failure mode is not an error — it is a
 * silent empty result. Code written that way looks like it works: the write
 * path throws, so somebody notices, but the READ path returns `[]` and the
 * caller concludes there is nothing there.
 *
 * That is the shape of the bug this rule exists to prevent, and it has been
 * written by hand often enough that four separate test files carry a comment
 * warning about it.
 *
 * `prisma.tenant.*` is exempt. `Tenant` is the one table that is not
 * tenant-scoped — it is the table tenants are rows OF — so there is no setting
 * for it to be bound by, and `withTenant` cannot be used to reach it without
 * knowing the tenant it is trying to find.
 */
const EXEMPT_MODELS = new Set(['tenant']);

/**
 * This file, which cannot help but contain the pattern it bans.
 *
 * Named explicitly rather than matched by a path pattern, so a second
 * exemption is a deliberate edit somebody has to justify in a diff.
 */
const EXEMPT_FILES = new Set([join('packages', 'db', 'src', 'prisma-boundary.test.ts')]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Comments removed before the scan.
 *
 * Without this the rule fails on its own documentation: the four warnings that
 * prompted it all quote `prisma.user.findMany()` to explain what not to write,
 * and a rule that cannot tell a violation from a warning about violations
 * teaches people to delete the warnings.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODEL_ACCESS = /\bprisma\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\./g;

describe('the Prisma client is reached through withTenant, or not at all', () => {
  it('has no direct model access outside packages/db', () => {
    const offenders: string[] = [];

    for (const root of ['packages', 'apps']) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        // `packages/db` owns the client, so it is the one place allowed to
        // hold it.
        if (rel.startsWith(join('packages', 'db') + sep)) continue;
        if (EXEMPT_FILES.has(rel)) continue;

        const text = withoutComments(readFileSync(file, 'utf8'));
        for (const match of text.matchAll(MODEL_ACCESS)) {
          const model = match[1]!;
          if (EXEMPT_MODELS.has(model)) continue;
          offenders.push(`${rel}: prisma.${model}`);
        }
      }
    }

    expect(
      [...new Set(offenders)].sort(),
      'Reach these through withTenant(tenantId, (tx) => tx.<model>...) — a bare ' +
        'client has no tenant bound, and row-level security answers with an ' +
        'empty result rather than an error.',
    ).toEqual([]);
  });

  it('would catch a violation if one were written', () => {
    // The rule is a regex over source text, which is exactly the kind of check
    // that can quietly stop matching — a changed pattern, a stripped comment
    // rule that eats too much — and go on reporting a clean repository
    // forever. So it is pointed at a sample rather than trusted.
    const sample = [
      "const rows = await prisma.user.findMany();",
      "await prisma.tenant.findFirst({ where: { slug } });",
      "// prisma.auditEvent.findMany() matches nothing outside a bound tx",
      "/* prisma.signingKey.findMany() likewise */",
    ].join('\n');

    const found = [...withoutComments(sample).matchAll(MODEL_ACCESS)]
      .map((m) => m[1]!)
      .filter((model) => !EXEMPT_MODELS.has(model));

    // The real access, and neither comment, and not the exempt model.
    expect(found).toEqual(['user']);
  });
});
