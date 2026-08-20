import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GOVERN_DIR = dirname(fileURLToPath(import.meta.url));

const sourceFiles = () =>
  readdirSync(GOVERN_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(GOVERN_DIR, f), 'utf8') }));

describe('Govern opens no socket', () => {
  it('imports no connector package anywhere in the module', () => {
    // Govern reads PostgreSQL. That is a security property worth more than the
    // convenience it costs: the reporting surface — the one an auditor, a
    // manager and a team lead all touch — cannot be used to reach a domain
    // controller, because nothing in its dependency graph knows how.
    const offenders = sourceFiles()
      .filter((f) => /@syntra\/connectors|from 'ldapts'|require\('ldapts'\)/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('reaches no vault entry and no target credential', () => {
    const offenders = sourceFiles()
      .filter((f) => /getSecret|putSecret|MasterKeyProvider|targetWithCredential|secretName/.test(f.text))
      .map((f) => f.name);
    // audit-integrity.ts is exempt: it holds a CHECKPOINT SIGNING key, which is
    // Govern's own and reaches no target. It is named explicitly rather than
    // matched by a pattern, so adding a second exemption is a deliberate edit.
    expect(offenders.filter((n) => n !== 'audit-integrity.ts')).toEqual([]);
  });

  it('keeps the eight pure modules free of any @syntra/db import', () => {
    const pure = [
      'types.ts', 'freshness.ts', 'attribute.ts', 'diff.ts',
      'sod.ts', 'dispatch.ts', 'revocation-guard.ts', 'graph.ts',
    ];
    for (const file of sourceFiles()) {
      if (!pure.includes(file.name)) continue;
      expect(file.text, `${file.name} must import nothing from @syntra/db`).not.toMatch(
        /from '@syntra\/db'/,
      );
    }
  });
});

describe('Govern writes no access-bearing row', () => {
  const FORBIDDEN = [
    'groupMembership',
    'appAssignment',
    'roleAssignment',
    'targetAccount',
    'accountEntitlement',
    'accessGrant',
    'auditEvent',
  ];

  it('names no write on a table another subsystem owns', () => {
    // Every removal is dispatched to the owning subsystem or becomes a
    // remediation item. `auditEvent` is on the list because Govern writes audit
    // events only through `recordEvent` — a direct create would bypass the
    // advisory lock and the chain.
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      for (const model of FORBIDDEN) {
        const pattern = new RegExp(`\\.${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`);
        if (pattern.test(file.text)) violations.push(`${file.name}: ${model}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('still permits reads of those tables, which is the whole job', () => {
    const collect = readFileSync(join(GOVERN_DIR, 'collect.ts'), 'utf8');
    expect(collect).toMatch(/\.groupMembership\.findMany/);
    expect(collect).toMatch(/\.accessGrant\.findMany/);
  });
});

describe('no import cycle reaches snapshot-service.ts — Ruling G-6', () => {
  // Two modules import `snapshot-service.ts` from inside it: Task 8 makes it
  // import `finding-service.ts`, and Task 16's first draft had it call
  // `sod-service.ts`. Both close a loop if those modules import the accessor
  // back out of it. The accessor therefore lives in `readable.ts`, which
  // imports nothing else in this directory, and these assertions keep it there.
  const CYCLE_FREE = ['finding-service.ts', 'drift-link.ts', 'sod-service.ts'];

  it('keeps finding-service.ts, drift-link.ts and sod-service.ts out of snapshot-service.ts', () => {
    for (const name of CYCLE_FREE) {
      const file = sourceFiles().find((f) => f.name === name);
      if (file === undefined) continue; // not yet written; the task that adds it adds the assertion
      expect(file.text, `${name} must not import snapshot-service.ts — use readable.ts`).not.toMatch(
        /from '\.\/snapshot-service\.js'/,
      );
    }
  });

  it('keeps snapshot-service.ts out of sod-service.ts and readable.ts', () => {
    const snapshot = sourceFiles().find((f) => f.name === 'snapshot-service.ts');
    expect(snapshot?.text ?? '').not.toMatch(/from '\.\/sod-service\.js'/);
    const readable = sourceFiles().find((f) => f.name === 'readable.ts');
    expect(readable, 'readable.ts must exist — Ruling G-6').toBeDefined();
    // readable.ts is the cycle breaker, so its ONLY in-directory import is
    // ./freshness.js (for ClassifiedSource). Anything else and the cycle
    // returns by another door. `@syntra/db` is not matched: it is not relative.
    const imports = [...(readable?.text ?? '').matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!);
    expect([...new Set(imports)].sort()).toEqual(['./freshness.js']);
  });
});

describe('the prevention points depend on Govern, never the reverse', () => {
  it('keeps every import of Provision and Automate out of the govern directory', () => {
    // Provision's rule editor and run guard, and Automate's eligibility check
    // and catalog, all import Govern. That is one-way by design: `sod.ts` is
    // pure and takes plain values, so none of them acquires a dependency on a
    // RUNNING Govern, and Govern acquires no dependency on them at all.
    //
    // The two exceptions are named, not implied: `jobs.ts` and `collect.ts`
    // reach into Automate for the outbox and for the live-grant vocabulary,
    // and both were already true before segregation of duties existed. An
    // import of `../provision/` in either direction would close a loop that
    // ESM tolerates until an initialisation order changes.
    const ALLOWED = new Map([
      ['jobs.ts', ["'../automate/notify.js'"]],
      ['collect.ts', ["'../automate/types.js'"]],
      // §12: Automate's selector machinery is REUSED rather than
      // reimplemented. An approval chain and a review chain disagreeing about
      // who somebody's manager is would be a support call nobody can close.
      // `approvers.js` is pure resolution and `notify.js` is the outbox;
      // neither reaches back into Govern.
      ['decision-service.ts', ["'../automate/approvers.js'"]],
      [
        'reviewer-service.ts',
        ["'../automate/approvers.js'", "'../automate/notify.js'"],
      ],
      // §11: a campaign's scope is written in "the same closed interpreter
      // Provision's business rules and Automate's audiences use, over the same
      // closed field set. A tenant learns one expression language."
      // `condition.ts` imports nothing but zod, so it is a leaf and the
      // direction cannot close into a cycle.
      [
        'campaign-service.ts',
        ["'../provision/condition.js'", "'../automate/notify.js'"],
      ],
      // §15. The self-approval invariant applies unchanged to a risk
      // acceptance, and §12's reason applies with it: Automate's resolver is
      // REUSED rather than reimplemented, because an approval chain and a
      // risk-acceptance chain disagreeing about who somebody's manager is
      // would be a support call nobody can close. It is the RESOLVER that is
      // reused and not `request-service.js`, which is keyed on a Product — an
      // exception is not a catalog item.
      [
        'exception-service.ts',
        ["'../automate/approvers.js'", "'../automate/notify.js'"],
      ],
      // §5 and §13. The revocation service is the ONE place Govern hands work
      // to another subsystem, so it is the one place these names belong — and
      // all four go the safe way. `fulfil.js` is Automate's entry point for
      // ending a grant and `types.js` its live-grant vocabulary, both called;
      // `provision/desired.js` gives `personDisplayName`, a pure formatter; and
      // `provision/types.js` is a TYPE-ONLY import of `RevocationOrderFacts`,
      // the plain-value shape Provision's plan stage receives. Provision never
      // queries Govern — it is HANDED that array — so nothing here closes a
      // loop.
      [
        'revocation-service.ts',
        [
          "'../automate/fulfil.js'",
          "'../automate/types.js'",
          "'../provision/desired.js'",
          "'../provision/types.js'",
        ],
      ],
    ]);
    for (const file of sourceFiles()) {
      const imports = [...file.text.matchAll(/from ('\.\.\/(?:provision|automate)\/[^']+')/g)].map(
        (m) => m[1]!,
      );
      const allowed = ALLOWED.get(file.name) ?? [];
      expect(
        imports.filter((i) => !allowed.includes(i)),
        `${file.name} must not import Provision or Automate`,
      ).toEqual([]);
    }
  });
});

describe('the sequencer is jobs.ts, not snapshot-service.ts', () => {
  it('keeps snapshot-service free of any import of sod-service', () => {
    // They would otherwise import each other: sod-service needs the snapshot
    // accessor, and a detect call in the other direction closes the loop. ESM
    // tolerates a cycle until an initialisation order changes and one module is
    // half-constructed, and the failure reads as an unrelated
    // `undefined is not a function` somewhere else entirely.
    const snapshot = sourceFiles().find((f) => f.name === 'snapshot-service.ts');
    expect(snapshot?.text ?? '').not.toMatch(/from '\.\/sod-service\.js'/);
  });
});

describe('every snapshot read goes through readableSnapshot', () => {
  it('is asserted over the module list, so a module added later without it fails', () => {
    // Automate's visibility suite, for staleness. Govern trades Provision's
    // atomicity for a status flag and this accessor is the entire protection
    // that trade bought, so the test is enumerated rather than sampled.
    const MUST_USE_ACCESSOR = [
      'report-service.ts',
      'export-service.ts',
      'campaign-service.ts',
      'sod-service.ts',
      'revocation-service.ts',
    ];
    for (const name of MUST_USE_ACCESSOR) {
      const file = sourceFiles().find((f) => f.name === name);
      if (file === undefined) continue; // not yet written; the task that adds it adds the assertion
      expect(file.text, `${name} must read snapshots through readableSnapshot()`).toMatch(
        /readableSnapshot\s*\(/,
      );
      expect(
        file.text,
        `${name} must not query accessSnapshot directly`,
      ).not.toMatch(/\.accessSnapshot\.(findFirst|findUnique|findMany)/);
    }
  });
});
