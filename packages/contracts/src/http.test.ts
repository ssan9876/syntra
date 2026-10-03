import { describe, expect, it } from 'vitest';
import { SERVER_PATH_PREFIXES, isServerPath } from './http.js';

describe('isServerPath', () => {
  it('claims every prefix, bare and with a path under it', () => {
    for (const prefix of SERVER_PATH_PREFIXES) {
      expect(isServerPath(prefix)).toBe(true);
      expect(isServerPath(`${prefix}/anything/below`)).toBe(true);
    }
  });

  it('claims every root prefix the API registers', () => {
    // apps/api/src/app.ts mounts routes under exactly these. One left out is
    // answered by the production fallback with 200 and the console's HTML.
    for (const path of [
      '/api/admin/users',
      '/saml/sso',
      '/oidc/token',
      '/federation/start',
      '/scim/v2/Users',
      '/health/ready',
      '/metrics',
    ]) {
      expect(isServerPath(path), path).toBe(true);
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
    expect(isServerPath('/scimitar')).toBe(false);
    expect(isServerPath('/metricsboard')).toBe(false);
  });
});
