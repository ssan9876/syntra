import { describe, expect, it } from 'vitest';
import { buildInfo, parseRelease } from './version.js';

/**
 * Everything here is one rule: **an install that cannot prove what it is
 * reports `dev`.**
 *
 * It matters because the updater compares versions to decide whether to
 * overwrite this tree. An install that guesses a number -- from a truncated
 * file, a half-written one, a `deploy.sh` push -- is one the updater will
 * happily replace, taking uncommitted work with it. Refusing to guess is what
 * makes the comparison safe to act on.
 */
describe('parseRelease', () => {
  it('reads a well-formed release', () => {
    const info = parseRelease(
      JSON.stringify({
        version: '1.4.0',
        released: '2026-08-24T19:02:11Z',
        commit: '5f63f3e',
        migrations: ['20260824020657_directory_writeback'],
      }),
    );

    expect(info).toEqual({
      version: '1.4.0',
      isRelease: true,
      released: '2026-08-24T19:02:11Z',
      commit: '5f63f3e',
      migrations: ['20260824020657_directory_writeback'],
    });
  });

  it('is dev when there is no release file at all', () => {
    expect(parseRelease(null)).toMatchObject({ version: 'dev', isRelease: false });
  });

  /** A tarball that was cut off mid-write, or a disk that filled. */
  it('is dev for a truncated file rather than throwing', () => {
    expect(parseRelease('{"version": "1.4.')).toMatchObject({ version: 'dev' });
  });

  it('is dev for valid JSON that is not a release', () => {
    for (const raw of ['{}', '[]', 'null', '"1.4.0"', '{"version": 140}']) {
      expect(parseRelease(raw), raw).toMatchObject({ version: 'dev', isRelease: false });
    }
  });

  /**
   * Not version zero, and not the empty string. A release file that cannot
   * name its version is broken, and treating it as a version would let the
   * updater compare against nothing.
   */
  it('is dev for an empty or blank version', () => {
    expect(parseRelease('{"version": ""}')).toMatchObject({ version: 'dev' });
    expect(parseRelease('{"version": "   "}')).toMatchObject({ version: 'dev' });
  });

  it('keeps the version but tolerates missing optional fields', () => {
    const info = parseRelease('{"version": "2.0.1"}');
    expect(info).toEqual({
      version: '2.0.1',
      isRelease: true,
      commit: null,
      released: null,
      migrations: [],
    });
  });

  it('ignores migration entries that are not strings', () => {
    const info = parseRelease('{"version": "1.0.0", "migrations": ["a", 7, null, "b"]}');
    expect(info.migrations).toEqual(['a', 'b']);
  });

  it('does not treat a non-array migrations field as migrations', () => {
    expect(parseRelease('{"version": "1.0.0", "migrations": "lots"}').migrations).toEqual([]);
  });
});

describe('buildInfo', () => {
  /**
   * This repository is a checkout, not a release, and must say so. If this
   * ever fails it means a RELEASE.json has been committed -- which would make
   * every developer's tree claim to be a shipped version.
   */
  it('reports a working checkout as dev', () => {
    expect(buildInfo()).toMatchObject({ version: 'dev', isRelease: false });
  });

  it('is stable across calls', () => {
    expect(buildInfo()).toBe(buildInfo());
  });
});
