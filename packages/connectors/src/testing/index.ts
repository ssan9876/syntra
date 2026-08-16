/**
 * Test doubles for `@syntra/connectors`, reachable only as
 * `@syntra/connectors/testing`.
 *
 * Deliberately NOT re-exported from the package root. A fake reachable from
 * production code is a fake that will eventually be reached: an import that
 * meant to pull in `ldapConnector` and pulled in `FakeTarget` instead type-
 * checks, passes review, and writes nothing to the directory it claims to be
 * managing. The separate entry point makes that import look wrong at the
 * import line, which is the only place anybody reads it.
 */
export * from './fake-target.js';
