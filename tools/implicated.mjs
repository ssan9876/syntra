/**
 * Which tests does any mutant implicate?
 *
 * The mutation pass answers "can the suite fail when the code is wrong". This
 * answers the other half: "is there a test that no mutation of the code can
 * make fail". A test in that position is documentation wearing a test's
 * clothes — it passes, it reads as a check, and nothing about the code
 * decides whether it passes.
 *
 * Task 10 ran this and found one such test. Task 5 reported another, honestly,
 * that no mutant could kill.
 */
import fs from 'node:fs';

const mutants = JSON.parse(fs.readFileSync('tools/task12-mutants.json', 'utf8'));
const files = [
  'packages/core/src/provision/target-service.test.ts',
  'packages/core/src/provision/target-service.schemas.test.ts',
  'packages/core/src/provision/entitlement-service.test.ts',
];

const patternsByFile = new Map();
for (const m of mutants) {
  if (!patternsByFile.has(m.test)) patternsByFile.set(m.test, []);
  patternsByFile.get(m.test).push({ id: m.id, re: new RegExp(m.pattern) });
}

let unimplicated = 0;
let total = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/\n\s*it\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    names.add(match[1].replace(/\\'/g, "'"));
  }
  // it.each cases: the template name with %s substituted is what vitest runs,
  // so the literal prefix is what a selector can match on.
  for (const match of source.matchAll(/it\.each\([^)]*\)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    names.add(match[1].replace(/ %s.*/, '').replace(/\\'/g, "'"));
  }

  const patterns = patternsByFile.get(file) ?? [];
  for (const name of [...names].sort()) {
    total += 1;
    const hits = patterns.filter((p) => p.re.test(name));
    if (hits.length === 0) {
      unimplicated += 1;
      console.log(`NOT IMPLICATED\t${file.split('/').pop()}\t${name}`);
    }
  }
}

console.log(`\n${total - unimplicated}/${total} tests implicated by at least one mutant`);
