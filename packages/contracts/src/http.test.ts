import { describe, expect, it } from 'vitest';
import { SERVER_PATH_PREFIXES, isServerPath } from './http.js';

describe('isServerPath', () => {
  it('claims every prefix, bare and with a path under it', () => {
    for (const prefix of SERVER_PATH_PREFIXES) {
      expect(isServerPath(prefix)).toBe(true);
      expect(isServerPath(`${prefix}/anything/below`)).toBe(true);
    }
  });

  it('leaves the application its own paths', () => {
    for (const path of ['/', '/login', '/admin/users', '/catalog/abc']) {
      expect(isServerPath(path)).toBe(false);
    }
  });

  it('matches on a segment boundary, not on a string prefix', () => {
    // `/apiary` is a page the application may own. Reading it as the API
    // because it begins with those four letters would serve JSON where a page
    // belongs, and nobody would think to look here for the reason.
    expect(isServerPath('/apiary')).toBe(false);
    expect(isServerPath('/healthcare')).toBe(false);
    expect(isServerPath('/oidcish')).toBe(false);
  });
});
