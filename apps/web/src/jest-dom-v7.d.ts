import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// jest-dom 7 still declares Vitest's pre-v5 one-parameter Assertion shape.
// Vitest 5 carries the assertion result and subject as two parameters, so the
// upstream augmentation is ignored and every DOM matcher disappears from
// typechecking. Mirror Vitest 5's public shape until jest-dom publishes a
// compatible declaration; the runtime registration remains in test-setup.ts.
declare module 'vitest' {
  interface Assertion<R extends void | Promise<void> = void, T = unknown>
    extends TestingLibraryMatchers<R, T> {}

  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}

