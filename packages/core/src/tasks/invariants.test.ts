import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The two static instruments this slice inherited by leaving Automate's
 * directory, carried here on purpose.
 *
 * `actions.ts` and `task-service.ts` began life in `packages/core/src/automate`
 * and broke two of that slice's invariant tests: `actions.ts` reaches for a
 * `Transport`, and `task-service.ts` calls `subjectAudienceFacts`. Moving them
 * out is the right fix — a delegated task is not a request and not an
 * approval, and Automate's rule that all its mail goes through the outbox is
 * one this slice genuinely cannot follow, because the reset-link template
 * carries a live credential and is deliberately excluded from `OutboxTemplate`.
 *
 * But a move that escaped the checks and left nothing behind would be evading
 * them, not answering them. Both rules still matter here, so both are
 * restated below in the form this slice actually has to satisfy.
 */
const DIR = 'packages/core/src/tasks';

/**
 * Comments stripped, so a docstring naming a forbidden symbol — this one
 * included — does not report the module that documents the rule as the module
 * that breaks it. Automate's own version of this check explains why at length.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const sourceFiles = () =>
  readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('nothing here sends inside a transaction', () => {
  it('reaches for a transport in exactly one module, and it is the action library', () => {
    // Automate forbids a transport in every module but the job module,
    // because everything it sends goes through the outbox. This slice cannot:
    // `send_password_reset` mails a live reset link, and `password-reset` is
    // excluded from `OutboxTemplate` for exactly that reason.
    //
    // So the rule narrows rather than disappears — one module may hold a
    // transport, and it is the one whose entries are the sends.
    const offenders = sourceFiles()
      .filter((f) => f !== 'actions.ts')
      .filter((f) =>
        /\b(sendMessage|queueMessage|deliverMessage|smtpTransport|Transport)\b/.test(
          codeOf(`${DIR}/${f}`),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('has no send inside the text of any withTenant callback', () => {
    // The rule that actually failed twice on this project. Bracket-matched to
    // the closing paren rather than counted, so moving one line into a
    // callback fails it.
    for (const file of sourceFiles()) {
      const code = codeOf(`${DIR}/${file}`);
      let index = code.indexOf('withTenant(');
      while (index !== -1) {
        let depth = 0;
        let end = index + 'withTenant'.length;
        for (; end < code.length; end += 1) {
          if (code[end] === '(') depth += 1;
          else if (code[end] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const span = code.slice(index, end);
        expect(
          /\b(sendMessage|queueMessage|deliverMessage|requestPasswordReset)\s*\(/.test(span),
          `${file} sends inside a withTenant callback`,
        ).toBe(false);
        index = code.indexOf('withTenant(', end);
      }
    }
  });
});

describe('the per-subject audience helper is not used over a population', () => {
  it('is called only where the subject count is exactly one', () => {
    // `subjectAudienceFacts` is roughly seven round trips and `withTenant` is
    // `prisma.$transaction` with Prisma's 5000 ms default, so it is safe only
    // where the subject count is fixed and small — and a P2028 anywhere the
    // count comes from data. Automate's copy of this check caught a live one:
    // `delegation-service.ts` calling it inside a loop bounded by a setting
    // that goes up to 1000.
    //
    // Both call sites here name ONE person: `tasksForPerson` takes a
    // `personId`, and `runTask` reads the facts of whoever is pressing the
    // button. Asserted rather than assumed, because "it is only ever one
    // person" is exactly the sentence that stops being true.
    const code = codeOf(`${DIR}/task-service.ts`);
    const calls = code.match(/subjectAudienceFacts\s*\(/g) ?? [];
    expect(calls).toHaveLength(2);

    // And no other module in this slice reaches for it at all.
    const others = sourceFiles()
      .filter((f) => f !== 'task-service.ts')
      .filter((f) => /subjectAudienceFacts\s*\(/.test(codeOf(`${DIR}/${f}`)));
    expect(others).toEqual([]);

    // Neither call sits inside a loop.
    //
    // Scoped to the ENCLOSING FUNCTION, not to a fixed number of characters
    // before the call. A fixed lookback crosses into whatever function happens
    // to precede this one and reports its `.map` as this one's loop — a test
    // that fails on correct code, which is the kind that gets relaxed until it
    // certifies nothing. The first draft of this did exactly that.
    for (const match of code.matchAll(/subjectAudienceFacts\s*\(/g)) {
      const start = code.lastIndexOf('function ', match.index);
      const body = code.slice(start === -1 ? 0 : start, match.index);
      expect(
        /\b(for|while)\s*\(|\.map\s*\(|\.forEach\s*\(/.test(body),
        'a per-subject read appears inside a loop',
      ).toBe(false);
    }
  });
});
