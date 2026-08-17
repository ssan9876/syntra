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
 * ## The verdict comes from vitest's summary, not from its exit code
 *
 * On this platform `vitest run` reliably PRINTS its summary and then
 * sometimes does not exit — most often after a failing test, which is exactly
 * what a mutation run produces. Waiting on the exit code turns a ten-second
 * answer into a five-minute timeout, and a timeout read as a non-zero exit is
 * a **false kill**: the runner would report that the tests caught the
 * mutation when all it observed was a process that would not close.
 *
 * So the child is watched for the `Duration` line that ends every vitest
 * summary, the summary is parsed, and the process tree is killed. A run whose
 * summary never appears is `INCONCLUSIVE` — never a kill.
 *
 * `verify` runs every selector against PRISTINE code first: a selector that
 * matches no test would otherwise look exactly like a mutant every test
 * caught.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const [, , mode, listPath, fromArg, toArg] = process.argv;
const mutants = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const logPath = listPath.replace(/\.json$/, `.${mode}.log`);
const TIMEOUT_MS = 180_000;

/**
 * Real ANSI sequences: ESC `[` … `m`.
 *
 * Stripping only the bracket half leaves a stray ESC in front of every
 * summary label, and ESC is not whitespace — so an anchored `\n\s*Duration`
 * never matches, the summary is never recognised, and every mutant comes back
 * INCONCLUSIVE. A whole pass reporting nothing, for one missing character in
 * a regex. Found by running it.
 */
const strip = (text) => text.replace(/\[[0-9;]*m/g, '');

function say(line) {
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/**
 * vitest's own entry point, run through `node` and NOT through `npx`.
 *
 * `spawn(..., { shell: true })` concatenates the arguments into one command
 * line WITHOUT quoting them -- Node says so itself, DEP0190 -- so a `-t`
 * pattern with spaces in it arrives as `-t refuses` followed by `a`, `blank`
 * and `name` as positional FILE filters. vitest then runs whatever files
 * those substrings happen to match, with a name filter nobody asked for.
 *
 * That is not a slow runner, it is a runner measuring something else: the
 * first pass built on it reported kills for mutants whose test never ran.
 * Resolving the binary and spawning `node` with a real argv removes the shell
 * from the loop entirely.
 */
const VITEST_BIN = createRequire(import.meta.url).resolve('vitest/vitest.mjs');

function vitest(testFile, pattern) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [VITEST_BIN, 'run', testFile, '-t', pattern],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    let settled = false;

    const settle = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child.pid);
      const clean = strip(out);
      // The `Tests` line, not the `Test Files` line. `\bTests` cannot match
      // "Test Files", so the two counts can never cross.
      const lines = [...clean.matchAll(/\n\s*Tests\s+(.+)/g)];
      const summary = lines.at(-1)?.[1] ?? '';
      resolve({
        reason,
        // Whether the summary was PARSED, not whether the Duration watcher
        // happened to fire before `close` did. A run that printed its result
        // and then exited normally is a result, and reading `reason` instead
        // marked every one of them inconclusive.
        sawSummary: summary !== '',
        passed: Number(/(\d+) passed/.exec(summary)?.[1] ?? 0),
        failed: Number(/(\d+) failed/.exec(summary)?.[1] ?? 0),
        noTests: /No test (files )?found/i.test(clean),
      });
    };

    const timer = setTimeout(() => settle('timeout'), TIMEOUT_MS);
    const scan = (chunk) => {
      out += chunk;
      // The last line vitest writes before it is done with the run.
      if (/Duration\s+[\d.]+\s*m?s/.test(strip(out))) {
        setTimeout(() => settle('summary'), 300);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('close', () => settle(out.length > 0 ? 'exit' : 'empty'));
  });
}

async function verify() {
  const seen = new Set();
  let bad = 0;
  for (const m of mutants) {
    const key = `${m.test}::${m.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const occurrences = fs.readFileSync(m.file, 'utf8').split(m.find).length - 1;
    const r = await vitest(m.test, m.pattern);
    const ok = r.passed > 0 && r.failed === 0 && occurrences === 1;
    if (!ok) bad += 1;
    say(
      `${ok ? 'ok  ' : 'BAD '}\t${m.id}\t${r.passed}p/${r.failed}f\t${r.reason}\tfind x${occurrences}\t${m.pattern}`,
    );
  }
  say(`\n${bad} selectors or patterns need attention`);
}

async function run() {
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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      restore();
      process.exit(1);
    });
  }

  const results = [];
  for (let i = from; i < to && i < mutants.length; i += 1) {
    const m = mutants[i];
    const original = pristine.get(m.file);
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({ id: m.id, verdict: 'BAD_PATTERN', note: m.note });
      say(`${m.id}\tBAD_PATTERN\t${occurrences} occurrences`);
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    const started = Date.now();
    const r = await vitest(m.test, m.pattern);
    fs.writeFileSync(m.file, original);

    const verdict = !r.sawSummary
      ? 'INCONCLUSIVE'
      : r.failed > 0
        ? 'KILLED'
        : r.passed > 0
          ? 'SURVIVED'
          : 'INCONCLUSIVE';
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({
      id: m.id,
      verdict,
      seconds,
      passed: r.passed,
      failed: r.failed,
      note: m.note,
    });
    say(`${m.id}\t${verdict}\t${seconds}s\t${r.passed}p/${r.failed}f\t${m.note ?? ''}`);
  }

  fs.writeFileSync(
    listPath.replace(/\.json$/, `.results.${from}-${to}.json`),
    JSON.stringify(results, null, 2),
  );
  const tally = (v) => results.filter((r) => r.verdict === v).length;
  say(
    `\n${tally('KILLED')} killed, ${tally('SURVIVED')} survived, ` +
      `${tally('INCONCLUSIVE')} inconclusive, of ${results.length}`,
  );
}

if (mode === 'verify') await verify();
else if (mode === 'run') await run();
else throw new Error(`unknown mode: ${mode}`);
