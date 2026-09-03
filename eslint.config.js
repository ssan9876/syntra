import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * What this linter is for, and what it deliberately leaves alone.
 *
 * `tsc -b` already runs over every package with `strict`,
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so the types
 * are not the gap. The gap is the class of mistake a type checker cannot see:
 * a promise nobody awaited, an `async` function passed where a synchronous
 * one was expected, a variable left behind by an edit. In a product whose
 * every write is meant to land inside a transaction beside an audit event, a
 * dropped `await` is not a style problem — it is an audit line claiming
 * something that had not happened yet when it was written.
 *
 * So the rule set is small and every rule in it is a bug detector. There is
 * no formatting opinion here at all: this repository has no formatter, the
 * diff of adding one would touch every file, and a lint run that rewrites
 * whitespace teaches people to run it with `--fix` and stop reading the
 * output. If a formatter is ever wanted it is its own change.
 */
export default tseslint.config(
  {
    // Everything not written by hand. `dist` and the Prisma client are
    // generated on every build, and linting them reports other people's
    // choices as this repository's problems.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'packages/db/generated/**',
      'apps/web/dist/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        // `projectService` rather than a list of tsconfigs: there are eight
        // project references and a hand-maintained list is one more place for
        // a new package to be forgotten.
        projectService: {
          // The configuration files at the repository root belong to no
          // package, so the project service cannot find a tsconfig that owns
          // them and refuses to parse them at all. They are the files that
          // decide how the suite and the browser tests run, so leaving them
          // unlinted is leaving out the ones a mistake is quietest in.
          allowDefaultProject: [
            'vitest.config.ts',
            'vitest.global-setup.ts',
            'vitest.setup-worker.ts',
            'playwright.config.ts',
            'eslint.config.js',
            'apps/web/vite.config.ts',
            'apps/web/vitest.config.ts',
            // The browser suite is a project of its own that no tsconfig
            // references, and it is the only place several whole journeys are
            // exercised end to end.
            'e2e/*.spec.ts',
          ],
          // The default project holds eight files before it refuses, and the
          // list above is seventeen. The cap is there because every file in
          // the default project is type-checked without the benefit of a real
          // program, which is slow at scale -- but these are seventeen leaf
          // files that import little, not a package, and the alternative is
          // leaving the browser suite and the files that configure the test
          // runners unlinted. Measured at about four seconds of the run.
          //
          // If this list grows much further, the answer is a tsconfig that
          // owns `e2e/` rather than a bigger number here.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // THE FOUR THAT PAY FOR THIS FILE. Each needs type information, which
      // is why the project service above is switched on.
      //
      // A floating promise in a route handler is a write that may not have
      // happened when the response is sent; in a job it is an error nobody
      // will ever see, because an unhandled rejection is not a failed run.
      //
      // `NavigateFunction` is exempted by name. React Router 7 types
      // `navigate()` as `void | Promise<void>` -- it returns a promise only
      // when a view transition is in flight -- and it is designed to be
      // called and forgotten; every one of the twenty-odd call sites here is
      // the last statement of a handler that has nothing left to do. Writing
      // `void navigate(...)` at each would be twenty-odd edits asserting
      // something the router's own signature already says.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'react-router', name: 'NavigateFunction' },
          ],
        },
      ],
      // An async function where a void one is expected: the caller cannot
      // await it, so a rejection escapes. It caught a real one on its first
      // run -- `perTenantRateLimit` returned an async hook declared with
      // Fastify's synchronous hook type.
      //
      // `attributes: false` because a JSX event handler is the one place this
      // check is wrong here. React ignores a handler's return value by
      // design, so `onSubmit={onSubmit}` with an async `onSubmit` is the
      // ordinary way to write it; the hazard the rule warns about is an
      // escaping rejection, and every one of the hundred-odd handlers in this
      // console already ends in `catch`/`finally` that sets an error and
      // clears the busy flag. The alternative is wrapping every one in
      // `void (async () => {})()`, which is a hundred files of noise buying
      // nothing. Everywhere that is not a JSX attribute is still checked.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // `await` on something that was never a promise is almost always a call
      // whose parentheses are in the wrong place.
      '@typescript-eslint/await-thenable': 'error',

      // `tsconfig.base.json` sets neither `noUnusedLocals` nor
      // `noUnusedParameters`, so nothing in this repository catches these.
      // The underscore prefix is the escape hatch, because a parameter that
      // exists to reach the one after it is not a mistake.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // `const { secret, ...rest } = input` is how a field is REMOVED
          // from an object here, and the named binding is meant to be
          // unused. Reporting it invites exactly the "fix" that deletes the
          // name and silently puts the field back -- which is a test that
          // stops testing, or a response that starts carrying a secret.
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // `==` against anything but null is a coercion nobody meant.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // OFF. The rule exists to catch a control character that got into a
      // pattern by accident, usually by being pasted. Every match in this
      // repository is the opposite: a directory product escapes and strips
      // control characters for a living -- the ones XML 1.0 cannot carry, the
      // ones RFC 4514 requires escaped in a DN, the ones an LDAP display name
      // can arrive holding -- and naming them in a character class is how
      // that is done. A rule that fires on all four of those and nothing else
      // is reporting the feature.
      'no-control-regex': 'off',

      // OFF, deliberately. The codebase reaches for `any` where it crosses a
      // boundary it does not own -- a parsed JSON body on its way into zod, a
      // Prisma error being narrowed -- and every one of those is a cast that
      // a reviewer has already looked at. Turning this on would report
      // hundreds of considered decisions and bury the three rules above.
      '@typescript-eslint/no-explicit-any': 'off',

      // Same reasoning: `!` after a lookup is how this codebase reads an
      // index it has just bounds-checked, which `noUncheckedIndexedAccess`
      // makes necessary rather than lazy.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // The React half. `rules-of-hooks` catches a hook behind a condition,
    // which is a crash rather than a warning, and `exhaustive-deps` catches
    // the stale closure -- the defect behind a list that shows the previous
    // search's results.
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // Tests reach into shapes the compiler cannot know -- a fixture's JSON, a
    // spy's arguments -- and a test asserting on `res.json().total` is doing
    // exactly what it should. The three promise rules above still apply here,
    // because a test that forgets an `await` passes while proving nothing,
    // which is the most expensive kind of green in this repository.
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'vitest.*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  {
    // Plain JavaScript: the mutation runner and this file. No type
    // information is available for them, so the type-aware rules must not be
    // asked for it.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        // Declared by hand rather than by pulling in `globals` for one file.
        // These are the Node built-ins `tools/mutate.mjs` uses; `no-undef` is
        // worth keeping switched on there precisely because it is the one
        // hand-written file in this repository that `tsc` never looks at.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // The mutation runner strips ANSI colour from the output it captures,
      // and an escape character is what ANSI colour is made of.
      'no-control-regex': 'off',
    },
  },
);
