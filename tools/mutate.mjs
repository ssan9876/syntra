/**
 * A minimal mutation runner for one task's files.
 *
 * Applies one textual mutation at a time to a source file, runs a named
 * subset of the suite, and records whether anything failed. The point is not
 * coverage: it is whether the tests are CAPABLE of failing when the code is
 * wrong, which is the only question a green suite cannot answer about itself.
 *
 *   node tools/mutate.mjs verify <mutants.json>
 *   node tools/mutate.mjs run    <mutants.json> [from] [to]
 *
 * `verify` runs every mutant's test selector against PRISTINE code and
 * reports how many tests it selected. A selector that matches nothing makes
 * vitest exit non-zero, which the runner would otherwise read as a kill — the
 * mutation-testing equivalent of a test that passes for the wrong reason.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [, , mode, listPath, fromArg, toArg] = process.argv;
const mutants = JSON.parse(fs.readFileSync(listPath, 'utf8'));

function vitest(testFile, pattern) {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', testFile, '-t', pattern],
    { encoding: 'utf8', shell: true, timeout: 900_000 },
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const passed = /Tests\s+(\d+) passed/.exec(out.replace(/\[[0-9;]*m/g, ''));
  const failed = /(\d+) failed/.exec(out.replace(/\[[0-9;]*m/g, ''));
  return {
    status: result.status,
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
  };
}

if (mode === 'verify') {
  const seen = new Set();
  let bad = 0;
  for (const m of mutants) {
    const key = `${m.test}::${m.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = fs.readFileSync(m.file, 'utf8');
    const occurrences = source.split(m.find).length - 1;
    const r = vitest(m.test, m.pattern);
    const ok = r.status === 0 && r.passed > 0 && occurrences === 1;
    if (!ok) bad += 1;
    console.log(
      `${ok ? 'ok  ' : 'BAD '}\t${m.id}\tselects ${r.passed}\texit ${r.status}\tfind x${occurrences}\t${m.pattern}`,
    );
  }
  console.log(`\n${bad} selectors or patterns need attention`);
  process.exit(bad === 0 ? 0 : 1);
}

const from = fromArg ? Number(fromArg) : 0;
const to = toArg ? Number(toArg) : mutants.length;

const pristine = new Map();
for (const m of mutants) {
  if (!pristine.has(m.file)) pristine.set(m.file, fs.readFileSync(m.file, 'utf8'));
}
const restore = () => {
  for (const [file, text] of pristine) fs.writeFileSync(file, text);
};
process.on('exit', restore);

const results = [];
for (let i = from; i < to && i < mutants.length; i += 1) {
  const m = mutants[i];
  const original = pristine.get(m.file);
  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    results.push({ id: m.id, verdict: 'BAD_PATTERN' });
    console.log(`${m.id}\tBAD_PATTERN\t${occurrences} occurrences`);
    continue;
  }
  fs.writeFileSync(m.file, original.replace(m.find, m.replace));
  const started = Date.now();
  const r = vitest(m.test, m.pattern);
  fs.writeFileSync(m.file, original);

  const verdict = r.status !== 0 ? 'KILLED' : 'SURVIVED';
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ id: m.id, verdict, seconds, failed: r.failed, note: m.note });
  console.log(`${m.id}\t${verdict}\t${seconds}s\tfailed=${r.failed}\t${m.note ?? ''}`);
}

const out = listPath.replace(/\.json$/, `.results.${from}-${to}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(
  `\n${results.filter((r) => r.verdict === 'KILLED').length}/${results.length} killed`,
);
