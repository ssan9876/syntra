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
export * from './fake-scim-server.js';

/**
 * The live Samba domain controller's connection contract, re-exported here
 * for the same reason and by the same boundary.
 *
 * It is a fixture, not production code, so it does not belong at the package
 * root. It has to be reachable from *outside* the package all the same:
 * Task 18's integration test lives in `@syntra/core`, and the deep path the
 * plan assumed -- `@syntra/connectors/src/ad/samba-connection.js` -- does not
 * resolve, because this package declares an `exports` map and an `exports`
 * map denies every subpath it does not list:
 *
 *   error TS2307: Cannot find module
 *   '@syntra/connectors/src/ad/samba-connection.js' or its corresponding
 *   type declarations.
 *
 * Tests inside this package still import it by relative path.
 */
export * from '../ad/samba-connection.js';
