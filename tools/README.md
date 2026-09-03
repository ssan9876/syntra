# tools/

## `mutate.mjs`

A minimal mutation runner for one task's files. It applies one textual
mutation at a time to a source file, runs a named subset of the suite against
it, and records whether anything failed. The question it answers is not
coverage — it is whether the tests are *capable* of failing when the code is
wrong, which a green suite cannot answer about itself.

```bash
node tools/mutate.mjs verify <mutants.json>
node tools/mutate.mjs run    <mutants.json> [from] [to]
```

`verify` runs every selector against pristine code first, so a selector that
matches no test does not read as a mutant every test caught. `run` applies
each mutation in turn and records a kill or a survivor. Both write a log next
to the input file: `<name>.verify.log` or `<name>.run.log`.

## `*-mutants.json`

One file per task or ruling that was mutation-tested (`p29-mutants.json`,
`task-13-mutants.json`, and so on). Each entry names the file to mutate, the
exact text to find and replace, the test file to run, and a pattern used to
select which test(s) exercise it. These are inputs to `mutate.mjs`, not
generated — write a new one by hand for a new task and run it with the
commands above.

The `.run.log` and `.verify.log` files a run writes beside its input are
**local output, not part of the repository** — `.gitignore` excludes `*.log`,
so they are never committed and are not a record anybody else can read. Treat
them as the working output of the run in front of you: read the survivors,
then act on them. What is worth keeping goes into the mutants file itself, or
into a test.
